---
title: "Play MKV Files in the Browser with JavaScript"
description: "Play MKV (Matroska) files in the browser \u2014 local files or URLs \u2014 with every audio track, embedded subtitle and chapter. FFmpeg WebAssembly + WebCodecs, nothing uploaded. Copy-paste code."
head:
  - - meta
    - property: og:title
      content: "Play MKV Files in the Browser with JavaScript"
  - - meta
    - property: og:description
      content: "Play MKV (Matroska) files in the browser \u2014 local files or URLs \u2014 with every audio track, embedded subtitle and chapter. FFmpeg WebAssembly + WebCodecs, nothing uploaded. Copy-paste code."
  - - script
    - type: application/ld+json
    - "{\"@context\": \"https://schema.org\", \"@type\": \"FAQPage\", \"mainEntity\": [{\"@type\": \"Question\", \"name\": \"Can a browser play MKV files?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"The native <video> tag cannot read the Matroska container in most browsers. movi-player demuxes MKV with FFmpeg compiled to WebAssembly and decodes with WebCodecs, so MKV plays in the browser.\"}}, {\"@type\": \"Question\", \"name\": \"Is the file uploaded anywhere?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"No. A local file is read in the browser from the user's disk; nothing is sent to a server.\"}}, {\"@type\": \"Question\", \"name\": \"Can I switch audio tracks and subtitles in an MKV?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Every audio and subtitle track in the file is listed in the menu and available from el.player.getAudioTracks() and getSubtitleTracks().\"}}, {\"@type\": \"Question\", \"name\": \"Does it play large MKV files?\", \"acceptedAnswer\": {\"@type\": \"Answer\", \"text\": \"Yes. Files are read in chunks as playback needs them, so multi-gigabyte files open without loading them into memory.\"}}]}"
---

# Play MKV files in the browser

The native `<video>` element does not read MKV in most browsers. `movi-player` does: it demuxes the Matroska container with FFmpeg compiled to WebAssembly and decodes with the browser's WebCodecs, so an MKV plays like any other video — with all of its audio tracks, subtitles and chapters.

## From a URL

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"></script>

<movi-player src="https://example.com/movie.mkv" controls thumb showtitle></movi-player>
```

The server needs to answer HTTP range requests and allow cross-origin reads (CORS) from your page; the player seeks by reading only the bytes it needs.

## From the user's disk

A `File` goes straight into `src`. Nothing is uploaded:

```html
<input type="file" id="pick" accept="video/*,.mkv" />
<movi-player id="player" controls></movi-player>

<script type="module">
  import "movi-player";
  const player = document.getElementById("player");
  document.getElementById("pick").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      player.src = file;
      player.play();
    }
  });
</script>
```

## Audio tracks, subtitles and chapters

An MKV often carries several audio languages and subtitle streams. All of them appear in the ⚙ menu, and the element's `player` exposes them:

```js
const el = document.querySelector("movi-player");
el.addEventListener("trackschange", () => {
  const audio = el.player.getAudioTracks();
  const subs = el.player.getSubtitleTracks();
  if (audio.length > 1) el.player.setAudioTrack(audio[1].id);
  if (subs.length) el.player.setSubtitleTrack(subs[0].id);
  console.log(el.player.getChapters()); // embedded chapters
});
```

Common MKV codecs are covered: H.264, HEVC, AV1, VP9 and VP8 video; AAC, Opus, FLAC, MP3, AC3, TrueHD and DTS audio; SRT, ASS, WebVTT, PGS and DVB subtitles.

## Styling subtitles

```html
<movi-player src="movie.mkv" controls
  subtitlesize="1.3" subtitlecolor="#ffffff"
  subtitlebg="rgba(0,0,0,.6)" subtitleedge="drop-shadow"
  subtitledelay="0.5"></movi-player>
```

## Try it

The **Decoded in the browser** demo on the [examples page](https://moviplayer.com/examples#decoded-in-the-browser) plays a multi-track MKV. More on local files is in [Local File Playback](/guide/local-files), and on tracks in [Multi-Track Support](/guide/multi-track).

## FAQ

### Can a browser play MKV files?

The native `<video>` tag cannot read the Matroska container in most browsers. movi-player demuxes MKV with FFmpeg compiled to WebAssembly and decodes with WebCodecs, so MKV plays in the browser.

### Is the file uploaded anywhere?

No. A local file is read in the browser from the user's disk; nothing is sent to a server.

### Can I switch audio tracks and subtitles in an MKV?

Yes. Every audio and subtitle track in the file is listed in the menu and available from el.player.getAudioTracks() and getSubtitleTracks().

### Does it play large MKV files?

Yes. Files are read in chunks as playback needs them, so multi-gigabyte files open without loading them into memory.
