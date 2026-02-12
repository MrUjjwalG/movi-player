import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import terser from '@rollup/plugin-terser';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      entryRoot: 'src', // Generate types for each entry point
    }),
  ],
  build: {
    lib: {
      // Multiple entry points for modular architecture
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        demuxer: resolve(__dirname, 'src/demuxer.ts'),
        player: resolve(__dirname, 'src/player.ts'),
        element: resolve(__dirname, 'src/element.ts'),
      },
      name: 'Movi',
      formats: ['es', 'cjs'], // Remove UMD for module entries
      fileName: (format, entryName) => {
        if (format === 'es') return `${entryName}.js`;
        if (format === 'cjs') return `${entryName}.cjs`;
        return `${entryName}.${format}.js`;
      },
    },
    rollupOptions: {
      external: [],
      output: {
        // Disable automatic code splitting - create standalone bundles
        // Return undefined to prevent chunking and inline everything
        manualChunks: () => undefined,
        globals: {},
        // Inline WASM files as base64 (for single file bundle)
        assetFileNames: (assetInfo) => {
          // Keep WASM files separate for now, but can be inlined if needed
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'wasm/[name][extname]';
          }
          return '[name][extname]';
        },
      },
      plugins: [
        terser({
          compress: {
            drop_console: false,
            drop_debugger: false,
            // pure_funcs: ['console.debug', 'console.trace'],
            passes: 5, // Increased passes for better compression (tested safe)
            unsafe: false, // Disable unsafe optimizations for Emscripten compatibility
            unsafe_comps: false,
            unsafe_math: false,
            unsafe_methods: false,
            unsafe_proto: false,
            unsafe_regexp: false,
            unsafe_undefined: false,
            dead_code: true,
            unused: true,
            // Additional size optimizations (safe for Emscripten)
            collapse_vars: true,
            evaluate: true,
            reduce_vars: true,
            inline: 2, // Inline functions for better compression
            keep_infinity: false,
          },
          mangle: {
            toplevel: false, // Don't mangle top-level for Emscripten compatibility
            eval: false,
            keep_classnames: true, // Keep class names for Emscripten
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
        }),
      ],
    },
    sourcemap: false,
    minify: false, // Disable default minify, use terser plugin
    emptyOutDir: false, // Preserve WASM files from docker build
    // Increase chunk size limit to allow WASM inlining
    chunkSizeWarningLimit: 10000,
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
