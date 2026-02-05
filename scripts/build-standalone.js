/**
 * Build script for standalone modular bundles
 * Builds each entry point separately to avoid shared chunks
 */

import { build } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

const entries = [
  { name: 'demuxer', path: 'src/demuxer.ts' },
  { name: 'player', path: 'src/player.ts' },
  { name: 'element', path: 'src/element.ts' },
  { name: 'index', path: 'src/index.ts' },
];

const terserConfig = {
  compress: {
    drop_console: false,
    drop_debugger: false,
    passes: 5,
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
  const formatExt = format === 'es' ? 'js' : format;
  console.log(`Building ${entry.name}.${formatExt}...`);

  await build({
    configFile: false,
    plugins: [
      // Only generate types once for ES format
      ...(format === 'es'
        ? [
            dts({
              insertTypesEntry: true,
              entryRoot: 'src',
              include: [entry.path],
            }),
          ]
        : []),
    ],
    build: {
      lib: {
        entry: resolve(rootDir, entry.path),
        name: 'Movi',
        formats: [format],
        fileName: () => `${entry.name}.${formatExt}`,
      },
      rollupOptions: {
        external: [],
        plugins: [terser(terserConfig)],
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
}

async function buildAll() {
  console.log('Building standalone modular bundles...\n');

  for (const entry of entries) {
    // Build ES format
    await buildEntry(entry, 'es');

    // Build CJS format
    await buildEntry(entry, 'cjs');

    console.log(`✓ ${entry.name} built\n`);
  }

  console.log('✓ All standalone bundles built successfully!');
}

buildAll().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
