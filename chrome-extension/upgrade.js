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
  attributes: {
    // The page's own <video> may have had no controls because the site drew
    // its own around it. Ours has nothing else to be driven by.
    controls: "",
  },
});
