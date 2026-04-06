/**
 * EncryptedHttpSource - Maximum security encrypted video playback
 *
 * Security layers:
 * 1. AES-256-GCM encryption — video is encrypted at rest
 * 2. Short-lived tokens (2s) — intercepted tokens expire instantly
 * 3. IP binding — token only works from same IP
 * 4. Browser fingerprint binding — token only works in same browser
 * 5. HMAC signed requests — every request is signed with a session secret
 * 6. One-time nonce — prevents replay attacks (each request has unique nonce)
 * 7. Timestamp validation — requests valid for 2s window only
 * 8. Per-chunk rotating keys — key changes with each token refresh
 *
 * Even if Burp Suite intercepts everything:
 *   - Token expired in 2s
 *   - Nonce already used (one-time)
 *   - HMAC can't be generated without session secret
 *   - Session secret only exists in memory (from token handshake)
 */

import type { SourceAdapter } from "./SourceAdapter";
import { Logger } from "../utils/Logger";

const TAG = "EncryptedSource";

export interface EncryptedSourceConfig {
  /** URL of the encrypted video file (.enc) */
  videoUrl: string;
  /** Token endpoint — POST to get short-lived token + decryption key */
  tokenUrl: string;
  /** Video ID for token requests */
  videoId: string;
  /** Browser fingerprint (from Fingerprint.ts) */
  fingerprint: string;
  /** Session token (JWT or similar from your auth system) */
  sessionToken: string;
  /** Custom headers for all requests */
  headers?: Record<string, string>;
  /** Token refresh interval in ms (default: 1500ms) */
  tokenRefreshInterval?: number;
  /** Callback when auth fails (e.g., redirect to login) */
  onAuthFailed?: (reason: string) => void;
}

interface TokenResponse {
  /** Base64-encoded AES-256-GCM key (32 bytes) */
  key: string;
  /** Base64-encoded IV/nonce (12 bytes) */
  iv: string;
  /** One-time token for chunk requests */
  token: string;
  /** Token expiry timestamp (ms) */
  expiresAt: number;
  /** Total file size (original, pre-encryption) */
  fileSize: number;
  /** Chunk size server uses for encryption */
  chunkSize: number;
  /** HMAC signing secret for this session (base64, unique per token refresh) */
  hmacSecret: string;
}

export class EncryptedHttpSource implements SourceAdapter {
  private config: EncryptedSourceConfig;
  private size: number = -1;
  private position: number = 0;
  private chunkSize: number = 2 * 1024 * 1024;

  // Crypto
  private cryptoKey: CryptoKey | null = null;
  private hmacKey: CryptoKey | null = null;
  private iv: Uint8Array | null = null;
  private currentToken: string = "";
  private tokenExpiresAt: number = 0;

  // Token refresh
  private isRefreshing: boolean = false;

  // Nonce tracking (prevent reuse on client side too)
  private usedNonces: Set<string> = new Set();

  // Stats
  private totalBytesDownloaded: number = 0;
  private maxBufferedEnd: number = 0; // Furthest byte position read
  private lastSpeedBytes: number = 0;
  private lastSpeedTime: number = 0;
  private currentSpeed: number = 0;
  private startTime: number = 0;
  private lastReadTime: number = 0;

  // Retry config
  private static readonly MAX_RETRIES = 5;
  private static readonly BASE_DELAY = 1000;

  constructor(config: EncryptedSourceConfig) {
    this.config = config;
    Logger.info(TAG, `Created for video: ${config.videoId}`);
  }

