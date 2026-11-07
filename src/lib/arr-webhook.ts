// The part of the Radarr and Sonarr webhooks that is the same for both: who is
// calling (guardrail 2), which instance fired (guardrail 32), the body caps,
// Test/Health, and the replay digest with its rollback. Each route keeps only
// its own event handling. Route files may export only HTTP handlers, so the
// shared code lives here.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "./prisma";
import type { IssueGrab } from "@/generated/prisma";
import { checkBodySize } from "./body-size";
import { checkRateLimit, getClientIp, ipBucketKey } from "./rate-limit";
import { getArrInstances } from "./arr-instance-registry";
import { arrSettingKey, DEFAULT_ARR_INSTANCE, type ArrInstanceConfig, type ArrService } from "./arr-instances";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "./webhook-replay";
import { forwardArrHealthEvent } from "./arr-health-notify";
import { emitNotificationEvent } from "./notify-agents";
import { notifyAdminGrabCompletedPush } from "./push";
import { autoResolveIssueForGrab } from "./issue-auto-resolve";

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
 * `compareSecret` is the route's own SHA-256 + timingSafeEqual compare
 * (guardrail 2). It stays in the route file so the route audit
 * (scripts/audit-routes.mts), which never follows a guard into an import, can
 * see every webhook handler perform it.
 *
 * Test and Health events are answered here, before the replay digest. Every
 * other event is digest-recorded first (a repeat answers 409), and the digest
 * is rolled back ONLY when `dispatch` throws, so the arr's own retry can land.
 * Every answer `dispatch` returns keeps it — the 400 for an invalid id
 * included, since a retry of a bad payload can't help.
 */
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

  // Every configured instance carries its own webhook secret (Setting key
  // <service><Slug>WebhookSecret). The legacy shared `webhookSecret` remains the
  // DEFAULT instance's ("") secret when it has no per-instance secret of its own.
  const instances = await getArrInstances(service);
  const [secretRows, legacyRow] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: instances.map((i) => arrSettingKey(service, i.slug, "WebhookSecret")) } },
    }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const secretByKey = new Map(secretRows.map((r) => [r.key, r.value ?? ""]));
  const instanceSecrets = instances.map((inst) => {
    const own = secretByKey.get(arrSettingKey(service, inst.slug, "WebhookSecret")) || "";
    const secret = own || (inst.slug === DEFAULT_ARR_INSTANCE ? legacyRow?.value || "" : "");
    return { slug: inst.slug, secret };
  });

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
  for (const inst of instanceSecrets) {
    const isMatch = token != null && inst.secret.length > 0 && compareSecret(token, inst.secret);
    if (!isMatch) continue;
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

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > MAX_WEBHOOK_BYTES) {
    console.warn(`${scope} 413 payload too large bytes=${rawBytes.length}`);
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
      const retryKey = `grabPushRetry:${grab.id}`;
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

      const outcome = await notifyAdminGrabCompletedPush({
        userId: grab.triggeredById,
        title: grab.title,
        tmdbId: grab.tmdbId,
        mediaType: grab.mediaType,
        scope: grab.scope,
        seasonNumber: grab.seasonNumber,
        episodeNumber: grab.episodeNumber,
        issueId: grab.issueId,
      });
      // "failed" → keep notifiedAt (emit stays claimed) and record a push-only
      // retry. "skipped-no-subs" / "skipped-no-keys" → leave notifiedAt set
      // (retrying won't help: the admin has no push subscription or keys set
      // up), but log so an operator can wire up an email/Discord backstop.
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
