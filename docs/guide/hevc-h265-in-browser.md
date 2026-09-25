---
title: "Play HEVC / H.265 Video in the Browser (Chrome, Firefox, Safari)"
description: "Play HEVC (H.265) video in the browser, including MKV, 10-bit and HDR files, with hardware decoding through WebCodecs and a WebAssembly software fallback. One web component, copy-paste code."
head:
  - - meta
    - property: og:title
      content: "Play HEVC / H.265 Video in the Browser (Chrome, Firefox, Safari)"
  - - meta
    - property: og:description
      content: "Play HEVC (H.265) video in the browser, including MKV, 10-bit and HDR files, with hardware decoding through WebCodecs and a WebAssembly software fallback. One web component, copy-paste code."
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"Why won't my HEVC video play in the browser?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Many browsers ship without an H.265 decoder for the <video> tag, and the ones that have one often accept HEVC only inside MP4. movi-player reads the file itself and decodes HEVC through WebCodecs, with a software decoder when the hardware path is not available.\"}}, {\"@type\": \"Question\", \"name\": \"Does it use hardware decoding?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes, where the browser and device offer a hardware HEVC decoder through WebCodecs. Otherwise it decodes in software with FFmpeg compiled to WebAssembly.\"}}, {\"@type\": \"Question\", \"name\": \"Does it play 10-bit and HDR HEVC?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. 10-bit HEVC and HDR10/HLG sources are supported; HDR is shown as HDR on displays and browsers that can present it and tone-mapped elsewhere.\"}}, {\"@type\": \"Question\", \"name\": \"Can I force software decoding?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes, with the sw attribute. sw=\\\"auto\\\" falls back to software silently only when hardware decoding fails.\"}}]}"
---

# Play HEVC / H.265 in the browser

HEVC is where the native `<video>` tag is least reliable: some browsers have no H.265 decoder at all, others decode it only on certain hardware or only inside MP4. `movi-player` reads the file itself and decodes HEVC through WebCodecs — on the GPU when the device offers it, and in software with FFmpeg compiled to WebAssembly when it does not.

## Quick start

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"></script>

<movi-player src="https://example.com/clip-hevc.mkv" controls></movi-player>
```

The container does not matter: HEVC in MKV, MP4 or MPEG-TS plays the same way.

## Hardware first, software when needed

```html
<!-- hardware where available, silent software fallback if it fails -->
<movi-player src="clip-hevc.mp4" sw="auto" controls></movi-player>

<!-- always software (useful for testing) -->
<movi-player src="clip-hevc.mp4" sw controls></movi-player>
```

Software decoding runs on the CPU: 1080p is comfortable on most machines, while 4K HEVC in software needs a fast one. For phones, serve an H.264 rendition alongside HEVC.

## 10-bit and HDR

10-bit HEVC and HDR10 / HLG sources are detected from the stream's colour metadata. On a browser and display that can present HDR the picture is shown in HDR; elsewhere it is tone-mapped to SDR. See [HDR Support](/guide/hdr-support).

## Check what a file contains

```js
import { Demuxer, HttpSource } from "movi-player/demuxer";

const demuxer = new Demuxer(new HttpSource("https://example.com/clip-hevc.mkv"));
await demuxer.open();
console.log(demuxer.getMediaInfo()); // codecs, resolution, colour metadata, tracks
```

## Try it

Open an HEVC file of your own on [moviplayer.com](https://moviplayer.com/) — it is read on your device, not uploaded — or see the [examples page](https://moviplayer.com/examples) for more setups.

## FAQ

### Why won't my HEVC video play in the browser?

Many browsers ship without an H.265 decoder for the `<video>` tag, and the ones that have one often accept HEVC only inside MP4. movi-player reads the file itself and decodes HEVC through WebCodecs, with a software decoder when the hardware path is not available.

### Does it use hardware decoding?

Yes, where the browser and device offer a hardware HEVC decoder through WebCodecs. Otherwise it decodes in software with FFmpeg compiled to WebAssembly.

### Does it play 10-bit and HDR HEVC?

Yes. 10-bit HEVC and HDR10/HLG sources are supported; HDR is shown as HDR on displays and browsers that can present it and tone-mapped elsewhere.

### Can I force software decoding?

Yes, with the sw attribute. sw="auto" falls back to software silently only when hardware decoding fails.
