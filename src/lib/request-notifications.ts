import "server-only";
import { settleLimit } from "./concurrency";
import { prisma } from "./prisma";
import { notifyUserRequestApproved, notifyUserRequestDeclined, notifyUsersRequestsAvailable } from "./discord-notify";
import { notifyUserRequestApprovedPush, notifyUserRequestDeclinedPush, notifyUsersRequestsAvailablePush } from "./push";
import { notifyUserRequestApprovedEmail, notifyUserRequestDeclinedEmail, notifyUserRequestAvailableEmail } from "./email";
import { resolveUserNotificationEmail } from "./notification-email";
import { claimAvailableNotificationWinners } from "./notify-available";
import { createInAppNotification } from "./in-app-notify";
import { buildNotificationData } from "./notification-data";
import { emitNotificationEvent, emitNotificationEvents } from "./notify-agents";
import type { NotifyEvent } from "./notify-events";

interface RequestInfo {
  requestedBy: string;
  title: string;
  mediaType: string;
  adminNote?: string | null;
  posterPath?: string | null;
  tmdbId?: number;
  // Optional context for the outbound channels (notify-agents.ts) only.
  requestId?: string;
  arrInstance?: string;
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
  // REQUIRED: the outbound `request.available` event names the instance
  // (guardrail 32), and a select that leaves it off would silently report the
  // default slug for a 4K/named request — the webhook polls shipped that way.
  arrInstance: string;
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
    // The body is re-rendered from type + mediaType in the reader's language.
    data: { v: 1 },
  });
}

// `inPlex`/`inJellyfin` are COLLAPSED booleans — the instance that proved
// presence is not carried here — and that stays sound under multi-server
// per-user visibility grants for one structural reason: every caller of this
// function probes the DEFAULT ("") server only. pollAndNotifyAvailable's
// checkPlex/checkJellyfin closures are built in the Radarr/Sonarr webhook
// handlers from getPlexConfig()/getJellyfinConfig() with no slug argument, which
// resolve DEFAULT_MEDIA_INSTANCE; the default instance is visible to every user
// by construction (defaultInstanceConfig hard-codes restricted:false and
// canViewMediaInstance short-circuits true on slug ""). So `true` here already
// means "present on a server this requester can see", for every requester.
//
// A restricted named instance can only enter the picture through the sync
// orchestrator, which does carry per-instance presence and applies the
// per-requester gate itself (presentForRequester in /api/sync/route.ts).
//
// If a caller ever probes a NAMED instance, this contract breaks and the two
// booleans must become per-instance (an optional slug-set parameter, so the two
// webhook call sites keep compiling) plus the same pre-CAS grants filter the
// orchestrator applies. Do not widen the probe without doing that.
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
  // actually flipped, not the full pre-CAS overlap set. requireStatusAvailable is the
  // documented contract for non-markAvailable callers (notify-available.ts): this path
  // doesn't set status itself, so it must only claim rows ALREADY AVAILABLE. Callers
  // today pre-filter to AVAILABLE (making this a no-op), but the guard keeps a future
  // caller from burning the once-only notifiedAvailable flag on a non-AVAILABLE row.
  const winners = await claimAvailableNotificationWinners(toNotify, { requireStatusAvailable: true });
  await fanOutAvailableWinners(winners, logScope);
}

export interface AvailableWinner {
  id?: string;
  requestedBy: string;
  title: string;
  mediaType: string;
  tmdbId?: number | null;
  posterPath?: string | null;
  // REQUIRED, not defaulted: the outbound event's `request.instance` is read
  // from here (guardrail 32). It was optional-with-`""` once, and four of the
  // seven callers silently dropped it — a 4K request marked by the arr-cache
  // passes or the webhook poll reported the default instance while the same
  // request marked by a library pass reported "4k". The compiler now makes
  // every caller carry the row's own slug.
  arrInstance: string;
}

