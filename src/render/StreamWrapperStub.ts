/**
 * The lean build's stand-in for the three adaptive-streaming wrappers.
 *
 * `scripts/build-standalone.js` aliases `./ShakaPlayerWrapper`,
 * `./HLSPlayerWrapper` and `./DASHPlayerWrapper` to this module when it builds
 * the lean entry, so Shaka Player, hls.js and dash.js never enter that bundle.
 * Nothing else changes: MoviPlayer constructs the same class names and calls
 * `load()`, which here refuses at once with one clear error. MoviPlayer's own
 * tier loop then destroys the wrapper and moves on — the hls.js / dash.js tier
 * (refused the same way), the FFmpeg demuxer for single-file DASH, and
 * otherwise the error surfaces to the element, whose slim-build native
 * fallback hands the URL to the browser's `<video>`.
 *
 * The rest of the surface exists so a caller that reads the wrapper between
 * construction and the rejected load sees idle values, never a missing method.
 * MoviPlayer nulls the wrapper as soon as `load()` rejects, so none of it is
 * reached in practice.
 *
 * Nothing in the default or slim builds imports this module; the build alias
 * is the only way in.
 */
import { EventEmitter } from "../events/EventEmitter";
import type { PlayerConfig, PlayerEventMap, PlayerState } from "../types";
import { TrackManager } from "../core/TrackManager";

/** The one message every stream tier refuses with in the lean build. */
export const LEAN_STREAM_MESSAGE =
  "This build of movi-player (lean) carries no HLS/DASH engine; " +
  "load movi-player/element/slim for adaptive streams.";

class LeanStreamWrapper extends EventEmitter<PlayerEventMap> {
  public trackManager = new TrackManager();
  private readonly engine: string;
  private video: HTMLVideoElement | null = null;

  constructor(_config: PlayerConfig, engine: string) {
    super();
    this.engine = engine;
  }

  async load(): Promise<void> {
    throw new Error(`${LEAN_STREAM_MESSAGE} (${this.engine} is not in this build)`);
  }

  async play(): Promise<void> {}
  pause(): void {}
  async seek(_time: number): Promise<void> {}
  getState(): PlayerState {
    return "idle";
  }
  getDuration(): number {
    return 0;
  }
  getCurrentTime(): number {
    return 0;
  }
  setVolume(_volume: number): void {}
  setMuted(_muted: boolean): void {}
  setPlaybackRate(_rate: number): void {}
  getVolume(): number {
    return 1;
  }
  getPlaybackRate(): number {
    return 1;
  }
  getVideoElement(): HTMLVideoElement {
    if (!this.video) this.video = document.createElement("video");
    return this.video;
  }
  getBufferEndTime(): number {
    return 0;
  }
  resizeCanvas(_width: number, _height: number): void {}
  getActiveResolution(): { width: number; height: number } {
    return { width: 0, height: 0 };
  }
  selectVideoTrack(_id: number): void {}
  selectAudioTrack(_id: number): boolean {
    return false;
  }
  async selectSubtitleTrack(_id: number | null): Promise<boolean> {
    return false;
  }
  setFitMode(_mode: unknown): void {}
  getStats(): Record<string, string | number | boolean> {
    return { engine: this.engine, build: "lean" };
  }
  getNetworkSpeed(): number {
    return 0;
  }
  destroy(): void {
    this.removeAllListeners();
    this.trackManager.removeAllListeners();
    this.video = null;
  }
}

export class ShakaPlayerWrapper extends LeanStreamWrapper {
  constructor(config: PlayerConfig) {
    super(config, "Shaka Player");
  }
}

export class HLSPlayerWrapper extends LeanStreamWrapper {
  constructor(config: PlayerConfig) {
    super(config, "hls.js");
  }
}

export class DASHPlayerWrapper extends LeanStreamWrapper {
  constructor(config: PlayerConfig) {
    super(config, "dash.js");
  }
}
