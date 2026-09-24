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
import { stripKaraokeGhost } from "./sanitizeVttHtml";

const TAG = "NativeVideoWrapper";

/**
 * SRT → WebVTT. A `<track>` element only speaks WebVTT, and the two formats
 * differ by a header and a decimal separator, so the conversion is textual.
 * (The WASM path has its own SRT parser; here the browser does the parsing and
 * only needs to be handed the dialect it knows.)
 */
function srtToVtt(text: string): string {
  return (
    "WEBVTT\n\n" +
    text
      .replace(/\r/g, "")
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
  );
}

export interface NativeFallbackOptions {
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
  /**
   * Split-audio companion (`<source kind="audio">`): the video URL carries no
   * audio track, so a bare `<video src>` would play silently. Given this, the
   * wrapper drives a second `<audio>` element alongside and keeps the two in
   * sync — see the sync notes on `attachSplitAudio`.
   */
  audioUrl?: string;
}

/** An external subtitle file declared as a `<track>` child. */
export interface SubtitleSource {
  url: string;
  lang: string;
  label: string;
  format?: "vtt" | "srt";
}

// Drift budget between the <video> and the split <audio>, in seconds. Under the
// nudge threshold the two are indistinguishable; between nudge and resync a
// small playbackRate trim pulls them together inaudibly; past resync only a hard
// seek recovers (a stall, a background tab, a decode hiccup).
const DRIFT_NUDGE = 0.045;
const DRIFT_RESYNC = 0.35;
// How hard the rate trim pulls. 3% is under the ~5% most listeners can detect.
const MAX_RATE_TRIM = 0.03;
const SYNC_INTERVAL_MS = 500;

