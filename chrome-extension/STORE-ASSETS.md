# Chrome Web Store assets

The current store set is captured from the unpacked Chrome extension running
in Chromium. The player is decoding real local media. No controls, playback
metadata, subtitles, or playlist rows are painted into the screenshots. The
hover play button is the real one content.js injects on a demo page; the
context-menu shot draws a faithful Chrome menu around the extension's real
"Open with MoviPlayer" entry, because a native menu cannot be captured
headless. Promotional tiles use the real playback capture — the small tile is
the marquee's composition at a quarter of the area.

## Upload files

All generated files are in `chrome-extension/screenshots/` (gitignored).

| File | Size | Contents |
| --- | --- | --- |
| `1-hero.png` | 1280 × 800 | What this is and why: the claim, the formats, the real playback capture |
| `2-hover-play.png` | 1280 × 800 | Hover play button on a media link, on an ordinary page |
| `3-context-menu.png` | 1280 × 800 | "Open with MoviPlayer" in the link context menu |
| `4-home.png` | 1280 × 800 | The extension's own page: file, folder, and URL picker, with its settings |
| `5-subtitles.png` | 1280 × 800 | Embedded credit captions and subtitle menu |
| `movi-player-promo.png` | 440 × 280 | Small promotional tile |
| `movi-player-promo-big.png` | 1400 × 560 | Marquee promotional tile |

The hero leads because a browsing shopper reads the first image, not the
listing: it has to say what the extension is and why, and a raw playback
frame said neither — playback itself now shows inside the hero and again in
the subtitle shot. Use only these five screenshots — the store takes at most
five, so the set IS the folder: nothing numbered sits in `screenshots/`
without being uploaded. The playback/playlist/audio-tracks captures (the hero and
promos are rendered FROM `archive-previous/playback.png`) and the obsolete
popup/laptop mockups live in `screenshots/archive-previous/`, outside the
upload set. The small promo's
existing `mov-` filename is retained for compatibility. Nothing in this
workflow uploads or publishes to the store.

[Chrome's image requirements](https://developer.chrome.com/docs/webstore/images)
allow up to five screenshots. These exports are opaque PNGs at the preferred
dimensions, with square corners and no device frames.

## Reproduce

Requires the repository's installed Playwright, a Playwright Chromium browser,
`curl`, and an FFmpeg build with H.264, VP9, AAC, and Opus encoders. From the
repository root:

```sh
# Build the current player, or reuse a dist/ build you have already verified.
npm run build:ts
SKIP_BUILD=1 bash chrome-extension/build.sh

# Downloads the official trailer only when it is missing, then makes samples.
node chrome-extension/scripts/prepare-store-media.mjs
node chrome-extension/scripts/capture-store-assets.mjs
node chrome-extension/scripts/capture-showcase.mjs
node chrome-extension/scripts/render-promos.mjs
```

To regenerate just the 440 × 280 tile, run
`node chrome-extension/scripts/render-promos.mjs --small`.

`MOVI_CHROMIUM_PATH` optionally selects an existing Chromium executable instead
of Playwright's default. Use Chromium/Chrome for Testing with unpacked-extension
support. A temporary clean browser profile is created and removed for each run.
`MOVI_CAPTURE_MEDIA` overrides the sample directory and `MOVI_CAPTURE_OUTPUT`
overrides the capture output directory. For custom output locations, pass the
playback PNG path and output directory to `render-promos.mjs` as arguments.

The sample preparer writes to `test-media/chrome-store/` by default. Its main
MKV contains the original trailer video, genuine stereo AAC and a mono
downmix, plus newly authored film-credit captions. These are demonstration
tracks, not alternative-language film dubs or a dialogue transcript. The
playlist uses actual separately encoded excerpts, not renamed copies of one
format. No source footage is bundled into the store-asset ZIP.

The capture waits for playback to advance after each seek, checks the selected
subtitle track, verifies loaded thumbnails, and restores the player's
scroll position after browser automation focuses controls. It writes
`capture-report.json` with source bundle hashes and decoded media metadata,
and `capture-console.json` with browser messages. Decoder/page errors fail the
capture; browser feature-policy warnings remain in the log for inspection.
The subtitle capture uses the player's supported 75% subtitle size setting.
Visually inspect all five captures after regeneration, including caption text
and thumbnail contents, which may be rendered into canvases.

## Media attribution

**Sintel — © copyright Blender Foundation | durian.blender.org**

Source: [official 720p trailer](https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4).
Licensed under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/);
see the [Blender Foundation sharing terms](https://durian.blender.org/sharing/).

The source was excerpted, remuxed/transcoded, given a mono audio downmix and
demonstration credit subtitles, and captured during playback. Promo tiles
scale a screenshot proportionally. No endorsement by Blender Foundation is
implied. Retain this attribution with the distributed asset set and in the
store listing's media credits; the promo tiles also include a visible credit.
