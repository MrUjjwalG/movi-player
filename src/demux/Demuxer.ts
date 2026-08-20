/**
 * Demuxer - FFmpeg-based demuxer using Asyncify for async I/O
 */

//hvc1.4.10.L93.B0

//hvc1.4.10.H153.8.9d

import type { SourceAdapter } from "../source/SourceAdapter";
import type {
  Track,
  VideoTrack,
  AudioTrack,
  SubtitleTrack,
  MediaInfo,
  Packet,
} from "../types";
import {
  WasmBindings,
  ThumbnailBindings,
  loadWasmModule,
  loadWasmModuleNew,
  claimSharedModule,
  releaseSharedModule,
  type MoviWasmModule,
  type StreamInfo,
  type DataSource,
} from "../wasm";
import { CodecParser } from "../decode/CodecParser";
import { Logger } from "../utils/Logger";

const TAG = "Demuxer";

// Wall-clock ceiling for the missing-duration packet scan, per source class.
//
// Local is disk-bound and the bytes are free: a 5.5MB Matroska demuxes in ~4ms,
// so a second is already far more rope than any sane file needs. Remote is
// bandwidth-bound and the bytes cost the viewer something, so it gets a longer
// clock (a network round trip alone can eat a local budget) but a hard size gate
// in front of it.
const DURATION_SCAN_BUDGET_MS = { local: 1000, remote: 3000 };

// Don't even start a remote scan above this. The scan has to pull the whole file
// to see the last packet, and past this point it's downloading more than a
// duration is worth — at ordinary broadband it couldn't finish inside the budget
// anyway, so it would just burn bandwidth on its way to giving up.
const REMOTE_DURATION_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Adapter to convert SourceAdapter to DataSource interface
 */
class SourceDataAdapter implements DataSource {
  private source: SourceAdapter;
  private fileSize: number = 0;

  constructor(source: SourceAdapter) {
    this.source = source;
  }

  async getSize(): Promise<number> {
    if (this.fileSize === 0) {
      this.fileSize = await this.source.getSize();
    }
    return this.fileSize;
  }

  async read(offset: number, size: number): Promise<Uint8Array> {
    const buffer = await this.source.read(offset, size);
    return new Uint8Array(buffer);
  }
}

export class Demuxer {
  private source: SourceAdapter;
  private module: MoviWasmModule | null = null;
  private bindings: WasmBindings | null = null;
  private tracks: Track[] = [];
  private duration: number = 0;
  /** This demuxer holds the shared main-playback module — see claimSharedModule. */
  private _holdsSharedModule = false;
  private isOpened: boolean = false;
  private wasmBinary?: Uint8Array;
  private useNewWasmInstance: boolean = false;

  /**
   * @param source - Data source adapter
   * @param wasmBinary - Optional WASM binary
   * @param useNewWasmInstance - If true, creates isolated WASM instance (for preview pipeline)
   */
  constructor(
    source: SourceAdapter,
    wasmBinary?: Uint8Array,
    useNewWasmInstance: boolean = false,
  ) {
    this.source = source;
    this.wasmBinary = wasmBinary;
    this.useNewWasmInstance = useNewWasmInstance;
  }

  /**
   * Open the media file and parse metadata
   */
  async open(): Promise<MediaInfo> {
    Logger.info(TAG, "Opening media...");

    // Load WASM module - use isolated instance for preview to avoid memory conflicts
    if (this.useNewWasmInstance) {
      Logger.debug(TAG, "Using isolated WASM instance");
      this.module = await loadWasmModuleNew({ wasmBinary: this.wasmBinary });
    } else if (this._holdsSharedModule || claimSharedModule()) {
      // The shared module is ours (or already was, if this demuxer is being
      // re-opened) — see claimSharedModule for why it can only have one user.
      this._holdsSharedModule = true;
      this.module = await loadWasmModule({ wasmBinary: this.wasmBinary });
    } else {
      // Another player is demuxing through the shared module. Sharing it would
      // cross the two players' reads (see claimSharedModule); take an isolated
      // instance instead so both play.
      Logger.info(
        TAG,
        "The shared WASM module is in use by another player — opening on an isolated instance",
      );
      this.module = await loadWasmModuleNew({ wasmBinary: this.wasmBinary });
    }
    this.bindings = new WasmBindings(this.module);

    // Create context
    if (!this.bindings.create()) {
      throw new Error("Failed to create demuxer context");
    }

    // Set up data source adapter for async I/O
    const dataSource = new SourceDataAdapter(this.source);
    this.bindings.setDataSource(dataSource);

    // Open media (async - uses Asyncify for I/O)
    const streamCount = await this.bindings.open();
    Logger.info(TAG, `Opened with ${streamCount} streams`);

    this.isOpened = true;

    // Get duration and start time
    this.duration = this.bindings.getDuration();
    if (this.duration <= 0) {
      this.duration = await this.recoverMissingDuration();
    }
    const startTime = this.bindings.getStartTime();

    // Enumerate streams
    this.tracks = this.enumerateTracks();

    Logger.info(
      TAG,
      `Media info: duration=${this.duration}s, start=${startTime}s, tracks=${this.tracks.length}`,
    );

    // Get title from metadata
    const title = this.bindings.getMetadataTitle();
    const metadata: Record<string, string> = {};
    if (title) metadata.title = title;

    // Get chapters
    const chapters = this.bindings.getChapters();
    if (chapters.length > 0) {
      Logger.info(TAG, `Found ${chapters.length} chapters`);
    }

    return {
      formatName: this.bindings.getFormatName(),
      duration: this.duration,
      bitRate: 0, // TODO
      startTime: startTime,
      tracks: this.tracks,
      chapters: chapters,
      metadata: metadata,
    };
  }

