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
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="323 49 930 930" width="24" height="24" aria-hidden="true"><defs><clipPath id="moviExtGL-0"><path clip-rule="evenodd" d="M383.55 222 C383.55 152.17 440.03 97.5 512 97.5 C543.4 97.5 559.7 101.8 590 117.5 L1100 381.5 C1174.55 414.03 1191.47 471.49 1193 512.5 C1192.29 590.19 1134.3 634.06 1100 646.5 C930.83 737.99 761.67 826.04 592.5 909 C571.47 917.98 554.22 929.25 512 930.3 C455.97 929.9 384.46 889.54 383.55 802 Z M614 360 L913 520 C686.95 641.07 614 666.34 614 669 Z"/></clipPath><linearGradient id="moviExtGL-1" gradientUnits="userSpaceOnUse" x1="0" y1="97" x2="0" y2="360"><stop offset="0" stop-color="#737bfd"/><stop offset="0.5" stop-color="#6eb3fd"/><stop offset="1" stop-color="#81e1fe"/></linearGradient><radialGradient id="moviExtGL-2" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(726.13 101.51) scale(218.96 701.75)"><stop offset="0" stop-color="#0c00fd"/><stop offset="0.12" stop-color="#0c00fd" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0c00fd" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0c00fd" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0c00fd" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0c00fd" stop-opacity="0.006"/><stop offset="1" stop-color="#0c00fd" stop-opacity="0"/></radialGradient><radialGradient id="moviExtGL-3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(255.4 225.67) scale(350.82 206.02)"><stop offset="0" stop-color="#4c00fd" stop-opacity="0.58"/><stop offset="0.12" stop-color="#4c00fd" stop-opacity="0.484"/><stop offset="0.24" stop-color="#4c00fd" stop-opacity="0.282"/><stop offset="0.36" stop-color="#4c00fd" stop-opacity="0.115"/><stop offset="0.48" stop-color="#4c00fd" stop-opacity="0.033"/><stop offset="0.64" stop-color="#4c00fd" stop-opacity="0.003"/><stop offset="1" stop-color="#4c00fd" stop-opacity="0"/></radialGradient><linearGradient id="moviExtGL-4" gradientUnits="userSpaceOnUse" x1="0" y1="225" x2="0" y2="817"><stop offset="0" stop-color="#5143ff"/><stop offset="0.5" stop-color="#294cf6"/><stop offset="1" stop-color="#0437cc"/></linearGradient><radialGradient id="moviExtGL-5" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(621.75 616.05) scale(192.93 939.93)"><stop offset="0" stop-color="#436eff"/><stop offset="0.12" stop-color="#436eff" stop-opacity="0.835"/><stop offset="0.24" stop-color="#436eff" stop-opacity="0.487"/><stop offset="0.36" stop-color="#436eff" stop-opacity="0.198"/><stop offset="0.48" stop-color="#436eff" stop-opacity="0.056"/><stop offset="0.64" stop-color="#436eff" stop-opacity="0.006"/><stop offset="1" stop-color="#436eff" stop-opacity="0"/></radialGradient><radialGradient id="moviExtGL-6" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(637.74 314.49) scale(126.64 109.33)"><stop offset="0" stop-color="#0000ec"/><stop offset="0.12" stop-color="#0000ec" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0000ec" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0000ec" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0000ec" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0000ec" stop-opacity="0.006"/><stop offset="1" stop-color="#0000ec" stop-opacity="0"/></radialGradient><linearGradient id="moviExtGL-7" gradientUnits="userSpaceOnUse" x1="0" y1="669" x2="0" y2="930"><stop offset="0" stop-color="#001fad"/><stop offset="0.5" stop-color="#2e50ff"/><stop offset="1" stop-color="#3d4eff"/></linearGradient><radialGradient id="moviExtGL-8" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(367.66 690.91) scale(257.59 321.92)"><stop offset="0" stop-color="#0023ab"/><stop offset="0.12" stop-color="#0023ab" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0023ab" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0023ab" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0023ab" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0023ab" stop-opacity="0.006"/><stop offset="1" stop-color="#0023ab" stop-opacity="0"/></radialGradient><radialGradient id="moviExtGL-9" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(554.73 904.5) scale(161.77 151.07)"><stop offset="0" stop-color="#564efc"/><stop offset="0.12" stop-color="#564efc" stop-opacity="0.835"/><stop offset="0.24" stop-color="#564efc" stop-opacity="0.487"/><stop offset="0.36" stop-color="#564efc" stop-opacity="0.198"/><stop offset="0.48" stop-color="#564efc" stop-opacity="0.056"/><stop offset="0.64" stop-color="#564efc" stop-opacity="0.006"/><stop offset="1" stop-color="#564efc" stop-opacity="0"/></radialGradient><linearGradient id="moviExtGL-10" gradientUnits="userSpaceOnUse" x1="460" y1="0" x2="1185" y2="0"><stop offset="0" stop-color="#4442fc"/><stop offset="0.5" stop-color="#5800fd"/><stop offset="1" stop-color="#00c9ff"/></linearGradient><radialGradient id="moviExtGL-11" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(918.16 679.1) scale(562.77 1104.38)"><stop offset="0" stop-color="#b3acfc" stop-opacity="0.732"/><stop offset="0.12" stop-color="#b3acfc" stop-opacity="0.611"/><stop offset="0.24" stop-color="#b3acfc" stop-opacity="0.356"/><stop offset="0.36" stop-color="#b3acfc" stop-opacity="0.145"/><stop offset="0.48" stop-color="#b3acfc" stop-opacity="0.041"/><stop offset="0.64" stop-color="#b3acfc" stop-opacity="0.004"/><stop offset="1" stop-color="#b3acfc" stop-opacity="0"/></radialGradient><linearGradient id="moviExtGL-12" gradientUnits="userSpaceOnUse" x1="933.66" y1="4.95" x2="816.34" y2="695.05"><stop offset="0" stop-color="#ff3efc"/><stop offset=".25" stop-color="#6cb1fd"/><stop offset=".5" stop-color="#548cfd"/><stop offset=".75" stop-color="#295dfd"/><stop offset="1" stop-color="#0b07f8"/></linearGradient><radialGradient id="moviExtGL-13" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(1255.8 459.16) rotate(22.04) scale(464.67 224.5)"><stop offset="0" stop-color="#00d4fe" stop-opacity="0.797"/><stop offset=".5" stop-color="#00d4fe" stop-opacity="0.246"/><stop offset="1" stop-color="#00d4fe" stop-opacity="0"/></radialGradient><radialGradient id="moviExtGL-14" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(630 351) rotate(-113.37) scale(1399.91 230.15)"><stop offset="0" stop-color="#a0effd" stop-opacity="0.2"/><stop offset=".5" stop-color="#a0effd" stop-opacity="0"/><stop offset="1" stop-color="#a0effd" stop-opacity="0"/></radialGradient><path id="moviExtGL-15" d="M350 80 H1220 V950 H350 Z"/><path id="moviExtGL-16" d="M350 80 H614 V668.5 C394.51 759.97 395.83 810.57 384 817 H350 Z"/><path id="moviExtGL-17" d="M384 817 C395.83 810.57 394.51 759.97 614 668.5 C601.76 795.98 495.68 900.62 460 920 L350 960 V817 Z"/><path id="moviExtGL-18" d="M350 80 H1220 V545 L1184 558 C1091.75 639.78 1018.25 572.14 913 520 L614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/><path id="moviExtGL-19" d="M350 80 H520 L539 100 C563.83 110.79 604.49 141.82 611.5 230 C614.03 257.11 613.18 307.14 614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/></defs><g clip-path="url(#moviExtGL-0)"><g id="moviExtGL-20"><use href="#moviExtGL-15" fill="url(#moviExtGL-10)"/><use href="#moviExtGL-15" fill="url(#moviExtGL-11)"/></g><g id="moviExtGL-21"><use href="#moviExtGL-16" fill="url(#moviExtGL-4)"/><use href="#moviExtGL-16" fill="url(#moviExtGL-5)"/><use href="#moviExtGL-16" fill="url(#moviExtGL-6)"/></g><g id="moviExtGL-22"><use href="#moviExtGL-17" fill="url(#moviExtGL-7)"/><use href="#moviExtGL-17" fill="url(#moviExtGL-8)"/><use href="#moviExtGL-17" fill="url(#moviExtGL-9)"/></g><g id="moviExtGL-23"><use href="#moviExtGL-18" fill="url(#moviExtGL-12)"/><use href="#moviExtGL-18" fill="url(#moviExtGL-13)"/><use href="#moviExtGL-18" fill="url(#moviExtGL-14)"/></g><g id="moviExtGL-24"><use href="#moviExtGL-19" fill="url(#moviExtGL-1)"/><use href="#moviExtGL-19" fill="url(#moviExtGL-2)"/><use href="#moviExtGL-19" fill="url(#moviExtGL-3)"/></g></g></svg>`;
  btn.title = "Play with MoviPlayer";

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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="323 49 930 930" width="56" height="56" aria-hidden="true"><defs><clipPath id="moviExtOverlayGL-0"><path clip-rule="evenodd" d="M383.55 222 C383.55 152.17 440.03 97.5 512 97.5 C543.4 97.5 559.7 101.8 590 117.5 L1100 381.5 C1174.55 414.03 1191.47 471.49 1193 512.5 C1192.29 590.19 1134.3 634.06 1100 646.5 C930.83 737.99 761.67 826.04 592.5 909 C571.47 917.98 554.22 929.25 512 930.3 C455.97 929.9 384.46 889.54 383.55 802 Z M614 360 L913 520 C686.95 641.07 614 666.34 614 669 Z"/></clipPath><linearGradient id="moviExtOverlayGL-1" gradientUnits="userSpaceOnUse" x1="0" y1="97" x2="0" y2="360"><stop offset="0" stop-color="#737bfd"/><stop offset="0.5" stop-color="#6eb3fd"/><stop offset="1" stop-color="#81e1fe"/></linearGradient><radialGradient id="moviExtOverlayGL-2" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(726.13 101.51) scale(218.96 701.75)"><stop offset="0" stop-color="#0c00fd"/><stop offset="0.12" stop-color="#0c00fd" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0c00fd" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0c00fd" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0c00fd" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0c00fd" stop-opacity="0.006"/><stop offset="1" stop-color="#0c00fd" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(255.4 225.67) scale(350.82 206.02)"><stop offset="0" stop-color="#4c00fd" stop-opacity="0.58"/><stop offset="0.12" stop-color="#4c00fd" stop-opacity="0.484"/><stop offset="0.24" stop-color="#4c00fd" stop-opacity="0.282"/><stop offset="0.36" stop-color="#4c00fd" stop-opacity="0.115"/><stop offset="0.48" stop-color="#4c00fd" stop-opacity="0.033"/><stop offset="0.64" stop-color="#4c00fd" stop-opacity="0.003"/><stop offset="1" stop-color="#4c00fd" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-4" gradientUnits="userSpaceOnUse" x1="0" y1="225" x2="0" y2="817"><stop offset="0" stop-color="#5143ff"/><stop offset="0.5" stop-color="#294cf6"/><stop offset="1" stop-color="#0437cc"/></linearGradient><radialGradient id="moviExtOverlayGL-5" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(621.75 616.05) scale(192.93 939.93)"><stop offset="0" stop-color="#436eff"/><stop offset="0.12" stop-color="#436eff" stop-opacity="0.835"/><stop offset="0.24" stop-color="#436eff" stop-opacity="0.487"/><stop offset="0.36" stop-color="#436eff" stop-opacity="0.198"/><stop offset="0.48" stop-color="#436eff" stop-opacity="0.056"/><stop offset="0.64" stop-color="#436eff" stop-opacity="0.006"/><stop offset="1" stop-color="#436eff" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-6" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(637.74 314.49) scale(126.64 109.33)"><stop offset="0" stop-color="#0000ec"/><stop offset="0.12" stop-color="#0000ec" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0000ec" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0000ec" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0000ec" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0000ec" stop-opacity="0.006"/><stop offset="1" stop-color="#0000ec" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-7" gradientUnits="userSpaceOnUse" x1="0" y1="669" x2="0" y2="930"><stop offset="0" stop-color="#001fad"/><stop offset="0.5" stop-color="#2e50ff"/><stop offset="1" stop-color="#3d4eff"/></linearGradient><radialGradient id="moviExtOverlayGL-8" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(367.66 690.91) scale(257.59 321.92)"><stop offset="0" stop-color="#0023ab"/><stop offset="0.12" stop-color="#0023ab" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0023ab" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0023ab" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0023ab" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0023ab" stop-opacity="0.006"/><stop offset="1" stop-color="#0023ab" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-9" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(554.73 904.5) scale(161.77 151.07)"><stop offset="0" stop-color="#564efc"/><stop offset="0.12" stop-color="#564efc" stop-opacity="0.835"/><stop offset="0.24" stop-color="#564efc" stop-opacity="0.487"/><stop offset="0.36" stop-color="#564efc" stop-opacity="0.198"/><stop offset="0.48" stop-color="#564efc" stop-opacity="0.056"/><stop offset="0.64" stop-color="#564efc" stop-opacity="0.006"/><stop offset="1" stop-color="#564efc" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-10" gradientUnits="userSpaceOnUse" x1="460" y1="0" x2="1185" y2="0"><stop offset="0" stop-color="#4442fc"/><stop offset="0.5" stop-color="#5800fd"/><stop offset="1" stop-color="#00c9ff"/></linearGradient><radialGradient id="moviExtOverlayGL-11" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(918.16 679.1) scale(562.77 1104.38)"><stop offset="0" stop-color="#b3acfc" stop-opacity="0.732"/><stop offset="0.12" stop-color="#b3acfc" stop-opacity="0.611"/><stop offset="0.24" stop-color="#b3acfc" stop-opacity="0.356"/><stop offset="0.36" stop-color="#b3acfc" stop-opacity="0.145"/><stop offset="0.48" stop-color="#b3acfc" stop-opacity="0.041"/><stop offset="0.64" stop-color="#b3acfc" stop-opacity="0.004"/><stop offset="1" stop-color="#b3acfc" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-12" gradientUnits="userSpaceOnUse" x1="933.66" y1="4.95" x2="816.34" y2="695.05"><stop offset="0" stop-color="#ff3efc"/><stop offset=".25" stop-color="#6cb1fd"/><stop offset=".5" stop-color="#548cfd"/><stop offset=".75" stop-color="#295dfd"/><stop offset="1" stop-color="#0b07f8"/></linearGradient><radialGradient id="moviExtOverlayGL-13" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(1255.8 459.16) rotate(22.04) scale(464.67 224.5)"><stop offset="0" stop-color="#00d4fe" stop-opacity="0.797"/><stop offset=".5" stop-color="#00d4fe" stop-opacity="0.246"/><stop offset="1" stop-color="#00d4fe" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-14" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(630 351) rotate(-113.37) scale(1399.91 230.15)"><stop offset="0" stop-color="#a0effd" stop-opacity="0.2"/><stop offset=".5" stop-color="#a0effd" stop-opacity="0"/><stop offset="1" stop-color="#a0effd" stop-opacity="0"/></radialGradient><path id="moviExtOverlayGL-15" d="M350 80 H1220 V950 H350 Z"/><path id="moviExtOverlayGL-16" d="M350 80 H614 V668.5 C394.51 759.97 395.83 810.57 384 817 H350 Z"/><path id="moviExtOverlayGL-17" d="M384 817 C395.83 810.57 394.51 759.97 614 668.5 C601.76 795.98 495.68 900.62 460 920 L350 960 V817 Z"/><path id="moviExtOverlayGL-18" d="M350 80 H1220 V545 L1184 558 C1091.75 639.78 1018.25 572.14 913 520 L614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/><path id="moviExtOverlayGL-19" d="M350 80 H520 L539 100 C563.83 110.79 604.49 141.82 611.5 230 C614.03 257.11 613.18 307.14 614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/></defs><g clip-path="url(#moviExtOverlayGL-0)"><g id="moviExtOverlayGL-20"><use href="#moviExtOverlayGL-15" fill="url(#moviExtOverlayGL-10)"/><use href="#moviExtOverlayGL-15" fill="url(#moviExtOverlayGL-11)"/></g><g id="moviExtOverlayGL-21"><use href="#moviExtOverlayGL-16" fill="url(#moviExtOverlayGL-4)"/><use href="#moviExtOverlayGL-16" fill="url(#moviExtOverlayGL-5)"/><use href="#moviExtOverlayGL-16" fill="url(#moviExtOverlayGL-6)"/></g><g id="moviExtOverlayGL-22"><use href="#moviExtOverlayGL-17" fill="url(#moviExtOverlayGL-7)"/><use href="#moviExtOverlayGL-17" fill="url(#moviExtOverlayGL-8)"/><use href="#moviExtOverlayGL-17" fill="url(#moviExtOverlayGL-9)"/></g><g id="moviExtOverlayGL-23"><use href="#moviExtOverlayGL-18" fill="url(#moviExtOverlayGL-12)"/><use href="#moviExtOverlayGL-18" fill="url(#moviExtOverlayGL-13)"/><use href="#moviExtOverlayGL-18" fill="url(#moviExtOverlayGL-14)"/></g><g id="moviExtOverlayGL-24"><use href="#moviExtOverlayGL-19" fill="url(#moviExtOverlayGL-1)"/><use href="#moviExtOverlayGL-19" fill="url(#moviExtOverlayGL-2)"/><use href="#moviExtOverlayGL-19" fill="url(#moviExtOverlayGL-3)"/></g></g></svg>
      </div>
      <div class="movi-ext-title">Open with MoviPlayer</div>
      <div class="movi-ext-desc">Play this video with advanced codec support, subtitles, and more.</div>
      <button class="movi-ext-btn" id="movi-ext-open">Play in MoviPlayer</button>
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

