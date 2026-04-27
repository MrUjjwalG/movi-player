import * as Movi from "./dist/element.js";

const params = new URLSearchParams(window.location.search);
const url = params.get("url");

const overlay = document.getElementById("fileOverlay");
const dropZone = document.getElementById("dropZone");
const filePicker = document.getElementById("filePicker");
const folderPicker = document.getElementById("folderPicker");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingName = document.getElementById("loadingName");

const playlistPanel = document.getElementById("playlistPanel");
const playlistItemsEl = document.getElementById("playlistItems");
const playlistCountEl = document.getElementById("playlistCount");
const playlistTitleEl = document.getElementById("playlistTitle");
const playlistCloseBtn = document.getElementById("playlistClose");
const playlistToggleBtn = document.getElementById("playlistToggle");
const addFilesBtn = document.getElementById("addFilesBtn");
const addFolderBtn = document.getElementById("addFolderBtn");
const playlistSearchWrap = document.getElementById("playlistSearchWrap");
const playlistSearch = document.getElementById("playlistSearch");
const playlistSearchClear = document.getElementById("playlistSearchClear");
const cacheSizeText = document.getElementById("cacheSizeText");
const cacheClearBtn = document.getElementById("cacheClearBtn");

let fileAccessEnabled = false;
try {
  chrome.extension.isAllowedFileSchemeAccess().then((a) => { fileAccessEnabled = !!a; });
} catch {}

// ─── Loading overlay ──────────────────────────────────────
function showLoading(name) {
  if (loadingName) loadingName.textContent = name || "";
  loadingOverlay.classList.remove("hidden");
}
function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

// ─── Player wiring ────────────────────────────────────────
const playerEl = document.getElementById("player");
let lastProgressWrite = 0;
customElements.whenDefined("movi-player").then(() => {
  playerEl.addEventListener("loadeddata", () => {
    hideLoading();
    const t = playerEl.title;
    if (t) document.title = t + " — Movi Player";
  });
  playerEl.addEventListener("ended", () => {
    if (playlistIndex >= 0) {
      const f = playlist[playlistIndex];
      if (f) {
        const m = fileMeta.get(f) || {};
        fileMeta.set(f, { ...m, progress: 1 });
        if (playlistItemEls[playlistIndex]) applyItemProgress(playlistItemEls[playlistIndex], f);
      }
    }
    if (playlist.length && playlistIndex >= 0 && playlistIndex < playlist.length - 1) {
      playPlaylistItem(playlistIndex + 1);
    }
  });
  playerEl.addEventListener("timeupdate", () => {
    if (playlistIndex < 0) return;
    const file = playlist[playlistIndex];
    if (!file) return;
    const dur = playerEl.duration;
    const cur = playerEl.currentTime;
    if (!dur || !isFinite(dur) || !isFinite(cur) || dur <= 0) return;
    const now = performance.now();
    if (now - lastProgressWrite < 600) return;
    lastProgressWrite = now;
    const p = Math.max(0, Math.min(1, cur / dur));
    const m = fileMeta.get(file) || {};
    fileMeta.set(file, { ...m, progress: p });
    if (playlistItemEls[playlistIndex]) applyItemProgress(playlistItemEls[playlistIndex], file);
  });
});

// ─── Helpers ──────────────────────────────────────────────
const VIDEO_EXT_RE = /\.(mp4|mkv|webm|mov|avi|ts|m3u8|flv|m4v|ogv|wmv|m2ts|mts|3gp|mpg|mpeg)$/i;
const isVideoFile = (f) => (f.type && f.type.startsWith("video/")) || VIDEO_EXT_RE.test(f.name || "");
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

// Sort playlist entries in tree DFS order with folders-first at every depth.
// Without this, raw-path alpha sort would put a root file like "master.mp4"
// before a folder file like "Videos/x.mp4" (because "m" < "V" with base
// sensitivity), but the tree renders folders first — so playlist[0] would
// not match the file shown at the top of the tree.
const compareTreeOrder = (a, b) => {
  const pa = (a.webkitRelativePath || a.name).split("/");
  const pb = (b.webkitRelativePath || b.name).split("/");
  for (let i = 0; ; i++) {
    if (i >= pa.length || i >= pb.length) return pa.length - pb.length;
    const inFolderA = i < pa.length - 1;
    const inFolderB = i < pb.length - 1;
    if (inFolderA !== inFolderB) return inFolderA ? -1 : 1;
    const c = naturalCompare(pa[i], pb[i]);
    if (c !== 0) return c;
  }
};

const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

