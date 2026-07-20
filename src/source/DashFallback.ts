/**
 * Fallback resolver for MPEG-DASH manifests the MSE engines (Shaka / hls.js /
 * dash.js) refuse or can't play — so movi's own FFmpeg-WASM demuxer takes over.
 *
 * It targets the "single file per Representation" shape: each Representation is
 * one complete (fragmented) MP4 addressed by a <BaseURL>, either with NO segment
 * addressing at all, or with a <SegmentBase> that merely indexes the sidx INSIDE
 * that one file. Both are ordinary MP4s the FFmpeg demuxer reads whole via range
 * requests. (SegmentTemplate / SegmentList split media across many separate
 * files and are NOT handled here — that needs a segment-streaming source.)
 *
 * Two failure modes this recovers:
 *  - Shaka is strict and skips single-file-with-SegmentBase Representations
 *    ("does not contain a segment information source"), failing the load with
 *    DASH_EMPTY_PERIOD (4004).
 *  - The browser's MSE can't decode the stream's codec (e.g. Safari + HE-AAC),
 *    so Shaka loads the manifest but appendBuffer fails (error 3014). The WASM
 *    demuxer decodes every codec, so routing the same file through it plays.
 *
 * This module probes the manifest and, when it finds the single-file case,
 * resolves the best video file URL plus (for demuxed content) the separate
 * audio file URL, so the caller can play them through the demuxer (+ a native
 * <audio> element / audioSource for the split audio).
 *
 * Returns null when every Representation is multi-segment (SegmentTemplate /
 * SegmentList), so Shaka's failure was for a reason this fallback can't help.
 */

import { Logger } from "../utils/Logger";

const TAG = "DashFallback";

const AUDIO_CODEC_RE = /\b(mp4a|ac-3|ec-3|ac-4|opus|vorbis|flac|dtsc|dtse)\b/i;
const VIDEO_CODEC_RE = /\b(avc[13]|hvc1|hev1|vp0[89]|vp8|vp9|av01|dvh)/i;

export interface DashFallbackPlan {
  /** Single-file video (or muxed) Representation to feed the demuxer. */
  videoUrl: string;
  /** Separate audio file for demuxed content; omitted when muxed/audio-only. */
  audioUrl?: string;
  /**
   * Sidecar caption files (single-file WebVTT/SRT text Representations) so the
   * demuxer path can surface them as external subtitle tracks — otherwise the
   * manifest's captions would be lost when we leave the MSE engine.
   */
  subtitles?: {
    url: string;
    lang: string;
    label: string;
    format?: "vtt" | "srt" | "ttml";
  }[];
  /**
   * One audio Representation per LANGUAGE (best bitrate, best-first), so the
   * demuxer path offers the same language menu the stream engine had. Bitrate
   * variants of one language are collapsed (that's ABR, not a track). `lang` is
   * the BCP-47 key; `label` is the display name. Present only when 2+ distinct
   * languages exist; a single language uses `audioUrl`.
   */
  audioTracks?: { url: string; lang: string; label: string }[];
  /**
   * Every selectable video Representation (best-first) with a display label
   * (e.g. "1080p"), so the demuxer path can offer a quality menu. Switching a
   * quality re-loads the main source with that Representation's file. Present
   * only when there's more than one.
   */
  videoTracks?: { url: string; label: string; id: string }[];
}

/** BCP-47 code → human language name (viewer's locale), falling back to the code. */
function langName(code: string): string {
  const base = (code || "").split("-")[0];
  if (!base || base === "und") return "Audio";
  try {
    const locale =
      (typeof navigator !== "undefined" && navigator.language) || "en";
    return (
      new Intl.DisplayNames([locale], { type: "language" }).of(base) ||
      base.toUpperCase()
    );
  } catch {
    return base.toUpperCase();
  }
}

/** Resolve a (possibly relative) URL against a base. */
function resolve(base: string, rel: string | null | undefined): string {
  if (!rel) return base;
  try {
    return new URL(rel, base).href;
  } catch {
    return base;
  }
}

/** First <BaseURL> text child of an element, if any. */
function baseUrlOf(el: Element | null): string | null {
  if (!el) return null;
  for (const child of Array.from(el.children)) {
    if (child.localName === "BaseURL") return child.textContent?.trim() || null;
  }
  return null;
}

