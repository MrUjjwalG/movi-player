/**
 * Copies build artifacts from the repo root into the desktop app:
 *   dist/element.js          → renderer/vendor/element.js   (the player bundle)
 *   app/favicon-512x512.png  → build/icon.png               (app icon, if absent)
 *
 * The player bundle is NOT auto-built here — dist/ is produced by the repo's
 * own `npm run build:ts`. If it's missing we stop with a clear message rather
 * than silently shipping a broken app.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import png2icons from "png2icons";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..");

const elementSrc = resolve(repoRoot, "dist", "element.js");
const elementDst = resolve(desktopDir, "renderer", "vendor", "element.js");
const iconSrc = resolve(repoRoot, "app", "favicon-512x512.png");
const iconDst = resolve(desktopDir, "build", "icon.png");

if (!existsSync(elementSrc)) {
  console.error(
    "\n✗ dist/element.js not found.\n" +
      "  Build the player bundle first from the repo root:\n" +
      "    npm run build:ts        (or full: npm run build)\n"
  );
  process.exit(1);
}

await mkdir(dirname(elementDst), { recursive: true });
await copyFile(elementSrc, elementDst);
console.log("✓ element.js → renderer/vendor/element.js");

if (existsSync(iconSrc) && !existsSync(iconDst)) {
  await mkdir(dirname(iconDst), { recursive: true });
  await copyFile(iconSrc, iconDst);
  console.log("✓ icon.png → build/icon.png  (512px; swap in a 1024px source for sharper installer icons)");
}

// Generate .icns (macOS) and .ico (Windows) from the png — pure JS, so it runs
// on any build machine (mac/win/linux CI). Linux uses the png directly. These
// back both the app icon and the Finder/Explorer document-type icons.
if (existsSync(iconDst)) {
  const png = readFileSync(iconDst);
  writeFileSync(resolve(desktopDir, "build", "icon.icns"), png2icons.createICNS(png, png2icons.BILINEAR, 0));
  writeFileSync(resolve(desktopDir, "build", "icon.ico"), png2icons.createICO(png, png2icons.BILINEAR, 0, false));
  console.log("✓ icon.icns + icon.ico → build/  (cross-platform icons)");
}

console.log("✓ assets synced");
