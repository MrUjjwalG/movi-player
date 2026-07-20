/**
 * HlsFallback - HLS analog of DashFallback.
 *
 * When both Shaka and hls.js fail an HLS stream (a codec the browser's MSE
 * genuinely can't decode), there's no single demuxable file the way a
 * single-Representation DASH source gives us — HLS is a list of segments. This
 * parses the playlist into ordered segment lists (with per-segment durations
 * and any BYTERANGE), which SegmentStreamSource then presents to the FFmpeg-WASM
 * demuxer as one concatenated, seekable stream.
 *
 * Handles the master playlist's alternate renditions too: a video-only variant
 * with a separate #EXT-X-MEDIA:TYPE=AUDIO group (each audio language is its own
 * segment playlist, surfaced as split-audio tracks) and TYPE=SUBTITLES groups
 * (segmented WebVTT, concatenated by the caller).
 */
import { Logger } from "../utils/Logger";

const TAG = "HlsFallback";

export interface HlsSegment {
  url: string;
  duration: number;
  /** Set for #EXT-X-BYTERANGE segments (all slices of one resource). */
  byteRange?: { length: number; offset: number };
}

/** A media-playlist parse result (video/muxed, an audio language, or subs). */
export interface HlsMediaTrack {
  segments: HlsSegment[];
  initSegment?: string;
  container: "ts" | "mp4";
  totalDuration: number;
  isLive: boolean;
}

export interface HlsAudioRendition extends HlsMediaTrack {
  lang: string;
  label: string;
  isDefault: boolean;
}

export interface HlsSubtitleRendition {
  lang: string;
  label: string;
  segments: HlsSegment[]; // WebVTT segment files
  isDefault: boolean;
}

export interface HlsFallbackPlan {
  /** Video (or muxed video+audio) segments. */
  segments: HlsSegment[];
  initSegment?: string;
  container: "ts" | "mp4";
  totalDuration: number;
  isLive: boolean;
  /** Separate audio languages (present only when the variant has an AUDIO group). */
  audioRenditions?: HlsAudioRendition[];
  /** Subtitle languages (segmented WebVTT). */
  subtitleRenditions?: HlsSubtitleRendition[];
  /**
   * Selectable video qualities (the master's variants in the chosen audio
   * group, best-first). `url` is the variant playlist URL — pass it back as
   * `forceVariantUrl` to switch quality. Present only when there's a choice.
   */
  videoTracks?: { url: string; label: string; id: string }[];
  /** The variant playlist URL this plan was built from (the active quality). */
  selectedVariant?: string;
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

/** Parse an EXT-X tag's comma-separated attribute list (quoted values allowed). */
function parseAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = line.slice(line.indexOf(":") + 1);
  // Split on commas that are not inside quotes.
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return attrs;
}

interface MediaTag {
  type: string;
  groupId: string;
  name: string;
  language: string;
  uri?: string;
  isDefault: boolean;
}

interface VariantTag {
  bandwidth: number;
  hasVideo: boolean;
  height: number;
  audioGroup?: string;
  subtitlesGroup?: string;
  url: string;
}

/** Parse a master playlist into its media tags + variants. */
function parseMaster(
  text: string,
  base: string,
): { media: MediaTag[]; variants: VariantTag[] } {
  const lines = text.split(/\r?\n/);
  const media: MediaTag[] = [];
  const variants: VariantTag[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttrs(line);
      media.push({
        type: a["TYPE"] || "",
        groupId: a["GROUP-ID"] || "",
        name: a["NAME"] || "",
        language: a["LANGUAGE"] || "",
        uri: a["URI"] ? resolveUrl(a["URI"], base) : undefined,
        isDefault: a["DEFAULT"] === "YES",
      });
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttrs(line);
      const codecs = a["CODECS"] || "";
      const hasVideo =
        !!a["RESOLUTION"] || /avc|hvc|hev|vp0?9|av01|mp4v|dvh/i.test(codecs);
      const resM = /(\d+)x(\d+)/.exec(a["RESOLUTION"] || "");
      const height = resM ? parseInt(resM[2], 10) : 0;
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j].trim() === "" || lines[j].trim().startsWith("#"))
      )
        j++;
      if (j < lines.length) {
        variants.push({
          bandwidth: parseInt(a["BANDWIDTH"] || "0", 10),
          hasVideo,
          height,
          audioGroup: a["AUDIO"] || undefined,
          subtitlesGroup: a["SUBTITLES"] || undefined,
          url: resolveUrl(lines[j].trim(), base),
        });
      }
    }
  }
  return { media, variants };
}

