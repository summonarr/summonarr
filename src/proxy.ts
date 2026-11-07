import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isLocalHost } from "@/lib/local-only";
import {
  markSessionResponseUncacheable,
  parseSessionCookie,
  replaceSessionCookie,
  serializeSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import { verifyAndRefreshSession } from "@/lib/session-refresh";
import { verifySessionJwt } from "@/lib/session-jwt";
import { parseAuthUrl } from "@/lib/auth-url";
import {
  configuredTrustedOrigins,
  isTrustedOrigin,
  requestOrigin,
} from "@/lib/trusted-origin";
import {
  parseBearerToken,
  hasNativeClientHeader,
  NATIVE_CLIENT_HEADER,
} from "@/lib/mobile-auth";
import {
  API_VERSION,
  parseNativeClient,
  isClientBelowMinimum,
} from "@/lib/api-version";
import {
  effectivePermissions,
  hasPermission,
  parsePermissions,
  Permission,
} from "@/lib/permissions";

const trustProxy = process.env.TRUST_PROXY === "true";

// AUTH_URL + AUTH_TRUSTED_ORIGIN, read once at module load (the rules live in
// trusted-origin.ts, shared with cron-auth.ts and the register route). Empty ⇒
// only a request's own origin is trusted (isTrustedOrigin).
const envOrigins: ReadonlySet<string> = (() => {
  const trusted = configuredTrustedOrigins();
  if (trusted.size === 0 && process.env.NODE_ENV === "production") {
    console.error(
      "[proxy] No trusted origins configured in production. " +
      "Set AUTH_URL to allow browser API calls."
    );
  }
  return trusted;
})();

// Machine endpoints that authenticate themselves (webhook secret, CRON_SECRET
// or an admin session with its own same-origin check, Discord's signature).
// They are public to the session gate AND exempt from the CSRF Origin check:
// their callers send no browser Origin. Declared once so the two lists can't
// drift — a route in one and not the other either 401s its machine caller or
// skips the Origin check for a cookie one.
function isMachinePath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/webhooks/") ||
    pathname === "/api/sync" ||
    pathname.startsWith("/api/sync/") ||
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
function isAuthRouteExemptFromCsrf(pathname: string): boolean {
  return (
    pathname === "/api/auth/oidc/callback" ||
    pathname === "/api/auth/oidc/start" ||
    pathname === "/api/auth/machine-session"
  );
}

function isPublicPath(pathname: string): boolean {
  return (
    // RFC 9116 security.txt (public/.well-known/) and any other well-known
    // resource: their only audience is anonymous, so a login redirect makes
    // them unreachable everywhere they were meant to be read. Kept here rather
    // than in the matcher so the Host gate and CSP still apply.
    pathname.startsWith("/.well-known/") ||
    // Crawlers fetch robots.txt anonymously; a login redirect would hide the
    // "stay out" rule from exactly the clients it is for.
    pathname === "/robots.txt" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/auth/plex") ||
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

// An app URL for a redirect: AUTH_URL's origin when it parses as an http(s) URL,
// else the request's own origin. A blank (`AUTH_URL=` in a compose file) or
// scheme-less value used to reach `new URL(path, base)` raw and throw, which
// 500'd every logged-out page request outside production (where boot refuses
// such a value). auth-url.ts is zero-import, so proxy.ts stays light.
function appUrl(path: string, req: NextRequest): URL {
  const origin = parseAuthUrl(process.env.AUTH_URL)?.origin ?? req.nextUrl.origin;
  return new URL(`${process.env.BASE_PATH ?? ""}${path}`, origin);
}

function buildLoginRedirect(req: NextRequest): URL {
  const url = appUrl("/login", req);
  // Path AND query: a shared `/movies?genre=28` link must land on the filtered
  // page after sign-in, not on bare `/movies`. The login form validates the
  // value with safeInternalPath, which preserves a query it is given.
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return url;
}

// The CSRF Origin check for a mutating cookie request to a protected API: the
// 403 to return, or null when the request names a trusted origin (its Origin
// header, else its Referer's). Runs before the session is resolved, so a
// cross-site request never costs a DB read.
function csrfRefusal(request: NextRequest): Response | null {
  const origin = requestOrigin(request.headers);
  if (!origin) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  if (!isTrustedOrigin(origin, envOrigins, request.nextUrl.origin)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

// The Content-Security-Policy for one response, around its fresh nonce.
//
// 'unsafe-eval' is `next dev` ONLY. React's development build calls eval() to
// reconstruct server-side error stacks in the browser, and Turbopack's HMR
// runtime evaluates modules the same way; without it every dev page logs
// "eval() is not supported in this environment" and those debugging features
// go dark. Next's CSP guide documents this exact carve-out and states neither
// React nor Next uses eval() in production.
//
// NEVER widen this past `=== "development"`. 'unsafe-eval' turns any string
// that reaches eval()/new Function() into executable script, which is most
// of what the nonce + 'strict-dynamic' policy exists to prevent — and a
// production response is the one an attacker can reach. `next build` sets
// NODE_ENV=production, so this reads false for every shipped deployment.
// NODE_ENV is read on every call; tests/proxy.test.mts pins both directions.
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data: https://image.tmdb.org https://plex.tv https://assets.plex.tv https://secure.gravatar.com https://i0.wp.com",
    "font-src 'self'",
    `connect-src 'self' https://plex.tv${(() => { try { return process.env.OIDC_ISSUER ? ` ${new URL(process.env.OIDC_ISSUER).origin}` : ""; } catch { return ""; } })()}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function loginRedirectResponse(redirectTo: URL, clearCookies: boolean): Response {
  const res = new Response(null, {
    status: 302,
    headers: { Location: redirectTo.toString() },
  });
  if (clearCookies) {
    for (const cookie of serializeClearedSessionCookies()) {
      res.headers.append("Set-Cookie", cookie);
    }
  }
  return res;
}

export async function proxy(request: NextRequest) {
  // Local-only mode: when TRUST_PROXY is not "true" we cannot read the real
  // client IP, so we refuse any request whose Host header is not a
  // loopback/private-network (RFC1918) address. This protects a public
  // deployment that forgot to set TRUST_PROXY — see src/lib/local-only.ts.
  if (!trustProxy && !isLocalHost(request.headers.get("host"))) {
    return NextResponse.json(
      {
        error:
          "TRUST_PROXY is not enabled. This server only serves local network requests. " +
          "Set TRUST_PROXY=true when running behind a reverse proxy.",
      },
      { status: 403 },
    );
  }

  const { pathname } = request.nextUrl;

  // Native/API clients authenticate with `Authorization: Bearer <session-jwt>`
  // and tag requests with X-Summonarr-Client instead of the browser cookie.
  // Both are custom headers a cross-origin page can't attach to a credentialed
  // request (CORS preflight blocks them), so either one means this request is
  // not a cookie-riding CSRF vector. See src/lib/mobile-auth.ts.
  const bearerToken = parseBearerToken(request.headers.get("authorization"));
  const isNativeClient = hasNativeClientHeader(
    request.headers.get(NATIVE_CLIENT_HEADER),
  );
  // Parsed form of the same header (platform/build/api) for the version gate
  // below. Presence (isNativeClient) drives the CSRF skip; the parsed build
  // drives the 426 force-upgrade gate.
  const nativeClient = parseNativeClient(
    request.headers.get(NATIVE_CLIENT_HEADER),
  );

  const isProtectedApi =
    pathname.startsWith("/api/") &&
    !isAuthRouteExemptFromCsrf(pathname) &&
    !isMachinePath(pathname);

  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);

  // Force-upgrade kill-switch: a native client that positively identifies a
  // build below the per-platform minimum is refused on MUTATING requests with
  // 426 Upgrade Required. Reads are never blocked, so the app can still fetch
  // GET /api/config/compat and render a graceful "update" screen. Version is
  // NEVER an authz input — this gates only an honest, identifiable stale build;
  // an unknown/legacy build is allowed through. See src/lib/api-version.ts.
  if (
    isMutating &&
    pathname.startsWith("/api/") &&
    isClientBelowMinimum(nativeClient)
  ) {
    return NextResponse.json(
      {
        error:
          "This version of the Summonarr app is no longer supported. Please update to the latest version.",
      },
      { status: 426 },
    );
  }

  // Origin check guards against CSRF on mutation endpoints; webhook and sync
  // routes use their own auth. Bearer/native-client requests are exempt — a
  // custom-header request can't be forged cross-origin, so it carries no
  // ambient-cookie CSRF risk (this also lets a native client POST the sign-in
  // route, which has no Origin header).
  if (isMutating && isProtectedApi && !bearerToken && !isNativeClient) {
    const refusal = csrfRefusal(request);
    if (refusal) return refusal;
  }

  // Resolve the session for the gating + role checks below. Public paths are
  // verified too, so a signed-in user browsing /login etc. still gets any
  // re-signed cookie (e.g. after a role change rotated the session).
  // Prefer the bearer token (native clients) over the cookie (browsers); the
  // two never coexist for one principal, and resolving the bearer first means a
  // forged cookie can never ride a CSRF-exempt bearer request.
  const sessionToken =
    bearerToken ?? parseSessionCookie(request.headers.get("cookie"));
  // The transport is where the token came from, and a token bound to the other
  // one is refused (guardrail 6h): a stolen browser cookie can't be replayed as
  // a bearer to dodge the cookie-only defences (the CSRF Origin check, rotation
  // on a privilege change), and a native token can't be planted in a browser as
  // a cookie. Rotation only on the cookie transport: this pass hands
  // a cookie client its replacement via Set-Cookie, but a bearer client is
  // never given a new token (guardrail 6b), so rotating its session would sign
  // the app out.
  const refreshResult = sessionToken
    ? await verifyAndRefreshSession(sessionToken, {
        transport: bearerToken ? "bearer" : "cookie",
        allowRotation: !bearerToken,
      })
    : null;
  const isLoggedIn = !!refreshResult;
  const role = refreshResult?.claims.role;

  if (!isPublicPath(pathname)) {
    if (!isLoggedIn) {
      // API clients (native apps, XHR) need a machine-readable 401, not a 302
      // to the HTML login page. Browser page navigations still get the redirect.
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Clear the cookie only when it is junk (forged, expired, malformed, or
      // bound to the bearer transport). A well-signed cookie that failed the DB
      // check may be the PRE-rotation copy a request carried while a privilege
      // change in another tab or prefetch renamed the session: by the time this
      // answer lands the browser holds the rotated cookie under the same name,
      // and Max-Age=0 would delete that one, signing the user out. Left alone,
      // the stale token is refused on every request and overwritten at sign-in.
      const keepCookie =
        !bearerToken && sessionToken !== null && (await verifySessionJwt(sessionToken, "cookie")) !== null;
      return loginRedirectResponse(buildLoginRedirect(request), !keepCookie);
    }

    // No User-Agent fingerprint check here any more (guardrail 6h). The client
    // writes that header, so an attacker replaying a stolen cookie just sent the
    // victim's browser family along with it; all the comparison ever did was
    // sign real users out when a browser changed its UA.

    // The effective mask (ADMIN role → superbit; unseeded → role preset), for
    // the /api/admin/* backstop and the /admin page gate below.
    const perms = effectivePermissions(
      role ?? "USER",
      parsePermissions(refreshResult.claims.permissions),
    );

    // Defense-in-depth backstop for the admin API surface — fails closed only if a
    // per-route withAdmin/withIssueAdmin/withPermission guard is ever missing, and
    // only for principals with NO admin-surface access at all.
    //
    // Must honor management permission bits, not just legacy ADMIN/ISSUE_ADMIN: a
    // plain USER may hold a granular bit (e.g. MANAGE_ISSUES, the modern equivalent
    // of ISSUE_ADMIN) that the per-route guard honors for routes like
    // /api/admin/fix-match/*. A role-only backstop would 403 those callers before
    // their route ran. So we also let through any principal holding a management
    // bit and deny here only when the principal has no admin-surface access of any
    // kind, where a missing per-route guard would otherwise fail open.
    if (
      pathname.startsWith("/api/admin/") &&
      role !== "ADMIN" &&
      role !== "ISSUE_ADMIN"
    ) {
      const hasAdminSurface = hasPermission(
        perms,
        [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS, Permission.MANAGE_ISSUES],
        "or",
      );
      if (!hasAdminSurface) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // The instance-configuration API is ADMIN-only, exactly: every /api/settings
    // route is withAdmin, which is hasRole on the role LABEL (a USER holding the
    // ADMIN bit is refused there too), and scripts/audit-routes.mts refuses any
    // weaker wrapper on this prefix (STRICT_ADMIN_PREFIXES). So this backstop
    // mirrors the routes precisely — it can never deny a caller a settings
    // handler would admit — and is deliberately stricter than the /api/admin/*
    // one above, which must let MANAGE_* delegates reach their per-route guard.
    // A settings route that ever ships with a weaker guard still answers 403
    // here to everyone but an ADMIN; the audit catches it in CI before that.
    // Admitting a delegate here means changing the wrapper, this check, the
    // audit list and both tests together, on purpose. tests/proxy.test.mts pins it.
    if (
      (pathname === "/api/settings" || pathname.startsWith("/api/settings/")) &&
      role !== "ADMIN"
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const lowerPath = pathname.toLowerCase();
    if (lowerPath.startsWith("/admin") && role !== "ADMIN") {
      // Honor granular MANAGE_* bits for page access (proxy must not redirect
      // before the server component's bit guard can run). ADMIN bit covers all.
      const canIssues = hasPermission(perms, Permission.MANAGE_ISSUES);
      const canUsers = hasPermission(perms, Permission.MANAGE_USERS);
      const canRequests = hasPermission(perms, Permission.MANAGE_REQUESTS);
      const isFullAdmin = hasPermission(perms, Permission.ADMIN);
      let allowed = isFullAdmin;
      if (!allowed) {
        if (lowerPath.startsWith("/admin/issues")) {
          allowed = canIssues;
        } else if (lowerPath.startsWith("/admin/users")) {
          allowed = canUsers;
        } else if (lowerPath === "/admin" || lowerPath.startsWith("/admin/")) {
          // Default admin surface (requests list) + catch-all for other admin pages
          // that pages themselves can further restrict (activity etc).
          allowed = canRequests || canUsers || canIssues;
        }
      }
      if (!allowed) {
        return NextResponse.redirect(appUrl("/", request));
      }
    }
  }

  // A fresh random nonce per request. It is passed on in the x-nonce request
  // header, and server components read it to stamp their inline scripts.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const cspValue = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspValue);

  // Hand the refreshed JWT to the DOWNSTREAM verifier in THIS pass. The session
  // is verified twice per request (here, then again in authenticateRequest for
  // API routes / authActive() for page renders), and both read the token off the
  // forwarded request. When this pass ROTATED the sessionId (a role/permission
  // change), the incoming credential is already dead — the second pass would find
  // no AuthSession row and 401 the route or redirect the page to /login. It also
  // carries the `dbCheckedAt` claim this pass just stamped, so the second verify
  // takes the fast path instead of repeating the whole DB-checked slow path.
  //
  // Must be set BEFORE NextResponse.next(): Next snapshots these headers into
  // x-middleware-request-* at construction time, so mutating afterwards is a
  // no-op.
  if (refreshResult?.refreshed) {
    if (bearerToken) {
      // Bearer transport: rewrite the FORWARDED Authorization header. This is
      // purely server-internal — the client is handed no replacement (no
      // Set-Cookie, no token in a body) and keeps presenting the token it
      // signed in with, so guardrail 6b's "no refresh for bearer clients" holds.
      // Without this a bearer request paid the full DB-checked verify TWICE:
      // `dbCheckedAt` is only stamped by the re-sign here, so a bearer token
      // that was never rewritten could never take the fast path.
      requestHeaders.set(
        "authorization",
        `Bearer ${refreshResult.refreshed.token}`,
      );
    } else {
      requestHeaders.set(
        "cookie",
        replaceSessionCookie(request.headers.get("cookie"), refreshResult.refreshed.token),
      );
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", cspValue);
  // Advertise the API contract version so a native client can passively learn
  // server capability on any response. Authoritative source is the public
  // GET /api/config/compat; this is a coarse integer, never the marketing version.
  response.headers.set("X-Summonarr-Api", String(API_VERSION));

  // Send the re-signed JWT back to the browser whenever verifyAndRefreshSession
  // produced one (a sessionId rotation or a dbCheckedAt bump). Cookie sessions
  // only: a bearer client can't read Set-Cookie, so it keeps presenting the
  // token it was given at sign-in (guardrails 6b/6c).
  //
  // A response carrying a session token must never be stored: a shared cache
  // replaying it would hand this session to the next visitor. Next leaves a
  // Cache-Control the proxy set alone (send-payload.js only fills one in when
  // none exists), so this also covers page renders, which next.config.ts's
  // /api/* header rule doesn't reach.
  if (refreshResult?.refreshed && !bearerToken) {
    response.headers.append(
      "Set-Cookie",
      serializeSessionCookie(refreshResult.refreshed.token, {
        maxAgeSeconds: refreshResult.refreshed.expiresInSeconds,
      }),
    );
    markSessionResponseUncacheable(response.headers);
  }
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|sw\\.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
