# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta.1] - 2026-04-05

### Added
- Chrome Extension: popup with "Paste & Play" (clipboard) and "Play from Computer", context menu on video links, play button overlay on detected URLs, drag & drop player page.
- Memory usage in nerd stats (Chrome only).
- Portrait video detection for timeline thumbnails.

### Changed
- Context menu: "Stats for nerds" moved to bottom.
- Extension popup: complete redesign with card layout, no input box.
- Extension build script copies only element.js (6.5MB vs 40MB+).

### Fixed
- Nerd stats close button z-index (was behind graph on mobile).
- Nerd stats graph canvas auto-resize to container width.
- Nerd stats graph hidden when player height < 300px.
- Mobile controls: compact buttons (34px), smaller icons, tighter layout.
- Timeline/thumbnail rotation: negative margin trick for proper container fit.
- Portrait thumbnails in timeline use width constraint instead of height.
- Timeline position syncs with controls show/hide (smooth transition).
- Subtitles stack above timeline when both visible.
- Focus restored after closing timeline, resume dialog, nerd stats.
- "Start Over" now seeks to 0:00.
- Network/disk speed resets to 0 after 1s idle (fixes stale graph on pause).
- Seek thumbnail rotation margin re-applied on each hover.

## [0.2.0] - 2026-04-05

### Added
- **Stable Volume**: DynamicsCompressorNode for loudness normalization (YouTube-like). Opt-in via `stablevolume` attribute. Smooth gain transitions, AudioContext auto-recovery, gap filling on underrun.
- **Nerd Stats**: Press `I` for comprehensive overlay — codec, resolution, FPS, decoder type, buffer health, color info, and live network/disk activity graph.
- **Timeline**: Press `T` for auto-generated thumbnail strip. Chapter-aware when video has chapters. 20 thumbnails, click-to-seek.
- **Chapter Support**: Extract chapters from video metadata (FFmpeg WASM). Chapter markers on progress bar, chapter titles in seek tooltip.
- **Video Rotation**: Press `R` to rotate 90. Metadata rotation auto-applied. Thumbnails and seek previews sync with rotation.
- **Keyboard Shortcuts Panel**: Press `?` to view all shortcuts in a two-column overlay.
- **Resume Playback**: Opt-in via `resume` attribute. Saves position to localStorage, shows "Resume / Start Over" dialog on reload.
- **Encrypted Playback**: AES-256-GCM chunked encryption with HMAC-SHA256 signed requests, one-time nonces, IP + fingerprint binding. Configurable via HTML attributes (`encrypted`, `tokenurl`, `videourl`, `videoid`) or `loadEncrypted()` API.
- **Browser Fingerprint**: Canvas, WebGL, screen, timezone based fingerprint for token binding.
- **Encrypted Server Example**: Node.js Express server with encrypt CLI, multi-video support, chunked on-demand decryption (~2MB RAM per request).
- **Subtitle Shift**: Subtitles move up smoothly when controls are visible.
- **Continuous Double-tap Seek**: YouTube-like mobile behavior with cumulative OSD.
- **Auto-focus on Hover**: Keyboard shortcuts work without clicking the player.

### Changed
- Stable volume is now opt-in via `stablevolume` attribute (not enabled by default).
- Loop and stable volume icons use filled/outline toggle pattern (like subtitle CC button).
- Nerd stats includes quality label, pixel format, color range/primaries/transfer, language, subtitle info.
- README rewritten — concise, no repetition, clear value proposition and comparison table.

### Fixed
- Subtitle track switch now seeks to current position to pick up subtitle packets.
- Thumbnail 403 errors now retry with exponential backoff instead of fatal failure.
- Audio starvation threshold increased to 2s, requires empty buffer before triggering.
- Removed starvation-based rebuffering (caused false buffering during thumbnail generation).
- Fullscreen Escape key closes overlays (context menu, shortcuts, stats) before exiting fullscreen.
- 180 rotation now renders at full size (was shrinking due to resize logic).
- EncryptedHttpSource buffer progress bar shows real-time download progress.

## [0.1.5] - 2026-02-15

### Added
- Pitch preservation for playback rate changes
- Pitch preservation support for HLS playback
- MediaSession API integration for background playback and media controls
- HTTPS support for local development environment

### Changed
- Simplified error messages to be more concise and consistent
- Replaced all hardcoded purple colors with CSS variables (--movi-primary) for full theme customization
- Enhanced center play button with theme color by default
- Center play button now displays with colored glow and border initially (not just on hover)
- Improved visual prominence of play button when autoplay is disabled
- Updated loading spinner with responsive sizing and theme-aware colors
- All UI elements now use CSS variables for consistent theming

### Fixed
- Improved playback stability with enhanced error handling and timeout management
- Resolved audio-video sync issues with hardware decoding
- Distinguished 403/401/404 errors from CORS errors for better error reporting
- CORS errors now propagate immediately instead of waiting for timeout
- Title bar z-index now properly positioned below control menus in mobile view
- Fixed menu accessibility issue where speed/subtitle menus appeared behind title
- Center play button backdrop blur now enabled on mobile/touch devices
- Center play button icon visibility fixed using visibility instead of display property
- Center play button icon color now properly displays in both dark and light themes
- Progress handle (seekbar tip) now uses theme color variables
- Controls no longer auto-hide when menus are open on mobile
- Loading spinner now theme-aware and visible on all backgrounds

### Documentation
- Added SoundTouch third-party license attribution

## [0.1.5-beta.0] - 2026-02-11 (unreleased)

### Changed
- Enhanced center play button with purple theme color by default
- Center play button now displays with purple glow and border initially (not just on hover)
- Improved visual prominence of play button when autoplay is disabled
- Updated both dark and light theme styles for consistent purple accent
- Applied purple styling to mobile and desktop versions

### Fixed
- Mobile touch device hover states now properly display purple theme colors

## [0.1.4] - 2026-02-11

### Fixed
- Resolved video stalling during playback and improved A/V sync
- Playback speed changes now take immediate effect on audio
- Auto-unmute when volume slider is moved while muted
- Mute button now correctly toggles audio muting

## Previous Versions

See git commit history for changes in versions prior to 0.1.4.
