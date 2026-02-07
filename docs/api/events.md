# Events Reference

Complete reference for all events emitted by Movi-Player.

## Event Subscription

### MoviPlayer (Programmatic API)

```typescript
// Subscribe
player.on("stateChange", (state) => console.log("State:", state));
player.on("loadEnd", () => console.log("Loaded!"));
player.on("durationChange", (duration) => console.log("Duration:", duration));

// Unsubscribe
const handler = (state) => console.log("State:", state);
player.on("stateChange", handler);
player.off("stateChange", handler);
```

### MoviElement (Custom Element)

```typescript
const element = document.querySelector("movi-player");

// Standard addEventListener
element.addEventListener("stateChange", (e: CustomEvent) => {
  console.log("State:", e.detail);
});

element.addEventListener("durationChange", (e: CustomEvent) => {
  console.log("Duration:", e.detail);
});
```

## Available Events

All events from `PlayerEventMap`:

| Event            | Payload             | Description                    |
| ---------------- | ------------------- | ------------------------------ |
| `loadStart`      | `void`              | Loading started                |
| `loadEnd`        | `void`              | Loading completed              |
| `stateChange`    | `PlayerState`       | State changed                  |
| `timeUpdate`     | `number`            | Current time updated           |
| `durationChange` | `number`            | Duration available/changed     |
| `tracksChange`   | `Track[]`           | Tracks list updated            |
| `seeking`        | `number`            | Seek started (target time)     |
| `seeked`         | `number`            | Seek completed (actual time)   |
| `bufferUpdate`   | `{ start, end }[]`  | Buffer ranges updated          |
| `ended`          | `void`              | Playback ended                 |
| `error`          | `Error`             | Error occurred                 |
| `frame`          | `DecodedVideoFrame` | Video frame decoded (advanced) |
| `audio`          | `DecodedAudioFrame` | Audio frame decoded (advanced) |
| `subtitle`       | `SubtitleCue`       | Subtitle cue active            |

## Lifecycle Events

### `loadStart`

Fired when loading begins.

```typescript
player.on("loadStart", () => {
  showSpinner();
  console.log("Loading video...");
});
```

### `loadEnd`

Fired when loading completes (metadata parsed, ready to play).

```typescript
player.on("loadEnd", () => {
  hideSpinner();
  enablePlayButton();
  console.log("Video loaded!");

  // Safe to access tracks now
  renderQualityMenu();
  renderAudioMenu();
});
```

### `durationChange`

Fired when duration becomes available.

```typescript
player.on("durationChange", (duration: number) => {
  console.log("Duration:", duration, "seconds");
  timeDuration.textContent = formatTime(duration);
});
```

### `ended`

Fired when playback reaches the end.

```typescript
player.on("ended", () => {
  showReplayButton();
  trackVideoComplete();
});
```

### `error`

Fired when an error occurs.

```typescript
player.on("error", (error: Error) => {
  console.error("Playback error:", error);
  showErrorMessage(error.message);
  hideSpinner();
});
```

## State Events

### `stateChange`

Fired when player state changes. This is the primary event for tracking playback state.

```typescript
player.on("stateChange", (state: PlayerState) => {
  console.log("State:", state);

  switch (state) {
    case "idle":
      // Initial state, not loaded
      break;
    case "loading":
      showSpinner();
      break;
    case "ready":
      hideSpinner();
      break;
    case "playing":
      updatePlayButton("pause");
      hideSpinner();
      break;
    case "paused":
      updatePlayButton("play");
      break;
    case "buffering":
      showSpinner();
      break;
    case "seeking":
      showSeekIndicator();
      break;
    case "ended":
      showReplayButton();
      break;
    case "error":
      showError();
      break;
  }
});
```

### PlayerState Values

| State       | Description                   |
| ----------- | ----------------------------- |
| `idle`      | Initial state, nothing loaded |
| `loading`   | Loading media file            |
| `ready`     | Loaded and ready to play      |
| `playing`   | Active playback               |
| `paused`    | Paused                        |
| `buffering` | Waiting for data              |
| `seeking`   | Seeking to position           |
| `ended`     | Playback finished             |
| `error`     | Error occurred                |

## Progress Events

### `timeUpdate`

Fired periodically during playback with current time.

```typescript
player.on("timeUpdate", (currentTime: number) => {
  const duration = player.getDuration();
  const percent = (currentTime / duration) * 100;

  progressBar.style.width = `${percent}%`;
  timeDisplay.textContent = formatTime(currentTime);
});
```

### `seeking`

Fired when a seek operation begins.

```typescript
player.on("seeking", (targetTime: number) => {
  console.log("Seeking to:", targetTime);
  showSeekIndicator();
});
```

### `seeked`

Fired when a seek operation completes.

