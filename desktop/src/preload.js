/**
 * Preload bridge. Exposes a tiny, audited surface to the renderer — no Node,
 * no ipcRenderer leakage. Runs with context isolation on.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("movi", {
  platform: process.platform,

  // Tell main we've wired our listeners and the player is defined; flushes
  // any files the OS asked us to open before we were ready.
  ready: () => ipcRenderer.send("renderer-ready"),

  // Open the native file dialog. Result comes back asynchronously via onLoadPaths.
  openDialog: () => ipcRenderer.invoke("dialog:open"),

  // Files to load (from dialog or OS "open with").
  onLoadPaths: (cb) => ipcRenderer.on("load-paths", (_e, paths) => cb(paths)),

  // Menu "Open URL…" asks the renderer to focus its URL field.
  onFocusUrl: (cb) => ipcRenderer.on("focus-url", () => cb()),

  // OS window fullscreen toggled (used to drop the macOS titlebar inset AND to
  // sync the player's own fullscreen UI — see renderer).
  onFullscreen: (cb) => ipcRenderer.on("window-fullscreen", (_e, on) => cb(on)),

  // Toggle the OS window fullscreen. The player's own fullscreen button / F key /
  // double-click routes here so it drives the SAME OS fullscreen as the macOS
  // green button, instead of a separate HTML element-fullscreen the two paths
  // would fight over.
  toggleFullscreen: () => ipcRenderer.send("window:toggle-fullscreen"),

  // Recent files (path-based opens only).
  getRecents: () => ipcRenderer.invoke("recents:get"),
  openRecent: (p) => ipcRenderer.send("recents:open", p),
  clearRecents: () => ipcRenderer.invoke("recents:clear"),

  // Resolve a dropped File to its absolute path (Electron's File.path successor).
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
  // Read the system clipboard (for the "paste link" button). Done in the main
  // process — the clipboard module isn't available in a sandboxed preload.
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  // Allow-list paths for the /_local endpoint (e.g. dragged files).
  grant: (paths) => ipcRenderer.invoke("files:grant", paths),

  // Picture-in-Picture (main window side).
  pipOpen: (payload) => ipcRenderer.send("pip:open", payload),
  onPipActive: (cb) => ipcRenderer.on("pip:active", () => cb()),
  onPipClosed: (cb) => ipcRenderer.on("pip:closed", (_e, state) => cb(state)),
  // Picture-in-Picture (PiP window side).
  pipReportState: (src, time) => ipcRenderer.send("pip:state", { src, time }),
  onPipLoad: (cb) => ipcRenderer.on("pip:load", (_e, d) => cb(d)),
  pipClose: () => ipcRenderer.send("pip:close"),
});
