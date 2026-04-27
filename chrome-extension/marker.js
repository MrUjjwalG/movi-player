// Tell the official Movi Player site that the extension is installed,
// so it can hide its "Add to Chrome" prompt. Domain-scoped via manifest
// so the extension's presence doesn't leak to unrelated sites.
try {
  document.documentElement.setAttribute("data-movi-extension", "installed");
} catch {}