/**
 * A Representation is a single demuxable file when it has a BaseURL and no
 * MULTI-segment addressing. SegmentTemplate / SegmentList split the media into
 * many separate segment files, which the whole-file demuxer can't follow. A
 * SegmentBase, by contrast, only points at the `sidx` index INSIDE an otherwise
 * complete single file — the FFmpeg demuxer reads that file whole via range
 * requests and ignores the index hint, so it counts as single-file here. This
 * is the common "one fragmented-MP4 per Representation" VOD case (e.g. the
 * Elephants Dream test stream) that Shaka rejects but the demuxer plays fine —
 * including codecs the browser's MSE can't decode (Safari + HE-AAC).
 */
function isSingleFileRepresentation(rep: Element, adaptation: Element): boolean {
  if (!baseUrlOf(rep)) return false;
  const hasMultiSegment = (el: Element) =>
    el.getElementsByTagName("SegmentTemplate").length > 0 ||
    el.getElementsByTagName("SegmentList").length > 0;
  return !hasMultiSegment(rep) && !hasMultiSegment(adaptation);
}

function contentTypeOf(
  rep: Element,
  adaptation: Element,
): "audio" | "video" | "text" | "other" {
  const ct = (
    adaptation.getAttribute("contentType") ||
    rep.getAttribute("mimeType") ||
    adaptation.getAttribute("mimeType") ||
    ""
  ).toLowerCase();
  if (ct.includes("audio")) return "audio";
  if (ct.includes("video")) return "video";
  if (ct.includes("text") || ct.includes("vtt") || ct.includes("ttml"))
    return "text";
  const codecs = rep.getAttribute("codecs") || adaptation.getAttribute("codecs") || "";
  if (VIDEO_CODEC_RE.test(codecs)) return "video";
  if (AUDIO_CODEC_RE.test(codecs)) return "audio";
  return "other";
}

/**
 * Probe a DASH manifest for the bare-BaseURL single-file case. Returns the video
 * (and any separate audio) file URLs, or null if it's not that case.
 */
