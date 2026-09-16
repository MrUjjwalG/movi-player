/**
 * Build script for standalone modular bundles
 * Builds each entry point separately to avoid shared chunks
 *
 * Ten bundles come out of here — five entries in two formats — and each one is
 * an 11 MB rollup put through five terser passes, so the run is minutes of
 * pure CPU and nothing about it is sequential by nature. It runs as a pool
 * (MOVI_JOBS), and it can be narrowed to the one bundle you are actually
 * iterating on (MOVI_ENTRY / MOVI_FORMAT) instead of rebuilding the other
 * nine to look at one.
 *
 *   MOVI_ENTRY=element.slim MOVI_FORMAT=es   just the slim ESM bundle
 *   MOVI_JOBS=1                              back to one at a time
 *   MOVI_VERBOSE=1                           vite's own per-build chatter
 *   MOVI_NO_HARDEN=1                         skip terser (diagnostic builds)
 *
 * Declarations are NOT built here. `tsc` runs ahead of this script in
 * `build:ts` with `declaration: true` and emits every .d.ts — and .d.ts.map —
 * into the same dist. vite-plugin-dts used to regenerate them on top, which
 * cost a slow type pass per entry for a byte-for-byte equivalent result, made
 * the entries unsafe to run in parallel (they write each other's shared
 * transitive declarations), and got the package's own entry wrong: with
 * `insertTypesEntry` every entry writes dist/index.d.ts, so the LAST one built
 * won and `"types": "dist/index.d.ts"` resolved to the SLIM element's types
 * rather than the index's.
 */

import { build } from 'vite';
import { resolve } from 'path';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { cpus } from 'os';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Bake the package version into the bundle so it can be read at runtime
// (MoviElement.version / VERSION export), jQuery-style.
const PKG_VERSION = JSON.parse(
  readFileSync(resolve(rootDir, 'package.json'), 'utf8'),
).version;

/** `a,b` → `["a","b"]`; empty/unset → `[]`, which every filter reads as "all". */
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The formats, and what each one is called on disk.
 *
 * `iife` is the one a CDN's copy-paste snippet can actually run. A plain
 * `<script src="...">` cannot load an ES module, and this package is ESM-only
 * — so jsDelivr, which falls back to `main` and prints a plain script tag for
 * its "Default" install, was handing people a line that throws. The `.global`
 * build registers <movi-player> on load with no import anywhere, which is the
 * whole job for an element; `jsdelivr`/`unpkg` in package.json point at it.
 *
 * Only the entries that ARE a browser drop-in get one — building the demuxer
 * or the index barrel as a global is two more multi-megabyte bundles nobody
 * can use, since the thing you would want from them is the exports an IIFE
 * does not give you.
 */
const ALL_FORMATS = ['es', 'cjs', 'iife'];
const FORMAT_EXT = { es: 'js', cjs: 'cjs', iife: 'global.js' };
const outFile = (entry, format) => `dist/${entry.name}.${FORMAT_EXT[format]}`;

const ONLY_ENTRIES = list(process.env.MOVI_ENTRY);
const ONLY_FORMATS = list(process.env.MOVI_FORMAT);
const VERBOSE = process.env.MOVI_VERBOSE === '1';
/* Each job holds a multi-megabyte rollup AST and a terser pass on top of it,
   so this is bounded by memory long before it is bounded by cores. Four is
   comfortable on an 8 GB machine; raise it with MOVI_JOBS if yours has room. */
const JOBS = Math.max(
  1,
  Number(process.env.MOVI_JOBS) || Math.min(4, Math.max(1, cpus().length - 2)),
);

const entries = [
  { name: 'demuxer', path: 'src/demuxer.ts' },
  { name: 'player', path: 'src/player.ts' },
  { name: 'element', path: 'src/element.ts', global: true },
  { name: 'index', path: 'src/index.ts' },
  // Slim build: same <movi-player>, but the WASM ships as a separate
  // movi-slim.wasm (streamed) instead of embedded, and playback auto-falls back
  // to native <video> when that WASM isn't available. `slim: true` swaps the
  // WASM glue via alias and flips the __MOVI_SLIM__ define below.
  { name: 'element.slim', path: 'src/element-slim.ts', slim: true, global: true },
];


