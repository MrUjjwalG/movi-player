# Programmatic API

Use the MoviPlayer class directly for full control over video playback.

![Custom Player UI Example](../images/custom.gif)

## Basic Setup

```typescript
import { MoviPlayer } from "movi-player/player";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const player = new MoviPlayer({
  source: { url: "video.mp4" },
  canvas: canvas,
});

// Load and play
await player.load({ url: "video.mp4" });
await player.play();
```

## Complete Example

```typescript
import { MoviPlayer } from "movi-player/player";

// Get elements
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const progressBar = document.getElementById("progress") as HTMLInputElement;
const timeDisplay = document.getElementById("time") as HTMLSpanElement;
const volumeSlider = document.getElementById("volume") as HTMLInputElement;

// Create player
const player = new MoviPlayer({
  source: { url: "video.mp4" },
  canvas: canvas,
  renderer: "canvas",
});

// Initialize
async function init() {
  try {
    const info = await player.load({ url: "video.mp4" });
    console.log(`Loaded: ${info.duration}s, ${info.tracks.length} tracks`);

    // Show video info
    const videoTrack = player.getVideoTracks()[0];
    console.log(`Video: ${videoTrack.width}x${videoTrack.height}`);
    console.log(`HDR: ${videoTrack.isHDR ? "Yes" : "No"}`);
    console.log(`Codec: ${videoTrack.codec}`);
  } catch (error) {
    console.error("Failed to load:", error);
  }
}

// Playback controls
playBtn.onclick = () => player.play();
pauseBtn.onclick = () => player.pause();

// Progress bar
player.on("timeupdate", ({ currentTime, duration }) => {
  const percent = (currentTime / duration) * 100;
  progressBar.value = String(percent);
  timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
});

progressBar.oninput = () => {
  const percent = parseFloat(progressBar.value);
  const time = (percent / 100) * player.getDuration();
  player.seek(time);
};

// Volume
volumeSlider.oninput = () => {
  player.setVolume(parseFloat(volumeSlider.value));
};

// Cleanup on page unload
window.onbeforeunload = () => {
  player.destroy();
};

// Helper
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

init();
```

## Configuration Options

```typescript
interface PlayerConfig {
  // Required
  source: SourceConfig;
  canvas: HTMLCanvasElement | OffscreenCanvas;

  // Optional
  renderer?: "canvas" | "mse"; // Default: 'canvas'
  decoder?: "auto" | "hardware" | "software"; // Default: 'auto'
  cache?: CacheConfig;
}

interface SourceConfig {
  type?: "url" | "file"; // Auto-detected if omitted
  url?: string; // HTTP(S) URL
  file?: File; // File object from input
}

interface CacheConfig {
  type?: "lru";
  maxSizeMB?: number; // Default: 100
}
```

### Example Configuration

```typescript
import { MoviPlayer, LogLevel } from "movi-player/player";

// Set log level (optional)
MoviPlayer.setLogLevel(LogLevel.ERROR);

const player = new MoviPlayer({
  source: {
    type: "url",
    url: "https://example.com/video.mp4",
  },
  canvas: document.getElementById("canvas") as HTMLCanvasElement,
  renderer: "canvas",
  decoder: "auto",
  cache: { type: "lru", maxSizeMB: 520 },
});
```

## Methods Reference

### Lifecycle

```typescript
// Load media
const info = await player.load({ url: "video.mp4" });

// Destroy and cleanup
player.destroy();
```

### Playback Control

```typescript
// Play
await player.play();

// Pause
player.pause();

// Seek to timestamp (seconds)
await player.seek(120.5);

// Set playback rate (0.25 to 4.0)
player.setPlaybackRate(1.5);

// Set loop mode
player.setLoop(true);
```

### Audio Control

```typescript
// Set volume (0.0 to 1.0)
player.setVolume(0.5);

// Mute/Unmute
player.mute();
player.unmute();
```

### State Queries