// This script runs in every frame (all_frames), so a video embedded through
// an iframe gets the same treatment as one on the page itself.
const IS_TOP_FRAME = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

// Bail out on non-HTML documents (SVG, XML, image viewers, etc.) — they have
// no <body> element, so MutationObserver and our DOM scans would just throw.
if (document.body instanceof HTMLElement) {
  // The "Open with MoviPlayer" card is for a TAB showing a bare video file:
  // its button replaces the tab. In a frame that is someone else's page, so
  // a frame that happens to be a bare file is left to the takeover instead.
  const directViewer = () => IS_TOP_FRAME && isNativeVideoViewer();
  // Initial scan
  if (directViewer()) {
    injectDirectVideoOverlay();
  } else {
    scanPage();
  }

  // Re-scan on DOM changes (SPA, dynamic content)
  const observer = new MutationObserver(() => {
    if (directViewer()) {
      injectDirectVideoOverlay();
    } else {
      scanPage();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Take over the page's own <video> (off by default) ─────────────────────
//
// Switched on from the player page's settings. When it is on, the library's
// upgradeVideoElements() replaces a plain <video> with a <movi-player> that
// carries its attributes, its sources and its API — so the page's own scripts
// keep working while the file plays through a real demuxer.
//
// Two gates, for two different reasons:
//
//  1. Here: is there anything on this page worth the bundle? The player is
//     megabytes of WebAssembly. A page whose videos are all streamed — which
//     is most pages with a video on them — must not pay for it, so nothing is
//     injected until a <video> with a file behind it actually exists.
//  2. There: which of them may be taken. upgradeVideoElements leaves anything
//     that is not a file at a URL alone (MSE, MediaStream, DRM, no source
//     yet), which is what keeps YouTube and Netflix working.
const TAKEOVER_KEY = "takeOverPageVideos";
const UPGRADE_SCRIPT_ID = "movi-upgrade-script";
let takeoverInjected = false;

/**
 * Is this the page's PLAYER, or is it furniture?
 *
 * A <video> on the web is not always something to be watched. A search page
 * of stock footage is a grid of them, each one a thumbnail that plays a muted
 * loop when the pointer crosses it; a marketing page puts one behind its
 * headline. Replacing those with a real player turns a page of previews into a
 * page of black boxes — and costs a WebAssembly engine for each one.
 *
 * So the question is not "can this be opened" (the library answers that) but
 * "did the page put this here to be watched":
 *
 *  - a site's own player skin around it says yes, whatever else is true;
 *  - the controls attribute says yes — the page expects a viewer to drive it;
 *  - a muted or looping video says no: that is a decoration, a preview, a
 *    background;
 *  - otherwise, only a page whose single video is big enough to be the point
 *    of the page.
 *
 * Kept in both content.js and upgrade.js on purpose: this copy decides whether
 * the page is worth megabytes of player at all, the other which elements get
 * one. They must answer the same way, so they ask the same question.
 */
function looksLikeThePagesPlayer(video) {
  if (
    video.closest(
      ".video-js, .vjs-container, .plyr, .jwplayer, .flowplayer, .shaka-video-container, .mejs__container",
    )
  ) {
    return true;
  }
  if (video.hasAttribute("controls")) return true;
  if (video.loop || video.muted || video.hasAttribute("muted")) return false;
  if (document.querySelectorAll("video").length !== 1) return false;
  const box = video.getBoundingClientRect();
  return box.width >= 400 && box.height >= 225;
}

function videoWorthTakingOver(video) {
  // The page's own opt-out — the library honours it too (see upgrade.ts), so a
  // page whose only video carries it is not worth loading the player for.
  if (video.closest("[data-movi-ignore]")) return false;
  if (video.srcObject) return false;
  if (video.mediaKeys) return false;
  const source =
    video.currentSrc ||
    video.getAttribute("src") ||
    video.querySelector("source")?.getAttribute("src") ||
    "";
  // blob: is how a MediaSource is attached, and it is also how a page plays a
  // file it picked. The two cannot be told apart from out here, so it is the
  // streaming case that decides: left alone.
  if (!source || /^(blob:|mediastream:)/i.test(source)) return false;
  return looksLikeThePagesPlayer(video);
}

/**
 * Ask for the CORS header the site never sent, before the player asks for the
 * bytes.
 *
 * Only for files on another origin — a same-origin read needs nothing — and
 * only the ones this page is actually about to open. See allowMediaCors in
 * background.js. It is best-effort: without the host permission (or in a
 * browser without the API) the player still opens, and still falls back to the
 * native element the way it did before any of this.
 */
function askForMediaCors() {
  // Every candidate, not only the ones that LOOK cross-origin. A same-origin
  // media URL that redirects to a CDN is the ordinary shape of this — the page
  // asks its own host, the host sends the request somewhere else, and the
  // somewhere-else is what has to carry the header. The rule for a same-origin
  // URL costs nothing: the header it adds is one the browser would not have
  // asked about.
  const urls = [];
  for (const video of Array.from(document.querySelectorAll("video"))) {
    if (!videoWorthTakingOver(video)) continue;
    // Every source it declares, not just the one it settled on. A <video> with
    // an mp4 and an ogg beside it is the oldest shape on the web, and the
    // player tries what the page offered — so each of them needs the header,
    // or the second one is blocked after the first is not.
    const declared = [
      video.currentSrc,
      video.getAttribute("src"),
      ...Array.from(video.querySelectorAll("source")).map((s) => s.getAttribute("src")),
    ];
    for (const raw of declared) {
      if (!raw) continue;
      try {
        const href = new URL(raw, location.href).href;
        if (!urls.includes(href)) urls.push(href);
      } catch {
        /* a source the page wrote that is not a URL */
      }
    }
  }
  if (urls.length === 0) return Promise.resolve({});
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: "allowMediaCors", urls }, (reply) => {
        void chrome.runtime.lastError;
        // Say the one thing the console cannot work out for itself. Without
        // site access no header rule is written, every media read is refused,
        // and the page fills with CORS failures that look like the player's
        // fault. One line names the cause and where the switch is.
        if (reply && reply.needsPermission) {
          console.info(
            "[movi] Take over page videos: no site access, so this page's video files are read by the browser instead. Turn on site access in the movi-player extension to change that.",
          );
        }
        resolve((reply && reply.verdicts) || {});
      });
    } catch {
      resolve({});
    }
  });
}

