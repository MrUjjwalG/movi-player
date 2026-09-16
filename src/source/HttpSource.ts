/**
 * HttpSource - SharedArrayBuffer Streaming with Atomics
 *
 * Uses SharedArrayBuffer for zero-copy data sharing.
 * Atomics for thread-safe concurrent access.
 */

import type { SourceAdapter } from "./SourceAdapter";
import { Logger } from "../utils/Logger";

const TAG = "HttpSource";

// Configuration
const MIN_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB minimum
const DEFAULT_MAX_BUFFER_SIZE_MB = 250; // ~250MB cap (YouTube-like: Chrome gives ~150-300MB per tab for video)
const BUFFER_PERCENTAGE = 0.08; // 8% of file size — covers ~60-90s of content for large files
const MAX_STREAM_BUFFER_SIZE = 250 * 1024 * 1024; // Match max buffer — stream until buffer is full
// Largest bytes= range asked for in ONE request. The window a stream fills is
// still MAX_STREAM_BUFFER_SIZE / the whole file; this only splits it into
// chunks, which the loop fetches back to back.
//
// Reason: CDNs that pace a long-lived response serve a SHORT range at full
// link speed and then throttle to roughly the stream's own bitrate. Measured
// against googlevideo on a 28MB audio track: 4MB in 0.42s (~10 MB/s), 8MB in
// 2.0s, and 12MB+ delivered 377KB in 12s — parked at ~30 KB/s. Asking for the
// whole file (which a small one did, since it fits the buffer) therefore made
// the demuxer's open wait ~18s for bytes it should have had in under a second;
// that was the entire startup delay on a split-audio YouTube source.
//
// Two sizes, because the two chunks are asked for different reasons:
//
//   OPEN — the first one. Small, so the demuxer's first read is answered in a
//   fraction of a second. That is the case above.
//
//   FILL — every one after it. Those exist to build a buffer, and 4MB is the
//   wrong size for that on a heavy rung: at 8K (~60 Mbps) it is barely half a
//   second of video per request, so the stream spends its time paying TTFB
//   (measured 30-500ms each) instead of filling. The buffer then never gets
//   ahead, which is what a switch to a high rung feels like. 8MB is the
//   largest the CDN still served whole in the measurement above, so take it.
// 4MB, and NOT smaller — tried. Shrinking this to 512KB on the theory that the
// open chunk was the wait made it seventeen times worse: `loadedmetadata` went
// from 1646ms to 28807ms on the same warm click. Whatever the demuxer needs to
// open, it is not answered by one small range, and the fill loop taking over
// from there is nowhere near as fast as one big request.
const FIRST_RANGE_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_RANGE_CHUNK_SIZE = 8 * 1024 * 1024;
const CORS_DETECTION_THRESHOLD = 3; // Only treat "Failed to fetch" as CORS after N consecutive failures while online
// IMPORTANT: Header size increased to 6 Int32 values (24 bytes) to support 64-bit buffer start offsets
const HEADER_SIZE = 24; // Header bytes for atomics (6 Int32 values)

// Header layout (Int32 indices)
// IMPORTANT: BUFFER_START is split into low/high 32-bit parts to support offsets >= 2GB
const HEADER = {
  WRITE_POS: 0, // Current write position in buffer
  BUFFER_START_LOW: 1, // Start offset of data in buffer (low 32 bits)
  BUFFER_START_HIGH: 2, // Start offset of data in buffer (high 32 bits)
  LOCK: 3, // Lock for exclusive access
  STREAM_ACTIVE: 4, // Is stream currently active
  VERSION: 5, // Change counter for cache invalidation
};

// HEAD_CACHE_SIZE is now dynamic: calculated in ensureHeadCache based on file size.

// Metadata LRU: caches small reads served out of HttpSource so that
// metadata-shaped access patterns (moov/ftyp/Cues/index reads — typically
// small, repeated, scattered across the file) survive sliding-window
// eviction. Format-agnostic: we don't assume where metadata lives, we
// learn from actual access patterns. Hot path for thumbnail borrow.
const METADATA_CACHE_MAX_CHUNK = 128 * 1024; // Reads larger than this skip the cache
const METADATA_CACHE_MAX_BYTES = 8 * 1024 * 1024; // 8MB total cap
const METADATA_CACHE_MAX_ENTRIES = 128;

// How much of the FILE HEAD to keep for the life of the source, out of bytes
// we were downloading anyway.
//
// The opening bytes are the one region every fresh demuxer re-reads, and the
// sliding window is the one place they never survive: the very first stream
// starts at 0, a metadata read then seeks the stream elsewhere (MKV Cues at
// EOF), and when it comes back the window restarts at 823 — the EBML header
// is gone. Nothing above 0 is affected, so the loss is invisible to playback
// but total for anyone re-opening the file: the thumbnail demuxer's probe
// read at offset 0 missed the borrow by 823 bytes and paid a 2MB range fetch
// (1.6s of the ~2.1s a first hover took on a 1.5MB/s link).
//
// One megabyte was sized for that probe read and nothing more, and it is not
// what a demuxer needs to OPEN a file. A 3.9GB MKV shows the gap exactly: its
// own open walked the head out to ~4.2MB (offsets 0, 31719, 556007, 1080295,
// 1604583, 2128871, 2653159, 3177447, 3701735, half a megabyte at a time), and
// the thumbnail demuxer has to walk the same ground when it opens its own
// instance later.
//
// While playback starts at zero that costs nothing — the reads land in the
// main sliding window and borrow for free. RESUMING is what exposes it: the
// resume seek moves the window to the middle of the file, the head region goes
// with it, and the only thing left covering the start is this cache. The
// thumbnail open then borrowed contiguously up to offset 988949 — the last
// 32KB read that fits under 1MB — and fell off the end at 1021717, paying two
// 2MB range fetches to read on to ~3.95MB. That is 1.9s of the ~4s a first
// hover took after a resume, and it is why it only ever happened after one.
//
// Sized to the opening fetch (see startStream) so it holds what the source has
// ALREADY downloaded rather than asking for more: on a resume the first 4MB
// still streams past before the seek moves the window, so this is free.
const HEAD_CACHE_BYTES = 4 * 1024 * 1024;

export class HttpSource implements SourceAdapter {
  private url: string;
  private headers: Record<string, string>;
  private size: number = -1;
  private position: number = 0;
  private _contentDispositionFilename: string | null = null;

  // Persistent Cache
  private headBuffer: Uint8Array | null = null;
  /**
   * How many bytes of `headBuffer`, counted from 0, are real.
   *
   * The buffer is allocated to its full capacity up front but filled as the
   * download passes over the head, so its `.length` says nothing about what is
   * present — every reader has to go by this instead, or it serves zeros.
   */
  private headFilled: number = 0;

  /**
   * Opening bytes handed over by whoever fetched them first, keyed by URL.
   *
   * The pre-play probe used to download ~3MB purely to time the link and throw
   * every byte away — then this source downloaded the same opening bytes again.
   * Now the probe reads the head of the rung it is measuring and leaves it
   * here; `read()` already checks headBuffer before touching the network, so
   * the demuxer's first reads are served without a request.
   *
   * One entry, replaced on each offer: only the rung about to open matters.
   */
  private static warmHead: { url: string; bytes: Uint8Array } | null = null;

  /** Hand over opening bytes for a URL that is about to be opened. */
  static offerWarmHead(url: string, bytes: Uint8Array): void {
    if (!url || bytes.byteLength === 0) return;
    HttpSource.warmHead = { url, bytes };
  }

  /**
   * Size of the FIRST range request, overridable per source.
   *
   * 4MB is right for video — it covers the moov and the opening GOP. For a
   * separate audio stream it is four minutes of AAC nobody needs yet, and it
   * is fetched during startup where it costs seconds directly. The split-audio
   * path asks for a smaller opening; the streaming loop after it is unchanged.
   */
  private firstRangeBytes = FIRST_RANGE_CHUNK_SIZE;

  setFirstRangeBytes(bytes: number): void {
    if (bytes > 0) this.firstRangeBytes = bytes;
  }

  // Metadata LRU (see top-of-file comment). Keyed by absolute file offset
  // → the cached bytes. JS Map preserves insertion order; on hit we
  // delete+re-insert to bump to most-recent. Only small reads enter.
  private metadataCache: Map<number, Uint8Array> = new Map();
  private metadataCacheBytes: number = 0;

  // Shared buffer
  private sharedBuffer: SharedArrayBuffer | null = null;
  private headerView: Int32Array | null = null;
  private dataView: Uint8Array | null = null;
  private useSharedBuffer: boolean = false;

  // Fallback for non-SharedArrayBuffer environments
  private fallbackBuffer: Uint8Array | null = null;
  private fallbackStart: number = 0;
  private fallbackWritePos: number = 0;
  // Mirrors STREAM_ACTIVE for the non-SAB path. Without it, atomicSetStreaming
  // was a no-op and atomicIsStreaming fell back to `reader !== null` — which is
  // still false in the window between startStream() setting the flag and the
  // fetch resolving the reader, so read()'s waitForData bailed and every load
  // failed with "Timeout at 0" when cross-origin isolation was absent.
  private fallbackStreaming: boolean = false;

  // Readers parked in waitForData(), each waiting for bufferEnd to reach its
  // own `needed` byte. The stream writer wakes them the moment their bytes
  // land (see atomicSetWritePos). Without this, waitForData polled on a timer
  // and a read could sit idle for most of a poll interval after its bytes had
  // already arrived — and because WASM I/O is Asyncify-suspended, that idle
  // time froze the whole module, decoders included.
  private bufferWaiters: Set<{ needed: number; wake: () => void }> = new Set();

  // Stream state
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  /**
   * Aborted once on close(), killing every request this source has in flight.
   *
   * `abortController` above only covers the sequential stream (it's recycled on
   * every stream restart), so the ranged reads went out with no signal at all —
   * a player torn down mid-read (a quality switch, a source error recreate) left
   * multi-megabyte range requests downloading to nobody, competing for the link
   * with the replacement that just started.
   */
  private lifetimeAbort = new AbortController();
  private streamError: Error | null = null;
  /**
   * A failure this URL will not recover from, remembered for the life of the
   * source rather than for the life of one stream attempt.
   *
   * `streamError` is cleared by startStream(), which is correct for it — each
   * attempt starts clean. But read() answers a window it cannot cover by
   * calling startStream(), so a URL that had begun refusing produced: fetch,
   * fail, set streamError, stop; read; startStream; CLEAR the error; fetch;
   * fail… Measured against a signed URL expiring mid-playback, that ran 1131
   * requests in five seconds, the state stayed "playing", and no error ever
   * survived long enough for a reader to see one. The viewer got a picture
   * that had quietly stopped and no reason for it.
   */
  private fatalError: Error | null = null; // Store fatal errors from background stream

  // Track maximum buffered position (independent of sliding window)
  private maxBufferedEnd: number = 0;

  // True when the entire file fits in the buffer and has been fully downloaded.
  // In this state, all reads can be served from memory — no re-fetching needed.
  private fullyBuffered: boolean = false;

  // Set once we've confirmed the server ignores Range (returns 200, not 206).
  // From then on there is exactly one stream — the full file from byte 0 — and
  // we must never restart it at a non-zero offset (the server would resend from
  // the start, mis-aligning the buffer).
  private rangeUnsupported: boolean = false;
  // Subset of rangeUnsupported: the file is larger than the buffer cap (or its
  // size is unknown), so it can't be held whole in memory. We run a bounded
  // forward-only sliding window — playback is linear, seeking is impossible.
  private linearMode: boolean = false;
  // Fired once when we enter linearMode, so the UI can disable seek/thumbnails/
  // the timeline. Wired up by MoviPlayer.createSource.
  private onLinearMode: (() => void) | null = null;
  // Forward high-water mark of successful reads (the demuxer's furthest read
  // point). Monotonic — unlike `position`, an internal rewind doesn't pull it
  // back — so the linear window can keep ~trail of history behind the frontier.
  private readMax: number = 0;
  // Ring of recent read offsets (linear mode). Their minimum approximates the
  // lowest offset any demuxer stream / a just-happened backward seek still
  // needs, so the sliding window never drops bytes a live reader is using —
  // even when streams sit far apart in the file or a rewind just occurred.
  private recentReads: number[] = [];

