import HTML_RAW from "./index.html";
import TEST_NATIVE_HTML from "./test-native.html";
import COMPARE_HTML from "./compare.html";
import EXAMPLES_HTML from "./examples.html";
import DRIVE_HTML from "./drive.html";
import SITEMAP from "./sitemap.xml";
import ROBOTS from "./robots.txt";
import LLMS from "./llms.txt";

const BUILD_VERSION = "__BUILD_VERSION__";
const HTML_WITH_VERSION = HTML_RAW.replace(/__BUILD_VERSION__/g, BUILD_VERSION);
const TEST_NATIVE_WITH_VERSION = TEST_NATIVE_HTML.replace(/__BUILD_VERSION__/g, BUILD_VERSION);
const COMPARE_WITH_VERSION = COMPARE_HTML.replace(/__BUILD_VERSION__/g, BUILD_VERSION);
const EXAMPLES_WITH_VERSION = EXAMPLES_HTML.replace(/__BUILD_VERSION__/g, BUILD_VERSION);
const DRIVE_WITH_VERSION = DRIVE_HTML.replace(/__BUILD_VERSION__/g, BUILD_VERSION);

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

    // Redirect www to non-www
    if (url.hostname === "www.moviplayer.com") {
      return Response.redirect(`https://moviplayer.com${path}${url.search}`, 301);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- Serve app ---
    if (path === "/" || path === "/index.html") {
      return new Response(buildHtml(env), {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
          ...SECURITY_HEADERS,
        },
      });
    }

    // --- Test page for isolating native <video> playback issues ---
    if (path === "/test-native.html" || path === "/test-native") {
      return new Response(TEST_NATIVE_WITH_VERSION, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        },
      });
    }

    // --- Side-by-side comparison: native <video> vs <movi-player> ---
    if (path === "/compare" || path === "/compare.html" || path === "/compare/") {
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
    if (path === "/examples" || path === "/examples.html" || path === "/examples/") {
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
    if (path === "/drive" || path === "/drive.html" || path === "/drive/") {
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
    if (path === "/api/video") {
      return handleEncVideo(request, env);
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
  if (isText) {
    const body = (await res.text()).split("/movi-player/").join("/docs/");
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

function handleEmbed(url, request) {
  // Embed-only: this page is meant to live inside an <iframe>, never opened
  // directly. Sec-Fetch-Dest tells us the request's destination — 'iframe' or
  // 'frame' when embedded, 'document' on a top-level navigation (typing the
  // URL, opening in a new tab). Block the top-level case. All current browsers
  // send this header; when it's absent (older clients) we fall through and the
  // client-side guard in the page below handles it.
  const dest = request && request.headers.get("Sec-Fetch-Dest");
  if (dest === "document") {
    return embedTopLevelBlock();
  }

  const videoUrl = url.searchParams.get("url") || "";
  const playerAttrs = buildEmbedPlayerAttrs(url.searchParams);

  const embedHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%236c5dd3'/%3E%3Cstop offset='100%25' stop-color='%234a3bba'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='50' cy='50' r='45' fill='url(%23g)'/%3E%3Cpolygon points='39,29 39,71 74,50' fill='white'/%3E%3C/svg%3E"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#000}
movi-player{width:100%;height:100%;display:block}
</style>
<script>
// Minimal __movilog shim for the embed. The bundled player is built
// with terser drop_console:true, so any diagnostics it wants to emit
// go through window.__movilog (the name survives minification). In
// the embed we route them straight to the iframe's DevTools console
// so users debugging an embed can still see player logs — and we
// keep a small ring buffer for postMessage/inspection from the
// parent. No on-page panel here (embed is meant to be invisible
// chrome).
(function () {
  var MAX = 200;
  var buf = [];
  function push(level, args) {
    var entry = { level: level, args: Array.prototype.slice.call(args), t: Date.now() };
    buf.push(entry);
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    try { (console[level] || console.log).apply(console, args); } catch (e) {}
  }
  function makeLogger(level) {
    return function () { push(level, arguments); };
  }
  var movilog = makeLogger("log");
  movilog.log = makeLogger("log");
  movilog.info = makeLogger("info");
  movilog.warn = makeLogger("warn");
  movilog.error = makeLogger("error");
  movilog.debug = makeLogger("debug");
  window.__movilog = movilog;
  window.__moviDevLog = { buffer: buf };
})();
</script>
</head>
<body>
<movi-player id="p" ${playerAttrs}></movi-player>
<script type="module">
import "/dist/${BUILD_VERSION}/element.js";
// Fallback for the rare browser that doesn't send Sec-Fetch-Dest (the worker
// already blocks the top-level case for everyone else): if we're the top-level
// document rather than framed, this embed URL was opened directly — show the
// notice instead of the player. window.top vs window.self compares safely even
// across origins (reference compare, no property access).
if (window.top === window.self) {
  // Build via DOM (not innerHTML) so there's zero markup-injection surface,
  // even though the strings here are all static. Text nodes escape the literal
  // "<iframe>" for us.
  document.body.textContent = "";
  const box = document.createElement("div");
  box.setAttribute("style", "font:14px/1.5 system-ui,sans-serif;color:#cfcfe6;display:flex;align-items:center;justify-content:center;height:100%;text-align:center;padding:24px");
  box.append("This is an embed-only page — open it inside an <iframe>. ");
  const a = document.createElement("a");
  a.href = "https://moviplayer.com";
  a.textContent = "moviplayer.com";
  a.setAttribute("style", "color:#8b7bff;margin-left:6px");
  box.appendChild(a);
  document.body.appendChild(box);
} else {
  const p=document.getElementById("p");
  const url="${videoUrl.replace(/"/g, "&quot;")}";
  // Adaptive-streaming manifests (HLS/DASH/Smooth) load directly — the player
  // fetches their (relative-URL) segments itself, which /proxy?url= would break.
  if(url) p.src=/\\.(m3u8|mpd|ism)($|\\?)/i.test(url)?url:"/proxy?url="+encodeURIComponent(url);
}
</script>
</body>
</html>`;

  return new Response(embedHTML, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
      // The response depends on Sec-Fetch-Dest (embed vs top-level block), so
      // caches must key on it — otherwise a cached iframe copy could be served
      // to a direct top-level open, or vice versa.
      "Vary": "Sec-Fetch-Dest",
      ...SECURITY_HEADERS,
    },
  });
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
<svg width="40" height="40" viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8a7cf2"/><stop offset="100%" stop-color="#6c5dd3"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#g)"/><polygon points="40,29 40,71 73,50" fill="#ffffff"/></svg>
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
  ico: "image/x-icon",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  ts: "video/mp2t",
};

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
    "https://vsmarketplacebadges.dev/downloads-short/mrujjwalg.movi-player-vscode.svg?label=VS%20Code&color=7c6cf0",
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
      "Cache-Control": "public, max-age=31536000, immutable",
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
async function preflightSignatureCheck(targetUrl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "Range": `bytes=0-${MAGIC_SNIFF_SIZE - 1}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        redirect: "follow",
      });
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

async function handleProxy(request, url, env) {
  if (!isAllowedProxyReferer(request)) {
    return jsonResponse({ error: "Referer not allowed" }, 403);
  }

  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "url parameter required" }, 400);
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
    const response = await fetch(targetUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });

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
        const result = await preflightSignatureCheck(targetUrl);
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

    // Cache video responses
    respHeaders.set("Cache-Control", "public, max-age=86400");

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

function isPrivateHost(hostname) {
  // Block localhost and private IPs
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;

  // Check private IP ranges
  const parts = hostname.split(".");
  if (parts.length === 4) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16
    if (a === 0) return true;                            // 0.0.0.0/8
  }

  return false;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
