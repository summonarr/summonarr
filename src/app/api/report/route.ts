import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { sanitizeText } from "@/lib/sanitize";
import { prisma } from "@/lib/prisma";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { hasPermission, Permission } from "@/lib/permissions";

// POST /api/report — a signed-in user flags user-generated content (an issue
// message, a vote reason) for the instance admin to review. The report lands in
// the admin Audit Log (action CONTENT_REPORT). This satisfies the "report
// objectionable content" half of App Store Guideline 1.2 for the app's UGC
// surfaces; moderation itself (delete the issue/message, remove the user) already
// lives in the admin UI, and the instance is private/invite-only.
const CONTENT_TYPES = ["issue_message", "vote_reason", "issue"] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

const MAX_REASON = 500;

type Viewer = { userId: string; managesIssues: boolean };

// Whether the reported item exists and the reporter can see it, per content
// type. Issues and their messages are private to the reporter and the issue
// managers (the issues routes' rule); vote reasons are on the shared votes list.
const REPORTABLE: Record<ContentType, (id: string, viewer: Viewer) => Promise<boolean>> = {
  issue: async (id, viewer) =>
    (await prisma.issue.count({ where: { id, ...(viewer.managesIssues ? {} : { reportedBy: viewer.userId }) } })) > 0,
  issue_message: async (id, viewer) =>
    (await prisma.issueMessage.count({ where: { id, ...(viewer.managesIssues ? {} : { issue: { reportedBy: viewer.userId } }) } })) > 0,
  vote_reason: async (id) => (await prisma.deletionVote.count({ where: { id } })) > 0,
};

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  // 10 reports/hour/user — a spam guard, not a security boundary.
  if (!checkRateLimit(`report:${session.user.id}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: t("apiUser.report.rateLimited") },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<{ contentType?: string; contentId?: string; context?: string; reason?: string }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { contentType, contentId } = body;
  if (!contentType || !CONTENT_TYPES.includes(contentType as ContentType)) {
    return NextResponse.json(
      { error: t("apiUser.report.contentTypeOneOf", { values: CONTENT_TYPES.join(", ") }) },
      { status: 400 },
    );
  }
  if (!contentId || typeof contentId !== "string" || contentId.length > 200) {
    return NextResponse.json({ error: t("apiUser.report.contentIdRequired") }, { status: 400 });
  }

  // Confirm the reported content exists AND that the reporter can see it before
  // writing the audit row: otherwise an arbitrary contentId pollutes the admin
  // Audit Log, and the 404-vs-ok answer tells anyone whether an issue they can't
  // see exists.
  const viewer = {
    userId: session.user.id,
    managesIssues: hasPermission(session.user.permissions, Permission.MANAGE_ISSUES),
  };
  if (!(await REPORTABLE[contentType as ContentType](contentId, viewer))) {
    return NextResponse.json({ error: t("apiUser.report.notFound") }, { status: 404 });
  }

  // One report per reporter per item: a repeat adds nothing for the admin to
  // review, so it answers ok without a second row.
  const target = `${contentType}:${contentId}`;
  const already = await prisma.auditLog.findFirst({
    where: { action: "CONTENT_REPORT", target, userId: session.user.id },
    select: { id: true },
  });
  if (already) return NextResponse.json({ ok: true });

  const context = typeof body.context === "string" ? sanitizeText(body.context).slice(0, 200) : undefined;
  const reason = typeof body.reason === "string" ? sanitizeText(body.reason).slice(0, MAX_REASON) : undefined;

  // The audit write IS the operation here (there is no prior mutation), so
  // logAuditOrFail is correct — a failed write must surface as an error, not a
  // false "reported" (guardrail 26 only bars logAuditOrFail *after* a committed
  // mutation, which this is not).
  await logAuditOrFail({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "CONTENT_REPORT",
    target,
    details: { contentType, contentId, context, reason },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
