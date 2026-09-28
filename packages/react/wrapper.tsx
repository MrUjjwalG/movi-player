/**
 * The React wrapper's implementation — deliberately WITHOUT the side effect
 * that registers <movi-player>. The two entry points pick which build gets
 * registered and re-export everything from here:
 *
 *   index.tsx → movi-player/element        (embedded WASM)
 *   slim.tsx  → movi-player/element/slim   (external movi.wasm)
 *
 * Import one of those, not this file — on its own it renders a tag no build has
 * defined. The `movi-player/element` import below is type-only (both builds
 * share the exact same API), so it adds nothing to the bundle.
 */
import * as React from "react";
import type {
  MoviElement,
  MoviPlayerAttributes,
  MoviSourceProps,
  MoviTrackProps,
  QoEEvent,
} from "movi-player/element";

export type { MoviElement, QoEEvent, MoviSourceProps, MoviTrackProps };

export interface MoviPlayerProps extends MoviPlayerAttributes {
  className?: string;
  style?: React.CSSProperties;
  /** `<source>` / `<track>` children for multi-quality, external audio, or subtitles. */
  children?: React.ReactNode;
  /** Fires once the element is mounted, with the element instance. */
  onReady?: (el: MoviElement) => void;
  onQoe?: (event: QoEEvent) => void;
  onTimeUpdate?: (time: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onError?: (error: unknown) => void;
  /**
   * An error screen went up, with the wording on it. Unlike `onError`, which
   * hands over the raw Error ("HTTP 403 (Fatal)"), this is what the viewer is
   * being shown — and it also covers the format/codec failures that never
   * raise a runtime error. Pair it with a `slot="error"` child to render your
   * own screen; `canRetry` / `canTrySoftware` say which recoveries are worth
   * offering (`el.load()` and `el.enableSoftwareDecoding()` off the ref).
   */
  onErrorDisplay?: (info: {
    title: string | null;
    message: string | null;
    canRetry: boolean;
    canTrySoftware: boolean;
  }) => void;
}

const EVENT_PROPS = new Set([
  "onReady",
  "onQoe",
  "onTimeUpdate",
  "onPlay",
  "onPause",
  "onEnded",
  "onError",
  "onErrorDisplay",
  "className",
  "style",
  "children",
]);

export const MoviPlayer = React.forwardRef<MoviElement, MoviPlayerProps>(
  function MoviPlayer(props, ref) {
    const elRef = React.useRef<MoviElement | null>(null);
    React.useImperativeHandle(ref, () => elRef.current as MoviElement, []);

    // Attributes THIS wrapper wrote, so a prop that goes away can take its
    // attribute with it — see the undefined branch below.
    const writtenRef = React.useRef<Set<string>>(new Set());
    // What each prop was the last time it was reflected — see below.
    const lastRef = React.useRef<Map<string, unknown>>(new Map());

    // Reflect declarative attributes onto the element every render. Booleans
    // become presence/absence; everything else becomes a string attribute.
    //
    // Written ONLY when the value actually differs. This effect has no
    // dependency array — it runs on every render of the host, including ones
    // that have nothing to do with the player (expanding a description,
    // opening a menu). Re-setting an attribute to the value it already has
    // still fires attributeChangedCallback, and for a source-affecting
    // attribute that means a reload: clicking "Show more" restarted playback
    // from 30s back to 0.
    React.useEffect(() => {
      const el = elRef.current;
      if (!el) return;
      for (const [key, value] of Object.entries(props)) {
        if (EVENT_PROPS.has(key)) continue;
        const attr = key.toLowerCase();
        // Only what the HOST changed since it last said it. Several of these
        // attributes are ones the viewer changes too — the player reflects
        // loop, cropbars, ambientmode, muted… onto itself when a key, the gear
        // panel or the context menu flips them — and comparing against the
        // ELEMENT read that as drift to correct: the next render of the host,
        // for any reason at all, put the page's value back. Pressing L on a
        // page that declares `loop={false}` looped until something else on
        // the page re-rendered, then quietly stopped. A prop that has not
        // changed is not the host saying anything new.
        const last = lastRef.current;
        if (last.has(attr) && Object.is(last.get(attr), value)) continue;
        last.set(attr, value);
        if (value === undefined || value === null) {
          // A prop that USED to have a value and now has none means the host
          // is describing a different video — `chapters={list?.length ? … :
          // undefined}` on a video with no chapters, a `poster` that resolved
          // to nothing. Skipping it left the last video's attribute in place,
          // so its chapter marks stayed on the scrubber of the next one.
          //
          // Only attributes this wrapper set are cleared. The player writes
          // some of its own — `src` moves rung by rung on a premuxed ladder —
          // and a host that passes `src={undefined}` because it uses
          // <MoviSource> children would otherwise have every re-render tear
          // the current rung off the element mid-play.
          if (!writtenRef.current.has(attr)) continue;
          writtenRef.current.delete(attr);
          if (el.hasAttribute(attr)) el.removeAttribute(attr);
          continue;
        }
        if (typeof value === "boolean") {
          writtenRef.current.add(attr);
          if (value === el.hasAttribute(attr)) continue;
          if (value) el.setAttribute(attr, "");
          else el.removeAttribute(attr);
        } else {
          const next = String(value);
          writtenRef.current.add(attr);
          if (el.getAttribute(attr) === next) continue;
          el.setAttribute(attr, next);
        }
      }
    });

    // Bridge web-component events to React callbacks.
    React.useEffect(() => {
      const el = elRef.current;
      if (!el) return;
      const listeners: Array<[string, EventListener]> = [];
      const add = (name: string, fn?: (detail: any) => void) => {
        if (!fn) return;
        const l: EventListener = (e) => fn((e as CustomEvent).detail);
        el.addEventListener(name, l);
        listeners.push([name, l]);
      };
      add("movi-qoe", props.onQoe);
      add("timeupdate", props.onTimeUpdate);
      if (props.onPlay) add("play", () => props.onPlay!());
      if (props.onPause) add("pause", () => props.onPause!());
      if (props.onEnded) add("ended", () => props.onEnded!());
      add("error", props.onError);
      add("errordisplay", props.onErrorDisplay);
      props.onReady?.(el);
      return () => listeners.forEach(([n, l]) => el.removeEventListener(n, l));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      props.onQoe,
      props.onTimeUpdate,
      props.onPlay,
      props.onPause,
      props.onEnded,
      props.onError,
      props.onErrorDisplay,
      props.onReady,
    ]);

    // createElement avoids needing a JSX.IntrinsicElements augmentation for the
    // custom tag; React passes unknown props straight through as attributes.
    // Children (<source>/<track>) are rendered into the element so they're
    // present when the player's connectedCallback parses them.
    //
    // `wasmurl` is passed here rather than left to the reflect effect above:
    // React sets attributes on the element before inserting it, whereas effects
    // run after connectedCallback — and the slim build reads this one on connect
    // to point the WASM loader. Too late means the engine fetches the default
    // `movi.wasm` next to the bundle and, if that 404s/403s, silently drops to
    // native <video> (where split video+audio sources lose their audio).
    return React.createElement(
      "movi-player",
      {
        ref: elRef,
        className: props.className,
        style: props.style,
        wasmurl: props.wasmurl,
      },
      props.children,
    );
  },
);

/**
 * A typed `<source>` for a `<MoviPlayer>` child list. Maps its friendly props
 * to the exact attributes the element parses — `height` → `data-height`,
 * `srcLang` → `srclang`, `default` → `data-default`, etc. Non-standard names go
 * through as `data-*` (or plain lowercase) so React renders them verbatim
 * instead of stripping them the way it would on a raw `<source srclang>`.
 *
 *   <MoviPlayer controls>
 *     <MoviSource src="4k.mp4"    height={2160} badge="HDR" default />
 *     <MoviSource src="1080.mp4"  height={1080} />
 *     <MoviSource src="en.m4a"    kind="audio" srcLang="en" label="English" />
 *   </MoviPlayer>
 */
export function MoviSource(props: MoviSourceProps): React.ReactElement {
  const attrs: Record<string, unknown> = { src: props.src };
  if (props.type) attrs.type = props.type;
  if (props.kind) attrs.kind = props.kind;
  if (props.srcLang) attrs.srcLang = props.srcLang;
  // `label` isn't a standard <source> attribute, so React warns on it — the
  // element reads `data-label` too, which is always valid.
  if (props.label) attrs["data-label"] = props.label;
  if (props.height != null) attrs["data-height"] = props.height;
  if (props.fps != null) attrs["data-fps"] = props.fps;
  if (props.badge) attrs["data-badge"] = props.badge;
  if (props.bandwidth != null) attrs["data-bandwidth"] = props.bandwidth;
  if (props.codec) attrs["data-codec"] = props.codec;
  if (props.default) attrs["data-default"] = "";
  return React.createElement("source", attrs);
}

/** A typed `<track>` (subtitles / captions) for a `<MoviPlayer>` child list. */
export function MoviTrack(props: MoviTrackProps): React.ReactElement {
  const attrs: Record<string, unknown> = {
    src: props.src,
    kind: props.kind ?? "subtitles",
  };
  if (props.srcLang) attrs.srcLang = props.srcLang;
  if (props.label) attrs.label = props.label;
  if (props.format) attrs["data-format"] = props.format;
  if (props.default) attrs["data-default"] = "";
  return React.createElement("track", attrs);
}
