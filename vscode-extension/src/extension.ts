import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

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
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "movi.player",
      new MoviEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
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

    const sub = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
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

export function deactivate() {
  if (commandPanel) commandPanel.dispose();
}
