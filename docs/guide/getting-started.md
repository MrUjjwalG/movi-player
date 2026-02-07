# Getting Started

Get up and running with Movi-Player in under a minute.

## Installation

::: code-group

```bash [npm]
npm install movi-player
```

```bash [yarn]
yarn add movi-player
```

```bash [pnpm]
pnpm add movi-player
```

```bash [bun]
bun add movi-player
```

:::

## Quick Start

### Option 1: CDN (No Install Required)

The fastest way to try Movi-Player:

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module">
      import "https://unpkg.com/movi-player@latest/dist/element.js";
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

### Option 2: Custom Element

```html
<script type="module">
  import "movi-player";
</script>

<movi-player
  src="video.mp4"
  controls
  style="width: 100%; height: 500px;"
></movi-player>
```

### Option 3: Programmatic API

```typescript
import { MoviPlayer, LogLevel } from "movi-player/player";

// Optional: Set log level
MoviPlayer.setLogLevel(LogLevel.ERROR);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const player = new MoviPlayer({
  source: {
    type: "url",
    url: "video.mp4",
  },
  canvas: canvas,
  renderer: "canvas",
  decoder: "auto",
});

// Event listeners
player.on("loadEnd", () => console.log("Ready!"));
player.on("stateChange", (state) => console.log("State:", state));

// Load and play
await player.load();
await player.play();
```

::: tip CORS Note
When using HTTP URLs, ensure your server has CORS enabled. For local file playback using `FileSource`, no CORS configuration is needed!
:::

## What's Next?

- [Why Movi-Player?](/guide/why-movi-player) - See how we compare to other players
- [Architecture](/guide/architecture) - Understand the modular design
- [Custom Element](/guide/custom-element) - Full element API reference
- [API Reference](/api/player) - Detailed API documentation
