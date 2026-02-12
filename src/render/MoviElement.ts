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

  // Internal state
  private _src: string | File | null = null;
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
      <div class="movi-context-menu-item" data-action="fit">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="3" y1="9" x2="21" y2="9"></line>
          <line x1="3" y1="15" x2="21" y2="15"></line>
          <line x1="9" y1="3" x2="9" y2="21"></line>
          <line x1="15" y1="3" x2="15" y2="21"></line>
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
        <div class="movi-context-menu-item" data-fit="contain">Contain</div>
        <div class="movi-context-menu-item" data-fit="cover">Cover</div>
        <div class="movi-context-menu-item" data-fit="fill">Stretch</div>
        <div class="movi-context-menu-item" data-fit="zoom">Zoom</div>
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
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v2"></path>
          <path d="M12 20v2"></path>
          <path d="M4.93 4.93l1.41 1.41"></path>
          <path d="M17.66 17.66l1.41 1.41"></path>
          <path d="M2 12h2"></path>
          <path d="M20 12h2"></path>
          <path d="M6.34 17.66l-1.41 1.41"></path>
          <path d="M19.07 4.93l-1.41 1.41"></path>
          <circle cx="12" cy="12" r="4"></circle>
        </svg>
        <span class="movi-context-menu-label">HDR Mode</span>
        <span class="movi-context-menu-status movi-hdr-status">On</span>
      </div>
      <div class="movi-context-menu-divider movi-hdr-divider" style="display: none;"></div>
      <div class="movi-context-menu-item" data-action="fullscreen">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
        </svg>
        <span class="movi-context-menu-label">Fullscreen</span>
        <span class="movi-context-menu-shortcut">F</span>
      </div>
      <div class="movi-context-menu-item" data-action="loop-toggle">
        <svg class="movi-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M17 2l4 4-4 4"></path>
           <path d="M3 11v-1a4 4 0 0 1 4-4h14"></path>
           <path d="M7 22l-4-4 4-4"></path>
           <path d="M21 13v1a4 4 0 0 1-4 4H3"></path>
        </svg>
        <span class="movi-context-menu-label">Loop</span>
        <span class="movi-context-menu-status movi-loop-status">Off</span>
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
      <div class="movi-controls-bar" style="position: relative; z-index: 10;">
        <div class="movi-progress-container">
          <div class="movi-progress-bar">
            <div class="movi-progress-buffer"></div>
            <div class="movi-progress-filled"></div>
            <div class="movi-progress-handle"></div>
          </div>
          <div class="movi-seek-thumbnail" style="display: none;">
             <div class="movi-thumbnail-placeholder" style="display: none;"></div>
             <img class="movi-thumbnail-img" style="display: none;">
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
                    <rect width="18" height="14" x="3" y="5" rx="2" ry="2"></rect>
                    <path d="M11 9H9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2 M17 9h-2a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2"></path>
                  </svg>
                  <svg class="movi-icon-subtitle-filled" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2z M11 11 H9.5 V10.5 H7.5 V13.5 H9.5 V13 H11 V14 C11 14.55 10.55 15 10 15 H7 C6.45 15 6 14.55 6 14 V10 C6 9.45 6.45 9 7 9 H10 C10.55 9 11 9.45 11 10 V11 Z M18 11 H16.5 V10.5 H14.5 V13.5 H16.5 V13 H18 V14 C18 14.55 17.55 15 17 15 H14 C13.45 15 13 14.55 13 14 V10 C13 9.45 13.45 9 14 9 H17 C17.55 9 18 9.45 18 10 V11 Z"></path>
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

              <button class="movi-btn movi-aspect-ratio-btn" aria-label="Aspect Ratio">
                <svg class="movi-icon-aspect-ratio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path class="movi-aspect-inner" d="M3 9h18M3 15h18M9 3v18M15 3v18"></path>
                </svg>
              </button>

              <button class="movi-btn movi-loop-btn" aria-label="Toggle Loop">
                <svg class="movi-icon-loop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 2l4 4-4 4"></path>
                  <path d="M3 11v-1a4 4 0 0 1 4-4h14"></path>
                  <path d="M7 22l-4-4 4-4"></path>
                  <path d="M21 13v1a4 4 0 0 1-4 4H3"></path>
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
        if (state === "playing") {
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
    });

    // Loop Toggle
    loopBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.loop = !this.loop;
    });

    // Center play/pause button
    const centerPlayPauseBtn = shadowRoot.querySelector(
      ".movi-center-play-pause",
    ) as HTMLElement;
    centerPlayPauseBtn?.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering overlay click
      if (this.player) {
        const state = this.player.getState();
        if (state === "playing") {
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
    // Aspect Ratio
    const aspectRatioBtn = shadowRoot.querySelector(
      ".movi-aspect-ratio-btn",
    ) as HTMLElement;
    aspectRatioBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const modes: Array<"contain" | "cover" | "fill" | "zoom"> = [
        "contain",
        "cover",
        "fill",
        "zoom",
      ];
      const currentIndex = modes.indexOf(this._currentFit);
      const nextIndex = (currentIndex + 1) % modes.length;
      this._currentFit = modes[nextIndex];
      this.updateFitMode();
      this.updateAspectRatioIcon();

      Logger.info(TAG, `Internal Aspect Ratio changed to: ${this._currentFit}`);
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
        if (state === "playing") {
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
      // Resize canvas when entering/exiting fullscreen
      // Use requestAnimationFrame to ensure layout is complete
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
    // Only allow seeking if player is ready, playing, paused, or ended
    if (
      state !== "ready" &&
      state !== "playing" &&
      state !== "paused" &&
      state !== "ended"
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
    // Only allow seeking if player is ready, playing, paused, or ended
    if (
      state !== "ready" &&
      state !== "playing" &&
      state !== "paused" &&
      state !== "ended"
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
          if (state === "playing") {
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

        // Check if fast seek is enabled
        if (this._fastSeek) {
          if (xPos < width * 0.3) {
            // Rewind
            this.currentTime = Math.max(0, this.currentTime - 10);
            this.showOSD(
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
              </svg>`,
              "- 10s",
            );
          } else if (xPos > width * 0.7) {
            // Forward
            this.currentTime = Math.min(this.duration, this.currentTime + 10);
            this.showOSD(
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <text x="50%" y="54%" font-size="7" font-family="sans-serif" font-weight="bold" fill="currentColor" text-anchor="middle" dominant-baseline="middle" stroke="none">10</text>
              </svg>`,
              "+ 10s",
            );
          } else {
            this.toggleFullscreen();
          }
        } else {
          // If seek disabled, always treat double tap as fullscreen toggle
          this.toggleFullscreen();
        }
        lastTap = 0;
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
            if (state === "playing") {
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

      switch (e.key) {
        case " ":
        case "k":
        case "K": {
          // Space or K: Play/Pause
          e.preventDefault();
          const state = this.player?.getState();
          if (state === "playing") {
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
          break;
        case "s":
        case "S":
          // S: Snapshot
          e.preventDefault();
          this.takeSnapshot();
          this.showOSD(
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`,
            "Snapshot",
          );
          break;
        case "f":
        case "F":
          // F: Fullscreen
          e.preventDefault();
          this.toggleFullscreen();
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

    // Hide context menu on escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._contextMenuVisible) {
        hideContextMenu(); // Used new local method
      }
    });

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
      const subtitleTrackId = item.dataset.subtitleTrackId;

      if (action === "play-pause") {
        if (this.player) {
          const state = this.player.getState();
          if (state === "playing") {
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
        // Show fit submenu (changed from toggle to add)
        const submenu = shadowRoot.querySelector(
          '.movi-context-menu-submenu[data-submenu="fit"]',
        ) as HTMLElement;
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
      } else if (audioTrackId !== undefined) {
        // Select audio track
        const trackId = parseInt(audioTrackId);
        if (this.player) {
          this.player.selectAudioTrack(trackId);
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
      } else if (subtitleTrackId !== undefined) {
        // Select subtitle track
        const trackId = parseInt(subtitleTrackId);
        if (this.player) {
          if (trackId === -1) {
            this.player.selectSubtitleTrack(null);
          } else {
            this.player.selectSubtitleTrack(trackId);
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

        hideContextMenu();
      } else if (item.dataset.fit) {
        // Set object fit mode
        const fitMode = item.dataset.fit as
          | "contain"
          | "cover"
          | "fill"
          | "zoom";

        if (this._objectFit === "control") {
          // If in control mode, just update the current choice so button stays visible
          this._currentFit = fitMode;
          this.updateFitMode();
          this.updateAspectRatioIcon();
        } else {
          // Otherwise update the main property (which might be a fixed mode)
          this.objectFit = fitMode;
        }

        // Update active state
        contextMenu
          .querySelectorAll(".movi-context-menu-item[data-fit]")
          .forEach((el) => {
            el.classList.remove("movi-context-menu-active");
          });
        item.classList.add("movi-context-menu-active");

        hideContextMenu();
      } else if (action === "hdr-toggle") {
        this.hdr = !this.hdr;
        hideContextMenu();
      } else if (action === "loop-toggle") {
        this.loop = !this.loop;
        hideContextMenu();
      } else if (action === "fullscreen") {
        this.toggleFullscreen();
        hideContextMenu();
      } else if (action === "snapshot") {
        this.takeSnapshot();
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

    if (audioTracks.length > 1 && audioDivider && audioItem && audioSubmenu) {
      audioDivider.style.display = "block";
      audioItem.style.display = "flex";
      // Remove inline display:none so CSS visibility can work
      audioSubmenu.style.removeProperty("display");

      // Populate audio track submenu
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

      html += audioTracks
        .map((track) => {
          const isActive = activeAudioTrack?.id === track.id;
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

          const info =
            infoParts.length > 0 ? ` (${infoParts.join(" • ")})` : "";
          const activeClass = isActive ? " movi-context-menu-active" : "";

          return `<div class="movi-context-menu-item${activeClass}" data-audio-track-id="${track.id}">${label}${info}</div>`;
        })
        .join("");

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
      subtitleTracks.length > 0 &&
      subtitleDivider &&
      subtitleItem &&
      subtitleSubmenu
    ) {
      subtitleDivider.style.display = "block";
      subtitleItem.style.display = "flex";
      // Remove inline display:none so CSS visibility can work
      subtitleSubmenu.style.removeProperty("display");

      // Update Context Menu Icon (Toggle Filled/Outline)
      const contextMenuSubtitleIcon = subtitleItem.querySelector(
        "svg:not(.movi-context-menu-subtitle-filled)",
      ) as HTMLElement;
      const contextMenuSubtitleFilledIcon = subtitleItem.querySelector(
        ".movi-context-menu-subtitle-filled",
      ) as HTMLElement;

      if (activeSubtitleTrack) {
        if (contextMenuSubtitleIcon)
          contextMenuSubtitleIcon.style.display = "none";
        if (contextMenuSubtitleFilledIcon)
          contextMenuSubtitleFilledIcon.style.display = "block";
      } else {
        if (contextMenuSubtitleIcon)
          contextMenuSubtitleIcon.style.display = "block";
        if (contextMenuSubtitleFilledIcon)
          contextMenuSubtitleFilledIcon.style.display = "none";
      }

      // Add "Off" option for subtitles
      const offActive = !activeSubtitleTrack;
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
      html += `<div class="movi-context-menu-item${offActive ? " movi-context-menu-active" : ""}" data-subtitle-track-id="-1">Off</div>`;

      // Populate subtitle track submenu
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

      subtitleSubmenu.innerHTML = html;

      // Setup hover handlers for subtitle track submenu
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

  private updateAspectRatioIcon(): void {
    const icon = this.shadowRoot?.querySelector(
      ".movi-icon-aspect-ratio",
    ) as HTMLElement;
    const inner = icon?.querySelector(".movi-aspect-inner") as HTMLElement;

    if (!inner) return;

    const fit =
      this._objectFit === "control"
        ? this._currentFit
        : (this._objectFit as any);

    if (fit === "contain") {
      // Fit inside (Standard wide frame)
      inner.setAttribute("d", "M3 7h18v10H3z");
      inner.style.opacity = "1";
    } else if (fit === "cover") {
      // Expand to cover (Corners)
      inner.setAttribute("d", "M15 3h6v6 M21 3l-7 7 M9 21H3v-6 M3 21l7-7");
      inner.style.opacity = "1";
    } else if (fit === "fill") {
      // Stretch to fill (Full box with crosshair)
      inner.setAttribute("d", "M3 3h18v18H3z M12 3v18 M3 12h18");
      inner.style.opacity = "1";
    } else if (fit === "zoom") {
      // Zoom (Brackets with center plus)
      inner.setAttribute(
        "d",
        "M10 3H3v7 M14 3h7v7 M3 14v7h10 M21 14v7h-7 M12 9v6 M9 12h6",
      );
      inner.style.opacity = "1";
    }
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

    const audioTracks = this.player.getAudioTracks();
    const activeTrack = this.player.trackManager.getActiveAudioTrack();

    // Hide container if only one or no audio tracks
    if (audioTracks.length <= 1) {
      audioTrackContainer.style.display = "none";
    } else {
      audioTrackContainer.style.display = "flex";
    }

    // Hide volume control if no audio tracks (length === 0)
    const volumeContainer = this.shadowRoot?.querySelector(
      ".movi-volume-container",
    ) as HTMLElement;
    if (volumeContainer) {
      volumeContainer.style.display = audioTracks.length > 0 ? "flex" : "none";
    }

    // If we only hid the container because checks matched but actually have 0 tracks, ensure consistency
    if (audioTracks.length === 0) {
      audioTrackContainer.style.display = "none";
      return;
    }

    // If not returned, we have > 0 tracks (so volume is visible) and > 1 track (so audio menu is visible)
    audioTrackBtn.style.display = "flex";

    // Build menu
    audioTrackList.innerHTML = audioTracks
      .map((track) => {
        const isActive = activeTrack?.id === track.id;
        const label = track.label || `Audio ${track.id}`;
        const infoParts: string[] = [];

        // Add language code if available
        if (track.language) {
          // Language might be in ISO 639-2 format (3 chars) or ISO 639-1 (2 chars)
          // Convert to uppercase and show first 2-3 characters
          const langCode =
            track.language.length >= 2
              ? track.language.substring(0, 3).toUpperCase()
              : track.language.toUpperCase();
          infoParts.push(langCode);
        }

        // Add channel count
        if (track.channels) {
          infoParts.push(`${track.channels}ch`);
        }

        const info = infoParts.length > 0 ? infoParts.join(" • ") : "";

        return `
        <div class="movi-audio-track-item ${isActive ? "movi-audio-track-active" : ""}" 
             data-track-id="${track.id}">
          <span class="movi-audio-track-label">${label}</span>
          ${info ? `<span class="movi-audio-track-info">${info}</span>` : ""}
        </div>
      `;
      })
      .join("");

    // Add click handlers
    audioTrackList
      .querySelectorAll(".movi-audio-track-item")
      .forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const trackId = parseInt(
            (item as HTMLElement).dataset.trackId || "0",
          );
          if (this.player) {
            this.player.selectAudioTrack(trackId);
            // Close menu
            const menu = this.shadowRoot?.querySelector(
              ".movi-audio-track-menu",
            ) as HTMLElement;
            if (menu) {
              menu.style.display = "none";
            }
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

    // Hide container if no subtitle tracks
    if (subtitleTracks.length === 0) {
      subtitleTrackContainer.style.display = "none";
      return;
    }

    subtitleTrackContainer.style.display = "flex";
    subtitleTrackBtn.style.display = "flex";

    // Toggle icons based on active state
    const subtitleIcon = this.shadowRoot?.querySelector(
      ".movi-icon-subtitle",
    ) as HTMLElement;
    const subtitleIconFilled = this.shadowRoot?.querySelector(
      ".movi-icon-subtitle-filled",
    ) as HTMLElement;

    if (activeTrack) {
      if (subtitleIcon) subtitleIcon.style.display = "none";
      if (subtitleIconFilled) subtitleIconFilled.style.display = "block";
    } else {
      if (subtitleIcon) subtitleIcon.style.display = "block";
      if (subtitleIconFilled) subtitleIconFilled.style.display = "none";
    }

    // Build menu - start with "Off" option
    let menuHTML = `
      <div class="movi-subtitle-track-item ${activeTrack === null ? "movi-subtitle-track-active" : ""}" 
           data-track-id="null">
        <span class="movi-subtitle-track-label">Off</span>
      </div>
    `;

    // Add subtitle tracks
    menuHTML += subtitleTracks
      .map((track) => {
        const isActive = activeTrack?.id === track.id;
        const label = track.label || `Subtitle ${track.id}`;
        const infoParts: string[] = [];

        // Add language code if available
        if (track.language) {
          const langCode =
            track.language.length >= 2
              ? track.language.substring(0, 3).toUpperCase()
              : track.language.toUpperCase();
          infoParts.push(langCode);
        }

        // Add subtitle type
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

    subtitleTrackList.innerHTML = menuHTML;

    // Add click handlers
    subtitleTrackList
      .querySelectorAll(".movi-subtitle-track-item")
      .forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const trackIdStr = (item as HTMLElement).dataset.trackId;
          Logger.debug(TAG, `Subtitle track item clicked: ${trackIdStr}`);
          if (this.player) {
            if (trackIdStr === "null") {
              // Disable subtitles
              Logger.debug(TAG, "Disabling subtitles");
              this.player.selectSubtitleTrack(null).catch((error) => {
                Logger.error(TAG, "Failed to disable subtitles", error);
              });
            } else {
              const trackId = parseInt(trackIdStr || "0");
              Logger.debug(TAG, `Selecting subtitle track: ${trackId}`);
              this.player
                .selectSubtitleTrack(trackId)
                .then((result) => {
                  Logger.debug(
                    TAG,
                    `Subtitle track selection result: ${result}`,
                  );
                })
                .catch((error) => {
                  Logger.error(TAG, "Failed to select subtitle track", error);
                });
            }
            // Close menu
            const menu = this.shadowRoot?.querySelector(
              ".movi-subtitle-track-menu",
            ) as HTMLElement;
            if (menu) {
              menu.style.display = "none";
            }
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
      :host(:fullscreen) canvas,
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
        margin-left: 8px;
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

      .movi-loop-btn.active svg {
        color: var(--movi-primary);
        filter: drop-shadow(0 0 8px var(--movi-primary-glow));
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
          font-size: 11px;
        }
        
        .movi-controls-bar {
          padding: 6px 16px 10px;
          gap: 4px;
        }
        
        .movi-controls-left,
        .movi-controls-right {
          gap: 4px;
        }
        
        .movi-btn {
          padding: 8px;
        }
        
        .movi-btn svg {
          width: 20px;
          height: 20px;
        }
        
        /* Show volume slider on mobile - user request */
        .movi-volume-slider-container {
          /* display: none !important; REMOVED */
        }
        
        .movi-progress-container {
          padding: 8px 0 2px;
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
      }

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
        min-width: 140px;
        max-height: 280px;
        overflow-y: auto;
        box-shadow: var(--movi-shadow-lg);
        z-index: 1001;
        pointer-events: auto !important;
        padding: 8px 0;
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
        z-index: 20;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .movi-thumbnail-img {
        width: auto;
        height: auto;
        max-width: 180px;
        max-height: 160px;
        object-fit: contain;
        margin-bottom: 4px;
        background-color: #000;
        border: 1px solid #333;
        border-radius: 2px;
        pointer-events: none;
      }
      .movi-seek-thumbnail.visible {
        opacity: 1;
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

    // Automatically initialize player if src is set
    if (this._src) {
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

    // Update button visibility - move outside of player check
    const aspectRatioBtn = this.shadowRoot?.querySelector(
      ".movi-aspect-ratio-btn",
    ) as HTMLElement;
    if (aspectRatioBtn) {
      aspectRatioBtn.style.display =
        this._objectFit === "control" ? "flex" : "none";
      // Ensure icon matches the state immediately
      this.updateAspectRatioIcon();
    }
  }

  /**
   * Automatically create and initialize MoviPlayer
   */
  private async initializePlayer(): Promise<void> {
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

      // Use canvas mode
      playerConfig.renderer = "canvas";
      playerConfig.canvas = this.canvas;

      // Update visibility
      this.canvas.style.display = "block";
      this.video.style.display = "none";

      // Create Player instance
      Logger.info(TAG, "Initializing MoviPlayer (Canvas Renderer Mode)");
      this.player = new MoviPlayer(playerConfig);

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

      // Dispatch load event
      this.dispatchEvent(new Event("loadeddata"));
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      Logger.error(TAG, "Failed to initialize MoviPlayer", error);

      let message = "An unexpected error occurred while loading the video.";
      let title = "Initialization Failed";

      if (error instanceof Error) {
        message = error.message;
        if (message.includes("fetch")) {
          title = "Network Error";
          message =
            "Failed to fetch video resource. Check your connection or CORS settings.";
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
    };
    this.player.trackManager.on("tracksChange", tracksChangeHandler);
    this.eventHandlers.set("tracksChange", () =>
      this.player?.trackManager.off("tracksChange", tracksChangeHandler),
    );

    // Forward player events to element
    const stateChangeHandler = (state: PlayerState) => {
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
      } else if (state === "ended") {
        this.dispatchEvent(new Event("ended"));
        this.showControls();
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
    const isDecoderError =
      title === "Format Unsupported" ||
      title === "Codec Unsupported" ||
      title === "Playback Error" ||
      message?.toLowerCase().includes("decoder") ||
      message?.toLowerCase().includes("codec");

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
      ".movi-play-pause, .movi-progress-container, .movi-audio-track-btn, .movi-subtitle-track-btn, .movi-hdr-btn, .movi-speed-btn, .movi-aspect-ratio-btn, .movi-loop-btn, .movi-fullscreen-btn, .movi-more-btn, .movi-center-play-pause, .movi-seek-backward, .movi-seek-forward";
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

    // Apply to external ambient wrapper element
    if (this.ambientWrapperElement && this._ambientMode) {
      this.ambientWrapperElement.style.background = gradient;

      // For light mode, we might also want to add a subtle box shadow to help it pop
      if (this._theme === "light") {
        this.ambientWrapperElement.style.filter =
          "saturate(1.5) brightness(1.1)";
      } else {
        this.ambientWrapperElement.style.filter = "none";
      }
    }
  }

  get src(): string | File | null {
    return this._src;
  }

  set src(value: string | File | null) {
    // Reset title-related flags when src changes
    if (this._titleAutoLoaded) {
      // If title was auto-loaded (not explicitly set by user), reset it
      this._title = null;
    }
    this._titleAutoLoaded = false;
    this._lastDuration = 0;

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

    if (this._loop) {
      loopBtn?.classList.add("active");
      loopMenuItem?.classList.add("movi-context-menu-active");
      if (loopStatus) loopStatus.textContent = "On";
    } else {
      loopBtn?.classList.remove("active");
      loopMenuItem?.classList.remove("movi-context-menu-active");
      if (loopStatus) loopStatus.textContent = "Off";
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
      // Only allow seeking if player is ready, playing, or paused
      const state = this.player.getState();
      if (
        state === "ready" ||
        state === "playing" ||
        state === "paused" ||
        state === "ended"
      ) {
        this.isSeeking = true;
        this.player
          .seek(value)
          .catch((error) => {
            Logger.error(TAG, "Seek error", error);
          })
          .finally(() => {
            // Note: In rapid seeking (frame-by-frame), we don't clear isSeeking immediately
            // if we want to avoid progress bar jumps, but we must allow next seek to proceed.
            this.isSeeking = false;
          });
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
          const lastDotIndex = filename.lastIndexOf(".");
          if (lastDotIndex > 0) {
            // Only remove extension if dot is not at the start (hidden files)
            this._title = filename.substring(0, lastDotIndex);
          } else {
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
