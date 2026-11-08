// The part of the Radarr and Sonarr webhooks that is the same for both: who is
// calling (guardrail 2), which instance fired (guardrail 32), the body caps,
// Test/Health, and the replay digest with its rollback. Each route keeps only
// its own event handling. Route files may export only HTTP handlers, so the
// shared code lives here.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "./prisma";
import type { IssueGrab } from "@/generated/prisma";
import { checkBodySize, readBodyBytesCapped } from "./body-size";
import { checkRateLimit, getClientIp, ipBucketKey } from "./rate-limit";
import { getArrInstances } from "./arr-instance-registry";
import { arrSettingKey, DEFAULT_ARR_INSTANCE, effectiveWebhookSecretFrom, LEGACY_WEBHOOK_SECRET_KEY, type ArrInstanceConfig, type ArrService } from "./arr-instances";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "./webhook-replay";
import { forwardArrHealthEvent } from "./arr-health-notify";
import { emitNotificationEvent } from "./notify-agents";
import { notifyAdminGrabCompletedPush } from "./push";
import { autoResolveIssueForGrab } from "./issue-auto-resolve";
import { warnOnChange, forgetWarnOnChange } from "./log-dedup";
import { processSingleton } from "./process-singleton";

const MAX_WEBHOOK_BYTES = 1_048_576;
const SERVICE_NAME: Record<ArrService, string> = { radarr: "Radarr", sonarr: "Sonarr" };

export interface ArrWebhookContext<P> {
  payload: P;
  /** The instance whose secret matched: every write the handler makes is scoped to it. */
  arrInstance: string;
  instances: ArrInstanceConfig[];
}

/**
 * Authenticate an arr webhook, then hand its event to `dispatch`.
 *
 * `compareSecret` is the SHA-256 + timingSafeEqual compare (guardrail 2),
 * safeCompareStrings called from the route's own handler, so the route audit
 * (scripts/audit-routes.mts), which never follows a guard into an import, can
 * see every webhook handler perform it.
 *
 * Test and Health events are answered here, before the replay digest. Every
 * other event is digest-recorded first (a repeat answers 409), and the digest
 * is rolled back ONLY when `dispatch` throws, so the arr's own retry can land.
 * Every answer `dispatch` returns keeps it — the 400 for an invalid id
 * included, since a retry of a bad payload can't help.
 */
// Every configured instance carries its own webhook secret (Setting key
// <service><Slug>WebhookSecret). The legacy shared `webhookSecret` remains the
// DEFAULT instance's ("") secret when it has no per-instance secret of its own.
async function loadInstanceSecrets(service: ArrService, instances: readonly ArrInstanceConfig[]): Promise<Array<{ slug: string; secret: string }>> {
  const [secretRows, legacyRow] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: instances.map((i) => arrSettingKey(service, i.slug, "WebhookSecret")) } },
    }),
    prisma.setting.findUnique({ where: { key: LEGACY_WEBHOOK_SECRET_KEY } }),
  ]);
  const secretByKey = new Map(secretRows.map((r) => [r.key, r.value ?? ""]));
  return instances.map((inst) => ({
    slug: inst.slug,
    secret: effectiveWebhookSecretFrom(inst.slug, secretByKey.get(arrSettingKey(service, inst.slug, "WebhookSecret")), legacyRow?.value),
  }));
}

