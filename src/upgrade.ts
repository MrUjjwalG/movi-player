/**
 * Take over the `<video>` elements a page already has.
 *
 * A page that was built around `<video>` — or around video.js, which is a
 * `<video>` with a script on top — should not have to be rewritten to gain a
 * demuxer. `upgradeVideoElements()` walks the document, puts a `<movi-player>`
 * where each `<video>` was, and carries its attributes and its children across:
 * the sources, the caption tracks, the poster, `data-setup`. What was declared
 * stays declared.
 *
 * The old element is kept, hidden, and wired to the new one, because a page's
 * JavaScript holds references to it: `video.play()`, `video.currentTime = 30`,
 * `video.addEventListener("ended", …)` all keep working, and keep meaning the
 * same thing, now that the player is what answers them. Existing code does not
 * know anything changed — which is the point.
 *
 * ```js
 * import { upgradeVideoElements } from "movi-player";
 *
 * upgradeVideoElements();                       // every <video> on the page
 * upgradeVideoElements("video.player");         // just these
 * upgradeVideoElements(document.querySelector("#hero"));
 *
 * const stop = upgradeVideoElements({ watch: true });   // …and future ones
 * ```
 *
 * A page opts a video out with `data-movi-ignore` — on the `<video>` itself or
 * on anything around it:
 *
 * ```html
 * <video data-movi-ignore src="clip.mp4" controls></video>
 * <section data-movi-ignore> …videos left alone… </section>
 * ```
 */

import { Logger } from "./utils/Logger";

const TAG = "upgrade";

/** Marks an element that has already been taken over, so a second pass skips it. */
const TAKEN = "__moviUpgraded";

/**
 * The page's own "leave this one alone".
 *
 * `skip` and `filter` belong to whoever CALLS the upgrade — and on a page the
 * browser extension upgrades, that is not the page. The page is the one that
 * knows a video is meant to stay native: the compare page shows a `<video>`
 * beside a `<movi-player>` precisely to show what the native element does, and
 * the extension's takeover replaced it, so both halves of the comparison were
 * the same player. Honoured on an ancestor too, so a whole section can opt out.
 */
const IGNORE_ATTRIBUTE = "data-movi-ignore";

export interface UpgradeOptions {
  /** Where to look. Defaults to the whole document. */
  root?: ParentNode;
  /**
   * Keep watching for `<video>` elements added later — a route change, a lazy
   * component, an ad slot. The returned function stops watching.
   */
  watch?: boolean;
  /**
   * Attributes to put on every player this creates, for the things a `<video>`
   * has no way to ask for: `{ thumb: "", fallback: "native", sw: "auto" }`.
   */
  attributes?: Record<string, string>;
  /**
   * Forward the old element's API to the player, so code that still holds the
   * `<video>` keeps working. On by default; turn it off if the page is being
   * rewritten anyway and you would rather see it break loudly.
   */
  proxy?: boolean;
  /** Leave alone any `<video>` matching this selector. */
  skip?: string;
  /**
   * The last word on whether a particular `<video>` is taken.
   *
   * Everything else here asks what CAN be opened. This is for a caller that
   * also has to judge what SHOULD be — a page where videos are content rather
   * than a player, a grid of previews, a muted loop behind a headline. Called
   * with each candidate that has already passed the rest; return false to
   * leave it as it is.
   */
  filter?: (video: HTMLVideoElement) => boolean;
  /**
   * Is there media at the end of this element's links?
   *
   * An upgraded player reads the bytes itself, so a link that leads to
   * something else — a dead file, an expired signed URL, a paywall answering
   * with HTML — becomes a player with nothing to play, where the native
   * element would at least have shown the page's own error. From the DOM all
   * of those look like a perfectly good `<video src>`, so nothing here can
   * tell them apart.
   *
   * Whoever CAN is the caller. A browser extension has host permission and
   * can ask the server what is there; a page cannot, which is the same CORS
   * wall that makes the takeover necessary in the first place. So the
   * question is asked rather than answered: called with every URL this
   * element declares, absolute and in the order the page wrote them, return
   * false to leave the element alone.
   *
   * Not called at all when it is not supplied, which is the honest default —
   * an unanswerable question should not stop anything.
   */
  sourceCheck?: (urls: string[], video: HTMLVideoElement) => boolean;
  /**
   * Which sources may be taken over.
   *
   * "static" — the default — takes over a `<video>` that is playing a FILE at
   * a URL, and leaves every other one alone. The other ones are the sites that
   * feed the element themselves: YouTube, Netflix, anything on Media Source
   * Extensions, a camera on a MediaStream, anything under DRM. There is no
   * file behind those to open — the bytes arrive through JavaScript the page
   * is running — so taking the element away from them replaces a video that
   * works with a player that cannot possibly fetch anything, and breaks the
   * site. A video with no source yet is left alone for the same reason: that
   * is what a streaming site's element looks like a moment before its script
   * attaches to it.
   *
   * "any" upgrades whatever is there, for a caller who knows their page.
   */
  sources?: "static" | "any";
  /**
   * Leave the page's own layers over the video where they are.
   *
   * By default, anything the page painted over the old element and that sits
   * within the player's box — a big play button, a poster, a click-catcher, the
   * gradient a skin put under its controls — is hidden once the player is in
   * place, since it was drawn for a video that is no longer there and now
   * covers one that is. Set this for a page whose layers mean something on
   * their own.
   */
  keepOverlays?: boolean;
}

/** What an upgrade produced, for a caller that wants the pieces. */
export interface UpgradedVideo {
  /** The element that was there. Still in the DOM, hidden, and forwarding. */
  video: HTMLVideoElement;
  /** The player that replaced it. */
  player: HTMLElement;
}

/**
 * Attributes that mean the same thing on both elements and can simply be
 * copied. Everything else on the `<video>` is copied too — an unknown
 * attribute costs nothing and a page's own `data-*` and `class` are how it
 * finds and styles the thing.
 */
const DROP_ATTRS = new Set(["is"]);

/**
 * The `<video>` surface a page is most likely to use. Forwarded to the player,
 * which implements the same names — this is why upgraded pages keep working.
 */
const FORWARD_PROPS = [
  "currentTime",
  "duration",
  "paused",
  "ended",
  "volume",
  "muted",
  "playbackRate",
  "readyState",
  "videoWidth",
  "videoHeight",
  "buffered",
  "seekable",
  "loop",
  "autoplay",
  "controls",
  "poster",
  "src",
  // The old element's own source is taken off it (see below), so this has to
  // come from the player or a page asking what is playing gets "".
  "currentSrc",
  // Sizing through the property is how a page resizes a <video> from script —
  // `myVideo.width = 600`. Without these it set a number on the hidden element
  // and nothing moved.
  "width",
  "height",
  // What a player's health checks read. Left on the hidden element they
  // answered for a <video> with nothing in it — networkState EMPTY, never
  // seeking, no frames decoded — which is a stall to any skin or page that
  // asks, however well the film is playing.
  "seeking",
  "networkState",
  "error",
  "played",
  "preload",
  "defaultMuted",
  "defaultPlaybackRate",
  "preservesPitch",
  "disablePictureInPicture",
  "playsInline",
  // Not textTracks / audioTracks / videoTracks: a skin adds tracks of its own
  // there and switches their modes to draw its captions, and handed the
  // player's lists it would be driving the player's subtitles instead.
  //
  // Where it is on the page. The hidden element is display:none, which is a
  // 0x0 box at 0,0 with no offsetParent — a player nowhere, to a page sizing
  // an overlay to it, a skin laying out its menus, or anything deciding
  // whether the video is on screen.
  "offsetWidth",
  "offsetHeight",
  "offsetTop",
  "offsetLeft",
  "offsetParent",
  "clientWidth",
  "clientHeight",
  "clientTop",
  "clientLeft",
] as const;

