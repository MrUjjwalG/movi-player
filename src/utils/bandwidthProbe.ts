/**
 * A quick, standalone link-speed test.
 *
 * The naive "fetch a slice and time it" measures the wrong thing through a
 * caching/buffering proxy (movi-tube's `/api/stream/media`, a CDN edge, a
 * Service Worker): the FIRST couple of megabytes come out of the proxy's
 * read-ahead buffer almost instantly — 600+ MB/s bursts show up in the logs —
 * and only AFTER that does the stream throttle down to the real origin rate. A
 * probe that stops inside the burst reads a fantasy number and picks a rung the
 * link can't actually carry.
 *
 * So this streams the response and IGNORES the burst: it starts its stopwatch
 * only once `SKIP_BYTES` have already arrived, then times how long the next
 * `MEASURE_BYTES` take (or whatever lands before the wall-clock cap). That tail
 * is the sustained rate. It downloads a few MB at most and aborts the moment it
 * has its answer — never the whole file.
 */
export interface BandwidthProbeOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Bytes to discard as the proxy/CDN burst before measuring. */
  skipBytes?: number;
  /** Bytes to time after the burst for the sustained reading. */
  measureBytes?: number;
  /** Hard wall-clock cap (ms) so a very slow link still returns something. */
  timeoutMs?: number;
}

const DEFAULT_SKIP_BYTES = 2_500_000; // past the ~2 MB proxy read-ahead burst
const DEFAULT_MEASURE_BYTES = 1_500_000; // ~1.5 MB of real, throttled stream
const DEFAULT_TIMEOUT_MS = 6000;
/**
 * Ceiling for the "it arrived instantly" reading below. A cache hit is proof
 * the bytes are local, not proof the LINK is that fast — the rest of the file
 * may still have to stream — so the reading is capped at a rate that opens a
 * comfortable rung (1080p-ish) and lets the ABR climb from there on real
 * samples rather than on a number the network never earned.
 */
const INSTANT_HIT_CAP_BPS = 25_000_000;
/** How much recent download history to keep for the timed-out reading. */
const TRAIL_WINDOW_MS = 2500;

/**
 * Whether the browser served this URL from cache rather than the network.
 * `transferSize === 0` with a non-zero body is the Resource Timing signal for a
 * cache hit. Unknown (no entry, or the API missing) is treated as a network
 * fetch: the cap this gates only exists to hold cached bytes back from
 * advertising a link speed they never proved, and applying it to a genuinely
 * fast connection would cost real quality.
 */
function isFromCache(url: string): boolean {
  try {
    const entries = performance.getEntriesByName(
      new URL(url, location.href).href,
      "resource",
    ) as PerformanceResourceTiming[];
    const last = entries[entries.length - 1];
    return !!last && last.transferSize === 0 && last.decodedBodySize > 0;
  } catch {
    return false;
  }
}

/**
 * Measure sustained link throughput in BITS/second, or -1 if it couldn't get a
 * trustworthy reading (fetch failed, file too small to clear the burst, or the
 * measured window was too short to be meaningful). Never throws.
 */
