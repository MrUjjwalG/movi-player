/**
 * MoviPlayer desktop — Electron main process.
 *
 * Boots a localhost server that serves the renderer with COOP/COEP (so the
 * WASM demuxer gets SharedArrayBuffer), opens a window pointed at it, and
 * wires up file opening from three sources: the in-app dialog, drag & drop
 * (handled in the renderer), and OS "open with" / double-click (here).
 */
const { app, BrowserWindow, dialog, ipcMain, shell, Menu, clipboard, session, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { createLocalServer } = require("./local-server");
const { buildMenu } = require("./menu");

// Cosmetic: localhost over http triggers Electron's dev security warning.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

// --- Codec switches (must precede app "ready") ---
// PlatformHEVCDecoderSupport: lets WebCodecs use the OS HEVC decoder.
// SharedArrayBuffer: belt-and-suspenders alongside the COOP/COEP headers.
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport,SharedArrayBuffer");

// Keep playback smooth when the window is unfocused or covered by another app.
// Chromium otherwise throttles timers / rAF and de-prioritises a backgrounded
// renderer, which stutters or stalls the video. (Pairs with
// webPreferences.backgroundThrottling: false below.)
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

// Extensions we treat as media when handed a bare path by the OS.
const MEDIA_EXT = new Set([
  ".mkv", ".mp4", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".mts",
  ".flv", ".wmv", ".hevc", ".h265", ".av1", ".ogv", ".mpg", ".mpeg", ".3gp",
  ".mka", ".m4b", ".opus", ".oga", ".flac", ".mp3", ".aac", ".ac3", ".eac3",
  ".dts", ".wav",
]);
const isMediaFile = (p) => MEDIA_EXT.has(path.extname(p || "").toLowerCase());

// Absolute paths the renderer's /_local endpoint is allowed to stream.
// Populated only when the user explicitly opens a file.
const allowedFiles = new Set();
const grantFile = (p) => allowedFiles.add(path.normalize(p));
const isLocalAllowed = (p) => allowedFiles.has(path.normalize(p));

// --- Recent files (persisted to userData; path-based opens only) ---
const RECENTS_MAX = 10;
const recentsFile = () => path.join(app.getPath("userData"), "recents.json");

function readRecents() {
  try {
    return JSON.parse(fs.readFileSync(recentsFile(), "utf8"));
  } catch {
    return [];
  }
}
function writeRecents(list) {
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    /* best-effort */
  }
}
function addRecent(p) {
  const abs = path.normalize(p);
  const list = readRecents().filter((e) => e.path !== abs);
  list.unshift({ path: abs, openedAt: Date.now() });
  writeRecents(list);
}
/** Decorate stored recents with current name/size/ext; drop missing files. */
function listRecents() {
  const out = [];
  for (const e of readRecents()) {
    try {
      const st = fs.statSync(e.path);
      out.push({
        path: e.path,
        name: path.basename(e.path),
        ext: path.extname(e.path).replace(/^\./, ""),
        size: st.size,
      });
    } catch {
      /* file moved/deleted → omit */
    }
  }
  return out;
}

let mainWindow = null;
let serverPort = 0;
let rendererReady = false;
const pendingPaths = []; // OS-open paths that arrived before the renderer was wired

/** Bring the whole app (not just the window) to the foreground — needed on
 *  macOS when a file is opened while the app is in the background. */
function foreground() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  app.focus({ steal: true });
}

/** Grant + hand a batch of media paths to the renderer (or queue them). */
function sendPaths(paths) {
  const media = (paths || []).filter(isMediaFile);
  if (!media.length) return;
  media.forEach(grantFile);
  media.forEach(addRecent);

  // PiP is the active player — load the file there instead of the main window.
  if (pipWindow) {
    const src = pipSrcForPath(media[0]);
    // New file, same viewer: the language and speed they picked carry over,
    // exactly as they would opening it in the main window. Only the position
    // starts again.
    pipState = { src, time: 0, settings: pipState.settings || null };
    pipWindow.webContents.send("pip:load", { src, time: 0 });
    pipWindow.focus();
    return;
  }

  // Window was closed (macOS keeps the app running) — recreate it. Queued
  // paths flush once the renderer signals ready. If the app isn't ready yet
  // (serverPort still 0), just queue; start() will create the window.
  if (!mainWindow) {
    pendingPaths.push(...media);
    if (serverPort) {
      createWindow();
      app.focus({ steal: true });
    }
    return;
  }

  if (rendererReady) {
    mainWindow.webContents.send("load-paths", media);
    foreground();
  } else {
    pendingPaths.push(...media);
  }
}