// THE "now available" fan-out, for every path that has already won the
// once-only claim (claimAvailableNotificationWinners / claimAvailableNotifications
// — guardrail 14): the webhook poll above, all six sync-orchestrator /
// per-source marking passes, AND the manual admin "mark available"
// (dispatchRequestStatusChange below, after its own CAS + disabled-account
// gate). Callers pass only the claimed, DELIVERABLE rows (disabled requesters
// already dropped — guardrail 33), so every channel here fires exactly once
// per transition. Adding a channel means adding it HERE, not at a call site —
// the sites used to repeat this list six times, and the manual path kept a
// seventh, differently-shaped copy (guardrail 14c).
//
// Returns the email send (bounded, awaited inside); the sync callers `void` it,
// the webhook path awaits it.
export async function fanOutAvailableWinners(winners: AvailableWinner[], logScope: string): Promise<void> {
  if (winners.length === 0) return;
  const payload = winners.map((r) => ({ requestedBy: r.requestedBy, title: r.title, mediaType: r.mediaType, tmdbId: r.tmdbId ?? undefined }));
  notifyUsersRequestsAvailable(payload).catch((err) => console.error(`[${logScope}] Discord available notify failed:`, err instanceof Error ? err.message : err));
  notifyUsersRequestsAvailablePush(payload).catch((err) => console.error(`[${logScope}] push available notify failed:`, err instanceof Error ? err.message : err));
  // In-app inbox for the batch winners (one createMany, same CAS-once guarantee).
  void writeAvailableInAppNotifications(winners, logScope);
  // Outbound channels: one event per claimed request. This is the ONLY
  // `request.available` emit — dispatchRequestStatusChange routes here rather
  // than emitting its own, or the manual path would fire the event twice.
  emitNotificationEvents(winners.map((w) => availableEvent(w)));
  // Email channel, so the user's `emailOnAvailable` preference is honoured on
  // the webhook/sync paths too.
  await notifyUsersRequestsAvailableEmail(winners, logScope);
}

function availableEvent(w: AvailableWinner): NotifyEvent {
  return {
    event: "request.available",
    media: { type: w.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: w.tmdbId ?? null, title: w.title, posterPath: w.posterPath ?? null },
    request: { id: w.id ?? null, instance: w.arrInstance },
  };
}

// Shared BATCH in-app inbox writer for the "now available" fan-out. Every
// AVAILABLE transition — the webhook poll (notifyAvailablePerServer above), all
// six sync-orchestrator/per-source claimAvailableNotificationWinners sites and
// the manual admin path (via fanOutAvailableWinners) — routes its winners
// through here, so the header bell / /notifications inbox gets a
// REQUEST_AVAILABLE row for every one of them. The CAS (compare-and-swap) in
// claimAvailableNotificationWinners has already deduped the winner set;
// skipDuplicates is an extra safety net.
// One createMany = one DB round-trip.
// Best-effort: swallows its own errors so an inbox-write blip never aborts the
// sync run or the triggering action. Call fire-and-forget:
// `void writeAvailableInAppNotifications(...)`.
export async function writeAvailableInAppNotifications(
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
  try {
    await prisma.notification.createMany({
      data: winners.map((r) =>
        buildNotificationData(r.requestedBy, {
          type: "REQUEST_AVAILABLE",
          title: r.title,
          body: inAppBodyFor("REQUEST_AVAILABLE", r.mediaType),
          tmdbId: r.tmdbId ?? null,
          mediaType: r.mediaType,
          posterPath: r.posterPath ?? null,
          data: { v: 1 },
        }),
      ),
      skipDuplicates: true,
    });
  } catch (err) {
    console.error(`[${logScope}] in-app available write failed:`, err instanceof Error ? err.message : err);
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
    select: { id: true, email: true, notificationEmail: true, emailOnAvailable: true, locale: true },
  }).catch((err) => {
    console.error(`[${logScope}] email-pref fetch failed:`, err instanceof Error ? err.message : err);
    return [];
  });
  const prefByUserId = new Map(userPrefs.map((u) => [u.id, u]));
  // BOUNDED (guardrail 31), and awaited. Each send opens its own SMTP connection, and
  // firing the whole winner set at once blew past the relay's per-client connection
  // cap (see EMAIL_SEND_CONCURRENCY) — so a backlog pass, which is exactly when this
  // fans out widest, had most of its mail rejected. The
  // "now available" claim is a once-only CAS that has ALREADY been burned by the time
  // this runs, so a dropped send is never retried: that mail is simply lost.
  const recipients = winners.flatMap((w) => {
    const u = prefByUserId.get(w.requestedBy);
    if (!u || !u.emailOnAvailable) return [];
    const to = resolveUserNotificationEmail(u);
    return to ? [{ w, to, locale: u.locale ?? null }] : [];
  });
  await settleLimit(recipients, EMAIL_SEND_CONCURRENCY, async ({ w, to, locale }) => {
    await notifyUserRequestAvailableEmail({
      toEmail: to,
      title: w.title,
      mediaType: w.mediaType,
      posterPath: w.posterPath ?? null,
      tmdbId: w.tmdbId ?? undefined,
      locale,
    }).catch((err) => console.error(`[${logScope}] email error:`, err instanceof Error ? err.message : err));
  });
}

