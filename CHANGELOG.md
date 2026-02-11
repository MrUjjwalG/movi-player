# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5-beta.0] - 2026-02-11

### Changed
- Replaced all hardcoded purple colors with CSS variables (--movi-primary) for full theme customization
- Enhanced center play button with theme color by default
- Center play button now displays with colored glow and border initially (not just on hover)
- Improved visual prominence of play button when autoplay is disabled
- Updated loading spinner with responsive sizing and theme-aware colors
- All UI elements now use CSS variables for consistent theming

### Fixed
- Title bar z-index now properly positioned below control menus in mobile view
- Fixed menu accessibility issue where speed/subtitle menus appeared behind title
- Center play button backdrop blur now enabled on mobile/touch devices
- Center play button icon visibility fixed using visibility instead of display property
- Center play button icon color now properly displays in both dark and light themes
- Progress handle (seekbar tip) now uses theme color variables
- Controls no longer auto-hide when menus are open on mobile
- Loading spinner now theme-aware and visible on all backgrounds

## [0.1.5] - 2026-02-11 (unreleased)

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
