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
import { claimGrabAndQueuePush, deliverGrabPush, grabPushOf } from "./issue-grab-notify";
import { autoResolveIssueForGrab } from "./issue-auto-resolve";
import { confirmDeliveredGrabs } from "./arr-grab-confirm";
import { warnOnChange, forgetWarnOnChange } from "./log-dedup";
import { requestArrWatchRecount } from "./arr-watch-trigger";

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
    // The error's NAME only: a SyntaxError's message quotes a slice of the body.
    console.warn(`${scope} 400 invalid JSON (${err instanceof Error ? err.name : "error"})`);
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

  // A first, authenticated delivery means the download queue just changed:
  // ask for a monitor run so the admin nav's queue count follows it now, not
  // at the next scheduled tick. Coalesced and spaced (arr-watch-trigger.ts);
  // synchronous, never throws, never awaited.
  requestArrWatchRecount();

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
 * notifiedAt is the claim and is NEVER reset: the outbound agents
 * (ntfy/Gotify/webhook) fire once per grab, and the issue is auto-resolved
 * once. The admin's push is queued in the claim's own transaction
 * (issue-grab-notify.ts) and stays queued until the push service has answered,
 * so a push that failed — or a restart right after the claim — is sent by the
 * outbox drain instead of being lost. An already-claimed grab is ignored here:
 * whatever it still owes is the drain's.
 * Callers pass only grabs this delivery completed, already scoped to the
 * firing instance.
 *
 * The delivery itself proves nothing (the secret is the only auth), and the
 * claim is one-shot: it tells the admin the replacement landed and can close
 * the issue (guardrail 5j). So a grab is claimed only once the firing instance
 * confirms a file in the grab's scope added after the grab
 * (arr-grab-confirm.ts) — asked only when there is one to claim, so the
 * common delivery pays no extra call. A refuted grab stays pending for a later
 * delivery. Returned: the grabs the instance gave no usable answer for; the
 * routes try those once more after the library scan.
 */
export async function claimCompletedGrabs(
  grabs: IssueGrab[],
  service: ArrService,
  delivery: { arrInstance: string; tvdbId?: number | null },
): Promise<IssueGrab[]> {
  const unclaimed = grabs.filter((grab) => grab.notifiedAt === null);
  if (unclaimed.length === 0) return [];
  const scope = `[webhook/${service}]`;
  const now = new Date();
  const confirmation = await confirmDeliveredGrabs(service, delivery.arrInstance, unclaimed, { tvdbId: delivery.tvdbId });
  await Promise.all(
    unclaimed.map(async (grab) => {
      // Not confirmed by the instance: no claim, no emit, no auto-resolve.
      if (!confirmation.confirmed.has(grab.id)) return;
      // CAS: only one concurrent webhook claims the grab, and the claim queues
      // the push it owes in the same transaction.
      if (!(await claimGrabAndQueuePush(grab, now))) return;

      emitNotificationEvent({
        event: "arr.grab_completed",
        media: { type: grab.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: grab.tmdbId, title: grab.title },
        request: { instance: grab.arrInstance },
      });
      // The replacement landed, so close the issue (when enabled).
      void autoResolveIssueForGrab(grab, now);

      await deliverGrabPush(grab.id, grabPushOf(grab), scope);
    }),
  );
  return unclaimed.filter((grab) => confirmation.unverified.has(grab.id));
}

/**
 * The one later attempt at the grabs a delivery could not verify (the instance
 * gave no usable answer). Runs from the routes' after() work, once the library
 * scan has waited out the instance's queue. Never throws; still unverifiable
 * leaves them pending for a later delivery.
 */
export async function retryUnverifiedGrabs(
  grabs: IssueGrab[],
  service: ArrService,
  delivery: { arrInstance: string; tvdbId?: number | null },
): Promise<void> {
  if (grabs.length === 0) return;
  try {
    await claimCompletedGrabs(grabs, service, delivery);
  } catch (err) {
    console.warn(`[webhook/${service}] deferred grab claim failed:`, err instanceof Error ? err.message : err);
  }
}
