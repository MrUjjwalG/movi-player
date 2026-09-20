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

// The arrow has to mean something. On the extension's own page it goes back to
// where files are opened; here the only place it can go is out of fullscreen,
// which is where the title bar carrying it appears in the first place. On a
// phone it is also the only way out that does not need a keyboard — which is
// why "back-mobile" puts it there and nowhere else. The element only announces
// the press, so a page that wants its own answer can preventDefault it first.
document.addEventListener("back", (event) => {
  const target = event.target;
  if (!target || target.tagName !== "MOVI-PLAYER") return;
  if (!document.fullscreenElement) return;
  event.preventDefault();
  document.exitFullscreen?.().catch(() => {});
});

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
    // The name of what is playing, where it is actually wanted: fullscreen,
    // with nothing else on screen to say it. Windowed, the page's own title
    // and chrome are right there and a second one over the picture is noise.
    titlemode: "fullscreen back-mobile",
    subtitlepicker: "",
    ambientmode: "",
    resume: "",
    smoothwarning: "",
  },
});
