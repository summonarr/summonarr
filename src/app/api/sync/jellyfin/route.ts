import { NextRequest, NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getJellyfinTmdbIds, getJellyfinTVEpisodes } from "@/lib/jellyfin";
import { notifyUsersRequestsAvailable } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording } from "@/lib/cron-auth";
import { claimAvailableNotificationWinners, clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { notifyUsersRequestsAvailableEmail } from "@/lib/request-notifications";

// 2 hours — intentionally wider than the 1-hour sync interval so one missed run is survivable
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withCronRunRecording("jellyfin-sync", () => syncJellyfin(request));
}

async function syncJellyfin(request: NextRequest) {
  const rawBody = await readJsonCappedOr<Record<string, unknown>>(request, 8192, {});
  if (rawBody instanceof NextResponse) return rawBody;
  const recentOnly = rawBody.full !== true;

  const [urlRow, keyRow, librariesRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinLibraries" } }),
  ]);

  if (!urlRow?.value || !keyRow?.value) {
    return NextResponse.json({ error: "Jellyfin server not configured" }, { status: 400 });
  }

  const baseUrl = urlRow.value.replace(/\/$/, "");
  const apiKey = keyRow.value;
  const selectedJellyfinIds = librariesRow?.value
    ? new Set(librariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
    : undefined;

  const minDateLastSaved = recentOnly ? new Date(Date.now() - RECENT_WINDOW_MS) : undefined;

  let movieIds: Awaited<ReturnType<typeof getJellyfinTmdbIds>>;
  let tvIds:    Awaited<ReturnType<typeof getJellyfinTmdbIds>>;
  try {
    [movieIds, tvIds] = await Promise.all([
      getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE", selectedJellyfinIds, minDateLastSaved),
      getJellyfinTmdbIds(baseUrl, apiKey, "TV", selectedJellyfinIds, minDateLastSaved),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync/jellyfin] Failed to fetch library:", msg);
    return NextResponse.json(
      { error: "Could not reach Jellyfin server" },
      { status: 502 }
    );
  }

  const seriesItemIdToTmdbId = new Map<string, number>();
  for (const [tmdbId, data] of tvIds) {
    if (data.itemId) seriesItemIdToTmdbId.set(data.itemId, tmdbId);
  }

  // Fire-and-forget: episode cache is best-effort and must not block the main library write.
  // On recentOnly, scope deletes to the series we're about to repopulate so unrelated cached
  // episodes survive (the recentOnly tv filter is a 2h window, not the whole library).
  const episodeRecentOnly = recentOnly;
  const tmdbIdsBeingReplaced = Array.from(seriesItemIdToTmdbId.values());
  getJellyfinTVEpisodes(baseUrl, apiKey, selectedJellyfinIds, seriesItemIdToTmdbId)
    .then(async (episodes) => {
      if (episodes.length === 0) return;
      await prisma.$transaction(async (tx) => {
        // Advisory lock 2002,2 — Jellyfin TVEpisodeCache coordination. Shared with
        // /api/sync/route and /api/sync/tv-episodes so a recentOnly tmdbId-scoped delete can't
        // be interleaved with a wholesale rewrite from another runner.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
        if (episodeRecentOnly) {
          if (tmdbIdsBeingReplaced.length > 0) {
            await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId: { in: tmdbIdsBeingReplaced } } });
          }
        } else {
          await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
        }
        await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "jellyfin" as const, ...e })));
      }, { timeout: BATCH_TX_TIMEOUT });
    })
    .catch((err) => console.error("[sync/jellyfin] Episode cache failed:", err));

  const sanitizeStr = (s: string | null | undefined, maxLen = 1000): string | null => {
    if (s == null) return null;
    return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
  };

  const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
  const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));

  if (recentOnly) {
    // Insert-only: never delete rows on this path — an empty window would nuke the whole library
    const [existingMovies, existingTv] = await Promise.all([
      prisma.jellyfinLibraryItem.findMany({
        where: { mediaType: "MOVIE", tmdbId: { in: movieRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
      prisma.jellyfinLibraryItem.findMany({
        where: { mediaType: "TV", tmdbId: { in: tvRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
    ]);
    const existingMovieSet = new Set(existingMovies.map((r) => r.tmdbId));
    const existingTvSet    = new Set(existingTv.map((r) => r.tmdbId));
    const newMovieRows = movieRows.filter((r) => !existingMovieSet.has(r.tmdbId));
    const newTvRows    = tvRows.filter((r)    => !existingTvSet.has(r.tmdbId));
    // Advisory lock 2001,2 — serializes Jellyfin library writes against orchestrator + concurrent
    // per-source invocations (admin "Resync Jellyfin" while cron is mid-flight).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
      if (newMovieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, newMovieRows);
      if (newTvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, newTvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  } else {

    // Advisory lock 2001,2 — see comment in the recentOnly branch above.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
      await tx.jellyfinLibraryItem.deleteMany();
      if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
      if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  }

  // Stamp last-success so the orchestrator's 24h-stale fallback (sync/route.ts
  // pendingAvailableNotify gate) doesn't fire falsely on deployments where the
  // admin runs the per-source resync more recently than the orchestrator.
  await prisma.setting.upsert({
    where: { key: "lastJellyfinSyncSucceededAt" },
    update: { value: String(Date.now()) },
    create: { key: "lastJellyfinSyncSucceededAt", value: String(Date.now()) },
  }).catch((err) => console.error("[sync/jellyfin] failed to stamp lastJellyfinSyncSucceededAt:", err));

  const requests = await prisma.mediaRequest.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, notifiedAvailable: true },
  });

  const toMark = requests.filter((req) =>
    req.mediaType === "MOVIE" ? movieIds.has(req.tmdbId) : tvIds.has(req.tmdbId)
  );

  if (toMark.length > 0) {
    const toNotify = toMark.filter((r) => !r.notifiedAvailable);
    if (toNotify.length > 0) {
      // CAS on notifiedAvailable so concurrent sync paths don't double-fire notifications;
      // winner filter ensures we only notify on rows we actually flipped.
      const winners = await claimAvailableNotificationWinners(toNotify, { markAvailable: true });
      if (winners.length > 0) {
        void clearDeletionVotesForTmdbs(winners);
        notifyUsersRequestsAvailable(winners).catch(() => {});
        notifyUsersRequestsAvailablePush(winners).catch(() => {});
        void notifyUsersRequestsAvailableEmail(winners, "sync/jellyfin");
      }
    }

    const alreadyNotified = toMark.filter((r) => r.notifiedAvailable);
    if (alreadyNotified.length > 0) {
      // Stamp availableAt on the flip (matches the orchestrator's markLibraryRequests).
      // The status guard keeps it from rewriting the timestamp on every sync tick.
      const flipped = await prisma.mediaRequest.updateMany({
        where: { id: { in: alreadyNotified.map((r) => r.id) }, status: { not: "AVAILABLE" } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      if (flipped.count > 0) void clearDeletionVotesForTmdbs(alreadyNotified);
    }
  }

  const session = await auth();
  if (session?.user) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.id,
      action: "LIBRARY_SYNC",
      target: "sync:jellyfin",
      details: { movies: movieIds.size, tv: tvIds.size, marked: toMark.length, full: !recentOnly },
    });
  }

  return NextResponse.json({
    scanned: { movies: movieIds.size, tv: tvIds.size },
    checked: requests.length,
    marked: toMark.length,
    full: !recentOnly,
  });
}
