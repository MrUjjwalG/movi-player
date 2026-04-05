/**
 * Encrypted Video Server — Maximum Security
 *
 * Security layers:
 *   1. AES-256-GCM encryption
 *   2. Short-lived tokens (2s TTL)
 *   3. IP binding
 *   4. Browser fingerprint binding
 *   5. HMAC-SHA256 signed requests
 *   6. One-time nonce (replay protection)
 *   7. Timestamp validation (2s window)
 *   8. Rate limiting
 *   9. Per-session rotating HMAC secrets
 *
 * Usage:
 *   1. node encrypt.js video.mp4
 *   2. node server.js
 *   3. http://localhost:3000
 */

import express from "express";
import cors from "cors";
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { randomBytes, createHmac } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ─── Configuration ───────────────────────────────────────────────
const TOKEN_TTL = 2000;        // Token valid for 2 seconds
const TIMESTAMP_WINDOW = 2000; // Request timestamp must be within 2s
const MAX_REQUESTS_PER_MIN = 120; // Rate limit

let encFile = null;
let keyInfo = null;

// Find .enc + .key files
const dirFiles = readdirSync(__dirname);
for (const f of dirFiles) {
  if (f.endsWith(".enc")) {
    const keyPath = join(__dirname, f.replace(/\.enc$/, ".key"));
    if (existsSync(keyPath)) {
      encFile = join(__dirname, f);
      keyInfo = JSON.parse(readFileSync(keyPath, "utf-8"));
      break;
    }
  }
}

if (!encFile || !keyInfo) {
  console.error("No encrypted video found! Run: node encrypt.js <video-file>");
  process.exit(1);
}

console.log(`Video: ${keyInfo.originalFile} (${(keyInfo.originalSize / 1024 / 1024).toFixed(1)} MB)`);

// ─── Security Stores (production: use Redis) ─────────────────────

// Active tokens: token -> { ip, fingerprint, hmacSecret, expiresAt }
const activeTokens = new Map();

// Used nonces: nonce -> timestamp (for replay protection)
const usedNonces = new Map();

// Rate limiting: ip -> { count, resetAt }
const rateLimits = new Map();

// Cleanup expired data every 5s
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of activeTokens) {
    if (now > data.expiresAt + 5000) activeTokens.delete(token);
  }
  for (const [nonce, ts] of usedNonces) {
    if (now - ts > 10000) usedNonces.delete(nonce);
  }
  for (const [ip, data] of rateLimits) {
    if (now > data.resetAt) rateLimits.delete(ip);
  }
}, 5000);

// ─── Helpers ─────────────────────────────────────────────────────

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] || req.socket.remoteAddress;
}

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= MAX_REQUESTS_PER_MIN;
}

function verifyHMAC(token, nonce, timestamp, offset, length, hmacSecret) {
  const message = `${token}:${nonce}:${timestamp}:${offset}:${length}`;
  const expected = createHmac("sha256", Buffer.from(hmacSecret, "base64"))
    .update(message)
    .digest("hex");
  return expected;
}

// ─── API: Get Token + Key + HMAC Secret ──────────────────────────

app.post("/api/token", (req, res) => {
  const { videoId, fingerprint } = req.body;
  const ip = getClientIP(req);

  if (!videoId || !fingerprint) {
    return res.status(400).json({ error: "Missing videoId or fingerprint" });
  }

  // Rate limit
  if (!checkRateLimit(ip)) {
    console.log(`[RATE LIMIT] IP=${ip}`);
    return res.status(429).json({ error: "Too many requests" });
  }

  // Generate token + HMAC secret (both unique per refresh)
  const token = randomBytes(32).toString("hex");
  const hmacSecret = randomBytes(32).toString("base64");
  const expiresAt = Date.now() + TOKEN_TTL;

  // Store with bindings
  activeTokens.set(token, {
    ip,
    fingerprint,
    hmacSecret,
    expiresAt,
  });

  res.json({
    key: keyInfo.key,
    iv: keyInfo.iv,
    token,
    expiresAt,
    fileSize: keyInfo.originalSize,
    chunkSize: 2 * 1024 * 1024,
    hmacSecret, // Client uses this to sign requests
  });

  console.log(`[TOKEN] IP=${ip} fp=${fingerprint.slice(0, 8)}... TTL=${TOKEN_TTL}ms`);
});

