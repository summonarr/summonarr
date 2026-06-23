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
