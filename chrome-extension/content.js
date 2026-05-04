// Mark the document so the official Movi Player site can detect that the
// extension is installed and skip its "Add to Chrome" prompt. Runs on every
// page (cheap, single attribute write) so we don't depend on manifest match
// patterns being perfectly tuned for every host (localhost ports, etc.).
try {
  if (document.documentElement) {
    document.documentElement.setAttribute("data-movi-extension", "installed");
  }
} catch {}

// Detect video URLs on page and add play button overlay
const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|mov|avi|ts|m3u8|flv|m4v|ogv|wmv|m2ts|mts|3gp|mpg|mpeg)(\?|$)/i;

function isVideoUrl(url) {
  return VIDEO_EXTENSIONS.test(url);
}

function createPlayButton(link) {
  if (link.dataset.moviBtn) return;
  link.dataset.moviBtn = "true";

  const btn = document.createElement("div");
  btn.className = "movi-ext-play-btn";
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="24" height="24"><defs><linearGradient id="moviExtG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6c5dd3"/><stop offset="100%" stop-color="#4a3bba"/></linearGradient></defs><circle cx="50" cy="50" r="45" fill="url(#moviExtG)"/><polygon points="39,29 39,71 74,50" fill="white"/></svg>`;
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

// Scan page for video links
function scanPage() {
  const links = document.querySelectorAll("a[href]");
  links.forEach((link) => {
    if (isVideoUrl(link.href)) {
      createPlayButton(link);
    }
  });
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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="56" height="56">
          <defs>
            <linearGradient id="moviExtOverlayG" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#6c5dd3"/>
              <stop offset="100%" stop-color="#4a3bba"/>
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r="45" fill="url(#moviExtOverlayG)"/>
          <polygon points="39,29 39,71 74,50" fill="white"/>
        </svg>
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
