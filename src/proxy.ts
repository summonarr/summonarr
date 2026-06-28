import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isLocalHost } from "@/lib/local-only";
import {
  parseSessionCookie,
  serializeSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import { verifyAndRefreshSession } from "@/lib/session-refresh";
import {
  parseBearerToken,
  hasNativeClientHeader,
  NATIVE_CLIENT_HEADER,
} from "@/lib/mobile-auth";
import {
  extractUaFingerprint,
  serializeFingerprint,
} from "@/lib/ua-fingerprint";
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

const envOrigins: ReadonlySet<string> = (() => {
  const trusted = new Set<string>();
  for (const raw of [
    process.env.AUTH_URL,
    ...(process.env.AUTH_TRUSTED_ORIGIN ?? "").split(","),
  ]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    try { trusted.add(new URL(trimmed).origin); } catch { }
  }
  if (trusted.size === 0 && process.env.NODE_ENV === "production") {
    console.error(
      "[proxy] No trusted origins configured in production. " +
      "Set AUTH_URL to allow browser API calls."
    );
  }
  return trusted;
})();

const trustedOriginsCache = new Map<string, ReadonlySet<string>>();

function buildTrustedOrigins(selfOrigin: string): ReadonlySet<string> {
  if (envOrigins.size > 0) return envOrigins;
  const cached = trustedOriginsCache.get(selfOrigin);
  if (cached) return cached;
  const fallback = new Set<string>([selfOrigin]);
  trustedOriginsCache.set(selfOrigin, fallback);
  return fallback;
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/auth/plex") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/setup/") ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/discord/") ||
    pathname === "/api/sync" ||
    pathname.startsWith("/api/sync/") ||
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/interactions" ||
    pathname === "/api/health" ||
    pathname === "/api/config/compat"
  );
}

function buildLoginRedirect(req: NextRequest): URL {
  const baseUrl =
    process.env.AUTH_URL ?? req.nextUrl.origin;
  const basePath = process.env.BASE_PATH ?? "";
  const url = new URL(`${basePath}/login`, baseUrl);
  url.searchParams.set("callbackUrl", req.nextUrl.pathname);
  return url;
}

function clearedCookieResponse(redirectTo: URL): Response {
  const res = new Response(null, {
    status: 302,
    headers: { Location: redirectTo.toString() },
  });
  for (const cookie of serializeClearedSessionCookies()) {
    res.headers.append("Set-Cookie", cookie);
  }
  return res;
}