async function openViaDialog() {
  if (!mainWindow) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Open video or audio",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Video", extensions: ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts", "m2ts", "mts", "flv", "wmv", "hevc", "av1", "mpg", "mpeg", "ogv", "3gp"] },
      { name: "Audio", extensions: ["mka", "m4b", "opus", "oga", "flac", "mp3", "aac", "ac3", "eac3", "dts", "wav"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (canceled) return;
  sendPaths(filePaths);
}

// Per-OS window chrome: native traffic lights inset on macOS, an overlaid
// native control strip on Windows, and the standard frame on Linux.
function chromeOptions() {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#0a0f1e", symbolColor: "#c9d2e6", height: 40 },
    };
  }
  return {}; // Linux: keep the standard frame
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 680,
    minHeight: 460,
    backgroundColor: "#0a0f1e",
    title: "MoviPlayer",
    icon: process.platform === "linux" ? path.join(__dirname, "..", "build", "icon.png") : undefined,
    ...chromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Don't throttle timers/rendering when this window loses focus.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);

  // External links (Help menu, footer) open in the system browser. Anything
  // else — notably the Document Picture-in-Picture window (about:blank) — is
  // allowed; denying it was what broke the PiP button.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Let the renderer drop the macOS titlebar inset while in OS fullscreen.
  mainWindow.on("enter-full-screen", () => mainWindow.webContents.send("window-fullscreen", true));
  mainWindow.on("leave-full-screen", () => mainWindow.webContents.send("window-fullscreen", false));

  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
  });
}

// --- IPC from renderer ---
ipcMain.on("renderer-ready", () => {
  rendererReady = true;
  if (pendingPaths.length && mainWindow) {
    mainWindow.webContents.send("load-paths", pendingPaths.splice(0));
    foreground();
  }
});
// The player's own fullscreen button/F key routes here so it drives OS window
// fullscreen (matching the green button). The enter/leave-full-screen listeners
// above then send window-fullscreen back to sync the player UI.
ipcMain.on("window:toggle-fullscreen", () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});
ipcMain.handle("dialog:open", () => openViaDialog());

// --- Window follows the video, the way QuickTime Player does ---
//
// A video opens at its own size, scaled down to fit the screen when it is
// bigger, with the window's centre kept where it was. Resizing afterwards keeps
// the picture's shape, so there are no black bars to drag away. The welcome
// screen keeps the window's own minimum; a video may go smaller, down to what
// the controls still fit in.
const WELCOME_MIN = { width: 680, height: 460 };
const VIDEO_MIN_WIDTH = 400;
const SCREEN_FILL = 0.9;
let videoAspect = 0; // width / height of the picture being shown, or 0
let playlistExtra = 0; // px the open playlist panel adds beside the picture

function applyAspectLock() {
  if (!mainWindow) return;
  // Only the picture keeps its shape — the panel beside it is a fixed width.
  mainWindow.setAspectRatio(videoAspect || 0, { width: playlistExtra, height: 0 });
}

