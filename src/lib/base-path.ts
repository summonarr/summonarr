// Base path support for subpath deployments (e.g. BASE_PATH=/request behind a reverse proxy).
//
// Next.js `basePath` only rewrites next/link and next/router navigation — raw client
// `fetch()`, `EventSource`, `navigator.serviceWorker.register`, `window.location`, and
// plain `<img src>` are NOT prefixed automatically. Route those through these helpers so a
// non-empty BASE_PATH deployment reaches the app subtree instead of the origin root.
//
// NEXT_PUBLIC_BASE_PATH is injected at build time (Dockerfile) and mirrors BASE_PATH.

const RAW_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Normalise: leading slash, no trailing slash, empty string when unset.
function normalize(base: string): string {
  if (!base || base === "/") return "";
  const withLeading = base.startsWith("/") ? base : `/${base}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

const BASE_PATH = normalize(RAW_BASE);

/**
 * Prefix a root-absolute path (API route, static asset, or in-app URL) with the configured
 * base path. A no-op when BASE_PATH is empty (the default). Pass-through for absolute URLs.
 */
export function withBasePath(path: string): string {
  if (!BASE_PATH) return path;
  // Leave fully-qualified URLs and protocol-relative URLs untouched.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return path;
  if (!path.startsWith("/")) return path;
  return `${BASE_PATH}${path}`;
}

export { BASE_PATH };
