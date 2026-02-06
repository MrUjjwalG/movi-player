# Demuxer Documentation

**Movi Streaming Video Library - Demuxer Component**

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [API Reference](#api-reference)
4. [Container Format Support](#container-format-support)
5. [Codec Support](#codec-support)
6. [Color Space Handling](#color-space-handling)
7. [Usage Examples](#usage-examples)
8. [Performance Considerations](#performance-considerations)
9. [Error Handling](#error-handling)
10. [Technical Details](#technical-details)

---

## Overview

The Demuxer is a core component of the Movi library responsible for:

- **Container Parsing:** Extracting audio, video, and subtitle streams from media files
- **Metadata Extraction:** Reading codec parameters, dimensions, color space, bitrate, etc.
- **Packet Delivery:** Providing encoded packets for decoder consumption
- **Seeking:** Random access to any timestamp in the media
- **Async I/O:** Non-blocking data reading through pluggable source adapters

**Key File:** [src/demux/Demuxer.ts](../src/demux/Demuxer.ts)

### Technology Stack

- **FFmpeg WASM:** Emscripten-compiled FFmpeg for universal container format support
- **Asyncify:** Enables asynchronous I/O operations through WASM boundary
- **TypeScript:** Type-safe API with full IntelliSense support

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     Demuxer                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐      ┌──────────────────────┐         │
│  │ SourceAdapter│─────>│  SourceDataAdapter   │         │
│  │  Interface   │      │   (Async I/O Bridge) │         │
│  └──────────────┘      └──────────┬───────────┘         │
│                                    │                    │
│                                    ▼                    │
│                        ┌───────────────────────┐        │
│                        │   WasmBindings        │        │
│                        │  (TypeScript Wrapper) │        │
│                        └───────────┬───────────┘        │
│                                    │                    │
│                                    ▼                    │
│                        ┌───────────────────────┐        │
│                        │  FFmpeg WASM Module   │        │
│                        │  (libavformat +       │        │
│                        │   libavcodec)         │        │
│                        └───────────────────────┘        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Source Reading:** SourceAdapter (HttpSource/FileSource) provides async read access
2. **Adaptation:** SourceDataAdapter converts to DataSource interface for WASM
3. **WASM Bridge:** WasmBindings manages FFmpeg C API through Asyncify
4. **Demuxing:** FFmpeg parses container and extracts packets
5. **Metadata:** Track information (codec, dimensions, color space) extracted
6. **Packet Return:** Encoded packets returned to player for decoding

---

## API Reference

### Constructor

```typescript
constructor(
  source: SourceAdapter,
  wasmBinary?: Uint8Array,
  useNewWasmInstance: boolean = false
)
```

**Parameters:**

- `source` - Data source adapter (HttpSource or FileSource)
- `wasmBinary` - Optional pre-loaded WASM binary (for faster initialization)
- `useNewWasmInstance` - Create isolated WASM instance (used for thumbnail generation)

**Example:**

```typescript
import { Demuxer } from "movi/demuxer";
import { HttpSource } from "movi/source";

const source = new HttpSource("https://example.com/video.mp4");
const demuxer = new Demuxer(source);
```

---

### Methods

#### `open(): Promise<MediaInfo>`

Opens the media file and parses metadata.

**Returns:** MediaInfo object containing:

```typescript
interface MediaInfo {
  formatName: string; // Container format (e.g., "mp4", "matroska")
  duration: number; // Duration in seconds
  bitRate: number; // Overall bitrate in bits/second
  startTime: number; // Start time offset
  tracks: Track[]; // Array of video/audio/subtitle tracks
}
```

**Example:**

```typescript
const mediaInfo = await demuxer.open();
console.log(`Duration: ${mediaInfo.duration}s`);
console.log(`Tracks: ${mediaInfo.tracks.length}`);
```

---

#### `readPacket(): Promise<Packet | null>`

Reads the next encoded packet from the current stream position.

**Returns:** Packet object or null at end of stream:

```typescript
interface Packet {
  streamIndex: number; // Track ID (0, 1, 2, ...)
  keyframe: boolean; // True for keyframes/sync points
  timestamp: number; // Presentation timestamp (PTS) in seconds
  duration: number; // Packet duration in seconds
  data: Uint8Array; // Encoded data
}
```

**Example:**

```typescript
while (true) {
  const packet = await demuxer.readPacket();
  if (!packet) break; // End of stream

  if (packet.streamIndex === 0) {
    // Video packet
    videoDecoder.decode(packet.data, packet.timestamp, packet.keyframe);
  }
}
```

---

#### `seek(timestamp: number, flags?: number): Promise<void>`

Seeks to a specific timestamp. FFmpeg will seek to the nearest keyframe before the target.

**Parameters:**

- `timestamp` - Target time in seconds
- `flags` - Seek flags (default: 1 = AVSEEK_FLAG_BACKWARD)

**Example:**

```typescript
await demuxer.seek(120.5); // Seek to 2 minutes 30 seconds
```

---

#### `getTracks(): Track[]`

Returns all tracks in the media file.

**Returns:** Array of Track objects:

```typescript
type Track = VideoTrack | AudioTrack | SubtitleTrack;
```

**Example:**

```typescript
const tracks = demuxer.getTracks();
tracks.forEach((track) => {
  console.log(`Track ${track.id}: ${track.type} (${track.codec})`);
});
```

---

#### `getVideoTracks(): VideoTrack[]`

Returns only video tracks.

```typescript
interface VideoTrack extends Track {
  type: "video";
  codec: string; // Codec name (e.g., "h264", "hevc")
  width: number;
  height: number;
  frameRate: number; // Frames per second
  bitRate: number;
  profile?: number; // Codec profile
  level?: number; // Codec level
  rotation?: number; // Rotation in degrees (0, 90, 180, 270)
  colorPrimaries?: string; // Color primaries (e.g., "bt709", "bt2020")
  colorTransfer?: string; // Transfer function (e.g., "smpte2084" for HDR)
  colorSpace?: string; // Color matrix (e.g., "bt2020-ncl")
  isHDR: boolean; // Convenient HDR detection (true if HDR transfer or BT.2020)
  extradata?: Uint8Array; // Codec configuration record
}
```

---

#### `getAudioTracks(): AudioTrack[]`

Returns only audio tracks.

```typescript
interface AudioTrack extends Track {
  type: "audio";
  codec: string; // Codec name (e.g., "aac", "opus")
  channels: number; // Channel count (2 = stereo)
  sampleRate: number; // Sample rate in Hz
  bitRate: number;
  language?: string; // ISO 639-2 language code
  label?: string; // Human-readable label
  extradata?: Uint8Array;
}
```

---

#### `getSubtitleTracks(): SubtitleTrack[]`

Returns only subtitle tracks.

```typescript
interface SubtitleTrack extends Track {
  type: "subtitle";
  codec: string;
  subtitleType: "text" | "image"; // Text (SRT, WebVTT) or Image (PGS, DVBSUB)
  language?: string;
  label?: string;
  extradata?: Uint8Array;
}
```

---

#### `getExtradata(trackId: number): Uint8Array | null`

Gets the codec configuration record (extradata) for a specific track.

**Returns:** Binary codec configuration or null if not available

**Usage:** Required for initializing WebCodecs decoders with proper configuration

**Example:**

```typescript
const extradata = demuxer.getExtradata(0); // Get video track extradata
const codecString = CodecParser.getCodecString("hevc", extradata);
// Returns: "hvc1.2.4.L153.B0"
```

---

#### `getDuration(): number`

Returns media duration in seconds.

---

#### `close(): void`

Closes the demuxer and releases all resources.

**Important:** Always call this when done to free WASM memory.

```typescript
demuxer.close();
```

---

## Container Format Support

The demuxer supports all FFmpeg-compatible container formats through WASM compilation:

### Fully Supported

| Format        | Extension              | Standards              | Notes                           |
| ------------- | ---------------------- | ---------------------- | ------------------------------- |
| **MP4**       | `.mp4`, `.m4v`, `.m4a` | ISO/IEC 14496-14       | Primary web format, best tested |
| **WebM**      | `.webm`                | WebM Project           | VP8/VP9, optimized for web      |
| **Matroska**  | `.mkv`, `.mka`         | Matroska Specification | Universal container, all codecs |
| **MPEG-TS**   | `.ts`, `.m2ts`         | ISO/IEC 13818-1        | Broadcast format                |
| **QuickTime** | `.mov`                 | Apple QuickTime        | Apple ecosystem                 |
| **AVI**       | `.avi`                 | Microsoft AVI          | Legacy format                   |
| **FLV**       | `.flv`                 | Adobe Flash Video      | Legacy streaming                |
| **OGG**       | `.ogg`, `.ogv`         | Xiph.Org               | Open format                     |

### Partially Supported

| Format      | Extension      | Limitations                                |
| ----------- | -------------- | ------------------------------------------ |
| **ASF/WMV** | `.wmv`, `.asf` | Windows Media, proprietary codecs may fail |

---

## Codec Support

### Video Codecs

| Codec          | Status  | Decoder                 | Notes                            |
| -------------- | ------- | ----------------------- | -------------------------------- |
| **H.264/AVC**  | ✅ Full | WebCodecs → SW fallback | Most common, universal support   |
| **H.265/HEVC** | ✅ Full | WebCodecs → SW fallback | 4K/HDR primary codec             |
| **VP9**        | ✅ Full | WebCodecs → SW fallback | YouTube, HDR capable             |
| **VP8**        | ✅ Full | WebCodecs → SW fallback | WebM standard                    |
| **AV1**        | ✅ Full | WebCodecs → SW fallback | Next-gen codec, best compression |

**Legend:**

- ✅ Full: Hardware decode + software fallback
- ⚠️ SW Only: Software decode only (slower)

### Audio Codecs

| Codec      | Status  | Notes                      |
| ---------- | ------- | -------------------------- |
| **AAC-LC** | ✅ Full | Most common web audio      |
| **MP3**    | ✅ Full | Universal compatibility    |
| **Opus**   | ✅ Full | Best quality/bitrate ratio |
| **Vorbis** | ✅ Full | OGG audio standard         |
| **FLAC**   | ✅ Full | Lossless audio             |
| **PCM**    | ✅ Full | Uncompressed audio         |
| **AC-3**   | ✅ Full | Dolby Digital 5.1          |
| **E-AC-3** | ✅ Full | Dolby Digital Plus         |

### Subtitle Codecs

| Codec                      | Type  | Status                      |
| -------------------------- | ----- | --------------------------- |
| **WebVTT**                 | Text  | ✅ Full                     |
| **SubRip (SRT)**           | Text  | ✅ Full                     |
| **SubStation Alpha (ASS)** | Text  | ✅ Full (styling supported) |
| **HDMV PGS**               | Image | ✅ Full                     |
| **DVD SUB**                | Image | ✅ Full                     |
| **DVB SUB**                | Image | ✅ Full                     |

---

## Color Space Handling

### Metadata Extraction

The demuxer extracts three critical color parameters from video tracks:

1. **Color Primaries** - Defines the RGB color gamut
2. **Color Transfer** - Defines the gamma/EOTF curve
3. **Color Matrix** - Defines YUV→RGB conversion

### Standards Compliance

Follows **ITU-T H.273** - Coding-independent code points for video signal type identification

### HDR Detection Strategy

#### 1. Metadata-First Approach

**File:** [Demuxer.ts:192-220](../src/demux/Demuxer.ts)

Prioritizes explicit FFmpeg metadata when available and valid:

```typescript
if (info.colorPrimaries && info.colorPrimaries !== "unknown") {
  videoTrack.colorPrimaries = normalizeColorPrimaries(info.colorPrimaries);
}
```

**Normalization:**

- `bt2020` → `bt2020` (ITU-T BT.2020, UHDTV)
- `bt709` → `bt709` (ITU-T BT.709, HDTV)
- `smpte2084` → `smpte2084` (PQ/HDR10)
- `arib-std-b67` → `arib-std-b67` (HLG)

#### 2. Heuristic Fallback for 4K Content

**File:** [Demuxer.ts:224-255](../src/demux/Demuxer.ts)

Many 4K HDR files lack proper VUI signaling in container metadata. The demuxer applies intelligent heuristics:

```typescript
const isLikelyHDRResolution = width >= 3840 && height >= 2160;

if (
  isLikelyHDRResolution &&
  (currentPrimaries === "bt709" || !videoTrack.colorPrimaries)
) {
  // Trust CodecParser heuristic for 4K content
  const colorInfo = CodecParser.getColorSpaceInfo(
    codec,
    extradata,
    width,
    height,
  );
}
```

**Rationale:**

- 95%+ of 4K HEVC content is HDR (BT.2020 + PQ or HLG)
- Many encoders don't set VUI flags correctly
- Container metadata often stripped during transcoding

#### 3. Profile-Based Detection

**File:** [Demuxer.ts:257-272](../src/demux/Demuxer.ts)

For HEVC, 10-bit profiles indicate HDR:

```typescript
if (videoTrack.codec.startsWith("hvc1") && info.profile & 2) {
  // Main 10 profile → 10-bit → HDR likely
  videoTrack.colorPrimaries = "bt2020";
  videoTrack.colorTransfer = "smpte2084"; // PQ
  videoTrack.colorSpace = "bt2020-ncl";
}
```

### Color Space Values

#### Color Primaries

| Value       | Standard            | Usage                  |
| ----------- | ------------------- | ---------------------- |
| `bt709`     | ITU-T BT.709        | HDTV (1080p), SDR      |
| `bt2020`    | ITU-T BT.2020       | UHDTV (4K/8K), HDR     |
| `smpte170m` | SMPTE 170M          | NTSC (legacy)          |
| `bt470bg`   | ITU-T BT.470        | PAL (legacy)           |
| `p3`        | DCI-P3 / Display P3 | Cinema, Apple displays |

#### Transfer Characteristics

| Value          | Standard      | Usage                          |
| -------------- | ------------- | ------------------------------ |
| `bt709`        | ITU-T BT.709  | SDR (gamma 2.4 approx)         |
| `smpte2084`    | SMPTE ST 2084 | HDR10, Dolby Vision (PQ curve) |
| `arib-std-b67` | ARIB STD-B67  | HLG (Hybrid Log-Gamma)         |
| `linear`       | Linear light  | Special processing             |
| `iec61966-2-1` | IEC 61966-2-1 | sRGB (web standard)            |

#### Color Matrix

| Value        | Standard          | Usage                           |
| ------------ | ----------------- | ------------------------------- |
| `bt709`      | ITU-T BT.709      | HDTV YUV matrix                 |
| `bt2020-ncl` | ITU-T BT.2020 NCL | UHDTV non-constant luminance    |
| `bt2020-cl`  | ITU-T BT.2020 CL  | UHDTV constant luminance (rare) |
| `smpte170m`  | SMPTE 170M        | NTSC matrix                     |

---

## Usage Examples

### Basic Usage

```typescript
import { Demuxer } from "movi/demuxer";
import { HttpSource } from "movi/source";

async function playVideo(url: string) {
  // Create source and demuxer
  const source = new HttpSource(url);
  const demuxer = new Demuxer(source);

  try {
    // Open and read metadata
    const mediaInfo = await demuxer.open();
    console.log(`Duration: ${mediaInfo.duration}s`);

    // Get track information
    const videoTracks = demuxer.getVideoTracks();
    const audioTracks = demuxer.getAudioTracks();

    console.log(`Video: ${videoTracks[0].width}x${videoTracks[0].height}`);
    console.log(`Codec: ${videoTracks[0].codec}`);

    // Check HDR
    if (videoTracks[0].colorTransfer === "smpte2084") {
      console.log("HDR10 content detected!");
    }

    // Read packets
    while (true) {
      const packet = await demuxer.readPacket();
      if (!packet) break;

      // Send to decoder...
    }
  } finally {
    demuxer.close();
  }
}
```

### Multi-Track Selection

```typescript
async function selectTracks(demuxer: Demuxer) {
  const videoTracks = demuxer.getVideoTracks();
  const audioTracks = demuxer.getAudioTracks();
  const subtitleTracks = demuxer.getSubtitleTracks();

  // Select 4K track if available
  const video4K = videoTracks.find((t) => t.height >= 2160);
  const selectedVideo = video4K || videoTracks[0];

  // Select preferred language audio
  const englishAudio = audioTracks.find((t) => t.language === "eng");
  const selectedAudio = englishAudio || audioTracks[0];

  // Select subtitle track
  const englishSub = subtitleTracks.find((t) => t.language === "eng");

  console.log(`Selected tracks:
    Video: ${selectedVideo.width}x${selectedVideo.height} @ ${selectedVideo.frameRate}fps
    Audio: ${selectedAudio.codec} ${selectedAudio.channels}ch @ ${selectedAudio.sampleRate}Hz
    Subtitle: ${englishSub?.codec || "none"}
  `);
}
```

### Seeking Example

```typescript
async function seekExample(demuxer: Demuxer) {
  // Seek to 5 minutes
  await demuxer.seek(300);

  // Read packets from new position
  let packet = await demuxer.readPacket();
  console.log(`First packet after seek: ${packet?.timestamp}s`);

  // Note: FFmpeg seeks to keyframe BEFORE target
  // So packet.timestamp might be < 300
}
```

### Extradata Extraction

```typescript
import { CodecParser } from "movi/decode";

async function getCodecStrings(demuxer: Demuxer) {
  await demuxer.open();

  const videoTrack = demuxer.getVideoTracks()[0];
  const extradata = demuxer.getExtradata(videoTrack.id);

  if (extradata) {
    const codecString = CodecParser.getCodecString(videoTrack.codec, extradata);
    console.log(`WebCodecs codec string: ${codecString}`);
    // Example output: "hvc1.2.4.L153.B0"

    // Get color space info
    const colorInfo = CodecParser.getColorSpaceInfo(
      videoTrack.codec,
      extradata,
      videoTrack.width,
      videoTrack.height,
    );
    console.log(`Color space: ${JSON.stringify(colorInfo)}`);
  }
}
```

---

## Performance Considerations

### Memory Management

**WASM Memory:**

- FFmpeg allocates memory from WASM heap
- Call `demuxer.close()` to free resources
- Isolated instances (`useNewWasmInstance: true`) for thumbnails

**Packet Data:**

- Packets return `Uint8Array` views into WASM memory
- Copy data if storing for later use
- Packets become invalid after next `readPacket()` call

### Async I/O Performance

**HTTP Streaming:**

- Uses range requests for random access
- SharedArrayBuffer mode for zero-copy (when available)
- Fallback buffer mode for compatibility

**File Reading:**

- LRU cache for file chunks (default: 64 chunks)
- Chunk size: 1MB (configurable)
- Preloading for sequential reads

### Seeking Performance

- **Keyframe seeking:** Fast (index-based)
- **Non-keyframe seeking:** Slower (requires decode from last keyframe)
- **Post-seek throttle:** 200ms delay to prevent rapid seeks on low-end devices

---

## Error Handling

### Common Errors

#### 1. Failed to Open

```typescript
try {
  await demuxer.open();
} catch (error) {
  console.error("Failed to open media:", error);
  // Possible causes:
  // - Unsupported container format
  // - Corrupted file
  // - Network error (for HTTP sources)
}
```

#### 2. WASM Initialization Failure

```typescript
// Demuxer constructor may throw if WASM fails to load
try {
  const demuxer = new Demuxer(source);
  await demuxer.open();
} catch (error) {
  console.error("WASM initialization failed:", error);
  // Possible causes:
  // - WASM not supported in browser
  // - WASM binary not found
}
```

#### 3. Seek Errors

```typescript
try {
  await demuxer.seek(timestamp);
} catch (error) {
  console.error("Seek failed:", error);
  // Possible causes:
  // - Timestamp out of range
  // - Non-seekable stream (e.g., live stream)
}
```

### Error Recovery

```typescript
async function robustDemuxing(source: SourceAdapter) {
  const demuxer = new Demuxer(source);

  try {
    const info = await demuxer.open();

    let consecutiveErrors = 0;
    while (consecutiveErrors < 5) {
      try {
        const packet = await demuxer.readPacket();
        if (!packet) break; // End of stream

        // Process packet...
        consecutiveErrors = 0; // Reset on success
      } catch (error) {
        consecutiveErrors++;
        console.warn(`Packet read error (${consecutiveErrors}/5):`, error);

        if (consecutiveErrors >= 5) {
          throw new Error("Too many consecutive read errors");
        }
      }
    }
  } finally {
    demuxer.close();
  }
}
```

---

## Technical Details

### WASM Bindings

**File:** [src/wasm/bindings.ts](../src/wasm/bindings.ts)

The WasmBindings class provides a high-level TypeScript interface to the FFmpeg C API:

```typescript
class WasmBindings {
  // Context management
  create(): boolean;
  destroy(): void;

  // Data source
  setDataSource(source: DataSource): void;

  // Demuxing
  async open(): Promise<number>; // Returns stream count
  async readFrame(): Promise<FrameData>; // Returns next packet
  async seek(timestamp, streamIndex, flags): Promise<number>;

  // Metadata
  getStreamCount(): number;
  getStreamInfo(index): StreamInfo;
  getExtradata(index): Uint8Array;
  getDuration(): number;
  getStartTime(): number;
}
```

### Asyncify Integration

**Problem:** FFmpeg uses synchronous I/O, but browsers require async I/O

**Solution:** Emscripten Asyncify rewrites WASM to support async operations

**How it works:**

1. FFmpeg calls `read_packet()` callback
2. Asyncify suspends WASM execution, saves stack state
3. TypeScript performs async read from source
4. Promise resolves, Asyncify restores WASM stack
5. FFmpeg continues with data

**Performance:** ~10-20% overhead vs pure sync, but enables streaming

### Source Adapter Interface

```typescript
interface SourceAdapter {
  // Read [offset, offset+size) from source
  read(offset: number, size: number): Promise<ArrayBuffer>;

  // Get total file/stream size
  getSize(): Promise<number>;

  // Optional: prefetch data
  prefetch?(offset: number, size: number): Promise<void>;

  // Optional: destroy resources
  destroy?(): void;
}
```

**Implementations:**

- `HttpSource` - HTTP range requests
- `FileSource` - File API with LRU cache
- `ThumbnailHttpSource` - Optimized for thumbnail generation

---

## Best Practices

### 1. Always Close the Demuxer

```typescript
const demuxer = new Demuxer(source);
try {
  await demuxer.open();
  // ... use demuxer
} finally {
  demuxer.close(); // Critical: frees WASM memory
}
```

### 2. Reuse WASM Binary

```typescript
// Load once
const wasmBinary = await fetch("movi.wasm").then((r) => r.arrayBuffer());
const wasmUint8 = new Uint8Array(wasmBinary);

// Reuse for multiple demuxers
const demuxer1 = new Demuxer(source1, wasmUint8);
const demuxer2 = new Demuxer(source2, wasmUint8);
```

### 3. Handle Color Metadata

```typescript
const videoTrack = demuxer.getVideoTracks()[0];

// Simple HDR check using convenience property
console.log(`Is HDR: ${videoTrack.isHDR}`);

// Or check manually
const isHDR =
  videoTrack.colorPrimaries === "bt2020" &&
  (videoTrack.colorTransfer === "smpte2084" ||
    videoTrack.colorTransfer === "arib-std-b67");

// Configure decoder accordingly
if (videoTrack.isHDR) {
  console.log("Enable HDR rendering pipeline");
}
```

### 4. Optimize for Streaming

```typescript
// For HTTP sources, enable SharedArrayBuffer if available
const source = new HttpSource(url, {
  enableSharedArrayBuffer: true, // Zero-copy mode
  chunkSize: 1024 * 1024, // 1MB chunks
  maxCacheSize: 64 * 1024 * 1024, // 64MB cache
});
```

---

## See Also

- [Player Documentation](./PLAYER.md)
- [Codec Parser Documentation](./CODEC_PARSER.md)
- [ISO Standards Compliance](./ISO_STANDARDS_COMPLIANCE.md)
- [Source Adapters](./SOURCE_ADAPTERS.md)

---

**Last Updated:** February 5, 2026
