// Context menu: "Open with MoviPlayer" on links and on <video> elements.
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
      title: "Open with MoviPlayer",
      contexts: ["link", "video"],
    });
  });
}
ensureContextMenu();

// Toolbar icon opens the player page. There is no popup: everything it used
// to hold — paste a link, the right-click tip, the two settings — lives on
// the player page, which has room for it and can show a real URL field
// instead of a clipboard read that fails silently when permission is denied.
/**
 * The icon does one of two things, and which one depends on the page.
 *
 * On a page the extension has nothing to say about — no video it would take
 * over, or takeover switched off altogether — it opens the player, which is
 * what it has always done and what anyone pressing it there wants.
 *
 * On a page where takeover is in play it opens the popup instead, because
 * that is where "not on this site" lives.
 *
 * The switch is per tab: an action with a popup never fires onClicked, so the
 * popup is attached only to the tabs that need it (see takeoverRelevant
 * below) and this listener answers everywhere else. It cannot be done with
 * default_popup, which is one setting for every page at once.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("player.html") });
});

function setPopupFor(tabId, on) {
  if (tabId == null) return;
  try {
    chrome.action.setPopup({ tabId, popup: on ? "popup.html" : "" });
  } catch {
    /* the tab closed while we were deciding */
  }
}

// Keep the probeBlankLinks storage flag in sync with the actual permission
// state. The player page triggers chrome.permissions.request(); listening
// here in the background rather than there also catches the case where the
// user revokes "<all_urls>" from the browser's own extensions page.
chrome.permissions.onAdded.addListener((perms) => {
  if (perms.origins?.includes("<all_urls>")) {
    chrome.storage.local.set({ probeBlankLinks: true });
  }
  void syncEarlyHooks();
});
chrome.permissions.onRemoved.addListener((perms) => {
  if (perms.origins?.includes("<all_urls>")) {
    chrome.storage.local.set({ probeBlankLinks: false });
  }
  void syncEarlyHooks();
});

// ─── The takeover's early hooks ───────────────────────────────────────────
//
// early.js records what a page attaches to its <video> before the takeover
// can see it, so the player can be handed it (see that file). It has to run
// before the page's own scripts, in the page's world, and every page's
// addEventListener and observers pass through it — so it is registered only
// while the takeover is on, and only where the extension may run on the page
// at all, and taken off again when either stops being true. Not a static
// content script: that would be every page, for everyone, takeover or not.
const EARLY_HOOKS_ID = "movi-early-hooks";