export async function analyzeDashFallback(
  manifestUrl: string,
  headers?: Record<string, string>,
): Promise<DashFallbackPlan | null> {
  let xml: string;
  try {
    const res = await fetch(manifestUrl, { headers });
    if (!res.ok) return null;
    xml = await res.text();
  } catch (e) {
    Logger.warn(TAG, "Failed to fetch DASH manifest for fallback", e);
    return null;
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const mpd = doc.getElementsByTagName("MPD")[0];
  if (!mpd) return null;

  const mpdBase = resolve(manifestUrl, baseUrlOf(mpd));

  let bestVideo: { url: string; bw: number; muxed: boolean } | null = null;
  let bestAudio: { url: string; bw: number } | null = null;
  const subtitles: {
    url: string;
    lang: string;
    label: string;
    format?: "vtt" | "srt" | "ttml";
  }[] = [];
  const audioReps: { url: string; lang: string; bw: number; id: string }[] = [];
  const videoReps: {
    url: string;
    bw: number;
    height: number;
    id: string;
    muxed: boolean;
  }[] = [];

  // First period only — these single-file manifests are single-period VOD.
  const period = mpd.getElementsByTagName("Period")[0];
  if (!period) return null;
  const periodBase = resolve(mpdBase, baseUrlOf(period));

  for (const adaptation of Array.from(period.getElementsByTagName("AdaptationSet"))) {
    const adaptationBase = resolve(periodBase, baseUrlOf(adaptation));
    for (const rep of Array.from(adaptation.getElementsByTagName("Representation"))) {
      if (!isSingleFileRepresentation(rep, adaptation)) continue;
      const url = resolve(adaptationBase, baseUrlOf(rep));
      const bw = parseInt(rep.getAttribute("bandwidth") || "0", 10);
      const type = contentTypeOf(rep, adaptation);
      const codecs = rep.getAttribute("codecs") || adaptation.getAttribute("codecs") || "";
      const muxed = AUDIO_CODEC_RE.test(codecs) && VIDEO_CODEC_RE.test(codecs);

      if (type === "video") {
        if (!bestVideo || bw > bestVideo.bw) bestVideo = { url, bw, muxed };
        const height = parseInt(
          rep.getAttribute("height") || adaptation.getAttribute("height") || "0",
          10,
        );
        const id = rep.getAttribute("id") || String(bw);
        if (!videoReps.some((v) => v.url === url)) {
          videoReps.push({ url, bw, height, id, muxed });
        }
      } else if (type === "audio") {
        if (!bestAudio || bw > bestAudio.bw) bestAudio = { url, bw };
        const lang =
          adaptation.getAttribute("lang") || rep.getAttribute("lang") || "und";
        const id = rep.getAttribute("id") || String(bw);
        if (!audioReps.some((a) => a.url === url)) {
          audioReps.push({ url, lang, bw, id });
        }
      } else if (type === "text") {
        // Single-file sidecar caption — WebVTT, SRT, or TTML (all rendered by
        // movi's external-subtitle path). Segmented text still isn't handled
        // (isSingleFileRepresentation already excluded it above).
        const mime = (
          adaptation.getAttribute("mimeType") ||
          rep.getAttribute("mimeType") ||
          ""
        ).toLowerCase();
        let format: "vtt" | "srt" | "ttml" | undefined;
        if (/\.vtt(\?|#|$)/i.test(url) || /vtt/.test(mime)) format = "vtt";
        else if (/\.srt(\?|#|$)/i.test(url)) format = "srt";
        else if (/\.(ttml|dfxp)(\?|#|$)/i.test(url) || /ttml|dfxp/.test(mime))
          format = "ttml";
        if (format) {
          const lang =
            adaptation.getAttribute("lang") || rep.getAttribute("lang") || "und";
          const label =
            adaptation.getAttribute("label") ||
            rep.getAttribute("id") ||
            lang.toUpperCase();
          if (!subtitles.some((s) => s.url === url)) {
            subtitles.push({ url, lang, label, format });
          }
        }
      }
    }
  }

  // No bare-BaseURL Representations → Shaka failed for another reason.
  if (!bestVideo && !bestAudio) return null;

  // Audio-only manifest: play the audio file through the demuxer directly.
  if (!bestVideo && bestAudio) {
    Logger.info(TAG, `DASH fallback (audio-only) → ${bestAudio.url}`);
    return { videoUrl: bestAudio.url };
  }

  const plan: DashFallbackPlan = { videoUrl: bestVideo!.url };
  // Muxed file already carries audio; otherwise attach the separate audio file.
  if (!bestVideo!.muxed && bestAudio) plan.audioUrl = bestAudio.url;
  if (subtitles.length > 0) plan.subtitles = subtitles;
  // Collapse bitrate variants to the best Representation per language, then
  // expose an audio menu only when there are 2+ distinct LANGUAGES. Bitrate
  // within one language is an ABR/quality axis, not a separate audio track —
  // showing "English · 48 kbps / · 64 kbps" would be a manual bitrate picker no
  // mainstream player offers. Matches the dash.js/hls.js stream path, where a
  // single-language multi-bitrate audio shows no selector. A lone language
  // falls through to plan.audioUrl (bestAudio = highest bitrate).
  if (!bestVideo!.muxed && audioReps.length > 1) {
    const bestPerLang = new Map<string, (typeof audioReps)[number]>();
    for (const a of audioReps) {
      const cur = bestPerLang.get(a.lang);
      if (!cur || a.bw > cur.bw) bestPerLang.set(a.lang, a);
    }
    if (bestPerLang.size > 1) {
      plan.audioTracks = Array.from(bestPerLang.values())
        .sort((a, b) => b.bw - a.bw)
        .map((a) => ({
          url: a.url,
          lang: a.lang,
          label: langName(a.lang),
        }));
    }
  }
  // More than one video Representation → expose a quality menu, best-first.
  // Label by height ("1080p") when known, else bitrate.
  if (videoReps.length > 1) {
    const heightCounts: Record<number, number> = {};
    for (const v of videoReps) heightCounts[v.height] = (heightCounts[v.height] || 0) + 1;
    plan.videoTracks = videoReps
      .slice()
      .sort((a, b) => b.bw - a.bw)
      .map((v) => ({
        url: v.url,
        id: v.id,
        label:
          v.height > 0
            ? // Two renditions at the same height → disambiguate with bitrate.
              heightCounts[v.height] > 1
              ? `${v.height}p · ${Math.round(v.bw / 1000)} kbps`
              : `${v.height}p`
            : `${Math.round(v.bw / 1000)} kbps`,
      }));
  }
  Logger.info(
    TAG,
    `DASH fallback → video=${plan.videoUrl}${plan.videoTracks ? ` (${plan.videoTracks.length} qualities)` : ""}${plan.audioUrl ? `, audio=${plan.audioUrl}` : " (muxed)"}${plan.audioTracks ? `, audioTracks=${plan.audioTracks.length}` : ""}${plan.subtitles ? `, subs=${plan.subtitles.length}` : ""}`,
  );
  return plan;
}
