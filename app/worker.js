import HTML_RAW from "./index.html";

const BUILD_VERSION = "__BUILD_VERSION__";
const HTML = HTML_RAW.replace(/__BUILD_VERSION__/g, BUILD_VERSION);

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition",
};

const ALLOWED_CONTENT_TYPES = [
  "video/", "audio/", "application/octet-stream",
  "application/x-matroska", "application/x-mpegurl",
  "application/vnd.apple.mpegurl", "application/dash+xml",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- Serve app ---
    if (path === "/" || path === "/index.html") {
      return new Response(HTML, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
          ...SECURITY_HEADERS,
        },
      });
    }

    // --- Serve dist files from R2 (strip query params for key lookup) ---
    if (path.startsWith("/dist/")) {
      const key = path.slice(6).split("?")[0];
      return handleR2(env, key, request);
    }

    // --- Embed player ---
    if (path === "/embed") {
      return handleEmbed(url);
    }

    // --- Video proxy ---
    if (path === "/proxy") {
      return handleProxy(request, url);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function handleEmbed(url) {
  const videoUrl = url.searchParams.get("url") || "";
  const autoplay = url.searchParams.has("autoplay");

  const embedHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23bd34fe'/%3E%3Cstop offset='100%25' stop-color='%2341d1ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='50' cy='50' r='45' fill='url(%23g)'/%3E%3Cpolygon points='40,30 40,70 75,50' fill='white'/%3E%3C/svg%3E"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#000}
movi-player{width:100%;height:100%;display:block}
</style>
</head>
<body>
<movi-player id="p" renderer="canvas" controls objectfit="control" gesturefs fastseek stablevolume${autoplay ? " autoplay" : ""}></movi-player>
<script type="module">
import "/dist/element.js?v=${BUILD_VERSION}";
const p=document.getElementById("p");
const url="${videoUrl.replace(/"/g, "&quot;")}";
if(url) p.src="/proxy?url="+encodeURIComponent(url);
</script>
</body>
</html>`;

  return new Response(embedHTML, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
      ...SECURITY_HEADERS,
    },
  });
}

const MIME_TYPES = {
  js: "application/javascript",
  wasm: "application/wasm",
  json: "application/json",
  map: "application/json",
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

async function handleProxy(request, url) {
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
    return new Response(response.body, {
      status: response.status,
      headers: respHeaders,
    });
  } catch (err) {
    return jsonResponse({ error: "Fetch failed: " + err.message }, 502);
  }
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
