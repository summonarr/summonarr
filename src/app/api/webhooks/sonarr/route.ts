import { NextRequest, NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { notifyAdminGrabCompletedPush } from "@/lib/push";
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
}

export async function POST(req: NextRequest) {
  const tooLarge = checkBodySize(req, 1_048_576);
  if (tooLarge) return tooLarge;

  const clientIp = getClientIp(req.headers);
  if (!checkRateLimit(`webhook:sonarr:${clientIp}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const [sourceRow, legacyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "sonarrWebhookSecret" } }),
    prisma.setting.findUnique({ where: { key: "webhookSecret" } }),
  ]);
  const secret = sourceRow?.value || legacyRow?.value || "";

  if (secret.length === 0) {
    console.warn("[webhook/sonarr] secret not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  // ?token= fallback is load-bearing: Sonarr webhook UI has no Authorization header field
  const queryToken = req.nextUrl.searchParams.get("token");
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;
  if (!token || !safeCompare(token, secret)) {
    console.warn("[webhook/sonarr] 401 unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    payload = JSON.parse(rawBody);
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
        where: { tmdbId: safeMdbId, mediaType: "TV", status: "APPROVED", availableAt: null },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      const alreadyAvailable = await tx.mediaRequest.updateMany({
        where: { tmdbId: safeMdbId, mediaType: "TV", status: "APPROVED", availableAt: { not: null } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      updated = { count: resetNotify.count + alreadyAvailable.count };
      await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: safeMdbId } });
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
        where: { tvdbId: safeVdbId!, mediaType: "TV" },
        select: { tmdbId: true },
      });
      const resetNotify = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", status: "APPROVED", availableAt: null },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      const alreadyAvailable = await tx.mediaRequest.updateMany({
        where: { tvdbId: safeVdbId!, mediaType: "TV", status: "APPROVED", availableAt: { not: null } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      updated = { count: resetNotify.count + alreadyAvailable.count };
      if (req && updated.count > 0) {
        await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: req.tmdbId } });
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
    await scheduleLibraryScan("tv", safeMdbId ?? undefined);

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

          const sent = await notifyAdminGrabCompletedPush({
            userId: grab.triggeredById,
            title: grab.title,
            scope: grab.scope,
            seasonNumber: grab.seasonNumber,
            episodeNumber: grab.episodeNumber,
            issueId: grab.issueId,
          });
          if (!sent) {
            await prisma.issueGrab.update({
              where: { id: grab.id, notifiedAt: now },
              data: { notifiedAt: null },
            }).catch(() => {});
            console.warn("[webhook/sonarr] grab notification failed, reset for retry");
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
