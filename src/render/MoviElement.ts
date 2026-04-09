/**
 * Custom HTML element for Movi Player
 * Usage: <movi-player src="video.mp4" autoplay muted></movi-player>
 *
 * Note: Custom element names must contain a hyphen per HTML spec.
 *
 * Supports native video element properties:
 * - src, autoplay, controls, loop, muted, playsinline, preload, poster
 * - width, height, crossorigin
 * - volume, playbackRate, currentTime, duration, paused, ended
 */

import { MoviPlayer } from "../core/MoviPlayer";
import type {
  SourceConfig,
  RendererType,
  VideoTrack,
  DecoderType,
  PlayerState,
} from "../types";
import { Logger, LogLevel } from "../utils/Logger";

import { SettingsStorage } from "../utils/SettingsStorage";

const TAG = "MoviElement";

// OSD icon constants — shared across keyboard, button, and context menu handlers
const OSD = {
  loop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
  stableAudio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 15v-2M9 15v-4M12 15v-6M15 15v-4M18 15v-2"/></svg>`,
  hdr: `<span style="font-weight:700;font-size:14px;letter-spacing:1px;padding:4px 10px;border:2px solid currentColor;border-radius:6px;">HDR</span>`,
  speed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/><line x1="19" y1="3" x2="19" y2="21"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  subOn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4M13 15h4"/></svg>`,
  subOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4M13 15h4"/><line x1="3" y1="5" x2="21" y2="19" stroke-width="2.5"/></svg>`,
  snapshot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`,
  rotate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
  muted: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
  unmuted: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
  ambient: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
} as const;

export class MoviElement extends HTMLElement {
  private canvas: HTMLCanvasElement;
  private video: HTMLVideoElement;
  private subtitleOverlay: HTMLElement;
  private player: MoviPlayer | null = null;
  private isLoading: boolean = false;
  private _isUnsupported: boolean = false;
  private eventHandlers: Map<string, () => void> = new Map();
  private controlsContainer: HTMLElement | null = null;
  private brokenIndicator: HTMLElement | null = null;
  private emptyStateIndicator: HTMLElement | null = null;
  private controlsTimeout: number | null = null;
  private isOverControls: boolean = false;
  private isSeeking: boolean = false;
  private isDragging: boolean = false;
  private isTouchDragging: boolean = false;

  // Gesture tracking
  private touchStartX: number = 0;
  private touchStartY: number = 0;
  private touchStartTime: number = 0;
  private gesturePerformed: boolean = false; // Track if a gesture was performed
  private clickTimer: number | null = null; // Timer to delay single click for double click detection
  private lastSeekTime: number = 0; // Track last seek time to prevent accidental pauses
  private lastSeekSide: "left" | "right" | null = null;
  private cumulativeSeekAmount: number = 0;
  private _contextMenuVisible: boolean = false;
  private _contextMenuJustClosed: boolean = false;
  private lastTouchTime: number = 0;

  // Nerd Stats
  private _nerdStatsVisible: boolean = false;
  private _currentManualRotation: number = 0; // Track for thumbnail margin re-apply
  private nerdStatsInterval: number | null = null;
  private networkSpeedHistory: number[] = []; // speed samples for graph
  private static readonly GRAPH_MAX_SAMPLES = 60; // 30 seconds of data (500ms interval)

  // Internal state
  private _src: string | File | null = null;
  private _audioSrc: string | null = null; // Separate audio source URL
  private _audioTracks: { src: string; type?: string; lang: string; label: string }[] = []; // Multi-language audio
  private _subtitleTracks: { src: string; lang: string; label: string; format?: string }[] = []; // External subtitles
  private _autoplay: boolean = false;
  private _controls: boolean = false;
  private _loop: boolean = false;
  private _muted: boolean = false;
  private _playsinline: boolean = false;
  private _preload: "none" | "metadata" | "auto" = "auto";
  private _poster: string = "";
  private _volume: number = 1.0;
  private _playbackRate: number = 1.0;
  private _ambientMode: boolean = false;
  private _renderer: RendererType = "canvas";
  private _objectFit: "contain" | "cover" | "fill" | "zoom" | "control" =
    "contain"; // Configuration mode
  private _currentFit: "contain" | "cover" | "fill" | "zoom" = "contain"; // Actual fit being applied
  private _thumb: boolean = false;
  private _hdr: boolean = true; // HDR enabled by default
  private _theme: "dark" | "light" = "dark"; // Default theme
  private _sw: DecoderType = "auto"; // Preferred decoder mode (auto or software)

  private _fps: number = 0; // Custom frame rate (0 = auto from video)
  private _gesturefs: boolean = false; // Gestures only in fullscreen if true
  private _noHotkeys: boolean = false; // Disable keyboard shortcuts if true
  private _startAt: number = 0; // Start time in seconds
  private _fastSeek: boolean = false; // Enable skip controls (buttons, keys, gestures) if true
  private _doubleTap: boolean = true; // Enable/disable double tap to seek
  private _themeColor: string | null = null; // Custom theme color
  private _bufferSize: number = 0; // Custom buffer size in seconds
  private _watermark: string | null = null; // Watermark image URL
  private _title: string | null = null; // Video title to display
  private _showTitle: boolean = false; // Show title at top if true
  private _resume: boolean = false; // Resume playback from last position (opt-in)
  private _stableVolume: boolean = false; // Stable volume / loudness normalization (opt-in)
  private _encrypted: boolean = false;   // Encrypted source mode
  private _tokenUrl: string = "";        // Token endpoint for encrypted playback
  private _videoUrl: string = "";        // Video endpoint for encrypted playback
  private _videoId: string = "";         // Video ID for encrypted playback
  private _resumeSaveInterval: number | null = null; // Interval to save position
  private _titleAutoLoaded: boolean = false; // Track if title was auto-loaded from metadata
  private _lastDuration: number = 0; // Track duration changes for title auto-load
  private posterElement!: HTMLImageElement; // Poster image element

  // Ambient mode state
  private _ambientWrapper: string | null = null; // ID of external wrapper element
  private ambientWrapperElement: HTMLElement | null = null; // Reference to external wrapper element
  private _ambientRafId: number | null = null;
  private _lastAmbientSampleTime: number = 0;
  private _ambientSampleInterval: number = 100; // Start at 100ms (10fps) for better performance
  private _ambientSampleCanvas: HTMLCanvasElement | null = null;
  private _ambientSampleCtx: CanvasRenderingContext2D | null = null;
  private currentAmbientColors: { r: number; g: number; b: number } = {
    r: 0,
    g: 0,
    b: 0,
  };

  // Context handling state
  private _contextLostTime: number = 0;
  private _contextLostPlaying: boolean = false;

  // Observed attributes (native video element attributes)
  static get observedAttributes() {
    return [
      "src",
      "autoplay",
      "controls",
      "loop",
      "muted",
      "playsinline",
      "preload",
      "poster",
      "width",
      "height",
      "crossorigin",
      "volume",
      "playbackrate",
      "ambientmode",
      "ambientwrapper",
      "renderer",
      "objectfit",
      "thumb",
      "hdr",
      "theme",
      "sw",
      "fps",
      "gesturefs",
      "nohotkeys",
      "startat",
      "fastseek",
      "doubletap",
      "themecolor",
      "buffersize",
      "watermark",
      "title",
      "showtitle",
      "resume",
      "stablevolume",
      "encrypted",
      "tokenurl",
      "videourl",
      "videoid",
      "drm",
      "licenseurl",
    ];
  }

  constructor() {
    super();

    // Enable keyboard focus
    this.tabIndex = 0;

    // Set log level to INFO by default (change to DEBUG for troubleshooting)
    Logger.setLevel(LogLevel.DEBUG);

    // Create shadow DOM for encapsulation
    const shadowRoot = this.attachShadow({ mode: "open" });

    // Create canvas element
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    // Prevent default context menu on canvas
    this.canvas.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    // Add canvas to shadow DOM
    shadowRoot.appendChild(this.canvas);

    // Create video element (hidden by default)
    this.video = document.createElement("video");
    this.video.style.width = "100%";
    this.video.style.height = "100%";
    this.video.style.display = "none"; // Default to canvas mode
    this.video.style.objectFit = "contain";
    // Prevent default context menu on video
    this.video.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    // Add video to shadow DOM
    shadowRoot.appendChild(this.video);

    // Create poster image element (overlay on video/canvas)
    this.posterElement = document.createElement("img");
    this.posterElement.className = "movi-poster-overlay";
    this.posterElement.style.position = "absolute";
    this.posterElement.style.top = "0";
    this.posterElement.style.left = "0";
    this.posterElement.style.width = "100%";
    this.posterElement.style.height = "100%";
    this.posterElement.style.objectFit = "contain";
    this.posterElement.style.display = "none";
    this.posterElement.style.zIndex = "1";
    shadowRoot.appendChild(this.posterElement);

    // Create subtitle overlay element
    this.subtitleOverlay = document.createElement("div");
    this.subtitleOverlay.className = "movi-subtitle-overlay";
    shadowRoot.appendChild(this.subtitleOverlay);

    // Create loading indicator (positioned over video area)
    const loadingIndicator = document.createElement("div");
    loadingIndicator.className = "movi-loading-indicator";
    loadingIndicator.style.display = "none";
    loadingIndicator.innerHTML = `
      <div class="movi-loader-container"></div>
    `;
    shadowRoot.appendChild(loadingIndicator);

    // Create centered play/pause button
    const centerPlayPause = document.createElement("button");
    centerPlayPause.className = "movi-center-play-pause";
    centerPlayPause.setAttribute("aria-label", "Play/Pause");
    centerPlayPause.innerHTML = `
      <svg class="movi-center-icon-play" viewBox="0 0 24 24" fill="currentColor">
        <path d="M5 4v16l14-8z"></path>
      </svg>
      <svg class="movi-center-icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>
      </svg>
    `;
    shadowRoot.appendChild(centerPlayPause);

    // Create broken indicator
    this.brokenIndicator = document.createElement("div");
    this.brokenIndicator.className = "movi-broken-indicator";
    this.brokenIndicator.style.display = "none";
    this.brokenIndicator.innerHTML = `
      <div class="movi-broken-container">
        <div class="movi-broken-icon-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.75 3H13.25C17.5 3 21 6.5 21 10.75V13.25C21 17.5 17.5 21 13.25 21H10.75C6.5 21 3 17.5 3 13.25V10.75C3 6.5 6.5 3 10.75 3Z" fill="rgba(255, 68, 68, 0.05)"/>
            <path d="M12 8V12" stroke="#ff4444"/>
            <path d="M12 16H12.01" stroke="#ff4444"/>
            <path d="M3 3L21 21" stroke="white" stroke-opacity="0.2"/>
          </svg>
        </div>
        <div class="movi-broken-text">
          <h3 class="movi-broken-title">Format Unsupported</h3>
          <p class="movi-broken-message">This video codec is not supported by your browser's hardware acceleration.</p>
          <button class="movi-sw-fallback-btn" style="display: none;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 16h5v5"/>
            </svg>
            Try Software Decoding
          </button>
        </div>
      </div>
    `;
    shadowRoot.appendChild(this.brokenIndicator);

    // Setup software fallback button handler
    const swFallbackBtn = this.brokenIndicator.querySelector(
      ".movi-sw-fallback-btn",
    );
    swFallbackBtn?.addEventListener("click", () => {
      this.enableSoftwareDecoding();
    });

    // Create empty state indicator (shown when no src is set)
    this.emptyStateIndicator = document.createElement("div");
    this.emptyStateIndicator.className = "movi-empty-state";
    this.emptyStateIndicator.style.display = "flex"; // Show by default (no src initially)
    this.emptyStateIndicator.innerHTML = `
      <div class="movi-empty-container">
        <div class="movi-empty-icon-wrapper">
          <svg viewBox="0 0 48 48" fill="none">
            <rect x="8" y="12" width="32" height="24" rx="2" stroke="rgba(255, 255, 255, 0.3)" stroke-width="1.5" fill="rgba(255, 255, 255, 0.02)"/>
            <rect x="6" y="14" width="2" height="4" rx="0.5" fill="rgba(255, 255, 255, 0.2)"/>
            <rect x="6" y="22" width="2" height="4" rx="0.5" fill="rgba(255, 255, 255, 0.2)"/>
            <rect x="6" y="30" width="2" height="4" rx="0.5" fill="rgba(255, 255, 255, 0.2)"/>
            <rect x="40" y="14" width="2" height="4" rx="0.5" fill="rgba(255, 255, 255, 0.2)"/>
            <rect x="40" y="22" width="2" height="4" rx="0.5" fill="rgba(255, 255, 255, 0.2)"/>
            <rect x="40" y="30" width="2" height="4" rx="0.5" fill="rgba(255, 255, 255, 0.2)"/>
            <circle cx="24" cy="24" r="5" fill="rgba(255, 255, 255, 0.06)" stroke="rgba(255, 255, 255, 0.2)" stroke-width="1"/>
            <path d="M22 21l6 3-6 3z" fill="rgba(255, 255, 255, 0.3)"/>
          </svg>
        </div>
        <div class="movi-empty-text">
          <h3 class="movi-empty-title">No Video</h3>
          <p class="movi-empty-message">Add a video source to start playback</p>
        </div>
      </div>
    `;
    shadowRoot.appendChild(this.emptyStateIndicator);

    // Create OSD (On-Screen Display) container
    const osdContainer = document.createElement("div");
    osdContainer.className = "movi-osd-container";
    osdContainer.style.display = "none";
    osdContainer.innerHTML = `
      <div class="movi-osd-icon"></div>
      <div class="movi-osd-text"></div>
    `;
    shadowRoot.appendChild(osdContainer);

    // Create context menu FIRST (before setupContextMenu is called)
    this.createContextMenu(shadowRoot);

    // Create controls UI (this will call setupContextMenu)
    this.createControls(shadowRoot);

    // Set default styles
    this.addStyles(shadowRoot);
  }

  private createContextMenu(shadowRoot: ShadowRoot): void {
    Logger.debug(TAG, "[ContextMenu] Creating context menu element");
    const contextMenu = document.createElement("div");
    contextMenu.className = "movi-context-menu";
    contextMenu.style.display = "none";

    // Add backdrop for mobile side panel
    const backdrop = document.createElement("div");
    backdrop.className = "movi-context-menu-backdrop";
    backdrop.style.display = "none";
    shadowRoot.appendChild(backdrop);
    contextMenu.innerHTML = `
      <div class="movi-context-menu-item" data-action="play-pause">
        <svg class="movi-context-menu-icon movi-context-menu-play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <svg class="movi-context-menu-icon movi-context-menu-pause-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
        <span class="movi-context-menu-label">Play</span>
        <span class="movi-context-menu-shortcut">Space</span>
      </div>
      <div class="movi-context-menu-item" data-action="speed">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5.64 18.36a9 9 0 1 1 12.72 0"></path>
          <path d="m12 12 4-4"></path>
        </svg>
        <span class="movi-context-menu-label">Playback Speed</span>
        <span class="movi-context-menu-arrow">▶</span>
      </div>
      <div class="movi-context-menu-submenu" data-submenu="speed">
        <div class="movi-context-menu-item movi-context-menu-back" data-action="back">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          <span class="movi-context-menu-label">Back</span>
        </div>
        <div class="movi-context-menu-item" data-speed="0.25">0.25x</div>
        <div class="movi-context-menu-item" data-speed="0.5">0.5x</div>
        <div class="movi-context-menu-item" data-speed="0.75">0.75x</div>
        <div class="movi-context-menu-item movi-context-menu-active" data-speed="1">Normal</div>
        <div class="movi-context-menu-item" data-speed="1.25">1.25x</div>
        <div class="movi-context-menu-item" data-speed="1.5">1.5x</div>
        <div class="movi-context-menu-item" data-speed="1.75">1.75x</div>
        <div class="movi-context-menu-item" data-speed="2">2x</div>
      </div>
      <div class="movi-context-menu-item" data-action="fit">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="8" width="12" height="8" rx="1"/>
        </svg>
        <span class="movi-context-menu-label">Aspect Ratio</span>
        <span class="movi-context-menu-arrow">▶</span>
      </div>
      <div class="movi-context-menu-submenu" data-submenu="fit">
        <div class="movi-context-menu-item movi-context-menu-back" data-action="back">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          <span class="movi-context-menu-label">Back</span>
        </div>
        <div class="movi-context-menu-item" data-fit="contain">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="8" width="12" height="8" rx="1"/></svg>
          <span class="movi-context-menu-label">Contain</span>
        </div>
        <div class="movi-context-menu-item" data-fit="cover">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="1" y="7" width="22" height="10" rx="1"/></svg>
          <span class="movi-context-menu-label">Cover</span>
        </div>
        <div class="movi-context-menu-item" data-fit="fill">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 3h18v18H3z"/></svg>
          <span class="movi-context-menu-label">Stretch</span>
        </div>
        <div class="movi-context-menu-item" data-fit="zoom">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
          <span class="movi-context-menu-label">Zoom</span>
        </div>
      </div>
      <div class="movi-context-menu-divider movi-context-menu-divider-audio" style="display: none;"></div>
      <div class="movi-context-menu-item movi-context-menu-item-audio" data-action="audio-track" style="display: none;">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <span class="movi-context-menu-label">Audio Track</span>
        <span class="movi-context-menu-arrow">▶</span>
      </div>
      <div class="movi-context-menu-submenu movi-context-menu-submenu-audio" data-submenu="audio-track" style="display: none;"></div>
      <div class="movi-context-menu-divider movi-context-menu-divider-subtitle" style="display: none;"></div>
      <div class="movi-context-menu-item movi-context-menu-item-subtitle" data-action="subtitle-track" style="display: none;">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="14" x="3" y="5" rx="2" ry="2"></rect>
          <path d="M11 9H9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2 M17 9h-2a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2"></path>
        </svg>
        <svg class="movi-context-menu-icon movi-context-menu-subtitle-filled" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
           <path fill-rule="evenodd" clip-rule="evenodd" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2z M11 11 H9.5 V10.5 H7.5 V13.5 H9.5 V13 H11 V14 C11 14.55 10.55 15 10 15 H7 C6.45 15 6 14.55 6 14 V10 C6 9.45 6.45 9 7 9 H10 C10.55 9 11 9.45 11 10 V11 Z M18 11 H16.5 V10.5 H14.5 V13.5 H16.5 V13 H18 V14 C18 14.55 17.55 15 17 15 H14 C13.45 15 13 14.55 13 14 V10 C13 9.45 13.45 9 14 9 H17 C17.55 9 18 9.45 18 10 V11 Z"></path>
        </svg>
        <span class="movi-context-menu-label">Subtitle Track</span>
        <span class="movi-context-menu-arrow">▶</span>
      </div>
      <div class="movi-context-menu-submenu movi-context-menu-submenu-subtitle" data-submenu="subtitle-track" style="display: none;"></div>
      <div class="movi-context-menu-item" data-action="hdr-toggle" style="display: none;">
        <span class="movi-context-menu-icon" style="font-weight:700;font-size:10px;letter-spacing:0.5px;width:16px;text-align:center;overflow:visible;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;">HDR</span>
        <span class="movi-context-menu-label">HDR Mode</span>
        <span class="movi-context-menu-status movi-hdr-status">On</span>
        <span class="movi-context-menu-shortcut">H</span>
      </div>
      <div class="movi-context-menu-divider movi-hdr-divider" style="display: none;"></div>
      <div class="movi-context-menu-item movi-context-menu-pip" data-action="pip" style="display: none;">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="9" width="8" height="6" rx="1"/>
        </svg>
        <span class="movi-context-menu-label">Picture in Picture</span>
        <span class="movi-context-menu-shortcut">P</span>
      </div>
      <div class="movi-context-menu-item" data-action="fullscreen">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
        </svg>
        <span class="movi-context-menu-label">Fullscreen</span>
        <span class="movi-context-menu-shortcut">F</span>
      </div>
      <div class="movi-context-menu-item" data-action="rotate-video">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
          <path d="M21 3v5h-5"></path>
        </svg>
        <span class="movi-context-menu-label">Rotate Video</span>
        <span class="movi-context-menu-status movi-rotate-status">0°</span>
        <span class="movi-context-menu-shortcut">R</span>
      </div>
      <div class="movi-context-menu-item" data-action="loop-toggle">
        <svg class="movi-context-menu-icon movi-context-menu-loop-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M17 2l4 4-4 4"></path>
           <path d="M3 11v-1a4 4 0 0 1 4-4h14"></path>
           <path d="M7 22l-4-4 4-4"></path>
           <path d="M21 13v1a4 4 0 0 1-4 4H3"></path>
        </svg>
        <svg class="movi-context-menu-icon movi-context-menu-loop-filled" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
          <path d="M17 2l4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="M7 22l-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path>
        </svg>
        <span class="movi-context-menu-label">Loop</span>
        <span class="movi-context-menu-status movi-loop-status">Off</span>
        <span class="movi-context-menu-shortcut">L</span>
      </div>
      <div class="movi-context-menu-item" data-action="stable-audio-toggle">
        <svg class="movi-context-menu-icon movi-context-menu-stable-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2"></rect>
          <path d="M6 15v-2"></path>
          <path d="M9 15v-4"></path>
          <path d="M12 15v-6"></path>
          <path d="M15 15v-4"></path>
          <path d="M18 15v-2"></path>
        </svg>
        <svg class="movi-context-menu-icon movi-context-menu-stable-filled" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
          <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm1 9v2h2v-2H5zm3-2v4h2v-4H8zm3-2v6h2V9h-2zm3 2v4h2v-4h-2zm3 2v2h2v-2h-2z"></path>
        </svg>
        <span class="movi-context-menu-label">Stable Volume</span>
        <span class="movi-context-menu-status movi-stable-audio-status">Off</span>
        <span class="movi-context-menu-shortcut">U</span>
      </div>
      <div class="movi-context-menu-item" data-action="ambient-toggle">
        <svg class="movi-context-menu-icon movi-context-menu-ambient-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"></circle>
          <path d="M12 1v2"></path><path d="M12 21v2"></path>
          <path d="M4.22 4.22l1.42 1.42"></path><path d="M18.36 18.36l1.42 1.42"></path>
          <path d="M1 12h2"></path><path d="M21 12h2"></path>
          <path d="M4.22 19.78l1.42-1.42"></path><path d="M18.36 5.64l1.42-1.42"></path>
        </svg>
        <svg class="movi-context-menu-icon movi-context-menu-ambient-filled" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
          <circle cx="12" cy="12" r="5"></circle>
          <path d="M12 1v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M12 21v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M4.22 4.22l1.42 1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M18.36 18.36l1.42 1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M1 12h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M21 12h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M4.22 19.78l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
          <path d="M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
        </svg>
        <span class="movi-context-menu-label">Ambient Mode</span>
        <span class="movi-context-menu-status movi-ambient-status">Off</span>
        <span class="movi-context-menu-shortcut">G</span>
      </div>
      <div class="movi-context-menu-divider"></div>
      <div class="movi-context-menu-item" data-action="snapshot">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
        <span class="movi-context-menu-label">Snapshot</span>
        <span class="movi-context-menu-shortcut">S</span>
      </div>
      <div class="movi-context-menu-item" data-action="timeline">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="6" height="5" rx="1"></rect>
          <rect x="9" y="3" width="6" height="5" rx="1"></rect>
          <rect x="16" y="3" width="6" height="5" rx="1"></rect>
          <rect x="2" y="10" width="6" height="5" rx="1"></rect>
          <rect x="9" y="10" width="6" height="5" rx="1"></rect>
          <rect x="16" y="10" width="6" height="5" rx="1"></rect>
          <line x1="2" y1="19" x2="22" y2="19"></line>
          <line x1="2" y1="21" x2="22" y2="21"></line>
        </svg>
        <span class="movi-context-menu-label">Timeline</span>
        <span class="movi-context-menu-shortcut">T</span>
      </div>
      <div class="movi-context-menu-item" data-action="nerd-stats">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20V10"></path>
          <path d="M18 20V4"></path>
          <path d="M6 20v-4"></path>
        </svg>
        <span class="movi-context-menu-label">Stats for nerds</span>
        <span class="movi-context-menu-shortcut">I</span>
      </div>
    `;
    shadowRoot.appendChild(contextMenu);
    Logger.debug(
      TAG,
      "[ContextMenu] Context menu element appended to shadow root",
      {
        element: contextMenu,
        className: contextMenu.className,
        display: contextMenu.style.display,
      },
    );
  }

  private createControls(shadowRoot: ShadowRoot): void {
    const container = document.createElement("div");
    container.className = "movi-controls-container";
    container.innerHTML = `
      <div class="movi-controls-overlay"></div>
      <div class="movi-controls-bar" style="position: relative;">
        <div class="movi-progress-container">
          <div class="movi-progress-bar">
            <div class="movi-progress-buffer"></div>
            <div class="movi-progress-filled"></div>
            <div class="movi-chapter-markers"></div>
            <div class="movi-progress-handle"></div>
          </div>
          <div class="movi-seek-thumbnail" style="display: none;">
             <div class="movi-thumbnail-placeholder" style="display: none;"></div>
             <img class="movi-thumbnail-img" style="display: none;">
             <span class="movi-seek-chapter-title"></span>
             <span class="movi-seek-time">0:00</span>
          </div>
        </div>
        
        <div class="movi-buttons-row">
          <div class="movi-controls-left">
            <button class="movi-btn movi-play-pause" aria-label="Play/Pause">
              <svg class="movi-icon-play" viewBox="0 0 24 24" fill="currentColor">
                <path d="M5 4v16l14-8z"></path>
              </svg>
              <svg class="movi-icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>
              </svg>
            </button>

            <button class="movi-btn movi-seek-backward" aria-label="Skip Backward 10s">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
              </svg>
            </button>

            <button class="movi-btn movi-seek-forward" aria-label="Skip Forward 10s">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
              </svg>
            </button>

            <div class="movi-volume-container">
              <button class="movi-btn movi-volume-btn" aria-label="Mute/Unmute">
                <svg class="movi-icon-volume-high" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
                <svg class="movi-icon-volume-low" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                  <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
                <svg class="movi-icon-volume-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                  <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
                  <line x1="23" y1="9" x2="17" y2="15"></line>
                  <line x1="17" y1="9" x2="23" y2="15"></line>
                </svg>
              </button>
              <div class="movi-volume-slider-container">
                <input type="range" class="movi-volume-slider" min="0" max="1" step="0.01" value="1" aria-label="Volume">
              </div>
            </div>

            <div class="movi-time">
              <span class="movi-current-time">0:00</span>
              <span class="movi-time-separator"> / </span>
              <span class="movi-duration">0:00</span>
            </div>
          </div>

          <div class="movi-controls-right">
            <div class="movi-mobile-expandable">
              <div class="movi-audio-track-container">
                <button class="movi-btn movi-audio-track-btn" aria-label="Audio Track">
                  <svg class="movi-icon-audio-track" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                  </svg>
                </button>
                <div class="movi-audio-track-menu" style="display: none;">
                  <div class="movi-audio-track-list"></div>
                </div>
              </div>
              <div class="movi-subtitle-track-container">
                <button class="movi-btn movi-subtitle-track-btn" aria-label="Subtitles/Captions">
                  <svg class="movi-icon-subtitle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="20" height="16" x="2" y="4" rx="2" ry="2"></rect>
                    <path d="M10 8.5H8a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2 M18 8.5h-2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2"></path>
                  </svg>
                  <svg class="movi-icon-subtitle-filled" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
                    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM10 15H7c-.83 0-1.5-.67-1.5-1.5v-3c0-.83.67-1.5 1.5-1.5h3V11H7.5v2.5h2V13H10v2zm8 0h-3c-.83 0-1.5-.67-1.5-1.5v-3c0-.83.67-1.5 1.5-1.5h3V11h-2.5v2.5h2V13H18v2z"></path>
                  </svg>
                </button>
                <div class="movi-subtitle-track-menu" style="display: none;">
                  <div class="movi-subtitle-track-list"></div>
                </div>
              </div>

              <div class="movi-quality-container" style="display: none;">
                <button class="movi-btn movi-quality-btn" aria-label="Quality">
                  <svg class="movi-icon-quality" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                </button>
                <div class="movi-quality-menu" style="display: none;">
                  <div class="movi-quality-list"></div>
                </div>
              </div>

              <div class="movi-hdr-container">
                <button class="movi-btn movi-hdr-btn" aria-label="Toggle HDR">
                  <svg class="movi-icon-hdr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 7v10M5 12h5M10 7v10M14 7h6a3 3 0 0 1 0 6h-6M17 13l3 4"></path>
                  </svg>
                  <span class="movi-hdr-label">HDR</span>
                </button>
              </div>

              <div class="movi-speed-container">
                <button class="movi-btn movi-speed-btn" aria-label="Playback Speed">
                  <svg class="movi-icon-speed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5.64 18.36a9 9 0 1 1 12.72 0"></path>
                    <path d="m12 12 4-4"></path>
                  </svg>
                </button>
                <div class="movi-speed-menu" style="display: none;">
                  <div class="movi-speed-list">
                    <div class="movi-speed-item" data-speed="0.25">0.25x</div>
                    <div class="movi-speed-item" data-speed="0.5">0.5x</div>
                    <div class="movi-speed-item" data-speed="0.75">0.75x</div>
                    <div class="movi-speed-item movi-speed-active" data-speed="1">Normal</div>
                    <div class="movi-speed-item" data-speed="1.25">1.25x</div>
                    <div class="movi-speed-item" data-speed="1.5">1.5x</div>
                    <div class="movi-speed-item" data-speed="1.75">1.75x</div>
                    <div class="movi-speed-item" data-speed="2">2x</div>
                  </div>
                </div>
              </div>

              <div class="movi-stable-audio-container">
                <button class="movi-btn movi-stable-audio-btn" aria-label="Toggle Stable Audio">
                  <svg class="movi-icon-stable-audio-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                    <path d="M6 15v-2"></path>
                    <path d="M9 15v-4"></path>
                    <path d="M12 15v-6"></path>
                    <path d="M15 15v-4"></path>
                    <path d="M18 15v-2"></path>
                  </svg>
                  <svg class="movi-icon-stable-audio-filled" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
                    <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm1 9v2h2v-2H5zm3-2v4h2v-4H8zm3-2v6h2V9h-2zm3 2v4h2v-4h-2zm3 2v2h2v-2h-2z"></path>
                  </svg>
                </button>
              </div>

              <button class="movi-btn movi-aspect-ratio-btn" aria-label="Aspect Ratio">
                <svg class="movi-icon-aspect-ratio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <rect class="movi-aspect-inner" x="6" y="8" width="12" height="8" rx="1"/>
                </svg>
              </button>

              <button class="movi-btn movi-loop-btn" aria-label="Toggle Loop">
                <svg class="movi-icon-loop-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 2l4 4-4 4"></path>
                  <path d="M3 11v-1a4 4 0 0 1 4-4h14"></path>
                  <path d="M7 22l-4-4 4-4"></path>
                  <path d="M21 13v1a4 4 0 0 1-4 4H3"></path>
                </svg>
                <svg class="movi-icon-loop-filled" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                  <path d="M17 2l4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="M7 22l-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path>
                </svg>
              </button>
            </div>
            
            <button class="movi-btn movi-more-btn" aria-label="More Settings">
              <svg class="movi-icon-more" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"></polyline>
              </svg>
              <svg class="movi-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </button>
            
            <button class="movi-btn movi-pip-btn" aria-label="Picture in Picture" style="display:none">
              <svg class="movi-icon-pip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="9" width="8" height="6" rx="1" fill="currentColor" opacity="0.3"/>
              </svg>
            </button>
            <button class="movi-btn movi-fullscreen-btn" aria-label="Fullscreen">
              <svg class="movi-icon-fullscreen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
              </svg>
              <svg class="movi-icon-fullscreen-exit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                <path d="M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
    shadowRoot.appendChild(container);
    this.controlsContainer = container;

    // Create title bar as a separate element outside controls container
    const titleBar = document.createElement("div");
    titleBar.className = "movi-title-bar";
    titleBar.style.display = "none";
    titleBar.innerHTML = `<span class="movi-title-text"></span>`;
    shadowRoot.appendChild(titleBar);

    // Create Nerd Stats overlay
    const nerdStats = document.createElement("div");
    nerdStats.className = "movi-nerd-stats";
    nerdStats.style.display = "none";
    nerdStats.innerHTML = `
      <div class="movi-nerd-stats-header">
        <span class="movi-nerd-stats-title">Stats for nerds</span>
        <button class="movi-nerd-stats-close" aria-label="Close stats">&times;</button>
      </div>
      <div class="movi-nerd-stats-body"></div>
    `;
    shadowRoot.appendChild(nerdStats);

    // Nerd stats close button
    nerdStats.querySelector(".movi-nerd-stats-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleNerdStats(shadowRoot);
    });

    // Create Timeline panel (separate from nerd stats)
    const timelinePanel = document.createElement("div");
    timelinePanel.className = "movi-timeline-panel";
    timelinePanel.style.display = "none";
    timelinePanel.innerHTML = `
      <div class="movi-timeline-header">
        <span class="movi-timeline-title">Timeline</span>
        <button class="movi-timeline-close" aria-label="Close timeline">&times;</button>
      </div>
      <div class="movi-timeline-strip"></div>
      <div class="movi-timeline-status"></div>
    `;
    shadowRoot.appendChild(timelinePanel);

    // Timeline close button
    timelinePanel.querySelector(".movi-timeline-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      timelinePanel.style.display = "none";
      this.focus();
    });

    // Create Resume Dialog
    const resumeDialog = document.createElement("div");
    resumeDialog.className = "movi-resume-dialog";
    resumeDialog.style.display = "none";
    resumeDialog.innerHTML = `
      <div class="movi-resume-text">Resume from <span class="movi-resume-time">0:00</span>?</div>
      <div class="movi-resume-buttons">
        <button class="movi-resume-btn movi-resume-yes">Resume</button>
        <button class="movi-resume-btn movi-resume-no">Start Over</button>
      </div>
    `;
    shadowRoot.appendChild(resumeDialog);

    resumeDialog.querySelector(".movi-resume-yes")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const time = parseFloat(resumeDialog.dataset.time || "0");
      resumeDialog.style.display = "none";
      this.focus();
      if (this.player && time > 0) {
        this.player.seek(time).then(() => this.play()).catch(() => {});
      }
    });

    resumeDialog.querySelector(".movi-resume-no")?.addEventListener("click", (e) => {
      e.stopPropagation();
      resumeDialog.style.display = "none";
      this.clearResumePosition();
      if (this.player) {
        this.player.seek(0).catch(() => {});
      }
      this.focus();
    });

    // Create Keyboard Shortcuts Panel
    const shortcutsPanel = document.createElement("div");
    shortcutsPanel.className = "movi-shortcuts-panel";
    shortcutsPanel.style.display = "none";
    shortcutsPanel.innerHTML = `
      <div class="movi-shortcuts-header">
        <span class="movi-shortcuts-title">Keyboard Shortcuts</span>
        <button class="movi-shortcuts-close" aria-label="Close">&times;</button>
      </div>
      <div class="movi-shortcuts-body">
        <div class="movi-shortcuts-col">
          <div class="movi-shortcut-row"><kbd>Space</kbd><span>Play / Pause</span></div>
          <div class="movi-shortcut-row"><kbd>F</kbd><span>Fullscreen</span></div>
          <div class="movi-shortcut-row"><kbd>P</kbd><span>Picture-in-Picture</span></div>
          <div class="movi-shortcut-row"><kbd>M</kbd><span>Mute / Unmute</span></div>
          <div class="movi-shortcut-row"><kbd>&uarr; / &darr;</kbd><span>Volume</span></div>
          <div class="movi-shortcut-row"><kbd>&larr; / &rarr;</kbd><span>Seek ±10s</span></div>
          <div class="movi-shortcut-row"><kbd>0</kbd><span>Seek to Start</span></div>
          <div class="movi-shortcut-row"><kbd>Ctrl+&larr;/&rarr;</kbd><span>Frame Step</span></div>
          <div class="movi-shortcut-row"><kbd>+/-</kbd><span>Speed Up/Down</span></div>
          <div class="movi-shortcut-row"><kbd>V</kbd><span>Cycle Subtitles</span></div>
          <div class="movi-shortcut-row"><kbd>B</kbd><span>Cycle Audio</span></div>
        </div>
        <div class="movi-shortcuts-col">
          <div class="movi-shortcut-row"><kbd>A</kbd><span>Aspect Ratio</span></div>
          <div class="movi-shortcut-row"><kbd>R</kbd><span>Rotate Video</span></div>
          <div class="movi-shortcut-row"><kbd>L</kbd><span>Loop</span></div>
          <div class="movi-shortcut-row"><kbd>U</kbd><span>Stable Volume</span></div>
          <div class="movi-shortcut-row"><kbd>H</kbd><span>HDR Mode</span></div>
          <div class="movi-shortcut-row"><kbd>S</kbd><span>Snapshot</span></div>
          <div class="movi-shortcut-row"><kbd>I</kbd><span>Stats for Nerds</span></div>
          <div class="movi-shortcut-row"><kbd>T</kbd><span>Timeline</span></div>
          <div class="movi-shortcut-row"><kbd>?</kbd><span>This Panel</span></div>
        </div>
      </div>
    `;
    shadowRoot.appendChild(shortcutsPanel);

    shortcutsPanel.querySelector(".movi-shortcuts-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      shortcutsPanel.style.display = "none";
    });

    // Setup control handlers
    this.setupControlHandlers(shadowRoot);
  }

  private setupControlHandlers(shadowRoot: ShadowRoot): void {
    const playPauseBtn = shadowRoot.querySelector(
      ".movi-play-pause",
    ) as HTMLElement;
    const progressBar = shadowRoot.querySelector(
      ".movi-progress-bar",
    ) as HTMLElement;
    const loopBtn = shadowRoot.querySelector(".movi-loop-btn") as HTMLElement;
    const volumeBtn = shadowRoot.querySelector(
      ".movi-volume-btn",
    ) as HTMLElement;
    const volumeSlider = shadowRoot.querySelector(
      ".movi-volume-slider",
    ) as HTMLInputElement;
    const hdrBtn = shadowRoot.querySelector(".movi-hdr-btn") as HTMLElement;
    const fullscreenBtn = shadowRoot.querySelector(
      ".movi-fullscreen-btn",
    ) as HTMLElement;
    const overlay = shadowRoot.querySelector(
      ".movi-controls-overlay",
    ) as HTMLElement;
    const seekBackwardBtn = shadowRoot.querySelector(
      ".movi-seek-backward",
    ) as HTMLElement;
    const seekForwardBtn = shadowRoot.querySelector(
      ".movi-seek-forward",
    ) as HTMLElement;

    let ignoreHover = false; // Prevent hover immediately after click from re-showing thumb

    // Play/Pause (controls bar button)
    playPauseBtn?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      if (this.player) {
        const state = this.player.getState();
        if (state === "playing" || state === "buffering") {
          this.pause();
        } else {
          // Play if in ready, paused, ended, or any other non-playing state
          this.play();
        }
      }
    });

    // Seek Backward
    seekBackwardBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = "left";
      const currentTime = this.currentTime;
      const newTime = Math.max(0, currentTime - 10);
      // Can seek if currently more than 0.5s away from start
      const canSeek = currentTime > 0.5;
      Logger.debug(TAG, `Seek backward: ${currentTime}s -> ${newTime}s (canSeek: ${canSeek})`);

      // Always perform the seek
      this.currentTime = newTime;

      // Only increment counter and show OSD if not at boundary
      if (canSeek) {
        if (this.lastSeekSide === side && Date.now() - this.lastSeekTime < 1000) {
          this.cumulativeSeekAmount += 10;
        } else {
          this.cumulativeSeekAmount = 10;
          this.lastSeekSide = side;
        }
        this.lastSeekTime = Date.now();
        Logger.debug(TAG, `Counter updated: ${this.cumulativeSeekAmount}s`);
        this.showOSD(
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
          </svg>`,
          `- ${this.cumulativeSeekAmount}s`,
        );
      } else {
        Logger.debug(TAG, `At boundary, skipping counter update`);
      }
    });

    // Seek Forward
    seekForwardBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = "right";
      const currentTime = this.currentTime;
      const newTime = Math.min(this.duration, currentTime + 10);
      // Can seek if currently more than 0.5s away from end
      const canSeek = currentTime < this.duration - 0.5;
      Logger.debug(TAG, `Seek forward: ${currentTime}s -> ${newTime}s (duration: ${this.duration}s, canSeek: ${canSeek})`);

      // Always perform the seek
      this.currentTime = newTime;

      // Only increment counter and show OSD if not at boundary
      if (canSeek) {
        if (this.lastSeekSide === side && Date.now() - this.lastSeekTime < 1000) {
          this.cumulativeSeekAmount += 10;
        } else {
          this.cumulativeSeekAmount = 10;
          this.lastSeekSide = side;
        }
        this.lastSeekTime = Date.now();
        Logger.debug(TAG, `Counter updated: ${this.cumulativeSeekAmount}s`);
        this.showOSD(
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
          </svg>`,
          `+ ${this.cumulativeSeekAmount}s`,
        );
      } else {
        Logger.debug(TAG, `At boundary, skipping counter update`);
      }
    });

    hdrBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hdr = !this.hdr;
      this.showOSD(
        OSD.hdr,
        this.hdr ? "HDR On" : "HDR Off",
      );
    });

    // Loop Toggle
    loopBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.loop = !this.loop;
      this.showOSD(
        OSD.loop,
        this.loop ? "Loop On" : "Loop Off",
      );
    });

    // Stable Audio Toggle
    const stableAudioBtn = shadowRoot.querySelector(".movi-stable-audio-btn") as HTMLElement;
    stableAudioBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.player) {
        const current = this.player.getStableAudio();
        this.player.setStableAudio(!current);
        this.updateStableAudioUI(shadowRoot);
        this.showOSD(
          OSD.stableAudio,
          !current ? "Stable Volume On" : "Stable Volume Off",
        );
      }
    });

    // Center play/pause button
    const centerPlayPauseBtn = shadowRoot.querySelector(
      ".movi-center-play-pause",
    ) as HTMLElement;
    centerPlayPauseBtn?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      if (this.player) {
        const state = this.player.getState();
        if (state === "playing" || state === "buffering") {
          this.pause();
        } else {
          // Play if in ready, paused, ended, or any other non-playing state
          this.play();
        }
      }
    });

    // Seek Thumbnail Helpers
    const thumbnail = shadowRoot.querySelector(
      ".movi-seek-thumbnail",
    ) as HTMLElement;
    const thumbnailTime = shadowRoot.querySelector(
      ".movi-seek-time",
    ) as HTMLElement;
    const thumbnailImg = shadowRoot.querySelector(
      ".movi-thumbnail-img",
    ) as HTMLImageElement;

    let previewDebounce: number | null = null;
    let lastPreviewUrl: string | null = null;
    let hoverIntentTimer: number | null = null;
    let lastHoverEvent: MouseEvent | null = null;
    let hideTimer: number | null = null;
    let showRafId: number | null = null;

    // Queue state for serialized preview fetching
    const previewLoopState = {
      isFetching: false,
      nextTime: null as number | null,
    };

    const processPreviewQueue = async () => {
      if (previewLoopState.isFetching || previewLoopState.nextTime === null)
        return;

      previewLoopState.isFetching = true;
      const timeToFetch = previewLoopState.nextTime;
      previewLoopState.nextTime = null; // Clear pending

      try {
        if (!this.player) return;
        const blob = await (this.player as any).getPreviewFrame?.(timeToFetch);

        // Update UI if we got a blob
        if (blob && thumbnailImg) {
          if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
          lastPreviewUrl = URL.createObjectURL(blob);
          thumbnailImg.src = lastPreviewUrl;

          // Show image (Hide static)
          const thumbnailPlaceholder = shadowRoot.querySelector(
            ".movi-thumbnail-placeholder",
          ) as HTMLElement;
          if (thumbnailPlaceholder) thumbnailPlaceholder.style.display = "none";
          thumbnailImg.style.display = "block";

          // Re-apply rotation transform + margin on each preview load
          this.applyThumbnailRotation(thumbnailImg);
        }
      } catch (e) {
        // Ignore aborts
      } finally {
        previewLoopState.isFetching = false;
        // If another time was requested while we were busy, loop again immediately
        if (previewLoopState.nextTime !== null) {
          processPreviewQueue();
        }
      }
    };

    const requestPreview = (time: number) => {
      if (!this.player || !thumbnailImg) return;

      const thumbnailPlaceholder = shadowRoot.querySelector(
        ".movi-thumbnail-placeholder",
      ) as HTMLElement;

      // Cancel pending timer
      if (previewDebounce) clearTimeout(previewDebounce);

      // Always switch to static noise when invalidating/debouncing
      thumbnailImg.style.display = "none";
      if (thumbnailPlaceholder) thumbnailPlaceholder.style.display = "block";

      // Schedule this time
      previewLoopState.nextTime = time;

      previewDebounce = window.setTimeout(() => {
        processPreviewQueue();
      }, 150);
    };

    // Helper to show/update thumbnail AND progress visuals during dragging/hovering
    const updateScrubbingUI = (
      clientX: number,
      showPreview: boolean = true,
    ) => {
      if (!progressBar || !thumbnail || !thumbnailTime) return;

      const rect = progressBar.getBoundingClientRect();
      const offsetX = clientX - rect.left;
      const percent = Math.max(0, Math.min(1, offsetX / rect.width));
      const duration = this.duration;

      // Update visual progress bar immediately only when dragging
      if (this.isDragging || this.isTouchDragging) {
        const progressFilled = shadowRoot.querySelector(
          ".movi-progress-filled",
        ) as HTMLElement;
        const progressHandle = shadowRoot.querySelector(
          ".movi-progress-handle",
        ) as HTMLElement;
        if (progressFilled) progressFilled.style.width = `${percent * 100}%`;
        if (progressHandle) progressHandle.style.left = `${percent * 100}%`;
      }

      if (duration <= 0) return;

      // If preview is disabled (e.g. on touch start), strictly hide/don't show
      if (!showPreview) {
        return;
      }

      const time = percent * duration;
      thumbnailTime.textContent = this.formatTime(time);

      // Show chapter title if hovering over a chapter
      const chapterTitleEl = shadowRoot.querySelector(".movi-seek-chapter-title") as HTMLElement;
      if (chapterTitleEl) {
        const chapters = this.player?.getChapters() ?? [];
        const chapter = chapters.find((ch, i) => {
          const end = i < chapters.length - 1 ? chapters[i + 1].start : duration;
          return time >= ch.start && time < end;
        });
        if (chapter) {
          chapterTitleEl.textContent = chapter.title;
          chapterTitleEl.style.display = "block";
        } else {
          chapterTitleEl.style.display = "none";
        }
      }

      if (this._thumb) {
        requestPreview(time);
      } else {
        if (thumbnailImg) thumbnailImg.style.display = "none";
        const thumbnailPlaceholder = shadowRoot.querySelector(
          ".movi-thumbnail-placeholder",
        ) as HTMLElement;
        if (thumbnailPlaceholder) thumbnailPlaceholder.style.display = "none";
      }

      // Position Tooltip
      let leftPos = offsetX;
      const tooltipWidth = this._thumb ? 160 : 60;
      if (leftPos < tooltipWidth / 2) leftPos = tooltipWidth / 2;
      if (leftPos > rect.width - tooltipWidth / 2)
        leftPos = rect.width - tooltipWidth / 2;

      thumbnail.style.left = `${leftPos}px`;
      thumbnail.style.display = "flex";

      // Cancel previous pending show
      if (showRafId) {
        cancelAnimationFrame(showRafId);
      }

      // Only add visible class in next frame to trigger transition
      showRafId = requestAnimationFrame(() => {
        showRafId = null;
        // Guard: If we are hiding (timer set), hidden (display none), or in deadzone (ignoreHover), don't show
        if (hideTimer || thumbnail.style.display === "none" || ignoreHover)
          return;
        thumbnail.classList.add("visible");
      });

      // Cancel any pending hide timers
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const hideThumbnail = (delay = 150) => {
      if (!thumbnail) return;

      // Cancel pending show
      if (showRafId) {
        cancelAnimationFrame(showRafId);
        showRafId = null;
      }

      if (hideTimer) clearTimeout(hideTimer);

      const doHide = () => {
        thumbnail.classList.remove("visible");
        if (previewDebounce) clearTimeout(previewDebounce);

        // If immediate (delay 0), hide immediately. Otherwise wait for transition.
        const transitionDelay = delay === 0 ? 0 : 150;

        setTimeout(() => {
          if (!thumbnail.classList.contains("visible")) {
            thumbnail.style.display = "none";
            if (thumbnailImg) thumbnailImg.style.display = "none";
            const thumbnailPlaceholder = shadowRoot.querySelector(
              ".movi-thumbnail-placeholder",
            ) as HTMLElement;
            if (thumbnailPlaceholder)
              thumbnailPlaceholder.style.display = "block";
          }
        }, transitionDelay);
      };

      if (delay === 0) {
        doHide();
        hideTimer = null;
      } else {
        hideTimer = window.setTimeout(() => {
          doHide();
          hideTimer = null;
        }, delay);
      }
    };

    progressBar?.addEventListener("mousedown", async (e) => {
      if (this.isLoading || this._isUnsupported || !this.player) return;
      e.stopPropagation();
      this.isDragging = true;
      this.showControls();
      updateScrubbingUI(e.clientX);
      // Don't seek yet, standard practice is to seek on release or drag depending on config
      // User requested seek on release only
    });

    document.addEventListener("mousemove", async (e) => {
      if (this.isDragging) {
        this.showControls();
        updateScrubbingUI(e.clientX);
      }
    });

    document.addEventListener("mouseup", async (e) => {
      if (this.isDragging) {
        this.isDragging = false; // Stop dragging immediately to prevent UI updates during seek
        await this.seekFromEvent(e); // Actual seek on release
      }
      this.isDragging = false;
      const controlsContainer = shadowRoot.querySelector(
        ".movi-controls-container",
      ) as HTMLElement;
      if (controlsContainer) {
        const rect = controlsContainer.getBoundingClientRect();
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        const stillOverControls =
          mouseX >= rect.left &&
          mouseX <= rect.right &&
          mouseY >= rect.top &&
          mouseY <= rect.bottom;

        this.isOverControls = stillOverControls;

        if (stillOverControls) {
          this.showControls();
        } else {
          this.showControls();
        }
      }
    });

    // Touch events for progress bar scrubbing with thumbnail
    progressBar?.addEventListener(
      "touchstart",
      async (e) => {
        if (this.isLoading || this._isUnsupported || !this.player) return;
        if (e.cancelable) e.preventDefault(); // Prevent ghost mouse events
        e.stopPropagation();
        this.isTouchDragging = true;
        hideThumbnail(0); // Ensure thumbnail is hidden at start of touch
        this.showControls();
        const touch = e.touches[0];
        this.touchStartX = touch.clientX; // Record start X for threshold
        updateScrubbingUI(touch.clientX, false); // False = Don't show thumbnail on initial touch
        // Don't seek yet
      },
      { passive: false },
    );

    document.addEventListener(
      "touchmove",
      async (e) => {
        if (this.isTouchDragging && progressBar) {
          this.showControls();
          const touch = e.touches[0];

          // Check for drag threshold to avoid showing thumbnail on slight taps
          const moveThreshold = 20;
          const isActuallyDragging =
            Math.abs(touch.clientX - this.touchStartX) > moveThreshold;

          updateScrubbingUI(touch.clientX, isActuallyDragging);
        }
      },
      { passive: true },
    );

    document.addEventListener("touchend", async (e) => {
      if (this.isTouchDragging) {
        this.isTouchDragging = false; // Stop dragging immediately
        const touch = e.changedTouches[0];
        if (touch) {
          await this.seekFromTouchEvent(e); // Actual seek on release
        }
        hideThumbnail(0);
      }
      this.isTouchDragging = false;
    });

    progressBar?.addEventListener("click", async (e) => {
      if (this.isLoading || this._isUnsupported || !this.player) return;
      e.stopPropagation();
      ignoreHover = true;

      // Brute-force safety interval to prevent race conditions during seek
      const safetyInterval = setInterval(() => hideThumbnail(0), 50);

      setTimeout(() => {
        ignoreHover = false;
        clearInterval(safetyInterval);
      }, 500); // 500ms deadzone

      hideThumbnail(0); // Hide immediately on click
      await this.seekFromEvent(e);
      this.showControls();
    });

    // Volume
    volumeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();

      // Determine if interaction is touch-based
      const pEvent = e as PointerEvent;
      const isTouch = pEvent.pointerType === "touch";
      const isMouse = pEvent.pointerType === "mouse";
      const noHover = window.matchMedia("(hover: none)").matches;

      const volumeContainer = shadowRoot.querySelector(
        ".movi-volume-container",
      );

      // If explicit mouse interaction -> Just Mute (Desktop)
      if (isMouse) {
        this.muted = !this.muted;
        return;
      }

      // If on mobile/touch, prioritize opening slider
      if (volumeContainer && (isTouch || noHover)) {
        // If slider is NOT active, open it
        if (!volumeContainer.classList.contains("active")) {
          volumeContainer.classList.add("active");

          const closeVolume = (evt: Event) => {
            const target = evt.target as Node;
            // If click outside container and button
            if (
              volumeContainer &&
              !volumeContainer.contains(target) &&
              target !== volumeBtn &&
              !volumeBtn.contains(target)
            ) {
              volumeContainer.classList.remove("active");
              document.removeEventListener("click", closeVolume);
            }
          };

          // Defer listener
          setTimeout(() => {
            document.addEventListener("click", closeVolume);
          }, 10);

          return; // Capture event, do NOT mute
        }
      }

      // Default behavior (Desktop click OR Touch second click): Toggle mute
      this.muted = !this.muted;
    });
    volumeSlider?.addEventListener("input", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      const target = e.target as HTMLInputElement;
      this.volume = parseFloat(target.value);
    });
    volumeSlider?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
    });

    // Mouse Hover Logic for Thumbnail (Desktop)
    if (progressBar && thumbnail) {
      progressBar.addEventListener("mousemove", (e) => {
        // Ignore if dragging OR recent click
        if (this.isDragging || ignoreHover) return;

        lastHoverEvent = e;

        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }

        // Hover Logic
        if (thumbnail.classList.contains("visible")) {
          updateScrubbingUI(e.clientX);
        } else {
          if (!hoverIntentTimer) {
            hoverIntentTimer = window.setTimeout(() => {
              if (lastHoverEvent) {
                updateScrubbingUI(lastHoverEvent.clientX);
              }
              hoverIntentTimer = null;
            }, 150);
          }
        }
      });

      progressBar.addEventListener("mouseleave", () => {
        // Don't hide if dragging!
        if (this.isDragging) return;

        if (hoverIntentTimer) {
          clearTimeout(hoverIntentTimer);
          hoverIntentTimer = null;
        }
        hideThumbnail(300); // 300ms delay for mouse leave
      });
    }

    // Audio Track
    const audioTrackBtn = shadowRoot.querySelector(
      ".movi-audio-track-btn",
    ) as HTMLElement;
    const audioTrackMenu = shadowRoot.querySelector(
      ".movi-audio-track-menu",
    ) as HTMLElement;

    audioTrackBtn?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      // Toggle menu visibility
      if (audioTrackMenu) {
        const isVisible = audioTrackMenu.style.display !== "none";
        audioTrackMenu.style.display = isVisible ? "none" : "block";
        if (!isVisible) {
          this.updateAudioTrackMenu();
          this.updateSubtitleTrackMenu();
        }
      }
    });

    // Close menu when clicking outside
    const closeMenuHandler = (e: MouseEvent) => {
      if (
        audioTrackMenu &&
        audioTrackBtn &&
        !audioTrackMenu.contains(e.target as Node) &&
        !audioTrackBtn.contains(e.target as Node)
      ) {
        audioTrackMenu.style.display = "none";
      }
    };
    document.addEventListener("click", closeMenuHandler);

    // Subtitle Track
    const subtitleTrackBtn = shadowRoot.querySelector(
      ".movi-subtitle-track-btn",
    ) as HTMLElement;
    const subtitleTrackMenu = shadowRoot.querySelector(
      ".movi-subtitle-track-menu",
    ) as HTMLElement;

    subtitleTrackBtn?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      // Toggle menu visibility
      if (subtitleTrackMenu) {
        const isVisible = subtitleTrackMenu.style.display !== "none";
        subtitleTrackMenu.style.display = isVisible ? "none" : "block";
        if (!isVisible) {
          this.updateSubtitleTrackMenu();
        }
      }
    });

    // Close subtitle menu when clicking outside
    const closeSubtitleMenuHandler = (e: MouseEvent) => {
      if (
        subtitleTrackMenu &&
        subtitleTrackBtn &&
        !subtitleTrackMenu.contains(e.target as Node) &&
        !subtitleTrackBtn.contains(e.target as Node)
      ) {
        subtitleTrackMenu.style.display = "none";
      }
    };
    document.addEventListener("click", closeSubtitleMenuHandler);

    // Aspect Ratio
    const aspectRatioBtn = shadowRoot.querySelector(
      ".movi-aspect-ratio-btn",
    ) as HTMLElement;
    aspectRatioBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const fits = ["contain", "cover", "fill", "zoom"] as const;
      const current = this._objectFit === "control" ? this._currentFit : this._objectFit;
      const idx = fits.indexOf(current as any);
      const next = fits[(idx + 1) % fits.length];
      if (this._objectFit === "control") {
        this._currentFit = next;
      } else {
        this._objectFit = next;
      }
      this.updateFitMode();
      const labels: Record<string, string> = { contain: "Fit", cover: "Fill", fill: "Stretch", zoom: "Zoom" };
      const osdSvg = MoviElement.ASPECT_ICONS[next] || MoviElement.ASPECT_ICONS.contain;
      this.showOSD(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${osdSvg}</svg>`,
        labels[next],
      );
    });

    // Playback Speed
    const speedBtn = shadowRoot.querySelector(".movi-speed-btn") as HTMLElement;
    const speedMenu = shadowRoot.querySelector(
      ".movi-speed-menu",
    ) as HTMLElement;
    const qualityMenu = shadowRoot.querySelector(
      ".movi-quality-menu",
    ) as HTMLElement;
    const qualityBtn = shadowRoot.querySelector(
      ".movi-quality-btn",
    ) as HTMLElement;

    speedBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (speedMenu) {
        // Close other menus
        if (audioTrackMenu) audioTrackMenu.style.display = "none";
        if (subtitleTrackMenu) subtitleTrackMenu.style.display = "none";
        if (qualityMenu) qualityMenu.style.display = "none";

        const isVisible = speedMenu.style.display !== "none";
        speedMenu.style.display = isVisible ? "none" : "block";
      }
    });

    qualityBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (qualityMenu) {
        // Close other menus
        if (audioTrackMenu) audioTrackMenu.style.display = "none";
        if (subtitleTrackMenu) subtitleTrackMenu.style.display = "none";
        if (speedMenu) speedMenu.style.display = "none";

        const isVisible = qualityMenu.style.display !== "none";
        qualityMenu.style.display = isVisible ? "none" : "block";
        if (!isVisible) this.updateQualityMenu();
      }
    });

    // Speed selection
    shadowRoot.querySelectorAll(".movi-speed-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const speed = parseFloat((item as HTMLElement).dataset.speed || "1");
        this.playbackRate = speed;
        this.showOSD(
          OSD.speed,
          `Speed ${speed}x`,
        );
        if (speedMenu) speedMenu.style.display = "none";
      });
    });

    // Close speed menu when clicking outside
    // Close speed/quality menu when clicking outside
    document.addEventListener("click", (e) => {
      const target = e.target as Node;
      if (
        speedMenu &&
        speedBtn &&
        !speedMenu.contains(target) &&
        !speedBtn.contains(target)
      ) {
        speedMenu.style.display = "none";
      }
      if (
        qualityMenu &&
        qualityBtn &&
        !qualityMenu.contains(target) &&
        !qualityBtn.contains(target)
      ) {
        qualityMenu.style.display = "none";
      }
    });

    // Fullscreen
    fullscreenBtn?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      this.toggleFullscreen();
    });

    // Picture-in-Picture
    const pipBtn = shadowRoot.querySelector(".movi-pip-btn") as HTMLElement;
    // Show PiP button + context menu item only if Document PiP API is available
    if ("documentPictureInPicture" in window) {
      if (pipBtn) pipBtn.style.display = "";
      const pipCtxItem = shadowRoot.querySelector(".movi-context-menu-pip") as HTMLElement;
      if (pipCtxItem) pipCtxItem.style.display = "";
    }
    pipBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePiP();
    });

    // More Settings (Mobile Horizontal Expansion)
    const moreBtn = shadowRoot.querySelector(".movi-more-btn") as HTMLElement;
    const controlsRight = shadowRoot.querySelector(
      ".movi-controls-right",
    ) as HTMLElement;

    moreBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (controlsRight) {
        const isExpanded = controlsRight.classList.toggle("expanded");

        // Update More icon
        const moreIcon = moreBtn.querySelector(
          ".movi-icon-more",
        ) as HTMLElement;
        const closeIcon = moreBtn.querySelector(
          ".movi-icon-close",
        ) as HTMLElement;
        if (moreIcon && closeIcon) {
          moreIcon.style.display = isExpanded ? "none" : "block";
          closeIcon.style.display = isExpanded ? "block" : "none";
        }
      }
    });

    // Close expansion when clicking outside
    document.addEventListener("click", (e) => {
      if (
        controlsRight?.classList.contains("expanded") &&
        !controlsRight.contains(e.target as Node)
      ) {
        controlsRight.classList.remove("expanded");
        const moreIcon = moreBtn?.querySelector(
          ".movi-icon-more",
        ) as HTMLElement;
        const closeIcon = moreBtn?.querySelector(
          ".movi-icon-close",
        ) as HTMLElement;
        if (moreIcon && closeIcon) {
          moreIcon.style.display = "block";
          closeIcon.style.display = "none";
        }
      }
    });

    // Click on video to play/pause (only on canvas/video area, not controls)
    // Handle clicks on both overlay and canvas
    const handleVideoClick = (e: MouseEvent) => {
      // If context menu is open or was just closed, don't toggle play/pause
      if (this._contextMenuVisible || this._contextMenuJustClosed) {
        // Context menu will be hidden by its own click handler
        // Just prevent play/pause toggle
        return;
      }

      // Check if this is a touch-generated click (pointerType or sourceCapabilities)
      const isTouchClick =
        (e as any).pointerType === "touch" ||
        (e as any).sourceCapabilities?.firesTouchEvents;

      // Ignore if this was triggered by a touch gesture
      if (isTouchClick && this.gesturePerformed) {
        this.gesturePerformed = false; // Reset for next interaction
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // For mouse clicks, always allow (gesturePerformed only applies to touch)

      // Don't trigger if clicking on controls or any control element
      const target = e.target as Element;
      const controlsBar = shadowRoot.querySelector(
        ".movi-controls-bar",
      ) as HTMLElement;
      const centerPlayPause = shadowRoot.querySelector(
        ".movi-center-play-pause",
      ) as HTMLElement;

      // Check if click originated from controls area
      if (
        controlsBar &&
        (controlsBar.contains(target) || target.closest(".movi-controls-bar"))
      ) {
        e.stopPropagation(); // Stop event from bubbling
        return; // Don't toggle play/pause if clicking controls
      }

      // Check if click is on center play/pause button
      if (
        centerPlayPause &&
        (centerPlayPause.contains(target) ||
          target.closest(".movi-center-play-pause"))
      ) {
        e.stopPropagation();
        return; // Don't toggle if clicking on center button (it has its own handler)
      }

      // Check if click is on a button or interactive element
      if (
        target.closest("button") ||
        target.closest("input") ||
        target.closest(".movi-btn")
      ) {
        e.stopPropagation();
        return; // Don't toggle if clicking on controls
      }

      // Mouse Triple Click logic removed to prevent accidental seeking

      // Delay single click to allow double click detection
      // Cancel any existing timer
      if (this.clickTimer) {
        clearTimeout(this.clickTimer);
      }

      // Set timer to execute single click after delay
      this.clickTimer = window.setTimeout(() => {
        // If we've passed all the control checks above, toggle play/pause
        // This means the click is on the video area (canvas/overlay), not on controls
        this.focus(); // Make sure it gets focus for keyboard shortcuts
        const state = this.player?.getState();
        if (state === "playing" || state === "buffering") {
          this.pause();
        } else {
          this.play();
        }
        this.clickTimer = null;
      }, 300); // Wait 300ms to see if double click happens
    };

    overlay?.addEventListener("click", handleVideoClick);
    this.canvas.addEventListener("click", handleVideoClick);
    this.video.addEventListener("click", handleVideoClick);

    // Keyboard shortcuts
    this.setupKeyboardShortcuts();

    // Setup gestures
    this.setupGestures(shadowRoot);

    // Setup context menu
    this.setupContextMenu(shadowRoot);

    // Fullscreen change listener
    document.addEventListener("fullscreenchange", () => {
      const isFullscreen = !!document.fullscreenElement;
      this.updateFullscreenIcon(isFullscreen);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.updateCanvasSize();
        });
      });
    });

    // Show/hide controls - use a flag to track if mouse is over controls
    const controlsContainer = shadowRoot.querySelector(
      ".movi-controls-container",
    ) as HTMLElement;

    // Keep controls visible when hovering over controls area
    controlsContainer?.addEventListener("mouseenter", () => {
      this.isOverControls = true;
      this.showControls();
    });

    controlsContainer?.addEventListener(
      "touchstart",
      () => {
        this.lastTouchTime = Date.now();
        this.isOverControls = true;
        this.showControls();
      },
      { passive: true },
    );

    controlsContainer?.addEventListener(
      "touchend",
      () => {
        setTimeout(() => {
          this.isOverControls = false;
          // Restart hide timer if playing
          if (this.player?.getState() === "playing") {
            this.showControls();
          }
        }, 1000);
      },
      { passive: true },
    );

    controlsContainer?.addEventListener("mouseleave", (e) => {
      // Check if mouse is moving to another part of controls
      const relatedTarget = e.relatedTarget as Element;
      if (relatedTarget && controlsContainer?.contains(relatedTarget)) {
        return; // Still over controls
      }

      // Ignore mouseleave if it's a touch interaction (within 1000ms of last touch)
      if (Date.now() - this.lastTouchTime < 1000) {
        return;
      }

      this.isOverControls = false;
      // Only hide if not dragging
      if (!this.isDragging) {
        this.hideControls();
      }
    });

    // Show controls when mouse enters video area (overlay)
    overlay?.addEventListener("mouseenter", () => {
      if (!this.isOverControls) {
        this.showControls();
      }
    });

    // Hide controls when mouse leaves video area (but not if going to controls)
    overlay?.addEventListener("mouseleave", (e) => {
      const relatedTarget = e.relatedTarget as Element;
      // Don't hide if mouse is moving to controls
      if (relatedTarget && controlsContainer?.contains(relatedTarget)) {
        return;
      }
      // Only hide if not over controls and not dragging
      if (!this.isOverControls && !this.isDragging) {
        this.hideControls();
      }
    });

    // Show controls when mouse moves over canvas/video/overlay
    const activityHandler = () => {
      this.showControls();
    };

    this.canvas.addEventListener("mousemove", activityHandler);
    this.video.addEventListener("mousemove", activityHandler);
    overlay?.addEventListener("mousemove", activityHandler);
    controlsContainer?.addEventListener("mousemove", activityHandler);
  }

  private async seekFromEvent(e: MouseEvent): Promise<void> {
    const progressBar = this.shadowRoot?.querySelector(
      ".movi-progress-bar",
    ) as HTMLElement;
    if (
      !progressBar ||
      !this.player ||
      this.isSeeking ||
      this.isLoading ||
      this._isUnsupported
    )
      return;

    const state = this.player.getState();
    // Allow seeking in playable states + buffering/seeking
    if (
      state !== "ready" &&
      state !== "playing" &&
      state !== "paused" &&
      state !== "ended" &&
      state !== "buffering" &&
      state !== "seeking"
    ) {
      return;
    }

    const rect = progressBar.getBoundingClientRect();
    const percent = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const duration = this.duration;
    if (duration <= 0) return;

    const time = percent * duration;
    const wasPlaying = state === "playing";

    this.isSeeking = true;
    try {
      await this.player.seek(time);

      // If we were playing before seek, ensure playback resumes
      // The player should handle this, but add a safety check
      if (wasPlaying && this.player.getState() !== "playing") {
        // Small delay to let seek complete, then resume if needed
        setTimeout(() => {
          if (this.player) {
            const currentState = this.player.getState();
            if (currentState === "ready" || currentState === "paused") {
              this.player.play().catch((err) => {
                Logger.error(TAG, "Failed to resume playback after seek", err);
              });
            }
          }
        }, 100);
      }
    } catch (error) {
      Logger.error(TAG, "Seek error", error);
      // Don't show alert for seek errors - they're usually recoverable
    } finally {
      this.isSeeking = false;
    }
  }

  private async seekFromTouchEvent(e: TouchEvent): Promise<void> {
    const progressBar = this.shadowRoot?.querySelector(
      ".movi-progress-bar",
    ) as HTMLElement;
    if (
      !progressBar ||
      !this.player ||
      this.isSeeking ||
      this.isLoading ||
      this._isUnsupported
    )
      return;

    // Get touch position
    const touch = e.touches[0] || e.changedTouches[0];
    if (!touch) return;

    const state = this.player.getState();
    // Allow seeking in playable states + buffering/seeking
    if (
      state !== "ready" &&
      state !== "playing" &&
      state !== "paused" &&
      state !== "ended" &&
      state !== "buffering" &&
      state !== "seeking"
    ) {
      return;
    }

    const rect = progressBar.getBoundingClientRect();
    const percent = Math.max(
      0,
      Math.min(1, (touch.clientX - rect.left) / rect.width),
    );
    const duration = this.duration;
    if (duration <= 0) return;

    const time = percent * duration;
    const wasPlaying = state === "playing";

    this.isSeeking = true;
    try {
      await this.player.seek(time);

      // If we were playing before seek, ensure playback resumes
      if (wasPlaying && this.player.getState() !== "playing") {
        setTimeout(() => {
          if (this.player) {
            const currentState = this.player.getState();
            if (currentState === "ready" || currentState === "paused") {
              this.player.play().catch((err) => {
                Logger.error(TAG, "Failed to resume playback after seek", err);
              });
            }
          }
        }, 100);
      }
    } catch (error) {
      Logger.error(TAG, "Touch seek error", error);
    } finally {
      this.isSeeking = false;
    }
  }

  private setupGestures(shadowRoot: ShadowRoot): void {
    const overlay = shadowRoot.querySelector(
      ".movi-controls-overlay",
    ) as HTMLElement;
    const canvas = this.canvas;
    const video = this.video;

    // Use the most appropriate target for gestures
    // Overlay is best if visible, but canvas/video are better fallbacks
    // We EXCLUDE 'this' (the host) here to prevent gestures from capturing
    // interactions on the control bar at the bottom.
    const gestureTargets = [overlay, canvas, video].filter(
      (t) => t !== null,
    ) as HTMLElement[];

    // Single tap for play/pause, double tap for fullscreen/seek (touch)
    let lastTap = 0;
    let tapTimer: number | null = null;

    const handleTap = (e: TouchEvent) => {
      const target = e.target as Element;
      // Don't trigger if tapping on controls
      if (
        target.closest(".movi-controls-bar") ||
        target.closest(".movi-center-play-pause") ||
        target.closest("button") ||
        target.closest("input") ||
        target.closest(".movi-btn")
      ) {
        return;
      }

      // If double tap is disabled, handle as single tap immediately (simple toggle)
      if (!this._doubleTap) {
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = null;

        const controlsContainer = this.controlsContainer;
        const controlsHidden = controlsContainer?.classList.contains(
          "movi-controls-hidden",
        );

        if (controlsHidden) {
          this.showControls();
        } else {
          const state = this.player?.getState();
          if (state === "playing" || state === "buffering") {
            this.pause();
          } else {
            this.play();
          }
        }
        return;
      }

      const now = Date.now();
      const tapLength = now - lastTap;

      const touch = e.changedTouches?.[0];
      if (!touch) return;

      const rect = this.getBoundingClientRect();
      const xPos = touch.clientX - rect.left;
      const width = rect.width;

      if (tapLength < 400 && tapLength > 0) {
        // Double tap detected
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = null;

        let didSeek = false;

        // Check if fast seek is enabled
        if (this._fastSeek) {
          if (xPos < width * 0.3) {
            // Rewind
            this.cumulativeSeekAmount = (this.lastSeekSide === "left" && now - this.lastSeekTime < 1000)
              ? this.cumulativeSeekAmount + 10 : 10;
            this.lastSeekSide = "left";
            this.lastSeekTime = now;
            this.currentTime = Math.max(0, this.currentTime - 10);
            this.showOSD(
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
              </svg>`,
              `- ${this.cumulativeSeekAmount}s`,
            );
            didSeek = true;
          } else if (xPos > width * 0.7) {
            // Forward
            this.cumulativeSeekAmount = (this.lastSeekSide === "right" && now - this.lastSeekTime < 1000)
              ? this.cumulativeSeekAmount + 10 : 10;
            this.lastSeekSide = "right";
            this.lastSeekTime = now;
            this.currentTime = Math.min(this.duration, this.currentTime + 10);
            this.showOSD(
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
              </svg>`,
              `+ ${this.cumulativeSeekAmount}s`,
            );
            didSeek = true;
          } else {
            this.toggleFullscreen();
          }
        } else {
          // If seek disabled, always treat double tap as fullscreen toggle
          this.toggleFullscreen();
        }
        // Keep lastTap alive for continuous tapping (like YouTube)
        // If we seeked, next tap should immediately seek again
        lastTap = didSeek ? now : 0;
      } else {
        // First tap
        lastTap = now;

        tapTimer = window.setTimeout(() => {
          // Single tap action (show controls or toggle play)
          const controlsContainer = this.controlsContainer;
          const controlsHidden = controlsContainer?.classList.contains(
            "movi-controls-hidden",
          );

          if (controlsHidden) {
            this.showControls();
          } else {
            const state = this.player?.getState();
            if (state === "playing" || state === "buffering") {
              this.pause();
            } else {
              this.play();
            }
          }
          lastTap = 0;
        }, 300);
      }
    };

    let initialVolume = this._volume;
    let initialSeekTime = 0;
    let isVerticalGesture = false;
    let isHorizontalGesture = false;
    let isEdgeStart = false;

    // Attach listeners to all possible interaction targets
    gestureTargets.forEach((target) => {
      // Touch events
      target.addEventListener(
        "touchstart",
        (e: TouchEvent) => {
          if (e.touches.length === 1) {
            this.gesturePerformed = false;
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;

            // Check for edge start to prevent conflict with system gestures
            // Safe area: 40px from edges
            const edgeThreshold = 40;
            const winWidth = window.innerWidth;
            const winHeight = window.innerHeight;
            isEdgeStart =
              this.touchStartX < edgeThreshold ||
              this.touchStartX > winWidth - edgeThreshold ||
              this.touchStartY < edgeThreshold ||
              this.touchStartY > winHeight - edgeThreshold;

            this.touchStartTime = Date.now();
            initialVolume = this._volume;
            initialSeekTime = this.currentTime;
            isVerticalGesture = false;
            isHorizontalGesture = false;
          }
        },
        { passive: true },
      );

      target.addEventListener(
        "touchmove",
        (e: TouchEvent) => {
          if (isEdgeStart) return;
          if (e.touches.length === 1) {
            const touch = e.touches[0];
            const deltaX = touch.clientX - this.touchStartX;
            const deltaY = touch.clientY - this.touchStartY;

            // Determine gesture type early
            // If gesturefs is enabled, ONLY allow gestures if in fullscreen
            if (this._gesturefs && !document.fullscreenElement) {
              return;
            }

            if (
              !isVerticalGesture &&
              !isHorizontalGesture &&
              !this.gesturePerformed
            ) {
              if (Math.abs(deltaY) > 5 && Math.abs(deltaY) > Math.abs(deltaX)) {
                isVerticalGesture = true;
                this.gesturePerformed = true;
              } else if (Math.abs(deltaX) > 10) {
                isHorizontalGesture = true;
                this.gesturePerformed = true;
              }
            }

            if (isVerticalGesture) {
              const rect = this.getBoundingClientRect();
              const startXPercent = (this.touchStartX - rect.left) / rect.width;

              // Right side vertical swipe = Volume
              if (startXPercent > 0.5) {
                if (e.cancelable) e.preventDefault();

                const volumeChange = -deltaY / 200;
                const newVolume = Math.max(
                  0,
                  Math.min(1, initialVolume + volumeChange),
                );
                this.volume = newVolume;
              }
            } else if (isHorizontalGesture) {
              // Only enabled if fastseek is true
              if (!this._fastSeek) return;

              if (e.cancelable) e.preventDefault();

              const rect = this.getBoundingClientRect();
              // Sensitivity: Approx 90 seconds for full screen swipe
              const seekRatio = deltaX / rect.width;
              const seekAmount = seekRatio * 90;
              const newTime = Math.max(
                0,
                Math.min(this.duration, initialSeekTime + seekAmount),
              );

              // Show OSD with seek information
              const icon =
                deltaX >= 0
                  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"/></svg>`
                  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg>`;

              const timeStr = this.formatTime(newTime);
              const durationStr = this.formatTime(this.duration);
              this.showOSD(icon, `${timeStr} / ${durationStr}`);

              // Perform actual seek
              // The currentTime setter handles its own isSeeking lock
              this.currentTime = newTime;
            }
          }
        },
        { passive: false },
      );

      target.addEventListener(
        "touchend",
        (e: TouchEvent) => {
          if (e.changedTouches.length === 1) {
            const touch = e.changedTouches[0];
            const endTime = Date.now();
            const deltaX = touch.clientX - this.touchStartX;
            const deltaY = touch.clientY - this.touchStartY;
            const deltaTime = endTime - this.touchStartTime;

            const rect = this.getBoundingClientRect();
            const startXPercent = (this.touchStartX - rect.left) / rect.width;

            // Check for vertical swipe on LEFT side for Fullscreen toggle
            if (
              this.gesturePerformed &&
              isVerticalGesture &&
              startXPercent <= 0.5
            ) {
              if (deltaY < -60) {
                // Swipe UP -> Enter Fullscreen
                if (!document.fullscreenElement) {
                  this.requestFullscreen().catch((err) =>
                    Logger.error(TAG, "Error entering fullscreen", err),
                  );
                }
              } else if (deltaY > 60) {
                // Swipe DOWN -> Exit Fullscreen
                if (document.fullscreenElement) {
                  document
                    .exitFullscreen()
                    .catch((err) =>
                      Logger.error(TAG, "Error exiting fullscreen", err),
                    );
                }
              }
            }

            if (
              !this.gesturePerformed &&
              Math.abs(deltaX) < 20 &&
              Math.abs(deltaY) < 20 &&
              deltaTime < 300
            ) {
              handleTap(e);
              if (e.cancelable) e.preventDefault();
            } else if (this.gesturePerformed) {
              if (e.cancelable) e.preventDefault();
            }

            setTimeout(() => {
              this.gesturePerformed = false;
            }, 300);
          } else {
            this.gesturePerformed = true;
            if (e.cancelable) e.preventDefault();
            setTimeout(() => {
              this.gesturePerformed = false;
            }, 300);
          }
        },
        { passive: false },
      );
    });

    // Mouse double click for fullscreen / fast seek
    const handleDoubleClick = (e: MouseEvent) => {
      // Cancel any pending single click
      if (this.clickTimer) {
        clearTimeout(this.clickTimer);
        this.clickTimer = null;
      }

      this.lastSeekTime = Date.now();

      // Don't trigger if clicking on controls
      const targetEl = e.target as Element;
      const controlsBar = shadowRoot.querySelector(
        ".movi-controls-bar",
      ) as HTMLElement;
      if (controlsBar && controlsBar.contains(targetEl)) {
        return;
      }

      // Mouse double click acts as fullscreen toggle only (no fast seek)
      this.toggleFullscreen();

      e.preventDefault();
      e.stopPropagation();
    };

    // Register double click on all layers
    gestureTargets.forEach((target) => {
      target.addEventListener("dblclick", handleDoubleClick);
    });

    // Mouse single click - handled by overlay click handler for play/pause
  }

  private setupKeyboardShortcuts(): void {
    this.addEventListener("keydown", (e) => {
      // Check if keyboard controls are disabled
      if (this._noHotkeys) return;

      // Only handle if player exists (content loaded)
      if (!this.player) return;

      // Resume dialog keyboard navigation
      const resumeDialog = this.shadowRoot?.querySelector(".movi-resume-dialog") as HTMLElement;
      if (resumeDialog && resumeDialog.style.display !== "none") {
        const yesBtn = resumeDialog.querySelector(".movi-resume-yes") as HTMLElement;
        const noBtn = resumeDialog.querySelector(".movi-resume-no") as HTMLElement;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          // Toggle focus between Resume and Start Over
          // Toggle visual selection
          const yesSelected = yesBtn?.classList.contains("movi-resume-focused");
          yesBtn?.classList.toggle("movi-resume-focused", !yesSelected);
          noBtn?.classList.toggle("movi-resume-focused", yesSelected);
          return;
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const focused = resumeDialog.querySelector(".movi-resume-focused") as HTMLElement;
          (focused || yesBtn)?.click();
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          noBtn?.click();
          return;
        }
      }

      // Timeline navigation — intercept when timeline is open
      const timelinePanel = this.shadowRoot?.querySelector(".movi-timeline-panel") as HTMLElement;
      if (timelinePanel && timelinePanel.style.display !== "none") {
        if (e.key === "Escape") {
          e.preventDefault();
          this.toggleTimeline();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Enter") {
          e.preventDefault();
          const items = timelinePanel.querySelectorAll(".movi-timeline-item");
          if (items.length === 0) return;

          // Find currently selected item
          let selectedIdx = -1;
          items.forEach((item, i) => {
            if ((item as HTMLElement).classList.contains("movi-timeline-selected")) {
              selectedIdx = i;
            }
          });

          if (e.key === "ArrowRight") {
            selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
          } else if (e.key === "ArrowLeft") {
            selectedIdx = Math.max(selectedIdx - 1, 0);
          } else if (e.key === "Enter" && selectedIdx >= 0) {
            // Seek to selected item
            (items[selectedIdx] as HTMLElement).click();
            return;
          }

          // Update selection
          items.forEach((item) => (item as HTMLElement).classList.remove("movi-timeline-selected"));
          if (selectedIdx >= 0) {
            const selected = items[selectedIdx] as HTMLElement;
            selected.classList.add("movi-timeline-selected");
            selected.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
          }
          return;
        }
      }

      switch (e.key) {
        case " ":
        case "k":
        case "K": {
          // Space or K: Play/Pause
          e.preventDefault();
          const state = this.player?.getState();
          if (state === "playing" || state === "buffering") {
            this.pause();
          } else {
            this.play();
          }
          this.showControls();
          break;
        }
        case "ArrowLeft":
          // Left Arrow: Seek backward 5 seconds or single frame (if Ctrl)
          // Only enabled if fastseek is true
          if (!this._fastSeek) break;

          e.preventDefault();
          {
            const side = "left";
            if (e.ctrlKey || e.metaKey) {
              // Frame backward - only work if paused (auto-pause if playing)
              if (this.player?.getState() === "playing") {
                this.pause();
              }
              const vTrack = this.player?.getVideoTracks()?.[0];
              const fps = vTrack?.frameRate || 24;
              const frameTime = 1 / fps;
              this.currentTime = Math.max(0, this.currentTime - frameTime);
              this.showOSD(
                `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg>`,
                `-1 Frame`,
              );
            } else {
              const currentTime = this.currentTime;
              const newTime = Math.max(0, currentTime - 10);
              // Can seek if currently more than 0.5s away from start
              const canSeek = currentTime > 0.5;

              // Always perform the seek
              this.currentTime = newTime;

              // Only increment counter and show OSD if not at boundary
              if (canSeek) {
                // Increase cumulative amount if pressing same direction quickly (or holding key)
                if (
                  this.lastSeekSide === side &&
                  Date.now() - this.lastSeekTime < 1000
                ) {
                  this.cumulativeSeekAmount += 10;
                } else {
                  this.cumulativeSeekAmount = 10;
                  this.lastSeekSide = side;
                }
                this.lastSeekTime = Date.now();

                this.showOSD(
                  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
                  </svg>`,
                  `- ${this.cumulativeSeekAmount}s`,
                );
              }
            }
          }
          break;
        case "ArrowRight":
          // Right Arrow: Seek forward 5 seconds or single frame (if Ctrl)
          // Only enabled if fastseek is true
          if (!this._fastSeek) break;

          e.preventDefault();
          {
            const side = "right";
            if (e.ctrlKey || e.metaKey) {
              // Frame forward - only work if paused (auto-pause if playing)
              if (this.player?.getState() === "playing") {
                this.pause();
              }
              const vTrack = this.player?.getVideoTracks()?.[0];
              const fps = vTrack?.frameRate || 24;
              const frameTime = 1 / fps;
              this.currentTime = Math.min(
                this.duration,
                this.currentTime + frameTime,
              );
              this.showOSD(
                `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"/></svg>`,
                `+1 Frame`,
              );
            } else {
              const currentTime = this.currentTime;
              const newTime = Math.min(this.duration, currentTime + 10);
              // Can seek if currently more than 0.5s away from end
              const canSeek = currentTime < this.duration - 0.5;

              // Always perform the seek
              this.currentTime = newTime;

              // Only increment counter and show OSD if not at boundary
              if (canSeek) {
                if (
                  this.lastSeekSide === side &&
                  Date.now() - this.lastSeekTime < 1000
                ) {
                  this.cumulativeSeekAmount += 10;
                } else {
                  this.cumulativeSeekAmount = 10;
                  this.lastSeekSide = side;
                }
                this.lastSeekTime = Date.now();

                this.showOSD(
                  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                    <path d="M21 3v5h-5" />
                    <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
                  </svg>`,
                  `+ ${this.cumulativeSeekAmount}s`,
                );
              }
            }
          }
          break;
        case "ArrowUp":
          // Up Arrow: Increase volume
          e.preventDefault();
          // Only change volume if audio tracks exist
          if (this.player && this.player.getAudioTracks().length > 0) {
            this.volume = Math.min(1, this.volume + 0.1);
          }
          break;
        case "ArrowDown":
          // Down Arrow: Decrease volume
          e.preventDefault();
          // Only change volume if audio tracks exist
          if (this.player && this.player.getAudioTracks().length > 0) {
            this.volume = Math.max(0, this.volume - 0.1);
          }
          break;
        case "m":
        case "M":
          // M: Mute/Unmute
          e.preventDefault();
          this.muted = !this.muted;
          this.showOSD(
            this.muted
              ? OSD.muted
              : OSD.unmuted,
            this.muted ? "Muted" : "Unmuted",
          );
          break;
        case "s":
        case "S":
          // S: Snapshot
          e.preventDefault();
          this.takeSnapshot();
          this.showOSD(
            OSD.snapshot,
            "Snapshot",
          );
          break;
        case "f":
        case "F":
          // F: Fullscreen
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case "p":
        case "P":
          // P: Picture-in-Picture
          e.preventDefault();
          this.togglePiP();
          break;
        case "i":
        case "I":
          // I: Toggle nerd stats
          e.preventDefault();
          this.toggleNerdStats();
          break;
        case "t":
        case "T":
          // T: Toggle timeline
          e.preventDefault();
          this.toggleTimeline();
          break;
        case "r":
        case "R":
          // R: Rotate video 90° (disabled during PiP)
          e.preventDefault();
          if (this.player && !this._pipWindow) {
            const deg = this.player.rotateVideo();
            this.showOSD(
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`,
              `${deg}°`,
            );
            const statusEl = this.shadowRoot?.querySelector(".movi-rotate-status");
            if (statusEl) statusEl.textContent = `${deg}°`;
            this.syncThumbnailRotation(deg);
          }
          break;
        case "a":
        case "A":
          // A: Cycle aspect ratio (contain → cover → fill)
          e.preventDefault();
          {
            const fits = ["contain", "cover", "fill", "zoom"] as const;
            const current = this._objectFit === "control" ? this._currentFit : this._objectFit;
            const idx = fits.indexOf(current as any);
            const next = fits[(idx + 1) % fits.length];
            if (this._objectFit === "control") {
              this._currentFit = next;
            } else {
              this._objectFit = next;
            }
            this.updateFitMode();
            this.updateAspectRatioIcon();
            const labels: Record<string, string> = { contain: "Fit", cover: "Fill", fill: "Stretch", zoom: "Zoom" };
            const osdSvg = MoviElement.ASPECT_ICONS[next] || MoviElement.ASPECT_ICONS.contain;
            this.showOSD(
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${osdSvg}</svg>`,
              labels[next],
            );
          }
          break;
        case "l":
        case "L":
          // L: Toggle loop
          e.preventDefault();
          this.loop = !this.loop;
          this.showOSD(
            OSD.loop,
            this.loop ? "Loop On" : "Loop Off",
          );
          break;
        case "v":
        case "V":
          // V: Cycle subtitle track (VLC standard) — external then muxed
          e.preventDefault();
          if (this.player) {
            const extSubs = this.player.getSubtitleLangs();
            const muxedSubs = this.player.getSubtitleTracks();
            const subOsdOn = OSD.subOn;
            const subOsdOff = OSD.subOff;

            if (extSubs.length > 0) {
              // Cycle through external subtitle tracks: off → lang1 → lang2 → ... → off
              const activeIdx = extSubs.findIndex((t) => t.active);
              if (activeIdx === -1) {
                // Currently off → select first
                this.player.selectSubtitleLang(extSubs[0].lang);
                this.showOSD(subOsdOn, `${extSubs[0].label} (1/${extSubs.length})`);
              } else if (activeIdx + 1 < extSubs.length) {
                // Next track
                const next = extSubs[activeIdx + 1];
                this.player.selectSubtitleLang(next.lang);
                this.showOSD(subOsdOn, `${next.label} (${activeIdx + 2}/${extSubs.length})`);
              } else {
                // Last → off
                this.player.selectSubtitleLang(null);
                this.showOSD(subOsdOff, "Subtitles Off");
              }
              this.updateSubtitleTrackMenu();
            } else if (muxedSubs.length > 0) {
              // Fallback: muxed subtitle tracks
              const active = this.player.trackManager.getActiveSubtitleTrack();
              const activeIdx = active ? muxedSubs.findIndex(t => t.id === active.id) : -1;
              const nextIdx = activeIdx + 1;
              if (nextIdx >= muxedSubs.length) {
                this.player.selectSubtitleTrack(null);
                this.showOSD(subOsdOff, "Subtitles Off");
              } else {
                const next = muxedSubs[nextIdx];
                this.player.selectSubtitleTrack(next.id);
                this.showOSD(subOsdOn, `${next.language?.toUpperCase() || "Sub"} (${nextIdx + 1}/${muxedSubs.length})`);
              }
              this.updateSubtitleTrackMenu();
            }
          }
          break;
        case "b":
        case "B":
          // B: Cycle audio track — muxed + external combined
          e.preventDefault();
          if (this.player) {
            const bMuxed = this.player.getAudioTracks();
            const bExternal = this.player.getAudioLangs();
            const bIcon = OSD.audio;

            // Build unified list: muxed first, then external
            type AudioEntry = { type: "muxed"; id: number; label: string } | { type: "ext"; lang: string; label: string };
            const allAudio: AudioEntry[] = [
              ...bMuxed.map((t) => ({ type: "muxed" as const, id: t.id, label: t.label || t.language || `Audio ${t.id}` })),
              ...bExternal.map((t) => ({ type: "ext" as const, lang: t.lang, label: t.label })),
            ];

            if (allAudio.length > 1) {
              // Find current active index
              const isNative = this.player.isNativeAudioActive();
              let curIdx = -1;
              if (isNative) {
                const activeLang = bExternal.find((t) => t.active)?.lang;
                curIdx = allAudio.findIndex((a) => a.type === "ext" && a.lang === activeLang);
              } else {
                const activeId = this.player.trackManager.getActiveAudioTrack()?.id;
                curIdx = allAudio.findIndex((a) => a.type === "muxed" && a.id === activeId);
              }
              const nextIdx = (curIdx + 1) % allAudio.length;
              const next = allAudio[nextIdx];

              if (next.type === "ext") {
                this.player.selectAudioLang(next.lang);
              } else {
                if (this.player.isNativeAudioActive()) this.player.useMuxedAudio();
                this.player.selectAudioTrack(next.id);
              }
              this.showOSD(bIcon, `${next.label} (${nextIdx + 1}/${allAudio.length})`);
              this.updateAudioTrackMenu();
            }
          }
          break;
        case "h":
        case "H":
          // H: Toggle HDR mode (only if content is HDR)
          e.preventDefault();
          {
            const hdrItem = this.shadowRoot?.querySelector('.movi-context-menu-item[data-action="hdr-toggle"]') as HTMLElement;
            if (hdrItem && hdrItem.style.display !== "none") {
              this.hdr = !this.hdr;
              this.showOSD(
                OSD.hdr,
                this.hdr ? "HDR On" : "HDR Off",
              );
            }
          }
          break;
        case "u":
        case "U":
          // U: Toggle stable volume
          e.preventDefault();
          if (this.player) {
            const current = this.player.getStableAudio();
            this.player.setStableAudio(!current);
            this.updateStableAudioUI(this.shadowRoot!);
            this.showOSD(
              OSD.stableAudio,
              !current ? "Stable Volume On" : "Stable Volume Off",
            );
          }
          break;
        case "g":
        case "G":
          // G: Toggle ambient mode
          e.preventDefault();
          this._ambientMode = !this._ambientMode;
          if (this._ambientMode) {
            this.setAttribute("ambientmode", "");
          } else {
            this.removeAttribute("ambientmode");
          }
          this.updateAmbientMode();
          this.updateAmbientUI();
          this.showOSD(
            OSD.ambient,
            this._ambientMode ? "Ambient Mode On" : "Ambient Mode Off",
          );
          break;
        case "=":
        case "+":
          // +: Speed up (VLC standard)
          e.preventDefault();
          {
            const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            const curIdx = speeds.findIndex(s => s >= this._playbackRate);
            const nextIdx = Math.min((curIdx === -1 ? 3 : curIdx) + 1, speeds.length - 1);
            this.playbackRate = speeds[nextIdx];
            this.showOSD(
              OSD.speed,
              `Speed ${this._playbackRate}x`,
            );
          }
          break;
        case "-":
          // -: Speed down (VLC standard)
          e.preventDefault();
          {
            const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            const curIdx = speeds.findIndex(s => s >= this._playbackRate);
            const nextIdx = Math.max((curIdx === -1 ? 3 : curIdx) - 1, 0);
            this.playbackRate = speeds[nextIdx];
            this.showOSD(
              OSD.speed,
              `Speed ${this._playbackRate}x`,
            );
          }
          break;
        case "?":
          // ?: Show keyboard shortcuts
          e.preventDefault();
          {
            const panel = this.shadowRoot?.querySelector(".movi-shortcuts-panel") as HTMLElement;
            if (panel) panel.style.display = panel.style.display === "none" ? "flex" : "none";
          }
          break;
        case "0":
          // 0: Seek to start
          e.preventDefault();
          this.currentTime = 0;
          this.showControls();
          break;
        case "Home":
          // Home: Seek to start
          e.preventDefault();
          this.currentTime = 0;
          this.showControls();
          break;
        case "End":
          // End: Seek to end
          e.preventDefault();
          this.currentTime = this.duration;
          this.showControls();
          break;
      }
    });

    // Make element focusable for keyboard shortcuts
    if (!this.hasAttribute("tabindex")) {
      this.setAttribute("tabindex", "0");
    }

    // Auto-focus on mouse enter so keyboard shortcuts work without clicking
    this.addEventListener("mouseenter", () => {
      this.focus();
    });
  }

  private setupContextMenu(shadowRoot: ShadowRoot): void {
    const contextMenu = shadowRoot.querySelector(
      ".movi-context-menu",
    ) as HTMLElement;
    if (!contextMenu) {
      Logger.error(
        TAG,
        "[ContextMenu] Context menu element not found in shadow root!",
      );
      return;
    }
    Logger.debug(TAG, "[ContextMenu] Context menu element found");

    this._contextMenuVisible = false;

    // Prevent default context menu on all elements
    const preventDefaultContextMenu = (e: MouseEvent) => {
      // If we are currently scrubbing/dragging, just kill the menu event silently
      if (this.isDragging || this.isTouchDragging) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }

      Logger.debug(TAG, "[ContextMenu] preventDefaultContextMenu called", {
        type: e.type,
        target: e.target,
        clientX: e.clientX,
        clientY: e.clientY,
      });

      // CRITICAL: Always prevent default FIRST, before any other logic
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Don't show on controls
      const target = e.target as Element;
      const shadowTarget = e.composedPath
        ? (e.composedPath()[0] as Element)
        : target;

      Logger.debug(TAG, "[ContextMenu] Checking target", {
        target: target?.tagName,
        shadowTarget: shadowTarget?.tagName,
        isInControls: shadowTarget?.closest(".movi-controls-container"),
        isInMenu: shadowTarget?.closest(".movi-context-menu"),
      });

      if (
        shadowTarget &&
        (shadowTarget.closest(".movi-controls-container") ||
          shadowTarget.closest(".movi-context-menu"))
      ) {
        Logger.debug(
          TAG,
          "[ContextMenu] Clicked on controls or menu, not showing menu",
        );
        return false;
      }

      Logger.debug(TAG, "[ContextMenu] Showing custom context menu");

      // Update context menu content before showing
      this.updateContextMenuContent(contextMenu, shadowRoot);

      // Show custom context menu
      const rect = this.getBoundingClientRect();
      const isMobile =
        window.innerWidth <= 1024 ||
        window.matchMedia("(pointer: coarse)").matches;

      if (isMobile) {
        contextMenu.classList.add("movi-context-menu-mobile");
        contextMenu.style.left = "";
        contextMenu.style.top = "";
        contextMenu.style.display = "flex";
        contextMenu.style.visibility = "visible";

        // Show backdrop
        const backdrop = shadowRoot.querySelector(
          ".movi-context-menu-backdrop",
        ) as HTMLElement;
        if (backdrop) backdrop.style.display = "block";

        // Ensure all submenus are hidden when opening main menu on mobile
        shadowRoot
          .querySelectorAll(
            ".movi-context-menu-submenu, .movi-context-menu-submenu-audio, .movi-context-menu-submenu-subtitle",
          )
          .forEach((sm) =>
            sm.classList.remove("movi-context-menu-submenu-visible"),
          );
      } else {
        contextMenu.classList.remove("movi-context-menu-mobile");
        const backdrop = shadowRoot.querySelector(
          ".movi-context-menu-backdrop",
        ) as HTMLElement;
        if (backdrop) backdrop.style.display = "none";
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;

        Logger.debug(TAG, "[ContextMenu] Initial position", {
          x,
          y,
          rectWidth: rect.width,
          rectHeight: rect.height,
        });

        // Temporarily show menu to get its dimensions
        contextMenu.style.display = "block";
        contextMenu.style.visibility = "hidden";
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        Logger.debug(TAG, "[ContextMenu] Menu dimensions", {
          menuWidth,
          menuHeight,
        });
        contextMenu.style.visibility = "visible";

        // Adjust horizontal position if menu would overflow
        if (x + menuWidth > rect.width) {
          x = rect.width - menuWidth - 10;
          Logger.debug(TAG, "[ContextMenu] Adjusted x to prevent overflow", {
            x,
          });
        }
        if (x < 10) {
          x = 10;
          Logger.debug(TAG, "[ContextMenu] Adjusted x to minimum", { x });
        }

        // Adjust vertical position if menu would overflow
        if (y + menuHeight > rect.height) {
          y = rect.height - menuHeight - 10;
          Logger.debug(TAG, "[ContextMenu] Adjusted y to prevent overflow", {
            y,
          });
        }
        if (y < 10) {
          y = 10;
          Logger.debug(TAG, "[ContextMenu] Adjusted y to minimum", { y });
        }

        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
      }

      // Delay adding visible class slightly to ensure transition works
      requestAnimationFrame(() => {
        contextMenu.classList.add("visible");
      });

      this._contextMenuVisible = true; // Refactored to use class property

      Logger.debug(TAG, "[ContextMenu] Menu positioned and shown", {
        left: contextMenu.style.left,
        top: contextMenu.style.top,
        display: contextMenu.style.display,
        visibility: contextMenu.style.visibility,
        computedDisplay: window.getComputedStyle(contextMenu).display,
        computedVisibility: window.getComputedStyle(contextMenu).visibility,
      });

      return false; // Return false to ensure preventDefault works
    };

    // Helper to hide context menu
    const hideContextMenu = () => {
      contextMenu.classList.remove("visible");
      this._contextMenuVisible = false;

      // Set just-closed flag to prevent play/pause toggle
      this._contextMenuJustClosed = true;
      setTimeout(() => {
        this._contextMenuJustClosed = false;
      }, 100);

      // Hide backdrop
      const backdrop = shadowRoot.querySelector(
        ".movi-context-menu-backdrop",
      ) as HTMLElement;
      if (backdrop) backdrop.style.display = "none";

      // On mobile, let transition finish before display none
      const isMobile =
        window.innerWidth <= 1024 ||
        window.matchMedia("(pointer: coarse)").matches;
      if (isMobile) {
        setTimeout(() => {
          if (!this._contextMenuVisible) contextMenu.style.display = "none";
        }, 400);
      } else {
        contextMenu.style.display = "none";
      }

      // Hide all submenus
      shadowRoot
        .querySelectorAll(
          ".movi-context-menu-submenu, .movi-context-menu-submenu-audio, .movi-context-menu-submenu-subtitle",
        )
        .forEach((sm) =>
          sm.classList.remove("movi-context-menu-submenu-visible"),
        );
    };

    // Add event listeners with capture phase and passive: false to allow preventDefault
    // Use capture phase to intercept before it reaches other handlers
    // Add to multiple elements to ensure we catch it everywhere
    const options = { capture: true, passive: false };

    Logger.debug(TAG, "[ContextMenu] Adding event listeners");
    this.addEventListener("contextmenu", preventDefaultContextMenu, options);
    Logger.debug(TAG, "[ContextMenu] Added listener to host element");

    this.canvas.addEventListener(
      "contextmenu",
      preventDefaultContextMenu,
      options,
    );
    Logger.debug(TAG, "[ContextMenu] Added listener to canvas");

    this.video.addEventListener(
      "contextmenu",
      preventDefaultContextMenu,
      options,
    );
    Logger.debug(TAG, "[ContextMenu] Added listener to video");

    const overlay = shadowRoot.querySelector(
      ".movi-controls-overlay",
    ) as HTMLElement;
    if (overlay) {
      overlay.addEventListener(
        "contextmenu",
        preventDefaultContextMenu,
        options,
      );
      Logger.debug(TAG, "[ContextMenu] Added listener to overlay");
    } else {
      Logger.warn(TAG, "[ContextMenu] Overlay element not found");
    }

    // Also prevent on subtitle overlay
    if (this.subtitleOverlay) {
      this.subtitleOverlay.addEventListener(
        "contextmenu",
        preventDefaultContextMenu,
        options,
      );
      Logger.debug(TAG, "[ContextMenu] Added listener to subtitle overlay");
    }

    // Also add to shadow root to catch events from all shadow DOM elements
    shadowRoot.addEventListener(
      "contextmenu",
      ((e: Event) => {
        Logger.debug(TAG, "[ContextMenu] Shadow root contextmenu event");
        const mouseEvent = e as MouseEvent;
        return preventDefaultContextMenu(mouseEvent);
      }) as EventListener,
      options,
    );
    Logger.debug(TAG, "[ContextMenu] Added listener to shadow root");

    // Add a document-level listener as a fallback (but only for clicks within this element)
    const documentContextMenuHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      Logger.debug(TAG, "[ContextMenu] Document contextmenu handler", {
        target: target,
        contains: this.contains(target),
        shadowContains: this.shadowRoot?.contains(target),
      });
      if (this.contains(target) || this.shadowRoot?.contains(target)) {
        // Call the main handler to show the menu
        Logger.debug(
          TAG,
          "[ContextMenu] Document handler calling preventDefaultContextMenu",
        );
        preventDefaultContextMenu(e);
        return false;
      }
      return false;
    };
    document.addEventListener("contextmenu", documentContextMenuHandler, {
      capture: true,
      passive: false,
    });
    Logger.debug(TAG, "[ContextMenu] Added document-level listener");

    // Also use oncontextmenu attribute on the element itself (most reliable)
    // This must also show the menu, not just prevent default
    this.oncontextmenu = (e: MouseEvent) => {
      Logger.debug(TAG, "[ContextMenu] oncontextmenu handler called");
      preventDefaultContextMenu(e);
      return false;
    };
    Logger.debug(TAG, "[ContextMenu] Set oncontextmenu handler");

    // Store handler for cleanup
    (this as any)._documentContextMenuHandler = documentContextMenuHandler;

    // Hide context menu on click outside
    document.addEventListener(
      "click",
      (e) => {
        if (!this._contextMenuVisible) return;

        // Use composedPath to get all elements in the event path (including shadow DOM)
        const path = e.composedPath ? e.composedPath() : [e.target];
        const isClickOnMenu = path.some((node) => {
          if (node === contextMenu) return true;
          if (
            node instanceof Element &&
            (node.classList.contains("movi-context-menu") ||
              node.closest(".movi-context-menu"))
          ) {
            return true;
          }
          return false;
        });

        Logger.debug(TAG, "[ContextMenu] Click outside check", {
          contextMenuVisible: this._contextMenuVisible,
          isClickOnMenu,
          pathLength: path.length,
          target: e.target,
        });

        // Hide if click is NOT on the menu
        if (!isClickOnMenu) {
          hideContextMenu(); // Used new local method
        }
      },
      true,
    );

    // Handle backdrop click to close menu
    const backdrop = shadowRoot.querySelector(
      ".movi-context-menu-backdrop",
    ) as HTMLElement;
    backdrop?.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      hideContextMenu(); // Used new local method
    });

    // Handle context menu item clicks
    contextMenu.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest(".movi-context-menu-item") as HTMLElement;
      if (!item) return;

      e.stopPropagation();
      e.preventDefault(); // Added e.preventDefault()

      const action = item.dataset.action;

      // Handle Back button for mobile submenus
      if (action === "back") {
        const submenu = item.closest(
          ".movi-context-menu-submenu, .movi-context-menu-submenu-audio, .movi-context-menu-submenu-subtitle",
        );
        if (submenu) {
          submenu.classList.remove("movi-context-menu-submenu-visible");
        }
        return;
      }

      const speed = item.dataset.speed;
      const audioTrackId = item.dataset.audioTrackId;
      const audioLang = item.dataset.audioLang;
      const subtitleTrackId = item.dataset.subtitleTrackId;
      const subtitleLang = item.dataset.subtitleLang;

      if (action === "play-pause") {
        if (this.player) {
          const state = this.player.getState();
          if (state === "playing" || state === "buffering") {
            this.pause();
          } else {
            this.play();
          }
        }
        hideContextMenu();
      } else if (action === "speed") {
        // Show speed submenu (changed from toggle to add)
        const submenu = shadowRoot.querySelector(
          '.movi-context-menu-submenu[data-submenu="speed"]',
        ) as HTMLElement;
        if (submenu) {
          contextMenu.scrollTop = 0;
          submenu.classList.add("movi-context-menu-submenu-visible");
        }
      } else if (action === "fit") {
        const submenu = shadowRoot.querySelector('.movi-context-menu-submenu[data-submenu="fit"]') as HTMLElement;
        if (submenu) {
          contextMenu.scrollTop = 0;
          submenu.classList.add("movi-context-menu-submenu-visible");
        }
      } else if (action === "audio-track") {
        // Show audio track submenu (changed from toggle to add)
        const submenu = shadowRoot.querySelector(
          ".movi-context-menu-submenu-audio",
        ) as HTMLElement;
        if (submenu) {
          contextMenu.scrollTop = 0;
          submenu.classList.add("movi-context-menu-submenu-visible");
        }
      } else if (audioLang !== undefined) {
        // Select native audio language track
        if (this.player) {
          const langTrack = this.player.getAudioLangs().find(t => t.lang === audioLang);
          this.player.selectAudioLang(audioLang);
          this.updateAudioTrackMenu();
          this.showOSD(
            OSD.audio,
            langTrack?.label || audioLang,
          );
        }
        hideContextMenu();
      } else if (audioTrackId !== undefined) {
        // Select muxed audio track
        const trackId = parseInt(audioTrackId);
        if (this.player) {
          if (this.player.isNativeAudioActive()) {
            this.player.useMuxedAudio();
          }
          this.player.selectAudioTrack(trackId);
          this.updateAudioTrackMenu();
          const trk = this.player.getAudioTracks().find(t => t.id === trackId);
          this.showOSD(
            OSD.audio,
            trk?.label || trk?.language || `Audio ${trackId}`,
          );
        }
        hideContextMenu();
      } else if (action === "subtitle-track") {
        // Show subtitle track submenu (changed from toggle to add)
        const submenu = shadowRoot.querySelector(
          ".movi-context-menu-submenu-subtitle",
        ) as HTMLElement;
        if (submenu) {
          contextMenu.scrollTop = 0;
          submenu.classList.add("movi-context-menu-submenu-visible");
        }
      } else if (subtitleLang !== undefined) {
        // Select external subtitle language
        if (this.player) {
          const subTrack = this.player.getSubtitleLangs().find(t => t.lang === subtitleLang);
          this.player.selectSubtitleLang(subtitleLang);
          this.updateSubtitleTrackMenu();
          this.showOSD(
            OSD.subOn,
            subTrack?.label || subtitleLang,
          );
        }
        hideContextMenu();
      } else if (subtitleTrackId !== undefined) {
        // Select muxed subtitle track
        const trackId = parseInt(subtitleTrackId);
        if (this.player) {
          const subOsdIcon = OSD.subOn;
          if (trackId === -1) {
            this.player.selectSubtitleTrack(null);
            this.player.selectSubtitleLang(null);
            this.showOSD(
              OSD.subOff,
              "Subtitles Off",
            );
          } else {
            this.player.selectSubtitleLang(null);
            this.player.selectSubtitleTrack(trackId);
            const trk = this.player.getSubtitleTracks().find(t => t.id === trackId);
            this.showOSD(subOsdIcon, trk?.label || trk?.language || `Subtitle ${trackId}`);
          }
        }
        hideContextMenu();
      } else if (speed) {
        // Set playback speed
        const playbackSpeed = parseFloat(speed);
        if (this.player) {
          this.player.setPlaybackRate(playbackSpeed);
          this._playbackRate = playbackSpeed;
          this.setAttribute("playbackrate", playbackSpeed.toString());
        }

        // Update active state
        contextMenu
          .querySelectorAll(".movi-context-menu-item[data-speed]")
          .forEach((el) => {
            el.classList.remove("movi-context-menu-active");
          });
        item.classList.add("movi-context-menu-active");

        this.showOSD(
          OSD.speed,
          `Speed ${playbackSpeed}x`,
        );
        hideContextMenu();
      } else if (item.dataset.fit) {
        const fitMode = item.dataset.fit as "contain" | "cover" | "fill" | "zoom";
        if (this._objectFit === "control") {
          this._currentFit = fitMode;
        } else {
          this._objectFit = fitMode;
        }
        this.updateFitMode();
        this.updateAspectRatioIcon();
        contextMenu.querySelectorAll(".movi-context-menu-item[data-fit]").forEach((el) => {
          el.classList.remove("movi-context-menu-active");
        });
        item.classList.add("movi-context-menu-active");
        // Update the new context menu status too
        const aspectStatus = shadowRoot.querySelector(".movi-aspect-status");
        if (aspectStatus) {
          const labels: Record<string, string> = { contain: "Fit", cover: "Fill", fill: "Stretch", zoom: "Zoom" };
          aspectStatus.textContent = labels[fitMode] || fitMode;
        }
        hideContextMenu();
      } else if (action === "hdr-toggle") {
        this.hdr = !this.hdr;
        this.showOSD(
          OSD.hdr,
          this.hdr ? "HDR On" : "HDR Off",
        );
        hideContextMenu();
      } else if (action === "rotate-video") {
        if (this.player && !this._pipWindow) {
          const deg = this.player.rotateVideo();
          const statusEl = shadowRoot.querySelector(".movi-rotate-status");
          if (statusEl) statusEl.textContent = `${deg}°`;
          this.syncThumbnailRotation(deg);
          this.showOSD(
            OSD.rotate,
            `Rotate ${deg}°`,
          );
        }
        hideContextMenu();
      } else if (action === "loop-toggle") {
        this.loop = !this.loop;
        this.showOSD(
          OSD.loop,
          this.loop ? "Loop On" : "Loop Off",
        );
        hideContextMenu();
      } else if (action === "stable-audio-toggle") {
        if (this.player) {
          const current = this.player.getStableAudio();
          this.player.setStableAudio(!current);
          this.updateStableAudioUI(shadowRoot);
          this.showOSD(
            OSD.stableAudio,
            !current ? "Stable Volume On" : "Stable Volume Off",
          );
        }
        hideContextMenu();
      } else if (action === "ambient-toggle") {
        this._ambientMode = !this._ambientMode;
        if (this._ambientMode) {
          this.setAttribute("ambientmode", "");
        } else {
          this.removeAttribute("ambientmode");
        }
        this.updateAmbientMode();
        this.updateAmbientUI();
        this.showOSD(
          OSD.ambient,
          this._ambientMode ? "Ambient Mode On" : "Ambient Mode Off",
        );
        hideContextMenu();
      } else if (action === "nerd-stats") {
        this.toggleNerdStats(shadowRoot);
        hideContextMenu();
      } else if (action === "timeline") {
        this.toggleTimeline();
        hideContextMenu();
      } else if (action === "pip") {
        this.togglePiP();
        hideContextMenu();
      } else if (action === "fullscreen") {
        this.toggleFullscreen();
        hideContextMenu();
      } else if (action === "snapshot") {
        this.takeSnapshot();
        this.showOSD(
          OSD.snapshot,
          "Snapshot",
        );
        hideContextMenu();
      }
    });

    // Handle hover for submenu
    const speedItem = contextMenu.querySelector(
      '.movi-context-menu-item[data-action="speed"]',
    ) as HTMLElement;
    const speedSubmenu = shadowRoot.querySelector(
      '.movi-context-menu-submenu[data-submenu="speed"]',
    ) as HTMLElement;

    // Simplified speed submenu setup using shared handler
    if (speedItem && speedSubmenu) {
      this.setupSubmenuHover(speedItem, speedSubmenu);
    }

    // Audio and subtitle track hover handlers will be set up dynamically in updateContextMenuContent
    // when the items are shown, to avoid issues with hidden elements

    // Fit submenu hover handler
    const fitItem = contextMenu.querySelector(
      '.movi-context-menu-item[data-action="fit"]',
    ) as HTMLElement;
    const fitSubmenu = shadowRoot.querySelector(
      '.movi-context-menu-submenu[data-submenu="fit"]',
    ) as HTMLElement;
    if (fitItem && fitSubmenu) {
      this.setupSubmenuHover(fitItem, fitSubmenu);
    }
  }

  private updateContextMenuContent(
    contextMenu: HTMLElement,
    shadowRoot: ShadowRoot,
  ): void {
    if (!this.player) return;

    // Update Play/Pause text based on current state
    const playPauseItem = contextMenu.querySelector(
      '.movi-context-menu-item[data-action="play-pause"]',
    ) as HTMLElement;
    const playPauseLabel = playPauseItem?.querySelector(
      ".movi-context-menu-label",
    ) as HTMLElement;
    if (playPauseLabel) {
      const state = this.player.getState();
      playPauseLabel.textContent = state === "playing" ? "Pause" : "Play";
    }

    // Update audio tracks
    const audioTracks = this.player.getAudioTracks();
    const activeAudioTrack = this.player.trackManager.getActiveAudioTrack();
    const audioDivider = contextMenu.querySelector(
      ".movi-context-menu-divider-audio",
    ) as HTMLElement;
    const audioItem = contextMenu.querySelector(
      ".movi-context-menu-item-audio",
    ) as HTMLElement;
    const audioSubmenu = shadowRoot.querySelector(
      ".movi-context-menu-submenu-audio",
    ) as HTMLElement;

    const nativeLangs = this.player.getAudioLangs();
    const ctxIsNativeActive = this.player.isNativeAudioActive();
    const totalAudioTracks = audioTracks.length + nativeLangs.length;

    if (totalAudioTracks > 1 && audioDivider && audioItem && audioSubmenu) {
      audioDivider.style.display = "block";
      audioItem.style.display = "flex";
      audioSubmenu.style.removeProperty("display");

      let html = "";
      if (
        window.innerWidth <= 1024 ||
        window.matchMedia("(pointer: coarse)").matches
      ) {
        html += `<div class="movi-context-menu-item movi-context-menu-back" data-action="back">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          <span class="movi-context-menu-label">Back</span>
        </div>`;
      }

      // Muxed audio tracks
      if (audioTracks.length > 0) {
        html += audioTracks
          .map((track) => {
            const isActive = !ctxIsNativeActive && activeAudioTrack?.id === track.id;
            const label = track.label || `Audio ${track.id}`;
            const infoParts: string[] = [];
            if (track.language) {
              const langCode = track.language.length >= 2
                ? track.language.substring(0, 3).toUpperCase()
                : track.language.toUpperCase();
              infoParts.push(langCode);
            }
            if (track.channels) infoParts.push(`${track.channels}ch`);
            const info = infoParts.length > 0 ? ` (${infoParts.join(" • ")})` : "";
            const activeClass = isActive ? " movi-context-menu-active" : "";
            return `<div class="movi-context-menu-item${activeClass}" data-audio-track-id="${track.id}">${label}${info}</div>`;
          })
          .join("");
      }

      // External audio tracks
      if (nativeLangs.length > 0) {
        html += nativeLangs
          .map((t) => {
            const activeClass = t.active ? " movi-context-menu-active" : "";
            return `<div class="movi-context-menu-item${activeClass}" data-audio-lang="${t.lang}">${t.label} (${t.lang.toUpperCase()})</div>`;
          })
          .join("");
      }

      audioSubmenu.innerHTML = html;

      // Setup hover handlers for audio track submenu
      this.setupSubmenuHover(audioItem, audioSubmenu);
    } else {
      if (audioDivider) audioDivider.style.display = "none";
      if (audioItem) audioItem.style.display = "none";
      if (audioSubmenu) audioSubmenu.style.display = "none";
    }

    // Update subtitle tracks
    const subtitleTracks = this.player.getSubtitleTracks();
    const activeSubtitleTrack =
      this.player.trackManager.getActiveSubtitleTrack();
    const ctxExternalSubs = this.player.getSubtitleLangs();
    const ctxAnyExternalSubActive = ctxExternalSubs.some((t) => t.active);
    const subtitleDivider = contextMenu.querySelector(
      ".movi-context-menu-divider-subtitle",
    ) as HTMLElement;
    const subtitleItem = contextMenu.querySelector(
      ".movi-context-menu-item-subtitle",
    ) as HTMLElement;
    const subtitleSubmenu = shadowRoot.querySelector(
      ".movi-context-menu-submenu-subtitle",
    ) as HTMLElement;

    if (
      (subtitleTracks.length > 0 || ctxExternalSubs.length > 0) &&
      subtitleDivider &&
      subtitleItem &&
      subtitleSubmenu
    ) {
      subtitleDivider.style.display = "block";
      subtitleItem.style.display = "flex";
      subtitleSubmenu.style.removeProperty("display");

      // Update Context Menu Icon
      const contextMenuSubtitleIcon = subtitleItem.querySelector(
        "svg:not(.movi-context-menu-subtitle-filled)",
      ) as HTMLElement;
      const contextMenuSubtitleFilledIcon = subtitleItem.querySelector(
        ".movi-context-menu-subtitle-filled",
      ) as HTMLElement;

      const ctxSubActive = activeSubtitleTrack !== null || ctxAnyExternalSubActive;
      if (ctxSubActive) {
        if (contextMenuSubtitleIcon) contextMenuSubtitleIcon.style.display = "none";
        if (contextMenuSubtitleFilledIcon) contextMenuSubtitleFilledIcon.style.display = "block";
      } else {
        if (contextMenuSubtitleIcon) contextMenuSubtitleIcon.style.display = "block";
        if (contextMenuSubtitleFilledIcon) contextMenuSubtitleFilledIcon.style.display = "none";
      }

      const ctxOffActive = !activeSubtitleTrack && !ctxAnyExternalSubActive;
      let html = "";
      if (
        window.innerWidth <= 1024 ||
        window.matchMedia("(pointer: coarse)").matches
      ) {
        html += `<div class="movi-context-menu-item movi-context-menu-back" data-action="back">
          <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          <span class="movi-context-menu-label">Back</span>
        </div>`;
      }
      html += `<div class="movi-context-menu-item${ctxOffActive ? " movi-context-menu-active" : ""}" data-subtitle-track-id="-1">Off</div>`;

      // Muxed subtitle tracks
      html += subtitleTracks
        .map((track) => {
          const isActive = activeSubtitleTrack?.id === track.id;
          const label = track.label || track.language || `Subtitle ${track.id}`;
          const infoParts: string[] = [];

          if (track.language && !track.label) {
            const langCode =
              track.language.length >= 2
                ? track.language.substring(0, 3).toUpperCase()
                : track.language.toUpperCase();
            infoParts.push(langCode);
          }

          const info =
            infoParts.length > 0 ? ` (${infoParts.join(" • ")})` : "";
          const activeClass = isActive ? " movi-context-menu-active" : "";

          return `<div class="movi-context-menu-item${activeClass}" data-subtitle-track-id="${track.id}">${label}${info}</div>`;
        })
        .join("");

      // External subtitle tracks
      html += ctxExternalSubs
        .map((t) => {
          const activeClass = t.active ? " movi-context-menu-active" : "";
          return `<div class="movi-context-menu-item${activeClass}" data-subtitle-lang="${t.lang}">${t.label} (${t.lang.toUpperCase()})</div>`;
        })
        .join("");

      subtitleSubmenu.innerHTML = html;

      this.setupSubmenuHover(subtitleItem, subtitleSubmenu);
    } else {
      if (subtitleDivider) subtitleDivider.style.display = "none";
      if (subtitleItem) subtitleItem.style.display = "none";
      if (subtitleSubmenu) subtitleSubmenu.style.display = "none";
    }

    // Update HDR visibility/state in context menu
    this.updateHDRVisibility();

    // Update active state for Fit mode
    const currentActiveFit =
      this._objectFit === "control" ? this._currentFit : this._objectFit;
    const fitItems = contextMenu.querySelectorAll(
      ".movi-context-menu-item[data-fit]",
    );
    fitItems.forEach((item) => {
      const fit = (item as HTMLElement).dataset.fit;
      if (fit === currentActiveFit) {
        item.classList.add("movi-context-menu-active");
      } else {
        item.classList.remove("movi-context-menu-active");
      }
    });

    // Disable rotate during PiP
    const rotateItem = contextMenu.querySelector('.movi-context-menu-item[data-action="rotate-video"]');
    if (rotateItem) {
      rotateItem.classList.toggle("movi-context-menu-disabled", !!this._pipWindow);
    }
  }

  private setupSubmenuHover(item: HTMLElement, submenu: HTMLElement): void {
    // Check if listeners are already attached (using a data attribute)
    if (item.dataset.hoverSetup === "true") {
      return; // Already set up
    }

    // Mark as set up
    item.dataset.hoverSetup = "true";

    let hideTimeout: number | null = null;

    const showSubmenu = () => {
      // Clear any pending hide timeout
      if (hideTimeout !== null) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      // Position submenu to align with parent item
      const contextMenu = item.closest(".movi-context-menu") as HTMLElement;
      if (contextMenu) {
        const itemRect = item.getBoundingClientRect();
        const menuRect = contextMenu.getBoundingClientRect();
        const topOffset = itemRect.top - menuRect.top;
        submenu.style.top = `${topOffset}px`;

        // Intelligent positioning
        const playerRect = this.getBoundingClientRect();
        const submenuWidth = submenu.offsetWidth || 160;
        const padding = 10;

        const spaceOnRight = playerRect.right - menuRect.right;
        const spaceOnLeft = menuRect.left - playerRect.left;

        if (spaceOnRight >= submenuWidth + padding) {
          // 1. Show on RIGHT (Preferred)
          submenu.style.left = "100%";
          submenu.style.right = "auto";
          submenu.style.marginLeft = "4px";
          submenu.style.marginRight = "0";
          submenu.style.transform = "translateX(-8px)";
        } else if (spaceOnLeft >= submenuWidth + padding) {
          // 2. Show on LEFT
          submenu.style.left = "auto";
          submenu.style.right = "100%";
          submenu.style.marginLeft = "0";
          submenu.style.marginRight = "4px";
          submenu.style.transform = "translateX(8px)";
        } else {
          // 3. OVERLAP (Mobile/Tight Space) - "Stack" it
          submenu.style.left = "20px"; // Slight offset to show depth
          submenu.style.right = "auto";
          submenu.style.marginLeft = "0";
          submenu.style.marginRight = "0";
          submenu.style.transform = "translateY(10px)"; // Slide up slightly
        }

        // Vertical positioning: Check if there's space on the bottom
        // We need to make the element temporarily visible to measure it if it's hidden
        const wasClassVisible = submenu.classList.contains(
          "movi-context-menu-submenu-visible",
        );

        // Force layout for measurement
        if (!wasClassVisible) {
          submenu.style.visibility = "hidden";
          submenu.style.display = "block";
        }

        // Now measure
        const submenuRect = submenu.getBoundingClientRect();

        // Restore
        if (!wasClassVisible) {
          submenu.style.display = "";
          submenu.style.visibility = "";
        }

        // submenuRect.top is currently based on the initial top assignment
        // The absolute top relative to viewport would be menuRect.top + topOffset
        const currentAbsTop = menuRect.top + topOffset;

        // Check if the bottom of the submenu would be below the player bottom
        if (currentAbsTop + submenuRect.height > playerRect.bottom - 10) {
          // It overflows! Shift it up.
          // New top relative to menu parent:
          // We want bottom of submenu to be at playerRect.bottom - 10
          // So top = (playerRect.bottom - 10) - height - menuRect.top
          let newTop =
            playerRect.bottom - 10 - submenuRect.height - menuRect.top;

          // Ensure we don't go off the top either
          if (menuRect.top + newTop < playerRect.top + 10) {
            newTop = playerRect.top + 10 - menuRect.top;
          }

          submenu.style.top = `${newTop}px`;
        }
      }

      submenu.classList.add("movi-context-menu-submenu-visible");
    };

    const hideSubmenu = () => {
      submenu.classList.remove("movi-context-menu-submenu-visible");
    };

    const scheduleHide = () => {
      // Clear any existing timeout
      if (hideTimeout !== null) {
        clearTimeout(hideTimeout);
      }
      // Add a small delay to allow mouse to move to submenu
      hideTimeout = window.setTimeout(() => {
        hideSubmenu();
        hideTimeout = null;
      }, 150); // 150ms delay
    };

    // Setup listeners - ONLY on desktop (hover doesn't make sense on mobile and causes double-tap issues)
    const isMobile =
      window.innerWidth <= 1024 ||
      window.matchMedia("(pointer: coarse)").matches;

    if (!isMobile) {
      item.addEventListener("mouseenter", showSubmenu);

      item.addEventListener("mouseleave", (e) => {
        const relatedTarget = e.relatedTarget as Node;
        // Check if mouse is moving to submenu
        if (!submenu.contains(relatedTarget) && relatedTarget !== submenu) {
          scheduleHide();
        }
      });

      // When mouse enters submenu, cancel hide and show it
      submenu.addEventListener("mouseenter", () => {
        if (hideTimeout !== null) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        showSubmenu();
      });

      submenu.addEventListener("mouseleave", (e) => {
        const relatedTarget = e.relatedTarget as Node;
        // Check if mouse is moving back to parent item
        if (!item.contains(relatedTarget) && relatedTarget !== item) {
          scheduleHide();
        }
      });
    }
  }

  private async toggleFullscreen(): Promise<void> {
    if (this.isLoading || this._isUnsupported || !this.player) {
      return;
    }
    try {
      if (!document.fullscreenElement) {
        await this.requestFullscreen();
        this.updateFullscreenIcon(true);
      } else {
        await document.exitFullscreen();
        this.updateFullscreenIcon(false);
      }
    } catch (error) {
      Logger.error(TAG, "Failed to toggle fullscreen", error);
    }
  }

  private _pipWindow: Window | null = null;

  private restorePiPCanvas(): void {
    Logger.info(TAG, `restorePiPCanvas called — _pipWindow: ${!!this._pipWindow}, canvas: ${!!this.canvas}, shadowRoot: ${!!this.shadowRoot}`);
    if (!this._pipWindow) {
      Logger.info(TAG, "restorePiPCanvas: already restored, skipping");
      return;
    }
    this._pipWindow = null;
    if (this.player) this.player.isPiPActive = false;

    const canvas = this.canvas;
    const sr = this.shadowRoot;
    if (!canvas || !sr) {
      Logger.warn(TAG, `restorePiPCanvas: missing canvas=${!!canvas} shadowRoot=${!!sr}`);
      return;
    }

    // Always move canvas back to shadowRoot as first child (original position)
    if (canvas.parentNode !== sr) {
      sr.insertBefore(canvas, sr.firstChild);
      Logger.info(TAG, "restorePiPCanvas: moved canvas back to shadowRoot");
    } else {
      Logger.info(TAG, "restorePiPCanvas: canvas already in shadowRoot");
    }

    Logger.info(TAG, `restorePiPCanvas: canvas isConnected=${canvas.isConnected}`);

    // Restore original size
    requestAnimationFrame(() => {
      this.updateCanvasSize();
      Logger.info(TAG, `restorePiPCanvas: after resize — ${this.canvas?.width}x${this.canvas?.height}`);
    });
    Logger.info(TAG, "PiP closed, canvas restored");
  }

  private async togglePiP(): Promise<void> {
    if (!this.player || !this.canvas) return;

    const docPiP = (window as any).documentPictureInPicture;
    if (!docPiP) return;

    // If already in PiP, close it and restore immediately
    if (this._pipWindow) {
      Logger.info(TAG, "togglePiP: closing PiP, restoring canvas first");
      const win = this._pipWindow;
      this.restorePiPCanvas();
      try { win.close(); } catch (_) {}
      Logger.info(TAG, "togglePiP: PiP window closed");
      return;
    }

    try {
      const videoTrack = this.player.getVideoTracks()?.[0];
      const vw = videoTrack?.width || 640;
      const vh = videoTrack?.height || 360;
      const savedRotation = this.player.getVideoRotation();
      // PiP always shows original (unrotated) video
      const aspect = vw / vh;
      const maxW = Math.min(400, window.innerWidth * 0.35);
      const maxH = Math.min(500, window.innerHeight * 0.5);
      let pipWidth: number, pipHeight: number;
      if (aspect >= 1) {
        pipWidth = maxW;
        pipHeight = Math.round(maxW / aspect);
      } else {
        pipHeight = maxH;
        pipWidth = Math.round(maxH * aspect);
      }
      // Reset rotation for PiP (restore on close)
      if (savedRotation !== 0) {
        this.player.setVideoRotation(0);
      }

      const pipWindow: Window = await docPiP.requestWindow({
        width: Math.round(pipWidth),
        height: Math.round(pipHeight),
      });
      this._pipWindow = pipWindow;

      // Chrome may ignore requestWindow size (remembers last PiP size), force resize
      try {
        const chromeW = pipWindow.outerWidth - pipWindow.innerWidth;
        const chromeH = pipWindow.outerHeight - pipWindow.innerHeight;
        pipWindow.resizeTo(Math.round(pipWidth) + chromeW, Math.round(pipHeight) + chromeH);
      } catch {};

      // Style the PiP window
      const style = pipWindow.document.createElement("style");
      style.textContent = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; overflow: hidden; width: 100%; height: 100%; position: relative; }
        canvas { width: 100%; height: 100%; object-fit: contain; display: block; }
        .pip-controls {
          position: absolute; bottom: 0; left: 0; right: 0;
          background: linear-gradient(transparent, rgba(0,0,0,0.85));
          padding: 8px 10px 6px; display: flex; flex-direction: column; gap: 4px;
          opacity: 0; transition: opacity 0.2s;
        }
        body:hover .pip-controls, body.show-controls .pip-controls { opacity: 1; }
        .pip-progress-row { display: flex; flex-direction: column; gap: 4px; }
        .pip-progress-bar {
          width: 100%; height: 3px; background: rgba(255,255,255,0.2);
          border-radius: 2px; cursor: pointer; position: relative;
        }
        .pip-progress-bar:hover { height: 5px; }
        .pip-progress-fill {
          height: 100%; background: #8B5CF6; border-radius: 2px;
          width: 0%; pointer-events: none;
        }
        .pip-time { font: 500 10px/1 -apple-system, sans-serif; color: rgba(255,255,255,0.7); white-space: nowrap; }
        .pip-time-row { display: flex; justify-content: space-between; padding: 0 2px; }
        .pip-btn-row { display: flex; align-items: center; justify-content: center; gap: 16px; position: relative; }
        .pip-btn {
          background: none; border: none; cursor: pointer; padding: 4px;
          color: #fff; opacity: 0.85; display: flex; align-items: center; justify-content: center;
        }
        .pip-btn:hover { opacity: 1; }
        .pip-btn svg { width: 20px; height: 20px; }
        .pip-btn.play-pause svg { width: 26px; height: 26px; }
        .pip-btn.mute-toggle { position: absolute; left: 0; }
        .pip-btn.mute-toggle svg { width: 18px; height: 18px; }
        .pip-btn.back-to-tab { position: absolute; right: 0; }
        .pip-btn.back-to-tab svg { width: 18px; height: 18px; }
      `;
      pipWindow.document.head.appendChild(style);

      // Move canvas to PiP window
      pipWindow.document.body.appendChild(this.canvas);
      Logger.info(TAG, `PiP: canvas moved to PiP window, isConnected=${this.canvas.isConnected}`);

      // Build PiP controls
      const controls = pipWindow.document.createElement("div");
      controls.className = "pip-controls";

      // Progress row
      const progressRow = pipWindow.document.createElement("div");
      progressRow.className = "pip-progress-row";
      const timeRow = pipWindow.document.createElement("div");
      timeRow.className = "pip-time-row";
      const timeCurrent = pipWindow.document.createElement("div");
      timeCurrent.className = "pip-time";
      timeCurrent.textContent = "00:00";
      const timeDuration = pipWindow.document.createElement("div");
      timeDuration.className = "pip-time";
      timeDuration.textContent = "00:00";
      timeRow.appendChild(timeCurrent);
      timeRow.appendChild(timeDuration);
      const progressBar = pipWindow.document.createElement("div");
      progressBar.className = "pip-progress-bar";
      const progressFill = pipWindow.document.createElement("div");
      progressFill.className = "pip-progress-fill";
      progressBar.appendChild(progressFill);
      progressRow.appendChild(timeRow);
      progressRow.appendChild(progressBar);

      // Button row
      const btnRow = pipWindow.document.createElement("div");
      btnRow.className = "pip-btn-row";

      const makeBtn = (cls: string, svg: string) => {
        const btn = pipWindow.document.createElement("button");
        btn.className = `pip-btn ${cls}`;
        btn.innerHTML = svg;
        return btn;
      };

      const seekBackBtn = makeBtn("seek-back", `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 3C7.81 3 4.01 6.54 3.58 11H1l3.5 4L8 11H5.59c.42-3.35 3.33-6 6.91-6 3.87 0 7 3.13 7 7s-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.96 8.96 0 0012.5 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/><text x="12.5" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" font-family="-apple-system,sans-serif">10</text></svg>`);
      const playPauseBtn = makeBtn("play-pause", this.player.getState() === "playing"
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`);
      const seekFwdBtn = makeBtn("seek-fwd", `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.5 3c4.69 0 8.49 3.54 8.92 8H23l-3.5 4L16 11h2.41c-.42-3.35-3.33-6-6.91-6-3.87 0-7 3.13-7 7s3.13 7 7 7c1.93 0 3.68-.79 4.94-2.06l1.42 1.42A8.96 8.96 0 0111.5 21c-4.97 0-9-4.03-9-9s4.03-9 9-9z"/><text x="11.5" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" font-family="-apple-system,sans-serif">10</text></svg>`);
      const backToTabBtn = makeBtn("back-to-tab", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`);
      const isMuted = this._muted;
      const muteBtn = makeBtn("mute-toggle", isMuted
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`);

      btnRow.appendChild(muteBtn);
      btnRow.appendChild(seekBackBtn);
      btnRow.appendChild(playPauseBtn);
      btnRow.appendChild(seekFwdBtn);
      btnRow.appendChild(backToTabBtn);

      controls.appendChild(progressRow);
      controls.appendChild(btnRow);
      pipWindow.document.body.appendChild(controls);

      // PiP control handlers
      const updatePlayPauseIcon = () => {
        if (!this.player) return;
        const isPlaying = this.player.getState() === "playing";
        playPauseBtn.innerHTML = isPlaying
          ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
      };

      playPauseBtn.addEventListener("click", () => {
        if (!this.player) return;
        const pipPlayState = this.player.getState();
        if (pipPlayState === "playing" || pipPlayState === "buffering") this.pause();
        else this.play();
      });

      seekBackBtn.addEventListener("click", () => {
        if (!this.player) return;
        this.currentTime = Math.max(0, this.currentTime - 10);
      });

      seekFwdBtn.addEventListener("click", () => {
        if (!this.player) return;
        this.currentTime = Math.min(this.duration, this.currentTime + 10);
      });

      backToTabBtn.addEventListener("click", () => {
        this.togglePiP();
      });

      muteBtn.addEventListener("click", () => {
        this.muted = !this.muted;
        this.showOSD(
          this.muted
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
          this.muted ? "Muted" : "Unmuted",
        );
      });

      // Progress bar seek
      progressBar.addEventListener("click", (e: MouseEvent) => {
        if (!this.player || !this.duration) return;
        const rect = progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.currentTime = pct * this.duration;
      });

      // Update progress + time on interval
      const pipUpdateInterval = setInterval(() => {
        if (!this._pipWindow || !this.player) { clearInterval(pipUpdateInterval); return; }
        const cur = this.currentTime;
        const dur = this.duration || 0;
        const pct = dur > 0 ? (cur / dur) * 100 : 0;
        progressFill.style.width = `${pct}%`;
        timeCurrent.textContent = this.formatTime(cur);
        timeDuration.textContent = this.formatTime(dur);
        updatePlayPauseIcon();
        const muted = this._muted;
        muteBtn.innerHTML = muted
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
      }, 250);

      // Show controls briefly on open
      pipWindow.document.body.classList.add("show-controls");
      setTimeout(() => pipWindow.document.body.classList.remove("show-controls"), 2000);

      // Keyboard shortcuts in PiP window
      pipWindow.document.addEventListener("keydown", (e: KeyboardEvent) => {
        if (!this.player) return;
        if (e.key === " " || e.key === "k") {
          e.preventDefault();
          const pipState = this.player.getState();
          if (pipState === "playing" || pipState === "buffering") this.pause();
          else this.play();
        } else if (e.key === "ArrowLeft") {
          this.currentTime = Math.max(0, this.currentTime - 10);
        } else if (e.key === "ArrowRight") {
          this.currentTime = Math.min(this.duration, this.currentTime + 10);
        } else if (e.key === "m") {
          muteBtn.click();
        } else if (e.key === "Escape" || e.key === "p") {
          this.togglePiP();
        }
      });

      // Mark PiP active so background handler doesn't drop frames
      this.player.isPiPActive = true;

      // Resize canvas to fit PiP window
      const resizeInPiP = () => {
        if (this._pipWindow && this.player) {
          this.player.resizeCanvas(pipWindow.innerWidth, pipWindow.innerHeight);
        }
      };
      pipWindow.addEventListener("resize", resizeInPiP);
      resizeInPiP();

      // Handle PiP window close — move canvas back
      const restore = (e: Event) => {
        Logger.info(TAG, `PiP event: ${e.type} fired`);
        clearInterval(pipUpdateInterval);
        this.restorePiPCanvas();
        // Restore rotation
        if (savedRotation !== 0 && this.player) {
          requestAnimationFrame(() => this.player?.setVideoRotation(savedRotation));
        }
      };
      pipWindow.addEventListener("pagehide", restore);
      pipWindow.addEventListener("unload", restore);

      Logger.info(TAG, `PiP opened: ${Math.round(pipWidth)}x${pipHeight}`);
    } catch (error) {
      Logger.error(TAG, "Failed to open PiP", error);
      this._pipWindow = null;
    }
  }

  private updateFullscreenIcon(isFullscreen: boolean): void {
    const fullscreenIcon = this.shadowRoot?.querySelector(
      ".movi-icon-fullscreen",
    ) as HTMLElement;
    const fullscreenExitIcon = this.shadowRoot?.querySelector(
      ".movi-icon-fullscreen-exit",
    ) as HTMLElement;

    if (isFullscreen) {
      fullscreenIcon?.style.setProperty("display", "none");
      fullscreenExitIcon?.style.setProperty("display", "block");
    } else {
      fullscreenIcon?.style.setProperty("display", "block");
      fullscreenExitIcon?.style.setProperty("display", "none");
    }
  }

  private static readonly ASPECT_ICONS: Record<string, string> = {
    contain: `<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="6" y="8" width="12" height="8" rx="1"/>`,
    cover: `<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="1" y="7" width="22" height="10" rx="1"/>`,
    fill: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 3h18v18H3z"/>`,
    zoom: `<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/>`,
  };

  private updateAspectRatioIcon(): void {
    const icon = this.shadowRoot?.querySelector(".movi-icon-aspect-ratio") as SVGElement;
    if (!icon) return;

    const fit = this._objectFit === "control" ? this._currentFit : (this._objectFit as any);
    const svg = MoviElement.ASPECT_ICONS[fit] || MoviElement.ASPECT_ICONS.contain;
    icon.innerHTML = svg;
  }

  private updateAudioTrackMenu(): void {
    if (!this.player) return;

    const audioTrackList = this.shadowRoot?.querySelector(
      ".movi-audio-track-list",
    ) as HTMLElement;
    const audioTrackBtn = this.shadowRoot?.querySelector(
      ".movi-audio-track-btn",
    ) as HTMLElement;
    const audioTrackContainer = this.shadowRoot?.querySelector(
      ".movi-audio-track-container",
    ) as HTMLElement;
    if (!audioTrackList || !audioTrackBtn || !audioTrackContainer) return;

    const nativeLangs = this.player.getAudioLangs();
    const audioTracks = this.player.getAudioTracks();
    const activeTrack = this.player.trackManager.getActiveAudioTrack();
    const isNativeActive = this.player.isNativeAudioActive();
    const totalTracks = audioTracks.length + nativeLangs.length;

    // Volume is always visible when any audio exists
    const volumeContainer = this.shadowRoot?.querySelector(
      ".movi-volume-container",
    ) as HTMLElement;
    if (volumeContainer) {
      volumeContainer.style.display = totalTracks > 0 ? "flex" : "none";
    }

    // Show audio selector only if multiple tracks total
    if (totalTracks <= 1) {
      audioTrackContainer.style.display = "none";
      return;
    }

    audioTrackContainer.style.display = "flex";
    audioTrackBtn.style.display = "flex";

    // Build combined menu — muxed tracks first, then external
    let menuHTML = "";

    // Muxed audio tracks (from MKV/MP4 demuxer)
    menuHTML += audioTracks
      .map((track) => {
        // Muxed track is active only when native audio is NOT active
        const isActive = !isNativeActive && activeTrack?.id === track.id;
        const label = track.label || `Audio ${track.id}`;
        const infoParts: string[] = [];

        if (track.language) {
          const langCode =
            track.language.length >= 2
              ? track.language.substring(0, 3).toUpperCase()
              : track.language.toUpperCase();
          infoParts.push(langCode);
        }
        if (track.channels) {
          infoParts.push(`${track.channels}ch`);
        }

        const info = infoParts.length > 0 ? infoParts.join(" • ") : "";

        return `
        <div class="movi-audio-track-item ${isActive ? "movi-audio-track-active" : ""}"
             data-track-id="${track.id}">
          <span class="movi-audio-track-label">${label}</span>
          ${info ? `<span class="movi-audio-track-info">${info}</span>` : ""}
        </div>`;
      })
      .join("");

    // External audio tracks (native <audio> element)
    menuHTML += nativeLangs
      .map((t) => `
        <div class="movi-audio-track-item ${t.active ? "movi-audio-track-active" : ""}"
             data-audio-lang="${t.lang}">
          <span class="movi-audio-track-label">${t.label}</span>
          <span class="movi-audio-track-info">${t.lang.toUpperCase()}</span>
        </div>`)
      .join("");

    audioTrackList.innerHTML = menuHTML;

    // Add click handlers
    audioTrackList
      .querySelectorAll(".movi-audio-track-item")
      .forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const el = item as HTMLElement;
          const lang = el.dataset.audioLang;
          const trackIdStr = el.dataset.trackId;

          if (this.player) {
            const audioIcon = OSD.audio;
            if (lang) {
              // External audio track — switch to native <audio>
              this.player.selectAudioLang(lang);
              const t = this.player.getAudioLangs().find(a => a.lang === lang);
              this.showOSD(audioIcon, t?.label || lang);
            } else if (trackIdStr) {
              // Muxed audio track — switch back to WASM if needed
              if (this.player.isNativeAudioActive()) {
                this.player.useMuxedAudio();
              }
              const tid = parseInt(trackIdStr);
              this.player.selectAudioTrack(tid);
              const trk = this.player.getAudioTracks().find(a => a.id === tid);
              this.showOSD(audioIcon, trk?.label || trk?.language || `Audio ${tid}`);
            }
            this.updateAudioTrackMenu();
            const menu = this.shadowRoot?.querySelector(
              ".movi-audio-track-menu",
            ) as HTMLElement;
            if (menu) menu.style.display = "none";
          }
        });
      });
  }

  /*
   * Update quality menu based on current tracks
   */
  private updateQualityMenu(): void {
    if (!this.player) return;

    const qualityList = this.shadowRoot?.querySelector(
      ".movi-quality-list",
    ) as HTMLElement;
    const qualityBtn = this.shadowRoot?.querySelector(
      ".movi-quality-btn",
    ) as HTMLElement;
    const qualityContainer = this.shadowRoot?.querySelector(
      ".movi-quality-container",
    ) as HTMLElement;

    if (!qualityList || !qualityBtn || !qualityContainer) return;

    // Only show quality menu for HLS streams (URLs ending in .m3u8)
    // Local files or single-file URLs should not show quality selection
    const isHLS =
      typeof this._src === "string" &&
      (this._src.includes(".m3u8") || this._src.toLowerCase().endsWith("m3u8"));
    if (!isHLS) {
      qualityContainer.style.display = "none";
      return;
    }

    if (typeof (this.player as any).getVideoTracks !== "function") {
      qualityContainer.style.display = "none";
      return;
    }

    const tracks = (this.player as any).getVideoTracks() as VideoTrack[];

    // Log tracks for debugging
    Logger.debug(
      TAG,
      `Quality Menu: Found ${tracks ? tracks.length : 0} tracks`,
      tracks,
    );

    if (!tracks || tracks.length <= 1) {
      Logger.debug(TAG, "Quality Menu: Hiding (tracks <= 1)");
      qualityContainer.style.display = "none";
      return;
    }

    // Sort tracks: Auto (-1) first, then by resolution descending, then by bitrate descending
    const sortedTracks = [...tracks].sort((a, b) => {
      if (a.id === -1) return -1;
      if (b.id === -1) return 1;
      const heightDiff = (b.height || 0) - (a.height || 0);
      if (heightDiff !== 0) return heightDiff;
      return (b.bitRate || 0) - (a.bitRate || 0);
    });

    // Deduplicate tracks by label (e.g. "720p")
    const uniqueTracks: VideoTrack[] = [];
    const seenLabels = new Set<string>();

    sortedTracks.forEach((track) => {
      // Always include Auto
      if (track.id === -1) {
        if (!seenLabels.has("Auto")) {
          seenLabels.add("Auto");
          uniqueTracks.push(track);
        }
        return;
      }

      const label = track.label || (track.height ? `${track.height}p` : "Auto");
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        uniqueTracks.push(track);
      }
    });

    // Check visibility threshold
    // We need at least 2 unique items to offer a choice (e.g. Auto + 720p)
    // If we only have Auto + one quality, and Auto just picks that quality, is it worth showing?
    // standard behavior is: yes, show it so user can see what quality is playing or lock it.

    Logger.debug(TAG, `Quality Menu: Unique tracks: ${uniqueTracks.length}`);

    if (uniqueTracks.length < 2) {
      Logger.debug(TAG, "Quality Menu: Hiding (unique tracks < 2)");
      qualityContainer.style.display = "none";
      return;
    }

    qualityContainer.style.display = "flex";

    const activeTrack = (
      this.player as any
    ).trackManager?.getActiveVideoTrack();

    qualityList.innerHTML = uniqueTracks
      .map((track) => {
        const isActive = activeTrack?.id === track.id;
        const label =
          track.label || (track.height ? `${track.height}p` : "Auto");

        return `
         <div class="movi-quality-item ${isActive ? "movi-quality-active" : ""}" data-track-id="${track.id}">
            <span class="movi-quality-label">${label}</span>
            ${
              isActive
                ? `
            <svg class="movi-quality-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>`
                : ""
            }
         </div>
       `;
      })
      .join("");

    qualityList.querySelectorAll(".movi-quality-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const trackId = parseInt((item as HTMLElement).dataset.trackId || "-1");
        if (
          this.player &&
          (this.player as any).trackManager &&
          typeof (this.player as any).trackManager.selectVideoTrack ===
            "function"
        ) {
          (this.player as any).trackManager.selectVideoTrack(trackId);
          this.updateQualityMenu(); // Update menu after selection to show checkmark
          const menu = this.shadowRoot?.querySelector(
            ".movi-quality-menu",
          ) as HTMLElement;
          if (menu) menu.style.display = "none";
          this.updateQualityMenu();
        }
      });
    });
  }

  /*
   * Show On-Screen Display (OSD) notification
   */
  private osdTimeout: number | null = null;

  private showOSD(icon: string, text: string): void {
    const osdContainer = this.shadowRoot?.querySelector(
      ".movi-osd-container",
    ) as HTMLElement;
    const osdIcon = this.shadowRoot?.querySelector(
      ".movi-osd-icon",
    ) as HTMLElement;
    const osdText = this.shadowRoot?.querySelector(
      ".movi-osd-text",
    ) as HTMLElement;

    // Don't show OSD if controls are disabled
    if (!this._controls) return;

    if (!osdContainer || !osdIcon || !osdText) return;

    osdIcon.innerHTML = icon;
    osdText.textContent = text;

    // Clear existing timeout
    if (this.osdTimeout) {
      clearTimeout(this.osdTimeout);
      this.osdTimeout = null;
    }

    // Show and animate
    osdContainer.style.display = "flex";
    // Force reflow
    void osdContainer.offsetWidth;
    osdContainer.classList.add("visible");

    this.osdTimeout = window.setTimeout(() => {
      osdContainer.classList.remove("visible");

      // Reset seek counter once OSD is hidden
      this.cumulativeSeekAmount = 0;
      this.lastSeekSide = null;

      setTimeout(() => {
        if (!osdContainer.classList.contains("visible")) {
          osdContainer.style.display = "none";
        }
      }, 300); // Wait for fade out
    }, 2000);
  }

  private updateSubtitleTrackMenu(): void {
    if (!this.player) return;

    const subtitleTrackList = this.shadowRoot?.querySelector(
      ".movi-subtitle-track-list",
    ) as HTMLElement;
    const subtitleTrackBtn = this.shadowRoot?.querySelector(
      ".movi-subtitle-track-btn",
    ) as HTMLElement;
    const subtitleTrackContainer = this.shadowRoot?.querySelector(
      ".movi-subtitle-track-container",
    ) as HTMLElement;
    if (!subtitleTrackList || !subtitleTrackBtn || !subtitleTrackContainer)
      return;

    const subtitleTracks = this.player.getSubtitleTracks();
    const activeTrack = this.player.trackManager.getActiveSubtitleTrack();
    const externalSubs = this.player.getSubtitleLangs();
    const hasExternalSubs = externalSubs.length > 0;

    // Hide container if no subtitle tracks (muxed or external)
    if (subtitleTracks.length === 0 && !hasExternalSubs) {
      subtitleTrackContainer.style.display = "none";
      return;
    }

    subtitleTrackContainer.style.display = "flex";
    subtitleTrackBtn.style.display = "flex";

    const anyExternalActive = externalSubs.some((t) => t.active);
    const offActive = activeTrack === null && !anyExternalActive;

    // Toggle icons based on active state
    const subtitleIcon = this.shadowRoot?.querySelector(
      ".movi-icon-subtitle",
    ) as HTMLElement;
    const subtitleIconFilled = this.shadowRoot?.querySelector(
      ".movi-icon-subtitle-filled",
    ) as HTMLElement;

    const subtitleActive = activeTrack !== null || anyExternalActive;
    if (subtitleActive) {
      if (subtitleIcon) subtitleIcon.style.display = "none";
      if (subtitleIconFilled) subtitleIconFilled.style.display = "block";
    } else {
      if (subtitleIcon) subtitleIcon.style.display = "block";
      if (subtitleIconFilled) subtitleIconFilled.style.display = "none";
    }

    // Build menu - start with "Off" option
    let menuHTML = `
      <div class="movi-subtitle-track-item ${offActive ? "movi-subtitle-track-active" : ""}"
           data-track-id="null">
        <span class="movi-subtitle-track-label">Off</span>
      </div>
    `;

    // Add muxed subtitle tracks
    menuHTML += subtitleTracks
      .map((track) => {
        const isActive = activeTrack?.id === track.id;
        const label = track.label || `Subtitle ${track.id}`;
        const infoParts: string[] = [];

        if (track.language) {
          const langCode =
            track.language.length >= 2
              ? track.language.substring(0, 3).toUpperCase()
              : track.language.toUpperCase();
          infoParts.push(langCode);
        }

        if (track.subtitleType) {
          infoParts.push(track.subtitleType === "image" ? "Image" : "Text");
        }

        const info = infoParts.length > 0 ? infoParts.join(" • ") : "";

        return `
        <div class="movi-subtitle-track-item ${isActive ? "movi-subtitle-track-active" : ""}"
             data-track-id="${track.id}">
          <span class="movi-subtitle-track-label">${label}</span>
          ${info ? `<span class="movi-subtitle-track-info">${info}</span>` : ""}
        </div>
      `;
      })
      .join("");

    // Add external subtitle tracks
    menuHTML += externalSubs
      .map((t) => `
        <div class="movi-subtitle-track-item ${t.active ? "movi-subtitle-track-active" : ""}"
             data-subtitle-lang="${t.lang}">
          <span class="movi-subtitle-track-label">${t.label}</span>
          <span class="movi-subtitle-track-info">${t.lang.toUpperCase()}</span>
        </div>
      `)
      .join("");

    subtitleTrackList.innerHTML = menuHTML;

    // Add click handlers
    subtitleTrackList
      .querySelectorAll(".movi-subtitle-track-item")
      .forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const trackIdStr = (item as HTMLElement).dataset.trackId;
          const subtitleLang = (item as HTMLElement).dataset.subtitleLang;

          if (this.player) {
            const subIconOn = OSD.subOn;
            const subIconOff = OSD.subOff;
            if (subtitleLang !== undefined) {
              // External subtitle track
              const st = this.player.getSubtitleLangs().find(t => t.lang === subtitleLang);
              this.player.selectSubtitleLang(subtitleLang);
              this.updateSubtitleTrackMenu();
              this.showOSD(subIconOn, st?.label || subtitleLang);
            } else if (trackIdStr === "null") {
              // Disable all subtitles (muxed + external)
              this.player.selectSubtitleTrack(null).catch(() => {});
              this.player.selectSubtitleLang(null);
              this.updateSubtitleTrackMenu();
              this.showOSD(subIconOff, "Subtitles Off");
            } else {
              // Muxed subtitle track
              const trackId = parseInt(trackIdStr || "0");
              this.player.selectSubtitleLang(null);
              this.player.selectSubtitleTrack(trackId).catch(() => {});
              const trk = this.player.getSubtitleTracks().find(t => t.id === trackId);
              this.showOSD(subIconOn, trk?.label || trk?.language || `Subtitle ${trackId}`);
            }
            // Close menu
            const menu = this.shadowRoot?.querySelector(
              ".movi-subtitle-track-menu",
            ) as HTMLElement;
            if (menu) menu.style.display = "none";
          }
        });
      });
  }

  private showControls(): void {
    if (!this._controls) return;
    const container = this.controlsContainer;
    if (container) {
      container.classList.add("movi-controls-visible");
      container.classList.remove("movi-controls-hidden");

      // Update cursor
      if (this.canvas) this.canvas.style.cursor = "default";
      if (this.video) this.video.style.cursor = "default";
    }

    // Shift timeline panel up above controls
    const bar = this.shadowRoot?.querySelector(".movi-controls-bar") as HTMLElement;
    const barHeight = bar?.offsetHeight ?? 80;
    const timelinePanel = this.shadowRoot?.querySelector(".movi-timeline-panel") as HTMLElement;
    let subtitlePadding = barHeight + 20;

    if (timelinePanel && timelinePanel.style.display !== "none") {
      timelinePanel.style.bottom = `${barHeight + 20}px`;
      // Subtitle above timeline
      requestAnimationFrame(() => {
        const tlHeight = timelinePanel.offsetHeight || 0;
        if (tlHeight > 0 && this.player) {
          this.player.setSubtitleControlsPadding(barHeight + tlHeight + 30);
        }
      });
    } else if (this.player) {
      this.player.setSubtitleControlsPadding(subtitlePadding);
    }

    // Show title bar if showtitle is enabled
    if (this._showTitle && this.shadowRoot) {
      const titleBar = this.shadowRoot.querySelector(".movi-title-bar") as HTMLElement;
      if (titleBar && titleBar.style.display !== "none") {
        titleBar.classList.add("movi-title-visible");
      }
    }

    // Clear existing timeout
    if (this.controlsTimeout) {
      clearTimeout(this.controlsTimeout);
      this.controlsTimeout = null;
    }

    // Auto-hide only if:
    // 1. Player is playing (as requested)
    // 2. Not dragging
    // 3. Mouse is NOT over the controls bar (traditional behavior to keep it visible if manually hovering)
    // 4. No menu is currently open
    const state = this.player?.getState();
    const isPlaying = state === "playing";

    if (
      isPlaying &&
      !this.isOverControls &&
      !this.isDragging &&
      !this.isTouchDragging &&
      !this.isAnyMenuOpen()
    ) {
      this.controlsTimeout = window.setTimeout(() => {
        // Double check state before hiding
        const currentState = this.player?.getState();
        if (
          currentState === "playing" &&
          !this.isOverControls &&
          !this.isDragging &&
          !this.isTouchDragging &&
          !this.isAnyMenuOpen()
        ) {
          this.hideControls();
        }
        this.controlsTimeout = null;
      }, 3000); // 3 seconds of inactivity
    }
  }

  private isAnyMenuOpen(): boolean {
    if (!this.shadowRoot) return false;

    const speedMenu = this.shadowRoot.querySelector(".movi-speed-menu") as HTMLElement;
    const audioMenu = this.shadowRoot.querySelector(".movi-audio-track-menu") as HTMLElement;
    const subtitleMenu = this.shadowRoot.querySelector(".movi-subtitle-track-menu") as HTMLElement;
    const qualityMenu = this.shadowRoot.querySelector(".movi-quality-menu") as HTMLElement;
    const contextMenu = this.shadowRoot.querySelector(".movi-context-menu") as HTMLElement;

    return (
      (speedMenu && speedMenu.style.display === "block") ||
      (audioMenu && audioMenu.style.display === "block") ||
      (subtitleMenu && subtitleMenu.style.display === "block") ||
      (qualityMenu && qualityMenu.style.display === "block") ||
      (contextMenu && (contextMenu.style.display === "block" || contextMenu.style.display === "flex"))
    );
  }

  private hideControls(): void {
    if (!this._controls) return;
    const container = this.controlsContainer;
    if (container) {
      container.classList.remove("movi-controls-visible");
      container.classList.add("movi-controls-hidden");

      // Hide cursor
      if (this.canvas) this.canvas.style.cursor = "none";
      if (this.video) this.video.style.cursor = "none";
    }

    // Shift timeline panel down when controls hide
    const timelinePanel = this.shadowRoot?.querySelector(".movi-timeline-panel") as HTMLElement;
    if (timelinePanel) {
      timelinePanel.style.bottom = "12px";
    }

    // Shift subtitles — if timeline open, keep above it
    if (this.player) {
      if (timelinePanel && timelinePanel.style.display !== "none") {
        requestAnimationFrame(() => {
          const tlHeight = timelinePanel.offsetHeight || 0;
          this.player?.setSubtitleControlsPadding(tlHeight + 24);
        });
      } else {
        this.player.setSubtitleControlsPadding(0);
      }
    }

    // Hide title bar when controls are hidden
    if (this.shadowRoot) {
      const titleBar = this.shadowRoot.querySelector(".movi-title-bar") as HTMLElement;
      if (titleBar) {
        titleBar.classList.remove("movi-title-visible");
      }
    }
  }

  private updateControlsVisibility(): void {
    const container = this.controlsContainer;
    if (!container) return;

    const centerPlayPause = this.shadowRoot?.querySelector(
      ".movi-center-play-pause",
    ) as HTMLElement;

    if (this._controls) {
      container.style.display = "block";
      this.showControls();
    } else {
      container.style.display = "none";
      if (centerPlayPause) centerPlayPause.classList.remove("movi-center-visible");
    }
  }

  private startUIUpdates(): void {
    this.updateAspectRatioIcon();
    const updateUI = () => {
      if (!this.player) return;

      this.updatePlayPauseIcon();
      this.updateTimeDisplay();
      this.updateProgressBar();
      this.updateVolumeIcon();
      this.updateLoadingIndicator(); // Check buffer fill percentage
      this.updateTitle(); // Auto-load title from metadata if needed

      requestAnimationFrame(updateUI);
    };
    updateUI();
  }

  private addStyles(shadowRoot: ShadowRoot): void {
    const style = document.createElement("style");
    style.textContent = `
      /* ========================================
         MOVI PLAYER - PREMIUM UI STYLES
         Rich, Elegant & Responsive Design
      ======================================== */
      
      /* Import premium fonts */
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
      
      /* Global rules to remove all outlines and focus rings */
      * {
        outline: none !important;
        -webkit-tap-highlight-color: transparent !important;
        box-sizing: border-box;
      }
      
      *:focus,
      *:active,
      *:focus-visible,
      *:focus-within {
        outline: none !important;
        outline-width: 0 !important;
        outline-style: none !important;
        outline-color: transparent !important;
        border: none !important;
        box-shadow: none !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      
      button,
      input,
      button:focus,
      button:active,
      button:focus-visible,
      button:focus-within,
      input:focus,
      input:active,
      input:focus-visible,
      input:focus-within {
        outline: none !important;
        outline-width: 0 !important;
        outline-style: none !important;
        outline-color: transparent !important;
        border: none !important;
        box-shadow: none !important;
        -webkit-tap-highlight-color: transparent !important;
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
      }

      :host {
        /* Premium Color Palette */
        --movi-primary: #8B5CF6;
        --movi-primary-light: #A78BFA;
        --movi-primary-dark: #7C3AED;
        --movi-accent: #06B6D4;
        --movi-accent-light: #22D3EE;
        /* Use solid color instead of gradient */
        --movi-gradient: var(--movi-primary);
        
        /* Glass-morphism */
        --movi-glass-bg: rgba(15, 15, 20, 0.85);
        --movi-glass-border: rgba(255, 255, 255, 0.08);
        --movi-glass-blur: 20px;
        
        /* Text Colors */
        --movi-controls-color: #FFFFFF;
        --movi-text-secondary: rgba(255, 255, 255, 0.7);
        --movi-text-tertiary: rgba(255, 255, 255, 0.5);
        
        /* Dynamic Theme Backgrounds */
        --movi-bar-bg: linear-gradient(to top, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.4) 100%);
        --movi-overlay-bg: linear-gradient(to top, rgba(0, 0, 0, 0.4) 0%, transparent 30%);
        --movi-progress-bg: rgba(255, 255, 255, 0.15);
        
        /* Sizing */
        --movi-controls-height: 72px;
        --movi-controls-height-mobile: 64px;
        --movi-progress-height: 4px;
        --movi-progress-height-hover: 6px;
        --movi-btn-size: 44px;
        --movi-btn-size-mobile: 40px;
        
        /* Shadows & Effects */
        --movi-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.3);
        --movi-shadow-md: 0 8px 32px rgba(0, 0, 0, 0.4);
        --movi-shadow-lg: 0 16px 64px rgba(0, 0, 0, 0.5);
        --movi-shadow-glow: 0 0 20px color-mix(in srgb, var(--movi-primary) 0.3);
        
        /* Transitions */
        --movi-transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        --movi-transition-normal: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        --movi-transition-slow: 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        --movi-transition-bounce: 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        
        /* Legacy variables for compatibility */
        --movi-controls-bg: var(--movi-glass-bg);
        --movi-progress-color: var(--movi-primary);
        --movi-progress-buffer-color: rgba(255, 255, 255, 0.2);
        --movi-btn-hover-bg: rgba(255, 255, 255, 0.1);
        
        display: block;
        position: relative;
        overflow: hidden;
        width: 100%;
        height: 100%;
        background: #000;
        outline: none !important;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        overflow: hidden;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      /* Light Theme Override */
      :host([theme="light"]) {
        --movi-primary: #7c3aed; /* Vibrancy boost for light theme */
        --movi-glass-bg: rgba(255, 255, 255, 0.7);
        --movi-glass-border: rgba(0, 0, 0, 0.1);
        --movi-controls-color: #11142d;
        --movi-text-secondary: rgba(0, 0, 0, 0.6);
        --movi-text-tertiary: rgba(0, 0, 0, 0.4);
        
        --movi-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.05);
        --movi-shadow-md: 0 8px 32px rgba(0, 0, 0, 0.1);
        --movi-shadow-lg: 0 16px 64px rgba(0, 0, 0, 0.15);
        --movi-shadow-glow: 0 0 20px color-mix(in srgb, var(--movi-primary) 0.15);
        
        --movi-btn-hover-bg: rgba(0, 0, 0, 0.05);
        --movi-btn-hover-bg: rgba(0, 0, 0, 0.05);
        --movi-progress-buffer-color: rgba(0, 0, 0, 0.15);

        /* Light Theme Backgrounds */
        --movi-bar-bg: linear-gradient(to top, rgba(255, 255, 255, 0.98) 0%, rgba(255, 255, 255, 0.8) 100%);
        --movi-overlay-bg: linear-gradient(to top, rgba(255, 255, 255, 0.5) 0%, transparent 30%);
        --movi-progress-bg: rgba(0, 0, 0, 0.1);
      }
      
      /* Explicitly force colors in Light Theme to override any defaults */
      :host([theme="light"]) .movi-controls-bar,
      :host([theme="light"]) .movi-btn,
      :host([theme="light"]) .movi-time,
      :host([theme="light"]) .movi-current-time,
      :host([theme="light"]) .movi-duration,
      :host([theme="light"]) .movi-speed-item,
      :host([theme="light"]) .movi-audio-track-item,
      :host([theme="light"]) .movi-subtitle-track-item,
      :host([theme="light"]) .movi-quality-item {
         color: #11142d !important;
      }
      
      :host([theme="light"]) .movi-time-separator {
         color: rgba(0, 0, 0, 0.4) !important; 
      }
      
      :host([theme="light"]) .movi-volume-slider::-webkit-slider-runnable-track {
         background: rgba(0, 0, 0, 0.15);
      }

      :host([theme="light"]) .movi-volume-slider::-webkit-slider-thumb {
         background: #11142d;
         box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
      }

      :host([theme="light"]) .movi-volume-slider::-moz-range-track {
         background: rgba(0, 0, 0, 0.15);
      }

      :host([theme="light"]) .movi-volume-slider::-moz-range-thumb {
         background: #11142d;
         box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
      }

      /* Light Theme Tooltip */
      :host([theme="light"]) .movi-seek-thumbnail {
        background-color: rgba(255, 255, 255, 0.65) !important;
        backdrop-filter: blur(20px) !important;
        -webkit-backdrop-filter: blur(20px) !important;
        color: #11142d !important;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12) !important;
        border: 1px solid rgba(255, 255, 255, 0.4) !important;
      }

      :host([theme="light"]) .movi-thumbnail-img {
         border-color: rgba(0, 0, 0, 0.1) !important;
         background-color: #f0f0f0 !important;
      }

      /* Light Theme OSD */
      :host([theme="light"]) .movi-osd-container {
        background: rgba(255, 255, 255, 0.85) !important;
        border-color: rgba(0, 0, 0, 0.05) !important;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12) !important;
      }

      :host([theme="light"]) .movi-osd-text {
        color: #11142d !important;
      }

      /* Light Theme Button Hover */
      :host([theme="light"]) .movi-btn:hover {
        background: var(--movi-btn-hover-bg) !important;
      }

      /* Light Theme Controls Overlay */
      :host([theme="light"]) .movi-controls-overlay {
        background: linear-gradient(to top, rgba(255, 255, 255, 0.4) 0%, transparent 30%) !important;
      }

      /* Light Theme Title Bar */
      :host([theme="light"]) .movi-title-bar {
        background: linear-gradient(to bottom, rgba(255, 255, 255, 0.7) 0%, transparent 100%) !important;
      }

      /* Light Theme Progress Bar */
      :host([theme="light"]) .movi-progress-bar {
        background: rgba(0, 0, 0, 0.15) !important;
      }

      :host([theme="light"]) .movi-progress-bar:hover {
        background: rgba(0, 0, 0, 0.2) !important;
      }

      :host([theme="light"]) .movi-progress-buffer {
        background: rgba(0, 0, 0, 0.1) !important;
      }

      /* Light Theme Center Play Button */
      :host([theme="light"]) .movi-center-play-pause {
        background: color-mix(in srgb, var(--movi-primary) 15%, transparent) !important;
        border-color: color-mix(in srgb, var(--movi-primary) 30%, transparent) !important;
        box-shadow: 0 8px 32px color-mix(in srgb, var(--movi-primary) 20%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--movi-primary) 10%, transparent) !important;
      }

      :host([theme="light"]) .movi-center-play-pause:hover {
        background: color-mix(in srgb, var(--movi-primary) 25%, transparent) !important;
        border-color: color-mix(in srgb, var(--movi-primary) 50%, transparent) !important;
        box-shadow: 0 8px 40px color-mix(in srgb, var(--movi-primary) 30%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--movi-primary) 15%, transparent) !important;
      }

      :host([theme="light"]) .movi-center-play-pause svg {
        filter: drop-shadow(0 0 4px color-mix(in srgb, var(--movi-primary) 30%, transparent)) !important;
      }

      :host([theme="light"]) .movi-center-play-pause:hover svg {
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--movi-primary) 50%, transparent)) !important;
      }

      /* Light Theme Context Menu */
      :host([theme="light"]) .movi-context-menu {
        background: rgba(255, 255, 255, 0.95) !important;
        border-color: rgba(0, 0, 0, 0.1) !important;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15) !important;
        color: #11142d !important;
      }

      :host([theme="light"]) .movi-context-menu-item:hover {
        background-color: rgba(0, 0, 0, 0.05) !important;
      }

      :host([theme="light"]) .movi-context-menu-divider {
        background: rgba(0, 0, 0, 0.1) !important;
      }

      :host([theme="light"]) .movi-speed-menu,
      :host([theme="light"]) .movi-audio-track-menu,
      :host([theme="light"]) .movi-subtitle-track-menu,
      :host([theme="light"]) .movi-quality-menu,
      :host([theme="light"]) .movi-context-menu-submenu,
      :host([theme="light"]) .movi-context-menu-submenu-audio,
      :host([theme="light"]) .movi-context-menu-submenu-subtitle {
        background: rgba(255, 255, 255, 0.95) !important;
        border-color: rgba(0, 0, 0, 0.1) !important;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15) !important;
        color: #11142d !important;
      }

      /* Light Theme Menu Items Hover */
      :host([theme="light"]) .movi-audio-track-item:hover,
      :host([theme="light"]) .movi-subtitle-track-item:hover,
      :host([theme="light"]) .movi-speed-item:hover {
        background: color-mix(in srgb, var(--movi-primary) 0.08) !important;
      }

      :host([theme="light"]) .movi-audio-track-item.movi-audio-track-active,
      :host([theme="light"]) .movi-subtitle-track-item.movi-subtitle-track-active,
      :host([theme="light"]) .movi-speed-item.movi-speed-active {
        background: color-mix(in srgb, var(--movi-primary) 0.15) !important;
      }

      :host([theme="light"]) .movi-quality-item:hover {
        background: rgba(0, 0, 0, 0.05) !important;
      }

      :host([theme="light"]) .movi-quality-item.movi-quality-active {
        background: color-mix(in srgb, var(--movi-primary) 0.12) !important;
      }

      :host:focus,
      :host:active,
      :host:focus-visible {
        outline: none !important;
        outline-offset: 0 !important;
        border: none !important;
        box-shadow: none !important;
      }

      /* Ensure element fills fullscreen viewport */
      :host(:fullscreen) {
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
      }

      canvas, video {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain; /* Maintain aspect ratio */
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
      }

      /* Ensure canvas fills fullscreen */
      :host(:fullscreen) canvas:not(.movi-nerd-stats-graph),
      :host(:fullscreen) video {
        width: 100vw !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
      }

      .movi-controls-container {
        display: none;
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 10;
        pointer-events: none;
        transition: opacity var(--movi-transition-normal), transform var(--movi-transition-normal);
        transform: translateY(0);
      }

      .movi-controls-container.movi-controls-hidden {
        opacity: 0;
        pointer-events: none;
        transform: translateY(10px);
      }
      
      /* Hide cursor on canvas when controls are hidden */
      :host:has(.movi-controls-container.movi-controls-hidden) canvas,
      :host:has(.movi-controls-container.movi-controls-hidden) video {
        cursor: none !important;
      }

      .movi-controls-container.movi-controls-visible {
        opacity: 1;
        pointer-events: none;
        transform: translateY(0);
      }
      
      /* Show normal cursor on canvas when controls are visible */
      :host:has(.movi-controls-container.movi-controls-visible) canvas,
      :host:has(.movi-controls-container.movi-controls-visible) video {
        cursor: default !important;
      }
      
      /* Move timeline panel above controls bar when visible */
      :host:has(.movi-controls-container.movi-controls-visible) .movi-timeline-panel {
        bottom: 125px;
      }

      /* Hide seek thumbnail when timeline is open — prevents z-index overlap */
      :host:has(.movi-timeline-panel[style*="flex"]) .movi-seek-thumbnail {
        display: none !important;
      }

      /* Force enable pointer events on all interactive controls */
      .movi-controls-container.movi-controls-visible .movi-controls-bar,
      .movi-controls-container.movi-controls-visible .movi-controls-bar *,
      .movi-controls-container.movi-controls-visible button,
      .movi-controls-container.movi-controls-visible input {
        pointer-events: auto !important;
      }

      .movi-controls-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: var(--movi-controls-height);
        pointer-events: all;
        z-index: 1;
        /* Subtle gradient overlay for better control visibility */
        background: var(--movi-overlay-bg);
        opacity: 0;
        transition: opacity var(--movi-transition-normal);
      }
      
      .movi-controls-container.movi-controls-visible .movi-controls-overlay {
        opacity: 1;
      }

      .movi-title-bar {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        padding: 16px 20px;
        background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7) 0%, transparent 100%);
        z-index: 5;
        opacity: 0;
        transform: translateY(-10px);
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;
      }

      .movi-title-bar.movi-title-visible {
        opacity: 1;
        transform: translateY(0);
      }

      .movi-title-text {
        color: var(--movi-controls-color);
        font-size: clamp(16px, 4vw, 20px);
        font-weight: 500;
        display: block;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.4;
      }

      .movi-controls-bar {
        position: relative;
        pointer-events: auto !important;
        z-index: 10 !important;
        display: flex;
        flex-direction: column;
        padding: 0 20px 10px;
        background: var(--movi-bar-bg);
        backdrop-filter: blur(var(--movi-glass-blur));
        -webkit-backdrop-filter: blur(var(--movi-glass-blur));
        color: var(--movi-controls-color);
        height: auto;
        min-height: var(--movi-controls-height);
      }

      .movi-progress-container {
        width: 100%;
        padding: 10px 0 15px;
        display: flex;
        align-items: center;
        position: relative;
      }

      .movi-buttons-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        gap: 16px;
      }

      .movi-controls-left,
      .movi-controls-right {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }

      .movi-btn {
        background: transparent;
        border: none;
        color: var(--movi-controls-color);
        cursor: pointer;
        padding: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--movi-btn-size);
        height: var(--movi-btn-size);
        border-radius: 50%;
        transition: all var(--movi-transition-fast);
        pointer-events: auto !important;
        outline: none !important;
      }

      .movi-btn:hover {
        background: color-mix(in srgb, var(--movi-primary) 0.15); /* Purplish hover */
        transform: scale(1.1);
      }
      
      .movi-btn:active {
        transform: scale(0.95);
      }

      .movi-btn:focus,
      .movi-btn:focus-visible {
        outline: none !important;
        outline-offset: 0 !important;
        outline-width: 0 !important;
        outline-style: none !important;
        outline-color: transparent !important;
        border: none !important;
        box-shadow: none !important;
        -webkit-focus-ring-color: transparent !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      
      /* Remove Firefox button inner border */
      .movi-btn::-moz-focus-inner {
        border: 0 !important;
        outline: none !important;
        padding: 0;
      }

      .movi-btn svg {
        width: 22px;
        height: 22px;
        transition: transform var(--movi-transition-fast);
      }
      
      .movi-btn:hover svg {
        filter: drop-shadow(0 0 4px color-mix(in srgb, var(--movi-primary) 0.5));
      }
      
      .movi-icon-play {
        margin-left: 2px;
      }

      .movi-time {
        font-size: 13px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        letter-spacing: 0.02em;
        color: var(--movi-text-secondary);
      }
      
      .movi-current-time {
        color: var(--movi-controls-color);
      }
      
      .movi-time-separator {
        color: var(--movi-text-tertiary);
        margin: 0 2px;
      }

      .movi-progress-container {
        width: 100%;
        padding: 10px 0 15px;
        display: flex;
        align-items: center;
        position: relative;
      }

      .movi-progress-bar {
        position: relative;
        width: 100%;
        height: var(--movi-progress-height);
        min-height: 5px;
        background: var(--movi-progress-bg);
        border-radius: 100px;
        cursor: pointer;
        pointer-events: auto !important;
        z-index: 11 !important;
        outline: none !important;
        border: none;
        transition: height var(--movi-transition-fast), background var(--movi-transition-fast);
        overflow: visible;
      }
      
      .movi-progress-bar:hover {
        height: var(--movi-progress-height-hover);
        background: rgba(255, 255, 255, 0.2);
      }

      .movi-progress-bar:focus,
      .movi-progress-bar:active,
      .movi-progress-bar:focus-visible {
        outline: none !important;
        outline-offset: 0 !important;
        outline-width: 0 !important;
        outline-style: none !important;
        outline-color: transparent !important;
        border: none !important;
        box-shadow: none !important;
        -webkit-focus-ring-color: transparent !important;
        -webkit-tap-highlight-color: transparent !important;
      }

      .movi-progress-filled {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        background: var(--movi-primary);
        border-radius: 100px;
        width: 0%;
        transition: width 0.1s linear;
      }

      .movi-chapter-markers {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 100%;
        z-index: 3;
        pointer-events: none;
      }

      .movi-chapter-marker {
        position: absolute;
        top: 0;
        width: 3px;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        transform: translateX(-1.5px);
        border-radius: 1px;
        z-index: 3;
      }

      .movi-chapter-segment {
        position: absolute;
        top: 0;
        height: 100%;
        pointer-events: none;
      }

      .movi-progress-buffer {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        background: rgba(255, 255, 255, 0.25);
        border-radius: 100px;
        width: 0%;
        transition: width 0.1s linear, left 0.1s linear;
      }

      .movi-progress-handle {
        position: absolute;
        top: 50%;
        left: 0%;
        transform: translate(-50%, -50%) scale(0);
        width: 16px;
        height: 16px;
        background: var(--movi-controls-color);
        border-radius: 50%;
        opacity: 0;
        transition: all var(--movi-transition-fast);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 3px color-mix(in srgb, var(--movi-primary) 30%, transparent);
        z-index: 5;
      }

      .movi-progress-bar:hover .movi-progress-handle {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }

      .movi-progress-handle:active {
        transform: translate(-50%, -50%) scale(1.2);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4), 0 0 0 5px color-mix(in srgb, var(--movi-primary) 40%, transparent);
      }

      /* Always show progress handle on touch devices */
      @media (hover: none) and (pointer: coarse) {
        .movi-progress-handle {
          opacity: 1 !important;
          transform: translate(-50%, -50%) scale(1) !important;
          transition: none !important;
        }
      }

      .movi-volume-container {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 100%;
      }

      .movi-volume-slider-container {
        width: 0;
        overflow: hidden;
        transition: all var(--movi-transition-normal);
        padding: 8px 0;
        box-sizing: content-box;
        display: flex;
        align-items: center;
        opacity: 0;
      }

      .movi-volume-container:hover .movi-volume-slider-container,
      .movi-volume-container.active .movi-volume-slider-container {
        width: 80px !important;
        padding: 8px 8px;
        overflow: visible;
        opacity: 1 !important;
      }

      .movi-volume-slider {
        width: 100%;
        height: 4px;
        -webkit-appearance: none;
        appearance: none;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 100px;
        outline: none !important;
        pointer-events: auto !important;
        cursor: pointer;
        position: relative;
        z-index: 11 !important;
        margin: 0;
        padding: 0;
        border: none;
        vertical-align: middle;
      }

      .movi-volume-slider:focus,
      .movi-volume-slider:active,
      .movi-volume-slider:focus-visible {
        outline: none !important;
        outline-offset: 0 !important;
        outline-width: 0 !important;
        outline-style: none !important;
        outline-color: transparent !important;
        border: none !important;
        box-shadow: none !important;
        -webkit-focus-ring-color: transparent !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      
      /* Remove Firefox input inner border */
      .movi-volume-slider::-moz-focus-inner {
        border: 0 !important;
        outline: none !important;
      }

      .movi-volume-slider::-webkit-slider-runnable-track {
        height: 4px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 100px;
      }

      .movi-volume-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 14px;
        height: 14px;
        background: #fff;
        border-radius: 50%;
        cursor: pointer;
        margin-top: -5px;
        outline: none !important;
        border: none !important;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        transition: transform var(--movi-transition-fast), box-shadow var(--movi-transition-fast);
      }
      
      .movi-volume-slider::-webkit-slider-thumb:hover {
        transform: scale(1.15);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4), 0 0 0 3px color-mix(in srgb, var(--movi-primary) 0.3);
      }
      
      .movi-volume-slider::-webkit-slider-thumb:focus,
      .movi-volume-slider::-webkit-slider-thumb:active {
        outline: none !important;
        border: none !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4), 0 0 0 3px color-mix(in srgb, var(--movi-primary) 0.3);
      }

      .movi-volume-slider::-moz-range-thumb {
        width: 14px;
        height: 14px;
        background: #fff;
        border-radius: 50%;
        cursor: pointer;
        border: none !important;
        outline: none !important;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
      }
      
      .movi-volume-slider::-moz-range-thumb:focus,
      .movi-volume-slider::-moz-range-thumb:active {
        outline: none !important;
        border: none !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4), 0 0 0 3px color-mix(in srgb, var(--movi-primary) 0.3);
      }
      
      .movi-volume-slider::-moz-range-track {
        height: 4px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 100px;
      }

      .movi-audio-track-container {
        position: relative;
        display: none;
        align-items: center;
        margin-left: 4px;
      }

      .movi-audio-track-btn {
        display: none;
      }

      .movi-audio-track-menu {
        position: absolute;
        bottom: calc(100% + 12px);
        right: 0;
        background: var(--movi-glass-bg);
        backdrop-filter: blur(var(--movi-glass-blur));
        -webkit-backdrop-filter: blur(var(--movi-glass-blur));
        border: 1px solid var(--movi-glass-border);
        border-radius: 12px;
        min-width: 200px;
        max-height: 280px;
        overflow-y: auto;
        box-shadow: var(--movi-shadow-lg);
        z-index: 1000;
        pointer-events: auto !important;
      }

      .movi-audio-track-list {
        padding: 8px 0;
      }

      .movi-audio-track-item {
        padding: 12px 16px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: var(--movi-controls-color);
        transition: background var(--movi-transition-fast);
        gap: 12px;
        min-width: 0;
        font-size: 14px;
      }

      .movi-audio-track-item:hover {
        background: color-mix(in srgb, var(--movi-primary) 0.15);
      }

      .movi-audio-track-item.movi-audio-track-active {
        background: color-mix(in srgb, var(--movi-primary) 0.25);
        font-weight: 600;
      }

      .movi-audio-track-item.movi-audio-track-active::before {
        content: '✓';
        margin-right: 8px;
        color: var(--movi-primary);
        flex-shrink: 0;
      }

      .movi-audio-track-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .movi-audio-track-info {
        font-size: 12px;
        color: var(--movi-text-tertiary);
        flex-shrink: 0;
        white-space: nowrap;
      }

      .movi-subtitle-track-container {
        position: relative;
        display: none; /* Hidden by default, shown when subtitle tracks available */
        align-items: center;
        margin-left: 4px;
      }

      .movi-subtitle-track-btn {
        display: none; /* Hidden by default, shown when subtitle tracks available */
      }

      .movi-subtitle-track-menu {
        position: absolute;
        bottom: calc(100% + 8px);
        right: 0;
        background: var(--movi-glass-bg);
        backdrop-filter: blur(var(--movi-glass-blur));
        -webkit-backdrop-filter: blur(var(--movi-glass-blur));
        border: 1px solid var(--movi-glass-border);
        border-radius: 12px;
        min-width: 200px;
        max-height: 280px;
        overflow-y: auto;
        box-shadow: var(--movi-shadow-lg);
        z-index: 1000;
        pointer-events: auto !important;
      }

      .movi-subtitle-track-list {
        padding: 8px 0;
      }

      .movi-subtitle-track-item {
        padding: 12px 16px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: var(--movi-controls-color);
        transition: background var(--movi-transition-fast);
        gap: 12px;
        min-width: 0;
        font-size: 14px;
      }

      .movi-subtitle-track-item:hover {
        background: color-mix(in srgb, var(--movi-primary) 0.15);
      }

      .movi-subtitle-track-item.movi-subtitle-track-active {
        background: color-mix(in srgb, var(--movi-primary) 0.25);
        font-weight: 600;
      }

      .movi-subtitle-track-item.movi-subtitle-track-active::before {
        content: '✓';
        margin-right: 8px;
        color: var(--movi-primary);
        flex-shrink: 0;
      }

      .movi-subtitle-track-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .movi-subtitle-track-info {
        font-size: 12px;
        color: var(--movi-text-tertiary);
        flex-shrink: 0;
        cursor: pointer;
      }
      
      /* HDR Button Styling */
      .movi-hdr-container {
        display: flex;
        align-items: center;
        position: relative;
      }
      
      .movi-hdr-btn {
        display: none; /* Hidden by default, shown when HDR content is detected */
        align-items: center;
        justify-content: center;
        padding: 0 12px !important; /* Force override of .movi-btn padding */
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.15);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        opacity: 0.9;
        width: auto !important;
        height: 28px !important;
        margin: 0;
        box-sizing: border-box;
      }
      
      .movi-hdr-btn:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.3);
        transform: scale(1.05);
      }
      
      .movi-hdr-active {
        background: #fff !important;
        border-color: #fff;
        opacity: 1;
        box-shadow: 0 0 15px rgba(255, 255, 255, 0.2);
      }
      
      .movi-hdr-active .movi-hdr-label {
        color: #000 !important;
      }
      
      .movi-hdr-label {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        color: #fff;
        line-height: 1;
        text-transform: uppercase;
      }
      
      .movi-icon-hdr {
        display: none; /* Hide icon for now as pill text is cleaner */
      }
      
      .movi-hdr-status {
        font-size: 10px;
        background: rgba(255, 255, 255, 0.1);
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: auto;
        font-weight: 600;
      }
      
      .movi-context-menu-active .movi-hdr-status {
        background: rgba(255, 255, 255, 0.2);
      }

      .movi-speed-container {
        position: relative;
        display: flex;
        align-items: center;
        margin-left: 8px;
      }

      .movi-speed-menu {
        position: absolute;
        bottom: calc(100% + 12px);
        right: 0;
        background: var(--movi-glass-bg);
        backdrop-filter: blur(var(--movi-glass-blur));
        -webkit-backdrop-filter: blur(var(--movi-glass-blur));
        border: 1px solid var(--movi-glass-border);
        border-radius: 12px;
        min-width: 140px;
        max-height: 280px;
        overflow-y: auto;
        box-shadow: var(--movi-shadow-lg);
        z-index: 1000;
        pointer-events: auto !important;
      }

      .movi-speed-list {
        padding: 8px 0;
      }

      .movi-speed-item {
        padding: 11px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        color: var(--movi-controls-color);
        transition: background var(--movi-transition-fast);
        font-size: 14px;
        user-select: none;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        margin: 2px 6px;
        border-radius: 10px;
      }

      .movi-speed-item:hover {
        background: color-mix(in srgb, var(--movi-primary) 0.15);
      }

      .movi-speed-item.movi-speed-active {
        background: color-mix(in srgb, var(--movi-primary) 0.25);
        font-weight: 600;
      }
      
      .movi-speed-item.movi-speed-active::before {
        content: '✓';
        margin-right: 8px;
        color: var(--movi-primary);
      }

      .movi-loop-btn.active .movi-icon-loop-outline {
        display: none;
      }

      .movi-loop-btn.active .movi-icon-loop-filled {
        display: block !important;
      }

      .movi-stable-audio-container {
        position: relative;
      }

      .movi-stable-audio-btn.active .movi-icon-stable-audio-outline {
        display: none;
      }

      .movi-stable-audio-btn.active .movi-icon-stable-audio-filled {
        display: block !important;
      }

      /* ========================================
         NERD STATS OVERLAY
      ======================================== */
      .movi-nerd-stats {
        position: absolute;
        top: 12px;
        left: 12px;
        z-index: 9;
        background: rgba(0, 0, 0, 0.82);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 0;
        min-width: 280px;
        max-width: 380px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.9);
        pointer-events: auto;
        user-select: text;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }

      .movi-nerd-stats::-webkit-scrollbar {
        width: 4px;
      }

      .movi-nerd-stats::-webkit-scrollbar-track {
        background: transparent;
      }

      .movi-nerd-stats::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 2px;
      }

      .movi-nerd-stats-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
        position: relative;
        z-index: 5;
      }

      .movi-nerd-stats-title {
        font-weight: 700;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: rgba(255, 255, 255, 0.6);
      }

      .movi-nerd-stats-close {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 20px;
        cursor: pointer;
        pointer-events: auto;
        padding: 4px 8px;
        line-height: 1;
        padding: 0 2px;
        line-height: 1;
        transition: color 0.15s;
      }

      .movi-nerd-stats-close:hover {
        color: #fff;
      }

      .movi-nerd-stats-body {
        padding: 6px 12px 10px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
      }

      .movi-nerd-stats-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 3px 0;
        gap: 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }

      .movi-nerd-stats-row:last-child {
        border-bottom: none;
      }

      .movi-nerd-stats-key {
        color: rgba(255, 255, 255, 0.45);
        white-space: nowrap;
        font-size: 10.5px;
      }

      .movi-nerd-stats-value {
        color: rgba(255, 255, 255, 0.95);
        font-weight: 600;
        text-align: right;
        word-break: break-all;
        font-size: 10.5px;
      }

      .movi-nerd-stats-graph-section {
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        margin-top: 6px;
        padding: 8px 0 0;
      }

      .movi-nerd-stats-graph-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }

      .movi-nerd-stats-graph-title {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: rgba(255, 255, 255, 0.45);
      }

      .movi-nerd-stats-graph-speed {
        font-size: 11px;
        font-weight: 700;
        color: #00ff88;
        font-variant-numeric: tabular-nums;
      }

      .movi-nerd-stats-graph {
        width: 100%;
        height: 80px;
        border-radius: 4px;
        display: block;
        position: static;
        z-index: auto;
        object-fit: unset;
      }

      @media (max-width: 640px) {
        .movi-nerd-stats {
          top: 4px;
          left: 4px;
          right: 4px;
          min-width: unset;
          max-width: unset;
          font-size: 9px;
          border-radius: 6px;
        }

        .movi-nerd-stats-header {
          padding: 8px 10px;
        }

        .movi-nerd-stats-close {
          font-size: 24px;
          padding: 6px 10px;
          pointer-events: auto;
        }

        .movi-nerd-stats-title {
          font-size: 9px;
        }

        .movi-nerd-stats-body {
          padding: 4px 10px 6px;
        }

        .movi-nerd-stats-row {
          padding: 2px 0;
          gap: 8px;
        }

        .movi-nerd-stats-key,
        .movi-nerd-stats-value {
          font-size: 8.5px;
        }

        .movi-nerd-stats-graph-section {
          padding: 6px 10px 8px;
        }

        .movi-nerd-stats-graph {
          height: 50px;
          width: 100%;
          display: block;
          position: static;
          z-index: auto;
          object-fit: unset;
        }

        .movi-nerd-stats-graph-header {
          margin-bottom: 4px;
        }

        .movi-nerd-stats-graph-title {
          font-size: 8px;
        }

        .movi-nerd-stats-graph-speed {
          font-size: 9px;
        }
      }

      /* ========================================
         TIMELINE PANEL
      ======================================== */
      .movi-timeline-panel {
        position: absolute;
        bottom: 125px;
        left: 12px;
        transition: bottom 0.3s ease;
        right: 12px;
        z-index: 11;
        background: rgba(0, 0, 0, 0.88);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        padding: 0;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        font-family: 'Inter', -apple-system, sans-serif;
        max-height: 240px;
        overflow: hidden;
      }

      .movi-timeline-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
      }

      .movi-timeline-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: rgba(255, 255, 255, 0.6);
      }

      .movi-timeline-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .movi-timeline-generate-btn {
        background: var(--movi-primary);
        border: none;
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        padding: 5px 12px;
        border-radius: 6px;
        cursor: pointer;
        transition: opacity 0.2s;
        font-family: inherit;
      }

      .movi-timeline-generate-btn:hover {
        opacity: 0.85;
      }

      .movi-timeline-generate-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .movi-timeline-close {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.15s;
      }

      .movi-timeline-close:hover {
        color: #fff;
      }

      .movi-timeline-strip {
        display: flex;
        gap: 4px;
        padding: 10px 14px;
        overflow-x: auto;
        overflow-y: hidden;
        flex: 1;
        min-height: 0;
      }

      .movi-timeline-strip::-webkit-scrollbar {
        height: 4px;
      }

      .movi-timeline-strip::-webkit-scrollbar-track {
        background: transparent;
      }

      .movi-timeline-strip::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 2px;
      }

      .movi-timeline-item {
        flex-shrink: 0;
        cursor: pointer;
        position: relative;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.08);
        transition: border-color 0.2s, transform 0.2s;
      }

      .movi-timeline-item:hover,
      .movi-timeline-item.movi-timeline-selected {
        border-color: var(--movi-primary);
        transform: scale(1.05);
      }

      .movi-timeline-item img {
        display: block;
        height: 90px;
        width: auto;
        object-fit: contain;
      }

      .movi-timeline-portrait .movi-timeline-item {
        min-width: auto;
      }

      .movi-timeline-portrait .movi-timeline-item img {
        height: auto;
        width: 55px;
      }

      .movi-timeline-time {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 10px;
        font-weight: 600;
        color: #fff;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
        padding: 12px 4px 4px;
        font-variant-numeric: tabular-nums;
      }

      .movi-timeline-chapter {
        min-width: 130px;
      }

      .movi-timeline-chapter-label {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.85));
        padding: 16px 6px 5px;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .movi-timeline-chapter-title {
        font-size: 10px;
        font-weight: 600;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .movi-timeline-chapter .movi-timeline-time {
        position: static;
        background: none;
        padding: 0;
        font-size: 9px;
        color: rgba(255, 255, 255, 0.5);
      }

      .movi-timeline-status {
        padding: 0 14px 8px;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
        text-align: center;
        flex-shrink: 0;
      }

      @media (max-width: 640px) {
        .movi-timeline-panel {
          left: 8px;
          right: 8px;
          bottom: 70px;
        }

        .movi-timeline-item img {
          height: 65px;
        }
      }

      /* ========================================
         KEYBOARD SHORTCUTS PANEL
      ======================================== */
      .movi-shortcuts-panel {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 100;
        background: rgba(0, 0, 0, 0.92);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        padding: 0;
        flex-direction: column;
        min-width: 420px;
        max-width: 520px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
        font-family: 'Inter', -apple-system, sans-serif;
        color: rgba(255, 255, 255, 0.9);
        pointer-events: auto;
      }

      .movi-shortcuts-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .movi-shortcuts-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.02em;
      }

      .movi-shortcuts-close {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        font-size: 22px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.15s;
      }

      .movi-shortcuts-close:hover {
        color: #fff;
      }

      .movi-shortcuts-body {
        display: flex;
        gap: 24px;
        padding: 14px 18px 18px;
      }

      .movi-shortcuts-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .movi-shortcut-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .movi-shortcut-row kbd {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 5px;
        padding: 3px 8px;
        font-size: 11px;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        font-weight: 600;
        min-width: 28px;
        text-align: center;
        color: rgba(255, 255, 255, 0.85);
        white-space: nowrap;
      }

      .movi-shortcut-row span {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.6);
        text-align: right;
        flex: 1;
      }

      @media (max-width: 640px) {
        .movi-shortcuts-panel {
          min-width: unset;
          max-width: unset;
          left: 8px;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          width: auto;
        }

        .movi-shortcuts-body {
          flex-direction: column;
          gap: 8px;
          padding: 10px 14px 14px;
        }

        .movi-shortcut-row kbd {
          font-size: 10px;
        }

        .movi-shortcut-row span {
          font-size: 11px;
        }
      }

      /* ========================================
         RESUME DIALOG
      ======================================== */
      .movi-resume-dialog {
        position: absolute;
        bottom: 90px;
        right: 16px;
        z-index: 50;
        background: rgba(0, 0, 0, 0.9);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        gap: 16px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        font-family: 'Inter', -apple-system, sans-serif;
        pointer-events: auto;
        animation: movi-resume-slide-up 0.3s ease;
      }

      @keyframes movi-resume-slide-up {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes movi-resume-fade-out {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(10px); }
      }

      .movi-resume-text {
        font-size: 13px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.9);
        white-space: nowrap;
      }

      .movi-resume-time {
        font-weight: 700;
        color: var(--movi-primary);
      }

      .movi-resume-buttons {
        display: flex;
        gap: 8px;
      }

      .movi-resume-btn {
        border: none;
        border-radius: 6px;
        padding: 7px 16px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: opacity 0.15s, transform 0.1s;
        white-space: nowrap;
      }

      .movi-resume-btn:hover {
        opacity: 0.85;
      }

      .movi-resume-btn:active {
        transform: scale(0.97);
      }

      .movi-resume-btn.movi-resume-focused {
        outline: 2px solid var(--movi-primary);
        outline-offset: 2px;
        transform: scale(1.05);
      }

      .movi-resume-yes {
        background: var(--movi-primary);
        color: #fff;
      }

      .movi-resume-no {
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.8);
      }

      @media (max-width: 640px) {
        .movi-resume-dialog {
          bottom: 80px;
          padding: 10px 14px;
          gap: 10px;
        }

        .movi-resume-text {
          font-size: 12px;
        }

        .movi-resume-btn {
          padding: 6px 12px;
          font-size: 11px;
        }
      }

      /* ========================================
         RESPONSIVE STYLES - Mobile First
      ======================================== */

      /* Mobile devices (up to 640px) */
      @media (max-width: 640px) {
        :host {
          --movi-controls-height: var(--movi-controls-height-mobile);
          --movi-btn-size: var(--movi-btn-size-mobile);
        }
        
        .movi-loader-container {
          width: 64px !important;
          height: 64px !important;
        }

        /* Disable animations on mobile */
        .movi-controls-container,
        .movi-controls-overlay,
        .movi-center-play-pause,
        .movi-btn,
        .movi-progress-handle {
          transition: none !important;
          animation: none !important;
          transform: none !important;
        }

        /* Explicit state overrides for mobile */
        .movi-controls-container.movi-controls-hidden {
           opacity: 0 !important;
           transform: none !important;
        }
        
        .movi-controls-container.movi-controls-visible {
           opacity: 1 !important;
           transform: none !important;
        }
        
        /* Restore explicit transforms that are structural, not animated */
        .movi-center-play-pause {
           /* Center button needs transform for centering */
           transform: translate(-50%, -50%) scale(0.7) !important;
           width: 68px !important;
           height: 68px !important;
           border-width: 1.5px !important;
        }
        .movi-center-play-pause.movi-center-visible {
           transform: translate(-50%, -50%) scale(1) !important;
        }
        .movi-center-play-pause svg {
           width: 32px !important;
           height: 32px !important;
           color: var(--movi-controls-color) !important;
           fill: var(--movi-controls-color) !important;
           filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3)) !important;
        }
        .movi-center-icon-play {
           margin-left: 5px !important;
        }
        .movi-progress-handle {
            /* Handle needs transform for centering and positioning */
            transform: translate(-50%, -50%) !important;
        }
        
        .movi-time {
          font-size: 10px;
        }

        .movi-controls-bar {
          padding: 4px 10px 6px;
          gap: 2px;
          min-height: var(--movi-controls-height-mobile);
        }

        .movi-buttons-row {
          gap: 4px;
        }

        .movi-controls-left,
        .movi-controls-right {
          gap: 2px;
        }

        .movi-btn {
          padding: 6px;
          width: 34px;
          height: 34px;
        }

        .movi-btn svg {
          width: 18px;
          height: 18px;
        }
        
        /* Show volume slider on mobile - user request */
        .movi-volume-slider-container {
          /* display: none !important; REMOVED */
        }
        
        .movi-volume-slider-container {
          max-width: 50px;
        }

        .movi-progress-container {
          padding: 6px 0 2px;
        }
        
        .movi-progress-bar {
          height: 6px;
        }
        
        .movi-progress-bar:hover {
          height: 8px;
        }
        
        .movi-progress-handle {
          width: 14px;
          height: 14px;
        }

        .movi-hdr-label {
          display: none !important;
        }

        /* Horizontal Expansion Style */
        .movi-controls-right {
          position: relative;
          display: flex;
          align-items: center;
          gap: 0;
          transition: gap var(--movi-transition-normal);
        }

        .movi-mobile-expandable {
          display: flex;
          align-items: center;
          width: 0;
          opacity: 0;
          overflow: hidden;
          transition: all var(--movi-transition-normal);
          pointer-events: none;
          gap: 0;
          height: 100%; /* Match bar height */
        }

        .movi-controls-right.expanded .movi-mobile-expandable {
          width: auto;
          opacity: 1;
          pointer-events: auto;
          gap: 4px;
          margin-right: 4px;
          overflow: visible; /* Prevent clipping of hover backgrounds */
          flex: 1;
          justify-content: flex-end;
        }

        /* Reset margins and restore dimensions */
        .movi-controls-right.expanded .movi-mobile-expandable > * {
          margin: 0 !important;
          width: auto;
          height: auto;
        }

        /* Hide individual buttons by default on mobile */
        .movi-quality-container,
        .movi-speed-container,
        .movi-aspect-ratio-btn,
        .movi-loop-btn {
          width: 0;
          height: 0;
          margin: 0;
          gap: 0;
          overflow: visible;
        }

        .movi-more-container {
          display: flex;
          align-items: center;
          position: relative;
        }

        .movi-more-btn {
          display: flex !important;
          z-index: 12;
        }

        .movi-controls-right.expanded ~ .movi-controls-left,
        .movi-controls-left:has(~ .movi-controls-right.expanded),
        :host([theme]) .movi-controls-right.expanded .movi-controls-left {
          display: none !important;
        }

        /* If right is expanded, hide the left group to make space */
        .movi-buttons-row:has(.movi-controls-right.expanded) .movi-controls-left {
           display: none !important;
        }
        
        /* Alternative for older browsers: shrink left instead of hiding if :has not supported */
        .movi-controls-right.expanded {
           flex: 1;
           justify-content: flex-end;
        }
        
        /* Allow menus to position relative to the controls bar/player on mobile */
        .movi-controls-right,
        .movi-mobile-expandable,
        .movi-audio-track-container,
        .movi-subtitle-track-container,
        .movi-quality-container,
        .movi-speed-container {
             position: static !important;
        }

        /* Position menus correctly on mobile */
        .movi-audio-track-menu,
        .movi-subtitle-track-menu,
        .movi-quality-menu,
        .movi-speed-menu {
          position: absolute !important;
          bottom: 100% !important;
          margin-bottom: 15px !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          width: 90% !important;
          max-width: 300px !important;
          /* Constrain height: min of 60% viewport height OR 30% viewport width (fits ~108px on 360px wide 16:9 player, strictly avoiding top clip) */
          max-height: min(60vh, 30vw) !important;
          overflow-y: auto !important;
          z-index: 2000 !important;
          -webkit-overflow-scrolling: touch !important;
          /* Ensure scrollbar doesn't take up space/looks clean */
          scrollbar-width: thin;
        }
        
        /* Give more vertical space in fullscreen */
        :host(:fullscreen) .movi-audio-track-menu,
        :host(:fullscreen) .movi-subtitle-track-menu,
        :host(:fullscreen) .movi-quality-menu,
        :host(:fullscreen) .movi-speed-menu {
           max-height: 70vh !important;
        }
      }

      /* Desktop: Hide More button */
      @media (min-width: 641px) {
        .movi-more-btn {
          display: none !important;
        }
        .movi-mobile-expandable {
          display: contents; /* Effectively removes the wrapper on desktop */
        }
      }

      
      /* Tablet devices (641px to 1024px) */
      @media (min-width: 641px) and (max-width: 1024px) {
        .movi-controls-bar {
          padding: 14px 18px;
        }
        
        .movi-time {
          font-size: 12px;
        }
      }
      
      /* Large screens (1025px and above) */
      @media (min-width: 1025px) {
        .movi-controls-bar {
          padding: 16px 24px;
        }
      }
      
      /* Touch device optimizations */
      @media (hover: none) and (pointer: coarse) {
        /* Aggressively disable animations on touch interactions */
        .movi-controls-container,
        .movi-controls-overlay,
        .movi-center-play-pause,
        .movi-btn,
        .movi-btn svg,
        .movi-progress-bar,
        .movi-volume-slider,
        .movi-volume-slider-container {
          transition: none !important;
          animation: none !important;
        }

        /* Remove backdrop filter which causes white flashes on some mobile GPUs */
        .movi-controls-bar {
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          background: rgba(10, 10, 18, 0.95) !important; /* Solid dark background fallback */
        }

        /* Light theme mobile controls bar */
        :host([theme="light"]) .movi-controls-bar {
          background: rgba(255, 255, 255, 0.95) !important;
        }

        /* Remove the slide-up/down effect */
        .movi-controls-container,
        .movi-controls-container.movi-controls-hidden,
        .movi-controls-container.movi-controls-visible {
          transform: none !important;
        }

        /* Ensure opacity toggle is instant */
        .movi-controls-container.movi-controls-hidden {
           opacity: 0 !important;
        }
        .movi-controls-container.movi-controls-visible {
           opacity: 1 !important;
        }

        /* Center button focus/hover reset for touch devices */
        .movi-center-play-pause:hover,
        .movi-center-play-pause:focus,
        .movi-center-play-pause:active {
           background: color-mix(in srgb, var(--movi-primary) 40%, transparent) !important;
           border-color: color-mix(in srgb, var(--movi-primary) 60%, transparent) !important;
           box-shadow: 0 8px 32px color-mix(in srgb, var(--movi-primary) 40%, transparent) !important;
        }

        .movi-center-play-pause svg {
           color: var(--movi-controls-color) !important;
           fill: var(--movi-controls-color) !important;
           filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3)) !important;
        }

        .movi-center-play-pause:hover svg,
        .movi-center-play-pause:focus svg {
           color: var(--movi-controls-color) !important;
           fill: var(--movi-controls-color) !important;
           filter: drop-shadow(0 0 8px color-mix(in srgb, var(--movi-primary) 60%, transparent)) !important;
        }

        .movi-btn:hover svg,
        .movi-btn:focus svg {
           filter: none !important;
        }

        /* Center button: Keep structural transform but remove transition */
        .movi-center-play-pause {
           transform: translate(-50%, -50%) !important;
           transition: none !important;
        }

        /* Override button states to prevent white background flash */
        .movi-btn {
          background: transparent !important;
          transition: none !important;
        }

        .movi-btn:hover,
        .movi-btn:focus,
        .movi-btn:active {
          background: transparent !important;
          transform: none !important;
          box-shadow: none !important;
        }

        /* Ensure volume slider container interactions didn't rely on hover */
        .movi-volume-slider-container {
           /* display: none !important; REMOVED */
        }
      }

      /* Loading indicator - positioned over video area */
      .movi-loading-indicator {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        pointer-events: none;
        background: transparent;
      }

      .movi-loader-container {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        display: inline-block;
        border-top: 4px solid var(--movi-controls-color);
        border-right: 4px solid transparent;
        box-sizing: border-box;
        animation: movi-loader-spin 1s linear infinite;
        filter: drop-shadow(0 0 8px rgba(0, 0, 0, 0.3));
      }

      /* Mobile loader - smaller size */
      @media (max-width: 640px) {
        .movi-loader-container {
          width: 48px;
          height: 48px;
          border-top-width: 3px;
          border-right-width: 3px;
        }
      }

      @keyframes movi-loader-spin {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }

      /* Center play/pause button */
      .movi-center-play-pause {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.8);
        z-index: 5;
        width: 88px;
        height: 88px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--movi-primary) 25%, transparent);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        padding: 0;
        border: 2px solid color-mix(in srgb, var(--movi-primary) 40%, transparent);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity var(--movi-transition-bounce), transform var(--movi-transition-bounce), visibility 0s linear 0.3s;
        box-shadow: 0 8px 32px color-mix(in srgb, var(--movi-primary) 25%, transparent), inset 0 0 0 1px rgba(255, 255, 255, 0.1);
      }

      .movi-center-play-pause.movi-center-visible {
        opacity: 1;
        visibility: visible;
        transform: translate(-50%, -50%) scale(1);
        pointer-events: auto;
        transition-delay: 0s;
      }

      .movi-center-play-pause:hover {
        background: color-mix(in srgb, var(--movi-primary) 40%, transparent);
        border-color: color-mix(in srgb, var(--movi-primary) 60%, transparent);
        box-shadow: 0 8px 40px color-mix(in srgb, var(--movi-primary) 40%, transparent), inset 0 0 0 1px rgba(255, 255, 255, 0.15);
      }

      .movi-center-play-pause.movi-center-visible:hover {
        transform: translate(-50%, -50%) scale(1.08);
      }

      .movi-center-play-pause:active {
        transform: translate(-50%, -50%) scale(0.92);
      }

      .movi-center-play-pause.movi-center-visible:active {
        transform: translate(-50%, -50%) scale(0.92);
      }

      .movi-center-play-pause svg {
        width: 48px;
        height: 48px;
        color: var(--movi-controls-color);
        fill: var(--movi-controls-color);
        transition: all var(--movi-transition-fast);
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
      }

      .movi-center-play-pause:hover svg {
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--movi-primary) 60%, transparent));
      }

      /* Play icon offset for optical centering */
      .movi-center-icon-play {
        margin-left: 6px;
        display: block;
      }

      .movi-center-play-pause:focus {
        outline: none !important;
        border-color: color-mix(in srgb, var(--movi-primary) 50%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--movi-primary) 30%, transparent), 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      
      /* Mobile center button sizing */
      @media (max-width: 640px) {
        .movi-center-play-pause {
          width: 72px;
          height: 72px;
        }
        
        .movi-center-play-pause svg {
          width: 36px;
          height: 36px;
        }
      }

      /* Subtitle overlay - HTML element for better performance */
      .movi-subtitle-overlay {
        position: absolute;
        bottom: 12%;
        left: 0;
        right: 0;
        z-index: 5;
        pointer-events: none;
        display: none;
        text-align: center;
        padding: 0 5%;
        transition: padding-bottom 0.3s ease;
      }

      /* Subtitle shift is handled via JS in showControls/hideControls */

      .movi-subtitle-line {
        color: #FFFFFF;
        font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
        font-size: clamp(18px, 3vw, 42px);
        font-weight: 500;
        line-height: 1.4;
        text-shadow: 
          0 0 4px rgba(0, 0, 0, 0.8),
          0 2px 4px rgba(0, 0, 0, 0.8);
        margin: 2px 0;
        padding: 2px 6px;
        white-space: pre-wrap;
        word-wrap: break-word;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        transform: translateZ(0); /* Force hardware acceleration for better rendering */
      }

      /* Context Menu */
      .movi-context-menu {
        position: absolute;
        background: rgba(15, 15, 22, 0.95);
        backdrop-filter: blur(30px);
        -webkit-backdrop-filter: blur(30px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        padding: 8px 4px; /* Consistent with submenus */
        min-width: 220px;
        z-index: 10000;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        color: var(--movi-controls-color);
        overflow: visible;
        letter-spacing: 0.01em;
        transition: transform 0.2s ease, opacity 0.2s ease, visibility 0.2s;
        box-sizing: border-box;
      }

      .movi-context-menu-backdrop {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 19999;
        display: none;
      }

      .movi-context-menu-icon {
        width: 16px;
        height: 16px;
        margin-right: 12px;
        opacity: 0.7;
        transition: all 0.2s ease;
      }

      @media (hover: hover) {
        .movi-context-menu-item:hover .movi-context-menu-icon {
          opacity: 1;
          color: var(--movi-primary-light);
        }
      }

      .movi-context-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        cursor: pointer;
        user-select: none;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        margin: 2px 6px;
        border-radius: 10px;
        letter-spacing: 0.01em;
      }

      @media (hover: hover) {
        .movi-context-menu-item:hover {
          background-color: rgba(255, 255, 255, 0.08);
          transform: scale(1.02);
        }

        :host([theme="light"]) .movi-context-menu-item:hover {
          background-color: rgba(0, 0, 0, 0.05);
        }

        .movi-context-menu-item:hover .movi-context-menu-arrow {
          transform: translateX(2px);
          color: var(--movi-primary-light);
        }
      }

      .movi-context-menu-item:active {
        background-color: rgba(255, 255, 255, 0.12);
        transform: scale(0.98);
        transition: transform 0.1s ease;
      }

      .movi-context-menu-item.movi-context-menu-disabled {
        opacity: 0.3;
        pointer-events: none;
      }

      .movi-context-menu-item.movi-context-menu-active {
        background-color: color-mix(in srgb, var(--movi-primary) 0.12);
        color: var(--movi-primary-light);
        font-weight: 600;
      }
      
      .movi-context-menu-item.movi-context-menu-active::before {
        content: '';
        position: absolute;
        left: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 12px;
        background: var(--movi-primary);
        border-radius: 4px;
        box-shadow: 0 0 10px var(--movi-primary);
      }

      /* Adjust label position for active indicator */
      .movi-context-menu-item.movi-context-menu-active .movi-context-menu-label {
        padding-left: 8px;
      }

      .movi-context-menu-label {
        flex: 1;
      }

      .movi-context-menu-shortcut {
        color: var(--movi-text-tertiary);
        font-size: 12px;
        margin-left: 16px;
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        font-weight: 500;
      }

      .movi-context-menu-arrow {
        color: var(--movi-text-tertiary);
        font-size: 10px;
        margin-left: 8px;
        transition: transform var(--movi-transition-fast);
      }

      .movi-context-menu-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.1);
        margin: 8px 0;
      }

      .movi-context-menu-submenu {
        position: absolute;
        left: 100%;
        top: 0;
        margin-left: 4px;
        background: rgba(15, 15, 22, 0.95);
        backdrop-filter: blur(30px);
        -webkit-backdrop-filter: blur(30px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        padding: 8px 4px;
        min-width: 160px;
        visibility: hidden;
        opacity: 0;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        z-index: 10001;
        transform: translateX(-8px);
        transition: transform 0.2s ease, opacity 0.2s ease, visibility 0.2s;
        pointer-events: none;
        max-height: 250px;
        overflow-y: auto;
      }

      .movi-context-menu-submenu.movi-context-menu-submenu-visible {
        visibility: visible !important;
        opacity: 1 !important;
        transform: translateX(0) !important;
        pointer-events: auto !important;
      }
      
      .movi-context-menu-submenu-audio,
      .movi-context-menu-submenu-subtitle {
        position: absolute;
        left: 100%;
        top: 0;
        margin-left: 4px;
        background: rgba(15, 15, 22, 0.95);
        backdrop-filter: blur(30px);
        -webkit-backdrop-filter: blur(30px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        padding: 8px 4px;
        min-width: 160px;
        visibility: hidden;
        opacity: 0;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        z-index: 10001;
        transform: translateX(-8px);
        transition: transform 0.2s ease, opacity 0.2s ease, visibility 0.2s;
        pointer-events: none;
        max-height: 250px;
        overflow-y: auto;
      }
      
      .movi-context-menu-submenu-audio.movi-context-menu-submenu-visible,
      .movi-context-menu-submenu-subtitle.movi-context-menu-submenu-visible {
        visibility: visible !important;
        opacity: 1 !important;
        transform: translateX(0) !important;
        pointer-events: auto !important;
      }

      /* Custom Scrollbar for Submenus & Control Menus */
      .movi-context-menu-submenu::-webkit-scrollbar,
      .movi-context-menu-submenu-audio::-webkit-scrollbar,
      .movi-context-menu-submenu-subtitle::-webkit-scrollbar,
      .movi-audio-track-menu::-webkit-scrollbar,
      .movi-subtitle-track-menu::-webkit-scrollbar,
      .movi-quality-menu::-webkit-scrollbar,
      .movi-speed-menu::-webkit-scrollbar {
        width: 6px;
      }

      /* Quality Menu */
      /* Quality Menu */
      .movi-quality-container {
        position: relative;
        display: flex;
        align-items: center; 
      }

      .movi-quality-menu {
        position: absolute;
        bottom: calc(100% + 12px);
        right: 0; /* Align to right like speed menu */
        left: auto; /* Reset left */
        transform: none; /* Reset transform */
        margin-bottom: 0;
        background: var(--movi-glass-bg);
        backdrop-filter: blur(var(--movi-glass-blur));
        -webkit-backdrop-filter: blur(var(--movi-glass-blur));
        border: 1px solid var(--movi-glass-border);
        border-radius: 12px;
        min-width: 200px;
        max-height: 280px;
        overflow-y: auto;
        box-shadow: var(--movi-shadow-lg);
        z-index: 1001;
        pointer-events: auto !important;
        padding: 8px 0;
        white-space: nowrap;
      }
      
      .movi-quality-item {
        padding: 8px 16px;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.9);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        transition: background 0.2s;
        font-weight: 500;
      }
      
      .movi-quality-item:hover {
        background: rgba(255, 255, 255, 0.1);
      }
      
      .movi-quality-item.movi-quality-active {
        color: var(--movi-primary);
        font-weight: 600;
        background: color-mix(in srgb, var(--movi-primary) 0.1);
      }

      .movi-quality-check {
         width: 14px;
         height: 14px;
         margin-left: 8px;
      }

      /* Hide speed/quality menus on mobile by default and position them centrally */
      @media (max-width: 640px) {
         .movi-quality-menu {
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            width: 80%;
            max-width: 280px;
            max-height: 50vh;
            overflow-y: auto;
         }
      }
      .movi-speed-menu::-webkit-scrollbar {
        width: 6px;
      }
      
      .movi-context-menu-submenu::-webkit-scrollbar-track,
      .movi-context-menu-submenu-audio::-webkit-scrollbar-track,
      .movi-context-menu-submenu-subtitle::-webkit-scrollbar-track,
      .movi-audio-track-menu::-webkit-scrollbar-track,
      .movi-subtitle-track-menu::-webkit-scrollbar-track,
      .movi-speed-menu::-webkit-scrollbar-track {
        background: transparent;
      }
      
      .movi-context-menu-submenu::-webkit-scrollbar-thumb,
      .movi-context-menu-submenu-audio::-webkit-scrollbar-thumb,
      .movi-context-menu-submenu-subtitle::-webkit-scrollbar-thumb,
      .movi-audio-track-menu::-webkit-scrollbar-thumb,
      .movi-subtitle-track-menu::-webkit-scrollbar-thumb,
      .movi-speed-menu::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.05); /* Stealth by default */
        border-radius: 10px;
        background-clip: padding-box;
        border: 2px solid transparent;
        transition: background 0.3s;
      }

      .movi-context-menu-submenu::-webkit-scrollbar-thumb:hover,
      .movi-context-menu-submenu-audio::-webkit-scrollbar-thumb:hover,
      .movi-context-menu-submenu-subtitle::-webkit-scrollbar-thumb:hover,
      .movi-audio-track-menu::-webkit-scrollbar-thumb:hover,
      .movi-subtitle-track-menu::-webkit-scrollbar-thumb:hover,
      .movi-speed-menu::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
        background-clip: padding-box;
      }

      /* Seek Thumbnail */
      .movi-seek-thumbnail {
        position: absolute;
        bottom: 25px;
        left: 0;
        transform: translateX(-50%);
        background-color: rgba(28, 28, 28, 0.9);
        color: white;
        padding: 6px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 500;
        pointer-events: none;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.1s ease;
        box-shadow: 0 4px 8px rgba(0,0,0,0.6);
        overflow: hidden;
        z-index: 20;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .movi-thumbnail-img {
        display: block;
        width: auto;
        height: auto;
        max-width: 180px;
        max-height: 200px;
        object-fit: contain;
        margin-bottom: 4px;
        border: 1px solid #333;
        border-radius: 2px;
        pointer-events: none;
      }
      .movi-seek-thumbnail.visible {
        opacity: 1;
      }

      .movi-seek-chapter-title {
        display: none;
        font-size: 11px;
        font-weight: 600;
        color: #fff;
        text-align: center;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 4px;
        margin-bottom: 2px;
        position: relative;
        z-index: 2;
      }

      .movi-seek-time {
        position: relative;
        z-index: 2;
      }

      .movi-thumbnail-img {
        position: relative;
        z-index: 1;
      }
      
      @keyframes movi-shimmer-anim {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }

      .movi-thumbnail-placeholder {
        width: auto;
        height: auto;
        min-width: 0;
        min-height: 0;
        margin: 0;
        padding: 0;
        border: none;
        background: transparent;
        animation: none;
      }
      
      
      
      .movi-progress-container {
        position: relative; 
      }

      /* OSD Notification Styles */
      .movi-osd-container {
        position: absolute;
        top: 40px;
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        background: rgba(15, 15, 20, 0.85);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        padding: 12px 24px;
        border-radius: 30px;
        display: none; /* Flex when visible */
        align-items: center;
        justify-content: center;
        gap: 12px;
        z-index: 1000;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease, transform 0.3s ease;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      }
      
      .movi-osd-container.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      
      .movi-osd-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--movi-primary);
      }
      
      .movi-osd-icon svg {
        width: 24px;
        height: 24px;
      }
      
      .movi-osd-text {
        font-size: 16px;
        font-weight: 600;
        color: white;
        font-family: 'Inter', sans-serif;
        letter-spacing: 0.02em;
      }
      
      .movi-broken-indicator {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle at center, rgba(30, 30, 30, 0.4) 0%, rgba(10, 10, 10, 0.95) 100%);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        color: white;
        font-family: 'Inter', sans-serif;
        text-align: center;
        padding: 40px;
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        opacity: 0;
        animation: movi-fade-in 0.5s ease forwards;
      }

      @keyframes movi-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      .movi-broken-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        max-width: 320px;
        animation: movi-slide-up 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes movi-slide-up {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      
      .movi-broken-icon-wrapper {
        position: relative;
        width: 80px;
        height: 80px;
        margin-bottom: 24px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      }
      
      .movi-broken-icon-wrapper svg {
        width: 44px;
        height: 44px;
        filter: drop-shadow(0 0 15px rgba(255, 68, 68, 0.4));
      }
      
      .movi-broken-title {
        font-size: 22px;
        font-weight: 700;
        margin: 0 0 10px 0;
        letter-spacing: -0.02em;
        background: linear-gradient(to bottom, #fff, #bbb);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        text-align: center;
      }
      
      .movi-broken-text {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      
      .movi-broken-message {
        font-size: 14px;
        line-height: 1.6;
        color: rgba(255, 255, 255, 0.6);
        margin: 0;
        font-weight: 400;
        text-align: center;
      }
      
      .movi-sw-fallback-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin-top: 16px;
        padding: 10px 20px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        color: #fff;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      
      .movi-sw-fallback-btn:hover {
        background: rgba(255, 255, 255, 0.25);
        border-color: rgba(255, 255, 255, 0.4);
        transform: scale(1.02);
      }
      
      .movi-sw-fallback-btn svg {
        flex-shrink: 0;
      }

      /* Empty State Indicator */
      .movi-empty-state {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 5;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center;
        padding: 40px;
        opacity: 0;
        animation: movi-fade-in 0.4s ease forwards;
      }

      .movi-empty-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
      }

      .movi-empty-icon-wrapper {
        width: 96px;
        height: 96px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.6;
      }

      .movi-empty-icon-wrapper svg {
        width: 100%;
        height: 100%;
      }

      .movi-empty-title {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
        color: rgba(255, 255, 255, 0.9);
        letter-spacing: -0.01em;
      }

      .movi-empty-text {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }

      .movi-empty-message {
        font-size: 13px;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.5);
        margin: 0;
        font-weight: 400;
      }

      /* Mobile Responsiveness for Context Menu - Side Panel Mode */
      @media (max-width: 1024px), (pointer: coarse) {
        .movi-context-menu.movi-context-menu-mobile {
          position: absolute;
          top: 0 !important;
          right: 0 !important;
          left: auto !important;
          width: 80% !important;
          max-width: 350px !important;
          height: 100% !important;
          border-radius: 0 !important;
          border-left: 1px solid rgba(255, 255, 255, 0.1) !important;
          padding: 16px 8px !important;
          flex-direction: column;
          box-shadow: -10px 0 50px rgba(0, 0, 0, 0.8) !important;
          transform: translateX(100%) !important;
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1) !important;
          display: flex !important;
          visibility: visible !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          min-width: 0 !important;
          box-sizing: border-box !important;
          z-index: 20000 !important;
        }

        /* Light theme mobile context menu */
        :host([theme="light"]) .movi-context-menu.movi-context-menu-mobile {
          border-left-color: rgba(0, 0, 0, 0.1) !important;
          box-shadow: -10px 0 50px rgba(0, 0, 0, 0.2) !important;
        }

        .movi-context-menu.movi-context-menu-mobile.visible {
          transform: translateX(0) !important;
        }

        .movi-context-menu-item {
          padding: 10px 14px !important;
          margin: 2px 4px !important;
          font-size: 14px !important;
        }

        .movi-context-menu-icon {
          width: 18px !important;
          height: 18px !important;
          margin-right: 12px !important;
        }

        .movi-context-menu-submenu,
        .movi-context-menu-submenu-audio,
        .movi-context-menu-submenu-subtitle {
          position: absolute !important;
          top: 0 !important;
          right: 0 !important;
          left: auto !important;
          width: 100% !important;
          height: 100% !important;
          margin: 0 !important;
          border-radius: 0 !important;
          border: none !important;
          z-index: 20001 !important;
          background: rgba(15, 15, 22, 0.98) !important;
          transform: translateX(100%) !important;
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
          display: block !important;
          visibility: visible !important;
          pointer-events: none !important;
          max-height: none !important;
          overflow-x: hidden !important;
          min-width: 0 !important;
          box-sizing: border-box !important;
          padding: 16px 8px !important;
        }

        .movi-context-menu-submenu.movi-context-menu-submenu-visible,
        .movi-context-menu-submenu-audio.movi-context-menu-submenu-visible,
        .movi-context-menu-submenu-subtitle.movi-context-menu-submenu-visible {
          transform: translateX(0) !important;
          pointer-events: auto !important;
          opacity: 1 !important;
        }

        .movi-context-menu-shortcut {
          display: none !important; /* Shortcuts don't make sense on mobile */
        }

        /* Light theme mobile submenus */
        :host([theme="light"]) .movi-context-menu-submenu,
        :host([theme="light"]) .movi-context-menu-submenu-audio,
        :host([theme="light"]) .movi-context-menu-submenu-subtitle {
          background: rgba(255, 255, 255, 0.98) !important;
        }
      }

      /* Mobile Responsiveness for Context Menu */
      @media (max-width: 600px) {
        .movi-context-menu {
          min-width: 160px;
          font-size: 13px;
        }
        .movi-context-menu-item {
          padding: 8px 12px;
        }
        .movi-context-menu-shortcut {
          font-size: 10px;
          margin-left: 8px;
        }
        .movi-context-menu-submenu {
            min-width: 130px;
        }
        .movi-seek-thumbnail {
            transform: translateX(-50%) scale(0.85);
            bottom: 40px;
        }
        
        .movi-osd-container {
            top: 20px; 
        }
      }
    `;
    shadowRoot.appendChild(style);
  }

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    Logger.warn(TAG, "WebGL context lost - suspending playback");

    if (this.player) {
      try {
        this._contextLostTime = this.player.getCurrentTime();
        this._contextLostPlaying = this.player.getState() === "playing";
        this.player.destroy();
      } catch (err) {
        // Ignore error during destroy context loss
      }
      this.player = null;
    }

    this.isLoading = true;
    this.updateControlsState();
    this.updateLoadingIndicator("loading");
  };

  private handleContextRestored = () => {
    Logger.info(TAG, "WebGL context restored - recovering playback");
    this.initializePlayer().then(() => {
      if (this.player) {
        if (this._contextLostTime > 0) {
          this.player.seek(this._contextLostTime).catch(() => {});
        }
        if (this._contextLostPlaying) {
          this.player.play().catch(() => {});
        }
      }
    });
  };

  connectedCallback() {
    // Read initial attributes
    const srcAttr = this.getAttribute("src");
    this._src = srcAttr || null;
    this._autoplay = this.hasAttribute("autoplay");
    this._controls = this.hasAttribute("controls");
    this._loop = this.hasAttribute("loop");
    this._muted = this.hasAttribute("muted");
    this._playsinline = this.hasAttribute("playsinline");
    this._preload =
      (this.getAttribute("preload") as "none" | "metadata" | "auto") || "auto";
    this._poster = this.getAttribute("poster") || "";
    const volumeAttr = this.getAttribute("volume");
    if (volumeAttr) this._volume = parseFloat(volumeAttr);
    const playbackRateAttr = this.getAttribute("playbackrate");
    if (playbackRateAttr) this._playbackRate = parseFloat(playbackRateAttr);
    this._ambientMode = this.hasAttribute("ambientmode");
    this._ambientWrapper = this.getAttribute("ambientwrapper");
    const objectFitAttr = this.getAttribute("objectfit");
    if (objectFitAttr) {
      const validFitModes: (
        | "contain"
        | "cover"
        | "fill"
        | "zoom"
        | "control"
      )[] = ["contain", "cover", "fill", "zoom", "control"];
      this._objectFit = validFitModes.includes(
        objectFitAttr.toLowerCase() as any,
      )
        ? (objectFitAttr.toLowerCase() as
            | "contain"
            | "cover"
            | "fill"
            | "zoom"
            | "control")
        : "contain";
    }

    // Update fit mode based on attributes
    this.updateFitMode();

    this._thumb = this.hasAttribute("thumb");
    this._hdr = this.hasAttribute("hdr") || this.getAttribute("hdr") === null; // Default to true if attribute is missing
    const themeAttr = this.getAttribute("theme");
    if (themeAttr === "light" || themeAttr === "dark") {
      this._theme = themeAttr;
    }

    this._gesturefs = this.hasAttribute("gesturefs");
    this._noHotkeys = this.hasAttribute("nohotkeys");
    this._fastSeek = this.hasAttribute("fastseek");
    this._doubleTap =
      !this.hasAttribute("doubletap") ||
      this.getAttribute("doubletap") !== "false"; // Default true unless explicitly false

    const startAtAttr = this.getAttribute("startat");
    if (startAtAttr) {
      this._startAt = parseFloat(startAtAttr);
    }

    const bufferSizeAttr = this.getAttribute("buffersize");
    if (bufferSizeAttr) {
      this._bufferSize = parseFloat(bufferSizeAttr);
    }

    this._themeColor = this.getAttribute("themecolor");
    if (this._themeColor) {
      this.style.setProperty("--movi-primary", this._themeColor);
    }

    this._watermark = this.getAttribute("watermark");
    this.updateWatermark();

    // Update controls visibility based on initial attributes
    this.updateControlsVisibility();

    // Get external ambient wrapper element by ID
    this.updateAmbientWrapperElement();

    // Initialize ambient mode if enabled
    this.updateAmbientMode();

    // Update HDR UI to match default state
    this.updateHDRUI();

    // Update canvas size when element is connected
    this.updateCanvasSize();

    // Listen for WebGL context loss (e.g. minimizing on mobile)
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );

    // Initial state: disable controls except volume
    this.updateControlsState();
    this.updatePlayPauseIcon();
    this.updateFastSeek();
    this.updatePoster();

    // Listen for resize events
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        this.updateCanvasSize();
      });
      resizeObserver.observe(this);
    } else {
      // Fallback for browsers without ResizeObserver
      window.addEventListener("resize", () => {
        this.updateCanvasSize();
      });
    }

    // Initial visibility check
    this.updateControlsVisibility();

    // Check for required security headers
    this.checkSecurityHeaders();

    // Read encrypted attributes
    this._encrypted = this.hasAttribute("encrypted");
    this._tokenUrl = this.getAttribute("tokenurl") || "";
    this._videoUrl = this.getAttribute("videourl") || "";
    this._videoId = this.getAttribute("videoid") || "";
    this._resume = this.hasAttribute("resume");
    this._stableVolume = this.hasAttribute("stablevolume");

    // If no src attribute, check for <source> child elements (Video.js-style)
    if (!this._src && !this._encrypted) {
      const sourceEls = this.querySelectorAll("source");
      if (sourceEls.length > 0) {
        const allSources = Array.from(sourceEls).map((el) => ({
          src: el.getAttribute("src") || "",
          type: el.getAttribute("type") || undefined,
          kind: el.getAttribute("kind") || undefined,
        })).filter((s) => s.src);

        // Separate audio sources (kind="audio") from video sources
        const audioSources = allSources.filter((s) => s.kind === "audio");
        const videoSources = allSources.filter((s) => s.kind !== "audio");

        if (videoSources.length > 0) {
          const picked = this.pickSource(videoSources);
          this._src = picked ? picked.src : videoSources[0].src;
        }

        if (audioSources.length > 0) {
          this._audioSrc = audioSources[0].src;
        }
      }
    }

    // Automatically initialize player if src is set or encrypted mode
    if (this._src || (this._encrypted && this._tokenUrl && this._videoUrl)) {
      this.initializePlayer();
    }

    // Load saved settings (OPFS)
    SettingsStorage.getInstance()
      .load()
      .then((settings) => {
        let changed = false;

        // Apply volume if not explicitly set by attribute
        if (!this.hasAttribute("volume") && settings.volume !== undefined) {
          this._volume = settings.volume;
          this.updateVolume();
          changed = true;
        }

        // Apply muted if not explicitly set
        if (!this.hasAttribute("muted") && settings.muted !== undefined) {
          this._muted = settings.muted;
          this.updateMuted();
          changed = true;
        }

        // Apply playbackRate if not explicitly set
        if (
          !this.hasAttribute("playbackrate") &&
          settings.playbackRate !== undefined
        ) {
          this._playbackRate = settings.playbackRate;
          this.updatePlaybackRate();
          changed = true;
        }

        if (changed) {
          this.updateVolumeIcon();
          // Update external attributes to reflect loaded state
          if (settings.volume !== undefined)
            this.setAttribute("volume", settings.volume.toString());
          if (settings.muted) this.setAttribute("muted", "");
          if (settings.playbackRate !== undefined)
            this.setAttribute("playbackrate", settings.playbackRate.toString());
        }
      });
  }

  disconnectedCallback() {
    // Remove WebGL context listeners
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    // Cleanup nerd stats interval
    if (this.nerdStatsInterval) {
      clearInterval(this.nerdStatsInterval);
      this.nerdStatsInterval = null;
    }

    // Save position and stop resume saving
    if (this._resume) this.saveResumePosition();
    this.stopResumeSaving();

    // Cleanup event handlers
    this.eventHandlers.forEach((unsubscribe) => unsubscribe());
    this.eventHandlers.clear();

    // Remove document-level context menu handler
    if ((this as any)._documentContextMenuHandler) {
      document.removeEventListener(
        "contextmenu",
        (this as any)._documentContextMenuHandler,
        { capture: true },
      );
      delete (this as any)._documentContextMenuHandler;
    }

    // Stop ambient mode color sampling
    this.stopAmbientColorSampling();

    // Cleanup player when element is removed
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
  }

  attributeChangedCallback(
    name: string,
    _oldValue: string | null,
    newValue: string | null,
  ) {
    switch (name) {
      case "thumb":
        this._thumb = newValue !== null;
        break;
      case "hdr":
        this.hdr = newValue !== null;
        break;
      case "theme":
        this.theme = (newValue as "light" | "dark") || "dark";
        break;
      case "gesturefs":
        this._gesturefs = newValue !== null;
        break;
      case "nohotkeys":
        this._noHotkeys = newValue !== null;
        break;
      case "startat":
        this._startAt = newValue ? parseFloat(newValue) : 0;
        break;
      case "fastseek":
        this._fastSeek = newValue !== null;
        this.updateFastSeek();
        break;
      case "doubletap":
        // usage: doubletap="false" to disable. Check existence? Or value?
        // Standard boolean attribute: presence = true.
        // But user might want to disable it.
        // Let's assume standard boolean: present = enabled? No, default is enabled.
        // Let's say attribute 'nodoubletap' or 'doubletap="false"'.
        // Re-reading user request: "doubletap (Boolean)"
        // Usually boolean attributes are false if missing, true if present.
        // If default is true, we should probably use 'disable-doubletap' or check for string "false".
        // Let's stick to: if attribute is present and not "false", it's true.
        // Wait, the request says property doubletap.
        // Let's assume if the attribute is present it sets the boolean value.
        // Since I made default true, logic is:
        this._doubleTap = newValue !== "false";
        break;
      case "themecolor":
        this._themeColor = newValue;
        if (newValue) {
          this.style.setProperty("--movi-primary", newValue);
        } else {
          this.style.removeProperty("--movi-primary");
        }
        break;
      case "buffersize":
        this._bufferSize = newValue ? parseFloat(newValue) : 0;
        // Propagate to player if possible
        break;
      case "watermark":
        this._watermark = newValue;
        this.updateWatermark();
        break;
      case "title":
        this._title = newValue;
        this.updateTitle();
        break;
      case "showtitle":
        this._showTitle = newValue !== null;
        this.updateTitle();
        break;
      case "resume":
        this._resume = newValue !== null;
        break;
      case "stablevolume":
        this._stableVolume = newValue !== null;
        if (this.player) {
          this.player.setStableAudio(this._stableVolume);
          this.updateStableAudioUI();
        }
        break;
      case "encrypted":
        this._encrypted = newValue !== null;
        break;
      case "tokenurl":
        this._tokenUrl = newValue || "";
        break;
      case "videourl":
        this._videoUrl = newValue || "";
        break;
      case "videoid":
        this._videoId = newValue || "";
        break;
      case "src":
        // Only handle string src attributes, File objects are handled via setter
        if (!(this._src instanceof File)) {
          const oldSrc = this._src;
          this._src = newValue || null;

          // Show/hide empty state indicator based on src
          if (this.emptyStateIndicator) {
            if (!this._src && !this.player) {
              this.emptyStateIndicator.style.display = "flex";
            } else {
              this.emptyStateIndicator.style.display = "none";
            }
          }

          // If src changed and element is connected, reload
          if (this.isConnected && this._src && this._src !== oldSrc) {
            this.load();
          }
        }
        break;
      case "autoplay":
        this._autoplay = newValue !== null;
        break;
      case "controls":
        this._controls = newValue !== null;
        this.updateControlsVisibility();
        break;
      case "loop":
        this._loop = newValue !== null;
        this.updateLoopUI();
        // Update loop handler if player exists
        if (this.player) {
          this.setupEventHandlers();
        }
        break;
      case "muted":
        this._muted = newValue !== null;
        if (this.video) {
          this.video.muted = this._muted;
        }
        if (this._autoplay) {
          this.play();
        } else if (this._startAt > 0 && this.player) {
          // Seek to start time if set
          this.player.seek(this._startAt);
        }
        break;
      case "playsinline":
        this._playsinline = newValue !== null;
        if (this.video) {
          this.video.playsInline = this._playsinline;
        }
        break;
      case "preload":
        this._preload = (newValue as "none" | "metadata" | "auto") || "auto";
        break;
      case "poster":
        this._poster = newValue || "";
        this.updatePoster();
        break;
      case "width":
      case "height":
        this.updateCanvasSize();
        break;
      case "crossorigin":
        // Store but not used yet - would need MoviPlayer to support CORS
        break;
      case "volume":
        if (newValue !== null) {
          this._volume = parseFloat(newValue);
          if (this.player) {
            this.updateVolume();
          }
        }
        break;
      case "playbackrate":
        if (newValue !== null) {
          this._playbackRate = parseFloat(newValue);
          if (this.player) {
            this.updatePlaybackRate();
          }
        }
        break;
      case "ambientmode":
        this._ambientMode = newValue !== null;
        this.updateAmbientMode();
        break;
      case "ambientwrapper":
        this._ambientWrapper = newValue;
        this.updateAmbientWrapperElement();
        this.updateAmbientMode();
        break;
      case "renderer":
        // Default to canvas if invalid or null
        const validRenderers: RendererType[] = ["canvas"];
        const newRenderer: RendererType = validRenderers.includes(
          newValue as RendererType,
        )
          ? (newValue as RendererType)
          : "canvas";
        if (this._renderer !== newRenderer) {
          this._renderer = newRenderer;
          // Reload if source exists to apply renderer change
          if (this.isConnected && this._src) {
            this.load();
          }
        }
        break;
      case "objectfit":
        const validFitModes: (
          | "contain"
          | "cover"
          | "fill"
          | "zoom"
          | "control"
        )[] = ["contain", "cover", "fill", "zoom", "control"];
        const newFitMode =
          newValue && validFitModes.includes(newValue.toLowerCase() as any)
            ? (newValue.toLowerCase() as
                | "contain"
                | "cover"
                | "fill"
                | "zoom"
                | "control")
            : "contain";
        if (this._objectFit !== newFitMode) {
          this._objectFit = newFitMode;
          this.updateFitMode();
        }
        break;
      case "sw":
        if (newValue === "auto") {
          this._sw = "auto";
        } else if (newValue === "false") {
          this._sw = "auto";
        } else {
          this._sw = newValue !== null ? "software" : "auto";
        }
        // If sw attribute changes and element is connected with src, reload
        if (this.isConnected && this._src) {
          this.load();
        }
        break;
      case "fps":
        this._fps = newValue ? parseFloat(newValue) : 0;
        // If fps changes and element is connected with src, reload
        if (this.isConnected && this._src) {
          this.load();
        }
        break;
    }
  }

  private updateCanvasSize() {
    const widthAttr = this.getAttribute("width");
    const heightAttr = this.getAttribute("height");

    let width: number;
    let height: number;

    // In fullscreen, use viewport dimensions
    if (document.fullscreenElement === this) {
      width = window.innerWidth;
      height = window.innerHeight;
    } else {
      const rect = this.getBoundingClientRect();
      width = widthAttr ? parseInt(widthAttr, 10) : rect.width;
      height = heightAttr ? parseInt(heightAttr, 10) : rect.height;
    }

    if (width > 0 && height > 0) {
      // Update canvas dimensions
      // Update canvas dimensions
      this.canvas.width = width;
      this.canvas.height = height;

      // CSS layout is handled by CanvasRenderer and style.width='100%' default
      // Removing manual pixel overrides prevents conflict with rotation logic

      // Update video dimensions
      this.video.width = width;
      this.video.height = height;

      // Reconfigure video renderer with new canvas dimensions
      if (this.player) {
        this.player.resizeCanvas(width, height);
      }
    }
  }

  private updateMuted() {
    if (this.player) {
      // When muted, disable audio track processing (saves CPU)
      this.player.setMuted(this._muted);
      this.updateVolumeIcon();
    }
  }

  private updateVolume() {
    if (this.player) {
      // Only update volume if not muted (muted state overrides volume)
      if (!this._muted) {
        this.player.setVolume(this._volume);
      }
    }
    // Always update icon immediately to ensure UI reflects state even if not playing
    this.updateVolumeIcon();

    // Show OSD for volume (volume is 0-1, show as 0-100%)
    if (this.isConnected && !this.isLoading) {
      const volumePercent = Math.round(this._volume * 100);
      let icon = "";
      if (this._muted || this._volume === 0) {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
      } else if (this._volume < 0.5) {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
      } else {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
      }

      // Only show if user interacting or specifically requested (simple logic: just check if player exists to avoid startup spam)
      // We add a check for timestamp to avoid showing on initial page load if we had a persistent volume setter
      // For now, simpler is better: if connected and player is ready
      // AND checks if audio tracks exist before showing OSD
      if (this.player && this.player.getAudioTracks().length > 0) {
        this.showOSD(icon, `${volumePercent}%`);
      }
    }
  }

  private updatePlaybackRate() {
    if (this.player) {
      this.player.setPlaybackRate(this._playbackRate);
    }

    // Update menu UI to match current rate
    const speedItems = this.shadowRoot?.querySelectorAll(".movi-speed-item");
    speedItems?.forEach((item) => {
      const speed = parseFloat((item as HTMLElement).dataset.speed || "1");
      if (Math.abs(speed - this._playbackRate) < 0.01) {
        // Float comparison
        item.classList.add("movi-speed-active");
      } else {
        item.classList.remove("movi-speed-active");
      }
    });

    // Show OSD for speed
    if (this.isConnected && !this.isLoading && this.player) {
      this.showOSD(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.64 18.36a9 9 0 1 1 12.72 0"></path><path d="m12 12 4-4"></path></svg>`,
        `${this._playbackRate}x`,
      );
    }
  }

  private updateFitMode() {
    if (this.player) {
      if (this._objectFit === "control") {
        this.player.setFitMode(this._currentFit);
      } else {
        this.player.setFitMode(this._objectFit as any);
      }
    }

    // Ensure icon matches the state immediately
    this.updateAspectRatioIcon();
  }

  /**
   * Automatically create and initialize MoviPlayer
   */
  private async initializePlayer(): Promise<void> {
    // If encrypted mode, use loadEncrypted instead
    if (this._encrypted && this._tokenUrl && this._videoUrl && !this.isLoading && !this.player) {
      try {
        const { generateFingerprint } = await import("../utils/Fingerprint");
        const fingerprint = await generateFingerprint();
        await this.loadEncrypted({
          videoUrl: this._videoUrl,
          tokenUrl: this._tokenUrl,
          videoId: this._videoId || "default",
          fingerprint,
          sessionToken: "session-" + Date.now(),
        });
      } catch (e) {
        Logger.error("MoviElement", "Failed to initialize encrypted source", e);
      }
      return;
    }

    if (!this._src || this.isLoading || this.player || this._isUnsupported) {
      return;
    }

    this.isLoading = true;

    // Hide empty state indicator when loading begins
    if (this.emptyStateIndicator) {
      this.emptyStateIndicator.style.display = "none";
    }

    try {
      // Determine source type (URL or File)
      let source: SourceConfig;
      if (this._src instanceof File) {
        // File object - use FileSource
        source = { type: "file", file: this._src };
      } else if (typeof this._src === "string") {
        // String - check if it's a URL
        if (
          this._src.startsWith("http://") ||
          this._src.startsWith("https://")
        ) {
          source = { type: "url", url: this._src };
        } else if (
          this._src.startsWith("blob:") ||
          this._src.startsWith("data:")
        ) {
          source = { type: "url", url: this._src };
        } else {
          // Assume it's a file path - treat as URL
          source = { type: "url", url: this._src };
        }
      } else {
        throw new Error("Invalid source type");
      }

      // Create MoviPlayer instance
      // Configure MoviPlayer options
      const playerConfig: any = {
        source,
        decoder: this._sw,
        cache: { type: "lru", maxSizeMB: 520 },
        enablePreviews: this._thumb,
        ...(this._fps > 0 && { frameRate: this._fps }),
      };

      // Separate audio source — multi-language or single
      if (this._audioTracks.length > 0) {
        playerConfig.audioTracks = this._audioTracks.map((t) => ({
          url: t.src,
          type: t.type,
          lang: t.lang,
          label: t.label,
        }));
      } else if (this._audioSrc) {
        playerConfig.audioSource = { type: "url", url: this._audioSrc } as SourceConfig;
      }

      // External subtitle tracks
      if (this._subtitleTracks.length > 0) {
        playerConfig.subtitleTracks = this._subtitleTracks.map((t) => ({
          url: t.src,
          lang: t.lang,
          label: t.label,
          format: (t.format as "vtt" | "srt" | undefined),
        }));
      }

      // DRM mode: use native video element for HLS (EME requires <video>)
      const isDrm = this.hasAttribute("drm");
      const isHLS = typeof this._src === "string" &&
        (this._src.includes(".m3u8") || this._src.toLowerCase().endsWith("m3u8"));

      if (isDrm && isHLS) {
        playerConfig.renderer = "video";
        playerConfig.drm = true;
        playerConfig.licenseUrl = this.getAttribute("licenseurl") || "";
        this.canvas.style.display = "none";
        this.video.style.display = "block";
      } else {
        playerConfig.renderer = "canvas";
        playerConfig.canvas = this.canvas;
        this.canvas.style.display = "block";
        this.video.style.display = "none";
      }

      // Create Player instance
      const mode = playerConfig.drm ? "DRM/Native Video" : "Canvas Renderer";
      Logger.info(TAG, `Initializing MoviPlayer (${mode} Mode)`);
      this.player = new MoviPlayer(playerConfig);

      // In DRM mode, use HLS wrapper's video element directly
      if (playerConfig.drm) {
        const hlsVideo = this.player.getHLSVideoElement();
        if (hlsVideo && this.video) {
          // Replace our video element with HLS's video element
          hlsVideo.style.width = "100%";
          hlsVideo.style.height = "100%";
          hlsVideo.style.display = "block";
          hlsVideo.style.objectFit = "contain";
          this.video.replaceWith(hlsVideo);
          this.video = hlsVideo;
          Logger.info(TAG, "DRM: Swapped in HLS native video element");
        }
      }

      // Reset unsupported state
      this._isUnsupported = false;
      if (this.brokenIndicator) this.brokenIndicator.style.display = "none";

      this.updateControlsState();

      // Set up event handlers
      this.setupEventHandlers();

      // Show loading indicator
      this.updateLoadingIndicator("loading");

      // Set subtitle overlay for HTML-based rendering
      if (this.player) {
        this.player.setSubtitleOverlay(this.subtitleOverlay);
      }

      // Load the video
      // Load the video
      if (this.player) {
        await this.player.load();
      }

      // Check for software decoding fallback (only for MoviPlayer/Canvas mode)
      // Don't show broken icon if sw attribute is set (user explicitly wants software decoding)
      if (
        this.player instanceof MoviPlayer &&
        this.player.isSoftwareDecoding() &&
        this._sw !== "software" &&
        this.getAttribute("sw") !== "auto" // Silent fallback for explicit "auto"
      ) {
        Logger.warn(
          TAG,
          "Hardware decoding not supported, falling back to software. Showing broken icon as per user request.",
        );
        this.handleUnsupportedVideo(
          "Format Unsupported",
          "This video codec is not supported by your browser's hardware acceleration.",
        );
        return;
      }

      // Apply properties
      this.updateVolume();
      this.updateMuted(); // Apply muted state before autoplay
      this.updatePlaybackRate();
      this.updateCanvasSize(); // Ensure canvas size is synced after load overwrites
      this.updateFitMode();
      if (this.player) {
        this.player.setHDREnabled(this._hdr);
        this.player.setStableAudio(this._stableVolume);
        this.updateStableAudioUI();
      }
      this.updateHDRVisibility();
      this.updateControlsVisibility();
      this.updateControlsState();

      // Update loading indicator after load
      this.updateLoadingIndicator();

      // Auto-play if requested
      // Seek to initial position if set
      if (this._startAt > 0 && this.player) {
        await this.player.seek(this._startAt).catch((e: unknown) => {
          Logger.warn(TAG, "Failed to seek to start time", e);
        });
      } else if (this._resume && this.player) {
        // Show resume dialog if saved position exists
        const savedTime = this.getResumePosition();
        if (savedTime > 2 && savedTime < this.duration - 5) {
          this.showResumeDialog(savedTime);
        }
      }

      // Start saving position periodically if resume enabled
      if (this._resume) {
        this.startResumeSaving();
      }

      // Auto-play if requested
      if (this._autoplay && this.player) {
        await this.player.play().catch(() => {
          // Autoplay may fail due to browser policies
        });
      } else {
        // Render first frame (poster) if not autoplaying and no custom start time
        if (this._startAt === 0 && this.player) {
          this.player.seek(0).catch(() => {});
        }
      }

      // Start UI updates
      this.startUIUpdates();

      // Initialize ambient mode if enabled
      this.updateAmbientMode();
      this.updateAmbientUI();

      // Dispatch load event
      this.dispatchEvent(new Event("loadeddata"));
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      Logger.error(TAG, "Failed to initialize MoviPlayer", error);

      let message = "An unexpected error occurred while loading the video.";
      let title = "Initialization Failed";

      if (error instanceof Error) {
        message = error.message;

        // Check for CORS errors - these typically show as "Load failed" TypeError
        if (
          message.includes("Load failed") ||
          message.toLowerCase().includes("cors") ||
          message.toLowerCase().includes("access-control-allow-origin")
        ) {
          title = "Network Error";
          message =
            "Failed to fetch video resource. Check your connection or CORS settings.";
        } else if (message.includes("fetch")) {
          title = "Network Error";
          message =
            "Failed to fetch video resource. Check your connection or try again.";
        } else if (message.includes("decode")) {
          title = "Playback Error";
        }
      }

      this.handleUnsupportedVideo(title, message);
    } finally {
      this.isLoading = false;
      this.updateControlsState();
      this.updatePlayPauseIcon();
    }
  }

  /**
   * Set up event handlers for the player
   */
  private setupEventHandlers(): void {
    if (!this.player) return;

    // Remove existing listeners
    this.eventHandlers.forEach((unsubscribe) => unsubscribe());
    this.eventHandlers.clear();

    // Handle loop
    if (this._loop) {
      const loopHandler = () => {
        this.play();
      };
      this.player.on("ended", loopHandler);
      this.eventHandlers.set("ended", () =>
        this.player?.off("ended", loopHandler),
      );
    }

    // Handle audio track changes
    const audioTrackChangeHandler = () => {
      this.updateAudioTrackMenu();
      this.updateSubtitleTrackMenu();
      this.dispatchEvent(new Event("audiotrackchange"));
    };
    this.player.trackManager.on("audioTrackChange", audioTrackChangeHandler);
    this.eventHandlers.set("audioTrackChange", () =>
      this.player?.trackManager.off(
        "audioTrackChange",
        audioTrackChangeHandler,
      ),
    );

    // Handle subtitle track changes
    const subtitleTrackChangeHandler = () => {
      this.updateSubtitleTrackMenu();
      this.dispatchEvent(new Event("subtitleTrackChange"));
    };
    this.player.trackManager.on(
      "subtitleTrackChange",
      subtitleTrackChangeHandler,
    );
    this.eventHandlers.set("subtitleTrackChange", () =>
      this.player?.trackManager.off(
        "subtitleTrackChange",
        subtitleTrackChangeHandler,
      ),
    );

    // Handle tracks change (when media loads)
    const tracksChangeHandler = () => {
      this.updateAudioTrackMenu();
      this.updateSubtitleTrackMenu();
      this.updateQualityMenu();
      this.renderChapterMarkers();
    };
    this.player.trackManager.on("tracksChange", tracksChangeHandler);
    this.eventHandlers.set("tracksChange", () =>
      this.player?.trackManager.off("tracksChange", tracksChangeHandler),
    );

    // Forward player events to element
    const stateChangeHandler = (state: PlayerState) => {
      Logger.info(TAG, `stateChange: ${state}`);
      // Hide poster on state change to playing
      if (state === "playing" && this.posterElement) {
        this.posterElement.style.display = "none";
      }

      this.dispatchEvent(new CustomEvent("statechange", { detail: state }));
      this.updateLoadingIndicator(state);
      this.updateControlsState();
      this.updatePlayPauseIcon();

      if (state === "playing") {
        this.dispatchEvent(new Event("play"));
        this.showControls();
      } else if (state === "paused") {
        this.dispatchEvent(new Event("pause"));
        this.showControls();
        if (this._resume) this.saveResumePosition();
      } else if (state === "ended") {
        this.dispatchEvent(new Event("ended"));
        this.showControls();
        // Clear resume position when video ends (start fresh next time)
        if (this._resume) this.clearResumePosition();
      }
    };
    this.player.on("stateChange", stateChangeHandler);
    this.eventHandlers.set("stateChange", () =>
      this.player?.off("stateChange", stateChangeHandler),
    );

    // Handle loadEnd event to hide loading indicator
    const loadEndHandler = () => {
      this.updateLoadingIndicator(this.player?.getState() || "idle");
      this.updateControlsState();
      this.updatePlayPauseIcon();
      this.dispatchEvent(new Event("loadeddata"));
    };
    this.player.on("loadEnd", loadEndHandler);
    this.eventHandlers.set("loadEnd", () =>
      this.player?.off("loadEnd", loadEndHandler),
    );

    const timeUpdateHandler = (time: number) => {
      this.dispatchEvent(new CustomEvent("timeupdate", { detail: time }));
    };
    this.player.on("timeUpdate", timeUpdateHandler);
    this.eventHandlers.set("timeUpdate", () =>
      this.player?.off("timeUpdate", timeUpdateHandler),
    );

    const errorHandler = (error: unknown) => {
      this.dispatchEvent(new CustomEvent("error", { detail: error }));

      let message = "An error occurred during playback.";
      let title = "Playback Error";

      if (error instanceof Error) {
        message = error.message;
      } else if (typeof error === "string") {
        message = error;
      }

      this.handleUnsupportedVideo(title, message);
    };
    this.player.on("error", errorHandler);
    this.eventHandlers.set("error", () =>
      this.player?.off("error", errorHandler),
    );
  }

  /**
   * Load the video source (automatic when src is set)
   */
  async load(): Promise<void> {
    // Reset auto-loaded title flag and duration tracker for new video
    this._titleAutoLoaded = false;
    this._lastDuration = 0;

    this.resetTimeline();

    // Clear chapter markers
    if (this.shadowRoot) {
      const markers = this.shadowRoot.querySelector(".movi-chapter-markers") as HTMLElement;
      if (markers) markers.innerHTML = "";
    }

    if (this.player) {
      // If player exists, destroy and recreate
      this.player.destroy();
      this.player = null;
    }

    // Show empty state if no src after player cleanup
    if (!this._src && this.emptyStateIndicator) {
      this.emptyStateIndicator.style.display = "flex";
    }

    await this.initializePlayer();
  }

  /**
   * Play the video
   */
  async play(): Promise<void> {
    if (this.player && !this.isLoading && !this._isUnsupported) {
      await this.player.play();
    }
  }

  /**
   * Pause the video
   */
  pause(): void {
    if (this.player && !this.isLoading && !this._isUnsupported) {
      this.player.pause();
    }
  }

  get theme(): "dark" | "light" {
    return this._theme;
  }

  set theme(value: "dark" | "light") {
    if (this._theme !== value) {
      this._theme = value;
      if (value) {
        this.setAttribute("theme", value);
      } else {
        this.removeAttribute("theme");
      }
    }
  }

  /**
   * Get the internal canvas element
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  // Property getters/setters (native video element API)
  private updatePlayPauseIcon(): void {
    const playIcon = this.shadowRoot?.querySelector(
      ".movi-icon-play",
    ) as HTMLElement;
    const pauseIcon = this.shadowRoot?.querySelector(
      ".movi-icon-pause",
    ) as HTMLElement;
    const centerPlayPauseBtn = this.shadowRoot?.querySelector(
      ".movi-center-play-pause",
    ) as HTMLElement;

    // Show play button if not playing (ready, paused, ended, idle states)
    // Show pause button only when playing
    const isPlaying = this.player?.getState() === "playing";
    const loadingIndicator = this.shadowRoot?.querySelector(
      ".movi-loading-indicator",
    ) as HTMLElement;
    const isLoading = loadingIndicator?.style.display === "flex";

    const contextMenuPlayIcon = this.shadowRoot?.querySelector(
      ".movi-context-menu-play-icon",
    ) as HTMLElement;
    const contextMenuPauseIcon = this.shadowRoot?.querySelector(
      ".movi-context-menu-pause-icon",
    ) as HTMLElement;
    const contextMenuLabel = this.shadowRoot?.querySelector(
      '.movi-context-menu-item[data-action="play-pause"] .movi-context-menu-label',
    ) as HTMLElement;

    const centerPlayIcon = centerPlayPauseBtn?.querySelector(
      ".movi-center-icon-play",
    ) as HTMLElement;
    const centerPauseIcon = centerPlayPauseBtn?.querySelector(
      ".movi-center-icon-pause",
    ) as HTMLElement;

    if (isPlaying) {
      playIcon?.style.setProperty("display", "none");
      pauseIcon?.style.setProperty("display", "block");

      // Update context menu
      contextMenuPlayIcon?.style.setProperty("display", "none");
      contextMenuPauseIcon?.style.setProperty("display", "block");
      if (contextMenuLabel) contextMenuLabel.textContent = "Pause";

      // Show center pause icon when playing (if not loading/unsupported)
      if (isLoading || this._isUnsupported) {
        if (centerPlayPauseBtn) {
          centerPlayPauseBtn.classList.remove("movi-center-visible");
        }
      } else if (centerPlayPauseBtn) {
        centerPlayIcon?.style.setProperty("display", "none");
        centerPauseIcon?.style.setProperty("display", "block");

        // Only show if controls are visible
        const controlsHidden = this.controlsContainer?.classList.contains(
          "movi-controls-hidden",
        );
        if (!controlsHidden) {
          requestAnimationFrame(() => {
            centerPlayPauseBtn.classList.add("movi-center-visible");
          });
        } else {
          centerPlayPauseBtn.classList.remove("movi-center-visible");
        }
      }
    } else {
      playIcon?.style.setProperty("display", "block");
      pauseIcon?.style.setProperty("display", "none");

      // Update context menu
      contextMenuPlayIcon?.style.setProperty("display", "block");
      contextMenuPauseIcon?.style.setProperty("display", "none");
      if (contextMenuLabel) contextMenuLabel.textContent = "Play";

      // Show center play icon when paused/ready, but hide if loading or unsupported state is shown
      if (isLoading || this._isUnsupported) {
        if (centerPlayPauseBtn) {
          centerPlayPauseBtn.classList.remove("movi-center-visible");
        }
      } else {
        if (centerPlayPauseBtn) {
          centerPlayIcon?.style.setProperty("display", "block");
          centerPauseIcon?.style.setProperty("display", "none");

          // Use a small delay for smooth transition
          requestAnimationFrame(() => {
            centerPlayPauseBtn.classList.add("movi-center-visible");
          });
        }
      }
    }
  }

  private updateTimeDisplay(): void {
    const currentTimeEl = this.shadowRoot?.querySelector(
      ".movi-current-time",
    ) as HTMLElement;
    const durationEl = this.shadowRoot?.querySelector(
      ".movi-duration",
    ) as HTMLElement;

    if (currentTimeEl) {
      currentTimeEl.textContent = this.formatTime(this.currentTime);
    }
    if (durationEl) {
      durationEl.textContent = this.formatTime(this.duration);
    }

    // Trigger title auto-load when duration first becomes available
    if (this._lastDuration === 0 && this.duration > 0) {
      this._lastDuration = this.duration;
      // Call updateTitle to check if we need to auto-load from metadata
      this.updateTitle();
    }
  }

  /**
   * Render chapter markers on the progress bar (YouTube-style)
   */
  private renderChapterMarkers(): void {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot || !this.player) return;

    const container = shadowRoot.querySelector(".movi-chapter-markers") as HTMLElement;
    if (!container) return;

    container.innerHTML = "";

    const chapters = this.player.getChapters();
    const duration = this.player.getDuration();
    if (chapters.length === 0 || duration <= 0) return;

    // Add chapter dividers (gaps between chapters)
    for (let i = 1; i < chapters.length; i++) {
      const ch = chapters[i];
      const percent = (ch.start / duration) * 100;

      const marker = document.createElement("div");
      marker.className = "movi-chapter-marker";
      marker.style.left = `${percent}%`;

      // Tooltip with chapter title
      marker.setAttribute("data-title", ch.title);

      container.appendChild(marker);
    }

    // Add chapter segment hover labels
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const startPct = (ch.start / duration) * 100;
      const endPct = i < chapters.length - 1
        ? (chapters[i + 1].start / duration) * 100
        : 100;

      const segment = document.createElement("div");
      segment.className = "movi-chapter-segment";
      segment.style.left = `${startPct}%`;
      segment.style.width = `${endPct - startPct}%`;
      segment.setAttribute("data-title", ch.title);

      container.appendChild(segment);
    }
  }

  private updateProgressBar(): void {
    // Don't update visuals if user is scrubbing or seeking
    if (this.isDragging || this.isTouchDragging || this.isSeeking) return;

    const progressFilled = this.shadowRoot?.querySelector(
      ".movi-progress-filled",
    ) as HTMLElement;
    const progressHandle = this.shadowRoot?.querySelector(
      ".movi-progress-handle",
    ) as HTMLElement;
    const progressBuffer = this.shadowRoot?.querySelector(
      ".movi-progress-buffer",
    ) as HTMLElement;

    if (this.duration > 0) {
      const percent = (this.currentTime / this.duration) * 100;
      if (progressFilled) {
        progressFilled.style.width = `${percent}%`;
      }
      if (progressHandle) {
        progressHandle.style.left = `${percent}%`;
      }

      // Update buffer (if available) - Show continuous buffered range from start
      if (this.player && progressBuffer) {
        const bufferEnd = this.player.getBufferEndTime();

        if (bufferEnd > 0) {
          // Show buffer from 0 to bufferEnd (continuous appearance, no gaps)
          const endPercent = (bufferEnd / this.duration) * 100;

          progressBuffer.style.left = "0%";
          progressBuffer.style.width = `${endPercent}%`;
        } else {
          progressBuffer.style.width = "0%";
        }
      }
    }
  }

  private updateVolumeIcon(): void {
    const volumeHigh = this.shadowRoot?.querySelector(
      ".movi-icon-volume-high",
    ) as HTMLElement;
    const volumeLow = this.shadowRoot?.querySelector(
      ".movi-icon-volume-low",
    ) as HTMLElement;
    const volumeMute = this.shadowRoot?.querySelector(
      ".movi-icon-volume-mute",
    ) as HTMLElement;
    const volumeSlider = this.shadowRoot?.querySelector(
      ".movi-volume-slider",
    ) as HTMLInputElement;

    if (volumeSlider) {
      volumeSlider.value = this._muted ? "0" : this._volume.toString();
    }

    // Reset all first
    volumeHigh?.style.setProperty("display", "none");
    volumeLow?.style.setProperty("display", "none");
    volumeMute?.style.setProperty("display", "none");

    if (this._muted || this._volume === 0) {
      volumeMute?.style.setProperty("display", "block");
    } else if (this._volume < 0.5) {
      volumeLow?.style.setProperty("display", "block");
    } else {
      volumeHigh?.style.setProperty("display", "block");
    }
  }

  private updateLoadingIndicator(state?: string): void {
    const loadingIndicator = this.shadowRoot?.querySelector(
      ".movi-loading-indicator",
    ) as HTMLElement;
    if (!loadingIndicator) return;

    const currentState = state || this.player?.getState() || "idle";
    const duration = this.player?.getDuration() || 0;

    // Show loading only when playback is interrupted:
    // - 'loading': initial load (but only if not playing yet)
    // - 'seeking': seeking (interrupts playback)
    // - 'buffering': buffering (interrupts playback)
    // Don't show loading during normal 'playing' state, even if duration is 0
    let shouldShow = false;

    // Only show loading for interruption states
    if (currentState === "seeking" || currentState === "buffering") {
      shouldShow = true;
    } else if (currentState === "loading" && duration === 0) {
      // Show loading only during initial load when duration is not yet available
      // Once playing starts, don't show loading even if duration is still 0
      shouldShow = true;
    }

    if (shouldShow) {
      loadingIndicator.style.display = "flex";
      // Hide center play button when loading is shown
      const centerPlayPauseBtn = this.shadowRoot?.querySelector(
        ".movi-center-play-pause",
      ) as HTMLElement;
      if (centerPlayPauseBtn) {
        centerPlayPauseBtn.classList.remove("movi-center-visible");
      }
    } else {
      loadingIndicator.style.display = "none";
      // Center play button visibility will be managed by updatePlayPauseIcon
    }
  }

  private formatTime(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      // Format: H:MM:SS (e.g., 1:02:30)
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    // Format: MM:SS (e.g., 00:26, 01:30, 14:47)
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  private handleUnsupportedVideo(title?: string, message?: string): void {
    const msgLower = message?.toLowerCase() || "";
    const isNetworkError = msgLower.includes("http 4") || msgLower.includes("http 5") ||
      msgLower.includes("stream unavailable") || msgLower.includes("network error") ||
      msgLower.includes("hls error");
    const isDecoderError = !isNetworkError && (
      title === "Format Unsupported" ||
      title === "Codec Unsupported" ||
      title === "Playback Error" ||
      msgLower.includes("decoder") ||
      msgLower.includes("codec"));

    // Silent fallback if sw="auto" is set
    if (
      isDecoderError &&
      this.getAttribute("sw") === "auto" &&
      this._sw !== "software"
    ) {
      Logger.info(
        TAG,
        'Decoder error detected with sw="auto", triggering silent software fallback',
      );
      this.enableSoftwareDecoding();
      return;
    }

    this._isUnsupported = true;

    // Stop player
    if (this.player) {
      const state = this.player.getState();
      if (state !== "idle" && state !== "loading" && state !== "error") {
        try {
          this.player.pause();
        } catch (e) {}
      }
    }

    // Show broken indicator
    if (this.brokenIndicator) {
      this.brokenIndicator.style.display = "flex";

      // Update text if provided
      if (title) {
        const titleEl =
          this.brokenIndicator.querySelector(".movi-broken-title");
        if (titleEl) titleEl.textContent = title;
      }
      if (message) {
        const messageEl = this.brokenIndicator.querySelector(
          ".movi-broken-message",
        );
        if (messageEl) messageEl.textContent = message;
      }

      // Show/hide the software fallback button based on parameter
      const swFallbackBtn = this.brokenIndicator.querySelector(
        ".movi-sw-fallback-btn",
      ) as HTMLElement;
      if (swFallbackBtn) {
        // Show the button for hardware acceleration or decoder failures (not for network errors)
        // Don't show if already using software decoding
        const shouldShowSwButton =
          isDecoderError &&
          this._sw !== "software" &&
          this.getAttribute("sw") !== "false";
        swFallbackBtn.style.display = shouldShowSwButton ? "flex" : "none";
      }
    }

    // Hide loading indicator
    const loadingIndicator = this.shadowRoot?.querySelector(
      ".movi-loading-indicator",
    ) as HTMLElement;
    if (loadingIndicator) loadingIndicator.style.display = "none";

    // Hide center play button in error state
    const centerPlayPauseBtn = this.shadowRoot?.querySelector(
      ".movi-center-play-pause",
    ) as HTMLElement;
    if (centerPlayPauseBtn) {
      centerPlayPauseBtn.classList.remove("movi-center-visible");
    }

    // Update controls
    this.updateControlsVisibility();
    this.updateControlsState();
    this.updatePlayPauseIcon();
    this.updateQualityMenu(); // Update quality menu
  }

  /**
   * Check if required security headers (COOP/COEP) are present
   * These headers are required for SharedArrayBuffer support (needed by FFmpeg)
   */
  private checkSecurityHeaders(): void {
    // Check if Cross-Origin-Isolated context is available
    if (!window.crossOriginIsolated) {
      Logger.warn(
        TAG,
        "Security headers missing: Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy are required",
      );

      // Show error message
      if (this.brokenIndicator) {
        this.brokenIndicator.style.display = "flex";

        const titleEl =
          this.brokenIndicator.querySelector(".movi-broken-title");
        if (titleEl) titleEl.textContent = "Security Headers Missing";

        const messageEl = this.brokenIndicator.querySelector(
          ".movi-broken-message",
        );
        if (messageEl) {
          messageEl.textContent =
            "This player requires Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp headers to be set on the server.";
        }

        // Hide the software fallback button (not applicable for header issues)
        const swFallbackBtn = this.brokenIndicator.querySelector(
          ".movi-sw-fallback-btn",
        ) as HTMLElement;
        if (swFallbackBtn) {
          swFallbackBtn.style.display = "none";
        }
      }

      // Prevent player initialization
      this._isUnsupported = true;
    }
  }

  /**
   * Enable software decoding and reload the video
   */
  private async enableSoftwareDecoding(): Promise<void> {
    Logger.info(TAG, "User requested software decoding fallback");

    // Reset unsupported state
    this._isUnsupported = false;

    // Hide broken indicator
    if (this.brokenIndicator) {
      this.brokenIndicator.style.display = "none";
    }

    // Set sw attribute to enable software decoding
    this._sw = "software";
    this.setAttribute("sw", "");

    // Get current source
    const currentSrc = this._src;

    // Destroy current player if exists
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }

    // Reset loading state so initializePlayer can run
    this.isLoading = false;

    // Show loading indicator
    const loadingIndicator = this.shadowRoot?.querySelector(
      ".movi-loading-indicator",
    ) as HTMLElement;
    if (loadingIndicator) loadingIndicator.style.display = "flex";

    // Re-initialize with software decoding
    if (currentSrc) {
      try {
        // Call initializePlayer directly since src hasn't changed
        await this.initializePlayer();
      } catch (e) {
        Logger.error(TAG, "Failed to initialize with software decoding", e);
        this.handleUnsupportedVideo(
          "Playback Error",
          "Failed to play video even with software decoding.",
        );
      }
    }
  }

  private updateControlsState(): void {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    // Initial state: No player, or currently loading
    // But don't treat it as initial if it's already unsupported
    const isInitial = (!this.player || this.isLoading) && !this._isUnsupported;
    const isUnsupported = this._isUnsupported;

    // Controls to disable (everything except volume)
    const controlsToDisableSelector =
      ".movi-play-pause, .movi-progress-container, .movi-audio-track-btn, .movi-subtitle-track-btn, .movi-hdr-btn, .movi-speed-btn, .movi-stable-audio-btn, .movi-aspect-ratio-btn, .movi-loop-btn, .movi-pip-btn, .movi-fullscreen-btn, .movi-more-btn, .movi-center-play-pause, .movi-seek-backward, .movi-seek-forward";
    const controlsToDisable = shadowRoot.querySelectorAll(
      controlsToDisableSelector,
    );

    controlsToDisable.forEach((control) => {
      const el = control as HTMLElement;
      if (isUnsupported || isInitial) {
        // Completely hide center play button in error state
        if (el.classList.contains("movi-center-play-pause")) {
          el.style.display = "none";
          el.style.opacity = "0";
          el.classList.remove("movi-center-visible");
        } else {
          el.style.opacity = "0.4";
        }
        el.style.pointerEvents = "none";
        if (el.tagName === "BUTTON") (el as HTMLButtonElement).disabled = true;
      } else {
        // Special case for center play button: clear opacity to let CSS classes manage it
        if (el.classList.contains("movi-center-play-pause")) {
          el.style.display = "";
          el.style.opacity = "";
        } else {
          el.style.opacity = "1";
        }
        el.style.pointerEvents = "auto";
        if (el.tagName === "BUTTON") (el as HTMLButtonElement).disabled = false;
      }
    });

    // Volume controls (enabled in initial state, disabled in unsupported state)
    const volumeControls = shadowRoot.querySelectorAll(
      ".movi-volume-container, .movi-volume-btn, .movi-volume-slider",
    );
    volumeControls.forEach((control) => {
      const el = control as HTMLElement;
      if (isUnsupported) {
        el.style.opacity = "0.4";
        el.style.pointerEvents = "none";
        if (el.tagName === "BUTTON") (el as HTMLButtonElement).disabled = true;
        if (el.tagName === "INPUT") (el as HTMLInputElement).disabled = true;
      } else {
        el.style.opacity = "1";
        el.style.pointerEvents = "auto";
        if (el.tagName === "BUTTON") (el as HTMLButtonElement).disabled = false;
        if (el.tagName === "INPUT") (el as HTMLInputElement).disabled = false;
      }
    });

    // Context menu actions
    const contextMenuItems = shadowRoot.querySelectorAll(
      ".movi-context-menu-item",
    );
    contextMenuItems.forEach((item) => {
      const el = item as HTMLElement;
      // Note: context menu doesn't have a volume action yet
      if (isUnsupported || isInitial) {
        el.style.opacity = "0.4";
        el.style.pointerEvents = "none";
      } else {
        el.style.opacity = "1";
        el.style.pointerEvents = "auto";
      }
    });
  }

  private updateAmbientWrapperElement(): void {
    if (this._ambientWrapper) {
      this.ambientWrapperElement = document.getElementById(
        this._ambientWrapper,
      );
      if (this.ambientWrapperElement) {
        // Add transition for smooth color changes
        this.ambientWrapperElement.style.transition = "background 0.5s ease";
      }
    } else {
      this.ambientWrapperElement = null;
    }
  }

  private updateAmbientMode(): void {
    if (this._ambientMode) {
      if (this.ambientWrapperElement) {
        this.ambientWrapperElement.style.opacity = "1";
      }
      this.startAmbientColorSampling();
    } else {
      if (this.ambientWrapperElement) {
        this.ambientWrapperElement.style.opacity = "0";
      }
      // Reset letterbox to black
      this.player?.setLetterboxColor(0, 0, 0);
      this.stopAmbientColorSampling();
    }
  }

  private startAmbientColorSampling(): void {
    if (this._ambientRafId !== null) return;

    // Create helper canvas if needed for performance optimization
    if (!this._ambientSampleCanvas) {
      this._ambientSampleCanvas = document.createElement("canvas"); // Not attached to DOM
      this._ambientSampleCanvas.width = 10;
      this._ambientSampleCanvas.height = 10;
      // Hint browser that we will read this frequently
      this._ambientSampleCtx = this._ambientSampleCanvas.getContext("2d", {
        willReadFrequently: true,
      });
    }

    const loop = (timestamp: number) => {
      // If software decoding is active, pause ambient sampling to save main thread cycles
      // This is crucial for CPU-heavy 4K software decoding
      const isSoftware = this.player?.isSoftwareDecoding() ?? false;
      if (isSoftware) {
        this._lastAmbientSampleTime = timestamp; // Keep advancing time but skip work
        this._ambientRafId = requestAnimationFrame(loop);
        return;
      }

      if (
        timestamp - this._lastAmbientSampleTime >=
        this._ambientSampleInterval
      ) {
        const start = performance.now();
        this.sampleCanvasColors();
        const duration = performance.now() - start;

        this._lastAmbientSampleTime = timestamp;

        // Adaptive sampling rate based on performance
        // If taking > 8ms, slow down significantly to avoid blocking main thread
        if (duration > 8) {
          this._ambientSampleInterval = Math.min(
            2000,
            this._ambientSampleInterval * 1.5,
          );
          // Only log periodically or if significant change to avoid spam
          if (this._ambientSampleInterval < 2000) {
            Logger.debug(
              TAG,
              `Ambient sampling taking too long (${duration.toFixed(1)}ms), slowing down to ${this._ambientSampleInterval.toFixed(0)}ms`,
            );
          }
        } else if (duration < 2 && this._ambientSampleInterval > 100) {
          // If very fast, we can speed up slightly, but cap at 10fps (100ms) as ambient doesn't need 60fps
          this._ambientSampleInterval = Math.max(
            100,
            this._ambientSampleInterval * 0.9,
          );
        }
      }
      this._ambientRafId = requestAnimationFrame(loop);
    };

    // Initial sample
    this.sampleCanvasColors();
    this._lastAmbientSampleTime = performance.now();
    this._ambientRafId = requestAnimationFrame(loop);
  }

  private stopAmbientColorSampling(): void {
    if (this._ambientRafId !== null) {
      cancelAnimationFrame(this._ambientRafId);
      this._ambientRafId = null;
    }
  }

  private sampleCanvasColors(): void {
    if (!this.canvas || !this.player) return;

    // Use helper canvas context if available, otherwise fallback (should exist from start)
    const ctx = this._ambientSampleCtx;
    if (!ctx) return;

    try {
      // Draw the main canvas into the 10x10 helper canvas
      // This allows the GPU to handle the downscaling which is much faster than processing 40k pixels in JS
      ctx.clearRect(0, 0, 10, 10);
      ctx.drawImage(this.canvas, 0, 0, 10, 10);

      const imageData = ctx.getImageData(0, 0, 10, 10);
      const data = imageData.data;

      // Calculate average color
      let r = 0,
        g = 0,
        b = 0;
      let count = 0;

      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }

      if (count > 0) {
        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);

        // Smooth color transition
        const smoothingFactor = 0.6; // Keep original smoothing
        this.currentAmbientColors = {
          r: Math.floor(
            this.currentAmbientColors.r +
              (r - this.currentAmbientColors.r) * smoothingFactor,
          ),
          g: Math.floor(
            this.currentAmbientColors.g +
              (g - this.currentAmbientColors.g) * smoothingFactor,
          ),
          b: Math.floor(
            this.currentAmbientColors.b +
              (b - this.currentAmbientColors.b) * smoothingFactor,
          ),
        };
        this.updateAmbientBackground();
      }
    } catch (error) {
      // Silently fail if canvas is not accessible (e.g., CORS) or context lost
    }
  }

  private updateAmbientBackground(): void {
    const { r, g, b } = this.currentAmbientColors;

    // Create a gradient with the sampled color
    // Use radial gradient for smooth ambient effect without lines
    let color1, color2, color3, color4;

    if (this._theme === "light") {
      // Significantly higher opacity for light mode to be visible against white/light backgrounds
      // Brighter, more saturated effect
      color1 = `rgba(${r}, ${g}, ${b}, 0.5)`;
      color2 = `rgba(${r}, ${g}, ${b}, 0.3)`;
      color3 = `rgba(${r}, ${g}, ${b}, 0.15)`;
      color4 = `rgba(${r}, ${g}, ${b}, 0.05)`;
    } else {
      // Original subtle opacity for dark mode
      color1 = `rgba(${r}, ${g}, ${b}, 0.2)`;
      color2 = `rgba(${r}, ${g}, ${b}, 0.1)`;
      color3 = `rgba(${r}, ${g}, ${b}, 0.05)`;
      color4 = `rgba(${r}, ${g}, ${b}, 0.02)`;
    }

    const gradient = `radial-gradient(
      ellipse 100% 100% at 50% 50%,
      ${color1} 0%,
      ${color2} 30%,
      ${color3} 60%,
      ${color4} 100%
    )`;

    if (this._ambientMode) {
      const isFullscreen = document.fullscreenElement === this;

      if (this.ambientWrapperElement && !isFullscreen) {
        // External wrapper in normal mode — wrapper handles ambient, letterbox stays black
        this.ambientWrapperElement.style.background = gradient;
        this.player?.setLetterboxColor(0, 0, 0);

        if (this._theme === "light") {
          this.ambientWrapperElement.style.filter =
            "saturate(1.5) brightness(1.1)";
        } else {
          this.ambientWrapperElement.style.filter = "none";
        }
      } else {
        // Fullscreen or no wrapper — letterbox color on canvas
        const maxBrightness = 80;
        const peak = Math.max(r, g, b, 1);
        const scale = Math.min(maxBrightness / peak, 0.45);
        this.player?.setLetterboxColor(
          Math.floor(r * scale),
          Math.floor(g * scale),
          Math.floor(b * scale),
        );
      }
    }
  }

  get src(): string | File | null {
    return this._src;
  }

  /**
   * Separate audio source URL (for split video+audio files)
   */
  get audioSrc(): string | null {
    return this._audioSrc;
  }

  set audioSrc(value: string | null) {
    this._audioSrc = value;
  }

  /**
   * Get available audio language tracks
   */
  getAudioLangs(): { lang: string; label: string; active: boolean }[] {
    if (this.player) return this.player.getAudioLangs();
    return this._audioTracks.map((t, i) => ({
      lang: t.lang,
      label: t.label,
      active: i === 0,
    }));
  }

  /**
   * Switch audio to a different language
   */
  selectAudioLang(lang: string): boolean {
    if (this.player) return this.player.selectAudioLang(lang);
    return false;
  }

  /**
   * Get available external subtitle tracks
   */
  getSubtitleLangs(): { lang: string; label: string; active: boolean }[] {
    if (this.player) return this.player.getSubtitleLangs();
    return this._subtitleTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: false,
    }));
  }

  /**
   * Select an external subtitle track by language (null to disable)
   */
  async selectSubtitleLang(lang: string | null): Promise<boolean> {
    if (this.player) return this.player.selectSubtitleLang(lang);
    return false;
  }

  set src(value: string | File | null) {
    // Reset title-related flags when src changes
    if (this._titleAutoLoaded) {
      // If title was auto-loaded (not explicitly set by user), reset it
      this._title = null;
    }
    this._titleAutoLoaded = false;
    this._lastDuration = 0;

    // Save position before switching source, then stop saving
    if (this._resume) this.saveResumePosition();
    this.stopResumeSaving();

    // Reset timeline and rotation on source change
    this.resetTimeline();
    this.syncThumbnailRotation(0);
    if (this.shadowRoot) {
      const statusEl = this.shadowRoot.querySelector(".movi-rotate-status");
      if (statusEl) statusEl.textContent = "0°";
    }

    if (value instanceof File) {
      // For File objects, store in memory (can't store in attributes)
      this._src = value;
      // Remove the src attribute if it was a string
      this.removeAttribute("src");
      // Re-initialize player if already connected
      if (this.isConnected) {
        // Destroy existing player
        if (this.player) {
          this.player.destroy();
          this.player = null;
        }
        this.initializePlayer();
      }
    } else if (typeof value === "string") {
      // For strings, use attribute
      if (value) {
        this.setAttribute("src", value);
      } else {
        this.removeAttribute("src");
        this._src = null;
        // Show empty state when src is cleared
        if (this.emptyStateIndicator && !this.player) {
          this.emptyStateIndicator.style.display = "flex";
        }
      }
    } else {
      this.removeAttribute("src");
      this._src = null;
      // Show empty state when src is cleared
      if (this.emptyStateIndicator && !this.player) {
        this.emptyStateIndicator.style.display = "flex";
      }
    }
  }

  /**
   * Set a File object as the source (convenience method)
   */
  setFile(file: File | null): void {
    this.src = file;
  }

  /**
   * Video.js-style source API
   *
   * Usage:
   *   // Single source as string
   *   player.source('video.mp4');
   *
   *   // Single source as object
   *   player.source({ src: 'video.mp4', type: 'video/mp4' });
   *
   *   // Multiple sources (first playable source wins)
   *   player.source([
   *     { src: 'video.mp4', type: 'video/mp4' },
   *     { src: 'video.webm', type: 'video/webm' },
   *   ]);
   *
   *   // Separate video + audio (DASH-style split)
   *   player.source({
   *     video: { src: 'video-only.mp4', type: 'video/mp4' },
   *     audio: { src: 'audio.m4a', type: 'audio/mp4' },
   *   });
   *
   *   // Multi-language audio
   *   player.source({
   *     video: { src: 'video.mp4', type: 'video/mp4' },
   *     audio: [
   *       { src: 'en.m4a', type: 'audio/mp4', lang: 'en', label: 'English' },
   *       { src: 'hi.m4a', type: 'audio/mp4', lang: 'hi', label: 'Hindi' },
   *     ],
   *   });
   *
   *   // Get current source
   *   const current = player.source();
   */
  source(
    value?:
      | string
      | { src: string; type?: string }
      | { src: string; type?: string }[]
      | {
          video: { src: string; type?: string };
          audio?:
            | { src: string; type?: string }
            | { src: string; type?: string; lang: string; label: string }[];
          subtitles?: { src: string; lang: string; label: string; format?: string }[];
        }
  ): { src: string | File | null; type: string; audioSrc?: string | null } | void {
    // Getter
    if (value === undefined) {
      const currentSrc = this._src;
      if (!currentSrc) return { src: null, type: "", audioSrc: this._audioSrc };
      if (currentSrc instanceof File) return { src: currentSrc, type: currentSrc.type, audioSrc: this._audioSrc };
      return { src: currentSrc, type: this.guessMediaType(currentSrc), audioSrc: this._audioSrc };
    }

    // Setter — string
    if (typeof value === "string") {
      this._audioSrc = null;
      this.src = value;
      return;
    }

    // Setter — array (pick first playable)
    if (Array.isArray(value)) {
      this._audioSrc = null;
      const picked = this.pickSource(value);
      if (picked) {
        this.src = picked.src;
      } else if (value.length > 0) {
        this.src = value[0].src;
      }
      return;
    }

    // Setter — separate video + audio/subtitles { video, audio?, subtitles? }
    if ("video" in value) {
      if (value.audio) {
        if (Array.isArray(value.audio)) {
          this._audioTracks = value.audio;
          this._audioSrc = value.audio[0]?.src || null;
        } else {
          this._audioTracks = [];
          this._audioSrc = value.audio.src;
        }
      } else {
        this._audioTracks = [];
        this._audioSrc = null;
      }
      this._subtitleTracks = value.subtitles || [];
      this.src = value.video.src;
      return;
    }

    // Setter — single object { src, type }
    this._audioSrc = null;
    this.src = (value as { src: string }).src;
  }

  /**
   * Pick the first source whose MIME type the browser can play.
   * Falls back to null if none are supported.
   */
  private pickSource(
    sources: { src: string; type?: string }[]
  ): { src: string; type?: string } | null {
    const testVideo = document.createElement("video");
    for (const s of sources) {
      if (!s.type) return s; // No type hint → try it
      const can = testVideo.canPlayType(s.type);
      if (can === "probably" || can === "maybe") return s;
    }
    return null;
  }

  /**
   * Guess MIME type from a URL string extension.
   */
  private guessMediaType(url: string): string {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      ogg: "video/ogg",
      ogv: "video/ogg",
      m3u8: "application/x-mpegURL",
      mpd: "application/dash+xml",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      mov: "video/quicktime",
      ts: "video/mp2t",
      m4v: "video/mp4",
    };
    return (ext && map[ext]) || "";
  }

  /**
   * Load an encrypted video source (programmatic API)
   *
   * Usage:
   *   const player = document.querySelector('movi-player');
   *   player.loadEncrypted({
   *     videoUrl: '/api/video',
   *     tokenUrl: '/api/token',
   *     videoId: 'my-video',
   *     fingerprint: await generateFingerprint(),
   *     sessionToken: 'jwt-token',
   *   });
   */
  async loadEncrypted(config: {
    videoUrl: string;
    tokenUrl: string;
    videoId: string;
    fingerprint: string;
    sessionToken: string;
    tokenRefreshInterval?: number;
    onAuthFailed?: (reason: string) => void;
  }): Promise<void> {
    // Reset existing player
    this.resetTimeline();
    this.syncThumbnailRotation(0);

    if (this.player) {
      this.player.destroy();
      this.player = null;
    }

    this.isLoading = true;
    if (this.emptyStateIndicator) {
      this.emptyStateIndicator.style.display = "none";
    }

    try {
      // Create player with encrypted source (respecting element properties)
      this.player = new MoviPlayer({
        source: {
          type: "encrypted",
          encrypted: config,
        },
        renderer: "canvas",
        decoder: this._sw,
        canvas: this.canvas,
        enablePreviews: this._thumb,
        frameRate: this._fps || undefined,
      });

      this.setupEventHandlers();
      await this.player.load();

      // Apply all element properties (same as initializePlayer)
      this.updateVolume();
      this.updateMuted();
      this.updatePlaybackRate();
      this.updateCanvasSize();
      this.updateFitMode();
      this.updateTimeDisplay();
      if (this.player) {
        this.player.setHDREnabled(this._hdr);
        this.player.setStableAudio(this._stableVolume);
        this.player.setSubtitleOverlay(this.subtitleOverlay);
        this.updateStableAudioUI();
      }
      this.updateHDRVisibility();
      this.updateControlsVisibility();
      this.updateControlsState();
      this.updateLoadingIndicator();
      this.renderChapterMarkers();
      this.startUIUpdates();

      // Seek to start position or resume
      if (this._startAt > 0 && this.player) {
        await this.player.seek(this._startAt).catch(() => {});
      } else if (this._resume && this.player) {
        const savedTime = this.getResumePosition();
        if (savedTime > 2 && savedTime < this.duration - 5) {
          this.showResumeDialog(savedTime);
        }
      }

      // Start resume saving if enabled
      if (this._resume) {
        this.startResumeSaving();
      }

      // Autoplay or render first frame
      if (this._autoplay && this.player) {
        await this.player.play().catch(() => {});
      } else if (this.player) {
        if (this._startAt === 0) {
          this.player.seek(0).catch(() => {});
        }
      }

      // Ambient mode
      this.updateAmbientMode();

      // Dispatch load event
      this.dispatchEvent(new Event("loadeddata"));

      this.isLoading = false;
      Logger.info("MoviElement", "Encrypted source loaded");
    } catch (e) {
      this.isLoading = false;
      Logger.error("MoviElement", "Failed to load encrypted source", e);
      throw e;
    }
  }

  get autoplay(): boolean {
    return this._autoplay;
  }

  set autoplay(value: boolean) {
    if (value) {
      this.setAttribute("autoplay", "");
    } else {
      this.removeAttribute("autoplay");
    }
  }

  get controls(): boolean {
    return this._controls;
  }

  set controls(value: boolean) {
    if (value) {
      this.setAttribute("controls", "");
    } else {
      this.removeAttribute("controls");
    }
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(value: boolean) {
    this._loop = !!value;
    if (this._loop) {
      this.setAttribute("loop", "");
    } else {
      this.removeAttribute("loop");
    }
    this.updateLoopUI();
  }

  private updateLoopUI(): void {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    const loopBtn = shadowRoot.querySelector(".movi-loop-btn");
    const loopMenuItem = shadowRoot.querySelector(
      '.movi-context-menu-item[data-action="loop-toggle"]',
    );
    const loopStatus = shadowRoot.querySelector(".movi-loop-status");

    // Context menu icons
    const ctxOutline = shadowRoot.querySelector(".movi-context-menu-loop-outline") as HTMLElement;
    const ctxFilled = shadowRoot.querySelector(".movi-context-menu-loop-filled") as HTMLElement;

    if (this._loop) {
      loopBtn?.classList.add("active");
      loopMenuItem?.classList.add("movi-context-menu-active");
      if (loopStatus) loopStatus.textContent = "On";
      if (ctxOutline) ctxOutline.style.display = "none";
      if (ctxFilled) ctxFilled.style.display = "block";
    } else {
      loopBtn?.classList.remove("active");
      loopMenuItem?.classList.remove("movi-context-menu-active");
      if (loopStatus) loopStatus.textContent = "Off";
      if (ctxOutline) ctxOutline.style.display = "block";
      if (ctxFilled) ctxFilled.style.display = "none";
    }
  }

  private updateAmbientUI(): void {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    const menuItem = shadowRoot.querySelector('.movi-context-menu-item[data-action="ambient-toggle"]');
    const status = shadowRoot.querySelector(".movi-ambient-status");
    const ctxOutline = shadowRoot.querySelector(".movi-context-menu-ambient-outline") as HTMLElement;
    const ctxFilled = shadowRoot.querySelector(".movi-context-menu-ambient-filled") as HTMLElement;

    if (this._ambientMode) {
      menuItem?.classList.add("movi-context-menu-active");
      if (status) status.textContent = "On";
      if (ctxOutline) ctxOutline.style.display = "none";
      if (ctxFilled) ctxFilled.style.display = "block";
    } else {
      menuItem?.classList.remove("movi-context-menu-active");
      if (status) status.textContent = "Off";
      if (ctxOutline) ctxOutline.style.display = "block";
      if (ctxFilled) ctxFilled.style.display = "none";
    }
  }

  private updateStableAudioUI(shadowRoot: ShadowRoot | null = this.shadowRoot): void {
    if (!shadowRoot) return;
    const isEnabled = this.player?.getStableAudio() ?? true;

    const stableBtn = shadowRoot.querySelector(".movi-stable-audio-btn");
    const stableMenuItem = shadowRoot.querySelector(
      '.movi-context-menu-item[data-action="stable-audio-toggle"]',
    );
    const stableStatus = shadowRoot.querySelector(".movi-stable-audio-status");

    // Context menu icons
    const ctxOutline = shadowRoot.querySelector(".movi-context-menu-stable-outline") as HTMLElement;
    const ctxFilled = shadowRoot.querySelector(".movi-context-menu-stable-filled") as HTMLElement;

    if (isEnabled) {
      stableBtn?.classList.add("active");
      stableMenuItem?.classList.add("movi-context-menu-active");
      if (stableStatus) stableStatus.textContent = "On";
      if (ctxOutline) ctxOutline.style.display = "none";
      if (ctxFilled) ctxFilled.style.display = "block";
    } else {
      stableBtn?.classList.remove("active");
      stableMenuItem?.classList.remove("movi-context-menu-active");
      if (stableStatus) stableStatus.textContent = "Off";
      if (ctxOutline) ctxOutline.style.display = "block";
      if (ctxFilled) ctxFilled.style.display = "none";
    }
  }

  /**
   * Toggle nerd stats overlay
   */
  private toggleNerdStats(shadowRoot: ShadowRoot | null = this.shadowRoot): void {
    if (!shadowRoot) return;
    const overlay = shadowRoot.querySelector(".movi-nerd-stats") as HTMLElement;
    if (!overlay) return;

    this._nerdStatsVisible = !this._nerdStatsVisible;

    if (this._nerdStatsVisible) {
      overlay.style.display = "flex";
      this.networkSpeedHistory = [];
      this.updateNerdStats(shadowRoot);
      // Update every 500ms
      this.nerdStatsInterval = window.setInterval(() => {
        this.updateNerdStats(shadowRoot);
      }, 500);
    } else {
      overlay.style.display = "none";
      if (this.nerdStatsInterval) {
        clearInterval(this.nerdStatsInterval);
        this.nerdStatsInterval = null;
      }
      this.focus();
    }
  }

  /**
   * Update nerd stats content and network graph
   */
  private updateNerdStats(shadowRoot: ShadowRoot): void {
    if (!this.player || !this._nerdStatsVisible) return;
    const overlay = shadowRoot.querySelector(".movi-nerd-stats") as HTMLElement;
    const body = shadowRoot.querySelector(".movi-nerd-stats-body");
    if (!body || !overlay) return;

    // Recalculate max-height every update (fullscreen/resize)
    const hostHeight = (this as HTMLElement).offsetHeight || (this as HTMLElement).clientHeight || 400;
    const bar = shadowRoot.querySelector(".movi-controls-bar") as HTMLElement;
    const controlsHeight = (bar?.offsetHeight ?? 60) + 8;
    const topGap = hostHeight < 400 ? 4 : 12;
    overlay.style.maxHeight = `${hostHeight - controlsHeight - topGap}px`;

    const stats = this.player.getStats();
    let html = "";
    for (const [key, value] of Object.entries(stats)) {
      html += `<div class="movi-nerd-stats-row">
        <span class="movi-nerd-stats-key">${key}</span>
        <span class="movi-nerd-stats-value">${value}</span>
      </div>`;
    }
    // Append graph section at the end of stats body
    const speed = this.player.getNetworkSpeed();
    this.networkSpeedHistory.push(speed);
    if (this.networkSpeedHistory.length > MoviElement.GRAPH_MAX_SAMPLES) {
      this.networkSpeedHistory.shift();
    }

    const graphLabel = this.player.isFileSource() ? "Disk Activity" : "Network Activity";
    const speedText = speed > 1048576
      ? `${(speed / 1048576).toFixed(1)} MB/s`
      : speed > 0
        ? `${(speed / 1024).toFixed(0)} KB/s`
        : "—";

    html += `<div class="movi-nerd-stats-graph-section">
      <div class="movi-nerd-stats-graph-header">
        <span class="movi-nerd-stats-graph-title">${graphLabel}</span>
        <span class="movi-nerd-stats-graph-speed">${speedText}</span>
      </div>
      <canvas class="movi-nerd-stats-graph" width="300" height="80"></canvas>
    </div>`;

    body.innerHTML = html;

    // Draw graph
    this.drawNetworkGraph(shadowRoot);
  }

  /**
   * Draw network throughput graph on canvas
   */
  private drawNetworkGraph(shadowRoot: ShadowRoot): void {
    const body = shadowRoot.querySelector(".movi-nerd-stats-body");
    const canvas = body?.querySelector(".movi-nerd-stats-graph") as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Auto-resize canvas to match CSS layout size (HiDPI aware)
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    if (cssW <= 0 || cssH <= 0) return;
    const bufW = Math.round(cssW * dpr);
    const bufH = Math.round(cssH * dpr);
    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW;
      canvas.height = bufH;
    }

    // Use CSS dimensions for drawing, scale context each frame
    const w = cssW;
    const h = cssH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const data = this.networkSpeedHistory;
    const maxSamples = MoviElement.GRAPH_MAX_SAMPLES;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(0, 0, w, h);

    if (data.length < 2) return;

    // Find max for scale (minimum 100KB/s for visual stability)
    const maxSpeed = Math.max(102400, ...data);

    // Grid lines (horizontal)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = Math.round(h * (i / 4)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Draw filled area
    const stepX = w / (maxSamples - 1);
    const startIdx = maxSamples - data.length;

    ctx.beginPath();
    ctx.moveTo(startIdx * stepX, h);
    for (let i = 0; i < data.length; i++) {
      const x = (startIdx + i) * stepX;
      const y = h - (data[i] / maxSpeed) * (h - 4);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        // Smooth curve
        const prevX = (startIdx + i - 1) * stepX;
        const prevY = h - (data[i - 1] / maxSpeed) * (h - 4);
        const cpX = (prevX + x) / 2;
        ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
      }
    }
    ctx.lineTo((startIdx + data.length - 1) * stepX, h);
    ctx.closePath();

    // Gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "rgba(0, 200, 120, 0.35)");
    gradient.addColorStop(1, "rgba(0, 200, 120, 0.02)");
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw line on top
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (startIdx + i) * stepX;
      const y = h - (data[i] / maxSpeed) * (h - 4);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = (startIdx + i - 1) * stepX;
        const prevY = h - (data[i - 1] / maxSpeed) * (h - 4);
        const cpX = (prevX + x) / 2;
        ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
      }
    }
    ctx.strokeStyle = "rgba(0, 220, 130, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Current value dot
    if (data.length > 0) {
      const lastX = (startIdx + data.length - 1) * stepX;
      const lastY = h - (data[data.length - 1] / maxSpeed) * (h - 4);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#00ff88";
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 255, 136, 0.4)";
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  }

  /**
   * Reset timeline panel (clear thumbnails, hide panel)
   */
  /**
   * Apply rotation transform + margin to a seek thumbnail image
   */
  private applyThumbnailRotation(img: HTMLImageElement): void {
    const deg = this._currentManualRotation;
    if (deg === 0) {
      img.style.transform = "none";
      img.style.margin = "";
      return;
    }
    img.style.transform = `rotate(${deg}deg)`;
    if (deg % 180 === 0) {
      img.style.margin = "";
      return;
    }
    // 90/270: need margin fix after image has dimensions
    const fixMargin = () => {
      img.style.margin = "0";
      const w = img.offsetWidth;
      const h = img.offsetHeight;
      if (w > 0 && h > 0) {
        const diff = (w - h) / 2;
        img.style.margin = `${diff}px ${-diff}px ${diff + 6}px ${-diff}px`;
      }
    };
    if (img.complete && img.naturalWidth > 0 && img.offsetWidth > 0) {
      fixMargin();
    } else {
      img.addEventListener("load", fixMargin, { once: true });
    }
  }

  /**
   * Sync thumbnail and timeline rotation with video rotation
   */
  private syncThumbnailRotation(deg: number): void {
    if (!this.shadowRoot) return;
    this._currentManualRotation = deg;

    // Get video aspect ratio to determine if portrait
    const videoTrack = this.player?.getVideoTracks()?.[0];
    const isPortraitVideo = videoTrack && videoTrack.height > videoTrack.width;
    const is90 = deg % 180 !== 0;
    // After 90° rotation: portrait becomes landscape, landscape becomes portrait
    const resultIsPortrait = is90 ? !isPortraitVideo : isPortraitVideo;

    // Seek thumbnail
    const thumbImg = this.shadowRoot.querySelector(".movi-thumbnail-img") as HTMLImageElement;
    if (thumbImg) {
      this.applyThumbnailRotation(thumbImg);
    }

    // Timeline — update portrait/landscape class based on result after rotation
    const strip = this.shadowRoot.querySelector(".movi-timeline-strip");
    if (strip) {
      if (resultIsPortrait) {
        strip.classList.add("movi-timeline-portrait");
      } else {
        strip.classList.remove("movi-timeline-portrait");
      }
    }

    // Timeline items — apply rotation + margin fix
    const timelineImgs = this.shadowRoot.querySelectorAll(".movi-timeline-item img") as NodeListOf<HTMLImageElement>;
    timelineImgs.forEach((el) => {
      if (deg === 0) {
        el.style.transform = "none";
        el.style.margin = "";
        el.style.width = "auto";
        el.style.height = "90px";
      } else if (is90) {
        el.style.width = "90px";
        el.style.height = "auto";
        el.style.transform = `rotate(${deg}deg)`;
        // Use naturalWidth/Height — works even when element is hidden
        const nw = el.naturalWidth;
        const nh = el.naturalHeight;
        if (nw > 0 && nh > 0) {
          // After setting width:90px, rendered height = 90 * (nh/nw)
          const renderedH = 90 * (nh / nw);
          const diff = (90 - renderedH) / 2;
          el.style.margin = `${diff}px ${-diff}px`;
        } else {
          el.style.margin = "0";
        }
      } else {
        // 180°
        el.style.transform = `rotate(${deg}deg)`;
        el.style.margin = "";
        el.style.width = "auto";
        el.style.height = "90px";
      }
    });
  }

  /**
   * Show resume dialog with saved position
   */
  private showResumeDialog(savedTime: number): void {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    const dialog = shadowRoot.querySelector(".movi-resume-dialog") as HTMLElement;
    if (!dialog) return;

    const timeEl = dialog.querySelector(".movi-resume-time");
    if (timeEl) timeEl.textContent = this.formatTime(savedTime);
    dialog.dataset.time = savedTime.toString();
    dialog.style.display = "flex";

    // Highlight Resume button for keyboard navigation
    dialog.querySelectorAll(".movi-resume-btn").forEach(b => b.classList.remove("movi-resume-focused"));
    const yesBtn = dialog.querySelector(".movi-resume-yes") as HTMLElement;
    yesBtn?.classList.add("movi-resume-focused");

    // Auto-hide after 10 seconds with fade-out
    setTimeout(() => {
      if (dialog.style.display !== "none") {
        dialog.style.animation = "movi-resume-fade-out 0.4s ease forwards";
        setTimeout(() => {
          dialog.style.display = "none";
          dialog.style.animation = "";
        }, 400);
      }
    }, 10000);
  }

  // ─── Resume Playback ────────────────────────────────────────────

  /**
   * Get a unique key for the current source (for localStorage)
   */
  private getResumeKey(): string {
    const src = this._src;
    if (src instanceof File) {
      return `movi-resume:${src.name}:${src.size}`;
    }
    if (typeof src === "string") {
      return `movi-resume:${src}`;
    }
    return "";
  }

  /**
   * Get saved resume position from localStorage
   */
  private getResumePosition(): number {
    const key = this.getResumeKey();
    if (!key) return 0;
    try {
      const val = localStorage.getItem(key);
      return val ? parseFloat(val) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Save current position to localStorage
   */
  private saveResumePosition(): void {
    const key = this.getResumeKey();
    if (!key || !this.player) return;
    const time = this.currentTime;
    if (time <= 0) return;
    try {
      localStorage.setItem(key, time.toFixed(2));
    } catch {
      // localStorage full or unavailable
    }
  }

  /**
   * Start periodically saving playback position
   */
  private startResumeSaving(): void {
    this.stopResumeSaving();
    // Save every 5 seconds
    this._resumeSaveInterval = window.setInterval(() => {
      if (this.player && this.player.getState() === "playing") {
        this.saveResumePosition();
      }
    }, 5000);
  }

  /**
   * Stop saving playback position
   */
  private stopResumeSaving(): void {
    if (this._resumeSaveInterval) {
      clearInterval(this._resumeSaveInterval);
      this._resumeSaveInterval = null;
    }
  }

  /**
   * Clear saved position for current source
   */
  private clearResumePosition(): void {
    const key = this.getResumeKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  private resetTimeline(): void {
    if (!this.shadowRoot) return;
    const strip = this.shadowRoot.querySelector(".movi-timeline-strip") as HTMLElement;
    const status = this.shadowRoot.querySelector(".movi-timeline-status") as HTMLElement;
    const panel = this.shadowRoot.querySelector(".movi-timeline-panel") as HTMLElement;
    if (strip) strip.innerHTML = "";
    if (status) status.textContent = "";
    if (panel) panel.style.display = "none";
  }

  /**
   * Toggle timeline panel visibility
   */
  private toggleTimeline(): void {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;
    const panel = shadowRoot.querySelector(".movi-timeline-panel") as HTMLElement;
    if (!panel) return;

    if (panel.style.display === "none") {
      panel.style.display = "flex";
      // Auto-generate if strip is empty or previous attempt failed
      const strip = shadowRoot.querySelector(".movi-timeline-strip") as HTMLElement;
      const status = shadowRoot.querySelector(".movi-timeline-status") as HTMLElement;
      const failed = status?.textContent?.includes("Failed");
      if (strip && (strip.children.length === 0 || failed)) {
        requestAnimationFrame(() => this.generateTimelineStrip(shadowRoot));
      }
    } else {
      panel.style.display = "none";
      this.focus();
    }
  }

  /**
   * Generate timeline thumbnail strip
   */
  private async generateTimelineStrip(shadowRoot: ShadowRoot): Promise<void> {
    if (!this.player) return;

    const strip = shadowRoot.querySelector(".movi-timeline-strip") as HTMLElement;
    const status = shadowRoot.querySelector(".movi-timeline-status") as HTMLElement;
    const titleEl = shadowRoot.querySelector(".movi-timeline-title") as HTMLElement;
    if (!strip || !status) return;

    strip.innerHTML = "";

    // Detect portrait video — consider metadata rotation
    const videoTrack = this.player.getVideoTracks()?.[0];
    const metadataRotation = videoTrack?.rotation || 0;
    const metaIs90 = metadataRotation % 180 !== 0;
    // After metadata rotation, is the video portrait?
    const isPortraitAfterMeta = videoTrack
      ? (metaIs90 ? videoTrack.width > videoTrack.height : videoTrack.height > videoTrack.width)
      : false;
    const deg = this._currentManualRotation;
    const is90 = deg % 180 !== 0;
    // Manual rotation flips orientation again
    const resultIsPortrait = is90 ? !isPortraitAfterMeta : isPortraitAfterMeta;

    if (resultIsPortrait) {
      strip.classList.add("movi-timeline-portrait");
    } else {
      strip.classList.remove("movi-timeline-portrait");
    }

    // Helper to apply rotation to a single image element
    const applyRotationToImg = (el: HTMLElement) => {
      if (deg === 0) return;
      if (is90) {
        el.style.width = "90px";
        el.style.height = "auto";
        el.style.transform = `rotate(${deg}deg)`;
        el.style.margin = "0";
        requestAnimationFrame(() => {
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          if (w > 0 && h > 0) {
            const diff = (w - h) / 2;
            el.style.margin = `${diff}px ${-diff}px`;
          }
        });
      } else {
        el.style.transform = `rotate(${deg}deg)`;
      }
    };

    const formatTime = (s: number) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      return h > 0
        ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
        : `${m}:${sec.toString().padStart(2, "0")}`;
    };

    const chapters = this.player.getChapters();
    const hasChapters = chapters.length > 0;

    if (hasChapters) {
      // Chapter-based timeline
      if (titleEl) titleEl.textContent = `Chapters (${chapters.length})`;
      status.textContent = "Generating...";

      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        // Generate thumbnail at chapter start time
        const blob = await this.player.getPreviewFrame(ch.start);

        const item = document.createElement("div");
        item.className = "movi-timeline-item movi-timeline-chapter";

        if (blob) {
          const img = document.createElement("img");
          img.src = URL.createObjectURL(blob);
          img.alt = ch.title;
          item.appendChild(img);
        }

        const labelContainer = document.createElement("div");
        labelContainer.className = "movi-timeline-chapter-label";

        const titleSpan = document.createElement("span");
        titleSpan.className = "movi-timeline-chapter-title";
        titleSpan.textContent = ch.title;

        const timeSpan = document.createElement("span");
        timeSpan.className = "movi-timeline-time";
        timeSpan.textContent = formatTime(ch.start);

        labelContainer.appendChild(titleSpan);
        labelContainer.appendChild(timeSpan);
        item.appendChild(labelContainer);

        // Click to seek to chapter
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          this.currentTime = ch.start;
        });

        strip.appendChild(item);
        const chImg = item.querySelector("img") as HTMLElement;
        if (chImg) applyRotationToImg(chImg);
        status.textContent = `${i + 1} / ${chapters.length}`;
      }

      status.textContent = `${chapters.length} chapters`;
    } else {
      // Regular interval-based timeline
      if (titleEl) titleEl.textContent = "Timeline";
      status.textContent = "Generating...";
      const count = 20;

      await this.player.generateTimeline(count, (_i, _total, blob, time) => {
        const item = document.createElement("div");
        item.className = "movi-timeline-item";

        const img = document.createElement("img");
        img.src = URL.createObjectURL(blob);
        img.alt = `Timeline ${formatTime(time)}`;

        const label = document.createElement("span");
        label.className = "movi-timeline-time";
        label.textContent = formatTime(time);

        item.appendChild(img);
        item.appendChild(label);

        item.addEventListener("click", (e) => {
          e.stopPropagation();
          this.currentTime = time;
        });

        strip.appendChild(item);
        applyRotationToImg(img);
        status.textContent = `${strip.children.length} / ${count}`;
      });

      status.textContent = strip.children.length > 0
        ? `${strip.children.length} thumbnails`
        : "Failed to generate — try again";
    }

  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(value: boolean) {
    if (value) {
      this.setAttribute("muted", "");
    } else {
      this.removeAttribute("muted");
    }
    this.updateMuted();
    SettingsStorage.getInstance().save({ muted: this._muted });
  }

  get playsInline(): boolean {
    return this._playsinline;
  }

  set playsInline(value: boolean) {
    if (value) {
      this.setAttribute("playsinline", "");
    } else {
      this.removeAttribute("playsinline");
    }
  }

  get preload(): "none" | "metadata" | "auto" {
    return this._preload;
  }

  set preload(value: "none" | "metadata" | "auto") {
    this.setAttribute("preload", value);
  }

  get poster(): string {
    return this._poster;
  }

  set poster(value: string) {
    this.setAttribute("poster", value);
  }

  get volume(): number {
    return this._volume;
  }

  set volume(value: number) {
    this._volume = Math.max(0, Math.min(1, value));
    this.setAttribute("volume", this._volume.toString());

    // If user increases volume while muted, automatically unmute (like YouTube)
    if (this._muted && this._volume > 0) {
      this._muted = false;
      this.removeAttribute("muted");
      // Update player muted state immediately
      if (this.player) {
        this.player.setMuted(false);
      }
    }

    this.updateVolume();
    SettingsStorage.getInstance().save({ volume: this._volume });
  }

  get playbackRate(): number {
    return this._playbackRate;
  }

  set playbackRate(value: number) {
    this._playbackRate = Math.max(0.25, Math.min(4, value));
    this.setAttribute("playbackrate", this._playbackRate.toString());
    this.updatePlaybackRate();
    SettingsStorage.getInstance().save({ playbackRate: this._playbackRate });
  }

  get ambientMode(): boolean {
    return this._ambientMode;
  }

  set ambientMode(value: boolean) {
    this._ambientMode = value;
    if (value) {
      this.setAttribute("ambientmode", "");
    } else {
      this.removeAttribute("ambientmode");
    }
    this.updateAmbientMode();
  }

  get currentTime(): number {
    return this.player?.getCurrentTime() || 0;
  }

  set currentTime(value: number) {
    if (this.player) {
      const state = this.player.getState();
      Logger.info(TAG, `currentTime setter: value=${value.toFixed(2)}, state=${state}, isSeeking=${this.isSeeking}`);
      if (
        state === "ready" ||
        state === "playing" ||
        state === "paused" ||
        state === "ended" ||
        state === "seeking" ||
        state === "buffering"
      ) {
        this.isSeeking = true;
        this.player
          .seek(value)
          .then(() => {
            Logger.info(TAG, `Seek resolved: value=${value.toFixed(2)}, newState=${this.player?.getState()}`);
          })
          .catch((error) => {
            Logger.error(TAG, `Seek error: value=${value.toFixed(2)}`, error);
          })
          .finally(() => {
            this.isSeeking = false;
          });
      } else {
        Logger.warn(TAG, `Seek blocked — state=${state} not allowed`);
      }
    }
  }

  get renderer(): RendererType {
    return this._renderer;
  }

  set renderer(value: RendererType) {
    if (this._renderer !== value) {
      if (value === "canvas") {
        this.setAttribute("renderer", value);
      } else {
        // Fallback to canvas for invalid values
        this.setAttribute("renderer", "canvas");
      }
    }
  }

  get sw(): boolean | "auto" {
    if (this.getAttribute("sw") === "auto") return "auto";
    return this._sw === "software";
  }

  set sw(value: boolean | "auto") {
    const newValue: DecoderType =
      value === "auto" ? "auto" : value ? "software" : "auto";
    if (this._sw !== newValue) {
      this._sw = newValue;
      if (newValue === "software") {
        this.setAttribute("sw", "");
      } else if (value === "auto") {
        this.setAttribute("sw", "auto");
      } else {
        this.removeAttribute("sw");
      }
    }
  }

  get fps(): number {
    return this._fps;
  }

  set fps(value: number) {
    if (this._fps !== value) {
      this._fps = value;
      if (value > 0) {
        this.setAttribute("fps", value.toString());
      } else {
        this.removeAttribute("fps");
      }
    }
  }

  get gesturefs(): boolean {
    return this._gesturefs;
  }

  set gesturefs(value: boolean) {
    if (this._gesturefs !== value) {
      this._gesturefs = value;
      if (value) {
        this.setAttribute("gesturefs", "");
      } else {
        this.removeAttribute("gesturefs");
      }
    }
  }

  get nohotkeys(): boolean {
    return this._noHotkeys;
  }

  set nohotkeys(value: boolean) {
    if (this._noHotkeys !== value) {
      this._noHotkeys = value;
      if (value) {
        this.setAttribute("nohotkeys", "");
      } else {
        this.removeAttribute("nohotkeys");
      }
    }
  }

  get startat(): number {
    return this._startAt;
  }
  set startat(value: number) {
    this._startAt = value;
    this.setAttribute("startat", value.toString());
  }

  get fastseek(): boolean {
    return this._fastSeek;
  }
  set fastseek(value: boolean) {
    this._fastSeek = value;
    if (value) {
      this.setAttribute("fastseek", "");
    } else {
      this.removeAttribute("fastseek");
    }
    this.updateFastSeek();
    this.updatePoster();
  }

  private updatePoster() {
    if (this._poster) {
      this.posterElement.src = this._poster;
      this.posterElement.style.display = "block";
      this.posterElement.style.objectFit = this._objectFit || "contain";
    } else {
      this.posterElement.style.display = "none";
    }
  }

  get doubletap(): boolean {
    return this._doubleTap;
  }
  set doubletap(value: boolean) {
    this._doubleTap = value;
    if (value) {
      this.setAttribute("doubletap", "true");
    } else {
      this.setAttribute("doubletap", "false");
    }
  }

  get themecolor(): string | null {
    return this._themeColor;
  }
  set themecolor(value: string | null) {
    this._themeColor = value;
    if (value) {
      this.setAttribute("themecolor", value);
      this.style.setProperty("--movi-primary", value);
    } else {
      this.removeAttribute("themecolor");
      this.style.removeProperty("--movi-primary");
    }
  }

  get buffersize(): number {
    return this._bufferSize;
  }
  set buffersize(value: number) {
    this._bufferSize = value;
    this.setAttribute("buffersize", value.toString());
  }

  get watermark(): string | null {
    return this._watermark;
  }
  set watermark(value: string | null) {
    this._watermark = value;
    if (value) {
      this.setAttribute("watermark", value);
    } else {
      this.removeAttribute("watermark");
    }
    this.updateWatermark();
  }

  get title(): string {
    return this._title || "";
  }
  set title(value: string) {
    this._title = value || null;
    // Reset auto-load flag when user explicitly sets title
    this._titleAutoLoaded = false;
    if (value) {
      this.setAttribute("title", value);
    } else {
      this.removeAttribute("title");
    }
    this.updateTitle();
  }

  get showtitle(): boolean {
    return this._showTitle;
  }
  set showtitle(value: boolean) {
    this._showTitle = value;
    if (value) {
      this.setAttribute("showtitle", "");
    } else {
      this.removeAttribute("showtitle");
    }
    this.updateTitle();
  }

  private updateWatermark() {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    let watermarkEl = shadowRoot.querySelector(
      ".movi-watermark",
    ) as HTMLImageElement;

    if (!this._watermark) {
      if (watermarkEl) watermarkEl.style.display = "none";
      return;
    }

    if (!watermarkEl) {
      watermarkEl = document.createElement("img");
      watermarkEl.className = "movi-watermark";
      // Basic styling for watermark
      watermarkEl.style.position = "absolute";
      watermarkEl.style.top = "20px";
      watermarkEl.style.right = "20px";
      watermarkEl.style.height = "30px"; // Default height
      watermarkEl.style.opacity = "0.8";
      watermarkEl.style.pointerEvents = "none";
      watermarkEl.style.zIndex = "10";

      const container = shadowRoot.querySelector(".movi-player-container");
      if (container) {
        container.appendChild(watermarkEl);
      }
    }

    watermarkEl.src = this._watermark;
    watermarkEl.style.display = "block";
  }

  private updateTitle() {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    const titleBar = shadowRoot.querySelector(".movi-title-bar") as HTMLElement;
    const titleText = shadowRoot.querySelector(
      ".movi-title-text",
    ) as HTMLElement;

    if (!titleBar || !titleText) return;

    // Auto-load title from media metadata if not explicitly set
    if (
      this._showTitle &&
      !this._title &&
      !this._titleAutoLoaded &&
      this.player &&
      this.duration > 0
    ) {
      const mediaInfo = this.player.getMediaInfo();
      if (mediaInfo?.metadata?.title) {
        this._title = mediaInfo.metadata.title;
        this._titleAutoLoaded = true;
      } else if (this._src) {
        // Fallback to filename if no metadata title
        let filename = "";
        if (this._src instanceof File) {
          // For File objects, use the file name
          filename = this._src.name;
        } else if (typeof this._src === "string") {
          // For URL strings, extract filename from path
          try {
            const url = new URL(this._src, window.location.href);
            const pathname = url.pathname;
            filename = pathname.substring(pathname.lastIndexOf("/") + 1);
            if (filename) {
              // Decode URI component and remove query params
              filename = decodeURIComponent(filename.split("?")[0]);
            }
          } catch {
            // If URL parsing fails, just use the string as-is
            filename = this._src;
          }
        }

        // Remove file extension from filename
        if (filename) {
          // Remove all extensions (e.g., "video.m3u8" → "video", ".m3u8" → "")
          filename = filename.replace(/\.[^.\/]+$/, "");
          // If filename is empty or non-descriptive, try parent path segment
          if (!filename || filename === "index" || filename === "master" || filename === "playlist") {
            try {
              const url = new URL(this._src as string, window.location.href);
              const segments = url.pathname.split("/").filter(s => s && !s.includes("."));
              if (segments.length > 0) {
                filename = decodeURIComponent(segments[segments.length - 1]).replace(/[-_]/g, " ");
              }
            } catch { /* ignore */ }
          }
          if (filename) {
            this._title = filename;
          }
        }
        this._titleAutoLoaded = true;
      }
    }

    if (this._showTitle && this._title) {
      titleText.textContent = this._title;
      titleBar.style.display = "block";

      // Show title if controls are currently visible
      const container = this.controlsContainer;
      if (container?.classList.contains("movi-controls-visible")) {
        titleBar.classList.add("movi-title-visible");
      }
    } else {
      titleBar.style.display = "none";
      titleBar.classList.remove("movi-title-visible");
    }
  }

  get duration(): number {
    return this.player?.getDuration() || 0;
  }

  get paused(): boolean {
    return this.player?.getState() === "paused" || false;
  }

  get ended(): boolean {
    return this.player?.getState() === "ended" || false;
  }

  get readyState(): number {
    // Map MoviPlayer states to HTMLMediaElement readyState
    // 0 = HAVE_NOTHING, 1 = HAVE_METADATA, 2 = HAVE_CURRENT_DATA, 3 = HAVE_FUTURE_DATA, 4 = HAVE_ENOUGH_DATA
    const state = this.player?.getState();
    if (!state || state === "idle") return 0; // HAVE_NOTHING
    if (state === "ready" || state === "loading") return 1; // HAVE_METADATA
    if (state === "playing" || state === "paused") return 4; // HAVE_ENOUGH_DATA
    return 0;
  }

  get width(): number {
    return this.canvas.width;
  }

  set width(value: number) {
    this.setAttribute("width", value.toString());
    this.updateCanvasSize();
  }

  get height(): number {
    return this.canvas.height;
  }

  set height(value: number) {
    this.setAttribute("height", value.toString());
    this.updateCanvasSize();
  }

  get objectFit(): "contain" | "cover" | "fill" | "zoom" | "control" {
    return this._objectFit;
  }

  set objectFit(value: "contain" | "cover" | "fill" | "zoom" | "control") {
    this.setAttribute("objectfit", value);
  }

  get thumb(): boolean {
    return this._thumb;
  }

  set thumb(value: boolean) {
    if (value) {
      this.setAttribute("thumb", "");
    } else {
      this.removeAttribute("thumb");
    }
  }

  get hdr(): boolean {
    return this._hdr;
  }

  set hdr(value: boolean) {
    this._hdr = !!value;
    if (this._hdr) {
      this.setAttribute("hdr", "");
    } else {
      this.removeAttribute("hdr");
    }

    this.updateHDRUI();

    // Pass to player
    if (this.player) {
      this.player.setHDREnabled(this._hdr);
    }
  }

  private updateHDRUI(): void {
    const hdrBtn = this.shadowRoot?.querySelector(".movi-hdr-btn");
    const hdrStatus = this.shadowRoot?.querySelector(".movi-hdr-status");
    const hdrMenuItem = this.shadowRoot?.querySelector(
      '.movi-context-menu-item[data-action="hdr-toggle"]',
    );

    if (this._hdr) {
      hdrBtn?.classList.add("movi-hdr-active");
      hdrMenuItem?.classList.add("movi-context-menu-active");
      if (hdrStatus) hdrStatus.textContent = "On";
    } else {
      hdrBtn?.classList.remove("movi-hdr-active");
      hdrMenuItem?.classList.remove("movi-context-menu-active");
      if (hdrStatus) hdrStatus.textContent = "Off";
    }
  }

  /*
   * Take a snapshot of the current frame and download it
   */
  private takeSnapshot(): void {
    if (!this.player) return;

    try {
      let dataUrl: string | null = null;

      // If we are in canvas mode, it's easy
      if (this.canvas && this.canvas.style.display !== "none") {
        dataUrl = this.canvas.toDataURL("image/png");
      } else if (this.video && this.video.style.display !== "none") {
        // If in video mode, draw video to a temporary canvas
        const canvas = document.createElement("canvas");
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL("image/png");
        }
      }

      if (dataUrl) {
        const link = document.createElement("a");
        // Format timestamp for filename
        const time = this.currentTime;
        const hours = Math.floor(time / 3600);
        const minutes = Math.floor((time % 3600) / 60);
        const seconds = Math.floor(time % 60);
        const timeStr = `${hours > 0 ? hours + "-" : ""}${minutes.toString().padStart(2, "0")}-${seconds.toString().padStart(2, "0")}`;

        link.download = `snapshot-${timeStr}.png`;
        link.href = dataUrl;
        link.click();

        Logger.info(TAG, "Snapshot taken and download triggered");
      } else {
        Logger.warn(TAG, "Failed to capture snapshot: No valid source found");
        // Could show a toast message here
      }
    } catch (e) {
      Logger.error(TAG, "Error taking snapshot", e);
    }
  }

  private updateHDRVisibility(): void {
    if (!this.player) return;

    // Check for Chromium-based browser (Chrome, Edge, Opera, Brave, etc.)
    const isChromium = !!(window as any).chrome;

    // HDR only supported on Chromium with Canvas renderer
    const canSupportHDR = isChromium && this._renderer === "canvas";

    const isContentHDR = (this.player as any).isHDRSupported?.() || false;
    const shouldShow = canSupportHDR && isContentHDR;

    const hdrContainer = this.shadowRoot?.querySelector(
      ".movi-hdr-container",
    ) as HTMLElement;
    const hdrMenuItem = this.shadowRoot?.querySelector(
      '.movi-context-menu-item[data-action="hdr-toggle"]',
    ) as HTMLElement;

    const hdrDivider = this.shadowRoot?.querySelector(
      ".movi-hdr-divider",
    ) as HTMLElement;

    if (shouldShow) {
      if (hdrContainer) hdrContainer.style.display = "flex";
      if (hdrMenuItem) hdrMenuItem.style.display = "flex";
      if (hdrDivider) hdrDivider.style.display = "block";

      // Show the HDR button when HDR content is detected
      const hdrBtn = this.shadowRoot?.querySelector(
        ".movi-hdr-btn",
      ) as HTMLElement;
      if (hdrBtn) hdrBtn.style.display = "flex";

      // Ensure UI reflects the active state now that it's visible
      this.updateHDRUI();
    } else {
      if (hdrContainer) hdrContainer.style.display = "none";
      if (hdrMenuItem) hdrMenuItem.style.display = "none";
      if (hdrDivider) hdrDivider.style.display = "none";

      // Hide the HDR button when no HDR content
      const hdrBtn = this.shadowRoot?.querySelector(
        ".movi-hdr-btn",
      ) as HTMLElement;
      if (hdrBtn) hdrBtn.style.display = "none";
    }

    Logger.debug(
      TAG,
      `HDR Visibility updated. Show: ${shouldShow} (Content HDR: ${isContentHDR}, Chromium: ${isChromium}, Renderer: ${this._renderer})`,
    );
  }

  private updateFastSeek() {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) return;

    const seekButtons = shadowRoot.querySelectorAll(
      ".movi-seek-backward, .movi-seek-forward",
    );
    seekButtons.forEach((btn) => {
      (btn as HTMLElement).style.display = this._fastSeek ? "" : "none";
    });
  }
}

// Register the custom element
// Note: Custom element names must contain a hyphen per HTML spec
if (typeof customElements !== "undefined") {
  customElements.define("movi-player", MoviElement);
}
