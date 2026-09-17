#!/bin/bash
# Build the Firefox add-on.
#
# Firefox and Chrome ship the SAME add-on: content script, player page,
# icons and the movi-player bundle all live in chrome-extension/ and are copied
# in here verbatim, so there is exactly one copy of the UI to maintain. Only
# manifest.json differs (Gecko needs an add-on id, an event-page background and
# no COOP/COEP keys) — and that is the one file this script never touches.
#
# Everything copied in is gitignored; `git status` stays clean after a build.

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
SRC="$ROOT/chrome-extension"

# Shared files the add-on needs, copied from the Chrome extension.
SHARED="background.js content.js content.css marker.js player.html player.js"

# SKIP_BUILD=1 lets the release orchestrator build the player once and reuse it
# across every target instead of rebuilding here.
if [ -z "$SKIP_BUILD" ]; then
  echo "Building movi-player dist..."
  cd "$ROOT"
  npm run build:ts
else
  echo "Reusing existing dist/element.slim.js (SKIP_BUILD set)"
fi

for f in element.slim.js movi.wasm; do
  if [ ! -f "$ROOT/dist/$f" ]; then
    echo "✗ dist/$f not found — run 'npm run build:ts' first" >&2
    exit 1
  fi
done

echo "Copying shared files from chrome-extension/..."
rm -rf "$DIR/dist" "$DIR/icons" "$DIR/fonts"
mkdir -p "$DIR/dist" "$DIR/icons" "$DIR/fonts"

for f in $SHARED; do
  cp "$SRC/$f" "$DIR/$f"
done
cp "$SRC"/icons/*.png "$SRC"/icons/*.svg "$DIR/icons/"
cp "$SRC"/fonts/*.woff2 "$DIR/fonts/"
# The slim bundle plus its engine — see the note in chrome-extension/build.sh.
# AMO refuses a JS file over 5MB; the all-in-one build is 11.8MB.
cp "$ROOT/dist/element.slim.js" "$ROOT/dist/movi.wasm" "$DIR/dist/"

echo "Done! Add-on size: $(du -sh "$DIR/dist" | cut -f1)"
echo "Load add-on from: $DIR"
echo "  → about:debugging#/runtime/this-firefox → Load Temporary Add-on → manifest.json"
