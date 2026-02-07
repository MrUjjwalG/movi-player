# Multi-Track Support

Movi-Player supports multiple audio, video, and subtitle tracks without any server-side processing.

## Overview

Many video files contain multiple tracks:

- **Audio**: Different languages, commentary, audio descriptions
- **Subtitles**: Various languages, captions, forced subs
- **Video**: Different quality levels, camera angles

Movi-Player can switch between tracks seamlessly during playback.

## Audio Tracks

### Get Available Audio Tracks

```typescript
import { MoviPlayer } from "movi-player/player";

const player = new MoviPlayer({
  source: { url: "anime.mkv" },
  canvas: document.getElementById("canvas") as HTMLCanvasElement,
});

await player.load({ url: "anime.mkv" });

const audioTracks = player.getAudioTracks();
console.log("Available audio tracks:", audioTracks);

// Example output:
// [
//   { id: 1, language: 'eng', title: 'English 5.1', codec: 'eac3', channels: 6 },
//   { id: 2, language: 'jpn', title: 'Japanese', codec: 'aac', channels: 2 },
//   { id: 3, language: 'eng', title: 'English Commentary', codec: 'aac', channels: 2 }
// ]
```

### Switch Audio Track

```typescript
// Switch to Japanese audio
const japaneseTrack = audioTracks.find((t) => t.language === "jpn");
if (japaneseTrack) {
  player.selectAudioTrack(japaneseTrack.id);
}

// Or by index
player.selectAudioTrack(audioTracks[1].id);
```

### Audio Track UI

```typescript
function setupAudioSelector(player: MoviPlayer) {
  const audioTracks = player.getAudioTracks();
  const selector = document.getElementById("audioSelect") as HTMLSelectElement;

  // Clear existing options
  selector.innerHTML = "";

  // Add options
  audioTracks.forEach((track, index) => {
    const option = document.createElement("option");
    option.value = String(track.id);

    let label = track.language?.toUpperCase() || `Track ${index + 1}`;
    if (track.title) {
      label += ` - ${track.title}`;
    }
    if (track.channels) {
      label += ` (${track.channels === 6 ? "5.1" : track.channels === 8 ? "7.1" : "Stereo"})`;
    }

    option.textContent = label;
    selector.appendChild(option);
  });

  // Handle selection
  selector.onchange = () => {
    const trackId = parseInt(selector.value);
    player.selectAudioTrack(trackId);
  };
}
```

## Subtitle Tracks

### Get Available Subtitles

```typescript
const subtitleTracks = player.getSubtitleTracks();
console.log("Available subtitles:", subtitleTracks);

// Example output:
// [
//   { id: 3, language: 'eng', title: 'English', codec: 'subrip', forced: false },
//   { id: 4, language: 'eng', title: 'English (SDH)', codec: 'subrip', forced: false },
//   { id: 5, language: 'jpn', title: 'Japanese', codec: 'ass', forced: false },
//   { id: 6, language: 'eng', title: 'Signs/Songs', codec: 'ass', forced: true }
// ]
```

### Enable/Disable Subtitles

```typescript
// Enable English subtitles
const englishSub = subtitleTracks.find(
  (t) => t.language === "eng" && !t.forced,
);
if (englishSub) {
  player.selectSubtitleTrack(englishSub.id);
}

// Disable subtitles
player.selectSubtitleTrack(null);
```

### Subtitle Selector UI

```typescript
function setupSubtitleSelector(player: MoviPlayer) {
  const subtitleTracks = player.getSubtitleTracks();
  const selector = document.getElementById(
    "subtitleSelect",
  ) as HTMLSelectElement;

  // Clear and add "Off" option
  selector.innerHTML = '<option value="">Subtitles Off</option>';

  subtitleTracks.forEach((track, index) => {
    const option = document.createElement("option");
    option.value = String(track.id);

    let label = track.language?.toUpperCase() || `Subtitle ${index + 1}`;
    if (track.title) {
      label += ` - ${track.title}`;
    }
    if (track.forced) {
      label += " (Forced)";
    }

    option.textContent = label;
    selector.appendChild(option);
  });

  selector.onchange = () => {
    const value = selector.value;
    if (value === "") {
      player.selectSubtitleTrack(null);
    } else {
      player.selectSubtitleTrack(parseInt(value));
    }
  };
}
```

## Video Tracks

### Multiple Video Qualities

```typescript
const videoTracks = player.getVideoTracks();
console.log("Available video tracks:", videoTracks);

// Example output:
// [
//   { id: 0, width: 1920, height: 1080, codec: 'hevc', bitrate: 8000000 },
//   { id: 1, width: 1280, height: 720, codec: 'hevc', bitrate: 4000000 },
//   { id: 2, width: 854, height: 480, codec: 'hevc', bitrate: 2000000 }
// ]
```

### Switch Video Quality

```typescript
// Switch to 4K
const track4K = videoTracks.find((t) => t.height >= 2160);
if (track4K) {
  player.selectVideoTrack(track4K.id);
}

// Switch to 720p
const track720p = videoTracks.find((t) => t.height === 720);
if (track720p) {
  player.selectVideoTrack(track720p.id);
}
```

### Quality Selector UI

