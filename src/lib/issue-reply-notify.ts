import "server-only";
import { prisma } from "./prisma";
import { emitNotificationEvent } from "./notify-agents";
import { notifyUserIssueMessage, notifyAdminsIssueMessage } from "./discord-notify";
import { createInAppNotification } from "./in-app-notify";
import { notifyUserIssueMessagePush, notifyAdminsIssueMessagePush } from "./push";
import { notifyUserIssueMessageEmail, notifyAdminsIssueMessageEmail } from "./email";
import { resolveUserNotificationEmail } from "./notification-email";
import { translatorForUser } from "./i18n/server-locale";

// A channel that fails must not stop the others, but it should leave a line.
const warnChannel = (channel: string) => (err: unknown) =>
  console.warn(`[issue-messages] ${channel} notification failed:`, err instanceof Error ? err.message : String(err));

export interface IssueReplyAnnouncement {
  issue: {
    id: string;
    title: string;
    mediaType: string;
    tmdbId: number;
    posterPath: string | null;
    issueType: string;
    reportedBy: string;
    claimedBy: string | null;
  };
  authorId: string;
  /** The author's display name; null when they have none. */
  authorDisplayName: string | null;
  /** Name shown to managers and the outbound agents (they see emails across the issue surface). */
  authorName: string;
  /** The author holds MANAGE_ISSUES (an issue admin replying). */
  fromIssueAdmin: boolean;
  /** The message as stored (trimmed and sanitized). */
  text: string;
}

/**
 * The name the REPORTER sees for an issue admin's reply: the display name, or
 * "Admin" in the REPORTER's language — never the admin's email (this route's
 * GET strips `author.email` for a non-manager, and the notifications must not
 * undo that), and never the replying admin's language.
 */
export function reporterFacingAuthor(authorDisplayName: string | null, reporter: { locale?: string | null }): string {
  return authorDisplayName ?? translatorForUser(reporter)("shared.thread.admin");
}

/**
 * Fans a new issue message out after it was written: the outbound agents hear
 * every reply; an issue admin's reply reaches the reporter (Discord, push,
 * inbox, email); and every issue admin but the author hears it — only the
 * claimer while the issue is claimed. Best-effort and never throws: the message
 * is already committed, and each channel swallows its own failure.
 *
 * The reporter is read ONCE (guardrail 33: gate in one place, not per channel),
 * and the read fails CLOSED: a missing row, a failed read or a deactivated
 * reporter notifies nobody, the inbox included — a disabled account keeps its
 * email, Discord link and push subscriptions, and the bell row would otherwise
 * be waiting when it is turned back on. A self-reply (an issue admin writing in
 * a thread they reported) reads nothing and notifies no reporter.
 */
export async function announceIssueReply(a: IssueReplyAnnouncement): Promise<void> {
  try {
    const { issue, text } = a;
    const media = { tmdbId: issue.tmdbId, mediaType: issue.mediaType };

    emitNotificationEvent({
      event: "issue.reply",
      media: { type: issue.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: issue.tmdbId, title: issue.title, posterPath: issue.posterPath ?? null },
      issue: { id: issue.id, type: issue.issueType },
      actor: { name: a.authorName },
      text: text.slice(0, 1_000),
    });

    if (a.fromIssueAdmin && issue.reportedBy !== a.authorId) {
      await notifyReporter(a);
    }

    // The admin side, whoever wrote: every issue admin but the author — or only
    // the claimer, whom the other admins are deliberately kept out of the
    // conversation for.
    const adminOpts = {
      excludeUserId: a.authorId,
      fromAdmin: a.fromIssueAdmin,
      ...(issue.claimedBy ? { restrictToUserId: issue.claimedBy } : {}),
    };
    void notifyAdminsIssueMessage(issue.title, a.authorName, text, { ...adminOpts, ...media }).catch(warnChannel("admin discord"));
    void notifyAdminsIssueMessagePush({ title: issue.title, ...media, userName: a.authorName, body: text, issueId: issue.id, ...adminOpts }).catch(warnChannel("admin push"));
    void notifyAdminsIssueMessageEmail({ issueTitle: issue.title, ...media, userName: a.authorName, body: text, issueId: issue.id, ...adminOpts }).catch(warnChannel("admin email"));
  } catch (err) {
    console.error("[issue-messages] announce failed:", err instanceof Error ? err.message : err);
  }
}

async function notifyReporter(a: IssueReplyAnnouncement): Promise<void> {
  const { issue, text } = a;
  // The same read gives the deactivatedAt check, the email preferences and the
  // language the reply is labelled in.
  const reporter = await prisma.user
    .findUnique({
      where: { id: issue.reportedBy },
      select: { deactivatedAt: true, email: true, notificationEmail: true, notifyOnIssue: true, locale: true },
    })
    .catch(() => null);
  if (!reporter || reporter.deactivatedAt != null) return;

  const author = reporterFacingAuthor(a.authorDisplayName, reporter);
  const media = { tmdbId: issue.tmdbId, mediaType: issue.mediaType };
  void notifyUserIssueMessage(issue.reportedBy, issue.title, author, text, media).catch(warnChannel("reporter discord"));
  void notifyUserIssueMessagePush({ userId: issue.reportedBy, title: issue.title, ...media, body: text, issueId: issue.id }).catch(warnChannel("reporter push"));
  createInAppNotification(issue.reportedBy, {
    type: "ISSUE_REPLY",
    title: issue.title,
    body: `${author} replied: ${text.slice(0, 400)}`,
    tmdbId: issue.tmdbId,
    mediaType: issue.mediaType,
    posterPath: issue.posterPath,
    // Re-rendered in the reader's language at read time (notification-render.ts).
    data: { v: 1, author, text: text.slice(0, 400) },
  });
  if (reporter.notifyOnIssue) {
    const toEmail = resolveUserNotificationEmail(reporter);
    if (toEmail) {
      void notifyUserIssueMessageEmail({ toEmail, issueTitle: issue.title, ...media, authorName: author, body: text, locale: reporter.locale }).catch(warnChannel("reporter email"));
    }
  }
}