```typescript
// Current time in seconds
const time = player.getCurrentTime();

// Total duration
const duration = player.getDuration();

// Player state
const state = player.getState();
// 'idle' | 'loading' | 'ready' | 'playing' | 'seeking' | 'ended' | 'error'

// Boolean checks
const isPaused = player.isPaused();
const isLooping = player.isLooping();
const isMuted = player.isMuted();
const volume = player.getVolume();
const rate = player.getPlaybackRate();
```

### Track Management

```typescript
// Get all tracks
const tracks = player.getTracks();

// Get by type
const videoTracks = player.getVideoTracks();
const audioTracks = player.getAudioTracks();
const subtitleTracks = player.getSubtitleTracks();

// Select tracks
player.selectVideoTrack(trackId);
player.selectAudioTrack(trackId);
player.selectSubtitleTrack(trackId); // or null to disable
```

### Thumbnail Generation

```typescript
// Generate thumbnail at timestamp
const blob = await player.generatePreview(60, 320, 180);
const url = URL.createObjectURL(blob);
imgElement.src = url;
```

## Events

```typescript
// Lifecycle events
player.on("loadStart", () => console.log("Loading..."));
player.on("loadEnd", () => console.log("Loaded!"));
player.on("durationChange", (duration) => console.log("Duration:", duration));

// State changes
player.on("stateChange", (state) => {
  console.log("State:", state);
  // States: 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'seeking' | 'ended' | 'error'
});

// Errors
player.on("error", (error) => console.error("Error:", error));

// Unsubscribe
const handler = () => console.log("State changed");
player.on("stateChange", handler);
player.off("stateChange", handler);
```

### State Values

| State       | Description               |
| ----------- | ------------------------- |
| `idle`      | Initial state, not loaded |
| `loading`   | Loading media             |
| `playing`   | Active playback           |
| `paused`    | Paused                    |
| `buffering` | Buffering data            |
| `seeking`   | Seeking to position       |
| `ended`     | Playback finished         |
| `error`     | Error occurred            |

## Multi-Track Audio Example

```typescript
import { MoviPlayer } from "movi-player/player";

async function setupMultiAudio() {
  const player = new MoviPlayer({
    source: { url: "multi-audio.mkv" },
    canvas: document.getElementById("canvas") as HTMLCanvasElement,
  });

  await player.load({ url: "multi-audio.mkv" });

  // Get audio tracks
  const audioTracks = player.getAudioTracks();
  console.log("Available audio tracks:", audioTracks);
  // [
  //   { id: 1, language: 'eng', title: 'English', codec: 'aac' },
  //   { id: 2, language: 'jpn', title: 'Japanese', codec: 'aac' },
  //   { id: 3, language: 'spa', title: 'Spanish', codec: 'aac' }
  // ]

  // Create audio selector
  const selector = document.getElementById("audioTrack") as HTMLSelectElement;

  audioTracks.forEach((track) => {
    const option = document.createElement("option");
    option.value = String(track.id);
    option.textContent = `${track.language} - ${track.title || track.codec}`;
    selector.appendChild(option);
  });

  // Handle selection change
  selector.onchange = () => {
    const trackId = parseInt(selector.value);
    player.selectAudioTrack(trackId);
    console.log("Switched to audio track:", trackId);
  };

  await player.play();
}
```

## Subtitle Example

```typescript
async function setupSubtitles() {
  const player = new MoviPlayer({
    source: { url: "video-with-subs.mkv" },
    canvas: document.getElementById("canvas") as HTMLCanvasElement,
  });

  await player.load({ url: "video-with-subs.mkv" });

  const subtitleTracks = player.getSubtitleTracks();
  console.log("Subtitles:", subtitleTracks);
  // [
  //   { id: 3, language: 'eng', title: 'English', codec: 'subrip' },
  //   { id: 4, language: 'spa', title: 'Spanish', codec: 'subrip' }
  // ]

  // Enable English subtitles
  const englishSub = subtitleTracks.find((t) => t.language === "eng");
  if (englishSub) {
    player.selectSubtitleTrack(englishSub.id);
  }

  // Disable subtitles
  // player.selectSubtitleTrack(null);
}
```