const formatDuration = (secs) => {
  if (!secs || !isFinite(secs) || secs < 0) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const qualityLabel = (h) => {
  if (!h) return "";
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  return `${h}p`;
};

const prettyName = (file) =>
  (file.name || "").replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").trim() || file.name;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const resumeKeyForFile = (file) => {
  const base = (file.name || "").replace(/\.[^.\/]+$/, "");
  if (!base || !Movi?.MoviElement?.cleanVideoTitle) return "";
  return `movi-resume:${Movi.MoviElement.cleanVideoTitle(base)}`;
};
const getSavedResumeTime = (file) => {
  const key = resumeKeyForFile(file);
  if (!key) return 0;
  try { const v = localStorage.getItem(key); return v ? parseFloat(v) : 0; } catch { return 0; }
};
const getItemProgress = (file) => {
  const meta = fileMeta.get(file);
  if (typeof meta?.progress === "number" && meta.progress > 0) return meta.progress;
  const saved = getSavedResumeTime(file);
  const dur = meta?.duration;
  if (saved > 0 && dur && dur > 0) return Math.min(1, saved / dur);
  return 0;
};

// ─── IndexedDB thumbnail / metadata cache ────────────────
// Same-machine same-file lookups skip every WASM call (Demuxer +
// ThumbnailBindings + decode). Key is (name, size, lastModified) — collision-
// free in practice and survives across sessions, so the panel feels instant
// after the first load of any folder.
const CACHE_DB = "movi-player-cache";
const CACHE_STORE = "thumbnails";
const CACHE_VERSION = 1;
let cacheDbPromise = null;

function openCacheDb() {
  if (cacheDbPromise) return cacheDbPromise;
  cacheDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, CACHE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.warn("[Movi] thumb cache open failed:", err);
    cacheDbPromise = null;
    return null;
  });
  return cacheDbPromise;
}

function cacheKey(file) {
  return `${file.name}::${file.size}::${file.lastModified || 0}`;
}

