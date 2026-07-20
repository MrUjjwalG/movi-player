/**
 * Custom URL-scheme → SourceAdapter registry.
 *
 * The built-in pipeline reads http/https/blob/data/file (via fetch/File). Any
 * other scheme fails at fetch() and surfaces as a network error — and the UI
 * flags it as an invalid URL. This registry lets an app teach the player about
 * a custom scheme (s3://, ipfs://, ws://, myapp://): register a factory once,
 * and thereafter `src="s3://bucket/movie.mp4"` builds the source THROUGH that
 * factory instead of fetch(), and the scheme is no longer treated as a typo.
 *
 * This complements `element.sourceAdapter = new MyAdapter(url)` — the instance
 * property is an explicit per-element override; the registry is global
 * (per document, like customElements.define) and selects by scheme.
 */
import type { SourceAdapter } from "./SourceAdapter";

/** Config handed to a registered factory when a matching-scheme src loads. */
export interface SourceAdapterFactoryConfig {
  /** The full source URL, e.g. "s3://bucket/movie.mp4". */
  url: string;
  /** Custom request headers set on the player (the `headers` config/attr). */
  headers?: Record<string, string>;
}

/** Builds a SourceAdapter for a custom URL scheme. May be async. */
export type SourceAdapterFactory = (
  config: SourceAdapterFactoryConfig,
) => SourceAdapter | Promise<SourceAdapter>;

// Schemes the built-in HttpSource (fetch) / FileSource pipeline already reads.
// A src using any of these needs no registration; anything else is treated as
// an invalid URL UNLESS a factory is registered for it.
const BUILTIN_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "blob:",
  "data:",
  "file:",
]);

const registry = new Map<string, SourceAdapterFactory>();

/** Normalize "s3", "s3:", "s3://…" → "s3" (lowercase, no colon/slashes). */
function schemeKey(input: string): string {
  return input.trim().toLowerCase().replace(/:.*$/, "");
}

/** A URL's scheme as a bare key ("s3://x" → "s3"), or "" if unparseable. */
function urlSchemeKey(url: string, base?: string): string {
  try {
    return new URL(url, base).protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

/**
 * Register a SourceAdapter factory for one or more custom URL schemes. Once
 * registered, a `src` with that scheme builds the source through this factory
 * instead of fetch(), and the scheme is no longer rejected as an invalid URL.
 *
 * Pass an array to bind the same factory to several schemes in one call
 * (e.g. registerSourceAdapter(["s3", "s3a"], factory)). Registration is
 * atomic — if any scheme is invalid or built-in, none are applied.
 *
 * Built-in schemes (http/https/blob/data/file) can't be overridden — pass an
 * explicit `element.sourceAdapter` instance if you need to intercept those.
 *
 * @param scheme A scheme name, or an array of them, with or without trailing
 *   punctuation ("s3", "s3:" and "s3://" are all accepted).
 * @param factory Builds the adapter for a matching URL. May be async.
 */
export function registerSourceAdapter(
  scheme: string | string[],
  factory: SourceAdapterFactory,
): void {
  if (typeof factory !== "function") {
    throw new Error("registerSourceAdapter: factory must be a function");
  }
  const keys = (Array.isArray(scheme) ? scheme : [scheme]).map(schemeKey);
  // Validate every scheme before mutating so a bad entry can't leave a
  // half-applied set.
  for (const key of keys) {
    if (!key) throw new Error("registerSourceAdapter: a scheme is required");
    if (BUILTIN_SCHEMES.has(key + ":")) {
      throw new Error(
        `registerSourceAdapter: "${key}" is a built-in scheme and can't be ` +
          `overridden — pass an explicit element.sourceAdapter instead`,
      );
    }
  }
  for (const key of keys) registry.set(key, factory);
}

/**
 * Remove one or more previously registered schemes. Returns true if at least
 * one was removed.
 */
export function unregisterSourceAdapter(scheme: string | string[]): boolean {
  const schemes = Array.isArray(scheme) ? scheme : [scheme];
  let removed = false;
  for (const s of schemes) {
    if (registry.delete(schemeKey(s))) removed = true;
  }
  return removed;
}

/** The registered scheme keys (without colons), e.g. ["s3", "ipfs"]. */
export function getRegisteredSchemes(): string[] {
  return [...registry.keys()];
}

/**
 * The factory registered for a URL's scheme, or null if none. `base` resolves
 * relative URLs (which never carry a custom scheme, so they return null).
 */
export function getSourceAdapterFactory(
  url: string,
  base?: string,
): SourceAdapterFactory | null {
  const key = urlSchemeKey(url, base);
  return key ? registry.get(key) ?? null : null;
}

/**
 * True when a URL's scheme is one the player can actually open — a built-in
 * fetchable scheme or one with a registered factory. Distinguishes a genuine
 * typo ("httpss://") from a valid custom scheme ("s3://"). Unparseable input
 * (relative to no base) returns false.
 */
export function isOpenableScheme(url: string, base?: string): boolean {
  const key = urlSchemeKey(url, base);
  if (!key) return false;
  return BUILTIN_SCHEMES.has(key + ":") || registry.has(key);
}
