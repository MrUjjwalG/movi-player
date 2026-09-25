/**
 * MoviPlayer - Main public API for the streaming video library
 */

import type {
  PlayerConfig,
  SourceConfig,
  Track,
  PlayerState,
  PlayerEventMap,
  MediaInfo,
  VideoTrack,
  AudioTrack,
  AudioSourceEntry,
  SubtitleTrack,
  SubtitleSourceEntry,
  SubtitleCue,
  SubtitleRenderer,
  Packet,
  PlaybackAssessment,
  PlaybackAssessmentOptions,
  PlaybackQuery,
  DecodeAudioOptions,
  DecodedAudioChunk,
} from "../types";
import { EventEmitter } from "../events/EventEmitter";
import {
  HttpSource,
  FileSource,
  ThumbnailHttpSource,
  EncryptedHttpSource,
  analyzeDashFallback,
  analyzeHlsFallback,
  loadHlsVariant,
  buildVttFromSegments,
  SegmentStreamSource,
  getSourceAdapterFactory,
  type SourceAdapter,
  type HlsSubtitleRendition,
} from "../source";
import { LRUCache } from "../cache";
import { Demuxer } from "../demux";
import { TrackManager } from "./TrackManager";
import { Clock } from "./Clock";
import { PlayerStateManager } from "./PlayerState";
import { lowerLinkBps, raiseLinkBps } from "../utils/LinkRate";
import { Logger, LogLevel } from "../utils/Logger";
import {
  Storyboard,
  type StoryboardSpec,
  type StoryboardTile,
} from "../utils/Storyboard";
import { probeLinkBandwidth } from "../utils/bandwidthProbe";
import { MoviVideoDecoder } from "../decode/VideoDecoder";
import { MoviAudioDecoder } from "../decode/AudioDecoder";
import { CodecParser } from "../decode/CodecParser";
import { SubtitleDecoder } from "../decode/SubtitleDecoder";
import {
  CanvasRenderer,
  type VRView,
  type RenderSource,
} from "../render/CanvasRenderer";
import { AudioRenderer } from "../render/AudioRenderer";
import { updateAllBindingsLogLevel, ThumbnailBindings, WasmBindings } from "../wasm/bindings";
import { loadWasmModuleNew, resetWasmModule } from "../wasm/FFmpegLoader";
import { ShakaPlayerWrapper } from "../render/ShakaPlayerWrapper";
import { HLSPlayerWrapper } from "../render/HLSPlayerWrapper";
import { DASHPlayerWrapper } from "../render/DASHPlayerWrapper";
import { ThumbnailRenderer } from "../utils/ThumbnailRenderer";
import { childAbort } from "../utils/abort";

// Any of the three adaptive-streaming engines (Shaka primary; hls.js / dash.js
// as fallbacks). They share the same surface; the Shaka-only extras (isLive,
// thumbnails, …) are called through optional chaining where used.
type StreamWrapper =
  | ShakaPlayerWrapper
  | HLSPlayerWrapper
  | DASHPlayerWrapper;

const TAG = "MoviPlayer";

/**
 * Whether a stream engine turned a source down for want of a LICENCE, rather
 * than for any of the other reasons it turns sources down.
 *
 * Both engines say so plainly — Shaka's wrapper produces "This video is
 * protected and can't be played here", dash.js produces "DRM: No license server
 * URL specified!" — and the difference matters: a licence refusal is the one
 * failure where the demuxer tier below already knows it has nothing to gain.
 */
function looksLikeDrmFailure(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? "");
  return /protected|licen[cs]e|key[ _-]?system|\bdrm\b|widevine|playready|fairplay/i.test(
    msg,
  );
}

// Module-level device decode-capability cache — survives player/element
// recreates for the whole page session, so a fresh MoviPlayer (per video, or
// after a recovery) doesn't re-learn the same limit and re-stutter. Keyed by
// rung HEIGHT (device-meaningful and stable across sources, unlike bandwidth).
// A height lands here the FIRST time it goes decode-bound — which, because the
// renderer tries an FPS cap first, means "can't sustain even at half rate": a
// device limit, not a transient. Cleared only on a full page reload.
const deviceDecodeBoundHeights = new Set<string>();
// …and the same lesson, kept across reloads — of this TAB, and no further.
// The in-memory set above is cleared by a reload, so a fresh visit paid the
// same stutter to re-learn a limit it had just found; carrying it in session
// storage saves that without the verdict outliving the run it was made in.
//
// Which matters, because the verdict is made from one machine on one evening:
// a laptop on battery, a GPU busy behind another tab, a browser mid-update.
// None of those is a property of the device, and all of them were being
// written down forever. The ceiling only ever rises — nothing lowers it — so
// a bad evening barred a rung on that device for good, on every video, with
// nothing in the interface to say why 4K was never chosen again. A session is
// the longest any of it can honestly claim to be true for.
// The thumbnail pipeline's WASM module, kept for the whole page session.
//
// It used to be built fresh per video — a second emscripten instance, its own
// multi-megabyte heap, its own compile. On a low-end device that is the most
// expensive thing a video change does, and it lands exactly where it hurts:
// alongside the new video's decode ramp, which is what pushed audio into
// underrun ("gap filled" → duck → the clicking) after a couple of playbacks.
// The module is stateless between videos; only the FFmpeg CONTEXT inside it is
// per-file, and that is still created and destroyed each time.
//
// Handlers (onReadRequest / _pendingSeek) live on the MODULE, so exactly one
// ThumbnailBindings may use it at a time. `inUse` enforces that: a second
// pipeline — which happens only in the overlap of an in-place quality switch —
// gets its own throwaway instance rather than corrupting this one.
let sharedThumbnailModule: Awaited<ReturnType<typeof loadWasmModuleNew>> | null = null;
let sharedThumbnailModuleInUse = false;

// Stand-ins for a bare codec FAMILY, so a host that knows only "av01" per rung
// can still be asked a valid MediaCapabilities question. Profile/level here are
// ordinary high-resolution choices — the answer turns on the codec and the
// width/height passed alongside, not on the exact level digits.
const REPRESENTATIVE_CODECS: Record<string, string> = {
  av01: "av01.0.13M.08",
  av1: "av01.0.13M.08",
  vp9: "vp09.00.51.08",
  vp09: "vp09.00.51.08",
  avc1: "avc1.640033",
  h264: "avc1.640033",
  hvc1: "hvc1.1.6.L153.90",
  hev1: "hev1.1.6.L153.90",
  hevc: "hvc1.1.6.L153.90",
};

// One name per codec, whichever spelling reached us. A ladder writes what its
// extractor happened to emit ("av1", "h264") and a WebCodecs string carries the
// registered fourcc ("av01.0.12M.08", "avc1.640033"); comparing the two raw
// makes the same codec look like two, which is exactly the mistake that makes a
// codec-aware rule silently fall back to the codec-blind one.
const CODEC_FAMILY_ALIASES: Record<string, string> = {
  av1: "av01",
  h264: "avc1",
  avc3: "avc1",
  h265: "hvc1",
  hevc: "hvc1",
  hev1: "hvc1",
  vp9: "vp09",
  vp8: "vp08",
};

function codecFamily(codec?: string): string {
  const raw = (codec || "").split(".")[0].toLowerCase();
  return CODEC_FAMILY_ALIASES[raw] || raw;
}

// What software decode can actually sustain. Once the video is being decoded in
// software, resolution is the only lever left, and Auto must not climb past what
// the CPU can hold — whatever the link can carry.
//
// 480p for every codec, H.264 included. H.264 used to get 720p as "the cheap
// one", and on a phone it isn't: opening at 720p H.264 held, but the moment Auto
// stepped to 1080p the picture stalled and the correction dropped it to 480p
// anyway — a climb, a stall and a drop, every load, to arrive where it should
// have started. Software decode is not the place to find the limit by hitting
// it. Only applies while software is in use; a hardware path keeps the full
// ladder.
function softwareDecodeCeiling(viaWebCodecs: boolean): number {
  // Two very different CPUs are doing the work depending on how we got here.
  //
  // Our WASM decoder is single-threaded and pays an Asyncify tax: 480p, and
  // even 720p H.264 only held until the first upshift stalled it.
  //
  // A WebCodecs decoder that merely lost `prefer-hardware` is the browser's own
  // — multithreaded, SIMD, years of tuning — and it carries 1080p on hardware
  // this modest. Capping it at 480 too took a 1080p AV1 that was playing and
  // dropped it three rungs for no reason anyone could see.
  return viaWebCodecs ? 1080 : 480;
}

/**
 * True when the browser has no WebCodecs at all, so software decode is a
 * certainty rather than a state to be discovered. `isSoftwareDecoding()` only
 * becomes true once the decoder has configured and fallen back — and the ABR
 * can reach a decision before that, which is how an upshift to 1080p slipped
 * past the ceiling on a browser that never had a hardware path.
 */
function webCodecsUnavailable(): boolean {
  return (
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder ===
    "undefined"
  );
}

/**
 * A rung this device has been shown not to decode, keyed by CODEC FAMILY AND
 * HEIGHT — not height alone.
 *
 * Height alone was codec-blind, and it barred by association: one video's 2160p
 * AV1 failing on a Safari with no AV1 path wrote down "2160", and from then on
 * every 2160p rung was refused — including the H.264 and VP9 ones that browser
 * decodes perfectly. The quality menu still listed 4K; Auto simply never chose
 * it, on any video, forever.
 *
 * The key is bumped to :v2 so the old height-only entries are dropped rather
 * than misread — a device carrying a poisoned ceiling heals on next load.
 */
const DECODE_CEILING_KEY = "movi:decode-ceiling:v2";

/**
 * The store is session storage: the ceiling belongs to this tab's run of the
 * player and goes when the tab does. See deviceDecodeBoundHeights.
 */
function decodeCeilingStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    // Blocked storage (a sandboxed frame, a privacy mode): the in-memory set
    // still holds for the life of the page.
    return null;
  }
}

/**
 * Resolve `p`, or TIMED_OUT once `ms` have passed.
 *
 * The losing promise is NOT cancelled — it cannot be — so every caller must
 * tear its demuxer down straight after, which is exactly what abandonPrep and
 * primeRendition's discard path do. Used only where an await has no bound of
 * its own and the thing being waited on is holding the link.
 */
const TIMED_OUT = Symbol("timed-out");
async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<typeof TIMED_OUT>((r) => {
    t = setTimeout(() => r(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(t);
  }
}

/** `av01@2160` — what actually failed, not just how tall it was. */
function decodeBoundKey(codec: string, height: number): string {
  const family = (codec || "").split(".")[0].toLowerCase() || "unknown";
  return `${family}@${height}`;
}

/**
 * `av01.0.17m.08@4320` — the exact rung SHAPE, for a bar that gets written
 * down.
 *
 * The family key above collapses everything a codec string carries: profile,
 * level and BIT DEPTH. That is right for the reactive bar, which comes from
 * this device visibly failing to play something and is a statement about the
 * machine right now. It is wrong for a persisted capability verdict, because
 * "8K AV1" is not one thing — a GPU can decode 8-bit and refuse 10-bit, and
 * two videos' 8K rungs are routinely different profiles. Keyed by family, one
 * refusal retired every 8K AV1 rung on that device for good, including the
 * ones it could have played.
 *
 * Empty for a bare family ("av01"), which has no shape to be exact about.
 */
function decodeBoundExactKey(codec: string, height: number): string {
  if (!codec.includes(".")) return "";
  return `${codec.toLowerCase()}@${height}`;
}

function loadPersistedDecodeCeiling(): void {
  try {
    // Whatever earlier versions wrote down for ever: drop it on sight. A
    // ceiling from another day is the thing this stopped keeping.
    localStorage.removeItem(DECODE_CEILING_KEY);
  } catch {
    /* nothing there to clear, or nowhere to clear it from */
  }
  try {
    const raw = decodeCeilingStore()?.getItem(DECODE_CEILING_KEY);
    if (!raw) return;
    for (const k of JSON.parse(raw) as string[]) {
      if (typeof k === "string" && k.includes("@")) deviceDecodeBoundHeights.add(k);
    }
  } catch {
    /* private mode / bad JSON — the session just re-learns */
  }
}

/**
 * Heights barred for THIS SESSION only — learned while software-decoding, so
 * they describe the CPU's limit, not the device's. Excluded from what gets
 * written down, and excluded even when a later, unrelated persist runs: the
 * write serialises the whole set, so without this a software-session bar
 * hitched a ride on the next hardware verdict.
 */
const sessionOnlyDecodeBoundHeights = new Set<string>();

function persistDecodeCeiling(): void {
  try {
    decodeCeilingStore()?.setItem(
      DECODE_CEILING_KEY,
      JSON.stringify(
        [...deviceDecodeBoundHeights].filter(
          (k) => !sessionOnlyDecodeBoundHeights.has(k),
        ),
      ),
    );
  } catch {
    /* storage unavailable — the in-memory set still holds for this session */
  }
}

loadPersistedDecodeCeiling();


/**
 * Ask MediaCapabilities whether this device can actually play each heavy rung,
 * and record the ones it cannot in the module-level ceiling. Shared by the
 * player (which knows the codec in play) and the element's opening pick (which
 * runs before any player exists) — see MoviPlayer.screenLadder.
 */
/**
 * What a rung costs to decode in software, in H.264-equivalent pixels per
 * second: `width × height × fps × codec factor`. The factors are rough — a
 * modern codec buys its bitrate with per-pixel work, and AV1/HEVC land around
 * 3× H.264 while VP9 sits near 2×.
 *
 * This replaced a plain `height >= 1440` test, which is a proxy that breaks in
 * both directions the moment a rung isn't 16:9. A 2.39:1 film's "1440p" rung is
 * 2560×1072 — under the height cut, never screened, though it is heavier than
 * ordinary 1080p. A portrait 1080×1920 is over the cut and would be barred,
 * though it is exactly as many pixels as the 1080p that passes. Both fall out
 * correctly once the real frame is measured instead of one of its sides.
 */
function softwareDecodeCost(
  width: number,
  height: number,
  fps: number,
  codec: string,
): number {
  const family = (codec || "").split(".")[0].toLowerCase();
  const factor = /^(av01|av1|hvc1|hev1|hevc|h265)/.test(family)
    ? 3
    : /^(vp0?9|vp9)/.test(family)
      ? 2
      : 1;
  return width * height * Math.max(1, fps) * factor;
}

/**
 * Cost above which a rung with NO hardware path is refused. Calibrated to the
 * old height thresholds at a nominal 30fps — mobile's 2560×1440×30 ≈ 110M,
 * desktop's headroom several times that — then rounded to numbers that hold up
 * against what was actually observed: a phone that could not produce one frame
 * of 1440p AV1 (332M), and the 1080p30 H.264 (62M) it plays without complaint.
 * Two constants, one place to tune.
 */
const SOFTWARE_DECODE_BUDGET_MOBILE = 100_000_000;
const SOFTWARE_DECODE_BUDGET_DESKTOP = 400_000_000;

/**
 * The most a HARDWARE decoder is built to carry, in pixels per second: 8K at
 * 60fps. That is the top of AV1 level 6.1 and HEVC level 6.1, which is where
 * the decoders in laptops, phones and consumer GPUs stop — a device advertising
 * "8K AV1" means 8K60, and nothing past it.
 *
 * It exists because nothing else here will say no. Asked about 8K at 120fps,
 * WebCodecs configured a hardware decoder and MediaCapabilities answered
 * smooth and power-efficient — its "smooth" comes from past playback of that
 * configuration, and with no history it is optimistic by default. Only a speed
 * setting reaches this in practice (8K60 at 2x is 8K120), which is exactly the
 * question canPlaySmoothly is asked with a rate for.
 */
const HARDWARE_DECODE_CEILING = 7680 * 4320 * 60;
/**
 * How far past realtime a decoder that already carries a stream is assumed to
 * go. Speed does not scale hardware decoding the way it scales the software
 * budget: a decoder has headroom above realtime — that is what makes fast
 * playback possible at all — and above 1x the player stops asking it for every
 * frame anyway (the adaptive frame cap, and the skip-ahead path). Two is what
 * an 8K60 file demonstrates: it plays at 2x while the old rule, which simply
 * multiplied the pixel rate by the speed, called it beyond hardware at 1.5x.
 */
const HARDWARE_RATE_HEADROOM = 2;

async function screenLadderForDecode(
  rungs: {
    height?: number;
    width?: number;
    fps?: number;
    codec?: string;
    bandwidth?: number;
  }[],
  fps: number,
  activeCodec: string,
  activeHeight: number,
  screened: Set<string>,
  mobile: boolean,
): Promise<void> {
    const caps = (
      navigator as unknown as {
        mediaCapabilities?: {
          decodingInfo?: (c: unknown) => Promise<{
            supported?: boolean;
            smooth?: boolean;
            powerEfficient?: boolean;
          }>;
        };
      }
    ).mediaCapabilities;
    if (!caps?.decodingInfo) return;

    for (const r of rungs) {
      const h = r.height ?? 0;
      if (h <= 0) continue;
      // Skip only a rung ALREADY judged for this codec — a different codec at
      // the same height is a different question.
      if (MoviPlayer.isDecodeBound(r.codec, h)) continue;
      // The rung's real frame. Only fall back to a 16:9 guess when the ladder
      // didn't declare a width — asking decodingInfo about dimensions the
      // content doesn't have gets an answer about a video nobody is playing.
      const w = r.width && r.width > 0 ? r.width : Math.round((h * 16) / 9);
      const rungFps = r.fps && r.fps > 0 ? r.fps : fps;
      // Judge a rung by ITS OWN codec. A ladder is often mixed — H.264 low,
      // AV1 high, which is what YouTube-style extractors produce — so asking
      // about the codec that happens to be PLAYING answers the wrong question.
      // Caught in throttled testing: from a 480p H.264 rung the screen asked
      // "8K H.264?", got "software" (true almost everywhere) and barred 8K on
      // devices whose 8K rung is AV1 and whose GPU handles it.
      //
      // Without a declared codec, fall back to the active one only while we
      // are already in the same size regime (above 4K), where a ladder does
      // not usually change codec. Otherwise leave it to the reactive path.
      const declared = r.codec || (activeHeight > 2160 ? activeCodec : "");
      if (!declared) continue;
      // A full WebCodecs string ("av01.0.13M.10") can be asked about directly.
      // A bare family ("av01"), which is all a host usually knows per rung, is
      // NOT a valid contentType codec — decodingInfo answers `unsupported` to
      // it, which would bar the rung for the wrong reason. Fill in a real
      // string: the playing one when the family matches, else a representative.
      const family = declared.split(".")[0].toLowerCase();
      const activeFamily = activeCodec.split(".")[0].toLowerCase();
      const exact = declared.includes(".");
      const codec = exact
        ? declared
        : family === activeFamily && activeCodec
          ? activeCodec
          : REPRESENTATIVE_CODECS[family] || "";
      if (!codec) continue;
      // Containers the codec strings map to. Getting this wrong makes
      // decodingInfo reject the query outright, which we treat as "no answer".
      const container = /^(vp0?[89]|vp8)/i.test(codec) ? "video/webm" : "video/mp4";
      // What this rung would cost the CPU, and whether that is more than this
      // class of machine can carry. Only rungs OVER the budget can be barred
      // for lacking a hardware path — under it, software decode is ordinary and
      // barring would cost quality for nothing. A hard `unsupported` still
      // counts at any size; that one isn't a judgement call.
      const cost = softwareDecodeCost(w, h, rungFps, codec);
      const overBudget =
        cost >
        (mobile
          ? SOFTWARE_DECODE_BUDGET_MOBILE
          : SOFTWARE_DECODE_BUDGET_DESKTOP);
      const key = `${codec}@${w}x${h}@${Math.round(rungFps)}`;
      if (screened.has(key)) continue;
      screened.add(key);
      try {
        const info = await caps.decodingInfo({
          type: "file",
          video: {
            contentType: `${container}; codecs="${codec}"`,
            width: w,
            height: h,
            bitrate: r.bandwidth || 0,
            framerate: rungFps,
          },
        });
        let verdict =
          // "unsupported" is only trusted for a codec string the host actually
          // declared. For one we filled in, it more likely means the guess was
          // wrong than that the device can't play the rung.
          info?.supported === false && exact
            ? "unsupported"
            : // The two soft verdicts are judgements about cost, so they only
              // count for a rung that IS costly. `smooth: false` and
              // `powerEfficient: false` are both routine on cheap rungs — a
              // 480p H.264 that plays anywhere can answer either way — and
              // acting on them there would bar quality for nothing.
              !overBudget
              ? ""
              : info?.smooth === false
                ? "not smooth"
                : info?.powerEfficient === false
                  ? "software-decoded"
                  : "";

        // Ask the API that actually DECIDES. decodingInfo is an advisory
        // second opinion, and Safari disagrees with itself: it answered
        // "supported" for 3840x2026 AV1 that VideoDecoder.isConfigSupported
        // then refused outright. The rung opened, fell to the WASM decoder at
        // 4K — hopeless — and the reactive correction dropped it to 450p, when
        // the ladder had a 1080p H.264 rung with a hardware path all along.
        //
        // Only for a rung already OVER budget: below it, "no hardware path"
        // is not a problem, software carries those every day.
        if (!verdict && overBudget && exact && typeof VideoDecoder !== "undefined") {
          try {
            const hw = await VideoDecoder.isConfigSupported({
              codec,
              codedWidth: w,
              codedHeight: h,
              hardwareAcceleration: "prefer-hardware",
            });
            if (hw?.supported === false) verdict = "no hardware path";
          } catch {
            /* the query itself is unsupported here — decodingInfo's answer stands */
          }
        }
        if (verdict) {
          // A verdict that gets WRITTEN DOWN is keyed by the exact rung shape,
          // so it retires that rung and not the whole family at that height —
          // see decodeBoundExactKey. A session-scoped one keeps the broad key:
          // it expires with the tab anyway, and while it lasts "this machine is
          // not comfortable at this size" is the useful reading of it.
          const isFact = verdict === "unsupported" || verdict === "no hardware path";
          const key =
            (isFact && decodeBoundExactKey(codec, h)) || decodeBoundKey(codec, h);
          deviceDecodeBoundHeights.add(key);
          // Facts are written down; judgements are not.
          //
          // "unsupported" and "no hardware path" come from
          // VideoDecoder.isConfigSupported — the API that decides, answering
          // about this codec on this machine. Those hold, so they persist.
          //
          // "not smooth" and "software-decoded" are decodingInfo's OPINION,
          // and it is a conservative one: it called 8K AV1 unsmooth on a
          // machine whose 4K AV1 runs on hardware without complaint. Persisted,
          // one cautious answer retired that rung for good — the rung would
          // never be tried again to find out whether the opinion was right.
          // Session-scoped, the next load gets to ask again, and if it really
          // can't hold it the reactive path pulls it down in a few seconds.
          if (isFact) {
            persistDecodeCeiling();
          } else {
            sessionOnlyDecodeBoundHeights.add(key);
          }
          Logger.info(
            TAG,
            `ABR: this device reports ${w}x${h}@${Math.round(rungFps)} ${codec} as ${verdict} (${Math.round(cost / 1e6)}M) — barring it ${isFact ? "for good" : "for this session"}`,
          );
        }
      } catch {
        /* query rejected (bad contentType, unimplemented) — leave it to the
           reactive path, which is what used to carry this alone. */
      }
    }
  }

export class MoviPlayer extends EventEmitter<PlayerEventMap> {
  // One-shot UA classification: mobile devices get the same conservative
  // decode/render budgets as 4K+ desktop, since mobile GPUs and Chrome's
  // AV1 hardware whitelist make the heavy path unaffordable at any res.
  // Memoized at class level so we don't re-parse navigator.userAgent in
  // every demux loop tick.
  private static readonly _isMobileDevice: boolean = (() => {
    if (typeof navigator === "undefined") return false;
    const uaData = (navigator as any)?.userAgentData;
    if (uaData?.mobile === true) return true;
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPod|Mobile|Opera Mini|IEMobile|BlackBerry/i.test(ua)) return true;
    // iPadOS 13+ reports as Mac — disambiguate via touch points
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
    return false;
  })();

  private config: PlayerConfig;
  private source: SourceAdapter | null = null;
  private cache: LRUCache;
  private demuxer: Demuxer | null = null;

  private _audioTracks: AudioSourceEntry[] = [];
  private _activeAudioLang: string = "";
  // Quality-independent HLS subtitle blobs, cached by stream URL so a quality
  // switch (which rebuilds the player) reuses them instead of re-fetching every
  // WebVTT segment — the dominant switch-latency cost.
  private static _hlsSubtitleCache = new Map<string, SubtitleSourceEntry[]>();

  // Split (separate-URL) audio, WASM-decoded. A separate audio track (e.g. a
  // YouTube itag-140 fMP4 that Safari's native <audio> can't play) is demuxed by
  // its OWN isolated-WASM Demuxer and decoded through the shared audioDecoder →
  // audioRenderer, exactly like muxed in-file audio. The AudioRenderer is already
  // the clock master, so A/V sync, volume, mute and playbackRate come for free.
  private audioDemuxer: Demuxer | null = null;
  private audioSource: SourceAdapter | null = null;
  private audioAnimationFrameId: number | null = null;
  private audioDemuxInFlight: boolean = false;
  private _splitAudioTrackId: number = -1;
  /** How long a split-audio track may fail every read before the player says
   *  so. Long enough to step over a bad patch, short enough that nobody sits
   *  through a silent film wondering. */
  private static readonly SPLIT_AUDIO_GIVE_UP_MS = 4000;

  private _splitAudioEof: boolean = false;
  // A split-audio track that has stopped answering. See pumpSplitAudio.
  private _splitAudioDead: boolean = false;
  private _splitAudioErrorSince: number = 0;
  // Bounded automatic recovery from a decoder that started rejecting every
  // packet (see recoverBrokenAudio). Counted per source, so a genuinely
  // undecodable stream ends in silence instead of a seek loop.
  /** Resolves once the video demuxer has produced mediaInfo — the only thing
   *  the parallel split-audio open has to wait for. */
  private _videoInfoReady: Promise<void> | null = null;
  private _resolveVideoInfoReady: (() => void) | null = null;
  private _audioRecoveryInFlight = false;
  private _audioRecoveries = 0;
  private static readonly MAX_AUDIO_RECOVERIES = 3;
  // How long the unmute re-read waits for AudioContext.resume() to settle.
  // A gesture-driven resume lands in a few ms; this only bounds the pathological
  // case where it never resolves, so the corrective seek still happens.
  private static readonly UNMUTE_RESUME_WAIT_MS = 400;
  // A separate audio source can be timed on its own PTS baseline (e.g. an HLS
  // audio rendition starting at PTS 0 while the video TS starts at ~10s).
  // `_splitAudioStartTime` is that source's own start; `_splitAudioPtsDelta`
  // (videoStart − audioStart) is added to each audio packet's PTS so it lands
  // on the video's timeline. Both are 0 when the two share a baseline (DASH).
  private _splitAudioStartTime: number = 0;
  // Media time below which split-audio packets are dropped after a seek
  // completes, so the audio demuxer's own (earlier) landing point can't drag
  // the clock back behind the first video frame. -1 = no filter armed.
  private _splitAudioSkipBefore: number = -1;
  // Same as _rewindAudioFloorPending, for the split pump: only a RATE-CHANGE
  // rewind arms a provisional floor (the seek path's cutoff is already exact).
  private _splitAudioFloorPending = false;
  private _splitAudioPtsDelta: number = 0;
  // True while an audio-track switch tears the audio demuxer down and re-stands
  // it up. hasAudibleSource() honors it so the volume control doesn't blink out
  // during the swap (audioDemuxer is briefly null).
  private _audioSwitchInProgress: boolean = false;
  // Set once destroy() runs. load() awaits (WASM loads, the split-audio second
  // demuxer) can outlive a rapid source switch that destroys this instance; the
  // continuation must bail instead of configuring/rendering onto the now-shared
  // canvas of the successor player (which showed as a black frame).
  private _destroyed: boolean = false;
  /**
   * Aborted by destroy(), and the signal every request this player makes is
   * expected to carry.
   *
   * The sources already cancelled their own work; nothing else did, because
   * nothing else had a handle to cancel WITH. A probe built its AbortController
   * as a local and only ever aborted it on its own timer; the subtitle loaders
   * passed no signal at all. So a player torn down mid-startup kept pulling
   * megabytes for a video that was already gone — off the link the replacement
   * player was trying to start on.
   */
  private _lifetimeAbort = new AbortController();

  /** The signal for anything fetched on this player's behalf. */
  get lifetimeSignal(): AbortSignal {
    return this._lifetimeAbort.signal;
  }
  // PTS (media time) of the last split-audio packet handed to the decoder. The
  // audio loop bounds its lead against the CLOCK using this — not the
  // AudioRenderer buffer, which mis-reports while the AudioContext is suspended
  // (Safari muted-autoplay), which otherwise let audio race far ahead of the
  // wall-clock-rolling video and land seconds/minutes out of sync on unmute.
  private _lastSplitAudioPts: number = 0;

  // External subtitle tracks (VTT/SRT)
  private _subtitleTracks: SubtitleSourceEntry[] = [];
  // DASH-fallback video Representations (best-first) + the one currently playing,
  // for the demuxer-mode quality menu. Populated only in the force-demux path.
  /**
   * The demuxer-path source came from a manifest that declares encryption. It
   * plays for as long as the packager's clear lead lasts, then stops for good;
   * this is what turns that stop into "needs a licence" rather than a decoder
   * fault. Set when the fallback plan is taken, cleared on every load.
   */
  private _sourceIsEncrypted: boolean = false;

  /**
   * Halt further reading without tearing the source down — the buffered part is
   * still good to seek around in, and only what comes next is unusable.
   */
  private stopSourceStreaming(): void {
    try {
      (this.source as unknown as { haltStreaming?: () => void })?.haltStreaming?.();
    } catch {
      /* best-effort */
    }
  }

  /** Reported once; either decoder may be the one that hits the wall first. */
  private _encryptedGaveUp: boolean = false;
  /** Audio already given up on for this source — say it once, not per packet. */
  private _encryptedAudioSilenced: boolean = false;

  /**
   * The clear lead of an encrypted source has run out. Whichever decoder
   * noticed, the answer is the same and there is no recovery to attempt.
   *
   * Stopping matters as much as reporting. Left running, the pipeline keeps
   * asking for frames it can never get, and the machinery built to rescue a
   * struggling stream turns on itself: audio empties, video is bound to it, the
   * stall detector fires, the element nudges a seek, and that repeats for as
   * long as anyone watches. Pausing ends that; halting the source stops pulling
   * bytes that cannot be used; the error names the cause.
   */
  private encryptedSourceGaveUp(): void {
    if (this._encryptedGaveUp) return;
    this._encryptedGaveUp = true;
    Logger.warn(
      TAG,
      "Encrypted source: the clear lead has ended — no licence, so playback stops here",
    );
    this.stopSourceStreaming();
    try {
      this.pause();
    } catch {
      /* already stopped */
    }
    this.stateManager.setState("error");
    this.emit(
      "error",
      new Error("This video is protected and needs a licence to play here."),
    );
  }

  private _dashRenditions: {
    url: string;
    label: string;
    id: string;
    bandwidth?: number;
    height?: number;
    /** This rung's own codec, when the host declared one — see the capability
     *  screen, which cannot judge a rung by the codec currently playing. */
    codec?: string;
  }[] = [];
  private _activeDashRendition: string = "";
  // Stamps each rendition-switch indicator, so an end that arrives after the
  // next switch has started can't clear the newer one's indicator.
  private _switchIndicatorGen = 0;
  // codec@height already put to MediaCapabilities — see
  // screenRungsForDecodeCapability. Instance-level: the answers it produces go
  // into the module-level ceiling, so re-asking costs nothing but time.
  private _decodeScreened = new Set<string>();
  // True while THIS player holds the shared thumbnail WASM module.
  private _usingSharedThumbModule = false;

  /**
   * Resolutions this device has been shown not to sustain — learned from a
   * decode-bound stall or from MediaCapabilities, and kept for this tab's
   * session (see deviceDecodeBoundHeights).
   * Public because the pick happens BEFORE any player exists: the element's
   * pre-play speed test chooses the opening rung off a bandwidth measurement
   * alone, so without this a machine that cannot decode 8K still opened on it
   * and stepped down a moment later, in full view.
   */
  static decodeBoundHeights(): string[] {
    return [...deviceDecodeBoundHeights];
  }

  /** Has THIS codec at THIS height been shown not to decode here? */
  static isDecodeBound(codec: string | undefined, height: number): boolean {
    if (!(height > 0)) return false;
    const exact = decodeBoundExactKey(codec || "", height);
    if (exact && deviceDecodeBoundHeights.has(exact)) return true;
    return deviceDecodeBoundHeights.has(decodeBoundKey(codec || "", height));
  }

  /**
   * Will this play smoothly HERE — on this device, in this browser, at this
   * speed — before committing to playing it?
   *
   * Answered with the same judgement the player itself acts on when it picks a
   * rendition (screenLadderForDecode), not a second opinion that could
   * disagree with it:
   *
   *  1. Is there a HARDWARE decoder for this exact configuration? Asked of
   *     WebCodecs with `prefer-hardware`, because that is the API that decides
   *     — MediaCapabilities is advisory, and Safari has been caught answering
   *     "supported" for 4K AV1 that isConfigSupported then refused.
   *  2. Failing that, is there a browser SOFTWARE decoder? Failing that, the
   *     player's own FFmpeg (WASM) takes it — which is why `playable` is true
   *     for nearly anything with a video track.
   *  3. Without hardware, it comes down to cost: width × height × fps × the
   *     codec's work factor × playback rate, against the budget for this class
   *     of device — the same two constants the player's ABR uses, calibrated on
   *     a phone that could not produce a frame of 1440p AV1 and the 1080p H.264
   *     it plays without complaint.
   *  4. MediaCapabilities gets a veto over "smooth": when the browser says a
   *     configuration will not be smooth, that is believed.
   *
   * Audio is reported but never decides it. Every audio track goes through the
   * software decoder already, and audio decode is a rounding error next to
   * video's.
   *
   * @param input A URL or File to open and read (an isolated WASM instance, so
   *   a player already playing is not disturbed), the tracks of something
   *   already open, or a {@link PlaybackQuery} when there is nothing to open.
   */
  static async assessPlayback(
    input: string | File | Blob | Track[] | PlaybackQuery,
    options: PlaybackAssessmentOptions = {},
  ): Promise<PlaybackAssessment> {
    const rate =
      typeof options.rate === "number" && options.rate > 0 ? options.rate : 1;
    const reasons: string[] = [];

    // ── What are we looking at ────────────────────────────────────────────
    let tracks: Track[];
    let fromQuery: PlaybackQuery | null = null;
    if (Array.isArray(input)) {
      tracks = input;
    } else if (typeof input === "string" || input instanceof Blob) {
      try {
        tracks = await MoviPlayer.probeTracks(input);
      } catch (e) {
        // A source that cannot be opened is a verdict, not an exception: the
        // caller asked "will this play", and "it could not be read" answers it.
        // Adaptive manifests land here too — open one with the player instead,
        // and ask the element once it has loaded.
        return {
          playable: false,
          smooth: false,
          powerEfficient: false,
          rate,
          video: null,
          audio: null,
          reasons: [
            `The source could not be read: ${e instanceof Error ? e.message : String(e)}`,
          ],
        };
      }
    } else {
      fromQuery = input;
      tracks = [
        {
          id: 0,
          type: "video",
          codec: input.codec,
          width: input.width,
          height: input.height,
          frameRate: input.fps && input.fps > 0 ? input.fps : 30,
          bitRate: input.bitrate,
        } as VideoTrack,
      ];
    }

    const video = tracks.find(
      (t): t is VideoTrack =>
        t.type === "video" && !(t as VideoTrack).isAttachedPic,
    );
    const audioTrack = tracks.find((t): t is AudioTrack => t.type === "audio");

    const audio: PlaybackAssessment["audio"] = audioTrack
      ? {
          codec: audioTrack.codec,
          channels: audioTrack.channels,
          sampleRate: audioTrack.sampleRate,
          decoder: MoviAudioDecoder.needsSoftwareDecoding(audioTrack.codec)
            ? "wasm"
            : "webcodecs",
        }
      : null;

    if (!video) {
      // Sound only: nothing here is expensive enough to stutter.
      return {
        playable: !!audioTrack,
        smooth: !!audioTrack,
        powerEfficient: !!audioTrack,
        rate,
        video: null,
        audio,
        reasons: audioTrack ? [] : ["No video or audio track was found."],
      };
    }

    // ── The codec string to ask with ──────────────────────────────────────
    // A full WebCodecs string when the stream's own extradata can build one;
    // otherwise the representative profile for its family, the same fill-in
    // the ladder screen uses. A query that already names a full string is
    // taken at its word.
    const family = (video.codec || "").split(".")[0].toLowerCase();
    const parsedCodec =
      (fromQuery && fromQuery.codec.includes(".") ? fromQuery.codec : null) ||
      (!fromQuery ? MoviPlayer.codecStringFor(video) : null) ||
      REPRESENTATIVE_CODECS[family] ||
      "";
    let codec = parsedCodec;

    const width = video.width || 0;
    const height = video.height || 0;
    const fps = video.frameRate && video.frameRate > 0 ? video.frameRate : 30;
    const budget = MoviPlayer._isMobileDevice
      ? SOFTWARE_DECODE_BUDGET_MOBILE
      : SOFTWARE_DECODE_BUDGET_DESKTOP;
    const load =
      softwareDecodeCost(width, height, fps * rate, codec || family) / budget;

    // ── Which decoder would carry it ──────────────────────────────────────
    //
    // Asked the way the decoder will actually be configured, or the answer is
    // about a decoder nobody builds. Two things the playback path does and this
    // did not, both on every MPEG-TS file:
    //  - Its extradata is Annex B (start codes, not an avcC/hvcC record). The
    //    decoder drops it and reads the inline parameter sets; handed over as
    //    `description` it makes the browser refuse the config outright.
    //  - The parser reads that Annex B as if it were a record and builds a
    //    string like "avc1.000001". The decoder falls back to a mapped string
    //    when its first one is refused, so this falls back too.
    // Without both, a 4K HEVC .ts that plays in hardware was judged WASM-only,
    // 3.7× over the software budget, and warned about as not smooth.
    const extradata = video.extradata;
    const annexB =
      !!extradata &&
      extradata.length > 4 &&
      extradata[0] === 0 &&
      extradata[1] === 0 &&
      (extradata[2] === 1 || (extradata[2] === 0 && extradata[3] === 1));
    const ask = async (
      codecString: string,
      hardwareAcceleration?: "prefer-hardware",
    ): Promise<boolean> => {
      if (!codecString || typeof VideoDecoder === "undefined") return false;
      try {
        const config: VideoDecoderConfig = {
          codec: codecString,
          codedWidth: width,
          codedHeight: height,
        };
        if (hardwareAcceleration) config.hardwareAcceleration = hardwareAcceleration;
        if (extradata && extradata.length > 0 && !annexB) {
          config.description = extradata;
        }
        const r = await VideoDecoder.isConfigSupported(config);
        return r?.supported === true;
      } catch {
        return false;
      }
    };
    const candidates = [parsedCodec, REPRESENTATIVE_CODECS[family] || ""].filter(
      (c, i, all) => !!c && all.indexOf(c) === i,
    );
    let hardware = false;
    let software = false;
    for (const candidate of candidates) {
      hardware = await ask(candidate, "prefer-hardware");
      software = hardware ? true : await ask(candidate);
      if (software) {
        codec = candidate;
        break;
      }
    }
    const decoder: "hardware" | "software" | "wasm" = hardware
      ? "hardware"
      : software
        ? "software"
        : "wasm";

    // ── The browser's own estimate ────────────────────────────────────────
    let browserSmooth: boolean | undefined;
    let browserEfficient: boolean | undefined;
    const caps = (
      navigator as unknown as {
        mediaCapabilities?: {
          decodingInfo?: (c: unknown) => Promise<{
            supported?: boolean;
            smooth?: boolean;
            powerEfficient?: boolean;
          }>;
        };
      }
    ).mediaCapabilities;
    if (codec && caps?.decodingInfo && width > 0 && height > 0) {
      try {
        const container = /^(vp0?[89]|vp8)/i.test(codec)
          ? "video/webm"
          : "video/mp4";
        const info = await caps.decodingInfo({
          type: "file",
          video: {
            contentType: `${container}; codecs="${codec}"`,
            width,
            height,
            bitrate: video.bitRate || 0,
            framerate: fps * rate,
          },
        });
        // Only an answer about a configuration the browser recognised counts.
        if (info?.supported) {
          browserSmooth = info.smooth;
          browserEfficient = info.powerEfficient;
        }
      } catch {
        /* the query itself was rejected — no opinion */
      }
    }

    // ── Verdict ───────────────────────────────────────────────────────────
    const dims = `${width}×${height} @ ${Math.round(fps)}fps${rate !== 1 ? ` × ${rate}x` : ""}`;
    let smooth: boolean;
    if (decoder === "hardware") {
      // Hardware is not bound by the software budget — but it is bound by what
      // hardware decoders are built for, and the browser saying otherwise.
      //
      // Two questions, not one: can a decoder of this class carry the STREAM,
      // and can it carry it at this SPEED. The second gets the headroom above
      // realtime that hardware has — see HARDWARE_RATE_HEADROOM — because the
      // old rule folded the speed into the pixel rate and so declared an 8K60
      // file beyond hardware the moment the viewer pressed 1.5x, while it went
      // on playing. If the headroom turns out not to be there, the stutter
      // hint says so from what actually happened.
      const pixelRate = width * height * fps;
      const beyondStream = pixelRate > HARDWARE_DECODE_CEILING;
      const beyondSpeed =
        pixelRate * rate > HARDWARE_DECODE_CEILING * HARDWARE_RATE_HEADROOM;
      const beyondHardware = beyondStream || beyondSpeed;
      smooth = !beyondHardware && browserSmooth !== false;
      if (beyondStream) {
        reasons.push(
          `${dims} is beyond what hardware video decoders are built for (8K at 60fps).`,
        );
      } else if (beyondSpeed) {
        reasons.push(
          `${dims} is more than a hardware decoder for ${width}×${height} @ ${Math.round(fps)}fps can be expected to keep up with.`,
        );
      }
    } else {
      const overBudget = load > 1;
      smooth = !overBudget && browserSmooth !== false;
      reasons.push(
        decoder === "software"
          ? `No hardware decoder for ${codec || family} at ${width}×${height} — the browser decodes it in software.`
          : `The browser cannot decode ${codec || family} — the player's built-in decoder (WASM) takes it.`,
      );
      if (overBudget) {
        reasons.push(
          `Software decoding ${dims} needs about ${load.toFixed(1)}× what this ${MoviPlayer._isMobileDevice ? "mobile" : "desktop"} device can sustain.`,
        );
      }
    }
    if (browserSmooth === false) {
      reasons.push(`The browser reports ${dims} as not smooth on this device.`);
    }
    const powerEfficient =
      decoder === "hardware" && browserEfficient !== false;

    return {
      playable: true,
      smooth,
      powerEfficient,
      rate,
      video: {
        codec: codec || video.codec,
        width,
        height,
        fps,
        decoder,
        smooth,
        powerEfficient,
        load: Math.round(load * 100) / 100,
      },
      audio,
      // "Smooth" with a note about software decode is still smooth — the note
      // is information, not a problem, so a smooth verdict carries no reasons.
      reasons: smooth ? [] : reasons,
    };
  }

  /**
   * The audio track of a URL or File, decoded to mono PCM and handed back in
   * chunks — without playing it, and alongside anything that IS playing.
   *
   *   for await (const chunk of MoviPlayer.decodeAudio(file, { from: 60 })) {
   *     // chunk.samples: Float32Array @ 16 kHz, chunk.start / chunk.end in seconds
   *   }
   *
   * Built for work that needs the sound ahead of the playhead — speech
   * recognition for captions is the case it was written for. It decodes with
   * this player's own demuxer and audio decoder, so anything the player can
   * play it can read: MKV, Opus, TrueHD, DTS — not just what the browser's
   * decodeAudioData happens to understand, and never the whole file into
   * memory at once.
   *
   * Runs on its own WASM instance, like assessPlayback, so a player that is
   * playing is not disturbed, and yields to the event loop as it goes. Resampled
   * with an OfflineAudioContext, which band-limits properly — a speech model
   * fed aliased audio hears noise that is not in the file.
   *
   * Uses the first audio track. Stops, and releases everything, when the
   * signal aborts or the loop is broken out of.
   */
  static async *decodeAudio(
    input: string | File | Blob,
    options: DecodeAudioOptions = {},
  ): AsyncGenerator<DecodedAudioChunk> {
    const outRate =
      options.sampleRate && options.sampleRate > 0 ? options.sampleRate : 16000;
    const chunkSeconds =
      options.chunkSeconds && options.chunkSeconds > 0 ? options.chunkSeconds : 30;
    const from = Math.max(0, options.from ?? 0);
    const signal = options.signal;

    const source: SourceAdapter =
      typeof input === "string"
        ? new HttpSource(input)
        : new FileSource(input instanceof File ? input : new File([input], "media"));
    const demuxer = new Demuxer(source, undefined, true);
    const decoder = new MoviAudioDecoder();

    // Decoded blocks, already mixed to mono, waiting to be gathered.
    const pending: { time: number; samples: Float32Array; rate: number }[] = [];
    const toMono = (planes: Float32Array[], frames: number): Float32Array => {
      if (planes.length === 1) return planes[0].slice(0, frames);
      const out = new Float32Array(frames);
      for (const plane of planes) {
        for (let i = 0; i < frames; i++) out[i] += plane[i];
      }
      const k = 1 / planes.length;
      for (let i = 0; i < frames; i++) out[i] *= k;
      return out;
    };

    try {
      const info = await demuxer.open();
      const track = info.tracks.find((t): t is AudioTrack => t.type === "audio");
      if (!track) return;

      const bindings = demuxer.getBindings();
      if (bindings) decoder.setBindings(bindings);
      // Stereo out of the software decoder, whatever the source layout; the mix
      // to one channel happens here, where it is a plain average.
      decoder.setDownmix(true);
      decoder.setOnPCM((frame) => {
        pending.push({
          time: frame.timestamp / 1e6,
          samples: toMono(frame.planes, frame.numberOfFrames),
          rate: frame.sampleRate,
        });
      });
      decoder.setOnData((data) => {
        try {
          const planes: Float32Array[] = [];
          for (let c = 0; c < data.numberOfChannels; c++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            planes.push(plane);
          }
          pending.push({
            time: data.timestamp / 1e6,
            samples: toMono(planes, data.numberOfFrames),
            rate: data.sampleRate,
          });
        } finally {
          data.close();
        }
      });
      const configured = await decoder.configure(
        track,
        demuxer.getExtradata(track.id) ?? undefined,
      );
      if (!configured) {
        throw new Error(`Cannot decode the ${track.codec} audio track`);
      }
      if (from > 0) await demuxer.seek(from);

      // Gathered mono samples at the source rate, not yet handed back.
      let parts: Float32Array[] = [];
      let length = 0;
      let startTime = -1;
      let rate = track.sampleRate || 48000;

      const resample = async (mono: Float32Array): Promise<Float32Array> => {
        if (rate === outRate) return mono;
        if (typeof OfflineAudioContext === "undefined") {
          // No audio graph (a worker): nearest-lower sample. Crude, but only
          // reached where the good path cannot run at all.
          const n = Math.floor((mono.length * outRate) / rate);
          const out = new Float32Array(n);
          const step = rate / outRate;
          for (let i = 0; i < n; i++) out[i] = mono[Math.floor(i * step)];
          return out;
        }
        const n = Math.max(1, Math.round((mono.length * outRate) / rate));
        const ctx = new OfflineAudioContext(1, n, outRate);
        const buffer = ctx.createBuffer(1, mono.length, rate);
        buffer.copyToChannel(mono as Float32Array<ArrayBuffer>, 0);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.start();
        const rendered = await ctx.startRendering();
        return rendered.getChannelData(0).slice();
      };

      const takeChunk = async (samplesWanted: number): Promise<DecodedAudioChunk> => {
        const joined = new Float32Array(length);
        let o = 0;
        for (const p of parts) {
          joined.set(p, o);
          o += p.length;
        }
        const head = joined.subarray(0, samplesWanted);
        const rest = joined.slice(samplesWanted);
        const chunkStart = startTime;
        parts = rest.length ? [rest] : [];
        length = rest.length;
        startTime = chunkStart + samplesWanted / rate;
        return {
          start: chunkStart,
          end: chunkStart + samplesWanted / rate,
          sampleRate: outRate,
          samples: await resample(head.slice()),
        };
      };

      const gather = () => {
        while (pending.length) {
          const block = pending.shift()!;
          // Pre-roll decoded ahead of a seek target is not part of the answer.
          let samples = block.samples;
          let time = block.time;
          if (time < from) {
            const skip = Math.floor((from - time) * block.rate);
            if (skip >= samples.length) continue;
            samples = samples.subarray(skip);
            time = from;
          }
          if (startTime < 0) startTime = time;
          rate = block.rate;
          parts.push(samples);
          length += samples.length;
        }
      };

      let packets = 0;
      for (;;) {
        if (signal?.aborted) return;
        const packet = await demuxer.readPacket();
        if (!packet) break;
        if (packet.streamIndex !== track.id) continue;
        decoder.decode(packet.data, packet.timestamp, packet.keyframe);
        gather();
        const chunkSamples = Math.round(chunkSeconds * rate);
        while (length >= chunkSamples && startTime >= 0) {
          yield await takeChunk(chunkSamples);
          if (signal?.aborted) return;
        }
        // Keep the page responsive: this can be minutes of audio.
        if (++packets % 48 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      await decoder.flush().catch(() => {});
      gather();
      if (length > 0 && startTime >= 0 && !signal?.aborted) {
        yield await takeChunk(length);
      }
    } finally {
      try {
        decoder.close();
      } catch {
        /* already gone */
      }
      try {
        demuxer.close();
      } catch {
        /* already gone */
      }
      try {
        source.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** The stream's own codec string, or null — never a throw on odd extradata. */
  private static codecStringFor(video: VideoTrack): string | null {
    try {
      return CodecParser.getCodecString(
        video.codec,
        video.extradata,
        video.width,
        video.height,
      );
    } catch {
      return null;
    }
  }

  /** Open a URL or File just long enough to read its tracks. */
  private static async probeTracks(input: string | Blob): Promise<Track[]> {
    const source: SourceAdapter =
      typeof input === "string"
        ? new HttpSource(input)
        : new FileSource(
            input instanceof File ? input : new File([input], "media"),
          );
    // An isolated WASM instance: the shared one belongs to whatever is playing.
    const demuxer = new Demuxer(source, undefined, true);
    try {
      const info = await demuxer.open();
      return info.tracks;
    } finally {
      try {
        demuxer.close();
      } catch {
        /* already gone */
      }
      try {
        source.close();
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Ask the device about a ladder before there is a player to ask through.
   *
   * The opening rung is picked in the element, off a bandwidth probe, before
   * any of this class exists — so on a fresh device the FIRST rung it lands on
   * has never been screened, and a machine that cannot decode it finds out by
   * playing it badly. That one visible attempt is the whole complaint; every
   * load after it is covered by the persisted ceiling.
   *
   * Callable statically because the ceiling it fills is module-level too.
   * Rungs need their own codec (a `codec` on <MoviSource> → `data-codec`);
   * without one there is nothing to ask, and the reactive path still covers it.
   */
  static async screenLadder(
    rungs: { height?: number; codec?: string; bandwidth?: number }[],
    fps = 30,
  ): Promise<void> {
    await screenLadderForDecode(
      rungs,
      fps,
      "",
      0,
      new Set<string>(),
      MoviPlayer._isMobileDevice,
    );
  }
  // Adaptive-quality (ABR) state for the demuxer/premuxed in-place switch.
  private _autoQuality: boolean = false;
  private _abrTimer: ReturnType<typeof setInterval> | null = null;
  private _abrSwitchInProgress: boolean = false;
  // Guards the active pre-upshift speed test (probeRungThroughput) so ticks
  // don't stack probes while one is in flight.
  private _abrProbeInFlight: boolean = false;
  // One startup speed test per player (see runStartupSpeedTest).
  private _startupSpeedTestRan: boolean = false;
  // Bounded retries for a split-audio open that stalled on a contended link.
  private _splitAudioRetries: number = 0;
  private static readonly MAX_SPLIT_AUDIO_RETRIES = 3;
  // Last non-zero throughput estimate (bytes/s), carried across source swaps and
  // stale reads. A fully-downloaded single file (premuxed) reports 0 once idle,
  // so without this the ABR would lose its estimate and freeze at the start rung.
  private _lastThroughputBps: number = 0;
  // Anti-thrash state for the ABR. Each in-place switch resets the video
  // pipeline (new file download, brief keyframe wait) which perturbs both the
  // throughput estimate and the buffer, so without hysteresis the controller
  // oscillates between rungs every tick. _lastAbrSwitchAt gates how soon the
  // next switch may fire; the up-candidate counter requires an upshift target
  // to persist across ticks before committing (a lone throughput spike — e.g. a
  // cache-served burst — shouldn't upshift).
  private _lastAbrSwitchAt: number = Number.NEGATIVE_INFINITY;
  // When playback first started for the current source. The buffer is
  // legitimately near-empty while that FIRST fill is still in flight, and no
  // switch has happened yet (`sinceSwitch` is Infinity), so the post-switch
  // settle can't protect it — without this the absolute-low check reads the
  // normal startup dip as "this rung can't be sustained" and drops 4K to 1080p
  // in the first seconds on a link that carries it fine.
  private _playbackStartedAt: number = Number.NEGATIVE_INFINITY;
  private _abrUpCandidate: string = "";
  private _abrUpConfirms: number = 0;
  // False until the ABR has made its first switch after Auto was enabled. The
  // first upshift commits without the usual 2-tick confirmation so a fresh (or
  // host-defaulted-low) start jumps straight to the network-appropriate rung
  // instead of sitting at a low quality for two ticks.
  private _abrPrimed: boolean = false;
  // Previous tick's buffered-ahead seconds, to detect a draining buffer (the
  // ground-truth "network can't sustain the current rung" signal). Reset on a
  // switch since the buffer restarts from the resume point.
  private _lastBufferAhead: number = 0;
  // Asymmetric hysteresis: when a buffer-trend downshift leaves a rung because it
  // couldn't be sustained, that rung's bandwidth is "penalized" for a hold
  // window. The upshift path won't climb back to it (or higher) until the window
  // expires — otherwise a bursty link that momentarily reads fast re-upshifts
  // into the very rung that just drained, and the two ping-pong (the 240⇄360 /
  // 4K⇄1440 flapping). 0 = no active penalty.
  private _abrPenalizedBandwidth: number = 0;
  private _abrPenaltyUntil: number = 0;
  private static readonly ABR_PENALTY_MS = 30000;
  // Decode-bound is a DEVICE limit, not a transient network dip — back off much
  // harder than a throughput drain so ABR doesn't re-climb into a rung the GPU
  // can't decode and re-stutter every ~40s. Base, doubled per repeat.
  private static readonly ABR_DECODE_PENALTY_MS = 120000; // 2 min
  private static readonly ABR_PENALTY_MAX_MS = 300000; // escalation ceiling (5 min)
  private static readonly ABR_STRIKE_DECAY_MS = 180000; // forget strikes after 3 min clean
  // How deep the buffer must be — and steady — before Auto will climb a rung.
  // The switch throws the current cushion away (new file, new buffer), so this
  // is not a safety margin for the swap: it is the evidence that the link
  // carries the CURRENT rung with room to spare. Set just above the 6s/4s marks
  // the downshift path treats as trouble.
  private static readonly ABR_UPSHIFT_MIN_BUFFER_S = 8;
  // How far BEHIND the playhead an in-place rendition swap aims its seek.
  //
  // The seek lands where it is asked to, which on these streams is usually
  // mid-GOP — and a decoder that has just been flushed cannot start there. It
  // discards packets until the next keyframe, which for a 60fps YouTube
  // rendition is several seconds away: the logs show 193 and 234 frames
  // skipped, with the first decodable frame landing 4.5s AHEAD of the audio
  // clock. The picture then holds on its last frame for those 4.5 seconds,
  // which is the "it went black and never came back" this was chasing — and
  // the freeze watchdog reads it as a stall and drops another rung, and the
  // one after that, all the way down the ladder.
  //
  // Aiming behind the playhead puts the landing at or before a keyframe, so
  // the new rendition starts with a frame the clock has already passed. Those
  // frames are downloaded and decode far faster than real time; the renderer
  // drops the ones older than the clock and the picture resumes at once.
  private static readonly RENDITION_SWAP_LOOKBACK_S = 4;
  /** How far past the playhead the incoming rendition must decode before a
   *  seamless switch will commit. A quarter second is several frames of
   *  runway — enough that the new decoder is never the thing being waited on
   *  at the seam. */
  private static readonly SEAMLESS_PRIME_LEAD_S = 0.25;
  /** …and the most it may prime, however much the outgoing queue holds. Whole
   *  decoded frames are expensive at 4K and outrageous at 8K. */
  private static readonly SEAMLESS_PRIME_MAX_AHEAD_S = 0.6;
  private static readonly SEAMLESS_PRIME_MIN_FRAMES = 3;
  /** Long enough to cross a GOP on a slow link, short enough that a switch
   *  which cannot be made seamless falls back before the reason for switching
   *  gets worse. */
  private static readonly SEAMLESS_PRIME_BUDGET_MS = 5000;
  /**
   * Whole-prep bound for an in-place switch — open, seek and prime together.
   *
   * Every await in the prep was unbounded, and the one that hurts is the rung
   * that cannot be fed: an 8K AV1 rung is a 1.2GB file at 38.7Mbps, and on a
   * link that measures about the same the open alone can hang for as long as
   * it likes. Nothing rescues that, because `_abrSwitchInProgress` is held for
   * the whole call and it gates abrDecide, the decode downshift AND
   * abrEmergencyDownshift — so the ladder cannot step back down while the
   * stream it is stuck on saturates the link the player is starving for.
   *
   * Generous on purpose. A DOWNSHIFT comes through here too, and that is the
   * one switch a struggling player must always be able to finish; its target
   * is a smaller rung, so it is nowhere near this. What this cuts off is a
   * climb into a rung the link cannot carry, which is the only case that ever
   * runs this long.
   */
  private static readonly SWITCH_PREP_BUDGET_MS = 12_000;
  // bandwidth → consecutive "couldn't sustain this rung" strikes + when the last
  // one hit. Each strike doubles the re-climb penalty (30s → 1m → 2m … capped),
  // so a rung the link keeps failing to hold is backed off harder and harder
  // instead of ping-ponging back into it every ~40s. Decays after a clean spell
  // so a genuinely improved link gets a fresh shot at the higher rung.
  private _abrDrainStrikes: Map<number, { count: number; at: number }> = new Map();
  // True while the video decoder is holding on the last frame mid-playback,
  // waiting for the next keyframe (clock/audio keep running). The video buffer
  // drains during this hold even though the network is fine, so ABR must NOT
  // read it as the rung failing and downshift.
  private _videoHoldingForKeyframe: boolean = false;
  // performance.now() of the last seek. The buffering right after a seek is a
  // normal re-fill, not a network stall — switching rendition into that (racing
  // the seek's own re-prime/re-read) is what crashed the demuxer, so the
  // emergency downshift stands down briefly after a seek.
  private _lastSeekAt: number = Number.NEGATIVE_INFINITY;
  // Black-frame recovery: a seek can force-complete with no decodable video frame
  // (the demuxer runs a GOP to EOF without a keyframe the decoder accepts —
  // open-GOP / a bad seek point), then the audio-driven buffering→resume flips to
  // "playing" over a BLACK screen while audio plays. A manual seek elsewhere fixes
  // it, so we automate that: a watchdog nudges the playhead to the next GOP when
  // no frame lands. Bounded so a genuinely undecodable stream can't seek forever.
  private _blackFrameWatchdog: ReturnType<typeof setTimeout> | null = null;
  private _blackRecoverySeeks: number = 0;
  private static readonly MAX_BLACK_RECOVERY_SEEKS = 3;
  // Set when the picture could not be recovered where it stopped and the sound
  // was handed playback instead of the playhead being nudged past it. It is the
  // difference between "the viewer misses the picture for a few seconds" and
  // "the viewer misses those seconds", which is what a nudge costs: each one
  // skips content — first two seconds, then six, then ten — that was decodable
  // sound the viewer never gets to hear. Cleared the moment a frame reaches the
  // screen, and by any seek or source change.
  private _soundCarryingAlone: boolean = false;
  /** framesPresented when the sound took over, so a picture that comes back on
   *  its own can end the hand-over even if the gate that watches for it was
   *  cleared by something else. */
  private _soundCarryingFrames = 0;
  /** Set for the one seek that STARTS the hand-over, so seek() re-primes the
   *  pipeline where the playhead is without cancelling it. */
  private _carrySoundThroughNextSeek: boolean = false;

  // ── The audio-only tail ────────────────────────────────────────────────
  // Some files carry audio past the end of their video: a phone recording
  // whose camera app cut the video track at 80s while the mic ran to 161s, a
  // stream remuxed from a feed that dropped its video mid-way, a concatenated
  // file with a music-only outro. There are no more video packets to come, so
  // every pipeline that treats an empty video queue as "the picture is late"
  // is wrong here — the picture is FINISHED. Bound (bindav, the default), that
  // read froze the whole thing: buffering at 80.5s, the element's stuck
  // watchdog nudging the playhead forward, each nudge seeking into a region
  // with no frame to decode, black-frame recovery burning its budget, and the
  // file ending on an error overlay with 80 seconds of audio never played.
  //
  // What should happen is what a native player does: the last frame stays on
  // screen and the sound plays on to the end of the file.
  //
  // Two independent detectors, because one of them can be absent:
  //  - the container's per-stream duration, exact and known before playback
  //    starts (MP4/Matroska both write it; see Track.duration), which is also
  //    what lets a SEEK into the tail know not to wait for a frame; and
  //  - the demuxer's own read cursor, for a container that declares nothing
  //    useful — audio packets arriving far past the newest video packet mean
  //    the video has stopped whatever the header claims.
  /** Media time from which the file has audio but no video. */
  private _videoTailStart: number = Number.POSITIVE_INFINITY;
  /**
   * Media time from which the file has video but no audio — the mirror of
   * _videoTailStart, and read the same way: from the audio track's own declared
   * duration, before playback starts.
   *
   * A container writes its streams to whatever lengths it likes. The player
   * already knew about a picture that stops before the file does and lets the
   * sound play on past the last frame. The other way round it did not: an audio
   * track that stops early left the master clock pinned at the last sample — it
   * is the audio that times playback — and everything downstream read the
   * silence as a fault. Measured on a 4K AV1 MKV whose Opus track ends at
   * 193.4s of a 243.8s film: playback stopped at 3:13 with fifty seconds left.
   *
   * Past here the picture carries playback on its own, exactly as the sound
   * does in the other tail.
   */
  private _audioTailStart: number = Number.POSITIVE_INFINITY;
  /** pts of the newest video packet the demuxer has handed us. */
  private _lastVideoPacketPts: number = -1;
  // How far audio may run ahead of the last video packet before the runtime
  // detector calls it a tail. Generous on purpose: interleave is a container's
  // own business and a coarsely-muxed file can legitimately hand over several
  // seconds of one stream at a time. Nothing is lost by deciding late — the
  // container-declared duration has usually decided already — and a false
  // positive only means the player declines to stall for a picture, which it
  // undoes the moment a video packet arrives.
  private static readonly VIDEO_TAIL_GAP_S = 6;
  /** pts of the newest audio packet the demuxer has handed us — the mirror of
   *  _lastVideoPacketPts, and the runtime half of _audioTailStart for the
   *  containers that declare no per-stream duration at all. This file's MKV
   *  declares none: both tracks report undefined, so the up-front read can
   *  never fire and only the cursors can tell. */
  private _lastAudioPacketPts: number = -1;
  // Video packets read since the last audio one. The pts gap alone is too
  // coarse to catch a soundtrack ending: read-ahead makes a few seconds of
  // video-ahead-of-audio normal, so the gap bar has to be wide, and by the
  // time it trips the damage is done. A COUNT does not have that problem —
  // audio packets are more frequent than video ones on any ordinary
  // interleave, so a long run of video with no audio between it means the
  // audio has stopped in the file, whatever the timestamps say.
  private _videoPacketsSinceAudio: number = 0;
  /** Media time the current continuous read pass began at — a load, or the
   *  last seek. Tells the EOF check whether "no audio packet was seen" means
   *  the sound has ended or merely that we started reading past it. */
  private _audioReadPassStart: number = 0;
  /** How far the picture may run past the newest audio packet before the
   *  runtime detector calls it a tail. Same reasoning and same value as
   *  VIDEO_TAIL_GAP_S: interleave is the container's business, deciding late
   *  costs nothing, and a video packet arriving retracts nothing while an
   *  audio packet does. */
  private static readonly AUDIO_TAIL_GAP_S = 6;
  private _activeSubtitleLang: string = "";
  private _externalSubCues: SubtitleCue[] = [];
  /**
   * Subtitle tracks whose cues were handed to us rather than fetched — see
   * appendSubtitleCues. Keyed by lang, each list kept sorted by start. The
   * array IS what the external renderer reads when that lang is active, so an
   * append shows up on the next tick without a reload.
   */
  private _generatedSubCues = new Map<string, SubtitleCue[]>();
  /** Generated tracks still waiting for their first cue — listed with a
   *  working indicator rather than as an empty track that does nothing. */
  private _pendingSubLangs = new Set<string>();
  private _externalSubTimer: number | null = null;
  public trackManager: TrackManager;
  private clock: Clock;
  private stateManager: PlayerStateManager;
  private mediaInfo: MediaInfo | null = null;
  private fileSize: number = -1; // Cached file size for buffer calculations
  private lastBufferedTime: number = 0;
  // Where the current buffering run started, in media time: 0 on load, the
  // seek target after a seek. The buffer bar spans [this .. getBufferedTime()].
  // Without it the bar is drawn from 0, so seeking to 20:00 instantly paints
  // everything before 20:00 as buffered when none of it has been fetched.
  private bufferedRangeStart: number = 0;

  /**
   * Enable/disable seek-bar scrub previews on an already-constructed player.
   * Lets the `thumb` attribute be toggled at runtime (or applied after `src`,
   * whose callback creates the player first) without recreating the player.
   * The thumbnail pipeline stays lazy — it only spins up on the first hover.
   */
  setPreviewsEnabled(enabled: boolean): void {
    this.config.enablePreviews = enabled;
    // Turning previews back on clears the "gave up" latch so a prior failed
    // init (or a never-attempted one) can retry on the next hover.
    if (enabled) this.previewInitGaveUp = false;
  }

  /**
   * The longest edge a preview JPEG is worth encoding at.
   *
   * The card is about 160px wide. Encoding the frame at its own size — 1920,
   * or 3840 on a 4K source — spends the time on pixels the browser then throws
   * away scaling it down: measured at 519KB and ~45ms a frame on 4K60, per
   * hovered position, on a fast desktop. Downscaling first costs one draw.
   */
  private static readonly PREVIEW_MAX_EDGE = 480;

  /**
   * How big a frame the SOFTWARE preview decoder may be asked for.
   *
   * Only reached when WebCodecs refuses the source outright — 8K H.264 is
   * refused by every browser tested. The cost is the decode, which is the
   * source's own size whatever the scaler is then asked for: measured in WASM
   * on this machine, ~250-330ms of blocked main thread per 8K frame, and over
   * a second for the first. 4K UHD (8.3MP) sits just under the line and stays.
   */
  private static readonly PREVIEW_SOFTWARE_MAX_PIXELS = 9_000_000;

  /**
   * Is the source too big to preview in software?
   *
   * Asked in two places, because a browser can refuse the source at
   * configure() — Chrome does, for 8K H.264 — or accept it and then fail to
   * produce a frame, which is what a decoder that cannot really do this size
   * looks like from here. Both end at the same software decoder, and at that
   * size it stalls the page either way.
   */
  private previewSoftwareTooBig(): boolean {
    const track = this.trackManager.getActiveVideoTrack();
    if (!track?.width || !track?.height) return false;
    return track.width * track.height > MoviPlayer.PREVIEW_SOFTWARE_MAX_PIXELS;
  }

  /**
   * The source's shape, shrunk to the size a preview is actually shown at.
   *
   * Everything on the preview path used to work at the source's own
   * resolution and shrink at the very end, one step before the JPEG. On an 8K
   * source that means a 7680x4320 RGBA buffer — 132MB — scaled by the decoder,
   * copied out of WASM, uploaded as a texture and drawn, per hover, for a
   * picture that is then thrown away and redrawn at 480px. Measured on 8K
   * H.264: 1.7-2.4s per preview with the main thread stalled for up to 2.1s of
   * it, which is the seek bar hanging the player while the keyboard seeks fine.
   *
   * The scaler has to resize the frame either way, so asking it for the size
   * the picture is wanted at costs nothing and saves all of the above.
   */
  private static previewShape(
    width: number,
    height: number,
  ): { width: number; height: number } {
    const longest = Math.max(width, height);
    if (!(longest > MoviPlayer.PREVIEW_MAX_EDGE) || !(width > 0) || !(height > 0)) {
      return { width, height };
    }
    const scale = MoviPlayer.PREVIEW_MAX_EDGE / longest;
    return {
      width: Math.max(2, Math.round(width * scale)),
      height: Math.max(2, Math.round(height * scale)),
    };
  }
  private previewScaleCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  /**
   * Frames already made, kept by the second they belong to.
   *
   * Scrubbing asks for a new time every few pixels of pointer travel, and the
   * pipeline is one decoder: each request seeks, decodes and encodes from
   * scratch, so a viewer moving back and forth over the same stretch paid for
   * the same frames again and again — and the card sat on its loading state
   * every time. A second is finer than the strip can show, so quantising to it
   * costs nothing and makes the second pass over any stretch instant.
   *
   * Bounded and insertion-ordered: the oldest entry goes when it is full, which
   * for scrubbing is the part of the timeline the pointer has left behind.
   */
  // Counted in cache steps, not seconds — see PREVIEW_CACHE_STEP_S. Raised
  // with the step so the window of scrubbing a viewer can go back over
  // without re-decoding stays about the same length of film.
  private static readonly PREVIEW_CACHE_MAX = 200;
  private previewCache = new Map<number, Blob>();

  /**
   * The same frames again, filed under the keyframe they actually came from.
   *
   * Outside precise mode a preview IS the keyframe at or before the hovered
   * time, so every position inside one GOP is the same picture — and on a
   * long-GOP source that is seconds of timeline. The time-keyed cache above
   * cannot know that: it files by where the pointer was, so a scrub across a
   * single GOP missed on every step of it and paid a full decode and JPEG
   * encode (~11ms of the ~16ms a preview costs) to arrive at pixels it already
   * had.
   *
   * This map is consulted AFTER the seek, because the seek is what says which
   * keyframe the time belongs to — 4ms rather than 16, with no guess about
   * where the GOP boundaries are and so no risk of showing the wrong frame.
   */
  private previewByKeyframe = new Map<number, Blob>();

  /**
   * How finely the preview cache tells one moment from another.
   *
   * It was a whole second — Math.round(time) — and a whole second is also how
   * often the picture could then change. Every hover inside it was answered
   * with the same remembered frame, so a scrub across ten seconds of a film
   * showed ten pictures however carefully the frame under the pointer had been
   * decoded. The precision the decode paid for never reached the screen.
   *
   * A fifth of a second is fine enough to read as continuous while dragging,
   * and still coarse enough that a pointer trembling on one spot is answered
   * from memory rather than re-decoded.
   */
  private static readonly PREVIEW_CACHE_STEP_S = 0.2;

  /** The cache key for a time, or null when the frame can't be reused. */
  private previewKey(time: number, view?: VRView | null): number | null {
    // A 360 preview is reprojected to wherever the viewer is looking, so the
    // same second is a different picture from one moment to the next.
    if (view) return null;
    if (!Number.isFinite(time)) return null;
    return Math.round(time / MoviPlayer.PREVIEW_CACHE_STEP_S);
  }

  /**
   * Is this position's picture already in hand?
   *
   * Asked BEFORE a preview is dispatched, by the pacer that otherwise waits
   * for the pointer to settle. That wait exists to stop a scrub spending a
   * 2MB range fetch at every position it crosses — but a frame that is
   * already remembered costs nothing to produce, so waiting for it buys
   * nothing and is simply 180ms of delay. Synchronous on purpose: a pacer
   * that had to await this could not decide in the same tick as the move.
   */
  hasPreviewFor(time: number, view?: VRView | null): boolean {
    const key = this.previewKey(time, view);
    return key !== null && this.previewCache.has(key);
  }

  private rememberPreview(key: number, blob: Blob): void {
    this.previewCache.set(key, blob);
    while (this.previewCache.size > MoviPlayer.PREVIEW_CACHE_MAX) {
      const oldest = this.previewCache.keys().next();
      if (oldest.done) break;
      this.previewCache.delete(oldest.value);
    }
  }

  /** The keyframe map's key for a decoded packet's pts, or null if unusable. */
  /**
   * The thumbnail demuxer's current packet, in the same time base as everything
   * that asks it questions.
   *
   * It reports the packet's RAW pts — `pkt->pts * time_base`, with no
   * `start_time` taken off — while every hover, target and duration on this
   * side of the WASM boundary is media time from zero. On a source whose
   * stream starts at zero those are the same number and nothing shows; on one
   * that does not, they are apart by exactly that offset, and three separate
   * things quietly read the wrong answer.
   *
   * Measured on a 47.7s 4K HEVC MPEG-TS whose stream starts at 1.050044s
   * (LG-Daylight-4K): a hover at 12.5s took the keyframe at raw 11.878 —
   * 10.827 in media time, and the file's own keyframe list confirms 11.877522
   * is a real raw pts, so the value is raw beyond doubt. The walk then stopped
   * at raw 12.545 because it breaks on `pts >= time`, which is media 11.495:
   * a preview one full second before the pointer, every time, sixty frames out
   * at this file's 59.94fps. Where the keyframe happened to land within the
   * offset of the hover, `timestamp < time` was false and the walk did not run
   * at all — precise mode falling back to the plain keyframe with nothing said.
   * And the renderer picks the frame nearest `targetSec`, which is media time,
   * against chunk timestamps that were raw — the same offset a third time.
   *
   * The C seek does normalise (it adds `start_time` to its target), so the
   * frame fetched was always the right one; only the arithmetic about it was
   * wrong. Correcting it here rather than in the WASM keeps the fix on the
   * side that owns the media-time convention, and needs no rebuild.
   */
  private previewPacketPts(): number {
    const raw = this.thumbnailBindings?.getPacketPts() ?? 0;
    if (!Number.isFinite(raw)) return raw;
    return raw - this.startTime;
  }

  private keyframeKey(pts: number): number | null {
    if (!Number.isFinite(pts)) return null;
    // Milliseconds: fine enough that two different keyframes never collide,
    // coarse enough that the same one always hashes the same way.
    return Math.round(pts * 1000);
  }

  private rememberKeyframePreview(pts: number, blob: Blob): void {
    const kfKey = this.keyframeKey(pts);
    if (kfKey === null) return;
    this.previewByKeyframe.set(kfKey, blob);
    while (this.previewByKeyframe.size > MoviPlayer.PREVIEW_CACHE_MAX) {
      const oldest = this.previewByKeyframe.keys().next();
      if (oldest.done) break;
      this.previewByKeyframe.delete(oldest.value);
    }
  }

  /** Drop remembered frames — the pictures behind them are no longer the file. */
  private clearPreviewCache(): void {
    this.previewCache.clear();
    this.previewByKeyframe.clear();
  }

  /**
   * Pictures the source brought with it (see utils/Storyboard).
   *
   * When a source has a storyboard, a preview costs a crop out of an image the
   * browser already has, instead of a seek, a decode and an encode — and the
   * second WASM module the decode path needs is never opened at all. Set from
   * the element's `storyboard` attribute or property; a URL is a WebVTT
   * thumbnail track, an object is a tile spec.
   */
  private storyboardSource: string | StoryboardSpec | null = null;
  private storyboard: Storyboard | null = null;
  private storyboardLoad: Promise<Storyboard | null> | null = null;
  /** Mosaics already fetched, by URL — one image serves dozens of previews. */
  private storyboardImages = new Map<string, Promise<ImageBitmap | null>>();
  private storyboardCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

  setStoryboard(source: string | StoryboardSpec | null): void {
    if (source === this.storyboardSource) return;
    this.storyboardSource = source;
    this.storyboard = null;
    this.storyboardLoad = null;
    this.storyboardImages.clear();
    this.clearPreviewCache();
    // Load the BOARD now rather than on the first hover. It is a few KB of
    // text (or nothing at all, for a spec), and waiting until the pointer
    // arrives means the one hover that matters most — the first — is the one
    // that has to wait for it.
    //
    // The mosaics it names are a different matter: those are real pictures,
    // and pulling one here put a fetch of hundreds of KB alongside the opening
    // buffer, which is bandwidth the video needs more than a hover nobody has
    // made yet. They are warmed once playback is running instead — by the
    // element, which paints them and knows when that moment arrives (see
    // MoviElement.flushStoryboardWarm). Nothing is lost if there is no element:
    // cropStoryboardTile fetches the sheet it needs on demand, as it always
    // did.
    if (source) void this.ensureStoryboard();
  }

  /** The board's mosaics in order, for a caller that paints them itself. */
  getStoryboardSheets(): string[] {
    return this.storyboard?.sheets() ?? [];
  }

  /**
   * The same list, but once the board has actually been parsed — for a caller
   * that wants to pull the pictures in before anybody hovers.
   *
   * getStoryboardSheets answers from what is in hand, so at load time (the one
   * moment worth warming at) it answers with nothing: a VTT track is still in
   * flight. Resolves to an empty list when there is no board, or when it turns
   * out not to have one — never rejects, because a storyboard is an
   * optimisation and its absence is not an error.
   */
  whenStoryboardReady(): Promise<string[]> {
    if (!this.storyboardSource) return Promise.resolve([]);
    return this.ensureStoryboard().then((board) => board?.sheets() ?? []);
  }

  /** True while a storyboard is standing in for the decode path. */
  hasStoryboard(): boolean {
    return this.storyboardSource !== null;
  }

  /**
   * The tile for a moment, RIGHT NOW — no promise, no crop, no encode.
   *
   * Cropping a tile into a blob costs a canvas draw, a JPEG encode and an
   * image decode on the other side, and the caller has to await all of it. A
   * caller that can paint the mosaic itself (the seek card, with a background
   * offset) needs none of that: it needs the rectangle, and it needs it in the
   * same frame the pointer moved. Returns null until the board is parsed —
   * asking starts that, so the next move is answered.
   */
  getStoryboardTileSync(time: number): StoryboardTile | null {
    if (!this.storyboardSource) return null;
    if (!this.storyboard) {
      void this.ensureStoryboard();
      return null;
    }
    return this.storyboard.tileAt(time);
  }

  private ensureStoryboard(): Promise<Storyboard | null> {
    if (this.storyboard) return Promise.resolve(this.storyboard);
    if (this.storyboardLoad) return this.storyboardLoad;
    const source = this.storyboardSource;
    if (!source) return Promise.resolve(null);

    // A spec needs no fetch — and, in the sprite form, needs the video's length,
    // which may not be known yet. Answer it here rather than inside the cached
    // promise below: caching a "not yet" would make it the answer forever.
    if (typeof source !== "string") {
      const board = Storyboard.fromSpec(source, this.getDuration());
      if (!board) return Promise.resolve(null);
      this.storyboard = board;
      Logger.info(
        TAG,
        `Storyboard ready: ${board.coverage.toFixed(0)}s covered`,
      );
      return Promise.resolve(board);
    }

    this.storyboardLoad = (async () => {
      try {
        if (typeof source === "string") {
          const res = await fetch(source, {
            signal: this.lifetimeSignal,
            ...(this.config.headers ? { headers: this.config.headers } : {}),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const url = res.url || source;
          this.storyboard = Storyboard.parseVtt(await res.text(), url);
        }
        if (!this.storyboard) {
          Logger.warn(TAG, "Storyboard had no usable cues — falling back to decoding previews");
        } else {
          Logger.info(
            TAG,
            `Storyboard ready: ${this.storyboard.coverage.toFixed(0)}s covered`,
          );
        }
      } catch (e) {
        // A storyboard is an optimisation, never a requirement: losing it costs
        // speed, and the decode path answers exactly as it did before.
        Logger.warn(TAG, `Storyboard load failed: ${(e as Error)?.message ?? e}`);
        this.storyboard = null;
        this.storyboardSource = null;
      }
      return this.storyboard;
    })();
    return this.storyboardLoad;
  }

  private loadStoryboardImage(url: string): Promise<ImageBitmap | null> {
    const existing = this.storyboardImages.get(url);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const res = await fetch(url, {
          signal: this.lifetimeSignal,
          ...(this.config.headers ? { headers: this.config.headers } : {}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await createImageBitmap(await res.blob());
      } catch (e) {
        Logger.warn(TAG, `Storyboard mosaic failed: ${(e as Error)?.message ?? e}`);
        return null;
      }
    })();
    this.storyboardImages.set(url, pending);
    return pending;
  }

  /** Cut one tile out of its mosaic and hand it over as a preview. */
  private async cropStoryboardTile(
    tile: StoryboardTile,
  ): Promise<Blob | null> {
    const image = await this.loadStoryboardImage(tile.url);
    if (!image) return null;
    const w = tile.width > 0 ? tile.width : image.width;
    const h = tile.height > 0 ? tile.height : image.height;
    if (
      !this.storyboardCanvas ||
      this.storyboardCanvas.width !== w ||
      this.storyboardCanvas.height !== h
    ) {
      if (typeof OffscreenCanvas !== "undefined") {
        this.storyboardCanvas = new OffscreenCanvas(w, h);
      } else {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        this.storyboardCanvas = c;
      }
    }
    const ctx = (this.storyboardCanvas as HTMLCanvasElement).getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return null;
    ctx.drawImage(image, tile.x, tile.y, w, h, 0, 0, w, h);
    return this.encodePreviewBlob(this.storyboardCanvas);
  }

  /**
   * Encode what has been rendered into `src` as a preview JPEG, shrinking it
   * first when it is bigger than a preview needs to be.
   */
  private encodePreviewBlob(
    src: OffscreenCanvas | HTMLCanvasElement,
  ): Promise<Blob | null> {
    const w = src.width;
    const h = src.height;
    const longest = Math.max(w, h);
    let out: OffscreenCanvas | HTMLCanvasElement = src;
    if (longest > MoviPlayer.PREVIEW_MAX_EDGE && w > 0 && h > 0) {
      const scale = MoviPlayer.PREVIEW_MAX_EDGE / longest;
      const dw = Math.max(1, Math.round(w * scale));
      const dh = Math.max(1, Math.round(h * scale));
      if (
        !this.previewScaleCanvas ||
        this.previewScaleCanvas.width !== dw ||
        this.previewScaleCanvas.height !== dh
      ) {
        if (typeof OffscreenCanvas !== "undefined") {
          this.previewScaleCanvas = new OffscreenCanvas(dw, dh);
        } else {
          const c = document.createElement("canvas");
          c.width = dw;
          c.height = dh;
          this.previewScaleCanvas = c;
        }
      }
      const ctx = (
        this.previewScaleCanvas as HTMLCanvasElement
      ).getContext("2d") as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (ctx) {
        ctx.drawImage(src as CanvasImageSource, 0, 0, dw, dh);
        out = this.previewScaleCanvas;
      }
    }
    if (typeof OffscreenCanvas !== "undefined" && out instanceof OffscreenCanvas) {
      return out.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    }
    return new Promise<Blob | null>((resolve) => {
      (out as HTMLCanvasElement).toBlob(
        (blob) => resolve(blob),
        "image/jpeg",
        0.7,
      );
    });
  }

  /**
   * Walk forward from the keyframe to the frame the pointer is actually on.
   *
   * A preview is normally the keyframe at or before the hovered time, because
   * that is the one frame a seek can hand over for free. On a long-GOP source
   * — a WEB-DL with 5-10s between keyframes — that is a picture from seconds
   * away from where the viewer is pointing. Precise mode decodes the frames in
   * between and shows the one that belongs to the hovered second instead.
   *
   * Off by default: it is the same decode the player does for playback, on the
   * hover path, so it costs a run of frames per preview rather than one — and
   * the run is as long as the source's GOP, since a walk that gives up part
   * way is a keyframe preview wearing this mode's name.
   */
  private precisePreviews = false;

  setPrecisePreviews(enabled: boolean): void {
    this.precisePreviews = enabled;
  }

  /**
   * Can a preview still cost a network read, or is every frame it will be
   * asked for already in hand?
   *
   * The seek bar asks before it decides how hard to push: a preview made from
   * bytes the machine already holds can be asked for as fast as the pointer
   * moves, but one that has to fetch cannot. The thumbnail reader pulls a 2MB
   * window per position, and a scrub is a run of positions — so asking for
   * every one of them puts the fetch for the frame the viewer actually stopped
   * on at the BACK of a queue of fetches for frames they only passed over. The
   * bar answers that by waiting for the pointer to settle first; this is how it
   * knows to.
   *
   * False for a local file (nothing to fetch, ever) and for an HTTP source
   * whose bytes are all in memory — a small file that has finished downloading
   * scrubs like a local one and must not be slowed down to match a link it is
   * no longer using. True for an adaptive stream, whose thumbnail tiles are
   * fetched per position by the wrapper.
   *
   * A source adapter from outside this file answers neither test and so counts
   * as fetching, which is the right way round to be wrong: a custom adapter is
   * a remote one until shown otherwise, and the cost of pacing one that turns
   * out to be local is a fraction of a second of settle, against a queue of
   * whole fetches the other way.
   */
  previewsMayFetch(): boolean {
    if (this.streamWrapper) return true;
    if (!this.source) return false;
    if (this.source instanceof FileSource) return false;
    return !(
      this.source as { isFullyCached?: () => boolean }
    ).isFullyCached?.();
  }

  private previewsAllowed(): boolean {
    if (!this.config.enablePreviews) return false;
    // Non-range sources keep previews ON: the thumbnail source borrows frames
    // straight from the main source's RAM window (no network), so previews work
    // for any position inside the buffered/seekable range.
    // NOTE: a file-size cap used to live here — the seek-bar thumbnail
    // pipeline opens a SECOND isolated WASM module + FFmpeg context, and on
    // large 1 GB+ sources the two heaps can exhaust the tab's memory budget,
    // making a later memory.grow() fail and trapping FFmpeg with "memory
    // access out of bounds" mid-playback. The cap was removed deliberately to
    // allow previews on big files; if OOM crashes resurface on large 4K
    // sources, reinstating a size gate here is the first thing to try.
    // No real video stream → nothing to scrub. Skipping here keeps
    // audio-only sources from opening a useless second WASM context
    // (the cover-art extractor already spins up its own short-lived one).
    if (this.trackManager.getVideoTracks().length === 0) return false;
    return true;
  }

  /** Proxy a stream wrapper's events + mirror its TrackManager onto the player. */
  private wireStreamWrapper(wrapper: StreamWrapper): void {
    const events = [
      "loadStart", "loadEnd", "play", "pause", "ended", "timeUpdate",
      "durationChange", "stateChange", "error", "buffering", "seeking", "seeked",
    ] as const;
    events.forEach((evt) => {
      // @ts-ignore — event names line up across the wrapper and player maps
      wrapper.on(evt, (arg) => this.emit(evt, arg));
    });
    wrapper.trackManager.on("tracksChange", (tracks) => {
      this.trackManager.setTracks(tracks);
    });
  }

  // Decoders and Renderers
  private videoDecoder: MoviVideoDecoder;
  private audioDecoder: MoviAudioDecoder;
  private subtitleDecoder: SubtitleDecoder | null = null;
  // Host-supplied subtitle renderer (e.g. jassub/libass for ASS). When set, the
  // active subtitle stream is routed to it instead of the internal decoder.
  private _customSubtitleRenderer: SubtitleRenderer | null = null;
  private _subtitleRenderRAF: number | null = null;
  private _subtitleDelaySec = 0;
  private videoRenderer: CanvasRenderer | null = null;

  // Stream id of the subtitle track whose entire cue list has already been
  // prefetched into the renderer cache. Used to avoid scanning twice when
  // the user nudges the delay value while the same track is active.
  private prefetchedSubtitleStream: number | null = null;
  private prefetchInFlight: boolean = false;

  // Embedded cover art (ID3v2 APIC, FLAC PICTURE, MP4 covr, MKV attachment).
  // Extracted once at load time when the demuxer reports an attached_pic
  // pseudo-stream; null for plain video files or audio without artwork.
  private coverArt: ImageBitmap | null = null;

  // Active adaptive-streaming wrapper (Shaka primary, hls.js/dash.js fallback).
  // Non-null only while a stream source is active; delegation throughout the
  // player stays format-agnostic.
  private streamWrapper: StreamWrapper | null = null;

  // Preview pipeline (C-based FFmpeg software decoding)
  private thumbnailBindings: ThumbnailBindings | null = null;
  /** The half-built pipeline, while it is still being built. It holds an
   *  FFmpeg context from the moment it exists, so teardown has to be able to
   *  find it even though callers must not — see initPreviewPipeline. */
  private thumbnailBindingsPending: ThumbnailBindings | null = null;
  private thumbnailSource: SourceAdapter | null = null;
  private thumbnailRenderer: ThumbnailRenderer | null = null;
  private thumbnailHDREnabled: boolean = true; // HDR enabled by default
  private isPreviewGenerating: boolean = false;
  /** The generation currently in flight, for callers that must WAIT rather
   *  than be turned away — see getPreviewFrame's `queue` argument. */
  private previewInFlight: Promise<Blob | null> | null = null;
  private audioRenderer: AudioRenderer;
  // Bumped every time the preview pipeline is torn down, so an init still
  // suspended in one of its awaits can tell that the pipeline it is building
  // belongs to a source (or a player) that is already gone.
  private _previewGeneration = 0;
  private previewInitPromise: Promise<void> | null = null; // Guard for preview initialization
  private previewInitAttempts: number = 0; // Bounded retries for preview pipeline init
  // Deferred eager preview warm-up (see load()): keeps the thumbnail decoder
  // from competing with the main decode during the startup grace.
  private _previewWarmTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PREVIEW_WARM_DELAY_MS = 12000;
  // How long to wait before re-asking when the warm-up came due while playback
  // was still young, or while the pipeline was busy seeking/rebuffering.
  private static readonly PREVIEW_WARM_RETRY_MS = 2000;
  // Idle wait before the preview reader's 2MB fetch window is released.
  private _thumbBufferIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly THUMB_BUFFER_IDLE_MS = 8000;
  // Background recovery of a duration the container never stored. One attempt
  // per source; see rescanDurationInBackground.
  private _durationRescanTimer: ReturnType<typeof setTimeout> | null = null;
  private _durationRescanDone: boolean = false;
  private static readonly DURATION_RESCAN_DELAY_MS = 3000;
  private previewInitGaveUp: boolean = false; // Stop retrying once init has failed too often

  // Debug flag to disable audio processing
  private disableAudio: boolean = false; // Set to true to disable audio for debugging
  // Audio-only mode (data-saver): skip video decoding to save CPU (the
  // demuxer still reads the interleaved bytes, but decode is the expensive
  // part); for adaptive streams the wrapper also drops the video renditions to
  // save bandwidth. The UI switches to the album-art / strip surface.
  private _audioOnly: boolean = false;
  private muted: boolean = false; // Mute state
  /**
   * Bind the two streams: either one running out stops both.
   *
   * Off (the default) each side is allowed to carry on while the other is
   * short. That is asymmetric in practice, because the two run out for
   * different reasons. Video runs out on the WIRE — it is an order of
   * magnitude the bigger stream, so on a slow link it is always the one
   * refilling, and the sound sails on over a frozen frame until the picture
   * comes back seconds behind what you have already heard. Audio runs out on
   * the CPU — an expensive codec decoding slower than realtime — and there the
   * picture carries on over sound full of holes.
   *
   * Bound — the default — neither happens: whichever side empties, playback
   * buffers, both are suspended, and they start again together when both are
   * ready. The cost is that a shortfall you would previously have watched or
   * listened through becomes a full stop, which is the honest thing to show:
   * a picture running seconds behind the sound is not playback anyone asked
   * for. `bindav="false"` unbinds them for a caller who would rather have the
   * stutter.
   *
   * The one case that would suffer from this is a picture that is merely slow
   * to DECODE, and that is not this: the frames-presented check below restarts
   * the stall window whenever frames are still reaching the screen, so a source
   * decoding at half rate keeps stuttering along rather than turning into a
   * spinner.
   */
  private _bindAV: boolean = true;

  /**
   * Does this source actually have a picture to wait for?
   *
   * Canvas mode builds a CanvasRenderer for EVERY source, audio-only included —
   * the strip a music file plays behind is that same renderer. So
   * `!!this.videoRenderer` says "we could draw", never "there is anything to
   * draw", and every place that read it as the latter was asking a video-less
   * file to produce a frame. Its queue is empty forever, which is
   * indistinguishable from a video source whose queue has just run dry.
   *
   * Measured on a FLAC-only .mka: the stall detector's `videoEmpty` was
   * permanently true and `_bindAV` defaults to true, so `videoStalled` held
   * from the first tick — and `bufferingForVideo`, also gated on the renderer
   * merely existing, lifted the audio ceiling for the whole of the buffering
   * that followed. The file played 0.51s, stalled, swallowed 141 SECONDS of
   * audio in one uninterrupted read, sat in buffering for 5.5s, resumed, and
   * did it again: five cycles in 5.6s of media.
   *
   * The honest question is whether the SOURCE carries video, so ask that.
   */
  private get hasPicture(): boolean {
    return !!this.videoRenderer && !!this.trackManager?.getActiveVideoTrack();
  }
  private wasPlayingBeforeRebuffer: boolean = false; // Track if we were playing before entering rebuffering state
  /**
   * Buffering is over and play() has been called, but the state is not
   * "playing" yet.
   *
   * Leaving buffering sets "paused" and then calls play(), which is async — it
   * resumes the AudioContext and re-anchors before it flips the state, ~60ms
   * later. The decoder does not wait for any of that: it is mid-burst on the
   * packets the prebuffer read, and onFrame bins every frame that arrives
   * outside "playing"/"buffering". Measured on a 20s 1080p30 video-only file,
   * first play: 33 frames closed between 0.300s and 1.400s, and the picture
   * then froze for 1.1s at 0.300s while the clock ran through the hole they
   * left. The frames were decoded, correct, and thrown away.
   *
   * So this says the resume is in flight, and the queue stays open across it.
   */
  private _resumeToPlayPending: boolean = false;
  private _stallStartTime: number = 0; // When stall was first detected
  /** performance.now() of the last frame decoded while a seek waited for sync —
   *  the signal that the seek is still working. See the seek deadline. */
  private _seekFrameProgressAt: number = 0;
  /** How long the video decoder may go silent mid-seek before the seek is
   *  declared stuck. One 4K AV1 frame is a few tens of ms even on a slow
   *  machine, so a gap this long means it has stopped, not slowed. */
  private static readonly SEEK_PROGRESS_IDLE_MS = 400;
  /** …and the ceiling on extending, because a decoder emitting frames that
   *  never reach the target is itself a failure to give up on. */
  private static readonly SEEK_PROGRESS_CAP_MS = 10000;
  /** framesPresented when the current stall window opened — the baseline the
   *  "is the picture still moving?" test measures against. */
  private _stallStartFrames: number = 0;
  /** Presented-frames-per-second at or above which an empty video queue is a
   *  slow decoder, not a stall. Deliberately low: this is the line between
   *  "watchable, if choppy" and "frozen", not a quality bar. A 60fps source
   *  running at 30, or a 24fps one dropping half its frames, is comfortably
   *  over it; a picture that has actually stopped presents nothing at all. */
  private static readonly STALL_MOVING_FPS = 5;
  // How recently the video decoder must have produced a frame for the picture
  // to count as alive-but-slow rather than stalled. Generous on purpose: at the
  // ~20fps a struggling 8K decode manages, frames are 50ms apart, and even a
  // GOP-sized hiccup stays well inside this. Past it, nothing is coming and the
  // stall is real.
  private static readonly DECODE_ALIVE_WINDOW_MS = 400;
  private _bufferingEntryTime: number = 0; // When we entered buffering state
  // True while the current buffering spell is the post-seek wait for the frame
  // queue rather than a real stall — see needsSeekResumeQueue().
  private _seekResumeQueueWait: boolean = false;
  // True when the current buffering state was entered because of something WE
  // just did — a rate change's audio re-anchor, or a seek resuming on the thin
  // buffer it left behind — rather than a real data/decode stall. Those resume
  // the moment the pipeline is ready instead of serving the stall floor.
  private _bufferingSelfInflicted: boolean = false;
  private _lastRateChangeAt: number = 0;
  /** When audio last changed language in place. A stall in the moments after
   *  belongs to that swap — the renderer was reset and the decoder is cold —
   *  not to the link, and the ABR must not read it as the rung failing. */
  private _lastAudioSwitchAt: number = 0;
  private _lastSeekResumeAt: number = 0;
  /**
   * How long after a seek resumes the picture on screen may still be one from
   * BEFORE it, and how far apart the two have to be to say so. See the audio
   * desync guard — a gap of seconds this soon after a seek is a leftover
   * frame, not drift, and chasing it undoes the seek.
   */
  private static readonly SEEK_STALE_PICTURE_MS = 3000;
  private static readonly SEEK_STALE_PICTURE_GAP_S = 3;

  /**
   * How far the picture may outrun the sound and still count as a tail rather
   * than as content. A container writes the two tracks to slightly different
   * lengths all the time — a frame or two — and that tail can never come due
   * against a clock the audio pins. Beyond this it is not a rounding artefact,
   * it is film, and it gets played. See the EOF block.
   */
  private static readonly AUDIO_TAIL_GRACE_S = 1.0;

  /** When an in-place rendition swap actually LANDED, and when a picture
   *  catch-up started. Both leave the video pipeline re-priming while the sound
   *  plays on, so a stall in the moments after is ours, not the link's. */
  private _lastRenditionSwapAt: number = 0;
  private _lastVideoCatchUpAt: number = 0;
  /**
   * How long after a swap its catch-up still owns a stall.
   *
   * The hard path deliberately lands RENDITION_SWAP_LOOKBACK_S behind the
   * playhead, so the new rendition has that much to fetch and decode before it
   * reaches the sound. At 4K60 that is not the blink it is at 720p, and the
   * stall it ends in was read as the rung failing — which dropped a rung, whose
   * own swap stalled the same way, all the way down the ladder.
   */
  private static readonly POST_SWAP_CATCHUP_MS = 10000;
  /**
   * How little must be buffered ahead for a stall to be about the LINK. A link
   * that cannot carry the rung starves the buffer to nothing; anything above
   * this and the bytes were already there.
   */
  private static readonly ABR_STALL_STARVED_S = 5;
  /** How long after a rate change or a seek's resume an audio stall is still
   *  attributable to the flush/re-anchor that operation performed itself. */
  private static readonly SELF_INFLICTED_STALL_WINDOW_MS = 1500;
  /** The renderer queue depth below which the picture counts as having run
   *  OUT, rather than merely being short — the point past which the audio
   *  cushion's cap must not be what holds the demuxer shut. A quarter of the
   *  queue's own cap, so it scales with the cap's own reasoning (VRAM on 8K,
   *  wall-clock on mobile, deep on desktop), held between these two so a very
   *  shallow cap cannot put the floor at the stall itself and a very deep one
   *  cannot keep the exemption standing through ordinary playback. */
  private static readonly PICTURE_FLOOR_MIN_FRAMES = 4;
  private static readonly PICTURE_FLOOR_MAX_FRAMES = 12;
  /**
   * Buffered ahead of the playhead, past which a stall is not about supply.
   * Comfortably more than the cushion the floor exists to rebuild, so a link
   * that is genuinely struggling never reads as fine.
   */
  private static readonly SUPPLY_FINE_AHEAD_S = 5.0;
  /** Set at stall entry: the bytes were already there, so only decode is short. */
  private _bufferingSupplyIsFine = false;
  /**
   * The picture running behind the sound, and staying there.
   *
   * Frame selection normally makes this self-healing: the presentation loop
   * takes the LATEST due frame, so a hitch is absorbed the moment fresh frames
   * arrive. What it cannot absorb is a decoder that lost ground and only ever
   * decodes forward at ~1x — after a GC pause or a few starved seconds on a
   * small-memory device, every frame that arrives is already late by the same
   * amount, each one is dutifully presented, and the offset becomes permanent.
   *
   * Nothing else catches it. The frozen-picture watchdog reads advancing
   * frames as healthy, and the desync check further down only looks the other
   * way (audio behind video), so the only fix was the viewer seeking by hand.
   */
  /** Set per seek() call: true while a seek nobody asked for is in flight. */
  private _seekIsInternal = false;
  /** The seek target the audio-crossed-it line was last said for. */
  private _audioTargetLoggedFor = -1;
  private _videoLagSince: number = 0;
  private _videoLagHealthySince: number = 0;
  private _lastVideoLagResyncAt: number = 0;
  private _videoLagResyncs: number = 0;
  /** Lip-sync is long gone by here, and it matches the audio-side threshold. */
  private static readonly VIDEO_LAG_S = 0.5;
  /** Long enough that an ordinary hitch heals itself first. */
  private static readonly VIDEO_LAG_SUSTAIN_MS = 2000;
  /** How long the video-only ending waits for the renderer's queue to run out
   *  once the clock has armed it. Only ever runs at the very end of a file. */
  private static readonly EOF_PICTURE_DRAIN_MS = 2000;
  /** How long the decoder must have emitted nothing before an empty renderer
   *  queue is taken to mean the picture is finished rather than between
   *  callbacks. Several frame intervals at any rate we play. */
  private static readonly EOF_PICTURE_SETTLE_MS = 150;
  /**
   * A speed-UP asked for but not applied yet, while the pipeline fills for it.
   *
   * Only ever set on the one path that stalls today. A rate change re-anchors
   * the audio, and when a healthy anchor survives that, setPlaybackRate skips
   * the corrective seek entirely and the change is already smooth — that case
   * is left exactly as it was. When the anchor is NOT healthy the seek runs:
   * decoders flushed, frame queue cleared, a keyframe waited for. That is the
   * "playback stops dead, lags, then runs fine at 2x" on a device that plays
   * 1080p perfectly well at 1x — it simply has no cushion to spare, and
   * doubling the rate halves what it has in wall-clock terms.
   *
   * So on that path, keep playing at the CURRENT rate for a moment and let the
   * loop fill against the new rate's targets instead. When the anchor comes
   * good the change applies and the seek is skipped; if it never does, it
   * applies anyway at the cap and nothing is worse than before.
   */
  private _pendingRate = 0;
  private _pendingRateSince = 0;
  /** True while the deferred rate is being handed back to setPlaybackRate, so
   *  it applies instead of deferring itself all over again. */
  private _applyingPendingRate = false;
  /** Longest the pipeline may prepare before the rate is applied regardless. */
  private static readonly RATE_PREPARE_MAX_MS = 1500;
  /** One-shot: the decoder is asked for its reorder tail once per EOF. */
  private _eofFlushRequested = false;
  /** Which EOF flush has finished emitting — see maybeStartLoopPreroll. A
   *  counter, not a flag, so a flush from before a seek cannot vouch for one
   *  asked for after it. */
  private _eofFlushSeq = 0;
  private _eofFlushSettledSeq = -1;
  /** When the video-only ending was armed (timeDone first true), so the drain
   *  wait above is measured from then and not from a much earlier EOF. */
  private _eofPictureDrainSince = 0;
  /**
   * How long after a speed change the picture may trail the sound without us
   * reaching for a seek. Longer than the seek window above because a rate
   * change can BE a seek plus an audio re-anchor, and the pipeline it re-primes
   * is the whole of it. The sustain timer only starts once this is past, so the
   * earliest a catch-up can fire after a speed change is this plus
   * VIDEO_LAG_SUSTAIN_MS.
   */
  private static readonly RATE_CHANGE_SETTLE_MS = 4000;
  /** Below this share of the source rate the picture is not merely late, it is
   *  being outrun — and a catch-up cannot win that. Deliberately looser than
   *  the renderer's own severe ratio: this only declines to make things worse,
   *  where that one commits the whole pipeline to a downshift. */
  private static readonly LAG_KEEPING_UP_RATIO = 0.6;
  private static readonly VIDEO_LAG_COOLDOWN_MS = 6000;
  /**
   * A catch-up that keeps being needed isn't catching up. Past this the device
   * is simply behind, and more re-seeks would only cost it the read-ahead they
   * throw away — the FPS/DPR degrades and the ABR downshift own that case. The
   * budget comes back after a stretch of being genuinely in step.
   */
  private static readonly MAX_VIDEO_LAG_RESYNCS = 3;
  /**
   * Presented-frame history, for pictureKeepingUp().
   *
   * The renderer's own decode-bound verdict is the right gate on the catch-up
   * and it is already wired below — but it needs four uninterrupted seconds of
   * presentation to reach, and `framesPresented` restarts at every seek. The
   * catch-up IS a seek, so each attempt wiped the evidence for the guard that
   * would have stopped the next one. Read off an 8K60 AV1 session in Firefox:
   * catch-ups at 6.3s, 12.3s and 18.4s, and the verdict only at 31.5s — once
   * the attempt limit had stopped the resets. Those 25 seconds are the stutter.
   *
   * So the player keeps its own reading, which nothing resets but time.
   */
  private _lagFpsBase = -1;
  private _lagFpsAt = 0;
  private _lagFpsAchieved = -1;
  private _lagSlowLogged = false;
  /**
   * Samples in the current reading's window, and how many of them found the
   * picture with nothing to work on: no frame waiting to be shown, nothing in
   * the decoder, nothing in the read-ahead stash. Frames not presented then
   * were never delivered, so they say nothing about the device. A slow
   * decoder still reads as one: its frame queue runs dry with packets still
   * waiting in the decoder.
   */
  private _lagWindowSamples = 0;
  private _lagWindowStarved = 0;
  /**
   * When the reading last looked. It only looks while playing, so a long gap
   * means playback stopped in between — a stall — and a window stretched over
   * one divides a second of frames by the seconds spent waiting for bytes.
   *
   * From an 8K60 AV1 file streamed from Google Drive: the link could not
   * carry its 41 Mbps, every window spanned a stall and read ~13fps, and this
   * reading called the DEVICE the bottleneck — the one verdict that keeps the
   * link notice silent (deviceIsBottleneck). Pausing to buffer played it
   * smoothly, which a slow decoder would not have. Reproduced with 4K25 AV1
   * over a throttled link: windows over stalls read 2, 5, 9fps on a decoder
   * doing 25, and deviceIsBottleneck was true for 17s of 70; with such
   * windows dropped, 2s of 90. So they are dropped, not recorded.
   */
  private _lagLastSampleAt = 0;
  private static readonly LAG_SAMPLE_GAP_MS = 400;
  /** Above this share of starved samples, a window's frame rate is not a
   *  reading of the device at all, and is discarded rather than recorded. */
  private static readonly LAG_STARVED_RATIO = 0.25;
  /**
   * How long a bound stall may hold before it gives up and resumes on whatever
   * it has.
   *
   * Generous on purpose. Under a binding the picture is frozen for the whole
   * wait either way — resuming early does not un-freeze it, it only lets the
   * sound walk off without it. So the only thing this protects against is a
   * video pipeline that is not slow but DEAD, and for that the decoder's own
   * error paths are the real answer; this is the backstop behind them.
   */
  private static readonly BOUND_RESUME_ESCAPE_MS = 15000;
  /**
   * How much video, in seconds of queued frames, a bound stall wants back
   * before it lets go. One frame is not a picture that is running again — it is
   * a picture that will freeze one frame later, with the sound released for the
   * whole grace that follows.
   */
  private static readonly BOUND_RESUME_CUSHION_S = 0.2;
  // Lossless/complex codecs whose WASM decode is genuinely sub-realtime from
  // cold. See activeAudioIsHeavySoftware().
  private static readonly HEAVY_SOFTWARE_AUDIO = /truehd|mlp|dts|dca/;
  // Hard cap on the post-seek wait for the frame queue. The wait is only ever
  // worth having while it is shorter than the hitching it replaces, so it is
  // deliberately far below every other escape in this file — and matched to
  // MoviElement.SEEK_SPINNER_GRACE_MS, which is how long a seek (and the
  // buffering that follows it, counted as one run) is given before it earns a
  // spinner. Inside that window this wait is invisible; past it, it would be
  // trading a stutter for a flash of spinner, which is not a trade.
  private static readonly SEEK_RESUME_QUEUE_ESCAPE_MS = 400;
  /** The stall-detection grace given to a resume that came out of a stall
   *  rather than out of a cold start. Long enough for the queue we just waited
   *  for to start playing, short enough that the sound cannot walk. */
  private static readonly BOUND_RESUME_GRACE_MS = 500;
  /** How long the decoder may sit waiting for a keyframe, picture frozen, with
   *  the stall detector suppressed, before a binding calls it a stall. Ends the
   *  wait that never ends when the packets stop arriving. */
  private static readonly BOUND_KEYFRAME_HOLD_MS = 1500;
  /** How long a superseded seek waits for whoever took its session to resolve
   *  the "seeking" state before doing it itself. */
  private static readonly ORPHANED_SEEK_BACKSTOP_MS = 750;
  /** How long the picture gets to rejoin the sound in a video-only catch-up
   *  before a binding stops the sound and waits for it. Long enough that the
   *  ordinary case — a few hundred ms of already-buffered decode — passes
   *  unnoticed; short enough that a catch-up going nowhere cannot run away. */
  private static readonly RESYNC_HOLD_MS = 1200;
  private _playStartTime: number = 0; // When play() was called — grace period for stall detection

  /**
   * A seek settled while paused, so the demuxer cursor is past the picture.
   *
   * A seek's processLoop bursts packets while it hunts for the frame the
   * target lands on, and a seek that ends paused stops there: the one frame is
   * painted, the decoded read-ahead behind it is dropped (see the paused branch
   * of notifySeekCompletion), and the cursor is left wherever the hunt reached
   * — measured 2.5s past the target on a 1080p source. Nothing rewinds it,
   * because resuming from a pause is otherwise just a matter of restarting the
   * clock. So playback picked up from the cursor: the viewer scrubbed to 260s,
   * saw 260s on the card and on the picture, pressed play, and the film jumped
   * to 262.5s.
   *
   * play() answers this with the realignment the first-play path already does
   * for the identical reason (the poster seek reads ahead the same way). This
   * flag is what tells the two apart from an ordinary pause → play, which must
   * stay instant and must NOT re-seek.
   */
  private _demuxerAheadOfClock: boolean = false;

  /**
   * Can the picture simply carry on from where the clock is, with what has
   * already been decoded?
   *
   * The flag above says the demuxer's cursor is past the clock. That is true
   * the moment ANY seek settles paused — including the one a click on the seek
   * bar issues, because the bar pauses for the drag. But a click is followed by
   * play() within a few tens of milliseconds, while the frames that seek just
   * decoded are still queued: playback runs straight out of them and the cursor
   * being ahead never costs anything. Rewinding there is pure harm — it throws
   * away those frames, leaves the PREVIOUS position's picture on screen while
   * it re-seeks and re-decodes, and restarts the audio a second time. Measured:
   * a click seeking to 162.45s showed the old frame at 286.28s for ~240ms
   * before snapping, against a clean -0.04s landing without the rewind.
   *
   * What made the paused-scrub-then-play case different is that by the time
   * play arrived those frames were gone — the queue measured empty — so
   * decoding resumed from the cursor and skipped everything between. So the
   * question is not whether the cursor is ahead; it is whether the frames that
   * cover the gap still exist. This asks that directly.
   */
  private pictureCanResumeFromClock(): boolean {
    const queued = this.videoRenderer?.queuedPtsRange;
    if (!queued) return false; // nothing decoded is waiting — the gap is real
    // The queue has to START at or before where playback is about to begin,
    // give or take a couple of frames. A queue that begins well after the
    // clock IS the hole this guards against.
    return queued.first <= this.clock.getTime() + 0.25;
  }
  /** performance.now() of the last buffering→playing resume (0 = never). */
  private _stallResumeAt: number = 0;
  private _primingAudio = false; // true while the first-play buffer is filling its startup cushion
  private _decoderStuckSince: number = 0; // When video decoder was first detected stuck
  private _lastDesyncSeekTime: number = 0; // performance.now() of last desync-triggered resync

  // Playback Loop
  private animationFrameId: number | null = null;
  private backgroundIntervalId: number | null = null;
  private backgroundWorker: Worker | null = null; // Worker-based timer for Safari
  /**
   * True when the tab is hidden.
   *
   * Seeded from the document rather than starting false, because a player is
   * not always born in a visible tab: an auto-advance while the viewer is away
   * destroys one player and builds the next one, and that new instance never
   * saw the visibilitychange that put the old one in the background. It came up
   * believing it was on screen, waited for a video frame that nothing was
   * decoding, and sat in buffering — silent — until the viewer came back. Every
   * background-aware branch in this file depends on this flag being right from
   * the first tick.
   */
  private isBackgrounded: boolean =
    typeof document !== "undefined" && document.visibilityState === "hidden";
  /**
   * The page has said hidden does not mean unwatched — see MoviElement's
   * `backgroundplay`. Two things follow from it: an autoplay may START while
   * hidden (handled in the element), and hiding the tab does not pause on a
   * phone (below).
   */
  private _backgroundPlay: boolean = false;
  // performance.now() of the last background→foreground recovery. For a short
  // window after, the audio-underrun stall detector is suppressed: returning
  // from background the decode loop was throttled, so a transient underrun is
  // expected and refills on its own. Without this the detector would suspend
  // audio the instant the user returns — stopping e.g. background music that
  // was playing fine — which it never did before the underrun-stall was added.
  private _foregroundRecoveryAt: number = 0;

  // WakeLock to prevent screen sleep during playback
  private wakeLock: WakeLockSentinel | null = null;

  // Seek state - track if we need to skip to keyframe after seek
  private seekingToKeyframe: boolean = false;
  private seekingToKeyframeStartTime: number = 0;
  private static readonly KEYFRAME_SEEK_TIMEOUT = 5000; // 5 seconds timeout
  /**
   * Video packets that must have been scanned before the wall-clock timeout is
   * allowed to give up and accept a non-keyframe. The timeout exists for long-GOP
   * content where a keyframe is genuinely far away — a condition measured in
   * PACKETS, not seconds. On a slow link only a handful of packets arrive in 5s,
   * so the pure wall-clock check fired while the demuxer was merely starved,
   * handing the decoder a non-keyframe and painting black video. Below this
   * count the seek is waiting on bytes, not on a keyframe, so keep waiting.
   */
  private static readonly SEEK_KEYFRAME_MIN_SCAN = 120;
  /** Absolute ceiling so a permanently starved seek can still bail out. */
  private static readonly KEYFRAME_SEEK_HARD_TIMEOUT = 20000;
  private seekKeyframeScanned: number = 0;
  // After a seek we prefer a true IDR to restart cleanly (avoids the open-GOP
  // CRA-as-key HW rejection on mixed-keyframe HEVC). But some streams only have
  // CRA keyframes for long stretches (e.g. seeking deep into a DoVi P8 .ts whose
  // sole IDR is at the file start), so if no IDR shows up within this short
  // window we fall back to resuming on a CRA rather than staying black.
  private seekCraSeen: number = 0;
  private static readonly SEEK_IDR_WAIT_MS = 400; // wait this long for an IDR before accepting a CRA

  // Set when an audio-starve video skip drops a non-keyframe, breaking AV1's
  // reference chain. While true the demux loop keeps dropping deltas until the
  // next keyframe (even after the starve clears) so no orphaned delta ever
  // reaches the decoder — that orphan is what throws EncodingError. Cleared on
  // the next keyframe, which rebuilds the chain. See the demux loop.
  private videoChainBrokenUntilKeyframe: boolean = false;

  // Set when the chain-break above is released by an open-GOP CRA rather than a
  // true IDR. A CRA reaches the decoder as `delta` (WebCodecs rejects a CRA sent
  // as `key`), so it is only a clean restart for the pictures that TRAIL it: the
  // RASL leading pictures that follow still reference the pre-CRA GOP the starve
  // just dropped, and feeding those orphans throws the very EncodingError the
  // chain-break latch exists to prevent. While true the demux loop keeps
  // dropping RASL packets until the first trailing picture. Nothing outside the
  // CRA's own leading set references a RASL, so dropping them costs nothing.
  private videoSkipRaslAfterChainCra: boolean = false;

  // Prebuffer targets — accumulate this much before reporting "ready" so
  // play() doesn't immediately stall on short videos where the demux burst
  // outruns the HTTP stream.
  private static readonly PREBUFFER_AUDIO_SECONDS = 0.5;
  private static readonly PREBUFFER_VIDEO_FRAMES = 2;
  // How many further packets to read looking for the video frames once audio is
  // already satisfied. Bounded because the stash is drained before playback
  // reads anything new — see the note in the prebuffer loop.
  private static readonly PREBUFFER_VIDEO_SEARCH_PACKETS = 120;
  private static readonly PREBUFFER_MAX_WALL_MS = 5000;
  private static readonly PREBUFFER_MAX_PACKETS = 400;

  // Seek target time - skip packets before this time to ensure accurate seeking
  // When seeking, FFmpeg seeks to the nearest keyframe BEFORE the target time
  // We need to decode but not display/play packets before the target time
  private seekTargetTime: number = -1;
  /**
   * A video-only resume point, for when the picture has to catch up to sound
   * that never stopped (see resyncVideoToAudio).
   *
   * seekTargetTime serves both streams, and there it has to sit at the END of
   * the audio the renderer has already scheduled, or the re-demuxed packets
   * behind it get decoded a second time and the sound fast-forwards. That end
   * is seconds ahead of what anyone is hearing — measured at six — and holding
   * the PICTURE to it meant the frame the viewer asked for waited for a moment
   * that had not been reached yet. Video has no such history to protect: it
   * resumes where the sound actually IS.
   *
   * -1 means no video-only resume is in flight and the shared target applies.
   * Otherwise this owns the video gate for the rest of the catch-up, dropping
   * to -Infinity once the first frame lands — the frames AFTER that one are
   * still behind the audio schedule's end, and handing the gate back to the
   * shared target would drop every one of them until the sound caught up to a
   * point it had only buffered, not played.
   */
  /**
   * The position a completed seek still owes the screen a picture for, or -1.
   *
   * A seek that finishes WITHOUT a frame — the forced completion, when the
   * demuxer ran out or the deadline fired before the walk reached the target —
   * leaves the player paused (or ended) with nothing new on the canvas. The
   * frames it was waiting for usually arrive a moment later, out of a decoder
   * that was still working, and the state gate below drops every one of them
   * because by then the state is "paused" and waitingForVideoSync is false.
   * Nothing else ever puts them up: the presentation loop is stopped while
   * paused, so the picture that was asked for is simply lost.
   *
   * Reported on a 1.33s single-GOP transport-stream segment (seg.ts, 40 frames,
   * one keyframe at 0). Every paused seek there decoded all 40 frames and
   * presented none: the file is short enough that EOF arrives before the
   * decoder has emitted the frames past the target, so the forced completion
   * always won the race. Playing the same file works, because "playing" holds
   * the gate open.
   */
  private _pictureOwedFrom: number = -1;
  private _videoResumeTarget: number = -1;
  /** When the catch-up above began, so the UI can tell a hitch nobody notices
   *  from a wait worth putting a spinner on. */
  private _videoCatchUpStartedAt = 0;

  // Buffer audio packets while waiting for video to catch up after seek
  private waitingForVideoSync: boolean = false;
  private pendingAudioPackets: Array<{
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
  }> = [];

  // Packets read during prebuffer — stashed unmodified so that normal
  // playback consumes them before resuming demux. We cannot decode during
  // prebuffer because (a) video frames would be dropped by the "playing"
  // state gate in setOnFrame and (b) the audio renderer eagerly schedules
  // buffers on AudioContext which would start audio playback early.
  private pendingPrebufferPackets: Packet[] = [];

  // Video packets read ahead of the renderer's frame cap so that the AUDIO
  // buried between them can be decoded. Held compressed and fed to the decoder
  // in order as soon as the frame queue has room — deferred, never discarded,
  // so the reference chain stays whole. See the read-ahead note in processLoop.
  private _videoAheadStash: Packet[] = [];
  private _videoAheadStashBytes: number = 0;
  private _videoAheadActive: boolean = false;
  // The seek session whose stash has already been thrown away. Emptying the
  // stash breaks the reference chain, so it must happen ONCE per seek and not
  // once per packet — see the wait-for-sync branch of trimOvertakenReadAhead.
  private _readAheadDroppedForSeek: number = -1;
  // Edge latch for processLoop's point-of-use guard: true while the condition
  // that invalidates the stash (decoder waiting for a keyframe, or a prebuffer
  // stash draining) is still standing, so the drop happens once as it begins
  // rather than on every iteration of the burst underneath it.
  private _readAheadInvalidated: boolean = false;

  /**
   * The ONE way the read-ahead stash is emptied. Every caller goes through here
   * — the flush sites, the seek/poster/teardown resets, and processLoop's
   * point-of-use guard — because emptying it has a consequence that is easy to
   * forget at any single call site, and forgetting it is a decoder error two
   * seconds later with nothing nearby to blame.
   */
  /**
   * Drop stashed video the picture has already gone past, up to the first
   * keyframe that is still ahead of it. Cheap: a scan of a queue that is only
   * ever a few hundred entries, and only while it is non-empty.
   */
  private trimOvertakenReadAhead(): void {
    const stash = this._videoAheadStash;
    if (stash.length === 0) return;
    // A seek that has not yet produced a frame of its own makes BOTH halves of
    // the comparison below lie. The on-screen time still reports the picture
    // that was up before the seek, and anything left in the stash was read for
    // the position being left — so "has the picture passed this packet?" is
    // asked about two different places in the film.
    //
    // Measured on an 8K source: a seek back to 91.29s trimmed the stash "up to
    // IDR 153.000s" against a screen still reading 149.800s. The trim did its
    // job perfectly and kept exactly the wrong packet — that leftover IDR was
    // decoded and presented as the seek's first frame, and the desync corrector
    // then pulled the whole player back to 153s.
    //
    // Nothing in the stash belongs to where playback is going, so drop it
    // rather than trim it. dropVideoReadAhead is the only sanctioned way to
    // empty it (it latches the reference-chain break the drop causes).
    //
    // ONCE, though. This runs on every iteration of the demux burst, and
    // waitingForVideoSync stays true across the whole post-seek fill — so an
    // unconditional drop here re-breaks the reference chain for every packet
    // the burst stashes, and the stash it is emptying is no longer the old
    // position's picture: the seek emptied that itself, and everything landing
    // here now was read AFTER it, for where playback is going.
    //
    // Traced on a 5.76s 1080p50 H.264 High 4:2:2 camera original: on play() the
    // seek dropped 77 stashed packets (correct, once), and then this branch
    // fired twenty more times in 25ms — stash of 1, dropped, chain broken;
    // keyframe, chain cleared; stash of 1, dropped, chain broken — and the
    // sequence happened to END on a break. From there every delta was skipped
    // waiting for a keyframe that the same starvation kept from arriving, so
    // 73 of the file's 288 frames were ever handed to the decoder: the picture
    // ran clean for ~1.2s and then advanced once per GOP (0.48s) for the rest
    // of the file. The decoder was never the problem — it was fed 73 chunks,
    // returned 76 frames and reported no error.
    //
    // Keyed on the seek session, so a genuinely stale stash is still dropped
    // the first time this seek looks at it (dropVideoReadAhead stamps the
    // session, so the seek's own drop counts), and never again for that seek.
    if (this.waitingForVideoSync) {
      if (this._readAheadDroppedForSeek !== this.seekSessionId) {
        this.dropVideoReadAhead();
      }
      return;
    }
    // Everything below rests on one assumption: a packet older than the screen
    // has been SHOWN, so dropping it costs nothing. That is only true when the
    // stash's own reference chain is already BROKEN — the starve-skip case this
    // was written for, where the deltas ahead of the screen are being discarded
    // anyway and the next IDR is the first thing that can be decoded at all.
    //
    // With the chain INTACT the stash is drained into the decoder in order, so
    // its head is the next packet the picture needs, not the last one it
    // showed. A head behind the screen then means one thing only: a re-seek
    // landed on the keyframe BEHIND the target, which is what a seek is
    // supposed to do. Those packets are the route to the screen's own frame,
    // the ones after it are the picture's immediate future, and "the first IDR
    // at or past the screen" is neither — it is the START OF THE NEXT GOP.
    //
    // Read off a 4K AV1 file, twice. Play pressed after a paused seek realigns
    // the demuxer; nothing raises waitingForVideoSync, because the realign
    // re-arms only the pre-target filter, so this ran with a head at the
    // landing keyframe and cut forward to the next GOP: "dropped 311 packet(s)
    // ... up to IDR 46.167s, screen 43.233s", first frame out 46.167 against
    // audio at 43.24. Guarding on the DECODER's waiting-for-keyframe flag did
    // not hold, and the second log says why: flush at 16:39:44.316, trim at
    // 16:39:44.428, and in the 112ms between them the burst had already fed
    // the landing IDR and cleared the flag. The decoder's flag is about the
    // decoder's next input; this is about whether the stash still hangs
    // together. Ask the latch that actually tracks that.
    if (!this.videoChainBrokenUntilKeyframe) return;
    const onScreen = this.videoRenderer?.getCurrentTime?.() ?? -1;
    if (!(onScreen > 0)) return;
    if (stash[0].timestamp >= onScreen) return; // head is still ahead — nothing stale
    // The first keyframe at or past the screen is the only place the run can be
    // cut without orphaning what follows.
    // A TRUE random-access point, not merely `keyframe`. On open-GOP HEVC that
    // flag is also set on CRA pictures, which WebCodecs is handed as `delta`
    // and which reset nothing — cutting to one leaves everything after it
    // orphaned. Measured on 4K60 HEVC Main 10 immediately after this trim:
    // "Decoder waiting for keyframe mid-playback", and the picture stood at
    // 78.862s for 1.2 seconds with an empty queue and an empty stash while the
    // clock ran to 81.4s. That is the one-second hitch a rate change leaves
    // behind, and this made it. The same lesson is already written into
    // movi_read_frame's is_idr and into the starve-skip's chain-break latch:
    // `keyframe` is not a reference reset here, `isIdr` is.
    let cut = -1;
    for (let i = 0; i < stash.length; i++) {
      if (stash[i].timestamp >= onScreen && stash[i].keyframe && stash[i].isIdr) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) return; // nothing to cut, or the keyframe is already the head
    let bytes = 0;
    for (let i = 0; i < cut; i++) bytes += stash[i].data.length;
    this._videoAheadStash = stash.slice(cut);
    this._videoAheadStashBytes = Math.max(0, this._videoAheadStashBytes - bytes);
    Logger.debug(
      TAG,
      `Read-ahead: dropped ${cut} packet(s) the picture had passed (up to IDR ${stash[cut].timestamp.toFixed(3)}s, screen ${onScreen.toFixed(3)}s)`,
    );
  }

  private dropVideoReadAhead(): void {
    // Stamped whether or not there was anything to drop: what the stamp records
    // is "this seek's stash has been dealt with", and an empty stash has been.
    this._readAheadDroppedForSeek = this.seekSessionId;
    if (this._videoAheadStash.length === 0) return;
    this._videoAheadStash = [];
    this._videoAheadStashBytes = 0;
    this._videoAheadActive = false;
    // Those packets were a CONTIGUOUS run of the picture, so dropping them
    // punches a hole in the reference chain exactly like an audio-starve skip
    // does — and the deltas that follow are orphans. Without this latch the
    // decoder was handed 5.856s and then 7.975s with no keyframe between and
    // no flush anywhere in sight, and closed itself on the first orphan: a
    // spurious EncodingError on resume that looked nothing like its cause.
    // Latch the same chain-break the skip path uses; it clears on the next
    // true IDR (or on a CRA once its RASL are dropped, see the field's note).
    this.videoChainBrokenUntilKeyframe = true;
  }

  // Bounds on that stash. 180 packets is ~3s at 60fps; the byte ceiling is what
  // actually matters on a high-bitrate source (74 Mbps 4K60 runs ~150KB/frame,
  // so the packet count alone would allow ~27MB and an 8K source far more).
  // Hitting either bound turns read-ahead off, which drops the loop back to
  // plain backpressure and, if audio still starves, to the GOP-skip last resort.
  private static readonly VIDEO_AHEAD_MAX_PACKETS = 180;
  // Stand read-ahead down this far from the end — comfortably more than the
  // stash's own ~3s depth, so it is always empty by the time EOF arrives.
  private static readonly VIDEO_AHEAD_TAIL_GUARD_S = 6;
  // Hysteresis on when to read ahead at all. `audioBuffered < maxAudioBuffered`
  // is true almost always — audio rarely reaches target on a source whose frame
  // cap is the shallower window — so using it left read-ahead permanently on,
  // and permanently stashing costs main-thread time for demux work that was not
  // needed yet. Measured on 8K60 AV1, where the cap is 16 frames and audio sits
  // at a low but SAFE 0.3-0.8s: always-on read-ahead held ~140 packets and cost
  // 2.6fps (57.3 vs 59.9) to fix a starve that was not happening. So engage
  // only once audio is genuinely near the 0.1s starve line, and stand down once
  // it has recovered — a burst when it is needed rather than a permanent tax.
  private static readonly VIDEO_AHEAD_ENGAGE_AUDIO_S = 0.5;
  private static readonly VIDEO_AHEAD_RELEASE_AUDIO_S = 1.25;
  private static readonly VIDEO_AHEAD_MAX_BYTES = 48 * 1024 * 1024;
  /** How much of the audio target must be in hand before the loop goes back to
   *  handing stashed video to the decoder instead of reading for sound. */
  private static readonly STASH_DRAIN_AUDIO_FRACTION = 0.5;

  // Audio packets collected during the current demux burst, handed to the
  // decoder as ONE batch when the tick ends. Only used when the software path
  // is active (see AudioDecoder.canBatch): TrueHD/MLP emits a 40-sample access
  // unit, so feeding ~1200 packets/s one at a time spends more time crossing
  // into WASM than decoding, leaving the renderer to fill the shortfall with
  // silence ("Gap filled" underruns). Flushed in processLoop's finally so no
  // demuxed packet is ever dropped on an early exit.
  private _audioBatchPending: {
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
  }[] = [];

  // Post-seek throttling to prevent stuttering on low-end devices
  private justSeeked: boolean = false;
  private seekTime: number = 0;
  private startTime: number = 0; // Media start time (PTS offset)
  // Per-seek "keyframe jump" offset. FFmpeg lands on the nearest keyframe
  // at-or-after the seek target, which on long-GOP containers (.ts mainly)
  // can be seconds beyond what the user asked for. Reporting the raw time
  // then makes the timeline jump from 0:00 → 0:02 right after a seek to 0.
  // Track the gap and subtract it from getCurrentTime() so the UI stays
  // pinned to what the user requested. Reset on every new seek.
  private seekKeyframeOffset: number = 0;
  private static readonly POST_SEEK_THROTTLE_MS = 1000; // Throttle aggressive buffering for 1000ms after seek to stabilize playback

  // Pause-time buffering: continue demuxing while paused so seek within buffered
  // area is instant and playback resumes without stall (like YouTube).
  // YouTube buffers ~2-5 minutes ahead while paused, then stops.
  private pauseBufferTimerId: number | null = null;
  private static readonly PAUSE_BUFFER_INTERVAL_MS = 100; // Demux every 100ms while paused
  private static readonly PAUSE_BUFFER_MAX_PACKETS = 3000; // Safety cap on packet count
  private static readonly PAUSE_BUFFER_AUDIO_SECONDS = 180; // ~3 minutes audio ahead (YouTube-like)
  private static readonly PAUSE_BUFFER_VIDEO_FRAMES = 5400; // ~3 minutes @ 30fps

  constructor(config: PlayerConfig) {
    super();

    this.config = config;
    this._audioOnly = !!config.audioOnly;
    this.cache = new LRUCache(config.cache?.maxSizeMB ?? 100);
    this.trackManager = new TrackManager();
    this.clock = new Clock();
    this.stateManager = new PlayerStateManager();

    // Disable FFmpeg logs by default
    updateAllBindingsLogLevel(LogLevel.SILENT);

    // Initialize components
    this.audioDecoder = new MoviAudioDecoder();
    this.audioRenderer = new AudioRenderer();
    this.subtitleDecoder = new SubtitleDecoder();

    // Initialize video renderer with canvas (WebCodecs)
    // Note: MSE mode is handled by MSEPlayerWrapper
    // Check if software decoding is forced via config
    const forceSoftware = config.decoder === "software";

    if (config.canvas || config.renderer === "canvas") {
      if (config.canvas) {
        // Use canvas with WebCodecs (or WASM software if forced)
        this.videoDecoder = new MoviVideoDecoder(forceSoftware);
        this.videoRenderer = new CanvasRenderer(config.canvas);
        // A source that OPENS in data-saver (the adaptive path reloads into
        // exactly that) has a configured video track and no picture. Say so
        // now, or the renderer spends the track believing one is coming.
        this.videoRenderer.setPictureSuspended(this._audioOnly);

        // Connect video renderer to audio clock for A/V sync (skip if audio disabled)
        if (!this.disableAudio) {
          this.videoRenderer.setAudioTimeProvider(
            () => this.audioRenderer.getAudioClock(),
            () => this.audioRenderer.hasHealthyBuffer(),
            // Measured once there is a buffer, predicted before there is —
            // see AudioRenderer.startLead().
            //
            // The renderer places its post-seek anchor at the one moment the
            // measurement cannot work: the flush has cleared the scheduled
            // buffers, so it answers zero, no lead is applied, and the picture
            // starts immediately. On a high-latency output the sound then
            // arrives a few hundred ms later, the first A/V sync finds the
            // video that far ahead and re-anchors it backwards, and the
            // picture stops until the wall clock catches up — the hitch a beat
            // after every seek on Bluetooth.
            //
            // …and there has to BE sound. With no audio track the lead is
            // still predicted — no first buffer has ever been scheduled, so
            // the honest answer to "how long until it is audible" is the
            // cold-start guess, min(0.5, latency) + latency. Measured at
            // 560ms, and the picture held for every one of them at each loop
            // turn of a video-only file: anchored 560ms into the future,
            // getVideoTime clamps the negative elapsed to zero, so media time
            // sat at 0.033s with 63 decoded frames queued behind it. The
            // picture then ran that far behind the clock for the whole pass.
            () => (this.hasAudioThatCanPlay() ? this.audioRenderer.startLead() : 0),
          );
        } else {
          // When audio is disabled, video runs independently without A/V sync overhead
          this.videoRenderer.setAudioTimeProvider(null, null, null);
          Logger.info(
            TAG,
            "Video renderer running independently (audio disabled)",
          );
        }

        // When the renderer decides the device can't hold the source frame
        // rate and caps presentation, shed load two ways:
        //   1) Software decode: skip non-reference frames to cut CPU (no-op on
        //      hardware — the present-side cap is the only lever there).
        //   2) Under Auto quality: drop a resolution rung. This is the real
        //      relief for a device that simply can't decode the current
        //      resolution (network fine, buffer full, frames dropping) — the
        //      plain ABR is network-only and never reacts to a decode bottleneck.
        this.videoRenderer.setOnPerformanceDegrade(() => {
          this.videoDecoder?.setPerformanceSkip(true);
          this.abrDeviceDownshift();
        });
        // Don't let the perf/decode-bound detector run while backgrounded — a
        // throttled rAF stalls framesPresented and would false-fire a downshift
        // (and, worse, a session resolution cap) on a capable device. PiP still
        // measures: there the video is actually visible and rendering.
        this.videoRenderer.setShouldMeasurePerf(
          () => !(this.isBackgrounded && !this.isPiPActive),
        );
        // Lets the perf detectors tell a slow decoder from a starved one — see
        // setVideoBacklogProvider. Read live rather than cached: the queue
        // drains and refills between windows.
        this.videoRenderer.setVideoBacklogProvider(
          () => this.videoDecoder?.queueSize ?? 0,
        );

        Logger.info(
          TAG,
          `Video renderer initialized with canvas (forceSoftware: ${forceSoftware})`,
        );
      } else {
        Logger.warn(
          TAG,
          "Canvas renderer requested but no canvas element provided",
        );
        this.videoDecoder = new MoviVideoDecoder(forceSoftware);
      }
    } else {
      // Default to software decoding with WebCodecs (no target element)
      this.videoDecoder = new MoviVideoDecoder(forceSoftware);
      Logger.info(
        TAG,
        "Video renderer initialized with default (WebCodecs decoder only)",
      );
    }

    // Connect audio as the master clock provider (skip if audio disabled)
    if (!this.disableAudio) {
      this.clock.setAudioProvider(this.audioRenderer);
    } else {
      // When audio is disabled, clock runs independently without audio sync overhead
      this.clock.setAudioProvider(null);
      Logger.info(TAG, "Clock running independently (audio disabled)");
    }

    // Setup decoder outputs
    if (this.videoDecoder) {
      this.wireVideoDecoder(this.videoDecoder);
    }

    this.audioDecoder.setOnData((data) => this.renderDecodedAudio(data));

    this.audioDecoder.setOnPCM((frame) => {
      // Software path (FFmpeg/WASM) emits planar Float32 PCM so we avoid
      // the WebCodecs AudioData constructor — which Firefox on Android
      // doesn't implement.
      this.audioRenderer.renderPCM(frame);
    });

    this.audioDecoder.setOnError((error) => {
      Logger.error(TAG, "Audio decoder error", error);
      // Audio errors are less fatal - video can continue, just emit the error
      this.emit("error", error);
    });
    this.audioDecoder.setOnBroken(() => void this.recoverBrokenAudio());

    // Forward state changes
    this.stateManager.on("change", (state) => {
      this.emit("stateChange", state);
    });

    // Forward track changes
    // Listen for audio track changes and immediately reconfigure decoder
    this.trackManager.on("audioTrackChange", async (track) => {
      if (!track) {
        Logger.warn(TAG, "Audio track change event received but track is null");
        return;
      }

      Logger.info(
        TAG,
        `Audio track changed to track ${track.id}, reconfiguring decoder`,
      );

      // Close current audio decoder immediately
      if (this.audioDecoder) {
        this.audioDecoder.close();
      }

      // Recreate audio decoder for new track
      this.audioDecoder = new MoviAudioDecoder();

      // Set bindings
      if (this.demuxer) {
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          this.audioDecoder.setBindings(bindings);
        }
      }

      this.audioDecoder.setOnData((data) => this.renderDecodedAudio(data));

      this.audioDecoder.setOnPCM((frame) => {
        this.audioRenderer.renderPCM(frame);
      });

      this.audioDecoder.setOnError((error) => {
        Logger.error(TAG, "Audio decoder error", error);
        // Audio errors are less fatal - video can continue, just emit the error
        this.emit("error", error);
      });
      this.audioDecoder.setOnBroken(() => void this.recoverBrokenAudio());

      // Configure decoder for new track
      if (this.demuxer && !this.disableAudio) {
        const extradata = this.demuxer.getExtradata(track.id) ?? undefined;
        const configured = await this.audioDecoder.configure(track, extradata);
        if (configured) {
          Logger.info(
            TAG,
            `Audio decoder reconfigured for track ${track.id}: ${track.codec} ${track.sampleRate}Hz ${track.channels}ch`,
          );
          // Re-evaluate the multichannel passthrough policy on every
          // track change — switching from 7.1 TrueHD to stereo AAC
          // (or vice versa) needs the destination channelCount and
          // the WASM downmix flag to follow the new track. The
          // AudioRenderer was already initialised before the first
          // track configure landed, so reading max channels here is
          // cheap and sync.
          const sourceCh = track.channels ?? 2;
          const maxCh = this.audioRenderer.getMaxChannelCount();
          if (sourceCh > 2 && maxCh >= sourceCh) {
            this.audioDecoder.setDownmix(false);
            this.audioRenderer.setOutputChannelCount(sourceCh);
          } else {
            this.audioDecoder.setDownmix(true);
            this.audioRenderer.setOutputChannelCount(2);
          }
        } else {
          Logger.warn(
            TAG,
            `Failed to reconfigure audio decoder for track ${track.id}`,
          );
        }
      }

      // Re-apply demuxer discard: re-enable the newly-selected audio track and
      // discard the previously-active one (issue #11).
      this.applyStreamDiscard();
    });

    this.trackManager.on("tracksChange", (tracks) => {
      this.emit("tracksChange", tracks);
    });

    Logger.info(TAG, "Player created");

    // Handle visibility changes to re-acquire WakeLock if lost
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    // Handle network recovery: re-seek to current position to restart cleanly
    window.addEventListener("online", this.handleNetworkOnline);
  }

  /**
   * Load the media file
   */
  async load(sourceConfig?: SourceConfig): Promise<void> {
    if (!this.stateManager.is("idle") && !sourceConfig) {
      throw new Error("Player must be idle to load");
    }

    // …and its own previews: the frames remembered for the last one are not
    // this one's picture at those times.
    this.clearPreviewCache();

    this._lagFpsBase = -1;
    this._lagFpsAt = 0;
    this._lagFpsAchieved = -1;
    this._lagSlowLogged = false;
    this._lagWindowSamples = 0;
    this._lagWindowStarved = 0;
    this._lagLastSampleAt = 0;
    // A new source gets its own attempts at catching the picture up; what the
    // last one spent says nothing about this one (see _videoLagSince).
    this._videoLagSince = 0;
    this._videoLagHealthySince = 0;
    this._lastVideoLagResyncAt = 0;
    this._videoLagResyncs = 0;

    // A verdict about the previous source's encryption says nothing about this
    // one; the fallback sets it again if this source earns it.
    this._sourceIsEncrypted = false;
    this._encryptedGaveUp = false;
    this._encryptedAudioSilenced = false;

    if (sourceConfig) {
      this.config.source = sourceConfig;
      // New source on a reused instance: re-arm the startup grace so its first
      // buffer fill gets the same protection a fresh instance would get.
      this._playbackStartedAt = performance.now();
      // If we were not idle, we should essentially reset/destroy previous state if reusing instance
      // But for now, let's assume usage pattern respects idle check or we force reset
      if (this.stateManager.getState() !== "idle") {
        // Reset internal state if reloading on same instance
        // Ideally calls destroy() -> new MoviPlayer() is better, but here we can try to soft-reset
      }
    }

    this.stateManager.setState("loading");
    this.emit("loadStart", undefined);
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = 0;
    this._loopCount = 0;

    // Drop the previous source's cover art so a soft-reload on the same
    // instance (no destroy) doesn't keep showing stale artwork when the
    // new source has none.
    this.coverArt?.close?.();
    this.coverArt = null;

    // Clean up any existing preview pipeline
    this.destroyPreviewPipeline();

    // The new source gets its own shot at a missing duration.
    if (this._durationRescanTimer) {
      clearTimeout(this._durationRescanTimer);
      this._durationRescanTimer = null;
    }
    this._durationRescanDone = false;

    // Adaptive streaming — only when the caller used SourceConfig (a custom
    // SourceAdapter bypasses URL detection entirely). HLS (.m3u8) and DASH
    // (.mpd) both go through Shaka Player (one engine, MSE under the hood). This
    // covers multiplexed DASH too — Shaka plays it natively, so there's no
    // FFmpeg fallback to fork on here.
    const src = this.config.source;
    const streamUrl =
      // A registered custom scheme (s3://…) is read via its SourceAdapter, which
      // the HLS/DASH (MSE) engines can't use — they fetch the URL directly. Keep
      // such URLs off the stream path so they reach the demuxer + adapter below.
      !this.config.sourceAdapter &&
      src &&
      src.type === "url" &&
      src.url &&
      !getSourceAdapterFactory(src.url)
        ? src.url
        : null;
    const lowerUrl = streamUrl?.toLowerCase() ?? "";
    // HLS (.m3u8), DASH (.mpd), and Smooth Streaming (.ism/.isml) all go
    // through Shaka. `.ism` also matches `.isml/manifest`.
    // `forceStream` is the same question answered by the server rather than by
    // the URL — a manifest whose path says nothing (see the option's note).
    const forced = this.config.forceStream;
    const isStream =
      !!streamUrl &&
      (lowerUrl.includes(".m3u8") ||
        lowerUrl.includes(".mpd") ||
        lowerUrl.includes(".ism") ||
        !!forced);

    if (isStream) {
      const isHls = lowerUrl.includes(".m3u8") || forced === "hls";
      const isDash = lowerUrl.includes(".mpd") || forced === "dash";
      const kind = isHls
        ? "HLS"
        : lowerUrl.includes(".ism")
          ? "Smooth Streaming"
          : "DASH";

      // Forward track selections from the main TrackManager to whichever stream
      // wrapper is currently active (added once; resolves the live field).
      this.trackManager.on("videoTrackChange", (track) => {
        this.streamWrapper?.selectVideoTrack(track ? track.id : -1);
      });
      this.trackManager.on("audioTrackChange", (track) => {
        if (track) this.streamWrapper?.selectAudioTrack(track.id);
      });
      this.trackManager.on("subtitleTrackChange", (track) => {
        this.streamWrapper?.selectSubtitleTrack(track ? track.id : null);
      });

      // Force-demux: a prior MSE attempt failed at RUNTIME on a codec the
      // browser can't decode (e.g. Safari rejecting a HE-AAC track → Shaka
      // error 3014). Skip the MSE stream engines entirely and play the
      // single-file DASH Representation through the FFmpeg-WASM demuxer, which
      // decodes every codec. Only single-file DASH (BaseURL + optional
      // SegmentBase) works — analyzeDashFallback returns null for multi-segment,
      // in which case we fall back to the normal stream path below.
      if (this.config.forceStreamDemux && isDash) {
        try {
          const plan = await analyzeDashFallback(streamUrl!, src?.headers, this.lifetimeSignal);
          if (plan) {
            this._sourceIsEncrypted = !!plan.encrypted;
            // Nothing here can recover, so don't spend fifty failed packets
            // discovering it — see AudioDecoder.setFailFast.
            if (plan.encrypted) this.audioDecoder.setFailFast(true);
            Logger.info(
              TAG,
              "forceStreamDemux: MSE failed at runtime — routing this DASH source through the FFmpeg demuxer",
            );
            // Remember the renditions for the demuxer-mode quality menu, and
            // honor a user-picked one (forceVideoRendition) over the best.
            this._dashRenditions = plan.videoTracks ?? [];
            const videoUrl =
              (this.config.forceVideoRendition &&
                this._dashRenditions.some(
                  (r) => r.url === this.config.forceVideoRendition,
                ) &&
                this.config.forceVideoRendition) ||
              plan.videoUrl;
            this._activeDashRendition = videoUrl;
            this.source = await this.createSource({
              type: "url",
              url: videoUrl,
              headers: src?.headers,
            });
            // Prefer the full audio menu (languages / bitrate variants) when the
            // manifest has more than one; else the single best audio file.
            if (plan.audioTracks?.length) {
              this.config.audioTracks = plan.audioTracks.map((t) => ({
                url: t.url,
                lang: t.lang,
                label: t.label,
              }));
            } else if (plan.audioUrl) {
              this.config.audioSource = {
                type: "url",
                url: plan.audioUrl,
                headers: src?.headers,
              };
            }
            // Carry the manifest's caption files across as external subtitle
            // tracks so the demuxer path keeps the CC the stream engine had.
            if (plan.subtitles?.length) {
              this.config.subtitleTracks = plan.subtitles.map((s) => ({
                url: s.url,
                lang: s.lang,
                label: s.label,
                format: s.format,
              }));
            }
          } else {
            Logger.warn(
              TAG,
              "forceStreamDemux: manifest is multi-segment — demuxer can't play it, retrying the stream path",
            );
          }
        } catch (eDemux) {
          Logger.warn(TAG, "forceStreamDemux: DASH fallback probe failed", eDemux);
        }
      }

      // Force-demux (HLS): both MSE engines failed a codec the browser can't
      // decode. HLS has no single demuxable file, so parse the playlist and
      // present its segments to the FFmpeg-WASM demuxer as one concatenated,
      // seekable stream (SegmentStreamSource). Alternate audio languages become
      // split-audio tracks (each its own segment stream); segmented WebVTT
      // subtitle renditions are concatenated into external subtitle tracks.
      if (this.config.forceStreamDemux && isHls && !this.source) {
        try {
          const plan = await analyzeHlsFallback(
            streamUrl!,
            src?.headers,
            this.config.forceVideoRendition,
            this.lifetimeSignal,
          );
          if (plan) {
            this._sourceIsEncrypted = !!plan.encrypted;
            // Nothing here can recover, so don't spend fifty failed packets
            // discovering it — see AudioDecoder.setFailFast.
            if (plan.encrypted) this.audioDecoder.setFailFast(true);
            Logger.info(
              TAG,
              `forceStreamDemux: routing HLS through the FFmpeg demuxer (${plan.segments.length} video segments)`,
            );
            // Quality menu: reuse the demuxer-mode rendition machinery (shared
            // with DASH) — the variant playlists are the selectable qualities.
            this._dashRenditions = plan.videoTracks ?? [];
            this._activeDashRendition = plan.selectedVariant ?? "";
            // Video (or muxed) stream.
            this.source = new SegmentStreamSource(
              plan.segments,
              plan.initSegment,
              streamUrl!,
              src?.headers,
            );

            // Separate audio languages → split-audio tracks, each backed by its
            // own segment stream (default language first). SegmentStreamSource
            // is lazy, so building them all costs nothing until one is selected.
            if (plan.audioRenditions?.length) {
              const ordered = [...plan.audioRenditions].sort(
                (a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0),
              );
              this.config.audioTracks = ordered.map((r, i) => {
                const key = `${streamUrl}#audio-${r.lang}-${i}`;
                return {
                  url: key,
                  lang: r.lang,
                  label: r.label,
                  adapter: new SegmentStreamSource(
                    r.segments,
                    r.initSegment,
                    key,
                    src?.headers,
                  ),
                };
              });
            }

            // Segmented WebVTT subtitle renditions → one concatenated VTT blob
            // per language, carried as external subtitle tracks. Cache by stream
            // URL: the subtitles are quality-independent, so a quality switch
            // reuses the blobs instead of re-fetching every VTT segment (the
            // main switch-latency cost).
            if (plan.subtitleRenditions?.length) {
              let subs = MoviPlayer._hlsSubtitleCache.get(streamUrl!);
              if (!subs) {
                subs = await this.buildHlsSubtitleTracks(
                  plan.subtitleRenditions,
                  src?.headers,
                );
                if (subs.length)
                  MoviPlayer._hlsSubtitleCache.set(streamUrl!, subs);
              }
              if (subs.length) this.config.subtitleTracks = subs;
            }
          } else {
            Logger.warn(
              TAG,
              "forceStreamDemux: HLS playlist not demuxable, retrying the stream path",
            );
          }
        } catch (eDemux) {
          Logger.warn(TAG, "forceStreamDemux: HLS fallback probe failed", eDemux);
        }
      }

      // --- Force a specific MSE engine (hls.js / dash.js), skipping Shaka. Set
      // when Shaka failed at RUNTIME but the other engine is more lenient with
      // the stream — e.g. a manifest-vs-actual codec mismatch Shaka rejects but
      // dash.js plays (hardware, lightweight). Preferred over the WASM demuxer,
      // which is the last resort. If this engine also can't LOAD, fall through
      // to Shaka/demuxer below; if it loads but fails at runtime, the element
      // escalates to force-demux (WASM). ---
      if (
        !this.source &&
        this.config.forceStreamEngine &&
        (isHls || isDash)
      ) {
        try {
          const engine = this.config.forceStreamEngine;
          const fb =
            engine === "hlsjs"
              ? new HLSPlayerWrapper(this.config)
              : new DASHPlayerWrapper(this.config);
          this.streamWrapper = fb;
          this.wireStreamWrapper(fb);
          Logger.info(TAG, `forceStreamEngine: playing ${kind} via ${engine}`);
          await fb.load();
          this.stateManager.setState("ready");
          return;
        } catch (eEngine) {
          Logger.warn(
            TAG,
            `forceStreamEngine (${this.config.forceStreamEngine}) failed to load; falling through`,
            eEngine,
          );
          try {
            this.streamWrapper?.destroy();
          } catch {}
          this.streamWrapper = null;
        }
      }

      // --- Tier 1: Shaka (HLS + DASH + MSS + muxed). Skipped when force-demux
      // above already resolved a demuxable single-file source. ---
      if (!this.source) try {
        const shaka = new ShakaPlayerWrapper(this.config);
        this.streamWrapper = shaka;
        this.wireStreamWrapper(shaka);
        Logger.info(TAG, `Detected ${kind} stream, using ShakaPlayerWrapper`);
        await shaka.load();
        this.stateManager.setState("ready");
        return;
      } catch (eShaka) {
        Logger.warn(TAG, `Shaka failed on ${kind} stream`, eShaka);
        try { this.streamWrapper?.destroy(); } catch {}
        this.streamWrapper = null;

        // Did the engines turn this down for want of a LICENCE, as opposed to
        // any of the other reasons they turn a stream down? It decides what the
        // demuxer tier below is allowed to do with encrypted media — see the
        // note where it is read.
        let drmRefused = looksLikeDrmFailure(eShaka);

        // --- Tier 2: hls.js / dash.js. Their MSE engines play streams Shaka
        // rejects (e.g. under-specified single-file DASH the browser demuxer
        // handles but Shaka/FFmpeg won't). ---
        if (isHls || isDash) {
          try {
            const fb = isHls
              ? new HLSPlayerWrapper(this.config)
              : new DASHPlayerWrapper(this.config);
            this.streamWrapper = fb;
            this.wireStreamWrapper(fb);
            Logger.info(TAG, `Shaka failed; retrying with ${isHls ? "hls.js" : "dash.js"}`);
            await fb.load();
            this.stateManager.setState("ready");
            Logger.info(TAG, `Recovered via ${isHls ? "hls.js" : "dash.js"}`);
            return;
          } catch (eFallback) {
            Logger.warn(TAG, `${isHls ? "hls.js" : "dash.js"} fallback also failed`, eFallback);
            drmRefused = drmRefused || looksLikeDrmFailure(eFallback);
            try { this.streamWrapper?.destroy(); } catch {}
            this.streamWrapper = null;
          }
        }

        // --- Tier 3: FFmpeg demuxer for bare-<BaseURL> single-file DASH that
        // even the MSE engines refuse (e.g. muxed single-file). Falls through
        // to the demuxer path below with the video file as the source (+ the
        // separate audio file as a native-audio source for demuxed content). ---
        let fellBack = false;
        if (isDash) {
          try {
            const plan = await analyzeDashFallback(streamUrl!, src?.headers, this.lifetimeSignal);
            // Encrypted, and we are only here because a licence was refused: the
            // answer is already known, so don't spend the viewer's attention
            // discovering it. A packager's clear lead exists to cover the wait
            // for a licence, not to be watched on its own — playing it would put
            // a few seconds of video up and then stop, which reads as the player
            // breaking rather than as content that was never going to play.
            //
            // Only when the licence is the reason. Arriving here for any other
            // reason (a forced engine, an MSE runtime failure) leaves the
            // encrypted flag to the decode-time path, which still plays whatever
            // is clear — the escape hatch for a manifest that declares
            // ContentProtection over media that turns out not to need it.
            if (plan?.encrypted && drmRefused) {
              Logger.info(
                TAG,
                "Encrypted manifest and the licence was refused — not opening it in the demuxer",
              );
              throw new Error(
                "This video is protected and needs a licence to play here.",
              );
            }
            if (plan) {
              this._sourceIsEncrypted = !!plan.encrypted;
              // Nothing here can recover, so don't spend fifty failed packets
              // discovering it — see AudioDecoder.setFailFast.
              if (plan.encrypted) this.audioDecoder.setFailFast(true);
              Logger.info(TAG, "Falling back to the FFmpeg demuxer");
              this.source = await this.createSource({
                type: "url",
                url: plan.videoUrl,
                headers: src?.headers,
              });
              if (plan.audioTracks?.length) {
                this.config.audioTracks = plan.audioTracks.map((t) => ({
                  url: t.url,
                  lang: t.lang,
                  label: t.label,
                }));
              } else if (plan.audioUrl) {
                this.config.audioSource = { type: "url", url: plan.audioUrl, headers: src?.headers };
              }
              if (plan.subtitles?.length) {
                this.config.subtitleTracks = plan.subtitles.map((s) => ({
                  url: s.url,
                  lang: s.lang,
                  label: s.label,
                  format: s.format,
                }));
              }
              fellBack = true; // fall through to the demuxer path below
            }
          } catch (eDemux) {
            Logger.warn(TAG, "FFmpeg DASH fallback failed", eDemux);
          }
        }
        if (!fellBack) {
          this.stateManager.setState("error");
          throw eShaka; // surface the original Shaka error
        }
      }
    }

    try {
      // Silence whatever is still queued from the LAST source before opening
      // this one. Every other transition already does this — seek, replay, an
      // audio-language switch — but loading a new source did not, and the
      // renderer happily played out its remaining buffer while the new file
      // was still opening. What that sounds like is a second of the previous
      // song after you have chosen a different one; it is loudest on a phone,
      // where the open takes longer and there is no video swap to cover it.
      this.audioRenderer.reset();
      if (this.videoRenderer) this.videoRenderer.clearQueue();

      // Create source — honor a pre-built adapter if the caller supplied
      // one (custom protocol, encrypted blob, IndexedDB-backed source, etc.)
      // so the demuxer can read through it without going through SourceConfig.
      if (this.source) {
        // Already resolved (defensive — a prior load may have set it).
      } else if (this.config.sourceAdapter) {
        this.source = this.config.sourceAdapter;
      } else if (this.config.source) {
        this.source = await this.createSource(this.config.source);
      } else {
        throw new Error("Either config.source or config.sourceAdapter is required");
      }

      // Which separate audio source to open, decided from config alone so the
      // decision can be made BEFORE the video demuxer opens — see below.
      let audioUrl: string | null = null;
      let audioAdapter: SourceAdapter | undefined;
      if (this.config.audioTracks && this.config.audioTracks.length > 0) {
        this._audioTracks = [...this.config.audioTracks];
        this._activeAudioLang = this._audioTracks[0].lang;
        audioUrl = this._audioTracks[0].url;
        audioAdapter = this._audioTracks[0].adapter;
        Logger.info(TAG, `Multi-language audio: ${this._audioTracks.length} tracks, default=${this._activeAudioLang}`);
      } else if (this.config.audioSource?.type === "url" && this.config.audioSource.url) {
        audioUrl = this.config.audioSource.url;
      }
      this._splitAudioRetries = 0; // fresh source → fresh retry budget

      // Create demuxer (getSize will be called lazily in bindings.open())
      this.demuxer = new Demuxer(this.source, this.config.wasmBinary);

      // The split-audio demuxer is a separate WASM instance reading a separate
      // file — none of it needs the video to be open first. Run it alongside:
      // measured, audio started 5.6s in and took another 2.8s, all of it after
      // the video demux had finished waiting on its own network. The one thing
      // it genuinely needs is the video's PTS baseline, and it waits for just
      // that (see _videoInfoReady in setupSplitAudio).
      this._videoInfoReady = new Promise<void>((resolve) => {
        this._resolveVideoInfoReady = resolve;
      });
      const splitAudioJob = audioAdapter
        ? this.setupSplitAudio(audioAdapter)
        : audioUrl
          ? this.setupSplitAudio(audioUrl)
          : null;

      // Open and get media info. Released in `finally` so a FAILED open still
      // frees the parallel audio job — otherwise it waits on a baseline that
      // is never coming and the promise never settles.
      try {
        this.mediaInfo = await this.demuxer.open();
      } finally {
        this._resolveVideoInfoReady?.();
      }
      // Destroyed by a rapid source switch during the (WASM + network) open —
      // bail before standing up the split-audio demuxer and decoders.
      if (this._destroyed) return;

      // Cache file size for buffer calculations (getSize was called in bindings.open())
      this.fileSize = await this.source.getSize();

      const bindings = this.demuxer.getBindings();
      if (bindings) {
        this.videoDecoder.setBindings(bindings);
        this.audioDecoder.setBindings(bindings);
        if (this.subtitleDecoder) {
          this.subtitleDecoder.setBindings(bindings);
        }
      }

      // Started before the video open (see above) — collect it here, where the
      // old serial call used to be, so everything downstream is unchanged.
      if (splitAudioJob) await splitAudioJob;
      // A rapid source switch may have destroyed this instance while the second
      // (split-audio) WASM demuxer was loading — bail so we don't configure
      // decoders / render onto the successor's canvas (black-frame flash).
      if (this._destroyed) return;

      // Store external subtitle tracks
      if (this.config.subtitleTracks && this.config.subtitleTracks.length > 0) {
        this._subtitleTracks = [...this.config.subtitleTracks];
        Logger.info(TAG, `External subtitles: ${this._subtitleTracks.length} tracks`);
      }

      // Set tracks
      this.trackManager.setTracks(this.mediaInfo.tracks);

      // Extract embedded cover art (if any) once the track list is settled.
      // Fire-and-forget: a missing/corrupt artwork stream shouldn't block
      // playback. The eventual emit is what wakes the element-side painter,
      // so callers don't need to await this.
      void this.extractCoverArt();

      // Configure decoders for active tracks
      await this.configureDecoders();

      // Set duration on clock for clamping (prevents timer exceeding duration)
      // Clock operates in media time (PTS), so it runs from startTime to startTime + duration
      this.startTime = this.mediaInfo.startTime || 0;
      this.seekKeyframeOffset = 0;
      this.clock.setDuration(this.mediaInfo.duration + this.startTime);
      this.clock.seek(this.startTime);

      // Does the video track stop before the file does? (See _videoTailStart.)
      // Read here rather than discovered later so a seek straight into the
      // tail — the seek bar dragged past the end of the picture — already
      // knows there is no frame coming and doesn't sit waiting for one.
      this._videoTailStart = Number.POSITIVE_INFINITY;
      this._lastVideoPacketPts = -1;
      this._lastAudioPacketPts = -1;
      this._videoPacketsSinceAudio = 0;
      this._soundCarryingAlone = false;
      const tailVideoTrack = this.trackManager.getActiveVideoTrack();
      const tailVideoDuration = tailVideoTrack?.duration ?? 0;
      const tailFileDuration = this.mediaInfo.duration;
      if (
        tailVideoTrack &&
        !tailVideoTrack.isAttachedPic &&
        tailVideoDuration > 0 &&
        tailFileDuration > 0 &&
        tailFileDuration - tailVideoDuration > 1
      ) {
        this._videoTailStart = this.startTime + tailVideoDuration;
        Logger.info(
          TAG,
          `Video track ends at ${this._videoTailStart.toFixed(2)}s of a ${tailFileDuration.toFixed(2)}s file — audio plays on past the last frame`,
        );
      }

      // …and the same question the other way round. See _audioTailStart.
      this._audioTailStart = Number.POSITIVE_INFINITY;
      const tailAudioTrack = this.trackManager.getActiveAudioTrack();
      const tailAudioDuration = tailAudioTrack?.duration ?? 0;
      if (
        tailAudioTrack &&
        tailVideoTrack &&
        !tailVideoTrack.isAttachedPic &&
        tailAudioDuration > 0 &&
        tailFileDuration > 0 &&
        tailFileDuration - tailAudioDuration > 1
      ) {
        this._audioTailStart = this.startTime + tailAudioDuration;
        Logger.info(
          TAG,
          `Audio track ends at ${this._audioTailStart.toFixed(2)}s of a ${tailFileDuration.toFixed(2)}s file — the picture plays on past the last sample`,
        );
      }

      // Emit duration
      this.emit("durationChange", this.mediaInfo.duration);

      // Prebuffer a small amount of media so play() doesn't immediately
      // stall on short videos (see prebuffer() for details).
      await this.prebuffer();

      this.stateManager.setState("ready");
      this.emit("loadEnd", undefined);

      // Warm the preview pipeline in the background — but NOT right now. It
      // stands up a second isolated WASM + WebCodecs decoder that competes with
      // the main video decoder for the GPU, and doing that during the first
      // seconds of playback is enough to tip a heavy 4K/HDR rung into a
      // frame-rate deficit and get its resolution wrongly capped. Defer the
      // eager warm-up until playback has settled; if the user scrubs before
      // then, the seek path lazy-inits it on demand (initPreviewPipeline is
      // idempotent), so previews still work — they just don't steal decode
      // headroom from a struggling startup.
      this.schedulePreviewWarm(MoviPlayer.PREVIEW_WARM_DELAY_MS);

      // A container that never wrote its duration down gets one more chance,
      // off the load path this time — see rescanDurationInBackground.
      if (!(this.mediaInfo.duration > 0)) this.scheduleDurationRescan();

      Logger.info(
        TAG,
        `Loaded: duration=${this.mediaInfo.duration}s, tracks=${this.mediaInfo.tracks.length}`,
      );
    } catch (error) {
      this.stateManager.setState("error");
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Create source adapter from config
   */
  private async createSource(config: SourceConfig): Promise<SourceAdapter> {
    if (config.type === "file" && config.file) {
      const fs = new FileSource(config.file, this.cache);
      // Low-end mobile: skip the whole-file preload. Its sequential read of the
      // entire file competes with heavy 4K decode and fills RAM (the "full load
      // before it plays" pause, plus periodic GC stalls); bounded read-ahead
      // that follows playback is gentler. Desktop keeps the full preload.
      if (MoviPlayer._isMobileDevice) fs.setFullFilePreload(false);
      fs.setOnRevoked((info) => {
        Logger.error(TAG, `File handle revoked: ${info.reason}`);
        this.emit("filerevoked", info);
      });
      fs.setOnPreloadComplete(() => {
        this.emit("preloadcomplete", undefined);
      });
      return fs;
    }

    if (config.type === "encrypted" && config.encrypted) {
      return new EncryptedHttpSource({
        ...config.encrypted,
        headers: config.headers,
      });
    }

    if (config.type === "url" && config.url) {
      // A custom scheme registered via registerSourceAdapter("s3", …) is built
      // through its factory instead of fetch(), letting the demuxer read bytes
      // from anything the app can supply (S3, IPFS, WebSocket, IndexedDB, …).
      const factory = getSourceAdapterFactory(config.url);
      if (factory) {
        return await factory({ url: config.url, headers: config.headers });
      }
      const maxBufferSizeMB = this.config.cache?.maxSizeMB;
      const source = new HttpSource(
        config.url,
        config.headers,
        maxBufferSizeMB,
      );
      // Server has no Range support + file too big to cache → forward-only
      // linear playback. Surface it so the UI can drop the timeline / seeking.
      source.setOnLinearMode(() => this.emit("linearmode", undefined));
      return source;
    }

    throw new Error("Invalid source configuration");
  }

  /**
   * Configure decoders for active tracks
   */
  /**
   * A+ verify-then-swap quality switch for the demuxer fallback (HLS/DASH).
   * Instead of tearing the player down and reloading, prepare the new
   * rendition's demuxer (open + seek to the current position) WHILE the old one
   * keeps playing, then atomically swap the video source/demuxer and reconfigure
   * the video decoder. Audio, subtitles, the clock and the AudioContext are
   * never touched — only the video briefly freezes on the last frame (no black
   * flash, no audio gap, no loading). Uses one decode pipeline at a time (the
   * new demuxer opens on an isolated WASM module so it doesn't clash with the
   * old during prep, but the video decoder only reconfigures at swap-time), so
   * memory stays flat. Returns false (staying on the current rendition) if the
   * new one can't be prepared, so a failed switch never breaks playback.
   */
  async switchVideoRenditionInPlace(newRenditionUrl: string): Promise<boolean> {
    if (this._destroyed) return false;
    if (!this.demuxer || !this.videoDecoder) return false;
    if (newRenditionUrl === this._activeDashRendition) return true;
    // Only safe when audio is a SEPARATE (split) source: the swap replaces just
    // the video demuxer/decoder and leaves audio running. If audio is muxed into
    // the main source, swapping it would drop the audio — let the caller fall
    // back to a full reload instead.
    if (!this.audioDemuxer) return false;

    const cfgSrc = this.config.source;
    const srcUrl =
      cfgSrc && "url" in cfgSrc && cfgSrc.url ? cfgSrc.url : "";
    // Tell the UI a swap is under way. It has to be paired with an end event on
    // EVERY exit below, including the early bails, or the indicator it drives
    // would be left running over a player that is doing nothing.
    const switchLabel = this._dashRenditions.find(
      (r) => r.url === newRenditionUrl,
    )?.label;
    // The start event is NOT emitted here. Everything up to the atomic swap is
    // prep — opening and seeking the new demuxer, off the current pipeline —
    // and the old rendition keeps playing throughout, untouched. Announcing a
    // switch during it put a loading indicator over a picture that was running
    // perfectly, for however long the network took, and then cleared it at the
    // return below — which is BEFORE the new frames reach the screen. So the
    // indicator covered the calm part and was gone by the time the picture
    // actually jumped. It goes up at the swap instead, and comes down when the
    // first new frame is painted.
    let indicatorOn = false;
    // The end can arrive late (it waits for the first painted frame) while a
    // NEXT switch has already raised its own indicator. Stamp each one so a
    // straggler can only ever clear the indicator it put up.
    let myIndicator = 0;
    const beginSwitchIndicator = () => {
      if (indicatorOn) return;
      indicatorOn = true;
      myIndicator = ++this._switchIndicatorGen;
      this.emit("renditionSwitch", { active: true, label: switchLabel });
      // Bound streams stop together, and this is the one place the picture
      // stops on purpose. The swap is seamless by design — only the video
      // pipeline is replaced, so the sound was never interrupted — but that
      // design is exactly what a binding says no to: on a slow link the new
      // rendition's first frame can be a second or more away, and what the
      // viewer gets is a frozen picture with a spinner over it while the sound
      // and the clock run on. Hold everything for the swap, and let the normal
      // resume gate start it again when frames are actually arriving.
      //
      // Marked self-inflicted: this is our own stall, not a starved pipeline,
      // so it resumes on readiness instead of serving the 1.5s cushion meant
      // for a decoder that fell behind. A switch that bails leaves the old
      // rendition's queue intact, so the gate finds video ready and lets go
      // immediately.
      if (this._bindAV && this.stateManager.is("playing")) {
        this.wasPlayingBeforeRebuffer = true;
        this._bufferingEntryTime = performance.now();
        this._bufferingSelfInflicted = true;
        this.stateManager.setState("buffering");
        this.clock.pause();
        this.audioRenderer?.suspendForBuffering();
        this.videoRenderer?.stopPresentationLoop();
      }
    };
    const endSwitch = <T,>(result: T): T => {
      if (indicatorOn && myIndicator === this._switchIndicatorGen) {
        indicatorOn = false;
        this.emit("renditionSwitch", { active: false, label: switchLabel });
      }
      return result;
    };
    const isHls = srcUrl.toLowerCase().includes(".m3u8");
    const headers = this.config.headers;

    // --- PREP (old keeps playing): build + open the new demuxer on an isolated
    // WASM module and seek it to the current position. Any failure here bails
    // out cleanly, leaving the old rendition untouched. ---
    // …and any HANG here bails out too. See SWITCH_PREP_BUDGET_MS: the prep is
    // several unbounded network waits held under a flag that disables every
    // path that could rescue playback, so it needs an end.
    const prepDeadline =
      performance.now() + MoviPlayer.SWITCH_PREP_BUDGET_MS;
    const prepLeft = () => prepDeadline - performance.now();
    let newSource: SourceAdapter;
    try {
      if (isHls) {
        const variant = await loadHlsVariant(newRenditionUrl, headers, this.lifetimeSignal);
        if (!variant) return endSwitch(false);
        newSource = new SegmentStreamSource(
          variant.segments,
          variant.initSegment,
          newRenditionUrl,
          headers,
        );
      } else {
        newSource = await this.createSource({
          type: "url",
          url: newRenditionUrl,
          headers,
        });
      }
    } catch (e) {
      Logger.warn(TAG, "in-place switch: new source build failed", e);
      return endSwitch(false);
    }

    const newDemuxer = new Demuxer(newSource, this.config.wasmBinary, true);
    // From here until the swap adopts them (or a bail closes them), these two
    // are the only pieces of this player that nothing else can reach: they are
    // locals of an async function, so destroy() — which closes `this.source`,
    // `this.audioSource` and the thumbnail source — had no idea they existed.
    // A switch that was still prepping when the player was destroyed therefore
    // kept its stream running: read off one session, the source went on
    // fetching 8MB ranges for another 60.5MB after "Player destroyed" and only
    // stopped when it hit its own download limit. Park them where the teardown
    // can find them.
    this._pendingSwitchSource = newSource;
    this._pendingSwitchDemuxer = newDemuxer;
    const abandonPrep = (reason?: string, e?: unknown): boolean => {
      if (reason) Logger.warn(TAG, `in-place switch: ${reason}`, e);
      try { newDemuxer.close(); } catch {}
      try { newSource.close(); } catch {}
      if (this._pendingSwitchSource === newSource) {
        this._pendingSwitchSource = null;
        this._pendingSwitchDemuxer = null;
      }
      return endSwitch(false);
    };
    let newInfo: MediaInfo;
    try {
      const opened = await withDeadline(newDemuxer.open(), prepLeft());
      if (opened === TIMED_OUT) {
        // The moov never arrived in the budget. On the rung that does this —
        // the one whose bitrate is at or above what the link can carry — the
        // read is not slow, it is losing a race with the stream that is still
        // playing. Abandon, which closes the source and hands the link back.
        return abandonPrep(
          `new demuxer open exceeded ${MoviPlayer.SWITCH_PREP_BUDGET_MS}ms — the link can't feed this rung`,
        );
      }
      newInfo = opened;
    } catch (e) {
      return abandonPrep("new demuxer open failed", e);
    }
    // The player went away while the open was in flight. Everything past this
    // point writes to a torn-down pipeline — one session ran the whole swap
    // against it and got as far as compiling a shader on a destroyed renderer.
    if (this._destroyed) return abandonPrep();
    const newVideoTrack = newInfo.tracks.find(
      (t) => t.type === "video",
    ) as VideoTrack | undefined;
    if (!newVideoTrack) {
      return abandonPrep();
    }
    const newStartTime = newInfo.startTime || 0;
    // Read the clock HERE, after the open — not before it.
    // Building and opening the new source is a network round trip — on the link
    // that most needs a quality switch it takes seconds, and audio (a separate
    // source, still playing) carries the clock right on through it. Seeking to
    // the stale time starts the new rendition BEHIND the playhead, and the
    // keyframe alignment drags it back further still; the swap then has to
    // fetch and decode that whole deficit ON TOP of realtime, precisely when
    // bandwidth is already the problem. Measured on a 5Mbps link: a 720p50
    // upshift came up 7.2s behind, which ate a 55s buffer in 12 seconds and
    // left the video frozen under running audio.
    //
    // And aim BEHIND it — see RENDITION_SWAP_LOOKBACK_S. Landing ahead of the
    // clock freezes the picture until the clock catches up; landing behind it
    // costs a little decode of frames that are already in hand.
    const lookbackFromNow = () =>
      Math.max(
        0,
        Math.min(
          this.getCurrentTime() - MoviPlayer.RENDITION_SWAP_LOOKBACK_S,
          this.getDuration() || Number.POSITIVE_INFINITY,
        ),
      );
    let swapTime = lookbackFromNow();
    // Where the incoming source was actually positioned. The two paths seek to
    // different points, and the buffer bar is drawn from this.
    let seekedTo = swapTime;
    // --- PRIME (old STILL playing): decode the incoming rendition past the
    // playhead so the swap below costs no frames. Only attempted while the
    // picture is actually running — a paused or seeking player has no seam to
    // hide — and only when both renditions count time from the same origin,
    // since the splice compares their frames by raw timestamp.
    let primed: { decoder: MoviVideoDecoder; frames: VideoFrame[] } | null = null;
    // Set when the prime ran out of clock rather than bailing for a structural
    // reason (no shared origin, a paused player, a software-backed decoder).
    // That distinction is what the abandon below turns on.
    const primeStatus: { exhausted: boolean; readInFlight?: Promise<unknown> } = {
      exhausted: false,
    };
    const sameOrigin = Math.abs(newStartTime - this.startTime) < 0.001;
    if (
      sameOrigin &&
      this.videoRenderer &&
      this.stateManager.getState() === "playing"
    ) {
      try {
        // Aimed AT the playhead, not behind it. The lookback below exists
        // because the hard path resumes decoding from where it seeks and must
        // not land ahead of the clock; priming decodes forward past the clock
        // on purpose, so every second of lookback would be a second of frames
        // decoded only to be thrown away — at the resolution that most needs
        // the switch to be cheap.
        seekedTo = this.getCurrentTime();
        const sought = await withDeadline(
          newDemuxer.seek(seekedTo + newStartTime),
          prepLeft(),
        );
        if (sought === TIMED_OUT) {
          return abandonPrep(
            "seek for the seamless prime exceeded the prep budget",
          );
        }
        primed = await this.primeRendition(
          newDemuxer,
          newVideoTrack,
          newStartTime,
          prepDeadline,
          primeStatus,
        );
      } catch (e) {
        Logger.debug(TAG, `Seamless prime unavailable: ${e}`);
        primed = null;
      }
    }

    if (!primed) {
      // Re-read the clock for the same reason it was read after the open: a
      // prime that ran for seconds and then gave up would otherwise seek to a
      // point that far behind the playhead ON TOP of the lookback, and the swap
      // would have to decode the whole deficit before showing anything.
      // A prep that has already spent its whole budget has said what it needed
      // to: this rung is not being fed. Falling through would commit the swap
      // regardless — the unprimed path is a HARD switch, so the picture stops,
      // the indicator goes up, and the player then waits on the very stream
      // that could not prime. Abandon instead and let the next tick decide
      // again, with the old rendition still playing throughout.
      if (prepLeft() <= 0) {
        return abandonPrep(
          "prep budget spent before the swap — leaving the current rung in place",
        );
      }
      // A prime that ran out of clock has already measured the thing this path
      // is about to bet on, and the answer was no.
      //
      // The hard swap aims RENDITION_SWAP_LOOKBACK_S behind the playhead on
      // purpose, so the incoming rendition starts on a frame the clock has
      // passed — and that is only cheap because "those frames decode far
      // faster than real time". On the rungs that fail to prime, they do not.
      // Measured on an 8K60 AV1 rung: the prime spent its whole budget without
      // staging a usable frame, the swap then seeked 4s back, the keyframe
      // before that put the first frame 6.2s behind the audio, and the picture
      // never closed the gap — three catch-up seeks each landed on an earlier
      // keyframe and lost more ground (3.6s → 4.5s → 6.1s behind) until the
      // resync cap ran out and the picture simply stopped under running sound.
      //
      // The prime is the cheapest possible test of exactly that capability and
      // we have already paid for it. Failing it means this rung cannot chew a
      // swap backlog either, so don't create one: leave the current rendition
      // playing and let the next tick decide again.
      //
      // Only for an EXHAUSTED prime. The structural bails — no shared origin, a
      // paused player, a prime that came up software-backed — say nothing about
      // decode headroom, and those swaps go through as before.
      // …and only when CLIMBING. A downshift is the switch a struggling player
      // must always be allowed to finish — refusing it because the link was too
      // slow to prime would strand the picture on the very rung it is trying to
      // escape, which is the opposite of the rescue. Backlog is affordable
      // there anyway: the target is the cheaper rung.
      const targetBw =
        this._dashRenditions.find((r) => r.url === newRenditionUrl)?.bandwidth ?? 0;
      const activeBw =
        this._dashRenditions.find((r) => r.url === this._activeDashRendition)
          ?.bandwidth ?? 0;
      if (primeStatus.exhausted && targetBw > activeBw) {
        return abandonPrep(
          "the incoming rung could not be primed inside its budget — it will not chew the swap backlog either",
        );
      }
      // The prime can give up on a read that has not come back — it cannot be
      // cancelled, only outwaited. Seeking the same demuxer over it hands the
      // seek the read's pending slot: the read's bytes then land on "No pending
      // read to fulfill" and the demuxer the swap is about to play from is
      // wedged. That is why AUTO switches stuck on the heavy rungs and manual
      // ones did not: an ABR downshift fires on a low buffer over a saturated
      // link, where a 4K/8K read outlasts the prime's budget, while a manual
      // pick lands on a healthy one and primes to a seamless handover. Measured
      // on a 2160p → 1440p downshift: the warning 7ms after the swap, then the
      // picture held while the sound ran on.
      if (primeStatus.readInFlight) {
        const landed = await withDeadline(
          primeStatus.readInFlight,
          Math.max(prepLeft(), 0),
        );
        if (landed === TIMED_OUT) {
          return abandonPrep(
            "the prime's last read never landed — the new demuxer cannot be reused",
          );
        }
      }
      swapTime = lookbackFromNow();
      seekedTo = swapTime;
      try {
        const sought = await withDeadline(
          newDemuxer.seek(swapTime + newStartTime),
          prepLeft(),
        );
        if (sought === TIMED_OUT) {
          return abandonPrep("new demuxer seek exceeded the prep budget");
        }
      } catch (e) {
        return abandonPrep("new demuxer seek failed", e);
      }
    }

    // Last exit before the swap commits. The prime and the seek above are both
    // network-length waits, and a player destroyed inside either of them must
    // not come out the other side and swap itself into a pipeline that is gone.
    if (this._destroyed) {
      try { primed?.decoder.close(); } catch {}
      for (const f of primed?.frames ?? []) {
        try { f.close(); } catch {}
      }
      return abandonPrep();
    }

    // --- ATOMIC SWAP: stop the video loop (audio + clock keep running), swap
    // the video source/demuxer, hand the renderer its new frames, resume. ---
    // Primed, this is invisible and no indicator goes up. Unprimed, this is
    // where the picture stops, so this is where the indicator starts.
    if (!primed) beginSwitchIndicator();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    ++this.seekSessionId; // supersede any in-flight seek
    // A seek we just superseded may have left its video-sync flag set; this swap
    // owns the resume now, so release it or the pipeline waits for a completion
    // that can never arrive (see notifySeekCompletion's superseded-seek branch).
    this.waitingForVideoSync = false;
    let guard = 0;
    while (this.demuxInFlight && guard++ < 100) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The wait above can outlast a prime: the clock kept running through it, so
    // frames staged for a playhead that has since passed them are no longer a
    // handover, they are a jump backwards. Drop them, and if that empties the
    // staging the switch is simply not seamless this time — nothing has been
    // swapped yet, so the hard path below is still open.
    if (primed) {
      const floor = this.getCurrentTime() - 0.05;
      while (
        primed.frames.length > 0 &&
        primed.frames[0].timestamp / 1_000_000 - newStartTime < floor
      ) {
        primed.frames.shift()!.close();
      }
      if (primed.frames.length === 0) {
        Logger.debug(TAG, "Seamless prime went stale during the swap — hard switch");
        try { primed.decoder.close(); } catch {}
        primed = null;
        beginSwitchIndicator();
        swapTime = lookbackFromNow();
        seekedTo = swapTime;
        // Put the read cursor back where the hard path expects it. The prime
        // drove it forward, and the reconfigured decoder would otherwise be fed
        // from mid-GOP and sit on its keyframe wait for as long as the GOP is
        // long. Failure here is not a reason to abandon the swap — the video
        // loop is already stopped, so there is nothing to return TO.
        try {
          await newDemuxer.seek(swapTime + newStartTime);
        } catch (e) {
          Logger.warn(TAG, "in-place switch: re-seek after a stale prime failed", e);
        }
      }
    }

    const oldDemuxer = this.demuxer;
    const oldSource = this.source;
    const oldDecoder = this.videoDecoder;

    // Everything read against the outgoing pipeline is now history — see the
    // generation check in processLoop's catch.
    this._demuxerGeneration++;
    this.demuxer = newDemuxer;
    this.source = newSource;
    // Adopted — the ordinary teardown owns them from here.
    this._pendingSwitchSource = null;
    this._pendingSwitchDemuxer = null;
    this.startTime = newStartTime;
    try {
      this.fileSize = await newSource.getSize();
    } catch {}

    // Reset the buffer-bar bookkeeping for the new source. getBufferedTime()
    // clamps the buffered-end monotonically (lastBufferedTime) and derives it
    // from the source's read cursor + fileSize — both of which just changed to a
    // fresh file that has only buffered from the resume point. Without this the
    // clamp holds the old rendition's higher, differently-scaled value and the
    // buffer bar freezes after a quality switch.
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = seekedTo;

    // The video decoder's software path reads through the demuxer's WASM module.
    const bindings = newDemuxer.getBindings();
    if (bindings) (primed?.decoder ?? this.videoDecoder).setBindings(bindings);

    // Set the active rendition BEFORE setTracks: setTracks fires tracksChange,
    // which re-renders the quality menu + gear badge from getActiveDashRendition
    // — so this must already point at the new rendition or the UI shows stale.
    this._activeDashRendition = newRenditionUrl;

    // Reflect the new video track (the split-audio demuxer path keeps only the
    // video track in the TrackManager; audio + subtitles live elsewhere).
    this.trackManager.setTracks([newVideoTrack]);
    this.trackManager.selectVideoTrack(newVideoTrack.id);

    if (primed) {
      // Hand over: the outgoing frames already queued play out, the primed ones
      // take the timeline from there, and the decoder that made them becomes
      // the decoder. Nothing is flushed — a flush is a wait for a pipeline we
      // are about to discard, and on some builds it is a wait that times out.
      const spliceAt = primed.frames[0].timestamp;
      const adopted = this.videoRenderer?.spliceQueue(spliceAt, primed.frames) ?? 0;
      this.wireVideoDecoder(primed.decoder);
      this.videoDecoder = primed.decoder;
      try { oldDecoder.close(); } catch {}
      Logger.debug(
        TAG,
        `Seamless handover at ${(spliceAt / 1_000_000).toFixed(3)}s with ${adopted} frames primed`,
      );
    } else {
      // Flush + reconfigure the video decoder/renderer for the new resolution.
      try { await this.videoDecoder.flush(); } catch {}
      this.dropVideoReadAhead();
      this.videoRenderer?.clearQueue();
      const extradata = newDemuxer.getExtradata(newVideoTrack.id) ?? undefined;
      await this.videoDecoder.configure(
        newVideoTrack,
        extradata,
        this.config.frameRate ?? 0,
      );
    }
    this.videoRenderer?.configure(
      newVideoTrack.width,
      newVideoTrack.height,
      newVideoTrack.colorPrimaries,
      newVideoTrack.colorTransfer,
      this.config.frameRate || newVideoTrack.frameRate,
      newVideoTrack.rotation ?? 0,
      newVideoTrack.isHDR,
      newVideoTrack.pixelFormat,
    );

    // NOTE: deliberately do NOT set seekTargetTime here — it's a shared field
    // the split-audio pump also honors, so setting it would make the untouched
    // audio drop packets and glitch. The video re-syncs to the running clock on
    // its own; the new demuxer is already seeked to the resume point.
    this.seekKeyframeOffset = 0;

    // Resume the video loop from the current position.
    this.processLoop();

    // The session bump above superseded whatever seek was in flight, and that
    // seek is not coming back to finish: it returns at its own superseded check
    // having already set "seeking" and paused the clock. If it notices in time
    // it resolves that itself; if the bump landed after its last check it
    // cannot, and the player is left frozen under a spinner that only a manual
    // seek clears (which is exactly how this was reported). The swap took the
    // session, so the swap finishes the seek.
    this.resumeAfterOrphanedSeek("an in-place rendition swap");

    // --- Tear down the old video pipeline (audio pipeline untouched). ---
    try { oldDemuxer.close(); } catch {}
    try { oldSource?.close(); } catch {}

    // The catch-up starts here, at the landing (see _lastRenditionSwapAt). A
    // seamless handover has no catch-up — its frames were decoded past the
    // playhead before the swap — so only the hard path arms it.
    if (!primed) this._lastRenditionSwapAt = performance.now();
    Logger.info(
      TAG,
      `in-place quality switch → ${newVideoTrack.width}x${newVideoTrack.height}${primed ? " (seamless)" : ""}`,
    );
    // Hold the indicator until the new rendition is actually on screen. The
    // swap is complete here, but the decoder has not produced a frame yet —
    // clearing now leaves the picture frozen with nothing explaining it, which
    // is the gap the viewer sees. Detached on purpose: the caller (ABR) is
    // waiting on this promise to release its own switch lock, and holding that
    // until the first frame lands would delay the next decision.
    // …and none of that applies to a seamless handover: no indicator went up,
    // because the picture never stopped to need one.
    if (!primed) void this.clearSwitchIndicatorOnResumedPlayback(endSwitch);
    // Re-stamp the anti-thrash clock at the LANDING, not the request. Every
    // settle in the ABR — the ordinary gate, the upshift hold, the emergency
    // downshift's "a fresh rung has nothing buffered yet BY DEFINITION" — is
    // measuring the new rung's first seconds, and the new rung does not exist
    // until here. Opening it costs a demuxer, a WASM instance and a byte range,
    // which on the link this was written for took the better part of a minute:
    // the settle expired while the OLD rung was still on screen, so the new one
    // landed with an empty buffer and no protection, froze during its own
    // refill, and was rescued off — 1080p → 720p → 480p → 360p, each step
    // "rescuing" the fill of the step before, on a link that then measured
    // 24Mbps and climbed straight back.
    this._lastAbrSwitchAt = performance.now();
    return true;
  }

  /**
   * Clear a rendition-switch indicator once the new pipeline is not just
   * painting but painting SMOOTHLY.
   *
   * The first frame is the wrong moment to let go of it. clearQueue() empties
   * the renderer at the swap, so that frame arrives with nothing behind it —
   * the decoder is still filling, and what the viewer gets for the next few
   * hundred milliseconds is a frame here, a frame there. Hiding the indicator
   * on it just moves the unexplained stutter to right after the indicator
   * disappears. Wait for about a third of a second of frames AND a queue with
   * something in reserve, which together are what "it's running again" means.
   *
   * Bounded: a decoder that never gets there (a rung the machine can't handle,
   * a stalled fetch) must not leave the indicator up forever. The stall then
   * shows as ordinary buffering, which is what it is.
   */
  private async clearSwitchIndicatorOnResumedPlayback(
    end: <T>(r: T) => T,
  ): Promise<void> {
    const deadline = performance.now() + 4000;
    const renderer = this.videoRenderer as unknown as {
      presentedSinceClear?: () => number;
      getQueueSize?: () => number;
    } | null;
    if (renderer?.presentedSinceClear) {
      const fps = this.trackManager?.getActiveVideoTrack()?.frameRate || 24;
      const settledFrames = Math.max(3, Math.round(fps * 0.3));
      while (performance.now() < deadline) {
        const painted = renderer.presentedSinceClear() || 0;
        // A queue with frames in it is the difference between "a frame landed"
        // and "frames keep landing". Renderers without the accessor fall back
        // to the frame count alone.
        const readyAhead = renderer.getQueueSize ? renderer.getQueueSize() >= 2 : true;
        if (painted >= settledFrames && readyAhead) break;
        await new Promise((r) => setTimeout(r, 32));
      }
    }
    end(undefined);
  }

  /**
   * Enable/disable adaptive quality (ABR) on the in-place demuxer/premuxed
   * switch. When on, a timer estimates download throughput and switches to the
   * best rendition it can sustain — in-place, so it's smooth. Off pins the
   * current rendition.
   */
  setAutoQuality(enabled: boolean): void {
    if (this._autoQuality === enabled) return;
    this._autoQuality = enabled;
    if (enabled) {
      this._abrPrimed = false; // first upshift jumps without the 2-tick wait
      this._abrPenalizedBandwidth = 0; // fresh Auto session — no stale penalty
      this._abrPenaltyUntil = 0;
      // Kick off a quick startup speed test so Auto can ramp to the right rung
      // in a couple of seconds instead of climbing rung-by-rung off passive
      // measurement — the "good link but started ugly-low" case. Non-blocking:
      // playback is already running on the small opening rung; when the probe
      // lands it seeds the estimate and re-evaluates. It measures PAST the proxy
      // burst (see probeLinkBandwidth), so it's honest on a caching proxy.
      void this.runStartupSpeedTest();
      this.abrTick(); // evaluate immediately (in case something already measured)
      if (!this._abrTimer) {
        this._abrTimer = setInterval(() => this.abrTick(), 4000);
      }
    } else if (this._abrTimer) {
      clearInterval(this._abrTimer);
      this._abrTimer = null;
    }
  }

  /**
   * One-shot startup speed test. Probes the SMALLEST rung's URL past the proxy
   * burst for a sustained reading, seeds the estimate, and re-evaluates so Auto
   * ramps straight to the affordable rung. Best-effort — a failure just leaves
   * Auto to measure passively from playback as before.
   */
  private async runStartupSpeedTest(): Promise<void> {
    if (this._startupSpeedTestRan) return;
    this._startupSpeedTestRan = true;
    // The host may have already run a pre-play probe and seeded the estimate
    // (the element does, to pick the opening rung). Don't probe again then.
    if (this._lastThroughputBps > 0) return;
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    if (rungs.length < 2) return;
    // Probe a MID rung: the smallest rung's whole file can be too small to skip
    // the proxy burst and still time a tail (it hit EOF and measured nothing).
    // The Range header caps the download; the link measured is the same.
    const probe =
      rungs[Math.min(rungs.length - 1, Math.floor(rungs.length / 2))];
    const bits = await probeLinkBandwidth(probe.url, {
      headers: this.config.headers,
      signal: this.lifetimeSignal,
    });
    if (this._destroyed || bits <= 0) return;
    // Seed only if playback hasn't already measured a HIGHER sustained rate
    // (a fully-cached/fast source can beat the probe) — never drag a good
    // reading down.
    const bps = bits / 8;
    if (bps > this._lastThroughputBps) this._lastThroughputBps = bps;
    Logger.info(
      TAG,
      `Startup speed test: ${(bits / 1e6).toFixed(1)}Mbps sustained (past the proxy burst)`,
    );
    // Keep it for the next open. Only the element's pre-play probe was writing
    // this store, so a session whose probe came up empty — a proxy that bursts
    // before it paces, which is exactly where the probe struggles — measured a
    // perfectly good link here and then threw the number away, and the next
    // open started from "no link measurement yet" on the smallest rung again.
    // raise, not persist: a reading taken mid-playback is a floor (the stream
    // is paced to its own bitrate), so it may lift a stored estimate but must
    // never drag a better one down. Same rule the Shaka and DASH wrappers use.
    raiseLinkBps(bps);
    if (this._autoQuality) void this.abrTick();
  }

  isAutoQuality(): boolean {
    return this._autoQuality;
  }

  /**
   * One ABR decision: pick the best rendition the measured throughput can
   * sustain and switch to it in-place. Downshifts eagerly when the audio buffer
   * is starving. No-op while a switch is already running or bitrates are unknown.
   */
  private async abrTick(): Promise<void> {
    // One decision at a time. The upshift path AWAITS a probe of the target
    // rung before it commits, and a tick that arrived during that await sailed
    // past every guard below — including _abrSwitchInProgress, which is only
    // set once the commit actually starts. Two ticks then committed the same
    // climb 285ms apart, and the second swap tore down the source the first was
    // still priming: the picture froze and the rescue dropped the quality
    // straight back down. That whole cycle reads as "Auto can't sit still".
    if (this._abrTickInFlight) return;
    this._abrTickInFlight = true;
    try {
      await this.abrDecide();
    } finally {
      this._abrTickInFlight = false;
    }
  }

  private _abrTickInFlight = false;
  // The source and demuxer an in-place rendition switch is preparing, while it
  // is preparing them. They belong to no one else until the swap adopts them —
  // see switchVideoRenditionInPlace — so this is how destroy() reaches them.
  private _pendingSwitchSource: SourceAdapter | null = null;
  private _pendingSwitchDemuxer: Demuxer | null = null;
  // Bumped whenever the video demuxer is replaced, so a read still in flight
  // against the old one can be told apart from a genuine failure.
  private _demuxerGeneration = 0;

  /** One ABR decision. Always through abrTick(), never called directly. */
  private async abrDecide(): Promise<void> {
    if (
      this._destroyed ||
      !this._autoQuality ||
      this._abrSwitchInProgress ||
      this._dashRenditions.length < 2 ||
      !this.source ||
      // Audio-only: the video source's prefetch is paused, so the video buffer
      // can only shrink as the playhead advances. The draining-buffer downshift
      // below reads that as an unsustainable rung and walks the quality down one
      // step every tick — a video that was on 8K comes back on 1080p after a
      // spell of audio-only, even though nothing about the link changed. There's
      // no video being fetched to adapt, so don't adapt: freeze the ABR here and
      // clear the buffer baseline so re-enabling video doesn't misfire on the
      // first post-resume tick.
      this._audioOnly ||
      // Never switch while a seek is resolving. The in-place swap replaces the
      // video demuxer/source and bumps seekSessionId; doing that concurrently
      // with a user seek races the seek's own demuxer reads and leaves the WASM
      // demuxer reading bytes at the wrong offset — surfacing as "corrupt data
      // stream" plus a large A/V desync. Wait for the seek to settle first.
      this.stateManager.is("seeking") ||
      this.waitingForVideoSync
    ) {
      if (this._audioOnly) this._lastBufferAhead = 0;
      return;
    }
    // Hidden tab: make no decision at all, and forget the buffer reading.
    //
    // Video decode is skipped while hidden, so the video buffer drains as the
    // clock runs even on a link that is perfectly fine — and the comparison
    // against the pre-background reading then reads as a collapsing buffer the
    // moment the tab comes back, which is why returning to a tab dropped the
    // quality. Clearing the baseline means the first tick after the return
    // establishes a fresh one instead of measuring against history.
    //
    // PiP is exempt: the video is visible there and decoding normally.
    if (this.isBackgrounded && !this.isPiPActive) {
      this._lastBufferAhead = 0;
      this._abrUpCandidate = "";
      this._abrUpConfirms = 0;
      return;
    }

    // Best-first: index 0 = highest bitrate.
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (rungs.length < 2) return; // no bitrate info → can't adapt

    const activeIdx = rungs.findIndex(
      (r) => r.url === this._activeDashRendition,
    );
    const now = performance.now();
    const sinceSwitch = now - this._lastAbrSwitchAt;

    // Capped-start correction: a new video (or a recreate) can start on the
    // source's default rung even though this device has already proven — this
    // session — it can't decode that height (e.g. it settled at 2160p last
    // video, so this one defaults to 2160p, which is session-capped). Drop
    // straight to the highest decodable rung instead of stuttering through the
    // whole decode-bound dance again.
    if (activeIdx >= 0 && deviceDecodeBoundHeights.size > 0 && now - this._lastAbrSwitchAt > 3000) {
      const active = rungs[activeIdx];
      if (active.height != null && MoviPlayer.isDecodeBound(active.codec, active.height)) {
        const ok = rungs.find(
          (r) => r.height == null || !MoviPlayer.isDecodeBound(r.codec, r.height),
        );
        if (ok && ok.url !== this._activeDashRendition) {
          Logger.info(
            TAG,
            `ABR: started on decode-capped ${active.height}p — correcting to ${ok.label || ok.bandwidth}`,
          );
          await this.abrCommit(ok.url, now);
          return;
        }
      }
    }

    // Same correction for SOFTWARE decode. The cap below stops Auto climbing
    // past what the CPU can hold, but a session that is already sitting above
    // it — the hardware path failed and the fallback reloaded at the rung that
    // was playing — would just stay there and stutter. Come down at once.
    if (activeIdx >= 0 && this.decodingOnCpu() && sinceSwitch > 3000) {
      const ceilingH = softwareDecodeCeiling(
        !!this.videoDecoder && !this.videoDecoder.isSoftware,
      );
      const active = rungs[activeIdx];
      if (
        (active.height ?? 0) > ceilingH &&
        this.softwareCeilingApplies(active.codec)
      ) {
        // The landing rung is chosen by the same per-codec rule, so a ladder
        // that changes codec on the way down lands on the highest rung this
        // machine can actually decode — not the highest one under a ceiling
        // that belongs to the codec being left behind.
        const ok = rungs.find(
          (r) =>
            (r.height ?? 0) <= ceilingH || !this.softwareCeilingApplies(r.codec),
        );
        if (ok && ok.url !== this._activeDashRendition) {
          // Write down what just happened, or the correction can undo itself.
          // Landing on a hardware rung clears decodingOnCpu, and with nothing
          // recorded the throughput path is free to climb straight back into
          // the rung that had no hardware path — fall to the CPU, correct,
          // climb, forever. Session-only and for this rung alone: a codec
          // without a hardware path at one height may well have one lower
          // down, and that is the next rung's question to answer, not this
          // one's to prejudge.
          const leavingKey = decodeBoundKey(
            this.videoDecoder?.configuredCodec || active.codec || "",
            active.height ?? 0,
          );
          if (active.height) {
            deviceDecodeBoundHeights.add(leavingKey);
            sessionOnlyDecodeBoundHeights.add(leavingKey);
          }
          Logger.info(
            TAG,
            `ABR: software decode can't hold ${active.height}p ${codecFamily(active.codec) || "video"} — correcting to ${ok.label || ok.height + "p"}${codecFamily(ok.codec) !== codecFamily(active.codec) ? ` (${codecFamily(ok.codec)}, which has a hardware path)` : ""}`,
          );
          await this.abrCommit(ok.url, now);
          return;
        }
      }
    }

    // How many seconds of video are buffered ahead of the playhead, and whether
    // that number is shrinking — the GROUND TRUTH for whether the current rung is
    // sustainable, independent of the throughput estimate. That estimate LAGS on
    // the premuxed path: while we coast on a filling buffer the source isn't
    // downloading, so its last-measured speed stays stale-high and would wrongly
    // report the rung as affordable (that's exactly how a 4K buffer drained to
    // zero on a throttled link without ever downshifting).
    const bufferAhead = Math.max(
      0,
      this.getBufferedTime() - this.getCurrentTime(),
    );
    // …but only while there is still something to fetch. Once the whole file is
    // in hand the buffer shrinks by a second for every second played, forever,
    // and that is not the link failing to keep up — it is the download being
    // finished. Reading it as a drain left Auto pinned: on a fully buffered
    // 144p rung every tick looked like a buffer in trouble, so the upshift gate
    // refused, and quality only ever climbed if the viewer PAUSED (which stops
    // the playhead, so the buffer stops shrinking).
    const nothingLeftToFetch = this.nothingLeftToFetch();
    const draining =
      !nothingLeftToFetch &&
      this._lastBufferAhead > 0 &&
      bufferAhead < this._lastBufferAhead - 1.5;
    this._lastBufferAhead = bufferAhead;

    // DOWNSHIFT (responsive) — a hard buffering stall OR a draining/low buffer
    // means the current rung can't be sustained; act fast and WITHOUT a
    // throughput gate (the gate, fed a stale-high estimate, was what blocked the
    // downshift). Paced by a short 5s settle rather than the 12s voluntary
    // cooldown so it responds before the buffer empties, and stood down for a few
    // seconds after a seek — that buffering is a normal re-fill, and swapping
    // into it races the seek's own re-prime and crashed the demuxer.
    const postSeekSettling = now - this._lastSeekAt < 4000;
    // The first seconds back from a hidden tab are a refill, not a verdict: the
    // buffer drained because decode was skipped, and it fills again at whatever
    // rate the link always had. Long enough to cover the refill, short enough
    // that a link which genuinely degraded while we were away is still caught
    // on the tick after.
    const postBackgroundSettling =
      this._foregroundRecoveryAt > 0 &&
      now - this._foregroundRecoveryAt < 8000;
    // Buffering is the ABR's ground truth for a rung the link cannot carry —
    // but only when the link is what stopped us. A buffering WE caused (a rate
    // change's audio re-anchor, a seek resuming on the cushion it just flushed,
    // a bound catch-up holding the sound for the picture) says nothing about
    // the rung, and reading it as a verdict costs a rung every few seconds for
    // as long as the hold lasts: one session walked 1440p → 1080p → 720p →
    // 480p → 360p → 240p on a link carrying 25.9s of buffer, each downshift
    // clearing the frame queue the hold was waiting to see fill — the ladder
    // collapse and the wait sustaining each other.
    // …and only when the link is what ran out. Playback can stall with seconds
    // of the rung already ON THE MACHINE — the frame queue empties while the
    // decoder re-primes, or the picture is catching up — and a downshift is a
    // bandwidth remedy for a problem that is not bandwidth. Measured on a 4K60
    // rung: three stalls with 7.1s, 9.5s and 67.2s buffered ahead, each read as
    // the rung failing, walking 2160p → 1440p → 1080p → 720p while the bytes
    // for 2160p sat in hand. A rung the DEVICE cannot decode still drops, via
    // the decode-bound branch that owns that case.
    const linkStarved = bufferAhead < MoviPlayer.ABR_STALL_STARVED_S;
    const stalling =
      this.stateManager.is("buffering") &&
      !this._bufferingSelfInflicted &&
      linkStarved;
    // An in-place quality switch resets the buffered range to ~0 at the current
    // playhead, so bufferAhead reads low for the first several seconds while the
    // new rendition re-primes — that's a REFILL, not the network failing to
    // sustain the rung. Gate the absolute-low check on a longer post-switch
    // settle (matching the upshift cooldown) so the refill dip can't be misread
    // as "can't cope" and fire a downshift — which resets the buffer again and
    // self-sustains a 240⇄360 oscillation on a perfectly fine link. A genuine
    // hard stall (buffering) or a sustained DRAIN — buffer actively shrinking,
    // which never happens while it's refilling — still downshifts responsively.
    // "Settled" = 12s clear of the last quality switch AND the last seek. Both
    // reset the buffered range to ~0 at the new playhead, so the absolute-low
    // clause below must not fire on that refill dip — a seek makes bufferAhead
    // low INSTANTLY, and downshifting then is wrong (it just needs to refill).
    // Same reasoning extended to the FIRST fill after playback starts: at
    // startup no switch has happened, so `sinceSwitch` is Infinity and the
    // clause below would fire on the normal 0–4s ramp-up dip. Give the buffer
    // the same 12s grace to build before its depth is treated as a verdict on
    // the rung — this is what let 4K survive startup instead of being dropped
    // to 1080p within the first second on a link that carries it.
    // Unset (still NEGATIVE_INFINITY) means playback hasn't begun — that is
    // the *least* settled state, so it must read false. Subtracting
    // NEGATIVE_INFINITY yields Infinity, which would wrongly read as "settled".
    const settledSinceStart =
      this._playbackStartedAt !== Number.NEGATIVE_INFINITY &&
      now - this._playbackStartedAt > 12000;
    const settledSinceSwitch =
      sinceSwitch > 12000 &&
      now - this._lastSeekAt > 12000 &&
      settledSinceStart;
    // While the video is holding for a keyframe (or just recovered), the video
    // buffer drains even though the network is fine — the clock advances but the
    // frozen frame doesn't. Don't let that phantom drain trigger a downshift; a
    // genuine network stall still fires via `stalling` (buffering state).
    const videoRecovering =
      this._videoHoldingForKeyframe ||
      !!this.videoDecoder?.isRecentlyRecovering?.();
    // Nothing left to fetch means nothing a downshift can fix. `draining`
    // already knows that; the absolute-low clause did not, and near the end of
    // a fully-downloaded file bufferAhead is small for the only reason it can
    // be — the video is ending. That read as a rung in trouble and dropped a
    // 2160p file to 360p three seconds before it finished, with the switch's
    // spinner over the last of the picture. The bytes were already on the
    // machine; there was no link to relieve.
    const bufferLow =
      !videoRecovering &&
      !nothingLeftToFetch &&
      ((draining && bufferAhead < 6) || (bufferAhead < 4 && settledSinceSwitch));
    if (
      (stalling || bufferLow) &&
      // Nothing left to fetch means the whole rung is already in hand, and a
      // downshift is a bandwidth remedy: there is no bandwidth problem to
      // remedy, and the lower rung would have to be fetched from scratch. A
      // stall here is the DECODER, not the link — that has its own downshift
      // (the software-ceiling branch above), which still fires and still drops
      // a rung the machine genuinely cannot decode. What this stops is a fully
      // buffered 4K walking down to 1080p and showing the viewer a worse
      // picture for no reason at all.
      !nothingLeftToFetch &&
      !postSeekSettling &&
      !postBackgroundSettling &&
      sinceSwitch > 5000 &&
      activeIdx >= 0 &&
      activeIdx < rungs.length - 1
    ) {
      // Drop to the highest rung the freshly-measured throughput sustains — once
      // the buffer is low the source IS actively downloading again, so its speed
      // is a real reading — but always at least one step down.
      const ns = (
        this.source as {
          getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
        } | null
      )?.getNetworkStats?.();
      const downBits = ((ns?.lastSpeed ?? ns?.currentSpeed ?? 0) || 0) * 8;
      // A soft bufferLow (not a hard stall) is only a real "can't sustain the
      // rung" signal when the source is ACTIVELY downloading and STILL can't
      // keep up. Two cases must HOLD the rung and just let it refill instead of
      // dropping quality:
      //   1) Coasting — the buffer filled up so the source paused fetching
      //      (currentSpeed ~0); the drain toward the buffer end is normal and it
      //      resumes on the SAME rung. This is the "1440p playing fine, buffer
      //      hit the end → keep buffering 1440p, don't drop" case.
      //   2) Live download already carries the rung (rate ≥ bitrate + margin).
      // Only an active-but-too-slow link, or a hard stall (playback actually
      // stopped, buffer truly empty), drops quality.
      const liveBits = (ns?.currentSpeed || 0) * 8;
      const currentRungBits = rungs[activeIdx].bandwidth || 0;
      if (!stalling) {
        if (liveBits <= 0) return; // coasting on a full buffer — it will refill
        if (currentRungBits > 0 && liveBits >= currentRungBits * 1.15) return;
      }
      // Default to the LOWEST rung: if the link can't sustain even the smallest
      // bitrate, jump straight there — its tiny file also preps fastest, so
      // playback resumes soonest (cascading one rung at a time means several slow
      // switches while the buffer sits empty). When some higher rung does fit the
      // measured rate, use the highest such rung instead.
      let target = rungs[rungs.length - 1];
      for (let i = activeIdx + 1; i < rungs.length; i++) {
        if ((rungs[i].bandwidth || 0) <= downBits) {
          target = rungs[i];
          break;
        }
      }
      // Penalize the rung we're leaving so the upshift path can't climb straight
      // back into it (or higher) on a transient spike. ESCALATE the hold each
      // repeat — a rung the link keeps failing to sustain gets 30s, then 1m, 2m,
      // … (capped) — so a borderline rung (throughput ≈ its bitrate) settles on
      // the lower one instead of ping-ponging every ~40s. Strikes decay after a
      // clean spell so an improved link still gets another shot.
      const leavingBw = rungs[activeIdx].bandwidth || 0;
      // The link just failed this rung, so the stored rate that opens the next
      // load must stop claiming it can carry it — see lowerLinkBps.
      lowerLinkBps(leavingBw);
      const prevStrike = this._abrDrainStrikes.get(leavingBw);
      const strikes =
        (prevStrike && now - prevStrike.at < MoviPlayer.ABR_STRIKE_DECAY_MS
          ? prevStrike.count
          : 0) + 1;
      this._abrDrainStrikes.set(leavingBw, { count: strikes, at: now });
      this._abrPenalizedBandwidth = leavingBw;
      this._abrPenaltyUntil = Math.max(
        this._abrPenaltyUntil,
        now +
          Math.min(
            MoviPlayer.ABR_PENALTY_MS * 2 ** (strikes - 1),
            MoviPlayer.ABR_PENALTY_MAX_MS,
          ),
      );
      Logger.info(
        TAG,
        `ABR downshift ${rungs[activeIdx].label || rungs[activeIdx].bandwidth} → ${target.label || target.bandwidth}: reason=${stalling ? "stall" : "bufferLow"}, bufferAhead=${bufferAhead.toFixed(1)}s, draining=${draining}, sinceSwitch=${(sinceSwitch / 1000).toFixed(0)}s`,
      );
      await this.abrCommit(target.url, now);
      return;
    }

    // Voluntary UPSHIFT holds for a cooldown after any switch so a single change
    // can't cascade into a rung-by-rung oscillation — the throughput estimate is
    // noisy right after a swap (it reflects the new file's fresh download).
    if (sinceSwitch < 12000) return;

    // And it holds until the CURRENT rung is comfortably carried. A switch is
    // not free: it opens a new file, and the cushion that made the old rung feel
    // safe does not come with it — the new rendition starts from nothing. So a
    // climb made while the buffer is thin or shrinking bets the whole playback
    // on an estimate, and on a marginal link that bet is what turns a video that
    // was playing into one that is buffering.
    //
    // A deep, steady buffer is the evidence that the link has room to spare;
    // without it, hold the rung and let it fill. Throughput alone is not enough
    // — it is a lagging average, and on a paced CDN stream it measures the
    // rung's own bitrate rather than the link's capacity.
    if (draining || bufferAhead < MoviPlayer.ABR_UPSHIFT_MIN_BUFFER_S) {
      // Make the candidate earn its confirmations again from a healthy buffer,
      // so a climb can't be assembled out of one good tick and one bad one.
      this._abrUpCandidate = "";
      this._abrUpConfirms = 0;
      return;
    }

    // Hold voluntary UPSHIFT while the tab is hidden. The video isn't rendered in
    // a background tab (its decode is skipped), so climbing to a higher rung just
    // burns bandwidth on a stream nobody can see — and the throughput estimate is
    // stale anyway, since sampleThroughput() rides the rAF UI loop, which the
    // browser throttles/stops when hidden. The protective downshift above still
    // runs off the download-range buffer signal (fed by the un-throttled
    // background timer), so audio stays safe on a degrading link. PiP is exempt —
    // there the video IS visible, so ABR should keep adapting normally.
    if (this.isBackgrounded && !this.isPiPActive) return;

    const netStats = (
      this.source as {
        getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
      } | null
    )?.getNetworkStats?.();
    // Prefer lastSpeed (the last measured rate, which survives idle) over
    // currentSpeed (0 once a small file finishes caching) so Auto keeps a real
    // estimate to size the rung from.
    const raw = netStats?.lastSpeed ?? netStats?.currentSpeed ?? 0;
    // EWMA-smooth the estimate so a single noisy reading doesn't drive a switch.
    if (raw > 0) {
      this._lastThroughputBps =
        this._lastThroughputBps > 0
          ? this._lastThroughputBps * 0.7 + raw * 0.3
          : raw;
    }
    const bps = this._lastThroughputBps;
    if (bps <= 0) {
      // No SUSTAINED measurement yet (playback just started on the smallest
      // rung). Do nothing — don't guess, don't probe a burst. sampleThroughput
      // builds the estimate off real playback within a couple of seconds, and
      // the next tick sizes the ramp from that honest number.
      return;
    }
    const throughputBits = bps * 8;

    // UPSHIFT — only to a higher rung that fits with a safety margin, and only
    // after it holds for two consecutive ticks so a lone spike (a cache-served
    // burst, one fast chunk) doesn't bounce quality up then straight back down.
    //
    // A deep, non-draining buffer means the download is PACING-limited, not
    // link-limited: the server (YouTube's CDN throttles each stream to roughly
    // its own bitrate once the opening burst is over) hands over exactly as much
    // as playback needs and no more. The sustained reading then measures the
    // rung's bitrate rather than the link, so it can only ever justify the next
    // rung up — which is how a connection doing 4 MB/s climbed 144p → 240p → …
    // one 12-second cooldown at a time and never arrived anywhere near the top.
    //
    // While the buffer is that healthy, the sustained number is a FLOOR, and the
    // range probe — a fresh request, served at burst speed — is the better
    // reading. It is still only used to size the CANDIDATE; the confirmation
    // below, the 0.85 margin, and the drain/penalty machinery all still apply, so
    // a rung the link can't really hold gets dropped again on its own.
    // 12s: comfortably above the 6s/4s marks the downshift path treats as
    // trouble, and low enough that a modest `buffersize` still reaches it.
    const paced = bufferAhead >= 12 && !draining;
    let sizingBits = throughputBits;
    if (
      paced &&
      this._lastProbeBits > 0 &&
      now - this._lastProbeAt < MoviPlayer.ABR_PROBE_FRESH_MS
    ) {
      sizingBits = Math.max(sizingBits, this._lastProbeBits);
    }
    let affordableBits = sizingBits * 0.85;
    // Never climb into a resolution this device has proven (twice) it can't
    // decode. The cap lives at module level (survives player recreates), so it
    // holds across every video this session — convert the capped heights to a
    // bandwidth ceiling here (higher resolution ⇒ higher bandwidth on any sane
    // ladder, so this also excludes anything above them).
    // Software decode caps the ladder on its own — see softwareDecodeCeiling.
    if (this.decodingOnCpu()) {
      const ceilingH = softwareDecodeCeiling(
        !!this.videoDecoder && !this.videoDecoder.isSoftware,
      );
      let swCapBits = Number.POSITIVE_INFINITY;
      for (const r of rungs) {
        if ((r.height ?? 0) > ceilingH && this.softwareCeilingApplies(r.codec)) {
          swCapBits = Math.min(swCapBits, r.bandwidth || Number.POSITIVE_INFINITY);
        }
      }
      if (swCapBits < Number.POSITIVE_INFINITY) {
        affordableBits = Math.min(affordableBits, swCapBits - 1);
      }
    }

    if (deviceDecodeBoundHeights.size > 0) {
      let heightCapBits = Number.POSITIVE_INFINITY;
      for (const r of rungs) {
        if (r.height != null && MoviPlayer.isDecodeBound(r.codec, r.height)) {
          heightCapBits = Math.min(
            heightCapBits,
            r.bandwidth || Number.POSITIVE_INFINITY,
          );
        }
      }
      if (heightCapBits < Number.POSITIVE_INFINITY) {
        affordableBits = Math.min(affordableBits, heightCapBits - 1);
      }
    }
    // Honour an active penalty: a rung that recently drained is off-limits (and
    // so is anything above it) until the hold window passes, so a bursty spike
    // can't re-upshift into the same rung that just failed. Cleared once expired.
    if (now < this._abrPenaltyUntil && this._abrPenalizedBandwidth > 0) {
      affordableBits = Math.min(affordableBits, this._abrPenalizedBandwidth - 1);
    } else if (this._abrPenaltyUntil !== 0 && now >= this._abrPenaltyUntil) {
      this._abrPenaltyUntil = 0;
      this._abrPenalizedBandwidth = 0;
    }
    let up = rungs[rungs.length - 1];
    for (const r of rungs) {
      if ((r.bandwidth || 0) <= affordableBits) {
        up = r;
        break;
      }
    }
    let upIdx = rungs.indexOf(up);
    if (activeIdx < 0) {
      // Current rung unknown (unseeded) — establish the affordable one at once.
      await this.abrCommit(up.url, now);
      return;
    }
    // Climb ONE rung at a time WHILE PLAYING. The estimate that sizes the jump
    // is measured against the rung currently playing, and on a small,
    // fully-cached one it reads like a much faster link than it is: a 144p file
    // that finished downloading reported 3.9Mbps and justified a leap to
    // 1080p60, which the link then couldn't hold — down again twelve seconds
    // later. Stepping makes each climb a cheap experiment the next tick can
    // confirm or undo, and the ladder walks up to the highest rung that holds
    // instead of swinging between the top and the bottom.
    //
    // PAUSED is the exception, and it is the one moment the estimate can be
    // trusted whole: nothing is being consumed, the buffer isn't racing a
    // deadline, and the download running underneath is measuring the link
    // rather than the rung's own pacing. Stepping there just means the viewer
    // presses play on a rung several steps below what their connection has
    // already demonstrated. The target probe below still has the final say.
    const paused = this.stateManager.getState() === "paused";
    if (!paused && upIdx < activeIdx - 1) {
      upIdx = activeIdx - 1;
      up = rungs[upIdx];
    }
    if (upIdx < activeIdx) {
      if (this._abrUpCandidate === up.url) {
        this._abrUpConfirms++;
      } else {
        this._abrUpCandidate = up.url;
        this._abrUpConfirms = 1;
      }
      // First upshift after enabling Auto commits at once (need 1); later ones
      // wait for 2 consecutive ticks so a lone spike can't bounce quality up.
      const need = this._abrPrimed ? 2 : 1;
      if (this._abrUpConfirms >= need) {
        // Confirm the upshift with a fresh probe of the TARGET rung — but the
        // probe can only make the decision MORE conservative, never less. Take
        // the MIN of the sustained estimate and the probe: through a caching/
        // buffering proxy the probe's first slice can read at cache speed (a
        // 600+ MB/s burst), so trusting it OVER the sustained estimate would
        // re-introduce the "jumped to 1080p on a slow link" bug. A genuinely
        // fast link reads fast on BOTH; a slow link stays gated by whichever is
        // lower. So the probe only ever catches a stale-high estimate, it can't
        // inflate a real one.
        // A candidate that keeps confirming gets probed every couple of ticks,
        // and each probe is 2.4MB of real download. When the last reading of
        // this rung is recent AND was short of what the rung needs, it already
        // has its answer — re-measuring can only spend bytes to hear it again,
        // and on a paused player it was doing so on repeat. Reused only in the
        // direction that REFUSES; a reading that would authorise a climb is
        // always re-taken, because that is the one the vote below exists for.
        const prior = this._rungProbeBits.get(up.url);
        const priorAge = prior ? now - prior.at : Number.POSITIVE_INFINITY;
        if (
          prior &&
          priorAge < MoviPlayer.ABR_PROBE_MIN_GAP_MS &&
          prior.bits * 0.85 < (up.bandwidth || 0)
        ) {
          this._abrUpCandidate = "";
          this._abrUpConfirms = 0;
          Logger.debug(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} held — ${(prior.bits / 1e6).toFixed(1)}Mbps measured ${((priorAge / 1000) | 0)}s ago still stands`,
          );
          return;
        }
        // Another probe already running is not a measurement of anything —
        // wait for the next tick rather than let the fallback decide. The
        // candidate and its confirmations stand.
        if (this._abrProbeInFlight) return;
        // Audio first. A probe is bandwidth spent on a BETTER picture, and the
        // split audio stream carries the thinnest buffer of the three things
        // sharing this link — so when it is already thin, taking a share for a
        // luxury is how a quality decision turns into a click in the speakers.
        // Held rather than decided around: nothing is lost by waiting, and
        // deciding without the probe is what hands the answer to a number
        // measured on the rung we are leaving.
        if (!this.disableAudio && !this.audioRenderer.hasHealthyBuffer()) {
          Logger.debug(
            TAG,
            "ABR upshift held — the audio buffer is thin, no bandwidth to spend on a probe",
          );
          return;
        }
        const rawProbeBits = await this.probeRungThroughput(up.url);
        // A rung gets probed again every time it comes up as a candidate, and
        // committing on the first reading that clears the bar is choosing the
        // best of N tries — which, with a variable link, is a near-certainty
        // given enough tries. This rung was read at 18.3, then 21.4, then
        // 30.6Mbps against a 25.9Mbps need, and the third reading — clearing by
        // 0.4% — is what put an 8K stream on screen that the link then could
        // not feed. The honest summary of those three numbers is "about 20".
        //
        // So a fresh earlier reading of the SAME rung has a vote, and the lower
        // one decides: two independent reads must agree before the ladder moves
        // into it. A link that genuinely improved says so on its next probe and
        // the climb costs one extra cycle; a spike says it once and is outvoted.
        const priorFresh =
          prior && priorAge < MoviPlayer.ABR_PROBE_FRESH_MS ? prior : null;
        let probeBits: number;
        if (rawProbeBits > 0) {
          probeBits = priorFresh
            ? Math.min(rawProbeBits, priorFresh.bits)
            : rawProbeBits;
          this._rungProbeBits.set(up.url, { bits: rawProbeBits, at: now });
          this._lastProbeBits = probeBits;
          this._lastProbeAt = now;
        } else if (priorFresh) {
          // A probe that returns nothing is "don't know", and don't-know must
          // not become yes. It used to: the fallback below hands the decision
          // to the sustained estimate, which is measured on the rung being
          // LEFT and, on a paused player, is stale on top of that. This rung
          // had been read twice at 24.7Mbps against a 25.9Mbps need and
          // refused both times; one unmeasurable probe later, a 52.3Mbps
          // number about another stream put 8K on screen. The readings we
          // already have are better evidence than a number about a different
          // file, and they stand until they go stale.
          probeBits = priorFresh.bits;
        } else {
          probeBits = rawProbeBits; // nothing known — the sustained estimate decides
        }
        // …except when the link is PACED, where "the sustained estimate" is not
        // an estimate of this rung at all.
        //
        // The branch above already refuses to let a don't-know become a yes
        // when there is an earlier reading to fall back on. With NO reading it
        // fell through to throughputBits, which is measured on the rung being
        // LEFT — and on a CDN that paces each stream to its own bitrate that is
        // a fact about a different file. Captured on an 8K ladder: the target
        // probe was thrown out as a cache hit ("1953KB in 18ms — cache or short
        // read, not the link"), and 72.9Mbps measured on the 2160p stream
        // authorised the climb into 4320p. Nothing had measured the 8K stream.
        //
        // Only in the paced case. Draining or on a thin buffer, throughputBits
        // is a real ceiling taken off a stream that is genuinely being pulled
        // as hard as it can be, so it still means something as a limit.
        if (paced && probeBits <= 0) {
          this._abrUpCandidate = "";
          this._abrUpConfirms = 0;
          Logger.info(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} held — nothing has measured that rung, and the ${(throughputBits / 1e6).toFixed(1)}Mbps we have is about the one we are on`,
          );
          return;
        }
        // MIN normally: with a shallow buffer the sustained number is a real
        // ceiling and the probe must not talk the estimate up past it.
        //
        // When paced, the probe DECIDES — it is no longer maxed against the
        // sustained rate. The sustained rate is measured on the rung being
        // LEFT, and on a CDN that paces each stream separately that is a fact
        // about a different file: the 2160p stream was feeding at 47Mbps while
        // the 8K stream it climbed into fed at 20, and the max let the first
        // number authorise the second. What the max was really for is the
        // paced under-read — a healthy buffer means the server feeds only as
        // fast as it needs to, so sustained is a floor and not a limit — and
        // the probe answers that directly now that it skips the opening burst.
        // Its verdict is about the rung being entered, which is the only rung
        // the question is about.
        const effectiveBits =
          probeBits > 0
            ? paced
              ? probeBits
              : Math.min(throughputBits, probeBits)
            : throughputBits;
        if (effectiveBits * 0.85 < (up.bandwidth || 0)) {
          // Can't sustain the higher rung — fold the tighter number into the
          // estimate and hold; the next tick re-decides on the truer value.
          //
          // Not in the paced case: there the number is a measurement of the
          // TARGET rung's stream, and writing it into the estimate that judges
          // the rung we are STAYING on would have one file's pacing argue for
          // downshifting another. The refusal above is the whole use for it.
          if (!(paced && probeBits > 0)) {
            this._lastThroughputBps = effectiveBits / 8;
          }
          this._abrUpCandidate = "";
          this._abrUpConfirms = 0;
          Logger.info(
            TAG,
            `ABR upshift to ${up.label || up.bandwidth} cancelled — ${(effectiveBits / 1e6).toFixed(1)}Mbps measured, rung needs ${((up.bandwidth || 0) / 1e6).toFixed(1)}Mbps`,
          );
          return;
        }
        // Last word before committing: a rung the CPU cannot hold is not a
        // candidate however fast the link is. The sizing cap earlier in this
        // tick works through BANDWIDTH, which is a proxy — a rung whose
        // bandwidth is missing or understated slips straight past it, and that
        // is how "ABR upshift 480p → 720p: 65.8Mbps" happened on a browser with
        // no WebCodecs, three seconds before "software decode can't hold 720p —
        // correcting to 480p" took it back. This reads the height itself.
        if (this.decodingOnCpu()) {
          const ceilingH = softwareDecodeCeiling(
            !!this.videoDecoder && !this.videoDecoder.isSoftware,
          );
          if (
            (up.height ?? 0) > ceilingH &&
            this.softwareCeilingApplies(up.codec)
          ) {
            this._abrUpCandidate = "";
            this._abrUpConfirms = 0;
            Logger.info(
              TAG,
              `ABR upshift to ${up.height}p refused — the CPU is decoding and can't hold past ${ceilingH}p`,
            );
            return;
          }
        }
        Logger.info(
          TAG,
          `ABR upshift ${rungs[activeIdx].label || rungs[activeIdx].bandwidth} → ${up.label || up.bandwidth}: ${(effectiveBits / 1e6).toFixed(1)}Mbps ${probeBits <= 0 ? "sustained" : rawProbeBits <= 0 ? "last reading of the target rung" : paced ? "probed on the target rung" : "sustained∧probed"}, bufferAhead=${bufferAhead.toFixed(1)}s`,
        );
        await this.abrCommit(up.url, now);
      }
      return;
    }

    // Current rung sits inside the hysteresis dead-zone — hold, and clear any
    // half-formed upshift streak.
    this._abrUpCandidate = "";
    this._abrUpConfirms = 0;
  }

  /**
   * Quick active speed test against a specific rung's file. Fetches a small
   * head slice and returns the measured throughput in BITS/s (or -1 if it can't
   * measure — a failure just falls back to the passive estimate).
   *
   * Probing the TARGET rung, not the current one, is the point: it's a file the
   * browser has never fetched, so it hits the network fresh rather than reading
   * a cache, and it directly answers "can the link carry THIS rung?". Only used
   * to gate an UPSHIFT — a downshift happens because the buffer is already
   * draining, and adding a probe fetch into a struggling link would only slow
   * the recovery, so downshift stays reactive.
   */
  /** Last usable range-probe reading, and when it was taken. Reused to size the
   *  upshift candidate while the buffer is deep — see the paced-link note in
   *  abrTick. */
  private _lastProbeBits = 0;
  private _lastProbeAt = 0;
  /** Last probe reading per rung URL — the second opinion an upshift needs
   *  before the ladder moves into that rung. See the vote in abrTick. */
  private _rungProbeBits = new Map<string, { bits: number; at: number }>();
  /** How long a probe reading stays fresh enough to size a candidate from. */
  private static readonly ABR_PROBE_FRESH_MS = 60_000;
  /** How long a rung's own refusal stands before it is worth spending another
   *  2.4MB to re-ask. Two ABR ticks and a little. */
  private static readonly ABR_PROBE_MIN_GAP_MS = 10_000;

  private async probeRungThroughput(url: string): Promise<number> {
    if (this._abrProbeInFlight || this._destroyed) return -1;
    this._abrProbeInFlight = true;
    // Time only what arrives AFTER the opening burst, the way the pre-play
    // probe does.
    //
    // Timing the whole slice measured the burst, and a CDN that paces a stream
    // to its own bitrate gives every stream the same generous opening — so the
    // probe answered "how fast does this server start?" and not "how fast does
    // it feed?". The two numbers were 2x apart on the same file, minutes apart:
    // the pre-play probe read the 8K rung at 22.3Mbps and passed it over as
    // unaffordable; this one read the identical URL at 41.8Mbps, climbed into
    // it, and the stream then fed at ~20Mbps until the buffer starved and the
    // rung was abandoned 13 seconds later. The pre-play number was right, and
    // it was right because of how it was measured.
    // Every byte here is a byte the video and the split AUDIO stream do not
    // get, on a link that is already the reason a switch is being considered.
    // The log shows it plainly: the video stream halves, from 6.2MB/s to
    // 3.6MB/s, for as long as a probe runs — and audio, which carries the
    // least buffer of the three, is what the viewer hears break. So the probe
    // takes the smallest sample that answers the question and then stops,
    // rather than downloading a fixed slice to the end.
    const BURST_BYTES = 800_000; // the opening gift — not the link
    const BURST_MS = 250; // …and a slow link should not have to fund all of it
    const TIMED_BYTES = 600_000; // enough to be a measurement
    const TIMED_MS = 500;
    const PROBE_BYTES = 2_000_000; // hard ceiling, rarely reached
    // Its own 6s cap AND the player's lifetime: a probe is up to 2MB of a link
    // the viewer may already have navigated away from, and the local controller
    // this used to build was invisible to destroy().
    const ctl = childAbort(this.lifetimeSignal);
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const startedAt = performance.now();
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${PROBE_BYTES - 1}`, ...(this.config.headers || {}) },
        // Ask the LINK, not the cache — the probe exists to measure the one and
        // the other cannot answer for it.
        //
        // Every probe reads the same opening range, so the first one put those
        // bytes in the HTTP cache and every probe after it was served from
        // there. The reading is then correctly thrown out ("cache or short
        // read, not the link"), which leaves the rung unmeasured, which is
        // exactly the state the paced guard below refuses to climb out of — so
        // it never climbs again. Seen on a 480p → 720p hold: "1953KB in 6ms"
        // thirteen times in a row, on a link that had probed at 79.5Mbps and a
        // buffer 349s deep. A ladder that can only ever step up once.
        //
        // `reload` bypasses the cache on the way out and still writes the
        // response back, so the bytes are there for the switch that follows.
        cache: "reload",
        signal: ctl.signal,
      });
      if ((!res.ok && res.status !== 206) || !res.body) {
        Logger.debug(TAG, `Rung probe: no body (HTTP ${res.status})`);
        return -1;
      }

      let total = 0;
      let timedBytes = 0;
      let timingStart = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.byteLength;
        const pastBurst =
          total > BURST_BYTES || performance.now() - startedAt > BURST_MS;
        if (pastBurst) {
          if (timingStart === 0) timingStart = performance.now();
          else timedBytes += value.byteLength;
        }
        // Enough of a sample. Everything after this would be bandwidth spent
        // to reach the same conclusion, so drop the connection and let the
        // streams that are actually feeding playback have it back.
        if (
          (timedBytes >= TIMED_BYTES &&
            performance.now() - timingStart >= 0.15 * 1000) ||
          (timingStart > 0 && performance.now() - timingStart >= TIMED_MS)
        ) {
          break;
        }
        if (total >= PROBE_BYTES) break;
      }
      try { await reader.cancel(); } catch {}
      if (this._destroyed) return -1;
      const totalSecs = (performance.now() - startedAt) / 1000;
      // A body that arrived faster than any link could deliver it came from a
      // cache, not the network — no measurement beats a fictional one.
      if (totalSecs < 0.03 || total < 262144) {
        Logger.debug(
          TAG,
          `Rung probe: ${(total / 1024) | 0}KB in ${(totalSecs * 1000) | 0}ms — cache or short read, not the link`,
        );
        return -1;
      }
      // The chunk that starts the clock isn't counted, so a body that arrived
      // in one piece past the burst leaves nothing to time. Fall back to the
      // whole slice — burst-inflated, but the alternative is no number at all.
      if (timedBytes === 0) {
        if (totalSecs >= 0.15) return (total / totalSecs) * 8;
        Logger.debug(TAG, `Rung probe: whole slice in ${(totalSecs * 1000) | 0}ms — too quick to time`);
        return -1;
      }
      const timedSecs = (performance.now() - timingStart) / 1000;
      if (timedSecs < 0.05) {
        Logger.debug(TAG, `Rung probe: only ${(timedSecs * 1000) | 0}ms past the burst — too short to time`);
        return -1;
      }
      return (timedBytes / timedSecs) * 8;
    } catch (e) {
      Logger.debug(TAG, `Rung probe failed: ${(e as Error)?.name || e}`);
      return -1;
    } finally {
      clearTimeout(timer);
      this._abrProbeInFlight = false;
    }
  }

  /** Perform an ABR switch and arm the anti-thrash cooldown/hysteresis. */
  private async abrCommit(url: string, now: number): Promise<void> {
    this._lastAbrSwitchAt = now;
    this._abrUpCandidate = "";
    this._abrUpConfirms = 0;
    this._abrPrimed = true; // subsequent upshifts use the 2-tick confirmation
    this._lastBufferAhead = 0; // buffer restarts from the resume point post-swap
    await this.abrSwitchTo(url);
  }

  private async abrSwitchTo(url: string): Promise<void> {
    this._abrSwitchInProgress = true;
    try {
      await this.switchVideoRenditionInPlace(url);
    } catch {
      /* keep the current rendition on failure */
    } finally {
      this._abrSwitchInProgress = false;
    }
  }

  /**
   * Relieve a DECODE/render bottleneck — the device can't sustain the CURRENT
   * rung's resolution even though the network is fine (buffer full, throughput
   * healthy), so frames are being dropped and playback stutters. The plain ABR
   * never sees this because it reads only network signals; this is driven off
   * the renderer's sustained frame-deficit detector instead. Drops ONE rung and
   * penalizes the one it leaves so the ABR won't climb straight back into a
   * resolution the device just proved it can't decode. A no-op unless Auto is on
   * and a lower rung exists — at the lowest rung (or with Auto off) the renderer's
   * FPS cap + software frame-skip remain the only levers. Re-fires naturally if
   * the lower rung is still too heavy: switchVideoRenditionInPlace reconfigures
   * the renderer, which re-arms its perf window for a fresh measurement.
   */
  /**
   * Ask the device, BEFORE climbing, whether it can actually play a rung.
   *
   * The reactive path learns a ceiling by climbing into a rung, stuttering for
   * a perf window or two, and dropping back out — so every machine that cannot
   * do 8K tries 8K, on a good connection, every time. MediaCapabilities answers
   * beforehand: decodingInfo() reports `smooth` (real-time) and
   * `powerEfficient` (hardware) for a codec at a resolution and frame rate.
   * A rung that isn't smooth here goes into the same ceiling the decode-bound
   * detector fills, so the ABR simply never offers it.
   *
   * Screened once per ladder, and only above 4K. Below that, software decode is
   * a legitimate option plenty of machines sustain, and screening it out would
   * cost quality on devices that were coping fine.
   *
   * Above it, three verdicts bar a rung: unsupported, not smooth, and NOT
   * powerEfficient. The last one matters because `smooth` is optimistic —
   * measured on a Mac, Chrome answers 8K AV1 with smooth:true even where
   * playback stutters, while 8K H.264 comes back powerEfficient:false. At that
   * size powerEfficient:false means a software decoder, and software 8K is not
   * real-time on anything. Whatever this misses, the decode-bound detector
   * still catches — once, now that the ceiling survives a reload.
   */
  private async screenRungsForDecodeCapability(
    rungs: {
      url: string;
      label?: string;
      height?: number;
      bandwidth?: number;
      codec?: string;
    }[],
  ): Promise<void> {
    await screenLadderForDecode(
      rungs,
      this.trackManager?.getActiveVideoTrack()?.frameRate || 30,
      this.videoDecoder?.configuredCodec || "",
      this.trackManager?.getActiveVideoTrack()?.height || 0,
      this._decodeScreened,
      MoviPlayer._isMobileDevice,
    );
  }

  private abrDeviceDownshift(): void {
    if (!this._autoQuality || this._abrSwitchInProgress) return;
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (rungs.length < 2) return;
    const activeIdx = rungs.findIndex((r) => r.url === this._activeDashRendition);
    if (activeIdx < 0 || activeIdx >= rungs.length - 1) return; // already lowest
    const now = performance.now();
    // Don't stack a device-downshift onto a just-made switch — the renderer needs
    // a fresh perf window on the new rung before the next decision is meaningful.
    if (now - this._lastAbrSwitchAt < 3000) return;
    const target = rungs[activeIdx + 1];
    const failing = rungs[activeIdx];
    const failingBw = failing.bandwidth || 0;
    this._abrPenalizedBandwidth = failingBw;
    // Cap this HEIGHT for the session on the FIRST decode-bound. The renderer
    // has already tried an FPS cap by now, so this means the device can't
    // sustain the resolution even at half rate — a device limit, not a
    // transient. Barring it (module-level, survives recreates) stops throughput
    // from re-climbing into it and re-stuttering (the log showed 4K re-tried 3×
    // before the old 2-fail cap engaged). Reload re-learns.
    const failH = failing.height ?? 0;
    const capped = failH > 0;
    if (capped) {
      const failCodec =
        this.videoDecoder?.configuredCodec || failing.codec || "";
      const failKey = decodeBoundKey(failCodec, failH);
      deviceDecodeBoundHeights.add(failKey);
      // What gets written down is the exact rung SHAPE, not the family at this
      // height — "8K AV1" is not one thing, and a machine that cannot hold a
      // 10-bit 8K rung may well hold an 8-bit one. The broad key still bars the
      // whole height for THIS SESSION, which is what stops the re-climb loop;
      // it just doesn't follow the device around forever. With no codec string
      // to be exact about there is nothing finer to say, so the broad key is
      // what persists, as before.
      const failExact = decodeBoundExactKey(failCodec, failH);
      if (failExact) {
        deviceDecodeBoundHeights.add(failExact);
        sessionOnlyDecodeBoundHeights.add(failKey);
      }
      // …but only WRITE IT DOWN if the hardware path was the one that failed.
      // A software-decoding session cannot hold 720p on a phone and says
      // nothing about what the GPU can do — yet this was persisted all the
      // same, and every later session (hardware, WebCodecs, prefer-hardware)
      // read it back and barred those rungs. Auto then sat at 480p on a link
      // measuring 29.7Mbps, permanently, with no way back short of clearing
      // storage. The in-memory bar still stands for THIS session, which is
      // what stops the re-climb-and-restutter loop.
      if (!this.isSoftwareDecoding()) {
        persistDecodeCeiling();
      } else {
        sessionOnlyDecodeBoundHeights.add(failKey);
        if (failExact) sessionOnlyDecodeBoundHeights.add(failExact);
        Logger.info(
          TAG,
          `ABR: ${failH}p barred for this session only — software decode failing says nothing about the hardware path`,
        );
      }
    }
    this._abrPenaltyUntil = Math.max(
      this._abrPenaltyUntil,
      now + MoviPlayer.ABR_DECODE_PENALTY_MS,
    );
    Logger.info(
      TAG,
      `ABR: device decode-bound at ${failing.label || failingBw + "bps"}${failH ? " (" + failH + "p)" : ""} — dropping to ${target.label || target.bandwidth + "bps"}${capped ? ` and capping ${failH}p+ for this session` : " to relieve stutter"}`,
    );
    void this.abrCommit(target.url, now);
  }

  /**
   * Last resort: the video has stopped moving under running audio and the
   * normal ABR hasn't rescued it. Bail out to the LOWEST rung immediately.
   *
   * Everything the ordinary downshift weighs — the 5s settle, the 12s cooldown,
   * "is the source coasting", the throughput estimate — exists to keep quality
   * from flapping on a healthy link. None of it applies once playback has
   * actually stopped: the rung has been disproven by the outcome, so this
   * skips the lot and goes straight to the bottom of the ladder, whose small
   * file also preps fastest.
   *
   * Retried once, because the failure that gets here is usually a flaky link
   * and the rescue's own open has to cross the same one — a single fumbled
   * size probe was enough to leave a real session frozen until the viewer
   * seeked by hand.
   *
   * Auto only. A rung the viewer picked by hand is their decision, and this
   * does not get to overrule it: if the link can't carry 1080p, a viewer who
   * asked for 1080p gets buffering, not a quality they didn't choose. (It used
   * to override the pick once playback stopped, on the grounds that a stalled
   * picture helps nobody. The choice is the viewer's to make and to change.)
   *
   * Returns the label of the rung it moved to, or null when there was nothing
   * to switch to (Auto off, no ladder, already lowest) — then the caller falls
   * back to its own recovery.
   */
  /**
   * How long the picture has been catching up to the sound, in ms — null when
   * it is not. The wait is normally under a tenth of a second, so the UI can
   * hold its spinner back for a moment rather than flashing one on every
   * return from a background tab.
   */
  videoCatchUpElapsedMs(): number | null {
    if (this._videoResumeTarget < 0) return null; // -1 none, -Infinity finished
    return performance.now() - this._videoCatchUpStartedAt;
  }

  /**
   * Milliseconds since a rendition switch last LANDED (Infinity if none has).
   * The picture is legitimately still for a moment after one — the queue was
   * emptied at the swap and the new decoder has not filled it yet — so the
   * element's frozen-video watchdog needs to know the difference between that
   * and a stall.
   */
  msSinceRenditionSwitch(): number {
    return performance.now() - this._lastAbrSwitchAt;
  }

  async abrEmergencyDownshift(reason: string): Promise<string | null> {
    if (!this._autoQuality || this._abrSwitchInProgress) return null;
    // A rung that was only just switched to has nothing buffered yet BY
    // DEFINITION — every switch starts a new file from zero. Rescuing that
    // state drops another rung, which starts another empty buffer, which looks
    // like starvation again: the log showed 480p → 360p → 240p in twelve
    // seconds, each step "rescuing" the refill of the step before. Give a fresh
    // rung the same settle the ordinary downshift gets.
    if (performance.now() - this._lastAbrSwitchAt < 10000) return null;
    // Same reasoning as the ordinary downshift: with the download finished
    // there is no link to relieve, so whatever froze the picture — decode, or
    // simply the end of the file — a lower rung cannot address it, and the
    // switch would cost a re-open and a spinner to prove that.
    if (this.nothingLeftToFetch()) return null;
    const rungs = this._dashRenditions
      .filter((r) => (r.bandwidth || 0) > 0)
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (rungs.length < 2) return null;
    const activeIdx = rungs.findIndex(
      (r) => r.url === this._activeDashRendition,
    );
    if (activeIdx < 0 || activeIdx >= rungs.length - 1) return null; // already lowest
    // Aim at what the link is actually delivering rather than diving straight to
    // the bottom: dropping a 4320p pick to 144p over one bad minute is its own
    // kind of broken. With no usable reading, the lowest rung is the safe
    // answer — its small file also preps fastest, so playback resumes soonest.
    const ns = (
      this.source as {
        getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
      } | null
    )?.getNetworkStats?.();
    // A frozen source often reports no live speed at all, and reading that as
    // "the link is dead" sent a 480p stall straight to 144p. The remembered
    // estimate is the better answer when there is no fresh one.
    const measuredBits =
      (((ns?.lastSpeed ?? ns?.currentSpeed ?? 0) || 0) ||
        this._lastThroughputBps) * 8;
    let target = rungs[rungs.length - 1];
    if (measuredBits > 0) {
      for (let i = activeIdx + 1; i < rungs.length; i++) {
        if ((rungs[i].bandwidth || 0) <= measuredBits * 0.8) {
          target = rungs[i];
          break;
        }
      }
    }
    const now = performance.now();
    // Bar the rung that stalled (and everything above it) from being climbed
    // back into on the next spike — it just proved it can't be sustained.
    const failingBw = rungs[activeIdx].bandwidth || 0;
    this._abrPenalizedBandwidth = failingBw;
    this._abrPenaltyUntil = Math.max(
      this._abrPenaltyUntil,
      now + MoviPlayer.ABR_PENALTY_MS * 2,
    );
    Logger.warn(
      TAG,
      `ABR emergency downshift (${reason}): ${rungs[activeIdx].label || failingBw} → ${target.label || target.bandwidth}`,
    );
    this._lastAbrSwitchAt = now;
    this._abrUpCandidate = "";
    this._abrUpConfirms = 0;
    this._lastBufferAhead = 0;
    this._abrSwitchInProgress = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (await this.switchVideoRenditionInPlace(target.url)) {
            return target.label || `${Math.round((target.bandwidth || 0) / 1000)}kbps`;
          }
        } catch {
          /* fall through to the retry */
        }
        if (this._destroyed) return null;
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      this._abrSwitchInProgress = false;
    }
    return null;
  }

  private async configureDecoders(): Promise<void> {
    if (!this.demuxer) return;

    // Configure video renderer/decoder
    const videoTrack = this.trackManager.getActiveVideoTrack();
    if (videoTrack && this.videoDecoder) {
      // Use WebCodecs - configure decoder
      const extradata = this.demuxer.getExtradata(videoTrack.id) ?? undefined;

      // Pass explicit frame rate override if present (for throttling)
      const targetFps = this.config.frameRate ?? 0;

      const configured = await this.videoDecoder.configure(
        videoTrack,
        extradata,
        targetFps,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Video decoder configured: ${videoTrack.codec} ${videoTrack.width}x${videoTrack.height}`,
        );
        // The ladder usually arrives BEFORE this (the quality menu hands it
        // over as soon as the element parses its <source> children), and the
        // capability screen needs the codec string, which only exists once the
        // decoder has been configured. Run it again now that it does.
        void this.screenRungsForDecodeCapability(this._dashRenditions);
        if (this.videoRenderer) {
          // Pass color space metadata for HDR detection and frame rate for 60fps conversion
          // Support manual frame rate override (fps parameter)
          const frameRate = this.config.frameRate || videoTrack.frameRate;

          this.videoRenderer.configure(
            videoTrack.width,
            videoTrack.height,
            videoTrack.colorPrimaries,
            videoTrack.colorTransfer,
            frameRate,
            videoTrack.rotation ?? 0,
            videoTrack.isHDR,
            videoTrack.pixelFormat,
          );
        }
      } else {
        Logger.warn(TAG, "Failed to configure video decoder");
      }
    }

    // Configure audio decoder (skip if disabled for debugging)
    // Configure audio decoder (skip if disabled for debugging or native audio)
    const audioTrack = this.trackManager.getActiveAudioTrack();
    // Skip the main-demuxer audio track when a split (separate-URL) audio demuxer
    // owns the audio — the audioDecoder is bound to the split demuxer instead.
    if (audioTrack && !this.disableAudio && !this.audioDemuxer) {
      const extradata = this.demuxer.getExtradata(audioTrack.id) ?? undefined;
      const configured = await this.audioDecoder.configure(
        audioTrack,
        extradata,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Audio decoder configured: ${audioTrack.codec} ${audioTrack.sampleRate}Hz ${audioTrack.channels}ch`,
        );
        // Pre-initialize AudioContext during load (created suspended, no audio plays).
        // Moves ~500ms creation cost from play() to load() for instant playback start.
        // init() no longer resumes — play() handles resume on user gesture.
        if (!this.disableAudio) {
          // Tell the renderer the source's rate BEFORE it builds the context.
          // The context is created once, at whatever rate it is given, and a
          // context that does not match the source resamples every buffer it
          // is handed — audibly, as periodic clicking, because each buffer is
          // resampled with its own filter state and the seams land at the
          // buffer boundaries. AudioRenderer already knows to ask for the
          // source rate; it just has to have been told what that is, and
          // init() is the last moment that is true.
          //
          // Only PlaybackController did this. Both paths here went straight to
          // init(), so _sourceSampleRate was still 0 and the context came up
          // at the device default — 48000 on Android against a 44100 source,
          // which is why the clicking was a mobile-only report. Desktop
          // Chrome usually opens its default context at 44100 and the mismatch
          // never arises.
          this.audioRenderer.configure(
            audioTrack.sampleRate,
            audioTrack.channels,
          );
          // Await so we can read destination.maxChannelCount synchronously
          // before deciding the downmix policy. Init is cheap; the
          // perf-sensitive bit (`resume`) is still gated on the user
          // gesture in play().
          await this.audioRenderer.init();
          // Preserve native channel layout when the device can drive
          // every plane (e.g. 7.1 over HDMI / DAC reporting
          // maxChannelCount=8). Otherwise leave the WASM downmix on
          // — FFmpeg's matrix is higher quality than Web Audio's
          // automatic "speakers" interpretation fallback.
          const sourceCh = audioTrack.channels ?? 2;
          const maxCh = this.audioRenderer.getMaxChannelCount();
          if (sourceCh > 2 && maxCh >= sourceCh) {
            Logger.info(
              TAG,
              `Multichannel passthrough: source ${sourceCh}ch, destination supports ${maxCh}ch`,
            );
            this.audioDecoder.setDownmix(false);
            this.audioRenderer.setOutputChannelCount(sourceCh);
          } else if (sourceCh > 2) {
            Logger.info(
              TAG,
              `Downmixing to stereo: source ${sourceCh}ch, destination caps at ${maxCh}ch`,
            );
          }
        }
      } else {
        Logger.warn(TAG, "Failed to configure audio decoder");
      }
    } else if (audioTrack && this.disableAudio) {
      Logger.info(TAG, "Audio processing disabled for debugging");
    }

    // Drop unused audio tracks from the demuxer read path (issue #11).
    this.applyStreamDiscard();

    // Configure subtitle decoder
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (subtitleTrack && this._customSubtitleRenderer) {
      // A host renderer owns subtitles — configure it and skip the internal path.
      await this._configureCustomSubtitleRenderer();
    } else if (subtitleTrack && this.subtitleDecoder) {
      const extradata =
        this.demuxer.getExtradata(subtitleTrack.id) ?? undefined;
      const configured = await this.subtitleDecoder.configure(
        subtitleTrack,
        extradata,
      );
      if (configured) {
        Logger.info(
          TAG,
          `Subtitle decoder configured: ${subtitleTrack.codec} (${subtitleTrack.subtitleType || "unknown"} type)`,
        );

        // Set up subtitle cue callback
        this.subtitleDecoder.setOnCue((cue) => {
          Logger.debug(
            TAG,
            `Subtitle cue received: "${cue.text?.substring(0, 30)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
          );
          // Update subtitle cues on video renderer
          if (this.videoRenderer) {
            // Get current cues and add/update this one
            // For simplicity, we'll just set a single cue for now
            // In a full implementation, we'd maintain a cue list
            Logger.debug(TAG, "Setting subtitle cue on video renderer");
            this.videoRenderer.setSubtitleCues([cue]);
          } else {
            Logger.warn(
              TAG,
              "Subtitle cue received but videoRenderer is null!",
            );
          }
        });

        // Set bindings (should already be set in load(), but set again to be safe)
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          this.subtitleDecoder.setBindings(bindings, false); // Don't auto-configure, we're configuring manually
        }
      } else {
        Logger.warn(
          TAG,
          `Failed to configure subtitle decoder for track ${subtitleTrack.id} (${subtitleTrack.codec}) - subtitles will not be displayed`,
        );
      }
    }
  }

  /**
   * Pre-read a small amount of media before reporting "ready" and stash the
   * packets for the normal demux loop to consume. On short videos the demux
   * burst can drain the file faster than the HTTP source delivers bytes,
   * tripping the stall detector the moment play() starts; reading ahead
   * gives the source layer more time to buffer bytes.
   *
   * We deliberately do NOT decode here — the video decoder's onFrame
   * callback drops frames whenever state !== "playing", and the audio
   * renderer starts AudioContext playback the moment samples arrive. Both
   * break if we decode during prebuffer.
   */
  private async prebuffer(): Promise<void> {
    if (!this.demuxer) return;

    const hasVideoTrack = !!this.trackManager.getActiveVideoTrack();
    const hasInFileAudio =
      !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;

    if (!hasVideoTrack && !hasInFileAudio) return;

    const startWall = performance.now();
    let videoPacketsStashed = 0;
    let audioDurationStashed = 0;
    let eof = false;

    const videoTargetMet = () =>
      !hasVideoTrack ||
      videoPacketsStashed >= MoviPlayer.PREBUFFER_VIDEO_FRAMES;
    const audioTargetMet = () =>
      !hasInFileAudio ||
      audioDurationStashed >= MoviPlayer.PREBUFFER_AUDIO_SECONDS;

    // Once audio has what it needs, keep looking for the video frames — but not
    // to the end of the packet budget. A file can interleave so much audio at
    // the head (two TrueHD tracks and PGS subtitles, in the case this was found
    // on) that chasing a second video frame stashes hundreds of audio packets,
    // and every one of them has to be chewed through before playback reads
    // anything new. Past this point the pipeline is better off starting and
    // letting the normal read loop find the rest.
    // Stash size at the moment audio was satisfied; the video search gets a
    // bounded number of packets beyond it.
    let audioMetAt = -1;
    const packetBudget = () => {
      if (audioMetAt < 0 && audioTargetMet()) {
        audioMetAt = this.pendingPrebufferPackets.length;
      }
      return audioMetAt < 0
        ? MoviPlayer.PREBUFFER_MAX_PACKETS
        : Math.min(
            MoviPlayer.PREBUFFER_MAX_PACKETS,
            audioMetAt + MoviPlayer.PREBUFFER_VIDEO_SEARCH_PACKETS,
          );
    };
    while (
      (!videoTargetMet() || !audioTargetMet()) &&
      !eof &&
      this.pendingPrebufferPackets.length < packetBudget()
    ) {
      if (performance.now() - startWall > MoviPlayer.PREBUFFER_MAX_WALL_MS) {
        Logger.warn(
          TAG,
          `Prebuffer wall-clock timeout after ${MoviPlayer.PREBUFFER_MAX_WALL_MS}ms`,
        );
        break;
      }

      let packet: Packet | null;
      try {
        packet = await this.demuxer.readPacket();
      } catch (err) {
        Logger.warn(TAG, "Prebuffer demux error, aborting prebuffer", err);
        break;
      }

      if (!packet) {
        eof = true;
        break;
      }

      this.pendingPrebufferPackets.push(packet);

      if (!this.trackManager.isActiveStream(packet.streamIndex)) continue;

      const activeVideo = this.trackManager.getActiveVideoTrack();
      const activeAudio = this.trackManager.getActiveAudioTrack();

      if (
        hasVideoTrack &&
        activeVideo &&
        activeVideo.id === packet.streamIndex
      ) {
        videoPacketsStashed++;
      } else if (
        hasInFileAudio &&
        activeAudio &&
        activeAudio.id === packet.streamIndex
      ) {
        audioDurationStashed += packet.duration > 0 ? packet.duration : 0.02;
      }
    }

    Logger.info(
      TAG,
      `Prebuffer complete: stashed=${this.pendingPrebufferPackets.length}, video=${videoPacketsStashed}, audio=${audioDurationStashed.toFixed(2)}s, eof=${eof}`,
    );
  }

  /**
   * Start playback
   */
  async play(): Promise<void> {
    if (this.streamWrapper) {
      return this.streamWrapper.play();
    }

    // Stop pause-time buffering — we're resuming active playback
    this.stopPauseBuffering();

    // Fallback stamp for callers that drive playback without going through
    // load() — normally load() sets this. Lets ABR tell "the buffer hasn't
    // filled yet" apart from "this rung can't be sustained".
    if (this._playbackStartedAt === Number.NEGATIVE_INFINITY) {
      this._playbackStartedAt = performance.now();
    }

    if (!this.stateManager.canPlay()) {
      Logger.warn(TAG, "Cannot play in current state");
      return;
    }

    const currentState = this.stateManager.getState();

    // During buffering or seeking, mark intent to resume when ready
    if (currentState === "buffering" || currentState === "seeking") {
      this.wasPlayingBeforeRebuffer = true;
      Logger.info(TAG, `Play requested during ${currentState} — will resume when ready`);
      return;
    }

    const wasEnded = currentState === "ended";

    // Replay path: delegate to seek(0). The full seek pipeline runs flush +
    // demuxer.seek + waitingForVideoSync + keyframe wait, and on first frame
    // notifySeekCompletion syncs the clock to the actual first decodable PTS
    // (matters for Open-GOP sources where the first ~2s have no usable IDR —
    // without this the clock advances from startTime while video stays
    // frozen, so EOF fires ~2s early and no buffering UI is shown). Setting
    // wasPlayingBeforeSeek after the await flips the resume path so the
    // seek completion transitions straight to "playing".
    if (wasEnded && this.demuxer) {
      Logger.debug(TAG, "Replaying from beginning after ended state");
      // This branch serves a manual replay too — pressing play on a finished
      // file. Only a looping one is a loop.
      if (this._loopEnabled) this.noteLoopTurn();
      this.requestWakeLock();
      // Set the resume intent BEFORE awaiting seek(0). Replay data is always
      // already buffered, so notifySeekCompletion can fire synchronously
      // inside the await — if wasPlayingBeforeSeek is still false at that
      // point, seek completion takes the "paused" branch and replay stalls at
      // the first frame instead of resuming. seek() itself derives
      // wasPlayingBeforeSeek from the entry state ("ended" → false), which is
      // why we must force it true here up front rather than after the await.
      this.wasPlayingBeforeSeek = true;
      // Re-arm the play grace so the stall/desync detectors don't fire on the
      // replay-seek transient. Right after "Replaying from beginning" the video
      // renderer's currentTime is still stale at the ended position (~duration)
      // while audio resets to 0 — without a fresh grace the desync detector sees
      // a ~full-duration "behind" and kicks off a spurious resync seek (an
      // audible trip at the start of every replay).
      this._playStartTime = performance.now();
      // The replay seek(0) flushes the audio decoder like any seek, so heavy
      // software audio (TrueHD/DTS) re-primes automatically via the seek-resume
      // path — no separate first-play re-arm needed. Codec-gated, so
      // hardware/lightweight audio replays stay instant.
      try {
        await this.seek(0, { suppressSpinner: true });
      } catch (error) {
        this.suppressSeekSpinner = false;
        this.wasPlayingBeforeSeek = false;
        Logger.warn(TAG, "Failed to seek to start on replay", error);
      }
      return;
    }
    // If resuming from paused state, seek to current time to ensure demuxer is at correct position

    // Fire-and-forget WakeLock (no need to block play for screen sleep prevention)
    this.requestWakeLock();

    // First play after poster seek: re-seek demuxer to the clock's current
    // time. Poster seek's processLoop reads the demuxer ahead (~1s) while
    // decoding the first video frame, so the demuxer cursor is out of sync
    // with where we actually want playback to start. Re-seeking realigns it.
    //
    // IMPORTANT: respect any user seek that happened before the first play —
    // read the target from the clock (which getTime() reports as paused or
    // seeked position), NOT the hardcoded startTime. Previously we always
    // seeked to startTime here, which silently discarded a pre-play scrub
    // and restarted from the beginning.
    // Guard: only treat this as the first play when the clock is still parked
    // at the start. _playStartTime is the primary signal, but if anything ever
    // leaves it at 0 mid-session, this stops the first-play seek(0) from
    // dragging an in-progress video (clock well past startTime) back to zero.
    const atStart =
      this.clock.getTime() <= this.startTime + 1;
    if (this._playStartTime === 0 && atStart && this.demuxer) {
      // First play: always seek to 0. The poster seek's processLoop reads the
      // demuxer ~1s ahead while decoding the first video frame, so the cursor
      // is out of sync with the start. Re-seeking to 0 realigns it so playback
      // begins cleanly from the beginning. The full seek pipeline runs
      // waitingForVideoSync + keyframe wait and notifySeekCompletion syncs the
      // clock to the actual first decodable PTS — same path as replay, so
      // buffering UI, A/V sync and EOF timing all behave identically.
      // Set wasPlayingBeforeSeek BEFORE the await: seek() enters from the
      // "paused" state and would otherwise derive it as false, so a fast
      // (already-buffered) completion firing inside the await would take the
      // paused branch and stall instead of starting playback. seek()'s
      // re-derivation now skips when this is already true.
      const uiTarget = 0;
      this.wasPlayingBeforeSeek = true;
      try {
        // Realigning the demuxer after the poster seek is housekeeping, not a
        // seek anybody asked for: pressing play on a fresh element reports no
        // seeking/seeked at all, and this one used to make it look as though
        // the viewer had scrubbed before playback began. (The replay-from-ended
        // seek above stays audible — an element genuinely does report that
        // one.)
        await this.seek(uiTarget, { suppressSpinner: true, internal: true });
        this._playStartTime = performance.now();
      } catch (error) {
        this.suppressSeekSpinner = false;
        this.wasPlayingBeforeSeek = false;
        Logger.warn(TAG, "First-play seek failed", error);
      }
      return;
    }

    // Two ways into the same realignment, for one reason: the demuxer cursor
    // is ahead of the picture on screen.
    //
    // The first play after the poster seek is the long-standing one. A seek
    // that settled while PAUSED leaves it in exactly the same state — the hunt
    // for the target frame reads ahead, the frames behind it are dropped, and
    // resuming from pause used to pick up wherever the cursor stopped. That is
    // the picture jumping forward the instant play is pressed after scrubbing
    // paused: measured at 2.5s on a 1080p source, and it never healed, because
    // the clock carried on from the target while the frames arriving were from
    // 2.5s later. See _demuxerAheadOfClock.
    // …but only when the frames that cover the gap are actually gone. A click
    // on the seek bar pauses for the drag, so its seek settles paused and sets
    // the flag too — and play() follows it within a few tens of milliseconds,
    // while that seek's own frames are still queued. Rewinding there threw them
    // away and left the PREVIOUS position on screen for ~240ms before snapping.
    // See pictureCanResumeFromClock.
    const rewindForPausedSeek =
      this._demuxerAheadOfClock && !this.pictureCanResumeFromClock();
    if ((this._playStartTime === 0 || rewindForPausedSeek) && this.demuxer) {
      const targetTime = this.clock.getTime();
      // Said out loud, because its absence is invisible: when this does NOT run
      // the only symptom is a picture that holds still for as long as the gap,
      // with nothing else in the log to explain it.
      Logger.info(
        TAG,
        `Realigning the demuxer to the clock at ${targetTime.toFixed(3)}s before first play`,
      );
      this._demuxerAheadOfClock = false;

      // Flush the decode pipeline before re-seeking the demuxer. The
      // poster seek's processLoop bursts ~40 packets per rAF, racing the
      // demuxer cursor ahead of pts=0 while it hunts for the first video
      // frame. Without a flush + audio reset here, the first audio packet
      // that surfaces after demuxer.seek(targetTime) can land at a stale
      // interleaved PTS (e.g. 2.6s), anchoring firstBufferMediaTime there
      // and forcing video to skip ahead to catch up — the first-play
      // stutter. Mirrors the replay path which flushes + resets first.
      await this.videoDecoder.flush();
      this.dropVideoReadAhead();
      await this.audioDecoder.flush();
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      this.audioRenderer.reset();

      // Seek the demuxer first; only after it completes do we resume the
      // audio context. Running them concurrently let the audio renderer
      // accept the very first decoded packet before the demuxer cursor
      // had finished rewinding.
      //
      // Guard the seek: the demuxer rejects with "error -1" when the source
      // opened in a degenerate state (e.g. a non-faststart file whose prebuffer
      // hit EOF with zero frames, or a rapid source-switch that tore down the
      // read path mid-open). Unguarded, it escaped as an uncaught rejection —
      // and with the caller re-issuing play() it spammed/looped. Bail cleanly
      // and mark the source unplayable so the UI can show the broken state
      // instead of retrying a seek that can never succeed.
      try {
        await this.demuxer.seek(targetTime);
      } catch (error) {
        Logger.error(TAG, "Demuxer realignment seek on play failed", error);
        this.wasPlayingBeforeSeek = false;
        this.suppressSeekSpinner = false;
        this.stateManager.setState("error");
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // After Open-GOP recovery (decoder rejected the first keyframe past
      // the seek target and reset), the next decoded frames will begin at
      // the previous GOP's keyframe — often 1-2s behind targetTime. Without
      // the seekTargetTime guard those pre-target frames get presented and
      // video lags audio for the rest of the GOP. Re-arm only the filter
      // (not waitingForVideoSync) — onFrame's pre-target drop check at the
      // top of the handler reads seekTargetTime alone, while leaving
      // waitingForVideoSync false keeps notifySeekCompletion from firing
      // and clobbering the state machine that play() is about to drive
      // into "playing" right below.
      this.seekTargetTime = targetTime;
      if (!this.disableAudio) {
        await this.audioRenderer.play();
      }
      this.clock.seek(targetTime);
      this.pendingAudioPackets = [];
      // Discard pause-time buffered packets — demuxer was just re-seeked,
      // so stashed packets are stale (would feed later timestamps into the
      // decoder, making first frame jump ahead instead of starting at targetTime).
      this.pendingPrebufferPackets = [];
      this.dropVideoReadAhead();
      this.eofReached = false;
      this._eofPictureDrainSince = 0;
    this._eofFlushRequested = false;
      this.eofSince = 0;
    } else {
      // Resume from pause — just resume AudioContext
      //
      // Reached with the flag still set when the queued frames cover the gap,
      // and playback is about to run straight out of them. Clear it: the
      // cursor being ahead has now been paid for, and leaving it armed would
      // make the NEXT plain pause → play rewind for a seek long since resumed.
      this._demuxerAheadOfClock = false;
      if (!this.disableAudio) {
        await this.audioRenderer.play();
      } else {
        Logger.debug(TAG, "Audio playback skipped (disabled for debugging)");
      }

      // Drop frames left in the queue that are stale relative to the clock.
      // This handles the rapid open→play→fullscreen→track-toggle case where
      // a decoder reset (Open GOP) re-decodes from an earlier reference
      // frame, leaves those frames queued during pause, and then presents
      // them on resume — causing a multi-second video lag behind audio.
      if (this.videoRenderer) {
        this.videoRenderer.dropStaleFrames(this.clock.getTime(), 0.2);
      }
    }

    // Start video presentation loop for smooth 60Hz playback
    if (this.videoRenderer) {
      this.videoRenderer.startPresentationLoop();
    }

    this.clock.start();
    this._playStartTime = performance.now();

    // Transition to playing state
    // At this point, state should be 'ready', 'paused', or 'seeking' (never 'ended' as it's handled above)
    const stateForPlay = this.stateManager.getState();
    if (
      stateForPlay === "ready" ||
      stateForPlay === "paused" ||
      stateForPlay === "seeking"
    ) {
      // Arrived — the state itself carries the queue open from here.
      this._resumeToPlayPending = false;
      if (!this.stateManager.setState("playing")) {
        Logger.error(
          TAG,
          `Failed to transition to playing from state: ${stateForPlay}`,
        );
        this.clock.pause();
        return;
      }
    } else if (stateForPlay !== "playing") {
      Logger.error(
        TAG,
        `Cannot transition to playing from state: ${stateForPlay}`,
      );
      this.clock.pause();
      return;
    }
    // Already playing is not a failure — it is this call's own goal, reached
    // by something else while we were awaiting above.
    //
    // play() is async and everything between the entry check and here can
    // yield: resuming the AudioContext, a first-play re-seek, a decoder flush.
    // A seek completing in that window resumes playback itself, so this call
    // comes back to a state it was on its way to setting. canPlay() bars
    // "playing" at the door, so this can only ever be that race.
    //
    // It used to fall into the branch above, which logs an error and PAUSES
    // THE CLOCK — undoing the playback that had just started. Read off a
    // Safari session's unmute, where the tap runs an audio resync seek and a
    // play() together: "Cannot transition to playing from state: playing",
    // then "Clock: Paused at 0.00026s", and the only reason it survived is
    // that the unmute re-seeks immediately afterwards and starts it again.
    // Nothing to transition, nothing to undo: fall through to the loops.

    // Start demux loop
    // Cancel any existing animation frame to prevent duplicates
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Resuming while the tab is hidden (e.g. a Media Session / lock-screen play,
    // or a media-key press with the tab in the background): the rAF-driven
    // processLoop is throttled to ~1fps in background tabs, so decode falls
    // behind and audio starves and stops within seconds. Drive decode off the
    // un-throttled background Worker timer instead — pause() tore it down, and
    // if the tab was hidden while already paused it was never started. Mirror
    // the hide path's setup (drop video presentation; frames are discarded while
    // hidden anyway). Gated on audio, matching handleVisibilityChange — a
    // no-audio hidden source would just race the demuxer to EOF.
    const resumingHidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      !this.isPiPActive;
    if (resumingHidden) {
      this.isBackgrounded = true;
      if (this.videoRenderer) {
        this.videoRenderer.stopPresentationLoop();
        this.videoRenderer.clearQueue();
      }
      this.ensureBackgroundPump();
    }

    // In WASM split audio-only mode the main (video) demux loop stays parked —
    // resuming it would re-download + decode the video body we're saving. Only
    // the audio loop runs. (Muxed audio-only DOES run processLoop, whose own
    // _audioOnly check skips just the video decode while decoding in-file
    // audio.)
    if (!(this._audioOnly && this.audioDemuxer)) {
      this.processLoop();
    }
    this.startAudioLoop();

    Logger.info(TAG, "Playing");
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.streamWrapper) {
      this.streamWrapper.pause();
      return;
    }

    // A pause ends whatever a seek was still working through, including the
    // spinner suppression its own re-prime buffering holds (see
    // notifySeekCompletion). Left latched, a genuine stall much later would
    // show no spinner at all.
    this.suppressSeekSpinner = false;
    // A pause lands on top of a resume that had not arrived yet — the viewer
    // changed their mind mid-flight. Nothing is resuming any more.
    this._resumeToPlayPending = false;

    if (!this.stateManager.canPause()) {
      Logger.warn(TAG, "Cannot pause in current state");
      return;
    }

    // Pause requested while a seek is still in flight. The seek owns the state
    // machine until it completes, so we do NOT force "paused" here — that would
    // race handleSeekComplete's own final-state transition. Instead drop the
    // resume intent, which lands the seek in its "Seek completed in paused
    // state" branch, and stop the output side immediately so the tap feels
    // instant. Without this the pause was silently dropped ("Cannot pause in
    // current state") and playback resumed on its own once the seek landed —
    // wide open on a software-decoded phone, where seeks run for seconds and
    // the frozen picture reads as "already paused".
    if (this.stateManager.getState() === "seeking") {
      this.wasPlayingBeforeSeek = false;
      this.wasPlayingBeforeRebuffer = false;
      this._seekResumeQueueWait = false;
      this.releaseWakeLock();
      this.clock.pause();
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
      this.stopBackgroundTimer();
      Logger.info(TAG, "Paused during seek — seek will settle into paused");
      return;
    }

    // During buffering, transition to paused and stop auto-resume
    if (this.stateManager.getState() === "buffering") {
      this.wasPlayingBeforeRebuffer = false;
      this._seekResumeQueueWait = false;
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
      this.stateManager.setState("paused");
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.stopBackgroundTimer();
      this.startPauseBuffering();
      Logger.info(TAG, "Paused during buffering");
      return;
    }

    // Release WakeLock when pausing
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }

    // Stop video presentation loop
    if (this.videoRenderer) {
      this.videoRenderer.stopPresentationLoop();
    }

    this.stateManager.setState("paused");

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.stopBackgroundTimer();

    // Continue buffering ahead while paused (YouTube-like behavior)
    this.startPauseBuffering();

    Logger.info(TAG, "Paused");
  }

  /**
   * Flag to prevent concurrent async WASM operations
   */
  private demuxInFlight = false;
  private demuxInFlightStartTime: number = 0;
  /**
   * The DTS of the last video packet handed to the decoder, and the marks a
   * muxed rate-change rewind leaves behind: re-read video up to that DTS has
   * already been decoded and is dropped, audio before the rewind target is a
   * fraction of a second the renderer has just been reset past. DTS rather
   * than PTS because the demuxer delivers in decode order, and re-delivers the
   * identical sequence — so resuming at the packet after the last one fed
   * leaves the decoder's reference chain exactly as it was.
   */
  private _lastFedVideoDts = -1;
  /** Decoded picture, in seconds at the new rate, that makes an audio-only rewind safe. */
  private static readonly REWIND_PICTURE_CUSHION_S = 0.8;
  // How full the renderer queue has to be, as a fraction of its own cap, to
  // count as "this is all the picture there is going to be" — see
  // hasPictureToCarryARewind(). Not 1.0: the queue drains between decodes, so
  // it sits a few frames under the cap in normal steady playback.
  private static readonly REWIND_QUEUE_AT_CAP_FRACTION = 0.7;
  // How far past its own target the audio buffer may be pushed by the demux
  // loop's carve-outs before the plain cap applies again. See the ceiling in
  // processLoop.
  private static readonly AUDIO_CARVEOUT_MAX_MULT = 3;
  private _rewindVideoUntilDts = -1;
  private _rewindAudioFrom = -1;
  // The rewind's audio floor is only PROVISIONAL until the first audio packet
  // comes back: see the gate in the demux loop for why it has to be re-read
  // there rather than trusted from where it was armed.
  private _rewindAudioFloorPending = false;
  private static readonly DEMUX_TIMEOUT = 35000; // 35 seconds timeout (slightly more than HTTP timeout of 30s)
  // ===== Gapless loop =====
  //
  // A loop used to be an ending followed by a beginning: handleEnded() stopped
  // the clock and the presentation loop, the element heard "ended" and called
  // play(), and play() ran the whole replay-from-ended seek — flush the
  // decoders, clear the queue, seek the demuxer, wait for a keyframe, wait
  // again for the queue to reach its cushion. Measured end to end on an 8s
  // 1080p60 file: 71ms from the last frame of one pass to the first of the
  // next, with the picture frozen for all of it. 20ms of that is the first
  // frame decoding, 28ms is the cushion the seek path waits for, and both are
  // buying something — there was nothing in it to simply delete.
  //
  // So do the work early instead. When the demuxer hits EOF the tail is
  // already read, and once the decoder has emitted it the decoder is idle too
  // — while the renderer still holds a second or more of picture to play. That
  // window is free, and it is enough to seek back to the start and decode the
  // opening of the file into a holding array. Nothing is flushed: frame 0 is
  // an IDR, which a decoder accepts at any time.
  //
  // The pass turns over when the outgoing queue finally empties: the primed
  // frames go in, the clock wraps, and the sound — which was never stopped —
  // keeps being scheduled where the last pass left off (see beginLoopPass).
  private _loopEnabled = false;
  /** Turns this source has come back round, from 1. Reset when the source is. */
  private _loopCount = 0;
  private _loopPrerolling = false;
  private _loopPrerollFrames: VideoFrame[] = [];
  /** This pass turns over on the SOUND's seam, not the picture's — see
   *  maybeCompleteLoopWrap. */
  private _loopWithSound = false;
  /** When the sound first ran dry with the seam still not reached, or 0. */
  private _loopSeamDrySince = 0;
  /** How long the sound may sit empty with no new pass in it before the
   *  picture turns over without it. */
  private static readonly LOOP_SEAM_DRY_MS = 500;
  /** Enough to cover the handover; a cap because these are DECODED frames and
   *  an 8K one is tens of megabytes of VRAM apiece. */
  private static readonly LOOP_PREROLL_MAX_FRAMES = 60;

  private eofReached = false;
  // Wall-clock time (performance.now) when eofReached first flipped true.
  // Used as a watchdog: if the normal drained-and-played-out conditions
  // never all line up (e.g. a marginal float mismatch between the audio
  // playout head and the last video frame), force the ended transition
  // rather than freezing one frame short of the end forever.
  private eofSince = 0;

  /**
   * Route a decoded audio frame to the renderer, dropping any that predate the
   * active seek target. FFmpeg seeks to the keyframe BEFORE the target, so it
   * decodes pre-target packets, and a seek-flush can emit an in-flight frame
   * from the OLD position — both would let the renderer sync the clock back to
   * where playback was, which reads as "the first seek jumped back and audio
   * stopped" (a second seek then works because the pipeline is clean). The
   * demux-level skip in pumpSplitAudio only catches packets read after the
   * seek, not frames already in the decoder pipeline; this catches those.
   * Mirrors the video onFrame guard.
   */
  private renderDecodedAudio(data: AudioData): void {
    if (
      this.seekTargetTime !== -1 &&
      data.timestamp / 1_000_000 < this.seekTargetTime
    ) {
      try {
        data.close();
      } catch {
        /* ignore */
      }
      return;
    }
    this.audioRenderer.render(data);
  }

  /**
   * Internal handler for seek completion when first target frame is found.
   * Clears the seek flag, synchronizes clock, and transitions to final state.
   */
  /**
   * True when the playhead has reached the stretch of the file that has audio
   * but no video (see _videoTailStart). Callers ask this before treating an
   * empty video queue as a stall: past here the queue is empty because the
   * video track ENDED, so the right behaviour is the native one — hold the
   * last frame and let the sound play on to the end of the file.
   */
  private isInAudioOnlyTail(at: number = this.clock.getTime()): boolean {
    if (!Number.isFinite(this._videoTailStart)) return false;
    // No video track at all is a different thing entirely (a music file, a
    // data-saver rendition); those paths already skip the picture on purpose.
    if (!this.trackManager.getActiveVideoTrack()) return false;
    return at >= this._videoTailStart - 0.05;
  }

  /**
   * The mirror: true once the playhead has reached the stretch that has video
   * but no audio (see _audioTailStart). Callers ask this before treating an
   * empty audio buffer as a shortfall — past here it is empty because the
   * track ENDED, and the right behaviour is to let the picture play on to the
   * end of the file.
   */
  isInVideoOnlyTail(at: number = this.clock.getTime()): boolean {
    if (!Number.isFinite(this._audioTailStart)) return false;
    if (!this.trackManager.getActiveAudioTrack()) return false;
    return at >= this._audioTailStart - 0.05;
  }

  /**
   * Is there no sound left to wait for here?
   *
   * `isInVideoOnlyTail()` answers from `_audioTailStart`, and that is LEARNED —
   * at EOF, or from a container that declares per-track durations, which the
   * MKV this was measured on does not. On a source that has just loaded,
   * nothing has been learned yet, so a seek straight into a stretch with no
   * audio reads as "sound is on its way" and anything waiting for a cushion
   * waits for good. Measured on the 243.8s file whose Opus ends at 193.4s:
   * load it and seek to 194, 200, 220 or 240 and it sat in `buffering` with the
   * spinner up and the clock frozen — indefinitely, with 130 frames decoded and
   * queued behind it. Play the same file THROUGH the handover first and the
   * same seeks are fine, because by then the tail is known.
   *
   * So ask the demuxer's own read as well. A long run of video packets with no
   * audio between them means the sound has stopped in the file: audio packets
   * outnumber video ones on any ordinary interleave, and the bar is the
   * read-ahead bound, which is the deepest a healthy pipeline ever runs video
   * ahead of the audio buried in it.
   *
   * NOT for the starve verdict in processLoop. Standing that down early was
   * tried twice and breaks the tail handover outright — see `soundIsOver`
   * there, which stays on the settled-at-EOF signals on purpose.
   */
  private noSoundLeftToWaitFor(): boolean {
    if (this.isInVideoOnlyTail()) return true;
    if (this.audioRenderer.isStreamEnded()) return true;
    // Split audio is decoded by its own loop and never touches these cursors,
    // so they read "no audio" on every split source, permanently.
    if (this.audioDemuxer) return false;
    // The count alone, deliberately — NOT "and we have seen an audio packet".
    // Both cursors reset on a seek, and a seek INTO the tail is precisely the
    // case where none will ever arrive, so requiring one first is requiring the
    // thing whose absence is the answer. The bar is the read-ahead bound
    // because that is the deepest a healthy pipeline ever runs video ahead of
    // the audio buried in it; below that a long run of video is ordinary.
    if (this._videoPacketsSinceAudio >= MoviPlayer.VIDEO_AHEAD_MAX_PACKETS) {
      return true;
    }
    // …or the loop has read everything it is allowed to and still found none.
    // Backpressure parks the demuxer once the picture is buffered to its cap,
    // so on a seek into a stretch with no sound the run above STOPS GROWING —
    // measured at 141 packets against a 180 bar, waiting on a count that the
    // very thing it is waiting for prevents from arriving. A picture buffered
    // to its cap with no audio anywhere in the pipeline and none read since the
    // seek is the same answer reached from the other side, and it is the only
    // one available while the loop is parked.
    const cap = this.videoQueueCapFrames(
      false,
      this.videoDecoder?.isSoftware ?? false,
      1,
    );
    return (
      this._lastAudioPacketPts < 0 &&
      this._videoPacketsSinceAudio > 0 &&
      this.audioDecoder.queueSize === 0 &&
      !(this.audioRenderer.getBufferedDuration() > 0) &&
      cap > 0 &&
      (this.videoRenderer?.getQueueSize() ?? 0) >= cap
    );
  }

  /**
   * True when the picture is the whole of playback — there is no sound that
   * could carry it on its own. A file with no audio track, audio switched off,
   * or sound the browser refuses to start.
   *
   * It matters wherever the pipeline is willing to let playback run without
   * frames. With sound, that is a picture falling behind; without it, it is a
   * wall clock ticking over a frozen frame while nothing plays at all — the
   * timeline advancing past content the viewer never saw, because the frames
   * that arrive late are already behind the clock and get dropped.
   *
   * False where the picture is missing BY DESIGN — data-saver audio-only, a
   * hidden tab — since waiting for frames nobody is decoding never ends.
   */
  private pictureIsPlayback(): boolean {
    // Nothing to show: a music file, or the stretch of a file whose video track
    // has already ended. Asking those to wait for frames waits forever.
    if (!this.trackManager.getActiveVideoTrack()) return false;
    if (this.isInAudioOnlyTail()) return false;
    if (this._audioOnly) return false;
    if (this.isBackgrounded && !this.isPiPActive) return false;
    return !this.hasAudioThatCanPlay();
  }

  /**
   * Is there sound that could carry playback on its own right now? A track that
   * exists, isn't switched off, and isn't being dropped because the browser
   * won't start the context. (Split audio lives in its own demuxer, outside the
   * track manager, so it is counted separately.)
   */
  private hasAudioThatCanPlay(): boolean {
    if (this.disableAudio) return false;
    if (!this.trackManager.getActiveAudioTrack() && !this.audioDemuxer) {
      return false;
    }
    return !this.audioRenderer.isDroppingAudio();
  }

  private cancelBlackFrameWatchdog(): void {
    if (this._blackFrameWatchdog !== null) {
      clearTimeout(this._blackFrameWatchdog);
      this._blackFrameWatchdog = null;
    }
  }

  /**
   * After a seek force-completes with no decodable video frame, watch for one to
   * actually land. If none does within a short window — the decoder can't produce
   * a picture at this point (open-GOP / a bad seek target), and the audio-driven
   * resume has flipped to "playing" over a BLACK screen — nudge the playhead onto
   * the next GOP by seeking a little forward. Escalates the jump each attempt and
   * stops after MAX_BLACK_RECOVERY_SEEKS so a genuinely undecodable stream doesn't
   * seek forever. This automates the manual seek users do to unstick a black
   * screen. Superseded silently if a newer seek (incl. the user's own) intervenes.
   */
  private armBlackFrameWatchdog(seekTarget: number): void {
    this.cancelBlackFrameWatchdog();
    const session = this.seekSessionId;
    const baseFrames = this.videoRenderer?.getStats?.().framesPresented ?? 0;
    this._blackFrameWatchdog = setTimeout(() => {
      this._blackFrameWatchdog = null;
      if (this.seekSessionId !== session) return; // a newer seek owns recovery
      // A black screen is a decode failure; a finished video track is not. Past
      // the end of the picture there is nothing to nudge towards, and nudging
      // anyway skips the audio the viewer is listening to. See _videoTailStart.
      if (this.isInAudioOnlyTail()) return;
      // Already handed to the sound — the picture rejoins on its own at the
      // next keyframe the decoder accepts, and nudging now would skip audio the
      // viewer is currently hearing. From here the frozen-picture watchdog owns
      // recovery, and its corrective seek stays where the playhead is.
      if (this._soundCarryingAlone) return;
      const nowFrames = this.videoRenderer?.getStats?.().framesPresented ?? 0;
      if (nowFrames > baseFrames) {
        this._blackRecoverySeeks = 0; // a frame decoded on its own — recovered
        return;
      }
      const st = this.stateManager.getState();
      // Also act while still "seeking": on open-GOP content the seek can sit
      // there with every keyframe a CRA the decoder rejects, so no frame ever
      // decodes and the seek never completes — the black screen the nudges exist
      // to clear. Only paused/ready/idle/error are left alone. The session check
      // above already prevents fighting a newer seek, and we only nudge when
      // ZERO frames decoded since arming, so a slow-but-working seek is safe.
      if (st !== "playing" && st !== "buffering" && st !== "seeking") return;
      // Starved, not stuck: with no buffered data ahead there is nothing to
      // decode at ANY position, so nudging forward only burns the budget and
      // resets the pipeline. These nudges exist to clear a bad GOP run, not a
      // slow link — re-arm and let it buffer, so the budget is still there if a
      // genuine undecodable run shows up once data flows again.
      const from0 = Math.max(seekTarget, this.clock.getTime());
      if (this.getBufferedTime() - from0 < 0.5) {
        this.armBlackFrameWatchdog(seekTarget);
        return;
      }
      // Nothing decodes here — but the sound does, and a nudge buys the picture
      // by throwing away everything in between. Let the sound carry playback
      // from where it is instead: the demuxer keeps feeding both decoders, so
      // the picture comes back at the next keyframe the decoder accepts, and
      // nothing the viewer could have heard is skipped to get it. The nudges
      // stay for the case with no sound to hand it to — a video-only file,
      // where the only thing in the gap is the picture that won't decode.
      if (this.hasAudioThatCanPlay()) {
        Logger.info(
          TAG,
          `No decodable frame at ${this.clock.getTime().toFixed(1)}s — letting the sound carry playback rather than skipping ahead; the picture rejoins at the next keyframe`,
        );
        this._soundCarryingAlone = true;
        this._soundCarryingFrames =
          this.videoRenderer?.getStats?.().framesPresented ?? 0;
        // Through a seek to where the playhead already is. Not to move it —
        // it doesn't — but because the wait has left the audio schedule built
        // out ahead of a clock that never advanced, and resuming onto that
        // starts the sound wherever the schedule reached. Measured: a hold
        // that began at 23.6s resumed the sound at 28.8s. Re-priming from the
        // playhead is what makes this hand-over cost nothing.
        this._carrySoundThroughNextSeek = true;
        void this.seek(Math.max(seekTarget, this.clock.getTime()));
        return;
      }
      if (this._blackRecoverySeeks >= MoviPlayer.MAX_BLACK_RECOVERY_SEEKS) {
        Logger.warn(
          TAG,
          "Black-frame recovery exhausted — no decodable frame after nudges",
        );
        return;
      }
      this._blackRecoverySeeks++;
      // Escalate the jump so a whole bad GOP run is cleared: 2s → 6s → 10s.
      const jump = 2 + (this._blackRecoverySeeks - 1) * 4;
      const duration = this.getDuration() || 0;
      const from = Math.max(seekTarget, this.clock.getTime());
      let target = from + jump;
      if (duration > 1 && target > duration - 0.5) {
        target = Math.max(0, duration - 1);
      }
      Logger.info(
        TAG,
        `Black-frame recovery #${this._blackRecoverySeeks}: no frame at ${from.toFixed(1)}s — nudging to ${target.toFixed(1)}s`,
      );
      void this.seek(target);
    }, 2500);
  }

  private notifySeekCompletion(time: number, forced: boolean = false): void {
    Logger.debug(TAG, `notifySeekCompletion called: time=${time.toFixed(3)}s, waitingForVideoSync=${this.waitingForVideoSync}, seekTargetTime=${this.seekTargetTime.toFixed(3)}s, forced=${forced}`);
    if (!this.waitingForVideoSync) {
      Logger.warn(TAG, "notifySeekCompletion: early return (waitingForVideoSync=false)");
      return;
    }
    // Bail if a newer seek has superseded the one that armed this completion.
    // A stale frame/timeout from a coalesced rapid seek would otherwise run the
    // resume/paused branch and consume wasPlayingBeforeSeek out from under the
    // live seek — intermittently leaving rapid seeks stuck paused.
    if (this.seekArmedSessionId !== this.seekSessionId) {
      Logger.warn(
        TAG,
        `notifySeekCompletion: stale session ${this.seekArmedSessionId} != ${this.seekSessionId} — ignoring`,
      );
      // But the armed seek is DEAD — a later op (a subtitle prefetch, an audio
      // switch, a quality swap) bumped the session to supersede it without
      // clearing the sync flag it left set. If we only ignore, every frame
      // re-enters here and bails forever while `waitingForVideoSync` stays true,
      // so the pipeline sits in a permanent "seeking"/loading state that only a
      // fresh manual seek clears. The superseding op owns its own resume, so we
      // must NOT run the resume/paused branch — just release the dead flag so
      // playback can proceed. (seekTargetTime is left alone: the superseding op
      // may be using it as a pre-target frame filter.)
      if (this.seekArmedSessionId < this.seekSessionId && this.waitingForVideoSync) {
        Logger.info(
          TAG,
          "notifySeekCompletion: releasing a superseded seek's stuck video-sync flag",
        );
        this.waitingForVideoSync = false;
        this.seekingToKeyframe = false;
      }
      return;
    }

    // "The seek is done" is a different statement from "playback has resumed",
    // and only the first one is what `seeked` means.
    //
    // This used to be announced at the very end of this function — which the
    // branches below never reach when playback was rolling: a seek made while
    // playing lands in one of the "buffer until the cushion fills" paths and
    // returns from there. So a scrub during playback fired `seeking` and then
    // nothing, and any page waiting for `seeked` waited for good. A media
    // element says seeked as soon as the new position is available and then,
    // if it has to refill, waiting — in that order.
    let seekedAnnounced = false;
    const announceSeeked = () => {
      if (seekedAnnounced) return;
      seekedAnnounced = true;
      // Media time back to UI time.
      const at = Math.max(0, time - this.startTime);
      // The pipeline's own completion, which fires for EVERY seek. `seeked` is
      // the page's event and stays quiet for the ones nobody asked for; the
      // element still has to know when its poster frame has landed, and
      // borrowing the public event for that meant suppressing the event
      // silently broke the poster: the clock was never reset off the poster
      // timestamp, so playback began there and the readout — held at zero for
      // the length of the poster seek — was held there for good.
      this.emit("seekcomplete", at);
      if (this._seekIsInternal) return;
      this.emit("seeked", at);
    };

    // A genuine frame-driven completion (forced=false) means a real picture
    // decoded — cancel any pending black-frame watchdog and refill its budget so
    // a later, unrelated black event gets fresh recovery attempts.
    if (!forced) {
      this.cancelBlackFrameWatchdog();
      this._blackRecoverySeeks = 0;
    } else {
      // …and a forced one means the opposite: this seek is finishing with
      // nothing on the canvas. Note what it still owes so the frames the
      // decoder is about to hand over — the ones this gave up waiting for —
      // are not dropped by the state gate the moment we leave "seeking".
      // Settled by the first frame that reaches the renderer.
      this._pictureOwedFrom = time;
    }

    // Forced completion (safety timeout) with no decoded video frame yet: the
    // seek didn't actually produce a picture — slow network/decode just hasn't
    // delivered one. Going straight to "playing" here advances the clock over a
    // black screen and only recovers on a manual pause→play. Instead, finish
    // the seek bookkeeping but resume into "buffering" with the play intent
    // latched, so the normal buffering→resume path flips to "playing" the
    // moment the first frame is actually decoded — no user interaction needed.
    // Only a source that HAS a picture can be waiting for one — see hasPicture.
    const noVideoFrameYet =
      this.hasPicture && this.videoRenderer!.getQueueSize() === 0;
    // …but NOT while the tab is hidden, where there is no picture to wait for.
    // Video decode is skipped there on purpose, so "resume into buffering until
    // a frame decodes" is a wait that cannot end: the next video after a
    // background auto-advance sat in buffering, silent, until the viewer came
    // back and the decoder started again. Read off a real session's log —
    // "notifySeekCompletion … forced=true", "State: seeking -> buffering", and
    // then nothing at all until "Foreground recovery". Backgrounded, the audio
    // IS the playback, so let it start. PiP is not backgrounded in this sense:
    // the picture is on screen and worth waiting for.
    const pictureIsBeingDecoded = !this.isBackgrounded || this.isPiPActive;
    // …and not past the end of the video track: no frame is coming, so
    // "buffering until the first frame" is a wait with no end, and the nudges
    // armed with it walk the playhead through the rest of the file. Resume on
    // audio, over the frame already on screen. See _videoTailStart.
    const forcedWithoutFrame =
      forced &&
      noVideoFrameYet &&
      pictureIsBeingDecoded &&
      !!this.trackManager.getActiveVideoTrack() &&
      !this.isInAudioOnlyTail() &&
      !this._soundCarryingAlone;

    const seekTarget = this.seekTargetTime;
    this.seekTargetTime = -1;
    this.waitingForVideoSync = false;
    this.seekingToKeyframe = false; // Also clear keyframe skip flag
    // First-play/replay seek has produced its first frame — drop spinner
    // suppression so any later genuine rebuffer shows the loading UI.
    //
    // …but not while this same seek is about to buffer for its own re-prime.
    // The state sequence is seeking -> buffering -> paused -> playing, and the
    // buffering in the middle belongs to the seek, not to a later stall. Clearing
    // here handed the element a spinner for exactly that window: invisible on a
    // fast machine, where the element's own 400ms seek grace covers it, and a
    // half-second flash on one where the re-prime takes longer — which is where
    // it was reported, on a speed change that no longer stops the picture but
    // still flashed a loading ring at it. The resume below clears it instead.
    // …nor while the SOUND half of the same seek is still coming up.
    // needsSeekResumeQueue() asks only about the video renderer's queue, which
    // is the whole story when the two sides fill together. With split audio —
    // a separate demuxer on its own URL, which the prebuffer never touches
    // (it reads this.demuxer, and a video-only file has no audio track to
    // count) — they do not: a cached video refills instantly while audio is
    // still opening from zero. The guard went false there, this cleared the
    // suppression, and the buffering the seek itself then caused waiting for
    // audio drew a spinner over a picture that was already running.
    //
    // Deliberately only the spinner: needsSeekResumeQueue() also gates
    // clock.pause() and stopPresentationLoop(), and holding THAT for audio
    // would trade the flash for a frozen picture.
    if (!this.needsSeekResumeQueue() && !this.audioSideStillPriming()) {
      this.suppressSeekSpinner = false;
    }

    // How far past the requested target did the first frame actually land?
    // Long-GOP .ts files can land seconds late; subtract that in
    // getCurrentTime() so the UI timeline starts where the user clicked.
    if (seekTarget >= 0) {
      this.seekKeyframeOffset = Math.max(0, time - seekTarget);
    }

    Logger.debug(
      TAG,
      `Seek completion at ${time.toFixed(3)}s (target: ${seekTarget.toFixed(3)}s)`,
    );

    // Sync correction: Match clock to actual video/audio start time.
    //
    // When video arrives late (hardware decode lag, or no keyframe at the
    // exact seek target), we have two options:
    //
    //   a) Sync clock to earliest audio packet — audio stays continuous, but
    //      video frame sits queued until clock catches up, so the user hears
    //      audio while the video is frozen/stale for the gap duration.
    //
    //   b) Sync clock to video frame time — drops the stale audio packets
    //      between seek target and video time, but A/V stays coherent.
    //
    // Small gaps (< 200ms) are imperceptible, so (a) wins. Large gaps (from
    // sparse keyframes / slow HEVC+HDR decoders) were causing bad user-facing
    // desync: video and audio visibly drifting for nearly a second. For those
    // we now prefer (b) — a brief audio skip beats sustained A/V mismatch.
    if (time > seekTarget + 0.01) {
      const AUDIO_SYNC_GAP_LIMIT = 0.2;
      let syncTime = time;
      let syncedToAudio = false;

      if (this.pendingAudioPackets.length > 0) {
        const earliestAudioTime = Math.min(
          ...this.pendingAudioPackets.map((p) => p.timestamp)
        );

        if (earliestAudioTime < time) {
          const gap = time - earliestAudioTime;
          if (gap <= AUDIO_SYNC_GAP_LIMIT) {
            syncTime = earliestAudioTime;
            syncedToAudio = true;
            Logger.debug(
              TAG,
              `Video arrived late (${time.toFixed(3)}s), syncing clock to earliest audio (${syncTime.toFixed(3)}s) — gap ${(gap * 1000).toFixed(0)}ms`,
            );
          } else {
            Logger.info(
              TAG,
              `Video-audio gap ${(gap * 1000).toFixed(0)}ms exceeds ${AUDIO_SYNC_GAP_LIMIT * 1000}ms; syncing clock to video (${time.toFixed(3)}s) and dropping stale audio before that`,
            );
          }
        } else {
          Logger.debug(
            TAG,
            `Stream jumped ahead. Syncing clock to video at ${syncTime.toFixed(3)}s.`,
          );
        }
      } else {
        Logger.debug(
          TAG,
          `Stream jumped ahead. Syncing clock to ${syncTime.toFixed(3)}s.`,
        );
      }

      this.clock.seek(syncTime);

      // Filter audio packets:
      //  - synced to audio: keep everything from seek target onward
      //  - synced to video: drop audio before the video frame so AV stays
      //    aligned after the seek
      const cutoff = syncedToAudio ? seekTarget - 0.01 : syncTime - 0.01;
      this.pendingAudioPackets = this.pendingAudioPackets.filter(
        (p) => p.timestamp >= cutoff,
      );
      // Split (separate-URL) audio never passes through pendingAudioPackets —
      // its own loop decodes straight from the audio demuxer — so that filter
      // left it untouched and the two paths disagreed about where playback
      // resumes. The audio demuxer's seek lands on ITS container boundary,
      // which can sit well before the target, and its in-flight guard
      // (seekTargetTime) is released the moment this completion runs. Those
      // early packets were then decoded and scheduled, the clock followed audio
      // backwards, and the picture sat frozen on a full renderer queue until
      // the clock crawled back up to the first video frame.
      //
      // It bites hardest exactly where the video starts LATE: an open-GOP CRA
      // whose keyframe the decoder rejects resumes video a good half second
      // past the target, so the audio-behind gap is at its widest. Measured on
      // a split source: video resumed at 10.552s against a 10.000s target while
      // audio started at 9.47s — 616ms of frozen picture. Hand the same cutoff
      // to the split loop so it drops the stale head too.
      if (this.audioDemuxer) {
      // An exact cutoff: nothing provisional about it.
      this._splitAudioSkipBefore = cutoff;
      this._splitAudioFloorPending = false;
    }
    }

    // Transition to final state
    if (
      (this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer) &&
      forcedWithoutFrame
    ) {
      // Wanted to resume, but the forced timeout fired before any video frame
      // decoded. Enter buffering with the play intent kept so the process
      // loop's buffering→resume path auto-flips to "playing" on the first
      // frame — instead of advancing the clock over a black screen.
      Logger.info(
        TAG,
        "Seek forced-complete with no video frame yet — buffering until first frame",
      );
      this.wasPlayingBeforeSeek = false;
      this.wasPlayingBeforeRebuffer = true; // resume intent for buffering→play
      this._bufferingEntryTime = performance.now();
      // This wait is the seek's own doing and its exit condition is already the
      // right one — "the first frame arrived" IS videoReady below. Serving the
      // stall floor on top would just hold a decodable frame off screen: on a
      // heavy source (8K AV1) the seek already spent its 3s timeout getting
      // here, so every further fixed wait is felt directly.
      this._bufferingSelfInflicted = true;
      this.stateManager.setState("buffering");
      // Heavy software audio is flushed-cold by the seek. This branch waits for
      // the first video frame — which on an open-GOP CRA source can take a few
      // seconds (HW decoder recreate + CRA wait). Without priming, the audio
      // context keeps running through that wait and drains its buffer, so when
      // the first frame finally lands and we resume, the sub-realtime cold
      // decode underruns into gap-fill jitter. Hold the context suspended so
      // the catch-up decode instead accumulates a cushion, and flag the resume
      // gate to wait for it (issue #11, seek case).
      if (this.activeAudioNeedsColdPrime()) {
        this.beginAudioPrime();
      } else {
        // …and every other codec still has to be HELD, even though it needs no
        // cushion demand. render() drops AudioData while the renderer isn't
        // playing, and this branch hands control to the resume gate without
        // starting it — so without the hold, every frame decoded during the
        // wait is thrown away while the demuxer reads on. Captured on a
        // software-AAC file over a slow link: seventeen seconds of audio
        // discarded, the buffer still reading zero, the bound stall giving up
        // on "audioReady=false", and then the first buffer that finally landed
        // was at 16.8s of media time against a picture at 0.7s — the clock
        // jumped forward to meet it. See holdAudioForBuffering.
        this.holdAudioForBuffering();
      }
      if (this._playStartTime === 0) {
        this._playStartTime = performance.now();
      }
      // Waiting for the first frame can hang forever when the decoder simply
      // can't produce one at this seek point (open-GOP / bad keyframe), while the
      // audio-driven resume flips to "playing" over black. Arm a watchdog to nudge
      // the playhead onto the next GOP if no frame lands — the automated form of
      // the manual seek that recovers it.
      this.armBlackFrameWatchdog(seekTarget);
    } else if (this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer) {
      // Consume the resume intent so it doesn't leak into the next seek. It's
      // never reset elsewhere, so a stale `true` would make a later paused
      // user-seek wrongly auto-resume (and would defeat seek()'s re-derivation
      // guard that now skips re-deriving when this is already true).
      this.wasPlayingBeforeSeek = false;
      this.wasPlayingBeforeRebuffer = false;
      if (this._playStartTime === 0) {
        this._playStartTime = performance.now();
      }

      // Cold-start audio prime for heavy software audio (TrueHD/DTS via WASM),
      // which decodes sub-realtime for ~1-2s while the decode path warms up. If
      // we start now, the fast HW video races ahead while audio underruns —
      // gap-fills ("atak-atak") then a ~2s A/V resync once the buffer empties.
      // Route the resume through the same buffering machinery the stall path
      // uses: hold the AudioContext suspended (isPlaying=true so decoded audio
      // still accumulates), hold the clock and video presentation, and let the
      // buffering→resume gate below start both together once a real audio
      // cushion exists. NOT one-shot — every seek flushes the decoder, so each
      // post-seek resume is a cold start that needs the cushion too, else a
      // mid-playback seek resumes thin and underruns into ~2s of jitter (issue
      // #11, seek case). Hardware audio (AAC) and lightweight software codecs
      // (Opus/FLAC/AC-3/E-AC-3) decode faster than realtime even cold, so
      // activeAudioNeedsColdPrime() gates them out — no needless buffer for them.
      if (this.activeAudioNeedsColdPrime()) {
        this.beginAudioPrime();
        this.wasPlayingBeforeRebuffer = true; // resume intent for buffering→play
        this._bufferingEntryTime = performance.now();
        this._bufferingSelfInflicted = false;
        this.stateManager.setState("buffering");
        this.clock.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        Logger.info(TAG, "Audio cold-prime: buffering until cushion");
        announceSeeked();
        return;
      }

      // The same argument, for the picture.
      //
      // A seek flushes the video decoder and clears the renderer queue, and
      // this branch runs on the FIRST frame back — so the clock starts against
      // a queue of exactly one, and the queue then has to be built from nothing
      // while playback is already running at realtime. Every seek in a capture
      // shows it: `Initial A/V sync … framesPresented=0`, `First frame`,
      // `framesPresented=1`, and then a visible half-second of hitching before
      // the decoder is far enough ahead to be smooth. The rebuffer gate below
      // has asked for a real cushion (fps × BOUND_RESUME_CUSHION_S) for exactly
      // this reason since bindav landed; the seek path never did.
      //
      // Route it through the same machinery, marked self-inflicted so it serves
      // no dwell floor and no 2s audio cushion — the decoder is warm and
      // running, the frames are already on their way, and the only thing being
      // waited on is the queue filling. SEEK_RESUME_QUEUE_ESCAPE_MS caps it
      // hard: this wait exists to be shorter than the stutter it replaces, so
      // if the frames are not there in a beat it starts anyway.
      if (this.needsSeekResumeQueue()) {
        this._seekResumeQueueWait = true;
        this.holdAudioForBuffering();
        this.wasPlayingBeforeRebuffer = true; // resume intent for buffering→play
        this._bufferingEntryTime = performance.now();
        this._bufferingSelfInflicted = true;
        // Stamp it here as well as on the direct resume below: an underrun in
        // the moment after this wait ends is still the seek's flush working
        // through, not a starving link (see SELF_INFLICTED_STALL_WINDOW_MS).
        this._lastSeekResumeAt = performance.now();
        this.stateManager.setState("buffering");
        this.clock.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        // This branch RETURNS, so it reaches neither place that decides whether
        // the demuxer is ahead of the clock: the resume below clears the flag,
        // the paused branch sets it, and this one did neither — leaving
        // whatever the last seek happened to leave.
        //
        // It IS ahead. The seek hunted for its target frame and read past it,
        // exactly as the paused branch says. The difference is only that this
        // branch expects to carry straight on into playback, and while that
        // holds, play() picks up close enough that the gap never shows.
        //
        // When it does not hold, it shows badly. A blocked autoplay sits here
        // for over a second while the muted-fallback grace runs, and play() is
        // then reached with BOTH of its realignment triggers already disarmed:
        // `_playStartTime` was stamped on the way into this same seek
        // completion, above, before play() was ever called. Measured in Safari
        // on that path — paused with the queue at 0.00–0.28s, playing a second
        // later with the queue at 2.60–5.36s and nothing in between ever
        // decoded. The picture held one frame for 2.3s while the clock ran up
        // to meet it, then resumed at full rate. No drops, no refusals, no
        // state change, and not one line logged.
        //
        // So say what is true and let play() decide. Where the resume really is
        // immediate, the realignment it triggers seeks the demuxer to a
        // position it has barely left, off bytes the source still holds.
        this._demuxerAheadOfClock = true;
        Logger.debug(TAG, "Post-seek: buffering until the frame queue fills");
        announceSeeked();
        return;
      }

      Logger.info(TAG, "Resuming playback after seek");
      // This seek carries straight on into playback with its own decoded
      // frames, so nothing is left ahead for play() to rewind.
      this._demuxerAheadOfClock = false;
      // Playback is starting; if the tab is hidden this is the only thing that
      // will feed the renderer.
      this.ensureBackgroundPump();
      // Stamp it: the decoders were flushed by this seek, so playback is
      // restarting on a thin cushion and an underrun in the next moment is our
      // doing, not a starving link (see SELF_INFLICTED_STALL_WINDOW_MS).
      this._lastSeekResumeAt = performance.now();
      this.stateManager.setState("playing");
      // Mark that playback has actually started. When play() is pressed during
      // the initial poster-seek it early-returns before reaching the body that
      // normally sets _playStartTime, and the seek-completion resume path takes
      // over here instead — so _playStartTime would stay 0 for the whole
      // session. A later mid-playback recovery (decode-error → buffering →
      // this.play()) would then see _playStartTime === 0, mistake itself for
      // the "first play", and seek(0) — yanking a video that's an hour in back
      // to the start. Stamp it here so the first-play branch only ever fires
      // for a genuine first play.
      if (this._playStartTime === 0) {
        this._playStartTime = performance.now();
      }
      this.clock.start();
      if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
        this.audioRenderer.play();
      }

      // Flush buffered audio packets AFTER play() so AudioRenderer.isPlaying=true
      // and render() accepts the decoded AudioData instead of dropping it.
      if (this.pendingAudioPackets.length > 0) {
        Logger.debug(
          TAG,
          `Flushing ${this.pendingAudioPackets.length} buffered audio packets after seek sync`,
        );
        this.submitAudioPackets(this.pendingAudioPackets);
        this.pendingAudioPackets = [];
      }
    } else {
      Logger.info(TAG, "Seek completed in paused state");
      this.wasPlayingBeforeSeek = false;
      this.stateManager.setState("paused");
      // The hunt for this frame left the demuxer past it, and the frames
      // between the two are about to be thrown away below. Playback cannot
      // just restart the clock from here — see _demuxerAheadOfClock.
      this._demuxerAheadOfClock = true;

      // Don't decode audio now (AudioRenderer not playing — would drop all data).
      // Discard stashed audio and prebuffer packets — play() re-seeks the
      // demuxer back to this position (see _demuxerAheadOfClock, set just
      // above) and re-reads them fresh. Keeping them causes A/V desync: they
      // were read AHEAD of the target while the seek hunted for its frame, so
      // feeding them back would start playback from later than the picture on
      // screen.
      this.pendingAudioPackets = [];
      this.pendingPrebufferPackets = [];
      this.dropVideoReadAhead();

      // Don't start clock or audio — but continue buffering ahead
      this.startPauseBuffering();
    }

    // Ready — and if a branch above already said so, this is a no-op.
    announceSeeked();
  }

  /**
   * Heavy lossless/complex software audio codecs (TrueHD/MLP, DTS/DCA) decode
   * sub-realtime for ~1-2s from a cold start. Every seek flushes the decoder,
   * so each post-seek resume is a cold start that needs the audio prime cushion
   * — not just the first play/replay. Hardware audio (AAC) and lightweight
   * software codecs (Opus/FLAC/AC-3/E-AC-3) decode faster than realtime even
   * cold and don't need it. (issue #11)
   */
  private activeAudioNeedsColdPrime(): boolean {
    return (
      !this.disableAudio &&
      // Nothing to prime when the audio is being discarded: muted with a
      // context the browser won't start (autoplay blocked). The cushion the
      // prime waits for can never appear, so it would only freeze the picture
      // for the full max-dwell before starting anyway.
      !this.audioRenderer.isDroppingAudio() &&
      this.activeAudioIsHeavySoftware()
    );
  }

  /**
   * Should a post-seek resume hold for the frame queue to refill first?
   *
   * Only where there is a picture that is actually being decoded and presented:
   * data-saver audio-only and a hidden tab both skip video on purpose, so the
   * queue is empty for a reason that has nothing to do with the seek, and
   * waiting on it would hold the sound for a picture nobody asked for. Same
   * carve-outs the rebuffer gate's `pictureRunning` makes.
   */
  private needsSeekResumeQueue(): boolean {
    if (!this.videoRenderer || this._audioOnly) return false;
    if (this.isBackgrounded && !this.isPiPActive) return false;
    if (!this.trackManager.getActiveVideoTrack()) return false;
    // On a high-latency output the renderer is going to hold the picture
    // anyway while the first audio buffer travels to the speakers
    // (CanvasRenderer.audioStartLeadMs), and the presentation loop runs
    // through that hold with the queue filling behind it — which is exactly
    // what this wait is for. Stacking the two would add a wait on top of a
    // delay that already covers it: on Bluetooth, ~400ms of buffering ahead of
    // a ~600ms lead, for a full second of frozen picture after every seek.
    if (
      !this.disableAudio &&
      this.audioRenderer.expectedStartLead() * 1000 >=
        MoviPlayer.SEEK_RESUME_QUEUE_ESCAPE_MS
    ) {
      return false;
    }
    return this.videoRenderer.getQueueSize() < this.seekResumeQueueTarget();
  }

  /** Whether the audio side has yet to reach a resumable cushion — the sound
   *  half of the question needsSeekResumeQueue() asks about the picture.
   *  Mirrors `audioReady` in the rebuffer check, at its lightest target: this
   *  decides how long to keep a spinner hidden, not when to resume. */
  private audioSideStillPriming(): boolean {
    if (this.disableAudio) return false;
    // The split demuxer counts even when the container itself has no audio
    // track — it IS the audio in that case.
    const hasAudio =
      !!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer;
    if (!hasAudio) return false;
    return this.audioRenderer.getBufferedDuration() <= 0.1;
  }

  /** Frames the renderer should hold before playback restarts after a seek. */
  private seekResumeQueueTarget(): number {
    const fps =
      this.trackManager.getActiveVideoTrack()?.frameRate ||
      (this.mediaInfo as any)?.videoFrameRate ||
      24;
    return Math.max(2, Math.round(fps * MoviPlayer.BOUND_RESUME_CUSHION_S));
  }

  /**
   * The active audio is one of the codecs that genuinely decodes sub-realtime
   * from cold — the ones the prime and the 2s rebuffer cushion were built for.
   *
   * This used to be spelled `audioDecoder.usesSoftware && /truehd|mlp|dts|dca/`
   * in one place and plain `audioDecoder.usesSoftware` in the other, and the
   * two meant the same thing back when only the heavy codecs took the software
   * path. AudioDecoder.needsSoftwareDecoding() now returns true for everything
   * (see its note — one decoder, so the bitrate ladder isn't also a decoder
   * ladder), which silently turned the second spelling into "always". The
   * consequence was measurable: a plain 8-channel AAC file underran once, and
   * the buffering exit gate then demanded a 2s cushion — the TrueHD number —
   * before it would resume. It never got there, and the recovery came from
   * MoviElement's stuck watchdog seeking out of it rather than from the player.
   *
   * So ask the codec, not the code path, and ask it from one place.
   */
  private activeAudioIsHeavySoftware(): boolean {
    if (!this.audioDecoder.usesSoftware) return false;
    const codec = (
      this.trackManager.getActiveAudioTrack()?.codec ?? ""
    ).toLowerCase();
    return MoviPlayer.HEAVY_SOFTWARE_AUDIO.test(codec);
  }

  /**
   * Tell the demuxer to skip every audio track except the active one. A file
   * with a second, unused audio track (e.g. a dual-TrueHD source with ~933
   * packets/s PER track) otherwise floods the read path with packets the loop
   * immediately throws away — roughly doubling the reads needed per second. On
   * a slower engine (Safari pulls ~half the packets/s of Chromium) that starved
   * the ACTIVE audio below realtime and stalled every few seconds (issue #11).
   * AVDISCARD_ALL makes av_read_frame skip them internally so each read returns
   * a useful packet. Only audio streams are touched — video and subtitles keep
   * their demuxer defaults (subtitles are read on demand). Re-applied on every
   * audio-track switch so the newly-selected track is re-enabled.
   */
  private applyStreamDiscard(): void {
    const bindings = this.demuxer?.getBindings();
    if (!bindings) return;
    const activeAudioId = this.trackManager.getActiveAudioTrack()?.id;
    for (const t of this.trackManager.getTracks()) {
      if (t.type === "audio") {
        bindings.setStreamDiscard(t.id, t.id !== activeAudioId);
      }
    }
  }

  /**
   * Begin an audio prime: hold the AudioContext suspended (primeForBuffering,
   * which never issues a resume() so it can't drain/race), flush any pending
   * post-seek audio packets into the decoder so the cushion starts filling, and
   * flag _primingAudio so the buffering→resume gate waits for a real cushion
   * (2s) rather than the thin 0.1s default before resuming.
   */
  private beginAudioPrime(): void {
    this.holdAudioForBuffering();
    this._primingAudio = true;
  }

  /**
   * The mechanical half of a prime, without the 2s cushion demand: hold the
   * context suspended and hand the stashed post-seek packets to the decoder so
   * the buffer fills against a frozen clock.
   *
   * Any seek-completion branch that holds the picture back has to do this. The
   * packets are stashed precisely BECAUSE the renderer isn't playing yet
   * (render() drops AudioData while isPlaying is false), so a branch that
   * returns without calling this leaves the audio buffer at zero — and the
   * resume gate it just handed control to reads that as "audio not ready" and
   * waits out its escape every single time.
   */
  private holdAudioForBuffering(): void {
    this.audioRenderer.primeForBuffering();
    if (this.pendingAudioPackets.length > 0) {
      this.submitAudioPackets(this.pendingAudioPackets);
      this.pendingAudioPackets = [];
    }
  }

  /**
   * Hand a run of audio packets to the decoder in as few WASM round-trips as
   * possible.
   *
   * Only the software path batches — and that's where it matters: TrueHD/MLP
   * emits a 40-sample access unit (~0.8 ms), so priming a 2s cushion after a
   * seek means ~2400 packets, each otherwise costing its own send/receive/getter
   * round-trips and per-channel copies. Batched, the whole run crosses once.
   * WebCodecs codecs have no such cost and just replay one by one.
   *
   * A short `consumed` means the block ended at a format change or pts
   * discontinuity, so the remainder goes as a fresh batch — never flattened.
   */
  private submitAudioPackets(
    packets: { data: Uint8Array; timestamp: number; keyframe: boolean }[],
  ): void {
    if (packets.length === 0) return;

    if (!this.audioDecoder.canBatch()) {
      for (const pkt of packets) {
        this.audioDecoder.decode(pkt.data, pkt.timestamp, pkt.keyframe);
      }
      return;
    }

    let batch = packets.map((p) => ({ data: p.data, pts: p.timestamp }));
    while (batch.length > 0) {
      const consumed = this.audioDecoder.decodeBatch(batch);
      if (consumed <= 0) break; // decoder errored//broke — drop the rest
      if (consumed >= batch.length) break;
      batch = batch.slice(consumed);
    }
  }

  /**
   * Main Playback Loop
   */
  private processLoop = async () => {
    const currentState = this.stateManager.getState();
    // Run if playing OR buffering (for rebuffering) OR if we are resolving a seek (fetching target frame)
    if (currentState !== "playing" && currentState !== "buffering" && !this.waitingForVideoSync)
      return;

    // Capture session ID at start of loop - if a new seek starts, this loop should abort
    const currentSessionId = this.seekSessionId;
    // …and which video pipeline this pass belongs to. An in-place rendition
    // swap replaces the demuxer and closes the old one while a readPacket()
    // from this pass may still be suspended inside it; that read then fails
    // BECAUSE we tore its source down, and the catch below has no way to tell
    // that from a real failure. It was classifying the teardown as a fatal
    // WASM abort and rebuilding the whole player — twice in a two-minute
    // session, each time interrupting playback that was otherwise fine.
    const pipelineGeneration = this._demuxerGeneration;

    // ONE chain, always. This loop is entered from several places — the frame
    // it schedules here, the background timer's tick, play(), a rendition swap,
    // a video-only resync — and each entry used to schedule another frame
    // without retiring the one already pending. While the tab is hidden that
    // compounds: rAF callbacks do not run, so every background tick leaves one
    // more queued, and on return they all fire in the same frame and each
    // spawns a self-sustaining chain of its own. Measured on a 12-second
    // background stint: 359,761 loop entries in the first second, the thread
    // saturated, and the first packet not read until a second after the tab
    // came back — which is the "sometimes the picture takes forever" this was
    // chased for. Retiring the pending frame first keeps exactly one chain
    // whatever calls in.
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.animationFrameId = requestAnimationFrame(this.processLoop);

    if (!this.demuxer) return;

    // Check if a new seek has started - if so, abort this loop iteration
    if (this.seekSessionId !== currentSessionId) {
      Logger.debug(TAG, "ProcessLoop aborted: new seek started");
      return;
    }

    // Check if audio is rebuffering due to playback rate change
    if (!this.disableAudio && this.audioRenderer.isRebuffering()) {
      // Enter buffering state and pause clock until rebuffering completes
      const currentState = this.stateManager.getState();
      if (currentState === "playing") {
        this.wasPlayingBeforeRebuffer = true;
        this._bufferingEntryTime = performance.now();
        this.stateManager.setState("buffering");
        this.clock.pause();
        if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
        this._bufferingSelfInflicted = true;
        Logger.debug(TAG, "Entered buffering state for playback rate change");
      }
      // Continue processing to allow new audio to be decoded and scheduled
    } else if (this.stateManager.getState() === "buffering" && this.wasPlayingBeforeRebuffer) {
      // Resume after minimum dwell time to accumulate enough data
      //
      // Split (separate-URL) audio has no track in the MAIN demuxer's
      // trackManager — it is decoded from its own demuxer straight into the
      // audio renderer — so asking the track manager alone reads as "no audio
      // at all" on every split source. The stall detector below already counts
      // `audioDemuxer` for exactly this reason; the resume gate did not, and
      // the consequence was worse than a loose audioReady: `bound` (see below)
      // was false, so on precisely the sources this player streams — YouTube's
      // separate video and audio URLs — `bindav` held the way IN to a stall and
      // then let go the way OUT on audio alone. That is the drift the binding
      // exists to prevent.
      // …but not once the playhead is past the end of that track. Waiting for a
      // cushion of audio that the file does not contain is a buffering state
      // nothing can leave: seeking anywhere past the end of the sound sat on
      // the spinner for good, with the picture already decoded and queued
      // behind it. See _audioTailStart.
      // …and the learned tail is not the only way that is true. It is learned
      // at EOF, so on a freshly-loaded source it is not known yet and a seek
      // straight into the tail hit exactly the buffering state this clause was
      // written to prevent. See noSoundLeftToWaitFor().
      const hasAudioTrack =
        (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
        !this.noSoundLeftToWaitFor();
      // The first-play cold prime needs a REAL cushion before it starts: the
      // software decode is still sub-realtime (and gets even slower once video
      // decode/render competes for CPU), so resuming on a thin 0.1s buffer just
      // underruns again → a second stall + a ~2s A/V resync. Require ~1.5s
      // buffered for the prime (with a generous max-dwell fallback so a very
      // slow decoder still eventually starts). A normal mid-playback rebuffer
      // keeps the lighter 0.1s threshold for responsiveness.
      // A mid-playback rebuffer resumes on a thin 0.1s cushion for
      // responsiveness. That's right when the stall was I/O — the decoder is
      // idle and refills instantly. It's badly wrong when the stall was an
      // UNDERRUN from a sub-realtime software codec (TrueHD/MLP/DTS): 0.1s is
      // spent within a second and we stall straight back, so the spinner
      // ping-pongs every couple of seconds. A decoder running ~8% behind drains
      // 0.1s in ~1s but 2s in ~25s — same deficit, a totally different
      // experience. Rebuild a real cushion for the software path.
      //
      // …but only for the codecs that are actually sub-realtime. Every codec
      // now decodes in WASM, so `usesSoftware` alone reads "always" and handed
      // plain AAC the TrueHD cushion — see activeAudioIsHeavySoftware().
      const heavyAudioStall =
        !this.disableAudio && this.activeAudioIsHeavySoftware();
      // Light software audio (AAC/Opus/FLAC/AC-3) still decodes faster than
      // realtime, but it is no longer the browser's own decoder either: it is
      // WASM on the same thread as demux and render, so the 0.1s that was
      // chosen for a hardware decoder is thinner than it used to be and a
      // rebuffer resuming on it can stall straight back. Half a second is
      // enough to play through the next hitch without being felt as a wait.
      const lightSoftwareAudio =
        !this.disableAudio && this.audioDecoder.usesSoftware;
      // The 2s cushion is for a decoder that fell BEHIND realtime — rebuilding
      // a real buffer is the only way out of that. A rate change is the
      // opposite case: nothing was starving, we discarded the scheduled audio
      // ourselves in the re-anchor, and the decoder is idle and refilling at
      // full speed. Demanding 2s there just extends the frozen picture (E-AC3 /
      // AC-3 / TrueHD / DTS all decode in software, so every such title paid
      // it on every speed change). Use the light threshold; if the new rate
      // genuinely can't be sustained, the stall detector re-enters buffering
      // and the full cushion applies then.
      const audioTargetS = this._bufferingSelfInflicted
        ? 0.1
        : this._primingAudio || heavyAudioStall
          ? 2.0
          : lightSoftwareAudio
            ? 0.5
            : 0.1;
      const audioReady =
        this.disableAudio ||
        !hasAudioTrack ||
        this.audioRenderer.getBufferedDuration() > audioTargetS;
      // Bound, sound and picture stall together and start together — see the
      // long note at the resume decision below, and MoviPlayer's _bindAV.
      //
      // …but only where there IS a picture. Data-saver audio-only and a hidden
      // tab both skip video decode on purpose, so the video queue is empty for
      // a reason that has nothing to do with the link: binding to it would hold
      // the sound for a picture nobody asked to be decoded.
      const pictureRunning =
        !this._audioOnly && (!this.isBackgrounded || this.isPiPActive);
      // Nor where the sound is being dropped rather than played: an
      // autoplay-blocked context is suspended, so there is no sound to come back
      // in step with and waiting for it never ends. See the stall detector.
      // Nor past the end of the video track, where waiting for the picture to
      // come back in step is waiting for a picture that has finished. The last
      // frame stays on screen and the sound carries the rest of the file.
      const bound =
        this._bindAV &&
        hasAudioTrack &&
        !this.disableAudio &&
        pictureRunning &&
        !this.audioRenderer.isDroppingAudio() &&
        !this.isInAudioOnlyTail() &&
        // …nor while the sound is deliberately carrying playback past a
        // stretch the decoder can't get through: binding it to the picture
        // there is what the hand-over exists to avoid.
        !this._soundCarryingAlone;
      // …and bound, "a frame exists" is not "the picture is running again". One
      // frame satisfies a `> 0` test the instant it lands; the presentation
      // loop shows it, the queue is empty again, and the post-play grace then
      // covers the next three seconds during which the stall detector may not
      // even look — so the sound gets all of it. Repeated on a link that is
      // delivering the odd frame and nothing more, it ratchets: stall, resume,
      // ~3.5s of audio over a picture that never moved, stall again. Ask
      // instead for enough queue to actually play through that grace. The
      // presentation loop is stopped for the whole of buffering, so this counts
      // only frames that ACCUMULATED — and the escape below still caps the wait.
      const fps =
        this.trackManager.getActiveVideoTrack()?.frameRate ||
        (this.mediaInfo as any)?.videoFrameRate ||
        24;
      // The post-seek queue wait asks for the same cushion whether or not the
      // two are bound: it is not there to keep them in step, it is there so the
      // picture that comes back has something behind it (see the entry point in
      // notifySeekCompletion). Falling back to `1` would satisfy it with the
      // single frame it was entered on.
      // With no sound to carry it the picture is the whole of playback, so it
      // needs the same cushion a binding asks for: resuming on the single frame
      // a `> 0` test accepts empties the queue again on the next tick, and the
      // resume grace then covers the seconds that follow — stall, resume, a
      // frozen frame with the clock running, stall again. See pictureIsPlayback.
      const needsFrames = this.pictureIsPlayback();
      const videoTargetFrames =
        bound || needsFrames || this._seekResumeQueueWait
          ? Math.max(2, Math.round(fps * MoviPlayer.BOUND_RESUME_CUSHION_S))
          : 1;
      const videoReady =
        !this.videoRenderer ||
        this.isInAudioOnlyTail() ||
        this._soundCarryingAlone ||
        this.videoRenderer.getQueueSize() >= videoTargetFrames;
      const dwellMs = performance.now() - this._bufferingEntryTime;
      // A rate change is NOT a stall. AudioRenderer.isRebuffering() is raised
      // only for the rate-change re-anchor, and while it's up the clock is
      // paused, the AudioContext is suspended and the presentation loop is
      // stopped — the picture is frozen. The 1.5s floor below exists to stop a
      // starved pipeline from resuming onto a thin buffer and stalling right
      // back; neither applies here, where audio is typically still scheduled
      // seconds ahead and the video queue is full. Holding the freeze for a
      // fixed 1.5s (every speed change, and again on every change back) was
      // the entire stall. Let the readiness checks below decide instead.
      const dwellFloor =
        this._bufferingSelfInflicted || this._bufferingSupplyIsFine ? 0 : 1500;
      const minDwell = dwellFloor; // Wait at least 1.5s to accumulate buffer
      // Cap the prime startup so a very CPU-bound decoder doesn't spin forever;
      // it starts with whatever cushion it built (a residual stall is possible
      // on such machines — the real fix is off-thread audio decode).
      const maxDwell = this._primingAudio ? 4000 : 3000;
      // Under a binding, audio alone is not enough to leave.
      //
      // `bindav` bound the way IN to a stall — either side running dry enters
      // buffering — and left the way OUT on audio, which on a slow link is the
      // side that is never short: a YouTube audio track is a fraction of its
      // video, so it refills in the time the picture needs to fetch one frame.
      // Measured on Slow 4G: the player entered buffering, served three
      // seconds, resumed on audio alone, played a beat, and stalled again —
      // and over 25 seconds of that the sound advanced from 6.8s to 14.2s
      // while the picture sat at 6.04s throughout. Nothing was lost by the
      // stalls, which freeze both properly; it was drifting apart in the
      // moments BETWEEN them. Then the ABR dropped a rung, the video pipeline
      // caught up in one jump, and the viewer saw playback "resume" eight
      // seconds late. It had not resumed late — the picture had jumped forward
      // to meet the sound.
      //
      // So when the two are bound, resuming needs both. The escape is far
      // longer (see BOUND_RESUME_ESCAPE_MS): a bound wait costs nothing but
      // the wait, since the picture is frozen throughout it either way.
      //
      // The post-seek queue wait is the exception in both directions: it is our
      // own doing, the decoder is warm and already producing, and its whole
      // value is being shorter than the stutter it stands in for. It gets its
      // own tight cap whether or not the two are bound.
      const escapeMs = this._seekResumeQueueWait
        ? MoviPlayer.SEEK_RESUME_QUEUE_ESCAPE_MS
        : bound
          ? MoviPlayer.BOUND_RESUME_ESCAPE_MS
          : maxDwell;
      // The escape is for a picture that is BEHIND, not one that is absent.
      // With nothing at all in the renderer, resuming is not "letting go on
      // what we have" — it is starting the sound over a still frame, which is
      // the exact thing a binding is asked to prevent. Two sessions of a
      // dropped connection show what it costs: the wait ran its 15 seconds,
      // gave up on `videoReady=false`, played a second of audio, stalled, and
      // came back to do it again — and once, with EOF having quietly switched
      // the stall detector off, it ran twenty-one seconds before the viewer
      // seeked by hand. Bound and empty, keep waiting: the spinner is the
      // honest state, and the rescues that matter (the ABR's downshift, the
      // element's stuck watchdog, the decoder's own recreate) all run inside
      // buffering anyway.
      const somethingToShow = (this.videoRenderer?.getQueueSize() ?? 0) > 0;
      // …and with nothing to hear, escaping onto an empty queue is not "letting
      // go on what we have" either — there is nothing at all to play.
      // …and the same for sound. The escape exists so a picture that is BEHIND
      // isn't held forever; it was letting a picture that has nothing to play
      // WITH start anyway. On a link running far under the file's bitrate that
      // is what it did — captured on a 2.8Mbps file over a 0.15MB/s link:
      // "Bound stall gave up after 15002ms — audioReady=false videoReady=true",
      // then video with no sound at all, and a fresh stall 0.7s later. Waiting
      // is the honest answer there: the spinner says the link cannot carry
      // this, where silent video says the player is broken.
      const soundToPlay = audioReady || !hasAudioTrack || this.disableAudio;
      const mayEscape =
        ((!bound && !needsFrames) || somethingToShow) && soundToPlay;
      // Resume if: (1) both ready after minDwell, (2) unbound, audio ready
      // after a longer wait, or (3) the escape (don't wait forever).
      const canResume = dwellMs >= minDwell && (
        (audioReady && videoReady) ||
        // Audio alone, after a longer wait — but only where audio IS the
        // playback. On a file with no sound `audioReady` is permanently true,
        // so this resumed every stall after three seconds whatever the queue
        // held, which on a link running under the video's own bitrate meant
        // resuming into nothing, over and over.
        (!bound && !needsFrames && audioReady && dwellMs >= 3000) ||
        (dwellMs >= escapeMs && mayEscape)
      );
      if (
        canResume &&
        bound &&
        !this._seekResumeQueueWait &&
        !(audioReady && videoReady)
      ) {
        Logger.warn(
          TAG,
          `Bound stall gave up after ${Math.round(dwellMs)}ms — audioReady=${audioReady} videoReady=${videoReady}`,
        );
      }
      if (canResume) {
        this._primingAudio = false;
        this._bufferingSelfInflicted = false;
        this._bufferingSupplyIsFine = false;
        this._seekResumeQueueWait = false;
        // Stamp the resume so the stall detector can tell this — a warm
        // pipeline picking back up — from a cold first play, and not hand it
        // the full three-second grace (see playGraceMs).
        this._stallResumeAt = performance.now();
        // Before the state moves, not after: the decoder can hand over a frame
        // between these two lines. See _resumeToPlayPending.
        this._resumeToPlayPending = true;
        this.stateManager.setState("paused");
        this.wasPlayingBeforeRebuffer = false;
        // Resume AudioContext before play() so audio picks up from where it was
        if (this.audioRenderer) {
          this.audioRenderer.resumeFromBuffering();
        }
        Logger.info(TAG, "Buffers refilled, resuming playback");
        // The seek that armed this buffering is finally done — see the note in
        // notifySeekCompletion. Anything that stalls from here is genuinely new
        // and deserves its spinner.
        this.suppressSeekSpinner = false;
        this.play().catch((err) => {
          this._resumeToPlayPending = false;
          Logger.error(TAG, "Failed to resume playback after rebuffering:", err);
        });
      }
    }

    // Update FileSource preload position based on current time
    if (this.source instanceof FileSource && this.mediaInfo) {
      const currentTime = this.clock.getTime();
      const duration = this.mediaInfo.duration + this.startTime;
      if (duration > 0) {
        this.source.updatePreloadPosition(currentTime, duration);
      }
    }

    // Emit periodic time update for UI
    this.emit("timeUpdate", this.getCurrentTime());

    // Stall detection: if playing but both video and audio buffers are critically low
    // Skip near end of video to avoid false stall at EOF
    const nearEnd = this.mediaInfo && this.clock.getTime() >= (this.mediaInfo.duration + this.startTime) - 3;
    // Longer stall timeout for slow + high-FPS: stretcher / hardware rate fallback
    // causes brief audio gaps that aren't true stalls. 2s vs 500ms default.
    const currentRate = this.clock.getPlaybackRate();
    const currentFps = (this.mediaInfo as any)?.videoFrameRate ?? 30;
    const isSlowHighFps = currentRate < 0.99 && currentFps >= 50;
    const stallTimeout = isSlowHighFps ? 2000 : 500;
    // Is there sound that can walk away from a frozen picture? (Split audio
    // lives in its own demuxer, outside the track manager — see the resume
    // gate.) Only then does a binding have anything to hold together.
    const boundToAudio =
      this._bindAV &&
      !this.disableAudio &&
      !this._audioOnly &&
      // Sound the browser refuses to start cannot walk away from anything.
      !this.audioRenderer.isDroppingAudio() &&
      (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer);
    // Grace period after play() starts: allow decode pipeline to fill before stall detection.
    // Without this, clicking play on a poster triggers a false stall → buffering → loading spinner.
    //
    // That is a COLD start — play() on a poster, nothing decoded yet. A resume
    // out of a stall is not: the pipeline was already running and the gate only
    // let go because frames were there. Handing it the full three seconds is
    // how a bound stream drifts anyway — the queue runs dry again immediately
    // and the sound has three clear seconds before the detector may even look,
    // once per stall. Five of those in a row is where the audio in the reported
    // session got 17 seconds ahead of a picture that never moved. Bound, a
    // resume off the stall path gets a short grace instead.
    //
    // The same is true, for a different reason, when there is no sound at all:
    // three seconds during which the detector may not look is three seconds of
    // wall clock over a frozen frame, and on a link that keeps running dry it
    // repeats at every resume. Measured on a video-only file served under its
    // own bitrate: stall, resume, and the timeline ran 32.5s → 35.5s with the
    // queue empty and not one frame presented.
    const sinceStallResume = performance.now() - this._stallResumeAt;
    const resumedFromStall =
      (boundToAudio || this.pictureIsPlayback()) &&
      this._stallResumeAt > 0 &&
      sinceStallResume < 3000;
    const playGraceMs = resumedFromStall
      ? MoviPlayer.BOUND_RESUME_GRACE_MS
      : 3000;
    const inPlayGrace = this._playStartTime > 0 && (performance.now() - this._playStartTime) < playGraceMs;
    // …and the sound gets a much shorter one.
    //
    // The grace above is for the VIDEO pipeline filling up — a cold start has
    // an empty renderer queue by definition, and a spinner over that is a lie.
    // It was applied to the whole detector, so it covered the audio side too:
    // resume with a thin buffer, the sound runs dry, and for as long as the
    // grace lasts nothing is allowed to notice. On a resume that isn't stamped
    // as coming off a stall — a seek that buffered, most often — that is three
    // full seconds of picture playing to an empty room, which is exactly what
    // it sounds like.
    //
    // An audio pipeline that has started fills in a fraction of a second, so a
    // silence outlasting this one is not a pipeline warming up.
    const AUDIO_PLAY_GRACE_MS = 400;
    const inAudioGrace =
      this._playStartTime > 0 &&
      performance.now() - this._playStartTime <
        Math.min(playGraceMs, AUDIO_PLAY_GRACE_MS);
    // Grace while the video decoder is recovering from a transient decode
    // error (recreate + wait-for-keyframe). The video queue is legitimately
    // empty for ~1 GOP there — counting it as a stall sends the player into a
    // buffering→resume loop (seen on high-bitrate 1080p H.264 whose HW decoder
    // throws an EncodingError on every IDR). The keyframe-wait handler already
    // shows buffering during the actual recovery; this just stops the stall
    // detector from piling on right after.
    // NOTE: this grace is applied to the VIDEO-empty branch only, not to the
    // whole detector. Gating everything on it meant that on a source whose
    // decoder recreates after every seek (open-GOP HEVC), the audio-underrun
    // branch below could never fire — precisely when the user is hearing the
    // glitches and needs the spinner. The two are independent: the video
    // decoder rebuilding says nothing about whether audio is keeping up.
    //
    // …and that suppression has to END. isRecentlyRecovering() is true for the
    // whole keyframe wait, and a keyframe only arrives if packets do: when the
    // link dies mid-recovery the wait never ends and the detector is switched
    // off for good. Read off the reported session — the decoder recreated at
    // 2607s, the network went offline in the same breath, and the sound (a
    // separate source with its bytes already in hand) played on for 57 seconds
    // over a picture frozen on one frame, timeline running the whole way, no
    // spinner at any point. Bound, that is exactly what must not happen, so cap
    // the hold: past the cap an empty video queue is a stall like any other.
    // Unbound the documented behaviour is untouched — clock and audio carry on
    // and the picture catches up at the next keyframe.
    const keyframeHoldTooLong =
      boundToAudio &&
      (this.videoDecoder?.keyframeWaitMs() ?? 0) >
        MoviPlayer.BOUND_KEYFRAME_HOLD_MS;
    const decoderRecovering =
      !!this.videoDecoder &&
      this.videoDecoder.isRecentlyRecovering() &&
      !keyframeHoldTooLong;
    // EOF normally means the picture is finished rather than stalled: the queue
    // drains, playback ends, and a spinner over that would be wrong. But the
    // demuxer's read cursor runs well ahead of the decode, so "no more packets"
    // can arrive with most of the video still unshown — in one session the
    // video demuxer read out to the end of the file while the playhead sat at
    // 97s of 142s, and the flag silenced the detector for the rest of the
    // session: the sound ran on alone for twenty-one seconds and only a manual
    // seek brought the picture back. Bound, EOF stops speaking for the picture;
    // the genuine end of playback is already covered by `nearEnd` below.
    const eofSilencesStall = this.eofReached && !boundToAudio;
    if (this.stateManager.getState() === "playing" && !eofSilencesStall && !this.waitingForVideoSync && !nearEnd && !this.isBackgrounded) {
      // `hasPicture`, not `videoRenderer` — a source with no video track has
      // an empty queue forever and must never read as a stalled picture.
      const videoEmpty = this.hasPicture
        ? this.videoRenderer!.getQueueSize() === 0
        : false;
      // Split (separate-URL) audio has no track in the MAIN demuxer's
      // trackManager — it's decoded from its own demuxer into audioRenderer. So
      // count audioDemuxer too, else hasAudio is false, audioLow is always true,
      // and the detector false-stalls on any momentary video-queue blip while the
      // (independent) audio buffer is perfectly healthy.
      //
      // …and audio the browser will not let us start is not audio at all here.
      // Blocked by autoplay policy the context stays suspended, so its clock
      // never advances and nothing scheduled against it is ever consumed: the
      // buffer reads empty on every pass, forever. Counting that as a track made
      // `audioStarved` permanently true, and under a binding the picture waited
      // on sound that could never arrive — stall, spinner, resume, stall, for as
      // long as the viewer left it muted. isDroppingAudio() is false for our OWN
      // suspends (a prime, a buffering hold), which are exactly the ones the
      // picture SHOULD wait through.
      const hasAudio =
        (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
        !this.disableAudio &&
        !this.audioRenderer.isDroppingAudio();
      const audioLow = !hasAudio || this.audioRenderer.getBufferedDuration() < 0.05;
      // Audio can starve on its own while video stays perfectly healthy: an
      // expensive software codec (TrueHD/MLP/DTS) decodes slower than realtime,
      // so the renderer quietly patches hole after hole with silence while the
      // player still reports "playing". The user hears broken audio and gets no
      // signal at all. Treat sustained underrunning as a stall in its own right
      // — buffering pauses cleanly and lets the cushion rebuild, which at least
      // trades a visible spinner for inaudible glitches. (Not gated on
      // videoEmpty: the bytes are usually already in memory; it's CPU, not I/O.)
      // Suppress the underrun→buffering path briefly after returning from
      // background: the throttled-decode underrun that lands on recovery is
      // transient and refills on its own. Suspending audio for it would stop
      // playback (e.g. background music) the instant the user comes back.
      const inForegroundGrace =
        this._foregroundRecoveryAt > 0 &&
        performance.now() - this._foregroundRecoveryAt < 3000;
      // A soundtrack that has ENDED is not underrunning. Nothing is coming to
      // refill it, so every check below would read it as starving for as long
      // as the picture ran on — which on a file whose audio stops early is a
      // spinner over the rest of the film. See AudioRenderer._streamEnded.
      //
      // Armed the moment the PLAYHEAD crosses the end of the audio track, from
      // the duration the container declared up front (see _audioTailStart) —
      // not when the demuxer finally reaches EOF. Waiting for EOF meant the
      // pipeline spent the whole tail being told the sound was merely late:
      // the clock stayed pinned to the last sample, the picture had nothing to
      // advance it, and the queue ran dry a second or two later.
      if (!this.audioRenderer.isStreamEnded() && this.isInVideoOnlyTail()) {
        Logger.info(
          TAG,
          `Playhead has passed the end of the audio track — the picture carries playback from here`,
        );
        this.audioRenderer.endOfStream();
      }
      const soundIsOver = this.audioRenderer.isStreamEnded();
      const audioUnderrunning =
        hasAudio &&
        !soundIsOver &&
        !inForegroundGrace &&
        this.audioRenderer.isUnderrunning();
      // Whichever side runs out, when the two are bound (see _bindAV).
      //
      // Unbound, a side running dry only counts if the OTHER one did too: a
      // frozen picture over continuous sound, or continuous picture over
      // patched-up sound, is taken as the lesser evil. Bound, either is enough
      // on its own — which is the point, since it is precisely the healthy side
      // carrying on that lets the two drift apart.
      //
      // `audioLow` is not the audio side of that test: with no audio track at
      // all it is permanently true, so a silent video would read as starved in
      // every frame. It has to be audio that EXISTS and has run out.
      const audioStarved =
        hasAudio &&
        !soundIsOver &&
        this.audioRenderer.getBufferedDuration() < 0.05;
      // …but an empty queue past the end of the video track is not a shortfall
      // at all — there are no more frames in the file to wait for. Stalling
      // there stops the sound too (bound, which is the default) and hands the
      // rest of the file to the stuck watchdog. See _videoTailStart.
      // The hand-over is a claim that no picture is coming. Frames reaching the
      // screen disprove it — and they can arrive by a route that never passes
      // the gate the hand-over armed (a rendition switch, a recovery recreate,
      // a poster reset). Without this the claim outlives the outage that made
      // it, and with it the A/V binding stays off: sound and picture drift and
      // nothing pulls them back.
      if (this._soundCarryingAlone) {
        const framesNow = this.videoRenderer?.getStats?.().framesPresented ?? 0;
        if (framesNow > this._soundCarryingFrames) {
          Logger.info(
            TAG,
            "Picture is presenting again — ending the sound-only hand-over",
          );
          this._soundCarryingAlone = false;
          this._blackRecoverySeeks = 0;
        }
      }
      // A decoder that is merely too SLOW for the source is not a stall, and
      // treating it as one is worse than doing nothing. Measured on 8K60 AV1 on
      // an M4: the hardware decoder tops out at ~20fps against a 60fps source,
      // whatever config it is given — prefer-hardware, no-preference and
      // optimizeForLatency all land within 0.3fps of each other. Supply is
      // fine; the machine simply cannot decode it in real time.
      //
      // Buffering cannot fix that. It stops the sound, flashes through paused,
      // discards the picture that HAD arrived, and resumes into the same
      // shortfall — measured at 11 to 20 of those cycles a minute, none of
      // which ever caught up, because catching up was never possible.
      //
      // The existing pictureMoving guard is meant for exactly this, but it
      // reads framesPresented, and in this state almost nothing is presented:
      // frames arrive later than the audio clock and the renderer discards
      // them. So ask the DECODER instead. If it handed out a frame recently
      // the picture is alive and merely behind — show it, choppy, rather than
      // stopping everything to wait for a recovery that cannot come.
      const decodeIsSlowNotStuck =
        !!this.videoDecoder &&
        this.videoDecoder.msSinceLastFrame() <
          MoviPlayer.DECODE_ALIVE_WINDOW_MS;
      const videoStalled =
        videoEmpty &&
        (audioLow || this._bindAV) &&
        !decoderRecovering &&
        !decodeIsSlowNotStuck &&
        !inPlayGrace &&
        !this.isInAudioOnlyTail() &&
        !this._soundCarryingAlone;
      // The audio side of the stall, whether it arrived as a real underrun
      // (holes already heard) or as an empty buffer under a binding.
      const audioBlocking =
        !inAudioGrace && (audioUnderrunning || (this._bindAV && audioStarved));
      if (videoStalled || audioBlocking) {
        // An underrun isn't a silent buffer dipping low — it's a hole the user
        // ALREADY heard as a click. Waiting the full stall window means five or
        // six audible glitches before the spinner appears, which is the whole
        // complaint. Two gaps is enough evidence the decoder is behind.
        // Left at the standard window under a binding too. Shortening it to
        // 250ms was tried and measured: 2.91s of drift against 3.05s, which is
        // noise. The residual is not the detection window — it is the second or
        // so of playback between resuming and running dry again — so a shorter
        // window buys nothing and only makes the spinner flicker more.
        const effectiveStallTimeout =
          audioBlocking && !videoEmpty ? 200 : stallTimeout;
        const framesNow = this.videoRenderer
          ? this.videoRenderer.getStats().framesPresented
          : 0;
        // A 60fps source a machine can only decode at ~30 keeps the queue at or
        // near zero the whole time — the presentation loop takes each frame the
        // instant it lands — so `videoEmpty` reads true forever and this
        // detector called it a stall. The picture was never stopped; it was
        // HALF RATE, and a spinner over moving video is worse than the stutter
        // it complains about. So ask what actually reached the screen across
        // the stall window: frames still arriving at a watchable rate means
        // slow decode, not an empty pipe, and the window simply restarts.
        //
        // Never applied when it is the AUDIO that is short — those gaps are
        // already audible (or, under a binding, about to be), and rebuilding
        // the cushion is the right answer however healthy the picture looks.
        const stallElapsed = this._stallStartTime
          ? performance.now() - this._stallStartTime
          : 0;
        const pictureMoving =
          !audioBlocking &&
          stallElapsed > 0 &&
          ((framesNow - this._stallStartFrames) * 1000) / stallElapsed >=
            MoviPlayer.STALL_MOVING_FPS;
        if (!this._stallStartTime || pictureMoving) {
          this._stallStartTime = performance.now();
          this._stallStartFrames = framesNow;
        } else if (stallElapsed > effectiveStallTimeout) {
          // Only enter buffering after 500ms of continuous stall
          Logger.warn(
            TAG,
            audioUnderrunning
              ? "Stall detected: audio underrunning for 500ms (decode behind realtime), entering buffering state"
              : audioBlocking
                ? "Stall detected: audio buffer empty and bound to video, entering buffering state"
                : "Stall detected: buffers empty for 500ms, entering buffering state",
          );
          this.wasPlayingBeforeRebuffer = true;
          this._bufferingEntryTime = performance.now();
          // A stall landing right after a rate change is one WE caused:
          // AudioRenderer's re-anchor drops the scheduled old-rate audio, so
          // the buffer reads empty for exactly as long as the decoder needs to
          // refill. Nothing is actually starving — the decoder is idle and the
          // video queue is full — so this must not serve the underrun recovery
          // (1.5s dwell + a 2s cushion for software audio). Without this every
          // speed change froze the picture for ~1.5-2s.
          //
          // A stall just after a SEEK resumed is the same story: the seek
          // flushed both decoders, so playback restarts on whatever thin
          // cushion the first packets provide and the underrun detector fires
          // a few hundred ms later. Captured on a streaming 4K AV1 source —
          // seek lands at 2.05s, audio ducks at 2.29s, stall at 2.50s, then
          // the picture sat frozen for a further 1516ms serving the floor
          // alone. The readiness checks below are the right gate for both.
          const now = performance.now();
          // …and an in-place AUDIO switch is a third: it resets the renderer
          // and starts a decoder cold, so the buffer it stalls on is the one
          // this player just emptied.
          this._bufferingSelfInflicted =
            now - this._lastRateChangeAt <
              MoviPlayer.SELF_INFLICTED_STALL_WINDOW_MS ||
            now - this._lastSeekResumeAt <
              MoviPlayer.SELF_INFLICTED_STALL_WINDOW_MS ||
            now - this._lastAudioSwitchAt <
              MoviPlayer.SELF_INFLICTED_STALL_WINDOW_MS ||
            // …and so is the catch-up after an in-place rendition swap, and the
            // one that pulls a lagging picture up to the sound. Both empty the
            // video queue on purpose, at a moment we chose (see
            // POST_SWAP_CATCHUP_MS).
            now - this._lastRenditionSwapAt < MoviPlayer.POST_SWAP_CATCHUP_MS ||
            now - this._lastVideoCatchUpAt <
              MoviPlayer.SELF_INFLICTED_STALL_WINDOW_MS * 3;
          // Is there anything to wait FOR?
          //
          // The dwell floor is a supply measure: it holds a starved pipeline
          // still for a moment so it does not resume onto a thin buffer and
          // stall straight back. Where the bytes are already in hand — a local
          // file, or a network buffer comfortably ahead of the playhead — there
          // is no supply to wait for. What is short is decode, and decode is
          // exactly what the readiness checks measure; the floor adds nothing
          // to it but a frozen picture.
          //
          // Read off a 4K60 HEVC file whose decoder throws every few seconds:
          // the decoder was back in 107ms and the queue refilled behind it, and
          // then the picture sat frozen for a further 1500ms serving the floor
          // alone — the whole visible stall, repeating every five seconds.
          this._bufferingSupplyIsFine =
            this.isFileSource() ||
            this.getBufferEndTime() - this.getCurrentTime() >
              MoviPlayer.SUPPLY_FINE_AHEAD_S;
          this.stateManager.setState("buffering");
          this.clock.pause();
          // Suspend AudioContext so already-scheduled audio doesn't play ahead of video.
          // Keep isPlaying=true so render() still accepts AudioData and buffers fill up.
          if (this.audioRenderer) {
            this.audioRenderer.suspendForBuffering();
          }
          // Stop presentation loop so decoded frames accumulate in queue
          // (otherwise it keeps consuming them and videoReady never becomes true)
          if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
          this._stallStartTime = 0;
        }
      } else {
        this._stallStartTime = 0;
        this._stallStartFrames = 0;
      }
    } else {
      this._stallStartTime = 0;
      this._stallStartFrames = 0;
    }

    // Audio desync detection: if audio falls significantly behind video at 1x.
    // Clock syncs to audio so clock vs audio is always ~0. Compare audio against
    // maxScheduledMediaTime vs actual playback position to detect real desync.
    // Skip only when audio is genuinely out of the pipeline (muted AND a
    // suspended context — autoplay blocked): there the demux loop drops audio
    // frames, so getAudioClock() stays clamped and this would falsely trip. A
    // muted-but-running context schedules audio normally and can desync just
    // like an audible one.
    //
    // Not across a loop turn: the sound wraps to the start a moment before the
    // picture does, and the gap between them is the whole file long. Chasing
    // it pulled the sound back to the END and restarted the loop through a
    // seek — the very trip the turn exists to avoid.
    if (this.stateManager.getState() === "playing" && !this.disableAudio && !this.audioRenderer.isDroppingAudio() && !inPlayGrace && !this._loopPrerolling && Math.abs(this.clock.getPlaybackRate() - 1.0) < 0.01) {
      const audioTime = this.audioRenderer.getAudioClock();
      const videoTime = this.videoRenderer
        ? (this.videoRenderer as any).currentTime ?? -1
        : -1;
      if (audioTime >= 0 && videoTime > 0) {
        const audioBehind = videoTime - audioTime;
        // Cooldown: a resync seek itself takes ~1–2s, so back-to-back desync
        // detections trigger a stutter loop where almost no playback happens
        // between seeks (especially with slow software audio decoders). Wait
        // at least 5s between desync-driven seeks — better to tolerate a
        // sustained ~500ms offset than to pause every second.
        const sinceLastResync = performance.now() - this._lastDesyncSeekTime;
        // A picture from BEFORE the seek is not drift, and must never be
        // chased.
        //
        // The resync below pulls the sound FORWARD to the picture, which is
        // right while the picture is genuinely where the viewer is. It is
        // exactly wrong when the picture is a leftover. Measured on an 8K
        // source: a seek back to 91.29s ran past its 1500ms budget and
        // force-completed with no frame of its own, the renderer put up a
        // stashed frame from 153.00s, and half a second later this read
        // video=153.10 against audio=91.78 and pulled the sound to 153.10 —
        // silently undoing the seek the viewer had just asked for and landing
        // them back where they started.
        //
        // Right after a seek the SOUND is the authority: it is at the target by
        // construction, and it is the picture that has yet to catch up. Sixty
        // seconds is not a drift any decode lag can produce; it is a frame from
        // the position being left. Leave it alone and the picture corrects
        // itself as the seek's own frames arrive.
        const sinceSeekResume = performance.now() - this._lastSeekResumeAt;
        const pictureMayBePreSeek =
          sinceSeekResume < MoviPlayer.SEEK_STALE_PICTURE_MS &&
          audioBehind > MoviPlayer.SEEK_STALE_PICTURE_GAP_S;
        if (pictureMayBePreSeek) {
          Logger.debug(
            TAG,
            `Ignoring a ${audioBehind.toFixed(1)}s A/V gap ${sinceSeekResume.toFixed(0)}ms after a seek — ` +
              `video=${videoTime.toFixed(2)}s is a frame from before it, not drift`,
          );
        }
        if (audioBehind > 0.5 && sinceLastResync > 5000 && !pictureMayBePreSeek) {
          // Suppress the seek when the audio renderer already has samples
          // scheduled past the presented video frame. The gap is just the
          // buffer runway — audio playback will catch up on its own. Forcing
          // a seek here would flush already-decoded audio and cause an
          // audible trip. Most visible after foreground recovery: while
          // backgrounded the audio worker keeps scheduling buffers (out to
          // ~maxScheduledMediaTime), the demuxer-seek brings video forward
          // to that same point, and the playback head is still chewing
          // through the runway — looks like 1s of "desync" but isn't.
          const audioBufferEnd = this.audioRenderer.getMaxScheduledMediaTime();
          if (audioBufferEnd < videoTime - 0.1) {
            // Resync FORWARD, to where the video (what the viewer is actually
            // watching) already is — never to getCurrentTime(), which the audio
            // drives: with the audio 100s behind that would rewind the whole
            // playback 100s, throwing away progress the viewer already saw.
            // Pull the audio up to the video instead. If that position isn't
            // buffered yet the seek simply waits (loading) — acceptable — but
            // the position must not go backwards.
            const resyncTo = Math.max(videoTime, this.getCurrentTime());
            Logger.warn(TAG, `Audio desync detected: video=${videoTime.toFixed(2)}s, audio=${audioTime.toFixed(2)}s, behind=${(audioBehind * 1000).toFixed(0)}ms — pulling audio forward to ${resyncTo.toFixed(2)}s`);
            this._lastDesyncSeekTime = performance.now();
            this.seek(resyncTo).catch(() => {});
          }
        }
      }
    }

    // The other direction: the PICTURE behind the sound (see _videoLagSince).
    // The recovery is the video-only one, not seek() — the sound is where the
    // viewer already is and must not be flushed to fetch the picture back.
    if (
      this.stateManager.getState() === "playing" &&
      !this._audioOnly &&
      !this.disableAudio &&
      !inPlayGrace &&
      !this.isBackgrounded &&
      this.hasPicture &&
      // A decoder that cannot hold the rate at all will just lose the ground
      // again, and each attempt costs the source's read-ahead. That case has
      // its own answers: the renderer's own degrade, and the ABR downshift.
      !this.videoRenderer!.isDecodeBound?.() &&
      Math.abs(this.clock.getPlaybackRate() - 1.0) < 0.01
    ) {
      const nowLag = performance.now();
      // …and the same judgement from the player's own reading, which arrives
      // sooner. See pictureKeepingUp: the verdict above needs four
      // uninterrupted seconds and every catch-up resets the count it needs.
      const outrun = this.pictureKeepingUp() === false;
      if (outrun) {
        this._videoLagSince = 0;
        if (!this._lagSlowLogged) {
          this._lagSlowLogged = true;
          Logger.warn(
            TAG,
            `Picture is being outrun (~${this._lagFpsAchieved.toFixed(1)}fps presented) — ` +
              `not chasing it; the sound carries on and the picture runs at what it can`,
          );
        }
      }
      const audioAt = this.audioRenderer.getAudioClock();
      const videoAt = (this.videoRenderer as any).currentTime ?? -1;
      const videoBehind =
        audioAt >= 0 && videoAt > 0 ? audioAt - videoAt : 0;
      if (videoBehind < MoviPlayer.VIDEO_LAG_S) {
        this._videoLagSince = 0;
        if (this._videoLagHealthySince === 0) {
          this._videoLagHealthySince = nowLag;
        } else if (nowLag - this._videoLagHealthySince > 10000) {
          this._videoLagResyncs = 0;
        }
      } else {
        // Behind. Clear the healthy streak FIRST, outside the settle gate
        // below — leaving a stale timestamp there let a run of lag end in an
        // instant budget refill, which is the opposite of what it measures.
        this._videoLagHealthySince = 0;
      }
      // A hard rendition swap lands RENDITION_SWAP_LOOKBACK_S behind the sound
      // on purpose, expecting the frames in between to be eaten far faster than
      // real time. At 2160p60 they are not — measured on a YouTube ladder, the
      // picture ran seconds behind for most of a switch. There is nothing to
      // wait and see about there: the lag is known the moment the swap lands,
      // so halve the patience and get the picture back sooner.
      const sustainMs =
        nowLag - this._lastRenditionSwapAt < MoviPlayer.POST_SWAP_CATCHUP_MS
          ? MoviPlayer.VIDEO_LAG_SUSTAIN_MS / 2
          : MoviPlayer.VIDEO_LAG_SUSTAIN_MS;
      if (
        videoBehind >= MoviPlayer.VIDEO_LAG_S &&
        // A seek's own re-prime trails the sound for a moment by design; only
        // start counting once that is behind us.
        nowLag - this._lastSeekResumeAt > MoviPlayer.VIDEO_LAG_SUSTAIN_MS &&
        // A speed change is the same story and was not covered. It re-anchors
        // the audio in place, and on a source heavy enough to need one it also
        // runs a corrective seek — it disturbs the pipeline on purpose, at a
        // moment we chose, exactly as the buffering path already recognises
        // through this same stamp (see _bufferingSelfInflicted). The lag that
        // follows is ours, and it clears itself: measured on 8K60 AV1, a 2x to
        // 1x change settled back to 12ms behind and stayed there.
        //
        // Left uncovered it does real damage on this shape of source. The
        // catch-up is a seek, and on a long-GOP 8K AV1 the keyframe before the
        // target is far behind it — captured on one: a rate change to 1x, then
        // "Picture fell behind: video-only seek to 24.69s", and the first
        // packet the seek could resume from was 3.608s EARLIER than the target
        // it was aiming at. All of that has to be demuxed and decoded before
        // anything reaches the screen, and the renderer threw away 28 stale
        // frames and re-anchored twice on the way out.
        nowLag - this._lastRateChangeAt > MoviPlayer.RATE_CHANGE_SETTLE_MS
      ) {
        if (this._videoLagSince === 0) {
          this._videoLagSince = nowLag;
        } else if (
          !outrun &&
          nowLag - this._videoLagSince > sustainMs &&
          nowLag - this._lastVideoLagResyncAt >
            MoviPlayer.VIDEO_LAG_COOLDOWN_MS &&
          this._videoLagResyncs < MoviPlayer.MAX_VIDEO_LAG_RESYNCS
        ) {
          this._videoLagSince = 0;
          this._lastVideoLagResyncAt = nowLag;
          this._videoLagResyncs++;
          Logger.warn(
            TAG,
            `Picture ${(videoBehind * 1000).toFixed(0)}ms behind the sound ` +
              `(video=${videoAt.toFixed(2)}s, audio=${audioAt.toFixed(2)}s) — ` +
              `catching the picture up (attempt ${this._videoLagResyncs})`,
          );
          void this.resyncVideoToAudio("Picture fell behind").catch(() => {});
        }
      }
    }

    // Prevent concurrent async WASM operations (Asyncify limitation)
    // Add timeout safeguard - if demux has been in flight too long, reset it
    if (this.demuxInFlight) {
      const elapsed = performance.now() - this.demuxInFlightStartTime;
      if (elapsed > MoviPlayer.DEMUX_TIMEOUT) {
        Logger.warn(
          TAG,
          `Demux operation timeout after ${elapsed}ms, resetting flag`,
        );
        this.demuxInFlight = false;
      } else {
        return;
      }
    }

    // A speed-up held back until the pipeline could take it — see _pendingRate.
    // No-op unless one is pending, which it never is on a machine whose anchor
    // survives a rate change.
    this.maybeApplyPendingRate();

    // The outgoing pass has run out and the next one is primed — turn over
    // rather than end. Checked before the EOF branch because priming clears
    // eofReached (reading restarts), so this is the only thing still watching.
    if (this._loopPrerolling && this.maybeCompleteLoopWrap()) {
      // processLoop schedules its own next pass; a bare return here stops the
      // pipeline dead. Measured: the turn worked, and four seconds later
      // "audio buffer empty and bound to video" because nothing had demuxed
      // since.
      this.animationFrameId = requestAnimationFrame(this.processLoop);
      return;
    }

    // Stop READING once enough is primed — not just stop keeping frames.
    //
    // This is what leaves the demuxer cursor where the new pass continues
    // from. Capping the frames alone let the read run on to EOF behind the
    // tail: every packet went through the decoder, every frame past the cap
    // was closed, and the new pass then began with a demuxer that had nothing
    // left to give — the picture stalled for three seconds about two seconds
    // in, with the renderer queue pinned at 3.
    //
    // AFTER the wrap check above, never before it: a full preroll is exactly
    // the state the turn happens in, so returning first means the turn is
    // never looked for and the file simply stops looping.
    if (
      this._loopPrerolling &&
      this._loopPrerollFrames.length >= MoviPlayer.LOOP_PREROLL_MAX_FRAMES
    ) {
      this.animationFrameId = requestAnimationFrame(this.processLoop);
      return;
    }

    // Check if we've reached EOF and decoders are empty - transition to ended
    if (this.eofReached) {
      // Ask the decoder for its tail, once. WebCodecs holds reordered frames in
      // its DPB until a flush — on H.264 with B-frames that is the last few
      // pictures of the file, and nothing else was ever going to ask for them:
      // no more packets are coming, so the decoder simply goes quiet holding
      // them. Measured on an 8.008s 720p59.94 video-only clip, after the
      // clock-margin fix below: 471 of 480 frames, the last at 7.941s, with
      // three frames still inside the decoder and msSinceLastFrame growing.
      // flush() emits them and leaves the decoder configured.
      //
      // Not while anything is still WAITING to be fed. `eofReached` says the
      // demuxer ran out, and with a read-ahead stash that happens long before
      // the picture gets there — measured on 4K60 HEVC at 2x, the stash still
      // held 224 packets when this fired. Flushing then makes the decoder wait
      // for a keyframe mid-playback, the point-of-use guard dumps the stash on
      // top of that, and there is no keyframe left to come because the file has
      // ended: the picture stopped for 8.85 seconds and the tail was lost. The
      // reorder tail is only the tail once the last packet has actually gone
      // in.
      if (
        !this._eofFlushRequested &&
        !this.videoDecoder.isWaitingForKeyframe &&
        this._videoAheadStash.length === 0 &&
        this.pendingPrebufferPackets.length === 0
      ) {
        this._eofFlushRequested = true;
        const seq = ++this._eofFlushSeq;
        this.videoDecoder
          .flush()
          .catch(() => {
            /* a decoder that cannot flush has nothing left to give */
          })
          .finally(() => {
            this._eofFlushSettledSeq = seq;
          });
      }
      // A looping file does not end here — it primes the next pass while the
      // tail is still on screen. Only from EOF, and only once the tail is out
      // of the decoder, which is what the flush above is for.
      if (this.maybeStartLoopPreroll()) return;

      const currentTime = this.clock.getTime();
      const duration = this.mediaInfo?.duration ?? 0;
      const timeDone =
        currentTime >= duration + this.startTime - 0.5 || duration === 0;

      // Does the sound stop before the file does? Asked HERE, once the demuxer
      // has run out, because only then are the cursors final.
      //
      // It cannot be asked from the packet stream the way the audio-side tail
      // is. Nothing reads audio ahead, so an audio packet running past the
      // newest video one really does mean the picture stopped; but the video
      // read-ahead stash exists precisely to read the picture ahead, so the
      // same test the other way round fires on ordinary files. Measured: a
      // startup burst put video 6s past the newest audio packet and declared
      // the sound finished at 4.894s of a four-minute song.
      //
      // At EOF the read pass has covered everything from where it began to the
      // end of the file, so: audio seen in it means the newest one is where the
      // sound ends, and no audio at all means the sound ended before the pass
      // started — which is all we may claim, so the tail begins there.
      if (
        !this.audioDemuxer &&
        !!this.trackManager.getActiveAudioTrack() &&
        !!this.trackManager.getActiveVideoTrack() &&
        duration > 0
      ) {
        // Audio seen in this pass is exact evidence: that is where the sound
        // ends. None at all is weaker — it only says the sound ended somewhere
        // before the pass began — so it may narrow an earlier guess but never
        // widen one, and exact evidence replaces a guess outright.
        const sawAudio = this._lastAudioPacketPts >= 0;
        const learned = sawAudio
          ? this._lastAudioPacketPts
          : Math.min(this._audioTailStart, this._audioReadPassStart);
        if (
          duration + this.startTime - learned > MoviPlayer.AUDIO_TAIL_GAP_S &&
          (sawAudio ? learned !== this._audioTailStart : learned < this._audioTailStart)
        ) {
          // A guess made from a seek that started past the sound is only ever
          // an upper bound: seeking to 200 with no audio in the file after
          // 193.4 taught "no sound from 200", which then left a seek to 197
          // waiting for audio that does not exist. Later passes sharpen it.
          this._audioTailStart = learned;
          Logger.info(
            TAG,
            sawAudio
              ? `Sound ends at ${learned.toFixed(2)}s of a ${duration.toFixed(2)}s file — the picture carries playback from there`
              : `No sound anywhere from ${learned.toFixed(2)}s to the end of a ${duration.toFixed(2)}s file — the picture carries playback from there`,
          );
        }
      }

      const hasAudioTrack =
        !!this.trackManager?.getActiveAudioTrack() &&
        !this.disableAudio &&
        !this.isInVideoOnlyTail();

      if (hasAudioTrack) {
        const decodersDone =
          this.videoDecoder.queueSize === 0 && this.audioDecoder.queueSize === 0;
        // The audio renderer keeps playing buffers it already scheduled for
        // seconds after the decoder queue drains. The clock is synced to that
        // playout head, so it only reaches maxScheduledMediaTime once the final
        // samples are actually heard. End when the playout head has caught up to
        // the furthest scheduled audio — not when the decoder empties — or the
        // last few seconds get clipped (audible on near-end seeks of audio-only
        // files). duration===0 keeps the unknown-length fallback.
        // maxScheduled is already absolute media time (the scheduler stores
        // raw packet timestamps), same basis as clock.getTime(). Don't add
        // startTime again — on sources with a non-zero start (e.g. a .ts
        // beginning at 4200s) the double-add pushes the threshold out of
        // reach, audioPlayedOut never trips, and EOF never transitions to
        // ended (timer freezes short of duration).
        const maxScheduled = this.audioRenderer.getMaxScheduledMediaTime();
        // Normally audio is "played out" once the clock catches the furthest
        // scheduled buffer. But maxScheduled can be stale/runaway — e.g. when
        // a prior decoder instance scheduled audio out to a wrong (longer)
        // duration and the AudioRenderer carried that value into the new
        // player (HW→software fallback on the same element). The clock is also
        // clamped to the true container duration in getTime(), so it plateaus
        // at `duration` and can never reach an inflated maxScheduled. Treat
        // audio as done if EITHER the playout head is reached OR the clock has
        // arrived at the real end of content — whichever the clock can attain.
        const reachedContentEnd =
          duration > 0 && currentTime >= duration + this.startTime - 0.25;
        const audioPlayedOut =
          (maxScheduled > 0 && currentTime >= maxScheduled - 0.1) ||
          reachedContentEnd;
        // The clock is clamped to the audio playout head (getAudioClock caps
        // at maxScheduledMediaTime). When the last video frame's PTS sits past
        // that head — e.g. video runs a few ms longer than the audio track —
        // the presentation loop never reaches it, so it lingers in the queue
        // forever and a strict queue-empty check would block the ended
        // transition indefinitely (EOF reached, but never ends). Once the
        // demuxer and video decoder are both drained, treat the renderer as
        // done if its queue is empty OR only holds this unpresentable tail
        // (head frame at/after the audio playout head).
        const headFrameTime = this.videoRenderer?.getHeadFrameTime() ?? -1;
        // The picture can simply run LONGER than the sound.
        //
        // The tail clause below exists for a video that overruns the audio by
        // a frame or two — one that the clock, clamped to the audio playout
        // head, can never come due for. It had no upper bound, so it read a
        // picture that outlives the sound by MINUTES as the same thing.
        // Measured on a 4K AV1 MKV whose Opus track ends at 193.4s against a
        // picture running to 243.8s: at 3:13 the head frame was past the audio
        // head, this declared the video finished, and fifty seconds of film
        // were dropped on the floor. The viewer sees the timer jump to the
        // duration and the video end early.
        //
        // A real overrun is a frame or two. Anything beyond that is content,
        // and the answer is to play it: tell the audio renderer its stream is
        // over so its clock stops holding the picture back, and let the
        // ordinary drain end things when the queue is actually empty.
        // Asked of the CONTENT, not of the queue's head. The head frame is
        // only ever the next one after the sound stops — milliseconds past it,
        // whether one frame follows or fifty seconds do. What says which is
        // where the film ends against where the sound ends.
        //
        // …and `maxScheduled` is not where the sound ends. It is the SCHEDULING
        // HORIZON: AudioRenderer holds decoded audio as data and only makes
        // source nodes as their turn approaches (see scheduleAudioBuffer), so it
        // sits about one cushion ahead of the clock and no further, however many
        // seconds are decoded behind it. Read as the end of the soundtrack it
        // declares every file short — it just usually goes unnoticed, because on
        // a normal file the demuxer is still reading and EOF is minutes away.
        //
        // Measured on a 5.76s 1080p50 H.264 High 4:2:2 camera original (~93
        // Mbps, no hardware decoder): the whole file demuxed 1.16s into
        // playback, so EOF landed with the clock at 1.14s. maxScheduled read
        // 2.25s — the clock plus its 1133ms cushion — with 3030ms of decoded
        // audio still pending behind it, and this declared a full-length
        // soundtrack over at 2.25s of 5.76s. endOfStream() then made
        // getAudioClock() return -1 every time the playout head touched the
        // horizon, so the master clock and the renderer's presentation timing
        // spent the remaining 4.5s dropping and re-acquiring audio sync — the
        // picture juddering the whole way, and the clock finishing at 5.52s.
        //
        // Two things do say where the sound ends, and either one alone would
        // have stopped that:
        //
        //  - The last audio PACKET the demuxer saw. At EOF the read pass has
        //    covered the rest of the file, so it is exact — it is the same
        //    evidence the tail-learning block above runs on, and that block had
        //    already concluded there was no tail here while this one decided
        //    there was. Only ours to read when the audio comes through THIS
        //    loop; split audio has its own demuxer and never sets it, hence the
        //    same `!audioDemuxer` guard the block above carries.
        //  - Audio still sitting in the renderer. Sound that is buffered is
        //    sound that is coming, whether or not a source node exists for it
        //    yet, and getBufferedDuration counts both halves.
        //
        // Only the first of those belongs in the verdict. This flag is read by
        // two more things below — videoDone and the EOF watchdog — and BOTH
        // take `false` to mean "the sound is not short, so the audio playout
        // head is the end of the film" and end playback there. A guard that
        // makes it read false while the true answer is "yes, but not yet"
        // therefore does not postpone the handover, it ends the film at the
        // audio head: exactly the fifty-seconds-dropped bug described above,
        // and how the 4K AV1 / Opus file stopped dead at 3:13 again. So the
        // verdict is asked of the CONTENT alone, and the readiness test moves
        // onto the ACTION, which is the only part that has to wait.
        const lastSoundPts =
          !this.audioDemuxer && this._lastAudioPacketPts >= 0
            ? this._lastAudioPacketPts
            : -1;
        const soundEndsAt = lastSoundPts >= 0 ? lastSoundPts : maxScheduled;
        const pictureOutlivesSound =
          decodersDone &&
          maxScheduled > 0 &&
          duration > 0 &&
          !!this.trackManager.getActiveVideoTrack() &&
          duration + this.startTime >
            soundEndsAt + MoviPlayer.AUDIO_TAIL_GRACE_S;
        // Letting the sound go is what waits. endOfStream() stops the audio
        // clock clamping at maxScheduledMediaTime, and calling it while the
        // renderer still holds decoded audio hands the picture the clock at the
        // SCHEDULING HORIZON instead of at the end of the sound — which on the
        // 4:2:2 file above meant the clock dropping and re-acquiring audio sync
        // for the rest of the run. Sound that is buffered is sound that is
        // coming; wait until there is none. It drains in real time and the
        // clock is clamped to it, so on a genuinely short soundtrack this comes
        // due exactly as the last samples are heard — nothing is held up.
        const soundHasRunOut =
          this.audioRenderer.getBufferedDuration() <=
          MoviPlayer.AUDIO_TAIL_GRACE_S;
        if (
          pictureOutlivesSound &&
          soundHasRunOut &&
          !this.audioRenderer.isStreamEnded()
        ) {
          Logger.info(
            TAG,
            `Sound ends at ${soundEndsAt.toFixed(2)}s ` +
              `but the picture runs to ` +
              `${(this.mediaInfo?.duration ?? 0).toFixed(2)}s — playing the rest out without it`,
          );
          this.audioRenderer.endOfStream();
        }
        // An empty renderer queue says "the picture has all been shown" only
        // while the picture is BEING shown. Backgrounding stops the
        // presentation loop and clears the queue, so from the first tick in a
        // hidden tab it reads empty for the opposite reason — nothing is
        // presenting at all — and on a file whose picture outlives its sound
        // that ends the film the instant the sound runs out.
        //
        // Measured on an 8K AV1 song, 163.77s of picture against 148.53s of
        // Opus. Hidden tab: "Sound ends at 148.53s ... playing the rest out
        // without it" fires correctly, and 0.9s later "Playback ended" with the
        // clock paused at 148.4662 — fourteen milliseconds before
        // isInVideoOnlyTail() (>= _audioTailStart - 0.05) would have flipped
        // and handed the ending to the tail branch, which would have carried
        // the wall clock the remaining 15.24s to the duration. In the
        // foreground the queue holds frames, this clause is false, and the same
        // file plays its tail out — which is exactly the difference reported.
        //
        // So the same guard the clause below already carries: a picture known
        // to outlive its sound is not finished because the queue is empty.
        const videoDone =
          !this.videoRenderer ||
          (this.videoRenderer.getQueueSize() === 0 && !pictureOutlivesSound) ||
          (decodersDone &&
            maxScheduled > 0 &&
            headFrameTime >= maxScheduled - 0.05 &&
            !pictureOutlivesSound);
        if ((decodersDone && videoDone && audioPlayedOut) || duration === 0) {
          this.handleEnded();
          return;
        }
        // Watchdog: the audio has fully played out (it's the master clock and
        // its playout head has been reached) but the strict conditions above
        // never all aligned — a marginal float mismatch between the audio tail
        // and the last video frame can leave one frame unpresentable forever.
        // Once audio is done and we've waited a beat, end rather than freeze.
        if (
          audioPlayedOut &&
          this.eofSince > 0 &&
          performance.now() - this.eofSince > 750 &&
          // Not while there is still picture to play. This watchdog is for a
          // float mismatch leaving one frame unpresentable; a soundtrack that
          // simply ends early would otherwise trip it 750ms later and end the
          // film anyway, whatever the tail clause above decided.
          !pictureOutlivesSound
        ) {
          Logger.warn(
            TAG,
            "EOF watchdog: audio played out but pipeline never fully drained; forcing ended",
          );
          this.handleEnded();
          return;
        }
      } else {
        // Video-only: WebCodecs decodeQueueSize drops to 0 before all output
        // callbacks fire, so the DECODER's queue cannot say when the picture is
        // finished, and the clock is what arms the ending instead.
        //
        // But arming is not finishing, and ending on the clock alone threw the
        // tail away. `timeDone` fires half a second before the duration, which
        // at 59.94fps is thirty frames. Measured on an 8.008s 720p59.94
        // video-only clip: 450 of 480 frames presented, the last at 7.524s, the
        // clock paused at 7.5238s — 0.484s short, every single time.
        //
        // The RENDERER's queue is the honest signal the decoder's is not: it
        // holds decoded frames, not chunks the decoder has merely accepted, and
        // it drains as they are presented. So let the clock arm the ending and
        // let the picture running out finish it.
        // An empty renderer queue is necessary but not sufficient. This is what
        // the note above about decodeQueueSize was really warning of: the queue
        // can read zero for an instant while the decoder still has output
        // callbacks in flight, and ending there clips whatever was about to
        // arrive. Requiring the queue AND a decoder that has gone quiet took
        // the same clip from 4 frames short to none — at 59.94fps a frame is
        // due every 16.7ms, so a decoder silent for EOF_PICTURE_SETTLE_MS has
        // genuinely finished rather than merely paused between callbacks.
        const pictureLeft = (this.videoRenderer?.getQueueSize() ?? 0) > 0;
        const decoderQuiet =
          (this.videoDecoder?.msSinceLastFrame?.() ?? Number.POSITIVE_INFINITY) >
          MoviPlayer.EOF_PICTURE_SETTLE_MS;
        if (timeDone && !pictureLeft && decoderQuiet) {
          this.handleEnded();
          return;
        }
        // …and never wait on it forever. A last frame whose PTS sits past the
        // container's declared duration can never come due against a clock that
        // getTime() clamps to that duration, and the queue would hold it for
        // good. Stamped from when the ending was ARMED, not from eofSince — the
        // demuxer can reach EOF seconds earlier on a small, fully-buffered file,
        // and measuring from there would expire the wait before it began. Same
        // shape as the audio watchdog above.
        //
        // ARMED means timeDone — the clock has reached the end of the content.
        // Without that gate this stamped the moment `eofReached` went true, and
        // that only says the DEMUXER ran out. On a transport stream read ahead
        // into a deep stash it runs out minutes before the picture gets there,
        // so the watchdog armed early and forced `ended` two seconds later with
        // most of the file unplayed. Reported as "EOF happens far too soon" on
        // a 457s 4K HEVC .ts. Reset while not armed, so a spell of eofReached
        // that the clock never catches up to cannot bank time towards it.
        if (!timeDone) {
          this._eofPictureDrainSince = 0;
        } else if (this._eofPictureDrainSince === 0) {
          this._eofPictureDrainSince = performance.now();
        } else if (
          performance.now() - this._eofPictureDrainSince >
          MoviPlayer.EOF_PICTURE_DRAIN_MS
        ) {
          Logger.warn(
            TAG,
            `EOF watchdog: ${this.videoRenderer?.getQueueSize() ?? 0} frame(s) never came due; ending`,
          );
          this.handleEnded();
          return;
        }
      }
      // Don't demux more, just wait for playback to finish — unless the
      // read-ahead stash still holds picture. Those packets were demuxed long
      // before EOF and deliberately deferred; "don't demux more" is about
      // READING, and handing over what was already read is not reading. This
      // return stranded them: measured on a 61.6 Mbps 4K60 HEVC .ts, 93 packets
      // — the closing 1.3 seconds of the film — sat in the stash while the
      // renderer queue read zero for thirteen straight samples and the picture
      // stood still all the way to `ended`. The burst's own stash branch
      // already special-cases eofReached; it simply never got to run.
      if (this._videoAheadStash.length === 0) {
        return;
      }
    }

    // Check backpressure - relax limits for better throughput
    // After seek, use stricter limits to prevent overwhelming low-end devices
    const isSoftware = this.isSoftwareDecoding();
    const timeSinceSeek = performance.now() - this.seekTime;
    const isPostSeek =
      this.justSeeked && timeSinceSeek < MoviPlayer.POST_SEEK_THROTTLE_MS;

    const audioBuffered = this.disableAudio
      ? 0
      : this.audioRenderer.getBufferedDuration();

    // Canvas/WebCodecs path
    // Primed frames are decoded picture in hand, exactly like queued ones —
    // they are simply waiting for the turn rather than for their presentation
    // time. Counting them here is what puts a preroll under the SAME
    // backpressure as ordinary playback: decoding throttles when there is
    // enough picture, while the demuxer keeps reading into the read-ahead
    // stash. Stopping the read as well (which a hard return did) left the
    // pipeline cold at the turn, and playback hitched a second or two later
    // when the primed frames ran out — 60 of them is exactly 2s at 30fps.
    const videoBuffered =
      (this.videoRenderer?.getQueueSize() ?? 0) + this._loopPrerollFrames.length;

    // Adaptive limits for software/hardware modes
    // During post-seek or while waiting for initial sync, we are more permissive with decoder queues
    // to ensure they have enough data to output the first few frames.
    const maxVideoQueue = isSoftware
      ? 1000
      : isPostSeek || this.waitingForVideoSync
        ? 60
        : 30;
    const maxAudioQueue = isSoftware
      ? 500
      : isPostSeek || this.waitingForVideoSync
        ? 40
        : 20;

    // Buffer targets — scale up at slow speeds so both audio and video buffers
    // hold the same wall-clock duration as at 1x. Without this, at 0.5x the 100-frame
    // video buffer lasts 3.3s wall-time while 2s audio buffer starves after 2s → stutter.
    // While a speed-up is being prepared, fill for the rate we are ABOUT to run
    // at, not the one still on the clock — that preparation is the whole point.
    const rate = Math.max(
      0.25,
      Math.max(this.clock.getPlaybackRate(), this._pendingRate),
    );
    // Slow rates: keep the same wall-clock buffer duration (so a 2s audio
    // target doesn't underrun at 0.5x). Fast rates: give the video pipeline
    // proportional headroom too — at 1.5x the decoder is producing frames
    // 50% faster than wall-clock, and the base queue cap empties just as
    // quickly, so any decode jitter shows up as stutter. Cap at 2x scale
    // so 4x playback doesn't balloon VRAM/audio buffers on heavy sources.
    const rateScale = rate < 1.0 ? 1.0 / rate : Math.min(2.0, rate);
    // Software audio keeps its deep lead on every device. The cost that made
    // this look device-dependent was on the OUTPUT side — one live source node
    // per buffered frame, ~215 of them at a 5s lead, which a phone's audio
    // thread cannot render in time. AudioRenderer holds buffers as data now
    // and only makes nodes as their turn approaches, so the lead no longer
    // sets the width of the graph. See scheduleAudioBuffer.
    const maxAudioBuffered =
      (isSoftware ? 5.0 : isPostSeek ? 1.5 : 2.0) * rateScale;
    // Renderer queue limits (in frames). Two separate constraints:
    //
    //  1. High-res (≥4K): per-frame VRAM cost is huge (8K HDR ≈ 50MB/frame).
    //     A deep queue locks GBs of VRAM and starves the GPU compositor,
    //     producing slips even when decode is keeping up. Hard frame cap.
    //
    //  2. Mobile at any res: weaker hardware + Chrome Android's conservative
    //     AV1 HW whitelist mean software dav1d is common; deep buffering
    //     just delays the inevitable underrun. Cap by wall-clock duration
    //     (~800ms) so the cap scales with fps — a 25fps source doesn't end
    //     up with the same tiny 16-frame buffer as 60fps, which would fire
    //     demuxer backpressure long before audio is ready to refill (this
    //     was the "audio drift" symptom).
    //
    // When both apply (e.g. 8K on mobile), use the tighter of the two.
    const maxVideoBuffered = this.videoQueueCapFrames(
      isPostSeek,
      isSoftware,
      rateScale,
    );

    // Skip video backpressure only where video genuinely isn't being consumed:
    // backgrounded (not PiP), where decode is skipped outright.
    //
    // Buffering used to be exempt too, on the reasoning that the presentation
    // loop is stopped so the queue can't drain and the cap would block the loop
    // forever. That reasoning described a queue that never filled — frames
    // decoded while buffering were being dropped before they reached it — so
    // the exemption was a no-op on the video side and a licence to read without
    // any ceiling at all. Measured during one stall: 14MB pulled in a single
    // uninterrupted burst, the demuxer racing off through the file while the
    // renderer stayed empty. Now that the frames are kept, the cap means
    // something and is the brake. Nothing deadlocks behind it: split audio runs
    // its own loop, and muxed audio starving with the video queue full is
    // exactly what the delta-skip below is for.
    const skipVideoBackpressure = this.isBackgrounded && !this.isPiPActive;

    // Stuck decoder detection: if video decoder queue is full but renderer queue
    // stays empty for too long, the decoder is hung (e.g. 8K content too heavy).
    // Flush it to unstick — some frames may be lost but playback continues.
    if (this.videoDecoder.queueSize > maxVideoQueue && videoBuffered === 0) {
      if (!this._decoderStuckSince) {
        this._decoderStuckSince = performance.now();
      } else if (performance.now() - this._decoderStuckSince > 5000) {
        Logger.warn(TAG, `Video decoder stuck for 5s (queue=${this.videoDecoder.queueSize}, output=0), flushing`);
        this.videoDecoder.flush().catch(() => {});
        this.dropVideoReadAhead();
        this._decoderStuckSince = 0;
      }
    } else {
      this._decoderStuckSince = 0;
    }

    // When the video buffer/decoder queue is full but audio is STARVING, don't
    // block demuxing — set a flag so the demux loop skips video DELTA decode
    // while keeping audio flowing. Critical for content the decoder can't
    // sustain in real time: 120fps, and (the case this was missing) a heavy 8K
    // AV1 MUXED file at 1x, where the decoder falls behind, the backpressure
    // gate stops the whole demux loop, and the muxed audio then underruns and
    // rebuffers every few seconds even though the network is fast.
    //
    // Once gated to non-1x only, on two now-obsolete worries:
    //   - "1x skipping causes early EOF" — the EOF check is near-end-gated
    //     (currentTime >= duration - 0.5), so a mid-file skip can't trip it.
    //   - "skipping AV1 deltas corrupts the reference chain" — the skip below
    //     drops ONLY deltas, keeps every keyframe, and latches
    //     videoChainBrokenUntilKeyframe, so nothing the decoder gets is orphaned
    //     (no EncodingError). Video updates ~1 frame/GOP until audio recovers.
    // So the rate gate is gone. The tight trigger — audio within 100ms of
    // underrun AND the video decoder/buffer genuinely full — means it only ever
    // engages when the pipeline truly can't keep up, never on healthy playback.
    //
    // The 100ms threshold matches latencyHint="interactive"'s ~50-150ms
    // steady-state scheduled buffer; below it audio is genuinely about to
    // underrun and warrants the packet-drop tradeoff.
    // Split (separate-URL) audio is decoded by its OWN loop (audioProcessLoop),
    // not this one. Its buffer intentionally runs a several-second lead, which is
    // far above maxAudioBuffered — so gating THIS (video) loop on the audio
    // buffer/queue would wrongly stop video decode the moment split audio is
    // full, draining the video renderer and freezing the picture (audio keeps
    // playing). Exclude the audio conditions when split audio owns the audio.
    const gateOnAudio = !this.disableAudio && !this.audioDemuxer;
    // The delta-drop below needs that same exclusion, and didn't have it. With
    // split audio this loop's view of the audio buffer reads ~0 no matter how
    // far ahead the audio loop actually is, so audioStarving was permanently
    // true — and every time the video queue filled (which is the normal state
    // on a healthy 4K source) deltas were dropped until the next keyframe.
    // Measured on movi-tube, whose YouTube-style sources are always split:
    // videoChainBrokenUntilKeyframe latched on 9 of 10 seeks with the audio
    // buffer reading 0.000, punching GOP-sized holes in the decoded video. The
    // symptom is the picture freezing for ~0.5-1s a second or two after a seek
    // while the queue sits full and the clock keeps running.
    // A source with no audio at all reads 0 here for the same reason and just
    // as permanently — a video-only file (movi-tube serves exactly these,
    // paired with a separate audio URL) was dropping deltas throughout.
    // A track that has ENDED is not a track that is starving, and this is the
    // third way the same mistake has been made here — after split audio and
    // after a source with no audio at all. A file whose sound stops before its
    // picture does leaves an active audio track behind and an audio buffer
    // that reads 0 for the rest of the film, so this stayed true for the whole
    // video-only tail; with the queue at its cap (which it always is once the
    // sound stops gating the demuxer) the delta-drop then ran for the entire
    // tail. isInVideoOnlyTail exists to be asked exactly this question — its
    // own note says "callers ask this before treating an empty audio buffer as
    // a shortfall" — and this caller was not asking it.
    //
    // Measured on a 243.8s 4K AV1 MKV whose Opus track ends at 193.4s: from
    // 193.4s the renderer queue held ~120 frames scattered across 199s to the
    // last frame at 242.3s — one picture every couple of seconds instead of a
    // contiguous five-second window — and the film advanced by a frame every
    // 1.5s of wall clock for its last fifty seconds while the clock ran on.
    // The stream-ended flag is the same fact from the renderer's side, for the
    // sources where the tail was never learned.
    //
    // Both of those are settled at EOF, which leaves a few seconds of picture
    // decided in the last moments of the soundtrack — the buffer drains under
    // 100ms there because there is no more audio, not because of a shortfall,
    // and with read-ahead that decides several seconds ahead of the playhead.
    // An earlier signal is available in principle: the demuxer reading video
    // from well past the newest audio packet it has seen. Tried, and it made
    // things worse, not better — the tail handover stopped happening at all
    // (neither tail log fired) and the clip stalled dead at the audio end in
    // `buffering`, which is the original bug. Standing the starve protection
    // down that early evidently keeps the loop from reaching EOF, and EOF is
    // what settles the tail. Left alone deliberately; the residual is a few
    // seconds of sparse picture at the handover against fifty before.
    const soundIsOver =
      this.isInVideoOnlyTail() || this.audioRenderer.isStreamEnded();
    const hasAudioToStarve =
      this.trackManager.getActiveAudioTrack() !== null && !soundIsOver;
    // …and only once the sound has actually started. Before the first buffer is
    // scheduled the audio buffer reads 0 because nothing has been asked of it
    // yet, not because it is about to underrun — and a starve verdict there
    // costs picture for a problem that does not exist. Read-ahead, the gentle
    // half of this protection, already stands down outside "playing"; its
    // last-resort sibling did not, so during the startup buffering pass the
    // stash sat over its 180-packet cap with nothing draining it and the drop
    // path took reference deltas instead.
    //
    // Traced on a 5.76s 1080p50 H.264 High 4:2:2 file: three chain breaks
    // inside 8ms at ~140ms in, state "buffering", audio buffer 0 because audio
    // had not begun — a 1.2-second hole in the middle of a six-second clip,
    // with 112 decoded frames sitting in the renderer queue for film that had
    // already been thrown away.
    const audioHasStarted = this.audioRenderer.getMaxScheduledMediaTime() > 0;
    const audioStarving =
      gateOnAudio && hasAudioToStarve && audioHasStarted && audioBuffered < 0.1;
    const videoDecoderFull = this.videoDecoder.queueSize > maxVideoQueue;
    const videoBufferFull = !skipVideoBackpressure && videoBuffered > maxVideoBuffered;
    // Muted is not the same as audio-less. The clock is mastered by audio in
    // every state, so an empty audio buffer stalls playback whether or not
    // anyone can hear it — and gating this protection on `muted` is why a
    // software-decoded file played fine with sound and stuttered with the
    // spinner flashing while it was still on muted autoplay: unmuted, video
    // decode yields to keep audio alive; muted, it didn't, and the buffers ran
    // dry every couple of seconds. The one state where audio really is out of
    // the pipeline is muted-and-suspended (autoplay blocked, pre-gesture),
    // where frames are dropped rather than scheduled.
    const audioInPipeline = !this.audioRenderer.isDroppingAudio();
    const skipVideoDecodeForAudio =
      audioInPipeline && (videoBufferFull || videoDecoderFull) && audioStarving;

    // The renderer's frame cap is a VRAM bound, and on a 4K60 source it is a
    // much SHORTER window than the audio the loop is trying to buffer: 48
    // frames is 0.8s of picture against a 2s audio target. From a single
    // interleaved stream those two cannot both hold — reading 2s of audio means
    // reading 2s of video — so the video cap stops the loop first, every time,
    // and audio never gets near its target. Measured on 4K60 HEVC Main10 at 74
    // Mbps: 794 of 795 backpressure stops were the video cap, not one was the
    // audio cap, and audio oscillated 0.14–0.85s against a 0.1s starve line.
    // Every dip under that line handed the picture to skipVideoDecodeForAudio,
    // which discards video to the next keyframe — the 1–2s freezes, several
    // times a minute, on a file nothing was actually struggling to decode.
    //
    // So when the frame cap is the ONLY thing holding the loop shut and audio
    // is below target, keep reading and STASH the video packets instead of
    // decoding them. Compressed, a GOP costs ~12MB of RAM where the same frames
    // decoded cost ~2.6GB of VRAM, which is the whole reason the frame cap is
    // 48. Nothing is discarded, so the reference chain stays whole and there is
    // no keyframe to wait for; the stash feeds the decoder in order the moment
    // the renderer has room.
    //
    // Gated on the decoder being able to keep up (`!videoDecoderFull`): if
    // video decode is the real bottleneck, reading further ahead only grows the
    // stash. Both bounds turn it off and hand back to plain backpressure.
    // Engage/release the read-ahead latch on audio's distance from starving,
    // clamped so a source whose audio target is below the release mark can still
    // stand down. See the constants for the measurement behind the numbers.
    const engageAt = Math.min(
      MoviPlayer.VIDEO_AHEAD_ENGAGE_AUDIO_S,
      maxAudioBuffered * 0.5,
    );
    const releaseAt = Math.min(
      MoviPlayer.VIDEO_AHEAD_RELEASE_AUDIO_S,
      maxAudioBuffered * 0.9,
    );
    if (this._videoAheadActive) {
      if (audioBuffered >= releaseAt) this._videoAheadActive = false;
    } else if (audioBuffered < engageAt) {
      this._videoAheadActive = true;
    }

    const videoAheadStashFull =
      this._videoAheadStash.length >= MoviPlayer.VIDEO_AHEAD_MAX_PACKETS ||
      this._videoAheadStashBytes >= MoviPlayer.VIDEO_AHEAD_MAX_BYTES;
    // Steady continuous playback only. That is the whole of what this is for —
    // the starve-and-freeze cycle it fixes only exists while the picture is
    // running — and it is also the only state where the stash has no one to
    // disagree with. Pause owns the packet stash for its own buffering, and
    // near EOF a stash is the tail of the picture with nothing left to read to
    // trigger a drain; read-ahead in either state bought nothing and cost a
    // spurious decoder error on resume and a clipped last half-second.
    // ...and not into the last few seconds. Read-ahead holds up to ~3s of
    // picture, and at EOF there is nothing left to read that would trigger a
    // drain, so whatever is still stashed when the file ends never reaches the
    // decoder and the tail freezes on the last queued frame. Standing down
    // before then costs nothing — the starve cycle this fixes needs minutes of
    // runway, not the closing seconds.
    const readAheadDuration = this.getDuration();
    const readAheadNearEnd =
      readAheadDuration > 0 &&
      readAheadDuration - this.getCurrentTime() <=
        MoviPlayer.VIDEO_AHEAD_TAIL_GUARD_S;
    const videoReadAheadForAudio =
      this.stateManager.is("playing") &&
      !this.eofReached &&
      !readAheadNearEnd &&
      gateOnAudio &&
      audioInPipeline &&
      !skipVideoBackpressure &&
      // Either queue being full is a reason to hold video and go for the audio
      // behind it. It used to be the renderer's alone, with `!videoDecoderFull`
      // standing the whole thing down whenever the DECODER was the blockage —
      // on the reasoning that reading further ahead of a decoder that cannot
      // keep up only grows the stash. But the stash is bounded (see
      // VIDEO_AHEAD_MAX_PACKETS / _MAX_BYTES), so it fills and stops, while the
      // audio buried between those packets keeps being read.
      //
      // Standing down there is what starved the audio. Measured on 8K60 AV1:
      // the video decoder queue pinned at its cap of 30, the demux loop stopped
      // on it, the audio DECODER queue read 0 the whole time because nothing
      // reached it, and the audio buffer fell 1.66s -> 0.00s in a straight line
      // over 1.7 seconds and then stalled. The same shape at 1x, just slower.
      (videoBufferFull || videoDecoderFull) &&
      !videoAheadStashFull &&
      this._videoAheadActive &&
      this.pendingPrebufferPackets.length === 0;

    // Audio's cushion must not hold the loop shut while the PICTURE has
    // nothing at all. Coming back from a backgrounded tab the two are at
    // opposite extremes by construction: the background timer kept decoding
    // audio, so its buffer is seconds over target, while video was skipped
    // entirely and its queues are empty. The single "audio is full → read
    // nothing" gate then stopped every read — audio AND video — until the
    // cushion drained back under target in real time. Measured: a 12-second
    // background stint returned with ~3.8s of audio buffered and the first
    // packet was not read for 1.5s, the whole of it with an empty video queue.
    // That was the frozen picture.
    //
    // Narrow on purpose: only while a video-only catch-up is in flight (see
    // _videoResumeTarget), which ends as soon as the first frame lands. The
    // audio DECODER's own queue gate above still applies, so this cannot flood
    // it; all it allows is reading ahead by the few hundred ms the catch-up
    // takes.
    // `>= 0`, not `!== -1`. The field has THREE states — -1 none, a real time
    // while a catch-up is in flight, and -Infinity once it has finished (see
    // the gate in onFrame) — and only the middle one is "catching up". Reading
    // it as `!== -1` made a FINISHED catch-up look permanently in flight, and
    // since this flag lifts the audio ceiling below, the ceiling then stayed
    // lifted for the rest of playback. Measured after a 12s background tab, on
    // return: audio buffered 29.5s against a 2s target and never came down,
    // holding 51 live source nodes — the exact shape that makes a phone's audio
    // thread miss its deadline. A background tab arms a video-only catch-up
    // (see the resume path), so every trip away from the tab left it stuck on.
    const catchingUpVideo = this._videoResumeTarget >= 0;
    // Buffering is the same trap, and the worse one, because it can never end
    // on its own.
    //
    // The player enters "buffering" waiting for VIDEO — that is what the resume
    // gate measures. The audio cap can stop the very reads that would produce
    // it, and while the context is held suspended the audio cushion does not
    // drain, so the cap never clears: no reads, no frames, no resume, forever.
    // Captured on a slow link with a 7.8s cushion: sixty-four seconds in
    // "buffering" without a single demuxer read, and a manual seek — which
    // flushes both sides — was the only way out.
    //
    // Same narrowness as the catch-up above: the audio DECODER's queue gate
    // still applies, so this cannot flood it; all it allows is reading on for
    // the picture the wait is waiting for.
    const bufferingForVideo =
      this.stateManager.is("buffering") &&
      this.hasPicture &&
      !this._audioOnly;
    // The third case, and the one that actually bites on a single interleaved
    // stream: the picture the loop already read is sitting in the read-ahead
    // stash, the renderer has room for it, and the audio cushion — the very
    // cushion that stash was filled to protect — holds the loop shut so it can
    // never be handed over. The drain lives INSIDE the burst, past this return,
    // so "audio has enough" stops video that costs nothing to deliver: it is
    // demuxed, it is in memory, and the decoder is idle.
    //
    // Measured on a 61.6 Mbps 4K60 HEVC .ts, hardware decode, nothing
    // struggling: the renderer queue hit ZERO five times in forty seconds —
    // 22.1s, 28.1s, 34.1s, 40.1s, 46.1s, almost exactly 6s apart — and at every
    // one of them the stash was holding 176 to 197 packets (~3s of picture) and
    // the audio buffer read 2.07 to 2.23s against a 2.0s cap. The picture
    // stopped while three seconds of it sat one function call away. Then audio
    // drained under the cap, the gate opened, the stash flooded back, the
    // renderer jumped to ~66, read-ahead re-engaged, audio overshot 2.0 again,
    // and the whole cycle repeated for the length of the file.
    //
    // Same shape and same reasoning as the two carve-outs above: bounded (the
    // stash only shrinks), self-clearing (once it is empty the cap applies
    // again next tick), and the audio DECODER queue gate above still holds, so
    // this cannot flood anything.
    const stashCanFeedThePicture =
      this._videoAheadStash.length > 0 && videoBuffered <= maxVideoBuffered;
    // The fourth, and the one the cap CAUSES rather than merely fails to
    // prevent: the picture has run out while the cushion is still over its cap.
    //
    // Coming back from a background tab is where it bites. The hidden-tab pump
    // schedules a deeper cushion — 3.1s measured against the 2.0s cap — and the
    // foreground recovery then flushes the video decoder, clears the renderer
    // queue and drops the read-ahead stash, all on purpose. So at the moment of
    // return the audio side is a full second OVER its ceiling and the video
    // side is at zero, and none of the three carve-outs above is standing:
    // _videoResumeTarget cleared the instant the first frame passed it (63ms
    // in), the stash was just dropped, and "buffering" has not happened yet.
    //
    // The gate therefore closes and the demuxer reads NOTHING for as long as
    // the cushion takes to drain under the cap. Read off the session this came
    // from, twice: recovery at 43.471, first frame at 43.545, gate shut,
    // `Stall detected: buffers empty for 500ms` at 44.462 — 917ms of an idle
    // demuxer, a decoder with nothing to do, and an empty renderer. Then
    // buffering makes bufferingForVideo true, the gate opens, the queue
    // refills, playback resumes, the cushion is STILL over the cap, and the
    // whole thing goes round again. Three times in two seconds, each one
    // pausing the clock and suspending the AudioContext, until the audio clock
    // stopped advancing (104.374s logged twice a full second apart) and the
    // picture ran far enough ahead for the desync detector to fire a corrective
    // seek.
    //
    // bufferingForVideo already concedes the whole argument — it exists so the
    // cap cannot hold shut the reads that would end a wait for picture. It just
    // concedes it one stall too late. This is the same rule, before the stop
    // rather than after it.
    //
    // Same shape as the three above: bounded (it clears the moment the queue is
    // off the floor), self-limiting (the video cap and the audio DECODER queue
    // gate both still apply), and it cannot leave the audio ceiling lifted the
    // way `_videoResumeTarget !== -1` once did, because the queue climbing back
    // is what ends it.
    const pictureFloorFrames = Math.max(
      MoviPlayer.PICTURE_FLOOR_MIN_FRAMES,
      Math.min(
        MoviPlayer.PICTURE_FLOOR_MAX_FRAMES,
        Math.floor(maxVideoBuffered / 4),
      ),
    );
    //
    // The DECODER's own queue has to be dry too, and that is what keeps this
    // from becoming the very bug the catch-up flag once was. A machine that
    // cannot decode the source in real time — 8K60 AV1 at ~20fps against 60 —
    // holds the renderer queue at zero permanently: the presentation loop takes
    // every frame the instant it lands. On the renderer queue alone this
    // exemption would then stand for the whole file and lift the audio ceiling
    // with it, which is exactly how one session ended up with 29.5s of audio
    // buffered against a 2s target. But that pipeline is not short of PACKETS —
    // its decoder is backed up with them — and reading more cannot help it. The
    // one this is for has nothing anywhere: no frames, no work queued, and a
    // demuxer sitting idle because of a cushion. Asking both questions
    // separates them exactly.
    //
    // …and picture sitting in the read-ahead stash is picture, so it is not
    // "run out" either. Without that clause this exemption is unbounded in the
    // one state where it cannot clear itself: after a seek the renderer is
    // empty and the decoder is dry, and if what the loop reads goes to the
    // STASH rather than the decoder, both stay that way however much is read.
    // Measured on the 163.766s 8K file, a seek to 75.06s: 4912 stashed packets
    // and 73.5s of decoded audio inside 500ms, and `eofReached` set at 75s of a
    // 164s film — the flag that later ended the film 77 seconds early. The
    // stash's own drain (stashCanFeedThePicture) still runs, so the picture is
    // handed over rather than waited for; this only stops the demuxer racing
    // off through the file to fetch more of what it is already holding.
    const pictureHasRunOut =
      this.hasPicture &&
      videoBuffered <= pictureFloorFrames &&
      videoBuffered < maxVideoBuffered &&
      this.videoDecoder.queueSize <= pictureFloorFrames &&
      this._videoAheadStash.length === 0;
    // …and this tick is running ONLY on that exemption when the audio cap is
    // the one thing it stepped over. The burst below must then stop the moment
    // the stash is empty: the exemption was granted to hand over picture
    // already in memory, not to read further bytes past a cushion that is
    // already full.
    // A ceiling none of the four carve-outs above may step over.
    //
    // Each of them lifts the audio cap for a good reason and each says the same
    // thing in its comment — "the audio DECODER's queue gate still applies, so
    // this cannot flood it". That gate does not hold. Decoded audio leaves the
    // decoder queue immediately for the renderer's pending list, which has no
    // bound at all, so the decoder queue reads near zero however long the loop
    // runs and nothing ever closes the gate again.
    //
    // Measured, from a session on the 163.766s 8K file: a thumbnail-hover seek
    // to 75.06s forced its completion with no frame yet decoded, which put the
    // player in "buffering" and armed bufferingForVideo. The loop then read the
    // whole REST OF THE FILE in about a second — `queued=71230ms`, seventy-one
    // seconds of decoded audio against a 2s target — and set eofReached at 75s
    // of a 164s film. Playback carried on to 85s with that flag stuck true, and
    // the next pause/resume was enough for the ended test (decoders drained,
    // clock past the furthest scheduled audio) to declare the film over and
    // jump the clock to 163.766s. "Achanak se end ho gaya", 77 seconds early.
    //
    // The carve-outs need a second or two of reading to do their job; none of
    // them needs three times the target, let alone thirty-five. Past the
    // ceiling the two that read NEW bytes — the background-tab catch-up and the
    // wait for a first frame — stop excusing the cushion.
    //
    // The other two are deliberately left alone, and a first attempt that
    // applied the ceiling to all four deadlocked on this very file: with 57s of
    // audio banked the gate shut for good, the 3490-packet read-ahead stash
    // could then never be handed over, so no frame ever arrived, so the state
    // stayed "buffering" forever with the picture black. stashCanFeedThePicture
    // hands over packets already in memory (stashOnlyPass stops the burst the
    // moment the stash is empty, so it reads no further bytes) and
    // pictureHasRunOut fires only when there is no picture and no decoder work
    // anywhere — reading is the only way out of both. A cushion is never a
    // reason to refuse either.
    const audioCarveOutCeilingHit =
      audioBuffered > maxAudioBuffered * MoviPlayer.AUDIO_CARVEOUT_MAX_MULT;
    const stashOnlyPass =
      stashCanFeedThePicture &&
      gateOnAudio &&
      !catchingUpVideo &&
      !bufferingForVideo &&
      // …and not when the picture running out is what got this tick through.
      // That exemption is not about handing over packets already in memory, so
      // stopping the burst at an empty stash would end it before it has read
      // the one thing it was granted for.
      !pictureHasRunOut &&
      audioBuffered > maxAudioBuffered;
    if (
      (!skipVideoBackpressure &&
        !skipVideoDecodeForAudio &&
        // Stashing does not feed the decoder, so its queue being full is no
        // reason to stop reading — the audio behind those packets is the point.
        !videoReadAheadForAudio &&
        this.videoDecoder.queueSize > maxVideoQueue) ||
      (gateOnAudio && this.audioDecoder.queueSize > maxAudioQueue) ||
      (gateOnAudio &&
        !(catchingUpVideo && !audioCarveOutCeilingHit) &&
        !(bufferingForVideo && !audioCarveOutCeilingHit) &&
        !stashCanFeedThePicture &&
        !pictureHasRunOut &&
        audioBuffered > maxAudioBuffered) ||
      (!skipVideoBackpressure &&
        !skipVideoDecodeForAudio &&
        !videoReadAheadForAudio &&
        videoBuffered > maxVideoBuffered)
    ) {
      if (
        this.waitingForVideoSync &&
        (this.videoDecoder.queueSize > maxVideoQueue ||
          videoBuffered > maxVideoBuffered)
      ) {
        Logger.debug(
          TAG,
          `Backpressure during sync: videoDecoder=${this.videoDecoder.queueSize}, videoBuffered=${videoBuffered}`,
        );
      }
      return;
    }

    // Read packet
    try {
      // Final check before starting async operation - ensure no new seek started
      if (this.seekSessionId !== currentSessionId) {
        Logger.debug(TAG, "ProcessLoop aborted before demux: new seek started");
        return;
      }

      this.demuxInFlight = true;
      this.demuxInFlightStartTime = performance.now();

      // Determine burst size based on buffer levels, post-seek state, and FPS.
      // High-FPS content (120fps) has ~120 video packets per ~47 audio packets.
      // A burst of 20 may only yield 1-2 audio packets (~42ms) which isn't enough
      // to prevent audio buffer underruns between rAF callbacks (~16.7ms).
      const fps = this.trackManager?.getActiveVideoTrack()?.frameRate ?? 30;
      const fpsScale = Math.max(1, Math.ceil(fps / 30)); // 1x for 30fps, 2x for 60fps, 4x for 120fps
      let burstSize = 20 * fpsScale;

      if (isPostSeek) {
        burstSize = 5 * fpsScale;

        // ...but never at the cost of starving audio. Burst is a PACKET cap,
        // and codecs with tiny packets carry almost no audio per packet —
        // TrueHD emits ~40 frames (~0.8ms @48kHz) each. Interleaved with
        // video, a 5-packet burst yields only a couple of ms of audio per
        // tick: an order of magnitude below realtime. The renderer then runs
        // dry for the whole POST_SEEK_THROTTLE_MS window, so every seek on a
        // TrueHD/DTS source was followed by ~1s of chopped-up audio. Until
        // the cushion is back, read at the same dense-interleave rate the
        // normal path uses (self-limiting: the outer backpressure gate stops
        // the reads once the targets are met).
        const hasMuxedAudio =
          !this.disableAudio && !!this.trackManager?.getActiveAudioTrack();
        if (hasMuxedAudio && audioBuffered < 1.0) {
          burstSize = 160 * fpsScale;
        }

        Logger.debug(
          TAG,
          `Post-seek throttling: using burst size ${burstSize}`,
        );
      } else {
        // Clear the justSeeked flag after throttle period
        if (
          this.justSeeked &&
          timeSinceSeek >= MoviPlayer.POST_SEEK_THROTTLE_MS
        ) {
          this.justSeeked = false;
          Logger.debug(TAG, "Post-seek throttle period ended");
        }

        // Normal burst size logic
        const videoQueue = this.videoRenderer?.getQueueSize() ?? 0;
        const currentAudioBuffered = this.audioRenderer.getBufferedDuration();

        // If buffers are low, increase burst size to fill faster.
        // High-FPS needs more headroom because audio packets are sparse among video packets.
        // During initial play grace period with audio active, use a gentler burst to
        // avoid overwhelming the main thread (audio decode + render + stable audio
        // processing is CPU-heavy alongside 4K video decode).
        // `isSoftware` is the VIDEO decoder's state, so a hardware-decoded
        // HEVC/AV1 file carrying TrueHD/DTS landed on the thin 0.5s target even
        // though its audio is the expensive, sub-realtime software path. That
        // left no headroom: any hiccup drained the renderer and it patched the
        // hole with silence ("Gap filled"). Software audio gets the deep target
        // too, independent of how the video is decoded.
        const softwareAudio = !this.disableAudio && this.audioDecoder.usesSoftware;
        const bufferTarget =
          isSoftware || softwareAudio ? 2.0 : fps >= 60 ? 1.0 : 0.5;
        if (videoQueue < 30 || currentAudioBuffered < bufferTarget) {
          if (
            inPlayGrace &&
            !this.audioRenderer.isDroppingAudio() &&
            !this.disableAudio &&
            !isSoftware &&
            // Software audio can't afford the gentle ramp either — 20 packets a
            // tick is a few ms of TrueHD, nowhere near realtime.
            !softwareAudio
          ) {
            burstSize = 20 * fpsScale; // Gentler ramp during initial fill with audio
          } else {
            // Burst is a PACKET cap, but what matters for a cushion is how many
            // VIDEO packets it reads — and in a heavily-interleaved file that
            // can be a tiny fraction. e.g. a dual-audio 1080p TrueHD source
            // reads ~933 pkt/s PER audio track vs ~19 video pkt/s, so a
            // 40-packet burst pulls only ~0.4 video packets and video can never
            // read ahead of realtime → no cushion → a stall on any hiccup
            // (issue #11, "stalls every ~60s" on a 2×TrueHD file). A larger cap
            // lets video outpace consumption and build a cushion; it stays
            // self-limiting because the outer backpressure gate stops reading
            // once videoBuffered/audioBuffered pass their targets, and the
            // periodic MessageChannel yield below keeps the tick non-blocking.
            burstSize = (isSoftware ? 160 : 160) * fpsScale;
          }
        }
      }

      // For video-only content, throttle submissions based on renderer queue.
      // Without audio backpressure, all packets get submitted in one burst which
      // overwhelms VP8/software WebCodecs decoders (output callbacks stop firing).
      const hasAudioForBurst = !!this.trackManager?.getActiveAudioTrack() && !this.disableAudio;
      const maxRendererQueue = 60; // ~2.4s at 25fps, enough buffer without overwhelming

      // When decoder is skipping frames (waitingForKeyframe after error), limit burst
      // to prevent the demuxer from racing through the entire file in one rAF.
      // Without this, non-keyframes skip silently → no backpressure → early EOF.
      if (this.videoDecoder.isWaitingForKeyframe) {
        burstSize = Math.min(burstSize, 5);
      }

      for (let i = 0; i < burstSize; i++) {
        // Handing over the stash was the whole reason this tick got past the
        // audio cap — see stashOnlyPass — or past the EOF return above. With
        // the stash empty the exemption is spent: reading on would push a
        // cushion that is already over its target further over it, or ask an
        // exhausted demuxer for bytes that aren't there.
        if (
          (stashOnlyPass || this.eofReached) &&
          this._videoAheadStash.length === 0
        ) {
          break;
        }

        // Video-only throttle: if renderer queue is full enough, stop submitting
        // and let the presentation loop consume frames before adding more.
        if (!hasAudioForBurst && this.videoRenderer && this.videoRenderer.getQueueSize() > maxRendererQueue) {
          break;
        }

        // Check both video and audio queues after seek to prevent overwhelming decoders
        // When audio is starving, don't let video queue fullness stop the burst — we need
        // to keep reading packets to find audio data (video decode is skipped below).
        //
        // The AUDIO queue does not gate the prebuffer stash. Those packets were
        // read before playback began and are already in memory; holding them
        // back throttles them out at audio-decode speed, and the video packets
        // buried behind them arrive at that same crawl. On a file whose opening
        // is dense with audio — two TrueHD tracks here — the stash ended up
        // holding 400 packets and exactly one video frame, so the picture sat
        // on that frame for half a minute while slow software audio decode let
        // the rest dribble through. Seeking cleared the stash, which is why a
        // seek "fixed" it.
        const drainingStash = this.pendingPrebufferPackets.length > 0;
        if (
          (!skipVideoDecodeForAudio &&
            !videoReadAheadForAudio &&
            this.videoDecoder.queueSize > maxVideoQueue) ||
          (!drainingStash && !this.disableAudio && this.audioDecoder.queueSize > maxAudioQueue)
        ) {
          // Queue getting full, stop to let decoders catch up
          if (isPostSeek) {
            Logger.debug(
              TAG,
              `Post-seek: queue full (video: ${this.videoDecoder.queueSize}, audio: ${this.audioDecoder.queueSize}), pausing burst`,
            );
          }
          break;
        }

        // Yield periodically to prevent blocking the main thread, especially in software mode
        // Scale with FPS — at 120fps, packets are small and fast, yielding too often starves audio
        const yieldInterval = isPostSeek ? 2 * fpsScale : isSoftware ? 3 : 20 * fpsScale;
        if (i > 0 && i % yieldInterval === 0) {
          // Use MessageChannel for fast yielding (better than setTimeout)
          const channel = new MessageChannel();
          await new Promise((resolve) => {
            channel.port1.onmessage = resolve;
            channel.port2.postMessage(null);
          });

          // Check if a new seek started during yield
          if (this.seekSessionId !== currentSessionId) {
            Logger.debug(
              TAG,
              "ProcessLoop aborted during packet read: new seek started",
            );
            this.demuxInFlight = false; // Reset flag so new seek can proceed
            return;
          }
        }

        // Drain prebuffered packets first so play() doesn't re-read them
        // from the source. Stashed packets are pre-seek and always safe.
        // A flush — seek, resume, resolution change, stuck-decoder recovery —
        // resets the decoder's reference chain, and everything already stashed
        // was read against the OLD one. Feeding it afterwards is exactly the
        // orphaned-delta EncodingError the stash exists to avoid; it fired twice
        // on resume when this was checked once per tick instead, because a flush
        // lands mid-burst. So check it at the point of USE, and key the stash's
        // lifetime on the decoder waiting for a keyframe — the one signal that
        // covers every flush path, including ones added later.
        //
        // The prebuffer/pause stash invalidates it for the same reason without
        // ever touching the decoder: those packets are read by a seek or a
        // pause AFTER the ones sitting here, and they drain FIRST (below). Both
        // stashes holding at once therefore feeds newer packets and then older
        // ones — which is the out-of-order garbage that errored on every
        // resume. They must never coexist, and the newer stash wins.
        //
        // On the EDGE of that, not for as long as it lasts. Both conditions
        // hold across many iterations of this burst — a keyframe wait runs to
        // the end of a GOP, a prebuffer drain to the end of the stash — and an
        // unconditional drop inside the loop therefore bins whatever landed in
        // the read-ahead stash since the previous iteration, one packet at a
        // time, re-breaking the reference chain on each. What the rule is
        // actually about is the packets that were in the stash when the
        // condition BEGAN: those are the ones read against the old reference
        // chain, or older than the stash that now outranks them. Everything
        // arriving afterwards was read against the state we are already in, and
        // is exactly what the decoder needs the moment a keyframe lands.
        //
        // Traced on a 5.76s 1080p50 H.264 High 4:2:2 file: three of these fired
        // within 2ms of each other during the post-seek fill, each costing the
        // deltas of a GOP, and the picture stood still for 1.2s in the middle
        // of the clip with 112 frames sitting decoded in the renderer queue —
        // frames for a stretch of film that had already been thrown away.
        const readAheadInvalidated =
          this.videoDecoder.isWaitingForKeyframe ||
          this.pendingPrebufferPackets.length > 0;
        if (readAheadInvalidated) {
          if (!this._readAheadInvalidated) {
            this._readAheadInvalidated = true;
            this.dropVideoReadAhead();
          }
        } else {
          this._readAheadInvalidated = false;
        }

        // Ground the picture has already passed. The stash is a queue of video
        // read ahead, and on a long enough run the picture overtakes its head:
        // measured on 8K60 AV1 after coming back from 2x, 460 packets with the
        // OLDEST at 35.133s while the screen was showing 41.283s — six seconds
        // behind. Every frame those make is refused as older than what is on
        // screen, then pruned, so the decoder spends itself producing pictures
        // that can never be shown while the one thing it is short of is time.
        // That is what holds the picture still for seconds after a speed
        // change; it starts again only when the head finally passes the screen.
        //
        // So skip them — but only as far as a keyframe, because everything
        // after the cut needs its references. No keyframe in the stale run
        // means no clean cut is available and it is left alone; better a hold
        // than an orphaned decoder.
        this.trimOvertakenReadAhead();

        let packet: Packet | null;
        let fromAheadStash = false;
        if (this.pendingPrebufferPackets.length > 0) {
          packet = this.pendingPrebufferPackets.shift()!;
        } else if (
          this._videoAheadStash.length > 0 &&
          ((this.videoRenderer?.getQueueSize() ?? 0) <= maxVideoBuffered ||
            this.eofReached) &&
          // …but not while the sound is running out. Draining the stash feeds
          // the decoder without touching the demuxer, so a deep stash and an
          // empty renderer together meant the loop spent every burst handing
          // video back and never read a packet again — and the audio
          // interleaved behind those packets never arrived. Measured on 8K60
          // AV1 at 2x: a 353-packet stash draining while the audio buffer went
          // 1.63s -> 0.00s in a straight line underneath it.
          //
          // Read live: this is inside the burst, and the tick-level snapshot is
          // stale by the time it matters. The stash is not lost, only deferred
          // again — it drains as soon as the sound is comfortable.
          (this.eofReached ||
            !gateOnAudio ||
            // No audio track means no sound to hold the drain open for, and
            // its buffer reads 0 forever — so this rule, meant to keep the
            // loop reading while the sound runs low, instead never let the
            // stash drain at all. Measured on a video-only 4K HEVC transport
            // stream: the loop swallowed the ENTIRE file into the stash in 4.4
            // seconds — 11,131 packets, one null read, and not a single read
            // afterwards — then played the next minute out of memory with the
            // demuxer idle and eofReached latched. Whatever the stash could not
            // hold was the rest of the film.
            !hasAudioToStarve ||
            this.audioRenderer.getBufferedDuration() >=
              maxAudioBuffered * MoviPlayer.STASH_DRAIN_AUDIO_FRACTION)
        ) {
          fromAheadStash = true;
          // Room in the renderer again — hand back the video that was read past
          // it, oldest first, before pulling anything new off the demuxer.
          packet = this._videoAheadStash.shift()!;
          this._videoAheadStashBytes = Math.max(
            0,
            this._videoAheadStashBytes - packet.data.length,
          );
        } else {
          // When separate audio demuxer exists, primary demuxer only provides video/subtitle
          packet = await this.demuxer.readPacket();

          // Check again after async readPacket - seek may have started during read
          if (this.seekSessionId !== currentSessionId) {
            Logger.debug(
              TAG,
              "ProcessLoop aborted after readPacket: new seek started",
            );
            this.demuxInFlight = false; // Reset flag so new seek can proceed
            return;
          }
        }

        if (!packet) {
          // No bytes can mean two very different things, and they arrive
          // identically. The demuxer reads through a C callback that answers
          // with a byte count, so a read that FAILED looks exactly like the end
          // of the file: FFmpeg reports EOF either way. A source that had been
          // refused mid-file therefore ended the video — the picture stopped,
          // the clock jumped to the duration, and anything watching for "ended"
          // (an autoplay-next, a playlist) moved on as though the video had
          // simply finished. Ask the source which of the two this was.
          const sourceFailure = (
            this.source as { getFatalError?: () => Error | null } | null
          )?.getFatalError?.();
          if (sourceFailure) {
            Logger.error(
              TAG,
              `Read returned nothing because the source failed, not because the file ended: ${sourceFailure.message}`,
            );
            throw sourceFailure;
          }
          // EOF reached - mark it but don't stop immediately
          // Let the decoders finish processing
          if (!this.eofReached) this.eofSince = performance.now();
          this.eofReached = true;

          // Clear seeking flag if we hit EOF before finding keyframe
          if (this.seekingToKeyframe) {
            this.seekingToKeyframe = false;
            Logger.warn(TAG, "EOF reached before finding keyframe after seek");
          }

          // If we were waiting for sync, trigger it now so player doesn't hang in loading state
          if (this.waitingForVideoSync) {
            Logger.warn(
              TAG,
              "EOF reached while waiting for seek sync, forcing completion",
            );
            // forced=true: this is a no-frame forced completion (the decoder
            // exhausted the stream without a decodable frame — e.g. an open-GOP
            // 4K AV1 whose keyframes the HW decoder keeps rejecting). Without the
            // flag, notifySeekCompletion advances the clock straight into
            // "playing" over a BLACK screen (framesPresented=0) that only a
            // manual seek recovers. With it, the forcedWithoutFrame path resumes
            // into "buffering" with play intent latched, so the first frame that
            // actually decodes — e.g. after the ABR downshifts to a rendition the
            // decoder CAN handle — auto-flips to "playing". Matches the seek-
            // timeout path, which already passes forced=true.
            this.notifySeekCompletion(this.seekTargetTime, true);
          }

          // The read-ahead stash still holds the tail of the picture: those
          // packets were read PAST the renderer's cap to get at the audio
          // behind them, and nothing further will be read now to trigger a
          // drain. Breaking here strands them and the last second freezes on
          // whatever frame was already queued. eofReached is set above, which
          // opens the drain branch unconditionally, so go round again.
          if (this._videoAheadStash.length > 0) {
            continue;
          }

          Logger.debug(TAG, "EOF reached");
          break;
        }

        // Dispatch to decoders/renderers
        if (this.trackManager.isActiveStream(packet.streamIndex)) {
          const activeVideo = this.trackManager.getActiveVideoTrack();
          const activeAudio = this.trackManager.getActiveAudioTrack();

          if (activeVideo && activeVideo.id === packet.streamIndex) {
            // A video packet exists at this position, whatever anyone decided
            // earlier — recorded before the skips below, which drop the DECODE
            // and not the evidence. Past a tail start, it also retracts it: the
            // container under-declared its video duration, or this is a gap in
            // the middle of the file rather than the end of the picture.
            this._lastVideoPacketPts = packet.timestamp;
            this._videoPacketsSinceAudio++;
            if (packet.timestamp > this._videoTailStart) {
              Logger.info(
                TAG,
                `Video resumed at ${packet.timestamp.toFixed(2)}s, past the expected end of the picture — clearing the audio-only tail`,
              );
              this._videoTailStart = Number.POSITIVE_INFINITY;
            }
            // Audio-only mode: skip ALL video decoding to save CPU. Decode is
            // the expensive part; the interleaved bytes still arrive (no single-
            // file bandwidth saving — that's the adaptive-stream wrapper's job),
            // but the GPU/CPU video pipeline stays idle. Toggling back to video
            // re-seeks to recover a keyframe (see setAudioOnly).
            if (this._audioOnly) {
              continue;
            }

            // Read-ahead: the renderer's frame queue is full but audio is still
            // hungry, so this packet was read only to get at the audio behind
            // it. Hold it compressed rather than decoding it into a queue with
            // no room — or discarding it, which is what breaks the chain and
            // freezes the picture. It goes to the decoder, in order, as soon as
            // the renderer drains. See videoReadAheadForAudio above.
            //
            // "In order" is the whole contract, and it needs the second clause
            // to hold. The read-ahead flag is decided ONCE per tick, so a tick
            // that reads video while the flag is off — the latch released
            // because audio recovered, say — sent its packet straight to the
            // decoder while the stash still held older ones. The decoder then
            // got the file's closing packets and, once the stash finally
            // drained, three seconds of the middle behind them. Captured on a
            // 61.6 Mbps 4K60 HEVC .ts: pts 47.4964, then 48.3306 — the last
            // packet in the stream — then 45.4778, and WebCodecs answered with
            // EncodingError, closed the decoder, and dropped the 175-packet
            // stash on the keyframe wait that followed. That is the "decoder
            // error out of nowhere" this stash was supposed to prevent.
            //
            // So: while anything is stashed, nothing may overtake it. A
            // freshly-read packet goes to the back of the queue, and the
            // decoder is fed only from the front (the drain branch above).
            const mustQueueBehindStash =
              !fromAheadStash && this._videoAheadStash.length > 0;
            if (
              !fromAheadStash &&
              (mustQueueBehindStash ||
                (videoReadAheadForAudio &&
                  // Measured live. `videoAheadStashFull` is decided once a tick,
                  // and a burst can push hundreds past it: 353 packets against a
                  // 180 cap on one 8K rate change.
                  this._videoAheadStash.length <
                    MoviPlayer.VIDEO_AHEAD_MAX_PACKETS &&
                  this._videoAheadStashBytes <
                    MoviPlayer.VIDEO_AHEAD_MAX_BYTES &&
                  ((this.videoRenderer?.getQueueSize() ?? 0) > maxVideoBuffered ||
                    this.videoDecoder.queueSize > maxVideoQueue)))
            ) {
              this._videoAheadStash.push(packet);
              this._videoAheadStashBytes += packet.data.length;
              continue;
            }
            // In background (not PiP), skip video decoding entirely.
            // This prevents frame queue buildup that blocks audio demuxing via backpressure.
            // At 60fps, video queue fills in ~1.7s and starves audio.
            if (this.isBackgrounded && !this.isPiPActive) {
              continue;
            }

            // Skip video decode when video buffer is full but audio is starving.
            // This keeps audio flowing at non-1x rates where video frames accumulate
            // faster than consumed. Some video frames are lost but audio stays smooth.
            //
            // Keyframes-only during the starve: AV1's inter-frame dependency means
            // dropping a non-keyframe orphans every delta that references it, so
            // feeding those deltas to the decoder throws EncodingError → decoder
            // close → recreate→keyframe-wait recovery (noisy, and a momentary
            // freeze). Dropping ALL video (the old behavior) is even worse — the
            // next decoded delta is still an orphan, so the error fires the
            // moment the starve ends. Instead we keep decoding keyframes and skip
            // only deltas: each keyframe is a self-contained reference reset, so
            // nothing the decoder receives is ever orphaned — no EncodingError.
            // Video updates at roughly one frame per GOP (~0.5fps on a 2s GOP)
            // until audio recovers, then full-rate decode resumes at the next
            // keyframe with the reference chain intact.
            if (skipVideoDecodeForAudio && !packet.keyframe) {
              // Spend the non-reference pictures first. Nothing in the stream
              // points at them, so dropping one leaves the reference chain whole
              // and every delta behind it still decodes — the picture keeps
              // moving on the reference frames in between instead of holding
              // still. On the 4K60 HEVC Main 10 source this was measured
              // against, the GOP runs one reference picture to every two
              // non-reference ones (978 of 1475 deltas over 25s), so this covers
              // two thirds of what the starve needs at no cost to the chain.
              if (packet.disposable) {
                continue;
              }
              // A reference delta is not free: dropping one orphans everything
              // after it until a keyframe, and on that same source keyframes run
              // ~2s apart, so the cost of a drop here is up to two seconds of
              // frozen picture. Defer it instead — compressed in the read-ahead
              // stash a GOP costs ~12MB against the ~2.6GB the same frames cost
              // decoded, and the drain above feeds it back in order the moment
              // the renderer has room. Dropping is what's left when the stash is
              // full too.
              //
              // Measured live, not from the tick's snapshot: the stash grows
              // inside this burst, and a stale "not full" would push past the
              // bound it exists to hold.
              const stashFull =
                this._videoAheadStash.length >=
                  MoviPlayer.VIDEO_AHEAD_MAX_PACKETS ||
                this._videoAheadStashBytes >= MoviPlayer.VIDEO_AHEAD_MAX_BYTES;
              if (!stashFull) {
                if (fromAheadStash) {
                  // This packet came OUT of the stash a moment ago (the renderer
                  // had room, the decoder queue did not). Appending it would put
                  // it behind everything still queued — out of decode order,
                  // which is its own EncodingError. Put it back where it was and
                  // let the next tick retry.
                  this._videoAheadStash.unshift(packet);
                  this._videoAheadStashBytes += packet.data.length;
                  break;
                }
                this._videoAheadStash.push(packet);
                this._videoAheadStashBytes += packet.data.length;
                continue;
              }
              // …and only while breaking the chain can still buy something.
              //
              // What it buys is AUDIO: the loop reads on and finds the sound
              // buried between the video packets. When the demuxer has read
              // video well past the newest audio packet it has ever seen there
              // is no such sound — the track has ended in the file — and this
              // spends a GOP of picture on nothing. That is the last few
              // seconds of a soundtrack that stops before the picture does: the
              // buffer drains under the starve line because the track is over,
              // the queue is at its cap, and within a second and a half the
              // stash is five times its bound and this has broken the chain.
              // Measured on the 243.8s file whose Opus ends at 193.4s — one
              // GOP lost there is the four seconds of frozen picture and the
              // spinner at 3:21, seconds after the sound stops.
              //
              // Asked HERE rather than of the starve verdict itself. Standing
              // the whole protection down on this signal was tried and broke
              // the tail handover outright (see soundIsOver); this changes
              // nothing but the last resort, in the one case where the last
              // resort has nothing to gain. Backpressure is what is left: stop
              // reading, let the renderer drain into the room the stash needs,
              // and keep the picture whole. Nothing deadlocks behind it — the
              // stash's own drain feeds the decoder as the queue empties.
              //
              // Asked two ways, because the pts gap alone answers too late.
              // Read-ahead makes several seconds of video-ahead-of-audio
              // ordinary, so that bar has to be wide — and the demuxer covers
              // the width of it in half a second once the sound stops gating
              // it, breaking the chain on the way past. Measured: the break
              // landed with the demuxer 4.6s past the last audio packet,
              // under the 6s bar, and surfaced as a 1.9s hole five seconds
              // later because the stash it had already filled was ~1000
              // packets deep. The COUNT trips first and does not depend on
              // how far read-ahead runs: audio packets outnumber video ones
              // on any ordinary interleave, so a run this long with none
              // between means the track has ended.
              const soundStillComing =
                !!this.audioDemuxer ||
                this._lastAudioPacketPts < 0 ||
                (this._videoPacketsSinceAudio <
                  MoviPlayer.VIDEO_AHEAD_MAX_PACKETS &&
                  this._lastVideoPacketPts <=
                    this._lastAudioPacketPts + MoviPlayer.AUDIO_TAIL_GAP_S);
              if (!soundStillComing) {
                // Holding the packet, so keep it. Breaking with it in hand
                // discards it as silently as the drop this branch exists to
                // avoid — and once per burst, which is once per packet:
                // measured as 37 consecutive reference deltas gone, a 1.9s
                // hole in the picture with the chain intact, nothing logged,
                // and the renderer sitting on a full queue whose head was two
                // seconds ahead of the clock. Same ordering rule as the stash
                // push above: one that came OUT of the stash goes back to the
                // front, a freshly-read one to the back.
                if (fromAheadStash) {
                  this._videoAheadStash.unshift(packet);
                } else {
                  this._videoAheadStash.push(packet);
                }
                this._videoAheadStashBytes += packet.data.length;
                break;
              }
              // A delta was skipped, so every following delta is now orphaned
              // until the next keyframe rebuilds the reference chain. Latch this
              // so that even after the starve clears we keep skipping deltas
              // until a keyframe — otherwise the first post-starve delta is an
              // orphan and throws the very EncodingError we're avoiding.
              this.videoChainBrokenUntilKeyframe = true;
              continue;
            }
            // Reference chain broken by an earlier skip: keep dropping deltas
            // until a keyframe resets it, regardless of current starve state.
            if (this.videoChainBrokenUntilKeyframe) {
              if (!packet.keyframe) {
                continue;
              }
              this.videoChainBrokenUntilKeyframe = false;
              // Not every keyframe rebuilds the chain. An open-GOP CRA is fed to
              // the decoder as `delta`, and the RASL leading pictures that trail
              // it still point at the GOP this starve just dropped — feeding them
              // closes the decoder. Keep dropping until the first trailing
              // picture, which references the CRA onward. Measured on 4K60 HEVC
              // Main10 (CRA on roughly every other GOP): a 2s starve resumed on
              // the CRA at 15.482s and EncodingError closed the decoder ~35
              // frames later, mid-GOP, far from anything that looked related.
              this.videoSkipRaslAfterChainCra = !packet.isIdr;
            } else if (this.videoSkipRaslAfterChainCra) {
              if (packet.isRasl) {
                continue;
              }
              this.videoSkipRaslAfterChainCra = false;
            }

            // After seek, skip non-keyframe video packets until we find a keyframe
            // This prevents decoder errors (decoder needs keyframe after flush)
            if (this.seekingToKeyframe) {
              // Check timeout - if we've been waiting too long, give up and accept any frame
              const elapsed =
                performance.now() - this.seekingToKeyframeStartTime;
              this.seekKeyframeScanned++;
              // Where the demuxer actually landed, once per seek.
              //
              // "First frame arrived N seconds past the target" has two very
              // different causes and the completion log cannot tell them apart:
              // the seek went back to the keyframe before the target and the
              // GOP is simply long (fine — the pre-target frames are decoded
              // and dropped), or the seek landed mid-GOP and the next keyframe
              // is a whole GOP ahead (not fine — that is content the viewer
              // asked for and will never see). The first packet after the seek
              // separates them: at/before the target means the former, at the
              // target means the latter.
              if (this.seekKeyframeScanned === 1) {
                Logger.debug(
                  TAG,
                  `Post-seek first packet: pts=${packet.timestamp.toFixed(3)}s keyframe=${packet.keyframe} idr=${packet.isIdr} (target=${this.seekTargetTime.toFixed(3)}s, delta=${(packet.timestamp - this.seekTargetTime).toFixed(3)}s)`,
                );
              }
              // Prefer a true IDR to restart: on mixed-keyframe HEVC a CRA sent
              // as `key` is rejected by the HW decoder (open-GOP) and forces a
              // software fallback, while an IDR restarts cleanly. But accept a
              // CRA if no IDR arrives quickly — some streams have only CRA
              // keyframes for long stretches (seeking deep into a DoVi P8 .ts),
              // where waiting for an IDR never resumes and the video stays black.
              const idrWaitElapsed = elapsed > MoviPlayer.SEEK_IDR_WAIT_MS;
              // A CRA at/before the seek target IS the demuxer's restart point —
              // decode straight from it (pre-target frames are dropped by the
              // onFrame filter). The IDR-preference below only helps when a true
              // IDR sits within a few frames of the target; a CRA-only stream
              // has none, and skipping the target CRA then lets the demux loop
              // (which outruns the 400ms wall-clock IDR wait) race through the
              // whole file, skipping every CRA to EOF with no frame decoded →
              // permanent "buffering". So accept the target CRA outright rather
              // than hunt for an IDR that never arrives.
              const isTargetCra =
                packet.keyframe &&
                this.seekTargetTime !== -1 &&
                packet.timestamp <= this.seekTargetTime + 0.05;
              const acceptThisKeyframe =
                packet.keyframe && (packet.isIdr || idrWaitElapsed || isTargetCra);
              // Starved (few packets scanned) means we're waiting on the network,
              // not on a distant keyframe — extend to the hard ceiling instead of
              // feeding the decoder a non-keyframe and painting black.
              const starved =
                this.seekKeyframeScanned < MoviPlayer.SEEK_KEYFRAME_MIN_SCAN;
              const timedOut =
                elapsed >
                (starved
                  ? MoviPlayer.KEYFRAME_SEEK_HARD_TIMEOUT
                  : MoviPlayer.KEYFRAME_SEEK_TIMEOUT);
              if (timedOut) {
                Logger.warn(
                  TAG,
                  `Keyframe seek timeout after ${elapsed.toFixed(0)}ms (scanned=${this.seekKeyframeScanned}, starved=${starved}), accepting any frame`,
                );
                this.seekingToKeyframe = false;
              } else if (!acceptThisKeyframe) {
                // Not yet: skip non-keyframes, and skip CRA keyframes while still
                // within the short IDR-wait window (hoping a true IDR is near).
                if (packet.keyframe) this.seekCraSeen++;
                continue;
              } else {
                // Found a keyframe to restart on (IDR, or a CRA after the wait).
                this.seekingToKeyframe = false;
                Logger.debug(
                  TAG,
                  `Found ${packet.isIdr ? "IDR" : "CRA"} keyframe after seek (craSkipped=${this.seekCraSeen}), resuming normal playback`,
                );
                this.seekCraSeen = 0;
              }
            }

            // Re-reading ground the decoder has already covered — an audio
            // rewind moved the shared cursor back, and the picture never
            // stopped. Decoding these again would paint frames that are behind
            // the clock (dropped as stale) at exactly the moment the machine is
            // busiest. Skipped until the cursor passes the last packet fed, and
            // then the stream continues into a decoder whose references were
            // never disturbed.
            if (this._rewindVideoUntilDts >= 0) {
              // …and the moment the cushion this was spending runs low, stop
              // spending it. If the cursor never reaches the mark — a seek
              // landed elsewhere, the file ended — the alternative is a picture
              // that never moves again. Decoding what we already have costs a
              // frame the renderer drops as stale; not decoding costs the film.
              const cushion = this.videoRenderer?.getQueueSize?.() ?? 0;
              if (packet.dts <= this._rewindVideoUntilDts && cushion > 4) continue;
              this._rewindVideoUntilDts = -1;
            }

            if (this.videoDecoder) {
              // Decode and render to canvas
              // Note: All packets including pre-target are decoded to build reference frames
              // The onFrame callback filters out frames before seekTargetTime
              this.videoDecoder.decode(
                packet.data,
                packet.timestamp,
                packet.keyframe,
                packet.dts,
                packet.isIdr,
                packet.isRasl,
                packet.disposable,
              );
              this._lastFedVideoDts = packet.dts;
            }
          } else if (activeAudio && activeAudio.id === packet.streamIndex) {
            // An audio packet exists here, whatever was decided earlier. Past a
            // declared audio tail it retracts it — the gap was in the middle of
            // the file, not the end of the sound — and gives the clock back to
            // the audio.
            this._lastAudioPacketPts = packet.timestamp;
          this._videoPacketsSinceAudio = 0;
            if (packet.timestamp > this._audioTailStart) {
              Logger.info(
                TAG,
                `Audio resumed at ${packet.timestamp.toFixed(2)}s — that was a gap, not the end of the sound`,
              );
              this._audioTailStart = Number.POSITIVE_INFINITY;
              this.audioRenderer.clearEndOfStream();
            }
            // Audio running this far past the newest video packet means the
            // video track has stopped — either for good (the tail) or for a
            // stretch. The container's own duration usually says so first; this
            // is for the ones that don't say anything useful. Split audio is
            // excluded: it comes from a DIFFERENT file, so the two cursors have
            // no relationship to measure. (See _videoTailStart.)
            if (
              !this.audioDemuxer &&
              !Number.isFinite(this._videoTailStart) &&
              this._lastVideoPacketPts >= 0 &&
              packet.timestamp - this._lastVideoPacketPts >
                MoviPlayer.VIDEO_TAIL_GAP_S
            ) {
              this._videoTailStart = this._lastVideoPacketPts;
              Logger.info(
                TAG,
                `No video packet since ${this._lastVideoPacketPts.toFixed(2)}s while audio reached ${packet.timestamp.toFixed(2)}s — holding the last frame and playing the audio on`,
              );
            }
            // Audio can be processed normally (doesn't need keyframes)
            // Skip audio processing if disabled for debugging
            if (!this.disableAudio) {
              // The rewind lands on the keyframe before its target, so the
              // first audio it hands back is a fraction of a second already
              // heard. The renderer was just reset; playing it would be that
              // fraction played twice.
              if (this._rewindAudioFrom >= 0) {
                // …and the mark it was armed with is already stale. It was
                // read before the demuxer seek, and that seek is the whole
                // wait: a backwards reposition on a cursor that had read far
                // ahead (further still when the speed change was HELD while
                // the pipeline filled for it) is I/O plus, on MKV, a cue
                // parse. The picture never stopped through any of it and the
                // clock ran on at the NEW rate, so resuming the sound at the
                // armed mark hands the renderer audio from behind the
                // playhead — and because setPlaybackRate's clock.seek() has
                // just cleared syncedToAudio, the FIRST healthy buffer is a
                // hard re-sync (Clock.getTime) that drags the whole clock
                // back onto it. That is the "plays, steps back, plays it
                // again" on the prepare path; the faster the machine, the
                // smaller the gap, which is why it never showed here.
                //
                // So resolve the floor where the playhead actually is now,
                // plus the lead before this sound can be heard at all —
                // during that lead the output is silent whatever we do, so
                // the media it covers would only ever be heard late. Capped:
                // an over-predicted lead skips content, and unlike a repeat
                // that cannot be taken back.
                if (this._rewindAudioFloorPending) {
                  this._rewindAudioFloorPending = false;
                  const live = this.getCurrentTime() + this.startTime;
                  const lead = Math.min(
                    0.25,
                    this.audioRenderer?.expectedStartLead?.() ?? 0,
                  );
                  const floor = live + lead * this.clock.getPlaybackRate();
                  if (Number.isFinite(floor) && floor > this._rewindAudioFrom) {
                    this._rewindAudioFrom = floor;
                  }
                }
                if (packet.timestamp < this._rewindAudioFrom) continue;
                this._rewindAudioFrom = -1;
              }
              // IMPORTANT: Skip audio packets before the seek target time
              if (
                this.seekTargetTime !== -1 &&
                packet.timestamp < this.seekTargetTime
              ) {
                continue;
              }

              // If waiting for video frame to ensure sync, buffer audio packets
              // (even when muted — needed for clock alignment to start at 0s)
              //
              // …unless the seek landed past the end of the video track, where
              // no frame will ever arrive to release them: every audio packet
              // to the end of the file would pile up in this array while the
              // player sat in "seeking". Past there the audio IS the playback
              // and completes the seek on its own, exactly as it does for a
              // file with no video track at all (see below).
              if (
                this.waitingForVideoSync &&
                this.trackManager.getActiveVideoTrack() &&
                !this.isInAudioOnlyTail(this.seekTargetTime) &&
                !this._soundCarryingAlone
              ) {
                this.pendingAudioPackets.push(packet);
                continue;
              }

              // Decode audio even when muted. AudioRenderer keeps gain at 0 so
              // it stays silent, but the audio clock advances normally — without
              // this, unmute pivots firstBufferMediaTime to wherever the demuxer
              // is (~1-3s ahead of presentation due to video buffer), and the
              // drift correction in CanvasRenderer judders the video to chase it.

              if (
                this.seekTargetTime !== -1 &&
                packet.timestamp >= this.seekTargetTime
              ) {
                // Once per target, not once per packet. This guard stays
                // armed until a VIDEO frame passes the target and clears it,
                // so while the decoder is hunting for a keyframe — seconds, on
                // a source with two-second keyframes — every audio packet came
                // through here and said the same thing. One session logged it
                // 96 times in a second and a half, which is noise sitting
                // exactly where the real problem is being diagnosed.
                if (this._audioTargetLoggedFor !== this.seekTargetTime) {
                  this._audioTargetLoggedFor = this.seekTargetTime;
                  Logger.debug(
                    TAG,
                    `Audio reached seek target: ${packet.timestamp.toFixed(3)}s (target: ${this.seekTargetTime.toFixed(3)}s)`,
                  );
                }
                if (
                  !this.trackManager.getActiveVideoTrack() ||
                  this.isInAudioOnlyTail(this.seekTargetTime) ||
                  this._soundCarryingAlone
                ) {
                  this.notifySeekCompletion(packet.timestamp);
                }
                // Retire it once audio is past: the guard exists to stop
                // already-scheduled audio being decoded a second time, and
                // there is none left behind this packet.
                //
                // Only safe to do here when VIDEO is not reading the same
                // field. On an ordinary seek it is — the pre-target frame
                // filter is this value — and the video side clears it when a
                // frame passes. During a video-only catch-up video has its own
                // gate (_videoResumeTarget) and deliberately leaves this one
                // armed for audio's sake, so nothing would ever clear it: the
                // branch above then logged for every audio packet, forever.
                if (
                  this._videoResumeTarget !== -1 ||
                  !this.trackManager.getActiveVideoTrack()
                ) {
                  this.seekTargetTime = -1;
                }
              }

              // Software codecs (TrueHD/MLP/DTS) go in as one batch per tick —
              // their access units are tiny, so the per-packet WASM round-trip,
              // not the decode itself, is what starves the renderer. WebCodecs
              // has no such cost, so it decodes inline as before.
              if (this.audioDecoder.canBatch()) {
                this._audioBatchPending.push(packet);
              } else {
                this.audioDecoder.decode(
                  packet.data,
                  packet.timestamp,
                  packet.keyframe,
                );
              }
            }
          } else {
            // Check for subtitle track
            const activeSubtitle = this.trackManager.getActiveSubtitleTrack();
            if (
              activeSubtitle &&
              activeSubtitle.id === packet.streamIndex &&
              this._customSubtitleRenderer
            ) {
              // A host renderer (e.g. jassub/libass) owns this track — hand it the
              // raw packet and skip the internal decoder entirely.
              try {
                void this._customSubtitleRenderer.pushPacket(packet);
              } catch (e) {
                Logger.error(TAG, "Custom subtitle renderer pushPacket failed", e);
              }
            } else if (
              activeSubtitle &&
              activeSubtitle.id === packet.streamIndex &&
              this.subtitleDecoder
            ) {
              let duration = packet.duration;
              if (!duration || duration <= 0) {
                duration = 0;
                Logger.debug(
                  TAG,
                  `Subtitle packet has no duration, will use fallback: timestamp=${packet.timestamp.toFixed(3)}s`,
                );
              }
              Logger.debug(
                TAG,
                `Processing subtitle packet: stream=${packet.streamIndex}, size=${packet.data.length}, timestamp=${packet.timestamp.toFixed(3)}s, duration=${duration > 0 ? duration.toFixed(3) : "fallback"}s`,
              );
              this.subtitleDecoder
                .decode(
                  packet.data,
                  packet.timestamp,
                  packet.keyframe,
                  duration,
                )
                .catch((error) => {
                  Logger.error(TAG, "Subtitle decode error", error);
                });
            }
          }
        }
      }
    } catch (e) {
      // Belongs to a pipeline that has since been swapped out — its source was
      // closed under it on purpose. Nothing to report and nothing to recover.
      if (pipelineGeneration !== this._demuxerGeneration) {
        Logger.debug(TAG, "Demux error from a retired pipeline — ignoring", e);
        this.demuxInFlight = false;
        return;
      }
      Logger.error(TAG, "Demux error", e);

      // Check for fatal errors that indicate corrupted state
      const errorMessage = (e as any).message || "";
      // WASM-level traps. Once av_read_frame or any other FFmpeg entry
      // point dereferences past the heap, the entire WASM module is
      // unrecoverable — every subsequent ccall hits the same OOB. Without
      // this branch, processLoop classifies it as transient and retries
      // every ~17ms, flooding the console and pinning the CPU until the
      // user closes the tab.
      const isWasmFatal =
        /out of bounds memory access|memory access out of bounds|RuntimeError|Aborted\(\)/i.test(
          errorMessage,
        );
      const isCorruptError =
        isWasmFatal ||
        errorMessage.includes("Invalid packet size") ||
        errorMessage.includes("Invalid typed array length") ||
        errorMessage.includes("State may be corrupted");

      // Source-level failures (HTTP 4xx/5xx, exhausted retries, CORS, etc.)
      // surface through here as the demuxer reads its bytes from the source.
      // Without classifying these as fatal, processLoop just keeps retrying
      // the demux and the buffering spinner spins indefinitely with no
      // user-visible reason. The actual messages come from HttpSource —
      // see the strings it throws in startStream/buildHeaders.
      const isSourceError =
        // Unanchored — the demuxer wraps it ("Failed to open media: HTTP 403"),
        // and a wrapped 4xx is every bit as fatal as a bare one.
        /\bHTTP \d{3}\b/.test(errorMessage) ||
        errorMessage.includes("Access denied") ||
        errorMessage.includes("Authentication required") ||
        errorMessage.includes("Video not found") ||
        errorMessage.includes("Failed to fetch video resource") ||
        errorMessage.includes("Stream failed after") ||
        errorMessage.includes("Server does not support range requests");

      if (isWasmFatal) {
        // The abort left the SHARED cached WASM module permanently dead — the
        // main demuxer reuses that singleton, so without this every later open
        // (a new video, a quality switch) fails "File is corrupted" until a page
        // reload. Drop the cached module so the recovery reload — and the next
        // source — instantiates a fresh one instead of reusing the corpse.
        resetWasmModule();
      }

      if (isCorruptError || isSourceError) {
        Logger.error(
          TAG,
          isSourceError
            ? `Fatal source error, pausing playback: ${errorMessage}`
            : "Fatal demux error detected, pausing playback",
        );
        this.pause();
        this.stateManager.setState("error");
        this.emit(
          "error",
          isSourceError
            ? (e instanceof Error ? e : new Error(errorMessage))
            : new Error("Playback error: corrupt data stream"),
        );
        return; // Exit process loop
      }

      // For non-fatal errors, continue (transient network glitches, etc.)
    } finally {
      this.demuxInFlight = false;
      // Hand this tick's audio to the decoder as one batch. In the finally so
      // it runs on EVERY exit path — an early return on a superseded seek, a
      // non-fatal error, or normal completion. The packets are already demuxed;
      // dropping them would tear a hole in the audio the same way the old
      // per-packet path did by starving the renderer. (A seek flushes the
      // decoder anyway, so any stale batch decoded here is discarded — exactly
      // what happened before, when packets were decoded as they were read.)
      if (this._audioBatchPending.length > 0) {
        const batch = this._audioBatchPending;
        this._audioBatchPending = [];
        this.submitAudioPackets(batch);
      }
    }
  };

  /**
   * Handle playback ended
   */
  /**
   * Turn the loop on or off. Off discards anything primed — the frames are
   * decoded pictures and holding them for a loop that is no longer coming is
   * VRAM nobody asked for.
   */
  setLoop(on: boolean): void {
    if (this._loopEnabled === on) return;
    this._loopEnabled = on;
    if (!on) this.discardLoopPreroll();
    Logger.debug(TAG, `Loop ${on ? "enabled" : "disabled"}`);
  }

  isLoopEnabled(): boolean {
    return this._loopEnabled;
  }

  /**
   * The sound as levels, for drawing — `bars` bands, each 0..1, or null when
   * there is nothing playing to read. Used by the cover-art view's dotted
   * meter; any host can draw its own from the same numbers.
   */
  getAudioLevels(bars: number): Float32Array | null {
    if (this.disableAudio) return null;
    return this.audioRenderer?.getLevels?.(bars) ?? null;
  }

  /** How many times this source has looped, from 0. */
  getLoopCount(): number {
    return this._loopCount;
  }

  /**
   * The file has come back round. One place for it, because there are two
   * routes to here — the gapless turn, and the restart a file with a
   * soundtrack still takes through `ended` — and a page counting loops should
   * not have to care which one it got.
   */
  private noteLoopTurn(): void {
    this._loopCount++;
    this.emit("loop", { count: this._loopCount });
    Logger.debug(TAG, `Loop: pass ${this._loopCount}`);
  }

  /** Let go of a primed pass: closing the frames, dropping the held packets,
   *  and cancelling the seam the audio renderer was holding open. */
  private discardLoopPreroll(): void {
    if (!this._loopPrerolling && this._loopPrerollFrames.length === 0) {
      return;
    }
    for (const f of this._loopPrerollFrames) {
      try {
        f.close();
      } catch {
        /* already closed */
      }
    }
    this._loopPrerollFrames = [];
    this._loopPrerolling = false;
    if (!this.disableAudio) this.audioRenderer.cancelLoopPass();
  }

  /**
   * Start decoding the next pass, if this is the moment for it.
   *
   * Every condition here is about having somewhere free to do the work. The
   * demuxer is free because EOF means it has read everything. The decoder is
   * free because the EOF flush has emitted its reorder tail and its queue has
   * drained. And there is TIME to work in because the renderer still holds
   * picture — without that the priming would be racing the very freeze it
   * exists to remove, and we may as well take the old path.
   */
  private maybeStartLoopPreroll(): boolean {
    if (!this._loopEnabled || this._loopPrerolling) return false;
    if (!this.videoRenderer || !this.trackManager.getActiveVideoTrack()) {
      return false;
    }
    // With sound there are two seams, not one: the audio wraps when the
    // outgoing samples run out, the picture when the outgoing queue empties,
    // and those are not the same moment. Turning the picture over on its own
    // seam left the clock (which follows the audio) either behind the primed
    // frames or well ahead — measured on a muxed 8s file, 2x went from 88ms to
    // 225ms and 0.5x to over a second. So a file with a soundtrack turns over
    // on the SOUND's seam instead, and the picture follows it.
    //
    // Without this, such a file restarted through `ended`: the context was
    // suspended, the schedule torn down and a seek waited for its cushion —
    // an audible trip at every turn of a looping beep.
    const withSound =
      !!this.trackManager.getActiveAudioTrack() && !this.disableAudio;
    if (withSound) {
      // A soundtrack that stops before the picture has no seam at the end of
      // the file to turn on. Those keep the restart.
      if (
        this._audioTailStart !== Number.POSITIVE_INFINITY ||
        this.isInVideoOnlyTail()
      ) {
        return false;
      }
      // Every sample of the outgoing pass has to be out of the decoder first:
      // the seam is recognised by the timestamps stepping back, and a straggler
      // from the old pass arriving after the new pass's first buffer would be
      // scheduled after it.
      if (this.audioDecoder.queueSize > 0) return false;
    }
    if (this.audioDemuxer) return false;
    if (!this.stateManager.is("playing")) return false;
    // The tail has to be out of the decoder before the head goes in: the two
    // passes share one decoder, and a picture still being reordered must not
    // be interleaved with the opening IDR.
    if (!this._eofFlushRequested) return false;
    // Requested is not the same as done. The flush emits the reorder tail
    // asynchronously, after the decode queue already reads empty — and once
    // priming starts every frame that comes out is taken as the NEXT pass.
    // The last two frames of the file went into the primed array that way,
    // sorted behind the clock at the turn and were dropped: a 117ms hold on
    // the first turn of a 30fps clip, where later turns showed 33ms.
    if (this._eofFlushSettledSeq !== this._eofFlushSeq) return false;
    if (this.videoDecoder.queueSize > 0) return false;
    // Nothing left on screen to cover the work — or, with sound, in the ears.
    if (
      this.videoRenderer.getQueueSize() === 0 &&
      !(withSound && this.audioRenderer.getBufferedDuration() > 0.1)
    ) {
      return false;
    }

    this._loopPrerolling = true;
    this._loopWithSound = withSound;
    this._loopSeamDrySince = 0;
    void this.startLoopPreroll();
    return true;
  }

  private async startLoopPreroll(): Promise<void> {
    try {
      if (!this.demuxer) throw new Error("no demuxer");
      // Arm the sound BEFORE a byte of the new pass is read.
      //
      // The audio is not held back the way the picture is, because it does not
      // need to be: commitAudioBuffer places each buffer at `scheduledTime`
      // and never honours a BACKWARD jump in the media timeline, so the
      // opening samples of the new pass land exactly where the closing ones of
      // the old pass end — contiguous, with nothing to hear. What did have to
      // wait is the CLOCK, and beginLoopPass is what defers that to the seam.
      //
      // Holding the audio instead was measured and is worse: decoding it all
      // at the turn put the first buffer 26ms late — "Gap filled: 26.1ms
      // silence" — and the underrun that caused took the player into buffering
      // 200ms later.
      if (!this.disableAudio) this.audioRenderer.beginLoopPass();
      await this.demuxer.seek(this.startTime);
      // Reading stopped because of EOF; the file starts again from here.
      this.eofReached = false;
      this._eofFlushRequested = false;
      Logger.info(
        TAG,
        "Loop: priming the next pass while the tail plays out",
      );
    } catch (e) {
      Logger.warn(
        TAG,
        "Loop: priming seek failed — falling back to the restart path",
        e,
      );
      this.discardLoopPreroll();
      this.eofReached = true;
    }
  }

  /**
   * The seam. Called once the outgoing pass has no picture left to show.
   *
   * Order matters: the sound is armed BEFORE any of the new pass is decoded,
   * so the first buffer of it is placed against a scheduler that already knows
   * where the media time wraps — and placed at `scheduledTime`, which is where
   * the outgoing pass's last sample ends. commitAudioBuffer never honours a
   * backward jump in the media timeline, so it appends rather than re-anchors:
   * no hole, no overlap, nothing to hear.
   */
  private maybeCompleteLoopWrap(): boolean {
    const outgoingFrames = this.videoRenderer?.getQueueSize() ?? 0;
    let clockTime = this.startTime;
    if (this._loopWithSound) {
      // One boundary: the picture turns when the sound does. Whatever of the
      // old picture is still queued at that moment is behind the new clock
      // for good, and goes; if the picture ran out first it simply holds its
      // last frame until the sound gets there.
      if (this.audioRenderer.isLoopSeamPending()) {
        // The new pass's sound never arrived (nothing decoded, or no audio in
        // its opening). Don't hold the picture hostage to it forever — but
        // measure that from the sound running OUT, not from priming. How much
        // of the old pass is still to be heard depends on how deep the audio
        // was buffered: an 8s MP4 still had more than three seconds of it, and
        // a fixed wait from priming gave up on a seam that was on its way.
        if (outgoingFrames > 0 || this.audioRenderer.getBufferedDuration() > 0.05) {
          this._loopSeamDrySince = 0;
          return false;
        }
        const now = performance.now();
        if (this._loopSeamDrySince === 0) this._loopSeamDrySince = now;
        if (now - this._loopSeamDrySince < MoviPlayer.LOOP_SEAM_DRY_MS) {
          return false;
        }
        Logger.warn(TAG, "Loop: the sound never reached its seam — turning the picture over without it");
        this.audioRenderer.cancelLoopPass();
      } else {
        const heard = this.audioRenderer.getAudioClock();
        if (heard >= 0) clockTime = heard;
      }
    } else if (outgoingFrames > 0) {
      return false;
    }

    const frames = this._loopPrerollFrames;
    this._loopPrerollFrames = [];
    this._loopPrerolling = false;

    // Without sound the queue is empty by definition here; with it, anything
    // left is old picture the clock has already wrapped past. What this is
    // mostly for is the guards it resets alongside. lastPresentedPts above all:
    // left at the end of the file it would refuse every frame of a pass that
    // starts at zero, which is the same monotonic guard that keeps a stale
    // pre-seek frame off the screen.
    this.videoRenderer?.clearQueue();
    // The sound is about to wrap under the picture; anchor on it rather than
    // banking the difference (see reanchorRequested).
    this.videoRenderer?.requestAudioReanchor();
    for (const f of frames) this.videoRenderer?.queueFrame(f);

    // The seek bar's buffered range belongs to the pass that just ended. A
    // normal seek re-anchors both of these and this turn is a seek in every
    // way that matters to the bar — without it the buffered segment stays
    // painted where the old pass finished while the progress bar grows from
    // zero, which draws as a detached sliver at the right end with a gap in
    // front of it. Same two lines, same reasons, as seek()'s own reset.
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = this.startTime;

    // Say it the way a looping media element says it.
    //
    // A native <video loop> does not fire `ended` — it reaches the last frame,
    // seeks back and carries on, and what the page hears is seeking then
    // seeked. The element already suppresses `ended` for exactly that reason
    // and its comment promises the pair. Going through a real seek() used to
    // provide them; turning the pass over here does not, and without this the
    // turn was completely silent — measured across one, not a single event
    // fired but the ordinary per-frame timeUpdate. A page had no way to know
    // the file had started again short of watching currentTime go backwards.
    //
    // Safe to say from here: the spinner follows the player STATE, which this
    // turn never moves out of "playing", so these are announcements and
    // nothing more.
    // Everything that forgives a seek's settling — the desync and lag
    // detectors, the self-inflicted stall test — should forgive this too: the
    // picture restarts a frame or two behind a sound that never stopped.
    this._lastSeekResumeAt = performance.now();

    this.emit("seeking", 0);
    this.clock.seek(clockTime);
    this.emit("timeUpdate", 0);
    this.emit("seeked", 0);
    this.noteLoopTurn();
    Logger.info(TAG, `Loop: wrapped with ${frames.length} frame(s) primed`);
    return true;
  }

  private handleEnded(): void {
    Logger.info(TAG, "Playback ended");

    // Release WakeLock when playback ends
    this.releaseWakeLock();

    this.clock.pause();
    if (!this.disableAudio) {
      this.audioRenderer.pause();
    }

    // Stop video presentation loop
    if (this.videoRenderer) {
      this.videoRenderer.stopPresentationLoop();
    }

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Snap time to end. Drop the keyframe-jump offset so getCurrentTime()
    // reports the true duration — otherwise open-GOP sources (where the
    // first decodable IDR is ~2s in) report end ~2s short of duration.
    //
    // Audio-only caveat: VBR MP3 / OGG / similar containers expose a
    // bitrate-derived duration that's typically overestimated by a few
    // seconds vs. the actual decoded sample count. Snapping to that
    // inflated duration makes the time-display jump forward at EOF and
    // makes the source look like it ended ~4s short of "done." For
    // audio-only sources, prefer the real last-scheduled audio media
    // time and update mediaInfo.duration so the seek bar matches.
    if (this.mediaInfo) {
      this.seekKeyframeOffset = 0;
      const hasVideo = !!this.trackManager?.getActiveVideoTrack?.();
      const audioEnd = this.audioRenderer.getMaxScheduledMediaTime?.() ?? 0;
      const useAudioEnd = !hasVideo && audioEnd > 0;
      const endTime = useAudioEnd ? audioEnd : this.mediaInfo.duration;
      if (useAudioEnd && Math.abs(audioEnd - this.mediaInfo.duration) > 0.1) {
        // Correct the cached duration so getDuration() and the timeline
        // both show the real value instead of the metadata estimate.
        this.mediaInfo.duration = audioEnd;
        this.clock.setDuration(audioEnd + this.startTime);
        this.emit("durationChange", audioEnd);
      }
      this.clock.seek(endTime + this.startTime);
      this.emit("timeUpdate", endTime);
    }

    this.stateManager.setState("ended");
    this.emit("ended", undefined);
  }

  /**
   * Seek to timestamp
   */
  private seekSessionId = 0;
  // The seek session whose completion is currently armed (waitingForVideoSync).
  // notifySeekCompletion bails when this no longer matches seekSessionId, so a
  // superseded seek's late frame/timeout can't stomp state or consume intent.
  private seekArmedSessionId = 0;
  // The session a live seek() is actually driving. Everything else that bumps
  // seekSessionId — an in-place rendition swap, a subtitle prefetch, a recovery
  // re-seek — does so only to INVALIDATE whatever seek is in flight, and leaves
  // this alone. That difference is how a seek walking away from its own
  // supersession can tell "a newer seek owns the state machine now" from
  // "nobody does" (see abandonSupersededSeek).
  private _liveSeekSession = -1;
  private wasPlayingBeforeSeek = false;

  // True while an internal seek with no real interruption is in flight: the
  // initial poster seek(0), first play, and replay-from-ended. These route
  // through the full seek pipeline (flush + demuxer.seek + keyframe wait) so
  // the state machine briefly enters "seeking"/"buffering" even though, from
  // the user's view, nothing is loading. The UI reads this to keep the loading
  // spinner hidden during that window. Set via seek()'s suppressSpinner opt,
  // cleared on seek completion (notifySeekCompletion).
  suppressSeekSpinner = false;

  /**
   * The failure the source will not come back from, if there has been one.
   *
   * An expired or revoked link answers every subsequent byte range the same
   * way, so HttpSource latches the refusal and re-throws it on every read
   * without touching the network again. That latch is the only honest signal
   * that the video is over — the demuxer cannot supply one, because a read
   * that FAILED and a read that reached the end of the file both reach C as
   * "no bytes".
   */
  getSourceFailure(): Error | null {
    return (
      (this.source as { getFatalError?: () => Error | null } | null)
        ?.getFatalError?.() ?? null
    );
  }

  /**
   * What the server called this source, from a request it had already made.
   *
   * Asked after an open has failed, to tell the one case the URL cannot: a
   * manifest served from a path with no extension. Empty for a source that
   * never saw an HTTP header — a file, an adapter, a stream already playing.
   */
  getSourceContentType(): string {
    return (
      (this.source as { getContentType?: () => string } | null)
        ?.getContentType?.() ?? ""
    );
  }

  /** The same question for a separately-fetched audio rendition, which has a
   *  source of its own and therefore an expiry of its own. A split stream's
   *  two URLs are signed together and die together, but the audio is the one
   *  read on a tick of its own — see pumpSplitAudio. */
  getSplitAudioFailure(): Error | null {
    return this.audioSource?.getFatalError?.() ?? null;
  }

  /**
   * End playback on a failure nothing downstream can recover from.
   *
   * Pausing without this leaves the state machine in "buffering", which the
   * UI renders as a spinner that never resolves — the viewer is told the
   * video is loading when it is not coming at all.
   */
  failFatally(error: Error): void {
    if (this.stateManager.getState() === "error") return;
    Logger.error(TAG, `Fatal playback failure: ${error.message}`);
    this.pause();
    this.stateManager.setState("error");
    this.emit("error", error);
  }

  async seek(
    seconds: number,
    opts?: {
      suppressSpinner?: boolean;
      preservePlaying?: boolean;
      /**
       * Machinery, not a request: rendering the first frame, priming a poster,
       * re-anchoring after a context loss. `seeking`/`seeked` stay quiet for
       * these — a media element repositioning itself internally says nothing
       * either, because those events answer for what a page asked for.
       */
      internal?: boolean;
    },
  ): Promise<void> {
    this._seekIsInternal = opts?.internal ?? false;
    // Whatever lag was being tracked is re-primed by this seek; the ATTEMPT
    // BUDGET deliberately survives it. Resetting the budget here made the cap
    // toothless — a recovery that ends in any seek at all handed itself a
    // fresh three attempts, which is exactly the loop the cap exists to stop.
    // The budget comes back the honest way: ten seconds of being in step.
    this._videoLagSince = 0;
    this._videoLagHealthySince = 0;

    if (this.streamWrapper) {
      return this.streamWrapper.seek(seconds);
    }

    // Split audio-only: seek ONLY the separate audio demuxer + clock; never
    // touch the main (video) demuxer whose body we're skipping, and never wait
    // for a video-sync that will never come (flush decoder, reset renderer,
    // re-seek the audio demuxer, restart the audio loop).
    if (this._audioOnly && this.audioDemuxer) {
      const t = Math.max(0, Math.min(seconds, this.getDuration() || seconds));
      this.stopAudioLoop();
      let guard = 0;
      while (this.audioDemuxInFlight && guard++ < 200) {
        await new Promise((r) => setTimeout(r, 5));
      }
      this.audioDecoder.flush();
      this.audioRenderer.reset();
      try {
        // Seek in the audio source's own PTS baseline (may differ from video's).
        this._splitAudioSkipBefore = -1;
        this._splitAudioFloorPending = false;
        await this.audioDemuxer.seek(t + this._splitAudioStartTime);
      } catch (e) {
        Logger.warn(TAG, `Split audio-only seek failed: ${(e as any)?.message ?? e}`);
      }
      this._splitAudioEof = false;
      this._lastSplitAudioPts = t;
      this.seekTargetTime = -1;
      this.clock.seek(t + this.startTime);
      this.seekKeyframeOffset = 0;
      this.eofReached = false;
      this._eofPictureDrainSince = 0;
    this._eofFlushRequested = false;
      this.eofSince = 0;
      // Honor a resume intent, mirroring what the video path does in
      // notifySeekCompletion. play()'s first-play (and replay) branch sets
      // wasPlayingBeforeSeek before calling seek(0); in audio-only there are no
      // video frames to decode, so that completion callback NEVER fires and the
      // transition to "playing" would otherwise never happen — autoplay on an
      // auto-advanced track silently stalls in "ready" (audio loop never
      // starts, context never resumes) until a manual play. Drive it here.
      // Also covers an already-rolling state (a live user scrub while playing).
      const shouldResume =
        this.wasPlayingBeforeSeek ||
        this.wasPlayingBeforeRebuffer ||
        this.stateManager.is("playing") ||
        this.stateManager.is("buffering");
      if (shouldResume) {
        this.wasPlayingBeforeSeek = false;
        this.wasPlayingBeforeRebuffer = false;
        if (this._playStartTime === 0) {
          this._playStartTime = performance.now();
        }
        if (!this.stateManager.is("playing")) {
          this.stateManager.setState("playing");
        }
        this.clock.start();
        // Split audio-only runs playback entirely from here — play()'s body,
        // and with it the one call that starts the renderer, is never reached.
        // Nothing is being presented either way; what this starts is the
        // caption clock, without which subtitles turned on in audio-only sit
        // there for the whole track (see setPictureSuspended).
        this.videoRenderer?.startPresentationLoop();
        // Resume the (auto-suspended) context so audio is audible. Fire-and-
        // forget like the video path — the shared context was already unlocked
        // by the previous track, so this wakes it without a fresh gesture.
        if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
          this.audioRenderer.play();
        }
        this.startAudioLoop();
      }
      if (!this._seekIsInternal) this.emit("seeking", t);
      this.emit("timeUpdate", t);
      this.emit("seekcomplete", t);
      if (!this._seekIsInternal) this.emit("seeked", t);
      return;
    }

    // A genuine user seek (no opt) clears any leftover suppression so its
    // spinner shows; play()-initiated seeks pass suppressSpinner to hide it.
    this.suppressSeekSpinner = opts?.suppressSpinner ?? false;
    // preservePlaying: a corrective seek (e.g. rate change) that must NOT flip
    // the play/pause state. If we were playing — including mid-flight from a
    // prior corrective seek (state "seeking"/"buffering") — keep the resume
    // intent so completion lands back in "playing", never "paused".
    if (opts?.preservePlaying) {
      const s = this.stateManager.getState();
      if (s !== "paused" && s !== "ended") {
        this.wasPlayingBeforeSeek = true;
      }
    }

    const currentState = this.stateManager.getState();
    Logger.info(TAG, `seek(${seconds.toFixed(2)}): state=${currentState}, waitingForVideoSync=${this.waitingForVideoSync}, demuxInFlight=${this.demuxInFlight}, seekSessionId=${this.seekSessionId}`);

    // Safety check - though PlayerState now permits it
    if (!this.stateManager.canSeek()) {
      Logger.warn(TAG, `seek blocked: canSeek=false, state=${currentState}`);
      return;
    }

    // A source that has permanently refused will refuse every byte this seek
    // asks for too. Seeking anyway spends the whole deadline waiting for a
    // frame that cannot be decoded, forces completion without one, and lands
    // in "buffering" — where the element's stuck watchdog seeks forward and
    // starts the same round again. A log of an expired link shows exactly
    // that: 587s → 591s → 597s, the timeline creeping under a spinner that
    // never resolves. The source is dead; say so instead of walking the
    // playhead through it.
    const preSeekFailure = this.getSourceFailure();
    if (preSeekFailure) {
      Logger.error(
        TAG,
        `seek(${seconds.toFixed(2)}) refused: the source has failed permanently`,
      );
      this.failFatally(preSeekFailure);
      return;
    }

    if (!this.demuxer) {
      throw new Error("Demuxer not initialized");
    }

    // Stop pause-time buffering — seek invalidates stashed packets
    this.stopPauseBuffering();

    // Track intent: if we were playing (or already seeking but originally playing), we want to resume
    // During buffering, preserve the pre-buffering play/pause intent.
    // Don't clobber an explicit pre-seek resume intent (e.g. the replay path
    // sets wasPlayingBeforeSeek=true before calling seek(0) from the "ended"
    // state — "ended" isn't "playing", so re-deriving here would wrongly reset
    // it to false and seek completion would land paused instead of replaying).
    if (currentState !== "seeking" && !this.wasPlayingBeforeSeek) {
      this.wasPlayingBeforeSeek = currentState === "playing" || (currentState === "buffering" && this.wasPlayingBeforeRebuffer);
    }

    // Pause clock so UI time doesn't advance during seek while in loading state
    this.clock.pause();

    // Drop the keyframe-jump offset from the previous seek; it gets
    // re-measured when this seek completes.
    this.seekKeyframeOffset = 0;
    // A seek repositions the cursor for its own reasons, so a rate-change
    // rewind's marks describe a cursor that no longer exists.
    this._rewindVideoUntilDts = -1;
    // …and so does a primed loop pass. Its frames are the start of a file the
    // viewer has just decided not to arrive at that way.
    this.discardLoopPreroll();
    this._rewindAudioFrom = -1;
    this._rewindAudioFloorPending = false;

    const mySessionId = ++this.seekSessionId;
    // Claim the session: from here until this seek finishes or is superseded,
    // a seek — not a swap, not a prefetch — owns the state machine.
    this._liveSeekSession = mySessionId;
    this._lastSeekAt = performance.now();
    // Retire the ABR's buffer baseline with it. A seek restarts the buffered
    // range at the new playhead, so the next tick would compare a fresh ~2s
    // against the tens of seconds measured before the seek and read a massive
    // DRAIN — the ground-truth signal that the rung can't be sustained. The
    // absolute-low half of that check is already held off for 12s after a seek
    // for exactly this reason; the draining half only had the 4s
    // postSeekSettling window, so scrubbing around dropped the quality a few
    // seconds after the user stopped, on a link that was carrying the rung
    // perfectly. Zeroing it makes the next tick establish a post-seek baseline
    // instead (draining requires a positive previous reading), so a real drain
    // is still caught one tick later. The in-place rendition swap already does
    // the same thing for the same reason.
    this._lastBufferAhead = 0;
    this.stateManager.setState("seeking");
    if (!this._seekIsInternal) this.emit("seeking", seconds);

    // Re-anchor the buffer bar's START to the target NOW, not after the
    // (blocking, potentially multi-second) demuxer.seek below. The scrubber
    // handle jumps to the target the instant the user releases, so leaving the
    // range anchored at the old position strands the buffered segment far
    // behind the handle — or, once the handle passes it, collapses the segment
    // to zero width. Either way the user sees "no buffer". Anchored here the
    // segment sits under the handle and grows forward as bytes actually land.
    // UI-only field (getBufferedRangeStart has no other consumer); the
    // lastBufferedTime monotonic clamp is deliberately left to reset after the
    // demuxer lands so ABR's bufferAhead isn't zeroed mid-seek.
    this.bufferedRangeStart = seconds;

    // CRITICAL: Cancel any running processLoop immediately to prevent WASM async conflicts
    // This must happen before waiting for demuxInFlight, otherwise processLoop may start new async operations
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    try {
      // If demuxing is in flight, wait for it to avoid WASM/Asyncify corruption
      // We loop but also check session ID to abort early if a new seek started
      // Also reset demuxInFlight if this seek is superseded
      if (this.demuxInFlight) {
        let retries = 0;
        while (this.demuxInFlight && retries < 100) {
          if (this.seekSessionId !== mySessionId) {
            // This seek was superseded, reset demuxInFlight to allow new seek to proceed
            this.demuxInFlight = false;
            return this.abandonSupersededSeek(mySessionId);
          }
          await new Promise((r) => setTimeout(r, 10));
          retries++;
        }
      }

      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);

      // Flush decoders
      Logger.info(TAG, `seek: flushing video decoder...`);
      await this.videoDecoder.flush();
      // Let go the instant the await returns, not at the next check further
      // down. A flush is not quick — one here gave up after 1860ms with 31
      // packets still queued — and a second seek arriving inside that window
      // runs its own flush, its own read-ahead drop, its own queue clear and
      // its own audioRenderer.reset() while this one is still parked. The
      // only session check was after ALL of that, so both seeks performed the
      // whole teardown: the log shows every line of it twice, interleaved.
      // That time the loser finished first and the winner's state survived by
      // luck; the other order wipes the frames and the audio the winner has
      // already rebuilt.
      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);
      this.dropVideoReadAhead();
      Logger.info(TAG, `seek: flushing audio decoder...`);
      await this.audioDecoder.flush();
      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);
      // Drop the host subtitle renderer's pending state — its cues are for the
      // position we're leaving; fresh packets stream in after the seek.
      if (this._customSubtitleRenderer) {
        try {
          this._customSubtitleRenderer.clear();
        } catch {
          /* ignore */
        }
      }
      // Drop any audio collected for the current tick's batch — it belongs to
      // the position we're leaving. The decoder has just been flushed, and the
      // batch is submitted from processLoop's finally AFTER this, so keeping it
      // would push pre-seek packets into the fresh decoder and emit audio at
      // stale timestamps. play() re-seeks, which is why pause→play was enough
      // to trigger it: the batch stranded by the pause got replayed on resume.
      this._audioBatchPending = [];
      Logger.info(TAG, `seek: decoders flushed`);

      // Clear video frame queue to prevent old frames from being displayed
      if (this.videoRenderer) {
        this.videoRenderer.clearQueue();
      }

      // Flush audio renderer (clears buffers)
      this.audioRenderer.reset();

      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);

      // Tell the source a seek is coming so it repositions its stream at the
      // landing offset. Otherwise it can only infer the seek from a run of
      // out-of-window reads, each a separate range request competing with the
      // old stream — on a large remote file the 3s seek timeout below fires
      // first, so the stream keeps pulling the region we just left and the
      // new position starves (no video frame, chopped audio, bogus buffer bar).
      (this.source as { hintSeek?: () => void } | null)?.hintSeek?.();

      // Seek relative to start time (time 0 in UI = startTime in media)
      Logger.info(TAG, `seek: demuxer.seek(${(seconds + this.startTime).toFixed(2)}) starting...`);
      await this.demuxer.seek(seconds + this.startTime);
      // The seek lands where it was asked to land, and nowhere else.
      //
      // There used to be a second look here: where the keyframe behind the
      // target sat more than 1.5s back and the one AFTER it was within 0.5s,
      // the seek started on the later one instead. The walk back is paid in
      // frames decoded only to be dropped, and on a sparse-keyframe 8K60 file
      // that was 654ms against 189ms — a real saving, on that file.
      //
      // It is the wrong trade to make silently, because what it spends is the
      // viewer's aim. Reported on a 28.6s 4K120 DoVi transport stream with
      // keyframes at 12.00 and 14.083: every click between 13.55 and 14.08 —
      // the whole second half of that GOP — landed on 14.092. Click anywhere
      // in the back half of a block and you arrive at the end of it, which is
      // not a slower seek or a rougher one, it is a different position from
      // the one asked for. And the saving it was buying there was nothing:
      // both sides of the threshold settled the picture in 358-363ms, because
      // the walk this avoids is only expensive when the frames are expensive.
      //
      // A threshold in SECONDS is what made it fire here at all — 1.5s is 36
      // frames at 24fps and 180 at 120 — so if this comes back it should be
      // bounded by the frames it actually has to decode, and it should not
      // move the landing point past where the pointer was.

      // Seek the split (separate-URL) audio demuxer to the same target. Stop the
      // audio loop and let any in-flight read settle first — a concurrent
      // readFrame + seek on the (separate) audio WASM module would corrupt it.
      if (this.audioDemuxer) {
        this.stopAudioLoop();
        let guard = 0;
        while (this.audioDemuxInFlight && guard++ < 200) {
          await new Promise((r) => setTimeout(r, 5));
        }
        try {
          // Seek in the audio source's own PTS baseline (may differ from video's).
          // Retire any filter armed by the PREVIOUS seek — this one will arm its
          // own on completion, and a stale cutoff would silently eat the head of
          // the new position's audio.
          this._splitAudioSkipBefore = -1;
          this._splitAudioFloorPending = false;
          await this.audioDemuxer.seek(seconds + this._splitAudioStartTime);
        } catch (e) {
          Logger.warn(TAG, `Split audio seek failed: ${(e as any)?.message ?? e}`);
        }
        this._splitAudioEof = false;
        // Re-baseline the decode-lead gate to the seek target so it doesn't
        // think audio is already seconds ahead (or behind) the new playhead.
        this._lastSplitAudioPts = seconds;
      }
      Logger.info(TAG, `seek: demuxer.seek done`);
      this.clock.seek(seconds + this.startTime);

      // Reset EOF flag after seek - we're now at a new position
      this.eofReached = false;
      this._eofPictureDrainSince = 0;
    this._eofFlushRequested = false;
      this.eofSince = 0;
      // A seek re-aligns the audio source too, so the automatic-recovery budget
      // starts fresh — a failure burst earlier in the file shouldn't leave a
      // later stretch permanently silent.
      this._audioRecoveries = 0;

      // Buffered region restarts from the new position; drop the
      // monotonic clamp so the bar can shrink to reflect the new range,
      // and re-anchor the range's START to the seek target so the bar grows
      // forward from where the user clicked instead of being painted from 0.
      this.lastBufferedTime = 0;
      this.bufferedRangeStart = seconds;

      // Mark that we need to skip to keyframe after seek
      // This prevents decoder errors from non-keyframe packets after seek
      this.seekingToKeyframe = true;
      this.seekingToKeyframeStartTime = performance.now();
      this.seekKeyframeScanned = 0;
      this.seekCraSeen = 0;
      // A seek is a fresh keyframe-anchored start; any pending starve-induced
      // chain break is moot.
      this.videoChainBrokenUntilKeyframe = false;
      this.videoSkipRaslAfterChainCra = false;

      // IMPORTANT: Set seek target time for accurate seek positioning
      // FFmpeg seeks to the nearest keyframe BEFORE the target time,
      // so packets will have timestamps earlier than 'seconds'.
      // We need to skip audio packets before target and decode (but not display) video frames.
      // Normalize target time against startTime offset
      this.seekTargetTime = seconds + this.startTime;
      // A new continuous read pass starts here. What audio it turns up (or
      // fails to) is what the EOF check reads — see _audioReadPassStart.
      this._audioReadPassStart = seconds + this.startTime;
      this._lastAudioPacketPts = -1;
      this._videoPacketsSinceAudio = 0;
    if (this._carrySoundThroughNextSeek) {
      // The hand-over's own seek: re-prime decode where the playhead already is
      // so the sound starts again from exactly there — not from wherever the
      // schedule built up to during the wait — and keep the hand-over armed, so
      // the completion below resumes on audio instead of holding for a picture
      // this position has already proved it can't produce. Any frame from here
      // on is the picture rejoining.
      this._carrySoundThroughNextSeek = false;
      this._videoResumeTarget = seconds + this.startTime;
    } else {
      this._videoResumeTarget = -1; // a real seek supersedes a video-only catch-up
      this._soundCarryingAlone = false; // …and re-primes the picture from here
    }
      this.waitingForVideoSync = true;
      // A new seek retires the previous one's debt: its picture is not wanted
      // any more, and this seek arms its own.
      this._pictureOwedFrom = -1;
      // Tag which seek session armed this completion. notifySeekCompletion
      // bails if a newer seek has since superseded this one, so a stale (e.g.
      // coalesced/rapid-seek) completion can't run the resume/paused branch and
      // consume wasPlayingBeforeSeek out from under the live seek — which
      // intermittently left rapid seeks stuck paused.
      this.seekArmedSessionId = mySessionId;
      // Any post-seek queue wait belonged to the seek this one supersedes; its
      // tight escape must not be left armed over an unrelated stall.
      this._seekResumeQueueWait = false;
      this.pendingAudioPackets = [];
      // Stashed prebuffer packets are pre-seek and now stale
      this.pendingPrebufferPackets = [];
      this.dropVideoReadAhead();

      // Enable post-seek throttling to prevent overwhelming low-end devices
      // BUT skip throttling when seeking within already-buffered data — the bytes
      // are already local so aggressive bursting won't cause network stalls.
      const seekInBufferedRange = this.isSeekTargetBuffered(seconds);
      if (seekInBufferedRange) {
        this.justSeeked = false;
        Logger.info(TAG, "Seek within buffered range — skipping post-seek throttle");
      } else {
        this.justSeeked = true;
      }
      this.seekTime = performance.now();

      if (this.seekSessionId !== mySessionId)
        return this.abandonSupersededSeek(mySessionId);

      // Start processing loop to find and decode the target frame/packet.
      // notifySeekCompletion will be called once the first valid frame is received.
      Logger.info(TAG, `seek: starting processLoop, waitingForVideoSync=${this.waitingForVideoSync}, state=${this.stateManager.getState()}`);
      this.processLoop();
      this.startAudioLoop();

      // Ensure the video renderer loop is running to actually draw frames as they arrive
      if (this.videoRenderer) {
        this.videoRenderer.startPresentationLoop();
      }

      // Safety timeout: force seek completion if frames don't arrive in time.
      // Shorter timeout for buffered seeks since data is already local.
      //
      // The deadline is a floor, not a budget. It used to be a flat 1500ms for
      // a buffered seek, and on 4K AV1 with a long GOP the decoder simply needs
      // longer than that to walk from the keyframe to the target — it was still
      // producing frames when the deadline cut it off. What followed was worse
      // than waiting: a forced completion with no frame lands in buffering,
      // black-frame recovery then seeks AGAIN two seconds further on, and the
      // sound is left a couple of seconds ahead of the picture. Both of the
      // logs this came from show exactly that chain.
      //
      // So the deadline only fires once the decoder has gone QUIET for a
      // moment. Frames still arriving push it out, up to a hard cap, because a
      // decoder producing frames nobody wants forever is its own failure.
      // …and none of that reasoning applies while the tab is hidden, where
      // video decode is skipped on purpose. There the deadline is not waiting
      // for a slow decoder, it is waiting for one that was never asked to run:
      // the frame cannot arrive, so the full 1500ms is spent before the next
      // track can start. Measured on a background auto-advance — "Seek timeout
      // after 1501ms (no frame decoded at all)". Complete on the next tick
      // instead; the audio is the playback there and it is ready now. PiP is
      // excluded: the picture is on screen and IS being decoded.
      const noPictureComing = this.isBackgrounded && !this.isPiPActive;
      const seekTimeoutMs = noPictureComing
        ? 0
        : seekInBufferedRange
          ? 1500
          : 3000;
      const seekStartedAt = performance.now();
      this._seekFrameProgressAt = 0;
      let seekTimeout: ReturnType<typeof setTimeout>;
      const onSeekDeadline = () => {
        if (this.seekSessionId !== mySessionId || !this.waitingForVideoSync) return;
        const now = performance.now();
        const sinceFrame = now - this._seekFrameProgressAt;
        const elapsed = now - seekStartedAt;
        if (
          this._seekFrameProgressAt > 0 &&
          sinceFrame < MoviPlayer.SEEK_PROGRESS_IDLE_MS &&
          elapsed < MoviPlayer.SEEK_PROGRESS_CAP_MS
        ) {
          seekTimeout = setTimeout(
            onSeekDeadline,
            MoviPlayer.SEEK_PROGRESS_IDLE_MS - sinceFrame,
          );
          return;
        }
        // The source can die mid-seek — the refusal that latches it may land
        // between seek() and this deadline. Forcing completion then buffers on
        // bytes that will never arrive, so check before pretending the seek
        // merely ran slow.
        const midSeekFailure = this.getSourceFailure();
        if (midSeekFailure && this._seekFrameProgressAt === 0) {
          Logger.error(
            TAG,
            `Seek to ${seconds}s produced no frame because the source failed: ${midSeekFailure.message}`,
          );
          this.waitingForVideoSync = false;
          this.failFatally(midSeekFailure);
          return;
        }
        Logger.warn(
          TAG,
          `Seek timeout after ${Math.round(elapsed)}ms (${
            this._seekFrameProgressAt > 0
              ? `${Math.round(sinceFrame)}ms since the last decoded frame`
              : "no frame decoded at all"
          }), forcing completion at ${seconds}s`,
        );
        this.notifySeekCompletion(seconds + this.startTime, true);
      };
      seekTimeout = setTimeout(onSeekDeadline, seekTimeoutMs);

      // Clear timeout if seek completes or is superseded
      const clearSeekTimeout = () => {
        clearTimeout(seekTimeout);
        this.off("seeked", clearSeekTimeout);
      };
      this.on("seeked", clearSeekTimeout);

      Logger.info(TAG, `Seek initiated to ${seconds}s, waiting for sync...`);
    } catch (error) {
      // Reset seeking flag on error
      this.seekingToKeyframe = false;

      if (this.seekSessionId === mySessionId) {
        this.stateManager.setState("error");
        this.emit("error", error as Error);
      }
      throw error;
    }
  }

  /**
   * A seek that was superseded mid-flight, letting go.
   *
   * If a NEWER SEEK took the session there is nothing to do: it set "seeking"
   * itself and its own completion will resolve it. The other case is the one
   * this exists for. An in-place rendition swap, a subtitle prefetch and the
   * network-recovery re-seek all bump seekSessionId purely to invalidate an
   * in-flight seek — none of them is a seek, and none of them finishes what
   * this one started. What it leaves behind is a player in "seeking" with a
   * paused clock, a stopped split-audio pump, and (past the arming point)
   * waitingForVideoSync raised for a session that can never complete, so every
   * frame that arrives afterwards just re-enters notifySeekCompletion's
   * stale-session branch and bails.
   *
   * Read off the reported session: the network came back, the recovery seek
   * went out, the ABR swap that had been stuck on the dead link completed
   * half a second later and took the session — and the player sat frozen under
   * a spinner, first frame decoded and on screen, until the viewer dragged the
   * scrubber by hand. That manual seek was doing what this does here.
   */
  private abandonSupersededSeek(mySessionId: number): void {
    // Drop our arming first, whoever owns the session now: left set, it is a
    // completion nothing will ever fire.
    if (this.seekArmedSessionId === mySessionId) {
      this.waitingForVideoSync = false;
      this.seekingToKeyframe = false;
    }
    // A backstop, not a race. Whatever took the session gets its chance first:
    // the rendition swap resolves the state as its last act, and the subtitle
    // prefetch and the recovery re-seek run resumes of their own. Only if the
    // player is STILL sitting in "seeking" a moment later did nobody, and only
    // then does this step in.
    setTimeout(() => {
      if (this._destroyed) return;
      this.resumeAfterOrphanedSeek("a non-seek operation");
    }, MoviPlayer.ORPHANED_SEEK_BACKSTOP_MS);
  }

  /**
   * Hand the pipeline back to playback after the seek that owned it was taken
   * over by something that is not a seek. Called from both ends of that race:
   * the seek itself when it notices (abandonSupersededSeek), and the operation
   * that took the session — the in-place rendition swap — when the seek was
   * already past its last check and cannot. Whichever gets there first, the
   * other finds the state resolved and does nothing.
   */
  private resumeAfterOrphanedSeek(takenBy: string): void {
    // A live seek holds the session — it owns the resume.
    if (this._liveSeekSession === this.seekSessionId) return;
    if (!this.stateManager.is("seeking")) return;
    const resume = this.wasPlayingBeforeSeek || this.wasPlayingBeforeRebuffer;
    this.wasPlayingBeforeSeek = false;
    this.wasPlayingBeforeRebuffer = false;
    this.waitingForVideoSync = false;
    this.seekingToKeyframe = false;
    Logger.info(
      TAG,
      `seek superseded by ${takenBy} — resolving the seeking state (${
        resume ? "resuming" : "staying paused"
      })`,
    );
    this.stateManager.setState("paused");
    // The seek stopped the split-audio pump before seeking its demuxer and
    // never reached the line that restarts it.
    this.startAudioLoop();
    this.emit("seeked", Math.max(0, this.clock.getTime() - this.startTime));
    if (resume) {
      void this.play().catch((err) => {
        Logger.error(TAG, "Failed to resume after a superseded seek:", err);
      });
    } else {
      this.startPauseBuffering();
    }
  }

  /**
   * Check if seek target time falls within the already-buffered byte range.
   * Uses linear byte→time estimation (same as getBufferedTime).
   */
  private isSeekTargetBuffered(seekSeconds: number): boolean {
    if (!this.mediaInfo || !this.source || this.fileSize <= 0) return false;
    const duration = this.mediaInfo.duration;
    if (duration <= 0) return false;

    if (this.source instanceof FileSource) return true;

    if (this.source instanceof HttpSource) {
      // Entire file is in memory — every seek is local
      if (this.source.isFullyCached()) return true;

      const bufferStartBytes = this.source.getBufferStart();
      const bufferEndBytes = this.source.getBufferedEnd();
      // Convert seek target to estimated byte offset
      const seekRatio = Math.min(1, (seekSeconds + this.startTime) / (duration + this.startTime));
      const seekByteEstimate = seekRatio * this.fileSize;
      // Check if estimated byte position is within buffered window (with margin for keyframe before)
      const margin = this.fileSize * 0.02; // 2% margin for keyframe before target
      return seekByteEstimate >= bufferStartBytes - margin && seekByteEstimate <= bufferEndBytes;
    }

    // For other sources with getBufferedEnd
    if ("getBufferedEnd" in this.source) {
      const bufferEndBytes = (this.source as any).getBufferedEnd();
      if (bufferEndBytes > 0) {
        const seekRatio = Math.min(1, (seekSeconds + this.startTime) / (duration + this.startTime));
        const seekByteEstimate = seekRatio * this.fileSize;
        return seekByteEstimate <= bufferEndBytes;
      }
    }

    return false;
  }

  /**
   * Initialize WebGL context for thumbnail rendering
   */

  /**
   * Generates a preview frame for the given time using C-based FFmpeg software decoding.
   * Fast and doesn't block main playback.
   */
  /**
   * Generates a preview frame for the given time using C for demuxing and WebCodecs for decoding.
   */
  async getPreviewFrame(
    time: number,
    view?: VRView | null,
    /**
     * Wait for a generation already in flight instead of returning null.
     *
     * The pipeline is a single decoder, so only one frame can be made at a
     * time, and a second caller is turned away. That is RIGHT for the seek bar:
     * a hover wants the frame for where the pointer is NOW, and a queue of
     * stale positions is worse than a dropped one.
     *
     * It is wrong for anything asking for a fixed list of times. The chapter
     * strip asks for one frame per chapter in a loop, and one preview already
     * running — a keyframe fetch is 2MB, which is seconds on a phone — turned
     * every one of those calls away instantly. Sixteen chapters resolved to
     * null in a few milliseconds and the panel came out empty, with the count
     * printed over it.
     */
    queue = false,
  ): Promise<Blob | null> {
    if (this._audioOnly) return null; // Data-saver: never decode video for previews
    if (!this.previewsAllowed()) return null; // Disabled, or source too large for a 2nd WASM context
    // Adaptive streams: use the manifest's own thumbnail track via Shaka
    // (DASH-IF tiled thumbnails / HLS image playlists). Returns null when the
    // manifest has no thumbnail track, so the preview just stays hidden — far
    // cheaper than the FFmpeg path, which can't byte-range-seek a stream.
    if (this.streamWrapper) return (this.streamWrapper as any).getThumbnailBlob?.(time) ?? null;
    if (this.previewInitGaveUp) return null; // Init failed repeatedly — stop retrying (and re-loading WASM)
    // Already made this one (see previewCache). Answered before the in-flight
    // lock below, so a pointer moving back over ground it has already covered
    // gets its frame at once — even while another one is being decoded, which
    // during a scrub is most of the time.
    const key = this.previewKey(time, view);
    if (key !== null) {
      const cached = this.previewCache.get(key);
      if (cached) return cached;
    }
    // Pictures the source came with beat pictures we have to make: a crop out
    // of a mosaic the browser has already fetched, with no seek, no decode and
    // no second WASM module behind it. Answered before the in-flight lock too,
    // because nothing here is in flight — a storyboard has no single decoder
    // to queue behind. A 360 view is the exception: those frames are
    // reprojected per angle, which a flat tile cannot be.
    if (this.storyboardSource && !view) {
      const board = await this.ensureStoryboard();
      const tile = board?.tileAt(time) ?? null;
      if (tile) {
        const blob = await this.cropStoryboardTile(tile);
        if (blob) {
          if (key !== null) this.rememberPreview(key, blob);
          return blob;
        }
      }
    }
    if (this.isPreviewGenerating) {
      if (!queue) return null; // Busy — the hover path would rather have nothing
      // Wait it out, then take our turn. Re-entered rather than looped: by the
      // time this resolves another caller may have started, and the same rule
      // applies to them.
      try {
        await this.previewInFlight;
      } catch {
        /* the other caller's failure is not ours */
      }
      return this.getPreviewFrame(time, view, true);
    }
    // Audio-only sources have no video track to thumbnail. Bail early
    // so a hover on the seek bar doesn't trigger a "Thumbnail bindings
    // or renderer not available" error every time.
    if (!this.trackManager.getActiveVideoTrack()) return null;
    this.isPreviewGenerating = true;
    // The signal waiters block on. Its value is never read — a waiter takes its
    // own turn afterwards rather than sharing this frame, which is a different
    // time anyway.
    let releaseInFlight: () => void = () => {};
    this.previewInFlight = new Promise<Blob | null>((resolve) => {
      releaseInFlight = () => resolve(null);
    });

    try {
      // Initialize thumbnail pipeline if needed
      if (!this.thumbnailBindings) {
        if (this.previewInitPromise) {
          Logger.debug(TAG, "Waiting for existing preview initialization...");
          try {
            await this.previewInitPromise;
          } catch {
            // Init failed, clear promise so retry can work
            this.previewInitPromise = null;
          }
        }
        // If still no bindings (init failed or promise was cleared), retry —
        // but cap attempts so a persistent failure doesn't re-load a fresh WASM
        // module on every seek-bar hover.
        if (!this.thumbnailBindings) {
          if (++this.previewInitAttempts > 3) {
            this.previewInitGaveUp = true;
            Logger.warn(TAG, "Thumbnail pipeline init failed repeatedly — disabling previews.");
            return null;
          }
          Logger.debug(TAG, "Initializing thumbnail pipeline (retry)...");
          this.previewInitPromise = this.initPreviewPipeline();
          try {
            await this.previewInitPromise;
          } catch {
            this.previewInitPromise = null;
          }
        }
      }

      if (!this.thumbnailBindings || !this.thumbnailRenderer) {
        Logger.warn(TAG, "Thumbnail bindings or renderer not available");
        return null;
      }

      // 360°: reproject the equirect keyframe to the current viewing angle so
      // the seek-bar preview matches what's on screen. Must be set BEFORE the
      // decode/render below — draw() happens synchronously inside the WebCodecs
      // output callback. Null (2D sources) keeps the flat passthrough path.
      this.thumbnailRenderer.setProjection(view ?? null);

      // Read keyframe from thumbnailer
      // Convert time to media time (PTS) by adding startTime
      const packetSize = await this.thumbnailBindings.readKeyframe(time);
      Logger.debug(
        TAG,
        `Thumbnail readKeyframe(${time.toFixed(2)}s): size=${packetSize}`,
      );

      if (packetSize <= 0) {
        // Suppress warning for expected errors like aborted reads (-6) or generic errors during rapid seeking
        if (packetSize !== -6) {
          Logger.warn(TAG, `Thumbnail read failed or empty: ${packetSize}`);
        }
        return null;
      }

      const timestamp = this.previewPacketPts();

      // The seek has just named the keyframe this position belongs to. If that
      // keyframe has already been decoded, this hover's picture is that
      // picture — no decode, no encode, and no guess about GOP length.
      //
      // Only outside precise mode and outside 360: both of those make the
      // frame depend on more than which keyframe it is (the walk forward to
      // the hovered moment, and the angle it is reprojected to).
      if (!this.precisePreviews && !view) {
        const kfKey = this.keyframeKey(timestamp);
        const seen = kfKey === null ? null : this.previewByKeyframe.get(kfKey);
        if (seen) {
          if (key !== null) this.rememberPreview(key, seen);
          return seen;
        }
      }

      const dataPtr = this.thumbnailBindings.getPacketData();

      Logger.debug(
        TAG,
        `Thumbnail packet: pts=${timestamp.toFixed(2)}s, ptr=${dataPtr}, size=${packetSize}`,
      );

      if (!dataPtr) {
        Logger.warn(TAG, "Thumbnail packet data pointer is null");
        return null;
      }

      // Get packet data from the ISOLATED thumbnail module (not main module!)
      const packetData = this.thumbnailBindings.getPacketDataCopy(packetSize);
      if (!packetData) {
        Logger.warn(TAG, "Failed to copy thumbnail packet data");
        return null;
      }

      // 1. Try WebCodecs (Hardware) through Renderer
      let rendered = false;

      // Precise mode walks from the keyframe to the frame the pointer is
      // actually on. The packets are collected FIRST and decoded as one run,
      // because the decoder has to be flushed to get a frame out and a flush
      // ends the run: Chrome answers the next delta with "A key frame is
      // required after configure() or flush()".
      //
      // Unbounded, on purpose. It used to stop at 120 frames or 900ms and
      // keep whatever it had reached, which on the long-GOP sources this mode
      // exists for is the keyframe again — precise previews that quietly
      // stopped being precise exactly where the imprecision was worst. In
      // this mode the answer is the frame under the pointer; the walk ends
      // when it gets there, at EOF, or on a read that fails.
      const run: Array<{ data: Uint8Array; pts: number; key: boolean }> = [
        { data: packetData, pts: timestamp, key: true },
      ];
      if (this.precisePreviews && timestamp < time - 0.02) {
        // Packets arrive in DECODE order, and with B-frames that is not
        // presentation order: a packet whose pts is past the pointer can
        // arrive while the frames AT the pointer are still to come. Measured
        // on a 1080p25 H.264 file with a B-pyramid, four packets in:
        //
        //   pts 0.000  0.040  0.080  0.200  0.120  0.160  0.320  0.240
        //
        // Stopping at the first `pts >= time` therefore stopped at 0.200 for
        // a hover at 0.160 — before 0.120 and 0.160 had been read at all —
        // and the card showed whatever the run happened to contain, which is
        // not the frame the seek then lands on. It is exactly this file's
        // "the preview and the frame disagree", and only this file's, because
        // most encodes deliver pts in order.
        //
        // The reader answers that with the packet's DECODE timestamp, which
        // rises with every packet in the order they arrive. The frame the
        // pointer is on has dts <= its own pts, so reading until dts reaches
        // the pointer is guaranteed to have read it — and everything it
        // references, whose dts is earlier still.
        //
        // A WASM build that predates this reports no dts (NaN). There the
        // walk keeps going for a short window past the first pts that passes
        // the pointer instead: the reorder depth is small (2–4 in practice,
        // this file included) and the frames are small, so a dozen is
        // generous and costs a few milliseconds.
        const REORDER_TAIL = 12;
        let tail = -1;
        for (;;) {
          const size = await this.thumbnailBindings.readNextPacket();
          if (size <= 0) break; // EOF, or a read that went wrong
          const pts = this.previewPacketPts();
          const rawDts = this.thumbnailBindings.getPacketDts?.() ?? Number.NaN;
          const dts = Number.isFinite(rawDts) ? rawDts - this.startTime : Number.NaN;
          const data = this.thumbnailBindings.getPacketDataCopy(size);
          if (!data) break;
          run.push({ data, pts, key: false });
          if (Number.isFinite(dts)) {
            if (dts >= time) break;
          } else {
            if (pts >= time && tail < 0) tail = 0;
            if (tail >= 0 && ++tail > REORDER_TAIL) break;
          }
        }
      }

      try {
        rendered = await this.thumbnailRenderer!.decodeSequenceAndRender(run, time);
        if (run.length > 1) {
          Logger.debug(
            TAG,
            `Precise preview: decoded ${run.length} frames from the keyframe at ` +
              `${timestamp.toFixed(2)}s up to ${time.toFixed(2)}s`,
          );
        }
      } catch (e) {
        Logger.warn(TAG, "Thumbnail WebCodecs decode failed", e);
      }

      // The walk left the demuxer holding the LAST packet it read, and the
      // software path below decodes whatever the context is holding. A delta
      // on its own decodes to nothing, so put the keyframe back before handing
      // over — the software fallback then shows the keyframe, which is what it
      // showed before this mode existed.
      if (!rendered && run.length > 1) {
        try {
          await this.thumbnailBindings.readKeyframe(time);
        } catch {
          /* the fallback reports its own failure */
        }
      }

      /* REMOVED OLD LOGIC START
              const videoTrack = this.mediaInfo?.tracks?.find(
                (t) => t.type === "video",
              ) as VideoTrack | undefined;
              const aspect =
                videoTrack?.width && videoTrack?.height
                  ? videoTrack.width / videoTrack.height
                  : 16 / 9;
              const width = 320;
              const height = Math.round(width / aspect);

              const rgba = this.thumbnailBindings!.decodeCurrentPacket(
                width,
                height,
              );

              if (rgba && rgba.length > 0) {
                if (!this.thumbnailCanvas) {
                  if (typeof OffscreenCanvas !== "undefined") {
                    this.thumbnailCanvas = new OffscreenCanvas(width, height);
                  } else {
                    this.thumbnailCanvas = document.createElement("canvas");
                    this.thumbnailCanvas.width = width;
                    this.thumbnailCanvas.height = height;
                  }
                  this.thumbnailContext = this.thumbnailCanvas.getContext(
                    "2d",
                    { alpha: false, willReadFrequently: true },
                  ) as any;
                }

                if (
                  this.thumbnailCanvas!.width !== width ||
                  this.thumbnailCanvas!.height !== height
                ) {
                  this.thumbnailCanvas!.width = width;
                  this.thumbnailCanvas!.height = height;
                }

                // Draw software pixels
                const imageData = new ImageData(
                  new Uint8ClampedArray(rgba),
                  width,
                  height,
                );
                this.thumbnailContext!.putImageData(imageData, 0, 0);

                // Convert to Blob
                if (this.thumbnailCanvas instanceof OffscreenCanvas) {
                  (this.thumbnailCanvas as OffscreenCanvas)
                    .convertToBlob({ type: "image/jpeg", quality: 0.7 })
                    .then((blob) => {
                      // Free C-side RGB buffer after blob creation
                      this.thumbnailBindings?.clearBuffer();
                      resolve(blob);
                    });
                } else {
                  (this.thumbnailCanvas as HTMLCanvasElement).toBlob(
                    (blob) => {
                      // Free C-side RGB buffer after blob creation
                      this.thumbnailBindings?.clearBuffer();
                      resolve(blob);
                    },
                    "image/jpeg",
                    0.7,
                  );
                }
              } else {
                Logger.warn(TAG, "Software fallback returned no data");
                resolve(null);
              }
            } catch (e) {
              Logger.error(TAG, "Software fallback exception", e);
              resolve(null);
            }
          }
        }, 500); // Fast timeout for fallback

        this.thumbnailDecoder?.setOnFrame((frame) => {
          if (resolved) {
            frame.close();
            return;
          }

          Logger.debug(
            TAG,
            `Thumbnail frame received: ${frame.codedWidth}x${frame.codedHeight}`,
          );

          // 3. Render VideoFrame to Canvas using WebGL (with HDR support)
          const videoTrack = this.mediaInfo?.tracks?.find(
            (t) => t.type === "video",
          ) as VideoTrack | undefined;
          const rotation = videoTrack?.rotation || 0;
          const isRotated = rotation % 180 !== 0;

          // Use display dimensions
          const frameW = frame.displayWidth;
          const frameH = frame.displayHeight;
          const canvasW = isRotated ? frameH : frameW;
          const canvasH = isRotated ? frameW : frameH;

          // Create canvas if needed
          if (!this.thumbnailCanvas) {
            if (typeof OffscreenCanvas !== "undefined") {
              this.thumbnailCanvas = new OffscreenCanvas(canvasW, canvasH);
            } else {
              this.thumbnailCanvas = document.createElement("canvas");
              this.thumbnailCanvas.width = canvasW;
              this.thumbnailCanvas.height = canvasH;
            }

            // Try to initialize WebGL with HDR support
            const colorSpace = this.detectThumbnailHDRColorSpace();
            const webglInitialized = this.initThumbnailWebGL(
              this.thumbnailCanvas,
              colorSpace,
            );

            // Fallback to 2D if WebGL fails
            if (!webglInitialized) {
              this.thumbnailContext = this.thumbnailCanvas.getContext("2d", {
                alpha: false,
                willReadFrequently: true,
              }) as any;
            }
          }

          // Resize canvas if dimensions changed
          if (
            this.thumbnailCanvas.width !== canvasW ||
            this.thumbnailCanvas.height !== canvasH
          ) {
            this.thumbnailCanvas.width = canvasW;
            this.thumbnailCanvas.height = canvasH;

            // Re-initialize WebGL if it was being used
            if (this.thumbnailGL) {
              const colorSpace = this.detectThumbnailHDRColorSpace();
              this.initThumbnailWebGL(this.thumbnailCanvas, colorSpace);
            }
          }

          // When rotated, ensure 2D context exists (WebGL path doesn't handle rotation)
          if (rotation !== 0 && !this.thumbnailContext && this.thumbnailCanvas) {
            this.thumbnailContext = this.thumbnailCanvas.getContext("2d", {
              alpha: false,
              willReadFrequently: true,
            }) as any;
          }

          // Render using WebGL if available (skip WebGL when rotated — 2D handles rotation)
          if (
            rotation === 0 &&
            this.thumbnailGL &&
            this.thumbnailGLProgram &&
            this.thumbnailGLTexture &&
            this.thumbnailGLVao
          ) {
            try {
              const gl = this.thumbnailGL;

              // Setup viewport
              gl.viewport(0, 0, canvasW, canvasH);
              gl.clearColor(0, 0, 0, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);

              // Bind program and VAO
              gl.useProgram(this.thumbnailGLProgram);
              gl.bindVertexArray(this.thumbnailGLVao);

              // Upload frame to texture
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, this.thumbnailGLTexture);
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                frame,
              );

              // Draw
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

              Logger.debug(
                TAG,
                `Thumbnail rendered with WebGL (HDR: ${this.thumbnailHDREnabled})`,
              );
            } catch (e) {
              Logger.warn(
                TAG,
                "WebGL thumbnail rendering failed, falling back to 2D",
                e,
              );
              // Fallback to 2D rendering
              if (this.thumbnailContext) {
                if (rotation !== 0) {
                  this.thumbnailContext.save();
                  this.thumbnailContext.translate(canvasW / 2, canvasH / 2);
                  this.thumbnailContext.rotate((rotation * Math.PI) / 180);
                  this.thumbnailContext.drawImage(
                    frame,
                    -frameW / 2,
                    -frameH / 2,
                    frameW,
                    frameH,
                  );
                  this.thumbnailContext.restore();
                } else {
                  this.thumbnailContext.drawImage(frame, 0, 0, frameW, frameH);
                }
              }
            }
          } else {
            // Use 2D canvas as fallback
            if (rotation !== 0 && this.thumbnailContext) {
              this.thumbnailContext.save();
              this.thumbnailContext.translate(canvasW / 2, canvasH / 2);
              this.thumbnailContext.rotate((rotation * Math.PI) / 180);
              this.thumbnailContext.drawImage(
                frame,
                -frameW / 2,
                -frameH / 2,
                frameW,
                frameH,
              );
              this.thumbnailContext.restore();
            } else {
              this.thumbnailContext?.drawImage(frame, 0, 0, frameW, frameH);
            }
          }

          frame.close();
          resolved = true;
          clearTimeout(timeout);

          // 4. Convert to Blob
          if (this.thumbnailCanvas instanceof OffscreenCanvas) {
            (this.thumbnailCanvas as OffscreenCanvas)
              .convertToBlob({ type: "image/jpeg", quality: 0.7 })
              .then((blob) => {
                Logger.debug(
                  TAG,
                  `Thumbnail blob created: ${blob?.size} bytes`,
                );
                // Free C-side RGB buffer (if software fallback was used)
                this.thumbnailBindings?.clearBuffer();
                resolve(blob);
              });
          } else {
            (this.thumbnailCanvas as HTMLCanvasElement).toBlob(
              (blob) => {
                Logger.debug(
                  TAG,
                  `Thumbnail blob created: ${blob?.size} bytes`,
                );
                // Free C-side RGB buffer (if software fallback was used)
                this.thumbnailBindings?.clearBuffer();
                resolve(blob);
              },
              "image/jpeg",
              0.7,
            );
          }
        });

      REMOVED OLD LOGIC END */

      // 2. Fallback to Software Decoding
      if (!rendered && this.previewSoftwareTooBig()) {
        this.previewInitGaveUp = true;
        Logger.warn(
          TAG,
          "The hardware preview decoder gave up on a frame too big to decode in " +
            "software without stalling the page — previews off for this source",
        );
        // Not here: this call still holds the bindings, and the finally below
        // reaches for them again. See the WASM use-after-destroy this pipeline
        // has already been bitten by.
        setTimeout(() => this.destroyPreviewPipeline(), 0);
        return null;
      }
      if (!rendered) {
        try {
          // The size the preview is SHOWN at, not the size the source is in.
          // See previewShape — this is where the 8K hang was.
          const videoTrack = this.trackManager.getActiveVideoTrack();
          const shrunk = videoTrack
            ? MoviPlayer.previewShape(videoTrack.width, videoTrack.height)
            : { width: 320, height: 180 };
          const width = shrunk.width;
          const height = shrunk.height;

          const rgba = this.thumbnailBindings!.decodeCurrentPacket(
            width,
            height,
          );
          if (rgba && rgba.length > 0) {
            this.thumbnailRenderer!.render(rgba, width, height);
            this.thumbnailBindings!.clearBuffer();
            rendered = true;
          } else {
            Logger.warn(TAG, "Software thumbnail decoder returned no data");
          }
        } catch (e) {
          Logger.error(TAG, "Software thumbnail fallback exception", e);
        }
      }

      if (rendered) {
        const blob = await this.encodePreviewBlob(
          this.thumbnailRenderer!.getCanvas() as
            | OffscreenCanvas
            | HTMLCanvasElement,
        );
        if (blob) {
          if (key !== null) this.rememberPreview(key, blob);
          // File it under its keyframe too, so the rest of this GOP is free.
          // Precise mode's frames are NOT their keyframe, and a 360 preview is
          // one angle of it, so neither may be reused this way.
          if (!this.precisePreviews && !view) {
            this.rememberKeyframePreview(timestamp, blob);
          }
        }
        return blob;
      }

      return null;
    } catch (e) {
      Logger.warn(TAG, "Preview generation failed", e);
      return null;
    } finally {
      this.isPreviewGenerating = false;
      this.previewInFlight = null;
      releaseInFlight();
      // Let the ThumbnailHttpSource keep its 2MB window for a while yet.
      //
      // Dropping it here — after every single frame — threw away the block the
      // fetch had just paid for, and a scrub is a run of hovers a fraction of
      // a second apart that land INSIDE that same block: measured on a 1.5MB/s
      // link, hovers at 100.8s and 101.6s of an un-downloaded stretch both sat
      // inside 114.9-117.0MB, and the second one re-fetched all 2MB of it
      // (1.65s) because the first one's copy had already been discarded.
      // Clear it once the scrub is over instead.
      this.scheduleThumbBufferClear();
    }
  }

  /**
   * Generate timeline thumbnails at regular intervals
   * @param count Number of thumbnails to generate (default 8)
   * @param onProgress Callback for each generated thumbnail
   * @returns Array of { time, blob } objects
   */
  async generateTimeline(
    count: number = 8,
    onProgress?: (index: number, total: number, blob: Blob, time: number) => void
  ): Promise<Array<{ time: number; blob: Blob }>> {
    const duration = this.mediaInfo?.duration ?? 0;
    if (duration <= 0) return [];

    const results: Array<{ time: number; blob: Blob }> = [];
    const interval = duration / (count + 1); // Avoid first/last frames

    for (let i = 1; i <= count; i++) {
      const time = interval * i;
      const blob = await this.getPreviewFrame(time);
      if (blob) {
        results.push({ time, blob });
        onProgress?.(i, count, blob, time);
      }
    }

    return results;
  }

  /**
   * The rung to decode seek previews from, or null when there is no ladder to
   * choose from (a single file — there is nothing cheaper to read).
   *
   * Lowest rung that still has some detail: a preview is a ~160px-wide still,
   * so anything above ~240p is pixels nobody sees, paid for in bytes and in
   * decode time on the machine already decoding playback. Below 240p the
   * picture starts to read as mush at 2x DPR, so that is the floor — and if
   * the ladder's smallest rung is lower than that, it is still the cheapest
   * thing on offer and wins by default.
   *
   * …but never ABOVE the rung being played. That floor is about how a preview
   * LOOKS, and it only earns its cost while the picture beside it is better
   * still. A player that opened on 144p did so because the link could not carry
   * more, and pulling a 240p stream alongside it to draw hover stills is the
   * one machine on the one link spending more on the preview than on the video.
   * There the cheapest rung is also the honest one: a still can hardly be
   * blurrier than the picture it is previewing.
   */
  private pickPreviewRendition(): {
    url: string;
    label: string;
    height?: number;
  } | null {
    const rungs = this._dashRenditions.filter((r) => r.url);
    if (rungs.length < 2) return null;
    const bySize = rungs
      .slice()
      .sort((a, b) => (a.height || 0) - (b.height || 0));
    const pick = bySize.find((r) => (r.height || 0) >= 240) || bySize[0];
    // What is actually streaming, by url — the ladder is the only place a
    // rendition's height is recorded.
    const playingHeight =
      this._dashRenditions.find((r) => r.url === this._activeDashRendition)
        ?.height || 0;
    if (playingHeight > 0 && (pick.height || 0) > playingHeight) {
      // Tallest rung that is no taller than the picture. Falls back to the
      // smallest when even that is above it, which is the cheapest read there
      // is and the closest thing to "the same as playback" on offer.
      return (
        [...bySize].reverse().find((r) => (r.height || 0) <= playingHeight) ||
        bySize[0]
      );
    }
    return pick;
  }

  /**
   * Arm the deferred preview warm-up, and keep re-arming it until playback has
   * actually settled.
   *
   * The delay exists to keep the second WASM module + WebCodecs decoder out of
   * the first seconds of PLAYBACK. It used to be a single timer started when
   * load() finished, which quietly assumes play() follows immediately — and on
   * a local file it does not. A FileSource preload reads 20×2MB before play()
   * is even reachable, so on an 11 GB MKV the 12s grace was already spent by
   * the time the first frame went up: the warm-up landed ~4.5s into playback,
   * stood a second isolated WASM instance up, re-opened the same 11 GB file
   * through the same main-thread Asyncify reads, and the audio cushion the
   * (all-software) decoder was holding collapsed into a stall that then made
   * no progress at all for six seconds, until MoviElement's stuck watchdog
   * seeked out of it.
   *
   * So measure the grace against playback, not load, and never start the
   * warm-up while the pipeline is already struggling — buffering and seeking
   * are precisely when the competing decode is least affordable. A source that
   * is simply sitting paused is not competing with anything, so it still warms
   * on schedule; if the user scrubs before any of that, the seek path lazy-inits
   * on demand (initPreviewPipeline is idempotent).
   */
  private schedulePreviewWarm(delayMs: number): void {
    if (this._previewWarmTimer) return;
    if (!this.previewsAllowed()) return;
    // A source with a storyboard has no use for the decode pipeline, and that
    // pipeline is the expensive half of previews: a second WASM module and its
    // own FFmpeg context, warmed in the background for previews that will be
    // crops out of a JPEG. The lazy path is still there if the board turns out
    // not to cover a position.
    if (this.storyboardSource) return;
    this._previewWarmTimer = setTimeout(() => {
      this._previewWarmTimer = null;
      if (this._destroyed || this.previewInitPromise || this.thumbnailBindings) {
        return;
      }
      const state = this.stateManager.getState();
      const busy =
        state === "loading" || state === "seeking" || state === "buffering";
      const playbackYoung =
        this._playStartTime > 0 &&
        performance.now() - this._playStartTime <
          MoviPlayer.PREVIEW_WARM_DELAY_MS;
      if (busy || playbackYoung) {
        this.schedulePreviewWarm(MoviPlayer.PREVIEW_WARM_RETRY_MS);
        return;
      }
      this.previewInitPromise = this.initPreviewPipeline().catch((e) => {
        Logger.warn(TAG, "Preview pipeline init failed (non-critical)", e);
        this.previewInitPromise = null;
      });
    }, delayMs);
  }

  private async initPreviewPipeline() {
    if (this.thumbnailBindings) return; // Already initialized
    // Everything below allocates — an isolated WASM module and FFmpeg context,
    // a WebCodecs decoder, a WebGL context — and it does so across long awaits
    // (module load, network open). destroy() or a load() of a new source can
    // land inside any of them, and both run destroyPreviewPipeline() before
    // this returns: whatever is built after that point is built onto a
    // pipeline nobody owns and nobody will release. Stop at each await.
    const gen = this._previewGeneration;
    const superseded = () => this._destroyed || gen !== this._previewGeneration;

    Logger.debug(TAG, "Initializing thumbnail pipeline...");
    // Use a NEW isolated WASM module instance for thumbnails
    // This prevents onReadRequest handler conflicts with main playback
    let module: Awaited<ReturnType<typeof loadWasmModuleNew>>;
    if (sharedThumbnailModule && !sharedThumbnailModuleInUse) {
      module = sharedThumbnailModule;
      sharedThumbnailModuleInUse = true;
      this._usingSharedThumbModule = true;
      Logger.debug(TAG, "Reusing the shared thumbnail WASM module");
    } else {
      module = await loadWasmModuleNew({
        wasmBinary: this.config.wasmBinary,
      });
      if (!sharedThumbnailModule) {
        // First one becomes the shared instance every later video reuses.
        sharedThumbnailModule = module;
        sharedThumbnailModuleInUse = true;
        this._usingSharedThumbModule = true;
      }
    }
    Logger.debug(TAG, "Thumbnail WASM module ready");
    if (superseded()) {
      this.releaseSharedThumbModule();
      return;
    }

    // Encrypted playback: reuse the main EncryptedHttpSource for thumbnails.
    // A 2nd EncryptedHttpSource spins up an independent ECDH handshake +
    // token-signed GETs, which the server treats as concurrent sessions;
    // observed server behavior is 206 responses with truncated/empty
    // bodies (seen as "Stream ended before block N" errors) when both
    // instances fetch overlapping ranges. Sharing the main source also
    // makes thumbnail reads free once the block is in the main source's
    // block cache — no extra network at all for near-playhead previews.
    const sourceConfig = this.config.source;
    const isEncrypted = sourceConfig
      && typeof sourceConfig !== "string"
      && (sourceConfig as any).type === "encrypted";
    const previewRung = this.pickPreviewRendition();
    // HLS demuxer fallback: the media is a concatenated segment stream, not the
    // .m3u8 playlist in config.source — opening that URL as media would fail.
    // Reuse the SegmentStreamSource: its read() is offset-explicit (safe to
    // share with the thumbnail demuxer) and its segment cache is shared too.
    if (this.source instanceof SegmentStreamSource) {
      this.thumbnailSource = this.source;
    }
    // Custom user-supplied adapter — we can't safely spin up a second reader
    // (we don't know the underlying protocol), so reuse the main source.
    // The user's read() must tolerate interleaved offsets in this case.
    else if (this.config.sourceAdapter && this.source) {
      this.thumbnailSource = this.source;
    } else if (isEncrypted && this.source) {
      this.thumbnailSource = this.source;
    } else if (previewRung) {
      // A ladder is available, so preview off a SMALL rung instead of whatever
      // the player is streaming. A hover thumbnail is ~160 CSS px wide; pulling
      // and decoding a 4K keyframe to fill it costs ~50x the pixels it can
      // show, and every one of those decodes lands on the same machine that is
      // busy decoding playback. The rung is also a fraction of the bytes, so
      // the seek-scrub reads stop competing with the playback stream.
      //
      // No borrow source here: a different rendition is a different file, so
      // the main source's cached bytes are not ours to read.
      Logger.debug(
        TAG,
        `Thumbnail source: using ${previewRung.label || previewRung.height + "p"} rung instead of the playing rendition`,
      );
      this.thumbnailSource = new ThumbnailHttpSource(
        previewRung.url,
        (sourceConfig && typeof sourceConfig !== "string" && "headers" in sourceConfig
          ? sourceConfig.headers
          : undefined) || {},
        null,
      );
    } else {
      // Plain HTTP / URL sources: use a dedicated ThumbnailHttpSource that
      // borrows (read-only) from the main source's metadata LRU +
      // sliding-window buffer, only fetching on miss.
      const borrowSource =
        this.source &&
        typeof (this.source as any).peekMetadata === "function" &&
        typeof (this.source as any).peekRange === "function"
          ? (this.source as any)
          : null;
      if (typeof sourceConfig === "string") {
        this.thumbnailSource = new ThumbnailHttpSource(sourceConfig, {}, borrowSource);
      } else if (sourceConfig && "url" in sourceConfig && sourceConfig.url) {
        this.thumbnailSource = new ThumbnailHttpSource(
          sourceConfig.url,
          sourceConfig.headers || {},
          borrowSource,
        );
      } else if (sourceConfig) {
        // File source. A second FileSource over the same File, sharing the main
        // one's LRU — but explicitly a SECONDARY reader: no preload sweep of its
        // own, and no cache-clearing on close. Both of those were costing a
        // whole extra read of the file, which is free on an SSD and very much
        // not on a Drive-backed virtual file. See FileSource.markSecondary.
        const thumbSource = await this.createSource(sourceConfig);
        if (thumbSource instanceof FileSource) thumbSource.markSecondary();
        this.thumbnailSource = thumbSource;
      } else if (this.source) {
        // No SourceConfig (custom adapter path) — fall back to main source.
        this.thumbnailSource = this.source;
      } else {
        throw new Error("No source available for thumbnail pipeline");
      }
      // Reuse the size the main source already resolved — a dedicated
      // ThumbnailHttpSource can't probe it on a non-range server (HEAD strips
      // Content-Length, the 200 GET may be chunked), which used to fail init.
      if (
        this.fileSize > 0 &&
        this.thumbnailSource &&
        "seedSize" in this.thumbnailSource &&
        typeof (this.thumbnailSource as { seedSize?: unknown }).seedSize === "function"
      ) {
        (this.thumbnailSource as { seedSize: (n: number) => void }).seedSize(this.fileSize);
      }
    }

    const fileSize = await this.thumbnailSource.getSize();
    Logger.debug(TAG, `Thumbnail source created, file size: ${fileSize}`);
    // Sizing a fresh reader is a network round trip of its own.
    if (superseded()) {
      if (this.thumbnailSource !== this.source) {
        try {
          this.thumbnailSource.close();
        } catch {}
      }
      this.thumbnailSource = null;
      this.releaseSharedThumbModule();
      return;
    }

    // Create thumbnail bindings
    // Held locally until the pipeline can actually make a frame.
    //
    // Published here, it read as "initialised" from the moment it existed —
    // and it exists two awaits before it is usable (create, then open, both
    // over the network). A preview asked for inside that window skipped the
    // wait-for-init branch, because bindings were set, and fell through to the
    // availability check, where the renderer was still missing: "Thumbnail
    // bindings or renderer not available", returned null, 182 times in one
    // session. The chapter strip asks for one frame per chapter in a tight
    // loop, so a panel opened in that window came out completely empty.
    const bindings = new ThumbnailBindings(module);
    this.thumbnailBindingsPending = bindings;

    const dataAdapter = {
      read: async (offset: number, size: number): Promise<Uint8Array> => {
        if (!this.thumbnailSource) throw new Error("No thumbnail source");
        const buffer = await this.thumbnailSource.read(offset, size);
        return new Uint8Array(buffer);
      },
      getSize: async (): Promise<number> => {
        if (!this.thumbnailSource) throw new Error("No thumbnail source");
        return this.thumbnailSource.getSize();
      },
    };
    bindings.setDataSource(dataAdapter);

    const created = await bindings.create(fileSize);
    Logger.debug(TAG, `Thumbnail context create result: ${created}`);
    if (!created) throw new Error("Failed to create thumbnail context");

    const opened = await bindings.open();
    Logger.debug(TAG, `Thumbnail context open result: ${opened}`);
    if (!opened) throw new Error("Failed to open thumbnail media");

    // Opening reads over the network — the same race as above, and this side
    // of it holds an FFmpeg context. Hand it back before returning.
    if (superseded()) {
      try {
        bindings.destroy();
      } catch {}
      this.thumbnailBindingsPending = null;
      this.releaseSharedThumbModule();
      return;
    }

    // Initialize Renderer
    this.thumbnailRenderer = new ThumbnailRenderer();

    let videoTrack = this.trackManager.getActiveVideoTrack();
    if (!videoTrack) {
      const tracks = this.trackManager.getVideoTracks();
      if (tracks.length > 0) videoTrack = tracks[0];
    }

    // Reading a different rendition means the main track describes the wrong
    // file — different dimensions, possibly a different codec, and certainly
    // different extradata. Take the picture's shape from the preview demuxer's
    // OWN stream info in that case; the main track stays the fallback for the
    // ordinary same-file path (and if the preview's info is unreadable).
    const previewInfo = previewRung
      ? bindings.getStreamInfo()
      : null;
    const shape = previewInfo?.width
      ? {
          width: previewInfo.width,
          height: previewInfo.height,
          rotation: previewInfo.rotation || 0,
          colorPrimaries: previewInfo.colorPrimaries,
          colorTransfer: previewInfo.colorTransfer,
          codec: previewInfo.codecName,
          profile: previewInfo.profile,
          level: previewInfo.level,
          extradata: bindings.getExtradata(),
        }
      : videoTrack
        ? {
            width: videoTrack.width,
            height: videoTrack.height,
            rotation: videoTrack.rotation || 0,
            colorPrimaries: videoTrack.colorPrimaries,
            colorTransfer: videoTrack.colorTransfer,
            codec: videoTrack.codec,
            profile: videoTrack.profile,
            level: videoTrack.level,
            extradata: this.demuxer?.getExtradata(videoTrack.id) ?? null,
          }
        : null;

    if (shape) {
      // Initialize renderer dimensions and HDR settings
      // The canvas is a preview surface, so it is preview-sized: a WebGL
      // surface at 8K is 132MB to allocate and to read back, for a picture
      // that is 480px wide. The draw scales the frame on the GPU on its way
      // in, which is cheaper than doing it afterwards as well.
      const canvasShape = MoviPlayer.previewShape(shape.width, shape.height);
      this.thumbnailRenderer.initialize({
        width: canvasShape.width,
        height: canvasShape.height,
        rotation: shape.rotation,
        colorPrimaries: shape.colorPrimaries,
        colorTransfer: shape.colorTransfer,
        hdrEnabled: this.thumbnailHDREnabled,
      });

      // Configure internal VideoDecoder
      const extradata = shape.extradata;

      Logger.debug(
        TAG,
        `Configuring thumbnail decoder with track: ${shape.codec} ${shape.width}x${shape.height}, extradata: ${extradata ? extradata.length : 0} bytes`,
      );
      const configured = await this.thumbnailRenderer.configureDecoder(
        shape.codec,
        extradata, // can be null
        shape.width,
        shape.height,
        shape.profile,
        shape.level,
      );

      if (!configured) {
        // The software fallback decodes the frame WHOLE, in WASM, on this
        // thread — the scaler can hand back a small picture but the decode
        // itself is the source's own size. At 8K that is most of a second per
        // hover with everything else stopped, which is the seek bar hanging
        // the player while the keyboard seeks fine. Past the budget there is
        // no version of this worth having: no preview is better than a frozen
        // bar, and the bar still seeks.
        if (shape.width * shape.height > MoviPlayer.PREVIEW_SOFTWARE_MAX_PIXELS) {
          this.previewInitGaveUp = true;
          Logger.warn(
            TAG,
            `No hardware path for ${shape.codec} at ${shape.width}x${shape.height}, ` +
              "and software decode at that size would stall the page — previews off for this source",
          );
          // Everything this got as far as building — the second WASM context,
          // its own reader, the WebGL surface — is for a pipeline that is not
          // going to be used. It is never published, so teardown is the only
          // thing that can still reach it.
          this.destroyPreviewPipeline();
          return;
        }
        Logger.warn(
          TAG,
          "Failed to configure thumbnail VideoDecoder, will use software fallback",
        );
      }
    } else {
      Logger.warn(TAG, "No video track found for thumbnail renderer");
    }

    // Published last, and only now: from here a caller that finds bindings set
    // can rely on there being a renderer behind them. Until this line it is
    // reachable only through thumbnailBindingsPending, which is teardown's
    // business and nobody else's.
    this.thumbnailBindings = bindings;
    this.thumbnailBindingsPending = null;

    Logger.debug(TAG, "Thumbnail pipeline initialized successfully");
  }

  /** Hand the shared thumbnail module back, if this player holds it. */
  private releaseSharedThumbModule(): void {
    if (!this._usingSharedThumbModule) return;
    this._usingSharedThumbModule = false;
    sharedThumbnailModuleInUse = false;
    // A read or seek left in flight belongs to the context being torn down;
    // the next video's bindings must not inherit it.
    try {
      const m = sharedThumbnailModule as unknown as { _pendingSeek?: unknown } | null;
      if (m && m._pendingSeek) m._pendingSeek = null;
    } catch {
      /* nothing to clear */
    }
  }

  /**
   * Is the source playing without a duration anybody could find?
   *
   * True only once the media is actually open — during a load the duration is
   * legitimately unknown and the UI should stay blank, not pretend the file is
   * endless. Drives the seek bar's live-edge rendering and hides the 0:00 that
   * would otherwise sit where a total ought to be.
   */
  hasUnknownDuration(): boolean {
    if (!this.mediaInfo) return false;
    if (this.mediaInfo.duration > 0) return false;
    const state = this.stateManager.getState();
    return state !== "idle" && state !== "loading" && state !== "error";
  }

  /**
   * Try once more for a missing duration, with playback already running.
   *
   * The scan inside open() has a load waiting on it, so it is capped in the
   * single seconds and gives up having read a few percent of anything but a
   * small file — a 291MB Matroska got 14MB in before its second was up. Off
   * the load path there is nothing to hold up, so the same pass can be given
   * the time it actually needs.
   *
   * It cannot run on the playing context: movi_scan_duration reads that
   * context to EOF and then seeks it back, which would take every packet out
   * of the demuxer's mouth. So it opens its own, over its own reader, exactly
   * as the preview pipeline does — and for the same reason.
   */
  private scheduleDurationRescan(): void {
    if (this._durationRescanDone || this._durationRescanTimer) return;
    if (this._destroyed || this.streamWrapper) return;
    // No SourceConfig means a caller-supplied adapter: we don't know how to
    // build a second reader for it, and sharing the one playback is using
    // would interleave a whole-file sweep into its reads.
    if (!this.config.source) return;

    this._durationRescanTimer = setTimeout(() => {
      this._durationRescanTimer = null;
      void this.rescanDurationInBackground();
    }, MoviPlayer.DURATION_RESCAN_DELAY_MS);
  }

  private async rescanDurationInBackground(): Promise<void> {
    if (this._durationRescanDone || this._destroyed) return;
    this._durationRescanDone = true; // one attempt per source, win or lose

    const sourceConfig = this.config.source;
    if (!sourceConfig || !this.source) return;

    const budgetMs = Demuxer.durationRescanBudgetMs(
      this.source.getKey(),
      this.fileSize,
    );
    if (budgetMs === null) {
      Logger.debug(TAG, "Duration rescan: source isn't worth a full pass");
      return;
    }

    // The generation this attempt belongs to. Everything below is a long await
    // over a reader we own, and a load() of a new source (or destroy()) can
    // land inside any of them — the result would then be the OLD file's
    // duration, published over the new one's.
    const gen = this._previewGeneration;
    const superseded = () => this._destroyed || gen !== this._previewGeneration;

    let scanSource: SourceAdapter | null = null;
    let bindings: WasmBindings | null = null;
    try {
      const cfg =
        typeof sourceConfig === "string"
          ? ({ type: "url", url: sourceConfig } as SourceConfig)
          : sourceConfig;
      scanSource = await this.createSource(cfg);
      // A second reader over the same File: no preload sweep of its own, and
      // no cache-clearing on close. See FileSource.markSecondary.
      if (scanSource instanceof FileSource) scanSource.markSecondary();
      if (superseded()) return;

      const module = await loadWasmModuleNew({
        wasmBinary: this.config.wasmBinary,
      });
      if (superseded()) return;

      bindings = new WasmBindings(module);
      if (!bindings.create()) throw new Error("Failed to create scan context");
      bindings.setDataSource({
        read: async (offset: number, size: number): Promise<Uint8Array> =>
          new Uint8Array(await scanSource!.read(offset, size)),
        getSize: async (): Promise<number> => scanSource!.getSize(),
      });
      await bindings.open();
      if (superseded()) return;

      Logger.info(
        TAG,
        `Duration rescan: scanning in the background (budget ${Math.round(budgetMs / 1000)}s)`,
      );
      const started = performance.now();
      const scanned = await bindings.scanDuration(budgetMs);
      const elapsed = Math.round(performance.now() - started);
      if (superseded()) return;

      if (!(scanned > 0)) {
        Logger.warn(TAG, `Duration rescan found nothing usable (${elapsed}ms)`);
        return;
      }
      if (!this.mediaInfo || this.mediaInfo.duration > 0) return;

      Logger.info(TAG, `Duration rescan recovered ${scanned}s (${elapsed}ms)`);
      this.mediaInfo.duration = scanned;
      this.clock.setDuration(scanned + this.startTime);
      this.emit("durationChange", scanned);
    } catch (e) {
      Logger.warn(TAG, "Duration rescan failed (non-critical)", e);
    } finally {
      try {
        bindings?.destroy();
      } catch {}
      try {
        scanSource?.close();
      } catch {}
    }
  }

  /**
   * Drop the preview reader's fetch window once hovering has stopped, so the
   * 2MB it holds isn't kept for the rest of the session — but not between two
   * hovers of the same scrub, which is what it exists for.
   */
  private scheduleThumbBufferClear(): void {
    if (this._thumbBufferIdleTimer) clearTimeout(this._thumbBufferIdleTimer);
    this._thumbBufferIdleTimer = setTimeout(() => {
      this._thumbBufferIdleTimer = null;
      const src = this.thumbnailSource as { clearBuffer?: () => void } | null;
      if (src && typeof src.clearBuffer === "function") src.clearBuffer();
    }, MoviPlayer.THUMB_BUFFER_IDLE_MS);
  }

  /**
   * The seek bar is done asking: stop downloading the rest of the preview
   * reader's fetch window, keeping the bytes that have arrived.
   *
   * The window keeps streaming after its frame is made so a scrub's next hover
   * finds its bytes already here — worth it only while the pointer is still
   * travelling. The caller is the one that knows: the player sees requests, and
   * on a fetching source the seek bar deliberately holds those back for up to
   * 1.5s mid-drag, so a quiet spell here is not a pointer at rest. Ignored
   * while a frame is being made; its own reads need the window.
   */
  stopPreviewFill(): void {
    if (this.isPreviewGenerating) return;
    const src = this.thumbnailSource as { stopFill?: () => void } | null;
    src?.stopFill?.();
  }

  private destroyPreviewPipeline() {
    this._previewGeneration++;
    if (this._durationRescanTimer) {
      clearTimeout(this._durationRescanTimer);
      this._durationRescanTimer = null;
    }
    if (this._thumbBufferIdleTimer) {
      clearTimeout(this._thumbBufferIdleTimer);
      this._thumbBufferIdleTimer = null;
    }
    this.releaseSharedThumbModule();
    // A build that was still in flight holds a context too, and an init that
    // threw between creating it and publishing it leaves it here.
    if (this.thumbnailBindingsPending) {
      try {
        this.thumbnailBindingsPending.destroy();
      } catch {}
      this.thumbnailBindingsPending = null;
    }
    if (this.thumbnailBindings) {
      try {
        this.thumbnailBindings.destroy();
      } catch {}
    }

    if (this.thumbnailRenderer) {
      this.thumbnailRenderer.destroy();
      this.thumbnailRenderer = null;
    }

    // Only a reader of our own. The encrypted / HLS / custom-adapter paths
    // deliberately share the MAIN source, and closing that here would pull it
    // out from under playback (or, from destroy(), from the close that follows).
    if (this.thumbnailSource && this.thumbnailSource !== this.source) {
      try {
        this.thumbnailSource.close();
      } catch {}
    }
    this.thumbnailSource = null;
    this.previewInitPromise = null;
  }

  /**
   * Get all tracks
   */
  getTracks(): Track[] {
    return this.trackManager.getTracks();
  }

  /**
   * DASH-fallback video Representations for the demuxer-mode quality menu
   * (best-first), and the one currently playing. Empty unless force-demuxing.
   */
  getDashRenditions(): {
    url: string;
    label: string;
    id: string;
    bandwidth?: number;
  }[] {
    return this._dashRenditions;
  }
  getActiveDashRendition(): string {
    return this._activeDashRendition;
  }

  /**
   * Externally supply the video renditions (with bitrate) for the ABR — used by
   * the premuxed multi-source path, which owns the quality list in the element.
   *
   * `activeUrl` seeds which rendition is *currently* playing. This matters: the
   * ABR compares its pick against `_activeDashRendition`, and until a swap sets
   * that it's "". With it empty the ABR can't recognise the file already on
   * screen, so it "switches" to the identical rendition — a pointless in-place
   * swap that reseeks the video and desyncs it against the still-running split
   * audio. Seed it once (only when unset, so a real swap's value isn't clobbered
   * by a later menu re-render passing the unchanged element src).
   */
  setDashRenditions(
    renditions: {
      url: string;
      label: string;
      id: string;
      bandwidth?: number;
      height?: number;
      codec?: string;
    }[],
    activeUrl?: string,
  ): void {
    // NOTE: the device decode cap is deliberately NOT reset here — it lives at
    // module level and must persist across sources (a device that can't decode
    // 8K can't decode it for the next video either).
    this._dashRenditions = renditions;
    // Ask the device about the big rungs now, while nothing is riding on the
    // answer, so the ABR never has to learn a ceiling by stuttering into it.
    void this.screenRungsForDecodeCapability(renditions);
    if (activeUrl && !this._activeDashRendition) {
      this._activeDashRendition = activeUrl;
    }
  }

  /** Current network throughput estimate (bytes/s). Hosts can persist this and
   *  re-seed the next video (a fresh player) so the ABR sizes the starting
   *  quality from a real number instead of climbing up from a cold estimate. */
  getNetworkThroughputBps(): number {
    return this._lastThroughputBps;
  }

  /** Seed the throughput estimate (bytes/s) before playback measures its own.
   *  Only applied while no live measurement exists, so a real sample always
   *  wins. Lets a fresh video pick the right rung on the first ABR tick. */
  seedNetworkThroughputBps(bps: number): void {
    if (bps > 0 && this._lastThroughputBps <= 0) {
      this._lastThroughputBps = bps;
    }
  }

  /**
   * Fold the source's live download speed into the throughput estimate. Meant to
   * be called frequently (every UI tick, ~250ms) — the ABR's own 4s tick is too
   * coarse to catch a small file that finishes downloading in under a second, so
   * a fully-cached video would otherwise leave the estimate stale/low and Auto,
   * thinking the link is slow, would sit stuck at the low starting rung.
   */
  sampleThroughput(): void {
    // `this.source` is null whenever a wrapper owns the networking (Shaka /
    // HLS / DASH), and it is null again after unload. The `?.()` below only
    // guards a MISSING METHOD, not a missing source — so the UI tick, which
    // calls this every ~250ms regardless of which pipeline is playing, threw
    // "Cannot read properties of null (reading 'getNetworkStats')" on every
    // HLS playback. Same shape at the three ABR call sites.
    const s = (
      this.source as {
        getNetworkStats?: () => { currentSpeed: number; lastSpeed?: number };
      } | null
    )?.getNetworkStats?.();
    const raw = s?.lastSpeed ?? s?.currentSpeed ?? 0;
    if (raw > 0) {
      this._lastThroughputBps =
        this._lastThroughputBps > 0
          ? this._lastThroughputBps * 0.7 + raw * 0.3
          : raw;
    }
  }

  /**
   * Get video tracks
   */
  getVideoTracks(): VideoTrack[] {
    return this.trackManager.getVideoTracks();
  }

  /**
   * Get audio tracks
   */
  getAudioTracks(): AudioTrack[] {
    return this.trackManager.getAudioTracks();
  }

  /**
   * Get subtitle tracks
   */
  getSubtitleTracks(): SubtitleTrack[] {
    return this.trackManager.getSubtitleTracks();
  }

  /**
   * Select audio track
   */
  selectAudioTrack(trackId: number): boolean {
    return this.trackManager.selectAudioTrack(trackId);
    // Note: change event listeners above will reconfigure decoder
  }

  /**
   * Route audio output to a specific device (AudioContext.setSinkId).
   * "" → system default. Returns false when unsupported / device gone.
   */
  setAudioOutputDevice(deviceId: string): Promise<boolean> {
    return this.audioRenderer.setSinkId(deviceId);
  }

  /** Current audio output device id ("" = system default). */
  getAudioOutputDevice(): string {
    return this.audioRenderer.getSinkId();
  }

  /**
   * Select subtitle track
   */
  async selectSubtitleTrack(trackId: number | null): Promise<boolean> {
    Logger.info(TAG, `selectSubtitleTrack called: trackId=${trackId}`);
    const result = this.trackManager.selectSubtitleTrack(trackId);
    Logger.debug(TAG, `TrackManager.selectSubtitleTrack returned: ${result}`);

    // Track changed — invalidate any prefetched cue list so the next
    // setSubtitleDelay re-scans the new stream.
    if (this.prefetchedSubtitleStream !== trackId) {
      this.prefetchedSubtitleStream = null;
    }

    // Clear subtitles when track is deselected
    if (trackId === null) {
      Logger.info(TAG, "Disabling subtitles");
      if (this.videoRenderer) {
        this.videoRenderer.clearSubtitles();
        Logger.debug(TAG, "Cleared subtitles from video renderer");
      }
      if (this.subtitleDecoder) {
        this.subtitleDecoder.close();
        Logger.debug(TAG, "Closed subtitle decoder");
      }
      if (this._customSubtitleRenderer) {
        try {
          this._customSubtitleRenderer.clear();
        } catch {
          /* ignore */
        }
      }
      return result;
    }

    // A host renderer owns subtitles — reset it and configure for the new track,
    // skipping the internal decoder path entirely.
    if (this._customSubtitleRenderer && !this.streamWrapper) {
      try {
        this._customSubtitleRenderer.clear();
      } catch {
        /* ignore */
      }
      await this._configureCustomSubtitleRenderer();
      return result;
    }

    // Adaptive streams: Shaka already applied the text-track selection (via the
    // trackManager → streamWrapper wiring) and renders cues itself. There's no
    // FFmpeg demuxer / subtitle decoder to configure, so stop here.
    if (this.streamWrapper) {
      return result;
    }

    // Configure decoder for new subtitle track
    if (this.demuxer && this.subtitleDecoder) {
      const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
      Logger.info(
        TAG,
        `Configuring subtitle decoder for track: id=${subtitleTrack?.id}, codec=${subtitleTrack?.codec}, type=${subtitleTrack?.subtitleType}`,
      );

      if (subtitleTrack) {
        // Close previous decoder before configuring new one (helps with track switching)
        Logger.debug(
          TAG,
          "Closing previous subtitle decoder before switching tracks",
        );
        this.subtitleDecoder.close();

        // Set bindings first (required for configure)
        const bindings = this.demuxer.getBindings();
        if (bindings) {
          Logger.debug(TAG, "Setting bindings on subtitle decoder");
          this.subtitleDecoder.setBindings(bindings, false);
        } else {
          Logger.warn(TAG, "No bindings available from demuxer!");
        }

        const extradata =
          this.demuxer.getExtradata(subtitleTrack.id) ?? undefined;
        Logger.debug(
          TAG,
          `Configuring subtitle decoder: extradata=${extradata?.length || 0} bytes`,
        );
        const configured = await this.subtitleDecoder.configure(
          subtitleTrack,
          extradata,
        );
        Logger.info(
          TAG,
          `Subtitle decoder configuration result: ${configured}`,
        );

        if (configured) {
          // Set up subtitle cue callback
          Logger.debug(TAG, "Setting up subtitle cue callback");
          this.subtitleDecoder.setOnCue((cue) => {
            Logger.debug(
              TAG,
              `Subtitle cue callback triggered: "${cue.text?.substring(0, 30)}..." (${cue.start.toFixed(2)}s - ${cue.end.toFixed(2)}s)`,
            );
            if (this.videoRenderer) {
              Logger.debug(TAG, "Setting subtitle cue on video renderer");
              this.videoRenderer.setSubtitleCues([cue]);
            } else {
              Logger.warn(TAG, "Subtitle cue callback: videoRenderer is null!");
            }
          });

          // TODO: Seek to re-read subtitle packets causes playback disruption
          // const currentTime = this.getCurrentTime();
          // Logger.debug(TAG, `Seeking to ${currentTime.toFixed(2)}s to pick up subtitle packets`);
          // this.seek(currentTime).catch(() => {});

          // If a non-zero subtitle delay is already configured (e.g. set
          // before the track was selected, or persisted via attribute),
          // prefetch the full cue list now so the renderer has
          // out-of-order cues available immediately.
          if (this.videoRenderer && this.videoRenderer.getSubtitleDelay() !== 0) {
            void this.prefetchActiveSubtitleStream();
          }
        } else {
          Logger.warn(
            TAG,
            `Could not configure subtitle decoder for track ${subtitleTrack.id} (${subtitleTrack.codec}) - codec may not be available in WASM build`,
          );
          // If decoder configuration failed, deselect the track since we can't decode it
          this.trackManager.selectSubtitleTrack(-1);
          return false;
        }
      } else {
        Logger.warn(
          TAG,
          `No active subtitle track found after selecting trackId ${trackId}`,
        );
      }
    } else {
      Logger.warn(
        TAG,
        `Cannot configure subtitle decoder: demuxer=${!!this.demuxer}, subtitleDecoder=${!!this.subtitleDecoder}`,
      );
    }

    return result;
  }

  /**
   * Get current playback time
   */
  getCurrentTime(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getCurrentTime();
    }
    // Subtract seekKeyframeOffset so the timeline reports the user-requested
    // time after a seek instead of where the decoder actually landed (which
    // can be seconds later on long-GOP containers like .ts). Offset is reset
    // on every new seek and only ever non-negative.
    return Math.max(
      0,
      this.clock.getTime() - this.startTime - this.seekKeyframeOffset,
    );
  }

  /**
   * After a `postertime` seek has painted the poster frame on the canvas,
   * reset only the CLOCK/playhead bookkeeping back to the start — WITHOUT
   * flushing the decoder, re-seeking the demuxer, or clearing the renderer
   * queue. That keeps the poster frame (from ~postertime) visible on the
   * canvas while the seek bar/getCurrentTime() read 0, and lets the first
   * play() start cleanly from the beginning (play()'s first-play branch
   * re-seeks the demuxer to 0 itself). Pure time-math; touches no media state.
   */
  resetClockToStartForPoster(): void {
    if (this.streamWrapper) return; // HLS owns its own timeline
    this.clock.seek(this.startTime); // paused → pausedTime = startTime
    this.seekKeyframeOffset = 0; // so getCurrentTime() === 0
    this.seekTargetTime = -1; // clear any lingering pre-target frame-drop filter
    this._videoResumeTarget = -1;
    // …and with the gate goes the thing waiting on it. Left armed, the sound
    // would carry playback for the whole of the next source — which means no
    // A/V binding, so a picture drifting from the sound would never be pulled
    // back. See _soundCarryingAlone.
    this._soundCarryingAlone = false;
    this.waitingForVideoSync = false; // no stale seek-completion armed
    this._playStartTime = 0; // keep first-play branch eligible
    // …which realigns the demuxer anyway, so a paused-seek flag left over from
    // the last source has nothing to add.
    this._demuxerAheadOfClock = false;
    this._primingAudio = false;
    this.pendingAudioPackets = []; // poster-era audio is stale; play() re-seeks
    this.pendingPrebufferPackets = [];
    this.dropVideoReadAhead();
    // The poster seek advanced HttpSource's monotonic buffered-end to ~poster
    // time; reset it (as a real seek does) so the buffer bar starts from 0
    // instead of showing a false prebuffer at the poster timestamp. The range
    // start goes back to 0 too — the poster seek re-seeks to the beginning.
    this.lastBufferedTime = 0;
    this.bufferedRangeStart = 0;
    this.emit("timeUpdate", this.getCurrentTime()); // snap seek bar to 00:00
  }

  /**
   * Get duration
   */
  getDuration(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getDuration();
    }
    return this.mediaInfo?.duration ?? 0;
  }

  /**
   * Get LRU cache statistics
   */
  getCacheStats(): {
    utilization: number;
    sizeBytes: number;
    maxSizeBytes: number;
    entryCount: number;
  } {
    return {
      utilization: this.cache.getUtilization(),
      sizeBytes: this.cache.getSize(),
      maxSizeBytes: this.cache.getMaxSize(),
      entryCount: this.cache.getEntryCount(),
    };
  }

  /**
   * Get cached time ranges for visualization
   * Converts cached byte ranges to time ranges
   * @returns Array of {start, end} time ranges in seconds
   */
  getCachedTimeRanges(): Array<{ start: number; end: number }> {
    if (!this.source || !this.mediaInfo || this.fileSize <= 0) {
      return [];
    }

    const sourceKey = this.source.getKey();
    const byteRanges = this.cache.getCachedRanges(sourceKey);
    const duration = this.mediaInfo.duration;

    if (duration <= 0) {
      return [];
    }

    // Convert byte ranges to time ranges using linear estimation
    const timeRanges: Array<{ start: number; end: number }> = [];

    for (const range of byteRanges) {
      const startRatio = range.offset / this.fileSize;
      const endRatio = (range.offset + range.length) / this.fileSize;

      const start = Math.max(0, Math.min(duration, startRatio * duration));
      const end = Math.max(0, Math.min(duration, endRatio * duration));

      if (end > start) {
        timeRanges.push({ start, end });
      }
    }

    return timeRanges;
  }

  /**
   * Get current state
   */
  getState(): PlayerState {
    if (this.streamWrapper) {
      return this.streamWrapper.getState();
    }
    return this.stateManager.getState();
  }

  /**
   * Intended playback state, independent of transient interruptions.
   *
   * The raw state flips to "buffering"/"seeking" while the user is still
   * mid-playback (network stall, internal seek), which would otherwise make
   * the UI's play/pause icon flicker to "play" even though the user never
   * paused. This returns true whenever playback is meant to be running —
   * actually "playing", or interrupted by a buffer/seek that we entered
   * from a playing state (tracked via wasPlayingBeforeRebuffer/Seek). Use
   * this to drive the play/pause icon so it stays stable through stalls.
   */
  isPlaybackIntended(): boolean {
    const state = this.getState();
    if (state === "playing") return true;
    if (
      (state === "buffering" || state === "seeking") &&
      (this.wasPlayingBeforeRebuffer || this.wasPlayingBeforeSeek)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Get media info
   */
  /**
   * Load an encrypted video source
   * Reconfigures the player with an EncryptedHttpSource
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
    this.config.source = {
      type: "encrypted",
      encrypted: config,
    };
    await this.load();
  }

  getMediaInfo(): MediaInfo | null {
    return this.mediaInfo;
  }

  getContentDispositionFilename(): string | null {
    if (this.source instanceof HttpSource) {
      return this.source.getContentDispositionFilename();
    }
    return null;
  }

  getMetadataTitle(): string | null {
    return this.mediaInfo?.metadata?.title ?? null;
  }

  /**
   * Get HLS video element (DRM mode) for direct DOM insertion
   */
  getHLSVideoElement(): HTMLVideoElement | null {
    return this.streamWrapper?.getVideoElement() ?? null;
  }


  /** Chapters supplied by the host, which win over anything in the container.
   *  Null = none supplied, so the container's own chapters are used. */
  private _externalChapters:
    | Array<{ title: string; start: number; end?: number; image?: string }>
    | null = null;

  /**
   * Get chapters: the host's list if it supplied one, otherwise the media's
   * own (MKV/MP4 chapter atoms, read by the demuxer).
   *
   * Ends are filled in HERE rather than when the list is set, because a host
   * typically has its chapters before the media is open — at which point the
   * duration is still 0 and the last chapter would be left ending where it
   * starts, i.e. zero-length.
   */
  getChapters(): Array<{
    title: string;
    start: number;
    end: number;
    image?: string;
  }> {
    const own = this._externalChapters;
    if (!own) return this.mediaInfo?.chapters ?? [];
    const duration = this.getDuration();
    return own.map((c, i) => ({
      title: c.title,
      start: c.start,
      image: c.image,
      end:
        Number.isFinite(c.end as number) && (c.end as number) > c.start
          ? (c.end as number)
          : i < own.length - 1
            ? own[i + 1].start
            : duration > c.start
              ? duration
              : c.start,
    }));
  }

  /**
   * Supply chapters from outside the media file. Most streaming sources carry
   * them nowhere near the bytes — YouTube keeps them in the watch page, a CMS
   * in its own database — so a player that can only read container chapters
   * can't show them for the sources that use them most.
   *
   * Ends are derived where omitted: a chapter runs until the next one starts,
   * and the last to the end of the media. Pass null (or an empty list) to drop
   * back to the container's own chapters.
   */
  setChapters(
    list:
      | Array<{ title: string; start: number; end?: number; image?: string }>
      | null
      | undefined,
  ): void {
    if (!list || list.length === 0) {
      this._externalChapters = null;
      return;
    }
    const sorted = list
      .filter((c) => Number.isFinite(c.start) && c.start >= 0)
      .map((c) => ({
        title: String(c.title ?? ""),
        start: Number(c.start),
        end: c.end,
        // Carried verbatim. An empty string is dropped rather than passed on,
        // so a tile falls back to a decoded frame instead of rendering a
        // broken image for a field the host left blank.
        image: c.image ? String(c.image) : undefined,
      }))
      .sort((a, b) => a.start - b.start);
    this._externalChapters = sorted.length ? sorted : null;
  }

  resizeCanvas(width: number, height: number): void {
    if (this.streamWrapper) {
      // The active stream wrapper owns the shared canvas — resize only its
      // renderer. The main videoRenderer isn't the active renderer here and,
      // crucially, only the wrapper's canvasRenderer receives setVideoRotation,
      // so the main one stays at 0°. Resizing it too would re-run its
      // (unrotated) resize on the SAME canvas and clobber the wrapper's
      // rotation-aware styles (position/transform/dimension-swap) — the video
      // reverts to un-rotated on any resize after a rotate.
      this.streamWrapper.resizeCanvas(width, height);
    } else if (this.videoRenderer) {
      this.videoRenderer.resize(width, height);
    }
    // A resize often coincides with a fullscreen / orientation / PiP change —
    // a good moment to recover a wake lock that dropped or whose first request
    // failed. Idempotent: no-op when already held / not playing / page hidden.
    this.ensureWakeLock();
  }

  /**
   * Set HDR enabled state
   */
  setHDREnabled(enabled: boolean): void {
    this.thumbnailHDREnabled = enabled;
    if (this.videoRenderer && (this.videoRenderer as any).setHDREnabled) {
      (this.videoRenderer as any).setHDREnabled(enabled);
    }

    if (this.thumbnailRenderer) {
      this.thumbnailRenderer.setHDREnabled(enabled);
    }

    // For non-Chromium browsers with tone mapping shader, just update the uniform
    // No need to recreate the entire context
    /* Manual WebGL update logic removed */
  }

  /**
   * Check if current media is HDR
   */
  isHDRSupported(): boolean {
    if (this.videoRenderer && (this.videoRenderer as any).isHDRSupported) {
      return (this.videoRenderer as any).isHDRSupported();
    }
    return false;
  }

  /**
   * Set subtitle overlay element for HTML-based subtitle rendering
   */
  setSubtitleOverlay(overlay: HTMLElement | null): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleOverlay(overlay);
    }
  }

  /**
   * Set extra bottom padding for subtitles when controls are visible
   */
  /** See CanvasRenderer.subtitleReservePx. */
  getSubtitleReserve(): number {
    return this.videoRenderer?.subtitleReservePx() ?? 0;
  }

  /** Hold the caption still while the viewer drags it. */
  setSubtitleHeld(held: boolean): void {
    this.videoRenderer?.setSubtitleHeld(held);
  }

  setSubtitleControlsPadding(padding: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleControlsPadding(padding);
    }
  }

  /**
   * Rotate video 90 degrees clockwise
   */
  rotateVideo(): number {
    // Adaptive streams render via the wrapper's OWN CanvasRenderer on the
    // shared canvas — MoviPlayer's own videoRenderer never gets frames for a
    // stream, so its containerWidth stays 0 and rotate90() there is a silent
    // no-op (the button/shortcut appeared to do nothing / not center). Route
    // to the wrapper instead, same as setVideoRotation().
    if (this.streamWrapper) {
      return (this.streamWrapper as any).rotateVideo?.() ?? 0;
    }
    if (this.videoRenderer) {
      return this.videoRenderer.rotate90();
    }
    return 0;
  }

  /**
   * The currently-displayed picture, or null — a decoded VideoFrame, or the
   * <video> element on the MSE paths. Fallback capture source for snapshots
   * when the WebGL canvas reads back blank; both are drawImage sources.
   */
  getCurrentVideoFrame(): RenderSource | null {
    return this.videoRenderer?.getCurrentFrame() ?? null;
  }

  /**
   * Get current video rotation
   */
  getVideoRotation(): number {
    if (this.streamWrapper) {
      return (this.streamWrapper as any).getVideoRotation?.() ?? 0;
    }
    return this.videoRenderer?.getRotation() ?? 0;
  }

  setVideoRotation(deg: number): void {
    this.videoRenderer?.setManualRotation(deg);
    // Adaptive streams draw through the wrapper's OWN CanvasRenderer on the same
    // canvas; without routing the rotation there too, its per-frame resize()
    // resets the canvas to an un-rotated 100% box and clobbers the centering
    // (the video ends up rotated but pinned to one side). Mirrors setFitMode.
    (this.streamWrapper as any)?.setVideoRotation?.(deg);
  }

  setFitMode(mode: "contain" | "cover" | "fill" | "zoom" | "control"): void {
    if (this.streamWrapper) {
      this.streamWrapper.setFitMode(mode);
    }
    if (this.videoRenderer) {
      this.videoRenderer.setFitMode(mode);
    }
  }

  setLetterboxColor(r: number, g: number, b: number): void {
    if (this.videoRenderer) {
      this.videoRenderer.setLetterboxColor(r, g, b);
    }
  }

  // ───────────────────────── 360° VR ─────────────────────────

  /** Enable/disable 360° equirectangular projection on the video renderer. */
  setVR360(enabled: boolean): void {
    this.videoRenderer?.setVR360(enabled);
  }

  isVR360Enabled(): boolean {
    return this.videoRenderer?.isVR360Enabled() ?? false;
  }

  /** Live 360° camera + projection snapshot for reprojecting seek-bar previews
   *  to the current view. Null when not in 360. */
  getVR360View(): VRView | null {
    return this.videoRenderer?.getVRView() ?? null;
  }

  /** Select the VR projection/layout: half = VR180, fisheye = equidistant
   *  fisheye, stereoSbs = side-by-side stereo (left eye), stereographic =
   *  little-planet. */
  setVRProjection(
    half: boolean,
    fisheye = false,
    stereoSbs = false,
    stereographic = false,
  ): void {
    this.videoRenderer?.setVRProjection(half, fisheye, stereoSbs, stereographic);
  }

  /** Pan the 360° camera by a pointer drag (CSS px) over a viewport of
   *  viewportPx CSS height. */
  nudgeVR360(dx: number, dy: number, viewportPx: number): void {
    this.videoRenderer?.nudgeVR360(dx, dy, viewportPx);
  }

  /** Zoom the 360° camera (delta>0 zooms out, e.g. wheel deltaY). */
  zoomVR360(delta: number): void {
    this.videoRenderer?.zoomVR360(delta);
  }

  /** Recentre the 360° camera. */
  resetVRView(): void {
    this.videoRenderer?.resetVRView();
  }

  /** Paint a still poster image onto the canvas (so a custom `poster` shows in
   *  360° before playback, since a poster URL skips the initial decode). */
  renderPosterImage(image: CanvasImageSource): void {
    this.videoRenderer?.renderPosterImage(image);
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate: number): void {
    if (this.streamWrapper) {
      this.streamWrapper.setPlaybackRate(rate);
    }

    // Idempotent: a re-application of the SAME rate has nothing to do, and
    // doing it anyway is actively harmful. The element sets its `playbackrate`
    // attribute AND calls updatePlaybackRate(), so every user speed change
    // arrives here twice. The first pass re-anchors AudioRenderer (drops the
    // scheduled old-rate sources, pulls scheduledTime to `now`) — which leaves
    // the buffer legitimately empty for a moment. The second pass then read
    // that as "no healthy audio anchor" and took the corrective-seek path:
    // full decoder flush, HEVC decoder recreate, frame-queue clear. That is
    // the second-plus freeze on every speed change.
    if (this.clock.getPlaybackRate() === rate) return;

    // Stamp the change so the stall detector can tell an underrun caused by our
    // own audio re-anchor from a genuine one (see SELF_INFLICTED_STALL_WINDOW_MS).
    this._lastRateChangeAt = performance.now();

    const savedTime = this.getCurrentTime();
    // Only the corrective seek's purpose (undoing the audio read-ahead pivot)
    // applies when playback is actually rolling. At load time the rate is
    // restored from settings while the player sits in "ready"/"paused" — a
    // corrective seek then would (via preservePlaying) latch a resume intent
    // and auto-start playback. Gate it to active playback only.
    const playingNow =
      this.stateManager.getState() === "playing" ||
      this.stateManager.getState() === "buffering";

    // Snapshot the audio anchor BEFORE anything is re-anchored below. This must
    // not move: AudioRenderer.setPlaybackRate() stops the scheduled old-rate
    // sources and pulls scheduledTime back to `now`, and hasHealthyBuffer()
    // reads exactly those two fields (activeSources empty + zero buffer ahead)
    // — so asking afterwards ALWAYS answers "unhealthy", and the corrective
    // seek below fired on every single rate change, which is the freeze this
    // guard exists to prevent. Read it while the pre-change audio state is
    // still intact.
    const audioAnchored = this.hasHealthyAudioAnchor();

    // The one case that stalls, and the branch below already names it: with
    // enough decoded picture in hand the rewind carries the change and the
    // picture never stops, and without it the whole thing falls to fullSeek —
    // decoders flushed, frame queue thrown away, a keyframe waited for. That is
    // the dead stop, the lag, and then 2x running fine, on a device that plays
    // 1080p perfectly well at 1x. It simply has no cushion to spare, and asking
    // for twice the speed halves what the cushion is worth in wall-clock terms
    // AND doubles the queue cap it is measured against.
    //
    // So when the picture cannot carry the rewind YET, don't take the stop —
    // hold the rate and let the loop fill for it (the buffer targets already
    // read _pendingRate). maybeApplyPendingRate applies the moment the cushion
    // is there, and at RATE_PREPARE_MAX_MS regardless, which is exactly what
    // happens today.
    //
    // A machine that already has the picture in hand — which is what "smooth on
    // this Mac" means — never enters this at all: hasPictureToCarryARewind is
    // already true at the press, so the rate applies in the same tick and the
    // path below is untouched.
    //
    // Not only speed-ups. Coming back DOWN takes the same branch and the same
    // stop, because the test is about the cushion the pipeline is holding and a
    // pipeline that was struggling at 2x is holding very little of it. Reported
    // exactly that way: "1x pe wapas aane pe ekdam ruk ja rha hai". A slower
    // rate wants a SMALLER cushion, so this resolves quickly there — but it has
    // to be allowed to resolve at all.
    //
    // None of which applies when the sound can carry the change on its own
    // (see hasHealthyAudioAnchor): there is no rewind to carry then, nothing
    // to fill for, and holding the rate back would be a wait for its own sake.
    if (
      !this._applyingPendingRate &&
      playingNow &&
      !audioAnchored &&
      !this.streamWrapper &&
      !this.audioDemuxer &&
      !this.hasPictureToCarryARewind(rate)
    ) {
      if (this._pendingRate !== rate) {
        this._pendingRate = rate;
        this._pendingRateSince = performance.now();
        Logger.info(
          TAG,
          `Speed ${rate}x: not enough decoded picture to carry the rewind — filling for it first`,
        );
      }
      return;
    }
    this._pendingRate = 0;

    this.clock.setPlaybackRate(rate);

    // Update audio renderer playback rate
    if (this.audioRenderer) {
      this.audioRenderer.setPlaybackRate(rate);
    }

    // Update video renderer playback rate
    if (this.videoRenderer) {
      this.videoRenderer.setPlaybackRate(rate);
    }
    // Tell the decoder the rate: it only screens out crash-inducing tiny
    // show_existing_frame packets at non-1x (at 1x they decode fine and
    // dropping them breaks the reference chain → later keyframe reject).
    if (this.videoDecoder) {
      this.videoDecoder.setPlaybackRate(rate);
    }

    // No decoder flushes on rate change. Flushing the audio decoder drops
    // its read-ahead queue, so the next chunk arrives with whatever mediaTime
    // the demuxer has progressed to (often a second or more ahead) — that
    // audio leap then strands the video decoder behind, causing either
    // pixelation (no video flush) or a multi-second freeze (with flush, on
    // low-end hardware or Open GOP AV1). Letting buffered packets keep
    // flowing means the audible transition is just whatever output buffer
    // the AudioContext has — small with latencyHint="interactive" — and
    // the new rate is applied to subsequent stretcher output naturally.

    // Corrective seek to the saved position so the audio clock can't pivot to
    // the demuxer read-ahead mediaTime (the "jumps ahead on rate change" bug).
    // preservePlaying keeps the play/pause state across it; the seek-session
    // guard keeps rapid rate changes from a superseded completion landing
    // paused. Only when actually playing — see playingNow above.
    // Linear (non-seekable) playback can't do the corrective seek — the
    // keyframe before savedTime is usually behind the sliding window and the
    // read would fail (seek timeout → buffering). Skip it; the worst case is a
    // brief read-ahead pivot on rate change, far better than a stalled seek.
    //
    // Also skip it when a healthy audio clock is already anchoring playback:
    // AudioRenderer.setPlaybackRate() re-anchors in place (stops the stale
    // old-rate sources, pulls scheduledTime to now, keeps firstBufferMediaTime)
    // so the pivot is already prevented WITHOUT a seek. The seek is a
    // re-prime of the whole demux→decode→render pipeline — invisible spinner,
    // but a brief frame hitch. Dropping it here makes the common case (audio
    // playing, buffer healthy) as seek-free as a native <video> rate change.
    // The seek stays as the fallback for video-only / unhealthy-audio playback,
    // where nothing else re-anchors the clock.
    if (
      playingNow &&
      !this.isLinearPlayback() &&
      !audioAnchored
    ) {
      // …but a SPLIT source does not need the video pipeline rewound to fix an
      // audio read-ahead. Audio has its own demuxer there, and the seek that
      // rewinds it also flushes the video decoder, clears the frame queue and
      // waits on a keyframe — which on a 4K60 rendition is the whole cost of
      // the operation. Measured on a YouTube ladder: 2636ms from a speed change
      // to playing again, 2504ms of it with the sound stopped, for a rewind
      // that only ever concerned the sound. Rewind just the audio; the picture
      // never stops.
      // Read the playhead at the moment the seek is issued, not at the top of
      // setPlaybackRate. The clock has been running at the NEW rate since then;
      // seeking to the older value steps playback backwards by that much. Same
      // reasoning as the rewind path — see rewindMuxedAudioTo.
      const fullSeek = () =>
        this.seek(Math.max(savedTime, this.getCurrentTime()), {
          suppressSpinner: true,
          preservePlaying: true,
        }).catch(() => {});
      if (this.audioDemuxer) {
        void this.rewindSplitAudioTo(savedTime);
      } else if (this.hasPictureToCarryARewind(rate)) {
        // Muxed, with enough decoded picture in hand to cover the re-prime:
        // rewind the sound alone and let the frames already made keep playing.
        void this.rewindMuxedAudioTo(savedTime).then((done) => {
          if (!done) fullSeek();
        });
      } else {
        fullSeek();
      }
    } else if (playingNow && audioAnchored) {
      Logger.info(
        TAG,
        `Speed ${rate}x carried on the audio already scheduled — no rewind`,
      );
    }
  }

  /**
   * Put the MUXED audio pipeline back to a media time, and leave the picture
   * running.
   *
   * The problem a rate change creates is entirely an audio one: the renderer
   * drops the audio scheduled at the old rate, those packets are already spent
   * from the demuxer, and the next chunk to arrive comes from the read-ahead
   * position — so the clock pivots onto it and seconds of the film are skipped.
   * A seek back to the playhead fixes that by rewinding the demuxer, but the
   * demuxer is shared: the same seek flushes the video decoder, throws away
   * every decoded frame waiting to be shown, and waits on a keyframe. Measured
   * on a 1080p file at 2x with the CPU throttled to a phone's: 96 frames of
   * cushion discarded, the picture stopped, and about six tenths of a second
   * before playback was itself again — on every press of the speed control.
   *
   * The rewind is what is needed; the flush is not. The frames already decoded
   * are the same frames the seek would decode again, so the video decoder and
   * the renderer queue are left alone and the re-read is dropped on the way in
   * (see _rewindVideoUntilDts). The sound re-primes from the playhead, the
   * picture never stops, and nothing is skipped.
   *
   * Returns false if the pipeline could not be settled safely, so the caller
   * can fall back to the seek.
   */
  private async rewindMuxedAudioTo(time: number): Promise<boolean> {
    const dm = this.demuxer;
    if (!dm) return false;
    // Same order the seek path uses: stop the loop BEFORE waiting on the read
    // in flight, or it starts another one behind the wait.
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    let guard = 0;
    while (this.demuxInFlight && guard++ < 100) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this._destroyed || this.demuxer !== dm) return true; // gone; nothing owed
    // Where playback is NOW, not where it was when the speed was pressed.
    //
    // The caller reads the playhead, applies the new rate to the clock, and
    // only then calls this — and the wait above is asynchronous, so between
    // those two moments the clock runs on at the NEW rate. Rewinding to the
    // stale value therefore drags playback back by exactly the gap times the
    // new rate: it goes to the speed you asked for, then steps backwards, then
    // carries on. Reported that way for both faster and slower, and worst at
    // 2x, where the same gap counts double.
    //
    // The playhead is the whole target of this rewind — the point is to undo
    // the demuxer's read-ahead, not to undo playback — so read it here, after
    // the wait, where it is true. `time` remains the floor: a clock that has
    // somehow gone backwards must not push the rewind forwards.
    const live = this.getCurrentTime();
    const target =
      Math.max(0, Number.isFinite(live) && live > time ? live : time) +
      this.startTime;
    if (this.demuxInFlight) {
      // A read that will not settle is a demuxer nobody may reposition.
      this.animationFrameId = requestAnimationFrame(this.processLoop);
      return false;
    }
    this.audioDecoder.flush();
    this.audioRenderer.reset();
    this._rewindVideoUntilDts = this._lastFedVideoDts;
    this._rewindAudioFrom = target;
    // Provisional: the seek below is the part that takes the time, so the
    // audio floor is re-read at the first packet back — see the gate.
    this._rewindAudioFloorPending = true;
    // The cursor is moving backwards; whatever the loop decided about the end
    // of the file no longer holds.
    this.eofReached = false;
    this._eofPictureDrainSince = 0;
    this.eofSince = 0;
    try {
      await dm.seek(target);
    } catch (e) {
      Logger.warn(
        TAG,
        `Rate-change audio rewind to ${time.toFixed(2)}s failed: ${(e as { message?: string })?.message ?? e}`,
      );
      this._rewindVideoUntilDts = -1;
      this._rewindAudioFrom = -1;
      this._rewindAudioFloorPending = false;
    }
    if (this._destroyed || this.demuxer !== dm) return true;
    if (
      !this.disableAudio &&
      !this.audioRenderer.isAudioPlaying() &&
      (this.stateManager.is("playing") || this.stateManager.is("buffering"))
    ) {
      this.audioRenderer.play();
    }
    // The sound now restarts from `time` while the picture has been running
    // this whole while on an anchor that predates the rewind. Whatever offset
    // that leaves is fixed, and small enough to fall through both the re-sync's
    // 400ms bar and the continuous correction's 150ms threshold — so it never
    // closes on its own. Ask the renderer to re-anchor on the new audio clock.
    this.videoRenderer?.requestAudioReanchor?.();
    this.animationFrameId = requestAnimationFrame(this.processLoop);
    return true;
  }

  /**
   * Put the split audio pipeline back to a media time, and touch nothing else.
   *
   * The video demuxer, decoder, frame queue and the clock are all left running
   * — this is the audio-side twin of resyncVideoToAudio, for the one thing a
   * rate change actually disturbs: AudioRenderer's re-anchor drops the audio
   * scheduled at the old rate, and those packets are already spent from the
   * demuxer, so without a rewind the next chunk arrives from the read-ahead
   * position and the clock pivots onto it (seconds of the film skipped).
   */
  private async rewindSplitAudioTo(time: number): Promise<void> {
    const dm = this.audioDemuxer;
    if (!dm) return;
    const t = Math.max(0, time);
    this.stopAudioLoop();
    let guard = 0;
    while (this.audioDemuxInFlight && guard++ < 200) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // The wait can outlive the pipeline it was waiting for.
    if (this._destroyed || this.audioDemuxer !== dm) return;
    this.audioDecoder.flush();
    this.audioRenderer.reset();
    try {
      // Drop whatever lands before the target: the renderer was just reset, so
      // anything earlier would be a fraction of a second played twice. In the
      // video PTS scale, which is what the split pump compares against.
      this._splitAudioSkipBefore = t + this.startTime;
      this._splitAudioFloorPending = true;
      // …and seek in the audio source's own baseline, which may differ.
      await dm.seek(t + this._splitAudioStartTime);
    } catch (e) {
      Logger.warn(
        TAG,
        `Rate-change audio rewind to ${t.toFixed(2)}s failed: ${(e as { message?: string })?.message ?? e}`,
      );
      this._splitAudioSkipBefore = -1;
      this._splitAudioFloorPending = false;
    }
    this._splitAudioEof = false;
    this._lastSplitAudioPts = t;
    if (this._destroyed || this.audioDemuxer !== dm) return;
    if (this.stateManager.is("playing") || this.stateManager.is("buffering")) {
      if (!this.disableAudio && !this.audioRenderer.isAudioPlaying()) {
        this.audioRenderer.play();
      }
      this.startAudioLoop();
    }
  }

  /**
   * Is there enough decoded picture in hand to play through an audio rewind?
   *
   * The rewind costs the demuxer a re-read of everything between the keyframe
   * it lands on and the playhead, and the picture during that is whatever the
   * renderer already holds — measured at the NEW rate, which is the whole
   * point: a queue that is two seconds at 1x is one at 2x. Short of that, the
   * old full seek is the safer answer, because a rewind that outlasts the
   * queue stops the picture anyway and without a spinner to explain it.
   */
  /**
   * How many decoded frames the renderer queue is ALLOWED to hold.
   *
   * Extracted so the number lives in one place. It is a VRAM bound counted in
   * FRAMES, and two callers need it for different reasons: the demux loop uses
   * it as backpressure, and the rate-change rewind needs to know whether a
   * shallow queue means "not buffered yet" or "as full as it will ever get" —
   * those look identical from the queue size alone and lead to opposite
   * decisions. See hasPictureToCarryARewind().
   */
  private videoQueueCapFrames(
    isPostSeek: boolean,
    isSoftware: boolean,
    rateScale: number,
  ): number {
    const activeVideo = this.trackManager.getActiveVideoTrack();
    const pixels = (activeVideo?.width ?? 0) * (activeVideo?.height ?? 0);
    const fps = Math.max(15, Math.min(120, activeVideo?.frameRate ?? 30));
    const is8KPlus = pixels >= 7680 * 4320;
    const isHighRes = pixels >= 3840 * 2160; // 4K and above
    const isMobile = MoviPlayer._isMobileDevice;
    let baseHwQueue: number;
    if (is8KPlus) {
      // 8K+ desktop: 16 frames is a VRAM-bound sweet spot (8K HDR frames are
      // ~50MB each; deeper queues stall the compositor and 100 × 50MB ≈ 5GB
      // VRAM was the original starvation cause). Mobile shifts to software
      // dav1d so a shallow queue helps the decoder catch up.
      if (isMobile) baseHwQueue = isPostSeek ? 8 : 12;
      else baseHwQueue = isPostSeek ? 12 : 16;
    } else if (isHighRes) {
      // 4K (not 8K) desktop: 4K HDR RGBA8 frames are ~33MB so 48 × 33MB ≈
      // 1.6GB VRAM — bounded but deep enough to absorb 250-500ms GC/decode
      // hiccups without draining the renderer queue. The previous uniform
      // 16-frame cap (267ms @60fps) was too shallow for 4K60 HEVC HDR: any
      // jitter emptied the queue, paused demuxing, and starved audio.
      if (isMobile) baseHwQueue = isPostSeek ? 8 : 16;
      else baseHwQueue = isPostSeek ? 24 : 48;
    } else if (isMobile) {
      // 1080p (and lighter) on mobile is smooth at the 800ms target — keep it.
      const targetMs = isPostSeek ? 400 : 800;
      baseHwQueue = Math.max(12, Math.round((fps * targetMs) / 1000));
    } else {
      baseHwQueue = isPostSeek ? 20 : 100; // desktop default
    }
    return Math.round((isSoftware ? 60 : baseHwQueue) * rateScale);
  }

  private hasPictureToCarryARewind(rate: number): boolean {
    const queued = this.videoRenderer?.getQueueSize?.() ?? 0;
    if (queued <= 0) return false;
    const fps = this.trackManager?.getActiveVideoTrack()?.frameRate || 24;
    const seconds = queued / Math.max(1, fps) / Math.max(1, rate);
    if (seconds >= MoviPlayer.REWIND_PICTURE_CUSHION_S) return true;

    // 0.8s of decoded picture is a wall a high-res source can never climb. The
    // cushion is in SECONDS but the queue cap is in FRAMES — a VRAM bound of 16
    // at 8K and 48 at 4K — so at 60fps the deepest queue 8K is ALLOWED to hold
    // is 0.27s. The bar could not be met at any rate above ~0.34x, which made
    // the expensive full seek GUARANTEED on exactly the sources where it costs
    // the most, while 1080p30 (100 frames = 3.3s) always got the cheap path.
    // Measured on 8K60 AV1: six of nine rebuffers in one session were
    // rate-change seeks, each flushing both decoders, clearing the queue and
    // refilling 16 frames of 8K from an IDR — the freeze on every press of the
    // speed control. The 0.25x change in that same session took the cheap path,
    // and only because rateScale multiplies the cap by 4 at that rate.
    //
    // A queue at its cap is not "not buffered yet", it is "as full as it will
    // ever get", and those are opposite situations that look identical from the
    // queue size alone. Waiting for 0.8s there is waiting for something that
    // cannot arrive, so rewind the sound and let the picture keep running: a
    // small hitch is strictly better than stopping it outright.
    const rateScale = rate < 1.0 ? 1.0 / rate : Math.min(2.0, rate);
    const cap = this.videoQueueCapFrames(
      false,
      this.videoDecoder?.isSoftware ?? false,
      rateScale,
    );
    return cap > 0 && queued >= cap * MoviPlayer.REWIND_QUEUE_AT_CAP_FRACTION;
  }

  /**
   * True when a healthy audio clock is currently anchoring playback, so the
   * corrective seek in setPlaybackRate() is redundant (the audio pipeline
   * re-anchors the rate change in place). Used to keep rate changes seek-free
   * — and therefore native-video-smooth — in the common case.
   */
  /**
   * Hand a deferred speed-up back to setPlaybackRate once the pipeline can take
   * it — see _pendingRate. Called every tick; a no-op when nothing is pending,
   * which is every tick on a machine that never needed to defer.
   */
  private maybeApplyPendingRate(): void {
    const target = this._pendingRate;
    if (!target) return;
    // Not rolling any more: apply it outright. The branch that made deferring
    // worthwhile is gated on active playback, so there is nothing left to
    // protect — and dropping the request instead would leave the control
    // showing a speed the engine is not running at.
    const rolling = this.stateManager.is("playing");
    const waited = performance.now() - this._pendingRateSince;
    const ready = this.hasPictureToCarryARewind(target);
    if (!rolling || ready || waited > MoviPlayer.RATE_PREPARE_MAX_MS) {
      Logger.info(
        TAG,
        `Applying ${target}x after ${waited.toFixed(0)}ms — ` +
          (ready
            ? "picture can carry the rewind"
            : rolling
              ? "prepare window elapsed"
              : "no longer rolling"),
      );
      this._pendingRate = 0;
      this._applyingPendingRate = true;
      try {
        this.setPlaybackRate(target);
      } finally {
        this._applyingPendingRate = false;
      }
    }
  }

  private hasHealthyAudioAnchor(): boolean {
    // This returned a flat `false` — no machine ever skipped the corrective
    // seek — and the reason it did was real at the time: AudioRenderer's
    // re-anchor DROPPED the scheduled audio, which left the demuxer parked at
    // its read-ahead position, and the next chunk to arrive read as an
    // underrun and pivoted the whole clock onto that read-ahead media time
    // ("Pivot global clock if we underrun"). 1.5-3.6s of the film skipped on
    // every speed change. The seek was what rewound the demuxer back.
    //
    // That premise is gone. AudioRenderer.setPlaybackRate now TAKES BACK the
    // audio scheduled ahead — the unstarted sources are stopped and their
    // original pre-stretch buffers pushed to the front of the pending queue,
    // re-stretched at the new tempo, rescheduled behind the chunk still
    // playing — and it deliberately keeps hasFirstBuffer/firstBufferMediaTime
    // so the clock cannot leap to the read-ahead. No media is dropped, so
    // there is no hole for an underrun to pivot on, and the span the seek went
    // back to fetch is the span the renderer is still holding.
    //
    // What the seek costs, meanwhile, is the whole stop: the demux loop
    // cancelled, the read in flight waited out, the audio decoder flushed, the
    // renderer reset (which throws away exactly the audio just reclaimed) and
    // a backwards demuxer seek — with the picture living off its queue for all
    // of it. That is "2x hone se pehle thodi der ko ruk jaata hai", and on the
    // prepare path it is at its worst, because that path exists precisely for
    // pipelines with nothing to spare.
    //
    // So ask the renderer whether the reclaim is actually available, rather
    // than assuming either way. Thin or cold audio still takes the seek.
    return this.audioRenderer?.canCarryRateChange?.() ?? false;
  }


  /**
   * Pause/resume the video source's background prefetch for audio-only mode.
   * Only used for split sources, where this.source is video-only and the audio
   * streams independently.
   */
  private setVideoSourcePrefetchPaused(paused: boolean): void {
    const src = this.source as unknown as {
      setPrefetchThrottle?: (v: boolean) => void;
    } | null;
    src?.setPrefetchThrottle?.(paused);
  }

  /**
   * Stand up a WASM-decoded split (separate-URL) audio track: a SECOND Demuxer
   * (isolated WASM module) over the audio URL, feeding the shared audioDecoder →
   * audioRenderer. Mirrors the muxed configure path; the AudioRenderer is already
   * clock-master so sync/volume/rate need no extra wiring. Best-effort — on
   * failure it clears the demuxer so playback continues video-only.
   */
  /**
   * Turn HLS segmented-WebVTT subtitle renditions into external subtitle
   * tracks: fetch every segment, concatenate into one presentation-timed VTT
   * (via buildVttFromSegments), and hand back blob-URL tracks. Renditions with
   * no cues are skipped.
   */
  private async buildHlsSubtitleTracks(
    renditions: HlsSubtitleRendition[],
    headers?: Record<string, string>,
  ): Promise<SubtitleSourceEntry[]> {
    const out: SubtitleSourceEntry[] = [];
    for (const r of renditions) {
      // A rendition is one request PER SEGMENT — dozens of them, fired at once
      // and none of them cancellable, which made this the largest single source
      // of traffic outliving a torn-down player. The signal goes on every one,
      // and the loop stops between renditions too so a long list doesn't start
      // a fresh batch after teardown.
      if (this._lifetimeAbort.signal.aborted) break;
      try {
        const texts = await Promise.all(
          r.segments.map((s) =>
            fetch(s.url, {
              ...(headers ? { headers } : {}),
              signal: this.lifetimeSignal,
            })
              .then((res) => (res.ok ? res.text() : ""))
              .catch(() => ""),
          ),
        );
        const vtt = buildVttFromSegments(texts);
        if (!vtt.includes("-->")) continue; // no cues parsed
        const url = URL.createObjectURL(
          new Blob([vtt], { type: "text/vtt" }),
        );
        out.push({ url, lang: r.lang, label: r.label, format: "vtt" });
      } catch (e) {
        Logger.warn(TAG, `HLS subtitle build failed for ${r.lang}`, e);
      }
    }
    return out;
  }

  private async setupSplitAudio(
    source: string | SourceAdapter,
  ): Promise<void> {
    try {
      if (typeof source === "string") {
        Logger.info(TAG, `Split audio (WASM) setup: ${source}`);
        this.audioSource = await this.createSource({
          type: "url",
          url: source,
          headers: this.config.headers,
        });
        // A smaller opening request for audio. 4MB of AAC is four minutes
        // nobody needs yet, and it is fetched during startup where the wait is
        // the viewer's — measured at 2.8s on an ordinary link. The streaming
        // loop after the first range is unchanged, so nothing under-buffers.
        (
          this.audioSource as unknown as {
            setFirstRangeBytes?: (n: number) => void;
          }
        )?.setFirstRangeBytes?.(1_000_000);
      } else {
        // Pre-built adapter (e.g. an HLS audio rendition's segment stream).
        Logger.info(TAG, `Split audio (WASM) setup: ${source.getKey()}`);
        this.audioSource = source;
      }
      // Isolated WASM instance (3rd arg): a second demuxer MUST NOT share the
      // main module's global read callback — same isolation the thumbnail/cover
      // pipelines use.
      this.audioDemuxer = new Demuxer(
        this.audioSource,
        this.config.wasmBinary,
        true,
      );
      const audioInfo = await this.audioDemuxer.open();
      const aTrack = this.audioDemuxer.getAudioTracks()[0];
      if (!aTrack) {
        Logger.warn(TAG, "Split audio: no audio track in separate source");
        this.audioDemuxer = null;
        this.audioSource = null;
        return;
      }
      this._splitAudioTrackId = aTrack.id;
      // Everything above ran alongside the video demuxer. THIS is the one line
      // that needs it — the video's PTS baseline — so wait for it here rather
      // than making the whole audio open wait.
      if (this._videoInfoReady) await this._videoInfoReady;
      if (this._destroyed) return;
      // Align this source's PTS baseline with the video's. Use mediaInfo.startTime
      // (already resolved) rather than this.startTime, which isn't set yet on the
      // initial-load call path.
      this._splitAudioStartTime = audioInfo?.startTime || 0;
      this._splitAudioPtsDelta =
        (this.mediaInfo?.startTime || 0) - this._splitAudioStartTime;
      if (this._splitAudioPtsDelta !== 0) {
        Logger.info(
          TAG,
          `Split audio PTS baseline ${this._splitAudioStartTime.toFixed(3)}s vs video ${(this.mediaInfo?.startTime || 0).toFixed(3)}s — shifting audio by ${this._splitAudioPtsDelta.toFixed(3)}s`,
        );
      }
      const extradata = this.audioDemuxer.getExtradata(aTrack.id) ?? undefined;
      const bindings = this.audioDemuxer.getBindings();
      if (bindings) this.audioDecoder.setBindings(bindings);
      const configured = await this.audioDecoder.configure(aTrack, extradata);
      if (!configured) {
        Logger.warn(TAG, "Split audio: decoder configure failed");
        this.audioDemuxer = null;
        this.audioSource = null;
        return;
      }
      // Same as the muxed path above: the rate has to reach the renderer
      // before the context exists. This is the path a split (separate-URL)
      // audio stream takes, which is what every YouTube-style source uses.
      this.audioRenderer.configure(aTrack.sampleRate, aTrack.channels);
      await this.audioRenderer.init();
      const sourceCh = aTrack.channels ?? 2;
      const maxCh = this.audioRenderer.getMaxChannelCount();
      if (sourceCh > 2 && maxCh >= sourceCh) {
        this.audioDecoder.setDownmix(false);
        this.audioRenderer.setOutputChannelCount(sourceCh);
      } else {
        this.audioDecoder.setDownmix(true);
        this.audioRenderer.setOutputChannelCount(2);
      }
      this._splitAudioEof = false;
      // A source of its own, so a clean slate for its failures too.
      this._splitAudioDead = false;
      this._splitAudioErrorSince = 0;
      this._lastSplitAudioPts = 0;
      // Sync the freshly-opened audio demuxer to where the player ACTUALLY is.
      // This setup is async: a recovery recreate's resume-seek (or any seek that
      // lands while it's still in flight) moves the video but can't seek an
      // audio demuxer that doesn't exist yet. Without this the audio starts at 0
      // and runs tens of seconds behind — which the desync detector then
      // "fixes" by dragging the VIDEO backwards to meet it.
      const playhead = this.getCurrentTime();
      if (playhead > 0.5) {
        try {
          await this.audioDemuxer.seek(playhead + this._splitAudioStartTime);
          Logger.info(
            TAG,
            `Split audio synced to playhead ${playhead.toFixed(1)}s after setup`,
          );
        } catch {
          /* best-effort — the next seek/resync corrects it */
        }
      }
      Logger.info(
        TAG,
        `Split audio (WASM) ready: ${aTrack.codec} ${aTrack.sampleRate}Hz ${aTrack.channels}ch`,
      );
    } catch (e) {
      Logger.error(TAG, `Split audio setup failed: ${(e as any)?.message ?? e}`);
      try { this.audioDemuxer?.close(); } catch {}
      try { this.audioSource?.close(); } catch {}
      this.audioDemuxer = null;
      this.audioSource = null;
      // A stall/timeout opening the audio demuxer is usually transient — the
      // video's opening burst monopolised the link and the audio's first-bytes
      // read starved out ("Timeout at 0"). Once the video buffer fills and the
      // link frees up, a retry gets through. Bounded so a genuinely dead audio
      // URL doesn't loop. Without this the video played on permanently silent.
      const transient =
        typeof source === "string" &&
        /timeout|stall|network|failed to fetch|incomplete/i.test(
          String((e as any)?.message ?? ""),
        );
      if (transient && this._splitAudioRetries < MoviPlayer.MAX_SPLIT_AUDIO_RETRIES) {
        this._splitAudioRetries++;
        const delay = 1500 * this._splitAudioRetries;
        Logger.warn(
          TAG,
          `Split audio open stalled — retry ${this._splitAudioRetries}/${MoviPlayer.MAX_SPLIT_AUDIO_RETRIES} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        if (this._destroyed) return;
        await this.setupSplitAudio(source);
      }
    }
  }

  /**
   * Audio demux pump for split audio — sibling to processLoop but reads only the
   * separate audio demuxer and feeds the shared audioDecoder. Own in-flight guard
   * (separate WASM module, so independent of the video demuxInFlight critical
   * section). Bounded lead so it doesn't fetch the whole audio file ahead.
   */
  // One decode pass of the split-audio demuxer. Returns false when the loop
  // should stop (no demuxer / EOF / not playing), true to keep going. Does NOT
  // schedule the next tick — the caller owns cadence: the rAF wrapper in the
  // foreground, the un-throttled background Worker timer when hidden (rAF is
  // throttled in background, which is exactly what stalled audio there).
  private async pumpSplitAudio(): Promise<boolean> {
    if (!this.audioDemuxer || this._splitAudioEof || this._splitAudioDead) {
      return false;
    }
    const state = this.stateManager.getState();
    if (
      state !== "playing" &&
      state !== "buffering" &&
      !this.waitingForVideoSync
    ) {
      return false;
    }
    if (this.audioDemuxInFlight) return true;

    // Hold audio while the video is still hunting its first keyframe after a
    // seek/first-play. The AudioRenderer plays buffers the instant they're
    // decoded (even before the clock starts), so decoding here would let audio
    // run ahead during the ~2s sync window — the clock then snaps to an audio
    // position seconds past the video, which never catches up (perpetual
    // "buffers empty" stall loop). The muxed path holds audio the same way via
    // pendingAudioPackets. Idle until video sync completes.
    //
    // Never in audio-only: there's no video being shown to sync to, so holding
    // audio for a video keyframe just starves it — worst on a seek into a
    // not-yet-buffered region, where the video can't produce that frame for
    // seconds and the audio (often fully cached) goes silent for no reason.
    if (
      !this._audioOnly &&
      this.waitingForVideoSync &&
      this.trackManager.getActiveVideoTrack()
    ) {
      return true;
    }

    // Read a SMALL burst of packets per tick — enough to stay ahead of AAC's
    // ~43 frames/sec (one-per-rAF underran when rAF stuttered under video load),
    // but NOT so many that the sequential WASM readFrame calls monopolise the
    // main thread and starve the video decode/present loop (a big burst stalled
    // heavy 1440p60 AV1). ~24/tick × 60fps ≈ 1440 pkt/s capacity vs 43 needed,
    // filling the lead over a few ticks instead of one blocking gulp. Hold a
    // few seconds of lead (scaled with rate); the audio bitrate is tiny so the
    // time-cushion costs almost no bytes.
    // While a speed-up is being prepared, fill for the rate we are ABOUT to run
    // at, not the one still on the clock — that preparation is the whole point.
    const rate = Math.max(
      0.25,
      Math.max(this.clock.getPlaybackRate(), this._pendingRate),
    );
    const bufferedTarget = 5 * (rate < 1 ? 1 / rate : Math.min(2, rate));

    // Bound the audio decode lead against the CLOCK, not the AudioRenderer
    // buffer. While the AudioContext is suspended (Safari muted-autoplay) the
    // buffer-duration reading is unreliable, so a buffer-only gate let audio
    // race far ahead of the wall-clock-rolling video and land wildly out of sync
    // on unmute. Gating on how far the last decoded PTS is past the playhead
    // keeps audio close to the video in every state. Crucially, while audio is
    // being DROPPED (muted with a suspended context — autoplay blocked, before
    // any gesture) keep the lead tiny: that renderer advances its media clock to
    // the lead edge, so a big lead becomes exactly that much A/V drift the
    // instant the user unmutes. A small lead makes unmute land on the playhead.
    // A muted-but-RUNNING context schedules audio like any other, so it gets the
    // full smooth-buffer lead — starving it there was making muted playback
    // stall in a loop while the same file played smoothly with sound.
    const lead = this.audioRenderer.isDroppingAudio() ? 0.25 : bufferedTarget;
    const mediaNow = Math.max(0, this.clock.getTime() - this.startTime);
    if (this._lastSplitAudioPts - mediaNow > lead) return true;

    this.audioDemuxInFlight = true;
    try {
      let reads = 0;
      while (
        reads < 24 &&
        !this._splitAudioEof &&
        this.audioDecoder.queueSize <= 40 &&
        this.audioRenderer.getBufferedDuration() < bufferedTarget &&
        this._lastSplitAudioPts - mediaNow <= lead
      ) {
        const pkt = await this.audioDemuxer.readPacket();
        reads++;
        if (!pkt) {
          // No bytes is either the end of the track or a source that has
          // stopped answering — they reach C as the same thing. Ask, the way
          // the muxed loop asks (see getSourceFailure), or an expired audio
          // URL passes for a finished one and the film plays on in silence.
          const failure = this.getSplitAudioFailure();
          if (failure) throw failure;
          this._splitAudioEof = true;
          break;
        }
        // A packet arrived, so whatever went wrong before was a moment, not
        // the end of the road.
        this._splitAudioErrorSince = 0;
        if (
          this._splitAudioTrackId !== -1 &&
          pkt.streamIndex !== this._splitAudioTrackId
        ) {
          continue;
        }
        // Shift a separately-timed audio rendition onto the video's PTS timeline
        // (delta is 0 when they share a baseline), so decode timestamps, the
        // seek-target filter (video-PTS scale) and the clock all agree.
        const pts = pkt.timestamp + this._splitAudioPtsDelta;
        // Skip packets before an in-flight seek target (mirror the video path).
        if (this.seekTargetTime !== -1 && pts < this.seekTargetTime) {
          continue;
        }
        // …and keep skipping past completion, up to where the seek actually
        // resumed (see _splitAudioSkipBefore). Cleared by the first packet that
        // reaches it, so it costs one comparison per packet afterwards.
        if (this._splitAudioSkipBefore >= 0) {
          // A rate-change rewind armed this before its demuxer seek, and the
          // picture ran on at the new rate all through that wait — resuming
          // the sound at the armed mark hands back audio from behind the
          // playhead, which the cleared syncedToAudio then hard-syncs the
          // whole clock onto. Resolve it where the playhead is now (plus the
          // silent lead before this sound can be heard). See the muxed twin.
          if (this._splitAudioFloorPending) {
            this._splitAudioFloorPending = false;
            const live = this.getCurrentTime() + this.startTime;
            const lead = Math.min(
              0.25,
              this.audioRenderer?.expectedStartLead?.() ?? 0,
            );
            const floor = live + lead * this.clock.getPlaybackRate();
            if (Number.isFinite(floor) && floor > this._splitAudioSkipBefore) {
              this._splitAudioSkipBefore = floor;
            }
          }
          if (pts < this._splitAudioSkipBefore) continue;
          this._splitAudioSkipBefore = -1;
        }
        this.audioDecoder.decode(pkt.data, pts, pkt.keyframe);
        // Track the last PTS 0-based (content time) to match the pump's lead
        // gate, which compares against `mediaNow` (clock − startTime).
        this._lastSplitAudioPts = pts - this.startTime;
      }
    } catch (e) {
      const message = (e as any)?.message ?? String(e);
      // A bad packet is worth stepping over: the next read usually works, and
      // this loop's whole job is to keep the sound coming. A source that has
      // stopped answering is not that. It fails every read the same way, and
      // this pump runs on the animation frame — so the same warning went out
      // sixty times a second, for ever, while the viewer watched a picture
      // with no sound and no reason given. (Measured on a signed URL that
      // began answering 403 mid-playback: 777 identical lines and counting.)
      //
      // So: ask the source whether this is a fact about the URL, and failing
      // that, give the track a few seconds to produce ONE packet. Neither
      // answer is recoverable here — the link has to be re-issued, which is
      // the embedding page's business, and it can only do that if it is told.
      const failure = this.getSplitAudioFailure();
      const stuckFor = this._splitAudioErrorSince
        ? performance.now() - this._splitAudioErrorSince
        : 0;
      if (!this._splitAudioErrorSince) {
        this._splitAudioErrorSince = performance.now();
        Logger.warn(TAG, `Split audio demux error: ${message}`);
      }
      if (failure || stuckFor >= MoviPlayer.SPLIT_AUDIO_GIVE_UP_MS) {
        this._splitAudioDead = true;
        this.failFatally(
          failure ??
            new Error(
              `Audio track stopped reading after ${(stuckFor / 1000).toFixed(1)}s: ${message}`,
            ),
        );
      }
    } finally {
      this.audioDemuxInFlight = false;
    }

    return !this._splitAudioEof && !this._splitAudioDead;
  }

  /** True once the split-audio demuxer has hit EOF and the renderer has played
   *  out its buffered tail — i.e. the track is actually finished. Mirrors the
   *  main processLoop's audioPlayedOut check. */
  private isSplitAudioPlayedOut(): boolean {
    const currentTime = this.clock.getTime();
    const duration = this.mediaInfo?.duration ?? 0;
    const maxScheduled = this.audioRenderer.getMaxScheduledMediaTime();
    const reachedEnd =
      duration > 0 && currentTime >= duration + this.startTime - 0.25;
    const playedOut =
      maxScheduled > 0 && currentTime >= maxScheduled - 0.1;
    return playedOut || reachedEnd || duration === 0;
  }

  /** When the main processLoop (which normally emits "ended") is parked, the
   *  split-audio path must detect end-of-track itself — else a finished track
   *  never fires "ended" and the host can't auto-advance. Emits once the
   *  demuxer hit EOF (not a pause/stop) and the tail has drained. Returns true
   *  when it ended. Safe from both the rAF loop and the background timer.
   *
   *  Two ways the main loop is parked, and only the first was covered:
   *
   *    audio-only — there is no video pipeline to run.
   *
   *    BACKGROUNDED — rAF is throttled to nothing and video decode is skipped
   *    on purpose, so the background timer runs the audio pump and nothing
   *    else. A video watched with the tab hidden therefore played its audio
   *    to the very end and then simply stopped: no EOF, no "ended", no
   *    auto-advance, and the queue sat there until the viewer came back and
   *    the main loop resumed. Read off a real session's log — audio draining
   *    3901ms → 650ms while hidden, then "EOF reached / Playback ended" only
   *    after "Foreground recovery". PiP is excluded because the video IS being
   *    shown there, so the main loop is running and owns the transition. */
  private maybeEndSplitAudio(): boolean {
    const mainLoopParked =
      this._audioOnly || (this.isBackgrounded && !this.isPiPActive);
    if (
      mainLoopParked &&
      this._splitAudioEof &&
      (this.stateManager.is("playing") || this.stateManager.is("buffering")) &&
      this.isSplitAudioPlayedOut()
    ) {
      this.handleEnded();
      return true;
    }
    return false;
  }

  private audioProcessLoop = async () => {
    const keepGoing = await this.pumpSplitAudio();
    if (keepGoing) {
      this.audioAnimationFrameId = requestAnimationFrame(this.audioProcessLoop);
      return;
    }
    // The pump stopped. If it's because the demuxer hit EOF (audio-only), keep
    // ticking until the buffered tail drains, then end — otherwise it stopped
    // for a pause/state change and we just idle.
    if (
      (this._audioOnly || (this.isBackgrounded && !this.isPiPActive)) &&
      this._splitAudioEof &&
      (this.stateManager.is("playing") || this.stateManager.is("buffering"))
    ) {
      this.audioAnimationFrameId = this.maybeEndSplitAudio()
        ? null
        : requestAnimationFrame(this.audioProcessLoop);
      return;
    }
    this.audioAnimationFrameId = null;
  };

  private startAudioLoop(): void {
    if (!this.audioDemuxer || this.audioAnimationFrameId !== null) return;
    this.audioAnimationFrameId = requestAnimationFrame(this.audioProcessLoop);
  }

  private stopAudioLoop(): void {
    if (this.audioAnimationFrameId !== null) {
      cancelAnimationFrame(this.audioAnimationFrameId);
      this.audioAnimationFrameId = null;
    }
  }

  /**
   * The audio decoder gave up — every packet is being rejected and playback has
   * gone silent. That's usually a stream the decoder is out of STEP with rather
   * than one it can't decode (an in-place rendition swap, a demuxer replaced
   * under the pump, a decoder reset that left the packet stream mid-frame): the
   * proof is that a manual seek brings the audio straight back, because seeking
   * re-aligns the source and flushes the breaker.
   *
   * So do that automatically, without touching the video: stop the pump, flush,
   * re-seek the audio source to the playhead, resume. Bounded — if it doesn't
   * take after a few tries the source really is undecodable and the player stays
   * silent rather than seeking in a loop.
   */
  private async recoverBrokenAudio(): Promise<void> {
    if (this._destroyed || this._audioRecoveryInFlight) return;
    // On an encrypted source there is nothing to re-align to: the audio track
    // gets no clear lead of its own (the packager's lead covers the video), so
    // the first packet fails and so will every one after it.
    //
    // Go SILENT rather than stopping. The video's clear lead is real playback
    // and worth showing; ending it here would throw away the whole point of
    // getting this far. What must not continue is the waiting — audio empty,
    // video bound to it, the stall detector nudging a seek, forever. Cutting
    // audio out of the picture entirely is what unblocks the video, and the
    // stop then comes from the video decoder when ITS clear lead runs out.
    if (this._sourceIsEncrypted) {
      if (this._encryptedAudioSilenced) return;
      this._encryptedAudioSilenced = true;
      Logger.warn(
        TAG,
        "Encrypted source: audio needs a licence — going silent so the clear video lead can still play",
      );
      this.disableAudio = true;
      try {
        this.audioRenderer.pause();
      } catch {
        /* nothing scheduled */
      }
      return;
    }
    if (this._audioRecoveries >= MoviPlayer.MAX_AUDIO_RECOVERIES) {
      Logger.warn(
        TAG,
        `Audio decode kept failing after ${this._audioRecoveries} re-alignments — leaving audio off`,
      );
      return;
    }
    this._audioRecoveryInFlight = true;
    this._audioRecoveries++;
    const playhead = this.getCurrentTime();
    Logger.info(
      TAG,
      `Audio decoder broken — re-aligning the audio source at ${playhead.toFixed(2)}s (attempt ${this._audioRecoveries})`,
    );
    try {
      if (this.audioDemuxer) {
        this.stopAudioLoop();
        let guard = 0;
        while (this.audioDemuxInFlight && guard++ < 200) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // flush() clears the breaker as well as the codec's own state.
        await this.audioDecoder.flush();
        try {
          await this.audioDemuxer.seek(playhead + this._splitAudioStartTime);
        } catch (e) {
          Logger.warn(
            TAG,
            `Audio re-align seek failed: ${(e as any)?.message ?? e}`,
          );
        }
        this._splitAudioEof = false;
        this._lastSplitAudioPts = playhead;
        this.audioRenderer.reset();
        this.startAudioLoop();
      } else {
        // Muxed audio: the packets keep coming from the main demuxer, so a
        // flush alone re-arms the decoder at the next keyframe.
        await this.audioDecoder.flush();
        this.audioRenderer.reset();
      }
    } finally {
      this._audioRecoveryInFlight = false;
    }
  }



  /**
   * Hand a still-playing <audio> element to a successor player across a
   * rebuild. This pipeline decodes audio itself and owns no element, so there
   * is never one to pass — the method stays because callers reach it
   * duck-typed on whichever engine is live (NativeVideoWrapper does own one).
   */
  releaseNativeAudio(): HTMLAudioElement | null {
    return null;
  }

  /**
   * Take ownership of an <audio> element carried over from a previous engine
   * (the native fallback owns one). This pipeline has no use for it, so
   * "adopting" it means shutting it down — see below.
   */
  adoptNativeAudio(el: HTMLAudioElement): void {
    // The WASM pipeline no longer plays audio through a media element, so an
    // element handed over from a previous player has no owner here. Adopting it
    // would resurrect the second, independently-clocked audio path this class
    // deliberately dropped; ignoring it would leave it playing the OLD source
    // forever, since the hand-off drops the last reference to it. Stop it.
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* noop */
    }
    const stashed = (el as any).__moviObjectUrl;
    if (stashed) {
      try {
        URL.revokeObjectURL(stashed);
      } catch {
        /* noop */
      }
    }
    delete (el as any).__moviObjectUrl;
    delete (el as any).__moviLogicalUrl;
  }

  /**
   * Get available audio language tracks (multi-language mode)
   */
  getAudioLangs(): { lang: string; label: string; active: boolean }[] {
    return this._audioTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this._activeAudioLang,
    }));
  }

  /**
   * Switch audio to another language/track through the SAME WASM split-audio
   * pipeline as the initial audio — NOT a native <audio> element. Native
   * <audio> stalls on the fragmented-MP4 audio files DASH ships (served as
   * video/mp4, readyState never settles), so instead we tear down the current
   * audio demuxer and stand up a fresh one for the new URL, re-seek it to the
   * current position, and resume. Position & play state are preserved.
   */
  async selectAudioLang(lang: string): Promise<boolean> {
    const track = this._audioTracks.find((t) => t.lang === lang);
    if (!track) {
      Logger.warn(TAG, `Audio track not found for lang: ${lang}`);
      return false;
    }
    if (lang === this._activeAudioLang && this.audioDemuxer) return true;

    const t = this.getCurrentTime();

    // --- PREP (old audio keeps playing): build + open + seek the new audio
    // demuxer on an isolated WASM module. The slow work (open = source measure,
    // plus the seek) happens here while the current language still plays, so the
    // silent window shrinks to a buffer flush. Switching LANGUAGE means the old
    // and new content differ, so the buffered old audio must be dropped — a
    // small gap is unavoidable (unlike a same-content bitrate switch). Bails
    // (staying on the current language) if the new one can't be prepared. ---
    let newSource: SourceAdapter | null = null;
    let newDemuxer: Demuxer | null = null;
    let aTrack: AudioTrack | undefined;
    let newAudioStart = 0;
    try {
      newSource =
        track.adapter ??
        (await this.createSource({
          type: "url",
          url: track.url,
          headers: this.config.headers,
        }));
      newDemuxer = new Demuxer(newSource, this.config.wasmBinary, true);
      const info = await newDemuxer.open();
      newAudioStart = info.startTime || 0;
      aTrack = newDemuxer.getAudioTracks()[0];
      if (!aTrack) throw new Error("no audio track in the selected language");
      await newDemuxer.seek(t + newAudioStart);
    } catch (e) {
      Logger.warn(
        TAG,
        `Audio switch prep failed for ${track.label}: ${(e as any)?.message ?? e}`,
      );
      try { newDemuxer?.close(); } catch {}
      if (newSource && newSource !== track.adapter) {
        try { newSource.close(); } catch {}
      }
      // A failed prep leaves the CURRENT language playing, whatever the source
      // shape. This used to hand single-file audio to a native <audio> element
      // instead — which meant the WASM pipeline suddenly ran its audio on a
      // second, independently-clocked media element: its own drift against the
      // canvas clock, its own volume path (no AudioContext, so no stable-volume
      // or >100% boost), and an element that outlived teardown often enough to
      // leave the previous video's audio playing under the next one. Inside the
      // WASM pipeline audio stays in the WASM pipeline; native audio belongs to
      // the native fallback surface, which owns its own <audio> deliberately.
      return false;
    }

    // --- ATOMIC SWAP: stop the audio pump, swap the demuxer/source, reconfigure
    // the audio decoder, drop the old buffer, resume. ---
    this._audioSwitchInProgress = true;
    this.stopAudioLoop();
    let guard = 0;
    while (this.audioDemuxInFlight && guard++ < 200) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const oldDemuxer = this.audioDemuxer;
    const oldSource = this.audioSource;

    this.audioDemuxer = newDemuxer;
    this.audioSource = newSource;
    this._splitAudioTrackId = aTrack.id;
    // Re-derive the PTS-baseline shift for the new audio source.
    this._splitAudioStartTime = newAudioStart;
    this._splitAudioPtsDelta = (this.mediaInfo?.startTime || 0) - newAudioStart;

    const bindings = newDemuxer.getBindings();
    if (bindings) this.audioDecoder.setBindings(bindings);
    const extradata = newDemuxer.getExtradata(aTrack.id) ?? undefined;
    await this.audioDecoder.flush();
    const configured = await this.audioDecoder.configure(aTrack, extradata);
    if (configured) {
      const sourceCh = aTrack.channels ?? 2;
      const maxCh = this.audioRenderer.getMaxChannelCount();
      if (sourceCh > 2 && maxCh >= sourceCh) {
        this.audioDecoder.setDownmix(false);
        this.audioRenderer.setOutputChannelCount(sourceCh);
      } else {
        this.audioDecoder.setDownmix(true);
        this.audioRenderer.setOutputChannelCount(2);
      }
    }
    this.audioRenderer.reset(); // drop the previous language's buffered audio
    this.disableAudio = false;
    this._activeAudioLang = lang;
    this._splitAudioEof = false;
    // Another language is another source: whatever the last one died of is
    // not this one's to carry.
    this._splitAudioDead = false;
    this._splitAudioErrorSince = 0;
    this._lastSplitAudioPts = t;
    // Restart the pump on the state AS IT IS NOW, and count a seek in flight
    // as live.
    //
    // This used to read the state from BEFORE the swap — before an open, a
    // seek and a decoder reconfigure, any of which can outlast the state that
    // was current when the switch was asked for. Restoring a remembered
    // language is the case that proves it: the element asks as the media
    // loads, so the answer was taken during the opening seek ("seeking", which
    // counted as neither playing nor buffering), the swap landed into a
    // playing player, and the pump was never started again. Nothing decoded a
    // single audio packet after that — the stall detector found the buffer
    // empty, buffering held the full fifteen seconds of the bound escape, and
    // playback resumed with audioReady=false. Measured on a dubbed video: 15s
    // silent, then a 2.6s desync seek to catch the sound up.
    //
    // Safe to start whenever: pumpSplitAudio has its own state guard and idles
    // if it should not be running.
    if (
      this.stateManager.is("playing") ||
      this.stateManager.is("buffering") ||
      this.waitingForVideoSync
    ) {
      if (!this.audioRenderer.isAudioPlaying()) this.audioRenderer.play();
      this.startAudioLoop();
    }
    // A stall in the next moment belongs to this switch, not to the link: the
    // renderer was just reset and the new decoder is starting cold. Without
    // this the ABR reads it as the rung failing — measured on the same
    // session, 720p to 144p on the tick after a dub was selected.
    this._lastAudioSwitchAt = performance.now();
    this._audioSwitchInProgress = false;

    // Tear down the old audio pipeline (video untouched).
    try { oldDemuxer?.close(); } catch {}
    if (oldSource && oldSource !== newSource) {
      try { oldSource.close(); } catch {}
    }

    Logger.info(
      TAG,
      `Audio switched in-place (WASM) to: ${track.label} (${track.lang})`,
    );
    this.emit("audioTrackChange" as any, { lang, label: track.label });
    return true;
  }

  /**
   * Hand playback back to muxed (WASM) audio. Nothing to undo here — this
   * pipeline never leaves it — but the method stays because callers reach it
   * duck-typed on whichever engine is live, and the native fallback DOES have
   * an element to put down.
   */
  useMuxedAudio(): void {}

  /**
   * Whether a native <audio> element is carrying the audio. Never here — this
   * pipeline decodes it — but callers ask whichever engine is live, and the
   * native fallback answers true.
   */
  isNativeAudioActive(): boolean {
    return false;
  }

  hasNativeAudio(): boolean {
    return false;
  }

  /**
   * True if any audio path is active that the user can mute / volume-control.
   * Covers muxed (WASM) tracks, split (separate-URL) audio, and HLS streams
   * whose audio is muxed inside the stream wrapper's <video> element.
   */
  hasAudibleSource(): boolean {
    return (
      this._audioSwitchInProgress ||
      this._audioTracks.length > 0 ||
      this.trackManager.getAudioTracks().length > 0 ||
      this.audioDemuxer !== null ||
      this.streamWrapper !== null
    );
  }

  /**
   * True when audio plays through a native HTMLMediaElement — an adaptive
   * stream (HLS/DASH via the stream wrapper's <video>) — rather than the
   * AudioContext. Such audio can't be boosted above 100%
   * (HTMLMediaElement.volume caps at [0,1]), so the volume UI caps at 100%.
   */
  usesNativeAudio(): boolean {
    // Shaka plays through a media element, so its audio bypasses the WebAudio
    // gain node and can't be boosted past 100%. The WASM path always can.
    return this.streamWrapper !== null;
  }

  /**
   * True when playback runs through an adaptive-stream wrapper (HLS/DASH/Shaka)
   * rather than the WASM demux + canvas renderer. Such playback draws frames via
   * a separate stream-side CanvasRenderer, so the WASM renderer's 16x16 ambient
   * mirror is never populated — the ambient glow can't sample it and the control
   * is hidden.
   */
  isStreamPlayback(): boolean {
    return this.streamWrapper !== null;
  }

  /**
   * Whether seek-bar preview thumbnails are available for an adaptive stream —
   * they come from a manifest thumbnail track (DASH-IF tiled thumbnails / HLS
   * image playlists), which many streams simply don't carry. When false, the
   * Timeline control can't generate previews and is hidden.
   */
  streamHasThumbnails(): boolean {
    return !!(this.streamWrapper as any)?.hasThumbnails?.();
  }

  /** True for a live (dynamic) adaptive stream — drives the LIVE indicator. */
  isLiveStream(): boolean {
    // Shaka-only extras — undefined on the hls.js/dash.js fallback wrappers.
    return (this.streamWrapper as any)?.isLive?.() ?? false;
  }

  /** True when the active adaptive stream is audio-only (no video track). */
  isStreamAudioOnly(): boolean {
    return (this.streamWrapper as any)?.isAudioOnly?.() ?? false;
  }

  /** Live-edge time of a live stream (seekable range end). */
  getLiveEdge(): number {
    return (this.streamWrapper as any)?.getLiveEdge?.() ?? this.getDuration();
  }

  /** Start of a live stream's seekable (DVR) window. */
  getSeekRangeStart(): number {
    return (this.streamWrapper as any)?.getSeekRangeStart?.() ?? 0;
  }

  /** Jump to the live edge of a live stream. */
  seekToLive(): void {
    const edge = this.getLiveEdge();
    if (isFinite(edge) && edge > 0) this.streamWrapper?.seek(edge);
  }

  /**
   * Get available external subtitle tracks
   */
  /**
   * Add an external subtitle track after the source has loaded.
   *
   * The config path (`config.subtitleTracks`) is read once, when the source is
   * opened — everything that arrives later, a file the viewer picked among it,
   * had no way in short of reloading the video. Nothing else needs to change:
   * selectSubtitleLang() already fetches the URL on demand, so a `blob:` from
   * a picked File loads exactly like a hosted `.srt` does.
   *
   * `lang` is the key the menu and selectSubtitleLang() address a track by, so
   * an entry with an existing lang replaces it rather than adding a duplicate
   * the viewer cannot tell apart.
   */
  addSubtitleTrack(entry: SubtitleSourceEntry): void {
    const at = this._subtitleTracks.findIndex((t) => t.lang === entry.lang);
    if (at >= 0) this._subtitleTracks[at] = entry;
    else this._subtitleTracks.push(entry);
    Logger.info(TAG, `External subtitle added: ${entry.label} (${entry.lang})`);
  }

  /**
   * Add cues to a subtitle track that is being generated rather than loaded —
   * speech recognition writing captions as it goes is what this is for.
   *
   * The first call for a `lang` creates the track (it appears in the subtitle
   * menu like any other); later calls extend it. Cues may arrive in any order —
   * a recogniser that jumps to wherever the viewer seeked, then fills in the
   * rest — and are kept sorted; one that duplicates a cue already there (same
   * text, starting within a tenth of a second) is ignored, so overlapping
   * windows do not print a line twice. Empty or zero-length cues are dropped.
   *
   * If the track is the one showing, the new cues are on screen on the next
   * subtitle tick.
   *
   * `pending: true` with no cues lists the track before anything is known —
   * speech recognition warming up — and getSubtitleLangs() reports it as
   * pending until its first cue lands (or `pending: false` says there will be
   * none).
   */
  appendSubtitleCues(
    lang: string,
    label: string,
    cues: SubtitleCue[],
    pending?: boolean,
  ): void {
    let list = this._generatedSubCues.get(lang);
    if (!list) {
      list = [];
      this._generatedSubCues.set(lang, list);
      this.addSubtitleTrack({ url: "", lang, label, format: "vtt" });
    }
    let added = 0;
    for (const cue of cues) {
      const text = cue.text?.trim();
      if (!text || !(cue.end > cue.start)) continue;
      const dupe = list.some(
        (c) => c.text === text && Math.abs(c.start - cue.start) < 0.1,
      );
      if (dupe) continue;
      // Binary search for the insertion point — lists run to thousands.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].start <= cue.start) lo = mid + 1;
        else hi = mid;
      }
      list.splice(lo, 0, { start: cue.start, end: cue.end, text });
      added++;
    }
    if (added || pending === false) this._pendingSubLangs.delete(lang);
    else if (pending && list.length === 0) this._pendingSubLangs.add(lang);
    // The renderer remembers which index it last drew; an insertion ahead of it
    // shifts that index onto a different cue, so restart it rather than leave
    // the wrong line up.
    if (added && this._activeSubtitleLang === lang) {
      this.startExternalSubtitles();
    }
  }

  /**
   * Take a generated track (see appendSubtitleCues) out of the menu, cues and
   * all, switching subtitles off if it was showing. False if there is none.
   */
  removeSubtitleCues(lang: string): boolean {
    if (!this._generatedSubCues.has(lang)) return false;
    if (this._activeSubtitleLang === lang) {
      this.stopExternalSubtitles();
      this._externalSubCues = [];
      this._activeSubtitleLang = "";
      this.videoRenderer?.clearSubtitles();
      this.emit("subtitleTrackChange" as any, { lang: null, label: null });
    }
    this._generatedSubCues.delete(lang);
    this._pendingSubLangs.delete(lang);
    this._subtitleTracks = this._subtitleTracks.filter((t) => t.lang !== lang);
    return true;
  }

  getSubtitleLangs(): {
    lang: string;
    label: string;
    active: boolean;
    pending?: boolean;
  }[] {
    return this._subtitleTracks.map((t) => ({
      lang: t.lang,
      label: t.label,
      active: t.lang === this._activeSubtitleLang,
      ...(this._pendingSubLangs.has(t.lang) ? { pending: true } : {}),
    }));
  }

  /**
   * Select an external subtitle track by language.
   * Fetches the VTT/SRT file, parses cues, and starts rendering.
   * Pass empty string or null to disable.
   */
  async selectSubtitleLang(lang: string | null): Promise<boolean> {
    // Disable current external subtitles
    this.stopExternalSubtitles();

    if (!lang) {
      this._activeSubtitleLang = "";
      if (this.videoRenderer) this.videoRenderer.clearSubtitles();
      this.emit("subtitleTrackChange" as any, { lang: null, label: null });
      return true;
    }

    const track = this._subtitleTracks.find((t) => t.lang === lang);
    if (!track) {
      Logger.warn(TAG, `Subtitle track not found for lang: ${lang}`);
      return false;
    }

    // A generated track has nothing to fetch: its cues are already here, and
    // still arriving.
    const generated = this._generatedSubCues.get(lang);
    if (generated) {
      this.videoRenderer?.setSubtitleFormat("vtt");
      this._externalSubCues = generated;
      this._activeSubtitleLang = lang;
      this.selectSubtitleTrack(null);
      this.startExternalSubtitles();
      this.emit("subtitleTrackChange" as any, { lang, label: track.label });
      return true;
    }

    try {
      // Fetch subtitle file
      const res = await fetch(track.url, { signal: this.lifetimeSignal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      // Detect format
      const fmt =
        track.format ||
        (/\.(ttml|dfxp)(\?|#|$)/i.test(track.url)
          ? "ttml"
          : track.url.includes(".srt")
            ? "srt"
            : "vtt");

      // Tell the renderer which format we're using so it can toggle the
      // VTT-only backdrop styling. TTML renders like plain text (VTT path).
      this.videoRenderer?.setSubtitleFormat(fmt === "ttml" ? "vtt" : fmt);

      // Parse into cues
      this._externalSubCues =
        fmt === "srt"
          ? this.parseSRT(text)
          : fmt === "ttml"
            ? this.parseTTML(text)
            : this.parseVTT(text);

      this._activeSubtitleLang = lang;

      // Disable muxed subtitles if active
      this.selectSubtitleTrack(null);

      // Start cue timer
      this.startExternalSubtitles();

      Logger.info(TAG, `Subtitle loaded: ${track.label} (${this._externalSubCues.length} cues)`);
      this.emit("subtitleTrackChange" as any, { lang, label: track.label });
      return true;
    } catch (e) {
      Logger.error(TAG, `Failed to load subtitle: ${track.url}`, e);
      return false;
    }
  }

  /** Parse VTT text into SubtitleCue[] */
  private parseVTT(text: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(
          /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
        );
        if (match) {
          const start = +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
          const end = +match[5] * 3600 + +match[6] * 60 + +match[7] + +match[8] / 1000;
          const cueText = lines.slice(i + 1).join("\n").trim();
          if (cueText) cues.push({ start, end, text: cueText });
          break;
        }
      }
    }
    return cues;
  }

  /** Parse SRT text into SubtitleCue[] */
  private parseSRT(text: string): SubtitleCue[] {
    // SRT has same timestamp format but with comma instead of dot — parseVTT handles both
    return this.parseVTT(text);
  }

  /**
   * Parse TTML (Timed Text Markup Language, application/ttml+xml — what DASH
   * streams commonly ship, e.g. GPAC test vectors) into SubtitleCue[]. Reads
   * each <p>'s begin/end (or begin + dur) timing and its text, turning <br/>
   * into newlines and dropping styling tags. Namespace-agnostic (matches by
   * localName) so both `<p>` and `<tt:p>` work.
   */
  private parseTTML(text: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(text, "application/xml");
    } catch {
      return cues;
    }
    if (doc.getElementsByTagName("parsererror").length > 0) return cues;

    // "01:02:03.500" / "01:02:03:12" (frames) / "5s" / "1500ms" / "2m" / "1h".
    const parseTime = (raw: string | null): number => {
      if (!raw) return NaN;
      const t = raw.trim();
      const off = t.match(/^([\d.]+)(ms|h|m|s|f)$/);
      if (off) {
        const v = parseFloat(off[1]);
        return off[2] === "h"
          ? v * 3600
          : off[2] === "m"
            ? v * 60
            : off[2] === "ms"
              ? v / 1000
              : off[2] === "f"
                ? v / 30 // frames — assume 30fps (no frameRate context here)
                : v; // "s"
      }
      const p = t.split(":");
      if (p.length >= 3) {
        let sec = (+p[0] || 0) * 3600 + (+p[1] || 0) * 60 + (parseFloat(p[2]) || 0);
        if (p.length === 4) sec += (+p[3] || 0) / 30; // HH:MM:SS:frames
        return sec;
      }
      return NaN;
    };

    const extractText = (el: Element): string => {
      let out = "";
      el.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) out += n.textContent || "";
        else if (n.nodeType === Node.ELEMENT_NODE) {
          if ((n as Element).localName.toLowerCase() === "br") out += "\n";
          else out += extractText(n as Element);
        }
      });
      return out;
    };

    const paras = Array.from(doc.getElementsByTagName("*")).filter(
      (el) => el.localName.toLowerCase() === "p",
    );
    for (const p of paras) {
      const start = parseTime(p.getAttribute("begin"));
      let end = parseTime(p.getAttribute("end"));
      if (isNaN(end)) {
        const dur = parseTime(p.getAttribute("dur"));
        if (!isNaN(dur) && !isNaN(start)) end = start + dur;
      }
      const cueText = extractText(p)
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .trim();
      if (cueText && !isNaN(start) && !isNaN(end) && end > start) {
        cues.push({ start, end, text: cueText });
      }
    }
    return cues;
  }

  /** Start rendering external subtitle cues based on playback time */
  private startExternalSubtitles(): void {
    this.stopExternalSubtitles();
    let lastIdx = -1;
    this._externalSubTimer = window.setInterval(() => {
      if (!this.videoRenderer) return;
      const time = this.clock.getTime();
      // Find active cue
      const idx = this._externalSubCues.findIndex(
        (c) => time >= c.start && time <= c.end
      );
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (idx >= 0) {
          this.videoRenderer.setSubtitleCues([this._externalSubCues[idx]]);
        } else {
          this.videoRenderer.setSubtitleCues([]);
        }
      }
    }, 100); // 10Hz check — enough for subtitle timing
  }

  /** Stop external subtitle rendering */
  private stopExternalSubtitles(): void {
    if (this._externalSubTimer !== null) {
      clearInterval(this._externalSubTimer);
      this._externalSubTimer = null;
    }
  }

  /**
   * Get playback rate
   */
  getPlaybackRate(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getPlaybackRate();
    }
    return this.clock.getPlaybackRate();
  }

  /**
   * Set subtitle delay in seconds.
   * VLC/mpv convention: positive value = subtitles appear later than the
   * original cue timing, negative value = earlier. Useful when the subtitle
   * track is out of sync with the video due to different source releases or
   * frame-rate conversions.
   */
  setSubtitleDelay(seconds: number): void {
    this._subtitleDelaySec = seconds;
    if (this._customSubtitleRenderer) {
      try {
        this._customSubtitleRenderer.setDelay(seconds);
      } catch {
        /* ignore */
      }
    }
    if (this.videoRenderer) {
      this.videoRenderer.setSubtitleDelay(seconds);
    }
    // Non-zero delay needs cues from stream positions the demuxer hasn't
    // necessarily reached yet (negative delay) or has already passed
    // (positive delay across a seek). Prefetch the full cue list once so
    // the renderer cache is authoritative regardless of demuxer position.
    // Zero delay falls back to the streaming path — no prefetch overhead.
    if (seconds !== 0) {
      void this.prefetchActiveSubtitleStream();
    }
  }

  /** Get current subtitle delay in seconds. */
  getSubtitleDelay(): number {
    return this.videoRenderer ? this.videoRenderer.getSubtitleDelay() : 0;
  }

  /**
   * Register a pluggable subtitle renderer (or clear it with null) — e.g. jassub
   * (libass-wasm) for full ASS/SSA styling. While set, the active embedded
   * subtitle stream is routed to it (configure/pushPacket/render/…) instead of
   * the internal decoder, and its cues are suppressed. See SubtitleRenderer.
   */
  setSubtitleRenderer(renderer: SubtitleRenderer | null): void {
    if (this._customSubtitleRenderer === renderer) return;
    this._customSubtitleRenderer = renderer;
    this._stopSubtitleRenderLoop();
    // NB: the player never destroys the renderer — the registrar owns its
    // lifecycle (the element re-applies the same instance to a fresh player on a
    // source change, so destroying it here would kill it mid-swap).
    // Handing over or back: drop the internal decoder's cues so the two paths
    // never draw at once.
    this.videoRenderer?.setSubtitleCues([]);
    if (renderer) {
      const overlay = this.videoRenderer?.getSubtitleOverlay?.() ?? null;
      if (overlay && renderer.mount) {
        try {
          renderer.mount(overlay);
        } catch {
          /* ignore */
        }
      }
      try {
        renderer.setDelay(this._subtitleDelaySec);
      } catch {
        /* ignore */
      }
      void this._configureCustomSubtitleRenderer();
      this._startSubtitleRenderLoop();
    }
  }

  /** (Re)configure the custom renderer for the active subtitle track. */
  private async _configureCustomSubtitleRenderer(): Promise<void> {
    const r = this._customSubtitleRenderer;
    const track = this.trackManager.getActiveSubtitleTrack();
    if (!r || !track || !this.demuxer) return;
    const extradata = this.demuxer.getExtradata(track.id) ?? undefined;
    // Embedded font attachments aren't surfaced yet (Matroska ATTACHMENT streams
    // need a C-side hook — tracked separately); pass undefined for now, so the
    // renderer falls back to its default/system fonts.
    try {
      await r.configure(track, extradata, undefined);
    } catch (e) {
      Logger.error(TAG, "Custom subtitle renderer configure failed", e);
    }
  }

  private _startSubtitleRenderLoop(): void {
    if (this._subtitleRenderRAF !== null || typeof requestAnimationFrame === "undefined") {
      return;
    }
    const tick = () => {
      this._subtitleRenderRAF = null;
      const r = this._customSubtitleRenderer;
      if (!r) return;
      const vt = this.trackManager.getActiveVideoTrack();
      // Raw media time — the renderer applies its own offset via setDelay().
      try {
        void r.render(this.clock.getTime(), vt?.width || 0, vt?.height || 0);
      } catch {
        /* a renderer hiccup shouldn't kill the loop */
      }
      this._subtitleRenderRAF = requestAnimationFrame(tick);
    };
    this._subtitleRenderRAF = requestAnimationFrame(tick);
  }

  private _stopSubtitleRenderLoop(): void {
    if (this._subtitleRenderRAF !== null) {
      cancelAnimationFrame(this._subtitleRenderRAF);
      this._subtitleRenderRAF = null;
    }
  }

  /**
   * Return every cue for the active subtitle stream, scanning it via the
   * C-side prefetch path if we haven't already done so. Used by the cues
   * browser UI — gives the caller a stable list to render and seek into.
   * Resolves to an empty array when no subtitle is active, the active
   * track is bitmap-only (PGS), or scanning fails.
   */
  async getAllSubtitleCues(): Promise<{ start: number; end: number; text: string }[]> {
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (!subtitleTrack) return [];
    if (subtitleTrack.subtitleType && subtitleTrack.subtitleType !== "text") return [];
    if (this.prefetchedSubtitleStream !== subtitleTrack.id) {
      await this.prefetchActiveSubtitleStream();
    }
    if (!this.videoRenderer) return [];
    // The renderer's cue cache is the canonical post-prefetch source —
    // prefetchActiveSubtitleStream pushes the full list into it via
    // setSubtitleCues. Reading it back avoids holding a duplicate copy
    // on MoviPlayer.
    return this.videoRenderer.getAllCues();
  }

  /**
   * Scan the active subtitle stream and seed the renderer with every cue.
   * No-op when the same stream has already been prefetched, when no
   * subtitle is selected, or when a prefetch is in flight. The demuxer is
   * left at EOF after the C-side scan, so we re-seek back to the current
   * playback position before returning.
   */
  private async prefetchActiveSubtitleStream(): Promise<void> {
    if (this.prefetchInFlight) return;
    if (!this.demuxer || !this.videoRenderer) return;
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (!subtitleTrack) return;
    if (this.prefetchedSubtitleStream === subtitleTrack.id) return;
    const bindings = this.demuxer.getBindings();
    if (!bindings) return;
    // Only support text subtitles — bitmap (PGS/dvd_subtitle) decoding
    // returns image data, which the prefetch text path can't carry across
    // and which the user-shift UI doesn't apply to anyway.
    if (subtitleTrack.subtitleType && subtitleTrack.subtitleType !== "text") return;

    this.prefetchInFlight = true;
    const resumeTime = this.clock.getTime();
    const wasPlaying = this.stateManager.getState() === "playing";

    // Quiesce all paths that touch the demuxer/decoders. Without this the
    // prefetch's seek-to-0 + sequential reads race the playback processLoop
    // (which is already mid-readPacket via Asyncify), corrupting the
    // js_read_async pending-read state and stalling playback indefinitely
    // ("No pending read to fulfill").
    this.stopPauseBuffering();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Bumping the seek session ID forces any in-flight processLoop iteration
    // to bail out at its next checkpoint instead of writing stale results.
    this.seekSessionId++;
    // Release a superseded seek's video-sync flag — this prefetch does its own
    // re-seek + resume below, so a lingering wait would strand the pipeline in a
    // permanent loading state (see notifySeekCompletion's superseded branch).
    this.waitingForVideoSync = false;
    if (wasPlaying) {
      this.clock.pause();
      if (!this.disableAudio) this.audioRenderer.pause();
      if (this.videoRenderer) this.videoRenderer.stopPresentationLoop();
    }
    // Wait for any demuxer call already in flight to land before we issue
    // our own. Asyncify won't let two reads/seeks overlap on the same
    // context; this poll is short because js_read_async resolves within a
    // single rAF once the JS side delivers the buffer.
    const maxWaitMs = 2000;
    const waitStart = performance.now();
    while (this.demuxInFlight && performance.now() - waitStart < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 10));
    }

    try {
      Logger.info(TAG, `Prefetching subtitle cues for stream ${subtitleTrack.id}...`);
      const cues = await bindings.prefetchSubtitleCues(subtitleTrack.id);
      if (cues && cues.length > 0) {
        // Seed the renderer's cache with every cue at once. The renderer
        // already maintains an active-cue cursor that re-evaluates against
        // the current adjusted time, so we don't need a separate "play
        // from cache" mode — the existing display path just works.
        this.videoRenderer.setSubtitleCues(cues);
        this.prefetchedSubtitleStream = subtitleTrack.id;
        Logger.info(TAG, `Prefetched ${cues.length} subtitle cues for stream ${subtitleTrack.id}`);
      } else {
        Logger.warn(TAG, `Subtitle prefetch returned no cues for stream ${subtitleTrack.id}`);
      }

      // The C-side scan leaves the demuxer at EOF. Re-seek back to where
      // playback should be so the audio/video pipeline can keep going.
      // Flush decoders + clear queue since the demuxer is in an
      // undefined-for-playback state.
      await this.videoDecoder.flush();
      this.dropVideoReadAhead();
      await this.audioDecoder.flush();
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      this.audioRenderer.reset();
      await this.demuxer.seek(resumeTime);
      this.clock.seek(resumeTime);
      this.pendingAudioPackets = [];
      this.pendingPrebufferPackets = [];
      this.dropVideoReadAhead();
      this.eofReached = false;
      this._eofPictureDrainSince = 0;
    this._eofFlushRequested = false;
      this.eofSince = 0;
    } catch (err) {
      Logger.error(TAG, "Subtitle prefetch failed", err);
    } finally {
      this.prefetchInFlight = false;
    }

    // Resume audio/video pipelines if we paused them above. We bypass the
    // public play() because the player's state is still "playing" — we
    // only paused the underlying clocks/decoders and need to nudge them
    // back without the full first-play song-and-dance.
    if (wasPlaying) {
      try {
        if (!this.disableAudio) await this.audioRenderer.play();
        if (this.videoRenderer) this.videoRenderer.startPresentationLoop();
        this.clock.start();
        // Re-arm the seek-target guard (filter-only, not waitingForVideoSync)
        // so any pre-target frames produced by Open-GOP recovery after the
        // resumeTime seek get dropped without firing notifySeekCompletion's
        // state transitions.
        this.seekTargetTime = resumeTime;
        this.animationFrameId = requestAnimationFrame(this.processLoop);
        this.requestWakeLock();
      } catch (err) {
        Logger.error(TAG, "Failed to resume after subtitle prefetch", err);
      }
    } else {
      // Even when paused, kick off pause-time buffering again so the
      // demuxer keeps reading ahead behind the scenes (HTTP sources only).
      this.startPauseBuffering();
    }
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    if (this.streamWrapper) {
      this.streamWrapper.setVolume(volume);
    }
    this.audioRenderer.setVolume(volume);
  }

  /**
   * Take the sound down a slope, for a player that is about to go away.
   *
   * See AudioRenderer.fadeOut. An adaptive stream's audio comes out of a media
   * element rather than our gain node, so there is nothing to ramp — it is
   * stepped down instead, often enough that the ear hears a slope and not a
   * staircase.
   */
  fadeOutAudio(durationMs: number = 200): void {
    this.audioRenderer.fadeOut(durationMs);
    const wrapper = this.streamWrapper;
    if (!wrapper) return;
    const from = this.audioRenderer.getVolume?.() ?? 1;
    const steps = Math.max(4, Math.round(durationMs / 25));
    for (let i = 1; i <= steps; i++) {
      setTimeout(
        () => {
          try {
            wrapper.setVolume(Math.max(0, from * (1 - i / steps)));
          } catch {
            /* the stream is already gone */
          }
        },
        (durationMs * i) / steps,
      );
    }
  }

  /**
   * Get volume (0-1)
   */
  getVolume(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getVolume();
    }
    return this.audioRenderer.getVolume();
  }

  /**
   * Set muted state
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return; // No change

    this.muted = muted;
    if (this.streamWrapper) {
      this.streamWrapper.setMuted(muted);
      return;
    }

    // Was the audio being thrown away? Read it BEFORE unmute() flips the state.
    // While muted with a browser-suspended context every decoded audio frame is
    // dropped, so there is no audio for the picture on screen — the decoder has
    // run on ahead with the demuxer, a video buffer's worth past the presented
    // frame. See the re-sync below.
    const wasDroppingAudio = this.audioRenderer.isDroppingAudio();

    if (muted) {
      this.audioRenderer.mute();
    } else {
      // unmute() is async (initializes AudioContext on first unmute) but we
      // don't await it to keep setMuted() synchronous. Call it FIRST so its
      // AudioContext.resume() claims the tap's user activation before anything
      // else can: on Safari the wake-lock request below consumes the transient
      // activation, and if it ran first the resume would be denied — leaving the
      // shared context suspended and re-showing "tap to unmute" on the next video.
      const unmuted = this.audioRenderer.unmute().catch((err) => {
        Logger.error("MoviPlayer", "Failed to unmute", err);
      });
      // Tap-to-unmute is also a good moment to (re)acquire the screen wake lock,
      // which muted autoplay couldn't get without a gesture. Best-effort, after
      // unmute — losing the activation to it here is harmless; losing audio isn't.
      this.ensureWakeLock();

      // The audio for this moment is gone — dropped, frame by frame, while the
      // context was suspended. What the decoder holds now belongs to the
      // demuxer's read position, one video buffer AHEAD of the frame on screen.
      // Let that start playing and the clock, which audio masters, jumps
      // forward with it: the viewer hears a second or two of audio from the
      // future while the picture sits still, then the video catches up. That is
      // the "1-3s of audio, then video continues" on tap-to-unmute.
      //
      // The only way to get the audio for the current position is to read it
      // again, which is a seek — to exactly where we already are, so nothing is
      // lost but the re-read, and the bytes are still in the source's buffer.
      if (wasDroppingAudio && this.stateManager.getState() === "playing") {
        // Hold the output silent across the re-read. The resume has to ride the
        // tap, but what it makes audible is the decoder's position, not the
        // picture's — so the viewer got a second of the wrong moment, then a
        // seek, then the right one. Silent through the correction, audible when
        // it lands: one transition instead of three.
        this.audioRenderer.silenceForResync();
        // Where the picture is, read NOW — before the resume, not after it.
        //
        // A suspended AudioContext freezes its own currentTime, and the audio
        // clock is a mapping off that, so it goes on reporting the position
        // where the context went to sleep. While the audio was being dropped
        // nothing masters off it and the clock tracks the picture; the moment
        // the context is running again the clock snaps to that stale audio
        // position instead. Sampling the target inside the .then() therefore
        // sampled it AFTER the snap, and the seek dutifully took the picture
        // back to where the audio had been asleep. Measured: picture at 8.48s,
        // audio clock still reading 5.09s, and the tap sent playback back to
        // 4.31s — a four-second jump backwards, and then the race forwards to
        // catch up with the sound.
        const pictureAt = this.getCurrentTime();
        // …but the SEEK only once the context is RUNNING. Seeking first put the re-read
        // audio on an anchor that the "running" statechange then discarded,
        // and every buffer decoded in between was already late against a wall
        // clock that had walked the picture on: ~2s of silent video, then a
        // 2036ms drift correction to catch up. Racing a short timeout so a
        // resume that never settles can't swallow the correction entirely.
        void Promise.race([
          unmuted,
          new Promise((r) => setTimeout(r, MoviPlayer.UNMUTE_RESUME_WAIT_MS)),
        ]).then(() => {
          if (this.muted || this.stateManager.getState() !== "playing") {
            this.audioRenderer.releaseResyncSilence();
            return;
          }
          Logger.info(
            TAG,
            `Unmute: audio was being dropped — re-reading from ${pictureAt.toFixed(2)}s (where the picture was at the tap) so it lands with it`,
          );
          this.seek(pictureAt)
            // Whatever happens — landed, failed, superseded — the hold has to
            // come off, or tap-to-unmute ends in permanent silence.
            .catch(() => {})
            .finally(() => this.audioRenderer.releaseResyncSilence());
        });
      }
    }
  }

  /**
   * Get muted state
   */
  getMuted(): boolean {
    return this.muted;
  }

  /**
   * Enable/disable stable audio mode
   * Stable audio provides: smooth gain transitions, auto-recovery,
   * gap filling on underrun, starvation detection, and fade on seek/reset
   */
  setStableAudio(enabled: boolean): void {
    this.audioRenderer.setStableAudio(enabled);
  }

  /** Stall the two streams together, either way round: see _bindAV. */
  setBindAV(enabled: boolean): void {
    this._bindAV = enabled;
  }

  /** Hidden does not mean unwatched: see _backgroundPlay. */
  setBackgroundPlay(enabled: boolean): void {
    this._backgroundPlay = enabled;
  }

  getBackgroundPlay(): boolean {
    return this._backgroundPlay;
  }

  getBindAV(): boolean {
    return this._bindAV;
  }

  /**
   * Get stable audio mode state
   */
  getStableAudio(): boolean {
    return this.audioRenderer.getStableAudio();
  }

  /**
   * Get comprehensive player stats for "Stats for nerds" overlay
   */
  /**
   * Raw render-health numbers for the stutter-hint monitor — distinct from
   * getStats(), which formats display strings. framesPresented is cumulative
   * (resets to 0 on seek/reset), so callers must handle it going backwards.
   * Null when there's no video renderer (audio-only / adaptive streams).
   */
  getRenderHealth(): { framesPresented: number; sourceFps: number } | null {
    if (!this.videoRenderer || this.streamWrapper) return null;
    const vt = this.trackManager.getActiveVideoTrack() as VideoTrack | null;
    return {
      framesPresented: this.videoRenderer.getStats().framesPresented,
      sourceFps: vt?.frameRate && vt.frameRate > 0 ? vt.frameRate : 30,
    };
  }

  /**
   * True once the renderer has judged this device unable to decode the current
   * rung at all (near-zero frames presented while audio flows). Callers use it
   * to tell "the pipeline is stuck" apart from "the decoder is simply too slow"
   * — the recovery for the first (a corrective re-prime seek) is actively
   * harmful for the second.
   */
  /**
   * What this source needs, in BITS per second, to arrive in real time.
   *
   * Total bytes over duration, not the video track's declared bitrate: a remux
   * carries every audio track and every subtitle in the same container, and the
   * demuxer reads the lot — on the 40GB file this was written for, five audio
   * tracks including TrueHD Atmos. What has to come down the wire is the file,
   * so the file is what the figure is taken from. Declared per-track bitrates
   * would answer a question nobody is asking, and MKV often omits them anyway.
   *
   * 0 when it cannot be known — a local file, or a source that has not resolved
   * its size — which is the signal to say nothing rather than guess.
   *
   * Deliberately NOT paired with a throughput accessor here. The ABR's reading
   * is a floor once the source parks at the prefetch gate, and publishing it
   * beside this invites exactly the comparison that cried wolf twice; the link
   * side of the question belongs to probeLinkBandwidth.
   */
  requiredLinkBps(): number {
    const bytes =
      (this.source as { getKnownSize?: () => number } | null)?.getKnownSize?.() ??
      0;
    const duration = this.getDuration();
    if (!(bytes > 0) || !(duration > 0)) return 0;
    return (bytes * 8) / duration;
  }

  /**
   * Is the picture presenting fast enough for a catch-up to be worth trying?
   *
   * `null` until there is a second of history to answer from. A catch-up is a
   * video-only seek, and on a long-GOP 8K AV1 the keyframe before the target
   * sits well behind it — measured in the session this comes from, 1.7s and
   * 3.2s behind two of the targets. Asking the slowest decoder in the session
   * to decode that much extra before anything reaches the screen loses more
   * ground than the lag it was chasing, which is the same reasoning the
   * decode-bound gate beside it already carries; this just gets there sooner.
   */
  private pictureKeepingUp(): boolean | null {
    const h = this.getRenderHealth();
    if (!h) return null;
    const now = performance.now();
    const gap = now - this._lagLastSampleAt;
    this._lagLastSampleAt = now;
    if (
      this._lagFpsBase < 0 ||
      h.framesPresented < this._lagFpsBase ||
      gap > MoviPlayer.LAG_SAMPLE_GAP_MS
    ) {
      // First look, the counter restarted under us (any seek does that), or
      // playback stopped since the last look (see _lagLastSampleAt): start a
      // fresh window, keep the last reading.
      this._lagFpsBase = h.framesPresented;
      this._lagFpsAt = now;
      this._lagWindowSamples = 0;
      this._lagWindowStarved = 0;
      return this._lagFpsAchieved < 0
        ? null
        : this._lagFpsAchieved >= h.sourceFps * MoviPlayer.LAG_KEEPING_UP_RATIO;
    }
    // See _lagWindowStarved: was there anything to present, or to decode?
    this._lagWindowSamples++;
    if (
      (this.videoRenderer?.getStats().frameQueueSize ?? 0) === 0 &&
      (this.videoDecoder?.queueSize ?? 0) === 0 &&
      this._videoAheadStash.length === 0
    ) {
      this._lagWindowStarved++;
    }
    const elapsed = now - this._lagFpsAt;
    if (elapsed >= 1000) {
      const starved =
        this._lagWindowSamples > 0 &&
        this._lagWindowStarved / this._lagWindowSamples >
          MoviPlayer.LAG_STARVED_RATIO;
      // A window the delivery starved is no reading of the device: unknown,
      // not slow. Unknown answers null here and false in deviceIsBottleneck.
      this._lagFpsAchieved = starved
        ? -1
        : (h.framesPresented - this._lagFpsBase) / (elapsed / 1000);
      this._lagFpsBase = h.framesPresented;
      this._lagFpsAt = now;
      this._lagWindowSamples = 0;
      this._lagWindowStarved = 0;
    }
    if (this._lagFpsAchieved < 0) return null;
    return this._lagFpsAchieved >= h.sourceFps * MoviPlayer.LAG_KEEPING_UP_RATIO;
  }

  /**
   * Is the DEVICE the bottleneck right now, rather than the delivery?
   *
   * The link notice needs this because its only other evidence is that
   * playback stopped, and a decoder that cannot keep up stops playback too —
   * the catch-up hold does it on purpose ("holding sound and clock for it").
   * Without this, a slow decoder on a heavy file would arm a verdict about the
   * connection, and a probe that happens to read low while competing with the
   * player's own streaming would then blame the link for the device's problem.
   * That is the same wrong-cause-named mistake the notice already made twice,
   * arriving from the third direction.
   *
   * Three answers, cheapest first. Self-inflicted buffering is the player's own
   * doing by definition, so it is never the link. The renderer's decode-bound
   * verdict is the settled judgement. The lag reading is the early one — see
   * pictureKeepingUp — and is READ here, never sampled, so this cannot perturb
   * the window that method keeps.
   *
   * Used only to hold a notice back, so a false positive here costs nothing but
   * silence, which is the right way to be wrong about this.
   */
  deviceIsBottleneck(): boolean {
    if (this._bufferingSelfInflicted) return true;
    if (this.videoRenderer?.isDecodeBound?.()) return true;
    const h = this.getRenderHealth();
    return (
      !!h &&
      this._lagFpsAchieved >= 0 &&
      this._lagFpsAchieved < h.sourceFps * MoviPlayer.LAG_KEEPING_UP_RATIO
    );
  }

  isDecodeBound(): boolean {
    return this.videoRenderer?.isDecodeBound?.() ?? false;
  }

  /**
   * Did the DELIVERY run dry just now — a read waiting on bytes the network
   * had not brought yet?
   *
   * deviceIsBottleneck answers the other half of the question and cannot
   * answer this one: it reads how fast the picture reaches the screen, and a
   * picture can run slow for reasons that never stop playback. From an 8K60
   * AV1 file on Google Drive: the host page held rAF to ~40/s, the picture
   * presented ~32fps, deviceIsBottleneck said "device" — and every stall in
   * the session was the sound running out because the next bytes had not
   * arrived. Those stalls were never counted against the link, so the notice
   * that the file needs 41 Mbps never came. A stall with a read parked on the
   * network is the delivery's, whatever the picture is doing.
   */
  deliveryStarved(withinMs: number = MoviPlayer.DELIVERY_STARVED_WINDOW_MS): boolean {
    const at =
      (this.source as { lastNetworkWait?: () => number } | null)?.lastNetworkWait?.() ?? 0;
    return at > 0 && performance.now() - at < withinMs;
  }
  private static readonly DELIVERY_STARVED_WINDOW_MS = 3000;

  /** The best rate the media has actually arrived at from this source,
   *  BITS/second, or -1 — see HttpSource.bestDeliveryBps. */
  deliveryRateBps(): number {
    const src = this.source as {
      bestDeliveryBps?: () => number;
      recentDeliveryBps?: () => number;
    } | null;
    const best = src?.bestDeliveryBps?.() ?? -1;
    return best > 0 ? best : (src?.recentDeliveryBps?.() ?? -1);
  }

  getStats(): Record<string, string | number | boolean> {
    // HLS mode: delegate to HLS wrapper
    if (this.streamWrapper) {
      return this.streamWrapper.getStats();
    }

    const mediaInfo = this.mediaInfo;
    const videoTrack = this.trackManager.getActiveVideoTrack() as VideoTrack | null;
    const audioTrack = this.trackManager.getActiveAudioTrack() as AudioTrack | null;
    const videoDecoderStats = this.videoDecoder.getStats();
    const audioDecoderStats = this.audioDecoder.getStats();
    const rendererStats = this.videoRenderer?.getStats();
    const audioBuffered = this.audioRenderer.getBufferedDuration();

    const stats: Record<string, string | number | boolean> = {};

    // Video info
    if (videoTrack) {
      stats["Video Codec"] = videoTrack.codec ?? "N/A";
      stats["Resolution"] = `${videoTrack.width}x${videoTrack.height}`;
      // Quality label — classify by the larger of actual height and the
      // 16:9-normalised height (width * 9 / 16). Cinematic / ultrawide
      // sources letterbox horizontally, so a 3840×2080 cut of 4K UHD
      // would otherwise misreport as "2K" purely because its pixel
      // height is < 2160.
      const h = videoTrack.height;
      const eff = Math.max(h, Math.round(videoTrack.width * 9 / 16));
      stats["Quality"] = eff >= 8640 ? "16K" : eff >= 4320 ? "8K" : eff >= 2160 ? "4K" : eff >= 1440 ? "2K" : eff >= 1080 ? "1080p" : eff >= 720 ? "720p" : eff >= 480 ? "480p" : "SD";
      stats["Frame Rate"] = `${videoTrack.frameRate} fps`;
      stats["Video Bitrate"] = videoTrack.bitRate
        ? `${(videoTrack.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
      if (videoTrack.pixelFormat) stats["Pixel Format"] = videoTrack.pixelFormat;
      stats["Color Space"] = videoTrack.colorSpace ?? "N/A";
      if (videoTrack.colorRange) stats["Color Range"] = videoTrack.colorRange;
      if (videoTrack.colorPrimaries && videoTrack.colorPrimaries !== "unknown") {
        stats["Color Primaries"] = videoTrack.colorPrimaries;
      }
      if (videoTrack.colorTransfer && videoTrack.colorTransfer !== "unknown") {
        stats["Color Transfer"] = videoTrack.colorTransfer;
      }
      stats["HDR"] = videoTrack.isHDR ? "Yes" : "No";
      if (videoTrack.rotation) stats["Rotation"] = `${videoTrack.rotation}°`;
      stats["Video Decoder"] = videoDecoderStats.decoderType;
    }

    // Audio info
    if (audioTrack) {
      stats["Audio Codec"] = audioTrack.codec ?? "N/A";
      if (audioTrack.language && audioTrack.language !== "und") {
        stats["Language"] = audioTrack.language.toUpperCase();
      }
      stats["Sample Rate"] = `${audioTrack.sampleRate} Hz`;
      stats["Channels"] = audioTrack.channels === 1 ? "Mono" :
                          audioTrack.channels === 2 ? "Stereo" :
                          audioTrack.channels === 6 ? "5.1 Surround" :
                          audioTrack.channels === 8 ? "7.1 Surround" :
                          `${audioTrack.channels}ch`;
      stats["Audio Bitrate"] = audioTrack.bitRate
        ? `${(audioTrack.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
      stats["Audio Decoder"] = audioDecoderStats.decoderType;
    }

    // Subtitle info
    const subtitleTrack = this.trackManager.getActiveSubtitleTrack();
    if (subtitleTrack) {
      stats["Subtitle"] = `${subtitleTrack.codec ?? "text"}${subtitleTrack.language ? ` (${subtitleTrack.language.toUpperCase()})` : ""}`;
    }

    // Container
    if (mediaInfo) {
      stats["Container"] = mediaInfo.formatName ?? "N/A";
      stats["Total Bitrate"] = mediaInfo.bitRate
        ? `${(mediaInfo.bitRate / 1000).toFixed(0)} kbps`
        : "N/A";
    }

    // Playback
    stats["Playback State"] = this.stateManager.getState();
    stats["Playback Rate"] = `${this.clock.getPlaybackRate()}x`;
    stats["A/V Sync"] = this.clock.isSyncedToAudio() ? "Audio Master" : "Wall Clock";
    stats["Stable Volume"] = this.audioRenderer.getStableAudio() ? "On" : "Off";

    // Buffers
    stats["Audio Buffer"] = `${audioBuffered.toFixed(2)}s`;
    stats["Video Queue"] = `${rendererStats?.frameQueueSize ?? 0} frames`;
    stats["Frames Rendered"] = rendererStats?.framesPresented ?? 0;
    stats["Video Decoder Queue"] = videoDecoderStats.queueSize;
    stats["Audio Decoder Queue"] = audioDecoderStats.queueSize;

    // Memory usage (Chrome only)
    const mem = (performance as any).memory;
    if (mem) {
      stats["Memory Used"] = `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`;
      stats["Memory Limit"] = `${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`;
    }

    // File
    if (this.fileSize > 0) {
      stats["File Size"] = this.fileSize > 1048576
        ? `${(this.fileSize / 1048576).toFixed(1)} MB`
        : `${(this.fileSize / 1024).toFixed(1)} KB`;
    }

    // Network (HttpSource) or Disk (FileSource) stats
    if (this.source instanceof HttpSource) {
      const net = this.source.getNetworkStats();
      stats["Downloaded"] = net.totalBytes > 1048576
        ? `${(net.totalBytes / 1048576).toFixed(1)} MB`
        : `${(net.totalBytes / 1024).toFixed(1)} KB`;
      stats["Network Speed"] = net.currentSpeed > 0
        ? net.currentSpeed > 1048576
          ? `${(net.currentSpeed / 1048576).toFixed(1)} MB/s`
          : `${(net.currentSpeed / 1024).toFixed(0)} KB/s`
        : "—";
      stats["Connection Time"] = `${net.elapsed.toFixed(1)}s`;
    } else if (this.source instanceof FileSource) {
      const disk = this.source.getDiskStats();
      stats["Disk Read"] = disk.totalBytes > 1048576
        ? `${(disk.totalBytes / 1048576).toFixed(1)} MB`
        : `${(disk.totalBytes / 1024).toFixed(1)} KB`;
      stats["Read Speed"] = disk.currentSpeed > 0
        ? disk.currentSpeed > 1048576
          ? `${(disk.currentSpeed / 1048576).toFixed(1)} MB/s`
          : `${(disk.currentSpeed / 1024).toFixed(0)} KB/s`
        : "—";
    }

    return stats;
  }

  /**
   * Get current I/O throughput in bytes/sec (for graph)
   * Works for both network (HttpSource) and disk (FileSource)
   */
  getNetworkSpeed(): number {
    // HLS mode: delegate to HLS wrapper
    if (this.streamWrapper) {
      return this.streamWrapper.getNetworkSpeed();
    }
    // EncryptedHttpSource extends HttpSource, so the HttpSource branch
    // covers encrypted playback too.
    if (this.source instanceof HttpSource) {
      return this.source.getNetworkStats().currentSpeed;
    }
    if (this.source instanceof FileSource) {
      return this.source.getDiskStats().currentSpeed;
    }
    return 0;
  }

  /**
   * Check if source is a local file
   */
  isFileSource(): boolean {
    if (this.streamWrapper) return false;
    return this.source instanceof FileSource;
  }

  /**
   * True when the active source has fallen back to linear (forward-only,
   * non-seekable) playback — server lacks HTTP Range support and the file is
   * too big to cache whole. Used by the UI as a backstop alongside the
   * "linearmode" event (in case the event fired before listeners attached).
   */
  isLinearPlayback(): boolean {
    const src = this.source as { isLinearMode?: () => boolean } | null;
    return typeof src?.isLinearMode === "function" ? src.isLinearMode() : false;
  }

  /**
   * True when audio is blocked by the browser's autoplay policy — the
   * AudioContext is stuck suspended despite an unmuted play() because no
   * user gesture has unlocked it. play()'s promise resolves either way, so
   * the element polls this after autoplay to decide whether to fall back to
   * muted playback + a "Tap to unmute" pill.
   */
  isAudioBlockedSuspended(): boolean {
    if (this.streamWrapper) return false;
    if (this.disableAudio) return false;
    return this.audioRenderer.isBlockedSuspended();
  }

  /**
   * True once the shared AudioContext has been unlocked at any point this
   * session. A subsequent suspended state (e.g. right after init() on an
   * auto-advanced track) is then just a resume in flight that will recover, so
   * the element waits it out instead of flashing the unmute pill.
   */
  wasAudioContextActivated(): boolean {
    if (this.disableAudio) return false;
    return this.audioRenderer.wasEverActivated();
  }

  /** True when audio-only (data-saver) mode is active. */
  isAudioOnly(): boolean {
    return this._audioOnly;
  }

  /**
   * True when the playhead has passed the end of the video track in a file
   * whose audio runs on past it (see _videoTailStart). The picture is finished
   * — the last frame stays on screen — so anything that judges playback by
   * frames arriving has to stop judging here: for the rest of the file the
   * sound IS the playback.
   */
  isPastVideoEnd(): boolean {
    return this.isInAudioOnlyTail();
  }

  /**
   * Toggle audio-only (data-saver) mode at runtime. On the demuxer path the
   * processLoop stops decoding video (CPU saving) — re-enabling re-seeks to
   * recover a keyframe and resume video in sync. Adaptive streams drop/restore
   * video renditions via a reload (config.audioOnly), so this only flips the
   * flag for them; the caller (MoviElement) owns that reload.
   */
  setAudioOnly(enabled: boolean): void {
    if (this._audioOnly === enabled) return;
    this._audioOnly = enabled;
    // Captions are not part of the picture, and they are the one thing on
    // screen that still has to keep time while it is gone.
    this.videoRenderer?.setPictureSuspended(enabled);
    if (this.streamWrapper) {
      // Adaptive streams: the wrapper picks an audio-only / smallest-video
      // variant live (no reload, so the stream — and its LIVE state — survives).
      (this.streamWrapper as any).setAudioOnly?.(enabled);
      return;
    }

    // Separate audio drives playback independently of the main (video) demux
    // loop — either the native <audio> element OR the WASM split-audio demuxer.
    // Either way, audio-only can stop the main loop entirely (video body stops
    // downloading + decoding) while audio keeps playing on its own path.
    const splitSource = !!this.audioDemuxer;

    if (enabled) {
      // Freeze the video surface cleanly — drop queued + on-screen frames so the
      // UI can swap to the album-art / strip view without a stale last frame.
      if (this.videoRenderer) this.videoRenderer.clearQueue();
      if (splitSource) {
        // Split source: stop the MAIN (video) demux loop so video stops
        // decoding. Audio keeps playing on its own — the native <audio>
        // element, or (WASM split) the separate audioProcessLoop, which is
        // driven by audioAnimationFrameId and is untouched here.
        // (Doing this live — never via a reload — avoids tearing down the WASM
        // context while a read is in flight, which crashes with an OOB.)
        if (this.animationFrameId !== null) {
          cancelAnimationFrame(this.animationFrameId);
          this.animationFrameId = null;
        }
        this.stopPauseBuffering();
        // Stopping the demux loop halts video DECODE, but it does NOT stop the
        // download: HttpSource runs its own background stream (a full-file
        // prefetch that pulls the entire video body regardless of demux reads).
        // Pause that stream so audio-only actually stops downloading video —
        // otherwise a 200MB video keeps flowing while the user only wants
        // audio. The video source is separate from the audio source here, so
        // this never touches audio. Resumed when video is re-enabled below.
        this.setVideoSourcePrefetchPaused(true);
      }
      // Muxed source: keep the demux loop running (it still decodes the in-file
      // audio); the processLoop's _audioOnly check skips only the video decode.
    } else {
      // Re-enabling video. Resume the video source prefetch that audio-only
      // paused (idempotent no-op if it wasn't paused), then bring the picture
      // back to where the sound already is.
      //
      // This used to be a plain seek() to the playhead, and a seek serves BOTH
      // pipelines: the audio renderer's scheduled buffers were dropped and
      // rebuilt, so the sound broke at the exact moment the viewer asked for
      // the picture back. Nothing about audio needs to move here — it never
      // stopped. This is the same situation as returning from a backgrounded
      // tab, where video decode was skipped while audio played on, and it takes
      // the same video-only recovery.
      this.setVideoSourcePrefetchPaused(false);
      if (this.stateManager.getState() === "playing") {
        void this.resyncVideoToAudio("Audio-only → video");
      } else {
        // Paused: there is no audio clock to catch up to and no loop to
        // restart, so put a frame back on screen the ordinary way.
        this.seek(this.getCurrentTime()).catch((e) =>
          Logger.warn(TAG, "Audio-only → video resync seek failed", e),
        );
      }
    }
  }

  /**
   * True when the active source is not a FileSource (gate inactive), or when
   * the FileSource's initial preload pass has settled.
   */
  isFileSourcePreloadComplete(): boolean {
    if (!(this.source instanceof FileSource)) return true;
    return this.source.isPreloadComplete();
  }

  /**
   * Public accessor for the mobile-device flag (used by MoviElement to gate
   * UI behavior on mobile-only paths).
   */
  static isMobileDevice(): boolean {
    return MoviPlayer._isMobileDevice;
  }

  /**
   * Request WakeLock to prevent screen sleep
   */
  private async requestWakeLock(retry: number = 1): Promise<void> {
    // Check if WakeLock API is available
    if (!("wakeLock" in navigator)) {
      Logger.debug(TAG, "WakeLock API not available");
      return;
    }

    // The Screen Wake Lock API rejects (NotAllowedError) unless the page is
    // visible — don't even attempt while hidden. It's the wrong moment, not a
    // fault; handleVisibilityChange re-requests once the tab is shown.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      Logger.debug(TAG, "WakeLock skipped — page not visible");
      return;
    }

    try {
      // Release existing wakeLock if any
      if (this.wakeLock) {
        await this.releaseWakeLock();
      }

      // Request new wakeLock
      const wakeLock = await (navigator as any).wakeLock.request("screen");
      this.wakeLock = wakeLock;
      Logger.debug(TAG, "WakeLock acquired");

      // Handle wakeLock release (e.g., user switches tab, screen locks)
      wakeLock.addEventListener("release", () => {
        Logger.debug(TAG, "WakeLock released by system");
        this.wakeLock = null;
      });
    } catch (error) {
      this.wakeLock = null;
      Logger.warn(TAG, "Failed to acquire WakeLock", error);
      // Some devices reject the very FIRST request transiently even while
      // visible (a race as the page becomes fully interactive), then never
      // re-acquire for the rest of the session. Retry once shortly — but only
      // if we still want the lock (active playback, visible, none held).
      if (retry > 0) {
        setTimeout(() => {
          const st = this.stateManager.getState();
          if (
            !this.wakeLock &&
            (st === "playing" || st === "buffering") &&
            typeof document !== "undefined" &&
            document.visibilityState === "visible"
          ) {
            this.requestWakeLock(retry - 1);
          }
        }, 600);
      }
    }
  }

  /**
   * Re-acquire the screen wake lock if we should be holding one but aren't.
   * Called on the moments where the lock can quietly drop, or where a failed
   * first attempt gets a fresh chance: tab visibility changes and player
   * resizes (fullscreen / orientation / PiP transitions). Idempotent — no-op
   * when a lock is already held, playback isn't active, or the page is hidden.
   */
  private ensureWakeLock(): void {
    if (this.wakeLock) return; // already held
    const st = this.stateManager.getState();
    if (st !== "playing" && st !== "buffering") return; // not actively playing
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    this.requestWakeLock();
  }

  /**
   * Handle network recovery — re-seek to current position to restart cleanly
   */
  private handleNetworkOnline = (): void => {
    const state = this.stateManager.getState();
    if (state === "buffering" || state === "playing") {
      const currentTime = this.getCurrentTime();
      Logger.info(TAG, `Network online — re-seeking to ${currentTime.toFixed(2)}s for clean recovery`);
      this.seek(currentTime).catch((err) => {
        Logger.error(TAG, "Network recovery seek failed", err);
      });
    }
  };

  /**
   * Handle visibility change
   */
  /** Set by MoviElement when Document PiP is active */
  public isPiPActive: boolean = false;

  private handleVisibilityChange = async (): Promise<void> => {
    const isPlaying = this.stateManager.getState() === "playing" || this.stateManager.getState() === "buffering";

    if (document.visibilityState === "hidden" && isPlaying) {
      // On phones/tablets, skip background-playback gymnastics entirely. The OS
      // throttles/freezes hidden tabs aggressively (timers stop, AudioContext
      // suspends, recovery on resume is unreliable) — easier to just pause.
      // PiP is exempted; that's an explicit "keep playing" gesture.
      // UA check (not pointer:coarse) so Windows touch laptops aren't misclassified.
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const uaData = (navigator as any)?.userAgentData;
      const isMobile = uaData?.mobile === true ||
        /Android|iPhone|iPod|Mobile|Opera Mini|IEMobile|BlackBerry/i.test(ua) ||
        // iPad on iOS 13+ reports as Mac — disambiguate via touch points
        (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
      // ...unless the page has explicitly asked for background playback. It is
      // opt-in, so the caller is taking on the unreliability described above;
      // the return path already handles the worst of it, pausing for a tap if
      // the AudioContext comes back stuck suspended.
      if (isMobile && !this.isPiPActive && !this._backgroundPlay) {
        this.pause();
        return;
      }

      // Tab went to background — use Worker timer (Safari throttles setInterval to 1s+)
      this.isBackgrounded = true;

      // Background timer drives processLoop to keep audio flowing while hidden.
      // For audio-less content (no audio track or audio disabled) without PiP,
      // video decode is skipped AND there's no audio to drive — running the loop
      // would just race the demuxer to EOF (no backpressure → eofReached=true →
      // foreground recovery returns early → video stuck on resume).
      // Count split (separate-URL) audio too — its track lives in audioDemuxer,
      // not the main trackManager, so without this the timer never starts for
      // split audio and its rAF-driven decode loop dies the moment the tab hides
      // (audio stops seconds after backgrounding).
      const hasAudio =
        (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
        !this.disableAudio;
      if (hasAudio || this.isPiPActive) {
        this.startBackgroundTimer();
      }

      // In background (not PiP), stop video presentation and clear queue
      // to prevent frame accumulation that blocks audio demuxing via backpressure.
      // At 60fps, the queue fills in ~1.7s and starves audio completely.
      if (!this.isPiPActive && this.videoRenderer) {
        this.videoRenderer.stopPresentationLoop();
        this.videoRenderer.clearQueue();
      }

      // Resume AudioContext if suspended
      if (this.audioRenderer) {
        (this.audioRenderer as any).audioContext?.resume?.().catch(() => {});
      }
    } else if (document.visibilityState === "visible") {
      // Tab visible again — stop background timer, RAF takes over
      this.isBackgrounded = false;
      this.stopBackgroundTimer();

      // The system drops the wake lock whenever the tab hides; now that we're
      // visible again, re-acquire it (idempotent, gated on active playback).
      this.ensureWakeLock();

      if (isPlaying) {
        // Open the underrun-stall grace window: the decode loop was throttled
        // in background, so an underrun right now is transient and self-heals.
        this._foregroundRecoveryAt = performance.now();
        // Same window for the audio duck: the recovery's video-decoder flush +
        // re-seek briefly starves audio, and ducking there would mute it the
        // instant the user returns (reads as "the audio stopped").
        this.audioRenderer?.suppressDuckFor(3000);
        // Resume AudioContext if needed. On mobile after long background the
        // browser may keep it suspended (autoplay policy — prior gesture has
        // expired). If resume doesn't actually move us back to "running",
        // there's no point pretending playback is live: pause cleanly so the
        // UI shows the play button and the user can tap to resume.
        const audioCtx = (this.audioRenderer as any)?.audioContext as AudioContext | undefined;
        if (audioCtx) {
          try { await audioCtx.resume(); } catch {}
          if (audioCtx.state === "suspended" && !this.muted && !this.disableAudio) {
            Logger.warn(TAG, "AudioContext stuck suspended after foreground — pausing for user tap");
            this.pause();
            return;
          }
        }

        if (!this.isPiPActive) {
          await this.resyncVideoToAudio("Foreground recovery");
        } else {
          // PiP was active — just restart processLoop, video was rendering in PiP
          this.processLoop();
        }

        // Re-acquire once playback has settled back in — idempotent, so it's a
        // no-op if ensureWakeLock above already got it.
        setTimeout(() => this.ensureWakeLock(), 500);
      }
    }
  };

  /**
   * Bring the PICTURE back to where the sound already is, without touching the
   * sound.
   *
   * Used wherever video decode was stopped while audio kept running — a
   * backgrounded tab, and the audio-only toggle being switched back off. An
   * ordinary seek() would serve both, but it re-seeks the audio too: the
   * renderer's scheduled buffers are dropped and rebuilt, which is a hole in
   * the sound at the exact moment the viewer asked for the picture back. Here
   * only the video decoder is flushed and only the demuxer is repositioned;
   * the audio decoder, the renderer and everything it has already scheduled are
   * left alone, and the re-demuxed audio packets that were already played are
   * skipped by seekTargetTime.
   */
  private async resyncVideoToAudio(reason: string): Promise<void> {
    // Flushing the video decoder and re-seeking empties the queue by design, so
    // the stall that may follow is this call's, not the link's.
    this._lastVideoCatchUpAt = performance.now();
    // clock.getTime() falls back to wall-clock when the audio output is
    // suspended in background, so it can race far ahead of the audio that has
    // actually been rendered. Resolve the real audio position from the
    // AudioRenderer's clock / buffer end, and fall back to the wall clock when
    // there is no audio at all.
    const audioClock = this.audioRenderer?.getAudioClock() ?? -1;
    const audioBufferEnd = this.audioRenderer?.getMaxScheduledMediaTime() ?? 0;
    const audioTime =
      audioClock >= 0
        ? audioClock
        : audioBufferEnd > 0
          ? audioBufferEnd
          : this.clock.getTime();
    Logger.debug(TAG, `${reason}: video-only seek to ${audioTime.toFixed(2)}s`);

    // "Video-only" is the whole point of this recovery — and the one thing a
    // binding does not allow. The sound is asked to carry on while the picture
    // is re-fetched and re-decoded, which on a healthy link is a blink and on a
    // failing one is the complaint itself: audio-only switched back to video,
    // the video would not fetch, the spinner came up, and the sound played
    // straight through it without ever waiting for the picture.
    //
    // Worse, this is the one recovery that can take the pipeline with it. It
    // cancels the loop below and then blocks on demuxer.seek(); if that seek
    // never lands — a link that died in the same moment — processLoop is never
    // restarted, and processLoop is where stall detection, the resume gate and
    // the demux timeout all live. Read off the session this came from: 5,628
    // further log lines, not one buffering event, the sound running on over a
    // picture that stopped at 42s.
    //
    // So hold, but LATE. Holding up front costs the case that works: the whole
    // catch-up is normally a few hundred milliseconds of already-buffered
    // decode, and stopping the sound for it turned a switch nobody noticed into
    // a spinner — and, because the ABR reads any buffering as the rung failing,
    // into a walk down the whole ladder. Give the picture its moment, and hold
    // only if it doesn't arrive: past this, the sound is running away from a
    // catch-up that is not catching up, which is the thing a binding forbids.
    let held = false;
    const holdIfStillWaiting = () => {
      if (this._destroyed || this.seekSessionId !== mySessionId) return;
      if (!this.stateManager.is("playing")) return;
      const bound =
        this._bindAV &&
        !this.disableAudio &&
        (!!this.audioDemuxer || !!this.trackManager.getActiveAudioTrack());
      if (!bound) return;
      held = true;
      Logger.info(
        TAG,
        `${reason}: the picture is still coming — holding sound and clock for it`,
      );
      this.wasPlayingBeforeRebuffer = true;
      this._bufferingEntryTime = performance.now();
      // Our own doing, not a starved pipeline: the resume gate lets go on
      // readiness instead of serving the cushion meant for a decoder that fell
      // behind, and the ABR knows not to read it as the rung failing.
      this._bufferingSelfInflicted = true;
      this.stateManager.setState("buffering");
      this.clock.pause();
      this.audioRenderer?.suspendForBuffering();
      // Down so the catch-up's frames ACCUMULATE — that queue is what the
      // resume gate measures before it starts the two together again.
      this.videoRenderer?.stopPresentationLoop();
    };

    // Cancel any in-flight processLoop to avoid demux conflicts during seek
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    const mySessionId = ++this.seekSessionId;
    const holdTimer = setTimeout(
      holdIfStillWaiting,
      MoviPlayer.RESYNC_HOLD_MS,
    );
    // Release a superseded seek's video-sync flag (this recovery seek is
    // filter-only and owns its own resume) so the pipeline can't strand in
    // a permanent wait — see notifySeekCompletion's superseded branch.
    this.waitingForVideoSync = false;

    try {
      // Let a read already inside the demuxer land before seeking it — the
      // same wait seek() and the rendition swap do. Cancelling the rAF stops
      // the NEXT pass, not a readPacket that Asyncify has suspended mid-call,
      // and a seek issued over that read takes its pending slot: the read's
      // bytes then arrive to "No pending read to fulfill", the readPacket never
      // resolves, and demuxInFlight holds the whole pipeline until the demux
      // timeout. Measured right after a hard 8K → 4K swap, where this catch-up
      // fires by design: a 35s freeze while the source kept filling for nobody.
      let guard = 0;
      while (this.demuxInFlight && guard++ < 100) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (this.seekSessionId !== mySessionId) {
        clearTimeout(holdTimer);
        return; // Superseded
      }

      // Flush video decoder only — audio decoder and renderer untouched
      if (this.videoDecoder) {
        await this.videoDecoder.flush();
        this.dropVideoReadAhead();
      }
      if (this.videoRenderer) {
        this.videoRenderer.clearQueue();
      }

      if (this.seekSessionId !== mySessionId) return; // Superseded

      // Reset EOF flag — demuxer is being repositioned. For audio-less
      // video, background processLoop may have raced to EOF; without this
      // reset, processLoop would early-return and playback stalls.
      this.eofReached = false;
      this._eofPictureDrainSince = 0;
    this._eofFlushRequested = false;
      this.eofSince = 0;

      // Seek demuxer to nearest keyframe before current audio position
      if (this.demuxer) {
        await this.demuxer.seek(audioTime + this.startTime);
      }
      // The blocking part is behind us — whatever happens now, the pipeline is
      // moving again, so the hold has nothing left to protect against.
      clearTimeout(holdTimer);

      if (this.seekSessionId !== mySessionId) return; // Superseded

      // Re-anchor the wall clock to audio. While backgrounded the wall
      // clock advanced freely while audio output was suspended; without
      // this re-sync, getTime() will continue reporting the inflated
      // value and Clock's drift correction will snap the wall clock
      // back at 50%/sample, causing time-update jitter on resume.
      this.clock.seek(audioTime + this.startTime);

      // Skip pre-target packets: use audio buffer end (not clock time) so
      // already-scheduled audio isn't re-decoded — prevents fast-forward sound.
      this.seekTargetTime = Math.max(audioTime + this.startTime, audioBufferEnd);
      // …but the PICTURE rejoins where the sound is, not where its schedule
      // ends. See _videoResumeTarget.
      this._videoResumeTarget = audioTime + this.startTime;
      this._videoCatchUpStartedAt = performance.now();
      this.seekingToKeyframe = true;
      this.seekingToKeyframeStartTime = performance.now();
      this.seekKeyframeScanned = 0;
      this.seekCraSeen = 0;
      this.videoChainBrokenUntilKeyframe = false;
      this.videoSkipRaslAfterChainCra = false;

      // Restart video pipeline. If the hold went up while we were waiting, the
      // presentation loop stays down: the resume gate is measuring the queue
      // now, and a loop running through that would consume each frame as it
      // landed and leave the gate with nothing to find.
      if (this.videoRenderer && !held) {
        this.videoRenderer.startPresentationLoop();
      }
      this.processLoop();
    } catch (err) {
      clearTimeout(holdTimer);
      Logger.error(TAG, `${reason} failed`, err);
      // Fall back to processLoop restart so playback doesn't stall
      this.processLoop();
    }
  }

  /**
   * Start background timer using Web Worker (Safari-safe, not throttled)
   */
  /**
   * Make sure the hidden-tab pump is running, whatever route got us playing.
   *
   * While the tab is hidden rAF is throttled to nothing, so the audio loop —
   * which runs on rAF — does not tick and the renderer is handed nothing to
   * play. The Worker timer is what keeps it fed. play() already starts it, but
   * play() is not the only way playback begins: a seek completing resumes
   * straight into "playing", and that is exactly how the next track starts
   * after a background auto-advance. Read off a real session's log — state
   * playing, clock started, "AudioRenderer Playing … state: running", and then
   * not one decoded packet until the viewer came back.
   */
  private ensureBackgroundPump(): void {
    if (!this.isBackgrounded || this.isPiPActive) return;
    // Split (separate-URL) audio's track is not in the main trackManager, so
    // count its demuxer too — same reason handleVisibilityChange does.
    const hasAudio =
      (!!this.trackManager.getActiveAudioTrack() || !!this.audioDemuxer) &&
      !this.disableAudio;
    if (hasAudio) this.startBackgroundTimer();
  }

  private startBackgroundTimer(): void {
    if (this.backgroundWorker || this.backgroundIntervalId) return;
    Logger.debug(TAG, "Starting background playback timer");

    try {
      // Create inline Worker — not throttled in background tabs
      const blob = new Blob([`
        let id = null;
        self.onmessage = (e) => {
          if (e.data === 'start') {
            id = setInterval(() => self.postMessage('tick'), 16);
          } else if (e.data === 'stop') {
            clearInterval(id);
            id = null;
          }
        };
      `], { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));
      this.backgroundWorker = worker;
      worker.onmessage = () => this.backgroundTick();
      // A worker that fails to LOAD does not throw — the constructor returns an
      // object and the failure arrives later as an error event, so the catch
      // below never ran and neither did its fallback. What was left was a
      // worker that would never tick and an `if (this.backgroundWorker) return`
      // guard saying the pump was running. Safari does exactly this: a
      // cross-origin-isolated page (which this one is — SharedArrayBuffer needs
      // COOP/COEP) refuses a blob: worker, logging "Cannot load blob:… due to
      // access control checks". So the hidden tab had no pump at all: rAF is
      // throttled to nothing there, and the sound stopped as soon as the
      // buffered second or two ran out.
      worker.onerror = () => {
        Logger.warn(
          TAG,
          "Background worker failed to load — falling back to setInterval",
        );
        try { worker.terminate(); } catch {}
        if (this.backgroundWorker === worker) this.backgroundWorker = null;
        this.startBackgroundTimerFallback();
      };
      worker.postMessage("start");
    } catch {
      // Worker not available at all (constructor threw).
      Logger.debug(TAG, "Worker unavailable, using setInterval fallback");
      this.startBackgroundTimerFallback();
    }
  }

  /**
   * The pump without a worker. Throttled in a hidden tab (Safari clamps it to
   * about a second), which is far worse than a worker tick — but a tick a
   * second still decodes ahead and keeps the sound alive, where nothing at all
   * ends it.
   */
  private startBackgroundTimerFallback(): void {
    if (this.backgroundIntervalId || this._destroyed) return;
    // Only while the pump is still wanted — the load error can land after the
    // tab came back, and the visibility handler has stopped the timer by then.
    // (PiP is deliberately not excluded: the hidden-tab-with-PiP case starts
    // this pump too.)
    if (!this.isBackgrounded) return;
    this.backgroundIntervalId = window.setInterval(
      () => this.backgroundTick(),
      16,
    );
  }

  /**
   * One background-timer tick (Worker or setInterval). Drives decode while the
   * tab is hidden and rAF is throttled.
   */
  private backgroundTick(): void {
    const state = this.stateManager.getState();
    if (state !== "playing" && state !== "buffering") return;
    if (this.audioDemuxer) {
      // Split (separate-URL) audio: keep the audio decoding — its own loop runs
      // on rAF, which is throttled while hidden (this is what stalled it). The
      // video body isn't shown in the background, so skip its decode entirely to
      // avoid piling frames into a queue nothing is draining — except in PiP,
      // where the video IS visible in the PiP window.
      this.pumpSplitAudio();
      // A track finishing while backgrounded must still auto-advance (music).
      this.maybeEndSplitAudio();
      if (this.isPiPActive) this.processLoop();
    } else {
      // Muxed: processLoop decodes the in-file audio inline, so it's all we need.
      this.processLoop();
    }
    if (this.isPiPActive && this.videoRenderer) {
      (this.videoRenderer as any).presentationLoop?.();
    }
  }

  /**
   * Stop background timer
   */
  private stopBackgroundTimer(): void {
    if (this.backgroundWorker) {
      this.backgroundWorker.postMessage("stop");
      this.backgroundWorker.terminate();
      this.backgroundWorker = null;
      Logger.debug(TAG, "Background worker stopped");
    }
    if (this.backgroundIntervalId !== null) {
      clearInterval(this.backgroundIntervalId);
      this.backgroundIntervalId = null;
    }
  }

  /**
   * Start pause-time buffering: demux packets while paused so that
   * resume/seek within buffered area is near-instant (YouTube-like behavior).
   * Stashes packets into pendingPrebufferPackets without decoding.
   */
  private startPauseBuffering(): void {
    if (this.pauseBufferTimerId !== null) return;
    if (!this.demuxer || this.eofReached) return;
    // Only for HTTP sources — local files are already fully available
    if (this.source instanceof FileSource) return;

    Logger.debug(TAG, "Starting pause-time buffering");
    this.pauseBufferTimerId = window.setInterval(() => {
      this.pauseBufferTick();
    }, MoviPlayer.PAUSE_BUFFER_INTERVAL_MS);
  }

  private stopPauseBuffering(): void {
    if (this.pauseBufferTimerId !== null) {
      clearInterval(this.pauseBufferTimerId);
      this.pauseBufferTimerId = null;
      Logger.debug(TAG, "Stopped pause-time buffering");
    }
  }

  private pauseBufferTick = async () => {
    // Guard: only buffer while actually paused
    if (this.stateManager.getState() !== "paused") {
      this.stopPauseBuffering();
      return;
    }
    // Don't interfere with active WASM operations
    if (this.demuxInFlight || !this.demuxer) return;
    if (this.eofReached) {
      this.stopPauseBuffering();
      return;
    }

    // Check if we've buffered enough
    const stashedCount = this.pendingPrebufferPackets.length;
    if (stashedCount >= MoviPlayer.PAUSE_BUFFER_MAX_PACKETS) {
      Logger.debug(TAG, `Pause buffer full: ${stashedCount} packets stashed`);
      this.stopPauseBuffering();
      return;
    }

    // Check audio/video targets
    let audioDuration = 0;
    let videoFrames = 0;
    const activeVideo = this.trackManager.getActiveVideoTrack();
    const activeAudio = this.trackManager.getActiveAudioTrack();
    for (const pkt of this.pendingPrebufferPackets) {
      if (activeVideo && pkt.streamIndex === activeVideo.id) {
        videoFrames++;
      } else if (activeAudio && pkt.streamIndex === activeAudio.id) {
        audioDuration += pkt.duration ?? 0;
      }
    }

    // Only require targets for tracks that actually exist. A video-only or
    // audio-only stream would otherwise never satisfy the AND check, so the
    // loop ran until the 3000-packet safety cap (~30s of demux work) — which
    // shows up as a long burst of "Read: served from full-file cache" log
    // spam after pause.
    const videoTargetMet = !activeVideo || videoFrames >= MoviPlayer.PAUSE_BUFFER_VIDEO_FRAMES;
    const audioTargetMet = !activeAudio || audioDuration >= MoviPlayer.PAUSE_BUFFER_AUDIO_SECONDS;
    if (videoTargetMet && audioTargetMet) {
      Logger.debug(TAG, `Pause buffer targets met: audio=${audioDuration.toFixed(1)}s, video=${videoFrames} frames`);
      this.stopPauseBuffering();
      return;
    }

    try {
      this.demuxInFlight = true;
      this.demuxInFlightStartTime = performance.now();

      // Read a small burst of packets
      const burstSize = 10;
      for (let i = 0; i < burstSize; i++) {
        if (this.stateManager.getState() !== "paused") break;
        if (this.pendingPrebufferPackets.length >= MoviPlayer.PAUSE_BUFFER_MAX_PACKETS) break;

        // Don't push the demuxer past what HttpSource already holds — the next
        // read would otherwise trigger startStream() at the new offset, which
        // resets the sliding window and evicts already-buffered earlier bytes.
        // Pause-time buffering must never request bytes the network hasn't
        // delivered yet.
        if (this.source instanceof HttpSource && !this.source.isFullyCached()) {
          const pos = this.source.getPosition();
          const end = this.source.getBufferedEnd();
          // Keep ~1MB margin so an in-progress demuxer read doesn't straddle
          // the boundary and still trigger a refetch.
          if (pos >= end - 1024 * 1024) {
            this.stopPauseBuffering();
            break;
          }
        }

        const packet = await this.demuxer.readPacket();
        if (!packet) {
          this.eofReached = true;
          break;
        }

        // Only stash packets for active tracks
        if (this.trackManager.isActiveStream(packet.streamIndex)) {
          this.pendingPrebufferPackets.push(packet);
        }
      }
    } catch (e) {
      Logger.error(TAG, "Pause buffer demux error", e);
    } finally {
      this.demuxInFlight = false;
    }
  };

  /**
   * Release WakeLock
   */
  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        Logger.debug(TAG, "WakeLock released");
      } catch (error) {
        Logger.warn(TAG, "Failed to release WakeLock", error);
        this.wakeLock = null;
      }
    }
  }

  /**
   * Get buffered time in seconds
   * Returns the furthest time position that has been buffered
   */
  getBufferedTime(): number {
    if (this.streamWrapper) {
      return this.streamWrapper.getBufferEndTime();
    }

    if (!this.mediaInfo || !this.source) {
      return 0;
    }

    const duration = this.mediaInfo.duration;
    if (duration <= 0) {
      return 0;
    }

    // Audio-only: the bar has to answer for the AUDIO, since that is the only
    // thing still being fetched. The video source's prefetch is paused by this
    // very mode, so its read cursor and its window cannot move — the forward
    // delta the maths below computes is frozen, and `currentTime + a constant`
    // is a bar that grows only because the playhead does. That is exactly what
    // it looks like: a buffer that tracks the progress instead of leading it.
    //
    // A linear byte→time map is honest for audio in a way it is not for video:
    // an AAC/Opus track holds its bitrate, so bytes and seconds stay in step.
    if (this._audioOnly && this.audioSource instanceof HttpSource) {
      const audio = this.audioSource;
      if (audio.isFullyCached()) return duration;
      const size = audio.getKnownSize();
      const end = audio.getBufferedEnd();
      if (size > 0 && end > 0) {
        return Math.min(duration, (end / size) * duration);
      }
    }

    // For HttpSource, report the buffered-end *relative* to the source's
    // real read cursor. Converting both endpoints to time via linear ratio
    // fails on VBR (seek byte offset ≠ linear(seek time)). Instead, use the
    // byte delta between buffered-end and the source's last-read position
    // — both are real byte offsets — and apply linear conversion only to
    // that small delta, added to the accurate currentTime.
    //
    // Pause-time buffering decouples the demuxer cursor from the playback
    // clock (demuxer keeps reading ahead while currentTime is frozen),
    // which causes forwardBytes to shrink and the bar to walk backward.
    // Clamp monotonically: the buffered-end never moves backward except on
    // seek (where lastBufferedTime is reset elsewhere).
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      // Small files fully cached in memory should report the entire
      // duration as buffered. The byte-delta math below underreports
      // for VBR content (e.g., a high-bitrate intro consumes more bytes
      // than its share of duration, so currentBytes/fileSize at low
      // currentTime is artificially high → forwardTime is artificially
      // low → bufferedTime = currentTime + forwardTime falls short of
      // duration even though every byte is in memory).
      if (this.source.isFullyCached()) {
        this.lastBufferedTime = duration;
        return duration;
      }
      const bufferedEndBytes = this.source.getBufferedEnd();
      if (bufferedEndBytes > 0) {
        const currentBytes = this.source.getPosition();
        // Downloaded to the last byte of the file: there is nothing left to
        // fetch, so the bar is full. The same VBR skew described above stops
        // the byte-delta maths from ever saying so — it leaves the bar a
        // sliver short of the end on a file that finished downloading minutes
        // ago, which reads as "still buffering" forever.
        // …but only when the window actually SPANS from here to the end. It
        // slides, and a container whose index lives at the tail — Matroska
        // cues, a trailing moov — sends it there during open: for that moment
        // the window ends at the last byte of a file it has read four
        // megabytes of, and this said the whole thing was buffered. Worse, it
        // said so into a monotonic latch, so a 45-minute file showed a full bar
        // from the first second and only told the truth again after a seek
        // reset the latch.
        // Measured against where the PLAYHEAD is, not where the demuxer's
        // cursor is: during the tail read they are the same byte, so comparing
        // the window to the cursor still calls a 4MB read of a 3.6GB file
        // "fully buffered". The playhead's offset is only an estimate — linear,
        // so VBR skews it — but the question here is coarse: is the window
        // somewhere near the beginning of what is left to play, or is it parked
        // at the far end of the file reading an index?
        const windowStart = this.source.getBufferedStart();
        const playheadBytes = (this.getCurrentTime() / duration) * this.fileSize;
        if (bufferedEndBytes >= this.fileSize && windowStart <= playheadBytes) {
          this.lastBufferedTime = duration;
          return duration;
        }
        const forwardBytes = Math.max(0, bufferedEndBytes - currentBytes);
        const forwardTime = (forwardBytes / this.fileSize) * duration;
        // Never past the end: the same skew can overshoot in the other
        // direction, and a bar wider than the track is its own small lie.
        const computed = Math.min(duration, this.getCurrentTime() + forwardTime);
        this.lastBufferedTime = Math.max(this.lastBufferedTime, computed);
        return this.lastBufferedTime;
      }
    }

    // For FileSource, the entire file is buffered
    if (this.source instanceof FileSource) {
      return duration;
    }

    // EncryptedHttpSource now extends HttpSource, so the branch above
    // handles its buffered-end reporting too.

    // HLS demuxer fallback: the SegmentStreamSource fetches segments on demand,
    // so its read cursor (getPosition = furthest byte read) sits ahead of the
    // playhead by the demuxer's prebuffer. Estimate the playhead's byte position
    // linearly and report the gap as buffered-ahead time.
    if (this.source instanceof SegmentStreamSource && this.fileSize > 0 && duration > 0) {
      const frontier = this.source.getPosition();
      const playheadBytes = (this.getCurrentTime() / duration) * this.fileSize;
      const forwardBytes = Math.max(0, frontier - playheadBytes);
      const forwardTime = (forwardBytes / this.fileSize) * duration;
      return Math.min(this.getCurrentTime() + forwardTime, duration);
    }

    return 0;
  }

  /**
   * Check if current source is HttpSource
   */
  isHttpSource(): boolean {
    return this.source instanceof HttpSource;
  }

  /**
   * Tune the active source's prefetch window. Value is megabytes — the
   * target "buffer ahead of playback" the source should try to maintain.
   * Honored by HttpSource (adjusts its sliding-window cap) and by
   * EncryptedHttpSource (scales PREFETCH_HIGH/LOW_WATER + cache cap).
   * Other source types are silently ignored.
   *
   * Wired to the `buffersize` element attribute so consumers can tune
   * memory vs. seek responsiveness at deploy time without forking.
   */
  setMaxBufferSize(megabytes: number): void {
    if (!(megabytes > 0) || !this.source) return;
    const src = this.source as SourceAdapter & {
      setMaxBufferSize?: (mb: number) => void;
    };
    if (typeof src.setMaxBufferSize === "function") {
      src.setMaxBufferSize(megabytes);
    }
  }

  /**
   * Get buffer start position in bytes (for HttpSource)
   * Returns -1 if not available or not HttpSource
   */
  getBufferStartBytes(): number {
    if (this.source instanceof HttpSource) {
      return this.source.getBufferStart();
    }
    return -1;
  }

  /**
   * Get buffer end position in bytes (for HttpSource)
   * Returns -1 if not available or not HttpSource
   */
  getBufferEndBytes(): number {
    if (this.source instanceof HttpSource) {
      return this.source.getBufferedEnd();
    }
    return -1;
  }

  /**
   * Get buffer start time in seconds (for HttpSource)
   * Converts buffer start bytes to time position using current read position as reference
   */
  /**
   * Where the current buffering run began, in media time — 0 after a load,
   * the seek target after a seek. Pair with getBufferedTime() to draw the
   * buffer bar as a real range: drawing it from 0 instead makes a seek to
   * 20:00 paint the whole first 20 minutes as buffered the moment you click,
   * when nothing there has been fetched.
   */
  getBufferedRangeStart(): number {
    return this.bufferedRangeStart;
  }

  getBufferStartTime(): number {
    if (
      !this.mediaInfo ||
      !this.source ||
      !(this.source instanceof HttpSource) ||
      this.fileSize <= 0
    ) {
      return 0;
    }

    const duration = this.mediaInfo.duration;
    // For HttpSource, convert buffer start bytes to time using stable linear estimation
    if (this.source instanceof HttpSource && this.fileSize > 0) {
      const bufferStartBytes = this.source.getBufferStart();
      const ratio = Math.min(1, bufferStartBytes / this.fileSize);
      return ratio * duration;
    }
    return 0;
  }

  /**
   * Lowest time a backward seek can SAFELY land in linear (non-range) playback.
   * The window starts at getBufferStartTime, but a seek's keyframe sits at a
   * lower byte than the linear time→byte estimate (GOP span + VBR), so seeking
   * right at the window edge usually reads just below it and fails. Pad the
   * start by a byte safety margin so the keyframe stays inside the RAM window.
   * Returns 0 for seekable (range-capable) or non-HTTP sources.
   */
  getSeekableStartTime(): number {
    if (
      !this.mediaInfo ||
      !(this.source instanceof HttpSource) ||
      this.fileSize <= 0 ||
      !this.source.isLinearMode()
    ) {
      return 0;
    }
    const MARGIN_BYTES = 96 * 1024 * 1024; // covers a keyframe-before-target gap
    const safeBytes = Math.min(this.fileSize, this.source.getBufferStart() + MARGIN_BYTES);
    return Math.min(
      this.mediaInfo.duration,
      (safeBytes / this.fileSize) * this.mediaInfo.duration,
    );
  }

  /**
   * Get buffer end time in seconds (for HttpSource)
   * Same as getBufferedTime but more explicit
   */
  getBufferEndTime(): number {
    return this.getBufferedTime();
  }

  /**
   * Get the source adapter (for checking buffer status, etc.)
   */
  getSource(): SourceAdapter | null {
    return this.source;
  }

  /**
   * Set log level
   */
  static setLogLevel(level: LogLevel): void {
    Logger.setLevel(level);
    // Also update FFmpeg log level for all active bindings
    updateAllBindingsLogLevel(level);
  }

  /**
   * Get the video element renderer (for faststart conversion access)
   * Returns null if not using MSE mode
   */
  /**
   * Check if video decoding is falling back to software
   */
  isSoftwareDecoding(): boolean {
    return this.videoDecoder ? this.videoDecoder.isSoftware : false;
  }

  /**
   * WHY the picture is being decoded on the CPU — see
   * MoviVideoDecoder.softwareReason. "hardware-refused" is a trade worth
   * offering the viewer; the other two are simply how this codec plays.
   */
  softwareDecodeReason(): "unmapped" | "no-webcodecs" | "hardware-refused" | null {
    return this.videoDecoder?.softwareReason ?? null;
  }

  /**
   * Is the CPU carrying the decode? True for the WASM decoder, for a browser
   * with no WebCodecs at all, and — the case that hid for a while — for a
   * WebCodecs decoder that had to drop `prefer-hardware` because the rung has
   * no hardware path. Chrome accepts AV1 1440p that way and decodes it on the
   * CPU; the ladder ceiling has to treat all three the same, or the rung sits
   * there with a full decode queue and the spinner up, never stepping down.
   */
  /**
   * Is the download finished — the whole file in hand, or everything up to the
   * end of the media already buffered?
   *
   * The ABR's every downshift reason is a statement about the LINK, and once
   * there is nothing left to fetch there is no link left in the picture. A
   * shrinking buffer then means only that the playhead is walking toward an end
   * that is already downloaded, which is what playback IS. Dropping a rung
   * there costs a switch and buys nothing: the bytes for the rung we would
   * leave are already on the machine, and the ones for the rung we would land
   * on are not.
   */
  private nothingLeftToFetch(): boolean {
    if (
      (this.source as { isFullyCached?: () => boolean } | null)?.isFullyCached?.() === true
    ) {
      return true;
    }
    const duration = this.getDuration();
    return duration > 0 && this.getBufferedTime() >= duration - 0.5;
  }

  /**
   * Everything a video decoder needs to be THE video decoder: frames into the
   * renderer's queue with the seek-target filter, errors out to the host, and
   * the keyframe-wait hold that keeps a mid-playback recovery out of the
   * buffering state.
   *
   * A method rather than a block in the constructor because a seamless quality
   * switch builds its next decoder BEFORE it owns the pipeline — it primes into
   * a private list of frames, and takes this wiring only at the swap. Wiring
   * that differed even slightly from the original would show up as a bug that
   * appears only after the first switch.
   */
  /**
   * Decode the incoming rendition PAST the playhead before anything is swapped,
   * so the changeover costs no frames.
   *
   * The old switch was seamless everywhere except the one place that shows: the
   * network prep overlapped, but the DECODE did not. The pipeline stopped, the
   * decoder flushed, every queued frame was thrown away, the decoder
   * reconfigured, and only then did the first packet of the new rendition go
   * in. What the viewer sees is the sum of those — a still frame under a
   * spinner, for as long as a fresh GOP takes.
   *
   * So a second decoder runs alongside the first, on its own demuxer, and
   * decodes until it holds frames the clock has not reached yet. Only then does
   * anything swap, and what swaps is a queue that already has the next quarter
   * second in it. The outgoing frames play out first (see spliceQueue), so the
   * seam is one frame following another at a new size.
   *
   * Two decoders exist at once for the length of the prime, which is the cost:
   * on a device that only has one hardware decoder the second will not
   * configure, and on a slow one the extra decode may cost the OLD rendition a
   * frame or two. Both end the same way — null, and the caller does the hard
   * switch it always did.
   *
   * Staging is bounded by the clock, not by the packet count: a frame the
   * playhead has already passed is closed the moment it arrives, so the window
   * held in memory is the lead below and never the whole seek-to-live gap. It
   * matters — at 8K a second of frames is not something to hold "just in case".
   */
  private async primeRendition(
    newDemuxer: Demuxer,
    newTrack: VideoTrack,
    newStartTime: number,
    prepDeadline: number,
    status: { exhausted: boolean; readInFlight?: Promise<unknown> },
  ): Promise<{ decoder: MoviVideoDecoder; frames: VideoFrame[] } | null> {
    const staged: VideoFrame[] = [];
    const mediaTime = (f: VideoFrame) => f.timestamp / 1_000_000 - newStartTime;
    const dropStale = () => {
      const floor = this.getCurrentTime() - 0.05;
      while (staged.length > 0 && mediaTime(staged[0]) < floor) {
        staged.shift()!.close();
      }
    };
    const discard = () => {
      for (const f of staged) f.close();
      staged.length = 0;
    };

    const dec = new MoviVideoDecoder(this.config.decoder === "software");
    const bindings = newDemuxer.getBindings();
    if (bindings) dec.setBindings(bindings);
    let decoderFailed = false;
    dec.setOnError(() => {
      decoderFailed = true;
    });
    dec.setOnFrame((frame) => {
      // Behind the playhead already — decoded only to build reference state.
      if (mediaTime(frame) < this.getCurrentTime() - 0.05) {
        frame.close();
        return;
      }
      staged.push(frame);
    });
    dec.setPlaybackRate(this.clock.getPlaybackRate());

    try {
      const extradata = newDemuxer.getExtradata(newTrack.id) ?? undefined;
      const configured = await dec.configure(
        newTrack,
        extradata,
        this.config.frameRate ?? 0,
      );
      if (!configured || decoderFailed) {
        discard();
        dec.close();
        return null;
      }
      // Priming holds two decoders open at once, and on a device with one
      // hardware decode session the SECOND one is the one that loses it — it
      // configures perfectly well and quietly comes up in software. Adopting
      // that would trade a visible switch for an invisible collapse to CPU
      // decode at the higher resolution, which is a far worse trade. The hard
      // path has no such contention: by the time it configures, the outgoing
      // decoder is closed and the hardware is free.
      if (dec.isSoftwareBacked && !this.videoDecoder?.isSoftwareBacked) {
        Logger.debug(
          TAG,
          "Seamless prime came up in software while the outgoing decoder is on hardware — hard switch instead",
        );
        discard();
        dec.close();
        return null;
      }

      // How far ahead to prime. Reaching the end of what the outgoing rendition
      // has queued would mean losing nothing at all, but that queue can hold
      // seconds and these are whole decoded frames — at 8K, seconds of them is
      // not memory to spend on a cosmetic. Capped, so a deep queue gives up its
      // tail and everything else is kept.
      const queued = this.videoRenderer?.queuedPtsRange ?? null;
      const target = Math.min(
        Math.max(
          this.getCurrentTime() + MoviPlayer.SEAMLESS_PRIME_LEAD_S,
          (queued?.last ?? 0) + 0.05,
        ),
        this.getCurrentTime() + MoviPlayer.SEAMLESS_PRIME_MAX_AHEAD_S,
      );

      // Its own budget, or whatever the whole prep has left — whichever runs
      // out first. The open may already have eaten most of it.
      const deadline = Math.min(
        performance.now() + MoviPlayer.SEAMLESS_PRIME_BUDGET_MS,
        prepDeadline,
      );
      let started = false;
      let fed = 0;
      for (;;) {
        if (decoderFailed || this._destroyed) break;
        if (performance.now() > deadline) {
          status.exhausted = true;
          break;
        }
        dropStale();
        const last = staged.length > 0 ? mediaTime(staged[staged.length - 1]) : -Infinity;
        if (last >= target && staged.length >= MoviPlayer.SEAMLESS_PRIME_MIN_FRAMES) {
          return { decoder: dec, frames: staged };
        }
        // The deadline above is checked at the TOP of each pass, which bounds a
        // slow DECODE but not a slow READ — and on the rung that needs this
        // most, the read is the whole wait. Unbounded, the 5s budget was worth
        // whatever a single readPacket felt like taking on a 1.2GB file.
        const read = newDemuxer.readPacket();
        const packet = await withDeadline(read, deadline - performance.now());
        if (packet === TIMED_OUT) {
          status.exhausted = true;
          // Still suspended inside the demuxer — which the hard path goes on
          // to seek and play from. It has to land first; see the swap.
          status.readInFlight = read.catch(() => undefined);
          break;
        }
        if (!packet) break; // EOF before we could get ahead
        if (packet.streamIndex !== newTrack.id) continue;
        // A decoder that has just configured needs a random-access point, and
        // the demuxer's seek landed on one — but a non-IDR open-GOP keyframe is
        // not one, and feeding it here would produce the corrupt frames the
        // main path spends its keyframe hunt avoiding.
        if (!started) {
          if (!packet.keyframe || !packet.isIdr) continue;
          started = true;
        }
        dec.decode(
          packet.data,
          packet.timestamp,
          packet.keyframe,
          packet.dts,
          packet.isIdr,
          packet.isRasl,
          packet.disposable,
        );
        // Frames come out asynchronously; without yielding, this loop would
        // feed the whole budget in before a single one arrived — and hold the
        // main thread away from the rendition that is still playing.
        if (++fed % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      Logger.debug(TAG, `Seamless prime failed: ${e}`);
    }
    discard();
    dec.close();
    return null;
  }

  private wireVideoDecoder(dec: MoviVideoDecoder): void {
    dec.setOnFrame((frame) => {
      // Background mode: drop video frames silently (audio keeps playing)
      // But keep frames if PiP is active (canvas is visible in PiP window)
      if (document.hidden && !this.isPiPActive) {
        frame.close();
        return;
      }

      // The next pass of a loop, decoded early. These belong to the START of
      // the file while the renderer is still showing the END of it, so they
      // cannot go in the queue — it is ordered by timestamp and would put them
      // in front of the tail. Hold them until the tail has played out.
      if (this._loopPrerolling) {
        // Keep every one. The cap belongs to the READ — it stops the demuxer
        // once there is enough — and closing frames on top of it punched a
        // hole in the new pass: the packets that made them had already moved
        // the cursor past, so nothing after the turn ever covered that
        // stretch. The picture held at the last primed frame for 137ms at
        // exactly the two-second mark, which is where 60 frames run out at
        // 30fps. What is kept beyond the cap here is only what was already in
        // flight when the read stopped.
        this._loopPrerollFrames.push(frame);
        return;
      }

      // Queue frames for smooth presentation with A/V sync
      // Allow processing if playing OR if we are seeking (waiting for sync)
      //
      // …and while BUFFERING, which is the state whose whole purpose is to
      // refill this queue. Leaving it out closed a loop with no way out of it:
      // buffering waits for the video queue to come back, and every frame
      // decoded to fill it was thrown away here because we were buffering. The
      // queue could only ever hold what survived from BEFORE the stall — and a
      // stall is declared on an empty queue, so it held nothing. Everything odd
      // in three sessions of logs is this: a bound wait that never once saw
      // `videoReady` true and always left on its 15s escape; the demuxer racing
      // flat-out through 14MB of file during a stall, because the renderer
      // never filled and never applied backpressure; a hold for the picture
      // that sat there while the picture was decoded and discarded a frame at a
      // time, until the viewer seeked by hand. The presentation loop is stopped
      // throughout buffering, so nothing here reaches the screen early — the
      // frames simply wait, which is what the resume gate is waiting to find.
      if (
        this.videoRenderer &&
        (this.stateManager.getState() === "playing" ||
          this.stateManager.getState() === "buffering" ||
          // Leaving buffering parks on "paused" for the length of an async
          // play(), and the decoder keeps handing frames over throughout —
          // see _resumeToPlayPending.
          this._resumeToPlayPending ||
          this.waitingForVideoSync ||
          // …and for the one frame a forced completion left owing. See
          // _pictureOwedFrom: without this the frames a paused seek was
          // waiting for arrive just after it gives up and are all dropped.
          this._pictureOwedFrom !== -1)
      ) {
        // A frame arriving while a seek waits for sync is that seek WORKING —
        // the decoder walking from the keyframe towards the target. Stamped
        // here, before the drop below, precisely because those dropped frames
        // are the evidence: they are the walk. The seek deadline reads this to
        // tell "the decoder is grinding through a long GOP" apart from "nothing
        // is coming", which is the only case the deadline is for.
        if (this.waitingForVideoSync) {
          this._seekFrameProgressAt = performance.now();
        }

        // IMPORTANT: Drop video frames before the seek target time
        // These frames are decoded to build decoder state (reference frames),
        // but we don't display them - we want accurate seeking to the target time
        const frameTime = frame.timestamp / 1_000_000; // Convert to seconds
        // A video-only resume overrides the shared target, which is parked at
        // the audio schedule's end for the audio path's sake — see
        // _videoResumeTarget.
        const gate =
          this._videoResumeTarget !== -1
            ? this._videoResumeTarget
            : this.seekTargetTime !== -1
              ? this.seekTargetTime
              // Nothing else is filtering, but an owed picture still must not
              // be paid with a frame from before the position asked for.
              : this._pictureOwedFrom;
        // CRITICAL: Check seekTargetTime !== -1 instead of >= 0 to support negative start times
        // Some media files have negative PTS offsets (e.g., startTime = -0.105s)
        if (gate !== -1 && frameTime < gate) {
          // Drop this frame, it's before our target time
          frame.close();
          return;
        }
        // Caught up. The gate stays OURS — opened, not handed back — and
        // seekTargetTime stays armed for the audio it is protecting: those
        // packets run seconds ahead of this frame and must not decode twice.
        if (this._videoResumeTarget !== -1) {
          this._videoResumeTarget = Number.NEGATIVE_INFINITY;
          // The picture is back — whatever it was waiting on, including a
          // stretch the decoder couldn't get through with the sound carrying
          // playback alone. See _soundCarryingAlone.
          if (this._soundCarryingAlone) {
            Logger.info(
              TAG,
              `Picture rejoined at ${frameTime.toFixed(1)}s`,
            );
            this._soundCarryingAlone = false;
            this._blackRecoverySeeks = 0;
          }
          this._pictureOwedFrom = -1;
          this.videoRenderer.queueFrame(frame);
          return;
        }

        // Video reached target! If a seek is awaiting sync, fire the
        // completion path. Otherwise the guard was set in filter-only
        // mode (first-play / post-prefetch resume) just to drop pre-target
        // frames produced by Open-GOP recovery — we just clear the guard
        // so subsequent frames flow through without re-entering this
        // branch (which would log a warn-spam every frame).
        if (this.seekTargetTime !== -1) {
          if (this.waitingForVideoSync) {
            Logger.debug(TAG, `onFrame: frameTime=${frameTime.toFixed(3)}s >= seekTargetTime=${this.seekTargetTime.toFixed(3)}s, calling notifySeekCompletion`);
            this.notifySeekCompletion(frameTime);
          } else {
            this.seekTargetTime = -1;
          }
        }

        this._pictureOwedFrom = -1;
        this.videoRenderer.queueFrame(frame);
      } else {
        frame.close();
      }
    });

    dec.setOnError((error) => {
      Logger.error(TAG, "Video decoder error", error);
      // On a source we KNOW is encrypted, this is where the clear lead ran out.
      // The decoder is telling the truth — it cannot decode these samples — but
      // "Decoding error" describes the symptom and hides the cause, and the
      // cause is one the embedder can act on. Say it plainly instead, and stop
      // pulling: the rest of the file is bytes we can never use, and reading it
      // to the end is what turned this into a hundreds-of-megabytes download.
      if (this._sourceIsEncrypted) {
        this.encryptedSourceGaveUp();
        return;
      }
      this.emit("error", error);
      // Note: Decoder now has built-in recovery, only pauses after MAX_ERRORS
    });

    // When the decoder enters its "skip non-keyframes until next IDR" recovery
    // during normal playback (decode-error recreate, e.g. high-bitrate 1080p
    // H.264 whose HW decoder throws an EncodingError on an IDR), we deliberately
    // do NOT flip into buffering. Per request: the clock and audio keep running
    // and the video simply holds its last frame until the next keyframe lands
    // (~1 GOP), then A/V sync catches the video up with a jump. The stall
    // detector is already suppressed across this window via
    // videoDecoder.isRecentlyRecovering(), so the empty video queue here is not
    // mistaken for a stall. Seeks are handled by the seek pipeline (suppressed
    // here via the state/sync guard).
    dec.onKeyframeWaitChange = (waiting) => {
      const state = this.stateManager.getState();
      // Track the hold so ABR doesn't misread the draining video buffer
      // (clock advancing, video frozen on last frame) as the rung failing.
      this._videoHoldingForKeyframe = waiting && state === "playing";
      if (state === "seeking" || this.waitingForVideoSync) return;
      if (this._videoHoldingForKeyframe) {
        Logger.debug(
          TAG,
          "Decoder waiting for keyframe mid-playback — staying in playing (audio/clock continue, video holds until next keyframe)",
        );
      }
    };
  }

  private decodingOnCpu(): boolean {
    if (webCodecsUnavailable()) return true;
    return this.videoDecoder ? this.videoDecoder.isSoftwareBacked : false;
  }

  /**
   * Does the software-decode ceiling apply to THIS rung?
   *
   * The ceiling exists because the CPU is carrying the decode — but a decoder is
   * chosen per CODEC, and a ladder is usually mixed. Applied to the whole ladder
   * it punished rungs that were never the problem: a 2160p AV1 with no hardware
   * path fell to the WASM decoder, and the correction took the whole ladder down
   * to 480p — past the 1080p H.264 rung sitting right there, which this machine
   * decodes in hardware without noticing. A rung of a different family is an
   * open question, and the decode-bound screen is what answers it; this cap has
   * nothing to say about it.
   *
   * Two cases keep the ceiling ladder-wide: no WebCodecs at all (then every
   * codec is our WASM decoder, family is irrelevant), and a rung whose codec the
   * ladder never declared (nothing to compare — stay conservative).
   */
  private softwareCeilingApplies(rungCodec?: string): boolean {
    if (webCodecsUnavailable()) return true;
    const family = codecFamily(rungCodec);
    const active = codecFamily(this.videoDecoder?.configuredCodec);
    if (!family || !active) return true;
    return family === active;
  }

  /**
   * Embedded cover art for the loaded source, decoded into an ImageBitmap.
   * Null when the source has no attached_pic stream (regular video files,
   * audio files without artwork). Caller MUST NOT close() the bitmap — it
   * is owned by the player and released on destroy() / next load.
   */
  getCoverArt(): ImageBitmap | null {
    return this.coverArt;
  }

  /**
   * Extract embedded cover art once at load and emit a "coverart" event.
   *
   * Runs entirely in a short-lived, isolated thumbnail-style WASM context
   * — the same isolated-demuxer machinery the seek-bar previews use — so
   * reading the artwork packet never moves the MAIN demuxer's file
   * position and therefore can't disturb playback or seeking. Done
   * exactly once (artwork is static), then the context is torn down.
   *
   * Deliberately does NOT surface attached_pic through a new C/WASM
   * StreamInfo field or export: that shifts the WASM memory layout and
   * trips a latent FFmpeg audio overflow into a production-only OOB (see
   * project memory "Album Art Crashes WASM"). Using only the existing
   * thumbnail read/packet exports keeps the WASM binary byte-identical.
   */
  private async extractCoverArt(): Promise<void> {
    // Opt-in via the `thumb` attribute (maps to config.enablePreviews).
    // Without it the audio source just shows the bare strip — no artwork,
    // and no isolated WASM context is spun up at all.
    if (!this.config.enablePreviews) return;

    // Cover art only makes sense for an audio-led source: there must be an
    // audio track and NO real playable video (a real video file's frames
    // are the content, not artwork). getVideoTracks() already excludes the
    // still-image cover stream via the isLikelyCoverArt heuristic, so an
    // audio file with embedded art reports zero video tracks here.
    if (this.trackManager.getAudioTracks().length === 0) return;
    if (this.trackManager.getVideoTracks().length > 0) return;

    const picTracks = this.trackManager.getAttachedPicTracks();
    if (picTracks.length === 0) return;
    // Past this point an art track exists, so the UI is holding off the
    // audio-strip layout waiting for a bitmap. Emit a null "coverart" on every
    // failure exit so the element can stop waiting and fall back to the strip
    // instead of sitting on a blank surface forever.
    if (!this.source || this.fileSize <= 0) {
      this.emit("coverart", null);
      return;
    }

    try {
      // Demuxer owns the isolated-context read; we just turn the encoded
      // bytes into a bitmap and publish it.
      const data = await Demuxer.extractAttachedPicture(
        this.source,
        this.fileSize,
        this.config.wasmBinary,
      );
      if (!data || data.length === 0) {
        this.emit("coverart", null);
        return;
      }

      const codec = (picTracks[0].codec || "").toLowerCase();
      const mime =
        codec === "png"
          ? "image/png"
          : codec === "mjpeg" || codec === "jpeg" || codec === "jpg"
            ? "image/jpeg"
            : codec === "webp"
              ? "image/webp"
              : "image/*";
      // getPacketDataCopy already .slice()s into a fresh, non-shared
      // ArrayBuffer, so it's safe to hand straight to Blob.
      const blob = new Blob([data.buffer as ArrayBuffer], { type: mime });
      const bitmap = await createImageBitmap(blob);

      // Release the previous bitmap before stomping the reference — a stale
      // load → load sequence (playlist next-track) would otherwise leak GPU
      // memory until the next GC cycle.
      this.coverArt?.close?.();
      this.coverArt = bitmap;

      this.emit("coverart", bitmap);
      Logger.info(
        TAG,
        `Cover art extracted: ${bitmap.width}x${bitmap.height} (${codec || "image"})`,
      );
    } catch (err) {
      Logger.warn(TAG, "Cover art extraction failed", err);
      this.emit("coverart", null);
    }
  }

  /**
   * Destroy player and release resources
   */
  destroy(): void {
    Logger.info(TAG, "Destroying player");
    this._destroyed = true;
    // First, before any of the teardown below. Everything this player has in
    // flight — probes, subtitle segments, manifest fetches, ranged reads —
    // carries this signal, and the point of it is that they stop the moment the
    // player does rather than finishing into a void. The sources are closed
    // further down as well; that is belt and braces, not the mechanism.
    this._lifetimeAbort.abort();

    // Stop driving a host subtitle renderer, but DON'T destroy it — the renderer
    // is owned by whoever registered it (the element re-applies it to the fresh
    // player after a source change, so destroying it here would kill it mid-swap).
    // The registrar owns destroy(): the element does it on disconnect / on swap.
    this._stopSubtitleRenderLoop();
    this._customSubtitleRenderer = null;

    // Cancel a pending deferred preview warm-up.
    if (this._previewWarmTimer) {
      clearTimeout(this._previewWarmTimer);
      this._previewWarmTimer = null;
    }

    // Stop the ABR timer.
    if (this._abrTimer) {
      clearInterval(this._abrTimer);
      this._abrTimer = null;
    }
    this.cancelBlackFrameWatchdog();

    // Release WakeLock
    this.releaseWakeLock();

    // Stop playback
    this.clock.pause();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.stopBackgroundTimer();
    this.stopPauseBuffering();

    // A rendition switch caught mid-prep. Its source is downloading right now
    // and is not `this.source` yet, so nothing below would ever reach it.
    if (this._pendingSwitchDemuxer) {
      try { this._pendingSwitchDemuxer.close(); } catch {}
      this._pendingSwitchDemuxer = null;
    }
    if (this._pendingSwitchSource) {
      try { this._pendingSwitchSource.close(); } catch {}
      this._pendingSwitchSource = null;
    }

    // Tear down the split (separate-URL) WASM audio pipeline.
    this.stopAudioLoop();
    if (this.audioDemuxer) {
      this.audioDemuxer.close();
      this.audioDemuxer = null;
    }
    if (this.audioSource) {
      try {
        this.audioSource.close();
      } catch {}
      this.audioSource = null;
    }

    // Destroy the adaptive-streaming wrapper (HLS or DASH, via Shaka)
    if (this.streamWrapper) {
      this.streamWrapper.destroy();
      this.streamWrapper = null;
    }

    this.pendingPrebufferPackets = [];
    this.dropVideoReadAhead();

    // Close resources
    this.videoDecoder.close();
    this.audioDecoder.close();

    if (this.videoRenderer) {
      this.videoRenderer.destroy();
    }
    this.audioRenderer.destroy();

    // Close demuxer
    if (this.demuxer) {
      this.demuxer.close();
      this.demuxer = null;
    }

    // Cleanup external subtitles
    this.stopExternalSubtitles();
    this._externalSubCues = [];
    this._subtitleTracks = [];

    // Tear down the thumbnail (seek-preview) pipeline. It is a SECOND, fully
    // independent stack — its own isolated WASM module and FFmpeg context, its
    // own WebCodecs decoder, its own WebGL context, its own HTTP source — and
    // none of it was being released. A host that rebuilds the player per video
    // (the common pattern) therefore leaked one of each per video, and the
    // WebGL contexts are the sharp end: Chrome caps a page at ~16, after which
    // it starts killing the oldest — which may belong to the player on screen.
    this.destroyPreviewPipeline();

    // Close source
    if (this.source) {
      this.source.close();
      this.source = null;
    }

    // Clear cache
    this.cache.clear();

    // Clear track manager
    this.trackManager.clear();

    // Release cover art bitmap. close() is a no-op on platforms that
    // don't implement it (older Firefox); guard with optional call.
    this.coverArt?.close?.();
    this.coverArt = null;

    // Reset state
    this.stateManager.reset();
    this.mediaInfo = null;

    // Remove all listeners
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    window.removeEventListener("online", this.handleNetworkOnline);
    this.removeAllListeners();

    Logger.info(TAG, "Player destroyed");
  }
}
