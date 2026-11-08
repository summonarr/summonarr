// How src/proxy.ts classifies a request path: public, machine (own-auth), or
// exempt from the CSRF Origin check. Pure and zero-import so each rule can be
// unit-tested without the proxy's session machinery.
//
// These are EXEMPTIONS, so they match the path exactly as sent: a mis-cased or
// look-alike path is never exempted (App Router matching is case-sensitive, so
// such a path reaches no route anyway). Prefixes match whole path segments —
// `/login` covers `/login` and `/login/…`, never `/login-history` — so a future
// page whose name merely starts with a public one is not public by accident.

// `path` is `base` itself or something under it.
export function isUnderPath(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

// Machine endpoints that authenticate themselves (webhook secret, CRON_SECRET
// or an admin session with its own same-origin check, Discord's signature).
// They are public to the session gate AND exempt from the CSRF Origin check:
// their callers send no browser Origin. Declared once so the two lists can't
// drift — a route in one and not the other either 401s its machine caller or
// skips the Origin check for a cookie one.
export function isMachinePath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/webhooks/") ||
    isUnderPath(pathname, "/api/sync") ||
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/interactions"
  );
}

// Auth routes that legitimately have no Origin header:
//   - oidc/callback: top-level redirect initiated by the IdP.
//   - oidc/start: same-site top-level navigation (no Origin sent by browsers
//     on top-level navigations).
//   - machine-session: server-to-server caller with Bearer CRON_SECRET.
// Every other /api/auth/* route is public but still Origin-checked: browser
// sign-in/sign-out/register POSTs DO send Origin, and the check defends
// against login-CSRF and forced-logout-CSRF.
export function isAuthRouteExemptFromCsrf(pathname: string): boolean {
  return (
    pathname === "/api/auth/oidc/callback" ||
    pathname === "/api/auth/oidc/start" ||
    pathname === "/api/auth/machine-session"
  );
}

// Pages reachable without a session (the sign-in and first-run flows).
const PUBLIC_PAGES = ["/login", "/register", "/setup", "/auth/plex"] as const;

export function isPublicPath(pathname: string): boolean {
  return (
    // RFC 9116 security.txt (public/.well-known/) and any other well-known
    // resource: their only audience is anonymous, so a login redirect makes
    // them unreachable everywhere they were meant to be read. Kept here rather
    // than in the matcher so the Host gate and CSP still apply.
    pathname.startsWith("/.well-known/") ||
    // Crawlers fetch robots.txt anonymously; a login redirect would hide the
    // "stay out" rule from exactly the clients it is for.
    pathname === "/robots.txt" ||
    PUBLIC_PAGES.some((page) => isUnderPath(pathname, page)) ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/setup/") ||
    isMachinePath(pathname) ||
    pathname === "/api/health" ||
    pathname === "/api/config/compat" ||
    // Notification-email verification link is clicked from an email (possibly
    // logged-out / another device); the one-time token in the query IS the
    // credential. Token-authed inside the handler — see audit-routes exception.
    pathname === "/api/profile/notification-email/confirm" ||
    // Personal iCal feed: calendar apps poll it with no cookie or header, so the
    // secret token in the path IS the credential. Token-authed (hashed,
    // timing-safe) inside the handler — see audit-routes exception.
    pathname.startsWith("/api/calendar/feed/")
  );
}
