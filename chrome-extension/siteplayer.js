/**
 * CORS for a site that embeds MoviPlayer itself.
 *
 * The takeover feature already asks the background for
 * Access-Control-Allow-Origin on the files it is about to open. A site that
 * put <movi-player> on its own page gets none of that: its player asks for
 * the bytes, the host that serves them sends no CORS header, the fetch is
 * refused, and MoviPlayer falls back to the browser's <video> — which is the
 * thing the site embedded it to avoid. From the outside it looks like the
 * player quietly stopped working.
 *
 * So the same headers are offered here, for the URLs a page-owned player
 * declares.
 *
 * TIMING is the whole reason this runs at document_start rather than beside
 * the rest of content.js. A rule has to exist before the first read. The one
 * thing on our side is that a custom element is inert until its definition
 * arrives: <movi-player src="..."> sits in the DOM doing nothing until the
 * site's own bundle calls customElements.define and the element upgrades. So
 * an observer installed at document_start sees it while it is still a plain
 * unknown element, and the rules are written before it can ask for a byte.
 *
 * Deliberately NOT gated on the takeover exemption. "Off for this site" means
 * do not replace that site's video player — it does not mean break the player
 * the site chose to ship.
 *
 * Best-effort throughout: without the optional <all_urls> permission no rule
 * is written and the page behaves exactly as it did before the extension was
 * installed.
 */

(() => {
  // Attributes a page-owned player can be pointed at a file with. `src` is
  // the ordinary one; `videourl` is the encrypted-source path. Anything set
  // as a PROPERTY (audioSrc, or a File) is invisible from here and is left
  // alone — a File needs no CORS, and split audio is a host-side arrangement
  // that already controls its own headers.
  const URL_ATTRS = ["src", "videourl"];
  const asked = new Set();
  let timer = null;

  const collect = () => {
    const urls = [];
    for (const el of document.querySelectorAll("movi-player")) {
      for (const attr of URL_ATTRS) {
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        // A blob: or data: source is already the page's own bytes.
        if (/^(blob:|data:|file:)/i.test(raw)) continue;
        let href;
        try {
          href = new URL(raw, location.href).href;
        } catch {
          continue;
        }
        if (asked.has(href)) continue;
        asked.add(href);
        urls.push(href);
      }
    }
    return urls;
  };

  const send = () => {
    timer = null;
    const urls = collect();
    if (urls.length === 0) return;
    try {
      chrome.runtime.sendMessage({ action: "allowMediaCors", urls }, () => {
        // Nothing to report. The takeover path already explains the missing
        // permission on pages it acts on, and a site that ships its own
        // player should not have the extension talking in its console.
        void chrome.runtime.lastError;
      });
    } catch {
      /* the extension context went away mid-navigation */
    }
  };

  // Coalesced: a page that renders a list of players would otherwise send one
  // message per element as each is parsed.
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(send, 0);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: URL_ATTRS,
  });
  schedule();

  // A page with no player by the time it has settled is not going to grow one
  // later in a way worth watching the whole document for — and that is every
  // page on the web, which is the only reason this stops watching at all.
  //
  // A page that HAS one keeps being watched, for as long as it is open. The
  // thing being waited for is not the element, it is its SOURCE, and that
  // arrives whenever the viewer says so: the examples page carries an empty
  // <movi-player> from the first byte and gets its src when someone pastes a
  // link into it and presses play. Measured against it with site access
  // granted — a src set 2s after load was offered CORS, the same src set 15s
  // after load was not, because the observer had already gone. Which is to
  // say the feature did nothing at all on the most ordinary way of using it.
  const settle = () =>
    setTimeout(() => {
      if (!document.querySelector("movi-player")) observer.disconnect();
    }, 10000);
  if (document.readyState === "complete") settle();
  else window.addEventListener("load", settle, { once: true });
})();