async function cacheGet(key) {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const req = tx.objectStore(CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(entry) {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

async function cacheStats() {
  const db = await openCacheDb();
  if (!db) return { count: 0, bytes: 0 };
  return new Promise((resolve) => {
    let count = 0;
    let bytes = 0;
    try {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const cur = tx.objectStore(CACHE_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve({ count, bytes }); return; }
        count++;
        if (c.value?.thumbBlob) bytes += c.value.thumbBlob.size || 0;
        c.continue();
      };
      cur.onerror = () => resolve({ count, bytes });
    } catch { resolve({ count, bytes }); }
  });
}

async function cacheClear() {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

// ─── Playlist state ───────────────────────────────────────
let playlist = [];
let playlistIndex = -1;
let currentFile = null;
const playlistItemEls = [];
const fileMeta = new Map();
const metaQueue = [];
let metaProcessing = false;
let thumbWasmPromise = null;

function loadFile(file) {
  overlay.classList.add("hidden");
  document.title = file.name + " — Movi Player";
  if (playerEl.setFile) playerEl.setFile(file);
  else playerEl.src = file;
}

function showPlaylist() {
  playlistPanel.hidden = false;
  playlistToggleBtn.classList.remove("visible");
}
function hidePlaylist() {
  playlistPanel.hidden = true;
  if (playlist.length) playlistToggleBtn.classList.add("visible");
}
playlistCloseBtn.addEventListener("click", hidePlaylist);
playlistToggleBtn.addEventListener("click", showPlaylist);

// ─── Search ───────────────────────────────────────────────
function applySearchFilter() {
  const q = (playlistSearch.value || "").trim().toLowerCase();
  playlistSearchWrap.classList.toggle("has-query", !!q);

  if (!q) {
    // Restore: show everything, re-apply user collapse state.
    playlistItemsEl.querySelectorAll(".playlist-item").forEach((el) => { el.style.display = ""; });
    playlistItemsEl.querySelectorAll(".playlist-folder").forEach((folderEl) => {
      folderEl.style.display = "";
      const wrap = folderEl.nextElementSibling;
      if (!wrap) return;
      wrap.style.display = "";
      const path = folderEl.dataset.path;
      if (collapsedFolders.has(path)) {
        folderEl.classList.add("collapsed");
        wrap.classList.add("hidden");
      } else {
        folderEl.classList.remove("collapsed");
        wrap.classList.remove("hidden");
      }
    });
    return;
  }

  // Hide non-matching files.
  playlistItemEls.forEach((el, i) => {
    if (!el) return;
    const name = playlist[i]?.name?.toLowerCase() || "";
    el.style.display = name.includes(q) ? "" : "none";
  });

  // Folder visibility: shown (and force-expanded) iff at least one descendant
  // file matches. Walking the DOM bottom-up keeps the parent-of-parent case
  // working without recursion.
  const folders = Array.from(playlistItemsEl.querySelectorAll(".playlist-folder")).reverse();
  for (const folderEl of folders) {
    const wrap = folderEl.nextElementSibling;
    if (!wrap) continue;
    let anyVisible = false;
    wrap.querySelectorAll(":scope > .playlist-item").forEach((it) => {
      if (it.style.display !== "none") anyVisible = true;
    });
    wrap.querySelectorAll(":scope > .playlist-folder").forEach((sub) => {
      if (sub.style.display !== "none") anyVisible = true;
    });
    if (anyVisible) {
      folderEl.style.display = "";
      wrap.style.display = "";
      folderEl.classList.remove("collapsed");
      wrap.classList.remove("hidden");
    } else {
      folderEl.style.display = "none";
      wrap.style.display = "none";
    }
  }
}

playlistSearch.addEventListener("input", applySearchFilter);
playlistSearchClear.addEventListener("click", () => {
  playlistSearch.value = "";
  applySearchFilter();
  playlistSearch.focus();
});
// Esc inside the search input clears it instead of leaving the field.
playlistSearch.addEventListener("keydown", (e) => {
  if (e.code === "Escape" && playlistSearch.value) {
    e.preventDefault();
    e.stopPropagation();
    playlistSearch.value = "";
    applySearchFilter();
  }
});

// Focus the panel on any mousedown inside it so keyboard nav becomes active
// immediately. Buttons / inputs still receive their own clicks because focus
// transitions land where the browser would naturally put them.
playlistPanel.addEventListener("mousedown", (e) => {
  if (playlistPanel.contains(document.activeElement)) return;
  if (e.target === playlistPanel) {
    e.preventDefault();
    playlistPanel.focus();
  } else {
    queueMicrotask(() => {
      if (!playlistPanel.contains(document.activeElement)) playlistPanel.focus();
    });
  }
});

// Up / Down / Enter while playlist is focused — handled here, NOT forwarded
// to the player. Other keys still fall through to the document handler so
// space, F, M etc. continue to control playback regardless of focus.
playlistPanel.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
  if (e.code === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    moveHighlight(1);
  } else if (e.code === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    moveHighlight(-1);
  } else if (e.code === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    if (highlightedIndex >= 0) playPlaylistItem(highlightedIndex);
  } else if (e.code === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    setHighlightedIndex(-1);
    playerEl.focus();
  }
});

function setPlaylist(files, { rootName } = {}) {
  const videos = files.filter(isVideoFile);
  if (!videos.length) return;
  videos.sort(compareTreeOrder);
  // Release any prior thumbnail blob URLs before replacing the playlist.
  fileMeta.forEach((m) => { if (m?.thumbUrl) URL.revokeObjectURL(m.thumbUrl); });
  fileMeta.clear();
  metaQueue.length = 0;

  playlist = videos;
  playlistIndex = -1;
  playlistTitleEl.textContent = rootName || (videos.length === 1 ? videos[0].name : "Playlist");
  showPlaylist();
  renderPlaylist();
  // Drop any stale search query left over from the previous playlist so the
  // user sees the new files in full.
  if (playlistSearch.value) {
    playlistSearch.value = "";
    applySearchFilter();
  }
  playPlaylistItem(0);
}

function appendToPlaylist(files) {
  const videos = files.filter(isVideoFile);
  if (!videos.length) return;
  const key = (f) => (f.webkitRelativePath || f.name) + ":" + f.size;
  const existing = new Set(playlist.map(key));
  const fresh = videos.filter((f) => !existing.has(key(f)));
  if (!fresh.length) return;
  const wasEmpty = playlist.length === 0;
  playlist = playlist.concat(fresh);
  playlist.sort(compareTreeOrder);
  playlistIndex = currentFile ? playlist.indexOf(currentFile) : -1;
  if (wasEmpty) {
    playlistTitleEl.textContent = playlist.length === 1 ? playlist[0].name : "Playlist";
    showPlaylist();
  }
  renderPlaylist();
  if (wasEmpty) playPlaylistItem(0);
}

// Keyboard "selection cursor" for playlist nav — independent of which file
// is currently playing (`playlistIndex`). Up/Down moves this; Enter plays it.
let highlightedIndex = -1;

function setHighlightedIndex(i) {
  highlightedIndex = i;
  playlistItemEls.forEach((el, j) => {
    if (!el) return;
    el.classList.toggle("highlighted", j === i);
  });
  const el = playlistItemEls[i];
  if (!el) return;
  const c = playlistItemsEl;
  const elTop = el.offsetTop - c.offsetTop;
  const elBottom = elTop + el.offsetHeight;
  if (elTop < c.scrollTop) c.scrollTo({ top: elTop, behavior: "smooth" });
  else if (elBottom > c.scrollTop + c.clientHeight) {
    c.scrollTo({ top: elBottom - c.clientHeight, behavior: "smooth" });
  }
}

function visibleItemIndices() {
  const out = [];
  for (let i = 0; i < playlistItemEls.length; i++) {
    const el = playlistItemEls[i];
    // offsetParent is null when the element (or any ancestor) is display:none —
    // i.e. the item lives inside a collapsed folder.
    if (el && el.offsetParent !== null) out.push(i);
  }
  return out;
}

function moveHighlight(delta) {
  const visible = visibleItemIndices();
  if (!visible.length) return;
  let cursor = visible.indexOf(highlightedIndex);
  if (cursor === -1) {
    cursor = visible.indexOf(playlistIndex);
    if (cursor === -1) cursor = 0;
  } else {
    cursor = Math.max(0, Math.min(visible.length - 1, cursor + delta));
  }
  setHighlightedIndex(visible[cursor]);
}

function playPlaylistItem(i) {
  if (i < 0 || i >= playlist.length) return;
  const file = playlist[i];
  if (!file) return;
  playlistIndex = i;
  currentFile = file;
  overlay.classList.add("hidden");
  document.title = file.name + " — Movi Player";
  // Drop poster so previous item's poster doesn't bleed in
  playerEl.removeAttribute("poster");
  playerEl.removeAttribute("postertime");
  playerEl.setAttribute("postertime", "10%");
  if (playerEl.setFile) playerEl.setFile(file);
  else playerEl.src = file;
  playerEl.play?.().catch(() => {});
  updateActiveItem(i);
}

// ─── Item rendering ───────────────────────────────────────
const applyItemMeta = (li, file) => {
  const meta = fileMeta.get(file);
  const img = li.querySelector(".playlist-thumb-img");
  const durEl = li.querySelector(".playlist-thumb-duration");
  const metaEl = li.querySelector(".playlist-item-meta");
  const thumbEl = li.querySelector(".playlist-thumb");

  if (meta?.thumbUrl) {
    if (img.src !== meta.thumbUrl) img.src = meta.thumbUrl;
    img.hidden = false;
    thumbEl.classList.remove("no-thumb");
  } else if (meta?.completed) {
    // Generation finished without producing a thumb (decode failed, non-video
    // file, etc.) — kill the shimmer and show a static fallback icon.
    thumbEl.classList.add("no-thumb");
  }
  if (meta?.duration) {
    durEl.textContent = formatDuration(meta.duration);
    durEl.hidden = false;
  }

  let hdr = thumbEl.querySelector(".playlist-thumb-hdr");
  if (meta?.isHDR) {
    if (!hdr) {
      hdr = document.createElement("span");
      hdr.className = "playlist-thumb-hdr";
      hdr.textContent = "HDR";
      thumbEl.appendChild(hdr);
    }
  } else if (hdr) hdr.remove();

  let fps = thumbEl.querySelector(".playlist-thumb-fps");
  if (meta?.isHighFps && meta?.frameRate) {
    if (!fps) {
      fps = document.createElement("span");
      fps.className = "playlist-thumb-fps";
      thumbEl.appendChild(fps);
    }
    fps.textContent = `${Math.round(meta.frameRate)} FPS`;
  } else if (fps) fps.remove();

  applyItemProgress(li, file);

  const parts = [];
  if (meta?.height) parts.push(`<span class="meta-res">${qualityLabel(meta.height)}</span>`);
  if (meta?.codec) parts.push(escapeHtml(String(meta.codec).toUpperCase()));
  parts.push(escapeHtml(formatSize(file.size)));
  metaEl.innerHTML = parts.filter(Boolean).join(" · ");
};

function applyItemProgress(li, file) {
  const progressEl = li.querySelector(".playlist-thumb-progress");
  const barEl = li.querySelector(".playlist-thumb-progress-bar");
  if (!progressEl || !barEl) return;
  const p = getItemProgress(file);
  if (p > 0.005) {
    barEl.style.width = `${Math.min(100, p * 100)}%`;
    progressEl.hidden = false;
  } else {
    progressEl.hidden = true;
  }
}

function createItemEl(file, i) {
  const li = document.createElement("div");
  li.className = "playlist-item";
  li.dataset.index = String(i);
  li.title = file.webkitRelativePath || file.name;
  li.innerHTML = `
    <span class="playlist-thumb">
      <img class="playlist-thumb-img" alt="" loading="lazy" hidden />
      <span class="playlist-thumb-fallback" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
      </span>
      <span class="playlist-thumb-playing" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </span>
      <span class="playlist-thumb-duration" hidden></span>
      <span class="playlist-thumb-progress" hidden>
        <span class="playlist-thumb-progress-bar"></span>
      </span>
    </span>
    <span class="playlist-item-body">
      <span class="playlist-item-name"></span>
      <span class="playlist-item-meta"></span>
    </span>
  `;
  li.querySelector(".playlist-item-name").textContent = prettyName(file);
  li.addEventListener("click", () => {
    playPlaylistItem(i);
    // Keep keyboard focus on the panel so user can immediately Up/Down to
    // the next item — without this, click moves focus to body and arrow
    // keys would scrub the player instead of navigating the playlist.
    playlistPanel.focus({ preventScroll: true });
    setHighlightedIndex(i);
  });
  applyItemMeta(li, file);
  return li;
}

const metaObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const i = Number(entry.target.dataset.index);
            const file = playlist[i];
            if (file) enqueueMeta(file);
            metaObserver.unobserve(entry.target);
          }
        },
        { root: playlistItemsEl, rootMargin: "200px 0px" }
      )
    : null;

