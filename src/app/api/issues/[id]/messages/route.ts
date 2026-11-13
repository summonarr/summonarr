import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type SummonarrSession } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeText } from "@/lib/sanitize";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { hasPermission, Permission } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { promoteIssueInProgress } from "@/lib/issue-transitions";
import { announceIssueReply } from "@/lib/issue-reply-notify";
import { THREAD_READ_CAP } from "@/lib/api-body-limits";
import { splitAtCap, truncationHeaders } from "@/lib/truncation";
import { olderThanWhere, parseThreadCursor } from "@/lib/thread-cursor";
import type { Issue } from "@/generated/prisma";
import type { Translator } from "@/lib/i18n/translate";

type RouteContext = { params: Promise<{ id: string }> };

// The newest messages a thread read returns. A thread only grows (10 posts a
// minute per user), and every poll and live refresh re-reads it, so the read
// is bounded; the request-comment thread has the same cap.
const MAX_THREAD_MESSAGES = THREAD_READ_CAP;
const MAX_MESSAGE_LENGTH = 2000;

// The thread is the reporter's and the issue admins'. With issue reporting
// switched off (feature.page.issues), the reporter can neither read nor add to
// it; issue admins stay able to respond and wind threads down. Null = allowed.
async function threadAccessRefusal(
  issue: Issue,
  session: SummonarrSession,
  isIssueAdmin: boolean,
  t: Translator,
): Promise<NextResponse | null> {
  if (!isIssueAdmin && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: t("apiUser.common.forbidden") }, { status: 403 });
  }
  if (!isIssueAdmin && !(await isFeatureEnabled("feature.page.issues"))) {
    return NextResponse.json({ error: t("apiUser.issues.disabled") }, { status: 403 });
  }
  return null;
}

export const GET = withAuth(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  const isAdmin = hasPermission(session.user.permissions, Permission.MANAGE_ISSUES);
  const refused = await threadAccessRefusal(issue, session, isAdmin, t);
  if (refused) return refused;

  // The newest MAX_THREAD_MESSAGES, answered oldest first: the response stays the
  // bare array clients decode (guardrail 25). `?before=<createdAt>|<id>` reads the
  // page of messages older than that one (same shape and cap; X-Truncated says
  // whether still older ones remain).
  const before = parseThreadCursor(req.nextUrl.searchParams.get("before"));
  const newest = await prisma.issueMessage.findMany({
    where: { issueId: id, ...olderThanWhere(before) },
    include: { author: { select: { name: true, role: true, ...(isAdmin ? { email: true } : {}) } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_THREAD_MESSAGES + 1,
  });
  const { rows, truncated } = splitAtCap(newest, MAX_THREAD_MESSAGES);

  return NextResponse.json(rows.reverse(), { headers: truncationHeaders(truncated, MAX_THREAD_MESSAGES) });
});

export const POST = withAuth(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`issue-msg:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.issues.messagesRateLimited") }, { status: 429 });
  }

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  const isIssueAdmin = hasPermission(session.user.permissions, Permission.MANAGE_ISSUES);
  // Matches the issues POST gate (see threadAccessRefusal).
  const refused = await threadAccessRefusal(issue, session, isIssueAdmin, t);
  if (refused) return refused;

  const parsed = await readJsonCapped<{ body?: unknown }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;

  // Check the type BEFORE calling a string method: parsed JSON is not type-checked
  // at runtime, so a number/object/null body would throw on .trim() and become a
  // 500 instead of this 400.
  if (typeof parsed.body !== "string") {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyRequired") }, { status: 400 });
  }
  const rawText = parsed.body.trim();
  if (!rawText) {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyRequired") }, { status: 400 });
  }
  if (rawText.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyTooLong") }, { status: 400 });
  }
  const text = sanitizeText(rawText);
  // Checked again AFTER sanitizing: "<>" or only zero-width characters passes
  // the check above and sanitizes to nothing — an empty bubble that still
  // reopened a resolved issue and notified the other side.
  if (!text) {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyRequired") }, { status: 400 });
  }

  const message = await prisma.issueMessage.create({
    data: {
      issueId: id,
      authorId: session.user.id,
      body: text,
      fromAdmin: isIssueAdmin,
    },
    // Mirror GET's author select (email for admins only) so a null-named author
    // renders identically whether the thread was fetched or just posted to.
    include: { author: { select: { name: true, role: true, ...(isIssueAdmin ? { email: true } : {}) } } },
  });

  // The message is stored: a failed status follow-up must not turn the answer
  // into a 500, or a retry would post the reply a second time.
  try {
    await applyReplyStatusChange(issue, isIssueAdmin, session, req);
  } catch (err) {
    console.error("[issues] Reply stored but its status change failed:", err instanceof Error ? err.message : err);
  }
  emitSSE({ type: "issuemessage:created", issueId: id, messageId: message.id, userId: issue.reportedBy });

  await announceIssueReply({
    issue,
    authorId: session.user.id,
    authorDisplayName: session.user.name ?? null,
    // Managers (the admin fan-out and the agents) see emails throughout the
    // issue surface, so the email fallback stays for them; the reporter never
    // gets it (issue-reply-notify.ts).
    authorName: session.user.name ?? session.user.email ?? "Someone",
    fromIssueAdmin: isIssueAdmin,
    text,
  });

  return NextResponse.json(message, { status: 201 });
});

// The status a reply moves, each a compare-and-swap so a concurrent transition
// wins, and the SSE and audit follow only an actual change:
//   - an issue admin's first reply on an OPEN issue → IN_PROGRESS (the reporter
//     sees it is being looked at);
//   - the reporter replying to a RESOLVED issue reopens it (OPEN, resolution and
//     resolvedAt cleared). An admin reply on a resolved issue adds a closing
//     note without changing status.
async function applyReplyStatusChange(
  issue: Issue,
  isIssueAdmin: boolean,
  session: SummonarrSession,
  req: NextRequest,
): Promise<void> {
  if (isIssueAdmin && issue.status === "OPEN") {
    await promoteIssueInProgress({ issue, from: "open", trigger: "admin-reply-auto-promote", session, req });
    return;
  }
  if (isIssueAdmin || issue.status !== "RESOLVED" || issue.reportedBy !== session.user.id) return;
  const reopened = await prisma.issue.updateMany({
    where: { id: issue.id, status: "RESOLVED" },
    data: { status: "OPEN", resolution: null, resolvedAt: null },
  });
  if (reopened.count === 0) return;
  emitSSE({ type: "issue:updated", issueId: issue.id, status: "OPEN", userId: issue.reportedBy });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ISSUE_STATUS_CHANGE",
    target: `issue:${issue.id}`,
    details: { trigger: "reporter-reply-reopen", before: { status: "RESOLVED" }, after: { status: "OPEN" } },
    ...auditContext(req, session),
  });
}
