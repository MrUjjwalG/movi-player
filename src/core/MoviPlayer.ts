/**
 * MoviPlayer - Main public API for the streaming video library
 */

import type {
  PlayerConfig,
  SourceConfig,
  Track,
  PlayerState,
  PlayerEventMap,
  MediaInfo,
  VideoTrack,
  AudioTrack,
  SubtitleTrack,
} from "../types";
import { EventEmitter } from "../events/EventEmitter";
import {
  HttpSource,
  FileSource,
  ThumbnailHttpSource,
  type SourceAdapter,
} from "../source";
import { LRUCache } from "../cache";
import { Demuxer } from "../demux";
import { TrackManager } from "./TrackManager";
import { Clock } from "./Clock";
import { PlayerStateManager } from "./PlayerState";
import { Logger, LogLevel } from "../utils/Logger";
import { MoviVideoDecoder } from "../decode/VideoDecoder";
import { MoviAudioDecoder } from "../decode/AudioDecoder";
import { SubtitleDecoder } from "../decode/SubtitleDecoder";
import { CanvasRenderer } from "../render/CanvasRenderer";
import { AudioRenderer } from "../render/AudioRenderer";
import { updateAllBindingsLogLevel, ThumbnailBindings } from "../wasm/bindings";
import { loadWasmModuleNew } from "../wasm/FFmpegLoader";
import { HLSPlayerWrapper } from "../render/HLSPlayerWrapper";
import { ThumbnailRenderer } from "../utils/ThumbnailRenderer";

const TAG = "MoviPlayer";

export class MoviPlayer extends EventEmitter<PlayerEventMap> {
  private config: PlayerConfig;
  private source: SourceAdapter | null = null;
  private cache: LRUCache;
  private demuxer: Demuxer | null = null;
  public trackManager: TrackManager;
  private clock: Clock;
  private stateManager: PlayerStateManager;
  private mediaInfo: MediaInfo | null = null;
  private fileSize: number = -1; // Cached file size for buffer calculations

  // Decoders and Renderers
  private videoDecoder: MoviVideoDecoder;
  private audioDecoder: MoviAudioDecoder;
  private subtitleDecoder: SubtitleDecoder | null = null;
  private videoRenderer: CanvasRenderer | null = null;

  // HLS Wrapper
  private hlsWrapper: HLSPlayerWrapper | null = null;

  // Preview pipeline (C-based FFmpeg software decoding)
  private thumbnailBindings: ThumbnailBindings | null = null;
  private thumbnailSource: SourceAdapter | null = null;
  private thumbnailRenderer: ThumbnailRenderer | null = null;
  private thumbnailHDREnabled: boolean = true; // HDR enabled by default
  private isPreviewGenerating: boolean = false;
  private audioRenderer: AudioRenderer;
  private previewInitPromise: Promise<void> | null = null; // Guard for preview initialization

  // Debug flag to disable audio processing
  private disableAudio: boolean = false; // Set to true to disable audio for debugging
  private muted: boolean = false; // Mute state
  private wasPlayingBeforeRebuffer: boolean = false; // Track if we were playing before entering rebuffering state

  // Playback Loop
  private animationFrameId: number | null = null;

  // WakeLock to prevent screen sleep during playback
  private wakeLock: WakeLockSentinel | null = null;

  // Seek state - track if we need to skip to keyframe after seek
  private seekingToKeyframe: boolean = false;
  private seekingToKeyframeStartTime: number = 0;
  private static readonly KEYFRAME_SEEK_TIMEOUT = 5000; // 5 seconds timeout

  // Seek target time - skip packets before this time to ensure accurate seeking
  // When seeking, FFmpeg seeks to the nearest keyframe BEFORE the target time
  // We need to decode but not display/play packets before the target time
  private seekTargetTime: number = -1;

  // Buffer audio packets while waiting for video to catch up after seek
  private waitingForVideoSync: boolean = false;
  private pendingAudioPackets: Array<{
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
  }> = [];

  // Post-seek throttling to prevent stuttering on low-end devices
  private justSeeked: boolean = false;
  private seekTime: number = 0;
  private startTime: number = 0; // Media start time (PTS offset)
  private static readonly POST_SEEK_THROTTLE_MS = 1000; // Throttle aggressive buffering for 1000ms after seek to stabilize playback

  constructor(config: PlayerConfig) {
    super();

    this.config = config;
    this.cache = new LRUCache(config.cache?.maxSizeMB ?? 100);
    this.trackManager = new TrackManager();
    this.clock = new Clock();
    this.stateManager = new PlayerStateManager();

    // Disable FFmpeg logs by default
    updateAllBindingsLogLevel(LogLevel.SILENT);

    // Initialize components
    this.audioDecoder = new MoviAudioDecoder();
    this.audioRenderer = new AudioRenderer();
    this.subtitleDecoder = new SubtitleDecoder();

    // Initialize video renderer with canvas (WebCodecs)
    // Note: MSE mode is handled by MSEPlayerWrapper
    // Check if software decoding is forced via config
    const forceSoftware = config.decoder === "software";

    if (config.canvas || config.renderer === "canvas") {
      if (config.canvas) {
        // Use canvas with WebCodecs (or WASM software if forced)
        this.videoDecoder = new MoviVideoDecoder(forceSoftware);
        this.videoRenderer = new CanvasRenderer(config.canvas);

        // Connect video renderer to audio clock for A/V sync (skip if audio disabled)
        if (!this.disableAudio) {
          this.videoRenderer.setAudioTimeProvider(
            () => this.audioRenderer.getAudioClock(),
            () => this.audioRenderer.hasHealthyBuffer(),
          );
        } else {
          // When audio is disabled, video runs independently without A/V sync overhead
          this.videoRenderer.setAudioTimeProvider(null, null);
          Logger.info(
            TAG,
            "Video renderer running independently (audio disabled)",
          );
        }

        Logger.info(
          TAG,
          `Video renderer initialized with canvas (forceSoftware: ${forceSoftware})`,
        );
      } else {
        Logger.warn(
          TAG,
          "Canvas renderer requested but no canvas element provided",
        );
        this.videoDecoder = new MoviVideoDecoder(forceSoftware);
      }
    } else {
      // Default to software decoding with WebCodecs (no target element)
      this.videoDecoder = new MoviVideoDecoder(forceSoftware);
      Logger.info(
        TAG,
        "Video renderer initialized with default (WebCodecs decoder only)",
      );
    }

    // Connect audio as the master clock provider (skip if audio disabled)
    if (!this.disableAudio) {
      this.clock.setAudioProvider(this.audioRenderer);
    } else {
      // When audio is disabled, clock runs independently without audio sync overhead
      this.clock.setAudioProvider(null);
      Logger.info(TAG, "Clock running independently (audio disabled)");
    }

    // Setup decoder outputs
    if (this.videoDecoder) {
      this.videoDecoder.setOnFrame((frame) => {
        // Queue frames for smooth presentation with A/V sync
        // Allow processing if playing OR if we are seeking (waiting for sync)
        if (
          this.videoRenderer &&
          (this.stateManager.getState() === "playing" ||
            this.waitingForVideoSync)
        ) {
          // IMPORTANT: Drop video frames before the seek target time
          // These frames are decoded to build decoder state (reference frames),
          // but we don't display them - we want accurate seeking to the target time
          const frameTime = frame.timestamp / 1_000_000; // Convert to seconds
          // CRITICAL: Check seekTargetTime !== -1 instead of >= 0 to support negative start times
          // Some media files have negative PTS offsets (e.g., startTime = -0.105s)
          if (this.seekTargetTime !== -1 && frameTime < this.seekTargetTime) {
            // Drop this frame, it's before our target time
            frame.close();
            return;
          }

          // Video reached target! Clear the flag to ensure sync and transition to final state
          if (this.seekTargetTime !== -1) {
            Logger.debug(TAG, `onFrame: frameTime=${frameTime.toFixed(3)}s >= seekTargetTime=${this.seekTargetTime.toFixed(3)}s, calling notifySeekCompletion`);
            this.notifySeekCompletion(frameTime);
          }

          this.videoRenderer.queueFrame(frame);
        } else {
          frame.close();
        }
      });

      this.videoDecoder.setOnError((error) => {
        Logger.error(TAG, "Video decoder error", error);
        this.emit("error", error);
        // Note: Decoder now has built-in recovery, only pauses after MAX_ERRORS
      });
    }

    this.audioDecoder.setOnData((data) => {
      // Direct render (buffers in AudioContext)
      this.audioRenderer.render(data);
    });

    this.audioDecoder.setOnError((error) => {
      Logger.error(TAG, "Audio decoder error", error);
      // Audio errors are less fatal - video can continue, just emit the error
      this.emit("error", error);
    });

    // Forward state changes
    this.stateManager.on("change", (state) => {
      this.emit("stateChange", state);
    });

    // Forward track changes
    // Listen for audio track changes and immediately reconfigure decoder
    this.trackManager.on("audioTrackChange", async (track) => {
      if (!track) {
        Logger.warn(TAG, "Audio track change event received but track is null");
        return;
      }

      Logger.info(
        TAG,
        `Audio track changed to track ${track.id}, reconfiguring decoder`,
      );

      // Close current audio decoder immediately
      if (this.audioDecoder) {
        this.audioDecoder.close();
      }

      // Recreate audio decoder for new track
      this.audioDecoder = new MoviAudioDecoder();

      // Set bindings
      if (this.demuxer) {
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          this.audioDecoder.setBindings(bindings);
        }
      }

      // Set up callbacks (match original setup)
      this.audioDecoder.setOnData((data) => {
        // Direct render (buffers in AudioContext)
        // AudioRenderer handles muted state internally
        this.audioRenderer.render(data);
      });

      this.audioDecoder.setOnError((error) => {
        Logger.error(TAG, "Audio decoder error", error);
        // Audio errors are less fatal - video can continue, just emit the error
        this.emit("error", error);
      });

      // Configure decoder for new track
      if (this.demuxer && !this.disableAudio) {
        const extradata = this.demuxer.getExtradata(track.id) ?? undefined;
        const configured = await this.audioDecoder.configure(track, extradata);
        if (configured) {
          Logger.info(
            TAG,
            `Audio decoder reconfigured for track ${track.id}: ${track.codec} ${track.sampleRate}Hz ${track.channels}ch`,
          );
        } else {
          Logger.warn(
            TAG,
            `Failed to reconfigure audio decoder for track ${track.id}`,
          );
        }
      }
    });

