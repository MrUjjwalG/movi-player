/**
 * MoviPlayer desktop — Electron main process.
 *
 * Boots a localhost server that serves the renderer with COOP/COEP (so the
 * WASM demuxer gets SharedArrayBuffer), opens a window pointed at it, and
 * wires up file opening from three sources: the in-app dialog, drag & drop
 * (handled in the renderer), and OS "open with" / double-click (here).
 */
const { app, BrowserWindow, dialog, ipcMain, shell, Menu, clipboard, session } = require("electron");
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
    pipState = { src, time: 0 };
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
      titleBarOverlay: { color: "#0c0c11", symbolColor: "#cfcfe0", height: 40 },
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
    backgroundColor: "#0c0c11",
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
ipcMain.handle("dialog:open", () => openViaDialog());
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
let pipState = { src: null, time: 0 };

const pipSrcForPath = (p) =>
  "/_local/" + encodeURIComponent(path.basename(p)) + "?p=" + encodeURIComponent(p);

function openPip(src, time, playing) {
  if (!serverPort || !src) return;
  if (pipWindow) {
    pipWindow.focus();
    return;
  }
  // Leave fullscreen first (covers both the player's HTML fullscreen and the
  // OS green-button fullscreen) so PiP pops out as a floating window instead of
  // opening into the main window's fullscreen Space.
  if (mainWindow && mainWindow.isFullScreen()) {
    mainWindow.once("leave-full-screen", () => createPipWindow(src, time, playing));
    mainWindow.setFullScreen(false);
    return;
  }
  createPipWindow(src, time, playing);
}

function createPipWindow(src, time, playing) {
  pipState = { src, time: time || 0 };
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
  if (s.src) pipState = { src: s.src, time: s.time || 0 };
  else pipState.time = s.time || pipState.time;
});
ipcMain.on("pip:close", () => { if (pipWindow) pipWindow.close(); });
ipcMain.on("pip:open", (_e, payload) => openPip(payload?.src, payload?.time, payload?.playing));

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
