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

export class HttpSource implements SourceAdapter {
  private url: string;
  private headers: Record<string, string>;
  private size: number = -1;
  private position: number = 0;
  private _contentDispositionFilename: string | null = null;

  // Persistent Cache
  private headBuffer: Uint8Array | null = null;

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

  // Stream state
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  private streamError: Error | null = null; // Store fatal errors from background stream

  // Track maximum buffered position (independent of sliding window)
  private maxBufferedEnd: number = 0;

  // True when the entire file fits in the buffer and has been fully downloaded.
  // In this state, all reads can be served from memory — no re-fetching needed.
  private fullyBuffered: boolean = false;

  // Force restart tracking (to prevent cascading failures)
  private consecutiveForceRestarts: number = 0;
  private lastForceRestartTime: number = 0;
  private readonly MAX_FORCE_RESTARTS = 3; // Max consecutive force restarts before giving up

  // Dynamic buffer size (3% of file size, clamped)
  // Start with minimum size, will be resized when file size is known
  private bufferSize: number = MIN_BUFFER_SIZE;

  // Network stats tracking
  private totalBytesDownloaded: number = 0;
  private streamStartTime: number = 0;
  private lastSpeedBytes: number = 0;
  private lastSpeedTime: number = 0;
  private currentSpeed: number = 0; // bytes per second

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

  private atomicIsStreaming(): boolean {
    if (this.useSharedBuffer && this.headerView) {
      return Atomics.load(this.headerView, HEADER.STREAM_ACTIVE) === 1;
    }
    return this.reader !== null;
  }

