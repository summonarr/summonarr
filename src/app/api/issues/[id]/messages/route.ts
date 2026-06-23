import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { notifyUserIssueMessage, notifyAdminsIssueMessage } from "@/lib/discord-notify";
import { notifyUserIssueMessagePush, notifyAdminsIssueMessagePush } from "@/lib/push";
import { notifyUserIssueMessageEmail, notifyAdminsIssueMessageEmail } from "@/lib/email";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeText } from "@/lib/sanitize";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { hasPermission, Permission } from "@/lib/permissions";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withAuth(async (_req, { params }: RouteContext, session) => {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!hasPermission(session.user.permissions, Permission.MANAGE_ISSUES) && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const isAdmin = hasPermission(session.user.permissions, Permission.MANAGE_ISSUES);

  const messages = await prisma.issueMessage.findMany({
    where: { issueId: id },
    include: { author: { select: { name: true, role: true, ...(isAdmin ? { email: true } : {}) } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(messages);
});

export const POST = withAuth(async (req, { params }: RouteContext, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  if (!checkRateLimit(`issue-msg:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many messages — try again in a minute" }, { status: 429 });
  }

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!hasPermission(session.user.permissions, Permission.MANAGE_ISSUES) && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = await readJsonCapped<{ body?: string }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // Validate the type BEFORE calling a string method: req.json() is untyped at
  // runtime, so a non-string body (number/object/null) would throw on .trim() and
  // surface as a 500 instead of this 400. Mirrors the guard in releases/route.ts.
  if (typeof body.body !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  const rawText = body.body.trim();
  if (!rawText) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  if (rawText.length > 2000) {
    return NextResponse.json({ error: "body must be under 2000 characters" }, { status: 400 });
  }
  const text = sanitizeText(rawText);

  const isAdmin = hasPermission(session.user.permissions, Permission.MANAGE_ISSUES);

  const message = await prisma.issueMessage.create({
    data: {
      issueId: id,
      authorId: session.user.id,
      body: text,
      fromAdmin: isAdmin,
    },
    include: { author: { select: { name: true, role: true } } },
  });

  // Auto-transition to IN_PROGRESS when an admin first replies — signals the reporter
  // their issue is seen. CAS on OPEN so a concurrent RESOLVED transition isn't
  // clobbered, and only emit the SSE / log when we actually changed status.
  if (isAdmin && issue.status === "OPEN") {
    const claimed = await prisma.issue.updateMany({
      where: { id, status: "OPEN" },
      data: { status: "IN_PROGRESS" },
    });
    if (claimed.count > 0) {
      emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
      void logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email ?? null,
        action: "ISSUE_STATUS_CHANGE",
        target: `issue:${id}`,
        details: { trigger: "admin-reply-auto-promote", before: { status: "OPEN" }, after: { status: "IN_PROGRESS" } },
        ...auditContext(req, session),
      });
    }
  }

  // A reporter replying to a RESOLVED issue reopens it (mirror of the admin
  // OPEN→IN_PROGRESS auto-promote above). An admin reply on a resolved issue adds a
  // closing note without changing status. CAS on RESOLVED so a concurrent change wins.
  if (!isAdmin && issue.status === "RESOLVED" && issue.reportedBy === session.user.id) {
    const reopened = await prisma.issue.updateMany({
      where: { id, status: "RESOLVED" },
      data: { status: "OPEN", resolution: null },
    });
    if (reopened.count > 0) {
      emitSSE({ type: "issue:updated", issueId: id, status: "OPEN", userId: issue.reportedBy });
      void logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email ?? null,
        action: "ISSUE_STATUS_CHANGE",
        target: `issue:${id}`,
        details: { trigger: "reporter-reply-reopen", before: { status: "RESOLVED" }, after: { status: "OPEN" } },
        ...auditContext(req, session),
      });
    }
  }

  emitSSE({ type: "issuemessage:created", issueId: id, userId: issue.reportedBy });

  const authorName = session.user.name ?? session.user.email ?? "Someone";

  // When the issue is claimed, narrow the admin audience to the claimer only —
  // other admins/issue-admins are intentionally kept out of the conversation.
  const adminOpts = {
    excludeUserId: session.user.id,
    fromAdmin: isAdmin,
    ...(issue.claimedBy ? { restrictToUserId: issue.claimedBy } : {}),
  };

  if (isAdmin) {
    void notifyUserIssueMessage(issue.reportedBy, issue.title, authorName, text).catch(() => {});
    void notifyUserIssueMessagePush({ userId: issue.reportedBy, title: issue.title, body: text, issueId: id }).catch(() => {});
    void prisma.user
      .findUnique({
        where: { id: issue.reportedBy },
        select: { email: true, notificationEmail: true, notifyOnIssue: true },
      })
      .then((reporter) => {
        if (!reporter?.notifyOnIssue) return;
        const toEmail = resolveUserNotificationEmail(reporter);
        if (!toEmail) return;
        return notifyUserIssueMessageEmail({ toEmail, issueTitle: issue.title, authorName, body: text });
      })
      .catch(() => {});
    void notifyAdminsIssueMessage(issue.title, authorName, text, adminOpts).catch(() => {});
    void notifyAdminsIssueMessagePush({ title: issue.title, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
    void notifyAdminsIssueMessageEmail({ issueTitle: issue.title, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
  } else {
    void notifyAdminsIssueMessage(issue.title, authorName, text, adminOpts).catch(() => {});
    void notifyAdminsIssueMessagePush({ title: issue.title, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
    void notifyAdminsIssueMessageEmail({ issueTitle: issue.title, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
  }

  return NextResponse.json(message, { status: 201 });
});
