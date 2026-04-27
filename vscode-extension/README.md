# Movi Player for VS Code

Play modern video formats directly inside VS Code — **MKV, HEVC, AV1, HDR, WebM, MOV, TS** and more, including formats VS Code can't natively handle.

100% local. Nothing uploaded. Powered by FFmpeg WebAssembly + WebCodecs hardware decoding.

## Usage

- **Single-click any video file** in the Explorer (`.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.ts`, `.flv`, `.wmv`, `.m4v`, `.3gp`, `.mpg`, `.mpeg`, `.m2ts`, `.hevc`, `.265`) — opens directly in Movi Player
- **Right-click any file → "Open With…" → "Movi Player"** — works for any extension (try with `.iso`, `.vob`, etc.)
- **Command Palette** (`Cmd+Shift+P`):
  - `Movi: Open Video File` — file picker
  - `Movi: Open Video from URL` — paste a remote video URL

## Supported formats

**Containers:** MP4, MKV, WebM, MOV, TS/M2TS, AVI, FLV, WMV, MPG/MPEG, 3GP

**Video codecs:** H.264, HEVC (H.265), AV1, VP9, VP8 — hardware-accelerated where available

**Audio codecs:** AAC, Opus, FLAC, MP3, AC3, Vorbis — software fallback

**HDR:** HDR10 / HLG / Dolby Vision profile 8 (on supported displays)

## Settings

| Setting | Default | Effect |
|---|---|---|
| `movi.ambientMode` | `true` | Color glow around the video |
| `movi.resume` | `true` | Resume playback from last position |

## Limitations

VS Code's webview sandbox restricts a few features that work in the [Chrome extension](https://chromewebstore.google.com/detail/movi-player/ckleeigcopjnpehkjokijokjegknfgej):

- **Fullscreen** is disabled (Permissions-Policy denies `requestFullscreen` in webviews)
- **Picture-in-Picture** is hidden (same reason)
- **SharedArrayBuffer** is unavailable, so FFmpeg runs single-threaded — slightly slower demuxing on very large files (8K HDR streams). Hardware video decode is unaffected.

For full feature parity (including fullscreen + PiP), use the Chrome extension or [movi-player web app](https://mrujjwalg.github.io/movi-player/).

## Privacy

Everything runs locally inside VS Code's sandboxed webview. No uploads, no telemetry, no servers. Your video files never leave your machine.

## Links

- 📦 [movi-player on GitHub](https://github.com/MrUjjwalG/movi-player)
- 📖 [Documentation](https://mrujjwalg.github.io/movi-player/)
- 🐛 [Report a bug](https://github.com/MrUjjwalG/movi-player/issues)
- 🛒 [Chrome extension](https://chromewebstore.google.com/detail/movi-player/ckleeigcopjnpehkjokijokjegknfgej)

---

Made with 💜 by [mrujjwalg](https://github.com/MrUjjwalG)