export async function handleArrWebhook<P extends { eventType?: unknown }>(
  req: NextRequest,
  service: ArrService,
  compareSecret: (presented: string, secret: string) => boolean,
  dispatch: (ctx: ArrWebhookContext<P>) => Promise<NextResponse>,
): Promise<NextResponse> {
  const scope = `[webhook/${service}]`;
  const tooLarge = checkBodySize(req, MAX_WEBHOOK_BYTES);
  if (tooLarge) return tooLarge;

  const clientIp = getClientIp(req.headers);
  // 600/min (~10/s): a legitimate season-pack import fires one Download event
  // per episode, and 120/min rejected the tail of a large burst. Still bounds
  // the pre-auth cost (two Setting reads + a hash compare) per IP.
  if (!checkRateLimit(`webhook:${service}:${ipBucketKey(clientIp)}`, 600, 60_000)) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const instances = await getArrInstances(service);
  const instanceSecrets = await loadInstanceSecrets(service, instances);

  if (instanceSecrets.every((i) => i.secret.length === 0)) {
    console.warn(`${scope} secret not configured`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: the Radarr/Sonarr webhook UIs have no
  // Authorization header field (guardrail 2).
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  // Secret-as-discriminator: each instance is configured with its own webhook
  // secret, so the secret that matches tells us which instance fired. Compare the
  // presented token against EVERY instance secret with no early return (no timing
  // oracle). Guardrail 2: keep ?token= + the timing-safe compare; no HMAC.
  let matchedSlug: string | null = null;
  let secret = "";
  const matched: string[] = [];
  for (const inst of instanceSecrets) {
    const isMatch = token != null && inst.secret.length > 0 && compareSecret(token, inst.secret);
    if (!isMatch) continue;
    matched.push(inst.slug);
    // Equal-secret collision (misconfig): the DEFAULT instance ("") wins; otherwise
    // the first configured instance in registry order wins (getArrInstances lists
    // the default first, so keeping the first match already yields that ordering).
    if (matchedSlug === null || inst.slug === DEFAULT_ARR_INSTANCE) {
      matchedSlug = inst.slug;
      secret = inst.secret;
    }
  }
  if (!token || matchedSlug === null) {
    console.warn(`${scope} 401 unauthorized`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const arrInstance = matchedSlug;
  // One secret on several instances can't tell them apart: every event is
  // handled as the winner's. Said once per unchanged set, never refused (a
  // refusal would drop the default instance's events too).
  const sharedKey = `${scope}:shared-secret`;
  if (matched.length > 1) {
    const names = matched.map((slug) => slug || "default").join(", ");
    warnOnChange(sharedKey, names, `${scope} one webhook secret matches several instances (${names}); events are handled as "${arrInstance || "default"}" — give each instance its own secret`);
  } else {
    forgetWarnOnChange(sharedKey);
  }

  // Read at most one byte past the cap, never the whole body first.
  const rawBytes = await readBodyBytesCapped(req, MAX_WEBHOOK_BYTES);
  if (rawBytes === null) {
    console.warn(`${scope} 413 payload too large bytes>${MAX_WEBHOOK_BYTES}`);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  let payload: P;
  try {
    const parsed = JSON.parse(rawBody);
    // JSON.parse("null") / primitives / arrays are valid JSON but not a payload
    // object; guard so the eventType dereference below can't throw a 500.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    // Only the top level is checked here: each route narrows every field it
    // reads through its payload view (arr-webhook-payload.ts), never `P` itself.
    payload = parsed;
  } catch (err) {
    console.warn(`${scope} 400 invalid JSON:`, err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Test events have a fixed payload shape — admins clicking "Test" twice within
  // the 24h replay TTL would otherwise see the second click 409. Skip the digest
  // check and short-circuit before recording.
  if (payload.eventType === "Test") {
    return NextResponse.json({ ok: true, message: `${SERVICE_NAME[service]} webhook connected` });
  }

  // Health / HealthRestored are the same shape: a fixed per-issue payload
  // (level/message/type/wikiUrl — nothing per delivery). An indexer flapping
  // twice inside the 24h replay TTL would otherwise see its second identical
  // POST answered 409, and the arr then records Summonarr's notification as
  // failing and raises its own health warning. Acknowledge before the digest,
  // like Test; the only thing done with one is forwarding it to the admin's
  // notification channels (arr.health / arr.health_restored), which keeps its
  // own short dedupe window instead (arr-health-notify.ts). Every OTHER
  // unhandled eventType stays replay-recorded (the Grab pin in
  // tests/webhook-routes.test.mts): those payloads carry per-delivery fields,
  // so a byte-identical repeat IS a replay.
  if (payload.eventType === "Health" || payload.eventType === "HealthRestored") {
    const forwarded = forwardArrHealthEvent({
      service,
      instance: arrInstance,
      instanceName: arrInstance === DEFAULT_ARR_INSTANCE ? null : instances.find((i) => i.slug === arrInstance)?.name ?? arrInstance,
      eventType: payload.eventType,
      payload,
    });
    return NextResponse.json({ ok: true, health: true, forwarded });
  }

  // Canonical-JSON replay digest: a replay with reordered keys still produces the same digest.
  // A payload nested past the canonicaliser's depth cap is malformed, not a 500.
  let firstDelivery: boolean;
  try {
    firstDelivery = await checkAndRecordWebhookJson(service, secret, payload);
  } catch (err) {
    if (err instanceof Error && err.name === "WebhookPayloadTooDeep") {
      console.warn(`${scope} 400 payload nested too deeply`);
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    throw err;
  }
  if (!firstDelivery) {
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  // Pushes a failed delivery left for a later webhook, retried in the
  // background (throttled, never awaited, never failing this delivery).
  void retryPendingGrabPushes().catch((err: unknown) => {
    console.warn(`${scope} grab push retry sweep failed:`, err instanceof Error ? err.message : err);
  });

  try {
    return await dispatch({ payload, arrInstance, instances });
  } catch (err) {
    // The handler failed: roll the digest back so the arr's source-side retry
    // can re-deliver. Over the SAME parsed object that was recorded.
    await clearWebhookReplayDigestJson(service, secret, payload);
    throw err;
  }
}


/**
 * Claim the issue grabs a Download completed and tell the admin who fired them.
 *
 * notifiedAt is the outbound-emit claim and is NEVER reset: ntfy/Gotify/
 * NotificationAgent fire once per grab. Web push may still fail after that; a
 * Setting `grabPushRetry:<id>` lets the next Download retry the push without
 * re-opening the emit (unclaiming notifiedAt used to re-fire the agents).
 * Callers pass only grabs this delivery completed, already scoped to the
 * firing instance.
 */
export async function claimCompletedGrabs(grabs: IssueGrab[], service: ArrService): Promise<void> {
  if (grabs.length === 0) return;
  const scope = `[webhook/${service}]`;
  const now = new Date();
  await Promise.all(
    grabs.map(async (grab) => {
      const retryKey = grabPushRetryKey(grab.id);
      if (grab.notifiedAt !== null) {
        // Already emitted. Consume the push-retry marker (CAS): a 0 count
        // means no pending retry, or another delivery already took it.
        const taken = await prisma.setting.deleteMany({ where: { key: { in: [retryKey] } } });
        if (taken.count === 0) return;
      } else {
        // CAS: ensure only one concurrent webhook fires the notification for this grab
        const claimed = await prisma.issueGrab.updateMany({
          where: { id: grab.id, notifiedAt: null },
          data: { notifiedAt: now },
        });
        if (claimed.count === 0) return;

        emitNotificationEvent({
          event: "arr.grab_completed",
          media: { type: grab.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: grab.tmdbId, title: grab.title },
          request: { instance: grab.arrInstance },
        });
        // First claim only: the replacement landed, so close the issue (when enabled).
        void autoResolveIssueForGrab(grab, now);
      }

      const outcome = await notifyAdminGrabCompletedPush(grabPushOf(grab));
      // "failed" → keep notifiedAt (emit stays claimed) and record a push-only
      // retry. "skipped-no-subs" / "skipped-no-keys" → leave notifiedAt set
      // (retrying won't help: the admin has no push subscription or keys set
      // up), but log so an operator can wire up an email/Discord backstop.
      // "skipped-disabled" → push is switched off for the deployment: nothing
      // to retry and nothing to log. "delivered" → done.
      if (outcome === "failed") {
        await prisma.setting.createMany({
          data: [{ key: retryKey, value: now.toISOString() }],
          skipDuplicates: true,
        });
        console.warn(`${scope} grab notification failed, will retry push`);
      } else if (outcome === "skipped-no-subs" || outcome === "skipped-no-keys") {
        console.warn(`${scope} grab push skipped (${outcome}) for user=${grab.triggeredById} issue=${grab.issueId}`);
      }
    }),
  );
}

const GRAB_PUSH_RETRY_PREFIX = "grabPushRetry:";
const grabPushRetryKey = (grabId: string) => `${GRAB_PUSH_RETRY_PREFIX}${grabId}`;

type GrabPushFields = Pick<IssueGrab, "triggeredById" | "title" | "tmdbId" | "mediaType" | "scope" | "seasonNumber" | "episodeNumber" | "issueId">;
const grabPushOf = (grab: GrabPushFields): Parameters<typeof notifyAdminGrabCompletedPush>[0] => ({
  userId: grab.triggeredById,
  title: grab.title,
  tmdbId: grab.tmdbId,
  mediaType: grab.mediaType,
  scope: grab.scope,
  seasonNumber: grab.seasonNumber,
  episodeNumber: grab.episodeNumber,
  issueId: grab.issueId,
});

/** A retry marker is retried only once it is this old: a fresh one belongs to the delivery that wrote it. */
export const GRAB_PUSH_RETRY_MIN_AGE_MS = 10 * 60_000;
/** Past this a push no longer helps (the grab is old news): the marker is dropped unsent. */
export const GRAB_PUSH_RETRY_TTL_MS = 24 * 60 * 60_000;
/** The sweep runs at most this often per process. */
export const GRAB_PUSH_RETRY_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_GRAB_PUSH_RETRIES_PER_SWEEP = 20;

const grabPushSweep = processSingleton("arr-webhook:grabPushSweep", () => ({ lastAt: Number.NEGATIVE_INFINITY }));

/**
 * Retry the web pushes a failed delivery left as `grabPushRetry:<grabId>`.
 * Before this only a later Download for the SAME title retried one, and the
 * first claim usually resolved the issue, so the marker stayed forever. Each
 * marker is claimed by deleting it (a count of 0 means another delivery took
 * it), the push is retried once, and a push that fails again writes the marker
 * back with its ORIGINAL time, so the TTL counts from the first failure. The
 * emit (notifiedAt) is never touched. Throttled per process unless `force`.
 */
export async function retryPendingGrabPushes(opts: {
  now?: Date;
  force?: boolean;
  push?: typeof notifyAdminGrabCompletedPush;
} = {}): Promise<{ retried: number; expired: number }> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const out = { retried: 0, expired: 0 };
  if (!opts.force && nowMs - grabPushSweep.lastAt < GRAB_PUSH_RETRY_SWEEP_INTERVAL_MS) return out;
  grabPushSweep.lastAt = nowMs;
  const push = opts.push ?? notifyAdminGrabCompletedPush;
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: GRAB_PUSH_RETRY_PREFIX } },
    select: { key: true, value: true },
    take: MAX_GRAB_PUSH_RETRIES_PER_SWEEP,
  });
  for (const row of rows) {
    if (!row.key.startsWith(GRAB_PUSH_RETRY_PREFIX)) continue;
    const at = Date.parse(row.value ?? "");
    const age = Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
    if (age < GRAB_PUSH_RETRY_MIN_AGE_MS) continue;
    const taken = await prisma.setting.deleteMany({ where: { key: { in: [row.key] } } });
    if (taken.count === 0) continue;
    if (age > GRAB_PUSH_RETRY_TTL_MS) {
      out.expired++;
      continue;
    }
    const grab = await prisma.issueGrab.findUnique({ where: { id: row.key.slice(GRAB_PUSH_RETRY_PREFIX.length) } });
    if (!grab) continue;
    out.retried++;
    if ((await push(grabPushOf(grab))) === "failed") {
      await prisma.setting.createMany({ data: [{ key: row.key, value: row.value ?? now.toISOString() }], skipDuplicates: true });
    }
  }
  return out;
}

/** Test seam: let the next sweep run at once. */
export function _resetGrabPushSweepForTests(): void {
  grabPushSweep.lastAt = Number.NEGATIVE_INFINITY;
}
