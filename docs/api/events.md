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

| Event                  | Payload                  | Description                                |
| ---------------------- | ------------------------ | ------------------------------------------ |
| `loadStart`            | `void`                   | Loading started                            |
| `loadEnd`              | `void`                   | Loading completed                          |
| `preloadComplete`      | `void`                   | Initial preload buffer filled              |
| `stateChange`          | `PlayerState`            | State changed                              |
| `timeUpdate`           | `number`                 | Current time updated                       |
| `durationChange`       | `number`                 | Duration available/changed                 |
| `tracksChange`         | `Track[]`                | Tracks list updated                        |
| `audioTrackChange`     | `{ lang, label }`        | Active audio track switched                |
| `subtitleTrackChange`  | `{ lang, label } \| { lang: null, label: null }` | Active subtitle track switched (or off) |
| `seeking`              | `number`                 | Seek started (target time)                 |
| `seeked`               | `number`                 | Seek completed (actual time)               |
| `bufferUpdate`         | `{ start, end }[]`       | Reserved — declared in `PlayerEventMap` but not emitted yet |
| `coverArt`             | `ImageBitmap \| null`    | Embedded cover art extracted at load. Caller owns the bitmap and must call `close()`. |
| `ended`                | `void`                   | Playback ended                             |
| `error`                | `Error`                  | Error occurred                             |
| `frame`                | `DecodedVideoFrame`      | Video frame decoded (advanced)             |
| `audio`                | `DecodedAudioFrame`      | Audio frame decoded (advanced)             |
| `subtitle`             | `SubtitleCue`            | Subtitle cue active                        |
| `filerevoked`          | `{ offset, length, reason }` | `FileSource` handle was revoked by the browser (mobile background / memory pressure) |

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

### `preloadComplete`

Fired when the initial preload buffer has enough data to begin playback without stalling. For local files this fires almost immediately; for HTTP sources it fires after the first prefetch window fills.

```typescript
player.on("preloadComplete", () => {
  console.log("Buffer ready, safe to play");
  playButton.disabled = false;
});
```

### `coverArt`

Fired when embedded cover art has been extracted from the media file (MP3 ID3v2 APIC, MP4 `covr`, FLAC PICTURE, MKV attachments). The payload is an `ImageBitmap` or `null` if no artwork was found. The caller owns the bitmap and **must call `close()`** on it when done.

