import { NextResponse, type NextRequest } from "next/server";
import {
  parseSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import { parseBearerToken } from "@/lib/mobile-auth";
import { verifySessionJwt } from "@/lib/session-jwt";
import { revokeSessionById } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Summonarr-native sign-out. Fully revokes the session server-side (deletes the
// AuthSession row AND bumps the user's sessionsRevokedAt cutoff so a captured
// copy of the JWT can't ride the fast-path cache window) and clears both
// Summonarr session cookie variants. Dead in prod until PR 5 swaps the client's
// signOut() call.
export async function POST(req: NextRequest) {
  // Bearer (native clients) preferred over the cookie (browsers) so a native
  // sign-out revokes the session server-side, not just client-side.
  const token =
    parseBearerToken(req.headers.get("authorization")) ??
    parseSessionCookie(req.headers.get("cookie"));
  if (token) {
    const claims = await verifySessionJwt(token);
    if (claims?.sessionId) {
      // Full revoke (not just a row delete): marks the session force-revoked in
      // the in-process ledger AND bumps the user's sessionsRevokedAt cutoff, so a
      // separately-captured copy of this JWT is rejected immediately instead of
      // surviving the dbCheckedAt fast-path window (up to 60s) after logout.
      // Best-effort server-side revoke: revokeSessionById no longer swallows its
      // error, but a DB failure here must NOT block the local sign-out (cookie
      // clearing) below. Catch, log, and continue clearing cookies.
      try {
        await revokeSessionById(claims.sessionId);
      } catch (err) {
        console.error("[auth] sign-out revoke failed (clearing cookie anyway):", err);
      }
      void logAudit({
        userId: claims.id,
        userName: claims.name ?? claims.email ?? "unknown",
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
