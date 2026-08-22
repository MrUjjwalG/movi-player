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
 */

import { Logger } from "./utils/Logger";

const TAG = "upgrade";

/** Marks an element that has already been taken over, so a second pass skips it. */
const TAKEN = "__moviUpgraded";

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
] as const;

const FORWARD_METHODS = [
  "play",
  "pause",
  "load",
  "canPlayType",
  "requestPictureInPicture",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
] as const;

function upgradeOne(
  video: HTMLVideoElement,
  options: UpgradeOptions,
): UpgradedVideo | null {
  if ((video as unknown as Record<string, unknown>)[TAKEN]) return null;
  if (options.skip && video.matches(options.skip)) return null;
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
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    player.setAttribute(name, value);
  }

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

  (video as unknown as Record<string, unknown>)[TAKEN] = true;
  (video as unknown as Record<string, unknown>).moviPlayer = player;

  if (options.proxy !== false) forwardTo(video, player);

  return { video, player };
}

/**
 * Point the old element's API at the new one.
 *
 * Own properties are defined on the instance, which shadow the prototype's —
 * so `video.currentTime = 30` reaches the player, and every listener the page
 * added later is added to the player instead.
 */
function forwardTo(video: HTMLVideoElement, player: HTMLElement): void {
  const target = player as unknown as Record<string, unknown>;
  for (const name of FORWARD_PROPS) {
    try {
      Object.defineProperty(video, name, {
        configurable: true,
        get: () => target[name],
        set: (value: unknown) => {
          target[name] = value;
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
        value: (...args: unknown[]) =>
          (target[name] as ((...a: unknown[]) => unknown) | undefined)?.apply(
            player,
            args,
          ),
      });
    } catch {
      /* ditto */
    }
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
    });
    done.stop = () => observer.disconnect();
  }

  return done;
}

/** The player that took over a given `<video>`, if one did. */
export function playerFor(video: HTMLVideoElement): HTMLElement | null {
  return (
    ((video as unknown as Record<string, unknown>).moviPlayer as HTMLElement) ??
    null
  );
}
