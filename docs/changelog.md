# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-09-22

### Added
- **Playlist / queue**: `playlist` + `autoadvance` — Next/Previous, `Shift+N`/`Shift+P`, and lock-screen/headset skip, all wired up for free. A `src`-less item hands loading back to the host while the element keeps the transport controls.
- **Take over the `<video>` elements a page already has**: `upgradeVideoElements()` (or a zero-JS `data-upgrade` script tag) drops a `<movi-player>` in place of an existing `<video>` or video.js instance, carrying over its attributes and children and keeping the old element as a live proxy so existing page scripts keep working.
- **`thumb="precise"`**: walks from the keyframe to the exact hovered frame instead of showing the keyframe before it — the fix that matters on long-GOP downloads. On by default in the extensions and the web app now.
- **Thumbnail tracks read the video.js/JW Player way** (`<track kind="metadata" label="thumbnails">`), replacing the old bespoke `storyboard` attribute; a `storyboard` property still covers a board worked out at runtime.
- **A top-right corner control placement** (`placement: "top"`) for session-level controls (cast, share, close), a **centred bar control** (`placement: "center"`), and **fullscreen-only controls** (`screen:`).
- **External subtitle files from a picker**: `addSubtitleTrack()` / `addSubtitleFile()` and a `subtitlepicker` menu row load an SRT/VTT/TTML file sitting next to the video, no reload required.
- **DRM-protected content says so**: shows "Protected Video" with a plain explanation instead of a generic error, and plays through a packager's clear lead instead of stalling and retrying forever.
- **Google Drive picker** no longer scrolls the page away when it opens, and resumes playback automatically when closed.
- **ChromeOS Files app integration and lock-screen skip** for the Chrome extension.
- **Firefox extension and Chrome's toolbar icon** open the full player page directly instead of a popup, and both work from an incognito/private window.
- **In-player debug console** gets a level filter and search.
- **A centred bar control** (`placement: "center"`) and **fullscreen-only controls** (`screen: "fullscreen" | "windowed"`).
- **`spinnerdelay` takes two numbers** — a mid-play stall's wait, then the opening's (`spinnerdelay="0.25 1"`).
- **`smoothwarning`**: one attribute shows "This video (or audio) may not play smoothly" in plain language — including "it plays fine at normal speed" when the speed is the cause — on load and on every speed change; a cancelable `smoothwarning` event lets a page show its own.
- **Ask whether something will play smoothly**: `MoviElement.canPlaySmoothly(url | file | query, { rate })`, `element.canPlaySmoothly()`, and `MoviPlayer.assessPlayback()` — `playable`, `smooth`, `powerEfficient`, which decoder would carry it, and plain-language `reasons`. The same judgement the player uses to pick a rendition, plus a hardware ceiling at 8K60.
- **A build a plain `<script>` tag can load**: `dist/element.global.js` and `dist/element.slim.global.js` (subpaths `movi-player/element/global`, `/element/slim/global`); `jsdelivr`/`unpkg` point at it, so a CDN's default install snippet works as printed.
- **Seamless loop**: a video-only file turns over without a black frame or freeze. `loop` gained a grammar — bare/`one` repeats the item, `loop="all"` the queue, a number is the gap between items — plus a `loop` event and `loopCount`.
- **`shuffle`**: the queue in a random order, a fresh order each pass, `reshuffle()`, `shufflechange`.
- **Shuffle and repeat in the playlist panels** of the Chrome/Firefox extensions and the web app, driven by the element so the panel and the context menu can't disagree.
- **Auto English captions, made in the browser.** Two APIs make it possible and the web app puts them together. `decodeAudio()` hands back the soundtrack as 16 kHz mono samples — the shape speech models take — from any point in the file, without playing it and on its own WASM instance, so a player already playing is not disturbed. `appendSubtitleCues()` writes a subtitle track as lines arrive, in any order, and shows a cue straight away if it covers the current moment; with `pending: true` the track is listed before its first line, with a turning ring where its language badge goes, and `removeSubtitleCues()` takes it away again. In the web app, "Auto captions" in the right-click menu puts "English (auto)" in the subtitle list at once, turning until its first line is ready (and gone again, with a note, if the video has no speech), and runs Whisper (base, through transformers.js) in a worker on 30-second windows and adds what it hears as "English (auto)" — translating when the speech isn't English. It starts at the playhead, follows a seek, rests once 90 seconds ahead, and fills in whatever was skipped; lines are cut to readable length and laid over the stretches that actually have voice in them, and the loops a small model falls into on music ("I'm not a man, I'm not a man…") are dropped. Silero VAD (2 MB) decides which stretches have someone speaking: a window with no speech never reaches Whisper — a song's 30-second instrumental intro was passed over in 0.2s — words it would invent over music are thrown out, and cues are timed to the voice rather than to whatever is loud. What has been made is kept per video in IndexedDB (a local file by name, size and date; a link by its address), so opening the video again shows its captions straight away without loading the model, and only the parts never reached are made. Nothing leaves the browser except the models, about 80 MB, downloaded once. Measured on a laptop: 30 seconds of speech in 3-10 seconds, with no frames dropped from playback alongside it.
- **Dividers on the control bar are public.** The line between the track controls and the viewing controls can be switched off (`controlslist="nodivider"`), restyled (`--movi-divider-color`, `--movi-divider-width`, `--movi-divider-height`, `--movi-divider-gap`, `::part(controls-divider)`), and used as an anchor (`after: "divider"`). A page can add its own with `addControl({ id, divider: true })`, placed like any control — including inside a capsule with `group` — and as a rule in the context menu with `placement: "menu"`. A divider left with nothing visible on one side of it in its capsule hides itself, so a control unavailable for this source doesn't strand a line at the end of a pill.
- **`posterdelay`**: how long to hold the OPENING poster back, in milliseconds. Default `0` — paint it at once, which is what a player without the attribute has always done. It is for a host that prefetches: when the first frame is already on its way, a poster that appears and is replaced a moment later is a flash the viewer reads as a fault rather than a cover, so a load that finishes inside the wait now shows no poster at all and the picture is simply there. Only the opening poster waits; one replacing a picture already on screen is unaffected.

- **Captions go where the viewer puts them**: drag a subtitle anywhere in the picture and it stays — across seeks, sources and sessions — with a double-click to reset and a hint that says so until the reset is used once. `controlslist="nosubtitledrag"` turns it off.
- **The browser extensions can hand a page's own video to MoviPlayer**: an opt-in toggle replaces a site's `<video>` in place, for a file at a URL only (MSE/DRM streaming sites are left alone), hides the site's own player chrome, and — with site access — adds the CORS header the file's host never sent so the player can read it.
- **The audio strip says where the pointer is pointing**: its scrubber shows the time under the pointer on hover and drag.
- **The home page hands over the install line**: `npm install movi-player`, one click to copy.

- **`resumekey`**: files the resume position under a name the host chooses instead of under the title. The title is the player's guess — two episodes can share one, a corrected title is still the same video, and a source the player cannot name got no resume at all. An id is the host's fact, and being an attribute it is known before the file opens, so the position is offered without waiting for metadata.
- **The takeover brings the site's quality ladder with it.** A `<video>` holds one file — whichever rung the site's player picked — so a page that plainly offered 360/720/1080 used to become a player with one quality and no menu. The qualities are now read from JW's playlist item, from video.js's own player, or from the `<video>`'s `<source>` children, whichever has them. A manifest among them is left out (it has its own ladder inside it), and sources that say nothing about themselves are left alone: an mp4 with a webm beside it is a format fallback, not a choice anyone offered.
- **A toolbar popup for the browser extensions**, the way an ad blocker's icon works: the site you are on, one switch that turns takeover off for it, and the button that opens the full player. The icon only stops to ask where there is something to ask about — on a page with nothing to take over it opens the player directly, as before. Turning it off for a site reloads the page, because the site's own `<video>` elements were replaced and a reload is what hands them back.
- **A site that embeds `<movi-player>` itself now gets CORS from the extension too.** That site's player asks for the bytes, the host that serves them sends no header, and the player falls back to the browser's `<video>` — the thing the site embedded it to avoid. The same headers the takeover asks for are now offered for the URLs a page-owned player declares, whether or not takeover is switched off for that site.
- **Restyle the chrome with `::part()`, and replace the loading ring.** Forty-five parts — every bar button (`::part(button)` hits them all), the progress track, the time, the centre button, the title bar, the poster, the OSD, caption lines and the spinner's box. `<div slot="spinner">` swaps the built-in ribbon for your own while the player still decides when it is up and where it sits; `controlslist="nospinner"` takes the ring away entirely and leaves `is-buffering` / `is-spinner-pending` on the host for a page drawing its own. `::part(error-screen)` and `::part(subtitle)` were documented but missing from the markup — they exist now.
- **Every icon can be replaced**: `setIcon("play", "<svg>…</svg>")`, `null` to restore. All 72 marks have names now (`MoviElement.iconNames`) — including the "Nothing to Play" and error-screen card stacks — and one swap changes the bar, the centre button, the menu and the OSD together. 27 marks that lived inline at a single call site moved into the symbol table to get there — the only drawing left outside it is the loading ribbon, which has a slot instead — and `::part(icon)` reaches every one for size and colour.
- **`data-movi-ignore` keeps a `<video>` native** — on the element or an ancestor, the upgrade and the extensions' takeover leave it alone.
- **Renewed links keep your place** — with `resumekey` unchanged across a `<source>` swap, the player treats it as the same media under new URLs and keeps the position, paused/playing state and speed instead of restarting from 0:00.
- **"This media needs about N Mbps to play"** — under `smoothwarning`, a stall caused by the link (not the device) names the rate the media needs and the rate it is arriving at. The event carries `link: true`, `neededBps`, `measuredBps`.

