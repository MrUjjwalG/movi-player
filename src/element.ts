/**
 * Movi Element Module
 *
 * Provides the custom HTML element wrapper for Movi Player.
 * This is the complete bundle including UI controls and gestures.
 *
 * Usage:
 * ```typescript
 * import { MoviElement } from 'movi/element';
 * // or just use <movi-player> in HTML
 * ```
 *
 * HTML Usage:
 * ```html
 * <movi-player src="video.mp4" controls autoplay></movi-player>
 * ```
 */

// Core Types
export type {
  Track,
  TrackType,
  VideoTrack,
  AudioTrack,
  SubtitleTrack,
  SubtitleRenderer,
  SubtitleCue,
  SourceConfig,
  CacheConfig,
  RendererType,
  DecoderType,
  PlayerConfig,
  MediaInfo,
  VideoDecoderConfig,
  AudioDecoderConfig,
  Packet,
  DecodedVideoFrame,
  DecodedAudioFrame,
  PlayerState,
  PlayerEventMap,
} from './types';

// Utilities
export {
  upgradeVideoElements,
  playerFor,
  type UpgradeOptions,
  type UpgradedVideo,
} from './upgrade';
export { Logger, LogLevel } from './utils/Logger';
export { Time, TIME_BASE } from './utils/Time';

// Events
export { EventEmitter } from './events/EventEmitter';

// WASM bindings (singleton pattern)
export { WasmBindings, ThumbnailBindings, type DataSource } from './wasm/bindings';
export { loadWasmModule, loadWasmModuleNew, getWasmModule, isWasmModuleLoaded } from './wasm/FFmpegLoader';
export type { MoviWasmModule, StreamInfo, PacketInfo } from './wasm/types';

// Source adapters
export type { SourceAdapter } from './source/SourceAdapter';
export { HttpSource, createHttpSource } from './source/HttpSource';
export { FileSource, createFileSource } from './source/FileSource';
export { ThumbnailHttpSource, createThumbnailHttpSource } from './source/ThumbnailHttpSource';
export { EncryptedHttpSource } from './source/EncryptedHttpSource';
export type { EncryptedSourceConfig } from './source/EncryptedHttpSource';
export {
  registerSourceAdapter,
  unregisterSourceAdapter,
  getRegisteredSchemes,
} from './source/adapterRegistry';
export type {
  SourceAdapterFactory,
  SourceAdapterFactoryConfig,
} from './source/adapterRegistry';
export { generateFingerprint } from './utils/Fingerprint';

// Cache
export { LRUCache } from './cache/LRUCache';

// Demuxer
export { Demuxer } from './demux/Demuxer';

// Decoders
export { MoviVideoDecoder } from './decode/VideoDecoder';
export { MoviAudioDecoder } from './decode/AudioDecoder';
export { SubtitleDecoder } from './decode/SubtitleDecoder';

// Renderers
export { CanvasRenderer } from './render/CanvasRenderer';
export { AudioRenderer } from './render/AudioRenderer';

// Core components
export { TrackManager } from './core/TrackManager';
export { Clock } from './core/Clock';
export { PlayerStateManager } from './core/PlayerState';
export { PlaybackController } from './core/PlaybackController';

// Player
export { MoviPlayer } from './core/MoviPlayer';

// Main export: MoviElement (custom HTML element)
export { MoviElement } from './render/MoviElement';
// Host-supplied bar buttons / context-menu rows — see MoviElement.addControl.
export type { MoviControlSpec, MoviControlItem } from './render/MoviElement';
// One entry in the queue — see MoviElement.playlist.
export type { MoviPlaylistItem } from './render/MoviElement';
import type { MoviElement as MoviElementType } from './render/MoviElement';

// Package version, baked in at build time. `import { VERSION } from
// "movi-player/element"`, or read MoviElement.version / element.version.
export { VERSION } from './version';

// Which bundle this is — "slim" (separate movi.wasm) or "full" (embedded).
// Separate from VERSION, which is identical across both. Also readable as
// MoviElement.build / element.build.
export { BUILD } from './build-flags';

// QoE analytics — versioned event stream + pluggable sinks.
export {
  QoECollector,
  beaconSink,
  QOE_SCHEMA_VERSION,
} from './utils/QoE';
export type { QoEEvent, QoESink, QoESession } from './utils/QoE';

