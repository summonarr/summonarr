import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { sanitizeForLog } from "@/lib/sanitize";
import { TraktRateLimitedError, getTraktOAuthConfig, pollTraktDeviceAuth } from "@/lib/trakt-user";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// One poll of the caller's pending Trakt connection. `state`:
//   pending   — not approved yet; poll again after the interval;
//   connected — stored (with `username`); the cron picks it up on its next run;
//   expired   — the code lapsed, was used, or nothing is pending: start again;
//   denied    — the user refused on trakt.tv;
//   conflict  — that Trakt account is connected to another Summonarr account.
// The server paces the real Trakt calls itself, so polling faster than the
// interval only gets "pending" answers.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  if (!checkRateLimit(`trakt-poll:${session.user.id}`, 40, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  const cfg = await getTraktOAuthConfig();
  if (!cfg) return NextResponse.json({ error: t("apiAuth.profile.trakt.unavailable") }, { status: 400 });
  try {
    const result = await pollTraktDeviceAuth(session.user.id, cfg);
    if (result.state === "connected") {
      // A credential was stored. After the commit, swallowing (guardrail 26).
      void logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email ?? "unknown",
        action: "SETTINGS_CHANGE",
        target: `user:${session.user.id}`,
        details: { kind: "trakt-connect", traktUser: result.username },
        ...auditContext(req, session),
      });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TraktRateLimitedError) {
      return NextResponse.json({ error: t("apiAuth.profile.trakt.busy") }, { status: 429 });
    }
    console.error(`[trakt] device poll for user ${session.user.id} failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    return NextResponse.json({ error: t("apiAuth.profile.trakt.unreachable") }, { status: 502 });
  }
});
