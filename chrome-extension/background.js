// Context menu: "Open with Movi Player" on links and on <video> elements
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-with-movi",
    title: "Open with Movi Player",
    contexts: ["link", "video"],
  });
});

// Keep the probeBlankLinks storage flag in sync with the actual permission
// state. The popup triggers chrome.permissions.request(), but Chrome closes
// the popup as soon as the prompt steals focus — so the request callback
// runs in a dead context. Listening here in the persistent service worker
// avoids that race entirely. Also catches the case where the user revokes
// "<all_urls>" from chrome://extensions.
chrome.permissions.onAdded.addListener((perms) => {
  if (perms.origins?.includes("<all_urls>")) {
    chrome.storage.local.set({ probeBlankLinks: true });
  }
});
chrome.permissions.onRemoved.addListener((perms) => {
  if (perms.origins?.includes("<all_urls>")) {
    chrome.storage.local.set({ probeBlankLinks: false });
  }
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "open-with-movi") return;
  // For <video> right-click, Chrome sets info.srcUrl to the media URL.
  // For <a> right-click, info.linkUrl has the link URL.
  const url = info.srcUrl || info.linkUrl;
  if (!url) return;
  const playerUrl = chrome.runtime.getURL(
    `player.html?url=${encodeURIComponent(url)}`
  );
  chrome.tabs.create({ url: playerUrl });
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openPlayer") {
    const playerUrl = chrome.runtime.getURL(
      `player.html?url=${encodeURIComponent(message.url)}`
    );
    if (message.replaceTab && sender.tab?.id != null) {
      chrome.tabs.update(sender.tab.id, { url: playerUrl });
    } else {
      chrome.tabs.create({ url: playerUrl });
    }
    return;
  }

  if (message.action === "probeVideo") {
    probeVideoUrl(message.url).then(sendResponse).catch(() => sendResponse({ isVideo: false }));
    return true; // keep channel open for async response
  }
});

// In-memory cache so repeated probes for the same URL don't re-hit the network.
// Service worker may be evicted; that's fine — cache is best-effort.
const probeCache = new Map();
const MEDIA_EXT_RE = /\.(mp4|mkv|webm|mov|avi|ts|m3u8|mpd|flv|m4v|ogv|wmv|m2ts|mts|evo|3gp|mpg|mpeg|mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|ac3|ec3|eac3|mka|dts)(\?|$|")/i;

async function probeVideoUrl(url) {
  if (probeCache.has(url)) return probeCache.get(url);

  const result = await runProbe(url);
  probeCache.set(url, result);
  // Cap cache to avoid unbounded growth on link-heavy SPAs
  if (probeCache.size > 500) {
    const firstKey = probeCache.keys().next().value;
    probeCache.delete(firstKey);
  }
  return result;
}

async function runProbe(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let res;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    // Some servers reject HEAD with 405/501; fall back to a tiny ranged GET.
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 6000);
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          redirect: "follow",
          signal: ctrl2.signal,
        });
      } finally {
        clearTimeout(timer2);
      }
    }
    if (!res.ok && res.status !== 206) return { isVideo: false };

    const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
    const cdisp = res.headers.get("Content-Disposition") || "";

    if (ctype.startsWith("video/") || ctype.startsWith("audio/")) return { isVideo: true, reason: "content-type" };
    if (ctype === "application/x-matroska" || ctype === "application/x-mpegurl" || ctype === "application/vnd.apple.mpegurl" || ctype === "application/dash+xml" || ctype === "application/ogg") {
      return { isVideo: true, reason: "content-type" };
    }
    // Content-Disposition with a video-extension filename — common for download endpoints
    // that serve as application/octet-stream.
    if (cdisp && MEDIA_EXT_RE.test(cdisp)) {
      return { isVideo: true, reason: "content-disposition" };
    }
    return { isVideo: false };
  } catch {
    return { isVideo: false };
  }
}