```typescript
function setupQualitySelector(player: MoviPlayer) {
  const videoTracks = player.getVideoTracks();
  const selector = document.getElementById(
    "qualitySelect",
  ) as HTMLSelectElement;

  selector.innerHTML = "";

  // Sort by resolution (highest first)
  const sorted = [...videoTracks].sort((a, b) => b.height - a.height);

  sorted.forEach((track) => {
    const option = document.createElement("option");
    option.value = String(track.id);

    let label = `${track.height}p`;
    if (track.height >= 2160) label = "4K";
    else if (track.height >= 1440) label = "1440p QHD";
    else if (track.height >= 1080) label = "1080p HD";
    else if (track.height >= 720) label = "720p HD";
    else if (track.height >= 480) label = "480p SD";
    else label = `${track.height}p`;

    if (track.isHDR) {
      label += " HDR";
    }

    option.textContent = label;
    selector.appendChild(option);
  });

  selector.onchange = () => {
    player.selectVideoTrack(parseInt(selector.value));
  };
}
```

## Complete Track Manager

```typescript
class TrackManager {
  private player: MoviPlayer;

  constructor(player: MoviPlayer) {
    this.player = player;
  }

  getTrackInfo() {
    return {
      audio: this.player.getAudioTracks(),
      video: this.player.getVideoTracks(),
      subtitle: this.player.getSubtitleTracks(),
    };
  }

  setAudioByLanguage(language: string) {
    const track = this.player
      .getAudioTracks()
      .find((t) => t.language === language);
    if (track) {
      this.player.selectAudioTrack(track.id);
      return true;
    }
    return false;
  }

  setSubtitleByLanguage(language: string | null) {
    if (language === null) {
      this.player.selectSubtitleTrack(null);
      return true;
    }

    const track = this.player
      .getSubtitleTracks()
      .find((t) => t.language === language && !t.forced);
    if (track) {
      this.player.selectSubtitleTrack(track.id);
      return true;
    }
    return false;
  }

  setVideoByQuality(minHeight: number) {
    const track = this.player
      .getVideoTracks()
      .filter((t) => t.height >= minHeight)
      .sort((a, b) => a.height - b.height)[0];

    if (track) {
      this.player.selectVideoTrack(track.id);
      return true;
    }
    return false;
  }

  autoSelectByPreferences(prefs: {
    audioLanguage?: string;
    subtitleLanguage?: string | null;
    maxVideoHeight?: number;
  }) {
    if (prefs.audioLanguage) {
      this.setAudioByLanguage(prefs.audioLanguage);
    }

    if (prefs.subtitleLanguage !== undefined) {
      this.setSubtitleByLanguage(prefs.subtitleLanguage);
    }

    if (prefs.maxVideoHeight) {
      this.setVideoByQuality(prefs.maxVideoHeight);
    }
  }
}

// Usage
const trackManager = new TrackManager(player);

trackManager.autoSelectByPreferences({
  audioLanguage: "jpn",
  subtitleLanguage: "eng",
  maxVideoHeight: 1080,
});
```

## Using with Custom Element

```html
<movi-player id="player" src="multi-track.mkv" controls></movi-player>

<div class="track-controls">
  <label>
    Audio:
    <select id="audioSelect"></select>
  </label>

  <label>
    Subtitles:
    <select id="subtitleSelect"></select>
  </label>

  <label>
    Quality:
    <select id="qualitySelect"></select>
  </label>
</div>

<script type="module">
  import "movi-player";

  const player = document.getElementById("player");

  player.addEventListener("loadedmetadata", () => {
    // Setup audio selector
    const audioTracks = player.getAudioTracks();
    const audioSelect = document.getElementById("audioSelect");

    audioTracks.forEach((track) => {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = `${track.language} - ${track.title || track.codec}`;
      audioSelect.appendChild(option);
    });

    audioSelect.onchange = () => {
      player.selectAudioTrack(parseInt(audioSelect.value));
    };

    // Setup subtitle selector
    const subtitleTracks = player.getSubtitleTracks();
    const subtitleSelect = document.getElementById("subtitleSelect");

    subtitleSelect.innerHTML = '<option value="">Off</option>';

    subtitleTracks.forEach((track) => {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = `${track.language} - ${track.title || "Subtitle"}`;
      subtitleSelect.appendChild(option);
    });

    subtitleSelect.onchange = () => {
      const value = subtitleSelect.value;
      player.selectSubtitleTrack(value ? parseInt(value) : null);
    };
  });
</script>
```

## Supported Codecs

### Audio Codecs

| Codec    | Format       | Notes             |
| -------- | ------------ | ----------------- |
| `aac`    | AAC          | Most common       |
| `mp3`    | MP3          | Legacy            |
| `opus`   | Opus         | Modern            |
| `flac`   | FLAC         | Lossless          |
| `ac3`    | Dolby AC-3   | Surround          |
| `eac3`   | Dolby E-AC-3 | Enhanced Surround |
| `dts`    | DTS          | Surround          |
| `vorbis` | Vorbis       | WebM              |

### Subtitle Formats

| Format      | Extension      | Features           |
| ----------- | -------------- | ------------------ |
| **SRT**     | `.srt`         | Simple text        |
| **ASS/SSA** | `.ass`, `.ssa` | Styled, positioned |
| **WebVTT**  | `.vtt`         | Web standard       |
| **PGS**     | `.sup`         | Blu-ray image subs |
| **VobSub**  | `.sub`, `.idx` | DVD image subs     |

::: tip No Conversion Needed
All tracks are processed in the browser. No need to extract or convert tracks on the server!
:::
