/**
 * The listeners and observers a page puts on its <video> before the takeover
 * can see it — kept, so the takeover can hand them to the player.
 *
 * The takeover hides the page's <video> and puts <movi-player> in its place.
 * Anything the page attaches to the video afterwards is pointed at the player
 * (see forwardTo in src/upgrade.ts). What it attached BEFORE stays on a hidden
 * element that is never clicked, never sized and never on screen, and nothing
 * can list an element's listeners after the fact. A player skin attaches all
 * of it the moment it builds its <video>, which is before any takeover:
 *
 *  - a click or key listener on the video — the site's own play/pause, its
 *    shortcuts — silently stopped working;
 *  - an IntersectionObserver on the video reported it permanently off screen,
 *    which is what "pause when scrolled away" and ad viewability act on;
 *  - a ResizeObserver on it reported a 0x0 box.
 *
 * So this runs first — document_start, in the page's world — and only
 * records. Registered by background.js while "Take over page videos" is on,
 * and never otherwise: every page's addEventListener and observers go through
 * it, and a page the takeover will not touch should not pay for that.
 *
 * Media events (`playing`, `timeupdate`…) are not recorded: the upgrade
 * re-dispatches those on the hidden element (relayMediaEvents), where their
 * listeners already are.
 *
 * The protocol is one function, `handoff(video, player)`, on
 * globalThis[Symbol.for("movi-player.video-hooks")] — src/upgrade.ts calls it.
 */
