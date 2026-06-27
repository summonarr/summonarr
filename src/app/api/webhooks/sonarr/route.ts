import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notifyAdminGrabCompletedPush, notifyAdminsManualInteractionRequiredPush } from "@/lib/push";
import { checkAndRecordWebhookJson, clearWebhookReplayDigestJson } from "@/lib/webhook-replay";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { sanitizeForLog } from "@/lib/sanitize";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

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

  const [sourceRow, source4kRow, legacyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "sonarrWebhookSecret" } }),
    prisma.setting.findUnique({ where: { key: "sonarr4kWebhookSecret" } }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const hdSecret = sourceRow?.value || legacyRow?.value || "";
  const fourKSecret = source4kRow?.value || "";

  if (hdSecret.length === 0 && fourKSecret.length === 0) {
    console.warn("[webhook/sonarr] secret not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Sonarr webhook UI has no Authorization header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  // Secret-as-discriminator (see webhooks/radarr): the matching secret selects the
  // instance variant. Compare against both without an early return. Guardrail 2.
  const matchedHd = token != null && hdSecret.length > 0 && safeCompare(token, hdSecret);
  const matched4k = token != null && fourKSecret.length > 0 && safeCompare(token, fourKSecret);
  if (!token || (!matchedHd && !matched4k)) {
    console.warn("[webhook/sonarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const is4k = matched4k && !matchedHd;
  const secret = is4k ? fourKSecret : hdSecret;

  // Sonarr's webhook UI has no Authorization header field — ?token= is the only
  // option upstream supports. Don't warn about it; nothing the user can do.

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
    // Don't log the payload-supplied series title (CodeQL js/log-injection — it's
    // a remote source). The title still reaches admins via the push below.
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
      const manualKey = `manualInteractionNotified:sonarr:${stableSeriesId}`;
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

  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };

  let effectiveMdbId: number | null = null;
  let effectiveVdbId: number | null = null;
  // Lifted out of the tvdb-path tx so we can wipe DeletionVotes after the tx commits.
  let tvdbPathTmdbId: number | null = null;

  // Try tmdbId first; fall back to tvdbId because Sonarr may not always send tmdbId
  if (safeMdbId) {
    // Advisory lock 1001,2 prevents a concurrent Sonarr sync from overwriting the wanted table mid-transaction
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
      // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
      const resetNotify = await tx.mediaRequest.updateMany({
        where: { tmdbId: safeMdbId, mediaType: "TV", is4k, status: "APPROVED", availableAt: null },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      const alreadyAvailable = await tx.mediaRequest.updateMany({
        where: { tmdbId: safeMdbId, mediaType: "TV", is4k, status: "APPROVED", availableAt: { not: null } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      updated = { count: resetNotify.count + alreadyAvailable.count };
      await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: safeMdbId, is4k } });
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
        where: { tvdbId: safeVdbId!, mediaType: "TV", is4k },
        select: { tmdbId: true },
      });
      const resetNotify = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", is4k, status: "APPROVED", availableAt: null },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      const alreadyAvailable = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", is4k, status: "APPROVED", availableAt: { not: null } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      updated = { count: resetNotify.count + alreadyAvailable.count };
      if (req && updated.count > 0) {
        await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: req.tmdbId, is4k } });
        tvdbPathTmdbId = req.tmdbId;
      } else if (!req) {
        console.warn(`[webhooks/sonarr] could not evict sonarrWantedItem: no MediaRequest found for tvdbId ${sanitizeForLog(safeVdbId)}`);
      }
    }, { timeout: 30_000 });
    if (updated.count > 0) {
      effectiveVdbId = safeVdbId;
      if (tvdbPathTmdbId !== null) {
        void clearDeletionVotesForTmdbs([{ tmdbId: tvdbPathTmdbId, mediaType: "TV" }]);
      }
    }
  }

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("tv", safeMdbId ?? undefined, is4k ? "4k" : "hd");

    const whereNotify = effectiveMdbId
      ? { tmdbId: effectiveMdbId, mediaType: "TV" as const, status: "AVAILABLE" as const, notifiedAvailable: false }
      : effectiveVdbId
      ? { tvdbId: effectiveVdbId, mediaType: "TV" as const, status: "AVAILABLE" as const, notifiedAvailable: false }
      : null;
    if (!whereNotify) return;

    const pending = await prisma.mediaRequest.findMany({
      where: whereNotify,
      select: { id: true, tmdbId: true, requestedBy: true, title: true, mediaType: true, posterPath: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const tmdbIdForCheck = effectiveMdbId ?? pending[0].tmdbId;
    if (!tmdbIdForCheck) return;

    const [plexUrlRow, plexTokenRow, jfUrlRow, jfKeyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexUrlRow?.value && plexTokenRow?.value
        ? () => hasPlexItemByTmdbId(plexUrlRow.value!, plexTokenRow.value!, tmdbIdForCheck, "tv")
        : null,
      jfUrlRow?.value && jfKeyRow?.value
        ? () => hasJellyfinItemByTmdbId(jfUrlRow.value!, jfKeyRow.value!, tmdbIdForCheck, "tv")
        : null,
      "webhook/sonarr",
    ).catch((err) => { console.warn("[webhooks/sonarr] notification failed after marking AVAILABLE:", err); });
  });

  const grabWhere = safeMdbId
    ? { tmdbId: safeMdbId, mediaType: "TV" as const, notifiedAt: null }
    : safeVdbId
    ? { tvdbId: safeVdbId, mediaType: "TV" as const, notifiedAt: null }
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
