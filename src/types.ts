/**
 * Movi Types - Core type definitions for the streaming video library
 */

// ============================================================================
// Track Types
// ============================================================================

export type TrackType = "video" | "audio" | "subtitle";

export interface Track {
  id: number;
  type: "video" | "audio" | "subtitle";
  codec: string;
  /**
   * This stream's own duration in seconds, as the container declares it —
   * NOT the file's. They differ on a file whose streams don't end together:
   * a 161s recording whose camera stopped at 80s has a video track of 80s
   * and an audio track of 161s. Falls back to the container duration when the
   * stream doesn't carry one, and is 0 when neither does.
   */
  duration?: number;
  codecString?: string;
  extradata?: Uint8Array;
  profile?: number;
  level?: number;
  language?: string;
  label?: string;
  // Video-specific
  width?: number;
  height?: number;
  frameRate?: number;
  // Audio-specific
  channels?: number;
  sampleRate?: number;
  // Subtitle-specific
  subtitleType?: "text" | "image";
}

export interface VideoTrack extends Track {
  type: "video";
  width: number;
  height: number;
  frameRate: number;
  pixelFormat?: string;
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  bitRate?: number;
  rotation?: number;
  colorRange?: string;
  isHDR?: boolean;
  /**
   * 360° spherical projection from container metadata: 0 / undefined = not a
   * 360 video, else AVSphericalProjection+1 (1=equirectangular, 2=cubemap,
   * 3=equirectangular-tile, 4=half-equirectangular). Only equirectangular
   * (1 and 3) is renderable by the current 360 viewer.
   */
  projection?: number;
  /**
   * True when this is an embedded cover-art pseudo-stream (ID3v2 APIC,
   * FLAC PICTURE, MP4 covr, Matroska attachment). These look like single-
   * frame PNG/JPEG video streams to the demuxer; consumers picking an
   * active video track should skip them and read the picture via the
   * player's cover-art accessor instead.
   */
  isAttachedPic?: boolean;
}

export interface AudioTrack extends Track {
  type: "audio";
  channels: number;
  sampleRate: number;
  bitRate?: number;
}

export interface SubtitleTrack extends Track {
  type: "subtitle";
  subtitleType: "text" | "image";
}

// ============================================================================
// Subtitle Types
// ============================================================================

export interface SubtitleCue {
  start: number;
  end: number;
  text?: string;
  image?: ImageBitmap;
  position?: { x: number; y: number };
}

// ============================================================================
// Player Configuration
// ============================================================================

export interface SourceConfig {
  type: "url" | "file" | "encrypted";
  url?: string;
  file?: File;
  headers?: Record<string, string>;
  /** Encrypted source config */
  encrypted?: {
    videoUrl: string;
    tokenUrl: string;
    videoId: string;
    fingerprint: string;
    sessionToken: string;
    tokenRefreshInterval?: number;
    onAuthFailed?: (reason: string) => void;
  };
}

/** Audio source with language metadata for multi-language support */
export interface AudioSourceEntry {
  url: string;
  type?: string;
  lang: string;       // BCP 47 language code (e.g., "en", "hi", "ja")
  label: string;      // Display name (e.g., "English", "Hindi")
  /**
   * Pre-built adapter for this track (e.g. an HLS audio rendition presented as
   * a concatenated segment stream). Opened directly instead of `url` when set;
   * `url` still serves as the display/cache key.
   */
  adapter?: import("./source/SourceAdapter").SourceAdapter;
}

/** External subtitle source (VTT/SRT) with language metadata */
export interface SubtitleSourceEntry {
  url: string;
  lang: string;       // BCP 47 language code
  label: string;      // Display name
  format?: "vtt" | "srt" | "ttml"; // Auto-detected from URL extension if omitted
}

export interface CacheConfig {
  type: "lru";
  maxSizeMB: number;
}

export type RendererType = "canvas";
export type DecoderType = "auto" | "software";

