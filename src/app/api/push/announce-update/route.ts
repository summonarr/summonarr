import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendAppUpdateNoticeToAllIos } from "@/lib/push";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { auditActor, logAudit } from "@/lib/audit";

// Admin broadcast: sends the generic "Update Summonarr" push to every iOS
// device registered on this server (all users, platform "ios"). Content is
// fixed and user-free — pair it with the `recommendedIosBuild` setting so the
// app also shows its dismissible update sheet. Like /api/push/test this is a
// deliberate operator action, so it bypasses the `feature.integration.push`
// flag and per-event preferences. Hard rate-limited: a broadcast hits every
// device at once, so 2 per hour per admin AND 2 per hour for the whole server —
// several admins must not multiply what each device receives.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const HOUR = 60 * 60 * 1000;
  if (
    !checkRateLimit(`push-announce-update:${session.user.id}`, 2, HOUR) ||
    !checkRateLimit("push-announce-update:server", 2, HOUR)
  ) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  try {
    const { sent, failed } = await sendAppUpdateNoticeToAllIos();
    // Every device already got it; a failed audit write must not 500 the send
    // (guardrail 26).
    void logAudit({
      ...auditActor(req, session),
      action: "PUSH_BROADCAST",
      target: "push:ios",
      details: { kind: "app-update", sent, failed },
    });
    return NextResponse.json({ ok: true, sent, failed });
  } catch (err) {
    // The device list read failed: nothing was sent.
    console.error("[push] update broadcast failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
