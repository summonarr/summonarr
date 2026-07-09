import "server-only";
import { prisma } from "./prisma";
import { buildNotificationData, type InAppNotificationInput } from "./notification-data";

export type { InAppNotificationInput } from "./notification-data";

// Shared best-effort writer for the in-app notification inbox (the header bell +
// /notifications page). Fire-and-forget: the delivered channels (email/push/
// Discord) are already swallowing-async, and a failed inbox write must never
// break the triggering action. Unconditional — the inbox is a passive record the
// user pulls, not a channel to opt out of.
//
// `type` is a free string (REQUEST_APPROVED | REQUEST_AVAILABLE | REQUEST_DECLINED
// | ISSUE_REPLY | ISSUE_RESOLVED | …); the client routes ISSUE_* to /issues and
// media-typed rows to the title page. Field shaping lives in buildNotificationData
// (notification-data.ts) so the batch path in request-notifications stays in sync.
export function createInAppNotification(userId: string, n: InAppNotificationInput): void {
  void prisma.notification
    .create({ data: buildNotificationData(userId, n) })
    .catch((err) => console.error("[notify] in-app write failed:", err instanceof Error ? err.message : err));
}
