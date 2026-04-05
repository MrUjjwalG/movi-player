#!/bin/bash
# Build chrome extension — copies dist from main project

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "Building movi-player dist..."
cd "$ROOT"
npm run build:ts

echo "Copying dist to extension..."
rm -rf "$DIR/dist"
cp -r "$ROOT/dist" "$DIR/dist"

echo "Done! Load extension from: $DIR"
echo "  → chrome://extensions → Developer mode → Load unpacked"
