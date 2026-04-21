import webpush from "web-push";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/token-crypto";
import { isFeatureEnabled } from "@/lib/features";

async function getVapidKeysRaw(): Promise<{ publicKey: string; privateKey: string; contact: string } | null> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["vapidPublicKey", "vapidPrivateKey", "smtpFrom", "smtpUser"] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) return null;
  const contact = `mailto:${cfg.smtpFrom || cfg.smtpUser || "admin@localhost"}`;
  return { publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey, contact };
}

// Send-path variant — returns null when the push integration feature flag is disabled so all notification helpers short-circuit through their existing `if (!keys) return` guards. Key bootstrapping (getOrCreateVapidPublicKey) uses getVapidKeysRaw directly so keys can still be inspected/generated even when sends are disabled.
async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string; contact: string } | null> {
  if (!(await isFeatureEnabled("feature.integration.push"))) return null;
  return getVapidKeysRaw();
}

export async function getOrCreateVapidPublicKey(): Promise<string> {
  // VAPID keys must never change after subscriptions are stored — changing them invalidates all existing push subscriptions
  const existing = await getVapidKeysRaw();
  if (existing) return existing.publicKey;

  const generated = webpush.generateVAPIDKeys();
  await prisma.$transaction(async (tx) => {
    // Advisory lock prevents two concurrent requests both generating and storing different key pairs
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 5)`;

    const rows = await tx.setting.findMany({
      where: { key: { in: ["vapidPublicKey", "vapidPrivateKey"] } },
    });
    if (rows.length >= 2) return;
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

  const keys = await getVapidKeysRaw();
  return keys?.publicKey ?? generated.publicKey;
}

async function getAdminSubscriptions() {
  return prisma.pushSubscription.findMany({
    where: { user: { role: "ADMIN" } },
  });
}

async function getIssueAdminSubscriptions() {
  return prisma.pushSubscription.findMany({
    where: {
      user: {
        role: { in: ["ADMIN", "ISSUE_ADMIN"] },
        notifyOnIssue: true,
      },
    },
  });
}

async function sendPush(
  keys: { publicKey: string; privateKey: string; contact: string },
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: object
): Promise<boolean> {
  webpush.setVapidDetails(keys.contact, keys.publicKey, keys.privateKey);
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: decryptToken(subscription.p256dh), auth: decryptToken(subscription.auth) } },
      JSON.stringify(payload)
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

export async function notifyAdminsNewRequestPush(data: {
  title: string;
  mediaType: string;
  requestedBy: string;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const subs = await getAdminSubscriptions();
    if (!subs.length) return;

    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload = {
      title: `New ${mediaLabel} Request`,
      body: `${data.title} — requested by ${data.requestedBy}`,
      url: "/admin",
    };

    await Promise.allSettled(subs.map((s: { endpoint: string; p256dh: string; auth: string }) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (request):", err);
  }
}

export async function notifyUserIssueMessagePush(data: {
  userId: string;
  title: string;
  body: string;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const payload = {
      title: `Admin replied on: ${data.title}`,
      body: data.body.length > 100 ? data.body.slice(0, 97) + "…" : data.body,
      url: "/issues",
    };

    await Promise.allSettled(subs.map((s) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (issue message):", err);
  }
}

export async function notifyAdminsIssueMessagePush(data: {
  title: string;
  userName: string;
  body: string;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const subs = await getIssueAdminSubscriptions();
    if (!subs.length) return;

    const payload = {
      title: `User reply on issue: ${data.title}`,
      body: `${data.userName}: ${data.body.length > 80 ? data.body.slice(0, 77) + "…" : data.body}`,
      url: "/admin/issues",
    };

    await Promise.allSettled(subs.map((s) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (issue message):", err);
  }
}

export async function notifyAdminGrabCompletedPush(data: {
  userId: string;
  title: string;
  scope: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  issueId: string;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    let scopeLabel = "";
    if (data.scope === "EPISODE" && data.seasonNumber != null && data.episodeNumber != null) {
      scopeLabel = ` S${String(data.seasonNumber).padStart(2, "0")}E${String(data.episodeNumber).padStart(2, "0")}`;
    } else if (data.scope === "SEASON" && data.seasonNumber != null) {
      scopeLabel = ` Season ${data.seasonNumber}`;
    }

    const payload = {
      title: "Download complete",
      body: `${data.title}${scopeLabel} has finished downloading`,
      url: "/admin/issues",
    };

    await Promise.allSettled(subs.map((s) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admin (grab completed):", err);
  }
}

export async function notifyUserRequestApprovedPush(data: {
  userId: string;
  title: string;
  mediaType: string;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const user = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { pushOnApproved: true },
    });
    if (!user?.pushOnApproved) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload = {
      title: "Request Approved",
      body: `Your ${mediaLabel} request for ${data.title} has been approved`,
      url: "/requests",
    };

    await Promise.allSettled(subs.map((s) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (approved):", err);
  }
}

export async function notifyUserRequestDeclinedPush(data: {
  userId: string;
  title: string;
  mediaType: string;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const user = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { pushOnDeclined: true },
    });
    if (!user?.pushOnDeclined) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload = {
      title: "Request Declined",
      body: `Your ${mediaLabel} request for ${data.title} was not approved`,
      url: "/requests",
    };

    await Promise.allSettled(subs.map((s) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify user (declined):", err);
  }
}

export async function notifyUsersRequestsAvailablePush(
  requests: Array<{ requestedBy: string; title: string; mediaType: string }>
) {
  if (requests.length === 0) return;
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

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
      const sub = userSubs[0];
      if (!sub) return [];
      const mediaLabel = r.mediaType === "MOVIE" ? "Movie" : "TV Show";
      const payload = {
        title: "Now Available",
        body: `Your ${mediaLabel} ${r.title} is ready to watch`,
        url: "/requests",
      };
      return [sendPush(keys, sub, payload)];
    });
    await Promise.allSettled(deduped);
  } catch (err) {
    console.error("[push] Failed to notify users (available):", err);
  }
}

export async function notifyUsersRequestsApprovedPush(
  requests: Array<{ requestedBy: string; title: string; mediaType: string }>
) {
  if (requests.length === 0) return;
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

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
        const payload = {
          title: "Request Approved",
          body: `Your ${mediaLabel} request for ${r.title} has been approved`,
          url: "/requests",
        };
        return userSubs.map((s) => sendPush(keys, s, payload));
      })
    );
  } catch (err) {
    console.error("[push] Failed to notify users (approved):", err);
  }
}

export async function notifyUsersRequestsDeclinedPush(
  requests: Array<{ requestedBy: string; title: string; mediaType: string }>
) {
  if (requests.length === 0) return;
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

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
        const payload = {
          title: "Request Declined",
          body: `Your ${mediaLabel} request for ${r.title} was not approved`,
          url: "/requests",
        };
        return userSubs.map((s) => sendPush(keys, s, payload));
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
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const subs = await getIssueAdminSubscriptions();
    if (!subs.length) return;

    const issueLabel = data.issueType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const payload = {
      title: "New Issue Report",
      body: `${data.title} — ${issueLabel} reported by ${data.reportedBy}`,
      url: "/admin/issues",
    };

    await Promise.allSettled(subs.map((s: { endpoint: string; p256dh: string; auth: string }) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (issue):", err);
  }
}

export async function notifyAdminsDeletionVoteThresholdPush(data: {
  title: string;
  mediaType: string;
  voteCount: number;
}) {
  try {
    const keys = await getVapidKeys();
    if (!keys) return;

    const subs = await getAdminSubscriptions();
    if (!subs.length) return;

    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const payload = {
      title: "Deletion Vote Threshold Reached",
      body: `${data.title} (${label}) has ${data.voteCount} deletion votes`,
      url: "/votes",
    };

    await Promise.allSettled(subs.map((s: { endpoint: string; p256dh: string; auth: string }) => sendPush(keys, s, payload)));
  } catch (err) {
    console.error("[push] Failed to notify admins (deletion vote):", err);
  }
}
