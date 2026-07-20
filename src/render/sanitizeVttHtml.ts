/**
 * Minimal WebVTT-markup-to-safe-DOM sanitizer for cue text handed to us as a
 * plain string (dash.js's manual-rendering `cueEnter` event). Real VTTCue
 * objects (hls.js) skip this entirely via the native, browser-trusted
 * VTTCue.getCueAsHTML() — this exists only for the string-based path, where
 * the source is a remote manifest/subtitle file the embedding page didn't
 * necessarily choose, so we don't trust it as pre-sanitized HTML the way
 * dash.js's own sample code assigns it straight to an element's markup.
 *
 * Keeps WebVTT's own formatting tags (b/i/u/ruby/rt/rp/span/br, plus the VTT
 * class-span tag `c`) and drops everything else — script/img/event-handler
 * attributes, href/src/style — by unwrapping disallowed elements (their TEXT
 * survives, just not the tag) rather than dropping their content outright.
 */
const ALLOWED_TAGS = new Set([
  "b",
  "i",
  "u",
  "em",
  "strong",
  "span",
  "ruby",
  "rt",
  "rp",
  "br",
  "c",
]);
const ALLOWED_ATTRS = new Set(["class"]);

export function sanitizeVttHtml(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let sourceBody: HTMLElement;
  try {
    sourceBody = new DOMParser().parseFromString(html, "text/html").body;
  } catch {
    frag.appendChild(document.createTextNode(html));
    return frag;
  }

  const walk = (source: Node, target: Node) => {
    source.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(node.textContent || ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (ALLOWED_TAGS.has(tag)) {
        const clean = document.createElement(tag);
        for (const attr of Array.from(el.attributes)) {
          if (ALLOWED_ATTRS.has(attr.name.toLowerCase())) {
            clean.setAttribute(attr.name, attr.value);
          }
        }
        walk(el, clean);
        target.appendChild(clean);
      } else {
        // Disallowed tag — keep its text content, drop the wrapper.
        walk(el, target);
      }
    });
  };
  walk(sourceBody, frag);
  return frag;
}
