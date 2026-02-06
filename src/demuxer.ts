/**
 * Movi Demuxer Module
 *
 * Provides media file parsing and packet extraction functionality.
 * This module can be used independently for metadata extraction and demuxing.
 *
 * Usage:
 * ```typescript
 * import { Demuxer, HttpSource } from 'movi/demuxer';
 * const source = HttpSource('video.mp4');
 * const demuxer = new Demuxer(source);
 * await demuxer.load();
 * ```
 */

// Core Types
export type {
  Track,
  TrackType,
  VideoTrack,
  AudioTrack,
  SubtitleTrack,
  SubtitleCue,
  SourceConfig,
  CacheConfig,
  RendererType,
  DecoderType,
  PlayerConfig,
  MediaInfo,
  VideoDecoderConfig,
  AudioDecoderConfig,
  Packet,
  DecodedVideoFrame,
  DecodedAudioFrame,
  PlayerState,
  PlayerEventMap,
} from './types';

// Utilities
export { Logger, LogLevel } from './utils/Logger';
export { Time, TIME_BASE } from './utils/Time';
export { ThumbnailRenderer, type ThumbnailRenderOptions } from './utils/ThumbnailRenderer';

// Events
export { EventEmitter } from './events/EventEmitter';

// WASM bindings (singleton pattern)
export { WasmBindings, ThumbnailBindings, type DataSource } from './wasm/bindings';
export { loadWasmModule, loadWasmModuleNew, getWasmModule, isWasmModuleLoaded } from './wasm/FFmpegLoader';
export type { MoviWasmModule, StreamInfo, PacketInfo } from './wasm/types';

// Source adapters (required for Demuxer)
export type { SourceAdapter } from './source/SourceAdapter';
export { HttpSource, createHttpSource } from './source/HttpSource';
export { FileSource, createFileSource } from './source/FileSource';
export { ThumbnailHttpSource, createThumbnailHttpSource } from './source/ThumbnailHttpSource';

// Cache (useful for advanced usage)
export { LRUCache } from './cache/LRUCache';

// Main export: Demuxer
export { Demuxer } from './demux/Demuxer';
