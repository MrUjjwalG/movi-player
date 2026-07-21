// Builds the framework wrappers into the main package's dist as subpath entries:
//   movi-player/react   ← packages/react/index.tsx      (React.createElement, no JSX)
//   movi-player/vue     ← packages/vue/index.ts         (h() render fn)
//   movi-player/svelte  ← packages/svelte/MoviPlayer.svelte (shipped as source)
//
// react/vue are transpiled with esbuild (types stripped; react/vue/movi-player
// stay as external imports the consumer resolves). Their .tsx/.ts source is
// copied alongside as the `types` target — TypeScript reads it directly and the
// consumer already has the framework types + movi-player/element (self-ref).
// Svelte components are distributed as source; the consumer's compiler builds it.
import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

const dirs = ["dist/react", "dist/vue", "dist/svelte"];
for (const d of dirs) mkdirSync(d, { recursive: true });

async function transpile(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: false, // single file, only external imports — leave them as-is
    format: "esm",
    target: "es2020",
    logLevel: "warning",
  });
}

await transpile("packages/react/index.tsx", "dist/react/index.js");
await transpile("packages/vue/index.ts", "dist/vue/index.js");

// Source doubles as the type surface (see header note).
copyFileSync("packages/react/index.tsx", "dist/react/index.tsx");
copyFileSync("packages/vue/index.ts", "dist/vue/index.ts");
copyFileSync("packages/svelte/MoviPlayer.svelte", "dist/svelte/MoviPlayer.svelte");

console.log("[wrappers] react + vue transpiled, svelte copied → dist/{react,vue,svelte}");
