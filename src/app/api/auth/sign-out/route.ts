import { NextResponse, type NextRequest } from "next/server";
import {
  parseSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import { verifySessionJwt } from "@/lib/session-jwt";
import { revokeSessionById } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Summonarr-native sign-out. Fully revokes the session server-side (deletes the
// AuthSession row AND bumps the user's sessionsRevokedAt cutoff so a captured
// copy of the JWT can't ride the fast-path cache window) and clears both
// Summonarr session cookie variants. Dead in prod until PR 5 swaps the client's
// signOut() call.
export async function POST(req: NextRequest) {
  const token = parseSessionCookie(req.headers.get("cookie"));
  if (token) {
    const claims = await verifySessionJwt(token);
    if (claims?.sessionId) {
      // Full revoke (not just a row delete): marks the session force-revoked in
      // the in-process ledger AND bumps the user's sessionsRevokedAt cutoff, so a
      // separately-captured copy of this JWT is rejected immediately instead of
      // surviving the dbCheckedAt fast-path window (up to 60s) after logout.
      await revokeSessionById(claims.sessionId);
      void logAudit({
        userId: claims.id,
        userName: "unknown",
        action: "AUTH_LOGOUT",
        target: "auth:logout",
        provider: claims.provider ?? null,
      });
    }
  }

  const res = NextResponse.json({ ok: true });
  for (const cookie of serializeClearedSessionCookies()) {
    res.headers.append("Set-Cookie", cookie);
  }
  res.headers.set("Cache-Control", "no-store, private");
  return res;
}
