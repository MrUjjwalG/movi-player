import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";

const VIDEO_EXTS = [
  "mp4", "mkv", "webm", "mov", "avi", "flv", "wmv",
  "m4v", "3gp", "mpg", "mpeg", "m2ts", "hevc", "265",
];

let commandPanel: vscode.WebviewPanel | undefined;
let logChannel: vscode.OutputChannel | undefined;

function getLogChannel(): vscode.OutputChannel {
  if (!logChannel) logChannel = vscode.window.createOutputChannel("Movi Player");
  return logChannel;
}

// Settings forced ONLY for the duration of a Movi fullscreen (Zen Mode)
// session. Each is saved on enter and reverted on exit so the user's normal
// coding view is never polluted. zenMode.* keys are read at toggle time, so
// they're applied BEFORE toggling Zen Mode; the rest take effect immediately
// on write so they're applied after, keeping the toggle snappy.
const ZEN_OVERRIDES: Array<{ section: string; key: string; force: unknown }> = [
  { section: "zenMode", key: "centerLayout", force: false },
  { section: "breadcrumbs", key: "enabled", force: false },
  { section: "window", key: "commandCenter", force: false },
  { section: "workbench", key: "layoutControl.enabled", force: false },
  { section: "workbench", key: "editor.showTabs", force: "none" },
  { section: "workbench", key: "editor.editorActionsLocation", force: "hidden" },
  // activity bar + status bar are settings-driven (not just runtime UI),
  // so writing them goes through the same save/restore + cleanup pipeline
  // and survives a crash/close-while-in-fullscreen.
  { section: "workbench", key: "activityBar.location", force: "hidden" },
  { section: "workbench", key: "statusBar.visible", force: false },
];

const UNSET = Symbol("unset");
const savedZenValues = new Map<string, unknown | typeof UNSET>();
let inMoviFullscreen = false;

// Cross-platform wake lock — VS Code webviews block navigator.wakeLock via
// Permissions-Policy, so spawn an OS-level inhibitor process from the host
// instead. Held only while in Movi fullscreen so a backgrounded/idle
// VS Code doesn't inhibit sleep when the user isn't watching.
let wakeLockProcess: ChildProcess | undefined;

function acquireWakeLock(): void {
  if (wakeLockProcess && !wakeLockProcess.killed) return;
  try {
    if (process.platform === "darwin") {
      // -i blocks idle sleep; runs forever until killed.
      wakeLockProcess = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: false });
    } else if (process.platform === "linux") {
      // systemd-inhibit holds the inhibitor until the spawned command exits.
      wakeLockProcess = spawn(
        "systemd-inhibit",
        ["--what=idle:sleep", "--who=movi-player", "--why=Playing video", "sleep", "infinity"],
        { stdio: "ignore", detached: false }
      );
    } else if (process.platform === "win32") {
      // ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED kept alive
      // by an idle PowerShell loop; releases when the process exits.
      const ps = [
        "Add-Type -TypeDefinition '",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public class Sleep {",
        "  [DllImport(\"kernel32.dll\")]",
        "  public static extern uint SetThreadExecutionState(uint esFlags);",
        "}';",
        "[Sleep]::SetThreadExecutionState(0x80000003) | Out-Null;",
        "while ($true) { Start-Sleep -Seconds 60 }",
      ].join(" ");
      wakeLockProcess = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", detached: false });
    }
    wakeLockProcess?.on("error", () => { wakeLockProcess = undefined; });
    wakeLockProcess?.on("exit", () => { wakeLockProcess = undefined; });
  } catch {
    wakeLockProcess = undefined;
  }
}

function releaseWakeLock(): void {
  if (!wakeLockProcess) return;
  try { wakeLockProcess.kill(); } catch {}
  wakeLockProcess = undefined;
}

// Set true by movi.openInNewWindow just before openWith, consumed by
// resolveCustomEditor. Always force-cleared in a finally{} after openWith
// returns so a panel that didn't trigger resolveCustomEditor (e.g. a
// re-focus of an already-open editor) doesn't leak the flag onto the next
// normal open.
let pendingAux = false;

async function applyZenOverrides(filter: "zen" | "nonZen"): Promise<void> {
  for (const { section, key, force } of ZEN_OVERRIDES) {
    const isZen = section === "zenMode";
    if (filter === "zen" && !isZen) continue;
    if (filter === "nonZen" && isZen) continue;
    const cfg = vscode.workspace.getConfiguration(section);
    const inspected = cfg.inspect<unknown>(key);
    const id = `${section}.${key}`;
    savedZenValues.set(
      id,
      inspected?.globalValue !== undefined ? inspected.globalValue : UNSET
    );
    if (inspected?.globalValue !== force) {
      await cfg.update(key, force, vscode.ConfigurationTarget.Global);
    }
  }
}

