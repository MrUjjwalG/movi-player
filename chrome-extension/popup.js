// Paste & Play — read from clipboard
document.getElementById("paste").addEventListener("click", async () => {
  const hint = document.getElementById("paste-hint");
  try {
    const text = await navigator.clipboard.readText();
    const url = text.trim();
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`player.html?url=${encodeURIComponent(url)}`),
      });
      window.close();
    } else {
      hint.textContent = "No video link in clipboard";
      hint.style.color = "#ef4444";
      setTimeout(() => { hint.textContent = "Play a video link from clipboard"; hint.style.color = ""; }, 2000);
    }
  } catch {
    hint.textContent = "Clipboard access needed";
    hint.style.color = "#f59e0b";
    setTimeout(() => { hint.textContent = "Play a video link from clipboard"; hint.style.color = ""; }, 2000);
  }
});

// Play from Computer
document.getElementById("file").addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("player.html"),
  });
  window.close();
});

// ─── Detect-download-links toggle ───
const PROBE_ORIGINS = { origins: ["<all_urls>"] };
const probeToggle = document.getElementById("probe-toggle");
const probeSub = document.getElementById("probe-sub");

// Source of truth = storage flag (the user's preference). Permission is only
// needed for HEAD requests to succeed; we don't try to revoke it on OFF
// because Chrome refuses to revoke permissions that were granted as required
// on an older install — would force a reinstall. The flag alone gates the
// content script, which is enough to fully disable the feature.
function syncProbeToggle() {
  chrome.storage.local.get("probeBlankLinks", (data) => {
    probeToggle.checked = !!data.probeBlankLinks;
  });
}
syncProbeToggle();

function flashProbeSub(text, color) {
  probeSub.textContent = text;
  probeSub.style.color = color;
  setTimeout(() => {
    probeSub.textContent = "Scan CDN / no-extension links for video";
    probeSub.style.color = "";
  }, 2000);
}

// ─── Experimental flag row ───
const flagBtn = document.getElementById("open-flags");
const flagSub = document.getElementById("flags-sub");

// Same probe as app/compare.html — try to set WebGL2 drawingBufferColorSpace
// to rec2100-pq. Only succeeds when the experimental web platform features
// flag is on in Chromium. Returns false on Safari/Firefox (where the
// property is undefined) or when the assignment is rejected.
function detectExperimentalFlag() {
  if (!window.chrome) return false;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl || gl.drawingBufferColorSpace === undefined) return false;
    gl.drawingBufferColorSpace = "rec2100-pq";
    return gl.drawingBufferColorSpace === "rec2100-pq";
  } catch {
    return false;
  }
}

if (detectExperimentalFlag()) {
  // Flag already on — no action needed, show a check badge instead of a
  // button to avoid suggesting the user has something to do.
  flagSub.textContent = "Enabled — HDR & codecs unlocked";
  flagSub.style.color = "#10b981";
  flagBtn.outerHTML = `<span class="setting-badge" title="Experimental features enabled">✓</span>`;
} else if (!window.chrome) {
  // Non-Chromium browsers can't toggle this flag — hide the action.
  flagBtn.style.display = "none";
  flagSub.textContent = "Chrome only";
} else {
  flagBtn.addEventListener("click", () => {
    chrome.tabs.create({
      url: "chrome://flags/#enable-experimental-web-platform-features",
    });
    window.close();
  });
}

probeToggle.addEventListener("change", () => {
  const wantOn = probeToggle.checked;
  if (wantOn) {
    // permissions.request returns granted=true instantly (no prompt) if the
    // permission was already granted, so this handles both first-time and
    // already-permitted cases.
    chrome.permissions.request(PROBE_ORIGINS, (granted) => {
      probeToggle.checked = granted;
      chrome.storage.local.set({ probeBlankLinks: granted });
      if (!granted) flashProbeSub("Permission denied", "#ef4444");
    });
  } else {
    chrome.storage.local.set({ probeBlankLinks: false });
  }
});