const FORWARD_METHODS = [
  "play",
  "pause",
  "load",
  "canPlayType",
  "requestPictureInPicture",
  "getVideoPlaybackQuality",
  "fastSeek",
  "requestVideoFrameCallback",
  "cancelVideoFrameCallback",
  "setSinkId",
  "getBoundingClientRect",
  "getClientRects",
  "checkVisibility",
  "scrollIntoView",
  "focus",
  "blur",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
] as const;

/**
 * Is this element playing a file at a URL, rather than bytes a script is
 * feeding it? See UpgradeOptions.sources.
 */
export function hasStaticSource(video: HTMLVideoElement): boolean {
  // A MediaSource or a MediaStream handed over as an object: nothing to fetch.
  if (video.srcObject) return false;
  // Encrypted: the keys belong to the page's own pipeline.
  if ((video as unknown as { mediaKeys?: unknown }).mediaKeys) return false;
  const source =
    video.currentSrc ||
    video.getAttribute("src") ||
    video.querySelector("source")?.getAttribute("src") ||
    "";
  if (!source) return false;
  // blob: is both — a file the page picked, and the handle a MediaSource is
  // attached by — and the two cannot be told apart from here. It is the form
  // every streaming site's element takes, so it is the form this leaves alone.
  return /^(https?:|file:|data:)/i.test(source) ||
    // A relative or protocol-relative URL is a file on the page's own origin.
    /^(\/|\.\.?\/)/.test(source);
}

/**
 * Every URL this element points at, absolute, in the order the page wrote
 * them.
 *
 * All of them, not only the one the browser settled on: a `<video>` with an
 * mp4 and an ogg beside it is the oldest shape on the web, and which one
 * `currentSrc` names depends on what this browser can play — which is not the
 * question being asked.
 */
function declaredSources(video: HTMLVideoElement): string[] {
  const out: string[] = [];
  const raw = [
    video.currentSrc,
    video.getAttribute("src"),
    ...Array.from(video.querySelectorAll("source")).map((s) =>
      s.getAttribute("src"),
    ),
  ];
  for (const one of raw) {
    if (!one) continue;
    try {
      const href = new URL(one, document.baseURI).href;
      if (!out.includes(href)) out.push(href);
    } catch {
      /* a source the page wrote that is not a URL */
    }
  }
  return out;
}

