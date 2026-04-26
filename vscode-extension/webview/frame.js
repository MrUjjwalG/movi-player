const vscode = acquireVsCodeApi();

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingName = document.getElementById("loadingName");

function showLoading(name) {
  if (loadingName) loadingName.textContent = name || "";
  loadingOverlay.classList.remove("hidden");
}
function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

customElements.whenDefined("movi-player").then(() => {
  const player = document.getElementById("player");
  player.addEventListener("loadeddata", () => {
    hideLoading();
    const title = player.title;
    if (title) document.title = title + " — Movi Player";
  });
});

async function loadFromUrl(url, name) {
  showLoading(name || "");
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const blob = await response.blob();
    const file = new File([blob], name || "video", {
      type: blob.type || "video/mp4",
    });
    if (name) document.title = name + " — Movi Player";
    customElements.whenDefined("movi-player").then(() => {
      document.getElementById("player").src = file;
    });
  } catch (err) {
    console.error("[Movi] Failed to load:", err);
    hideLoading();
  }
}

function loadRemoteUrl(url) {
  const name = decodeURIComponent(url.split("/").pop().split("?")[0]).replace(/\.[^.]+$/, "");
  if (name) document.title = name + " — Movi Player";
  customElements.whenDefined("movi-player").then(() => {
    document.getElementById("player").src = url;
  });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "loadFile") {
    loadFromUrl(msg.url, msg.name);
  } else if (msg.type === "loadUrl") {
    loadRemoteUrl(msg.url);
  }
});

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

vscode.postMessage({ type: "ready" });