// Rewrites every console.log/info/warn/error/debug call site to
// globalThis.__movilog?.<level>(...). We do this BEFORE terser runs:
// terser's drop_console only matches the literal console.* property
// path, so once rewritten the calls survive minification and reach
// the on-page dev console panel at runtime (see app/index.html).
//
// Lives as a Rollup plugin (renderChunk) so it sees the merged bundle
// after tree-shaking but before minification.
const movilogRewritePlugin = () => ({
  name: 'movilog-rewrite',
  renderChunk(code) {
    if (!/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(code)) return null;
    const out = code.replace(
      /\bconsole\.(log|info|warn|error|debug)(\s*)\(/g,
      'globalThis.__movilog?.$1$2(',
    );
    return { code: out, map: null };
  },
});

const terserConfig = {
  compress: {
    drop_console: true,
    drop_debugger: true,
    // Five passes is the shipped setting. It is also most of this script's
    // wall clock, so MOVI_TERSER_PASSES lowers it for a build you are only
    // going to load once — the output is a little larger and otherwise the
    // same code.
    passes: Number(process.env.MOVI_TERSER_PASSES) || 5,
    unsafe: false,
    unsafe_comps: false,
    unsafe_math: false,
    unsafe_methods: false,
    unsafe_proto: false,
    unsafe_regexp: false,
    unsafe_undefined: false,
    dead_code: true,
    unused: true,
    collapse_vars: true,
    evaluate: true,
    reduce_vars: true,
    inline: 2,
    keep_infinity: false,
  },
  mangle: {
    toplevel: false,
    eval: false,
    keep_classnames: true,
    keep_fnames: false,
    reserved: [
      'Movi',
      'Module',
      'FS',
      'HEAP',
      'HEAPU8',
      'HEAP32',
      'HEAPF64',
      'createMoviModule',
      'startsWith',
      'endsWith',
      'locateFile',
      'wasmBinary',
    ],
  },
  format: {
    comments: false,
    beautify: false,
    ascii_only: false,
  },
};

async function buildEntry(entry, format) {
  const formatExt = FORMAT_EXT[format];
  const started = Date.now();

  await build({
    configFile: false,
    define: {
      __MOVI_VERSION__: JSON.stringify(PKG_VERSION),
      // Literal so the dead branch tree-shakes out of the default build.
      __MOVI_SLIM__: entry.slim ? 'true' : 'false',
    },
    // The slim entry swaps the embedded WASM glue (dist/wasm/movi.js, base64
    // inside) for the external-WASM glue (dist/wasm/external/movi.js, which
    // streams external/movi.wasm). A regex alias so it matches the relative
    // specifier FFmpegLoader imports ("../../dist/wasm/movi.js"), not just an
    // absolute path — string aliases run against the raw specifier.
    ...(entry.slim
      ? {
          resolve: {
            alias: [
              {
                find: /\/dist\/wasm\/movi\.js$/,
                replacement: '/dist/wasm/external/movi.js',
              },
            ],
          },
        }
      : {}),
    // No dts plugin: tsc emits the declarations before this script runs. See
    // the note at the top of the file.
    plugins: [],
    logLevel: VERBOSE ? 'info' : 'warn',
    build: {
      // Native class fields output (no __publicField helper). Required
      // by the post-build harden pass: terser's property mangler
      // rewrites `this._foo` accesses, but it does NOT rename the
      // string literal inside `__publicField(this, "_foo", ...)`. With
      // the helper in play, the mangled getter looks up a property
      // that was never installed under its new name → undefined at
      // runtime. All WebCodecs-supporting browsers ship class fields,
      // so dropping the helper costs nothing.
      target: 'es2022',
      // The slim build's whole point is to NOT carry the WASM in the JS. Vite
      // otherwise base64-inlines the movi.wasm that external/movi.js references
      // via `new URL(..., import.meta.url)` — re-embedding exactly what we split
      // out. 0 forces it to be emitted as a separate asset instead.
      ...(entry.slim ? { assetsInlineLimit: 0 } : {}),
      lib: {
        entry: resolve(rootDir, entry.path),
        name: 'Movi',
        formats: [format],
        fileName: () => `${entry.name}.${formatExt}`,
      },
      rollupOptions: {
        external: [],
        // Order matters: rewrite console.* → __movilog FIRST, then terser.
        // Terser disabled for the "no-harden" diagnostic build — toggle via
        // env var MOVI_NO_HARDEN=1. Keeps the movilog rewrite (so consoles
        // still pipe to the extension/output channel) but skips the
        // dead-code / inline / mangle passes that we suspect change
        // Asyncify timing in production.
        plugins: process.env.MOVI_NO_HARDEN === "1"
          ? [movilogRewritePlugin()]
          : [movilogRewritePlugin(), terser(terserConfig)],
        output: {
          globals: {},
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.wasm')) {
              return 'wasm/[name][extname]';
            }
            return '[name][extname]';
          },
        },
      },
      sourcemap: false,
      minify: false,
      emptyOutDir: false,
      chunkSizeWarningLimit: 10000,
      outDir: resolve(rootDir, 'dist'),
    },
  });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  ✓ ${entry.name}.${formatExt}  (${secs}s)`);
}

/**
 * Un-inline the WASM from the slim bundle.
 *
 * Vite's library mode base64-inlines the movi.wasm that external/movi.js
 * references via `new URL(..., import.meta.url)`, ignoring assetsInlineLimit —
 * a lib has no stable base URL to emit assets against, so it always inlines.
 * That re-embeds exactly what the slim build exists to split out.
 *
 * So we do it after the fact, deterministically: replace the inlined data URL
 * (the FIRST arg of `new URL(...)`) with a plain "movi.wasm" reference, leaving
 * the SECOND arg — Vite's own base resolution, `import.meta.url` for ESM and a
 * document/require expression for CJS — untouched, so both formats resolve the
 * file next to their own bundle. Then drop movi.wasm beside them.
 */
function externalizeSlimWasm(files) {
  const wasmSrc = resolve(rootDir, 'dist/wasm/external/movi.wasm');
  if (!existsSync(wasmSrc)) {
    throw new Error(
      `Slim build: ${wasmSrc} is missing — run \`npm run build:wasm\` first ` +
        `(it emits dist/wasm/external/movi.{js,wasm}).`,
    );
  }
  copyFileSync(wasmSrc, resolve(rootDir, 'dist/movi.wasm'));

  // Only the files THIS run produced. With MOVI_FORMAT narrowing the run to one
  // format, the other one on disk is a previous build's output — already fixed
  // up, so the data URL is long gone and the "did the fixup match" check below
  // would fail on a bundle that is perfectly correct.
  const dataUrl = /new URL\("data:application\/wasm;base64,[A-Za-z0-9+/=]+"/g;
  for (const file of files) {
    const p = resolve(rootDir, file);
    const before = readFileSync(p, 'utf8');
    const after = before.replace(dataUrl, 'new URL("movi.wasm"');
    if (after === before) {
      throw new Error(
        `Slim build: no inlined WASM data URL found in ${file} to externalize ` +
          `— the Vite inlining behaviour may have changed; re-check the fixup.`,
      );
    }
    writeFileSync(p, after);
  }
  console.log('✓ slim WASM externalized → dist/movi.wasm (bundle no longer embeds it)');
}

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * A fixed set of workers pulling from a shared cursor, rather than chunking the
 * list into batches: the bundles are wildly uneven — the slim one is 4.5 MB and
 * index is 11.4 MB — and a batch is only as fast as its slowest member, which
 * would leave three cores idle waiting on index every time.
 */
