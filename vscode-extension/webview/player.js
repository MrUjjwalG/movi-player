const vscode = acquireVsCodeApi();

// Wire log buffer to extension Output channel
if (typeof window.__moviSetLogForward === "function") {
  window.__moviSetLogForward((entry) => {
    try { vscode.postMessage({ type: "log", entry }); } catch {}
  });
}

// Enable verbose logging in movi-player so fullscreen + decoder paths trace
import("./dist/element.js").then((mod) => {
  try {
    if (mod.Logger && mod.LogLevel) {
      mod.Logger.setLevel(mod.LogLevel.DEBUG);
      console.info("[Movi] Logger set to DEBUG");
    }
  } catch (e) { console.warn("[Movi] Could not enable Logger:", e); }
}).catch(() => {});

// Surface fullscreen API behavior so we can see WHY clicks fail
document.addEventListener("fullscreenchange", () => {
  console.info("[Movi] fullscreenchange — element:", document.fullscreenElement && document.fullscreenElement.tagName);
});
document.addEventListener("fullscreenerror", (e) => {
  console.error("[Movi] fullscreenerror:", e.type, "target:", e.target && e.target.tagName);
});

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
  // Hide fullscreen + PiP buttons (not supported in VS Code webviews) and
  // remove their entries from the right-click context menu. Inject into
  // shadow DOM since regular page CSS can't reach inside it.
  function hideUnsupported() {
    if (!player.shadowRoot) return;
    if (player.shadowRoot.getElementById("movi-vscode-hide")) return;
    const style = document.createElement("style");
    style.id = "movi-vscode-hide";
    // VS Code webview top-level frame: Permissions-Policy denies both
    // fullscreen and PiP. PiP button is hidden entirely. Fullscreen button
    // stays visible (familiar UI) but disabled — clicking does nothing.
    style.textContent = `
      .movi-pip-btn,
      .movi-context-menu-item[data-action="pip"] { display: none !important; }

      .movi-fullscreen-btn {
        opacity: 0.4 !important;
        cursor: not-allowed !important;
        pointer-events: none !important;
      }
      .movi-context-menu-item[data-action="fullscreen"] {
        opacity: 0.4 !important;
        pointer-events: none !important;
        cursor: not-allowed !important;
      }
    `;
    player.shadowRoot.appendChild(style);
  }
  hideUnsupported();
  // Re-apply after first frame in case shadow root populates async
  setTimeout(hideUnsupported, 0);
  setTimeout(hideUnsupported, 500);
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
