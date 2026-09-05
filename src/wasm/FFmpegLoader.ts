/**
 * FFmpegLoader - Async loader for WASM module
 */

import type { MoviWasmModule } from './types';
import { Logger } from '../utils/Logger';
import { IS_SLIM } from '../build-flags';
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

// The URL the glue actually resolved `movi.wasm` to, learned from the
// `locateFile` below on the first module that loads without an override. With
// no override set, the glue's own default is `new URL("movi.wasm",
// import.meta.url)` against the BUNDLE's location, which nothing here can
// compute — so it is remembered as it happens rather than guessed.
let resolvedWasmUrl: string | null = null;

/**
 * Build a `locateFile` for the slim build's external `movi.wasm`.
 *
 * Two jobs: redirect the request to a `wasmurl` override when one is set (the
 * original purpose), and remember whatever URL comes out either way, so
 * {@link compiledWasmModule} can compile from it. Returning `undefined` leaves
 * the glue on its own default path, which is what the embedded build wants.
 */
function wasmLocateFile(): ((path: string, prefix: string) => string) | undefined {
  if (!wasmUrlOverride && !IS_SLIM) return undefined;
  const override = wasmUrlOverride;
  return (path: string, prefix: string) => {
    if (!path.endsWith(".wasm")) return prefix + path;
    const url = override ?? prefix + path;
    resolvedWasmUrl = url;
    return url;
  };
}

// The compiled 5.4MB module, shared by every instance.
//
// Emscripten compiles the WASM once per module it builds, and this player
// builds several: the cached main-playback one, an isolated one for every
// extra demuxer (a second player, the preview/thumbnail pipeline), and another
// after a quality switch rebuilds the pipeline. Each of those was its own
// fetch AND its own multi-megabyte compile — the repeated `movi.wasm` rows in
// the network panel are exactly this. A `WebAssembly.Module` is immutable and
// instantiating it is cheap, so compiling once and instantiating many times
// gives each caller the same isolated memory it had before for a fraction of
// the cost.
let compiledWasmPromise: Promise<WebAssembly.Module> | null = null;

/** Compile `movi.wasm` from `url`, once per page. */
function compiledWasmModule(url: string): Promise<WebAssembly.Module> {
  if (compiledWasmPromise) return compiledWasmPromise;
  const promise = (async () => {
    try {
      // Streaming compile — the same call the glue makes, so a server that
      // labels the file `application/wasm` still gets the fast path (and, in
      // Chrome, the cross-page compiled-code cache that only streaming fills).
      return await WebAssembly.compileStreaming(
        fetch(url, { credentials: "same-origin" }),
      );
    } catch (error) {
      // Wrong MIME type is the usual reason, and it is fatal to streaming but
      // not to the buffer path — the glue has the same fallback.
      Logger.warn(TAG, `wasm streaming compile failed (${error}); retrying via ArrayBuffer`);
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
      }
      return WebAssembly.compile(await response.arrayBuffer());
    }
  })();
  compiledWasmPromise = promise;
  // A failure must not be cached — the next load should be free to try again
  // (and to fall back to letting the glue fetch it itself).
  promise.catch(() => {
    if (compiledWasmPromise === promise) compiledWasmPromise = null;
  });
  return promise;
}

/**
 * Build the `instantiateWasm` hook that hands Emscripten an instance of the
 * shared compiled module, or `undefined` when there is nothing to share yet —
 * in which case the glue fetches and compiles as it always did, and this
 * load's `locateFile` records the URL so the NEXT one can share.
 *
 * The compile is awaited HERE, before the module is created, on purpose: the
 * hook has no error channel (the glue awaits a promise the callback resolves,
 * so a throw inside it hangs the load forever). Resolving it first means a
 * failure just means no hook.
 */
async function wasmInstantiateHook(
  wasmBinary: Uint8Array | null,
): Promise<((imports: WebAssembly.Imports, success: (inst: WebAssembly.Instance) => void) => void) | undefined> {
  // Bytes in hand (an embedded build, or a caller passing their own) — the
  // glue has nothing to fetch and this buys nothing.
  if (wasmBinary || !IS_SLIM) return undefined;
  const url = wasmUrlOverride ?? resolvedWasmUrl;
  if (!url) return undefined;
  let module: WebAssembly.Module;
  try {
    module = await compiledWasmModule(url);
  } catch (error) {
    Logger.warn(TAG, `Shared WASM compile failed (${error}); falling back to the loader's own fetch`);
    return undefined;
  }
  return (imports, success) => {
    WebAssembly.instantiate(module, imports).then(
      (instance) => success(instance),
      (error) => {
        // Instantiating an already-compiled module with the glue's own imports
        // does not realistically fail; if it somehow does, say so rather than
        // leaving a silently hung load.
        Logger.error(TAG, 'Failed to instantiate the shared WASM module', error);
      },
    );
  };
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
  // The COMPILED module is deliberately kept. What abort() kills is one
  // instance's memory and stack, not the code — a fresh instance of the same
  // compiled module is exactly the live one this wants to rebuild, and
  // recompiling 5.4MB to get it would only make the recovery slower.
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
        // Slim build — tell Emscripten where movi.wasm is (and learn the URL).
        moduleOptions.locateFile = locateFile;
      }
      const instantiateWasm = await wasmInstantiateHook(wasmBinary ?? null);
      if (instantiateWasm) {
        // Reuse the already-compiled module instead of fetching and compiling
        // it again. Takes priority over locateFile in the glue: with this set
        // it never asks for the file at all.
        moduleOptions.instantiateWasm = instantiateWasm;
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
      // Slim build — tell Emscripten where movi.wasm is (and learn the URL).
      moduleOptions.locateFile = locateFile;
    }
    const instantiateWasm = await wasmInstantiateHook(wasmBinary ?? null);
    if (instantiateWasm) {
      // The whole point of this path is a separate WebAssembly.Memory, and it
      // still gets one — instantiating a shared compiled module builds a fresh
      // instance every time. Only the fetch and the compile are shared.
      moduleOptions.instantiateWasm = instantiateWasm;
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