function upgradeOne(
  video: HTMLVideoElement,
  options: UpgradeOptions,
): UpgradedVideo | null {
  if ((video as unknown as Record<string, unknown>)[TAKEN]) return null;
  if (video.closest?.(`[${IGNORE_ATTRIBUTE}]`)) return null;
  if (options.skip && video.matches(options.skip)) return null;
  if (options.sources !== "any" && !hasStaticSource(video)) return null;
  if (options.filter && !options.filter(video)) return null;
  if (options.sourceCheck && !options.sourceCheck(declaredSources(video), video)) {
    return null;
  }
  if (!video.parentNode) return null;

  const player = document.createElement("movi-player");

  // Everything the page wrote, as it wrote it — including class and data-*,
  // which are how its CSS and its scripts find this element.
  for (const attr of Array.from(video.attributes)) {
    if (DROP_ATTRS.has(attr.name)) continue;
    try {
      player.setAttribute(attr.name, attr.value);
    } catch {
      /* an attribute name the element refuses is not worth failing over */
    }
  }
  // A src set as a PROPERTY (a blob URL from a file picker, say) never shows up
  // in the attributes.
  if (!player.hasAttribute("src") && video.src) {
    player.setAttribute("src", video.src);
  }
  // Before the caller's own attributes, so an explicit poster still wins.
  if (!player.hasAttribute("poster")) {
    const fromSkin = posterFromSkin(video);
    if (fromSkin) player.setAttribute("poster", fromSkin);
  }
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    player.setAttribute(name, value);
  }

  // The floor is what was there before.
  //
  // This element replaced a native <video>, and a native <video> plays a
  // cross-origin file without asking anyone's permission. Movi reads the bytes
  // itself, which needs CORS — so a source the browser was happily playing can
  // be one Movi cannot open at all. Archive.org is the plain example: it
  // redirects to a node that serves ranges without an Allow-Origin header, so
  // the fetch is blocked and the page that worked a moment ago shows an error.
  // Falling back to native there gives the page back exactly what it had, and
  // the WASM engine is a gain wherever it can read.
  if (!player.hasAttribute("fallback")) {
    player.setAttribute("fallback", "native");
  }

  // Which rung is on screen — read before the children move, because moving
  // a <video>'s <source> elements out from under it is a change of source,
  // and currentSrc does not survive the browser reconsidering.
  const playingNow = player.getAttribute("src") || video.currentSrc || "";

  // The children come across rather than being copied: <source> and <track>
  // carry the sources, the captions and the thumbnails, and the page may well
  // hold references to them.
  while (video.firstChild) player.appendChild(video.firstChild);

  // The id moves with it, so getElementById keeps finding "the player" — the
  // page's own scripts are written against that name. The old element keeps a
  // suffixed one so it is still reachable for anyone who wants it.
  const id = video.getAttribute("id");
  if (id) {
    video.setAttribute("id", `${id}-native`);
    player.setAttribute("id", id);
  }

  // A ladder the skin had and the element could not carry.
  //
  // Emitted as <source> children rather than as a src, because that is the
  // only shape that can say "these are the qualities" — and _parseChildSources
  // reads them ONLY when there is no src, so the one the video carried has to
  // come off. The rung the skin had selected stays the one that plays: it is
  // marked default, and the others become the quality menu.
  const ladder = ladderFromSkin(video, player);
  if (ladder.length > 1) {
    let resolvedPlaying = playingNow;
    try {
      resolvedPlaying = new URL(playingNow, document.baseURI).href;
    } catch {
      /* not a URL — nothing matches it, and the skin's own default stands */
    }
    player.removeAttribute("src");
    // When the ladder IS the children — a plain multi-source <video> — the
    // rungs that were read are the elements standing here. They go, and come
    // back carrying what the reader worked out about them.
    for (const old of Array.from(player.querySelectorAll("source"))) old.remove();
    for (const rung of ladder) {
      const el = document.createElement("source");
      el.setAttribute("src", rung.src);
      if (rung.type) el.setAttribute("type", rung.type);
      if (rung.label) el.setAttribute("data-label", rung.label);
      if (rung.height) el.setAttribute("data-height", String(rung.height));
      if (rung.bandwidth) el.setAttribute("data-bandwidth", String(rung.bandwidth));
      // What is on screen right now wins over what the config called default:
      // the viewer may have picked a rung before the upgrade reached them.
      if (rung.src === resolvedPlaying || (!resolvedPlaying && rung.isDefault)) {
        el.setAttribute("data-default", "");
      }
      player.appendChild(el);
    }
  }

  // Sit where the element being replaced sat.
  //
  // A <video> is inline-level by default, so a container that centres its
  // contents with text-align centres it. <movi-player> is a block, which
  // text-align does not reach — and a page that had its video in the middle
  // suddenly had it hard against the left edge, the same width as before and
  // in the wrong place. Measured on a centred 640px video in a 1100px page:
  // 320px of margin either side became 24 and 616.
  //
  // Centred with auto margins rather than by making the player inline-level:
  // inline-block shrinks to its contents, and the player's contents are a
  // canvas that sizes itself to the box — so it collapsed to nothing. A block
  // with auto margins is what centring a block means, and the player keeps
  // the width it works out for itself.
  //
  // Read BEFORE the element is hidden below: a hidden element computes to
  // display:none and would answer the wrong question. Only for a video the
  // page left inline-level — one a stylesheet or a skin has already made a
  // block is laid out by whatever made that choice.
  try {
    const parent = video.parentElement;
    const was = getComputedStyle(video).display;
    const inlineLevel = was === "inline" || was === "inline-block";
    const centred = parent && getComputedStyle(parent).textAlign === "center";
    if (inlineLevel && centred && !player.style.marginInline) {
      player.style.marginInline = "auto";
    }
  } catch {
    /* an element in a document that cannot be measured */
  }

  // A video file opened on its own — the tab's whole document is the browser's
  // viewer, a <body> holding nothing but this <video>. The browser's own sheet
  // for that page fits the video to the window (max-width and max-height 100%,
  // centred), and that sheet names the <video>, not us: the player sized itself
  // from the content instead, and a tall or large file ran past the bottom of
  // the window. Fill the window the viewer filled, and let the picture fit
  // inside it the way the native one did.
  try {
    // Asked of the document's type, not its shape. "A <body> holding only a
    // <video>" is also a hand-written test page, a bare embed, anybody's
    // minimal page — and pinning the player over the window there covered
    // everything the page put below it. The browser's viewer is a document
    // whose type is the file's own.
    const alone = /^(video|audio)\//i.test(video.ownerDocument?.contentType || "");
    if (alone) {
      player.style.position = "fixed";
      player.style.inset = "0";
      player.style.width = "100%";
      player.style.height = "100%";
      player.style.maxWidth = "none";
      player.style.maxHeight = "none";
      player.style.margin = "0";
    }
  } catch {
    /* a document that cannot be inspected */
  }

  // A video the page laid out of flow — the padding-box embed, a `position:
  // absolute` <video> pinned over a wrapper that reserves its space. The rule
  // that did the pinning usually names the TAG (`.player video`), and a
  // <movi-player> does not match it: the player dropped into the flow below
  // the space reserved for it, one whole picture-height down, and in an
  // iframe that is outside the frame entirely. Take the box the video had.
  try {
    const cs = getComputedStyle(video);
    if (
      (cs.position === "absolute" || cs.position === "fixed") &&
      !player.style.position
    ) {
      player.style.position = cs.position;
      const box = video.offsetParent as HTMLElement | null;
      const fills =
        !!box &&
        video.offsetLeft === 0 &&
        video.offsetTop === 0 &&
        Math.abs(video.offsetWidth - box.clientWidth) <= 1 &&
        Math.abs(video.offsetHeight - box.clientHeight) <= 1;
      if (fills) {
        player.style.inset = "0";
        player.style.width = "100%";
        player.style.height = "100%";
      } else {
        player.style.top = `${video.offsetTop}px`;
        player.style.left = `${video.offsetLeft}px`;
        player.style.width = `${video.offsetWidth}px`;
        player.style.height = `${video.offsetHeight}px`;
      }
    }
  } catch {
    /* an element in a document that cannot be measured */
  }

  // Inside a frame, the frame is the window: the page that embedded it gave it
  // a size and nothing beyond that size is ever seen. A player that takes its
  // height from the picture's shape — a 16:9 film in a wide, short embed —
  // ran past the bottom of the frame with its controls cut off. The native
  // <video> never did, because the page's own rules bounded it; hold the
  // player to the frame the same way.
  if (window.top !== window) {
    if (!player.style.maxWidth) player.style.maxWidth = "100vw";
    if (!player.style.maxHeight) player.style.maxHeight = "100vh";
  }

  video.parentNode.insertBefore(player, video);

  // Kept, not removed: a page holds references, and a removed element would
  // quietly stop answering. Hidden and inert instead, with its surface pointed
  // at the player (see FORWARD_PROPS).
  try {
    video.pause();
  } catch {
    /* already paused, or a source it never opened */
  }
  video.removeAttribute("autoplay");
  video.removeAttribute("controls");
  video.style.display = "none";

  // Let go of the film.
  //
  // The old element is kept for the page's sake, not to play anything — and a
  // hidden <video> with a source still loads it. Two consequences, both real:
  // the browser downloads and decodes the whole film a second time beside the
  // player that is actually showing it, and the element learns the film's
  // dimensions, which is how a page that fits its layout to videoWidth ends up
  // re-fitting the box it had already sized from the tag. Detached, it reports
  // what an element with nothing in it reports, and everything the page asks
  // it comes from the player instead (see FORWARD_PROPS).
  try {
    video.removeAttribute("src");
    video.load();
  } catch {
    /* an element that was never going to load anything anyway */
  }

  (video as unknown as Record<string, unknown>)[TAKEN] = true;
  (video as unknown as Record<string, unknown>).moviPlayer = player;

  if (options.proxy !== false) {
    const pacer = timeupdatePacer(player);
    forwardTo(video, player, !!video.closest?.(HOST_SKINS), pacer);
    relayMediaEvents(video, player, pacer);
    moveInputHandlers(video, player);
    // What only a script that ran before the page's own could have seen — see
    // VIDEO_HOOKS.
    try {
      (globalThis as unknown as Record<symbol, VideoHooks | undefined>)[VIDEO_HOOKS]?.handoff?.(
        video,
        player,
      );
    } catch {
      /* the page's own listeners and observers stay where they were */
    }
  }

  fitToHostSkin(video, player);
  keepAnsweredKeysFromSkin(video, player);
  hideHostChrome();
  if (!options.keepOverlays) hideOverlaysAfterLayout(player);

  return { video, player };
}

/**
 * Hide what the page left lying over the player.
 *
 * A site's own layers over its <video> — the big play button, the poster
 * image, a transparent click-catcher, the dark gradient under a custom bar —
 * stay behind when the element under them is replaced, and now sit over a
 * player with its own of each. The click-catcher is the one that hurts: every
 * click lands on it instead of on the player.
 *
 * Found by asking the page what is on top: points across the player's box are
 * hit-tested, and whatever answers before the player does is over it. Only
 * what sits (four-fifths or more) inside that box is hidden — a cookie banner
 * or a modal that happens to cross it is part of the page, not of the player.
 * Asked again a little later, because a page's player script often draws its
 * layers after the element is already there. `keepOverlays` turns it off.
 */
