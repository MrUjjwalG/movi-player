# Custom Element

The `<movi-player>` custom element is a drop-in replacement for the native `<video>` element with enhanced capabilities.

## Basic Usage

```html
<script type="module">
  import "movi-player";
</script>

<movi-player
  src="video.mp4"
  controls
  autoplay
  muted
  style="width: 100%; height: 500px;"
></movi-player>
```

## Attributes

### Standard Video Attributes

| Attribute  | Type      | Default | Description                                   |
| ---------- | --------- | ------- | --------------------------------------------- |
| `src`      | `string`  | -       | Video URL or can be set to File object via JS |
| `controls` | `boolean` | `false` | Show player controls                          |
| `autoplay` | `boolean` | `false` | Start playing when loaded                     |
| `muted`    | `boolean` | `false` | Mute audio                                    |
| `loop`     | `boolean` | `false` | Loop playback                                 |
| `poster`   | `string`  | -       | Poster image URL                              |
| `width`    | `number`  | -       | Player width in pixels                        |
| `height`   | `number`  | -       | Player height in pixels                       |

### Enhanced Attributes

| Attribute     | Type      | Values                             | Description                |
| ------------- | --------- | ---------------------------------- | -------------------------- |
| `objectfit`   | `string`  | `contain`, `cover`, `fill`, `zoom` | Video scaling mode         |
| `theme`       | `string`  | `dark`, `light`                    | UI theme                   |
| `hdr`         | `boolean` | -                                  | Enable HDR rendering       |
| `ambientmode` | `boolean` | -                                  | Ambient background effects |
| `renderer`    | `string`  | `canvas`, `mse`                    | Rendering mode             |
| `sw`          | `boolean` | -                                  | Force software decoding    |
| `fps`         | `number`  | -                                  | Custom frame rate override |

## Examples

### Dark Theme with HDR

```html
<movi-player
  src="hdr-video.mp4"
  controls
  theme="dark"
  hdr
  style="width: 100%; max-width: 1280px; aspect-ratio: 16/9;"
></movi-player>
```

### Cover Mode (Fill Container)

```html
<movi-player
  src="video.mp4"
  controls
  objectfit="cover"
  style="width: 100%; height: 100vh;"
></movi-player>
```

### Ambient Mode

Ambient mode applies a dynamic glow effect around the player by sampling the video colors and applying them to a wrapper element.

To enable this, you must:

1. Add the `ambientmode` attribute.
2. Provide the ID of the wrapper element via the `ambientwrapper` attribute.

```html
<div
  id="my-player-container"
  style="padding: 50px; background: #000; transition: background 0.5s ease;"
>
  <movi-player
    src="video.mp4"
    controls
    ambientmode
    ambientwrapper="my-player-container"
    theme="dark"
  ></movi-player>
</div>
```

::: warning Important
The wrapper element should have enough padding to show the glow and its `overflow` should NOT be `hidden`.
:::

### Force Software Decoding

```html
<!-- Useful for debugging or when hardware decode fails -->
<movi-player src="video.mp4" controls sw></movi-player>
```

## JavaScript API

### Properties

```javascript
const player = document.querySelector("movi-player");

// Read/Write properties
player.src = "new-video.mp4";
player.currentTime = 60; // Seek to 60s
player.volume = 0.5; // 50% volume
player.muted = true;
player.loop = true;
player.playbackRate = 1.5;

// Read-only properties
console.log(player.duration); // Total duration
console.log(player.paused); // Is paused?
console.log(player.ended); // Has ended?
console.log(player.readyState); // Loading state
```

### Methods

```javascript
// Playback control
await player.play();
player.pause();

// Seek
player.currentTime = 120; // Seek to 2:00

// Fullscreen
player.requestFullscreen();
document.exitFullscreen();
```

### Events

