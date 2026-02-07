/**
 * VideoDecoder - WebCodecs-based video decoder
 */

import type { VideoTrack, VideoDecoderConfig } from "../types";
import { Logger } from "../utils/Logger";
import { SoftwareVideoDecoder } from "./SoftwareVideoDecoder";
import { WasmBindings } from "../wasm/bindings";

import { CodecParser } from "./CodecParser";

const TAG = "VideoDecoder";

export class MoviVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private swDecoder: SoftwareVideoDecoder | null = null;
  private bindings: WasmBindings | null = null;
  private useSoftware: boolean = false;

  private pendingFrames: VideoFrame[] = [];
  private pendingChunks: Array<{
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
  }> = [];
  // ... (fields same) ...
  private isConfigured: boolean = false;
  private onFrame: ((frame: VideoFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private waitingForKeyframe: boolean = false;
  private errorCount: number = 0;
  private static MAX_ERRORS = 5; // Max consecutive errors before giving up
  private lastConfig: VideoDecoderConfig | null = null;
  private currentProfile: number | undefined;
  private currentTrack: VideoTrack | null = null;
  private lastErrorTime: number = 0;
  private openGopErrorCount: number = 0;
  private hardwareRetryCount: number = 0;
  private lastHardwareRetryTime: number = 0;
  private isResurrecting: boolean = false;
  private forceSoftware: boolean = false;
  private targetFps: number = 0;

  constructor(forceSoftware: boolean = false) {
    this.forceSoftware = forceSoftware;
    Logger.debug(TAG, `Created (forceSoftware: ${forceSoftware})`);
  }

  setBindings(bindings: WasmBindings) {
    this.bindings = bindings;
  }

  /**
   * Configure the decoder for a specific track
   */
  async configure(
    track: VideoTrack,
    extradata?: Uint8Array,
    targetFps: number = 0,
  ): Promise<boolean> {
    this.currentTrack = track;
    this.targetFps = targetFps;
    this.currentProfile = track.profile;

    // Reset fallback state on new configuration
    this.useSoftware = false;
    this.openGopErrorCount = 0;
    this.hardwareRetryCount = 0;
    this.lastHardwareRetryTime = 0;
    if (this.swDecoder) {
      this.swDecoder.close();
      this.swDecoder = null;
    }

    // If forceSoftware is enabled, skip WebCodecs and use WASM software decoder
    if (this.forceSoftware) {
      Logger.info(TAG, "Force software decoding enabled, using WASM decoder");
      this.useSoftware = true;
      return this.initSoftwareDecoder();
    }

    if (!("VideoDecoder" in window)) {
      Logger.error(TAG, "WebCodecs VideoDecoder not supported");
      return false;
    }

    // Use codec string from CodecParser if extradata is available
    let codecString = CodecParser.getCodecString(track.codec, track.extradata);

    // Fallback if parser returns null or empty
    if (!codecString) {
      Logger.debug(
        TAG,
        "CodecParser returned null, falling back to manual mapping",
      );
      codecString = this.mapCodecToWebCodecs(
        track.codec,
        track.width,
        track.height,
        track.profile,
        track.level,
      );
    }

    // const codecString = this.mapCodecToWebCodecs(track.codec, track.width, track.height, track.profile, track.level);
    if (!codecString) {
      Logger.error(TAG, `Unsupported codec: ${track.codec}`);
      return false;
    }

    // Build config object
    const config: VideoDecoderConfig = {
      codec: codecString,
      codedWidth: track.width,
      codedHeight: track.height,
    };

    // Add color space if available
    if (track.colorPrimaries || track.colorTransfer || track.colorSpace) {
      config.colorSpace = {
        primaries: track.colorPrimaries as VideoColorPrimaries,
        transfer: track.colorTransfer as VideoTransferCharacteristics,
        matrix: track.colorSpace as VideoMatrixCoefficients,
      };
      Logger.info(
        TAG,
        `Decoder color space: primaries=${track.colorPrimaries}, transfer=${track.colorTransfer}, matrix=${track.colorSpace}`,
      );
    }

    // Add description (extradata) if available - required for some codecs
    let description = extradata || track.extradata;

    // Check if description is Annex B (starts with 00 00 01 or 00 00 00 01)
    if (description && description.length > 4) {
      const isAnnexB =
        (description[0] === 0 &&
          description[1] === 0 &&
          description[2] === 1) ||
        (description[0] === 0 &&
          description[1] === 0 &&
          description[2] === 0 &&
          description[3] === 1);

      if (isAnnexB) {
        Logger.warn(
          TAG,
          "Extradata appears to be Annex B (NAL units). WebCodecs hvc1/avc1 requires MP4 box format (hvcC/avcC). Stripping extradata from config to avoid initialization error.",
        );
        description = undefined; // Do not pass invalid description
      }
    }

    if (description && description.length > 0) {
      config.description = description;
    }

    // Check if codec is supported
    try {
      let support: VideoDecoderSupport;
      try {
        support = await VideoDecoder.isConfigSupported(config);
      } catch (e) {
        // If it throws (e.g. TypeError for invalid enum), treat as not supported
        // and let the color stripping logic below retry
        support = { supported: false, config: config };
      }

      // If failed and we have color space info, try removing it as it might be causing validation issues
      // while the codec itself is supported. The decoder often detects color space from bitstream anyway.
      if (!support.supported && config.colorSpace) {
        Logger.info(
          TAG,
          `Codec config failed with color space. Retrying without explicit color metadata.`,
        );
        const configNoColor = { ...config };
        delete configNoColor.colorSpace;

        const supportNoColor =
          await VideoDecoder.isConfigSupported(configNoColor);
        if (supportNoColor.supported) {
          Logger.info(
            TAG,
            `Codec supported WITHOUT explicit color metadata. Using stripped config.`,
          );
          // Use the config without color space for the decoder,
          // but 'track' still has the info for the renderer to use!
          delete config.colorSpace;
          support = supportNoColor;
        }
      }

      if (!support.supported) {
        Logger.warn(TAG, `Codec config not supported: ${config.codec}`);

        // Try fallback to manual mapping if generic/parser string failed
        // This handles cases where the container/extradata specifies a very high/specific profile (e.g. H153)
        // that the browser rejects, but a generic compatible profile (L93) might work.

        // Special strict fallback for HEVC Rext (Profile 4) based on user report
        if (codecString && codecString.startsWith("hvc1.4")) {
          const rextFallback = "hvc1.4.10.L93.B0";
          if (codecString !== rextFallback) {
            Logger.info(
              TAG,
              `HEVC Rext detected. Retrying with compatible fallback string: ${rextFallback}`,
            );
            const rextConfig = { ...config, codec: rextFallback };
            if (rextConfig.colorSpace) delete rextConfig.colorSpace; // Also strip color for fallback

            const rextSupport =
              await VideoDecoder.isConfigSupported(rextConfig);
            if (rextSupport.supported) {
              Logger.info(
                TAG,
                `HEVC Rext fallback string IS supported. Switching to ${rextFallback}`,
              );
              config.codec = rextFallback;
              if (config.colorSpace) delete config.colorSpace;
              codecString = rextFallback;
              support = rextSupport;
            }
          }
        }

        const manualCodec = this.mapCodecToWebCodecs(
          track.codec,
          track.width,
          track.height,
          track.profile,
          track.level,
        );

        if (manualCodec && manualCodec !== codecString) {
          Logger.info(TAG, `Retrying with manual codec string: ${manualCodec}`);
          const manualConfig = { ...config, codec: manualCodec };
          if (manualConfig.colorSpace) delete manualConfig.colorSpace; // Also strip color for fallback

          const manualSupport =
            await VideoDecoder.isConfigSupported(manualConfig);

          if (manualSupport.supported) {
            Logger.info(
              TAG,
              `Manual codec string IS supported. Using ${manualCodec} instead of ${codecString}`,
            );
            config.codec = manualCodec;
            if (config.colorSpace) delete config.colorSpace;
            codecString = manualCodec;
            support = manualSupport;
          }
        }

        if (!support.supported) {
          Logger.warn(
            TAG,
            `Codec not supported by hardware: ${codecString}. Trying software.`,
          );
          return this.initSoftwareDecoder();
        }
      }
    } catch (error) {
      Logger.warn(TAG, `Codec config check failed: ${codecString}`, error);

      // Retry without color space on error
      if (config.colorSpace) {
        try {
          Logger.info(
            TAG,
            "Retrying config check without color space after error",
          );
          delete config.colorSpace;
          const support = await VideoDecoder.isConfigSupported(config);
          if (support.supported) {
            Logger.info(
              TAG,
              "Codec check passed after removing color space. Proceeding.",
            );
            // Continue to creation
          } else {
            return this.initSoftwareDecoder();
          }
        } catch (e) {
          return this.initSoftwareDecoder();
        }
      } else {
        // Fallback to software?
        return this.initSoftwareDecoder();
      }
    }

    // Create decoder
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.openGopErrorCount = 0;
        this.errorCount = 0;
        this.isResurrecting = false; // Success!
        if (this.onFrame) {
          this.onFrame(frame);
        } else {
          this.pendingFrames.push(frame);
        }
      },
      error: (error) => {
        Logger.error(TAG, "Decoder error", error);
        // Try to recover by recovering
        this.recoverFromError(error);
      },
    });

    // Configure decoder (reuse config from isConfigSupported check)
    this.lastConfig = config;
    try {
      this.decoder.configure(config);
      this.isConfigured = true;
      Logger.info(
        TAG,
        `Configured: ${codecString} ${track.width}x${track.height}`,
      );
      return true;
    } catch (error) {
      Logger.error(TAG, "Failed to configure decoder", error);
      return this.initSoftwareDecoder();
    }
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

    // Close HW
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (e) {}
      this.decoder = null;
    }

    this.swDecoder = new SoftwareVideoDecoder(this.bindings);
    this.swDecoder.setOnFrame((frame) => {
      if (this.onFrame) this.onFrame(frame);
      else {
        this.pendingFrames.push(frame);
      }
    });
    this.swDecoder.setOnError((e) => {
      Logger.error(TAG, "Software decoder error", e);
      if (this.onError) this.onError(e);
    });

    const success = await this.swDecoder.configure(
      this.currentTrack,
      this.targetFps,
    );
    if (success) {
      this.isConfigured = true;
      this.waitingForKeyframe = true; // Wait for keyframe on new decoder

      // Process pending chunks
      if (this.pendingChunks.length > 0) {
        Logger.info(
          TAG,
          `Processing ${this.pendingChunks.length} pending chunks for software decoder`,
        );
        const chunks = [...this.pendingChunks];
        this.pendingChunks = []; // Clear first to avoid duplicates if decode requeues

        for (const chunk of chunks) {
          this.decode(chunk.data, chunk.timestamp, chunk.keyframe);
        }
      }

      return true;
    }
    return false;
  }

  /**
   * Recreate the decoder after a fatal error
   */
  private recreateDecoder(): boolean {
    if (this.useSoftware) return false;
    if (!this.lastConfig) return false;

    Logger.warn(TAG, "Recreating decoder to recover from error");

    // Close existing
    try {
      this.decoder?.close();
    } catch (e) {}

    // Create new
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.openGopErrorCount = 0;
        this.errorCount = 0;
        this.isResurrecting = false; // Success!
        if (this.onFrame) {
          this.onFrame(frame);
        } else {
          this.pendingFrames.push(frame);
        }
      },
      error: (error) => {
        Logger.error(TAG, "Decoder error", error);
        // Try to recover by recreating
        this.recoverFromError(error);
      },
    });

    // Configure
    try {
      this.decoder.configure(this.lastConfig);
      this.isConfigured = true;
      // Reset waiting for keyframe to ensure we resync
      this.waitingForKeyframe = true;
      return true;
    } catch (error) {
      Logger.error(TAG, "Failed to recreate decoder", error);
      return false;
    }
  }

  private lastChunkInfo: {
    timestamp: number;
    keyframe: boolean;
    size: number;
  } | null = null;

  /**
   * Decode an encoded video chunk
   */
  decode(
    data: Uint8Array,
    timestamp: number,
    keyframe: boolean,
    dts?: number,
  ): void {
    this.lastChunkInfo = { timestamp, keyframe, size: data.byteLength };

    if (!this.isConfigured) return;

    if (this.useSoftware && this.swDecoder) {
      // RESURRECTION LOGIC: Periodically try to switch back to hardware only on a TRUE IDR keyframe
      // DISABLED if software is explicitly forced
      if (keyframe && !this.forceSoftware && this.shouldRetryHardware(data)) {
        Logger.info(
          TAG,
          `Found a sync frame! Attempting hardware resurrection (Attempt ${this.hardwareRetryCount + 1})...`,
        );
        this.lastHardwareRetryTime = performance.now();
        this.hardwareRetryCount++;

        // Temporarily switch back to HW path
        this.useSoftware = false;
        this.openGopErrorCount = 0;
        this.isResurrecting = true;

        if (!this.recreateDecoder()) {
          // If HW recreation failed immediately, go back to safety of software
          this.useSoftware = true;
          this.isResurrecting = false;
        } else {
          // Try decoding this chunk with hardware.
          // If it fails, recoverFromError will trigger software fallback again.
        }
      }

      if (this.useSoftware) {
        // Software decoder logic...
        if (!this.swDecoder.configured) {
          this.pendingChunks.push({ data, timestamp, keyframe });
          return;
        }

        // Strict keyframe check for software decoder too!
        if (this.waitingForKeyframe && !keyframe) {
          return;
        }
        if (keyframe) {
          this.waitingForKeyframe = false;
        }

        this.swDecoder.decode(data, timestamp, dts ?? timestamp, keyframe);
        return;
      }
    }

    if (!this.decoder) {
      return; // Silently skip when not configured
    }

    // Check if decoder is in a valid state
    if (this.decoder.state === "closed") {
      // Try to recover if closed unexpectedly
      this.recoverFromError(new Error("Decoder closed unexpectedly"));
      return;
    }

    // If we're waiting for keyframe after an error, skip non-keyframes
    if (this.waitingForKeyframe && !keyframe) {
      return;
    }

    // Got a keyframe, reset recovery state
    if (keyframe) {
      this.waitingForKeyframe = false;
    }

    // Check if we've exceeded max errors
    if (this.errorCount >= MoviVideoDecoder.MAX_ERRORS) {
      return; // Give up after too many errors
    }

    const chunk = new EncodedVideoChunk({
      type: keyframe ? "key" : "delta",
      timestamp: timestamp * 1_000_000, // Convert to microseconds
      data: data,
    });

    try {
      this.decoder.decode(chunk);
    } catch (error) {
      // Use shared recovery logic
      this.recoverFromError(error as Error);

      // Handle fallback to software immediately for this chunk
      if (this.useSoftware) {
        Logger.warn(
          TAG,
          "Hardware decode failed, queuing chunk for software decoder",
        );
        this.pendingChunks.push({ data, timestamp, keyframe });
      }
    }
  }

  private recoverFromError(error: Error) {
    const isKeyFrameError =
      error.message &&
      (error.message.includes("wasn't a key frame") ||
        error.message.includes("key frame is required"));

    // Check time since last error to distinguish between sporadic and continuous errors
    // BUT IGNORE Open GOP errors for count increment
    const now = performance.now();

    if (!isKeyFrameError) {
      // Use 30 second window. If errors happen more frequently than once every 30s, they accumulate.
      // If we have > 30s of clean playback, we reset to 1.
      if (now - this.lastErrorTime > 30000) {
        this.errorCount = 1;
      } else {
        this.errorCount++;
      }
      this.lastErrorTime = now;
    }

    // Detailed Debug Logging
    const errorInfo = {
      message: error.message,
      name: error.name,
      lastChunk: this.lastChunkInfo,
      queueSize: this.decoder?.decodeQueueSize,
      state: this.decoder?.state,
      codec: this.lastConfig?.codec,
      errorCount: this.errorCount,
      isUnsupportedProfile: false,
    };

    if (isKeyFrameError) {
      // If we were just trying to switch back to hardware, and it failed on frame 1,
      // then don't even bother with the retry cycle. Just go back to software.
      if (this.isResurrecting) {
        Logger.warn(
          TAG,
          "Hardware resurrection failed on sync frame. Returning to software decoder.",
        );
        this.isResurrecting = false;
        this.initSoftwareDecoder();
        return;
      }

      this.openGopErrorCount++;
      Logger.warn(
        TAG,
        `Decoding warning: Frame was marked as keyframe but decoder rejected it (Open GOP?). Timestamp: ${this.lastChunkInfo?.timestamp}. Count (OpenGOP): ${this.openGopErrorCount}`,
      );

      // If we keep hitting these, hardware decoder is too strict. Fallback to software.
      if (this.openGopErrorCount > 15) {
        Logger.error(
          TAG,
          "Persistent Open GOP errors detected. Switching to software decoder.",
        );
        this.initSoftwareDecoder();
        return;
      }

      // CRITICAL FIX: We MUST reset the decoder to clear the error state even for Open GOP warnings.
      // If we don't reset, the VideoDecoder remains in an errored state and rejects all subsequent chunks.
      if (this.decoder && this.decoder.state !== "closed") {
        try {
          this.decoder.reset();
          this.decoder.configure(this.lastConfig!);
          this.waitingForKeyframe = true;
          return;
        } catch (e) {
          Logger.warn(
            TAG,
            "Fast reset failed during Open GOP recovery, proceeding to full recreation",
          );
        }
      }
    } else {
      Logger.error(
        TAG,
        `Decoding error details: ${JSON.stringify(errorInfo)}. Count: ${this.errorCount}`,
      );
    }

    if (this.errorCount >= MoviVideoDecoder.MAX_ERRORS) {
      Logger.error(
        TAG,
        `Max errors (${MoviVideoDecoder.MAX_ERRORS}) exceeded within short duration. Emitting fatal error.`,
      );
      if (this.onError) this.onError(error);
      return;
    }

    // Treat error as fatal if using HEVC Rext profile (4) which is often unsupported
    // But per user request, we DO NOT switch to software mid-stream.
    // We will attempt to reset/reconfigure the hardware decoder instead.
    if (
      this.currentProfile === 4 &&
      this.lastConfig?.codec.startsWith("hvc1.4.")
    ) {
      Logger.warn(TAG, "HEVC Rext profile error.");

      const fallbackStr = "hvc1.4.10.L93.B0";
      // If we aren't already using the fallback string, try switching to it
      if (this.lastConfig.codec !== fallbackStr) {
        Logger.info(
          TAG,
          `Attempting recovery by switching to compatible fallback string: ${fallbackStr}`,
        );

        this.lastConfig.codec = fallbackStr;

        // CRITICAL: Patch extradata (description) to match the fallback profile (Main10) to avoid profile mismatch errors.
        // Browser decoder might cross-check codec string vs extradata headers.
        // By changing Profile IDC in extradata from 4 (Rext) to 2 (Main 10), we align them.
        if (
          this.lastConfig.description &&
          this.lastConfig.description.length > 5
        ) {
          const patched = new Uint8Array(this.lastConfig.description);
          // hvcC header:
          // Byte 0: Configuration Version
          // Byte 1: ProfileIndication (Space(2) + Tier(1) + ProfileIdc(5))
          // Mask out profile (0x1F) and set to 2 (Main 10)
          const originalProfile = patched[1] & 0x1f;
          if (originalProfile === 4) {
            // Only patch if it is Rext
            patched[1] = (patched[1] & 0xe0) | 2;
            Logger.warn(
              TAG,
              `Patched HEVC extradata: Spoofed Profile IDC from ${originalProfile} to 2 (Main 10) to bypass strict hardware checks.`,
            );
            this.lastConfig.description = patched;
          }
        }

        this.openGopErrorCount = 0; // Added as per instruction
        // Reconfigure with new string
        try {
          if (this.decoder && this.decoder.state !== "closed") {
            this.decoder.configure(this.lastConfig);
            this.waitingForKeyframe = true;
            this.errorCount = 0; // Reset error count as we are trying a new config/hack
            return;
          } else {
            // Decoder closed, try full recreate with new config
            if (this.recreateDecoder()) {
              this.errorCount = 0;
              return;
            }
          }
        } catch (e) {
          Logger.error(TAG, "Fallback configuration failed", e);
        }
      } else {
        Logger.warn(
          TAG,
          "HEVC Rext fallback string also failed. Attempting reset/recreation.",
        );
      }
    }

    // FAST RECOVERY: Try reset() first if decoder is not closed
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        Logger.warn(TAG, "Attempting fast reset recovery");
        this.decoder.reset();
        this.decoder.configure(this.lastConfig!);
        this.waitingForKeyframe = true;
        return;
      } catch (e) {
        Logger.warn(TAG, "Fast reset failed, trying full recreation");
      }
    }

    // FULL RECOVERY: Recreate decoder
    this.recreateDecoder();
  }

  /**
   * Map FFmpeg codec names to WebCodecs codec strings
   */
  private mapCodecToWebCodecs(
    codec: string,
    _width: number,
    _height: number,
    profile?: number,
    _level?: number,
  ): string | null {
    const codecLower = codec.toLowerCase();

    // H.264 / AVC
    if (codecLower === "h264" || codecLower === "avc1") {
      // Use a common profile/level - will be overridden by extradata
      return "avc1.640028"; // High profile, level 4.0
    }

    // H.265 / HEVC
    if (
      codecLower === "hevc" ||
      codecLower === "h265" ||
      codecLower === "hvc1"
    ) {
      // Handle HEVC profiles
      if (profile === 4) {
        // FF_PROFILE_HEVC_REXT
        Logger.info(
          TAG,
          "Detected HEVC Rext profile. Trying compatible Main10 string map.",
        );
        return "hvc1.4.10.L93.B0";
      }

      // Main 10 Profile (Profile 2)
      if (profile === 2) {
        // If level is provided use it, otherwise default to Level 5.1 (153) for 4K support
        // Note: WebCodecs is picky about level matching the content.
        // L153 = 5.1, supports up to 4K@60
        // L120 = 4.0, supports up to 1080p@30 / 4K@bad
        const levelStr = _level ? `L${_level}` : "L153";
        Logger.info(
          TAG,
          `Mapping HEVC Main 10 profile (2) to hvc1.2.4.${levelStr}.B0`,
        );
        return `hvc1.2.4.${levelStr}.B0`;
      }

      // Main Profile (Profile 1)
      if (profile === 1) {
        const levelStr = _level ? `L${_level}` : "L120"; // Default to 4.0
        return `hvc1.1.6.${levelStr}.B0`;
      }

      // Default fallback
      return "hvc1.1.6.L93.B0"; // Main profile, Level 3.1
    }

    // VP8
    if (codecLower === "vp8") {
      return "vp8";
    }

    // VP9
    if (codecLower === "vp9") {
      // Handle Profile 2 (10-bit / HDR)
      if (profile === 2) {
        // vp09.profile.level.bitDepth.chroma.primaries.transfer.matrix.range
        // Profile 2, Level 5.1 (51), 10-bit (10), 4:2:0 (01)
        // Color: BT.2020 (09), PQ (16), BT.2020nc (09), TV Range (00)
        // Note: Browser might override color based on bitstream, but setting 10-bit profile is critical.
        Logger.info(
          TAG,
          "Mapping VP9 Profile 2 to vp09.02.51.10.01.09.16.09.00 (HDR)",
        );
        return "vp09.02.51.10.01.09.16.09.00";
      }

      // Handle Profile 3 (10/12-bit 4:2:2 / HDR) - Rare but possible
      if (profile === 3) {
        return "vp09.03.51.10.01.09.16.09.00";
      }

      // Generic fallback: Profile 0, Level 4.1, 8-bit, 4:2:0
      return "vp09.00.41.08.01.01.01.01.00";
    }

    // AV1
    if (codecLower === "av1") {
      return "av01.0.01M.08"; // Main profile, level 2.1, 8-bit
    }

    // H.263 (legacy codec - browser support varies)
    if (codecLower === "h263" || codecLower === "h263p") {
      return "h263"; // May not be supported by most browsers
    }

    // MPEG-4 Part 2 (legacy)
    if (codecLower === "mpeg4" || codecLower === "mp4v") {
      return "mp4v.20.9"; // Simple profile
    }

    return null;
  }

  /**
   * Set frame output callback
   */
  setOnFrame(callback: (frame: VideoFrame) => void): void {
    this.onFrame = callback;

    if (this.swDecoder) {
      this.swDecoder.setOnFrame(callback);
    }

    // Flush any pending frames
    while (this.pendingFrames.length > 0) {
      const frame = this.pendingFrames.shift()!;
      callback(frame);
    }
  }

  /**
   * Set error callback
   */
  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
    if (this.swDecoder) {
      this.swDecoder.setOnError(callback);
    }
  }

  /**
   * Flush the decoder
   */
  async flush(): Promise<void> {
    this.openGopErrorCount = 0;
    this.pendingChunks = []; // Clear pending inputs
    if (this.swDecoder) {
      return this.swDecoder.flush();
    }
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
    this.openGopErrorCount = 0;
    if (this.swDecoder) {
      this.swDecoder.reset();
    }
    if (this.decoder) {
      try {
        this.decoder.reset();
      } catch (error) {
        Logger.error(TAG, "Reset error", error);
      }
    }

    // Close pending frames
    for (const frame of this.pendingFrames) {
      frame.close();
    }
    this.pendingFrames = [];
    this.pendingChunks = [];
  }

  /**
   * Close the decoder
   */
  close(): void {
    this.reset();

    if (this.swDecoder) {
      this.swDecoder.close();
      this.swDecoder = null;
    }

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (error) {
        // Ignore close errors
      }
      this.decoder = null;
    }

    this.isConfigured = false;
    this.onFrame = null;
    this.onError = null;
    this.useSoftware = false;

    Logger.debug(TAG, "Closed");
  }
  /**
   * Check if decoder is configured
   */
  get configured(): boolean {
    return this.isConfigured;
  }

  /**
   * Helper to check if we should try switching back to hardware
   */
  private shouldRetryHardware(data: Uint8Array): boolean {
    if (!this.useSoftware || !this.currentTrack) return false;

    // Safety: Don't retry too many times if it keeps failing
    if (this.hardwareRetryCount >= 10) return false;

    // CRITICAL: Only retry hardware if this keyframe is actually an IDR/Sync frame.
    // Hardware decoders will reject non-IDR keyframes as start points after a seek/flush.
    if (!this.isLikelySyncFrame(data)) {
      return false;
    }

    const now = performance.now();
    // Cooldown logic: First retry after 10s, subsequent every 30s
    const cooldown = this.hardwareRetryCount === 0 ? 10000 : 30000;

    return now - this.lastHardwareRetryTime > cooldown;
  }

  /**
   * Bitwise NAL unit inspection to detect true Sync/IDR frames
   */
  private isLikelySyncFrame(data: Uint8Array): boolean {
    if (!this.lastConfig) return true;
    const codec = this.lastConfig.codec.toLowerCase();

    try {
      let headerPos = -1;
      // Search for NAL start code (0001 or 001) or assume AVCC 4-byte size
      if (data[0] === 0 && data[1] === 0 && data[2] === 1) headerPos = 3;
      else if (data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1)
        headerPos = 4;
      else if (data.length > 4) headerPos = 4; // Most MP4/MKV hardware chunks are AVCC

      if (headerPos === -1 || headerPos >= data.length) return false;

      const header = data[headerPos];

      // H.264 (AVC)
      if (codec.includes("avc1") || codec.includes("h264")) {
        const type = header & 0x1f;
        return type === 5; // IDR Slice
      }

      // H.265 (HEVC)
      if (
        codec.includes("hvc1") ||
        codec.includes("hev1") ||
        codec.includes("h265")
      ) {
        const type = (header >> 1) & 0x3f;
        // Types 16-21 are IRAP (Intra Random Access Point)
        // 19/20 are IDR, 21 is CRA (Clean Random Access)
        return type >= 16 && type <= 21;
      }
    } catch (e) {}

    return true; // Default to true if parsing fails or codec unknown
  }

  /**
   * Get queue size
   */
  get queueSize(): number {
    return (
      (this.swDecoder?.queueSize ?? 0) + (this.decoder?.decodeQueueSize ?? 0)
    );
  }

  /**
   * Check if software decoder is being used
   */
  get isSoftware(): boolean {
    return this.useSoftware;
  }
}
