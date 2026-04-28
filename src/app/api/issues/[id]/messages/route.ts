import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { notifyUserIssueMessage, notifyAdminsIssueMessage } from "@/lib/discord-notify";
import { notifyUserIssueMessagePush, notifyAdminsIssueMessagePush } from "@/lib/push";
import { notifyUserIssueMessageEmail, notifyAdminsIssueMessageEmail } from "@/lib/email";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeText } from "@/lib/sanitize";
import { checkRateLimit } from "@/lib/rate-limit";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN" && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const isAdmin = session.user.role === "ADMIN" || session.user.role === "ISSUE_ADMIN";

  const messages = await prisma.issueMessage.findMany({
    where: { issueId: id },
    include: { author: { select: { name: true, role: true, ...(isAdmin ? { email: true } : {}) } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(messages);
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const maint = await maintenanceGuard(session.user.role);
  if (maint) return maint;

  if (!checkRateLimit(`issue-msg:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many messages — try again in a minute" }, { status: 429 });
  }

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: "Cannot add messages to a resolved issue" }, { status: 422 });
  }

  if (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN" && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawText = body.body?.trim();
  if (!rawText || typeof rawText !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  if (rawText.length > 2000) {
    return NextResponse.json({ error: "body must be under 2000 characters" }, { status: 400 });
  }
  const text = sanitizeText(rawText);

  const isAdmin = session.user.role === "ADMIN" || session.user.role === "ISSUE_ADMIN";

  const message = await prisma.issueMessage.create({
    data: {
      issueId: id,
      authorId: session.user.id,
      body: text,
      fromAdmin: isAdmin,
    },
    include: { author: { select: { name: true, role: true } } },
  });

  // Auto-transition to IN_PROGRESS when an admin first replies — signals the reporter their issue is seen
  if (isAdmin && issue.status === "OPEN") {
    await prisma.issue.update({ where: { id }, data: { status: "IN_PROGRESS" } });
    emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
  }

  emitSSE({ type: "issuemessage:created", issueId: id, userId: issue.reportedBy });

  const authorName = session.user.name ?? session.user.email ?? "Someone";

  if (isAdmin) {
    void notifyUserIssueMessage(issue.reportedBy, issue.title, authorName, text).catch(() => {});
    void notifyUserIssueMessagePush({ userId: issue.reportedBy, title: issue.title, body: text }).catch(() => {});
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
  } else {
    void notifyAdminsIssueMessage(issue.title, authorName, text).catch(() => {});
    void notifyAdminsIssueMessagePush({ title: issue.title, userName: authorName, body: text }).catch(() => {});
    void notifyAdminsIssueMessageEmail({ issueTitle: issue.title, userName: authorName, body: text, issueId: id }).catch(() => {});
  }

  return NextResponse.json(message, { status: 201 });
}
