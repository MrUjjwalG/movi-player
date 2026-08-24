/**
 * FileSource - Uses LRU cache for chunked file access with preloading
 *
 * For local File objects, we read the file in chunks and cache them
 * using an LRU cache. Chunks are preloaded sequentially to fill the cache.
 */

import type { SourceAdapter } from "./SourceAdapter";
import { LRUCache } from "../cache/LRUCache";
import { Logger } from "../utils/Logger";

const TAG = "FileSource";

// Chunk size for reading file (2MB chunks)
const CHUNK_SIZE = 2 * 1024 * 1024;

// How long the preload sweep stays out of the way after a read somebody was
// actually waiting on. Long enough to cover the gaps inside one demuxer burst
// (a seek asks for several chunks back to back), short enough that the sweep
// resumes the moment playback stops asking. See waitForDemandReads.
const PRELOAD_YIELD_MS = 200;

// …and the longest anything will wait its turn. Continuous playback reads would
// otherwise hold a seek-bar preview off forever, and a preview that never
// arrives is its own bug. See waitForDemandReads.
const DEMAND_YIELD_CAP_MS = 1500;

export class FileSource implements SourceAdapter {
  private file: File;
  private cache: LRUCache;
  private size: number = -1;
  private position: number = 0;
  private preloadPromise: Promise<void> | null = null;
  private sourceKey: string;
  private currentTime: number = 0;
  private duration: number = 0;
  private preloadOffset: number = 0; // Current byte offset being preloaded around
  private preloadAbort: boolean = false; // Signal to abort current preload cycle
  // When false, never preload the whole file even if it fits in cache — use a
  // bounded read-ahead instead. The host sets this on low-end mobile, where the
  // sequential whole-file read competes with heavy 4K decode and fills RAM.
  private fullFilePreload: boolean = true;
  // A second reader over a file some other source already owns — the thumbnail
  // pipeline's. It shares that source's LRU under the same key, so it must
  // neither run a preload sweep of its own nor throw the cache away on close.
  private secondary: boolean = false;

  // Disk read stats
  private totalBytesRead: number = 0;
  private lastSpeedBytes: number = 0;
  private lastSpeedTime: number = 0;
  private currentReadSpeed: number = 0; // bytes per second
  private readStartTime: number = 0;

  // Notified when a file read times out — the underlying File handle has likely
  // been revoked by the browser (mobile background, memory pressure). Fired
  // once per source; subsequent reads continue to throw.
  private onRevokedCallback: ((info: { offset: number; length: number; reason: string }) => void) | null = null;
  private revokedFired: boolean = false;

  // Fires once when the initial preload pass settles (success, error, or
  // abort). Used by MoviPlayer to gate playback on mobile 4K+ where early
  // disk I/O competes with the decode pipeline.
  private preloadComplete: boolean = false;
  private onPreloadCompleteCallback: (() => void) | null = null;

  constructor(file: File, cache: LRUCache | null = null) {
    this.file = file;
    this.size = file.size;
    // Use provided cache or create a default one
    this.cache = cache || new LRUCache(100); // Default 100MB cache
    this.sourceKey = this.getKey();
  }

  /**
   * Register a callback fired the first time a file read times out (likely
   * revocation by mobile browser). Lets the host surface a re-pick UI.
   */
  setOnRevoked(cb: (info: { offset: number; length: number; reason: string }) => void): void {
    this.onRevokedCallback = cb;
  }

  /**
   * Disable whole-file preloading (bounded read-ahead only). Set by the host on
   * low-end mobile so the initial sequential disk read doesn't compete with a
   * strained 4K decode or fill RAM. Small files fall in the read-ahead window
   * anyway, so they still cache fully.
   */
  setFullFilePreload(enabled: boolean): void {
    this.fullFilePreload = enabled;
  }

  /**
   * Mark this as a SECOND reader over a file another source already owns — the
   * thumbnail pipeline builds one of these for file sources.
   *
   * Both readers share one LRU under one key (the key is name/size/mtime, so
   * it is the same string), which is what makes the arrangement work at all.
   * What did not work was leaving the second one behaving like an owner:
   *
   *   - It ran its own whole-file preload sweep. Each pass checks the cache
   *     before reading, but the two run CONCURRENTLY, so both miss on the same
   *     not-yet-finished chunk and both read it — the whole file pulled twice.
   *     Invisible on an SSD; on a Google Drive / OneDrive virtual file, where
   *     every chunk is a network fetch through the filesystem shim, it doubles
   *     the download and makes the two readers queue behind each other.
   *   - Its close() cleared the cache. Not its own entries — the whole LRU,
   *     including everything the main source had spent that download filling.
   *     A thumbnail init that gets superseded (a quick second source change)
   *     therefore threw away the file mid-playback and it was fetched again.
   *
   * Read-through still caches every chunk it touches, so previews stay warm.
   */
  markSecondary(): void {
    this.secondary = true;
  }