### Changed
- **The WASM module compiles once and is instantiated many times** — a second player, the preview pipeline, and a post-quality-switch rebuild no longer each pay for their own fetch and compile.
- **Adaptive load-shedding can lift again**: the frame-rate cap for underpowered devices used to engage and never release; it now retests and lifts itself on a sustained healthy stretch.
- **A speed change no longer costs a stall**: already-scheduled audio is re-stretched in place instead of thrown away for a fresh demuxer seek.
- **Auto (adaptive) quality**: fixed a unit bug that read the link estimate 8x too small, a bottom-rung confirm pass that never ran, an ignored persisted link measurement, and a climb into 8K priced off a different stream's throughput.
- **`/embed` runs inside the embedding page's own origin** now (a `srcdoc` iframe) instead of a cross-origin frame that needed CORS headers a host may never send; an old embed explains what happened and offers a one-copy replacement.
- Built against **FFmpeg 9.0.2**.
- **The loading spinner waits before it appears**: `spinnerdelay` defaults to `"1 2"` (a stall after 1s, an opening after 2s) instead of `0`, so a fast local open never flashes a ring. `spinnerdelay="0"` restores the old behaviour.

- **The audio strip keeps its controls**: the strip IS the player, so it no longer thins out at rest, and its title row starts on the same line as the controls under it.
- **Fullscreen ends when the source turns out to be sound alone** — a bar or a sleeve in the middle of a black screen is not what fullscreen was entered for.
- **The settings panel closes on a press anywhere outside it**, like the other popups — including a press on the picture, which now dismisses it and nothing else.
- **The adaptive decode ceiling lasts the session**, not the life of the device.
- The three browser extensions are now called **MoviPlayer**.

- **The takeover looks before it leaps**: the link a `<video>` declares is checked for actual media before the element is replaced, per element rather than per page, so a page whose `<video>` points at an HTML error page or a dead link keeps the player it had.
- **The takeover no longer switches `resume` on.** A resume prompt is something a site asks for; arriving over someone else's player uninvited is not.
- **The next range is fetched while the current one arrives** (at its halfway point), hiding each response's round trip and slow start: 1.88 → 2.12 MB/s delivered on a 2.3 MB/s link.
- **`smoothwarning` speaks from measurement at 1x too**: 5 bad seconds out of 8 (under 75% of the frames) raise it once per source; the "Play at 1x" hint counts the same way. Seconds the host page starved the main thread don't count.
- **The software-decode budget scales with the machine's cores** (600M px/s per 8 threads) instead of one flat figure that warned about files a fast desktop plays perfectly.
- **A script's `play()` with no gesture is treated as autoplay**: a refused sound falls back to muted with "Tap to unmute", and a page-muted start shows the pill.
- **An autoplay source opens without raising the controls** on `src` set or change.
- **Auto aims at the rung the link carries** and probes that rung itself; a refused reading aims the next tick lower, a two-rung jump needs two readings, and a thin buffer still climbs one rung at a time.
- **Picking Auto goes straight to the link's rung**, as a fresh open does.
- **A downshift is decided at half the buffer**, with one short probe, so the switch can prime under a picture still playing.
- **A rung whose in-place climb cannot be primed** is left out of the climb for 30s, then 60s, then at most 120s.
- **The loading light flows like a tide.**

### Fixed
- **The opening poster no longer fades up out of black.** It was faded in over 220ms on every load, and both the host and the canvas are opaque black before the first frame — so what the fade actually did was ramp a thumbnail out of black on every navigation, measured at opacity 0 to 1 across 158ms to 366ms. That reads as a flash, and it lasted as long as the fade rather than as long as the load. It now cuts to the poster, and the fade is kept for the case it was written for: a poster replacing a picture that is already on screen.
- **A prefetched start no longer re-downloads the head it just read.** The pre-play probe reads the head of the rung it is about to open and hands those bytes to the source so it does not fetch the same range again — except when the body came from the browser's cache, where it returned before the handover and the bytes were dropped. Measured on a prefetched open: the probe read the head in 23ms, threw it away, and the open then sat waiting for data for 129ms of a 345ms start.
- **A seek-bar preview no longer keeps downloading after it is on screen.** A hover on a stretch that has not been fetched pulls a 2MB window so a drag's next positions are already in hand, and the picture needs only its first few tens of KB — but the rest kept arriving for nobody once the pointer stopped: measured at 12 Mbit, the preview was up 0.12s into its request and 1.9MB followed over the next 1.5s, four seconds' worth on a 4 Mbit link. The window now stops half a second after the pointer comes to rest, or as soon as the card closes, keeping what has arrived. The seek bar decides it rather than the player, because mid-drag it holds requests back for up to 1.5s on purpose; a drag still fetches exactly as before (the same 2 windows and 7 pictures over the same scrub).
- **A file whose audio ends before its picture now plays to the real end** instead of stopping dead where the sound ran out; also fixed a finished soundtrack read as "starving", a hang seeking into that tail, and a leftover pre-seek frame dragging playback backward.
- **Faster seeking on long-GOP sources**: a seek can land on the keyframe ahead of its target instead of always decoding forward from the one behind it, cutting a 1.2s seek to under 200ms on an 8K60 file.
- A **paused seek that's then played** no longer jumps the picture forward and never heals; a **seek-bar click** no longer restarts playback twice; a seek held open by a **blocked autoplay** no longer freezes the picture with nothing to explain it.
- **Audio-gain glitches after a seek**: a fade/duck race that could park the volume near zero with no way back except reload, now caught by a watchdog that restores the master gain without fighting a fade already in progress.
- **Software-decoded audio** (TrueHD/DTS, etc.) now hands off PCM in ~150ms blocks instead of multi-second ones, so a speed change no longer leaves old-speed audio playing under an already-changed picture.
- **Context-menu submenus** could fail to open on click, flash a stray panel, or reappear after their menu had closed — all from the same portal bookkeeping, fixed together.
- **Seek-bar and thumbnail previews**: scrubbing no longer waits for the pointer to stop, a far hover reuses a Matroska's own index instead of re-bisecting the file, the first HTTP hover reuses bytes already downloaded, and `thumb="precise"` no longer gives up part-way through a long GOP.
- **Auto quality** no longer collapses the whole ladder over a stall the player caused itself, and drops a rung before blaming a link that's still delivering.
- A **missing container duration** now gets a second, unhurried scan after load instead of settling for "0:00" with a dead seek bar.
- **Mobile paste-a-link flow**: more room for the field, a properly sized/centred Play button, and a bar thinned to phone proportions.
- **Native-`<video>`/HLS-DASH-fallback**: event parity with a real `<video>` (`play`/`pause`/`seeking`/`seeked`/`paused`), no volume control on a source with no audio, and a message when the browser silently drops audio it can't decode.
- **Open-GOP (CRA/BLA) streams and transport-stream seeks**: a string of decoder-queue, reference-chain and reorder-tail fixes.
- A control capsule could get permanently marked "empty" by a measurement taken while the bar was hidden.
- **DASH sources**: an audio track no longer lists once per bitrate rendition, dash.js's own thumbnail track is read, and a preview is no longer promised on a source that can't produce one.
- **A discarded tab comes back where it was**: after Chrome's Memory Saver reloads a background tab, the position, play state and speed are restored (URL sources, Chromium).
- **No freeze a moment after playback starts**: frames decoded while leaving buffering were being thrown away (a 1.1s hole on a 1080p30 file).
- **No freezes at slow speeds**: drift budgets that were 4× too loose at 0.25x, a speed change made while paused, and a read-ahead trim that cut a GOP.
- **No hitch at a speed change on Bluetooth**: the picture was waiting out the headset's full output latency (~250ms) at every change.
- **A video-only file's picture no longer waits for sound that never comes** — a 560ms hold after every loop turn.
- **No spinner over a picture that never stopped**, after a backward seek or a loop turn.
- **Seek-bar hover right after a resume** is fast on large remote files (it took 4–7s).
- **A video-only file in a background tab** plays its tail out instead of ending early.

- **A source with no picture shows its captions** — sound-alone and data-saver audio-only ran the caption clock off a renderer that was not running.
- **A hover on an 8K film no longer stops the page**: the preview decodes at preview size instead of the source's, and gives up cleanly rather than hanging. Thumbnails fill their box instead of sitting letterboxed in it.
- **An audio track whose link dies says so** instead of leaving the picture running in silence while the reader retried every frame.
- **A cover-art player's menus are no longer clipped** by the bar's collapse, and the spinner keeps its size and place.

