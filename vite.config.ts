import { defineConfig } from 'vite';

// Production build is handled by scripts/build-standalone.js (not this config)
// This config is only used for dev server (vite dev) and vitest
export default defineConfig({
  worker: {
    format: 'es',
  },
  server: {
    allowedHosts: true,
    headers: {
      // Required for SharedArrayBuffer
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
