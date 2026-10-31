import "server-only";
import { prisma } from "./prisma";
import { commentAudience } from "./request-comments";
import { emitNotificationEvent } from "./notify-agents";
import { createInAppNotification } from "./in-app-notify";
import { resolveUserNotificationEmail } from "./notification-email";
import { notifyUserRequestComment, notifyAdminsRequestComment } from "./discord-notify";
import { notifyUserRequestCommentPush, notifyAdminsRequestCommentPush } from "./push";
import { notifyUserRequestCommentEmail, notifyAdminsRequestCommentEmail } from "./email";

export interface RequestCommentAnnouncement {
  request: {
    id: string;
    title: string;
    mediaType: "MOVIE" | "TV";
    tmdbId: number;
    posterPath: string | null;
    requestedBy: string;
    arrInstance: string;
  };
  authorId: string;
  /** Name shown to managers (they see emails across the request surface). */
  authorName: string;
  /** Name shown to the requester: never the author's email (a manager without a display name reads "Admin"). */
  requesterFacingAuthor: string;
  text: string;
  authorIsManager: boolean;
}

// Fans a new request comment out to its audience (request-comments.ts
// commentAudience): the requester when a manager wrote it, every other manager
// when the requester did. Best-effort and never throws — the comment is already
// committed (guardrail 26), and each channel swallows its own failure.
//
// Gating is read ONCE per recipient (guardrail 33: not per channel). A removed
// account keeps its email, Discord link and push subscriptions, and the senders
// below re-check deactivatedAt on their own queries too. The per-channel
// preferences (notifyOnComment / emailOnComment / pushOnComment) live in the
// senders so the manager fan-out, which selects its audience in SQL, uses the
// same columns.
export async function announceRequestComment(a: RequestCommentAnnouncement): Promise<void> {
  try {
    const { request } = a;
    const text = a.text.slice(0, 1_000);
    const media = { tmdbId: request.tmdbId, mediaType: request.mediaType };

    // Outbound channels (webhook / ntfy / Gotify) hear about every comment.
    emitNotificationEvent({
      event: "request.comment",
      media: { type: request.mediaType, tmdbId: request.tmdbId, title: request.title, posterPath: request.posterPath },
      request: { id: request.id, instance: request.arrInstance },
      actor: { name: a.authorName },
      text,
    });

    const audience = commentAudience({
      authorIsManager: a.authorIsManager,
      authorIsRequester: a.authorId === request.requestedBy,
    });

    if (audience.to === "requester") {
      // Fails CLOSED — a missing row (or a failed read) notifies nobody, the
      // inbox included, so a disabled account has nothing waiting on re-enable.
      const requester = await prisma.user
        .findUnique({
          where: { id: request.requestedBy },
          select: { deactivatedAt: true, email: true, notificationEmail: true, emailOnComment: true, locale: true },
        })
        .catch(() => null);
      if (!requester || requester.deactivatedAt != null) return;

      void notifyUserRequestComment(request.requestedBy, request.title, a.requesterFacingAuthor, text, media).catch(() => {});
      void notifyUserRequestCommentPush({
        userId: request.requestedBy, title: request.title, tmdbId: request.tmdbId, mediaType: request.mediaType, body: text, requestId: request.id,
      }).catch(() => {});
      createInAppNotification(request.requestedBy, {
        type: "REQUEST_COMMENT",
        title: request.title,
        body: `${a.requesterFacingAuthor} commented: ${text.slice(0, 400)}`,
        tmdbId: request.tmdbId,
        mediaType: request.mediaType,
        posterPath: request.posterPath,
        // Re-rendered in the reader's language at read time (notification-render.ts).
        data: { v: 1, author: a.requesterFacingAuthor, text: text.slice(0, 400) },
      });
      if (requester.emailOnComment) {
        const toEmail = resolveUserNotificationEmail(requester);
        if (toEmail) {
          void notifyUserRequestCommentEmail({
            toEmail, title: request.title, tmdbId: request.tmdbId, mediaType: request.mediaType,
            authorName: a.requesterFacingAuthor, body: text, requestId: request.id, locale: requester.locale,
          }).catch(() => {});
        }
      }
      return;
    }

    if (audience.to === "managers") {
      void notifyAdminsRequestComment(request.title, a.authorName, text, { excludeUserId: a.authorId, ...media }).catch(() => {});
      void notifyAdminsRequestCommentPush({
        title: request.title, tmdbId: request.tmdbId, mediaType: request.mediaType, userName: a.authorName, body: text, requestId: request.id, excludeUserId: a.authorId,
      }).catch(() => {});
      void notifyAdminsRequestCommentEmail({
        title: request.title, tmdbId: request.tmdbId, mediaType: request.mediaType, userName: a.authorName, body: text, requestId: request.id, excludeUserId: a.authorId,
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[request-comments] announce failed:", err instanceof Error ? err.message : err);
  }
}