export interface PlayerConfig {
  /**
   * Standard source descriptor (url / file / encrypted). Optional when a
   * pre-built `sourceAdapter` is supplied instead.
   */
  source?: SourceConfig;
  /**
   * Pre-built SourceAdapter — overrides `source` when present.
   * Use this to feed media from a custom protocol (WebSocket, WebRTC data
   * channel, IndexedDB, encrypted blob, etc.) without writing a SourceConfig
   * branch. The adapter's `getSize()` and `read()` are called directly.
   */
  sourceAdapter?: import("./source/SourceAdapter").SourceAdapter;
  /**
   * Skip the MSE stream engines (Shaka / hls.js / dash.js) for a DASH source
   * and play its single-file Representation through the FFmpeg-WASM demuxer
   * instead. Set after an MSE engine fails at RUNTIME on a codec the browser
   * can't decode (e.g. Safari + HE-AAC): the demuxer decodes every codec.
   */
  forceStreamDemux?: boolean;
  /**
   * Skip Shaka and play a stream through a specific MSE engine (hls.js /
   * dash.js) directly. Set when Shaka failed at runtime but the other engine
   * is more lenient (e.g. a manifest/actual codec mismatch) — tried before the
   * heavier WASM demuxer so hardware MSE playback is preferred when possible.
   */
  forceStreamEngine?: "dashjs" | "hlsjs";
  /**
   * Treat this URL as an adaptive manifest whatever its path looks like.
   *
   * Which of the two a URL is — a manifest or a media file — is normally read
   * off the URL, and that holds only while a manifest ends in .m3u8 or .mpd.
   * Plenty do not: a signed endpoint like
   * "/share/streaming?type=M3U8_FLV_264_480" serves a playlist and says so in
   * its Content-Type, while nothing in its path says anything at all. Such a
   * URL is handed to the demuxer, which is given a text playlist where it
   * expected a container, and the open fails.
   *
   * Set by the caller that has since found out — see the retry in MoviElement,
   * which asks the source what the server called it once an open has already
   * failed. Not a probe: nothing is fetched to answer this.
   */
  forceStream?: "hls" | "dash";
  /**
   * When force-demuxing a DASH source, use this specific video Representation
   * file instead of the best one — set when the user picks a quality in the
   * demuxer-mode quality menu, so the re-load lands on the chosen rendition.
   */
  forceVideoRendition?: string;
  /** Separate audio source — single or multi-language */
  audioSource?: SourceConfig;
  /** Multiple audio tracks with language metadata */
  audioTracks?: AudioSourceEntry[];
  /** External subtitle tracks (VTT/SRT) with language metadata */
  subtitleTracks?: SubtitleSourceEntry[];
  renderer?: RendererType;
  decoder?: DecoderType;
  cache?: CacheConfig;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  wasmBinary?: Uint8Array; // Embedded WASM binary data
  enablePreviews?: boolean; // Enable thumbnail preview pipeline (default: false)
  frameRate?: number; // Override frame rate (fps) - 0 = auto
  headers?: Record<string, string>; // Custom HTTP headers for media network requests — adaptive manifest + segments (HLS/DASH) and progressive downloads alike (e.g. auth tokens, signed cookies)
  audioOnly?: boolean; // Audio-only mode: skip video decode (CPU) and, for adaptive streams, fetch only audio renditions (bandwidth). UI shows album art / strip.
  drm?: boolean; // Enable DRM mode for HLS (native video element, no canvas)
  licenseUrl?: string; // Widevine/FairPlay license server URL
  licenseHeaders?: Record<string, string>; // Custom headers for license requests (e.g., auth tokens)
  lcevc?: boolean; // Enable MPEG-5 Part 2 LCEVC decoding (needs the lcevc_dec.js library)
  lcevcUrl?: string; // Optional URL to lazy-load the lcevc_dec.js decoder library (else expect a global LCEVCdec)
}

// ============================================================================
// Media Info
// ============================================================================

export interface Chapter {
  title: string;
  start: number; // seconds
  end: number;   // seconds
  /**
   * Optional artwork for the chapter, supplied by the host alongside the list.
   * Where it is set the timeline tile shows it instead of decoding a frame at
   * `start` — which is both the picture the host wanted and one less seek.
   * Container chapters never carry one; it is only ever set through the
   * `chapters` attribute/property.
   */
  image?: string;
}

/**
 * A video to ask about without a file: what `canPlaySmoothly()` needs when the
 * page already knows the shape of what it is going to play (a ladder rung, an
 * upload's metadata) and has no reason to open it.
 */
export interface PlaybackQuery {
  /** A WebCodecs string ("av01.0.13M.10", "avc1.640028") or a bare family
   *  ("av1", "hevc", "h264", "vp9"), which is filled in with a representative
   *  profile. */
  codec: string;
  width: number;
  height: number;
  /** Frames per second. Defaults to 30. */
  fps?: number;
  /** Bits per second, when known — only the browser's own estimate uses it. */
  bitrate?: number;
}

export interface PlaybackAssessmentOptions {
  /** Playback speed to judge at. Decode work scales with it: 2x is twice the
   *  frames per second of wall time. Defaults to 1. */
  rate?: number;
}

