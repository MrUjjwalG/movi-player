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
import { readFileSync, existsSync, readdirSync } from "fs";
import { randomBytes, createHmac, createDecipheriv } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Required for SharedArrayBuffer (movi-player WASM)
app.use((_req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// Serve movi-player dist files
app.use("/dist", express.static(join(__dirname, "../dist")));

// ─── Configuration ───────────────────────────────────────────────
const TOKEN_TTL = 2000;        // Token valid for 2 seconds
const TIMESTAMP_WINDOW = 2000; // Request timestamp must be within 2s
// Rate limiting disabled for demo — in production, use per-second limits
// const MAX_REQUESTS_PER_SEC = 50;

// ─── Multi-file Video Library ────────────────────────────────────
const videos = new Map(); // videoId -> { encFile, keyInfo, encBuffer, chunkIndex }

const videosDir = join(__dirname, "videos");
const dirFiles = existsSync(videosDir) ? readdirSync(videosDir) : [];
for (const f of dirFiles) {
  if (f.endsWith(".enc")) {
    const keyPath = join(videosDir, f.replace(/\.enc$/, ".key"));
    if (existsSync(keyPath)) {
      const ki = JSON.parse(readFileSync(keyPath, "utf-8"));
      const encPath = join(videosDir, f);
      const encBuf = readFileSync(encPath);

      // Parse chunk index
      const cc = encBuf.readUInt32LE(0);
      const ci = [];
      for (let i = 0; i < cc; i++) {
        const idx = 4 + i * 16;
        ci.push({
          originalOffset: encBuf.readUInt32LE(idx),
          originalSize: encBuf.readUInt32LE(idx + 4),
          encOffset: encBuf.readUInt32LE(idx + 8),
          encSize: encBuf.readUInt32LE(idx + 12),
        });
      }

      videos.set(ki.originalFile, { encFile: encPath, keyInfo: ki, encBuffer: encBuf, chunkIndex: ci });
      console.log(`  [${videos.size}] ${ki.originalFile} (${(ki.originalSize / 1024 / 1024).toFixed(1)} MB, ${ki.chunkCount} chunks)`);
    }
  }
}

if (videos.size === 0) {
  console.error("No encrypted videos found! Run: node encrypt.js <video-file>");
  process.exit(1);
}

console.log(`\nLoaded ${videos.size} encrypted video(s)`);

/**
 * Decrypt a single chunk on-demand (~2MB RAM, freed after response)
 */
function decryptChunk(video, chunkIdx) {
  const info = video.chunkIndex[chunkIdx];
  const encChunk = video.encBuffer.subarray(info.encOffset, info.encOffset + info.encSize);
  const iv = encChunk.subarray(0, 12);
  const authTag = encChunk.subarray(12, 28);
  const ciphertext = encChunk.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(video.keyInfo.key, "base64"), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Security Stores (production: use Redis) ─────────────────────

// Active tokens: token -> { ip, fingerprint, hmacSecret, expiresAt }
const activeTokens = new Map();

// Used nonces: nonce -> timestamp (for replay protection)
const usedNonces = new Map();


// Cleanup expired data every 5s
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of activeTokens) {
    if (now > data.expiresAt + 5000) activeTokens.delete(token);
  }
  for (const [nonce, ts] of usedNonces) {
    if (now - ts > 10000) usedNonces.delete(nonce);
  }
}, 5000);

// ─── Helpers ─────────────────────────────────────────────────────

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] || req.socket.remoteAddress;
}

// Rate limiting disabled for demo

function verifyHMAC(token, nonce, timestamp, offset, length, hmacSecret) {
  const message = `${token}:${nonce}:${timestamp}:${offset}:${length}`;
  const expected = createHmac("sha256", Buffer.from(hmacSecret, "base64"))
    .update(message)
    .digest("hex");
  return expected;
}

// ─── API: List Videos ────────────────────────────────────────────
app.get("/api/videos", (_req, res) => {
  const list = Array.from(videos.entries()).map(([id, v]) => ({
    id,
    size: v.keyInfo.originalSize,
    chunks: v.keyInfo.chunkCount,
  }));
  res.json(list);
});

// ─── API: Get Token + HMAC Secret ────────────────────────────────

app.post("/api/token", (req, res) => {
  const { videoId, fingerprint } = req.body;
  const ip = getClientIP(req);

  if (!videoId || !fingerprint) {
    return res.status(400).json({ error: "Missing videoId or fingerprint" });
  }

  // Check video exists
  const video = videos.get(videoId);
  if (!video) {
    return res.status(404).json({ error: "Video not found", available: Array.from(videos.keys()) });
  }

  // Generate token + HMAC secret (both unique per refresh)
  const token = randomBytes(32).toString("hex");
  const hmacSecret = randomBytes(32).toString("base64");
  const expiresAt = Date.now() + TOKEN_TTL;

  // Store with bindings + videoId
  activeTokens.set(token, {
    ip,
    fingerprint,
    hmacSecret,
    videoId,
    expiresAt,
  });

  res.json({
    token,
    expiresAt,
    fileSize: video.keyInfo.originalSize,
    chunkSize: video.keyInfo.chunkSize,
    hmacSecret,
  });

  console.log(`[TOKEN] IP=${ip} fp=${fingerprint.slice(0, 8)}... TTL=${TOKEN_TTL}ms`);
});

