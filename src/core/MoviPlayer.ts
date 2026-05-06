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
  AudioSourceEntry,
  SubtitleTrack,
  SubtitleSourceEntry,
  SubtitleCue,
  Packet,
} from "../types";
import { EventEmitter } from "../events/EventEmitter";
import {
  HttpSource,
  FileSource,
  ThumbnailHttpSource,
  EncryptedHttpSource,
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

  // Separate audio source — uses native <audio> element (zero WASM overhead)
  private nativeAudioEl: HTMLAudioElement | null = null;
  private _audioTracks: AudioSourceEntry[] = [];
  private _activeAudioLang: string = "";

  // External subtitle tracks (VTT/SRT)
  private _subtitleTracks: SubtitleSourceEntry[] = [];
  private _activeSubtitleLang: string = "";
  private _externalSubCues: SubtitleCue[] = [];
  private _externalSubTimer: number | null = null;
  public trackManager: TrackManager;
  private clock: Clock;
  private stateManager: PlayerStateManager;
  private mediaInfo: MediaInfo | null = null;
  private fileSize: number = -1; // Cached file size for buffer calculations
  private lastBufferedTime: number = 0;

  // Decoders and Renderers
  private videoDecoder: MoviVideoDecoder;
  private audioDecoder: MoviAudioDecoder;
  private subtitleDecoder: SubtitleDecoder | null = null;
  private videoRenderer: CanvasRenderer | null = null;

  // Stream id of the subtitle track whose entire cue list has already been
  // prefetched into the renderer cache. Used to avoid scanning twice when
  // the user nudges the delay value while the same track is active.
  private prefetchedSubtitleStream: number | null = null;
  private prefetchInFlight: boolean = false;

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
  private _stallStartTime: number = 0; // When stall was first detected
  private _bufferingEntryTime: number = 0; // When we entered buffering state
  private _playStartTime: number = 0; // When play() was called — grace period for stall detection
  private _decoderStuckSince: number = 0; // When video decoder was first detected stuck
  private _lastDesyncSeekTime: number = 0; // performance.now() of last desync-triggered resync

  // Playback Loop
  private animationFrameId: number | null = null;
  private backgroundIntervalId: number | null = null;
  private backgroundWorker: Worker | null = null; // Worker-based timer for Safari
  private isBackgrounded: boolean = false; // True when tab is hidden (background)

  // WakeLock to prevent screen sleep during playback
  private wakeLock: WakeLockSentinel | null = null;

  // Seek state - track if we need to skip to keyframe after seek
  private seekingToKeyframe: boolean = false;
  private seekingToKeyframeStartTime: number = 0;
  private static readonly KEYFRAME_SEEK_TIMEOUT = 5000; // 5 seconds timeout

  // Prebuffer targets — accumulate this much before reporting "ready" so
  // play() doesn't immediately stall on short videos where the demux burst
  // outruns the HTTP stream.
  private static readonly PREBUFFER_AUDIO_SECONDS = 0.5;
  private static readonly PREBUFFER_VIDEO_FRAMES = 2;
  private static readonly PREBUFFER_MAX_WALL_MS = 5000;
  private static readonly PREBUFFER_MAX_PACKETS = 400;

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

  // Packets read during prebuffer — stashed unmodified so that normal
  // playback consumes them before resuming demux. We cannot decode during
  // prebuffer because (a) video frames would be dropped by the "playing"
  // state gate in setOnFrame and (b) the audio renderer eagerly schedules
  // buffers on AudioContext which would start audio playback early.
  private pendingPrebufferPackets: Packet[] = [];

  // Post-seek throttling to prevent stuttering on low-end devices
  private justSeeked: boolean = false;
  private seekTime: number = 0;
  private startTime: number = 0; // Media start time (PTS offset)
  private static readonly POST_SEEK_THROTTLE_MS = 1000; // Throttle aggressive buffering for 1000ms after seek to stabilize playback

  // Pause-time buffering: continue demuxing while paused so seek within buffered
  // area is instant and playback resumes without stall (like YouTube).
  // YouTube buffers ~2-5 minutes ahead while paused, then stops.
  private pauseBufferTimerId: number | null = null;
  private static readonly PAUSE_BUFFER_INTERVAL_MS = 100; // Demux every 100ms while paused
  private static readonly PAUSE_BUFFER_MAX_PACKETS = 3000; // Safety cap on packet count
  private static readonly PAUSE_BUFFER_AUDIO_SECONDS = 180; // ~3 minutes audio ahead (YouTube-like)
  private static readonly PAUSE_BUFFER_VIDEO_FRAMES = 5400; // ~3 minutes @ 30fps

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
        // Background mode: drop video frames silently (audio keeps playing)
        // But keep frames if PiP is active (canvas is visible in PiP window)
        if (document.hidden && !this.isPiPActive) {
          frame.close();
          return;
        }

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

          // Video reached target! If a seek is awaiting sync, fire the
          // completion path. Otherwise the guard was set in filter-only
          // mode (first-play / post-prefetch resume) just to drop pre-target
          // frames produced by Open-GOP recovery — we just clear the guard
          // so subsequent frames flow through without re-entering this
          // branch (which would log a warn-spam every frame).
          if (this.seekTargetTime !== -1) {
            if (this.waitingForVideoSync) {
              Logger.debug(TAG, `onFrame: frameTime=${frameTime.toFixed(3)}s >= seekTargetTime=${this.seekTargetTime.toFixed(3)}s, calling notifySeekCompletion`);
              this.notifySeekCompletion(frameTime);
            } else {
              this.seekTargetTime = -1;
            }
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

    // Handle network recovery: re-seek to current position to restart cleanly
    window.addEventListener("online", this.handleNetworkOnline);
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
    this.lastBufferedTime = 0;

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

      // Separate audio source: use native <audio> element (zero WASM overhead)
      // Supports single audioSource or multi-language audioTracks
      let audioUrl: string | null = null;

      if (this.config.audioTracks && this.config.audioTracks.length > 0) {
        // Multi-language mode — store all tracks, pick first as default
        this._audioTracks = [...this.config.audioTracks];
        this._activeAudioLang = this._audioTracks[0].lang;
        audioUrl = this._audioTracks[0].url;
        Logger.info(TAG, `Multi-language audio: ${this._audioTracks.length} tracks, default=${this._activeAudioLang}`);
      } else if (this.config.audioSource?.type === "url" && this.config.audioSource.url) {
        // Single separate audio source
        audioUrl = this.config.audioSource.url;
      }

      if (audioUrl) {
        this.setupNativeAudio(audioUrl);
      }

      // Store external subtitle tracks
      if (this.config.subtitleTracks && this.config.subtitleTracks.length > 0) {
        this._subtitleTracks = [...this.config.subtitleTracks];
        Logger.info(TAG, `External subtitles: ${this._subtitleTracks.length} tracks`);
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

      // Prebuffer a small amount of media so play() doesn't immediately
      // stall on short videos (see prebuffer() for details).
      await this.prebuffer();

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
      const fs = new FileSource(config.file, this.cache);
      fs.setOnRevoked((info) => {
        Logger.error(TAG, `File handle revoked: ${info.reason}`);
        this.emit("filerevoked", info);
      });
      return fs;
    }

    if (config.type === "encrypted" && config.encrypted) {
      return new EncryptedHttpSource({
        ...config.encrypted,
        headers: config.headers,
      });
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
            videoTrack.pixelFormat,
          );
        }
      } else {
        Logger.warn(TAG, "Failed to configure video decoder");
      }
    }

    // Configure audio decoder (skip if disabled for debugging)
    // Configure audio decoder (skip if disabled for debugging or native audio)
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
        // Pre-initialize AudioContext during load (created suspended, no audio plays).
        // Moves ~500ms creation cost from play() to load() for instant playback start.
        // init() no longer resumes — play() handles resume on user gesture.
        if (!this.disableAudio) {
          this.audioRenderer.init().catch(() => {});
        }
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
   * Pre-read a small amount of media before reporting "ready" and stash the
   * packets for the normal demux loop to consume. On short videos the demux
   * burst can drain the file faster than the HTTP source delivers bytes,
   * tripping the stall detector the moment play() starts; reading ahead
   * gives the source layer more time to buffer bytes.
   *
   * We deliberately do NOT decode here — the video decoder's onFrame
   * callback drops frames whenever state !== "playing", and the audio
   * renderer starts AudioContext playback the moment samples arrive. Both
   * break if we decode during prebuffer.
   */
  private async prebuffer(): Promise<void> {
    if (!this.demuxer) return;

    const hasVideoTrack = !!this.trackManager.getActiveVideoTrack();
    const hasInFileAudio =
      !!this.trackManager.getActiveAudioTrack() &&
      !this.disableAudio &&
      !this.nativeAudioEl;

    if (!hasVideoTrack && !hasInFileAudio) return;

    const startWall = performance.now();
    let videoPacketsStashed = 0;
    let audioDurationStashed = 0;
    let eof = false;

    const videoTargetMet = () =>
      !hasVideoTrack ||
      videoPacketsStashed >= MoviPlayer.PREBUFFER_VIDEO_FRAMES;
    const audioTargetMet = () =>
      !hasInFileAudio ||
      audioDurationStashed >= MoviPlayer.PREBUFFER_AUDIO_SECONDS;

    while (
      (!videoTargetMet() || !audioTargetMet()) &&
      !eof &&
      this.pendingPrebufferPackets.length < MoviPlayer.PREBUFFER_MAX_PACKETS
    ) {
      if (performance.now() - startWall > MoviPlayer.PREBUFFER_MAX_WALL_MS) {
        Logger.warn(
          TAG,
          `Prebuffer wall-clock timeout after ${MoviPlayer.PREBUFFER_MAX_WALL_MS}ms`,
        );
        break;
      }

      let packet: Packet | null;
      try {
        packet = await this.demuxer.readPacket();
      } catch (err) {
        Logger.warn(TAG, "Prebuffer demux error, aborting prebuffer", err);
        break;
      }

      if (!packet) {
        eof = true;
        break;
      }

      this.pendingPrebufferPackets.push(packet);

      if (!this.trackManager.isActiveStream(packet.streamIndex)) continue;

      const activeVideo = this.trackManager.getActiveVideoTrack();
      const activeAudio = this.trackManager.getActiveAudioTrack();

      if (
        hasVideoTrack &&
        activeVideo &&
        activeVideo.id === packet.streamIndex
      ) {
        videoPacketsStashed++;
      } else if (
        hasInFileAudio &&
        activeAudio &&
        activeAudio.id === packet.streamIndex
      ) {
        audioDurationStashed += packet.duration > 0 ? packet.duration : 0.02;
      }
    }

    Logger.info(
      TAG,
      `Prebuffer complete: stashed=${this.pendingPrebufferPackets.length}, video=${videoPacketsStashed}, audio=${audioDurationStashed.toFixed(2)}s, eof=${eof}`,
    );
  }

  /**
   * Start playback
   */
  async play(): Promise<void> {
    if (this.hlsWrapper) {
      return this.hlsWrapper.play();
    }

    // Stop pause-time buffering — we're resuming active playback
    this.stopPauseBuffering();

    if (!this.stateManager.canPlay()) {
      Logger.warn(TAG, "Cannot play in current state");
      return;
    }

    const currentState = this.stateManager.getState();

    // During buffering or seeking, mark intent to resume when ready
    if (currentState === "buffering" || currentState === "seeking") {
      this.wasPlayingBeforeRebuffer = true;
      Logger.info(TAG, `Play requested during ${currentState} — will resume when ready`);
      return;
    }

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
        if (this.nativeAudioEl) this.nativeAudioEl.currentTime = this.startTime;
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

    // Fire-and-forget WakeLock (no need to block play for screen sleep prevention)
    this.requestWakeLock();

    // First play after poster seek: re-seek demuxer to the clock's current
    // time. Poster seek's processLoop reads the demuxer ahead (~1s) while
    // decoding the first video frame, so the demuxer cursor is out of sync
    // with where we actually want playback to start. Re-seeking realigns it.
    //
    // IMPORTANT: respect any user seek that happened before the first play —
    // read the target from the clock (which getTime() reports as paused or
    // seeked position), NOT the hardcoded startTime. Previously we always
    // seeked to startTime here, which silently discarded a pre-play scrub
    // and restarted from the beginning.
    if (this._playStartTime === 0 && this.demuxer) {
      const targetTime = this.clock.getTime();

      // Flush the decode pipeline before re-seeking the demuxer. The
      // poster seek's processLoop bursts ~40 packets per rAF, racing the
      // demuxer cursor ahead of pts=0 while it hunts for the first video
      // frame. Without a flush + audio reset here, the first audio packet
      // that surfaces after demuxer.seek(targetTime) can land at a stale
      // interleaved PTS (e.g. 2.6s), anchoring firstBufferMediaTime there
      // and forcing video to skip ahead to catch up — the first-play
      // stutter. Mirrors the replay path which flushes + resets first.
      await this.videoDecoder.flush();
      await this.audioDecoder.flush();
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      this.audioRenderer.reset();

      // Seek the demuxer first; only after it completes do we resume the
      // audio context. Running them concurrently let the audio renderer
      // accept the very first decoded packet before the demuxer cursor
      // had finished rewinding.
      await this.demuxer.seek(targetTime);
      // After Open-GOP recovery (decoder rejected the first keyframe past
      // the seek target and reset), the next decoded frames will begin at
      // the previous GOP's keyframe — often 1-2s behind targetTime. Without
      // the seekTargetTime guard those pre-target frames get presented and
      // video lags audio for the rest of the GOP. Re-arm only the filter
      // (not waitingForVideoSync) — onFrame's pre-target drop check at the
      // top of the handler reads seekTargetTime alone, while leaving
      // waitingForVideoSync false keeps notifySeekCompletion from firing
      // and clobbering the state machine that play() is about to drive
      // into "playing" right below.
      this.seekTargetTime = targetTime;
      if (!this.disableAudio) {
        await this.audioRenderer.play();
      }
      this.clock.seek(targetTime);
      this.pendingAudioPackets = [];
      // Discard pause-time buffered packets — demuxer was just re-seeked,
      // so stashed packets are stale (would feed later timestamps into the
      // decoder, making first frame jump ahead instead of starting at targetTime).
      this.pendingPrebufferPackets = [];
      this.eofReached = false;
    } else {
      // Resume from pause — just resume AudioContext
      if (!this.disableAudio) {
        await this.audioRenderer.play();
      } else {
        Logger.debug(TAG, "Audio playback skipped (disabled for debugging)");
      }

      // Drop frames left in the queue that are stale relative to the clock.
      // This handles the rapid open→play→fullscreen→track-toggle case where
      // a decoder reset (Open GOP) re-decodes from an earlier reference
      // frame, leaves those frames queued during pause, and then presents
      // them on resume — causing a multi-second video lag behind audio.
      if (this.videoRenderer) {
        this.videoRenderer.dropStaleFrames(this.clock.getTime(), 0.2);
      }
    }

    // Start video presentation loop for smooth 60Hz playback
    if (this.videoRenderer) {
      this.videoRenderer.startPresentationLoop();
    }

    // Start native audio BEFORE clock so it becomes master immediately.
    // If autoplay is blocked, abort the play() and stay paused so the user
    // can resume with a gesture — otherwise video would advance without
    // audio and the clock would never sync.
    if (this.nativeAudioEl) {
      this.nativeAudioEl.playbackRate = this.clock.getPlaybackRate();
      try {
        await this.nativeAudioEl.play();
      } catch {
        Logger.warn(TAG, "Native audio play blocked — staying paused for user gesture");
        if (!this.disableAudio) this.audioRenderer.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        if (this.stateManager.getState() !== "paused") {
          this.stateManager.setState("paused");
        }
        return;
      }
    }

    this.clock.start();
    this._playStartTime = performance.now();

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

    // During buffering, transition to paused and stop auto-resume
    if (this.stateManager.getState() === "buffering") {
      this.wasPlayingBeforeRebuffer = false;
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.nativeAudioEl) this.nativeAudioEl.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
      this.stateManager.setState("paused");
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.stopBackgroundTimer();
      this.startPauseBuffering();
      Logger.info(TAG, "Paused during buffering");
      return;
    }

    // Release WakeLock when pausing
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }
    if (this.nativeAudioEl) {
      this.nativeAudioEl.pause();
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
    this.stopBackgroundTimer();

    // Continue buffering ahead while paused (YouTube-like behavior)
    this.startPauseBuffering();

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

    // Sync correction: Match clock to actual video/audio start time.
    //
    // When video arrives late (hardware decode lag, or no keyframe at the
    // exact seek target), we have two options:
    //
    //   a) Sync clock to earliest audio packet — audio stays continuous, but
    //      video frame sits queued until clock catches up, so the user hears
    //      audio while the video is frozen/stale for the gap duration.
    //
    //   b) Sync clock to video frame time — drops the stale audio packets
    //      between seek target and video time, but A/V stays coherent.
    //
    // Small gaps (< 200ms) are imperceptible, so (a) wins. Large gaps (from
    // sparse keyframes / slow HEVC+HDR decoders) were causing bad user-facing
    // desync: video and audio visibly drifting for nearly a second. For those
    // we now prefer (b) — a brief audio skip beats sustained A/V mismatch.
    if (time > seekTarget + 0.01) {
      const AUDIO_SYNC_GAP_LIMIT = 0.2;
      let syncTime = time;
      let syncedToAudio = false;

      if (this.pendingAudioPackets.length > 0) {
        const earliestAudioTime = Math.min(
          ...this.pendingAudioPackets.map((p) => p.timestamp)
        );

        if (earliestAudioTime < time) {
          const gap = time - earliestAudioTime;
          if (gap <= AUDIO_SYNC_GAP_LIMIT) {
            syncTime = earliestAudioTime;
            syncedToAudio = true;
            Logger.debug(
              TAG,
              `Video arrived late (${time.toFixed(3)}s), syncing clock to earliest audio (${syncTime.toFixed(3)}s) — gap ${(gap * 1000).toFixed(0)}ms`,
            );
          } else {
            Logger.info(
              TAG,
              `Video-audio gap ${(gap * 1000).toFixed(0)}ms exceeds ${AUDIO_SYNC_GAP_LIMIT * 1000}ms; syncing clock to video (${time.toFixed(3)}s) and dropping stale audio before that`,
            );
          }
        } else {
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

      // Filter audio packets:
      //  - synced to audio: keep everything from seek target onward
      //  - synced to video: drop audio before the video frame so AV stays
      //    aligned after the seek
      const cutoff = syncedToAudio ? seekTarget - 0.01 : syncTime - 0.01;
      this.pendingAudioPackets = this.pendingAudioPackets.filter(
        (p) => p.timestamp >= cutoff,
      );
    }

    // Transition to final state
    if (this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer) {
      Logger.info(TAG, "Resuming playback after seek");
      this.wasPlayingBeforeRebuffer = false;
      this.stateManager.setState("playing");
      this.clock.start();
      if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
        this.audioRenderer.play();
      }

      // Flush buffered audio packets AFTER play() so AudioRenderer.isPlaying=true
      // and render() accepts the decoded AudioData instead of dropping it.
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
    } else {
      Logger.info(TAG, "Seek completed in paused state");
      this.stateManager.setState("paused");

      // Don't decode audio now (AudioRenderer not playing — would drop all data).
      // Discard stashed audio and prebuffer packets — play() will re-seek the
      // demuxer to startTime so all packets will be re-read fresh from 0.
      // Keeping stale packets causes A/V desync (prebuffer audio at 0.4s+
      // would be processed before fresh audio at 0s).
      this.pendingAudioPackets = [];
      this.pendingPrebufferPackets = [];

      // Don't start clock or audio — but continue buffering ahead
      this.startPauseBuffering();
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
        this._bufferingEntryTime = performance.now();
        this.stateManager.setState("buffering");
        this.clock.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        Logger.debug(TAG, "Entered buffering state for playback rate change");
      }
      // Continue processing to allow new audio to be decoded and scheduled
    } else if (this.stateManager.getState() === "buffering" && this.wasPlayingBeforeRebuffer) {
      // Resume after minimum dwell time to accumulate enough data
      const hasAudioTrack = !!this.trackManager.getActiveAudioTrack();
      const audioReady = this.disableAudio || !hasAudioTrack || this.audioRenderer.getBufferedDuration() > 0.1;
      const videoReady = !this.videoRenderer || this.videoRenderer.getQueueSize() > 0;
      const dwellMs = performance.now() - this._bufferingEntryTime;
      const minDwell = 1500; // Wait at least 1.5s to accumulate buffer
      // Resume if: (1) both ready after minDwell, or (2) audio ready after longer wait
      // Video decoder output is async — don't block forever if frames are delayed
      const canResume = dwellMs >= minDwell && (
        (audioReady && videoReady) ||
        (audioReady && dwellMs >= 3000)
      );
      if (canResume) {
        this.stateManager.setState("paused");
        this.wasPlayingBeforeRebuffer = false;
        // Resume AudioContext before play() so audio picks up from where it was
        if (this.audioRenderer) {
          this.audioRenderer.resumeFromBuffering();
        }
        Logger.info(TAG, "Buffers refilled, resuming playback");
        this.play().catch((err) => {
          Logger.error(TAG, "Failed to resume playback after rebuffering:", err);
        });
      }
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

    // Stall detection: if playing but both video and audio buffers are critically low
    // Skip near end of video to avoid false stall at EOF
    const nearEnd = this.mediaInfo && this.clock.getTime() >= (this.mediaInfo.duration + this.startTime) - 3;
    // Longer stall timeout for slow + high-FPS: SoundTouch/hardware rate fallback
    // causes brief audio gaps that aren't true stalls. 2s vs 500ms default.
    const currentRate = this.clock.getPlaybackRate();
    const currentFps = (this.mediaInfo as any)?.videoFrameRate ?? 30;
    const isSlowHighFps = currentRate < 0.99 && currentFps >= 50;
    const stallTimeout = isSlowHighFps ? 2000 : 500;
    // Grace period after play() starts: allow decode pipeline to fill before stall detection.
    // Without this, clicking play on a poster triggers a false stall → buffering → loading spinner.
    const playGraceMs = 3000;
    const inPlayGrace = this._playStartTime > 0 && (performance.now() - this._playStartTime) < playGraceMs;
    if (this.stateManager.getState() === "playing" && !this.eofReached && !this.waitingForVideoSync && !nearEnd && !this.isBackgrounded && !inPlayGrace) {
      const videoEmpty = this.videoRenderer ? this.videoRenderer.getQueueSize() === 0 : false;
      const hasAudio = !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;
      const audioLow = !hasAudio || this.audioRenderer.getBufferedDuration() < 0.05;
      if (videoEmpty && audioLow) {
        if (!this._stallStartTime) {
          this._stallStartTime = performance.now();
        } else if (performance.now() - this._stallStartTime > stallTimeout) {
          // Only enter buffering after 500ms of continuous stall
          Logger.warn(TAG, "Stall detected: buffers empty for 500ms, entering buffering state");
          this.wasPlayingBeforeRebuffer = true;
          this._bufferingEntryTime = performance.now();
          this.stateManager.setState("buffering");
          this.clock.pause();
          // Suspend AudioContext so already-scheduled audio doesn't play ahead of video.
          // Keep isPlaying=true so render() still accepts AudioData and buffers fill up.
          if (this.audioRenderer) {
            this.audioRenderer.suspendForBuffering();
          }
          // Stop presentation loop so decoded frames accumulate in queue
          // (otherwise it keeps consuming them and videoReady never becomes true)
          if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
          this._stallStartTime = 0;
        }
      } else {
        this._stallStartTime = 0;
      }
    } else {
      this._stallStartTime = 0;
    }

    // Audio desync detection: if audio falls significantly behind video at 1x.
    // Clock syncs to audio so clock vs audio is always ~0. Compare audio against
    // maxScheduledMediaTime vs actual playback position to detect real desync.
    // Skip when muted — demux loop drops audio decode entirely (see muted check
    // in process loop), so getAudioClock() stays clamped and would falsely trip.
    if (this.stateManager.getState() === "playing" && !this.disableAudio && !this.muted && !inPlayGrace && Math.abs(this.clock.getPlaybackRate() - 1.0) < 0.01) {
      const audioTime = this.audioRenderer.getAudioClock();
      const videoTime = this.videoRenderer
        ? (this.videoRenderer as any).currentTime ?? -1
        : -1;
      if (audioTime >= 0 && videoTime > 0) {
        const audioBehind = videoTime - audioTime;
        // Cooldown: a resync seek itself takes ~1–2s, so back-to-back desync
        // detections trigger a stutter loop where almost no playback happens
        // between seeks (especially with slow software audio decoders). Wait
        // at least 5s between desync-driven seeks — better to tolerate a
        // sustained ~500ms offset than to pause every second.
        const sinceLastResync = performance.now() - this._lastDesyncSeekTime;
        if (audioBehind > 0.5 && sinceLastResync > 5000) {
          Logger.warn(TAG, `Audio desync detected: video=${videoTime.toFixed(2)}s, audio=${audioTime.toFixed(2)}s, behind=${(audioBehind * 1000).toFixed(0)}ms — resyncing`);
          this._lastDesyncSeekTime = performance.now();
          this.seek(this.getCurrentTime()).catch(() => {});
        }
      }
    }

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
      const currentTime = this.clock.getTime();
      const duration = this.mediaInfo?.duration ?? 0;
      const timeDone =
        currentTime >= duration + this.startTime - 0.5 || duration === 0;

      const hasAudioTrack = !!this.trackManager?.getActiveAudioTrack();

      if (hasAudioTrack) {
        // With audio: queue-based end is reliable (audio provides steady signal)
        const videoDone =
          !this.videoRenderer || this.videoRenderer.getQueueSize() === 0;
        const decodersDone =
          this.videoDecoder.queueSize === 0 && this.audioDecoder.queueSize === 0;
        if (timeDone || (decodersDone && videoDone)) {
          this.handleEnded();
          return;
        }
      } else {
        // Video-only: WebCodecs decodeQueueSize drops to 0 before all output
        // callbacks fire, making queue-based end unreliable. Use clock only.
        if (timeDone) {
          this.handleEnded();
          return;
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

    // Buffer targets — scale up at slow speeds so both audio and video buffers
    // hold the same wall-clock duration as at 1x. Without this, at 0.5x the 100-frame
    // video buffer lasts 3.3s wall-time while 2s audio buffer starves after 2s → stutter.
    const rate = Math.max(0.25, this.clock.getPlaybackRate());
    const rateScale = rate < 1.0 ? 1.0 / rate : 1.0; // e.g. 2x at 0.5x, 4x at 0.25x
    const maxAudioBuffered = (isSoftware ? 5.0 : isPostSeek ? 1.5 : 2.0) * rateScale;
    // Renderer queue limits (in frames)
    const maxVideoBuffered = Math.round((isSoftware ? 60 : isPostSeek ? 20 : 100) * rateScale);

    // Skip video backpressure when video isn't being consumed:
    // - Background (not PiP): video decode is skipped entirely
    // - Buffering: presentation loop stopped, frames accumulate but aren't consumed
    //   (must keep demuxing so audio data flows and isRebufferingForRateChange clears)
    const skipVideoBackpressure =
      (this.isBackgrounded && !this.isPiPActive) ||
      currentState === "buffering";

    // Stuck decoder detection: if video decoder queue is full but renderer queue
    // stays empty for too long, the decoder is hung (e.g. 8K content too heavy).
    // Flush it to unstick — some frames may be lost but playback continues.
    if (this.videoDecoder.queueSize > maxVideoQueue && videoBuffered === 0) {
      if (!this._decoderStuckSince) {
        this._decoderStuckSince = performance.now();
      } else if (performance.now() - this._decoderStuckSince > 5000) {
        Logger.warn(TAG, `Video decoder stuck for 5s (queue=${this.videoDecoder.queueSize}, output=0), flushing`);
        this.videoDecoder.flush().catch(() => {});
        this._decoderStuckSince = 0;
      }
    } else {
      this._decoderStuckSince = 0;
    }

    // When video buffer/decoder queue is full but audio is starving, don't block demuxing —
    // set a flag so the demux loop skips video decode while keeping audio flowing.
    // This is critical for high-FPS content (120fps) where the video decoder queue fills
    // faster than hardware can process, which would otherwise starve the audio pipeline.
    // ONLY at non-1x rates: at 1x, video/audio are consumed at the same rate so skipping
    // video is unnecessary and causes early EOF (video never decoded → queues empty → ended).
    const isNon1xRate = Math.abs(rate - 1.0) > 0.01;
    const audioStarving = !this.disableAudio && audioBuffered < 0.5;
    const videoDecoderFull = this.videoDecoder.queueSize > maxVideoQueue;
    const videoBufferFull = !skipVideoBackpressure && videoBuffered > maxVideoBuffered;
    const skipVideoDecodeForAudio = isNon1xRate && !this.muted && (videoBufferFull || videoDecoderFull) && audioStarving;

    if (
      (!skipVideoBackpressure && !skipVideoDecodeForAudio && this.videoDecoder.queueSize > maxVideoQueue) ||
      (!this.disableAudio && this.audioDecoder.queueSize > maxAudioQueue) ||
      (!this.disableAudio && audioBuffered > maxAudioBuffered) ||
      (!skipVideoBackpressure && !skipVideoDecodeForAudio && videoBuffered > maxVideoBuffered)
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

      // Determine burst size based on buffer levels, post-seek state, and FPS.
      // High-FPS content (120fps) has ~120 video packets per ~47 audio packets.
      // A burst of 20 may only yield 1-2 audio packets (~42ms) which isn't enough
      // to prevent audio buffer underruns between rAF callbacks (~16.7ms).
      const fps = this.trackManager?.getActiveVideoTrack()?.frameRate ?? 30;
      const fpsScale = Math.max(1, Math.ceil(fps / 30)); // 1x for 30fps, 2x for 60fps, 4x for 120fps
      let burstSize = 20 * fpsScale;

      if (isPostSeek) {
        burstSize = 5 * fpsScale;
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

        // If buffers are low, increase burst size to fill faster.
        // High-FPS needs more headroom because audio packets are sparse among video packets.
        // During initial play grace period with audio active, use a gentler burst to
        // avoid overwhelming the main thread (audio decode + render + stable audio
        // processing is CPU-heavy alongside 4K video decode).
        const bufferTarget = isSoftware ? 2.0 : fps >= 60 ? 1.0 : 0.5;
        if (videoQueue < 30 || currentAudioBuffered < bufferTarget) {
          if (inPlayGrace && !this.muted && !this.disableAudio && !isSoftware) {
            burstSize = 20 * fpsScale; // Gentler ramp during initial fill with audio
          } else {
            burstSize = (isSoftware ? 80 : 40) * fpsScale;
          }
        }
      }

      // For video-only content, throttle submissions based on renderer queue.
      // Without audio backpressure, all packets get submitted in one burst which
      // overwhelms VP8/software WebCodecs decoders (output callbacks stop firing).
      const hasAudioForBurst = !!this.trackManager?.getActiveAudioTrack() && !this.disableAudio;
      const maxRendererQueue = 60; // ~2.4s at 25fps, enough buffer without overwhelming

      // When decoder is skipping frames (waitingForKeyframe after error), limit burst
      // to prevent the demuxer from racing through the entire file in one rAF.
      // Without this, non-keyframes skip silently → no backpressure → early EOF.
      if (this.videoDecoder.isWaitingForKeyframe) {
        burstSize = Math.min(burstSize, 5);
      }

      for (let i = 0; i < burstSize; i++) {
        // Video-only throttle: if renderer queue is full enough, stop submitting
        // and let the presentation loop consume frames before adding more.
        if (!hasAudioForBurst && this.videoRenderer && this.videoRenderer.getQueueSize() > maxRendererQueue) {
          break;
        }

        // Check both video and audio queues after seek to prevent overwhelming decoders
        // When audio is starving, don't let video queue fullness stop the burst — we need
        // to keep reading packets to find audio data (video decode is skipped below).
        if (
          (!skipVideoDecodeForAudio && this.videoDecoder.queueSize > maxVideoQueue) ||
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
        // Scale with FPS — at 120fps, packets are small and fast, yielding too often starves audio
        const yieldInterval = isPostSeek ? 2 * fpsScale : isSoftware ? 3 : 20 * fpsScale;
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

        // Drain prebuffered packets first so play() doesn't re-read them
        // from the source. Stashed packets are pre-seek and always safe.
        let packet: Packet | null;
        if (this.pendingPrebufferPackets.length > 0) {
          packet = this.pendingPrebufferPackets.shift()!;
        } else {
          // When separate audio demuxer exists, primary demuxer only provides video/subtitle
          packet = await this.demuxer.readPacket();

          // Check again after async readPacket - seek may have started during read
          if (this.seekSessionId !== currentSessionId) {
            Logger.debug(
              TAG,
              "ProcessLoop aborted after readPacket: new seek started",
            );
            this.demuxInFlight = false; // Reset flag so new seek can proceed
            return;
          }
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
            // In background (not PiP), skip video decoding entirely.
            // This prevents frame queue buildup that blocks audio demuxing via backpressure.
            // At 60fps, video queue fills in ~1.7s and starves audio.
            if (this.isBackgrounded && !this.isPiPActive) {
              continue;
            }

            // Skip video decode when video buffer is full but audio is starving.
            // This keeps audio flowing at non-1x rates where video frames accumulate
            // faster than consumed. Some video frames are lost but audio stays smooth.
            if (skipVideoDecodeForAudio) {
              continue;
            }

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
            // Skip audio processing if disabled for debugging
            if (!this.disableAudio) {
              // IMPORTANT: Skip audio packets before the seek target time
              if (
                this.seekTargetTime !== -1 &&
                packet.timestamp < this.seekTargetTime
              ) {
                continue;
              }

              // If waiting for video frame to ensure sync, buffer audio packets
              // (even when muted — needed for clock alignment to start at 0s)
              if (
                this.waitingForVideoSync &&
                this.trackManager.getActiveVideoTrack()
              ) {
                this.pendingAudioPackets.push(packet);
                continue;
              }

              // Decode audio even when muted. AudioRenderer keeps gain at 0 so
              // it stays silent, but the audio clock advances normally — without
              // this, unmute pivots firstBufferMediaTime to wherever the demuxer
              // is (~1-3s ahead of presentation due to video buffer), and the
              // drift correction in CanvasRenderer judders the video to chase it.

              if (
                this.seekTargetTime !== -1 &&
                packet.timestamp >= this.seekTargetTime
              ) {
                Logger.debug(
                  TAG,
                  `Audio reached seek target: ${packet.timestamp.toFixed(3)}s (target: ${this.seekTargetTime.toFixed(3)}s)`,
                );
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
              let duration = packet.duration;
              if (!duration || duration <= 0) {
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
            }
          }
        }
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
    Logger.info(TAG, `seek(${seconds.toFixed(2)}): state=${currentState}, waitingForVideoSync=${this.waitingForVideoSync}, demuxInFlight=${this.demuxInFlight}, seekSessionId=${this.seekSessionId}`);

    // Safety check - though PlayerState now permits it
    if (!this.stateManager.canSeek()) {
      Logger.warn(TAG, `seek blocked: canSeek=false, state=${currentState}`);
      return;
    }

    if (!this.demuxer) {
      throw new Error("Demuxer not initialized");
    }

    // Stop pause-time buffering — seek invalidates stashed packets
    this.stopPauseBuffering();

    // Track intent: if we were playing (or already seeking but originally playing), we want to resume
    // During buffering, preserve the pre-buffering play/pause intent
    if (currentState !== "seeking") {
      this.wasPlayingBeforeSeek = currentState === "playing" || (currentState === "buffering" && this.wasPlayingBeforeRebuffer);
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
      Logger.info(TAG, `seek: flushing video decoder...`);
      await this.videoDecoder.flush();
      Logger.info(TAG, `seek: flushing audio decoder...`);
      await this.audioDecoder.flush();
      Logger.info(TAG, `seek: decoders flushed`);

      // Clear video frame queue to prevent old frames from being displayed
      if (this.videoRenderer) {
        this.videoRenderer.clearQueue();
      }

      // Flush audio renderer (clears buffers)
      this.audioRenderer.reset();

      if (this.seekSessionId !== mySessionId) return; // Superceded

      // Seek relative to start time (time 0 in UI = startTime in media)
      Logger.info(TAG, `seek: demuxer.seek(${(seconds + this.startTime).toFixed(2)}) starting...`);
      await this.demuxer.seek(seconds + this.startTime);
      // Seek native audio element (separate audio source)
      if (this.nativeAudioEl) {
        this.nativeAudioEl.currentTime = seconds;
      }
      Logger.info(TAG, `seek: demuxer.seek done`);
      this.clock.seek(seconds + this.startTime);

      // Reset EOF flag after seek - we're now at a new position
      this.eofReached = false;

      // Buffered region restarts from the new position; drop the
      // monotonic clamp so the bar can shrink to reflect the new range.
      this.lastBufferedTime = 0;

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
      // Stashed prebuffer packets are pre-seek and now stale
      this.pendingPrebufferPackets = [];

      // Enable post-seek throttling to prevent overwhelming low-end devices
      // BUT skip throttling when seeking within already-buffered data — the bytes
      // are already local so aggressive bursting won't cause network stalls.
      const seekInBufferedRange = this.isSeekTargetBuffered(seconds);
      if (seekInBufferedRange) {
        this.justSeeked = false;
        Logger.info(TAG, "Seek within buffered range — skipping post-seek throttle");
      } else {
        this.justSeeked = true;
      }
      this.seekTime = performance.now();

      if (this.seekSessionId !== mySessionId) return; // Superceded

      // Start processing loop to find and decode the target frame/packet.
      // notifySeekCompletion will be called once the first valid frame is received.
      Logger.info(TAG, `seek: starting processLoop, waitingForVideoSync=${this.waitingForVideoSync}, state=${this.stateManager.getState()}`);
      this.processLoop();

      // Ensure the video renderer loop is running to actually draw frames as they arrive
      if (this.videoRenderer) {
        this.videoRenderer.startPresentationLoop();
      }

      // Safety timeout: force seek completion if frames don't arrive in time.
      // Shorter timeout for buffered seeks since data is already local.
      const seekTimeoutMs = seekInBufferedRange ? 1500 : 3000;
      const seekTimeout = setTimeout(() => {
        if (this.seekSessionId === mySessionId && this.waitingForVideoSync) {
          Logger.warn(TAG, `Seek timeout after ${seekTimeoutMs}ms, forcing completion at ${seconds}s`);
          this.notifySeekCompletion(seconds + this.startTime);
        }
      }, seekTimeoutMs);

      // Clear timeout if seek completes or is superseded
      const clearSeekTimeout = () => {
        clearTimeout(seekTimeout);
        this.off("seeked", clearSeekTimeout);
      };
      this.on("seeked", clearSeekTimeout);

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
   * Check if seek target time falls within the already-buffered byte range.
   * Uses linear byte→time estimation (same as getBufferedTime).
   */
  private isSeekTargetBuffered(seekSeconds: number): boolean {
    if (!this.mediaInfo || !this.source || this.fileSize <= 0) return false;
    const duration = this.mediaInfo.duration;
    if (duration <= 0) return false;

    if (this.source instanceof FileSource) return true;

    if (this.source instanceof HttpSource) {
      // Entire file is in memory — every seek is local
      if (this.source.isFullyCached()) return true;

      const bufferStartBytes = this.source.getBufferStart();
      const bufferEndBytes = this.source.getBufferedEnd();
      // Convert seek target to estimated byte offset
      const seekRatio = Math.min(1, (seekSeconds + this.startTime) / (duration + this.startTime));
      const seekByteEstimate = seekRatio * this.fileSize;
      // Check if estimated byte position is within buffered window (with margin for keyframe before)
      const margin = this.fileSize * 0.02; // 2% margin for keyframe before target
      return seekByteEstimate >= bufferStartBytes - margin && seekByteEstimate <= bufferEndBytes;
    }

    // For other sources with getBufferedEnd
    if ("getBufferedEnd" in this.source) {
      const bufferEndBytes = (this.source as any).getBufferedEnd();
      if (bufferEndBytes > 0) {
        const seekRatio = Math.min(1, (seekSeconds + this.startTime) / (duration + this.startTime));
        const seekByteEstimate = seekRatio * this.fileSize;
        return seekByteEstimate <= bufferEndBytes;
      }
    }

    return false;
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
          try {
            await this.previewInitPromise;
          } catch {
            // Init failed, clear promise so retry can work
            this.previewInitPromise = null;
          }
        }
        // If still no bindings (init failed or promise was cleared), retry
        if (!this.thumbnailBindings) {
          Logger.debug(TAG, "Initializing thumbnail pipeline (retry)...");
          this.previewInitPromise = this.initPreviewPipeline();
          try {
            await this.previewInitPromise;
          } catch {
            this.previewInitPromise = null;
          }
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

          // When rotated, ensure 2D context exists (WebGL path doesn't handle rotation)
          if (rotation !== 0 && !this.thumbnailContext && this.thumbnailCanvas) {
            this.thumbnailContext = this.thumbnailCanvas.getContext("2d", {
              alpha: false,
              willReadFrequently: true,
            }) as any;
          }

          // Render using WebGL if available (skip WebGL when rotated — 2D handles rotation)
          if (
            rotation === 0 &&
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

  /**
   * Generate timeline thumbnails at regular intervals
   * @param count Number of thumbnails to generate (default 8)
   * @param onProgress Callback for each generated thumbnail
   * @returns Array of { time, blob } objects
   */
  async generateTimeline(
    count: number = 8,
    onProgress?: (index: number, total: number, blob: Blob, time: number) => void
  ): Promise<Array<{ time: number; blob: Blob }>> {
    const duration = this.mediaInfo?.duration ?? 0;
    if (duration <= 0) return [];

    const results: Array<{ time: number; blob: Blob }> = [];
    const interval = duration / (count + 1); // Avoid first/last frames

    for (let i = 1; i <= count; i++) {
      const time = interval * i;
      const blob = await this.getPreviewFrame(time);
      if (blob) {
        results.push({ time, blob });
        onProgress?.(i, count, blob, time);
      }
    }

    return results;
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

    // Encrypted playback: reuse the main EncryptedHttpSource for thumbnails.
    // A 2nd EncryptedHttpSource spins up an independent ECDH handshake +
    // token-signed GETs, which the server treats as concurrent sessions;
    // observed server behavior is 206 responses with truncated/empty
    // bodies (seen as "Stream ended before block N" errors) when both
    // instances fetch overlapping ranges. Sharing the main source also
    // makes thumbnail reads free once the block is in the main source's
    // block cache — no extra network at all for near-playhead previews.
    const sourceConfig = this.config.source;
    const isEncrypted = sourceConfig
      && typeof sourceConfig !== "string"
      && (sourceConfig as any).type === "encrypted";
    if (isEncrypted && this.source) {
      this.thumbnailSource = this.source;
    } else {
      // Plain HTTP / URL sources: use a dedicated ThumbnailHttpSource that
      // borrows (read-only) from the main source's metadata LRU +
      // sliding-window buffer, only fetching on miss.
      const borrowSource =
        this.source &&
        typeof (this.source as any).peekMetadata === "function" &&
        typeof (this.source as any).peekRange === "function"
          ? (this.source as any)
          : null;
      if (typeof sourceConfig === "string") {
        this.thumbnailSource = new ThumbnailHttpSource(sourceConfig, {}, borrowSource);
      } else if ("url" in sourceConfig && sourceConfig.url) {
        this.thumbnailSource = new ThumbnailHttpSource(
          sourceConfig.url,
          sourceConfig.headers || {},
          borrowSource,
        );
      } else {
        // File source
        this.thumbnailSource = await this.createSource(sourceConfig);
      }
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

    // Track changed — invalidate any prefetched cue list so the next
    // setSubtitleDelay re-scans the new stream.
    if (this.prefetchedSubtitleStream !== trackId) {
      this.prefetchedSubtitleStream = null;
    }

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

          // TODO: Seek to re-read subtitle packets causes playback disruption
          // const currentTime = this.getCurrentTime();
          // Logger.debug(TAG, `Seeking to ${currentTime.toFixed(2)}s to pick up subtitle packets`);
          // this.seek(currentTime).catch(() => {});

          // If a non-zero subtitle delay is already configured (e.g. set
          // before the track was selected, or persisted via attribute),
          // prefetch the full cue list now so the renderer has
          // out-of-order cues available immediately.
          if (this.videoRenderer && this.videoRenderer.getSubtitleDelay() !== 0) {
            void this.prefetchActiveSubtitleStream();
          }
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
  /**
   * Load an encrypted video source
   * Reconfigures the player with an EncryptedHttpSource
   */
  async loadEncrypted(config: {
    videoUrl: string;
    tokenUrl: string;
    videoId: string;
    fingerprint: string;
    sessionToken: string;
    tokenRefreshInterval?: number;
    onAuthFailed?: (reason: string) => void;
  }): Promise<void> {
    this.config.source = {
      type: "encrypted",
      encrypted: config,
    };
    await this.load();
  }

  getMediaInfo(): MediaInfo | null {
    return this.mediaInfo;
  }

  getContentDispositionFilename(): string | null {
    if (this.source instanceof HttpSource) {
      return this.source.getContentDispositionFilename();
    }
    return null;
  }

  getMetadataTitle(): string | null {
    return this.mediaInfo?.metadata?.title ?? null;
  }

  /**
   * Get HLS video element (DRM mode) for direct DOM insertion
   */
  getHLSVideoElement(): HTMLVideoElement | null {
    return this.hlsWrapper?.getVideoElement() ?? null;
  }


  /**
   * Get chapters from the media (empty array if none)
   */
  getChapters(): Array<{ title: string; start: number; end: number }> {
    return this.mediaInfo?.chapters ?? [];
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

  /**
   * Set extra bottom padding for subtitles when controls are visible
   */
  setSubtitleControlsPadding(padding: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleControlsPadding(padding);
    }
  }

  /**
   * Rotate video 90 degrees clockwise
   */
  rotateVideo(): number {
    if (this.videoRenderer) {
      return this.videoRenderer.rotate90();
    }
    return 0;
  }

  /**
   * Get current video rotation
   */
  getVideoRotation(): number {
    return this.videoRenderer?.getRotation() ?? 0;
  }

  setVideoRotation(deg: number): void {
    this.videoRenderer?.setManualRotation(deg);
  }

  setFitMode(mode: "contain" | "cover" | "fill" | "zoom" | "control"): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.setFitMode(mode);
    }
    if (this.videoRenderer) {
      this.videoRenderer.setFitMode(mode);
    }
  }

  setLetterboxColor(r: number, g: number, b: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setLetterboxColor(r, g, b);
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
    if (this.nativeAudioEl) {
      this.nativeAudioEl.playbackRate = rate;
    }

    // Flush both decoders on rate change to clear stale packets from previous rate.
    // On heavy content (8K), old packets block the decoder queue and cause hangs.
    // Audio decoder also needs flush — stale packets cause persistent stalling at 1x.
    if (this.stateManager.getState() === "playing" || this.stateManager.getState() === "buffering") {
      if (this.videoDecoder) this.videoDecoder.flush().catch(() => {});
      this.audioDecoder.flush().catch(() => {});
    }
  }

  /**
   * Setup native <audio> element for separate audio source.
   * Shared by single audioSource and multi-language audioTracks.
   */
  private setupNativeAudio(url: string): void {
    const wasPlaying = this.nativeAudioEl && !this.nativeAudioEl.paused;
    const currentTime = this.nativeAudioEl?.currentTime ?? 0;
    const sameSrc = this.nativeAudioEl && this.nativeAudioEl.src === url;

    // Reuse or create element
    if (!this.nativeAudioEl) {
      this.nativeAudioEl = new Audio();
    }
    // Skip src reassignment when adopting an already-playing element with the
    // same URL (quality switch where audio track is shared) — reassigning the
    // same src triggers a reload and loses the user-activated play() context.
    if (!sameSrc) {
      this.nativeAudioEl.src = url;
    }
    this.nativeAudioEl.preload = "auto";
    this.nativeAudioEl.volume = this.muted ? 0 : this.audioRenderer.getVolume();
    this.nativeAudioEl.muted = this.muted;
    this.disableAudio = true;

    // Wire up clock + video renderer to native audio.
    // When paused (e.g. autoplay blocked) currentTime stays at 0 but
    // readyState reports HAVE_FUTURE_DATA — Clock would then "sync" to
    // a frozen 0 and stall video. Return -1 so Clock falls back to wall
    // clock until the user gesture lets <audio> actually start.
    const audioEl = this.nativeAudioEl;
    const self = this;
    const isAudioReady = () => !audioEl.paused && audioEl.readyState >= 3;
    this.clock.setAudioProvider({
      getAudioClock: () => isAudioReady() ? audioEl.currentTime + self.startTime : -1,
      hasHealthyBuffer: isAudioReady,
      isAudioPlaying: () => !audioEl.paused,
    });
    if (this.videoRenderer) {
      this.videoRenderer.setAudioTimeProvider(
        () => isAudioReady() ? audioEl.currentTime + self.startTime : -1,
        isAudioReady,
      );
    }

    // Restore position and playback state when switching tracks
    if (currentTime > 0) {
      audioEl.currentTime = currentTime;
    }
    if (wasPlaying) {
      audioEl.play().catch(() => {});
    }
  }

  /**
   * Detach the native <audio> element from this player WITHOUT pausing it,
   * so it can be re-adopted by a successor instance during a quality switch.
   * Returns the element (or null) so callers can hand it to adoptNativeAudio
   * on the new player. Critical because creating a fresh Audio element after
   * a programmatic src swap loses the user-activation token and trips
   * browser autoplay policy on the way back up.
   */
  releaseNativeAudio(): HTMLAudioElement | null {
    const el = this.nativeAudioEl;
    if (el) {
      this.nativeAudioEl = null;
    }
    return el;
  }

  /**
   * Adopt an existing <audio> element before init() runs, so setupNativeAudio
   * sees a populated nativeAudioEl and reuses it (instead of constructing a
   * brand-new — and unactivated — Audio).
   */
  adoptNativeAudio(el: HTMLAudioElement): void {
    if (this.nativeAudioEl && this.nativeAudioEl !== el) {
      try { this.nativeAudioEl.pause(); } catch {}
    }
    this.nativeAudioEl = el;
  }

  /**
   * Get available audio language tracks (multi-language mode)
   */
  getAudioLangs(): { lang: string; label: string; active: boolean }[] {
    return this._audioTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this._activeAudioLang,
    }));
  }

  /**
   * Switch audio to an external language track (native <audio> element).
   * Disables WASM audio if it was active. Preserves position & playback.
   */
  selectAudioLang(lang: string): boolean {
    const track = this._audioTracks.find((t) => t.lang === lang);
    if (!track) {
      Logger.warn(TAG, `Audio track not found for lang: ${lang}`);
      return false;
    }
    if (lang === this._activeAudioLang && this.nativeAudioEl) return true;

    // Mute WASM audio if it was active (don't destroy — keep decodable for switch-back)
    if (!this.disableAudio) {
      this.audioRenderer.mute();
      this.disableAudio = true;
    }

    this._activeAudioLang = lang;
    this.setupNativeAudio(track.url);
    Logger.info(TAG, `Audio switched to external: ${track.label} (${track.lang})`);
    this.emit("audioTrackChange" as any, { lang, label: track.label });
    return true;
  }

  /**
   * Switch back to muxed (WASM) audio, disabling native <audio> element.
   * Called when user selects a demuxer audio track while external is active.
   */
  useMuxedAudio(): void {
    if (!this.nativeAudioEl) return;

    // Stop native audio
    this.nativeAudioEl.pause();
    this.nativeAudioEl.src = "";
    this.nativeAudioEl = null;
    this._activeAudioLang = "";

    // Re-enable WASM audio
    this.disableAudio = false;
    this.muted = false;
    this.audioRenderer.unmute().catch(() => {});

    // Restore WASM audio as clock provider
    this.clock.setAudioProvider(this.audioRenderer);
    if (this.videoRenderer) {
      this.videoRenderer.setAudioTimeProvider(
        () => this.audioRenderer.getAudioClock(),
        () => this.audioRenderer.hasHealthyBuffer(),
      );
    }

    Logger.info(TAG, "Switched back to muxed (WASM) audio");
  }

  /** Check if native audio is currently active */
  isNativeAudioActive(): boolean {
    return this.nativeAudioEl !== null && this._activeAudioLang !== "";
  }

  /** True whenever a native <audio> element is loaded (single split-source or multi-lang). */
  hasNativeAudio(): boolean {
    return this.nativeAudioEl !== null;
  }

  /**
   * True if any audio path is active that the user can mute / volume-control.
   * Covers muxed (WASM) tracks, split-source <audio>, and HLS streams whose
   * audio is muxed inside the native <video> element.
   */
  hasAudibleSource(): boolean {
    return (
      this.trackManager.getAudioTracks().length > 0 ||
      this.hasNativeAudio() ||
      this.hlsWrapper !== null
    );
  }

  /**
   * Get available external subtitle tracks
   */
  getSubtitleLangs(): { lang: string; label: string; active: boolean }[] {
    return this._subtitleTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this._activeSubtitleLang,
    }));
  }

  /**
   * Select an external subtitle track by language.
   * Fetches the VTT/SRT file, parses cues, and starts rendering.
   * Pass empty string or null to disable.
   */
  async selectSubtitleLang(lang: string | null): Promise<boolean> {
    // Disable current external subtitles
    this.stopExternalSubtitles();

    if (!lang) {
      this._activeSubtitleLang = "";
      if (this.videoRenderer) this.videoRenderer.clearSubtitles();
      this.emit("subtitleTrackChange" as any, { lang: null, label: null });
      return true;
    }

    const track = this._subtitleTracks.find((t) => t.lang === lang);
    if (!track) {
      Logger.warn(TAG, `Subtitle track not found for lang: ${lang}`);
      return false;
    }

    try {
      // Fetch subtitle file
      const res = await fetch(track.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      // Detect format
      const fmt = track.format || (track.url.includes(".srt") ? "srt" : "vtt");

      // Tell the renderer which format we're using so it can toggle the
      // VTT-only backdrop styling.
      this.videoRenderer?.setSubtitleFormat(fmt);

      // Parse into cues
      this._externalSubCues = fmt === "srt"
        ? this.parseSRT(text)
        : this.parseVTT(text);

      this._activeSubtitleLang = lang;

      // Disable muxed subtitles if active
      this.selectSubtitleTrack(null);

      // Start cue timer
      this.startExternalSubtitles();

      Logger.info(TAG, `Subtitle loaded: ${track.label} (${this._externalSubCues.length} cues)`);
      this.emit("subtitleTrackChange" as any, { lang, label: track.label });
      return true;
    } catch (e) {
      Logger.error(TAG, `Failed to load subtitle: ${track.url}`, e);
      return false;
    }
  }

  /** Parse VTT text into SubtitleCue[] */
  private parseVTT(text: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(
          /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
        );
        if (match) {
          const start = +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
          const end = +match[5] * 3600 + +match[6] * 60 + +match[7] + +match[8] / 1000;
          const cueText = lines.slice(i + 1).join("\n").trim();
          if (cueText) cues.push({ start, end, text: cueText });
          break;
        }
      }
    }
    return cues;
  }

  /** Parse SRT text into SubtitleCue[] */
  private parseSRT(text: string): SubtitleCue[] {
    // SRT has same timestamp format but with comma instead of dot — parseVTT handles both
    return this.parseVTT(text);
  }

  /** Start rendering external subtitle cues based on playback time */
  private startExternalSubtitles(): void {
    this.stopExternalSubtitles();
    let lastIdx = -1;
    this._externalSubTimer = window.setInterval(() => {
      if (!this.videoRenderer) return;
      const time = this.clock.getTime();
      // Find active cue
      const idx = this._externalSubCues.findIndex(
        (c) => time >= c.start && time <= c.end
      );
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (idx >= 0) {
          this.videoRenderer.setSubtitleCues([this._externalSubCues[idx]]);
        } else {
          this.videoRenderer.setSubtitleCues([]);
        }
      }
    }, 100); // 10Hz check — enough for subtitle timing
  }

  /** Stop external subtitle rendering */
  private stopExternalSubtitles(): void {
    if (this._externalSubTimer !== null) {
      clearInterval(this._externalSubTimer);
      this._externalSubTimer = null;
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
   * Set subtitle delay in seconds.
   * VLC/mpv convention: positive value = subtitles appear later than the
   * original cue timing, negative value = earlier. Useful when the subtitle
   * track is out of sync with the video due to different source releases or
   * frame-rate conversions.
   */
  setSubtitleDelay(seconds: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleDelay(seconds);
    }
    // Non-zero delay needs cues from stream positions the demuxer hasn't
    // necessarily reached yet (negative delay) or has already passed
    // (positive delay across a seek). Prefetch the full cue list once so
    // the renderer cache is authoritative regardless of demuxer position.
    // Zero delay falls back to the streaming path — no prefetch overhead.
    if (seconds !== 0) {
      void this.prefetchActiveSubtitleStream();
    }
  }

  /** Get current subtitle delay in seconds. */
  getSubtitleDelay(): number {
    return this.videoRenderer ? this.videoRenderer.getSubtitleDelay() : 0;
  }

  /**
   * Return every cue for the active subtitle stream, scanning it via the
   * C-side prefetch path if we haven't already done so. Used by the cues
   * browser UI — gives the caller a stable list to render and seek into.
   * Resolves to an empty array when no subtitle is active, the active
   * track is bitmap-only (PGS), or scanning fails.
   */
  async getAllSubtitleCues(): Promise<{ start: number; end: number; text: string }[]> {
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (!subtitleTrack) return [];
    if (subtitleTrack.subtitleType && subtitleTrack.subtitleType !== "text") return [];
    if (this.prefetchedSubtitleStream !== subtitleTrack.id) {
      await this.prefetchActiveSubtitleStream();
    }
    if (!this.videoRenderer) return [];
    // The renderer's cue cache is the canonical post-prefetch source —
    // prefetchActiveSubtitleStream pushes the full list into it via
    // setSubtitleCues. Reading it back avoids holding a duplicate copy
    // on MoviPlayer.
    return this.videoRenderer.getAllCues();
  }

  /**
   * Scan the active subtitle stream and seed the renderer with every cue.
   * No-op when the same stream has already been prefetched, when no
   * subtitle is selected, or when a prefetch is in flight. The demuxer is
   * left at EOF after the C-side scan, so we re-seek back to the current
   * playback position before returning.
   */
  private async prefetchActiveSubtitleStream(): Promise<void> {
    if (this.prefetchInFlight) return;
    if (!this.demuxer || !this.videoRenderer) return;
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (!subtitleTrack) return;
    if (this.prefetchedSubtitleStream === subtitleTrack.id) return;
    const bindings = this.demuxer.getBindings();
    if (!bindings) return;
    // Only support text subtitles — bitmap (PGS/dvd_subtitle) decoding
    // returns image data, which the prefetch text path can't carry across
    // and which the user-shift UI doesn't apply to anyway.
    if (subtitleTrack.subtitleType && subtitleTrack.subtitleType !== "text") return;

    this.prefetchInFlight = true;
    const resumeTime = this.clock.getTime();
    const wasPlaying = this.stateManager.getState() === "playing";

    // Quiesce all paths that touch the demuxer/decoders. Without this the
    // prefetch's seek-to-0 + sequential reads race the playback processLoop
    // (which is already mid-readPacket via Asyncify), corrupting the
    // js_read_async pending-read state and stalling playback indefinitely
    // ("No pending read to fulfill").
    this.stopPauseBuffering();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Bumping the seek session ID forces any in-flight processLoop iteration
    // to bail out at its next checkpoint instead of writing stale results.
    this.seekSessionId++;
    if (wasPlaying) {
      this.clock.pause();
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.nativeAudioEl) this.nativeAudioEl.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
    }
    // Wait for any demuxer call already in flight to land before we issue
    // our own. Asyncify won't let two reads/seeks overlap on the same
    // context; this poll is short because js_read_async resolves within a
    // single rAF once the JS side delivers the buffer.
    const maxWaitMs = 2000;
    const waitStart = performance.now();
    while (this.demuxInFlight && performance.now() - waitStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 10));
    }

    try {
      Logger.info(TAG, `Prefetching subtitle cues for stream ${subtitleTrack.id}...`);
      const cues = await bindings.prefetchSubtitleCues(subtitleTrack.id);
      if (cues && cues.length > 0) {
        // Seed the renderer's cache with every cue at once. The renderer
        // already maintains an active-cue cursor that re-evaluates against
        // the current adjusted time, so we don't need a separate "play
        // from cache" mode — the existing display path just works.
        this.videoRenderer.setSubtitleCues(cues);
        this.prefetchedSubtitleStream = subtitleTrack.id;
        Logger.info(TAG, `Prefetched ${cues.length} subtitle cues for stream ${subtitleTrack.id}`);
      } else {
        Logger.warn(TAG, `Subtitle prefetch returned no cues for stream ${subtitleTrack.id}`);
      }

      // The C-side scan leaves the demuxer at EOF. Re-seek back to where
      // playback should be so the audio/video pipeline can keep going.
      // Flush decoders + clear queue since the demuxer is in an
      // undefined-for-playback state.
      await this.videoDecoder.flush();
      await this.audioDecoder.flush();
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      this.audioRenderer.reset();
      await this.demuxer.seek(resumeTime);
      this.clock.seek(resumeTime);
      this.pendingAudioPackets = [];
      this.pendingPrebufferPackets = [];
      this.eofReached = false;
    } catch (err) {
      Logger.error(TAG, "Subtitle prefetch failed", err);
    } finally {
      this.prefetchInFlight = false;
    }

    // Resume audio/video pipelines if we paused them above. We bypass the
    // public play() because the player's state is still "playing" — we
    // only paused the underlying clocks/decoders and need to nudge them
    // back without the full first-play song-and-dance.
    if (wasPlaying) {
      try {
        if (!this.disableAudio) await this.audioRenderer.play();
        if (this.nativeAudioEl) await this.nativeAudioEl.play().catch(() => {});
        if (this.videoRenderer) this.videoRenderer.startPresentationLoop();
        this.clock.start();
        // Re-arm the seek-target guard (filter-only, not waitingForVideoSync)
        // so any pre-target frames produced by Open-GOP recovery after the
        // resumeTime seek get dropped without firing notifySeekCompletion's
        // state transitions.
        this.seekTargetTime = resumeTime;
        this.animationFrameId = requestAnimationFrame(this.processLoop);
        this.requestWakeLock();
      } catch (err) {
        Logger.error(TAG, "Failed to resume after subtitle prefetch", err);
      }
    } else {
      // Even when paused, kick off pause-time buffering again so the
      // demuxer keeps reading ahead behind the scenes (HTTP sources only).
      this.startPauseBuffering();
    }
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    if (this.hlsWrapper) {
      this.hlsWrapper.setVolume(volume);
    }
    this.audioRenderer.setVolume(volume);
    if (this.nativeAudioEl) {
      this.nativeAudioEl.volume = volume;
    }
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
    if (this.nativeAudioEl) {
      this.nativeAudioEl.muted = muted;
    }
  }

  /**
   * Get muted state
   */
  getMuted(): boolean {
    return this.muted;
  }

  /**
   * Enable/disable stable audio mode
   * Stable audio provides: smooth gain transitions, auto-recovery,
   * gap filling on underrun, starvation detection, and fade on seek/reset
   */
  setStableAudio(enabled: boolean): void {
    this.audioRenderer.setStableAudio(enabled);
  }

  /**
   * Get stable audio mode state
   */
  getStableAudio(): boolean {
    return this.audioRenderer.getStableAudio();
  }

  /**
   * Get comprehensive player stats for "Stats for nerds" overlay
   */
  getStats(): Record<string, string | number | boolean> {
    // HLS mode: delegate to HLS wrapper
    if (this.hlsWrapper) {
      return this.hlsWrapper.getStats();
    }

    const mediaInfo = this.mediaInfo;
    const videoTrack = this.trackManager.getActiveVideoTrack() as VideoTrack | null;
    const audioTrack = this.trackManager.getActiveAudioTrack() as AudioTrack | null;
    const videoDecoderStats = this.videoDecoder.getStats();
    const audioDecoderStats = this.audioDecoder.getStats();
    const rendererStats = this.videoRenderer?.getStats();
    const audioBuffered = this.audioRenderer.getBufferedDuration();

    const stats: Record<string, string | number | boolean> = {};

    // Video info
    if (videoTrack) {
      stats["Video Codec"] = videoTrack.codec ?? "N/A";
      stats["Resolution"] = `${videoTrack.width}x${videoTrack.height}`;
      // Quality label
      const h = videoTrack.height;
      stats["Quality"] = h >= 8640 ? "16K" : h >= 4320 ? "8K" : h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "1080p" : h >= 720 ? "720p" : h >= 480 ? "480p" : "SD";
      stats["Frame Rate"] = `${videoTrack.frameRate} fps`;
      stats["Video Bitrate"] = videoTrack.bitRate
        ? `${(videoTrack.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
      if (videoTrack.pixelFormat) stats["Pixel Format"] = videoTrack.pixelFormat;
      stats["Color Space"] = videoTrack.colorSpace ?? "N/A";
      if (videoTrack.colorRange) stats["Color Range"] = videoTrack.colorRange;
      if (videoTrack.colorPrimaries && videoTrack.colorPrimaries !== "unknown") {
        stats["Color Primaries"] = videoTrack.colorPrimaries;
      }
      if (videoTrack.colorTransfer && videoTrack.colorTransfer !== "unknown") {
        stats["Color Transfer"] = videoTrack.colorTransfer;
      }
      stats["HDR"] = videoTrack.isHDR ? "Yes" : "No";
      if (videoTrack.rotation) stats["Rotation"] = `${videoTrack.rotation}°`;
      stats["Video Decoder"] = videoDecoderStats.decoderType;
    }

    // Audio info
    if (audioTrack) {
      stats["Audio Codec"] = audioTrack.codec ?? "N/A";
      if (audioTrack.language && audioTrack.language !== "und") {
        stats["Language"] = audioTrack.language.toUpperCase();
      }
      stats["Sample Rate"] = `${audioTrack.sampleRate} Hz`;
      stats["Channels"] = audioTrack.channels === 1 ? "Mono" :
                          audioTrack.channels === 2 ? "Stereo" :
                          audioTrack.channels === 6 ? "5.1 Surround" :
                          audioTrack.channels === 8 ? "7.1 Surround" :
                          `${audioTrack.channels}ch`;
      stats["Audio Bitrate"] = audioTrack.bitRate
        ? `${(audioTrack.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
      stats["Audio Decoder"] = audioDecoderStats.decoderType;
    }

    // Subtitle info
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (subtitleTrack) {
      stats["Subtitle"] = `${subtitleTrack.codec ?? "text"}${subtitleTrack.language ? ` (${subtitleTrack.language.toUpperCase()})` : ""}`;
    }

    // Container
    if (mediaInfo) {
      stats["Container"] = mediaInfo.formatName ?? "N/A";
      stats["Total Bitrate"] = mediaInfo.bitRate
        ? `${(mediaInfo.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
    }

    // Playback
    stats["Playback State"] = this.stateManager.getState();
    stats["Playback Rate"] = `${this.clock.getPlaybackRate()}x`;
    stats["A/V Sync"] = this.clock.isSyncedToAudio() ? "Audio Master" : "Wall Clock";
    stats["Stable Volume"] = this.audioRenderer.getStableAudio() ? "On" : "Off";

    // Buffers
    stats["Audio Buffer"] = `${audioBuffered.toFixed(2)}s`;
    stats["Video Queue"] = `${rendererStats?.frameQueueSize ?? 0} frames`;
    stats["Frames Rendered"] = rendererStats?.framesPresented ?? 0;
    stats["Video Decoder Queue"] = videoDecoderStats.queueSize;
    stats["Audio Decoder Queue"] = audioDecoderStats.queueSize;

    // Memory usage (Chrome only)
    const mem = (performance as any).memory;
    if (mem) {
      stats["Memory Used"] = `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`;
      stats["Memory Limit"] = `${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`;
    }

    // File
    if (this.fileSize > 0) {
      stats["File Size"] = this.fileSize > 1048576
        ? `${(this.fileSize / 1048576).toFixed(1)} MB`
        : `${(this.fileSize / 1024).toFixed(1)} KB`;
    }

    // Network (HttpSource) or Disk (FileSource) stats
    if (this.source instanceof HttpSource) {
      const net = this.source.getNetworkStats();
      stats["Downloaded"] = net.totalBytes > 1048576
        ? `${(net.totalBytes / 1048576).toFixed(1)} MB`
        : `${(net.totalBytes / 1024).toFixed(1)} KB`;
      stats["Network Speed"] = net.currentSpeed > 0
        ? net.currentSpeed > 1048576
          ? `${(net.currentSpeed / 1048576).toFixed(1)} MB/s`
          : `${(net.currentSpeed / 1024).toFixed(0)} KB/s`
        : "—";
      stats["Connection Time"] = `${net.elapsed.toFixed(1)}s`;
    } else if (this.source instanceof FileSource) {
      const disk = this.source.getDiskStats();
      stats["Disk Read"] = disk.totalBytes > 1048576
        ? `${(disk.totalBytes / 1048576).toFixed(1)} MB`
        : `${(disk.totalBytes / 1024).toFixed(1)} KB`;
      stats["Read Speed"] = disk.currentSpeed > 0
        ? disk.currentSpeed > 1048576
          ? `${(disk.currentSpeed / 1048576).toFixed(1)} MB/s`
          : `${(disk.currentSpeed / 1024).toFixed(0)} KB/s`
        : "—";
    }

    return stats;
  }

  /**
   * Get current I/O throughput in bytes/sec (for graph)
   * Works for both network (HttpSource) and disk (FileSource)
   */
  getNetworkSpeed(): number {
    // HLS mode: delegate to HLS wrapper
    if (this.hlsWrapper) {
      return this.hlsWrapper.getNetworkSpeed();
    }
    // EncryptedHttpSource extends HttpSource, so the HttpSource branch
    // covers encrypted playback too.
    if (this.source instanceof HttpSource) {
      return this.source.getNetworkStats().currentSpeed;
    }
    if (this.source instanceof FileSource) {
      return this.source.getDiskStats().currentSpeed;
    }
    return 0;
  }

  /**
   * Check if source is a local file
   */
  isFileSource(): boolean {
    if (this.hlsWrapper) return false;
    return this.source instanceof FileSource;
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
   * Handle network recovery — re-seek to current position to restart cleanly
   */
  private handleNetworkOnline = (): void => {
    const state = this.stateManager.getState();
    if (state === "buffering" || state === "playing") {
      const currentTime = this.getCurrentTime();
      Logger.info(TAG, `Network online — re-seeking to ${currentTime.toFixed(2)}s for clean recovery`);
      this.seek(currentTime).catch((err) => {
        Logger.error(TAG, "Network recovery seek failed", err);
      });
    }
  };

  /**
   * Handle visibility change
   */
  /** Set by MoviElement when Document PiP is active */
  public isPiPActive: boolean = false;

  private handleVisibilityChange = async (): Promise<void> => {
    const isPlaying = this.stateManager.getState() === "playing" || this.stateManager.getState() === "buffering";

    if (document.visibilityState === "hidden" && isPlaying) {
      // On phones/tablets, skip background-playback gymnastics entirely. The OS
      // throttles/freezes hidden tabs aggressively (timers stop, AudioContext
      // suspends, recovery on resume is unreliable) — easier to just pause.
      // PiP is exempted; that's an explicit "keep playing" gesture.
      // UA check (not pointer:coarse) so Windows touch laptops aren't misclassified.
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const uaData = (navigator as any)?.userAgentData;
      const isMobile = uaData?.mobile === true ||
        /Android|iPhone|iPod|Mobile|Opera Mini|IEMobile|BlackBerry/i.test(ua) ||
        // iPad on iOS 13+ reports as Mac — disambiguate via touch points
        (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
      if (isMobile && !this.isPiPActive) {
        this.pause();
        return;
      }

      // Tab went to background — use Worker timer (Safari throttles setInterval to 1s+)
      this.isBackgrounded = true;

      // Background timer drives processLoop to keep audio flowing while hidden.
      // For audio-less content (no audio track or audio disabled) without PiP,
      // video decode is skipped AND there's no audio to drive — running the loop
      // would just race the demuxer to EOF (no backpressure → eofReached=true →
      // foreground recovery returns early → video stuck on resume).
      const hasAudio = !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;
      if (hasAudio || this.isPiPActive) {
        this.startBackgroundTimer();
      }

      // In background (not PiP), stop video presentation and clear queue
      // to prevent frame accumulation that blocks audio demuxing via backpressure.
      // At 60fps, the queue fills in ~1.7s and starves audio completely.
      if (!this.isPiPActive && this.videoRenderer) {
        this.videoRenderer.stopPresentationLoop();
        this.videoRenderer.clearQueue();
      }

      // Resume AudioContext if suspended
      if (this.audioRenderer) {
        (this.audioRenderer as any).audioContext?.resume?.().catch(() => {});
      }
    } else if (document.visibilityState === "visible") {
      // Tab visible again — stop background timer, RAF takes over
      this.isBackgrounded = false;
      this.stopBackgroundTimer();

      if (isPlaying) {
        // Resume AudioContext if needed. On mobile after long background the
        // browser may keep it suspended (autoplay policy — prior gesture has
        // expired). If resume doesn't actually move us back to "running",
        // there's no point pretending playback is live: pause cleanly so the
        // UI shows the play button and the user can tap to resume.
        const audioCtx = (this.audioRenderer as any)?.audioContext as AudioContext | undefined;
        if (audioCtx) {
          try { await audioCtx.resume(); } catch {}
          if (audioCtx.state === "suspended" && !this.muted && !this.disableAudio) {
            Logger.warn(TAG, "AudioContext stuck suspended after foreground — pausing for user tap");
            this.pause();
            return;
          }
        }

        if (!this.isPiPActive) {
          // Video-only recovery via demuxer seek — audio stays completely untouched.
          // In background, video decoding was skipped so video decoder has stale state.
          // We seek the demuxer to the nearest keyframe near current audio position,
          // flush only the video decoder, and set seekTargetTime to skip any
          // re-demuxed audio packets that were already played.
          //
          // clock.getTime() falls back to wall-clock when the audio output is
          // suspended in background, so it can race far ahead of the audio
          // that has actually been rendered. Resolve the real audio position:
          //   - external audio (separate <source kind="audio">) → nativeAudioEl
          //     keeps advancing its own currentTime even while clock raced ahead
          //   - in-container audio → AudioRenderer's clock / buffer end
          //   - no audio at all → fall back to wall-clock
          const nativeAudioTime = this.nativeAudioEl
            ? this.nativeAudioEl.currentTime
            : -1;
          const audioClock = this.audioRenderer.getAudioClock();
          const audioBufferEnd = this.audioRenderer.getMaxScheduledMediaTime();
          const audioTime = nativeAudioTime >= 0
            ? nativeAudioTime
            : audioClock >= 0
              ? audioClock
              : audioBufferEnd > 0
                ? audioBufferEnd
                : this.clock.getTime();
          Logger.debug(TAG, `Foreground recovery: video-only seek to ${audioTime.toFixed(2)}s`);

          // Cancel any in-flight processLoop to avoid demux conflicts during seek
          if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
          }
          const mySessionId = ++this.seekSessionId;

          try {
            // Flush video decoder only — audio decoder and renderer untouched
            if (this.videoDecoder) {
              await this.videoDecoder.flush();
            }
            if (this.videoRenderer) {
              this.videoRenderer.clearQueue();
            }

            if (this.seekSessionId !== mySessionId) return; // Superseded

            // Reset EOF flag — demuxer is being repositioned. For audio-less
            // video, background processLoop may have raced to EOF; without this
            // reset, processLoop would early-return and playback stalls.
            this.eofReached = false;

            // Seek demuxer to nearest keyframe before current audio position
            if (this.demuxer) {
              await this.demuxer.seek(audioTime + this.startTime);
            }

            if (this.seekSessionId !== mySessionId) return; // Superseded

            // Re-anchor the wall clock to audio. While backgrounded the wall
            // clock advanced freely while audio output was suspended; without
            // this re-sync, getTime() will continue reporting the inflated
            // value and Clock's drift correction will snap the wall clock
            // back at 50%/sample, causing time-update jitter on resume.
            this.clock.seek(audioTime + this.startTime);

            // Skip pre-target packets: use audio buffer end (not clock time) so
            // already-scheduled audio isn't re-decoded — prevents fast-forward sound.
            this.seekTargetTime = Math.max(audioTime + this.startTime, audioBufferEnd);
            this.seekingToKeyframe = true;
            this.seekingToKeyframeStartTime = performance.now();

            // Restart video pipeline
            if (this.videoRenderer) {
              this.videoRenderer.startPresentationLoop();
            }
            this.processLoop();
          } catch (err) {
            Logger.error(TAG, "Foreground recovery failed", err);
            // Fall back to processLoop restart so playback doesn't stall
            this.processLoop();
          }
        } else {
          // PiP was active — just restart processLoop, video was rendering in PiP
          this.processLoop();
        }

        setTimeout(() => {
          if (this.stateManager.getState() === "playing") {
            this.requestWakeLock();
          }
        }, 500);
      }
    }
  };

  /**
   * Start background timer using Web Worker (Safari-safe, not throttled)
   */
  private startBackgroundTimer(): void {
    if (this.backgroundWorker || this.backgroundIntervalId) return;
    Logger.debug(TAG, "Starting background playback timer");

    try {
      // Create inline Worker — not throttled in background tabs
      const blob = new Blob([`
        let id = null;
        self.onmessage = (e) => {
          if (e.data === 'start') {
            id = setInterval(() => self.postMessage('tick'), 16);
          } else if (e.data === 'stop') {
            clearInterval(id);
            id = null;
          }
        };
      `], { type: "application/javascript" });
      this.backgroundWorker = new Worker(URL.createObjectURL(blob));
      this.backgroundWorker.onmessage = () => {
        const state = this.stateManager.getState();
        if (state === "playing" || state === "buffering") {
          this.processLoop();
          // In PiP mode, also drive video rendering since main window rAF is stopped
          if (this.isPiPActive && this.videoRenderer) {
            (this.videoRenderer as any).presentationLoop?.();
          }
        }
      };
      this.backgroundWorker.postMessage("start");
    } catch {
      // Worker not available — fallback to setInterval
      Logger.debug(TAG, "Worker unavailable, using setInterval fallback");
      this.backgroundIntervalId = window.setInterval(() => {
        const state = this.stateManager.getState();
        if (state === "playing" || state === "buffering") {
          this.processLoop();
          if (this.isPiPActive && this.videoRenderer) {
            (this.videoRenderer as any).presentationLoop?.();
          }
        }
      }, 16);
    }
  }

  /**
   * Stop background timer
   */
  private stopBackgroundTimer(): void {
    if (this.backgroundWorker) {
      this.backgroundWorker.postMessage("stop");
      this.backgroundWorker.terminate();
      this.backgroundWorker = null;
      Logger.debug(TAG, "Background worker stopped");
    }
    if (this.backgroundIntervalId !== null) {
      clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }
  }

  /**
   * Start pause-time buffering: demux packets while paused so that
   * resume/seek within buffered area is near-instant (YouTube-like behavior).
   * Stashes packets into pendingPrebufferPackets without decoding.
   */
  private startPauseBuffering(): void {
    if (this.pauseBufferTimerId !== null) return;
    if (!this.demuxer || this.eofReached) return;
    // Only for HTTP sources — local files are already fully available
    if (this.source instanceof FileSource) return;

    Logger.debug(TAG, "Starting pause-time buffering");
    this.pauseBufferTimerId = window.setInterval(() => {
      this.pauseBufferTick();
    }, MoviPlayer.PAUSE_BUFFER_INTERVAL_MS);
  }

  private stopPauseBuffering(): void {
    if (this.pauseBufferTimerId !== null) {
      clearInterval(this.pauseBufferTimerId);
      this.pauseBufferTimerId = null;
      Logger.debug(TAG, "Stopped pause-time buffering");
    }
  }

  private pauseBufferTick = async () => {
    // Guard: only buffer while actually paused
    if (this.stateManager.getState() !== "paused") {
      this.stopPauseBuffering();
      return;
    }
    // Don't interfere with active WASM operations
    if (this.demuxInFlight || !this.demuxer) return;
    if (this.eofReached) {
      this.stopPauseBuffering();
      return;
    }

    // Check if we've buffered enough
    const stashedCount = this.pendingPrebufferPackets.length;
    if (stashedCount >= MoviPlayer.PAUSE_BUFFER_MAX_PACKETS) {
      Logger.debug(TAG, `Pause buffer full: ${stashedCount} packets stashed`);
      this.stopPauseBuffering();
      return;
    }

    // Check audio/video targets
    let audioDuration = 0;
    let videoFrames = 0;
    const activeVideo = this.trackManager.getActiveVideoTrack();
    const activeAudio = this.trackManager.getActiveAudioTrack();
    for (const pkt of this.pendingPrebufferPackets) {
      if (activeVideo && pkt.streamIndex === activeVideo.id) {
        videoFrames++;
      } else if (activeAudio && pkt.streamIndex === activeAudio.id) {
        audioDuration += pkt.duration ?? 0;
      }
    }

    // Only require targets for tracks that actually exist. A video-only or
    // audio-only stream would otherwise never satisfy the AND check, so the
    // loop ran until the 3000-packet safety cap (~30s of demux work) — which
    // shows up as a long burst of "Read: served from full-file cache" log
    // spam after pause.
    const videoTargetMet = !activeVideo || videoFrames >= MoviPlayer.PAUSE_BUFFER_VIDEO_FRAMES;
    const audioTargetMet = !activeAudio || audioDuration >= MoviPlayer.PAUSE_BUFFER_AUDIO_SECONDS;
    if (videoTargetMet && audioTargetMet) {
      Logger.debug(TAG, `Pause buffer targets met: audio=${audioDuration.toFixed(1)}s, video=${videoFrames} frames`);
      this.stopPauseBuffering();
      return;
    }

    try {
      this.demuxInFlight = true;
      this.demuxInFlightStartTime = performance.now();

      // Read a small burst of packets
      const burstSize = 10;
      for (let i = 0; i < burstSize; i++) {
        if (this.stateManager.getState() !== "paused") break;
        if (this.pendingPrebufferPackets.length >= MoviPlayer.PAUSE_BUFFER_MAX_PACKETS) break;

        // Don't push the demuxer past what HttpSource already holds — the next
        // read would otherwise trigger startStream() at the new offset, which
        // resets the sliding window and evicts already-buffered earlier bytes.
        // Pause-time buffering must never request bytes the network hasn't
        // delivered yet.
        if (this.source instanceof HttpSource && !this.source.isFullyCached()) {
          const pos = this.source.getPosition();
          const end = this.source.getBufferedEnd();
          // Keep ~1MB margin so an in-progress demuxer read doesn't straddle
          // the boundary and still trigger a refetch.
          if (pos >= end - 1024 * 1024) {
            this.stopPauseBuffering();
            break;
          }
        }

        const packet = await this.demuxer.readPacket();
        if (!packet) {
          this.eofReached = true;
          break;
        }

        // Only stash packets for active tracks
        if (this.trackManager.isActiveStream(packet.streamIndex)) {
          this.pendingPrebufferPackets.push(packet);
        }
      }
    } catch (e) {
      Logger.error(TAG, "Pause buffer demux error", e);
    } finally {
      this.demuxInFlight = false;
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

    // For HttpSource, report the buffered-end *relative* to the source's
    // real read cursor. Converting both endpoints to time via linear ratio
    // fails on VBR (seek byte offset ≠ linear(seek time)). Instead, use the
    // byte delta between buffered-end and the source's last-read position
    // — both are real byte offsets — and apply linear conversion only to
    // that small delta, added to the accurate currentTime.
    //
    // Pause-time buffering decouples the demuxer cursor from the playback
    // clock (demuxer keeps reading ahead while currentTime is frozen),
    // which causes forwardBytes to shrink and the bar to walk backward.
    // Clamp monotonically: the buffered-end never moves backward except on
    // seek (where lastBufferedTime is reset elsewhere).
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      // Small files fully cached in memory should report the entire
      // duration as buffered. The byte-delta math below underreports
      // for VBR content (e.g., a high-bitrate intro consumes more bytes
      // than its share of duration, so currentBytes/fileSize at low
      // currentTime is artificially high → forwardTime is artificially
      // low → bufferedTime = currentTime + forwardTime falls short of
      // duration even though every byte is in memory).
      if (this.source.isFullyCached()) {
        this.lastBufferedTime = duration;
        return duration;
      }
      const bufferedEndBytes = this.source.getBufferedEnd();
      if (bufferedEndBytes > 0) {
        const currentBytes = this.source.getPosition();
        const forwardBytes = Math.max(0, bufferedEndBytes - currentBytes);
        const forwardTime = (forwardBytes / this.fileSize) * duration;
        const computed = this.getCurrentTime() + forwardTime;
        this.lastBufferedTime = Math.max(this.lastBufferedTime, computed);
        return this.lastBufferedTime;
      }
    }

    // For FileSource, the entire file is buffered
    if (this.source instanceof FileSource) {
      return duration;
    }

    // EncryptedHttpSource now extends HttpSource, so the branch above
    // handles its buffered-end reporting too.

    return 0;
  }

  /**
   * Check if current source is HttpSource
   */
  isHttpSource(): boolean {
    return this.source instanceof HttpSource;
  }

  /**
   * Tune the active source's prefetch window. Value is megabytes — the
   * target "buffer ahead of playback" the source should try to maintain.
   * Honored by HttpSource (adjusts its sliding-window cap) and by
   * EncryptedHttpSource (scales PREFETCH_HIGH/LOW_WATER + cache cap).
   * Other source types are silently ignored.
   *
   * Wired to the `buffersize` element attribute so consumers can tune
   * memory vs. seek responsiveness at deploy time without forking.
   */
  setMaxBufferSize(megabytes: number): void {
    if (!(megabytes > 0) || !this.source) return;
    const src = this.source as SourceAdapter & {
      setMaxBufferSize?: (mb: number) => void;
    };
    if (typeof src.setMaxBufferSize === "function") {
      src.setMaxBufferSize(megabytes);
    }
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
    this.stopBackgroundTimer();
    this.stopPauseBuffering();

    // Destroy HLS wrapper
    if (this.hlsWrapper) {
      this.hlsWrapper.destroy();
      this.hlsWrapper = null;
    }

    this.pendingPrebufferPackets = [];

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

    // Cleanup native audio element (separate audio source)
    if (this.nativeAudioEl) {
      this.nativeAudioEl.pause();
      this.nativeAudioEl.src = "";
      this.nativeAudioEl = null;
    }

    // Cleanup external subtitles
    this.stopExternalSubtitles();
    this._externalSubCues = [];
    this._subtitleTracks = [];

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
    window.removeEventListener("online", this.handleNetworkOnline);
    this.removeAllListeners();

    Logger.info(TAG, "Player destroyed");
  }
}
