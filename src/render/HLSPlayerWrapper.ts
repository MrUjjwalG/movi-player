import Hls from "hls.js";
import { EventEmitter } from "../events/EventEmitter";
import {
  PlayerEventMap,
  PlayerState,
  PlayerConfig,
  Track,
  VideoTrack,
} from "../types";
import { CanvasRenderer } from "./CanvasRenderer";
import { TrackManager } from "../core/TrackManager";
import { Logger } from "../utils/Logger";

const TAG = "HLSPlayerWrapper";

export class HLSPlayerWrapper extends EventEmitter<PlayerEventMap> {
  private config: PlayerConfig;
  private hls: Hls | null = null;
  private videoElement: HTMLVideoElement;
  private canvasRenderer: CanvasRenderer | null = null;
  private state: PlayerState = "idle";
  public trackManager: TrackManager;
  private frameCallbackId: number | null = null;

  constructor(config: PlayerConfig) {
    super();
    this.config = config;
    this.trackManager = new TrackManager();

    this.videoElement = document.createElement("video");
    this.videoElement.crossOrigin = "anonymous";
    this.videoElement.playsInline = true;
    this.videoElement.style.display = "none"; // Hidden by default, canvas renderer will draw frames

    // Preserve pitch when changing playback speed
    (this.videoElement as any).preservesPitch = true;
    (this.videoElement as any).mozPreservesPitch = true; // Firefox
    (this.videoElement as any).webkitPreservesPitch = true; // Safari/older Chrome

    if (config.renderer === "canvas" && config.canvas) {
      this.canvasRenderer = new CanvasRenderer(config.canvas);
    }

    this.setupEventHandlers();

    // Listen to track manager changes to update HLS level
    this.trackManager.on("videoTrackChange", (track: VideoTrack | null) => {
      if (this.hls) {
        const levelId = track ? track.id : -1;

        // Handle Auto (-1)
        if (levelId === -1) {
          if (!this.hls.autoLevelEnabled) {
            this.hls.currentLevel = -1;
            Logger.info(TAG, "Switched to Auto Quality (ABR)");
          }
          return;
        }

        // Disable previews for HLS streams as byte-range seeking is not reliable
        if (this.config.enablePreviews) {
          Logger.info(
            TAG,
            "HLS previews are disabled due to byte-range seeking limitations.",
          );
          // Potentially emit an event or set a flag to indicate previews are not available
          // For now, just log and proceed without trying to initialize preview pipeline
        }

        Logger.info(TAG, `Requesting Quality Switch to ${levelId}`);

        // Manual Selection
        if (this.state === "playing") {
          // If playing, use nextLevel for smooth switch (avoids immediate buffer flush/stall)
          this.hls.nextLevel = levelId;
          Logger.info(TAG, `Set nextLevel=${levelId} (smooth switch)`);
        } else {
          // If paused/buffering/idle, switch immediately to load new quality ASAP
          this.hls.currentLevel = levelId;
          Logger.info(TAG, `Set currentLevel=${levelId} (immediate switch)`);
        }
      }
    });
  }

  private setupEventHandlers(): void {
    this.videoElement.addEventListener("play", () => this.setState("playing"));
    this.videoElement.addEventListener("playing", () =>
      this.setState("playing"),
    );
    this.videoElement.addEventListener("pause", () => {
      if (this.state !== "ended") this.setState("paused");
    });
    this.videoElement.addEventListener("ended", () => this.setState("ended"));
    this.videoElement.addEventListener("seeking", () =>
      this.setState("seeking"),
    );
    this.videoElement.addEventListener("seeked", () => {
      if (this.videoElement.paused) this.setState("paused");
      else this.setState("playing");
    });
    this.videoElement.addEventListener("waiting", () =>
      this.setState("buffering"),
    );
    this.videoElement.addEventListener("timeupdate", () => {
      this.emit("timeUpdate", this.videoElement.currentTime);
    });
    this.videoElement.addEventListener("durationchange", () => {
      this.emit("durationChange", this.videoElement.duration);
    });
    this.videoElement.addEventListener("error", (_e) => {
      const error = this.videoElement.error;
      this.emit("error", new Error(error?.message || "Video element error"));
      this.setState("error");
    });
  }

