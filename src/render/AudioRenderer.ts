/**
 * AudioRenderer - Web Audio API based audio playback with precise clock synchronization
 * Uses AudioContext as the master clock for A/V sync (60Hz smooth playback)
 */

import { Logger } from "../utils/Logger";
import { SoundTouch } from "../utils/soundtouch";

const TAG = "AudioRenderer";

export class AudioRenderer {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private scheduledTime: number = 0;
  private isPlaying: boolean = false;
  private volume: number = 1.0;
  private _playbackRate: number = 1.0;
  private activeSources: AudioBufferSourceNode[] = [];
  private _muted: boolean = false;

  // Audio clock tracking for A/V sync
  private firstBufferScheduledAt: number = 0;
  private firstBufferMediaTime: number = 0;
  private hasFirstBuffer: boolean = false;
  private currentMediaTime: number = 0;
  private maxScheduledMediaTime: number = 0; // Track the furthest media time we've scheduled

  // Buffer health monitoring
  private lastDecodeTime: number = 0;
  private scheduledCount: number = 0;

  // Playback rate change rebuffering flag
  private isRebufferingForRateChange: boolean = false;

  // Pitch preservation
  private preservePitch: boolean = true;
  private soundTouch: SoundTouch | null = null;

  // Stable audio: master toggle (off by default, opt-in via element attribute)
  private _stableAudio: boolean = false;

  // Stable audio: gain ramp duration for smooth transitions (prevents clicks/pops)
  private static readonly GAIN_RAMP_TIME = 0.015; // 15ms ramp
  private static readonly FADE_OUT_TIME = 0.03; // 30ms fade-out before seek/reset

  // Stable audio: AudioContext state monitoring & auto-recovery
  private contextStateHandler: (() => void) | null = null;
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
      // 0.5s of 8kHz mono 8-bit silence (4044 bytes including 44-byte WAV header)
      const sampleRate = 8000;
      const numSamples = sampleRate / 2;
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
      this.audioContext = new AudioContext({
        latencyHint: "playback",
      });
      this.gainNode = this.audioContext.createGain();

      // Create compressor for stable audio (loudness normalization)
      this.compressorNode = this.audioContext.createDynamicsCompressor();
      // YouTube-like stable volume settings:
      // Compress loud parts (explosions, music) while keeping dialogue clear
      this.compressorNode.threshold.value = -24;  // Start compressing above -24dB
      this.compressorNode.knee.value = 30;         // Smooth transition into compression
      this.compressorNode.ratio.value = 12;        // 12:1 compression ratio
      this.compressorNode.attack.value = 0.003;    // Fast attack (3ms) to catch sudden loud sounds
      this.compressorNode.release.value = 0.25;    // Smooth release (250ms)

      // Wire audio chain based on stable audio state
      if (this._stableAudio) {
        // source -> compressor -> gain -> destination
        this.gainNode.connect(this.compressorNode);
        this.compressorNode.connect(this.audioContext.destination);
      } else {
        // source -> gain -> destination
        this.gainNode.connect(this.audioContext.destination);
      }

      // Apply muted state if set before initialization
      this.gainNode.gain.value = this._muted ? 0 : this.volume;

      // Don't resume here — play() handles resume when user clicks play.
      // Pre-init creates AudioContext during load for fast startup;
      // resuming here would cause poster-seek audio to leak.

      // Stable audio: monitor AudioContext state for auto-recovery
      if (this._stableAudio) {
        this.setupContextStateMonitoring();
      }