function fitWindowToVideo(width, height) {
  if (!mainWindow || !(width > 0) || !(height > 0)) return;
  videoAspect = width / height;
  // Smaller than the old minimum is fine for a picture (a portrait phone clip
  // is narrower than 680px at any sensible height), just not unusably small.
  const minH = Math.round(VIDEO_MIN_WIDTH / Math.max(videoAspect, 1));
  mainWindow.setMinimumSize(VIDEO_MIN_WIDTH + playlistExtra, Math.max(minH, 225));
  applyAspectLock();

  // A maximised or fullscreen window is a size the viewer chose for the whole
  // screen; leave it, and let the lock apply when they come back out of it.
  if (mainWindow.isFullScreen() || mainWindow.isMaximized()) return;

  const current = mainWindow.getContentBounds();
  const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
  const maxW = Math.floor(workArea.width * SCREEN_FILL) - playlistExtra;
  const maxH = Math.floor(workArea.height * SCREEN_FILL);
  const scale = Math.min(1, maxW / width, maxH / height);
  let w = Math.round(width * scale);
  let h = Math.round(height * scale);
  if (w < VIDEO_MIN_WIDTH) {
    h = Math.round(h * (VIDEO_MIN_WIDTH / w));
    w = VIDEO_MIN_WIDTH;
  }
  w += playlistExtra;
  if (Math.abs(w - current.width) <= 2 && Math.abs(h - current.height) <= 2) return;

  // Grow from the centre, then keep the whole window on screen.
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let x = Math.round(cx - w / 2);
  let y = Math.round(cy - h / 2);
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - w);
  y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - h);
  mainWindow.setContentBounds({ x, y, width: w, height: h }, process.platform === "darwin");
}

ipcMain.on("window:fit-video", (_e, size) => {
  fitWindowToVideo(Number(size && size.width), Number(size && size.height));
});
// No picture (an audio file, or back to nothing): the window is free again.
ipcMain.on("window:release-video", () => {
  videoAspect = 0;
  if (!mainWindow) return;
  mainWindow.setAspectRatio(0);
  mainWindow.setMinimumSize(WELCOME_MIN.width, WELCOME_MIN.height);
});
// The playlist panel sits beside the picture at a fixed width. Opening it
// widens the window by that much instead of squeezing the video, and closing
// it gives the width back.
ipcMain.on("window:playlist-panel", (_e, { open, width }) => {
  if (!mainWindow) return;
  const extra = open ? Math.max(0, Number(width) || 0) : 0;
  if (extra === playlistExtra) return;
  const delta = extra - playlistExtra;
  playlistExtra = extra;
  applyAspectLock();
  if (videoAspect && !mainWindow.isFullScreen() && !mainWindow.isMaximized()) {
    const b = mainWindow.getContentBounds();
    const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
    const w = b.width + delta;
    const x = Math.min(Math.max(b.x, workArea.x), workArea.x + workArea.width - w);
    const [, minH] = mainWindow.getMinimumSize();
    mainWindow.setMinimumSize(VIDEO_MIN_WIDTH + playlistExtra, minH);
    mainWindow.setContentBounds({ x, y: b.y, width: w, height: b.height }, process.platform === "darwin");
  }
});
ipcMain.handle("recents:get", () => listRecents());
ipcMain.handle("recents:clear", () => writeRecents([]));
ipcMain.on("recents:open", (_e, p) => sendPaths([p]));
ipcMain.handle("clipboard:read", () => clipboard.readText() || "");
ipcMain.handle("files:grant", (_e, paths) => {
  (paths || []).forEach((p) => {
    grantFile(p);
    addRecent(p);
  });
  return true;
});

// --- Picture-in-Picture: a separate always-on-top window playing the same
//     source. Electron doesn't render Document PiP, so we build our own. ---
let pipWindow = null;
// What the PiP window is currently playing, so we can hand it back on return.
let pipState = { src: null, time: 0, settings: null };

const pipSrcForPath = (p) =>
  "/_local/" + encodeURIComponent(path.basename(p)) + "?p=" + encodeURIComponent(p);

function openPip(src, time, playing, settings) {
  if (!serverPort || !src) return;
  if (pipWindow) {
    pipWindow.focus();
    return;
  }
  // Leave fullscreen first (covers both the player's HTML fullscreen and the
  // OS green-button fullscreen) so PiP pops out as a floating window instead of
  // opening into the main window's fullscreen Space.
  if (mainWindow && mainWindow.isFullScreen()) {
    mainWindow.once("leave-full-screen", () =>
      createPipWindow(src, time, playing, settings),
    );
    mainWindow.setFullScreen(false);
    return;
  }
  createPipWindow(src, time, playing, settings);
}

