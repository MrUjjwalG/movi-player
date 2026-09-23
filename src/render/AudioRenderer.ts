/**
 * AudioRenderer - Web Audio API based audio playback with precise clock synchronization
 * Uses AudioContext as the master clock for A/V sync (60Hz smooth playback)
 */

import { Logger } from "../utils/Logger";
import {
  createSignalsmithStretcher,
  loadSignalsmith,
  type SignalsmithStretcher,
} from "../utils/signalsmith";
import type { PCMFrame } from "../decode/SoftwareAudioDecoder";

const TAG = "AudioRenderer";

// Session-wide AudioContext, shared across every AudioRenderer instance (i.e.
// across source/quality/video switches). Safari grants autoplay-with-sound per
// AudioContext via a user gesture; a brand-new context per video lands its
// resume() outside the click's activation window and gets blocked, so the
// "tap to unmute" pill reappears on every switch. Reusing ONE context means
// that once the user unmutes, it stays "running" and later videos start audible
// with no gesture — matching how native <audio> inherited media engagement.
// Created lazily on first init(); never closed (a renderer destroy() only
// disconnects its own nodes), so it survives player teardown.
let sharedAudioContext: AudioContext | null = null;
// True once the shared context has been resumed to "running" via a user gesture
// (unmute/play). A player's pause() (e.g. when a video ends) suspends the shared
// context, so the next auto-advanced / switched video would inherit a suspended
// context and re-show the "tap to unmute" pill. Once activated, a suspended
// shared context can be resumed WITHOUT a fresh gesture — so a new renderer
// wakes it during init(), before autoplay's block-check runs. Stays false until
// the first real gesture so a brand-new page's poster-seek can't leak audio.
let sharedContextActivated = false;

/**
 * Whether this session's output has ever been handed a buffer.
 *
 * Deliberately NOT part of the per-run counters: a seek resets those (the run
 * starts over) but the DEVICE does not forget it has been playing. The full
 * start cushion is for an output that has never been fed; asking a warm one
 * for it again only holds the picture longer. Module-level for the same reason
 * sharedContextActivated is — the context is shared across videos.
 */
let outputEverFed = false;

/**
 * How long play() waits on an AudioContext.resume() before carrying on
 * without it.
 *
 * Long enough for a genuine wake-up (measured at tens of ms, and ~100ms on
 * Gecko), short enough that a resume the browser has silently declined does
 * not hold playback hostage. Safari's declined resume never settles at all —
 * see the race in play().
 */
const RESUME_GRACE_MS = 1200;
/**
 * "Somebody suspended this context on purpose."
 *
 * Module scope, because the context is module scope. This was an instance
 * field, and on a shared context that made every renderer's watchdog judge a
 * suspension by whether IT had asked for one. Two renderers overlap routinely
 * — a quality switch builds the next before retiring the last — and the older
 * one is not paused, it is simply superseded, so it still reads as playing.
 * The live renderer would suspend for a user's pause and the stale one's
 * watchdog would call that unexplained and resume the context: the sound
 * carried on after the button, then stopped again once something else caught
 * up. The logs showed it plainly — ten "suspended unexpectedly" warnings and
 * twenty-one "recovered to running", two handlers answering every transition.
 *
 * The intent belongs to the context, so it is stored where the context is.
 */
let contextSuspendIntent = false;

export class AudioRenderer {
  private audioContext: AudioContext | null = null;
  // Fixed fan-in bus: every decoded source connects here. Keeping the input
  // separate from the volume node lets us reorder the compressor/gain chain
  // (stable-audio toggle) without re-touching the live sources.
  private inputNode: GainNode | null = null;
  /** A tap for drawing the sound, not for hearing it — see getLevels. Built
   *  only when something asks, and hung off the gain node in parallel, so it
   *  never sits between the audio and the speakers. */
  private _analyser: AnalyserNode | null = null;
  private _analyserBins: Uint8Array<ArrayBuffer> | null = null;
  private gainNode: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private scheduledTime: number = 0;
  private isPlaying: boolean = false;
  private volume: number = 1.0;
  private _playbackRate: number = 1.0;
  private activeSources: AudioBufferSourceNode[] = [];
  /**
   * What each live source was made from, and when it is due.
   *
   * A scheduled source is a finished thing — post-stretch PCM with a start time
   * the audio thread already owns — and there is no reading back out of it. A
   * rate change needs to do exactly that: everything scheduled ahead of the
   * playhead is at the old rate and has to go, and up to SCHEDULE_LOOKAHEAD
   * seconds of media goes with it unless the buffer it was made from can be put
   * back. Keyed weakly so a source that has played out is collectable with its
   * entry.
   */
  private sourceOrigin = new WeakMap<
    AudioBufferSourceNode,
    { buffer: AudioBuffer; audioTime: number; when: number; endsAt: number }
  >();
  private _muted: boolean = false;
  // Set while frames are being thrown away because the context is suspended
  // and we are muted (autoplay-blocked). Tells the recovery path that the
  // clock anchor describes dropped audio and has to be rebuilt.
  private droppedWhileSuspended = false;

  // Audio clock tracking for A/V sync
  private firstBufferScheduledAt: number = 0;
  /**
   * The context time this RUN of sound starts at — the moment the picture has
   * to wait out before the first of it reaches the speakers. See
   * secondsUntilAudible().
   *
   * Not the same thing as firstBufferScheduledAt, which is the anchor the
   * media clock's arithmetic hangs off and is RE-BASED whenever that
   * arithmetic needs it to be — most importantly by a speed change, which
   * moves it to "now" so the old rate's elapsed time is not read at the new
   * one. Nothing about the sound restarts there; it is playing, and has been.
   * Reading that re-based anchor as a run start answers "how long until it is
   * audible" with the device's whole output latency, which on Bluetooth is a
   * quarter of a second of picture parked at every speed change.
   */
  private soundRunStartedAt: number = 0;
  private firstBufferMediaTime: number = 0;
  private hasFirstBuffer: boolean = false;
  // performance.now() of the last buffer underrun (a hole we patched with
  // silence). Sustained underruns mean packets aren't reaching the renderer in
  // realtime — see isUnderrunning().
  private _lastUnderrunAt: number = 0;
  // True while the input is faded out to cover a run of underruns. Stitched
  // output across underruns is audibly broken — clicks and chopped syllables —
  // and chopped audio reads as "this player is broken" where silence just reads
  // as "it's loading". So we fade out for the whole stuttery stretch and fade
  // back in only once packets have flowed cleanly again. The player's buffering
  // spinner covers the same window, so the silence is explained on screen.
  private _ducked: boolean = false;
  /** Output held silent across the unmute re-read — see silenceForResync. */
  private _resyncSilenced: boolean = false;
  private static readonly DUCK_FADE_OUT = 0.01; // 10ms: beats the glitch, still too slow to click
  private static readonly DUCK_FADE_IN = 0.04; // 40ms: audibly smooth on the way back
  // Hold the silence until this long without a fresh underrun. Must stay well
  // clear of the gap cadence during a bad stretch, or we'd fade in and out
  // between holes and turn a dropout into tremolo.
  private static readonly DUCK_CLEAR_MS = 300;
  /** How often the duck re-asks whether it can lift — see duckForUnderrun. */
  private static readonly DUCK_POLL_MS = 100;
  private _duckReleaseTimer: number | null = null;
  // performance.now() before which ducking is suppressed. The player sets this
  // around a background→foreground recovery: the recovery flushes the video
  // decoder and re-seeks, which briefly starves audio — a transient underrun,
  // not glitchy playback. Ducking there would mute audio the instant the user
  // returns, which reads as "the audio stopped".
  private _suppressDuckUntil: number = 0;
  private currentMediaTime: number = 0;
  private maxScheduledMediaTime: number = 0; // Track the furthest media time we've scheduled

  /**
   * The sound is over, and no more of it is coming.
   *
   * getAudioClock() clamps to maxScheduledMediaTime so a runaway clock cannot
   * outrun what has been scheduled. That is right while more audio is on its
   * way and wrong once there is none: an audio track SHORTER than the picture
   * leaves the clock parked at the last sample for good, and everything that
   * follows it — the master clock and the renderer's own presentation timing
   * both read this — stops with it. Measured on a 4K AV1 MKV whose Opus track
   * ends at 193.4s against a picture running to 243.8s: playback stopped dead
   * at 3:13 with fifty seconds of video left.
   *
   * Once the player says the stream has ended AND the head has reached it,
   * report no clock at all. Both readers already treat a negative time as
   * "time this yourself", which is exactly right: there is no sound left to
   * sync to, and the picture should play out on its own.
   */
  private _streamEnded: boolean = false;

  /**
   * A media-time origin that takes effect at a CONTEXT time still in the
   * future — how a gapless loop turns the corner.
   *
   * The audio clock is `firstBufferMediaTime + elapsed-since-the-anchor`, so
   * moving the origin back to zero for the next pass cannot be done when that
   * pass is SCHEDULED: its samples are queued a cushion ahead of the ones
   * being heard, and re-anchoring then would drop the clock to zero while the
   * end of the previous pass is still coming out of the speakers.
   *
   * So the new origin is armed with the context time its first sample begins
   * at, and getAudioClock()/getCurrentTime() adopt it once the output has
   * actually reached that point. Before the seam they read the old pass, after
   * it the new one, and the samples themselves were never interrupted.
   */
  private _pendingAnchor: { atContextTime: number; mediaOrigin: number } | null =
    null;

  /**
   * A loop pass the player has started reading, whose first buffer has not
   * arrived yet.
   *
   * The seam used to be armed at `scheduledTime` the moment the pass began.
   * That is only where the old pass ends when nothing of it is still waiting —
   * and buffers DO wait: they sit in `_pending` as data until they come within
   * the lookahead, so on a file with a soundtrack a second of the old pass was
   * still to be scheduled behind that point, and the clock wrapped to zero a
   * second before the sound did.
   *
   * So the seam is found in the audio itself. The first buffer whose timestamp
   * jumps back is where the new pass begins; it is marked on the way in, and
   * the anchor is armed with the context time it is actually started at.
   */
  private _loopArm: { lastAudioTime: number; found: boolean } | null = null;
  /**
   * The furthest media time scheduled for the NEXT pass while the old one is
   * still being heard. Kept apart because the clock clamps to
   * maxScheduledMediaTime, and letting the new pass's small numbers in early
   * would pin the old pass's clock at them.
   */
  private _nextPassMaxMediaTime = 0;

  /** Called by the player when the demuxer has no more audio to give. */
  endOfStream(): void {
    this._streamEnded = true;
  }

  /** Has the sound already been let go for this run? */
  isStreamEnded(): boolean {
    return this._streamEnded;
  }

  /** Fresh audio is coming (a seek, a new source): the sound is not over. */
  clearEndOfStream(): void {
    this._streamEnded = false;
  }

  // Buffer health monitoring
  private lastDecodeTime: number = 0;
  private scheduledCount: number = 0;

  // Playback rate change rebuffering flag
  private isRebufferingForRateChange: boolean = false;

  // Pitch preservation via Signalsmith Stretch (MIT), compiled into the same
  // movi WASM module as FFmpeg/dav1d. Loads asynchronously on first need;
  // until then we fall back to scaling source.playbackRate (which shifts
  // pitch but keeps audio playing).
  private preservePitch: boolean = true;
  private signalsmith: SignalsmithStretcher | null = null;
  private signalsmithLoading: boolean = false;
  private signalsmithSampleRate: number = 0;
  /** Pending background build of the stretcher — see warmStretcherSoon(). */
  private stretcherWarmTimer: number | null = null;
  // Sample rate of the most recently decoded audio buffer. The stretcher is
  // fixed-rate per instance and MUST be built at this rate — not the
  // AudioContext's, which can differ (e.g. 48kHz media in a 44.1kHz context).
  // Cached here so the pre-warm on the first rate change targets the right rate
  // instead of building at the context rate and then throwing it away + lazily
  // rebuilding on the first chunk (the ~1-2s opening-silence gap).
  private _decodedSampleRate: number = 0;

  // Stable audio: master toggle (off by default, opt-in via element attribute)
  private _stableAudio: boolean = false;
  /** The state the GRAPH is actually wired for, so a repeated request for the
   *  state we are already in doesn't tear the chain apart to rebuild it
   *  identically — see setStableAudio. */
  private _wiredStableAudio: boolean = false;

  // Audio output device (AudioContext.setSinkId). "" = system default.
  // Remembered here so it survives AudioContext re-creation (init runs again
  // on source change / device loss); re-applied at the end of init().
  private _sinkId: string = "";

  // Stable audio: gain ramp duration for smooth transitions (prevents clicks/pops)
  private static readonly GAIN_RAMP_TIME = 0.015; // 15ms ramp
  /** …and how slowly a level nobody asked for is walked back, which wants to
   *  be gentle rather than quick: it is a correction to a mistake, not a
   *  response to the viewer, and it must not read as a jump. */
  private static readonly GAIN_RESTORE_TIME = 0.25;
  private static readonly FADE_OUT_TIME = 0.03; // 30ms fade-out before seek/reset

  // Stable audio: AudioContext state monitoring & auto-recovery
  private contextStateHandler: (() => void) | null = null;
  /**
   * Latches sharedContextActivated the moment the context reaches "running".
   * Separate from contextStateHandler on purpose: that one is stable audio's
   * recovery monitor and is only wired when stable audio is on, while "audio
   * got unlocked this session" is a fact every path needs — see init().
   */
  private contextActivationHandler: (() => void) | null = null;
  private recoveryAttempts: number = 0;
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;

  // Stable audio: starvation detection
  private starvationStartTime: number = 0;
  private isStarved: boolean = false;
  private static readonly STARVATION_THRESHOLD = 2000; // ms without new audio data before considered starved

  // Bluetooth keepalive: silent <audio> element played during pause to hold the
  // OS audio session so A2DP devices don't drop and re-pair. AudioContext.suspend()
  // alone releases the output route on iOS/Android; an HTMLMediaElement keeps
  // the session claimed without affecting our scheduled buffers.
  private keepaliveEl: HTMLAudioElement | null = null;
  private keepaliveUrl: string | null = null;

  constructor() {
    Logger.debug(TAG, "Created");
  }

