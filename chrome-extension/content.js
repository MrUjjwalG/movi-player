// Extension-presence signalling lives in marker.js (a MAIN-world script that
// sets window.__moviExtension) — see that file for why we don't tag the DOM.

// Detect media (video + audio) URLs on page and add a play button overlay.
// Kept in sync with MEDIA_EXT_RE in player.js so anything the player can open
// gets a button here too.
const MEDIA_EXT_GROUP =
  "mp4|mkv|webm|mov|avi|ts|m3u8|mpd|flv|m4v|ogv|wmv|m2ts|mts|evo|3gp|mpg|mpeg|mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|ac3|ec3|eac3|mka|dts";
const MEDIA_EXTENSIONS = new RegExp(`\\.(${MEDIA_EXT_GROUP})(\\?|$)`, "i");
// Presigned download URLs (S3, Cloudflare R2, GCS) carry no file extension in
// the path — the real filename lives in a response-content-disposition /
// filename= query param, URL-encoded (e.g. `...filename%3D%22Movie.mkv%22...`).
// After decoding that reads `filename="Movie.mkv"`, so match the extension when
// it's terminated by a quote, `&`, `;`, or end-of-string.
const DISPOSITION_MEDIA_RE = new RegExp(
  `filename[^=]*=\\s*"?[^"&;]*\\.(${MEDIA_EXT_GROUP})("|&|;|$)`,
  "i"
);

function isMediaUrl(url) {
  if (MEDIA_EXTENSIONS.test(url)) return true;
  try {
    if (DISPOSITION_MEDIA_RE.test(decodeURIComponent(url))) return true;
  } catch {}
  return false;
}

