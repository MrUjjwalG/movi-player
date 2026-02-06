/**
 * ThumbnailRenderer - WebGL2-based thumbnail rendering with HDR support
 * Uses browser-specific rendering paths for optimal quality:
 * - Chromium: Native HDR via drawingBufferColorSpace
 * - Non-Chromium: Shader-based PQ tone mapping
 */

import { CodecParser } from "../decode/CodecParser";
import { Logger } from "./Logger";

const TAG = "ThumbnailRenderer";

export interface ThumbnailRenderOptions {
  width: number;
  height: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  hdrEnabled?: boolean;
}

export class ThumbnailRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  // WebCodecs support
  private decoder: VideoDecoder | null = null;
  private pendingDecodeResolve: ((success: boolean) => void) | null = null;

  private hasNativeHDRSupport: boolean = false;
  private isHDRSource: boolean = false;
  private hdrEnabled: boolean = true;

  constructor() {
    this.canvas = document.createElement("canvas");
  }

  /**
   * Detect if browser supports native HDR (Chromium-based)
   */
  private detectChromium(): boolean {
    return !!(window as any).chrome;
  }

  /**
   * Detect HDR color space from metadata
   */
  private detectHDRColorSpace(
    colorPrimaries?: string,
    colorTransfer?: string,
  ): string {
    const primaries = (colorPrimaries || "").toLowerCase();
    const transfer = (colorTransfer || "").toLowerCase();

    if (!this.hdrEnabled) {
      return "srgb";
    }

    const isHDRTransfer =
      transfer.includes("pq") ||
      transfer.includes("hlg") ||
      transfer.includes("smpte2084") ||
      transfer.includes("arib-std-b67");

    const isBT2020 =
      primaries.includes("bt2020") || primaries.includes("rec2020");

    if (isHDRTransfer || isBT2020) {
      Logger.debug(
        TAG,
        `HDR content detected (primaries: ${colorPrimaries}, transfer: ${colorTransfer}). Using display-p3.`,
      );
      return "display-p3";
    }

    if (primaries.includes("p3") || primaries.includes("display-p3")) {
      Logger.debug(TAG, `P3 content detected. Using display-p3.`);
      return "display-p3";
    }

    return "srgb";
  }

  /**
   * Initialize WebGL2 context with appropriate shader for browser
   */
  initialize(options: ThumbnailRenderOptions): void {
    const {
      width,
      height,
      colorPrimaries,
      colorTransfer,
      hdrEnabled = true,
    } = options;

    this.hdrEnabled = hdrEnabled;
    this.canvas.width = width;
    this.canvas.height = height;

    // Detect if source is HDR
    const primaries = (colorPrimaries || "").toLowerCase();
    const transfer = (colorTransfer || "").toLowerCase();
    const isHDRTransfer =
      transfer.includes("pq") ||
      transfer.includes("hlg") ||
      transfer.includes("smpte2084") ||
      transfer.includes("arib-std-b67");
    const isBT2020 =
      primaries.includes("bt2020") || primaries.includes("rec2020");
    this.isHDRSource = isHDRTransfer || isBT2020;

    // Detect HDR and get appropriate color space
    const detectedColorSpace = this.detectHDRColorSpace(
      colorPrimaries,
      colorTransfer,
    );

    // Initialize WebGL2
    const contextOptions: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
    };

    this.gl = this.canvas.getContext(
      "webgl2",
      contextOptions,
    ) as WebGL2RenderingContext;

    if (!this.gl) {
      throw new Error("WebGL2 not supported");
    }

    // Configure color space (Chromium 104+, Safari 17+)
    try {
      // @ts-ignore
      if (
        detectedColorSpace !== "srgb" &&
        this.gl.drawingBufferColorSpace !== undefined
      ) {
        // @ts-ignore
        this.gl.drawingBufferColorSpace = detectedColorSpace;
        // @ts-ignore
        this.gl.unpackColorSpace = detectedColorSpace;
        Logger.debug(TAG, `WebGL color space set to: ${detectedColorSpace}`);
      }
    } catch (e) {
      Logger.warn(TAG, "Failed to set drawingBufferColorSpace", e);
    }

    // Detect browser and choose rendering path
    const isChromium = this.detectChromium();
    this.hasNativeHDRSupport = isChromium;

    const needsShaderToneMapping =
      !this.hasNativeHDRSupport && this.isHDRSource;

    if (needsShaderToneMapping) {
      Logger.debug(TAG, "Using shader-based HDR tone mapping (non-Chromium)");
      this.initWebGLWithHDR();
    } else {
      Logger.debug(TAG, "Using simple passthrough (Chromium native HDR)");
      this.initWebGLSimple();
    }

    Logger.info(
      TAG,
      `Initialized: ${width}x${height}, isChromium=${isChromium}, isHDR=${this.isHDRSource}, colorSpace=${detectedColorSpace}`,
    );
  }

  /**
   * Simple WebGL initialization for Chromium (native HDR support)
   */
  private initWebGLSimple(): void {
    if (!this.gl) return;

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

    const shader = this.createProgram(vsSource, fsSource);
    if (!shader) {
      throw new Error("Failed to create shader program");
    }
    this.program = shader;

    this.setupGeometry();
    this.setupTexture();
  }

  /**
   * WebGL initialization with HDR tone mapping for non-Chromium browsers
   */
  private initWebGLWithHDR(): void {
    if (!this.gl) return;

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
    uniform float u_hdrEnabled;
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
      float exposure = mix(22.0, 35.0, u_hdrEnabled);
      vec3 sdr = toneMapReinhard(linear, exposure);

      // Saturation boost
      float saturation = mix(1.1, 1.5, u_hdrEnabled);
      sdr = adjustSaturation(sdr, saturation);

      // Apply gamma
      vec3 display = pow(sdr, vec3(1.0/2.2));

      outColor = vec4(display, color.a);
    }`;

    const shader = this.createProgram(vsSource, fsSource);
    if (!shader) {
      throw new Error("Failed to create shader program");
    }
    this.program = shader;

    this.setupGeometry();
    this.setupTexture();

    // Set HDR uniform
    if (!this.gl || !this.program) return;
    this.gl.useProgram(this.program);
    const uHdrEnabled = this.gl.getUniformLocation(
      this.program,
      "u_hdrEnabled",
    );
    if (uHdrEnabled) {
      this.gl.uniform1f(uHdrEnabled, this.hdrEnabled ? 1.0 : 0.0);
    }
  }

  /**
   * Create and compile shader program
   */
  private createProgram(
    vsSource: string,
    fsSource: string,
  ): WebGLProgram | null {
    if (!this.gl) return null;

    const createShader = (type: number, source: string) => {
      if (!this.gl) return null;
      const shader = this.gl.createShader(type);
      if (!shader) return null;
      this.gl.shaderSource(shader, source);
      this.gl.compileShader(shader);
      if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
        Logger.error(
          TAG,
          "Shader compile error:",
          this.gl.getShaderInfoLog(shader),
        );
        this.gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vert = createShader(this.gl.VERTEX_SHADER, vsSource);
    const frag = createShader(this.gl.FRAGMENT_SHADER, fsSource);
    if (!vert || !frag) return null;

    const program = this.gl.createProgram();
    if (!program) return null;
    this.gl.attachShader(program, vert);
    this.gl.attachShader(program, frag);
    this.gl.linkProgram(program);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      Logger.error(
        TAG,
        "Program link error:",
        this.gl.getProgramInfoLog(program),
      );
      return null;
    }

    return program;
  }

  /**
   * Setup geometry (fullscreen quad)
   */
  private setupGeometry(): void {
    if (!this.gl || !this.program) return;
    const gl = this.gl;

    const vertices = new Float32Array([
      -1.0,
      1.0,
      0.0,
      0.0, // TL
      -1.0,
      -1.0,
      0.0,
      1.0, // BL
      1.0,
      1.0,
      1.0,
      0.0, // TR
      1.0,
      -1.0,
      1.0,
      1.0, // BR
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
  }

  /**
   * Configure WebCodecs VideoDecoder
   */
  async configureDecoder(
    codec: string,
    extradata: Uint8Array | null,
    width: number,
    height: number,
    profile?: number,
    level?: number,
  ): Promise<boolean> {
    if (!("VideoDecoder" in window)) {
      Logger.warn(TAG, "WebCodecs not supported in this browser");
      return false;
    }

    // Reset existing decoder if any
    if (this.decoder) {
      if (this.decoder.state !== "closed") {
        this.decoder.close();
      }
      this.decoder = null;
    }

    return new Promise((resolve) => {
      try {
        this.decoder = new VideoDecoder({
          output: (frame) => {
            // Render the frame immediately when decoded
            this.renderVideoFrame(frame);
            frame.close(); // Important: release frame
            if (this.pendingDecodeResolve) {
              this.pendingDecodeResolve(true);
              this.pendingDecodeResolve = null;
            }
          },
          error: (e) => {
            Logger.error(TAG, "VideoDecoder error:", e);
            if (this.pendingDecodeResolve) {
              this.pendingDecodeResolve(false);
              this.pendingDecodeResolve = null;
            }
          },
        });

        // Use CodecParser to properly parse extradata binary format
        let codecString: string | null = null;

        // If profile is available, try manual mapping first as it's more reliable than parsing extradata
        if (profile !== undefined) {
          codecString = this.mapCodecToWebCodecs(
            codec,
            width,
            height,
            profile,
            level,
          );
        }

        // If manual mapping didn't yield a result (or profile wasn't provided), try CodecParser
        if (!codecString) {
          codecString = CodecParser.getCodecString(
            codec,
            extradata ?? undefined,
            width,
            height,
          );
        }

        // Final fallback
        if (!codecString) {
          codecString = codec;
          Logger.warn(
            TAG,
            "Failed to resolve codec string, using generic:",
            codecString,
          );
        } else {
          Logger.debug(TAG, "Resolved codec string:", codecString);
        }

        const config: VideoDecoderConfig = {
          codec: codecString,
          codedWidth: width,
          codedHeight: height,
          hardwareAcceleration: "prefer-hardware",
          optimizeForLatency: true,
        };

        // For VP9, WebCodecs often works best WITHOUT description if we have the full codec string (e.g. vp09.02...)
        // For H.264/H.265, description (avcC/hvcC) IS important, unless it's Annex B (start codes).
        // If Annex B, we assume headers are in the keyframe packets.
        const isAnnexB =
          extradata &&
          ((extradata.length > 3 &&
            extradata[0] === 0 &&
            extradata[1] === 0 &&
            extradata[2] === 1) ||
            (extradata.length > 4 &&
              extradata[0] === 0 &&
              extradata[1] === 0 &&
              extradata[2] === 0 &&
              extradata[3] === 1));

        if (
          extradata &&
          !codecString.startsWith("vp09") &&
          !codecString.startsWith("vp8") &&
          !isAnnexB
        ) {
          config.description = extradata;
        } else {
          Logger.debug(
            TAG,
            "Skipping description (extradata) for VPx codec, Annex B, or missing data",
          );
        }

        this.decoder.configure(config);
        resolve(true);
      } catch (e) {
        Logger.error(TAG, "Failed to configure VideoDecoder:", e);
        this.decoder = null;
        resolve(false);
      }
    });
  }

  /**
   * Map FFmpeg codec names to WebCodecs codec strings
   * (Copied from MoviVideoDecoder for consistency)
   */
  private mapCodecToWebCodecs(
    codec: string,
    _width: number,
    _height: number,
    profile?: number,
    _level?: number,
  ): string | null {
    const codecLower = codec.toLowerCase();

    // H.264 / AVC
    if (codecLower === "h264" || codecLower === "avc1") {
      return "avc1.640028"; // High profile, level 4.0
    }

    // H.265 / HEVC
    if (
      codecLower === "hevc" ||
      codecLower === "h265" ||
      codecLower === "hvc1"
    ) {
      // Main 10 Profile (Profile 2)
      if (profile === 2) {
        const levelStr = _level ? `L${_level}` : "L153";
        return `hvc1.2.4.${levelStr}.B0`;
      }
      // Main Profile (Profile 1)
      if (profile === 1) {
        const levelStr = _level ? `L${_level}` : "L120";
        return `hvc1.1.6.${levelStr}.B0`;
      }
      // Rext Profile 4
      if (profile === 4) {
        return "hvc1.4.10.L93.B0";
      }
      return "hvc1.1.6.L93.B0";
    }

    // VP9
    if (codecLower === "vp9") {
      // Profile 2 (10-bit HDR)
      if (profile === 2) {
        Logger.info(
          TAG,
          "Mapping VP9 Profile 2 to vp09.02.51.10.01.09.16.09.00 (HDR)",
        );
        return "vp09.02.51.10.01.09.16.09.00";
      }
      // Profile 3
      if (profile === 3) {
        return "vp09.03.51.10.01.09.16.09.00";
      }
      // Default Profile 0
      return "vp09.00.41.08.01.01.01.01.00";
    }

    // AV1
    if (codecLower === "av1") {
      return "av01.0.01M.08";
    }

    // Legacy
    if (codecLower === "vp8") return "vp8";

    return null;
  }

  /**
   * Decode and render a packet using WebCodecs
   */
  async decodeAndRender(
    packetData: Uint8Array,
    pts: number,
    duration?: number,
  ): Promise<boolean> {
    const decoder = this.decoder;
    if (!decoder || decoder.state === "closed") {
      return false;
    }

    return new Promise((resolve) => {
      this.pendingDecodeResolve = resolve;

      try {
        const chunk = new EncodedVideoChunk({
          type: "key", // Thumbnails are always keyframes in this context
          timestamp: pts * 1_000_000,
          duration: duration,
          data: packetData,
        });

        decoder.decode(chunk);
        decoder.flush().catch((e) => {
          Logger.error(TAG, "Decoder flush error:", e);
          if (this.pendingDecodeResolve) {
            this.pendingDecodeResolve(false);
            this.pendingDecodeResolve = null;
          }
        });
      } catch (e) {
        Logger.error(TAG, "Decode error:", e);
        if (this.pendingDecodeResolve) {
          this.pendingDecodeResolve(false);
          this.pendingDecodeResolve = null;
        }
      }
    });
  }

  /**
   * Render RGBA data to canvas
   */
  render(rgbaData: Uint8Array, width: number, height: number): void {
    if (!this.gl || !this.program || !this.texture || !this.vao) {
      throw new Error("ThumbnailRenderer not initialized");
    }

    const gl = this.gl;

    // Upload texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgbaData,
    );

    this.draw();
  }

  /**
   * Render VideoFrame to canvas
   */
  renderVideoFrame(frame: VideoFrame): void {
    if (!this.gl || !this.program || !this.texture || !this.vao) {
      return;
    }

    const gl = this.gl;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    this.draw();
  }

  private draw(): void {
    if (!this.gl || !this.program || !this.vao) return;
    const gl = this.gl;

    // Render
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Setup texture
   */
  private setupTexture(): void {
    if (!this.gl || !this.program) return;
    const gl = this.gl;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(this.program);
    const uImage = gl.getUniformLocation(this.program, "u_image");
    if (uImage) {
      gl.uniform1i(uImage, 0);
    }
  }

  /**
   * Get the rendered canvas
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Destroy WebGL resources
   */
  destroy(): void {
    if (this.gl) {
      if (this.texture) {
        this.gl.deleteTexture(this.texture);
        this.texture = null;
      }
      if (this.vao) {
        this.gl.deleteVertexArray(this.vao);
        this.vao = null;
      }
      if (this.program) {
        this.gl.deleteProgram(this.program);
        this.program = null;
      }
    }
    this.gl = null;

    if (this.decoder) {
      if (this.decoder.state !== "closed") {
        this.decoder.close();
      }
      this.decoder = null;
    }
  }
}
