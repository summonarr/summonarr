import { NextResponse, type NextRequest } from "next/server";
import {
  parseSessionCookie,
  serializeSessionCookie,
} from "@/lib/session-cookie";
import { verifyAndRefreshSession } from "@/lib/session-refresh";
import type { SessionClaims } from "@/lib/session-jwt";

interface PublicSession {
  user: {
    id: string;
    role: string;
    email?: string | null;
    name?: string | null;
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
      email: claims.email ?? null,
      name: claims.name ?? null,
      provider: claims.provider,
      mediaServer: claims.mediaServer ?? null,
    },
    sessionId: claims.sessionId,
    expiresAt: claims.expiresAt,
  };
}

// Session source for the client-side SummonarrSessionProvider. Reads the
// Summonarr session cookie, runs the verify+refresh pipeline (revocation
// check + sliding window + role refresh), returns the session and threads
// any refreshed JWT back as Set-Cookie.
export async function GET(req: NextRequest) {
  const token = parseSessionCookie(req.headers.get("cookie"));
  if (!token) {
    return NextResponse.json({ session: null }, { status: 401 });
  }
  const result = await verifyAndRefreshSession(token);
  if (!result) {
    return NextResponse.json({ session: null }, { status: 401 });
  }
  const res = NextResponse.json({ session: serialize(result.claims) });
  if (result.refreshed) {
    res.headers.append(
      "Set-Cookie",
      serializeSessionCookie(result.refreshed.token, {
        maxAgeSeconds: result.refreshed.expiresInSeconds,
      }),
    );
  }
  return res;
}