  private setState(newState: PlayerState) {
    if (this.state !== newState) {
      this.state = newState;
      this.emit("stateChange", newState);

      if (newState === "playing" && this.canvasRenderer) {
        this.startFrameLoop();
      } else if (newState !== "seeking" && newState !== "buffering") {
        if (
          newState === "paused" ||
          newState === "ended" ||
          newState === "error" ||
          newState === "idle"
        ) {
          this.stopFrameLoop();
        }
      }
    }
  }

  private startFrameLoop() {
    if (this.frameCallbackId !== null) return;

    this.frameCallbackId = this.videoElement.requestVideoFrameCallback(
      (_now, _metadata) => {
        this.renderFrame();

        this.frameCallbackId = null;
        if (
          this.state === "playing" ||
          this.state === "seeking" ||
          this.state === "buffering"
        ) {
          this.startFrameLoop();
        }
      },
    );
  }

  private stopFrameLoop() {
    if (this.frameCallbackId !== null) {
      this.videoElement.cancelVideoFrameCallback(this.frameCallbackId);
      this.frameCallbackId = null;
    }
  }

  private renderFrame() {
    if (!this.canvasRenderer) return;

    try {
      const frame = new VideoFrame(this.videoElement);
      this.canvasRenderer.render(frame);
      frame.close();
    } catch (e) {
      Logger.warn(TAG, "Failed to create VideoFrame", e);
    }
  }

