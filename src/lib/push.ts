import { generateVapidKeys, sendPushNotification } from "@/lib/web-push";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/token-crypto";
import { isFeatureEnabled } from "@/lib/features";
import { safeFetchAdminConfigured } from "@/lib/safe-fetch";
import { encryptForDevice } from "@/lib/push-e2e";
import { hasPermission, Permission, effectivePermissions, parsePermissions } from "@/lib/permissions";

type VapidKeys = { publicKey: string; privateKey: string; contact: string };

// Thrown when only one half of the VAPID keypair is present. Regenerating both
// would invalidate every stored web push subscription, so the locked init path
// refuses instead — the caller treats it as "web push not ready".
class VapidPartialKeypairError extends Error {
  constructor() {
    super("VAPID keypair is incomplete; refusing to regenerate over a partial pair");
    this.name = "VapidPartialKeypairError";
  }
}

// Shape every notify* helper passes to sendPush. `title`/`body` are the rich web
// text; `category` selects the GENERIC iOS alert (see APNS_ALERTS) so no titles
// or usernames ever reach the central relay.
type PushPayload = { title: string; body: string; url: string; category: ApnsCategory; deepLink?: string };

// Row shape sendPush consumes — structurally satisfied by prisma.pushSubscription
// findMany results (web rows have p256dh/auth; ios rows have deviceToken).
type PushRow = {
  endpoint: string;
  platform: string;
  p256dh: string | null;
  auth: string | null;
  deviceToken: string | null;
  publicKey: string | null;
};

async function getVapidKeysRaw(): Promise<VapidKeys | null> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["vapidPublicKey", "vapidPrivateKey", "smtpFrom", "smtpUser"] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) return null;
  const contact = `mailto:${cfg.smtpFrom || cfg.smtpUser || "admin@localhost"}`;
  return { publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey, contact };
}

