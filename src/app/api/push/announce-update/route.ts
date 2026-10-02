import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendAppUpdateNoticeToAllIos } from "@/lib/push";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin broadcast: sends the generic "Update Summonarr" push to every iOS
// device registered on this server (all users, platform "ios"). Content is
// fixed and user-free — pair it with the `recommendedIosBuild` setting so the
// app also shows its dismissible update sheet. Like /api/push/test this is a
// deliberate operator action, so it bypasses the `feature.integration.push`
// flag and per-event preferences. Hard rate-limited: a broadcast hits every
// device at once, so 2 per hour per admin.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`push-announce-update:${session.user.id}`, 2, 60 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const { sent, failed } = await sendAppUpdateNoticeToAllIos();
  return NextResponse.json({ ok: true, sent, failed });
});
