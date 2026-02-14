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

  constructor() {
    Logger.debug(TAG, "Created");
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
      this.gainNode.connect(this.audioContext.destination);
      // Apply muted state if set before initialization
      this.gainNode.gain.value = this._muted ? 0 : this.volume;

      // Resume if suspended (only if not muted to avoid autoplay policy errors)
      // When muted, we'll resume on first user interaction (unmute/play)
      if (this.audioContext.state === "suspended" && !this._muted) {
        await this.audioContext.resume();
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

      // Apply pitch preservation if enabled and playback rate is not 1.0
      let processedBuffer = audioBuffer;
      if (this.preservePitch && Math.abs(this._playbackRate - 1.0) > 0.01) {
        processedBuffer = this.processSoundTouch(audioBuffer, this._playbackRate);
      }

      // Create buffer source
      const source = this.audioContext.createBufferSource();
      source.buffer = processedBuffer;
      source.connect(this.gainNode);
      // When using SoundTouch, playback rate is already applied, so keep it at 1.0
      source.playbackRate.value = this.preservePitch && Math.abs(this._playbackRate - 1.0) > 0.01 ? 1.0 : this._playbackRate;

      // Schedule playback sequentially
      const now = this.audioContext.currentTime;
      const minTime = now + 0.005; // Small buffer to prevent glitches

      // Detect buffer underrun
      if (this.scheduledTime < now) {
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
      this.scheduledTime = when + audioBuffer.duration / this._playbackRate;
      this.currentMediaTime = audioTime;
      this.scheduledCount++;

      // Clear rebuffering flag once we successfully schedule new audio
      if (this.isRebufferingForRateChange) {
        this.isRebufferingForRateChange = false;
        Logger.debug(TAG, "Rebuffering complete after playback rate change");
      }

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

    // Warmup context (Safari fix) - only if not muted
    if (!this._muted && this.audioContext) {
      this.warmupContext();
    }

    // Reset last decode time to prevent false unhealthy buffer detection after long pause
    this.lastDecodeTime = performance.now();

    this.isPlaying = true;

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
      // Return a silent buffer if no output available
      return this.audioContext.createBuffer(numChannels, 1, sampleRate);
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
  pause(): void {
    this.isPlaying = false;

    // Don't stop sources or clear buffers!
    // Just suspend the context to pause time.
    // This preserves the audio buffer (scheduled nodes) so we resume exactly where we left off.
    // If we clear sources, we lose the buffered audio (e.g. 2 seconds worth), causing the
    // player to jump forward by that amount on resume.
    if (this.audioContext && this.audioContext.state === "running") {
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
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode && !this._muted) {
      this.gainNode.gain.value = this.volume;
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

      // Set rebuffering flag to signal MoviPlayer to show loading and pause clock
      // Set this flag even if no active sources, to ensure proper clock sync on resume
      if (this.isPlaying || this.activeSources.length > 0) {
        this.isRebufferingForRateChange = true;
      }

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
   * Mute
   */
  mute(): void {
    this._muted = true;
    if (this.gainNode) {
      this.gainNode.gain.value = 0;
    }
    Logger.debug(TAG, "Muted");
  }

  /**
   * Unmute
   */
  async unmute(): Promise<void> {
    this._muted = false;

    // Initialize AudioContext on unmute if not already initialized (user gesture)
    // This happens during autoplay muted -> unmute transition
    if (!this.audioContext && this.isPlaying) {
      await this.init();
    }

    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
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
   * Reset timing and stop all scheduled audio
   */
  reset(): void {
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

    // Clear SoundTouch state
    if (this.soundTouch) {
      this.soundTouch.clear();
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
   * Destroy renderer
   */
  async destroy(): Promise<void> {
    this.isPlaying = false;
    this.reset();

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.gainNode = null;
    this.soundTouch = null;
    Logger.debug(TAG, "Destroyed");
  }
}