function createPlayButton(link) {
  if (link.dataset.moviBtn) return;
  link.dataset.moviBtn = "true";

  const btn = document.createElement("div");
  btn.className = "movi-ext-play-btn";
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="24" height="24" aria-hidden="true"><defs><linearGradient id="moviExtGL" gradientUnits="userSpaceOnUse" x1="27" y1="18" x2="27" y2="84"><stop offset="0" stop-color="#6366ff"/><stop offset=".5" stop-color="#3d4dff"/><stop offset="1" stop-color="#1638d2"/></linearGradient><linearGradient id="moviExtGT" gradientUnits="userSpaceOnUse" x1="27" y1="20" x2="80" y2="50"><stop offset="0" stop-color="#86b6ff"/><stop offset=".55" stop-color="#4f86ff"/><stop offset="1" stop-color="#14aaff"/></linearGradient><linearGradient id="moviExtGB" gradientUnits="userSpaceOnUse" x1="27" y1="80" x2="80" y2="50"><stop offset="0" stop-color="#5a4dff"/><stop offset=".5" stop-color="#8e72ff"/><stop offset="1" stop-color="#7cb9ff"/></linearGradient></defs><g fill="none" stroke-linecap="round" stroke-width="17"><path d="M77 52 27 80" stroke="url(#moviExtGB)"/><path d="M27 20 77 48" stroke="url(#moviExtGT)"/><path d="M27 20v60" stroke="url(#moviExtGL)"/><path d="M27 80 41 72.2" stroke="url(#moviExtGB)"/></g></svg>`;
  btn.title = "Play with Movi Player";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      action: "openPlayer",
      url: link.href,
    });
  });

  const wrapper = link.parentElement;
  if (wrapper) {
    wrapper.style.position = wrapper.style.position || "relative";
  }
  link.style.position = link.style.position || "relative";
  link.appendChild(btn);
}

// Scan page for media links — only the cheap regex match here. _blank link
// probing is hover-triggered (see the mouseover listener below) to avoid
// firing HEAD requests for every target="_blank" on link-heavy pages.
function scanPage() {
  const links = document.querySelectorAll("a[href]");
  links.forEach((link) => {
    if (isMediaUrl(link.href)) {
      createPlayButton(link);
    }
  });
}

// Hover-triggered probing for any link that doesn't match the extension
// regex. Event delegation = no per-link listener overhead.
document.addEventListener(
  "mouseover",
  (e) => {
    if (!probeEnabled) return;
    const link = e.target.closest?.("a[href]");
    if (!link) return;
    if (link.dataset.moviBtn) return;
    if (isMediaUrl(link.href)) return; // would already be handled by scanPage
    maybeProbeLink(link);
  },
  true
);

// URLs we've already asked the background to probe (or are queued). Stores the
// final URL string regardless of outcome so we never re-probe the same target.
const probedUrls = new Map(); // url -> "pending" | "video" | "not-video"
const probeQueue = [];
let activeProbes = 0;
const MAX_CONCURRENT_PROBES = 4;

// Gated by an opt-in setting. Default off — the feature requires the
// `<all_urls>` host permission, which the user grants from the toggle on the
// player page.
// Probing is hover-triggered, so nothing extra to do on enable/disable
// beyond keeping this flag fresh.
let probeEnabled = false;
chrome.storage?.local.get("probeBlankLinks", (data) => {
  probeEnabled = !!data?.probeBlankLinks;
});
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("probeBlankLinks" in changes)) return;
  probeEnabled = !!changes.probeBlankLinks.newValue;
});

function maybeProbeLink(link) {
  if (!probeEnabled) return;
  const url = link.href;
  if (!url || !/^https?:/i.test(url)) return;

  const prior = probedUrls.get(url);
  if (prior === "video") {
    createPlayButton(link);
    return;
  }
  if (prior) return; // pending or already determined not-video

  probedUrls.set(url, "pending");
  probeQueue.push(url);
  drainProbeQueue();
}

function drainProbeQueue() {
  while (activeProbes < MAX_CONCURRENT_PROBES && probeQueue.length) {
    const url = probeQueue.shift();
    activeProbes++;
    chrome.runtime.sendMessage({ action: "probeVideo", url }, (resp) => {
      activeProbes--;
      // chrome.runtime.lastError fires when the service worker dropped the
      // response (e.g. extension reloaded). Treat as a benign miss.
      if (chrome.runtime.lastError) {
        probedUrls.set(url, "not-video");
      } else if (resp && resp.isVideo) {
        probedUrls.set(url, "video");
        // Tag every matching link currently in the DOM (a URL may appear in
        // several <a> elements on link-heavy pages).
        document.querySelectorAll(`a[href="${CSS.escape(url)}"]`).forEach(createPlayButton);
      } else {
        probedUrls.set(url, "not-video");
      }
      drainProbeQueue();
    });
  }
}

// Detect Chrome's native direct-video viewer (file:// video, or http direct video URL).
// Chrome renders a bare <video> element as the sole child of <body> for these pages.
function isNativeVideoViewer() {
  const video = document.querySelector("body > video");
  if (!video) return false;
  // Body should contain essentially only the video element (Chrome's native viewer layout)
  const meaningfulChildren = Array.from(document.body.children).filter(
    (el) => !el.classList?.contains("movi-ext-direct-overlay")
  );
  return meaningfulChildren.length === 1 && meaningfulChildren[0].tagName === "VIDEO";
}

function getVideoSourceUrl() {
  const video = document.querySelector("body > video");
  if (!video) return null;
  return video.currentSrc || video.src || location.href;
}

let directOverlayDismissed = false;

function injectDirectVideoOverlay() {
  if (directOverlayDismissed) return;
  if (document.getElementById("movi-ext-direct-overlay")) return;

  const videoUrl = getVideoSourceUrl();
  if (!videoUrl) return;

  const video = document.querySelector("body > video");
  // Pause the native video so two players don't overlap audio
  try { video?.pause(); } catch {}

  const overlay = document.createElement("div");
  overlay.id = "movi-ext-direct-overlay";
  overlay.className = "movi-ext-direct-overlay";
  overlay.innerHTML = `
    <div class="movi-ext-card">
      <div class="movi-ext-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="56" height="56" aria-hidden="true"><defs><linearGradient id="moviExtOverlayGL" gradientUnits="userSpaceOnUse" x1="27" y1="18" x2="27" y2="84"><stop offset="0" stop-color="#6366ff"/><stop offset=".5" stop-color="#3d4dff"/><stop offset="1" stop-color="#1638d2"/></linearGradient><linearGradient id="moviExtOverlayGT" gradientUnits="userSpaceOnUse" x1="27" y1="20" x2="80" y2="50"><stop offset="0" stop-color="#86b6ff"/><stop offset=".55" stop-color="#4f86ff"/><stop offset="1" stop-color="#14aaff"/></linearGradient><linearGradient id="moviExtOverlayGB" gradientUnits="userSpaceOnUse" x1="27" y1="80" x2="80" y2="50"><stop offset="0" stop-color="#5a4dff"/><stop offset=".5" stop-color="#8e72ff"/><stop offset="1" stop-color="#7cb9ff"/></linearGradient></defs><g fill="none" stroke-linecap="round" stroke-width="17"><path d="M77 52 27 80" stroke="url(#moviExtOverlayGB)"/><path d="M27 20 77 48" stroke="url(#moviExtOverlayGT)"/><path d="M27 20v60" stroke="url(#moviExtOverlayGL)"/><path d="M27 80 41 72.2" stroke="url(#moviExtOverlayGB)"/></g></svg>
      </div>
      <div class="movi-ext-title">Open with Movi Player</div>
      <div class="movi-ext-desc">Play this video with advanced codec support, subtitles, and more.</div>
      <button class="movi-ext-btn" id="movi-ext-open">Play in Movi Player</button>
      <button class="movi-ext-dismiss" id="movi-ext-dismiss" title="Dismiss">&times;</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("movi-ext-open").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openPlayer", url: videoUrl, replaceTab: true });
  });
  document.getElementById("movi-ext-dismiss").addEventListener("click", () => {
    directOverlayDismissed = true;
    overlay.remove();
    try { video?.play(); } catch {}
  });
}

// Bail out on non-HTML documents (SVG, XML, image viewers, etc.) — they have
// no <body> element, so MutationObserver and our DOM scans would just throw.
if (document.body instanceof HTMLElement) {
  // Initial scan
  if (isNativeVideoViewer()) {
    injectDirectVideoOverlay();
  } else {
    scanPage();
  }

  // Re-scan on DOM changes (SPA, dynamic content)
  const observer = new MutationObserver(() => {
    if (isNativeVideoViewer()) {
      injectDirectVideoOverlay();
    } else {
      scanPage();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