  /**
   * Last resort for a container that stores no duration — demux to EOF and take
   * the largest packet end timestamp (see movi_scan_duration in the WASM layer).
   *
   * The files this rescues are downloads that were never finalised: a Matroska
   * muxed in live mode has an unknown-size segment, no Duration element and no
   * Cues, so FFmpeg reports AV_NOPTS_VALUE and the player shows 0:00 with a dead
   * seek bar. Native `ffprobe` prints duration=N/A on the same file.
   *
   * The scan is only ever expensive in I/O, so what it costs depends entirely on
   * where the bytes come from, and the gating splits three ways:
   *
   *  - Local (a File, an object URL, or the desktop shell's loopback server):
   *    a disk read. Scan it, no size limit.
   *  - Segmented (HLS/DASH): never. Those are assembled from a playlist whose
   *    window slides, and the stream wrapper — not the container — is the
   *    authority on their duration. Handing one a scanned window length would
   *    clamp the clock to a number that goes stale as the window moves.
   *  - Plain remote: only when the server declares a size and that size is small
   *    enough to be worth the download. Requiring Content-Length is also what
   *    keeps chunked/endless responses out.
   */
  private async recoverMissingDuration(): Promise<number> {
    if (!this.bindings) return 0;

    const key = this.source.getKey();
    let budgetMs = DURATION_SCAN_BUDGET_MS.local;

    if (!Demuxer.isLocallyBacked(key)) {
      if (key.startsWith("hls-segments:")) {
        Logger.debug(
          TAG,
          "Container reports no duration; segmented source owns its own duration",
        );
        return 0;
      }

      budgetMs = DURATION_SCAN_BUDGET_MS.remote;
      const size = await this.source.getSize().catch(() => 0);
      if (!Number.isFinite(size) || size <= 0) {
        Logger.debug(
          TAG,
          "Container reports no duration and the source declares no size; skipping scan",
        );
        return 0;
      }
      if (size > REMOTE_DURATION_SCAN_MAX_BYTES) {
        Logger.debug(
          TAG,
          `Container reports no duration, but ${Math.round(size / 1048576)}MB is too much to scan over the network`,
        );
        return 0;
      }
    }

    Logger.info(TAG, "Container reports no duration, scanning packets...");
    const started = performance.now();
    try {
      const scanned = await this.bindings.scanDuration(budgetMs);
      const elapsed = Math.round(performance.now() - started);
      if (scanned > 0) {
        Logger.info(TAG, `Recovered duration=${scanned}s by scan (${elapsed}ms)`);
        return scanned;
      }
      Logger.warn(TAG, `Duration scan found nothing usable (${elapsed}ms)`);
    } catch (e) {
      Logger.warn(TAG, `Duration scan failed: ${e}`);
    }
    return 0;
  }