async function restoreZenOverrides(): Promise<void> {
  for (const { section, key } of ZEN_OVERRIDES) {
    const id = `${section}.${key}`;
    if (!savedZenValues.has(id)) continue;
    const saved = savedZenValues.get(id);
    const value = saved === UNSET ? undefined : saved;
    const cfg = vscode.workspace.getConfiguration(section);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }
  savedZenValues.clear();
}

// Sidebar (Explorer), aux bar (Claude Code etc), bottom panel (terminal):
// one-way close on enter, no auto-restore on exit — VS Code doesn't expose
// visibility state to extensions so a blind toggle would OPEN bars that
// were already hidden. User reopens via Cmd+B (sidebar) / Cmd+J (terminal)
// / Cmd+Alt+B (aux bar) when needed.
const CLOSE_BAR_COMMANDS = [
  "workbench.action.closeSidebar",
  "workbench.action.closeAuxiliaryBar",
  "workbench.action.closePanel",
];

async function closeBars(): Promise<void> {
  for (const cmd of CLOSE_BAR_COMMANDS) {
    try {
      await vscode.commands.executeCommand(cmd);
    } catch {
      // Older VS Code versions may not expose every close command.
    }
  }
}

async function toggleMoviFullscreen(): Promise<void> {
  if (!inMoviFullscreen) {
    inMoviFullscreen = true;
    await applyZenOverrides("zen");
    await applyZenOverrides("nonZen");
    await closeBars();
    acquireWakeLock();
  } else {
    inMoviFullscreen = false;
    releaseWakeLock();
    await restoreZenOverrides();
  }
}

// Earlier builds wrote these globally and never reliably reverted them,
// leaving users with hidden tabs/breadcrumbs/etc in their regular editor.
// On activation, undo that pollution: only reset values still matching the
// exact forced value, so a user who genuinely set these is left alone.
async function cleanupPollutedSettings(): Promise<void> {
  for (const { section, key, force } of ZEN_OVERRIDES) {
    const cfg = vscode.workspace.getConfiguration(section);
    const inspected = cfg.inspect<unknown>(key);
    if (inspected?.globalValue === force) {
      await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
}

function appendLog(msg: { entry?: { level: string; text: string; t: number } }) {
  if (!msg.entry) return;
  const ch = getLogChannel();
  const d = new Date(msg.entry.t);
  const ts =
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0") + "." +
    String(d.getMilliseconds()).padStart(3, "0");
  ch.appendLine(`[${ts}] ${msg.entry.level.toUpperCase()} ${msg.entry.text}`);
}

export function activate(context: vscode.ExtensionContext) {
  cleanupPollutedSettings();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "movi.player",
      new MoviEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        // Allow the same video to be open in multiple panels at once so
        // "Play in New Window" can spawn a fresh aux-window panel without
        // stealing the existing main-window tab for the same URI.
        supportsMultipleEditorsPerDocument: true,
      }
    ),

    vscode.commands.registerCommand("movi.openPlayer", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Videos: VIDEO_EXTS },
        openLabel: "Play",
      });
      if (picked && picked[0]) {
        vscode.commands.executeCommand(
          "vscode.openWith",
          picked[0],
          "movi.player"
        );
      }
    }),

    vscode.commands.registerCommand(
      "movi.openCurrentFile",
      (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showWarningMessage("Movi: No file selected.");
          return;
        }
        vscode.commands.executeCommand("vscode.openWith", target, "movi.player");
      }
    ),

    vscode.commands.registerCommand(
      "movi.openToSide",
      (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showWarningMessage("Movi: No file selected.");
          return;
        }
        vscode.commands.executeCommand(
          "vscode.openWith",
          target,
          "movi.player",
          vscode.ViewColumn.Beside
        );
      }
    ),

    vscode.commands.registerCommand(
      "movi.openInNewWindow",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showWarningMessage("Movi: No file selected.");
          return;
        }
        // Flag this open before openWith so resolveCustomEditor (which fires
        // synchronously inside openWith) can mark its panel as an aux-window
        // panel and disable the fullscreen flow there.
        pendingAux = true;
        try {
          // ViewColumn.Beside forces a fresh panel even when the same video
          // is already open in the main window — prevents the existing tab
          // from being yanked into the aux window.
          await vscode.commands.executeCommand(
            "vscode.openWith",
            target,
            "movi.player",
            vscode.ViewColumn.Beside
          );
          await vscode.commands.executeCommand(
            "workbench.action.moveEditorToNewWindow"
          );
          try {
            await vscode.commands.executeCommand(
              "workbench.action.enableCompactAuxiliaryWindow"
            );
          } catch {
            // Older VS Code versions may not expose the compact-window command.
          }
        } finally {
          // Force-clear in case resolveCustomEditor never consumed it (e.g.
          // an already-open editor was just focused, not re-resolved).
          pendingAux = false;
        }
      }
    ),

    vscode.commands.registerCommand("movi.openUrl", async () => {
      const url = await vscode.window.showInputBox({
        prompt: "Enter video URL",
        placeHolder: "https://example.com/video.mp4",
      });
      if (url) openCommandPanelWithUrl(context, url);
    })
  );
}

class MoviDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class MoviEditorProvider
  implements vscode.CustomReadonlyEditorProvider<MoviDocument>
{
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): MoviDocument {
    return new MoviDocument(uri);
  }

  resolveCustomEditor(
    document: MoviDocument,
    panel: vscode.WebviewPanel
  ): void {
    const webviewRoot = vscode.Uri.joinPath(
      this.context.extensionUri,
      "webview"
    );
    const folders = vscode.workspace.workspaceFolders ?? [];
    const fileFolder = vscode.Uri.file(path.dirname(document.uri.fsPath));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot, fileFolder, ...folders.map((f) => f.uri)],
    };
    panel.webview.html = renderHtml(panel.webview, webviewRoot);
    panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "icons",
      "icon128.png"
    );

    const fsPath = document.uri.fsPath;
    const name = path.basename(fsPath);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(fsPath);
    } catch (e) {
      vscode.window.showErrorMessage(`Movi: cannot stat file ${name}`);
    }

    // If movi.openInNewWindow set the flag, this panel is the one about to
    // be moved to an auxiliary window — disable fullscreen there since Zen
    // Mode + chrome hides target the main window.
    const isAuxPanel = pendingAux;
    if (isAuxPanel) pendingAux = false;

    const sub = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
        if (isAuxPanel) {
          panel.webview.postMessage({ type: "disableFullscreen" });
        }
        if (!stat) return;
        panel.webview.postMessage({
          type: "loadStream",
          name,
          size: stat.size,
          mimeType: guessMime(fsPath),
        });
      } else if (msg?.type === "readChunk") {
        const { id, start, length } = msg;
        try {
          const buffer = await readFileRange(fsPath, start, length);
          panel.webview.postMessage({
            type: "chunkData",
            id,
            buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          panel.webview.postMessage({ type: "chunkError", id, error: message });
        }
      } else if (msg?.type === "fullscreen") {
        if (isAuxPanel) return;
        toggleMoviFullscreen();
      } else if (msg?.type === "log") {
        appendLog(msg);
      }
    });
    panel.onDidDispose(() => sub.dispose());
  }
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".3gp": "video/3gpp",
    ".hevc": "video/hevc",
    ".265": "video/hevc",
  };
  return map[ext] || "application/octet-stream";
}

async function readFileRange(
  filePath: string,
  start: number,
  length: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const end = start + length - 1;
    const stream = fs.createReadStream(filePath, { start, end });
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", reject);
  });
}

function openCommandPanelWithUrl(
  context: vscode.ExtensionContext,
  url: string
) {
  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, "webview");
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (commandPanel) {
    commandPanel.title = "Movi Player";
    commandPanel.reveal(vscode.ViewColumn.Active);
    commandPanel.webview.postMessage({ type: "loadUrl", url });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "moviPlayer",
    "Movi Player",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot, ...folders.map((f) => f.uri)],
    }
  );

  panel.webview.html = renderHtml(panel.webview, webviewRoot);
  panel.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "icons",
    "icon128.png"
  );

  const sub = panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "ready") {
      panel.webview.postMessage({ type: "loadUrl", url });
    } else if (msg?.type === "fullscreen") {
      vscode.commands.executeCommand("workbench.action.toggleZenMode");
    } else if (msg?.type === "log") {
      appendLog(msg);
    }
  });

  panel.onDidDispose(() => {
    sub.dispose();
    if (commandPanel === panel) commandPanel = undefined;
  });

  commandPanel = panel;
}

function renderHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
  const htmlPath = path.join(webviewRoot.fsPath, "player.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  const elementJs = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewRoot, "dist", "element.js")
  );
  const playerJs = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewRoot, "player.js")
  );

  const config = vscode.workspace.getConfiguration("movi");
  const settings = {
    ambientMode: config.get<boolean>("ambientMode", true),
    resume: config.get<boolean>("resume", true),
  };

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `media-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval' 'unsafe-eval' 'unsafe-inline'`,
    `connect-src ${webview.cspSource} https: data: blob:`,
    `worker-src ${webview.cspSource} blob:`,
    `child-src blob:`,
  ].join("; ");

  return html
    .replaceAll("%CSP%", csp)
    .replaceAll("%ELEMENT_JS%", elementJs.toString())
    .replaceAll("%PLAYER_JS%", playerJs.toString())
    .replaceAll("%SETTINGS%", JSON.stringify(settings))
    .replaceAll(
      "%PLAYER_ATTRS%",
      [
        "controls",
        "thumb",
        "fastseek",
        "showtitle",
        settings.ambientMode ? "ambientmode" : "",
        settings.resume ? "resume" : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
}

export async function deactivate(): Promise<void> {
  if (commandPanel) commandPanel.dispose();
  releaseWakeLock();
  if (inMoviFullscreen) {
    // Block here so VS Code's 5s deactivate window waits for settings to
    // actually be written back. A sync call returns a Promise but the host
    // shuts down before it resolves, leaving settings polluted.
    await restoreZenOverrides();
  }
}
