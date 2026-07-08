import "server-only";
import { prisma } from "./prisma";
import { notifyUserRequestApproved, notifyUserRequestAvailable, notifyUserRequestDeclined, notifyUsersRequestsAvailable } from "./discord-notify";
import { notifyUserRequestApprovedPush, notifyUserRequestDeclinedPush, notifyUsersRequestsAvailablePush } from "./push";
import { notifyUserRequestApprovedEmail, notifyUserRequestDeclinedEmail, notifyUserRequestAvailableEmail } from "./email";
import { resolveUserNotificationEmail } from "./notification-email";
import { claimAvailableNotificationWinners } from "./notify-available";
import { createInAppNotification } from "./in-app-notify";
import { buildNotificationData } from "./notification-data";

interface RequestInfo {
  requestedBy: string;
  title: string;
  mediaType: string;
  adminNote?: string | null;
  posterPath?: string | null;
  tmdbId?: number;
}

export interface PendingAvailableRequest {
  id: string;
  requestedBy: string;
  title: string;
  mediaType: string;
  // posterPath + tmdbId are optional to keep this interface compatible with
  // older webhook-handler selects, but supplying them enables the email-channel
  // branch in notifyAvailablePerServer.
  posterPath?: string | null;
  tmdbId?: number | null;
  user: { mediaServer: string | null } | null;
}

type InAppNotificationType = "REQUEST_APPROVED" | "REQUEST_AVAILABLE" | "REQUEST_DECLINED";

function inAppBodyFor(type: InAppNotificationType, mediaType: string): string {
  const label = mediaType === "MOVIE" ? "movie" : "TV show";
  if (type === "REQUEST_APPROVED") return `Your ${label} request was approved and is downloading.`;
  if (type === "REQUEST_AVAILABLE") return `Your ${label} is now available to watch.`;
  return `Your ${label} request was declined.`;
}

// Best-effort in-app inbox write (the header bell). Wraps the shared writer with
// this module's request-specific body copy. Fire-and-forget alongside the
// email/push/Discord fan-out; UNCONDITIONAL — the inbox is a passive record the
// user pulls, not a delivered channel to opt out of.
function writeInAppNotification(
  userId: string,
  type: InAppNotificationType,
  info: { title: string; mediaType: string; tmdbId?: number | null; posterPath?: string | null },
): void {
  createInAppNotification(userId, {
    type,
    title: info.title,
    body: inAppBodyFor(type, info.mediaType),
    tmdbId: info.tmdbId ?? null,
    mediaType: info.mediaType,
    posterPath: info.posterPath ?? null,
  });
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

  // CAS on notifiedAvailable prevents duplicate "now available" notifications when Plex
  // and Jellyfin both match the item; winner filter ensures we only notify on rows we
  // actually flipped, not the full pre-CAS overlap set.
  const winners = await claimAvailableNotificationWinners(toNotify);
  if (winners.length > 0) {
    const payload = winners.map((r) => ({ requestedBy: r.requestedBy, title: r.title, mediaType: r.mediaType, tmdbId: r.tmdbId ?? undefined }));
    notifyUsersRequestsAvailable(payload).catch((err) => console.error(`[${logScope}] notification error:`, err instanceof Error ? err.message : err));
    notifyUsersRequestsAvailablePush(payload).catch((err) => console.error(`[${logScope}] push error:`, err instanceof Error ? err.message : err));

    // In-app inbox for the batch winners (one createMany, same CAS-once guarantee).
    // Uses buildNotificationData directly — not createInAppNotification per-row —
    // to keep this a single DB round-trip while sharing the field-shaping rules.
    void prisma.notification
      .createMany({
        data: winners.map((r) =>
          buildNotificationData(r.requestedBy, {
            type: "REQUEST_AVAILABLE",
            title: r.title,
            body: inAppBodyFor("REQUEST_AVAILABLE", r.mediaType),
            tmdbId: r.tmdbId ?? null,
            mediaType: r.mediaType,
            posterPath: r.posterPath ?? null,
          }),
        ),
      })
      .catch((err) => console.error(`[${logScope}] in-app write failed:`, err instanceof Error ? err.message : err));

    // Email channel — webhook/sync AVAILABLE paths previously fanned out only
    // Discord + push, leaving `emailOnAvailable` a dead preference there.
    await notifyUsersRequestsAvailableEmail(winners, logScope);
  }
}

