# Movi Player Chrome Extension

Play any video URL with Movi Player directly in Chrome.

## Features

- **Play button overlay** on video links detected on any page
- **Right-click context menu** → "Open with Movi Player" on any link
- **Popup** to paste and play any video URL
- Supports: MP4, MKV, WebM, MOV, TS, AVI, HLS (`.m3u8`), MPEG-DASH (`.mpd`), HEVC, AV1, HDR

## Setup

```bash
# 1. Build movi-player dist
cd ..
npm run build:ts

# 2. Copy dist into extension
cp -r dist chrome-extension/dist

# 3. Add icon files (16x16, 48x48, 128x128 PNG) to icons/

# 4. Load in Chrome
#    → chrome://extensions
#    → Enable "Developer mode"
#    → "Load unpacked" → select this folder
```

## How it works

- **Content Script** scans every page for `<a>` tags with video extensions (.mp4, .mkv, etc.) and adds a play button
- **Background Script** handles context menu clicks and opens player tab
- **Player Page** loads `movi-player` element with the video URL — full controls, seek, subtitles, HDR
- **No server needed** — everything runs locally in the browser via WASM

## COOP/COEP Note

SharedArrayBuffer requires COOP/COEP headers. The extension's player page runs in an extension context where these are available. For cross-origin videos, the extension fetches via its own context which bypasses CORS restrictions.