```typescript
player.on("coverArt", (bitmap: ImageBitmap | null) => {
  if (bitmap) {
    artElement.width = bitmap.width;
    artElement.height = bitmap.height;
    artElement.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    artElement.src = "placeholder.png";
  }
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

### `audioTrackChange`

Fired when the active audio track switches (e.g., user picks a different language).

```typescript
player.on("audioTrackChange", ({ lang, label }) => {
  console.log("Audio now:", lang, label);
  highlightActiveAudio(lang);
});
```

**Payload:** `{ lang: string; label: string }`

### `subtitleTrackChange`

Fired when the active subtitle track switches, or when subtitles are turned off.

```typescript
player.on("subtitleTrackChange", ({ lang, label }) => {
  if (lang === null) {
    console.log("Subtitles off");
    hideSubtitleIndicator();
  } else {
    console.log("Subtitles now:", lang, label);
    highlightActiveSubtitle(lang);
  }
});
```

**Payload:** `{ lang: string; label: string }` when a track is selected, `{ lang: null, label: null }` when subtitles are disabled.

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

## MoviElement DOM Events

The custom element re-exposes player activity as DOM events so you can wire `addEventListener(...)` like a native `<video>`. Names use HTML-style lowercase where they map to a standard media event, and stay as-is for player-specific extras.

| Event                  | Detail payload                       | Description                                        |
| ---------------------- | ------------------------------------ | -------------------------------------------------- |
| `loadstart`            | `{ src: string \| null }`            | A new source is being loaded                       |
| `abort`                | —                                    | A load was stopped before it had data              |
| `suspend`              | —                                    | Preload settled; no more bytes are being pulled    |
| `encrypted`            | `{ initDataType, tokenUrl, videoUrl }` | The source needs a key; the handshake is starting |
| `waitingforkey`        | —                                    | Playback is held until the licence lands           |
| `cuechange`            | —                                    | Fired on the `TextTrack`, not on the element       |
| `loadedmetadata`       | —                                    | Duration and track list are known                  |
| `loadeddata`           | —                                    | First frame is decoded and ready to render         |
| `canplay`              | —                                    | Enough data buffered to begin playback             |
| `durationchange`       | `number` (seconds)                   | Duration became known, or was corrected mid-playback |
| `play`                 | —                                    | Playback started                                   |
| `playing`              | —                                    | Playback actually resumed (after a stall or start) |
| `waiting`              | —                                    | Playback stalled waiting for data                  |
| `pause`                | —                                    | Playback paused                                    |
| `seeking`              | `number` (target time)               | A seek started                                     |
| `seeked`               | `number` (landed time)               | The seek completed                                 |
| `progress`             | `number` (buffered end, seconds)     | Fetching advanced the buffered end                 |
| `canplaythrough`       | —                                    | Buffer reached the end of the media. Unlike `<video>`, this is **not** an estimate — it fires only when the rest is genuinely buffered, at most once per source |
| `stalled`              | —                                    | No data arrived for ~3s while fetching             |
| `emptied`              | —                                    | Previous media torn down; a new load is starting   |
| `resize`               | `{ width: number, height: number }`  | Intrinsic video size changed (i.e. a quality switch) |
| `ended`                | —                                    | Playback reached the end                           |
| `timeupdate`           | `number` (current time)              | Current time advanced (fires repeatedly)           |
| `error`                | `Error`                              | Internal player error surfaced to the DOM          |
| `errordisplay`         | `{ title, message, canRetry, canTrySoftware }` | An error screen went up, with the wording on it. Unlike `error`, whose payload is the raw `Error`, this is what the viewer is shown — and it also covers the format/codec failures that raise no runtime error. See [Customizing the Error Screen](./element.md#customizing-the-error-screen) |
| `statechange`          | `PlayerState`                        | Underlying `MoviPlayer` state transitioned         |
| `volumechange`         | `{ volume: number, muted: boolean }` | Volume or mute toggled (UI, hotkey, or property)   |
| `ratechange`           | `{ playbackRate: number }`           | Playback speed changed                             |
| `titlechange`          | `{ title: string \| null }`          | Resolved/cleaned video title changed               |
| `audiotrackchange`     | —                                    | Active audio track switched                        |
| `subtitletrackchange`  | —                                    | Active subtitle track switched                     |
| `trackschange`         | `Track[]`                            | Available tracks list updated                      |
| `fullscreenchange`     | `{ fullscreen: boolean }`            | Player entered/exited fullscreen                   |
| `movi-fullscreen-request` | —                                 | **Cancelable** — fires before `requestFullscreen()`. `preventDefault()` blocks it so a host can take over via [`setHostFullscreen()`](./element.md#sethostfullscreen-active-boolean-void) |
| `pipchange`            | `{ pip: boolean }`                   | Picture-in-Picture window opened/closed            |
| `enterpictureinpicture` | —                                   | `HTMLVideoElement` alias, fired alongside `pipchange` |
| `leavepictureinpicture` | —                                   | `HTMLVideoElement` alias, fired alongside `pipchange` |
| `qualitychange`        | `{ trackId }` or `{ src, height, … }` or `{ height, auto }` | Active video quality / track switched. The shape depends on what moved it: a pick from the track menu carries `trackId`, a ladder switch carries `src` and `height`, and an Auto/ABR switch carries `height` and `auto: true`. A host persisting a deliberate choice should ignore `auto === true`; one prefetching the next video should read `height` from any of them and treat its absence as "unchanged" |
| `subtitledelaychange`  | `{ subtitleDelay: number }`          | Subtitle offset changed via property/attribute     |
| `playlistchange`       | `{ items: MoviPlaylistItem[] }`      | The queue was replaced (see [`playlist`](./element.md#playlist)) |
| `itemchange`           | `{ index, previousIndex, item }`     | **Cancelable** — the queue moved to another item and is about to load it. `preventDefault()` takes back the load, not the move, so a host whose sources are `<source>`/`<track>` children (or whose items are routes) can own what plays. See [Queues the host loads](./element.md#queues-the-host-loads) |
| `playlistend`          | `{ index: number }`                  | The last item ended with nothing after it. Fires whether or not [`autoadvance`](./element.md#autoadvance) is on |
| `loopchange`           | `{ enabled: boolean, mode: string }` | Loop switched or changed kind — `mode` is `off`, `one` (the item) or `all` (the queue); see [`loop`](./element.md#loop) |
| `loop`                 | `{ count: number }`                  | The item started over on a seamless loop; `count` is which turn this is, from 1 |
| `shufflechange`        | `{ enabled: boolean }`               | Shuffle switched on or off (see [`shuffle`](./element.md#shuffle)); a fresh order is already drawn |
| `smoothwarning`        | `PlaybackAssessment & { media: string, message: object }` | **Cancelable** — what is loaded is not expected to play smoothly at the current speed; `media` is `video` or `audio`, `message` is the notice's plain-language `{ title, body }`. `preventDefault()` keeps the built-in notice down (see [`smoothwarning`](./element.md#smoothwarning)) |
| `coverart`             | `ImageBitmap \| null`                | Embedded cover art extracted at load (close the bitmap when done) |
| `preloadcomplete`      | —                                    | Initial preload buffer filled, ready to play       |
| `linearmode`           | —                                    | Source server ignores `Range` (`200`, not `206`) — playback is forward-only via a sliding RAM window; hide seek-dependent UI |
| `audiotrackchange`     | —                                    | Active audio track switched                        |
| `audiooutputchange`    | `{ deviceId: string \| null }`       | Audio output device (sink) changed                 |
| `audiostripchange`     | `{ active: boolean }`                | Audio-only strip layout entered/left               |
| `nativefallback`       | `{ src: string }`                    | Source handed to a native `<video>` (`fallback="native"`) |
| `movi-qoe`             | QoE snapshot                         | Playback-quality telemetry sample                  |
| `filerevoked`          | `{ offset, length, reason }`         | Underlying `File` handle was revoked by the browser (mobile background / memory pressure). Prompt the user to re-pick. |

::: tip Casing note
`subtitletrackchange` is the canonical name, matching every other DOM event here. A camelCase `subtitleTrackChange` is dispatched alongside it as a compatibility alias — earlier versions of this page documented only that spelling. Prefer the lowercase one.
:::

### Parity with `<video>`

The element aims to be drop-in for code written against a native media element. Every `HTMLMediaElement` event above behaves the same way, with these deliberate exceptions:

| Native event    | Status | Why                                                                                       |
| --------------- | ------ | ----------------------------------------------------------------------------------------- |
| `canplaythrough` | Stricter | `<video>` fires it on a heuristic estimate. We fire it only when the media is genuinely buffered to the end, so it may arrive later — or, on a slow link, not at all. Gate optional UI on it, never playback. |
| `abort`         | Fires | A load counts as in flight until it has data, not merely while the loading flag is up, so a source taken away mid-open reports it. Ordered before `emptied`, as the spec has it. |
| `suspend`       | Fires | Raised when preload settles — the moment this player stops pulling bytes on purpose. |
| `encrypted`     | Fires, differently | `<video>` raises it on meeting initialisation data it needs a key for. This player is told up front, so it fires where the key handshake begins: the load about to ask the token endpoint. |
| `waitingforkey` | Fires | Follows `encrypted` — playback is held until the token lands. |
| `cuechange`     | Fires | On the mirrored `TextTrack` whose caption changed, which is where native fires it. |

`seeking` / `seeked` / `timeupdate` / `durationchange` / `progress` / `resize` carry a `detail` payload (see the table) where `<video>` carries none — read the property off the element instead if you want identical code across both.

### Subscribing

```typescript
const el = document.querySelector("movi-player")!;

el.addEventListener("loadstart", (e: CustomEvent) => {
  console.log("Loading:", e.detail.src);
});

el.addEventListener("timeupdate", (e: CustomEvent<number>) => {
  progressBar.style.width = `${(e.detail / el.duration) * 100}%`;
});

el.addEventListener("statechange", (e: CustomEvent) => {
  if (e.detail === "buffering") showSpinner();
  else hideSpinner();
});

el.addEventListener("volumechange", (e: CustomEvent) => {
  volumeIcon.dataset.muted = String(e.detail.muted);
});

el.addEventListener("pipchange", (e: CustomEvent) => {
  pipButton.dataset.active = String(e.detail.pip);
});

el.addEventListener("titlechange", (e: CustomEvent) => {
  document.title = e.detail.title ?? "Movi";
});
```
