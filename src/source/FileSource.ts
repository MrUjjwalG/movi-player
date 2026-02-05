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

  constructor(file: File, cache: LRUCache | null = null) {
    this.file = file;
    this.size = file.size;
    // Use provided cache or create a default one
    this.cache = cache || new LRUCache(100); // Default 100MB cache
    this.sourceKey = this.getKey();
  }

  /**
   * Get the total size of the source in bytes
   */
  async getSize(): Promise<number> {
    if (this.size === -1) {
      this.size = this.file.size;
    }
    // Start preloading chunks into cache (from beginning initially)
    this.startPreload();
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

    // Estimate byte position from time (linear estimation)
    const ratio = Math.max(0, Math.min(1, currentTime / duration));
    const estimatedByteOffset = Math.floor(ratio * this.size);

    // Update preload offset if it changed significantly (more than one chunk)
    const offsetDiff = Math.abs(estimatedByteOffset - this.preloadOffset);
    if (offsetDiff >= CHUNK_SIZE) {
      const oldOffset = this.preloadOffset;
      this.preloadOffset = estimatedByteOffset;

      Logger.debug(
        TAG,
        `Preload position updated: ${oldOffset} -> ${estimatedByteOffset} (time: ${currentTime.toFixed(2)}s / ${duration.toFixed(2)}s)`,
      );

      // Restart preloading around new position
      this.preloadPromise = null; // Allow restart
      this.startPreload();
    }
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
   * Close the source and release resources
   */
  close(): void {
    // Clear cache entries for this source
    this.cache.clear();
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

      // Preload strategy: prioritize chunks ahead of current position, then behind
      // This ensures smooth playback while allowing backward seeks
      const PRELOAD_AHEAD_CHUNKS = 20; // Preload 20 chunks (40MB) ahead
      const PRELOAD_BEHIND_CHUNKS = 5; // Preload 5 chunks (10MB) behind

      // Calculate range to preload
      const startChunk = Math.floor(startOffset / CHUNK_SIZE);
      const aheadStart = startChunk;
      const aheadEnd = Math.min(
        startChunk + PRELOAD_AHEAD_CHUNKS,
        Math.ceil(this.size / CHUNK_SIZE),
      );
      const behindStart = Math.max(0, startChunk - PRELOAD_BEHIND_CHUNKS);
      const behindEnd = startChunk;

      // Preload ahead chunks first (for playback)
      for (let chunkIdx = aheadStart; chunkIdx < aheadEnd; chunkIdx++) {
        if (await this.shouldStopPreload()) break;

        const offset = chunkIdx * CHUNK_SIZE;
        const chunkLength = Math.min(CHUNK_SIZE, this.size - offset);

        if (chunkLength <= 0) break;

        // Check if already cached
        const cached = this.cache.get(this.sourceKey, offset, chunkLength);
        if (cached) continue;

        // Read and cache chunk
        const chunk = await this.readChunkFromFile(offset, chunkLength);
        this.cache.set(this.sourceKey, offset, chunkLength, chunk);
      }

      // Preload behind chunks (for seeking backward)
      for (let chunkIdx = behindEnd - 1; chunkIdx >= behindStart; chunkIdx--) {
        if (await this.shouldStopPreload()) break;

        const offset = chunkIdx * CHUNK_SIZE;
        const chunkLength = Math.min(CHUNK_SIZE, this.size - offset);

        if (chunkLength <= 0) continue;

        // Check if already cached
        const cached = this.cache.get(this.sourceKey, offset, chunkLength);
        if (cached) continue;

        // Read and cache chunk
        const chunk = await this.readChunkFromFile(offset, chunkLength);
        this.cache.set(this.sourceKey, offset, chunkLength, chunk);
      }

      Logger.debug(
        TAG,
        `Preload completed for file: ${this.file.name} around offset ${startOffset}`,
      );
    } catch (error) {
      Logger.error(TAG, `Failed to preload file: ${this.file.name}`, error);
      // Don't throw - preload failure shouldn't break the source
    } finally {
      this.preloadPromise = null;
    }
  }

  /**
   * Check if preloading should stop (cache full)
   */
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
   */
  private async readChunkFromFile(
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    const blob = this.file.slice(offset, offset + length);
    const arrayBuffer = await blob.arrayBuffer();
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
        // Not in cache, read it from file
        chunkData = await this.readChunkFromFile(chunkOffset, chunkLength);
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
    const result = new ArrayBuffer(requestedLength);
    const resultView = new Uint8Array(result);
    let filled = 0;

    // Sort by offset
    overlapping.sort((a, b) => a.offset - b.offset);

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
