import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getJellyfinTmdbIds, getJellyfinTVEpisodes } from "@/lib/jellyfin";
import { notifyUsersRequestsAvailable } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/cron-auth";

// 2 hours — intentionally wider than the 1-hour sync interval so one missed run is survivable
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await request.json().catch(() => ({})) as Record<string, unknown>;
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

  // Fire-and-forget: episode cache is best-effort and must not block the main library write
  getJellyfinTVEpisodes(baseUrl, apiKey, selectedJellyfinIds, seriesItemIdToTmdbId)
    .then(async (episodes) => {
      if (episodes.length === 0) return;
      await prisma.$transaction(async (tx) => {
        await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
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
    await Promise.all([
      newMovieRows.length > 0 ? prisma.jellyfinLibraryItem.createMany({ data: newMovieRows }) : Promise.resolve(),
      newTvRows.length    > 0 ? prisma.jellyfinLibraryItem.createMany({ data: newTvRows })    : Promise.resolve(),
    ]);
  } else {

    await prisma.$transaction(async (tx) => {
      await tx.jellyfinLibraryItem.deleteMany();
      if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
      if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  }

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
      // CAS on notifiedAvailable so concurrent sync paths don't double-fire notifications
      const updated = await prisma.mediaRequest.updateMany({
        where: { id: { in: toNotify.map((r) => r.id) }, notifiedAvailable: false },
        data: { status: "AVAILABLE", availableAt: new Date(), notifiedAvailable: true },
      });
      if (updated.count > 0) {
        notifyUsersRequestsAvailable(toNotify).catch(() => {});
        notifyUsersRequestsAvailablePush(toNotify).catch(() => {});
      }
    }

    const alreadyNotified = toMark.filter((r) => r.notifiedAvailable);
    if (alreadyNotified.length > 0) {
      await prisma.mediaRequest.updateMany({
        where: { id: { in: alreadyNotified.map((r) => r.id) } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
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
