import { NextResponse } from "next/server";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { notifyUserIssueMessage, notifyAdminsIssueMessage } from "@/lib/discord-notify";
import { createInAppNotification } from "@/lib/in-app-notify";
import { notifyUserIssueMessagePush, notifyAdminsIssueMessagePush } from "@/lib/push";
import { notifyUserIssueMessageEmail, notifyAdminsIssueMessageEmail } from "@/lib/email";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { emitSSE } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeText } from "@/lib/sanitize";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { hasPermission, Permission } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withAuth(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  if (!hasPermission(session.user.permissions, Permission.MANAGE_ISSUES) && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: t("apiUser.common.forbidden") }, { status: 403 });
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
  if (!isIssueAdmin && issue.reportedBy !== session.user.id) {
    return NextResponse.json({ error: t("apiUser.common.forbidden") }, { status: 403 });
  }

  // Match the issues POST gate: when issue reporting is disabled, ordinary users
  // can't add to a thread. Issue admins stay able to respond / wind threads down.
  if (!isIssueAdmin && !(await isFeatureEnabled("feature.page.issues"))) {
    return NextResponse.json({ error: t("apiUser.issues.disabled") }, { status: 403 });
  }

  const parsed = await readJsonCapped<{ body?: string }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // Check the type BEFORE calling a string method: parsed JSON is not type-checked
  // at runtime, so a number/object/null body would throw on .trim() and become a
  // 500 instead of this 400.
  if (typeof body.body !== "string") {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyRequired") }, { status: 400 });
  }
  const rawText = body.body.trim();
  if (!rawText) {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyRequired") }, { status: 400 });
  }
  if (rawText.length > 2000) {
    return NextResponse.json({ error: t("apiUser.issues.messageBodyTooLong") }, { status: 400 });
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
    // Mirror GET's author select (email for admins only) so a null-named author
    // renders identically whether the thread was fetched or just posted to.
    include: { author: { select: { name: true, role: true, ...(isAdmin ? { email: true } : {}) } } },
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

  emitNotificationEvent({
    event: "issue.reply",
    media: { type: issue.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: issue.tmdbId, title: issue.title, posterPath: issue.posterPath ?? null },
    issue: { id, type: issue.issueType },
    actor: { name: authorName },
    text: text.slice(0, 1_000),
  });

  // When the issue is claimed, narrow the admin audience to the claimer only —
  // other admins/issue-admins are intentionally kept out of the conversation.
  const adminOpts = {
    excludeUserId: session.user.id,
    fromAdmin: isAdmin,
    ...(issue.claimedBy ? { restrictToUserId: issue.claimedBy } : {}),
  };

  if (isAdmin) {
    // ONE lookup of the reporter decides whether any reporter-facing channel
    // runs (guardrail 33: gate in one place, not in each channel). A removed
    // account is only disabled, so it still has a live email, Discord link and
    // push subscriptions, and would otherwise keep getting notified.
    //
    // It also skips self-replies: an issue admin replying in an issue they
    // reported themselves should not be notified about their own message.
    const selfAction = issue.reportedBy === session.user.id;

    // The same read gives both the deactivatedAt check and the email preferences.
    const reporter = selfAction
      ? Promise.resolve(null)
      : prisma.user
          .findUnique({
            where: { id: issue.reportedBy },
            select: { deactivatedAt: true, email: true, notificationEmail: true, notifyOnIssue: true, locale: true },
          })
          .catch(() => null);
    // Fails CLOSED — a null row (missing, or a failed read) means no notification.
    const reporterActive = reporter.then((u) => !!u && u.deactivatedAt == null);

    void reporterActive.then((active) => {
      if (!active) return;
      void notifyUserIssueMessage(issue.reportedBy, issue.title, authorName, text, { tmdbId: issue.tmdbId, mediaType: issue.mediaType }).catch(() => {});
      void notifyUserIssueMessagePush({ userId: issue.reportedBy, title: issue.title, tmdbId: issue.tmdbId, mediaType: issue.mediaType, body: text, issueId: id }).catch(() => {});
    });
    if (!selfAction) {
      createInAppNotification(issue.reportedBy, {
        type: "ISSUE_REPLY",
        title: issue.title,
        body: `${authorName} replied: ${text.slice(0, 400)}`,
        tmdbId: issue.tmdbId,
        mediaType: issue.mediaType,
        posterPath: issue.posterPath,
        // Re-rendered in the reader's language at read time (notification-render.ts).
        data: { v: 1, author: authorName, text: text.slice(0, 400) },
      });
    }
    void reporter
      .then(async (reporter) => {
        if (!reporter?.notifyOnIssue) return;
        if (!(await reporterActive)) return; // same chokepoint as above
        const toEmail = resolveUserNotificationEmail(reporter);
        if (!toEmail) return;
        return notifyUserIssueMessageEmail({ toEmail, issueTitle: issue.title, tmdbId: issue.tmdbId, mediaType: issue.mediaType, authorName, body: text, locale: reporter.locale });
      })
      .catch(() => {});
    void notifyAdminsIssueMessage(issue.title, authorName, text, { ...adminOpts, tmdbId: issue.tmdbId, mediaType: issue.mediaType }).catch(() => {});
    void notifyAdminsIssueMessagePush({ title: issue.title, tmdbId: issue.tmdbId, mediaType: issue.mediaType, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
    void notifyAdminsIssueMessageEmail({ issueTitle: issue.title, tmdbId: issue.tmdbId, mediaType: issue.mediaType, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
  } else {
    void notifyAdminsIssueMessage(issue.title, authorName, text, { ...adminOpts, tmdbId: issue.tmdbId, mediaType: issue.mediaType }).catch(() => {});
    void notifyAdminsIssueMessagePush({ title: issue.title, tmdbId: issue.tmdbId, mediaType: issue.mediaType, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
    void notifyAdminsIssueMessageEmail({ issueTitle: issue.title, tmdbId: issue.tmdbId, mediaType: issue.mediaType, userName: authorName, body: text, issueId: id, ...adminOpts }).catch(() => {});
  }

  return NextResponse.json(message, { status: 201 });
});