```typescript
player.on("seeked", (actualTime: number) => {
  console.log("Seeked to:", actualTime);
  hideSeekIndicator();
});
```

### `bufferUpdate`

Fired when buffer ranges are updated.

```typescript
player.on("bufferUpdate", (ranges: { start: number; end: number }[]) => {
  // Update buffer bar
  if (ranges.length > 0) {
    const lastRange = ranges[ranges.length - 1];
    const bufferPercent = (lastRange.end / player.getDuration()) * 100;
    bufferBar.style.width = `${bufferPercent}%`;
  }
});
```

## Track Events

### `tracksChange`

Fired when available tracks are updated.

```typescript
player.on("tracksChange", (tracks: Track[]) => {
  console.log("Tracks updated:", tracks.length);

  const videoTracks = tracks.filter((t) => t.type === "video");
  const audioTracks = tracks.filter((t) => t.type === "audio");
  const subtitleTracks = tracks.filter((t) => t.type === "subtitle");

  updateQualityMenu(videoTracks);
  updateAudioMenu(audioTracks);
  updateSubtitleMenu(subtitleTracks);
});
```

## Advanced Events

### `frame`

Fired for each decoded video frame. **Warning: High frequency!**

```typescript
// Use sparingly - called for every frame
player.on("frame", (frame: DecodedVideoFrame) => {
  console.log("Frame:", frame.timestamp, frame.width, frame.height);

  // Process frame for analysis
  analyzeFrame(frame);
});

interface DecodedVideoFrame {
  timestamp: number;
  duration: number;
  width: number;
  height: number;
  format: "yuv420p" | "rgb24" | "rgba";
  data: Uint8Array;
}
```

### `audio`

Fired for decoded audio frames. **Warning: High frequency!**

```typescript
player.on("audio", (frame: DecodedAudioFrame) => {
  // Process for visualization
  audioVisualizer.update(frame.channelData[0]);
});

interface DecodedAudioFrame {
  timestamp: number;
  duration: number;
  sampleRate: number;
  channels: number;
  numFrames: number;
  format: "f32-planar";
  channelData: Float32Array[];
}
```

### `subtitle`

Fired when a subtitle cue becomes active.

```typescript
player.on("subtitle", (cue: SubtitleCue) => {
  if (cue.text) {
    showSubtitle(cue.text);
  } else if (cue.image) {
    showSubtitleImage(cue.image);
  }
});

interface SubtitleCue {
  start: number;
  end: number;
  text?: string;
  image?: ImageBitmap;
  position?: { x: number; y: number };
}
```

## Event Flow

```
player.load() called
    │
    ├─► loadStart
    │
    ├─► stateChange ('loading')
    │
    ├─► durationChange (duration)
    │
    ├─► tracksChange (tracks)
    │
    ├─► loadEnd
    │
    └─► stateChange ('ready')

player.play() called
    │
    ├─► stateChange ('playing')
    │
    └─► timeUpdate (repeats during playback)

player.seek(60) called
    │
    ├─► seeking (60)
    │
    ├─► stateChange ('seeking')
    │
    ├─► seeked (60)
    │
    └─► stateChange ('playing')

player.pause() called
    │
    └─► stateChange ('paused')

Video ends
    │
    ├─► ended
    │
    └─► stateChange ('ended')
```

## Complete Example

```typescript
import { MoviPlayer, LogLevel } from "movi-player/player";

MoviPlayer.setLogLevel(LogLevel.ERROR);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const player = new MoviPlayer({
  source: { type: "url", url: "video.mp4" },
  canvas: canvas,
});

// UI elements
const spinner = document.getElementById("spinner");
const playBtn = document.getElementById("playBtn");
const progressBar = document.getElementById("progressBar");
const timeDisplay = document.getElementById("time");

// Loading events
player.on("loadStart", () => {
  spinner.style.display = "block";
});

player.on("loadEnd", () => {
  spinner.style.display = "none";
});

player.on("durationChange", (duration) => {
  timeDisplay.dataset.duration = String(duration);
});

// State events
player.on("stateChange", (state) => {
  if (state === "playing") {
    playBtn.textContent = "⏸";
    spinner.style.display = "none";
  } else if (state === "paused") {
    playBtn.textContent = "▶";
  } else if (state === "buffering") {
    spinner.style.display = "block";
  } else if (state === "ended") {
    playBtn.textContent = "↺";
  }
});

// Progress
player.on("timeUpdate", (currentTime) => {
  const duration = player.getDuration();
  progressBar.style.width = `${(currentTime / duration) * 100}%`;
  timeDisplay.textContent = formatTime(currentTime);
});

// Errors
player.on("error", (error) => {
  console.error("Error:", error);
  spinner.style.display = "none";
  alert(`Playback error: ${error.message}`);
});

// Load and play
await player.load();
await player.play();

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```
