// Validates that an external URL is a safe http(s) link before it's used as an
// `<a href>`. Third-party metadata (TMDB `homepage`, MDBList trailer URL) is
// untrusted — a `javascript:`/`data:`/`vbscript:` URL in an href is a
// script-execution / XSS vector. Returns the URL only when it parses as http: or
// https:, otherwise undefined. Pure (no imports) so client and server can use it.
export function safeExternalHref(url: string | null | undefined): string | undefined {
  if (!url || typeof url !== "string") return undefined;
  const trimmed = url.trim();
  try {
    const { protocol } = new URL(trimmed);
    if (protocol === "http:" || protocol === "https:") return trimmed;
  } catch {
    // Not an absolute URL — reject. Protocol-relative (//host) and relative paths
    // throw here (no base) and are intentionally rejected; we only render absolute
    // http(s) external links.
  }
  return undefined;
}

// Synthetic origin used only as a resolution base. Never navigated to — a
// candidate that resolves away from it is off-origin and gets rejected.
const INTERNAL_BASE = "https://internal.invalid";

/**
 * Validates a post-login/return-to redirect target as an IN-APP path and returns
 * it normalised (path + query + hash), or undefined when it points anywhere else.
 *
 * Resolve-then-compare-origin, NOT a `startsWith("/") && !startsWith("//")`
 * string test. The string test is bypassable: the WHATWG URL parser strips
 * TAB (U+0009), LF (U+000A) and CR (U+000D) from input *before* parsing, so
 * `/%09/evil.com` — which arrives from `searchParams.get()` already decoded to
 * `/\t/evil.com`, passes "starts with / and not //", and contains no backslash —
 * resolves to `https://evil.com/`. That shipped as an open redirect on the OIDC
 * post-login hop (the 302 also carried the freshly-minted session cookie) and on
 * the login form's `router.push`. Backslash folding (`/\evil.com`) and
 * `javascript:`/`data:` targets fall out of the same origin check for free.
 *
 * Pure (no imports) so client and server share one implementation — the three
 * hand-rolled copies of the old string test are what let them drift.
 */
export function safeInternalPath(raw: string | null | undefined): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw, INTERNAL_BASE);
    if (u.origin !== INTERNAL_BASE) return undefined;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return undefined;
  }
}