export async function proxy(request: NextRequest) {
  // Local-only mode: when TRUST_PROXY is not "true" we cannot read the real
  // client IP, so we refuse any request whose Host header is not a
  // loopback/RFC1918 address. Footgun-prevention for misconfigured public
  // deployments — see src/lib/local-only.ts.
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
  // not a cookie-riding CSRF vector AND the UA-fingerprint cookie-binding does
  // not apply. See src/lib/mobile-auth.ts.
  const bearerToken = parseBearerToken(request.headers.get("authorization"));
  const isNativeClient = hasNativeClientHeader(
    request.headers.get(NATIVE_CLIENT_HEADER),
  );
  // Parsed form of the same header (platform/build/api) for the version gate
  // below. Presence (isNativeClient) drives the CSRF/fingerprint skips; the
  // parsed build drives the 426 force-upgrade gate.
  const nativeClient = parseNativeClient(
    request.headers.get(NATIVE_CLIENT_HEADER),
  );

  // Auth routes that legitimately have no Origin header:
  //   - oidc/callback: top-level redirect initiated by the IdP.
  //   - oidc/start: same-site top-level navigation (no Origin sent by browsers
  //     on top-level navigations).
  //   - machine-session: server-to-server caller with Bearer CRON_SECRET.
  // Browser-facing sign-in/sign-out/register POSTs DO send Origin and SHOULD
  // be Origin-checked to defend against login-CSRF and forced-logout-CSRF.
  const isAuthRouteExemptFromCsrf =
    pathname === "/api/auth/oidc/callback" ||
    pathname === "/api/auth/oidc/start" ||
    pathname === "/api/auth/machine-session";
  const isProtectedApi =
    pathname.startsWith("/api/") &&
    !isAuthRouteExemptFromCsrf &&
    !pathname.startsWith("/api/webhooks/") &&
    pathname !== "/api/sync" &&
    !pathname.startsWith("/api/sync/") &&
    !pathname.startsWith("/api/cron/") &&
    pathname !== "/api/interactions";

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
    const origin = request.headers.get("origin");
    let effectiveOrigin = origin;
    if (!effectiveOrigin) {
      const referer = request.headers.get("referer");
      if (referer) {
        try { effectiveOrigin = new URL(referer).origin; } catch { }
      }
    }
    if (effectiveOrigin) {
      const trusted = buildTrustedOrigins(request.nextUrl.origin);
      if (!trusted.has(effectiveOrigin)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
    }
  }

  // Resolve session for the gating + role checks below. Public paths still
  // pass through verifyAndRefreshSession so the cookie gets refreshed even
  // when visiting /login — keeps the slide alive while a logged-in user
  // navigates around the public surface.
  // Prefer the bearer token (native clients) over the cookie (browsers); the
  // two never coexist for one principal, and resolving the bearer first means a
  // forged cookie can never ride a CSRF-exempt bearer request.
  const sessionToken =
    bearerToken ?? parseSessionCookie(request.headers.get("cookie"));
  const refreshResult = sessionToken
    ? await verifyAndRefreshSession(sessionToken)
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
      return clearedCookieResponse(buildLoginRedirect(request));
    }

    // UA fingerprint check. Skipped for machine sessions (CRON_SECRET-bound) and
    // for bearer sessions: a native client holds its JWT in app-secure storage
    // and presents it explicitly, so the device-class binding that hardens an
    // ambiently-replayed browser cookie doesn't apply. Browser cookie sessions
    // get the full check.
    const storedFp = refreshResult.claims.uaFingerprint;
    if (!bearerToken && storedFp && !storedFp.startsWith("machine:")) {
      const currentFp = serializeFingerprint(
        extractUaFingerprint(request.headers.get("user-agent") ?? ""),
      );
      if (currentFp !== storedFp) {
        return clearedCookieResponse(buildLoginRedirect(request));
      }
    }

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
      const perms = effectivePermissions(
        role ?? "USER",
        parsePermissions(refreshResult.claims.permissions),
      );
      const hasAdminSurface = hasPermission(
        perms,
        [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS, Permission.MANAGE_ISSUES],
        "or",
      );
      if (!hasAdminSurface) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const lowerPath = pathname.toLowerCase();
    if (lowerPath.startsWith("/admin") && role !== "ADMIN") {
      if (
        role !== "ISSUE_ADMIN" ||
        !lowerPath.startsWith("/admin/issues")
      ) {
        const baseUrl =
          process.env.AUTH_URL ??
          request.nextUrl.origin;
        const basePath = process.env.BASE_PATH ?? "";
        return NextResponse.redirect(new URL(`${basePath}/`, baseUrl));
      }
    }
  }

  // Nonce is propagated via x-nonce request header; server components read it to stamp inline scripts
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const cspValue = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data: https://image.tmdb.org https://plex.tv https://assets.plex.tv https://secure.gravatar.com https://i0.wp.com",
    "font-src 'self'",
    `connect-src 'self' https://plex.tv${(() => { try { return process.env.OIDC_ISSUER ? ` ${new URL(process.env.OIDC_ISSUER).origin}` : ""; } catch { return ""; } })()}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspValue);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", cspValue);
  // Advertise the API contract version so a native client can passively learn
  // server capability on any response. Authoritative source is the public
  // GET /api/config/compat; this is a coarse integer, never the marketing version.
  response.headers.set("X-Summonarr-Api", String(API_VERSION));

  // Carry the refreshed JWT through to the client whenever verifyAndRefresh
  // produced one — sliding window or sessionId rotation or dbCheckedAt bump.
  // Only for cookie sessions: a bearer client can't read Set-Cookie, so it
  // rides its original fixed-lifetime token until expiry, then re-authenticates.
  if (refreshResult?.refreshed && !bearerToken) {
    response.headers.append(
      "Set-Cookie",
      serializeSessionCookie(refreshResult.refreshed.token, {
        maxAgeSeconds: refreshResult.refreshed.expiresInSeconds,
      }),
    );
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
