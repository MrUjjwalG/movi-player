import * as vscode from "vscode";

interface ActionNode {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  tooltip?: string;
  command?: string;
  children?: ActionNode[];
}

const SECTIONS: ActionNode[] = [
  {
    id: "local",
    label: "Local Files",
    icon: "folder",
    children: [
      {
        id: "local.open",
        label: "Open Video File",
        icon: "play-circle",
        tooltip: "Pick a video file and play it in the active editor",
        command: "movi.openPlayer",
      },
      {
        id: "local.openSide",
        label: "Open to the Side",
        icon: "split-horizontal",
        tooltip: "Pick a video file and play it beside your code",
        command: "movi.openFileToSide",
      },
      {
        id: "local.openWindow",
        label: "Open in New Window",
        icon: "multiple-windows",
        tooltip: "Pick a video file and play it in a new VS Code window",
        command: "movi.openFileInNewWindow",
      },
    ],
  },
  {
    id: "url",
    label: "Remote URLs",
    icon: "link",
    children: [
      {
        id: "url.open",
        label: "Open Video from URL",
        icon: "globe",
        tooltip: "Stream a remote video URL through the extension host (no CORS)",
        command: "movi.openUrl",
      },
      {
        id: "url.openSide",
        label: "Open URL to the Side",
        icon: "split-horizontal",
        tooltip: "Stream a remote URL beside the active editor",
        command: "movi.openUrlToSide",
      },
      {
        id: "url.openWindow",
        label: "Open URL in New Window",
        icon: "multiple-windows",
        tooltip: "Stream a remote URL in a new VS Code window",
        command: "movi.openUrlInNewWindow",
      },
    ],
  },
  {
    id: "current",
    label: "Current Editor",
    icon: "file",
    children: [
      {
        id: "current.play",
        label: "Play Active File",
        icon: "play",
        tooltip: "Open the active editor's file in Movi Player",
        command: "movi.openCurrentFile",
      },
    ],
  },
];

export class MoviActionsProvider implements vscode.TreeDataProvider<ActionNode> {
  getTreeItem(element: ActionNode): vscode.TreeItem {
    const isLeaf = !element.children || element.children.length === 0;
    const item = new vscode.TreeItem(
      element.label,
      isLeaf
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = element.id;
    if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
    if (element.tooltip) item.tooltip = element.tooltip;
    if (element.description) item.description = element.description;
    if (element.command) {
      item.command = {
        command: element.command,
        title: element.label,
      };
    }
    item.contextValue = isLeaf ? "moviAction" : "moviSection";
    return item;
  }

  getChildren(element?: ActionNode): ActionNode[] {
    return element ? element.children ?? [] : SECTIONS;
  }
}
