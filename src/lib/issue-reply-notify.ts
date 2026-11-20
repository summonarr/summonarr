import "server-only";
import { prisma } from "./prisma";
import { emitNotificationEvent } from "./notify-agents";
import { notifyUserIssueMessage, notifyAdminsIssueMessage } from "./discord-notify";
import { createInAppNotification } from "./in-app-notify";
import { notifyUserIssueMessagePush, notifyAdminsIssueMessagePush } from "./push";
import { notifyUserIssueMessageEmail, notifyAdminsIssueMessageEmail } from "./email";
import { resolveUserNotificationEmail } from "./notification-email";
import { translatorForUser } from "./i18n/server-locale";
import { OUTBOX_ALL_CHANNELS, OUTBOX_ISSUE_REPLY_KIND, settleOutbox } from "./outbox";

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
  /** Name shown to managers one by one (push, email) and to the outbound agents; falls back to the email, so never post it to a shared channel. */
  authorName: string;
  /** The author holds MANAGE_ISSUES (an issue admin replying). */
  fromIssueAdmin: boolean;
  /** The message as stored (trimmed and sanitized). */
  text: string;
  /**
   * The message's id, when its announcement was queued with the write
   * (outbox.ts queueAnnouncement): the row is settled once every channel has
   * returned. Absent ⇒ nothing was queued and nothing is settled.
   */
  messageId?: string;
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
  // The announcement was queued in the message's own transaction (guardrail
  // 14f). The channels go out without being waited on; once all have returned
  // the outbox row is deleted. A failed reporter read settles nothing, so the
  // drain announces it again.
  const sends: Array<Promise<unknown>> = [];
  let owed = false;
  try {
    owed = await announceReply(a, sends);
  } catch (err) {
    owed = true;
    console.error("[issue-messages] announce failed:", err instanceof Error ? err.message : err);
  }
  if (a.messageId && !owed) {
    const id = a.messageId;
    void Promise.allSettled(sends).then(() => settleOutbox(OUTBOX_ISSUE_REPLY_KIND, OUTBOX_ALL_CHANNELS, [id]));
  }
}

// Starts every channel (pushed onto `sends`). True ⇒ still owed: the reporter
// could not be read.
async function announceReply(a: IssueReplyAnnouncement, sends: Array<Promise<unknown>>): Promise<boolean> {
  {
    const { issue, text } = a;
    const media = { tmdbId: issue.tmdbId, mediaType: issue.mediaType };

    emitNotificationEvent({
      event: "issue.reply",
      media: { type: issue.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: issue.tmdbId, title: issue.title, posterPath: issue.posterPath ?? null },
      issue: { id: issue.id, type: issue.issueType },
      actor: { name: a.authorName },
      text: text.slice(0, 1_000),
    });

    let owed = false;
    if (a.fromIssueAdmin && issue.reportedBy !== a.authorId) {
      owed = !(await notifyReporter(a, sends));
    }

    // The admin side, whoever wrote: every issue admin but the author — or only
    // the claimer, whom the other admins are deliberately kept out of the
    // conversation for.
    const adminOpts = {
      excludeUserId: a.authorId,
      fromAdmin: a.fromIssueAdmin,
      ...(issue.claimedBy ? { restrictToUserId: issue.claimedBy } : {}),
    };
    // Discord posts this one to the SHARED channel, so it gets the display name
    // only; the push and email below go to each admin and keep the email fallback.
    sends.push(notifyAdminsIssueMessage(issue.title, a.authorDisplayName, text, { ...adminOpts, ...media }).catch(warnChannel("admin discord")));
    sends.push(notifyAdminsIssueMessagePush({ title: issue.title, ...media, userName: a.authorName, body: text, issueId: issue.id, ...adminOpts }).catch(warnChannel("admin push")));
    sends.push(notifyAdminsIssueMessageEmail({ issueTitle: issue.title, ...media, userName: a.authorName, body: text, issueId: issue.id, ...adminOpts }).catch(warnChannel("admin email")));
    return owed;
  }
}

// False ⇒ the reporter could not be READ (the announcement stays owed). A
// missing or deactivated reporter is a decision — nobody is told — and is true.
async function notifyReporter(a: IssueReplyAnnouncement, sends: Array<Promise<unknown>>): Promise<boolean> {
  const { issue, text } = a;
  // The same read gives the deactivatedAt check, the email preferences and the
  // language the reply is labelled in.
  const read = await prisma.user
    .findUnique({
      where: { id: issue.reportedBy },
      select: { deactivatedAt: true, email: true, notificationEmail: true, notifyOnIssue: true, locale: true },
    })
    .then((row) => ({ row }))
    .catch(() => null);
  if (!read) return false;
  const reporter = read.row;
  if (!reporter || reporter.deactivatedAt != null) return true;

  const author = reporterFacingAuthor(a.authorDisplayName, reporter);
  const media = { tmdbId: issue.tmdbId, mediaType: issue.mediaType };
  sends.push(notifyUserIssueMessage(issue.reportedBy, issue.title, author, text, media).catch(warnChannel("reporter discord")));
  sends.push(notifyUserIssueMessagePush({ userId: issue.reportedBy, title: issue.title, ...media, body: text, issueId: issue.id }).catch(warnChannel("reporter push")));
  sends.push(createInAppNotification(issue.reportedBy, {
    type: "ISSUE_REPLY",
    title: issue.title,
    body: `${author} replied: ${text.slice(0, 400)}`,
    tmdbId: issue.tmdbId,
    mediaType: issue.mediaType,
    posterPath: issue.posterPath,
    // Re-rendered in the reader's language at read time (notification-render.ts).
    data: { v: 1, author, text: text.slice(0, 400) },
  }));
  if (reporter.notifyOnIssue) {
    const toEmail = resolveUserNotificationEmail(reporter);
    if (toEmail) {
      sends.push(notifyUserIssueMessageEmail({ toEmail, issueTitle: issue.title, ...media, authorName: author, body: text, locale: reporter.locale }).catch(warnChannel("reporter email")));
    }
  }
  return true;
}