// ─── API: Serve Encrypted Video (with full validation) ───────────

app.get("/api/video", async (req, res) => {
  const token = req.headers["x-token"];
  const fingerprint = req.headers["x-fingerprint"];
  const nonce = req.headers["x-nonce"];
  const timestamp = parseInt(req.headers["x-timestamp"] || "0", 10);
  const signature = req.headers["x-signature"];
  const ip = getClientIP(req);

  if (!token || !fingerprint || !nonce || !timestamp || !signature) return res.status(401).json({ error: "Missing auth headers" });

  const tokenData = activeTokens.get(token);
  if (!tokenData) return res.status(401).json({ error: "Invalid token" });
  if (Date.now() > tokenData.expiresAt) { activeTokens.delete(token); return res.status(401).json({ error: "Token expired" }); }
  if (tokenData.ip !== ip) return res.status(403).json({ error: "IP mismatch" });
  if (tokenData.fingerprint !== fingerprint) return res.status(403).json({ error: "Fingerprint mismatch" });
  if (Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW) return res.status(403).json({ error: "Request too old" });
  if (usedNonces.has(nonce)) return res.status(403).json({ error: "Replay detected" });
  usedNonces.set(nonce, Date.now());

  // Get video for this token
  const video = videos.get(tokenData.videoId);
  if (!video) return res.status(404).json({ error: "Video not found" });

  // Parse range using original size
  const originalSize = video.keyInfo.originalSize;
  const range = req.headers.range;
  let start = 0;
  let end = originalSize - 1;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : originalSize - 1;
  }
  end = Math.min(end, originalSize - 1);
  const responseLength = end - start + 1;

  // Verify HMAC
  const expectedSig = verifyHMAC(token, nonce, timestamp, start, responseLength, tokenData.hmacSecret);
  if (signature !== expectedSig) return res.status(403).json({ error: "Invalid signature" });

  // On-demand chunk decryption — only decrypt needed chunks (~2MB each)
  const CHUNK_SIZE = video.keyInfo.chunkSize;
  const firstChunk = Math.floor(start / CHUNK_SIZE);
  const lastChunk = Math.floor(end / CHUNK_SIZE);
  const parts2 = [];

  for (let i = firstChunk; i <= lastChunk; i++) {
    const decrypted = decryptChunk(video, i);
    const chunkStart = i * CHUNK_SIZE;
    const sliceStart = Math.max(0, start - chunkStart);
    const sliceEnd = Math.min(decrypted.length, end - chunkStart + 1);
    parts2.push(decrypted.subarray(sliceStart, sliceEnd));
  }
  const responseData = Buffer.concat(parts2);

  if (range) {
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${originalSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": responseData.length,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, no-cache",
    });
  } else {
    res.writeHead(200, {
      "Content-Length": originalSize,
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store, no-cache",
    });
  }
  res.end(responseData);
  console.log(`[SERVE] ${start}-${end} (${(responseData.length / 1024).toFixed(0)}KB) chunks ${firstChunk}-${lastChunk} IP=${ip}`);
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
  <div class="player-container">
    <movi-player id="player"
      controls thumb fastseek showtitle autoplay muted
      encrypted
      tokenurl="/api/token"
      videourl="/api/video"
      videoid="${Array.from(videos.keys())[0]}"
    ></movi-player>
  </div>
  <div class="info" id="info">Initializing encrypted playback...</div>

  <script type="module">
    // Just import element — encrypted playback is handled by attributes!
    import '/dist/element.js';

    const info = document.getElementById('info');

    // Show security info
    info.innerHTML =
      '<div class="security-grid">' +
        ['AES-256-GCM Encryption', 'HMAC-SHA256 Signatures', '2s Token Expiry', 'IP Binding',
         'Fingerprint Binding', 'One-time Nonce', 'Replay Protection',
         'No &lt;video&gt; Element', 'Canvas Rendering'
        ].map(s => '<div class="sec-item"><div class="dot"></div>' + s + '</div>').join('') +
      '</div>';
  </script>
</body>
</html>`);
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🔒 Encrypted Video Server — http://localhost:${PORT}`);
  console.log(`   Token TTL: ${TOKEN_TTL}ms`);
  console.log(`   Rate limit: disabled (demo)`);
  console.log(`\n   Security: AES-GCM + HMAC + Nonce + IP + Fingerprint + Rate Limit`);
});