export async function getOrCreateVapidPublicKey(): Promise<string> {
  // VAPID keys must never change after subscriptions are stored — changing them invalidates all existing push subscriptions
  const existing = await getVapidKeysRaw();
  if (existing) return existing.publicKey;

  const generated = generateVapidKeys();
  try {
    await prisma.$transaction(async (tx) => {
    // Advisory lock prevents two concurrent requests both generating and storing different key pairs
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 5)`;

    const rows = await tx.setting.findMany({
      where: { key: { in: ["vapidPublicKey", "vapidPrivateKey"] } },
    });
    const hasPublic = rows.some((r) => r.key === "vapidPublicKey");
    const hasPrivate = rows.some((r) => r.key === "vapidPrivateKey");
    if (hasPublic && hasPrivate) return;
    // A partial keypair (exactly one half present) must NOT trigger a full
    // regenerate — overwriting the surviving key invalidates every existing web
    // push subscription. Backfill the missing half from the surviving one would
    // be impossible (the secret half can't be derived from the public half), so
    // the only safe move is to refuse and leave the stored half untouched. The
    // outer getVapidKeysRaw() then returns null (both must be present), and web
    // push stays disabled until an operator repairs the pair.
    if (hasPublic || hasPrivate) {
      throw new VapidPartialKeypairError();
    }
    await Promise.all([
      tx.setting.upsert({
        where: { key: "vapidPublicKey" },
        create: { key: "vapidPublicKey", value: generated.publicKey },
        update: { value: generated.publicKey },
      }),
      tx.setting.upsert({
        where: { key: "vapidPrivateKey" },
        create: { key: "vapidPrivateKey", value: generated.privateKey },
        update: { value: generated.privateKey },
      }),
    ]);
    });
  } catch (err) {
    if (err instanceof VapidPartialKeypairError) {
      // Leave the stored half intact. Return whatever public key exists so a
      // subscription registered against it still validates; never the freshly
      // generated one (its private half was never stored).
      console.error("[push] VAPID keypair is incomplete — repair the vapidPublicKey/vapidPrivateKey Settings; web push is disabled until then");
      const row = await prisma.setting.findUnique({ where: { key: "vapidPublicKey" } });
      return row?.value ?? "";
    }
    throw err;
  }

  const keys = await getVapidKeysRaw();
  return keys?.publicKey ?? generated.publicKey;
}

// ── iOS (APNs via the central relay) ─────────────────────────────────────────

type ApnsCategory =
  | "new_request"
  | "approved"
  | "declined"
  | "available"
  | "issue_reply"
  | "issue_resolved"
  | "new_issue"
  | "grab_complete"
  | "manual_interaction"
  | "deletion_votes"
  | "test";

// Generic, content-free alerts sent to iOS through the relay. They deliberately
// omit media titles and usernames — the relay is operated centrally and must
// never see them; the app loads the real details on tap from the user's own
// server. Web Push keeps its rich text (it goes to the user's browser vendor,
// not our relay) — only the iOS branch swaps in these generics.
const APNS_ALERTS: Record<ApnsCategory, { title: string; body: string }> = {
  new_request: { title: "New request", body: "A new request needs review" },
  approved: { title: "Request approved", body: "Open Summonarr to see details" },
  declined: { title: "Request declined", body: "Open Summonarr to see details" },
  available: { title: "Now available", body: "Something you requested is ready to watch" },
  issue_reply: { title: "New reply", body: "There's new activity on an issue" },
  issue_resolved: { title: "Issue resolved", body: "An issue you reported was resolved" },
  new_issue: { title: "New issue", body: "A new issue was reported" },
  grab_complete: { title: "Download complete", body: "A download has finished" },
  manual_interaction: { title: "Manual import needed", body: "A download needs your attention" },
  deletion_votes: { title: "Deletion votes", body: "A title reached the deletion-vote threshold" },
  test: { title: "Summonarr", body: "Test notification — push is working!" },
};

// Default relay operated by the app publisher. Overridable per-server via the
// `apnsRelayUrl` Setting (e.g. to point at a self-hosted relay).
const DEFAULT_APNS_RELAY_URL = "https://summonapns.gadgetusaf.com/push";

async function getApnsRelayUrl(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: "apnsRelayUrl" } });
  return row?.value?.trim() || DEFAULT_APNS_RELAY_URL;
}

async function sendApns(subscription: PushRow, payload: PushPayload): Promise<boolean> {
  if (!subscription.deviceToken) return false;
  const alert = APNS_ALERTS[payload.category];
  const apnsPayload: Record<string, unknown> = {
    aps: { alert: { title: alert.title, body: alert.body }, sound: "default" },
    url: payload.url,
  };

  // If the device registered an E2E public key, encrypt the REAL title/body and
  // mark the payload mutable so the on-device Notification Service Extension
  // rewrites the banner. The relay only ever sees ciphertext + the generic
  // placeholder above (shown if decryption is unavailable). Falls back to the
  // placeholder on any encrypt failure.
  if (subscription.publicKey) {
    try {
      const blob = encryptForDevice(
        subscription.publicKey,
        // `u` (the item deep link) rides INSIDE the encrypted blob — it can carry
        // a tmdbId, which must never reach the relay in cleartext.
        JSON.stringify({ t: payload.title, b: payload.body, ...(payload.deepLink ? { u: payload.deepLink } : {}) }),
      );
      (apnsPayload.aps as Record<string, unknown>)["mutable-content"] = 1;
      apnsPayload.e2e = blob;
    } catch (err) {
      console.error("[push] e2e encrypt failed:", err instanceof Error ? err.message : err);
    }
  }

  try {
    const token = decryptToken(subscription.deviceToken, "PushSubscription.deviceToken");
    const relayUrl = await getApnsRelayUrl();
    const res = await safeFetchAdminConfigured(relayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // collapseId groups same-category alerts so a batch (e.g. several requests
      // flipping available at once) shows as one notification on the device.
      body: JSON.stringify({ deviceToken: token, payload: apnsPayload, collapseId: payload.category }),
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      // 5xx / timeouts are transient — keep the token, no prune.
      console.error(`[push] APNs relay HTTP ${res.status}`);
      return false;
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;
    if (data?.reason === "unregistered") {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
      return false;
    }
    return data?.ok === true;
  } catch (err) {
    console.error("[push] APNs relay send failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Sends a test push to a user's registered iOS (APNs) devices through the real
// relay + E2E path — the same code the notify* helpers use. It's a manual
// diagnostic (triggered from /api/push/test), so it deliberately bypasses the
// `feature.integration.push` flag and per-event preferences, and touches only
// iOS rows (web rows are tested separately via VAPID). Returns a per-device
// result so the caller can report which devices delivered.
export async function sendApnsTestToUser(
  userId: string,
): Promise<Array<{ endpoint: string; label: string | null; ok: boolean }>> {
  const subs = await prisma.pushSubscription.findMany({
    where: { userId, platform: "ios" },
  });
  const payload: PushPayload = {
    title: "Summonarr",
    body: "Test notification — push is working! 🎉",
    url: "/",
    category: "test",
  };
  return Promise.all(
    subs.map(async (s) => ({
      endpoint: s.endpoint.slice(0, 28) + "…",
      label: s.label ?? null,
      ok: await sendApns(s, payload),
    })),
  );
}

// ── shared send path ─────────────────────────────────────────────────────────

// Returns the VAPID keys (possibly null) when push is enabled, or null when the
// integration flag is off so all notify helpers short-circuit. Keys may be null
// even when enabled — iOS push goes through the relay and needs no VAPID setup,
// so we must NOT abort the whole send just because web keys aren't configured.
async function pushContext(): Promise<{ keys: VapidKeys | null } | null> {
  if (!(await isFeatureEnabled("feature.integration.push"))) return null;
  return { keys: await getVapidKeysRaw() };
}

async function getAdminSubscriptions(excludeUserId?: string) {
  // Bitmask: MANAGE_REQUESTS holders (new requests, deletion votes, manual arr interaction).
  const subs = await prisma.pushSubscription.findMany({
    where: excludeUserId ? { userId: { not: excludeUserId } } : {},
    include: { user: { select: { role: true, permissions: true } } },
  });
  return subs.filter((s) => {
    const p = s.user?.permissions ?? 0;
    const r = s.user?.role ?? "USER";
    const perms = effectivePermissions(r, parsePermissions(String(p)));
    return hasPermission(perms, Permission.MANAGE_REQUESTS);
  });
}

async function getIssueAdminSubscriptions(opts: { excludeUserId?: string; restrictToUserId?: string } = {}) {
  if (opts.restrictToUserId && opts.restrictToUserId === opts.excludeUserId) return [];
  const userIdFilter = opts.restrictToUserId
    ? { userId: opts.restrictToUserId }
    : opts.excludeUserId
      ? { userId: { not: opts.excludeUserId } }
      : {};
  const subs = await prisma.pushSubscription.findMany({
    where: {
      ...userIdFilter,
      user: { notifyOnIssue: true },
    },
    include: { user: { select: { role: true, permissions: true } } },
  });
  return subs.filter((s) => {
    const p = s.user?.permissions ?? 0;
    const r = s.user?.role ?? "USER";
    const perms = effectivePermissions(r, parsePermissions(String(p)));
    return hasPermission(perms, Permission.MANAGE_ISSUES);
  });
}

async function sendPush(
  keys: VapidKeys | null,
  subscription: PushRow,
  payload: PushPayload,
): Promise<boolean> {
  if (subscription.platform === "ios") {
    return sendApns(subscription, payload);
  }

  // web (VAPID) — needs both the configured keys and the subscription's crypto material
  if (!keys || !subscription.p256dh || !subscription.auth) return false;
  try {
    await sendPushNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: decryptToken(subscription.p256dh, "PushSubscription.p256dh"),
          auth: decryptToken(subscription.auth, "PushSubscription.auth"),
        },
      },
      JSON.stringify({ title: payload.title, body: payload.body, url: payload.url }),
      { contact: keys.contact, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey },
    );
    return true;
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    // 410 Gone / 404 Not Found means the subscription was revoked by the browser — remove it to stop retrying
    if (status === 410 || status === 404) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
    } else {
      console.error("[push] Send failed:", err);
    }
    return false;
  }
}

// Builds the encrypted-only media deep link (/media/<type>/<tmdbId>). Undefined
// when no tmdbId is available, leaving that notification tab-level.
function mediaDeepLink(mediaType: string, tmdbId: number | null | undefined): string | undefined {
  if (tmdbId == null) return undefined;
  return `/media/${mediaType === "MOVIE" ? "movie" : "tv"}/${tmdbId}`;
}

export async function notifyAdminsNewRequestPush(data: {
  title: string;
  mediaType: string;
  requestedBy: string;
  tmdbId?: number;
  excludeUserId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getAdminSubscriptions(data.excludeUserId);
    if (!subs.length) return;

    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload: PushPayload = {
      title: `New ${mediaLabel} Request`,
      body: `${data.title} — requested by ${data.requestedBy}`,
      url: "/admin",
      category: "new_request",
      deepLink: mediaDeepLink(data.mediaType, data.tmdbId),
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (request):", err);
  }
}

export async function notifyUserIssueMessagePush(data: {
  userId: string;
  title: string;
  body: string;
  issueId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: data.userId, user: { notifyOnIssue: true } },
    });
    if (!subs.length) return;

    const payload: PushPayload = {
      title: `Admin replied on: ${data.title}`,
      body: data.body.length > 100 ? data.body.slice(0, 97) + "…" : data.body,
      url: data.issueId ? `/issues?selected=${data.issueId}` : "/issues",
      category: "issue_reply",
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (issue message):", err);
  }
}

export async function notifyUserIssueResolvedPush(data: {
  userId: string;
  title: string;
  resolution?: string | null;
  issueId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: data.userId, user: { notifyOnIssue: true } },
    });
    if (!subs.length) return;

    const resolution = data.resolution?.trim();
    const payload: PushPayload = {
      title: `Issue resolved: ${data.title}`,
      body: resolution
        ? resolution.length > 100
          ? resolution.slice(0, 97) + "…"
          : resolution
        : "An admin marked your reported issue as resolved",
      url: data.issueId ? `/issues?selected=${data.issueId}` : "/issues",
      category: "issue_resolved",
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (issue resolved):", err);
  }
}

export async function notifyAdminsIssueMessagePush(data: {
  title: string;
  userName: string;
  body: string;
  excludeUserId?: string;
  fromAdmin?: boolean;
  restrictToUserId?: string;
  issueId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getIssueAdminSubscriptions({
      excludeUserId: data.excludeUserId,
      restrictToUserId: data.restrictToUserId,
    });
    if (!subs.length) return;

    const payload: PushPayload = {
      title: data.fromAdmin ? `Admin reply on issue: ${data.title}` : `User reply on issue: ${data.title}`,
      body: `${data.userName}: ${data.body.length > 80 ? data.body.slice(0, 77) + "…" : data.body}`,
      url: data.issueId ? `/admin/issues?selected=${data.issueId}` : "/admin/issues",
      category: "issue_reply",
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (issue message):", err);
  }
}

// Returns true when the caller may consider the notification "delivered" (so the
// IssueGrab CAS claim should be left in place). Returns false when delivery was
// attempted but every push failed — caller should reset notifiedAt for retry.
//
// Distinct outcomes encoded as a boolean:
// - true: keys missing OR no subscriptions (nothing to retry by sending more); or
//   at least one push to a subscription succeeded.
// - false: ≥1 subscription existed but every send failed (transient endpoint outage,
//   401 from upstream, etc.) — retry on the next webhook tick may succeed.
// Outcome of an admin push send attempt. Lets the webhook caller distinguish
// "user has no subs / no VAPID configured" (don't retry, but the notification
// channel was effectively a no-op — caller may want to backstop via email or
// Discord) from "delivered" (success) and "failed" (retryable network/transport
// error).
export type AdminGrabPushOutcome =
  | "delivered"
  | "skipped-no-subs"
  | "skipped-no-keys"
  | "failed";

export async function notifyAdminGrabCompletedPush(data: {
  userId: string;
  title: string;
  scope: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  issueId: string;
}): Promise<AdminGrabPushOutcome> {
  try {
    const ctx = await pushContext();
    if (!ctx) return "skipped-no-keys";

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return "skipped-no-subs";

    let scopeLabel = "";
    if (data.scope === "EPISODE" && data.seasonNumber != null && data.episodeNumber != null) {
      scopeLabel = ` S${String(data.seasonNumber).padStart(2, "0")}E${String(data.episodeNumber).padStart(2, "0")}`;
    } else if (data.scope === "SEASON" && data.seasonNumber != null) {
      scopeLabel = ` Season ${data.seasonNumber}`;
    }

    const payload: PushPayload = {
      title: "Download complete",
      body: `${data.title}${scopeLabel} has finished downloading`,
      url: `/issues?selected=${data.issueId}`,
      category: "grab_complete",
    };

    const results = await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
    const anyDelivered = results.some((r) => r.status === "fulfilled" && r.value === true);
    return anyDelivered ? "delivered" : "failed";
  } catch (err) {
    console.error("[push] Failed to notify admin (grab completed):", err);
    return "failed";
  }
}

export async function notifyUserRequestApprovedPush(data: {
  userId: string;
  title: string;
  mediaType: string;
  tmdbId?: number;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const user = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { pushOnApproved: true },
    });
    if (!user?.pushOnApproved) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload: PushPayload = {
      title: "Request Approved",
      body: `Your ${mediaLabel} request for ${data.title} has been approved`,
      url: "/requests",
      category: "approved",
      deepLink: mediaDeepLink(data.mediaType, data.tmdbId),
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (approved):", err);
  }
}

export async function notifyUserRequestDeclinedPush(data: {
  userId: string;
  title: string;
  mediaType: string;
  tmdbId?: number;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const user = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { pushOnDeclined: true },
    });
    if (!user?.pushOnDeclined) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload: PushPayload = {
      title: "Request Declined",
      body: `Your ${mediaLabel} request for ${data.title} was not approved`,
      url: "/requests",
      category: "declined",
      deepLink: mediaDeepLink(data.mediaType, data.tmdbId),
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (declined):", err);
  }
}

export async function notifyUsersRequestsAvailablePush(
  requests: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number }>
) {
  if (requests.length === 0) return;
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, pushOnAvailable: true },
      select: { id: true },
    });
    const eligibleIds = new Set(users.map((u) => u.id));

    const eligible = requests.filter((r) => eligibleIds.has(r.requestedBy));
    if (!eligible.length) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: [...eligibleIds] } },
    });
    if (!subs.length) return;

    const subsByUser = new Map<string, typeof subs>();
    for (const s of subs) {
      const arr = subsByUser.get(s.userId) ?? [];
      arr.push(s);
      subsByUser.set(s.userId, arr);
    }

    const deduped = eligible.flatMap((r) => {
      const userSubs = subsByUser.get(r.requestedBy) ?? [];
      if (!userSubs.length) return [];
      const mediaLabel = r.mediaType === "MOVIE" ? "Movie" : "TV Show";
      const payload: PushPayload = {
        title: "Now Available",
        body: `Your ${mediaLabel} ${r.title} is ready to watch`,
        url: "/requests",
        category: "available",
        deepLink: mediaDeepLink(r.mediaType, r.tmdbId),
      };
      // Send to ALL of the user's devices — matches the approved/declined push
      // siblings; previously only userSubs[0] got the "now available" push.
      return userSubs.map((s) => sendPush(ctx.keys, s, payload));
    });
    await Promise.allSettled(deduped);
  } catch (err) {
    console.error("[push] Failed to notify users (available):", err);
  }
}

export async function notifyUsersRequestsApprovedPush(
  requests: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number }>
) {
  if (requests.length === 0) return;
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, pushOnApproved: true },
      select: { id: true },
    });
    const eligibleIds = new Set(users.map((u) => u.id));

    const eligible = requests.filter((r) => eligibleIds.has(r.requestedBy));
    if (!eligible.length) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: [...eligibleIds] } },
    });
    if (!subs.length) return;

    const subsByUser = new Map<string, typeof subs>();
    for (const s of subs) {
      const arr = subsByUser.get(s.userId) ?? [];
      arr.push(s);
      subsByUser.set(s.userId, arr);
    }

    await Promise.allSettled(
      eligible.flatMap((r) => {
        const userSubs = subsByUser.get(r.requestedBy) ?? [];
        const mediaLabel = r.mediaType === "MOVIE" ? "Movie" : "TV Show";
        const payload: PushPayload = {
          title: "Request Approved",
          body: `Your ${mediaLabel} request for ${r.title} has been approved`,
          url: "/requests",
          category: "approved",
          deepLink: mediaDeepLink(r.mediaType, r.tmdbId),
        };
        return userSubs.map((s) => sendPush(ctx.keys, s, payload));
      })
    );
  } catch (err) {
    console.error("[push] Failed to notify users (approved):", err);
  }
}

export async function notifyUsersRequestsDeclinedPush(
  requests: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number }>
) {
  if (requests.length === 0) return;
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, pushOnDeclined: true },
      select: { id: true },
    });
    const eligibleIds = new Set(users.map((u) => u.id));

    const eligible = requests.filter((r) => eligibleIds.has(r.requestedBy));
    if (!eligible.length) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: [...eligibleIds] } },
    });
    if (!subs.length) return;

    const subsByUser = new Map<string, typeof subs>();
    for (const s of subs) {
      const arr = subsByUser.get(s.userId) ?? [];
      arr.push(s);
      subsByUser.set(s.userId, arr);
    }

    await Promise.allSettled(
      eligible.flatMap((r) => {
        const userSubs = subsByUser.get(r.requestedBy) ?? [];
        const mediaLabel = r.mediaType === "MOVIE" ? "Movie" : "TV Show";
        const payload: PushPayload = {
          title: "Request Declined",
          body: `Your ${mediaLabel} request for ${r.title} was not approved`,
          url: "/requests",
          category: "declined",
          deepLink: mediaDeepLink(r.mediaType, r.tmdbId),
        };
        return userSubs.map((s) => sendPush(ctx.keys, s, payload));
      })
    );
  } catch (err) {
    console.error("[push] Failed to notify users (declined):", err);
  }
}

export async function notifyAdminsNewIssuePush(data: {
  title: string;
  issueType: string;
  reportedBy: string;
  issueId?: string;
  excludeUserId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getIssueAdminSubscriptions({ excludeUserId: data.excludeUserId });
    if (!subs.length) return;

    const issueLabel = data.issueType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const payload: PushPayload = {
      title: "New Issue Report",
      body: `${data.title} — ${issueLabel} reported by ${data.reportedBy}`,
      url: data.issueId ? `/admin/issues?selected=${data.issueId}` : "/admin/issues",
      category: "new_issue",
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (issue):", err);
  }
}

// Radarr/Sonarr fire ManualInteractionRequired when a grabbed release can't be imported
// automatically and is parked in the queue waiting for an operator. Best-effort push to all
// admins so they know to go resolve it; there's nothing to mark available.
export async function notifyAdminsManualInteractionRequiredPush(data: {
  service: "Radarr" | "Sonarr";
  title: string;
  detail?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getAdminSubscriptions();
    if (!subs.length) return;

    const title = data.title.length > 100 ? data.title.slice(0, 97) + "…" : data.title;
    const payload: PushPayload = {
      title: `${data.service}: manual import needed`,
      body: data.detail
        ? `${title} — stuck in ${data.detail}, needs manual intervention`
        : `${title} needs manual intervention in ${data.service}`,
      url: "/admin",
      category: "manual_interaction",
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (manual interaction):", err);
  }
}

export async function notifyAdminsDeletionVoteThresholdPush(data: {
  title: string;
  mediaType: string;
  voteCount: number;
  tmdbId?: number;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getAdminSubscriptions();
    if (!subs.length) return;

    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload: PushPayload = {
      title: "Deletion Vote Threshold Reached",
      body: `${data.title} (${label}) has ${data.voteCount} deletion votes`,
      url: "/votes",
      category: "deletion_votes",
      deepLink: mediaDeepLink(data.mediaType, data.tmdbId),
    };

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (deletion vote):", err);
  }
}
