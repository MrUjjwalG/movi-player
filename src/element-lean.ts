/**
 * Movi Element — lean build entry.
 *
 * The slim build without the adaptive-streaming engines. Same `<movi-player>`
 * element and the exact same API as `movi-player/element/slim`; the WASM
 * streams from a separate `movi.wasm` just as it does there. What is left out
 * is Shaka Player, dash.js and hls.js, which the slim bundle carries in full
 * even for a page that only ever plays files. The build wires this entry the
 * same way it wires slim (see scripts/build-standalone.js), plus:
 *
 *   1. an alias that swaps the three stream wrappers for
 *      `src/render/StreamWrapperStub.ts`, so none of the three libraries is
 *      bundled;
 *   2. the `__MOVI_LEAN__` define, so `MoviElement.build` reports `"lean"`.
 *
 * An HLS / DASH / Smooth Streaming manifest has no engine in this build: each
 * stream tier refuses at load, and the slim build's automatic native fallback
 * hands the URL to the browser's own `<video>`, which plays HLS where it does
 * so natively (Safari) and nothing elsewhere. Single-file DASH still reaches
 * the FFmpeg demuxer through the existing fallback. A page that needs adaptive
 * streaming loads `movi-player/element/slim` or `movi-player/element`.
 */
export * from "./element";