  /**
   * Register a one-shot callback fired when the initial preload pass settles.
   * If preload is already complete, fires synchronously.
   */
  setOnPreloadComplete(cb: () => void): void {
    if (this.preloadComplete) {
      cb();
      return;
    }
    this.onPreloadCompleteCallback = cb;
  }

  /**
   * True once the initial preload pass has settled (success, error, or abort).
   */
  isPreloadComplete(): boolean {
    return this.preloadComplete;
  }

  /**
   * Get the total size of the source in bytes
   */
  async getSize(): Promise<number> {
    if (this.size === -1) {
      this.size = this.file.size;
    }
    // Start preloading chunks into cache (from beginning initially).
    // A secondary reader never sweeps — see markSecondary.
    if (!this.secondary) this.startPreload();
    return this.size;
  }

  /**
   * Update preload position based on current playback time
   * @param currentTime Current playback time in seconds
   * @param duration Total duration in seconds
   */
  updatePreloadPosition(currentTime: number, duration: number): void {
    if (duration <= 0 || this.size <= 0) return;

    this.currentTime = currentTime;
    this.duration = duration;
    // Let the initial preload finish — it's caching the file for smooth playback.
    // Don't restart or trigger new preloads during playback; demux reads via
    // readFromFile() already cache every chunk they touch as a fallback.
  }

  /**
   * Read data from the source at the given offset
   * @param offset Byte offset to start reading from
   * @param length Number of bytes to read
   * @returns ArrayBuffer containing the requested data
   */
  async read(offset: number, length: number): Promise<ArrayBuffer> {
    // Clamp offset and length to valid range
    const clampedOffset = Math.max(0, Math.min(offset, this.size));
    const availableLength = this.size - clampedOffset;
    const clampedLength = Math.max(0, Math.min(length, availableLength));

    if (clampedLength === 0) {
      return new ArrayBuffer(0);
    }

    // Update position
    this.position = clampedOffset + clampedLength;

    // Try to get exact match from cache first
    const cached = this.cache.get(this.sourceKey, clampedOffset, clampedLength);
    if (cached) {
      // Exact match found in cache
      return cached;
    }

    // Check for overlapping cached chunks
    const overlapping = this.cache.findOverlapping(
      this.sourceKey,
      clampedOffset,
      clampedLength,
    );
    if (overlapping.length > 0) {
      // Try to construct the result from overlapping chunks
      const result = this.constructFromOverlapping(
        overlapping,
        clampedOffset,
        clampedLength,
      );
      if (result) {
        return result;
      }
    }

    // Not in cache, read from file
    return await this.readFromFile(clampedOffset, clampedLength);
  }

  /**
   * Seek to a position (for sources that need state)
   * @param offset The byte offset to seek to
   * @returns The actual offset seeked to
   */
  seek(offset: number): number {
    this.position = Math.max(0, Math.min(offset, this.size));
    return this.position;
  }

  /**
   * Get the current read position
   */
  getPosition(): number {
    return this.position;
  }

  /**
   * Get disk read stats for nerd stats overlay
   */
  getDiskStats(): { totalBytes: number; currentSpeed: number; elapsed: number } {
    // If no read in last 1s, speed is 0 (paused/idle)
    const timeSinceLastRead = this.lastSpeedTime > 0 ? (Date.now() - this.lastSpeedTime) / 1000 : 0;
    const speed = timeSinceLastRead > 1 ? 0 : this.currentReadSpeed;
    return {
      totalBytes: this.totalBytesRead,
      currentSpeed: speed,
      elapsed: this.readStartTime > 0 ? (Date.now() - this.readStartTime) / 1000 : 0,
    };
  }

  /**
   * Close the source and release resources
   */
  close(): void {
    // Clear cache entries for this source — unless the cache belongs to the
    // source this one is reading alongside. See markSecondary.
    if (!this.secondary) this.cache.clear();
    this.position = 0;
  }

