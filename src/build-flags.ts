/**
 * Compile-time build flags, injected via Vite `define`.
 *
 * `__MOVI_SLIM__` is `true` only in the slim entry's build (see
 * scripts/build-standalone.js), `false` everywhere else. The `typeof` guard
 * keeps a bare `tsc` / vitest run — where no define happens — from throwing.
 * Because the value is a literal after `define`, the dead branch tree-shakes
 * away, so the default build carries none of the slim-only code.
 */
declare const __MOVI_SLIM__: boolean | undefined;
declare const __MOVI_LEAN__: boolean | undefined;

/**
 * The slim build ships the WASM as a separate `movi-slim.wasm` (streamed,
 * cached) instead of base64-embedded, and — because a consumer may not host
 * that extra file — auto-falls back to native `<video>` playback when the WASM
 * engine can't be loaded, even without a `fallback="native"` attribute.
 */
export const IS_SLIM: boolean =
  typeof __MOVI_SLIM__ !== "undefined" ? __MOVI_SLIM__ : false;

/**
 * The lean build is the slim build without the adaptive-streaming engines:
 * Shaka Player, dash.js and hls.js are swapped for a stub at build time (see
 * scripts/build-standalone.js), so a page that only plays files does not ship
 * the three libraries. `true` only in the lean entry's build; a lean build is
 * always also slim.
 */
export const IS_LEAN: boolean =
  typeof __MOVI_LEAN__ !== "undefined" ? __MOVI_LEAN__ : false;

/**
 * Which bundle is running: `"lean"` (WASM streamed from a separate
 * `movi.wasm`, no HLS/DASH engines), `"slim"` (WASM streamed from a separate
 * `movi.wasm`) or `"full"` (WASM embedded in the JS).
 *
 * Deliberately NOT folded into {@link VERSION} — all builds ship the same
 * release, and a `0.4.0+slim` string would break every consumer that compares
 * versions for equality. This is the separate axis, and the one worth having in
 * a bug report: the bundles differ in how the engine loads, in what happens
 * when it can't, and in whether a manifest has an engine at all.
 */
export const BUILD: "lean" | "slim" | "full" = IS_LEAN
  ? "lean"
  : IS_SLIM
    ? "slim"
    : "full";
