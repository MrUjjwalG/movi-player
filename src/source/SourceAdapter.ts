/**
 * SourceAdapter - Interface for data sources
 * 
 * All data access in movi flows through this interface, enabling
 * unified handling of HTTP URLs and local Files.
 */

export interface SourceAdapter {
  /**
   * Get the total size of the source in bytes
   */
  getSize(): Promise<number>;

  /**
   * Read data from the source at the given offset
   * @param offset Byte offset to start reading from
   * @param length Number of bytes to read
   * @returns ArrayBuffer containing the requested data
   */
  read(offset: number, length: number): Promise<ArrayBuffer>;

  /**
   * Seek to a position (for sources that need state)
   * @param offset The byte offset to seek to
   * @returns The actual offset seeked to
   */
  seek(offset: number): number;

  /**
   * Get the current read position
   */
  getPosition(): number;

  /**
   * Close the source and release resources
   */
  close(): void;

  /**
   * Get a unique identifier for this source (used for caching)
   */
  getKey(): string;

  /**
   * The failure this source will not recover from, if it has had one — a
   * signed URL that has started answering 403, a file that has gone away.
   *
   * A read that fails reaches the demuxer as "invalid data", which is also
   * what one bad packet looks like, and a reader that treats the two alike
   * retries a source that is never going to answer. Optional: a source that
   * cannot fail this way simply does not have it.
   */
  getFatalError?(): Error | null;
}

/**
 * Factory function type for creating source adapters
 */
export type SourceFactory = (config: SourceConfig) => Promise<SourceAdapter>;

import type { SourceConfig } from '../types';
