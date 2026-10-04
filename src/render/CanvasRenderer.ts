/**
 * CanvasRenderer - Renders VideoFrames to canvas with frame-perfect timing
 * Uses a frame queue and presentation loop for smooth 60Hz playback
 */

import { Logger } from "../utils/Logger";
import type { SubtitleCue } from "../types";
import { KARAOKE_GHOST_DELIM } from "./sanitizeVttHtml";

const TAG = "CanvasRenderer";

/**
 * What the renderer can draw. The WebCodecs path hands over decoded
 * VideoFrames; the MSE wrappers (Shaka/hls.js/DASH) hand over their <video>
 * element directly.
 *
 * They used to wrap it — `new VideoFrame(videoElement)` — and that construction
 * succeeds on Firefox Android while the upload behind it does not: the element
 * holds a hardware surface Firefox can't read back for a CPU texture upload, so
 * every frame arrived as "tex(Sub)Image[23]D: Failed to retrieve source bytes
 * for CPU upload" and the canvas stayed black through perfectly good playback.
 * gl.getError() reports NO_ERROR for it, so none of the fallbacks below fire.
 * Uploading the element itself takes the browser's accelerated video-texture
 * path instead, which is the one every WebGL video site depends on.
 */
export type RenderSource = VideoFrame | HTMLVideoElement;

/** Narrow a RenderSource to the <video>-element case. */
export function isVideoElementSource(
  source: RenderSource,
): source is HTMLVideoElement {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    source instanceof HTMLVideoElement
  );
}

/** Presented width of either source, in content pixels. */
function sourceWidth(source: RenderSource): number {
  return isVideoElementSource(source) ? source.videoWidth : source.displayWidth;
}

/** Presented height of either source, in content pixels. */
function sourceHeight(source: RenderSource): number {
  return isVideoElementSource(source)
    ? source.videoHeight
    : source.displayHeight;
}

/**
 * A snapshot of the live 360° camera + projection, enough to reproject an
 * equirectangular frame to exactly what the user currently sees. Consumed by
 * the thumbnail/preview renderer so seek-bar previews match the on-screen view.
 */
export interface VRView {
  yaw: number; // radians, look left/right (current, post-spring)
  pitch: number; // radians, look up/down
  fov: number; // vertical field of view (radians)
  aspect: number; // player viewport width / height (frames the preview to match)
  half: boolean; // VR180 (front hemisphere)
  fisheye: boolean; // equidistant fisheye
  sbs: boolean; // side-by-side stereo (left eye)
  stereographic: boolean; // little-planet
  texAspect: number; // source frame width / height
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private width: number = 0;
  private height: number = 0;
  private colorSpace: string = "srgb"; // Default to sRGB
  private hasNativeHDRSupport: boolean = false; // Native HDR support detection (Chromium)

  // Frame queue for presentation timing
  private frameQueue: VideoFrame[] = [];
  // Increased for 4K 60fps: need ~1.5-2s buffering = 90-120 frames at 60fps
  // Base size of 120 provides ~2s at 60fps, ~4s at 30fps
  private static readonly MAX_FRAME_QUEUE = 120;

  // Ceiling on how long the presentation anchor may be pushed into the future
  // to wait for a high-latency audio output. See audioStartLeadMs().
  //
  // Set above a real Bluetooth lead (~305ms of device lead plus ~305ms of
  // output latency) on purpose: capping BELOW it doesn't avoid the wait, it
  // splits it — the picture starts early by the remainder and the drift
  // correction still has to claw that back, which is the stutter this is here
  // to remove. It is a guard against a nonsense reading, not a budget.
  private static readonly MAX_AUDIO_START_LEAD_S = 0.7;

  private hdrEnabled: boolean = true;
  private isHDRSource: boolean = false;
  private isHighBitDepth: boolean = false; // 12-bit+ content needs RGBA16F texture
  private _loggedFrameFormat: boolean = false;

  // Ambient mode mini-render: a 16×16 RGBA8 framebuffer that mirrors each
  // drawn frame. Lets MoviElement sample average color via a 256-pixel
  // readPixels (sync, ~microseconds) instead of an 8K canvas readback
  // (~100ms GPU stall). Created lazily when ambient mode turns on.
  /** Frames turned down by the no-going-backwards rule since anything last
   *  reached the screen — see selectFrameForPresentation. */
  private _backwardsRefused = 0;
  private _backwardsReportedAt = 0;
  /** Only worth saying once the hold is longer than any ordinary gap. */
  private static readonly BACKWARDS_REPORT_AFTER_MS = 250;
  private static readonly BACKWARDS_REPORT_EVERY_MS = 2000;
  private static readonly AMBIENT_SIZE = 16;
  private ambientFbo: WebGLFramebuffer | null = null;
  private ambientTex: WebGLTexture | null = null;
  private ambientEnabled: boolean = false;
  private ambientPixels: Uint8Array | null = null;

  // Presentation loop
  private rafId: number | null = null;
  private isPlaying: boolean = false;
  // A source with no picture never presents a frame, so the presentation loop
  // below refuses to run — and the caption clock was only ever driven from
  // inside it. See startSubtitleClock().
  private subtitleClockTimer: ReturnType<typeof setInterval> | null = null;
  // Data-saver: the source HAS a video track and this renderer is configured
  // for it, but nothing is being decoded. See setPictureSuspended().
  private pictureSuspended: boolean = false;
  // Set once configure() runs, which only happens when a real video track is
  // active. Audio-only sources (incl. cover-art "video" streams that
  // TrackManager classifies as attached-pic) never configure the renderer, so
  // this stays false and the presentation loop is skipped — no point spinning a
  // 60fps rAF + A/V sync against frames that never arrive.
  private isVideoConfigured: boolean = false;

  // Adaptive DPR — measure first second of playback at full 2x DPR. If
  // average paint takes more than ~half a frame at 60Hz, the device is
  // GPU-bound and a 2x backbuffer is the difference between smooth and
  // stuttering. Drop to 1x DPR (quarter the pixels) and trigger a
  // resize so the change takes effect. Measurement is one-shot: once
  // we've decided, no more sampling overhead. Beats `deviceMemory` /
  // `hardwareConcurrency` heuristics — those misclassify weak-GPU /
  // strong-RAM phones and undercount iOS where deviceMemory is absent.
  private _maxDpr: number = 2;
  private _paintSamples: number[] = [];
  private _adaptDprChecked: boolean = false;
  private static readonly PAINT_SAMPLE_COUNT = 60; // ~1 second @ 60Hz
  private static readonly PAINT_THRESHOLD_MS = 8; // >50% of 16.67ms frame budget
  /**
   * The second rung of the same ladder, and it counts the TAIL rather than the
   * average, because the average is not what hurts.
   *
   * A 12-bit source uploads RGBA16F — 3840x2160x4x2 is ~66MB a frame — and on a
   * machine that cannot absorb that the cost does not show up as a slow mean.
   * Measured on hevc_4k24P_rext_12bit_444_pq.mp4 over 30s, DPR already capped:
   * mean paint 3.03ms and p90 2.5ms, both healthy, while the MAX was 126.8ms
   * and twelve individual paints ran past 24ms. The mean-based rung above
   * cannot see that; twelve blocks longer than the audio output buffer is what
   * the viewer hears as crackle. The same file forced to RGBA8: max 2.5ms, and
   * not one paint over 16.7ms.
   *
   * So: a handful of genuinely long paints inside one window and the 16-bit
   * texture goes. Banding on a 12-bit HDR source is a real cost and this pays
   * it only on hardware that has already proved it cannot hold the frame.
   */
  private static readonly LONG_PAINT_MS = 20;
  private static readonly LONG_PAINT_WINDOW = 240; // ~10s at 24fps, ~4s at 60
  private static readonly LONG_PAINT_LIMIT = 4;
  private _longPaints = 0;
  private _paintsSeenSinceWindow = 0;
  private _bitDepthDowngraded = false;

  // Adaptive frame-rate cap — the second-stage degrade after adaptive DPR.
  // Some devices (low-end mobile on 4K60) can't hold the source rate even at
  // 1x DPR: either the paint/composite budget is blown or the decoder runs
  // sub-realtime. We compare the *achieved* distinct-present rate to the source
  // rate over 1s windows; a sustained deficit while audio is healthy means the
  // video pipeline — not the network — is the wall (a network stall starves
  // audio too, so gating on audio health keeps it from false-triggering). We
  // then halve the present target, dropping intermediate frames evenly so
  // motion stays smooth at the lower rate, and on the software path ask the
  // decoder to skip non-reference frames to cut CPU as well. One-way per
  // source, mirroring adaptive DPR — no oscillation.
  private _presentFpsCap: number = 0; // 0 = uncapped
  // Consecutive windows that held the cap comfortably, and how many of them the
  // next probe needs. See the lift in samplePerformance().
  private _capHealthyWindows: number = 0;
  private _capProbeAfterWindows: number = 10; // = PERF_CAP_PROBE_WINDOWS (declared below)
  private _perfDegradeChecked: boolean = false;
  // Latched once the decode-bound catastrophe fires: this device cannot decode
  // the current rung at all. Read by the element's frozen-video watchdog, whose
  // "clock moving, no new frames" trigger this condition satisfies permanently
  // — without it that watchdog reads a slow decoder as a stuck pipeline and
  // keeps issuing corrective seeks that cannot help. Cleared by configure().
  private _decodeBound: boolean = false;
  private _videoBacklog: (() => number) | null = null;
  // Whether the decoder held any queued work at ANY point in the current
  // window. Sampling it once per window would miss it: the queue drains and
  // refills within a window even on a decoder that is genuinely behind (an 8K
  // trace showed 0-30 packets oscillating every few hundred ms), so a single
  // unlucky read would excuse a device that really can't keep up.
  private _backlogSeenStuck: boolean = false;
  private _backlogSeenDeficit: boolean = false;
  private _perfWindowStart: number = 0; // performance.now() of the current window, 0 = not started
  private _perfWindowBaseCount: number = 0; // framesPresented at window start
  private _perfDeficitWindows: number = 0; // consecutive struggling windows
  // Decode-bound (STUCK) detector — a separate, TIME-based window so it works
  // even when the frame-warmup gate never clears: a near-frozen decoder barely
  // advances framesPresented, so it would sit under PERF_WARMUP_FRAMES forever
  // and the slow-path deficit check would never run. Audio-gated so a network
  // stall (audio starves too) isn't blamed on the video pipeline.
  private _perfStuckWindows: number = 0;
  private _stuckWindowStart: number = 0;
  private _stuckBaseCount: number = 0;
  // performance.now() when the perf detectors were (re)armed by configure().
  // The startup grace is measured from here.
  private _perfArmedAt: number = 0;
  // Host-page contention. The presentation loop can only put up as many frames
  // as rAF hands it callbacks, and on a page running its own heavy JS animation
  // the main thread is busy enough that rAF fires well below the display rate.
  // From inside the detectors below that is indistinguishable from a decoder
  // that cannot keep up — so an animation-heavy site reads as decode-bound and
  // gets its rung dropped, losing resolution because of the SITE's animations
  // rather than anything about the device or the link. Three-way per window:
  //   queue empty                      → decode really is behind (backlog latches)
  //   queue ready, our own tick is long → OUR draw is the cost; capping helps
  //   queue ready, our own tick is short → someone else owns the thread; excuse it
  private _rafTicks: number = 0; // presentation-loop callbacks this window
  private _rafSelfMs: number = 0; // wall time spent INSIDE those callbacks
  private _rafWindowStart: number = 0; // 0 = not started
  private _framesReadyInWindow: boolean = false; // queue was non-empty at some tick
  private _hostContended: boolean = false; // verdict of the last completed window
  private _hostContentionLogged: boolean = false; // log once per source
  private _onPerformanceDegrade: ((targetFps: number) => void) | null = null;
  private static readonly PERF_WINDOW_MS = 1000;
  private static readonly PERF_DEFICIT_RATIO = 0.7; // achieved < 70% of source rate = struggling
  private static readonly PERF_DEFICIT_WINDOWS = 4; // consecutive bad windows before engaging
  // Startup/rendition-switch grace. For the first few seconds after a source
  // (or rung) is configured, decode FPS is NATURALLY low and unrepresentative:
  // the decoder is warming up, the buffer is still filling, the thumbnail
  // pipeline is initialising (a second decoder competing for the GPU), and a
  // heavy 4K/HDR rung needs a moment to reach steady state. Capping quality in
  // that window is the "dropped 4K in the first seconds even though the device
  // could hold it once buffered" case. The detectors still ACCUMULATE during
  // the grace — they just don't ENGAGE a cap/downshift until it passes.
  private static readonly PERF_STARTUP_GRACE_MS = 12000;
  // ~4s of near-zero video with healthy audio = decode-bound, not transient
  // recovery (a keyframe hunt restores frames within ~1-2s).
  private static readonly PERF_STUCK_WINDOWS = 4;
  private static readonly PERF_WARMUP_FRAMES = 60; // skip startup / post-seek ramp
  private static readonly PERF_MIN_CAP_FPS = 24; // never cap below this
  // Below this share of the target rate the frame-rate lever cannot close the
  // gap, so don't spend windows proving it — go straight to the ABR.
  private static readonly PERF_SEVERE_RATIO = 0.4;
  // Below this achieved rate the pipeline is STUCK (decoder error / recovering /
  // EOF / starved), not merely slow — capping the present rate or dropping
  // frames can't help, and it must not turn on disposable-frame skipping while
  // the decoder is hunting a keyframe to recover. A genuinely decode-bound
  // device still presents well above this.
  private static readonly PERF_MIN_ACHIEVED_FPS = 5;
  // rAF cadence below this share of the rate we are trying to present at means
  // the callbacks themselves are the ceiling — no decoder can beat it, so
  // nothing the adaptive-FPS or ABR levers do would gain a single frame.
  // A window that comes within this share of the CAPPED rate is holding the cap
  // comfortably — the only evidence available, from inside a cap, that the
  // device might manage more.
  private static readonly PERF_CAP_HOLD_RATIO = 0.95;
  // How many such windows before the cap is lifted to re-judge, and the ceiling
  // that backoff climbs to. Ten seconds is short enough that a passing squeeze
  // does not cost the rest of the film, and the doubling below means a device
  // that genuinely cannot hold the full rate is probed ever more rarely instead
  // of flapping.
  private static readonly PERF_CAP_PROBE_WINDOWS = 10;
  private static readonly PERF_CAP_PROBE_MAX_WINDOWS = 160;
  private static readonly PERF_CONTENTION_RAF_RATIO = 0.7;
  // …and if our own ticks account for less than this share of the window's wall
  // time, the thread is being held by the host page rather than by us. A
  // healthy 60fps draw is a few ms of each 16.7ms frame (~25%); a draw heavy
  // enough to BE the bottleneck runs well above this, and must stay judgeable —
  // present-capping is exactly the right answer for that one.
  private static readonly PERF_CONTENTION_SELF_SHARE = 0.35;

  // Audio time provider for A/V sync
  private getAudioTime: (() => number) | null = null;
  private _isAudioHealthy: (() => boolean) | null = null;
  // Seconds until scheduled audio is actually audible — see
  // AudioRenderer.secondsUntilAudible(). Non-zero only on a high-latency
  // output (Bluetooth), and only for the moment after a start or a seek.
  private _audioStartLead: (() => number) | null = null;
  private _shouldMeasurePerf: (() => boolean) | null = null;

  // Presentation timing
  private presentationStartTime: number = 0;
  private presentationStartPts: number = 0;
  private lastPresentedPts: number = -1;
  private syncedToAudio: boolean = false;

  // Set when the picture's anchor was dropped ON PURPOSE — a rate change, or an
  // audio pipeline that was just rewound under it — as opposed to noticing we
  // had drifted. The difference matters at the re-sync below: a spontaneous
  // unsync is usually output jitter and re-anchoring on it stutters, so it is
  // gated behind a large drift; a REQUESTED one has no old anchor worth
  // keeping, and declining to re-anchor there is what left the offset in place.
  private reanchorRequested: boolean = false;
  private lastKnownAudioTime: number = -1;
  private playbackRate: number = 1.0;
  private justSeeked: boolean = false; // Track if we just seeked (for post-seek frame handling)
  /** When a frame last went up, or when the queue was last cleared. Only used
   *  to bound how long the picture may be held while pre-roll is dropped. */
  private _lastPresentAt = 0;
  private framesDropped: number = 0;
  /** Frames presented and dropped since this renderer was built, for
   *  getVideoPlaybackQuality() on the element. */
  getFrameStats(): { presented: number; dropped: number } {
    return { presented: this.framesPresented, dropped: this.framesDropped };
  }
  /** Called for every frame that reaches the screen — drives the element's
   *  requestVideoFrameCallback. */
  onFramePresented: ((mediaTime: number) => void) | null = null;
  private framesPresented: number = 0; // Track number of frames presented (for initial sync)

  // Current time tracking
  private currentTime: number = 0;

  // Frame rate for timing calculations
  private videoFrameRate: number = 60; // Default to 60fps

  // Rotation (degrees: 0, 90, 180, 270) - total = metadata + manual
  private rotation: number = 0;
  private metadataRotation: number = 0; // From video metadata
  private manualRotation: number = 0;   // User-applied rotation
  private containerWidth: number = 0;   // Original container width (before any rotation)
  private containerHeight: number = 0;  // Original container height

  // Fit mode for canvas rendering
  private fitMode: "contain" | "cover" | "fill" | "zoom" | "control" =
    "contain"; // Default to contain (maintain aspect ratio)
  private letterboxColor: [number, number, number] = [0, 0, 0]; // Current smoothed RGB (0-255)
  private letterboxTarget: [number, number, number] = [0, 0, 0]; // Target RGB from ambient sampling

  // 360° VR (equirectangular) projection. When enabled, drawFrame renders the
  // frame as the inside of a sphere viewed from its centre, via a per-fragment
  // equirectangular raycast, instead of the flat scaled/letterboxed quad. The
  // same fullscreen-quad VAO and texture upload are reused — only the program
  // and a handful of camera uniforms differ. The VR program is compiled lazily
  // the first time 360 mode is switched on (initVRProgram), so the 99% of
  // playback that is flat 2D pays nothing.
  private vr360Enabled: boolean = false;
  private vrProgram: WebGLProgram | null = null;
  private vrLocs: {
    image: WebGLUniformLocation | null;
    yaw: WebGLUniformLocation | null;
    pitch: WebGLUniformLocation | null;
    fov: WebGLUniformLocation | null;
    aspect: WebGLUniformLocation | null;
    lonDiv: WebGLUniformLocation | null;
    latDiv: WebGLUniformLocation | null;
    proj: WebGLUniformLocation | null;
    fishFov: WebGLUniformLocation | null;
    uScale: WebGLUniformLocation | null;
    uOffset: WebGLUniformLocation | null;
    planetScale: WebGLUniformLocation | null;
    srcAspect: WebGLUniformLocation | null;
  } | null = null;
  // VR180 (half-equirectangular): the frame covers only the front hemisphere.
  // The longitude span halves (π instead of 2π). false = full 360°.
  private vrHalf: boolean = false;
  // Fisheye projection (equidistant) instead of equirectangular — common in
  // VR180 camera captures (circular lens image with black corners).
  private vrFisheye: boolean = false;
  // Stereo side-by-side: the frame holds two eyes; sample only the left one.
  private vrStereoSbs: boolean = false;
  // Stereographic "little planet" projection (tiny-planet 360 clips).
  private vrStereographic: boolean = false;
  // Fisheye lens coverage (radians); 180° lenses → π.
  private static readonly VR_FISHEYE_FOV = Math.PI;
  // Stereographic horizon radius in image half-height units (tuned so a typical
  // tiny-planet's horizon sits sensibly; the camera reaches the rim/zenith).
  private static readonly VR_PLANET_SCALE = 0.5;
  // Source pixel aspect (width/height), used to derive the latitude span and to
  // clamp the VR180 camera so the viewport never exits the content (no black).
  private vrTexAspect: number = 2;
  // The camera is animated: input updates the *target*, and a light spring
  // eases the rendered (current) value toward it each frame — slightly
  // underdamped so it settles with a soft, YouTube-like glide/bounce instead
  // of snapping. drawVRFrame reads the current values; the targets are what
  // nudge/zoom/reset move.
  private vrYaw: number = 0; // current rendered yaw (radians)
  private vrPitch: number = 0; // current rendered pitch (radians)
  private vrFov: number = 1.2217; // current rendered FOV (radians, ~70°)
  private vrYawTarget: number = 0;
  private vrPitchTarget: number = 0;
  private vrFovTarget: number = 1.2217;
  private vrYawVel: number = 0; // spring velocity (rad/s)
  private vrPitchVel: number = 0;
  private vrAnimRaf: number | null = null;
  // Spring constants. DAMPING < 2·√STIFFNESS → underdamped. ζ ≈ 0.6 here
  // (DAMPING / 2·√STIFFNESS) gives a clear-but-tasteful ~9% overshoot — the
  // soft "bounce" YouTube has on release — while staying tight enough during
  // a drag not to feel laggy.
  private static readonly VR_STIFFNESS = 210;
  private static readonly VR_DAMPING = 17;
  private static readonly VR_FOV_LERP = 0.22; // zoom eases linearly, no bounce
  private static readonly VR_DEFAULT_FOV = 1.2217;
  private static readonly VR_MIN_FOV = 0.5236; // 30° — most zoomed-in
  private static readonly VR_MAX_FOV = 2.0944; // 120° — most zoomed-out


  // Subtitle rendering
  private activeSubtitleCue: SubtitleCue | null = null;
  // Cached text/cue used in the last innerHTML write. renderSubtitles() runs
  // every animation frame; without this guard we re-write innerHTML 60×/sec
  // even when the cue text hasn't changed, restarting the fade-in animation
  // each time and leaving the subtitle perpetually invisible during playback.
  private _lastRenderedSubtitleKey: string = "";
  // Plain text of what's currently on screen — used to find the suffix
  // delta of the next karaoke cue so only the new word fades in, instead
  // of the whole line re-animating each tick.
  private _lastRenderedSubtitlePlain: string = "";
  // Rendered line count of the previous subtitle paint. A growth in this while
  // the same sentence is still building is what triggers the scroll-up.
  private _lastSubtitleLineCount: number = 0;
  // The encoded PGS/DVB bitmap currently in the overlay, and which cue it came
  // from. A resize or a controls toggle re-lays out the same cue, and encoding
  // the PNG again for it is pure cost.
  private _lastImageCueKey: string = "";
  private _lastImageDataUrl: string = "";
  // Canvas + cached font string used to measure a karaoke cue's full
  // final-sentence width so the line can hold a stable min-width
  // anchor. The font cache is keyed by viewport width because the
  // subtitle font-size uses clamp() against vw.
  private _subtitleMeasureCanvas: HTMLCanvasElement | null = null;
  private _subtitleFontCache: { viewport: number; font: string } | null =
    null;
  // rAF handle that coalesces resize-driven subtitle re-renders. A
  // window drag fires ResizeObserver ~60×/s — running the full layout
  // pass (probe getComputedStyle, canvas measureText, innerHTML rewrite)
  // on every tick burns the main thread enough to stall the
  // presentation loop. One re-render per frame is plenty.
  private _subtitleRerenderRafId: number | null = null;
  private subtitleCues: SubtitleCue[] = [];
  private subtitleOverlay: HTMLElement | null = null;
  // See setHostSubtitleOwned().
  private _hostSubtitleOwned = false;
  /** The subtitle overlay element — absolutely positioned over the visible video
   *  (letterbox-aware). Handed to a host SubtitleRenderer as a mount point. */
  getSubtitleOverlay(): HTMLElement | null {
    return this.subtitleOverlay;
  }
  private subtitleControlsPadding: number = 0; // Extra padding when controls visible
  // Set while the viewer is dragging the caption. See setSubtitleHeld().
  private subtitleHeld: boolean = false;
  // Subtitle delay in seconds. VLC/mpv convention: positive = subs appear
  // later, negative = earlier. Applied at the active-cue check so it works
  // uniformly for text and image subtitles and can be adjusted live without
  // invalidating buffered cues.
  private subtitleDelay: number = 0;

  // Animation state for object-fit transitions
  // Content dimensions the current scale was derived from. A change means the
  // scale's frame of reference moved (a rendition switch), so interpolating
  // from it would animate through sizes that never made sense — snap instead.
  private _scaleContentW: number = 0;
  private _scaleContentH: number = 0;
  private currentScaleX: number = 0;
  private currentScaleY: number = 0;
  private lastTargetScaleX: number = 0;
  private lastTargetScaleY: number = 0;
  private fitAnimRafId: number | null = null;

