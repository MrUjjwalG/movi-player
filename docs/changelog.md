# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-04-26

### Added
- **`postertime` Attribute**: Generate a native-resolution poster from any timestamp without an explicit `poster` URL. Accepts `"10%"`, `"5"`, `"1:30"`, or `"0:01:30"`. Uses an isolated thumbnail pipeline (WASM + `ThumbnailBindings`), respects rotation metadata, and is race-guarded so in-flight generators can't paint stale frames after a `src` change.
- **`dispose()` Method**: Tears down the internal player and resets transient UI (subtitles, timeline, time, title, generated poster) back to the no-source state. Called automatically on every `src` change so playlist-style flows never leak state between sources. Safe to call when nothing is loaded.
- **`playing` Getter**: Read-only boolean that's `true` only while the player is actively playing — distinguishes it from `ready`, `loading`, `seeking`, and `buffering` states (precise inverse of `paused`).
- **`MoviElement.cleanVideoTitle(filename)` Static**: Utility exposed for playlist UIs to derive the same cleaned title the player uses internally — useful for computing the resume localStorage key (`movi-resume:<cleanVideoTitle(name)>`).
- **Folder Playlist (web demo app)**: Sidebar/below-player playlist via File System Access API (with `webkitdirectory` fallback). YouTube-style items with thumbnail, duration, HDR chip, codec/quality/size meta, and watched-progress bar. Lazy thumbnail generation, natural-sort, autoplay-next toggle, drag-and-drop multi-file support.

### Changed
- **`play()` Semantics**: Now queues a play intent during `isLoading` and flushes it from `initializePlayer()`'s finally block — matches `HTMLMediaElement` behavior. Previously bailed silently when called during load.
- **Software Decoder Fallback Per-Source**: Choosing "Try software" no longer sticks across `src` changes. The next video gets a fresh hardware-decode attempt; the `sw` attribute is cleared on dispose.
- **Encrypted Playback Protocol**: `EncryptedHttpSource` rewritten — block prefetch high-water/low-water tuning, concurrent-stream cap, `getPosition()` reports the real read cursor, and parent position field is kept in sync so buffer math stays honest. Encrypted-server ported to match the new protocol.
- **Buffer Tuning**: Runtime tuning of prefetch high-water, refill threshold, and block cache cap via the existing `buffersize` attribute. README/docs corrected to clarify the value is in **megabytes** (not seconds) and applies to both HTTP and encrypted sources.
- **Production Bundles**: Re-enabled terser `drop_console` and `drop_debugger` so release builds ship without dev-only logging.
- **Build Stability**: `app:release` script ties build + R2 upload + worker deploy into a single command. Build version cache-bust scoped to the quoted `__BUILD_VERSION__` literal so unrelated lines aren't rewritten.

### Fixed
- **Post-Seek A/V Sync**: Cap the post-seek audio gap at 200ms — when the first video frame after a seek arrives late (sparse keyframes / slow HEVC+HDR decoders), sync the clock to video time and drop stale audio instead of syncing to the earliest audio packet. Small gaps still prefer audio for continuity.
- **Pre-Play Seek Position**: Scrubbing the timeline before pressing play no longer resets to 0 — the first-play poster-seek now reads `clock.getTime()` instead of a hardcoded start time. Pipeline is flushed on user seek so prebuffered start audio doesn't briefly play before jumping to the target.
- **Fully-Cached Buffered Duration**: Buffered range now reports the full media duration when the file is fully cached, instead of stopping at the last network read.
- **Buffer Indicator Race**: Collapsed the seek-race scan sweep that could draw a phantom buffered range mid-seek.
- **Encrypted Thumbnails**: Share the main source for thumbnail reads instead of opening a parallel session — cuts redundant token churn. Concurrent stream cap prevents seek-storm thrash. Hardened thumbnail read failures (no more fragile retry/cooldown loop).
- **Worker `/proxy` Empty 206**: Retry empty 206 responses from upstream before streaming back, so transient origin hiccups don't surface as broken playback.
- **Worker Probe Failures**: Transient probe errors no longer get misreported as `415 Unsupported Media Type`.
- **TMDb Title Parser**: Detect TV shows when the episode title trails the `SxxExx` code (e.g., `Show.S05E01.Title`).

### Security
- **Worker Referer Allowlist**: `/proxy` and `/eproxy` endpoints now gate requests by Referer to block hotlinking from unauthorized origins.
- **Worker Magic-Byte Validation**: `/proxy` responses are validated against expected media magic bytes before being streamed back, mitigating MIME confusion attacks.

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

## [0.2.0] - 2026-04-09

