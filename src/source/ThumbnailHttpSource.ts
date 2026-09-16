/**
 * ThumbnailHttpSource - Buffered HTTP source for thumbnail extraction.
 *
 * Uses a simple sliding buffer to cache data and reduce HTTP requests.
 * Each seek position triggers a larger chunk fetch, and subsequent reads
 * are served from the buffer until a new seek is needed.
 */

import type { SourceAdapter } from "./SourceAdapter";
import { Logger } from "../utils/Logger";
import { childAbort } from "../utils/abort";

const TAG = "ThumbnailHttpSource";

// Buffer 2MB at a time. A single 4K HDR keyframe can run 1-2MB, and the
// demuxer also issues several scattered index/keyframe reads around the
// target before it hands us the packet. At 512KB each of those reads missed
// the buffer and paid its own HTTP round-trip — a single far-position hover
// fired ~8 sequential fetches (the ~4s vs <2s gap against a real seek).
// 2MB lets one fetch cover the keyframe plus its neighbouring reads.
const BUFFER_SIZE = 2 * 1024 * 1024;
// Maximum fetch size to prevent excessive downloads (5MB cap)
const MAX_FETCH_SIZE = 5 * 1024 * 1024;

/**
 * Minimal interface describing a source we can peek into without mutating.
 * HttpSource implements this structurally via peekMetadata() / peekRange().
 */
export interface PeekableSource {
  peekMetadata(offset: number, length: number): Uint8Array | null;
  peekRange(offset: number, length: number): Uint8Array | null;
  /** Opening bytes the main source held on to. Optional: not every peekable
   *  source keeps a head cache. */
  peekHead?(offset: number, length: number): Uint8Array | null;
}

export class ThumbnailHttpSource implements SourceAdapter {
  private url: string;
  private headers: Record<string, string>;
  private size: number = -1;
  private position: number = 0;
  private abortController: AbortController | null = null;
  /**
   * This source's own lifetime, aborted by close().
   *
   * `abortController` above only ever covered one path; the size probes and the
   * ranged read each built their own local controller (the read's on a 10s
   * timer), which close() could not see. So tearing the preview pipeline down
   * mid-hover left a range request downloading to its own deadline.
   */
  private readonly lifetimeAbort = new AbortController();
  // Set once a fetch comes back 200 (server ignores Range). From then on we
  // never hit the network — thumbnails are served purely by borrowing bytes
  // the main source already has in its RAM window; a borrow miss just yields
  // no preview rather than a doomed (and spammy) range fetch.
  private rangeUnsupported: boolean = false;

  // Simple buffer cache
  private buffer: Uint8Array | null = null;
  private bufferStart: number = 0;
  private bufferEnd: number = 0;

  /**
   * The end of the window currently STREAMING IN, and the machinery to wait on
   * it. `bufferEnd` is how far the bytes have actually got; `fillEnd` is where
   * they are going. While the two differ, a fetch is still arriving.
   *
   * A read used to wait for the whole 2MB window before it saw a single byte,
   * and the demuxer asks for 32KB. Measured on a 404MB AV1 MKV over R2: one
   * hover = one 32KB read, served by a 2048KB download the preview blocked on
   * for 7.0s, of which the first byte arrived after 0.33s. The window is the
   * right size — it is what keeps a hover to ONE request — but nothing about
   * it requires the answer to wait for its tail.
   */
  private fillEnd: number = 0;
  private fillToken: number = 0;
  private fillWaiters: Array<() => void> = [];

