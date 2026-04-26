#!/bin/bash
# Build VS Code extension — compiles TS + copies player bundle into webview/dist
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "Building movi-player dist..."
cd "$ROOT"
npm run build:ts

echo "Copying element.js into webview/dist..."
rm -rf "$DIR/webview/dist"
mkdir -p "$DIR/webview/dist"
cp "$ROOT/dist/element.js" "$DIR/webview/dist/"

echo "Compiling extension TypeScript..."
cd "$DIR"
if [ ! -d node_modules ]; then
  npm install
fi
npm run compile

echo "Done! Webview size: $(du -sh "$DIR/webview" | cut -f1)"
echo "Run extension:"
echo "  → Open this folder in VS Code"
echo "  → Press F5 to launch Extension Development Host"
echo "  → In the new window, run command: 'Movi: Open Video File'"
