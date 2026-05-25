import { NextResponse, type NextRequest } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import {
  parseSessionCookie,
  serializeSessionCookie,
} from "@/lib/session-cookie";
import {
  signSessionJwt,
  verifySessionJwt,
  type SessionClaims,
} from "@/lib/session-jwt";

// Session source for the new SummonarrSessionProvider on the client.
//
// Two paths:
//   1. Fast path: a valid Summonarr session cookie is already set. Verify and
//      return the claims. No DB hit, no next-auth round-trip.
//   2. Transitional backfill: the user has a next-auth session but no
//      Summonarr cookie yet (post-deploy first request). Mint one from the
//      live next-auth session so the next request hits the fast path.
//
// The backfill exists only for the migration window — it lets the new path
// carry real data before any sign-in route has been switched over. PR 5
// (next-auth rip) deletes the auth()/isTokenExpired fallback along with
// next-auth itself.
//
// Route is exempt from the api-auth wrappers because *it is* the session
// source — wrapping with withAuth would 401 anyone who has only the new
// cookie. Audit-routes allowlists everything under /api/auth/.

interface PublicSession {
  user: {
    id: string;
    role: string;
    provider?: string;
    mediaServer?: string | null;
  };
  sessionId?: string;
  expiresAt?: number;
}

function serialize(claims: SessionClaims): PublicSession {
  return {
    user: {
      id: claims.id,
      role: claims.role,
      provider: claims.provider,
      mediaServer: claims.mediaServer ?? null,
    },
    sessionId: claims.sessionId,
    expiresAt: claims.expiresAt,
  };
}

export async function GET(req: NextRequest) {
  const cookieToken = parseSessionCookie(req.headers.get("cookie"));
  if (cookieToken) {
    const claims = await verifySessionJwt(cookieToken);
    if (claims) return NextResponse.json({ session: serialize(claims) });
  }

  const naSession = await auth();
  if (!naSession?.user?.id || isTokenExpired(naSession)) {
    return NextResponse.json({ session: null }, { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = naSession.tokenExpiresAt
    ? Math.max(60, naSession.tokenExpiresAt - now)
    : 60 * 60 * 24 * 30;

  const minted = await signSessionJwt(
    {
      id: naSession.user.id,
      role: naSession.user.role,
      provider: naSession.user.provider,
      mediaServer: naSession.user.mediaServer ?? null,
      sessionId: naSession.sessionId,
      uaFingerprint: (naSession as unknown as { uaFingerprint?: string })
        .uaFingerprint,
      expiresAt: naSession.tokenExpiresAt,
    },
    { expiresInSeconds },
  );

  const verified = await verifySessionJwt(minted);
  if (!verified) {
    // Defensive: we just signed it; verification failing means a key mismatch
    // mid-request, which would surface elsewhere too. Surface a 500 rather
    // than a misleading 401 so it's diagnosable.
    return NextResponse.json({ session: null }, { status: 500 });
  }

  const res = NextResponse.json({ session: serialize(verified) });
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(minted, { maxAgeSeconds: expiresInSeconds }),
  );
  return res;
}
