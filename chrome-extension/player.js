const params = new URLSearchParams(window.location.search);
const url = params.get("url");
const fileMode = params.has("file");

const overlay = document.getElementById("fileOverlay");
const dropZone = document.getElementById("dropZone");
const filePicker = document.getElementById("filePicker");

// Update tab title from metadata once media is loaded
customElements.whenDefined("movi-player").then(() => {
  const player = document.getElementById("player");
  player.addEventListener("loadeddata", () => {
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

if (url) {
  // URL mode — extract meaningful title from URL
  let name = decodeURIComponent(url.split("/").pop().split("?")[0]);
  // Remove extension
  name = name.replace(/\.[^.]+$/, "");
  // If name is empty or generic (manifest files), use parent path segment
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
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});