function createPipWindow(src, time, playing, settings) {
  pipState = { src, time: time || 0, settings: settings || null };
  pipWindow = new BrowserWindow({
    width: 480,
    height: 270,
    minWidth: 240,
    minHeight: 135,
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    fullscreenable: true, // let the player's fullscreen button work
    backgroundColor: "#000",
    title: "MoviPlayer — Picture in Picture",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  pipWindow.setAlwaysOnTop(true, "floating");
  pipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const u = new URL(`http://127.0.0.1:${serverPort}/pip.html`);
  u.searchParams.set("src", src);
  u.searchParams.set("t", String(time || 0));
  if (playing) u.searchParams.set("playing", "1");
  // Audio language, captions, volume, speed — see renderer/handoff.js. Rides
  // the URL alongside the source rather than arriving over IPC afterwards, so
  // it is in hand before the PiP player opens the file and picks its own.
  if (settings) {
    try {
      u.searchParams.set("s", JSON.stringify(settings));
    } catch {}
  }
  pipWindow.loadURL(u.toString());

  pipWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  pipWindow.on("closed", () => {
    pipWindow = null;
    if (mainWindow) {
      mainWindow.show();
      if (process.platform === "darwin" && app.dock) app.dock.show();
      mainWindow.focus();
      mainWindow.webContents.send("pip:closed", pipState);
    }
  });

  // The PiP window is now the active player — pause + hide the main window.
  if (mainWindow) {
    mainWindow.webContents.send("pip:active");
    mainWindow.hide();
  }
}

// PiP reports its current source + position so we can resume from it on return.
ipcMain.on("pip:state", (_e, s) => {
  if (!s) return;
  if (s.src) {
    pipState = { src: s.src, time: s.time || 0, settings: pipState.settings || null };
  } else {
    pipState.time = s.time || pipState.time;
  }
  // Either way the settings are the PiP window's own answer, and they are what
  // the main window puts back on itself when the float closes.
  if (s.settings) pipState.settings = s.settings;
});
ipcMain.on("pip:close", () => { if (pipWindow) pipWindow.close(); });
ipcMain.on("pip:open", (_e, payload) =>
  openPip(payload?.src, payload?.time, payload?.playing, payload?.settings),
);

// --- Single-instance: route a second launch (with a file arg) to us ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    sendPaths(argv.slice(1).filter(isMediaFile));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS delivers "open with" via this event — once PER FILE, so opening
  // several files at once fires several events in quick succession. Batch them
  // so they become a single playlist instead of rapidly replacing each other
  // (which raced the decoder and errored).
  let openFileBatch = [];
  let openFileTimer = null;
  app.on("open-file", (e, p) => {
    e.preventDefault();
    openFileBatch.push(p);
    clearTimeout(openFileTimer);
    openFileTimer = setTimeout(() => {
      const batch = openFileBatch;
      openFileBatch = [];
      sendPaths(batch);
    }, 150);
  });

  app.whenReady().then(async () => {
    // The renderer only ever loads our own bundled content from 127.0.0.1, so
    // grant its permission checks/requests. The key one is "media": without it
    // Chromium hides audio output device ids/labels (enumerateDevices returns
    // blanks), so the Audio Output menu would only ever show "System Default".
    // Granting the CHECK is enough to expose labelled devices — we never call
    // getUserMedia, so the macOS microphone (TCC) prompt never appears.
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) =>
      cb(true),
    );

    const server = createLocalServer({ rendererDir: RENDERER_DIR, isLocalAllowed });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = server.address().port;

    createWindow();
    Menu.setApplicationMenu(
      buildMenu({
        onOpen: openViaDialog,
        onOpenUrl: () => mainWindow && mainWindow.webContents.send("focus-url"),
      })
    );

    // First-launch file argument (Windows/Linux double-click / "open with").
    sendPaths(process.argv.slice(1).filter(isMediaFile));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
