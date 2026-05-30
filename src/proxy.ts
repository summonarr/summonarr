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
  extractUaFingerprint,
  serializeFingerprint,
} from "@/lib/ua-fingerprint";

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
    pathname === "/api/health"
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

  // Origin check guards against CSRF on mutation endpoints; webhook and sync routes use their own auth
  if (isMutating && isProtectedApi) {
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
  const cookieToken = parseSessionCookie(request.headers.get("cookie"));
  const refreshResult = cookieToken
    ? await verifyAndRefreshSession(cookieToken)
    : null;
  const isLoggedIn = !!refreshResult;
  const role = refreshResult?.claims.role;

  if (!isPublicPath(pathname)) {
    if (!isLoggedIn) {
      return clearedCookieResponse(buildLoginRedirect(request));
    }

    // UA fingerprint check. Machine sessions (auth.config.ts had a special
    // marker for these) — for now we just skip the check entirely; PR 6 can
    // restore them if needed. Browser sessions get the full check.
    const storedFp = refreshResult.claims.uaFingerprint;
    if (storedFp && !storedFp.startsWith("machine:")) {
      const currentFp = serializeFingerprint(
        extractUaFingerprint(request.headers.get("user-agent") ?? ""),
      );
      if (currentFp !== storedFp) {
        return clearedCookieResponse(buildLoginRedirect(request));
      }
    }

    // Defense-in-depth backstop for the admin API surface. Per-route
    // withAdmin/withIssueAdmin guards are the source of truth for the exact
    // ADMIN-vs-ISSUE_ADMIN decision; this only fails closed if such a guard
    // is ever missing, and only for roles with NO admin access at all.
    if (
      pathname.startsWith("/api/admin/") &&
      role !== "ADMIN" &&
      role !== "ISSUE_ADMIN"
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  // Carry the refreshed JWT through to the client whenever verifyAndRefresh
  // produced one — sliding window or sessionId rotation or dbCheckedAt bump.
  if (refreshResult?.refreshed) {
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