async function runPool(tasks, limit) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
}

async function buildAll() {
  const selected = ONLY_ENTRIES.length
    ? entries.filter((e) => ONLY_ENTRIES.includes(e.name))
    : entries;
  if (!selected.length) {
    throw new Error(
      `MOVI_ENTRY=${process.env.MOVI_ENTRY} matches no entry. Known: ` +
        entries.map((e) => e.name).join(', '),
    );
  }
  const formats = ONLY_FORMATS.length
    ? ALL_FORMATS.filter((f) => ONLY_FORMATS.includes(f))
    : ALL_FORMATS;
  if (!formats.length) {
    throw new Error(
      `MOVI_FORMAT=${process.env.MOVI_FORMAT} matches no format. Known: ` +
        ALL_FORMATS.join(', '),
    );
  }

  const jobs = [];
  for (const entry of selected) {
    for (const format of formats) {
      if (format === 'iife' && !entry.global) continue;
      jobs.push({ entry, format });
    }
  }

  const started = Date.now();
  console.log(
    `Building ${jobs.length} bundle(s) — ${selected.map((e) => e.name).join(', ')} ` +
      `× ${formats.join(', ')} — ${Math.min(JOBS, jobs.length)} at a time\n`,
  );

  // Say it out loud when the run is narrowed. A partial run leaves the other
  // bundles in dist as whatever the last full build wrote, which is exactly
  // what you want while iterating and exactly what you must not publish — and
  // a stale bundle looks identical to a fresh one on disk.
  const skippedEntries = entries.filter((e) => !selected.includes(e));
  const skippedFormats = ALL_FORMATS.filter((f) => !formats.includes(f));
  if (skippedEntries.length || skippedFormats.length) {
    const parts = [];
    if (skippedEntries.length)
      parts.push(`entries ${skippedEntries.map((e) => e.name).join(', ')}`);
    if (skippedFormats.length) parts.push(`format ${skippedFormats.join(', ')}`);
    console.log(
      `  ! partial build — ${parts.join(' and ')} left as the previous build wrote them.\n` +
        `    Run \`npm run build:ts\` before publishing or releasing.\n`,
    );
  }

  await runPool(
    jobs.map(({ entry, format }) => () => buildEntry(entry, format)),
    JOBS,
  );

  const slimFiles = jobs
    .filter(({ entry }) => entry.slim)
    .map(({ entry, format }) => outFile(entry, format));
  if (slimFiles.length) externalizeSlimWasm(slimFiles);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n✓ ${jobs.length} bundle(s) built in ${secs}s`);
}

buildAll().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