// ─── Tree (folder hierarchy) ─────────────────────────────
const collapsedFolders = new Set();

function buildTree(files) {
  const root = { folders: new Map(), files: [], depth: 0, path: "" };
  files.forEach((file, i) => {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split("/");
    parts.pop(); // strip filename
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) {
        node.folders.set(part, {
          folders: new Map(),
          files: [],
          depth: node.depth + 1,
          path: node.path ? node.path + "/" + part : part,
        });
      }
      node = node.folders.get(part);
    }
    node.files.push({ file, index: i });
  });

  // If everything sits inside a single root folder, promote that folder up.
  // The panel header already shows its name, so a duplicate top-level row
  // would feel redundant.
  if (root.files.length === 0 && root.folders.size === 1) {
    const only = Array.from(root.folders.values())[0];
    const rebase = (n, depth, prefix) => {
      n.depth = depth;
      n.path = prefix;
      n.folders.forEach((c, name) => rebase(c, depth + 1, prefix ? prefix + "/" + name : name));
    };
    rebase(only, 0, "");
    return only;
  }
  return root;
}

function countFiles(node) {
  let n = node.files.length;
  for (const c of node.folders.values()) n += countFiles(c);
  return n;
}

function renderNode(node, container) {
  // Folders alphabetically first, then files alphabetically — standard
  // Explorer/Finder convention. The `playlist` array is sorted with
  // compareTreeOrder so playlist[0] is the file at the top of this tree.
  const folderEntries = Array.from(node.folders.entries()).sort(([a], [b]) => naturalCompare(a, b));
  for (const [name, child] of folderEntries) {
    const folderEl = document.createElement("div");
    folderEl.className = "playlist-folder";
    folderEl.dataset.path = child.path;
    const isCollapsed = collapsedFolders.has(child.path);
    if (isCollapsed) folderEl.classList.add("collapsed");
    folderEl.innerHTML = `
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="playlist-folder-name"></span>
      <span class="playlist-folder-count"></span>
    `;
    folderEl.querySelector(".playlist-folder-name").textContent = name;
    folderEl.querySelector(".playlist-folder-count").textContent = String(countFiles(child));
    container.appendChild(folderEl);

    const childWrap = document.createElement("div");
    childWrap.className = "playlist-folder-children";
    if (isCollapsed) childWrap.classList.add("hidden");
    container.appendChild(childWrap);

    folderEl.addEventListener("click", () => {
      const collapsed = folderEl.classList.toggle("collapsed");
      childWrap.classList.toggle("hidden", collapsed);
      if (collapsed) collapsedFolders.add(child.path);
      else collapsedFolders.delete(child.path);
    });

    renderNode(child, childWrap);
  }

  const fileEntries = [...node.files].sort((a, b) => naturalCompare(a.file.name, b.file.name));
  for (const { file, index } of fileEntries) {
    const li = createItemEl(file, index);
    if (index === playlistIndex) li.classList.add("active");
    container.appendChild(li);
    playlistItemEls[index] = li;
    metaObserver?.observe(li);
  }
}