### Added
- **Ambient Mode**: Dynamic letterbox glow that samples video colors in real-time. Smooth 60fps color transitions via WebGL clearColor. Toggle with `G` key or context menu. Works in fullscreen (letterbox) and normal mode (external wrapper). `ambientmode` attribute.
- **Split Source Support**: Separate video, audio, and subtitle file URLs via `videosrc`, `audiosrc`, `subtitlesrc` attributes.
- **PGS Image Subtitles**: Bitmap subtitle decoding with zlib decompression support.
- **Network Disconnect Recovery**: Intelligent CORS vs transient network failure detection (3-strike threshold). Online-event-aware backoff for instant retry on reconnection. Auto re-seek on recovery. 30s timeout on offline wait.
- **Document Picture-in-Picture**: Floating video window with play/pause, seek, mute, progress bar, time display, keyboard shortcuts, and back-to-tab button. Portrait video sizing. Rotation save/restore on PiP enter/exit.
- **DRM Support**: `drm` and `licenseurl` attributes for HLS streams with Widevine/FairPlay via EME API.
- **HLS Quality Menu**: Duplicate resolutions show bitrate (e.g., "1080p · 5000 kbps").
- **HLS Nerd Stats**: Video codec, resolution, quality, frame rate, bitrate, buffer, HLS level, bandwidth, live latency, frames decoded/dropped.
- **VLC-style Shortcuts**: `V` subtitles, `B` audio, `+/-` speed, `L` loop, `U` stable volume, `H` HDR, `P` PiP, `G` ambient, `A` aspect ratio.
- **Aspect Ratio Controls**: `A` key cycles contain/cover/fill/zoom. Sub-menu with icons in context menu and bottom controls.
- **Stable Volume**: DynamicsCompressorNode for loudness normalization. Opt-in via `stablevolume` attribute.
- **Nerd Stats**: Press `I` for codec, resolution, FPS, decoder type, buffer health, color info, and live network/disk activity graph.
- **Timeline**: Press `T` for auto-generated thumbnail strip with chapter support. Arrow key navigation, click-to-seek.
- **Chapter Support**: Extract chapters from video metadata. Chapter markers on progress bar, chapter titles in seek tooltip.
- **Video Rotation**: Press `R` to rotate 90°. Metadata rotation auto-applied. Disabled during PiP.
- **Keyboard Shortcuts Panel**: Press `?` to view all shortcuts.
- **Resume Playback**: `resume` attribute saves position to localStorage with resume/start-over dialog.
- **Encrypted Playback**: AES-256-GCM chunked encryption with HMAC-SHA256 signed requests.
- **Background Audio**: Video keeps playing audio when tab is in background via Web Worker timer fallback.
- **Chrome Extension**: Popup with "Paste & Play" and "Play from Computer", context menu on video links, play button overlay on detected URLs.
- **Privacy Policy**: Published at docs site for Chrome Web Store compliance.

### Changed
- Buffering state now stops presentation loop so frames accumulate for reliable recovery.
- Buffering exit requires video frames ready (with 3s fallback for async decoder delays).
- Pause during buffering allowed from all UI controls (click, keyboard, buttons, PiP, context menu).
- `buffering → ended` state transition allowed for EOF during rebuffer.
- Invalid packet size at EOF treated as EOF (not fatal error) for FFmpeg stale buffer data.
- HDR icon changed to text badge style in OSD and context menu (matches bottom controls).
- Extension description rewritten to remove excessive format keywords (Chrome Web Store compliance).
- Console logs dropped in production build.

### Fixed
- Hardware decoder error recovery with keyframe cache and software fallback.
- Seek and play/pause during buffering state.
- Network disconnect causing permanent CORS misclassification when `navigator.onLine` lags.
- Stale stream loops from leaked online event listeners during backoff.
- Multiple concurrent fetch loops after network recovery.
- Clock advancing during buffering (presentation loop consuming frames).
- PiP rotation clipping — rotation reset on PiP enter, restored on close.
- PiP portrait video oversized — height-limited sizing for portrait aspect ratios.
- Pause-seek loading stuck — `VideoDecoder.flush()` 1s timeout with reset+reconfigure fallback.
- EOF not triggering — relaxed condition with 0.5s tolerance.
- PiP canvas restore using `shadowRoot` directly.
- PiP frame freeze on tab switch with `isPiPActive` guard.
- EncryptedHttpSource network resilience matching HttpSource.
- Nerd stats graph fullscreen positioning and CSS specificity.

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
- Updated loading spinner with responsive sizing and theme-aware colors

### Fixed
- Improved playback stability with enhanced error handling and timeout management
- Resolved audio-video sync issues with hardware decoding
- Distinguished 403/401/404 errors from CORS errors for better error reporting
- CORS errors now propagate immediately instead of waiting for timeout
- Title bar z-index now properly positioned below control menus in mobile view
- Center play button backdrop blur now enabled on mobile/touch devices
- Controls no longer auto-hide when menus are open on mobile

## [0.1.4] - 2026-02-11

### Fixed
- Resolved video stalling during playback and improved A/V sync
- Playback speed changes now take immediate effect on audio
- Auto-unmute when volume slider is moved while muted
- Mute button now correctly toggles audio muting

## Previous Versions

See git commit history for changes in versions prior to 0.1.4.
