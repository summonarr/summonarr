import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { checkRateLimit } from "@/lib/rate-limit";
import { sanitizeForLog } from "@/lib/sanitize";
import {
  TraktRateLimitedError,
  getTraktOAuthConfig,
  startTraktDeviceAuth,
  traktUsesFor,
} from "@/lib/trakt-user";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { readJsonCappedOr } from "@/lib/body-size";
import { requireStepUp } from "@/lib/step-up-auth";

// Start connecting the caller's Trakt account (device-code flow, guardrail 34c).
// Answers the short code to enter at trakt.tv/activate; the device code itself
// stays on the server. The client then polls POST /api/profile/trakt/device/poll
// every `interval` seconds until it answers connected / expired / denied.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  if (!checkRateLimit(`trakt-device:${session.user.id}`, 5, 10 * 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  const [cfg, uses] = await Promise.all([getTraktOAuthConfig(), traktUsesFor(session.user.permissions)]);
  if (!cfg || (!uses.watchlist && !uses.history)) {
    return NextResponse.json({ error: t("apiAuth.profile.trakt.unavailable") }, { status: 400 });
  }
  // Step-up (guardrail 6g): a connected Trakt account files its watchlist as
  // this user's requests and survives a password change, so a hijacked session
  // must not be able to connect the hijacker's own Trakt. (No native client
  // calls this route.)
  const parsed = await readJsonCappedOr<{ confirmPassword?: unknown }>(req, 16 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const denied = await requireStepUp({
    req,
    session,
    confirmPassword: parsed.confirmPassword,
    context: "trakt-connect",
    messages: {
      passwordRequired: t("apiAuth.stepUp.passwordRequired"),
      recentSignInRequired: t("apiAuth.stepUp.recentSignIn"),
    },
    t,
  });
  if (denied) return denied;
  try {
    return NextResponse.json(await startTraktDeviceAuth(session.user.id, cfg));
  } catch (err) {
    if (err instanceof TraktRateLimitedError) {
      return NextResponse.json({ error: t("apiAuth.profile.trakt.busy") }, { status: 429 });
    }
    console.error(`[trakt] device code for user ${session.user.id} failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    return NextResponse.json({ error: t("apiAuth.profile.trakt.unreachable") }, { status: 502 });
  }
});
