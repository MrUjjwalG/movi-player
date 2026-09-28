/**
 * The Vue wrapper's implementation — deliberately WITHOUT the side effect that
 * registers <movi-player>. The two entry points pick which build gets
 * registered and re-export everything from here:
 *
 *   index.ts → movi-player/element        (embedded WASM)
 *   slim.ts  → movi-player/element/slim   (external movi.wasm)
 *
 * Import one of those, not this file — on its own it renders a tag no build has
 * defined. The `movi-player/element` import below is type-only (both builds
 * share the exact same API), so it adds nothing to the bundle.
 */
import {
  defineComponent,
  h,
  ref,
  onMounted,
  onBeforeUnmount,
  watchEffect,
  type PropType,
} from "vue";
import type {
  MoviElement,
  MoviSourceProps,
  MoviTrackProps,
  QoEEvent,
} from "movi-player/element";

export const MoviPlayer = defineComponent({
  name: "MoviPlayer",
  inheritAttrs: false,
  props: {
    src: String,
    poster: String,
    theme: String as PropType<"dark" | "light">,
    themecolor: String,
    volume: [Number, String],
    playbackrate: [Number, String],
    controls: { type: Boolean, default: undefined },
    autoplay: { type: Boolean, default: undefined },
    loop: { type: Boolean, default: undefined },
    muted: { type: Boolean, default: undefined },
    playsinline: { type: Boolean, default: undefined },
  },
  emits: [
    "ready",
    "qoe",
    "timeupdate",
    "play",
    "pause",
    "ended",
    "error",
    // The wording on an error screen, as opposed to `error`'s raw Error. Also
    // fires for the format/codec failures that raise no runtime error.
    "errordisplay",
  ],
  setup(props, { attrs, emit, expose, slots }) {
    const elRef = ref<MoviElement | null>(null);
    expose({ element: elRef });

    // Attributes THIS wrapper wrote, so a prop that goes away can take its
    // attribute with it — see the undefined branch below.
    const written = new Set<string>();
    // What each prop was the last time it was reflected. The effect re-runs
    // when ANY prop changes and used to rewrite every attribute — so a viewer's
    // loop, crop or ambient switch was undone by an unrelated prop changing.
    // Only a prop whose value the host actually changed is written.
    const last = new Map<string, unknown>();

    // Reflect props + passthrough attrs onto the element.
    watchEffect(() => {
      const el = elRef.value;
      if (!el) return;
      const all: Record<string, unknown> = { ...attrs, ...props };
      for (const [key, value] of Object.entries(all)) {
        const attr = key.toLowerCase();
        if (last.has(attr) && Object.is(last.get(attr), value)) continue;
        last.set(attr, value);
        if (value === undefined || value === null) {
          // A prop that USED to have a value and now has none means the host is
          // describing a different video — chapters that the next video doesn't
          // have, a poster that resolved to nothing. Skipping it left the last
          // video's attribute in place, so its chapter marks stayed on the
          // scrubber of the next one.
          //
          // Only attributes this wrapper set are cleared. The player writes some
          // of its own — `src` moves rung by rung on a premuxed ladder — and a
          // host that leaves `src` unset because it uses <source> children would
          // otherwise have every re-render tear the current rung off mid-play.
          if (!written.has(attr)) continue;
          written.delete(attr);
          if (el.hasAttribute(attr)) el.removeAttribute(attr);
          continue;
        }
        // Reflect only primitives — a fallthrough event listener (onFoo) or an
        // object/array would otherwise be String()'d into a bogus attribute.
        if (typeof value === "function" || typeof value === "object") continue;
        written.add(attr);
        if (typeof value === "boolean") {
          if (value) el.setAttribute(attr, "");
          else el.removeAttribute(attr);
        } else {
          el.setAttribute(attr, String(value));
        }
      }
    });

    const listeners: Array<[string, EventListener]> = [];
    onMounted(() => {
      const el = elRef.value;
      if (!el) return;
      const bridge = (dom: string, vue: string) => {
        const l: EventListener = (e) => emit(vue as any, (e as CustomEvent).detail);
        el.addEventListener(dom, l);
        listeners.push([dom, l]);
      };
      bridge("movi-qoe", "qoe");
      bridge("timeupdate", "timeupdate");
      bridge("play", "play");
      bridge("pause", "pause");
      bridge("ended", "ended");
      bridge("error", "error");
      bridge("errordisplay", "errordisplay");
      emit("ready", el);
    });
    onBeforeUnmount(() => {
      const el = elRef.value;
      listeners.forEach(([n, l]) => el?.removeEventListener(n, l));
    });

    // Forward the default slot so <source>/<track> children reach the element
    // (multi-quality, external audio, subtitles) before it parses them.
    //
    // `wasmurl` rides along on the vnode instead of waiting for the reflect
    // effect above: Vue sets it before inserting the element, while the effect
    // lands after connectedCallback — and the slim build reads this one on
    // connect to point the WASM loader. Too late means the engine fetches the
    // default `movi.wasm` next to the bundle and, if that isn't there, silently
    // drops to native <video> (where split video+audio sources lose audio).
    return () =>
      h(
        "movi-player",
        { ref: elRef, wasmurl: attrs.wasmurl as string | undefined },
        slots.default?.(),
      );
  },
});

/**
 * Typed `<source>` for a `<MoviPlayer>` child list. Maps friendly props to the
 * attributes the element parses (`height` → `data-height`, `srcLang` →
 * `srclang`, `default` → `data-default`).
 *
 *   <MoviPlayer controls>
 *     <MoviSource src="4k.mp4" :height="2160" badge="HDR" default />
 *     <MoviSource src="en.m4a" kind="audio" srcLang="en" label="English" />
 *   </MoviPlayer>
 */
export const MoviSource = defineComponent({
  name: "MoviSource",
  props: {
    src: { type: String, required: true },
    type: String,
    kind: String as PropType<"audio">,
    srcLang: String,
    label: String,
    height: Number,
    fps: Number,
    badge: String,
    bandwidth: Number,
    default: { type: Boolean, default: undefined },
  },
  setup(props) {
    return () => {
      const attrs: Record<string, unknown> = { src: props.src };
      if (props.type) attrs.type = props.type;
      if (props.kind) attrs.kind = props.kind;
      if (props.srcLang) attrs.srclang = props.srcLang;
      if (props.label) attrs.label = props.label;
      if (props.height != null) attrs["data-height"] = props.height;
      if (props.fps != null) attrs["data-fps"] = props.fps;
      if (props.badge) attrs["data-badge"] = props.badge;
      if (props.bandwidth != null) attrs["data-bandwidth"] = props.bandwidth;
      if (props.default) attrs["data-default"] = "";
      return h("source", attrs);
    };
  },
});

/** Typed `<track>` (subtitles / captions) for a `<MoviPlayer>` child list. */
export const MoviTrack = defineComponent({
  name: "MoviTrack",
  props: {
    src: { type: String, required: true },
    kind: String as PropType<"subtitles" | "captions">,
    srcLang: String,
    label: String,
    format: String as PropType<"vtt" | "srt">,
    default: { type: Boolean, default: undefined },
  },
  setup(props) {
    return () => {
      const attrs: Record<string, unknown> = {
        src: props.src,
        kind: props.kind ?? "subtitles",
      };
      if (props.srcLang) attrs.srclang = props.srcLang;
      if (props.label) attrs.label = props.label;
      if (props.format) attrs["data-format"] = props.format;
      if (props.default) attrs["data-default"] = "";
      return h("track", attrs);
    };
  },
});

export type { MoviElement, QoEEvent, MoviSourceProps, MoviTrackProps };
