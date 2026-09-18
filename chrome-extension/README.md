# Movi Player Chrome Extension

Play any video URL with Movi Player directly in Chrome.

For real Chrome Web Store screenshots, promotional tiles, and the repeatable
capture workflow, see [STORE-ASSETS.md](./STORE-ASSETS.md).

This folder is also the **source of truth for the Firefox add-on** — everything
except `manifest.json` is copied into [`../firefox-extension/`](../firefox-extension/)
by its `build.sh`. Keep changes here browser-agnostic (no bare `window.chrome`
checks, no unconditional `chrome://` links); see the settings block at the
bottom of `player.js` for the pattern.

## Features

- **ChromeOS Files app** — the extension registers as a file handler, so
  double-clicking a video in Files opens it here (multi-select becomes a
  playlist). ChromeOS + Chrome 120 or newer; everywhere else the code is inert
- **Next / Previous in the player** — a folder or multi-select is handed to the
  element's own queue, so the bar gets skip buttons, Shift+N / Shift+P work, and
  the OS media keys and lock screen carry the skip pair. The items are src-less:
  the element owns the controls, this page still does the loading
- **Works in incognito** — `"incognito": "split"`, so the player page opens in
  the incognito window it was launched from rather than being pushed into a
  normal one. Still has to be allowed at `chrome://extensions` first
- **Play button overlay** on video links detected on any page
- **Right-click context menu** → "Open with Movi Player" on any link
- **Toolbar icon** opens the player page — pick files, paste a link, and the
  two settings all live there (there is no popup)
- **Back arrow in the title bar** returns to that picker without losing what is
  playing — close it or press Escape to go back to the video, and it picks up
  where it left off if it was running. Not shown in fullscreen
  (`titlemode="back-windowed"`), where the title still is
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

## The `file_handlers` warning

Loading this on anything but ChromeOS puts a warning on the extension's card:

> `'file_handlers'` is only allowed for packaged apps, but this is a extension.

It is a warning, not a load failure, and the key is deliberate. `file_handlers`
was a packaged-app key first; ChromeOS 120 opened it to extensions so they can
appear in the Files app's "Open with". Desktop Chrome has no extension-side
implementation, falls back to the old apps-only check, and says so. The key
does nothing there and breaks nothing.

It stays in the one package on purpose: ChromeOS users install the same Chrome
extension as everyone else, and a second ChromeOS-only build would be two
packages to keep in step for one manifest key. **Don't delete it to silence the
warning** — that is the ChromeOS Files app integration.

## COOP/COEP Note

SharedArrayBuffer requires COOP/COEP headers. The extension's player page runs in an extension context where these are available. For cross-origin videos, the extension fetches via its own context which bypasses CORS restrictions.
