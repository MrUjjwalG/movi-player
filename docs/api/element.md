# Video Element Documentation

**Movi Streaming Video Library - Custom HTML Video Element**

![Movi Element Showcase](../images/element.gif)

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

#### `volume`

Sets the initial audio volume (0.0 to 1.0). User preference persists across reloads via OPFS and overrides this default on subsequent loads.

```html
<movi-player src="video.mp4" volume="0.5"></movi-player>
```

---

#### `playbackrate`

Sets the initial playback speed. Persists across reloads like `volume`.

```html
<movi-player src="video.mp4" playbackrate="1.5"></movi-player>
```

**Note:** Attribute name is all lowercase (`playbackrate`). The JS property is camelCase (`player.playbackRate`).

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

#### `postertime`

Generates a native-resolution poster frame from a timestamp instead of (or as a fallback for) `poster`. Useful when you don't have a pre-rendered thumbnail but want to show a representative frame.

**Accepted formats:**

- `"10%"` — percentage of total duration
- `"5"` or `"5s"` — seconds
- `"1:30"` — `mm:ss`
- `"0:01:30"` — `hh:mm:ss`

```html
<!-- Show frame at 10% of duration -->
<movi-player src="video.mp4" postertime="10%"></movi-player>

<!-- Show frame at 1 minute 30 seconds -->
<movi-player src="video.mp4" postertime="1:30"></movi-player>
```

**Behavior:**

- Runs on an isolated thumbnail pipeline (separate WASM + `ThumbnailBindings`); does **not** disturb the main player's clock or decoder.
- Respects the video's rotation metadata so portrait videos display correctly.
- Race-guarded — a generation counter invalidates in-flight generators on every `src` change so a late frame from the old source can't paint over the new poster.
- Skipped if an explicit `poster` URL is set, or if the source is encrypted/DRM (those pipelines have their own protected paths).
- Only `File` and plain HTTP URL sources are supported.

**Use Case:** Playlist UIs that don't want to ship pre-rendered thumbnails but still want a sharp, native-resolution preview before play.

---

#### `title`

Sets the video title shown in the in-player overlay. Unlike the global HTML `title` attribute, this does **not** trigger a native browser tooltip on hover.

```html
<movi-player src="video.mp4" title="My Vacation Video" showtitle></movi-player>
```

Use together with `showtitle` to render the title bar. Auto-filled from metadata/filename if not provided.

---

#### `showtitle`

Shows the title bar overlay at the top of the player.

```html
<movi-player src="video.mp4" title="Intro" showtitle></movi-player>
```

Auto-hides with the controls.

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

#### `sw`

Forces software decoding (using FFmpeg WASM) instead of hardware-accelerated WebCodecs.

```html
<movi-player src="video.mp4" sw></movi-player>
```

**Note:** Useful if hardware decoding fails or produces visual artifacts for a specific file.

---

#### `fps`

Overrides the video frame rate with a custom value.

**Values:**

- `0` (default) - Use frame rate from video metadata
- `number` - Fixed frame rate (e.g., `24`, `60`)

```html
<movi-player src="video.mp4" fps="60"></movi-player>
```

---

#### `gesturefs`

Restricts touch gestures to fullscreen mode only. When enabled, tap/swipe/pinch gestures will only work when the player is in fullscreen.

```html
<movi-player src="video.mp4" gesturefs></movi-player>
```

**Use Case:** Prevent accidental gesture triggers when player is embedded in scrollable content or near system gesture edges on mobile devices.

---

#### `nohotkeys`

Disables all keyboard shortcuts for playback control.

```html
<movi-player src="video.mp4" nohotkeys></movi-player>
```

**Use Case:** Useful when embedding player in forms or pages where keyboard shortcuts might conflict with other page functionality.

**Disabled Shortcuts:**
- Space/K - Play/Pause
- Arrow Left/Right - Seek ±10s
- Arrow Up/Down - Volume ±10%
- F - Fullscreen
- M - Mute/Unmute

---

#### `startat`

Specifies the time (in seconds) where playback should start.

```html
<movi-player src="video.mp4" startat="30"></movi-player>
```

**Use Case:** Start video at a specific timestamp, useful for sharing video links with timestamps or auto-skipping intros.

---

#### `fastseek`

Enables fast seek controls for quick ±10s navigation.

```html
<movi-player src="video.mp4" fastseek></movi-player>
```

**Enables:**
- Skip forward/backward buttons in control bar
- Double-tap on left/right sides to seek
- Arrow Left/Right keyboard shortcuts (±10s)

**Use Case:** Better navigation experience for longer videos (podcasts, lectures, movies).

---

#### `doubletap`

Enables/disables double-tap to seek gesture.