## HDR Detection Example

```typescript
async function checkHDR() {
  const player = new MoviPlayer({
    source: { url: "hdr-video.mp4" },
    canvas: document.getElementById("canvas") as HTMLCanvasElement,
  });

  await player.load({ url: "hdr-video.mp4" });

  const videoTrack = player.getVideoTracks()[0];

  console.log("Video Info:");
  console.log(`  Resolution: ${videoTrack.width}x${videoTrack.height}`);
  console.log(`  Codec: ${videoTrack.codec}`);
  console.log(`  HDR: ${videoTrack.isHDR ? "Yes" : "No"}`);

  if (videoTrack.isHDR) {
    console.log(`  Color Primaries: ${videoTrack.colorPrimaries}`);
    console.log(`  Transfer: ${videoTrack.colorTransfer}`);
    console.log(`  Matrix: ${videoTrack.colorSpace}`);

    // Determine HDR format
    if (videoTrack.colorTransfer === "smpte2084") {
      console.log("  Format: HDR10 (PQ)");
    } else if (videoTrack.colorTransfer === "arib-std-b67") {
      console.log("  Format: HLG");
    }
  }
}
```

## Progress Bar with Thumbnails

```typescript
async function setupProgressWithThumbnails() {
  const player = new MoviPlayer({
    source: { url: "video.mp4" },
    canvas: document.getElementById("canvas") as HTMLCanvasElement,
    enablePreviews: true, // Enable thumbnail generation
  });

  await player.load({ url: "video.mp4" });

  const progressBar = document.getElementById("progress") as HTMLInputElement;
  const thumbnail = document.getElementById("thumbnail") as HTMLImageElement;
  const thumbnailContainer = document.getElementById(
    "thumbnailContainer",
  ) as HTMLDivElement;

  let thumbnailTimeout: number;

  progressBar.onmousemove = async (e) => {
    const rect = progressBar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const time = percent * player.getDuration();

    // Position thumbnail
    thumbnailContainer.style.left = `${e.clientX}px`;
    thumbnailContainer.style.display = "block";

    // Debounce thumbnail generation
    clearTimeout(thumbnailTimeout);
    thumbnailTimeout = window.setTimeout(async () => {
      try {
        const blob = await player.generatePreview(time, 160, 90);
        thumbnail.src = URL.createObjectURL(blob);
      } catch (e) {
        // Ignore errors during rapid mouse movement
      }
    }, 100);
  };

  progressBar.onmouseleave = () => {
    thumbnailContainer.style.display = "none";
    clearTimeout(thumbnailTimeout);
  };
}
```

## Error Handling

```typescript
const player = new MoviPlayer({
  source: { url: "video.mp4" },
  canvas: document.getElementById("canvas") as HTMLCanvasElement,
});

player.on("error", (error) => {
  console.error("Player error:", error);

  // Show user-friendly message
  if (error.message.includes("network")) {
    showError("Network error. Please check your connection.");
  } else if (error.message.includes("codec")) {
    showError("Unsupported video format.");
  } else {
    showError("Playback error. Please try again.");
  }
});

try {
  await player.load({ url: "video.mp4" });
  await player.play();
} catch (error) {
  console.error("Failed to start playback:", error);
}
```

## Memory Management

```typescript
// Always destroy player when done
function cleanup() {
  if (player) {
    player.pause();
    player.destroy();
    player = null;
  }
}

// React useEffect cleanup
useEffect(() => {
  const player = new MoviPlayer({ ... });

  return () => {
    player.destroy();
  };
}, []);

// Page navigation
window.addEventListener('beforeunload', cleanup);

// SPA route change
router.beforeEach(() => {
  cleanup();
});
```
