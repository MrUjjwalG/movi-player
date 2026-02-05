# Movi Documentation

Complete technical documentation for the Movi streaming video library.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Documentation Files](#documentation-files)
3. [Quick Links](#quick-links)
4. [Standards Compliance](#standards-compliance)

---

## Getting Started

Choose your integration level:

### Level 1: Demuxer Only (~45KB)
Just need to parse video containers and extract metadata?

```typescript
import { Demuxer } from 'movi/demuxer';
```

**Read:** [DEMUXER.md](./DEMUXER.md)

---

### Level 2: Player (~180KB)
Need programmatic playback control without UI?

```typescript
import { MoviPlayer } from 'movi/player';
```

**Read:** [PLAYER.md](./PLAYER.md)

---

### Level 3: Full Element (~410KB)
Want a drop-in `<video>` replacement with built-in controls?

```html
<movi-player src="video.mp4" controls></movi-player>
```

**Read:** [VIDEO_ELEMENT.md](./VIDEO_ELEMENT.md)

---

## Documentation Files

### Core Documentation

| File | Description | Audience |
|------|-------------|----------|
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Complete system architecture overview | Engineers, Architects |
| **[DEMUXER.md](./DEMUXER.md)** | Demuxer API and container format support | Backend Developers |
| **[PLAYER.md](./PLAYER.md)** | Player API, events, and playback control | Frontend Developers |
| **[VIDEO_ELEMENT.md](./VIDEO_ELEMENT.md)** | Custom element attributes and usage | Web Developers |

### Standards & Compliance

| File | Description | Audience |
|------|-------------|----------|
| **[ISO_STANDARDS_COMPLIANCE.md](./ISO_STANDARDS_COMPLIANCE.md)** | ISO/ITU-T standards compliance report | QA, Compliance Teams |

---

## Quick Links

### By Use Case

**I want to...**

- **Play a video on a webpage**
  → Start with [VIDEO_ELEMENT.md](./VIDEO_ELEMENT.md)

- **Build a custom video player**
  → Read [PLAYER.md](./PLAYER.md)

- **Extract video metadata**
  → Check [DEMUXER.md](./DEMUXER.md)

- **Understand the architecture**
  → Review [ARCHITECTURE.md](./ARCHITECTURE.md)

- **Verify standards compliance**
  → See [ISO_STANDARDS_COMPLIANCE.md](./ISO_STANDARDS_COMPLIANCE.md)

---

### By Topic

**Codec Support:**
- [Supported Codecs](./DEMUXER.md#codec-support)
- [Codec String Generation](./ISO_STANDARDS_COMPLIANCE.md#2-codec-parser-implementation)

**Color Spaces & HDR:**
- [HDR Detection](./DEMUXER.md#color-space-handling)
- [Color Space Standards](./ISO_STANDARDS_COMPLIANCE.md#12-color-space-metadata-itu-t-standards)

**Performance:**
- [Memory Management](./ARCHITECTURE.md#memory-management)
- [Zero-Copy I/O](./ARCHITECTURE.md#zero-copy-io-sharedarraybuffer-mode)
- [Hardware Acceleration](./ARCHITECTURE.md#hardware-acceleration)

**API Reference:**
- [Demuxer API](./DEMUXER.md#api-reference)
- [Player API](./PLAYER.md#api-reference)
- [Element API](./VIDEO_ELEMENT.md#api-reference)

---

## Standards Compliance

Movi follows these international standards:

### Container Formats
- **ISO/IEC 14496-14** - MP4 File Format
- **ISO/IEC 14496-12** - ISO Base Media File Format
- **Matroska Specification** - MKV container
- **WebM Specification** - WebM container

### Video Codecs
- **ISO/IEC 14496-10** - H.264/AVC
- **ISO/IEC 23008-2** - H.265/HEVC
- **ITU-T H.264** - Advanced Video Coding
- **ITU-T H.265** - High Efficiency Video Coding
- **AV1 Bitstream & Decoding Process Specification**
- **VP9 Bitstream & Decoding Process Specification**

### Codec Configuration
- **ISO/IEC 14496-15** - Carriage of NAL unit structured video
- **AV1 Codec ISO Media File Format Binding**
- **VP Codec ISO Media File Format Binding**

### Color Spaces
- **ITU-T H.273** - Coding-independent code points for video signal type
- **SMPTE ST 2084** - High Dynamic Range EOTF (PQ)
- **ARIB STD-B67** - Essential Parameter Values for the Extended Image Dynamic Range TV System (HLG)

### Web Standards
- **W3C WebCodecs API** - Video/Audio decoding
- **W3C Web Audio API** - Audio playback
- **WHATWG HTML Living Standard** - Custom Elements, Shadow DOM
- **Khronos WebGL 2.0** - Graphics rendering
- **CSS Color Module Level 4** - Color spaces (sRGB, Display-P3)

**Full Details:** [ISO_STANDARDS_COMPLIANCE.md](./ISO_STANDARDS_COMPLIANCE.md)

---

## Examples

### Basic Playback

```html
<movi-player src="video.mp4" controls autoplay muted></movi-player>
```

### Programmatic Control

```typescript
import { MoviPlayer } from 'movi/player';

const canvas = document.getElementById('canvas');
const player = new MoviPlayer({ canvas });

await player.load({ url: 'video.mp4' });
await player.play();
```

### Metadata Extraction

```typescript
import { Demuxer, HttpSource } from 'movi/demuxer';

const source = new HttpSource('video.mp4');
const demuxer = new Demuxer(source);

const info = await demuxer.open();
console.log(`Duration: ${info.duration}s`);
console.log(`Tracks: ${info.tracks.length}`);
```

---

## Browser Support

| Browser | Version | Support Level |
|---------|---------|---------------|
| Chrome | 94+ | ✅ Full (WebCodecs, HDR) |
| Edge | 94+ | ✅ Full |
| Safari | 16.4+ | ✅ Full |
| Firefox | - | ❌ Awaiting WebCodecs (Q2 2026) |

---

## Contributing

Found an issue or want to improve the documentation?

1. Check existing issues: https://github.com/anthropics/movi/issues
2. Open a new issue with detailed description
3. Submit pull request with improvements

---

## License

See [LICENSE](../LICENSE) file in the root directory.

---

## Contact

- **Issues:** https://github.com/anthropics/movi/issues
- **Discussions:** https://github.com/anthropics/movi/discussions

---

**Documentation Version:** 1.0.0
**Last Updated:** February 5, 2026
