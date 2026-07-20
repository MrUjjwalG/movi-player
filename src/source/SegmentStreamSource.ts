/**
 * SegmentStreamSource - a SourceAdapter that presents an ordered list of HLS
 * segments (optionally an fMP4 init segment first) as ONE contiguous, seekable
 * byte stream for the FFmpeg-WASM demuxer.
 *
 * Concatenating the segments byte-for-byte yields a valid continuous MPEG-TS
 * (or fragmented MP4, init + fragments) that FFmpeg demuxes linearly. To make
 * it seekable through FFmpeg's byte-based I/O we build a byte-offset map: each
 * segment's length comes from its #EXT-X-BYTERANGE when present, else a HEAD
 * (or a 0-0 ranged GET's Content-Range) measured once up front. read() then
 * maps any byte range to the covering segment(s), fetches them (LRU-cached),
 * and stitches the result.
 */
import { SourceAdapter } from "./SourceAdapter";
import { HlsSegment } from "./HlsFallback";
import { Logger } from "../utils/Logger";

const TAG = "SegmentStreamSource";

interface Entry {
  url: string;
  start: number; // virtual byte offset in the concatenated stream
  length: number; // byte length of this segment
  srcOffset: number; // offset within the source URL (BYTERANGE), else 0
  isRange: boolean; // fetch with a Range header?
}

export class SegmentStreamSource implements SourceAdapter {
  private entries: Entry[] = [];
  private totalSize = 0;
  private position = 0;
  private built = false;
  private buildPromise: Promise<void> | null = null;

  // Small LRU of fetched segment buffers, keyed by entry index.
  private cache = new Map<number, ArrayBuffer>();
  private cacheOrder: number[] = [];
  private readonly maxCached = 24;
  private _throughputBps = 0; // EWMA download speed (bytes/s) for ABR
  // Aborts in-flight segment/measure fetches on close() — e.g. the instant an
  // in-place quality switch swaps this source out — so the old rendition stops
  // pulling bytes we'll never use. The resulting "(canceled)" rows in the
  // Network tab are expected (this is what YouTube does on a quality switch),
  // not a failure; the AbortErrors it raises are swallowed below, not logged.
  private abortController = new AbortController();

  private readonly key: string;

  constructor(
    private segments: HlsSegment[],
    private initSegment: string | undefined,
    keyUrl: string,
    private headers?: Record<string, string>,
  ) {
    this.key = `hls-segments:${keyUrl}`;
  }

  /** Resolve one segment's byte length (and how to fetch it). */
  private async measure(
    url: string,
    byteRange?: { length: number; offset: number },
  ): Promise<{ length: number; srcOffset: number; isRange: boolean }> {
    if (byteRange) {
      return { length: byteRange.length, srcOffset: byteRange.offset, isRange: true };
    }
    // HEAD → Content-Length.
    try {
      const head = await fetch(url, {
        method: "HEAD",
        headers: this.headers,
        signal: this.abortController.signal,
      });
      const cl = head.headers.get("Content-Length");
      if (head.ok && cl) return { length: parseInt(cl, 10), srcOffset: 0, isRange: false };
    } catch {
      /* fall through */
    }
    // 0-0 ranged GET → total from Content-Range ("bytes 0-0/<total>").
    try {
      const res = await fetch(url, {
        headers: { ...(this.headers || {}), Range: "bytes=0-0" },
        signal: this.abortController.signal,
      });
      const cr = res.headers.get("Content-Range");
      if (cr) {
        const m = /\/\s*(\d+)\s*$/.exec(cr);
        if (m) return { length: parseInt(m[1], 10), srcOffset: 0, isRange: false };
      }
    } catch {
      /* fall through */
    }
    // Last resort: pull the whole segment and measure it (cached for read()).
    const full = await fetch(url, {
      headers: this.headers,
      signal: this.abortController.signal,
    });
    const buf = await full.arrayBuffer();
    return { length: buf.byteLength, srcOffset: 0, isRange: false };
  }

