# Video Element Documentation

**Movi Streaming Video Library - Custom HTML Video Element**

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [API Reference](#api-reference)
4. [Attributes](#attributes)
5. [Properties](#properties)
6. [Methods](#methods)
7. [Events](#events)
8. [UI Controls](#ui-controls)
9. [Gestures](#gestures)
10. [Theming](#theming)
11. [Advanced Features](#advanced-features)
12. [Examples](#examples)

---

## Overview

The `<movi-player>` custom HTML element provides a native `<video>`-like interface with enhanced capabilities:

- **Drop-in Replacement:** Compatible with standard HTMLVideoElement API
- **Built-in Controls:** Professional UI with play, progress, volume, settings
- **Gesture Support:** Touch-friendly with tap, swipe, pinch gestures
- **HDR Support:** Automatic HDR detection and Display-P3 rendering
- **Theme System:** Dark/Light modes with customizable styling
- **Ambient Mode:** Extracts and displays average frame colors
- **Track Selection:** Multi-audio/subtitle track selection UI
- **Object Fit Modes:** contain/cover/fill/zoom with smooth transitions

**Key File:** [src/render/MoviElement.ts](../src/render/MoviElement.ts)

### Browser Compatibility

| Browser | Version | Notes                              |
| ------- | ------- | ---------------------------------- |
| Chrome  | 94+     | Full support (WebCodecs)           |
| Edge    | 94+     | Full support                       |
| Safari  | 16.4+   | Full support                       |
| Firefox | ❌      | No WebCodecs yet (Q2 2026 planned) |

---

## Quick Start

### Installation

```bash
npm install movi
```

### Basic Usage

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module">
      import "movi";
    </script>
  </head>
  <body>
    <movi-player
      src="https://example.com/video.mp4"
      controls
      autoplay
      muted
      style="width: 100%; height: 500px;"
    ></movi-player>
  </body>
</html>
```

That's it! The element works just like a native `<video>` tag.

---

## API Reference

### Element Registration

The custom element is automatically registered on import:

```typescript
import "movi"; // Registers <movi-player>
```

**Element Name:** `movi-player` (hyphen required per Web Components spec)

---

## Attributes

### Media Source

#### `src`

Specifies the video source URL or File object.

```html
<!-- HTTP URL -->
<movi-player src="https://example.com/video.mp4"></movi-player>

<!-- Local file via JavaScript -->
<movi-player id="player"></movi-player>
<script>
  const player = document.getElementById("player");
  const fileInput = document.getElementById("file");
  fileInput.addEventListener("change", (e) => {
    player.src = e.target.files[0];
  });
</script>
```

**Supported Formats:**

- MP4 (`.mp4`, `.m4v`)
- WebM (`.webm`)
- Matroska (`.mkv`)
- QuickTime (`.mov`)
- MPEG-TS (`.ts`)
- Any FFmpeg-supported format

---

### Playback Behavior

#### `autoplay`

Starts playback automatically when loaded.

```html
<movi-player src="video.mp4" autoplay></movi-player>
```

**Note:** Most browsers require `muted` attribute for autoplay to work.

---

#### `loop`

Restarts playback when video ends.

```html
<movi-player src="video.mp4" loop></movi-player>
```

---

#### `muted`

Mutes audio by default.

```html
<movi-player src="video.mp4" muted></movi-player>
```

---

#### `playsinline`

Prevents fullscreen on iOS (plays inline instead).

```html
<movi-player src="video.mp4" playsinline></movi-player>
```

---

### UI Configuration

#### `controls`

Shows/hides the built-in UI controls.

```html
<!-- With controls -->
<movi-player src="video.mp4" controls></movi-player>

<!-- Without controls (custom UI) -->
<movi-player src="video.mp4"></movi-player>
```

---

#### `poster`

Displays an image before playback starts.

```html
<movi-player src="video.mp4" poster="thumbnail.jpg"></movi-player>
```

---

### Advanced Attributes

#### `renderer`

Chooses the rendering backend.

**Values:**

- `canvas` (default) - WebGL2 canvas rendering with full features
- `mse` - Media Source Extensions via HLS.js (for compatibility)

```html
<movi-player src="video.mp4" renderer="canvas"></movi-player>
```

**When to use MSE:**

- Browser lacks WebCodecs support
- Need native media controls
- Simpler integration with existing MSE infrastructure

---

#### `objectfit`

Controls how video fills the canvas.

**Values:**

- `contain` (default) - Fit within bounds, maintain aspect ratio
- `cover` - Fill bounds, crop if necessary
- `fill` - Stretch to fill bounds (may distort)
- `zoom` - Slightly zoomed in (1.1x)
- `control` - User can pinch/zoom to adjust

```html
<movi-player src="video.mp4" objectfit="cover"></movi-player>
```

---

#### `hdr`

Enables/disables HDR rendering.

```html
<!-- HDR enabled (default) -->
<movi-player src="video.mp4" hdr></movi-player>

<!-- Force SDR -->
<movi-player src="video.mp4" hdr="false"></movi-player>
```

**Auto-Detection:**

- BT.2020 primaries + PQ/HLG transfer → Display-P3 canvas
- Otherwise → sRGB canvas

---

#### `theme`

Sets the UI theme.

**Values:**

- `dark` (default)
- `light`

```html
<movi-player src="video.mp4" theme="light"></movi-player>
```

---

#### `ambientmode`

Enables ambient background effects.

```html
<movi-player src="video.mp4" ambientmode></movi-player>
```

**Effect:** Samples average frame colors and applies to wrapper element.

---

#### `ambientwrapper`

Specifies external element for ambient effects.

```html
<div id="wrapper" style="padding: 20px; transition: background 0.5s;">
  <movi-player
    src="video.mp4"
    ambientmode
    ambientwrapper="wrapper"
  ></movi-player>
</div>
```

---

#### `thumb`

Generates thumbnails on demand (used internally for preview).

```html
<movi-player src="video.mp4" thumb></movi-player>
```

---

### Standard HTML Attributes

#### `width` / `height`

Sets element dimensions (CSS preferred).

```html
<movi-player src="video.mp4" width="800" height="450"></movi-player>
```

---

#### `preload`

Hints how much data to buffer initially.

**Values:**

- `none` - Don't preload
- `metadata` (default) - Load metadata only
- `auto` - Buffer as much as possible

```html
<movi-player src="video.mp4" preload="auto"></movi-player>
```

---

#### `crossorigin`

CORS mode for cross-origin videos.

**Values:**

- `anonymous` - No credentials
- `use-credentials` - Include credentials

```html
<movi-player
  src="https://cdn.example.com/video.mp4"
  crossorigin="anonymous"
></movi-player>
```

---

## Properties

### Media Properties

#### `src: string | File | null`

Gets/sets the media source.

```typescript
const player = document.querySelector("movi-player");

// Set URL
player.src = "https://example.com/video.mp4";

// Set File
player.src = fileObject;

// Get current source
console.log(player.src);
```

---

#### `currentTime: number`

Gets/sets current playback position (in seconds).

```typescript
// Get position
console.log(player.currentTime); // 45.2

// Seek to position
player.currentTime = 120.5;
```

---

#### `duration: number` (read-only)

Total media duration in seconds.

```typescript
console.log(`Duration: ${player.duration}s`);
```

---

#### `paused: boolean` (read-only)

True if playback is paused.

```typescript
if (player.paused) {
  console.log("Video is paused");
}
```

---

#### `ended: boolean` (read-only)

True if playback has reached the end.

```typescript
if (player.ended) {
  console.log("Video finished");
}
```

---

### Audio Properties

#### `volume: number`

Gets/sets audio volume (0.0 to 1.0).

```typescript
player.volume = 0.5; // 50% volume
```

---

#### `muted: boolean`

Gets/sets mute state.

```typescript
player.muted = true; // Mute
```

---

### Playback Control

#### `playbackRate: number`

Gets/sets playback speed multiplier.

```typescript
player.playbackRate = 1.5; // 1.5x speed
player.playbackRate = 0.5; // Half speed
```

---

#### `loop: boolean`

Gets/sets loop mode.

```typescript
player.loop = true; // Enable looping
```

---

### UI Properties

#### `controls: boolean`

Gets/sets whether controls are visible.

```typescript
player.controls = true; // Show controls
```

---

#### `poster: string`

Gets/sets poster image URL.

```typescript
player.poster = "thumbnail.jpg";
```

---

## Methods

### Playback Control

#### `play(): Promise<void>`

Starts playback.

```typescript
await player.play();
console.log("Playing");
```

**Returns:** Promise that resolves when playback starts

---

#### `pause(): void`

Pauses playback.

```typescript
player.pause();
```

---

#### `load(): Promise<void>`

Loads the media source (called automatically when `src` changes).

```typescript
player.src = "video.mp4";
await player.load();
```

---

### Track Selection

#### `getVideoTracks(): VideoTrack[]`

Returns available video tracks.

```typescript
const tracks = player.getVideoTracks();
tracks.forEach((track) => {
  console.log(`${track.width}x${track.height} @ ${track.frameRate}fps`);
});
```

---

#### `getAudioTracks(): AudioTrack[]`

Returns available audio tracks.

```typescript
const tracks = player.getAudioTracks();
tracks.forEach((track) => {
  console.log(`${track.language}: ${track.codec}`);
});
```

---

#### `getSubtitleTracks(): SubtitleTrack[]`

Returns available subtitle tracks.

```typescript
const tracks = player.getSubtitleTracks();
```

---

#### `selectVideoTrack(trackId: number): void`

Switches to a different video track.

```typescript
const tracks = player.getVideoTracks();
player.selectVideoTrack(tracks[1].id); // Select second track
```

---

#### `selectAudioTrack(trackId: number): void`

Switches to a different audio track.

```typescript
const englishTrack = player.getAudioTracks().find((t) => t.language === "eng");
if (englishTrack) {
  player.selectAudioTrack(englishTrack.id);
}
```

---

#### `selectSubtitleTrack(trackId: number | null): void`

Enables a subtitle track or disables subtitles.

```typescript
// Enable subtitles
player.selectSubtitleTrack(tracks[0].id);

// Disable subtitles
player.selectSubtitleTrack(null);
```

---

### Advanced Methods

#### `requestPictureInPicture(): Promise<PictureInPictureWindow>`

Enters picture-in-picture mode (if supported).

```typescript
if (document.pictureInPictureEnabled) {
  await player.requestPictureInPicture();
}
```

---

#### `requestFullscreen(): Promise<void>`

Enters fullscreen mode.

```typescript
await player.requestFullscreen();
```

---

#### `generatePreview(timestamp: number, width?: number, height?: number): Promise<Blob>`

Generates a thumbnail image.

```typescript
const thumbnail = await player.generatePreview(60, 320, 180);
imgElement.src = URL.createObjectURL(thumbnail);
```

---

## Events

The element fires standard HTMLMediaElement events:

### Lifecycle Events

```typescript
player.addEventListener("loadstart", () => {
  console.log("Loading started");
});

player.addEventListener("loadedmetadata", () => {
  console.log(`Duration: ${player.duration}s`);
});

player.addEventListener("canplay", () => {
  console.log("Can start playing");
});

player.addEventListener("play", () => {
  console.log("Playing");
});

player.addEventListener("pause", () => {
  console.log("Paused");
});

player.addEventListener("ended", () => {
  console.log("Playback finished");
});
```

---

### Time Events

```typescript
player.addEventListener("timeupdate", () => {
  console.log(`Time: ${player.currentTime}s`);
});

player.addEventListener("seeking", () => {
  console.log("Seeking started");
});

player.addEventListener("seeked", () => {
  console.log("Seeking finished");
});
```

---

### Error Events

```typescript
player.addEventListener("error", (event) => {
  console.error("Playback error:", event.detail);
});
```

---

## UI Controls

The built-in controls provide:

### Bottom Control Bar

```
┌─────────────────────────────────────────────────────────┐
│ [▶]  ●──────────────────────────○  [⚙] [CC] [FS]  1:23 │
└─────────────────────────────────────────────────────────┘
  ↑         ↑                      ↑    ↑   ↑   ↑     ↑
  │         │                      │    │   │   │     └─ Time display
  │         │                      │    │   │   └─────── Fullscreen
  │         │                      │    │   └─────────── Subtitles
  │         │                      │    └─────────────── Settings
  │         │                      └──────────────────── Volume
  │         └─────────────────────────────────────────── Progress bar
  └───────────────────────────────────────────────────── Play/Pause
```

### Settings Menu

Accessed via ⚙ icon:

- **Quality:** Video track selection
- **Speed:** Playback rate (0.25x to 2x)
- **Audio:** Audio track selection
- **Subtitles:** Subtitle track selection
- **Object Fit:** contain/cover/fill/zoom
- **Theme:** Dark/Light mode
- **HDR:** Enable/Disable

---

### Center Play Button

Large play/pause button in center:

- Shown when paused
- Hidden during playback
- Responds to tap/click

---

### Context Menu (Right-Click)

Custom right-click menu with quick access to:

- **Aspect Ratio:** Switch between contain, cover, fill, zoom
- **Playback Speed:** 0.25x to 2.0x
- **Audio/Subtitle Tracks:** Quick selection
- **HDR Mode:** Toggle HDR rendering
- **Snapshot:** Capture current frame
- **Fullscreen:** Toggle fullscreen mode

## Gestures

### Touch Gestures

#### Tap to Play/Pause

```
Single tap → Toggle play/pause
Double tap → (reserved, no action)
```

**Behavior:**

- 200ms delay for double-tap detection
- Works anywhere on video surface

---

#### Swipe to Seek

```
Swipe left  → Seek backward (-10s)
Swipe right → Seek forward  (+10s)
```

**Cumulative Seeking:**

- Multiple swipes accumulate
- Visual indicator shows total seek amount
- Example: Right swipe × 3 = +30s seek

**Threshold:** 50px minimum swipe distance

---

#### Pinch to Zoom

```
Pinch out → Zoom in  (object-fit: zoom)
Pinch in  → Zoom out (object-fit: contain)
```

**Modes:**

- `objectfit="control"` - User can freely adjust zoom
- Other modes - Pinch gesture disabled

---

### Mouse Gestures

#### Click to Play/Pause

Single click toggles playback (same as tap).

---

#### Hover Controls

Controls auto-hide after 3 seconds of inactivity.

**Behavior:**

- Mouse move → Show controls
- 3s idle → Hide controls
- Hover over controls → Stay visible

---

## Theming

### Dark Theme (Default)

```html
<movi-player src="video.mp4" theme="dark"></movi-player>
```

**Colors:**

- Background: `rgba(0, 0, 0, 0.7)`
- Text: `#ffffff`
- Accent: `#4CAF50` (green)
- Progress: `#2196F3` (blue)

---

### Light Theme

```html
<movi-player src="video.mp4" theme="light"></movi-player>
```

**Colors:**

- Background: `rgba(255, 255, 255, 0.9)`
- Text: `#333333`
- Accent: `#4CAF50` (green)
- Progress: `#2196F3` (blue)

---

### Custom Styling

Shadow DOM allows styling via CSS custom properties (future enhancement):

```css
movi-player {
  --control-bg: rgba(0, 0, 0, 0.8);
  --control-text: #fff;
  --accent-color: #ff5722;
  --progress-color: #4caf50;
}
```

---

## Advanced Features

### Ambient Mode

Extracts average frame colors and applies to wrapper element.

**Setup:**

```html
<div id="ambient-wrapper" style="padding: 50px; transition: background 0.5s;">
  <movi-player
    src="video.mp4"
    ambientmode
    ambientwrapper="ambient-wrapper"
  ></movi-player>
</div>
```

**Effect:**

- Samples 8×8 center region of frame
- Calculates average RGB color
- Updates wrapper background every 100ms
- Smooth transitions via CSS

**Performance:** Uses downsampled canvas (~64KB sample)

---

### HDR Rendering

Automatic HDR detection and rendering:

**Detection:**

```typescript
if (
  videoTrack.colorPrimaries === "bt2020" &&
  videoTrack.colorTransfer === "smpte2084"
) {
  // HDR10 content → Use Display-P3 canvas
}
```

**Rendering:**

- Creates WebGL2 context with `colorSpace: 'display-p3'`
- Preserves wide color gamut
- Tone-mapping handled by browser/OS

**Requirements:**

- HDR-capable display
- Browser support (Chrome 94+, Safari 16.4+)
- macOS, Windows 10+ with HDR enabled

---

### Multi-Quality Streaming

Select video quality at runtime:

```html
<movi-player id="player" src="video.mp4" controls></movi-player>

<select id="quality">
  <option value="0">1080p</option>
  <option value="1">720p</option>
  <option value="2">480p</option>
</select>

<script>
  const player = document.getElementById("player");
  const quality = document.getElementById("quality");

  player.addEventListener("loadedmetadata", () => {
    const tracks = player.getVideoTracks();
    // Assume tracks are sorted by resolution
    quality.addEventListener("change", () => {
      player.selectVideoTrack(tracks[quality.value].id);
    });
  });
</script>
```

---

### Custom Context Menu

Right-click opens custom menu (not browser default):

**Items:**

- Copy video URL
- Open in new tab
- Download video
- About Movi Player

**Disable:**

```css
movi-player {
  pointer-events: none; /* Disables context menu */
}
```

---

## Examples

### Responsive Video

```html
<style>
  .video-container {
    position: relative;
    width: 100%;
    padding-top: 56.25%; /* 16:9 aspect ratio */
  }

  movi-player {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }
</style>

<div class="video-container">
  <movi-player src="video.mp4" controls></movi-player>
</div>
```

---

### Playlist

```html
<movi-player id="player" controls></movi-player>

<ul id="playlist">
  <li data-src="video1.mp4">Video 1</li>
  <li data-src="video2.mp4">Video 2</li>
  <li data-src="video3.mp4">Video 3</li>
</ul>

<script>
  const player = document.getElementById("player");
  const items = document.querySelectorAll("#playlist li");

  items.forEach((item) => {
    item.addEventListener("click", () => {
      player.src = item.dataset.src;
      player.play();
    });
  });

  // Auto-advance to next video
  player.addEventListener("ended", () => {
    const current = Array.from(items).findIndex(
      (i) => i.dataset.src === player.src,
    );
    const next = items[current + 1];
    if (next) {
      player.src = next.dataset.src;
      player.play();
    }
  });
</script>
```

---

### Custom Controls

```html
<movi-player id="player" src="video.mp4"></movi-player>

<div class="custom-controls">
  <button id="play">Play</button>
  <button id="pause">Pause</button>
  <input type="range" id="seek" min="0" max="100" value="0" />
  <span id="time">0:00 / 0:00</span>
</div>

<script>
  const player = document.getElementById("player");

  document.getElementById("play").onclick = () => player.play();
  document.getElementById("pause").onclick = () => player.pause();

  player.addEventListener("timeupdate", () => {
    const percent = (player.currentTime / player.duration) * 100;
    document.getElementById("seek").value = percent;
    document.getElementById("time").textContent =
      `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`;
  });

  document.getElementById("seek").oninput = (e) => {
    const time = (e.target.value / 100) * player.duration;
    player.currentTime = time;
  };

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }
</script>
```

---

### File Upload

```html
<input type="file" id="file" accept="video/*" />
<movi-player
  id="player"
  controls
  style="width: 100%; height: 500px;"
></movi-player>

<script>
  const fileInput = document.getElementById("file");
  const player = document.getElementById("player");

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      player.src = file;
      player.play();
    }
  });
</script>
```

---

### Subtitle Customization

```html
<style>
  movi-player::part(subtitle) {
    font-size: 24px;
    font-family: Arial, sans-serif;
    color: yellow;
    text-shadow: 2px 2px 4px black;
  }
</style>

<movi-player src="video.mp4" controls></movi-player>
```

_Note: Shadow parts may not be fully exposed yet. Check component implementation._

---

## Browser Support

### Feature Support Matrix

| Feature            | Chrome 94+ | Safari 16.4+ | Edge 94+ | Firefox |
| ------------------ | ---------- | ------------ | -------- | ------- |
| Basic Playback     | ✅         | ✅           | ✅       | ❌\*    |
| Hardware Decode    | ✅         | ✅           | ✅       | ❌      |
| HDR (Display-P3)   | ✅         | ✅           | ✅       | ❌      |
| SharedArrayBuffer  | ✅         | ✅           | ✅       | ✅      |
| Picture-in-Picture | ✅         | ✅           | ✅       | ✅      |

\*Firefox: Awaiting WebCodecs implementation (expected Q2 2026)

---

## Performance Tips

### 1. Preload WASM Binary

```typescript
// Fetch WASM once, reuse for all players
const wasmBinary = await fetch("/movi.wasm").then((r) => r.arrayBuffer());

const player1 = document.querySelector("#player1");
player1.wasmBinary = new Uint8Array(wasmBinary);

const player2 = document.querySelector("#player2");
player2.wasmBinary = new Uint8Array(wasmBinary);
```

---

### 2. Lazy Load

```html
<!-- Don't load until user clicks play -->
<movi-player
  id="player"
  data-src="video.mp4"
  controls
  poster="thumb.jpg"
></movi-player>

<script>
  const player = document.getElementById("player");
  player.addEventListener(
    "play",
    () => {
      if (!player.src) {
        player.src = player.dataset.src;
      }
    },
    { once: true },
  );
</script>
```

---

### 3. Destroy When Hidden

```typescript
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) {
      entry.target.pause();
      // Optional: destroy player to free memory
      // entry.target.destroy();
    }
  });
});

observer.observe(player);
```

---

## See Also

- [Player API Documentation](./PLAYER.md)
- [Demuxer Documentation](./DEMUXER.md)
- [ISO Standards Compliance](./ISO_STANDARDS_COMPLIANCE.md)

---

**Last Updated:** February 5, 2026
