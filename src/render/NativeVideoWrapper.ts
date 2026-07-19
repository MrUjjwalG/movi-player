import { EventEmitter } from "../events/EventEmitter";
import {
  PlayerEventMap,
  PlayerState,
  VideoTrack,
  AudioTrack,
  SubtitleTrack,
} from "../types";
import { TrackManager } from "../core/TrackManager";
import { Logger } from "../utils/Logger";

const TAG = "NativeVideoWrapper";

export interface NativeFallbackOptions {
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
}

/**
 * Minimal player-interface adapter backed by a raw <video> element, used for
 * fallback="native": when the WASM/WebCodecs pipeline can't READ a cross-origin
 * no-CORS source but the browser's own media element can render it opaquely, we
 * hand playback to this wrapper and set it as MoviElement's `player`, so Movi's
 * OWN control UI (play / seek / time / volume / fullscreen) drives the native
 * <video> instead of the browser's default controls.
 *
 * It intentionally does NOT use fetch/MSE (both would re-hit the same CORS wall
 * that broke the WASM path) — just `<video src>`, which the browser fetches
 * opaquely. Advanced features (quality/audio/subtitle tracks, HDR, VR, chapters,
 * stats) don't apply to a degraded native surface, so their methods are safe
 * no-ops / empty; returning empty track lists makes Movi auto-hide those menus.
 *
 * Structurally it implements the subset of MoviPlayer's public API that
 * MoviElement's controls + UI-poll loop actually call (see the enumeration in
 * engageNativeFallback). It is assigned to `this.player` via an `unknown` cast.
 */
export class NativeVideoWrapper extends EventEmitter<PlayerEventMap> {
  public trackManager: TrackManager;
  private video: HTMLVideoElement;
  private state: PlayerState = "idle";
  private _destroyed = false;
  private _handlers: Array<[string, EventListener]> = [];

  constructor(videoElement: HTMLVideoElement) {
    super();
    this.video = videoElement;
    this.trackManager = new TrackManager(); // empty — no selectable tracks
    this.wireVideoEvents();
  }

  private wireVideoEvents(): void {
    const add = (type: string, fn: EventListener) => {
      this.video.addEventListener(type, fn);
      this._handlers.push([type, fn]);
    };
    add("play", () => this.setState("playing"));
    add("playing", () => this.setState("playing"));
    add("pause", () => {
      if (this.state !== "ended") this.setState("paused");
    });
    add("ended", () => {
      this.setState("ended");
      this.emit("ended", undefined as void);
    });
    add("seeking", () => this.setState("seeking"));
    add("seeked", () => {
      this.emit("seeked", this.video.currentTime);
      this.setState(this.video.paused ? "paused" : "playing");
    });
    add("waiting", () => this.setState("buffering"));
    add("canplay", () => {
      if (this.state === "buffering" || this.state === "loading") {
        this.setState(this.video.paused ? "paused" : "playing");
      }
    });
    add("timeupdate", () => this.emit("timeUpdate", this.video.currentTime));
    add("durationchange", () =>
      this.emit("durationChange", this.video.duration),
    );
    add("loadeddata", () => this.emit("loadEnd", undefined as void));
    add("error", () => {
      this.emit(
        "error",
        new Error(this.video.error?.message || "Native <video> playback error"),
      );
      this.setState("error");
    });
  }

  private setState(newState: PlayerState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.emit("stateChange", newState);
  }

  /** Point the native element at the source and start loading. No fetch/MSE. */
  async load(url: string, opts: NativeFallbackOptions = {}): Promise<void> {
    // Anonymous crossOrigin would demand the CORS headers we already know are
    // missing — leave it unset so the media element fetches the bytes opaquely
    // (it never exposes them to JS, so this stays within the same-origin rules).
    this.video.removeAttribute("crossorigin");
    (this.video as unknown as { crossOrigin: string | null }).crossOrigin = null;
    this.video.playsInline = opts.playsInline ?? true;
    this.video.loop = !!opts.loop;
    this.video.muted = !!opts.muted;
    (this.video as unknown as { preservesPitch: boolean }).preservesPitch = true;
    this.setState("loading");
    this.video.src = url;
    this.video.load();
    if (opts.autoplay) {
      try {
        await this.video.play();
      } catch {
        // Autoplay blocked while unmuted — retry muted, matching Movi's policy.
        this.video.muted = true;
        try {
          await this.video.play();
        } catch {
          /* user will press play */
        }
      }
    }
    Logger.info(TAG, "Native <video> source attached (opaque, no CORS read)");
  }