  // Force restart tracking (to prevent cascading failures)
  private consecutiveForceRestarts: number = 0;
  private lastForceRestartTime: number = 0;
  private readonly MAX_FORCE_RESTARTS = 3; // Max consecutive force restarts before giving up
  // Bumped on every startStream(), on both the SAB and main-thread paths (the
  // SAB header VERSION only exists on one). Lets a read tell "my stream died"
  // from "someone else's stream replaced mine" before tearing it down.
  private streamGeneration = 0;
  // Consecutive one-off range fetches served while the read fell outside the
  // stream window. A lone spike (stray metadata/index read) shouldn't disturb
  // the sequential stream, but a run of them means the play position genuinely
  // moved (a seek) — so after a couple we restart the stream at the new offset
  // instead of dribbling the whole file out as tiny range requests.
  private consecutiveOneOffFetches: number = 0;
  private readonly MAX_ONEOFF_BEFORE_RESTART = 2;
  /**
   * Probing: the reads arriving right now are deliberate poking around the
   * file, not a play position moving.
   *
   * The demuxer's index search for an unindexed Matroska bisects the whole file
   * — a dozen reads at wildly different offsets, each a few hundred KB, none of
   * them anywhere the viewer is about to watch. The one-off allowance above
   * runs out after two of those, and from the third on every probe restarted
   * the download at its offset: 12MB fetched to answer a 256KB question, on
   * every probe. While this is set, an out-of-window read is always served as
   * a one-off range and never counts toward a restart.
   */
  private _probing = false;

  setProbeMode(on: boolean): void {
    this._probing = on;
    if (!on) this.consecutiveOneOffFetches = 0;
  }
  // Set by the player immediately before a demuxer seek. Counting one-off
  // fetches (above) can only INFER a seek after a run of them, and each one is
  // its own HTTP request racing the still-running old stream for bandwidth —
  // on a big remote file the player's 3s seek timeout fires before the streak
  // ever reaches the restart threshold, so the stream never repositions and
  // keeps downloading the region the user just seeked away from. The hint
  // makes it exact: the first out-of-window read after a seek IS the seek
  // landing, so restart there at once instead of dribbling range requests.
  // Consumed by the next read either way (an in-window seek needs no restart).
  private seekHinted: boolean = false;

  // Dynamic buffer size (3% of file size, clamped)
  // Start with minimum size, will be resized when file size is known
  private bufferSize: number = MIN_BUFFER_SIZE;

  // Network stats tracking
  private totalBytesDownloaded: number = 0;
  private streamStartTime: number = 0;
  private lastSpeedBytes: number = 0;
  private lastSpeedTime: number = 0;
  private currentSpeed: number = 0; // bytes per second (0 when idle — for UI)
  // Last measured active download rate (bytes/s), NOT zeroed when idle. The ABR
  // needs the link's capability even after a small file finishes caching; a
  // fully-downloaded source reporting currentSpeed 0 was why Auto sat stuck at a
  // low rung. Captured on the sub-1s path too (currentSpeed's 0.5s window misses
  // a file that downloads in a few hundred ms).
  private lastSpeed: number = 0;

  // Maximum buffer size (from cache config, defaults to DEFAULT_MAX_BUFFER_SIZE_MB)
  private maxBufferSizeMB: number;

  constructor(
    url: string,
    headers: Record<string, string> = {},
    maxBufferSizeMB?: number,
  ) {
    this.url = url;
    this.headers = headers;
    this.maxBufferSizeMB = maxBufferSizeMB ?? DEFAULT_MAX_BUFFER_SIZE_MB;
    // Claim the opening bytes if the probe fetched this exact URL. Consumed
    // (not just read) so a later source for a different rung can't inherit
    // another rung's head — that would hand the demuxer the wrong file.
    const warm = HttpSource.warmHead;
    if (warm && warm.url === url) {
      this.headBuffer = warm.bytes;
      this.headFilled = warm.bytes.byteLength;
      HttpSource.warmHead = null;
      Logger.info(
        TAG,
        `Opening ${(warm.bytes.byteLength / 1024 / 1024).toFixed(1)}MB served from the pre-play probe — no re-fetch`,
      );
    }
    this.initBuffer();
  }

  /**
   * Initialize buffer (SharedArrayBuffer if available, fallback otherwise)
   * Starts with minimum size (2MB), will be resized to 3% of file size when known
   */
  private initBuffer(): void {
    // Start with minimum buffer size, will resize to 3% when file size is known
    this.bufferSize = MIN_BUFFER_SIZE;
    this.resizeBuffer(this.bufferSize);
  }

  /**
   * Override the maximum buffer size cap at runtime. Takes effect on the
   * next resizeBuffer() call (typically the post-resolveSize pass) — and
   * immediately re-runs the buffer-sizing logic if a size is already
   * known, so UI attribute changes reflect without needing a reload.
   * Pass a number of megabytes. 0 or negative values are ignored.
   */
  setMaxBufferSize(megabytes: number): void {
    if (!(megabytes > 0)) return;
    this.maxBufferSizeMB = megabytes;
    if (this.size > 0) {
      const maxBufferBytes = megabytes * 1024 * 1024;
      const canCacheEntireFile = this.size <= maxBufferBytes;
      const calculatedBufferSize = canCacheEntireFile
        ? this.size
        : Math.floor(this.size * BUFFER_PERCENTAGE);
      this.resizeBuffer(calculatedBufferSize);
    }
  }

  /**
   * Register a callback fired once when the source falls back to linear
   * (forward-only, non-seekable) playback because the server has no Range
   * support and the file is too large to cache whole. The UI uses this to
   * hide the timeline and disable seeking/thumbnails.
   */
  setOnLinearMode(cb: () => void): void {
    this.onLinearMode = cb;
    // Already linear (callback registered late)? Fire immediately.
    if (this.linearMode) cb();
  }

  /** True once the source is in forward-only linear (non-seekable) playback. */
  isLinearMode(): boolean {
    return this.linearMode;
  }

  /**
   * True once we've confirmed the server has no Range support (covers both the
   * full-cache and the linear fallback). Callers use it to skip features that
   * need scattered random-access reads (e.g. the thumbnail pipeline).
   */
  isRangeUnsupported(): boolean {
    return this.rangeUnsupported;
  }

