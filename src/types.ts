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
}

/** External subtitle source (VTT/SRT) with language metadata */
export interface SubtitleSourceEntry {
  url: string;
  lang: string;       // BCP 47 language code
  label: string;      // Display name
  format?: "vtt" | "srt"; // Auto-detected from URL extension if omitted
}

export interface CacheConfig {
  type: "lru";
  maxSizeMB: number;
}

export type RendererType = "canvas";
export type DecoderType = "auto" | "software";

export interface PlayerConfig {
  source: SourceConfig;
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
  drm?: boolean; // Enable DRM mode for HLS (native video element, no canvas)
  licenseUrl?: string; // Widevine/FairPlay license server URL
  licenseHeaders?: Record<string, string>; // Custom headers for license requests (e.g., auth tokens)
}

// ============================================================================
// Media Info
// ============================================================================

export interface Chapter {
  title: string;
  start: number; // seconds
  end: number;   // seconds
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
  loadStart: void;
  loadEnd: void;
  seeking: number;
  seeked: number;
  bufferUpdate: { start: number; end: number }[];
  ended: void;
}
