import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendAppUpdateNoticeToAllIos } from "@/lib/push";

// Admin broadcast: sends the generic "Update Summonarr" push to every iOS
// device registered on this server (all users, platform "ios"). Content is
// fixed and user-free — pair it with the `recommendedIosBuild` setting so the
// app also shows its dismissible update sheet. Like /api/push/test this is a
// deliberate operator action, so it bypasses the `feature.integration.push`
// flag and per-event preferences. Hard rate-limited: a broadcast hits every
// device at once, so 2 per hour per admin.
export const POST = withAdmin(async (_req, _ctx, session) => {
  if (!checkRateLimit(`push-announce-update:${session.user.id}`, 2, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const { sent, failed } = await sendAppUpdateNoticeToAllIos();
  return NextResponse.json({ ok: true, sent, failed });
});