- **An ordinary film no longer wears the HDR film's colour.** After an HDR source, a plain one played greyish and flat: the canvas kept the wide-gamut tag the HDR pipeline set and nothing put it back for SDR.
- **Subtitles in the audio strip.** A sound-only source showed no captions at all — not an embedded track, not an SRT the viewer picked. They now appear in a band above the bar that grows for a second line and no further, centred, and the size and colour settings reach them like anywhere else.
- **Coming back to a spot you already looked at no longer reloads it.** A second hover on the same part of the seek bar re-fetched and re-decoded a picture that was already in hand.
- **A flush that times out no longer throws away everything it was draining** — 645 decoded frames, on an EOF flush that ran out of a budget fixed at 5 seconds regardless of how much was queued.
- **A stream whose URL never admits to being one** now plays: an HLS link with no `.m3u8` in it is recognised from what the server says it is serving.
- **A poster the host refuses to share** is fetched again without CORS rather than left blank; it is a picture, and nothing reads its pixels.
- **Re-stating the source it already has** — a host or a framework writing the same `src` back — no longer restarts the film from the top.
- **JW Player's skin comes down properly**, poster and all, and the poster a video.js or Plyr skin was showing carries over to the player instead of leaving a black box.
- **A video the page had centred stays centred** after the takeover, instead of jumping to the left edge.
- **The player's corners no longer escape the frame it sits in** on the web app.
- **A divider no longer strands itself** at the end of a capsule when native fallback leaves nothing visible beside it.
- **The adaptive quality probe stops reading its own cache**: a measurement answered from bytes it had already fetched could only ever say "faster", so the ladder could climb on a link that never carried it.
- **Auto quality on 4K/8K no longer sticks after a switch**: a switch seeked a demuxer over a read still in flight and played from a wedged pipeline (once a 35s freeze). Manual picks were never affected.
- **A remembered link speed that failed is lowered**, so a stale record no longer opens every load on 8K.
- **A video-only file on a slow link keeps its clock on the picture** instead of running the bar over a frozen frame.
- **Running out of data near the end is a stall**, not silence plus a desync seek; and a file on a slow link no longer ends 0.25s early.
- **An upgraded `<video autoplay>` starts at once** when sound is certain to be refused, instead of ~1.6s under a play button.
- **The link-speed notice** probes with the source's headers (Drive answered 403) and no longer mistakes a starved link for a slow device.
- **`setIcon()` with the same icon is a no-op** instead of a repaint on every framework render.
- **8K no longer drops to 4K every few seconds** on a link that carries it: a full buffer window holds the download instead of ending it.
- **The buffer bar no longer slides back after a seek**, and **pausing, scrubbing and pressing play no longer empties it**.
- **A picture waiting for its bytes is not read as decode-bound**, so 8K is not capped for the session.
- **Safari no longer bars 1440p AV1** on WebKit's `decodingInfo` answer when `VideoDecoder` can decode it.
- **An abandoned quality switch stops downloading**, and **a link too fast to time is still measured**.
- **A downshift on a slow link finishes**; **a refused (403) source no longer walks the quality down**; **`bindav` holds** when the picture has not arrived.
- No starved rescue over smooth playback; a held arrow key wins over an automatic switch; setting the same source twice opens it correctly.
- A paused video restored in place shows no first-play button, poster or 0:00; tap to unmute shows no spinner; Matroska files no longer hitch a few seconds in.

## [0.4.0] - 2026-08-15

