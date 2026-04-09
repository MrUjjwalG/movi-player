# Movi Player

Play any video format directly in the browser. No transcoding, no server processing.

[![npm](https://img.shields.io/npm/v/movi-player.svg)](https://www.npmjs.com/package/movi-player)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[Documentation](https://mrujjwalg.github.io/movi-player/) | [Live Demo](https://movi-player-examples.vercel.app/element.html) | [Examples](https://github.com/MrUjjwalG/movi-player-examples)

![Movi Player](docs/images/element.gif)

## Why Movi Player?

**The browser can't play MKV, HEVC, or HDR videos.** You either transcode everything server-side or tell users "format not supported." Movi Player fixes this.

- **Play anything** -- MKV, HEVC, AV1, 4K HDR, multi-audio, subtitles. Formats that `<video>` can't touch.
- **Zero server cost** -- No FFmpeg on your server. No transcoding pipeline. Everything runs in the browser via WebAssembly.
- **Drop-in replacement** -- `<movi-player src="video.mp4" controls>` works like `<video>` but plays everything.
- **Content protection** -- Built-in encrypted playback with AES-256-GCM, token auth, HMAC signing. No DRM license server needed.
- **HDR rendering** -- Detects and renders BT.2020/PQ/HLG content on supported displays. Other players can't.
- **Canvas-based** -- No `<video>` element exposed. Right-click save disabled. Screen recording gets watermarked.
- **Picture-in-Picture** -- Document PiP with controls (play/pause, seek, mute, progress). Chromium 116+.
- **Ambient mode** -- Dynamic letterbox glow that samples video colors in real-time. Press `G` or use context menu.
- **Split sources** -- Separate video, audio, and subtitle file URLs via `videosrc`, `audiosrc`, `subtitlesrc` attributes.
- **DRM ready** -- Optional Widevine/FairPlay support via `drm` + `licenseurl` attributes for HLS streams.

### vs. Other Players

| | Movi Player | video.js | hls.js | Plyr |
|---|---|---|---|---|
| MKV / HEVC / AV1 | Yes | No | No | No |
| HDR rendering | Yes | No | No | No |
| No server transcoding | Yes | No | No | No |
| Canvas rendering (no `<video>`) | Yes | No | No | No |
| Encrypted playback | Yes | No | No | No |
| Built-in subtitle rendering | Yes | Plugin | No | No |
| Multi-audio track switching | Yes | Plugin | Yes | No |
| Chapters on progress bar | Yes | Plugin | No | No |
| Picture-in-Picture | Document PiP | Basic | No | No |
| DRM (Widevine/FairPlay) | Optional | Plugin | Yes | No |
| Bundle size | 50-410KB | 500KB+ | 60KB | 25KB |

## Install

```bash
npm i movi-player
```

## Usage

### HTML Element (simplest)

```html
<script type="module">
  import "movi-player";
</script>

<movi-player src="video.mp4" controls autoplay muted></movi-player>
```

### Local File

```html
<movi-player id="player" controls></movi-player>
<input type="file" onchange="document.getElementById('player').src = this.files[0]" />
```

### Programmatic

```typescript
import { MoviPlayer } from "movi-player/player";

const player = new MoviPlayer({
  source: { type: "url", url: "video.mp4" },
  canvas: document.getElementById("canvas"),
});

await player.load();
await player.play();
```

### Encrypted Playback

```html
<movi-player
  encrypted
  tokenurl="/api/token"
  videourl="/api/video"
  videoid="movie.mp4"
  controls autoplay muted
></movi-player>
```

AES-256-GCM encrypted, HMAC signed, 2s token expiry, IP + fingerprint binding.
See [encrypted-server/](encrypted-server/) for the server example.

### DRM (HLS + Widevine/FairPlay)

```html
<movi-player
  src="https://example.com/encrypted.m3u8"
  drm
  licenseurl="https://license.pallycon.com/ri/licenseManager.do"
  controls autoplay
></movi-player>
```

Requires a DRM license server (PallyCon, EZDRM, BuyDRM, etc.). In DRM mode, native `<video>` element is used (canvas features like rotation/watermark are disabled).

### Demuxer Only (50KB)

![Demuxer](docs/images/demuxer.webp)

[Live Demo](https://movi-player-examples.vercel.app/demuxer.html) | [Source](https://github.com/MrUjjwalG/movi-player-examples/blob/main/demuxer.html)

Extract metadata, tracks, HDR info, and thumbnails without playing the video.

```typescript
import { Demuxer, HttpSource } from "movi-player/demuxer";

const demuxer = new Demuxer(new HttpSource("video.mp4"));
const info = await demuxer.open();

console.log(`Duration: ${info.duration}s, Format: ${info.formatName}`);
console.log(`Chapters: ${info.chapters.length}`);

const video = demuxer.getVideoTracks()[0];
console.log(`${video.width}x${video.height} ${video.codec} ${video.frameRate}fps`);
console.log(`HDR: ${video.isHDR}, Color: ${video.colorPrimaries}/${video.colorTransfer}`);

const audio = demuxer.getAudioTracks();
console.log(`Audio: ${audio.map(a => `${a.codec} ${a.language}`).join(", ")}`);

const subs = demuxer.getSubtitleTracks();
console.log(`Subtitles: ${subs.map(s => `${s.codec} ${s.language}`).join(", ")}`);

demuxer.close();
```

Use cases: video validators, asset management, HDR detection pipelines, search indexing, format analysis before transcoding.

## Modules

| Module | Size | What you get |
|---|---|---|
| `movi-player` | ~410KB | Full player with UI, controls, gestures |
| `movi-player/player` | ~180KB | Programmatic playback, no UI |
| `movi-player/demuxer` | ~50KB | Metadata extraction, decoding only |

## Features

**Playback** -- MP4, MKV, WebM, MOV, TS, AVI. H.264, HEVC, VP9, AV1. Hardware decode with software fallback.

**Audio** -- AAC, MP3, Opus, FLAC, AC-3, E-AC-3. Multi-track switching. Stable volume (loudness normalization).

**Subtitles** -- SRT, ASS, WebVTT, PGS (image-based), DVB. Multi-track with on-the-fly switching.

**HDR** -- BT.2020/PQ/HLG detection + Display-P3 rendering on supported browsers.

**UI** -- Controls, context menu, keyboard shortcuts (`?` to view all), themes (dark/light), gestures, ambient mode.

**Picture-in-Picture** -- Document PiP with play/pause, seek, mute, progress bar. Press `P`.

**Aspect Ratio** -- Press `A` to cycle contain/cover/fill/zoom. Context menu sub-menu with icons.

**Nerd Stats** -- Press `I` for codec, resolution, FPS, decoder type, buffer health, network graph. HLS-aware stats.

**Timeline** -- Press `T` for thumbnail strip. Chapter-aware. Keyboard navigation (arrows + enter).

**Chapters** -- Auto-detected from video metadata. Markers on progress bar, titles in seek tooltip.

**Rotation** -- Press `R` to rotate 90. Metadata rotation auto-applied. Thumbnails sync.

**Resume** -- `<movi-player resume>` saves position to localStorage, shows resume dialog on reload. Keyboard navigable.

**Encrypted** -- AES-256-GCM chunked encryption with HMAC-signed token auth. See encrypted-server/.

**DRM** -- Optional Widevine/FairPlay for HLS streams via `drm` + `licenseurl` attributes. Uses native `<video>` + EME API.

## Element Attributes

```html
<movi-player
  src="video.mp4"          <!-- Video URL or set via JS: player.src = file -->
  controls                 <!-- Show player controls -->
  autoplay                 <!-- Auto-play on load -->
  muted                    <!-- Start muted -->
  loop                     <!-- Loop playback -->
  poster="thumb.jpg"       <!-- Poster image -->
  theme="dark"             <!-- dark | light -->
  objectfit="contain"      <!-- contain | cover | fill | zoom | control -->
  hdr                      <!-- Enable HDR rendering -->
  ambientmode              <!-- Ambient background glow -->
  thumb                    <!-- Enable seek thumbnails -->
  fastseek                 <!-- Enable skip buttons and gestures -->
  showtitle                <!-- Show video title -->
  resume                   <!-- Resume from last position -->
  stablevolume             <!-- Loudness normalization -->
  startat="30"             <!-- Start at time (seconds) -->
  gesturefs                <!-- Gestures only in fullscreen -->
  nohotkeys                <!-- Disable keyboard shortcuts -->
  encrypted                <!-- Encrypted playback mode -->
  tokenurl="/api/token"    <!-- Token endpoint (encrypted) -->
  videourl="/api/video"    <!-- Video endpoint (encrypted) -->
  videoid="movie.mp4"      <!-- Video ID (encrypted) -->
  drm                      <!-- DRM mode for HLS (native video + EME) -->
  licenseurl="https://..."  <!-- Widevine/FairPlay license server URL -->
  videosrc="video.mp4"     <!-- Separate video source (split source) -->
  audiosrc="audio.mp4"     <!-- Separate audio source (split source) -->
  subtitlesrc="subs.srt"   <!-- Separate subtitle source (split source) -->
></movi-player>
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `F` | Fullscreen |
| `M` | Mute |
| `R` | Rotate 90 |
| `A` | Cycle aspect ratio |
| `I` | Stats for nerds |
| `T` | Timeline |
| `S` | Snapshot |
| `P` | Picture-in-Picture |
| `V` | Cycle subtitle track |
| `B` | Cycle audio track |
| `L` | Toggle loop |
| `U` | Toggle stable volume |
| `G` | Toggle ambient mode |
| `H` | Toggle HDR |
| `+` / `-` | Speed up / down |
| `?` | Shortcuts panel |
| `0` / `Home` | Seek to start |
| Arrows | Seek / Volume |

## Server Requirements

Videos served over HTTP need:

1. **Range requests** -- for seeking
2. **CORS headers** -- if cross-origin
3. **COOP/COEP headers** (optional) -- for SharedArrayBuffer zero-copy mode:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

## Browser Support

| Browser | WebCodecs | HDR |
|---|---|---|
| Chrome 94+ | Yes | Yes |
| Edge 94+ | Yes | Yes |
| Safari 16.4+ | Yes | Yes |
| Firefox | No | No |

## Development

```bash
git clone --recurse-submodules https://github.com/mrujjwalg/movi-player.git
cd movi-player
npm install
npm run build:wasm    # Requires Docker
npm run build:ts
npm run dev
```

## License

Apache 2.0 -- [Ujjwal Kashyap](https://github.com/mrujjwalg)