  /**
   * Resize buffer based on file size (3% of file, clamped to min/max)
   */
  private resizeBuffer(newSize: number): void {
    // Clamp buffer size to min/max
    const maxBufferSize = this.maxBufferSizeMB * 1024 * 1024;
    const clampedSize = Math.max(
      MIN_BUFFER_SIZE,
      Math.min(maxBufferSize, newSize),
    );

    if (
      this.bufferSize === clampedSize &&
      (this.sharedBuffer || this.fallbackBuffer)
    ) {
      // Already the right size, no need to resize
      return;
    }

    this.bufferSize = clampedSize;

    try {
      // Check if SharedArrayBuffer is available (requires COOP/COEP headers)
      if (typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated) {
        this.sharedBuffer = new SharedArrayBuffer(
          HEADER_SIZE + this.bufferSize,
        );
        this.headerView = new Int32Array(this.sharedBuffer, 0, HEADER_SIZE / 4);
        this.dataView = new Uint8Array(
          this.sharedBuffer,
          HEADER_SIZE,
          this.bufferSize,
        );
        this.useSharedBuffer = true;
        Logger.info(
          TAG,
          `Using SharedArrayBuffer for zero-copy streaming (${(this.bufferSize / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        this.fallbackBuffer = new Uint8Array(this.bufferSize);
        Logger.info(
          TAG,
          `Using standard ArrayBuffer (${(this.bufferSize / 1024 / 1024).toFixed(2)} MB)`,
        );
      }
    } catch {
      this.fallbackBuffer = new Uint8Array(this.bufferSize);
      Logger.warn(
        TAG,
        `SharedArrayBuffer init failed, using fallback (${(this.bufferSize / 1024 / 1024).toFixed(2)} MB)`,
      );
    }
  }

  /**
   * Atomic operations for SharedArrayBuffer
   */
  private atomicGetWritePos(): number {
    if (this.useSharedBuffer && this.headerView) {
      return Atomics.load(this.headerView, HEADER.WRITE_POS);
    }
    return this.fallbackWritePos;
  }

  private atomicSetWritePos(value: number): void {
    if (this.useSharedBuffer && this.headerView) {
      Atomics.store(this.headerView, HEADER.WRITE_POS, value);
    } else {
      this.fallbackWritePos = value;
    }
    // Every buffer advance funnels through here, so this is the one place that
    // can tell a parked reader its bytes have landed. Window shifts also call
    // atomicSetBufferStart, but always paired with a write pos update, so the
    // hook stays here rather than on both.
    this.wakeBufferWaiters();
  }

  /**
   * Wake readers parked in waitForData() whose bytes are now buffered.
   * `force` wakes every waiter regardless of its byte target — used when the
   * stream stops, so waiters re-evaluate the loop condition and exit rather
   * than waiting on bytes that are never coming.
   */
  private wakeBufferWaiters(force: boolean = false): void {
    if (this.bufferWaiters.size === 0) return;
    const end = force ? Infinity : this.bufferEnd;
    // Snapshot: wake() removes the waiter from the live set.
    for (const waiter of [...this.bufferWaiters]) {
      if (end >= waiter.needed) waiter.wake();
    }
  }

  /**
   * Resolve as soon as bufferEnd reaches `needed`, or after maxWaitMs.
   * The timer is a safety net for the checks waitForData runs each pass
   * (deadline, stall, superseded) — not the mechanism for spotting new bytes.
   */
  private waitForBufferAdvance(
    needed: number,
    maxWaitMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const waiter = {
        needed,
        wake: () => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          this.bufferWaiters.delete(waiter);
          resolve();
        },
      };
      this.bufferWaiters.add(waiter);
      timer = setTimeout(waiter.wake, maxWaitMs);
    });
  }

  // IMPORTANT: Split 64-bit offset into low/high 32-bit parts to support files >= 2GB
  private atomicGetBufferStart(): number {
    if (this.useSharedBuffer && this.headerView) {
      // Reconstruct 64-bit offset from two 32-bit parts
      const low = Atomics.load(this.headerView, HEADER.BUFFER_START_LOW);
      const high = Atomics.load(this.headerView, HEADER.BUFFER_START_HIGH);
      // Use unsigned arithmetic to avoid sign extension issues
      const lowUnsigned = low >>> 0; // Convert to unsigned 32-bit
      const highUnsigned = high >>> 0; // Convert to unsigned 32-bit
      return lowUnsigned + highUnsigned * 0x100000000;
    }
    return this.fallbackStart;
  }

  // IMPORTANT: Split 64-bit offset into low/high 32-bit parts to support files >= 2GB
  private atomicSetBufferStart(value: number): void {
    if (this.useSharedBuffer && this.headerView) {
      // Split 64-bit offset into two 32-bit parts
      // Use unsigned arithmetic to avoid sign extension issues
      const low = (value & 0xffffffff) >>> 0; // Extract low 32 bits as unsigned
      const high = ((value / 0x100000000) | 0) >>> 0; // Extract high 32 bits as unsigned
      Atomics.store(this.headerView, HEADER.BUFFER_START_LOW, low);
      Atomics.store(this.headerView, HEADER.BUFFER_START_HIGH, high);
    } else {
      this.fallbackStart = value;
    }
  }

  // Prefetch throttle. When a separate native <audio> track is bandwidth-starved
  // (its readyState is too low to play because the video stream is saturating the
  // connection), MoviPlayer flips this on so the video read loop stops pulling
  // bytes — HTTP backpressure then frees the pipe for the <audio> element to
  // buffer. The video already runs a large lead buffer, so briefly pausing
  // prefetch is safe. MoviPlayer auto-releases it (on audio-ready or a timeout),
  // so a permanently stuck audio element can never freeze video prefetch.
  private _prefetchThrottled = false;

  setPrefetchThrottle(throttled: boolean): void {
    this._prefetchThrottled = throttled;
  }

  /**
   * Tell the source a seek is about to happen, so the next read that falls
   * outside the stream window is treated as the seek landing and restarts the
   * stream there — instead of being served as a one-off range fetch while the
   * old stream keeps downloading (and saturating the link with) the region the
   * user just left. See `seekHinted`. Harmless if the seek lands in-window:
   * the next read simply clears the hint.
   */
  hintSeek(): void {
    this.seekHinted = true;
  }

  private async awaitPrefetchGate(): Promise<void> {
    while (this._prefetchThrottled && this.atomicIsStreaming()) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private atomicIsStreaming(): boolean {
    if (this.useSharedBuffer && this.headerView) {
      return Atomics.load(this.headerView, HEADER.STREAM_ACTIVE) === 1;
    }
    return this.fallbackStreaming;
  }

  private atomicSetStreaming(active: boolean): void {
    if (this.useSharedBuffer && this.headerView) {
      Atomics.store(this.headerView, HEADER.STREAM_ACTIVE, active ? 1 : 0);
    } else {
      this.fallbackStreaming = active;
    }
    // Bytes will never arrive once the stream is down, so release parked
    // readers immediately instead of leaving them on the safety timer.
    if (!active) this.wakeBufferWaiters(true);
  }

  private atomicIncrementVersion(): void {
    if (this.useSharedBuffer && this.headerView) {
      Atomics.add(this.headerView, HEADER.VERSION, 1);
    }
  }

  /**
   * Try to acquire lock (non-blocking)
   */
  private tryLock(): boolean {
    if (this.useSharedBuffer && this.headerView) {
      return Atomics.compareExchange(this.headerView, HEADER.LOCK, 0, 1) === 0;
    }
    return true; // No lock needed for single-threaded
  }

  private unlock(): void {
    if (this.useSharedBuffer && this.headerView) {
      Atomics.store(this.headerView, HEADER.LOCK, 0);
    }
  }

  // ─── Subclass extension points ─────────────────────────────────
  //
  // Subclasses (e.g. EncryptedHttpSource) override these to swap out the
  // "how do we learn the size" and "what headers go on every request"
  // policies while inheriting the rest of HttpSource's streaming engine —
  // SharedArrayBuffer, sliding window, background prefetch, compaction,
  // retry/backoff, stream error handling, etc.

  /**
   * Resolve the total file size. Default implementation issues a HEAD
   * request and parses Content-Length + Content-Disposition. Override to
   * source the size from elsewhere (auth token response, database, etc.);
   * throw on failure.
   */
  protected async resolveSize(): Promise<number> {
    // CDNs intermittently strip Content-Length from a HEAD (and the ranged-GET
    // fallback can transiently flake on a cold/concurrent path), so a single
    // attempt occasionally fails for a file that's perfectly fine. Retry a few
    // times before giving up; only auth/not-found (4xx) errors are fatal.
    const MAX_ATTEMPTS = 4;
    let lastError: Error = new Error("Content-Length missing");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: "HEAD",
          headers: await this.buildRequestHeaders(),
          signal: this.lifetimeAbort.signal,
        });

        if (!response.ok) {
          if (response.status === 404) throw new Error("Video not found.");
          // 401/403 on a HEAD isn't necessarily an auth failure: SigV4
          // presigned URLs (S3, Cloudflare R2, GCS) bind the signature to the
          // HTTP method, so a URL signed for GET returns 403 on HEAD even
          // though ranged GETs work perfectly. Fall back to the GET-based size
          // probes before declaring it fatal — a genuinely bad/expired
          // signature fails those too and still throws below.
          if (response.status === 403 || response.status === 401) {
            const sizeViaRange = await this.resolveSizeViaRange();
            if (sizeViaRange !== null) return sizeViaRange;
            const sizeViaGet = await this.resolveSizeViaPlainGet();
            if (sizeViaGet !== null) return sizeViaGet;
            throw new Error(
              response.status === 403
                ? "Access denied. Check video permissions."
                : "Authentication required.",
            );
          }
          // 5xx / 429 etc. — retryable.
          lastError = new Error(`HTTP ${response.status}`);
        } else {
          // Read the download filename off the HEAD response.
          this.setFilenameFromDisposition(response.headers.get("Content-Disposition"));

          const contentLength = response.headers.get("Content-Length");
          if (contentLength) return parseInt(contentLength, 10);

          // HEAD had no Content-Length — recover the total from a 1-byte ranged
          // GET's Content-Range ("bytes 0-0/<total>").
          const sizeViaRange = await this.resolveSizeViaRange();
          if (sizeViaRange !== null) return sizeViaRange;

          // Last resort: a plain (un-ranged) GET. Some servers strip
          // Content-Length on HEAD and don't CORS-expose Content-Range on a
          // 206, yet still send Content-Length on a full 200 response.
          const sizeViaGet = await this.resolveSizeViaPlainGet();
          if (sizeViaGet !== null) return sizeViaGet;

          lastError = new Error("Content-Length missing");
        }
      } catch (err) {
        // Auth / not-found are definitive — don't waste retries on them.
        const msg = (err as Error)?.message || "";
        if (/Access denied|Authentication required|Video not found/.test(msg)) {
          throw err;
        }
        // The HEAD itself failed — a thrown fetch, not a status. Some origins
        // reject HEAD entirely (or the OPTIONS preflight it triggers) while
        // serving GET Range perfectly, so a HEAD network/CORS error must NOT be
        // treated as "the file is unreachable". Recover the size from a ranged
        // GET (then a plain GET) before retrying/failing — mirrors the 403/401
        // fallback above. (issue #14)
        //
        // The question "is this origin refusing US, or is it the HEAD it does
        // not like?" is asked ALONGSIDE those two, not after them: the answer
        // takes about as long as they do, and a CORS block fails all three the
        // same way. Started here, read below — so a refusal costs no more time
        // than the fallbacks that were going to run anyway.
        const refusalProbe =
          (err as { name?: string })?.name === "TypeError" ? this.originRefusesUs() : null;
        const sizeViaRange = await this.resolveSizeViaRange();
        if (sizeViaRange !== null) return sizeViaRange;
        const sizeViaGet = await this.resolveSizeViaPlainGet();
        if (sizeViaGet !== null) return sizeViaGet;
        lastError = err instanceof Error ? err : new Error(String(err));

        // Three ways of asking have all been refused. If the origin answers a
        // no-cors probe, the file is there and this page is simply not allowed
        // to read it — a permission, not a hiccup, and no number of retries
        // turns a permission into a yes. Stop now so whatever comes next
        // (native fallback, an error the viewer can act on) happens promptly:
        // measured on archive.org, which redirects to a node with no
        // Allow-Origin header, this loop spent twelve blocked requests and
        // 10.5s before handing over to a <video> that plays the file instantly.
        const online =
          typeof self === "undefined" || !self.navigator || self.navigator.onLine;
        if (refusalProbe && online && (await refusalProbe)) {
          throw new Error(
            "Failed to fetch video resource. Check your connection or CORS settings.",
          );
        }
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }

    throw lastError;
  }

  /**
   * Recover the total file size from a 1-byte ranged GET when HEAD didn't
   * carry Content-Length. Reads the total out of Content-Range; returns null
   * if the server gives us nothing usable. The body is cancelled immediately —
   * we only want headers, and a server that ignores Range would otherwise
   * start streaming the whole file.
   */
  protected async resolveSizeViaRange(): Promise<number | null> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "GET",
        headers: await this.buildRequestHeaders({ offset: 0, length: 1 }),
        signal: this.lifetimeAbort.signal,
      });
    } catch {
      return null;
    }
    res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 206) return null;

    // When HEAD is method-blocked (presigned-GET URLs), this ranged GET is our
    // first successful response — grab the download filename off it too.
    this.setFilenameFromDisposition(res.headers.get("Content-Disposition"));

    const contentRange = res.headers.get("Content-Range");
    if (contentRange) {
      // "bytes 0-0/12345678" — capture the total after the slash (skip "*").
      const m = /\/\s*(\d+)\s*$/.exec(contentRange);
      if (m) return parseInt(m[1], 10);
    }
    // Server ignored Range and answered 200, but still reported a length.
    const cl = res.headers.get("Content-Length");
    if (res.status === 200 && cl) return parseInt(cl, 10);
    return null;
  }

  /**
   * Last-resort size probe: a plain (un-ranged) GET. Catches servers that strip
   * Content-Length on HEAD and don't CORS-expose Content-Range on a 206, yet
   * still send Content-Length on a full 200 response. The body is cancelled the
   * moment headers are in, so nothing past the headers is downloaded.
   */
  protected async resolveSizeViaPlainGet(): Promise<number | null> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "GET",
        headers: await this.buildRequestHeaders(),
        signal: this.lifetimeAbort.signal,
      });
    } catch {
      return null;
    }
    res.body?.cancel().catch(() => {});
    if (!res.ok) return null;
    const cl = res.headers.get("Content-Length");
    if (res.status === 200 && cl) return parseInt(cl, 10);
    // A 206 (server forced a default range) still carries the total in
    // Content-Range, when it's exposed.
    const contentRange = res.headers.get("Content-Range");
    if (contentRange) {
      const m = /\/\s*(\d+)\s*$/.exec(contentRange);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  /** Pull a download filename out of a Content-Disposition header, if present. */
  private setFilenameFromDisposition(disposition: string | null): void {
    if (!disposition) return;
    // Try filename*= (RFC 5987 encoded) first, then filename=.
    // Per RFC 5987 the value after `UTF-8''` should be percent-encoded
    // (so spaces become %20), but some CDNs (fsl-buckets.life seen in
    // the wild) ship the filename with raw spaces. The old `[^;\s]+`
    // greedy was stopping at the first space — capturing only "The"
    // from "The Super Mario ...mkv". Capture up to `;` or end-of-string
    // and trim, so both compliant and lazy servers work.
    let filenameMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i);
    if (filenameMatch) {
      try {
        this._contentDispositionFilename = decodeURIComponent(filenameMatch[1].trim());
      } catch {
        this._contentDispositionFilename = filenameMatch[1].trim();
      }
    }
    if (!this._contentDispositionFilename) {
      // Try quoted filename first (allows spaces inside quotes)
      filenameMatch = disposition.match(/filename\s*=\s*"([^"]+)"/i);
      if (!filenameMatch) {
        // Unquoted: capture everything until semicolon or end, then trim
        filenameMatch = disposition.match(/filename\s*=\s*([^;]+)/i);
      }
      if (filenameMatch) {
        const raw = filenameMatch[1].trim();
        try {
          this._contentDispositionFilename = decodeURIComponent(raw);
        } catch {
          this._contentDispositionFilename = raw;
        }
      }
    }
    if (this._contentDispositionFilename) {
      Logger.debug(TAG, `Content-Disposition filename: ${this._contentDispositionFilename}`);
    }
  }

  /**
   * Build the HTTP headers used for every outbound request (HEAD, range
   * GET, stream GET). Default implementation just returns the static
   * headers provided to the constructor. Override to inject per-request
   * auth/signing headers (token, HMAC signature, nonce, timestamp, ...);
   * note this is called many times across a playback session, so any
   * expensive work should be cached/memoised by the subclass.
   *
   * @param range Optional byte range the caller will request. Subclasses
   *              that sign the range (e.g. HMAC over `offset/length`) need
   *              this; pass-through callers can ignore it.
   */
  protected async buildRequestHeaders(
    range?: { offset: number; length: number; openEnded?: boolean },
  ): Promise<Record<string, string>> {
    if (range) {
      return {
        ...this.headers,
        // openEnded requests `bytes=<offset>-` (to EOF) instead of a bounded
        // `bytes=<offset>-<end>`. Some token/proxy servers reject a bounded
        // range that starts at offset 0 (e.g. bytes=0-1048575) with 403 while
        // accepting the same range open-ended — the stream read loop caps the
        // actual download at the window regardless, so this stays bounded in
        // practice. See readStreamBackground's 403 retry.
        Range: range.openEnded
          ? `bytes=${range.offset}-`
          : `bytes=${range.offset}-${range.offset + range.length - 1}`,
      };
    }
    return { ...this.headers };
  }

  async getSize(): Promise<number> {
    if (this.size >= 0) return this.size;

    try {
      this.size = await this.resolveSize();
      Logger.debug(TAG, `File size: ${this.size} bytes`);

      // Buffer sizing strategy (YouTube-like):
      // - Files <= 250MB: cache entire file (instant seek/replay, zero re-fetch)
      // - Files > 250MB: sliding window at 8% of file size (~60-90s of content)
      const maxBufferBytes = this.maxBufferSizeMB * 1024 * 1024;
      const canCacheEntireFile = this.size <= maxBufferBytes;
      const calculatedBufferSize = canCacheEntireFile
        ? this.size  // Cache entire file in memory
        : Math.floor(this.size * BUFFER_PERCENTAGE);
      this.resizeBuffer(calculatedBufferSize);
      Logger.info(
        TAG,
        `Buffer: ${(this.bufferSize / 1024 / 1024).toFixed(1)}MB ${canCacheEntireFile ? '(full file cache)' : `(${(BUFFER_PERCENTAGE * 100)}% sliding window)`} for ${(this.size / 1024 / 1024).toFixed(1)}MB file`,
      );

      return this.size;
    } catch (error) {
      // Check if it's a CORS error (no response received)
      const errorMessage = (error as any).message || "";
      const isCorsError =
        (error as any).name === "TypeError" &&
        errorMessage.includes("Failed to fetch") &&
        !errorMessage.includes("HTTP"); // Not an HTTP status error

      if (isCorsError) {
        throw new Error(
          "Failed to fetch video resource. Check your connection or CORS settings."
        );
      }

      // Re-throw other errors (403, 404, etc.)
      throw error;
    }
  }

  getContentDispositionFilename(): string | null {
    return this._contentDispositionFilename;
  }

  private get bufferEnd(): number {
    return this.atomicGetBufferStart() + this.atomicGetWritePos();
  }

  private isInBuffer(offset: number, length: number): boolean {
    const start = this.atomicGetBufferStart();
    const end = this.bufferEnd;
    return offset >= start && offset + length <= end;
  }

  private getBuffer(): Uint8Array {
    return this.useSharedBuffer ? this.dataView! : this.fallbackBuffer!;
  }

  /**
   * Read-only peek into the persistent head cache.
   * Returns a copy if the full range is covered, null otherwise.
   * Does not mutate position/state, safe for cross-source borrowing.
   */
  peekHead(offset: number, length: number): Uint8Array | null {
    if (!this.headBuffer) return null;
    if (offset < 0 || offset + length > this.headFilled) return null;
    const out = new Uint8Array(length);
    out.set(this.headBuffer.subarray(offset, offset + length));
    return out;
  }

  /**
   * Keep the opening bytes of the file as they stream past.
   *
   * Called from both write paths with the ABSOLUTE offset of the chunk being
   * written. Only extends contiguously from what is already held: a chunk that
   * starts past `headFilled` would leave a hole, and a hole in a buffer whose
   * only bound is a length is indistinguishable from data. Chunks that overlap
   * what we have (the restarted stream re-sending bytes 823+) are welcome —
   * only the new tail of them is copied.
   */
  private captureHead(absOffset: number, bytes: Uint8Array): void {
    const cap = Math.min(
      Math.max(HEAD_CACHE_BYTES, this.headFilled),
      this.size > 0 ? this.size : Number.MAX_SAFE_INTEGER,
    );
    if (this.headFilled >= cap) return;
    if (absOffset > this.headFilled) return; // would leave a hole
    const end = absOffset + bytes.byteLength;
    if (end <= this.headFilled) return; // nothing new in it

    if (!this.headBuffer || this.headBuffer.byteLength < cap) {
      const grown = new Uint8Array(cap);
      if (this.headBuffer) grown.set(this.headBuffer.subarray(0, this.headFilled));
      this.headBuffer = grown;
    }
    const copyEnd = Math.min(end, cap);
    const from = this.headFilled - absOffset;
    this.headBuffer.set(
      bytes.subarray(from, from + (copyEnd - this.headFilled)),
      this.headFilled,
    );
    this.headFilled = copyEnd;
  }

  /**
   * Record a freshly-served small read into the metadata LRU.
   * Ignores reads larger than METADATA_CACHE_MAX_CHUNK (those are payload,
   * not metadata). The caller must pass bytes that will not be mutated —
   * we keep the reference as-is. read() already hands us fresh Uint8Arrays.
   */
  private cacheMetadataRead(offset: number, bytes: Uint8Array): void {
    if (bytes.length === 0 || bytes.length > METADATA_CACHE_MAX_CHUNK) return;

    // Refresh existing entry at the same offset (dedupe).
    const existing = this.metadataCache.get(offset);
    if (existing) {
      this.metadataCache.delete(offset);
      this.metadataCacheBytes -= existing.length;
    }

    this.metadataCache.set(offset, bytes);
    this.metadataCacheBytes += bytes.length;

    // Evict oldest until under caps.
    while (
      (this.metadataCacheBytes > METADATA_CACHE_MAX_BYTES ||
        this.metadataCache.size > METADATA_CACHE_MAX_ENTRIES) &&
      this.metadataCache.size > 0
    ) {
      const oldestKey = this.metadataCache.keys().next().value as
        | number
        | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.metadataCache.get(oldestKey)!;
      this.metadataCache.delete(oldestKey);
      this.metadataCacheBytes -= oldest.length;
    }
  }

  /**
   * Read-only peek into the metadata LRU.
   * Returns a fresh copy if any cached chunk fully covers [offset, offset+length).
   * Bumps matched entry to most-recent. Safe for cross-source borrowing.
   */
  peekMetadata(offset: number, length: number): Uint8Array | null {
    if (length <= 0 || this.metadataCache.size === 0) return null;
    for (const [entryOffset, entryBytes] of this.metadataCache) {
      if (
        entryOffset <= offset &&
        entryOffset + entryBytes.length >= offset + length
      ) {
        const localOffset = offset - entryOffset;
        const out = new Uint8Array(length);
        out.set(entryBytes.subarray(localOffset, localOffset + length));
        // Bump to most-recent — delete + re-insert preserves Map order.
        this.metadataCache.delete(entryOffset);
        this.metadataCache.set(entryOffset, entryBytes);
        return out;
      }
    }
    return null;
  }

  /**
   * Read-only peek into the sliding window buffer.
   * Returns a copy if the full range is present, null otherwise.
   * Seqlock-guarded via HEADER.VERSION — if the window shifts mid-copy
   * (new stream started), returns null so the caller can fall back.
   * Does not mutate position/state, safe for cross-source borrowing.
   */
  peekRange(offset: number, length: number): Uint8Array | null {
    if (length <= 0) return null;
    // Seqlock snapshot: capture version, bounds; re-check after copy.
    const v1 = this.useSharedBuffer && this.headerView
      ? Atomics.load(this.headerView, HEADER.VERSION)
      : 0;
    const start = this.atomicGetBufferStart();
    const writePos = this.atomicGetWritePos();
    if (offset < start || offset + length > start + writePos) return null;

    const buf = this.getBuffer();
    if (!buf) return null;
    const localOffset = offset - start;
    const out = new Uint8Array(length);
    out.set(buf.subarray(localOffset, localOffset + length));

    // If the window shifted (new stream), the bytes we copied may be stale.
    if (this.useSharedBuffer && this.headerView) {
      const v2 = Atomics.load(this.headerView, HEADER.VERSION);
      if (v1 !== v2) return null;
    }
    return out;
  }

  /**
   * Start streaming from offset
   */
  private async startStream(fromOffset: number): Promise<void> {
    // If the entire file is already cached, no need to start a new stream.
    if (this.fullyBuffered) {
      Logger.debug(TAG, `startStream(${fromOffset}): skipped — file fully cached`);
      return;
    }

    await this.stopStream();

    Logger.info(TAG, `Starting stream from ${fromOffset}`);

    // A URL that has already refused for good is not worth asking again — and
    // asking is exactly what turns one refusal into a retry storm.
    if (this.fatalError) throw this.fatalError;

    // Clear any previous stream error
    this.streamError = null;

    // EOF Guard: If we are asking for data past end of file, don't fetch.
    if (this.size > 0 && fromOffset >= this.size) {
      Logger.debug(TAG, "Requested stream at or past EOF. Ignoring.");
      this.atomicSetBufferStart(fromOffset);
      this.atomicSetWritePos(0);
      this.atomicSetStreaming(false);
      return;
    }

    // Reset buffer state atomically
    // We start with the requested offset to show a correct (though empty)
    // buffer window at the seek target (prevents bar jumping to 0).
    this.atomicSetBufferStart(fromOffset);
    this.atomicSetWritePos(0);
    this.atomicSetStreaming(true);
    this.atomicIncrementVersion();
    this.streamGeneration++;

    // Starting a new stream means old full-cache is invalid
    this.fullyBuffered = false;

    // Buffer has been reset (writePos = 0): nothing is actually buffered at
    // the new position yet. maxBufferedEnd tracks the farthest byte present
    // in the CURRENT window, so it must collapse to fromOffset regardless
    // of where the old value sat. Preserving it caused the seek-bar to
    // flash a phantom "already buffered ahead" region immediately after
    // seek, before any bytes had streamed in.
    this.maxBufferedEnd = fromOffset;

    this.abortController = new AbortController();

    // Delegate fetch to background loop
    this.readStreamBackground(fromOffset).catch((err) => {
      Logger.error(TAG, "Background stream failed fatally", err);
      this.atomicSetStreaming(false);
    });
  }

  private async readStreamBackground(startOffset: number): Promise<void> {
    let retryCount = 0;
    // Track if we have committed the new buffer window to atomics
    let windowInitialized = false;
    const MAX_RETRIES = 10;
    const BASE_DELAY = 1000;
    const MAX_RANGE_RETRIES = 3; // Retries for CDN cache warming (first hit returns 200 instead of 206)
    const RANGE_RETRY_DELAY = 1500; // ms between range retries
    let rangeRetryCount = 0;
    let consecutiveOnlineFetchFailures = 0;
    // A 4xx is usually the truth — an expired signature, a revoked link — but
    // not always the FINAL truth: a CDN edge can hand back a 403 for a moment
    // during a re-auth, and a 404 can be a node that has not caught up. So it
    // is asked again, a few times, with a widening gap. Only the same answer
    // every time is treated as the answer.
    let fatalAttempts = 0;
    const MAX_FATAL_ATTEMPTS = 3;
    const FATAL_RETRY_DELAY = 700;
    let lastFatalMessage = "";
    let streamBaseOffset = startOffset;
    // Set once a bounded range fetch is rejected with 403 by a server that only
    // accepts open-ended ranges; from then on this stream requests `bytes=N-`.
    let useOpenEndedRange = false;

    while (this.atomicIsStreaming()) {
      try {
        const buffer = this.getBuffer();

        let resumeOffset: number;
        if (windowInitialized) {
          resumeOffset = this.atomicGetBufferStart() + this.atomicGetWritePos();
        } else {
          // If not initialized, we try to start from the requested offset
          resumeOffset = startOffset;
        }

        // Check EOF
        if (this.size > 0 && resumeOffset >= this.size) {
          Logger.debug(TAG, "Stream reached end of requested range (EOF)");
          this.atomicSetStreaming(false);
          break;
        }

        // Calculate bounded range end: download at most MAX_STREAM_BUFFER_SIZE
        // This prevents downloading too much data on seeks in large files.
        // When the file fits entirely in the buffer, request the full remainder
        // so we don't leave a gap at the end that forces a second fetch.
        const fileCanFit = this.size > 0 && this.bufferSize >= this.size;
        const windowLimit = fileCanFit
          ? this.size  // Full file — the window is the whole thing
          : Math.floor(Math.min(MAX_STREAM_BUFFER_SIZE, this.bufferSize * 0.9));
        // …but never ask for the window in one request — see
        // MAX_RANGE_CHUNK_SIZE. The loop below continues from where the chunk
        // ended, so the window still fills; it just fills at link speed
        // instead of whatever pace the CDN puts a long range on.
        const maxDownload = Math.min(
          windowLimit,
          windowInitialized ? MAX_RANGE_CHUNK_SIZE : this.firstRangeBytes,
        );
        const rangeEnd = this.size > 0
          ? Math.min(resumeOffset + maxDownload - 1, this.size - 1)
          : resumeOffset + maxDownload - 1;

        // Fetch with bounded range
        Logger.debug(TAG, `Fetching range: ${resumeOffset}-${rangeEnd} (max ${(maxDownload / 1024 / 1024).toFixed(1)}MB)`);
        const response = await fetch(this.url, {
          headers: await this.buildRequestHeaders({
            offset: resumeOffset,
            length: rangeEnd - resumeOffset + 1,
            openEnded: useOpenEndedRange,
          }),
          cache: 'no-store', // Prevent cached 200 responses
          signal: this.abortController!.signal,
        });

        // Some token/proxy file servers reject a BOUNDED range that starts at
        // offset 0 (e.g. `bytes=0-1048575`) with 403, yet serve the very same
        // range OPEN-ENDED (`bytes=0-`) — and any non-zero-offset bounded range
        // — as 206. (Seen with Telegram/CDN proxy workers whose first-chunk
        // logic caps a 0-based bounded range.) Retry this stream open-ended; the
        // read loop still stops at the window (maxDownload) and cancels, so we
        // never pull the whole file. Only flips once, so if the open-ended fetch
        // also 403s it falls through to the fatal-4xx path below.
        if (response.status === 403 && !useOpenEndedRange) {
          useOpenEndedRange = true;
          try { response.body?.cancel(); } catch {}
          Logger.warn(
            TAG,
            `403 for bounded range ${resumeOffset}-${rangeEnd}; retrying open-ended (bytes=${resumeOffset}-)`,
          );
          continue;
        }

        // Check for 206 Partial Content response
        // If server returns 200, it may be a CDN cache warming issue (e.g. Cloudflare first hit)
        // Retry a few times before treating as fatal — CDN often supports range after caching the file
        if (response.status === 200) {
          // CDN cache-warming (e.g. Cloudflare's first hit) sometimes answers
          // 200, then 206 once the file is cached — retry a few times before
          // concluding the server truly lacks Range support.
          rangeRetryCount++;
          if (rangeRetryCount <= MAX_RANGE_RETRIES) {
            try { response.body?.cancel(); } catch {}
            Logger.warn(
              TAG,
              `Server returned 200 instead of 206 (attempt ${rangeRetryCount}/${MAX_RANGE_RETRIES}). ` +
              `CDN may be caching — retrying in ${RANGE_RETRY_DELAY}ms...`
            );
            await new Promise(r => setTimeout(r, RANGE_RETRY_DELAY));
            continue; // Retry the fetch loop
          }

          // Retries exhausted → no Range support. For the initial 0-based
          // stream we can still play by consuming the whole body sequentially
          // (full-cache if it fits the cap, else bounded linear mode). A
          // non-zero offset means a seek, which can't be served without Range.
          if (startOffset === 0) {
            Logger.warn(TAG, `No Range support after ${MAX_RANGE_RETRIES} retries — falling back to sequential playback.`);
            await this.consumeNonRangeStream(response);
            return; // consumeNonRangeStream drives the buffer to EOF + clears streaming
          }

          try { response.body?.cancel(); } catch {}
          const rangeError = new Error("Server does not support range requests.");
          Logger.error(TAG, `Server returned 200 for offset ${startOffset}; range requests not supported.`);
          this.abortController?.abort();
          this.atomicSetStreaming(false);
          this.streamError = rangeError;
          throw rangeError;
        }

        // Reset range retry counter on successful 206
        rangeRetryCount = 0;
        // …and the fatal streak: the URL answered, so whatever it was is over.
        if (response.ok || response.status === 206) {
          fatalAttempts = 0;
          lastFatalMessage = "";
        }

        if (!response.ok && response.status !== 206) {
          // If 4xx error (client error), maybe don't retry indefinitely
          if (response.status >= 400 && response.status < 500) {
            if (response.status === 416) {
              // Range Not Satisfiable
              Logger.warn(TAG, "Range not satisfiable, assuming EOF");
              this.atomicSetStreaming(false);
              break;
            }
            throw new Error(`HTTP ${response.status} (Fatal)`);
          }
          throw new Error(`HTTP ${response.status}`);
        }

        this.reader = response.body!.getReader();
        // Capture this loop's own reader. A superseding startStream (e.g. a seek
        // repositioning right after audio-only unpaused and resumed this parked
        // loop) swaps this.reader out; reading this.reader below would then hit a
        // null mid-swap (the "this.reader.read of null" crash) or steal the new
        // stream's reader and corrupt it. The loop bails the moment this.reader
        // is no longer ours.
        const reader = this.reader;
        retryCount = 0; // Reset retry on success
        consecutiveOnlineFetchFailures = 0; // Successful fetch — not a CORS issue

        // Initialize buffer window if this is the first successful connection
        if (!windowInitialized) {
          this.atomicSetBufferStart(startOffset);
          this.atomicSetWritePos(0);
          windowInitialized = true;
        }

        let downloadedBytes = 0;
        let lastLogBytes = 0;
        const startTime = Date.now();
        // Time this loop spends PARKED at the prefetch gate, which is our own
        // throttle rather than anything the link did. It has to come out of the
        // throughput windows below: with it in, a stream that is deliberately
        // paced reads as a slow link. That is how a connection delivering
        // ~4 MB/s reported 0.07 MB/s once the buffer was ahead — and the ABR,
        // which sizes rungs off exactly this number, then crawled up the ladder
        // one step at a time instead of settling on the quality the link
        // actually carries.
        let gateMsWindow = 0; // parked since the last speed sample
        let gateMsTotal = 0; // parked across this whole stream

        // Initialize network stats timing
        if (this.streamStartTime === 0) {
          this.streamStartTime = startTime;
          this.lastSpeedTime = startTime;
        }

        // Read Loop
        while (this.atomicIsStreaming()) {
          // Yield the network to a bandwidth-starved native <audio> track.
          const parkedAt = Date.now();
          await this.awaitPrefetchGate();
          const parkedMs = Date.now() - parkedAt;
          gateMsWindow += parkedMs;
          gateMsTotal += parkedMs;
          // Bail if the stream stopped OR was superseded while we were parked
          // (this.reader swapped to a new stream's reader — reading it here would
          // corrupt the new stream and can be null mid-swap).
          if (!this.atomicIsStreaming() || this.reader !== reader) break;
          const { done, value } = await reader.read();
          if (done) {
            // A body that ends short of the file is normally OUR range cap
            // (MAX_RANGE_CHUNK_SIZE), not the end of the data. Stay streaming
            // and let the outer loop fetch the next chunk from where this one
            // stopped — tearing the stream down here would make the next read
            // miss and pay a full restart every few MB. `downloadedBytes > 0`
            // keeps a server that answers with an empty body from spinning
            // the loop.
            const nextOffset =
              this.atomicGetBufferStart() + this.atomicGetWritePos();
            const moreToFetch =
              this.size > 0 && nextOffset < this.size && downloadedBytes > 0;
            if (!moreToFetch) this.atomicSetStreaming(false);
            break;
          }

          if (value) {
            downloadedBytes += value.length;

            // Track global network stats
            this.totalBytesDownloaded += value.length;
            const now = Date.now();
            // Active (unparked) time only — see gateMsWindow above.
            const speedElapsed = (now - this.lastSpeedTime - gateMsWindow) / 1000;
            if (speedElapsed >= 0.5) {
              const bytesSinceLast = this.totalBytesDownloaded - this.lastSpeedBytes;
              this.currentSpeed = bytesSinceLast / speedElapsed;
              this.lastSpeed = this.currentSpeed;
              this.lastSpeedBytes = this.totalBytesDownloaded;
              this.lastSpeedTime = now;
              gateMsWindow = 0;
            }

            if (downloadedBytes - lastLogBytes > 1024 * 1024) {
              // Log every 1MB
              const elapsed = (Date.now() - startTime - gateMsTotal) / 1000;
              // Per-1MB active rate (bytes/s) — captured even for a sub-0.5s
              // download that the window above never gets to measure. Parked
              // time is excluded here for the same reason as the window.
              if (elapsed > 0) this.lastSpeed = downloadedBytes / elapsed;
              const speed =
                elapsed > 0 ? downloadedBytes / 1024 / 1024 / elapsed : 0;
              Logger.debug(
                TAG,
                `Stream progress: ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB read @ ${speed.toFixed(2)} MB/s`,
              );
              lastLogBytes = downloadedBytes;
            }

            let currentWritePos = this.atomicGetWritePos();
            if (currentWritePos + value.length <= buffer.length) {
              // Write data to buffer
              let locked = false;
              for (let i = 0; i < 5; i++) {
                if (this.tryLock()) {
                  locked = true;
                  break;
                }
                await new Promise((r) => setTimeout(r, 1));
              }

              if (locked) {
                buffer.set(value, currentWritePos);
                this.captureHead(
                  this.atomicGetBufferStart() + currentWritePos,
                  value,
                );
                const newWritePos = currentWritePos + value.length;
                this.atomicSetWritePos(newWritePos);

                // Update max buffered position
                const currentEnd = this.atomicGetBufferStart() + newWritePos;
                if (currentEnd > this.maxBufferedEnd) {
                  this.maxBufferedEnd = currentEnd;
                }


                // When the entire file fits in the buffer, skip all limit/compaction
                // checks — just stream straight to EOF. Buffer has room for everything.
                const fileCanFitInBuffer = this.size > 0 && this.bufferSize >= this.size;

                // Check if buffer is getting full or download limit reached
                const totalDownloaded = currentEnd - streamBaseOffset;
                const maxDownload = Math.floor(Math.min(
                  MAX_STREAM_BUFFER_SIZE,
                  this.bufferSize * 0.9
                ));
                const limitReached = !fileCanFitInBuffer && totalDownloaded >= maxDownload;
                const bufferAlmostFull = !fileCanFitInBuffer && newWritePos >= buffer.length * 0.9;

                if (limitReached || bufferAlmostFull) {
                  // Try buffer compaction for continuous forward streaming
                  const bufStart = this.atomicGetBufferStart();
                  const consumed = this.position - bufStart;

                  if (consumed > this.bufferSize * 0.25 &&
                      this.size > 0 && currentEnd < this.size) {
                    const shift = Math.floor(consumed);
                    if (shift > 0 && newWritePos > shift) {
                      buffer.copyWithin(0, shift, newWritePos);
                      this.atomicSetBufferStart(bufStart + shift);
                      this.atomicSetWritePos(newWritePos - shift);
                      streamBaseOffset = bufStart + shift;
                      this.unlock();
                      Logger.debug(TAG, `Buffer compacted: reclaimed ${(shift / 1024 / 1024).toFixed(1)}MB`);
                      break; // Continue with new fetch in outer loop
                    }
                  }

                  // Can't compact - stop stream
                  this.unlock();
                  Logger.debug(TAG, `Downloaded ${(totalDownloaded / 1024 / 1024).toFixed(1)}MB (${limitReached ? 'limit reached' : 'buffer full'}), stopping stream`);
                  this.atomicSetStreaming(false);
                  break;
                }

                this.unlock();

                // Check EOF
                if (this.size > 0 && currentEnd >= this.size) {
                  // Mark fully buffered if the entire file is in the buffer
                  // (start at 0 and reached EOF, meaning all bytes are present)
                  const bufStart = this.atomicGetBufferStart();
                  if (bufStart === 0 && this.bufferSize >= this.size) {
                    this.fullyBuffered = true;
                    Logger.info(TAG, `Entire file cached in memory (${(this.size / 1024 / 1024).toFixed(1)}MB)`);
                  }
                  Logger.debug(TAG, `Reached EOF (bufferStart=${bufStart}, bufferEnd=${currentEnd}), stopping stream`);
                  this.atomicSetStreaming(false);
                  break;
                }
              } else {
                Logger.error(TAG, "Failed to acquire lock for writing");
                this.atomicSetStreaming(false);
                break;
              }
            } else {
              Logger.debug(TAG, "Buffer full, stopping stream");
              this.atomicSetStreaming(false);
              break;
            }
          }
        }

        // Clean up reader before potentially starting new fetch after compaction
        try { await this.reader?.cancel(); } catch {}
        this.reader = null;
      } catch (error) {
        if ((error as any).name === "AbortError") {
          break;
        }

        // Check for CORS errors (TypeError: Failed to fetch)
        // IMPORTANT: "Failed to fetch" also happens on transient network drops
        // where navigator.onLine still reports true (browser detection lags).
        // Only classify as CORS after multiple consecutive failures while online.
        const errorMessage = (error as any).message || "";
        const isFetchError =
          (error as any).name === "TypeError" &&
          errorMessage.includes("Failed to fetch");
        const isOffline = typeof self !== "undefined" && self.navigator && !self.navigator.onLine;

        if (isFetchError) {
          if (isOffline) {
            // Clearly offline — not a CORS issue
            consecutiveOnlineFetchFailures = 0;
          } else if (await this.originRefusesUs()) {
            // Asked, rather than inferred. "Failed to fetch" reads the same
            // whether a host refused this page or was not there, and waiting
            // for three of them to decide costs three round trips plus their
            // backoff — measured at twelve blocked requests and ~12s before a
            // player with fallback="native" gave up and handed over, on a file
            // the browser itself plays instantly. A no-cors probe needs no
            // permission and only has to answer: if it does, the bytes are
            // there and the block is CORS, which no amount of retrying fixes.
            const corsError = new Error(
              "Failed to fetch video resource. Check your connection or CORS settings."
            );
            Logger.error(
              TAG,
              `CORS error accessing ${this.url} — the origin answered a no-cors probe but refuses this page`,
            );
            this.atomicSetStreaming(false);
            this.streamError = corsError;
            this.fatalError = corsError;
            throw corsError;
          } else {
            // Online but fetch failed — could be transient network drop OR CORS
            consecutiveOnlineFetchFailures++;
            if (consecutiveOnlineFetchFailures >= CORS_DETECTION_THRESHOLD) {
              const corsError = new Error(
                "Failed to fetch video resource. Check your connection or CORS settings."
              );
              Logger.error(TAG, `CORS error accessing ${this.url} (${consecutiveOnlineFetchFailures} consecutive failures while online)`);
              this.atomicSetStreaming(false);
              this.streamError = corsError;
              this.fatalError = corsError;
              throw corsError;
            }
            Logger.warn(TAG, `Fetch failed while online (${consecutiveOnlineFetchFailures}/${CORS_DETECTION_THRESHOLD}), may be transient network issue`);
          }
        }

        // Check for range request error - don't retry, it's a fatal server limitation
        const isRangeError =
          (error as any).message &&
          (error as any).message.includes("does not support range requests");

        if (isRangeError) {
          Logger.error(TAG, `Range requests not supported, cannot stream this URL`);
          this.atomicSetStreaming(false);
          // streamError already set above
          throw error;
        }

        // 4xx client errors (other than 416 → EOF) are flagged with "(Fatal)"
        // by the response-status check above. Retrying a 404 / 403 / 410
        // mid-stream just delays the inevitable error by ~MAX_RETRIES × backoff
        // and leaves the buffering UI spinning. Fail fast so the player can
        // surface the real reason to the user.
        const errMsgForFatal = (error as any)?.message || "";
        if (errMsgForFatal.includes("(Fatal)")) {
          // Same failure as last time? Then it is a fact about the URL, not a
          // moment. A DIFFERENT one starts the count again — something is still
          // changing, and that is worth another ask.
          if (errMsgForFatal !== lastFatalMessage) {
            lastFatalMessage = errMsgForFatal;
            fatalAttempts = 0;
          }
          fatalAttempts++;
          if (fatalAttempts < MAX_FATAL_ATTEMPTS && this.atomicIsStreaming()) {
            const wait = FATAL_RETRY_DELAY * fatalAttempts;
            Logger.warn(
              TAG,
              `${errMsgForFatal} (attempt ${fatalAttempts}/${MAX_FATAL_ATTEMPTS}) — retrying in ${wait}ms`,
            );
            try {
              if (this.reader) await this.reader.cancel();
            } catch {}
            this.reader = null;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          Logger.error(
            TAG,
            `Fatal HTTP error after ${fatalAttempts} attempts, giving up: ${errMsgForFatal}`,
          );
          this.atomicSetStreaming(false);
          this.streamError = error instanceof Error ? error : new Error(errMsgForFatal);
          this.fatalError = this.streamError;
          break;
        }

        Logger.warn(TAG, `Stream error, retrying...`, error);

        try {
          if (this.reader) await this.reader.cancel();
        } catch {}
        this.reader = null; // Clear reader

        // Check for offline state - wait for connection before retrying or counting against limit
        if (
          typeof self !== "undefined" &&
          self.navigator &&
          !self.navigator.onLine
        ) {
          Logger.warn(TAG, "Network offline, waiting for connection...");
          // Wait for online event, abort signal, or timeout — whichever comes first
          const abortSignal = this.abortController?.signal;
          await new Promise<void>((resolve) => {
            let resolved = false;
            const cleanup = () => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeout);
              if (typeof self !== "undefined") self.removeEventListener("online", onOnline);
              abortSignal?.removeEventListener("abort", onAbort);
              resolve();
            };
            const timeout = setTimeout(() => {
              Logger.warn(TAG, "Offline wait timeout, retrying anyway...");
              cleanup();
            }, 30000);
            const onOnline = () => {
              Logger.info(TAG, "Network online, resuming...");
              cleanup();
            };
            const onAbort = () => cleanup(); // Stream stopped, exit immediately
            if (typeof self !== "undefined") self.addEventListener("online", onOnline);
            abortSignal?.addEventListener("abort", onAbort);
          });
          // If stream was stopped (e.g. by a seek), bail out immediately
          if (!this.atomicIsStreaming()) break;
          retryCount = 0; // Reset retries since we were offline
          continue;
        }

        retryCount++;
        if (retryCount > MAX_RETRIES) {
          Logger.error(TAG, `Max retries (${MAX_RETRIES}) reached, giving up.`);
          this.atomicSetStreaming(false);
          // Surface the last error to waitForData so the player can show
          // it instead of spinning forever on the buffering UI. Without
          // this, atomicIsStreaming() flips false silently and consumers
          // can't tell "EOF" apart from "server died mid-stream."
          this.streamError = (error instanceof Error)
            ? error
            : new Error(typeof error === "string" ? error : "Stream failed after maximum retries");
          // Ten attempts with backoff have been spent. Whatever this is, one
          // more startStream() will not fix it — and read() would call one.
          this.fatalError = this.streamError;
          break;
        }
        // Backoff — listen for online event or abort signal to exit early
        const delay = Math.min(BASE_DELAY * Math.pow(1.5, retryCount), 10000);
        const backoffAbortSignal = this.abortController?.signal;
        await new Promise<void>((resolve) => {
          let resolved = false;
          const cleanup = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (typeof self !== "undefined") self.removeEventListener("online", onOnline);
            backoffAbortSignal?.removeEventListener("abort", onAbort);
            resolve();
          };
          const timer = setTimeout(cleanup, delay);
          const onOnline = () => {
            Logger.info(TAG, "Online event during backoff — retrying immediately");
            retryCount = 0;
            consecutiveOnlineFetchFailures = 0;
            cleanup();
          };
          const onAbort = () => cleanup(); // Stream stopped, exit immediately
          if (typeof self !== "undefined" && self.addEventListener) {
            self.addEventListener("online", onOnline);
          }
          backoffAbortSignal?.addEventListener("abort", onAbort);
        });
      }
    }

    // Cleanup
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
      this.reader = null;
    }
  }

  /**
   * Consume a single 200 response as the whole file from byte 0, used when the
   * server has no Range support. Two outcomes:
   *  - File fits the buffer cap → cache it entirely → full random access
   *    (seek/thumbnails keep working once downloaded).
   *  - File exceeds the cap (or size unknown) → bounded forward-only sliding
   *    window (linearMode): playback is linear, seeking impossible. The UI is
   *    notified via onLinearMode so it can hide the timeline.
   * The response body MUST start at byte 0 (caller guarantees startOffset===0).
   */
  private async consumeNonRangeStream(response: Response): Promise<void> {
    this.rangeUnsupported = true;

    // Grow the buffer toward the cap: a ≤cap file caches whole, an over-cap
    // file gets as large a linear window as the cap allows. resizeBuffer
    // reallocates the SharedArrayBuffer, which resets the VERSION counter in
    // the fresh header — an in-flight waitForData() from the first read would
    // then read a different version and bail as "superseded". Preserve VERSION
    // across the realloc so that waiter keeps going.
    if (this.size > 0) {
      const ver = this.useSharedBuffer && this.headerView
        ? Atomics.load(this.headerView, HEADER.VERSION)
        : 0;
      this.resizeBuffer(this.size);
      if (this.useSharedBuffer && this.headerView) {
        Atomics.store(this.headerView, HEADER.VERSION, ver);
      }
    }
    const buffer = this.getBuffer();
    const fullFit = this.size > 0 && this.bufferSize >= this.size;

    if (!fullFit) {
      this.linearMode = true;
      Logger.warn(
        TAG,
        `Linear (non-seekable) playback: ${this.size > 0 ? (this.size / 1048576).toFixed(0) + "MB" : "unknown size"} ` +
        `exceeds the ${this.maxBufferSizeMB}MB cache cap or size is unknown.`,
      );
      try { this.onLinearMode?.(); } catch {}
    } else {
      Logger.info(TAG, `Caching entire ${(this.size / 1048576).toFixed(1)}MB file in memory (no Range support).`);
    }

    // The body represents [0, size). Reset the window to the start. NOTE: do
    // NOT bump the version here — this is a continuation of the same 0-based
    // stream startStream() already opened, and an in-flight waitForData() from
    // the first read would treat a version change as "superseded" and bail,
    // tearing down this consume loop.
    this.atomicSetBufferStart(0);
    this.atomicSetWritePos(0);
    this.maxBufferedEnd = 0;
    this.fullyBuffered = false;
    this.atomicSetStreaming(true);

    if (!response.body) {
      this.streamError = new Error("Empty response body");
      this.atomicSetStreaming(false);
      return;
    }

    const reader = response.body.getReader();
    this.reader = reader;

    try {
      while (this.atomicIsStreaming()) {
        // Yield the network to a bandwidth-starved native <audio> track.
        await this.awaitPrefetchGate();
        if (!this.atomicIsStreaming()) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        this.totalBytesDownloaded += value.length;
        await this.writeSequential(value, buffer, fullFit);
      }
    } catch (err) {
      if ((err as any)?.name !== "AbortError") {
        this.streamError = err instanceof Error ? err : new Error(String(err));
        Logger.error(TAG, "Non-range stream failed", err);
      }
    } finally {
      try { await reader.cancel(); } catch {}
      this.reader = null;
    }

    // EOF housekeeping.
    const end = this.atomicGetBufferStart() + this.atomicGetWritePos();
    if (this.size <= 0) this.size = end; // size was unknown — we know it now
    if (fullFit && this.atomicGetBufferStart() === 0 && this.size > 0 && end >= this.size) {
      this.fullyBuffered = true;
      Logger.info(TAG, `Entire file cached (${(this.size / 1048576).toFixed(1)}MB) — full random access.`);
    }
    this.atomicSetStreaming(false);
  }

  /**
   * Append a chunk to the buffer for the non-range stream. In full-cache mode
   * the buffer always has room. In linearMode it slides the window forward by
   * discarding already-consumed bytes, applying backpressure (waiting for the
   * demuxer to catch up) when the window can't be advanced yet.
   */
  private async writeSequential(
    value: Uint8Array,
    buffer: Uint8Array,
    fullFit: boolean,
  ): Promise<void> {
    let written = 0;
    while (written < value.length) {
      if (!this.atomicIsStreaming()) return;

      let writePos = this.atomicGetWritePos();
      if (writePos >= buffer.length) {
        if (fullFit) return; // Shouldn't happen — buffer >= file. Safety stop.
        // Linear: the buffer's full of read-ahead. Drop the oldest history to
        // make room; if readMax hasn't advanced past the trailing window yet
        // there's nothing droppable — that's normal backpressure (we already
        // hold ~half a buffer ahead), so just wait for the demuxer to consume.
        // The while-loop's streaming check exits us cleanly on seek/stop, and an
        // unreachable read fails on the read side, so no hard stall is needed.
        if (!(await this.slideWindow(buffer))) {
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        writePos = this.atomicGetWritePos();
      }

      const room = buffer.length - writePos;
      const chunk = Math.min(room, value.length - written);

      let locked = false;
      for (let i = 0; i < 50; i++) {
        if (this.tryLock()) { locked = true; break; }
        await new Promise((r) => setTimeout(r, 1));
      }
      if (!locked) { await new Promise((r) => setTimeout(r, 5)); continue; }

      const slice = value.subarray(written, written + chunk);
      buffer.set(slice, writePos);
      this.captureHead(this.atomicGetBufferStart() + writePos, slice);
      const newWritePos = writePos + chunk;
      this.atomicSetWritePos(newWritePos);
      const end = this.atomicGetBufferStart() + newWritePos;
      if (end > this.maxBufferedEnd) this.maxBufferedEnd = end;
      this.unlock();

      written += chunk;
    }
  }

  /**
   * Slide the linear-mode window forward to make room for new download. Keeps a
   * trailing history of up to LINEAR_TRAIL_BYTES behind the playhead so the user
   * can seek backward into already-played content that's still in RAM — only the
   * bytes older than that are dropped. Returns false when nothing can be dropped
   * yet (playhead hasn't advanced past the trailing window), so the caller
   * applies backpressure. This bounds read-ahead to (bufferSize - trail).
   */
  private async slideWindow(buffer: Uint8Array): Promise<boolean> {
    const bufStart = this.atomicGetBufferStart();
    const writePos = this.atomicGetWritePos();
    // Decide the oldest byte to keep. Two pulls, take whichever is LOWER so we
    // never drop something in use:
    //  - lag: the lowest recent read offset — covers a lagging interleaved
    //    stream or a just-happened backward seek (their bytes must stay).
    //  - readMax - trail: keep ~half a buffer of history behind the frontier
    //    for backward seeking when the streams sit close together.
    // Both rise as playback advances, so keepFrom advances and the window can
    // always slide forward to feed the frontier — no deadlock on a rewind.
    const trail = Math.floor(this.bufferSize / 2);
    const lag = this.recentReads.length
      ? Math.min(...this.recentReads)
      : this.readMax;
    const keepFrom = Math.max(0, Math.min(lag, this.readMax - trail));
    const shift = Math.min(keepFrom - bufStart, writePos);
    if (shift <= 0) return false;

    let locked = false;
    for (let i = 0; i < 50; i++) {
      if (this.tryLock()) { locked = true; break; }
      await new Promise((r) => setTimeout(r, 1));
    }
    if (!locked) return false;

    buffer.copyWithin(0, shift, writePos);
    this.atomicSetBufferStart(bufStart + shift);
    this.atomicSetWritePos(writePos - shift);
    this.unlock();
    return true;
  }

  /**
   * Stop pulling, but keep what has already been read.
   *
   * For when the player knows nothing further can be used — the clear lead of
   * an encrypted source has ended, say. close() would be wrong there: the
   * buffered part is still valid to seek around in, and tearing the source down
   * turns a stopped playback into a broken one. Reading on is the waste, and on
   * a large file it is a very expensive one.
   */
  haltStreaming(): void {
    void this.stopStream();
  }

  private async stopStream(): Promise<void> {
    this.atomicSetStreaming(false);

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
      this.reader = null;
    }
  }

  /**
   * Is the origin there, and simply refusing us?
   *
   * A no-cors request is one the browser will send anywhere: the response is
   * opaque, so nothing can be read from it, but the fact that it RESOLVED means
   * the server answered. Paired with a CORS-mode fetch that failed, that is the
   * difference between "this host will not share with this page" (permanent)
   * and "this host is not reachable" (worth retrying).
   */
  private async originRefusesUs(): Promise<boolean> {
    try {
      const cutoff = new AbortController();
      const timer = setTimeout(() => cutoff.abort(), 1500);
      try {
        await fetch(this.url, {
          method: "HEAD",
          mode: "no-cors",
          cache: "no-store",
          signal: cutoff.signal,
        });
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // No answer (or too slow to wait for): treat it as a network problem and
      // let the ordinary retry path have its go.
      return false;
    }
  }

  private async waitForData(
    offset: number,
    length: number,
    timeout = 30000, // Base timeout, extended if progress is being made
  ): Promise<boolean> {
    const startTime = Date.now();
    let deadline = startTime + timeout;
    let needed = offset + length;

    // Clamp to known file size
    if (this.size > 0 && needed > this.size) {
      needed = this.size;
    }

    // If we're already past/at EOF, return true (will read 0 bytes)
    if (offset >= needed && this.size > 0 && offset >= this.size) return true;

    const initialVersion =
      this.useSharedBuffer && this.headerView
        ? Atomics.load(this.headerView, HEADER.VERSION)
        : 0;

    // Track progress to allow slow but steady streams
    let lastProgress = this.bufferEnd;
    let lastProgressTime = Date.now();
    const PROGRESS_TIMEOUT = 15000; // 15s without any progress = stalled
    // A stream that has not delivered its FIRST byte is a different case. A
    // slow link still trickles bytes; a request the origin (or a proxy in
    // front of it) is sitting on delivers none at all, and a fresh connection
    // usually answers at once. Waiting the full 15s there — twice, once per
    // read that finds the corpse — was 30s of black screen before playback.
    const FIRST_BYTE_TIMEOUT = 6000;

    while (this.bufferEnd < needed && this.atomicIsStreaming()) {
      // Check for fatal stream errors (e.g., CORS) and throw immediately
      if (this.streamError) {
        throw this.streamError;
      }

      const now = Date.now();

      // Check if we're making progress (buffer is growing)
      if (this.bufferEnd > lastProgress) {
        // Progress detected! Reset progress timeout
        lastProgress = this.bufferEnd;
        lastProgressTime = now;

        // For slow networks, extend the deadline as long as progress continues
        // This allows slow but steady downloads to complete
        const elapsed = now - startTime;
        if (elapsed > timeout * 0.8) {
          // If we've used 80% of timeout but are still making progress, extend it
          deadline = now + PROGRESS_TIMEOUT;
        }
      }

      // Check for stalled stream (no progress for PROGRESS_TIMEOUT)
      const timeSinceProgress = now - lastProgressTime;
      const noBytesYet = this.atomicGetWritePos() === 0;
      if (
        timeSinceProgress >
        (noBytesYet ? FIRST_BYTE_TIMEOUT : PROGRESS_TIMEOUT)
      ) {
        Logger.error(
          TAG,
          `Stream stalled: no progress for ${(timeSinceProgress / 1000).toFixed(1)}s at ${offset}, needed ${needed}, currently ${this.bufferEnd}`,
        );
        return false;
      }

      // Also check absolute deadline
      if (now > deadline) {
        Logger.error(
          TAG,
          `Timeout waiting for data at ${offset}, needed ${needed}, currently ${this.bufferEnd}`,
        );
        return false;
      }

      // Check if stream was superseded by another startStream call
      if (this.useSharedBuffer && this.headerView) {
        if (Atomics.load(this.headerView, HEADER.VERSION) !== initialVersion) {
          Logger.warn(TAG, `Stream superseded while waiting for ${offset}`);
          return false;
        }
      }

      // Park until the bytes actually land. The timer only bounds how long we
      // go without re-running the checks above; on the SAB path the writer is
      // another thread and never calls wakeBufferWaiters, so keep polling
      // tight there. On the main-thread path the wake is exact, so the timer
      // can be loose.
      if (this.useSharedBuffer && this.headerView) {
        await new Promise((r) => setTimeout(r, 2));
      } else {
        await this.waitForBufferAdvance(needed, 250);
      }
    }

    const success = this.bufferEnd >= needed;

    // Check for fatal stream errors one more time after loop
    if (this.streamError) {
      throw this.streamError;
    }

    // Special case: If stream ended normally, and we have data up to the end, it's success (EOF read)
    if (!success && !this.atomicIsStreaming()) {
      if (this.size > 0 && this.bufferEnd >= this.size) {
        return true;
      }
      if (this.bufferEnd >= needed) {
        // Should be covered by success check, but for clarity
        return true;
      }
      Logger.warn(
        TAG,
        `Stream ended before reaching needed offset ${needed} (current end: ${this.bufferEnd})`,
      );
    }

    return success;
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    // Torn down mid-read. Say so plainly rather than restarting streams on a
    // dead source — the caller (a demuxer being replaced) is on its way out.
    if (this.closed) throw new Error("Source closed");
    // LRU peek first — metadata reads often repeat after the sliding window
    // has moved on. Cheap: single Map scan, bounded size.
    const cached = this.peekMetadata(offset, length);
    if (cached) {
      this.position = offset + length;
      Logger.debug(TAG, `Read: served from metadata LRU`);
      return cached.buffer as ArrayBuffer;
    }

    const result = await this._readInternal(offset, length);

    // Populate LRU on every small read served. Result is a fresh ArrayBuffer
    // (read paths all allocate new Uint8Arrays), safe to keep by-reference.
    if (result.byteLength > 0 && result.byteLength <= METADATA_CACHE_MAX_CHUNK) {
      this.cacheMetadataRead(offset, new Uint8Array(result));
    }
    return result;
  }

  private async _readInternal(offset: number, length: number): Promise<ArrayBuffer> {
    Logger.debug(
      TAG,
      `Read: offset=${offset}, length=${length}, bufferStart=${this.atomicGetBufferStart()}, bufferEnd=${this.bufferEnd}, streaming=${this.atomicIsStreaming()}`,
    );

    // EOF Check
    if (this.size > 0 && offset >= this.size) {
      Logger.debug(TAG, `Read: returning empty (EOF)`);
      return new ArrayBuffer(0);
    }

    // Fast path: entire file is cached in memory — serve directly, no network needed.
    // Use relaxed check: offset must be in buffer, length can extend past EOF
    // (FFmpeg commonly over-reads; readFromBuffer clamps to available data).
    if (this.fullyBuffered && offset >= this.atomicGetBufferStart() && offset < this.bufferEnd) {
      this.consecutiveForceRestarts = 0;
      Logger.debug(TAG, `Read: served from full-file cache`);
      return this.readFromBuffer(offset, length);
    }

    // Check persistent head cache first (avoids stream restart for metadata)
    if (this.headBuffer && offset + length <= this.headFilled) {
      const result = new Uint8Array(length);
      result.set(this.headBuffer.subarray(offset, offset + length));
      this.position = offset + length;

      // Head cache is always buffered, but don't update maxBufferedEnd here
      // as it's a fixed cache, not streaming data
      Logger.debug(TAG, `Read: served from head cache`);
      return result.buffer;
    }

    // Check buffer first
    if (this.isInBuffer(offset, length)) {
      // Don't update maxBufferedEnd on reads - reads consume data, they don't indicate buffering
      // maxBufferedEnd is updated when we write to the buffer (streaming)

      // Reset force restart counter on successful read
      this.consecutiveForceRestarts = 0;
      // Back on the sequential window — a stray one-off read didn't turn into
      // a seek, so forget the streak.
      this.consecutiveOneOffFetches = 0;
      // The seek (if any) landed inside the window — no restart needed.
      this.seekHinted = false;

      Logger.debug(TAG, `Read: serving from buffer`);
      return this.readFromBuffer(offset, length);
    }

    // Non-range source: there is exactly one stream (the full file from 0),
    // so we can never restart at a different offset. Forward reads wait for the
    // single sequential stream to reach them; reads behind the sliding window
    // were discarded (linear mode) and can't be served.
    if (this.rangeUnsupported) {
      if (offset < this.atomicGetBufferStart()) {
        // Behind the window — only happens on a backward seek / random access
        // in linear mode, which this source can't satisfy.
        throw new Error("Server does not support range requests.");
      }
      // Linear mode holds at most one bufferSize-wide window. A read whose end
      // is past (windowStart + bufferSize) can never sit in the window — that's
      // a far forward seek / moov-at-end on an over-cap file, or a single read
      // bigger than the buffer. Bail rather than wait forever.
      if (this.linearMode && offset + length > this.atomicGetBufferStart() + this.bufferSize) {
        throw new Error("Server does not support range requests.");
      }
      if (this.atomicIsStreaming()) {
        const ok = await this.waitForData(offset, length);
        if (ok) return this.readFromBuffer(offset, length);
      }
      if (this.isInBuffer(offset, length)) return this.readFromBuffer(offset, length);
      if (this.streamError) throw this.streamError;
      throw new Error("Server does not support range requests.");
    }

    // Optimization: Check if the ACTIVE stream covers this request.
    // If so, we strictly wait for it. Interrupting an active stream that is
    // successfully filling the buffer is inefficient and causes stalls.
    //
    // HOWEVER: if the requested offset is far ahead of what's currently buffered,
    // waiting for sequential download to reach it is wasteful (e.g., WebM/MKV
    // files where FFmpeg reads the Cues/index from the end of the file during open).
    // In that case, restart the stream from the requested offset.
    const streamStart = this.atomicGetBufferStart();
    const currentEnd = this.bufferEnd;
    const gap = offset - currentEnd;
    // If data is >2MB away, it's cheaper to restart than wait for sequential fill
    const GAP_RESTART_THRESHOLD = 2 * 1024 * 1024;
    const isCoveredByStream =
      this.atomicIsStreaming() &&
      offset >= streamStart &&
      offset < streamStart + this.bufferSize &&
      gap <= GAP_RESTART_THRESHOLD;

    Logger.debug(TAG, `Read: isCoveredByStream=${isCoveredByStream}, gap=${(gap / 1024).toFixed(0)}KB`);

    if (isCoveredByStream) {
      Logger.debug(TAG, `Read: waiting for data from active stream...`);
      const success = await this.waitForData(offset, length);
      Logger.debug(TAG, `Read: waitForData returned ${success}`);
      if (success) {
        // Reset force restart counter on successful read
        this.consecutiveForceRestarts = 0;
        this.consecutiveOneOffFetches = 0;
        // Seek landed inside the active stream — nothing to reposition.
        this.seekHinted = false;
        return this.readFromBuffer(offset, length);
      }

      // If wait failed but stream is still theoretically active/valid,
      // it means we timed out. We could restart, or throw.
      // Retrying wait or restarting check is better than blindly clobbering.
      if (this.atomicIsStreaming()) {
        // Double check buffer - maybe it arrived just now?
        if (this.isInBuffer(offset, length))
          return this.readFromBuffer(offset, length);

        // Check if we're in a force restart loop
        const now = Date.now();
        const timeSinceLastRestart = now - this.lastForceRestartTime;

        // Reset counter if it's been more than 5 seconds since last restart
        if (timeSinceLastRestart > 5000) {
          this.consecutiveForceRestarts = 0;
        }

        if (this.consecutiveForceRestarts >= this.MAX_FORCE_RESTARTS) {
          Logger.error(
            TAG,
            `Too many consecutive force restarts (${this.consecutiveForceRestarts}), giving up.`,
          );
          throw new Error(
            `Stream failed after ${this.consecutiveForceRestarts} restart attempts`,
          );
        }

        // Exponential backoff before restarting: 100ms, 200ms, 400ms
        const backoffDelay = Math.min(100 * Math.pow(2, this.consecutiveForceRestarts), 500);
        Logger.warn(
          TAG,
          `Read timeout for ${offset} but stream is active. Force restarting after ${backoffDelay}ms (attempt ${this.consecutiveForceRestarts + 1}/${this.MAX_FORCE_RESTARTS}).`,
        );

        // Wait before restarting to avoid cascade
        await new Promise((r) => setTimeout(r, backoffDelay));

        this.consecutiveForceRestarts++;
        this.lastForceRestartTime = now;
      }
    }

    // A read outside the active stream window would otherwise force a stream
    // restart — which aborts the in-flight sequential fetch and re-downloads
    // from the new offset (users saw this as the main request being abruptly
    // "cancelled" mid-playback). For a SMALL out-of-window read (metadata /
    // Cues / index / a stray random packet) serve it with a one-off range
    // fetch instead and let the main stream keep running.
    //
    // The old gate also required the whole file to fit in the buffer, so large
    // streamed files (which never fit) restarted on every such read; dropping
    // that requirement is what fixes the abrupt cancel for big remote files.
    const ONEOFF_RANGE_MAX_BYTES = 15 * 1024 * 1024;
    if (
      !isCoveredByStream &&
      this.atomicIsStreaming() &&
      // A hinted seek landed outside the window — reposition the stream now
      // rather than serving the new region as one-off ranges while the old
      // stream keeps consuming the bandwidth we need here. …unless these reads
      // are the search FOR that seek: the hint is still set from the viewer's
      // request, so every probe repositioned the download to a place the
      // search was about to reject.
      (!this.seekHinted || this._probing) &&
      length <= ONEOFF_RANGE_MAX_BYTES &&
      (this._probing ||
        this.consecutiveOneOffFetches < this.MAX_ONEOFF_BEFORE_RESTART)
    ) {
      Logger.info(TAG, `Read: one-off range fetch for offset=${offset}, length=${length} (outside stream window, main stream continues)`);
      try {
        const rangeEnd =
          this.size > 0
            ? Math.min(offset + length - 1, this.size - 1)
            : offset + length - 1;
        const rangeLen = rangeEnd - offset + 1;
        const response = await fetch(this.url, {
          headers: await this.buildRequestHeaders({ offset, length: rangeLen }),
          signal: this.lifetimeAbort.signal,
        });
        if (response.status === 206 || response.ok) {
          // Guard against a server that ignores the Range header and streams
          // the whole file back: that huge body would be wrong to slot into a
          // small window. Bail (→ stream restart) rather than mis-writing it.
          const contentLength = response.headers.get("content-length");
          if (contentLength && parseInt(contentLength, 10) > rangeLen * 1.5) {
            throw new Error(
              `Server ignored Range (Content-Length ${contentLength} for a ${rangeLen}-byte request)`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          if (
            response.status !== 206 &&
            arrayBuffer.byteLength > rangeLen * 1.5
          ) {
            throw new Error(
              `Server ignored Range (returned ${arrayBuffer.byteLength} bytes for a ${rangeLen}-byte request)`,
            );
          }
          const data = new Uint8Array(arrayBuffer);

          // Cache into the buffer only when the offset maps inside the current
          // window (small / buffer-fitting files). For large streamed files the
          // offset falls outside the window, so we just serve the data directly.
          const buffer = this.getBuffer();
          const bufStart = this.atomicGetBufferStart();
          const localOffset = offset - bufStart;
          if (localOffset >= 0 && localOffset + data.length <= buffer.length) {
            buffer.set(data, localOffset);
          }

          // Serve the fetched data directly
          const result = new Uint8Array(data.length);
          result.set(data);
          this.position = offset + data.length;
          this.consecutiveForceRestarts = 0;
          // Count this one-off; a run of them (a real seek) trips the gate above
          // on the next read and restarts the stream at the new position.
          if (!this._probing) this.consecutiveOneOffFetches++;
          return result.buffer;
        }
      } catch (e) {
        Logger.warn(TAG, `One-off range fetch failed, falling back to stream restart`, e);
      }
    }

    // A URL that has already failed for good answers every read the same way.
    // Checked here as well as in startStream() so the one-off range path above
    // cannot spin on it either.
    if (this.fatalError) throw this.fatalError;

    // Need new stream (Seeked outside window, or stream dead)
    Logger.debug(TAG, `Read: starting new stream from ${offset}`);
    await this.startStream(offset);
    Logger.debug(TAG, `Read: waiting for data...`);
    let generation = this.streamGeneration;
    let success = await this.waitForData(offset, length);
    Logger.debug(TAG, `Read: waitForData returned ${success}`);
    // The stream we just opened never delivered a byte and is still "active":
    // its request is hung. Throwing here left that corpse marked as streaming,
    // so the retried read saw it as covering the offset and waited on it all
    // over again before restarting. Replace it now, once — unless another read
    // already replaced it, or the source was torn down meanwhile.
    if (
      !success &&
      !this.closed &&
      !this.fatalError &&
      generation === this.streamGeneration &&
      this.atomicIsStreaming() &&
      this.atomicGetWritePos() === 0
    ) {
      Logger.warn(TAG, `Stream at ${offset} delivered nothing — reopening it`);
      await this.startStream(offset);
      generation = this.streamGeneration;
      success = await this.waitForData(offset, length);
    }
    if (!success) {
      // Still hung: stop it so the caller's retry opens a fresh request
      // instead of waiting on this one.
      if (
        generation === this.streamGeneration &&
        this.atomicIsStreaming() &&
        this.atomicGetWritePos() === 0
      ) {
        await this.stopStream();
      }
      throw new Error(`Timeout at ${offset}`);
    }

    // Reset force restart counter on successful read
    this.consecutiveForceRestarts = 0;
    // The stream is now repositioned at this offset, so the one-off streak is
    // spent — subsequent sequential reads are covered by the fresh stream.
    this.consecutiveOneOffFetches = 0;
    this.seekHinted = false;

    // Don't update maxBufferedEnd on reads - it's updated when streaming writes to buffer
    return this.readFromBuffer(offset, length);
  }

  private readFromBuffer(offset: number, length: number): ArrayBuffer {
    const buffer = this.getBuffer();
    const bufferStart = this.atomicGetBufferStart();
    const localOffset = offset - bufferStart;
    const available = Math.min(length, this.bufferEnd - offset);

    // Never hand the demuxer a SHORT buffer for a read that isn't a genuine EOF
    // tail. If the streaming window stopped at a 40MB-chunk boundary (or slid)
    // just before the last bytes of this range landed, returning the partial
    // slice makes the WASM demuxer parse a truncated packet and trap with
    // RuntimeError: Aborted() — surfaced to the user as "corrupt data stream".
    // Throw a retriable I/O error instead: the read loop restarts the stream and
    // retries, and the demuxer treats it as a normal read failure (no crash). A
    // real EOF tail (starts INSIDE the file but runs past its end) still returns
    // short. A read that *starts* at/after the file end (offset >= size) is not a
    // tail — it's an out-of-range read (e.g. a rendition swap left a byte cursor
    // sized for the previous, larger file); treat it as incomplete so it throws
    // rather than slicing a negative-length array or feeding garbage to the WASM.
    const isEofTail =
      this.size > 0 && offset < this.size && offset + length > this.size;
    if ((available < length || localOffset < 0) && !isEofTail) {
      throw new Error(
        `Incomplete read at ${offset}: ${Math.max(0, available)}/${length} bytes buffered`,
      );
    }

    const result = new Uint8Array(available);
    result.set(buffer.subarray(localOffset, localOffset + available));

    this.position = offset + available;
    if (this.position > this.readMax) this.readMax = this.position;
    // Track recent read offsets so the linear window knows the lowest byte any
    // stream still needs (see slideWindow). Bounded ring — ~64 reads ≈ 32MB of
    // activity, plenty to span the streams + a transient rewind.
    this.recentReads.push(offset);
    if (this.recentReads.length > 64) this.recentReads.shift();
    return result.buffer;
  }

  seek(offset: number): number {
    this.position = offset;
    return this.position;
  }

  getPosition(): number {
    return this.position;
  }

  /**
   * Get the shared buffer for zero-copy access from workers
   */
  getSharedBuffer(): SharedArrayBuffer | null {
    return this.sharedBuffer;
  }

  close(): void {
    this.closed = true;
    this.stopStream();
    // Kill anything still in flight (ranged reads, a size probe), not just the
    // sequential stream — otherwise they keep downloading after teardown.
    this.lifetimeAbort.abort();
    // Anything parked waiting for bytes has to be let go, or it sits on a
    // stream that will never write again until its own deadline expires.
    this.wakeBufferWaiters(true);
    Logger.debug(TAG, "Source closed");
  }

  /** True once close() has run. Reads stop trying to recover after that: their
   *  data is not coming, and restarting a stream on a torn-down source only
   *  produces failures that look like the link breaking. */
  private closed = false;

  getKey(): string {
    return this.url;
  }

  getUrl(): string {
    return this.url;
  }

  /**
   * Returns true when the entire file has been downloaded and is cached in the buffer.
   * In this state, all seek/replay operations are served from memory (zero network).
   */
  isFullyCached(): boolean {
    return this.fullyBuffered;
  }

  /**
   * The file size if it is already known, -1 before it has been resolved.
   *
   * getSize() is the way to ASK for it (it will go and fetch it); this is for
   * callers on a synchronous path — a UI tick reading the buffered range — that
   * want the answer only if it is already in hand.
   */
  getKnownSize(): number {
    return this.size;
  }

  /**
   * Get the current buffered end position in bytes
   * This represents the furthest byte that has been buffered
   * Uses the maximum of current buffer window and historical max position,
   * but caps it to not exceed what's actually available
   */
  /**
   * The first byte the streaming window currently holds.
   *
   * The window slides, so "the end is EOF" does NOT mean the file is
   * downloaded — a container whose index lives at the tail (Matroska cues, a
   * trailing MP4 moov) sends the window there during open, and for that moment
   * the window ends at the last byte of a 3.6GB file it has read 4MB of.
   * Callers that want "everything from here to the end is in hand" have to ask
   * where the window STARTS as well.
   */
  /**
   * The failure this source will not come back from, if there has been one.
   *
   * Asked at EOF. The demuxer reads through a C callback that can only answer
   * with a byte count, so a read that FAILED and a read that reached the end of
   * the file arrive as the same thing: no bytes. FFmpeg calls that EOF, the
   * packet loop ends the video, and a source that had been refused mid-file
   * looked exactly like a file that had finished — the picture stopped, the
   * clock jumped to the duration, and anything watching for "ended" (an
   * autoplay-next, a playlist) moved on as though nothing had gone wrong.
   */
  getFatalError(): Error | null {
    return this.fatalError;
  }

  getBufferedStart(): number {
    if (this.fullyBuffered) return 0;
    return this.atomicGetBufferStart();
  }

  getBufferedEnd(): number {
    // Entire file is in memory — report full size
    if (this.fullyBuffered && this.size > 0) return this.size;

    const currentBufferEnd = this.bufferEnd;
    const bufferStart = this.atomicGetBufferStart();

    // Reading inside the head cache. Those bytes are buffered — they are just
    // not in the STREAMING window, which is still at zero because nothing has
    // been fetched yet. Without this the clamp below returns `position`, so
    // forward = end - position = 0, and callers conclude nothing is buffered:
    // the freeze watchdog took a healthy 1080p down to 720p on that reading
    // ("ABR emergency downshift (starved 0.0s at 5.0s)") while every read was
    // being served from this very cache.
    //
    // The head cache is now filled from the download itself, not just from a
    // pre-play probe, so it exists on ordinary playback too — and the window
    // is then usually somewhere else entirely. Only count the window on top of
    // the head when the two actually meet; a window that starts past the head
    // is a separate island, and reporting across the gap is the phantom
    // "already buffered ahead" the clamp below exists to prevent.
    const headEnd = this.headFilled;
    if (headEnd > this.position) {
      const end =
        bufferStart <= headEnd ? Math.max(headEnd, currentBufferEnd) : headEnd;
      return this.size > 0 ? Math.min(end, this.size) : end;
    }

    // If the current read position is outside the buffer window, the buffer
    // doesn't cover us — there is nothing forward-buffered at the new spot
    // yet. Report position itself so "forward = bufferedEnd - position = 0".
    // This collapses a transient seek race: source.seek() updates position
    // synchronously, but startStream() (which resets window atomics) runs
    // async on the next read. Without this clamp, callers briefly see a
    // stale bufferedEnd against a new position and compute a huge forward
    // delta, producing a phantom "scan" sweep on the seek bar.
    if (this.position < bufferStart || this.position > currentBufferEnd) {
      return this.position;
    }

    // The current buffer end is the most reliable indicator of what's actually buffered
    // Only use maxBufferedEnd if it's within the current buffer window or close to it
    // (within 2x buffer size, meaning we might have read ahead but the window hasn't caught up)
    const maxReasonable = bufferStart + this.bufferSize * 2;

    // Use maxBufferedEnd only if it's reasonable and not too far ahead
    let result = currentBufferEnd;
    if (
      this.maxBufferedEnd > currentBufferEnd &&
      this.maxBufferedEnd <= maxReasonable
    ) {
      result = this.maxBufferedEnd;
    }

    // Never exceed file size
    if (this.size > 0 && result > this.size) {
      return this.size;
    }

    return result;
  }

  /**
   * Get the current buffer start position in bytes
   */
  getBufferStart(): number {
    return this.atomicGetBufferStart();
  }

  /**
   * Get network stats for nerd stats overlay
   */
  getNetworkStats(): {
    totalBytes: number;
    currentSpeed: number;
    lastSpeed: number;
    elapsed: number;
  } {
    const timeSinceLastRead = this.lastSpeedTime > 0 ? (Date.now() - this.lastSpeedTime) / 1000 : 0;
    const speed = timeSinceLastRead > 1 ? 0 : this.currentSpeed;
    return {
      totalBytes: this.totalBytesDownloaded,
      currentSpeed: speed, // 0 when idle — UI graph / stats
      lastSpeed: this.lastSpeed, // last measured rate, persists when idle — ABR
      elapsed: this.streamStartTime > 0 ? (Date.now() - this.streamStartTime) / 1000 : 0,
    };
  }
}

export async function createHttpSource(
  url: string,
  headers?: Record<string, string>,
  maxBufferSizeMB?: number,
): Promise<HttpSource> {
  const source = new HttpSource(url, headers, maxBufferSizeMB);
  // Size will be fetched lazily when needed (in bindings.open())
  return source;
}