/**
 * The documented `<movi-player>` attribute surface. Kept as a flat string/
 * boolean map so it can back both the HTMLElementTagNameMap typing and the
 * framework wrappers. Any attribute may also be set as a property on the
 * element instance (see MoviElement).
 */
export interface MoviPlayerAttributes {
  src?: string;
  poster?: string;
  posterfit?: string;
  postertime?: string;
  controls?: boolean | "";
  autoplay?: boolean | "";
  /**
   * Repeat. A bare attribute repeats the ITEM, which is what it has always
   * done; `loop="all"` repeats the QUEUE instead — the next item plays, and
   * the last leads back to the first.
   *
   *   <movi-player loop>            this file, over and over
   *   <movi-player loop="all">      the playlist, round and round
   *   <movi-player loop="all 5">    …with five seconds between items
   *   <movi-player loop="5">        the same — a gap can only mean the queue
   *
   * Aliases for the queue: `playlist`, `queue`, `wrap`. `all` implies that the
   * queue advances at all. The number is the gap between items, which saves
   * reaching for a second attribute to say it; `autoadvance` still wins when
   * it names one of its own.
   */
  loop?: boolean | "" | "all" | "one" | string;
  muted?: boolean | "";
  /** Play inline (don't auto-fullscreen on iOS). On any touch device, touch
   *  gestures (swipe-seek / volume) are suppressed while inline so they don't
   *  fight the page's scroll; fullscreen gestures are unaffected. Replaces
   *  `gesturefs`. */
  playsinline?: boolean | "";
  preload?: "none" | "metadata" | "auto";
  volume?: number | string;
  playbackrate?: number | string;
  theme?: "dark" | "light";
  /** One or two CSS colours, space-separated: primary, then optional
   *  secondary (`"#8B5CF6 #22D3EE"`). */
  themecolor?: string;
  title?: string;
  headers?: string;
  crossorigin?: "anonymous" | "use-credentials";
  vr?: string;
  vrpad?: boolean | "";
  audioonly?: boolean | "";
  audiooutput?: string;
  stablevolume?: boolean | "";
  ambientmode?: boolean | "";
  resume?: boolean | "";
  drm?: string;
  licenseurl?: string;
  /** Extra HTTP headers for the DRM license request only (JSON object string). */
  licenseheaders?: string;
  encrypted?: boolean | "";
  lcevc?: boolean | "";
  lcevcurl?: string;
  /** Token endpoint URL for encrypted playback. */
  tokenurl?: string;
  /** Video endpoint URL for encrypted playback. */
  videourl?: string;
  /** Video identifier sent to the token server. */
  videoid?: string;

  /** Element width in pixels (CSS sizing is preferred). */
  width?: number | string;
  /** Element height in pixels (CSS sizing is preferred). */
  height?: number | string;
  /** How the video fills the canvas. */
  objectfit?: "contain" | "cover" | "fill" | "zoom" | "control";
  /** Rotate the video, in degrees (snaps to a quarter-turn). */
  rotate?: 0 | 90 | 180 | 270;
  /** Rendering backend. */
  renderer?: "canvas";
  /** Show the title-bar overlay at the top of the player. */
  showtitle?: boolean | "";
  /** Where the title bar may show, plus an optional back arrow. Tokens:
   *  `both` (default) / `fullscreen` / `windowed`, and `back` — scoped with
   *  `back-mobile`, `back-fullscreen` or `back-mobile-fullscreen`. */
  titlemode?: string;
  /** Offer "Add subtitle file…" in the subtitle menu (SRT/VTT/TTML, read
   *  locally — the file never leaves the page). */
  subtitlepicker?: boolean | "";
  /** Chapters from outside the media file, as a JSON array of
   *  `{ title, start, end?, image? }` (seconds). `image` is a URL the timeline
   *  tile shows instead of decoding a frame at `start`. Use the `chapters`
   *  property to pass the array directly. */
  chapters?: string;
  /**
   * A queue, as a JSON array of `{ src?, id?, title?, poster?, startAt? }` — or
   * of bare source strings — or a URL to fetch that array from. Setting one
   * loads its first item, unless `src` already names one of them. Use the
   * `playlist` property to pass the array directly.
   *
   * Items may leave `src` off, for a queue the HOST loads: the element still
   * owns the buttons, the keys and the lock-screen skip pair, and announces
   * every move as a cancelable `itemchange`. That is the shape to use when a
   * source is more than a URL — a `<source>` quality ladder, per-language
   * audio, `<track>` subtitles — or when each item is its own route.
   */
  playlist?: string;
  /** Which item to open on. Default 0. */
  playlistindex?: number | string;
  /**
   * Let the end of one item start the next. Off by default. A number is the
   * gap in seconds (`autoadvance="5"`), `loop` joins the ends of the queue
   * (`autoadvance="loop"`, or `"5 loop"` for both) — though `loop="all"` on
   * the element says the same thing more plainly, and is where to reach for
   * it. A BARE `loop` on the element is a different thing and wins: it repeats
   * the item, so nothing ever ends and the queue never moves.
   */
  autoadvance?: boolean | "" | number | string;
  /**
   * Play the queue in a random order. Off by default.
   *
   * Its own attribute rather than a `loop` token, because it is its own
   * question: a queue can be shuffled and played through once, and it can be
   * looped in the order it was given. They compose — `shuffle loop="all"` is
   * the pair most people mean — but neither implies the other.
   *
   * The ORDER is shuffled, not the queue: `playlist` and `playlistIndex` still
   * describe the list the host handed over, so a page's own rows keep matching,
   * and turning it off puts the order back without reloading anything. The item
   * playing keeps its place, so switching shuffle on never restarts it. The
   * draw stands until the queue is replaced, shuffle is switched off and on,
   * or `reshuffle()` is called.
   */
  shuffle?: boolean | "";

