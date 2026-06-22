import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAuditOrFail, auditContext } from "@/lib/audit";

// POST /api/report — a signed-in user flags user-generated content (an issue
// message, a vote reason) for the instance admin to review. The report lands in
// the admin Audit Log (action CONTENT_REPORT). This satisfies the "report
// objectionable content" half of App Store Guideline 1.2 for the app's UGC
// surfaces; moderation itself (delete the issue/message, remove the user) already
// lives in the admin UI, and the instance is private/invite-only.
const CONTENT_TYPES = ["issue_message", "vote_reason", "issue"] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

const MAX_REASON = 500;

export const POST = withAuth(async (req, _ctx, session) => {
  // 10 reports/hour/user — a spam guard, not a security boundary.
  if (!checkRateLimit(`report:${session.user.id}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many reports — please wait a while before reporting again." },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<{ contentType?: string; contentId?: string; context?: string; reason?: string }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { contentType, contentId } = body;
  if (!contentType || !CONTENT_TYPES.includes(contentType as ContentType)) {
    return NextResponse.json(
      { error: `contentType must be one of: ${CONTENT_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  if (!contentId || typeof contentId !== "string" || contentId.length > 200) {
    return NextResponse.json({ error: "contentId is required" }, { status: 400 });
  }
  const context = typeof body.context === "string" ? body.context.slice(0, 200) : undefined;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, MAX_REASON) : undefined;

  // The audit write IS the operation here (there is no prior mutation), so
  // logAuditOrFail is correct — a failed write must surface as an error, not a
  // false "reported" (guardrail 26 only bars logAuditOrFail *after* a committed
  // mutation, which this is not).
  await logAuditOrFail({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "CONTENT_REPORT",
    target: `${contentType}:${contentId}`,
    details: { contentType, contentId, context, reason },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