/**
 * Is there actually media at the end of the links this page declares?
 *
 * The takeover reads the bytes itself, so a link that does not lead to media
 * is a player with nothing to play — where the native element would at least
 * have shown the page's own error. A dead source, an expired signed URL, a
 * paywall that answers with HTML: all of them look like a perfectly good
 * <video src> from the DOM.
 *
 * The answer comes from the round trip the CORS rules already make, so this
 * costs nothing extra.
 *
 * FAILS OPEN, deliberately and in two ways. Only a positive "this is not
 * media" counts against a page — silence, a server that answers nothing
 * useful, or no host permission at all leaves the takeover exactly as it was.
 * And one bad source among several does not condemn the page: a <video> with
 * an mp4 and an ogg beside it is the oldest shape on the web, and the first
 * of them 404ing is what the second is there for.
 */
function anySourcePlayable(verdicts) {
  const seen = Object.values(verdicts);
  if (seen.length === 0) return true;
  return seen.some((v) => v !== "notmedia");
}

function injectTakeover() {
  if (takeoverInjected) return;
  takeoverInjected = true;
  // The header rule has to exist before the first read, not after it.
  askForMediaCors().then((verdicts) => {
    // A whole page of dead links is not worth loading a decoding engine for.
    // The finer decision — which of several elements to leave alone — is the
    // upgrade module's, from the same verdicts passed below.
    if (!anySourcePlayable(verdicts)) {
      console.info(
        "[movi] Take over page videos: this page's video links do not lead to media, so the page has been left as it is.",
      );
      releaseSkinPrehide();
      return;
    }
    const script = document.createElement("script");
    script.type = "module";
    script.src = chrome.runtime.getURL("upgrade.js");
    script.id = UPGRADE_SCRIPT_ID;
    // Through the DOM, because this runs in the isolated world and the module
    // runs in the page's: the two share the document and nothing else, so an
    // attribute is the channel. Read at the top of the module, while the
    // element is still there — it is taken out on load, which is after.
    try {
      script.dataset.sources = JSON.stringify(verdicts);
    } catch {
      /* nothing worth passing along */
    }
    script.addEventListener("load", () => script.remove());
    (document.head || document.documentElement).appendChild(script);
  });
}

