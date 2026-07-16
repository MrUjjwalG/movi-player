import { defineConfig } from 'vite';

// Production build is handled by scripts/build-standalone.js (not this config)
// This config is only used for dev server (vite dev) and vitest
export default defineConfig({
  worker: {
    format: 'es',
  },
  // Don't let Vite pre-bundle the generated WASM glue into node_modules/.vite.
  // It's a ~6 MB emscripten module rebuilt via `npm run build:wasm`; if Vite
  // caches it as an optimized dep, the dev server keeps serving a STALE copy
  // after a WASM rebuild (no [movi] logs, old behaviour). Excluding it makes
  // the dev server always read the fresh dist/wasm/movi.js.
  optimizeDeps: {
    exclude: ['movi'],
  },
  server: {
    allowedHosts: true,
    headers: {
      // 'same-origin-allow-popups' (not 'same-origin') so Google Identity
      // Services OAuth popups can post the token back to the opener — plain
      // 'same-origin' severs that link and GIS falsely reports 'popup_closed'.
      // COEP is intentionally NOT set: it's only useful together with
      // COOP 'same-origin' to earn crossOriginIsolated (SharedArrayBuffer),
      // which we've given up here — and 'require-corp' both blocks cross-origin
      // subresources and further breaks the OAuth popup. The player does NOT
      // need SAB: single-threaded WASM + Asyncify I/O, HttpSource plain-buffer
      // fallback. SAB was only a zero-copy optimisation.
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
  },
});
