# Player Documentation

**Movi Streaming Video Library - Player Component**

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [API Reference](#api-reference)
4. [Configuration](#configuration)
5. [Playback Control](#playback-control)
6. [Track Management](#track-management)
7. [Events](#events)
8. [A/V Synchronization](#av-synchronization)
9. [Usage Examples](#usage-examples)
10. [Performance](#performance)
11. [Troubleshooting](#troubleshooting)

---

## Overview

The MoviPlayer is the main orchestrator component that coordinates:

- **Source Management:** HTTP/File data streaming
- **Demuxing:** Container parsing and packet extraction
- **Decoding:** Video/Audio/Subtitle decoding (hardware + software fallback)
- **Rendering:** Canvas (WebGL2) and Audio (Web Audio API) output
- **Synchronization:** Audio-master A/V sync with frame-perfect timing
- **State Management:** Playback state machine with error recovery

**Key File:** [src/core/MoviPlayer.ts](../src/core/MoviPlayer.ts)

### Key Features

✅ **Hardware-First Decoding:** WebCodecs with automatic software fallback
✅ **Pull-Based Streaming:** Memory-efficient, handles multi-GB files
✅ **HDR Support:** BT.2020/PQ/HLG with Display-P3 rendering
✅ **Multi-Track:** Runtime audio/video/subtitle track switching
✅ **Intelligent Seeking:** Keyframe-based with post-seek throttling
✅ **Preview Generation:** Isolated WASM instance for thumbnails
✅ **Wake Lock:** Prevents screen sleep during playback

---

## Architecture

### Component Hierarchy

```
┌────────────────────────────────────────────────────────────┐
│                      MoviPlayer                            │
│                   (EventEmitter Core)                      │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │ HttpSource / │──>│   Demuxer    │──>│ TrackManager │    │
│  │  FileSource  │   │   (FFmpeg)   │   │              │    │
│  └──────────────┘   └──────────────┘   └──────────────┘    │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Decoding Pipeline                       │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  MoviVideoDecoder   MoviAudioDecoder   SubtitleDec   │  │
│  │  (WebCodecs→SW)     (WebCodecs→SW)     (Text/Image)  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Rendering Pipeline                      │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  CanvasRenderer           AudioRenderer              │  │
│  │  (WebGL2 + P3)           (Web Audio API)             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │    Clock     │   │  StateManager│   │  WakeLock    │    │
│  │  (A/V Sync)  │   │ (FSM + Error)│   │  (Screen)    │    │
│  └──────────────┘   └──────────────┘   └──────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Data Flow

```
HTTP/File → Source → Demuxer → Packets → Decoders → Frames → Renderers → Output
                        ↓                    ↑
                   TrackManager          Clock (A/V Sync)
                        ↓                    ↓
                   StreamIndex           Audio Master
```

---

## API Reference

### Constructor

```typescript
constructor(config: PlayerConfig)
```

**Parameters:**

```typescript
interface PlayerConfig {
  source: SourceConfig; // Required: { url: string } or { file: File }
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  renderer?: RendererType; // 'canvas' | 'mse'
  decoder?: DecoderType; // 'hardware' | 'software'
  cache?: CacheConfig; // { maxSizeMB: number }
  wasmBinary?: Uint8Array; // Pre-loaded WASM binary
  enablePreviews?: boolean; // Enable thumbnail generation
}
```

**Example:**

```typescript
import { MoviPlayer } from "movi/player";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const player = new MoviPlayer({
  source: { url: "video.mp4" },
  canvas: canvas,
  renderer: "canvas",
});
```

---

### Methods

#### `load(config: SourceConfig): Promise<MediaInfo>`

Loads a media source and initializes playback pipeline.

**Parameters:**

```typescript
interface SourceConfig {
  url?: string; // HTTP(S) URL
  file?: File; // File object from input
  type?: "http" | "file"; // Auto-detected if omitted
  wasmBinary?: Uint8Array; // Optional pre-loaded WASM
}
```

**Returns:** MediaInfo with tracks, duration, and format details

**Example:**

```typescript
const info = await player.load({
  url: "https://example.com/video.mp4",
});

console.log(`Loaded: ${info.duration}s, ${info.tracks.length} tracks`);
```

---

#### `play(): Promise<void>`

Starts playback from current position.

**Behavior:**

- Acquires wake lock (prevents screen sleep)
- Starts demuxing loop
- Begins rendering at 60Hz
- Returns when playback starts (not when it ends)

**Example:**

```typescript
await player.play();
console.log("Playback started");
```

---

#### `pause(): void`

Pauses playback immediately.

**Behavior:**

- Stops demuxing loop
- Releases wake lock
- Preserves current time
- Keeps last frame visible

---

#### `seek(timestamp: number): Promise<void>`

Seeks to a specific timestamp.

**Parameters:**

- `timestamp` - Target time in seconds (must be ≥ 0 and ≤ duration)

**Behavior:**

- Seeks demuxer to nearest keyframe before timestamp
- Flushes video/audio decoders
- Skips packets until reaching target time
- Post-seek throttle (200ms) prevents rapid seeks

**Example:**

```typescript
await player.seek(120.5); // Seek to 2:00.5
console.log(`Seeked to: ${player.getCurrentTime()}s`);
```

**Note:** Actual position after seek may be slightly before target due to keyframe alignment.

---

#### `setPlaybackRate(rate: number): void`

Adjusts playback speed.

**Parameters:**

- `rate` - Speed multiplier (0.25 to 4.0 recommended)
  - `0.5` = half speed
  - `1.0` = normal speed (default)
  - `2.0` = double speed

**Example:**

```typescript
player.setPlaybackRate(1.5); // 1.5x speed
```

---

#### `setVolume(volume: number): void`

Sets audio volume.

**Parameters:**

- `volume` - Volume level (0.0 to 1.0)
  - `0.0` = muted
  - `1.0` = maximum (default)

**Example:**

```typescript
player.setVolume(0.5); // 50% volume
```

---

#### `mute(): void` / `unmute(): void`

Mutes or unmutes audio without changing volume level.

---

#### `setLoop(loop: boolean): void`

Enables or disables loop mode.

**Behavior:**

- When enabled, playback restarts from beginning when reaching end
- Fires `looped` event on each restart

---

#### `destroy(): void`

Destroys the player and releases all resources.

**Behavior:**

- Closes demuxer (frees WASM memory)
- Destroys decoders
- Clears frame queues
- Releases wake lock
- Removes all event listeners

**Important:** Always call this before removing player instance.

```typescript
player.destroy();
```

---

### Getters

#### `getCurrentTime(): number`

Returns current playback position in seconds.

---

#### `getDuration(): number`

Returns total media duration in seconds.

---

#### `getState(): PlayerState`

Returns current player state.

```typescript
type PlayerState =
  | "idle" // Not loaded
  | "loading" // Loading source
  | "ready" // Loaded, paused
  | "playing" // Active playback
  | "seeking" // Seeking in progress
  | "ended" // Playback finished
  | "error"; // Error occurred
```

---

#### `isPaused(): boolean`

Returns true if player is paused.

---

#### `isLooping(): boolean`

Returns true if loop mode is enabled.

---

#### `getVolume(): number`

Returns current volume (0.0 to 1.0).

---

#### `isMuted(): boolean`

Returns true if audio is muted.

---

#### `getPlaybackRate(): number`

Returns current playback rate multiplier.

---

#### `getMediaInfo(): MediaInfo | null`

Returns media metadata (null if not loaded).

---

#### `getTracks(): Track[]`

Returns all tracks (video, audio, subtitle).

---

#### `getVideoTracks(): VideoTrack[]`

Returns video tracks only.

---

#### `getAudioTracks(): AudioTrack[]`

Returns audio tracks only.

---

#### `getSubtitleTracks(): SubtitleTrack[]`

Returns subtitle tracks only.

---

### Track Selection

#### `selectVideoTrack(trackId: number): void`

Switches to a different video track.

**Use Cases:**

- Multi-quality video (480p, 720p, 1080p, 4K)
- Multi-angle video
- Different codec variants

**Example:**

```typescript
const tracks = player.getVideoTracks();
const track4K = tracks.find((t) => t.height >= 2160);
if (track4K) {
  player.selectVideoTrack(track4K.id);
}
```

---

#### `selectAudioTrack(trackId: number): void`

Switches to a different audio track.

**Use Cases:**

- Multi-language audio
- Different audio codecs
- Surround sound vs stereo

**Example:**

```typescript
const tracks = player.getAudioTracks();
const english = tracks.find((t) => t.language === "eng");
if (english) {
  player.selectAudioTrack(english.id);
}
```

---

#### `selectSubtitleTrack(trackId: number | null): void`

Enables a subtitle track or disables subtitles.

**Parameters:**

- `trackId` - Track ID to enable, or `null` to disable

**Example:**

```typescript
const tracks = player.getSubtitleTracks();
const spanish = tracks.find((t) => t.language === "spa");
if (spanish) {
  player.selectSubtitleTrack(spanish.id);
}

// Disable subtitles
player.selectSubtitleTrack(null);
```

---

### Preview Generation

#### `generatePreview(timestamp: number, width?: number, height?: number): Promise<Blob>`

Generates a thumbnail image at a specific timestamp.

**Parameters:**

- `timestamp` - Time in seconds
- `width` - Optional width (default: video width / 4)
- `height` - Optional height (default: video height / 4)

**Returns:** JPEG image blob

**Features:**

- Uses isolated WASM instance (no interference with playback)
- Software decoding only (faster for single frames)
- Automatic cleanup after generation

**Example:**

```typescript
const thumbnail = await player.generatePreview(60, 320, 180);
const url = URL.createObjectURL(thumbnail);
imgElement.src = url;
```

---

## Configuration

### Player Config Options

```typescript
interface PlayerConfig {
  // Required
  source: SourceConfig; // { url: string } or { file: File }

  // Optional
  canvas?: HTMLCanvasElement | OffscreenCanvas; // Canvas for rendering
  renderer?: RendererType; // 'canvas' | 'mse' (default: 'canvas')
  decoder?: DecoderType; // 'hardware' | 'software' (default: 'hardware')
  cache?: CacheConfig; // { maxSizeMB: number } (default: 100MB)
  wasmBinary?: Uint8Array; // Pre-loaded WASM binary
  enablePreviews?: boolean; // Enable thumbnail generation (default: false)
}
```

---

## Playback Control

### State Machine

```
     ┌──────┐
     │ idle │
     └───┬──┘
         │ load()
         ▼
    ┌─────────┐
    │ loading │
    └────┬────┘
         │ success
         ▼
      ┌──────┐  play()  ┌─────────┐
      │ready │◄─────────┤ playing │
      └──┬───┘  pause()  └────┬────┘
         │                    │ end
         │ seek()             ▼
         ├────────>┌─────────┐
         │         │ seeking │
         │         └────┬────┘
         │              │ complete
         └──────────────┘
              │ error
              ▼
         ┌───────┐
         │ error │
         └───────┘
```

### Playback Loop

The player runs an internal `requestAnimationFrame` loop:

1. **Check State:** Skip if paused/seeking
2. **Read Packets:** Demux next video/audio/subtitle packets
3. **Decode:** Send packets to appropriate decoders
4. **Buffer Management:** Apply back-pressure if buffers full
5. **Frame Presentation:** Renderer handles timing
6. **Repeat:** Until paused or ended

---

## Track Management

### Multi-Track Architecture

**File:** [src/core/TrackManager.ts](../src/core/TrackManager.ts)

**Features:**

- Runtime track switching without rebuffering
- Automatic selection (first video/audio, no subtitle)
- Track filtering by type, language, codec

### Track Selection Strategy

```typescript
class TrackManager {
  // Default selection on load
  autoSelectTracks() {
    this.selectedVideoTrack = videoTracks[0];
    this.selectedAudioTrack = audioTracks[0];
    this.selectedSubtitleTrack = null; // Disabled by default
  }

  // User selection
  selectVideoTrack(trackId: number) {
    // Flush current video decoder
    // Switch to new track
    // Continue playback seamlessly
  }
}
```

---

## Events

The player extends `EventEmitter` and fires standard media events:

### Event Types

```typescript
interface PlayerEventMap {
  // Lifecycle
  loadstart: void;
  loadedmetadata: MediaInfo;
  canplay: void;
  play: void;
  pause: void;
  ended: void;

  // Time updates
  timeupdate: { currentTime: number; duration: number };
  seeking: number;
  seeked: number;

  // State changes
  statechange: PlayerState;

  // Looping
  looped: void;

  // Errors
  error: Error;

  // Rendering (advanced)
  frame: VideoFrame;
  audio: Float32Array;
  subtitle: SubtitleCue;
}
```

### Event Subscription

```typescript
// Single event
player.on("play", () => {
  console.log("Playback started");
});

// Time updates (fires at ~10Hz during playback)
player.on("timeupdate", ({ currentTime, duration }) => {
  console.log(`${currentTime}s / ${duration}s`);
  updateProgressBar(currentTime / duration);
});

// Error handling
player.on("error", (error) => {
  console.error("Playback error:", error);
  showErrorMessage(error.message);
});

// Unsubscribe
const handler = () => console.log("Paused");
player.on("pause", handler);
player.off("pause", handler);
```

---

## A/V Synchronization

### Audio-Master Sync Model

**File:** [src/core/Clock.ts](../src/core/Clock.ts)

**Principle:** Audio is the master clock, video syncs to audio

**Why Audio-Master?**

- Audio glitches are **very noticeable** (pops, clicks)
- Video frame drops are **less noticeable** (smooth motion blur)
- Web Audio API provides high-precision timing

### Sync Implementation

```typescript
class Clock {
  // Get current playback time from audio renderer
  getTime(): number {
    if (this.audioRenderer.isHealthy()) {
      return this.audioRenderer.getAudioClock();
    }
    // Fallback to wall clock if audio unhealthy
    return this.wallClockTime;
  }
}
```

**CanvasRenderer Sync:**

```typescript
presentFrame() {
  const audioTime = this.getAudioTime();
  const frame = this.frameQueue[0];

  if (frame.timestamp <= audioTime) {
    // Audio ahead or in sync → present frame
    this.renderFrame(frame);
    this.frameQueue.shift();
  } else {
    // Video ahead → wait for audio to catch up
    // Check again next RAF
  }
}
```

### Sync Modes

1. **Loose Sync (Default)**
   - Video uses wall clock for smooth presentation
   - Periodic corrections from audio clock
   - ±50ms tolerance before correction

2. **Tight Sync (Optional)**
   - Every frame checked against audio time
   - More accurate, may cause frame drops

### Buffer Health

**Video Buffer:** 120 frames (~2s at 60fps, ~4s at 30fps)
**Audio Buffer:** 2 seconds of audio

If buffers drain:

- Player enters buffering state
- Playback pauses until buffers refill
- Fires `buffering` event (if implemented)

---

## Usage Examples

### Basic Playback

```typescript
import { MoviPlayer } from "movi/player";

const canvas = document.getElementById("myCanvas") as HTMLCanvasElement;
const player = new MoviPlayer({
  source: { url: "https://example.com/video.mp4" },
  canvas: canvas,
  renderer: "canvas",
});

// Load and play
async function playVideo() {
  try {
    const info = await player.load({ url: "https://example.com/video.mp4" });
    console.log(`Loaded: ${info.duration}s`);

    await player.play();
  } catch (error) {
    console.error("Failed to play:", error);
  }
}

playVideo();
```

---

### Progress Bar

```typescript
const progressBar = document.getElementById("progress") as HTMLInputElement;
const timeDisplay = document.getElementById("time") as HTMLSpanElement;

player.on("timeupdate", ({ currentTime, duration }) => {
  const percent = (currentTime / duration) * 100;
  progressBar.value = percent.toString();

  const current = formatTime(currentTime);
  const total = formatTime(duration);
  timeDisplay.textContent = `${current} / ${total}`;
});

progressBar.addEventListener("input", () => {
  const percent = parseFloat(progressBar.value);
  const duration = player.getDuration();
  const timestamp = (percent / 100) * duration;
  player.seek(timestamp);
});

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

---

### Multi-Language Audio

```typescript
async function setupAudioTracks() {
  await player.load({ url });

  const audioTracks = player.getAudioTracks();
  const selector = document.getElementById("audioTrack") as HTMLSelectElement;

  // Populate dropdown
  audioTracks.forEach((track) => {
    const option = document.createElement("option");
    option.value = track.id.toString();
    option.textContent = `${track.language || "Unknown"} (${track.codec})`;
    selector.appendChild(option);
  });

  // Handle selection
  selector.addEventListener("change", () => {
    const trackId = parseInt(selector.value);
    player.selectAudioTrack(trackId);
  });
}
```

---

### HDR Detection

```typescript
async function checkHDR() {
  await player.load({ url });

  const videoTrack = player.getVideoTracks()[0];
  const isHDR =
    videoTrack.colorPrimaries === "bt2020" &&
    (videoTrack.colorTransfer === "smpte2084" || // HDR10
      videoTrack.colorTransfer === "arib-std-b67"); // HLG

  if (isHDR) {
    console.log("HDR content detected!");
    console.log(`Transfer: ${videoTrack.colorTransfer}`);
    console.log(`Primaries: ${videoTrack.colorPrimaries}`);
  }
}
```

---

### Thumbnail Generation

```typescript
async function generateThumbnails(url: string, count: number) {
  const player = new MoviPlayer({ canvas });
  await player.load({ url });

  const duration = player.getDuration();
  const interval = duration / (count + 1);

  const thumbnails: Blob[] = [];
  for (let i = 1; i <= count; i++) {
    const timestamp = interval * i;
    const thumbnail = await player.generatePreview(timestamp, 160, 90);
    thumbnails.push(thumbnail);
  }

  player.destroy();
  return thumbnails;
}

// Usage
const thumbs = await generateThumbnails("video.mp4", 10);
thumbs.forEach((blob, i) => {
  const img = document.createElement("img");
  img.src = URL.createObjectURL(blob);
  document.body.appendChild(img);
});
```

---

## Performance

### Hardware Decoding

**WebCodecs API** provides access to platform hardware decoders:

**Supported Codecs (hardware):**

- H.264/AVC (all platforms)
- H.265/HEVC (macOS, Windows, Android)
- VP9 (Chrome, Edge)
- AV1 (modern browsers)

**Fallback:**
If hardware fails, player automatically switches to software decoding (FFmpeg WASM).

### Memory Usage

**Typical 4K HEVC Playback:**

- WASM heap: ~50MB
- Video frame queue: ~120 frames × ~12MB = ~1.4GB (YUV 4:2:0)
- Audio buffer: ~2s × 48kHz × 2ch × 4B = ~384KB
- **Total: ~1.5GB** (mostly video frames)

**Optimization:**

- Frame queue size adapts to frame rate
- Decoder buffer limits prevent overflow
- Back-pressure stops demuxing when buffers full

### Seeking Performance

**Keyframe Seeking:**

- **Fast:** 100-300ms (index-based)
- Used for most seeks

**Non-Keyframe Seeking:**

- **Slower:** 500-2000ms (decode from last keyframe)
- Rare (only when seeking to exact timestamp)

**Post-Seek Throttle:**

- 200ms delay prevents rapid seeks
- Improves UX on low-end devices

---

## Troubleshooting

### Video Not Playing

**Check:**

1. Codec support: `await navigator.mediaCapabilities.decodingInfo(...)`
2. Browser compatibility: WebCodecs requires Chrome 94+, Edge 94+, Safari 16.4+
3. CORS headers: Cross-origin videos need `Access-Control-Allow-Origin`

**Debug:**

```typescript
player.on("error", (error) => {
  console.error("Error details:", error);
  console.log("Current state:", player.getState());
  console.log("Media info:", player.getMediaInfo());
});
```

---

### Audio/Video Out of Sync

**Causes:**

- Decoder lag (software decode of 4K)
- Buffer underrun
- Incorrect PTS in source file

**Debug:**

```typescript
player.on("frame", (frame) => {
  const audioClock = audioRenderer.getAudioClock();
  const drift = frame.timestamp - audioClock;
  console.log(`A/V drift: ${drift * 1000}ms`);
});
```

**Fix:**

- Enable hardware decoding
- Reduce quality (lower resolution track)
- Increase buffer sizes

---

### High Memory Usage

**Causes:**

- Large frame queue for 4K/8K
- Memory leak (frames not closed)

**Fix:**

```typescript
// Reduce frame queue (edit CanvasRenderer)
private static readonly MAX_FRAME_QUEUE = 60; // Default: 120

// Ensure player destroyed when done
window.addEventListener('beforeunload', () => {
  player.destroy();
});
```

---

### Seeking is Slow

**Causes:**

- Non-seekable stream (no index)
- Large GOP size (keyframes far apart)

**Workaround:**

```typescript
// Show loading indicator during seek
player.on("seeking", () => {
  showLoadingSpinner();
});

player.on("seeked", () => {
  hideLoadingSpinner();
});
```

---

## Best Practices

### 1. Always Destroy Player

```typescript
// React example
useEffect(() => {
  const player = new MoviPlayer({ canvas });

  return () => {
    player.destroy(); // Cleanup on unmount
  };
}, []);
```

### 2. Handle Errors Gracefully

```typescript
player.on("error", async (error) => {
  console.error("Playback error:", error);

  // Try recovery
  try {
    await player.seek(0);
    await player.play();
  } catch {
    showErrorMessage("Playback failed");
  }
});
```

### 3. Optimize for Mobile

```typescript
// Detect mobile and reduce quality
const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);

if (isMobile) {
  const tracks = player.getVideoTracks();
  const sdTrack = tracks.find((t) => t.height <= 720);
  if (sdTrack) {
    player.selectVideoTrack(sdTrack.id);
  }
}
```

---

## See Also

- [Demuxer Documentation](./demuxer.md)
- [Video Element Documentation](./element.md)
- [ISO Standards Compliance](../guide/standards.md)

---

**Last Updated:** February 5, 2026
