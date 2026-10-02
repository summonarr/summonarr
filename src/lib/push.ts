import { generateVapidKeys, sendPushNotification } from "@/lib/web-push";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/token-crypto";
import { isFeatureEnabled } from "@/lib/features";
import { safeFetchAdminConfigured } from "@/lib/safe-fetch";
import { encryptForDevice } from "@/lib/push-e2e";
import { hasPermission, Permission, effectivePermissions, parsePermissions } from "@/lib/permissions";
import { settleLimit } from "@/lib/concurrency";
import { localeForUser, translatorFor } from "@/lib/i18n/server-locale";
import { titleResolver, type TitleResolver } from "@/lib/tmdb-localize";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/translate";
import { issueTypeLabelT, mediaLabelT } from "@/lib/notify-i18n";

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
//
// Every payload is written in its RECIPIENT's language. `alert` is the generic
// APNs text in that same language (APNS_ALERTS is the English table); a payload
// built without it falls back to English.
type PushPayload = {
  title: string;
  body: string;
  url: string;
  category: ApnsCategory;
  deepLink?: string;
  alert?: { title: string; body: string };
};

// Builds a notification once per recipient LOCALE (not once per device) and
// attaches the matching generic APNs alert. `user` is the recipient row (or
// anything carrying its stored `locale`); null/absent → the instance default.
function localizedPayloads(build: (t: Translator, locale: Locale) => Omit<PushPayload, "alert">) {
  const byLocale = new Map<Locale, PushPayload>();
  return (user: { locale?: string | null } | null | undefined): PushPayload => {
    const locale = localeForUser(user);
    let payload = byLocale.get(locale);
    if (!payload) {
      const t = translatorFor(locale);
      const built = build(t, locale);
      payload = { ...built, alert: apnsAlert(built.category, t) };
      byLocale.set(locale, payload);
    }
    return payload;
  };
}

// The languages a set of recipients read — what titleResolver resolves media
// titles for (guardrail 40a).
function recipientLocales(users: readonly ({ locale?: string | null } | null | undefined)[]): Locale[] {
  return users.map((u) => localeForUser(u));
}

// Recipient rows join the subscription to its user's stored locale.
const WITH_LOCALE = { user: { select: { locale: true } } } as const;

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
  const contact = buildVapidContact(cfg.smtpFrom, cfg.smtpUser);
  return { publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey, contact };
}

// Builds the VAPID contact ("sub"), which RFC 8292 requires to be a URI.
// smtpFrom often holds a display-name address like `Summonarr <noreply@host>`.
// Pasting that straight after `mailto:` makes an invalid URI, and push services
// then reject every web push with no hint that the From address is the cause.
// So we pull out the address inside the <...> brackets when there is one.
//
// Exported so /api/push/test uses the same logic; it once built the contact
// itself and hit exactly this bug.
export function buildVapidContact(smtpFrom?: string | null, smtpUser?: string | null): string {
  const raw = (smtpFrom || smtpUser || "").trim();
  const addr = raw.match(/<([^>]+)>/)?.[1]?.trim() || raw;
  return `mailto:${addr || "admin@localhost"}`;
}