function renderPlaylist() {
  playlistItemsEl.innerHTML = "";
  playlistItemEls.length = 0;
  playlistCountEl.textContent = String(playlist.length);
  const tree = buildTree(playlist);
  renderNode(tree, playlistItemsEl);
}

function updateActiveItem(newIdx) {
  playlistItemEls.forEach((el, j) => {
    if (!el) return;
    el.classList.toggle("active", j === newIdx);
  });
  const el = playlistItemEls[newIdx];
  if (!el) return;
  const c = playlistItemsEl;
  const elTop = el.offsetTop - c.offsetTop;
  const elBottom = elTop + el.offsetHeight;
  if (elTop < c.scrollTop) c.scrollTo({ top: elTop, behavior: "smooth" });
  else if (elBottom > c.scrollTop + c.clientHeight) c.scrollTo({ top: elBottom - c.clientHeight, behavior: "smooth" });
}

// ─── Thumbnail / metadata generation ──────────────────────
function enqueueMeta(file) {
  if (!file) return;
  const state = fileMeta.get(file);
  if (state?.completed || state?.queued) return;
  fileMeta.set(file, { ...(state || {}), queued: true });
  metaQueue.push(file);
  pumpMetaQueue();
}

async function pumpMetaQueue() {
  if (metaProcessing) return;
  metaProcessing = true;
  try {
    while (metaQueue.length) {
      const file = metaQueue.shift();
      try {
        await generateMetaAndThumb(file);
      } catch (err) {
        console.warn("[Movi] thumb/meta failed for", file.name, err);
        fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true, failed: true });
      }
      const idx = playlist.indexOf(file);
      if (idx >= 0 && playlistItemEls[idx]) applyItemMeta(playlistItemEls[idx], file);
    }
  } finally {
    metaProcessing = false;
  }
}