/**
 * Tell the background this page is one the popup has something to say about.
 *
 * Sent whether or not the takeover actually runs. On an exempt site nothing
 * is injected, but the popup still has to be reachable — it holds the switch
 * that turned the site off, and hiding it there would leave no way back.
 */
let toldBackground = false;
function reportTakeoverRelevant() {
  if (toldBackground) return;
  toldBackground = true;
  try {
    chrome.runtime.sendMessage({ action: "takeoverRelevant" }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* the extension context went away mid-navigation */
  }
}

/**
 * Watch for a video worth acting on, and act — or, on an exempt site, only
 * report it.
 *
 * `inject` is what separates the two. Everything about deciding WHICH videos
 * count stays in one place either way, so an exempt site and a live one
 * answer the same question and differ only in what happens next.
 */
function watchForTakeover(inject = true) {
  const look = () => {
    if (takeoverInjected) return true;
    if (Array.from(document.querySelectorAll("video")).some(videoWorthTakingOver)) {
      reportTakeoverRelevant();
      if (inject) injectTakeover();
      return true;
    }
    return false;
  };
  if (look()) return;
  const observer = new MutationObserver(() => {
    if (look()) observer.disconnect();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  // A src set as a PROPERTY mutates nothing. The element still says so itself.
  document.addEventListener(
    "loadedmetadata",
    () => {
      if (look()) observer.disconnect();
    },
    true,
  );
  // A page that was never going to have one should not be watched for ever.
  setTimeout(() => observer.disconnect(), 60000);
}

/**
 * Sites the viewer has turned takeover off for, from the toolbar popup.
 *
 * A site-level exemption, not a page one: the decision is about a place, and
 * every page of it. Held as a list of hostnames so the answer is one read
 * rather than a key per site.
 *
 * Checked once, at the top. Nothing is watched, no player is injected and no
 * CORS rule is asked for on an exempt site — which is the point: "off here"
 * has to mean the extension does nothing here, not that it does everything
 * quietly.
 */
const EXEMPT_KEY = "takeoverExemptHosts";

function exemptHere(list, site) {
  if (!Array.isArray(list) || list.length === 0) return false;
  try {
    const { protocol, hostname } = site;
    if (protocol !== "http:" && protocol !== "https:") return false;
    return list.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * The site the viewer turned takeover off for is the TAB's, not the frame's.
 *
 * The popup's switch names the page in the address bar, and a video embedded
 * from another host sits in a frame with a hostname of its own — so a frame
 * asking about itself would take over on a site the viewer had turned off.
 * The frame cannot read a cross-origin parent's address, so it asks the
 * background, which knows the tab's.
 */
function topSite() {
  if (IS_TOP_FRAME) return Promise.resolve(location);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: "topSite" }, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply && reply.hostname ? reply : location);
      });
    } catch {
      resolve(location);
    }
  });
}

