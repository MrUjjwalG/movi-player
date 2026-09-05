import { Logger } from "./Logger";

const TAG = "LinkRate";

/**
 * Last measured link rate, so the opening pick doesn't have to buy the same
 * number twice.
 *
 * The pre-play probe used to spend a request and ~3MB measuring a rung it
 * often wasn't going to play. A rate measured minutes ago describes the same
 * link, and the confirm pass — which reads the head of the rung we DO open and
 * keeps those bytes — re-measures it for free on every load. Stale entries are
 * ignored rather than trusted: a link changes (wifi → cellular), and the first
 * load after that should measure again.
 *
 * The link belongs to the device, not to whatever is playing, so everything
 * that measures or needs it shares this one record: the multi-source pre-play
 * probe, and the adaptive engines, which otherwise each open on a blind guess
 * of their own (Shaka assumes 1 Mbps; dash.js ships lastBitrateCachingInfo but
 * in v5 that persists only language/codec, no bitrate). Whichever played last
 * teaches whichever plays next.
 */
const LINK_BPS_KEY = "movi:link-bps";
// Generous, because a clock is the WEAK test here: an estimate goes stale when
// the network changes, not when time passes. On the same wifi a day-old number
// is still true; one minute after switching to cellular it is a lie. The
// connection signature below is the real check; this is the fallback for
// browsers that don't expose one (Safari, Firefox).
const LINK_BPS_TTL_MS = 24 * 60 * 60 * 1000;
let sessionLinkBps = 0;
let sessionLinkBpsAt = 0;

type NetInfo = {
  effectiveType?: string;
  downlink?: number;
  addEventListener?: (t: string, fn: () => void) => void;
};

function netInfo(): NetInfo | undefined {
  return (navigator as unknown as { connection?: NetInfo }).connection;
}

/** What the link looks like right now — "4g/10" — or "" where unavailable. */
function connectionSignature(): string {
  const c = netInfo();
  if (!c) return "";
  const dl = typeof c.downlink === "number" ? Math.round(c.downlink) : "";
  return `${c.effectiveType || ""}/${dl}`;
}

// Switching networks mid-session invalidates the estimate immediately — no
// waiting for a TTL that was never measuring the right thing.
if (typeof navigator !== "undefined") {
  netInfo()?.addEventListener?.("change", () => {
    sessionLinkBps = 0;
    sessionLinkBpsAt = 0;
    try {
      localStorage.removeItem(LINK_BPS_KEY);
    } catch {
      /* nothing to clear */
    }
    Logger.info(TAG, "Connection changed — dropping the remembered link rate");
  });
}

export function loadPersistedLinkBps(): number {
  const sig = connectionSignature();
  if (
    sessionLinkBps > 0 &&
    Date.now() - sessionLinkBpsAt < LINK_BPS_TTL_MS &&
    sessionLinkSig === sig
  ) {
    return sessionLinkBps;
  }
  try {
    const raw = localStorage.getItem(LINK_BPS_KEY);
    if (!raw) return 0;
    const { bps, ts, sig: storedSig } = JSON.parse(raw) as {
      bps: number;
      ts: number;
      sig?: string;
    };
    if (!(bps > 0) || bps > LINK_BPS_SANE_MAX) return 0;
    if (Date.now() - ts > LINK_BPS_TTL_MS) return 0;
    // A signature we can read and that disagrees means a different network.
    // An absent one (either side) just falls back to the TTL.
    if (sig && storedSig && storedSig !== sig) return 0;
    return bps;
  } catch {
    return 0; // private mode / bad JSON — measure instead
  }
}

let sessionLinkSig = "";

/**
 * Where to start when nothing has been measured yet.
 *
 * A stored measurement wins — it is the only number that came from timing this
 * app's own bytes. Failing that, the browser's own estimate is a far better
 * answer than the smallest rung: a probe that comes up empty (a proxy that
 * bursts before it paces is where that happens) used to open on 144p over a
 * link that turned out to be tens of megabits.
 *
 * Deliberately NOT part of loadPersistedLinkBps(). That one means "what we
 * measured", and raiseLinkBps() compares against it — seeding it from the
 * browser would stop any real measurement below the estimate from ever being
 * stored.
 *
 * It is a floor, not a reading. `downlink` is recently observed application
 * throughput rounded to 25kbps, absent on Safari and Firefox, and on a fresh
 * link derived from the connection type rather than measured at all. Safe here
 * only because the caller confirms it: the pre-play confirm pass reads the head
 * of the rung it intends to open and steps down if the link cannot hold it.
 */
export function linkSeedBps(): number {
  const measured = loadPersistedLinkBps();
  if (measured > 0) return measured;
  const dl = netInfo()?.downlink;
  if (typeof dl !== "number" || !(dl > 0)) return 0;
  const bps = (dl * 1e6) / 8;
  return bps > LINK_BPS_SANE_MAX ? 0 : bps;
}

// No home link delivers this. Anything above it is a measurement artefact —
// a cache hit, a clock that barely moved — and remembering it would seed the
// next load's pick with a number nothing can live up to.
const LINK_BPS_SANE_MAX = 2_000_000_000;

/**
 * Record a measurement, replacing whatever was there.
 *
 * For a DEDICATED measurement only — the pre-play probe, which clears the proxy
 * burst and times a tail specifically to find out what the link can do. It
 * replaces rather than raises because a link that has genuinely slowed has to
 * be able to bring the number down.
 */
export function persistLinkBps(bps: number): void {
  if (!(bps > 0) || bps > LINK_BPS_SANE_MAX) return;
  sessionLinkBps = bps;
  sessionLinkBpsAt = Date.now();
  sessionLinkSig = connectionSignature();
  try {
    localStorage.setItem(
      LINK_BPS_KEY,
      JSON.stringify({ bps, ts: Date.now(), sig: sessionLinkSig }),
    );
  } catch {
    /* storage unavailable — the session value still holds */
  }
}

/**
 * Record a measurement only if it beats what's already known.
 *
 * For throughput observed WHILE PLAYING, which is a floor rather than a
 * capability: a CDN paces each stream to roughly its own bitrate, and once the
 * buffer is full the engine stops pulling at all, so a 40 Mbps link watching an
 * 8 Mbps rung measures about 8. Letting that replace the record would teach the
 * next load — and the pre-play probe that reads the same record — that the link
 * is a fifth of what it is, and every future pick would open lower for it.
 *
 * Raising is still worth doing: on a plain DASH/HLS source the probe never
 * runs, so an engine's own numbers are the only thing that will ever populate
 * the record. A floor that beats the stored value is real news; one that
 * doesn't tells us nothing we didn't have.
 *
 * The link-change listener and the signature check are what clear a number that
 * has stopped being true — not a paced reading from a stream that was never
 * trying to go faster.
 */
export function raiseLinkBps(bps: number): void {
  if (!(bps > 0) || bps > LINK_BPS_SANE_MAX) return;
  if (bps <= loadPersistedLinkBps()) return;
  persistLinkBps(bps);
}
