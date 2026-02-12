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
const DEFAULT_MAX_BUFFER_SIZE_MB = 520; // Default max buffer size in MB (matches default LRU cache)
const BUFFER_PERCENTAGE = 0.03; // 3% of file size
const MAX_STREAM_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB max per streaming session (regardless of total buffer size)
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

export class HttpSource implements SourceAdapter {
  private url: string;
  private headers: Record<string, string>;
  private size: number = -1;
  private position: number = 0;

  // Persistent Cache
  private headBuffer: Uint8Array | null = null;

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

  // Dynamic buffer size (3% of file size, clamped)
  // Start with minimum size, will be resized when file size is known
  private bufferSize: number = MIN_BUFFER_SIZE;

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

  async getSize(): Promise<number> {
    if (this.size >= 0) return this.size;

    try {
      const response = await fetch(this.url, {
        method: "HEAD",
        headers: this.headers,
      });

      if (!response.ok) {
        // Provide specific error messages for common status codes
        if (response.status === 403) {
          throw new Error("Access denied. Check video permissions.");
        } else if (response.status === 401) {
          throw new Error("Authentication required.");
        } else if (response.status === 404) {
          throw new Error("Video not found.");
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      }

      const contentLength = response.headers.get("Content-Length");
      if (!contentLength) throw new Error("Content-Length missing");

      this.size = parseInt(contentLength, 10);
      Logger.debug(TAG, `File size: ${this.size} bytes`);

      // Resize buffer to 3% of file size (clamped to min/max)
      const calculatedBufferSize = Math.floor(this.size * BUFFER_PERCENTAGE);
      this.resizeBuffer(calculatedBufferSize);
      Logger.debug(
        TAG,
        `Buffer size set to ${(this.bufferSize / 1024 / 1024).toFixed(2)} MB (3% of ${(this.size / 1024 / 1024).toFixed(2)} MB file)`,
      );

      // Start caching using the known file size to optimal calculation
      // this.ensureHeadCache();

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
   * Start streaming from offset
   */
  private async startStream(fromOffset: number): Promise<void> {
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

    // Reset maxBufferedEnd when seeking to new position
    // If the old maxBufferedEnd is outside the new buffer window, it's stale
    if (this.maxBufferedEnd < fromOffset || this.maxBufferedEnd > fromOffset + this.bufferSize) {
      // Old buffered data is outside new window, reset to current position
      this.maxBufferedEnd = fromOffset;
    }

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
        // This prevents downloading too much data on seeks in large files
        const maxDownload = Math.floor(Math.min(
          MAX_STREAM_BUFFER_SIZE,
          this.bufferSize * 0.9 // Don't exceed 90% of allocated buffer
        ));
        const rangeEnd = this.size > 0
          ? Math.min(resumeOffset + maxDownload - 1, this.size - 1)
          : resumeOffset + maxDownload - 1;

        // Fetch with bounded range
        Logger.debug(TAG, `Fetching range: ${resumeOffset}-${rangeEnd} (max ${(maxDownload / 1024 / 1024).toFixed(1)}MB)`);
        const response = await fetch(this.url, {
          headers: {
            ...this.headers,
            Range: `bytes=${resumeOffset}-${rangeEnd}`,
          },
          cache: 'no-store', // Prevent cached 200 responses
          signal: this.abortController!.signal,
        });

        // CRITICAL: Check for 206 Partial Content response
        // If server returns 200, it's sending entire file instead of range!
        if (response.status === 200) {
          const rangeError = new Error("Server does not support range requests.");
          Logger.error(
            TAG,
            `Server returned 200 instead of 206. Range requests not supported.`
          );
          // Abort the response to prevent downloading
          this.abortController?.abort();
          this.atomicSetStreaming(false);
          this.streamError = rangeError; // Store for read() to pick up immediately
          throw rangeError;
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
        retryCount = 0; // Reset retry on success

        // Initialize buffer window if this is the first successful connection
        if (!windowInitialized) {
          this.atomicSetBufferStart(startOffset);
          this.atomicSetWritePos(0);
          windowInitialized = true;
        }

        let downloadedBytes = 0;
        let lastLogBytes = 0;
        const startTime = Date.now();

        // Read Loop
        while (this.atomicIsStreaming()) {
          const { done, value } = await this.reader.read();
          if (done) {
            this.atomicSetStreaming(false);
            break;
          }

          if (value) {
            downloadedBytes += value.length;
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

                this.unlock();

                // Stop if we've downloaded the bounded amount (prevents excessive downloading on seeks)
                const downloadedBytes = currentEnd - startOffset;
                const maxDownload = Math.floor(Math.min(
                  MAX_STREAM_BUFFER_SIZE,
                  this.bufferSize * 0.9
                ));
                if (downloadedBytes >= maxDownload) {
                  Logger.debug(TAG, `Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB (limit reached), stopping stream`);
                  this.atomicSetStreaming(false);
                  break;
                }

                // Stop if buffer nearly full
                if (newWritePos >= buffer.length * 0.9) {
                  Logger.debug(TAG, `Buffer nearly full, stopping stream`);
                  this.atomicSetStreaming(false);
                  break;
                }

                // Check EOF
                if (this.size > 0 && currentEnd >= this.size) {
                  Logger.debug(TAG, "Reached EOF, stopping stream");
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
      } catch (error) {
        if ((error as any).name === "AbortError") {
          break;
        }

        // Check for CORS errors (TypeError: Failed to fetch)
        // CORS errors cannot be retried as they're a configuration issue
        const errorMessage = (error as any).message || "";
        const isCorsError =
          (error as any).name === "TypeError" &&
          errorMessage.includes("Failed to fetch");

        if (isCorsError) {
          const corsError = new Error(
            "Failed to fetch video resource. Check your connection or CORS settings."
          );
          Logger.error(TAG, `CORS error accessing ${this.url}`);
          this.atomicSetStreaming(false);
          this.streamError = corsError; // Store for read() to pick up
          throw corsError;
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
          // Wait for online event
          await new Promise<void>((resolve) => {
            const onOnline = () => {
              self.removeEventListener("online", onOnline);
              resolve();
            };
            self.addEventListener("online", onOnline);
          });
          Logger.info(TAG, "Network online, resuming...");
          retryCount = 0; // Reset retries since we were offline
          // Continue immediately ensuring we don't hit the backoff below
          continue;
        }

        retryCount++;
        if (retryCount > MAX_RETRIES) {
          Logger.error(TAG, `Max retries (${MAX_RETRIES}) reached, giving up.`);
          this.atomicSetStreaming(false);
          break;
        }
        // Backoff
        const delay = Math.min(BASE_DELAY * Math.pow(1.5, retryCount), 10000);
        await new Promise((r) => setTimeout(r, delay));
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
    timeout = 15000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeout;
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

    while (this.bufferEnd < needed && this.atomicIsStreaming()) {
      // Check for fatal stream errors (e.g., CORS) and throw immediately
      if (this.streamError) {
        throw this.streamError;
      }

      if (Date.now() > deadline) {
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
    Logger.debug(
      TAG,
      `Read: offset=${offset}, length=${length}, bufferStart=${this.atomicGetBufferStart()}, bufferEnd=${this.bufferEnd}, streaming=${this.atomicIsStreaming()}`,
    );

    // EOF Check
    if (this.size > 0 && offset >= this.size) {
      Logger.debug(TAG, `Read: returning empty (EOF)`);
      return new ArrayBuffer(0);
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
      Logger.debug(TAG, `Read: serving from buffer`);
      return this.readFromBuffer(offset, length);
    }

    // Optimization: Check if the ACTIVE stream covers this request.
    // If so, we strictly wait for it. Interrupting an active stream that is
    // successfully filling the buffer is inefficient and causes stalls.
    const streamStart = this.atomicGetBufferStart();
    // Check coverage: Stream is active AND request is within the buffer window it is filling
    const isCoveredByStream =
      this.atomicIsStreaming() &&
      offset >= streamStart &&
      offset < streamStart + this.bufferSize;

    Logger.debug(TAG, `Read: isCoveredByStream=${isCoveredByStream}`);

    if (isCoveredByStream) {
      Logger.debug(TAG, `Read: waiting for data from active stream...`);
      const success = await this.waitForData(offset, length);
      Logger.debug(TAG, `Read: waitForData returned ${success}`);
      if (success) return this.readFromBuffer(offset, length);

      // If wait failed but stream is still theoretically active/valid,
      // it means we timed out. We could restart, or throw.
      // Retrying wait or restarting check is better than blindly clobbering.
      if (this.atomicIsStreaming()) {
        // Double check buffer - maybe it arrived just now?
        if (this.isInBuffer(offset, length))
          return this.readFromBuffer(offset, length);

        Logger.warn(
          TAG,
          `Read timeout for ${offset} but stream is active. Force restarting.`,
        );
      }
    }

    // Need new stream (Seeked outside window, or stream dead)
    Logger.debug(TAG, `Read: starting new stream from ${offset}`);
    await this.startStream(offset);
    Logger.debug(TAG, `Read: waiting for data...`);
    const success = await this.waitForData(offset, length);
    Logger.debug(TAG, `Read: waitForData returned ${success}`);
    if (!success) throw new Error(`Timeout at ${offset}`);

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
   * Get the current buffered end position in bytes
   * This represents the furthest byte that has been buffered
   * Uses the maximum of current buffer window and historical max position,
   * but caps it to not exceed what's actually available
   */
  getBufferedEnd(): number {
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

    // Ensure buffered end is at least as far as current read position
    // This prevents buffer bar from appearing behind playback position
    if (result < this.position) {
      result = this.position;
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