// Email-on-available fan-out for the sync/webhook AVAILABLE paths. Batch-fetch
// user prefs in a single query, send per-winner where `emailOnAvailable` is true
// and a deliverable address resolves (synthetic *.local emails return null and
// skip cleanly). The `enableUserEmails` global gate + per-event throttle live
// inside notifyUserRequestAvailableEmail. Exported so the sync routes can fan out
// the email channel for their winner rows.
export async function notifyUsersRequestsAvailableEmail(
  winners: Array<{
    requestedBy: string;
    title: string;
    mediaType: string;
    tmdbId?: number | null;
    posterPath?: string | null;
  }>,
  logScope = "notify",
): Promise<void> {
  if (winners.length === 0) return;
  const userPrefs = await prisma.user.findMany({
    where: { id: { in: [...new Set(winners.map((w) => w.requestedBy))] } },
    select: { id: true, email: true, notificationEmail: true, emailOnAvailable: true },
  }).catch((err) => {
    console.error(`[${logScope}] email-pref fetch failed:`, err instanceof Error ? err.message : err);
    return [];
  });
  const prefByUserId = new Map(userPrefs.map((u) => [u.id, u]));
  for (const w of winners) {
    const u = prefByUserId.get(w.requestedBy);
    if (!u || !u.emailOnAvailable) continue;
    const to = resolveUserNotificationEmail(u);
    if (!to) continue;
    notifyUserRequestAvailableEmail({
      toEmail: to,
      title: w.title,
      mediaType: w.mediaType,
      posterPath: w.posterPath ?? null,
      tmdbId: w.tmdbId ?? undefined,
    }).catch((err) => console.error(`[${logScope}] email error:`, err instanceof Error ? err.message : err));
  }
}

// Poll for up to 12 minutes (24 × 30 s) before giving up — covers slow Plex/Jellyfin scan propagation after a webhook
const ITEM_POLL_INTERVAL_MS = 30_000;
const ITEM_POLL_MAX = 24;

// One in-flight poll per identical pending set: a season import fires one Download
// webhook per episode, and each used to spawn its own 12-minute 24×30s poll loop
// against Plex + Jellyfin — hundreds of concurrent pollers hammering the media
// servers during a mass import when the library scan lags. The pending rows stay
// unnotified until a poll completes, so repeat webhooks fetch the same id set and
// join the running poll (HD and 4K sets differ by is4k scoping, so they key apart).
// A request row created AFTER a running poll snapshotted its set misses that
// poll's notify — the sync orchestrator's AVAILABLE+unnotified fallback picks it
// up on the next tick.
const inFlightPolls = new Map<string, Promise<void>>();

export async function pollAndNotifyAvailable(
  pending: PendingAvailableRequest[],
  checkPlex: (() => Promise<boolean>) | null,
  checkJellyfin: (() => Promise<boolean>) | null,
  logScope: string,
): Promise<void> {
  const plexConfigured = !!checkPlex;
  const jellyfinConfigured = !!checkJellyfin;

  if (!plexConfigured && !jellyfinConfigured) {
    // No polling happens on this branch — nothing to coalesce.
    await notifyAvailablePerServer(pending, false, false, false, false, logScope);
    return;
  }

  const key = pending.map((r) => r.id).sort().join(",");
  const running = inFlightPolls.get(key);
  if (running) return running;

  const poll = (async () => {
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
  })().finally(() => {
    inFlightPolls.delete(key);
  });
  inFlightPolls.set(key, poll);
  return poll;
}

export function notifyRequestStatusChange(
  status: "APPROVED" | "AVAILABLE" | "DECLINED",
  request: RequestInfo,
): void {
  const { requestedBy, title, mediaType, posterPath, tmdbId } = request;

  if (status === "APPROVED") {
    writeInAppNotification(requestedBy, "REQUEST_APPROVED", { title, mediaType, tmdbId, posterPath });
    notifyUserRequestApproved(requestedBy, title, mediaType).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUserRequestApprovedPush({ userId: requestedBy, title, mediaType, tmdbId }).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnApproved: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnApproved) notifyUserRequestApprovedEmail({ toEmail: to, title, mediaType, posterPath, tmdbId });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }

  if (status === "AVAILABLE") {
    writeInAppNotification(requestedBy, "REQUEST_AVAILABLE", { title, mediaType, tmdbId, posterPath });
    notifyUserRequestAvailable(requestedBy, title, mediaType).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUsersRequestsAvailablePush([{ requestedBy, title, mediaType, tmdbId }]).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnAvailable: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnAvailable) notifyUserRequestAvailableEmail({ toEmail: to, title, mediaType, posterPath, tmdbId });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }

  if (status === "DECLINED") {
    writeInAppNotification(requestedBy, "REQUEST_DECLINED", { title, mediaType, tmdbId, posterPath });
    notifyUserRequestDeclined(requestedBy, title, mediaType, request.adminNote).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUserRequestDeclinedPush({ userId: requestedBy, title, mediaType, tmdbId }).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnDeclined: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnDeclined) notifyUserRequestDeclinedEmail({ toEmail: to, title, mediaType, adminNote: request.adminNote, posterPath });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }
}