  /** Wake everything waiting on the stream to reach further. */
  private notifyFill(): void {
    const waiters = this.fillWaiters;
    this.fillWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Abandon whatever is streaming in: the bytes it is carrying are no longer
   * wanted, or the buffer they were going into has gone.
   */
  private invalidateFill(): void {
    this.fillToken++;
    this.fillEnd = 0;
    this.notifyFill();
  }

  /**
   * Wait until the in-flight window has reached `target`, or has stopped
   * short of it. True when the bytes are there.
   */
  private async awaitFilled(target: number, token: number): Promise<boolean> {
    while (
      this.fillToken === token &&
      this.bufferEnd < target &&
      this.fillEnd > this.bufferEnd
    ) {
      await new Promise<void>((resolve) => this.fillWaiters.push(resolve));
    }
    return this.fillToken === token && this.bufferEnd >= target;
  }

  // Optional main source to borrow already-buffered bytes from.
  // Used to avoid re-fetching data the main playback stream has cached
  // — particularly hot for seekbar hover previews near current playback.
  private borrowSource: PeekableSource | null = null;

  constructor(
    url: string,
    headers: Record<string, string> = {},
    borrowSource: PeekableSource | null = null,
  ) {
    this.url = url;
    this.headers = headers;
    this.borrowSource = borrowSource;
  }

  setBorrowSource(source: PeekableSource | null): void {
    this.borrowSource = source;
  }

  /**
   * Seed the file size from the main source so getSize() skips its own HEAD /
   * ranged-GET probe. Essential for non-range servers where that probe can't
   * recover a size (Cloudflare strips Content-Length on HEAD and may chunk the
   * 200 GET) — the main source already knows the size, so just reuse it.
   */
  seedSize(size: number): void {
    if (size > 0) this.size = size;
  }

  async getSize(): Promise<number> {
    if (this.size >= 0) return this.size;

    const response = await fetch(this.url, {
      method: "HEAD",
      headers: this.headers,
      signal: this.lifetimeAbort.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentLength = response.headers.get("Content-Length");
    if (contentLength) {
      this.size = parseInt(contentLength, 10);
    } else {
      // Cloudflare (and some CDNs) strip Content-Length from null-body HEAD
      // responses — recover the total from a 1-byte ranged GET's Content-Range.
      // Mirrors HttpSource.resolveSizeViaRange.
      const viaRange = await this.resolveSizeViaRange();
      if (viaRange === null) throw new Error("Content-Length missing");
      this.size = viaRange;
    }
    Logger.debug(TAG, `File size: ${this.size} bytes`);

    return this.size;
  }

  /**
   * Recover total size from a 1-byte ranged GET when HEAD lacks Content-Length.
   * Body is cancelled immediately — we only need the Content-Range header.
   */
  private async resolveSizeViaRange(): Promise<number | null> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "GET",
        headers: { ...this.headers, Range: "bytes=0-0" },
        signal: this.lifetimeAbort.signal,
      });
    } catch {
      return null;
    }
    res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 206) return null;

    const contentRange = res.headers.get("Content-Range");
    if (contentRange) {
      const m = /\/\s*(\d+)\s*$/.exec(contentRange);
      if (m) return parseInt(m[1], 10);
    }
    const cl = res.headers.get("Content-Length");
    if (res.status === 200 && cl) return parseInt(cl, 10);
    return null;
  }

  /**
   * Check if requested data is in buffer
   */
  private isInBuffer(offset: number, length: number): boolean {
    return (
      this.buffer !== null &&
      offset >= this.bufferStart &&
      offset + length <= this.bufferEnd
    );
  }

  /**
   * Read data - uses buffer cache to minimize HTTP requests
   */
  async read(offset: number, length: number): Promise<ArrayBuffer> {
    // Clamp to file size if known
    if (this.size > 0 && offset >= this.size) {
      return new ArrayBuffer(0);
    }

    // FFmpeg over-reads at the end of the file — it asks for a full block and
    // takes whatever comes back. Asking the caches for bytes that do not exist
    // is a guaranteed miss, and the miss is expensive: the MKV Cues sit in the
    // last 2.5KB, the main source has them cached from its own open, and a
    // 512KB request for them borrowed nothing and paid a round trip on every
    // first hover. Ask for what the file can actually give.
    if (this.size > 0) length = Math.min(length, this.size - offset);
    if (length <= 0) return new ArrayBuffer(0);

    // Serve from buffer if available
    if (this.isInBuffer(offset, length)) {
      const localOffset = offset - this.bufferStart;
      const result = new Uint8Array(length);
      result.set(this.buffer!.subarray(localOffset, localOffset + length));
      this.position = offset + length;
      Logger.debug(TAG, `Read from buffer: offset=${offset}, length=${length}`);
      return result.buffer;
    }

    // Not here yet, but on its way: a window is streaming in and these bytes
    // are inside it. Wait for the stream to reach them rather than opening a
    // second request for bytes the first one is already carrying — which is
    // what the demuxer's follow-up reads would otherwise do, each of them
    // throwing away the download still in progress.
    if (
      this.buffer !== null &&
      this.fillEnd > this.bufferEnd &&
      offset >= this.bufferStart &&
      offset + length <= this.fillEnd
    ) {
      const token = this.fillToken;
      if (await this.awaitFilled(offset + length, token)) {
        const localOffset = offset - this.bufferStart;
        const result = new Uint8Array(length);
        result.set(this.buffer!.subarray(localOffset, localOffset + length));
        this.position = offset + length;
        Logger.debug(
          TAG,
          `Read from the window still arriving: offset=${offset}, length=${length}`,
        );
        return result.buffer;
      }
    }

    // Try borrowing from main source's buffers before paying for a new fetch.
    // Metadata LRU covers moov/ftyp/Cues reads the main player has already
    // served (format-agnostic); sliding window covers keyframe bytes near
    // current playback (seekbar hover previews).
    if (this.borrowSource) {
      // The head first: a fresh demuxer open starts by probing offset 0, and
      // that is the one region the main source's sliding window never keeps
      // (its first stream restarts elsewhere for a metadata read and comes
      // back a few hundred bytes in). The head cache is what survives it.
      const head = this.borrowSource.peekHead?.(offset, length);
      if (head) {
        this.position = offset + length;
        Logger.debug(TAG, `Read borrowed from main head cache: offset=${offset}, length=${length}`);
        return head.buffer as ArrayBuffer;
      }
      const meta = this.borrowSource.peekMetadata(offset, length);
      if (meta) {
        this.position = offset + length;
        Logger.debug(TAG, `Read borrowed from metadata LRU: offset=${offset}, length=${length}`);
        // peek methods always return fresh Uint8Array backed by ArrayBuffer
        return meta.buffer as ArrayBuffer;
      }
      const hit = this.borrowSource.peekRange(offset, length);
      if (hit) {
        this.position = offset + length;
        Logger.debug(TAG, `Read borrowed from main window: offset=${offset}, length=${length}`);
        return hit.buffer as ArrayBuffer;
      }
    }

    // Non-range source: the borrow missed and the server can't serve a range,
    // so there's nothing to fetch. Yield empty — the requested frame just isn't
    // in the buffered window, so no preview is shown there.
    if (this.rangeUnsupported) {
      return new ArrayBuffer(0);
    }

    // Need to fetch - calculate optimal range
    // Fetch a larger chunk to avoid multiple small requests, but cap at MAX_FETCH_SIZE
    const fetchStart = offset;
    const fetchSize = Math.min(
      Math.max(BUFFER_SIZE, length),
      MAX_FETCH_SIZE // Cap to prevent excessive downloads
    );
    const fetchEnd =
      this.size > 0
        ? Math.min(fetchStart + fetchSize - 1, this.size - 1)
        : fetchStart + fetchSize - 1;

    Logger.debug(
      TAG,
      `Fetching: range=${fetchStart}-${fetchEnd} (${((fetchEnd - fetchStart + 1) / 1024).toFixed(1)} KB)`,
    );

    // Retry loop
    const MAX_RETRIES = 5;
    const BASE_DELAY = 1000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Check for offline state
      if (
        typeof self !== "undefined" &&
        self.navigator &&
        !self.navigator.onLine
      ) {
        Logger.warn(TAG, "Network offline, waiting for connection...");
        await new Promise<void>((resolve) => {
          const onOnline = () => {
            self.removeEventListener("online", onOnline);
            resolve();
          };
          self.addEventListener("online", onOnline);
        });
        Logger.info(TAG, "Network online, resuming...");
        attempt = 0; // Reset retries
      }

      // Its own 10s cap AND close(): a preview range is megabytes, and the
      // pipeline it belongs to is torn down on every source change.
      const controller = childAbort(this.lifetimeAbort.signal);
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      try {
        const response = await fetch(this.url, {
          headers: {
            ...this.headers,
            Range: `bytes=${fetchStart}-${fetchEnd}`,
          },
          cache: 'no-store', // Prevent cached 200 responses
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // If the server returns 200 instead of 206 it's ignoring Range and
        // would stream the whole file. Latch range-unsupported and fall back to
        // borrow-only: abort this download and yield empty (no preview here).
        // No retries — they'd all come back 200 too (the old behavior spammed
        // 5 failed fetches per hover).
        if (response.status === 200) {
          Logger.info(
            TAG,
            "Server returned 200 (no Range support) — thumbnails switch to borrow-only.",
          );
          controller.abort();
          this.rangeUnsupported = true;
          return new ArrayBuffer(0);
        }

        if (!response.ok && response.status !== 206) {
          if (response.status === 416) {
            Logger.warn(
              TAG,
              `HTTP 416 (Range Not Satisfiable) at ${fetchStart}-${fetchEnd}. Treating as EOF.`,
            );
            return new ArrayBuffer(0);
          } else if (response.status >= 500 || response.status === 429) {
            // Retry server errors
            throw new Error(`HTTP ${response.status}`);
          } else {
            // Fatal client error
            throw new Error(`HTTP ${response.status} (Fatal)`);
          }
        }

        // Take the window as a stream and answer THIS read the moment its own
        // bytes have landed; the rest of the window keeps filling behind it.
        //
        // The window is 2MB because that is what keeps a hover to one request
        // (see BUFFER_SIZE). The read that triggered it is 32KB. Waiting for
        // the whole window meant the picture appeared after the last byte
        // rather than the 32,768th: 7.0s instead of 0.4s on a 404MB AV1 MKV
        // over a link whose first byte came back in 0.33s. Both goals are
        // available at once — one request, and an answer as soon as it is
        // answerable — because nothing about a big window requires waiting for
        // its tail.
        const body = response.body;
        const windowLength = fetchEnd - fetchStart + 1;

        if (!body) {
          // No streaming body (an old browser, or a mocked response): the
          // whole-block read is still correct, just slower.
          const arrayBuffer = await response.arrayBuffer();
          this.invalidateFill();
          this.buffer = new Uint8Array(arrayBuffer);
          this.bufferStart = fetchStart;
          this.bufferEnd = fetchStart + arrayBuffer.byteLength;
          const wholeLength = Math.min(length, arrayBuffer.byteLength);
          const whole = new Uint8Array(wholeLength);
          whole.set(this.buffer.subarray(0, wholeLength));
          this.position = offset + wholeLength;
          return whole.buffer;
        }

        // Anything already streaming is superseded by this window.
        this.invalidateFill();
        const token = ++this.fillToken;
        this.buffer = new Uint8Array(windowLength);
        this.bufferStart = fetchStart;
        this.bufferEnd = fetchStart;
        this.fillEnd = fetchStart + windowLength;

        // What this read needs before it can return.
        const needed = fetchStart + Math.min(length, windowLength);
        const reader = body.getReader();
        let filled = 0;
        let streamError: unknown = null;
        // Held in an object: a bare `let` assigned inside the executor gets
        // narrowed to null by the compiler, which then refuses the call below.
        const needGate: { release: (() => void) | null } = { release: null };
        const needMet = new Promise<void>((resolve) => {
          needGate.release = resolve;
        });

        // Deliberately not awaited: it outlives this read, filling the rest of
        // the window so the demuxer's next reads are already served.
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              // Superseded (a new window, clearBuffer(), close()). Stop, and
              // let the connection go with it.
              if (this.fillToken !== token) {
                try {
                  await reader.cancel();
                } catch {
                  /* already gone */
                }
                return;
              }
              if (done) break;
              const take = Math.min(windowLength - filled, value.length);
              if (take > 0) {
                this.buffer!.set(value.subarray(0, take), filled);
                filled += take;
                this.bufferEnd = fetchStart + filled;
                this.notifyFill();
                if (needGate.release && this.bufferEnd >= needed) {
                  needGate.release();
                  needGate.release = null;
                }
              }
              if (filled >= windowLength) break;
            }
          } catch (e) {
            streamError = e;
          } finally {
            if (this.fillToken === token) {
              // Nothing more is coming — unblock anyone waiting for bytes past
              // where the stream actually stopped.
              this.fillEnd = this.bufferEnd;
              this.notifyFill();
            }
            needGate.release?.();
            needGate.release = null;
          }
        })();

        await needMet;

        // A stream that died before delivering anything is a failed read, and
        // the retry loop below is where that belongs.
        if (streamError && this.bufferEnd <= fetchStart) throw streamError;

        Logger.debug(
          TAG,
          `Window ${this.bufferStart}-${this.fillEnd} streaming; served ${(
            (this.bufferEnd - fetchStart) / 1024
          ).toFixed(1)} KB of it`,
        );

        // fetchStart === offset, so the read starts at the window's head.
        const resultLength = Math.max(
          0,
          Math.min(length, this.bufferEnd - offset),
        );
        const result = new Uint8Array(resultLength);
        result.set(this.buffer.subarray(0, resultLength));
        this.position = offset + resultLength;

        return result.buffer;
      } catch (error) {
        clearTimeout(timeoutId);

        if ((error as any).name === "AbortError") {
          Logger.debug(TAG, `Read aborted at offset ${offset}`);
          return new ArrayBuffer(0); // Cancelled
        }

        // Check for CORS errors (TypeError: Failed to fetch)
        // CORS errors are fatal and should not be retried
        const errorMessage = (error as any).message || "";
        const isCorsError =
          (error as any).name === "TypeError" &&
          errorMessage.includes("Failed to fetch");

        if (isCorsError) {
          Logger.error(TAG, `CORS error accessing ${this.url}`);
          throw new Error(
            "Failed to fetch video resource. Check your connection or CORS settings."
          );
        }

        // Check if fatal error
        if (
          (error as any).message &&
          (error as any).message.includes("(Fatal)")
        ) {
          throw error;
        }

        if (attempt === MAX_RETRIES) {
          Logger.error(
            TAG,
            `Max retries (${MAX_RETRIES}) reached for thumbnail fetch, giving up.`,
          );
          throw error;
        }

        Logger.warn(
          TAG,
          `Fetch error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`,
          error,
        );
        const delay = Math.min(BASE_DELAY * Math.pow(1.5, attempt), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return new ArrayBuffer(0); // Should not reach here
  }

  seek(offset: number): number {
    this.position = offset;
    return this.position;
  }

  getPosition(): number {
    return this.position;
  }

  /**
   * Stop the window that is still streaming in, keeping what has arrived.
   *
   * The window is 2MB so that the next hovers of a scrub land inside it, but
   * the frame that asked for it needed its first 32KB: measured at 12 Mbit,
   * the preview was on screen 0.17s into the request and the other 1.9MB kept
   * downloading for 1.3s after — four seconds of it on a 4 Mbit link — for a
   * pointer that had stopped moving. The bytes already here still serve any
   * read that falls inside them.
   */
  stopFill(): void {
    if (this.fillEnd <= this.bufferEnd) return;
    this.invalidateFill();
    Logger.debug(TAG, `Window stopped at ${this.bufferEnd} (was filling to its end)`);
  }

  /**
   * Clear buffer to free memory when thumbnails aren't being actively generated
   * Call this after thumbnail generation is complete
   */
  clearBuffer(): void {
    // Before the buffer goes: a window may still be streaming into it, and it
    // must not write into an array nobody is reading any more.
    this.invalidateFill();
    this.buffer = null;
    this.bufferStart = 0;
    this.bufferEnd = 0;
    Logger.debug(TAG, "Buffer cleared");
  }

  close(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // …and everything else in flight: the size probes and any ranged read.
    this.lifetimeAbort.abort();
    this.invalidateFill();
    this.buffer = null;
    Logger.debug(TAG, "Source closed");
  }

  getKey(): string {
    return `thumbnail:${this.url}`;
  }

  getUrl(): string {
    return this.url;
  }

  getBufferedEnd(): number {
    return this.bufferEnd;
  }

  getBufferStart(): number {
    return this.bufferStart;
  }
}

export async function createThumbnailHttpSource(
  url: string,
  headers?: Record<string, string>,
): Promise<ThumbnailHttpSource> {
  const source = new ThumbnailHttpSource(url, headers);
  return source;
}