  /**
   * Lazily create a near-silent looping <audio> element used to keep the
   * OS audio session alive while AudioContext is suspended. Uses a tiny
   * generated WAV blob so resume from pause stays seamless and Bluetooth
   * speakers/headphones don't drop the connection.
   */
  private ensureKeepalive(): HTMLAudioElement | null {
    if (this.keepaliveEl) return this.keepaliveEl;
    try {
      // 5s of 8kHz mono 8-bit silence (~40KB including 44-byte WAV header).
      // Duration matters: Chrome grants FULL audio focus — the state that
      // actually surfaces the OS media session (macOS Now Playing, Windows
      // SMTC, Linux MPRIS) — only for media ≥5s. A shorter anchor gets merely
      // transient focus, so the OS controls may never appear even though the
      // navigator.mediaSession metadata/handlers are all set correctly.
      const sampleRate = 8000;
      const numSamples = sampleRate * 5;
      const buf = new ArrayBuffer(44 + numSamples);
      const view = new DataView(buf);
      const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + numSamples, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);          // PCM
      view.setUint16(22, 1, true);          // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
      view.setUint16(32, 1, true);          // block align
      view.setUint16(34, 8, true);          // bits per sample
      writeStr(36, "data");
      view.setUint32(40, numSamples, true);
      // 8-bit unsigned PCM silence is 0x80
      const samples = new Uint8Array(buf, 44, numSamples);
      samples.fill(0x80);

      const blob = new Blob([buf], { type: "audio/wav" });
      this.keepaliveUrl = URL.createObjectURL(blob);
      const el = new Audio();
      el.src = this.keepaliveUrl;
      el.loop = true;
      el.preload = "auto";
      el.volume = 0.0001; // inaudible but enough to hold the audio session
      this.keepaliveEl = el;
    } catch (err) {
      Logger.warn(TAG, "Failed to create BT keepalive element", err);
      return null;
    }
    return this.keepaliveEl;
  }

  private startKeepalive(): void {
    const el = this.ensureKeepalive();
    if (!el) return;
    el.play().catch(() => {
      // Autoplay policies may block this without a user gesture; harmless —
      // the user already interacted to start playback before they paused.
    });
  }

  private stopKeepalive(): void {
    if (this.keepaliveEl) {
      try {
        this.keepaliveEl.pause();
        this.keepaliveEl.currentTime = 0;
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Initialize audio context
   */
  async init(): Promise<boolean> {
    try {
      // Reuse the session-wide context so a resumed (unmuted) state survives
      // source/video switches — see sharedAudioContext above. Mint a new one on
      // first use, if a prior one somehow ended up closed, or if the one we
      // inherited runs at the wrong rate for this source.
      //
      // That last case is what the sharing costs. The context is opened at the
      // FIRST source's rate and then kept for the life of the page, so the
      // second source at a different rate has every one of its buffers
      // resampled per node — the "pit pit" described below, the very thing
      // opening at the source rate was meant to cure. Reproduced directly: play
      // a 44.1kHz source, then a 48kHz one, and all ten of the second source's
      // scheduled nodes come back bufSr=48000 against ctxSr=44100. Playing the
      // 48kHz source alone gives zero mismatches, which is why this only ever
      // shows up partway through a session and clears on a reload.
      //
      // Re-minting is only free once the session has been activated by a
      // gesture: from then on a fresh context can be resumed without one, which
      // is the entire reason the sharing exists (see sharedContextActivated).
      // Before that first gesture the mismatch stays — a resampled seam is a
      // smaller price than sound that will not start at all.
      const inheritedRateWrong =
        !!sharedAudioContext &&
        sharedAudioContext.state !== "closed" &&
        this._sourceSampleRate > 0 &&
        sharedAudioContext.sampleRate !== this._sourceSampleRate;
      const remintForRate = inheritedRateWrong && sharedContextActivated;
      const retiringContext = remintForRate ? sharedAudioContext : null;
      if (!sharedAudioContext || sharedAudioContext.state === "closed" || remintForRate) {
        // Open at the SOURCE's sample rate when we know it. Every decoded
        // packet becomes its own AudioBufferSourceNode, and a buffer whose rate
        // differs from the context's is resampled PER NODE — each one resampled
        // in isolation, so every buffer boundary carries a small discontinuity.
        // At 1024 frames / 44.1kHz that is a click roughly 43 times a second:
        // the "pit pit" heard on a Chrome/Android whose output runs at 48kHz,
        // and silent on devices that happen to run at 44.1kHz, where no
        // resampling took place. Matching the rate here moves the conversion to
        // the output mix, where it is one continuous stream.
        const opts: AudioContextOptions = {
          // "interactive" gives Chromium's audio thread a shorter read-ahead
          // (~30–50ms vs ~150ms with "playback"). Without this, Chromium starves
          // when setPlaybackRate stops active sources and resets scheduledTime
          // to `now` — Safari/Firefox tolerate it because their read-ahead is
          // already short. Trade-off is a smaller output buffer cushion against
          // main-thread spikes; the audio decoder + Stable Audio gap-fill
          // already handle that case.
          latencyHint: "interactive",
        };
        if (this._sourceSampleRate > 0) opts.sampleRate = this._sourceSampleRate;
        try {
          sharedAudioContext = new AudioContext(opts);
        } catch {
          // Some devices refuse a rate outright — the browser's own is fine,
          // it just costs the per-buffer resampling described above.
          sharedAudioContext = new AudioContext({ latencyHint: "interactive" });
        }
      }
      this.audioContext = sharedAudioContext;
      if (retiringContext && retiringContext !== sharedAudioContext) {
        Logger.info(
          TAG,
          `Retired the ${retiringContext.sampleRate}Hz context for a ${this.audioContext.sampleRate}Hz one to match this ${this._sourceSampleRate}Hz source`,
        );
        // Only after the replacement is in hand, so there is never a moment
        // without a context. Best-effort: a context another player still holds
        // will simply refuse, and the worst that costs is one idle device
        // stream.
        retiringContext.close().catch(() => {});
      }
      // A shared context we could NOT re-mint (audio not unlocked yet) keeps
      // its rate, and this says so at a level someone chasing a "pit pit"
      // report will actually see: the per-buffer resampling is still in play.
      if (
        this._sourceSampleRate > 0 &&
        this.audioContext.sampleRate !== this._sourceSampleRate
      ) {
        Logger.warn(
          TAG,
          `Context runs at ${this.audioContext.sampleRate}Hz, source is ${this._sourceSampleRate}Hz — buffers will be resampled per node (clicking at buffer seams). Kept because audio has not been unlocked by a gesture yet.`,
        );
      }
      // Inheriting an already-running shared context (a prior player kept it
      // alive) is itself proof audio is unlocked — latch it so the next
      // pause-suspended switch can wake without a gesture, even if the monitor
      // below never sees a transition (no statechange fires for an already-
      // running context).
      if (this.audioContext.state === "running") sharedContextActivated = true;
      // If the user already unlocked audio this session but a prior player's
      // pause()/end left the shared context suspended, wake it here — early in
      // load, well before autoplay's suspended-context check — so an
      // auto-advanced or switched video starts audible with no "tap to unmute"
      // pill. Skipped on the very first load (not yet activated) so the poster
      // seek stays silent.
      if (sharedContextActivated && this.audioContext.state === "suspended") {
        this.audioContext.resume().catch(() => {});
      }
      this.inputNode = this.audioContext.createGain();
      // Volume / mute / makeup gain — ALWAYS the last node before destination.
      // A >100% boost lives here, applied AFTER the limiter, so stable audio's
      // compressor can't cancel it (a gain *before* the limiter would be
      // crushed straight back down — ~+6dB becomes ~+0.6dB).
      this.gainNode = this.audioContext.createGain();

      // Create compressor for stable audio (loudness normalization).
      // Tuned as a peak-limiter, not a heavy compressor: a wide soft knee
      // + low ratio (the WebAudio default-ish) flattens the whole signal
      // and the average RMS rises — perceptually that makes loud passages
      // feel *louder*, not stabler. Instead we let dialogue / mid-level
      // content pass untouched and clamp only true peaks.
      this.compressorNode = this.audioContext.createDynamicsCompressor();
      this.compressorNode.threshold.value = -18;  // only peaks > -18dB engage
      // Softer than it was, and the reason is what a 1ms attack at 20:1
      // actually does to music. That is a limiter, and it grabs every drum hit
      // the instant it crosses the threshold — the gain steps down in a
      // millisecond, holds, and walks back over 150ms, on every beat. The step
      // is heard as a faint crackle riding the transients, which is what
      // "stable volume on, very slight clicking" is.
      //
      // The intent stays: leave dialogue and mid-level content alone, clamp
      // true peaks. It is reached with a wider knee (the transition is a curve
      // rather than a corner), a firm-but-not-brickwall ratio, and an attack
      // that lets the first few milliseconds of a transient through — the part
      // that carries the punch and none of the level — before clamping the
      // body behind it. A longer release then moves the gain less often.
      this.compressorNode.knee.value = 12;
      this.compressorNode.ratio.value = 12;
      this.compressorNode.attack.value = 0.005;   // 5ms — the transient passes, its body does not
      this.compressorNode.release.value = 0.25;

      this.wireGraph();

      // Apply muted state if set before initialization
      this.gainNode.gain.value = this._muted ? 0 : this.perceptualGain(this.volume);
      // A tap built before this point would have been wired to the old graph.
      if (this._analyser) {
        this._analyser = null;
        this._analyserBins = null;
      }

      // Re-apply the chosen output device to the freshly-created context.
      // Non-blocking: a stale/removed deviceId just falls back to default.
      if (this._sinkId) {
        this.applySinkId(this._sinkId).catch(() => {});
      }

      // Don't resume here — play() handles resume when user clicks play.
      // Pre-init creates AudioContext during load for fast startup;
      // resuming here would cause poster-seek audio to leak.

      // Stable audio: monitor AudioContext state for auto-recovery
      if (this._stableAudio) {
        this.setupContextStateMonitoring();
      }

      // Always watch for the context reaching "running", whatever wakes it.
      // This latch used to live ONLY inside the stable-audio recovery monitor
      // above, so with stable audio off (the default) a context that woke on
      // its own was never noticed: wasAudioContextActivated() stayed false for
      // the whole session, and every track after the first re-ran the
      // cold-start autoplay path as if audio had never been unlocked. Gecko
      // makes that visible — it mints the context "suspended" and flips it to
      // "running" a beat after resume(), with no gesture involved, and that
      // transition arrives only as an event.
      if (!this.contextActivationHandler) {
        this.contextActivationHandler = () => {
          if (this.audioContext?.state === "running") sharedContextActivated = true;
        };
      }
      // Same (type, listener) pair — re-adding on a shared context is a no-op.
      this.audioContext.addEventListener("statechange", this.contextActivationHandler);

      Logger.info(
        TAG,
        `Initialized: sampleRate=${this.audioContext.sampleRate}, muted=${this._muted}, state=${this.audioContext.state}`,
      );

      // Warm the Signalsmith WASM module so the first rate change isn't
      // gated on a fetch. The stretcher instance is constructed lazily on
      // the first audio chunk so we use the decoded sample rate (not
      // AudioContext's, which often differs for Opus).
      loadSignalsmith();
      return true;
    } catch (error) {
      Logger.error(TAG, "Failed to initialize", error);
      return false;
    }
  }

  /**
   * Route audio to a specific output device via AudioContext.setSinkId
   * (Chromium 110+). `deviceId` "" → the system default. Stored so it
   * survives the AudioContext re-creation in init(). Returns false when
   * unsupported or the device can't be selected (e.g. unplugged).
   */
  async setSinkId(deviceId: string): Promise<boolean> {
    this._sinkId = deviceId || "";
    return this.applySinkId(this._sinkId);
  }

  /** Current output device id ("" = system default). */
  getSinkId(): string {
    const live = (this.audioContext as unknown as { sinkId?: string } | null)
      ?.sinkId;
    return typeof live === "string" ? live : this._sinkId;
  }

  /** True when the running engine can route output to a chosen device. */
  static isSinkSelectionSupported(): boolean {
    return (
      typeof AudioContext !== "undefined" &&
      typeof (AudioContext.prototype as unknown as { setSinkId?: unknown })
        .setSinkId === "function"
    );
  }

  private async applySinkId(deviceId: string): Promise<boolean> {
    const ctx = this.audioContext as unknown as {
      setSinkId?: (id: string) => Promise<void>;
    } | null;
    if (!ctx || typeof ctx.setSinkId !== "function") return false;
    try {
      await ctx.setSinkId(deviceId || "");
      Logger.info(TAG, `Output device set: ${deviceId || "(default)"}`);
      return true;
    } catch (e) {
      Logger.warn(TAG, `setSinkId failed for "${deviceId}"`, e);
      return false;
    }
  }

  /**
   * Configure audio format (logs only, format is taken from AudioData)
   */
  /** Decoded source sample rate, from configure(). 0 until the decoder reports. */
  private _sourceSampleRate = 0;
  /**
   * Until when a ramp we asked for owns the master gain (performance.now()).
   *
   * The drift check must not police a gain that is deliberately on its way
   * somewhere: a seek fades to zero and back, and a check landing inside that
   * window sees "far from target", cancels the fade and hauls the level up
   * mid-flight — which is the pumping a seek started doing the moment the
   * check was added.
   */
  private _gainHoldUntil = 0;
  /** Consecutive health ticks that have seen the gain wrong. Restoring takes
   *  two, so nothing transient is ever touched. */
  private _gainDriftStrikes = 0;

  /** Channels in the last buffer actually scheduled. A track that starts
   *  arriving as mono, or downmixed, is one of the ways "it went quiet" is
   *  true — see the health line. */
  private _lastChannels = 0;

  configure(sampleRate: number, channels: number): void {
    // Remembered for init(): opening the context at the SOURCE's rate is what
    // keeps Web Audio from resampling every buffer separately. See init().
    if (sampleRate > 0) this._sourceSampleRate = sampleRate;
    Logger.info(TAG, `Configured: ${sampleRate}Hz, ${channels}ch`);
  }

  /**
   * Maximum number of output channels the user's audio device + browser
   * combination supports. 2 (stereo) for typical laptop/phone setups,
   * 6 for a 5.1 receiver, 8 for 7.1. Returns 2 when the AudioContext
   * hasn't been created yet.
   */
  getMaxChannelCount(): number {
    return this.audioContext?.destination.maxChannelCount ?? 2;
  }

  /**
   * Ask the AudioContext destination to accept `n` discrete channels
   * instead of Web Audio's default 2. `channelCountMode: "explicit"` +
   * `channelInterpretation: "discrete"` together suppress the
   * automatic speaker-layout downmix the API would otherwise apply,
   * so a 7.1 AudioBuffer reaches the device with all 8 planes intact.
   * Caller is responsible for ensuring the OS / hardware actually has
   * that many output channels — read getMaxChannelCount() first and
   * clamp accordingly.
   */
  setOutputChannelCount(n: number): void {
    if (!this.audioContext) return;
    const dest = this.audioContext.destination;
    const clamped = Math.min(Math.max(1, Math.floor(n)), dest.maxChannelCount);
    try {
      dest.channelCount = clamped;
      dest.channelCountMode = "explicit";
      dest.channelInterpretation = "discrete";
      // GainNode defaults to channelCountMode:"max", which already
      // promotes its output to match the input — so multichannel
      // audio flows through it untouched even with channelCount=2.
      // Setting it here is a defensive no-op; documenting the
      // intent for readers chasing the same channel question. The
      // compressor (when stable audio is on) uses "clamped-max"
      // which DOES respect channelCount, so we promote it
      // explicitly — otherwise a 5.1 source would lose its
      // surround when piped through stable-audio compression.
      if (this.inputNode) {
        this.inputNode.channelCount = clamped;
      }
      if (this.gainNode) {
        this.gainNode.channelCount = clamped;
      }
      if (this.compressorNode) {
        this.compressorNode.channelCount = clamped;
      }
      Logger.info(TAG, `Destination channelCount → ${clamped} (max ${dest.maxChannelCount})`);
    } catch (e) {
      Logger.warn(TAG, "Failed to set destination channelCount", e);
    }
  }

  /**
   * Render AudioData with precise timing
   */
  render(audioData: AudioData): void {
    if (!this.audioContext || !this.gainNode) {
      audioData.close();
      return;
    }

    if (!this.isPlaying) {
      audioData.close();
      return;
    }

    // If muted and context is suspended (autoplay muted), just drop the audio
    // Audio will start playing once user unmutes (which resumes the context).
    // isDroppingAudio() — not a raw state check — so a prime's OWN suspend is
    // excluded: primeForBuffering() suspends the context on purpose so decoded
    // audio piles up against a frozen clock, and a raw check threw away exactly
    // the audio it was told to accumulate. On a muted autoplay that made the
    // cushion unreachable, so the prime dwelled its full 4s with video
    // backpressure lifted (state === buffering) and the demux loop ran away ~30s
    // into the file; when the context finally resumed, the clock re-anchored to
    // that far-ahead audio and every decoded frame behind it was stale — the
    // picture sat on frame 0 until decode caught up. That is the black start.
    if (this.isDroppingAudio()) {
      this.droppedWhileSuspended = true;
      audioData.close();
      return;
    }

    try {
      const numberOfFrames = audioData.numberOfFrames;
      const numberOfChannels = audioData.numberOfChannels;
    this._lastChannels = numberOfChannels;
      const sampleRate = audioData.sampleRate;
      const audioTime = audioData.timestamp / 1_000_000; // Convert to seconds

      const audioBuffer = this.audioContext.createBuffer(
        numberOfChannels,
        numberOfFrames,
        sampleRate,
      );

      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames);
        audioData.copyTo(channelData, {
          planeIndex: channel,
          format: "f32-planar",
        });
        audioBuffer.copyToChannel(channelData, channel);
      }

      this.scheduleAudioBuffer(audioBuffer, audioTime);
    } catch (error) {
      Logger.error(TAG, "Render error", error);
    } finally {
      audioData.close();
    }
  }

  /**
   * Render a raw PCM frame (browser-agnostic path used by the software
   * decoder). Avoids constructing a WebCodecs AudioData, which Firefox on
   * Android does not implement.
   */
  renderPCM(frame: PCMFrame): void {
    if (!this.audioContext || !this.gainNode) return;
    if (!this.isPlaying) return;
    if (this.isDroppingAudio()) {
      this.droppedWhileSuspended = true;
      return;
    }

    try {
      const audioTime = frame.timestamp / 1_000_000;
      this._lastChannels = frame.numberOfChannels;
      const audioBuffer = this.audioContext.createBuffer(
        frame.numberOfChannels,
        frame.numberOfFrames,
        frame.sampleRate,
      );

      for (let channel = 0; channel < frame.numberOfChannels; channel++) {
        audioBuffer.copyToChannel(
          frame.planes[channel] as Float32Array<ArrayBuffer>,
          channel,
        );
      }

      this.scheduleAudioBuffer(audioBuffer, audioTime);
    } catch (error) {
      Logger.error(TAG, "RenderPCM error", error);
    }
  }

  /**
   * Schedule a populated AudioBuffer through the stretcher + A/V sync
   * pipeline. Shared by render() and renderPCM().
   */
  /**
   * Decode as far ahead as the pipeline likes; keep the graph narrow anyway.
   *
   * Every scheduled buffer is a live AudioBufferSourceNode, and WebAudio pulls
   * every connected node once per render quantum whether it has started or
   * not. Committing each buffer the moment it was decoded tied the width of
   * the graph to the depth of the buffer: software audio runs a 5s lead, AAC
   * frames are 23ms, so ~215 nodes. A desktop shrugs. A phone's audio thread
   * misses its deadline, and a missed deadline is a click — measured on mobile
   * Chrome as cushion=4199ms sources=181 with the context's own outputLatency
   * wandering between 600 and 770ms, and with no underrun and no late
   * schedule: the data was there, on time, and the graph was simply too wide
   * to render.
   *
   * So the two are separated. Buffers wait here as plain data, costing
   * nothing, and become nodes only once their turn is within LOOKAHEAD. The
   * lead is unchanged — getBufferedDuration counts what is waiting — so the
   * decode headroom the deep buffer was for is still there.
   */
  private scheduleAudioBuffer(audioBuffer: AudioBuffer, audioTime: number): void {
    // The first buffer of the next loop pass: its timestamp goes BACK. Anything
    // short of a clear step back is the old pass (or ordinary PTS jitter).
    let loopStart = false;
    const arm = this._loopArm;
    if (arm && !arm.found) {
      // Stays armed (found) until that buffer is STARTED — it can wait a
      // second in _pending, and the seam must read as pending all that time.
      if (arm.lastAudioTime >= 0 && audioTime < arm.lastAudioTime - 0.25) {
        loopStart = true;
        arm.found = true;
      } else {
        arm.lastAudioTime = Math.max(arm.lastAudioTime, audioTime);
      }
    }
    this._pending.push({ buffer: audioBuffer, audioTime, loopStart });
    this._pendingDuration += audioBuffer.duration;
    this.pumpSchedule();
  }

  /**
   * Hand over every buffer whose turn has come.
   *
   * Driven both by arriving audio and by a timer, because the queue has to
   * keep draining when nothing is arriving — which is exactly what happens
   * once the player hits its buffer cap and stops feeding.
   */
  private pumpSchedule(): void {
    const ctx = this.audioContext;
    if (!ctx) return;
    while (this._pending.length > 0) {
      const lead = this.scheduledTime - ctx.currentTime;
      // First buffer of a run has nothing scheduled to measure against — let
      // it through, or nothing ever starts.
      if (this.hasFirstBuffer && lead >= AudioRenderer.SCHEDULE_LOOKAHEAD) break;
      const next = this._pending.shift();
      if (!next) break;
      this._pendingDuration = Math.max(
        0,
        this._pendingDuration - next.buffer.duration,
      );
      this.commitAudioBuffer(next.buffer, next.audioTime, next.loopStart);
    }
    if (this._pending.length > 0) {
      if (this._pumpTimer === null) {
        this._pumpTimer = setInterval(
          () => this.pumpSchedule(),
          AudioRenderer.PUMP_INTERVAL_MS,
        ) as unknown as number;
      }
    } else if (this._pumpTimer !== null) {
      clearInterval(this._pumpTimer);
      this._pumpTimer = null;
    }
  }

  private commitAudioBuffer(
    audioBuffer: AudioBuffer,
    audioTime: number,
    loopStart = false,
  ): void {
    if (!this.audioContext || !this.gainNode) return;

    // Track when we receive decoded audio
    this.lastDecodeTime = performance.now();

    // Stable audio: recover from starvation state
    if (this._stableAudio && this.isStarved) {
      this.isStarved = false;
      this.starvationStartTime = 0;
      Logger.debug(TAG, "Recovered from audio starvation");
    }

    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    this._decodedSampleRate = sampleRate;
    // Now that the decoded rate is known, get the stretcher built while nobody
    // is waiting on it.
    this.warmStretcherSoon(sampleRate);

    // Clear rebuffering flag as soon as audio data arrives (decoder is producing).
    // Don't wait for successful scheduling — the stretcher may swallow a few
    // buffers while warming up, but the flag should clear immediately.
    if (this.isRebufferingForRateChange) {
      this.isRebufferingForRateChange = false;
      Logger.debug(TAG, "Rebuffering complete after playback rate change");
    }

    // Apply pitch preservation via Signalsmith if enabled and playback rate
    // is not 1.0. If the stretcher isn't ready yet (WASM still loading) we
    // schedule expected-duration silence instead of falling back to scaling
    // source.playbackRate — that fallback shifts pitch (chipmunk audio) for
    // the ~1s of startup before the WASM stretcher kicks in. A brief silent
    // gap at the start is preferable to an audible pitch-shifted blip.
    let processedBuffer = audioBuffer;
    let usedStretcher = false;
    if (this.preservePitch && Math.abs(this._playbackRate - 1.0) > 0.01) {
      const stOutput = this.processStretch(audioBuffer, this._playbackRate);
      if (stOutput && stOutput.length > 1) {
        processedBuffer = stOutput;
        usedStretcher = true;
      } else {
        // Stretcher ready-but-warming OR not loaded yet — schedule
        // expected-duration silence so timing stays correct. Brief gap,
        // no pitch shift (no chipmunk).
        const expectedDuration = audioBuffer.duration / this._playbackRate;
        const silenceFrames = Math.max(1, Math.ceil(expectedDuration * sampleRate));
        processedBuffer = this.audioContext.createBuffer(numberOfChannels, silenceFrames, sampleRate);
        usedStretcher = true;
      }
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = processedBuffer;
    source.connect(this.inputNode ?? this.gainNode);
    source.playbackRate.value = usedStretcher ? 1.0 : this._playbackRate;

    const now = this.audioContext.currentTime;
    // The floor a buffer may be scheduled at.
    //
    // 5ms is right once playback is running: by then `scheduledTime` is seconds
    // ahead and this only guards against handing the audio thread something it
    // has already passed.
    //
    // It is wrong for the FIRST buffer of a run, and that is where a start-of-
    // track click was coming from. A run begins with nothing written ahead at
    // all, so this buffer IS the cushion — and 5ms of cushion against an output
    // device that is 168ms deep (measured on Chrome/Android; a desktop reports
    // 24ms, which is why this was never audible there) starves the very first
    // moment of playback. The log said it plainly: `cushion=28ms queued=0ms
    // sources=1 latency=168.0ms` in the health line immediately after the first
    // buffer, followed by a `late schedule` seam — one buffer, no queue, and a
    // device expecting six times more than it was given.
    //
    // So the first buffer is placed a full output-latency ahead instead. It
    // costs that much delay before sound starts — inaudible against the decode
    // and the fetch that precede it — and buys the scheduler the same window to
    // queue the buffers behind it, which is what the device is actually asking
    // for. Every buffer after it takes the 5ms floor as before.
    const ctx = this.audioContext as AudioContext & {
      outputLatency?: number;
      baseLatency?: number;
    };
    // …and that reasoning is about a device that has never been fed. The
    // starvation it describes is the first buffer of a SESSION, where nothing
    // has primed the output at all.
    //
    // A seek restarts a run on a device that has been playing for minutes: the
    // flush cleared our scheduling, not the device's own pipeline, and the
    // decoder already has packets queued so the buffers behind this one land
    // within a frame or two. Paying the full lead there costs the viewer real
    // time — the picture is held for exactly this figure plus the output
    // latency (see expectedStartLead), which on Bluetooth is why the frames
    // pause for the better part of a second after every seek.
    //
    // So the full cushion for a cold start, a small one once warm.
    const latency = ctx.outputLatency ?? ctx.baseLatency ?? 0;
    const warmOutput = outputEverFed;
    const deviceLead = this.hasFirstBuffer
      ? 0
      : Math.min(warmOutput ? 0.12 : 0.5, latency);
    const minTime = now + 0.005 + deviceLead;

    // Detect buffer underrun
    if (this.scheduledTime < now) {
      // Record it: a run of these means the decode pipeline is behind realtime
      // and playback is audibly broken. The player watches this to show its
      // buffering state instead of pretending to play while we quietly patch
      // holes with silence. (Only counts once we're actually playing out —
      // before the first buffer there's nothing to under-run.)
      if (this.hasFirstBuffer) {
        this._lastUnderrunAt = performance.now();
        // Silence the output for this stretch. The gap fill below stops the
        // pops at the seams, but what plays between the holes is still chopped
        // — better not heard at all.
        this.duckForUnderrun();
      }

      // Stable audio: fill the gap with a short silence buffer to prevent pops
      if (this._stableAudio && this.hasFirstBuffer && this.audioContext) {
        const gapDuration = now - this.scheduledTime;
        if (gapDuration > 0.005 && gapDuration < 1.0) {
          try {
            const silenceFrames = Math.ceil(gapDuration * sampleRate);
            const silenceBuffer = this.audioContext.createBuffer(
              numberOfChannels, silenceFrames, sampleRate
            );
            const silenceSource = this.audioContext.createBufferSource();
            silenceSource.buffer = silenceBuffer;
            silenceSource.connect(this.inputNode ?? this.gainNode);
            silenceSource.start(this.scheduledTime);
            silenceSource.onended = () => {
              try { silenceSource.disconnect(); } catch { /* ignore */ }
            };
            Logger.debug(TAG, `Gap filled: ${(gapDuration * 1000).toFixed(1)}ms silence`);
          } catch {
            // Ignore gap fill errors
          }
        }
      }

      this.scheduledTime = minTime;

      if (this.hasFirstBuffer) {
        // Pivot global clock if we underrun (resync)
        this.firstBufferScheduledAt = minTime;
        this.firstBufferMediaTime = audioTime;
        // The sound ran out and begins again here, so this one IS a run start.
        this.soundRunStartedAt = minTime;
      }
    }

    // Packets are flowing again if this buffer arrived without a hole; fade
    // back in once that's held for DUCK_CLEAR_MS. No-op unless ducked.
    this.unduckIfClean();

    // Where this buffer should start.
    //
    // Two things can pull it away from where the last one ended, and both used
    // to do it silently — which is what a click IS: a seam with nothing across
    // it. Neither trips the underrun test above, because that only asks
    // whether we are already late; these happen while the schedule is still in
    // the future, so they were invisible in every log.
    let targetScheduleTime = this.scheduledTime;

    if (this.hasFirstBuffer) {
      const expectedTime =
        this.firstBufferScheduledAt +
        (audioTime - this.firstBufferMediaTime) / this._playbackRate;

      const drift = expectedTime - this.scheduledTime;
      // 1. Re-anchoring to the media timeline. A 20ms disagreement between
      //    where the PTS says this buffer belongs and where the previous one
      //    ended was corrected by jumping straight to the PTS — tearing a 20ms
      //    hole, or overlapping 20ms of two buffers, on every correction. On a
      //    source whose PTS grid does not divide evenly into its frame
      //    duration that correction fires over and over, which is a click
      //    every few hundred milliseconds and nothing in the log.
      //
      //    Forward is now filled rather than jumped. Backward is not honoured
      //    at all: playing two buffers over each other is worse than being
      //    20ms early, and the clock's own sync corrects the offset without
      //    touching the audio.
      if (drift > 0.02) {
        this.fillSeam(
          this.scheduledTime,
          drift,
          numberOfChannels,
          sampleRate,
          "re-anchor",
        );
        targetScheduleTime = expectedTime;
      }
    }

    // 2. The floor. Scheduling that lands inside the 5ms guard gets pushed to
    //    it, and that push is a hole of exactly the same kind. It is the one
    //    that shows up on a phone: the guard is a fixed 5ms while the main
    //    thread there is slower and less predictable, so the schedule arrives
    //    late often enough to be heard, without ever falling behind `now` and
    //    registering as an underrun.
    const when = Math.max(targetScheduleTime, minTime);
    if (when > targetScheduleTime + 0.0005) {
      this.fillSeam(
        targetScheduleTime,
        when - targetScheduleTime,
        numberOfChannels,
        sampleRate,
        "late schedule",
      );
    }
    source.start(when);

    // The next loop pass starts sounding at `when` — that is the seam, exact
    // at any rate, and the clock takes the new origin once output reaches it.
    if (loopStart && this.hasFirstBuffer) {
      this._loopArm = null;
      this._pendingAnchor = { atContextTime: when, mediaOrigin: audioTime };
      this._nextPassMaxMediaTime = 0;
      Logger.debug(
        TAG,
        `Loop seam at context ${when.toFixed(3)}s → media ${audioTime.toFixed(3)}s`,
      );
    }

    if (!this.hasFirstBuffer) {
      this.firstBufferScheduledAt = when;
      this.firstBufferMediaTime = audioTime;
      // A genuine start: nothing is coming out of the speakers yet.
      this.soundRunStartedAt = when;
      this.hasFirstBuffer = true;
      Logger.debug(
        TAG,
        `First buffer scheduled at ${when.toFixed(3)}s, mediaTime=${audioTime.toFixed(3)}s`,
      );
    }

    this.activeSources.push(source);
    this.scheduledTime = when + (usedStretcher
      ? processedBuffer.duration
      : audioBuffer.duration / this._playbackRate);
    // The buffer this was made from, kept so a rate change can hand back the
    // part nobody has heard yet — see setPlaybackRate. The ORIGINAL, not the
    // stretched one: the stretched copy is at the rate being left behind, and
    // re-stretching it would apply the tempo shift twice.
    this.sourceOrigin.set(source, {
      buffer: audioBuffer,
      audioTime,
      when,
      endsAt: this.scheduledTime,
    });

    // Once a second, what the output actually has in hand.
    //
    // Three rounds of chasing a mobile-only click have ruled out the rate, the
    // lifecycle and the schedule — every log came back clean because nothing
    // reports the state the clicking would show up in. These four numbers do:
    // the cushion (how far ahead of the hardware we have written), how many
    // sources are alive, whether the context is still running, and what it
    // thinks its own latency is. A cushion collapsing towards zero, a source
    // count that climbs across a track change, or an output latency that moves
    // are three different bugs, and this tells them apart.
    //
    // …and what the output is being multiplied BY, which none of the four
    // said. "It went quiet after a seek" is a report these lines could not
    // answer: the master gain, the underrun duck and the channel count are
    // three separate ways for the same complaint to be true, and a log with
    // none of them in it leaves guessing as the only move.
    if (
      this.audioContext &&
      now - this._lastHealthLogAt > 1
    ) {
      this._lastHealthLogAt = now;
      const ctx = this.audioContext as AudioContext & {
        outputLatency?: number;
        baseLatency?: number;
      };
      this.policeMasterGain();

      Logger.debug(
        TAG,
        `Output: cushion=${((this.scheduledTime - now) * 1000).toFixed(0)}ms ` +
          `queued=${(this._pendingDuration * 1000).toFixed(0)}ms ` +
          `sources=${this.activeSources.length} state=${ctx.state} ` +
          `gain=${this.gainNode ? this.gainNode.gain.value.toFixed(3) : "-"}` +
          `/${this.perceptualGain(this.volume).toFixed(3)} ` +
          (this._ducked ? "DUCKED " : "") +
          (this._muted ? "MUTED " : "") +
          `ch=${this._lastChannels} ` +
          (this._stableAudio && this.compressorNode
            ? `gr=${this.compressorNode.reduction.toFixed(1)}dB `
            : "") +
          `latency=${(((ctx.outputLatency ?? ctx.baseLatency ?? 0)) * 1000).toFixed(1)}ms ` +
          `rate=${ctx.sampleRate}`,
      );
    }
    this.currentMediaTime = audioTime;
    this.scheduledCount++;
    outputEverFed = true;

    const endMediaTime = audioTime + audioBuffer.duration;
    if (this._pendingAnchor) {
      if (endMediaTime > this._nextPassMaxMediaTime) {
        this._nextPassMaxMediaTime = endMediaTime;
      }
    } else if (endMediaTime > this.maxScheduledMediaTime) {
      this.maxScheduledMediaTime = endMediaTime;
    }

    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) {
        this.activeSources.splice(idx, 1);
      }
      try {
        source.disconnect();
      } catch {
        // Ignore
      }
    };
  }

  /**
   * Render raw PCM samples
   */
  renderSamples(samples: Float32Array[], sampleRate: number): void {
    if (!this.audioContext || !this.gainNode) return;
    if (!this.isPlaying) return;
    this._decodedSampleRate = sampleRate;

    try {
      const numberOfChannels = samples.length;
      const numberOfFrames = samples[0].length;

      const audioBuffer = this.audioContext.createBuffer(
        numberOfChannels,
        numberOfFrames,
        sampleRate,
      );

      for (let channel = 0; channel < numberOfChannels; channel++) {
        audioBuffer.copyToChannel(
          samples[channel] as Float32Array<ArrayBuffer>,
          channel,
        );
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.inputNode ?? this.gainNode);
      source.playbackRate.value = this._playbackRate;

      const currentTime = this.audioContext.currentTime;
      const startTime = Math.max(currentTime, this.scheduledTime);

      source.start(startTime);
      this.scheduledTime =
        startTime + audioBuffer.duration / this._playbackRate;
    } catch (error) {
      Logger.error(TAG, "Render samples error", error);
    }
  }

  /**
   * Start playback
   */
  async play(): Promise<void> {
    // Flip isPlaying up front, BEFORE any await. The resume branch in the
    // player's notifySeekCompletion calls play() fire-and-forget and then
    // immediately decodes the first post-seek audio packets. If we only set
    // isPlaying after awaiting audioContext.resume() (which on replay can take
    // tens of ms while the context wakes from suspended), every frame decoded
    // during that window — the 0s frame and the next ~1s of audio — hits
    // render()'s `!isPlaying` guard and gets dropped. The first surviving
    // frame is then ~1s in, so replay starts playing ahead of 0. Setting the
    // flag synchronously here lets those early frames schedule; they sit in
    // the AudioContext queue and play once it resumes.
    this.isPlaying = true;
    contextSuspendIntent = false;

    // Don't initialize AudioContext during muted autoplay (browser policy)
    // It will be initialized when user unmutes (user gesture)
    if (!this.audioContext && !this._muted) {
      await this.init();
    }

    // Eager stretcher warmup when starting playback already at a non-1x rate
    // (saved preference, or rate set while paused). Kicks WASM construction
    // off now so it's ready before the first decoded chunk needs stretching,
    // avoiding the opening silence gap the chunk-time lazy init would leave.
    // Build at the decoded media rate when known (falls back to the context
    // rate before the first chunk) so we don't build the wrong-rate instance
    // and pay a destroy+rebuild when audio arrives at a different rate.
    if (
      this.preservePitch &&
      this.audioContext &&
      !this.signalsmith &&
      Math.abs(this._playbackRate - 1.0) > 0.01
    ) {
      this.maybeInitSignalsmith(
        this._decodedSampleRate || this.audioContext.sampleRate,
      );
    }

    // Resume the AudioContext when either (a) we're not muted so audio
    // can actually play, OR (b) we suspended it ourselves via pause()
    // and need to wake it back up. The original `!_muted` gate was a
    // browser-autoplay-policy safety net for the very first play before
    // any user gesture had unlocked audio — but a resume-after-pause
    // has already crossed that gate (pause() only suspends a running
    // context, which only reached running via a prior gesture). Without
    // the second branch, a muted pause→play leaves the context stuck
    // suspended, audio time stops advancing, and the canvas renderer's
    // audio-synced presentation loop wedges on its last frame even
    // though the Clock keeps ticking via fallback time.
    if (
      this.audioContext?.state === "suspended" &&
      (!this._muted || contextSuspendIntent)
    ) {
      try {
        const resuming = this.audioContext.resume();
        // Remember that this session's shared context is unlocked, so future
        // auto-advanced / switched videos can wake it without a fresh gesture.
        // Hung off the promise itself rather than read after the race below:
        // a resume that lands late still counts.
        void resuming
          .then(() => {
            if ((this.audioContext?.state as string) === "running") {
              sharedContextActivated = true;
            }
          })
          .catch(() => {});
        // Bounded, because a resume the browser will not grant does not always
        // REJECT. Safari leaves it pending until a gesture arrives, and every
        // caller awaiting it stops there — which took the whole player down
        // with it: the buffering→resume path awaited this and so never reached
        // clock.start() or the "playing" state. Read off a session's log, the
        // video sat on its poster with no error, no autoplay fallback and no
        // "Tap to unmute" pill, and the viewer had to press play by hand.
        //
        // Past the grace, playback starts without sound. That is the same
        // bargain the muted-autoplay fallback makes, and the element raises
        // the pill for it once the picture is moving.
        await Promise.race([
          resuming,
          new Promise<void>((r) => setTimeout(r, RESUME_GRACE_MS)),
        ]);
      } catch (err) {
        Logger.warn(
          TAG,
          "Failed to resume AudioContext (user gesture may be required)",
          err,
        );
      }
    }

    // Play the silent anchor <audio> for the duration of playback. WebCodecs +
    // Web Audio never request Android Audio Focus on their own, so without a
    // real playing media element the OS Media Session notification never
    // appears / can't be controlled. This element is the anchor; it is PAUSED
    // again in pause() so the notification's play/pause state mirrors the real
    // player (Chrome derives that state from the element, not from
    // navigator.mediaSession.playbackState, on many platforms).
    this.startKeepalive();

    // Warmup context (Safari fix) - only if not muted
    if (!this._muted && this.audioContext) {
      this.warmupContext();
    }

    // Reset last decode time to prevent false unhealthy buffer detection after long pause
    this.lastDecodeTime = performance.now();

    // isPlaying / intentionalSuspend already set synchronously at the top of
    // play() so no decoded frames are dropped during the async resume window.

    // NOTE: We do NOT reset scheduledTime or sync anchors here.
    // If we are resuming from pause (suspend), the buffer is preserved
    // and we want to continue exactly where we left off.
    // If this is a fresh start or seek, reset() would have been called previously.

    Logger.debug(
      TAG,
      `Playing (muted: ${this._muted}, audioContext: ${this.audioContext ? "initialized" : "deferred"}, state: ${this.audioContext?.state || "N/A"})`,
    );
  }

  /**
   * Kick off Signalsmith stretcher construction. Single-flight; idempotent.
   * The movi WASM module is shared with FFmpeg, so this is fast once the
   * player has loaded — just an instance allocation.
   */
  /**
   * Build the pitch-preserving stretcher in the background, before anyone asks
   * for a speed change.
   *
   * It used to be built when the speed actually changed, and the speed changing
   * is the worst moment to start: the build is an async WASM load, and until it
   * lands every chunk is deliberately scheduled as silence rather than as
   * pitch-shifted audio (see commitAudioBuffer). That choice is right — a
   * chipmunk blip is worse than a gap — but it means the whole load time is
   * heard as a hole, which is the second of silence on the first speed change.
   * Nothing about that load needs the speed change to have happened.
   *
   * So it is built once playback is settled, at the DECODED sample rate, which
   * is only known after some audio has come through (the stretcher is
   * fixed-rate per instance, and building at the context rate instead means
   * destroying it and rebuilding at the real rate on the first chunk — the same
   * silence, just moved). One instance per session, off the startup path.
   */
  private warmStretcherSoon(sampleRate: number): void {
    if (!this.preservePitch) return;
    if (this.signalsmith || this.signalsmithLoading) return;
    if (this.stretcherWarmTimer !== null) return;
    this.stretcherWarmTimer = setTimeout(() => {
      this.stretcherWarmTimer = null;
      // Late enough that starting a video does not compete with it, early
      // enough that nobody has reached the speed menu yet.
      this.maybeInitSignalsmith(this._decodedSampleRate || sampleRate);
    }, AudioRenderer.STRETCHER_WARM_DELAY_MS) as unknown as number;
  }

  private maybeInitSignalsmith(sampleRate: number): void {
    if (this.signalsmith || this.signalsmithLoading) return;
    this.signalsmithLoading = true;
    this.signalsmithSampleRate = sampleRate;
    createSignalsmithStretcher(sampleRate, 2)
      .then((s) => {
        this.signalsmithLoading = false;
        if (!s) return;
        s.tempo = this._playbackRate;
        s.pitch = 1.0;
        this.signalsmith = s;
        Logger.info(TAG, `Signalsmith ready @ ${sampleRate}Hz`);
      })
      .catch((err) => {
        this.signalsmithLoading = false;
        Logger.warn(TAG, "Signalsmith init failed", err);
      });
  }

  /**
   * Pitch-preserving time stretch through Signalsmith. Returns the stretched
   * AudioBuffer, or null if the stretcher isn't ready yet (caller falls back
   * to source.playbackRate scaling, which shifts pitch but keeps audio playing).
   */
  private processStretch(
    inputBuffer: AudioBuffer,
    playbackRate: number,
  ): AudioBuffer | null {
    if (!this.audioContext) return null;

    const numChannels = inputBuffer.numberOfChannels;
    const sampleRate = inputBuffer.sampleRate;
    const inputFrames = inputBuffer.length;

    // Drop + rebuild the stretcher if the decoded sample rate changed —
    // Signalsmith is fixed-rate per instance.
    if (this.signalsmith && this.signalsmithSampleRate !== sampleRate) {
      this.signalsmith.destroy();
      this.signalsmith = null;
    }
    this.maybeInitSignalsmith(sampleRate);

    if (!this.signalsmith) return null; // still loading — caller falls back

    const stretcher = this.signalsmith;
    stretcher.tempo = this._playbackRate;
    stretcher.pitch = 1.0;

    // Convert planar AudioBuffer → interleaved stereo for the WASM API.
    const interleavedInput = new Float32Array(inputFrames * 2);
    const leftChannel = inputBuffer.getChannelData(0);
    const rightChannel = numChannels > 1 ? inputBuffer.getChannelData(1) : leftChannel;
    for (let i = 0; i < inputFrames; i++) {
      interleavedInput[i * 2] = leftChannel[i];
      interleavedInput[i * 2 + 1] = rightChannel[i];
    }

    stretcher.inputBuffer.putSamples(interleavedInput, 0, inputFrames);
    stretcher.process();

    const expectedFrames = Math.ceil(inputFrames / playbackRate);
    const availableFrames = stretcher.outputBuffer.frameCount;
    const framesToExtract = Math.min(expectedFrames, availableFrames);

    if (framesToExtract === 0) {
      // Stretcher is still warming up — caller should skip scheduling.
      return null;
    }

    const interleavedOutput = new Float32Array(framesToExtract * 2);
    stretcher.outputBuffer.receiveSamples(interleavedOutput, framesToExtract);

    const outputBuffer = this.audioContext.createBuffer(
      numChannels,
      framesToExtract,
      sampleRate,
    );
    const outputLeft = outputBuffer.getChannelData(0);
    const outputRight = numChannels > 1 ? outputBuffer.getChannelData(1) : null;
    for (let i = 0; i < framesToExtract; i++) {
      outputLeft[i] = interleavedOutput[i * 2];
      if (outputRight) outputRight[i] = interleavedOutput[i * 2 + 1];
    }

    return outputBuffer;
  }

  /**
   * Warmup AudioContext (Safari fix)
   */
  private warmupContext(): void {
    if (!this.audioContext) return;
    try {
      const emptyBuffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = emptyBuffer;
      source.connect(this.audioContext.destination);
      source.start();
    } catch {
      // Ignore
    }
  }

  /**
   * Pause playback
   */
  // Flag to prevent auto-recovery when we intentionally suspend during buffering


  pause(): void {
    this.isPlaying = false;

    // Pause the silent media-session anchor <audio> so the OS notification's
    // play/pause state mirrors the real player. On many platforms Chrome drives
    // the lock-screen state from the media element's own play/paused state, NOT
    // from navigator.mediaSession.playbackState — so a continuously-playing
    // anchor leaves the notification frozen on "playing". Mirroring it (play on
    // play, pause on pause) is what makes the OS UI actually update on each
    // action. Trade-off: A2DP Bluetooth may re-negotiate on resume; a correct
    // lock-screen state is worth more than avoiding that.
    this.stopKeepalive();

    // Don't stop sources or clear buffers!
    // Just suspend the context to pause time.
    // This preserves the audio buffer (scheduled nodes) so we resume exactly where we left off.
    // If we clear sources, we lose the buffered audio (e.g. 2 seconds worth), causing the
    // player to jump forward by that amount on resume.
    if (this.audioContext && this.audioContext.state === "running") {
      contextSuspendIntent = true;
      this.audioContext.suspend().catch((err) => {
        Logger.error(TAG, "Failed to suspend audio context", err);
      });
    }

    // We do NOT reset clock tracking here.
    // Since we are suspending the context, the relationship between
    // AudioContext.currentTime and media time is preserved.

    Logger.debug(TAG, "Paused");
  }

  /**
   * Suspend audio output for buffering without stopping data acceptance.
   * Keeps isPlaying=true so render() still accepts AudioData and buffers fill up.
   * Suppresses auto-recovery so the context stays suspended until resumeFromBuffering().
   */
  suspendForBuffering(): void {
    contextSuspendIntent = true;
    if (this.audioContext && this.audioContext.state === "running") {
      this.audioContext.suspend().catch((err) => {
        Logger.error(TAG, "Failed to suspend audio context for buffering", err);
      });
    }
    Logger.debug(TAG, "Suspended for buffering (isPlaying still true)");
  }

  /**
   * Prepare for the first-play / replay audio prime: mark the renderer playing
   * so render() accepts decoded audio and the buffer fills, but hold the
   * AudioContext suspended so nothing drains until resumeFromBuffering().
   *
   * Unlike play() + suspendForBuffering(), this NEVER issues an async resume().
   * That pair raced on replay: after `ended`, pause() leaves the context
   * suspended; the prime's fire-and-forget play() then kicks off an async
   * resume(), and the immediately-following suspendForBuffering() sees the
   * context still "suspended" (resume in flight) so its state===running guard
   * skips the suspend — the late resume then wins and the context stays
   * running for the whole prime, draining the primed audio and underrunning
   * the sub-realtime software decoder into a flood of gap-fills. Priming
   * without ever resuming removes the race entirely.
   */
  primeForBuffering(): void {
    this.isPlaying = true;
    contextSuspendIntent = true;
    if (!this.audioContext && !this._muted) {
      // Context deferred (never created yet) — bring it up, then hold it
      // suspended. Any audio decoded before init resolves has nowhere to
      // schedule, but by the prime path the context already exists in every
      // observed flow (first play created it during the poster seek); this is
      // just a safety net.
      this.init()
        .then(() => {
          if (contextSuspendIntent && this.audioContext?.state === "running") {
            this.audioContext.suspend().catch(() => {});
          }
        })
        .catch(() => {});
    } else if (this.audioContext && this.audioContext.state === "running") {
      this.audioContext.suspend().catch((err) => {
        Logger.error(TAG, "Failed to suspend audio context for prime", err);
      });
    }
    this.lastDecodeTime = performance.now();
    Logger.debug(TAG, "Primed for buffering (context held suspended)");
  }

  /**
   * Resume audio after buffering. Clears the intentional suspend flag.
   */
  resumeFromBuffering(): void {
    contextSuspendIntent = false;
    if (this.audioContext && this.audioContext.state === "suspended") {
      this.audioContext.resume().catch((err) => {
        Logger.error(TAG, "Failed to resume audio context from buffering", err);
      });
    }
    Logger.debug(TAG, "Resumed from buffering");
  }

  /**
   * Set volume (0-1) with smooth ramping to prevent clicks/pops
   */
  setVolume(volume: number): void {
    // 0–2: values above 1 boost up to 200% (VLC-style).
    this.volume = Math.max(0, Math.min(2, volume));
    if (this.gainNode && !this._muted && !this._fadingOut) {
      const g = this.perceptualGain(this.volume);
      if (this._stableAudio) {
        this.rampGain(g);
      } else {
        this.gainNode.gain.value = g;
      }
    }
    Logger.debug(TAG, `Volume: ${this.volume} (muted: ${this._muted})`);
  }

  /**
   * Get volume
   */
  getVolume(): number {
    return this.volume;
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate: number): void {
    const newRate = Math.max(0.25, Math.min(4, rate));
    if (this._playbackRate === newRate) return;

    const oldRate = this._playbackRate;

    // Clear stretcher state when rate changes.
    if (this.preservePitch && this.signalsmith) {
      this.signalsmith.tempo = newRate;
      this.signalsmith.clear();
    } else if (
      this.preservePitch &&
      Math.abs(newRate - 1.0) > 0.01 &&
      this.audioContext
    ) {
      // Eager warmup: kick off WASM stretcher construction the moment a
      // non-1x rate is chosen, BEFORE the first audio chunk arrives. Without
      // this the stretcher only starts loading inside processStretch() on the
      // first chunk, leaving the opening ~1s with no stretcher — which falls
      // through to the silence path (no chipmunk, but a brief audio gap).
      // Warming it ahead of the chunks closes that gap in the common case.
      //
      // Build at the DECODED media rate (cached from the audio already
      // playing), NOT the AudioContext rate — they differ when e.g. 48kHz
      // media plays in a 44.1kHz context. Building at the context rate made
      // processStretch destroy it and lazily rebuild at the real rate on the
      // first chunk, which reintroduced the very ~1-2s silence this warmup
      // exists to prevent (only on the FIRST rate change; later ones reused the
      // now-correct instance). Fall back to the context rate only before any
      // audio has decoded.
      this.maybeInitSignalsmith(
        this._decodedSampleRate || this.audioContext.sampleRate,
      );
    }

    // Re-anchor the audio→media clock at the CURRENT play position, then take
    // back the stale old-rate audio scheduled ahead of `now` so the rate change
    // is heard immediately instead of after a multi-second tail.
    //
    // TAKE BACK, not throw away — that distinction is the whole second of
    // silence this used to cost.
    //
    // Everything scheduled ahead is old-rate and cannot stay. It used to be
    // stopped and forgotten, with scheduledTime pulled to `now` on the reasoning
    // that the next decoded chunk would then play immediately. It does not: that
    // chunk's media time is a full SCHEDULE_LOOKAHEAD past the playhead, because
    // that is precisely the span just discarded, and the scheduler honours the
    // media timeline — it puts the chunk where its PTS says it belongs and fills
    // the space in front with silence. One second of scheduled audio dropped is
    // therefore one second of hole, and the picture, which follows the audio
    // clock, stops with it. That is the interruption on every speed change.
    //
    // Nothing about that audio was wrong except its rate, and the buffers it was
    // built from are still to hand (see sourceOrigin). So the sources that have
    // not begun are stopped and their ORIGINAL buffers pushed back onto the
    // pending queue, in order, to be stretched again at the new rate and
    // rescheduled behind whatever is playing right now. No media is skipped, so
    // there is no hole to fill; the seam is a buffer boundary that was never
    // heard.
    //
    // The one source already playing is left alone. It finishes at the old rate
    // — a chunk, tens of milliseconds — and is the bridge across the change
    // rather than a click to be faded over.
    //
    // Crucially we do NOT clear firstBufferMediaTime / hasFirstBuffer the way
    // reset() does. Keeping the anchor (mapped through the OLD rate up to now)
    // means the next chunk schedules via expectedTime against the current
    // playhead — so the audio clock does NOT leap to the demuxer's read-ahead
    // mediaTime, and the video does not hard-snap forward. That leap was the
    // "jumps 1–3s ahead on rate change" regression.
    //
    // None of this may be skipped while the context is SUSPENDED, which is
    // what pause() leaves behind — and requiring "running" here skipped all of
    // it, so a rate change made from a paused player re-anchored nothing.
    // getAudioClock() maps the whole span since the anchor through the
    // CURRENT rate, so on resume the entire pre-change history was re-scaled:
    // anchored at media 108.716, played 6.82s at 1x to a pause at 115.532,
    // then 1x → 0.25x gave 108.716 + 6.82 * 0.25 = 110.42 — the clock reported
    // 110.427 and the picture, which may not go back over frames it has
    // already shown, froze for the 5.1s hole. At 0.25x that is 20 seconds of
    // still image. A suspended context is the ideal place to do this work:
    // currentTime is frozen at the instant of the pause, so `now` IS the
    // paused position and the same arithmetic that is right while running is
    // right here. Only a closed context has nothing to re-anchor.
    if (
      this.audioContext &&
      this.audioContext.state !== "closed" &&
      this.hasFirstBuffer
    ) {
      const now = this.audioContext.currentTime;
      const currentMediaTime =
        this.firstBufferMediaTime +
        (now - this.firstBufferScheduledAt) * oldRate;
      this.firstBufferScheduledAt = now;
      this.firstBufferMediaTime = currentMediaTime;

      // A hair of slack on "has it begun": a source due within a few
      // milliseconds is already the audio thread's, and stopping it is a cut in
      // sound that is on its way out of the speaker.
      const started = now + 0.005;
      const reclaimed: { buffer: AudioBuffer; audioTime: number }[] = [];
      // The context time the retained audio runs out at, which is where the
      // new-rate audio has to begin. `now` when nothing is playing.
      let seam = now;
      // Over a copy: stop() fires onended, which splices activeSources.
      for (const source of [...this.activeSources]) {
        const origin = this.sourceOrigin.get(source);
        // Playing right now: leave it, and start the new rate where it ends.
        if (origin && origin.when <= started) {
          seam = Math.max(seam, origin.endsAt);
          continue;
        }
        // Everything else goes. With an origin it comes back below; without one
        // it can only be dropped — but it still has to be stopped, or old-rate
        // audio would play over what is scheduled in its place.
        try {
          source.stop();
          source.disconnect();
        } catch {
          /* ignore */
        }
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) this.activeSources.splice(idx, 1);
        if (origin) {
          reclaimed.push({ buffer: origin.buffer, audioTime: origin.audioTime });
        }
      }

      // Back at the FRONT of the queue and in schedule order: this is the media
      // immediately after what is playing, and everything already waiting comes
      // after it.
      if (reclaimed.length > 0) {
        this._pending.unshift(...reclaimed);
        for (const r of reclaimed) this._pendingDuration += r.buffer.duration;
      }

      // Where the new rate starts: the end of the audio still in flight, so the
      // two meet without a gap and without playing over each other. Stretcher
      // ring already cleared above.
      this.scheduledTime = seam;
    }

    this._playbackRate = newRate;
    // Refill now, at the new rate. The queue drains on arriving audio or on its
    // own timer, and neither is due: the player parks its audio loop once the
    // buffer is deep, and the timer only runs while something was left waiting.
    // Without this the reclaimed audio would sit there until the retained chunk
    // had run out — which is the hole again, just a smaller one.
    this.pumpSchedule();
  }

  /**
   * Get playback rate
   */
  getPlaybackRate(): number {
    return this._playbackRate;
  }

  /**
   * Set pitch preservation mode
   */
  setPreservePitch(preserve: boolean): void {
    this.preservePitch = preserve;
    Logger.debug(TAG, `Pitch preservation: ${preserve}`);
  }

  /**
   * Get pitch preservation mode
   */
  getPreservePitch(): boolean {
    return this.preservePitch;
  }

  /**
   * Check if audio is rebuffering due to playback rate change
   */
  isRebuffering(): boolean {
    return this.isRebufferingForRateChange;
  }

  /**
   * Mute with smooth fade to prevent clicks/pops
   */
  mute(): void {
    this._muted = true;
    if (this.gainNode) {
      if (this._stableAudio) {
        this.rampGain(0);
      } else {
        this.gainNode.gain.value = 0;
      }
    }
    Logger.debug(TAG, "Muted");
  }

  /**
   * Unmute with smooth fade to prevent clicks/pops
   */
  async unmute(): Promise<void> {
    this._muted = false;

    // Initialize AudioContext on unmute if not already initialized (user gesture)
    // This happens during autoplay muted -> unmute transition
    if (!this.audioContext && this.isPlaying) {
      await this.init();
    }

    if (this.gainNode && !this._fadingOut) {
      const g = this.perceptualGain(this.volume);
      if (this._stableAudio) {
        this.rampGain(g);
      } else {
        this.gainNode.gain.value = g;
      }
    }

    // Resume AudioContext on unmute (user gesture) if it was suspended.
    // Awaited, so callers can sequence work behind a context that is actually
    // running: the "running" statechange drops the stale clock anchor (see
    // contextStateHandler), and anything scheduled before that lands on an
    // anchor about to be thrown away — audio for those seconds is discarded
    // as late while the wall clock walks the picture forward without it.
    //
    // …but only while playback is actually running. pause() suspends the
    // context and deliberately KEEPS its scheduled nodes, so that resuming
    // continues exactly where it stopped — which means a resume() here starts
    // them. Unmuting a paused player played it: pause, mute, unmute, and the
    // audio ran on over a still picture. Nothing is lost by waiting; play()
    // resumes the context itself, and that press is a user gesture too, so the
    // first unmute still gets its unlock.
    if (
      this.isPlaying &&
      this.audioContext &&
      this.audioContext.state === "suspended"
    ) {
      try {
        await this.audioContext.resume();
        Logger.debug(TAG, "AudioContext resumed on unmute");
      } catch (err) {
        Logger.warn(TAG, "Failed to resume AudioContext on unmute", err);
      }
    }

    Logger.debug(TAG, "Unmuted");
  }

  /**
   * Reset timing and stop all scheduled audio with smooth fade-out
   */
  reset(): void {
    // A seek or a new source means fresh audio is on its way, so the sound is
    // no longer over — see _streamEnded.
    this._streamEnded = false;
    // Whatever loop seam was armed belonged to the run being thrown away.
    this._pendingAnchor = null;
    this._loopArm = null;
    this._nextPassMaxMediaTime = 0;
    // Silence first, always — not only under stable audio.
    //
    // Stopping a source ends it mid-waveform, which is a click, and it does
    // nothing at all about audio that has already been RENDERED. WebAudio
    // hands the output device a stretch of finished samples ahead of time —
    // 600 to 770ms of it on the phone this was reported from — and no node
    // teardown can recall those. That is the sliver of the previous track
    // still playing after the source changes.
    //
    // A gain of zero cannot recall them either, but it applies to everything
    // not yet rendered, which is most of that stretch. Over a few
    // milliseconds rather than instantly, because a hard cut to zero is its
    // own click.
    if (this.audioContext && this.inputNode && this.activeSources.length > 0) {
      try {
        const now = this.audioContext.currentTime;
        // Stable audio was already doing this and getting the quiet handover
        // for free; everyone else got the tail and the click. The fade is
        // longer there because that path is also covering compressor release.
        const fade = this._stableAudio ? AudioRenderer.FADE_OUT_TIME : 0.008;
        // The fade down and the restore at the end of reset() are one
        // movement; keep the drift check off the input for the whole of it.
        this._gainHoldUntil = performance.now() + 1000;
        this.inputNode.gain.cancelScheduledValues(now);
        this.inputNode.gain.setValueAtTime(this.inputNode.gain.value, now);
        this.inputNode.gain.linearRampToValueAtTime(0, now + fade);
      } catch {
        // Ignore ramp errors
      }
    }

    // Waiting buffers belong to the stretch being thrown away. Left queued,
    // a seek would play the old position's audio a moment later.
    this._pending = [];
    this._pendingDuration = 0;
    this.stopDuckPolling();
    if (this._pumpTimer !== null) {
      clearInterval(this._pumpTimer);
      this._pumpTimer = null;
    }

    // Stop AFTER the fade above has had time to run, not before it.
    //
    // The ramp was being written and then made pointless in the same breath:
    // the sources were stopped immediately, so there was nothing left to fade
    // and the output ended on a cut — which is a click of its own. Handing the
    // stop to the ramp's own end time lets the last few milliseconds actually
    // fade, and costs nothing: a source told to stop at a time in the near
    // future stops itself, with no timer to keep alive.
    const stopAt =
      this.audioContext && this.gainNode && this.activeSources.length > 0
        ? this.audioContext.currentTime +
          (this._stableAudio ? AudioRenderer.FADE_OUT_TIME : 0.008)
        : 0;
    for (const source of this.activeSources) {
      try {
        if (stopAt > 0) source.stop(stopAt);
        else source.stop();
      } catch {
        // Ignore
      }
    }
    // Disconnect on their own ended event, so the fade is not cut short by
    // pulling the node out of the graph underneath it.
    this.activeSources = [];
    this.scheduledTime = this.audioContext?.currentTime ?? 0;

    // Drop the underrun duck. A seek/flush retires the stretch that caused it,
    // and unduckIfClean() only runs from the scheduling path — so leaving this
    // set would keep a freshly-seeked, perfectly healthy player silent.
    // The flag only. Putting the gain back to 1 HERE used to be the whole of
    // it, and that now lands between the fade-out above and the restore below
    // — cancelling the fade a seek needs. The restore at the end of this
    // function is the one place the input comes back, ducked or not.
    this._ducked = false;
    this._lastUnderrunAt = 0;

    // Reset clock tracking
    this.hasFirstBuffer = false;
    this.firstBufferScheduledAt = 0;
    this.soundRunStartedAt = 0;
    this.firstBufferMediaTime = 0;
    this.scheduledCount = 0;
    this.maxScheduledMediaTime = 0;

    // Reset starvation tracking
    this.isStarved = false;
    this.starvationStartTime = 0;

    // Clear stretcher state
    if (this.signalsmith) this.signalsmith.clear();

    // Bring the input back, on the same terms the fade went out on. Guarding
    // this on stable audio while the fade above is unconditional would leave
    // every other setup silent from the first seek onwards.
    if (this.inputNode && this.audioContext) {
      try {
        const param = this.inputNode.gain;
        const now = this.audioContext.currentTime;
        const fade = this._stableAudio ? AudioRenderer.FADE_OUT_TIME : 0.008;
        this._gainHoldUntil = performance.now() + 1000;
        // Anchored, and on a cleared timeline — not a bare ramp trusting
        // whatever came before it.
        //
        // A bare one is what shipped, and it left the input parked below 1
        // twice in one session (0.5292 and 0.0026, caught by the net). The
        // race: this ramp is scheduled, then an underrun during the same seek
        // fires duck(), which does cancelScheduledValues and takes the input
        // to zero — the restore is gone. The next seek then clears the duck
        // FLAG without putting the gain back and stops the duck's release
        // timer, so nothing is left that would ever raise it again.
        //
        // Cancelling first, anchoring at wherever the value actually is, and
        // ramping from there makes this the last word on the param whatever
        // happened before it, which is what a reset should be.
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(1, now + fade + 0.005);
      } catch {
        // Fallback: set directly
        this.inputNode.gain.value = 1;
      }
    }
  }

  /**
   * Get current audio context time
   */
  getCurrentTime(): number {
    // Use accurate audio clock during playback
    if (
      this.isPlaying &&
      this.audioContext &&
      this.audioContext.state === "running" &&
      this.hasFirstBuffer
    ) {
      this.adoptPendingAnchor();
      const elapsed =
        this.audioContext.currentTime - this.firstBufferScheduledAt;
      let computedTime =
        this.firstBufferMediaTime + Math.max(0, elapsed * this._playbackRate);

      const latency =
        (this.audioContext as any).outputLatency ||
        (this.audioContext as any).baseLatency ||
        0;
      if (latency > 0) {
        computedTime -= latency * this._playbackRate;
        // Prevent time from going below the first buffer time (Bluetooth high latency fix)
        computedTime = Math.max(computedTime, this.firstBufferMediaTime);
      }

      return computedTime;
    }
    return this.currentMediaTime;
  }

  /**
   * How long from now until the audio we have scheduled is actually HEARD —
   * i.e. how long getAudioClock() will keep returning firstBufferMediaTime
   * unchanged before it starts advancing. Zero once sound is playing out, and
   * on every device whose latency is small enough not to matter.
   *
   * Two separate delays stack up at the start of every playback run, and both
   * are deliberate:
   *
   *  - the first buffer is placed one output-latency ahead (`deviceLead`, see
   *    render()) so the scheduler has a window to queue the buffers behind it
   *    instead of handing a deep device a single buffer and starving it;
   *  - and what is scheduled at context time T is heard at T + outputLatency,
   *    which getAudioClock() subtracts so video syncs to what is HEARD.
   *
   * On a wired or built-in output that is ~5-25ms twice over and nobody can
   * tell. On Bluetooth it is ~305ms twice over: for the first ~600ms after a
   * seek there is no sound yet, and the audio clock is flat by construction.
   *
   * The video side has to know that, because its own clock is wall-clock based
   * and would otherwise start advancing immediately from an anchor taken off
   * that flat value — running ~600ms ahead of the sound, until the drift
   * correction notices and yanks the presentation anchor backwards, which is
   * seen as the picture freezing a moment after every seek. Bluetooth only,
   * because on anything else the number is too small to cross the threshold.
   */
  /**
   * What secondsUntilAudible() will report once the next run's first buffer is
   * scheduled — the deviceLead render() is about to apply, plus the latency it
   * will then take to be heard.
   *
   * Callers that have to decide whether to hold playback need the figure BEFORE
   * any buffer exists: right after a seek the flush has cleared hasFirstBuffer,
   * so secondsUntilAudible() honestly reports zero and would talk them out of a
   * wait that is coming regardless.
   */
  expectedStartLead(): number {
    if (!this.audioContext) return 0;
    const ctx = this.audioContext as AudioContext & {
      outputLatency?: number;
      baseLatency?: number;
    };
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    // Mirrors render()'s deviceLead, warm case included — this figure is what
    // the video side holds for, so a prediction bigger than the real delay is
    // a picture parked for nothing.
    const warmOutput = outputEverFed;
    return Math.min(warmOutput ? 0.12 : 0.5, latency) + latency;
  }

  /**
   * How long until sound is actually coming out — measured once there is a
   * buffer to measure, predicted before there is.
   *
   * The two halves answer the same question at different moments and must not
   * be mixed up: after a seek's flush there is no scheduled buffer, so the
   * measurement honestly reports zero, and a caller that acts on it starts the
   * picture with no lead at all. Past the first buffer the prediction is
   * stale — the live figure counts down to zero as the sound approaches, and
   * must be allowed to reach it, or the drift correction it gates never runs.
   */
  startLead(): number {
    if (!this.audioContext) return 0;
    return this.hasFirstBuffer
      ? this.secondsUntilAudible()
      : this.expectedStartLead();
  }

  secondsUntilAudible(): number {
    if (!this.audioContext || !this.hasFirstBuffer) return 0;
    if (this.audioContext.state !== "running") return 0;
    const ctx = this.audioContext as AudioContext & {
      outputLatency?: number;
      baseLatency?: number;
    };
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    return Math.max(
      0,
      this.soundRunStartedAt + latency - ctx.currentTime,
    );
  }

  /**
   * Can a speed change be carried on the audio this renderer already holds?
   *
   * setPlaybackRate() does not throw the scheduled audio away any more — it
   * stops the sources that have not begun and pushes their ORIGINAL buffers
   * back onto the pending queue to be re-stretched at the new tempo and
   * rescheduled behind whatever is playing. Nothing is skipped and no hole is
   * opened, so the media from the playhead forward is still in hand and the
   * source does not have to be re-read to get it back.
   *
   * This reports whether that reclaim is actually available: the branch's own
   * preconditions (a running context past its first buffer) plus a material
   * amount of audio to reclaim. Read it BEFORE setPlaybackRate() — afterwards
   * the sources have already been taken back into the queue.
   */
  canCarryRateChange(minSeconds = 0.3): boolean {
    if (!this.audioContext || this.audioContext.state !== "running") {
      return false;
    }
    if (!this.isPlaying || !this.hasFirstBuffer) return false;
    return this.getBufferedDuration() >= minSeconds;
  }

  /**
   * Get the audio clock - THE MASTER TIME SOURCE FOR A/V SYNC
   * Returns accurate time based on when audio actually started playing
   * Returns -1 if audio hasn't started yet
   * Clamps to maxScheduledMediaTime when audio has ended
   */

  /**
   * Take up an armed origin once the output has actually reached it. Called
   * from both clock readers rather than on a timer: the only moment that
   * matters is the one being asked about.
   */
  private adoptPendingAnchor(): void {
    const p = this._pendingAnchor;
    if (!p || !this.audioContext) return;
    if (this.audioContext.currentTime < p.atContextTime) return;
    this.firstBufferScheduledAt = p.atContextTime;
    this.firstBufferMediaTime = p.mediaOrigin;
    this._pendingAnchor = null;
    // The clamp's horizon now belongs to the pass being heard.
    this.maxScheduledMediaTime = this._nextPassMaxMediaTime;
    this._nextPassMaxMediaTime = 0;
    Logger.debug(
      TAG,
      `Loop seam reached — media clock now counts from ${p.mediaOrigin.toFixed(3)}s`,
    );
  }

  /**
   * The next pass of a looping file starts here.
   *
   * Everything about the sound carries on untouched — the scheduler keeps
   * placing buffers at `scheduledTime`, so the first sample of the new pass
   * abuts the last sample of the old one and there is no seam to hear. What
   * changes is only the BOOKKEEPING: the media time those samples are labelled
   * with wraps back to the start of the file, and the clock has to wrap with
   * them, but not until they are heard.
   *
   * Call BEFORE the new pass is read. Its first buffer is recognised by its
   * timestamp stepping back (see _loopArm) and the seam is armed when that
   * buffer is started.
   */
  beginLoopPass(): void {
    const last = this._pending[this._pending.length - 1];
    this._loopArm = {
      found: false,
      lastAudioTime: last ? last.audioTime : this.hasFirstBuffer ? this.currentMediaTime : -1,
    };
    this._pendingAnchor = null;
    this._nextPassMaxMediaTime = 0;
    // Fresh audio is on its way, so the sound is not over — the same reason
    // reset() clears this, without any of reset()'s teardown.
    this._streamEnded = false;
    Logger.debug(TAG, "Loop pass armed — waiting for its first buffer");
  }

  /**
   * True from beginLoopPass until the output has reached the new pass. The
   * player turns the picture over when this goes false, so both halves of the
   * loop share one boundary.
   */
  isLoopSeamPending(): boolean {
    this.adoptPendingAnchor();
    return this._loopArm !== null || this._pendingAnchor !== null;
  }

  /** Drop an armed loop seam that is not going to happen after all. */
  cancelLoopPass(): void {
    if (this._pendingAnchor || this._loopArm) {
      this._pendingAnchor = null;
      this._loopArm = null;
      for (const p of this._pending) p.loopStart = false;
      if (this._nextPassMaxMediaTime > this.maxScheduledMediaTime) {
        this.maxScheduledMediaTime = this._nextPassMaxMediaTime;
      }
      this._nextPassMaxMediaTime = 0;
      Logger.debug(TAG, "Loop pass cancelled");
    }
  }

  getAudioClock(): number {
    if (
      this.audioContext &&
      this.audioContext.state === "running" &&
      this.hasFirstBuffer
    ) {
      this.adoptPendingAnchor();
      const elapsed =
        this.audioContext.currentTime - this.firstBufferScheduledAt;
      let computedTime =
        this.firstBufferMediaTime + Math.max(0, elapsed * this._playbackRate);

      // Adjust for output latency if available (Critical for Android/Bluetooth sync)
      // outputLatency represents the delay between the audio hardware and the speakers
      // Subtracting this ensures the video syncs to what is actually HEARD, not just scheduled
      const latency =
        (this.audioContext as any).outputLatency ||
        (this.audioContext as any).baseLatency ||
        0;
      if (latency > 0) {
        computedTime -= latency * this._playbackRate;
        // Prevent audio clock from going below the first buffer time
        // This is critical for Bluetooth devices with high latency (100-300ms)
        // to prevent video stalling at playback start
        computedTime = Math.max(computedTime, this.firstBufferMediaTime);
      }

      // Clamp to the maximum scheduled media time to prevent clock runaway
      if (this.maxScheduledMediaTime > 0) {
        // …unless there is no more sound coming and the head has reached the
        // end of it. Then the clamp is not holding back a runaway, it is
        // holding back the picture — see _streamEnded.
        if (
          this._streamEnded &&
          computedTime >= this.maxScheduledMediaTime - 0.01
        ) {
          return -1;
        }
        return Math.min(computedTime, this.maxScheduledMediaTime);
      }
      return computedTime;
    }
    return -1;
  }

  /**
   * True when an AudioContext exists but the browser is keeping it suspended
   * despite us asking to play unmuted — i.e. autoplay-with-sound was blocked
   * because no user gesture has unlocked audio yet. resume() resolves without
   * throwing in this case (Chromium silently leaves the context suspended),
   * so callers can't detect the block from play()'s promise; they poll this
   * instead. Returns false when muted (we intentionally don't resume) or when
   * the context is genuinely running.
   */
  isBlockedSuspended(): boolean {
    return (
      !!this.audioContext &&
      this.audioContext.state === "suspended" &&
      !this._muted &&
      !contextSuspendIntent
    );
  }

  /**
   * True once the shared AudioContext has run (been unlocked by a gesture) at
   * any point this session — see the module-level sharedContextActivated latch.
   * After that, a gesture-free resume() will succeed on its own, so a suspended
   * state seen right after init() is just the async resume still in flight and
   * WILL recover. Callers use this to wait it out instead of falling back to
   * muted autoplay (which would flash the "tap to unmute" pill on every
   * auto-advanced track).
   */
  wasEverActivated(): boolean {
    return sharedContextActivated;
  }

  /**
   * Check if audio has healthy buffers (not in underrun state)
   * Used by video renderer to decide whether to sync to audio
   */
  hasHealthyBuffer(): boolean {
    if (!this.audioContext || !this.hasFirstBuffer) return false;

    // Context must be running
    if (this.audioContext.state !== "running") return false;

    // Stable audio: if starved, buffer is not healthy
    if (this._stableAudio && this.isStarved) return false;

    // Compute buffer ahead time
    const realBufferAhead = this.scheduledTime - this.audioContext.currentTime;

    // Check if decoder has stopped outputting — but only when the scheduled
    // buffer is genuinely thin. The demux loop refills audio in BURSTS: it
    // fills to maxAudioBuffered, then backpressure parks the loop for a second
    // or more before the next burst. So a >500ms decode gap while seconds of
    // audio are still scheduled is the normal steady state, not a stall — and
    // reading it as "unhealthy" made this flicker false for roughly half of
    // every burst cycle. Callers that ask an instantaneous question (the
    // rate-change corrective-seek guard, the clock's audio-drift sync) then
    // saw a healthy pipeline as broken: a rate change landing in a quiet
    // window took the full flush + decoder-recreate seek path and froze the
    // picture for over a second. With a real cushion ahead, audio can keep
    // anchoring regardless of when the last chunk decoded.
    const timeSinceLastDecode = performance.now() - this.lastDecodeTime;
    if (
      this.lastDecodeTime > 0 &&
      timeSinceLastDecode > 500 &&
      realBufferAhead < 0.5
    ) {
      return false;
    }
    const hasScheduledAudio =
      this.activeSources.length > 0 || realBufferAhead > 0;

    // For initial sync stability (especially with Bluetooth), require more buffer
    // First few chunks need larger buffer to ensure stable clock
    const minBufferThreshold = this.scheduledCount < 5 ? 0.1 : 0.02;

    return hasScheduledAudio && realBufferAhead > minBufferThreshold;
  }

  /**
   * Check if audio is actively playing
   */
  isAudioPlaying(): boolean {
    return (
      this.isPlaying &&
      this.audioContext?.state === "running" &&
      this.hasFirstBuffer
    );
  }

  /**
   * Get filtered buffered duration (seconds ahead of current time)
   */
  /**
   * True when audio frames are being thrown away rather than scheduled: muted
   * with a context the browser won't let us start (the autoplay-blocked state,
   * before any gesture). Only then is audio genuinely absent from the pipeline
   * — a muted context that IS running still schedules everything, at gain 0,
   * and still drives the clock.
   *
   * An intentional suspend (a prime / buffering hold) is explicitly NOT this
   * state: we suspended the context ourselves precisely so decoded audio
   * accumulates against a frozen clock, and it resumes on our own call.
   */
  isDroppingAudio(): boolean {
    return (
      this._muted &&
      !contextSuspendIntent &&
      this.audioContext?.state === "suspended"
    );
  }

  getBufferedDuration(): number {
    if (!this.audioContext) return 0;
    // Scheduled AND waiting. The player gates decode on this, and audio held
    // back by the lookahead is every bit as decoded as audio already handed to
    // the graph — leaving it out would make the pipeline think it was starving
    // and race ahead.
    return (
      Math.max(0, this.scheduledTime - this.audioContext.currentTime) +
      this._pendingDuration
    );
  }

  /**
   * True if we patched a hole with silence within `withinMs`. A run of these
   * means the decode pipeline has fallen behind realtime — the audio the user
   * hears is already broken, so the player surfaces its buffering state rather
   * than claiming to play. High packet-rate codecs (TrueHD/MLP/DTS) are what
   * hit this: they read far more often than AAC, so anything that adds latency
   * per read shows up here first — the same file decodes clean from a local
   * file and stutters over HTTP.
   */
  isUnderrunning(withinMs: number = 500): boolean {
    return (
      this._lastUnderrunAt > 0 &&
      performance.now() - this._lastUnderrunAt < withinMs
    );
  }

  /**
   * Fade the input out to cover a run of underruns.
   * Rides on inputNode, never gainNode: gainNode carries the user's volume and
   * boost, and stomping it here would fight setVolume() and leave the ducked
   * level behind as the user's own setting.
   */
  /**
   * Suppress ducking for the next `ms` and release any current duck. Called by
   * the player around a background→foreground recovery, whose decoder flush +
   * re-seek briefly starves audio — a transient underrun that must not mute.
   */
  suppressDuckFor(ms: number): void {
    this._suppressDuckUntil = performance.now() + ms;
    this.forceUnduck();
  }

  /** Immediately restore the input gain and clear the duck (no fade). */
  private forceUnduck(): void {
    this.stopDuckPolling();
    if (!this._ducked || !this.inputNode || !this.audioContext) return;
    this._ducked = false;
    try {
      const param = this.inputNode.gain;
      const now = this.audioContext.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(1, now);
    } catch {
      // Ignore ramp errors
    }
  }

  /**
   * Put silence across a gap in the schedule, so the seam is joined rather
   * than torn.
   *
   * WebAudio does not play "nothing" between two buffer sources — it plays
   * whatever the graph last had, then the next buffer starts abruptly. That
   * step is the click. A silent buffer laid over the gap gives the output
   * something continuous to run through, which is what the underrun path has
   * always done; these two callers are the seams that were missing it.
   *
   * Logged, because a click that leaves no trace is a bug nobody can find
   * twice: the reason mobile-only clicking survived several rounds of looking
   * is that neither of these paths said anything at all.
   */
  private fillSeam(
    at: number,
    duration: number,
    channels: number,
    sampleRate: number,
    reason: string,
  ): void {
    const target = this.inputNode ?? this.gainNode;
    if (!this.audioContext || !target || duration <= 0 || duration > 1) return;
    try {
      const frames = Math.ceil(duration * sampleRate);
      const buffer = this.audioContext.createBuffer(channels, frames, sampleRate);
      const filler = this.audioContext.createBufferSource();
      filler.buffer = buffer;
      filler.connect(target);
      filler.start(at);
      filler.onended = () => {
        try { filler.disconnect(); } catch { /* ignore */ }
      };
      Logger.debug(
        TAG,
        `Seam filled: ${(duration * 1000).toFixed(1)}ms (${reason})`,
      );
    } catch {
      // A seam we could not fill is the old behaviour, not a new failure.
    }
  }

  /** Throttle for the once-a-second output line above. */
  private _lastHealthLogAt = 0;

  /** Decoded audio waiting for its turn to become a node — see
   *  scheduleAudioBuffer. Plain data; costs nothing until committed. */
  private _pending: Array<{
    buffer: AudioBuffer;
    audioTime: number;
    /** First buffer of the next loop pass — see _loopArm. */
    loopStart?: boolean;
  }> = [];
  private _pendingDuration = 0;
  private _pumpTimer: number | null = null;
  /** How far ahead of the output a buffer may be turned into a node. Wide
   *  enough that jank cannot starve the graph, narrow enough that the node
   *  count stays in the dozens rather than the hundreds. */
  private static readonly SCHEDULE_LOOKAHEAD = 1.0;
  /** How often the queue drains itself while no audio is arriving. */
  private static readonly PUMP_INTERVAL_MS = 50;
  /**
   * How long after audio starts flowing the stretcher is built.
   *
   * Long enough to stay off the opening of a video, where the decode, the fetch
   * and the first frames are already competing; far shorter than it takes
   * anyone to open the speed menu.
   */
  private static readonly STRETCHER_WARM_DELAY_MS = 1500;

  private duckForUnderrun(): void {
    // Suppressed right after a foreground recovery: the recovery's own
    // decoder flush/seek causes a one-off underrun that must not mute audio.
    if (performance.now() < this._suppressDuckUntil) {
      this.forceUnduck();
      return;
    }
    // Never duck in the background. The duck exists to mute glitchy audio while
    // a spinner shows — but there's no spinner when hidden, and the decode loop
    // is throttled there so underruns are constant. Muting on them would
    // silence background audio playback entirely (music stops the moment the
    // tab hides). If we were already ducked when the tab hid, release it so the
    // audio isn't left muted.
    if (typeof document !== "undefined" && document.hidden) {
      this.forceUnduck();
      return;
    }
    if (this._ducked || !this.inputNode || !this.audioContext) return;
    this._ducked = true;
    // Its own way back up.
    //
    // The release used to ride on the next committed buffer, and a buffer is
    // committed only when one ARRIVES — so on a link that stalls, the duck
    // engaged on the underrun at the resume and then sat there for the whole
    // play stretch, because the cushion it resumed with was already scheduled
    // and nothing new needed committing before the next stall. Measured on a
    // 1.4GB file over a throttled link: state "playing", the clock running
    // 79.86s to 82.19s, and the input gain flat at 0 the entire time. Video
    // playing to no sound, which is the report.
    //
    // The duck is about the audio being broken, so its end is a question of
    // time, not of traffic: check on a timer and lift as soon as no underrun
    // has landed for DUCK_CLEAR_MS.
    if (this._duckReleaseTimer === null) {
      this._duckReleaseTimer = setInterval(
        () => this.unduckIfClean(),
        AudioRenderer.DUCK_POLL_MS,
      ) as unknown as number;
    }
    try {
      const param = this.inputNode.gain;
      const now = this.audioContext.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + AudioRenderer.DUCK_FADE_OUT);
      Logger.debug(TAG, `Duck: engaged (underrun)`);
    } catch {
      // Ignore ramp errors
    }
  }

  /**
   * Fade back in, but only once no underrun has landed for DUCK_CLEAR_MS.
   * Called on every scheduled buffer, so recovery needs no external signal.
   */
  /**
   * Hold the output silent WITHOUT touching the mute flag.
   *
   * Tap-to-unmute has to resume the AudioContext inside the tap — the browser
   * won't allow it a task later — but the audio that resume makes audible is
   * whatever the decoder holds, which is not where the picture is. So the
   * viewer heard a second of the wrong moment, then a seek, then the right one.
   * Resuming stays on the tap; this keeps it inaudible until the re-read lands.
   *
   * Same gain node the underrun duck uses, its own flag, and the duck can't
   * lift it — see unduckIfClean.
   */
  silenceForResync(): void {
    if (this._resyncSilenced || !this.inputNode || !this.audioContext) return;
    this._resyncSilenced = true;
    try {
      const param = this.inputNode.gain;
      const now = this.audioContext.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + AudioRenderer.DUCK_FADE_OUT);
      Logger.debug(TAG, "Silenced for resync");
    } catch {
      /* ignore ramp errors */
    }
  }

  private stopDuckPolling(): void {
    if (this._duckReleaseTimer !== null) {
      clearInterval(this._duckReleaseTimer);
      this._duckReleaseTimer = null;
    }
  }

  /** Fade back in once the re-read has landed. Safe to call unconditionally. */
  releaseResyncSilence(): void {
    if (!this._resyncSilenced) return;
    this._resyncSilenced = false;
    // An underrun duck may legitimately be holding the output down as well;
    // leave that one alone and let its own recovery release it.
    if (this._ducked || !this.inputNode || !this.audioContext) return;
    try {
      const param = this.inputNode.gain;
      const now = this.audioContext.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(1, now + AudioRenderer.DUCK_FADE_IN);
      Logger.debug(TAG, "Resync silence released");
    } catch {
      /* ignore ramp errors */
    }
  }

  private unduckIfClean(): void {
    // The resync hold outranks the duck: letting this ramp back to 1 would
    // make the pre-seek audio audible, which is the whole thing being avoided.
    if (this._resyncSilenced) return;
    if (!this._ducked || !this.inputNode || !this.audioContext) return;
    if (this.isUnderrunning(AudioRenderer.DUCK_CLEAR_MS)) return;
    this._ducked = false;
    this.stopDuckPolling();
    try {
      const param = this.inputNode.gain;
      const now = this.audioContext.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(1, now + AudioRenderer.DUCK_FADE_IN);
      Logger.debug(TAG, `Duck: released (clean)`);
    } catch {
      // Ignore ramp errors
    }
  }

  /**
   * Get the furthest media time (seconds) already scheduled in Web Audio.
   */
  getMaxScheduledMediaTime(): number {
    return this.maxScheduledMediaTime;
  }

  // ─── Stable Audio Methods ────────────────────────────────────────────

  /**
   * (Re)connect the audio graph for the current stable-audio state.
   *   stable ON : sources → input → compressor → gain(makeup) → destination
   *   stable OFF: sources → input → gain(volume)  → destination
   *
   * The volume/makeup gainNode is ALWAYS the final node before destination, so
   * a >100% boost is applied *after* the limiter instead of being cancelled by
   * it. Measured: with the old gain-before-limiter order, 100%→200% yielded
   * only ~+0.6dB; with gain after the limiter it's the full ~+6dB. Because the
   * limiter has already tamed peaks to ≈-15dBFS, a 2× makeup still lands well
   * under 0dBFS, so it does not re-introduce clipping.
   */
  private wireGraph(): void {
    if (
      !this.audioContext ||
      !this.inputNode ||
      !this.gainNode ||
      !this.compressorNode
    )
      return;
    try {
      // Bare disconnect() is a safe no-op when nothing is connected yet.
      this.inputNode.disconnect();
      this.compressorNode.disconnect();
      this.gainNode.disconnect();
      if (this._stableAudio) {
        this.inputNode.connect(this.compressorNode);
        this.compressorNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
      } else {
        this.inputNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
      }
    } catch {
      Logger.warn(TAG, "Failed to (re)wire audio chain");
    }
  }

  /**
   * The sound as levels, for drawing.
   *
   * `bars` bands from the spectrum, each 0..1, weighted so the low end does
   * not swamp everything (music has most of its energy there and a plain
   * average leaves every bar but the first two flat). Returns null when there
   * is nothing to read — no context, no sound running — and the caller can
   * draw its resting state.
   */
  getLevels(bars: number): Float32Array | null {
    const ctx = this.audioContext;
    if (!ctx || ctx.state !== "running" || !this.gainNode || bars <= 0) {
      return null;
    }
    if (!this._analyser) {
      try {
        this._analyser = ctx.createAnalyser();
        this._analyser.fftSize = 512;
        this._analyser.smoothingTimeConstant = 0.72;
        // In parallel with the output, not in series: an analyser passes audio
        // through, but hanging it off the gain node keeps the path to the
        // speakers exactly as it was.
        this.gainNode.connect(this._analyser);
        this._analyserBins = new Uint8Array(
          new ArrayBuffer(this._analyser.frequencyBinCount),
        );
      } catch {
        this._analyser = null;
        return null;
      }
    }
    const analyser = this._analyser;
    const bins = this._analyserBins;
    if (!analyser || !bins) return null;
    analyser.getByteFrequencyData(bins);
    const out = new Float32Array(bars);
    // Logarithmic bands: the ear hears pitch that way, and it spreads a song
    // across the whole row instead of the first handful of bars.
    const top = Math.floor(bins.length * 0.72); // above this is mostly hiss
    for (let i = 0; i < bars; i++) {
      const from = Math.floor(Math.pow(i / bars, 1.7) * top);
      const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * top));
      let sum = 0;
      for (let b = from; b < to && b < bins.length; b++) sum += bins[b];
      const avg = sum / Math.max(1, to - from) / 255;
      // Lift the top end, which is quieter in almost every recording — gently.
      // At 1.6 most of the row pinned at 1.0 on anything loud, and a meter
      // where every band reads full is a straight line, not a meter.
      out[i] = Math.min(1, avg * (1 + (i / bars) * 0.8));
    }
    return out;
  }

  /**
   * Enable/disable stable audio mode (dynamic range compression / loudness normalization)
   */
  setStableAudio(enabled: boolean): void {
    // Rewiring is not free: it disconnects a node that ~40 live sources are
    // feeding and reconnects it, and the break between the two is a hole in
    // the output. Doing that for a state we are already in is a click for
    // nothing — and the logs show every toggle arriving TWICE (the property
    // and the attribute reflecting back onto each other), so each flip cost
    // two of them.
    if (this._wiredStableAudio === enabled) return;
    this._wiredStableAudio = enabled;
    this._stableAudio = enabled;
    Logger.info(TAG, `Stable audio: ${enabled ? "enabled" : "disabled"}`);

    // Rewire for the new state (live sources stay attached to inputNode).
    this.wireGraph();
    Logger.debug(TAG, `Audio chain rewired: compressor ${enabled ? "active" : "bypassed"}`);

    if (enabled && this.audioContext) {
      this.setupContextStateMonitoring();
    } else if (!enabled && this.audioContext && this.contextStateHandler) {
      this.audioContext.removeEventListener("statechange", this.contextStateHandler);
      this.contextStateHandler = null;
    }
  }

  /**
   * Get stable audio mode state
   */
  getStableAudio(): boolean {
    return this._stableAudio;
  }

  /**
   * Smoothly ramp gain to target value to prevent clicks/pops
   */
  /**
   * Convert a linear slider value (0-1) to a perceptual gain value.
   *
   * Human loudness perception is logarithmic, so a linear gain feels like
   * "almost everything happens in the first 10%" and the top 90% feels flat.
   * We map the slider through an exponential (dB-based) curve so that equal
   * slider movement produces a roughly equal perceived loudness change across
   * the whole range. 0 -> silence, 1 -> unity gain.
   */
  private perceptualGain(v: number): number {
    if (v <= 0) return 0;
    // Above 100% we boost LINEARLY (VLC-style, up to 200% = 2x gain). Unity at
    // v=1. Loud content near 0 dBFS can clip when boosted — enabling stable
    // audio inserts the limiter that tames it.
    if (v >= 1) return v;
    // ~60 dB usable range: gain = (e^(k*v) - 1) / (e^k - 1), k tuned for feel.
    const k = 6.908; // ln(1000) -> ~60 dB dynamic range
    return (Math.exp(k * v) - 1) / (Math.exp(k) - 1);
  }

  /**
   * Put the master gain back if it has been wrong for long enough that
   * nothing legitimate can explain it.
   *
   * While playing, unmuted and unducked, the gain IS perceptualGain(volume).
   * It was found parked at 0.001 against a target of 0.436 and still there
   * twelve seconds later — the "it went quiet after a seek" report — with no
   * way back for the viewer except reloading. The cause of that is still
   * open; this does not need it.
   *
   * What it does need is to never fight. Every deliberate move of this param
   * — a seek's fade down and back, a volume change, a mute — is short, and
   * while one is in flight the level is MEANT to be somewhere other than the
   * target. Correcting it there is the fault this net was supposed to prevent,
   * turned upside down: the first version of it hauled the gain up mid-fade
   * and made a seek pump audibly. So it stands down for the length of any ramp
   * we asked for, forgets what it saw while standing down, waits for three
   * consecutive seconds of a wrong level, and then moves slowly enough that
   * being wrong about it is inaudible.
   */
  private policeMasterGain(): void {
    if (
      !this.gainNode ||
      !this.audioContext ||
      !this.isPlaying ||
      this._muted ||
      this._ducked ||
      this.audioContext.state !== "running"
    ) {
      return;
    }
    // A ramp of ours owns the gain — and a strike counted before it started
    // describes a level that no longer exists, so that goes too.
    if (performance.now() < this._gainHoldUntil) {
      this._gainDriftStrikes = 0;
      return;
    }
    // Two params can silence the output and only one of them is the viewer's.
    // The volume node is written by setVolume and setMuted and nothing else
    // now; the input node carries the transients — the duck, and the fade a
    // seek makes. Either being wrong for long enough is the same fault.
    const want = this.perceptualGain(this.volume);
    const have = this.gainNode.gain.value;
    const inputWrong =
      !!this.inputNode && Math.abs(this.inputNode.gain.value - 1) > 0.05;
    if (
      Math.abs(have - want) <= Math.max(0.01, want * 0.05) &&
      !inputWrong
    ) {
      this._gainDriftStrikes = 0;
      return;
    }
    // This net is for a level that is STUCK, and stuck levels stay stuck.
    if (++this._gainDriftStrikes < 3) return;
    this._gainDriftStrikes = 0;
    Logger.warn(
      TAG,
      `Audio stuck quiet — volume ${have.toFixed(4)} of ${want.toFixed(4)}` +
        (inputWrong ? `, input ${this.inputNode!.gain.value.toFixed(4)} of 1` : "") +
        " — restoring",
    );
    try {
      const now = this.audioContext.currentTime;
      this._gainHoldUntil =
        performance.now() + AudioRenderer.GAIN_RESTORE_TIME * 1000 + 100;
      if (inputWrong && this.inputNode) {
        this.inputNode.gain.cancelScheduledValues(now);
        this.inputNode.gain.setValueAtTime(this.inputNode.gain.value, now);
        this.inputNode.gain.linearRampToValueAtTime(
          1,
          now + AudioRenderer.GAIN_RESTORE_TIME,
        );
      }
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(have, now);
      this.gainNode.gain.linearRampToValueAtTime(
        want,
        now + AudioRenderer.GAIN_RESTORE_TIME,
      );
    } catch {
      this.gainNode.gain.value = want;
      if (this.inputNode) this.inputNode.gain.value = 1;
    }
  }

  /**
   * Take the sound down a slope and leave it there.
   *
   * For a player that is going away — the desktop window closing, a page
   * unloading — where the alternative is the sound stopping dead on whatever
   * sample it was on. That cliff is what makes closing an app feel like
   * pulling a plug out; a fifth of a second of slope is all it takes to feel
   * like a door closing instead.
   *
   * Nothing raises it again on the way down: the drift net restores a gain
   * that is wrong, and this one is wrong on purpose. There is no fade back —
   * whatever asked for this is not expecting to play again.
   */
  fadeOut(durationMs: number = 200): void {
    if (!this.gainNode || !this.audioContext) return;
    this._fadingOut = true;
    const seconds = Math.max(0.02, durationMs / 1000);
    this._gainHoldUntil = performance.now() + durationMs + 2000;
    try {
      const now = this.audioContext.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0, now + seconds);
    } catch {
      this.gainNode.gain.value = 0;
    }
    Logger.debug(TAG, `Fading out over ${durationMs}ms`);
  }

  /** Set once fadeOut has run: the level is on its way to zero and stays there. */
  private _fadingOut: boolean = false;

  private rampGain(targetValue: number): void {
    if (!this.gainNode || !this.audioContext || this._fadingOut) {
      return;
    }
    try {
      const now = this.audioContext.currentTime;
      this._gainHoldUntil =
        performance.now() + AudioRenderer.GAIN_RAMP_TIME * 1000 + 50;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(
        targetValue,
        now + AudioRenderer.GAIN_RAMP_TIME
      );
    } catch {
      // Fallback: set directly if ramping fails
      this.gainNode.gain.value = targetValue;
    }
  }

  /**
   * Monitor AudioContext state changes and auto-recover from interruptions
   * Handles cases like: phone calls, other audio sources, OS-level interruptions
   */
  private setupContextStateMonitoring(): void {
    if (!this.audioContext) return;

    // Remove old handler if any
    if (this.contextStateHandler) {
      this.audioContext.removeEventListener("statechange", this.contextStateHandler);
    }

    this.contextStateHandler = () => {
      if (!this.audioContext) return;
      const state = this.audioContext.state;

      if (state === "interrupted" || (state === "suspended" && this.isPlaying && !this._muted && !contextSuspendIntent)) {
        Logger.warn(TAG, `AudioContext ${state} unexpectedly during playback, attempting recovery`);
        this.attemptContextRecovery();
      } else if (state === "running") {
        // Successfully recovered
        this.recoveryAttempts = 0;
        // The context reaching "running" — via play(), the tap-to-unmute
        // resume(), a recovery, anything — means audio is unlocked this session.
        // Latch it so an auto-advanced / switched video's init() can wake the
        // (pause-suspended) shared context without a fresh gesture. Previously
        // only play() set this, so a first unlock via tap-to-unmute left it
        // false and the NEXT video re-showed "tap to unmute".
        sharedContextActivated = true;
        Logger.debug(TAG, "AudioContext recovered to running state");
        // Audio frames that arrived while the context was suspended were
        // dropped, so the clock mapping (first-buffer anchor + the
        // max-scheduled clamp) describes a moment that never played. Left
        // alone, getAudioClock() then reports a time pinned near where the
        // drop began — and since video presentation follows the audio clock,
        // the picture freezes on its first frame. That is the black start on
        // a muted autoplay: unmuting and seeking rebuilt the mapping, which
        // is why it "fixed itself".
        //
        // Drop the anchor instead: the next buffer scheduled after recovery
        // re-establishes it, and until then getAudioClock() returns -1 and the
        // wall clock drives the video.
        if (this.droppedWhileSuspended) {
          this.droppedWhileSuspended = false;
          this.hasFirstBuffer = false;
          this.firstBufferScheduledAt = 0;
          this.firstBufferMediaTime = 0;
          this.maxScheduledMediaTime = 0;
          Logger.debug(TAG, "Audio clock anchor reset after suspended drop");
        }
      }
    };

    this.audioContext.addEventListener("statechange", this.contextStateHandler);
  }

  /**
   * Attempt to recover AudioContext from interrupted/suspended state
   */
  private attemptContextRecovery(): void {
    if (!this.audioContext || !this.isPlaying) return;
    if (this.recoveryAttempts >= AudioRenderer.MAX_RECOVERY_ATTEMPTS) {
      Logger.error(TAG, `AudioContext recovery failed after ${AudioRenderer.MAX_RECOVERY_ATTEMPTS} attempts`);
      this.recoveryAttempts = 0;
      return;
    }

    this.recoveryAttempts++;
    Logger.debug(TAG, `AudioContext recovery attempt ${this.recoveryAttempts}/${AudioRenderer.MAX_RECOVERY_ATTEMPTS}`);

    this.audioContext.resume().then(() => {
      if (this.audioContext?.state === "running") {
        Logger.info(TAG, "AudioContext recovered successfully");
        this.recoveryAttempts = 0;
      }
    }).catch((err) => {
      Logger.warn(TAG, "AudioContext recovery failed", err);
      // Retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, this.recoveryAttempts - 1), 5000);
      setTimeout(() => this.attemptContextRecovery(), delay);
    });
  }

  /**
   * Check if audio is in starvation state (no new data for extended period)
   * Used by Clock/MoviPlayer to decide whether audio clock is reliable
   */
  isAudioStarved(): boolean {
    if (!this.isPlaying || !this.hasFirstBuffer) return false;

    // Only starve if buffer is actually empty (not just no new decodes)
    const bufferAhead = this.getBufferedDuration();
    if (bufferAhead > 0.1) return false; // Still have audio buffered, not starved

    const timeSinceLastDecode = performance.now() - this.lastDecodeTime;
    if (this.lastDecodeTime > 0 && timeSinceLastDecode > AudioRenderer.STARVATION_THRESHOLD) {
      if (!this.isStarved) {
        this.isStarved = true;
        this.starvationStartTime = performance.now();
        Logger.warn(TAG, `Audio starvation detected: ${timeSinceLastDecode.toFixed(0)}ms since last decode`);
      }
      return true;
    }

    return false;
  }

  /**
   * Get duration of current starvation period in ms (0 if not starved)
   */
  getStarvationDuration(): number {
    if (!this.isStarved || this.starvationStartTime === 0) return 0;
    return performance.now() - this.starvationStartTime;
  }

  /**
   * Destroy renderer
   */
  async destroy(): Promise<void> {
    this.isPlaying = false;
    this.reset();

    // reset() ends by ramping the gain back up, which is right for a seek —
    // it is the same renderer and it is about to play again — and wrong here.
    // This renderer is going away, and the ramp was undoing its own fade about
    // 13ms in: the fade started, the restore cancelled it, and the audio still
    // in flight left at full level. That is the sliver of the previous track
    // heard after a source change. Hold it down instead.
    if (this.audioContext && this.gainNode) {
      try {
        const now = this.audioContext.currentTime;
        const fade = this._stableAudio ? AudioRenderer.FADE_OUT_TIME : 0.008;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(0, now + fade);
      } catch {
        /* a context that will not take a ramp is already past caring */
      }
    }

    // Tear down BT keepalive
    this.stopKeepalive();
    if (this.keepaliveEl) {
      try {
        this.keepaliveEl.src = "";
      } catch {
        /* noop */
      }
      this.keepaliveEl = null;
    }
    if (this.keepaliveUrl) {
      URL.revokeObjectURL(this.keepaliveUrl);
      this.keepaliveUrl = null;
    }

    // Clean up context state monitoring
    if (this.audioContext && this.contextStateHandler) {
      this.audioContext.removeEventListener("statechange", this.contextStateHandler);
      this.contextStateHandler = null;
    }
    // The activation latch comes off too — the context is shared and outlives
    // this renderer, so a listener left behind would accumulate one per source.
    if (this.audioContext && this.contextActivationHandler) {
      this.audioContext.removeEventListener(
        "statechange",
        this.contextActivationHandler,
      );
      this.contextActivationHandler = null;
    }

    // The AudioContext is shared session-wide (see sharedAudioContext) and is
    // NOT closed here. Only this instance's nodes come off it; the singleton
    // outlives the renderer for the next source to inherit.
    //
    // Retiring it was tried, to cut the stretch of the previous track that the
    // output device has already been handed and that no gain, stop or
    // disconnect can recall. It works — a closed context's queue goes with it —
    // and it costs the one thing the sharing exists for: a fresh context is
    // suspended, and waking it is what re-triggers the autoplay block and puts
    // the "tap to unmute" pill back on every switch. Sound that starts is worth
    // more than a tail that ends, so the context stays.
    //
    // What silences this renderer is the fade held down above plus the sources
    // reset() stopped — everything still IN the graph. A host that wants the
    // device queue gone as well has the blunt instrument available to it:
    // clearing the source tears the whole player down at the moment of the
    // decision, rather than a second later.

    // …after the fade reset() started has had time to run. Disconnecting these
    // synchronously pulled the graph out from under it: the ramp was written
    // and discarded in the same turn, and what was already in flight left at
    // full level. The nodes cost nothing while they wait, and the reference is
    // dropped here either way so nothing new can reach them.
    const doomed = [this.inputNode, this.compressorNode, this.gainNode];
    const linger = (this._stableAudio ? AudioRenderer.FADE_OUT_TIME : 0.008) * 1000 + 20;
    setTimeout(() => {
      for (const node of doomed) {
        try {
          node?.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    }, linger);
    this.audioContext = null;

    this.inputNode = null;
    this.gainNode = null;
    this.compressorNode = null;
    if (this.stretcherWarmTimer !== null) {
      clearTimeout(this.stretcherWarmTimer);
      this.stretcherWarmTimer = null;
    }
    if (this.signalsmith) {
      this.signalsmith.destroy();
      this.signalsmith = null;
    }
    this.recoveryAttempts = 0;
    Logger.debug(TAG, "Destroyed");
  }
}
