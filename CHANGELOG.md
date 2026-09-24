# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-09-22

### Added
- **Playlist / queue**: `playlist` takes a list and an index the element owns — the bar's Next/Previous buttons, `Shift+N`/`Shift+P`, and (the part a page could never draw for itself) the skip pair on the lock screen and headset button, all wired up for free. `autoadvance` opts into auto-play-through with a delay and an end-of-list `loop`. An item with no `src` — a page whose sources are `<source>`/`<track>` children (a quality ladder, per-language audio) — hands loading back to the host while the element still owns the transport controls and announces each move as a cancelable `itemchange`.
- **Take over the `<video>` elements a page already has**: `upgradeVideoElements()` — or a zero-JS `<script type="module" src=".../element.js" data-upgrade>` tag — drops a `<movi-player>` in place of an existing `<video>`, including one driven by video.js, carrying across its attributes, `<source>`/`<track>` children, poster and id. The original element is kept as a live, hidden proxy, so a page's own `video.play()`, `video.currentTime = 60`, and `addEventListener("ended", …)` keep meaning exactly what they meant before — no page code has to change. `watch: true` upgrades elements added later, for an SPA.
- **`thumb="precise"`**: walks from the keyframe to the exact hovered frame and decodes it, instead of showing the keyframe before it — the difference that matters on long-GOP downloads, where a keyframe-only preview can be seconds away from wherever the pointer actually is. Opt-in, and now turned on by default in the three browser extensions and the web app, whose files are exactly that shape.
- **Thumbnail tracks read the way video.js and JW Player already write them** (`<track kind="metadata" label="thumbnails">`), replacing the player's own bespoke `storyboard` attribute — one spelling to learn instead of two. A `storyboard` *property* still covers a board worked out at runtime (a VTT URL, a tile spec), the shape YouTube and `videojs-sprite-thumbnails` use.
- **A control anchored to the top-right corner** (`placement: "top"`): a surface for controls about the session rather than about playback — cast, share, close — alongside the existing bar and menu placements; `["top", "menu"]` places a control on both.
- **A centred bar control** (`placement: "center"`) and **fullscreen-only controls** (`screen: "fullscreen" | "windowed"`): a spot in the middle of the bar for a host's own affordance (an end-screen "Suggestions" button, say), shown only in the surface it actually belongs on.
- **Point the player at an external subtitle file from a picker, not just markup**: `MoviPlayer.addSubtitleTrack()` / `addSubtitleFile()`, and a `subtitlepicker` "Add subtitle file…" row in the subtitle menu, let a viewer load an SRT/VTT/TTML file sitting next to their video without a reload.
- **DRM-protected content says so**: a source that needs a licence — none given, or one given and refused — now shows "Protected Video" with a plain explanation instead of a generic loading error, and plays through a packager's clear lead (video briefly visible before the licence check lands) rather than stalling and silently retrying forever.
- **Google Drive picker** ("Open with movi-player" on Drive): pick a video without the page jumping to the dialog as it opens; playback resumes automatically when the picker is closed if it was already running.
- **ChromeOS Files app integration and lock-screen skip**: the Chrome extension registers as a file handler, so double-clicking a video there (or a multi-select) opens it as a playlist here instead of sending you to find the toolbar icon first.
- **Firefox extension** and the **Chrome extension's toolbar icon** now open the full player page directly instead of a 320px popup, and both work correctly from an incognito/private window.
- **In-player debug console gets a level filter and search**, so a long session's log can be narrowed to what you're looking for instead of scrolled past.
- **`spinnerdelay` can hold the opening to a different wait than a stall** — `spinnerdelay="0.25 1"` reports a mid-play stall after a quarter of a second and leaves an opening alone for a full one. One number still means what it always meant. The two are not the same wait: a video that has not started has its poster up and is doing what a starting video does, while one that stops mid-picture has frozen — measured on a host that hit this, an ordinary cold open put the ring on screen for 925ms of a 1205ms startup, and no single number could cover that without also going quiet on real stalls.
- **`smoothwarning`: tell the viewer before it stutters.** One attribute puts up a notice when what is loaded is not expected to play smoothly at the current speed in words for the viewer rather than a developer — "This video may not play smoothly at 2× speed · It plays fine at normal speed — switch back to 1× if it stutters", or "This audio…" for a sound-only source. The technical reasons stay in the event. Checked on load and on every speed change, once per source and speed; a speed that fixes it takes the notice down. A cancelable `smoothwarning` event fires first, so a page can show its own. It is the prediction; the existing "Play at 1x" hint remains the measurement.
- **Ask whether something will play smoothly before playing it**: `MoviElement.canPlaySmoothly(url | file | query, { rate })`, and `element.canPlaySmoothly()` for what the element has loaded. Resolves with `playable`, `smooth`, `powerEfficient`, which decoder would carry the video (hardware, the browser's software decoder, or the built-in WASM one) and plain-language `reasons` — so a page can offer a lower quality or grey out 2x instead of learning from a stutter. It is the same judgement the player acts on when choosing a rendition — hardware path first, then software decode cost against the device's budget, with the browser's own estimate as a veto — plus a ceiling at 8K60 for hardware, the top of what hardware decoders are built for, because nothing else will say no: Chrome configured a hardware decoder for 8K at 120fps and MediaCapabilities called it smooth. `MoviPlayer.assessPlayback()` is the same thing on the player module.
- **A build a plain `<script>` tag can load**: `dist/element.global.js` (and `dist/element.slim.global.js`) register `<movi-player>` on load with no module anywhere, and `jsdelivr`/`unpkg` in the package now point at it. The package is ESM-only, so a CDN with nothing else to go on fell back to `main` and printed a classic script tag for an ES module — a copy-paste line that could only throw, pointed at the 11MB barrel rather than the element. The module build is still the one to reach for; this is for the page that cannot use one.
- **A loop with no seam**: `loop` on a video-only file now turns over without stopping first — the next pass is decoded and held while the current one finishes, so there is no black frame, no freeze and no re-open at the join. The attribute grew a grammar with it: bare `loop` (or `one`) repeats the **item**, `loop="all"` repeats the **queue** — the next item plays and the last leads back to the first — and a number is the gap in seconds between items, which can only mean the queue and so implies `all`. `loop="all"` turns `autoadvance` on by itself. Each turn fires a `loop` event carrying which turn it is, and `loopCount` reads the same number back.
- **`shuffle`**: play a queue in a random order. Its own attribute rather than a `loop` token, because it is its own question — a queue can be shuffled and played through once, and it can be looped in the order it was given. Everything that steps through the queue follows it: Next and Previous, the keys, auto-advance and the wrap. The item playing keeps its place when you switch it on, so it changes what comes next and nothing that is on screen, and each pass through a shuffled queue draws its own order rather than replaying the first one for ever. `reshuffle()` draws a new order on demand, and a `shufflechange` event reports either.
- **Shuffle and repeat in the playlist panels** of the Chrome and Firefox extensions and the web app: a repeat button cycling off → all → one, and a shuffle toggle. All three now ask the element for the order they play in instead of working one out themselves, so the panel button and the player's own context menu can no longer disagree — and the web app hands over its queue at the same time, which gets it the bar's Next button and the OS media controls for free.
- **Auto English captions, made in the browser.** Two APIs make it possible and the web app puts them together. `decodeAudio()` hands back the soundtrack as 16 kHz mono samples — the shape speech models take — from any point in the file, without playing it and on its own WASM instance, so a player already playing is not disturbed. `appendSubtitleCues()` writes a subtitle track as lines arrive, in any order, and shows a cue straight away if it covers the current moment; with `pending: true` the track is listed before its first line, with a turning ring where its language badge goes, and `removeSubtitleCues()` takes it away again. In the web app, "Auto captions" in the right-click menu puts "English (auto)" in the subtitle list at once, turning until its first line is ready (and gone again, with a note, if the video has no speech), and runs Whisper (base, through transformers.js) in a worker on 30-second windows and adds what it hears as "English (auto)" — translating when the speech isn't English. It starts at the playhead, follows a seek, rests once 90 seconds ahead, and fills in whatever was skipped; lines are cut to readable length and laid over the stretches that actually have voice in them, and the loops a small model falls into on music ("I'm not a man, I'm not a man…") are dropped. Silero VAD (2 MB) decides which stretches have someone speaking: a window with no speech never reaches Whisper — a song's 30-second instrumental intro was passed over in 0.2s — words it would invent over music are thrown out, and cues are timed to the voice rather than to whatever is loud. What has been made is kept per video in IndexedDB (a local file by name, size and date; a link by its address), so opening the video again shows its captions straight away without loading the model, and only the parts never reached are made. Nothing leaves the browser except the models, about 80 MB, downloaded once. Measured on a laptop: 30 seconds of speech in 3-10 seconds, with no frames dropped from playback alongside it.
- **Dividers on the control bar are public.** The line between the track controls and the viewing controls can be switched off (`controlslist="nodivider"`), restyled (`--movi-divider-color`, `--movi-divider-width`, `--movi-divider-height`, `--movi-divider-gap`, `::part(controls-divider)`), and used as an anchor (`after: "divider"`). A page can add its own with `addControl({ id, divider: true })`, placed like any control — including inside a capsule with `group` — and as a rule in the context menu with `placement: "menu"`. A divider left with nothing visible on one side of it in its capsule hides itself, so a control unavailable for this source doesn't strand a line at the end of a pill.
- **`posterdelay`**: how long to hold the OPENING poster back, in milliseconds. Default `0` — paint it at once, which is what a player without the attribute has always done. It is for a host that prefetches: when the first frame is already on its way, a poster that appears and is replaced a moment later is a flash the viewer reads as a fault rather than a cover, so a load that finishes inside the wait now shows no poster at all and the picture is simply there. Only the opening poster waits; one replacing a picture already on screen is unaffected.

- **Captions go where the viewer puts them.** Drag a subtitle anywhere in the picture and it stays there — across seeks, across sources, across sessions — and a double-click (or double-tap) puts it back. A hint says so the first few times a caption is carried, and stops for good once the reset has been used once. `controlslist="nosubtitledrag"` leaves the caption where the player puts it.
- **The browser extensions can hand a page's own video to MoviPlayer.** A toggle in the player page replaces a site's `<video>` with the player, in place, for a file at a URL — the streaming sites feed their element from JavaScript (MSE, DRM) and are left alone, so YouTube, Netflix and the rest are untouched. The site's own player chrome is hidden with it, and with site access granted the extension adds the `Access-Control-Allow-Origin` a file's host never sent, for that URL in that tab, so the player reads it rather than handing the file back to the browser. The settings row says when that access is missing and offers it.
- **The audio strip says where the pointer is pointing**: hovering or dragging its scrubber shows the time under the pointer, the way the seek bar over a picture always has. It is the shortest scrubber the player has, where a pixel is worth several seconds.
- **The home page hands over the install line**: `npm install movi-player` sits in the hero, and the line is the button — one click copies it.
- **The page can restyle the player's own chrome, and replace the loading ring.** Forty-four pieces of the shadow tree now carry a `part=` — every button on the bar (`::part(button)` for all of them at once), the progress track and its buffered/played/handle, the time, the centre play button, the title strip, the poster, the OSD, a caption line, and the spinner's box — so a page can restyle them with `::part()` without reaching into the shadow root. `<div slot="spinner">` replaces the built-in ribbon outright while the player keeps deciding when the ring is up and where it sits, and `controlslist="nospinner"` takes it off the screen entirely for a page that would rather draw its own somewhere else (`is-buffering` and `is-spinner-pending` still ride on the host either way). `::part(error-screen)` and `::part(subtitle)`, documented since they were written and never actually in the markup, are real now.

### Changed
- **The WASM module is compiled once and instantiated many times**: a second player, the hover-preview pipeline, and a pipeline rebuilt after a quality switch each used to fetch and compile their own multi-megabyte copy; now only the first one pays that cost, cutting both load time and memory for anything opened after it.
- **Adaptive load-shedding can lift again**: the frame-rate cap for underpowered devices used to engage and never release. It now watches for a sustained healthy stretch and lifts itself, backing off how often it retests so a genuinely weak device isn't probed too aggressively.
- **A speed change no longer costs a stall**: the audio already scheduled is kept and re-stretched to the new tempo in place, instead of being thrown away for a fresh demuxer seek — removing the pause a speed change used to introduce before the new rate audibly took hold.
- **Auto (adaptive) quality** gets several corrections on top of 0.4.0's rewrite: a unit bug that read the browser's own link estimate eight times too small (opening on the smallest rung over a fast connection), a bottom-rung confirm pass that never ran, a persisted link measurement a fresh session was ignoring, and a climb into an 8K rung priced off a *different* stream's paced throughput — each capable of opening a video too low, too high, or stalling the switch outright.
- **`/embed` now runs inside the embedding page's own origin** (a `srcdoc` iframe carrying the whole player), instead of loading a cross-origin moviplayer.com frame that needed CORS headers a host site may never send. An embed pasted before this change now explains what happened and offers a one-copy replacement snippet instead of silently failing.
- **The loading spinner now waits before it appears**: `spinnerdelay` defaults to `"1 2"` — a mid-play stall is reported after a second, an opening after two — instead of `0`. Opening a local file put a ring on screen every time, for a few hundred milliseconds, over a player doing exactly what it is supposed to do; a ring that comes and goes faster than it can be read is not information. `spinnerdelay="0"` asks for the old behaviour, and a thin-link page should lower it rather than leave it.
- Built against **FFmpeg 9.0.1**.

- **The audio strip keeps its controls.** A bar over a picture can go away, because the picture is still there to look at; the strip IS the player, so thinning it at rest took play, volume and the gear off the screen and left a clock and a line. It now stays as it is, whatever the auto-hide decides — and its title row starts on the same line as the controls under it, at the same size.
- **Fullscreen ends when the source turns out to be sound alone.** Switching to audio-only, or reaching a source that has no picture, used to leave a bar or a sleeve in the middle of a black screen with no way back but the keyboard.
- **The settings panel closes on a press anywhere outside it**, the way the track and speed popups always have — including a press on the picture, which dismisses the panel and nothing else rather than also toggling playback.
- **The adaptive decode ceiling is remembered for the session, not for the device.** A cap learned from one struggling file used to outlive the tab and quietly hold every later file down.
- The three browser extensions are now called **MoviPlayer**, the name the site and the element have used for a while.

### Fixed
- **The opening poster no longer fades up out of black.** It was faded in over 220ms on every load, and both the host and the canvas are opaque black before the first frame — so what the fade actually did was ramp a thumbnail out of black on every navigation, measured at opacity 0 to 1 across 158ms to 366ms. That reads as a flash, and it lasted as long as the fade rather than as long as the load. It now cuts to the poster, and the fade is kept for the case it was written for: a poster replacing a picture that is already on screen.
- **A prefetched start no longer re-downloads the head it just read.** The pre-play probe reads the head of the rung it is about to open and hands those bytes to the source so it does not fetch the same range again — except when the body came from the browser's cache, where it returned before the handover and the bytes were dropped. Measured on a prefetched open: the probe read the head in 23ms, threw it away, and the open then sat waiting for data for 129ms of a 345ms start.
- **A seek-bar preview no longer keeps downloading after it is on screen.** A hover on a stretch that has not been fetched pulls a 2MB window so a drag's next positions are already in hand, and the picture needs only its first few tens of KB — but the rest kept arriving for nobody once the pointer stopped: measured at 12 Mbit, the preview was up 0.12s into its request and 1.9MB followed over the next 1.5s, four seconds' worth on a 4 Mbit link. The window now stops half a second after the pointer comes to rest, or as soon as the card closes, keeping what has arrived. The seek bar decides it rather than the player, because mid-drag it holds requests back for up to 1.5s on purpose; a drag still fetches exactly as before (the same 2 windows and 7 pictures over the same scrub).
- **A speed change no longer costs a hitch on Bluetooth.** The picture holds back by however long the sound needs to reach the speakers, and it reads that wait off the anchor the audio clock's arithmetic hangs on — an anchor a speed change re-bases to "now" so the old rate's elapsed time isn't read at the new one. Nothing about the sound restarts there; it is playing, and has been. But the wait was then answered with the output's whole latency: measured at 213-239ms per speed change against a 250ms output, where a built-in speaker's 10ms had always hidden it. The run's real start is now its own anchor, so a genuine start and a post-seek resume still wait (500ms and 359ms on that same output) and a speed change waits for nothing.
- **A tab the browser discarded comes back where it was, not at 0:00.** Leave a tab in the background long enough and Chrome's Memory Saver takes its memory; going back reloads the page. A native `<video>` and YouTube return to the same spot, and this returned to the start. The position, whether it was playing and the speed are now written to `sessionStorage` as the tab is hidden, frozen or unloaded, and restored when `document.wasDiscarded` says the reload is that one — no prompt, no attribute, and nothing different for an ordinary reload. The opening-frame paint had been seeking straight back to 0 five milliseconds after the restore; it now stands aside for a restored position the way it already did for `startat`. URL sources only: a local file cannot be handed back to a reloaded page.
- **The picture froze for a second or two shortly after playback started**, on any source — the clock running, the renderer holding frames it had already decoded. Leaving the buffering state parks on "paused" and then calls `play()`, which is asynchronous; the decoder kept handing frames over throughout and every one that landed in that window was thrown away. Measured on a 20s 1080p30 file: 33 frames binned, and a 1.1s freeze where they should have been.
- **The picture no longer freezes at slow speeds.** The A/V drift budgets were measured in media time, which made them four times looser at 0.25x than at 1x; a speed change made while PAUSED re-scaled the whole span before it and stopped the picture for twenty seconds; and the read-ahead trim could cut forward a whole GOP while the decoder was still waiting for a keyframe, or into an open-GOP picture that was not a reference reset at all.
- **A video-only file's picture no longer waits for sound that will never come**: the renderer holds its clock back by however long the audio needs to reach the speakers, and with no audio track that figure is a cold-start prediction — 560ms, applied at every re-anchor. On a loop it meant the picture came back more than half a second after each turn and ran that far behind the clock for the rest of the pass.
- **No spinner over a picture that never stopped**: the "if sound and picture are both moving, nothing is loading" guard asks whether the clock has advanced since it last looked, and a backward seek — a loop coming round to the top, a scrub back — makes that reading say "stopped" for the length of its 600ms sample. Long enough for a ring to appear and go over playback that was running.
- **Hovering the seek bar right after a resume** took 4-7 seconds on a large remote file and a second thereafter: the cached head was sized to what probing the container needs, not to what OPENING it needs, so the resumed session re-fetched the whole header before it could answer anything.
- **A video-only file in a background tab** ended at its last decoded frame instead of playing its tail out — a hidden tab keeps no frame queue, and the end-of-file test read that empty queue as "the picture is finished".
- **A file whose audio track ends before its picture does now plays to the real end**, instead of stopping dead the moment the sound runs out — the mirror of the tail case the player already handled (video ending first, audio carrying on). Fixed alongside it: a soundtrack that has finished being misread as one that's *starving* (drawing a spinner over the rest of the film), a seek into that tail that could hang forever, and a leftover frame from before a seek reaching the screen and dragging playback back to where it was seeked from.
- **Seeking is faster on long-GOP sources**: a seek now lands on the keyframe *ahead* of its target — instead of always decoding forward from the keyframe behind it — when that keyframe is close and the walk back is long, cutting a 1.2-second seek down to under 200ms on an 8K60 file with 7-second keyframe gaps.
- A **seek that settles paused and is then played** no longer jumps the picture forward by seconds and never heals; a **click on the seek bar** no longer restarts playback twice (once on press, once on release); a seek held open by a **blocked autoplay** no longer leaves the picture frozen for a couple of seconds with nothing to explain it.
- Several **audio-gain glitches after a seek**: a race between a seek's own volume fade and the underrun "duck" could park the level near zero with no way back except a reload; a watchdog now restores the master gain if it's ever found off-target for more than a few seconds, without fighting a fade that's already in progress on purpose.
- **Software-decoded audio** (TrueHD/DTS and other formats forced off WebCodecs) had its PCM output handed to the renderer in multi-second blocks instead of ~150ms ones — the old shape meant a speed change could leave up to three seconds of old-speed audio playing under an already-changed picture.
- **Context-menu submenus** (Playback Speed, Audio Track, Audio Output, Subtitle Track) could fail to open on click on desktop, flash a stray panel in the player's corner after picking an item, or reappear after the menu that owned them had closed — all from the same portal bookkeeping, fixed together.
- **Seek-bar and thumbnail previews**: a scrub no longer waits for the pointer to stop before showing anything (coalesced to the display's own refresh rate instead of a debounce the pointer never let fire); a far hover on a large remote file no longer re-bisects the whole file when the Matroska's own index was there to read; the first hover on an HTTP source reuses bytes already downloaded instead of paying for a fresh 2MB fetch; and `thumb="precise"`'s decode walk no longer gives up part-way through a long GOP and shows the very keyframe picture it exists to replace.
- **Auto quality** no longer collapses the whole rendition ladder in response to a stall the player caused itself (a rendition switch, a seek), and drops a rung before blaming a link that's actually still delivering.
- A **missing container duration** (a live-muxed Matroska with nothing in its header) now gets a second, unhurried scan a few seconds after load instead of settling for good on "0:00" with a dead seek bar.
- **Mobile paste-a-link flow**: the field no longer loses room to the paste/protected/Play controls on a phone, the Play button is sized and centred like an actual button, and the bar itself is thinned to phone proportions.
- Several **native-`<video>`/HLS-DASH-fallback correctness fixes**: the element now reports `play`/`pause`/`seeking`/`seeked`/`paused` the way a native `<video>` would (matters for code ported from one), a source with no audio track no longer offers a volume control it can't act on, and the player now says so when the browser is silently dropping audio it can't decode while picture keeps playing.
- **Open-GOP (CRA/BLA) streams and transport-stream seeks**: a string of decoder-queue, reference-chain and reorder-tail fixes so a keyframe that doesn't reset the reference chain, a disposable frame with no container hint, or a transport-stream seek landing off its intended keyframe no longer stalls or corrupts playback.
- A control capsule (gear, aspect ratio, PiP, fullscreen) could get permanently marked "empty" by a measurement taken while the bar was hidden, and never come back even once it held visible controls again.
- **DASH sources**: an audio track no longer appears once per bitrate rendition, dash.js's own thumbnail track is read instead of ignored, and a preview is no longer promised on a source that can't actually produce one.

- **A source with no picture shows its captions.** A track that is sound alone — or a video switched to audio-only to save data — ran its caption clock off the renderer, which is not running when there is nothing to render, so the subtitles never appeared.
- **A hover on an 8K film no longer stops the page.** The seek-bar preview decoded at the source's own resolution (132MB of pixels a frame) and fell back to software decoding when that failed; it now works at preview size, and gives up cleanly instead of hanging when even that is too much. Thumbnails fill their box rather than sitting letterboxed in it.
- **An audio track whose link dies says so.** A split stream fetches its sound separately, and an expired URL there left the picture running in silence while the reader retried on every animation frame — hundreds of identical log lines and no reason given. It now ends with the failure the source reported, which is what a page needs in order to re-issue the link.
- **A cover-art player's menus are no longer clipped** by the collapse that takes its bar's clusters away, and the loading spinner keeps its size and its place over the centre button.

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
- **Captions rotate with the video**: rotating the video (`R` / menu) now turns the subtitles with it and keeps them on the rotated video's bottom edge — for both text and image (PGS/VobSub) subtitles.
- **Blurred backdrop for embedded album art**: audio files with *embedded* cover art now get the same blurred-artwork backdrop that poster-based audio already had, instead of a plain dark background.

### Fixed
- **Fullscreen: the right-click / gear menu wouldn't open**: the desktop context menu portals to a body-level layer to escape page clipping, but in fullscreen the player itself is the fullscreen element, so the body-level menu rendered outside it and never appeared. In fullscreen the menu now stays within the player and positions itself directly.
- **Context-menu toggles didn't reflect their new state**: toggling Ambient Mode / Stable Volume / Loop / Rotate / HDR from the menu didn't update the row's On/Off label and highlight (the state was written to the wrong place while the menu was portaled) — it now updates correctly.
- **Volume slider offered a 200% boost on native audio**: a single external audio source (one `<source kind="audio">`) plays through a native `<audio>` element, which can't apply the WebAudio boost — the slider now caps at 100% there instead of promising a boost that won't happen.

### Changed
- **Wider context-menu submenus**: the audio-track and audio-output submenus are wider so long track / device names (e.g. "MacBook Air Speakers (Built-in)") no longer wrap.

## [0.3.4] - 2026-07-11

### Added
- **OS Media Session — lock-screen & hardware-key controls**: playback now surfaces on the OS lock screen / notification shade with title metadata, artwork (poster, a captured frame, or embedded cover art), and play / pause / stop / seek controls — driven by `navigator.mediaSession` and reachable from hardware and Bluetooth media keys, with a position scrubber kept in sync as you seek or change rate.
- **Press-and-hold to 2x (touch)**: a YouTube-style long-press on the video speeds playback up to 2x while held and reverts on release, with an on-screen "2×" pill.
- **Settings (gear) button**: since long-press now drives the hold-to-2x gesture on touch, a discoverable gear button in the top-right opens the same menu right-click opens on desktop.
- **"Play at 1x" stutter hint**: on a source the decoder can't sustain above 1x (e.g. 8K60 AV1) — video drops frames while audio stays smooth — the player shows a one-off OSD nudge to drop back to 1x, with a cooldown so it doesn't nag.
- **360°/VR seek-bar preview reprojection**: hovering the seek bar on a 360°/VR source now shows the same perspective you're currently looking at, instead of the raw flat equirectangular frame.
- **Themeable control-bar colors**: additional chrome colors (icon foreground, surfaces, PiP accent, hairline border) are now driven by overridable `--movi-*` CSS custom properties for easier embedder theming — no visual change out of the box.
- **Volume boost to 200%**: the volume slider now goes above 100% up to 200% (VLC-style), with a tinted boost zone above the unity mark, for quiet sources. Enabling stable audio tames clipping on already-loud content.
- **Screen-reader accessibility**: an off-screen `aria-live` region announces each caption as it appears (the canvas-aligned overlay isn't a reliable source on its own), and the seek and volume controls are now real `role="slider"` widgets that announce position as text ("1:23 of 4:56", "Volume 150%").
- **QoE analytics (`movi-qoe`)**: a versioned quality-of-experience event stream — startup time, rebuffering, bitrate switches, decode-fallback, errors and periodic heartbeats — surfaced as a DOM event and via `addQoeSink()` / `getQoeSession()`, with a built-in `beaconSink(url)` for cookieless POST to Mux / GA4 / your own endpoint.
- **Framework wrappers + typed element**: official typed `movi-player/react`, `movi-player/vue`, and `movi-player/svelte` wrappers (subpaths of the one package — no extra install), plus `HTMLElementTagNameMap` typing so `<movi-player>` is typed in plain TypeScript.
- **Embed / headless bare player + `noerrorscreen`**: a `<movi-player>` with **no `controls` attribute** is now a pure display surface — no resume dialog, no "No Video" empty state, no loading spinner, and no mouse interaction at all (click, double-click, right-click and drag are inert) — for background/hero videos or a host-driven render canvas. The new **`noerrorscreen`** attribute additionally suppresses the built-in error overlays so an embedder can render its own error UI.
- **Number-key seeking (`1`–`9`)**: pressing `1` through `9` jumps to 10%–90% of the timeline, YouTube-style, alongside the existing `0` / `Home` (seek to start).
- **Swipe-to-dismiss touch menu**: on touch devices the context menu (opened from the gear) is a right-side drawer — you can now drag it back toward the right edge to close it, matching the slide-in direction. Vertical scrolling and taps inside the menu are unaffected.
- **Pinch to change aspect fit in fullscreen (touch)**: on a touch device in fullscreen, a two-finger pinch now switches the video fit YouTube-style — spread to zoom-to-fill (crop to edges), pinch in to fit (contain) — with the same Fit/Fill OSD as the aspect-ratio button. Gated to fullscreen so it never fights inline page scroll/pinch-zoom, and excluded from 360° mode.
- **iOS Safari pseudo-fullscreen fallback**: iOS Safari only exposes the Fullscreen API for `<video>`, and the player renders to canvas — fullscreen now falls back to a CSS viewport-fill mode (spanning behind Safari's toolbars) with forced-landscape rotation for landscape video on a portrait screen, since iOS won't rotate the page for you. iPad and other browsers with real element-fullscreen support are unaffected.
- **Small-player control bar and menu overhaul**: an embedded or resized player now stays usable down to ~100px wide — tighter padding/buttons/gaps below 400px, the PiP button folds behind the "more" toggle, the expanded control cluster scrolls horizontally instead of overflowing, the fullscreen button folds in below 290px, the resume dialog stacks and spans the player instead of clipping, dropdown menus cap their height to the room inside the player so the first row is never chopped off, and the top-right gear now hides while a bottom dropdown or the timeline panel is open.

### Fixed
- **HTTP streaming without cross-origin isolation (COOP/COEP)**: HTTP(S) sources no longer need the isolation headers (`SharedArrayBuffer`) to play. The WASM engine is single-threaded with Asyncify I/O, so `HttpSource` now falls back to a plain-buffer streaming path — fixing a `Failed to open media: Timeout at 0` that made HTTP sources fail on any page served without the headers. Setting COOP/COEP now only enables an optional zero-copy fast-path.
- **Fullscreen auto-rotation forced landscape for portrait video (Android)**: entering fullscreen no longer rotates a portrait clip to landscape. Portrait phone footage is commonly stored as landscape frames plus a 90°/270° rotation flag, so the orientation lock now reads the effective display rotation (metadata + manual) before choosing portrait vs landscape.
- **Audio-strip (collapsed 56px) mode**: keyboard shortcuts now work while collapsed; the settings gear aligns with the title, stays visible (no auto-hide) and appears as soon as a source loads; the touch context menu no longer overflows the player edge; the strip reflows when embedded cover art arrives late; and a strip with no `controls` hides itself entirely.
- **Picture-in-Picture cursor**: the mouse cursor stays visible over the area above the controls in document Picture-in-Picture.
- **Touch press-and-hold to 2x too eager**: raised the long-press threshold to 600ms, and the gesture now cancels when it turns into a scroll, so it no longer fires by accident.
- **Resume-dialog selection ring**: the arrow-key selection ring is now actually visible on pointer devices (a global `outline` reset was hiding it) and hidden on touch devices.
- **Blank snapshot on hardware-decoded AV1**: a snapshot that read back blank from WebGL (seen on 4K AV1 hardware decode) now falls back to the decoded `VideoFrame`.
- **Settings gear on non-touch devices**: the top-right gear is hidden where a right-click already opens the menu.
- **Safari first-load flash**: no more flash of unstyled overlays on the very first load in Safari.
- **OS Media Session focus**: the silent audio anchor is now long enough (≥5s) for the OS to grant full media-key / lock-screen focus.
- **Volume clamping**: the native-element volume path is clamped to `[0,1]` and the on-screen slider caps at 100% unless boost is enabled.
- **Context menu clamped on-screen**: the right-click / gear menu repositions after opening so it never spills outside the viewport.
- **Lite / proxy browsers without cross-origin isolation**: the player initializes and runs on reduced browsers that don't provide `SharedArrayBuffer`.
- **Open-GOP CRA-opening HEVC stuck on "buffering"**: files that open mid-stream on an open-GOP CRA frame (common with cut/re-encoded clips) no longer hang forever — a seek now accepts a CRA at or before the target instead of waiting indefinitely for an IDR.
- **TrueHD/DTS buzzy or jittery audio around seeks and replays**: a cluster of fixes removes choppy/buzzy audio and gap-fill jitter on TrueHD/DTS (MLP/DCA) sources — the software audio decoder now flushes its state correctly on seek, a cold-start priming cushion is applied on every seek and replay (not just the first play) so the sub-realtime decode doesn't underrun, and replaying no longer trips a spurious A/V-desync resync. Lightweight/hardware codecs (AAC, Opus, FLAC, AC-3) stay instant.
- **Multi-audio-track files stalling every few seconds**: files carrying a second, unused audio track (e.g. dual-TrueHD releases) no longer stall repeatedly — unused audio streams are now discarded at the demuxer level so the active track's packets aren't starved by the interleaved packets of the track nobody's listening to.
- **Crash on load with newer WASM builds**: builds whose WASM heap uses a resizable `ArrayBuffer` threw inside `TextDecoder.decode()` and blocked every file from loading; heap bytes are now copied out before decoding.
- **Playback stalling after resuming from the background**: resuming a hidden tab (including via the new Media Session lock-screen controls) now restarts the un-throttled background decode timer, so audio no longer starves and video no longer jumps ahead of audio when you return to the tab.
- **SigV4 presigned URLs (S3 / R2 / GCS) failing to load**: a `HEAD` size-probe on a presigned URL legitimately returns 403/401 (the signature is bound to the HTTP method) — the player now falls back to a ranged/plain `GET` instead of treating it as access-denied. The Chrome extension's link probe also now recognizes presigned download links that carry no file extension in the URL path.
- **Context-menu submenu options all showing "active" (touch)**: the Fit and Speed submenus, which move outside the menu's overflow area at runtime, no longer accumulate a stale highlight on every option tapped.
- **Selected-track text unreadable in light theme + auto-hide stuck open**: the active track's codec/language text is now readable in light theme, and switching audio tracks correctly restarts the controls auto-hide timer instead of leaving the bar up indefinitely.
- **VS Code extension bundle out of date**: the published extension was missing the audio-output, VR, and FLAC fixes shipped in 0.3.3 because packaging skipped the bundle-copy step — republished with the current player build.
- **VS Code: fullscreen button hidden despite fullscreen working**: the player auto-hides its fullscreen button when the embedding iframe reports `fullscreenEnabled=false` — true for a VS Code webview, but fullscreen still works there via the extension host. The webview now grants the capability so the button stays.
- **Embed: dead fullscreen/PiP/audio-output controls no longer shown**: fullscreen, Picture-in-Picture, and audio-output controls are now hidden (instead of failing silently on click) when the embedding iframe's Permissions Policy doesn't allow them, with PiP additionally retiring itself if opening its window throws.
- **`playsinline` now also gates touch gestures**: an inline player on a touch device suppresses swipe-seek/volume gestures so they don't fight page scroll, resuming in fullscreen — behavior previously tied to the separate `gesturefs` attribute, which is now deprecated (still honored for compatibility).
- **Right-click context menu clipped by page layout**: the menu now portals to a body-level layer on open so it can escape any clipping ancestor (a page wrapper's `overflow:hidden`, etc.) instead of getting chopped at the player's edge, matching native context-menu behavior. Submenus are viewport-aware in this mode.
- **Resume-dialog selection ring didn't follow the pointer**: hovering Cancel while Resume was selected left the ring on Resume; the ring now moves to whichever button the pointer is over, matching arrow-key behavior.
- **Scrub thumbnail previews depended on attribute order**: `<movi-player src=… thumb>` could silently build with previews disabled because `src` triggered `load()` before the `thumb` attribute was read. Attribute order no longer matters, and pressing the timeline key (`T`) now generates thumbnails on demand regardless of the `thumb` attribute.
- **Timeline panel: thumbnails touching + controls-bar flash on close**: increased the thumbnail-strip gap and shrunk the hover/active pop so scaled thumbnails no longer overlap their neighbors on small players; closing the panel no longer causes a stray flash of the auto-hidden controls bar.
- **360° mode: scroll-wheel accidentally zoomed the view**: removed the wheel listener in 360°/VR mode so page scrolling behaves normally; drag-to-look and pinch-to-zoom remain the intended navigation.
- **Aspect-fit menu item didn't show the Fit/Fill OSD**: changing aspect ratio from the context menu now flashes the same on-screen confirmation as the aspect button and keyboard shortcut.
- **Pinch-to-fit and press-and-hold-to-2x could fire together**: a second finger landing while hold-to-2x was armed (or already engaged) now cancels it, so a pinch gesture can't trigger 2x mid-pinch.
- **HTTP streaming: large remote files restarted mid-playback on small out-of-window reads**: a small read outside the active stream window used to force a full stream restart (visible as the request abruptly "cancelling" on large files, e.g. from torbox-style sources). It's now served with a one-off range fetch while the main stream keeps running, with a cap on consecutive one-off fetches so a genuine seek still restarts the stream cleanly. (Thanks @anilabhadatta.)

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
- **MPEG-DASH playback (`.mpd`) (closes #9)**: DASH manifests now play through the adaptive-streaming pipeline alongside HLS. Standard demuxed DASH is fully supported; the player draws dash.js/Shaka frames to the shared canvas via `requestVideoFrameCallback` so all UI, stats, and the quality menu stay format-agnostic.
- **Unified adaptive streaming via Shaka Player (HLS / DASH / Smooth)**: Shaka Player is now the primary adaptive engine, collapsing the old hls.js/dash.js wrapper pair into a single format-agnostic `streamWrapper` that handles `.m3u8` (HLS), `.mpd` (DASH), and `.ism` (Smooth Streaming). hls.js and dash.js remain as automatic fallbacks. `DashFallback` resolves bare-`BaseURL` manifests Shaka rejects (`DASH_EMPTY_PERIOD`) by playing the fragmented MP4s through the demuxer.
- **Live-stream UI**: A `LIVE` badge that jumps to the live edge, DVR-window seeking, and an Auto-mode quality badge showing the currently-served rendition.
- **Custom request headers (`headers` attribute / property)**: Send auth tokens or signed headers across the *entire* media network flow — manifest + segments (Shaka request filter, hls.js `xhrSetup`, dash.js request interceptor), progressive HTTP, thumbnails, and the encrypted source (stream GET + token refresh). Set via the `headers` attribute (JSON string) or the `headers` property (object) on `<movi-player>`, or `PlayerConfig.headers`. Native `<audio>` can't carry headers, so split-audio tracks are fetched with headers and played from an in-memory blob URL.
- **Audio-only data-saver mode (`audioonly` attribute / `audioOnly` property)**: Play just the audio to save CPU and bandwidth. Muxed files skip the video decode; adaptive streams switch to an audio-only (or smallest) rendition with ABR off; split sources stop the demux loop entirely so the video body never downloads. Live-toggleable without a reload, and the UI forces the album-art / strip surface.
- **Non-range (no-Range) server playback**: Servers that ignore `Range` (respond `200`, not `206`) now play instead of hard-failing. Small bodies are cached whole for full random access; larger bodies use a bounded forward-only sliding window (**linear mode**) with a trailing history so in-window seeking still works. A new `linearmode` event lets the UI adapt (keep the scrubber, hide the seek-dependent thumbnail strip, clamp seeks to the buffered RAM window).
- **MPEG-5 LCEVC decoding (`lcevc` / `lcevcurl` attributes)**: Opt-in LCEVC enhancement-layer decoding for adaptive streams via the external `lcevc_dec.js` library (`PlayerConfig.lcevc` / `lcevcUrl`).
- **Muted-autoplay fallback for split native-audio tracks**: When autoplay-with-sound is blocked and audio comes from a separate native `<audio>` track, the player now rolls the video muted on the wall clock and shows the "Tap to unmute" pill (matching the WebAudio path) instead of freezing on the first frame.
- **Extension: detect `.mpd` (DASH) URLs in page scan**: The Chrome extension's play-button overlay, URL probe, and player now recognise `.mpd` links and the `application/dash+xml` content-type.
- **VS Code extension: adaptive streaming via URL**: `Movi: Open Video from URL` now plays HLS (`.m3u8`), MPEG-DASH (`.mpd`), and Smooth (`.ism`) manifests by loading them **directly** in the bundled player's engine against CORS-enabled CDNs, instead of the host byte-range proxy — the proxy can't resolve a manifest's relative segment URLs, so progressive files still use it while adaptive streams bypass it.
- **VS Code extension: `.ts` (MPEG-TS) in the open-file dialog**: added to the `Movi: Open Video File` picker filter (kept out of the single-click custom-editor association so `.ts` TypeScript files aren't hijacked).

### Changed
- **DRM key-system order**: Adaptive-streaming DRM now tries Widevine → PlayReady → FairPlay in order.
- **Manifests load directly, never via `/proxy`**: Adaptive-streaming players fetch the manifest and its (relative) segment URLs themselves, so `.m3u8` / `.mpd` / `.ism` manifests are now loaded directly in both the web app and the `/embed` page. Routing them through `/proxy` broke relative segment resolution and tripped the proxy's content-type allowlist on the `text/xml` manifests some CDNs serve.
- **Size resolution hardened for CDNs that strip `Content-Length`**: Source size is recovered via a retry chain — HEAD → ranged GET → last-resort plain GET — so seeking and progress work on servers that omit `Content-Length` on HEAD.
- **deps**: add `shaka-player ^4.11.2` and `dashjs ^5.2.0`; bump `hls.js` to `^1.6.16`.

### Fixed
- **Robust startup**: blocked-autoplay sources now keep a visible play affordance (the centre play button no longer stays hidden after a rejected `ready → paused` transition); the first-play demuxer seek is guarded so a degenerate source goes to `error` instead of throwing an uncaught `error -1` and looping `play()`; background-tab autoplay is deferred until the tab is visible (browsers throttle/gate background autoplay anyway).
- **Stream: don't emit wrapper errors mid-fallback**: hls.js/dash.js (fallbacks behind Shaka) no longer fire an `error` event on a *pre-load* failure — they reject `load()` only — so the error overlay no longer flashes a spurious "Try Software Decoding" button while the player works through the fallback chain.
- **HTTP errors surface real messages**: `403` / `404` / `5xx` now read as access-denied / not-found / server-error (Shaka `NETWORK` code split on `BAD_HTTP_STATUS`) instead of a generic "check your internet" / decode-failure message.
- **Wake lock**: skip the request entirely while the page is hidden (the API rejects there), retry once (~600 ms) on a transient failure while visible, and re-acquire idempotently on tab-visible and on resize (fullscreen / orientation / PiP transitions) so a dropped lock recovers.
- **Don't collapse a loading/errored video into the 56px audio strip**: a still-loading or failed video source (which has no tracks yet) is no longer mistaken for audio-only on a resize — audio-only is decided from the `src` media type until tracks resolve.
- **App: don't proxy same-origin URLs**: avoids a `522` self-fetch loop.
- **App: don't magic-sniff tiny range probes in `/proxy`**.
- **Volume slider opens on first touch** even when `matchMedia` reports hover-capable, and collapses when the controls bar hides.
- **Ambient mode re-applies after a `src` change** instead of staying "on" in the menu but not painting.
- **Audio-only replay/loop restarts the separate native `<audio>`** (the `wasEnded` path previously left it paused); no custom right-click context menu when there's no `controls` attribute.
- **Cover-art backdrop blur** moved from canvas `ctx.filter` (ignored by Safari < 17) to a CSS `filter: blur()` layer — a real Gaussian in every browser; an audio-only `poster` now renders as album art (blurred backdrop + centred) instead of the bare strip.
- **Empty-state centring** uses a host class instead of `:has()`, and the "Security Headers Missing" diagnostic no longer doubles up.

## [0.3.0] - 2026-06-02

### Added
- **Signalsmith Stretch audio rate-change pipeline**: Replaced SoundTouch with Signalsmith Stretch as the sole pitch-preserving time-stretcher. Compiled to WASM via `wasm/movi_stretch.cpp`. Delivers clean pitch-preserved playback at non-1x rates without the phase artifacts that SoundTouch exhibited on speech and complex music. Includes eager pre-warm so the first rate change doesn't glitch.
- **First-class audio-only support with strip UI**: Audio-only files (MP3, FLAC, AAC, Opus, etc.) now play through the canvas pipeline with a dedicated audio strip UI (cover art, title, progress bar, controls) instead of falling back to a hidden native `<audio>`. Always-software decode path ensures every codec works regardless of WebCodecs audio support.
- **Muted-autoplay fallback with tap-to-unmute**: When autoplay is blocked by browser policy, the player now starts muted and shows an "unmute" pill overlay. Tapping the pill or pressing `M` restores audio with a single user gesture.
- **Cover art display for audio**: JS-only album art extraction via an isolated demuxer context — reads embedded artwork from MP3/MP4/FLAC containers without requiring a canvas or WebCodecs. Falls back to a gradient placeholder when no art is found.
- **Custom `SourceAdapter` for `<movi-player>` and `MoviPlayer` (closes #7)**: Plug any custom byte protocol (WebSocket, WebRTC data channel, IndexedDB, custom encryption, etc.) directly into the element or programmatic player. New `sourceAdapter` property on `<movi-player>` and `sourceAdapter` field in `PlayerConfig`. `src` / `sourceAdapter` are mutually exclusive — setting one clears the other.
- **File-source preload settling gate**: `play()` and resume are gated until the initial preload window fills, preventing the player from entering a buffering loop on large local files.
- **YouTube-style centre play button**: Always-visible large play/pause icon in the centre of the player. Shows immediately when the spinner clears; suppressed during autoplay startup to avoid flash.
- **Unified controls chrome — dark gradient bar + redesigned OSD**: Bottom controls use a dark gradient overlay with redesigned on-screen display (volume, time, speed). Opaque backgrounds replace backdrop-filter blurs for better mobile performance.
- **Extension: playlist shuffle, autoplay toggle, next button**: Chrome extension playlist now supports shuffle mode, an autoplay-next toggle, and a next-track button.
- **Extension: hover-probe links + opt-in toggle + flag detection**: Links to video files are probed on hover; opt-in toggle in popup settings; automatic flag emoji detection in tab titles.
- **Compare page (`/compare`)**: Side-by-side comparison of native `<video>` vs `<movi-player>` with sync playback toggle, auto-selected English subtitles, audio codec row, and HDR canvas-flag tip.
- **VS Code extension — URL streaming via host fetch (closes CORS)**: `Movi: Open Video from URL` streams remote URLs through the extension host (Node.js `fetch`), bypassing webview CORS entirely.
- **VS Code extension — URL multi-window commands**: `Open URL to the Side` and `Open URL in New Window` for remote URLs.
- **VS Code extension — Activity Bar entry**: Dedicated Movi Player icon with Quick Actions view.
- **Homepage redesign**: Simplified landing page targeted at non-technical users.

### Changed
- **4K playback rate cap raised to 2x**: Removed the blanket 1.5x rate cap for 4K+ sources — only 8K+ is capped at 1.5x now. Hardware decoders can sustain 2x on 4K content.
- **Renderer queue split for 4K vs 8K**: `baseHwQueue` cap is now resolution-aware — 4K gets a larger queue than 8K, fixing 4K HEVC stutter that was caused by the previous one-size-fits-all cap.
- **UI update loop throttled to 4Hz**: Progress bar and time display update at 4Hz instead of 60Hz, cutting UI-related jank during playback.
- **Volume slider uses perceptual (log) gain curve**: Volume slider now maps through a logarithmic curve so 50% slider position sounds like 50% loudness instead of ~25%.
- **Ambient mode FBO mirror**: Ambient mode now samples a 16x16 RGBA8 FBO instead of reading back the full canvas, eliminating the ~100ms GPU stall per sample on high-resolution content.
- **Thumbnail hover latency cut**: GOP scan stops after the first keyframe instead of scanning the entire file, reducing hover-to-thumbnail latency.
- **Dropped backdrop-filter blur from all UI surfaces**: Replaced with opaque backgrounds for better mobile compositing performance.
- **README redesigned**: centered hero banner image, expanded badge row, quick-link bullets.
- **Browser support updated**: Firefox 130+ now listed with WebCodecs `Yes` and HDR `Limited`.
- **Author spelling**: `Ujjwal` → `Ujjawal` in README, `package.json`, and outreach docs.
- **AGENTS.md shipped in package**: Architecture guide for AI coding assistants included in the npm package.
- **File picker extended**: Drop-handler and file picker now accept audio extensions alongside video.

### Fixed
- **Decode: skip orphaned RASL leading pictures after CRA/BLA seek resume**: Prevents decode errors when resuming into a CRA/BLA region that has orphaned RASL reference pictures.
- **Decode: keep DoVi/HDR HEVC on hardware**: Poster generation now runs on the main decoder instead of the thumbnail pipeline; decoder is recreated on seek; no open-GOP software fallback that would drop DoVi metadata.
- **Decode: fast software fallback for mid-stream open-GOP HEVC**: Instead of 15 rounds of stutter, the decoder now detects open-GOP HEVC and falls back to software quickly.
- **Decode: drop tiny corrupt non-keyframe packets before decode**: Small orphaned packets that confuse hardware decoders are dropped pre-decode.
- **Decode: restrict post-flush keyframe-reject software fallback to HEVC**: The recovery path no longer triggers for non-HEVC codecs.
- **Decode: limit tiny-packet drop to the post-flush startup window**: Avoids dropping legitimate small packets during mid-playback.
- **Decode: only drop tiny show_existing_frame packets at non-1x**: Prevents reference chain corruption at normal playback speed.
- **Demux: prepend AV1 Temporal Delimiter OBU for spec-compliant WebCodecs chunks**: Fixes AV1 decode errors on browsers that require the TD OBU.
- **Seek: prefer IDR but fall back to CRA so all-CRA regions still resume**: Seek now handles CRA-only streams correctly.
- **Seek: resume into buffering on forced seek-timeout to avoid black screen**: After a seek timeout, the player enters buffering state instead of showing a black frame.
- **Playback: don't buffer on mid-playback decode-error recovery**: Keeps audio running during decoder recovery instead of entering a buffering loop.
- **Playback: don't auto-start on load when playback rate is restored**: Restored rate no longer triggers an unwanted auto-play.
- **Playback: stop rapid seeks/rate changes from getting stuck paused**: Corrective seek on rate change no longer leaves the player stuck in paused state.
- **Playback: stamp _playStartTime on seek-completion resume**: Prevents spurious seek(0) after completing a seek.
- **Playback: skip stall detection during decoder recovery**: Prevents the stall detector from triggering a buffering loop while the decoder is recovering.
- **Playback: cut old-rate audio tail on rate change without clock leap**: Audio transition between rates is now seamless.
- **Playback: replace rate-change corrective seek with audio resync**: Corrective seek replaced with audio resync; keyframes-only on audio-starve.
- **Playback: start at 0 on first play/replay, re-seek on rate change**: First play always starts at 0; rate change triggers a re-seek for correct A/V alignment.
- **Playback: end playback when video tail sits past audio playout head**: Prevents infinite playback when video ends before audio.
- **Audio: map volume slider through perceptual (log) gain curve**: 50% slider = 50% perceived loudness.
- **Audio: no pitch-shift at startup on >1x**: Eager-warm the stretcher so the first frame at non-1x doesn't glitch.
- **Audio: block video-only keyboard shortcuts in audio-only mode**: Arrow seek and other video shortcuts are suppressed for audio-only sources.
- **Audio: skip video presentation loop for audio-only sources**: No wasted canvas draws for audio-only playback.
- **Audio: stop near-end seek clipping audio-only playback**: Seek near the end no longer clips the final seconds.
- **Audio: drop double startTime add in EOF playout check**: Fixes premature EOF detection.
- **UI: don't flash controls on tap; drop resume dialog when chrome hides**: Controls no longer flash on tap; resume dialog is dismissed when chrome auto-hides.
- **UI: keep play/pause icon on intended state through stalls and startup**: Play/pause icon no longer flips during buffering or startup.
- **UI: show centre play icon immediately when the spinner clears**: Eliminates a visible delay between spinner disappearance and play icon.
- **UI: stop centre play icon flickering while paused on a buffering source**: Prevents rapid icon toggling.
- **UI: hide cursor over centre play/pause button when controls hide**: Cursor is hidden along with controls.
- **UI: replay when loop toggled on while at ended state**: Toggling loop at the end now immediately replays.
- **Touch: don't flash controls on tap**: Tap no longer briefly shows controls.
- **Poster: render poster on the main decoder, not the thumbnail pipeline**: Fixes poster generation for sources that don't work with the thumbnail decoder.
- **Thumbnail: recreate dead WebCodecs decoder instead of disabling previews**: Thumbnail previews recover automatically instead of being permanently disabled.
- **Extension: detect video links regardless of target=_blank**: Hover-probe now works on all link types.
- **Extension: loop replays in place + single-file drop skips playlist**: Better UX for single-file and loop scenarios.
- **HTTP: surface server errors instead of an infinite buffering spinner**: HTTP errors now show a meaningful error message.
- **Stats: width-aware quality label so 3840x2080 reads as 4K, not 2K**: Quality label uses width-based detection for non-standard aspect ratios.
- **Canvas: fall back to display-p3 when rec2100-pq is rejected**: HDR canvas now gracefully falls back when the browser rejects the PQ colorspace tag.
- **Canvas: preserve rec2100-pq tag through HDR toggle**: HDR toggle no longer strips the colorspace tag.
- **Element: persist muted=false when volume slider auto-unmutes**: Muted state is correctly persisted after using the volume slider.
- **Controls: flush time/progress/volume on show**: Controls no longer show stale values when re-appearing.
- **Controls: suppress play/pause overlay flash during autoplay startup**: Eliminates brief icon flash on autoplay.
- **Controls: suppress spinner flash on poster/first-play/replay seeks**: Spinner no longer briefly appears during seeks.
- **Controls: hide cursor over overlay when controls hide**: Cursor is hidden with controls in all regions.

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
