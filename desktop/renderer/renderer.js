/**
 * Renderer wiring for the MoviPlayer desktop shell.
 *
 * Media reaches <movi-player> by source:
 *   drag & drop  → File object → player.setFile()      (zero-copy)
 *   pick / recent / OS open-with → path → /_local?p=…   (range-streamed)
 *   URL bar      → /_proxy?url=…                         (range pass-through)
 */
const player = document.getElementById("player");
const welcome = document.getElementById("welcome");
const dropzone = document.getElementById("dropzone");
const urlForm = document.getElementById("url-form");
const urlInput = document.getElementById("url-input");
const dropOverlay = document.getElementById("drop-overlay");
const toast = document.getElementById("toast");
const recentsSection = document.getElementById("recents");
const recentsList = document.getElementById("recents-list");
const recentsClear = document.getElementById("recents-clear");
const playlistPanel = document.getElementById("playlist-panel");
const plItems = document.getElementById("pl-items");
const plCount = document.getElementById("pl-count");
const plClose = document.getElementById("pl-close");
const plToggle = document.getElementById("pl-toggle");
const plToggleCount = document.getElementById("pl-toggle-count");

document.body.classList.add(
  window.movi.platform === "darwin" ? "mac" : window.movi.platform === "win32" ? "win" : "linux"
);

// Carry the real filename as a throwaway path segment. The player derives its
// title fallback from the URL's basename, so without this it would read
// "_local"/"_proxy" (→ "Local"/"Proxy"). The EMBEDDED container title still
// wins — the element only falls back to this filename when the media carries
// no title metadata. The query (?p= / ?url=) is what the server actually reads.
const baseName = (p) => String(p).split(/[?#]/)[0].split(/[\\/]/).pop() || String(p);
const localSrc = (p) => `/_local/${encodeURIComponent(baseName(p))}?p=${encodeURIComponent(p)}`;
const proxySrc = (u) => `/_proxy/${encodeURIComponent(baseName(u))}?url=${encodeURIComponent(u)}`;

let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

function prime() {
  welcome.style.display = "none";
  player.hidden = false;
  player.setAttribute("autoplay", "");
}
function loadSrc(src) {
  prime();
  player.src = src;
}
async function loadFile(file) {
  prime();
  clearPlaylist();
  // Prefer loading by path (via the local server) so the file also works in
  // the PiP window and lands in Recents. Fall back to a zero-copy File when the
  // path isn't available (then PiP isn't possible for that source).
  const fp = window.movi.pathForFile(file);
  if (fp) {
    try { await window.movi.grant([fp]); } catch {}
    player.src = localSrc(fp);
  } else if (typeof player.setFile === "function") {
    player.setFile(file);
  } else {
    player.src = file;
  }
}
function loadPaths(paths) {
  openPathList(paths);
}

// ---------- Playlist ----------
let playlist = [];
let playlistIndex = -1;
let panelOpen = false;
let controlsVisible = true;
let iconHovered = false;

// The playlist icon rides with the player controls — shown only when the
// controls are visible, a multi-file playlist exists, and the panel is closed.
// Stay visible while hovered: the icon is a sibling over the player, so hovering
// it makes the player hide its controls → icon hides → mouse back on the player
// → controls show → icon shows … a flicker loop. The hover guard breaks it.
function updatePlToggle() {
  const show = playlist.length > 1 && !panelOpen && (controlsVisible || iconHovered);
  plToggle.hidden = !show;
}
function openPanel() {
  panelOpen = true;
  playlistPanel.classList.add("open");
  updatePlToggle();
}
function closePanel() {
  panelOpen = false;
  playlistPanel.classList.remove("open");
  updatePlToggle();
}

// Entry point for any batch of paths: 2+ → playlist, 1 → single play.
function openPathList(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  if (list.length > 1) {
    setPlaylist(list);
  } else {
    clearPlaylist();
    loadSrc(localSrc(list[0]));
  }
}

function setPlaylist(paths) {
  playlist = paths.slice();
  playlistIndex = -1;
  renderPlaylist();
  // Don't auto-open the panel (would shrink the video). The icon surfaces with
  // the controls; the user opens the list on demand.
  closePanel();
  playPlaylistItem(0);
}

function clearPlaylist() {
  playlist = [];
  playlistIndex = -1;
  plItems.replaceChildren();
  closePanel();
}

function playPlaylistItem(i) {
  if (i < 0 || i >= playlist.length) return;
  playlistIndex = i;
  loadSrc(localSrc(playlist[i]));
  updateActiveItem();
}

function renderPlaylist() {
  plItems.replaceChildren();
  playlist.forEach((p, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pl-item";
    btn.title = baseName(p);

    const idx = document.createElement("span");
    idx.className = "pl-index";
    idx.textContent = String(i + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "pl-name";
    name.textContent = baseName(p);

    btn.append(idx, name);
    btn.addEventListener("click", () => playPlaylistItem(i));
    li.append(btn);
    plItems.append(li);
  });
  const n = playlist.length;
  plCount.textContent = n;
  plToggleCount.textContent = n;
}

function updateActiveItem() {
  Array.from(plItems.children).forEach((li, i) => {
    li.firstElementChild.classList.toggle("active", i === playlistIndex);
  });
  const active = plItems.children[playlistIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

// Auto-advance to the next track when one ends (unless looping the current).
player.addEventListener("ended", () => {
  if (player.loop) return;
  if (playlistIndex >= 0 && playlistIndex < playlist.length - 1) {
    playPlaylistItem(playlistIndex + 1);
  }
});

plClose.addEventListener("click", closePanel);
plToggle.addEventListener("click", openPanel);
plToggle.addEventListener("mouseenter", () => { iconHovered = true; updatePlToggle(); });
plToggle.addEventListener("mouseleave", () => { iconHovered = false; updatePlToggle(); });

// Sync the playlist icon with the player's own controls visibility.
function observeControls(attempt = 0) {
  const sr = player.shadowRoot;
  const container = sr && sr.querySelector(".movi-controls-container");
  if (!container) {
    if (attempt < 30) setTimeout(() => observeControls(attempt + 1), 100);
    return;
  }
  const sync = () => {
    controlsVisible = !container.classList.contains("movi-controls-hidden");
    updatePlToggle();
  };
  new MutationObserver(sync).observe(container, { attributes: true, attributeFilter: ["class"] });
  sync();
}
observeControls();

// ---------- Recents ----------
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

async function refreshRecents() {
  let items = [];
  try {
    items = (await window.movi.getRecents()) || [];
  } catch {
    items = [];
  }
  recentsList.replaceChildren();
  if (!items.length) {
    recentsSection.hidden = true;
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent";
    btn.title = it.path;

    const ext = document.createElement("span");
    ext.className = "recent-ext";
    ext.textContent = (it.ext || "FILE").toUpperCase();

    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = it.name;

    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = fmtSize(it.size);

    btn.append(ext, name, meta);
    btn.addEventListener("click", () => window.movi.openRecent(it.path));
    li.append(btn);
    recentsList.append(li);
  }
  recentsSection.hidden = false;
}

recentsClear.addEventListener("click", async () => {
  await window.movi.clearRecents();
  refreshRecents();
});

// ---------- UI events ----------
urlForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const u = urlInput.value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) return showToast("Enter a full http(s):// link");
  clearPlaylist();
  loadSrc(proxySrc(u));
  urlInput.blur();
});

// Paste a link from the clipboard, and play it if it's a valid URL.
document.getElementById("url-paste").addEventListener("click", async () => {
  const text = ((await window.movi.readClipboard()) || "").trim();
  if (!text) return showToast("Clipboard is empty");
  urlInput.value = text;
  if (/^https?:\/\//i.test(text)) {
    clearPlaylist();
    loadSrc(proxySrc(text));
    urlInput.blur();
  } else {
    urlInput.focus();
    showToast("Clipboard isn't a http(s) link");
  }
});

const pickFile = () => window.movi.openDialog();
dropzone.addEventListener("click", pickFile);
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    pickFile();
  }
});