// Auto-quality tuning.
//
// Judged on STALLS, not buffer level. A native element buffers to its own
// policy, not to the link's headroom — measured here, Chrome holds a steady
// ~2.5s ahead whatever the rung, so "buffer below N" reads as permanently
// starved and walks an 8K source that plays fine all the way down to 240p.
// What actually means "this rung is too big for this link" is playback
// stalling, which the element reports directly.
const ABR_TICK_MS = 2000;
// Playback seconds without a stall before trying the next rung up.
const ABR_QUIET_SECONDS = 20;
// After a switch, playback seconds before that rung is judged at all — a swap
// reloads at the playhead, and the first moments say nothing about the link.
const ABR_SETTLE_SECONDS = 6;
// A rung that stalled within this long of being selected is treated as proven
// too big; the wait before re-trying it doubles each time.
const ABR_PROBATION_SECONDS = 12;

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
  // Split-audio companion — null unless the source declared a separate
  // <source kind="audio">. When set, IT owns volume/mute: the <video> stays
  // permanently muted (it's a video-only stream anyway) so the two can never
  // double up if the file turns out to carry audio after all.
  private audio: HTMLAudioElement | null = null;
  private _audioHandlers: Array<[string, EventListener]> = [];
  private _syncTimer: ReturnType<typeof setInterval> | null = null;
  // Whether playback is *intended*, as opposed to momentarily stalled: either
  // element can go "waiting" on its own, and whichever one is still running
  // must be held back so they don't drift apart while the other rebuffers.
  private _playIntent = false;
  private _rate = 1;
  private _volume = 1;
  private _muted = false;
  // True while a hard resync is holding the picture for the audio (see
  // syncAudioTo). The transport/state handlers below sit out that window so its
  // internal pause/seek don't surface as a paused player or a seek spinner.
  private _resyncing = false;
  // Premuxed quality ladder: which rendition URL is on screen. MoviElement owns
  // the list (parsed from <source data-height>) and drives the menu; the wrapper
  // only has to report the active one and swap it (switchVideoRenditionInPlace).
  private activeSrc = "";
  // Identity of the last video track handed to the TrackManager — see
  // publishActiveVideoTrack for why republishing the same one is not harmless.
  private _publishedTrackStamp = "";
  // "Auto" state: the ladder, plus the buffer-watching loop that climbs and
  // drops through it (see setAutoQuality for why it's buffer- not rate-based).
  private renditions: {
    url: string;
    id?: string;
    label?: string;
    height?: number;
  }[] = [];
  private autoQuality = false;
  private abrTimer: ReturnType<typeof setInterval> | null = null;
  private abrSwitching = false;
  // Playhead position the current rung started from — both the settle window
  // and the "quiet since" measurement run against it (see abrTick).
  private abrSettleFrom = -Infinity;
  // Playhead position of the last stall. Climbing waits for quiet since here.
  private abrLastStallAt = -Infinity;
  // Per-rung penalty (seconds) for rungs that stalled soon after being picked,
  // doubling each time, so Auto stops re-trying a rung the link can't hold.
  private abrPenalty = new Map<string, number>();
  // External subtitles (<track> children). The browser could render these
  // itself, but its cue painting ignores every --movi-sub-* control, so we parse
  // them here and paint into Movi's own overlay instead.
  // Multi-language audio: the declared <source kind="audio" srclang> list and
  // which one the companion element is currently playing.
  private audioLangs: { src: string; lang: string; label: string }[] = [];
  private activeAudioLang = "";
  private subs: SubtitleSource[] = [];
  private activeSubLang = "";
  private subtitleOverlay: HTMLElement | null = null;
  private trackEl: HTMLTrackElement | null = null;
  private textTrack: TextTrack | null = null;
  private _cueChangeHandler: (() => void) | null = null;
  private cueBlobUrl: string | null = null;
  private subDelay = 0;
  private _appliedSubDelay = 0;
  private _lastCueSignature = "";

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
      if (this._resyncing) return;
      if (this.state !== "ended") this.setState("paused");
    });
    add("ended", () => {
      this._playIntent = false;
      this.audio?.pause();
      this.setState("ended");
      this.emit("ended", undefined as void);
    });
    add("seeking", () => {
      if (this._resyncing) return;
      this.setState("seeking");
    });
    add("seeked", () => {
      if (this._resyncing) return;
      this.emit("seeked", this.video.currentTime);
      this.setState(this.video.paused ? "paused" : "playing");
    });
    add("waiting", () => {
      this.setState("buffering");
      this.onAbrStall();
    });
    add("stalled", () => this.onAbrStall());
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

  /**
   * Drive a second `<audio>` element next to the `<video>` for split sources
   * (`<source kind="audio">`), which the browser can't do on its own — a media
   * element plays exactly one file, so the video-only stream would be silent.
   *
   * There's no common clock to slave them to (that's what the WASM pipeline
   * provides), so the two run independently and are held together by:
   *   • mirrored transport — play/pause/seek/rate/loop go to both;
   *   • a stall hold — whichever element goes "waiting" pauses the other, so a
   *     rebuffer on one side doesn't advance the other past it;
   *   • a drift watchdog on a timer — a small playbackRate trim for ordinary
   *     drift, a hard `currentTime` resync once it's past hearing it.
   *
   * A/V lock is looser than the WASM path's sample-accurate sync; it's the
   * degraded surface's "audio at all" rather than a replacement for it.
   */
  private attachSplitAudio(url: string, opts: NativeFallbackOptions): void {
    // Idempotent: a second load() on the same wrapper must not orphan the first
    // companion. It isn't in the DOM, so nothing else would ever stop it — it
    // would just keep playing the previous source underneath the new one.
    this.detachSplitAudio();
    const a = new Audio();
    // Same reasoning as the <video>: leave crossOrigin unset so the bytes are
    // fetched opaquely (the CORS headers are exactly what's missing here).
    a.preload = "auto";
    a.loop = false; // loop is driven off the <video>'s "ended" → seek(0) + play
    a.playbackRate = this._rate;
    a.volume = this._volume;
    a.muted = this._muted || !!opts.muted;
    a.src = url;
    a.load();
    this.audio = a;

    // The <video> half of a split pair carries no audio track, but mute it
    // anyway: a mislabelled source that DOES have one would otherwise play
    // twice, slightly out of phase.
    this.video.muted = true;
    // Native looping wraps the <video> to 0 WITHOUT firing "ended", which would
    // leave the audio to run out and stop. Drive looping off the "ended" event
    // instead (MoviElement re-seeks + replays both through this wrapper).
    this.video.loop = false;

    const addV = (type: string, fn: EventListener) => {
      this.video.addEventListener(type, fn);
      this._handlers.push([type, fn]);
    };
    const addA = (type: string, fn: EventListener) => {
      a.addEventListener(type, fn);
      this._audioHandlers.push([type, fn]);
    };

    // Stall hold, both directions.
    addV("waiting", () => {
      if (this._playIntent) a.pause();
    });
    addV("playing", () => {
      if (this._playIntent) this.resumeAudio();
    });
    addA("waiting", () => {
      if (this._playIntent) this.video.pause();
    });
    addA("playing", () => {
      if (this._playIntent && this.video.paused) this.video.play().catch(() => {});
    });
    addA("canplay", () => {
      if (this._playIntent && this.video.paused) this.video.play().catch(() => {});
    });

    addV("seeked", () => {
      if (this._resyncing) return; // the resync itself moves both — don't fight it
      void this.syncAudioTo(this.video.currentTime);
    });
    addV("ratechange", () => {
      this._rate = this.video.playbackRate;
      a.playbackRate = this._rate;
    });
    // A dead audio track shouldn't kill playback — the video is still watchable,
    // so log it and let the <video> carry on silently rather than surfacing the
    // wrapper's "error" (which tears the fallback down into the error UI).
    addA("error", () => {
      Logger.warn(
        TAG,
        `Split audio failed to load (${a.error?.message || "unknown error"}) — continuing video-only`,
      );
      this.stopSyncLoop();
    });

    this._syncTimer = setInterval(() => this.syncTick(), SYNC_INTERVAL_MS);
    Logger.info(TAG, "Split audio attached — <audio> synced to the native video");
  }

  /** Start/resume the split audio at the video's position. */
  private resumeAudio(): void {
    const a = this.audio;
    if (!a) return;
    if (Math.abs(a.currentTime - this.video.currentTime) > DRIFT_RESYNC) {
      a.currentTime = this.video.currentTime;
    }
    a.play().catch(() => {
      // Autoplay policy refused the unmuted audio (the <video> is muted, so it
      // was allowed to start on its own). Match the video path's policy: play it
      // muted rather than not at all — the user's first gesture unmutes it.
      a.muted = true;
      this._muted = true;
      this.emit("autoplaymuted", undefined as void);
      a.play().catch(() => {});
    });
  }

  /**
   * Hard resync: seek the audio to `target` and HOLD the picture until the
   * element has actually landed there.
   *
   * Seeking the audio alone doesn't work — an `<audio>` seek costs a rebuffer,
   * and the video keeps running through it, so the pair settles a few hundred ms
   * apart again (measured ~350ms, right back at the resync threshold, where the
   * rate trim then claws at it forever). Pausing the video for the duration and
   * re-aligning it to where the audio actually landed converts that permanent
   * offset into one short hitch.
   */
  private async syncAudioTo(target: number): Promise<void> {
    const a = this.audio;
    if (!a || this._resyncing) return;
    this._resyncing = true;
    const resumeAfter = this._playIntent;
    if (!this.video.paused) this.video.pause();
    a.currentTime = target;
    a.playbackRate = this._rate;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        a.removeEventListener("seeked", finish);
        a.removeEventListener("canplay", finish);
        resolve();
      };
      // Don't hold the picture hostage to an audio element that never reports
      // back (a dead/stalled track) — release after a beat and carry on.
      const timer = setTimeout(finish, 1200);
      a.addEventListener("seeked", finish);
      a.addEventListener("canplay", finish);
    });
    if (this._destroyed) return;
    // Land the picture on wherever the audio ended up, not the other way round:
    // the audio is the one that can't be nudged without being heard. Wait for
    // that seek to settle before dropping the flag — its own "seeked" would
    // otherwise re-enter this method and never stop.
    if (Math.abs(a.currentTime - this.video.currentTime) > DRIFT_NUDGE) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.video.removeEventListener("seeked", finish);
          resolve();
        };
        const timer = setTimeout(finish, 800);
        this.video.addEventListener("seeked", finish);
        this.video.currentTime = a.currentTime;
      });
    }
    this._resyncing = false;
    if (resumeAfter && this._playIntent) {
      await Promise.allSettled([this.video.play(), a.play()]);
    }
  }

  /** Drift watchdog — trim small drift by rate, hard-resync large drift. */
  private syncTick(): void {
    const a = this.audio;
    if (!a || !this._playIntent || this._resyncing || this.video.paused) return;
    if (a.paused) {
      if (a.readyState >= 3) this.resumeAudio();
      return;
    }
    const drift = a.currentTime - this.video.currentTime;
    const mag = Math.abs(drift);
    if (mag > DRIFT_RESYNC) {
      void this.syncAudioTo(this.video.currentTime);
    } else if (mag > DRIFT_NUDGE) {
      // Audio ahead (drift > 0) → run it slower, and vice versa.
      const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, -drift * 0.5));
      a.playbackRate = this._rate * (1 + trim);
    } else if (a.playbackRate !== this._rate) {
      a.playbackRate = this._rate;
    }
  }

  // ── Premuxed quality ladder ─────────────────────────────────────────────────

  /** The rendition URL currently on screen (drives the menu's checkmark). */
  getActiveDashRendition(): string {
    return this.activeSrc;
  }

  /**
   * Take the quality ladder (MoviElement parsed it from the `<source>` children)
   * so "Auto" has something to switch between.
   */
  setDashRenditions(
    renditions: { url: string; id?: string; label?: string; height?: number }[],
    activeUrl?: string,
  ): void {
    this.renditions = [...renditions].sort(
      (a, b) => (b.height || 0) - (a.height || 0),
    );
    if (activeUrl) this.activeSrc = activeUrl;
    this.publishActiveVideoTrack();
  }

  isAutoQuality(): boolean {
    return this.autoQuality;
  }

  /**
   * Turn adaptive switching on/off.
   *
   * The ABR here is BUFFER-based, not throughput-based: a native element
   * downloads opaquely, so there are no byte counters to measure a link speed
   * with (the WASM path's ABR sizes renditions off measured throughput). What
   * IS observable is how the buffer ahead of the playhead behaves — it grows
   * when the link outruns the bitrate, drains when it doesn't. So: sustained
   * healthy buffer → try one rung up; drained buffer or a stall → drop a rung.
   * Slower to settle than the real ABR, but it never guesses above what the
   * link is visibly sustaining.
   */
  setAutoQuality(enabled: boolean): void {
    this.autoQuality = enabled;
    if (!enabled) {
      if (this.abrTimer !== null) {
        clearInterval(this.abrTimer);
        this.abrTimer = null;
      }
      return;
    }
    this.abrSettleFrom = this.video.currentTime;
    this.abrLastStallAt = -Infinity;
    if (this.abrTimer === null) {
      this.abrTimer = setInterval(() => this.abrTick(), ABR_TICK_MS);
    }
  }

  private abrTick(): void {
    if (
      this._destroyed ||
      !this.autoQuality ||
      this.abrSwitching ||
      this._resyncing ||
      this.renditions.length < 2 ||
      this.video.paused ||
      this.video.seeking
    ) {
      return;
    }
    // Settle window after a switch (and after the initial load): a rendition
    // swap reloads at the playhead, and the first moments of a fresh file say
    // nothing about whether the link can hold it.
    if (this.video.currentTime - this.abrSettleFrom < ABR_SETTLE_SECONDS) return;

    const idx = this.renditions.findIndex((r) => r.url === this.activeSrc);
    if (idx < 0 || idx === 0) return; // already at the top — nothing to climb to

    // Climb once playback has run quietly (no stall) for long enough, and the
    // rung above isn't serving a penalty from stalling last time it was tried.
    const quietFor =
      this.video.currentTime - Math.max(this.abrSettleFrom, this.abrLastStallAt);
    const next = this.renditions[idx - 1];
    const penalty = this.abrPenalty.get(next.url) ?? 0;
    if (quietFor >= ABR_QUIET_SECONDS + penalty) {
      void this.abrSwitchTo(idx - 1, `${Math.round(quietFor)}s without a stall`);
    }
  }

  /**
   * Playback stalled for data. That — not a buffer-level reading — is the
   * signal that the current rung is bigger than the link can carry, so drop one
   * and remember that the rung we were on stalled quickly, if it did.
   */
  private onAbrStall(): void {
    if (!this.autoQuality || this._destroyed || this.abrSwitching) return;
    if (this._resyncing || this.video.seeking) return; // our own hold, not the link
    const now = this.video.currentTime;
    this.abrLastStallAt = now;
    const heldFor = now - this.abrSettleFrom;
    if (heldFor < ABR_SETTLE_SECONDS) return; // still settling; not a verdict

    const idx = this.renditions.findIndex((r) => r.url === this.activeSrc);
    if (idx < 0 || idx >= this.renditions.length - 1) return; // already lowest

    // Stalling soon after landing on this rung means it's genuinely too big:
    // put it on probation so the climb doesn't walk straight back into it, and
    // double the wait every time it fails again.
    if (heldFor < ABR_PROBATION_SECONDS * 4) {
      const prev = this.abrPenalty.get(this.activeSrc) ?? 0;
      this.abrPenalty.set(
        this.activeSrc,
        prev === 0 ? ABR_PROBATION_SECONDS : Math.min(prev * 2, 600),
      );
    }
    void this.abrSwitchTo(idx + 1, "playback stalled");
  }

  private async abrSwitchTo(index: number, why: string): Promise<void> {
    const next = this.renditions[index];
    if (!next || next.url === this.activeSrc) return;
    this.abrSwitching = true;
    Logger.info(
      TAG,
      `Auto quality → ${next.label || next.height || next.url} (${why})`,
    );
    try {
      await this.switchVideoRenditionInPlace(next.url);
    } finally {
      this.abrSwitching = false;
    }
  }

  /**
   * Publish the active rung as the one video track. MoviElement's UI poll reads
   * trackManager.getActiveVideoTrack()?.height to fire `qualitychange` (with the
   * auto flag), which is how a host like movi-tube learns what Auto settled on —
   * so the ladder has to surface through the same channel the WASM path uses.
   */
  private publishActiveVideoTrack(): void {
    const active = this.renditions.find((r) => r.url === this.activeSrc);
    if (!active) return;
    // setTracks() emits tracksChange unconditionally, and MoviElement answers
    // that by re-rendering the quality menu — which calls setDashRenditions(),
    // which lands back here. Publishing a track identical to the live one
    // therefore recursed: measured 569 rounds of the whole menu rebuild on a
    // single gear-panel open, blocking the page for ~2.5s. Only publish when
    // the rung actually changed; a repeat is not news.
    const stamp = `${active.url}|${active.height || 0}|${active.label || ""}`;
    if (stamp === this._publishedTrackStamp) return;
    this._publishedTrackStamp = stamp;
    this.trackManager.setTracks([
      {
        id: 0,
        type: "video",
        codec: "",
        width: 0,
        height: active.height || 0,
        frameRate: 0,
        label: active.label,
      } as unknown as VideoTrack,
    ]);
  }

  /**
   * Swap the video file in place for another rung of the premuxed ladder,
   * keeping the playhead, the play state and the split audio. MoviElement's
   * switchPremuxedQuality() prefers this over a reload precisely so the audio
   * and clock survive — here a reload would tear the whole fallback down and
   * re-run the WASM path that already failed.
   *
   * Auto IS offered here, but on a different signal: sizing renditions by
   * throughput needs byte counters a native element doesn't expose, so
   * setAutoQuality above adapts off the buffer instead.
   */
  async switchVideoRenditionInPlace(url: string): Promise<boolean> {
    if (this._destroyed || !url) return false;
    if (url === this.activeSrc) return true;
    const resumeTime = this.video.currentTime;
    const resumePlaying = this._playIntent;
    // Hold the UI's state churn (the reload fires pause/seeking/waiting) and
    // silence the audio while the new file gets to the playhead.
    this._resyncing = true;
    this.audio?.pause();
    this.video.src = url;
    this.activeSrc = url;
    this.video.load();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.video.removeEventListener("loadedmetadata", finish);
        resolve();
      };
      const timer = setTimeout(finish, 4000);
      this.video.addEventListener("loadedmetadata", finish);
    });
    if (this._destroyed) return false;
    this.video.currentTime = resumeTime;
    this._resyncing = false;
    if (resumePlaying) {
      try {
        await this.video.play();
      } catch {
        /* the user's next gesture will resume it */
      }
    }
    // Re-align the companion audio to wherever the new file actually landed.
    if (this.audio) await this.syncAudioTo(this.video.currentTime);
    this.publishActiveVideoTrack();
    // Restart the settle window: the new rung buffers from scratch here.
    this.abrSettleFrom = this.video.currentTime;
    Logger.info(TAG, `Native rendition swapped in place → ${url}`);
    return true;
  }

  // ── Multi-language audio (<source kind="audio" srclang>) ────────────────────

  /** The declared audio-language tracks; MoviElement drives the menu. */
  setAudioLangTracks(tracks: { src: string; lang: string; label: string }[]): void {
    this.audioLangs = tracks.filter((t) => t.src);
    // Seed the active one from whichever URL the companion already loaded (the
    // element picked it as the default), so the menu opens with a checkmark on
    // the right row instead of none.
    const playing = this.audio?.getAttribute("src") || "";
    this.activeAudioLang =
      this.audioLangs.find((t) => t.src === playing)?.lang ||
      this.audioLangs[0]?.lang ||
      "";
  }

  getAudioLangs(): { lang: string; label: string; active: boolean }[] {
    return this.audioLangs.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this.activeAudioLang,
    }));
  }

  /**
   * Switch the companion `<audio>` to another language. The WASM path rebuilds
   * its audio demuxer here; on this surface the companion is just a media
   * element, so it's a src swap plus the same aligned resync the drift watchdog
   * uses — position and play state carry over.
   */
  async selectAudioLang(lang: string): Promise<boolean> {
    const track = this.audioLangs.find((t) => t.lang === lang);
    if (!track || !this.audio) return false;
    if (lang === this.activeAudioLang) return true;
    const at = this.video.currentTime;
    this.activeAudioLang = lang;
    this.audio.pause();
    this.audio.src = track.src;
    this.audio.load();
    await this.syncAudioTo(at);
    Logger.info(TAG, `Native split audio switched → ${track.label || lang}`);
    return true;
  }

  // ── External subtitles (<track> children) ───────────────────────────────────

  /** Hand over the declared `<track>` children; MoviElement drives the menu. */
  setExternalSubtitles(tracks: SubtitleSource[]): void {
    this.subs = tracks.filter((t) => t.url);
  }

  /** Where cues are painted — Movi's own overlay, so its styling controls apply. */
  setSubtitleOverlay(element: HTMLElement | null): void {
    this.subtitleOverlay = element;
  }

  getSubtitleLangs(): { lang: string; label: string; active: boolean }[] {
    return this.subs.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this.activeSubLang,
    }));
  }

  /** VLC/mpv convention: positive = subtitles appear later. */
  setSubtitleDelay(seconds: number): void {
    this.subDelay = seconds || 0;
    this.applySubtitleDelayToCues();
    this.paintActiveCues();
  }

  getSubtitleDelay(): number {
    return this.subDelay;
  }

  /**
   * Load + activate one of the declared tracks, or pass null to turn them off.
   *
   * The cues go through a real `<track kind="subtitles" mode="hidden">` on the
   * `<video>` — the same shape HLSPlayerWrapper/ShakaPlayerWrapper use for their
   * native surfaces. The browser owns parsing and cue scheduling (including
   * WebVTT markup and YouTube's inline karaoke timestamps, which a hand-rolled
   * parser flattens into one run-on blob) and we only paint whatever it reports
   * as active into Movi's overlay.
   */
  async selectSubtitleLang(lang: string | null): Promise<boolean> {
    this.detachTrackElement();
    if (!lang) {
      this.activeSubLang = "";
      this.clearCueDisplay();
      return true;
    }
    const track = this.subs.find((t) => t.lang === lang);
    if (!track) return false;
    // Mark it active up front: the menu re-renders synchronously right after
    // this call (it doesn't await), so waiting for the load would draw the
    // checkmark on the old row. Rolled back below if the load fails.
    this.activeSubLang = lang;
    try {
      let url = track.url;
      const isSrt =
        track.format === "srt" || /\.srt(\?|#|$)/i.test(track.url);
      if (isSrt) {
        // A <track> only reads WebVTT, so SRT has to be converted first. This
        // fetch (and the <track> load below) needs the file to be same-origin or
        // CORS-enabled — a real limit, since the native fallback often exists
        // BECAUSE the media is no-CORS, though subtitle files are usually served
        // separately. On failure subtitles stay off; playback is untouched.
        const res = await fetch(track.url, {
          signal: this.lifetimeAbort.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.cueBlobUrl = URL.createObjectURL(
          new Blob([srtToVtt(await res.text())], { type: "text/vtt" }),
        );
        url = this.cueBlobUrl;
      }
      const el = document.createElement("track");
      el.kind = "subtitles";
      el.label = track.label;
      el.srclang = track.lang;
      el.src = url;
      el.addEventListener("error", () => {
        Logger.warn(TAG, `Subtitle track failed to load: ${track.url}`);
        this.activeSubLang = "";
        this.clearCueDisplay();
      });
      this.video.appendChild(el);
      this.trackEl = el;
      // "hidden" = parse and schedule cues, but don't let the browser paint them
      // (its own caption rendering ignores every --movi-sub-* control).
      const tt = el.track;
      tt.mode = "hidden";
      this.textTrack = tt;
      const onCueChange = () => this.paintActiveCues();
      tt.addEventListener("cuechange", onCueChange);
      this._cueChangeHandler = onCueChange;
      // Cues arrive asynchronously; apply any standing delay once they're in.
      el.addEventListener("load", () => {
        this.applySubtitleDelayToCues();
        this.paintActiveCues();
      });
      Logger.info(TAG, `Subtitle track attached natively: ${track.label}`);
      return true;
    } catch (e) {
      this.activeSubLang = "";
      this.clearCueDisplay();
      Logger.warn(TAG, `Failed to load subtitle ${track.url}`, e);
      return false;
    }
  }

  /** Paint the browser's currently-active cues into Movi's overlay. */
  private paintActiveCues(): void {
    const overlay = this.subtitleOverlay;
    const tt = this.textTrack;
    if (!overlay || !tt) return;
    const active = Array.from(tt.activeCues || []) as VTTCue[];
    const signature = active.map((c) => `${c.startTime}:${c.text}`).join("|");
    if (signature === this._lastCueSignature) return;
    this._lastCueSignature = signature;

    overlay.replaceChildren();
    if (active.length === 0) {
      overlay.style.display = "none";
      return;
    }
    // The canvas renderer normally sizes and shows this overlay; in native mode
    // it never runs, so switch it on here. Layout comes from the stylesheet.
    overlay.classList.add("movi-subtitle-format-vtt");
    overlay.style.display = "block";

    // Same anchor/block/line markup the canvas path emits, so the whole
    // --movi-sub-* set (size, colour, background, edge) styles these identically.
    const anchor = document.createElement("div");
    anchor.className = "movi-subtitle-anchor";
    anchor.style.textAlign = "center";
    const block = document.createElement("div");
    block.className = "movi-subtitle-block";
    for (const cue of active) {
      const row = document.createElement("div");
      row.className = "movi-subtitle-line";
      row.setAttribute("part", "subtitle");
      const visible = stripKaraokeGhost(cue.text);
      if (visible !== cue.text) {
        // Karaoke cue: everything after the delimiter is the not-yet-spoken
        // sentence, carried for width anchoring — it must never reach the
        // screen. Plain text is fine here; these cues carry no VTT markup.
        row.textContent = visible;
      } else {
        // getCueAsHTML() is the browser's own trusted WebVTT-markup parser —
        // real DOM nodes for <b>/<i>/<u>/<ruby>, no innerHTML anywhere.
        try {
          row.appendChild(cue.getCueAsHTML());
        } catch {
          row.textContent = cue.text;
        }
      }
      block.appendChild(row);
    }
    anchor.appendChild(block);
    overlay.appendChild(anchor);
  }

  /**
   * Shift every cue by the current delay. VTTCue times are mutable, so the
   * offset is applied to the cue list itself and the browser keeps scheduling
   * them — no second timing loop of our own.
   */
  private applySubtitleDelayToCues(): void {
    const tt = this.textTrack;
    if (!tt?.cues) return;
    const shift = this.subDelay - this._appliedSubDelay;
    if (!shift) return;
    for (const cue of Array.from(tt.cues) as VTTCue[]) {
      cue.startTime += shift;
      cue.endTime += shift;
    }
    this._appliedSubDelay = this.subDelay;
  }

  private clearCueDisplay(): void {
    const overlay = this.subtitleOverlay;
    if (overlay) {
      overlay.replaceChildren();
      overlay.style.display = "none";
    }
    this._lastCueSignature = "";
  }

  private detachTrackElement(): void {
    if (this._cueChangeHandler && this.textTrack) {
      this.textTrack.removeEventListener("cuechange", this._cueChangeHandler);
    }
    this._cueChangeHandler = null;
    this.textTrack = null;
    this._appliedSubDelay = 0;
    if (this.trackEl) {
      try {
        this.trackEl.remove();
      } catch {
        /* noop */
      }
      this.trackEl = null;
    }
    if (this.cueBlobUrl) {
      URL.revokeObjectURL(this.cueBlobUrl);
      this.cueBlobUrl = null;
    }
  }

  private stopSyncLoop(): void {
    if (this._syncTimer !== null) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
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
    this._muted = !!opts.muted;
    this._volume = this.video.volume;
    this._rate = this.video.playbackRate || 1;
    this.setState("loading");
    this.video.src = url;
    this.activeSrc = url;
    this.video.load();
    // Split audio: wire the companion <audio> BEFORE any autoplay below, so the
    // two start together instead of the video racing ahead on its own.
    if (opts.audioUrl) this.attachSplitAudio(opts.audioUrl, opts);
    if (opts.autoplay) {
      this._playIntent = true;
      try {
        await this.video.play();
      } catch {
        // Autoplay blocked while unmuted — retry muted, matching Movi's policy.
        this.video.muted = true;
        this._muted = true;
        try {
          await this.video.play();
          // Tell MoviElement so it surfaces the "Tap to unmute" pill; the mute
          // happened down here, so its own autoplay-block detection (which
          // watches an AudioContext this path never creates) can't see it.
          this.emit("autoplaymuted", undefined as void);
        } catch {
          this._playIntent = false; // user will press play
        }
      }
      if (this._playIntent) this.resumeAudio();
    }
    Logger.info(
      TAG,
      opts.audioUrl
        ? "Native <video> + split <audio> attached (opaque, no CORS read)"
        : "Native <video> source attached (opaque, no CORS read)",
    );
  }

  // ── Core playback (real, backed by the <video>) ─────────────────────────────
  async play(): Promise<void> {
    this._playIntent = true;
    await this.video.play();
    this.resumeAudio();
  }
  pause(): void {
    this._playIntent = false;
    this.video.pause();
    this.audio?.pause();
  }
  async seek(time: number): Promise<void> {
    // Silence the companion up front — otherwise the old position keeps playing
    // audibly for the whole seek. The video's "seeked" then runs the aligned
    // resync, which restarts it in step.
    this.audio?.pause();
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
  // Volume/mute go to whichever element is actually audible: the companion
  // <audio> when a split source is playing (the <video> is muted for good
  // there), otherwise the <video> itself.
  setVolume(volume: number): void {
    this._volume = Math.min(1, Math.max(0, volume));
    if (this.audio) this.audio.volume = this._volume;
    else this.video.volume = this._volume;
  }
  getVolume(): number {
    return this.audio ? this.audio.volume : this.video.volume;
  }
  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.audio) this.audio.muted = muted;
    else this.video.muted = muted;
  }
  isMuted(): boolean {
    return this.audio ? this.audio.muted : this.video.muted;
  }
  setPlaybackRate(rate: number): void {
    this._rate = rate;
    this.video.playbackRate = rate;
    if (this.audio) this.audio.playbackRate = rate;
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
  getChapters(): unknown[] {
    return [];
  }
  getAllSubtitleCues(): unknown[] {
    return [];
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
    if (this.audio) {
      stats.Audio = "Split audio element (native)";
      stats["A/V Drift"] = `${((this.audio.currentTime - this.video.currentTime) * 1000).toFixed(0)}ms`;
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
  setStableAudio(_enabled: boolean): void {}
  setHDREnabled(_enabled: boolean): void {}
  setMaxBufferSize(_bytes: number): void {}
  setLetterboxColor(_color: unknown): void {}
  setSubtitleControlsPadding(_px: number): void {}
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
  /**
   * MoviElement hands over the `<audio>` a previous MoviPlayer released across a
   * quality switch, expecting the next player to reuse it. This wrapper runs its
   * own companion, so the donated one has to be STOPPED rather than ignored:
   * it's detached from the DOM and still playing the previous source, and the
   * hand-off drops the last reference to it — a silent no-op here leaves the old
   * audio running under the new video with nothing able to reach it.
   */
  adoptNativeAudio(el: unknown): void {
    const a = el as HTMLAudioElement | null;
    if (!a || typeof a.pause !== "function") return;
    try {
      a.pause();
      a.removeAttribute("src");
      a.load();
    } catch {
      /* noop */
    }
  }

  /** Stop and release the companion `<audio>` (nothing else can reach it). */
  private detachSplitAudio(): void {
    const a = this.audio;
    if (!a) return;
    for (const [type, fn] of this._audioHandlers) {
      try {
        a.removeEventListener(type, fn);
      } catch {
        /* noop */
      }
    }
    this._audioHandlers = [];
    try {
      a.pause();
    } catch {
      /* noop */
    }
    a.removeAttribute("src");
    try {
      a.load(); // release the network/decoder resources
    } catch {
      /* noop */
    }
    this.audio = null;
  }

  /** Aborted by destroy(), so a subtitle fetch can't outlive the wrapper. */
  private readonly lifetimeAbort = new AbortController();

  destroy(): void {
    this.lifetimeAbort.abort();
    if (this._destroyed) return;
    this._destroyed = true;
    this._playIntent = false;
    this.autoQuality = false;
    if (this.abrTimer !== null) {
      clearInterval(this.abrTimer);
      this.abrTimer = null;
    }
    this.stopSyncLoop();
    this.detachTrackElement();
    this.clearCueDisplay();
    this.detachSplitAudio();
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