  /**
   * Get a unique identifier for this source (used for caching)
   */
  getKey(): string {
    // Use file name, size, and last modified time as key
    return `file:${this.file.name}:${this.file.size}:${this.file.lastModified}`;
  }

  /**
   * Start preloading chunks into cache
   * This method is idempotent - multiple calls will share the same preload promise
   */
  private startPreload(): void {
    // Cancel existing preload if running
    if (this.preloadPromise) {
      // Let it continue, but it will check preloadOffset
      return;
    }

    // Start preloading in background (don't await)
    this.preloadPromise = this.preloadChunks();
  }

  /**
   * Preload chunks around current position (ahead for playback, behind for seeking)
   */
  private async preloadChunks(): Promise<void> {
    this.preloadAbort = false;

    try {
      const startOffset = this.preloadOffset > 0 ? this.preloadOffset : 0;
      const timeInfo =
        this.duration > 0 && this.currentTime > 0
          ? ` (time: ${this.currentTime.toFixed(2)}s / ${this.duration.toFixed(2)}s)`
          : "";
      Logger.debug(
        TAG,
        `Starting preload for file: ${this.file.name} around offset ${startOffset}${timeInfo} (${this.size} bytes)`,
      );

      // Preload only runs before playback starts (initial load).
      // During playback, demux reads fill the cache naturally.
      // If the entire file fits in cache, preload ALL chunks to avoid disk I/O
      // during playback (which causes stutter on 4K content with heavy processLoop).
      const totalChunks = Math.ceil(this.size / CHUNK_SIZE);
      const cacheMaxBytes = this.cache.getMaxSize();
      // Full-file preload trades one big upfront read for zero disk I/O during
      // playback — a win on desktop. On low-end mobile the host disables it
      // (fullFilePreload=false): that sequential read of the whole file
      // competes with an already-strained 4K decode and fills RAM, so fall back
      // to a bounded read-ahead that follows playback instead.
      const fileFitsInCache =
        this.fullFilePreload &&
        cacheMaxBytes > 0 &&
        this.size < cacheMaxBytes * 0.8;
      const PRELOAD_AHEAD_CHUNKS = fileFitsInCache ? totalChunks : 20;
      const PRELOAD_BEHIND_CHUNKS = fileFitsInCache ? 0 : 5;

      // Calculate range to preload
      const startChunk = Math.floor(startOffset / CHUNK_SIZE);
      const aheadStart = fileFitsInCache ? 0 : startChunk;
      const aheadEnd = Math.min(
        (fileFitsInCache ? 0 : startChunk) + PRELOAD_AHEAD_CHUNKS,
        totalChunks,
      );
      const behindStart = Math.max(0, startChunk - PRELOAD_BEHIND_CHUNKS);
      const behindEnd = startChunk;

      // Preload ahead chunks first (for playback)
      for (let chunkIdx = aheadStart; chunkIdx < aheadEnd; chunkIdx++) {
        if (this.preloadAbort || await this.shouldStopPreload()) break;

        const offset = chunkIdx * CHUNK_SIZE;
        const chunkLength = Math.min(CHUNK_SIZE, this.size - offset);

        if (chunkLength <= 0) break;

        // Check if already cached
        const cached = this.cache.get(this.sourceKey, offset, chunkLength);
        if (cached) continue;

        // Never in front of a read somebody is blocked on.
        await this.waitForDemandReads();
        if (this.preloadAbort) break;

        // Read and cache chunk
        const chunk = await this.readChunkFromFile(offset, chunkLength);
        this.cache.set(this.sourceKey, offset, chunkLength, chunk);
      }

      // Preload behind chunks (for seeking backward)
      for (let chunkIdx = behindEnd - 1; chunkIdx >= behindStart; chunkIdx--) {
        if (this.preloadAbort || await this.shouldStopPreload()) break;

        const offset = chunkIdx * CHUNK_SIZE;
        const chunkLength = Math.min(CHUNK_SIZE, this.size - offset);

        if (chunkLength <= 0) continue;

        // Check if already cached
        const cached = this.cache.get(this.sourceKey, offset, chunkLength);
        if (cached) continue;

        // Never in front of a read somebody is blocked on.
        await this.waitForDemandReads();
        if (this.preloadAbort) break;

        // Read and cache chunk
        const chunk = await this.readChunkFromFile(offset, chunkLength);
        this.cache.set(this.sourceKey, offset, chunkLength, chunk);
      }

      if (!this.preloadAbort) {
        Logger.debug(
          TAG,
          `Preload completed for file: ${this.file.name} around offset ${startOffset}`,
        );
      }
    } catch (error) {
      Logger.error(TAG, `Failed to preload file: ${this.file.name}`, error);
    } finally {
      this.preloadPromise = null;
      this.preloadAbort = false;
      if (!this.preloadComplete) {
        this.preloadComplete = true;
        const cb = this.onPreloadCompleteCallback;
        this.onPreloadCompleteCallback = null;
        if (cb) cb();
      }
    }
  }

