import "server-only";
import { prisma } from "./prisma";
import { notifyUserRequestApproved, notifyUserRequestAvailable, notifyUserRequestDeclined, notifyUsersRequestsAvailable } from "./discord-notify";
import { notifyUserRequestApprovedPush, notifyUserRequestDeclinedPush, notifyUsersRequestsAvailablePush } from "./push";
import { notifyUserRequestApprovedEmail, notifyUserRequestDeclinedEmail, notifyUserRequestAvailableEmail } from "./email";
import { resolveUserNotificationEmail } from "./notification-email";

interface RequestInfo {
  requestedBy: string;
  title: string;
  mediaType: string;
  adminNote?: string | null;
}

export interface PendingAvailableRequest {
  id: string;
  requestedBy: string;
  title: string;
  mediaType: string;
  user: { mediaServer: string | null } | null;
}

export async function notifyAvailablePerServer(
  pending: PendingAvailableRequest[],
  inPlex: boolean,
  inJellyfin: boolean,
  plexConfigured: boolean,
  jellyfinConfigured: boolean,
  logScope: string,
): Promise<void> {
  const toNotify = pending.filter((req) => {
    const ms = req.user?.mediaServer ?? null;
    if (!ms) return inPlex || inJellyfin || (!plexConfigured && !jellyfinConfigured);
    if (ms === "plex") return inPlex || (!plexConfigured && (inJellyfin || !jellyfinConfigured));
    if (ms === "jellyfin") return inJellyfin || (!jellyfinConfigured && (inPlex || !plexConfigured));
    return false;
  });
  if (toNotify.length === 0) return;

  // CAS on notifiedAvailable prevents duplicate "now available" notifications when Plex and Jellyfin both match the item
  const cas = await prisma.mediaRequest.updateMany({
    where: { id: { in: toNotify.map((r) => r.id) }, notifiedAvailable: false },
    data: { notifiedAvailable: true },
  });
  if (cas.count > 0) {
    const payload = toNotify.map((r) => ({ requestedBy: r.requestedBy, title: r.title, mediaType: r.mediaType }));
    notifyUsersRequestsAvailable(payload).catch((err) => console.error(`[${logScope}] notification error:`, err instanceof Error ? err.message : err));
    notifyUsersRequestsAvailablePush(payload).catch((err) => console.error(`[${logScope}] push error:`, err instanceof Error ? err.message : err));
  }
}

// Poll for up to 12 minutes (24 × 30 s) before giving up — covers slow Plex/Jellyfin scan propagation after a webhook
const ITEM_POLL_INTERVAL_MS = 30_000;
const ITEM_POLL_MAX = 24;

export async function pollAndNotifyAvailable(
  pending: PendingAvailableRequest[],
  checkPlex: (() => Promise<boolean>) | null,
  checkJellyfin: (() => Promise<boolean>) | null,
  logScope: string,
): Promise<void> {
  const plexConfigured = !!checkPlex;
  const jellyfinConfigured = !!checkJellyfin;

  if (!plexConfigured && !jellyfinConfigured) {
    await notifyAvailablePerServer(pending, false, false, false, false, logScope);
    return;
  }

  let inPlex = false;
  let inJellyfin = false;

  for (let attempt = 1; attempt <= ITEM_POLL_MAX; attempt++) {
    await new Promise((r) => setTimeout(r, ITEM_POLL_INTERVAL_MS));

    [inPlex, inJellyfin] = await Promise.all([
      checkPlex && !inPlex ? checkPlex() : Promise.resolve(inPlex),
      checkJellyfin && !inJellyfin ? checkJellyfin() : Promise.resolve(inJellyfin),
    ]);

    const allSatisfied = pending.every((req) => {
      const ms = req.user?.mediaServer ?? null;
      if (!ms) return inPlex || inJellyfin;
      if (ms === "plex") return inPlex || (!plexConfigured && (inJellyfin || !jellyfinConfigured));
      if (ms === "jellyfin") return inJellyfin || (!jellyfinConfigured && (inPlex || !plexConfigured));
      return false;
    });
    if (allSatisfied) break;
  }

  await notifyAvailablePerServer(pending, inPlex, inJellyfin, plexConfigured, jellyfinConfigured, logScope);
}

export function notifyRequestStatusChange(
  status: "APPROVED" | "AVAILABLE" | "DECLINED",
  request: RequestInfo,
): void {
  const { requestedBy, title, mediaType } = request;

  if (status === "APPROVED") {
    notifyUserRequestApproved(requestedBy, title, mediaType).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUserRequestApprovedPush({ userId: requestedBy, title, mediaType }).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnApproved: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnApproved) notifyUserRequestApprovedEmail({ toEmail: to, title, mediaType });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }

  if (status === "AVAILABLE") {
    notifyUserRequestAvailable(requestedBy, title, mediaType).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUsersRequestsAvailablePush([{ requestedBy, title, mediaType }]).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnAvailable: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnAvailable) notifyUserRequestAvailableEmail({ toEmail: to, title, mediaType });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }

  if (status === "DECLINED") {
    notifyUserRequestDeclined(requestedBy, title, mediaType, request.adminNote).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUserRequestDeclinedPush({ userId: requestedBy, title, mediaType }).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnDeclined: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnDeclined) notifyUserRequestDeclinedEmail({ toEmail: to, title, mediaType, adminNote: request.adminNote });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }
}