export async function probeLinkBandwidth(
  url: string,
  opts: BandwidthProbeOptions = {},
): Promise<number> {
  const skipBytes = opts.skipBytes ?? DEFAULT_SKIP_BYTES;
  const measureBytes = opts.measureBytes ?? DEFAULT_MEASURE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wantBytes = skipBytes + measureBytes;

  // Our own timeout, combined with any caller signal, so a stalled link can't
  // hang the probe forever.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort);
  // Our own cap, told apart from a caller abort: hitting it is not a failure,
  // it just means the link is slow — and a slow link is precisely the reading
  // worth having. See the timed-out branch below.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const requestedAt = performance.now();
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${wantBytes - 1}`, ...(opts.headers || {}) },
      signal: ac.signal,
      // A link test answered from the cache measures the cache. It asks for the
      // head of the file, which is exactly what the player read first — so on
      // any source it had been playing, the answer came out of memory: 3404
      // Mbps, measured, on a link carrying 4-9, and the link notice concluded
      // the connection was fine.
      cache: "no-store",
    });
    if ((!res.ok && res.status !== 206) || !res.body) return -1;

    reader = res.body.getReader();
    let received = 0;
    let firstByteAt = 0; // time the first chunk arrived
    // Stopwatch state for the post-burst (sustained) window.
    let measureStart = 0;
    let measureStartBytes = 0;
    // A short trail of (time, bytes) marks, so a probe that runs out of clock
    // before clearing the burst can still time its most RECENT seconds — the
    // part of the download that is already past the proxy's read-ahead.
    const trail: Array<{ t: number; b: number }> = [];

    try {
      for (;;) {
        const { done, value } = await reader.read();
        const now = performance.now();
        if (done) break;
        if (!value) continue;
        if (firstByteAt === 0) firstByteAt = now;
        received += value.length;
        trail.push({ t: now, b: received });
        while (trail.length > 1 && now - trail[0].t > TRAIL_WINDOW_MS) trail.shift();

        // Arm the post-burst stopwatch the first time we cross the burst
        // boundary. Note the chunk that crosses it may carry bytes past the
        // boundary too — measuring from `received` here just means the window is
        // slightly conservative, which is fine.
        if (measureStart === 0 && received >= skipBytes) {
          measureStart = now;
          measureStartBytes = received;
          continue;
        }
        // Enough sustained data timed — return that rate.
        if (measureStart !== 0 && received - measureStartBytes >= measureBytes) {
          const seconds = (now - measureStart) / 1000;
          const bytes = received - measureStartBytes;
          if (seconds > 0) return (bytes / seconds) * 8;
        }
      }

    } catch (err) {
      // A caller cancelling is a real abort; our own clock running out is not.
      if (!timedOut) throw err;
    }

    // Stream ended (or timed out). Prefer the post-burst window if it gathered
    // a usable sample...
    const end = performance.now();
    if (measureStart !== 0) {
      const seconds = (end - measureStart) / 1000;
      const bytes = received - measureStartBytes;
      if (bytes >= 262144 && seconds >= 0.15) return (bytes / seconds) * 8;
    }
    // ...otherwise time the trail: the last few seconds of whatever did arrive.
    // On a slow link the 6s cap expires before the burst is even cleared, and
    // the whole-download rate below would then be mostly burst — a fantasy
    // number. The tail of the trail is real throttled stream, and having ANY
    // honest reading is what stops the player opening at 144p and climbing the
    // whole ladder in front of the viewer.
    if (trail.length >= 2) {
      const first = trail[0];
      const seconds = (end - first.t) / 1000;
      const bytes = received - first.b;
      if (bytes >= 131072 && seconds >= 0.5) return (bytes / seconds) * 8;
    }
    // ...otherwise fall back to the WHOLE-download rate. This is the fast-link
    // case: the requested range arrived in one/few big chunks, so there was no
    // throttled tail to isolate — which only happens when the link delivered it
    // all quickly, i.e. it IS fast, so the (burst-inclusive) whole rate is a
    // fair, high reading. A throttled link instead produces a slow tail and
    // takes the post-burst path above.
    if (firstByteAt !== 0 && received >= 500_000) {
      const seconds = (end - firstByteAt) / 1000;
      if (seconds >= 0.1) return (received / seconds) * 8;

      // Under 100ms for the whole range: the response came out of the HTTP
      // cache. Safari hands a cached range back as a single chunk, so there is
      // no tail to time AND firstByteAt lands on top of the end — every window
      // above measures zero and the probe used to give up with -1. "Unmeasured"
      // then meant "open on the smallest rung", which is how a video the viewer
      // had already watched once started at 144p for a second or two.
      //
      // Instant delivery is not a failed measurement, it is a fast one. Time it
      // from the request instead of the first byte — the only window with any
      // duration in it.
      const wallSeconds = Math.max((end - requestedAt) / 1000, 0.005);
      const instantBits = (received / wallSeconds) * 8;
      // The cap applies to a CACHE HIT only. A cache hit proves the bytes are
      // local, not that the link can carry them — the rest of the file may still
      // have to stream, so the reading gets clamped to something a network can
      // plausibly refill. A live link that simply happens to be fast enough to
      // deliver the range in under 100ms has earned its number and keeps it;
      // capping that would hold a very fast connection down to a mid rung.
      // transferSize === 0 is how the timeline reports "served from cache".
      return isFromCache(url) ? Math.min(instantBits, INSTANT_HIT_CAP_BPS) : instantBits;
    }
    return -1;
  } catch {
    return -1; // aborted / network error — caller falls back to passive measure
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    try {
      await reader?.cancel();
    } catch {
      /* noop */
    }
  }
}