  /**
   * Check if preloading should stop (cache full)
   */
  /**
   * Hold the preload sweep while somebody is waiting on bytes of their own.
   *
   * The sweep walks the file from the front. A seek needs bytes from wherever
   * the playhead landed, which on a long file is far ahead of wherever the
   * sweep has got to — so the two ask the filesystem for different parts of
   * the same file at the same time, and the one nobody is waiting for gets
   * served alongside the one everybody is. Captured on a 94MB 4K AV1 file: a
   * seek to 110s needs the chunk at 58MB, and what actually arrived in the
   * next second and a half were the sweep's chunks at 37MB and 39MB. No frame
   * decoded, the seek hit its deadline, black-frame recovery seeked again.
   *
   * So the sweep stands down for a moment after every demand read. It is a
   * read-ahead: being late costs nothing, and being in the way costs a seek.
   */
  private async waitForDemandReads(): Promise<void> {
    // Read off the shared cache, not this instance: the reader most in need of
    // giving way — the thumbnail pipeline's — never issues a demand read of its
    // own, so its local stamp would say the coast was clear forever.
    let waited = 0;
    while (
      !this.preloadAbort &&
      this.cache.msSinceDemandRead() < PRELOAD_YIELD_MS &&
      waited < DEMAND_YIELD_CAP_MS
    ) {
      await new Promise((r) => setTimeout(r, 30));
      waited += 30;
    }
  }

  private async shouldStopPreload(): Promise<boolean> {
    // Check if cache is nearly full (95% utilization)
    const utilization = this.cache.getUtilization();
    if (utilization >= 95) {
      Logger.debug(
        TAG,
        `Cache nearly full (${utilization.toFixed(1)}%), stopping preload`,
      );
      return true;
    }

    return false;
  }

