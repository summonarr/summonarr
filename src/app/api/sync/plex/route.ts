import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPlexTmdbIds, getPlexTVEpisodes, getPlexLibrarySections } from "@/lib/plex";
import { notifyUsersRequestsAvailable } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/cron-auth";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await request.json().catch(() => ({})) as Record<string, unknown>;
  const recentOnly = rawBody.full !== true;

  const [serverUrlRow, tokenRow, librariesRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    prisma.setting.findUnique({ where: { key: "plexLibraries" } }),
  ]);

  if (!serverUrlRow?.value || !tokenRow?.value) {
    return NextResponse.json({ error: "Plex server not configured" }, { status: 400 });
  }

  const serverUrl = serverUrlRow.value.replace(/\/$/, "");
  const token = tokenRow.value;
  const selectedPlexKeys = librariesRow?.value
    ? new Set(librariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
    : undefined;

  let sections: Awaited<ReturnType<typeof getPlexLibrarySections>>;
  let movieIds: Awaited<ReturnType<typeof getPlexTmdbIds>>;
  let tvIds:    Awaited<ReturnType<typeof getPlexTmdbIds>>;
  try {
    sections = await getPlexLibrarySections(serverUrl, token);
    [movieIds, tvIds] = await Promise.all([
      getPlexTmdbIds(serverUrl, token, "MOVIE", recentOnly, selectedPlexKeys, sections),
      getPlexTmdbIds(serverUrl, token, "TV", recentOnly, selectedPlexKeys, sections),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync/plex] Failed to fetch library:", msg);
    return NextResponse.json(
      { error: "Could not reach Plex server" },
      { status: 502 }
    );
  }

  // Fire-and-forget: episode cache is best-effort and must not block the main library write
  getPlexTVEpisodes(serverUrl, token, selectedPlexKeys, sections)
    .then(async (episodes) => {
      if (episodes.length === 0) return;
      await prisma.$transaction(async (tx) => {
        await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
        await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
      }, { timeout: BATCH_TX_TIMEOUT });
    })
    .catch((err) => console.error("[sync/plex] Episode cache failed:", err));

  const sanitizeStr = (s: string | null | undefined, maxLen = 1000): string | null => {
    if (s == null) return null;
    return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
  };

  const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
  const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));

  // Plex can conflate two TMDB IDs onto the same ratingKey when metadata bundles merge;
  // deduplicate by preferring the previously stored mapping to avoid flip-flopping on every sync
  type PlexRow = { tmdbId: number; mediaType: "MOVIE" | "TV"; filePath: string | null; plexRatingKey: string | null };
  const deduplicateByRatingKey = async (
    rows: PlexRow[],
    mediaType: "MOVIE" | "TV",
  ): Promise<PlexRow[]> => {
    const ratingKeyCount = new Map<string, number>();
    for (const r of rows) {
      if (r.plexRatingKey) ratingKeyCount.set(r.plexRatingKey, (ratingKeyCount.get(r.plexRatingKey) ?? 0) + 1);
    }
    const conflatedKeys = new Set([...ratingKeyCount.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    if (conflatedKeys.size === 0) return rows;

    const conflatedTmdbIds = rows.filter((r) => r.plexRatingKey && conflatedKeys.has(r.plexRatingKey)).map((r) => r.tmdbId);
    const existing = await prisma.plexLibraryItem.findMany({
      where: { mediaType, tmdbId: { in: conflatedTmdbIds } },
      select: { tmdbId: true, plexRatingKey: true },
    });
    const fixedIdByRatingKey = new Map<string, number>();
    for (const e of existing) {
      if (e.plexRatingKey) fixedIdByRatingKey.set(e.plexRatingKey, e.tmdbId);
    }

    const seenRatingKeys = new Set<string>();
    return rows.filter((r) => {
      if (!r.plexRatingKey || !conflatedKeys.has(r.plexRatingKey)) return true;
      const fixed = fixedIdByRatingKey.get(r.plexRatingKey);
      if (fixed !== undefined) {
        if (r.tmdbId !== fixed) {
          console.log(`[sync/plex] conflated ratingKey=${r.plexRatingKey}: dropping tmdb=${r.tmdbId}, keeping fixed tmdb=${fixed}`);
          return false;
        }
      } else if (seenRatingKeys.has(r.plexRatingKey)) {
        // No prior DB mapping; keep the first occurrence, drop subsequent duplicates
        return false;
      }
      seenRatingKeys.add(r.plexRatingKey);
      return true;
    });
  };

  let finalMovieRows = await deduplicateByRatingKey(movieRows, "MOVIE");
  let finalTvRows    = await deduplicateByRatingKey(tvRows,    "TV");

  if (recentOnly) {
    // Insert-only: never delete rows on this path — an empty window would nuke the whole library
    const [existingMovies, existingTv] = await Promise.all([
      prisma.plexLibraryItem.findMany({
        where: { mediaType: "MOVIE", tmdbId: { in: finalMovieRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
      prisma.plexLibraryItem.findMany({
        where: { mediaType: "TV", tmdbId: { in: finalTvRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
    ]);
    const existingMovieSet = new Set(existingMovies.map((r) => r.tmdbId));
    const existingTvSet    = new Set(existingTv.map((r) => r.tmdbId));
    finalMovieRows = finalMovieRows.filter((r) => !existingMovieSet.has(r.tmdbId));
    finalTvRows    = finalTvRows.filter((r)    => !existingTvSet.has(r.tmdbId));

    await Promise.all([
      finalMovieRows.length > 0 ? prisma.plexLibraryItem.createMany({ data: finalMovieRows }) : Promise.resolve(),
      finalTvRows.length    > 0 ? prisma.plexLibraryItem.createMany({ data: finalTvRows })    : Promise.resolve(),
    ]);
  } else {

    await prisma.$transaction(async (tx) => {
      await tx.plexLibraryItem.deleteMany({ where: { mediaType: "MOVIE" } });
      await tx.plexLibraryItem.deleteMany({ where: { mediaType: "TV" } });
      if (finalMovieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, finalMovieRows);
      if (finalTvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, finalTvRows);
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
      target: "sync:plex",
      details: { movies: movieIds.size, tv: tvIds.size, marked: toMark.length },
    });
  }

  return NextResponse.json({
    scanned: { movies: movieIds.size, tv: tvIds.size },
    checked: requests.length,
    marked: toMark.length,
    full: !recentOnly,
  });
}