async function syncEarlyHooks() {
  try {
    const { takeOverPageVideos } = await chrome.storage.local.get("takeOverPageVideos");
    const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    const want = !!takeOverPageVideos && granted;
    const have =
      (await chrome.scripting.getRegisteredContentScripts({ ids: [EARLY_HOOKS_ID] })).length > 0;
    if (want && !have) {
      await chrome.scripting.registerContentScripts([
        {
          id: EARLY_HOOKS_ID,
          js: ["early.js"],
          matches: ["<all_urls>"],
          runAt: "document_start",
          world: "MAIN",
          allFrames: true,
          persistAcrossSessions: true,
        },
      ]);
    } else if (!want && have) {
      await chrome.scripting.unregisterContentScripts({ ids: [EARLY_HOOKS_ID] });
    }
  } catch {
    /* no scripting API, or a second sync got there first — the takeover
       still works, it just cannot move what the page attached early */
  }
}
void syncEarlyHooks();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.takeOverPageVideos) void syncEarlyHooks();
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

  // "There is a video here that takeover is about to act on — or would be,
  // if this site were not exempt." The exempt case matters as much as the
  // other: with the popup hidden there, the switch that turned the site off
  // would be the one thing you could no longer reach to turn back on.
  if (message.action === "takeoverRelevant") {
    setPopupFor(sender.tab?.id, true);
    return false;
  }

  // A frame asking which site its tab is on — see topSite() in content.js.
  if (message.action === "topSite") {
    try {
      const { protocol, hostname } = new URL(sender.tab?.url || "");
      sendResponse({ protocol, hostname });
    } catch {
      sendResponse({});
    }
    return false;
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
const CORS_RULE_FLOOR = 9000;

/**
 * Every media URL this tab has asked to have a header added to.
 *
 * Kept because the rules are rebuilt wholesale on each call — the update
 * removes the tab's previous rule ids — so two callers would cancel each
 * other. There are several: the takeover path, a page that embeds
 * <movi-player> itself, and every frame of the tab doing either.
 */
const corsWanted = new Map();

/**
 * One rebuild at a time.
 *
 * A page with its videos in iframes asks once per frame, all at the same
 * moment. Each call probes its URLs over the network before it writes, so
 * they overlapped: each started from an empty set, and each one's update
 * removed the rule ids the last one to finish had recorded — whichever ids
 * those happened to be. Four embeds came out alternating, the 1st and 3rd
 * with their header and the 2nd and 4th reading without it.
 */
let corsQueue = Promise.resolve();

function queueCorsWrite(step) {
  const run = corsQueue.then(step);
  corsQueue = run.catch(() => {});
  return run;
}

/**
 * This tab's header rules, from the browser rather than from memory.
 *
 * Session rules outlive the service worker; a Map does not. After the worker
 * was put to sleep and woken, the ids it remembered were gone and the counter
 * started again at the floor — so the next update either left the old rules
 * behind for ever or asked for an id that already existed, which fails the
 * whole update and writes nothing.
 */
async function tabCorsRules(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const mine = rules
    .filter((r) => r.id > CORS_RULE_FLOOR && r.condition.tabIds?.includes(tabId))
    .map((r) => r.id);
  const top = rules.reduce((max, r) => Math.max(max, r.id), CORS_RULE_FLOOR);
  return { mine, top };
}

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
  //
  // Probed outside the queue: it is the network, and one slow host must not
  // hold up the header for every other frame's video.
  const known = corsWanted.get(tabId);
  const fresh = urls.slice(0, 12).filter((url) => !known?.has(url));
  const probed = await Promise.all(fresh.map((url) => probeUrl(url)));
  const verdicts = {};
  fresh.forEach((url, i) => (verdicts[url] = probed[i].verdict));

  return queueCorsWrite(async () => {
    const wanted = corsWanted.get(tabId) ?? new Set();
    fresh.forEach((url, i) => {
      wanted.add(url);
      if (probed[i].landed) wanted.add(probed[i].landed);
    });
    // A cap, because this set only ever grows within a tab and each entry is a
    // session rule. A page with more media than this is a page the takeover
    // heuristics would not have touched anyway.
    while (wanted.size > 48) wanted.delete(wanted.values().next().value);
    corsWanted.set(tabId, wanted);

    const { mine: previous, top } = await tabCorsRules(tabId);
    let nextId = top;
    const addRules = [];
    for (const url of wanted) {
      addRules.push({
        id: ++nextId,
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
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: previous,
      addRules,
    });
    return { ok: true, rules: addRules.length, verdicts };
  });
}

/**
 * Follow a media URL to wherever it ends, and say what came back.
 *
 * From here rather than from the page: this side has the host permission, so
 * the redirect can be followed without the CORS the page is missing in the
 * first place. HEAD where the server answers one; a single byte where it does
 * not, which is every server that answers HEAD with 405.
 *
 * Returns { landed, verdict }. The verdict is the same round trip the
 * redirect needed, read for a second thing: is there media at the end of this
 * link at all. It has three values and only one of them is a refusal —
 *
 *   "media"     the server said so, or served a range of bytes
 *   "notmedia"  the server said HTML, or said no such thing exists
 *   "unknown"   no answer worth acting on
 *
 * — because a gate that guesses wrong here stops the takeover working on a
 * site that was fine. Only a positive "this is not media" is acted on.
 */
const MEDIA_TYPE = /^(video|audio)\/|^application\/(octet-stream|vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|ogg)/i;
const PAGE_TYPE = /^(text\/|application\/(json|xhtml))/i;

function verdictFor(response) {
  if (response.status >= 400) return "notmedia";
  const type = (response.headers.get("content-type") || "").trim().toLowerCase();
  if (MEDIA_TYPE.test(type)) return "media";
  if (PAGE_TYPE.test(type)) return "notmedia";
  // A 206 with no type worth reading is still a server handing out ranges of
  // a file, which is the shape of media whatever it calls itself.
  if (response.status === 206) return "media";
  return "unknown";
}

async function probeUrl(url) {
  for (const init of [
    { method: "HEAD" },
    { method: "GET", headers: { Range: "bytes=0-0" } },
  ]) {
    try {
      const response = await fetch(url, { ...init, redirect: "follow" });
      if (init.method === "GET") response.body?.cancel?.();
      const verdict = verdictFor(response);
      const landed = response.url && response.url !== url ? response.url : "";
      // A HEAD that 405s tells us nothing; go round again as a GET.
      if (init.method === "HEAD" && response.status === 405) continue;
      return { landed, verdict };
    } catch {
      /* try the next shape, then give up — the rule for the URL we were
         given still stands */
    }
  }
  return { landed: "", verdict: "unknown" };
}

// A rule belongs to the page that asked for it.
chrome.tabs.onRemoved.addListener((tabId) => void dropCorsRules(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    void dropCorsRules(tabId);
    // A new page decides for itself. Left set, the popup would follow the tab
    // to a site with no video on it.
    setPopupFor(tabId, false);
  }
});

async function dropCorsRules(tabId) {
  // The remembered URLs go with the rules. A tab that navigates is a
  // different page, and carrying the last one's media into it would keep
  // writing headers for files nothing is going to ask for.
  //
  // Queued behind any rebuild in flight, or that rebuild would write this
  // page's rules back after they were cleared.
  try {
    await queueCorsWrite(async () => {
      corsWanted.delete(tabId);
      const { mine } = await tabCorsRules(tabId);
      if (mine.length === 0) return;
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: mine });
    });
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