// ─── API: Serve Encrypted Video (with full validation) ───────────

app.get("/api/video", (req, res) => {
  const token = req.headers["x-token"];
  const fingerprint = req.headers["x-fingerprint"];
  const nonce = req.headers["x-nonce"];
  const timestamp = parseInt(req.headers["x-timestamp"] || "0", 10);
  const signature = req.headers["x-signature"];
  const ip = getClientIP(req);

  // 1. Rate limit
  if (!checkRateLimit(ip)) {
    console.log(`[REJECT] Rate limit: IP=${ip}`);
    return res.status(429).json({ error: "Rate limited" });
  }

  // 2. All headers required
  if (!token || !fingerprint || !nonce || !timestamp || !signature) {
    console.log(`[REJECT] Missing headers`);
    return res.status(401).json({ error: "Missing auth headers" });
  }

  // 3. Token exists
  const tokenData = activeTokens.get(token);
  if (!tokenData) {
    console.log(`[REJECT] Invalid token`);
    return res.status(401).json({ error: "Invalid token" });
  }

  // 4. Token not expired
  if (Date.now() > tokenData.expiresAt) {
    activeTokens.delete(token);
    console.log(`[REJECT] Token expired`);
    return res.status(401).json({ error: "Token expired" });
  }

  // 5. IP binding
  if (tokenData.ip !== ip) {
    console.log(`[REJECT] IP mismatch: ${tokenData.ip} ≠ ${ip}`);
    return res.status(403).json({ error: "IP mismatch" });
  }

  // 6. Fingerprint binding
  if (tokenData.fingerprint !== fingerprint) {
    console.log(`[REJECT] Fingerprint mismatch`);
    return res.status(403).json({ error: "Fingerprint mismatch" });
  }

  // 7. Timestamp within window
  const timeDiff = Math.abs(Date.now() - timestamp);
  if (timeDiff > TIMESTAMP_WINDOW) {
    console.log(`[REJECT] Timestamp too old: ${timeDiff}ms`);
    return res.status(403).json({ error: "Request too old" });
  }

  // 8. Nonce not reused (replay protection)
  if (usedNonces.has(nonce)) {
    console.log(`[REJECT] Nonce reused (replay attack)`);
    return res.status(403).json({ error: "Replay detected" });
  }
  usedNonces.set(nonce, Date.now());

  // 9. Parse range
  const range = req.headers.range;
  const fileSize = statSync(encFile).size;
  let start = 0;
  let end = fileSize - 1;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  }
  const chunkLength = end - start + 1;

  // 10. Verify HMAC signature
  const expectedSig = verifyHMAC(
    token, nonce, timestamp, start, chunkLength, tokenData.hmacSecret
  );
  if (signature !== expectedSig) {
    console.log(`[REJECT] HMAC mismatch (tampered request)`);
    return res.status(403).json({ error: "Invalid signature" });
  }

  // ✅ All checks passed — serve encrypted chunk
  const fd = openSync(encFile, "r");
  const buffer = Buffer.alloc(chunkLength);
  readSync(fd, buffer, 0, chunkLength, start);
  closeSync(fd);

  if (range) {
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkLength,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, no-cache",
    });
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store, no-cache",
    });
  }

  res.end(buffer);
  console.log(`[SERVE] ${start}-${end} (${(chunkLength / 1024).toFixed(0)}KB) IP=${ip}`);
});

