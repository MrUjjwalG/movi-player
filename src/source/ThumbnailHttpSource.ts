/**
 * ThumbnailHttpSource - Buffered HTTP source for thumbnail extraction.
 *
 * Uses a simple sliding buffer to cache data and reduce HTTP requests.
 * Each seek position triggers a larger chunk fetch, and subsequent reads
 * are served from the buffer until a new seek is needed.
 */

import type { SourceAdapter } from "./SourceAdapter";
import { Logger } from "../utils/Logger";

const TAG = "ThumbnailHttpSource";

// Buffer 512KB at a time - enough for most keyframes
const BUFFER_SIZE = 512 * 1024;

export class ThumbnailHttpSource implements SourceAdapter {
  private url: string;
  private headers: Record<string, string>;
  private size: number = -1;
  private position: number = 0;
  private abortController: AbortController | null = null;

  // Simple buffer cache
  private buffer: Uint8Array | null = null;
  private bufferStart: number = 0;
  private bufferEnd: number = 0;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async getSize(): Promise<number> {
    if (this.size >= 0) return this.size;

    const response = await fetch(this.url, {
      method: "HEAD",
      headers: this.headers,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentLength = response.headers.get("Content-Length");
    if (!contentLength) throw new Error("Content-Length missing");

    this.size = parseInt(contentLength, 10);
    Logger.debug(TAG, `File size: ${this.size} bytes`);

    return this.size;
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

    // Serve from buffer if available
    if (this.isInBuffer(offset, length)) {
      const localOffset = offset - this.bufferStart;
      const result = new Uint8Array(length);
      result.set(this.buffer!.subarray(localOffset, localOffset + length));
      this.position = offset + length;
      Logger.debug(TAG, `Read from buffer: offset=${offset}, length=${length}`);
      return result.buffer;
    }

    // Need to fetch - calculate optimal range
    // Fetch a larger chunk to avoid multiple small requests
    const fetchStart = offset;
    const fetchSize = Math.max(BUFFER_SIZE, length);
    const fetchEnd =
      this.size > 0
        ? Math.min(fetchStart + fetchSize - 1, this.size - 1)
        : fetchStart + fetchSize - 1;

    Logger.debug(
      TAG,
      `Fetching: range=${fetchStart}-${fetchEnd} (${((fetchEnd - fetchStart + 1) / 1024).toFixed(1)} KB)`,
    );

    // Use a local controller for this request + timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const response = await fetch(this.url, {
        headers: {
          ...this.headers,
          Range: `bytes=${fetchStart}-${fetchEnd}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 416) {
          Logger.warn(
            TAG,
            `HTTP 416 (Range Not Satisfiable) at ${fetchStart}-${fetchEnd} (Size: ${this.size}). Treating as EOF.`,
          );
          // If we get 416, we are likely past the end of the file or the file size changed
          // Return empty buffer to signal EOF
          return new ArrayBuffer(0);
        } else if (response.status !== 206) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
      }

      const arrayBuffer = await response.arrayBuffer();

      // Store in buffer
      this.buffer = new Uint8Array(arrayBuffer);
      this.bufferStart = fetchStart;
      this.bufferEnd = fetchStart + arrayBuffer.byteLength;

      Logger.debug(
        TAG,
        `Buffered: ${this.bufferStart}-${this.bufferEnd} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`,
      );

      // Return requested portion
      const resultLength = Math.min(length, arrayBuffer.byteLength);
      const result = new Uint8Array(resultLength);
      result.set(this.buffer.subarray(0, resultLength));
      this.position = offset + resultLength;

      return result.buffer;
    } catch (error) {
      if ((error as any).name === "AbortError") {
        Logger.debug(TAG, `Read aborted at offset ${offset}`);
        return new ArrayBuffer(0);
      }
      throw error;
    }
  }

  seek(offset: number): number {
    this.position = offset;
    return this.position;
  }

  getPosition(): number {
    return this.position;
  }

  /**
   * Clear buffer to free memory when thumbnails aren't being actively generated
   * Call this after thumbnail generation is complete
   */
  clearBuffer(): void {
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