  /** Enable ±10s fast-seek. Bare = every affordance; a token list narrows it to
   *  `buttons` (the bottom-bar pair), `keys` (arrow keys) and/or `gestures`
   *  (double-tap and drag-to-seek) — e.g. `fastseek="keys gestures"`. Aliases:
   *  `touch`, `nontouch`, `keyonly`, `controls`, `none`. */
  fastseek?: boolean | "" | string;
  /** Enable the double-tap-to-seek gesture. */
  doubletap?: boolean | "";
  /** Disable all keyboard shortcuts. */
  nohotkeys?: boolean | "";
  /** Start playback at this time, in seconds. */
  startat?: number | string;
  /** Target prefetch window, in megabytes. */
  buffersize?: number | string;
  /**
   * How long an interruption must last, in seconds, before the viewer is shown
   * a loading spinner. `0` (default) shows it at once. Applies to every reason
   * the spinner goes up — the opening load, seeking, buffering, a rendition
   * switch, judder — so a brief stall passes in silence.
   */
  spinnerdelay?: number | string;
  /** Override the video frame rate (0 = use the source's own). */
  fps?: number | string;
  /** Force software decoding (FFmpeg WASM) instead of WebCodecs. `auto` (default) picks per source. */
  sw?: boolean | "auto";
  /** Enable HDR tone-mapping (Chromium + canvas renderer + HDR source). */
  hdr?: boolean | "";
  /**
   * Generate on-demand thumbnails for seek-bar previews. `thumb="precise"`
   * decodes forward from the keyframe to the frame under the pointer, rather
   * than showing the keyframe before it — exact, at the cost of a run of
   * frames per preview.
   */
  thumb?: boolean | "precise" | "";
  /**
   * Enter Picture-in-Picture automatically when the tab is hidden, as the
   * attribute does on `<video>`. Only meaningful while the native element is
   * carrying playback — a canvas has no auto-PiP of its own.
   */
  autopictureinpicture?: boolean | "";

  /** Subtitle timing offset, in seconds (positive = later, VLC/mpv sign). */
  subtitledelay?: number | string;
  /** Subtitle font size — a multiplier, or a percentage above 5. */
  subtitlesize?: number | string;
  /** Subtitle text colour as a hex string (`#fff` / `#ffffff`). */
  subtitlecolor?: string;
  /** Subtitle background opacity — 0–1, or a percentage above 1. */
  subtitlebg?: number | string;
  /** Subtitle edge style. */
  subtitleedge?: "none" | "shadow" | "outline" | "raised";