// ─── Serve Player Page ──────────────────────────────────────────

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Movi - Encrypted Playback</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column; align-items: center;
      padding: 20px; min-height: 100vh;
    }
    h1 { font-size: 20px; margin-bottom: 4px; color: #8B5CF6; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 20px; }
    .player-container {
      width: 100%; max-width: 900px; aspect-ratio: 16/9;
      background: #000; border-radius: 12px; overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    movi-player { width: 100%; height: 100%; display: block; }
    .info {
      margin-top: 16px; padding: 16px 20px; background: #111;
      border-radius: 8px; font-size: 12px; color: #888;
      font-family: 'SF Mono', monospace; max-width: 900px; width: 100%;
      line-height: 1.8;
    }
    .info .l { color: #8B5CF6; font-weight: 600; }
    .info .ok { color: #00ff88; }
    .info .s { color: #444; }
    .security-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 8px; margin-top: 12px;
    }
    .sec-item {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #666;
    }
    .sec-item .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #00ff88; flex-shrink: 0;
    }
  </style>
</head>
<body>
  <h1>Encrypted Playback</h1>
  <p class="subtitle">AES-256-GCM + HMAC signed + 2s tokens + IP/fingerprint binding</p>
  <div class="player-container" style="display:flex;align-items:center;justify-content:center;">
    <div style="text-align:center;color:#444;font-size:13px;padding:20px;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:12px;">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <div>Encrypted video server running</div>
      <div style="margin-top:4px;color:#666;">Use movi-player element with <code>loadEncrypted()</code> to play</div>
    </div>
  </div>
  <div class="info" id="info">Initializing encrypted playback...</div>

  <script type="module">
    const info = document.getElementById('info');

    function log(lines) {
      info.innerHTML = lines.map(([label, value, type]) =>
        '<span class="l">' + label + '</span> ' +
        (type === 'ok' ? '<span class="ok">' + value + '</span>' : value)
      ).join('<br>') +
      '<div class="security-grid">' +
        ['AES-256-GCM Encryption', 'HMAC-SHA256 Signatures', '2s Token Expiry', 'IP Binding',
         'Fingerprint Binding', 'One-time Nonce', 'Replay Protection', 'Rate Limiting',
         'No &lt;video&gt; Element', 'Canvas Rendering'
        ].map(s => '<div class="sec-item"><div class="dot"></div>' + s + '</div>').join('') +
      '</div>';
    }

    // Inline fingerprint generator (same as Fingerprint.ts)
    async function generateFingerprint() {
      const c = [
        navigator.userAgent,
        screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        navigator.language,
        navigator.platform,
        'cores:' + (navigator.hardwareConcurrency || 'unknown'),
      ];
      try {
        const cv = document.createElement('canvas');
        cv.width = 64; cv.height = 64;
        const ctx = cv.getContext('2d');
        if (ctx) {
          ctx.textBaseline = 'top'; ctx.font = '14px Arial';
          ctx.fillStyle = '#f60'; ctx.fillRect(0,0,64,64);
          ctx.fillStyle = '#069'; ctx.fillText('movi:fp', 2, 15);
          c.push(cv.toDataURL().slice(-50));
        }
      } catch {}
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) c.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        }
      } catch {}
      const data = new TextEncoder().encode(c.join('|'));
      const hash = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
    }

    async function init() {
      try {
        log([['Status:', 'Generating fingerprint...']]);
        const fingerprint = await generateFingerprint();

        log([
          ['Fingerprint:', fingerprint.slice(0, 24) + '...'],
          ['Status:', 'Requesting token...'],
        ]);

        // Request token to verify connection
        const tokenRes = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: '${keyInfo.originalFile}', fingerprint }),
        });

        if (!tokenRes.ok) throw new Error('Token request failed: ' + tokenRes.status);
        const token = await tokenRes.json();

        log([
          ['Fingerprint:', fingerprint.slice(0, 24) + '...'],
          ['Video:', '${keyInfo.originalFile}'],
          ['File Size:', (token.fileSize / 1024 / 1024).toFixed(1) + ' MB'],
          ['Token TTL:', '2 seconds'],
          ['Status:', 'Token server connected — encrypted video ready', 'ok'],
          ['', ''],
          ['Note:', 'This demo shows the token + HMAC handshake.'],
          ['', 'To play encrypted video, use movi-player with loadEncrypted() API.'],
        ]);

      } catch (e) {
        info.textContent = 'Error: ' + e.message;
        console.error(e);
      }
    }

    init();
  </script>
</body>
</html>`);
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🔒 Encrypted Video Server — http://localhost:${PORT}`);
  console.log(`   Token TTL: ${TOKEN_TTL}ms`);
  console.log(`   Rate limit: ${MAX_REQUESTS_PER_MIN}/min`);
  console.log(`\n   Security: AES-GCM + HMAC + Nonce + IP + Fingerprint + Rate Limit`);
});