function hideOverlaysAfterLayout(player: HTMLElement): void {
  const sweep = () => {
    if (!player.isConnected) return;
    const box = player.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return;
    const doc = player.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;
    const over = new Set<Element>();
    const around = new Set<Element>();
    for (let i = 1; i <= 5; i++) {
      for (let j = 1; j <= 5; j++) {
        const x = box.left + (box.width * i) / 6;
        const y = box.top + (box.height * j) / 6;
        if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
        for (const el of doc.elementsFromPoint(x, y)) {
          if (el === player || player.contains(el)) break;
          if (el.contains(player)) {
            around.add(el);
            break;
          }
          over.add(el);
        }
      }
    }
    // A box the player sits INSIDE answering the hit test before the player
    // does. Its own background paints under its children, so what is on top is
    // one of its pseudo-elements — JW's idle `.jw-media::after` is the shape of
    // it: a layer drawn by the player's own parent, invisible to
    // elementsFromPoint (which names the parent, not the pseudo) and taking
    // every click meant for the player. It cannot be given an inline style;
    // it is marked, and the stylesheet hideHostChrome puts up takes it down.
    for (const el of around) {
      for (const pseudo of ["::after", "::before"] as const) {
        const cs = view.getComputedStyle(el, pseudo);
        if (!cs.content || cs.content === "none" || cs.content === "normal") continue;
        if (cs.position !== "absolute" && cs.position !== "fixed") continue;
        el.setAttribute(`data-movi-hide-${pseudo.slice(2)}`, "");
      }
    }
    for (const el of over) {
      if (el === doc.body || el === doc.documentElement) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (!(area > 0)) continue;
      const ix = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
      const iy = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
      if ((ix * iy) / area < 0.8) continue;
      (el as HTMLElement).style?.setProperty("visibility", "hidden", "important");
      el.setAttribute("data-movi-hidden-overlay", "");
    }
  };
  const view = player.ownerDocument.defaultView;
  view?.requestAnimationFrame(() => view.requestAnimationFrame(sweep));
  view?.setTimeout(sweep, 1000);
  view?.setTimeout(sweep, 3000);
}

/**
 * Take down the controls the page was drawing around this video.
 *
 * A page built on video.js is a <video> with a skin on top: replacing the
 * element leaves the skin behind, so the viewer gets two control bars, two
 * play buttons and two spinners, one of them over the other. The skin is not
 * removed and its player is not disposed — the page's scripts still hold it,
 * and it still works, because the element it drives is the hidden <video> that
 * forwards to ours. It is only stopped from drawing.
 *
 * Written as a stylesheet with !important rather than inline styles, because
 * the skin sets its own inline styles as it shows and hides itself and would
 * otherwise draw straight over the top again on the next mouse move. Put up
 * whenever anything is upgraded, without first looking for a skin: whether
 * there is one to hide depends on when that skin's own script runs, which is
 * as likely to be after this as before it. The rules match nothing on a page
 * that has none.
 */
/** The skins that own the box their video sits in. */
const HOST_SKINS = ".video-js, .vjs-container, .plyr, .jwplayer, .flowplayer, .shaka-video-container, .mejs__container";

/**
 * The picture a skin was showing before anyone pressed play.
 *
 * A `<video poster="…">` comes across with the rest of the attributes. A skin
 * does not use that attribute: video.js paints its own `.vjs-poster` div and
 * puts the image in its background, Plyr does the same with
 * `.plyr__poster`. The upgrade hides that div along with the rest of the
 * skin's furniture — correctly, it is the skin's chrome — and the poster went
 * with it, so a player that had a still frame a moment ago was a black box.
 *
 * Read from the computed style rather than the attribute, because that is
 * where the skin put it, and only the first url() of it: a background can be
 * a stack, and the poster is the image in it.
 */
function posterFromSkin(video: HTMLVideoElement): string {
  const skin = video.closest?.(HOST_SKINS);
  if (!skin) return "";
  const holder = skin.querySelector(".vjs-poster, .plyr__poster, .jw-preview");
  if (!holder) return "";
  let image = "";
  try {
    image = getComputedStyle(holder).backgroundImage || "";
  } catch {
    return "";
  }
  const found = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(image);
  const raw = found?.[2]?.trim();
  if (!raw || raw === "none") return "";
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return "";
  }
}

/**
 * The quality ladder a page was given, when it was given more than one.
 *
 * A <video> carries one file at a time: whichever rung the skin picked. The
 * rest of the ladder lives in the skin's own configuration, so an upgrade that
 * reads only the element inherits a single quality and no way to change it —
 * the player's quality menu is empty on a page that plainly had one, and the
 * viewer loses a control the site had given them.
 *
 * Three places to ask, because three shapes exist:
 *
 *  - JW keeps it on its playlist item: sources[] of { file, label, height,
 *    bitrate, default }. Its API is on the page, and so is this code.
 *  - video.js hangs the player off its own element (`el.player`), and
 *    currentSources() hands back every source it was configured with. The
 *    quality keys are not video.js's own — `label`, `res`, `size` come from
 *    whichever switcher plugin the site uses — so all of them are read.
 *  - Failing both, the <video>'s own <source> children, which is the ladder
 *    written in plain HTML and the one every skin is built over anyway.
 *
 * The first of those to offer more than one rung wins; a single rung is not a
 * ladder and leaves the ordinary src path alone.
 *
 * Manifests are left out. An .m3u8 or .mpd among the sources is an adaptive
 * stream with its own ladder inside it, and mixing the two would offer the
 * same qualities twice — once as rungs, once as whatever the manifest lists.
 */
interface SkinRung {
  src: string;
  label: string;
  height: number;
  bandwidth: number;
  type: string;
  isDefault: boolean;
}

/** A height out of whatever the page called the rung: "720p HD", "1080". */
function heightFromLabel(label: string): number {
  const found = /(\d{3,4})\s*p?\b/i.exec(label);
  return found ? Number(found[1]) : 0;
}

/**
 * One entry of a ladder, whatever shape the page wrote it in.
 *
 * Every key here is some player's spelling of the same four facts, so they
 * are all tried rather than branching per framework: JW says file/bitrate,
 * video.js says src/type, a switcher plugin says res or size, Plyr says size,
 * and a plain <source> says whatever its author felt like.
 */
function rungFrom(one: Record<string, unknown>): SkinRung | null {
  const raw =
    (typeof one.src === "string" && one.src) ||
    (typeof one.file === "string" && one.file) ||
    "";
  if (!raw || /\.(m3u8|mpd|ism)(\?|$)/i.test(raw)) return null;
  let href: string;
  try {
    href = new URL(raw, document.baseURI).href;
  } catch {
    return null;
  }
  const label = String(one.label ?? one.title ?? one.res ?? one.size ?? "");
  return {
    src: href,
    label,
    height: Number(one.height) || Number(one.res) || Number(one.size) ||
      heightFromLabel(label),
    bandwidth: Number(one.bitrate) || Number(one.bandwidth) || 0,
    type: typeof one.type === "string" ? one.type : "",
    isDefault: one.default === true || one.selected === true,
  };
}

function normaliseLadder(entries: unknown): SkinRung[] {
  if (!Array.isArray(entries) || entries.length < 2) return [];
  const rungs: SkinRung[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rung = rungFrom(entry as Record<string, unknown>);
    // A file offered twice is one rung: a page that lists the same mp4 under
    // two labels has a ladder of one, whatever it says.
    if (rung && !rungs.some((r) => r.src === rung.src)) rungs.push(rung);
  }
  // Several sources are not automatically a ladder. An mp4 with a webm beside
  // it is the oldest shape on the web — one film, written twice, so that
  // whichever the browser can open is the one it opens. Offering those as a
  // quality menu invents a choice the page never made, and labels it with
  // nothing, because a format fallback carries no height, no bitrate and no
  // name. A ladder says which rung is which; that is what tells them apart.
  const named = rungs.filter((r) => r.height || r.bandwidth || r.label);
  return named.length > 1 ? rungs : [];
}

/** What JW was configured with, asked of JW. */
function ladderFromJw(video: HTMLVideoElement): SkinRung[] {
  const container = video.closest?.(".jwplayer");
  if (!container) return [];
  const jw = (window as unknown as { jwplayer?: (id?: unknown) => unknown })
    .jwplayer;
  if (typeof jw !== "function") return [];
  try {
    // By element, not bare: jwplayer() with no argument hands back whichever
    // instance was made last, which on a page with more than one player is
    // not the one that owns this video.
    const instance = jw(container) as {
      getPlaylistItem?: () => { sources?: unknown };
    } | null;
    return normaliseLadder(instance?.getPlaylistItem?.()?.sources);
  } catch {
    return [];
  }
}