/** What `canPlaySmoothly()` concluded, and why. */
export interface PlaybackAssessment {
  /** Something here can decode it at all. */
  playable: boolean;
  /** Expected to play without dropping frames, at `rate`. */
  smooth: boolean;
  /** Decoded on dedicated hardware, which is what keeps a laptop cool and a
   *  phone's battery alive. False does not mean it stutters. */
  powerEfficient: boolean;
  /** The speed this was judged at. */
  rate: number;
  video: {
    /** The codec string the question was asked with. */
    codec: string;
    width: number;
    height: number;
    fps: number;
    /**
     * Which decoder would carry it: "hardware" — the GPU's; "software" — the
     * browser's own software decoder; "wasm" — this player's built-in FFmpeg,
     * used when the browser has no decoder for it at all.
     */
    decoder: "hardware" | "software" | "wasm";
    smooth: boolean;
    powerEfficient: boolean;
    /**
     * Software decode work relative to what this class of device can carry
     * (1 = exactly at the limit). Only decides anything when there is no
     * hardware path; a hardware decoder is not bound by it.
     */
    load: number;
  } | null;
  audio: {
    codec: string;
    channels: number;
    sampleRate: number;
    decoder: "webcodecs" | "wasm";
  } | null;
  /** Plain-language reasons for anything short of smooth. Empty when smooth. */
  reasons: string[];
}

/** Options for decodeAudio(). */
export interface DecodeAudioOptions {
  /** Output sample rate. Defaults to 16000 — what speech models expect. */
  sampleRate?: number;
  /** Where to start, in seconds of media time. Defaults to 0. */
  from?: number;
  /** Length of each chunk handed back, in seconds. Defaults to 30. */
  chunkSeconds?: number;
  /** Stops decoding (and releases the file) when aborted. */
  signal?: AbortSignal;
}

/** One stretch of decoded audio from decodeAudio(): mono, resampled. */
export interface DecodedAudioChunk {
  /** Media time of the first sample, in seconds. */
  start: number;
  /** Media time just past the last sample, in seconds. */
  end: number;
  sampleRate: number;
  /** Mono samples in [-1, 1]. */
  samples: Float32Array;
}

export interface MediaInfo {
  formatName: string;
  duration: number;
  bitRate: number;
  startTime: number;
  tracks: Track[];
  chapters: Chapter[];
  metadata?: {
    [key: string]: string;
  };
}

// ============================================================================
// Decoder Config Types (WebCodecs compatible)
// ============================================================================

export interface VideoDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  colorSpace?: {
    primaries?: VideoColorPrimaries | null;
    transfer?: VideoTransferCharacteristics | null;
    matrix?: VideoMatrixCoefficients | null;
    fullRange?: boolean | null;
  };
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
}

export interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: Uint8Array;
}

// ============================================================================
// Packet Types
// ============================================================================

export interface Packet {
  streamIndex: number;
  keyframe: boolean;
  timestamp: number; // PTS
  dts: number; // DTS
  duration: number;
  data: Uint8Array;
  // True only for a real IDR/BLA random-access keyframe. False for open-GOP
  // CRA sync frames (flagged keyframe but must be sent as delta mid-stream) and
  // for non-keyframes. See VideoDecoder.decode.
  isIdr: boolean;
  // True for an HEVC RASL leading picture (NAL 8/9) that trails a CRA/BLA. After
  // a random-access resume these reference an absent (pre-RAP) GOP and must be
  // skipped — Safari's decoder hard-errors on them. See VideoDecoder.decode.
  isRasl: boolean;
  // True for a disposable (non-reference) frame — safe to drop under load since
  // nothing references it. VideoDecoder drops these before the decoder when the
  // renderer's adaptive detector reports the device can't keep up. Always false
  // for keyframes. See VideoDecoder.decode.
  disposable: boolean;
}

/**
 * Pluggable subtitle renderer. movi-player decodes video to its own WebGL canvas
 * (no HTMLVideoElement), so a native `<track>` overlay can't be used — and full
 * ASS/SSA styling (positioning, karaoke, embedded fonts) is beyond the built-in
 * text/bitmap path. Register one of these via `player.setSubtitleRenderer()` (or
 * `<movi-player>.setSubtitleRenderer()`) to take over an embedded subtitle track
 * with your own renderer — e.g. jassub (libass-wasm) for pixel-accurate ASS —
 * without the core taking that dependency.
 *
 * When a renderer is set, the player stops feeding the selected subtitle stream
 * to its internal decoder and drives this instead: `configure` on track select,
 * `pushPacket` for each demuxed subtitle packet, `render` every frame with the
 * current media time and the video's native dimensions, `setDelay` on a subtitle
 * offset change, `clear` on seek/track change, and `destroy` on teardown/swap.
 * If `mount` is present the player calls it with an overlay element already sized
 * and positioned over the visible video (letterbox-aware) for the renderer to
 * draw into.
 */
