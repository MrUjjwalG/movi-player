---
title: "HLS Player in JavaScript \u2014 play .m3u8 streams with one tag"
description: "Play HLS (.m3u8) streams in any browser with a single web component: adaptive bitrate with a quality menu, auth headers on every segment, DRM, subtitles and multi-audio. Copy-paste examples."
head:
  - - meta
    - property: og:title
      content: "HLS Player in JavaScript \u2014 play .m3u8 streams with one tag"
  - - meta
    - property: og:description
      content: "Play HLS (.m3u8) streams in any browser with a single web component: adaptive bitrate with a quality menu, auth headers on every segment, DRM, subtitles and multi-audio. Copy-paste examples."
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"How do I play an .m3u8 stream in JavaScript?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Import movi-player and set the .m3u8 URL as the src of a <movi-player> element. It detects the HLS manifest and plays it with adaptive bitrate, with no extra setup.\"}}, {\"@type\": \"Question\", \"name\": \"Does it switch quality automatically?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Adaptive streams get an Auto mode that follows bandwidth, plus a quality menu listing every rendition so viewers can pin one.\"}}, {\"@type\": \"Question\", \"name\": \"Can I send an auth token with every segment request?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Put a JSON object in the headers attribute; it is applied to the manifest and to every segment request.\"}}, {\"@type\": \"Question\", \"name\": \"Does it support DRM on HLS?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Set drm and a licenseurl pointing at your Widevine or FairPlay license server; the player switches to a native <video> with EME for those streams.\"}}]}"
---

# HLS player in JavaScript

Play an HLS (`.m3u8`) stream in the browser with one element. `movi-player` recognises the manifest, adapts quality to the viewer's bandwidth, and gives you the same controls, subtitles and track menus it uses for files.

## Quick start

::: code-group

```html [CDN]
<script type="module" src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"></script>

<movi-player src="https://example.com/live/stream.m3u8" controls></movi-player>
```

```js [npm]
// npm install movi-player
import "movi-player/element"; // registers <movi-player>
```

:::

That is the whole integration. There is no separate HLS library to load and no `MediaSource` wiring on your side.

## Adaptive quality and the quality menu

For an adaptive ladder the player starts on **Auto**, which follows the measured bandwidth, and lists every rendition in the ⚙ menu so a viewer can pin one. Listen for the change:

```js
const el = document.querySelector("movi-player");
el.addEventListener("qualitychange", (e) => console.log("now playing", e.detail));
```

## Auth headers on every request

Private streams usually need a token on the manifest **and** on every segment. Pass the headers once:

```html
<movi-player
  src="https://cdn.example.com/private/master.m3u8"
  headers='{"Authorization": "Bearer <token>"}'
  controls
></movi-player>
```

## DRM (Widevine / FairPlay)

```html
<movi-player
  src="https://cdn.example.com/protected/master.m3u8"
  drm
  licenseurl="https://license.example.com/widevine"
  controls
></movi-player>
```

With `drm` set, the player plays the stream through a native `<video>` and the browser's EME, so canvas-only features such as rotation and snapshots are off for that source.

## Subtitles and audio tracks

Subtitle and audio renditions declared in the playlist show up in the ⚙ menu. From script:

```js
const el = document.querySelector("movi-player");
el.addEventListener("trackschange", () => {
  const audio = el.player.getAudioTracks();
  if (audio.length > 1) el.player.setAudioTrack(audio[1].id);
});
```

## When the source cannot be read

If a CDN blocks cross-origin reads, `fallback="native"` hands the source to a native `<video>` under the same controls instead of showing an error:

```html
<movi-player src="https://cdn.example.com/stream.m3u8" fallback="native" controls></movi-player>
```

## Try it

Open the live **HLS stream, auto quality** demo on the [examples page](https://moviplayer.com/examples#hls-stream-auto-quality), or see the [MPEG-DASH guide](/guide/dash-player) for `.mpd` manifests.

## FAQ

### How do I play an .m3u8 stream in JavaScript?

Import movi-player and set the .m3u8 URL as the src of a `<movi-player>` element. It detects the HLS manifest and plays it with adaptive bitrate, with no extra setup.

### Does it switch quality automatically?

Yes. Adaptive streams get an Auto mode that follows bandwidth, plus a quality menu listing every rendition so viewers can pin one.

### Can I send an auth token with every segment request?

Yes. Put a JSON object in the headers attribute; it is applied to the manifest and to every segment request.

### Does it support DRM on HLS?

Yes. Set drm and a licenseurl pointing at your Widevine or FairPlay license server; the player switches to a native `<video>` with EME for those streams.
