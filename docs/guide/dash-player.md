---
title: "MPEG-DASH Player for the Web \u2014 play .mpd with captions and multi-audio"
description: "Play MPEG-DASH (.mpd) manifests in the browser with one web component: adaptive bitrate, caption tracks, multi-language audio, auth headers and a quality menu. Same player as HLS."
head:
  - - meta
    - property: og:title
      content: "MPEG-DASH Player for the Web \u2014 play .mpd with captions and multi-audio"
  - - meta
    - property: og:description
      content: "Play MPEG-DASH (.mpd) manifests in the browser with one web component: adaptive bitrate, caption tracks, multi-language audio, auth headers and a quality menu. Same player as HLS."
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"How do I play an MPEG-DASH .mpd file in the browser?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Set the .mpd URL as the src of a <movi-player> element. The player parses the manifest, adapts quality, and exposes captions and audio languages in its menu.\"}}, {\"@type\": \"Question\", \"name\": \"Does DASH playback work in Safari?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"A DASH stream encoded as H.264 video with AAC audio plays across browsers, Safari included. The limit is which codecs the browser can decode, not the manifest.\"}}, {\"@type\": \"Question\", \"name\": \"Can I use the same player for HLS and DASH?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. The same element plays .m3u8 and .mpd; only the src changes.\"}}, {\"@type\": \"Question\", \"name\": \"How do I add auth headers to DASH segment requests?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Use the headers attribute with a JSON object; it applies to the manifest and every segment.\"}}]}"
---

# MPEG-DASH player for the web

`movi-player` plays MPEG-DASH (`.mpd`) manifests with the same element it uses for HLS and plain files: adaptive quality, caption tracks, multiple audio languages, and one set of controls.

## Quick start

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"></script>

<movi-player src="https://example.com/vod/manifest.mpd" controls></movi-player>
```

Or with a bundler:

```js
// npm install movi-player
import "movi-player/element";
```

## Captions and audio languages

Text and audio adaptation sets in the manifest appear in the ⚙ menu. A manifest with many caption languages gives the viewer the whole list; pick one from script with the element's `player`:

```js
const el = document.querySelector("movi-player");
el.addEventListener("trackschange", () => {
  const subs = el.player.getSubtitleTracks();
  if (subs.length) el.player.setSubtitleTrack(subs[0].id);
});
```

## Quality

The player starts on **Auto** and follows bandwidth; every representation is listed so a viewer can pin one. The `qualitychange` event fires on each switch.

## Headers and protected streams

```html
<movi-player
  src="https://cdn.example.com/private/manifest.mpd"
  headers='{"Authorization": "Bearer <token>"}'
  controls
></movi-player>
```

The headers go on the manifest request and on every segment.

## HLS and DASH with one player

The format is picked up from the URL, so a page that serves both needs one component:

```js
el.src = prefersDash ? "/vod/manifest.mpd" : "/vod/master.m3u8";
```

## Try it

The **MPEG-DASH with captions** demo on the [examples page](https://moviplayer.com/examples#mpeg-dash-with-captions) plays a public `.mpd` with selectable captions in many languages. For `.m3u8`, see the [HLS player guide](/guide/hls-player).

## FAQ

### How do I play an MPEG-DASH .mpd file in the browser?

Set the .mpd URL as the src of a `<movi-player>` element. The player parses the manifest, adapts quality, and exposes captions and audio languages in its menu.

### Does DASH playback work in Safari?

A DASH stream encoded as H.264 video with AAC audio plays across browsers, Safari included. The limit is which codecs the browser can decode, not the manifest.

### Can I use the same player for HLS and DASH?

Yes. The same element plays .m3u8 and .mpd; only the src changes.

### How do I add auth headers to DASH segment requests?

Use the headers attribute with a JSON object; it applies to the manifest and every segment.