  private atomicSetStreaming(active: boolean): void {
    if (this.useSharedBuffer && this.headerView) {
      Atomics.store(this.headerView, HEADER.STREAM_ACTIVE, active ? 1 : 0);
    }
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
    const response = await fetch(this.url, {
      method: "HEAD",
      headers: await this.buildRequestHeaders(),
    });

    if (!response.ok) {
      if (response.status === 403) throw new Error("Access denied. Check video permissions.");
      if (response.status === 401) throw new Error("Authentication required.");
      if (response.status === 404) throw new Error("Video not found.");
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = response.headers.get("Content-Length");
    if (!contentLength) throw new Error("Content-Length missing");

    // Extract filename from Content-Disposition header (e.g., "attachment; filename=\"video.mp4\"")
    const disposition = response.headers.get("Content-Disposition");
    if (disposition) {
      // Try filename*= (RFC 5987 encoded) first, then filename=
      let filenameMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\s]+)/i);
      if (filenameMatch) {
        try {
          this._contentDispositionFilename = decodeURIComponent(filenameMatch[1]);
        } catch { /* ignore decode error */ }
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

    return parseInt(contentLength, 10);
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
    range?: { offset: number; length: number },
  ): Promise<Record<string, string>> {
    if (range) {
      return {
        ...this.headers,
        Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
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
    if (offset < 0 || offset + length > this.headBuffer.length) return null;
    const out = new Uint8Array(length);
    out.set(this.headBuffer.subarray(offset, offset + length));
    return out;
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
    let streamBaseOffset = startOffset;

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
        const maxDownload = fileCanFit
          ? this.size  // Full file — no limit needed
          : Math.floor(Math.min(MAX_STREAM_BUFFER_SIZE, this.bufferSize * 0.9));
        const rangeEnd = this.size > 0
          ? Math.min(resumeOffset + maxDownload - 1, this.size - 1)
          : resumeOffset + maxDownload - 1;

        // Fetch with bounded range
        Logger.debug(TAG, `Fetching range: ${resumeOffset}-${rangeEnd} (max ${(maxDownload / 1024 / 1024).toFixed(1)}MB)`);
        const response = await fetch(this.url, {
          headers: await this.buildRequestHeaders({
            offset: resumeOffset,
            length: rangeEnd - resumeOffset + 1,
          }),
          cache: 'no-store', // Prevent cached 200 responses
          signal: this.abortController!.signal,
        });

        // Check for 206 Partial Content response
        // If server returns 200, it may be a CDN cache warming issue (e.g. Cloudflare first hit)
        // Retry a few times before treating as fatal — CDN often supports range after caching the file
        if (response.status === 200) {
          // Abort the 200 response body to prevent downloading entire file
          try { response.body?.cancel(); } catch {}

          rangeRetryCount++;
          if (rangeRetryCount <= MAX_RANGE_RETRIES) {
            Logger.warn(
              TAG,
              `Server returned 200 instead of 206 (attempt ${rangeRetryCount}/${MAX_RANGE_RETRIES}). ` +
              `CDN may be caching — retrying in ${RANGE_RETRY_DELAY}ms...`
            );
            await new Promise(r => setTimeout(r, RANGE_RETRY_DELAY));
            continue; // Retry the fetch loop
          }

          // Exhausted retries — fatal
          const rangeError = new Error("Server does not support range requests.");
          Logger.error(TAG, `Server returned 200 after ${MAX_RANGE_RETRIES} retries. Range requests not supported.`);
          this.abortController?.abort();
          this.atomicSetStreaming(false);
          this.streamError = rangeError;
          throw rangeError;
        }

        // Reset range retry counter on successful 206
        rangeRetryCount = 0;

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

        // Initialize network stats timing
        if (this.streamStartTime === 0) {
          this.streamStartTime = startTime;
          this.lastSpeedTime = startTime;
        }

        // Read Loop
        while (this.atomicIsStreaming()) {
          const { done, value } = await this.reader.read();
          if (done) {
            this.atomicSetStreaming(false);
            break;
          }

          if (value) {
            downloadedBytes += value.length;

            // Track global network stats
            this.totalBytesDownloaded += value.length;
            const now = Date.now();
            const speedElapsed = (now - this.lastSpeedTime) / 1000;
            if (speedElapsed >= 0.5) {
              const bytesSinceLast = this.totalBytesDownloaded - this.lastSpeedBytes;
              this.currentSpeed = bytesSinceLast / speedElapsed;
              this.lastSpeedBytes = this.totalBytesDownloaded;
              this.lastSpeedTime = now;
            }

            if (downloadedBytes - lastLogBytes > 1024 * 1024) {
              // Log every 1MB
              const elapsed = (Date.now() - startTime) / 1000;
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
      if (timeSinceProgress > PROGRESS_TIMEOUT) {
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

      if (this.useSharedBuffer && this.headerView) {
        await new Promise((r) => setTimeout(r, 2));
      } else {
        await new Promise((r) => setTimeout(r, 10));
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
    if (this.headBuffer && offset + length <= this.headBuffer.length) {
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

      Logger.debug(TAG, `Read: serving from buffer`);
      return this.readFromBuffer(offset, length);
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

    // If the main stream is actively filling a full-file-cache buffer,
    // do a one-off range fetch instead of restarting the stream (which would
    // discard all already-downloaded data and start over from the new offset).
    // This handles WebM/MKV Cues reads from the end of file during open().
    const fileCanFitInBuffer = this.size > 0 && this.bufferSize >= this.size;
    if (fileCanFitInBuffer && this.atomicIsStreaming() && gap > GAP_RESTART_THRESHOLD) {
      Logger.info(TAG, `Read: one-off range fetch for offset=${offset}, length=${length} (gap=${(gap / 1024).toFixed(0)}KB, main stream continues)`);
      try {
        const rangeEnd = Math.min(offset + length - 1, this.size - 1);
        const rangeLen = rangeEnd - offset + 1;
        const response = await fetch(this.url, {
          headers: await this.buildRequestHeaders({ offset, length: rangeLen }),
        });
        if (response.ok || response.status === 206) {
          const arrayBuffer = await response.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);

          // Write the fetched data into the buffer at the correct position
          // (the buffer is sized for the full file, so the offset maps directly)
          const buffer = this.getBuffer();
          const bufStart = this.atomicGetBufferStart();
          const localOffset = offset - bufStart;
          if (localOffset >= 0 && localOffset + data.length <= buffer.length) {
            buffer.set(data, localOffset);
            // Extend writePos if this fetch goes beyond current end
            const newEnd = localOffset + data.length;
            if (newEnd > this.atomicGetWritePos()) {
              // Don't extend writePos — the main stream owns it sequentially.
              // Instead, just serve the data directly.
            }
          }

          // Serve the fetched data directly
          const result = new Uint8Array(data.length);
          result.set(data);
          this.position = offset + data.length;
          this.consecutiveForceRestarts = 0;
          return result.buffer;
        }
      } catch (e) {
        Logger.warn(TAG, `One-off range fetch failed, falling back to stream restart`, e);
      }
    }

    // Need new stream (Seeked outside window, or stream dead)
    Logger.debug(TAG, `Read: starting new stream from ${offset}`);
    await this.startStream(offset);
    Logger.debug(TAG, `Read: waiting for data...`);
    const success = await this.waitForData(offset, length);
    Logger.debug(TAG, `Read: waitForData returned ${success}`);
    if (!success) throw new Error(`Timeout at ${offset}`);

    // Reset force restart counter on successful read
    this.consecutiveForceRestarts = 0;

    // Don't update maxBufferedEnd on reads - it's updated when streaming writes to buffer
    return this.readFromBuffer(offset, length);
  }

  private readFromBuffer(offset: number, length: number): ArrayBuffer {
    const buffer = this.getBuffer();
    const bufferStart = this.atomicGetBufferStart();
    const localOffset = offset - bufferStart;
    const available = Math.min(length, this.bufferEnd - offset);

    const result = new Uint8Array(available);
    result.set(buffer.subarray(localOffset, localOffset + available));

    this.position = offset + available;
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
    this.stopStream();
    Logger.debug(TAG, "Source closed");
  }

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
   * Get the current buffered end position in bytes
   * This represents the furthest byte that has been buffered
   * Uses the maximum of current buffer window and historical max position,
   * but caps it to not exceed what's actually available
   */
  getBufferedEnd(): number {
    // Entire file is in memory — report full size
    if (this.fullyBuffered && this.size > 0) return this.size;

    const currentBufferEnd = this.bufferEnd;
    const bufferStart = this.atomicGetBufferStart();

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
  getNetworkStats(): { totalBytes: number; currentSpeed: number; elapsed: number } {
    const timeSinceLastRead = this.lastSpeedTime > 0 ? (Date.now() - this.lastSpeedTime) / 1000 : 0;
    const speed = timeSinceLastRead > 1 ? 0 : this.currentSpeed;
    return {
      totalBytes: this.totalBytesDownloaded,
      currentSpeed: speed,
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