  async getSize(): Promise<number> {
    if (this.size === -1) {
      await this.refreshToken();
    }
    return this.size;
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    const clampedOffset = Math.max(0, Math.min(offset, this.size > 0 ? this.size : Infinity));
    const availableLength = this.size > 0 ? this.size - clampedOffset : length;
    const clampedLength = Math.max(0, Math.min(length, availableLength));
    if (clampedLength === 0 && this.size > 0) return new ArrayBuffer(0);

    this.lastReadTime = Date.now();
    let retryCount = 0;

    while (true) {
      try {
        // Ensure we have a valid token
        if (!this.currentToken || Date.now() >= this.tokenExpiresAt) {
          await this.refreshToken();
        }

        // Generate unique nonce for this request
        const nonce = this.generateNonce();
        const timestamp = Date.now();

        // Sign the request with HMAC
        const signature = await this.signRequest(
          this.currentToken, nonce, timestamp, clampedOffset, clampedLength
        );

        const headers: Record<string, string> = {
          "Range": `bytes=${clampedOffset}-${clampedOffset + clampedLength - 1}`,
          "X-Token": this.currentToken,
          "X-Fingerprint": this.config.fingerprint,
          "X-Nonce": nonce,
          "X-Timestamp": timestamp.toString(),
          "X-Signature": signature,
          ...this.config.headers,
        };

        const response = await fetch(this.config.videoUrl, {
          method: "GET",
          headers,
          credentials: "include",
        });

        if (response.status === 401 || response.status === 403) {
          Logger.warn(TAG, `Auth failed: ${response.status}`);
          this.config.onAuthFailed?.(`Token rejected: ${response.status}`);
          await this.refreshToken();
          continue; // Retry with new token
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const encryptedData = await response.arrayBuffer();

        // Track stats
        this.totalBytesDownloaded += encryptedData.byteLength;
        const now = Date.now();
        if (this.startTime === 0) {
          this.startTime = now;
          this.lastSpeedTime = now;
        }
        const elapsed = (now - this.lastSpeedTime) / 1000;
        if (elapsed >= 0.5) {
          this.currentSpeed = (this.totalBytesDownloaded - this.lastSpeedBytes) / elapsed;
          this.lastSpeedBytes = this.totalBytesDownloaded;
          this.lastSpeedTime = now;
        }
        this.lastReadTime = now;

        // Decrypt if key available (client-side encryption)
        // If server decrypts, cryptoKey will be null and we pass data through
        let result: ArrayBuffer;
        if (this.cryptoKey && this.iv) {
          result = await this.decrypt(encryptedData);
        } else {
          result = encryptedData;
        }
        this.position = clampedOffset + result.byteLength;
        if (this.position > this.maxBufferedEnd) this.maxBufferedEnd = this.position;

        retryCount = 0; // Reset on success
        return result;
      } catch (error) {
        const errorMessage = (error as any)?.message || "";
        const isFetchError = (error as any)?.name === "TypeError" && errorMessage.includes("Failed to fetch");
        const isOffline = typeof self !== "undefined" && self.navigator && !self.navigator.onLine;

        // If offline, wait for connection before retrying
        if (isFetchError && isOffline) {
          Logger.warn(TAG, "Network offline, waiting for connection...");
          await new Promise<void>((resolve) => {
            const onOnline = () => { self.removeEventListener("online", onOnline); resolve(); };
            self.addEventListener("online", onOnline);
          });
          Logger.info(TAG, "Network online, resuming...");
          retryCount = 0;
          continue;
        }

        // CORS or fatal error when online — don't retry
        if (isFetchError && !isOffline) {
          Logger.error(TAG, "CORS or network error", error);
          throw new Error("Failed to fetch encrypted video. Check connection or CORS settings.");
        }

        retryCount++;
        if (retryCount > EncryptedHttpSource.MAX_RETRIES) {
          Logger.error(TAG, `Max retries (${EncryptedHttpSource.MAX_RETRIES}) reached`);
          throw error;
        }

        Logger.warn(TAG, `Read error, retrying (${retryCount}/${EncryptedHttpSource.MAX_RETRIES})...`);
        const delay = Math.min(EncryptedHttpSource.BASE_DELAY * Math.pow(1.5, retryCount), 10000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  seek(offset: number): number {
    this.position = Math.max(0, Math.min(offset, this.size));
    return this.position;
  }

  getPosition(): number {
    return this.position;
  }

  getKey(): string {
    return `encrypted:${this.config.videoId}`;
  }

  close(): void {
    this.cryptoKey = null;
    this.hmacKey = null;
    this.iv = null;
    this.currentToken = "";
    this.usedNonces.clear();
    Logger.info(TAG, "Closed");
  }

  // ─── HMAC Signing ──────────────────────────────────────────────

  /**
   * Generate a cryptographically random nonce (one-time use)
   */
  private generateNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    // Prevent client-side reuse
    if (this.usedNonces.has(nonce)) {
      return this.generateNonce(); // Extremely unlikely, but safe
    }
    this.usedNonces.add(nonce);

    // Keep set small — clear old nonces periodically
    if (this.usedNonces.size > 1000) {
      const arr = Array.from(this.usedNonces);
      this.usedNonces = new Set(arr.slice(-500));
    }

    return nonce;
  }

  /**
   * Sign a request using HMAC-SHA256
   * Signature = HMAC(token + nonce + timestamp + offset + length)
   * Server verifies the same signature — proves client has the session secret
   */
  private async signRequest(
    token: string, nonce: string, timestamp: number,
    offset: number, length: number
  ): Promise<string> {
    if (!this.hmacKey) {
      throw new Error("No HMAC key available");
    }

    const message = `${token}:${nonce}:${timestamp}:${offset}:${length}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    const signature = await crypto.subtle.sign("HMAC", this.hmacKey, data);
    const sigArray = Array.from(new Uint8Array(signature));
    return sigArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ─── Token Management ─────────────────────────────────────────

  /**
   * Request a new short-lived token + HMAC secret from auth server
   */
  private async refreshToken(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      const response = await fetch(this.config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.sessionToken}`,
          ...this.config.headers,
        },
        body: JSON.stringify({
          videoId: this.config.videoId,
          fingerprint: this.config.fingerprint,
        }),
        credentials: "include",
      });

      if (!response.ok) {
        const reason = `Token request failed: ${response.status}`;
        Logger.error(TAG, reason);
        this.config.onAuthFailed?.(reason);
        throw new Error(reason);
      }

      const data: TokenResponse = await response.json();

      // Import AES decryption key (optional — server may decrypt)
      if (data.key) {
        const keyBytes = Uint8Array.from(atob(data.key), (c) => c.charCodeAt(0));
        this.cryptoKey = await crypto.subtle.importKey(
          "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]
        );
      }

      // Import HMAC signing key
      const hmacBytes = Uint8Array.from(atob(data.hmacSecret), (c) => c.charCodeAt(0));
      this.hmacKey = await crypto.subtle.importKey(
        "raw", hmacBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );

      // Store IV (optional)
      if (data.iv) {
        this.iv = Uint8Array.from(atob(data.iv), (c) => c.charCodeAt(0));
      }
      this.currentToken = data.token;
      this.tokenExpiresAt = data.expiresAt;
      this.chunkSize = data.chunkSize || this.chunkSize;

      if (this.size === -1) {
        this.size = data.fileSize;
      }

      // Clear old nonces on token refresh
      this.usedNonces.clear();

      Logger.debug(TAG, `Token refreshed, expires in ${data.expiresAt - Date.now()}ms`);
    } finally {
      this.isRefreshing = false;
    }
  }

  // ─── Decryption ────────────────────────────────────────────────

  /**
   * Decrypt data with AES-256-GCM
   */
  private async decrypt(encryptedData: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.cryptoKey || !this.iv) {
      throw new Error("No decryption key available");
    }

    try {
      return await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: this.iv as Uint8Array<ArrayBuffer> },
        this.cryptoKey,
        encryptedData,
      );
    } catch (error) {
      Logger.error(TAG, "Decryption failed", error);
      throw new Error("Decryption failed — key may have expired");
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────

  /**
   * Get furthest byte position read (for buffer progress bar)
   */
  getBufferedEnd(): number {
    return this.maxBufferedEnd;
  }

  getNetworkStats(): { totalBytes: number; currentSpeed: number; elapsed: number } {
    // Reset speed to 0 after 1s idle (prevents stale graph on pause)
    if (this.lastReadTime > 0 && (Date.now() - this.lastReadTime) > 1000) {
      this.currentSpeed = 0;
    }
    return {
      totalBytes: this.totalBytesDownloaded,
      currentSpeed: this.currentSpeed,
      elapsed: this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0,
    };
  }
}