/** What video.js was configured with, asked of the player on its own element. */
function ladderFromVideoJs(video: HTMLVideoElement): SkinRung[] {
  const container = video.closest?.(".video-js, .vjs-container");
  if (!container) return [];
  // Reached through the element rather than the videojs global on purpose:
  // the player is attached there by video.js itself, so this works on a page
  // that keeps its copy of videojs to itself, and it cannot pick up the
  // wrong instance.
  const player = (container as { player?: unknown }).player as {
    currentSources?: () => unknown;
    options_?: { sources?: unknown };
  } | null;
  if (!player) return [];
  try {
    const ladder = normaliseLadder(player.currentSources?.());
    return ladder.length > 1 ? ladder : normaliseLadder(player.options_?.sources);
  } catch {
    return [];
  }
}

/**
 * The ladder in plain HTML, which is what a skin is usually built over.
 *
 * Read off the PLAYER, not the video: by the time this is asked the children
 * have already moved across, and the element they came from is empty.
 */
function ladderFromChildren(player: HTMLElement): SkinRung[] {
  const kids = player.querySelectorAll?.("source");
  if (!kids || kids.length < 2) return [];
  const entries: Record<string, unknown>[] = [];
  for (const kid of Array.from(kids)) {
    const attr = (name: string) => kid.getAttribute(name) ?? undefined;
    entries.push({
      src: attr("src"),
      type: attr("type"),
      label: attr("label") ?? attr("data-label") ?? attr("title"),
      res: attr("res") ?? attr("data-res"),
      size: attr("size") ?? attr("data-size"),
      height: attr("data-height"),
      bitrate: attr("data-bandwidth") ?? attr("data-bitrate"),
      default: kid.hasAttribute("default") || kid.hasAttribute("data-default"),
    });
  }
  return normaliseLadder(entries);
}

function ladderFromSkin(
  video: HTMLVideoElement,
  player: HTMLElement,
): SkinRung[] {
  const jw = ladderFromJw(video);
  if (jw.length > 1) return jw;
  const vjs = ladderFromVideoJs(video);
  if (vjs.length > 1) return vjs;
  return ladderFromChildren(player);
}

/**
 * Inside a skin, the page owns the box — say so, in the only way that is
 * heard.
 *
 * A player with no size given to it works out its own from the film, which is
 * right on a page that put it there and left it alone, and wrong here: the
 * skin already has a box, sized to the page, and the film is very often a
 * different shape from it. A 2.39:1 film in a 16:9 skin sizes itself to 67% of
 * the height the page allowed — a player that is suddenly, visibly short.
 *
 * It does not show while the skin's own height holds, because a CSS height
 * beats an aspect ratio. It shows the moment that height wobbles, which is
 * what a fullscreen transition is: the skin re-lays out around it and the
 * player comes back the shape of the FILM rather than the shape of the box.
 *
 * So the box is taken outright, as the skin's own tech rules would have done
 * for the <video> that was there — and an inline height is also what tells the
 * player to stop working one out (see applyIntrinsicAspect in the element).
 */
function fitToHostSkin(video: HTMLVideoElement, player: HTMLElement): void {
  if (!video.closest?.(HOST_SKINS)) return;
  if (!player.style.width) player.style.width = "100%";
  if (player.style.height) return;
  if (heightComesFromThePage(player)) return;
  player.style.height = "100%";
}

/**
 * Not every skin's box has a height of its own. Plyr's wraps the <video> and
 * is as tall as the video makes it, and the page sizes the VIDEO: an embed
 * with `#target { width: 100%; height: 100vh }` under a Plyr skin. The id
 * moved across to the player and that rule matched it, but the inline 100%
 * above beat it, and 100% of a box with no height of its own is no height
 * at all — the player fell back to its 16:9 box, which on a wide window is
 * taller than the window, and the page's `overflow: hidden` cut the controls
 * off the bottom.
 *
 * So where the box would collapse without its contents and the page's own
 * rules already give the player a height, those rules are left to do it.
 * Anything else gets the 100% as before.
 *
 * "A rule gives it a height" is asked of the player, not compared with the
 * video: the id that carried the rule across has left the video, so the
 * hidden element no longer matches it and measures 0. A height that stays put
 * under two very different aspect ratios is one a rule set; a height the
 * element is working out for itself follows the ratio.
 */
function heightComesFromThePage(player: HTMLElement): boolean {
  const box = player.parentElement;
  if (!box) return false;
  const display = player.style.display;
  const ratio = player.style.aspectRatio;
  try {
    player.style.display = "none";
    const ownHeight = box.getBoundingClientRect().height;
    player.style.display = display;
    if (ownHeight > 1) return false; // the box has a height to fill
    player.style.aspectRatio = "1 / 1";
    const square = player.getBoundingClientRect().height;
    player.style.aspectRatio = "4 / 1";
    const wide = player.getBoundingClientRect().height;
    return square > 0 && Math.abs(square - wide) <= 1;
  } catch {
    return false;
  } finally {
    player.style.display = display;
    player.style.aspectRatio = ratio;
  }
}

/**
 * A key the player answered is not the skin's to answer again.
 *
 * Skins keep their own shortcuts on the box around the video, and the press
 * bubbles out of the player into it. Plyr has L for loop and M for mute, the
 * same letters as ours: the player flipped the loop, Plyr flipped the hidden
 * element's back, and the forwarded property carried that to the player, so
 * L never changed anything. Play/pause survived only because the toggle
 * guard in forwardTo already catches a second answer to one gesture.
 *
 * The player's own keydown listener is added in its constructor, so this one
 * runs after it and can see whether the press was taken.
 */
function keepAnsweredKeysFromSkin(video: HTMLVideoElement, player: HTMLElement): void {
  if (!video.closest?.(HOST_SKINS)) return;
  player.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) e.stopPropagation();
  });
}

const HOST_CHROME_STYLE_ID = "movi-upgrade-host-chrome";

