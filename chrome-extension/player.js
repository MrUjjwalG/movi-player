const params = new URLSearchParams(window.location.search);
const url = params.get("url");

const overlay = document.getElementById("fileOverlay");
const dropZone = document.getElementById("dropZone");
const filePicker = document.getElementById("filePicker");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingName = document.getElementById("loadingName");

// Detect whether the user has enabled "Allow access to file URLs" for this
// extension. When enabled, we let Chrome handle file drops natively — it
// navigates the tab to the file:// URL, our content script overlay takes over,
// and the user gets a bookmarkable URL after clicking "Play in Movi".
let fileAccessEnabled = false;
try {
  chrome.extension.isAllowedFileSchemeAccess().then((allowed) => {
    fileAccessEnabled = !!allowed;
  });
} catch {}

function showLoading(name) {
  if (loadingName) loadingName.textContent = name || "";
  loadingOverlay.classList.remove("hidden");
}
function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

// Update tab title from metadata once media is loaded
customElements.whenDefined("movi-player").then(() => {
  const player = document.getElementById("player");
  player.addEventListener("loadeddata", () => {
    hideLoading();
    const title = player.title;
    if (title) document.title = title + " — Movi Player";
  });
});

function loadFile(file) {
  overlay.classList.add("hidden");
  document.title = file.name + " — Movi Player";
  customElements.whenDefined("movi-player").then(() => {
    const player = document.getElementById("player");
    player.src = file;
  });
}

function filenameFromPath(path) {
  try {
    const decoded = decodeURIComponent(path.split("/").pop().split("?")[0].split("#")[0]);
    return decoded || "video";
  } catch {
    return "video";
  }
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
    // Wrap blob as File so MoviElement uses its FileSource adapter (chunked disk reads)
    const file = new File([blob], name, { type: blob.type || "video/mp4" });
    loadFile(file);
  } catch (err) {
    console.error("[Movi] Failed to load file URL:", err);
    hideLoading();
    showFileAccessError(fileUrl);
  }
}

if (url) {
  if (url.startsWith("file://")) {
    // Local file — fetch via extension page (requires "Allow access to file URLs")
    const name = filenameFromPath(url).replace(/\.[^.]+$/, "");
    document.title = (name || "Video") + " — Movi Player";
    loadFileUrl(url);
  } else {
    // Remote URL — extract meaningful title from URL
    let name = decodeURIComponent(url.split("/").pop().split("?")[0]);
    name = name.replace(/\.[^.]+$/, "");
    if (!name || /^(index|master|playlist)$/i.test(name)) {
      try {
        const segments = new URL(url).pathname.split("/").filter(s => s && !s.includes("."));
        if (segments.length > 0) name = decodeURIComponent(segments[segments.length - 1]).replace(/[-_]/g, " ");
      } catch {}
    }
    document.title = (name || "Video") + " — Movi Player";
    customElements.whenDefined("movi-player").then(() => {
      document.getElementById("player").src = url;
    });
  }
} else {
  // File mode — show overlay
  overlay.classList.remove("hidden");
}

// File picker button
filePicker.addEventListener("change", (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

// Drag and drop — entire page
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  overlay.classList.remove("hidden");
  dropZone.classList.add("dragover");
});

document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    dropZone.classList.remove("dragover");
  }
});

document.addEventListener("drop", (e) => {
  dropZone.classList.remove("dragover");

  // If the user has "Allow access to file URLs" enabled, let Chrome handle
  // the drop natively: it will open the file:// URL (often in a new tab),
  // where our content script's overlay takes over and the user lands in
  // Movi with a bookmarkable ?url=file:///... query parameter.
  // Close this empty player tab so the user is left only with the file:// one.
  if (fileAccessEnabled && e.dataTransfer.files.length > 0) {
    // Don't preventDefault — let Chrome route the file through its native viewer.
    // If Chrome navigates this same tab, the navigation supersedes window.close().
    // If Chrome opens a new tab, window.close() removes this dangling one.
    setTimeout(() => window.close(), 200);
    return;
  }

  // Fallback: load via File object directly (works without file access)
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// Forward document keyboard events to player
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
  const player = document.getElementById("player");
  if (!player || !player.shadowRoot) return;
  if (document.activeElement === player || player.contains(e.target)) return;
  player.dispatchEvent(new KeyboardEvent("keydown", {
    key: e.key, code: e.code, keyCode: e.keyCode,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
    bubbles: true, cancelable: true
  }));
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
    e.preventDefault();
  }
});