async function generateMetaAndThumb(file) {
  // ── Cache check first — most loads after the very first run never need
  // to touch WASM at all, so this is what keeps the panel responsive.
  const cacheK = cacheKey(file);
  const cached = await cacheGet(cacheK);
  if (cached) {
    const next = {
      duration: cached.duration,
      width: cached.width,
      height: cached.height,
      codec: cached.codec,
      isHDR: cached.isHDR,
      frameRate: cached.frameRate,
      isHighFps: cached.isHighFps,
      thumbUrl: cached.thumbBlob ? URL.createObjectURL(cached.thumbBlob) : undefined,
      completed: true,
    };
    fileMeta.set(file, { ...(fileMeta.get(file) || {}), ...next });
    return;
  }

  if (!Movi?.ThumbnailBindings || !Movi?.FileSource || !Movi?.loadWasmModuleNew) {
    fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
    return;
  }
  if (!thumbWasmPromise) {
    thumbWasmPromise = Movi.loadWasmModuleNew().catch((err) => {
      console.warn("[Movi] thumbnail wasm load failed:", err);
      thumbWasmPromise = null;
      return null;
    });
  }
  const wasm = await thumbWasmPromise;
  if (!wasm) {
    fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
    return;
  }

  // Read display-matrix rotation off a Demuxer pass. ThumbnailBindings'
  // streamInfo.rotation is unreliable for many MKV/MP4 files — some report
  // 0 even when the file declares a 90/180/270 matrix — so the thumb would
  // come out facing the wrong way. The Demuxer + IndexedDB cache below mean
  // this expensive call only happens the first time a given file is seen.
  let trackRotation = 0;
  if (Movi?.Demuxer) {
    try {
      const dm = new Movi.Demuxer(new Movi.FileSource(file), undefined, true);
      await dm.open();
      const vt = dm.getVideoTracks?.()[0];
      if (vt) trackRotation = vt.rotation || 0;
      try { dm.close(); } catch {}
    } catch {}
  }

  const bindings = new Movi.ThumbnailBindings(wasm);
  try {
    bindings.setDataSource(new Movi.FileSource(file));
    await bindings.create(file.size);
    if (!(await bindings.open())) {
      fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
      return;
    }
    const streamInfo = bindings.getStreamInfo?.() || null;
    if (!streamInfo) {
      fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
      return;
    }

    const sw = streamInfo.width || 0;
    const sh = streamInfo.height || 0;
    const rawRotation = trackRotation || streamInfo.rotation || 0;
    const rotation = ((rawRotation % 360) + 360) % 360;
    const isRotated = rotation === 90 || rotation === 270;
    const duration = streamInfo.duration || 0;
    const codec = streamInfo.codecName || "";
    const isHDR =
      streamInfo.colorTransfer === "smpte2084" ||
      streamInfo.colorTransfer === "arib-std-b67" ||
      streamInfo.colorPrimaries === "bt2020";
    const frameRate = streamInfo.frameRate || 0;
    const isHighFps = frameRate >= 50;
    const displayW = isRotated ? sh : sw;
    const displayH = isRotated ? sw : sh;

    fileMeta.set(file, {
      ...(fileMeta.get(file) || {}),
      duration, width: displayW, height: displayH, codec, isHDR,
      frameRate, isHighFps,
    });
    const idx = playlist.indexOf(file);
    if (idx >= 0 && playlistItemEls[idx]) applyItemMeta(playlistItemEls[idx], file);

    if (!sw || !sh || !duration) {
      fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
      return;
    }

    const time = Math.max(0, duration * 0.1);
    const pktSize = await bindings.readKeyframe(time);
    if (!pktSize || pktSize <= 0) {
      fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
      return;
    }
    const rgba = bindings.decodeCurrentPacket(sw, sh);
    if (!rgba) {
      fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
      return;
    }

    const THUMB_W = 320, THUMB_H = 180;
    const srcAR = displayW / displayH;
    const dstAR = THUMB_W / THUMB_H;
    let dw, dh;
    if (srcAR > dstAR) { dw = THUMB_W; dh = THUMB_W / srcAR; }
    else { dh = THUMB_H; dw = THUMB_H * srcAR; }

    const src = document.createElement("canvas");
    src.width = sw; src.height = sh;
    const sctx = src.getContext("2d");
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    sctx.putImageData(new ImageData(clamped, sw, sh), 0, 0);

    const out = document.createElement("canvas");
    out.width = THUMB_W; out.height = THUMB_H;
    const octx = out.getContext("2d");
    octx.fillStyle = "#000";
    octx.fillRect(0, 0, THUMB_W, THUMB_H);
    octx.save();
    octx.translate(THUMB_W / 2, THUMB_H / 2);
    if (rotation) octx.rotate((rotation * Math.PI) / 180);
    const drawW = isRotated ? dh : dw;
    const drawH = isRotated ? dw : dh;
    octx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH);
    octx.restore();

    const blob = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.75));
    if (blob) {
      const prev = fileMeta.get(file);
      if (prev?.thumbUrl) URL.revokeObjectURL(prev.thumbUrl);
      fileMeta.set(file, { ...(prev || {}), thumbUrl: URL.createObjectURL(blob), completed: true });
      cachePut({
        key: cacheK,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified || 0,
        duration, width: displayW, height: displayH, codec, isHDR, frameRate, isHighFps,
        thumbBlob: blob,
        createdAt: Date.now(),
      });
    } else {
      fileMeta.set(file, { ...(fileMeta.get(file) || {}), completed: true });
      // Cache the meta-only result too so we don't redo the WASM dance next
      // time for files where thumb decode failed but metadata was readable.
      cachePut({
        key: cacheK,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified || 0,
        duration, width: displayW, height: displayH, codec, isHDR, frameRate, isHighFps,
        thumbBlob: null,
        createdAt: Date.now(),
      });
    }
    try { bindings.clearBuffer?.(); } catch {}
  } finally {
    try { bindings.destroy?.(); } catch {}
  }
}