function hideHostChrome(): void {
  if (document.getElementById(HOST_CHROME_STYLE_ID)) return;
  // Keyed on the skin CONTAINING a player rather than on a class put there at
  // upgrade time: video.js builds its skin when its own script runs, which may
  // be before this or after it, and a class added to the element it is about
  // to rebuild around is a class that will not be there afterwards.
  const vjs = ".video-js:has(> movi-player)";
  const plyr = ".plyr:has(movi-player)";
  // JW nests the media, and deeper than it looks: .jwplayer holds a
  // .jw-wrapper, that holds .jw-media, and the <video> is inside THAT, with
  // every piece of chrome a sibling of .jw-media. So neither the skin nor its
  // chrome is reachable by the direct-child pattern the other two use.
  const jw = ".jwplayer:has(movi-player)";
  // The extension hides the same chrome before the upgrade gets here
  // (chrome-extension/early.js), so it never flashes up first. Keep the two
  // lists in step.
  const style = document.createElement("style");
  style.id = HOST_CHROME_STYLE_ID;
  style.textContent = [
    [
      `${vjs} > .vjs-control-bar`,
      `${vjs} > .vjs-big-play-button`,
      `${vjs} > .vjs-poster`,
      `${vjs} > .vjs-loading-spinner`,
      `${vjs} > .vjs-text-track-display`,
      `${vjs} > .vjs-title-bar`,
      `${vjs} > .vjs-modal-dialog`,
      `${vjs} > .vjs-error-display`,
      `${plyr} > .plyr__controls`,
      `${plyr} > .plyr__control--overlaid`,
      // Everything JW paints over its media: the poster, the whole controls
      // layer (big play button and bar alike), the title, the captions it
      // renders itself, the overlay stack, the logo and its error card.
      // DESCENDANTS, not children. JW 8 puts everything inside a .jw-wrapper
      // — .jwplayer > .jw-wrapper > { .jw-media, .jw-preview, .jw-controls,
      // … } — so a direct-child rule written against .jwplayer matches none of
      // it. Measured on a page with the real wrapper: every one of these was
      // still on screen. Safe as a descendant because our element is a
      // <movi-player> and every class below is JW's own.
      `${jw} .jw-preview`,
      `${jw} .jw-controls`,
      `${jw} .jw-controls-backdrop`,
      `${jw} .jw-title`,
      `${jw} .jw-captions`,
      `${jw} .jw-overlays`,
      `${jw} .jw-logo`,
      `${jw} .jw-error-msg`,
      // The layer JW lays over the media while it is idle — before play, and
      // again at the end. It belongs to .jw-media, the box the player now sits
      // in, so it is drawn over the player and takes its clicks.
      `${jw} .jw-media::after`,
      // Pseudo-element layers the overlay sweep found over the player on
      // any page — see hideOverlaysAfterLayout.
      "[data-movi-hide-after]::after",
      "[data-movi-hide-before]::before",
    ].join(",\n") + " { display: none !important; }",
    // The skin hides the pointer while it believes the viewer is idle. Ours
    // decides that for itself now, and its own bar is what the pointer is
    // being moved towards.
    `${vjs} { cursor: auto !important; }`,
    `${jw} { cursor: auto !important; }`,
    // Plyr sizes its video with a `video` selector, which no longer matches
    // anything, so the player is given the box. NOT for video.js: it sizes
    // whatever carries .vjs-tech, and our element carries it — forcing a size
    // on top of that is a second opinion about the layout, in !important, with
    // nothing to gain.
    `${plyr} > movi-player { width: 100% !important; height: 100% !important; }`,
  ].join("\n");
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Point the old element's API at the new one.
 *
 * Own properties are defined on the instance, which shadow the prototype's —
 * so `video.currentTime = 30` reaches the player, and every listener the page
 * added later is added to the player instead.
 */
/**
 * The film's own dimensions, which a skin's page measures its layout with.
 *
 * Kept off the forwarded surface inside a skin. The page sized its box before
 * anything had loaded — from the tag, from the window, from its own fit — and
 * that box is the one it laid out around. Handing it the film's numbers makes
 * it re-fit to the FILM on the next thing that prompts a re-fit, which is a
 * resize, which is also what leaving fullscreen is: a 2.39:1 film in a 16:9
 * box takes two thirds of the height the page had allowed, and the player
 * appears to shrink for no reason the viewer can see.
 *
 * The player still answers for itself — `document.querySelector("movi-player")
 * .videoWidth` is the film's width — and outside a skin the old element
 * answers too, because there the page's box IS the video's box and there is
 * nothing to protect.
 */
const SKIN_UNSAFE_PROPS = new Set(["videoWidth", "videoHeight"]);

/**
 * Is this src write asking for a different film, or re-stating the one that is
 * already playing?
 *
 * A skin re-asserts its own source as a matter of course — on a state change,
 * when an ad break ends, when it re-runs its setup. The player's own setter
 * disposes and re-initialises on every assignment, because a host writing to
 * it means a new source; forwarded from a skin the same write means nothing
 * of the kind. Measured on an upgraded element: three re-assertions of the
 * identical URL, three restarts, the position back to zero each time.
 *
 * Compared resolved, because a skin may write the relative form of the URL it
 * was given absolutely.
 */
function sameSource(current: unknown, next: unknown): boolean {
  if (current === next) return true;
  if (typeof current !== "string" || typeof next !== "string") return false;
  if (!current || !next) return false;
  try {
    return (
      new URL(current, document.baseURI).href ===
      new URL(next, document.baseURI).href
    );
  } catch {
    return false;
  }
}

/** The `<source>` children the player is choosing between, as URLs. */
function childSources(player: HTMLElement): string[] {
  return Array.from(player.querySelectorAll(":scope > source")).map(
    (s) => (s as HTMLSourceElement).src || s.getAttribute("src") || "",
  );
}

/**
 * Is this URL one of the qualities the player already carries?
 *
 * Only for a ladder — rungs the upgrade wrote out with a label or a height
 * (see ladderFromSkin). A plain mp4-and-webm pair is two formats, not two
 * qualities, and a page picking one of them is picking a source.
 */
function isRungOf(player: HTMLElement, value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const rungs = player.querySelectorAll(
    ":scope > source[data-label], :scope > source[data-height]",
  );
  if (rungs.length < 2) return false;
  return Array.from(rungs).some((rung) =>
    sameSource((rung as HTMLSourceElement).src, value),
  );
}

/**
 * How often a <video> says timeupdate: every 15 to 250ms, by the spec, and
 * about every 250 in practice.
 */
const TIMEUPDATE_MS = 250;

/**
 * timeupdate at a <video>'s pace, for the page's listeners.
 *
 * The player says it about every frame — its own bar is drawn from it — which
 * measured at ~50 a second. A skin does real work on each one (JW turns every
 * one into a `time` event, and its plugins and the page's analytics hang off
 * that), and it was written for four. The player keeps its pace for itself;
 * what the page hears is thinned to the native one. The one after a seek
 * always goes through, because a native element sends one there too and a
 * page moves its own clock on it.
 *
 * Returns a factory: one gate per listener, so two listeners do not share —
 * and starve — one budget.
 */
function timeupdatePacer(player: HTMLElement): () => () => boolean {
  let seeks = 0;
  player.addEventListener("seeked", () => seeks++);
  return () => {
    let last = -Infinity;
    let seen = seeks;
    return () => {
      const now = performance.now();
      if (seen === seeks && now - last < TIMEUPDATE_MS) return false;
      last = now;
      seen = seeks;
      return true;
    };
  };
}

/** How long after a swallowed rung swap its follow-up seek is still its own. */
const SWAP_ECHO_MS = 3000;

function forwardTo(
  video: HTMLVideoElement,
  player: HTMLElement,
  insideSkin: boolean,
  pacer: () => () => boolean,
): void {
  const target = player as unknown as Record<string, unknown>;
  // One paced stand-in per timeupdate listener, so removeEventListener with
  // the page's own function finds the one that was added.
  const paced = new WeakMap<object, EventListener>();
  const pacedListener = (listener: EventListenerOrEventListenerObject): EventListener => {
    let stand = paced.get(listener);
    if (!stand) {
      const pass = pacer();
      stand = function (this: unknown, event: Event) {
        if (!pass()) return;
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      paced.set(listener, stand);
    }
    return stand;
  };
  // What the last load() — or the page's last src — already loaded, so a
  // load() that asks for nothing new can be told apart from one that does.
  let loadedChildren = childSources(player).join("\n");
  let swallowedSwapAt = -Infinity;
  for (const name of FORWARD_PROPS) {
    if (insideSkin && SKIN_UNSAFE_PROPS.has(name)) continue;
    try {
      Object.defineProperty(video, name, {
        configurable: true,
        get: () => target[name],
        set: (value: unknown) => {
          // Re-stating the current source is not a request to start over.
          // Only src: every other forwarded property is cheap to set again.
          if (name === "src" && sameSource(target[name], value)) return;
          // The page switching quality behind the player's back. A skin's own
          // quality logic — its "auto", its stall watchdog — keeps running on
          // the hidden element and changes rung the only way a <video> can: a
          // new src, then load(), then a seek back to where it was. Each one
          // of those reached the player as a brand new source, which is a
          // dispose and a cold open, from the start: the film restarted every
          // time the skin changed its mind. The rungs are the player's own
          // quality menu now, and its own ABR picks between them.
          if (name === "src" && isRungOf(player, value)) {
            swallowedSwapAt = performance.now();
            Logger.info(TAG, `Page asked for another rung (${String(value)}); the player keeps its own`);
            return;
          }
          // …and the seek that puts it "back" where it already is. Within a
          // second of the picture is the same place; a real seek is further.
          if (
            name === "currentTime" &&
            performance.now() - swallowedSwapAt < SWAP_ECHO_MS &&
            typeof value === "number" &&
            Math.abs(value - Number(target.currentTime)) < 1
          ) {
            return;
          }
          target[name] = value;
          if (name === "src") loadedChildren = childSources(player).join("\n");
        },
      });
    } catch {
      /* a property the browser will not let us shadow stays as it was */
    }
  }
  for (const name of FORWARD_METHODS) {
    try {
      Object.defineProperty(video, name, {
        configurable: true,
        writable: true,
        value: (...given: unknown[]) => {
          let args = given;
          if (
            (name === "addEventListener" || name === "removeEventListener") &&
            args[0] === "timeupdate" &&
            args[1] &&
            (typeof args[1] === "function" || typeof args[1] === "object")
          ) {
            args = [args[0], pacedListener(args[1] as EventListenerOrEventListenerObject), ...args.slice(2)];
          }
          // One click, one toggle. A page that toggles on a click of its own
          // — a listener on the video, or on the box around it — hears the
          // same click the player just answered, reads the new state through
          // this proxy, and turns it straight back: pause, then play again.
          // A play()/pause() that would undo the player's toggle from the
          // same click is the page answering that click a second time.
          if (
            (name === "play" || name === "pause") &&
            (player as { _revertsThisGesture?: (wantPaused: boolean) => boolean })
              ._revertsThisGesture?.(name === "pause")
          ) {
            return name === "play" ? Promise.resolve() : undefined;
          }
          // load() is decided by the player's own guard below, so that a page
          // reaching the player directly is answered the same way.
          return (target[name] as ((...a: unknown[]) => unknown) | undefined)?.apply(
            player,
            args,
          );
        },
      });
    } catch {
      /* ditto */
    }
  }

  // load() starts the element over on whatever it now declares. A new src
  // already did that (the player loads on the assignment), and one the player
  // swallowed above has nothing to load; a skin's watchdog calling load() to
  // "recover" a player that is fine is a restart for nothing. Only a changed
  // set of <source> children, which the page may still hold and rewrite, is
  // news.
  //
  // Asked by the player itself, not only by the hidden element: the id moves
  // across, so a page that finds its video by id holds the PLAYER. An embed
  // under Plyr does exactly that on its first play (pause, `load()`, wait for
  // loadeddata, play), and the call went straight to the player's load(): a
  // cold open from the start, throwing away every second buffered while the
  // poster sat there (34.6MB, 124s, on the session that found it).
  //
  // A <video> answers load() with loadeddata and canplay again, and that page
  // calls play() only when it hears them. A swallowed load() that said
  // nothing left the film paused for good, so the player says them again.
  // Not while it has nothing to say: no player, a load in flight, or an
  // error, where a fresh load is exactly what is wanted.
  (player as { _pageLoadGuard?: () => boolean })._pageLoadGuard = () => {
    const now = childSources(player).join("\n");
    if (now !== loadedChildren) {
      loadedChildren = now;
      return false;
    }
    const state = (player as { player?: { getState?: () => string } | null }).player?.getState?.();
    if (!state || state === "idle" || state === "loading" || state === "error") return false;
    Logger.info(TAG, "Page asked to load() the film already loaded; the player keeps its buffer");
    setTimeout(() => {
      for (const name of ["loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) {
        try {
          player.dispatchEvent(new Event(name));
        } catch {
          /* a listener that throws is the page's, not ours */
        }
      }
    }, 0);
    return true;
  };

  // The attribute is the other way a page points a <video> at a file, and it
  // went to the hidden element: the page's next film never reached the
  // player, and the hidden element — whose own source the upgrade took away
  // so it would not fetch the film twice — started fetching it. Sent the way
  // the property goes, with the same checks for a source that is not new.
  const setAttribute = video.setAttribute;
  try {
    Object.defineProperty(video, "setAttribute", {
      configurable: true,
      writable: true,
      value: (qualifiedName: string, value: string) => {
        if (String(qualifiedName).toLowerCase() === "src") {
          (video as unknown as { src: string }).src = value;
          return;
        }
        setAttribute.call(video, qualifiedName, value);
      },
    });
  } catch {
    /* ditto */
  }

  // Fullscreen, asked of the old element: a site's own button, or iOS's
  // webkit* pair that only a <video> has. The hidden element cannot be shown
  // fullscreen at all, so all of it goes to the player's own route — the one
  // its button takes, with the host and iOS fallbacks the bare element API
  // does not have.
  const fs = player as unknown as {
    _enterFullscreenForPage?: () => Promise<void>;
    _isFullscreenForPage?: () => boolean;
    exitFullscreen?: () => void;
  };
  const enter = () => fs._enterFullscreenForPage?.() ?? Promise.resolve();
  const exit = () => fs.exitFullscreen?.();
  const methods: Record<string, () => unknown> = {
    requestFullscreen: enter,
    webkitRequestFullscreen: enter,
    webkitEnterFullscreen: enter,
    webkitEnterFullScreen: enter,
    webkitExitFullscreen: exit,
    webkitExitFullScreen: exit,
  };
  for (const [name, value] of Object.entries(methods)) {
    try {
      Object.defineProperty(video, name, { configurable: true, writable: true, value });
    } catch {
      /* ditto */
    }
  }
  const getters: Record<string, () => boolean> = {
    webkitDisplayingFullscreen: () => !!fs._isFullscreenForPage?.(),
    webkitSupportsFullscreen: () => true,
  };
  for (const [name, get] of Object.entries(getters)) {
    try {
      Object.defineProperty(video, name, { configurable: true, get });
    } catch {
      /* ditto */
    }
  }
}

/**
 * The listeners and observers a page attached to its <video> before the
 * upgrade could see it.
 *
 * Nothing can list an element's listeners after the fact, so they can only be
 * moved if something was watching when they were added — a script that runs
 * before the page's own. The extension installs one (chrome-extension/
 * early.js) while its takeover is on; it records addEventListener calls and
 * Intersection/ResizeObserver targets on media elements, and hands them to
 * the player here. A page using this library directly has no such script and
 * keeps what forwardTo and relayMediaEvents give it.
 */
const VIDEO_HOOKS = Symbol.for("movi-player.video-hooks");

interface VideoHooks {
  handoff?: (video: HTMLVideoElement, player: HTMLElement) => void;
}

/**
 * Input handlers the page set as properties — `video.onclick = …`. A <video>
 * with display:none is never clicked, so the ones already set move to the
 * player, and the ones set later go straight there. Media handlers
 * (`onplaying`) stay on the element: relayMediaEvents dispatches there.
 */
const INPUT_HANDLERS = [
  "onclick",
  "ondblclick",
  "oncontextmenu",
  "onmousedown",
  "onmouseup",
  "onmousemove",
  "onmouseenter",
  "onmouseleave",
  "onmouseover",
  "onmouseout",
  "onpointerdown",
  "onpointerup",
  "onpointermove",
  "onpointerenter",
  "onpointerleave",
  "onpointercancel",
  "ontouchstart",
  "ontouchend",
  "ontouchmove",
  "onwheel",
  "onkeydown",
  "onkeyup",
  "onkeypress",
  "onfocus",
  "onblur",
] as const;

function moveInputHandlers(video: HTMLVideoElement, player: HTMLElement): void {
  const from = video as unknown as Record<string, unknown>;
  const to = player as unknown as Record<string, unknown>;
  for (const name of INPUT_HANDLERS) {
    try {
      const set = from[name];
      if (typeof set === "function" && !to[name]) {
        to[name] = set;
        from[name] = null;
      }
      Object.defineProperty(video, name, {
        configurable: true,
        get: () => to[name],
        set: (value: unknown) => {
          to[name] = value;
        },
      });
    } catch {
      /* a handler the browser will not let us shadow stays as it was */
    }
  }
}

/**
 * What a <video> tells its listeners, and what the player tells them now.
 *
 * Deliberately not `error`, `emptied`, `abort` or `loadstart`: the player
 * says those about its own work — a rung switch, a fallback to the native
 * element — and a skin hearing them from its <video> takes them as the film
 * failing or being replaced, and acts on it.
 */
const RELAYED_MEDIA_EVENTS = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "durationchange",
  "play",
  "playing",
  "pause",
  "waiting",
  "seeking",
  "seeked",
  "timeupdate",
  "progress",
  "ended",
  "volumechange",
  "ratechange",
  "resize",
  "enterpictureinpicture",
  "leavepictureinpicture",
] as const;

/**
 * Tell the listeners the page put on its <video> BEFORE the upgrade what the
 * player is doing.
 *
 * forwardTo moves every listener added from now on across to the player. The
 * ones already there stay on the element — hidden, and never going to play —
 * and a player skin attaches its listeners the moment it builds its <video>,
 * which is before the upgrade can see it. So the skin never heard `playing`:
 * JW sat in "paused" through the whole film, and never fired its own `play`
 * event. A page that waits for that event to judge the player healthy then
 * judged it stuck — mat6tube arms a 15s "ad stuck" timer on every ad break,
 * cleared only by JW's `play`, and answers it with jwplayer().setup(): a new
 * <video>, a new player, and the film back at 0:00.
 *
 * Re-dispatched on the element itself, through the prototype's dispatchEvent
 * because forwardTo has pointed the element's own at the player. Listeners
 * added after the upgrade live on the player, not here, so nothing hears an
 * event twice.
 */
function relayMediaEvents(
  video: HTMLVideoElement,
  player: HTMLElement,
  pacer: () => () => boolean,
): void {
  const dispatch = EventTarget.prototype.dispatchEvent;
  const timeupdateDue = pacer();
  for (const name of RELAYED_MEDIA_EVENTS) {
    player.addEventListener(name, () => {
      if (name === "timeupdate" && !timeupdateDue()) return;
      try {
        dispatch.call(video, new Event(name));
      } catch {
        /* a listener that throws is the page's, not ours */
      }
    });
  }
}

/**
 * Replace `<video>` elements with `<movi-player>`.
 *
 * @param target A selector, an element, a list of them, or the options object.
 * @param maybeOptions Options, when the first argument named what to upgrade.
 * @returns The upgrades performed. With `watch: true` the returned array also
 *   carries a `stop()` that ends the watching.
 */
export function upgradeVideoElements(
  target?: string | HTMLVideoElement | ArrayLike<HTMLVideoElement> | UpgradeOptions,
  maybeOptions: UpgradeOptions = {},
): UpgradedVideo[] & { stop?: () => void } {
  let options: UpgradeOptions = maybeOptions;
  let scope: string | HTMLVideoElement | ArrayLike<HTMLVideoElement> | undefined;

  if (
    target &&
    typeof target === "object" &&
    !("nodeType" in target) &&
    !("length" in target)
  ) {
    options = target as UpgradeOptions;
  } else {
    scope = target as string | HTMLVideoElement | ArrayLike<HTMLVideoElement>;
  }

  const root: ParentNode = options.root ?? document;
  const collect = (): HTMLVideoElement[] => {
    if (typeof scope === "string") {
      return Array.from(root.querySelectorAll<HTMLVideoElement>(scope));
    }
    if (scope && "nodeType" in scope) return [scope as HTMLVideoElement];
    if (scope && "length" in scope) return Array.from(scope);
    return Array.from(root.querySelectorAll<HTMLVideoElement>("video"));
  };

  const done: UpgradedVideo[] & { stop?: () => void } = [];
  for (const video of collect()) {
    const upgraded = upgradeOne(video, options);
    if (upgraded) done.push(upgraded);
  }
  if (done.length > 0) {
    Logger.info(TAG, `Upgraded ${done.length} <video> element(s) to movi-player`);
  }

  if (options.watch) {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          const target = record.target;
          if (target instanceof HTMLVideoElement) upgradeOne(target, options);
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          const videos =
            node.tagName === "VIDEO"
              ? [node as HTMLVideoElement]
              : Array.from(node.querySelectorAll<HTMLVideoElement>("video"));
          for (const video of videos) upgradeOne(video, options);
        }
      }
    });
    observer.observe(root === document ? document.documentElement : (root as Node), {
      childList: true,
      subtree: true,
      // A <video> is routinely in the page before it has anything to play, and
      // under the "static" rule it is not a candidate until it does. Watching
      // the attribute is what lets the one that gains a file be taken over,
      // without the ones that never will being touched.
      attributes: true,
      attributeFilter: ["src"],
    });
    done.stop = () => observer.disconnect();
  }

  return done;
}

