# Encrypted Video Server Example

AES-256-GCM encrypted video playback with short-lived tokens (2s expiry), IP binding, and browser fingerprint validation.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Encrypt a video
node encrypt.js /path/to/video.mp4

# 3. Start server
npm start

# 4. Open browser
open http://localhost:3000
```

## How it works

```
Browser                          Server
  │                                │
  ├─ POST /api/token ────────────►│ Validate IP + fingerprint
  │  {videoId, fingerprint}        │ Generate token (2s TTL)
  │                                │ Return: {key, iv, token}
  │◄───────────────────────────────┤
  │                                │
  ├─ GET /api/video ─────────────►│ Validate token + IP + fingerprint
  │  X-Token: xxx                  │ Check not expired (<2s)
  │  X-Fingerprint: xxx            │ Serve encrypted chunk
  │  Range: bytes=0-2097151        │
  │◄───────────────────────────────┤
  │                                │
  │  Browser: AES-GCM decrypt      │
  │  → WASM demuxer → Canvas       │
  │                                │
  │  (Token expires, get new one)  │
  ├─ POST /api/token ────────────►│ ...repeat
```

## Security Layers

| Layer | Protection |
|---|---|
| AES-256-GCM | Video is encrypted at rest and in transit |
| Token TTL (2s) | Intercepted tokens expire immediately |
| IP binding | Token only works from same IP |
| Fingerprint binding | Token only works in same browser |
| No `<video>` element | Can't right-click → Save Video |
| Canvas rendering | No direct media access |
| WASM demuxer | Stream processing in WebAssembly |

## Files

- `encrypt.js` — Encrypt a video file (run once)
- `server.js` — Express server with token auth
- `*.enc` — Encrypted video (safe to put on CDN)
- `*.key` — Decryption key info (KEEP SECRET, server-only)