  async load(): Promise<void> {
    this.setState("loading");
    this.emit("loadStart", undefined);

    if (!Hls.isSupported()) {
      if (this.videoElement.canPlayType("application/vnd.apple.mpegurl")) {
        return this.loadNative();
      } else {
        const err = new Error("HLS not supported in this browser");
        this.emit("error", err);
        this.setState("error");
        throw err;
      }
    }

    const source = this.config.source;
    const url = source.type === "url" ? source.url : null;

    if (!url) {
      throw new Error("HLS source must be a URL");
    }

    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 30, // 30 seconds
      maxMaxBufferLength: 600, // Allow large buffer to avoid full errors during seeking/quality switch
    });

    this.hls.attachMedia(this.videoElement);

    return new Promise<void>((resolve, reject) => {
      this.hls!.on(Hls.Events.MEDIA_ATTACHED, () => {
        Logger.info(TAG, "HLS Media Attached");
        this.hls!.loadSource(url);
      });

      this.hls!.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        Logger.info(
          TAG,
          `HLS Manifest parsed. Found ${data.levels.length} quality levels`,
        );
        this.updateTracks(data);

        this.setState("ready");
        this.emit("loadEnd", undefined);
        resolve();
      });

      this.hls!.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          Logger.error(TAG, `HLS Fatal Error: ${data.details}`);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.hls!.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.hls!.recoverMediaError();
              break;
            default:
              this.hls!.destroy();
              const err = new Error(`HLS Error: ${data.details}`);
              this.emit("error", err);
              this.setState("error");
              reject(err);
              break;
          }
        } else {
          Logger.warn(TAG, `HLS Non-fatal error: ${data.details}`);
        }
      });
    });
  }

  private async loadNative(): Promise<void> {
    const url = this.config.source.type === "url" ? this.config.source.url : "";
    if (!url) throw new Error("Invalid URL");

    return new Promise((resolve, reject) => {
      const onLoaded = () => {
        this.videoElement.removeEventListener("loadedmetadata", onLoaded);
        this.videoElement.removeEventListener("error", onError);
        this.setState("ready");
        this.emit("loadEnd", undefined);
        resolve();
      };
      const onError = (_e: Event) => {
        this.videoElement.removeEventListener("loadedmetadata", onLoaded);
        this.videoElement.removeEventListener("error", onError);
        reject(new Error("Native HLS load failed"));
      };

      this.videoElement.addEventListener("loadedmetadata", onLoaded);
      this.videoElement.addEventListener("error", onError);

      this.videoElement.src = url;
      this.videoElement.load();
    });
  }

  private updateTracks(data: any) {
    const tracks: Track[] = [];

    // Add Auto track
    const autoTrack: VideoTrack = {
      id: -1,
      type: "video",
      codec: "auto",
      width: 0,
      height: 0,
      frameRate: 0,
      label: "Auto",
    };
    tracks.push(autoTrack);

    const seenLabels = new Set<string>();

    data.levels.forEach((level: any, index: number) => {
      const label = `${level.height}p`;

      // Skip duplicates based on label (resolution)
      if (seenLabels.has(label)) return;
      seenLabels.add(label);

      const videoTrack: VideoTrack = {
        id: index,
        type: "video",
        codec: level.videoCodec,
        bitRate: level.bitrate,
        width: level.width,
        height: level.height,
        frameRate: level.frameRate,
        label: label,
      };
      tracks.push(videoTrack);
    });

    this.trackManager.setTracks(tracks);

    // Select Auto by default
    this.trackManager.selectVideoTrack(-1);

    if (this.canvasRenderer && data.levels.length > 0) {
      const level = data.levels[0];
      this.canvasRenderer.configure(level.width, level.height);
    }
  }

  async play(): Promise<void> {
    await this.videoElement.play();
  }

  pause(): void {
    this.videoElement.pause();
  }

  async seek(time: number): Promise<void> {
    this.videoElement.currentTime = time;
  }

  getState(): PlayerState {
    return this.state;
  }

  getDuration(): number {
    return this.videoElement.duration;
  }

  getCurrentTime(): number {
    return this.videoElement.currentTime;
  }

  setVolume(volume: number): void {
    this.videoElement.volume = volume;
  }

  setMuted(muted: boolean): void {
    this.videoElement.muted = muted;
  }

  setPlaybackRate(rate: number): void {
    this.videoElement.playbackRate = rate;
  }

  getVolume(): number {
    return this.videoElement.volume;
  }

  isMuted(): boolean {
    return this.videoElement.muted;
  }

  getPlaybackRate(): number {
    return this.videoElement.playbackRate;
  }

  setSubtitleOverlay(_element: HTMLElement): void {
    // Pending
  }

  setHDREnabled(enabled: boolean): void {
    if (this.canvasRenderer) {
      this.canvasRenderer.setHDREnabled(enabled);
    }
  }

  getBufferEndTime(): number {
    if (this.videoElement.buffered.length) {
      return this.videoElement.buffered.end(
        this.videoElement.buffered.length - 1,
      );
    }
    return 0;
  }

  resizeCanvas(width: number, height: number): void {
    if (this.canvasRenderer) {
      this.canvasRenderer.resize(width, height);
    }
  }

  getVideoTracks(): VideoTrack[] {
    return this.trackManager
      .getTracks()
      .filter((t) => t.type === "video") as VideoTrack[];
  }

  selectVideoTrack(id: number): void {
    if (!this.hls) return;
    // Don't set hls.currentLevel here directly!
    // We let the trackManager event handler decide whether to use currentLevel (immediate) or nextLevel (smooth)
    this.trackManager.selectVideoTrack(id);
  }

  getAudioTracks() {
    return [];
  }
  selectAudioTrack(_id: number): boolean {
    return false;
  }
  getSubtitleTracks() {
    return [];
  }
  selectSubtitleTrack(_id: number | null): Promise<boolean> {
    return Promise.resolve(false);
  }

  setFitMode(mode: any) {
    if (this.canvasRenderer) {
      this.canvasRenderer.setFitMode(mode);
    } else {
      if (mode === "contain") this.videoElement.style.objectFit = "contain";
      else if (mode === "cover") this.videoElement.style.objectFit = "cover";
      else if (mode === "fill") this.videoElement.style.objectFit = "fill";
    }
  }

  destroy(): void {
    this.stopFrameLoop();

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    this.videoElement.removeAttribute("src");
    this.videoElement.load();
    if (this.videoElement.parentNode) {
      this.videoElement.parentNode.removeChild(this.videoElement);
    }
    this.eventHandlers.clear();
    this.removeAllListeners();
  }

  private eventHandlers = new Map<string, any>();
}