// ─── Folder picker (File System Access API → input fallback) ─
async function collectFilesFromDirHandle(dirHandle, path = "") {
  const out = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "directory") {
      const sub = await collectFilesFromDirHandle(entry, path + entry.name + "/");
      out.push(...sub);
    } else {
      try {
        const file = await entry.getFile();
        try {
          Object.defineProperty(file, "webkitRelativePath", {
            value: path + entry.name,
            configurable: true,
          });
        } catch {}
        out.push(file);
      } catch {}
    }
  }
  return out;
}

async function pickFolder({ append = false } = {}) {
  if ("showDirectoryPicker" in window) {
    try {
      const dir = await window.showDirectoryPicker();
      const files = await collectFilesFromDirHandle(dir, dir.name + "/");
      if (append) appendToPlaylist(files);
      else setPlaylist(files, { rootName: dir.name });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  folderPicker.dataset.append = append ? "1" : "";
  folderPicker.click();
}

// ─── URL / single-file load ───────────────────────────────
function filenameFromPath(path) {
  try {
    return decodeURIComponent(path.split("/").pop().split("?")[0].split("#")[0]) || "video";
  } catch { return "video"; }
}
function showFileAccessError(fileUrl) {
  overlay.classList.remove("hidden");
  const dropText = overlay.querySelector(".drop-text");
  if (dropText) {
    dropText.innerHTML = `
      <h2 style="color:#ef4444">File access not enabled</h2>
      <p style="color:#888;max-width:420px;margin:8px auto 0;line-height:1.5">
        To play local files, open <b style="color:#A78BFA">chrome://extensions</b>,
        find <b style="color:#A78BFA">Movi Player</b>, click <b style="color:#A78BFA">Details</b>,
        and enable <b style="color:#A78BFA">"Allow access to file URLs"</b>. Then reopen this video.
      </p>
      <p style="color:#555;margin-top:12px;font-size:11px;word-break:break-all">${fileUrl}</p>
    `;
  }
}
async function loadFileUrl(fileUrl) {
  const name = filenameFromPath(fileUrl);
  showLoading(name);
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const file = new File([blob], name, { type: blob.type || "video/mp4" });
    loadFile(file);
  } catch (err) {
    console.error("[Movi] failed to load file URL:", err);
    hideLoading();
    showFileAccessError(fileUrl);
  }
}

if (url) {
  if (url.startsWith("file://")) {
    const name = filenameFromPath(url).replace(/\.[^.]+$/, "");
    document.title = (name || "Video") + " — Movi Player";
    loadFileUrl(url);
  } else {
    let name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    name = name.replace(/\.[^.]+$/, "");
    if (!name || /^(index|master|playlist)$/i.test(name)) {
      try {
        const segments = new URL(url).pathname.split("/").filter((s) => s && !s.includes("."));
        if (segments.length > 0) name = decodeURIComponent(segments[segments.length - 1]).replace(/[-_]/g, " ");
      } catch {}
    }
    document.title = (name || "Video") + " — Movi Player";
    customElements.whenDefined("movi-player").then(() => { playerEl.src = url; });
  }
} else {
  overlay.classList.remove("hidden");
}

// ─── Picker handlers ──────────────────────────────────────
filePicker.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  const append = filePicker.dataset.append === "1";
  filePicker.dataset.append = "";
  filePicker.value = "";
  if (!files.length) return;
  if (files.length === 1 && !append && !playlist.length) loadFile(files[0]);
  else if (append) appendToPlaylist(files);
  else setPlaylist(files);
});

folderPicker.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  const append = folderPicker.dataset.append === "1";
  folderPicker.dataset.append = "";
  folderPicker.value = "";
  if (!files.length) return;
  let rootName = "Folder";
  const rel = files[0].webkitRelativePath;
  if (rel) rootName = rel.split("/")[0] || rootName;
  if (append) appendToPlaylist(files);
  else setPlaylist(files, { rootName });
});

