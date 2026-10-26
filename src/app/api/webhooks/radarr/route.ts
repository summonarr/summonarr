import { NextRequest, NextResponse, after } from "next/server";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { CLAIMABLE_GRAB_ISSUE } from "@/lib/issue-grab";
import { notifyAdminGrabCompletedPush, notifyAdminsManualInteractionRequiredPush } from "@/lib/push";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "@/lib/webhook-replay";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIp, ipBucketKey } from "@/lib/rate-limit";
import { isMovieDownloadedInRadarr } from "@/lib/arr";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { arrSettingKey, DEFAULT_ARR_INSTANCE } from "@/lib/arr-instances";
import { sanitizeForLog } from "@/lib/sanitize";
import { forwardArrHealthEvent } from "@/lib/arr-health-notify";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface RadarrWebhookPayload {
  eventType: string;
  movie?: {
    tmdbId: number;
    title: string;
  };
  // MovieFileDelete only — Radarr's DeleteMediaFileReason, camelCased by its
  // serializer ("upgrade" when the file is being replaced by a better one).
  deleteReason?: string;
}

export async function POST(req: NextRequest) {
  const tooLarge = checkBodySize(req, 1_048_576);
  if (tooLarge) return tooLarge;

  const clientIp = getClientIp(req.headers);
  // 600/min (~10/s): a legitimate season-pack import fires one Download event
  // per episode, and 120/min rejected the tail of a large burst. Still bounds
  // the pre-auth cost (two Setting reads + a hash compare) per IP.
  if (!checkRateLimit(`webhook:radarr:${ipBucketKey(clientIp)}`, 600, 60_000)) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  // Every configured instance carries its own webhook secret (Setting key
  // radarr<Slug>WebhookSecret). The legacy shared `webhookSecret` remains the
  // DEFAULT instance's ("") secret when it has no per-instance secret of its own.
  const instances = await getArrInstances("radarr");
  const [secretRows, legacyRow] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: instances.map((i) => arrSettingKey("radarr", i.slug, "WebhookSecret")) } },
    }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const secretByKey = new Map(secretRows.map((r) => [r.key, r.value ?? ""]));
  const instanceSecrets = instances.map((inst) => {
    const own = secretByKey.get(arrSettingKey("radarr", inst.slug, "WebhookSecret")) || "";
    const secret = own || (inst.slug === DEFAULT_ARR_INSTANCE ? legacyRow?.value || "" : "");
    return { slug: inst.slug, secret };
  });

  if (instanceSecrets.every((i) => i.secret.length === 0)) {
    console.warn("[webhook/radarr] secret not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Radarr webhook UI has no Authorization header field
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
    const isMatch = token != null && inst.secret.length > 0 && safeCompare(token, inst.secret);
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
    console.warn("[webhook/radarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const arrInstance = matchedSlug;

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > 1_048_576) {
    console.warn(`[webhook/radarr] 413 payload too large bytes=${rawBytes.length}`);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  let payload: RadarrWebhookPayload;
  try {
    const parsed = JSON.parse(rawBody);
    // JSON.parse("null") / primitives / arrays are valid JSON but not a payload
    // object; guard so the eventType dereference below can't throw a 500.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    payload = parsed;
  } catch (err) {
    console.warn("[webhook/radarr] 400 invalid JSON:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Test events have a fixed payload shape — admins clicking "Test" twice within
  // the 24h replay TTL would otherwise see the second click 409. Skip the digest
  // check and short-circuit before recording.
  if (payload.eventType === "Test") {
    return NextResponse.json({ ok: true, message: "Radarr webhook connected" });
  }

  // Health / HealthRestored are the same shape: a fixed per-issue payload
  // (level/message/type/wikiUrl — nothing per delivery). An indexer flapping
  // twice inside the 24h replay TTL would otherwise see its second identical
  // POST answered 409, and Radarr then records Summonarr's notification as
  // failing and raises its own health warning. Acknowledge before the digest,
  // like Test; the only thing done with one is forwarding it to the admin's
  // notification channels (arr.health / arr.health_restored), which keeps its
  // own short dedupe window instead (arr-health-notify.ts). Every OTHER
  // unhandled eventType stays replay-recorded (the Grab pin in
  // tests/webhook-routes.test.mts): those payloads carry per-delivery fields,
  // so a byte-identical repeat IS a replay.
  if (payload.eventType === "Health" || payload.eventType === "HealthRestored") {
    const forwarded = forwardArrHealthEvent({
      service: "radarr",
      instance: arrInstance,
      instanceName: arrInstance === DEFAULT_ARR_INSTANCE ? null : instances.find((i) => i.slug === arrInstance)?.name ?? arrInstance,
      eventType: payload.eventType,
      payload,
    });
    return NextResponse.json({ ok: true, health: true, forwarded });
  }

  // Canonical-JSON replay digest: a replay with reordered keys still produces the same digest
  if (!await checkAndRecordWebhookJson("radarr", secret, payload)) {
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  // Track whether the synchronous body completed; if it throws we roll back the
  // replay digest so Radarr's source-side retry can re-deliver.
  let syncCompleted = false;
  try {

  // Radarr fires ManualInteractionRequired when a grabbed release can't be imported
  // automatically (mismatch, sample, etc.) and is parked in the queue. There's nothing to
  // mark available — alert admins (best-effort) so they can resolve it in Radarr's queue.
  if (payload.eventType === "ManualInteractionRequired") {
    const title = payload.movie?.title ?? "A movie";
    // Don't interpolate the payload-supplied title into the log line. It's a
    // remote-controlled string, and logging it verbatim is a log-injection vector:
    // an attacker could embed newlines/control characters to forge or corrupt log
    // entries. The title still reaches admins through the structured push below,
    // which doesn't share the log's plain-text framing.
    console.warn("[webhook/radarr] manual interaction required — resolve it in Radarr's queue");
    // Per-item one-shot gate (same idempotent pattern as the deletion-vote
    // threshold in /api/votes): Radarr re-emits ManualInteractionRequired for the
    // same parked release on every queue tick (changing queue id / progress), and
    // the replay digest hashes the full payload so each one passes — push exactly
    // once per stuck item. Key on the STABLE tmdbId + service, never the volatile
    // queue id/progress. ISO value lets the marker be pruned later.
    // No usable tmdbId → fail closed (no notify). A shouldNotify=true fallback
    // re-fires on every queue tick: replay hashes the whole payload, and these
    // events change queue id/progress each time.
    const stableTmdbId = payload.movie?.tmdbId;
    let shouldNotify = false;
    if (isTmdbIdInRange(stableTmdbId as number)) {
      const manualKey = `manualInteractionNotified:radarr:${arrInstance}:${stableTmdbId}`;
      const claim = await prisma.setting.createMany({
        data: [{ key: manualKey, value: new Date().toISOString() }],
        skipDuplicates: true,
      });
      shouldNotify = claim.count === 1;
    }
    if (shouldNotify) {
      after(async () => {
        emitNotificationEvent({ event: "arr.manual_interaction", text: `Radarr: ${title}`, request: { instance: arrInstance } });
        await notifyAdminsManualInteractionRequiredPush({ service: "Radarr", title, instanceName: instances.find((i) => i.slug === arrInstance)?.name })
          .catch((err) => console.warn("[webhook/radarr] manual-interaction alert failed:", err));
        // Bound the one-shot marker table: a Setting row is inserted per distinct stuck
        // movie and never removed. The identical prune lives in the Sonarr twin, but it
        // only runs on a Sonarr fresh claim — a Radarr-only deployment (or one whose
        // Sonarr never parks an import) never fires it, so these rows grew for the life
        // of the install. Prefix-scoped, so whichever service is deployed cleans both.
        // ISO-8601 values sort lexically = chronologically; an item still stuck past the
        // 30d window simply re-notifies. Chained onto the push's task rather than a second
        // after() so a fresh claim still schedules exactly one deferred unit of work.
        await prisma.setting
          .deleteMany({
            where: {
              key: { startsWith: "manualInteractionNotified:" },
              value: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
            },
          })
          .catch((err) => console.warn("[webhook/radarr] manual-interaction marker prune failed:", err));
      });
    }
    syncCompleted = true;
    return NextResponse.json({ ok: true, manualInteraction: true });
  }

  // Radarr removed the movie (MovieDelete) or its file (MovieFileDelete): the
  // wanted/available cache rows describing it are stale until the next full
  // sync (up to SYNC_INTERVAL), and during that window a re-request of the
  // title is swallowed as { alreadyAvailable: true } with no request row
  // created. Evict the cache rows now, under the same advisory lock the sync
  // writer takes. MediaRequest.status and notifiedAvailable stay untouched —
  // the orchestrator's CAS remains the sole authority (guardrail 14).
  //
  // A file delete leaves the movie IN Radarr, without a file — exactly what the
  // sync records as wanted (`!hasFile`). So it moves the row to wanted rather
  // than dropping it: with neither row the synced cache says this instance
  // doesn't hold the movie, and the detail page offers "Add to" and the Issues
  // row loses its Manage icon until the next sync — right after an issue's
  // Replace file, when the admin is following the replacement.
  if (payload.eventType === "MovieDelete" || payload.eventType === "MovieFileDelete") {
    const delTmdbId = payload.movie?.tmdbId;
    // A file deleted FOR AN UPGRADE is transient — the replacement import is
    // already underway; evicting availability would just flicker the badge.
    const isUpgrade = payload.eventType === "MovieFileDelete" && payload.deleteReason === "upgrade";
    if (isTmdbIdInRange(delTmdbId as number) && !isUpgrade) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
        if (payload.eventType === "MovieDelete") {
          await tx.radarrWantedItem.deleteMany({ where: { tmdbId: delTmdbId as number, arrInstance } });
        }
        await tx.radarrAvailableItem.deleteMany({ where: { tmdbId: delTmdbId as number, arrInstance } });
        if (payload.eventType === "MovieFileDelete") {
          // skipDuplicates: a row already there is no error, so nothing aborts this tx (guardrail 23).
          await tx.radarrWantedItem.createMany({ data: [{ tmdbId: delTmdbId as number, arrInstance }], skipDuplicates: true });
        }
      }, { timeout: 30_000 });
    }
    syncCompleted = true;
    return NextResponse.json({ ok: true, evicted: !isUpgrade });
  }

  if (payload.eventType !== "Download" || !payload.movie?.tmdbId) {
    syncCompleted = true;
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tmdbId } = payload.movie;
  if (!isTmdbIdInRange(tmdbId)) {
    console.warn("[webhook/radarr] 400 invalid tmdbId");
    syncCompleted = true;  // Bad payload from Radarr; retry won't help.
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }

  // Never trust the payload's tmdbId on its own. The webhook secret authenticates
  // the request but does NOT prove the named title was actually downloaded: anyone
  // who learns the secret (or any process that can replay a captured request) could
  // POST a forged Download event for an arbitrary tmdbId and flip an APPROVED
  // request straight to AVAILABLE for a movie Radarr never grabbed. To close that,
  // verify the title against Radarr's own authoritative API before changing any
  // status. Tri-state result: `false` = Radarr is reachable and confirms there is
  // NO file, so we SKIP the flip (this is the forgery case we reject); `true` =
  // confirmed downloaded, proceed; `null` = we couldn't determine it (the firing
  // instance isn't configured, or Radarr is unreachable) so we proceed optimistically
  // and let the periodic library sync reconcile availability later. Proceeding on
  // null is safe against forgery because an attacker cannot force a null result
  // without first breaking the operator's own Radarr connectivity.
  const downloaded = await isMovieDownloadedInRadarr(tmdbId, arrInstance);
  if (downloaded === false) {
    console.warn("[webhook/radarr] Download event for tmdbId=%s not confirmed downloaded in Radarr; skipping status flip.", sanitizeForLog(tmdbId));
    syncCompleted = true;
    return NextResponse.json({ ok: true, skipped: true, reason: "not_downloaded" });
  }

  // Advisory lock 1001,1 prevents a concurrent Radarr sync from overwriting the wanted table mid-transaction
  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
    // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
    // One UPDATE covers both a fresh approval (availableAt null) and a re-push of
    // an already-available title — the two used to differ only in a
    // notifiedAvailable write that guardrail 14 removed.
    updated = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", arrInstance, status: "APPROVED" },
      // Clear the approve-time 90s backstop: the item is downloaded, so a stale
      // timer would fire a false "download pending" if a later sync revert flips
      // this back to APPROVED.
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
    });
    await tx.radarrWantedItem.deleteMany({ where: { tmdbId, arrInstance } });
    // Radarr CONFIRMED the file (never on the unverifiable null path — a forged
    // payload would otherwise make re-requests of the title read "already
    // available"): the movie is available on this instance now, not absent from
    // both caches until the next sync.
    if (downloaded === true) {
      await tx.radarrAvailableItem.createMany({ data: [{ tmdbId, arrInstance }], skipDuplicates: true });
    }
  }, { timeout: 30_000 });

  if (updated.count > 0) {
    void clearDeletionVotesForTmdbs([{ tmdbId, mediaType: "MOVIE" }]);
  }

  // A completed import ends the "stuck" episode the ManualInteractionRequired
  // marker one-shots — clear it so a FUTURE re-park of the same title can alert
  // again (the marker otherwise only ages out via the 30-day prune).
  // Post-commit fire-and-forget, idempotent; placed after the
  // downloaded===false early return so a refuted forgery never clears it.
  void prisma.setting.deleteMany({
    where: { key: { in: [`manualInteractionNotified:radarr:${arrInstance}:${tmdbId}`] } },
  }).catch(() => {});

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("movie", tmdbId, arrInstance);

    // Scope by arrInstance to the instance that fired this webhook: one instance's
    // Download must not sweep in a sibling instance's request and notify it off the
    // wrong grab.
    // `arrInstance` is selected, not taken from the handler's scope: the rows ARE
    // the instance's own (the where scopes them), and the outbound event reads
    // the slug off each winner row (guardrail 32).
    const pending = await prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType: "MOVIE", arrInstance, status: "AVAILABLE", notifiedAvailable: false },
      select: { id: true, requestedBy: true, title: true, mediaType: true, posterPath: true, tmdbId: true, arrInstance: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const [plexConfig, jellyfinConfig] = await Promise.all([
      getPlexConfig(),
      getJellyfinConfig(),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexConfig.url && plexConfig.token
        ? () => hasPlexItemByTmdbId(plexConfig.url!, plexConfig.token!, tmdbId, "movie")
        : null,
      jellyfinConfig.url && jellyfinConfig.apiKey
        ? () => hasJellyfinItemByTmdbId(jellyfinConfig.url!, jellyfinConfig.apiKey!, tmdbId, "movie")
        : null,
      "webhook/radarr",
    ).catch((err) => { console.warn("[webhooks/radarr] notification failed after marking AVAILABLE:", err); });
  });

  // arrInstance-scoped: one instance's Download must not claim (and notify off)
  // a grab that was fired at a sibling instance. A RESOLVED issue's grab is never
  // claimed: a replacement that found nothing would otherwise be announced by an
  // unrelated import months later (CLAIMABLE_GRAB_ISSUE).
  //
  // notifiedAt is the outbound-emit claim and is NEVER reset: ntfy/Gotify/
  // NotificationAgent fire once per grab. Web push may still fail after that; a
  // Setting `grabPushRetry:<id>` lets the next Download retry the push without
  // re-opening the emit (unclaiming notifiedAt used to re-fire the agents).
  const candidateGrabs = await prisma.issueGrab.findMany({
    where: { tmdbId, mediaType: "MOVIE", arrInstance, issue: CLAIMABLE_GRAB_ISSUE },
  });
  if (candidateGrabs.length > 0) {
    const now = new Date();
    await Promise.all(
      candidateGrabs.map(async (grab) => {
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
          console.warn("[webhook/radarr] grab notification failed, will retry push");
        } else if (outcome === "skipped-no-subs" || outcome === "skipped-no-keys") {
          console.warn(`[webhook/radarr] grab push skipped (${outcome}) for user=${grab.triggeredById} issue=${grab.issueId}`);
        }
      })
    );
  }

  syncCompleted = true;
  return NextResponse.json({ ok: true, marked: updated.count });
  } finally {
    if (!syncCompleted) {
      await clearWebhookReplayDigestJson("radarr", secret, payload);
    }
  }
}
