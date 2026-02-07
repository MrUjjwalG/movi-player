/**
 * CanvasRenderer - Renders VideoFrames to canvas with frame-perfect timing
 * Uses a frame queue and presentation loop for smooth 60Hz playback
 */

import { Logger } from "../utils/Logger";
import type { SubtitleCue } from "../types";

const TAG = "CanvasRenderer";

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

  private hdrEnabled: boolean = true;
  private isHDRSource: boolean = false;

  // Presentation loop
  private rafId: number | null = null;
  private isPlaying: boolean = false;

  // Audio time provider for A/V sync
  private getAudioTime: (() => number) | null = null;
  private _isAudioHealthy: (() => boolean) | null = null;

  // Presentation timing
  private presentationStartTime: number = 0;
  private presentationStartPts: number = 0;
  private lastPresentedPts: number = -1;
  private syncedToAudio: boolean = false;
  private playbackRate: number = 1.0;
  private justSeeked: boolean = false; // Track if we just seeked (for post-seek frame handling)

  // Current time tracking
  private currentTime: number = 0;

  // Frame rate for timing calculations
  private videoFrameRate: number = 60; // Default to 60fps

  // Rotation (degrees: 0, 90, 180, 270)
  private rotation: number = 0;

  // Fit mode for canvas rendering
  private fitMode: "contain" | "cover" | "fill" | "zoom" | "control" =
    "contain"; // Default to contain (maintain aspect ratio)

  // Subtitle rendering
  private activeSubtitleCue: SubtitleCue | null = null;
  private subtitleCues: SubtitleCue[] = [];
  private subtitleOverlay: HTMLElement | null = null;

  // Animation state for object-fit transitions
  private currentScaleX: number = 0;
  private currentScaleY: number = 0;

  // Persist last rendered frame for redrawing on resize during pause
  /**
   * We must retain a clone of the last rendered frame because:
   * 1. resizing the canvas clears it (black screen)
   * 2. if paused, frameQueue is likely empty, so we have nothing to redraw
   * 3. we need to redraw the *current* image to restore the view
   */
  private lastRenderedFrame: VideoFrame | null = null;

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
  ): void {
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

    // Set rotation
    if (rotation !== undefined) {
      this.rotation = rotation;
      if (this.canvas instanceof HTMLCanvasElement) {
        this.canvas.style.transform = `rotate(${rotation}deg)`;
        this.canvas.style.transformOrigin = "center center";
      }
      Logger.debug(TAG, `Rotation set to: ${rotation}° (CSS transform)`);
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
        alpha: false,
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

      // Configure color space on the GL context (Chrome 104+, Safari 17+)
      try {
        // @ts-ignore
        if (
          detectedColorSpace !== "srgb" &&
          this.gl.drawingBufferColorSpace !== undefined
        ) {
          // Verify if the browser actually supports the requested color space
          // WebGL2 only supports 'srgb' and 'display-p3'
          const supportedSpaces = ["srgb", "display-p3"];
          const targetSpace = supportedSpaces.includes(detectedColorSpace)
            ? detectedColorSpace
            : "srgb";

          // @ts-ignore
          this.gl.drawingBufferColorSpace = targetSpace;
          // @ts-ignore
          this.gl.unpackColorSpace = targetSpace;
          Logger.info(
            TAG,
            `WebGL drawing buffer color space set to: ${targetSpace} (requested: ${detectedColorSpace})`,
          );
        }
      } catch (e) {
        Logger.warn(
          TAG,
          "Failed to set drawingBufferColorSpace on GL context",
          e,
        );
      }

      this.initWebGL();
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
    in vec2 v_texCoord;
    out vec4 outColor;
    void main() {
      outColor = texture(u_image, v_texCoord);
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
      vec4 color = texture(u_image, v_texCoord);

      // Apply PQ EOTF to get linear light
      vec3 linear = PQtoLinear(color.rgb);

      // Tone map to SDR range
      // Adjusted to match Chrome native HDR appearance
      // When HDR disabled: lower exposure (22.0) for better contrast
      // When HDR enabled: higher exposure (35.0) to match native Chrome vibrance
      float exposure = mix(22.0, 35.0, u_hdrEnabled);
      vec3 sdr = toneMapReinhard(linear, exposure);

      // Saturation boost
      // When HDR disabled: slight boost (1.1) for better colors
      // When HDR enabled: strong boost (1.5) to match Chrome native HDR vibrancy
      float saturation = mix(1.1, 1.5, u_hdrEnabled);
      sdr = adjustSaturation(sdr, saturation);

      // Apply gamma (2.2 for accurate color reproduction)
      vec3 display = pow(sdr, vec3(1.0/2.2));

      outColor = vec4(display, color.a);
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

  private lastPrimaries?: string;
  private lastTransfer?: string;

  /**
   * Set HDR enabled state
   */
  setHDREnabled(enabled: boolean): void {
    if (this.hdrEnabled === enabled) return;
    this.hdrEnabled = enabled;
    Logger.info(TAG, `HDR manual override set to: ${enabled}`);

    // Re-detect and re-apply color space if gl exists
    const newColorSpace = this.detectHDRColorSpace(
      this.lastPrimaries,
      this.lastTransfer,
    );

    if (this.gl && this.gl.drawingBufferColorSpace !== undefined) {
      try {
        // @ts-ignore
        this.gl.drawingBufferColorSpace = newColorSpace;
        // @ts-ignore
        this.gl.unpackColorSpace = newColorSpace;
        this.colorSpace = newColorSpace;
        Logger.info(
          TAG,
          `Updated WebGL color space to ${newColorSpace} following HDR toggle`,
        );
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
   * Check if the current video source supports HDR
   */
  isHDRSupported(): boolean {
    return this.isHDRSource;
  }

  resize(width: number, height: number): void {
    if (width > 0 && height > 0) {
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

      this.width = targetWidth;
      this.height = targetHeight;
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;

      // Apply CSS sizing
      if (this.canvas instanceof HTMLCanvasElement) {
        if (isRotated90) {
          // Explicit pixel size is needed to override percentage stretching
          // so the buffer aspect ratio (HxW) is preserved in layout before rotation
          // We use !important to ensure this overrides any fullscreen CSS that forces 100vw/100vh
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
          // Restore standard sizing
          this.canvas.style.width = "100%";
          this.canvas.style.height = "100%";
          this.canvas.style.position = "relative";
          this.canvas.style.top = "";
          this.canvas.style.left = "";
          this.canvas.style.margin = "";
          this.canvas.style.transform = "none";
        }
      }

      // Recreate context only if not exists (usually resize just updates viewport in WebGL,
      // but if canvas was reset we might need to check gl)
      // WebGL contexts are robust to resize usually.
      if (!this.gl) {
        // Try to init if missing
        const opts = { alpha: false, desynchronized: false };
        this.gl = this.canvas.getContext(
          "webgl2",
          opts,
        ) as WebGL2RenderingContext;
        this.initWebGL();
      } else {
        // Just need to update viewport during draw
        // Trigger a redraw
      }

      // Immediately redraw without smoothing to avoid black flicker
      try {
        // Reset smoothing state so it doesn't interpolate from old dimensions
        this.currentScaleX = 0;
        this.currentScaleY = 0;

        if (this.frameQueue.length > 0) {
          this.drawFrame(this.frameQueue[0], true);
        } else if (this.lastRenderedFrame) {
          this.drawFrame(this.lastRenderedFrame, true);
        }
      } catch (error) {
        Logger.error(TAG, "Error redrawing frame after resize", error);
      }

      // Update overlay dimensions
      if (this.subtitleOverlay) {
        // Overlay matches container (unrotated visual area), not canvas buffer
        // So we use the original input width/height (Container WxH)
        const canvasWidth = width;
        const canvasHeight = height;

        // Calculate responsive bottom padding
        const minPadding = Math.min(80, canvasHeight * 0.1);
        const bottomPadding = Math.max(minPadding, 60);

        // Reset overlay positioning to ensure it stays aligned with canvas
        this.subtitleOverlay.style.position = "absolute";
        this.subtitleOverlay.style.top = "0";
        this.subtitleOverlay.style.left = "0";
        this.subtitleOverlay.style.right = "auto";
        this.subtitleOverlay.style.bottom = "auto";
        this.subtitleOverlay.style.width = `${canvasWidth}px`;
        this.subtitleOverlay.style.height = `${canvasHeight}px`;
        this.subtitleOverlay.style.margin = "0";
        this.subtitleOverlay.style.padding = "0";
        this.subtitleOverlay.style.paddingBottom = `${bottomPadding}px`; // Responsive space above controls
        this.subtitleOverlay.style.display = "flex";
        this.subtitleOverlay.style.flexDirection = "column";
        this.subtitleOverlay.style.justifyContent = "flex-end";
        this.subtitleOverlay.style.alignItems = "center";
        this.subtitleOverlay.style.transform = "none";
        this.subtitleOverlay.style.boxSizing = "border-box";

        // Re-render subtitles to update positions with new dimensions
        if (this.activeSubtitleCue) {
          this.renderSubtitles();
        }
      }
    }
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
  }

  /**
   * Set audio time provider for A/V sync
   * Pass null to disable A/V sync and run video independently
   */
  setAudioTimeProvider(
    getAudioTime: (() => number) | null,
    isAudioHealthy?: (() => boolean) | null,
  ): void {
    this.getAudioTime = getAudioTime;
    this._isAudioHealthy = isAudioHealthy || null;
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
  render(frame: VideoFrame): void {
    this.drawFrame(frame);
  }

  /**
   * Start the presentation loop for smooth playback
   */
  startPresentationLoop(): void {
    if (this.rafId !== null) return;

    this.isPlaying = true;
    this.presentationStartTime = performance.now();

    // Only reset timing if we don't have frames (fresh start/seek)
    // If we have queue, we are resuming, so keep last known PTS to avoid jumps
    if (this.frameQueue.length === 0) {
      this.lastPresentedPts = -1;
      this.syncedToAudio = false;
    } else {
      // Resuming with frames: reset anchor to last presented time to prevent restart from 0
      if (this.lastPresentedPts >= 0) {
        this.presentationStartPts = this.lastPresentedPts;
      } else {
        this.presentationStartPts = this.frameQueue[0].timestamp / 1_000_000;
      }
      this.syncedToAudio = false;
    }

    this.presentationLoop();
    Logger.debug(TAG, "Presentation loop started");
  }

  /**
   * Stop the presentation loop
   */
  stopPresentationLoop(): void {
    this.isPlaying = false;

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
   * RAF-based presentation loop - presents frames at VSync-aligned times
   * For true 60fps, we present exactly one frame per RAF call when available
   */
  private presentationLoop = (): void => {
    if (!this.isPlaying) {
      this.rafId = null;
      return;
    }

    // Schedule next frame first (ensures consistent timing)
    // This ensures RAF timing is consistent and VSync-aligned
    this.rafId = requestAnimationFrame(this.presentationLoop);

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
      this.videoFrameRate >= 60 &&
      this.frameQueue.length > 0
    ) {
      // For 60fps, present the first available frame to maintain cadence
      const firstFrame = this.frameQueue[0];
      const frameTime = firstFrame.timestamp / 1_000_000;
      const frameInterval = 1.0 / this.videoFrameRate;
      // Only use it if it's not too far behind (more than 2 frame intervals)
      if (currentPlaybackTime - frameTime <= frameInterval * 2) {
        this.drawFrame(firstFrame);

        // Retain for resize redraws
        if (this.lastRenderedFrame) this.lastRenderedFrame.close();
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
        return;
      }
    }

    if (frameToPresent) {
      // Draw and close the frame (drawFrame will update currentTime)
      this.drawFrame(frameToPresent);

      // Retain for resize redraws
      if (this.lastRenderedFrame) this.lastRenderedFrame.close();
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
    // Always use wall clock for video timing (smooth 60fps)
    let videoTime = -1;
    if (this.presentationStartTime > 0) {
      const elapsed = (performance.now() - this.presentationStartTime) / 1000;
      videoTime = this.presentationStartPts + elapsed * this.playbackRate;
    }

    // Check audio for drift correction (but don't block video)
    if (this.getAudioTime) {
      const audioTime = this.getAudioTime();
      const isHealthy = this._isAudioHealthy ? this._isAudioHealthy() : true;

      if (audioTime >= 0 && isHealthy) {
        // First sync - initialize wall clock to match audio
        if (!this.syncedToAudio) {
          this.presentationStartTime = performance.now();
          this.presentationStartPts = audioTime;
          this.syncedToAudio = true;
          return audioTime;
        }

        // Loose sync: only correct if video has drifted more than 100ms from audio
        // This prevents audio jitter from affecting smooth video playback
        if (videoTime >= 0) {
          const drift = videoTime - audioTime;

          // If video is more than 100ms ahead or behind audio, gently correct
          if (Math.abs(drift) > 0.1) {
            // Apply gradual correction (50% per check) to avoid jarring jumps
            const correction = drift * 0.5;
            this.presentationStartPts -= correction;
            // Logger.debug(TAG, `A/V drift correction: ${(drift * 1000).toFixed(1)}ms`);
          }
        }

        // Return wall clock time (not audio time) for smooth video
        const elapsed = (performance.now() - this.presentationStartTime) / 1000;
        return this.presentationStartPts + elapsed * this.playbackRate;
      }
    }

    // No audio or audio not ready - use wall clock
    return videoTime >= 0 ? videoTime : -1;
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

    // First frame special case - present immediately
    if (this.lastPresentedPts < 0 && this.frameQueue.length > 0) {
      const firstFrame = this.frameQueue.shift()!;
      this.lastPresentedPts = firstFrame.timestamp / 1_000_000;
      this.currentTime = this.lastPresentedPts;

      // Initialize presentation timing
      this.presentationStartTime = performance.now();
      this.presentationStartPts = this.lastPresentedPts;
      this.syncedToAudio = false;

      Logger.debug(
        TAG,
        `First frame: pts=${this.lastPresentedPts.toFixed(3)}s`,
      );
      return firstFrame;
    }

    // FPS Throttling & Memory Optimization
    // If configured FrameRate is low (e.g. < 20fps), we enforce throttling
    // and aggressively drop intermediate frames to save memory (crucial for 4K software decoding)
    if (this.videoFrameRate < 20 && this.lastPresentedPts >= 0) {
      const nextTargetTime = this.lastPresentedPts + frameInterval;

      // If we haven't reached the next target presentation time (with small tolerance)
      if (currentTime < nextTargetTime - 0.05) {
        // Prune the queue: Discard frames that are definitely too early to be useful
        // We only keep frames close to the target time (e.g. within 200ms)
        // This prevents buffering 1GB+ of 4K frames in memory while waiting for the next second
        const keepThreshold = nextTargetTime - 0.2;

        while (this.frameQueue.length > 0) {
          const first = this.frameQueue[0];
          const firstTime = first.timestamp / 1_000_000;

          if (firstTime >= keepThreshold) break;

          // Drop useless frame
          this.frameQueue.shift()?.close();
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

      // If first frame is coming up soon (within one frame interval), present it
      if (firstFrameTime <= currentTime + frameInterval) {
        bestFrame = firstFrame;
        bestIndex = 0;
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

      return bestFrame;
    }

    // No frame due - just keep showing the last frame (natural hold)
    // This is how YouTube handles it - no forced repetition, just timestamp-based
    return null;
  }

  /**
   * Draw a frame to the canvas
   */
  private drawFrame(frame: VideoFrame, force: boolean = false): void {
    if (!this.gl || !this.program || !this.texture) return;
    const gl = this.gl;

    try {
      // Update current time
      this.currentTime = frame.timestamp / 1_000_000;

      // Check if frame is valid (width/height > 0)
      // Attempting to draw a closed frame causes "WebGL: INVALID_OPERATION: texImage2D: can't texture a closed VideoFrame"
      // Explicitly check display dimensions which are 0 on closed frames
      if (frame.displayWidth === 0 || frame.displayHeight === 0) {
        Logger.warn(TAG, "Attempted to draw closed/invalid frame");
        return;
      }

      const contentWidth = frame.displayWidth;
      const contentHeight = frame.displayHeight;

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

      if (this.currentScaleX === 0 || this.currentScaleY === 0 || force) {
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

      const x = (this.width - scaledWidth) / 2;
      const y = (this.height - scaledHeight) / 2;

      // GL Draw steps:
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // WebGL viewport needs y from bottom
      // CSS y is from top.
      const viewportY = this.height - (y + scaledHeight);
      gl.viewport(x, viewportY, scaledWidth, scaledHeight);

      // Bind texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);

      // Upload frame
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        frame,
      );

      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } catch (error) {
      if (error instanceof DOMException && error.name === "InvalidStateError") {
        return;
      }
      Logger.error(TAG, "WebGL Draw error", error);
    }
  }

  /**
   * Set subtitle overlay element (HTML element for better performance)
   */
  setSubtitleOverlay(overlay: HTMLElement | null): void {
    this.subtitleOverlay = overlay;
    Logger.debug(TAG, `Subtitle overlay ${overlay ? "set" : "cleared"}`);
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
      const currentTime = this.getCurrentPlaybackTime();

      // Remove cues that have ended (with some tolerance)
      this.subtitleCues = this.subtitleCues.filter((cue) => {
        // Keep cues that haven't ended yet (with 500ms tolerance for safety)
        return currentTime <= cue.end + 0.5;
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
   * Render image subtitle in HTML overlay
   */
  private renderImageSubtitleInOverlay(cue: SubtitleCue): void {
    if (!this.subtitleOverlay || !cue.image) {
      return;
    }

    try {
      // Create a temporary canvas to convert ImageBitmap to data URL
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

      // Draw ImageBitmap to temporary canvas
      tempCtx.drawImage(cue.image, 0, 0);

      // Convert to data URL
      const dataUrl = tempCanvas.toDataURL("image/png");

      // Get display dimensions (not buffer dimensions) for overlay
      // If rotated 90/270, the buffer dimensions (this.width/height) are swapped relative to the screen
      const isRotated90 = this.rotation % 180 !== 0;
      const displayWidth = isRotated90 ? this.height : this.width;
      const displayHeight = isRotated90 ? this.width : this.height;

      const canvasWidth = displayWidth;
      const canvasHeight = displayHeight;

      // Scale position based on video dimensions vs subtitle dimensions
      // PGS subtitle positions are typically relative to video resolution (1920x1080, etc.)
      const subtitleVideoWidth = 1920; // Standard PGS subtitle resolution
      const subtitleVideoHeight = 1080;
      const scaleX = canvasWidth / subtitleVideoWidth;
      const scaleY = canvasHeight / subtitleVideoHeight;

      // Use uniform scale to preserve aspect ratio (prevent stretching)
      // Use the smaller scale to ensure image fits within canvas
      const uniformScale = Math.min(scaleX, scaleY);

      // Calculate scaled dimensions preserving aspect ratio
      const scaledWidth = cue.image.width * uniformScale;
      const scaledHeight = cue.image.height * uniformScale;

      // Calculate bottom padding (responsive - adjust based on screen size)
      // Use 80px on larger screens, but scale down proportionally on smaller screens
      const minPadding = Math.min(80, canvasHeight * 0.1); // At least 10% of height, max 80px
      const bottomPadding = Math.max(minPadding, 60); // Minimum 60px

      // Position at bottom center (above controls), similar to text subtitles
      // For image subtitles, always position at bottom if no explicit position
      let x = cue.position?.x
        ? cue.position.x * uniformScale
        : (canvasWidth - scaledWidth) / 2;
      let y: number;

      if (cue.position?.y) {
        // Use explicit Y position but ensure it doesn't go above top
        y = cue.position.y * uniformScale;
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
      this.subtitleOverlay.style.position = "absolute";
      this.subtitleOverlay.style.top = "0";
      this.subtitleOverlay.style.left = "0";
      this.subtitleOverlay.style.right = "auto";
      this.subtitleOverlay.style.bottom = "auto";
      this.subtitleOverlay.style.width = `${canvasWidth}px`;
      this.subtitleOverlay.style.height = `${canvasHeight}px`;
      this.subtitleOverlay.style.pointerEvents = "none";
      // zIndex controlled by CSS (.movi-subtitle-overlay)
      this.subtitleOverlay.style.transform = "none";
      this.subtitleOverlay.style.display = "flex";
      this.subtitleOverlay.style.flexDirection = "column";
      this.subtitleOverlay.style.justifyContent = "flex-end";
      this.subtitleOverlay.style.alignItems = "center";
      this.subtitleOverlay.style.overflow = "hidden"; // Prevent overflow outside canvas
      this.subtitleOverlay.style.padding = "0";
      // Calculate responsive bottom padding for image subtitles
      const minPaddingImg = Math.min(80, canvasHeight * 0.1); // At least 10% of height, max 80px
      const bottomPaddingImg = Math.max(minPaddingImg, 60); // Minimum 60px
      this.subtitleOverlay.style.paddingBottom = `${bottomPaddingImg}px`; // Responsive space above controls
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
      imgElement.style.maxWidth = `${canvasWidth}px`; // Ensure image doesn't exceed canvas width
      imgElement.style.maxHeight = `${canvasHeight}px`; // Ensure image doesn't exceed canvas height
      imgElement.style.objectFit = "contain"; // Preserve aspect ratio
      imgElement.style.display = "block";
      imgElement.style.visibility = "visible";
      imgElement.style.opacity = "1";

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
    // Clear all subtitle elements from overlay if it exists
    if (this.subtitleOverlay) {
      this.subtitleOverlay.innerHTML = "";
    }
  }

  /**
   * Update active subtitle based on current time
   */
  private updateActiveSubtitle(): void {
    // Use getCurrentPlaybackTime() instead of this.currentTime to ensure accurate timing
    // this.currentTime is only updated when frames are drawn, but subtitles need real-time updates
    const currentTime = this.getCurrentPlaybackTime();
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
        currentTime >= cue.start - startTolerance &&
        currentTime <= cue.end + endTolerance;

      if (isInRange) {
        // Calculate a score - prefer cues that are more centered in their time range
        const cueCenter = (cue.start + cue.end) / 2;
        const distanceFromCenter = Math.abs(currentTime - cueCenter);
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
        currentTime >= previousCue.start - startTolerance &&
        currentTime <= previousCue.end + extendedEndTolerance
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

    if (!this.activeSubtitleCue) {
      // Clear overlay if no active cue
      if (this.subtitleOverlay) {
        this.subtitleOverlay.textContent = "";
        this.subtitleOverlay.innerHTML = ""; // Clear any image elements too
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

      // Position overlay at bottom center (above controls)
      const minPadding = Math.min(80, displayHeight * 0.1);
      const bottomPadding = Math.max(minPadding, 60);

      this.subtitleOverlay.style.position = "absolute";
      this.subtitleOverlay.style.top = "0";
      this.subtitleOverlay.style.left = "0";
      this.subtitleOverlay.style.right = "auto";
      this.subtitleOverlay.style.bottom = "auto";
      this.subtitleOverlay.style.width = `${displayWidth}px`;
      this.subtitleOverlay.style.height = `${displayHeight}px`;
      this.subtitleOverlay.style.margin = "0";
      this.subtitleOverlay.style.padding = "0";
      this.subtitleOverlay.style.paddingBottom = `${bottomPadding}px`;
      this.subtitleOverlay.style.transform = "none";
      this.subtitleOverlay.style.boxSizing = "border-box";
      this.subtitleOverlay.style.display = "flex";
      this.subtitleOverlay.style.flexDirection = "column";
      this.subtitleOverlay.style.justifyContent = "flex-end";
      this.subtitleOverlay.style.alignItems = "center";
      this.subtitleOverlay.style.textAlign = "center";
      this.subtitleOverlay.style.pointerEvents = "none";
      this.subtitleOverlay.style.pointerEvents = "none";
      // zIndex controlled by CSS (.movi-subtitle-overlay)

      // Update HTML overlay with subtitle text
      // Split text into lines and create HTML
      const lines = cue.text.split("\n");
      this.subtitleOverlay.innerHTML = lines
        .map((line) => {
          // Allow safe HTML formatting tags (<i>, <b>, <u>, <font>) while escaping other content
          // First, protect safe formatting tags by replacing them with placeholders
          const placeholders: string[] = [];
          let textWithPlaceholders = line;

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

          return `<div class="movi-subtitle-line">${escaped}</div>`;
        })
        .join("");

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

    if (this.presentationStartTime > 0 && !this.syncedToAudio) {
      this.presentationStartTime = performance.now();
      this.presentationStartPts = currentTime;
    }
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
   * Get frame queue size
   */
  getQueueSize(): number {
    return this.frameQueue.length;
  }

  /**
   * Clear frame queue (useful for seek operations)
   * Resets all presentation timing to prevent stuttering after seek
   */
  clearQueue(): void {
    for (const frame of this.frameQueue) {
      frame.close();
    }
    this.frameQueue = [];
    this.lastPresentedPts = -1;
    this.syncedToAudio = false;

    // Reset presentation timing to prevent stuttering after seek
    // This ensures the next frame after seek starts with fresh timing
    this.presentationStartTime = 0;
    this.presentationStartPts = 0;

    // Mark that we just seeked - this will make frame selection more forgiving
    this.justSeeked = true;

    Logger.debug(TAG, "Frame queue cleared and presentation timing reset");
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

    // Clear retained frame on destroy
    if (this.lastRenderedFrame) {
      this.lastRenderedFrame.close();
      this.lastRenderedFrame = null;
    }

    this.clear();
    if (this.gl) {
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.program) this.gl.deleteProgram(this.program);
      // Extensions etc
      // WebGL2 contexts are garbage collected but good to delete resources
    }
    this.gl = null;
    Logger.debug(TAG, "Destroyed");
  }
}