/** Parse a media playlist → ordered segments + init + container + live flag. */
function parseMediaPlaylist(text: string, base: string): HlsMediaTrack {
  const lines = text.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  let initSegment: string | undefined;
  let container: "ts" | "mp4" = "ts";
  let isLive = true;
  let pendingDuration = 0;
  let pendingByteRange: { length: number; offset: number } | undefined;
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
      if (/\.(vtt|webvtt)(\?|$)/i.test(line)) container = "ts"; // n/a for subs
      segments.push({ url, duration: pendingDuration, byteRange: pendingByteRange });
      pendingDuration = 0;
      pendingByteRange = undefined;
    }
  }

  const totalDuration = segments.reduce((s, seg) => s + seg.duration, 0);
  return { segments, initSegment, container, isLive, totalDuration };
}

// --- WebVTT segment concatenation ---------------------------------------

/**
 * Presentation offset (seconds) from a segment's X-TIMESTAMP-MAP, to add to
 * its LOCAL cue times: presentation = LOCAL + (MPEGTS/90000 − LOCAL_base).
 */
function vttTimestampOffset(text: string): number {
  const m = /X-TIMESTAMP-MAP=[^\n]*MPEGTS:(\d+)[^\n]*LOCAL:(\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(
    text,
  );
  if (!m) return 0;
  const mpegts = parseInt(m[1], 10) / 90000;
  const local = +m[2] * 3600 + +m[3] * 60 + +m[4] + +m[5] / 1000;
  return mpegts - local;
}

function parseVttTime(s: string): number {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/.exec(s);
  if (!m) return NaN;
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function fmtVttTime(t: number): string {
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${String(ms).padStart(3, "0")}`;
}

/**
 * Concatenate the WebVTT bodies of an HLS subtitle rendition's segments into
 * one VTT document with presentation-absolute cue times (each segment's cues
 * shifted by its X-TIMESTAMP-MAP offset). Non-cue blocks (STYLE/NOTE/REGION)
 * and duplicate WEBVTT headers are dropped.
 */
export function buildVttFromSegments(texts: string[]): string {
  const cueBlocks: string[] = [];
  const seen = new Set<string>();
  // Baseline = the first segment's presentation offset (the media start PTS).
  // Subtract it so cue times come out 0-based (relative to content start),
  // matching movi's timeline — getCurrentTime() subtracts the media startTime,
  // and external cues are matched against it. Without this, cues land ~startTime
  // seconds late (e.g. a TS stream whose first PTS is ~10s).
  let baseline: number | null = null;
  for (const raw of texts) {
    if (!raw || !raw.includes("-->")) continue;
    const rawOffset = vttTimestampOffset(raw);
    if (baseline === null) baseline = rawOffset;
    const offset = rawOffset - baseline;
    const blocks = raw.replace(/^﻿/, "").split(/\r?\n\r?\n/);
    for (const block of blocks) {
      if (!block.includes("-->")) continue; // header / STYLE / NOTE / REGION
      const shifted = block.replace(
        /([\d:.]+)\s*-->\s*([\d:.]+)([^\n]*)/,
        (_, a: string, b: string, rest: string) =>
          `${fmtVttTime(parseVttTime(a) + offset)} --> ${fmtVttTime(
            parseVttTime(b) + offset,
          )}${rest}`,
      );
      // Overlapping HLS segments repeat boundary cues — de-dupe.
      if (seen.has(shifted)) continue;
      seen.add(shifted);
      cueBlocks.push(shifted.trim());
    }
  }
  return "WEBVTT\n\n" + cueBlocks.join("\n\n") + "\n";
}

async function loadMediaTrack(
  url: string,
  headers?: Record<string, string>,
): Promise<HlsMediaTrack | null> {
  try {
    const text = await fetchText(url, headers);
    const track = parseMediaPlaylist(text, url);
    return track.segments.length > 0 ? track : null;
  } catch (e) {
    Logger.warn(TAG, `media playlist load failed: ${url}`, e);
    return null;
  }
}

/**
 * Fetch and parse an HLS playlist (master or media) into a demuxable plan.
 * Returns null when there's nothing playable.
 */
export async function analyzeHlsFallback(
  url: string,
  headers?: Record<string, string>,
  forceVariantUrl?: string,
): Promise<HlsFallbackPlan | null> {
  try {
    const text = await fetchText(url, headers);

    // Media playlist directly (muxed, no alternate renditions).
    if (!isMaster(text)) {
      const track = parseMediaPlaylist(text, url);
      if (track.segments.length === 0) {
        Logger.warn(TAG, "media playlist has no segments");
        return null;
      }
      Logger.info(
        TAG,
        `HLS fallback → ${track.segments.length} ${track.container} segments, ${track.totalDuration.toFixed(1)}s (muxed)`,
      );
      return { ...track };
    }

    // Master: pick a video variant (a forced quality, else the best), then
    // resolve its audio/subtitle groups.
    const { media, variants } = parseMaster(text, url);
    const videoVariants = variants.filter((v) => v.hasVideo);
    const pool = videoVariants.length > 0 ? videoVariants : variants;
    const highest = pool.reduce(
      (a, b) => (b.bandwidth > a.bandwidth ? b : a),
      pool[0],
    );
    const best =
      (forceVariantUrl && pool.find((v) => v.url === forceVariantUrl)) || highest;
    if (!best) {
      Logger.warn(TAG, "master playlist has no usable variant");
      return null;
    }

    const videoTrack = await loadMediaTrack(best.url, headers);
    if (!videoTrack) {
      Logger.warn(TAG, "best variant media playlist unusable");
      return null;
    }

    const plan: HlsFallbackPlan = { ...videoTrack };
    plan.selectedVariant = best.url;

    // Quality menu: the video variants in the chosen variant's audio group
    // (so switching keeps the same audio), one per resolution, best-first.
    const sameGroup = pool.filter((v) => v.audioGroup === best.audioGroup);
    const heightCounts = new Map<number, number>();
    for (const v of sameGroup)
      heightCounts.set(v.height, (heightCounts.get(v.height) || 0) + 1);
    const byHeight = new Map<number, VariantTag>();
    for (const v of sameGroup) {
      const cur = byHeight.get(v.height);
      if (!cur || v.bandwidth > cur.bandwidth) byHeight.set(v.height, v);
    }
    const uniqueVariants = [...byHeight.values()].sort(
      (a, b) => b.height - a.height || b.bandwidth - a.bandwidth,
    );
    if (uniqueVariants.length > 1) {
      plan.videoTracks = uniqueVariants.map((v) => ({
        url: v.url,
        id: v.url,
        label: v.height
          ? `${v.height}p`
          : `${Math.round(v.bandwidth / 1000)} kbps`,
      }));
    }

    // Separate audio group → one rendition per language (segment playlists).
    if (best.audioGroup) {
      const audioTags = media.filter(
        (m) => m.type === "AUDIO" && m.groupId === best.audioGroup && m.uri,
      );
      const loaded = await Promise.all(
        audioTags.map(async (t) => {
          const track = await loadMediaTrack(t.uri!, headers);
          if (!track) return null;
          const rendition: HlsAudioRendition = {
            ...track,
            lang: t.language || "und",
            label: t.name || t.language || "Audio",
            isDefault: t.isDefault,
          };
          return rendition;
        }),
      );
      const audioRenditions = loaded.filter((r): r is HlsAudioRendition => !!r);
      if (audioRenditions.length > 0) plan.audioRenditions = audioRenditions;
    }

    // Subtitle group → segmented WebVTT per language.
    if (best.subtitlesGroup) {
      const subTags = media.filter(
        (m) =>
          m.type === "SUBTITLES" && m.groupId === best.subtitlesGroup && m.uri,
      );
      const loaded = await Promise.all(
        subTags.map(async (t) => {
          const track = await loadMediaTrack(t.uri!, headers);
          if (!track) return null;
          const rendition: HlsSubtitleRendition = {
            lang: t.language || "und",
            label: t.name || t.language || "Subtitle",
            segments: track.segments,
            isDefault: t.isDefault,
          };
          return rendition;
        }),
      );
      const subtitleRenditions = loaded.filter(
        (r): r is HlsSubtitleRendition => !!r,
      );
      if (subtitleRenditions.length > 0) plan.subtitleRenditions = subtitleRenditions;
    }

    Logger.info(
      TAG,
      `HLS fallback → ${plan.segments.length} ${plan.container} video segments, ${plan.totalDuration.toFixed(
        1,
      )}s${plan.audioRenditions ? `, ${plan.audioRenditions.length} audio lang(s)` : " (muxed audio)"}${
        plan.subtitleRenditions ? `, ${plan.subtitleRenditions.length} subtitle(s)` : ""
      }${plan.isLive ? " (live snapshot)" : ""}`,
    );
    return plan;
  } catch (e) {
    Logger.warn(TAG, "HLS fallback probe failed", e);
    return null;
  }
}