### Added
- **Custom controls API**: `addControl()` lets a host add its own buttons and context-menu rows — described once (icon, label, toggle/button, which side/anchor it sits on) and the element builds both faces and keeps them in sync. Controls can open nested submenus (any depth), take a hotkey that shows up in the Keyboard Shortcuts panel and flashes the OSD, group into a bar capsule of their own, and declare `media: "video" | "audio" | "both"` so they hide themselves for content they don't apply to. `anchors: { bar, menu }` places a control differently per surface, and an anchor can be a list for a neighbour that only sometimes exists (HDR, captions, audio track). `showOverlay()` / `updateOverlay()` / `hideOverlay()` put a host's own panel (end screen, up-next) over the picture, including in fullscreen.
- **Host-supplied error screen**: `part=` on every piece of the built-in error overlay for restyling, a `slot="error"` for replacing it outright, and an `errordisplay` event (plus `errorTitle`/`errorMessage` properties) carrying the exact wording on screen — separate from the raw `error` event — including format/codec failures that never raise a runtime error. Bridged through the React/Vue/Svelte wrappers.
- **Settings-change events**: `aspectchange`, `loopchange`, `stablevolumechange`, `hdrchange`, `ambientchange`, `rotatechange`, and `audioonlychange` now fire so a host can persist a viewer's choice the way it already could for quality and volume.
- **External chapters**: a `chapters` attribute/property accepts a chapter list from outside the media file (`[{title, start, end?}]`) for sources — YouTube-style watch pages, a CMS — that never carry chapter atoms in the container itself. Supplied chapters win over the container's and survive a quality-switch/error player rebuild.
- **Granular `fastseek`**: the attribute now takes a value naming which skip affordances to turn on — `buttons`, `keys`, `gestures` (plus aliases like `touch`/`keyonly`) — instead of switching on all three at once, so a page can offer just the double-tap gesture, or just the arrow keys.
- **`titlemode`**: controls where the title bar shows (`fullscreen`, `windowed`, `both`, `back`, `back-mobile-fullscreen`) and whether it carries a back arrow, which fires a cancelable `back` event for the host to handle. Comes with a new `exitFullscreen()` method covering all three fullscreen routes.
- **`themecolor` takes a secondary colour** (`themecolor="#8B5CF6 #22D3EE"`), used for the centre play/pause flash; a single colour still works exactly as before.
- **`cropbars`**: strips real letterbox/pillarbox padding baked into the source pixels (a 2.39:1 film in a 16:9 frame, a phone clip in a 4:3 frame) before applying `cover`/`fill`/`zoom`, instead of scaling the bars along with the picture. Detected automatically per source with a conservative brightness/duration check so a genuine dark scene or fade-to-black is never mistaken for a bar.
- **Karaoke subtitles get a per-line backdrop and scroll on wrap**: each line of a rolling WebVTT cue now has its own sized pill instead of one box squared to the widest line, and a line pushed up by a wrap slides into place the way YouTube's rolling captions do, instead of jumping.
- **Full native media API surface**: all 78 `HTMLMediaElement`/`HTMLVideoElement` members now answer, including `buffered`/`seekable`/`played`, `textTracks`/`audioTracks`/`videoTracks`, `srcObject`, `canPlayType`, `captureStream`, `getVideoPlaybackQuality`, `requestVideoFrameCallback`, `setSinkId`, `fastSeek`, and the `abort`/`suspend`/`encrypted`/`waitingforkey`/`cuechange` events — so code written against a native `<video>` has nothing left to reach for that isn't there.
- **Firefox extension**: the same player-in-a-tab experience as the Chrome extension, sharing its UI (popup, content script, player page) via a build step so there is one codebase to maintain, not two that drift.
- **`backgroundplay`** now actually keeps a phone playing when the tab is hidden (previously only had an effect on desktop browsers).
- **Visitor feedback wall** on the landing page's FAQ — a note plus an optional 1-5 star rating, with server-side abuse filtering and rate limiting.
- **HLS/DASH streams the browser can't decode now play anyway**: when Shaka/hls.js/dash.js can't decode a stream's codec (e.g. Safari rejecting HE-AAC, or an unsupported video codec), playback now escalates through the other MSE engine and, as a last resort, falls back to the player's own FFmpeg-WASM software demuxer — for both DASH and HLS. Quality switching, alternate audio-language tracks, and subtitle/caption tracks (WebVTT and TTML) all carry over into that fallback mode.
- **Seamless, in-place quality switching everywhere**: manual and automatic quality changes — across the WASM-demuxer fallback, multi-file quality sources (one file per resolution), and now HLS/DASH — swap the active rendition in place instead of tearing the player down and reloading, so there's no loading gap, no dropped playhead, and no dead silence. The incoming rendition's decoder also runs ahead of the swap point, so a quarter-second of decoded frames is already ready the instant the old rendition's queue is retired — no frozen frame sitting under the spinner for as long as a fresh keyframe takes to arrive.
- **Auto (adaptive) quality**: an "Auto" option that measures your link's throughput and picks the best rendition it can sustain, now available on the demuxer-fallback and multi-file quality-source paths too, not just HLS/DASH. It runs a short pre-play speed test past a CDN's caching/pacing burst and opens directly on the rung the link can sustain, rather than climbing one rung at a time or trusting a stale cross-video estimate — so no opening 1080p on a 0.7 Mbps link, and no visible ramp up from 144p on a fast connection. Upshifts are confirmed by probing the target rung, so a burst can only make the decision *more* conservative; rungs are barred by codec *and* height together (a failed 4K AV1 rung no longer poisons 4K H.264 too); decode cost is priced by width × height × fps × codec factor instead of by height alone; the software-decode ceiling is sized separately per codec and no longer caps a healthy hardware 1080p session at 480p; and a codec that can't be hardware-decoded at all switches to software after one failed rung instead of walking the whole ladder down first. It persists your Auto preference across videos and shows the active rung like "Auto (1080p)". Also fixed along the way: thrashing between rungs, downshifting on estimate noise instead of an actually-draining buffer, losing a voluntary upshift while the tab is hidden, and switching quality mid-seek — which could corrupt the demuxer and desync audio/video by tens of seconds.
- **Pluggable `SubtitleRenderer` for ASS/SSA** (issue #17): a host hook to plug in a custom subtitle renderer (e.g. jassub/libass-wasm) for full ASS/SSA styling — positioning, karaoke, embedded fonts — since the player's canvas-only pipeline can't use a native `<track>` overlay for these.
- **`fallback="native"`**: when the WASM/WebCodecs pipeline can't read a source (a no-CORS cross-origin file, a transient network failure), playback now hands off to the browser's own `<video>` element wrapped in the player's own controls, instead of a dead end. The degraded surface keeps more than the transport: a `<source>` quality ladder still switches in place — with an Auto mode measured by stall rate rather than buffer depth, since a native element decodes opaquely and its buffer reads as permanently starved by the usual rule — `<track>` subtitles are parsed and painted into Movi's own overlay so the subtitle styling and delay controls keep working, and split video+audio sources, which a lone `<video>` can't play at all, get a synced companion `<audio>`: mirrored transport, drift correction, and a hard resync when the two disagree, including multi-language audio switching.
- **`engine` attribute**: choose which playback engine leads and what follows it — `wasm` (Movi's demuxer + WebCodecs, and for a manifest its own DASH/HLS handling), `shaka`, `dashjs`, `hlsjs`, `native`. A space-separated list, first name first: `engine="native wasm"` plays through the browser and only falls back to Movi's pipeline, `engine="dashjs shaka"` prefers dash.js for manifests. Unset keeps the built-in order.
- **Pluggable URL-scheme adapter registry**: `registerSourceAdapter()` teaches the player about custom `src` schemes — `s3://`, `ipfs://`, `ws://`, etc. — with no per-element wiring.
- **Adaptive load shedding for underpowered devices**: a detector measures the achieved frame-present rate against the source's rate and sheds load on a sustained deficit, so a device that can't keep up (low-end mobile on 4K, software-decoded AV1) degrades gracefully instead of stuttering indefinitely.
- **`movi-player/element/slim`**: a second, smaller build (4.2MB of JS vs. 11.4MB) that streams the FFmpeg WASM from a separate `movi.wasm` file instead of embedding it, with automatic fallback to native playback if the WASM can't be fetched. The framework wrappers have slim twins too — `movi-player/react/slim`, `movi-player/vue/slim`, `movi-player/svelte/slim` — same components, props, and events, and `wasmurl` points the loader at wherever you host the `.wasm`.
- **Standard `HTMLMediaElement` events**: ten previously-missing standard events — including `seeking`/`seeked` and `durationchange` — now fire, so code ported from a native `<video>` works without changes.
- **Full IDL property reflection**: every documented attribute (all 57) can now be read and set as a JS property (`el.rotate = 90`), not just via `setAttribute`/`getAttribute`.
- **Declarative `rotate` attribute** (`0`/`90`/`180`/`270`): set rotation from markup instead of only through the hotkey/menu.
- **`version` exposed at runtime**: `MoviElement.version` (static) and `el.version` (instance), jQuery-style. Alongside it, `MoviElement.build` / `el.build` (and the `BUILD` export) report which bundle is running — `"slim"` or `"full"` — since the two are otherwise indistinguishable at runtime despite loading the engine differently. The stats panel leads with both: `Player: 0.4.0 (slim)`.
- **Framework wrappers type all 57 attributes**: React/Vue/Svelte wrappers now type the complete attribute set and accept typed `<source>`/`<track>` children (`height`, `srcLang`, `kind="audio"`, etc.) instead of needing string/attribute-spread workarounds.
- **VS Code IntelliSense for `<movi-player>`**: attribute and value completion with hover docs, plus CSS completion for the 38 `--movi-*` theme variables.
- **Examples gallery** (`/examples`): a page of live, copy-paste `<movi-player>` recipes with modal demos; existing recipes expanded and reorganized into themed sections, including a new ASS/SSA subtitle recipe.
- **Embed-code dialog**: a toggle-driven dialog (autoplay, muted, loop, thumbnails, resume, ambient glow) generates a live `/embed` snippet, replacing the old one-shot copy button; `/embed` itself is now restricted to framed contexts, with a branded block page when opened directly.
- **Google Drive video player** (`/drive`): sign in, pick a video from your Drive, and stream it straight into `movi-player`.

### Changed
- **Every setting moved behind one gear**: quality, speed, stable volume, aspect, loop, audio track and HDR used to each have their own button on the bar; now there's a single gear panel the way most other players do it, and the bar keeps only what you touch *while* watching (play, volume, time, captions, PiP, fullscreen). Rows appear only when they lead somewhere, track rows now name the language ("HIN · Surround") instead of just the channel layout, and picking a value closes the panel while toggles don't.
- **Control bar redesign**: buttons group into capsules, chapter breaks are real gaps cut through the whole progress bar (groove, buffer and fill all break together) rather than ticks painted over it, the bar sits closer to the frame edge with a thicker/hoverable progress track, the quality badge reads height *and* frame rate ("720p@60"), an HDR badge joins it, and aspect ratio moved beside the gear. The keyboard shortcuts panel now fits inside a phone-sized player instead of running off the bottom.
- **`bindav` (bind audio+video on a stall) is on by default now**, opt out with `bindav="false"`. Whichever of audio or video runs dry now waits for the other before either resumes, instead of the picture racing seconds ahead of frozen audio (or vice versa) on a slow link.
- **HTTP range-request sizing tuned against a real paced CDN**: opens with a 4MB chunk for a fast first byte, then fills with 8MB chunks (previously always 4MB, which spent most of a high-bitrate stream's time on per-request overhead instead of filling the buffer).
- **The settings gear now hides rows that would silently do nothing**: stable volume and aspect ratio disappear from the panel on a source playing through the native fallback or an adaptive-stream engine, where neither setting has anywhere to act.
- **Compare page (`/compare`) now served from the slim build**, and the player bundle preloads during `<head>` so its download starts earlier on the main app.
- **README and docs discoverability**: an honest comparison table (added dash.js and Shaka Player columns) and a new "Alternatives" section naming peer libraries; docs are now served under `/docs`, and a Terms of Service page was added.
- **Third-party license attribution completed** for every bundled component, including the FFmpeg LGPL notice.

### Fixed
- **Picture-in-Picture**: the floating window now draws its own buffered range and loading spinner (previously both were painted on the page nobody was looking at) and renders subtitles inside the Document Picture-in-Picture window; its clock survives a change of video instead of freezing on the old one; the page's own clock, progress and controls keep running while PiP is open instead of freezing when the bar auto-hides or the tab backgrounds; the next auto-advanced video keeps painting into an already-open PiP window instead of going black, and starts directly in that window instead of waiting for the tab to be visible; the window picks up `themecolor` instead of always rendering violet; it closes automatically when the element is torn down, so no orphaned black window survives a video-to-video rebuild; and the PiP control is hidden inside any iframe, where the browser forbids opening a PiP window anyway.
- **Firefox autoplay false-mute**: Firefox flips an `AudioContext` from "suspended" to "running" about 100ms after `resume()`, after the promise has already resolved — the autoplay check read the state once, right after `play()`, and muted audio Firefox had already allowed, leaving "Tap to unmute" on screen for the whole video.
- **Muted-audio semantics**: pausing then pressing mute no longer shows an unmute pill as though the browser had blocked audio; unmuting a paused player no longer starts it playing over a still picture; and a deliberate mute is no longer clawed back by the same recovery path that restores audio the browser itself had blocked.
- **Split audio+video robustness**: the split-audio demuxer no longer starves during the opening speed-test burst (the opening rung is sized to leave it headroom, and a stalled open retries with backoff); a software audio-decode circuit-breaker trip now reports the failure and restores the hardware decoder that was working instead of leaving audio silent for the rest of the video; and the audio clock is rebuilt correctly after audio was dropped while suspended.
- **Rounded corners** stop eroding the outermost pixel row, and now survive fullscreen entry/exit, a quality switch, and losing/regaining the GPU context — previously several of these dropped the clip entirely or cut into the picture itself.
- **Seek bar falsely reading "fully buffered"**: a large MKV (cues at the tail) or an MP4 with a trailing `moov` made an opening read of the file's last few bytes look like the whole file had downloaded; the buffered bar now checks that the read window is actually near the playhead, not just that it happens to reach the end of the file.
- **A refused byte range is now reported instead of read as end-of-file**: an expired signed URL (403) used to look like the video had simply finished — clock jumped to the duration, "ended" fired — instead of surfacing an error; a URL that keeps refusing now backs off and stops retrying instead of firing over a thousand requests in a few seconds, and reports a message that matches the failure (expired link vs. not found vs. server error).
- **Image subtitles**: stopped re-encoding the same PGS/VobSub bitmap to a data URL on every render tick (was happening 60x/sec even when nothing had changed), and a cue that lands after a gap no longer visibly glides ~50px into position over a third of a second.
- **Centre play/pause icon**: no longer pops in-then-out when the button was already on screen (e.g. the poster); an in-flight fade is now cancelled the moment the button becomes a persistent control, fixing an occasional flicker back to full opacity; and a media-session play/pause (lock screen, media keys) now flashes the same receipt a click does.
- **Timeline thumbnail strip**: a touch device gets paging arrows again (sized for a fingertip) instead of relying on scroll alone with no sense of how much strip is left; and the scroll indicator now only draws while something is actually scrolling instead of a static grey line at all times.
- **Context menu / settings panel agreement**: both now agree on what's actually available on the current source; a tall context menu rests on the player's bottom edge instead of running past it; the aspect-ratio icon and open submenu update on every change; and the speed submenu ticks the right row regardless of what triggered the rate change.
- **Audio-only ⇄ video transitions**: the picture now rejoins before the audio-only path stops the sound for it (previously could stop cold), coming back from audio-only restores the picture instead of staying audio-only, the timeline holds correctly while the picture is gone, and a player that's been torn down stops downloading video no one will see.
- **Legacy/unmapped codecs** now fall back to software decoding instead of failing outright — WebCodecs has no registered codec string for several FFmpeg-supported legacy codecs (Motion JPEG in AVI among them), which used to leave the renderer black (#19, thanks [@Wgmlgz](https://github.com/Wgmlgz)).
- **`persist` now works when a framework mounts the element**: React (and similar) set attributes *after* appending the element, so the persisted-settings restore ran before `persist` existed and silently restored nothing; it now re-runs when the attribute actually arrives.
- **Audio-track reporting**: the audio-track list is rebuilt on a source change instead of carrying over the previous file's tracks, and the reported "current" track now matches what's actually playing instead of what was last selected.
- **A removed player could keep playing**: a source whose load failed *after* the element was taken out of the document (a host swapping videos on navigation) built its fallback player on the detached element — the teardown had already run, so nothing could ever stop it and the old audio played on underneath the next video. Player creation now bails once the element is gone, and the audio elements a quality switch hands between players are released instead of being left running.
- **Spurious "1x" / "100%" OSD on every playback start**: restoring persisted settings re-entered the volume/speed updaters (and reflected the values back onto the attributes, re-entering again), each time flashing the OSD as if the user had just changed something. The OSD now fires only on an actual change.
- **Karaoke subtitles printed their internal delimiter**: cue text carries the full upcoming sentence after a ghost marker so the caption box can be sized to the finished line; renderers that didn't strip it (the native surface, hls.js) put the marker and the whole sentence on screen.
- **Playback recovery instead of dead ends**: the player now recovers from a corrupt/short demuxer read, a frozen frame with audio still advancing after a long backgrounded spell, a stream that's exhausted its recovery budget (now a self-healing "Reconnecting…" instead of a permanent error), a stuck cached WASM module after an abort, and a hardware decode error on too heavy a rendition (drops to a lower rung under Auto instead of a dead-end error overlay).
- **Alternate audio-language and subtitle switching in HLS/DASH**: audio-language pickers that didn't work at all in some paths now do; subtitle-language switches no longer leave the previous language's caption stuck on screen; duplicate same-language audio renditions no longer clutter the menu with entries like "English · 48kbps / 64kbps / 32kbps".
- **Rotation, timeline, and subtitles across stream playback**: rotating a video (or resizing while rotated) is now respected during HLS/DASH/Shaka playback — it previously touched the wrong renderer and could be a silent no-op, or revert on resize.
- **Context menu in audio-only mode**: menu item queries are portal-aware everywhere now, the menu live-updates the moment you switch to audio-only, and video-only items (Aspect Ratio, Rotate, etc.) are hidden while in audio mode.
- **HDR re-detected on quality change**: a rendition ladder can mix HDR and SDR rungs (e.g. an HDR 4K rung under an SDR 1080p one) — the HDR indicator now re-evaluates on every quality change instead of sticking with whatever the first-loaded rung reported.
- **Album art no longer flashes over a playing video** during a quality switch.
- **Seek bar and progress UI**: clicking the seek bar no longer double-seeks and snaps back to the old position; ABR and the recovery watchdogs no longer fight an in-flight seek; the played/buffered bar draws seamlessly and resets to zero on a fresh load.
- **Audio robustness**: split (separate-URL) audio no longer stalls when the tab is backgrounded; audio-only mode stops downloading the unwatched video stream and correctly suppresses the "Play at 1x" stutter hint; the screen wake lock is now acquired on tap-to-unmute, ordered so Safari doesn't consume the gesture on the wrong request; the pitch stretcher warms up at the correct rate; stale pre-seek audio is dropped on seek instead of playing briefly.
- **Source resiliency**: a streamed source retries open-ended instead of failing when a bounded byte-range request gets a 403; file size is recovered via a ranged GET when a `HEAD` request throws (issue #14).
- **Playback rate changes stay seek-free** when a healthy audio clock can anchor them, instead of always reseeking.
- **Google Drive sign-in** no longer pops up unbidden on page load — it now only triggers on an explicit click.
- **Chrome extension no longer tags the page DOM** for presence detection, which was showing up as a hydration mismatch on React/Next.js and similar pages; it now uses an in-memory window flag instead.

## [0.3.5] - 2026-07-11

### Added
- **Captions rotate with the video**: rotating the video (`R` / menu) turns the subtitles with it and keeps them on the rotated bottom edge — text and image (PGS/VobSub) subtitles both.
- **Blurred backdrop for embedded album art**: audio with *embedded* cover art now gets the same blurred-artwork backdrop as poster-based audio, instead of a plain dark background.

### Fixed
- **Fullscreen: the right-click / gear menu wouldn't open**: the menu portals to a body-level layer to escape page clipping, but in fullscreen the player is the fullscreen element so that layer rendered outside it — the menu now stays within the player in fullscreen.
- **Context-menu toggles didn't reflect their new state**: Ambient Mode / Stable Volume / Loop / Rotate / HDR toggled from the menu now update their On/Off label and highlight (the state was written to the wrong place while the menu was portaled).
- **Volume slider offered a 200% boost on native audio**: a single external audio source plays through a native `<audio>` element that can't boost — the slider now caps at 100% there.

### Changed
- **Wider context-menu submenus**: audio-track and audio-output submenus are wider so long track / device names don't wrap.

## [0.3.4] - 2026-07-11

### Added
- **OS Media Session — lock-screen & hardware-key controls**: title metadata, artwork, and play/pause/stop/seek controls on the OS lock screen and notification shade via `navigator.mediaSession`, with a synced position scrubber.
- **Press-and-hold to 2x (touch)**: YouTube-style long-press speeds playback to 2x while held, reverts on release.
- **Settings (gear) button**: touch-friendly way to open the context menu now that long-press drives hold-to-2x.
- **"Play at 1x" stutter hint**: OSD nudge when a heavy source can't sustain above 1x (dropped video frames, smooth audio), with a cooldown.
- **360°/VR seek-bar preview reprojection**: seek-bar hover preview now matches your current viewing angle instead of the raw flat frame.
- **Themeable control-bar colors**: more chrome colors driven by overridable `--movi-*` CSS custom properties for embedder theming.
- **Volume boost to 200%**: the volume slider now reaches 200% (VLC-style) with a tinted boost zone above the unity mark, for quiet sources.
- **Screen-reader accessibility**: an off-screen `aria-live` region announces captions, and the seek/volume controls are now real `role="slider"` widgets with spoken position text.
- **QoE analytics (`movi-qoe`)**: a versioned QoE event stream (startup, rebuffering, bitrate switches, decode-fallback, errors, heartbeats) via a DOM event, `addQoeSink()` / `getQoeSession()`, and a built-in `beaconSink(url)`.
- **Framework wrappers + typed element**: official typed `movi-player/react` / `vue` / `svelte` wrappers (subpaths of the one package — no extra install), plus `HTMLElementTagNameMap` typing for `<movi-player>`.
- **Embed / headless bare player + `noerrorscreen`**: no `controls` attribute makes `<movi-player>` a pure display surface (no resume dialog, empty state, spinner, or mouse interaction); `noerrorscreen` also suppresses the built-in error overlays.
- **Number-key seeking (`1`–`9`)**: `1`–`9` jump to 10%–90% of the timeline (YouTube-style), alongside `0` / `Home`.
- **Swipe-to-dismiss touch menu**: the gear-opened context menu is a right-side drawer on touch — drag it toward the right edge to close it. Vertical scrolling and taps inside the menu are unaffected.
- **Pinch to change aspect fit in fullscreen (touch)**: a two-finger pinch switches the fit YouTube-style — spread to zoom-to-fill (crop), pinch in to fit — with the same Fit/Fill OSD. Fullscreen-only (won't fight inline page pinch-zoom); excluded from 360° mode.
- **iOS Safari pseudo-fullscreen fallback**: iOS Safari only allows element-fullscreen on `<video>` and the player renders to canvas — fullscreen falls back to a CSS viewport-fill mode (behind Safari's toolbars) with forced-landscape rotation for landscape video. iPad / real element-fullscreen browsers unaffected.
- **Small-player control bar & menu overhaul**: usable down to ~100px wide — tighter padding/buttons below 400px, PiP folds behind the "more" toggle, the expanded cluster scrolls horizontally, fullscreen folds in below 290px, the resume dialog stacks instead of clipping, dropdown menus cap to the room inside the player, and the gear hides while a bottom dropdown or the timeline is open.

### Fixed
- **HTTP streaming without cross-origin isolation**: HTTP(S) sources no longer need COOP/COEP (`SharedArrayBuffer`) — single-threaded Asyncify WASM falls back to a plain-buffer path; fixes a `Timeout at 0` on pages without the headers. The headers now only enable an optional zero-copy fast-path.
- **Fullscreen forced landscape for portrait video (Android)**: the orientation lock now reads the effective display rotation, so a portrait clip stored as landscape-frames-plus-rotation stays portrait in fullscreen.
- **Audio-strip (collapsed) mode**: shortcuts work while collapsed; the gear aligns with the title, stays visible and appears on load; the touch menu no longer overflows; the strip reflows on late cover art; a strip with no `controls` hides itself.
- **Picture-in-Picture cursor**: the cursor stays visible above the controls in document PiP.
- **Touch hold-to-2x too eager**: threshold raised to 600ms and the gesture cancels when it becomes a scroll.
- **Resume-dialog selection ring**: visible on pointer devices (a global `outline` reset was hiding it), hidden on touch.
- **Blank snapshot on hardware AV1**: falls back to the decoded `VideoFrame` when WebGL read-back is blank.
- **Settings gear on non-touch**: hidden where right-click already opens the menu.
- **Safari first-load flash**: no flash of unstyled overlays on first load.
- **OS Media Session focus**: the silent audio anchor is now ≥5s so the OS grants full media-key focus.
- **Volume clamping**: native-element volume clamped to `[0,1]`; the slider caps at 100% unless boost is on.
- **Context menu clamped on-screen**: the menu repositions after opening so it never spills off-viewport.
- **Lite / proxy browsers without cross-origin isolation**: the player runs on reduced browsers with no `SharedArrayBuffer`.
- **Open-GOP CRA-opening HEVC stuck buffering**: a seek now accepts a CRA at or before the target instead of waiting indefinitely for an IDR.
- **TrueHD/DTS buzzy/jittery audio around seeks and replays**: software decoder now flushes on seek, a cold-start cushion applies on every seek/replay (not just first play), and replay no longer trips a spurious desync resync.
- **Multi-audio-track files stalling repeatedly**: unused audio streams are now discarded at the demuxer level so the active track isn't starved by interleaved packets from a track nobody's listening to.
- **Crash on load with newer WASM builds**: heap bytes are now copied out before `TextDecoder.decode()` (resizable `ArrayBuffer` heaps threw and blocked every file from loading).
- **Playback stalling after resuming from the background**: the un-throttled background decode timer now restarts on resume (including via Media Session), so audio no longer starves and video no longer jumps ahead of audio.
- **SigV4 presigned URLs (S3 / R2 / GCS) failing to load**: falls back to ranged/plain `GET` when a `HEAD` probe returns 403/401 instead of treating it as access-denied; extension link probe also recognizes presigned links without a file extension.
- **Context-menu submenu options all showing "active" (touch)**: Fit and Speed submenus no longer accumulate a stale highlight.
- **Selected-track text unreadable in light theme + auto-hide stuck open**: readable codec/language text in light theme; switching audio tracks restarts the auto-hide timer.
- **VS Code extension bundle out of date**: republished with the current player build (was missing the 0.3.3 audio-output/VR/FLAC fixes).
- **VS Code: fullscreen button hidden despite fullscreen working**: the webview iframe reports `fullscreenEnabled=false` (so the button auto-hid), but fullscreen works via the extension host — the webview now grants the capability so the button stays.
- **Embed: dead fullscreen/PiP/audio-output controls no longer shown**: hidden (instead of silently failing) when the embedding iframe's Permissions Policy disallows them; PiP also retires itself if opening its window throws.
- **`playsinline` now also gates touch gestures**: an inline touch player suppresses swipe-seek/volume gestures so they don't fight page scroll (resumes in fullscreen). The separate `gesturefs` attribute is now deprecated (still honored).
- **Right-click context menu clipped by page layout**: the menu portals to a body-level layer so it escapes clipping ancestors (a wrapper's `overflow:hidden`) instead of being chopped at the player edge; submenus are viewport-aware in this mode.
- **Resume-dialog selection ring didn't follow the pointer**: the ring now moves to whichever button the pointer is over, matching arrow-key behavior.
- **Scrub thumbnail previews depended on attribute order**: `<movi-player src=… thumb>` no longer silently builds with previews disabled; order doesn't matter, and the timeline key (`T`) generates thumbnails regardless of the `thumb` attribute.
- **Timeline panel: thumbnails touching + controls-bar flash on close**: bigger thumbnail-strip gap and a smaller hover/active pop so thumbnails don't overlap on small players; closing no longer flashes the auto-hidden controls bar.
- **360° mode: scroll-wheel accidentally zoomed the view**: removed the wheel-zoom listener so page scrolling behaves normally; drag-to-look and pinch-to-zoom remain.
- **Aspect-fit menu item didn't show the Fit/Fill OSD**: changing aspect from the context menu now flashes the same OSD as the button and keyboard shortcut.
- **Pinch-to-fit and press-and-hold-to-2x could fire together**: a second finger landing cancels hold-to-2x so a pinch can't trigger 2x mid-gesture.
- **HTTP streaming: large remote files restarted mid-playback on small out-of-window reads**: served with a one-off range fetch while the main stream keeps running (fixes the request "cancelling" on large torbox-style files), with a cap on consecutive one-off fetches so a real seek still restarts the stream. (Thanks @anilabhadatta.)

## [0.3.3] - 2026-06-29

### Added
- **Immersive / VR video (`vr` attribute)**: 360° equirectangular, 180° (VR180), fisheye, side-by-side **stereo (3D)**, and stereographic **"little planet"** projections, rendered with a WebGL2 fullscreen-quad raycast and a spring-animated look-around camera (drag / arrow keys / pinch-zoom). Auto-enters the right projection from the source's spherical metadata — no toggle UI — or force it with tokens (`vr="180"`, `vr="fisheye sbs"`, `vr="littleplanet"`). Opt-in on-screen joystick via `vrpad`.
- **Audio output device selection (`audiooutput` attribute / `setAudioOutput()` API)**: route playback to any system output device (speakers, Bluetooth, virtual). `getAudioOutputs()` lists devices, `setAudioOutput(deviceId)` switches — it also accepts a **label substring** (e.g. `"Headphones"`) since device ids are session-salted — `getAudioOutput()` reads the current sink, and an `audiooutputchange` event fires on change. Surfaced as an **"Audio Output"** submenu in the right-click menu (the browser asks for device permission on first use; granted hosts list devices directly). Routed through `AudioContext.setSinkId`.

### Fixed
- **FLAC audio playback**: FLAC now always uses the software (FFmpeg-WASM) decoder — WebCodecs' FLAC decoder throws `EncodingError` on these streams and the error→software fallback didn't recover in every browser, leaving FLAC silent.
- **Title HTML-entity decoding**: titles from scraped / download-site sources that carry entities like `&quot;` (and the non-standard `&Quot;`), `&amp;`, `&#39;` now render as the real characters (`"`, `&`, `'`).
- **Audio-strip title placement**: when an audio file *with a title* collapses to the thin control strip, the title now sits in its own row above the controls instead of overlapping the control row.
- **Controls auto-hide vs. the timeline & menus**: the control bar no longer auto-hides while the **storyboard timeline** (`T`) is open or when clicking a thumbnail in it, and it correctly re-arms its inactivity auto-hide after the right-click menu closes.

## [0.3.2] - 2026-06-17

### Added
- **Desktop app — Windows / macOS / Linux (`desktop/`)**: a new Electron app wrapping the player engine. Plays MKV, HEVC, AV1 and 4K HDR locally through the same WebCodecs + FFmpeg-WASM pipeline, served from a cross-origin-isolated localhost server so the WASM demuxer keeps `SharedArrayBuffer`. Includes drag-and-drop, native **Open With** / file associations for every supported format, URL playback through a built-in proxy (no CORS limits), a **multi-file playlist** with auto-advance, recent files, an Open-URL dialog with clipboard paste, full-window keyboard shortcuts, and a **native always-on-top Picture-in-Picture** window (Electron doesn't render Document PiP, so PiP is a real OS window that hands the source off and resumes on return). Cross-platform installers (`dmg` / `nsis` / `AppImage` + `deb`) and document icons via electron-builder.

### Fixed
- **Software-decoder fallback without WebCodecs**: when the browser has no WebCodecs `VideoDecoder` (e.g. Firefox, especially on mobile) the player now falls back to the WASM software decoder instead of failing — video was left stuck buffering while audio fell back on its own.
- **Seek before ready is queued**: the `currentTime` setter now holds a seek requested before the player is ready and applies it on the next seekable state, so a hand-off / early seek no longer stalls on a still-loading source.
- **`<movi-player hidden>` now hides**: the component's `:host { display: block }` was overriding the UA `[hidden]` rule, so the standard `hidden` attribute did nothing.
- **Centre play/pause + loading spinner positioning**: sit at the true centre on the initial / autoplay-off screen and lift slightly to balance the controls bar only once playback has started; they also animate in compact / PiP layouts. (Previously keyed off a `:host:has()` rule that some engines, e.g. Electron's Chromium, don't apply to shadow descendants.)

## [0.3.1] - 2026-06-10

### Added
- **MPEG-DASH playback (`.mpd`) (closes #9)**: DASH manifests now play alongside HLS through the adaptive pipeline.
- **Unified adaptive streaming via Shaka (HLS / DASH / Smooth)**: Shaka is the primary engine for `.m3u8` / `.mpd` / `.ism`; hls.js and dash.js remain as automatic fallbacks. `DashFallback` plays bare-`BaseURL` manifests Shaka rejects via the demuxer.
- **Live-stream UI**: `LIVE` badge that jumps to the live edge, DVR-window seeking, Auto-mode quality badge.
- **Custom request headers (`headers` attribute / property)**: Auth tokens / signed headers across manifest + segments, progressive HTTP, thumbnails, and the encrypted source. JSON-string attribute or object property; also `PlayerConfig.headers`.
- **Audio-only data-saver mode (`audioonly` attribute / `audioOnly` property)**: Play just the audio to save CPU/bandwidth — muxed files skip the video decode, streams switch to an audio-only rendition, split sources stop downloading the video body. Live-toggleable, forces the album-art strip UI.
- **Non-range (no-Range) server playback**: Servers that ignore `Range` (`200` not `206`) now play via a forward-only sliding window (**linear mode**); a new `linearmode` event lets the UI adapt.
- **MPEG-5 LCEVC decoding (`lcevc` / `lcevcurl` attributes)**: Opt-in LCEVC enhancement-layer decoding for adaptive streams.
- **Muted-autoplay fallback for split native-audio tracks**: rolls video muted + shows the tap-to-unmute pill instead of freezing.
- **Extension: detect `.mpd` (DASH) URLs in page scan.**
- **VS Code extension: adaptive streaming via URL** — `Movi: Open Video from URL` plays `.m3u8` / `.mpd` / `.ism` by loading them directly in the player engine (no host byte-range proxy); progressive files still use the proxy.
- **VS Code extension: `.ts` (MPEG-TS) added to the open-file dialog** (not the single-click association).

### Changed
- **DRM key-system order**: Widevine → PlayReady → FairPlay.
- **Manifests load directly, never via `/proxy`**: fixes relative segment resolution and the proxy content-type allowlist for `.m3u8` / `.mpd` / `.ism`.
- **Size resolution hardened**: HEAD → ranged GET → plain GET retry chain for CDNs that strip `Content-Length`.
- **deps**: add `shaka-player ^4.11.2`, `dashjs ^5.2.0`; bump `hls.js` to `^1.6.16`.

### Fixed
- **Robust startup**: visible play affordance on blocked autoplay, guarded first-play seek, background-tab autoplay deferred until visible.
- **Don't flash wrapper errors mid-fallback**: no spurious "Try Software Decoding" while falling back behind Shaka.
- **HTTP errors surface real messages**: `403` / `404` / `5xx` map to access-denied / not-found / server-error.
- **Wake lock**: skip while hidden, retry transient failure, re-acquire on visible/resize.
- **Don't collapse a loading/errored video into the 56px audio strip on resize.**
- **App proxy**: don't proxy same-origin URLs (522 loop); don't magic-sniff tiny range probes.
- **Volume slider opens on first touch; ambient re-applies after `src` change.**
- **Cover-art backdrop blur** via CSS `filter:blur()` (works in Safari < 17); audio-only `poster` renders as album art.
- **Audio-only replay/loop restarts the native `<audio>`; no context menu without `controls`.**

## [0.3.0] - 2026-06-02

### Added
- **Signalsmith Stretch audio rate-change pipeline**: Replaced SoundTouch with Signalsmith Stretch as the sole pitch-preserving time-stretcher.
- **First-class audio-only support with strip UI**: Audio-only files play through the canvas pipeline with a dedicated audio strip UI (cover art, title, progress bar, controls).
- **Muted-autoplay fallback with tap-to-unmute**: When autoplay is blocked, the player starts muted and shows an "unmute" pill overlay.
- **Cover art display for audio**: JS-only album art extraction via an isolated demuxer context.
- **Custom `SourceAdapter` for `<movi-player>` and `MoviPlayer` (closes #7)**: Plug any custom byte protocol directly into the element or player.
- **File-source preload settling gate**: `play()` and resume gated until initial preload fills.
- **YouTube-style centre play button**: Always-visible large play/pause icon.
- **Unified controls chrome — dark gradient bar + redesigned OSD**: Opaque backgrounds replace backdrop-filter blurs.
- **Extension: playlist shuffle, autoplay toggle, next button**
- **Extension: hover-probe links + opt-in toggle + flag detection**
- **Compare page (`/compare`)**: Side-by-side native vs movi-player.
- **VS Code extension — URL streaming, multi-window commands, Activity Bar entry**
- **Homepage redesign**

### Changed
- **4K playback rate cap raised to 2x** (only 8K+ capped at 1.5x)
- **Renderer queue split for 4K vs 8K**
- **UI update loop throttled to 4Hz**
- **Volume slider uses perceptual (log) gain curve**
- **Ambient mode FBO mirror** (no more full canvas readback)
- **Thumbnail hover latency cut**
- **Dropped backdrop-filter blur from all UI surfaces**
- **README redesigned**, browser support updated (Firefox 130+)
- **AGENTS.md shipped in package**

### Fixed
- **Decode**: RASL leading pictures after CRA/BLA seek, DoVi/HDR HEVC on hardware, open-GOP HEVC fallback, tiny packet drop, AV1 Temporal Delimiter OBU
- **Seek**: prefer IDR fall back to CRA, resume into buffering on timeout
- **Playback**: mid-playback decode-error recovery, auto-start on rate restore, rapid seeks stuck, stall detection during recovery, audio tail on rate change, EOF detection
- **Audio**: log gain curve, pitch-shift at startup, audio-only shortcuts, near-end seek clipping
- **UI**: controls flash, play/pause icon state, centre play flickering, cursor hiding, loop toggle replay
- **Canvas**: display-p3 fallback, rec2100-pq preservation
- **Thumbnail**: recreate dead WebCodecs decoder
- **Extension**: video link detection, loop replays
- **HTTP**: surface server errors

## [0.2.3] - 2026-05-07

### Added
- **Subtitle Delay / Offset (closes #4)**: Shift subtitle timing relative to video — `subtitledelay` attribute, `subtitleDelay` property, `setSubtitleDelay()` / `getSubtitleDelay()` API methods, and a new `subtitledelaychange` CustomEvent. Sign convention matches VLC/mpv (positive = subtitles later). UI cap ±300s with widened input. Z/X hotkeys nudge by 100ms per press; OSD shows the current offset. Auto-prefetch when delay becomes non-zero so negative offsets work (cues from stream positions ahead of the demuxer cursor). Applied at the renderer's active-cue check so a single offset works for text and image (PGS/DVB) cues without re-decoding.
- **Subtitle Customization Panel**: `subtitlesize`, `subtitlecolor`, `subtitlebg`, `subtitleedge` attributes, plus an in-player customize panel persisted to localStorage. Size multiplier drives both bitmap (PGS/VOBSUB) and text (SRT/ASS/VTT) cues; edge style applies to text subs.
- **Subtitle Transcript Browser**: Full-cover panel with search, click-to-seek, active-cue highlight, italic/bold/entity rendering, and delay-aware timestamps. Click on a live caption opens the transcript at the current cue. Backed by a native `movi_prefetch_subtitle_cues` that uses `AVDISCARD_ALL` so a 700 MB scan touches only subtitle packets, not every audio/video body.
- **Karaoke Captions for VTT**: Tag-only-token folding, min-width anchor measured offscreen, render-key cache to stop the 60fps `innerHTML` rewrite that prevented fade-in during playback. Format-aware backdrop (VTT-only).
- **Premuxed Quality Menu**: Multiple `<source data-height="...">` children give a YouTube-style quality picker for plain MP4/MKV files — no HLS manifest needed. Adopt/release native `<audio>` across switches preserves the user-activation token so the next switch isn't blocked by autoplay policy.
- **Multi-Language Audio via `<source kind="audio">`**: Two or more audio `<source>` tags with `srclang` (or `label`) become parallel language tracks; the player surfaces the audio-language menu and `getAudioLangs()` / `selectAudioLang()` work exactly as for muxed tracks. Default pick: explicit `default` / `data-default` → first locale match (`navigator.language` prefix) → first track. Single `<source kind="audio">` continues to use the legacy split-audio path.
- **External Subtitles via `<track>`**: Standard `<video>`-style declarative markup — `<track kind="subtitles">`, `kind="captions"`, or no `kind` are recognized. Reads `srclang`, `label`, and `data-format` (defaults to VTT, set `srt` for SRT sidecars). Lets integrators ship full caption configurations as plain HTML without wiring up `source({ subtitles: [...] })` from JS.
- **Host Fullscreen Handoff**: New cancelable `movi-fullscreen-request` CustomEvent + `setHostFullscreen(active)` method. Lets embedders (VS Code webviews, custom app shells) take over fullscreen with their own chrome while keeping the player's toolbar icon, OSD, and context-menu label in sync. Fullscreen state is now reflected in the context-menu label.
- **File Revoked Event**: `filerevoked` CustomEvent fires when the browser silently revokes a `File` handle (mobile background / memory pressure). `FileSource` races each chunk read against an 8s timeout — no more demuxer hanging forever — and surfaces the failure via a one-shot `onRevoked` callback on `MoviPlayer`.
- **`MoviPlayer.hasAudibleSource()`**: Unified gate covering muxed audio, split native `<audio>`, *and* HLS audio (which lives inside the hidden native `<video>`). Used internally to decide whether to show volume controls / accept volume hotkeys.
- **VS Code Extension**: New `vscode-extension/` package (Marketplace 0.2.5). Webview-hosted player registered as a CustomEditor — single-click opens any MP4/MKV/HEVC/AV1/WebM/MOV/TS file VS Code can't natively play. True streaming via a custom `DataSource` (webview's `File` proxy delegates `slice().arrayBuffer()` to extension-host `fs.createReadStream` chunks); memory cost drops from O(filesize) to ~chunk size, so multi-GB and 8K HDR files no longer hit the 4 GB Blob limit. Movi fullscreen toggle hides workbench chrome with auto-cleanup on crash. OS wake lock (`caffeinate -i` / `systemd-inhibit` / `SetThreadExecutionState`) held during fullscreen. Multi-window playback via `movi.openInNewWindow`. Output channel surfaces bundled-player logs.
- **Web App Explorer-Style Playlist**: Folder hierarchy tree with collapsible groups + guide rail, multi-select, live search (folders auto-expand on match), keyboard navigation (Tab toggle, Up/Down/Enter, Esc). Thumbnails + metadata cached in IndexedDB so reopening the same files skips every WASM call. SEO overhaul, landing animations, gradient circle brand mark.
- **Chrome Extension Explorer Playlist**: Folder tree, breadcrumb, badges, progress, drag/drop, multi-file + folder picking. Shared isolated WASM instance (2-instance budget) for thumbnail generation, cached in IndexedDB across sessions. Install detection on moviplayer.com hides the "Add to Chrome" prompt when the extension is already present. Gradient circle play-button branding to match the main app.
- **Stats 8K / 16K Tiers**: `4320p` (8K) and `8640p` (16K) labels in both native and HLS stats paths — previously bucketed as 4K.

### Changed
- **HLS Volume Controls Now Visible**: Volume button, `ArrowUp` / `ArrowDown` hotkeys, and volume OSD were gated only on muxed/split audio, so HLS streams (audio inside the native `<video>`) had no mute control. Consolidated behind `hasAudibleSource()` so the HLS path is covered too.
- **Audio Decode Stays Running While Muted**: The demux loop no longer drops audio packets when muted — `AudioRenderer` keeps gain at 0 instead. Fixes the "atak atak" judder on unmute, where the audio clock pivoted forward to the demuxer's lookahead (~1–3s ahead of presentation) and `CanvasRenderer` chased it 25%/frame.
- **Bluetooth A2DP Keepalive**: Pause path now suspends the AudioContext but starts a near-silent looping `<audio>` element so the OS audio session stays claimed. BT devices stop dropping/re-pairing on every pause without re-introducing the "2–3s jump-ahead on resume" regression.
- **DPR-Scaled Canvas Backbuffer**: Canvas backbuffer scales with `devicePixelRatio` (capped at 2×) so downsampling 4K/8K sources stays sharp. CSS dimensions remain in logical pixels.
- **Encrypted Source Static Import**: `EncryptedHttpSource` hoisted to a top-level import — no more async boundary on every encrypted load. Matches the other source adapters.
- **FFmpeg Bumped to n8.1.1**: Picks up upstream point-release fixes on the n8.1 branch. `dvbsubtitle` / `dvdsubtitle` decoders renamed to `dvbsub` / `dvdsub` to match.
- **Subtitle Default Sizing**: Bumped the text-subtitle base size and replaced the desktop-era 60px floor on bottom padding with a height-proportional 8% (24px floor) so subtitles don't crowd into the middle of small embeds.
- **Menu Animations**: Pop-in / pop-out on the audio, subtitle, quality, and speed dropdowns plus a fade between the customize panel and track list. Bottom-controls dropdowns enforce one-at-a-time. Click on the player area closes any open menu instead of toggling play/pause.
- **Keyboard Shortcuts Ignored While Typing in Inputs**: Hotkeys no longer fire when an input/textarea inside the shadow DOM is focused.
- **Audio Menu Always Shows Language Code**: `formatAudioBadge` previously dropped the language code when channel info was available, so muxed tracks from MKV/MP4 displayed only "AAC Stereo" with no way to tell languages apart.
- **COOP/COEP Hard-Required**: README/docs corrected — the player hard-blocks without `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Surfaces a "Security Headers Missing" diagnostic instead of a cryptic timeout. Mention `coi-serviceworker` as a static-host workaround.

### Fixed
- **~1s Fullscreen Freeze**: ResizeObserver fires repeatedly during the fullscreen animation. Each call set `canvas.width` twice (in `updateCanvasSize` and `CanvasRenderer.resize`), clearing the WebGL framebuffer on every burst. Coalesced same-size resizes, dropped the duplicate width/height assignment, dropped the `<video>.width/height` no-ops.
- **WebGL Context Loss Recovery (Mobile)**: Capture canvas to JPEG on `visibilitychange→hidden` while the GL context is alive; on return, hide instantly if `gl.isContextLost()` is false, otherwise leave it up so `handleContextLost`/`handleContextRestored` can run recovery without a corrupt framebuffer flashing through. Restored `isLoading` clear so `initializePlayer` doesn't early-return after long minimize. 5s cooldown between audio-resync seeks prevents stutter loops on slow software audio decoders.
- **HLS First-Frame Black**: Manifests without `RESOLUTION` caused `configure(0,0)` on the canvas renderer, producing a black frame that only cleared on the next ResizeObserver tick. Defer configure to `<video> loadedmetadata` when manifest dims are missing.
- **HLS Quality Badge / Fit Animation**: Re-emit `tracksChange` on `LEVEL_SWITCHED` so the gear badge reflects the active rendition in Auto mode. Skip smoothing-state reset on same-size canvas resizes so fit-mode toggles can lerp instead of snapping; clone last frame in the direct-render path so HLS paused redraws have a source to animate against.
- **Pause→Resume 2–3s Jump-Ahead**: Pause now preserves scheduled buffers and sync anchors exactly, so the first packet drained from `pendingPrebufferPackets` (whose timestamp is the demuxer's lookahead) doesn't become the new `firstBufferMediaTime` anchor on resume.
- **Aspect-Ratio Change While Paused**: Fit-mode change now repaints the canvas after a seek-to-paused and animates via a dedicated RAF loop instead of snapping. Poster overlay tracks the active fit mode, lets pointer events pass through so dblclick / gesture handlers still fire, and stays hidden until a source is set.
- **Mobile Speaker Tap**: Switched from `PointerEvent.pointerType` (Android Chrome synthesizes click with `pointerType="mouse"` from a touch tap) to `matchMedia("(hover: none)")` as the primary touch signal. `composedPath()` to cross shadow boundary in the close-volume listener. Mobile media query no longer hides the slider on `.active`.
- **Embed Security Headers Diagnostic**: Every `src=` change now re-runs `checkSecurityHeaders()`, so reused players surface "Security Headers Missing" instead of a cryptic "Failed to open media: Timeout at 0".
- **Pause Buffering Loop / Single-Track Streams**: Pause buffer loop required both audio and video targets via AND, so audio-only / video-only streams never satisfied it and ran to the 3000-packet safety cap (~30s of demux), surfacing as a burst of cache-read spam after pause. Now only checks targets for tracks that exist.
- **A/V Drift Loop on Hardware Burst Decoders**: Hardware decoders that emit 8K frames in bursts queued many future-PTS frames; on >60Hz displays the fallback drained them faster than wall-clock and tripped the audio-desync resync seek loop. Reject frames more than one frame interval ahead of playback time.
- **Audio-less Video in Background Tab**: Without an audio track, the background `processLoop` had no backpressure (video decode skipped, no audio buffer to fill), so the demuxer raced to EOF in seconds. Pause on hide and auto-resume on visible.
- **Volume Keys for Native Audio Sources**: Hotkeys + OSD gated on `getAudioTracks().length` (empty for split video/audio sources). Now also accept `hasNativeAudio()`.
- **Buffered Bar Stability**: Buffered bar is now monotonic between seeks; pause-time buffering no longer pushes past `HttpSource`'s buffered end and trigger a window-resetting refetch.
- **PGS Subtitles On-Canvas**: Image-subtitle overlay was sized in DPR-scaled buffer pixels, pushing the flex-anchored bitmap off-screen on retina. Switched to the canvas's CSS rect (matching the text-subtitle path).
- **Skip A/V Desync Check When Muted**: Demux loop drops audio decode while muted, so `maxScheduledMediaTime` freezes and `getAudioClock()` clamps to a stale value — disabled the 500ms desync detector while muted.
- **No Corrective Seek After Unmute**: Reset the desync cooldown on unmute so the audio clock can catch up first instead of forcing a resync seek (visible as a loading shutter).
- **Progress Handle at 0%**: Dropped the `Math.max(1, …)` floor so the handle sits at 0% at the start instead of jumping in from 1%.
- **Pre-Play Seek**: Re-arm the `seekTargetTime` filter on first-play re-seek so Open-GOP recovery frames (1–2s behind the seek target) get dropped instead of presented; matching drop on resume from pause.
- **`getCurrentPlaybackTime` Frozen When Paused**: `updateActiveSubtitle` called via `setSubtitleCues` during pause can no longer jump to a wall-clock-driven time.
- **PiP Exit Buffer Resize**: Invalidate `_lastCanvasW/H` on PiP exit so the buffer resizes back to host dimensions instead of staying pinned at PiP resolution.
- **Seek OSD Accuracy**: Track the actual delta between the pre-seek time and the clamped target instead of a fixed 10s step. Anchor chained presses on the previous target. Dismiss the OSD on a boundary hit / sub-second / NaN delta.
- **Coalesce Rapid `currentTime` Sets**: Overlapping seeks now collapse into a single tail seek instead of queueing them all.
- **`preventScroll` on Hover Focus**: `focus()` on mouseenter no longer yanks the page when the player is partly off-screen.
- **Subtitle Re-render on Resize via rAF**: Previously a burst per ResizeObserver tick stalled the presentation loop on window drags.
- **Centre Non-VTT Subtitle Lines**: Multi-line SRT cues (e.g. `"- A long line\n- short"`) now sit at the player's centre instead of drifting left.
- **Worker /proxy Probe Failures**: Transient probe errors no longer get misreported as `415 Unsupported Media Type`.

### Documentation
- WebCodecs team outreach playbook (`docs/webcodecs-outreach.md`).

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
