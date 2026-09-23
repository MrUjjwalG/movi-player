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

/**
 * Is this the page's PLAYER, or is it furniture?
 *
 * A <video> on the web is not always something to be watched. A search page
 * of stock footage is a grid of them, each one a thumbnail that plays a muted
 * loop when the pointer crosses it; a marketing page puts one behind its
 * headline. Replacing those with a real player turns a page of previews into a
 * page of black boxes — and costs a WebAssembly engine for each one.
 *
 * So the question is not "can this be opened" (the library answers that) but
 * "did the page put this here to be watched":
 *
 *  - a site's own player skin around it says yes, whatever else is true;
 *  - the controls attribute says yes — the page expects a viewer to drive it;
 *  - a muted or looping video says no: that is a decoration, a preview, a
 *    background;
 *  - otherwise, only a page whose single video is big enough to be the point
 *    of the page.
 *
 * Kept in both content.js and upgrade.js on purpose: the first decides whether
 * this page is worth megabytes of player at all, the second which elements get
 * one. They must answer the same way, so they ask the same question.
 */
function looksLikeThePagesPlayer(video) {
  if (
    video.closest(
      ".video-js, .vjs-container, .plyr, .jwplayer, .flowplayer, .shaka-video-container, .mejs__container",
    )
  ) {
    return true;
  }
  if (video.hasAttribute("controls")) return true;
  if (video.loop || video.muted || video.hasAttribute("muted")) return false;
  if (document.querySelectorAll("video").length !== 1) return false;
  const box = video.getBoundingClientRect();
  return box.width >= 400 && box.height >= 225;
}

/**
 * What the background found at the end of each link, handed over by
 * content.js on this script's own tag — the isolated world and this one share
 * the document and nothing else.
 *
 * Read now rather than later: the tag is taken out of the DOM when this
 * module finishes loading.
 */
const SOURCE_VERDICTS = (() => {
  try {
    const tag = document.getElementById("movi-upgrade-script");
    return JSON.parse(tag?.dataset.sources || "{}");
  } catch {
    return {};
  }
})();

/**
 * Leave an element alone only when every link it declares is known NOT to be
 * media.
 *
 * One bad source among several is not a refusal: an mp4 with an ogg beside it
 * is the oldest shape on the web, and the first of them 404ing is what the
 * second is there for. Nor is silence — a URL nobody could probe, or a server
 * that said nothing useful, leaves the element exactly as it would have been.
 */
function sourceCheck(urls) {
  const known = urls.map((u) => SOURCE_VERDICTS[u]).filter(Boolean);
  if (known.length === 0) return true;
  return known.some((v) => v !== "notmedia");
}

upgradeVideoElements({
  sourceCheck,
  // A page that routes without reloading — and every site that swaps its
  // player between items — puts its next <video> in later.
  watch: true,
  filter: looksLikeThePagesPlayer,
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
    smoothwarning: "",
  },
});