// SMTP connections are the scarce resource, not CPU: every real relay caps concurrent
// connections per client (Office 365 allows 3, Gmail ~10). Stay under the tightest.
const EMAIL_SEND_CONCURRENCY = 3;

// Poll for up to 12 minutes (24 × 30 s) before giving up — long enough for a
// slow Plex/Jellyfin library scan to pick up the file after a webhook.
const ITEM_POLL_INTERVAL_MS = 30_000;
const ITEM_POLL_MAX = 24;

// One in-flight poll per identical pending set: a season import fires one Download
// webhook per episode, and each used to spawn its own 12-minute 24×30s poll loop
// against Plex + Jellyfin — hundreds of concurrent pollers hammering the media
// servers during a mass import when the library scan lags. The pending rows stay
// unnotified until a poll completes, so repeat webhooks fetch the same id set and
// join the running poll (requests on different arr instances are different rows,
// so their id sets key apart).
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
  const { requestedBy } = request;

  // Never notify a DISABLED account. Account removal disables rather than scrubs
  // (see account-lifecycle.ts), so the row keeps a live notification email,
  // Discord link and push subscriptions — without this gate an admin approving
  // or declining a removed user's leftover request would still ping them. One
  // lookup covers all four channels; the batch "now available" path has its own
  // chokepoint in claimAvailableNotificationWinners.
  void prisma.user
    .findUnique({ where: { id: requestedBy }, select: { deactivatedAt: true } })
    .then((u) => {
      if (u?.deactivatedAt) return;
      dispatchRequestStatusChange(status, request);
    })
    .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
}

function dispatchRequestStatusChange(
  status: "APPROVED" | "AVAILABLE" | "DECLINED",
  request: RequestInfo,
): void {
  const { requestedBy, title, mediaType, posterPath, tmdbId } = request;

  // The manual admin "mark available" is a claimed winner like any other
  // (requests/[id] runs the notifiedAvailable CAS before calling here, and the
  // disabled-account gate above has passed), so it takes THE "now available"
  // fan-out — every legacy channel plus the one outbound emit — instead of a
  // second, hand-maintained channel list (guardrail 14c). A channel added to
  // fanOutAvailableWinners reaches this path for free.
  if (status === "AVAILABLE") {
    fanOutAvailableWinners(
      [{ id: request.requestId, requestedBy, title, mediaType, tmdbId, posterPath, arrInstance: request.arrInstance ?? "" }],
      "notify",
    ).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    return;
  }

  emitNotificationEvent({
    event: status === "APPROVED" ? "request.approved" : "request.declined",
    media: { type: mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: tmdbId ?? null, title, posterPath: posterPath ?? null },
    request: { id: request.requestId ?? null, instance: request.arrInstance ?? "" },
    text: status === "DECLINED" ? (request.adminNote ?? null) : null,
  });

  if (status === "APPROVED") {
    writeInAppNotification(requestedBy, "REQUEST_APPROVED", { title, mediaType, tmdbId, posterPath });
    notifyUserRequestApproved(requestedBy, title, mediaType, tmdbId).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUserRequestApprovedPush({ userId: requestedBy, title, mediaType, tmdbId }).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnApproved: true, locale: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnApproved) notifyUserRequestApprovedEmail({ toEmail: to, title, mediaType, posterPath, tmdbId, locale: u.locale });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }

  if (status === "DECLINED") {
    writeInAppNotification(requestedBy, "REQUEST_DECLINED", { title, mediaType, tmdbId, posterPath });
    notifyUserRequestDeclined(requestedBy, title, mediaType, request.adminNote, tmdbId).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    notifyUserRequestDeclinedPush({ userId: requestedBy, title, mediaType, tmdbId }).catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
    prisma.user.findUnique({ where: { id: requestedBy }, select: { email: true, notificationEmail: true, emailOnDeclined: true, locale: true } })
      .then((u) => {
        const to = u && resolveUserNotificationEmail(u);
        if (to && u.emailOnDeclined) notifyUserRequestDeclinedEmail({ toEmail: to, title, mediaType, tmdbId, adminNote: request.adminNote, posterPath, locale: u.locale });
      })
      .catch((err) => console.error("[notify]", err instanceof Error ? err.message : err));
  }
}
