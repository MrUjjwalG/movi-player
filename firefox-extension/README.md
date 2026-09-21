# MoviPlayer Firefox Add-on

Play any video URL with MoviPlayer directly in Firefox — the same add-on as
[`chrome-extension/`](../chrome-extension/), repackaged for Gecko.

## Features

- **Play button overlay** on video links detected on any page
- **Right-click context menu** → "Open with MoviPlayer" on any link or `<video>`
- **Popup** to paste and play any video URL, or play a local file
- Supports: MP4, MKV, WebM, MOV, TS, AVI, HLS (`.m3u8`), MPEG-DASH (`.mpd`), HEVC, AV1, HDR

## Build

```bash
bash firefox-extension/build.sh
```

That builds `dist/element.js` (skip with `SKIP_BUILD=1` if it's already fresh)
and copies the shared UI in from `chrome-extension/`. Then:

```
about:debugging#/runtime/this-firefox → Load Temporary Add-on… → manifest.json
```

Everything the script copies is gitignored — `manifest.json`, `build.sh` and
this README are the only tracked files here.

## Why only manifest.json differs

The content script, player page, icons and player bundle are byte-for-byte
the Chrome extension's, so there is one copy of the UI to maintain. The manifest
is the only Gecko-specific file:

| Key | Chrome | Firefox |
| --- | --- | --- |
| `background` | `service_worker` | `scripts` — Gecko MV3 uses an event page, not a service worker |
| `incognito` | `split`, so the player page opens in the private window it was launched from | omitted — Firefox has no `split`, and installs an extension asking for it as `not_allowed`, which would shut the add-on out of private windows entirely. No key means the default `spanning` |
| `file_handlers` | registers as a ChromeOS file handler, so the Files app can open videos here | omitted — the key is ChromeOS-only |
| `browser_specific_settings.gecko` | — | add-on `id` (required for signing), `strict_min_version`, `data_collection_permissions` (required by AMO) |
| `cross_origin_embedder_policy` / `..._opener_policy` | set | dropped — Chrome-only manifest keys. The player only uses `SharedArrayBuffer` when `crossOriginIsolated` is true and falls back to single-threaded WASM + Asyncify I/O otherwise, so nothing here needs them |

`strict_min_version` is **140.0** (Android **142.0**) because AMO now requires
`data_collection_permissions`, which those versions introduced. The real floor
is Firefox 128 — `marker.js` runs in the MAIN world and `content_scripts[].world`
landed there — so the version can drop to 128 if the data-collection key ever
becomes optional again.

## Validation

```bash
npx web-ext lint --source-dir firefox-extension --ignore-files build.sh README.md
```

It reports **0 errors** and ~33 warnings. None of them block a submission; AMO
routes the add-on to human review either way. What they are:

- `UNSAFE_VAR_ASSIGNMENT` — in `player.js`, template literals whose only
  interpolated values go through `escapeHtml()`; the rest are inside the
  minified bundle. The linter flags the syntax, not an actual unsanitized value.
- `UNSUPPORTED_API` / `DANGEROUS_EVAL` — inside the bundle, from the FFmpeg glue.

Most of these are new only because the linter can finally *read* the bundle: at
11 MB it exceeded the parse limit and was skipped whole, so its contents were
never reported on.

`FILE_TOO_LARGE` used to appear here too: the all-in-one bundle is ~11 MB and
AMO's linter will not parse a JS file over 5 MB, which failed validation
outright. The add-on now ships `dist/element.slim.js` (~4.6 MB) with the FFmpeg
engine beside it as `dist/movi.wasm`, which the linter never opens because it
isn't JS. Same element, same API — the bundle reaches the engine through
`new URL("movi.wasm", import.meta.url)`, so the two must stay in one directory.

## Permissions

Host access is optional. Firefox MV3 treats host permissions as opt-in, so the
"Scan CDN / no-extension links for video" toggle on the player page requests
`<all_urls>` on demand — everything else works without it.

File (`file:///*`) access is granted from **about:addons → MoviPlayer →
Permissions** if you want the play-button overlay on local directory listings.

## How it works

- **Content script** scans every page for `<a>` tags with video extensions and adds a play button; on a direct-video page it offers an "Open with MoviPlayer" card
- **Background event page** handles context-menu clicks, opens the player tab, and probes extension-less links with a HEAD request
- **Player page** loads the `movi-player` element with the video URL — full controls, seek, subtitles, HDR
- **No server needed** — everything runs locally in the browser via WASM