export async function getOrCreateVapidPublicKey(): Promise<string> {
  // VAPID keys must never change once subscriptions exist: new keys would
  // invalidate every stored browser subscription.
  const existing = await getVapidKeysRaw();
  if (existing) return existing.publicKey;

  const generated = generateVapidKeys();
  try {
    await prisma.$transaction(async (tx) => {
    // A Postgres advisory lock stops two concurrent requests from each
    // generating and saving a different key pair.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 5)`;

    const rows = await tx.setting.findMany({
      where: { key: { in: ["vapidPublicKey", "vapidPrivateKey"] } },
    });
    const hasPublic = rows.some((r) => r.key === "vapidPublicKey");
    const hasPrivate = rows.some((r) => r.key === "vapidPrivateKey");
    if (hasPublic && hasPrivate) return;
    // Only one half present: do NOT regenerate. Overwriting the surviving key
    // would invalidate every existing web push subscription, and the missing
    // half can't be rebuilt from the other one. So refuse and leave the stored
    // half alone. getVapidKeysRaw() keeps returning null (it needs both), and
    // web push stays off until an operator repairs the pair.
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
  | "app_update"
  | "test";

// Generic, content-free alerts sent to iOS through the relay. They deliberately
// omit media titles and usernames — the relay is operated centrally and must
// never see them; the app loads the real details on tap from the user's own
// server. Web Push keeps its rich text (it goes to the user's browser vendor,
// not our relay) — only the iOS branch swaps in these generics.
//
// These strings are the ONLY cleartext alert text the relay ever sees, and the
// relay validates them: title ≤60 / body ≤120 chars, no control or bidi/zero-
// width characters, and a newline only in the body. A string that breaks a rule
// makes the relay answer 400 for that whole category, so tests/push.test.mts
// pins every entry against those rules — edit them there first.
//
// The text lives in the notify.push.apnsTitle.* / apnsBody.* catalog keys and is
// sent in the recipient's language; APNS_ALERTS is the English table, and
// apnsAlertsFor(t) builds the table for any locale (the tests pin every locale's
// entries against the relay rules).
const APNS_CATEGORIES: readonly ApnsCategory[] = [
  "new_request",
  "approved",
  "declined",
  "available",
  "issue_reply",
  "issue_resolved",
  "new_issue",
  "grab_complete",
  "manual_interaction",
  "deletion_votes",
  "app_update",
  "test",
];

function apnsAlert(category: ApnsCategory, t: Translator): { title: string; body: string } {
  return { title: t(`notify.push.apnsTitle.${category}`), body: t(`notify.push.apnsBody.${category}`) };
}

export function apnsAlertsFor(t: Translator): Record<ApnsCategory, { title: string; body: string }> {
  return Object.fromEntries(APNS_CATEGORIES.map((c) => [c, apnsAlert(c, t)])) as Record<
    ApnsCategory,
    { title: string; body: string }
  >;
}

export const APNS_ALERTS: Record<ApnsCategory, { title: string; body: string }> = apnsAlertsFor(translatorFor("en"));

// Default relay operated by the app publisher. Overridable per-server via the
// `apnsRelayUrl` Setting (e.g. to point at a self-hosted relay).
const DEFAULT_APNS_RELAY_URL = "https://summonapns.gadgetusaf.com/push";

// The relay config is two Setting rows that rarely change, but sendApns runs
// once per iOS device. Reading them every time meant e.g. 150 identical queries
// for a 50-title batch to 3-device users. So the config is cached for 30s, and
// callers that arrive while a read is running share that one read (the same
// pattern as omdb.ts's getApiKey).
//
// Note: the cache holds the DECRYPTED relay key in memory for up to 30s, just
// as omdb.ts does with its API key.
const APNS_RELAY_TTL_MS = 30_000;
let apnsRelayCache: { value: { url: string; key: string }; at: number } | null = null;
let apnsRelayInflight: Promise<{ url: string; key: string }> | null = null;

// Bumped by every invalidation. A read that was already running only saves
// its result if no invalidation happened meanwhile; otherwise it would put the
// OLD value back into the cache for another 30s.
let apnsRelayEpoch = 0;

/**
 * Clears the cache. Called by /api/settings after a relay change, so the
 * admin's usual "save the relay key, then press Send test notification" check
 * uses the new config instead of one up to 30s old.
 */
export function invalidateApnsRelayCache(): void {
  apnsRelayEpoch += 1;
  apnsRelayCache = null;
  apnsRelayInflight = null;
}

async function getApnsRelayConfig(): Promise<{ url: string; key: string }> {
  const now = Date.now();
  if (apnsRelayCache && now - apnsRelayCache.at < APNS_RELAY_TTL_MS) return apnsRelayCache.value;
  if (apnsRelayInflight) return apnsRelayInflight;
  const epochAtStart = apnsRelayEpoch;
  apnsRelayInflight = readApnsRelayConfig()
    .then((value) => {
      if (apnsRelayEpoch === epochAtStart) apnsRelayCache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      apnsRelayInflight = null;
    });
  return apnsRelayInflight;
}

async function readApnsRelayConfig(): Promise<{ url: string; key: string }> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["apnsRelayUrl", "apnsRelayKey"] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    url: cfg.apnsRelayUrl?.trim() || DEFAULT_APNS_RELAY_URL,
    // apnsRelayKey is decrypted on read by the Prisma extension; empty/absent
    // means the relay runs unauthenticated and no Authorization header is sent.
    key: cfg.apnsRelayKey?.trim() || "",
  };
}

async function sendApns(subscription: PushRow, payload: PushPayload): Promise<boolean> {
  if (!subscription.deviceToken) return false;
  const alert = payload.alert ?? APNS_ALERTS[payload.category];
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
    const relay = await getApnsRelayConfig();
    const res = await safeFetchAdminConfigured(relay.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Optional relay auth — only sent when an apnsRelayKey is configured.
        ...(relay.key ? { authorization: `Bearer ${relay.key}` } : {}),
      },
      // collapseId groups same-category alerts so a batch (e.g. several requests
      // flipping available at once) shows as one notification on the device.
      body: JSON.stringify({ deviceToken: token, payload: apnsPayload, collapseId: payload.category }),
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      // A non-2xx answer is not retried, and the device token is normally kept
      // (5xx and timeouts are temporary; the usual "unregistered" cleanup is on
      // the success path below). Read the relay's JSON error body, if any, so
      // the log says WHY, and so a clearly permanent APNs reason can still
      // delete the dead token.
      const errBody = (await res.json().catch(() => null)) as
        | { error?: string; reason?: string; apnsReason?: string }
        | null;
      const detail = [errBody?.error, errBody?.reason, errBody?.apnsReason]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join("; ");
      if (res.status === 400) {
        // The relay's payload validation refused what we sent. That is never
        // transient: this category will fail for every device until the code
        // changes, so say so plainly instead of reading like a relay hiccup.
        console.error(
          `[push] APNs relay rejected the payload (400: ${errBody?.error ?? "no error given"}) — the relay's validation refused it; this is a Summonarr server bug (category "${payload.category}"), not a transient failure`,
        );
      } else if (res.status === 401) {
        console.error(
          `[push] APNs relay rejected auth (401${detail ? `: ${detail}` : ""}) — set/verify the apnsRelayKey setting`,
        );
      } else if (res.status === 429) {
        // Deliberately dropped, not retried. The relay's budget is per device
        // (scoped to this server's apnsRelayKey when one is set), so a batch hitting it would schedule one detached
        // retry per job into the same exhausted budget, and nothing would track
        // or bound those timers. A lost alert is recovered by opening the app.
        const retryAfter = res.headers.get("retry-after");
        console.error(
          `[push] APNs relay rate-limited (429${detail ? `: ${detail}` : ""})${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
        );
      } else {
        console.error(`[push] APNs relay HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      // APNs "Unregistered" / "BadDeviceToken" is permanent: the app install is
      // gone. Keeping the row would waste a relay call on every later send, and
      // the dead row would still count toward the per-user device limit and push
      // out a live device. Only these two reasons delete the row.
      if (/unregistered|baddevicetoken/i.test(`${errBody?.apnsReason ?? ""} ${errBody?.reason ?? ""}`)) {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
      }
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
    include: WITH_LOCALE,
  });
  const payloadFor = localizedPayloads((t) => ({
    title: "Summonarr",
    body: t("notify.push.test.bodyIos"),
    url: "/",
    category: "test",
  }));
  return Promise.all(
    subs.map(async (s) => ({
      endpoint: s.endpoint.slice(0, 28) + "…",
      label: s.label ?? null,
      ok: await sendApns(s, payloadFor(s.user)),
    })),
  );
}

// Admin broadcast: "update the app" push to EVERY registered iOS device across
// all users. The alert is generic (no user content); devices with an E2E key
// get the same text through the encrypted rich path sendApns already runs per
// subscription. Like the test push, this is a deliberate operator action, so it
// bypasses the `feature.integration.push` flag and per-event preferences.
// Returns per-fan-out counts for the admin UI.
export async function sendAppUpdateNoticeToAllIos(): Promise<{ sent: number; failed: number }> {
  const subs = await prisma.pushSubscription.findMany({
    // A disabled account keeps its PushSubscription rows (guardrail 33 — the
    // deactivate write set is exactly two fields), so without this filter a
    // removed user would be told to update an app they can no longer sign
    // into. Guardrail 33's two notification chokepoints are keyed on a request,
    // and a broadcast has none, so the filter has to live on this query.
    where: { platform: "ios", user: { deactivatedAt: null } },
    include: WITH_LOCALE,
  });
  const payloadFor = localizedPayloads((t) => ({
    title: t("notify.push.apnsTitle.app_update"),
    body: t("notify.push.apnsBody.app_update"),
    url: "/",
    category: "app_update",
  }));
  // Bounded fan-out (guardrail 31): the device list scales with the user base,
  // so cap in-flight relay POSTs instead of bursting them all at once.
  const results = await settleLimit(subs, 8, (s) => sendApns(s, payloadFor(s.user)));
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === true) sent++;
    else failed++;
  }
  return { sent, failed };
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
  // Recipients are users whose permissions include MANAGE_REQUESTS (used for
  // new requests, deletion votes and manual *arr imports).
  const subs = await prisma.pushSubscription.findMany({
    // A disabled account keeps its PushSubscription rows (guardrail 33 — the
    // deactivate write set is exactly two fields), so its devices would keep
    // buzzing with other people's requests indefinitely.
    where: { user: { deactivatedAt: null }, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
    include: { user: { select: { role: true, permissions: true, locale: true } } },
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
      user: { notifyOnIssue: true, deactivatedAt: null }, // see getAdminSubscriptions
    },
    include: { user: { select: { role: true, permissions: true, locale: true } } },
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
    // 410 Gone / 404 Not Found: the browser revoked this subscription, so
    // delete it rather than keep sending to it.
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

// Builds the request deep link (/requests/<id>) for admin-facing notifications.
// An admin tapping "New request" needs the REQUEST — the approve/decline screen —
// not the title's detail page, which carries no queue action. Undefined when no
// request id is available, leaving that notification tab-level.
function requestDeepLink(requestId: string | null | undefined): string | undefined {
  if (!requestId) return undefined;
  return `/requests/${requestId}`;
}

export async function notifyAdminsNewRequestPush(data: {
  title: string;
  mediaType: string;
  tmdbId?: number;
  requestedBy: string;
  requestId?: string;
  excludeUserId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getAdminSubscriptions(data.excludeUserId);
    if (!subs.length) return;

    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => ({
      title: t("notify.push.newRequest.title", { media: mediaLabelT(t, data.mediaType) }),
      body: t("notify.push.newRequest.body", { title: resolve(data, locale), user: data.requestedBy }),
      url: "/admin",
      category: "new_request",
      deepLink: requestDeepLink(data.requestId),
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
  } catch (err) {
    console.error("[push] Failed to notify admins (request):", err);
  }
}

export async function notifyUserIssueMessagePush(data: {
  userId: string;
  title: string;
  tmdbId?: number;
  mediaType?: string;
  body: string;
  issueId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: data.userId, user: { notifyOnIssue: true } },
      include: WITH_LOCALE,
    });
    if (!subs.length) return;

    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => ({
      title: t("notify.push.userIssueMessage.title", { title: resolve(data, locale) }),
      body: data.body.length > 100 ? data.body.slice(0, 97) + "…" : data.body,
      url: data.issueId ? `/issues?selected=${data.issueId}` : "/issues",
      category: "issue_reply",
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
  } catch (err) {
    console.error("[push] Failed to notify user (issue message):", err);
  }
}

export async function notifyUserIssueResolvedPush(data: {
  userId: string;
  title: string;
  tmdbId?: number;
  mediaType?: string;
  resolution?: string | null;
  issueId?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: data.userId, user: { notifyOnIssue: true } },
      include: WITH_LOCALE,
    });
    if (!subs.length) return;

    const resolution = data.resolution?.trim();
    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => ({
      title: t("notify.push.issueResolved.title", { title: resolve(data, locale) }),
      body: resolution
        ? resolution.length > 100
          ? resolution.slice(0, 97) + "…"
          : resolution
        : t("notify.push.issueResolved.body"),
      url: data.issueId ? `/issues?selected=${data.issueId}` : "/issues",
      category: "issue_resolved",
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
  } catch (err) {
    console.error("[push] Failed to notify user (issue resolved):", err);
  }
}

export async function notifyAdminsIssueMessagePush(data: {
  title: string;
  tmdbId?: number;
  mediaType?: string;
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

    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => ({
      title: data.fromAdmin
        ? t("notify.push.adminIssueMessage.titleFromAdmin", { title: resolve(data, locale) })
        : t("notify.push.adminIssueMessage.title", { title: resolve(data, locale) }),
      body: `${data.userName}: ${data.body.length > 80 ? data.body.slice(0, 77) + "…" : data.body}`,
      url: data.issueId ? `/admin/issues?selected=${data.issueId}` : "/admin/issues",
      category: "issue_reply",
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
  } catch (err) {
    console.error("[push] Failed to notify admins (issue message):", err);
  }
}

// Result of the grab-complete push, read by the Radarr/Sonarr webhooks:
// - "delivered": at least one device got it.
// - "skipped-no-subs" / "skipped-no-keys": nothing could be sent (no devices,
//   push turned off, or only web devices and no VAPID keys). Retrying won't help.
// - "failed": a send was attempted and failed; the webhook retries later.
export type AdminGrabPushOutcome =
  | "delivered"
  | "skipped-no-subs"
  | "skipped-no-keys"
  | "failed";

export async function notifyAdminGrabCompletedPush(data: {
  userId: string;
  title: string;
  tmdbId?: number;
  mediaType?: string;
  scope: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  issueId: string;
}): Promise<AdminGrabPushOutcome> {
  try {
    const ctx = await pushContext();
    if (!ctx) return "skipped-no-keys";

    // deactivatedAt gate like getAdminSubscriptions/getIssueAdminSubscriptions
    // (guardrail 33): the triggering issue-admin may have been removed between
    // pressing Replace and the arr Download webhook firing — a disabled
    // account's surviving subscriptions must not be pinged.
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: data.userId, user: { deactivatedAt: null } },
      include: WITH_LOCALE,
    });
    if (!subs.length) return "skipped-no-subs";
    // Web devices need VAPID keys; iOS devices do not. With no keys and no iOS
    // device nothing can be sent, and reporting "failed" would make the webhook
    // retry forever.
    if (!ctx.keys && !subs.some((s) => s.platform === "ios")) return "skipped-no-keys";

    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => {
      let scopeLabel = "";
      if (data.scope === "EPISODE" && data.seasonNumber != null && data.episodeNumber != null) {
        scopeLabel = ` S${String(data.seasonNumber).padStart(2, "0")}E${String(data.episodeNumber).padStart(2, "0")}`;
      } else if (data.scope === "SEASON" && data.seasonNumber != null) {
        scopeLabel = ` ${t("notify.push.grab.season", { season: data.seasonNumber })}`;
      }
      return {
        title: t("notify.push.apnsTitle.grab_complete"),
        body: t("notify.push.grab.body", { title: resolve(data, locale), scope: scopeLabel }),
        url: `/issues?selected=${data.issueId}`,
        category: "grab_complete",
      };
    });

    const results = await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
    const anyDelivered = results.some((r) => r.status === "fulfilled" && r.value === true);
    return anyDelivered ? "delivered" : "failed";
  } catch (err) {
    console.error("[push] Failed to notify admin (grab completed):", err);
    return "failed";
  }
}

type RequestPushInfo = { title: string; mediaType: string; tmdbId?: number };

function approvedPayloads(r: RequestPushInfo, resolve: TitleResolver) {
  return localizedPayloads((t, locale) => ({
    title: t("notify.push.approved.title"),
    body: t("notify.push.approved.body", { media: mediaLabelT(t, r.mediaType), title: resolve(r, locale) }),
    url: "/requests",
    category: "approved",
    deepLink: mediaDeepLink(r.mediaType, r.tmdbId),
  }));
}

function declinedPayloads(r: RequestPushInfo, resolve: TitleResolver) {
  return localizedPayloads((t, locale) => ({
    title: t("notify.push.declined.title"),
    body: t("notify.push.declined.body", { media: mediaLabelT(t, r.mediaType), title: resolve(r, locale) }),
    url: "/requests",
    category: "declined",
    deepLink: mediaDeepLink(r.mediaType, r.tmdbId),
  }));
}

function availablePayloads(r: RequestPushInfo, resolve: TitleResolver) {
  return localizedPayloads((t, locale) => ({
    title: t("notify.push.available.title"),
    body: t("notify.push.available.body", { media: mediaLabelT(t, r.mediaType), title: resolve(r, locale) }),
    url: "/requests",
    category: "available",
    deepLink: mediaDeepLink(r.mediaType, r.tmdbId),
  }));
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
      select: { pushOnApproved: true, locale: true },
    });
    if (!user?.pushOnApproved) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const payload = approvedPayloads(data, await titleResolver([data], recipientLocales([user])))(user);

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
      select: { pushOnDeclined: true, locale: true },
    });
    if (!user?.pushOnDeclined) return;

    const subs = await prisma.pushSubscription.findMany({ where: { userId: data.userId } });
    if (!subs.length) return;

    const payload = declinedPayloads(data, await titleResolver([data], recipientLocales([user])))(user);

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
      select: { id: true, locale: true },
    });
    const eligibleIds = new Set(users.map((u) => u.id));
    const userById = new Map(users.map((u) => [u.id, u]));

    const eligible = requests.filter((r) => eligibleIds.has(r.requestedBy));
    if (!eligible.length) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: [...eligibleIds] } },
    });
    if (!subs.length) return;

    const resolve = await titleResolver(eligible, recipientLocales(users));
    const subsByUser = new Map<string, typeof subs>();
    for (const s of subs) {
      const arr = subsByUser.get(s.userId) ?? [];
      arr.push(s);
      subsByUser.set(s.userId, arr);
    }

    const jobs = eligible.flatMap((r) => {
      const userSubs = subsByUser.get(r.requestedBy) ?? [];
      if (!userSubs.length) return [];
      const payload = availablePayloads(r, resolve)(userById.get(r.requestedBy));
      // Send to every one of the user's devices, like the approved/declined pushes.
      return userSubs.map((s) => ({ sub: s, payload }));
    });
    // Bounded fan-out (guardrail 31): a large sync can flip a whole backlog to
    // available at once (requests × devices) — cap in-flight sends like the
    // APNs broadcast path.
    await settleLimit(jobs, 8, (j) => sendPush(ctx.keys, j.sub, j.payload));
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
      // deactivatedAt: null — account removal disables rather than scrubs
      // (guardrail 33), so a removed user keeps live push subscriptions and
      // would otherwise still get pinged by a later batch approve/decline.
      where: { id: { in: userIds }, pushOnApproved: true, deactivatedAt: null },
      select: { id: true, locale: true },
    });
    const eligibleIds = new Set(users.map((u) => u.id));
    const userById = new Map(users.map((u) => [u.id, u]));

    const eligible = requests.filter((r) => eligibleIds.has(r.requestedBy));
    if (!eligible.length) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: [...eligibleIds] } },
    });
    if (!subs.length) return;

    const resolve = await titleResolver(eligible, recipientLocales(users));
    const subsByUser = new Map<string, typeof subs>();
    for (const s of subs) {
      const arr = subsByUser.get(s.userId) ?? [];
      arr.push(s);
      subsByUser.set(s.userId, arr);
    }

    const jobs = eligible.flatMap((r) => {
      const userSubs = subsByUser.get(r.requestedBy) ?? [];
      const payload = approvedPayloads(r, resolve)(userById.get(r.requestedBy));
      return userSubs.map((s) => ({ sub: s, payload }));
    });
    // Bounded fan-out (guardrail 31): batch approvals fan out requests × devices.
    await settleLimit(jobs, 8, (j) => sendPush(ctx.keys, j.sub, j.payload));
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
      // deactivatedAt: null — see notifyUsersRequestsApprovedPush.
      where: { id: { in: userIds }, pushOnDeclined: true, deactivatedAt: null },
      select: { id: true, locale: true },
    });
    const eligibleIds = new Set(users.map((u) => u.id));
    const userById = new Map(users.map((u) => [u.id, u]));

    const eligible = requests.filter((r) => eligibleIds.has(r.requestedBy));
    if (!eligible.length) return;

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: [...eligibleIds] } },
    });
    if (!subs.length) return;

    const resolve = await titleResolver(eligible, recipientLocales(users));
    const subsByUser = new Map<string, typeof subs>();
    for (const s of subs) {
      const arr = subsByUser.get(s.userId) ?? [];
      arr.push(s);
      subsByUser.set(s.userId, arr);
    }

    const jobs = eligible.flatMap((r) => {
      const userSubs = subsByUser.get(r.requestedBy) ?? [];
      const payload = declinedPayloads(r, resolve)(userById.get(r.requestedBy));
      return userSubs.map((s) => ({ sub: s, payload }));
    });
    // Bounded fan-out (guardrail 31): batch declines fan out requests × devices.
    await settleLimit(jobs, 8, (j) => sendPush(ctx.keys, j.sub, j.payload));
  } catch (err) {
    console.error("[push] Failed to notify users (declined):", err);
  }
}

