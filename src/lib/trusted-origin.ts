// Pure, zero-import trusted-origin rules for the CSRF Origin checks: the proxy
// (every mutating cookie request to a protected /api/* route), cron-auth's
// admin-session path (cron/sync routes, which the proxy exempts), the register
// route's own check, and the boot warning in instrumentation.ts. One module so
// a fix to one reader reaches all of them; zero imports so proxy.ts stays
// import-light (the auth-url.ts pattern).
//
// Nothing here reads env at import time: proxy.ts builds its allowlist once at
// module load, the others per call.

// Only an http(s) URL yields a usable origin. `new URL("summonarr.local:3001")`
// does NOT throw — it parses as scheme `summonarr.local:` with path `3001` and
// reports `.origin === "null"` — so a try/catch alone silently trusted the
// literal string "null" (which a browser sends as `Origin: null` for
// sandboxed-iframe and cross-origin-redirected POSTs) and never trusted the
// host the operator meant.
export function parseTrustedOriginEntry(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.origin === "null") return null;
    return u.origin;
  } catch {
    return null;
  }
}

// AUTH_URL plus every comma-separated AUTH_TRUSTED_ORIGIN entry, as bare
// origins. An unusable entry is skipped (instrumentation.ts names each one at
// boot). Empty when neither is set.
export function configuredTrustedOrigins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Set<string> {
  const trusted = new Set<string>();
  for (const raw of [env.AUTH_URL, ...(env.AUTH_TRUSTED_ORIGIN ?? "").split(",")]) {
    const origin = parseTrustedOriginEntry(raw);
    if (origin) trusted.add(origin);
  }
  return trusted;
}

// The origin a browser request names: its Origin header, else its Referer's
// origin. Null when it names none — no header, an empty one, or a Referer that
// doesn't parse.
export function requestOrigin(headers: { get(name: string): string | null }): string | null {
  let origin = headers.get("origin");
  if (!origin) {
    const referer = headers.get("referer");
    if (referer) {
      try {
        origin = new URL(referer).origin;
      } catch {
        // A malformed Referer names no origin.
      }
    }
  }
  return origin || null;
}

// Whether `origin` is trusted. The configured allowlist is the WHOLE answer
// when there is one; only with none configured is the request's own origin
// trusted (dev and test: production boot refuses a missing AUTH_URL). Compared
// against the request's origin directly, never cached: it comes from the
// client's Host header.
export function isTrustedOrigin(
  origin: string,
  configured: ReadonlySet<string>,
  selfOrigin: string,
): boolean {
  return configured.size > 0 ? configured.has(origin) : origin === selfOrigin;
}

// requestOrigin + isTrustedOrigin: false when the request names no origin.
export function isTrustedRequestOrigin(
  headers: { get(name: string): string | null },
  configured: ReadonlySet<string>,
  selfOrigin: string,
): boolean {
  const origin = requestOrigin(headers);
  return origin !== null && isTrustedOrigin(origin, configured, selfOrigin);
}
