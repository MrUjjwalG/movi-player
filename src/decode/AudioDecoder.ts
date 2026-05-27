import type { AudioTrack } from "../types";
import { Logger } from "../utils/Logger";
import { SoftwareAudioDecoder, type PCMFrame } from "./SoftwareAudioDecoder";
import { WasmBindings } from "../wasm/bindings";

const TAG = "AudioDecoder";

export class MoviAudioDecoder {
  private decoder: AudioDecoder | null = null;
  private swDecoder: SoftwareAudioDecoder | null = null;
  private bindings: WasmBindings | null = null;
  private useSoftware: boolean = false;

  private pendingPCM: PCMFrame[] = [];
  private pendingChunks: Array<{
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
  }> = [];
  private isConfigured: boolean = false;
  private onPCM: ((frame: PCMFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private currentTrack: AudioTrack | null = null;
  // Stereo downmix policy for the software path (truehd, dca, ac3,
  // eac3, …). Defaults to stereo so headphones / laptop speakers
  // sound right; flipped off by setDownmix() when the player has
  // confirmed the output destination supports the source's full
  // channel count. WebCodecs path is unaffected — the browser
  // delivers AudioData at the source channel count and the AudioRenderer
  // either passes it through (if destination.channelCount matches)
  // or lets Web Audio do its own downmix.
  private _downmix = true;

  constructor() {
    Logger.debug(TAG, "Created");
  }

  setDownmix(downmix: boolean): void {
    this._downmix = downmix;
    if (this.swDecoder) this.swDecoder.setDownmix(downmix);
  }

  setBindings(bindings: WasmBindings) {
    this.bindings = bindings;
  }

  /**
   * Configure the decoder for a specific track
   */
  async configure(track: AudioTrack, _extradata?: Uint8Array): Promise<boolean> {
    this.currentTrack = track;
    this.useSoftware = false;

    if (this.swDecoder) {
      this.swDecoder.close();
      this.swDecoder = null;
    }

    // Always use the FFmpeg/WASM software path for audio. The hardware
    // WebCodecs AudioDecoder was historically flaky across browsers /
    // codecs (Opus gap handling, MP3 mid-stream config drift, AAC SBR
    // variants, multi-channel >2ch) — every observed failure ended in a
    // fallback to this same software path after a one-shot decode error
    // and a visible audio glitch at the switchover. Going straight to
    // software is consistent, free of that glitch, and the bitrates an
    // audio stream actually pushes (≤ 320 kbps music, 1–2 Mbps Tru/DTS)
    // are nowhere near a CPU bottleneck for the WASM decoder. The video
    // pipeline is unchanged and still tries hardware first.
    Logger.info(TAG, `Using software decoding for audio: ${track.codec}`);
    return this.initSoftwareDecoder();
  }

  private async initSoftwareDecoder(): Promise<boolean> {
    if (!this.currentTrack) return false;
    if (!this.bindings) {
      Logger.error(
        TAG,
        "Cannot switch to software decoder: bindings not available",
      );
      return false;
    }

    Logger.info(TAG, "Initializing software decoder fallback");
    this.useSoftware = true;

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (e) {}
      this.decoder = null;
    }

    this.swDecoder = new SoftwareAudioDecoder(this.bindings);
    // Carry forward the player-set downmix policy so a fresh swDecoder
    // (e.g. an audio-track switch) doesn't snap back to stereo while
    // the renderer is still wired for multi-channel output.
    this.swDecoder.setDownmix(this._downmix);
    this.swDecoder.setOnData((frame) => {
      if (this.onPCM) this.onPCM(frame);
      else this.pendingPCM.push(frame);
    });
    this.swDecoder.setOnError((e) => {
      Logger.error(TAG, "Software decoder error", e);
      if (this.onError) this.onError(e);
    });

    const success = await this.swDecoder.configure(this.currentTrack);
    if (success) {
      this.isConfigured = true;

      // Process pending chunks
      if (this.pendingChunks.length > 0) {
        const chunks = [...this.pendingChunks];
        this.pendingChunks = [];
        for (const chunk of chunks) {
          this.decode(chunk.data, chunk.timestamp, chunk.keyframe);
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Decode an encoded audio chunk
   */
  decode(data: Uint8Array, timestamp: number, keyframe: boolean): void {
    if (!this.isConfigured) {
      this.pendingChunks.push({ data, timestamp, keyframe });
      return;
    }
    if (!this.swDecoder) {
      Logger.warn(TAG, "Software decoder not configured");
      return;
    }
    this.swDecoder.decode(data, timestamp, keyframe);
  }

  /**
   * Set PCM frame output callback (the software decoder path is the
   * only path now; setOnData / WebCodecs AudioData hand-off is gone).
   */
  setOnPCM(callback: (frame: PCMFrame) => void): void {
    this.onPCM = callback;

    while (this.pendingPCM.length > 0) {
      const frame = this.pendingPCM.shift()!;
      callback(frame);
    }
  }

  /**
   * Set error callback
   */
  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  /**
   * Flush the decoder
   */
  async flush(): Promise<void> {
    if (!this.decoder) return;

    try {
      await this.decoder.flush();
    } catch (error) {
      Logger.error(TAG, "Flush error", error);
    }
  }

  /**
   * Reset the decoder
   */
  reset(): void {
    if (this.decoder) {
      try {
        this.decoder.reset();
      } catch (error) {
        Logger.error(TAG, "Reset error", error);
      }
    }
    this.pendingPCM = [];
  }

  /**
   * Close the decoder
   */
  close(): void {
    this.reset();

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (error) {
        // Ignore close errors
      }
      this.decoder = null;
    }

    this.isConfigured = false;
    this.onPCM = null;
    this.onError = null;

    Logger.debug(TAG, "Closed");
  }

  /**
   * Check if decoder is configured
   */
  get configured(): boolean {
    return this.isConfigured;
  }

  /**
   * Get queue size
   */
  get queueSize(): number {
    // Note: swDecoder is currently synchronous so its queue is effectively 0
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /**
   * Get decoder stats for nerd stats overlay
   */
  getStats(): { decoderType: string; queueSize: number } {
    return {
      decoderType: this.useSoftware ? "Software (FFmpeg)" : "Hardware (WebCodecs)",
      queueSize: this.queueSize,
    };
  }

}
