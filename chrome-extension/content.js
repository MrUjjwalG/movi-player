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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="323 49 930 930" width="56" height="56" aria-hidden="true"><defs><clipPath id="moviExtOverlayGL-0"><path clip-rule="evenodd" d="M383.55 222 C383.55 152.17 440.03 97.5 512 97.5 C543.4 97.5 559.7 101.8 590 117.5 L1100 381.5 C1174.55 414.03 1191.47 471.49 1193 512.5 C1192.29 590.19 1134.3 634.06 1100 646.5 C930.83 737.99 761.67 826.04 592.5 909 C571.47 917.98 554.22 929.25 512 930.3 C455.97 929.9 384.46 889.54 383.55 802 Z M614 360 L913 520 C686.95 641.07 614 666.34 614 669 Z"/></clipPath><linearGradient id="moviExtOverlayGL-1" gradientUnits="userSpaceOnUse" x1="0" y1="97" x2="0" y2="360"><stop offset="0" stop-color="#737bfd"/><stop offset="0.5" stop-color="#6eb3fd"/><stop offset="1" stop-color="#81e1fe"/></linearGradient><radialGradient id="moviExtOverlayGL-2" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(726.13 101.51) scale(218.96 701.75)"><stop offset="0" stop-color="#0c00fd"/><stop offset="0.12" stop-color="#0c00fd" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0c00fd" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0c00fd" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0c00fd" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0c00fd" stop-opacity="0.006"/><stop offset="1" stop-color="#0c00fd" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(255.4 225.67) scale(350.82 206.02)"><stop offset="0" stop-color="#4c00fd" stop-opacity="0.58"/><stop offset="0.12" stop-color="#4c00fd" stop-opacity="0.484"/><stop offset="0.24" stop-color="#4c00fd" stop-opacity="0.282"/><stop offset="0.36" stop-color="#4c00fd" stop-opacity="0.115"/><stop offset="0.48" stop-color="#4c00fd" stop-opacity="0.033"/><stop offset="0.64" stop-color="#4c00fd" stop-opacity="0.003"/><stop offset="1" stop-color="#4c00fd" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-4" gradientUnits="userSpaceOnUse" x1="0" y1="225" x2="0" y2="817"><stop offset="0" stop-color="#5143ff"/><stop offset="0.5" stop-color="#294cf6"/><stop offset="1" stop-color="#0437cc"/></linearGradient><radialGradient id="moviExtOverlayGL-5" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(621.75 616.05) scale(192.93 939.93)"><stop offset="0" stop-color="#436eff"/><stop offset="0.12" stop-color="#436eff" stop-opacity="0.835"/><stop offset="0.24" stop-color="#436eff" stop-opacity="0.487"/><stop offset="0.36" stop-color="#436eff" stop-opacity="0.198"/><stop offset="0.48" stop-color="#436eff" stop-opacity="0.056"/><stop offset="0.64" stop-color="#436eff" stop-opacity="0.006"/><stop offset="1" stop-color="#436eff" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-6" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(637.74 314.49) scale(126.64 109.33)"><stop offset="0" stop-color="#0000ec"/><stop offset="0.12" stop-color="#0000ec" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0000ec" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0000ec" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0000ec" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0000ec" stop-opacity="0.006"/><stop offset="1" stop-color="#0000ec" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-7" gradientUnits="userSpaceOnUse" x1="0" y1="669" x2="0" y2="930"><stop offset="0" stop-color="#001fad"/><stop offset="0.5" stop-color="#2e50ff"/><stop offset="1" stop-color="#3d4eff"/></linearGradient><radialGradient id="moviExtOverlayGL-8" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(367.66 690.91) scale(257.59 321.92)"><stop offset="0" stop-color="#0023ab"/><stop offset="0.12" stop-color="#0023ab" stop-opacity="0.835"/><stop offset="0.24" stop-color="#0023ab" stop-opacity="0.487"/><stop offset="0.36" stop-color="#0023ab" stop-opacity="0.198"/><stop offset="0.48" stop-color="#0023ab" stop-opacity="0.056"/><stop offset="0.64" stop-color="#0023ab" stop-opacity="0.006"/><stop offset="1" stop-color="#0023ab" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-9" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(554.73 904.5) scale(161.77 151.07)"><stop offset="0" stop-color="#564efc"/><stop offset="0.12" stop-color="#564efc" stop-opacity="0.835"/><stop offset="0.24" stop-color="#564efc" stop-opacity="0.487"/><stop offset="0.36" stop-color="#564efc" stop-opacity="0.198"/><stop offset="0.48" stop-color="#564efc" stop-opacity="0.056"/><stop offset="0.64" stop-color="#564efc" stop-opacity="0.006"/><stop offset="1" stop-color="#564efc" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-10" gradientUnits="userSpaceOnUse" x1="460" y1="0" x2="1185" y2="0"><stop offset="0" stop-color="#4442fc"/><stop offset="0.5" stop-color="#5800fd"/><stop offset="1" stop-color="#00c9ff"/></linearGradient><radialGradient id="moviExtOverlayGL-11" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="2.5" gradientTransform="translate(918.16 679.1) scale(562.77 1104.38)"><stop offset="0" stop-color="#b3acfc" stop-opacity="0.732"/><stop offset="0.12" stop-color="#b3acfc" stop-opacity="0.611"/><stop offset="0.24" stop-color="#b3acfc" stop-opacity="0.356"/><stop offset="0.36" stop-color="#b3acfc" stop-opacity="0.145"/><stop offset="0.48" stop-color="#b3acfc" stop-opacity="0.041"/><stop offset="0.64" stop-color="#b3acfc" stop-opacity="0.004"/><stop offset="1" stop-color="#b3acfc" stop-opacity="0"/></radialGradient><linearGradient id="moviExtOverlayGL-12" gradientUnits="userSpaceOnUse" x1="933.66" y1="4.95" x2="816.34" y2="695.05"><stop offset="0" stop-color="#ff3efc"/><stop offset=".25" stop-color="#6cb1fd"/><stop offset=".5" stop-color="#548cfd"/><stop offset=".75" stop-color="#295dfd"/><stop offset="1" stop-color="#0b07f8"/></linearGradient><radialGradient id="moviExtOverlayGL-13" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(1255.8 459.16) rotate(22.04) scale(464.67 224.5)"><stop offset="0" stop-color="#00d4fe" stop-opacity="0.797"/><stop offset=".5" stop-color="#00d4fe" stop-opacity="0.246"/><stop offset="1" stop-color="#00d4fe" stop-opacity="0"/></radialGradient><radialGradient id="moviExtOverlayGL-14" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(630 351) rotate(-113.37) scale(1399.91 230.15)"><stop offset="0" stop-color="#a0effd" stop-opacity="0.2"/><stop offset=".5" stop-color="#a0effd" stop-opacity="0"/><stop offset="1" stop-color="#a0effd" stop-opacity="0"/></radialGradient><path id="moviExtOverlayGL-15" d="M350 80 H1220 V950 H350 Z"/><path id="moviExtOverlayGL-16" d="M350 80 H614 V668.5 C394.51 759.97 395.83 810.57 384 817 H350 Z"/><path id="moviExtOverlayGL-17" d="M384 817 C395.83 810.57 394.51 759.97 614 668.5 C601.76 795.98 495.68 900.62 460 920 L350 960 V817 Z"/><path id="moviExtOverlayGL-18" d="M350 80 H1220 V545 L1184 558 C1091.75 639.78 1018.25 572.14 913 520 L614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/><path id="moviExtOverlayGL-19" d="M350 80 H520 L539 100 C563.83 110.79 604.49 141.82 611.5 230 C614.03 257.11 613.18 307.14 614 360 C551.52 322.82 391.01 278.71 384 226 L350 220 Z"/></defs><g clip-path="url(#moviExtOverlayGL-0)"><g id="moviExtOverlayGL-20"><use href="#moviExtOverlayGL-15" fill="url(#moviExtOverlayGL-10)"/><use href="#moviExtOverlayGL-15" fill="url(#moviExtOverlayGL-11)"/></g><g id="moviExtOverlayGL-21"><use href="#moviExtOverlayGL-16" fill="url(#moviExtOverlayGL-4)"/><use href="#moviExtOverlayGL-16" fill="url(#moviExtOverlayGL-5)"/><use href="#moviExtOverlayGL-16" fill="url(#moviExtOverlayGL-6)"/></g><g id="moviExtOverlayGL-22"><use href="#moviExtOverlayGL-17" fill="url(#moviExtOverlayGL-7)"/><use href="#moviExtOverlayGL-17" fill="url(#moviExtOverlayGL-8)"/><use href="#moviExtOverlayGL-17" fill="url(#moviExtOverlayGL-9)"/></g><g id="moviExtOverlayGL-23"><use href="#moviExtOverlayGL-18" fill="url(#moviExtOverlayGL-12)"/><use href="#moviExtOverlayGL-18" fill="url(#moviExtOverlayGL-13)"/><use href="#moviExtOverlayGL-18" fill="url(#moviExtOverlayGL-14)"/></g><g id="moviExtOverlayGL-24"><use href="#moviExtOverlayGL-19" fill="url(#moviExtOverlayGL-1)"/><use href="#moviExtOverlayGL-19" fill="url(#moviExtOverlayGL-2)"/><use href="#moviExtOverlayGL-19" fill="url(#moviExtOverlayGL-3)"/></g></g></svg>
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
