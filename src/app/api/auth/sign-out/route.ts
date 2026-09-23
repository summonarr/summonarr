import { NextResponse, type NextRequest } from "next/server";
import {
  parseSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import { parseBearerToken } from "@/lib/mobile-auth";
import { verifySessionJwt } from "@/lib/session-jwt";
import { revokeSessionById } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Sign-out. Revokes the session on the server (deletes its AuthSession row) and
// clears both Summonarr session cookie variants in the browser.
export async function POST(req: NextRequest) {
  // Bearer (native clients) preferred over the cookie (browsers) so a native
  // sign-out revokes the session server-side, not just client-side.
  const token =
    parseBearerToken(req.headers.get("authorization")) ??
    parseSessionCookie(req.headers.get("cookie"));
  if (token) {
    const claims = await verifySessionJwt(token);
    if (claims?.sessionId) {
      // revokeSessionById deletes the row and also marks the session as
      // force-revoked in memory, so a copied JWT is rejected on its very next
      // request instead of riding the short "recently DB-checked" fast path.
      // It throws on a DB failure; we catch it here because a failed server-side
      // revoke must not stop the cookie clearing below.
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
