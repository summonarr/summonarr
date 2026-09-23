import { NextResponse, type NextRequest } from "next/server";
import { machineIpAllowed } from "@/lib/api-auth";
import {
  parseSessionCookie,
  serializeSessionCookie,
} from "@/lib/session-cookie";
import { parseBearerToken } from "@/lib/mobile-auth";
import { matchesStoredFingerprint } from "@/lib/ua-fingerprint";
import { verifyAndRefreshSession } from "@/lib/session-refresh";
import type { SessionClaims } from "@/lib/session-jwt";

interface PublicSession {
  user: {
    id: string;
    role: string;
    // Decimal string for the effective permission bitmask. Client uses it for
    // nav/visibility decisions so granular MANAGE_* users see the right UI.
    permissions?: string;
    email?: string | null;
    name?: string | null;
    provider?: string;
    mediaServer?: string | null;
  };
  expiresAt?: number;
}

function serialize(claims: SessionClaims): PublicSession {
  // sessionId is intentionally omitted: no client consumer reads it (server
  // components that need it use auth() which carries the full claims) and
  // exposing it widens the JS-visible surface for no benefit.
  return {
    user: {
      id: claims.id,
      role: claims.role,
      permissions: claims.permissions ?? undefined,
      email: claims.email ?? null,
      name: claims.name ?? null,
      provider: claims.provider,
      mediaServer: claims.mediaServer ?? null,
    },
    expiresAt: claims.expiresAt,
  };
}

function applyPrivacyHeaders(res: NextResponse): NextResponse {
  // Never let a shared HTTP cache (corporate proxy, mis-configured CDN, BFCache,
  // service worker default cache) serve one user's session payload to the next
  // visitor. `private` blocks shared caches; `no-store` blocks even private
  // ones from persisting. `Vary: Cookie` is belt-and-suspenders for the few
  // legitimate caches that do honor private.
  res.headers.set("Cache-Control", "no-store, private, must-revalidate");
  res.headers.set("Pragma", "no-cache");
  res.headers.set("Vary", "Cookie");
  return res;
}

// Session source for the client-side SummonarrSessionProvider. Reads the
// session (bearer token or cookie), runs the verify+refresh pipeline
// (revocation check, sign-in deadline, role refresh), returns the session, and
// sends any re-signed JWT back to browsers as Set-Cookie.
export async function GET(req: NextRequest) {
  // Bearer (native clients) preferred over the cookie (browsers).
  const bearer = parseBearerToken(req.headers.get("authorization"));
  const token = bearer ?? parseSessionCookie(req.headers.get("cookie"));
  if (!token) {
    return applyPrivacyHeaders(NextResponse.json({ session: null }, { status: 401 }));
  }
  const result = await verifyAndRefreshSession(token);
  if (!result) {
    return applyPrivacyHeaders(NextResponse.json({ session: null }, { status: 401 }));
  }
  // UA-fingerprint replay check for cookie sessions. /api/auth/me is a public path
  // (isPublicPath in proxy.ts), so the proxy never runs the fingerprint check here —
  // enforce the cookie→device binding ourselves, matching the withAuth wrappers.
  // Bearer (native) sessions skip it: the JWT lives in app-secure storage, not an
  // ambiently-replayed cookie.
  if (!bearer && !matchesStoredFingerprint(result.claims.uaFingerprint, req.headers.get("user-agent"))) {
    return applyPrivacyHeaders(NextResponse.json({ session: null }, { status: 401 }));
  }
  // A machine session carries the IP allowlist that was in force when it was
  // minted, and every other authenticated surface re-checks it per request
  // (authActive and the withAuth/withAdmin wrappers). Check it here too, or a
  // leaked machine token used from a disallowed address could still read the
  // impersonated identity (id, role, permissions) from this route.
  // Unlike the fingerprint check above, this applies to bearer sessions as well.
  // No allowlist ⇒ true, so ordinary user sessions are unaffected.
  if (!machineIpAllowed(result.claims, req.headers)) {
    return applyPrivacyHeaders(NextResponse.json({ session: null }, { status: 401 }));
  }
  const res = applyPrivacyHeaders(NextResponse.json({ session: serialize(result.claims) }));
  if (result.refreshed && !bearer) {
    res.headers.append(
      "Set-Cookie",
      serializeSessionCookie(result.refreshed.token, {
        maxAgeSeconds: result.refreshed.expiresInSeconds,
      }),
    );
  }
  return res;
}
