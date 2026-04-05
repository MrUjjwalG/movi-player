// Detect video URLs on page and add play button overlay
const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|mov|avi|ts|m3u8|flv|m4v|ogv|wmv)(\?|$)/i;

function isVideoUrl(url) {
  return VIDEO_EXTENSIONS.test(url);
}

function createPlayButton(link) {
  // Don't add if already has one
  if (link.dataset.moviBtn) return;
  link.dataset.moviBtn = "true";

  const btn = document.createElement("div");
  btn.className = "movi-ext-play-btn";
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="white" width="20" height="20"><path d="M8 5v14l11-7z"/></svg>`;
  btn.title = "Play with Movi Player";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      action: "openPlayer",
      url: link.href,
    });
  });

  // Position relative to link
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

// Scan on load
scanPage();

// Re-scan on DOM changes (SPA, dynamic content)
const observer = new MutationObserver(() => {
  scanPage();
});
observer.observe(document.body, { childList: true, subtree: true });