/**
 * `data-upgrade` on the script tag that loads this bundle — the takeover with
 * no JavaScript of your own:
 *
 * ```html
 * <script type="module" src="https://cdn…/element.js" data-upgrade></script>
 * <video src="movie.mkv" controls></video>
 * ```
 *
 * The attribute's value is a selector when you want to narrow it
 * (`data-upgrade="video.hero"`); `data-upgrade-watch` keeps upgrading elements
 * that appear later, and `data-upgrade-attrs` is JSON put on every player it
 * makes. Module scripts run after the document is parsed, so the `<video>`
 * elements are already there when this fires.
 */
function autoUpgradeFromScriptTag(): void {
  if (typeof document === "undefined") return;
  const tag = document.querySelector("script[data-upgrade]");
  if (!tag) return;
  const selector = (tag.getAttribute("data-upgrade") || "").trim();
  let attributes: Record<string, string> | undefined;
  const raw = tag.getAttribute("data-upgrade-attrs");
  if (raw) {
    try {
      attributes = JSON.parse(raw) as Record<string, string>;
    } catch {
      Logger.warn(TAG, "data-upgrade-attrs is not valid JSON — ignoring it");
    }
  }
  const options: UpgradeOptions = {
    watch: tag.hasAttribute("data-upgrade-watch"),
    ...(attributes ? { attributes } : {}),
  };
  if (selector) upgradeVideoElements(selector, options);
  else upgradeVideoElements(options);
}

autoUpgradeFromScriptTag();

/** The player that took over a given `<video>`, if one did. */
export function playerFor(video: HTMLVideoElement): HTMLElement | null {
  return (
    ((video as unknown as Record<string, unknown>).moviPlayer as HTMLElement) ??
    null
  );
}
