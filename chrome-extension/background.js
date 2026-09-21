// Context menu: "Open with Movi Player" on links and on <video> elements.
//
// Built on every worker start, not on onInstalled. The extension is
// `"incognito": "split"`, so the incognito profile runs a background of its
// own — and that one starts when an incognito window opens, long after the
// install event it would never see. Menus are per-profile, so without this the
// item simply would not exist in incognito.
//
// removeAll() first because create() throws on a duplicate id, and a worker
// that is evicted and woken again runs this line each time.
function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "open-with-movi",
      title: "Open with Movi Player",
      contexts: ["link", "video"],
    });
  });
}
ensureContextMenu();

// Toolbar icon opens the player page. There is no popup: everything it used
// to hold — paste a link, the right-click tip, the two settings — lives on
// the player page, which has room for it and can show a real URL field
// instead of a clipboard read that fails silently when permission is denied.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("player.html") });
});

// Keep the probeBlankLinks storage flag in sync with the actual permission
// state. The player page triggers chrome.permissions.request(); listening
// here in the background rather than there also catches the case where the
// user revokes "<all_urls>" from the browser's own extensions page.
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

  if (message.action === "allowMediaCors") {
    allowMediaCors(message.urls, sender.tab?.id)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ─── CORS for the takeover ─────────────────────────────────────────────────
//
// A native <video> plays a cross-origin file without asking anyone. Movi reads
// the bytes itself, so the same file needs an Access-Control-Allow-Origin the
// site was never asked to send — and without it the player falls back to the
// native element, which is only as good as the browser's own decoders. For an
// MKV or an HEVC file that is no better than doing nothing.
//
// So the header is added here, to the response, where an extension is allowed
// to. Not by proxying the bytes: a range read through chrome.runtime is a
// multi-megabyte string squeezed through JSON twice, for every read, for the
// whole film.
//
// Narrow on purpose. One rule per media URL the page is actually going to
// open, bound to the tab that asked, cleared when that tab goes. Never a
// blanket "allow everything": the same header on an unrelated credentialed
// request is not permissiveness, it is a broken request — and a rule that
// outlives its page is a permission nobody granted.
const corsRuleIds = new Map(); // tabId → [ruleId]
let nextCorsRuleId = 9000;

async function allowMediaCors(urls, tabId) {
  if (!Array.isArray(urls) || urls.length === 0 || tabId == null) {
    return { ok: false };
  }
  // The rules only apply where the extension has access to the host, and that
  // access is optional — asked for on the player page, next to the setting.
  const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) return { ok: false, needsPermission: true };

  // Where each one actually ENDS. A media URL that redirects — the page's own
  // host handing off to a CDN — is answered by the address it lands on, and
  // that is the response the header has to be added to. The rule matches a
  // request by its own URL, so the redirect needs one of its own.
  const wanted = new Set();
  for (const url of urls.slice(0, 8)) {
    wanted.add(url);
    const landed = await finalUrl(url);
    if (landed) wanted.add(landed);
  }

  const addRules = [];
  for (const url of wanted) {
    addRules.push({
      id: ++nextCorsRuleId,
      priority: 1,
      condition: { urlFilter: url, tabIds: [tabId], resourceTypes: ["xmlhttprequest"] },
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "access-control-allow-origin", operation: "set", value: "*" },
          {
            header: "access-control-expose-headers",
            operation: "set",
            value: "content-range, content-length, accept-ranges",
          },
        ],
      },
    });
  }
  const previous = corsRuleIds.get(tabId) ?? [];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: previous,
    addRules,
  });
  corsRuleIds.set(tabId, addRules.map((rule) => rule.id));
  return { ok: true, rules: addRules.length };
}

/**
 * Follow a media URL to wherever it ends, without reading a byte of it.
 *
 * From here rather than from the page: this side has the host permission, so
 * the redirect can be followed without the CORS the page is missing in the
 * first place. HEAD where the server answers one; a single byte where it does
 * not, which is every server that answers HEAD with 405.
 */
async function finalUrl(url) {
  for (const init of [
    { method: "HEAD" },
    { method: "GET", headers: { Range: "bytes=0-0" } },
  ]) {
    try {
      const response = await fetch(url, { ...init, redirect: "follow" });
      if (init.method === "GET") response.body?.cancel?.();
      if (response.url && response.url !== url) return response.url;
      if (response.ok || response.status === 206) return "";
    } catch {
      /* try the next shape, then give up — the rule for the URL we were
         given still stands */
    }
  }
  return "";
}

// A rule belongs to the page that asked for it.
chrome.tabs.onRemoved.addListener((tabId) => void dropCorsRules(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") void dropCorsRules(tabId);
});

async function dropCorsRules(tabId) {
  const ids = corsRuleIds.get(tabId);
  if (!ids || ids.length === 0) return;
  corsRuleIds.delete(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch {
    /* the session is going away anyway */
  }
}

// In-memory cache so repeated probes for the same URL don't re-hit the network.
// Service worker may be evicted; that's fine — cache is best-effort.
//
// Under "split" incognito each profile runs its own worker and therefore its
// own cache, which is the behaviour you want anyway: a URL probed in incognito
// leaves no trace in the normal session's cache.
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
    // Some servers reject HEAD with 405/501; SigV4 presigned-GET URLs (S3, R2,
    // GCS) reject it with 403/401 because the signature is bound to the method.
    // In all these cases fall back to a tiny ranged GET, which is allowed.
    if (!res.ok && (res.status === 405 || res.status === 501 || res.status === 403 || res.status === 401)) {
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