export interface SubtitleRenderer {
  /** Called on track selection. `extradata` is the codec header (the ASS
   *  `[Script Info]`/`[V4+ Styles]` block for ass/ssa). `fonts` are embedded
   *  font attachments when available (may be undefined). */
  configure(
    track: SubtitleTrack,
    extradata?: Uint8Array,
    fonts?: Uint8Array[],
  ): Promise<void> | void;
  /** One demuxed subtitle packet for the active track. */
  pushPacket(packet: Packet): Promise<void> | void;
  /** Draw the state for `mediaTime` (seconds). `videoWidth`/`videoHeight` are the
   *  source frame dimensions the subtitle coordinates are authored against. */
  render(
    mediaTime: number,
    videoWidth: number,
    videoHeight: number,
  ): Promise<void> | void;
  /** Optional: receive the player's subtitle overlay element (absolutely
   *  positioned over the visible video) to append a canvas/DOM into. */
  mount?(container: HTMLElement): void;
  /** Subtitle timing offset in seconds (positive = later). */
  setDelay(seconds: number): void;
  /** Drop all pending state — called on seek and track change. */
  clear(): void;
  /** Release resources — called on teardown or when swapped out. */
  destroy(): Promise<void> | void;
}

// ============================================================================
// Frame Types
// ============================================================================

export interface DecodedVideoFrame {
  timestamp: number;
  duration: number;
  width: number;
  height: number;
  format: "yuv420p" | "rgb24" | "rgba";
  data: Uint8Array;
  planes?: {
    y?: Uint8Array;
    u?: Uint8Array;
    v?: Uint8Array;
  };
}

export interface DecodedAudioFrame {
  timestamp: number;
  duration: number;
  sampleRate: number;
  channels: number;
  numFrames: number;
  format: "f32-planar";
  channelData: Float32Array[];
}

// ============================================================================
// Player State
// ============================================================================

export type PlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "seeking"
  | "buffering"
  | "ended"
  | "error";

// ============================================================================
// Event Types
// ============================================================================

export interface PlayerEventMap {
  frame: DecodedVideoFrame;
  audio: DecodedAudioFrame;
  subtitle: SubtitleCue;
  stateChange: PlayerState;
  timeUpdate: number;
  durationChange: number;
  tracksChange: Track[];
  error: Error;
  filerevoked: { offset: number; length: number; reason: string };
  loadStart: void;
  loadEnd: void;
  /**
   * An in-place rendition switch started (`active: true`) or finished. Playback
   * continues throughout — audio never stops — but the picture is held for a
   * second or two while the new rendition opens, and without a sign of life
   * that pause reads as the player glitching. `label` names the rung being
   * moved to, for a UI that wants to say so.
   */
  renditionSwitch: { active: boolean; label?: string };
  seeking: number;
  seeked: number;
  /**
   * A seek finished — INCLUDING the ones the player performs for itself, which
   * `seeked` deliberately stays quiet about (rendering a poster frame, the
   * first-play realignment). Internal to the element's own bookkeeping: a host
   * wants `seeked`, which answers for what it asked for.
   */
  seekcomplete: number;
  bufferUpdate: { start: number; end: number }[];
  ended: void;
  /**
   * A looping file started over.
   *
   * There is no such event on a native media element — a looping one reports
   * only `seeking` and `seeked`, and a page that wants to COUNT the turns has
   * to infer them from a seek nobody asked for. This says it outright.
   *
   * `count` is how many times this source has come back round, from 1, and
   * resets when the source does. Fires on both routes: the gapless turn, and
   * the restart a file with a soundtrack still takes.
   */
  loop: { count: number };
  preloadcomplete: void;
  /**
   * Embedded cover art extracted from the source (ID3v2 APIC, FLAC PICTURE,
   * MP4 covr, Matroska attachment). Fires once after track enumeration when
   * an attached_pic pseudo-stream is present. Recipients own the bitmap and
   * should close() it on disposal. Fires with `null` when an art track was
   * present but extraction failed, so listeners waiting on it can stop.
   */
  coverart: ImageBitmap | null;
  /**
   * Fired once when playback falls back to linear (forward-only, non-seekable)
   * mode because the server has no HTTP Range support and the file is too large
   * to cache whole. The UI hides the timeline and disables seeking/thumbnails.
   */
  linearmode: void;
  /**
   * Autoplay-with-sound was refused, so playback started muted instead. The UI
   * surfaces the "Tap to unmute" pill — the user's gesture is the only way back
   * to audio. Emitted by the native fallback, whose muting happens inside the
   * media element (the WASM path detects the same condition off its
   * AudioContext, see maybeFallbackToMutedAutoplay).
   */
  autoplaymuted: void;
}
