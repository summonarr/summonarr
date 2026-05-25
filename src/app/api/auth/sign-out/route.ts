import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  parseSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import { verifySessionJwt } from "@/lib/session-jwt";
import { logAudit } from "@/lib/audit";

// Summonarr-native sign-out. Deletes the AuthSession row (the cross-replica
// revocation source of truth) and clears both Summonarr session cookie
// variants. Dead in prod until PR 5 swaps the client's signOut() call.
export async function POST(req: NextRequest) {
  const token = parseSessionCookie(req.headers.get("cookie"));
  if (token) {
    const claims = await verifySessionJwt(token);
    if (claims?.sessionId) {
      void prisma.authSession
        .delete({ where: { sessionId: claims.sessionId } })
        .catch(() => {});
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