```html
<!-- Enable (default) -->
<movi-player src="video.mp4" doubletap="true"></movi-player>

<!-- Disable -->
<movi-player src="video.mp4" doubletap="false"></movi-player>
```

**Behavior:** Double-tap left side seeks -10s, double-tap right side seeks +10s.

---

#### `themecolor`

Sets a custom primary color for the player UI (progress bar, buttons, accents).

```html
<movi-player src="video.mp4" themecolor="#ff5722"></movi-player>
```

**Value:** Any valid CSS color (hex, rgb, color name).

**Use Case:** Match player theme to your brand colors.

---

#### `buffersize`

Target prefetch window in **megabytes** — how far ahead of playback the source should try to keep buffered.

```html
<movi-player src="video.mp4" buffersize="200"></movi-player>
```

**Value:** Target buffer depth in MB.

**Default:** `250` for plain HTTP (sliding window at 8% of file size, capped at 250 MB); `~192` for encrypted mode (prefetch high-water × 2 MB block size).

**Behavior:**
- **HTTP source** — overrides the sliding-window cap. Files smaller than this value are cached entirely; larger files use a sliding window.
- **Encrypted source** — scales the prefetch depth (`PREFETCH_HIGH_WATER`), refill threshold (`LOW_WATER` ≈ half), and block cache cap (≈ 1.5× target).
- **File source** — no-op (entire file already in memory).

**Use Case:** Raise for deep-scrub UX on large files; lower for memory-constrained embeds.

---

#### `resume`

Saves playback position to localStorage and shows a resume dialog on reload.

```html
<movi-player src="video.mp4" resume></movi-player>
```

Position is saved every 5 seconds and on pause. Cleared when video ends. Uses URL as key for streams, filename+size for local files.

---

#### `stablevolume`

Enables loudness normalization (DynamicsCompressorNode). Reduces loud scenes and boosts quiet ones.

```html
<movi-player src="video.mp4" stablevolume></movi-player>
```

Toggle at runtime via the UI button or context menu.

---

#### `encrypted`

Enables encrypted video playback. Requires `tokenurl` and `videourl` attributes.

```html
<movi-player
  encrypted
  tokenurl="/api/token"
  videourl="/api/video"
  videoid="movie.mp4"
  controls autoplay muted
></movi-player>
```

