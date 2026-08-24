/**
 * LRUCache - Least Recently Used cache for byte ranges
 * 
 * Caches chunks of data keyed by source + byte range.
 * Automatically evicts least recently used entries when size limit reached.
 */

import { Logger } from '../utils/Logger';

const TAG = 'LRUCache';

interface CacheEntry {
  key: string;
  data: ArrayBuffer;
  accessTime: number;
  /** The byte range this entry holds. Carried on the entry because
   *  findOverlapping scans EVERY entry on every read, and re-deriving these
   *  from the key cost a split() and two parseInt() per entry per scan. */
  offset: number;
  length: number;
}

export class LRUCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSizeBytes: number;
  private currentSizeBytes: number = 0;

  constructor(maxSizeMB: number = 100) {
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;
    Logger.debug(TAG, `Created with max size: ${maxSizeMB}MB`);
  }

  /**
   * Generate a cache key from source key, offset, and length
   */
  private makeKey(sourceKey: string, offset: number, length: number): string {
    return `${sourceKey}:${offset}:${length}`;
  }

  /**
   * Get data from cache if available
   */
  get(sourceKey: string, offset: number, length: number): ArrayBuffer | null {
    const key = this.makeKey(sourceKey, offset, length);
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    // Update access time
    entry.accessTime = performance.now();
    
    Logger.debug(TAG, `Cache hit: ${key}`);
    return entry.data;
  }

  /**
   * Store data in cache
   */
  set(sourceKey: string, offset: number, length: number, data: ArrayBuffer): void {
    const key = this.makeKey(sourceKey, offset, length);
    
    // If already exists, remove old entry first
    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      this.currentSizeBytes -= existing.data.byteLength;
      this.cache.delete(key);
    }

    // Evict if necessary
    while (this.currentSizeBytes + data.byteLength > this.maxSizeBytes && this.cache.size > 0) {
      this.evictLRU();
    }

    // Add new entry
    const entry: CacheEntry = {
      key,
      data,
      accessTime: performance.now(),
      offset,
      length,
    };
    
    this.cache.set(key, entry);
    this.currentSizeBytes += data.byteLength;
    
    Logger.debug(TAG, `Cache set: ${key}, size: ${data.byteLength}, total: ${this.currentSizeBytes}`);
  }

  /**
   * Check if a range partially overlaps with cached data
   * Returns overlapping entries
   */
  findOverlapping(sourceKey: string, offset: number, length: number): Array<{
    offset: number;
    length: number;
    data: ArrayBuffer;
  }> {
    const results: Array<{ offset: number; length: number; data: ArrayBuffer }> = [];
    const end = offset + length;
    // A whole-cache scan runs on EVERY read, and the cache is sized in
    // hundreds of megabytes — 520MB of 2MB chunks is 260 entries. This used to
    // rebuild each entry's range from its key: `key.split(':')` allocates an
    // array and a string per segment, then two parseInt on top, for every
    // entry on every scan. That is on the order of a thousand short-lived
    // allocations per read and tens of thousands a second, which is a garbage
    // firehose — and `(garbage collector)` showed up as a 39ms main-thread
    // block in the profile of a session whose audio was crackling. The range
    // is known at set() time, so keep it there and read it.
    const prefix = sourceKey + ':';
    for (const entry of this.cache.values()) {
      if (!entry.key.startsWith(prefix)) continue;
      if (entry.offset < end && entry.offset + entry.length > offset) {
        entry.accessTime = performance.now();
        results.push({
          offset: entry.offset,
          length: entry.length,
          data: entry.data,
        });
      }
    }

    return results;
  }

  /**
   * Evict the least recently used entry
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.accessTime < oldestTime) {
        oldestTime = entry.accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      this.currentSizeBytes -= entry.data.byteLength;
      this.cache.delete(oldestKey);
      Logger.debug(TAG, `Evicted: ${oldestKey}`);
    }
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.cache.clear();
    this.currentSizeBytes = 0;
    Logger.debug(TAG, 'Cache cleared');
  }

  /**
   * Get current cache size in bytes
   */
  getSize(): number {
    return this.currentSizeBytes;
  }

  /**
   * Get number of entries in cache
   */
  getEntryCount(): number {
    return this.cache.size;
  }

  /**
   * When somebody last read bytes they were BLOCKED on, across every source
   * sharing this cache.
   *
   * It lives here rather than on a source because the readers that have to give
   * way are not the same object as the reader they give way to: playback and
   * the thumbnail pipeline are two FileSources over one file, sharing this
   * cache, and the thumbnail one has no other way to learn that a seek is
   * waiting on the disk. See FileSource.waitForDemandReads.
   */
  private _lastDemandReadAt: number = 0;

  markDemandRead(): void {
    this._lastDemandReadAt = performance.now();
  }

  msSinceDemandRead(): number {
    return this._lastDemandReadAt === 0
      ? Number.POSITIVE_INFINITY
      : performance.now() - this._lastDemandReadAt;
  }

  /**
   * Get cache utilization percentage
   */
  getUtilization(): number {
    return (this.currentSizeBytes / this.maxSizeBytes) * 100;
  }

  /**
   * Get maximum cache size in bytes
   */
  getMaxSize(): number {
    return this.maxSizeBytes;
  }

  /**
   * Get all cached byte ranges for a specific source
   * @param sourceKey The source key to get ranges for
   * @returns Array of {offset, length} byte ranges, sorted by offset
   */
  getCachedRanges(sourceKey: string): Array<{ offset: number; length: number }> {
    const ranges: Array<{ offset: number; length: number }> = [];
    
    for (const [key] of this.cache) {
      if (!key.startsWith(sourceKey + ':')) continue;
      
      const parts = key.split(':');
      const offset = parseInt(parts[parts.length - 2], 10);
      const length = parseInt(parts[parts.length - 1], 10);
      
      ranges.push({ offset, length });
    }
    
    // Sort by offset
    ranges.sort((a, b) => a.offset - b.offset);
    
    return ranges;
  }
}
