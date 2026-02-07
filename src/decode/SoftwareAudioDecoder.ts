import { WasmBindings } from "../wasm/bindings";
import { AudioTrack } from "../types";
import { Logger } from "../utils/Logger";

const TAG = "SoftwareAudioDecoder";

export class SoftwareAudioDecoder {
  private bindings: WasmBindings;
  private onData: ((data: AudioData) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private isConfigured = false;
  private trackIndex = -1;

  constructor(bindings: WasmBindings) {
    this.bindings = bindings;
  }

  setOnData(callback: (data: AudioData) => void): void {
    this.onData = callback;
  }

  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  async configure(track: AudioTrack): Promise<boolean> {
    this.trackIndex = track.id;

    // Enable decoder in WASM
    const ret = this.bindings.enableDecoder(this.trackIndex);
    if (ret < 0) {
      Logger.error(
        TAG,
        `Failed to enable software decoder for stream ${this.trackIndex}: ${ret}`,
      );
      return false;
    }

    // Enable stereo downmixing
    this.bindings.enableAudioDownmix(true);

    this.isConfigured = true;
    Logger.info(
      TAG,
      `Configured software decoder for stream ${this.trackIndex}`,
    );
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

  decode(data: Uint8Array, timestamp: number, keyframe: boolean): void {
    if (!this.isConfigured) return;

    const ret = this.bindings.sendPacket(
      this.trackIndex,
      data,
      timestamp,
      timestamp,
      keyframe,
    );

    if (ret < 0) {
      Logger.warn(TAG, `sendPacket failed: ${ret}`);
      return;
    }

    // Receive loop
    while (true) {
      const ret = this.bindings.receiveFrame(this.trackIndex);
      if (ret !== 0) break;

      this.processDecodedFrame(timestamp);
    }
  }

  private processDecodedFrame(timestamp: number) {
    if (!this.onData) return;

    const numberOfFrames = this.bindings.getFrameSamples();
    const numberOfChannels = this.bindings.getFrameChannels();
    const sampleRate = this.bindings.getFrameSampleRate();

    // FFmpeg usually outputs planar float (AV_SAMPLE_FMT_FLTP = 8) for most decoders
    // We need to check the format and convert if necessary, but WebCodecs AudioData
    // supports f32-planar which is what FLTP is.

    try {
      // AV_SAMPLE_FMT_FLTP (Planar Float)
      // Each plane is Float32Array
      const planeSize = numberOfFrames * 4; // 4 bytes per float
      const totalSize = planeSize * numberOfChannels;
      const buffer = new Uint8Array(totalSize);

      for (let i = 0; i < numberOfChannels; i++) {
        const ptr = this.bindings.getFrameDataPointer(i);
        const heap = (this.bindings as any).module.HEAPU8 as Uint8Array;
        const planeData = heap.subarray(ptr, ptr + planeSize);
        buffer.set(planeData, i * planeSize);
      }

      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: sampleRate,
        numberOfFrames: numberOfFrames,
        numberOfChannels: numberOfChannels,
        timestamp: timestamp * 1_000_000, // micro-seconds
        data: buffer,
      });

      if (Math.random() < 0.01) {
        // Log occasionally to avoid spam
        Logger.debug(
          TAG,
          `Audio data: ${numberOfChannels}ch, ${numberOfFrames} frames`,
        );
      }

      this.onData(audioData);
      // ownership passed to callback
    } catch (e) {
      Logger.error(TAG, "AudioData creation failed", e);
      if (this.onError) this.onError(e as Error);
    }
  }

  get configured(): boolean {
    return this.isConfigured;
  }
}