(() => {
  const KEY = Symbol.for("movi-player.video-hooks");
  if (globalThis[KEY]) return;

  const MEDIA_EVENTS = new Set([
    "abort", "canplay", "canplaythrough", "durationchange", "emptied",
    "encrypted", "ended", "error", "loadeddata", "loadedmetadata", "loadstart",
    "pause", "play", "playing", "progress", "ratechange", "resize", "seeked",
    "seeking", "stalled", "suspend", "timeupdate", "volumechange", "waiting",
    "waitingforkey", "enterpictureinpicture", "leavepictureinpicture",
  ]);

  const isMedia = (el) =>
    typeof HTMLMediaElement !== "undefined" && el instanceof HTMLMediaElement;
  const captureOf = (options) =>
    typeof options === "boolean" ? options : !!(options && options.capture);

  // ─── listeners ──────────────────────────────────────────────────────────
  // media element → [{ type, listener, options }]
  const listeners = new WeakMap();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;

  // Proxies rather than plain functions: they keep the native name, length
  // and "[native code]" string a page may check.
  EventTarget.prototype.addEventListener = new Proxy(nativeAdd, {
    apply(target, self, args) {
      try {
        const [type, listener, options] = args;
        if (listener && isMedia(self) && !MEDIA_EVENTS.has(type)) {
          let list = listeners.get(self);
          if (!list) listeners.set(self, (list = []));
          const capture = captureOf(options);
          if (!list.some((l) => l.type === type && l.listener === listener && captureOf(l.options) === capture)) {
            list.push({ type, listener, options });
          }
        }
      } catch {
        /* recording is best-effort; the page's call is not */
      }
      return Reflect.apply(target, self, args);
    },
  });
  EventTarget.prototype.removeEventListener = new Proxy(nativeRemove, {
    apply(target, self, args) {
      try {
        const [type, listener, options] = args;
        const list = isMedia(self) && listeners.get(self);
        if (list) {
          const capture = captureOf(options);
          const at = list.findIndex((l) => l.type === type && l.listener === listener && captureOf(l.options) === capture);
          if (at >= 0) list.splice(at, 1);
        }
      } catch {
        /* ditto */
      }
      return Reflect.apply(target, self, args);
    },
  });

  // ─── observers ──────────────────────────────────────────────────────────
  // Observing the player in the video's place, and handing the page entries
  // that name its video — a callback that looks its state up by
  // entry.target must still find it.
  const observerKinds = [];

  const hookObserver = (name, remap) => {
    const Native = globalThis[name];
    if (typeof Native !== "function") return;
    const nativeObserve = Native.prototype.observe;
    const nativeUnobserve = Native.prototype.unobserve;
    const nativeDisconnect = Native.prototype.disconnect;
    // observer → Map(player → video): the players it watches for a video.
    const standIns = new WeakMap();
    // media element → Map(observer → options): who is watching it, so the
    // upgrade can move them.
    const watchers = new WeakMap();
    // observer → Set(media element), so disconnect() can take it off the
    // watch lists — or the handover would start it observing again.
    const watching = new WeakMap();
    const standInsOf = (observer) => {
      let map = standIns.get(observer);
      if (!map) standIns.set(observer, (map = new Map()));
      return map;
    };

    const Hooked = class extends Native {
      constructor(callback, options) {
        // Not a function: the native constructor's own TypeError, unchanged.
        super(typeof callback !== "function" ? callback : function (entries, observer) {
          const map = standIns.get(observer);
          const out = map && map.size
            ? entries.map((e) => (map.has(e.target) ? remap(e, map.get(e.target)) : e))
            : entries;
          return callback.call(this, out, observer);
        }, options);
      }
      observe(target, options) {
        if (isMedia(target) && target.moviPlayer) {
          standInsOf(this).set(target.moviPlayer, target);
          return nativeObserve.call(this, target.moviPlayer, options);
        }
        if (isMedia(target)) {
          let who = watchers.get(target);
          if (!who) watchers.set(target, (who = new Map()));
          who.set(this, options);
          let mine = watching.get(this);
          if (!mine) watching.set(this, (mine = new Set()));
          mine.add(target);
        }
        return nativeObserve.call(this, target, options);
      }
      unobserve(target) {
        if (isMedia(target)) {
          watchers.get(target)?.delete(this);
          watching.get(this)?.delete(target);
          const player = target.moviPlayer;
          if (player && standIns.get(this)?.get(player) === target) {
            standIns.get(this).delete(player);
            return nativeUnobserve.call(this, player);
          }
        }
        return nativeUnobserve.call(this, target);
      }
      disconnect() {
        standIns.get(this)?.clear();
        for (const media of watching.get(this) || []) watchers.get(media)?.delete(this);
        watching.delete(this);
        return nativeDisconnect.call(this);
      }
    };
    Object.defineProperty(Hooked, "name", { value: Native.name });
    // WebIDL methods are enumerable; class methods are not, and they shadow
    // the native ones, so `for (k in observer)` saw no methods at all.
    // zone.js (Angular — the Firebase console) builds its ResizeObserver
    // wrapper exactly that way, and every page failed on "a.disconnect is
    // not a function".
    for (const method of ["observe", "unobserve", "disconnect"]) {
      Object.defineProperty(Hooked.prototype, method, { enumerable: true });
    }
    globalThis[name] = Hooked;

    observerKinds.push((video, player) => {
      const who = watchers.get(video);
      if (!who) return;
      for (const [observer, options] of who) {
        watching.get(observer)?.delete(video);
        nativeUnobserve.call(observer, video);
        standInsOf(observer).set(player, video);
        nativeObserve.call(observer, player, options);
      }
      watchers.delete(video);
    });
  };

  // An entry the page can read like the real one — its own fields, the real
  // prototype so instanceof holds — naming the video instead of the player.
  const copyAs = (proto, fields, entry, video) => {
    const out = Object.create(proto);
    for (const f of fields) {
      try {
        Object.defineProperty(out, f, { value: entry[f], enumerable: true });
      } catch {
        /* a field this browser does not have */
      }
    }
    Object.defineProperty(out, "target", { value: video, enumerable: true });
    return out;
  };

  hookObserver("IntersectionObserver", (entry, video) =>
    copyAs(
      IntersectionObserverEntry.prototype,
      ["time", "rootBounds", "boundingClientRect", "intersectionRect", "intersectionRatio", "isIntersecting", "isVisible"],
      entry,
      video,
    ),
  );
  hookObserver("ResizeObserver", (entry, video) =>
    copyAs(
      ResizeObserverEntry.prototype,
      ["contentRect", "borderBoxSize", "contentBoxSize", "devicePixelContentBoxSize"],
      entry,
      video,
    ),
  );

  // ─── the skin, hidden until the player is in ─────────────────────────────
  //
  // A site's player skin draws its chrome — poster, big play button, control
  // bar — the moment its script runs, and the takeover replaces the video
  // some time after: a CORS probe, then a player module to load. For that
  // stretch the viewer watched the site's player appear and then vanish under
  // ours. So the chrome the upgrade would hide anyway (hideHostChrome in
  // src/upgrade.ts — keep the two lists in step) is hidden from the start.
  //
  // Each skin gets it back as soon as the answer for it is known: upgraded
  // (the upgrade's own sheet takes over), streaming (blob:/MediaStream — never
  // taken over), or nothing after PREHIDE_MS. content.js releases the lot when
  // the page is not being taken over at all. A constructed sheet rather than a
  // <style>: nothing is added to the DOM a framework is about to hydrate.
  const PREHIDE_MS = 4000;
  const SKINS = ".jwplayer, .video-js, .vjs-container, .plyr";
  try {
    const waiting = (skin) => `:is(${skin}):not([data-movi-skin])`;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      `${waiting(".jwplayer")} :is(.jw-preview, .jw-controls, .jw-controls-backdrop, .jw-title, .jw-captions, .jw-overlays, .jw-logo),
       ${waiting(".jwplayer")} .jw-media::after,
       ${waiting(".video-js, .vjs-container")} > :is(.vjs-control-bar, .vjs-big-play-button, .vjs-poster, .vjs-loading-spinner, .vjs-text-track-display, .vjs-title-bar),
       ${waiting(".plyr")} > :is(.plyr__controls, .plyr__control--overlaid) {
         visibility: hidden !important;
       }`,
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

    const firstSeen = new WeakMap();
    const pageStart = performance.now();
    let timer = 0;
    const release = () => {
      clearInterval(timer);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
    const settle = () => {
      let pending = 0;
      for (const skin of document.querySelectorAll(SKINS)) {
        if (skin.hasAttribute("data-movi-skin")) continue;
        if (skin.querySelector("movi-player")) {
          skin.setAttribute("data-movi-skin", "movi");
          continue;
        }
        const video = skin.querySelector("video");
        const src = (video && (video.currentSrc || video.getAttribute("src"))) || "";
        const streaming = !!video && (!!video.srcObject || /^(blob:|mediastream:)/i.test(src));
        if (!firstSeen.has(skin)) firstSeen.set(skin, performance.now());
        if (streaming || performance.now() - firstSeen.get(skin) > PREHIDE_MS) {
          skin.setAttribute("data-movi-skin", "native");
          continue;
        }
        pending++;
      }
      // Watched while the page is young or a skin is still undecided. After
      // that the sheet goes altogether: a skin a page builds later is shown
      // as it comes, rather than hidden with nothing left to give it back.
      if (!pending && performance.now() - pageStart > 30000) release();
    };
    timer = setInterval(settle, 150);
    window.addEventListener("movi-prehide-release", release, { once: true });
  } catch {
    /* no constructed sheets here — the skin shows as it always did */
  }

  // ─── the handover ───────────────────────────────────────────────────────
  Object.defineProperty(globalThis, KEY, {
    value: {
      handoff(video, player) {
        const list = listeners.get(video);
        if (list) {
          for (const { type, listener, options } of list) {
            try {
              nativeRemove.call(video, type, listener, options);
              nativeAdd.call(player, type, listener, options);
            } catch {
              /* one listener that will not move does not stop the rest */
            }
          }
          listeners.delete(video);
        }
        for (const move of observerKinds) {
          try {
            move(video, player);
          } catch {
            /* ditto */
          }
        }
      },
    },
  });
})();
