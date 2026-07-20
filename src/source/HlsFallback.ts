/**
 * HlsFallback - HLS analog of DashFallback.
 *
 * When both Shaka and hls.js fail an HLS stream (a codec the browser's MSE
 * genuinely can't decode), there's no single demuxable file the way a
 * single-Representation DASH source gives us — HLS is a list of segments. This
 * parses the playlist into an ordered segment list (with per-segment durations
 * and any BYTERANGE), which SegmentStreamSource then presents to the FFmpeg-WASM
 * demuxer as one concatenated, seekable stream.
 *
 * MVP scope: muxed variant only (video+audio in the same segments). Separate
 * audio / subtitle renditions and a quality menu are deferred.
 */
import { Logger } from "../utils/Logger";

const TAG = "HlsFallback";

export interface HlsSegment {
  url: string;
  duration: number;
  /** Set for #EXT-X-BYTERANGE segments (all slices of one resource). */
  byteRange?: { length: number; offset: number };
}

export interface HlsFallbackPlan {
  segments: HlsSegment[];
  /** fMP4 (CMAF) initialization segment from #EXT-X-MAP, absolute. */
  initSegment?: string;
  totalDuration: number;
  container: "ts" | "mp4";
  /** No #EXT-X-ENDLIST → live. The map is a snapshot; seeking is limited. */
  isLive: boolean;
}

function resolveUrl(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

async function fetchText(
  url: string,
  headers?: Record<string, string>,
): Promise<string> {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`HLS playlist HTTP ${res.status}`);
  return res.text();
}

function isMaster(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF");
}

/** Master playlist → the highest-BANDWIDTH variant's media playlist URL. */
function pickBestVariant(text: string, base: string): string | null {
  const lines = text.split(/\r?\n/);
  let best: { bandwidth: number; url: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bwMatch = /[^-]BANDWIDTH=(\d+)/.exec("," + line);
    const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    // The URI is the next non-blank, non-comment line.
    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j].trim() === "" || lines[j].trim().startsWith("#"))
    )
      j++;
    if (j < lines.length) {
      const url = resolveUrl(lines[j].trim(), base);
      if (!best || bandwidth > best.bandwidth) best = { bandwidth, url };
    }
  }
  return best ? best.url : null;
}

/** Media playlist → ordered segments + init + container + live flag. */
function parseMediaPlaylist(text: string, base: string): HlsFallbackPlan {
  const lines = text.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  let initSegment: string | undefined;
  let container: "ts" | "mp4" = "ts";
  let isLive = true;
  let pendingDuration = 0;
  let pendingByteRange: { length: number; offset: number } | undefined;
  // #EXT-X-BYTERANGE without an explicit @offset continues from the previous
  // sub-range of the same resource.
  let byteRangeCursor = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#EXTINF:")) {
      const m = /#EXTINF:([\d.]+)/.exec(line);
      pendingDuration = m ? parseFloat(m[1]) : 0;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const uriM = /URI="([^"]+)"/.exec(line);
      if (uriM) {
        initSegment = resolveUrl(uriM[1], base);
        container = "mp4";
      }
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const m = /#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/.exec(line);
      if (m) {
        const length = parseInt(m[1], 10);
        const offset = m[2] !== undefined ? parseInt(m[2], 10) : byteRangeCursor;
        pendingByteRange = { length, offset };
        byteRangeCursor = offset + length;
      }
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      isLive = false;
    } else if (!line.startsWith("#")) {
      const url = resolveUrl(line, base);
      if (!initSegment && /\.(mp4|m4s|cmf[va]?|fmp4)(\?|$)/i.test(line)) {
        container = "mp4";
      }
      segments.push({ url, duration: pendingDuration, byteRange: pendingByteRange });
      pendingDuration = 0;
      pendingByteRange = undefined;
    }
  }

  const totalDuration = segments.reduce((s, seg) => s + seg.duration, 0);
  return { segments, initSegment, container, isLive, totalDuration };
}

/**
 * Fetch and parse an HLS playlist (master or media) into a demuxable segment
 * plan. Returns null when there's nothing playable (no variant / no segments).
 */
export async function analyzeHlsFallback(
  url: string,
  headers?: Record<string, string>,
): Promise<HlsFallbackPlan | null> {
  try {
    let text = await fetchText(url, headers);
    let base = url;
    if (isMaster(text)) {
      const variantUrl = pickBestVariant(text, url);
      if (!variantUrl) {
        Logger.warn(TAG, "master playlist has no usable variant");
        return null;
      }
      base = variantUrl;
      text = await fetchText(variantUrl, headers);
    }
    const plan = parseMediaPlaylist(text, base);
    if (plan.segments.length === 0) {
      Logger.warn(TAG, "media playlist has no segments");
      return null;
    }
    Logger.info(
      TAG,
      `HLS fallback → ${plan.segments.length} ${plan.container} segments, ${plan.totalDuration.toFixed(
        1,
      )}s${plan.isLive ? " (live snapshot)" : ""}${plan.initSegment ? " +init" : ""}`,
    );
    return plan;
  } catch (e) {
    Logger.warn(TAG, "HLS fallback probe failed", e);
    return null;
  }
}