  /**
   * Are this source's bytes free to read end-to-end? These skip the size gate
   * the missing-duration scan applies to everything else.
   *
   * A File or an object URL is disk- or memory-backed, so a full pass is free.
   * Loopback HTTP counts too, and has to: the desktop shell can't use file://
   * (the demuxer needs COOP/COEP, which file:// can't carry) so it serves
   * OS-opened files from 127.0.0.1 as /_local?p=<path>. Those arrive here as an
   * http: key even though every byte comes off the local disk — which is why
   * the scan quietly did nothing in the desktop app while working in the web
   * one on the same file.
   *
   * A loopback origin alone isn't sufficient, though: the same server also
   * exposes /_proxy?url=<remote> to stream a *remote* URL past CORS. So reject
   * any loopback URL that carries an absolute http(s) URL in its query — that's
   * the network wearing a local address.
   */
  private static isLocallyBacked(key: string): boolean {
    if (key.startsWith("file:") || key.startsWith("blob:")) return true;

    try {
      const base = typeof location !== "undefined" ? location.href : undefined;
      const url = new URL(key, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;

      const host = url.hostname;
      const isLoopback =
        host === "127.0.0.1" ||
        host === "localhost" ||
        host === "[::1]" ||
        host === "::1";
      if (!isLoopback) return false;

      for (const value of url.searchParams.values()) {
        if (/^https?:\/\//i.test(value)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Enumerate all tracks
   */
  private enumerateTracks(): Track[] {
    if (!this.bindings) return [];

    const tracks: Track[] = [];
    const count = this.bindings.getStreamCount();

    for (let i = 0; i < count; i++) {
      const info = this.bindings.getStreamInfo(i);
      if (!info) continue;

      const track = this.convertStreamInfo(info);
      if (track) {
        tracks.push(track);
      }
    }

    return tracks;
  }

  /**
   * Convert StreamInfo to Track
   */
  /**
   * Convert StreamInfo to Track
   */
  private convertStreamInfo(info: StreamInfo): Track | null {
    let track: Track | null = null;

    // Fetch extradata first if available (needed for color space extraction)
    let extradata: Uint8Array | null = null;
    if (this.bindings && info.extradataSize > 0) {
      extradata = this.bindings.getExtradata(info.index);
    }

    switch (info.type) {
      case 0: // Video
        track = {
          id: info.index,
          type: "video",
          codec: info.codecName,
          width: info.width,
          height: info.height,
          frameRate: info.frameRate,
          bitRate: info.bitRate,
          profile: info.profile,
          level: info.level,
          language: info.language ? info.language : undefined,
          label: info.label ? info.label : undefined,
          rotation: info.rotation,
          pixelFormat: info.pixelFormat,
          colorRange: info.colorRange,
          projection: info.projection || undefined,
          isAttachedPic: info.isAttachedPic || undefined,
        } as VideoTrack;

        // Store extradata on track
        if (extradata) {
          track.extradata = extradata;
        }

        const videoTrack = track as VideoTrack;

        // Use color metadata directly from FFmpeg/WASM if available and valid
        // NOTE: FFmpeg often returns 'unknown', 'reserved' or 'bt709' even for HDR content if it's not strictly flagged.
        // We will trust it if it explicitly says BT.2020 or SMPTE2084/HLG.
        if (
          info.colorPrimaries &&
          info.colorPrimaries !== "unknown" &&
          info.colorPrimaries !== "reserved"
        ) {
          videoTrack.colorPrimaries = this.normalizeColorPrimaries(
            info.colorPrimaries,
          );
        }
        if (
          info.colorTransfer &&
          info.colorTransfer !== "unknown" &&
          info.colorTransfer !== "reserved"
        ) {
          videoTrack.colorTransfer = this.normalizeColorTransfer(
            info.colorTransfer,
          );
        }
        if (
          info.colorMatrix &&
          info.colorMatrix !== "unknown" &&
          info.colorMatrix !== "reserved"
        ) {
          videoTrack.colorSpace = this.normalizeColorMatrix(info.colorMatrix);
        }

        // HDR Detection
        const primaries = (videoTrack.colorPrimaries || "").toLowerCase();
        const transfer = (videoTrack.colorTransfer || "").toLowerCase();
        const isHDRTransfer =
          transfer.includes("pq") ||
          transfer.includes("hlg") ||
          transfer.includes("smpte2084") ||
          transfer.includes("arib-std-b67");
        const isBT2020 =
          primaries.includes("bt2020") || primaries.includes("rec2020");

        videoTrack.isHDR = isHDRTransfer || isBT2020;

        // HEURISTIC: If we have 4K content but metadata says "bt709" or is missing,
        // it is extremely likely to be HDR. We should trust the parser heuristic in this case.
        // Many containers (MP4/MKV) don't carry the VUI in a way FFmpeg exposes easily without full parse.
        const isLikelyHDRResolution =
          videoTrack.width >= 3840 && videoTrack.height >= 2160;
        const currentPrimaries = videoTrack.colorPrimaries || "";
        const currentTransfer = videoTrack.colorTransfer || "";

        // If explicitly missing or "suspiciously SDR" for 4K, try heuristic
        if (
          !videoTrack.colorPrimaries ||
          !videoTrack.colorTransfer ||
          (isLikelyHDRResolution &&
            (currentPrimaries === "bt709" || currentTransfer === "bt709"))
        ) {
          const colorInfo = CodecParser.getColorSpaceInfo(
            info.codecName,
            extradata ?? undefined,
            info.width,
            info.height,
          );
          if (colorInfo) {
            if (colorInfo.colorPrimaries)
              videoTrack.colorPrimaries = colorInfo.colorPrimaries;
            if (colorInfo.colorTransfer)
              videoTrack.colorTransfer = colorInfo.colorTransfer;
            if (colorInfo.colorSpace)
              videoTrack.colorSpace = colorInfo.colorSpace;

            Logger.info(
              TAG,
              `Overriding/Filling Color Metadata via Heuristic: ${videoTrack.colorPrimaries}/${videoTrack.colorTransfer}`,
            );
          }
        }

        // Fallback for 10-bit profiles if metadata is still missing
        // If we know it's 10-bit HEVC but have no color info, default to HDR10
        if (
          (!videoTrack.colorPrimaries || !videoTrack.colorTransfer) &&
          videoTrack.codec.toLowerCase().startsWith("hvc1")
        ) {
          if (info.profile & 2 /* Main 10 */) {
            videoTrack.colorPrimaries = "bt2020";
            videoTrack.colorTransfer = "smpte2084";
            videoTrack.colorSpace = "bt2020-ncl";
            Logger.info(
              TAG,
              `Fallback: Assuming HDR10 for HEVC Main 10 profile without metadata`,
            );
          }
        }

        Logger.info(
          TAG,
          `Video Track Metadata: codec=${videoTrack.codec}, primaries=${videoTrack.colorPrimaries}, transfer=${videoTrack.colorTransfer}, matrix=${videoTrack.colorSpace}`,
        );
        break;

      case 1: // Audio
        track = {
          id: info.index,
          type: "audio",
          codec: info.codecName,
          channels: info.channels,
          sampleRate: info.sampleRate,
          bitRate: info.bitRate,
          language: info.language ? info.language : undefined,
          label: info.label ? info.label : undefined,
        } as AudioTrack;
        break;

      case 2: // Subtitle
        track = {
          id: info.index,
          type: "subtitle",
          codec: info.codecName,
          subtitleType: this.isImageSubtitle(info.codecName) ? "image" : "text",
          language: info.language ? info.language : undefined,
          label: info.label ? info.label : undefined,
        } as SubtitleTrack;
        break;
    }

    // Extradata is already fetched and set above for video tracks
    // For audio/subtitle tracks, set extradata if available
    if (track && track.type !== "video" && extradata) {
      track.extradata = extradata;
    }

    // Per-stream duration, kept because it is the only place the container
    // says a stream ENDS BEFORE THE FILE DOES — a recording whose camera cut
    // out while the mic ran on has 80s of video inside a 161s file, and
    // without this the pipeline has no way to tell that apart from video
    // that simply stopped arriving. See MoviPlayer's audio-only tail.
    if (track && info.duration > 0) {
      track.duration = info.duration;
    }

    return track;
  }

  /**
   * Check if subtitle codec is image-based
   */
  private isImageSubtitle(codec: string): boolean {
    const imageCodecs = ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"];
    return imageCodecs.includes(codec.toLowerCase());
  }

  /**
   * Normalize FFmpeg color primaries to WebCodecs enum values
   */
  private normalizeColorPrimaries(primaries: string): string {
    switch (primaries.toLowerCase()) {
      case "bt2020":
        return "bt2020";
      case "bt709":
        return "bt709";
      case "bt470bg":
        return "bt470bg";
      case "smpte170m":
        return "smpte170m";
      default:
        return primaries;
    }
  }

  /**
   * Normalize FFmpeg color transfer to WebCodecs enum values
   */
  private normalizeColorTransfer(transfer: string): string {
    switch (transfer.toLowerCase()) {
      case "smpte2084":
        return "smpte2084"; // PQ
      case "arib-std-b67":
        return "arib-std-b67"; // HLG
      case "bt709":
        return "bt709";
      case "smpte170m":
        return "smpte170m";
      case "linear":
        return "linear";
      case "iec61966-2-1":
        return "iec61966-2-1"; // sRGB
      default:
        return transfer;
    }
  }

  /**
   * Normalize FFmpeg color matrix names to WebCodecs enum values
   */
  private normalizeColorMatrix(matrix: string): string {
    switch (matrix.toLowerCase()) {
      case "bt2020nc":
        return "bt2020-ncl";
      case "bt2020c":
        return "bt2020-cl";
      case "smpte170m":
        return "smpte170m"; // Ensure this stays as is
      case "bt709":
        return "bt709";
      case "bt470bg":
        return "bt470bg";
      default:
        return matrix;
    }
  }

  /**
   * Get all tracks
   */
  getTracks(): Track[] {
    return [...this.tracks];
  }

  /**
   * Get video tracks
   */
  getVideoTracks(): VideoTrack[] {
    return this.tracks.filter((t): t is VideoTrack => t.type === "video");
  }

  /**
   * Get audio tracks
   */
  getAudioTracks(): AudioTrack[] {
    return this.tracks.filter((t): t is AudioTrack => t.type === "audio");
  }

  /**
   * Get subtitle tracks
   */
  getSubtitleTracks(): SubtitleTrack[] {
    return this.tracks.filter((t): t is SubtitleTrack => t.type === "subtitle");
  }

  /**
   * Get extradata for a track
   */
  getExtradata(trackId: number): Uint8Array | null {
    return this.bindings?.getExtradata(trackId) ?? null;
  }

  /**
   * Seek to timestamp (async due to Asyncify)
   */
  async seek(timestamp: number, flags: number = 1): Promise<void> {
    if (!this.bindings || !this.isOpened) {
      throw new Error("Demuxer not opened");
    }

    await this.bindings.seek(timestamp, -1, flags);
  }

  /**
   * Read next packet (async due to Asyncify)
   */
  async readPacket(): Promise<Packet | null> {
    if (!this.bindings || !this.isOpened) {
      throw new Error("Demuxer not opened");
    }

    const result = await this.bindings.readFrame();
    if (!result) return null;

    return {
      streamIndex: result.info.streamIndex,
      keyframe: result.info.keyframe,
      timestamp: result.info.pts,
      dts: result.info.dts,
      duration: result.info.duration,
      data: result.data,
      isIdr: result.info.isIdr,
      isRasl: result.info.isRasl,
      disposable: result.info.disposable,
    };
  }

  /**
   * Get duration
   */
  getDuration(): number {
    return this.duration;
  }

  /**
   * Close and cleanup
   */
  close(): void {
    if (this.bindings) {
      this.bindings.destroy();
      this.bindings = null;
    }
    if (this._holdsSharedModule) {
      this._holdsSharedModule = false;
      releaseSharedModule();
    }

    this.isOpened = false;
    this.tracks = [];

    Logger.info(TAG, "Demuxer closed");
  }

  /**
   * Extract embedded cover art (attached_pic) as the raw encoded image
   * bytes (jpeg / png), or null if the source has none.
   *
   * Runs in a short-lived, isolated WASM context — NOT the live playback
   * demuxer — so reading the artwork packet never moves the main read
   * position and can't disturb playback or seeking. The cover art is the
   * single keyframe of the still-image "video" stream, so readKeyframe(0)
   * returns its packet directly; no decode pass and no extra C exports
   * are needed (a dedicated movi_get_attached_pic_data export would shift
   * the WASM layout and trip a latent FFmpeg audio overflow — see project
   * memory "Album Art Crashes WASM"). Caller owns MIME-typing and decode
   * into an ImageBitmap. Best-effort: any failure resolves to null.
   */
  static async extractAttachedPicture(
    source: SourceAdapter,
    fileSize: number,
    wasmBinary?: Uint8Array,
  ): Promise<Uint8Array | null> {
    if (fileSize <= 0) return null;
    let bindings: ThumbnailBindings | null = null;
    try {
      const module = await loadWasmModuleNew({ wasmBinary });
      bindings = new ThumbnailBindings(module);
      bindings.setDataSource({
        read: async (offset: number, size: number): Promise<Uint8Array> =>
          new Uint8Array(await source.read(offset, size)),
        getSize: async (): Promise<number> => fileSize,
      });
      if (!(await bindings.create(fileSize))) return null;
      if (!(await bindings.open())) return null;
      const size = await bindings.readKeyframe(0);
      if (size <= 0) return null;
      return bindings.getPacketDataCopy(size);
    } catch (e) {
      Logger.warn(TAG, "Attached-picture extraction failed", e);
      return null;
    } finally {
      // Tear the isolated context down immediately — one frame is all we
      // need; keeping a second WASM heap alive for a static image is waste.
      bindings?.destroy();
    }
  }

  getBindings(): WasmBindings | null {
    return this.bindings;
  }

  getModule(): MoviWasmModule | null {
    return this.module;
  }
}
