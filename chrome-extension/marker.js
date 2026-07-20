// Expose the extension's presence to the page via a window flag (MAIN world),
// so the official Movi Player site can hide its "Add to Chrome" prompt on any
// host. A window property — instead of a DOM attribute on <html>/<body> — means
// we never mutate the server-rendered DOM before the page hydrates, so React /
// Next / Nuxt sites don't throw hydration mismatches. Runs at document_start so
// the flag is set before any page script reads it.
try {
  window.__moviExtension = { installed: true };
} catch {}
