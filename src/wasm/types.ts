/**
 * WASM Types - Type definitions for WASM module with Asyncify
 */

// Emscripten FS interface
export interface EmscriptenFS {
  mkdir: (path: string) => void;
  rmdir: (path: string) => void;
  mount: (type: unknown, opts: { files?: File[] }, mountpoint: string) => void;
  unmount: (mountpoint: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
  unlink: (path: string) => void;
  filesystems: {
    WORKERFS: unknown;
  };
}

export interface MoviWasmModule {
  // Memory
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF64: Float64Array;

  // Memory allocation
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;

  // String utils
  stringToNewUTF8: (str: string) => number;
  UTF8ToString: (ptr: number) => string;

  // Filesystem
  FS: EmscriptenFS;

  // Core API - async functions due to Asyncify
  _movi_create: () => number;
  _movi_destroy: (ctx: number) => void;
  _movi_set_file_size: (ctx: number, sizeLow: number, sizeHigh: number) => void;
  _movi_open: (ctx: number) => Promise<number>; // Now async (no filename param)
  _movi_get_duration: (ctx: number) => number;
  _movi_get_start_time: (ctx: number) => number;
  _movi_get_stream_count: (ctx: number) => number;
  _movi_get_stream_info: (
    ctx: number,
    streamIndex: number,
    infoPtr: number,
  ) => number;
  _movi_get_extradata: (
    ctx: number,
    streamIndex: number,
    buffer: number,
    bufferSize: number,
  ) => number;
  _movi_seek_to: (
    ctx: number,
    timestamp: number,
    streamIndex: number,
    flags: number,
  ) => Promise<number>; // Now async
  _movi_read_frame: (
    ctx: number,
    infoPtr: number,
    buffer: number,
    bufferSize: number,
  ) => Promise<number>; // Now async
  _movi_set_log_level: (level: number) => void;
  _movi_get_format_name: (ctx: number, buffer: number, size: number) => number;
  _movi_get_metadata_title: (
    ctx: number,
    buffer: number,
    size: number,
  ) => number;

  // Decoding
  _movi_enable_decoder: (ctx: number, stream_index: number) => number;
  _movi_send_packet: (
    ctx: number,
    stream_index: number,
    data: number,
    size: number,
    pts: number,
    dts: number,
    keyframe: number,
  ) => number;
  _movi_receive_frame: (ctx: number, stream_index: number) => number;
  _movi_get_frame_width: (ctx: number) => number;
  _movi_get_frame_height: (ctx: number) => number;
  _movi_get_frame_format(ctx: number): number;
  _movi_get_frame_data(ctx: number, plane: number): number;
  _movi_get_frame_linesize(ctx: number, plane: number): number;
  _movi_get_frame_samples(ctx: number): number;
  _movi_get_frame_channels(ctx: number): number;
  _movi_get_frame_sample_rate(ctx: number): number;
  _movi_enable_audio_downmix(ctx: number, enable: number): void;
  _movi_get_frame_pts(ctx: number, streamIndex: number): number;
  _movi_flush_decoder(ctx: number, streamIndex: number): void;

  // RGBA conversion for software decoding
  _movi_get_frame_rgba(
    ctx: number,
    targetWidth: number,
    targetHeight: number,
  ): number;
  _movi_get_frame_rgba_size(ctx: number): number;
  _movi_get_frame_rgba_linesize(ctx: number): number;
  _movi_set_skip_frame(ctx: number, streamIndex: number, skip: number): void;

  // Thumbnail API (demux only)
  _movi_thumbnail_create: (fileSizeLow: number, fileSizeHigh: number) => number;
  _movi_thumbnail_open: (ctx: number) => Promise<number>;
  _movi_thumbnail_read_keyframe: (ctx: number, timestamp: number) => void; // Callback pattern
  _movi_thumbnail_get_packet_data: (ctx: number) => number;
  _movi_thumbnail_get_packet_pts: (ctx: number) => number;
  _movi_thumbnail_get_stream_info: (ctx: number, infoPtr: number) => number;
  _movi_thumbnail_get_extradata: (
    ctx: number,
    buffer: number,
    bufferSize: number,
  ) => number;
  _movi_thumbnail_decode_frame_yuv: (ctx: number) => number;
  _movi_thumbnail_get_plane_data: (ctx: number, plane: number) => number;
  _movi_thumbnail_get_plane_linesize: (ctx: number, plane: number) => number;
  _movi_thumbnail_get_frame_width: (ctx: number) => number;
  _movi_thumbnail_get_frame_height: (ctx: number) => number;
  _movi_thumbnail_destroy: (ctx: number) => void;

  // Emscripten utilities
  ccall: (
    name: string,
    returnType: string,
    argTypes: string[],
    args: unknown[],
    opts?: { async?: boolean },
  ) => unknown | Promise<unknown>;
  cwrap: (
    name: string,
    returnType: string,
    argTypes: string[],
  ) => (...args: unknown[]) => unknown;
  addFunction: (func: Function, sig: string) => number;
}

export interface StreamInfo {
  index: number;
  type: number; // 0=video, 1=audio, 2=subtitle
  codecId: number;
  codecName: string;
  width: number;
  height: number;
  frameRate: number;
  channels: number;
  sampleRate: number;
  duration: number;
  bitRate: number;
  extradataSize: number;
  profile: number;
  level: number;
  language: string; // Empty string if not available
  label: string; // Empty string if not available
  rotation: number;
  colorPrimaries: string;
  colorTransfer: string;
  colorMatrix: string;
  pixelFormat: string;
  colorRange: string;
}

export interface PacketInfo {
  streamIndex: number;
  keyframe: boolean;
  pts: number;
  dts: number;
  duration: number;
  size: number;
}

// StreamInfo struct layout (matches C struct)
export const STREAM_INFO_SIZE = 336; // Adjusted for pixel format + range
export const STREAM_INFO_OFFSETS = {
  index: 0,
  type: 4,
  codecId: 8,
  codecName: 12, // 32 bytes
  width: 44,
  height: 48,
  frameRate: 56, // double
  channels: 64,
  sampleRate: 68,
  duration: 72, // double
  bitRate: 80, // int64
  extradataSize: 88,
  profile: 92,
  level: 96,
  language: 100, // 8 bytes (char[8])
  label: 108, // 64 bytes (char[64])
  rotation: 172, // 4 bytes (int)
  colorPrimaries: 176, // 32 bytes
  colorTransfer: 208, // 32 bytes
  colorMatrix: 240, // 32 bytes
  pixelFormat: 272, // 32 bytes
  colorRange: 304, // 32 bytes
};

// PacketInfo struct layout
export const PACKET_INFO_SIZE = 40;
export const PACKET_INFO_OFFSETS = {
  streamIndex: 0,
  keyframe: 4,
  timestamp: 8, // double
  dts: 16, // double
  duration: 24, // double
  size: 32,
};
