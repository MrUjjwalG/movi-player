/**
 * Push the site's icon set to the R2 bucket the worker serves it from.
 *
 * app/favicon*, app/apple-touch-icon.png and app/og-image.png are NOT served
 * out of the repo: worker.js routes those paths to the `ASSETS` binding
 * (bucket `movi-assets`) and answers with `immutable, max-age=31536000`. So
 * editing the files and deploying the worker changes nothing a visitor sees —
 * the bucket has to be written to as well, which is what this does. The
 * year-long cache is handled on the other side: every icon URL in the HTML
 * carries `?v=__BUILD_VERSION__`, which app:deploy stamps.
 *
 * Run it with `npm run app:upload:icons`. Overwrites whatever is there.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const TYPES = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Exactly the paths worker.js hands to handleStaticAsset. The R2 key is the
// URL path without its leading slash, so the file's own name is the key.
const FILES = [
  "favicon.svg",
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-192x192.png",
  "favicon-512x512.png",
  "apple-touch-icon.png",
  "og-image.png",
];

let failed = 0;
for (const name of FILES) {
  const file = path.join(repoRoot, "app", name);
  if (!existsSync(file)) {
    console.error(`✗ ${name} — not in app/`);
    failed++;
    continue;
  }
  const contentType = TYPES[path.extname(name)];
  try {
    execFileSync(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `movi-assets/${name}`,
        "--file",
        file,
        "--content-type",
        contentType,
        "--remote",
      ],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    console.log(`✓ ${name} → movi-assets/${name}`);
  } catch {
    console.error(`✗ ${name} — upload failed`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} of ${FILES.length} did not upload.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${FILES.length} uploaded. Deploy the worker so the new
?v= stamp goes out with the pages, or returning visitors keep the old icon
until their year-long cache entry expires.`);
}
