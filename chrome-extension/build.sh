#!/bin/bash
# Build chrome extension — copies only required dist files

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "Building movi-player dist..."
cd "$ROOT"
npm run build:ts

echo "Copying required files to extension..."
rm -rf "$DIR/dist"
mkdir -p "$DIR/dist"

# Only element.js (standalone bundle with everything) + WASM
cp "$ROOT/dist/element.js" "$DIR/dist/"

echo "Done! Extension size: $(du -sh "$DIR/dist" | cut -f1)"
echo "Load extension from: $DIR"
echo "  → chrome://extensions → Developer mode → Load unpacked"