/**
 * Give a site's player skin back its chrome.
 *
 * early.js hides the chrome of the skins the takeover replaces from the very
 * start of the page, so it does not flash up and vanish while the player
 * loads. It gives each skin back by itself once that skin is upgraded, turns
 * out to be streaming, or waits too long — but only this side knows the page
 * will not be taken over at all (off here, or its links are dead), and then
 * nothing should wait. An event because early.js lives in the page's world
 * and this does not; the two share the window's events and nothing else.
 */
function releaseSkinPrehide() {
  try {
    window.dispatchEvent(new Event("movi-prehide-release"));
  } catch {
    /* nothing listening */
  }
}

function decideTakeover(data) {
  if (!data || !data[TAKEOVER_KEY]) {
    releaseSkinPrehide();
    return;
  }
  topSite().then((site) => {
    const exempt = exemptHere(data[EXEMPT_KEY], site);
    if (exempt) releaseSkinPrehide();
    watchForTakeover(!exempt);
  });
}

try {
  chrome.storage?.local.get([TAKEOVER_KEY, EXEMPT_KEY], decideTakeover);
  // Switched on while this page is open: from here, not after a reload.
  // Turning it off again cannot un-take-over a page that has already been
  // upgraded — the page's own elements are gone — so the popup says to
  // reload rather than pretending otherwise.
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[TAKEOVER_KEY]?.newValue && !changes[EXEMPT_KEY]) return;
    chrome.storage.local.get([TAKEOVER_KEY, EXEMPT_KEY], decideTakeover);
  });
} catch {
  /* no storage access in this context — the setting simply stays off */
}
