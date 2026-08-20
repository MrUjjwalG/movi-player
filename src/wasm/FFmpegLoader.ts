/**
 * FFmpegLoader - Async loader for WASM module
 */

import type { MoviWasmModule } from './types';
import { Logger } from '../utils/Logger';
// Static import of the generated module (bundled into index.js)
// @ts-ignore - movi.js is Emscripten-generated, no types available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import createMoviModule from '../../dist/wasm/movi.js';

const TAG = 'FFmpegLoader';

let modulePromise: Promise<MoviWasmModule> | null = null;
let loadedModule: MoviWasmModule | null = null;

// Who currently owns the shared module.
//
// Emscripten's Asyncify unwinds and rewinds the WHOLE module's stack, and the
// pending read that a rewind resumes is stored on the module — one slot, module
// wide. Two players demuxing through the same module therefore overwrite each
// other's read: one of them is answered with the other's bytes, the other is
// told "No pending read to fulfill", and its open ends as
// "File is corrupted or in an unsupported format". Two <movi-player>s on one
// page is an ordinary thing to build (a gallery, a comparison, a feed) and it
// could not work at all.
//
// So the shared module is claimed, not assumed: the first main-playback demuxer
// takes it and every other one loads its own isolated instance — the same thing
// the preview pipeline already does. The cost is another WASM instance per
// simultaneous player, which is the honest price of playing two files at once.
let sharedModuleClaimed = false;

/**
 * Try to take the shared main-playback module. Returns false when another
 * demuxer already holds it, and the caller should load an isolated instance
 * (loadWasmModuleNew) instead. Synchronous on purpose: it settles the race
 * between two demuxers opening in the same tick, before either awaits.
 */
export function claimSharedModule(): boolean {
  if (sharedModuleClaimed) return false;
  sharedModuleClaimed = true;
  return true;
}

/** Give the shared module back, so the next player can use it. */
export function releaseSharedModule(): void {
  sharedModuleClaimed = false;
}

// Embedded WASM binary (will be set if WASM is bundled)
let embeddedWasmBinary: Uint8Array | null = null;

// Override URL for the external `movi.wasm` (slim build only). null → the glue's
// own `new URL("movi.wasm", import.meta.url)` default, i.e. next to the JS
// bundle. Set via the `wasmurl` attribute / `MoviElement.setWasmUrl()` when a
// consumer hosts the .wasm somewhere else (a CDN, a versioned path). No effect
// on the embedded (default) build, whose WASM lives inside the JS.
let wasmUrlOverride: string | null = null;

/**
 * Point the loader at a specific `movi.wasm` URL. Only meaningful for the slim
 * build; must be called before the engine first loads (the element does this
 * from its `wasmurl` attribute on connect).
 */
export function setWasmUrl(url: string | null): void {
  wasmUrlOverride = url && url.trim() ? url.trim() : null;
}

/** Build a `locateFile` that redirects the .wasm request to the override URL. */
function wasmLocateFile(): ((path: string, prefix: string) => string) | undefined {
  if (!wasmUrlOverride) return undefined;
  const url = wasmUrlOverride;
  return (path: string, prefix: string) =>
    path.endsWith(".wasm") ? url : prefix + path;
}

export interface LoaderOptions {
  wasmBinary?: Uint8Array; // Embedded WASM binary data (required if embeddedWasmBinary not set)
  workerPath?: string;
}

/**
 * Discard the cached main-playback module so the next loadWasmModule() builds a
 * fresh one. Emscripten's abort() (a WASM trap / OOB in an FFmpeg call) leaves
 * the module PERMANENTLY dead: every later avformat_open_input on it fails with
 * "File is corrupted or in an unsupported format". Because the main demuxer uses
 * this cached singleton, that error then repeats for EVERY source — a new video,
 * a quality switch, anything — until a full page reload rebuilds the JS context.
 * Calling this on a fatal WASM error makes the next load recover in-page, exactly
 * as a reload would.
 */
export function resetWasmModule(): void {
  loadedModule = null;
  modulePromise = null;
  // Whoever held the dead module is not going to give it back.
  sharedModuleClaimed = false;
}

