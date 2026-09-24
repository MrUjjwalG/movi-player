import HTML_RAW from "./index.html";
import TEST_NATIVE_HTML from "./test-native.html";
import COMPARE_HTML from "./compare.html";
import EXAMPLES_HTML from "./examples.html";
import DRIVE_HTML from "./drive.html";
import SITEMAP from "./sitemap.xml";
import ROBOTS from "./robots.txt";
import LLMS from "./llms.txt";
import SHARED_CSS from "./shared.css";
import CINEMATIC_HERO from "./cinematic-hero-v2.webp";
import { WatchParty } from "./watch-party.js";

// Re-exported because a Durable Object class has to be reachable from the
// worker's entry module for the runtime to bind it to the namespace.
export { WatchParty };

const BUILD_VERSION = "__BUILD_VERSION__";

// The shared design system (app/shared.css) is spliced into every page in
// place of the <!--__SHARED_CSS__--> marker, which sits at the very end of
// each <head> — i.e. AFTER that page's own <style>. Later wins, so one edit
// to shared.css re-skins the whole site without any page having to give up
// the layout rules its own JS depends on. Inlined rather than linked: it's a
// few KB on the critical path to first paint, and a <link> would cost every
// page an extra round trip before it could render.
const SHARED_STYLE = "<style>" + SHARED_CSS + "</style>";
const bake = (html) =>
  html
    .replace(/__BUILD_VERSION__/g, BUILD_VERSION)
    .replace("<!--__SHARED_CSS__-->", SHARED_STYLE);

const HTML_WITH_VERSION = bake(HTML_RAW);
const TEST_NATIVE_WITH_VERSION = bake(TEST_NATIVE_HTML);
const COMPARE_WITH_VERSION = bake(COMPARE_HTML);
const EXAMPLES_WITH_VERSION = bake(EXAMPLES_HTML);
const DRIVE_WITH_VERSION = bake(DRIVE_HTML);

// Turnstile site key is injected per-request from env so it can be
// rotated via wrangler secret without a redeploy. When empty the
// client-side Turnstile flow stays inert (matches the server falling
// open when TURNSTILE_SECRET_KEY isn't set).
function buildHtml(env) {
  return HTML_WITH_VERSION.replace(
    /__TURNSTILE_SITE_KEY__/g,
    env.TURNSTILE_SITE_KEY || "",
  );
}

// The Drive app's Google credentials are injected per-request from env so they
// aren't hardcoded in the committed HTML. CLIENT_ID / APP_ID are public
// identifiers (set as wrangler [vars]); DRIVE_API_KEY is a Cloudflare secret
// (`wrangler secret put DRIVE_API_KEY`). The Picker developer key is inherently
// client-visible — it's protected by an HTTP-referrer restriction, not secrecy.
// Missing values leave the placeholder in place, so the page shows a clear
// "not configured" message instead of silently half-working.
function buildDriveHtml(env) {
  return DRIVE_WITH_VERSION
    .replace(/__DRIVE_CLIENT_ID__/g, env.DRIVE_CLIENT_ID || "__DRIVE_CLIENT_ID__")
    .replace(/__DRIVE_API_KEY__/g, env.DRIVE_API_KEY || "__DRIVE_API_KEY__")
    .replace(/__DRIVE_APP_ID__/g, env.DRIVE_APP_ID || "__DRIVE_APP_ID__");
}

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// The Drive app opens a Google OAuth (GIS) popup that must post the token back
// to this window. COOP 'same-origin' + COEP 'require-corp' (SECURITY_HEADERS)
// sever that link and GIS falsely reports 'popup_closed', so /drive uses
// 'same-origin-allow-popups' and NO COEP. The player doesn't need
// SharedArrayBuffer (single-threaded WASM + Asyncify I/O), so dropping
// cross-origin isolation costs nothing here.
const DRIVE_HEADERS = {
  "Content-Type": "text/html;charset=UTF-8",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "public, max-age=300",
};

const CORS_HEADERS = {
  // None of what these headers ride on is a page: the API endpoints answer
  // JSON and the proxy streams somebody else's video. Googlebot found
  // /api/comments on its own and filed it under "crawled — currently not
  // indexed", which is noise in a report that should only be about pages, and
  // the proxy would put a viewer's video under this domain if it were ever
  // indexed. robots.txt keeps the crawler off /api/ and /proxy; this is what
  // answers anything that reaches them anyway — and unlike robots.txt, it is
  // a signal to DROP what was already crawled.
  "X-Robots-Tag": "noindex",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  // Encrypted-playback headers must be listed here so the CORS preflight
  // lets them through.
  "Access-Control-Allow-Headers":
    "Content-Type, Range, Authorization, X-Token, X-Fingerprint, X-Nonce, X-Timestamp, X-Signature",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition",
};

const ALLOWED_CONTENT_TYPES = [
  "video/", "audio/", "application/octet-stream",
  "application/x-matroska", "application/x-mpegurl",
  "application/vnd.apple.mpegurl", "application/dash+xml",
];

// How many leading bytes to sniff when validating a file's magic bytes.
// 32 is enough to cover every container we care about (EBML, ISO BMFF
// boxes at offset 4, RIFF/AVI at offset 8–11, etc.) without buffering
// meaningful amounts of video data.
const MAGIC_SNIFF_SIZE = 32;

/**
 * Returns true if the given byte prefix matches a known video/audio
 * container or streaming-manifest signature. Used as defense-in-depth
 * against upstream servers that mislabel Content-Type — an attacker
 * with their own origin could trivially set Content-Type: video/mp4
 * on arbitrary binaries, so the Content-Type allowlist alone isn't
 * enough to ensure the proxy only serves media.
 */
function hasSupportedSignature(buf) {
  if (!buf || buf.length < 4) return false;
  const b = buf;

  // MKV / WebM — EBML header 1A 45 DF A3
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return true;

  // ISO BMFF family (MP4, MOV, M4A, M4V, 3GP, DASH segments). Every
  // ISO BMFF file starts with a top-level box: 4-byte size + 4-byte
  // type. We allowlist the box types a media file actually starts
  // with — ftyp/styp for initial boxes, moof/moov/mdat/free/skip for
  // segment starts (fragmented MP4 used by DASH/CMAF).
  if (buf.length >= 8) {
    const isBox = (a, c, d, e) => b[4] === a && b[5] === c && b[6] === d && b[7] === e;
    if (isBox(0x66, 0x74, 0x79, 0x70)) return true; // ftyp
    if (isBox(0x73, 0x74, 0x79, 0x70)) return true; // styp
    if (isBox(0x6D, 0x6F, 0x6F, 0x66)) return true; // moof
    if (isBox(0x6D, 0x6F, 0x6F, 0x76)) return true; // moov
    if (isBox(0x6D, 0x64, 0x61, 0x74)) return true; // mdat
    if (isBox(0x66, 0x72, 0x65, 0x65)) return true; // free
    if (isBox(0x73, 0x6B, 0x69, 0x70)) return true; // skip
  }

  // AVI — "RIFF"....\"AVI \"
  if (buf.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 && b[11] === 0x20) return true;

  // FLV
  if (b[0] === 0x46 && b[1] === 0x4C && b[2] === 0x56) return true;

  // ASF / WMV — GUID 30 26 B2 75 8E 66 CF 11
  if (buf.length >= 8 &&
      b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75 &&
      b[4] === 0x8E && b[5] === 0x66 && b[6] === 0xCF && b[7] === 0x11) return true;

  // MPEG-PS (program stream) — pack-header start code 00 00 01 BA
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0xBA) return true;

  // MPEG-2 TS — sync byte 0x47. Stronger than just checking byte 0 by
  // also requiring the packet length offset (188 or 204) to repeat the
  // sync. Within 32 sniffed bytes we can only check the first one, so
  // this is paired with the Content-Type allowlist for safety.
  if (b[0] === 0x47) return true;

  // OGG — "OggS"
  if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return true;

  // MP3 w/ID3 tag — "ID3"
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true;
  // MP3 frame sync
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return true;
  // FLAC — "fLaC"
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return true;

  // HLS playlist — must start with "#EXTM3U"
  if (buf.length >= 7 &&
      b[0] === 0x23 && b[1] === 0x45 && b[2] === 0x58 && b[3] === 0x54 &&
      b[4] === 0x4D && b[5] === 0x33 && b[6] === 0x55) return true;

  // DASH MPD — XML. "<?xml" or "<MPD"
  if (buf.length >= 5 &&
      b[0] === 0x3C && b[1] === 0x3F && b[2] === 0x78 && b[3] === 0x6D && b[4] === 0x6C) return true;
  if (b[0] === 0x3C && b[1] === 0x4D && b[2] === 0x50 && b[3] === 0x44) return true;

  return false;
}

/**
 * Durable Object that tracks recently-seen nonces so that a captured
 * {token, nonce, timestamp, signature} tuple cannot be replayed within
 * the ENC_TIMESTAMP_WINDOW_MS window. One singleton instance ("global")
 * is plenty for this scale — a 10-second window at our traffic volume
 * holds only a few hundred nonces at once. Entries self-expire via the
 * opportunistic GC pass in check().
 *
 * Nonce state lives in process memory (a Map), not storage — a single
 * DO instance is strongly consistent by design, so in-memory tracking
 * is sufficient and avoids the storage.put() latency on every request.
 */
/**
 * Durable Object holding the rolling wrap key used to seal the server's
 * ephemeral ECDH private key inside each token. A new 32-byte random
 * wrap key is generated per WRAP_EPOCH_MS window; only the current
 * + previous epoch keys are kept. Older wrap keys are destroyed.
 *
 * This gives forward secrecy against an ENC_SERVER_SECRET leak. Without
 * this, a network attacker who captures years of (token, ciphertext)
 * tuples could decrypt all of them by learning the master secret later.
 * With rotation, only the current-epoch traffic is recoverable.
 *
 * Storage is used for persistence across DO restarts — losing the
 * current key would invalidate all in-flight tokens.
 */
export class WrapKeyStore {
  constructor(state, env) {
    this.state = state;
    this.ready = this.loadFromStorage();
  }

  async loadFromStorage() {
    const stored = await this.state.storage.get([
      "currentEpoch",
      "currentKey",
      "prevEpoch",
      "prevKey",
    ]);
    this.currentEpoch = stored.get("currentEpoch") ?? 0;
    this.currentKey = stored.get("currentKey") ?? null;
    this.prevEpoch = stored.get("prevEpoch") ?? 0;
    this.prevKey = stored.get("prevKey") ?? null;
  }

