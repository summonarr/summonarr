import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notifyAdminGrabCompletedPush, notifyAdminsManualInteractionRequiredPush } from "@/lib/push";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "@/lib/webhook-replay";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { sanitizeForLog } from "@/lib/sanitize";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isSeriesDownloadedInSonarr, resolveSingleTvdbToTmdb } from "@/lib/arr";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { arrSettingKey, DEFAULT_ARR_INSTANCE } from "@/lib/arr-instances";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface SonarrWebhookPayload {
  eventType: string;
  series?: {
    tvdbId: number;
    tmdbId?: number;
    title: string;
  };
  episodes?: Array<{ seasonNumber?: number; episodeNumber?: number }>;
  downloadClient?: string;
}

export async function POST(req: NextRequest) {
  const tooLarge = checkBodySize(req, 1_048_576);
  if (tooLarge) return tooLarge;

  const clientIp = getClientIp(req.headers);
  if (!checkRateLimit(`webhook:sonarr:${clientIp}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  // Every configured instance carries its own webhook secret (Setting key
  // sonarr<Slug>WebhookSecret). The legacy shared `webhookSecret` remains the
  // DEFAULT instance's ("") secret when it has no per-instance secret of its own.
  const instances = await getArrInstances("sonarr");
  const [secretRows, legacyRow] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: instances.map((i) => arrSettingKey("sonarr", i.slug, "WebhookSecret")) } },
    }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const secretByKey = new Map(secretRows.map((r) => [r.key, r.value ?? ""]));
  const instanceSecrets = instances.map((inst) => {
    const own = secretByKey.get(arrSettingKey("sonarr", inst.slug, "WebhookSecret")) || "";
    const secret = own || (inst.slug === DEFAULT_ARR_INSTANCE ? legacyRow?.value || "" : "");
    return { slug: inst.slug, secret };
  });

  if (instanceSecrets.every((i) => i.secret.length === 0)) {
    console.warn("[webhook/sonarr] secret not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Sonarr webhook UI has no Authorization header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  // Secret-as-discriminator (see webhooks/radarr): each instance is configured with
  // its own webhook secret, so the matching secret selects the instance that fired.
  // Compare against EVERY instance secret with no early return (no timing oracle).
  // Guardrail 2: keep ?token= + the timing-safe compare; no HMAC.
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
    console.warn("[webhook/sonarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const arrInstance = matchedSlug;

  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.length > 1_048_576) {
    console.warn(`[webhook/sonarr] 413 payload too large bytes=${rawBytes.length}`);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = new TextDecoder().decode(rawBytes);

  let payload: SonarrWebhookPayload;
  try {
    const parsed = JSON.parse(rawBody);
    // JSON.parse("null") / primitives / arrays are valid JSON but not a payload
    // object; guard so the eventType dereference below can't throw a 500.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    payload = parsed;
  } catch (err) {
    console.warn("[webhook/sonarr] 400 invalid JSON:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Test events have a fixed payload shape — admins clicking "Test" twice within
  // the 24h replay TTL would otherwise see the second click 409. Skip the digest
  // check and short-circuit before recording.
  if (payload.eventType === "Test") {
    return NextResponse.json({ ok: true, message: "Sonarr webhook connected" });
  }

  // Canonical-JSON replay digest: a replay with reordered keys still produces the same digest
  if (!await checkAndRecordWebhookJson("sonarr", secret, payload)) {
    return NextResponse.json({ error: "Replayed webhook" }, { status: 409 });
  }

  // Track whether the synchronous body completed; if it throws we roll back the
  // replay digest so Sonarr's source-side retry can re-deliver.
  let syncCompleted = false;
  try {

  // Sonarr fires ManualInteractionRequired when a grabbed release can't be imported
  // automatically and is parked in the queue. There's nothing to mark available — alert admins
  // (best-effort) so they can resolve it in Sonarr's queue.
  if (payload.eventType === "ManualInteractionRequired") {
    const seriesTitle = payload.series?.title ?? "A series";
    const eps = payload.episodes ?? [];
    let scope = "";
    if (eps.length === 1 && eps[0].seasonNumber != null && eps[0].episodeNumber != null) {
      scope = ` S${String(eps[0].seasonNumber).padStart(2, "0")}E${String(eps[0].episodeNumber).padStart(2, "0")}`;
    } else if (eps.length > 1) {
      scope = ` (${eps.length} episodes)`;
    }
    const title = `${seriesTitle}${scope}`;
    // Don't interpolate the payload-supplied series title into the log line. It's a
    // remote-controlled string, and logging it verbatim is a log-injection vector:
    // an attacker could embed newlines/control characters to forge or corrupt log
    // entries. The title still reaches admins through the structured push below,
    // which doesn't share the log's plain-text framing.
    console.warn("[webhook/sonarr] manual interaction required — resolve it in Sonarr's queue");
    // Per-item one-shot gate (same idempotent pattern as the deletion-vote
    // threshold in /api/votes): Sonarr re-emits ManualInteractionRequired for the
    // same parked release on every queue tick (changing queue id / progress), and
    // the replay digest hashes the full payload so each one passes — push exactly
    // once per stuck series. Key on the STABLE series id (tvdbId, falling back to
    // tmdbId) + service, never the volatile queue id/progress. ISO value lets the
    // marker be pruned later.
    const stableSeriesId =
      Number.isInteger(payload.series?.tvdbId) && (payload.series!.tvdbId as number) > 0
        ? payload.series!.tvdbId
        : Number.isInteger(payload.series?.tmdbId) && (payload.series!.tmdbId as number) > 0
        ? payload.series!.tmdbId
        : null;
    let shouldNotify = true;
    if (stableSeriesId !== null) {
      const manualKey = `manualInteractionNotified:sonarr:${arrInstance}:${stableSeriesId}`;
      const claim = await prisma.setting.createMany({
        data: [{ key: manualKey, value: new Date().toISOString() }],
        skipDuplicates: true,
      });
      shouldNotify = claim.count === 1;
    }
    if (shouldNotify) {
      after(() =>
        notifyAdminsManualInteractionRequiredPush({ service: "Sonarr", title, detail: payload.downloadClient })
          .catch((err) => console.warn("[webhook/sonarr] manual-interaction alert failed:", err)),
      );
      // Bound the one-shot marker table: a Setting row is inserted per distinct
      // stuck series and never removed. Prune markers older than 30 days — ISO-8601
      // values sort lexically = chronologically. A series still stuck past the
      // window simply re-notifies, which is acceptable. Runs only on a fresh claim
      // (when the table actually grew), so it stays naturally infrequent.
      after(() =>
        prisma.setting
          .deleteMany({
            where: {
              key: { startsWith: "manualInteractionNotified:" },
              value: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
            },
          })
          .catch((err) => console.warn("[webhook/sonarr] manual-interaction marker prune failed:", err)),
      );
    }
    syncCompleted = true;
    return NextResponse.json({ ok: true, manualInteraction: true });
  }

  if (payload.eventType !== "Download" || !payload.series) {
    syncCompleted = true;
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tvdbId, tmdbId } = payload.series;

  const safeVdbId = Number.isInteger(tvdbId) && tvdbId > 0 ? tvdbId : null;
  const safeMdbId = typeof tmdbId === "number" && Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null;

  // Never trust the payload's ids on their own. The webhook secret authenticates
  // the request but does NOT prove the named series was actually downloaded: anyone
  // who learns the secret (or replays a captured request) could POST a forged
  // Download event for arbitrary tvdbId/tmdbId and flip an APPROVED request straight
  // to AVAILABLE for a series Sonarr never grabbed. Verify against Sonarr's own
  // authoritative API before changing any status. Tri-state result: `false` =
  // Sonarr is reachable and confirms NO episode file exists, so we SKIP the flip
  // (the forgery case we reject); `true` = confirmed downloaded, proceed; `null` =
  // indeterminate (the firing instance isn't configured, or Sonarr is unreachable) so
  // we proceed optimistically and let the periodic library sync reconcile
  // availability independently. Proceeding on null is safe against forgery because
  // an attacker cannot force a null result without breaking the operator's own
  // Sonarr connectivity.
  const seriesDownloaded = await isSeriesDownloadedInSonarr(
    { tvdbId: safeVdbId, tmdbId: safeMdbId },
    arrInstance,
  );
  if (seriesDownloaded === false) {
    console.warn("[webhook/sonarr] Download event for tvdbId=%s tmdbId=%s not confirmed downloaded in Sonarr; skipping status flip.", sanitizeForLog(safeVdbId ?? "?"), sanitizeForLog(safeMdbId ?? "?"));
    syncCompleted = true;
    return NextResponse.json({ ok: true, skipped: true, reason: "not_downloaded" });
  }

  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };

  let effectiveMdbId: number | null = null;
  let effectiveVdbId: number | null = null;
  // Lifted out of the tvdb-path tx so we can wipe DeletionVotes after the tx commits.
  let tvdbPathTmdbId: number | null = null;
  // True when the tvdb-path flipped a request but no MediaRequest carried the tvdbId,
  // so the tmdbId-keyed wanted row couldn't be evicted inside the tx — resolve + evict
  // it after the tx commits (best-effort; the next full sync rewrites it regardless).
  let tvdbWantedEvictPending = false;

  // Try tmdbId first; fall back to tvdbId because Sonarr may not always send tmdbId
  if (safeMdbId) {
    // Advisory lock 1001,2 prevents a concurrent Sonarr sync from overwriting the wanted table mid-transaction
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
      // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
      const resetNotify = await tx.mediaRequest.updateMany({
        where: { tmdbId: safeMdbId, mediaType: "TV", arrInstance, status: "APPROVED", availableAt: null },
        // Clear the approve-time 90s backstop so a stale timer can't fire a
        // false "download pending" after a later revert.
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
      const alreadyAvailable = await tx.mediaRequest.updateMany({
        where: { tmdbId: safeMdbId, mediaType: "TV", arrInstance, status: "APPROVED", availableAt: { not: null } },
        // Clear the approve-time 90s backstop so a stale timer can't fire a
        // false "download pending" after a later revert.
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
      updated = { count: resetNotify.count + alreadyAvailable.count };
      await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: safeMdbId, arrInstance } });
      // Backfill tvdbId on the matched request(s). A later Download webhook for the same
      // series may arrive with only tvdbId (Sonarr omits tmdbId on some events); without
      // this, that tvdbId-only path can't find the request to evict its wanted-cache row.
      if (safeVdbId) {
        await tx.mediaRequest.updateMany({
          where: { tmdbId: safeMdbId, mediaType: "TV", tvdbId: null },
          data: { tvdbId: safeVdbId },
        });
      }
    }, { timeout: 30_000 });
    if (updated.count > 0) {
      effectiveMdbId = safeMdbId;
      void clearDeletionVotesForTmdbs([{ tmdbId: safeMdbId, mediaType: "TV" }]);
    }
  }

  if (updated.count === 0 && safeVdbId) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;

      const req = await tx.mediaRequest.findFirst({
        where: { tvdbId: safeVdbId!, mediaType: "TV", arrInstance },
        select: { tmdbId: true },
      });
      const resetNotify = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", arrInstance, status: "APPROVED", availableAt: null },
        // Clear the approve-time 90s backstop so a stale timer can't fire a
        // false "download pending" after a later revert.
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
      const alreadyAvailable = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", arrInstance, status: "APPROVED", availableAt: { not: null } },
        // Clear the approve-time 90s backstop so a stale timer can't fire a
        // false "download pending" after a later revert.
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
      updated = { count: resetNotify.count + alreadyAvailable.count };
      if (req && updated.count > 0) {
        await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: req.tmdbId, arrInstance } });
        tvdbPathTmdbId = req.tmdbId;
      } else if (!req && updated.count > 0) {
        // No MediaRequest mapped this tvdbId; the wanted table is tmdbId-keyed, so
        // defer the eviction to after the tx where we can resolve tvdb→tmdb.
        tvdbWantedEvictPending = true;
      }
    }, { timeout: 30_000 });
    if (updated.count > 0) {
      effectiveVdbId = safeVdbId;
      if (tvdbPathTmdbId !== null) {
        void clearDeletionVotesForTmdbs([{ tmdbId: tvdbPathTmdbId, mediaType: "TV" }]);
      }
      if (tvdbWantedEvictPending) {
        void (async () => {
          const resolved = await resolveSingleTvdbToTmdb(safeVdbId!);
          if (resolved !== null) {
            await prisma.sonarrWantedItem.deleteMany({ where: { tmdbId: resolved, arrInstance } });
          } else {
            console.warn(`[webhooks/sonarr] could not evict sonarrWantedItem: unresolvable tvdbId ${sanitizeForLog(safeVdbId)}`);
          }
        })().catch((err) => console.warn("[webhooks/sonarr] deferred wanted eviction failed:", err));
      }
    }
  }

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("tv", safeMdbId ?? undefined, arrInstance);

    // Scope by arrInstance to the instance that fired this webhook: one instance's
    // Download must not sweep in a sibling instance's request and notify it off the
    // wrong grab.
    const whereNotify = effectiveMdbId
      ? { tmdbId: effectiveMdbId, mediaType: "TV" as const, arrInstance, status: "AVAILABLE" as const, notifiedAvailable: false }
      : effectiveVdbId
      ? { tvdbId: effectiveVdbId, mediaType: "TV" as const, arrInstance, status: "AVAILABLE" as const, notifiedAvailable: false }
      : null;
    if (!whereNotify) return;

    const pending = await prisma.mediaRequest.findMany({
      where: whereNotify,
      select: { id: true, tmdbId: true, requestedBy: true, title: true, mediaType: true, posterPath: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const tmdbIdForCheck = effectiveMdbId ?? pending[0].tmdbId;
    if (!tmdbIdForCheck) return;

    const [plexConfig, jellyfinConfig] = await Promise.all([
      getPlexConfig(),
      getJellyfinConfig(),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexConfig.url && plexConfig.token
        ? () => hasPlexItemByTmdbId(plexConfig.url!, plexConfig.token!, tmdbIdForCheck, "tv")
        : null,
      jellyfinConfig.url && jellyfinConfig.apiKey
        ? () => hasJellyfinItemByTmdbId(jellyfinConfig.url!, jellyfinConfig.apiKey!, tmdbIdForCheck, "tv")
        : null,
      "webhook/sonarr",
    ).catch((err) => { console.warn("[webhooks/sonarr] notification failed after marking AVAILABLE:", err); });
  });

  // arrInstance-scoped: one instance's Download must not claim (and notify off)
  // a grab that was fired at a sibling instance.
  const grabWhere = safeMdbId
    ? { tmdbId: safeMdbId, mediaType: "TV" as const, arrInstance, notifiedAt: null }
    : safeVdbId
    ? { tvdbId: safeVdbId, mediaType: "TV" as const, arrInstance, notifiedAt: null }
    : null;
  if (grabWhere) {
    const pendingGrabs = await prisma.issueGrab.findMany({ where: grabWhere });
    if (pendingGrabs.length > 0) {
      const now = new Date();
      await Promise.all(
        pendingGrabs.map(async (grab) => {

          // CAS: ensure only one concurrent webhook fires the notification for this grab
          const claimed = await prisma.issueGrab.updateMany({
            where: { id: grab.id, notifiedAt: null },
            data: { notifiedAt: now },
          });
          if (claimed.count === 0) return;

          const outcome = await notifyAdminGrabCompletedPush({
            userId: grab.triggeredById,
            title: grab.title,
            scope: grab.scope,
            seasonNumber: grab.seasonNumber,
            episodeNumber: grab.episodeNumber,
            issueId: grab.issueId,
          });
          // "failed" → reset notifiedAt for retry. "skipped-no-subs" /
          // "skipped-no-keys" → leave notifiedAt set, but log so an operator
          // can wire up email/Discord backstop notification.
          if (outcome === "failed") {
            await prisma.issueGrab.update({
              where: { id: grab.id, notifiedAt: now },
              data: { notifiedAt: null },
            }).catch(() => {});
            console.warn("[webhook/sonarr] grab notification failed, reset for retry");
          } else if (outcome === "skipped-no-subs" || outcome === "skipped-no-keys") {
            console.warn(`[webhook/sonarr] grab push skipped (${outcome}) for user=${grab.triggeredById} issue=${grab.issueId}`);
          }
        })
      );
    }
  }

  syncCompleted = true;
  return NextResponse.json({ ok: true, marked: updated.count });
  } finally {
    if (!syncCompleted) {
      await clearWebhookReplayDigestJson("sonarr", secret, payload);
    }
  }
}
