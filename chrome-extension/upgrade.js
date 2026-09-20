/**
 * Hand the page's own <video> elements to Movi — the library's own takeover.
 *
 * Runs in the PAGE's world, because that is where a custom element has to be
 * defined for the page's own DOM to upgrade, and where the page's scripts hold
 * the <video> references that upgradeVideoElements keeps working.
 *
 * Which videos it may take is not decided here: upgradeVideoElements leaves
 * alone anything that is not a file at a URL — Media Source Extensions, a
 * MediaStream, anything under DRM, and an element with no source yet, which is
 * what a streaming site's player looks like a moment before its script reaches
 * it. That is what keeps YouTube, Netflix and the rest untouched.
 */
import { upgradeVideoElements } from "./dist/element.slim.js";

upgradeVideoElements({
  // A page that routes without reloading — and every site that swaps its
  // player between items — puts its next <video> in later.
  watch: true,
  // The same player the extension's own page opens files in. A <video> has no
  // way to ask for any of this, so it comes from here — and it is the same
  // list as player.html's, so a video is the same player wherever it is met.
  attributes: {
    // The site drew its own controls around its <video>; ours has nothing
    // else to be driven by.
    controls: "",
    thumb: "precise",
    fastseek: "",
    showtitle: "",
    // player.html's is "back-windowed". The arrow is not carried over: there
    // it goes back to the player's own home, and here there is nowhere for it
    // to go — the back event would be dispatched into a page that has never
    // heard of it. The title itself is worth having, so the rest stands.
    titlemode: "windowed",
    subtitlepicker: "",
    ambientmode: "",
    resume: "",
    smoothwarning: "",
  },
});