      Logger.info(
        TAG,
        `Initialized: sampleRate=${this.audioContext.sampleRate}, muted=${this._muted}, state=${this.audioContext.state}`,
      );
      return true;
    } catch (error) {
      Logger.error(TAG, "Failed to initialize", error);
      return false;
    }
  }

  /**
   * Configure audio format (logs only, format is taken from AudioData)
   */
  configure(sampleRate: number, channels: number): void {
    Logger.info(TAG, `Configured: ${sampleRate}Hz, ${channels}ch`);
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
    // Audio will start playing once user unmutes (which resumes the context)
    if (this._muted && this.audioContext.state === "suspended") {
      audioData.close();
      return;
    }

    // Track when we receive decoded audio
    this.lastDecodeTime = performance.now();

    // Stable audio: recover from starvation state
    if (this._stableAudio && this.isStarved) {
      this.isStarved = false;
      this.starvationStartTime = 0;
      Logger.debug(TAG, "Recovered from audio starvation");
    }

    // We do NOT drop frames here anymore to prevent A/V sync issues.
    // Instead, MoviPlayer checks getBufferedDuration() to apply backpressure.

    try {
      const numberOfFrames = audioData.numberOfFrames;
      const numberOfChannels = audioData.numberOfChannels;
      const sampleRate = audioData.sampleRate;
      const audioTime = audioData.timestamp / 1_000_000; // Convert to seconds

      // Create audio buffer
      const audioBuffer = this.audioContext.createBuffer(
        numberOfChannels,
        numberOfFrames,
        sampleRate,
      );

      // Copy data to buffer
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = new Float32Array(numberOfFrames);
        audioData.copyTo(channelData, {
          planeIndex: channel,
          format: "f32-planar",
        });
        audioBuffer.copyToChannel(channelData, channel);
      }

      // Clear rebuffering flag as soon as audio data arrives (decoder is producing).
      // Don't wait for successful scheduling — SoundTouch may skip a few buffers
      // while accumulating internally, but the flag should clear immediately.
      if (this.isRebufferingForRateChange) {
        this.isRebufferingForRateChange = false;
        Logger.debug(TAG, "Rebuffering complete after playback rate change");
      }

      // Apply pitch preservation if enabled and playback rate is not 1.0
      let processedBuffer = audioBuffer;
      let usedSoundTouch = false;
      if (this.preservePitch && Math.abs(this._playbackRate - 1.0) > 0.01) {
        const stOutput = this.processSoundTouch(audioBuffer, this._playbackRate);
        if (stOutput && stOutput.length > 1) {
          processedBuffer = stOutput;
          usedSoundTouch = true;
        } else {
          // SoundTouch is accumulating internally — schedule silence of the expected
          // duration to keep timing correct. No pitch change, just a brief gap.
          const expectedDuration = audioBuffer.duration / this._playbackRate;
          const silenceFrames = Math.max(1, Math.ceil(expectedDuration * sampleRate));
          processedBuffer = this.audioContext.createBuffer(numberOfChannels, silenceFrames, sampleRate);
          usedSoundTouch = true; // treat as SoundTouch path for scheduling
        }
      }

      // Create buffer source
      const source = this.audioContext.createBufferSource();
      source.buffer = processedBuffer;
      source.connect(this.gainNode);
      source.playbackRate.value = usedSoundTouch ? 1.0 : this._playbackRate;

      // Schedule playback sequentially
      const now = this.audioContext.currentTime;
      const minTime = now + 0.005; // Small buffer to prevent glitches

      // Detect buffer underrun
      if (this.scheduledTime < now) {
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
              silenceSource.connect(this.gainNode);
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
        }
      }

      // Calculate expected playback time based on timestamp
      let targetScheduleTime = this.scheduledTime;

      if (this.hasFirstBuffer) {
        const expectedTime =
          this.firstBufferScheduledAt +
          (audioTime - this.firstBufferMediaTime) / this._playbackRate;

        const drift = expectedTime - this.scheduledTime;
        // Tighter drift tolerance (20ms) for better sync
        if (Math.abs(drift) > 0.02) {
          targetScheduleTime = expectedTime;
        }
      }

      const when = Math.max(targetScheduleTime, minTime);
      source.start(when);

      // Track first buffer for audio clock
      if (!this.hasFirstBuffer) {
        this.firstBufferScheduledAt = when;
        this.firstBufferMediaTime = audioTime;
        this.hasFirstBuffer = true;
        Logger.debug(
          TAG,
          `First buffer scheduled at ${when.toFixed(3)}s, mediaTime=${audioTime.toFixed(3)}s`,
        );
      }

      this.activeSources.push(source);
      // When SoundTouch produced output, use its actual duration.
      // When falling back to hardware rate, use original duration / rate.
      this.scheduledTime = when + (usedSoundTouch
        ? processedBuffer.duration
        : audioBuffer.duration / this._playbackRate);
      this.currentMediaTime = audioTime;
      this.scheduledCount++;

      // Track the maximum media time we've scheduled
      // audioBuffer.duration is already in media seconds, no need to multiply by playbackRate
      const endMediaTime = audioTime + audioBuffer.duration;
      if (endMediaTime > this.maxScheduledMediaTime) {
        this.maxScheduledMediaTime = endMediaTime;
      }

      // Cleanup when finished
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

      // Close the AudioData
      audioData.close();
    } catch (error) {
      Logger.error(TAG, "Render error", error);
      audioData.close();
    }
  }

  /**
   * Render raw PCM samples
   */
  renderSamples(samples: Float32Array[], sampleRate: number): void {
    if (!this.audioContext || !this.gainNode) return;
    if (!this.isPlaying) return;

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
      source.connect(this.gainNode);
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
    // Don't initialize AudioContext during muted autoplay (browser policy)
    // It will be initialized when user unmutes (user gesture)
    if (!this.audioContext && !this._muted) {
      await this.init();
    }

    // Only resume if not muted (to avoid autoplay policy errors)
    // When muted, AudioContext stays suspended until user unmutes
    if (this.audioContext?.state === "suspended" && !this._muted) {
      try {
        await this.audioContext.resume();
      } catch (err) {
        Logger.warn(
          TAG,
          "Failed to resume AudioContext (user gesture may be required)",
          err,
        );
      }
    }

    // Stop the BT keepalive — main context is taking the audio session back.
    this.stopKeepalive();

    // Warmup context (Safari fix) - only if not muted
    if (!this._muted && this.audioContext) {
      this.warmupContext();
    }

    // Reset last decode time to prevent false unhealthy buffer detection after long pause
    this.lastDecodeTime = performance.now();

    this.isPlaying = true;
    this.intentionalSuspend = false;

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
   * Initialize or update SoundTouch instance
   */
  private initSoundTouch(): void {
    if (!this.soundTouch) {
      this.soundTouch = new SoundTouch();
    }
    this.soundTouch.tempo = this._playbackRate;
    this.soundTouch.pitch = 1.0;
  }

  /**
   * Process audio buffer through SoundTouch for pitch-preserving playback rate changes
   */
  private processSoundTouch(
    inputBuffer: AudioBuffer,
    playbackRate: number
  ): AudioBuffer {
    if (!this.audioContext) return inputBuffer;

    // Initialize or update SoundTouch
    this.initSoundTouch();

    const numChannels = inputBuffer.numberOfChannels;
    const sampleRate = inputBuffer.sampleRate;
    const inputFrames = inputBuffer.length;

    // Convert planar to interleaved stereo
    const interleavedInput = new Float32Array(inputFrames * 2);
    const leftChannel = inputBuffer.getChannelData(0);
    const rightChannel = numChannels > 1 ? inputBuffer.getChannelData(1) : leftChannel;

    for (let i = 0; i < inputFrames; i++) {
      interleavedInput[i * 2] = leftChannel[i];
      interleavedInput[i * 2 + 1] = rightChannel[i];
    }

    // Feed samples to SoundTouch
    this.soundTouch!.inputBuffer.putSamples(interleavedInput, 0, inputFrames);
    this.soundTouch!.process();

    // Calculate expected output frames
    const expectedFrames = Math.ceil(inputFrames / playbackRate);
    const availableFrames = this.soundTouch!.outputBuffer.frameCount;
    const framesToExtract = Math.min(expectedFrames, availableFrames);

    if (framesToExtract === 0) {
      // SoundTouch is still accumulating internally — signal caller to skip scheduling.
      // Input is buffered inside SoundTouch and will be emitted on subsequent calls.
      return null as unknown as AudioBuffer;
    }

    // Extract processed samples
    const interleavedOutput = new Float32Array(framesToExtract * 2);
    this.soundTouch!.outputBuffer.receiveSamples(interleavedOutput, framesToExtract);

    // Create output buffer
    const outputBuffer = this.audioContext.createBuffer(
      numChannels,
      framesToExtract,
      sampleRate
    );

    // De-interleave and copy to output buffer
    const outputLeft = outputBuffer.getChannelData(0);
    const outputRight = numChannels > 1 ? outputBuffer.getChannelData(1) : null;

    for (let i = 0; i < framesToExtract; i++) {
      outputLeft[i] = interleavedOutput[i * 2];
      if (outputRight) {
        outputRight[i] = interleavedOutput[i * 2 + 1];
      }
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
  private intentionalSuspend: boolean = false;

  pause(): void {
    this.isPlaying = false;

    // Don't stop sources or clear buffers!
    // Just suspend the context to pause time.
    // This preserves the audio buffer (scheduled nodes) so we resume exactly where we left off.
    // If we clear sources, we lose the buffered audio (e.g. 2 seconds worth), causing the
    // player to jump forward by that amount on resume.
    if (this.audioContext && this.audioContext.state === "running") {
      // Start silent <audio> keepalive BEFORE suspending so the OS audio
      // session never goes idle — without this, A2DP Bluetooth devices drop
      // the connection on every pause/resume cycle.
      this.startKeepalive();
      this.intentionalSuspend = true;
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
    this.intentionalSuspend = true;
    if (this.audioContext && this.audioContext.state === "running") {
      this.audioContext.suspend().catch((err) => {
        Logger.error(TAG, "Failed to suspend audio context for buffering", err);
      });
    }
    Logger.debug(TAG, "Suspended for buffering (isPlaying still true)");
  }

  /**
   * Resume audio after buffering. Clears the intentional suspend flag.
   */
  resumeFromBuffering(): void {
    this.intentionalSuspend = false;
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
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode && !this._muted) {
      if (this._stableAudio) {
        this.rampGain(this.volume);
      } else {
        this.gainNode.gain.value = this.volume;
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

    // Clear SoundTouch state when rate changes
    if (this.soundTouch && this.preservePitch) {
      this.soundTouch.clear();
    }

    // Pivot the clock before changing rate
    if (
      this.audioContext &&
      this.audioContext.state === "running" &&
      this.hasFirstBuffer
    ) {
      const now = this.audioContext.currentTime;
      const currentMediaTime =
        this.firstBufferMediaTime +
        (now - this.firstBufferScheduledAt) * oldRate;

      const bufferAhead = this.scheduledTime - now;
      if (bufferAhead > 0) {
        this.scheduledTime = now + bufferAhead * (oldRate / newRate);
      } else {
        this.scheduledTime = now + 0.01;
      }

      this.firstBufferScheduledAt = now;
      this.firstBufferMediaTime = currentMediaTime;
    }

    this._playbackRate = newRate;

    // Stop all currently playing sources to force immediate re-buffering with new rate
    // This causes a brief gap (~50-100ms) but ensures correct playback rate immediately
    if (this.audioContext) {
      const now = this.audioContext.currentTime;

      // No rebuffering flag — brief audio gap (~50-100ms) is acceptable.
      // Setting the flag causes loading state that gets stuck when SoundTouch
      // delays output (especially on Safari). Clock drift correction handles sync.

      // Stop all active sources
      if (this.activeSources.length > 0) {
        for (const source of this.activeSources) {
          try {
            source.stop(now);
            source.disconnect();
          } catch {
            // Source may already be stopped
          }
        }

        // Clear active sources array
        this.activeSources = [];

        // Reset scheduled time to force immediate re-buffering
        this.scheduledTime = now;
      } else if (this.isPlaying) {
        // No active sources but playing (e.g., underrun or just started)
        // Still need to reset scheduled time to ensure new audio uses new rate immediately
        this.scheduledTime = now;
      }
    }
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

    if (this.gainNode) {
      if (this._stableAudio) {
        this.rampGain(this.volume);
      } else {
        this.gainNode.gain.value = this.volume;
      }
    }

    // Resume AudioContext on unmute (user gesture) if it was suspended
    if (this.audioContext && this.audioContext.state === "suspended") {
      this.audioContext
        .resume()
        .then(() => {
          Logger.debug(TAG, "AudioContext resumed on unmute");
        })
        .catch((err) => {
          Logger.warn(TAG, "Failed to resume AudioContext on unmute", err);
        });
    }

    Logger.debug(TAG, "Unmuted");
  }

  /**
   * Reset timing and stop all scheduled audio with smooth fade-out
   */
  reset(): void {
    // Stable audio: fade out before stopping to prevent clicks
    if (this._stableAudio && this.audioContext && this.gainNode && this.activeSources.length > 0) {
      try {
        const now = this.audioContext.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(0, now + AudioRenderer.FADE_OUT_TIME);
      } catch {
        // Ignore ramp errors
      }
    }

    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Ignore
      }
    }
    this.activeSources = [];
    this.scheduledTime = this.audioContext?.currentTime ?? 0;

    // Reset clock tracking
    this.hasFirstBuffer = false;
    this.firstBufferScheduledAt = 0;
    this.firstBufferMediaTime = 0;
    this.scheduledCount = 0;
    this.maxScheduledMediaTime = 0;

    // Reset starvation tracking
    this.isStarved = false;
    this.starvationStartTime = 0;

    // Clear SoundTouch state
    if (this.soundTouch) {
      this.soundTouch.clear();
    }

    // Restore gain after fade-out (for next playback)
    if (this._stableAudio && this.gainNode && this.audioContext) {
      try {
        const restoreTime = this.audioContext.currentTime + AudioRenderer.FADE_OUT_TIME + 0.005;
        this.gainNode.gain.linearRampToValueAtTime(
          this._muted ? 0 : this.volume,
          restoreTime
        );
      } catch {
        // Fallback: set directly
        this.gainNode.gain.value = this._muted ? 0 : this.volume;
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
   * Get the audio clock - THE MASTER TIME SOURCE FOR A/V SYNC
   * Returns accurate time based on when audio actually started playing
   * Returns -1 if audio hasn't started yet
   * Clamps to maxScheduledMediaTime when audio has ended
   */
  getAudioClock(): number {
    if (
      this.audioContext &&
      this.audioContext.state === "running" &&
      this.hasFirstBuffer
    ) {
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
        return Math.min(computedTime, this.maxScheduledMediaTime);
      }
      return computedTime;
    }
    return -1;
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

    // Check if decoder has stopped outputting
    const timeSinceLastDecode = performance.now() - this.lastDecodeTime;
    if (this.lastDecodeTime > 0 && timeSinceLastDecode > 500) return false;

    // Compute buffer ahead time
    const realBufferAhead = this.scheduledTime - this.audioContext.currentTime;
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
  getBufferedDuration(): number {
    if (!this.audioContext) return 0;
    return Math.max(0, this.scheduledTime - this.audioContext.currentTime);
  }

  /**
   * Get the furthest media time (seconds) already scheduled in Web Audio.
   */
  getMaxScheduledMediaTime(): number {
    return this.maxScheduledMediaTime;
  }

  // ─── Stable Audio Methods ────────────────────────────────────────────

  /**
   * Enable/disable stable audio mode (dynamic range compression / loudness normalization)
   */
  setStableAudio(enabled: boolean): void {
    this._stableAudio = enabled;
    Logger.info(TAG, `Stable audio: ${enabled ? "enabled" : "disabled"}`);

    // Dynamically rewire audio chain
    if (this.audioContext && this.gainNode && this.compressorNode) {
      try {
        // Disconnect gainNode from current destination
        this.gainNode.disconnect();

        if (enabled) {
          // source -> gain -> compressor -> destination
          this.gainNode.connect(this.compressorNode);
          this.compressorNode.connect(this.audioContext.destination);
        } else {
          // source -> gain -> destination (bypass compressor)
          this.compressorNode.disconnect();
          this.gainNode.connect(this.audioContext.destination);
        }
        Logger.debug(TAG, `Audio chain rewired: compressor ${enabled ? "active" : "bypassed"}`);
      } catch {
        Logger.warn(TAG, "Failed to rewire audio chain");
      }
    }

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
  private rampGain(targetValue: number): void {
    if (!this.gainNode || !this.audioContext) {
      return;
    }
    try {
      const now = this.audioContext.currentTime;
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

      if (state === "interrupted" || (state === "suspended" && this.isPlaying && !this._muted && !this.intentionalSuspend)) {
        Logger.warn(TAG, `AudioContext ${state} unexpectedly during playback, attempting recovery`);
        this.attemptContextRecovery();
      } else if (state === "running") {
        // Successfully recovered
        this.recoveryAttempts = 0;
        Logger.debug(TAG, "AudioContext recovered to running state");
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

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.gainNode = null;
    this.compressorNode = null;
    this.soundTouch = null;
    this.recoveryAttempts = 0;
    Logger.debug(TAG, "Destroyed");
  }
}