addFilesBtn.addEventListener("click", () => {
  filePicker.dataset.append = "1";
  filePicker.click();
});
addFolderBtn.addEventListener("click", () => pickFolder({ append: true }));

document.querySelectorAll('.browse-btn.secondary').forEach((btn) => {
  btn.addEventListener("click", (e) => {
    if (!("showDirectoryPicker" in window)) return; // fall back to <input>
    e.preventDefault();
    pickFolder();
  });
});

// ─── Drag and drop ────────────────────────────────────────
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!playlist.length) overlay.classList.remove("hidden");
  dropZone.classList.add("dragover");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    dropZone.classList.remove("dragover");
  }
});

function walkEntry(entry, path, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        try {
          Object.defineProperty(file, "webkitRelativePath", {
            value: path + entry.name,
            configurable: true,
          });
        } catch {}
        out.push(file);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) return resolve();
          await Promise.all(entries.map((e) => walkEntry(e, path + entry.name + "/", out)));
          readBatch();
        }, () => resolve());
      };
      readBatch();
    } else resolve();
  });
}
async function filesFromDataTransfer(dt) {
  const items = dt.items ? Array.from(dt.items) : [];
  const supportsEntries = items.some((it) => typeof it.webkitGetAsEntry === "function");
  if (supportsEntries) {
    const out = [];
    const tasks = [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.();
      if (!entry) continue;
      tasks.push(walkEntry(entry, "", out));
    }
    await Promise.all(tasks);
    if (out.length) return out;
  }
  return Array.from(dt.files || []);
}

document.addEventListener("drop", async (e) => {
  dropZone.classList.remove("dragover");
  if (
    fileAccessEnabled &&
    !playlist.length &&
    !overlay.classList.contains("hidden") &&
    e.dataTransfer.files.length === 1 &&
    (!e.dataTransfer.items ||
      !Array.from(e.dataTransfer.items).some((it) => it.webkitGetAsEntry?.()?.isDirectory))
  ) {
    setTimeout(() => window.close(), 200);
    return;
  }
  e.preventDefault();
  const files = await filesFromDataTransfer(e.dataTransfer);
  if (!files.length) return;
  if (playlist.length) appendToPlaylist(files);
  else if (files.length === 1 && !files[0].webkitRelativePath) loadFile(files[0]);
  else setPlaylist(files);
});

// ─── Tab: switch focus between player and playlist ───────
document.addEventListener("keydown", (e) => {
  if (e.code !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  // Only toggle when there is actually a playlist to switch to. Without this
  // Tab would still get hijacked on the empty file-picker overlay.
  if (!playlist.length) return;
  e.preventDefault();
  e.stopPropagation();
  const focusInPlaylist =
    playlistPanel.contains(document.activeElement) || document.activeElement === playlistPanel;
  if (focusInPlaylist) {
    playerEl.focus();
  } else {
    if (playlistPanel.hidden) showPlaylist();
    playlistPanel.focus({ preventScroll: true });
  }
}, true); // capture so it wins over the search input's default tab-out

// ─── Cache info UI ────────────────────────────────────────
function formatBytes(b) {
  if (!b) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = b;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
async function refreshCacheInfo() {
  const { count, bytes } = await cacheStats();
  cacheSizeText.textContent = count
    ? `${formatBytes(bytes)} · ${count} ${count === 1 ? "thumb" : "thumbs"}`
    : "No cache yet";
  cacheClearBtn.disabled = count === 0;
}
cacheClearBtn.addEventListener("click", async () => {
  cacheClearBtn.disabled = true;
  cacheClearBtn.textContent = "Clearing…";
  await cacheClear();
  cacheClearBtn.textContent = "Clear cache";
  await refreshCacheInfo();
});
refreshCacheInfo();
// Keep the displayed total in sync as new thumbs land in the cache. The
// drop overlay is the only place this widget lives, so we only need to
// update while it's visible — but a periodic cheap query is simpler than
// hooking every cachePut call site.
setInterval(() => {
  if (overlay.classList.contains("hidden")) return;
  refreshCacheInfo();
}, 4000);

// ─── Forward keyboard ─────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
  if (!playerEl || !playerEl.shadowRoot) return;
  if (document.activeElement === playerEl || playerEl.contains(e.target)) return;

  // When the playlist panel has focus, Up/Down/Enter belong to the playlist
  // (handled by its own keydown listener). The panel handler stops propagation
  // for those keys — anything that reaches here from inside the panel is a
  // key the panel didn't claim, so we let it through to the player.
  if (playlistPanel.contains(document.activeElement) || document.activeElement === playlistPanel) {
    if (e.code === "ArrowUp" || e.code === "ArrowDown" || e.code === "Enter") return;
  }

  playerEl.dispatchEvent(new KeyboardEvent("keydown", {
    key: e.key, code: e.code, keyCode: e.keyCode,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
    bubbles: true, cancelable: true,
  }));
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
    e.preventDefault();
  }
});