  async rotateIfNeeded(epochMs) {
    const nowEpoch = Math.floor(Date.now() / epochMs);
    if (this.currentEpoch === nowEpoch && this.currentKey) return;
    // Slide: current → prev, generate fresh current. The key that was
    // in `prev` is now dropped — any token sealed with it is unrecoverable.
    this.prevEpoch = this.currentEpoch;
    this.prevKey = this.currentKey;
    this.currentEpoch = nowEpoch;
    this.currentKey = crypto.getRandomValues(new Uint8Array(32));
    await this.state.storage.put({
      currentEpoch: this.currentEpoch,
      currentKey: this.currentKey,
      prevEpoch: this.prevEpoch,
      prevKey: this.prevKey,
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const WRAP_EPOCH_MS = 60 * 60 * 1000; // rotate hourly

    await this.rotateIfNeeded(WRAP_EPOCH_MS);

    if (url.pathname === "/wrap-key") {
      // Hand out the current epoch's key for sealing a new token.
      return new Response(
        JSON.stringify({
          epoch: this.currentEpoch,
          keyB64: b64Encode(this.currentKey),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/unwrap-key") {
      // Look up the key for a specific epoch. Returns null if the epoch
      // has aged out — the token is permanently unrecoverable at that point.
      const { epoch } = await request.json();
      let keyB64 = null;
      if (epoch === this.currentEpoch && this.currentKey) {
        keyB64 = b64Encode(this.currentKey);
      } else if (epoch === this.prevEpoch && this.prevKey) {
        keyB64 = b64Encode(this.prevKey);
      }
      return new Response(
        JSON.stringify({ keyB64 }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  }
}

export class NonceTracker {
  constructor(state, env) {
    this.state = state;
    this.nonces = new Map(); // nonce → expiry epochMs
  }

  async fetch(request) {
    const { nonce, ttlMs } = await request.json();
    const now = Date.now();

    // Cheap opportunistic GC — only runs when the map crosses 500 entries,
    // which at 10s TTL means >50 req/s. No timer needed.
    if (this.nonces.size > 500) {
      for (const [n, exp] of this.nonces) {
        if (exp < now) this.nonces.delete(n);
      }
    }

    const existing = this.nonces.get(nonce);
    if (existing !== undefined && existing > now) {
      return new Response(
        JSON.stringify({ ok: false, reason: "replay" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    this.nonces.set(nonce, now + ttlMs);
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestHost = (request.headers.get("host") || "").split(":")[0];

    // One canonical origin: https, no www. The www half was already here; the
    // http half was not, so http://moviplayer.com/ answered 200 with the page
    // and Search Console filed it as a second copy that happened to carry the
    // right canonical. A redirect says it once, at the door.
    if (
      !env.LOCAL_DEV &&
      (requestHost === "www.moviplayer.com" ||
        (requestHost === "moviplayer.com" && url.protocol === "http:"))
    ) {
      return Response.redirect(`https://moviplayer.com${path}${url.search}`, 301);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // One URL per page.
    //
    // Every page answered 200 at three or four spellings — /compare,
    // /compare.html and /compare/ all served the same bytes — so a crawler
    // fetched each page several times and had only rel=canonical to tell it
    // which one counted. Say it in the response instead: the spellings 301 to
    // the canonical path, which is the one in the sitemap and in every link.
    const CANONICAL_PATH = {
      "/index.html": "/",
      "/compare.html": "/compare",
      "/compare/": "/compare",
      "/examples.html": "/examples",
      "/examples/": "/examples",
      "/drive.html": "/drive",
      "/drive/": "/drive",
      "/test-native.html": "/test-native",
    };
    if (CANONICAL_PATH[path]) {
      return Response.redirect(
        `${url.origin}${CANONICAL_PATH[path]}${url.search}`,
        301,
      );
    }

    // --- Serve app ---
    if (path === "/") {
      return new Response(buildHtml(env), {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
          ...SECURITY_HEADERS,
        },
      });
    }

    // --- Test page for isolating native <video> playback issues ---
    if (path === "/test-native") {
      return new Response(TEST_NATIVE_WITH_VERSION, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "no-store",
          // A debugging page for native <video>, of no use to anyone
          // searching — keep it out of the index rather than let it rank for
          // the player's own terms.
          "X-Robots-Tag": "noindex, nofollow",
          ...SECURITY_HEADERS,
        },
      });
    }

    // --- Side-by-side comparison: native <video> vs <movi-player> ---
    if (path === "/compare") {
      return new Response(COMPARE_WITH_VERSION, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=600",
          ...SECURITY_HEADERS,
        },
      });
    }

    // --- Examples gallery: real, copy-paste <movi-player> setups. Served
    // WITHOUT COEP: it embeds cross-origin demo streams (HLS/DASH), and
    // require-corp would fight their opaque/CORS fetches. The player needs no
    // SharedArrayBuffer (single-threaded WASM + Asyncify I/O), so dropping
    // cross-origin isolation costs nothing here. ---
    if (path === "/examples") {
      return new Response(EXAMPLES_WITH_VERSION, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=600",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        },
      });
    }

    // --- "Open with Movi Player" for Google Drive. Also the Drive UI
    // Integration Open URL: Drive appends ?state={ids,action} and the page
    // signs in + streams the picked file. Uses DRIVE_HEADERS (popup-safe COOP,
    // no COEP) so the GIS OAuth popup can return the token — see the note there.
    if (path === "/drive") {
      return new Response(buildDriveHtml(env), { headers: DRIVE_HEADERS });
    }

    // --- Docs: reverse-proxy the VitePress site (GitHub Pages) under /docs so
    // it lives on the apex domain (better SEO — one domain, consolidated
    // authority — than a docs.* subdomain). The GH Pages build uses base
    // "/movi-player/"; we rewrite that to "/docs/" in text responses so links
    // and assets resolve under moviplayer.com/docs. Each page's rel=canonical is
    // already moviplayer.com/docs/... (set in VitePress transformPageData), so
    // the github.io copy de-duplicates to this one for search engines.
    // Force the trailing slash: /docs → /docs/. The coi-serviceworker registers
    // with scope "/docs/", which does NOT control the slash-less "/docs" URL, so
    // that page can never reach cross-origin isolation and the coi reload retries
    // forever (a redirect loop). Landing everyone on "/docs/" keeps them inside
    // the SW scope. (Also the canonical/base is "/docs/".)
    if (path === "/docs") {
      return Response.redirect(`${url.origin}/docs/${url.search}`, 301);
    }
    if (path.startsWith("/docs/")) {
      return handleDocs(url);
    }

    // --- Serve dist files from R2 (strip version prefix for key lookup) ---
    if (path.startsWith("/dist/")) {
      const parts = path.slice(6).split("/");
      // /dist/<version>/element.js → key = "element.js"
      const key = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
      recordDistHit(env, parts, key, request);
      return handleR2(env, key, request);
    }

    // --- Demo media: range-aware so big videos can be seeked. ---
    if (path.startsWith("/samples/")) {
      const key = path.slice(1); // strip leading "/"
      return handleR2Sample(env, key, request);
    }

    // --- Embed player ---
    if (path === "/embed") {
      return handleEmbed(url, request);
    }

    // --- Video proxy ---
    if (path === "/proxy") {
      return handleProxy(request, url, env);
    }

    // --- Encrypted-playback proxy (auth headers + POST + no cache) ---
    if (path === "/eproxy") {
      return handleEncryptedProxy(request, url);
    }

    // --- Encrypted playback served directly from R2 ---
    if (path === "/api/session" && request.method === "POST") {
      return handleEncSession(request, env);
    }
    if (path === "/api/token" && request.method === "POST") {
      return handleEncToken(request, env);
    }
    if (path === "/api/proxy-sign" && request.method === "POST") {
      return handleProxySign(request, env);
    }
    if (path === "/api/video") {
      return handleEncVideo(request, env);
    }

    // --- Watch party (unlisted; see app/watch-party.js) ---
    if (path === "/api/party/host" && request.method === "POST") {
      return handlePartyHost(request, env);
    }
    if (path === "/api/party/room") {
      return handlePartyRoom(request, env, url);
    }

    // --- Visitor feedback wall (landing page, under the FAQ) ---
    if (path === "/api/comments") {
      if (request.method === "GET") return handleCommentsList(env, url);
      if (request.method === "POST") return handleCommentPost(request, env);
      if (request.method === "DELETE") return handleCommentDelete(request, env, url);
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // --- Sitemap & Robots ---
    if (path === "/sitemap.xml") {
      return new Response(SITEMAP, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=86400" } });
    }
    if (path === "/robots.txt") {
      return new Response(ROBOTS, { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
    }
    if (path === "/llms.txt") {
      return new Response(LLMS, { headers: { "Content-Type": "text/plain;charset=UTF-8", "Cache-Control": "public, max-age=86400" } });
    }
    if (path === "/cinematic-hero-v2.webp") {
      return new Response(CINEMATIC_HERO, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // --- Extension install/usage badges, proxied from upstream badge
    //     services. We can't <img> them directly: COEP require-corp on
    //     this zone blocks cross-origin subresources that lack a CORP
    //     header (vsmarketplacebadges.dev sends none). Re-serving them
    //     same-origin sidesteps COEP, edge-caches the count, and lets us
    //     fall back to a static badge if the upstream is down. ---
    if (path === "/badge/chrome.svg") return handleBadge("chrome");
    if (path === "/badge/vscode.svg") return handleBadge("vscode");
    if (path === "/badge/npm.svg") return handleBadge("npm");
    if (path === "/badge/jsdelivr.svg") return handleBadge("jsdelivr");

    // --- Serve static assets from R2 (favicons, etc.) ---
    if (path.startsWith("/favicon") || path === "/apple-touch-icon.png" || path === "/og-image.png") {
      const key = path.slice(1);
      return handleStaticAsset(env, key);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// GitHub Pages origin the docs are built to (VitePress base "/movi-player/").
const DOCS_ORIGIN = "https://mrujjwalg.github.io/movi-player";

/**
 * Reverse-proxy the VitePress docs so moviplayer.com/docs serves the same site
 * that's published to GitHub Pages. Maps /docs/<x> → <DOCS_ORIGIN>/<x>, and
 * rewrites the baked-in "/movi-player/" base to "/docs/" in text responses so
 * every link/asset resolves under the apex path. Binary assets stream through
 * untouched. 404s from GH Pages pass through as 404s.
 */
async function handleDocs(url) {
  // "/docs" → "/", "/docs/guide" → "/guide", "/docs/assets/x.js" → "/assets/x.js"
  let rest = url.pathname.replace(/^\/docs/, "");
  if (rest === "") rest = "/";
  const target = DOCS_ORIGIN + rest + url.search;

  let res;
  try {
    res = await fetch(target, {
      headers: { "User-Agent": "moviplayer-docs-proxy" },
      redirect: "follow",
    });
  } catch {
    return new Response("Docs upstream unavailable", { status: 502 });
  }

  const ct = res.headers.get("content-type") || "";
  const isText = /text\/html|javascript|json|text\/css|application\/xml|svg/i.test(ct);

  // Text (HTML/JS/CSS/JSON/XML): rewrite the base path so /movi-player/ → /docs/.
  // The rel=canonical is an absolute moviplayer.com/docs URL (set in VitePress),
  // so it contains no "/movi-player/" and is left intact.
  //
  // Only where it STARTS a path, which is the only place the VitePress base
  // appears: quoted in markup and JSON, or inside a CSS url(). A plain replace
  // of every "/movi-player/" also caught the ones sitting in the middle of an
  // absolute URL that has nothing to do with this site's base — the docs' own
  // CDN examples became cdn.jsdelivr.net/npm/docs/dist/element.js, and every
  // "Edit this page" link became github.com/MrUjjwalG/docs/edit/... — served
  // that way to every reader while the GitHub Pages copy underneath was
  // perfectly correct. Measured against the built site: 1873 references belong
  // to the base and 54 do not.
  if (isText) {
    const body = (await res.text()).replace(
      /(^|[\s"'`(=,;])\/movi-player\//g,
      "$1/docs/",
    );
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": ct,
        "Cache-Control": res.ok ? "public, max-age=600" : "no-store",
        "X-Robots-Tag": "index, follow",
      },
    });
  }

  // Binary (images, fonts, wasm): stream through with a longer cache.
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": ct,
      "Cache-Control": res.ok ? "public, max-age=86400" : "no-store",
    },
  });
}

// Attributes an /embed URL may set on <movi-player>, as ?attr (boolean) or
// ?attr=value. Presentational only — URL / DRM / header attributes (src,
// crossorigin, encrypted, tokenurl, videourl, videoid, drm, licenseurl,
// licenseheaders, headers, lcevc*, audiooutput) are deliberately excluded so an
// embed link can't repoint the player at arbitrary token/license endpoints or
// inject request headers. Attribute NAMES are whitelisted here; values are
// HTML-escaped at serialization.
const EMBED_ATTR_WHITELIST = new Set([
  "autoplay", "controls", "loop", "muted", "playsinline", "preload",
  "poster", "postertime", "volume", "playbackrate", "startat",
  "subtitledelay", "subtitlesize", "subtitlecolor", "subtitlebg", "subtitleedge",
  "ambientmode", "ambientwrapper", "objectfit", "thumb", "hdr", "theme",
  "fps", "gesturefs", "nohotkeys", "fastseek", "doubletap", "themecolor",
  "buffersize", "title", "showtitle", "resume", "stablevolume", "audioonly",
  "vr", "vrpad", "renderer", "width", "height", "sw",
  // Chooses which engine leads/trails — no URL, no headers, no credentials.
  "fallback", "engine",
]);

function escapeEmbedAttr(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Build the <movi-player> attribute string for an embed: sensible presentational
// defaults, then any whitelisted query params layered on top (a value overrides
// the default; `attr=0`/`attr=false` drops a default such as controls).
function buildEmbedPlayerAttrs(searchParams) {
  const attrs = new Map([
    ["renderer", "canvas"],
    ["controls", true],
    ["objectfit", "control"],
    ["gesturefs", true],
    ["fastseek", true],
    ["stablevolume", true],
    // See EMBED_DEFAULT_ATTRS in index.html: a host that sends no CORS headers
    // blocks the fetch the WASM path needs, and the embedder rarely controls
    // that host. The native element never needed CORS for the same file, and
    // the bytes still travel from their host to their page — never through
    // ours. `fallback=0` in the embed URL turns it off.
    ["fallback", "native"],
  ]);
  for (const [rawName, value] of searchParams) {
    const name = rawName.toLowerCase();
    if (name === "url") continue;
    if (!EMBED_ATTR_WHITELIST.has(name)) continue;
    if (value === "0" || value === "false") {
      attrs.delete(name); // explicit off — lets an embed drop a default
    } else if (value === "" || value === "1" || value === "true") {
      attrs.set(name, true); // boolean attribute
    } else {
      attrs.set(name, value); // value attribute
    }
  }
  return [...attrs]
    .map(([k, v]) => (v === true ? k : `${k}="${escapeEmbedAttr(v)}"`))
    .join(" ");
}

// The replacement this endpoint now hands out. Kept in step with
// buildEmbedCode() in index.html — same document, same inline styles — so a
// visitor gets the identical snippet whether they come from the Embed dialog
// or from an old iframe that stopped working.
const EMBED_PLAYER_CDN = "https://cdn.jsdelivr.net/npm/movi-player/dist/element.js";
const EMBED_IFRAME_STYLE =
  "display:block;box-sizing:border-box;border:0;margin:0;padding:0;" +
  "width:100%;max-width:800px;aspect-ratio:16/9;height:auto;background:#000";

function buildSrcdocEmbed(videoUrl, playerAttrs, wantAutoplay) {
  const doc =
    '<!doctype html><meta charset="utf-8">' +
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}" +
    "movi-player{width:100%;height:100%}</style>" +
    '<script type="module" src="' + EMBED_PLAYER_CDN + '"><\/script>' +
    '<movi-player src="' + escapeEmbedAttr(videoUrl) + '" ' + playerAttrs +
    "></movi-player>";
  // srcdoc carries a whole document inside one attribute, so everything in it
  // is unescaped a second time when parsed — hence the second pass.
  const srcdoc = doc.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
  const allow = "fullscreen" + (wantAutoplay ? "; autoplay" : "");
  return `<iframe srcdoc='${srcdoc}' style="${EMBED_IFRAME_STYLE}" width="800" ` +
    `height="450" frameborder="0" allowfullscreen allow="${allow}"></iframe>`;
}

/**
 * What an old /embed iframe shows now.
 *
 * This endpoint used to relay the media through our worker, which is the only
 * reason it ever worked for a source that sends no CORS headers. It doesn't
 * relay any more, so rather than let the player fail with a network error the
 * page explains what happened — and builds the replacement snippet from the
 * very parameters the old embed was called with, so the fix is a copy away.
 */
function embedDeprecatedNotice(videoUrl, playerAttrs, wantAutoplay) {
  const snippet = buildSrcdocEmbed(videoUrl, playerAttrs, wantAutoplay);
  const inTextarea = snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Embed out of date — MoviPlayer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font:13px/1.55 system-ui,-apple-system,sans-serif;background:#0e0e1a;color:#cfcfe6;
     padding:16px;display:flex;align-items:center;justify-content:center;overflow:auto}
.wrap{width:100%;max-width:620px}
.brand{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.brand-name{font-size:15px;font-weight:700;letter-spacing:-0.02em;color:#fff}
h1{font-size:15px;color:#fff;margin-bottom:6px}
p{margin-bottom:10px;color:#a9a9c4}
/* Wrapped, not scrolled sideways. The snippet is one very long line, and a
   box that shows only its first few words reads as truncated — which is
   exactly the doubt this page exists to remove. */
textarea{width:100%;height:150px;background:#07070f;color:#c9c9e4;border:1px solid #26263c;
         border-radius:8px;padding:8px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
         resize:vertical;white-space:pre-wrap;word-break:break-all;overflow:auto}
.row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
button{background:#6c5dd3;color:#fff;border:0;border-radius:7px;padding:7px 14px;
       font:600 12px system-ui;cursor:pointer}
button:hover{background:#7d6ee0}
a{color:#8b7bff;text-decoration:none}
a:hover{text-decoration:underline}
.ok{color:#7ddba0;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
<div class="brand">
<svg viewBox="323 49 930 930" width="26" height="26" aria-hidden="true"><defs><clipPath id="logoL-0"><path clip-rule="evenodd" d="M383.55 222 C383.55 152.17 440.03 97.5 512 97.5 C543.4 97.5 559.7 101.8 590 117.5 L1100 381.5 C1174.55 414.03 1191.47 471.49 1193 512.5 C1192.29 590.19 1134.3 634.06 1100 646.5 C930.83 737.99 761.67 826.04 592.5 909 C571.47 917.98 554.22 929.25 512 930.3 C455.97 929.9 384.46 889.54 383.55 802 Z M614 360 L913 520 C686.95 641.07 614 666.34 614 669 Z"/></clipPath><linearGradient id="logoL-1" gradientUnits="userSpaceOnUse" x1="0" y1="97" x2="0" y2="360"><stop offset="0" stop-color="#737bfd"/><stop offset="0.5" stop-color="#6eb3fd"/><stop offset="1" stop-color="#81e1fe"/></linearGradient><radialGradient id="logoL-2" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(726.13 101.51) scale(218.96 701.75)"><stop offset="0" stop-color="#0c00fd"/><stop offset="0.12" stop-color="#0c00fd" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0c00fd" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0c00fd" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0c00fd" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0c00fd" stop-opacity="0.006"/><stop offset="1" stop-color="#0c00fd" stop-opacity="0"/></radialGradient><radialGradient id="logoL-3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(255.4 225.67) scale(350.82 206.02)"><stop offset="0" stop-color="#4c00fd" stop-opacity="0.58"/><stop offset="0.12" stop-color="#4c00fd" stop-opacity="0.484"/><stop offset="0.24" stop-color="#4c00fd" stop-opacity="0.282"/><stop offset="0.36" stop-color="#4c00fd" stop-opacity="0.115"/><stop offset="0.48" stop-color="#4c00fd" stop-opacity="0.033"/><stop offset="0.64" stop-color="#4c00fd" stop-opacity="0.003"/><stop offset="1" stop-color="#4c00fd" stop-opacity="0"/></radialGradient><linearGradient id="logoL-4" gradientUnits="userSpaceOnUse" x1="0" y1="225" x2="0" y2="817"><stop offset="0" stop-color="#5143ff"/><stop offset="0.5" stop-color="#294cf6"/><stop offset="1" stop-color="#0437cc"/></linearGradient><radialGradient id="logoL-5" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(621.75 616.05) scale(192.93 939.93)"><stop offset="0" stop-color="#436eff"/><stop offset="0.12" stop-color="#436eff" stop-opacity="0.835"/><stop offset="0.24" stop-color="#436eff" stop-opacity="0.487"/><stop offset="0.36" stop-color="#436eff" stop-opacity="0.198"/><stop offset="0.48" stop-color="#436eff" stop-opacity="0.056"/><stop offset="0.64" stop-color="#436eff" stop-opacity="0.006"/><stop offset="1" stop-color="#436eff" stop-opacity="0"/></radialGradient><radialGradient id="logoL-6" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(637.74 314.49) scale(126.64 109.33)"><stop offset="0" stop-color="#0000ec"/><stop offset="0.12" stop-color="#0000ec" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0000ec" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0000ec" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0000ec" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0000ec" stop-opacity="0.006"/><stop offset="1" stop-color="#0000ec" stop-opacity="0"/></radialGradient><linearGradient id="logoL-7" gradientUnits="userSpaceOnUse" x1="0" y1="669" x2="0" y2="930"><stop offset="0" stop-color="#001fad"/><stop offset="0.5" stop-color="#2e50ff"/><stop offset="1" stop-color="#3d4eff"/></linearGradient><radialGradient id="logoL-8" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(367.66 690.91) scale(257.59 321.92)"><stop offset="0" stop-color="#0023ab"/><stop offset="0.12" stop-color="#0023ab" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0023ab" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0023ab" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0023ab" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0023ab" stop-opacity="0.006"/><stop offset="1" stop-color="#0023ab" stop-opacity="0"/></radialGradient><radialGradient id="logoL-9" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(554.73 904.5) scale(161.77 151.07)"><stop offset="0" stop-color="#564efc"/><stop offset="0.12" stop-color="#564efc" stop-opacity="0.835"/><stop offset="0.24" stop-color="#564efc" stop-opacity="0.487"/><stop offset="0.36" stop-color="#564efc" stop-opacity="0.198"/><stop offset="0.48" stop-color="#564efc" stop-opacity="0.056"/><stop offset="0.64" stop-color="#564efc" stop-opacity="0.006"/><stop offset="1" stop-color="#564efc" stop-opacity="0"/></radialGradient><linearGradient id="logoL-10" gradientUnits="userSpaceOnUse" x1="460" y1="0" x2="1185" y2="0"><stop offset="0" stop-color="#4442fc"/><stop offset="0.5" stop-color="#5800fd"/><stop offset="1" stop-color="#00c9ff"/></linearGradient><radialGradient id="logoL-11" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(918.16 679.1) scale(562.77 1104.38)"><stop offset="0" stop-color="#b3acfc" stop-opacity="0.732"/><stop offset="0.12" stop-color="#b3acfc" stop-opacity="0.611"/><stop offset="0.24" stop-color="#b3acfc" stop-opacity="0.356"/><stop offset="0.36" stop-color="#b3acfc" stop-opacity="0.145"/><stop offset="0.48" stop-color="#b3acfc" stop-opacity="0.041"/><stop offset="0.64" stop-color="#b3acfc" stop-opacity="0.004"/><stop offset="1" stop-color="#b3acfc" stop-opacity="0"/></radialGradient><linearGradient id="logoL-12" gradientUnits="userSpaceOnUse" x1="933.66" y1="4.95" x2="816.34" y2="695.05"><stop offset="0" stop-color="#ff3efc"/><stop offset=".25" stop-color="#6cb1fd"/><stop offset=".5" stop-color="#548cfd"/><stop offset=".75" stop-color="#295dfd"/><stop offset="1" stop-color="#0b07f8"/></linearGradient><radialGradient id="logoL-13" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(1255.8 459.16) rotate(22.04) scale(464.67 224.5)"><stop offset="0" stop-color="#00d4fe" stop-opacity="0.797"/><stop offset=".5" stop-color="#00d4fe" stop-opacity="0.246"/><stop offset="1" stop-color="#00d4fe" stop-opacity="0"/></radialGradient><radialGradient id="logoL-14" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(630 351) rotate(-113.37) scale(1399.91 230.15)"><stop offset="0" stop-color="#a0effd" stop-opacity="0.2"/><stop offset=".5" stop-color="#a0effd" stop-opacity="0"/><stop offset="1" stop-color="#a0effd" stop-opacity="0"/></radialGradient><path id="logoL-15" d="M350 80 H1220 V950 H350 Z"/><path id="logoL-16" d="M350 80 H614 V668.5 C394.51 759.97 395.83 810.57 384 817 H350 Z"/><path id="logoL-17" d="M384 817 C395.83 810.57 394.51 759.97 614 668.5 C601.76 795.98 495.68 900.62 460 920 L350 960 V817 Z"/><path id="logoL-18" d="M350 80 H1220 V545 L1184 558 C1091.75 639.78 1018.25 572.14 913 520 L614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/><path id="logoL-19" d="M350 80 H520 L539 100 C563.83 110.79 604.49 141.82 611.5 230 C614.03 257.11 613.18 307.14 614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/></defs><g clip-path="url(#logoL-0)"><g id="logoL-20"><use href="#logoL-15" fill="url(#logoL-10)"/><use href="#logoL-15" fill="url(#logoL-11)"/></g><g id="logoL-21"><use href="#logoL-16" fill="url(#logoL-4)"/><use href="#logoL-16" fill="url(#logoL-5)"/><use href="#logoL-16" fill="url(#logoL-6)"/></g><g id="logoL-22"><use href="#logoL-17" fill="url(#logoL-7)"/><use href="#logoL-17" fill="url(#logoL-8)"/><use href="#logoL-17" fill="url(#logoL-9)"/></g><g id="logoL-23"><use href="#logoL-18" fill="url(#logoL-12)"/><use href="#logoL-18" fill="url(#logoL-13)"/><use href="#logoL-18" fill="url(#logoL-14)"/></g><g id="logoL-24"><use href="#logoL-19" fill="url(#logoL-1)"/><use href="#logoL-19" fill="url(#logoL-2)"/><use href="#logoL-19" fill="url(#logoL-3)"/></g></g></svg>
<span class="brand-name">MoviPlayer</span>
</div>
<h1>This embed is out of date</h1>
<p>It played through moviplayer.com's servers. It no longer does, so the video
has to be readable directly by the browser. Replace the old iframe on your page
with the one below &mdash; it runs the player on your own site, and your options
have been carried over.</p>
<textarea readonly onclick="this.select()">${inTextarea}</textarea>
<div class="row">
<button id="c">Copy</button>
<span id="s" class="ok"></span>
<span style="margin-left:auto"><a href="https://moviplayer.com" target="_blank" rel="noopener">moviplayer.com</a></span>
</div>
</div>
<script>
document.getElementById("c").addEventListener("click", function () {
  var t = document.querySelector("textarea");
  var done = function () { document.getElementById("s").textContent = "Copied"; };
  // Clipboard access needs a permission an old embed's iframe was never given,
  // so fall back to the selection copy that has always worked.
  t.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t.value).then(done, function () {
      try { document.execCommand("copy"); done(); } catch (e) {
        document.getElementById("s").textContent = "Press Ctrl/Cmd+C";
      }
    });
  } else {
    try { document.execCommand("copy"); done(); } catch (e) {
      document.getElementById("s").textContent = "Press Ctrl/Cmd+C";
    }
  }
});
<\/script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "no-store",
      Vary: "Sec-Fetch-Dest",
    },
  });
}

function handleEmbed(url, request) {
  // Embed-only: this page is meant to live inside an <iframe>, never opened
  // directly. Sec-Fetch-Dest tells us the request's destination — 'iframe' or
  // 'frame' when embedded, 'document' on a top-level navigation (typing the
  // URL, opening in a new tab). Block the top-level case. All current browsers
  // send this header; when it's absent (older clients) we fall through to the
  // notice below, which is harmless to read directly.
  const dest = request && request.headers.get("Sec-Fetch-Dest");
  if (dest === "document") {
    return embedTopLevelBlock();
  }

  const videoUrl = url.searchParams.get("url") || "";
  const playerAttrs = buildEmbedPlayerAttrs(url.searchParams);

  // This endpoint no longer plays anything. Relaying the media was the only
  // thing that made it work for a source without CORS headers, and it stopped
  // relaying — so the player would fail with a network error that tells the
  // site owner nothing. Hand them the replacement instead, built from the
  // parameters this very embed was called with.
  const wantsAutoplay = /(^|&)autoplay(=|&|$)/i.test(url.search);
  return embedDeprecatedNotice(videoUrl, playerAttrs, wantsAutoplay);
}

// 403 shown when /embed is opened as a top-level document instead of inside an
// <iframe>. Never cached (no-store) and non-indexable so the block page can't
// be served in place of a legitimately-framed embed.
function embedTopLevelBlock() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Embed only — MoviPlayer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font:15px/1.6 system-ui,-apple-system,sans-serif;background:#0e0e1a;color:#cfcfe6;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
h1{font-size:18px;margin-bottom:8px;color:#fff}
a{color:#8b7bff;text-decoration:none}
a:hover{text-decoration:underline}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px}
.brand svg{display:block;filter:drop-shadow(0 4px 14px rgba(108,93,211,0.45))}
.brand-name{font-size:19px;font-weight:700;letter-spacing:-0.02em;color:#fff}
</style>
</head>
<body>
<div>
<div class="brand">
<svg viewBox="323 49 930 930" width="40" height="40" aria-hidden="true"><defs><clipPath id="logoL-2-0"><path clip-rule="evenodd" d="M383.55 222 C383.55 152.17 440.03 97.5 512 97.5 C543.4 97.5 559.7 101.8 590 117.5 L1100 381.5 C1174.55 414.03 1191.47 471.49 1193 512.5 C1192.29 590.19 1134.3 634.06 1100 646.5 C930.83 737.99 761.67 826.04 592.5 909 C571.47 917.98 554.22 929.25 512 930.3 C455.97 929.9 384.46 889.54 383.55 802 Z M614 360 L913 520 C686.95 641.07 614 666.34 614 669 Z"/></clipPath><linearGradient id="logoL-2-1" gradientUnits="userSpaceOnUse" x1="0" y1="97" x2="0" y2="360"><stop offset="0" stop-color="#737bfd"/><stop offset="0.5" stop-color="#6eb3fd"/><stop offset="1" stop-color="#81e1fe"/></linearGradient><radialGradient id="logoL-2-2" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(726.13 101.51) scale(218.96 701.75)"><stop offset="0" stop-color="#0c00fd"/><stop offset="0.12" stop-color="#0c00fd" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0c00fd" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0c00fd" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0c00fd" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0c00fd" stop-opacity="0.006"/><stop offset="1" stop-color="#0c00fd" stop-opacity="0"/></radialGradient><radialGradient id="logoL-2-3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(255.4 225.67) scale(350.82 206.02)"><stop offset="0" stop-color="#4c00fd" stop-opacity="0.58"/><stop offset="0.12" stop-color="#4c00fd" stop-opacity="0.484"/><stop offset="0.24" stop-color="#4c00fd" stop-opacity="0.282"/><stop offset="0.36" stop-color="#4c00fd" stop-opacity="0.115"/><stop offset="0.48" stop-color="#4c00fd" stop-opacity="0.033"/><stop offset="0.64" stop-color="#4c00fd" stop-opacity="0.003"/><stop offset="1" stop-color="#4c00fd" stop-opacity="0"/></radialGradient><linearGradient id="logoL-2-4" gradientUnits="userSpaceOnUse" x1="0" y1="225" x2="0" y2="817"><stop offset="0" stop-color="#5143ff"/><stop offset="0.5" stop-color="#294cf6"/><stop offset="1" stop-color="#0437cc"/></linearGradient><radialGradient id="logoL-2-5" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(621.75 616.05) scale(192.93 939.93)"><stop offset="0" stop-color="#436eff"/><stop offset="0.12" stop-color="#436eff" stop-opacity="0.835"/><stop offset="0.24" stop-color="#436eff" stop-opacity="0.487"/><stop offset="0.36" stop-color="#436eff" stop-opacity="0.198"/><stop offset="0.48" stop-color="#436eff" stop-opacity="0.056"/><stop offset="0.64" stop-color="#436eff" stop-opacity="0.006"/><stop offset="1" stop-color="#436eff" stop-opacity="0"/></radialGradient><radialGradient id="logoL-2-6" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(637.74 314.49) scale(126.64 109.33)"><stop offset="0" stop-color="#0000ec"/><stop offset="0.12" stop-color="#0000ec" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0000ec" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0000ec" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0000ec" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0000ec" stop-opacity="0.006"/><stop offset="1" stop-color="#0000ec" stop-opacity="0"/></radialGradient><linearGradient id="logoL-2-7" gradientUnits="userSpaceOnUse" x1="0" y1="669" x2="0" y2="930"><stop offset="0" stop-color="#001fad"/><stop offset="0.5" stop-color="#2e50ff"/><stop offset="1" stop-color="#3d4eff"/></linearGradient><radialGradient id="logoL-2-8" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(367.66 690.91) scale(257.59 321.92)"><stop offset="0" stop-color="#0023ab"/><stop offset="0.12" stop-color="#0023ab" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0023ab" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0023ab" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0023ab" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0023ab" stop-opacity="0.006"/><stop offset="1" stop-color="#0023ab" stop-opacity="0"/></radialGradient><radialGradient id="logoL-2-9" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(554.73 904.5) scale(161.77 151.07)"><stop offset="0" stop-color="#564efc"/><stop offset="0.12" stop-color="#564efc" stop-opacity="0.835"/><stop offset="0.24" stop-color="#564efc" stop-opacity="0.487"/><stop offset="0.36" stop-color="#564efc" stop-opacity="0.198"/><stop offset="0.48" stop-color="#564efc" stop-opacity="0.056"/><stop offset="0.64" stop-color="#564efc" stop-opacity="0.006"/><stop offset="1" stop-color="#564efc" stop-opacity="0"/></radialGradient><linearGradient id="logoL-2-10" gradientUnits="userSpaceOnUse" x1="460" y1="0" x2="1185" y2="0"><stop offset="0" stop-color="#4442fc"/><stop offset="0.5" stop-color="#5800fd"/><stop offset="1" stop-color="#00c9ff"/></linearGradient><radialGradient id="logoL-2-11" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(918.16 679.1) scale(562.77 1104.38)"><stop offset="0" stop-color="#b3acfc" stop-opacity="0.732"/><stop offset="0.12" stop-color="#b3acfc" stop-opacity="0.611"/><stop offset="0.24" stop-color="#b3acfc" stop-opacity="0.356"/><stop offset="0.36" stop-color="#b3acfc" stop-opacity="0.145"/><stop offset="0.48" stop-color="#b3acfc" stop-opacity="0.041"/><stop offset="0.64" stop-color="#b3acfc" stop-opacity="0.004"/><stop offset="1" stop-color="#b3acfc" stop-opacity="0"/></radialGradient><linearGradient id="logoL-2-12" gradientUnits="userSpaceOnUse" x1="933.66" y1="4.95" x2="816.34" y2="695.05"><stop offset="0" stop-color="#ff3efc"/><stop offset=".25" stop-color="#6cb1fd"/><stop offset=".5" stop-color="#548cfd"/><stop offset=".75" stop-color="#295dfd"/><stop offset="1" stop-color="#0b07f8"/></linearGradient><radialGradient id="logoL-2-13" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(1255.8 459.16) rotate(22.04) scale(464.67 224.5)"><stop offset="0" stop-color="#00d4fe" stop-opacity="0.797"/><stop offset=".5" stop-color="#00d4fe" stop-opacity="0.246"/><stop offset="1" stop-color="#00d4fe" stop-opacity="0"/></radialGradient><radialGradient id="logoL-2-14" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(630 351) rotate(-113.37) scale(1399.91 230.15)"><stop offset="0" stop-color="#a0effd" stop-opacity="0.2"/><stop offset=".5" stop-color="#a0effd" stop-opacity="0"/><stop offset="1" stop-color="#a0effd" stop-opacity="0"/></radialGradient><path id="logoL-2-15" d="M350 80 H1220 V950 H350 Z"/><path id="logoL-2-16" d="M350 80 H614 V668.5 C394.51 759.97 395.83 810.57 384 817 H350 Z"/><path id="logoL-2-17" d="M384 817 C395.83 810.57 394.51 759.97 614 668.5 C601.76 795.98 495.68 900.62 460 920 L350 960 V817 Z"/><path id="logoL-2-18" d="M350 80 H1220 V545 L1184 558 C1091.75 639.78 1018.25 572.14 913 520 L614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/><path id="logoL-2-19" d="M350 80 H520 L539 100 C563.83 110.79 604.49 141.82 611.5 230 C614.03 257.11 613.18 307.14 614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/></defs><g clip-path="url(#logoL-2-0)"><g id="logoL-2-20"><use href="#logoL-2-15" fill="url(#logoL-2-10)"/><use href="#logoL-2-15" fill="url(#logoL-2-11)"/></g><g id="logoL-2-21"><use href="#logoL-2-16" fill="url(#logoL-2-4)"/><use href="#logoL-2-16" fill="url(#logoL-2-5)"/><use href="#logoL-2-16" fill="url(#logoL-2-6)"/></g><g id="logoL-2-22"><use href="#logoL-2-17" fill="url(#logoL-2-7)"/><use href="#logoL-2-17" fill="url(#logoL-2-8)"/><use href="#logoL-2-17" fill="url(#logoL-2-9)"/></g><g id="logoL-2-23"><use href="#logoL-2-18" fill="url(#logoL-2-12)"/><use href="#logoL-2-18" fill="url(#logoL-2-13)"/><use href="#logoL-2-18" fill="url(#logoL-2-14)"/></g><g id="logoL-2-24"><use href="#logoL-2-19" fill="url(#logoL-2-1)"/><use href="#logoL-2-19" fill="url(#logoL-2-2)"/><use href="#logoL-2-19" fill="url(#logoL-2-3)"/></g></g></svg>
<span class="brand-name">MoviPlayer</span>
</div>
<h1>This is an embed-only page</h1>
<p>Open it inside an &lt;iframe&gt;, or visit <a href="https://moviplayer.com">moviplayer.com</a>.</p>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 403,
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "no-store",
      "Vary": "Sec-Fetch-Dest",
      "X-Robots-Tag": "noindex",
      ...SECURITY_HEADERS,
    },
  });
}

const MIME_TYPES = {
  js: "application/javascript",
  wasm: "application/wasm",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  ts: "video/mp2t",
};

/**
 * Note which SITE loaded a player bundle from this origin.
 *
 * The documented embed points at jsdelivr, so this does not see most adoption
 * and is not meant to — it answers one question: of the loads that DO come
 * here, whose page were they on. The referring HOST is the whole record. No
 * path, no query, no IP, no cookie: a cross-origin script load already sends
 * only the origin under the default referrer policy, and the origin is the
 * answer, so there is nothing further worth keeping.
 *
 * Own traffic is recorded too rather than filtered out — moviplayer.com is a
 * row like any other, and telling it apart is a WHERE clause at query time,
 * while dropping it here would make "is anyone else using this" unanswerable
 * against a baseline.
 *
 * Fall-open, like every other optional binding in this worker: with no
 * ANALYTICS dataset bound (a fork, `wrangler dev`) it does nothing at all.
 *
 * What it CANNOT tell you: how many people watched. /dist is served
 * `immutable` for a year, so a browser asks once and never again — these are
 * first fetches, not views.
 */
function recordDistHit(env, parts, key, request) {
  if (!env.DIST_HITS) return;
  try {
    const ref = request.headers.get("Referer") || "";
    let site = "(none)";
    if (ref) {
      try {
        site = new URL(ref).host;
      } catch {
        site = "(unparseable)";
      }
    }
    // The version is the first path segment when there is more than one —
    // /dist/0.4.1/element.js — and absent on a bare /dist/element.js.
    const version = parts.length > 1 ? parts[0] : "(unversioned)";
    env.DIST_HITS.writeDataPoint({
      // One index, and the site is the thing worth grouping by.
      indexes: [site],
      blobs: [site, version, key],
    });
  } catch {
    /* analytics must never be able to fail a file the page is waiting for */
  }
}

async function handleR2(env, key, request) {
  if (!env.ASSETS) {
    return jsonResponse({ error: "R2 bucket not configured" }, 500);
  }

  const object = await env.ASSETS.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const ext = key.split(".").pop();
  const headers = new Headers({
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...CORS_HEADERS,
  });

  if (object.httpMetadata?.contentEncoding) {
    headers.set("Content-Encoding", object.httpMetadata.contentEncoding);
  }

  return new Response(object.body, { headers });
}

/**
 * Range-aware R2 handler for demo media (samples/ prefix). Browsers absolutely
 * require HTTP 206 for video seek/scrub on multi-GB files; handleR2's single
 * 200 response would force a full re-download on every seek.
 */
async function handleR2Sample(env, key, request) {
  if (!env.ASSETS) {
    return jsonResponse({ error: "R2 bucket not configured" }, 500);
  }
  const rangeHeader = request.headers.get("Range");
  const ext = key.split(".").pop();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const commonHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...CORS_HEADERS,
  };
  if (request.method === "HEAD") {
    const head = await env.ASSETS.head(key);
    if (!head) return new Response("Not Found", { status: 404 });
    return new Response(null, {
      status: 200,
      headers: { ...commonHeaders, "Content-Length": String(head.size) },
    });
  }
  if (!rangeHeader) {
    const object = await env.ASSETS.get(key);
    if (!object) return new Response("Not Found", { status: 404 });
    return new Response(object.body, {
      headers: { ...commonHeaders, "Content-Length": String(object.size) },
    });
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response("Invalid Range", { status: 416 });
  }
  const head = await env.ASSETS.head(key);
  if (!head) return new Response("Not Found", { status: 404 });
  const total = head.size;
  const start = parseInt(match[1], 10);
  const end = match[2] === "" ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
  if (Number.isNaN(start) || start >= total || end < start) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }
  const length = end - start + 1;
  const object = await env.ASSETS.get(key, { range: { offset: start, length } });
  if (!object) return new Response("Not Found", { status: 404 });
  return new Response(object.body, {
    status: 206,
    headers: {
      ...commonHeaders,
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${total}`,
    },
  });
}

// Upstream badge endpoints, all themed to the site accent (#7c6cf0) and
// explicitly labelled so each one names its platform. Chrome Web Store
// only exposes a "users" count; the VS Code Marketplace and npm expose
// download totals. shields.io retired its visual-studio-marketplace
// badges, so VS Code goes through vsmarketplacebadges.dev instead. The
// npm total-downloads endpoint 301-redirects; Workers fetch follows it.
const BADGE_SOURCES = {
  chrome:
    "https://img.shields.io/chrome-web-store/users/ckleeigcopjnpehkjokijokjegknfgej?label=Chrome%20Web%20Store&color=7c6cf0&labelColor=23232e",
  vscode:
    "https://vsmarketplacebadges.dev/downloads-short/mrujjwalg.movi-player-vscode.svg?label=VS%20Code&color=7c6cf0&labelColor=23232e",
  npm:
    "https://img.shields.io/npm/dt/movi-player?label=npm%20downloads&color=7c6cf0&labelColor=23232e",
};

async function handleBadge(which) {
  if (which !== "jsdelivr" && !BADGE_SOURCES[which]) {
    return new Response("Not Found", { status: 404 });
  }
  try {
    // jsDelivr's own shields badge bakes "/year" into the value; we want the
    // yearly hit count with no period wording, so resolve it to a static
    // shields badge ("jsDelivr | 9.5k"). Everything else proxies directly.
    const src =
      which === "jsdelivr" ? await jsdelivrBadgeUrl() : BADGE_SOURCES[which];
    // `_v` (the deploy timestamp) busts Cloudflare's subrequest cache on every
    // deploy so a redeploy refreshes every badge's count — the upstream badge
    // services ignore the extra param. (jsdelivrBadgeUrl already busts its own
    // stats fetch; this covers the store/npm counts too.)
    const bustedSrc = src + (src.includes("?") ? "&" : "?") + "_v=" + BUILD_VERSION;
    // cf.cacheEverything caches the upstream SVG at the edge for 1h so we don't
    // hit the badge service on every page view. Bound the fetch: a slow badge
    // service (vsmarketplacebadges.dev has stalled 100s+) must never hold the
    // request — and thus the page's <img> and the tab's load spinner — open.
    // On timeout we fall through to the static fallback.
    const upstream = await fetch(bustedSrc, {
      cf: { cacheTtl: 3600, cacheEverything: true },
      headers: { "User-Agent": "movi-app-badge-proxy" },
      signal: AbortSignal.timeout(4000),
    });
    if (!upstream.ok) throw new Error("badge upstream " + upstream.status);
    const svg = await upstream.text();
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml;charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  } catch {
    // Upstream down/changed → serve a static badge so the <img> never
    // renders broken. Short cache so it self-heals when upstream returns.
    const label =
      { chrome: "Chrome Web Store", vscode: "VS Code", npm: "npm downloads", jsdelivr: "jsDelivr" }[which] ||
      "extension";
    const w = Math.max(60, label.length * 7 + 16);
    const fallback =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label} extension">` +
      `<rect width="${w}" height="20" rx="3" fill="#23232e"/>` +
      `<text x="${w / 2}" y="14" fill="#ffffff" font-family="Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle">${label}</text>` +
      `</svg>`;
    return new Response(fallback, {
      headers: {
        "Content-Type": "image/svg+xml;charset=utf-8",
        "Cache-Control": "public, max-age=600",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }
}

// jsDelivr's yearly hit count, resolved to a static shields badge URL so the
// value renders as "9.5k" instead of shields' built-in "9.5k/year" wording.
// Throws on any upstream trouble so handleBadge falls back to a static badge.
async function jsdelivrBadgeUrl() {
  // `_v` (the deploy timestamp) busts Cloudflare's subrequest cache on every
  // deploy, so a redeploy always refreshes the count. The 1h cacheTtl keeps it
  // reasonably fresh between deploys (jsDelivr's own stats update ~daily).
  const stats = await fetch(
    `https://data.jsdelivr.com/v1/stats/packages/npm/movi-player?period=year&_v=${BUILD_VERSION}`,
    {
      cf: { cacheTtl: 3600, cacheEverything: true },
      headers: { "User-Agent": "movi-app-badge-proxy" },
      signal: AbortSignal.timeout(4000),
    },
  );
  if (!stats.ok) throw new Error("jsdelivr stats " + stats.status);
  const data = await stats.json();
  const value = humanizeCount(data?.hits?.total ?? 0);
  return `https://img.shields.io/badge/jsDelivr-${encodeURIComponent(value)}-7c6cf0?labelColor=23232e`;
}

// 9455 → "9.5k", 1_200_000 → "1.2M". Mirrors how shields humanizes counts so
// the jsDelivr badge sits consistently next to the npm one.
function humanizeCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

async function handleStaticAsset(env, key) {
  if (!env.ASSETS) {
    return new Response("Not Found", { status: 404 });
  }

  const object = await env.ASSETS.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const ext = key.split(".").pop();
  return new Response(object.body, {
    headers: {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      // A day, not a year, and not immutable: everything this serves is a
      // MUTABLE file at a fixed URL — the favicons, the touch icon, the social
      // card. `immutable` told every browser that had ever loaded the site to
      // keep the old mark for a year and never ask again, which is exactly
      // what a new logo runs into. The pages carry ?v=<build> on the icons a
      // tab shows, so a deploy still lands instantly; this header is for the
      // ones whose URL has to stay put (the 192/512 the crawler remembers).
      "Cache-Control": "public, max-age=86400",
    },
  });
}

// Referer allowlist for the general-purpose /proxy endpoints. <video>
// media fetches don't send an Origin header, but browsers do send Referer
// (governed by Referrer-Policy). Our own pages produce a moviplayer.com
// Referer; a third-party page doing <video src="https://moviplayer.com/proxy?url=...">
// produces Referer: https://theirsite/... — rejected here so freeloaders
// can't use our worker as an open video CDN.
//
// Same-origin is always allowed (wrangler dev, future custom domains,
// and the /embed iframe which runs on moviplayer.com and therefore
// fetches /proxy as same-origin).
const PROXY_ALLOWED_REFERER_ORIGINS = new Set([
  "https://moviplayer.com",
  "https://www.moviplayer.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

// ─── Signed proxy URLs ─────────────────────────────────────────────────
//
// The Referer allowlist above only constrains *browsers* — a browser won't
// let script forge Referer, so it stops hotlinking. It stops nothing else:
// `curl -H "Referer: https://moviplayer.com"` walks straight through, and
// without a second gate /proxy is an open, anonymising media relay running
// on our bandwidth and our reputation.
//
// So every /proxy request must now carry an HMAC over the exact target URL.
// Signatures come from /api/proxy-sign, which is rate-limited and (when
// Turnstile is configured) requires a session JWT. A leaked signature is
// worth little: it is bound to one URL, so it can't be repointed at
// anything else, and it expires.
//
// The TTL is long because a <video> element re-requests the same signed URL
// for every range as playback proceeds — a short window would break seeking
// in a two-hour film, not just the initial load.
const PROXY_SIG_TTL_MS = 12 * 60 * 60 * 1000;   // 12h
const PROXY_SIGN_RATE_WINDOW_MS = 10 * 60 * 1000;
const PROXY_SIGN_RATE_MAX = 40;                 // signatures per IP per window
const PROXY_MAX_REDIRECTS = 4;

// Hosts serving the fixed demo clips on /examples. Those pages carry no
// Turnstile widget, and gating a handful of public sample files behind a
// bot challenge would buy nothing — the set is closed, so the worst case
// is someone relaying five well-known test videos.
// Hosts we've been asked to stop relaying, per the takedown process in the
// terms. Checked when a signature is minted *and* again on every /proxy
// request — a signature stays valid for 12 hours, so verifying only at
// minting time would leave a blocked host playing for the rest of the day.
//
// Entries match the host and everything under it: "example.com" also blocks
// "cdn.example.com". Add them here, or without redeploying via the
// PROXY_BLOCKED_HOSTS var in wrangler.toml (comma-separated).
const PROXY_BLOCKED_HOSTS = new Set([
  // e.g. "piracy.example",
]);

function isBlockedProxyHost(env, hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const extra = (env?.PROXY_BLOCKED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  for (const blocked of [...PROXY_BLOCKED_HOSTS, ...extra]) {
    if (host === blocked || host.endsWith("." + blocked)) return true;
  }
  return false;
}

const PROXY_UNGATED_HOSTS = new Set([
  "interactive-examples.mdn.mozilla.net",
  "raw.githubusercontent.com",
  "storage.googleapis.com",
  "test-streams.mux.dev",
  "www.soundhelix.com",
]);

function proxySigMessage(targetUrl, expiresAt) {
  return `proxy:${expiresAt}:${targetUrl}`;
}

async function signProxyTarget(env, targetUrl, expiresAt) {
  return hmacSha256Hex(env.ENC_SERVER_SECRET, proxySigMessage(targetUrl, expiresAt));
}

/**
 * Verify the ?exp/?sig pair against the ?url the caller is asking us to
 * fetch. Returns a reason string on failure so the caller can pick a status.
 */
async function verifyProxySignature(env, targetUrl, expRaw, sigGiven) {
  if (!expRaw || !sigGiven) return "missing";
  const expiresAt = Number(expRaw);
  if (!Number.isSafeInteger(expiresAt)) return "malformed";
  if (Date.now() > expiresAt) return "expired";
  // Don't honour a far-future expiry even if it verifies — that would turn a
  // single leaked signature into a permanent one.
  if (expiresAt > Date.now() + PROXY_SIG_TTL_MS) return "malformed";
  const expected = await signProxyTarget(env, targetUrl, expiresAt);
  if (!constantTimeEqual(sigGiven, expected)) return "bad-signature";
  return null;
}

/**
 * fetch() with redirects followed by hand so every hop is re-validated.
 * `redirect: "follow"` checks the host we were given and then quietly goes
 * wherever that host points — a public URL that 302s to a private address
 * defeats isPrivateHost entirely.
 */
async function fetchWithGuardedRedirects(env, targetUrl, init) {
  let current = targetUrl;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return { res };
    const location = res.headers.get("Location");
    if (!location) return { res };
    let next;
    try {
      next = new URL(location, current);
    } catch {
      return { error: "Invalid redirect target" };
    }
    if (!["http:", "https:"].includes(next.protocol)) {
      return { error: "Invalid redirect target" };
    }
    if (isPrivateHost(next.hostname)) {
      return { error: "Redirect to a private address" };
    }
    if (isBlockedProxyHost(env, next.hostname)) {
      return { error: "Redirect to a blocked host" };
    }
    current = next.toString();
  }
  return { error: "Too many redirects" };
}

function isAllowedProxyReferer(request) {
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  let refOrigin;
  try {
    refOrigin = new URL(referer).origin;
  } catch {
    return false;
  }
  try {
    if (refOrigin === new URL(request.url).origin) return true;
  } catch { /* malformed request.url — fall through to allowlist */ }
  return PROXY_ALLOWED_REFERER_ORIGINS.has(refOrigin);
}

// Sniff the first MAGIC_SNIFF_SIZE bytes from a ReadableStream, then
// return a new stream that re-emits the sniffed prefix followed by the
// remaining bytes. `reason` distinguishes "format" (we read bytes and
// they don't match a known container) from "network" (read failed
// mid-stream) so the caller can return 415 vs 502 correctly — a
// transient subrequest failure shouldn't be reported as a format error.
async function sniffAndPassthrough(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < MAGIC_SNIFF_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    reader.cancel().catch(() => {});
    return { ok: false, reason: "network", stream: null };
  }
  const prefix = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    prefix.set(c, off);
    off += c.byteLength;
  }
  if (!hasSupportedSignature(prefix)) {
    reader.cancel().catch(() => {});
    return { ok: false, reason: "format", stream: null };
  }
  const { readable, writable } = new TransformStream();
  (async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(prefix);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      try { await writer.abort(err); } catch { /* noop */ }
    }
  })();
  return { ok: true, stream: readable };
}

// Preflight magic-byte check for Range seeks past byte 0 (we can't
// infer the container signature from mid-file bytes, so we have to
// probe separately). Reads just MAGIC_SNIFF_SIZE bytes off the response
// stream rather than arrayBuffer()-ing the whole thing — matters for
// upstreams that ignore Range and return 200 with the full body.
// Retries once to smooth over transient subrequest failures (CF→CF
// fetches occasionally flake on cold paths).
async function preflightSignatureCheck(env, targetUrl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const hopped = await fetchWithGuardedRedirects(env, targetUrl, {
        method: "GET",
        headers: {
          "Range": `bytes=0-${MAGIC_SNIFF_SIZE - 1}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (hopped.error) return { ok: false, reason: "network" };
      const res = hopped.res;
      if (!res.ok && res.status !== 206) {
        if (attempt === 0) continue;
        return { ok: false, reason: "network" };
      }
      if (!res.body) return { ok: false, reason: "network" };
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < MAGIC_SNIFF_SIZE) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return { ok: hasSupportedSignature(buf), reason: "format" };
    } catch {
      if (attempt === 0) continue;
      return { ok: false, reason: "network" };
    }
  }
  return { ok: false, reason: "network" };
}

/**
 * POST /api/proxy-sign — mint a signed /proxy URL for one specific target.
 *
 * This is the choke point that /proxy itself can't be: a browser sends a real
 * Origin here and can't forge it, and when Turnstile is configured the caller
 * must also hold a session JWT, so a script can't mint signatures in bulk.
 * Everything downstream is then just signature verification — no per-range
 * database work while a video plays.
 */
async function handleProxySign(request, env) {
  if (!isAllowedEncOrigin(request)) {
    return jsonResponse({ error: "Origin not allowed" }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const targetUrl = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!targetUrl) {
    return jsonResponse({ error: "url required" }, 400);
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return jsonResponse({ error: "Only HTTP(S) URLs allowed" }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: "Private URLs not allowed" }, 403);
  }
  if (isBlockedProxyHost(env, parsed.hostname)) {
    return jsonResponse({ error: "This host is blocked" }, 451);
  }

  // Bot gate. Same fall-open behaviour as /api/token and /api/comments so a
  // fork without a Turnstile secret still runs — it just has no gate.
  if (env.TURNSTILE_SECRET_KEY && !PROXY_UNGATED_HOSTS.has(parsed.hostname)) {
    const auth = request.headers.get("Authorization") || "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (!(await verifySessionJwt(env, jwt, ip))) {
      return jsonResponse({ error: "Session required" }, 401);
    }
  } else if (!env.TURNSTILE_SECRET_KEY) {
    console.warn("TURNSTILE_SECRET_KEY missing — /api/proxy-sign has no bot gate");
  }

  const expiresAt = Date.now() + PROXY_SIG_TTL_MS;
  const sig = await signProxyTarget(env, targetUrl, expiresAt);
  return jsonResponse({
    url: `/proxy?url=${encodeURIComponent(targetUrl)}&exp=${expiresAt}&sig=${sig}`,
    expiresAt,
  });
}

async function handleProxy(request, url, env) {
  if (!isAllowedProxyReferer(request)) {
    return jsonResponse({ error: "Referer not allowed" }, 403);
  }

  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "url parameter required" }, 400);
  }

  // The signature is the real gate — see the note above the helpers. It has
  // to be checked before anything else, so no unsigned request can reach an
  // upstream fetch, an R2 read, or a redirect.
  const sigFailure = await verifyProxySignature(
    env,
    targetUrl,
    url.searchParams.get("exp"),
    url.searchParams.get("sig"),
  );
  if (sigFailure) {
    const status = sigFailure === "expired" ? 410 : 403;
    return jsonResponse({ error: `Proxy signature ${sigFailure}` }, status);
  }

  // Validate URL
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }

  // Same-origin target → never self-fetch. A fetch() back to our own zone is
  // routed by Cloudflare to a (non-existent) origin and times out with a 522.
  // These URLs have no CORS problem anyway: serve /samples/* straight from R2,
  // and redirect any other same-origin path to itself so it re-enters routing.
  if (parsed.origin === url.origin) {
    if (env?.ASSETS && parsed.pathname.startsWith("/samples/")) {
      return handleR2Sample(env, parsed.pathname.slice(1), request);
    }
    return Response.redirect(parsed.toString(), 302);
  }

  // Block private/local IPs (SSRF protection)
  if (isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: "Private URLs not allowed" }, 403);
  }

  // Re-checked here, not just at signing, so a takedown takes effect the
  // moment it lands rather than when the last signature expires.
  if (isBlockedProxyHost(env, parsed.hostname)) {
    return jsonResponse({ error: "This host is blocked" }, 451);
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return jsonResponse({ error: "Only HTTP(S) URLs allowed" }, 400);
  }

  // Forward Range header for video seeking
  const headers = new Headers();
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    headers.set("Range", rangeHeader);
  }

  // Forward User-Agent to avoid blocks
  headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    const hopped = await fetchWithGuardedRedirects(env, targetUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    });
    if (hopped.error) {
      return jsonResponse({ error: hopped.error }, 403);
    }
    const response = hopped.res;

    if (!response.ok && response.status !== 206) {
      return jsonResponse({ error: `Upstream returned ${response.status}` }, response.status);
    }

    // Check content type
    const contentType = response.headers.get("Content-Type") || "";
    const isAllowed = ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t));

    // Also allow if no content-type (some servers don't send it for raw files)
    if (!isAllowed && contentType && !contentType.startsWith("application/")) {
      return jsonResponse({ error: "Content type not allowed: " + contentType }, 403);
    }

    // Magic-byte check: upstream Content-Type can lie, so also verify
    // the actual file signature. Inline when the body starts at byte 0
    // (no Range or Range: bytes=0-…); preflight when the body starts
    // mid-file. HEAD requests have no body to check, and the follow-up
    // GET will get magic-checked anyway — skip the subrequest on HEAD
    // so a flaky CF-to-CF probe can't fail the metadata request.
    //
    // A range that starts at 0 but stops before the sniff window (e.g. the
    // `bytes=0-0` size probe the player uses to read Content-Range) can't carry
    // a signature inline — sniffing it would wrongly 415. Treat those like a
    // mid-file range so they're verified via a separate preflight fetch and the
    // tiny body passes through untouched.
    const zeroRange = rangeHeader ? /^bytes=0-(\d*)$/i.exec(rangeHeader) : null;
    const startsAtZero =
      !rangeHeader ||
      (!!zeroRange &&
        (zeroRange[1] === "" ||
          parseInt(zeroRange[1], 10) >= MAGIC_SNIFF_SIZE - 1));
    let body = response.body;
    if (request.method !== "HEAD") {
      if (!startsAtZero) {
        const result = await preflightSignatureCheck(env, targetUrl);
        if (!result.ok) {
          const status = result.reason === "format" ? 415 : 502;
          const message = result.reason === "format"
            ? "Unsupported file format"
            : "Upstream probe failed";
          return jsonResponse({ error: message }, status);
        }
      } else if (body) {
        const sniffed = await sniffAndPassthrough(body);
        if (!sniffed.ok) {
          const status = sniffed.reason === "format" ? 415 : 502;
          const message = sniffed.reason === "format"
            ? "Unsupported file format"
            : "Upstream probe failed";
          return jsonResponse({ error: message }, status);
        }
        body = sniffed.stream;
      }
    }

    // Build response headers
    const respHeaders = new Headers({
      ...CORS_HEADERS,
      "Cross-Origin-Resource-Policy": "cross-origin",
    });

    // Pass through important headers
    const passHeaders = [
      "Content-Type", "Content-Length", "Content-Range",
      "Accept-Ranges", "Content-Disposition",
    ];
    for (const h of passHeaders) {
      const val = response.headers.get(h);
      if (val) respHeaders.set(h, val);
    }

    // Never cache third-party media on our edge. The proxy exists only to
    // solve CORS for a URL the visitor typed; storing a copy of someone
    // else's video for a day makes us a host rather than a conduit.
    respHeaders.set("Cache-Control", "private, no-store");

    // Stream the response body (no buffering)
    return new Response(body, {
      status: response.status,
      headers: respHeaders,
    });
  } catch (err) {
    return jsonResponse({ error: "Fetch failed: " + err.message }, 502);
  }
}

// Encrypted-playback proxy — forwards to upstream auth-protected endpoints.
//
// Differs from handleProxy in that it:
//   - Allows POST (for token issuance) in addition to GET/HEAD
//   - Forwards the request body
//   - Forwards ALL custom auth headers (Authorization, X-Token,
//     X-Fingerprint, X-Nonce, X-Timestamp, X-Signature) so the upstream
//     can validate the signed request the player generated
//   - Passes JSON content-types through (token endpoint response)
//   - Never caches (every request carries a one-time nonce; caching would
//     both break security and serve stale tokens)
async function handleEncryptedProxy(request, url) {
  if (!isAllowedProxyReferer(request)) {
    return jsonResponse({ error: "Referer not allowed" }, 403);
  }

  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "url parameter required" }, 400);
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }

  // SSRF protection — block private/loopback targets when the worker is
  // reachable from the public internet. In local dev (wrangler dev on
  // localhost) we're already local, so allow localhost targets to talk
  // to a dev encrypted-server.
  const reqHost = new URL(request.url).hostname;
  const workerIsLocal = reqHost === "localhost" || reqHost === "127.0.0.1";
  if (!workerIsLocal && isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: "Private URLs not allowed" }, 403);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return jsonResponse({ error: "Only HTTP(S) URLs allowed" }, 400);
  }

  // Only allow methods the encrypted flow uses; block everything else so
  // this isn't a general open proxy.
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(method)) {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Forward auth-related headers (plus Range, Content-Type, Content-Length).
  // Static header list — anything the player sets must be listed here to
  // survive the proxy hop.
  const passReqHeaders = [
    "Authorization",
    "Content-Type",
    "Content-Length",
    "Range",
    "X-Token",
    "X-Fingerprint",
    "X-Nonce",
    "X-Timestamp",
    "X-Signature",
  ];
  const headers = new Headers();
  for (const h of passReqHeaders) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body: method === "POST" ? request.body : undefined,
      redirect: "follow",
    });

    const respHeaders = new Headers({
      ...CORS_HEADERS,
      "Cross-Origin-Resource-Policy": "cross-origin",
      // Tokens rotate every ~2s and every response carries a unique nonce —
      // never cache.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
    });

    const passResHeaders = [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Content-Disposition",
    ];
    for (const h of passResHeaders) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch (err) {
    return jsonResponse({ error: "Fetch failed: " + err.message }, 502);
  }
}

// ─── URL-gated encrypted playback (stateless tokens, HTTPS transit) ────
//
// Flow:
//   1. Client POSTs { url, fingerprint } to /api/token.
//   2. Worker validates the URL, probes it for size, bakes the URL into a
//      short-lived HMAC-signed token, and returns the token + session
//      HMAC secret to the client.
//   3. Client requests /api/video with token + per-request signature.
//   4. Worker verifies the signature, extracts the URL from the token
//      payload, proxies the range request upstream, and streams the
//      response body back.
//
// The upstream URL is never sent in query params or path — it lives only
// inside the signed token payload (opaque base64 to the client), so the
// URL is hidden from DevTools and from anyone replaying the token. HTTPS
// handles transit encryption; we don't add a second AES layer.

const ENC_TOKEN_TTL_MS = 30_000;   // Token valid 30s
const ENC_TIMESTAMP_WINDOW_MS = 10_000; // Request timestamp skew tolerance
const ENC_SESSION_TTL_MS = 60 * 60 * 1000; // Turnstile-issued session valid 1h

// Turnstile siteverify endpoint. When env.TURNSTILE_SECRET_KEY is set,
// /api/token requires a valid session JWT minted by /api/session after
// a successful challenge. If the secret isn't set (dev mode), the gate
// is disabled and everything falls open — surfaced via console.warn.
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Encrypted playback is gated to our own origins. A captured token still
// can't be replayed from a third-party page in a real browser (the browser
// will send their Origin, which this list rejects). Non-browser clients
// (curl, scripts) don't send Origin at all and will be rejected outright.
const ENC_ALLOWED_ORIGINS = new Set([
  "https://moviplayer.com",
  "https://www.moviplayer.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/**
 * Verify the Origin header against the allowlist. Same-origin requests
 * (Origin === worker's own origin) are always allowed — this is how
 * wrangler dev, Pages preview URLs, and any future custom domains keep
 * working without needing to update the static allowlist.
 *
 * Missing Origin is still a reject: browser fetches always include it
 * for POSTs and for any request with credentials, so a missing header
 * indicates a non-browser client (curl, scripts, servers).
 */
function isAllowedEncOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;

  // Same-origin: page and API live on the same worker.
  try {
    const requestOrigin = new URL(request.url).origin;
    if (origin === requestOrigin) return true;
  } catch { /* malformed request.url — fall through to allowlist */ }

  return ENC_ALLOWED_ORIGINS.has(origin);
}

/**
 * Mint a short-lived session JWT after a successful Turnstile challenge.
 * Payload is `{ ip, expiresAt }`; signature binds it to ENC_SERVER_SECRET.
 * /api/token accepts this JWT in the Authorization: Bearer header.
 */
async function issueSessionJwt(env, ip) {
  const expiresAt = Date.now() + ENC_SESSION_TTL_MS;
  const payload = { ip, expiresAt };
  const payloadB64 = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const sig = await hmacSha256Hex(env.ENC_SERVER_SECRET, "session:" + payloadB64);
  return `${payloadB64}.${sig}`;
}

async function verifySessionJwt(env, jwt, requestIp) {
  if (!jwt || typeof jwt !== "string") return false;
  const dot = jwt.lastIndexOf(".");
  if (dot < 0) return false;
  const payloadB64 = jwt.slice(0, dot);
  const sigGiven = jwt.slice(dot + 1);
  const sigExpected = await hmacSha256Hex(
    env.ENC_SERVER_SECRET,
    "session:" + payloadB64,
  );
  if (!constantTimeEqual(sigGiven, sigExpected)) return false;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadB64)),
    );
    if (Date.now() > payload.expiresAt) return false;
    if (payload.ip && payload.ip !== requestIp) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a Turnstile challenge token against Cloudflare's siteverify API.
 * Returns true on valid solve, false otherwise. If TURNSTILE_SECRET_KEY
 * isn't set this is a no-op gate (dev mode) — callers should check the
 * env var themselves to decide whether to require a challenge at all.
 */
async function verifyTurnstileToken(env, token, remoteIp) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    if (remoteIp) form.append("remoteip", remoteIp);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("Turnstile verify failed", err);
    return false;
  }
}

async function handleEncSession(request, env) {
  if (!isAllowedEncOrigin(request)) {
    return jsonResponse({ error: "Origin not allowed" }, 403);
  }
  if (!env.ENC_SERVER_SECRET) {
    return jsonResponse({ error: "ENC_SERVER_SECRET not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const turnstileToken = body?.turnstileToken;

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const gateEnabled = !!env.TURNSTILE_SECRET_KEY;
  if (gateEnabled) {
    const ok = await verifyTurnstileToken(env, turnstileToken, ip);
    if (!ok) {
      return jsonResponse({ error: "Turnstile challenge failed" }, 403);
    }
  } else {
    console.warn("TURNSTILE_SECRET_KEY missing — /api/session falls open");
  }

  const sessionJwt = await issueSessionJwt(env, ip);
  return new Response(
    JSON.stringify({
      sessionJwt,
      expiresAt: Date.now() + ENC_SESSION_TTL_MS,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    },
  );
}

/**
 * Ask the global nonce tracker DO whether this nonce has been seen in
 * the replay window. Returns true if it's a fresh nonce (and records it),
 * false if it's a replay. Falls open (returns true) if the DO binding
 * isn't configured — so dev envs without the binding still work, but a
 * missing binding in production is a silent security downgrade. We log a
 * warning to surface that.
 */
async function checkNonceFresh(env, nonce) {
  if (!env.NONCE_TRACKER) {
    console.warn("NONCE_TRACKER binding missing — replay protection disabled");
    return true;
  }
  try {
    const id = env.NONCE_TRACKER.idFromName("global");
    const stub = env.NONCE_TRACKER.get(id);
    // Window = signature skew tolerance + token lifetime ceiling. A
    // timestamp outside the skew window is already rejected earlier, so
    // storing for ENC_TIMESTAMP_WINDOW_MS + small buffer is enough.
    const res = await stub.fetch("https://do/check", {
      method: "POST",
      body: JSON.stringify({
        nonce,
        ttlMs: ENC_TIMESTAMP_WINDOW_MS + 5_000,
      }),
    });
    const data = await res.json();
    return data.ok === true;
  } catch (err) {
    // DO fetch failures are fail-closed: treating a transient DO outage
    // as a replay is safer than accepting potentially-replayed traffic.
    console.error("Nonce tracker call failed", err);
    return false;
  }
}

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64Encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256Hex(secret, message) {
  const keyBytes =
    typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const arr = new Uint8Array(sig);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function hmacSha256Raw(secretBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBytes));
}

// HKDF-SHA256 expand — derive `length` bytes from a high-entropy input
// key with a distinct `info` label per derivation (master key vs. HMAC
// key vs. wrapping key etc.), so the same shared secret yields multiple
// cryptographically independent sub-keys.
async function hkdf(inputKeyMaterial, info, length = 32, salt) {
  const ikm = await crypto.subtle.importKey(
    "raw",
    inputKeyMaterial,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Per-call salt when the caller supplies one (per-token session
      // derivation does); otherwise zero salt and the info label carries
      // all the domain separation — fine for wrap-key derivation and
      // other fixed-purpose expansions.
      salt: salt ?? new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    ikm,
    length * 8,
  );
  return new Uint8Array(bits);
}

// AES-GCM encrypt with a random 12-byte IV. Output layout:
//   [12-byte IV][ciphertext || 16-byte tag]   (Web Crypto appends tag)
// Returned as one contiguous Uint8Array the client can split directly.
async function aesGcmSeal(rawKey, plaintext) {
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const out = new Uint8Array(iv.length + ctWithTag.length);
  out.set(iv, 0);
  out.set(ctWithTag, iv.length);
  return out;
}

// Fetch the current wrap key from the rotating WrapKeyStore DO. Falls
// back to a deterministic HKDF derivation when the binding is missing
// (dev envs) — logs a warning because that path has no forward secrecy.
async function getCurrentWrapKey(env) {
  if (!env.WRAP_KEY_STORE) {
    console.warn("WRAP_KEY_STORE binding missing — falling back to static wrap key (no PFS)");
    const keyBytes = await hkdf(
      new TextEncoder().encode(env.ENC_SERVER_SECRET),
      "enc:server-priv-wrap",
      32,
    );
    return { epoch: 0, keyBytes };
  }
  const id = env.WRAP_KEY_STORE.idFromName("global");
  const stub = env.WRAP_KEY_STORE.get(id);
  const res = await stub.fetch("https://do/wrap-key");
  const data = await res.json();
  return { epoch: data.epoch, keyBytes: b64Decode(data.keyB64) };
}

// Look up a specific epoch's wrap key from the DO. Returns null if the
// epoch has rolled off the window (≥ 2 epochs old) — in that case the
// token is permanently unrecoverable. The fallback path (no binding)
// accepts any epoch since it's deterministic from the master secret.
async function getWrapKeyForEpoch(env, epoch) {
  if (!env.WRAP_KEY_STORE) {
    const keyBytes = await hkdf(
      new TextEncoder().encode(env.ENC_SERVER_SECRET),
      "enc:server-priv-wrap",
      32,
    );
    return keyBytes;
  }
  const id = env.WRAP_KEY_STORE.idFromName("global");
  const stub = env.WRAP_KEY_STORE.get(id);
  const res = await stub.fetch("https://do/unwrap-key", {
    method: "POST",
    body: JSON.stringify({ epoch }),
  });
  const data = await res.json();
  if (!data.keyB64) return null;
  return b64Decode(data.keyB64);
}

// Wrap the server's ephemeral ECDH private key with the current rotating
// wrap key. The epoch is returned so the token can embed it; unwrap
// looks the key up by epoch. Token-level HMAC signature covers this
// ciphertext AND the epoch, so a tampered wrap is detected before
// we ever decrypt.
async function wrapServerPriv(privPkcs8, env) {
  const { epoch, keyBytes } = await getCurrentWrapKey(env);
  const sealed = await aesGcmSeal(keyBytes, privPkcs8);
  return { wrapped: b64Encode(sealed), wrapEpoch: epoch };
}

async function unwrapServerPriv(wrappedB64, wrapEpoch, env) {
  const keyBytes = await getWrapKeyForEpoch(env, wrapEpoch);
  if (!keyBytes) {
    // Wrap key for this epoch has been rotated off — token permanently
    // unrecoverable. Throw to surface as "Key derivation failed".
    throw new Error("Wrap key for epoch not found");
  }
  const sealed = b64Decode(wrappedB64);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const iv = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}

// ECDH shared-secret derivation from the server's ephemeral private key
// and the client's ephemeral public key. Result is hashed+expanded via
// HKDF into two sub-keys: `master` (AES-GCM, for response body
// encryption) and `hmac` (for per-request signature verification).
async function deriveSessionKeys(serverPrivPkcs8, clientPubRaw, salt) {
  const privKey = await crypto.subtle.importKey(
    "pkcs8",
    serverPrivPkcs8,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const pubKey = await crypto.subtle.importKey(
    "raw",
    clientPubRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: pubKey },
    privKey,
    256,
  );
  const shared = new Uint8Array(sharedBits);
  // `salt` is the per-token random bytes embedded in the signed token
  // payload. Falls through to hkdf's zero-salt default when the token
  // predates this field, preserving compatibility with in-flight
  // pre-deploy tokens until they expire.
  const masterBytes = await hkdf(shared, "enc:master-aes", 32, salt);
  const hmacBytes = await hkdf(shared, "enc:req-hmac", 32, salt);
  return { masterBytes, hmacBytes };
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Parse a Content-Disposition header into just the filename (no
 * extension stripping — caller decides). Handles both `filename*=UTF-8''`
 * percent-encoded form and the plain `filename=` form, quoted or not.
 */
function parseContentDispositionFilename(header) {
  if (!header) return null;
  let m = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\s]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  m = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (!m) m = header.match(/filename\s*=\s*([^;]+)/i);
  if (m) {
    const raw = m[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * HEAD upstream (fallback to small range GET) to learn Content-Length +
 * Content-Disposition. Returns both so the token endpoint can pre-compute
 * the human-readable filename and hand it to the client — in encrypted
 * mode the client otherwise has no plain path to this upstream metadata.
 */
async function probeUpstreamMeta(url, signal) {
  const tryHead = async () => {
    try {
      const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
        },
      });
      if (!res.ok) return null;
      return {
        size: res.headers.get("Content-Length")
          ? parseInt(res.headers.get("Content-Length"), 10)
          : -1,
        disposition: res.headers.get("Content-Disposition"),
      };
    } catch {
      return null;
    }
  };

  const head = await tryHead();
  if (head && head.size >= 0) return head;

  // Fallback: tiny range GET to coax Content-Range / Content-Disposition.
  try {
    const probe = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: {
        Range: "bytes=0-0",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
      },
    });
    try { probe.body?.cancel(); } catch { /* noop */ }
    let size = -1;
    const contentRange = probe.headers.get("Content-Range");
    if (contentRange) {
      const total = contentRange.split("/")[1];
      if (total && total !== "*") size = parseInt(total, 10);
    }
    if (size < 0 && probe.headers.get("Content-Length")) {
      size = parseInt(probe.headers.get("Content-Length"), 10);
    }
    return { size, disposition: probe.headers.get("Content-Disposition") };
  } catch {
    return { size: -1, disposition: null };
  }
}

/**
 * POST /api/token — issue a short-lived token + perform an ephemeral
 * ECDH exchange. The client's public key comes in the request body; the
 * server returns its own ephemeral public key and embeds its ephemeral
 * private key (AES-wrapped) inside the signed token. On subsequent
 * /api/video calls the worker unwraps the private key and re-derives the
 * shared secret, so no session state lives outside the token itself.
 *
 * Neither side ever transmits the raw master AES key or HMAC secret —
 * both are HKDF-derived from the ECDH shared secret on each peer, so an
 * eavesdropper capturing the entire handshake still can't read the
 * session keys.
 */
async function handleEncToken(request, env) {
  if (!env.ENC_SERVER_SECRET) {
    return jsonResponse({ error: "ENC_SERVER_SECRET not configured" }, 500);
  }

  if (!isAllowedEncOrigin(request)) {
    return jsonResponse({ error: "Origin not allowed" }, 403);
  }

  // Turnstile gate: if a site secret is configured, /api/token requires
  // a valid session JWT in Authorization: Bearer. Without the secret set
  // this check is bypassed (dev mode) — a warning is logged so the gap
  // is visible in logs.
  if (env.TURNSTILE_SECRET_KEY) {
    const auth = request.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const jwt = m ? m[1].trim() : "";
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const ok = await verifySessionJwt(env, jwt, ip);
    if (!ok) {
      return jsonResponse(
        { error: "Session challenge required", code: "NEED_SESSION" },
        401,
      );
    }
  } else {
    // Turnstile is opt-in. No secret set = no bot gate, which is fine
    // for forks that don't want to run a Cloudflare account. See the
    // wrangler.toml comment block for setup instructions.
    console.warn("TURNSTILE_SECRET_KEY not set — /api/token has no bot gate (this is fine for forks; see wrangler.toml to enable)");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { fingerprint, clientPubKey } = body || {};
  const rawUrl = body?.url || body?.videoId;
  if (!rawUrl || !fingerprint || !clientPubKey) {
    return jsonResponse(
      { error: "Missing url, fingerprint, or clientPubKey" },
      400,
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return jsonResponse({ error: "Only HTTP(S) URLs allowed" }, 400);
  }

  const reqHost = new URL(request.url).hostname;
  const workerIsLocal = reqHost === "localhost" || reqHost === "127.0.0.1";
  if (!workerIsLocal && isPrivateHost(parsed.hostname)) {
    return jsonResponse({ error: "Private URLs not allowed" }, 403);
  }

  // Validate the client's public key up front — better to reject a
  // malformed key here than silently fail on /api/video.
  let clientPubBytes;
  try {
    clientPubBytes = b64Decode(clientPubKey);
    await crypto.subtle.importKey(
      "raw",
      clientPubBytes,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    return jsonResponse({ error: "Invalid clientPubKey" }, 400);
  }

  // Ephemeral server ECDH keypair — one pair per token. Private key is
  // wrapped into the token so the worker can recover it without any
  // external state.
  const keypair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const serverPubRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keypair.publicKey),
  );
  const serverPrivPkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keypair.privateKey),
  );
  const { wrapped: wrappedServerPriv, wrapEpoch } = await wrapServerPriv(
    serverPrivPkcs8,
    env,
  );

  const probe = await probeUpstreamMeta(parsed.toString());
  const fileSize = probe.size;
  const dispositionFilename = parseContentDispositionFilename(probe.disposition);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const expiresAt = Date.now() + ENC_TOKEN_TTL_MS;

  // Per-token random 32-byte HKDF salt. Folded into both the master-AES
  // and req-HMAC sub-key derivations so two tokens that happened to
  // derive from identical ECDH shared secrets (astronomically unlikely
  // but cheap defense-in-depth) still produce distinct session keys.
  // Embedded in the signed payload so the /api/video handler can
  // recover it alongside the wrapped private key; echoed in the JSON
  // response so the client uses the same value locally.
  const hkdfSaltBytes = crypto.getRandomValues(new Uint8Array(32));
  const hkdfSaltB64 = b64Encode(hkdfSaltBytes);

  const payload = {
    url: parsed.toString(),
    ip,
    fingerprint,
    expiresAt,
    clientPubKey,      // public, round-trips back for signature coverage
    wrappedServerPriv, // AES-wrapped with the current wrap epoch's key
    wrapEpoch,         // which rotating wrap key sealed wrappedServerPriv
    hkdfSalt: hkdfSaltB64, // per-token HKDF salt for session key derivation
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSha256Hex(env.ENC_SERVER_SECRET, payloadB64);
  const token = `${payloadB64}.${sig}`;

  return new Response(
    JSON.stringify({
      token,
      expiresAt,
      fileSize: fileSize > 0 ? fileSize : 0,
      chunkSize: 2 * 1024 * 1024,
      // Server's ephemeral public key — client needs this to derive the
      // shared secret locally. Public, safe to send in the clear.
      serverPubKey: b64Encode(serverPubRaw),
      // Upstream's Content-Disposition filename (if any). We parse it
      // server-side during the probe and hand it over so the client
      // doesn't need to re-parse the header, and so encrypted mode
      // (which otherwise doesn't expose upstream headers) can still
      // populate the title overlay via the real filename.
      contentDispositionFilename: dispositionFilename,
      // Per-token HKDF salt — same value is inside the signed payload,
      // we just need to hand it to the client in the clear so it can
      // derive matching session keys locally. Token HMAC covers the
      // payload copy so a network attacker can't substitute a different
      // salt on either side.
      hkdfSalt: hkdfSaltB64,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    },
  );
}

/** Verify a stateless token, return payload or null. */
async function verifyEncToken(token, serverSecret) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigGiven = token.slice(dot + 1);
  const sigExpected = await hmacSha256Hex(serverSecret, payloadB64);
  if (!constantTimeEqual(sigGiven, sigExpected)) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payloadB64));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * GET/HEAD /api/video — authenticate, proxy to the token-embedded URL,
 * AES-GCM encrypt the response body with a session key the client
 * derived via ECDH, and return [IV || ciphertext || tag]. Raw keys never
 * transit the network — only public ECDH material + AES-wrapped server
 * private key does, and the wrap key is the worker's server secret.
 */
async function handleEncVideo(request, env) {
  if (!env.ENC_SERVER_SECRET) {
    return jsonResponse({ error: "ENC_SERVER_SECRET not configured" }, 500);
  }

  // No Origin check here. Browsers omit the Origin header on same-origin
  // GET requests, which would break the player locally and in prod. The
  // endpoint is already authenticated via the HMAC-signed token, the
  // per-request ECDH-keyed signature, the nonce replay check, and the
  // fingerprint/IP pinning on the token — a stray third-party page
  // can't construct any of those without a valid /api/token round-trip,
  // which IS still Origin-gated.

  const token = request.headers.get("X-Token");
  const fingerprint = request.headers.get("X-Fingerprint");
  const nonce = request.headers.get("X-Nonce");
  const tsHeader = request.headers.get("X-Timestamp");
  const signature = request.headers.get("X-Signature");
  if (!token || !fingerprint || !nonce || !tsHeader || !signature) {
    return jsonResponse({ error: "Missing auth headers" }, 401);
  }

  const timestamp = parseInt(tsHeader, 10);
  if (Math.abs(Date.now() - timestamp) > ENC_TIMESTAMP_WINDOW_MS) {
    return jsonResponse({ error: "Request too old or too far in future" }, 403);
  }

  const payload = await verifyEncToken(token, env.ENC_SERVER_SECRET);
  if (!payload) return jsonResponse({ error: "Invalid token" }, 401);
  if (Date.now() > payload.expiresAt) {
    return jsonResponse({ error: "Token expired" }, 401);
  }
  if (payload.fingerprint !== fingerprint) {
    return jsonResponse({ error: "Fingerprint mismatch" }, 403);
  }
  const reqIp = request.headers.get("CF-Connecting-IP") || "";
  if (payload.ip && payload.ip !== reqIp) {
    return jsonResponse({ error: "IP mismatch" }, 403);
  }
  if (!payload.url || !payload.clientPubKey || !payload.wrappedServerPriv) {
    return jsonResponse({ error: "Malformed token" }, 400);
  }

  // Recover the server's ephemeral ECDH private key from the token and
  // derive the same session keys the client derived locally. The wrap
  // epoch came from the token payload — if it's aged off the rotation
  // window the unwrap helper throws and we return the generic error.
  let masterBytes;
  let hmacBytes;
  try {
    const serverPrivPkcs8 = await unwrapServerPriv(
      payload.wrappedServerPriv,
      payload.wrapEpoch ?? 0,
      env,
    );
    const clientPubRaw = b64Decode(payload.clientPubKey);
    // hkdfSalt absence means the token predates the salted-HKDF change;
    // deriveSessionKeys falls back to zero salt in that case so such a
    // token keeps working until it expires (≤30s).
    const saltBytes = payload.hkdfSalt
      ? b64Decode(payload.hkdfSalt)
      : undefined;
    const derived = await deriveSessionKeys(serverPrivPkcs8, clientPubRaw, saltBytes);
    masterBytes = derived.masterBytes;
    hmacBytes = derived.hmacBytes;
  } catch (err) {
    return jsonResponse({ error: "Key derivation failed" }, 400);
  }

  // Parse Range + signed length. EncryptedHttpSource always sends a
  // bounded range when decrypting per-request; open-ended signs as 0.
  const range = request.headers.get("Range");
  let start = 0;
  let endForSig = 0;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    start = parseInt(parts[0], 10) || 0;
    const endRaw = parts[1] ? parseInt(parts[1], 10) : -1;
    endForSig = endRaw >= 0 ? endRaw - start + 1 : 0;
  }

  // Verify per-request HMAC signed with the ECDH-derived hmac key. Method
  // is bound in so an attacker can't lift a GET signature and replay it as
  // HEAD (or vice-versa) — each method now has a distinct signing domain.
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const message = `${method}:${token}:${nonce}:${timestamp}:${start}:${endForSig}`;
  const expectedSigBytes = await hmacSha256Raw(
    hmacBytes,
    new TextEncoder().encode(message),
  );
  let expectedSigHex = "";
  for (const b of expectedSigBytes) expectedSigHex += b.toString(16).padStart(2, "0");
  if (!constantTimeEqual(signature, expectedSigHex)) {
    return jsonResponse({ error: "Invalid signature" }, 403);
  }

  // Post-signature replay check: a valid signature for a nonce we've
  // already seen means the tuple is being replayed within the skew
  // window. Reject it. Running this AFTER signature verification means
  // an attacker sending garbage can't probe the DO for free.
  const fresh = await checkNonceFresh(env, nonce);
  if (!fresh) {
    return jsonResponse({ error: "Nonce replay detected" }, 403);
  }

  // Proxy to upstream URL. Only forward Range + User-Agent; the player's
  // auth ends at the worker, upstream stays oblivious.
  const upstreamHeaders = new Headers();
  if (range) upstreamHeaders.set("Range", range);
  upstreamHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
  );

  let upstream;
  try {
    upstream = await fetch(payload.url, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return jsonResponse({ error: "Upstream fetch failed: " + err.message }, 502);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonResponse(
      { error: `Upstream returned ${upstream.status}` },
      upstream.status,
    );
  }

  // HEAD: no body to encrypt, just echo back the auth-gated status.
  if (request.method === "HEAD") {
    const headHeaders = new Headers({
      "Cache-Control": "no-store, no-cache",
      "Cross-Origin-Resource-Policy": "cross-origin",
      ...CORS_HEADERS,
    });
    for (const h of ["Content-Type", "Content-Length", "Accept-Ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headHeaders.set(h, v);
    }
    return new Response(null, { status: upstream.status, headers: headHeaders });
  }

  // Peek the first chunk of the upstream body and retry the fetch if it
  // closes immediately with no data. Observed behavior under concurrent
  // load: certain byte ranges return 206 OK headers but `done=true` on
  // first reader.read() — the body is empty. Faithfully passing that
  // empty body through to the client surfaces as "Stream ended before
  // block N" errors and wedges the thumbnail/playback consumer. A small
  // retry loop here is fully transparent: by the time we return the
  // Response below we either have a real chunk in hand or we've given
  // up and return 502 so the client retries via its own error path.
  const MAX_UPSTREAM_RETRIES = 2;
  let upstreamReader = null;
  let firstChunk = null;
  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    if (attempt > 0) {
      // Re-issue the upstream fetch from scratch. Don't reuse the prior
      // upstream's body — we already drained it (it was empty).
      try {
        upstream = await fetch(payload.url, {
          method: "GET",
          headers: upstreamHeaders,
          redirect: "follow",
        });
      } catch {
        upstream = null;
      }
      if (!upstream || (!upstream.ok && upstream.status !== 206)) continue;
    }
    if (!upstream.body) continue;
    const reader = upstream.body.getReader();
    let probe;
    try {
      probe = await reader.read();
    } catch {
      try { reader.releaseLock(); } catch { /* noop */ }
      continue;
    }
    if (!probe.done && probe.value && probe.value.length > 0) {
      upstreamReader = reader;
      firstChunk = probe.value;
      break;
    }
    // Empty body — release the reader and either retry or bail.
    try { reader.releaseLock(); } catch { /* noop */ }
    try { await upstream.body.cancel(); } catch { /* noop */ }
  }
  if (!upstreamReader) {
    return jsonResponse(
      { error: "Upstream returned empty body after retries" },
      502,
    );
  }

  // Stream-and-encrypt the upstream body in fixed 2MB plaintext frames.
  // Each frame is its own self-contained AES-GCM message so the client
  // can decrypt frames progressively as they arrive (SAB-style
  // streaming) instead of waiting for the whole response. Framing:
  //
  //   [4-byte BE length of (IV || CT || Tag)]
  //   [12-byte IV]
  //   [ciphertext || 16-byte tag]
  //
  // Repeated for every frame until the upstream stream closes. Frame
  // length is bounded so the worker's memory per decrypt stays < 3MB
  // regardless of how large the client's requested range is.
  const FRAME_PLAINTEXT = 2 * 1024 * 1024;
  const aesKey = await crypto.subtle.importKey(
    "raw",
    masterBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const respHeaders = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store, no-cache",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Enc-Envelope": "aes-gcm-framed-iv12-tag16",
    "X-Enc-Frame-Size": String(FRAME_PLAINTEXT),
    ...CORS_HEADERS,
  });
  const upstreamContentRange = upstream.headers.get("Content-Range");
  if (upstreamContentRange) respHeaders.set("Content-Range", upstreamContentRange);
  const upstreamAcceptRanges = upstream.headers.get("Accept-Ranges");
  if (upstreamAcceptRanges) respHeaders.set("Accept-Ranges", upstreamAcceptRanges);
  const upstreamDisposition = upstream.headers.get("Content-Disposition");
  if (upstreamDisposition) respHeaders.set("Content-Disposition", upstreamDisposition);

  // If upstream ignored the Range header (status 200 instead of 206) we
  // need to enforce the slice ourselves. Some origins return the full
  // body regardless of Range; we cannot just blindly restream that —
  // the client asked for an 18 MB block window, handing back the whole
  // 3 GB file would waste bandwidth, worker CPU, and pipeline the next
  // legitimate request behind a monster download. Track how many bytes
  // to skip (before `start`) and how many to emit, then abort once the
  // window is full.
  const rangeHonored = upstream.status === 206;
  let bytesToSkip = 0;
  let bytesToEmit = -1; // -1 = unknown/unlimited (no Range, no file size)
  if (range) {
    if (rangeHonored) {
      // Upstream already trimmed; we just cap at the requested span as
      // a defensive measure so a misbehaving origin can't balloon.
      bytesToEmit = endForSig > 0 ? endForSig : -1;
    } else {
      // Upstream returned the whole file — skip past `start`, then emit
      // (end - start + 1) bytes, drop the rest.
      bytesToSkip = start;
      bytesToEmit = endForSig > 0 ? endForSig : -1;
    }
  }

  // Pipeline: while an encrypt is running, let the next read() pull more
  // upstream bytes in parallel. The previous implementation awaited each
  // emitFrame() before reading again, which serialized the whole pipeline
  // on the encrypt step — upstream ingress and AES-GCM couldn't overlap.
  // A bounded 2-deep pipeline recovers most of the overlap while keeping
  // memory use predictable (at most ~4 MB of in-flight plaintext/cipher
  // buffers per stream).
  const PIPELINE_DEPTH = 2;

  const outStream = new ReadableStream({
    async start(controller) {
      // Reader was already opened during the empty-body peek above; the
      // first chunk we read from it is sitting in `firstChunk` and must
      // be replayed before resuming reads.
      const reader = upstreamReader;
      let pendingFirstChunk = firstChunk;
      // Fresh buffer per frame so the in-flight pipeline promises don't
      // race against the next-frame accumulation path writing into the
      // same memory.
      let pending = new Uint8Array(FRAME_PLAINTEXT);
      let pendingLen = 0;

      // FIFO of encrypt promises. Each resolves to { iv, ctTag } ready
      // to be framed and pushed to the response stream.
      const pipeline = [];

      const kickEncrypt = (plaintext) => {
        if (plaintext.length === 0) return;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const p = crypto.subtle
          .encrypt({ name: "AES-GCM", iv }, aesKey, plaintext)
          .then((ctBuf) => ({ iv, ctTag: new Uint8Array(ctBuf) }));
        pipeline.push(p);
      };

      const drainOneFrame = async () => {
        const { iv, ctTag } = await pipeline.shift();
        const header = new Uint8Array(4);
        // Big-endian length of (IV + ciphertext + tag).
        new DataView(header.buffer).setUint32(0, iv.length + ctTag.length, false);
        controller.enqueue(header);
        controller.enqueue(iv);
        controller.enqueue(ctTag);
      };

      let emitted = 0;
      let skipped = 0;
      let firstFrameEmitted = false;
      try {
        outer: while (true) {
          let done;
          let value;
          if (pendingFirstChunk) {
            value = pendingFirstChunk;
            pendingFirstChunk = null;
            done = false;
          } else {
            ({ done, value } = await reader.read());
          }
          if (done) break;
          if (!value || value.length === 0) continue;

          let v = value;

          // If upstream returned the whole file (status 200) despite our
          // Range request, burn off the prefix before the requested start
          // offset without passing it through encrypt or the client.
          if (bytesToSkip > skipped) {
            const toSkip = Math.min(bytesToSkip - skipped, v.length);
            skipped += toSkip;
            v = v.subarray(toSkip);
            if (v.length === 0) continue;
          }

          // Cap the post-skip bytes to the requested window. Anything
          // past that is surplus from an ignored Range — drop it and
          // abort the upstream connection so we don't keep pulling
          // bytes nobody wanted.
          if (bytesToEmit >= 0) {
            const remaining = bytesToEmit - emitted;
            if (remaining <= 0) {
              try { reader.cancel("range complete"); } catch { /* noop */ }
              break outer;
            }
            if (v.length > remaining) {
              v = v.subarray(0, remaining);
            }
          }
          emitted += v.length;

          while (v.length > 0) {
            const space = FRAME_PLAINTEXT - pendingLen;
            if (v.length < space) {
              pending.set(v, pendingLen);
              pendingLen += v.length;
              break;
            }
            pending.set(v.subarray(0, space), pendingLen);
            const frameBuf = pending;
            pending = new Uint8Array(FRAME_PLAINTEXT);
            pendingLen = 0;
            kickEncrypt(frameBuf);
            // Drain the first frame immediately (without waiting for
            // pipeline to fill) so the client sees first bytes ASAP.
            // After that, let the pipeline fill to PIPELINE_DEPTH for
            // sustained-throughput overlap between ingress + encrypt.
            // Waiting for pipeline to fill before the first drain adds
            // a whole FRAME_PLAINTEXT of latency to time-to-first-byte —
            // painful on slow upstreams where one frame can be seconds.
            if (!firstFrameEmitted) {
              await drainOneFrame();
              firstFrameEmitted = true;
            } else if (pipeline.length >= PIPELINE_DEPTH) {
              await drainOneFrame();
            }
            v = v.subarray(space);
          }

          // Hit the requested byte count — flush the partial trailing
          // frame and hang up on upstream.
          if (bytesToEmit >= 0 && emitted >= bytesToEmit) {
            try { reader.cancel("range complete"); } catch { /* noop */ }
            break outer;
          }
        }
        if (pendingLen > 0) {
          kickEncrypt(pending.subarray(0, pendingLen));
        }
        // Flush anything still in the pipeline in arrival order.
        while (pipeline.length > 0) {
          await drainOneFrame();
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(outStream, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/**
 * Parse the many legal spellings of an IPv4 literal into four octets, or
 * return null when the host isn't one. Parts may be decimal, hex (0x…) or
 * octal (leading 0), and there may be one to four of them.
 */
function ipv4Octets(host) {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const values = [];
  for (const part of parts) {
    if (part === "") return null;
    let value;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }

  // Every part but the last must fit in one octet; the last absorbs the rest.
  const head = values.slice(0, -1);
  const tail = values[values.length - 1];
  if (head.some((v) => v > 255)) return null;
  const tailMax = Math.pow(256, 4 - head.length);
  if (tail >= tailMax) return null;

  let n = 0;
  for (const v of head) n = n * 256 + v;
  n = n * tailMax + tail;
  return [(n / 16777216) & 255, (n / 65536) & 255, (n / 256) & 255, n & 255];
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Block localhost and private IPs
  if (host === "localhost" || host === "::1" || host === "::") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;

  // IPv6 loopback/link-local/unique-local. Anything with a colon is IPv6;
  // fc00::/7 (fc,fd), fe80::/10 (fe8-feb) and ::ffff:… mapped v4 are all
  // ways to reach something we shouldn't be fetching for a visitor.
  if (host.includes(":")) {
    if (/^f[cd]/.test(host)) return true;
    if (/^fe[89ab]/.test(host)) return true;
    if (host.startsWith("::ffff:")) return isPrivateHost(host.slice(7));
    return false;
  }

  // Dotted-quad is only one of the ways to write an IPv4 address. "127.1",
  // "2130706433" and "0x7f.1" all reach 127.0.0.1, and a check that only
  // understands a.b.c.d waves every one of them through. Normalise to a
  // 32-bit value first, following the same 1-to-4-part rule resolvers use:
  // the last part fills all remaining low octets.
  const octets = ipv4Octets(host);

  if (octets) {
    const [a, b] = octets;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // 127.0.0.0/8 — all of it
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true;                          // multicast + reserved
  }

  return false;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // X-Robots-Tag: noindex rides along in CORS_HEADERS.
      ...CORS_HEADERS,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  Visitor feedback wall — /api/comments
// ═══════════════════════════════════════════════════════════════════════
//
// Comments publish instantly (no approval queue), so every gate has to be
// automatic and server-side:
//
//   1. Turnstile  — same invisible widget the encrypted-playback session
//                   uses. Falls open when TURNSTILE_SECRET_KEY is unset.
//   2. Profanity  — English + Hinglish + Devanagari abuse list, matched
//                   against several de-obfuscated views of the text.
//   3. Links      — any domain outside a small allowlist is rejected. An
//                   unmoderated public wall is an SEO-spam magnet, and
//                   link spam is far more common here than swearing.
//   4. Rate limit — per hashed IP, enforced with a COUNT over D1.
//
// Client-side checks are duplicated in index.html purely for instant
// feedback; they are not the control. Everything below re-validates.

const COMMENT_MAX_NAME = 40;
const COMMENT_MAX_BODY = 1000;
const COMMENT_MIN_BODY = 2;
const COMMENT_PAGE_SIZE = 20;

// Rate limit: at most 3 comments per IP per 10 minutes, and never two
// within 30 seconds of each other.
const COMMENT_RATE_WINDOW_MS = 10 * 60 * 1000;
const COMMENT_RATE_MAX = 3;
const COMMENT_COOLDOWN_MS = 30 * 1000;

// Characters swapped in before matching, so "sh1t" / "f@g" / "@ss" don't
// slip past the word list. Applied only to the throwaway matching copy —
// the stored text is never rewritten.
const LEET_MAP = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
  "7": "t", "8": "b", "@": "a", "$": "s", "!": "i",
  "|": "i", "+": "t", "€": "e", "£": "l",
};

/**
 * Compile a word list into a single letter-bounded alternation.
 *
 * `\b` is the wrong boundary here: it treats digits as word characters,
 * so "\bfuck\b" would miss "fuck1". Explicit letter lookarounds match the
 * word plus any digit/punctuation padding while still refusing to fire in
 * the middle of a longer word.
 */
function buildWordRegex(words) {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![a-z])(?:${escaped.join("|")})(?![a-z])`, "u");
}

// The blocklist itself lives in the profanity_terms table (see schema.sql)
// so terms can be added or retired with a `wrangler d1 execute` instead of
// a redeploy. Only the matching logic lives here.
//
// Loading it per submission would mean a D1 round trip on every comment,
// so the compiled form is cached in the isolate. Workers reuses isolates
// across requests, and each edge location has its own — a term added now
// is live everywhere within PROFANITY_CACHE_MS.
const PROFANITY_CACHE_MS = 5 * 60 * 1000;
let profanityCache = null;
let profanityCachedAt = 0;

/**
 * Fetch the active blocklist and compile it into the three matchers
 * screenCommentText needs. Throws if the list can't be loaded — the caller
 * turns that into a 503 rather than accepting an unscreened comment.
 */
async function loadProfanityFilter(env) {
  const now = Date.now();
  if (profanityCache && now - profanityCachedAt < PROFANITY_CACHE_MS) {
    return profanityCache;
  }

  const { results } = await env.COMMENTS_DB.prepare(
    "SELECT term, kind FROM profanity_terms WHERE active = 1",
  ).all();

  const words = [];
  const phrases = [];
  const strong = [];
  for (const row of results || []) {
    const term = String(row.term || "").toLowerCase();
    if (!term) continue;
    if (row.kind === "word") words.push(term);
    else if (row.kind === "phrase") phrases.push(term);
    else if (row.kind === "strong") strong.push(term);
  }

  // An empty list would silently pass every comment — that's a broken
  // deploy (schema.sql not seeded), not a valid "allow everything" config.
  if (!words.length && !phrases.length && !strong.length) {
    throw new Error("profanity_terms is empty — run schema.sql against this database");
  }

  profanityCache = {
    // buildWordRegex on an empty array would produce `(?:)`, which matches
    // the empty string everywhere and blocks every comment.
    wordRe: words.length ? buildWordRegex(words) : null,
    phrases,
    strong,
  };
  profanityCachedAt = now;
  return profanityCache;
}

/**
 * Fold text into the form the word lists are written in: lowercase, no
 * accents, no zero-width/bidi tricks, leet characters restored, and runs
 * of 3+ identical characters squashed to one ("fuuuuck" → "fuck").
 *
 * The squash stops at runs of 3 on purpose. Collapsing pairs too would
 * turn "ass" into "as", and "as" is a perfectly ordinary word.
 */
function normalizeForFilter(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Recompose after stripping the Latin combining marks. Devanagari
    // nukta letters (ड़ = U+095C) decompose under NFD, and the word list
    // is written in the precomposed form — without this, "भोसड़ी" would
    // arrive as भ+ो+स+ड+़+ी and never match.
    .normalize("NFC")
    // Zero-width joiners/spaces and bidi overrides are the cheapest way to
    // break up a banned word without changing how it renders.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .replace(/[0134578@$!|+€£]/g, (c) => LEET_MAP[c] || c)
    .replace(/(.)\1{2,}/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rejoin letters that were spaced out to dodge the filter — "f u c k",
 * "c.h.u.t", "g-a-n-d". Only runs of 3+ single letters are joined, so
 * ordinary prose ("I do") is left alone.
 */
function joinSpacedLetters(s) {
  return s.replace(
    /(?<![a-z])((?:[a-z][^a-z\n]{1,2}){2,}[a-z])(?![a-z])/g,
    (m) => m.replace(/[^a-z]/g, ""),
  );
}

/**
 * Domains a comment is allowed to mention. Anything else — including bare
 * "spam-site.xyz" with no scheme — gets the comment rejected. Feedback
 * about the player rarely needs an outbound link, and letting them
 * through on an instantly-published page invites SEO spam.
 */
const COMMENT_LINK_ALLOWLIST = new Set([
  "moviplayer.com", "www.moviplayer.com",
  "github.com", "www.github.com",
  "npmjs.com", "www.npmjs.com",
  "youtube.com", "www.youtube.com", "youtu.be",
]);

const DOMAIN_LIKE_RE =
  /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|app|co|in|uk|us|de|ru|cn|xyz|info|biz|top|link|shop|club|online|site|live|me|tv|to|cc|ly|gg|ai|pro|store|vip|win|icu|buzz))\b/gi;

/**
 * Screen one field of a submission against a filter from
 * loadProfanityFilter(). Returns null when it's clean, or a
 * `{ reason, message }` object naming the first rule it broke.
 */
function screenCommentText(text, field, filter) {
  const normalized = normalizeForFilter(text);
  const joined = joinSpacedLetters(normalized);
  const stripped = normalized.replace(/[^a-z0-9\u0900-\u097f]/g, "");

  if (filter.wordRe && (filter.wordRe.test(normalized) || filter.wordRe.test(joined))) {
    return {
      reason: "profanity",
      message: `Please rephrase your ${field} — abusive language isn't allowed here.`,
    };
  }

  for (const phrase of filter.phrases) {
    if (normalized.includes(phrase)) {
      return {
        reason: "profanity",
        message: `Please rephrase your ${field} — abusive language isn't allowed here.`,
      };
    }
  }

  for (const term of filter.strong) {
    if (stripped.includes(term)) {
      return {
        reason: "profanity",
        message: `Please rephrase your ${field} — abusive language isn't allowed here.`,
      };
    }
  }

  // Links. Screened against the raw text, not the normalized copy — leet
  // folding mangles hostnames ("bit.ly" → "bit.iy") and would let some
  // through. DOMAIN_LIKE_RE is /g, so reset lastIndex between calls.
  DOMAIN_LIKE_RE.lastIndex = 0;
  const hosts = [...text.matchAll(DOMAIN_LIKE_RE)].map((m) => m[1].toLowerCase());
  const hasScheme = /https?:\/\/|\bwww\./i.test(text);
  // A bare scheme with no recognizable host ("http://1.2.3.4/x") is still a
  // link, so an empty host list counts as a hit once a scheme is present.
  if (hosts.some((h) => !COMMENT_LINK_ALLOWLIST.has(h)) || (hasScheme && hosts.length === 0)) {
    return { reason: "link", message: "Links aren't allowed in comments." };
  }

  return null;
}

/**
 * SHA-256(ip + secret), truncated to 32 hex chars. Enough to rate-limit
 * on, and — because the secret is mixed in — not reversible by hashing
 * every IPv4 address. Falls back to a constant when ENC_SERVER_SECRET is
 * unset, which collapses all visitors into one rate-limit bucket. That's
 * deliberately conservative: a misconfigured deploy throttles hard rather
 * than accepting unlimited posts.
 */
async function hashCommentIp(env, ip) {
  const data = new TextEncoder().encode(`${ip}|${env.ENC_SERVER_SECRET || "no-secret"}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Strip control characters and clamp length. Stored text stays raw
 * otherwise — the client renders it with textContent, so escaping here
 * would only double-encode legitimate "&" and "<" characters.
 */
function sanitizeCommentField(value, maxLen) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n/g, "\n")
    // Cap consecutive blank lines so one comment can't scroll the page.
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLen);
}

/** GET /api/comments?before=<id> — newest first, paginated by id. */
async function handleCommentsList(env, url) {
  if (!env.COMMENTS_DB) {
    return jsonResponse({ error: "Comments are not configured on this deployment" }, 503);
  }

  const before = Number(url.searchParams.get("before"));
  const hasCursor = Number.isFinite(before) && before > 0;

  try {
    // Top level only — a reply belongs to its parent's card, not to the page,
    // and letting one occupy a page slot would push a real comment off it.
    const rows = hasCursor
      ? await env.COMMENTS_DB.prepare(
          "SELECT id, name, body, rating, created_at FROM comments " +
            "WHERE hidden = 0 AND parent_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?",
        ).bind(before, COMMENT_PAGE_SIZE + 1).all()
      : await env.COMMENTS_DB.prepare(
          "SELECT id, name, body, rating, created_at FROM comments " +
            "WHERE hidden = 0 AND parent_id IS NULL ORDER BY id DESC LIMIT ?",
        ).bind(COMMENT_PAGE_SIZE + 1).all();

    const all = rows.results || [];
    // We asked for one extra row purely to learn whether more exist.
    const hasMore = all.length > COMMENT_PAGE_SIZE;
    const page = hasMore ? all.slice(0, COMMENT_PAGE_SIZE) : all;

    // One query for the whole page's replies rather than one per card.
    const repliesBy = new Map();
    if (page.length) {
      const marks = page.map(() => "?").join(",");
      const rep = await env.COMMENTS_DB.prepare(
        "SELECT id, name, body, created_at, parent_id, author_role FROM comments " +
          `WHERE hidden = 0 AND parent_id IN (${marks}) ORDER BY id ASC`,
      ).bind(...page.map((r) => r.id)).all();
      for (const r of rep.results || []) {
        if (!repliesBy.has(r.parent_id)) repliesBy.set(r.parent_id, []);
        repliesBy.get(r.parent_id).push({
          id: r.id,
          name: r.name,
          body: r.body,
          createdAt: r.created_at,
          role: r.author_role || "visitor",
        });
      }
    }

    // Replies are answers, not feedback: counting them would inflate the
    // comment count and they carry no rating to average anyway.
    const totals = await env.COMMENTS_DB.prepare(
      "SELECT COUNT(*) AS total, AVG(rating) AS avgRating, " +
        "COUNT(rating) AS rated FROM comments WHERE hidden = 0 AND parent_id IS NULL",
    ).first();

    return new Response(
      JSON.stringify({
        comments: page.map((r) => ({
          id: r.id,
          name: r.name,
          body: r.body,
          rating: r.rating,
          createdAt: r.created_at,
          replies: repliesBy.get(r.id) || [],
        })),
        hasMore,
        total: totals?.total ?? page.length,
        avgRating: totals?.avgRating ?? null,
        ratedCount: totals?.rated ?? 0,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          // Comments publish instantly; a cached list would show a visitor
          // a page that's missing the comment they just posted.
          "Cache-Control": "no-store",
          ...CORS_HEADERS,
        },
      },
    );
  } catch (err) {
    console.error("Comment list failed", err);
    return jsonResponse({ error: "Could not load comments" }, 500);
  }
}

/** POST /api/comments — validate, screen, rate-limit, insert, return the row. */
async function handleCommentPost(request, env) {
  if (!env.COMMENTS_DB) {
    return jsonResponse({ error: "Comments are not configured on this deployment" }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";

  // Bot gate. Same fall-open behaviour as /api/session: forks without a
  // Turnstile secret still work, they just lean on the rate limit.
  if (env.TURNSTILE_SECRET_KEY) {
    const ok = await verifyTurnstileToken(env, payload?.turnstileToken, ip);
    if (!ok) {
      return jsonResponse({ error: "Bot check failed — please try again." }, 403);
    }
  } else {
    console.warn("TURNSTILE_SECRET_KEY missing — /api/comments has no bot gate");
  }

  const name = sanitizeCommentField(payload?.name, COMMENT_MAX_NAME) || "Anonymous";
  const body = sanitizeCommentField(payload?.body, COMMENT_MAX_BODY);

  if (body.length < COMMENT_MIN_BODY) {
    return jsonResponse({ error: "Please write a comment first." }, 400);
  }

  // A reply is an ordinary comment hung off another one, and it comes through
  // this handler rather than a route of its own precisely so it meets the same
  // bot gate, rate limit and abuse screen above. Anyone may write one.
  let parentId = null;
  if (payload?.parentId != null && payload.parentId !== "") {
    const n = Number(payload.parentId);
    if (!Number.isInteger(n) || n <= 0) {
      return jsonResponse({ error: "Invalid parentId" }, 400);
    }
    parentId = n;
  }

  let rating = null;
  if (payload?.rating != null && payload.rating !== "") {
    const n = Number(payload.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return jsonResponse({ error: "Rating must be between 1 and 5." }, 400);
    }
    rating = n;
  }
  // A rating is feedback on the player, not on the comment being answered —
  // counting one from a reply would move the average for the wrong reason.
  if (parentId) rating = null;

  // Fail closed: with no blocklist there is no abuse gate, so refuse the
  // comment rather than publish it unscreened. Costs nothing in practice —
  // the same D1 outage would fail the INSERT a few lines below anyway.
  let filter;
  try {
    filter = await loadProfanityFilter(env);
  } catch (err) {
    console.error("Could not load profanity_terms", err);
    return jsonResponse({ error: "Comments are temporarily unavailable" }, 503);
  }

  for (const [value, field] of [[name, "name"], [body, "comment"]]) {
    const blocked = screenCommentText(value, field, filter);
    if (blocked) {
      return jsonResponse({ error: blocked.message, reason: blocked.reason }, 422);
    }
  }

  const now = Date.now();
  const ipHash = await hashCommentIp(env, ip);

  try {
    const recent = await env.COMMENTS_DB.prepare(
      "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM comments " +
        "WHERE ip_hash = ? AND created_at > ?",
    ).bind(ipHash, now - COMMENT_RATE_WINDOW_MS).first();

    if ((recent?.n ?? 0) >= COMMENT_RATE_MAX) {
      return jsonResponse(
        { error: "You've posted a few already — try again in a bit." },
        429,
      );
    }
    if (recent?.last && now - recent.last < COMMENT_COOLDOWN_MS) {
      const wait = Math.ceil((COMMENT_COOLDOWN_MS - (now - recent.last)) / 1000);
      return jsonResponse({ error: `Please wait ${wait}s before posting again.` }, 429);
    }

    // The parent has to exist, be visible, and itself be top-level. Without
    // the last check a reply could hang off another reply, and the wall only
    // ever draws one level deep — the thread would simply not appear.
    if (parentId) {
      const parent = await env.COMMENTS_DB.prepare(
        "SELECT id FROM comments WHERE id = ? AND hidden = 0 AND parent_id IS NULL",
      ).bind(parentId).first();
      if (!parent) {
        return jsonResponse({ error: "That comment is no longer available." }, 404);
      }
    }

    const inserted = await env.COMMENTS_DB.prepare(
      "INSERT INTO comments (name, body, rating, ip_hash, created_at, parent_id) " +
        "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(name, body, rating, ipHash, now, parentId).first();

    return jsonResponse({
      ok: true,
      comment: {
        id: inserted?.id,
        name,
        body,
        rating,
        createdAt: now,
        parentId,
        role: "visitor",
      },
    }, 201);
  } catch (err) {
    console.error("Comment insert failed", err);
    return jsonResponse({ error: "Could not save your comment" }, 500);
  }
}

/**
 * DELETE /api/comments?id=N — soft-hide a comment. Requires
 * `Authorization: Bearer <COMMENTS_ADMIN_TOKEN>`. Without the secret set
 * the route stays closed rather than falling open; an unauthenticated
 * delete endpoint would be worse than no delete endpoint.
 */
async function handleCommentDelete(request, env, url) {
  if (!env.COMMENTS_DB) {
    return jsonResponse({ error: "Comments are not configured on this deployment" }, 503);
  }
  if (!env.COMMENTS_ADMIN_TOKEN) {
    return jsonResponse({ error: "Admin token not configured" }, 503);
  }

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqualStr(token, env.COMMENTS_ADMIN_TOKEN)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ error: "Missing or invalid id" }, 400);
  }

  try {
    const res = await env.COMMENTS_DB.prepare(
      "UPDATE comments SET hidden = 1 WHERE id = ?",
    ).bind(id).run();
    return jsonResponse({ ok: true, changed: res.meta?.changes ?? 0 });
  } catch (err) {
    console.error("Comment delete failed", err);
    return jsonResponse({ error: "Could not delete comment" }, 500);
  }
}

/** Constant-time string compare, so token checks don't leak length/prefix. */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Watch party
//
// Two doors, different sizes. The room code is what people share and is not a
// credential — anyone may open ?party=movie and will land in it as a
// follower, able to do nothing. Claiming the chair in that room means
// presenting a six-digit code from an authenticator app, and only the first
// claim on a room is honoured.
//
// The code never reaches the Durable Object. It is checked here, and what
// travels onward is a short-lived HMAC over (code, expiry) — so a token
// lifted from one room's URL opens neither another room nor the same one
// tomorrow.
// ---------------------------------------------------------------------------

const PARTY_TOKEN_TTL_MS = 10 * 60 * 1000;
const PARTY_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,39}$/;

function partyCodeKey(code) {
  // "Chai Party", "chai-party" and "CHAI PARTY" are one room. People retype a
  // code from a phone screen and they will not match its punctuation; a room
  // nobody can land in is worse than a slightly smaller code space.
  return code.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

// --- TOTP (RFC 6238), so the thing a host types is a code that expires ---
//
// Checked against RFC 6238 Appendix B's published vectors before being
// trusted: all six match at 8 digits, which is the same computation the 6
// digits below take the tail of.

function base32Decode(str) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(str).toUpperCase().replace(/[\s-]+/g, "").replace(/=+$/, "");
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = A.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length ? new Uint8Array(out) : null;
}

async function totpAt(keyBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

// One step either side of now. Phones and Cloudflare do not agree to the
// second, and a host whose clock is twenty seconds out should not be told
// their code is wrong.
const TOTP_SKEW_STEPS = 1;

async function totpValid(secretBase32, given) {
  const key = base32Decode(secretBase32);
  if (!key || !/^[0-9]{6}$/.test(given)) return false;
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let d = -TOTP_SKEW_STEPS; d <= TOTP_SKEW_STEPS; d++) {
    if (constantTimeEqual(given, await totpAt(key, now + d))) return true;
  }
  return false;
}

async function signPartyToken(env, codeKey, expiresAt) {
  return hmacSha256Hex(env.ENC_SERVER_SECRET, `party:${expiresAt}:${codeKey}`);
}

/**
 * POST /api/party/host  { code, otp } -> { token, exp, code }
 *
 * The six digits from an authenticator app, not a password. Nothing to store
 * and nothing to leak: the shared secret lives in PARTY_TOTP_SECRET and never
 * leaves the worker, and what the host types stops working within the minute.
 *
 * Deliberately quiet about which half was wrong: a caller probing learns the
 * same thing from a bad code as from a malformed room name, and the same
 * again when no secret has been configured at all.
 */
async function handlePartyHost(request, env) {
  if (!env.ENC_SERVER_SECRET) {
    return jsonResponse({ error: "Watch party is not configured on this deployment" }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request" }, 400);
  }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const otp = typeof body?.otp === "string" ? body.otp.replace(/\s+/g, "") : "";
  if (!PARTY_CODE_RE.test(code) || !otp) {
    return jsonResponse({ error: "Not allowed" }, 403);
  }

  // No secret configured means nobody can host, rather than everybody: a gate
  // nobody has set up is shut.
  if (!env.PARTY_TOTP_SECRET || !(await totpValid(env.PARTY_TOTP_SECRET, otp))) {
    return jsonResponse({ error: "Not allowed" }, 403);
  }

  const codeKey = partyCodeKey(code);
  const exp = Date.now() + PARTY_TOKEN_TTL_MS;
  return jsonResponse({ token: await signPartyToken(env, codeKey, exp), exp, code: codeKey });
}

/**
 * GET /api/party/room?code=… — WebSocket upgrade into the room's object.
 *
 * A guest arrives with no token and follows. A claim arrives with the token
 * minted above; it is verified HERE, and the object is told the outcome in a
 * URL only this worker can write.
 */
async function handlePartyRoom(request, env, url) {
  if (!env.PARTY) {
    return new Response("Watch party is not configured on this deployment", { status: 503 });
  }
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const code = url.searchParams.get("code") || "";
  if (!PARTY_CODE_RE.test(code)) return new Response("bad code", { status: 400 });
  const codeKey = partyCodeKey(code);

  let asHost = false;
  const token = url.searchParams.get("token");
  const expRaw = url.searchParams.get("exp");
  if (token && expRaw) {
    const exp = Number(expRaw);
    if (
      Number.isSafeInteger(exp) &&
      Date.now() <= exp &&
      exp <= Date.now() + PARTY_TOKEN_TTL_MS &&
      constantTimeEqual(token, await signPartyToken(env, codeKey, exp))
    ) {
      asHost = true;
    }
  }

  const room = new URL("https://party.invalid/room");
  room.searchParams.set("host", asHost ? "1" : "0");
  room.searchParams.set("name", (url.searchParams.get("name") || "").slice(0, 24));
  return env.PARTY.get(env.PARTY.idFromName(codeKey)).fetch(new Request(room, request));
}