See [Encrypted Server Example](https://github.com/mrujjwalg/movi-player/tree/develop/encrypted-server) for the complete server implementation.

---

#### `tokenurl`

Token endpoint URL for encrypted playback. Server returns HMAC signing secret and file metadata.

---

#### `videourl`

Video endpoint URL for encrypted playback. Chunks are served with token + HMAC validation.

---

#### `videoid`

Video identifier sent to the token server. Maps to a specific encrypted file on the server.

---

#### `drm`

Enables DRM playback mode for HLS streams. When set, the player switches to a native `<video>` element + EME API instead of the canvas pipeline. Canvas-only features (rotation, snapshots) are disabled in this mode.

```html
<movi-player
  src="https://example.com/stream.m3u8"
  drm
  licenseurl="https://license.pallycon.com/ri/licenseManager.do"
  controls autoplay
></movi-player>
```

Works with Widevine (Chrome/Edge/Firefox) and FairPlay (Safari).

---

#### `licenseurl`

Widevine/FairPlay license server URL for DRM playback. Required when `drm` is set.

```html
<movi-player
  src="stream.m3u8"
  drm
  licenseurl="https://license.example.com/wv"
></movi-player>
```

Supported providers: PallyCon, EZDRM, BuyDRM, AWS Media Services, custom.

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

#### `playing: boolean` (read-only)

True only while the player is actively playing — distinguishes `playing` from intermediate states like `ready`, `loading`, `seeking`, and `buffering`. Useful when deciding whether to carry play state across a source switch (e.g., a playlist).

```typescript
if (player.playing) {
  console.log("Frame loop is running");
}

// Forward play state to the next playlist item
const wasPlaying = player.playing;
player.src = nextItem.url;
if (wasPlaying) await player.play();
```

**Note:** `!paused` is true even during `ready`/`buffering`. Use `playing` when you want to mean "actively rendering frames right now."

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

#### `sw: boolean`

Gets/sets whether software decoding is forced.

```typescript
player.sw = true; // Force software decoding
```

---

#### `fps: number`

Gets/sets custom frame rate override.

```typescript
player.fps = 24; // Override to 24 FPS
player.fps = 0; // Auto (from metadata)
```

---

#### `gesturefs: boolean`

Gets/sets whether touch gestures are restricted to fullscreen mode only.

```typescript
player.gesturefs = true; // Gestures only work in fullscreen
player.gesturefs = false; // Gestures always enabled
```

---

#### `nohotkeys: boolean`

Gets/sets whether keyboard shortcuts are disabled.

```typescript
player.nohotkeys = true; // Disable keyboard shortcuts
player.nohotkeys = false; // Enable keyboard shortcuts
```

---

#### `startat: number`

Gets/sets the starting playback time in seconds.

```typescript
player.startat = 30; // Start at 30 seconds
```

---

#### `fastseek: boolean`

Gets/sets whether fast seek controls are enabled.

```typescript
player.fastseek = true; // Enable ±10s skip buttons
player.fastseek = false; // Disable fast seek
```

---

#### `doubletap: boolean`

Gets/sets whether double-tap to seek is enabled.

```typescript
player.doubletap = true; // Enable double-tap seek
player.doubletap = false; // Disable double-tap seek
```

---

#### `themecolor: string | null`

Gets/sets custom theme color for the player UI.

```typescript
player.themecolor = "#ff5722"; // Set custom color
player.themecolor = null; // Reset to default
```

---

#### `buffersize: number`

Gets/sets the target prefetch window in **megabytes**. Applies to both HTTP and encrypted sources; file sources ignore it.

```typescript
player.buffersize = 400; // Keep ~400 MB buffered ahead
player.buffersize = 0;   // Restore library default
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

#### `postertime: string | null`

Gets/sets the timestamp used to generate the poster frame. Setting to `null` removes the attribute. See the [`postertime` attribute](#postertime) for accepted formats.

```typescript
player.postertime = "10%";   // Generate poster at 10% of duration
player.postertime = "1:30";  // Generate poster at 1m 30s
player.postertime = null;    // Disable
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

**Note:** Calling `play()` while a source is still loading is now safe — the play intent is queued and flushed once the load completes (matches `HTMLMediaElement` semantics).

---

#### `dispose(): void`

Tears down the internal player and resets transient UI (subtitles, timeline, time, title, generated poster) back to the no-source state. Called automatically on every `src` change so playlist-style flows never leak state between sources. Safe to call when nothing is loaded.

```typescript
// Manual cleanup before swapping content
player.dispose();
player.src = nextVideo;
```

**Notes:**
- Does **not** touch the canvas or the native `<video>` element — the canvas keeps its WebGL2 context for the next renderer to reuse, and resetting `<video>` would interfere with the DRM/HLS path.
- Releases any per-source software-decoder fallback so the next source gets a fresh hardware-decode attempt.
- Revokes any `postertime`-generated poster URL.

---

#### `loadEncrypted(config): Promise<void>`

Loads an encrypted video source programmatically.

```typescript
await player.loadEncrypted({
  videoUrl: "/api/video",
  tokenUrl: "/api/token",
  videoId: "movie.mp4",
  fingerprint: await generateFingerprint(),
  sessionToken: "jwt-token",
});
```

**Config:**
- `videoUrl` — Encrypted video endpoint
- `tokenUrl` — Token/HMAC endpoint
- `videoId` — Video identifier
- `fingerprint` — Browser fingerprint string
- `sessionToken` — Auth session token
- `tokenRefreshInterval` — Token refresh ms (default: 1500)
- `onAuthFailed` — Callback on auth failure

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

### Static Utilities

#### `MoviElement.cleanVideoTitle(filename: string): string`

Turns a raw filename or metadata string into a human-readable title by stripping separators, release-group tags, and quality/codec suffixes — the same logic the player uses internally for tab titles, the in-player overlay, and the resume localStorage key.

```typescript
import { MoviElement } from "movi-player/element";

MoviElement.cleanVideoTitle("My.Series.S01E02.Episode.Title.1080p.WEB-DL.DDP5.1.x265-RELEASEGRP.mkv");
// → "My Series S01E02 Episode Title"
```

**Use Case:** A playlist UI that wants to show identical titles to the player, or compute the resume key (`movi-resume:<cleanVideoTitle(name)>`) so the right resume position is shown next to each item.

---

## Events

The element re-exposes player activity as DOM events so you can wire `addEventListener(...)` like a native `<video>`. Standard media events use HTML-style lowercase; player-specific extras carry richer `detail` payloads.

| Event                  | Detail payload                       | When it fires                                      |
| ---------------------- | ------------------------------------ | -------------------------------------------------- |
| `loadstart`            | `{ src: string \| null }`            | A new source is being loaded                       |
| `loadeddata`           | —                                    | First frame is decoded and ready to render         |
| `play`                 | —                                    | Playback started                                   |
| `pause`                | —                                    | Playback paused                                    |
| `ended`                | —                                    | Playback reached the end                           |
| `timeupdate`           | `number` (current time)              | Current time advanced (fires repeatedly)           |
| `error`                | `Error`                              | Internal player error surfaced to the DOM          |
| `statechange`          | `PlayerState`                        | Underlying `MoviPlayer` state transitioned         |
| `volumechange`         | `{ volume: number, muted: boolean }` | Volume or mute toggled (UI, hotkey, or property)   |
| `ratechange`           | `{ playbackRate: number }`           | Playback speed changed                             |
| `titlechange`          | `{ title: string \| null }`          | Resolved/cleaned video title changed               |
| `audiotrackchange`     | —                                    | Active audio track switched                        |
| `subtitleTrackChange`  | —                                    | Active subtitle track switched (note camelCase)    |
| `trackschange`         | `Track[]`                            | Available tracks list updated                      |
| `fullscreenchange`     | `{ fullscreen: boolean }`            | Player entered/exited fullscreen                   |
| `pipchange`            | `{ pip: boolean }`                   | Picture-in-Picture window opened/closed            |
| `qualitychange`        | `{ trackId: number }`                | Active video quality / track switched              |

::: tip Casing note
`subtitleTrackChange` keeps camelCase for backward compatibility while every other custom event uses lowercase. If you're listening for both `audiotrackchange` and subtitle changes, mind the casing.
:::

### Lifecycle

```typescript
const player = document.querySelector("movi-player")!;

player.addEventListener("loadstart", (e: CustomEvent) => {
  console.log("Loading:", e.detail.src);
});

player.addEventListener("loadeddata", () => {
  console.log(`First frame ready, duration: ${player.duration}s`);
});

player.addEventListener("play", () => console.log("Playing"));
player.addEventListener("pause", () => console.log("Paused"));
player.addEventListener("ended", () => console.log("Playback finished"));
```

---

### Progress

```typescript
player.addEventListener("timeupdate", (e: CustomEvent<number>) => {
  console.log(`Time: ${e.detail}s`);
});
```

`statechange` (below) covers seeking/buffering — the element does not fire separate `seeking`/`seeked` DOM events.

---

### State

```typescript
player.addEventListener("statechange", (e: CustomEvent) => {
  switch (e.detail) {
    case "buffering": showSpinner(); break;
    case "seeking":   showSeekIndicator(); break;
    case "playing":   hideSpinner(); break;
    case "paused":    hideSpinner(); break;
    case "error":     showError(); break;
  }
});
```

---

### Volume / Speed

```typescript
player.addEventListener("volumechange", (e: CustomEvent) => {
  volumeIcon.dataset.muted = String(e.detail.muted);
  volumeSlider.value = String(e.detail.volume);
});

player.addEventListener("ratechange", (e: CustomEvent) => {
  speedLabel.textContent = `${e.detail.playbackRate}x`;
});
```

---

### Tracks

```typescript
player.addEventListener("trackschange", (e: CustomEvent) => {
  rebuildTrackMenus(e.detail);
});

player.addEventListener("audiotrackchange", () => {
  highlightActiveAudio(player.getAudioLangs().find((t) => t.active));
});

player.addEventListener("subtitleTrackChange", () => {
  // camelCase — see note above
  highlightActiveSubtitle(player.getSubtitleLangs().find((t) => t.active));
});

player.addEventListener("qualitychange", (e: CustomEvent) => {
  console.log("Quality switched to track:", e.detail.trackId);
});
```

---

### Title

```typescript
player.addEventListener("titlechange", (e: CustomEvent) => {
  document.title = e.detail.title ?? "Movi";
});
```

---

### Fullscreen / PiP

```typescript
player.addEventListener("fullscreenchange", (e: CustomEvent) => {
  console.log("Fullscreen:", e.detail.fullscreen);
});

player.addEventListener("pipchange", (e: CustomEvent) => {
  pipButton.dataset.active = String(e.detail.pip);
});
```

---

### Error

```typescript
player.addEventListener("error", (e: CustomEvent<Error>) => {
  console.error("Playback error:", e.detail);
});
```

---

## Keyboard Shortcuts

Press `?` during playback to view the shortcuts panel.

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` / `K` | Play / Pause | `0` / `Home` | Seek to start |
| `F` | Fullscreen | `End` | Seek to end |
| `M` | Mute / Unmute | `Left` | Seek -10s |
| `R` | Rotate video 90 | `Right` | Seek +10s |
| `I` | Stats for nerds | `Ctrl+Left` | Previous frame (when paused) |
| `T` | Timeline thumbnails | `Ctrl+Right` | Next frame (when paused) |
| `S` | Snapshot | `Up` | Volume up |
| `?` | Shortcuts panel | `Down` | Volume down |

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

- [Player API Documentation](./player.md)
- [Demuxer Documentation](./demuxer.md)
- [ISO Standards Compliance](../guide/standards.md)

---

**Last Updated:** February 5, 2026