// ---------- Drag & drop (anywhere) ----------
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("active");
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.remove("active");
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("active");
  document.body.classList.remove("dragging");
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) return;
  // Resolve to paths so they work in the playlist (and PiP). Multiple → playlist.
  const paths = files.map((f) => window.movi.pathForFile(f)).filter(Boolean);
  if (paths.length) {
    try { await window.movi.grant(paths); } catch {}
    openPathList(paths);
  } else {
    loadFile(files[0]); // no path available → single, zero-copy
  }
});

// Surface player errors instead of failing silently
player.addEventListener("error", (e) => {
  const msg = (e && e.detail && (e.detail.message || e.detail)) || "Couldn't play that file";
  showToast(String(msg));
});

// ---------- Wires from main ----------
window.movi.onLoadPaths(loadPaths);
window.movi.onFullscreen((on) => document.body.classList.toggle("osfs", on));

// ---------- Open-URL modal (works during playback; the welcome URL bar is hidden then) ----------
function playUrl(u) {
  u = (u || "").trim();
  if (!/^https?:\/\//i.test(u)) {
    showToast("Enter a full http(s):// link");
    return false;
  }
  clearPlaylist();
  loadSrc(proxySrc(u));
  return true;
}

const urlModal = document.getElementById("url-modal");
const modalUrlInput = document.getElementById("modal-url-input");

async function showUrlPrompt() {
  urlModal.hidden = false;
  try {
    const c = ((await window.movi.readClipboard()) || "").trim();
    if (/^https?:\/\//i.test(c)) modalUrlInput.value = c;
  } catch {}
  modalUrlInput.focus();
  modalUrlInput.select();
}
function hideUrlPrompt() {
  urlModal.hidden = true;
  modalUrlInput.value = "";
}

document.getElementById("url-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (playUrl(modalUrlInput.value)) hideUrlPrompt();
});
document.getElementById("url-modal-cancel").addEventListener("click", hideUrlPrompt);
document.getElementById("modal-url-paste").addEventListener("click", async () => {
  const text = ((await window.movi.readClipboard()) || "").trim();
  if (!text) return showToast("Clipboard is empty");
  modalUrlInput.value = text;
  modalUrlInput.focus();
});
urlModal.addEventListener("mousedown", (e) => {
  if (e.target === urlModal) hideUrlPrompt();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !urlModal.hidden) hideUrlPrompt();
});

