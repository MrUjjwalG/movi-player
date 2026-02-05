import { WasmBindings } from '../wasm/bindings';
import { VideoTrack } from '../types';
import { Logger } from '../utils/Logger';

const TAG = 'SoftwareVideoDecoder';

export class SoftwareVideoDecoder {
  private bindings: WasmBindings;
  private onFrame: ((frame: VideoFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private isConfigured = false;
  private trackIndex = -1;
  private currentTrack: VideoTrack | null = null;
  
  constructor(bindings: WasmBindings) {
    this.bindings = bindings;
  }

  setOnFrame(callback: (frame: VideoFrame) => void): void {
      this.onFrame = callback;
  }
  
  setOnError(callback: (error: Error) => void): void {
      this.onError = callback; 
  }

  async configure(track: VideoTrack): Promise<boolean> {
    this.trackIndex = track.id;
    this.currentTrack = track;
    
    // Enable decoder in WASM
    const ret = this.bindings.enableDecoder(this.trackIndex);
    if (ret < 0) {
        Logger.error(TAG, `Failed to enable software decoder for stream ${this.trackIndex}: ${ret}`);
        return false;
    }
    
    this.isConfigured = true;
    Logger.info(TAG, `Configured software decoder for stream ${this.trackIndex}`);
    return true;
  }
  
  async flush(): Promise<void> {
      // No-op
  }
  
  reset(): void {
      // No-op
  }
  
  close(): void {
      this.isConfigured = false;
  }

  decode(chunk: EncodedVideoChunk): void {
      if (!this.isConfigured) return;
      
      const size = chunk.byteLength;
      const buffer = new Uint8Array(size);
      chunk.copyTo(buffer);
      
      const ret = this.bindings.sendPacket(
          this.trackIndex, 
          buffer, 
          chunk.timestamp / 1_000_000, 
          chunk.timestamp / 1_000_000, 
          chunk.type === 'key'
      );
      
      if (ret < 0) {
          Logger.warn(TAG, `sendPacket failed: ${ret}`);
          return;
      }
      
      // Receive loop
      while (true) {
          const ret = this.bindings.receiveFrame(this.trackIndex);
          if (ret !== 0) break; 
          
          this.processDecodedFrame(chunk.timestamp);
      }
  }

  private processDecodedFrame(timestamp: number) {
      if (!this.onFrame) return;
      
      const width = this.bindings.getFrameWidth();
      const height = this.bindings.getFrameHeight();
      
      // Assuming YUV420P (I420)
      try {
          // Calculate sizes
          // Y: w * h
          // U: w/2 * h/2
          // V: w/2 * h/2
          const ySize = width * height;
          const uvSize = (width / 2) * (height / 2);
          const totalSize = ySize + 2 * uvSize;
          
          const buffer = new Uint8Array(totalSize);
          
          // Copy Y
          const yPtr = this.bindings.getFrameDataPointer(0);
          const yStride = this.bindings.getFrameLinesize(0);
          this.copyPlane(buffer, 0, yPtr, width, height, yStride);
          
          // Copy U
          const uPtr = this.bindings.getFrameDataPointer(1);
          const uStride = this.bindings.getFrameLinesize(1);
          this.copyPlane(buffer, ySize, uPtr, width/2, height/2, uStride);

          // Copy V
          const vPtr = this.bindings.getFrameDataPointer(2);
          const vStride = this.bindings.getFrameLinesize(2);
          this.copyPlane(buffer, ySize + uvSize, vPtr, width/2, height/2, vStride);
          
          const frameInit: VideoFrameBufferInit = {
              format: 'I420',
              codedWidth: width,
              codedHeight: height,
              timestamp: timestamp, 
          };

          // Apply color space if available
          if (this.currentTrack?.colorPrimaries || this.currentTrack?.colorTransfer || this.currentTrack?.colorSpace) {
              frameInit.colorSpace = {
                  primaries: this.currentTrack.colorPrimaries as VideoColorPrimaries,
                  transfer: this.currentTrack.colorTransfer as VideoTransferCharacteristics,
                  matrix: this.currentTrack.colorSpace as VideoMatrixCoefficients,
                  fullRange: true // Software decoder usually outputs full range or we assume it
              };
          }

          const frame = new VideoFrame(buffer, frameInit);
          
          this.onFrame(frame);
          // Ownership transferred to caller
      } catch (e) {
          Logger.error(TAG, 'Frame creation failed', e);
          if (this.onError) this.onError(e as Error);
      }
  }
  
  get configured(): boolean {
    return this.isConfigured;
  }
  
  private copyPlane(dest: Uint8Array, destOffset: number, srcPtr: number, width: number, height: number, stride: number) {
     const heap = (this.bindings as any).module.HEAPU8 as Uint8Array;
     for (let y = 0; y < height; y++) {
         const srcStart = srcPtr + y * stride;
         // Copy 'width' bytes (assuming 1 byte/pixel for I420)
         const srcEnd = srcStart + width; 
         const line = heap.subarray(srcStart, srcEnd);
         dest.set(line, destOffset + y * width);
     }
  }
}