export async function notifyAdminsNewIssuePush(data: {
  title: string;
  tmdbId?: number;
  mediaType?: string;
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

    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => ({
      title: t("notify.push.newIssue.title"),
      body: t("notify.push.newIssue.body", { title: resolve(data, locale), issue: issueTypeLabelT(t, data.issueType), user: data.reportedBy }),
      url: data.issueId ? `/admin/issues?selected=${data.issueId}` : "/admin/issues",
      category: "new_issue",
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
  } catch (err) {
    console.error("[push] Failed to notify admins (issue):", err);
  }
}

// Radarr/Sonarr send ManualInteractionRequired when a downloaded release can't
// be imported automatically and waits in the queue for a person. This is a
// best-effort push telling admins to go sort it out.
// `instanceName` is the Radarr/Sonarr INSTANCE's display name (e.g. "Default",
// "4K", "Anime"), never the download client (e.g. "SABnzbd"): with several
// instances, the admin needs to know which queue to open.
export async function notifyAdminsManualInteractionRequiredPush(data: {
  service: "Radarr" | "Sonarr";
  title: string;
  instanceName?: string;
}) {
  try {
    const ctx = await pushContext();
    if (!ctx) return;

    const subs = await getAdminSubscriptions();
    if (!subs.length) return;

    const title = data.title.length > 100 ? data.title.slice(0, 97) + "…" : data.title;
    const name = data.instanceName?.trim();
    const where = name && name !== "Default" ? `${data.service} (${name})` : data.service;
    const payloadFor = localizedPayloads((t) => ({
      title: t("notify.push.manual.title", { where }),
      body: t("notify.push.manual.body", { title, where }),
      url: "/admin",
      category: "manual_interaction",
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
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

    const resolve = await titleResolver([data], recipientLocales(subs.map((s) => s.user)));
    const payloadFor = localizedPayloads((t, locale) => ({
      title: t("notify.push.deletionVote.title"),
      body: t("notify.push.deletionVote.body", {
        title: resolve(data, locale),
        media: mediaLabelT(t, data.mediaType),
        votes: String(data.voteCount),
      }),
      url: "/votes",
      category: "deletion_votes",
      deepLink: mediaDeepLink(data.mediaType, data.tmdbId),
    }));

    await Promise.allSettled(subs.map((s) => sendPush(ctx.keys, s, payloadFor(s.user))));
  } catch (err) {
    console.error("[push] Failed to notify admins (deletion vote):", err);
  }
}
