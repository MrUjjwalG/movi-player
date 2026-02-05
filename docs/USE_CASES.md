# Movi Use Cases

**Comprehensive guide to using Movi across different industries and applications**

---

## Table of Contents

1. [Demuxer Module Use Cases](#demuxer-module-use-cases)
2. [Player Module Use Cases](#player-module-use-cases)
3. [Full Element Use Cases](#full-element-use-cases)
4. [Industry-Specific Applications](#industry-specific-applications)
5. [Integration Scenarios](#integration-scenarios)

---

## Demuxer Module Use Cases

**Package**: `movi/demuxer` | **Size**: ~45KB | **Best For**: Metadata extraction, format analysis

The lightweight demuxer module is perfect for applications that need video metadata without full playback capabilities.

### 1. Media Asset Management (MAM) Systems

**Scenario**: Catalog and index large video libraries without playing each file.

```typescript
import { Demuxer, HttpSource } from 'movi-player/demuxer';

async function catalogVideo(url: string) {
  const source = new HttpSource(url);
  const demuxer = new Demuxer(source);
  const info = await demuxer.open();

  const videoTrack = demuxer.getVideoTracks()[0];

  return {
    duration: info.duration,
    resolution: `${videoTrack.width}x${videoTrack.height}`,
    codec: videoTrack.codec,
    bitrate: videoTrack.bitrate,
    isHDR: videoTrack.isHDR,
    hdrFormat: videoTrack.isHDR
      ? videoTrack.colorTransfer === 'smpte2084' ? 'HDR10' : 'HLG'
      : null,
    audioTracks: demuxer.getAudioTracks().map(t => ({
      language: t.language,
      channels: t.channels,
      codec: t.codec
    })),
    subtitles: demuxer.getSubtitleTracks().map(t => ({
      language: t.language,
      codec: t.codec
    }))
  };
}
```

**Benefits**:
- Fast scanning: metadata only, no decoding
- Low bandwidth: reads only container headers
- Small bundle size: 45KB vs 410KB for full player

### 2. Video File Validators

**Scenario**: Validate uploaded video files meet platform requirements.

```typescript
async function validateUpload(file: File): Promise<ValidationResult> {
  const source = new FileSource(file);
  const demuxer = new Demuxer(source);

  try {
    const info = await demuxer.open();
    const video = demuxer.getVideoTracks()[0];

    const errors: string[] = [];

    // Check resolution
    if (video.width > 3840 || video.height > 2160) {
      errors.push('Resolution exceeds 4K limit');
    }

    // Check codec
    if (!['h264', 'hevc', 'vp9', 'av1'].includes(video.codec)) {
      errors.push('Unsupported video codec');
    }

    // Check duration
    if (info.duration > 3600) {
      errors.push('Duration exceeds 1 hour limit');
    }

    return {
      valid: errors.length === 0,
      errors,
      metadata: {
        duration: info.duration,
        resolution: `${video.width}x${video.height}`,
        codec: video.codec
      }
    };
  } catch (error) {
    return { valid: false, errors: ['Invalid video file'] };
  }
}
```

### 3. HDR Content Detection Pipelines

**Scenario**: Automatically detect and tag HDR content in video libraries.

```typescript
async function detectHDRContent(videoUrls: string[]) {
  const results = await Promise.all(
    videoUrls.map(async (url) => {
      const source = new HttpSource(url);
      const demuxer = new Demuxer(source);
      await demuxer.open();

      const video = demuxer.getVideoTracks()[0];

      return {
        url,
        isHDR: video.isHDR,
        colorSpace: {
          primaries: video.colorPrimaries,
          transfer: video.colorTransfer,
          matrix: video.colorSpace
        },
        hdrFormat: video.colorTransfer === 'smpte2084' ? 'HDR10'
                 : video.colorTransfer === 'arib-std-b67' ? 'HLG'
                 : null,
        bitDepth: video.width >= 3840 && video.isHDR ? 10 : 8
      };
    })
  );

  return results;
}
```

### 4. Video Format Conversion Tools

**Scenario**: Inspect source files before transcoding.

```typescript
async function getTranscodingPreset(sourceUrl: string) {
  const source = new HttpSource(sourceUrl);
  const demuxer = new Demuxer(source);
  const info = await demuxer.open();

  const video = demuxer.getVideoTracks()[0];
  const audio = demuxer.getAudioTracks()[0];

  // Determine optimal transcoding settings
  return {
    videoCodec: video.width >= 3840 ? 'hevc' : 'h264',
    audioCodec: audio.channels > 2 ? 'aac' : 'opus',
    targetBitrate: Math.floor(video.width * video.height * video.fps * 0.1),
    preserveHDR: video.isHDR,
    sourceMetadata: {
      resolution: `${video.width}x${video.height}`,
      fps: video.fps,
      codec: video.codec,
      isHDR: video.isHDR
    }
  };
}
```

### 5. Media Metadata Search Engines

**Scenario**: Build searchable indices of video metadata.

```typescript
interface VideoIndex {
  id: string;
  url: string;
  title: string;
  duration: number;
  resolution: string;
  codec: string;
  isHDR: boolean;
  audioLanguages: string[];
  subtitleLanguages: string[];
  thumbnailUrl?: string;
}

async function indexVideo(url: string): Promise<VideoIndex> {
  const source = new HttpSource(url);
  const demuxer = new Demuxer(source);
  const info = await demuxer.open();

  const video = demuxer.getVideoTracks()[0];

  return {
    id: generateId(url),
    url,
    title: info.metadata?.title || extractTitleFromUrl(url),
    duration: info.duration,
    resolution: `${video.width}x${video.height}`,
    codec: video.codec,
    isHDR: video.isHDR,
    audioLanguages: demuxer.getAudioTracks()
      .map(t => t.language)
      .filter(Boolean),
    subtitleLanguages: demuxer.getSubtitleTracks()
      .map(t => t.language)
      .filter(Boolean)
  };
}
```

---

## Player Module Use Cases

**Package**: `movi/player` | **Size**: ~180KB | **Best For**: Custom video players, programmatic control

The player module provides full playback capabilities with a programmable API for building custom video experiences.

### 1. Custom Video Player Interfaces

**Scenario**: Build a branded video player with custom UI.

```typescript
import { MoviPlayer } from 'movi-player/player';

class CustomVideoPlayer {
  private player: MoviPlayer;
  private canvas: HTMLCanvasElement;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);

    this.player = new MoviPlayer({
      source: { url: '' },
      canvas: this.canvas,
      decoder: 'hardware'
    });

    this.setupCustomControls(container);
    this.setupEventListeners();
  }

  private setupCustomControls(container: HTMLElement) {
    // Custom play button
    const playBtn = document.createElement('button');
    playBtn.textContent = 'Play';
    playBtn.onclick = () => this.player.play();
    container.appendChild(playBtn);

    // Custom seek bar
    const seekBar = document.createElement('input');
    seekBar.type = 'range';
    seekBar.min = '0';
    seekBar.max = '100';
    seekBar.oninput = () => {
      const time = (parseInt(seekBar.value) / 100) * this.player.getDuration();
      this.player.seek(time);
    };
    container.appendChild(seekBar);
  }

  private setupEventListeners() {
    this.player.on('timeupdate', ({ currentTime, duration }) => {
      // Update custom UI
    });

    this.player.on('ended', () => {
      // Handle video end
    });
  }

  async load(url: string) {
    await this.player.load({ url });
  }
}
```

### 2. Educational Platforms with Interactive Video

**Scenario**: E-learning platform with quiz overlay and chapter navigation.

```typescript
class InteractiveLearningVideo {
  private player: MoviPlayer;
  private chapters: Chapter[];
  private quizPoints: QuizPoint[];

  constructor(canvas: HTMLCanvasElement) {
    this.player = new MoviPlayer({
      source: { url: '' },
      canvas
    });

    this.setupQuizSystem();
  }

  private setupQuizSystem() {
    this.player.on('timeupdate', ({ currentTime }) => {
      // Check if we've reached a quiz point
      const quiz = this.quizPoints.find(
        q => Math.abs(currentTime - q.timestamp) < 0.5
      );

      if (quiz && !quiz.completed) {
        this.player.pause();
        this.showQuiz(quiz);
      }
    });
  }

  private async showQuiz(quiz: QuizPoint) {
    // Show quiz overlay
    const answer = await this.displayQuizUI(quiz);

    if (answer.correct) {
      quiz.completed = true;
      this.player.play();
    } else {
      // Rewind to chapter start
      this.player.seek(quiz.chapterStart);
      this.player.play();
    }
  }

  async loadCourse(courseUrl: string, metadata: CourseMetadata) {
    this.chapters = metadata.chapters;
    this.quizPoints = metadata.quizPoints;
    await this.player.load({ url: courseUrl });
  }
}
```

### 3. Multi-Language Video Platforms

**Scenario**: Netflix-style platform with audio/subtitle track switching.

```typescript
class MultiLanguagePlayer {
  private player: MoviPlayer;

  async initialize(url: string) {
    await this.player.load({ url });
    this.buildTrackSelectorUI();
  }

  private buildTrackSelectorUI() {
    const audioTracks = this.player.getAudioTracks();
    const subtitleTracks = this.player.getSubtitleTracks();

    // Audio menu
    const audioMenu = audioTracks.map(track => ({
      id: track.id,
      label: this.getLanguageName(track.language),
      channels: track.channels === 6 ? '5.1' : '2.0',
      selected: track === this.player.getCurrentAudioTrack()
    }));

    // Subtitle menu
    const subtitleMenu = subtitleTracks.map(track => ({
      id: track.id,
      label: this.getLanguageName(track.language),
      selected: track === this.player.getCurrentSubtitleTrack()
    }));

    this.renderTrackMenu(audioMenu, subtitleMenu);
  }

  switchAudio(trackId: number) {
    this.player.selectAudioTrack(trackId);
  }

  switchSubtitle(trackId: number) {
    this.player.selectSubtitleTrack(trackId);
  }

  private getLanguageName(code: string): string {
    const languageNames: Record<string, string> = {
      'eng': 'English',
      'spa': 'Español',
      'fra': 'Français',
      'deu': 'Deutsch',
      'jpn': '日本語',
      'kor': '한국어'
    };
    return languageNames[code] || code.toUpperCase();
  }
}
```

### 4. Video Conference Playback

**Scenario**: Playback of recorded video conferences with speaker switching.

```typescript
class ConferenceRecordingPlayer {
  private player: MoviPlayer;
  private activeSpeaker: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.player = new MoviPlayer({
      source: { url: '' },
      canvas
    });
  }

  async loadRecording(url: string, speakers: Speaker[]) {
    await this.player.load({ url });

    // If multiple audio tracks (one per speaker)
    const audioTracks = this.player.getAudioTracks();

    if (audioTracks.length > 1) {
      // Enable picture-in-picture view for other speakers
      this.setupMultiSpeakerView(speakers, audioTracks);
    }
  }

  switchToSpeaker(speakerIndex: number) {
    const audioTracks = this.player.getAudioTracks();
    if (audioTracks[speakerIndex]) {
      this.player.selectAudioTrack(audioTracks[speakerIndex].id);
      this.activeSpeaker = speakerIndex;
      this.updateSpeakerHighlight(speakerIndex);
    }
  }

  private setupMultiSpeakerView(speakers: Speaker[], tracks: AudioTrack[]) {
    // Create UI for speaker selection
    speakers.forEach((speaker, index) => {
      const button = this.createSpeakerButton(speaker, index);
      button.onclick = () => this.switchToSpeaker(index);
    });
  }
}
```

### 5. Social Media Video Feeds

**Scenario**: Instagram/TikTok-style vertical video feed.

```typescript
class VerticalVideoFeed {
  private players: Map<string, MoviPlayer> = new Map();
  private currentIndex: number = 0;
  private videos: VideoItem[];

  constructor(private container: HTMLElement) {
    this.setupGestures();
  }

  async loadFeed(videos: VideoItem[]) {
    this.videos = videos;

    // Preload current and next video
    await this.loadVideo(this.currentIndex);
    await this.loadVideo(this.currentIndex + 1);
  }

  private async loadVideo(index: number) {
    if (index < 0 || index >= this.videos.length) return;

    const video = this.videos[index];
    const canvas = this.createCanvas(video.id);

    const player = new MoviPlayer({
      source: { url: video.url },
      canvas
    });

    await player.load({ url: video.url });
    this.players.set(video.id, player);

    // Auto-play if visible
    if (index === this.currentIndex) {
      await player.play();
    }
  }

  private setupGestures() {
    let startY = 0;

    this.container.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    });

    this.container.addEventListener('touchend', (e) => {
      const endY = e.changedTouches[0].clientY;
      const deltaY = startY - endY;

      if (Math.abs(deltaY) > 50) {
        if (deltaY > 0) {
          this.nextVideo();
        } else {
          this.previousVideo();
        }
      }
    });
  }

  private async nextVideo() {
    if (this.currentIndex >= this.videos.length - 1) return;

    // Pause current
    const currentVideo = this.videos[this.currentIndex];
    this.players.get(currentVideo.id)?.pause();

    // Play next
    this.currentIndex++;
    const nextVideo = this.videos[this.currentIndex];
    await this.players.get(nextVideo.id)?.play();

    // Preload next
    await this.loadVideo(this.currentIndex + 1);

    // Unload old
    this.unloadVideo(this.currentIndex - 2);
  }
}
```

### 6. Video Thumbnail Generation Service

**Scenario**: Generate thumbnails at specific timestamps.

```typescript
class ThumbnailGenerator {
  private player: MoviPlayer;

  constructor() {
    const canvas = document.createElement('canvas');
    this.player = new MoviPlayer({
      source: { url: '' },
      canvas,
      enablePreviews: true
    });
  }

  async generateThumbnails(url: string, count: number = 10): Promise<Blob[]> {
    await this.player.load({ url });

    const duration = this.player.getDuration();
    const interval = duration / (count + 1);
    const thumbnails: Blob[] = [];

    for (let i = 1; i <= count; i++) {
      const timestamp = interval * i;
      const thumbnail = await this.player.generatePreview(
        timestamp,
        320,  // width
        180   // height
      );
      thumbnails.push(thumbnail);
    }

    return thumbnails;
  }

  async generateStoryboard(url: string): Promise<string> {
    const thumbnails = await this.generateThumbnails(url, 20);

    // Create sprite sheet
    const canvas = document.createElement('canvas');
    canvas.width = 320 * 5;  // 5 columns
    canvas.height = 180 * 4;  // 4 rows
    const ctx = canvas.getContext('2d')!;

    for (let i = 0; i < thumbnails.length; i++) {
      const img = await createImageBitmap(thumbnails[i]);
      const x = (i % 5) * 320;
      const y = Math.floor(i / 5) * 180;
      ctx.drawImage(img, x, y);
    }

    return canvas.toDataURL('image/jpeg', 0.8);
  }
}
```

---

## Full Element Use Cases

**Package**: `movi` (main) | **Size**: ~410KB | **Best For**: Drop-in video player replacement

The full element provides a complete video player with UI, controls, and gestures—perfect for replacing native `<video>` tags.

### 1. Content Management Systems (CMS)

**Scenario**: WordPress/Drupal video player plugin.

```html
<!-- Simple drop-in replacement -->
<movi-player
  src="https://cdn.example.com/videos/tutorial.mp4"
  poster="https://cdn.example.com/thumbnails/tutorial.jpg"
  controls
  width="800"
  height="450"
></movi-player>
```

```typescript
// WordPress plugin integration
function registerMoviPlayerBlock() {
  wp.blocks.registerBlockType('movi/video-player', {
    title: 'Movi Video Player',
    icon: 'video-alt3',
    category: 'media',
    attributes: {
      src: { type: 'string' },
      poster: { type: 'string' },
      hdr: { type: 'boolean', default: false },
      theme: { type: 'string', default: 'dark' }
    },
    edit: EditComponent,
    save: ({ attributes }) => (
      <movi-player
        src={attributes.src}
        poster={attributes.poster}
        hdr={attributes.hdr}
        theme={attributes.theme}
        controls
      />
    )
  });
}
```

### 2. E-Commerce Product Videos

**Scenario**: Shopify/WooCommerce product demo videos.

```html
<!-- HDR product showcase -->
<div class="product-video">
  <movi-player
    src="https://cdn.shop.com/products/iphone-demo.mp4"
    poster="https://cdn.shop.com/products/iphone-thumb.jpg"
    hdr
    theme="light"
    objectfit="contain"
    controls
    autoplay
    muted
    loop
  ></movi-player>
</div>
```

```typescript
// Add to cart integration
const player = document.querySelector('movi-player');

player.addEventListener('ended', () => {
  // Show "Add to Cart" button after video
  showAddToCartButton();
});

player.addEventListener('timeupdate', (e) => {
  const currentTime = e.detail.currentTime;

  // Show product features at specific timestamps
  if (currentTime >= 5 && currentTime < 6) {
    showFeaturePopup('Camera: 48MP Pro');
  } else if (currentTime >= 10 && currentTime < 11) {
    showFeaturePopup('Display: 6.7" Super Retina XDR');
  }
});
```

### 3. News & Media Websites

**Scenario**: News article embedded videos with auto-play muting.

```html
<!-- Auto-play muted for better UX -->
<article>
  <h1>Breaking News: Major Event</h1>

  <movi-player
    src="https://news.cdn.com/videos/breaking-news-2026.mp4"
    poster="https://news.cdn.com/thumbs/breaking-news-2026.jpg"
    controls
    autoplay
    muted
    theme="dark"
    style="width: 100%; max-width: 800px;"
  ></movi-player>

  <p>Article content continues here...</p>
</article>
```

```javascript
// Intersection Observer for auto-play
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const player = entry.target;

    if (entry.isIntersecting) {
      player.play();
    } else {
      player.pause();
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('movi-player').forEach(player => {
  observer.observe(player);
});
```

### 4. Portfolio & Resume Websites

**Scenario**: Personal portfolio with demo reel.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <title>John Doe - Video Editor</title>
  <script type="module">
    import 'movi-player';
  </script>
  <style>
    .demo-reel {
      max-width: 1200px;
      margin: 50px auto;
    }
  </style>
</head>
<body>
  <div class="demo-reel">
    <h2>My Demo Reel</h2>

    <movi-player
      src="https://portfolio.com/demo-reel-2026.mp4"
      poster="https://portfolio.com/demo-reel-thumb.jpg"
      controls
      hdr
      ambientmode
      theme="dark"
      objectfit="cover"
      style="width: 100%; height: 600px; border-radius: 12px;"
    ></movi-player>
  </div>
</body>
</html>
```

### 5. Online Course Platforms

**Scenario**: Udemy/Coursera-style course video player.

```html
<div class="course-player">
  <movi-player
    id="course-video"
    src="https://courses.com/lessons/intro-to-webdev-01.mp4"
    controls
    theme="dark"
    style="width: 100%; height: 100%;"
  ></movi-player>
</div>

<script type="module">
  import 'movi-player';

  const player = document.getElementById('course-video');

  // Save progress
  player.addEventListener('timeupdate', (e) => {
    const progress = e.detail.currentTime / e.detail.duration;
    localStorage.setItem('course-progress', progress.toString());
  });

  // Resume from last position
  player.addEventListener('loadedmetadata', () => {
    const savedProgress = parseFloat(localStorage.getItem('course-progress') || '0');
    if (savedProgress > 0) {
      player.currentTime = savedProgress * player.duration;
    }
  });

  // Next lesson
  player.addEventListener('ended', () => {
    showNextLessonButton();
  });
</script>
```

### 6. Digital Signage & Kiosks

**Scenario**: Museum interactive displays or retail signage.

```html
<!-- Full-screen looping promotional video -->
<movi-player
  src="https://signage.com/store-promo-4k-hdr.mp4"
  autoplay
  loop
  muted
  hdr
  objectfit="cover"
  style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;"
></movi-player>
```

---

## Industry-Specific Applications

### Healthcare & Medical Imaging

**Scenario**: Surgical video review and training.

```typescript
// High-precision frame control for medical professionals
class MedicalVideoPlayer {
  private player: MoviPlayer;

  async loadSurgicalVideo(url: string) {
    await this.player.load({ url });

    // Enable frame-by-frame control
    this.setupFrameControls();
  }

  private setupFrameControls() {
    document.getElementById('prev-frame')?.addEventListener('click', () => {
      this.stepFrame(-1);
    });

    document.getElementById('next-frame')?.addEventListener('click', () => {
      this.stepFrame(1);
    });
  }

  private stepFrame(direction: number) {
    const fps = 30;  // Get from video track
    const currentTime = this.player.getCurrentTime();
    const newTime = currentTime + (direction / fps);
    this.player.seek(newTime);
  }
}
```

### Security & Surveillance

**Scenario**: Security camera footage playback with timestamp overlay.

```typescript
class SecurityFootagePlayer {
  private player: MoviPlayer;

  async loadFootage(url: string, startTimestamp: Date) {
    await this.player.load({ url });

    this.player.on('timeupdate', ({ currentTime }) => {
      const actualTime = new Date(
        startTimestamp.getTime() + currentTime * 1000
      );
      this.updateTimestampOverlay(actualTime);
    });
  }

  async exportClip(startTime: number, endTime: number) {
    // Seek to start
    await this.player.seek(startTime);

    // Record frames until endTime
    // ... implementation for clip export
  }
}
```

### Broadcasting & Live Streaming Archive

**Scenario**: Playback of recorded live streams with chat replay.

```typescript
class LiveStreamArchivePlayer {
  private player: MoviPlayer;
  private chatReplay: ChatMessage[];

  async loadArchive(streamUrl: string, chatLog: ChatMessage[]) {
    this.chatReplay = chatLog;
    await this.player.load({ url: streamUrl });

    this.player.on('timeupdate', ({ currentTime }) => {
      // Show chat messages that occurred at this timestamp
      const relevantMessages = this.chatReplay.filter(msg =>
        Math.abs(msg.timestamp - currentTime) < 1
      );

      relevantMessages.forEach(msg => this.displayChatMessage(msg));
    });
  }
}
```

### Gaming & Esports

**Scenario**: Game replay viewer with synchronized telemetry.

```typescript
class GameReplayPlayer {
  private player: MoviPlayer;
  private telemetry: GameTelemetry;

  async loadReplay(videoUrl: string, telemetryUrl: string) {
    this.telemetry = await fetch(telemetryUrl).then(r => r.json());
    await this.player.load({ url: videoUrl });

    this.player.on('timeupdate', ({ currentTime }) => {
      // Display game stats at current timestamp
      const stats = this.telemetry.getStatsAt(currentTime);
      this.updateStatsOverlay(stats);
    });
  }

  seekToKill(killIndex: number) {
    const timestamp = this.telemetry.kills[killIndex].timestamp;
    this.player.seek(timestamp - 3);  // 3 seconds before kill
  }
}
```

### Real Estate Virtual Tours

**Scenario**: Property walkthrough videos with room navigation.

```html
<movi-player
  id="property-tour"
  src="https://realestate.com/tours/123-main-st.mp4"
  controls
  hdr
  objectfit="cover"
  style="width: 100%; height: 600px;"
></movi-player>

<div class="room-navigation">
  <button onclick="seekToRoom(0)">Living Room</button>
  <button onclick="seekToRoom(45)">Kitchen</button>
  <button onclick="seekToRoom(90)">Master Bedroom</button>
  <button onclick="seekToRoom(135)">Backyard</button>
</div>

<script>
  function seekToRoom(timestamp) {
    document.getElementById('property-tour').currentTime = timestamp;
  }
</script>
```

### Scientific Visualization

**Scenario**: Time-lapse microscopy playback.

```typescript
class MicroscopyPlayer {
  private player: MoviPlayer;

  async loadTimelapse(url: string, metadata: MicroscopyMetadata) {
    await this.player.load({ url });

    // Display scale bar and timestamp
    this.player.on('timeupdate', ({ currentTime }) => {
      const frameNumber = Math.floor(currentTime * metadata.fps);
      const realTime = metadata.startTime + (frameNumber * metadata.intervalMs);

      this.updateOverlay({
        scaleBar: `${metadata.scaleBarMicrons} μm`,
        timestamp: new Date(realTime).toISOString(),
        frameNumber
      });
    });
  }
}
```

---

## Integration Scenarios

### Framework Integrations

#### React

```tsx
import { useEffect, useRef, useState } from 'react';
import 'movi-player';

function VideoPlayer({ src }: { src: string }) {
  const playerRef = useRef<HTMLElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const player = playerRef.current;

    const handleTimeUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setCurrentTime(detail.currentTime);
      setDuration(detail.duration);
    };

    player?.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      player?.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, []);

  return (
    <div>
      <movi-player
        ref={playerRef}
        src={src}
        controls
        style={{ width: '100%', height: '500px' }}
      />
      <p>Progress: {Math.round((currentTime / duration) * 100)}%</p>
    </div>
  );
}
```

#### Vue 3

```vue
<template>
  <div>
    <movi-player
      ref="player"
      :src="videoUrl"
      controls
      @timeupdate="handleTimeUpdate"
      style="width: 100%; height: 500px;"
    />
    <p>{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import 'movi-player';

const player = ref<HTMLElement>();
const videoUrl = ref('https://example.com/video.mp4');
const currentTime = ref(0);
const duration = ref(0);

const handleTimeUpdate = (e: CustomEvent) => {
  currentTime.value = e.detail.currentTime;
  duration.value = e.detail.duration;
};

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
</script>
```

#### Svelte

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import 'movi-player';

  export let src: string;

  let player: HTMLElement;
  let currentTime = 0;
  let duration = 0;

  onMount(() => {
    player.addEventListener('timeupdate', (e: CustomEvent) => {
      currentTime = e.detail.currentTime;
      duration = e.detail.duration;
    });
  });
</script>

<movi-player
  bind:this={player}
  {src}
  controls
  style="width: 100%; height: 500px;"
/>

<p>Progress: {Math.round((currentTime / duration) * 100)}%</p>
```

### Backend Integration Examples

#### Node.js Thumbnail Generation

```typescript
// Server-side thumbnail generation (headless)
import { Demuxer, FileSource } from 'movi-player/demuxer';
import { createCanvas } from 'canvas';

async function generateThumbnailServer(filePath: string) {
  const source = new FileSource(filePath);
  const demuxer = new Demuxer(source);
  await demuxer.open();

  // Extract metadata for thumbnail generation
  const video = demuxer.getVideoTracks()[0];

  return {
    width: video.width,
    height: video.height,
    duration: demuxer.getDuration(),
    isHDR: video.isHDR
  };
}
```

#### Express API Endpoint

```typescript
import express from 'express';
import { Demuxer, HttpSource } from 'movi-player/demuxer';

const app = express();

app.get('/api/video-info', async (req, res) => {
  const videoUrl = req.query.url as string;

  try {
    const source = new HttpSource(videoUrl);
    const demuxer = new Demuxer(source);
    const info = await demuxer.open();

    const video = demuxer.getVideoTracks()[0];

    res.json({
      duration: info.duration,
      resolution: `${video.width}x${video.height}`,
      codec: video.codec,
      isHDR: video.isHDR,
      audioTracks: demuxer.getAudioTracks().length,
      subtitleTracks: demuxer.getSubtitleTracks().length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process video' });
  }
});
```

---

## Choosing the Right Module

| Requirement | Use Module | Example |
|-------------|------------|---------|
| Just need metadata | `movi/demuxer` (45KB) | MAM systems, validators |
| Custom player UI | `movi/player` (180KB) | Streaming platforms, custom apps |
| Drop-in replacement | `movi` (410KB) | CMS, blogs, e-commerce |
| HDR metadata only | `movi/demuxer` (45KB) | Content cataloging |
| HDR playback | `movi/player` (180KB+) | Professional video apps |
| Full UI with gestures | `movi` (410KB) | General purpose |

---

## Performance Considerations

### When to Use Movi

✅ **Good fit:**
- Custom video experiences
- HDR content platforms
- Multi-track audio/subtitle support
- Format flexibility (MKV, MOV, etc.)
- Hardware decoding requirements
- Professional video applications

❌ **Consider alternatives:**
- Simple SDR H.264/MP4 playback → Native `<video>`
- Live streaming only → HLS.js, Dash.js
- Legacy browser support → Video.js with Flash fallback

---

## Summary

Movi's modular architecture allows it to serve a wide range of use cases:

- **45KB demuxer**: Perfect for metadata extraction and format analysis
- **180KB player**: Ideal for custom video applications with programmatic control
- **410KB full element**: Best for drop-in video player replacement with complete UI

Whether you're building a Netflix-style streaming platform, a video asset management system, or simply need a better `<video>` tag, Movi provides the tools you need with excellent performance and HDR support.

---

**Ready to get started?** Check out the [Quick Start Guide](../README.md#quick-start) and [API Documentation](./README.md).
