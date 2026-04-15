# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-04-16

### Added
- **Persistent Preferences**: `stableVolume`, `ambientMode`, and `hdr` toggles now persist via OPFS alongside `volume`, `muted`, and `playbackRate`. User toggles win over HTML attribute defaults on subsequent loads.
- **Split-Source Volume Control**: Volume button now visible when a separate native audio element is loaded, even if the video file has no muxed audio track.
- **Smart Title Extraction**: VLC-style filename cleaning strips release tags, codecs, and quality markers from tab titles. `Content-Disposition` filename used when the server provides one.
- **Chrome Extension**: Local file playback via popup file picker, drag-and-drop onto the player page, and a redesigned popup layout.

### Changed
- **Context Menu**: Slide-panel variant now only used on touch devices (`pointer: coarse`); narrow desktop windows get the regular hover-driven menu.
- **Context Menu Scrolling**: Max-height clamped to player height with subtle scrollbar styling so tall menus stay accessible on short players.
- **Theme Color Cascade**: `themecolor` attribute now flows to `--movi-primary-light` and `--movi-primary-dark` via `color-mix`, so active menu items and highlights follow the custom theme.
- **`title` Attribute**: No longer triggers the browser's native tooltip on hover — title is rendered only by the in-player overlay.
- **Subtitle/Audio Track Menus**: Show language codes alongside track labels for clarity.

### Fixed
- **Short Video Stutter**: Prebuffer media before `ready` so `play()` doesn't immediately stall on short clips.
- **Background Audio at 50/60 fps**: Skip video decode while hidden so audio keeps flowing on high-fps content.
- **Narrow Viewport Controls**: Buttons, gaps, and center play button tightened on viewports ≤ 480px to prevent the controls bar from overflowing the player box on iPhone 12 Pro-class widths.
- **Empty State Placement**: "No Video" placeholder no longer clips into the controls bar on short/narrow players.
- **OSD Speed Icon**: Correct speed icon shown when playback rate changes via hotkeys/context menu.

## [0.2.0-beta.3] - 2026-04-07

### Added
- **Document Picture-in-Picture**: Floating video window with play/pause, seek, mute, progress bar, time display, keyboard shortcuts, and back-to-tab button. Chromium 116+.
- **DRM Support**: `drm` and `licenseurl` attributes for HLS streams with Widevine/FairPlay via EME API. Native `<video>` element used in DRM mode.
- **HLS Nerd Stats**: Video codec, resolution, quality, frame rate, bitrate, buffer ahead, HLS level, bandwidth estimate, live latency, stream type, frames decoded/dropped.
- **HLS Quality Menu**: Duplicate resolutions now show bitrate (e.g., "1080p · 5000 kbps"). Wider menu for longer labels.
- **VLC-style Shortcuts**: `V` subtitles, `B` audio, `+/-` speed, `L` loop, `U` stable volume, `H` HDR, `P` PiP. Context menu shows shortcut labels.
- **Aspect Ratio Controls**: `A` key cycles contain/cover/fill/zoom. Sub-menu with icons in context menu and bottom controls.
- **Subtitle/Audio Track Cycling**: `V`/`B` keys cycle with OSD showing track number and language.
- **Timeline Keyboard Navigation**: Arrow keys to navigate thumbnails/chapters, Enter to seek, Escape to close.
- **Resume Dialog Keyboard**: Arrow keys to toggle Resume/Start Over, Enter to confirm, Escape to dismiss. Visual focus indicator.
- **PiP in Context Menu**: Picture-in-Picture option with `P` shortcut.
- **Network Recovery**: Stall detection with 500ms grace period, auto-resume on buffer data, offline/online distinction for CORS errors.

### Changed
- Extension context menu simplified to single "Open with Movi Player" on all links.
- Extension removed `gesturefs` attribute for gesture support.
- Smart title extraction: `.m3u8`/`.mpd` URLs use parent path segment instead of filename.
- HLS error handling: 404/403 errors show instant error (no infinite retry). Max 3 network retries, 2 media retries.
- "Try Software Decoding" button hidden for network errors.
- Console logs dropped in production build (terser `drop_console`).
- PiP button disabled initially like other controls.

### Fixed
- **Pause-seek loading stuck**: `VideoDecoder.flush()` hanging on slow devices — 1s timeout with reset+reconfigure fallback.
- **EOF not triggering**: Relaxed condition to end when time reaches duration (0.5s tolerance) or all queues empty.
- **PiP canvas restore**: Use `shadowRoot` directly instead of `parentElement` (ShadowRoot is Node, not Element).
- **PiP frame freeze on tab switch**: `isPiPActive` guard on `document.hidden` frame dropping.
- **Network disconnect**: `navigator.onLine` check before treating fetch errors as CORS.
- **Seek loading**: `currentTime` setter allows seeking from `seeking`/`buffering` states. 3s seek timeout forces completion.
- **Timeline first-open**: Retry thumbnail pipeline init if first attempt failed.
- **Timeline position**: CSS-based controls-aware positioning (125px above controls).
- **Timeline thumbnail rotation**: Use `naturalWidth/Height` for hidden elements. Metadata rotation considered for portrait detection.
- **Seek thumbnail z-index**: Hidden when timeline is open to prevent overlap.
- **EncryptedHttpSource**: Network resilience matching HttpSource (retry, offline recovery, speed idle reset).
- **Closed frame warning spam**: Silenced at EOF (normal behavior).
- **Nerd stats graph**: Fixed fullscreen positioning, CSS specificity for graph canvas.
- **HLS resolution 0x0**: Read actual level from HLS.js instead of Auto track.

## [0.2.0-beta.2] - 2026-04-06

### Added
- Background audio playback: video keeps playing audio when tab is in background. Uses setInterval fallback when requestAnimationFrame stops.

### Fixed
- Video frames silently dropped in background (prevents WebGL errors that would stop audio).
- AudioContext resumed on tab hide to prevent suspension.
- Background interval cleaned up on pause/destroy.
- Network/disk activity graph: canvas auto-resize, roundRect compatibility fix, proper hide threshold.

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
