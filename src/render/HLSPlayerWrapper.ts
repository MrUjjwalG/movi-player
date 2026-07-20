import Hls from "hls.js";
import { EventEmitter } from "../events/EventEmitter";
import {
  PlayerEventMap,
  PlayerState,
  PlayerConfig,
  Track,
  VideoTrack,
  AudioTrack,
  SubtitleTrack,
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
  private _framesRendered: number = 0;
  // Subtitle rendering: hls.js parses cues (renderTextTracksNatively:false, since
  // the native <video> is hidden — the browser would never paint captions on it)
  // and hands them to us via CUES_PARSED as real VTTCue objects with no built-in
  // scheduling. We accumulate them and pick the active one(s) off `timeupdate`,
  // same as a native <track> element would, painting into our own overlay.
  private textContainer: HTMLDivElement | null = null;
  private pendingCues: VTTCue[] = [];
  private lastActiveCueSignature: string = "";

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

    // DRM mode: use native video element directly (no canvas)
    // Canvas can't access DRM-protected frames (browser blocks VideoFrame copy)
    if (!config.drm && config.renderer === "canvas" && config.canvas) {
      this.canvasRenderer = new CanvasRenderer(config.canvas);
      this.createTextContainer();
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

    this.trackManager.on("subtitleTrackChange", (track: SubtitleTrack | null) => {
      if (!this.hls) return;
      this.hls.subtitleTrack = track ? track.id : -1;
      // Drop accumulated cues from the previous track so a stale line doesn't
      // linger on screen after switching languages or turning subtitles off.
      this.pendingCues = [];
      this.lastActiveCueSignature = "";
      if (this.textContainer) this.textContainer.textContent = "";
      Logger.info(
        TAG,
        track
          ? `Selected subtitle track ${track.id} (${track.language || track.label || ""})`
          : "Subtitles disabled",
      );
    });

    // Audio-rendition switch. id is the index into hls.audioTracks (alternate
    // EXT-X-MEDIA TYPE=AUDIO renditions); setting hls.audioTrack changes the
    // active language. hls.js runs bitrate selection independently.
    this.trackManager.on("audioTrackChange", (track: AudioTrack | null) => {
      if (!this.hls || !track) return;
      if (this.hls.audioTrack === track.id) return; // already active
      this.hls.audioTrack = track.id;
      Logger.info(
        TAG,
        `Selected audio track ${track.id} (${track.language || track.label || ""})`,
      );
    });
  }

  /**
   * Own caption-rendering overlay, a sibling of the shared canvas (mirrors
   * ShakaPlayerWrapper's textContainer). Registered with the SAME
   * CanvasRenderer instance via setSubtitleOverlay() so its existing
   * rotation-aware resize() logic (dimension swap for 90/270°, centering,
   * rotate transform) sizes/positions/rotates it automatically — we only need
   * to write the active cue's text into it.
   */
  private createTextContainer(): void {
    if (this.textContainer || !this.config.canvas) return;
    const canvas = this.config.canvas as HTMLCanvasElement;
    const root = canvas.parentNode;
    if (!root) return;
    const tc = document.createElement("div");
    tc.className = "movi-hls-text-container";
    tc.style.position = "absolute";
    tc.style.inset = "0";
    tc.style.pointerEvents = "none";
    tc.style.zIndex = "2"; // above the canvas, below the controls bar
    tc.style.textAlign = "center";
    tc.style.color = "#fff";
    tc.style.textShadow = "0 1px 3px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)";
    tc.style.fontFamily = "sans-serif";
    tc.style.whiteSpace = "pre-line";
    tc.style.fontSize =
      "calc(clamp(20px, calc(var(--movi-player-width, 100vw) * 0.032), 40px) * var(--movi-sub-size-mult, 1))";
    root.appendChild(tc);
    this.textContainer = tc;
    this.canvasRenderer?.setSubtitleOverlay(tc);
  }

  /** Show whichever accumulated cue(s) are active at the current playhead —
   *  the browser-native equivalent of a <track> element's cue scheduling,
   *  which hls.js doesn't do for us in non-native-rendering mode. */
  private updateActiveCueDisplay(): void {
    if (!this.textContainer) return;
    const t = this.videoElement.currentTime;
    const active = this.pendingCues.filter(
      (c) => c.startTime <= t && t < c.endTime,
    );
    // Bound memory on long streams — drop cues that ended well in the past.
    if (this.pendingCues.length > 200) {
      this.pendingCues = this.pendingCues.filter((c) => c.endTime > t - 30);
    }
    const signature = active.map((c) => c.text).join("\n");
    if (signature === this.lastActiveCueSignature) return;
    this.lastActiveCueSignature = signature;

    this.textContainer.textContent = "";
    active.forEach((cue, i) => {
      if (i > 0) this.textContainer!.appendChild(document.createElement("br"));
      // getCueAsHTML() is the browser's own trusted WebVTT-markup parser — it
      // returns real DOM nodes for <b>/<i>/<u>/<ruby>/etc., so bold/italic
      // cues render correctly without us touching innerHTML at all.
      try {
        this.textContainer!.appendChild(cue.getCueAsHTML());
      } catch {
        this.textContainer!.appendChild(document.createTextNode(cue.text));
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
      this.updateActiveCueDisplay();
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
      this._framesRendered++;
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
    const url = source && source.type === "url" ? source.url : null;

    if (!url) {
      throw new Error("HLS source must be a URL");
    }

    if (this.config.drm) {
      Logger.info(TAG, "DRM mode enabled — using native video element (no canvas)");
      if (this.config.licenseUrl) {
        this.setupEME(this.config.licenseUrl, this.config.licenseHeaders);
      }
    }

    // Custom media headers (auth tokens, signed headers, …) on every request
    // hls.js makes — the manifest and all segments.
    const mediaHeaders = this.config.headers;
    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 30,
      maxMaxBufferLength: 600,
      // The <video> element is hidden (canvas draws frames) so the browser
      // never paints hls.js's native text tracks. Ask hls.js to hand us
      // parsed cues via CUES_PARSED instead, and render them ourselves —
      // see createTextContainer / updateActiveCueDisplay.
      renderTextTracksNatively: false,
      ...(mediaHeaders && {
        xhrSetup: (xhr: XMLHttpRequest) => {
          for (const [k, v] of Object.entries(mediaHeaders)) {
            xhr.setRequestHeader(k, v);
          }
        },
      }),
    });

    this.hls.attachMedia(this.videoElement);

    return new Promise<void>((resolve, reject) => {
      // Tracks whether load() has resolved. Before it has, a fatal error is a
      // load failure the caller (MoviPlayer) handles via its fallback chain —
      // we reject only. After it, errors are runtime and we emit them.
      let settled = false;

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
        settled = true;
        resolve();
      });

      // ABR / level switches in Auto mode change the active rendition
      // without changing the track list. Re-fire tracksChange so the
      // gear-badge UI in MoviElement repaints against the new height
      // (e.g. 720p → 1080p flips the gear pill from blank to "HD").
      this.hls!.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        Logger.debug(TAG, `LEVEL_SWITCHED → level ${data.level}`);
        this.trackManager.emit(
          "tracksChange",
          this.trackManager.getTracks(),
        );
      });

      // Parsed cues (WebVTT sidecar "subtitles" or in-stream CEA-608/708
      // "captions") for the currently-selected subtitle track — accumulate
      // for updateActiveCueDisplay's time-based scheduling.
      this.hls!.on(Hls.Events.CUES_PARSED, (_e, data) => {
        const cues = Array.isArray((data as any)?.cues) ? (data as any).cues : [];
        this.pendingCues.push(...cues);
      });

      let networkRetries = 0;
      let mediaRetries = 0;
      const MAX_NETWORK_RETRIES = 3;
      const MAX_MEDIA_RETRIES = 2;

      this.hls!.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          Logger.error(TAG, `HLS Fatal Error: ${data.details} (response: ${data.response?.code})`);

          const emitFatal = (msg: string) => {
            this.hls!.destroy();
            const err = new Error(msg);
            if (!settled) {
              // Pre-load failure: reject ONLY (no emit). hls.js is a fallback
              // behind Shaka; MoviPlayer surfaces the final classified error
              // itself. Emitting here flashes the error overlay mid-fallback —
              // a manifest 403 gets misread as a decode failure and briefly
              // shows an irrelevant "Try Software Decoding" button.
              settled = true;
              reject(err);
            } else {
              this.emit("error", err);
              this.setState("error");
            }
          };

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Don't retry 404/403 — resource doesn't exist or is forbidden
              const status = data.response?.code;
              if (status === 404 || status === 403) {
                emitFatal(`Stream unavailable (HTTP ${status})`);
              } else if (networkRetries < MAX_NETWORK_RETRIES) {
                networkRetries++;
                Logger.info(TAG, `Network retry ${networkRetries}/${MAX_NETWORK_RETRIES}`);
                this.hls!.startLoad();
              } else {
                emitFatal(`Network error: ${data.details}`);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              if (mediaRetries < MAX_MEDIA_RETRIES) {
                mediaRetries++;
                Logger.info(TAG, `Media recovery ${mediaRetries}/${MAX_MEDIA_RETRIES}`);
                this.hls!.recoverMediaError();
              } else {
                emitFatal(`Media error: ${data.details}`);
              }
              break;
            default:
              emitFatal(`HLS Error: ${data.details}`);
              break;
          }
        } else {
          Logger.warn(TAG, `HLS Non-fatal error: ${data.details}`);
        }
      });
    });
  }

  private async loadNative(): Promise<void> {
    const url = this.config.source && this.config.source.type === "url" ? this.config.source.url : "";
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

    // Count how many levels share the same resolution
    const heightCount = new Map<number, number>();
    data.levels.forEach((level: any) => {
      heightCount.set(level.height, (heightCount.get(level.height) || 0) + 1);
    });

    data.levels.forEach((level: any, index: number) => {
      const hasDuplicates = (heightCount.get(level.height) || 0) > 1;
      const label = hasDuplicates
        ? `${level.height}p · ${(level.bitrate / 1000).toFixed(0)} kbps`
        : `${level.height}p`;

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

    // Subtitle tracks (the master playlist declares subtitle groups upfront,
    // so hls.js has already parsed this list by MANIFEST_PARSED time). id is
    // the index into hls.subtitleTracks — exactly what the `subtitleTrack`
    // setter expects, so selectSubtitleTrack can pass it straight through.
    const subs = this.hls?.subtitleTracks ?? [];
    subs.forEach((t, index) => {
      const lang = t.lang && t.lang !== "und" ? t.lang : "";
      const label = t.name || lang || `Subtitle ${index + 1}`;
      tracks.push({
        id: index,
        type: "subtitle",
        codec: "",
        language: lang,
        label,
        subtitleType: "text",
      } as SubtitleTrack);
    });

    // Audio tracks — alternate EXT-X-MEDIA TYPE=AUDIO renditions (declared in
    // the master playlist, so parsed by MANIFEST_PARSED). id is the index into
    // hls.audioTracks, exactly what the `audioTrack` setter expects. Muxed-only
    // streams have 0-1 entries, so the selector stays hidden there.
    const auds = this.hls?.audioTracks ?? [];
    auds.forEach((t, index) => {
      const lang = t.lang && t.lang !== "und" ? t.lang : "";
      const label = t.name || lang || `Audio ${index + 1}`;
      tracks.push({
        id: index,
        type: "audio",
        codec: "",
        language: lang,
        label,
        channels: 0,
        sampleRate: 0,
      } as AudioTrack);
    });

    this.trackManager.setTracks(tracks);

    // Select Auto by default
    this.trackManager.selectVideoTrack(-1);

    // Reflect hls.js's active audio rendition as the selected track.
    if (auds.length > 1 && typeof this.hls?.audioTrack === "number") {
      const activeIdx = this.hls.audioTrack;
      if (activeIdx >= 0 && activeIdx < auds.length) {
        this.trackManager.selectAudioTrack(activeIdx);
      }
    }

    if (this.canvasRenderer && data.levels.length > 0) {
      const level = data.levels[0];
      const applyDims = (w: number, h: number) => {
        if (!this.canvasRenderer || w <= 0 || h <= 0) return;
        this.canvasRenderer.configure(w, h);
        // configure() only sets the drawing-buffer size; CSS sizing
        // (width/height: 100%) is only applied inside resize(). Without
        // this, canvas stays at its default 0×0 layout until the next
        // ResizeObserver tick — manifests as a black frame that clears
        // only after the user resizes the window.
        const canvas = this.canvasRenderer.getCanvas();
        const parent = canvas instanceof HTMLCanvasElement ? canvas.parentElement : null;
        const cw = parent?.clientWidth || w;
        const ch = parent?.clientHeight || h;
        if (cw > 0 && ch > 0) {
          this.canvasRenderer.resize(cw, ch);
        }
      };

      if (level.width > 0 && level.height > 0) {
        applyDims(level.width, level.height);
      } else {
        // Manifest didn't include RESOLUTION — wait for the <video>
        // element to surface real dimensions, otherwise we configure
        // a 0×0 framebuffer and render black until the next resize.
        Logger.info(TAG, "HLS manifest lacks RESOLUTION; deferring canvas configure to loadedmetadata");
        const onMeta = () => {
          this.videoElement.removeEventListener("loadedmetadata", onMeta);
          applyDims(this.videoElement.videoWidth, this.videoElement.videoHeight);
        };
        if (this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0) {
          applyDims(this.videoElement.videoWidth, this.videoElement.videoHeight);
        } else {
          this.videoElement.addEventListener("loadedmetadata", onMeta);
        }
      }
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
    // HTMLMediaElement.volume only accepts [0,1]; boost (>1) is applied via the
    // AudioContext gain path, not the native element, so clamp here.
    this.videoElement.volume = Math.min(1, Math.max(0, volume));
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

  /**
   * Setup Encrypted Media Extensions (EME) for Widevine/FairPlay DRM
   * Requires a valid license server URL from a DRM provider (e.g., PallyCon, EZDRM, BuyDRM)
   */
  private setupEME(licenseUrl: string, headers?: Record<string, string>): void {
    const video = this.videoElement;

    video.addEventListener("encrypted", async (event) => {
      Logger.info(TAG, `EME: encrypted event — initDataType=${event.initDataType}`);

      try {
        const config: MediaKeySystemConfiguration[] = [{
          initDataTypes: [event.initDataType],
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
          audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
        }];

        // Try key systems in order: Widevine, PlayReady (Edge), FairPlay (Safari).
        const keySystems = [
          "com.widevine.alpha",
          "com.microsoft.playready",
          "com.apple.fps.1_0",
        ];
        let keySystem = "";
        let access: MediaKeySystemAccess | null = null;
        for (const ks of keySystems) {
          try {
            access = await navigator.requestMediaKeySystemAccess(ks, config);
            keySystem = ks;
            break;
          } catch {
            /* not supported — try the next key system */
          }
        }
        if (!access) {
          throw new Error("No supported DRM key system (Widevine/PlayReady/FairPlay)");
        }

        Logger.info(TAG, `EME: Using ${keySystem}`);
        const keys = await access.createMediaKeys();
        await video.setMediaKeys(keys);

        const session = keys.createSession();
        session.addEventListener("message", async (e) => {
          // Request license from server
          const response = await fetch(licenseUrl, {
            method: "POST",
            body: e.message,
            headers: {
              "Content-Type": "application/octet-stream",
              ...headers,
            },
          });

          if (!response.ok) {
            Logger.error(TAG, `EME: License request failed (HTTP ${response.status})`);
            this.emit("error", new Error(`DRM license request failed (HTTP ${response.status})`));
            return;
          }

          const license = await response.arrayBuffer();
          await session.update(new Uint8Array(license));
          Logger.info(TAG, "EME: License acquired, playback authorized");
        });

        await session.generateRequest(event.initDataType, event.initData!);
      } catch (err) {
        Logger.error(TAG, "EME: DRM setup failed", err);
        this.emit("error", new Error(`DRM not supported or license server unreachable`));
      }
    });
  }

  getVideoElement(): HTMLVideoElement {
    return this.videoElement;
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

  getAudioTracks(): AudioTrack[] {
    return this.trackManager
      .getTracks()
      .filter((t) => t.type === "audio") as AudioTrack[];
  }
  selectAudioTrack(id: number): boolean {
    // Drives the trackManager audioTrackChange handler, which sets
    // hls.audioTrack to perform the rendition switch.
    return this.trackManager.selectAudioTrack(id);
  }
  getSubtitleTracks(): SubtitleTrack[] {
    return this.trackManager
      .getTracks()
      .filter((t) => t.type === "subtitle") as SubtitleTrack[];
  }
  async selectSubtitleTrack(id: number | null): Promise<boolean> {
    return this.trackManager.selectSubtitleTrack(id);
  }

  setVideoRotation(deg: number): void {
    this.canvasRenderer?.setManualRotation(deg);
  }

  rotateVideo(): number {
    return this.canvasRenderer?.rotate90() ?? 0;
  }

  getVideoRotation(): number {
    return this.canvasRenderer?.getRotation() ?? 0;
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

  getStats(): Record<string, string | number | boolean> {
    const stats: Record<string, string | number | boolean> = {};

    // Get actual playing level from HLS.js (handles Auto mode correctly)
    const level = this.hls?.levels?.[this.hls.currentLevel];
    const w = level?.width || this.videoElement.videoWidth || 0;
    const h = level?.height || this.videoElement.videoHeight || 0;

    // --- Video ---
    if (w && h) {
      stats["Video Codec"] = level?.videoCodec ?? "N/A";
      stats["Resolution"] = `${w}x${h}`;
      // See MoviPlayer.getStats — use effective (16:9-normalised) height
      // so ultrawide / letterboxed renditions don't drop a tier.
      const eff = Math.max(h, Math.round(w * 9 / 16));
      stats["Quality"] = eff >= 8640 ? "16K" : eff >= 4320 ? "8K" : eff >= 2160 ? "4K" : eff >= 1440 ? "2K" : eff >= 1080 ? "1080p" : eff >= 720 ? "720p" : eff >= 480 ? "480p" : "SD";
      if (level?.frameRate) stats["Frame Rate"] = `${level.frameRate} fps`;
      stats["Video Bitrate"] = level?.bitrate
        ? `${(level.bitrate / 1000).toFixed(0)} kbps`
        : "N/A";
    }
    if (level?.audioCodec) {
      stats["Audio Codec"] = level.audioCodec;
    }

    // --- Decoder ---
    if (this.canvasRenderer) {
      const rStats = this.canvasRenderer.getStats();
      stats["Video Decoder"] = "Hardware (Native)";
      stats["Renderer"] = "Canvas";
      stats["Color Space"] = rStats.colorSpace || "N/A";
    } else {
      stats["Video Decoder"] = "Hardware (Native)";
      stats["Renderer"] = "HTML5 Video";
    }

    // --- Playback ---
    stats["Playback State"] = this.state;
    stats["Playback Rate"] = `${this.videoElement.playbackRate}x`;

    // --- Frames ---
    const quality = (this.videoElement as any).getVideoPlaybackQuality?.();
    if (quality) {
      stats["Frames Decoded"] = quality.totalVideoFrames;
      stats["Frames Dropped"] = quality.droppedVideoFrames;
    }
    if (this.canvasRenderer) {
      stats["Frames Rendered"] = this._framesRendered;
    }

    // --- Buffer ---
    if (this.videoElement.buffered.length > 0) {
      const buffEnd = this.videoElement.buffered.end(this.videoElement.buffered.length - 1);
      const ahead = buffEnd - this.videoElement.currentTime;
      stats["Buffer Ahead"] = `${ahead.toFixed(1)}s`;
    }

    // --- HLS specific ---
    if (this.hls) {
      const levels = this.hls.levels;
      if (levels && levels.length > 1) {
        const activeLabel = level ? `${level.height}p` : "N/A";
        stats["HLS Level"] = this.hls.autoLevelEnabled
          ? `Auto (${activeLabel})`
          : activeLabel;
        const minH = Math.min(...levels.map(l => l.height));
        const maxH = Math.max(...levels.map(l => l.height));
        stats["Available Levels"] = `${levels.length} (${minH}p–${maxH}p)`;
      }
      if (this.hls.bandwidthEstimate) {
        stats["Bandwidth Estimate"] = `${(this.hls.bandwidthEstimate / 1000).toFixed(0)} kbps`;
      }
      // Latency (live streams)
      const latency = this.hls.latency;
      if (latency > 0) {
        stats["Live Latency"] = `${latency.toFixed(1)}s`;
      }
      // Type
      const details = levels?.[this.hls.currentLevel]?.details;
      if (details) {
        stats["Stream Type"] = details.live ? "Live" : "VOD";
      }
    }

    // Memory usage (Chrome only)
    const mem = (performance as any).memory;
    if (mem) {
      stats["Memory Used"] = `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`;
    }

    return stats;
  }

  getNetworkSpeed(): number {
    // Use HLS.js bandwidth estimate (bits/s → bytes/s)
    if (this.hls?.bandwidthEstimate) {
      return this.hls.bandwidthEstimate / 8;
    }
    return 0;
  }

  isFileSource(): boolean {
    return false;
  }

  destroy(): void {
    this.stopFrameLoop();

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    this.canvasRenderer?.setSubtitleOverlay(null);
    if (this.textContainer?.parentNode) {
      this.textContainer.parentNode.removeChild(this.textContainer);
    }
    this.textContainer = null;
    this.pendingCues = [];

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