  /**
   * Read a chunk from file and cache it
   *
   * Mobile browsers (iOS Safari, Android Chrome) can revoke the underlying File
   * handle after long backgrounding or under memory pressure. The Blob then
   * silently hangs on read instead of rejecting, which stalls the demuxer
   * forever. Race against a timeout and surface a clear error so the UI can
   * prompt the user to re-pick the file.
   */
  private async readChunkFromFile(
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    const blob = this.file.slice(offset, offset + length);
    const READ_TIMEOUT_MS = 8000;
    const reason = `FileSource read timeout (${READ_TIMEOUT_MS}ms) at offset=${offset} length=${length} — file handle likely revoked by browser; user must re-pick the file`;
    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await Promise.race([
        blob.arrayBuffer(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(reason)), READ_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      if (!this.revokedFired && this.onRevokedCallback) {
        this.revokedFired = true;
        try {
          this.onRevokedCallback({ offset, length, reason });
        } catch {
          // Don't let listener errors mask the original read failure
        }
      }
      throw err;
    }

    // Track disk read stats
    if (this.readStartTime === 0) {
      this.readStartTime = Date.now();
      this.lastSpeedTime = this.readStartTime;
    }
    this.totalBytesRead += arrayBuffer.byteLength;
    const now = Date.now();
    const elapsed = (now - this.lastSpeedTime) / 1000;
    if (elapsed >= 0.5) {
      this.currentReadSpeed = (this.totalBytesRead - this.lastSpeedBytes) / elapsed;
      this.lastSpeedBytes = this.totalBytesRead;
      this.lastSpeedTime = now;
    }

    return arrayBuffer;
  }

  /**
   * Read from file (not cached) and optionally cache it
   */
  /**
   * Read from file (not cached) and optionally cache it
   * Enforces strict CHUNK_SIZE alignment to prevent cache duplication
   */
  private async readFromFile(
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    const result = new ArrayBuffer(length);
    const resultView = new Uint8Array(result);

    // Calculate which standard chunks cover this range
    const startChunkIndex = Math.floor(offset / CHUNK_SIZE);
    const endChunkIndex = Math.floor((offset + length - 1) / CHUNK_SIZE);

    for (let i = startChunkIndex; i <= endChunkIndex; i++) {
      const chunkOffset = i * CHUNK_SIZE;
      const chunkLength = Math.min(CHUNK_SIZE, this.size - chunkOffset);

      if (chunkLength <= 0) break;

      // Try to get standard chunk from cache first
      let chunkData = this.cache.get(this.sourceKey, chunkOffset, chunkLength);

      if (!chunkData) {
        // Not in cache, read it from file. This is a DEMAND read — somebody is
        // blocked on these exact bytes — so stamp it, both before and after:
        // the preload sweep stands down while these are in flight, and the
        // after-stamp keeps it down until the burst really ends rather than
        // letting it barge back in between two demand chunks.
        //
        // A SECONDARY reader's "demand" is a seek-bar preview — a picture that
        // has not been asked for yet and that nobody is watching playback for.
        // It waits behind playback's reads instead of announcing itself as one.
        // This is the case both of the captured logs were stuck on: a preview
        // read went in flight as the user clicked, the seek's own bytes queued
        // behind it, and a second and a half later the seek gave up having
        // decoded nothing — then the preview landed.
        if (this.secondary) {
          await this.waitForDemandReads();
        } else {
          this.cache.markDemandRead();
        }
        chunkData = await this.readChunkFromFile(chunkOffset, chunkLength);
        if (!this.secondary) this.cache.markDemandRead();
        // Cache the standard chunk
        this.cache.set(this.sourceKey, chunkOffset, chunkLength, chunkData);
      }

      // Copy relevant portion to result
      const overlapStart = Math.max(offset, chunkOffset);
      const overlapEnd = Math.min(offset + length, chunkOffset + chunkLength);

      if (overlapEnd > overlapStart) {
        const dstOffset = overlapStart - offset;
        const srcOffset = overlapStart - chunkOffset;
        const copyLength = overlapEnd - overlapStart;

        resultView.set(
          new Uint8Array(chunkData, srcOffset, copyLength),
          dstOffset,
        );
      }
    }

    return result;
  }

  /**
   * Construct result from overlapping cached chunks
   */
  private constructFromOverlapping(
    overlapping: Array<{ offset: number; length: number; data: ArrayBuffer }>,
    requestedOffset: number,
    requestedLength: number,
  ): ArrayBuffer | null {
    const requestedEnd = requestedOffset + requestedLength;

    // Sort by offset
    overlapping.sort((a, b) => a.offset - b.offset);

    // Decide BEFORE allocating. A miss used to allocate the full request — half
    // a megabyte on the demuxer's avio buffer — copy every overlapping byte
    // into it, and then throw the whole thing away by returning null. On a file
    // larger than the cache that is the common case, and at the read rate a 4K
    // source demands it is megabytes a second of garbage for nothing. Walk the
    // ranges first; only a request the cache can satisfy end to end is worth a
    // buffer.
    let covered = requestedOffset;
    for (const chunk of overlapping) {
      if (chunk.offset > covered) break; // hole — the cache cannot serve this
      const chunkEnd = chunk.offset + chunk.length;
      if (chunkEnd > covered) covered = chunkEnd;
      if (covered >= requestedEnd) break;
    }
    if (covered < requestedEnd) {
      return null; // partial fill — trigger a file read
    }

    const result = new ArrayBuffer(requestedLength);
    const resultView = new Uint8Array(result);
    let filled = 0;

    for (const chunk of overlapping) {
      const chunkEnd = chunk.offset + chunk.length;

      // Calculate overlap
      const overlapStart = Math.max(requestedOffset, chunk.offset);
      const overlapEnd = Math.min(requestedEnd, chunkEnd);

      if (overlapStart < overlapEnd) {
        const overlapLength = overlapEnd - overlapStart;
        const srcStart = overlapStart - chunk.offset;
        const dstStart = overlapStart - requestedOffset;

        resultView.set(
          new Uint8Array(chunk.data, srcStart, overlapLength),
          dstStart,
        );
        filled += overlapLength;
      }
    }

    // If we filled the entire request, return it
    if (filled === requestedLength) {
      return result;
    }

    // Partial fill, return null to trigger file read
    return null;
  }
}

/**
 * Factory function to create a FileSource
 */
export async function createFileSource(
  file: File,
  cache: LRUCache | null = null,
): Promise<FileSource> {
  const source = new FileSource(file, cache);
  // Start preloading chunks into cache
  await source.getSize();
  return source;
}