  // ── Core playback (real, backed by the <video>) ─────────────────────────────
  async play(): Promise<void> {
    await this.video.play();
  }
  pause(): void {
    this.video.pause();
  }
  async seek(time: number): Promise<void> {
    this.video.currentTime = time;
  }
  getState(): PlayerState {
    return this.state;
  }
  getCurrentTime(): number {
    return this.video.currentTime || 0;
  }
  getDuration(): number {
    const d = this.video.duration;
    return isFinite(d) ? d : 0;
  }
  setVolume(volume: number): void {
    this.video.volume = Math.min(1, Math.max(0, volume));
  }
  getVolume(): number {
    return this.video.volume;
  }
  setMuted(muted: boolean): void {
    this.video.muted = muted;
  }
  isMuted(): boolean {
    return this.video.muted;
  }
  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
  }
  getPlaybackRate(): number {
    return this.video.playbackRate;
  }
  getBufferEndTime(): number {
    const b = this.video.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }
  getBufferStartTime(): number {
    const b = this.video.buffered;
    return b.length ? b.start(0) : 0;
  }
  getBufferedRangeStart(): number {
    return this.getBufferStartTime();
  }
  getSeekableStartTime(): number {
    const s = this.video.seekable;
    return s.length ? s.start(0) : 0;
  }
  getSeekRangeStart(): number {
    return 0;
  }
  getHLSVideoElement(): HTMLVideoElement {
    return this.video;
  }
  getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  // ── Capability / state queries (fallback defaults) ──────────────────────────
  isLiveStream(): boolean {
    return false;
  }
  isLive(): boolean {
    return false;
  }
  isFileSource(): boolean {
    return false;
  }
  isStreamPlayback(): boolean {
    return false;
  }
  isFileSourcePreloadComplete(): boolean {
    return true;
  }
  isAudioOnly(): boolean {
    return false;
  }
  isPiPActive(): boolean {
    return (
      typeof document !== "undefined" &&
      document.pictureInPictureElement === this.video
    );
  }
  isSoftwareDecoding(): boolean {
    return false;
  }
  isHDRSupported(): boolean {
    return false;
  }
  isPlaybackIntended(): boolean {
    return !this.video.paused;
  }
  isLinearPlayback(): boolean {
    return false;
  }
  isAudioBlockedSuspended(): boolean {
    return false;
  }
  hasAudibleSource(): boolean {
    return true;
  }
  isNativeAudioActive(): boolean {
    return true;
  }
  usesNativeAudio(): boolean {
    return true;
  }
  wasAudioContextActivated(): boolean {
    return true;
  }
  getStableAudio(): boolean {
    return false;
  }

  // ── Tracks / previews / metadata (empty → Movi hides these menus) ───────────
  getVideoTracks(): VideoTrack[] {
    return [];
  }
  getAudioTracks(): AudioTrack[] {
    return [];
  }
  getSubtitleTracks(): SubtitleTrack[] {
    return [];
  }
  getAudioLangs(): string[] {
    return [];
  }
  getSubtitleLangs(): string[] {
    return [];
  }
  getChapters(): unknown[] {
    return [];
  }
  getAllSubtitleCues(): unknown[] {
    return [];
  }
  getSubtitleDelay(): number {
    return 0;
  }
  getVideoRotation(): number {
    return 0;
  }
  getLiveEdge(): number {
    return 0;
  }
  getNetworkSpeed(): number {
    return 0;
  }
  getMetadataTitle(): string {
    return "";
  }
  getContentDispositionFilename(): string {
    return "";
  }
  getAudioOutputDevice(): string {
    return "";
  }
  async getPreviewFrame(): Promise<Blob | null> {
    return null;
  }
  getCurrentVideoFrame(): ImageBitmap | null {
    return null;
  }
  getStats(): Record<string, string | number | boolean> {
    const stats: Record<string, string | number | boolean> = {
      // Plain text only — the stats panel renders values as HTML, so angle
      // brackets (e.g. "<video>") would be parsed as a tag and inject a real
      // element into the panel.
      Renderer: "Native (fallback)",
    };
    if (this.video.videoWidth) {
      stats.Resolution = `${this.video.videoWidth}x${this.video.videoHeight}`;
    }
    stats["Playback Rate"] = `${this.video.playbackRate}x`;
    const b = this.video.buffered;
    if (b.length) stats.Buffered = `${b.end(b.length - 1).toFixed(1)}s`;
    const q = this.video.getVideoPlaybackQuality?.();
    if (q) {
      stats["Dropped Frames"] = `${q.droppedVideoFrames} / ${q.totalVideoFrames}`;
    }
    return stats;
  }
  getRenderHealth(): null {
    // Matches MoviPlayer, which returns null whenever a stream wrapper is active.
    return null;
  }

  // ── No-op actions/setters (don't apply to a native fallback surface) ────────
  selectVideoTrack(_id: number): void {}
  selectAudioTrack(_id: number): boolean {
    return false;
  }
  async selectSubtitleTrack(_id: number | null): Promise<boolean> {
    return false;
  }
  selectAudioLang(_lang: string): void {}
  selectSubtitleLang(_lang: string): void {}
  setStableAudio(_enabled: boolean): void {}
  setHDREnabled(_enabled: boolean): void {}
  setMaxBufferSize(_bytes: number): void {}
  setLetterboxColor(_color: unknown): void {}
  setSubtitleControlsPadding(_px: number): void {}
  setSubtitleDelay(_seconds: number): void {}
  setSubtitleOverlay(_element: HTMLElement): void {}
  setPreviewsEnabled(_enabled: boolean): void {}
  setFitMode(_mode: unknown): void {}
  setAudioOutputDevice(_deviceId: string): void {}
  setVideoRotation(_deg: number): void {}
  rotateVideo(): void {}
  resizeCanvas(_width: number, _height: number): void {}
  useMuxedAudio(): void {}
  setAudioOnly(_enabled: boolean): void {}
  setVR(_enabled: boolean): void {}
  setVRProjection(_projection: unknown): void {}
  nudgeVR(_x: number, _y: number): void {}
  zoomVR(_delta: number): void {}
  suppressSeekSpinner(): void {}
  seekToLive(): void {}
  resetClockToStartForPoster(): void {}
  renderPosterImage(): void {}
  adoptNativeAudio(_el: unknown): void {}

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const [type, fn] of this._handlers) {
      try {
        this.video.removeEventListener(type, fn);
      } catch {
        /* noop */
      }
    }
    this._handlers = [];
    if (
      typeof document !== "undefined" &&
      document.pictureInPictureElement === this.video
    ) {
      document.exitPictureInPicture().catch(() => {});
    }
    try {
      this.video.pause();
    } catch {
      /* noop */
    }
    this.video.removeAttribute("src");
    try {
      this.video.load();
    } catch {
      /* noop */
    }
    this.removeAllListeners();
    Logger.info(TAG, "Native video wrapper destroyed");
  }
}
