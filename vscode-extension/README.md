# Movi Player VS Code Extension

Play any video file with Movi Player directly inside VS Code.

## Features

- **Right-click any video file** in the Explorer → "Movi: Play with Movi Player"
- **Command Palette** → `Movi: Open Video File` to pick a file
- **Command Palette** → `Movi: Open Video from URL` to play a remote URL
- **Drag & drop** videos into the player panel
- Supports: MP4, MKV, WebM, MOV, TS, AVI, HLS, HEVC, AV1, HDR

## Setup (development)

```bash
# 1. From repo root, build movi-player dist
cd ..
npm run build:ts

# 2. Build extension (compiles TS + copies player bundle)
cd vscode-extension
./build.sh

# 3. Open this folder in VS Code, press F5
#    A new VS Code window opens with the extension loaded.
#    Run "Movi: Open Video File" from the command palette.
```

## Packaging

```bash
npm install -g @vscode/vsce
vsce package
# produces movi-player-vscode-X.Y.Z.vsix
```

Install the `.vsix` via Extensions panel → `…` menu → "Install from VSIX".

## How it works

- **Webview Panel** hosts the `<movi-player>` custom element with full controls, seek, subtitles, HDR
- **Local files** are served via `webview.asWebviewUri()` — VS Code's secure resource scheme
- **No server needed** — everything runs locally via WASM
- **Settings** (autoplay, ambient mode, resume) configurable via VS Code settings under "Movi Player"

## Why webview?

VS Code can't natively play formats like MKV, HEVC, AV1, or HDR content. The webview gives us a sandboxed Chromium where we run the same WASM-based decoder pipeline as the Chrome extension and the npm package.