// Menu "Open URL…" and Cmd/Ctrl+L. The keydown is captured before the player's
// own handler so it doesn't also toggle loop (its "l" case has no modifier guard).
window.movi.onFocusUrl(showUrlPrompt);
window.addEventListener(
  "keydown",
  (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showUrlPrompt();
    }
  },
  true
);

// Forward window key presses to the player so its shortcuts (space, arrows, f,
// m, l …) work anywhere — without the user having to click the player first.
// (Runs in the bubble phase, after the capture-phase PiP/URL intercepts above.)
window.addEventListener("keydown", (e) => {
  if (player.hidden) return; // only while a video is showing
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave menu/app shortcuts alone
  const ae = document.activeElement;
  if (ae && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(ae.tagName) || ae.isContentEditable)) return;
  if (e.composedPath().includes(player)) return; // player already received it
  const fwd = new KeyboardEvent("keydown", {
    key: e.key,
    code: e.code,
    shiftKey: e.shiftKey,
    repeat: e.repeat,
    bubbles: false,
    cancelable: true,
  });
  player.dispatchEvent(fwd);
  if (fwd.defaultPrevented) e.preventDefault();
});

// The player's shadow root is open, so patch desktop-only things into it.
function patchPlayerShadow(attempt = 0) {
  const sr = player.shadowRoot;
  if (!sr) {
    if (attempt < 20) setTimeout(() => patchPlayerShadow(attempt + 1), 100);
    return;
  }

  // macOS full-bleed: push the title below the traffic lights (no window strip).
  if (window.movi.platform === "darwin" && !sr.querySelector("#movi-desktop-patches")) {
    const style = document.createElement("style");
    style.id = "movi-desktop-patches";
    // Exclude audio-strip mode — there the player is a thin 56–78px bar, not a
    // full-bleed window, so there are no traffic lights to clear and the 46px
    // would shove the title down past the control row.
    style.textContent =
      ":host(:not(:fullscreen):not(.movi-audio-strip)) .movi-title-bar { padding-top: 46px; }";
    sr.appendChild(style);
  }

  // Document PiP doesn't render in Electron, so route the built-in PiP button
  // to our native always-on-top PiP window instead. Intercept in the capture
  // phase to pre-empt the element's own (no-op) Document-PiP handler.
  if (!sr.__moviPipHooked) {
    sr.__moviPipHooked = true;
    sr.addEventListener(
      "click",
      (e) => {
        const onPip = e.composedPath().some((el) => el.classList && el.classList.contains("movi-pip-btn"));
        if (!onPip) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        openPip();
      },
      true
    );
  }
}
patchPlayerShadow();

// ---------- Native Picture-in-Picture ----------
let pipWasPlaying = false;
function openPip() {
  const src = player.src;
  if (typeof src !== "string" || !src) {
    showToast("Picture-in-Picture isn't available for this source");
    return;
  }
  pipWasPlaying = !player.paused;
  window.movi.pipOpen({ src, time: player.currentTime || 0, playing: pipWasPlaying });
}

// The built-in "p" shortcut calls the element's Document PiP (dead in Electron).
// Intercept it in the capture phase (before the element's own keydown handler)
// and route to our native PiP instead.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "p" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.composedPath().includes(player)) return; // only when the player is focused
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPip();
  },
  true
);
window.movi.onPipActive(() => {
  try { player.pause(); } catch {}
});
window.movi.onPipClosed((state) => {
  const t = (state && state.time) || 0;
  const src = state && state.src;
  const resume = () => {
    if (t > 0) { try { player.currentTime = t; } catch {} }
    if (pipWasPlaying) { try { player.play(); } catch {} }
  };
  const apply = () => {
    if (src && src !== player.src) {
      // PiP switched to a different file — bring it back to the main window.
      // If it's a playlist item, stay in the playlist; otherwise it's a new
      // single track, so drop the old playlist.
      const idx = playlist.findIndex((p) => localSrc(p) === src);
      if (idx >= 0) {
        playlistIndex = idx;
        updateActiveItem();
      } else {
        clearPlaylist();
      }
      prime();
      player.src = src;
      let n = 0;
      const iv = setInterval(() => {
        if (++n > 100) return clearInterval(iv);
        if (player.duration > 0) { clearInterval(iv); resume(); }
      }, 100);
    } else {
      resume();
    }
  };
  // The window was hidden during PiP. Reloading before it's actually visible
  // leaves the player's snapshot-poster / deferred-load half-applied, so the
  // controls never re-enable. Wait until we're visible, then apply.
  if (document.visibilityState === "visible") {
    requestAnimationFrame(apply);
  } else {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onVis);
      requestAnimationFrame(apply);
    };
    const onVis = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVis);
    setTimeout(run, 800); // fallback if the event never arrives
  }
});

refreshRecents();
window.movi.ready();
