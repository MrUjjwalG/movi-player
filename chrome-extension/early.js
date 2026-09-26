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