  // Persist last rendered frame for redrawing on resize during pause
  /**
   * We must retain a clone of the last rendered frame because:
   * 1. resizing the canvas clears it (black screen)
   * 2. if paused, frameQueue is likely empty, so we have nothing to redraw
   * 3. we need to redraw the *current* image to restore the view
   */
  private lastRenderedFrame: RenderSource | null = null;

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    subtitleOverlay?: HTMLElement,
  ) {
    this.canvas = canvas;

    // Defer context creation to configure() so we can set the correct color space (sRGB vs P3)
    // Creating it here would lock it to sRGB in most browsers

    // Store subtitle overlay element if provided
    if (subtitleOverlay) {
      this.subtitleOverlay = subtitleOverlay;
    }

    Logger.debug(TAG, "Created");
  }

  private detectHDRColorSpace(
    colorPrimaries?: string,
    colorTransfer?: string,
  ): string {
    // HDR content typically uses BT.2020 primaries with PQ or HLG transfer
    const primaries = (colorPrimaries || "").toLowerCase();
    const transfer = (colorTransfer || "").toLowerCase();

    // Check for HDR indicators
    const isHDRTransfer =
      transfer.includes("pq") || // Perceptual Quantizer (HDR10/Dolby Vision)
      transfer.includes("hlg") || // Hybrid Log-Gamma
      transfer.includes("smpte2084") || // Legacy/FFmpeg PQ
      transfer.includes("arib-std-b67"); // Legacy/FFmpeg HLG

    const isBT2020 =
      primaries.includes("bt2020") || primaries.includes("rec2020");

    if (!this.hdrEnabled) {
      return "srgb";
    }

    if (isHDRTransfer || isBT2020) {
      Logger.info(
        TAG,
        `HDR/BT.2020 content detected (primaries: ${colorPrimaries}, transfer: ${colorTransfer}). Using display-p3 color space (if supported) for HDR.`,
      );
      return "display-p3";
    }

    if (primaries.includes("p3") || primaries.includes("display-p3")) {
      Logger.info(
        TAG,
        `Wide Gamut (P3) content detected. Using display-p3 color space.`,
      );
      return "display-p3";
    }

    return "srgb";
  }

  /**
   * Configure renderer dimensions and color space for HDR support
   */
  configure(
    width: number,
    height: number,
    colorPrimaries?: string,
    colorTransfer?: string,
    frameRate?: number,
    rotation?: number,
    isHDR?: boolean,
    pixelFormat?: string,
  ): void {
    const hadSubtitleClock = this.subtitleClockTimer !== null;
    this.isVideoConfigured = true;
    if (hadSubtitleClock && !this.pictureSuspended) {
      // A picture arrived mid-track (a switch off an audio-only rendition).
      // The presentation loop owns the captions again — but the play() that
      // started this run already called startPresentationLoop() and was turned
      // away, so nothing else will start it.
      this.stopSubtitleClock();
      if (this.isPlaying && this.rafId === null) {
        this.isPlaying = false;
        this.startPresentationLoop();
      }
    }
    // Detect high bit-depth (12-bit+) content that needs RGBA16F textures
    const pf = (pixelFormat || "").toLowerCase();
    this.isHighBitDepth = pf.includes("12") || pf.includes("14") || pf.includes("16");
    if (this.isHighBitDepth) {
      Logger.info(TAG, `High bit-depth content detected (${pixelFormat}), using RGBA16F texture`);
    }
    // Note: We don't overwrite this.width/height if they've already been set by resize()
    if (this.width === 0 || this.height === 0) {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
    }

    // Set video frame rate
    if (frameRate && frameRate > 0) {
      this.videoFrameRate = frameRate;
      Logger.debug(TAG, `Video frame rate: ${frameRate}fps (target: 60fps)`);
    } else {
      this.videoFrameRate = 60;
    }

    // Fresh source / rendition switch: re-arm the adaptive-FPS + decode-bound
    // detectors and clear any prior cap so the new rung gets a fresh judgment.
    this._presentFpsCap = 0;
    this._capHealthyWindows = 0;
    this._capProbeAfterWindows = CanvasRenderer.PERF_CAP_PROBE_WINDOWS;
    this._perfDegradeChecked = false;
    this._decodeBound = false;
    this._backlogSeenStuck = false;
    this._backlogSeenDeficit = false;
    this._perfWindowStart = 0;
    this._perfDeficitWindows = 0;
    this._perfStuckWindows = 0;
    this._stuckWindowStart = 0;
    this._perfArmedAt = 0; // stamped on the first sample once playback is live
    this.resetRafCadence();
    this._hostContentionLogged = false;

    // Set rotation from metadata
    if (rotation !== undefined) {
      this.metadataRotation = rotation;
      this.rotation = (this.metadataRotation + this.manualRotation) % 360;
      if (this.canvas instanceof HTMLCanvasElement) {
        this.canvas.style.transform = `rotate(${this.rotation}deg)`;
        this.canvas.style.transformOrigin = "center center";
      }
      Logger.debug(TAG, `Rotation set to: ${this.rotation}° (metadata: ${this.metadataRotation}°, manual: ${this.manualRotation}°)`);
    }

    // Capture metadata for potential re-config (HDR toggle)
    this.lastPrimaries = colorPrimaries;
    this.lastTransfer = colorTransfer;

    // Evaluate if source is HDR (regardless of current toggle state)
    if (isHDR !== undefined) {
      this.isHDRSource = isHDR;
    } else {
      const primaries = (colorPrimaries || "").toLowerCase();
      const transfer = (colorTransfer || "").toLowerCase();

      Logger.debug(
        TAG,
        `Checking HDR support - Primaries: '${primaries}', Transfer: '${transfer}'`,
      );

      const isHDRTransfer =
        transfer.includes("pq") ||
        transfer.includes("hlg") ||
        transfer.includes("smpte2084") ||
        transfer.includes("arib-std-b67");
      const isBT2020 =
        primaries.includes("bt2020") || primaries.includes("rec2020");
      this.isHDRSource = isHDRTransfer || isBT2020;
    }

    // Detect HDR and get appropriate color space
    const detectedColorSpace = this.detectHDRColorSpace(
      colorPrimaries,
      colorTransfer,
    );

    // Initialize WebGL
    try {
      const contextOptions: WebGLContextAttributes = {
        // Transparent, so the corners the shader declines to draw show whatever
        // is behind the player rather than black. Premultiplied, so the shader
        // scales colour and alpha together when it feathers a corner.
        alpha: true,
        premultipliedAlpha: true,
        desynchronized: false, // Disabled to prevent flickering on low-end devices
        antialias: false,
        depth: false,
        preserveDrawingBuffer: true, // Might be needed for some HDR scenarios
      };

      this.gl = this.canvas.getContext(
        "webgl2",
        contextOptions,
      ) as WebGL2RenderingContext;

      if (!this.gl) {
        Logger.error(TAG, "WebGL2 not supported");
        return;
      }

      // Configure color space on the GL context (Chrome 104+, Safari 17+).
      // For HDR PQ/HLG sources on Chromium, tag the canvas with
      // rec2100-pq/hlg — Chrome's compositor then sends the buffer to the
      // HDR display at full peak brightness. display-p3 alone is wide-gamut
      // SDR (~100 nits) and tone-maps PQ highlights down, making HDR look
      // dim. The HDR Canvas spec's RGBA16F float buffer (drawingBufferStorage)
      // is NOT required for this — the colorspace tag is independent of the
      // buffer's bit depth. 8-bit PQ has some quantization banding but
      // unlocks the full HDR brightness range, which Ujjawal prefers.
      try {
        const isChromium = !!(window as any).chrome;
        const transferLc = (colorTransfer || "").toLowerCase();
        const isHLGSource =
          transferLc.includes("hlg") || transferLc.includes("arib-std-b67");
        const isHDRPath =
          this.isHDRSource && this.hdrEnabled && isChromium;
        const hdrSpace = isHLGSource ? "rec2100-hlg" : "rec2100-pq";

        // @ts-ignore
        if (this.gl.drawingBufferColorSpace !== undefined) {
          let targetSpace: string;
          if (isHDRPath) {
            targetSpace = hdrSpace;
          } else if (detectedColorSpace !== "srgb") {
            // Wide-gamut SDR or HDR-disabled fallback
            const supportedSpaces = ["srgb", "display-p3"];
            targetSpace = supportedSpaces.includes(detectedColorSpace)
              ? detectedColorSpace
              : "srgb";
          } else {
            targetSpace = "srgb";
          }

          if (targetSpace !== "srgb") {
            // rec2100-pq/hlg is a Chromium extension behind
            // chrome://flags#enable-experimental-web-platform-features
            // (and Chrome version dependent). In practice Chromium does
            // not silently ignore unsupported values — the setter throws.
            // Try the HDR space first; on throw or readback mismatch,
            // fall back to display-p3 (wide-gamut SDR) instead of leaving
            // the canvas on srgb.
            let applied: string | null = null;
            try {
              // @ts-ignore
              this.gl.drawingBufferColorSpace = targetSpace;
              // @ts-ignore
              if (this.gl.drawingBufferColorSpace === targetSpace) {
                applied = targetSpace;
              }
            } catch (_e) {
              // setter threw — flag likely off, fall through to fallback
            }

            if (!applied && isHDRPath) {
              Logger.warn(
                TAG,
                `Browser rejected ${targetSpace}. HDR canvas flag likely disabled — falling back to display-p3.`,
              );
              try {
                // @ts-ignore
                this.gl.drawingBufferColorSpace = "display-p3";
                applied = "display-p3";
              } catch (_e2) {
                applied = null;
              }
            }

            if (applied) {
              // @ts-ignore
              this.gl.unpackColorSpace = applied;
              Logger.info(
                TAG,
                `WebGL drawing buffer color space set to: ${applied} (requested: ${detectedColorSpace}, HDR path: ${isHDRPath})`,
              );
            }
            this.setMacHdrCompositingGuard(applied === hdrSpace);
          } else {
            // …and an SDR source has to say so. The context outlives the
            // source: play an HDR film, then load an ordinary one, and the
            // canvas was still tagged rec2100-pq from the film — so the
            // compositor read plain Rec.709 as PQ and the picture came out
            // washed and grey. Only the non-srgb branch above ever assigned
            // the tag, so nothing took it off again.
            try {
              // @ts-ignore
              this.gl.drawingBufferColorSpace = "srgb";
              // @ts-ignore
              this.gl.unpackColorSpace = "srgb";
            } catch (_e) {
              /* a context that does not take the property never had one */
            }
            this.setMacHdrCompositingGuard(false);
          }
        }
      } catch (e) {
        Logger.warn(
          TAG,
          "Failed to set drawingBufferColorSpace on GL context",
          e,
        );
      }

      this.initWebGL();
      // If 360° was requested before the context existed (e.g. the `vr`
      // attribute), compile the VR program now so the first/poster frame
      // paints in 360 rather than flat.
      if (this.vr360Enabled && !this.vrProgram) {
        this.initVRProgram();
      }
      this.colorSpace = detectedColorSpace;
      Logger.info(
        TAG,
        `Configured WebGL2: ${width}x${height} (colorSpace: ${this.colorSpace})`,
      );
    } catch (error) {
      Logger.error(TAG, "Error configuring WebGL", error);
    }
  }

  private initWebGL() {
    if (!this.gl) return;

    // Detect if browser supports native HDR (drawingBufferColorSpace)
    // Only Chromium-based browsers (Chrome, Edge, Opera, Brave) have working native HDR
    // Use same detection as MoviElement for consistency
    const isChromium = !!(window as any).chrome;

    // For Chromium browsers, we trust the native HDR handling via drawingBufferColorSpace
    // This provides the best quality and color accuracy
    this.hasNativeHDRSupport = isChromium;

    Logger.info(
      TAG,
      `Browser detection: isChromium=${isChromium}, drawingBufferColorSpace=${this.gl.drawingBufferColorSpace !== undefined}, hasNativeHDRSupport=${this.hasNativeHDRSupport}, isHDRSource=${this.isHDRSource}`,
    );

    // Choose initialization based on browser capability:
    // - Chromium browsers: ALWAYS use simple passthrough (native HDR handling via color space)
    // - Non-Chromium with HDR content: use shader-based tone mapping (required for PQ decoding)
    const needsShaderToneMapping =
      !this.hasNativeHDRSupport && this.isHDRSource;

    if (needsShaderToneMapping) {
      Logger.info(
        TAG,
        `Initializing WebGL with shader-based HDR tone mapping (non-Chromium)`,
      );
      this.initWebGLWithHDR();
    } else {
      Logger.info(
        TAG,
        `Initializing WebGL with simple passthrough (Chromium native HDR)`,
      );
      this.initWebGLSimple();
    }
  }

  /**
   * Original simple WebGL initialization for Chromium (native HDR support)
   * This is the exact original configuration that works best for Chromium browsers
   */
  private initWebGLSimple() {
    if (!this.gl) return;
    const gl = this.gl;

    const vsSource = `#version 300 es
    layout(location = 0) in vec2 a_position;
    layout(location = 1) in vec2 a_texCoord;
    out vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }`;

    const fsSource = `#version 300 es
    precision highp float;
    uniform sampler2D u_image;
    // Rounded corners, cut in the shader.
    //
    // CSS cannot do this here: Firefox composites the canvas as its own layer
    // and ignores both border-radius and clip-path on it until that layer is
    // rebuilt, so a page that rounds the player got square corners over its own
    // rounded frame. Pixels the shader refuses to draw are transparent whatever
    // the compositor believes, so the rounding survives.
    // x = radius in drawing-buffer pixels (0 disables), yz = buffer size.
    uniform vec3 u_round;
    // Per corner, in drawing-buffer pixels: top-left, top-right, bottom-right,
    // bottom-left. u_round.x is the largest of them (0 disables the cut).
    uniform vec4 u_radii;
    float movi_cornerR(vec2 p, vec2 h) {
      // gl_FragCoord's origin is the bottom-left corner.
      return p.x < h.x ? (p.y >= h.y ? u_radii.x : u_radii.w) : (p.y >= h.y ? u_radii.y : u_radii.z);
    }
    // The part of the frame to actually show, in texture coordinates
    // (x0,y0 → x1,y1). The whole frame by default; narrowed when the black bars
    // baked INTO the picture are cropped away — see setBarCropEnabled.
    uniform vec4 u_crop;
    in vec2 v_texCoord;
    out vec4 outColor;
    void main() {
      outColor = texture(u_image, mix(u_crop.xy, u_crop.zw, v_texCoord));
      // The picture is opaque: the context is transparent only so a CUT corner
      // can show the page through it. Trusting the texture's own alpha instead
      // turned the whole canvas transparent on the paths that upload without
      // one (10-bit HEVC lands in RGBA16F with alpha 0) — the video vanished
      // and the page behind showed through as a black screen.
      outColor.a = 1.0;
      if (u_round.x > 0.0) {
        vec2 halfSize = u_round.yz * 0.5;
        float rr1 = movi_cornerR(gl_FragCoord.xy, halfSize);
        vec2 q = abs(gl_FragCoord.xy - halfSize) - (halfSize - vec2(rr1));
        float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - rr1;
        // d is in pixels, and the centre of an edge pixel sits exactly 0.5
        // inside the shape — so the falloff has to be one pixel wide and
        // centred on the boundary. A wider band (this was -0.75..0.75) still
        // takes ~7% off that last row, which reads as a thin dark line along
        // every straight edge where the host's black shows through.
        outColor *= 1.0 - smoothstep(-0.5, 0.5, d);
      }
    }`;

    // Create Program
    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        Logger.error(TAG, "Shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vert = createShader(gl.VERTEX_SHADER, vsSource);
    const frag = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vert || !frag) return;

    this.program = gl.createProgram();
    if (!this.program) return;
    gl.attachShader(this.program, vert);
    gl.attachShader(this.program, frag);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      Logger.error(
        TAG,
        "Program link error:",
        gl.getProgramInfoLog(this.program),
      );
      return;
    }

    // Quad mapping:
    // Vertices: (-1,1)=TL, (-1,-1)=BL, (1,1)=TR, (1,-1)=BR
    // UVs: (0,0)=TL, (0,1)=BL, (1,0)=TR, (1,1)=BR
    // This assumes video texture is uploaded with row 0 at top (standard)
    const vertices = new Float32Array([
      -1.0, 1.0, 0.0, 0.0, -1.0, -1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, -1.0,
      1.0, 1.0,
    ]);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0);

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (!this.program) return;
    const uImage = gl.getUniformLocation(this.program, "u_image");
    if (uImage && this.program) {
      gl.useProgram(this.program);
      gl.uniform1i(uImage, 0);
    }

  }

  /**
   * WebGL initialization with HDR tone mapping shader for non-Chromium browsers
   * Safari/Firefox need explicit PQ decoding and tone mapping
   */
  private initWebGLWithHDR() {
    if (!this.gl) return;
    const gl = this.gl;

    const vsSource = `#version 300 es
    layout(location = 0) in vec2 a_position;
    layout(location = 1) in vec2 a_texCoord;
    out vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }`;

    const fsSource = `#version 300 es
    precision highp float;
    uniform sampler2D u_image;
    uniform float u_hdrEnabled; // 0.0 = disabled, 1.0 = enabled
    // The part of the frame to actually show, in texture coordinates
    // (x0,y0 → x1,y1). The whole frame by default; narrowed when the black bars
    // baked INTO the picture are cropped away — see setBarCropEnabled.
    uniform vec4 u_crop;

    // Rounded corners cut in the shader — see the passthrough program.
    // x = radius in drawing-buffer pixels (0 disables), yz = buffer size.
    uniform vec3 u_round;
    // Per corner, in drawing-buffer pixels: top-left, top-right, bottom-right,
    // bottom-left. u_round.x is the largest of them (0 disables the cut).
    uniform vec4 u_radii;
    float movi_cornerR(vec2 p, vec2 h) {
      // gl_FragCoord's origin is the bottom-left corner.
      return p.x < h.x ? (p.y >= h.y ? u_radii.x : u_radii.w) : (p.y >= h.y ? u_radii.y : u_radii.z);
    }

    in vec2 v_texCoord;
    out vec4 outColor;

    // PQ (SMPTE 2084) EOTF constants
    const float m1 = 2610.0 / 16384.0;
    const float m2 = 2523.0 / 4096.0 * 128.0;
    const float c1 = 3424.0 / 4096.0;
    const float c2 = 2413.0 / 4096.0 * 32.0;
    const float c3 = 2392.0 / 4096.0 * 32.0;

    vec3 PQtoLinear(vec3 pq) {
      vec3 colToPow = pow(pq, vec3(1.0 / m2));
      vec3 num = max(colToPow - c1, vec3(0.0));
      vec3 den = c2 - c3 * colToPow;
      return pow(num / den, vec3(1.0 / m1));
    }

    vec3 toneMapReinhard(vec3 hdr, float exposure) {
      vec3 mapped = hdr * exposure;
      return mapped / (1.0 + mapped);
    }

    vec3 adjustSaturation(vec3 color, float saturation) {
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      vec3 gray = vec3(luminance);
      return mix(gray, color, saturation);
    }

    void main() {
      vec4 color = texture(u_image, mix(u_crop.xy, u_crop.zw, v_texCoord));

      // Apply PQ EOTF to get linear light
      vec3 linear = PQtoLinear(color.rgb);

      // Tone map to SDR range.
      // Reinhard's x/(1+x) curve gets steep fast — every extra unit of
      // exposure pushes mid-tones harder toward white, which reads as
      // crushed highlights + boosted contrast on most SDR displays.
      // The HDR-on path used to push exposure to 35.0 to "match Chrome
      // native HDR vibrance"; in practice that overshot native, with
      // visible extra contrast vs the <video> tag on the compare page.
      // 26.0 keeps the HDR path noticeably punchier than HDR-off (22.0)
      // without crushing highlights past where Chrome's compositor
      // lands.
      float exposure = mix(22.0, 26.0, u_hdrEnabled);
      vec3 sdr = toneMapReinhard(linear, exposure);

      // Saturation boost. 1.5 read as oversaturated next to native;
      // 1.25 keeps the wide-gamut feel without the cartoonish punch.
      float saturation = mix(1.1, 1.25, u_hdrEnabled);
      sdr = adjustSaturation(sdr, saturation);

      // Apply gamma (2.2 for accurate color reproduction)
      vec3 display = pow(sdr, vec3(1.0/2.2));

      outColor = vec4(display, 1.0); // opaque — see the passthrough program
      if (u_round.x > 0.0) {
        vec2 halfSizeR = u_round.yz * 0.5;
        float rr2 = movi_cornerR(gl_FragCoord.xy, halfSizeR);
        vec2 qR = abs(gl_FragCoord.xy - halfSizeR) - (halfSizeR - vec2(rr2));
        float dR = length(max(qR, vec2(0.0))) + min(max(qR.x, qR.y), 0.0) - rr2;
        outColor *= 1.0 - smoothstep(-0.5, 0.5, dR);
      }
    }`;

    // Create Program
    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        Logger.error(TAG, "Shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vert = createShader(gl.VERTEX_SHADER, vsSource);
    const frag = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vert || !frag) return;

    this.program = gl.createProgram();
    if (!this.program) return;
    gl.attachShader(this.program, vert);
    gl.attachShader(this.program, frag);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      Logger.error(
        TAG,
        "Program link error:",
        gl.getProgramInfoLog(this.program),
      );
      return;
    }

    // Quad mapping
    const vertices = new Float32Array([
      -1.0, 1.0, 0.0, 0.0, -1.0, -1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, -1.0,
      1.0, 1.0,
    ]);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 4 * 4, 0);

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 4 * 4, 2 * 4);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (!this.program) return;
    gl.useProgram(this.program);

    // Set u_image uniform
    const uImage = gl.getUniformLocation(this.program, "u_image");
    if (uImage) {
      gl.uniform1i(uImage, 0);
    }

    // Set u_hdrEnabled uniform
    const uHdrEnabled = gl.getUniformLocation(this.program, "u_hdrEnabled");
    if (uHdrEnabled) {
      gl.uniform1f(uHdrEnabled, this.hdrEnabled ? 1.0 : 0.0);
      Logger.debug(
        TAG,
        `Set u_hdrEnabled uniform to: ${this.hdrEnabled ? 1.0 : 0.0}`,
      );
    }

  }

  /**
   * Compile the 360° VR program lazily on first use. Reuses the existing
   * fullscreen-quad VAO (location 0 = a_position spans the clip-space quad)
   * and the existing video texture; only this program + its camera uniforms
   * are new. The fragment shader reconstructs a view ray per pixel from the
   * NDC position + camera yaw/pitch/fov, then maps that direction to an
   * equirectangular (longitude/latitude) texture coordinate.
   */
  /**
   * The ambient wash, drawn by GL.
   *
   * The letterbox is where ambient light belongs, and in fullscreen those bars
   * are the canvas's own pixels — measured: a bar pixel reads back opaque, so
   * the element background carrying the wash sits behind them and is never
   * seen. A flat clear colour DOES reach them, which is what ambient used to
   * do, and flat is the thing being fixed: it reads as a coloured band stuck to
   * the picture rather than light coming off it.
   *
   * So the wash is drawn: one full-canvas quad, two soft pools of the sampled
   * colour over black, drifting. No texture, no blur pass, no keyframe
   * animation running for the whole of playback — a handful of instructions
   * per pixel on a quad that was already being drawn.
   */
  private initWashProgram(): boolean {
    if (this.washProgram) return true;
    if (!this.gl) return false;
    const gl = this.gl;

    const vsSource = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;

    const fsSource = `#version 300 es
    precision highp float;
    uniform vec3 u_colour;   // the sampled ambient colour, already held down
    uniform vec3 u_phases;   // three slowly-walking phases, in radians
    uniform vec3 u_round;    // same corner cut as the picture — see the passthrough program
    // Per corner, in drawing-buffer pixels: top-left, top-right, bottom-right,
    // bottom-left. u_round.x is the largest of them (0 disables the cut).
    uniform vec4 u_radii;
    float movi_cornerR(vec2 p, vec2 h) {
      // gl_FragCoord's origin is the bottom-left corner.
      return p.x < h.x ? (p.y >= h.y ? u_radii.x : u_radii.w) : (p.y >= h.y ? u_radii.y : u_radii.z);
    }
    in vec2 v_uv;
    out vec4 outColor;

    void main() {
      // Three very slow waves laid over each other, not a blob. A blob has a
      // centre, and a bar is a narrow window onto it: when the centre drifts
      // toward the bar the visible slice brightens and widens in place, which
      // reads as the light SWELLING rather than travelling — and on a portrait
      // video, where the bars are wide, the circle itself becomes visible as a
      // shape. These waves are under one cycle across the frame, so there is no
      // repeating pattern and no edge anywhere, and every part of every bar has
      // a gradient running along it that slides as the phases walk.
      float f =
          0.30 * sin(v_uv.x * 3.7 + u_phases.x)
        + 0.28 * sin(v_uv.y * 2.9 + u_phases.y)
        + 0.20 * sin((v_uv.x * 1.6 - v_uv.y * 2.2) + u_phases.z);
      // Mapped, not clamped. Clamping flattened whole regions to zero, and a
      // region at zero is a bar with no light in it at all — so the bottom
      // could glow while the top was simply off. Dividing by the amplitudes
      // instead keeps the wave intact from trough to crest.
      float n = 0.5 + f / 1.56;
      // The floor is the point: the trough still carries some light, so when one
      // bar is at a crest the far one shows a trace of the same colour rather
      // than going black. Both bars are always lit, one just far more than the
      // other, and which one keeps changing as the waves walk.
      float i = 0.55 + 0.45 * n;
      // Cubed: the difference between trough and crest stays wide, so this reads
      // as light with a direction to it rather than an even tint.
      i = i * i * i;
      vec3 lit = u_colour * i;
      // Break the 8-bit staircase.
      //
      // What comes out of the waves above is smooth to many decimal places and
      // then gets written into an 8-bit buffer, so a whole region of it rounds
      // to one value and the next region to the next — and the boundary between
      // them is a hard edge running across the bar. On a dim wash the steps are
      // far apart (a dark colour spends most of its range on very few codes),
      // which is why they read as distinct contour LINES rather than as
      // roughness. Nothing about the gradient is wrong; the buffer cannot hold
      // it.
      //
      // A dither smaller than one code, added before that rounding, makes the
      // choice between the two neighbouring codes a per-pixel one instead of a
      // per-region one. The edge becomes a mixture and the eye reads the
      // average, which is the value the maths asked for in the first place.
      //
      // Two hashes subtracted, not one: a single uniform sample leaves the
      // noise correlated with the signal (it biases where it is already near a
      // boundary). The triangular distribution this makes is the standard
      // answer and costs one extra hash.
      //
      // Keyed on gl_FragCoord ALONE, so it is fixed in screen space. Reseeding
      // it per frame would turn a still gradient into crawling grain — the wash
      // is nearly static and any moving noise on it is more visible than the
      // banding was.
      vec2 seed = gl_FragCoord.xy;
      float d1 = fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453);
      float d2 = fract(sin(dot(seed, vec2(63.7264, 10.873))) * 32168.4127);
      lit += (d1 + d2 - 1.0) / 255.0;
      outColor = vec4(lit, 1.0);
      if (u_round.x > 0.0) {
        vec2 halfSizeR = u_round.yz * 0.5;
        float rr3 = movi_cornerR(gl_FragCoord.xy, halfSizeR);
        vec2 qR = abs(gl_FragCoord.xy - halfSizeR) - (halfSizeR - vec2(rr3));
        float dR = length(max(qR, vec2(0.0))) + min(max(qR.x, qR.y), 0.0) - rr3;
        outColor *= 1.0 - smoothstep(-0.5, 0.5, dR);
      }
    }`;

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        Logger.error(TAG, "Wash shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };
    const vert = createShader(gl.VERTEX_SHADER, vsSource);
    const frag = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vert || !frag) return false;
    const program = gl.createProgram();
    if (!program) return false;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      Logger.error(TAG, "Wash program link error:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return false;
    }
    this.washProgram = program;
    this.washLocs = {
      colour: gl.getUniformLocation(program, "u_colour"),
      phases: gl.getUniformLocation(program, "u_phases"),
      round: gl.getUniformLocation(program, "u_round"),
      radii: gl.getUniformLocation(program, "u_radii"),
    };
    Logger.info(TAG, "Ambient wash program compiled");
    return true;
  }

  /** Colour for the wash above. Null turns it off. The movement is the
   *  renderer's own — see advanceWash. */
  setAmbientWash(rgb: [number, number, number] | null): void {
    const toggled = !rgb !== !this._washRgb;
    this._washRgb = rgb;
    // Turning the wash on or off (entering or leaving fullscreen) on a PAUSED
    // player: nothing draws again on its own, so the bars stayed black — or
    // kept the colour after exit — until playback resumed. Repaint the retained
    // frame, as setCornerRadius does. Colour changes while on need no help:
    // the next frame carries them.
    if (toggled && this.lastRenderedFrame) {
      try {
        this.drawFrame(this.lastRenderedFrame, true);
      } catch {
        /* the next real frame will carry it */
      }
    }
  }
  private _washRgb: [number, number, number] | null = null;
  /** Where the three waves currently sit, and how fast each is walking on,
   *  in radians per second. */
  private _washPhases = [0.4, 2.1, 4.3];
  private _washSpeeds = [0.075, -0.055, 0.04];
  private _washLastT = 0;
  private washProgram: WebGLProgram | null = null;
  private washLocs: {
    colour: WebGLUniformLocation | null;
    phases: WebGLUniformLocation | null;
    radii: WebGLUniformLocation | null;
    round: WebGLUniformLocation | null;
  } = { colour: null, phases: null, radii: null, round: null };

  /**
   * Walk the waves on. The movement lives here rather than with the colour
   * sampler because that samples five times a second: motion driven off it
   * arrives in visible steps, which is what made the light look parked. Here it
   * advances once per drawn frame, and each speed takes a small random nudge so
   * no wave keeps a heading long enough for the eye to predict it — including
   * drifting through zero and reversing, which is what makes it wander rather
   * than sweep.
   */
  private advanceWash(): void {
    const now = performance.now();
    const dt = this._washLastT ? Math.min(0.1, (now - this._washLastT) / 1000) : 0;
    this._washLastT = now;
    if (!dt) return;
    for (let i = 0; i < 3; i++) {
      const nudged = this._washSpeeds[i] * 0.999 + (Math.random() - 0.5) * 0.02 * dt;
      // Magnitude is held off zero. A plain random walk parks: it spends long
      // stretches near zero speed, and a wave that is not moving is the thing
      // this is meant to avoid. Direction still reverses — when the walk
      // crosses zero the sign flips and the speed picks straight back up.
      const sign = nudged < 0 ? -1 : 1;
      this._washSpeeds[i] = sign * Math.min(0.12, Math.max(0.035, Math.abs(nudged)));
      this._washPhases[i] = (this._washPhases[i] + this._washSpeeds[i] * dt) % 6.2831853;
    }
  }

  /** Paint the wash over the whole canvas, before the picture goes on top. */
  private drawAmbientWash(gl: WebGL2RenderingContext): void {
    const rgb = this._washRgb;
    if (!rgb || !this.initWashProgram() || !this.washProgram) return;
    this.advanceWash();
    gl.useProgram(this.washProgram);
    if (this.washLocs.colour) {
      gl.uniform3f(this.washLocs.colour, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    }
    if (this.washLocs.phases) {
      const [p0, p1, p2] = this._washPhases;
      gl.uniform3f(this.washLocs.phases, p0, p1, p2);
    }
    if (this.washLocs.round) {
      gl.uniform3f(
        this.washLocs.round,
        this.cornerRadiusBufferPx(),
        this.canvas?.width || 0,
        this.canvas?.height || 0,
      );
    }
    if (this.washLocs.radii) {
      const [tl, tr, br, bl] = this.cornerRadiiBufferPx();
      gl.uniform4f(this.washLocs.radii, tl, tr, br, bl);
    }
    gl.viewport(0, 0, this.width, this.height);
    // The quad has to be bound HERE. The picture's own draw binds it further
    // down, so on the way in there is no vertex array attached and a_position
    // reads as a constant — measured as the wash appearing only as a sliver at
    // the right edge while both bars stayed black.
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private initVRProgram(): boolean {
    if (this.vrProgram) return true;
    if (!this.gl) return false;
    const gl = this.gl;

    const vsSource = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_ndc;
    void main() {
      v_ndc = a_position;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;

    const fsSource = `#version 300 es
    precision highp float;
    uniform sampler2D u_image;
    uniform float u_yaw;     // radians, look left/right
    uniform float u_pitch;   // radians, look up/down
    uniform float u_fov;     // vertical field of view (radians)
    uniform float u_aspect;  // viewport width / height
    uniform float u_lonDiv;  // longitude span (radians): 2π for 360, π for VR180
    uniform float u_latDiv;  // latitude span (radians), derived from source aspect
    uniform float u_proj;    // 0 = equirectangular, 1 = fisheye, 2 = stereographic
    uniform float u_fishFov; // fisheye coverage (radians), e.g. π for a 180° lens
    uniform float u_uScale;  // eye selection: 1 = full width, 0.5 = one SBS eye
    uniform float u_uOffset; // 0 = left eye, 0.5 = right eye
    uniform float u_planetScale; // stereographic: image radius of the horizon
    uniform float u_srcAspect;   // source frame width/height (keeps the disc round)
    // Rounded corners cut in the shader — see the passthrough program.
    uniform vec3 u_round;
    // Per corner, in drawing-buffer pixels: top-left, top-right, bottom-right,
    // bottom-left. u_round.x is the largest of them (0 disables the cut).
    uniform vec4 u_radii;
    float movi_cornerR(vec2 p, vec2 h) {
      // gl_FragCoord's origin is the bottom-left corner.
      return p.x < h.x ? (p.y >= h.y ? u_radii.x : u_radii.w) : (p.y >= h.y ? u_radii.y : u_radii.z);
    }
    in vec2 v_ndc;
    out vec4 outColor;

    const float PI = 3.14159265358979323846;

    void main() {
      // Camera-space ray: -z forward, scaled by the half-FOV tangent so the
      // vertical FOV matches u_fov and the horizontal FOV follows the aspect.
      float t = tan(u_fov * 0.5);
      vec3 dir = normalize(vec3(v_ndc.x * t * u_aspect, v_ndc.y * t, -1.0));

      // Rotate the ray by pitch (about X), then yaw (about Y).
      float cp = cos(u_pitch), sp = sin(u_pitch);
      dir = vec3(dir.x, cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);
      float cy = cos(u_yaw), sy = sin(u_yaw);
      dir = vec3(cy * dir.x + sy * dir.z, dir.y, -sy * dir.x + cy * dir.z);

      // Map the ray to a position inside ONE eye's 0..1 square.
      vec2 eye;
      if (u_proj < 0.5) {
        // Equirectangular: longitude across X, latitude up Y. Spans come from
        // the source so pixels stay square (a 2:1 frame → 180° vertical, etc.).
        float lon = atan(dir.x, -dir.z);
        float lat = asin(clamp(dir.y, -1.0, 1.0));
        eye = vec2(lon / u_lonDiv + 0.5, 0.5 - lat / u_latDiv);
      } else if (u_proj < 1.5) {
        // Equidistant fisheye: angle θ from the forward axis maps to a radius,
        // azimuth φ to the angle around the circle inscribed in the square.
        float theta = acos(clamp(-dir.z, -1.0, 1.0));
        float phi = atan(dir.y, dir.x);
        float r = theta / (u_fishFov * 0.5); // 0 at centre, 1 at the lens edge
        eye = vec2(0.5 + 0.5 * r * cos(phi), 0.5 - 0.5 * r * sin(phi));
      } else {
        // Stereographic "little planet": nadir (straight down) sits at the disc
        // centre, the horizon on a circle and the zenith out toward the rim.
        // Inverse-project: angle a from nadir → image radius r = tan(a/2),
        // azimuth around the vertical axis. Divide x by the source aspect so a
        // disc that's circular in pixels stays circular here.
        float a = acos(clamp(-dir.y, -1.0, 1.0)); // 0 down → π up
        float az = atan(dir.z, dir.x);
        float r = tan(a * 0.5) * u_planetScale;
        // +sin so tilting up samples toward the image top (where the zenith/sky
        // sits in a tiny-planet), keeping the scene right-side up.
        eye = vec2(0.5 + r * cos(az) / u_srcAspect, 0.5 + r * sin(az));
      }

      // Pick the eye half for side-by-side stereo (full width when mono). The
      // camera is clamped to the content and S/T wrap is CLAMP_TO_EDGE, so the
      // edge never shows a black void.
      vec2 uv = vec2(eye.x * u_uScale + u_uOffset, eye.y);
      outColor = texture(u_image, uv);
      outColor.a = 1.0; // opaque — see the passthrough program
      if (u_round.x > 0.0) {
        vec2 halfSizeR = u_round.yz * 0.5;
        float rr4 = movi_cornerR(gl_FragCoord.xy, halfSizeR);
        vec2 qR = abs(gl_FragCoord.xy - halfSizeR) - (halfSizeR - vec2(rr4));
        float dR = length(max(qR, vec2(0.0))) + min(max(qR.x, qR.y), 0.0) - rr4;
        outColor *= 1.0 - smoothstep(-0.5, 0.5, dR);
      }
    }`;

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        Logger.error(TAG, "VR shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vert = createShader(gl.VERTEX_SHADER, vsSource);
    const frag = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vert || !frag) return false;

    const program = gl.createProgram();
    if (!program) return false;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      Logger.error(TAG, "VR program link error:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return false;
    }

    this.vrProgram = program;
    this.vrLocs = {
      image: gl.getUniformLocation(program, "u_image"),
      yaw: gl.getUniformLocation(program, "u_yaw"),
      pitch: gl.getUniformLocation(program, "u_pitch"),
      fov: gl.getUniformLocation(program, "u_fov"),
      aspect: gl.getUniformLocation(program, "u_aspect"),
      lonDiv: gl.getUniformLocation(program, "u_lonDiv"),
      latDiv: gl.getUniformLocation(program, "u_latDiv"),
      proj: gl.getUniformLocation(program, "u_proj"),
      fishFov: gl.getUniformLocation(program, "u_fishFov"),
      uScale: gl.getUniformLocation(program, "u_uScale"),
      uOffset: gl.getUniformLocation(program, "u_uOffset"),
      planetScale: gl.getUniformLocation(program, "u_planetScale"),
      srcAspect: gl.getUniformLocation(program, "u_srcAspect"),
    };
    gl.useProgram(program);
    if (this.vrLocs.image) gl.uniform1i(this.vrLocs.image, 0);
    Logger.info(TAG, "VR 360° equirectangular program compiled");
    return true;
  }

  /**
   * Render one frame as a viewed sphere. The texture has already been bound +
   * uploaded by drawFrame; here we only set the full-canvas viewport, switch
   * to the VR program, push the camera uniforms and draw the fullscreen quad.
   * Full 360° wraps horizontally (WRAP_S = REPEAT for a seamless ±180° seam);
   * VR180 covers a single front hemisphere, so it clamps and clips to black.
   */
  private drawVRFrame(gl: WebGL2RenderingContext, frame: RenderSource): void {
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Only full 360° equirect wraps horizontally; VR180, fisheye and
    // stereographic all clamp at the edge.
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      this.vrHalf || this.vrStereographic ? gl.CLAMP_TO_EDGE : gl.REPEAT,
    );

    const vrH = sourceHeight(frame);
    if (vrH > 0) {
      this.vrTexAspect = sourceWidth(frame) / vrH;
    }
    // For side-by-side stereo each eye is half the frame width, so the per-eye
    // aspect (what the projection maps) halves.
    const eyeAspect = this.vrStereoSbs
      ? this.vrTexAspect / 2
      : this.vrTexAspect;
    // Equirect: longitude span fixed by coverage (full turn vs hemisphere),
    // latitude span follows the per-eye aspect so pixels stay square.
    const lonDiv = this.vrHalf ? Math.PI : 2 * Math.PI;
    const latDiv = Math.min(Math.PI, lonDiv / eyeAspect);

    gl.useProgram(this.vrProgram);
    this.applyRoundUniform(this.vrProgram);
    gl.bindVertexArray(this.vao);
    const locs = this.vrLocs!;
    if (locs.yaw) gl.uniform1f(locs.yaw, this.vrYaw);
    if (locs.pitch) gl.uniform1f(locs.pitch, this.vrPitch);
    if (locs.fov) gl.uniform1f(locs.fov, this.vrFov);
    if (locs.aspect)
      gl.uniform1f(locs.aspect, this.height > 0 ? this.width / this.height : 1);
    if (locs.lonDiv) gl.uniform1f(locs.lonDiv, lonDiv);
    if (locs.latDiv) gl.uniform1f(locs.latDiv, latDiv);
    const projMode = this.vrStereographic ? 2 : this.vrFisheye ? 1 : 0;
    if (locs.proj) gl.uniform1f(locs.proj, projMode);
    if (locs.fishFov) gl.uniform1f(locs.fishFov, CanvasRenderer.VR_FISHEYE_FOV);
    // Left eye for SBS (scale 0.5, offset 0); full width for mono.
    if (locs.uScale) gl.uniform1f(locs.uScale, this.vrStereoSbs ? 0.5 : 1);
    if (locs.uOffset) gl.uniform1f(locs.uOffset, 0);
    if (locs.planetScale)
      gl.uniform1f(locs.planetScale, CanvasRenderer.VR_PLANET_SCALE);
    if (locs.srcAspect) gl.uniform1f(locs.srcAspect, this.vrTexAspect || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Shared adaptive-DPR paint sampling. Called from both the flat and VR draw
   * paths so 360 playback also benefits from the 2x→1x backbuffer downgrade on
   * GPU-bound devices (360 raycasting is fragment-heavy at 4K).
   */
  private sampleAdaptiveDpr(paintStart: number): void {
    if (paintStart <= 0) return;
    const paintDuration = performance.now() - paintStart;

    // Rung two: the long-paint tail. Runs for as long as the 16-bit texture is
    // still in play, including long after the one-shot DPR check has closed.
    if (this.isHighBitDepth && !this._bitDepthDowngraded) {
      this._paintsSeenSinceWindow++;
      if (paintDuration > CanvasRenderer.LONG_PAINT_MS) this._longPaints++;
      if (this._longPaints >= CanvasRenderer.LONG_PAINT_LIMIT) {
        Logger.info(
          TAG,
          `Adaptive bit depth: ${this._longPaints} paints over ${CanvasRenderer.LONG_PAINT_MS}ms in ${this._paintsSeenSinceWindow} frames — dropping RGBA16F to RGBA8`,
        );
        this.isHighBitDepth = false;
        this._bitDepthDowngraded = true;
      } else if (
        this._paintsSeenSinceWindow >= CanvasRenderer.LONG_PAINT_WINDOW
      ) {
        this._paintsSeenSinceWindow = 0;
        this._longPaints = 0;
      }
    }

    if (this._adaptDprChecked) return;
    this._paintSamples.push(paintDuration);
    if (this._paintSamples.length >= CanvasRenderer.PAINT_SAMPLE_COUNT) {
      const sum = this._paintSamples.reduce((a, b) => a + b, 0);
      const avg = sum / this._paintSamples.length;
      if (
        avg > CanvasRenderer.PAINT_THRESHOLD_MS &&
        this._maxDpr > 1 &&
        this.containerWidth > 0 &&
        this.containerHeight > 0
      ) {
        Logger.info(
          TAG,
          `Adaptive DPR: avg paint ${avg.toFixed(1)}ms over ${this._paintSamples.length} frames > ${CanvasRenderer.PAINT_THRESHOLD_MS}ms threshold — capping DPR to 1x`,
        );
        this._maxDpr = 1;
        this.resize(this.containerWidth, this.containerHeight);
      }
      this._adaptDprChecked = true;
      this._paintSamples = [];
    }
  }

  /** Wire a callback fired once, when the renderer decides the device can't
   *  sustain the source frame rate and engages its adaptive cap. The player
   *  uses it to turn on decode-side non-reference skipping on the software
   *  path. `targetFps` is the capped rate. */
  /** True once this device has been judged unable to decode the current rung at
   *  all (see engageDecodeBound). */
  isDecodeBound(): boolean {
    return this._decodeBound;
  }

  /**
   * How many packets are queued in the video decoder. The perf detectors use it
   * to tell a decoder that is too SLOW (work piled up in front of it) from one
   * that is merely STARVED (nothing arriving) — both look identical from the
   * present side, which is all this renderer can otherwise see.
   */
  setVideoBacklogProvider(cb: () => number): void {
    this._videoBacklog = cb;
  }

  setOnPerformanceDegrade(cb: (targetFps: number) => void): void {
    this._onPerformanceDegrade = cb;
  }

  /** Gate perf sampling. The host passes false while the tab is backgrounded
   *  (and not in PiP): rAF is throttled there, so framesPresented stalls even
   *  though audio keeps flowing — which would false-fire the decode-bound
   *  detector and needlessly cap resolution on a perfectly capable device. */
  setShouldMeasurePerf(cb: () => boolean): void {
    this._shouldMeasurePerf = cb;
  }

  /** Roll the achieved-present-rate window and engage the adaptive FPS cap on a
   *  sustained deficit. Called once per presentation cycle, before the
   *  empty-queue bail, so a starving (decode-bound) pipeline still advances the
   *  window clock and registers its low present count. */
  private resetRafCadence(): void {
    this._rafWindowStart = 0;
    this._rafTicks = 0;
    this._rafSelfMs = 0;
    this._framesReadyInWindow = false;
    this._hostContended = false;
  }

  /**
   * Drop every perf window on the floor.
   *
   * All three of them measure a RATE across wall-clock time, so a window that
   * spans a stretch where the loop wasn't running measures nothing — it divides
   * the ticks and frames of a fraction of a second by however long the player
   * sat there. samplePerformance() has a `!isPlaying` branch for exactly this,
   * and it can never run: startPresentationLoop() sets isPlaying BEFORE its
   * first (synchronous) tick, so the first sample after a stop is already
   * "playing" and reads the stale window as live.
   *
   * Measured on a 5.76s clip played, left on the ended screen for 31 seconds,
   * and replayed: the replay's very first tick closed a 31-SECOND cadence
   * window holding the last partial second of ticks from the previous run, and
   * logged "Main thread contended by the host page: rAF fired ~1/s against a
   * 50fps target ... 0% of the window" before a single frame of the replay had
   * been presented. That verdict is sticky until a full window overwrites it,
   * and while it stands samplePerformance zeroes the deficit/stuck streaks and
   * returns — so the adaptive-FPS and decode-bound detectors were switched off
   * across the start of the replay by a window that measured an idle player.
   * The stuck detector's own window spans the same gap and reads ~0fps with
   * audio flowing, which is a decode-bound downshift waiting to happen; it was
   * only ever saved by the contention verdict returning first.
   *
   * So reset where the stop actually happens, and let each restart begin its
   * windows from the moment it is genuinely running again.
   */
  private resetPerfWindows(): void {
    this._perfWindowStart = 0;
    this._stuckWindowStart = 0;
    this._perfStuckWindows = 0;
    this.resetRafCadence();
  }

  /**
   * Roll the rAF-cadence window and decide whether the one that just closed was
   * the host page's doing rather than the pipeline's.
   *
   * Runs once per presentation tick. The verdict is sticky between windows — it
   * stands until the next full window overwrites it — which is what we want:
   * the detectors it gates work on multi-second streaks, so a per-tick verdict
   * would let a single lucky tick re-open the gate mid-streak.
   */
  private sampleRafCadence(now: number): void {
    // Latch every tick, not once per window: the queue drains and refills
    // within a window even on a healthy pipeline, so a single unlucky read
    // would claim the decoder had nothing ready when it did — the same reason
    // the backlog latches above are rolled this way.
    if (this.frameQueue.length > 0) this._framesReadyInWindow = true;

    if (this._rafWindowStart === 0) {
      this._rafWindowStart = now;
      this._rafTicks = 0;
      this._rafSelfMs = 0;
      return;
    }
    const elapsed = now - this._rafWindowStart;
    if (elapsed < CanvasRenderer.PERF_WINDOW_MS) return;

    const rafFps = this._rafTicks / (elapsed / 1000);
    const selfShare = this._rafSelfMs / elapsed;
    // Judge the cadence against the rate we are actually trying to hit, so an
    // engaged present cap doesn't make a deliberately-halved rate look starved.
    const targetFps =
      this._presentFpsCap > 0
        ? Math.min(this.videoFrameRate, this._presentFpsCap)
        : this.videoFrameRate;

    this._hostContended =
      targetFps > 0 &&
      // Frames were sitting ready and we still couldn't put them up — so the
      // decoder is not what's short. With an empty queue this is a starved
      // pipeline and the existing detectors own the call.
      this._framesReadyInWindow &&
      rafFps < targetFps * CanvasRenderer.PERF_CONTENTION_RAF_RATIO &&
      selfShare < CanvasRenderer.PERF_CONTENTION_SELF_SHARE;

    if (this._hostContended && !this._hostContentionLogged) {
      this._hostContentionLogged = true;
      Logger.info(
        TAG,
        `Main thread contended by the host page: rAF fired ~${rafFps.toFixed(0)}/s ` +
          `against a ${targetFps}fps target with frames ready, while the presentation ` +
          `loop itself used only ${(selfShare * 100).toFixed(0)}% of the window — ` +
          `holding off the adaptive-FPS and decode-bound detectors`,
      );
    }

    this._rafWindowStart = now;
    this._rafTicks = 0;
    this._rafSelfMs = 0;
    this._framesReadyInWindow = false;
  }

  private samplePerformance(): void {
    if (this._perfDegradeChecked) return;
    if (!this.isPlaying) {
      this.resetPerfWindows();
      return;
    }
    // Skip while backgrounded (and not in PiP): the throttled rAF stalls
    // framesPresented even though audio flows, which would false-fire the
    // decode-bound detector and cap resolution on a capable device. Reset so
    // returning to the foreground starts clean windows (no stale accumulation).
    if (this._shouldMeasurePerf && !this._shouldMeasurePerf()) {
      this._perfWindowStart = 0;
      this._perfDeficitWindows = 0;
      this._stuckWindowStart = 0;
      this._perfStuckWindows = 0;
      this.resetRafCadence();
      return;
    }
    // Off-speed playback changes distinct-frames-per-wall-second on its own
    // (2x can't show every frame on a 60Hz panel; slow-mo shows fewer) — that's
    // not the device struggling. Only measure at normal speed.
    if (Math.abs(this.playbackRate - 1.0) > 0.05) {
      this._perfWindowStart = 0;
      this._stuckWindowStart = 0;
      this.resetRafCadence();
      return;
    }

    const nowCadence = performance.now();
    this.sampleRafCadence(nowCadence);
    // The host page owns the thread, so nothing measured here is about this
    // pipeline. Drop the accumulated streaks as well as skipping the verdict —
    // otherwise a burst of the site's own animation work half-fills the
    // counters and the cap/downshift fires the moment it lets go, on windows
    // that were never the decoder's fault.
    if (this._hostContended) {
      this._perfDeficitWindows = 0;
      this._perfStuckWindows = 0;
      this._perfWindowStart = 0;
      this._stuckWindowStart = 0;
      return;
    }

    // Stamp the grace clock on the first live sample (playback actually running,
    // foreground, normal speed) rather than at configure() — which can run
    // seconds before the first frame while the source opens.
    if (this._perfArmedAt === 0) this._perfArmedAt = performance.now();
    // Within the startup grace the device hasn't had a fair chance yet: hold off
    // ENGAGING a cap/downshift. Keep the window CLOCKS advancing below (so we're
    // measuring), but zero the bad-window streaks so a startup deficit can't
    // carry over and fire the instant the grace ends — the post-grace judgment
    // starts from a clean slate on steady-state numbers.
    const inGrace =
      performance.now() - this._perfArmedAt < CanvasRenderer.PERF_STARTUP_GRACE_MS;
    if (inGrace) {
      this._perfDeficitWindows = 0;
      this._perfStuckWindows = 0;
    }

    // Decode-bound (STUCK) detector — runs BEFORE the frame-warmup gate on its
    // own time-based window, because a near-frozen decoder never advances
    // framesPresented past the warmup count (so the slow-path check below would
    // never even start). Audio healthy = playback is genuinely running, so
    // sustained near-zero video = the device can't decode this rung → tell ABR
    // to drop. A rendition switch re-arms us via configure().
    // Roll the "did the decoder have anything to do?" latches for both windows.
    if (this._videoBacklog ? this._videoBacklog() > 0 : true) {
      this._backlogSeenStuck = true;
      this._backlogSeenDeficit = true;
    }

    const nowStuck = performance.now();
    if (this._stuckWindowStart === 0) {
      this._stuckWindowStart = nowStuck;
      this._stuckBaseCount = this.framesPresented;
    } else if (nowStuck - this._stuckWindowStart >= CanvasRenderer.PERF_WINDOW_MS) {
      const stuckFps =
        (this.framesPresented - this._stuckBaseCount) /
        ((nowStuck - this._stuckWindowStart) / 1000);
      const audioFlowing = this._isAudioHealthy ? this._isAudioHealthy() : true;
      // Audio flowing is NOT enough on its own to call this a device limit.
      // Video outweighs audio by two orders of magnitude (an 8K60 rung runs
      // ~36 Mbit/s against ~200 kbit/s of Opus), so a link that cannot carry
      // the video keeps audio perfectly healthy while no frames arrive — which
      // is indistinguishable from a decoder that can't keep up, from here. The
      // decoder's own backlog separates them: work piled up in front of it
      // means slow, nothing queued means starved. Measured on a Drive-hosted
      // 8K60 AV1 file whose link tops out at 4.3 MB/s: the startup window read
      // as decode-bound, which downshifts ABR and (until it was gated) sent the
      // frozen-video watchdog seeking, even though the same file then sustained
      // a full 60fps once data was ahead of the playhead.
      if (
        audioFlowing &&
        this._backlogSeenStuck &&
        stuckFps < CanvasRenderer.PERF_MIN_ACHIEVED_FPS
      ) {
        this._perfStuckWindows++;
        if (this._perfStuckWindows >= CanvasRenderer.PERF_STUCK_WINDOWS && !inGrace) {
          this.engageDecodeBound(stuckFps);
          return;
        }
      } else {
        this._perfStuckWindows = 0;
      }
      this._stuckWindowStart = nowStuck;
      this._stuckBaseCount = this.framesPresented;
      this._backlogSeenStuck = false;
    }

    // framesPresented resets to 0 on start/seek, so a low count during the
    // ramp is expected — not a deficit. Reset the window and wait it out.
    if (this.framesPresented <= CanvasRenderer.PERF_WARMUP_FRAMES) {
      this._perfWindowStart = 0;
      this._perfDeficitWindows = 0;
      return;
    }
    const now = performance.now();
    if (this._perfWindowStart === 0) {
      this._perfWindowStart = now;
      this._perfWindowBaseCount = this.framesPresented;
      return;
    }
    const elapsed = now - this._perfWindowStart;
    if (elapsed < CanvasRenderer.PERF_WINDOW_MS) return;

    const achieved = this.framesPresented - this._perfWindowBaseCount;
    const achievedFps = achieved / (elapsed / 1000);
    // Judge against the CAPPED rate once a present cap is active, so a source
    // holding steady at the cap (e.g. 4K sustaining 30 of its 60fps) reads as
    // healthy instead of a deficit that would needlessly drop resolution.
    const targetFps =
      this._presentFpsCap > 0
        ? Math.min(this.videoFrameRate, this._presentFpsCap)
        : this.videoFrameRate;
    const expected = targetFps * (elapsed / 1000);
    // A network stall starves audio too — don't blame the video pipeline for
    // it. Only count a window when audio is flowing.
    const audioHealthy = this._isAudioHealthy ? this._isAudioHealthy() : true;
    // Near-zero present rate = pipeline STUCK, not slow (see the constant). Don't
    // treat it as a deficit; capping/skipping can't help and would fire during
    // decoder recovery. Genuine decode-bound playback stays well above the floor.
    const producing = achievedFps >= CanvasRenderer.PERF_MIN_ACHIEVED_FPS;

    // Same discriminator as the stuck detector above: only a decoder with work
    // queued can be "too slow". An empty backlog across the whole window means
    // the frames simply aren't arriving, and capping the present rate (or
    // dropping a rung) does nothing about that.
    if (
      audioHealthy &&
      this._backlogSeenDeficit &&
      producing &&
      expected > 0 &&
      achieved < expected * CanvasRenderer.PERF_DEFICIT_RATIO
    ) {
      this._perfDeficitWindows++;
      if (this._perfDeficitWindows >= CanvasRenderer.PERF_DEFICIT_WINDOWS && !inGrace) {
        this.engagePresentCap(achieved / (elapsed / 1000));
      }
    } else {
      this._perfDeficitWindows = 0;
      // A cap has to be able to come off again.
      //
      // engagePresentCap() halves the presentation rate on four bad seconds,
      // and until now the ONLY thing that ever cleared it was configure() — a
      // new source or a rendition switch. Not a seek, not minutes of healthy
      // playback. So one passing squeeze (a heavy stretch at 2x on an 8K60
      // source is the one this was found on) left the picture at 30fps for the
      // whole of the rest of the file, with nothing in the pipeline reporting a
      // fault: audio healthy, rAF firing a full 60Hz, frames sitting queued.
      // That is a ratchet, not an adaptation.
      //
      // The evidence for lifting is the only kind available from inside a cap:
      // windows that hold the capped rate comfortably. Being wrong is cheap and
      // self-correcting — the deficit test above re-judges against the full
      // rate and re-engages after its usual four windows — so the cost of a bad
      // probe is bounded at four seconds, while the cost of never probing is
      // the rest of the film. The probe interval doubles on each lift so a
      // device that genuinely cannot hold the full rate is asked ever less
      // often rather than flapping between the two.
      if (
        this._presentFpsCap > 0 &&
        !inGrace &&
        audioHealthy &&
        producing &&
        expected > 0 &&
        achieved >= expected * CanvasRenderer.PERF_CAP_HOLD_RATIO
      ) {
        if (++this._capHealthyWindows >= this._capProbeAfterWindows) {
          Logger.info(
            TAG,
            `Adaptive FPS: held ${targetFps}fps for ${this._capHealthyWindows}s — ` +
              `lifting the cap to re-judge at ${this.videoFrameRate}fps`,
          );
          this._presentFpsCap = 0;
          this._capHealthyWindows = 0;
          this._capProbeAfterWindows = Math.min(
            CanvasRenderer.PERF_CAP_PROBE_MAX_WINDOWS,
            this._capProbeAfterWindows * 2,
          );
        }
      } else if (this._presentFpsCap > 0) {
        // Short of the cap it is holding nothing, so it is not evidence.
        this._capHealthyWindows = 0;
      }
    }
    this._perfWindowStart = now;
    this._perfWindowBaseCount = this.framesPresented;
    this._backlogSeenDeficit = false;
  }

  private engagePresentCap(achievedFps: number): void {
    // A SEVERE shortfall skips the frame-rate stage. Capping to half rate is a
    // fair trade when a rung is a little too heavy — the resolution survives —
    // but when the pipeline is managing a quarter of the frames, half rate is
    // still far out of reach, and trying it first costs another four windows
    // before the ABR is even told. That wait is why coming back down off a rung
    // the device cannot handle takes so long.
    const targetFps =
      this._presentFpsCap > 0
        ? Math.min(this.videoFrameRate, this._presentFpsCap)
        : this.videoFrameRate;
    if (targetFps > 0 && achievedFps < targetFps * CanvasRenderer.PERF_SEVERE_RATIO) {
      Logger.warn(
        TAG,
        `Decode-bound (severe): ~${achievedFps.toFixed(1)}/${targetFps}fps — skipping the frame-rate cap and asking for a lower rung now`,
      );
      this.engageDecodeBound(achievedFps);
      return;
    }
    const cap = Math.max(
      CanvasRenderer.PERF_MIN_CAP_FPS,
      Math.round(this.videoFrameRate / 2),
    );
    // Can't cap any lower (source already ≤2× the floor) → the frame-rate lever
    // is spent; resolution downshift is all that's left.
    if (cap >= this.videoFrameRate) {
      this.engageDecodeBound(achievedFps);
      return;
    }
    if (this._presentFpsCap === 0) {
      // FIRST sign of trouble: cap the present rate and RE-ARM to re-judge
      // against the cap. Give the rung a chance to hold at the reduced frame
      // rate before dropping resolution — a 4K/1440p source the GPU can do at
      // 30 but not 60 keeps its resolution instead of stepping down (which is
      // what made it flap: it never got to try the current rung at half rate).
      this._presentFpsCap = cap;
      this._capHealthyWindows = 0;
      this._perfDeficitWindows = 0;
      this._perfWindowStart = 0;
      Logger.info(
        TAG,
        `Adaptive FPS: sustained ~${achievedFps.toFixed(0)}/${this.videoFrameRate}fps — capping presentation to ${cap}fps before any resolution drop`,
      );
      return;
    }
    // Already capped and STILL short of the cap → the rung is too heavy even at
    // the reduced rate. Now drop resolution.
    Logger.info(
      TAG,
      `Adaptive FPS: still ~${achievedFps.toFixed(0)}/${this._presentFpsCap}fps after the cap — dropping resolution`,
    );
    this.engageDecodeBound(achievedFps);
  }

  /** Decode-bound catastrophe: the decoder can't produce frames at all (near
   *  zero) while audio flows. Present-capping can't help a decoder that isn't
   *  producing — signal ABR to drop a rung instead (pass 0, no cap). */
  private engageDecodeBound(achievedFps: number): void {
    this._perfDegradeChecked = true; // one-way until configure() re-arms on the switch
    this._decodeBound = true;
    Logger.warn(
      TAG,
      `Decode-bound: only ~${achievedFps.toFixed(1)}/${this.videoFrameRate}fps presented with healthy audio — signalling ABR to drop a rung`,
    );
    try {
      this._onPerformanceDegrade?.(0);
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────── 360° VR public API ─────────────────────────

  /** Turn equirectangular 360° rendering on/off. The intent is stored
   *  unconditionally; the VR program is compiled when GL is ready — which may
   *  be NOW (toggled during playback) or later (the `vr` attribute requests 360
   *  before the first frame/poster has configured the context). configure() and
   *  drawFrame both compile lazily, so an early enable still paints the poster
   *  in 360. Repaints immediately when paused so the toggle is visible. */
  setVR360(enabled: boolean): void {
    if (this.vr360Enabled === enabled) return;
    this.vr360Enabled = enabled;
    if (enabled) {
      // Best-effort compile now; harmless no-op if GL isn't configured yet.
      if (this.gl) this.initVRProgram();
      // Sync targets to current so toggling on never kicks off a stray spring.
      this.vrYawTarget = this.vrYaw;
      this.vrPitchTarget = this.vrPitch;
      this.vrFovTarget = this.vrFov;
      this.vrYawVel = 0;
      this.vrPitchVel = 0;
    } else if (this.gl && this.texture) {
      // Restore CLAMP_TO_EDGE for the flat path when leaving VR.
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
      this.gl.texParameteri(
        this.gl.TEXTURE_2D,
        this.gl.TEXTURE_WRAP_S,
        this.gl.CLAMP_TO_EDGE,
      );
    }
    this.redrawForVR();
    Logger.info(TAG, `360° VR ${enabled ? "enabled" : "disabled"}`);
  }

  isVR360Enabled(): boolean {
    return this.vr360Enabled;
  }

  /**
   * The currently-displayed picture (or null) — a decoded VideoFrame, or the
   * <video> element itself on the MSE paths. Used as a fallback capture source
   * when reading the WebGL canvas back via toDataURL comes out blank — some
   * GPUs return an all-black buffer for hardware-decoded frames even with
   * preserveDrawingBuffer. Both types are valid drawImage sources. A VideoFrame
   * is owned by the renderer and may be closed on the next present, so consume
   * it synchronously.
   */
  /**
   * Presentation rate the renderer has deliberately capped itself to, or 0 when
   * uncapped. A cap is a DECISION, not a failure — the source's own fps stops
   * being the number to judge against the moment one is set.
   */
  get presentFpsCap(): number {
    return this._presentFpsCap || 0;
  }

  getCurrentFrame(): RenderSource | null {
    return this.lastRenderedFrame;
  }

  /**
   * Snapshot the live 360° camera + projection so a thumbnail/preview can be
   * reprojected to exactly what the user currently sees. Returns the CURRENT
   * (rendered, post-spring) yaw/pitch/fov — i.e. the on-screen view, not the
   * drag target. Null when 360 is off.
   */
  getVRView(): VRView | null {
    if (!this.vr360Enabled) return null;
    return {
      yaw: this.vrYaw,
      pitch: this.vrPitch,
      fov: this.vrFov,
      aspect: this.height > 0 ? this.width / this.height : 16 / 9,
      half: this.vrHalf,
      fisheye: this.vrFisheye,
      sbs: this.vrStereoSbs,
      stereographic: this.vrStereographic,
      texAspect: this.vrTexAspect,
    };
  }

  /** Choose the VR projection/layout:
   *  - half: false = full 360° equirectangular, true = front-hemisphere (VR180).
   *  - fisheye: true = equidistant fisheye instead of equirectangular.
   *  - stereoSbs: true = side-by-side stereo (render the left eye only).
   *  drawVRFrame reads these. */
  setVRProjection(
    half: boolean,
    fisheye = false,
    stereoSbs = false,
    stereographic = false,
  ): void {
    if (
      this.vrHalf === half &&
      this.vrFisheye === fisheye &&
      this.vrStereoSbs === stereoSbs &&
      this.vrStereographic === stereographic
    ) {
      return;
    }
    const enteringPlanet = stereographic && !this.vrStereographic;
    this.vrHalf = half;
    this.vrFisheye = fisheye;
    this.vrStereoSbs = stereoSbs;
    this.vrStereographic = stereographic;
    if (enteringPlanet) {
      // Open looking down at the planet — the recognisable tiny-planet view.
      // Tilt up to "unwrap" toward the horizon; spin yaw to rotate the world.
      this.vrPitch = this.vrPitchTarget = -1.35; // ~ -77°, mostly down
      this.vrYaw = this.vrYawTarget = 0;
      this.vrPitchVel = this.vrYawVel = 0;
    }
    this.clampVRCamera();
    this.redrawForVR();
  }

  /**
   * Keep the VR180 camera inside the content so no black void is ever shown.
   * The viewport's half-FOV (vertical from u_fov, horizontal via the canvas
   * aspect) is subtracted from the content's angular half-extents to get the
   * yaw/pitch limits, and zoom-out is capped so the viewport can't grow past
   * the content vertically. No-op for full 360° (it covers everything).
   */
  private clampVRCamera(): void {
    if (!this.vrHalf) return;
    // Per-eye aspect (SBS halves the width). Fisheye lenses are a circle in a
    // square eye, so treat them as 1:1 (180° both axes).
    const eyeAspect = this.vrStereoSbs
      ? this.vrTexAspect / 2
      : this.vrTexAspect;
    const lonSpan = Math.PI; // VR180 horizontal coverage = 180°
    const latSpan = this.vrFisheye
      ? Math.PI // fisheye covers ~180° vertically too
      : Math.min(Math.PI, lonSpan / eyeAspect);

    // Cap zoom-out so the vertical FOV never exceeds the content's vertical span.
    const maxFov = Math.min(CanvasRenderer.VR_MAX_FOV, latSpan);
    if (this.vrFovTarget > maxFov) this.vrFovTarget = maxFov;
    if (this.vrFov > maxFov) this.vrFov = maxFov;

    const vpAspect = this.height > 0 ? this.width / this.height : 16 / 9;
    const vHalf = this.vrFov * 0.5;
    const hHalf = Math.atan(Math.tan(vHalf) * vpAspect);
    const maxYaw = Math.max(0, lonSpan * 0.5 - hHalf);
    const maxPitch = Math.max(0, latSpan * 0.5 - vHalf);

    const clampAxis = (
      cur: number,
      tgt: number,
      lim: number,
    ): [number, number, boolean] => {
      const t = Math.max(-lim, Math.min(lim, tgt));
      let c = cur,
        hitEdge = false;
      if (c > lim) {
        c = lim;
        hitEdge = true;
      } else if (c < -lim) {
        c = -lim;
        hitEdge = true;
      }
      return [c, t, hitEdge];
    };

    let hitY: boolean, hitP: boolean;
    [this.vrYaw, this.vrYawTarget, hitY] = clampAxis(
      this.vrYaw,
      this.vrYawTarget,
      maxYaw,
    );
    [this.vrPitch, this.vrPitchTarget, hitP] = clampAxis(
      this.vrPitch,
      this.vrPitchTarget,
      maxPitch,
    );
    if (hitY) this.vrYawVel = 0; // stop the spring overshooting into the void
    if (hitP) this.vrPitchVel = 0;
  }

  /** Pan the camera by a pointer drag. dx/dy are CSS pixels; viewportPx is the
   *  canvas CSS height, so pan speed scales with the current zoom (FOV). Moves
   *  the *target* — the spring eases the rendered view toward it. */
  nudgeVR360(dx: number, dy: number, viewportPx: number): void {
    if (!this.vr360Enabled) return;
    // "Grab the world" convention (YouTube / Street View): dragging right pans
    // the scene right, so the camera rotates left; dragging down reveals the
    // sky, so the camera pitches up. Hence += on both.
    const radPerPx = this.vrFov / Math.max(1, viewportPx);
    this.vrYawTarget += dx * radPerPx;
    this.vrPitchTarget += dy * radPerPx;
    const lim = Math.PI / 2 - 0.01;
    this.vrPitchTarget = Math.max(-lim, Math.min(lim, this.vrPitchTarget));
    this.clampVRCamera();
    this.ensureVRAnimating();
  }

  /** Zoom by adjusting FOV. delta>0 zooms out (e.g. wheel deltaY). Eases. */
  zoomVR360(delta: number): void {
    if (!this.vr360Enabled) return;
    this.vrFovTarget = Math.max(
      CanvasRenderer.VR_MIN_FOV,
      Math.min(CanvasRenderer.VR_MAX_FOV, this.vrFovTarget + delta * 0.0015),
    );
    this.clampVRCamera(); // re-clamp look range — a wider FOV shrinks it
    this.ensureVRAnimating();
  }

  /** Recentre the camera (yaw/pitch 0, default FOV) — animated, not a snap. */
  resetVRView(): void {
    this.vrYawTarget = 0;
    this.vrPitchTarget = 0;
    this.vrFovTarget = CanvasRenderer.VR_DEFAULT_FOV;
    this.clampVRCamera();
    this.ensureVRAnimating();
  }

  /**
   * Advance the camera one tick toward its target: an underdamped spring for
   * yaw/pitch (soft settle/bounce) and a linear ease for FOV. Returns true once
   * everything has effectively converged.
   */
  private stepVRCamera(dt: number): boolean {
    const k = CanvasRenderer.VR_STIFFNESS;
    const c = CanvasRenderer.VR_DAMPING;

    // Yaw spring
    const yawForce = k * (this.vrYawTarget - this.vrYaw) - c * this.vrYawVel;
    this.vrYawVel += yawForce * dt;
    this.vrYaw += this.vrYawVel * dt;

    // Pitch spring
    const pitchForce =
      k * (this.vrPitchTarget - this.vrPitch) - c * this.vrPitchVel;
    this.vrPitchVel += pitchForce * dt;
    this.vrPitch += this.vrPitchVel * dt;

    // FOV — simple linear ease, no overshoot.
    this.vrFov += (this.vrFovTarget - this.vrFov) * CanvasRenderer.VR_FOV_LERP;

    // Keep within the VR180 content (clamps spring overshoot at the edges).
    this.clampVRCamera();

    const settled =
      Math.abs(this.vrYawTarget - this.vrYaw) < 1e-4 &&
      Math.abs(this.vrPitchTarget - this.vrPitch) < 1e-4 &&
      Math.abs(this.vrYawVel) < 1e-3 &&
      Math.abs(this.vrPitchVel) < 1e-3 &&
      Math.abs(this.vrFovTarget - this.vrFov) < 1e-4;
    if (settled) {
      this.vrYaw = this.vrYawTarget;
      this.vrPitch = this.vrPitchTarget;
      this.vrFov = this.vrFovTarget;
      this.vrYawVel = 0;
      this.vrPitchVel = 0;
    }
    return settled;
  }

  /**
   * Drive the camera spring on its own rAF loop while it's unsettled. Steps at
   * a fixed 60Hz dt so the feel is frame-rate independent. During playback the
   * presentation loop already repaints each frame (reading the stepped current
   * values), so this loop only repaints when paused — it never double-draws.
   */
  private ensureVRAnimating(): void {
    if (this.vrAnimRaf !== null) return;
    const tick = () => {
      this.vrAnimRaf = null;
      if (!this.vr360Enabled) return;
      const settled = this.stepVRCamera(1 / 60);
      if (!this.isPlaying && this.lastRenderedFrame) {
        try {
          this.drawFrame(this.lastRenderedFrame, true);
        } catch (e) {
          Logger.debug(TAG, "VR spring redraw skipped", e);
        }
      }
      if (!settled) this.vrAnimRaf = requestAnimationFrame(tick);
    };
    this.vrAnimRaf = requestAnimationFrame(tick);
  }

  /** Repaint the retained frame once (e.g. on toggle) so the change is visible
   *  immediately even while paused. Continuous animation goes through the
   *  spring loop (ensureVRAnimating). */
  private redrawForVR(): void {
    if (this.lastRenderedFrame) {
      try {
        this.drawFrame(this.lastRenderedFrame, true);
      } catch (e) {
        Logger.debug(TAG, "VR redraw skipped", e);
      }
    }
  }

  /**
   * Draw a still image (custom or postertime-generated poster) to the canvas
   * through the normal frame path, so 360° mode projects it like a video frame.
   * A `poster` URL makes the player skip the initial decode, so without this the
   * canvas stays blank in 360 and only the flat <img> overlay shows. Retained as
   * lastRenderedFrame so resize and camera nudges repaint it.
   */
  renderPosterImage(image: CanvasImageSource): void {
    if (!this.gl || !this.program || !this.texture) return;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(image, { timestamp: 0 });
    } catch (e) {
      Logger.warn(TAG, "Failed to wrap poster image as VideoFrame", e);
      return;
    }
    try {
      this.render(frame);
    } finally {
      frame.close();
    }
  }

  private lastPrimaries?: string;
  private lastTransfer?: string;

  /**
   * Set HDR enabled state
   */
  setHDREnabled(enabled: boolean): void {
    if (this.hdrEnabled === enabled) return;
    this.hdrEnabled = enabled;
    Logger.info(TAG, `HDR manual override set to: ${enabled}`);

    // Re-detect and re-apply color space if gl exists.
    // Mirror configure(): upgrade HDR sources on Chromium to rec2100-pq/hlg so
    // the compositor sends full peak brightness. detectHDRColorSpace() only
    // returns display-p3 (wide-gamut SDR), which would dim the picture.
    const detectedColorSpace = this.detectHDRColorSpace(
      this.lastPrimaries,
      this.lastTransfer,
    );

    if (this.gl && this.gl.drawingBufferColorSpace !== undefined) {
      try {
        const isChromium = !!(window as any).chrome;
        const transferLc = (this.lastTransfer || "").toLowerCase();
        const isHLGSource =
          transferLc.includes("hlg") || transferLc.includes("arib-std-b67");
        const isHDRPath = this.isHDRSource && this.hdrEnabled && isChromium;
        const hdrSpace = isHLGSource ? "rec2100-hlg" : "rec2100-pq";

        let targetSpace: string;
        if (isHDRPath) {
          targetSpace = hdrSpace;
        } else if (detectedColorSpace !== "srgb") {
          const supportedSpaces = ["srgb", "display-p3"];
          targetSpace = supportedSpaces.includes(detectedColorSpace)
            ? detectedColorSpace
            : "srgb";
        } else {
          targetSpace = "srgb";
        }

        // Chromium throws (not silent-ignore) on unsupported rec2100-pq/hlg
        // when the HDR canvas flag is off. Try first, fall back to display-p3.
        let applied: string | null = null;
        try {
          // @ts-ignore
          this.gl.drawingBufferColorSpace = targetSpace;
          // @ts-ignore
          if (this.gl.drawingBufferColorSpace === targetSpace) {
            applied = targetSpace;
          }
        } catch (_e) {
          // setter threw — flag likely off
        }

        if (!applied && isHDRPath) {
          Logger.warn(
            TAG,
            `Browser rejected ${targetSpace} on toggle. HDR canvas flag likely disabled — falling back to display-p3.`,
          );
          try {
            // @ts-ignore
            this.gl.drawingBufferColorSpace = "display-p3";
            applied = "display-p3";
          } catch (_e2) {
            applied = null;
          }
        }

        if (applied) {
          // @ts-ignore
          this.gl.unpackColorSpace = applied;
          this.colorSpace = applied === targetSpace ? detectedColorSpace : applied;
          Logger.info(
            TAG,
            `Updated WebGL color space to ${applied} (detected: ${detectedColorSpace}, HDR path: ${isHDRPath}) following HDR toggle`,
          );
        }
        this.setMacHdrCompositingGuard(applied === hdrSpace);
      } catch (e) {
        Logger.warn(TAG, "Failed to update drawingBufferColorSpace on the fly");
      }
    }

    // Update u_hdrEnabled uniform for shader-based tone mapping (non-Chromium browsers)
    if (
      this.gl &&
      this.program &&
      !this.hasNativeHDRSupport &&
      this.isHDRSource
    ) {
      const uHdrEnabled = this.gl.getUniformLocation(
        this.program,
        "u_hdrEnabled",
      );
      if (uHdrEnabled) {
        this.gl.useProgram(this.program);
        this.gl.uniform1f(uHdrEnabled, enabled ? 1.0 : 0.0);
        Logger.debug(
          TAG,
          `Updated u_hdrEnabled uniform to: ${enabled ? 1.0 : 0.0}`,
        );
      }
    }

    // Trigger immediate redraw if paused
    if (!this.isPlaying && this.lastRenderedFrame) {
      this.drawFrame(this.lastRenderedFrame, true);
    }
  }

  /**
   * Make macOS Chromium hand this canvas to CoreAnimation as extended-range
   * content rather than as a PQ-tagged surface.
   *
   * Measured 2026-09-19 (Chrome 153, macOS 26, HDR display, /tmp/hdr10.mp4,
   * pixels read back from a screencapture of the composited display):
   * whenever every quad in the frame qualifies, Chromium's Mac compositor
   * gives the whole frame to CoreAnimation as CALayers
   * (Compositing.Renderer.CALayerResult bucket 0 on a bare page and in
   * fullscreen), and the layer holding a rec2100-pq canvas is shown
   * tone-mapped to SDR — red bar 234,53,36, correct colours, no headroom.
   * An RGBA16F drawing buffer changes nothing (same 234,53,36), and
   * configureHighDynamicRange({mode:"extended"}) changes nothing;
   * drawingBufferToneMapping is not in Chrome 153 at all. The app page only
   * showed HDR windowed because a backdrop-filter in it failed the promotion
   * (bucket 19) and the frame was drawn by the SkiaRenderer, whose HDR
   * surfaces are extended-sRGB float — red 255,0,21. With
   * --disable-features=UseCALayerContentsHeadroom (Chromium's Metal HDR
   * copier instead of the macOS 26 contentsHeadroom attribute) the same PQ
   * layer shows as HDR, so the loss is in that new path.
   *
   * Two different non-zero corner radii on the canvas make cc render it
   * through a render pass of its own; the pass texture is viz's extended-sRGB
   * float, and that is what the CALayer receives — promotion still succeeds
   * (bucket 0) but the bare page, windowed and fullscreen, now composites
   * the same pixels as the app page (255,0,16). Uniform radii would not do:
   * they are applied on the quad itself and the PQ surface would still go
   * to the layer. The rounding is 1px and 2px on the top corners, under the
   * host's own clip when it is rounded and at the screen corners in
   * fullscreen, so nothing shows. Mac + Chromium only: that is where it was
   * measured, and elsewhere it would only cost a render pass.
   */
  private setMacHdrCompositingGuard(on: boolean): void {
    if (!(this.canvas instanceof HTMLCanvasElement)) return;
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    const isMac =
      nav.userAgentData?.platform === "macOS" ||
      /^Mac/i.test(nav.platform || "");
    const isChromium = !!(window as any).chrome;
    if (!isMac || !isChromium) return;
    this.canvas.style.borderRadius = on ? "1px 2px 0 0" : "";
  }

  /**
   * Check if the current video source supports HDR
   */
  isHDRSupported(): boolean {
    return this.isHDRSource;
  }

  resize(width: number, height: number, fromRotate: boolean = false): void {
    if (width > 0 && height > 0) {
      // Store original container dimensions (only from external resize, not from rotate)
      if (!fromRotate) {
        this.containerWidth = width;
        this.containerHeight = height;
      }

      Logger.debug(
        TAG,
        `Resizing to: ${width}x${height} (Rotation: ${this.rotation}°)`,
      );

      const isRotated90 = this.rotation % 180 !== 0;

      // If rotated 90/270, we swap dimensions
      // The container is WxH. We want the Visual result to be WxH.
      // So the Canvas (pre-rotation) must be HxW.
      // Then rotate(90) turns HxW -> WxH.
      const targetWidth = isRotated90 ? height : width;
      const targetHeight = isRotated90 ? width : height;

      // Backbuffer scales with devicePixelRatio so we don't lose detail
      // when downsampling high-resolution sources (4K/8K). Starts at 2x
      // and adapts down to 1x at runtime if the paint loop measures
      // slow on the actual device — `deviceMemory` and `hardwareConcurrency`
      // are too coarse / unreliable as a-priori signals (rounded to
      // powers of 2, absent on iOS, weak GPU often paired with healthy
      // RAM), so the only honest answer is to measure the device under
      // load. See `_adaptDprIfSlow` in the presentation loop.
      const dpr = Math.min(
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        this._maxDpr,
      );
      const bufferWidth = Math.round(targetWidth * dpr);
      const bufferHeight = Math.round(targetHeight * dpr);

      // Track whether the drawing-buffer actually changed. When the caller
      // resizes with the same dims (e.g. the fit-mode toggle's pre-flip
      // refresh in MoviElement.updateFitMode), we must NOT reset the
      // smoothing state — doing so makes drawFrame snap to the new fit's
      // target on the very first tick, which kills the fit animation.
      const bufferChanged =
        this.width !== bufferWidth || this.height !== bufferHeight;

      this.width = bufferWidth;
      this.height = bufferHeight;
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;

      // Apply CSS sizing
      if (this.canvas instanceof HTMLCanvasElement) {
        if (isRotated90) {
          // Explicit pixel size is needed to override percentage stretching
          // so the buffer aspect ratio (HxW) is preserved in layout before rotation
          // We use !important to ensure this overrides any fullscreen CSS that forces 100vw/100vh
          // CSS uses logical pixels (targetWidth/Height); backbuffer is dpr-scaled.
          this.canvas.style.setProperty(
            "width",
            `${targetWidth}px`,
            "important",
          );
          this.canvas.style.setProperty(
            "height",
            `${targetHeight}px`,
            "important",
          );

          // Center the rotated element absolutely
          this.canvas.style.position = "absolute";
          this.canvas.style.top = "50%";
          this.canvas.style.left = "50%";
          this.canvas.style.margin = "0";

          // Override conflicting global CSS max-dimensions (like 100vh in fullscreen)
          // When rotated, width/height are swapped, so 'height' might need to exceed '100vh' (to become 100vw visual)
          // BUT only do this for non-contain modes (Cover/Fill/Zoom).
          // If 'contain', we respect the limits to ensure it fits within viewport without overflow logic issues
          if (this.fitMode === "contain") {
            this.canvas.style.setProperty("max-width", "none", "important");
            this.canvas.style.setProperty("max-height", "none", "important");
          }

          // Rotate around center
          this.canvas.style.transform = `translate(-50%, -50%) rotate(${this.rotation}deg)`;
          this.canvas.style.transformOrigin = "center center";
        } else {
          // Restore standard sizing (0° and 180°)
          this.canvas.style.position = "relative";
          this.canvas.style.top = "";
          this.canvas.style.left = "";
          this.canvas.style.margin = "";
          this.canvas.style.setProperty("width", "100%", "important");
          this.canvas.style.setProperty("height", "100%", "important");
          this.canvas.style.setProperty("max-width", "none", "important");
          this.canvas.style.setProperty("max-height", "none", "important");
          this.canvas.style.transformOrigin = "center center";
          this.canvas.style.transform = this.rotation === 180 ? "rotate(180deg)" : "none";
        }
      }

      // Recreate context only if not exists (usually resize just updates viewport in WebGL,
      // but if canvas was reset we might need to check gl)
      // WebGL contexts are robust to resize usually.
      if (!this.gl) {
        // Try to init if missing
        const opts = { alpha: true, premultipliedAlpha: true, desynchronized: false };
        this.gl = this.canvas.getContext(
          "webgl2",
          opts,
        ) as WebGL2RenderingContext;
        this.initWebGL();
      } else {
        // Just need to update viewport during draw
        // Trigger a redraw
      }

      // Immediately redraw without smoothing to avoid black flicker, but
      // only force-snap when the buffer dims genuinely changed. Same-size
      // resizes (fit-mode pre-flip refresh) must keep the existing scale
      // so the next drawFrame can lerp toward the new fit's target.
      try {
        if (bufferChanged) {
          // Reset smoothing state so it doesn't interpolate from old dimensions
          this.currentScaleX = 0;
          this.currentScaleY = 0;
          this._scaleContentW = 0;
          this._scaleContentH = 0;

          if (this.frameQueue.length > 0) {
            this.drawFrame(this.frameQueue[0], true);
          } else if (this.lastRenderedFrame) {
            this.drawFrame(this.lastRenderedFrame, true);
          }
        }
      } catch (error) {
        Logger.error(TAG, "Error redrawing frame after resize", error);
      }

      // Update overlay dimensions
      if (this.subtitleOverlay) {
        // The overlay lives in the video's own (pre-rotation) coordinate space
        // and is then rotated to match the video, so captions ride the video's
        // bottom edge and turn with it. For 90°/270° the box is swapped (H×W)
        // and centred in the container so that, once rotated around its centre,
        // it maps back onto the video area.
        const rot = (((this.rotation ?? 0) % 360) + 360) % 360;
        const swapped = rot === 90 || rot === 270;
        const overlayWidth = swapped ? height : width;
        const overlayHeight = swapped ? width : height;

        // Responsive bottom padding is relative to the video's visual height
        // in its own frame (overlayHeight), not the container.
        const bottomPadding =
          this.subtitleBottomPadding(overlayHeight);

        // Reset overlay positioning to ensure it stays aligned with canvas
        this.subtitleOverlay.style.position = "absolute";
        this.subtitleOverlay.style.right = "auto";
        this.subtitleOverlay.style.bottom = "auto";
        this.subtitleOverlay.style.width = `${overlayWidth}px`;
        this.subtitleOverlay.style.height = `${overlayHeight}px`;
        this.subtitleOverlay.style.left = `${(width - overlayWidth) / 2}px`;
        this.subtitleOverlay.style.top = `${(height - overlayHeight) / 2}px`;
        this.subtitleOverlay.style.margin = "0";
        this.subtitleOverlay.style.padding = "0";
        const effectivePadding = this.subtitleEffectiveBottomPadding(
          overlayHeight,
          bottomPadding,
        );
        this.subtitleOverlay.style.paddingBottom = `${effectivePadding}px`;
        this.subtitleOverlay.style.display = "flex";
        this.subtitleOverlay.style.flexDirection = "column";
        this.subtitleOverlay.style.justifyContent = "flex-end";
        this.subtitleOverlay.style.alignItems = "center";
        this.subtitleOverlay.style.transformOrigin = "center center";
        this.subtitleOverlay.style.transform = rot ? `rotate(${rot}deg)` : "none";
        this.subtitleOverlay.style.boxSizing = "border-box";

        // Schedule a re-render so the on-screen subtitle picks up the
        // new dimensions. Coalesce via rAF — a window drag bursts
        // resize events, and re-running the full subtitle layout each
        // tick blocks the main thread long enough to stall the
        // presentation loop (player ends up "stuck" with a running
        // timer once the burst settles).
        if (this.activeSubtitleCue && bufferChanged) {
          this.scheduleSubtitleRerender();
        }
      }
    }
  }

  /**
   * Set letterbox/pillarbox color (for ambient background effect).
   * Color is applied on the next frame draw via clearColor.
   */
  setLetterboxColor(r: number, g: number, b: number): void {
    this.letterboxTarget = [r, g, b];
  }

  /**
   * Set fit mode for canvas rendering
   * - 'contain': Scale to fit while maintaining aspect ratio (default)
   * - 'cover': Scale to cover entire canvas while maintaining aspect ratio (may crop)
   * - 'fill': Stretch to fill entire canvas (may distort aspect ratio)
   */
  setFitMode(mode: "contain" | "cover" | "fill" | "zoom" | "control"): void {
    this.fitMode = mode;
    Logger.debug(TAG, `Fit mode set to: ${mode}`);

    // Update rotation CSS overrides based on new fit mode
    if (this.rotation % 180 !== 0 && this.canvas instanceof HTMLCanvasElement) {
      if (mode === "contain") {
        this.canvas.style.setProperty("max-width", "none", "important");
        this.canvas.style.setProperty("max-height", "none", "important");
      }
    }

    // Re-render last frame to show fit mode change immediately. Cannot gate on
    // !isPlaying — after a seek-to-paused, the presentation loop is still
    // running but no new frames arrive, so the loop alone won't repaint.
    // Drive an RAF loop so drawFrame runs without `force`, letting the scale
    // interpolation animate toward the new target.
    if (this.lastRenderedFrame) {
      this.startFitAnimation();
    }
  }

  private startFitAnimation(): void {
    if (this.fitAnimRafId !== null) return;
    const tick = () => {
      this.fitAnimRafId = null;
      if (!this.lastRenderedFrame) return;
      this.drawFrame(this.lastRenderedFrame, false);
      // Stop once scale has effectively converged (drawFrame snaps within 1e-4)
      const settled =
        Math.abs(this.currentScaleX - this.lastTargetScaleX) < 1e-4 &&
        Math.abs(this.currentScaleY - this.lastTargetScaleY) < 1e-4;
      if (!settled) {
        this.fitAnimRafId = requestAnimationFrame(tick);
      }
    };
    this.fitAnimRafId = requestAnimationFrame(tick);
  }

  /**
   * Set audio time provider for A/V sync
   * Pass null to disable A/V sync and run video independently
   */
  setAudioTimeProvider(
    getAudioTime: (() => number) | null,
    isAudioHealthy?: (() => boolean) | null,
    audioStartLead?: (() => number) | null,
  ): void {
    this.getAudioTime = getAudioTime;
    this._isAudioHealthy = isAudioHealthy || null;
    this._audioStartLead = audioStartLead || null;
    if (getAudioTime) {
      Logger.debug(TAG, "Audio time provider set");
    } else {
      Logger.debug(
        TAG,
        "Audio time provider disabled - video running independently",
      );
      // Reset sync state when disabling audio
      this.syncedToAudio = false;
    }
  }

  /**
   * Queue a VideoFrame for presentation (instead of immediate render)
   */
  queueFrame(frame: VideoFrame): void {
    // Emergency limit - drop if queue is too full (10x normal size)
    if (this.frameQueue.length >= CanvasRenderer.MAX_FRAME_QUEUE * 10) {
      frame.close();
      Logger.warn(
        TAG,
        `Frame queue overflow, dropping frame. Queue size: ${this.frameQueue.length}`,
      );
      return;
    }

    // For large queues, use binary search insertion for better performance
    const frameTime = frame.timestamp;
    if (this.frameQueue.length > 0) {
      const lastTime = this.frameQueue[this.frameQueue.length - 1].timestamp;
      if (frameTime >= lastTime) {
        // Fast path: frames are usually in order
        this.frameQueue.push(frame);
      } else {
        // Need to insert in order - use binary search for O(log n) insertion
        let left = 0;
        let right = this.frameQueue.length;
        while (left < right) {
          const mid = Math.floor((left + right) / 2);
          if (this.frameQueue[mid].timestamp <= frameTime) {
            left = mid + 1;
          } else {
            right = mid;
          }
        }
        this.frameQueue.splice(left, 0, frame);
      }
    } else {
      this.frameQueue.push(frame);
    }
  }

  /**
   * Render a VideoFrame immediately (for simple cases)
   */
  render(frame: RenderSource): void {
    this.drawFrame(frame);
    // A <video> source is not ours to clone or close — it stays on screen
    // holding its own current picture, so retain the element itself and let
    // the paused-redraw paths re-upload from it.
    if (isVideoElementSource(frame)) {
      this.releaseRetainedFrame();
      this.lastRenderedFrame = frame;
      return;
    }
    // Retain a clone so paused redraws (resize, fit-mode change via
    // startFitAnimation) have a frame to lerp against. The presentation-
    // loop path stores this on every present; this direct-render path
    // (used by HLSPlayerWrapper) was missing the clone, leaving the
    // fit-mode animation as a hard snap on HLS streams.
    this.releaseRetainedFrame();
    try {
      this.lastRenderedFrame = frame.clone();
    } catch {
      this.lastRenderedFrame = null;
    }
  }

  /**
   * Drop the retained frame. Only a VideoFrame is ours to close — a retained
   * <video> element belongs to the MSE wrapper that owns it.
   */
  private releaseRetainedFrame(): void {
    const retained = this.lastRenderedFrame;
    this.lastRenderedFrame = null;
    if (retained && !isVideoElementSource(retained)) {
      try {
        retained.close();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Start the presentation loop for smooth playback
   */
  startPresentationLoop(): void {
    // Audio-only source (no video track configured): nothing to present, and
    // running A/V sync against a non-existent video stream is meaningless. The
    // cover art, if any, is drawn separately via the overlay canvas.
    if (!this.isVideoConfigured || this.pictureSuspended) {
      // The captions still have to run, though. Cues arrive from the decoder
      // either way, and with no loop nothing ever compares them against the
      // clock: an audio track's subtitles stayed empty for its whole length,
      // and giving the source a picture back is what appeared to fix them.
      this.isPlaying = true;
      this.startSubtitleClock();
      return;
    }
    if (this.rafId !== null) return;

    this.isPlaying = true;

    // Only reset timing if we don't have frames (fresh start/seek)
    // If we have queue, we are resuming, so keep last known PTS to avoid jumps
    if (this.frameQueue.length === 0) {
      this.lastPresentedPts = -1;
      this.framesPresented = 0; // Reset frame counter for fresh start
      this.syncedToAudio = false;
      // Do NOT anchor the wall clock yet on a fresh start. If we set
      // presentationStartTime here — before the first frame has decoded or
      // audio has begun (8K/AV1 decode warmup can take ~1s) — getVideoTime
      // accrues that elapsed against a stream that isn't playing, so the video
      // clock races ahead. That surfaced as a ~1s startup "drift" that then
      // hard-resets to audio, and in timing variants where a frame is already
      // queued during the wait it presents frames at high speed (a startup
      // fast-forward flash). Leave it at 0 so getVideoTime reports "not
      // started" until the first frame / first audio sample anchors it cleanly
      // (getVideoTime's videoTime<0 reset, or the first-frame present path).
      this.presentationStartTime = 0;
      this.presentationStartPts = 0;
    } else {
      // Resuming with frames: the stream is already playing, so start the wall
      // clock now and anchor it to the last presented time to prevent a jump.
      //
      // "Now", unless the sound for this run hasn't reached the speakers yet —
      // an ordinary unpause never waits (the audio anchor is long past, so the
      // lead reads zero), but a resume out of the post-seek queue wait is a
      // fresh audio run whose first buffer is still in flight. See
      // audioStartLeadMs().
      this.presentationStartTime = performance.now() + this.audioStartLeadMs();
      if (this.lastPresentedPts >= 0) {
        this.presentationStartPts = this.lastPresentedPts;
      } else {
        this.presentationStartPts = this.frameQueue[0].timestamp / 1_000_000;
      }
      this.syncedToAudio = false;
      // Anchored on the frame we paused on — no jump — but that frame is NOT
      // where the sound resumes. pause() suspends the context, it does not
      // flush what the device already holds, so the audio clock comes back a
      // step away from the paused picture: measured at +254ms, +11ms and
      // -31ms across three resumes of one file. Left to the soft-sync branch
      // every one of those steps under 400ms is accepted and kept for the
      // rest of the run. It is the same situation a rate change creates, and
      // it has the same answer: this unsync was caused by us, so there is no
      // old anchor worth protecting — re-anchor on the sound the moment it is
      // actually running. Nothing happens while the context is still coming
      // out of suspend; the audio clock reports -1 until then.
      this.reanchorRequested = true;
    }

    this.presentationLoop();
    Logger.debug(TAG, "Presentation loop started");
  }

  /**
   * Stop the presentation loop
   */
  stopPresentationLoop(): void {
    this.isPlaying = false;
    this.stopSubtitleClock();
    // The perf windows are rates measured across wall-clock time, and nothing
    // is going to tick them while the loop is stopped. See resetPerfWindows().
    this.resetPerfWindows();

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // NOTE: We do NOT clear the frame queue here anymore.
    // This allows resuming playback instantly without re-buffering.
    // The queue is cleared explicitly via clearQueue() during seek or destroy.

    // Do NOT clear lastRenderedFrame here - we need it for resize during pause

    Logger.debug(TAG, "Presentation loop stopped");
  }

  /**
   * The caption clock for a source with no picture.
   *
   * updateActiveSubtitle() and renderSubtitles() live inside the presentation
   * loop, which is where they belong while frames are being shown and exactly
   * the wrong place for a source that has none: an audio file, or an
   * audio-only rendition of a video one. This stands in for the loop there.
   *
   * An interval rather than a rAF, because neither of the reasons to use rAF
   * applies: nothing is being painted in step with a frame, and an audio track
   * playing behind another tab is the ordinary case, not the odd one — rAF
   * parks there while the sound carries on. 100ms is the tolerance the cue
   * matcher already works to.
   */
  private startSubtitleClock(): void {
    if (this.subtitleClockTimer !== null) return;
    this.subtitleClockTimer = setInterval(() => {
      this.updateActiveSubtitle();
      this.renderSubtitles();
    }, 100);
  }

  private stopSubtitleClock(): void {
    if (this.subtitleClockTimer === null) return;
    clearInterval(this.subtitleClockTimer);
    this.subtitleClockTimer = null;
  }

  /**
   * Data-saver audio-only: a video track is configured and this renderer is
   * set up for it, but not one packet of it is being decoded.
   *
   * Presenting is then a loop with nothing to present, and worse than idle:
   * the perf detectors would read sixty ticks a second against zero frames
   * with audio flowing, which is their signature for a source the machine
   * cannot decode. So the captions move to the clock a picture-less source
   * uses, and the loop stands down until the picture comes back.
   */
  setPictureSuspended(suspended: boolean): void {
    if (this.pictureSuspended === suspended) return;
    this.pictureSuspended = suspended;
    if (!this.isPlaying) return;
    if (suspended) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      // Whatever those windows measured, they measured it against a picture
      // that is about to stop arriving. See resetPerfWindows().
      this.resetPerfWindows();
      this.startSubtitleClock();
      return;
    }
    this.stopSubtitleClock();
    if (this.rafId === null) {
      this.isPlaying = false;
      this.startPresentationLoop();
    }
  }

  /**
   * The presentation loop, wrapped so each tick is counted and timed. Both
   * numbers feed sampleRafCadence(), which is what lets the perf detectors tell
   * "the decoder is behind" apart from "the host page is holding the main
   * thread". Everything the loop actually does lives in presentationTick().
   */
  private presentationLoop = (): void => {
    const tickStart = performance.now();
    this._rafTicks++;
    try {
      this.presentationTick();
    } finally {
      this._rafSelfMs += performance.now() - tickStart;
    }
  };

  /**
   * RAF-based presentation loop - presents frames at VSync-aligned times
   * For true 60fps, we present exactly one frame per RAF call when available
   */
  private presentationTick = (): void => {
    if (!this.isPlaying) {
      this.rafId = null;
      return;
    }

    // Schedule next frame first (ensures consistent timing)
    // This ensures RAF timing is consistent and VSync-aligned
    this.rafId = requestAnimationFrame(this.presentationLoop);

    // Roll the adaptive-FPS window every cycle (before the empty-queue bail, so
    // a starving pipeline still registers its low present rate).
    this.samplePerformance();

    // Get current playback time with high precision
    let currentPlaybackTime = this.getCurrentPlaybackTime();

    // Startup fix: If we have frames but no time reference, show first frame
    if (
      currentPlaybackTime < 0 &&
      this.lastPresentedPts < 0 &&
      this.frameQueue.length > 0
    ) {
      currentPlaybackTime = 0;
    }

    // For true 60fps, always try to present a frame if available
    // This ensures we maintain frame rate even if timing is slightly off
    if (this.frameQueue.length === 0) {
      // Even if no frames, still update subtitles based on current playback time
      this.updateActiveSubtitle();
      this.renderSubtitles();
      return; // No frames available, wait for next cycle
    }

    // Select the best frame to present
    const frameToPresent = this.selectFrameForPresentation(currentPlaybackTime);

    // For 60fps videos, always present a frame if available to maintain smooth playback
    // If no frame was selected but we have frames, use the first one
    if (
      !frameToPresent &&
      this._presentFpsCap === 0 &&
      this.videoFrameRate >= 60 &&
      this.frameQueue.length > 0
    ) {
      // For 60fps, present the first available frame to maintain cadence
      const firstFrame = this.frameQueue[0];
      const frameTime = firstFrame.timestamp / 1_000_000;
      const frameInterval = 1.0 / this.videoFrameRate;
      // Reject frames that are too far ahead OR too far behind. Without the
      // upper cap, hardware decoders that emit 8K frames in bursts queue
      // many future-PTS frames; on >60Hz displays this fallback then drains
      // them faster than wall-clock, advancing currentTime past the audio
      // clock and tripping the audio-desync resync seek loop.
      const ahead = frameTime - currentPlaybackTime;
      const behind = currentPlaybackTime - frameTime;
      if (ahead <= frameInterval && behind <= frameInterval * 2) {
        this.drawFrame(firstFrame);

        // Retain for resize redraws
        this.releaseRetainedFrame();
        try {
          this.lastRenderedFrame = firstFrame.clone();
        } catch (e) {
          // Frame closed, ignore
          this.lastRenderedFrame = null;
        }

        firstFrame.close();
        this.frameQueue.shift();
        this.lastPresentedPts = frameTime;
        this.currentTime = frameTime;
        this.framesPresented++;
        this.onFramePresented?.(this.currentTime);
        this.onFramePresented?.(this.currentTime);
        this._lastPresentAt = performance.now();
        return;
      }
    }

    if (frameToPresent) {
      // Draw and close the frame (drawFrame will update currentTime)
      this.drawFrame(frameToPresent);

      // Retain for resize redraws
      this.releaseRetainedFrame();
      try {
        this.lastRenderedFrame = frameToPresent.clone();
      } catch (e) {
        // Frame closed, ignore
        this.lastRenderedFrame = null;
      }

      frameToPresent.close();

      // Remove the frame from queue (it was already selected and kept for drawing)
      const frameIndex = this.frameQueue.findIndex((f) => f === frameToPresent);
      if (frameIndex >= 0) {
        this.frameQueue.splice(frameIndex, 1);
      }
    }

    // Always update and render subtitles based on current playback time
    // This ensures subtitles appear/disappear at the right time even if no new frame is drawn
    this.updateActiveSubtitle();
    this.renderSubtitles();
    // If no new frame is due, keep showing the last frame (canvas holds the image)
    // This is how YouTube handles all frame rates - smooth and natural
  };

  /**
   * Get current playback time using wall clock with loose A/V sync
   * Video runs smoothly on wall clock, with periodic drift correction from audio
   * This ensures smooth 60fps video playback while maintaining A/V sync
   */
  private getCurrentPlaybackTime(): number {
    // No picture at all: the sound IS the clock. Everything below exists to
    // hold frames in step with the audio, and there are no frames — while the
    // last-presented-PTS fallback right under this would pin every caption to
    // -1 for the whole track, since nothing is ever presented.
    if (!this.isVideoConfigured || this.subtitleClockTimer !== null) {
      return this.getAudioTime ? this.getAudioTime() : -1;
    }
    // When the presentation loop is stopped (player paused), the
    // wall-clock formula below would advance time forever — but no one
    // is consuming frames, so updateActiveSubtitle (called from
    // setSubtitleCues during prefetch / track switches while paused)
    // would pick increasingly-out-of-sync cues and the in-video
    // subtitle would silently swap underneath the user. Return the last
    // actually-presented PTS (or, before the first frame, the anchor
    // pts) so the active cue stays pinned to the visible frame.
    if (!this.isPlaying) {
      if (this.lastPresentedPts >= 0) return this.lastPresentedPts;
      if (this.presentationStartPts > 0) return this.presentationStartPts;
      return -1;
    }
    // Always use wall clock for video timing (smooth 60fps)
    //
    // The anchor can sit in the FUTURE: on a high-latency output the sound for
    // this run is not audible yet, so the anchor is placed at the moment it
    // will be (see audioStartLeadMs). Floor the elapsed at zero exactly as the
    // audio clock floors its own — the picture holds on the anchor frame until
    // the sound reaches it, rather than running backwards from it.
    let videoTime = -1;
    if (this.presentationStartTime > 0) {
      const elapsed = (performance.now() - this.presentationStartTime) / 1000;
      videoTime =
        this.presentationStartPts + Math.max(0, elapsed) * this.playbackRate;
    }

    // Check audio for drift correction (but don't block video)
    if (this.getAudioTime) {
      const audioTime = this.getAudioTime();
      const isHealthy = this._isAudioHealthy ? this._isAudioHealthy() : true;

      // Track last known audio time for capping video when audio drops out
      if (audioTime >= 0) {
        this.lastKnownAudioTime = audioTime;
      }

      if (audioTime >= 0 && isHealthy) {
        // Every drift budget below is in MEDIA seconds, and what the eye
        // judges is REAL ones. At 0.25x a 150ms media offset is 600ms of the
        // sound arriving after the mouth — the same number that is fine at 1x
        // is four times as wrong at quarter speed. Scale the budgets with the
        // rate, and never past 1, so speeds above 1x keep exactly the
        // tolerances they have today.
        const rateScale = Math.min(this.playbackRate, 1);

        // First sync - initialize wall clock to match audio
        if (!this.syncedToAudio) {
          const drift = videoTime >= 0 ? Math.abs(videoTime - audioTime) : 0;
          const isVeryEarlyPlayback = this.framesPresented <= 3;

          // Reset presentation anchors if:
          // 1. Video hasn't started yet (videoTime < 0), OR
          // 2. Very early playback (≤3 frames) AND drift is significant (>30ms)
          //    This gives Bluetooth audio time to stabilize before hard sync
          // 3. Drift is very large (> 400ms) - critical desync recovery
          // A drift too small for the 400ms bar below but too small for the
          // continuous correction's own 150ms threshold has nowhere to go: the
          // else-branch marks us synced and the offset becomes permanent. That
          // is audible — measured on a 4K60 file, speed changes settled the
          // picture 120-148ms off the sound and it stayed there. When the
          // unsync was REQUESTED there is no old anchor worth protecting, so
          // re-anchor whatever the drift is.
          if (
            this.reanchorRequested ||
            videoTime < 0 ||
            (isVeryEarlyPlayback && drift > 0.03 * rateScale) ||
            drift > 0.4 * rateScale
          ) {
            this.reanchorRequested = false;
            this.presentationStartTime =
              performance.now() + this.audioStartLeadMs();
            this.presentationStartPts = audioTime;
            this.syncedToAudio = true;
            Logger.debug(TAG, `Initial A/V sync: audioTime=${audioTime.toFixed(3)}s, framesPresented=${this.framesPresented}, drift=${(drift * 1000).toFixed(0)}ms, early=${isVeryEarlyPlayback}`);
            return audioTime;
          } else {
            // We're already playing, just mark as synced without resetting
            // This prevents stuttering when Bluetooth latency causes audio clock fluctuations
            this.syncedToAudio = true;
            this.reanchorRequested = false;
            Logger.debug(TAG, `Soft A/V sync (no reset): videoTime=${videoTime.toFixed(3)}s, audioTime=${audioTime.toFixed(3)}s, framesPresented=${this.framesPresented}, drift=${(drift * 1000).toFixed(0)}ms`);
          }
        }

        // High-FPS (≥50fps) at slow speed: aggressive drift correction to prevent
        // video racing ahead of audio due to backpressure-induced audio gaps.
        const isSlowHighFps = this.playbackRate < 0.99 && this.videoFrameRate >= 50;

        // …but not against a clock that has not started yet. Before the first
        // scheduled buffer is audible the audio clock is flat at the run's
        // starting media time by construction, so `drift` here is not drift at
        // all — it is the lead itself, read as error. On Bluetooth that is
        // ~600ms, far past the 150ms threshold, so this fired every frame and
        // walked presentationStartPts backwards ~600ms over a handful of ticks:
        // the picture stopped dead until the wall clock caught up with where
        // the anchor had been dragged to. That is the freeze a moment after
        // every seek that only ever showed up on Bluetooth. The anchor is
        // already placed for the lead above; there is nothing to correct until
        // sound is actually coming out.
        if (
          videoTime >= 0 &&
          this.framesPresented > 30 &&
          this.audioStartLeadMs() <= 0
        ) {
          const drift = videoTime - audioTime;
          // Anything under this threshold is banked forever: the branch above
          // marks us synced without moving the anchor, and this is the only
          // thing that would have closed it. Read off a 25fps file watched at
          // 0.25x — resume after a pause settled the picture 70ms off the
          // sound and kept it there, because 70ms never reached the 150ms bar,
          // and 70ms of media at quarter speed is 280ms of real lip-sync
          // error. The deadband is wide on purpose (a tight one chases
          // Bluetooth's own clock jitter and judders), so keep the width in
          // REAL time and let the media-time figure follow the rate. Clamped
          // rather than scaled so the tighter high-fps value still wins where
          // it applies and 1x is bit-for-bit what it was.
          const threshold = Math.min(isSlowHighFps ? 0.05 : 0.15, 0.15 * rateScale);
          const strength = isSlowHighFps ? 0.5 : 0.25;

          if (Math.abs(drift) > threshold) {
            this.presentationStartPts -= drift * strength;
          }
        }

        const elapsed = (performance.now() - this.presentationStartTime) / 1000;
        return (
          this.presentationStartPts + Math.max(0, elapsed) * this.playbackRate
        );
      }
    }

    // High-FPS slow playback: cap video to last known audio time when audio drops
    const isSlowHighFps = this.playbackRate < 0.99 && this.videoFrameRate >= 50;
    if (isSlowHighFps && videoTime >= 0 && this.lastKnownAudioTime >= 0 && this.syncedToAudio) {
      return Math.min(videoTime, this.lastKnownAudioTime + 0.15);
    }
    return videoTime >= 0 ? videoTime : -1;
  }

  /**
   * How far in the future to place a fresh presentation anchor so the picture
   * starts moving with the sound rather than ahead of it, in ms.
   *
   * Zero on every ordinary output — the provider reports the real figure and it
   * is a handful of milliseconds there. Capped so a device reporting something
   * absurd (or a stale reading taken across a route change) can't park the
   * picture: past a third of a second the honest thing is to start the picture
   * and let the drift correction close the rest.
   */
  private audioStartLeadMs(): number {
    if (!this._audioStartLead) return 0;
    const lead = this._audioStartLead();
    if (!(lead > 0)) return 0;
    return Math.min(lead, CanvasRenderer.MAX_AUDIO_START_LEAD_S) * 1000;
  }

  /**
   * Select the best frame to present for the current time
   * Uses timestamp-based presentation (like YouTube) - no forced frame repetition
   * Works smoothly for ALL frame rates: 24fps, 30fps, 50fps, 60fps, etc.
   */
  private selectFrameForPresentation(currentTime: number): VideoFrame | null {
    if (this.frameQueue.length === 0) {
      return null;
    }

    const frameInterval = 1.0 / this.videoFrameRate;

    // First frame special case - present immediately.
    if (this.lastPresentedPts < 0 && this.frameQueue.length > 0) {
      // Open-GOP recovery after seek can leave the decoder backing up to an
      // earlier reference frame (e.g. seek to 1067s but the decoder's first
      // usable frame is the GOP keyframe at 1066s). Presenting that as-is
      // makes video play 1-2s behind audio for several seconds. If audio
      // is already ahead, skip stale frames so the first-presented frame
      // is near the current playback position.
      if (this.getAudioTime) {
        const audioTime = this.getAudioTime();
        if (audioTime >= 0) {
          const tolerance = 0.2; // 200ms — beyond this and the lag is visible
          while (this.frameQueue.length > 1) {
            const head = this.frameQueue[0];
            const headSec = head.timestamp / 1_000_000;
            if (headSec < audioTime - tolerance) {
              head.close();
              this.frameQueue.shift();
            } else {
              break;
            }
          }
        }
      }

      const firstFrame = this.frameQueue.shift()!;
      this.lastPresentedPts = firstFrame.timestamp / 1_000_000;
      this.currentTime = this.lastPresentedPts;
      this.framesPresented = 1; // First frame presented
      this._lastPresentAt = performance.now();

      // Initialize presentation timing.
      //
      // This frame goes up now — it is the picture at the seek target and the
      // viewer should see it immediately — but the clock that walks FORWARD
      // from it starts when the sound does. On a normal output that is the same
      // instant; on Bluetooth the audio for this run is ~600ms from being
      // audible, and starting the wall clock now would run the picture that far
      // ahead of it. See audioStartLeadMs().
      this.presentationStartTime = performance.now() + this.audioStartLeadMs();
      this.presentationStartPts = this.lastPresentedPts;
      this.syncedToAudio = false;

      Logger.debug(
        TAG,
        `First frame: pts=${this.lastPresentedPts.toFixed(3)}s`,
      );
      return firstFrame;
    }

    // FPS Throttling & Memory Optimization
    // Two throttles share this gate:
    //  - Low-fps sources (< 20fps): drop far-early frames aggressively to bound
    //    4K memory while we wait out the long inter-frame gap.
    //  - Adaptive cap engaged: space presents at the capped interval so the
    //    source's intermediate frames are skipped evenly. No aggressive pruning
    //    needed there — the main selection's splice drops the skipped frames on
    //    the next present, so the queue can't run away.
    const capActive = this._presentFpsCap > 0;
    if ((capActive || this.videoFrameRate < 20) && this.lastPresentedPts >= 0) {
      const targetFps = capActive ? this._presentFpsCap : this.videoFrameRate;
      const targetInterval = 1.0 / targetFps;
      const nextTargetTime = this.lastPresentedPts + targetInterval;
      const tol = capActive ? Math.min(0.05, targetInterval * 0.5) : 0.05;

      // If we haven't reached the next target presentation time (with tolerance)
      if (currentTime < nextTargetTime - tol) {
        if (!capActive) {
          // Prune the queue: discard frames too early to be useful, keeping
          // only those within ~200ms of the target. Prevents buffering 1GB+ of
          // 4K frames in memory while waiting for the next second.
          const keepThreshold = nextTargetTime - 0.2;
          while (this.frameQueue.length > 0) {
            const first = this.frameQueue[0];
            const firstTime = first.timestamp / 1_000_000;
            if (firstTime >= keepThreshold) break;
            this.frameQueue.shift()?.close();
          }
        }

        // Not time to present yet
        return null;
      }
    }

    // Timestamp-based frame selection (like YouTube)
    // Find the best frame for currentTime - works for ALL frame rates
    let bestFrame: VideoFrame | null = null;
    let bestIndex = -1;

    // After seek, be more permissive to prevent stuttering
    const maxLookAhead = this.justSeeked
      ? frameInterval * 3.0
      : frameInterval * 1.5;

    // Find the latest frame that's due (timestamp <= currentTime + small tolerance)
    // This naturally handles all frame rates without forced repetition
    for (let i = 0; i < this.frameQueue.length; i++) {
      const frame = this.frameQueue[i];
      const frameTime = frame.timestamp / 1_000_000;

      // Never go backwards. "Due" only asked whether a frame sits at or before
      // the clock, never whether we had already shown something LATER — and
      // after a rate change we routinely have. The corrective seek repositions
      // the demuxer to the playhead without clearing this queue, so the frames
      // that arrive next start from the keyframe BEFORE that point while the
      // picture has already run on past it. Every one of them is "due", and
      // showing them rewinds the picture and replays it.
      //
      // Measured on 8K60 AV1, 2x: the renderer had presented up to 9.283s, then
      // showed 6.267s and walked forward from there while the clock ran 9.32,
      // 9.35, 9.45 — a three second rewind, sixty-two backward presentations in
      // one run, which is the flicker where frames "come and then go".
      //
      // Skipping them leaves them for the prune below, which drops anything
      // more than maxBehind behind the clock — it could not reach them before
      // because it stops at the frame this loop selected. The three sites that
      // legitimately restart the picture somewhere else (an empty queue, the
      // stale-frame drop, clearQueue on a real seek) all reset lastPresentedPts
      // to -1, so a genuine backward seek is untouched.
      if (this.lastPresentedPts >= 0 && frameTime < this.lastPresentedPts - 0.0005) {
        this._backwardsRefused++;
        continue;
      }

      // Frame is due if its timestamp is at or before currentTime (with small tolerance)
      if (frameTime <= currentTime + 0.005) {
        // 5ms tolerance
        bestFrame = frame;
        bestIndex = i;
      } else if (frameTime > currentTime + maxLookAhead) {
        // Stop searching - frames are too far in future
        break;
      }
    }

    // If no frame is due yet, check if we should present an early frame
    // This handles the case where we're slightly behind
    if (!bestFrame && this.frameQueue.length > 0) {
      const firstFrame = this.frameQueue[0];
      const firstFrameTime = firstFrame.timestamp / 1_000_000;

      // Same rule as the loop above, and it has to be repeated here: this
      // fallback reaches straight for the head of the queue, so without it the
      // no-going-backwards test is simply stepped around — which is exactly
      // what a first attempt at this did, leaving the count of backward
      // presentations unchanged at sixty-odd.
      const wouldGoBackwards =
        this.lastPresentedPts >= 0 &&
        firstFrameTime < this.lastPresentedPts - 0.0005;

      // If first frame is coming up soon (within one frame interval), present it
      if (!wouldGoBackwards && firstFrameTime <= currentTime + frameInterval) {
        bestFrame = firstFrame;
        bestIndex = 0;
      }
    }

    // Pre-roll after a seek is not playback.
    //
    // A resync restarts the decoder at the keyframe BEFORE the target, so the
    // frames that arrive first sit behind the clock. Presenting them plays that
    // gap at whatever rate the decoder can manage — measured at 3.3x on a 4K60
    // source, which is the picture visibly racing for a moment before settling.
    // Dropping them instead holds the last frame a fraction longer and then
    // resumes at 1x, already in sync. It shows at 60fps first because the same
    // gap in seconds holds two and a half times the frames.
    if (bestFrame && this.justSeeked) {
      const behind = currentTime - bestFrame.timestamp / 1_000_000;
      const tolerance = Math.max(0.12, frameInterval * 4);
      // …but never hold for long. A machine that cannot reach the clock at all
      // would otherwise show a frozen picture over playing audio, which is
      // worse than a late one — so past this the stale frame goes up anyway.
      const held = performance.now() - this._lastPresentAt;
      if (behind > tolerance && held < 500) {
        for (const f of this.frameQueue.splice(0, bestIndex + 1)) f.close();
        return null;
      }
    }

    // Clear justSeeked flag after we've found a frame
    if (bestFrame) {
      this.justSeeked = false;
    }

    // Drop old frames that are too far behind (more than 2 frame intervals)
    // BUT do not drop the best frame we just found!
    const maxBehind = Math.max(2.0, frameInterval * 2);
    while (this.frameQueue.length > 0) {
      const oldestFrame = this.frameQueue[0];
      const oldestFrameTime = oldestFrame.timestamp / 1_000_000;

      // If this is the frame we want to present, do not prune it
      if (oldestFrame === bestFrame) break;

      if (currentTime - oldestFrameTime > maxBehind) {
        this.frameQueue.shift()?.close();
      } else {
        break;
      }
    }

    // If we found a frame, update tracking and remove old frames
    // Say when the picture is being held still by the rule above.
    //
    // It was silent, and that is why it went unexplained across three separate
    // reports: the viewer sees the picture stop and then jump, and the log for
    // that stretch carries nothing at all — no state change, no seek, no drop.
    // Every other thing that can stop the picture announces itself; this did
    // not. Rate-limited to one line an episode, and it says how long and how
    // far, which is what tells this apart from a decoder that is merely slow.
    if (this._backwardsRefused > 0 && !bestFrame) {
      const heldMs = performance.now() - this._lastPresentAt;
      if (
        heldMs > CanvasRenderer.BACKWARDS_REPORT_AFTER_MS &&
        performance.now() - this._backwardsReportedAt >
          CanvasRenderer.BACKWARDS_REPORT_EVERY_MS
      ) {
        this._backwardsReportedAt = performance.now();
        const head = this.frameQueue.length
          ? this.frameQueue[0].timestamp / 1_000_000
          : NaN;
        Logger.warn(
          TAG,
          `Picture held at ${this.lastPresentedPts.toFixed(3)}s for ${heldMs.toFixed(0)}ms — ` +
            `${this._backwardsRefused} frame(s) refused as older than what is on screen ` +
            `(queue ${this.frameQueue.length}, head ${Number.isFinite(head) ? head.toFixed(3) + "s" : "none"}, clock ${currentTime.toFixed(3)}s)`,
        );
      }
    }
    if (bestFrame) this._backwardsRefused = 0;

    if (bestFrame && bestIndex >= 0) {
      // Remove all frames up to (but not including) the best one
      if (bestIndex > 0) {
        const removed = this.frameQueue.splice(0, bestIndex);
        for (const f of removed) {
          f.close();
        }
      }

      // Update tracking
      this.lastPresentedPts = bestFrame.timestamp / 1_000_000;
      this.currentTime = this.lastPresentedPts;
      this.framesPresented++;
      this.onFramePresented?.(this.currentTime);
      this._lastPresentAt = performance.now();

      return bestFrame;
    }

    // No frame due - just keep showing the last frame (natural hold)
    // This is how YouTube handles it - no forced repetition, just timestamp-based
    return null;
  }

  /**
   * Upload a decoded VideoFrame into the currently-bound 2D texture. Tries
   * RGBA16F for high bit-depth content and falls back to RGBA8 on GL error or
   * exception. Shared by the flat and 360° draw paths.
   */
  private uploadFrameTexture(
    gl: WebGL2RenderingContext,
    frame: RenderSource,
  ): void {
    try {
      if (this.isHighBitDepth) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA16F,
          gl.RGBA,
          gl.HALF_FLOAT,
          frame,
        );
        // Check for GL error — some VideoFrame formats don't work with RGBA16F
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          Logger.warn(TAG, `RGBA16F texImage2D failed (GL error ${err}), falling back to RGBA8`);
          this.isHighBitDepth = false; // Disable for future frames
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        }
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      }
    } catch (texError) {
      // If RGBA16F throws, fall back to standard
      Logger.warn(TAG, `texImage2D failed, retrying with RGBA8:`, texError);
      this.isHighBitDepth = false;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    }
  }

  /**
   * Draw a frame to the canvas
   */
  private drawFrame(frame: RenderSource, force: boolean = false): void {
    if (!this.gl || !this.program || !this.texture) return;
    const gl = this.gl;
    // Keep timing while ANY adaptation is still available — the bit-depth rung
    // below outlives the one-shot DPR check. Two performance.now() calls a
    // frame cost nothing next to what they are measuring.
    const canStillAdapt =
      !this._adaptDprChecked ||
      (this.isHighBitDepth && !this._bitDepthDowngraded);
    const paintStart = canStillAdapt ? performance.now() : 0;

    try {
      // Update current time. A <video> source carries its own playhead;
      // a VideoFrame carries a microsecond PTS.
      this.currentTime = isVideoElementSource(frame)
        ? frame.currentTime
        : frame.timestamp / 1_000_000;

      // Check if frame is valid (width/height > 0)
      // Attempting to draw a closed frame causes "WebGL: INVALID_OPERATION: texImage2D: can't texture a closed VideoFrame"
      // Explicitly check display dimensions which are 0 on closed frames
      // (and on a <video> that has no metadata yet).
      // The CROPPED size, so contain/cover/zoom/aspect all reason about the
      // picture rather than the padded frame it arrived in. With no crop these
      // are the frame's own dimensions.
      const cropW = this.cropRect.x1 - this.cropRect.x0;
      const cropH = this.cropRect.y1 - this.cropRect.y0;
      const contentWidth = Math.round(sourceWidth(frame) * cropW);
      const contentHeight = Math.round(sourceHeight(frame) * cropH);
      if (contentWidth === 0 || contentHeight === 0) {
        return; // Silently skip closed/invalid frames (normal at EOF)
      }

      // 360° VR fast-path: bind + upload the frame, then render it as a
      // viewed sphere instead of the flat fit/letterbox quad. Compile the VR
      // program here if it wasn't ready when 360 was first requested (e.g. the
      // `vr` attribute enabled it before the context was configured) — drawFrame
      // only runs once GL/program/texture exist, so this compile always lands,
      // and the very first (poster) frame paints in 360.
      if (this.vr360Enabled) {
        if (!this.vrProgram) this.initVRProgram();
        if (this.vrProgram && this.vrLocs) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          this.uploadFrameTexture(gl, frame);
          this.drawVRFrame(gl, frame);
          this.sampleAdaptiveDpr(paintStart);
          return;
        }
      }

      let targetScaleX: number;
      let targetScaleY: number;

      if (this.fitMode === "fill") {
        targetScaleX = this.width / contentWidth;
        targetScaleY = this.height / contentHeight;
      } else {
        let scale: number;
        const containerW = this.width;
        const containerH =
          this.fitMode === "control"
            ? Math.max(0, this.height - 72)
            : this.height;

        if (this.fitMode === "contain" || this.fitMode === "control") {
          scale = Math.min(
            containerW / contentWidth,
            containerH / contentHeight,
          );
        } else if (this.fitMode === "cover") {
          scale = Math.max(
            containerW / contentWidth,
            containerH / contentHeight,
          );
        } else if (this.fitMode === "zoom") {
          scale =
            Math.max(containerW / contentWidth, containerH / contentHeight) *
            1.25;
        } else {
          scale = Math.min(
            containerW / contentWidth,
            containerH / contentHeight,
          );
        }
        targetScaleX = scale;
        targetScaleY = scale;
      }

      this.lastTargetScaleX = targetScaleX;
      this.lastTargetScaleY = targetScaleY;

      // The scale maps CONTENT pixels to display pixels, so it only means the
      // same thing while the content size holds. A rendition switch changes it
      // (3840x2160 → 1920x1080 doubles the scale for an identical picture on
      // screen), which made the interpolation below animate from the outgoing
      // rung's scale to the incoming one — the video visibly grew or shrank
      // into place over ~30 frames, each of them a full re-draw of a 4K/8K
      // texture at a size that was simply wrong. Snap instead: there is nothing
      // to animate between two renditions of the same picture. Genuine fit-mode
      // and container changes keep their animation, since the content size is
      // unchanged across those.
      const contentChanged =
        this._scaleContentW !== contentWidth ||
        this._scaleContentH !== contentHeight;
      this._scaleContentW = contentWidth;
      this._scaleContentH = contentHeight;

      if (
        this.currentScaleX === 0 ||
        this.currentScaleY === 0 ||
        force ||
        contentChanged
      ) {
        this.currentScaleX = targetScaleX;
        this.currentScaleY = targetScaleY;
      } else {
        const factor = 0.15;
        if (Math.abs(targetScaleX - this.currentScaleX) < 0.0001)
          this.currentScaleX = targetScaleX;
        else this.currentScaleX += (targetScaleX - this.currentScaleX) * factor;

        if (Math.abs(targetScaleY - this.currentScaleY) < 0.0001)
          this.currentScaleY = targetScaleY;
        else this.currentScaleY += (targetScaleY - this.currentScaleY) * factor;
      }

      const scaledWidth = contentWidth * this.currentScaleX;
      const scaledHeight = contentHeight * this.currentScaleY;

      // How much of the frame's height the picture fills, from the TARGET
      // scale so a fit change is followed once rather than every lerp step.
      // The caption's home is measured from the picture, not the frame — see
      // subtitleBottomPadding. Only for an upright or upside-down picture:
      // at 90/270 the overlay's height runs along the frame's width.
      const rotNow = (((this.rotation ?? 0) % 360) + 360) % 360;
      const pictureFrac =
        rotNow % 180 === 0 && this.height > 0
          ? Math.min(1, (contentHeight * targetScaleY) / this.height)
          : 1;
      if (Math.abs(pictureFrac - this._pictureHeightFrac) > 0.002) {
        this._pictureHeightFrac = pictureFrac;
        this.reapplySubtitlePadding();
      }

      const x = (this.width - scaledWidth) / 2;
      const y = (this.height - scaledHeight) / 2;

      // GL Draw steps:
      gl.viewport(0, 0, this.width, this.height);
      // Smooth letterbox color transition (lerp toward target every frame for ~60fps smooth)
      const f = 0.08;
      this.letterboxColor[0] += (this.letterboxTarget[0] - this.letterboxColor[0]) * f;
      this.letterboxColor[1] += (this.letterboxTarget[1] - this.letterboxColor[1]) * f;
      this.letterboxColor[2] += (this.letterboxTarget[2] - this.letterboxColor[2]) * f;
      // Clear TRANSPARENT and let the canvas ELEMENT's own background carry the
      // letterbox colour. A clear is a rectangle: it fills the drawing buffer
      // corner to corner, and the corner cut in the shader only touches what the
      // shader draws — the video quad. So a letterboxed picture came out as a
      // rounded frame inside a square opaque slab. Chrome hides that behind the
      // clip-path on the canvas; Firefox composites the canvas as its own layer
      // and honours neither that clip nor an ancestor's overflow, so the player
      // showed square corners there (measured in Firefox 153 over geckodriver —
      // Playwright's bundled Firefox rounds them and does NOT reproduce it).
      // As the element's background the same colour is painted by the browser,
      // which means border-radius applies to it, in every engine, with no clip.
      // Clear TRANSPARENT and let the canvas element's own background carry the
      // letterbox — see syncLetterboxBackground and the rounded corners it is
      // there for. A flat tint HERE was tried to guarantee ambient reached the
      // bars in fullscreen, and it does, but flat is exactly what ambient was
      // moved off: it put the old solid band back.
      // …and SAY transparent, rather than trusting whatever was set last. The
      // ambient mirror pass below sets an opaque clear colour for its 16x16
      // buffer and never puts it back, so with ambient on the next frame
      // cleared the whole canvas to opaque black — corners included. The
      // shader's corner cut only governs what the SHADER draws, so the cut
      // pixels showed that slab instead of the element's rounded background.
      // Chrome hides it behind the canvas clip; Firefox composites the canvas
      // as its own layer and honours neither that clip nor an ancestor's
      // overflow, so the corners went square there.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.syncLetterboxBackground();
      // Ambient light goes down first; the picture is drawn over it below.
      this.drawAmbientWash(gl);
      gl.useProgram(this.program);

      // WebGL viewport needs y from bottom
      // CSS y is from top.
      const viewportY = this.height - (y + scaledHeight);
      gl.viewport(x, viewportY, scaledWidth, scaledHeight);

      // Bind texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);

      // Log frame format once to diagnose high bit-depth rendering issues
      if (
        this.isHighBitDepth &&
        !this._loggedFrameFormat &&
        !isVideoElementSource(frame)
      ) {
        this._loggedFrameFormat = true;
        Logger.info(TAG, `VideoFrame format: ${frame.format}, ${frame.codedWidth}x${frame.codedHeight}, colorSpace: ${JSON.stringify(frame.colorSpace)}`);

        // Diagnostic: check if VideoFrame actually has pixel data by drawing to 2D canvas
        try {
          const testCanvas = new OffscreenCanvas(16, 16);
          const ctx2d = testCanvas.getContext("2d")!;
          ctx2d.drawImage(frame, 0, 0, 16, 16);
          const pixels = ctx2d.getImageData(0, 0, 4, 4).data;
          const nonZero = pixels.some((v: number) => v > 0);
          Logger.info(TAG, `VideoFrame pixel test: ${nonZero ? "HAS DATA" : "ALL BLACK"} (sample: R=${pixels[0]} G=${pixels[1]} B=${pixels[2]} A=${pixels[3]})`);
        } catch (e) {
          Logger.warn(TAG, `VideoFrame pixel test failed:`, e);
        }
      }

      // Upload frame — try RGBA16F for high bit-depth, fallback to RGBA8
      this.uploadFrameTexture(gl, frame);

      gl.useProgram(this.program);
      this.applyRoundUniform(this.program);
      this.applyCropUniform(this.program);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Mirror the just-drawn frame into a 16×16 framebuffer so ambient mode
      // can read average color cheaply. Only the extra draw runs here; the
      // sync readback is deferred until MoviElement asks via readAmbientPixels().
      if (this.ambientEnabled) {
        this._renderAmbientThumbnail();
        // Reads the mirror that was just written. Rate-limited inside, and a
        // no-op unless the host asked for bar cropping.
        this.detectBars(performance.now());
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "InvalidStateError") {
        return;
      }
      Logger.error(TAG, "WebGL Draw error", error);
    }

    // Adaptive DPR — sample paint duration for the first N frames after
    // playback starts. If the device can't keep paint under ~half a frame
    // budget at 2x DPR, drop to 1x and resize. One-shot.
    this.sampleAdaptiveDpr(paintStart);
  }

  /**
   * Enable the 16×16 ambient mirror render. Cheap: ~256 fragment shader
   * invocations per drawn frame on top of the main draw. Call once when
   * ambient mode turns on; the matching `readAmbientPixels()` returns the
   * latest 16×16 RGBA buffer synchronously and effectively for free.
   */
  enableAmbientMirror(): void {
    if (this.ambientEnabled) return;
    if (!this.gl) return;
    const gl = this.gl;
    const size = CanvasRenderer.AMBIENT_SIZE;

    this.ambientTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.ambientTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    this.ambientFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ambientFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.ambientTex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      Logger.warn(TAG, `Ambient FBO incomplete (0x${status.toString(16)}); ambient mode will see no updates`);
      if (this.ambientTex) gl.deleteTexture(this.ambientTex);
      if (this.ambientFbo) gl.deleteFramebuffer(this.ambientFbo);
      this.ambientTex = null;
      this.ambientFbo = null;
      return;
    }

    this.ambientPixels = new Uint8Array(size * size * 4);
    this.ambientEnabled = true;
  }

  disableAmbientMirror(): void {
    if (!this.ambientEnabled) return;
    const gl = this.gl;
    if (gl) {
      if (this.ambientTex) gl.deleteTexture(this.ambientTex);
      if (this.ambientFbo) gl.deleteFramebuffer(this.ambientFbo);
    }
    this.ambientTex = null;
    this.ambientFbo = null;
    this.ambientPixels = null;
    this.ambientEnabled = false;
  }

  /**
   * Read the latest mirrored frame as a 16×16 RGBA buffer. Synchronous and
   * cheap (256-pixel readPixels). Returns null if ambient mirror isn't
   * enabled or no frame has been drawn yet.
   *
   * NOTE: `readPixels` is a GPU synchronisation point — it flushes the command
   * queue and waits — so its cost is set by whatever is already queued, not by
   * the 256 pixels. On a 4K 12-bit source (RGBA16F, ~66MB a frame) samples were
   * measured at up to 21ms of blocked main thread here, and MoviElement's
   * ambient loop has seen 44ms in the field.
   *
   * A PBO + fenceSync rewrite was tried to make that asynchronous and was
   * MEASURABLY WORSE, on the same machine and file: p90 11.5ms -> 23.5ms, max
   * 21.4ms -> 121.7ms, main-thread long tasks 5 -> 20 over the same 40s. In
   * Chrome the WebGL context lives in the GPU process, so clientWaitSync and
   * getBufferSubData are each an IPC round trip — the "asynchronous" path adds
   * two blocking hops where the direct read had one. Don't reintroduce it.
   */
  readAmbientPixels(): Uint8Array | null {
    if (!this.ambientEnabled || !this.gl || !this.ambientFbo || !this.ambientPixels) {
      return null;
    }
    const gl = this.gl;
    const size = CanvasRenderer.AMBIENT_SIZE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ambientFbo);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, this.ambientPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.ambientPixels;
  }

  private _renderAmbientThumbnail(): void {
    if (!this.gl || !this.program || !this.texture || !this.ambientFbo) return;
    const gl = this.gl;
    const size = CanvasRenderer.AMBIENT_SIZE;

    // Re-bind to mirror FBO and redraw the same textured quad full-viewport.
    // GPU downscales 8K → 16×16 in one pass; cost is dominated by the 256
    // fragment shader invocations, not the texture sample. program/vao/
    // texture are still bound from the main drawArrays above this call.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ambientFbo);
    gl.viewport(0, 0, size, size);
    // No corner cut on this pass. The rounding uniform measures in the main
    // canvas's pixels, and this draws the same quad into a 16x16 buffer — every
    // fragment would fall outside the rounded rect and the ambient sample would
    // come back empty. Restored right after.
    this.setRoundUniformOff();
    // …and no crop either. This mirror is what bar detection reads, and a
    // cropped mirror would show it a frame with the bars already gone: it could
    // never tell that the crop had become wrong, and never widen back.
    this.applyCropUniform(this.program, true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.applyRoundUniform(this.program);
    this.applyCropUniform(this.program);
    // Restore main viewport for any subsequent GL work this tick.
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Set subtitle overlay element (HTML element for better performance)
   */
  setSubtitleOverlay(overlay: HTMLElement | null): void {
    this.subtitleOverlay = overlay;
    Logger.debug(TAG, `Subtitle overlay ${overlay ? "set" : "cleared"}`);
  }

  /**
   * A host SubtitleRenderer (jassub, a canvas ASS engine, …) has been handed
   * the overlay as its mount point. The internal cue path has nothing to show
   * then, and with no active cue renderSubtitles() set the overlay to
   * display:none on every presented frame and wiped its children on a clear —
   * so whatever the host mounted was never visible. While owned, the overlay
   * is only kept placed over the visible video; its contents are the host's.
   */
  setHostSubtitleOwned(owned: boolean): void {
    if (this._hostSubtitleOwned === owned) {
      // Owned before the overlay arrived (the element's order): place it now
      // rather than at the next presented frame, which a paused load lacks.
      if (owned) this.layoutHostSubtitleOverlay();
      return;
    }
    this._hostSubtitleOwned = owned;
    this.activeSubtitleCue = null;
    this._lastRenderedSubtitleKey = "";
    this._lastRenderedSubtitlePlain = "";
    this._lastSubtitleLineCount = 0;
    if (this.subtitleOverlay) {
      // Either way the other side's content must go: the internal path's last
      // line before a host takes over, or the host's leftovers when it leaves.
      this.subtitleOverlay.innerHTML = "";
      if (owned) this.layoutHostSubtitleOverlay();
      else this.subtitleOverlay.style.display = "none";
    }
  }

  /** Same box the text path computes, minus the caption-specific padding and
   *  flex layout, which mean nothing to a host drawing in video coordinates. */
  private layoutHostSubtitleOverlay(): void {
    const overlay = this.subtitleOverlay;
    if (!overlay) return;
    const canvasEl =
      this.canvas instanceof HTMLCanvasElement ? this.canvas : null;
    const rect = canvasEl?.getBoundingClientRect();
    const w = rect?.width || this.width;
    const h = rect?.height || this.height;
    const rot = (((this.rotation ?? 0) % 360) + 360) % 360;
    const swapped = rot === 90 || rot === 270;
    const ovW = swapped ? h : w;
    const ovH = swapped ? w : h;
    overlay.style.position = "absolute";
    overlay.style.right = "auto";
    overlay.style.bottom = "auto";
    overlay.style.width = `${ovW}px`;
    overlay.style.height = `${ovH}px`;
    overlay.style.left = `${(w - ovW) / 2}px`;
    overlay.style.top = `${(h - ovH) / 2}px`;
    overlay.style.margin = "0";
    overlay.style.padding = "0";
    overlay.style.transformOrigin = "center center";
    overlay.style.transform = rot ? `rotate(${rot}deg)` : "none";
    overlay.style.boxSizing = "border-box";
    overlay.style.display = "block";
    overlay.style.pointerEvents = "none";
  }

  /**
   * Tag the subtitle overlay with the source format. The styled black
   * backdrop is opt-in and only painted for WebVTT cues — that's the
   * karaoke-paced format from our YouTube proxy where the box reads as
   * a stable anchor for word-by-word reveal.
   *
   * All other formats render plain (text + shadow only):
   *   - Text-based: srt / ass / ssa / ttml — traditional movie subs;
   *     a backdrop reads as noise here.
   *   - Image-based: pgs / dvd / dvb (vobsub, hdmv, dvb_subtitle) —
   *     rendered through the cue.image path, untouched by this class.
   */
  setSubtitleFormat(
    format:
      | "vtt"
      | "srt"
      | "ass"
      | "ssa"
      | "ttml"
      | "pgs"
      | "dvd"
      | "dvb"
      | string
      | null,
  ): void {
    if (!this.subtitleOverlay) return;
    this.subtitleOverlay.classList.toggle(
      "movi-subtitle-format-vtt",
      format === "vtt",
    );
  }

  /**
   * Rotate video by 90 degrees clockwise
   */
  rotate90(): number {
    this.manualRotation = (this.manualRotation + 90) % 360;
    this.rotation = (this.metadataRotation + this.manualRotation) % 360;
    Logger.debug(TAG, `Rotation: ${this.rotation}° (metadata: ${this.metadataRotation}°, manual: ${this.manualRotation}°)`);

    if (this.containerWidth > 0 && this.containerHeight > 0) {
      this.resize(this.containerWidth, this.containerHeight, true);
    }

    return this.manualRotation;
  }

  /**
   * Get manual rotation (user-applied, not metadata)
   */
  getRotation(): number {
    return this.manualRotation;
  }

  /**
   * Set manual rotation to a specific value (for save/restore in PiP)
   */
  setManualRotation(deg: number): void {
    this.manualRotation = deg % 360;
    this.rotation = (this.metadataRotation + this.manualRotation) % 360;
    if (this.containerWidth > 0 && this.containerHeight > 0) {
      this.resize(this.containerWidth, this.containerHeight, true);
    }
  }

  /**
   * Set extra bottom padding for subtitles when controls are visible
   * 0 = use default padding, >0 = use this value instead
   */
  setSubtitleControlsPadding(padding: number): void {
    this.subtitleControlsPadding = padding;
    // Apply immediately if overlay exists
    if (this.subtitleOverlay) {
      const height = this.containerHeight || 672;
      const settled = this.subtitleEffectiveBottomPadding(
        height,
        this.subtitleBottomPadding(height),
      );
      if (padding > 0) {
        this.subtitleOverlay.style.paddingBottom = `${settled}px`;
      } else {
        // containerHeight is CSS pixels; this.height is the dpr-scaled
        // backbuffer and would inflate the padding 2× on retina.
        const h = this.containerHeight || 672;
        this.subtitleOverlay.style.paddingBottom =
          `${this.subtitleBottomPadding(h)}px`;
      }
    }
  }

  /**
   * Set subtitle cues for rendering
   * If cues array is provided, it replaces the current list
   * If a single cue is provided, it's added to the list (maintaining active cues)
   */
  setSubtitleCues(cues: SubtitleCue[]): void {
    Logger.debug(TAG, `Setting subtitle cues: ${cues.length} cue(s)`);
    cues.forEach((cue, i) => {
      if (cue.image) {
        Logger.debug(
          TAG,
          `  Cue ${i}: [IMAGE] ${cue.image.width}x${cue.image.height} at (${cue.position?.x ?? "?"}, ${cue.position?.y ?? "?"}) (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
        );
      } else {
        Logger.debug(
          TAG,
          `  Cue ${i}: "${cue.text?.substring(0, 50)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
        );
      }
    });

    // If multiple cues provided, replace the list (for batch updates)
    // If single cue provided, add it to the list (for incremental updates)
    if (cues.length > 1) {
      // Replace entire list
      this.subtitleCues = [...cues];
    } else if (cues.length === 1) {
      // Add single cue to list, but remove old cues that have already ended
      const newCue = cues[0];
      // Match the offset semantics in updateActiveSubtitle so a positive
      // subtitleDelay doesn't prematurely evict cues whose display window is
      // still in the future.
      const adjustedTime = this.getCurrentPlaybackTime() - this.subtitleDelay;

      // Remove cues that have ended (with some tolerance)
      this.subtitleCues = this.subtitleCues.filter((cue) => {
        // Keep cues that haven't ended yet (with 500ms tolerance for safety)
        return adjustedTime <= cue.end + 0.5;
      });

      // Check if this cue already exists (same start time)
      const existingIndex = this.subtitleCues.findIndex(
        (cue) => Math.abs(cue.start - newCue.start) < 0.01,
      );

      if (existingIndex >= 0) {
        // Replace existing cue with same start time
        this.subtitleCues[existingIndex] = newCue;
      } else {
        // Add new cue
        this.subtitleCues.push(newCue);
      }

      // Sort by start time to ensure correct order
      this.subtitleCues.sort((a, b) => a.start - b.start);
    } else {
      // Empty array - clear all
      this.subtitleCues = [];
    }

    // Update active subtitle immediately
    this.updateActiveSubtitle();
    // Also trigger render to update display
    this.renderSubtitles();
  }

  /**
   * Set subtitle delay in seconds (VLC/mpv convention).
   * Positive value: subtitles appear later than their original timing.
   * Negative value: subtitles appear earlier.
   */
  setSubtitleDelay(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    if (seconds === this.subtitleDelay) return;
    this.subtitleDelay = seconds;
    Logger.debug(TAG, `Subtitle delay set to ${seconds.toFixed(3)}s`);
    // Re-evaluate the active cue against the new offset and repaint so the
    // user sees the change immediately even when paused.
    this.updateActiveSubtitle();
    this.renderSubtitles();
  }

  /** Get current subtitle delay in seconds. */
  getSubtitleDelay(): number {
    return this.subtitleDelay;
  }

  /**
   * Snapshot every cue currently in the cache as a plain array. Used by
   * the all-cues browser UI; we strip image cues since the browser is
   * text-only.
   */
  getAllCues(): { start: number; end: number; text: string }[] {
    const out: { start: number; end: number; text: string }[] = [];
    for (const cue of this.subtitleCues) {
      const text = cue.text;
      if (typeof text === "string" && text.length > 0) {
        out.push({ start: cue.start, end: cue.end, text });
      }
    }
    return out;
  }

  /**
   * Render image subtitle in HTML overlay
   */
  private renderImageSubtitleInOverlay(cue: SubtitleCue): void {
    if (!this.subtitleOverlay || !cue.image) {
      return;
    }

    try {
      // Use CSS-pixel dimensions of the visible canvas, not the dpr-scaled
      // backbuffer. this.width/height live in buffer space (target × dpr) and
      // sizing the overlay with those values blows it up to 2× on retina,
      // pushing the bottom-anchored flex child off-screen below the canvas.
      // Mirrors the rect-based sizing the text-subtitle path already uses.
      const canvasEl =
        this.canvas instanceof HTMLCanvasElement ? this.canvas : null;
      const rect = canvasEl?.getBoundingClientRect();
      const canvasWidth =
        rect?.width || this.containerWidth || this.width;
      const canvasHeight =
        rect?.height || this.containerHeight || this.height;

      // Scale position based on video dimensions vs subtitle dimensions
      // PGS subtitle positions are typically relative to video resolution (1920x1080, etc.)
      const subtitleVideoWidth = 1920; // Standard PGS subtitle resolution
      const subtitleVideoHeight = 1080;
      const scaleX = canvasWidth / subtitleVideoWidth;
      const scaleY = canvasHeight / subtitleVideoHeight;

      // Honour the user's font-size multiplier from the customize panel.
      // Text subs read --movi-sub-size-mult via CSS; image subs are sized
      // in JS, so we pick the same var off the host's computed style and
      // bake it into the bitmap scale so 150% means a visibly larger cue.
      let userSizeMult = 1;
      if (typeof window !== "undefined" && this.subtitleOverlay) {
        const raw = window
          .getComputedStyle(this.subtitleOverlay)
          .getPropertyValue("--movi-sub-size-mult")
          .trim();
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) userSizeMult = parsed;
      }

      // baseScale is the geometric mapping from PGS source space (1920x1080)
      // into canvas pixels — this is what positions belong in. uniformScale
      // additionally bakes in the user's font-size multiplier so the bitmap
      // grows/shrinks. Mixing the two would let sizeMult drift the cue's
      // anchor (PGS x is the LEFT edge, so scaling it up shoves the bitmap
      // right of its original centre); keep them separate.
      //
      // PGS bitmaps are authored larger than the corresponding text
      // cue would render at the same player size (BluRay subs target
      // a reading distance / TV viewing context, not the boxed-in
      // browser player). 0.85 dials the rendered bitmap down to
      // visually match the CSS-driven text-subtitle size so toggling
      // between an SRT and a PGS track doesn't make the line jump in
      // size. Only the *display* scale shrinks — positions stay on
      // baseScale, so the cue still lands where the author put it.
      const IMAGE_SUB_DISPLAY_SHRINK = 0.85;
      const baseScale = Math.min(scaleX, scaleY);
      // …with the floor the TEXT path has. A text cue is sized by CSS as
      // clamp(20px, width * 0.032, 40px), so it stops shrinking at 20px; an
      // image cue scaled straight off the canvas has no such floor and keeps
      // going. In a Picture-in-Picture window a few hundred pixels wide that is
      // a fifth of full size next to text that is still 20px — the same track,
      // one line readable and the next a smudge.
      //
      // Expressed as the same curve: what the text size would be here, over
      // what it is at the reference width. Only ever used to RAISE the scale —
      // above 1920 the geometric mapping is larger and stays in charge, so a
      // big screen looks exactly as it did.
      const textPx = Math.min(40, Math.max(20, canvasWidth * 0.032));
      const textScale = textPx / 40;
      const displayScale = Math.max(baseScale, textScale);
      const uniformScale = displayScale * userSizeMult * IMAGE_SUB_DISPLAY_SHRINK;

      // Calculate scaled dimensions preserving aspect ratio
      const scaledWidth = cue.image.width * uniformScale;
      const scaledHeight = cue.image.height * uniformScale;

      // The video content is rendered "contain"-fit inside the canvas, so on
      // an ultrawide window with a 16:9 source the video sits in a centred
      // band with pillarbox bars on the sides (and vice versa for letterbox).
      // PGS coordinates live in the 1920x1080 presentation space — i.e.
      // relative to the video band, not the canvas — so positioned cues
      // need this offset added to land where the author put them. Without
      // it, a centred-in-PGS cue gets glued to the canvas's left third on
      // ultrawide displays.
      const videoOffsetX =
        (canvasWidth - subtitleVideoWidth * baseScale) / 2;
      const videoOffsetY =
        (canvasHeight - subtitleVideoHeight * baseScale) / 2;

      const bottomPadding =
        this.subtitleBottomPadding(canvasHeight);

      // Position at bottom center (above controls), similar to text subtitles
      // For image subtitles, always position at bottom if no explicit position.
      // When an explicit PGS position is given, anchor on the cue's *centre*
      // in source space so growing the bitmap stays visually centred there.
      let x: number;
      if (cue.position?.x !== undefined) {
        const sourceCentreX =
          (cue.position.x + cue.image.width / 2) * baseScale;
        x = videoOffsetX + sourceCentreX - scaledWidth / 2;
      } else {
        x = (canvasWidth - scaledWidth) / 2;
      }
      let y: number;

      if (cue.position?.y) {
        // Use explicit Y position (anchored on source centre, see x above)
        // but ensure it doesn't go above top.
        const sourceCentreY =
          (cue.position.y + cue.image.height / 2) * baseScale;
        y = videoOffsetY + sourceCentreY - scaledHeight / 2;
        y = Math.max(0, Math.min(y, canvasHeight - scaledHeight));
      } else {
        // Default: Position at bottom with padding above controls (same as text subtitles)
        // Calculate bottom position
        const calculatedBottomY = canvasHeight - scaledHeight - bottomPadding;

        // If image + padding is larger than canvas, position at bottom edge (with minimal padding)
        if (calculatedBottomY < 0) {
          // Image is too large for canvas, position at bottom with minimal 10px padding
          y = Math.max(0, canvasHeight - scaledHeight - 10);
        } else {
          // Normal case: position with proper bottom padding
          y = calculatedBottomY;
        }

        // Final clamp to ensure it's within bounds
        y = Math.max(0, Math.min(y, canvasHeight - scaledHeight));
      }

      // Clamp X position to ensure subtitle stays within canvas bounds
      x = Math.max(0, Math.min(x, canvasWidth - scaledWidth));

      // Set overlay container size to match canvas for proper positioning
      // Override CSS defaults that might interfere
      // The overlay should cover the entire canvas area and not overflow
      // Position overlay at bottom center (above controls), same as text subtitles
      // Rotate the overlay to match the video (same approach as text captions),
      // swapping to the video's own frame dimensions for 90°/270° and centring
      // so it maps back onto the video once rotated.
      const rotImg = (((this.rotation ?? 0) % 360) + 360) % 360;
      const swappedImg = rotImg === 90 || rotImg === 270;

      // The presentation loop calls this ~60x/s, and until now every one of
      // those ticks re-encoded the bitmap, re-assigned the img's src and
      // re-asserted a padding-bottom the overlay was still easing toward. The
      // 0.3s transition therefore never landed: it was retargeted before it
      // finished, so an image cue crept up from the bottom of the frame for as
      // long as it was on screen instead of simply appearing where it belongs.
      //
      // The text path has carried this guard since the same bug bit it there
      // (see the renderKey bail below it) — the image half never got one.
      // Everything the rendered result depends on is in the key, so a resize, a
      // rotation, the controls sliding in or a size-multiplier change all still
      // re-render; only an identical repeat is skipped.
      const imgKey = [
        "img",
        cue.start.toFixed(3),
        cue.end.toFixed(3),
        Math.round(canvasWidth),
        Math.round(canvasHeight),
        Math.round(this.subtitleControlsPadding),
        userSizeMult,
        rotImg,
      ].join("|");
      if (imgKey === this._lastRenderedSubtitleKey) return;

      // The bitmap only changes with the cue, so a resize or a controls toggle
      // reuses the PNG rather than paying for toDataURL again.
      const cueKey = `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}`;
      if (cueKey !== this._lastImageCueKey || !this._lastImageDataUrl) {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = cue.image.width;
        tempCanvas.height = cue.image.height;
        const tempCtx = tempCanvas.getContext("2d");
        if (!tempCtx) {
          Logger.warn(
            TAG,
            "Failed to create temporary canvas context for image subtitle",
          );
          return;
        }
        tempCtx.drawImage(cue.image, 0, 0);
        this._lastImageDataUrl = tempCanvas.toDataURL("image/png");
        this._lastImageCueKey = cueKey;
      }
      const dataUrl = this._lastImageDataUrl;

      const ovW = swappedImg ? canvasHeight : canvasWidth;
      const ovH = swappedImg ? canvasWidth : canvasHeight;
      this.subtitleOverlay.style.position = "absolute";
      this.subtitleOverlay.style.right = "auto";
      this.subtitleOverlay.style.bottom = "auto";
      this.subtitleOverlay.style.width = `${ovW}px`;
      this.subtitleOverlay.style.height = `${ovH}px`;
      this.subtitleOverlay.style.left = `${(canvasWidth - ovW) / 2}px`;
      this.subtitleOverlay.style.top = `${(canvasHeight - ovH) / 2}px`;
      this.subtitleOverlay.style.pointerEvents = "none";
      // zIndex controlled by CSS (.movi-subtitle-overlay)
      this.subtitleOverlay.style.transformOrigin = "center center";
      this.subtitleOverlay.style.transform = rotImg ? `rotate(${rotImg}deg)` : "none";
      this.subtitleOverlay.style.display = "flex";
      this.subtitleOverlay.style.flexDirection = "column";
      this.subtitleOverlay.style.justifyContent = "flex-end";
      this.subtitleOverlay.style.alignItems = "center";
      this.subtitleOverlay.style.overflow = "hidden"; // Prevent overflow outside canvas
      // Worked out BEFORE the shorthand below resets the sides, and that order
      // is the whole point rather than tidiness. subtitleBottomPadding reads
      // getComputedStyle, which forces a style flush; sitting between the reset
      // and the real value, that flush committed padding-bottom: 0 as a
      // rendered state, and the overlay's `transition: padding-bottom 0.3s`
      // then had a start value to animate FROM. Every cue that arrived after a
      // gap rose ~50px off the bottom of the frame over a third of a second.
      // The text path has always computed its padding first, which is exactly
      // why text cues never did this.
      const bottomPaddingImg = this.subtitleBottomPadding(ovH);
      const effectivePaddingImg = this.subtitleEffectiveBottomPadding(
        ovH,
        bottomPaddingImg,
      );
      this.subtitleOverlay.style.padding = "0";
      this.subtitleOverlay.style.paddingBottom = `${effectivePaddingImg}px`;
      this.subtitleOverlay.style.textAlign = "center";
      this.subtitleOverlay.style.boxSizing = "border-box";
      this.subtitleOverlay.style.margin = "0";

      // Create or update image element (single image element - replace on each update)
      let imgElement = this.subtitleOverlay.querySelector(
        "img.movi-subtitle-image",
      ) as HTMLImageElement;

      Logger.debug(
        TAG,
        `Rendering image subtitle in overlay: ${imgElement ? "img exists" : "creating img"}, x=${x.toFixed(0)}, y=${y.toFixed(0)}, width=${(cue.image.width * scaleX).toFixed(0)}, height=${(cue.image.height * scaleY).toFixed(0)}`,
      );

      if (!imgElement) {
        imgElement = document.createElement("img");
        imgElement.className = "movi-subtitle-image";
        imgElement.style.display = "block";
        imgElement.style.position = "relative"; // Use relative to respect flexbox
        imgElement.style.margin = "0";
        imgElement.style.padding = "0";
        imgElement.style.border = "none";
        imgElement.style.outline = "none";
        this.subtitleOverlay.innerHTML = ""; // Clear any old content
        this.subtitleOverlay.appendChild(imgElement);
      }

      // Don't use absolute positioning - let flexbox handle vertical positioning
      // Flexbox justify-content: flex-end will position it at bottom, paddingBottom will create space above controls
      // For horizontal positioning: use margin or transform
      if (cue.position?.x) {
        // If explicit x position is provided, use margin to offset
        const offsetX = x - (canvasWidth - scaledWidth) / 2;
        imgElement.style.marginLeft = `${offsetX}px`;
        imgElement.style.marginRight = "0";
      } else {
        // Center horizontally
        imgElement.style.marginLeft = "auto";
        imgElement.style.marginRight = "auto";
      }

      // Always update src, dimensions and position
      // Preserve aspect ratio to prevent stretching
      imgElement.src = dataUrl;
      imgElement.style.width = `${scaledWidth}px`;
      imgElement.style.height = `${scaledHeight}px`;
      imgElement.style.maxWidth = `${ovW}px`; // Ensure image doesn't exceed the (rotated) video frame width
      imgElement.style.maxHeight = `${ovH}px`; // Ensure image doesn't exceed the (rotated) video frame height
      imgElement.style.objectFit = "contain"; // Preserve aspect ratio
      imgElement.style.display = "block";
      imgElement.style.visibility = "visible";
      imgElement.style.opacity = "1";

      // Only once it is actually on screen: a bail above (no 2D context) has to
      // be free to try again on the next tick rather than being remembered as
      // done.
      this._lastRenderedSubtitleKey = imgKey;

      Logger.debug(
        TAG,
        `Image subtitle rendered: src set, dimensions=${(cue.image.width * scaleX).toFixed(0)}x${(cue.image.height * scaleY).toFixed(0)}, position=(${x.toFixed(0)}, ${y.toFixed(0)})`,
      );
    } catch (error) {
      Logger.error(TAG, "Failed to render image subtitle in overlay", error);
      // Fallback: Render image on canvas if no overlay using BUFFER dimensions
      // Not supported in WebGL mode
      // if (!this.ctx) { ... }
    }
  }

  /**
   * Clear all subtitle cues
   */
  clearSubtitles(): void {
    this.subtitleCues = [];
    this.activeSubtitleCue = null;
    this._lastRenderedSubtitleKey = "";
    this._lastRenderedSubtitlePlain = "";
    this._lastSubtitleLineCount = 0;
    // A different track (or file) — the cached bitmap belongs to neither.
    this._lastImageCueKey = "";
    this._lastImageDataUrl = "";
    // Clear all subtitle elements from overlay if it exists
    if (this.subtitleOverlay && !this._hostSubtitleOwned) {
      this.subtitleOverlay.innerHTML = "";
    }
  }

  /**
   * Default bottom padding for the subtitle overlay, in CSS pixels. The
   * 60px floor we used to carry was a desktop-era guess at "above the
   * controls bar"; on a 250-pixel-tall embed it pinned the cue 24% up
   * the frame and made small-screen subtitles look like they were
   * floating mid-screen. Scale primarily with overlay height (≈ 8%),
   * cap at 80px on large players, and only floor at a low value so
   * tiny embeds still keep a few pixels of breathing room from the
   * very edge.
   */
  private static computeSubtitleBottomPadding(overlayHeight: number): number {
    if (!Number.isFinite(overlayHeight) || overlayHeight <= 0) return 24;
    return Math.max(Math.min(80, overlayHeight * 0.08), 24);
  }

  /**
   * How far the caption sits off the bottom of the video.
   *
   * The default above is 8% of the picture's height, clamped to 24-80px, which
   * reads well on a wide player. It does not travel: on a 9:16 reel the same 8%
   * is a much shorter distance in a much taller frame, and the caption lands on
   * whatever the page has put along the bottom.
   *
   * `--movi-sub-bottom` on the element says otherwise - a percentage of the
   * picture's height, or a plain px value. The clamp is deliberately NOT
   * applied to it: a host that names a distance has asked for that distance.
   * The overlay's CSS rule carries the same variable for the non-canvas path;
   * this is the one that matters on the canvas path, where the overlay is
   * positioned by inline style and the CSS `bottom` never applies.
   */
  /**
   * How far the viewer has carried the caption UP the picture, in pixels.
   *
   * The element writes the drag onto this same overlay as `translate: x% y%`,
   * an inline value on an element this renderer already owns the rest of the
   * inline styles of — so it is read back here rather than pushed through the
   * player, and read off the style attribute rather than the computed style,
   * which would force a layout flush on every cue.
   */
  private subtitleUserLift(overlayHeight: number): number {
    const raw = (this.subtitleOverlay as HTMLElement | null)?.style?.translate;
    if (!raw || !Number.isFinite(overlayHeight) || overlayHeight <= 0) return 0;
    const y = raw.trim().split(/\s+/)[1];
    const pct = y ? /^(-?[\d.]+)%$/.exec(y) : null;
    if (!pct) return 0;
    return (-parseFloat(pct[1]) / 100) * overlayHeight;
  }

  /**
   * The controls reserve is for the caption the bar would otherwise cover,
   * and for no other caption.
   *
   * Where the caption sits comes out as max(home, controlsPadding) once CSS
   * adds the viewer's own lift back on — so one sitting down by the bar rides
   * up with it and settles back when it hides, exactly as it always has, and
   * one carried anywhere above the bar's reach never moves for it again.
   *
   * Stated as a maximum rather than as a near/far test, because a test flips:
   * the caption would jump the moment a drag crossed the line, in the middle
   * of the gesture that crossed it.
   */
  private subtitleEffectiveBottomPadding(
    overlayHeight: number,
    bottomPadding: number,
  ): number {
    // While the caption is being carried there is no reserve at all: it goes
    // where the pointer goes, pixel for pixel. Whatever reserve it was sitting
    // on was folded into the drag when the drag began (see subtitleReservePx),
    // so nothing moves as it is picked up either — and nothing moves as it is
    // let go, because the reserve does not come back for a placed caption.
    if (this.subtitleHeld) return bottomPadding;
    const lift = this.subtitleUserLift(overlayHeight);
    return Math.max(bottomPadding, this.subtitleControlsPadding - lift);
  }

  /**
   * How much of where the caption sits right now is the controls reserve
   * rather than the caption's own place — the distance it would drop if the
   * reserve were dropped. The element folds this into the drag it is about to
   * start, which is what lets the reserve be suspended for the drag without
   * the caption lurching the height of the bar as it is picked up.
   */
  subtitleReservePx(): number {
    const overlayHeight = (this.subtitleOverlay as HTMLElement | null)?.offsetHeight ?? 0;
    if (!overlayHeight) return 0;
    const bottomPadding = this.subtitleBottomPadding(overlayHeight);
    return Math.max(
      0,
      this.subtitleEffectiveBottomPadding(overlayHeight, bottomPadding) -
        bottomPadding,
    );
  }

  private subtitleBottomPadding(overlayHeight: number): number {
    // Measured from the PICTURE, not the frame it sits in. The overlay spans
    // the whole player, so a letterboxed picture — a 2.39:1 film in a 16:9
    // player, a 16:9 video in a tall one — had its caption placed off the
    // player's bottom edge: down in the black bar, or pressed against the
    // picture's edge, and sized by a height the picture does not have. The
    // bar below the picture is added first, then the distance the picture
    // itself calls for. A picture that fills the frame (cover, fill, most
    // players) has no bar, and nothing changes for it.
    const frac = this._pictureHeightFrac;
    const pictureHeight =
      Number.isFinite(overlayHeight) && overlayHeight > 0
        ? overlayHeight * frac
        : overlayHeight;
    const below =
      Number.isFinite(overlayHeight) && overlayHeight > 0
        ? (overlayHeight - pictureHeight) / 2
        : 0;
    const raw = this.subtitleOverlay
      ? getComputedStyle(this.subtitleOverlay)
          .getPropertyValue("--movi-sub-bottom")
          .trim()
      : "";
    if (raw && Number.isFinite(overlayHeight) && overlayHeight > 0) {
      const pct = /^([\d.]+)%$/.exec(raw);
      if (pct) return below + (pictureHeight * parseFloat(pct[1])) / 100;
      const px = /^([\d.]+)px$/.exec(raw);
      if (px) return below + parseFloat(px[1]);
    }
    return below + CanvasRenderer.computeSubtitleBottomPadding(pictureHeight);
  }

  /** How much of the frame's height the picture fills (1 when it fills it or
   *  overflows it). Kept by drawFrame. */
  private _pictureHeightFrac = 1;

  /** Put the caption back on its home after the picture's size in the frame
   *  changed — a new aspect, a fit-mode change, the first frame. */
  private reapplySubtitlePadding(): void {
    const overlay = this.subtitleOverlay as HTMLElement | null;
    if (!overlay) return;
    const h = parseFloat(overlay.style.height) || this.containerHeight || 0;
    if (!(h > 0)) return;
    overlay.style.paddingBottom = `${this.subtitleEffectiveBottomPadding(
      h,
      this.subtitleBottomPadding(h),
    )}px`;
    if (this.activeSubtitleCue) this.scheduleSubtitleRerender();
  }

  /**
   * Coalesce subtitle re-render requests onto a single rAF tick. Used
   * by resize() so a window drag (which bursts ResizeObserver at
   * monitor-refresh rate) re-lays out the on-screen cue at most once
   * per frame instead of dozens of times.
   */
  private scheduleSubtitleRerender(): void {
    if (this._subtitleRerenderRafId !== null) return;
    this._subtitleRerenderRafId = requestAnimationFrame(() => {
      this._subtitleRerenderRafId = null;
      if (!this.activeSubtitleCue) return;
      this._lastRenderedSubtitleKey = "";
      this._subtitleFontCache = null;
      this.renderSubtitles();
    });
  }

  /**
   * Update active subtitle based on current time
   */
  /**
   * Hold the caption on the cue it is showing.
   *
   * For the length of a drag, and for nothing else. A caption is rewritten
   * wholesale on every karaoke word and every cue — and between cues it is
   * taken off the screen altogether — so the thing the viewer has hold of
   * keeps being replaced underneath them: the block re-centres itself on the
   * new text and slips out from under the pointer, and in a gap between cues
   * there is suddenly nothing there at all. Pinned to one cue, the render
   * below meets the same key every tick and leaves the DOM alone.
   *
   * The CUE is held, not the rendering: the overlay's box and the controls
   * reserve go on being worked out every tick, because the reserve shrinks as
   * the caption is carried up and away from the bar. Frozen along with the
   * cue, all of that shrink arrived at once when the caption was let go, and
   * dropped it the height of the bar out of the viewer's hand.
   */
  setSubtitleHeld(held: boolean): void {
    if (this.subtitleHeld === held) return;
    this.subtitleHeld = held;
    if (!held) {
      this.updateActiveSubtitle();
      this.renderSubtitles();
    }
  }

  private updateActiveSubtitle(): void {
    if (this.subtitleHeld) return;
    // Use getCurrentPlaybackTime() instead of this.currentTime to ensure accurate timing
    // this.currentTime is only updated when frames are drawn, but subtitles need real-time updates
    const currentTime = this.getCurrentPlaybackTime();
    // Apply subtitle delay by shifting the comparison time. Positive delay
    // means subs should appear later, so we match cues against an earlier
    // adjusted time. Cues retain their original PTS in subtitleCues so the
    // offset can be changed mid-playback without re-decoding.
    const adjustedTime = currentTime - this.subtitleDelay;
    const previousCue = this.activeSubtitleCue;
    this.activeSubtitleCue = null;

    // Increased tolerance for subtitle matching:
    // - Start tolerance: 100ms (show subtitle slightly early)
    // - End tolerance: 200ms (keep subtitle visible slightly longer to prevent quick disappearance)
    const startTolerance = 0.1; // 100ms
    const endTolerance = 0.2; // 200ms

    // Find the best matching subtitle (prefer exact match, then closest)
    let bestCue: SubtitleCue | null = null;
    let bestScore = Infinity;

    for (const cue of this.subtitleCues) {
      // Check if current time is within the subtitle's time range (with tolerance)
      const isInRange =
        adjustedTime >= cue.start - startTolerance &&
        adjustedTime <= cue.end + endTolerance;

      if (isInRange) {
        // Calculate a score - prefer cues that are more centered in their time range
        const cueCenter = (cue.start + cue.end) / 2;
        const distanceFromCenter = Math.abs(adjustedTime - cueCenter);
        const score = distanceFromCenter;

        // If this cue is better (closer to center), use it
        if (score < bestScore) {
          bestScore = score;
          bestCue = cue;
        }
      }
    }

    // If we found a matching cue, use it
    if (bestCue) {
      this.activeSubtitleCue = bestCue;
      if (previousCue !== bestCue) {
        if (bestCue.image) {
          Logger.debug(
            TAG,
            `Active subtitle changed at ${currentTime.toFixed(2)}s: [IMAGE] ${bestCue.image.width}x${bestCue.image.height} (${bestCue.start.toFixed(2)}s - ${bestCue.end.toFixed(2)}s)`,
          );
        } else {
          Logger.debug(
            TAG,
            `Active subtitle changed at ${currentTime.toFixed(2)}s: "${bestCue.text?.substring(0, 30)}..." (${bestCue.start.toFixed(2)}s - ${bestCue.end.toFixed(2)}s)`,
          );
        }
      }
    } else if (previousCue) {
      // If no cue matches but we had one before, check if we should keep showing it
      // Keep showing previous cue if we're still within extended tolerance
      const extendedEndTolerance = 0.3; // 300ms extended tolerance
      if (
        adjustedTime >= previousCue.start - startTolerance &&
        adjustedTime <= previousCue.end + extendedEndTolerance
      ) {
        // Keep showing previous cue a bit longer
        this.activeSubtitleCue = previousCue;
      } else {
        if (previousCue.image) {
          Logger.debug(
            TAG,
            `Subtitle cleared at ${currentTime.toFixed(2)}s (was: [IMAGE] ${previousCue.image.width}x${previousCue.image.height} at ${previousCue.start.toFixed(2)}s - ${previousCue.end.toFixed(2)}s)`,
          );
        } else {
          Logger.debug(
            TAG,
            `Subtitle cleared at ${currentTime.toFixed(2)}s (was: "${previousCue.text?.substring(0, 30)}..." at ${previousCue.start.toFixed(2)}s - ${previousCue.end.toFixed(2)}s)`,
          );
        }
      }
    }
  }

  /**
   * Render active subtitle in HTML overlay (preferred) or on canvas (fallback)
   * Note: updateActiveSubtitle() should be called before this method
   */
  private renderSubtitles(): void {
    // Get actual display dimensions (not buffer dimensions) for overlay
    // If rotated 90/270, the buffer dimensions (this.width/height) are swapped relative to the screen
    // Subtitles overlaid via HTML should match the SCREEN/CONTAINER orientation
    const isRotated90 = this.rotation % 180 !== 0;
    const displayWidth = isRotated90 ? this.height : this.width;
    const displayHeight = isRotated90 ? this.width : this.height;

    // Canvas fallback uses the Internal Buffer dimensions (rotated)
    // const bufferWidth = this.width;
    // const bufferHeight = this.height;

    if (this._hostSubtitleOwned) {
      // Cues pushed by the prefetch path (a subtitle delay, the cue browser)
      // still land in subtitleCues; drawing them would double every line.
      this.layoutHostSubtitleOverlay();
      return;
    }

    if (!this.activeSubtitleCue) {
      // Clear overlay if no active cue
      if (this.subtitleOverlay) {
        if (this._lastRenderedSubtitleKey !== "") {
          this.subtitleOverlay.textContent = "";
          this.subtitleOverlay.innerHTML = ""; // Clear any image elements too
          this._lastRenderedSubtitleKey = "";
          this._lastRenderedSubtitlePlain = "";
          this._lastSubtitleLineCount = 0;
        }
        this.subtitleOverlay.style.display = "none";
      }
      return;
    }

    const cue = this.activeSubtitleCue;

    // Image subtitles: Try HTML overlay first, fallback to canvas
    if (cue.image) {
      if (this.subtitleOverlay) {
        // Render image subtitle in HTML overlay using DISPLAY dimensions
        this.renderImageSubtitleInOverlay(cue);
        return;
      }

      // Fallback: Render image on canvas if no overlay using BUFFER dimensions
      // WebGL 2 does not support drawImage 2D fallback
      return;
    }

    // Text subtitles: Use HTML overlay if available
    if (this.subtitleOverlay) {
      if (!cue.text) {
        this.subtitleOverlay.textContent = "";
        this.subtitleOverlay.style.display = "none";
        return;
      }

      // Size the overlay to the visible canvas rect (CSS pixels), not the
      // internal buffer dimensions. For 4K/8K content the buffer is much
      // larger than the rendered area, and pinning the overlay to buffer
      // pixels parks the subtitle thousands of pixels below the viewport
      // (where the host's overflow:hidden swallows it).
      const canvasEl =
        this.canvas instanceof HTMLCanvasElement ? this.canvas : null;
      const rect = canvasEl?.getBoundingClientRect();
      const overlayW = rect?.width || displayWidth;
      const overlayH = rect?.height || displayHeight;
      // Rotate the caption overlay to ride the video: swap to the video's own
      // frame box for 90°/270° and centre it so, once rotated around its centre,
      // it lands back over the video (see resize() for the same approach). This
      // render path runs ~60×/s and previously forced transform:none, undoing
      // the rotation set on rotate — so the rotation has to be re-applied here.
      const rotTxt = (((this.rotation ?? 0) % 360) + 360) % 360;
      const swappedTxt = rotTxt === 90 || rotTxt === 270;
      const ovTxtW = swappedTxt ? overlayH : overlayW;
      const ovTxtH = swappedTxt ? overlayW : overlayH;
      const bottomPadding =
        this.subtitleBottomPadding(ovTxtH);

      this.subtitleOverlay.style.position = "absolute";
      this.subtitleOverlay.style.right = "auto";
      this.subtitleOverlay.style.bottom = "auto";
      this.subtitleOverlay.style.width = `${ovTxtW}px`;
      this.subtitleOverlay.style.height = `${ovTxtH}px`;
      this.subtitleOverlay.style.left = `${(overlayW - ovTxtW) / 2}px`;
      this.subtitleOverlay.style.top = `${(overlayH - ovTxtH) / 2}px`;
      this.subtitleOverlay.style.margin = "0";
      this.subtitleOverlay.style.padding = "0";
      const effectivePad = this.subtitleEffectiveBottomPadding(
        ovTxtH,
        bottomPadding,
      );
      this.subtitleOverlay.style.paddingBottom = `${effectivePad}px`;
      this.subtitleOverlay.style.transformOrigin = "center center";
      this.subtitleOverlay.style.transform = rotTxt ? `rotate(${rotTxt}deg)` : "none";
      this.subtitleOverlay.style.boxSizing = "border-box";
      this.subtitleOverlay.style.display = "flex";
      this.subtitleOverlay.style.flexDirection = "column";
      this.subtitleOverlay.style.justifyContent = "flex-end";
      // Block stays horizontally centred in the player; text inside the
      // line block flows left → right so the karaoke type-out reads
      // naturally. Existing words don't re-animate (see word-static
      // class) so the gentle re-center as a new word appends is barely
      // perceptible.
      this.subtitleOverlay.style.alignItems = "center";
      this.subtitleOverlay.style.textAlign = "left";
      this.subtitleOverlay.style.pointerEvents = "none";
      // zIndex controlled by CSS (.movi-subtitle-overlay)

      // Skip re-rendering if the same cue text is already on screen — the
      // presentation loop calls renderSubtitles() ~60×/sec, and overwriting
      // innerHTML each tick recreates DOM nodes (restarting the
      // movi-subtitle-fade keyframes in a tight loop). Result: subtitle
      // never finishes fading in during playback and only becomes visible
      // when the loop pauses.
      const renderKey = `${cue.start.toFixed(3)}|${cue.text}`;
      if (renderKey === this._lastRenderedSubtitleKey) {
        return;
      }
      this._lastRenderedSubtitleKey = renderKey;

      // Karaoke cues from the proxy embed the FULL final sentence after
      // a `⟨⟨GHOST⟩⟩` delimiter. Only the *visible* portion goes into
      // the DOM — the full sentence's width is measured offscreen via a
      // 2D canvas and applied as `min-width` on the line. This anchors
      // the box at full-sentence width from cue #1 without putting any
      // ghost text into the DOM where it could leak through.
      const KARAOKE_DELIM = KARAOKE_GHOST_DELIM;
      const delimIdx = cue.text.indexOf(KARAOKE_DELIM);
      const visibleText =
        delimIdx >= 0 ? cue.text.slice(0, delimIdx) : cue.text;
      const renderText =
        delimIdx >= 0
          ? cue.text.slice(delimIdx + KARAOKE_DELIM.length)
          : cue.text;

      // Resolve the line's actual font (clamp() depends on viewport)
      // by reading computed style off a temporary probe in the shadow
      // root. Cached per-render-pass via `_subtitleFontCache`.
      const fontSig = (() => {
        const cached = this._subtitleFontCache;
        if (cached && cached.viewport === window.innerWidth) {
          return cached.font;
        }
        const probe = document.createElement("div");
        probe.className = "movi-subtitle-line";
        probe.style.position = "absolute";
        probe.style.left = "-99999px";
        probe.style.top = "-99999px";
        probe.style.visibility = "hidden";
        probe.textContent = "M";
        this.subtitleOverlay.parentNode?.appendChild(probe);
        const cs = window.getComputedStyle(probe);
        const f = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        probe.remove();
        this._subtitleFontCache = {
          viewport: window.innerWidth,
          font: f,
        };
        return f;
      })();

      // Walk forward through the cue list to find the longest cumulative
      // extension of the current cue's text — covers normal WebVTT
      // karaoke streams (no GHOST delimiter) where each subsequent cue
      // simply adds more words. Without this lookahead the box would
      // grow with every word reveal; with it, the box is sized to the
      // final sentence from cue #1.
      const stripGhost = (t: string) => {
        const idx = t.indexOf(KARAOKE_DELIM);
        return idx >= 0 ? t.slice(0, idx) : t;
      };
      let ultimateText = renderText;
      const activeIndex = this.subtitleCues.indexOf(this.activeSubtitleCue);
      if (activeIndex >= 0) {
        let chainTail = visibleText;
        for (let i = activeIndex + 1; i < this.subtitleCues.length; i++) {
          const next = this.subtitleCues[i];
          if (!next?.text) break;
          const nextVisible = stripGhost(next.text);
          if (
            nextVisible.length > chainTail.length &&
            nextVisible.startsWith(chainTail)
          ) {
            chainTail = nextVisible;
            // Prefer the GHOST-resolved variant if the next cue carries
            // its own GHOST tail (longer than the visible portion).
            ultimateText =
              next.text.length > nextVisible.length ? next.text : nextVisible;
          } else if (!nextVisible.startsWith(chainTail)) {
            break; // chain ended — different sentence starts here
          }
        }
      }

      // Measure the FULL final sentence's width once (per ultimateText),
      // so the line can be sized to it from the very first cue. Strip
      // any HTML formatting tags first — they don't affect width
      // meaningfully for sans-serif at this size.
      // For multi-line SRT cues we take the WIDEST line, not the
      // joined-line width. Joining "You've turned this house\ninto a
      // tomb of her memorial." into one line measures ~600px and
      // calibrates the anchor padding-left for that imaginary single
      // line — but the actual block hugs the widest *real* line
      // (~330px), so the block ends up left-shifted in the player.
      // Per-line max gives the correct anchor offset; karaoke cues
      // (typically no \n) collapse to the same single measurement.
      const plainFull = stripGhost(ultimateText).replace(/<[^>]*>/g, "");
      const measureCanvas = (this._subtitleMeasureCanvas ||=
        document.createElement("canvas"));
      const mctx = measureCanvas.getContext("2d");
      let fullWidth = 0;
      if (mctx) {
        mctx.font = fontSig;
        for (const ln of plainFull.split("\n")) {
          const w = Math.ceil(mctx.measureText(ln).width);
          if (w > fullWidth) fullWidth = w;
        }
      }

      // Update HTML overlay with subtitle text
      // Split full (renderable) text into lines and create HTML
      const lines = visibleText.split("\n");
      // Word index across all lines of this cue; drives staggered
      // typing-style reveal via per-word animation-delay.
      let wordIdx = 0;
      // Word-count split point: the first N tokens of the new cue match
      // what's already on screen (karaoke cumulative growth). Render those
      // statically and animate only the suffix — otherwise the whole line
      // re-fades on every word and looks flickery.
      const previousPlain = this._lastRenderedSubtitlePlain;
      const isCumulativeGrowth =
        !!previousPlain &&
        visibleText.startsWith(previousPlain) &&
        visibleText.length > previousPlain.length;
      const staticWordCount = isCumulativeGrowth
        ? previousPlain.split(/\s+/).filter(Boolean).length
        : 0;
      this._lastRenderedSubtitlePlain = visibleText;
      let cumulativeWordCount = 0;
      const linesHtml = lines
        .map((line) => {
          // Allow safe HTML formatting tags (<i>, <b>, <u>, <font>) while escaping other content
          // First, protect safe formatting tags by replacing them with placeholders
          const placeholders: string[] = [];
          // YouTube's WebVTT for auto-captions often arrives with text
          // chars already entity-encoded (e.g. ">>" written as the
          // literal "&gt;&gt;" speaker-change indicator). Without
          // decoding first, our own escape pass below would double-
          // encode the leading "&" to "&amp;", and the browser would
          // render the entity name as text instead of the character.
          let textWithPlaceholders = line
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&"); // amp last so the rest don't double-decode

          // Protect <i> tags
          textWithPlaceholders = textWithPlaceholders.replace(
            /<(\/?)i>/gi,
            (matched) => {
              const id = placeholders.length;
              placeholders.push(matched);
              return `__PLACEHOLDER_${id}__`;
            },
          );

          // Protect <b> tags
          textWithPlaceholders = textWithPlaceholders.replace(
            /<(\/?)b>/gi,
            (match) => {
              const id = placeholders.length;
              placeholders.push(match);
              return `__PLACEHOLDER_${id}__`;
            },
          );

          // Protect <u> tags
          textWithPlaceholders = textWithPlaceholders.replace(
            /<(\/?)u>/gi,
            (match) => {
              const id = placeholders.length;
              placeholders.push(match);
              return `__PLACEHOLDER_${id}__`;
            },
          );

          // Protect <font color="..."> tags
          textWithPlaceholders = textWithPlaceholders.replace(
            /<font\s+color=["']?([^"']+)["']?>/gi,
            (_match, color) => {
              const id = placeholders.length;
              placeholders.push(`<font color="${color}">`);
              return `__PLACEHOLDER_${id}__`;
            },
          );

          // Protect </font> tags
          textWithPlaceholders = textWithPlaceholders.replace(
            /<\/font>/gi,
            () => {
              const id = placeholders.length;
              placeholders.push("</font>");
              return `__PLACEHOLDER_${id}__`;
            },
          );

          // Now escape all remaining HTML
          let escaped = textWithPlaceholders
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

          // Restore protected formatting tags
          placeholders.forEach((placeholder, index) => {
            escaped = escaped.replace(`__PLACEHOLDER_${index}__`, placeholder);
          });

          // Tokenize on whitespace. YouTube auto-CC sprinkles formatting
          // tags (`<i>`, `<b>`, `<font>`) around words; after escaping
          // these survive in some tokens. Tokens that contain ONLY tags
          // (no real text) shouldn't get their own `<span>` — that would
          // render an empty inline-block which still triggers the
          // surrounding inter-element whitespace, producing visible gaps
          // between adjacent words. We fold tag-only tokens into the
          // adjacent real-word token so the styling is preserved without
          // creating an empty span between words.
          const rawTokens = escaped.split(/(\s+)/).filter(Boolean);
          const isWhitespace = (t: string) => /^\s+$/.test(t);
          const isTagOnly = (t: string) =>
            !!t && !t.replace(/<[^>]*>/g, "").trim();

          // Forward-merge orphan opening tags into the next real word.
          // Walk the tokens once, accumulate any tag-only token seen,
          // attach it as a prefix to the next real word.
          type Tok = { kind: "word" | "ws"; text: string };
          const merged: Tok[] = [];
          let pendingPrefix = "";
          for (const t of rawTokens) {
            if (isWhitespace(t)) {
              if (pendingPrefix) {
                // Whitespace between pending opening-tag glob and the
                // next word — drop it; the tag should hug the word it
                // styles, not introduce its own gap.
                continue;
              }
              merged.push({ kind: "ws", text: t });
              continue;
            }
            if (isTagOnly(t)) {
              pendingPrefix += t;
              continue;
            }
            merged.push({ kind: "word", text: pendingPrefix + t });
            pendingPrefix = "";
          }
          // Trailing closing tags glue onto the last word so styling
          // wraps correctly.
          if (pendingPrefix && merged.length) {
            const last = merged[merged.length - 1];
            if (last.kind === "word") last.text = last.text + pendingPrefix;
          }

          // Split tokens into 2 inline groups: STATIC (already on screen
          // from the previous cue) and NEW (the diff this cue introduces).
          // No ghost span — the line's width is locked via `min-width`
          // computed from a canvas measurement of the full sentence, so
          // there is *no* trailing text in the DOM that could leak out.
          const staticParts: string[] = [];
          const newParts: string[] = [];
          for (const tok of merged) {
            const groupForCount = (count: number) =>
              count < staticWordCount ? staticParts : newParts;
            if (tok.kind === "ws") {
              const target = groupForCount(cumulativeWordCount);
              if (
                target === staticParts &&
                staticParts.length === 0 &&
                cumulativeWordCount === 0
              ) {
                continue;
              }
              target.push(tok.text);
              continue;
            }
            const target = groupForCount(cumulativeWordCount);
            if (
              target === newParts &&
              newParts.length === 0 &&
              staticParts.length > 0
            ) {
              const lastStatic = staticParts[staticParts.length - 1];
              if (!/\s$/.test(lastStatic)) staticParts.push(" ");
            }
            target.push(tok.text);
            cumulativeWordCount += 1;
          }

          wordIdx += 1;

          const staticHtml = staticParts.join("").replace(/\s+$/, " ");
          const newHtml = newParts.join("");

          // The min-width anchor lives on the outer .movi-subtitle-block
          // wrapper now, so individual lines just hug their content (and
          // expand to the wrapper's width because they're block-level).
          const lineParts: string[] = [
            `<div class="movi-subtitle-line" part="subtitle">`,
          ];
          if (staticHtml)
            lineParts.push(
              `<span class="movi-subtitle-static">${staticHtml}</span>`,
            );
          if (newHtml)
            lineParts.push(
              `<span class="movi-subtitle-new">${newHtml}</span>`,
            );
          lineParts.push(`</div>`);
          return lineParts.join("");
        })
        .join("");

      // Layout:
      //   .anchor  — full-width container.
      //              When the full sentence FITS in the player's usable
      //              width (≤ 92% of overlay), we left-anchor it via
      //              padding-left so karaoke types in from a stable
      //              left edge. When the sentence is WIDER than the
      //              player (large user font, narrow embed), we fall
      //              back to text-align:center so the block stays
      //              centred and doesn't clip the right edge.
      //   .block   — inline-block backdrop (single rounded rectangle)
      //              that hugs the widest visible line.
      //   .line    — plain text row, no own background.
      const overlayPxW = parseFloat(this.subtitleOverlay.style.width) || 0;
      const usableW = overlayPxW * 0.92; // matches .movi-subtitle-block max-width
      const fitsInPlayer =
        overlayPxW > 0 && fullWidth > 0 && fullWidth <= usableW;
      const leftPad = fitsInPlayer
        ? Math.max(0, Math.floor((overlayPxW - fullWidth) / 2))
        : 0;
      const anchorStyle = fitsInPlayer
        ? leftPad > 0
          ? ` style="padding-left:${leftPad}px"`
          : ""
        : ` style="text-align:center"`;
      this.subtitleOverlay.innerHTML =
        `<div class="movi-subtitle-anchor"${anchorStyle}>` +
        `<div class="movi-subtitle-block">${linesHtml}</div>` +
        `</div>`;

      // A karaoke cue that just wrapped onto another line has pushed whatever
      // was showing upward. Left alone that is a jump; sliding the block up
      // from where it sat a moment ago turns it into the scroll YouTube's
      // rolling captions do. Only on the render where the count actually grew —
      // the innerHTML above is rebuilt on every word, so an unconditional
      // animation would re-run on each karaoke tick — and only while the same
      // sentence is growing, so a brand-new cue simply appears.
      const lineCountGrew =
        isCumulativeGrowth && lines.length > this._lastSubtitleLineCount;
      this._lastSubtitleLineCount = lines.length;
      if (lineCountGrew) {
        const blockEl = this.subtitleOverlay.querySelector(
          ".movi-subtitle-block",
        ) as HTMLElement | null;
        // Measure rather than assume a line box: font size, the user's size
        // multiplier and the per-line padding all feed into it.
        const firstLine = blockEl?.firstElementChild as HTMLElement | null;
        const advance = firstLine?.offsetHeight ?? 0;
        if (blockEl && advance > 0) {
          blockEl.style.setProperty("--movi-sub-adv", `${advance}px`);
          blockEl.classList.add("movi-subtitle-advance");
        }
      }

      return;
    }

    // Fallback to canvas rendering for text if no overlay element
    // Not supported in WebGL mode without texture atlas or overlay
    // The preferred method is HTML overlay managed above
    return;
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate: number): void {
    const currentTime = this.getCurrentPlaybackTime();
    this.playbackRate = Math.max(0.25, Math.min(4, rate));

    // Always update presentation anchors when playback rate changes
    // This ensures video timing is recalculated with the new rate
    if (this.presentationStartTime > 0) {
      this.presentationStartTime = performance.now();
      this.presentationStartPts = currentTime;
    }

    // Mark as not synced so we can re-sync to audio with new rate — and say
    // that this one was asked for, so the re-sync actually re-anchors instead
    // of accepting whatever offset the rate change introduced.
    this.syncedToAudio = false;
    this.reanchorRequested = true;
  }

  /**
   * The audio pipeline was rebuilt underneath a picture that never stopped —
   * the rate-change rewind does exactly this. The sound now starts from a media
   * time the video's anchor knows nothing about, so re-anchor the picture on it
   * rather than leaving the two a fixed distance apart forever.
   */
  requestAudioReanchor(): void {
    this.syncedToAudio = false;
    this.reanchorRequested = true;
  }

  /**
   * Get current time
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Check if frames are queued
   */
  hasQueuedFrames(): boolean {
    return this.frameQueue.length > 0;
  }

  /**
   * Whether the last cadence window was the HOST PAGE starving rAF rather than
   * the pipeline falling short — see sampleRafCadence.
   */
  isHostContended(): boolean {
    return this._hostContended;
  }

  /**
   * Media time (s) of the frame on screen, or -1 when nothing has been shown
   * since the last seek / queue clear.
   */
  getLastPresentedTime(): number {
    return this.lastPresentedPts;
  }

  /**
   * Get frame queue size
   */
  getQueueSize(): number {
    return this.frameQueue.length;
  }

  /**
   * Timestamp (seconds) of the oldest frame still queued for presentation,
   * or -1 when the queue is empty. Used at EOF to tell whether the residual
   * frames are an unpresentable tail (PTS past the audio playout head, which
   * caps the clock) vs. frames that are still genuinely due.
   */
  getHeadFrameTime(): number {
    if (this.frameQueue.length === 0) return -1;
    return this.frameQueue[0].timestamp / 1_000_000;
  }

  /**
   * Get video rendering stats for nerd stats overlay
   */
  getStats(): { framesPresented: number; frameQueueSize: number; colorSpace: string; resolution: string; syncedToAudio: boolean } {
    return {
      framesPresented: this.framesPresented,
      frameQueueSize: this.frameQueue.length,
      colorSpace: this.colorSpace,
      resolution: this.width > 0 ? `${this.width}x${this.height}` : "N/A",
      syncedToAudio: this.syncedToAudio,
    };
  }

  /**
   * Drop frames whose pts is more than `toleranceSec` behind `targetTimeSec`.
   * Used on resume from pause to discard frames that became stale while the
   * audio clock advanced (e.g. mid-decode-warmup when the user fullscreens or
   * toggles tracks, causing the queue to retain pre-resume frames).
   * Returns the number of frames dropped.
   */
  dropStaleFrames(targetTimeSec: number, toleranceSec: number = 0.2): number {
    let dropped = 0;
    while (this.frameQueue.length > 0) {
      const frame = this.frameQueue[0];
      const frameTime = frame.timestamp / 1_000_000;
      if (frameTime < targetTimeSec - toleranceSec) {
        frame.close();
        this.frameQueue.shift();
        dropped++;
        this.framesDropped++;
      } else {
        break;
      }
    }
    if (dropped > 0) {
      // Reset presentation anchors so the next surviving frame starts cleanly
      // against the new clock position.
      this.presentationStartTime = 0;
      this.presentationStartPts = 0;
      this.lastPresentedPts = -1;
      this.syncedToAudio = false;
      Logger.debug(
        TAG,
        `Dropped ${dropped} stale frames before ${targetTimeSec.toFixed(3)}s (tolerance ${toleranceSec.toFixed(2)}s)`,
      );
    }
    return dropped;
  }

  /**
   * Clear frame queue (useful for seek operations)
   * Resets all presentation timing to prevent stuttering after seek
   */
  /** Top-left, top-right, bottom-right, bottom-left, in CSS pixels. */
  private cornerRadiiCss: [number, number, number, number] = [0, 0, 0, 0];
  private roundLocs = new Map<WebGLProgram, WebGLUniformLocation | null>();
  private radiiLocs = new Map<WebGLProgram, WebGLUniformLocation | null>();

  /**
   * Corner radius (CSS pixels) for the picture itself.
   *
   * Firefox composites the canvas as its own layer and ignores border-radius
   * and clip-path on it until that layer is rebuilt, so a rounded page frame
   * ended up with square video inside it. Pixels the shader declines to draw
   * are transparent whatever the compositor thinks, so this holds everywhere.
   * 0 turns it off.
   *
   * One number rounds all four corners; four (top-left, top-right,
   * bottom-right, bottom-left — CSS order) round each on its own. A host
   * that rounds only the top of the picture, where it sits on a caption bar,
   * used to get all four corners cut to the first radius.
   */
  setCornerRadius(cssPx: number | number[]): void {
    const src = Array.isArray(cssPx) ? cssPx : [cssPx, cssPx, cssPx, cssPx];
    const r = [0, 1, 2, 3].map((i) => Math.max(0, src[i] || 0)) as [
      number, number, number, number,
    ];
    if (r.every((v, i) => v === this.cornerRadiiCss[i])) return;
    this.cornerRadiiCss = r;
    // A paused player never draws again on its own; repaint so the change shows.
    // (Same retained frame the VR camera nudges and resizes repaint from.)
    if (this.lastRenderedFrame) {
      try {
        this.drawFrame(this.lastRenderedFrame, true);
      } catch {
        /* the next real frame will carry it */
      }
    }
  }

  /**
   * Frames put on screen since the queue was last cleared — a seek, or a
   * rendition swap. 0 means nothing from the new pipeline has been painted yet,
   * which is what "the picture has actually changed over" means to a caller
   * that wants to hold a loading indicator until it has.
   */
  presentedSinceClear(): number {
    return this.framesPresented;
  }

  /** Push the letterbox colour onto the canvas ELEMENT, so the browser paints
   *  the bars and rounds them with the element's own corner. Written only when
   *  it changes — the colour lerps every frame and most frames land on the same
   *  8-bit triplet. */
  private syncLetterboxBackground(): void {
    const el = this.canvas as HTMLCanvasElement | null;
    if (!el || !el.style) return;
    const rgb = `rgb(${Math.round(this.letterboxColor[0])}, ${Math.round(
      this.letterboxColor[1],
    )}, ${Math.round(this.letterboxColor[2])})`;
    if (this._letterboxBgCss === rgb) return;
    this._letterboxBgCss = rgb;
    el.style.backgroundColor = rgb;
  }
  private _letterboxBgCss = "";

  /** Per-corner radii in DRAWING-BUFFER pixels, which is what the shader
   *  measures in. */
  private cornerRadiiBufferPx(): [number, number, number, number] {
    if (!this.canvas || this.cornerRadiiCss.every((v) => !v)) return [0, 0, 0, 0];
    const cssW =
      (this.canvas as HTMLCanvasElement).clientWidth || this.canvas.width;
    const scale = cssW > 0 ? this.canvas.width / cssW : 1;
    return this.cornerRadiiCss.map((v) => v * scale) as [number, number, number, number];
  }

  /** The largest of them: the shader's on/off switch (u_round.x). */
  private cornerRadiusBufferPx(): number {
    return Math.max(...this.cornerRadiiBufferPx());
  }

  // ── Bar cropping ────────────────────────────────────────
  /** On only when the host asks for it. Off, nothing here runs and the crop
   *  stays the whole frame. */
  private barCropEnabled = false;
  private barCropOwnsMirror = false;
  /** What the last few checks agreed on, and since when. */
  private barCropCandidate: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } | null = null;
  private barCropStableSince = 0;
  private barCropLastCheck = 0;
  private onCropChange:
    | ((crop: {
        top: number;
        bottom: number;
        left: number;
        right: number;
      }) => void)
    | null = null;

  /** How dark a row has to be to count as bar, and how much brighter the row
   *  just inside it must be for that edge to be a real one. */
  private static readonly BAR_DARK = 18;
  private static readonly BAR_EDGE = 34;
  /** What a REAL bar reads. Black bars come out of a decoder at essentially
   *  zero; BAR_DARK is deliberately looser than that so compression noise and
   *  banding still count as bar. The gap between the two is the ambiguous
   *  band — see the walk-back in detectBars. */
  private static readonly BAR_BLACK = 6;
  /** A bar this thick is not a bar. Nothing legitimate takes a quarter of the
   *  frame off each end. */
  private static readonly BAR_MAX = 0.25;
  /** How long the same answer has to hold before it is acted on. A fade to
   *  black is a dark frame for a moment; a letterbox is dark for the film. */
  private static readonly BAR_SETTLE_MS = 1200;
  private static readonly BAR_CHECK_MS = 250;

  /**
   * Crop the black bars that are part of the PICTURE.
   *
   * A 2.39:1 film delivered in a 16:9 frame carries its bars as pixels, so
   * "fill" and "zoom" scale the padding along with the image and the viewer
   * ends up with the same letterbox, larger. Cropping is done in the shader —
   * the sampled region narrows, nothing is decoded twice — and the fit maths
   * read the cropped size, which is what makes those modes mean anything.
   */
  setBarCropEnabled(
    on: boolean,
    onChange?: (crop: {
      top: number;
      bottom: number;
      left: number;
      right: number;
    }) => void,
  ): void {
    if (onChange !== undefined) this.onCropChange = onChange;
    if (on === this.barCropEnabled) return;
    this.barCropEnabled = on;
    if (on) {
      // Detection reads the ambient mirror. If ambient is not using it, this
      // turns it on and remembers that it was ours to turn off.
      if (!this.ambientEnabled) {
        this.enableAmbientMirror();
        this.barCropOwnsMirror = this.ambientEnabled;
      }
      this.barCropCandidate = null;
      this.barCropStableSince = 0;
      this.barCropLastCheck = 0;
    } else {
      if (this.barCropOwnsMirror) {
        this.disableAmbientMirror();
        this.barCropOwnsMirror = false;
      }
      this.setCropRect(0, 0, 0, 0);
    }
  }

  /** The crop in force, as the fraction taken off each edge. */
  getBarCrop(): { top: number; bottom: number; left: number; right: number } {
    return {
      top: this.cropRect.y0,
      bottom: 1 - this.cropRect.y1,
      left: this.cropRect.x0,
      right: 1 - this.cropRect.x1,
    };
  }

  private setCropRect(
    top: number,
    bottom: number,
    left: number,
    right: number,
  ): void {
    const y0 = Math.max(0, Math.min(0.45, top));
    const y1 = 1 - Math.max(0, Math.min(0.45, bottom));
    const x0 = Math.max(0, Math.min(0.45, left));
    const x1 = 1 - Math.max(0, Math.min(0.45, right));
    if (y1 - y0 < 0.3 || x1 - x0 < 0.3) return; // never leave a sliver
    if (
      this.cropRect.y0 === y0 &&
      this.cropRect.y1 === y1 &&
      this.cropRect.x0 === x0 &&
      this.cropRect.x1 === x1
    ) {
      return;
    }
    this.cropRect.y0 = y0;
    this.cropRect.y1 = y1;
    this.cropRect.x0 = x0;
    this.cropRect.x1 = x1;
    // The fit maths run off the cropped size, and they only run on a draw —
    // so a still frame would keep the old geometry until something moved.
    if (this.lastRenderedFrame) this.drawFrame(this.lastRenderedFrame, true);
    Logger.info(
      TAG,
      `Bar crop: top=${(y0 * 100).toFixed(1)}% bottom=${((1 - y1) * 100).toFixed(1)}% ` +
        `left=${(x0 * 100).toFixed(1)}% right=${((1 - x1) * 100).toFixed(1)}%`,
    );
    try {
      this.onCropChange?.(this.getBarCrop());
    } catch (e) {
      Logger.warn(TAG, "crop change handler threw", e);
    }
  }

  /**
   * Look for letterbox bars in the mirrored frame.
   *
   * Cheap by construction: the mirror is already drawn for ambient, and this
   * reads it a few times a second. Everything expensive about the idea is in
   * being SURE — a fade to black, a night scene and a title card are all dark
   * frames, and cropping one of them would eat the picture.
   */
  private detectBars(now: number): void {
    if (!this.barCropEnabled) return;
    if (now - this.barCropLastCheck < CanvasRenderer.BAR_CHECK_MS) return;
    this.barCropLastCheck = now;
    const px = this.readAmbientPixels();
    if (!px) return;
    const size = CanvasRenderer.AMBIENT_SIZE;

    // readPixels is bottom-up and the quad maps the texture's first row to the
    // TOP of the image, so the image's top rows land at the END of the buffer.
    const lum = (x: number, y: number) => {
      const i = (y * size + x) * 4;
      return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    };
    // Eight samples across a line is plenty to know whether it is black, and
    // stepping in from the extreme edge skips a scaler's ringing.
    const rowMax = (y: number) => {
      let m = 0;
      for (let i = 0; i < 8; i++) {
        m = Math.max(m, lum(Math.round(((i + 0.5) / 8) * (size - 1)), y));
      }
      return m;
    };
    const colMax = (x: number) => {
      let m = 0;
      for (let i = 0; i < 8; i++) {
        m = Math.max(m, lum(x, Math.round(((i + 0.5) / 8) * (size - 1))));
      }
      return m;
    };

    const limit = Math.floor(size * CanvasRenderer.BAR_MAX);
    // Rows are read from the far end for the image's top — readPixels is
    // bottom-up. Columns need no such flip.
    let top = 0;
    while (top < limit && rowMax(size - 1 - top) <= CanvasRenderer.BAR_DARK) top++;
    let bottom = 0;
    while (bottom < limit && rowMax(bottom) <= CanvasRenderer.BAR_DARK) bottom++;
    let left = 0;
    while (left < limit && colMax(left) <= CanvasRenderer.BAR_DARK) left++;
    let right = 0;
    while (right < limit && colMax(size - 1 - right) <= CanvasRenderer.BAR_DARK) {
      right++;
    }

    // A real bar ENDS somewhere: the first line of picture is much brighter
    // than the bar. A dark scene fades instead, and that is the test that tells
    // them apart — without it, the first night shot would crop the film.
    if (!(top > 0 && rowMax(size - 1 - top) > CanvasRenderer.BAR_EDGE)) top = 0;
    if (!(bottom > 0 && rowMax(bottom) > CanvasRenderer.BAR_EDGE)) bottom = 0;
    if (!(left > 0 && colMax(left) > CanvasRenderer.BAR_EDGE)) left = 0;
    if (!(right > 0 && colMax(size - 1 - right) > CanvasRenderer.BAR_EDGE)) {
      right = 0;
    }

    // …and now give back the lines that were only DARK, not black.
    //
    // The mirror is 16 rows, so one row is a sixteenth of the frame — and the
    // row the bar ends inside is a blend of bar and picture. Where the picture
    // is dark at that edge (a night scene, a fade, a shot that opens on black)
    // the blend still comes in under BAR_DARK and the whole row is taken as
    // bar: 6% of the frame, 65 lines on a 1080p file, cut off a picture that
    // was there. Worse, the bad measurement moves the computed aspect out of
    // the snapping window below, so the one thing that would have corrected it
    // never runs.
    //
    // A real bar is not dark, it is black. Walking back over the merely-dark
    // lines costs at most one line of bar left on screen, and that is the
    // right way round: a sliver of black nobody notices, instead of a strip of
    // film nobody gets back.
    //
    // AFTER the test above, not before. That test asks whether the line just
    // past the bar is bright, which is how a bar is told from a fade — and the
    // line this walk-back hands over is the dim one, so testing against it
    // answers "no bar at all" and crops nothing.
    while (top > 0 && rowMax(size - 1 - (top - 1)) > CanvasRenderer.BAR_BLACK) {
      top--;
    }
    while (bottom > 0 && rowMax(bottom - 1) > CanvasRenderer.BAR_BLACK) bottom--;
    while (left > 0 && colMax(left - 1) > CanvasRenderer.BAR_BLACK) left--;
    while (right > 0 && colMax(size - right) > CanvasRenderer.BAR_BLACK) right--;

    const found = {
      top: top / size,
      bottom: bottom / size,
      left: left / size,
      right: right / size,
    };
    const c = this.barCropCandidate;
    const same =
      c &&
      Math.abs(c.top - found.top) < 1 / size &&
      Math.abs(c.bottom - found.bottom) < 1 / size &&
      Math.abs(c.left - found.left) < 1 / size &&
      Math.abs(c.right - found.right) < 1 / size;
    if (!same) {
      this.barCropCandidate = found;
      this.barCropStableSince = now;
      return;
    }
    if (now - this.barCropStableSince < CanvasRenderer.BAR_SETTLE_MS) return;

    const current = this.getBarCrop();
    if (
      Math.abs(current.top - found.top) < 1 / size &&
      Math.abs(current.bottom - found.bottom) < 1 / size &&
      Math.abs(current.left - found.left) < 1 / size &&
      Math.abs(current.right - found.right) < 1 / size
    ) {
      return; // already there
    }
    this.setCropRect(...this.snapToKnownAspect(found));
  }

  /**
   * Nudge a crop onto a real aspect ratio.
   *
   * The mirror is 64 rows, so a measured bar is only ever a 64th of the frame —
   * good enough to find it, one row out either way. Films are not one row out:
   * they are 2.39, 1.85, 4:3. Landing exactly on the nearest of those keeps the
   * cropped picture from being a fraction off, which is the difference between
   * "cropped" and "cropped badly".
   */
  private snapToKnownAspect(found: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }): [number, number, number, number] {
    const w = this.lastRenderedFrame ? sourceWidth(this.lastRenderedFrame) : 0;
    const h = this.lastRenderedFrame ? sourceHeight(this.lastRenderedFrame) : 0;
    const vertical = found.top + found.bottom;
    const horizontal = found.left + found.right;
    // Both axes cropped is a window-boxed frame — a picture padded twice, by
    // two different hands. There is no single ratio to snap that onto, so it is
    // left exactly as measured.
    if (!w || !h || (vertical > 0 && horizontal > 0)) {
      return [found.top, found.bottom, found.left, found.right];
    }
    const visibleW = 1 - horizontal;
    const visibleH = 1 - vertical;
    if (visibleW <= 0 || visibleH <= 0) {
      return [found.top, found.bottom, found.left, found.right];
    }
    const aspect = (w * visibleW) / (h * visibleH);
    // Landscape ratios and their portrait twins. A phone video padded into a
    // 4:3 frame is 3:4 visible, which is 4/3 upside down — leaving the
    // reciprocals out meant a pillarboxed portrait clip matched nothing and
    // kept the mirror's own two-column error instead of being centred.
    const LANDSCAPE = [2.39, 2.35, 2.2, 2.0, 1.85, 16 / 9, 1.66, 1.5, 4 / 3];
    const KNOWN = [1, ...LANDSCAPE, ...LANDSCAPE.map((k) => 1 / k)];
    let best = 0;
    let bestErr = Infinity;
    for (const k of KNOWN) {
      const err = Math.abs(aspect - k) / k;
      if (err < bestErr) {
        bestErr = err;
        best = k;
      }
    }
    if (bestErr > 0.03) {
      return [found.top, found.bottom, found.left, found.right];
    }
    // Split it evenly. Matching a known ratio is the evidence that this is an
    // ordinary pad, and ordinary pads are centred — where the two sides came
    // out uneven, that is the 64-line mirror being one or two lines off on each
    // side, not an off-centre picture. Measured on a 1440x1080 file holding a
    // 810-wide image: 12 columns one side, 16 the other, when both are 14.
    // (An unsnapped crop keeps exactly what was measured — see the early
    // returns above.)
    if (vertical > 0) {
      const trim = Math.max(0, 1 - w / (h * best)) / 2;
      return [trim, trim, 0, 0];
    }
    if (horizontal > 0) {
      const trim = Math.max(0, 1 - (best * h) / w) / 2;
      return [0, 0, trim, trim];
    }
    return [0, 0, 0, 0];
  }

  /** The visible part of the frame, in texture coordinates. Whole frame until
   *  bar cropping finds something to take off. */
  private cropRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
  private cropLocs = new WeakMap<WebGLProgram, WebGLUniformLocation | null>();

  /** Feed the crop to whichever program is about to draw. */
  private applyCropUniform(program: WebGLProgram | null, full = false): void {
    const gl = this.gl;
    if (!gl || !program) return;
    let loc = this.cropLocs.get(program);
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, "u_crop");
      this.cropLocs.set(program, loc);
    }
    if (!loc) return;
    const c = this.cropRect;
    if (full) gl.uniform4f(loc, 0, 0, 1, 1);
    else gl.uniform4f(loc, c.x0, c.y0, c.x1, c.y1);
  }

  /** Turn the corner cut off for a pass that draws somewhere else (see the
   *  ambient thumbnail). */
  private setRoundUniformOff(): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    const loc = this.roundLocs.get(this.program);
    if (loc) gl.uniform3f(loc, 0, 0, 0);
  }

  /** Feed the rounding uniform to whichever program is about to draw. */
  private applyRoundUniform(program: WebGLProgram | null): void {
    const gl = this.gl;
    if (!gl || !program) return;
    let loc = this.roundLocs.get(program);
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, "u_round");
      this.roundLocs.set(program, loc);
    }
    if (!loc) return;
    gl.uniform3f(
      loc,
      this.cornerRadiusBufferPx(),
      this.canvas?.width || 0,
      this.canvas?.height || 0,
    );
    let rloc = this.radiiLocs.get(program);
    if (rloc === undefined) {
      rloc = gl.getUniformLocation(program, "u_radii");
      this.radiiLocs.set(program, rloc);
    }
    if (rloc) {
      const [tl, tr, br, bl] = this.cornerRadiiBufferPx();
      gl.uniform4f(rloc, tl, tr, br, bl);
    }
  }

  clearQueue(): void {
    for (const frame of this.frameQueue) {
      frame.close();
    }
    this.frameQueue = [];
    this.lastPresentedPts = -1;
    this.syncedToAudio = false;
    this.lastKnownAudioTime = -1;
    this.framesPresented = 0; // Reset frame counter

    // Reset presentation timing to prevent stuttering after seek
    // This ensures the next frame after seek starts with fresh timing
    this.presentationStartTime = 0;
    this.presentationStartPts = 0;

    // Mark that we just seeked - this will make frame selection more forgiving
    this.justSeeked = true;
    // …and restart the hold allowance. It bounds how long the picture may sit
    // still while pre-roll is dropped, and the last present was before the
    // seek — measuring from there would spend the whole allowance at once.
    this._lastPresentAt = performance.now();

    Logger.debug(TAG, "Frame queue cleared and presentation timing reset");
  }

  /**
   * Hand the queue over to a new rendition WITHOUT emptying it.
   *
   * clearQueue() is the seek primitive: throw everything away, the picture is
   * about to jump anyway. A quality switch is the opposite case — the picture
   * must not jump at all — so the frames already queued from the outgoing
   * rendition are exactly what covers the changeover. Everything from
   * `fromPtsMicros` on is replaced by the incoming rendition's frames and the
   * older ones play out first, so the seam falls between two consecutive
   * presentation times and reads as one continuous picture at a new size.
   *
   * Presentation timing is deliberately NOT reset: the clock never stopped, and
   * re-anchoring it here is what makes a switch look like a seek. `justSeeked`
   * stays untouched for the same reason.
   *
   * Returns the number of incoming frames adopted — zero means the splice point
   * was already behind the queue and the caller should fall back to a hard
   * switch rather than leave a gap.
   */
  spliceQueue(fromPtsMicros: number, frames: VideoFrame[]): number {
    const kept: VideoFrame[] = [];
    for (const frame of this.frameQueue) {
      if (frame.timestamp >= fromPtsMicros) frame.close();
      else kept.push(frame);
    }
    this.frameQueue = kept;
    let adopted = 0;
    for (const frame of frames) {
      if (frame.timestamp < fromPtsMicros) {
        frame.close();
        continue;
      }
      this.queueFrame(frame);
      adopted++;
    }
    // The perf detectors are judging a rung that is no longer playing, and the
    // decode-bound verdict in particular would carry a 4K stall onto the 720p
    // that replaced it. configure() re-arms them; this only makes sure the
    // window between here and there isn't judged against the wrong rendition.
    this._perfWindowStart = 0;
    this._perfDeficitWindows = 0;
    this._perfStuckWindows = 0;
    Logger.debug(
      TAG,
      `Queue spliced at ${(fromPtsMicros / 1_000_000).toFixed(3)}s: ${kept.length} outgoing frames play out, ${adopted} incoming queued`,
    );
    return adopted;
  }

  /** Oldest and newest presentation times sitting in the queue, in SECONDS.
   *  The switch path uses the newest to pick a splice point the outgoing
   *  rendition can actually reach. */
  get queuedPtsRange(): { first: number; last: number } | null {
    if (this.frameQueue.length === 0) return null;
    return {
      first: this.frameQueue[0].timestamp / 1_000_000,
      last: this.frameQueue[this.frameQueue.length - 1].timestamp / 1_000_000,
    };
  }

  /**
   * Render an ImageBitmap
   */
  renderBitmap(_bitmap: ImageBitmap): void {
    // Not implemented for WebGL adapter yet
    // Could upload as texture if needed
  }

  /**
   * Clear the canvas
   */
  clear(): void {
    if (!this.gl) return;
    this.gl.clearColor(0, 0, 0, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /**
   * Fill with black
   */
  fillBlack(): void {
    this.clear();
  }

  /**
   * Get canvas element
   */
  getCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.canvas;
  }

  /**
   * Destroy renderer
   */
  destroy(): void {
    this.stopPresentationLoop();
    if (this.vrAnimRaf !== null) {
      cancelAnimationFrame(this.vrAnimRaf);
      this.vrAnimRaf = null;
    }

    // Clear retained frame on destroy
    this.releaseRetainedFrame();

    // …and everything still waiting to be presented. A VideoFrame holds a
    // decoded buffer that only close() gives back; dropping the reference
    // leaves it to garbage collection, which is what produces "A VideoFrame was
    // garbage collected without being closed" and, until the collector runs,
    // starves the decoder of the buffers it needs. The queue is tens of frames
    // deep at 60fps, and every quality switch and error recovery destroys a
    // renderer.
    this.clearQueue();

    this.clear();
    if (this.gl) {
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.vrProgram) this.gl.deleteProgram(this.vrProgram);
      // Hand the GPU context back explicitly — but ONLY when the canvas is on
      // its way out with us. Dropping the reference alone just queues it for
      // garbage collection, and Chrome caps a page at ~16 live contexts, so a
      // host that rebuilds the player per video walks into "Too many active
      // WebGL contexts. Oldest context will be lost" and the context it kills
      // may belong to the player on screen.
      //
      // A player REBUILD (quality recreate, error recovery) keeps the element's
      // canvas and hands it to the replacement, and losing a context is
      // permanent — getContext() on that canvas returns the same lost context
      // forever. Worse, loseContext() fires webglcontextlost, which the element
      // treats as the GPU dropping us and answers by tearing the player down:
      // the brand-new player was destroyed microseconds after being built, and
      // playback stopped dead at idle with nothing on screen.
      //
      // Still connected means the canvas outlives this renderer. Leave it be.
      // An OffscreenCanvas is never in a document, so it always qualifies.
      const attached =
        typeof HTMLCanvasElement !== "undefined" &&
        this.canvas instanceof HTMLCanvasElement &&
        this.canvas.isConnected;
      if (!attached) {
        try {
          this.gl.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
          /* extension unavailable — the context still goes with the canvas */
        }
      }
    }
    this.gl = null;
    Logger.debug(TAG, "Destroyed");
  }
}