  /** CSS selector for an external element to receive the ambient glow. */
  ambientwrapper?: string;
  /** Crop the black bars that are part of the picture, so `cover` / `fill` /
   *  `zoom` size the image rather than its padding. */
  /** How far the demuxer may read before naming the streams: bytes, or
   *  "512kb" / "2mb". Omit for the built-in budget — see the docs, it is
   *  generous on purpose. */
  probesize?: string | number;
  /** How much media it may analyse first, in milliseconds. Companion to
   *  `probesize`. */
  probeduration?: string | number;
  cropbars?: boolean | "";
  /** Let `autoplay` start while the tab is hidden. Off by default: a first play
   *  in a background tab runs into a throttled rAF and can park in buffering. */
  backgroundplay?: boolean | "";
  /** Stall sound and picture together. ON by default, so this is an opt-OUT and
   *  the value carries it: `bindav="false"` (or off/0/no) unbinds them. */
  bindav?: boolean | "false" | "";
  /** What to do with a source Movi can't play (`native` → hand to `<video>`). */
  fallback?: "native";
  /**
   * Playback-engine priority, space-separated. The first name leads; any others
   * replace the built-in escalation. `wasm` (Movi's demuxer + WebCodecs — for a
   * manifest, its own DASH/HLS handling), `shaka`, `dashjs`, `hlsjs`, `native`.
   */
  engine?: string;
  /** @deprecated Replaced by {@link playsinline}. */
  gesturefs?: boolean | "";
  /** URL of the external `movi.wasm` (slim build only; defaults to next to the JS bundle). */
  wasmurl?: string;
  /** Which settings to remember across loads — see the `persist` attribute. */
  persist?: string;
  /** Namespace for everything `persist` stores. */
  persistkey?: string;
  /** Built-in controls to switch off, as `no<name>` tokens. */
  controlslist?: string;
  /** Refuse Picture-in-Picture, as `<video disablepictureinpicture>` does. */
  disablepictureinpicture?: boolean;
  /** Turn off remote playback targets, as `<video disableremoteplayback>` does. */
  disableremoteplayback?: boolean;
}

/**
 * A `<source>` child of `<movi-player>`. Movi reads several non-standard
 * attributes (`data-height`, `data-fps`, `data-badge`, `srclang`, `kind="audio"`)
 * that a native `<source>` type rejects — this describes the wrapper components'
 * friendly prop names, each mapping to the attribute the element parses.
 */
export interface MoviSourceProps {
  /** URL of the video or audio file. */
  src: string;
  /** MIME type — `canPlayType` uses it to pick the first playable source. */
  type?: string;
  /** Mark this as an audio-only track (split source / multi-language). */
  kind?: "audio";
  /** BCP-47 language code — required for the language menu. → `srclang` */
  srcLang?: string;
  /** Human-readable label shown in the menu. */
  label?: string;
  /** Resolution height in pixels — populates the quality picker. → `data-height` */
  height?: number;
  /** Frame-rate hint shown in the quality picker. → `data-fps` */
  fps?: number;
  /** Free-form chip (e.g. `"HDR"`) shown next to the label. → `data-badge` */
  badge?: string;
  /** Bitrate hint in bits/sec for ABR. → `data-bandwidth` */
  bandwidth?: number;
  /**
   * Codec of THIS rung — a WebCodecs string ("av01.0.13M.10") or just the
   * family ("av01" / "avc1" / "vp9"). → `data-codec`
   *
   * Lets the player ask the device whether it can actually decode a rung
   * before climbing into it. Without it, a mixed-codec ladder (H.264 low,
   * AV1 high — what YouTube-style extractors produce) has to be judged by the
   * codec currently playing, which answers the wrong question.
   */
  codec?: string;
  /** Make this the initial pick. → `data-default` */
  default?: boolean;
}

/**
 * A `<track>` child of `<movi-player>` (subtitles / captions). `format` maps to
 * the non-standard `data-format` the element reads.
 */
export interface MoviTrackProps {
  /** URL of the subtitle file. */
  src: string;
  /** `subtitles` or `captions` (omit to default). */
  kind?: "subtitles" | "captions";
  /** BCP-47 language code. → `srclang` */
  srcLang?: string;
  /** Human-readable label shown in the menu. */
  label?: string;
  /** Subtitle format. → `data-format` */
  format?: "vtt" | "srt";
  /** Make this the initial pick. → `data-default` */
  default?: boolean;
}

declare global {
  interface HTMLElementTagNameMap {
    // `document.querySelector('movi-player')` is now typed as the element.
    "movi-player": MoviElementType;
  }
}
