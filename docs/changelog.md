# Changelog

All notable changes to Movi-Player will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-02-10

### Added
- **Documentation**: Added comprehensive CORS & Headers section to README and Getting Started guide
- **Documentation**: Added Service Worker workaround for COI headers when server modification is not possible
- Service Worker example code for injecting Cross-Origin-Isolation headers client-side
- **New Property**: `gesturefs` attribute to restrict touch gestures (tap/swipe/pinch) to fullscreen mode only
- **New Property**: `nohotkeys` attribute to disable all keyboard shortcuts for playback control
- **New Property**: `startat` attribute to start playback at a specific timestamp (in seconds)
- **New Property**: `fastseek` attribute to enable fast seek controls (±10s skip buttons, keyboard shortcuts, double-tap)
- **New Property**: `doubletap` attribute to enable/disable double-tap to seek gesture
- **New Property**: `themecolor` attribute to customize player UI primary color
- **New Property**: `buffersize` attribute to set custom buffer size in seconds
- Loop functionality with toggle button in control bar and context menu

### Changed
- Improved visibility of server requirements for WebAssembly and SharedArrayBuffer usage

### Fixed
- WebGL context loss handling on mobile minimize/restore
- Touch control edges secured to prevent conflict with system gestures

## [0.1.3] - 2025-01-XX

### Fixed
- Improved seek behavior and stabilized buffer visualization
- Fixed hanging in seeking state
- Deferred buffer window creation until network response in source handling
- Updated fast seek icons and poster logic

### Added
- Robust retry logic and buffering state for unstable network connections
- Enhanced mobile experience with new control properties

### Changed
- Updated showcase GIF and documentation
- Documented 'auto' decoder mode and seamless fallback UX

## [0.1.2] - 2024-12-XX

### Added
- Initial public release
- WebCodecs + FFmpeg WASM decoding
- HDR detection and rendering support
- Modular design (demuxer, player, element)
- Multi-track audio/subtitle support
- Canvas-based rendering
- Local file playback support
- Professional UI with built-in controls

### Supported Formats
- **Containers**: MP4, MKV, WebM, MOV, MPEG-TS, AVI, FLV, OGG
- **Video Codecs**: H.264, H.265/HEVC, VP8, VP9, AV1
- **Audio Codecs**: AAC-LC, MP3, Opus, Vorbis, FLAC, PCM, AC-3, E-AC-3
- **Subtitles**: WebVTT, SubRip (SRT), SubStation Alpha (ASS), HDMV PGS, DVD SUB, DVB SUB

---

## Version History

- **0.1.4** - CORS documentation improvements
- **0.1.3** - Seeking fixes and network stability
- **0.1.2** - Initial public release