    this.trackManager.on("tracksChange", (tracks) => {
      this.emit("tracksChange", tracks);
    });

    Logger.info(TAG, "Player created");

    // Handle visibility changes to re-acquire WakeLock if lost
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  /**
   * Load the media file
   */
  async load(sourceConfig?: SourceConfig): Promise<void> {
    if (!this.stateManager.is("idle") && !sourceConfig) {
      throw new Error("Player must be idle to load");
    }

    if (sourceConfig) {
      this.config.source = sourceConfig;
      // If we were not idle, we should essentially reset/destroy previous state if reusing instance
      // But for now, let's assume usage pattern respects idle check or we force reset
      if (this.stateManager.getState() !== "idle") {
        // Reset internal state if reloading on same instance
        // Ideally calls destroy() -> new MoviPlayer() is better, but here we can try to soft-reset
      }
    }

    this.stateManager.setState("loading");
    this.emit("loadStart", undefined);

    // Clean up any existing preview pipeline
    this.destroyPreviewPipeline();

    // Check for HLS
    const src = this.config.source;
    if (
      src.type === "url" &&
      src.url &&
      (src.url.includes(".m3u8") || src.url.toLowerCase().endsWith("m3u8"))
    ) {
      Logger.info(TAG, "Detected HLS stream, switching to HLSPlayerWrapper");

      this.hlsWrapper = new HLSPlayerWrapper(this.config);

      // Proxy events
      const events = [
        "loadStart",
        "loadEnd",
        "play",
        "pause",
        "ended",
        "timeUpdate",
        "durationChange",
        "stateChange",
        "error",
        "buffering",
        "seeking",
        "seeked",
      ] as const;

      events.forEach((evt) => {
        // @ts-ignore
        this.hlsWrapper.on(evt, (arg) => this.emit(evt, arg));
      });

      // Special handling for tracks to integrate with TrackManager?
      // HLSWrapper has its own TrackManager. We might need to expose it or sync it.
      // For now, let's swap the trackManager so external API calls work naturally.
      // Sync tracks from HLS wrapper to main track manager
      this.hlsWrapper.trackManager.on("tracksChange", (tracks) => {
        this.trackManager.setTracks(tracks);
      });

      // Forward track selection from main track manager to HLS wrapper
      this.trackManager.on("videoTrackChange", (track) => {
        if (this.hlsWrapper) {
          this.hlsWrapper.selectVideoTrack(track ? track.id : -1);
        }
      });

      try {
        await this.hlsWrapper.load();
        this.stateManager.setState("ready"); // Sync local state manager just in case
        return;
      } catch (e) {
        this.stateManager.setState("error");
        throw e;
      }
    }

    try {
      // Create source
      this.source = await this.createSource(this.config.source);

      // Create demuxer (getSize will be called lazily in bindings.open())
      this.demuxer = new Demuxer(this.source, this.config.wasmBinary);

      // Open and get media info
      this.mediaInfo = await this.demuxer.open();

      // Cache file size for buffer calculations (getSize was called in bindings.open())
      this.fileSize = await this.source.getSize();

      const bindings = this.demuxer.getBindings();
      if (bindings) {
        this.videoDecoder.setBindings(bindings);
        this.audioDecoder.setBindings(bindings);
        if (this.subtitleDecoder) {
          this.subtitleDecoder.setBindings(bindings);
        }
      }

      // Set tracks
      this.trackManager.setTracks(this.mediaInfo.tracks);

      // Configure decoders for active tracks
      await this.configureDecoders();

      // Set duration on clock for clamping (prevents timer exceeding duration)
      // Clock operates in media time (PTS), so it runs from startTime to startTime + duration
      this.startTime = this.mediaInfo.startTime || 0;
      this.clock.setDuration(this.mediaInfo.duration + this.startTime);
      this.clock.seek(this.startTime);

      // Emit duration
      this.emit("durationChange", this.mediaInfo.duration);

      this.stateManager.setState("ready");
      this.emit("loadEnd", undefined);

      // Initialize preview pipeline in background (fire-and-forget)
      // Only if enabled in config to save memory
      if (this.config.enablePreviews) {
        // This makes the first preview faster since WASM is already loaded
        this.previewInitPromise = this.initPreviewPipeline().catch((e) => {
          Logger.warn(TAG, "Preview pipeline init failed (non-critical)", e);
          // Clear promise on error so we can retry later if needed
          this.previewInitPromise = null;
        });
      }

      Logger.info(
        TAG,
        `Loaded: duration=${this.mediaInfo.duration}s, tracks=${this.mediaInfo.tracks.length}`,
      );
    } catch (error) {
      this.stateManager.setState("error");
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Create source adapter from config
   */
  private async createSource(config: SourceConfig): Promise<SourceAdapter> {
    if (config.type === "file" && config.file) {
      return new FileSource(config.file, this.cache);
    }

    if (config.type === "url" && config.url) {
      const maxBufferSizeMB = this.config.cache?.maxSizeMB;
      const source = new HttpSource(
        config.url,
        config.headers,
        maxBufferSizeMB,
      );
      return source;
    }

    throw new Error("Invalid source configuration");
  }

  /**
   * Configure decoders for active tracks
   */
  private async configureDecoders(): Promise<void> {
    if (!this.demuxer) return;

    // Configure video renderer/decoder
    const videoTrack = this.trackManager.getActiveVideoTrack();
    if (videoTrack && this.videoDecoder) {
      // Use WebCodecs - configure decoder
      const extradata = this.demuxer.getExtradata(videoTrack.id) ?? undefined;

      // Pass explicit frame rate override if present (for throttling)
      const targetFps = this.config.frameRate ?? 0;

      const configured = await this.videoDecoder.configure(
        videoTrack,
        extradata,
        targetFps,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Video decoder configured: ${videoTrack.codec} ${videoTrack.width}x${videoTrack.height}`,
        );
        if (this.videoRenderer) {
          // Pass color space metadata for HDR detection and frame rate for 60fps conversion
          // Support manual frame rate override (fps parameter)
          const frameRate = this.config.frameRate || videoTrack.frameRate;

          this.videoRenderer.configure(
            videoTrack.width,
            videoTrack.height,
            videoTrack.colorPrimaries,
            videoTrack.colorTransfer,
            frameRate,
            videoTrack.rotation ?? 0,
            videoTrack.isHDR,
          );
        }
      } else {
        Logger.warn(TAG, "Failed to configure video decoder");
      }
    }

    // Configure audio decoder (skip if disabled for debugging)
    const audioTrack = this.trackManager.getActiveAudioTrack();
    if (audioTrack && !this.disableAudio) {
      const extradata = this.demuxer.getExtradata(audioTrack.id) ?? undefined;
      const configured = await this.audioDecoder.configure(
        audioTrack,
        extradata,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Audio decoder configured: ${audioTrack.codec} ${audioTrack.sampleRate}Hz ${audioTrack.channels}ch`,
        );
      } else {
        Logger.warn(TAG, "Failed to configure audio decoder");
      }
    } else if (audioTrack && this.disableAudio) {
      Logger.info(TAG, "Audio processing disabled for debugging");
    }

    // Configure subtitle decoder
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (subtitleTrack && this.subtitleDecoder) {
      const extradata =
        this.demuxer.getExtradata(subtitleTrack.id) ?? undefined;
      const configured = await this.subtitleDecoder.configure(
        subtitleTrack,
        extradata,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Subtitle decoder configured: ${subtitleTrack.codec} (${subtitleTrack.subtitleType || "unknown"} type)`,
        );

        // Set up subtitle cue callback
        this.subtitleDecoder.setOnCue((cue) => {
          Logger.debug(
            TAG,
            `Subtitle cue received: "${cue.text?.substring(0, 30)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
          );
          // Update subtitle cues on video renderer
          if (this.videoRenderer) {
            // Get current cues and add/update this one
            // For simplicity, we'll just set a single cue for now
            // In a full implementation, we'd maintain a cue list
            Logger.debug(TAG, "Setting subtitle cue on video renderer");
            this.videoRenderer.setSubtitleCues([cue]);
          } else {
            Logger.warn(
              TAG,
              "Subtitle cue received but videoRenderer is null!",
            );
          }
        });

        // Set bindings (should already be set in load(), but set again to be safe)
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          this.subtitleDecoder.setBindings(bindings, false); // Don't auto-configure, we're configuring manually
        }
      } else {
        Logger.warn(
          TAG,
          `Failed to configure subtitle decoder for track ${subtitleTrack.id} (${subtitleTrack.codec}) - subtitles will not be displayed`,
        );
      }
    }
  }

  /**
   * Start playback
   */
  async play(): Promise<void> {
    if (this.hlsWrapper) {
      return this.hlsWrapper.play();
    }

    if (!this.stateManager.canPlay()) {
      Logger.warn(TAG, "Cannot play in current state");
      return;
    }

    const currentState = this.stateManager.getState();
    const wasEnded = currentState === "ended";

    // If ended, seek to start (0) to replay from beginning
    // This transitions from 'ended' -> 'seeking' -> 'ready' -> 'playing'
    if (wasEnded && this.demuxer) {
      try {
        Logger.debug(TAG, "Replaying from beginning after ended state");

        // Transition to seeking state first (ended -> seeking is valid)
        if (!this.stateManager.setState("seeking")) {
          Logger.error(TAG, "Failed to transition from ended to seeking");
          return;
        }

        // Flush decoders
        await this.videoDecoder.flush();
        await this.audioDecoder.flush();

        // Clear video frame queue
        if (this.videoRenderer) {
          this.videoRenderer.clearQueue();
        }

        // Flush audio renderer
        this.audioRenderer.reset();

        // Seek demuxer to start (initial media startTime)
        await this.demuxer.seek(this.startTime);
        this.clock.seek(this.startTime);

        // Reset EOF flag
        this.eofReached = false;

        // Mark that we need to skip to keyframe after seek
        this.seekingToKeyframe = true;
        this.seekingToKeyframeStartTime = performance.now();

        // Transition to ready state after seek completes (seeking -> ready is valid)
        if (!this.stateManager.setState("ready")) {
          Logger.error(
            TAG,
            "Failed to transition from seeking to ready after replay seek",
          );
          this.clock.pause();
          return;
        }

        // After successful replay seek, we're now in 'ready' state
        // Continue with normal play flow below (will transition ready -> playing)
      } catch (error) {
        Logger.warn(
          TAG,
          "Failed to seek to start on replay, continuing anyway",
          error,
        );
        // Transition to ready even if seek fails, so we can still play
        const currentState = this.stateManager.getState();
        if (currentState === "seeking") {
          if (!this.stateManager.setState("ready")) {
            Logger.error(
              TAG,
              "Failed to transition from seeking to ready after failed replay seek",
            );
            this.clock.pause();
            return;
          }
        } else if (currentState === "ended") {
          // Still in ended state, can't proceed
          Logger.error(TAG, "Still in ended state after replay seek failed");
          this.clock.pause();
          return;
        }
        // If we successfully transitioned to ready, continue with play flow
      }
    }
    // If resuming from paused state, seek to current time to ensure demuxer is at correct position

    // Request WakeLock to prevent screen sleep
    await this.requestWakeLock();

    // Resume AudioContext if needed (skip if disabled for debugging)
    if (!this.disableAudio) {
      await this.audioRenderer.play();
    } else {
      Logger.debug(TAG, "Audio playback skipped (disabled for debugging)");
    }

    // Start video presentation loop for smooth 60Hz playback
    if (this.videoRenderer) {
      this.videoRenderer.startPresentationLoop();
    }

    this.clock.start();

    // Transition to playing state
    // At this point, state should be 'ready', 'paused', or 'seeking' (never 'ended' as it's handled above)
    const stateForPlay = this.stateManager.getState();
    if (
      stateForPlay === "ready" ||
      stateForPlay === "paused" ||
      stateForPlay === "seeking"
    ) {
      if (!this.stateManager.setState("playing")) {
        Logger.error(
          TAG,
          `Failed to transition to playing from state: ${stateForPlay}`,
        );
        this.clock.pause();
        return;
      }
    } else {
      Logger.error(
        TAG,
        `Cannot transition to playing from state: ${stateForPlay}`,
      );
      this.clock.pause();
      return;
    }

    // Start demux loop
    // Cancel any existing animation frame to prevent duplicates
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.processLoop();

    Logger.info(TAG, "Playing");
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.pause();
      return;
    }

    if (!this.stateManager.canPause()) {
      Logger.warn(TAG, "Cannot pause in current state");
      return;
    }

    // Release WakeLock when pausing
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }

    // Stop video presentation loop
    if (this.videoRenderer) {
      this.videoRenderer.stopPresentationLoop();
    }

    this.stateManager.setState("paused");

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    Logger.info(TAG, "Paused");
  }

  /**
   * Flag to prevent concurrent async WASM operations
   */
  private demuxInFlight = false;
  private demuxInFlightStartTime: number = 0;
  private static readonly DEMUX_TIMEOUT = 35000; // 35 seconds timeout (slightly more than HTTP timeout of 30s)
  private eofReached = false;

  /**
   * Internal handler for seek completion when first target frame is found.
   * Clears the seek flag, synchronizes clock, and transitions to final state.
   */
  private notifySeekCompletion(time: number): void {
    Logger.debug(TAG, `notifySeekCompletion called: time=${time.toFixed(3)}s, waitingForVideoSync=${this.waitingForVideoSync}, seekTargetTime=${this.seekTargetTime.toFixed(3)}s`);
    if (!this.waitingForVideoSync) {
      Logger.warn(TAG, "notifySeekCompletion: early return (waitingForVideoSync=false)");
      return;
    }

    const seekTarget = this.seekTargetTime;
    this.seekTargetTime = -1;
    this.waitingForVideoSync = false;
    this.seekingToKeyframe = false; // Also clear keyframe skip flag

    Logger.debug(
      TAG,
      `Seek completion at ${time.toFixed(3)}s (target: ${seekTarget.toFixed(3)}s)`,
    );

    // Sync correction: Match clock to actual video/audio start time
    // CRITICAL: If we have pending audio packets, sync to the EARLIEST audio packet
    // instead of the video frame. This prevents dropping audio when hardware video
    // decoding has delay (which causes video to arrive 100-500ms after audio).
    if (time > seekTarget + 0.01) {
      let syncTime = time;

      // If we have pending audio, use the earliest audio packet time
      if (this.pendingAudioPackets.length > 0) {
        const earliestAudioTime = Math.min(
          ...this.pendingAudioPackets.map((p) => p.timestamp)
        );

        // Sync to audio if it's earlier than video (hardware decode delay case)
        if (earliestAudioTime < time) {
          syncTime = earliestAudioTime;
          Logger.debug(
            TAG,
            `Video arrived late (${time.toFixed(3)}s), syncing clock to earliest audio (${syncTime.toFixed(3)}s) instead`,
          );
        } else {
          // Video and audio aligned, sync to video
          Logger.debug(
            TAG,
            `Stream jumped ahead. Syncing clock to video at ${syncTime.toFixed(3)}s.`,
          );
        }
      } else {
        Logger.debug(
          TAG,
          `Stream jumped ahead. Syncing clock to ${syncTime.toFixed(3)}s.`,
        );
      }

      this.clock.seek(syncTime);

      // Only filter audio packets that are truly too old (before seek target)
      // Don't drop packets just because video arrived late!
      this.pendingAudioPackets = this.pendingAudioPackets.filter(
        (p) => p.timestamp >= seekTarget - 0.01,
      );
    }

    // Flush any buffered audio packets
    if (this.pendingAudioPackets.length > 0) {
      Logger.debug(
        TAG,
        `Flushing ${this.pendingAudioPackets.length} buffered audio packets after seek sync`,
      );
      for (const pkt of this.pendingAudioPackets) {
        this.audioDecoder.decode(pkt.data, pkt.timestamp, pkt.keyframe);
      }
      this.pendingAudioPackets = [];
    }

    // Transition to final state
    if (this.wasPlayingBeforeSeek) {
      Logger.info(TAG, "Resuming playback after seek");
      this.stateManager.setState("playing");
      this.clock.start();
      if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
        this.audioRenderer.play();
      }
    } else {
      Logger.info(TAG, "Seek completed in paused state");
      this.stateManager.setState("ready");
      // Don't start clock or audio
    }

    // Emit seeked event now that we are actually ready
    // Convert back from media time to UI time
    this.emit("seeked", Math.max(0, time - this.startTime));
  }

  /**
   * Main Playback Loop
   */
  private processLoop = async () => {
    const currentState = this.stateManager.getState();
    // Run if playing OR buffering (for rebuffering) OR if we are resolving a seek (fetching target frame)
    if (currentState !== "playing" && currentState !== "buffering" && !this.waitingForVideoSync)
      return;

    // Capture session ID at start of loop - if a new seek starts, this loop should abort
    const currentSessionId = this.seekSessionId;

    this.animationFrameId = requestAnimationFrame(this.processLoop);

    if (!this.demuxer) return;

    // Check if a new seek has started - if so, abort this loop iteration
    if (this.seekSessionId !== currentSessionId) {
      Logger.debug(TAG, "ProcessLoop aborted: new seek started");
      return;
    }

    // Check if audio is rebuffering due to playback rate change
    if (!this.disableAudio && this.audioRenderer.isRebuffering()) {
      // Enter buffering state and pause clock until rebuffering completes
      const currentState = this.stateManager.getState();
      if (currentState === "playing") {
        this.wasPlayingBeforeRebuffer = true;
        this.stateManager.setState("buffering");
        this.clock.pause();
        Logger.debug(TAG, "Entered buffering state for playback rate change");
      }
      // Continue processing to allow new audio to be decoded and scheduled
    } else if (this.stateManager.getState() === "buffering" && this.wasPlayingBeforeRebuffer) {
      // Rebuffering complete, resume playback only if we were playing before
      // Transition to paused first, then let play() method handle the transition to playing
      this.stateManager.setState("paused");
      this.wasPlayingBeforeRebuffer = false;
      Logger.debug(TAG, "Exited buffering state, resuming playback");

      // Resume playback by calling play() method (proper state machine transition)
      this.play().catch((err) => {
        Logger.error(TAG, "Failed to resume playback after rebuffering:", err);
      });
    }

    // Update FileSource preload position based on current time
    if (this.source instanceof FileSource && this.mediaInfo) {
      const currentTime = this.clock.getTime();
      const duration = this.mediaInfo.duration + this.startTime;
      if (duration > 0) {
        this.source.updatePreloadPosition(currentTime, duration);
      }
    }

    // Emit periodic time update for UI
    this.emit("timeUpdate", this.getCurrentTime());

    // Prevent concurrent async WASM operations (Asyncify limitation)
    // Add timeout safeguard - if demux has been in flight too long, reset it
    if (this.demuxInFlight) {
      const elapsed = performance.now() - this.demuxInFlightStartTime;
      if (elapsed > MoviPlayer.DEMUX_TIMEOUT) {
        Logger.warn(
          TAG,
          `Demux operation timeout after ${elapsed}ms, resetting flag`,
        );
        this.demuxInFlight = false;
      } else {
        return;
      }
    }

    // Check if we've reached EOF and decoders are empty - transition to ended
    if (this.eofReached) {
      // Check if all decoders have finished processing (with tolerance for queued frames)
      // Allow up to 5 frames in decoder queue as normal processing lag
      if (
        this.videoDecoder.queueSize <= 5 &&
        this.audioDecoder.queueSize === 0
      ) {
        // Check time to see if we are done
        const currentTime = this.clock.getTime();
        const duration = this.mediaInfo?.duration ?? 0;
        const timeDone =
          currentTime >= duration + this.startTime - 0.2 || duration === 0;

        // Also check if video renderer has shown all frames
        // BUT if we reached duration (timeDone), we should end regardless of queue
        // (handles case where last frames are slightly beyond clamped clock)
        const videoDone =
          !this.videoRenderer || this.videoRenderer.getQueueSize() === 0;

        if (videoDone || timeDone) {
          if (timeDone) {
            this.handleEnded();
            return;
          }
        }
      }
      return; // Don't demux more, just wait for playback to finish
    }

    // Check backpressure - relax limits for better throughput
    // After seek, use stricter limits to prevent overwhelming low-end devices
    const isSoftware = this.isSoftwareDecoding();
    const timeSinceSeek = performance.now() - this.seekTime;
    const isPostSeek =
      this.justSeeked && timeSinceSeek < MoviPlayer.POST_SEEK_THROTTLE_MS;

    const audioBuffered = this.disableAudio
      ? 0
      : this.audioRenderer.getBufferedDuration();

    // Canvas/WebCodecs path
    const videoBuffered = this.videoRenderer?.getQueueSize() ?? 0;

    // Adaptive limits for software/hardware modes
    // During post-seek or while waiting for initial sync, we are more permissive with decoder queues
    // to ensure they have enough data to output the first few frames.
    const maxVideoQueue = isSoftware
      ? 1000
      : isPostSeek || this.waitingForVideoSync
        ? 60
        : 30;
    const maxAudioQueue = isSoftware
      ? 500
      : isPostSeek || this.waitingForVideoSync
        ? 40
        : 20;

    // Buffer targets (in seconds)
    const maxAudioBuffered = isSoftware ? 5.0 : isPostSeek ? 1.5 : 2.0;
    // Renderer queue limits (in frames)
    const maxVideoBuffered = isSoftware ? 60 : isPostSeek ? 20 : 100;

    if (
      this.videoDecoder.queueSize > maxVideoQueue ||
      (!this.disableAudio && this.audioDecoder.queueSize > maxAudioQueue) ||
      (!this.disableAudio && audioBuffered > maxAudioBuffered) ||
      videoBuffered > maxVideoBuffered
    ) {
      if (
        this.waitingForVideoSync &&
        (this.videoDecoder.queueSize > maxVideoQueue ||
          videoBuffered > maxVideoBuffered)
      ) {
        Logger.debug(
          TAG,
          `Backpressure during sync: videoDecoder=${this.videoDecoder.queueSize}, videoBuffered=${videoBuffered}`,
        );
      }
      return;
    }

    // Read packet
    try {
      // Final check before starting async operation - ensure no new seek started
      if (this.seekSessionId !== currentSessionId) {
        Logger.debug(TAG, "ProcessLoop aborted before demux: new seek started");
        return;
      }

      this.demuxInFlight = true;
      this.demuxInFlightStartTime = performance.now();

      // Determine burst size based on buffer levels and post-seek state
      let burstSize = 20;

      if (isPostSeek) {
        burstSize = 5;
        Logger.debug(
          TAG,
          `Post-seek throttling: using burst size ${burstSize}`,
        );
      } else {
        // Clear the justSeeked flag after throttle period
        if (
          this.justSeeked &&
          timeSinceSeek >= MoviPlayer.POST_SEEK_THROTTLE_MS
        ) {
          this.justSeeked = false;
          Logger.debug(TAG, "Post-seek throttle period ended");
        }

        // Normal burst size logic
        const videoQueue = this.videoRenderer?.getQueueSize() ?? 0;
        const currentAudioBuffered = this.audioRenderer.getBufferedDuration();

        // If buffers are low, increase burst size to fill faster
        const bufferTarget = isSoftware ? 2.0 : 0.5;
        if (videoQueue < 30 || currentAudioBuffered < bufferTarget) {
          burstSize = isSoftware ? 80 : 40; // Read more aggressively when buffers are low
        }
      }

      for (let i = 0; i < burstSize; i++) {
        // Check both video and audio queues after seek to prevent overwhelming decoders
        if (
          this.videoDecoder.queueSize > maxVideoQueue ||
          (!this.disableAudio && this.audioDecoder.queueSize > maxAudioQueue)
        ) {
          // Queue getting full, stop to let decoders catch up
          if (isPostSeek) {
            Logger.debug(
              TAG,
              `Post-seek: queue full (video: ${this.videoDecoder.queueSize}, audio: ${this.audioDecoder.queueSize}), pausing burst`,
            );
          }
          break;
        }

        // Yield periodically to prevent blocking the main thread, especially in software mode
        // This helps maintain audio responsiveness and UI interactivity
        const yieldInterval = isPostSeek ? 2 : isSoftware ? 3 : 20;
        if (i > 0 && i % yieldInterval === 0) {
          // Use MessageChannel for fast yielding (better than setTimeout)
          const channel = new MessageChannel();
          await new Promise((resolve) => {
            channel.port1.onmessage = resolve;
            channel.port2.postMessage(null);
          });

          // Check if a new seek started during yield
          if (this.seekSessionId !== currentSessionId) {
            Logger.debug(
              TAG,
              "ProcessLoop aborted during packet read: new seek started",
            );
            this.demuxInFlight = false; // Reset flag so new seek can proceed
            return;
          }
        }

        const packet = await this.demuxer.readPacket();

        // Check again after async readPacket - seek may have started during read
        if (this.seekSessionId !== currentSessionId) {
          Logger.debug(
            TAG,
            "ProcessLoop aborted after readPacket: new seek started",
          );
          this.demuxInFlight = false; // Reset flag so new seek can proceed
          return;
        }

        if (!packet) {
          // EOF reached - mark it but don't stop immediately
          // Let the decoders finish processing
          this.eofReached = true;

          // Clear seeking flag if we hit EOF before finding keyframe
          if (this.seekingToKeyframe) {
            this.seekingToKeyframe = false;
            Logger.warn(TAG, "EOF reached before finding keyframe after seek");
          }

          // If we were waiting for sync, trigger it now so player doesn't hang in loading state
          if (this.waitingForVideoSync) {
            Logger.warn(
              TAG,
              "EOF reached while waiting for seek sync, forcing completion",
            );
            this.notifySeekCompletion(this.seekTargetTime);
          }

          Logger.debug(TAG, "EOF reached");
          break;
        }

        // Dispatch to decoders/renderers
        if (this.trackManager.isActiveStream(packet.streamIndex)) {
          const activeVideo = this.trackManager.getActiveVideoTrack();
          const activeAudio = this.trackManager.getActiveAudioTrack();

          if (activeVideo && activeVideo.id === packet.streamIndex) {
            // After seek, skip non-keyframe video packets until we find a keyframe
            // This prevents decoder errors (decoder needs keyframe after flush)
            if (this.seekingToKeyframe) {
              // Check timeout - if we've been waiting too long, give up and accept any frame
              const elapsed =
                performance.now() - this.seekingToKeyframeStartTime;
              if (elapsed > MoviPlayer.KEYFRAME_SEEK_TIMEOUT) {
                Logger.warn(
                  TAG,
                  `Keyframe seek timeout after ${elapsed}ms, accepting any frame`,
                );
                this.seekingToKeyframe = false;
              } else if (!packet.keyframe) {
                // Skip this non-keyframe packet, continue to next
                continue;
              } else {
                // Found keyframe, clear the flag and process packet
                this.seekingToKeyframe = false;
                Logger.debug(
                  TAG,
                  "Found keyframe after seek, resuming normal playback",
                );
              }
            }

            if (this.videoDecoder) {
              // Decode and render to canvas
              // Note: All packets including pre-target are decoded to build reference frames
              // The onFrame callback filters out frames before seekTargetTime
              this.videoDecoder.decode(
                packet.data,
                packet.timestamp,
                packet.keyframe,
                packet.dts,
              );
            }
          } else if (activeAudio && activeAudio.id === packet.streamIndex) {
            // Audio can be processed normally (doesn't need keyframes)
            // Skip audio processing if disabled for debugging or muted
            if (!this.disableAudio && !this.muted) {
              // IMPORTANT: Skip audio packets before the seek target time
              // This prevents A/V sync from being based on the keyframe time (e.g., 0s)
              // instead of the actual seek target (e.g., 2s)
              // CRITICAL: Check seekTargetTime !== -1 to support negative start times
              if (
                this.seekTargetTime !== -1 &&
                packet.timestamp < this.seekTargetTime
              ) {
                // Skip this audio packet, it's before our target time
                // Continue to next packet (audio will start when we reach target time)
                continue;
              }

              // If waiting for video frame to ensure sync, buffer audio packets
              if (
                this.waitingForVideoSync &&
                this.trackManager.getActiveVideoTrack()
              ) {
                this.pendingAudioPackets.push(packet);
                continue;
              }

              // Note: We don't clear seekTargetTime here anymore!
              // With B-frame videos, video frames arrive asynchronously and may still need
              // to be filtered after audio catches up. The seekTargetTime will be cleared
              // after POST_SEEK_THROTTLE_MS when justSeeked becomes false, or on next seek.
              if (
                this.seekTargetTime !== -1 &&
                packet.timestamp >= this.seekTargetTime
              ) {
                Logger.debug(
                  TAG,
                  `Audio reached seek target: ${packet.timestamp.toFixed(3)}s (target: ${this.seekTargetTime.toFixed(3)}s)`,
                );
                // If there is no video track, audio completion triggers state transition
                if (!this.trackManager.getActiveVideoTrack()) {
                  this.notifySeekCompletion(packet.timestamp);
                }
              }

              this.audioDecoder.decode(
                packet.data,
                packet.timestamp,
                packet.keyframe,
              );
            }
          } else {
            // Check for subtitle track
            const activeSubtitle = this.trackManager.getActiveSubtitleTrack();
            if (
              activeSubtitle &&
              activeSubtitle.id === packet.streamIndex &&
              this.subtitleDecoder
            ) {
              // Decode subtitle packet
              // For SRT files, FFmpeg might not always extract duration correctly from timestamp lines
              // Use packet duration if available, otherwise pass 0 and let C code use fallback
              let duration = packet.duration;
              if (!duration || duration <= 0) {
                // FFmpeg didn't extract duration - C code will use fallback mechanism
                // The fallback will use minimum duration or calculate from next packet
                duration = 0;
                Logger.debug(
                  TAG,
                  `Subtitle packet has no duration, will use fallback: timestamp=${packet.timestamp.toFixed(3)}s`,
                );
              }
              Logger.debug(
                TAG,
                `Processing subtitle packet: stream=${packet.streamIndex}, size=${packet.data.length}, timestamp=${packet.timestamp.toFixed(3)}s, duration=${duration > 0 ? duration.toFixed(3) : "fallback"}s`,
              );
              this.subtitleDecoder
                .decode(
                  packet.data,
                  packet.timestamp,
                  packet.keyframe,
                  duration,
                )
                .catch((error) => {
                  Logger.error(TAG, "Subtitle decode error", error);
                });
            } else {
              if (
                activeSubtitle &&
                activeSubtitle.id === packet.streamIndex &&
                !this.subtitleDecoder
              ) {
                Logger.warn(
                  TAG,
                  `Subtitle packet received but decoder not initialized for track ${packet.streamIndex}`,
                );
              }
            }
          }
        }

        // Assuming packet.data is copied by bindings, we don't need to manually free JS side
        // unless bindings exposed a pointer. bindings.ts returns `result.data` which is `new Uint8Array(copy)`.
      }
    } catch (e) {
      Logger.error(TAG, "Demux error", e);

      // Check for fatal errors that indicate corrupted state
      const errorMessage = (e as any).message || "";
      const isFatalError =
        errorMessage.includes("Invalid packet size") ||
        errorMessage.includes("Invalid typed array length") ||
        errorMessage.includes("State may be corrupted");

      if (isFatalError) {
        // Fatal error - pause playback and stop processing
        Logger.error(TAG, "Fatal demux error detected, pausing playback");
        this.pause();
        this.emit("error", new Error("Playback error: corrupt data stream"));
        return; // Exit process loop
      }

      // For non-fatal errors, continue (network glitches, etc.)
    } finally {
      this.demuxInFlight = false;
    }
  };

  /**
   * Handle playback ended
   */
  private handleEnded(): void {
    Logger.info(TAG, "Playback ended");

    // Release WakeLock when playback ends
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }

    // Stop video presentation loop
    if (this.videoRenderer) {
      this.videoRenderer.stopPresentationLoop();
    }

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Snap time to end
    if (this.mediaInfo) {
      this.clock.seek(this.mediaInfo.duration + this.startTime);
      this.emit("timeUpdate", this.mediaInfo.duration);
    }

    this.stateManager.setState("ended");
    this.emit("ended", undefined);
  }

  /**
   * Seek to timestamp
   */
  private seekSessionId = 0;
  private wasPlayingBeforeSeek = false;

  async seek(seconds: number): Promise<void> {
    if (this.hlsWrapper) {
      return this.hlsWrapper.seek(seconds);
    }

    const currentState = this.stateManager.getState();

    // Safety check - though PlayerState now permits it
    if (!this.stateManager.canSeek()) {
      Logger.warn(TAG, "Cannot seek in current state");
      return;
    }

    if (!this.demuxer) {
      throw new Error("Demuxer not initialized");
    }

    // Track intent: if we were playing (or already seeking but originally playing), we want to resume
    if (currentState !== "seeking") {
      this.wasPlayingBeforeSeek = currentState === "playing";
    }

    // Pause clock so UI time doesn't advance during seek while in loading state
    this.clock.pause();

    const mySessionId = ++this.seekSessionId;
    this.stateManager.setState("seeking");
    this.emit("seeking", seconds);

    // CRITICAL: Cancel any running processLoop immediately to prevent WASM async conflicts
    // This must happen before waiting for demuxInFlight, otherwise processLoop may start new async operations
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    try {
      // If demuxing is in flight, wait for it to avoid WASM/Asyncify corruption
      // We loop but also check session ID to abort early if a new seek started
      // Also reset demuxInFlight if this seek is superseded
      if (this.demuxInFlight) {
        let retries = 0;
        while (this.demuxInFlight && retries < 100) {
          if (this.seekSessionId !== mySessionId) {
            // This seek was superseded, reset demuxInFlight to allow new seek to proceed
            this.demuxInFlight = false;
            return; // Superceded
          }
          await new Promise((r) => setTimeout(r, 10));
          retries++;
        }
      }

      if (this.seekSessionId !== mySessionId) return; // Superceded

      // Flush decoders
      await this.videoDecoder.flush();
      await this.audioDecoder.flush();

      // Clear video frame queue to prevent old frames from being displayed
      if (this.videoRenderer) {
        this.videoRenderer.clearQueue();
      }

      // Flush audio renderer (clears buffers)
      this.audioRenderer.reset();

      if (this.seekSessionId !== mySessionId) return; // Superceded

      // Seek relative to start time (time 0 in UI = startTime in media)
      await this.demuxer.seek(seconds + this.startTime);
      this.clock.seek(seconds + this.startTime);

      // Reset EOF flag after seek - we're now at a new position
      this.eofReached = false;

      // Mark that we need to skip to keyframe after seek
      // This prevents decoder errors from non-keyframe packets after seek
      this.seekingToKeyframe = true;
      this.seekingToKeyframeStartTime = performance.now();

      // IMPORTANT: Set seek target time for accurate seek positioning
      // FFmpeg seeks to the nearest keyframe BEFORE the target time,
      // so packets will have timestamps earlier than 'seconds'.
      // We need to skip audio packets before target and decode (but not display) video frames.
      // Normalize target time against startTime offset
      this.seekTargetTime = seconds + this.startTime;
      this.waitingForVideoSync = true;
      this.pendingAudioPackets = [];

      // Enable post-seek throttling to prevent overwhelming low-end devices
      this.justSeeked = true;
      this.seekTime = performance.now();

      if (this.seekSessionId !== mySessionId) return; // Superceded

      // Start processing loop to find and decode the target frame/packet.
      // notifySeekCompletion will be called once the first valid frame is received.
      this.processLoop();

      // Ensure the video renderer loop is running to actually draw frames as they arrive
      if (this.videoRenderer) {
        this.videoRenderer.startPresentationLoop();
      }

      Logger.info(TAG, `Seek initiated to ${seconds}s, waiting for sync...`);
    } catch (error) {
      // Reset seeking flag on error
      this.seekingToKeyframe = false;

      if (this.seekSessionId === mySessionId) {
        this.stateManager.setState("error");
        this.emit("error", error as Error);
      }
      throw error;
    }
  }

  /**
   * Initialize WebGL context for thumbnail rendering
   */

  /**
   * Generates a preview frame for the given time using C-based FFmpeg software decoding.
   * Fast and doesn't block main playback.
   */
  /**
   * Generates a preview frame for the given time using C for demuxing and WebCodecs for decoding.
   */
  async getPreviewFrame(time: number): Promise<Blob | null> {
    if (!this.config.enablePreviews) return null; // Previews disabled
    if (this.hlsWrapper) return null; // Previews not supported for HLS
    if (this.isPreviewGenerating) return null; // Busy
    this.isPreviewGenerating = true;

    try {
      // Initialize thumbnail pipeline if needed
      if (!this.thumbnailBindings) {
        if (this.previewInitPromise) {
          Logger.debug(TAG, "Waiting for existing preview initialization...");
          await this.previewInitPromise;
        } else {
          Logger.debug(TAG, "Initializing thumbnail pipeline (lazy)...");
          this.previewInitPromise = this.initPreviewPipeline();
          await this.previewInitPromise;
        }
      }

      if (!this.thumbnailBindings || !this.thumbnailRenderer) {
        Logger.warn(TAG, "Thumbnail bindings or renderer not available");
        return null;
      }

      // Read keyframe from thumbnailer
      // Convert time to media time (PTS) by adding startTime
      const packetSize = await this.thumbnailBindings.readKeyframe(time);
      Logger.debug(
        TAG,
        `Thumbnail readKeyframe(${time.toFixed(2)}s): size=${packetSize}`,
      );

      if (packetSize <= 0) {
        // Suppress warning for expected errors like aborted reads (-6) or generic errors during rapid seeking
        if (packetSize !== -6) {
          Logger.warn(TAG, `Thumbnail read failed or empty: ${packetSize}`);
        }
        return null;
      }

      const timestamp = this.thumbnailBindings.getPacketPts();
      const dataPtr = this.thumbnailBindings.getPacketData();

      Logger.debug(
        TAG,
        `Thumbnail packet: pts=${timestamp.toFixed(2)}s, ptr=${dataPtr}, size=${packetSize}`,
      );

      if (!dataPtr) {
        Logger.warn(TAG, "Thumbnail packet data pointer is null");
        return null;
      }

      // Get packet data from the ISOLATED thumbnail module (not main module!)
      const packetData = this.thumbnailBindings.getPacketDataCopy(packetSize);
      if (!packetData) {
        Logger.warn(TAG, "Failed to copy thumbnail packet data");
        return null;
      }

      // 1. Try WebCodecs (Hardware) through Renderer
      let rendered = false;

      try {
        rendered = await this.thumbnailRenderer!.decodeAndRender(
          packetData,
          timestamp,
        );
      } catch (e) {
        Logger.warn(TAG, "Thumbnail WebCodecs decode failed", e);
      }

      /* REMOVED OLD LOGIC START
              const videoTrack = this.mediaInfo?.tracks?.find(
                (t) => t.type === "video",
              ) as VideoTrack | undefined;
              const aspect =
                videoTrack?.width && videoTrack?.height
                  ? videoTrack.width / videoTrack.height
                  : 16 / 9;
              const width = 320;
              const height = Math.round(width / aspect);

              const rgba = this.thumbnailBindings!.decodeCurrentPacket(
                width,
                height,
              );

              if (rgba && rgba.length > 0) {
                if (!this.thumbnailCanvas) {
                  if (typeof OffscreenCanvas !== "undefined") {
                    this.thumbnailCanvas = new OffscreenCanvas(width, height);
                  } else {
                    this.thumbnailCanvas = document.createElement("canvas");
                    this.thumbnailCanvas.width = width;
                    this.thumbnailCanvas.height = height;
                  }
                  this.thumbnailContext = this.thumbnailCanvas.getContext(
                    "2d",
                    { alpha: false, willReadFrequently: true },
                  ) as any;
                }

                if (
                  this.thumbnailCanvas!.width !== width ||
                  this.thumbnailCanvas!.height !== height
                ) {
                  this.thumbnailCanvas!.width = width;
                  this.thumbnailCanvas!.height = height;
                }

                // Draw software pixels
                const imageData = new ImageData(
                  new Uint8ClampedArray(rgba),
                  width,
                  height,
                );
                this.thumbnailContext!.putImageData(imageData, 0, 0);

                // Convert to Blob
                if (this.thumbnailCanvas instanceof OffscreenCanvas) {
                  (this.thumbnailCanvas as OffscreenCanvas)
                    .convertToBlob({ type: "image/jpeg", quality: 0.7 })
                    .then((blob) => {
                      // Free C-side RGB buffer after blob creation
                      this.thumbnailBindings?.clearBuffer();
                      resolve(blob);
                    });
                } else {
                  (this.thumbnailCanvas as HTMLCanvasElement).toBlob(
                    (blob) => {
                      // Free C-side RGB buffer after blob creation
                      this.thumbnailBindings?.clearBuffer();
                      resolve(blob);
                    },
                    "image/jpeg",
                    0.7,
                  );
                }
              } else {
                Logger.warn(TAG, "Software fallback returned no data");
                resolve(null);
              }
            } catch (e) {
              Logger.error(TAG, "Software fallback exception", e);
              resolve(null);
            }
          }
        }, 500); // Fast timeout for fallback

        this.thumbnailDecoder?.setOnFrame((frame) => {
          if (resolved) {
            frame.close();
            return;
          }

          Logger.debug(
            TAG,
            `Thumbnail frame received: ${frame.codedWidth}x${frame.codedHeight}`,
          );

          // 3. Render VideoFrame to Canvas using WebGL (with HDR support)
          const videoTrack = this.mediaInfo?.tracks?.find(
            (t) => t.type === "video",
          ) as VideoTrack | undefined;
          const rotation = videoTrack?.rotation || 0;
          const isRotated = rotation % 180 !== 0;

          // Use display dimensions
          const frameW = frame.displayWidth;
          const frameH = frame.displayHeight;
          const canvasW = isRotated ? frameH : frameW;
          const canvasH = isRotated ? frameW : frameH;

          // Create canvas if needed
          if (!this.thumbnailCanvas) {
            if (typeof OffscreenCanvas !== "undefined") {
              this.thumbnailCanvas = new OffscreenCanvas(canvasW, canvasH);
            } else {
              this.thumbnailCanvas = document.createElement("canvas");
              this.thumbnailCanvas.width = canvasW;
              this.thumbnailCanvas.height = canvasH;
            }

            // Try to initialize WebGL with HDR support
            const colorSpace = this.detectThumbnailHDRColorSpace();
            const webglInitialized = this.initThumbnailWebGL(
              this.thumbnailCanvas,
              colorSpace,
            );

            // Fallback to 2D if WebGL fails
            if (!webglInitialized) {
              this.thumbnailContext = this.thumbnailCanvas.getContext("2d", {
                alpha: false,
                willReadFrequently: true,
              }) as any;
            }
          }

          // Resize canvas if dimensions changed
          if (
            this.thumbnailCanvas.width !== canvasW ||
            this.thumbnailCanvas.height !== canvasH
          ) {
            this.thumbnailCanvas.width = canvasW;
            this.thumbnailCanvas.height = canvasH;

            // Re-initialize WebGL if it was being used
            if (this.thumbnailGL) {
              const colorSpace = this.detectThumbnailHDRColorSpace();
              this.initThumbnailWebGL(this.thumbnailCanvas, colorSpace);
            }
          }

          // Render using WebGL if available, otherwise fall back to 2D
          if (
            this.thumbnailGL &&
            this.thumbnailGLProgram &&
            this.thumbnailGLTexture &&
            this.thumbnailGLVao
          ) {
            try {
              const gl = this.thumbnailGL;

              // Setup viewport
              gl.viewport(0, 0, canvasW, canvasH);
              gl.clearColor(0, 0, 0, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);

              // Bind program and VAO
              gl.useProgram(this.thumbnailGLProgram);
              gl.bindVertexArray(this.thumbnailGLVao);

              // Upload frame to texture
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, this.thumbnailGLTexture);
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                frame,
              );

              // Draw
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

              Logger.debug(
                TAG,
                `Thumbnail rendered with WebGL (HDR: ${this.thumbnailHDREnabled})`,
              );
            } catch (e) {
              Logger.warn(
                TAG,
                "WebGL thumbnail rendering failed, falling back to 2D",
                e,
              );
              // Fallback to 2D rendering
              if (this.thumbnailContext) {
                if (rotation !== 0) {
                  this.thumbnailContext.save();
                  this.thumbnailContext.translate(canvasW / 2, canvasH / 2);
                  this.thumbnailContext.rotate((rotation * Math.PI) / 180);
                  this.thumbnailContext.drawImage(
                    frame,
                    -frameW / 2,
                    -frameH / 2,
                    frameW,
                    frameH,
                  );
                  this.thumbnailContext.restore();
                } else {
                  this.thumbnailContext.drawImage(frame, 0, 0, frameW, frameH);
                }
              }
            }
          } else {
            // Use 2D canvas as fallback
            if (rotation !== 0 && this.thumbnailContext) {
              this.thumbnailContext.save();
              this.thumbnailContext.translate(canvasW / 2, canvasH / 2);
              this.thumbnailContext.rotate((rotation * Math.PI) / 180);
              this.thumbnailContext.drawImage(
                frame,
                -frameW / 2,
                -frameH / 2,
                frameW,
                frameH,
              );
              this.thumbnailContext.restore();
            } else {
              this.thumbnailContext?.drawImage(frame, 0, 0, frameW, frameH);
            }
          }

          frame.close();
          resolved = true;
          clearTimeout(timeout);

          // 4. Convert to Blob
          if (this.thumbnailCanvas instanceof OffscreenCanvas) {
            (this.thumbnailCanvas as OffscreenCanvas)
              .convertToBlob({ type: "image/jpeg", quality: 0.7 })
              .then((blob) => {
                Logger.debug(
                  TAG,
                  `Thumbnail blob created: ${blob?.size} bytes`,
                );
                // Free C-side RGB buffer (if software fallback was used)
                this.thumbnailBindings?.clearBuffer();
                resolve(blob);
              });
          } else {
            (this.thumbnailCanvas as HTMLCanvasElement).toBlob(
              (blob) => {
                Logger.debug(
                  TAG,
                  `Thumbnail blob created: ${blob?.size} bytes`,
                );
                // Free C-side RGB buffer (if software fallback was used)
                this.thumbnailBindings?.clearBuffer();
                resolve(blob);
              },
              "image/jpeg",
              0.7,
            );
          }
        });

      REMOVED OLD LOGIC END */

      // 2. Fallback to Software Decoding
      if (!rendered) {
        try {
          // Get width/height from active video track
          const videoTrack = this.trackManager.getActiveVideoTrack();
          let width = 320; // Default small
          let height = 180;

          if (videoTrack) {
            width = videoTrack.width;
            height = videoTrack.height;
          }

          const rgba = this.thumbnailBindings!.decodeCurrentPacket(
            width,
            height,
          );
          if (rgba && rgba.length > 0) {
            this.thumbnailRenderer!.render(rgba, width, height);
            this.thumbnailBindings!.clearBuffer();
            rendered = true;
          } else {
            Logger.warn(TAG, "Software thumbnail decoder returned no data");
          }
        } catch (e) {
          Logger.error(TAG, "Software thumbnail fallback exception", e);
        }
      }

      if (rendered) {
        const canvas = this.thumbnailRenderer!.getCanvas();
        if ("toBlob" in canvas) {
          return new Promise<Blob | null>((resolve) => {
            // @ts-ignore
            canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.7);
          });
        }
        // If OffscreenCanvas (unlikely here but possible if strict types used)
        if ("convertToBlob" in canvas) {
          // @ts-ignore
          return await canvas.convertToBlob({
            type: "image/jpeg",
            quality: 0.7,
          });
        }
      }

      return null;
    } catch (e) {
      Logger.warn(TAG, "Preview generation failed", e);
      return null;
    } finally {
      this.isPreviewGenerating = false;
      // Clear ThumbnailHttpSource buffer to free memory (512KB)
      // This clears the buffer after each thumbnail generation
      if (this.thumbnailSource && "clearBuffer" in this.thumbnailSource) {
        (this.thumbnailSource as any).clearBuffer();
      }
    }
  }

  private async initPreviewPipeline() {
    if (this.thumbnailBindings) return; // Already initialized

    Logger.debug(TAG, "Initializing thumbnail pipeline...");
    // Use a NEW isolated WASM module instance for thumbnails
    // This prevents onReadRequest handler conflicts with main playback
    const module = await loadWasmModuleNew({
      wasmBinary: this.config.wasmBinary,
    });
    Logger.debug(TAG, "Isolated WASM module loaded for thumbnails");

    // Use dedicated ThumbnailHttpSource to avoid conflicts with main playback stream
    // This source makes independent range requests without shared buffering state
    const sourceConfig = this.config.source;
    if (typeof sourceConfig === "string") {
      this.thumbnailSource = new ThumbnailHttpSource(sourceConfig);
    } else if ("url" in sourceConfig && sourceConfig.url) {
      this.thumbnailSource = new ThumbnailHttpSource(
        sourceConfig.url,
        sourceConfig.headers || {},
      );
    } else {
      // File source - use regular createSource as files don't have streaming conflicts
      this.thumbnailSource = await this.createSource(sourceConfig);
    }

    const fileSize = await this.thumbnailSource.getSize();
    Logger.debug(TAG, `Thumbnail source created, file size: ${fileSize}`);

    // Create thumbnail bindings
    this.thumbnailBindings = new ThumbnailBindings(module);

    const dataAdapter = {
      read: async (offset: number, size: number): Promise<Uint8Array> => {
        if (!this.thumbnailSource) throw new Error("No thumbnail source");
        const buffer = await this.thumbnailSource.read(offset, size);
        return new Uint8Array(buffer);
      },
      getSize: async (): Promise<number> => {
        if (!this.thumbnailSource) throw new Error("No thumbnail source");
        return this.thumbnailSource.getSize();
      },
    };
    this.thumbnailBindings.setDataSource(dataAdapter);

    const created = await this.thumbnailBindings.create(fileSize);
    Logger.debug(TAG, `Thumbnail context create result: ${created}`);
    if (!created) throw new Error("Failed to create thumbnail context");

    const opened = await this.thumbnailBindings.open();
    Logger.debug(TAG, `Thumbnail context open result: ${opened}`);
    if (!opened) throw new Error("Failed to open thumbnail media");

    // Initialize Renderer
    this.thumbnailRenderer = new ThumbnailRenderer();

    let videoTrack = this.trackManager.getActiveVideoTrack();
    if (!videoTrack) {
      const tracks = this.trackManager.getVideoTracks();
      if (tracks.length > 0) videoTrack = tracks[0];
    }

    if (videoTrack) {
      // Initialize renderer dimensions and HDR settings
      this.thumbnailRenderer.initialize({
        width: videoTrack.width,
        height: videoTrack.height,
        rotation: videoTrack.rotation || 0,
        colorPrimaries: videoTrack.colorPrimaries,
        colorTransfer: videoTrack.colorTransfer,
        hdrEnabled: this.thumbnailHDREnabled,
      });

      // Configure internal VideoDecoder
      const extradata = this.demuxer?.getExtradata(videoTrack.id) ?? null;

      Logger.debug(
        TAG,
        `Configuring thumbnail decoder with track: ${videoTrack.codec}, extradata: ${extradata ? extradata.length : 0} bytes`,
      );
      const configured = await this.thumbnailRenderer.configureDecoder(
        videoTrack.codec,
        extradata, // can be null
        videoTrack.width,
        videoTrack.height,
        videoTrack.profile,
        videoTrack.level,
      );

      if (!configured) {
        Logger.warn(
          TAG,
          "Failed to configure thumbnail VideoDecoder, will use software fallback",
        );
      }
    } else {
      Logger.warn(TAG, "No video track found for thumbnail renderer");
    }

    Logger.debug(TAG, "Thumbnail pipeline initialized successfully");
  }

  private destroyPreviewPipeline() {
    if (this.thumbnailBindings) {
      this.thumbnailBindings.destroy();
      this.thumbnailBindings = null;
    }

    if (this.thumbnailRenderer) {
      this.thumbnailRenderer.destroy();
      this.thumbnailRenderer = null;
    }

    this.thumbnailSource = null;
  }

  /**
   * Get all tracks
   */
  getTracks(): Track[] {
    return this.trackManager.getTracks();
  }

  /**
   * Get video tracks
   */
  getVideoTracks(): VideoTrack[] {
    return this.trackManager.getVideoTracks();
  }

  /**
   * Get audio tracks
   */
  getAudioTracks(): AudioTrack[] {
    return this.trackManager.getAudioTracks();
  }

  /**
   * Get subtitle tracks
   */
  getSubtitleTracks(): SubtitleTrack[] {
    return this.trackManager.getSubtitleTracks();
  }

  /**
   * Select audio track
   */
  selectAudioTrack(trackId: number): boolean {
    return this.trackManager.selectAudioTrack(trackId);
    // Note: change event listeners above will reconfigure decoder
  }

  /**
   * Select subtitle track
   */
  async selectSubtitleTrack(trackId: number | null): Promise<boolean> {
    Logger.info(TAG, `selectSubtitleTrack called: trackId=${trackId}`);
    const result = this.trackManager.selectSubtitleTrack(trackId);
    Logger.debug(TAG, `TrackManager.selectSubtitleTrack returned: ${result}`);

    // Clear subtitles when track is deselected
    if (trackId === null) {
      Logger.info(TAG, "Disabling subtitles");
      if (this.videoRenderer) {
        this.videoRenderer.clearSubtitles();
        Logger.debug(TAG, "Cleared subtitles from video renderer");
      }
      if (this.subtitleDecoder) {
        this.subtitleDecoder.close();
        Logger.debug(TAG, "Closed subtitle decoder");
      }
      return result;
    }

    // Configure decoder for new subtitle track
    if (this.demuxer && this.subtitleDecoder) {
      const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
      Logger.info(
        TAG,
        `Configuring subtitle decoder for track: id=${subtitleTrack?.id}, codec=${subtitleTrack?.codec}, type=${subtitleTrack?.subtitleType}`,
      );

      if (subtitleTrack) {
        // Close previous decoder before configuring new one (helps with track switching)
        Logger.debug(
          TAG,
          "Closing previous subtitle decoder before switching tracks",
        );
        this.subtitleDecoder.close();

        // Set bindings first (required for configure)
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          Logger.debug(TAG, "Setting bindings on subtitle decoder");
          this.subtitleDecoder.setBindings(bindings, false);
        } else {
          Logger.warn(TAG, "No bindings available from demuxer!");
        }

        const extradata =
          this.demuxer.getExtradata(subtitleTrack.id) ?? undefined;
        Logger.debug(
          TAG,
          `Configuring subtitle decoder: extradata=${extradata?.length || 0} bytes`,
        );
        const configured = await this.subtitleDecoder.configure(
          subtitleTrack,
          extradata,
        );
        Logger.info(
          TAG,
          `Subtitle decoder configuration result: ${configured}`,
        );

        if (configured) {
          // Set up subtitle cue callback
          Logger.debug(TAG, "Setting up subtitle cue callback");
          this.subtitleDecoder.setOnCue((cue) => {
            Logger.debug(
              TAG,
              `Subtitle cue callback triggered: "${cue.text?.substring(0, 30)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
            );
            if (this.videoRenderer) {
              Logger.debug(TAG, "Setting subtitle cue on video renderer");
              this.videoRenderer.setSubtitleCues([cue]);
            } else {
              Logger.warn(TAG, "Subtitle cue callback: videoRenderer is null!");
            }
          });
        } else {
          Logger.warn(
            TAG,
            `Could not configure subtitle decoder for track ${subtitleTrack.id} (${subtitleTrack.codec}) - codec may not be available in WASM build`,
          );
          // If decoder configuration failed, deselect the track since we can't decode it
          this.trackManager.selectSubtitleTrack(-1);
          return false;
        }
      } else {
        Logger.warn(
          TAG,
          `No active subtitle track found after selecting trackId ${trackId}`,
        );
      }
    } else {
      Logger.warn(
        TAG,
        `Cannot configure subtitle decoder: demuxer=${!!this.demuxer}, subtitleDecoder=${!!this.subtitleDecoder}`,
      );
    }

    return result;
  }

  /**
   * Get current playback time
   */
  getCurrentTime(): number {
    if (this.hlsWrapper) {
      return this.hlsWrapper.getCurrentTime();
    }
    return Math.max(0, this.clock.getTime() - this.startTime);
  }

  /**
   * Get duration
   */
  getDuration(): number {
    if (this.hlsWrapper) {
      return this.hlsWrapper.getDuration();
    }
    return this.mediaInfo?.duration ?? 0;
  }

  /**
   * Get LRU cache statistics
   */
  getCacheStats(): {
    utilization: number;
    sizeBytes: number;
    maxSizeBytes: number;
    entryCount: number;
  } {
    return {
      utilization: this.cache.getUtilization(),
      sizeBytes: this.cache.getSize(),
      maxSizeBytes: this.cache.getMaxSize(),
      entryCount: this.cache.getEntryCount(),
    };
  }

  /**
   * Get cached time ranges for visualization
   * Converts cached byte ranges to time ranges
   * @returns Array of {start, end} time ranges in seconds
   */
  getCachedTimeRanges(): Array<{ start: number; end: number }> {
    if (!this.source || !this.mediaInfo || this.fileSize <= 0) {
      return [];
    }

    const sourceKey = this.source.getKey();
    const byteRanges = this.cache.getCachedRanges(sourceKey);
    const duration = this.mediaInfo.duration;

    if (duration <= 0) {
      return [];
    }

    // Convert byte ranges to time ranges using linear estimation
    const timeRanges: Array<{ start: number; end: number }> = [];

    for (const range of byteRanges) {
      const startRatio = range.offset / this.fileSize;
      const endRatio = (range.offset + range.length) / this.fileSize;

      const start = Math.max(0, Math.min(duration, startRatio * duration));
      const end = Math.max(0, Math.min(duration, endRatio * duration));

      if (end > start) {
        timeRanges.push({ start, end });
      }
    }

    return timeRanges;
  }

  /**
   * Get current state
   */
  getState(): PlayerState {
    if (this.hlsWrapper) {
      return this.hlsWrapper.getState();
    }
    return this.stateManager.getState();
  }

  /**
   * Get media info
   */
  getMediaInfo(): MediaInfo | null {
    return this.mediaInfo;
  }

  resizeCanvas(width: number, height: number): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.resizeCanvas(width, height);
    }
    if (this.videoRenderer) {
      this.videoRenderer.resize(width, height);
    }
  }

  /**
   * Set HDR enabled state
   */
  setHDREnabled(enabled: boolean): void {
    this.thumbnailHDREnabled = enabled;
    if (this.videoRenderer && (this.videoRenderer as any).setHDREnabled) {
      (this.videoRenderer as any).setHDREnabled(enabled);
    }

    if (this.thumbnailRenderer) {
      this.thumbnailRenderer.setHDREnabled(enabled);
    }

    // For non-Chromium browsers with tone mapping shader, just update the uniform
    // No need to recreate the entire context
    /* Manual WebGL update logic removed */
  }

  /**
   * Check if current media is HDR
   */
  isHDRSupported(): boolean {
    if (this.videoRenderer && (this.videoRenderer as any).isHDRSupported) {
      return (this.videoRenderer as any).isHDRSupported();
    }
    return false;
  }

  /**
   * Set subtitle overlay element for HTML-based subtitle rendering
   */
  setSubtitleOverlay(overlay: HTMLElement | null): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleOverlay(overlay);
    }
  }

  setFitMode(mode: "contain" | "cover" | "fill" | "zoom" | "control"): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.setFitMode(mode);
    }
    if (this.videoRenderer) {
      this.videoRenderer.setFitMode(mode);
    }
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate: number): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.setPlaybackRate(rate);
    }

    this.clock.setPlaybackRate(rate);

    // Update audio renderer playback rate
    if (this.audioRenderer) {
      this.audioRenderer.setPlaybackRate(rate);
    }

    // Update video renderer playback rate
    if (this.videoRenderer) {
      this.videoRenderer.setPlaybackRate(rate);
    }
  }

  /**
   * Get playback rate
   */
  getPlaybackRate(): number {
    if (this.hlsWrapper) {
      return this.hlsWrapper.getPlaybackRate();
    }
    return this.clock.getPlaybackRate();
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.setVolume(volume);
    }
    this.audioRenderer.setVolume(volume);
  }

  /**
   * Get volume (0-1)
   */
  getVolume(): number {
    if (this.hlsWrapper) {
      return this.hlsWrapper.getVolume();
    }
    return this.audioRenderer.getVolume();
  }

  /**
   * Set muted state
   * When muted, audio track processing is disabled to save CPU
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return; // No change

    this.muted = muted;
    if (this.hlsWrapper) {
      this.hlsWrapper.setMuted(muted);
      return;
    }

    if (muted) {
      this.audioRenderer.mute();
    } else {
      // unmute() is async (initializes AudioContext on first unmute)
      // but we don't await it to keep setMuted() synchronous
      this.audioRenderer.unmute().catch((err) => {
        Logger.error("MoviPlayer", "Failed to unmute", err);
      });
    }
  }

  /**
   * Get muted state
   */
  getMuted(): boolean {
    return this.muted;
  }

  /**
   * Request WakeLock to prevent screen sleep
   */
  private async requestWakeLock(): Promise<void> {
    // Check if WakeLock API is available
    if (!("wakeLock" in navigator)) {
      Logger.debug(TAG, "WakeLock API not available");
      return;
    }

    try {
      // Release existing wakeLock if any
      if (this.wakeLock) {
        await this.releaseWakeLock();
      }

      // Request new wakeLock
      const wakeLock = await (navigator as any).wakeLock.request("screen");
      this.wakeLock = wakeLock;
      Logger.debug(TAG, "WakeLock acquired");

      // Handle wakeLock release (e.g., user switches tab, screen locks)
      wakeLock.addEventListener("release", () => {
        Logger.debug(TAG, "WakeLock released by system");
        this.wakeLock = null;
      });
    } catch (error) {
      Logger.warn(TAG, "Failed to acquire WakeLock", error);
      this.wakeLock = null;
    }
  }

  /**
   * Handle visibility change
   */
  private handleVisibilityChange = async (): Promise<void> => {
    // If the page becomes visible again and we are playing, we MUST re-acquire the lock.
    // The browser automatically releases the lock when visibility is lost (e.g. minimizing,
    // switching tabs, or potentially during the "black screen" transition of a lid close).
    if (
      document.visibilityState === "visible" &&
      this.stateManager.getState() === "playing"
    ) {
      // Small delay to ensure browser is ready
      setTimeout(() => {
        if (this.stateManager.getState() === "playing") {
          Logger.debug(TAG, "Visibility restored, re-acquiring WakeLock");
          this.requestWakeLock();
        }
      }, 1000);
    }
  };

  /**
   * Release WakeLock
   */
  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        Logger.debug(TAG, "WakeLock released");
      } catch (error) {
        Logger.warn(TAG, "Failed to release WakeLock", error);
        this.wakeLock = null;
      }
    }
  }

  /**
   * Get buffered time in seconds
   * Returns the furthest time position that has been buffered
   */
  getBufferedTime(): number {
    if (this.hlsWrapper) {
      return this.hlsWrapper.getBufferEndTime();
    }

    if (!this.mediaInfo || !this.source) {
      return 0;
    }

    const duration = this.mediaInfo.duration;
    if (duration <= 0) {
      return 0;
    }

    // For HttpSource, convert buffered bytes to time using stable linear estimation.
    // Transient bitrate-based estimation is unstable during seeks.
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      const bufferedBytes = this.source.getBufferedEnd();
      if (bufferedBytes > 0) {
        const ratio = Math.min(1, bufferedBytes / this.fileSize);
        const bufferedTime = ratio * duration;

        // Ensure buffer appears at least as far as current playback position
        // This prevents buffer bar from appearing behind progress bar
        return Math.max(bufferedTime, this.getCurrentTime());
      }
    }

    // For FileSource, the entire file is buffered
    if (this.source instanceof FileSource) {
      return duration;
    }

    return 0;
  }

  /**
   * Check if current source is HttpSource
   */
  isHttpSource(): boolean {
    return this.source instanceof HttpSource;
  }

  /**
   * Get buffer start position in bytes (for HttpSource)
   * Returns -1 if not available or not HttpSource
   */
  getBufferStartBytes(): number {
    if (this.source instanceof HttpSource) {
      return this.source.getBufferStart();
    }
    return -1;
  }

  /**
   * Get buffer end position in bytes (for HttpSource)
   * Returns -1 if not available or not HttpSource
   */
  getBufferEndBytes(): number {
    if (this.source instanceof HttpSource) {
      return this.source.getBufferedEnd();
    }
    return -1;
  }

  /**
   * Get buffer start time in seconds (for HttpSource)
   * Converts buffer start bytes to time position using current read position as reference
   */
  getBufferStartTime(): number {
    if (
      !this.mediaInfo ||
      !this.source ||
      !(this.source instanceof HttpSource) ||
      this.fileSize <= 0
    ) {
      return 0;
    }

    const duration = this.mediaInfo.duration;
    // For HttpSource, convert buffer start bytes to time using stable linear estimation
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      const bufferStartBytes = this.source.getBufferStart();
      const ratio = Math.min(1, bufferStartBytes / this.fileSize);
      return ratio * duration;
    }
    return 0;
  }

  /**
   * Get buffer end time in seconds (for HttpSource)
   * Same as getBufferedTime but more explicit
   */
  getBufferEndTime(): number {
    return this.getBufferedTime();
  }

  /**
   * Get the source adapter (for checking buffer status, etc.)
   */
  getSource(): SourceAdapter | null {
    return this.source;
  }

  /**
   * Set log level
   */
  static setLogLevel(level: LogLevel): void {
    Logger.setLevel(level);
    // Also update FFmpeg log level for all active bindings
    updateAllBindingsLogLevel(level);
  }

  /**
   * Get the video element renderer (for faststart conversion access)
   * Returns null if not using MSE mode
   */
  /**
   * Check if video decoding is falling back to software
   */
  isSoftwareDecoding(): boolean {
    return this.videoDecoder ? this.videoDecoder.isSoftware : false;
  }

  /**
   * Destroy player and release resources
   */
  destroy(): void {
    Logger.info(TAG, "Destroying player");

    // Release WakeLock
    this.releaseWakeLock();

    // Stop playback
    this.clock.pause();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }

    // Destroy HLS wrapper
    if (this.hlsWrapper) {
      this.hlsWrapper.destroy();
      this.hlsWrapper = null;
    }

    // Close resources
    this.videoDecoder.close();
    this.audioDecoder.close();

    if (this.videoRenderer) {
      this.videoRenderer.destroy();
    }
    this.audioRenderer.destroy();

    // Close demuxer
    if (this.demuxer) {
      this.demuxer.close();
      this.demuxer = null;
    }

    // Close source
    if (this.source) {
      this.source.close();
      this.source = null;
    }

    // Clear cache
    this.cache.clear();

    // Clear track manager
    this.trackManager.clear();

    // Reset state
    this.stateManager.reset();
    this.mediaInfo = null;

    // Remove all listeners
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.removeAllListeners();

    Logger.info(TAG, "Player destroyed");
  }
}