  private buildOnce(): Promise<void> {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      let offset = 0;
      const push = (
        url: string,
        m: { length: number; srcOffset: number; isRange: boolean },
      ) => {
        this.entries.push({
          url,
          start: offset,
          length: m.length,
          srcOffset: m.srcOffset,
          isRange: m.isRange,
        });
        offset += m.length;
      };

      // fMP4 init segment leads the stream.
      if (this.initSegment) {
        try {
          push(this.initSegment, await this.measure(this.initSegment));
        } catch (e) {
          if ((e as Error)?.name !== "AbortError")
            Logger.warn(TAG, "init segment measure failed", e);
        }
      }

      // Measure all media segments in parallel (bounded concurrency).
      const CONC = 12;
      const measured: (
        | { length: number; srcOffset: number; isRange: boolean }
        | null
      )[] = new Array(this.segments.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < this.segments.length) {
          const i = next++;
          const seg = this.segments[i];
          try {
            measured[i] = await this.measure(seg.url, seg.byteRange);
          } catch (e) {
            if ((e as Error)?.name !== "AbortError")
              Logger.warn(TAG, `segment ${i} measure failed`, e);
            measured[i] = { length: 0, srcOffset: 0, isRange: false };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONC, this.segments.length) }, worker),
      );

      for (let i = 0; i < this.segments.length; i++) {
        push(this.segments[i].url, measured[i]!);
      }

      this.totalSize = offset;
      this.built = true;
      Logger.info(
        TAG,
        `built segment map: ${this.entries.length} entries, ${(
          this.totalSize / 1e6
        ).toFixed(1)} MB`,
      );
    })();
    return this.buildPromise;
  }

  async getSize(): Promise<number> {
    if (!this.built) await this.buildOnce();
    return this.totalSize;
  }

  private async fetchEntry(entryIdx: number): Promise<ArrayBuffer> {
    const cached = this.cache.get(entryIdx);
    if (cached) return cached;

    const e = this.entries[entryIdx];
    const reqHeaders: Record<string, string> = { ...(this.headers || {}) };
    if (e.isRange) {
      reqHeaders["Range"] = `bytes=${e.srcOffset}-${e.srcOffset + e.length - 1}`;
    }
    const t0 = performance.now();
    let res: Response;
    let buf: ArrayBuffer;
    try {
      res = await fetch(e.url, {
        headers: reqHeaders,
        signal: this.abortController.signal,
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`segment ${entryIdx} HTTP ${res.status}`);
      }
      buf = await res.arrayBuffer();
    } catch (err) {
      // close() aborted us mid-fetch (source swapped out) — not an error;
      // return empty and let the discarded read unwind quietly.
      if ((err as Error)?.name === "AbortError") return new ArrayBuffer(0);
      throw err;
    }
    // Throughput estimate (bytes/s) for ABR — EWMA over segment downloads.
    // Floor the elapsed time instead of skipping fast fetches: the lowest
    // renditions have tiny segments that finish in a few ms, and skipping them
    // would freeze the estimate and trap the ABR at the bottom rung (unable to
    // upshift). A fast fetch legitimately signals high bandwidth.
    if (buf.byteLength > 0) {
      const elapsed = Math.max((performance.now() - t0) / 1000, 0.004);
      const bps = buf.byteLength / elapsed;
      this._throughputBps =
        this._throughputBps > 0
          ? this._throughputBps * 0.6 + bps * 0.4
          : bps;
    }
    // Server ignored the Range and returned the whole resource — slice it.
    if (e.isRange && res.status === 200 && buf.byteLength > e.length) {
      buf = buf.slice(e.srcOffset, e.srcOffset + e.length);
    }

    this.cache.set(entryIdx, buf);
    this.cacheOrder.push(entryIdx);
    if (this.cacheOrder.length > this.maxCached) {
      const evict = this.cacheOrder.shift();
      if (evict !== undefined && evict !== entryIdx) this.cache.delete(evict);
    }
    return buf;
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    if (!this.built) await this.buildOnce();
    if (offset >= this.totalSize || length <= 0) return new ArrayBuffer(0);

    const end = Math.min(offset + length, this.totalSize);
    const out = new Uint8Array(end - offset);
    let written = 0;

    // Binary-search the entry containing `offset`.
    let lo = 0;
    let hi = this.entries.length - 1;
    let startIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.entries[mid];
      if (offset < e.start) hi = mid - 1;
      else if (offset >= e.start + e.length) lo = mid + 1;
      else {
        startIdx = mid;
        break;
      }
    }

    let cur = offset;
    for (let i = startIdx; i < this.entries.length && cur < end; i++) {
      const e = this.entries[i];
      if (e.length === 0) continue;
      const buf = new Uint8Array(await this.fetchEntry(i));
      const within = cur - e.start;
      const take = Math.min(e.length - within, end - cur);
      out.set(buf.subarray(within, within + take), written);
      written += take;
      cur += take;
    }

    this.position = end;
    return written === out.length ? out.buffer : out.buffer.slice(0, written);
  }

  seek(offset: number): number {
    this.position = offset;
    return offset;
  }

  getPosition(): number {
    return this.position;
  }

  close(): void {
    // Abort in-flight segment/measure fetches so a swapped-out rendition stops
    // downloading data we'll never use. (The "(canceled)" Network-tab rows this
    // produces are expected — same as YouTube on a quality switch.)
    try {
      this.abortController.abort();
    } catch {
      /* already aborted */
    }
    this.cache.clear();
    this.cacheOrder = [];
  }

  getKey(): string {
    return this.key;
  }

  /** Download-speed estimate (bytes/s) for the ABR controller. Shape mirrors
   *  HttpSource.getNetworkStats() so the caller can duck-type either source. */
  getNetworkStats(): { currentSpeed: number; lastSpeed: number } {
    // _throughputBps is already a persistent EWMA, so currentSpeed and lastSpeed
    // are the same here (the ABR reads lastSpeed).
    return { currentSpeed: this._throughputBps, lastSpeed: this._throughputBps };
  }
}
