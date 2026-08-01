// Pure, zero-import AUTH_URL parsing. Lives here rather than inline in
// instrumentation.ts so the rule is unit-testable — instrumentation itself
// process.exit(1)s at boot and cannot be exercised by the suite.

// Parses AUTH_URL, returning null when it is absent, blank, or unusable.
//
// Presence is NOT sufficient, which is what the boot check used to test. Every
// consumer treats AUTH_URL as the BASE of `new URL(path, base)` — proxy.ts's
// buildLoginRedirect, the OIDC callback, notification-email links — and that
// THROWS on a value which doesn't parse. The common case is a scheme-less host
// ("requests.example.com"), which sails past a presence check and then takes down
// the login redirect on every logged-out request, while also silently defeating
// the public-host/TRUST_PROXY boot refusal (a parse failure there reads as "no
// host" ⇒ "not public" ⇒ nothing to refuse).
//
// Only absolute http(s) URLs are accepted: a scheme like file: or ftp: parses
// fine but is equally unusable as an origin for redirect and CSRF checks.
export function parseAuthUrl(raw: string | undefined): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}