/**
 * Load the WASM module (cached singleton for main playback)
 */
export async function loadWasmModule(options: LoaderOptions = {}): Promise<MoviWasmModule> {
  if (loadedModule) {
    return loadedModule;
  }

  if (modulePromise) {
    return modulePromise;
  }

  modulePromise = (async () => {
    Logger.info(TAG, 'Loading WASM module...');
    
    // With SINGLE_FILE, WASM is embedded in movi.js, so wasmBinary is optional
    const wasmBinary = options.wasmBinary || embeddedWasmBinary;
    
    try {
      // Static import - movi.js is bundled into index.js
      const createModule = createMoviModule;
      
      // Create module - with SINGLE_FILE, WASM is embedded, so wasmBinary is optional
      const moduleOptions: any = {
        print: (text: string) => {
          if (text && text.trim()) {
            Logger.debug('WASM', text);
          }
        },
        printErr: (text: string) => {
          if (text && text.trim()) {
            // FFmpeg uses stderr for all logging, including info/debug
            // Map to debug to avoid flooding console with "errors"
            Logger.debug('WASM', text);
          }
        },
        // Emscripten calls this the instant the module traps (abort()). This is
        // the CACHED singleton the main demuxer reuses, so once it's dead every
        // later open fails "File is corrupted" until a page reload — drop it from
        // the cache here so the next loadWasmModule() rebuilds a live one in-page.
        onAbort: (what: unknown) => {
          Logger.error(TAG, `WASM aborted — discarding dead cached module: ${what}`);
          resetWasmModule();
        },
      };
      if (wasmBinary) {
        moduleOptions.wasmBinary = wasmBinary;
      }
      const locateFile = wasmLocateFile();
      if (locateFile) {
        // Slim build with a custom wasmurl — tell Emscripten where movi.wasm is.
        moduleOptions.locateFile = locateFile;
      }
      const module: MoviWasmModule = await createModule(moduleOptions);
      
      Logger.info(TAG, 'WASM module loaded successfully');
      
      if ((module as any).FS) {
        Logger.debug(TAG, 'FS is present on module');
      } else {
        Logger.error(TAG, 'FS is MISSING from module!');
      }
      
      loadedModule = module;
      return module;
    } catch (error) {
      Logger.error(TAG, 'Failed to load WASM module', error);
      modulePromise = null;
      throw error;
    }
  })();

  return modulePromise;
}

/**
 * Load a NEW WASM module instance (not cached).
 * Use this for preview pipeline to get completely isolated WASM memory.
 * Each call creates a separate WebAssembly.Memory - no sharing with main module.
 */
export async function loadWasmModuleNew(options: LoaderOptions = {}): Promise<MoviWasmModule> {
  Logger.info(TAG, 'Loading NEW WASM module instance (isolated)...');
  
  const wasmBinary = options.wasmBinary || embeddedWasmBinary;
  
  try {
    const createModule = createMoviModule;
    
    const moduleOptions: any = {
      print: (text: string) => {
        if (text && text.trim()) {
          Logger.debug('WASM', text);
        }
      },
      printErr: (text: string) => {
        if (text && text.trim()) {
          Logger.debug('WASM', text);
        }
      }
    };
    if (wasmBinary) {
      moduleOptions.wasmBinary = wasmBinary;
    }
    const locateFile = wasmLocateFile();
    if (locateFile) {
      // Slim build with a custom wasmurl — tell Emscripten where movi.wasm is.
      moduleOptions.locateFile = locateFile;
    }

    // Always create fresh instance - no caching
    const module: MoviWasmModule = await createModule(moduleOptions);

    Logger.info(TAG, 'NEW WASM module instance loaded');
    return module;
  } catch (error) {
    Logger.error(TAG, 'Failed to load new WASM module', error);
    throw error;
  }
}

/**
 * Get the loaded module (throws if not loaded)
 */
export function getWasmModule(): MoviWasmModule {
  if (!loadedModule) {
    throw new Error('WASM module not loaded. Call loadWasmModule first.');
  }
  return loadedModule;
}

/**
 * Check if module is loaded
 */
export function isWasmModuleLoaded(): boolean {
  return loadedModule !== null;
}
