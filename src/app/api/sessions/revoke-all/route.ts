import { NextResponse } from "next/server";
import { requireStepUp } from "@/lib/step-up-auth";
import { notifyAccountSecurityEvent } from "@/lib/account-security-notify";
import { withAuth } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { signOutEverywhere } from "@/lib/sign-out-everywhere";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { readJsonCappedOr } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// One-shot "sign out everywhere" endpoint. Two modes via the includeCurrent body flag:
//
//   includeCurrent=false (default): revoke every other AuthSession row, keep the caller
//     signed in.
//
//   includeCurrent=true: every row, and User.sessionsRevokedAt = now —
//     verifyAndRefreshSession() (src/lib/session-refresh.ts) rejects every JWT minted
//     before it, so the caller is signed out too. Use this when you suspect compromise.
//
// The write itself (rows, cutoff, footholds, calendar token, the in-memory
// revocation marks) is signOutEverywhere (src/lib/sign-out-everywhere.ts).
//
// Step-up auth mirrors DELETE /api/sessions: credentials users prove with
// confirmPassword, SSO users must hold a session younger than 5 minutes.

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`sessions-revoke-all:${session.user.id}`, 5, 60 * 60_000)) {
    return NextResponse.json(
      { error: "rate_limit", message: t("apiAuth.sessions.revokeAllRateLimit") },
      { status: 429 },
    );
  }

  const parsed = await readJsonCappedOr<{ confirmPassword?: string; includeCurrent?: boolean }>(req, 16 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : undefined;
  const includeCurrent = body.includeCurrent === true;

  const denied = await requireStepUp({
    req,
    session,
    confirmPassword,
    context: includeCurrent ? "revoke-all" : "revoke-others",
    messages: {
      passwordRequired: t("apiAuth.sessions.confirmPasswordSignOut"),
      recentSignInRequired: t("apiAuth.sessions.recentSignInSignOut"),
    },
    t,
  });
  if (denied) return denied;

  const deletedCount = await signOutEverywhere(session.user.id, session.sessionId, includeCurrent);
  void notifyAccountSecurityEvent(session.user.id, includeCurrent ? "signed-out-all" : "signed-out-others");

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "unknown",
    action: "SESSION_REVOKE",
    target: `user:${session.user.id}`,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    details: {
      kind: includeCurrent ? "revoke-all" : "revoke-others",
      count: deletedCount,
      steppedUp: true,
    },
  });

  return NextResponse.json({ ok: true, count: deletedCount, includeCurrent });
});