```javascript
// Standard video events
player.addEventListener("play", () => console.log("Playing"));
player.addEventListener("pause", () => console.log("Paused"));
player.addEventListener("ended", () => console.log("Ended"));
player.addEventListener("timeupdate", () => {
  console.log("Time:", player.currentTime);
});
player.addEventListener("loadedmetadata", () => {
  console.log("Duration:", player.duration);
});

// Error handling
player.addEventListener("error", (e) => {
  console.error("Error:", e.detail);
});
```

## Track Selection

### Audio Tracks

```javascript
const player = document.querySelector("movi-player");

// Get audio tracks
const audioTracks = player.getAudioTracks();
console.log(audioTracks);
// [{ id: 0, language: 'eng', codec: 'aac' },
//  { id: 1, language: 'jpn', codec: 'aac' }]

// Switch audio track
player.selectAudioTrack(1); // Switch to Japanese
```

### Subtitle Tracks

```javascript
// Get subtitle tracks
const subtitleTracks = player.getSubtitleTracks();

// Enable subtitles
player.selectSubtitleTrack(subtitleTracks[0].id);

// Disable subtitles
player.selectSubtitleTrack(null);
```

### Video Quality

```javascript
// Get video tracks (different qualities)
const videoTracks = player.getVideoTracks();

// Switch to 4K
const track4K = videoTracks.find((t) => t.height >= 2160);
if (track4K) {
  player.selectVideoTrack(track4K.id);
}
```

## Gestures

The player includes built-in gesture support:

| Gesture              | Action                             |
| -------------------- | ---------------------------------- |
| **Tap**              | Play/Pause                         |
| **Double Tap Left**  | Seek -10s                          |
| **Double Tap Right** | Seek +10s                          |
| **Swipe Left/Right** | Seek ±10s (mobile)                 |
| **Swipe Up/Down**    | Volume (mobile)                    |
| **Pinch**            | Zoom (when objectfit="zoom")       |
| **Hover**            | Show controls (auto-hide after 3s) |

## Context Menu

Right-click (or long-press on mobile) shows a context menu with:

- Playback speed (0.25x - 2x)
- Picture-in-Picture
- Loop toggle
- Download option
- Stats for nerds

## Styling

### CSS Custom Properties

```css
movi-player {
  --movi-primary-color: #646cff;
  --movi-bg-color: rgba(0, 0, 0, 0.8);
  --movi-text-color: #ffffff;
  --movi-progress-color: #646cff;
  --movi-buffer-color: rgba(255, 255, 255, 0.3);
}
```

### Full Width Responsive

```css
movi-player {
  width: 100%;
  max-width: 1920px;
  aspect-ratio: 16 / 9;
  margin: 0 auto;
}
```

## React Integration

```tsx
import { useEffect, useRef } from "react";
import "movi-player";

// Type declaration for TypeScript
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "movi-player": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          controls?: boolean;
          autoplay?: boolean;
          muted?: boolean;
          loop?: boolean;
        },
        HTMLElement
      >;
    }
  }
}

function VideoPlayer({ src }: { src: string }) {
  const playerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const player = playerRef.current;

    const handleTimeUpdate = () => {
      console.log("Time:", (player as any).currentTime);
    };

    player?.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      player?.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, []);

  return (
    <movi-player
      ref={playerRef}
      src={src}
      controls
      style={{ width: "100%", height: "500px" }}
    />
  );
}

export default VideoPlayer;
```

## Vue Integration

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import "movi-player";

const playerRef = ref<HTMLElement | null>(null);

onMounted(() => {
  const player = playerRef.value;

  player?.addEventListener("timeupdate", () => {
    console.log("Time:", (player as any).currentTime);
  });
});
</script>

<template>
  <movi-player
    ref="playerRef"
    src="video.mp4"
    controls
    style="width: 100%; height: 500px;"
  />
</template>
```

## Next.js Integration

```tsx
"use client";

import { useEffect, useRef } from "react";

export default function VideoPlayer({ src }: { src: string }) {
  const playerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Dynamic import for client-side only
    import("movi-player");
  }, []);

  return (
    <movi-player
      ref={playerRef as any}
      src={src}
      controls
      style={{ width: "100%", height: "500px" }}
    />
  );
}
```
