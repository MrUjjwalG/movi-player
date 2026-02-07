# Why Movi-Player?

See how Movi-Player compares to other popular video players.

## Feature Comparison

| Feature              | Movi-Player | video.js | hls.js  | Plyr |
| -------------------- | ----------- | -------- | ------- | ---- |
| WebCodecs            | ✅          | ❌       | ❌      | ❌   |
| HDR Support          | ✅          | ❌       | ❌      | ❌   |
| MKV / MPEG-TS        | ✅          | ❌       | TS only | ❌   |
| Canvas Renderer      | ✅          | ❌       | ❌      | ❌   |
| Modular              | ✅          | ❌       | ✅      | ❌   |
| FFmpeg WASM          | ✅          | ❌       | ❌      | ❌   |
| No Server Processing | ✅          | ❌       | ❌      | ❌   |
| HLS/DASH             | ✅          | ✅       | ✅      | ✅   |
| Custom UI            | ✅          | ✅       | ❌      | ✅   |

## Bundle Size

| Player          | Full Bundle | Minimal |
| --------------- | ----------- | ------- |
| **Movi-Player** | 410KB       | 45KB    |
| video.js        | 500KB+      | N/A     |
| hls.js          | 300KB       | 300KB   |
| Plyr            | 100KB       | N/A     |

## Key Advantages

### 1. No Server-Side Processing

Other players require server-side transcoding for:

- Format conversion (MKV → MP4)
- Codec transcoding (HEVC → H.264)
- HLS/DASH packaging

**Movi-Player processes everything in the browser.**

```typescript
// Direct MKV playback - no server conversion needed!
<movi-player src="video.mkv" controls></movi-player>
```

### 2. HDR Content Support

Movi-Player is the only web player with full HDR support:

```typescript
const videoTrack = player.getVideoTracks()[0];

if (videoTrack.isHDR) {
  console.log("HDR Format:", videoTrack.colorTransfer);
  // "smpte2084" (HDR10) or "arib-std-b67" (HLG)
}
```

### 3. Multi-Track Without Processing

Switch audio/subtitle tracks without server-side extraction:

```typescript
// Get all audio tracks
const audioTracks = player.getAudioTracks();
// [{ id: 0, language: 'eng' }, { id: 1, language: 'jpn' }]

// Switch to Japanese audio
player.selectAudioTrack(1);
```

### 4. Local File Privacy

Play files directly from user's device:

```typescript
import { FileSource } from "movi-player/player";

// File never leaves the browser
const source = new FileSource(userSelectedFile);
player.load({ file: userSelectedFile });
```

::: info Privacy Benefit
User files are never uploaded to any server. All processing happens locally.
:::

## Migration from Other Players

### From video.js

```diff
- import videojs from 'video.js';
- const player = videojs('my-video');
+ import 'movi-player';
+ // Just use the element directly!
```

```html
<!-- Before: video.js -->
<video id="my-video" class="video-js">
  <source src="video.mp4" type="video/mp4" />
</video>

<!-- After: Movi-Player -->
<movi-player src="video.mp4" controls></movi-player>
```

### From hls.js

```diff
- import Hls from 'hls.js';
- const hls = new Hls();
- hls.loadSource('stream.m3u8');
- hls.attachMedia(video);
+ import 'movi-player';
```

```html
<!-- HLS just works out of the box -->
<movi-player src="stream.m3u8" controls></movi-player>
```
