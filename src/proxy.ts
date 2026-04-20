

import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

// Trusted origins are computed once at module load from env; per-request fallback uses the incoming host
const envOrigins: ReadonlySet<string> = (() => {
  const trusted = new Set<string>();
  for (const raw of [
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
    ...(process.env.AUTH_TRUSTED_ORIGIN ?? "").split(","),
  ]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    try { trusted.add(new URL(trimmed).origin); } catch { }
  }
  if (trusted.size === 0 && process.env.NODE_ENV === "production") {
    console.error(
      "[proxy] No trusted origins configured in production. " +
      "Set AUTH_URL or NEXTAUTH_URL to allow browser API calls."
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

export const proxy = auth(function proxyHandler(
  request: NextRequest,
  _event: NextFetchEvent,
) {
  const { pathname } = request.nextUrl;

  const NEXTAUTH_PATHS = [
    "/api/auth/signin",
    "/api/auth/signout",
    "/api/auth/session",
    "/api/auth/csrf",
    "/api/auth/callback",
    "/api/auth/providers",
    "/api/auth/error",
    "/api/auth/verify-request",
  ];
  const isNextAuthRoute = NEXTAUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const isProtectedApi =
    pathname.startsWith("/api/") &&
    !isNextAuthRoute &&
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
  return response;
});

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
