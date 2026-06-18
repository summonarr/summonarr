import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getUpcomingMovies, getUpcomingTV, type TmdbMedia } from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { prisma } from "@/lib/prisma";

// Native-client mirror of src/app/(app)/upcoming/page.tsx. Serves the cached
// upcoming feed (refreshed by the /api/sync/upcoming cron), falling back to
// live TMDB for whichever side the cache is missing, interleaved by release
// date. Keep the cache window + interleave logic in sync with that page.
async function getUpcomingFromCache(): Promise<TmdbMedia[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await prisma.upcomingCacheItem.findMany({
    where: {
      cachedAt: { gt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
      releaseDate: { gte: today },
    },
    orderBy: { releaseDate: "asc" },
    take: 500,
  });
  return rows.map((r) => ({
    id: r.tmdbId,
    mediaType: r.mediaType === "MOVIE" ? "movie" : ("tv" as TmdbMedia["mediaType"]),
    title: r.title,
    overview: r.overview,
    posterPath: r.posterPath,
    backdropPath: r.backdropPath,
    releaseDate: r.releaseDate,
    releaseYear: r.releaseYear,
    voteAverage: r.voteAverage,
  }));
}

export const GET = withAuth(async (request, _ctx, session) => {
  const hideAvailable = request.nextUrl.searchParams.get("hideAvailable") === "1";
  const raw: TmdbMedia[] = [];

  try {
    const today = new Date().toISOString().slice(0, 10);

    let all = await getUpcomingFromCache();
    const hasMovies = all.some((m) => m.mediaType === "movie");
    const hasTV = all.some((m) => m.mediaType === "tv");
    if (!hasMovies || !hasTV) {
      const [movies, tv] = await Promise.all([
        hasMovies ? Promise.resolve([] as TmdbMedia[]) : getUpcomingMovies(),
        hasTV ? Promise.resolve([] as TmdbMedia[]) : getUpcomingTV(),
      ]);
      all = [...all, ...movies, ...tv];
    }

    const futureMovies = all.filter((m) => m.mediaType === "movie" && m.releaseDate && m.releaseDate >= today);
    const futureTV = all.filter((m) => m.mediaType === "tv" && m.releaseDate && m.releaseDate >= today);

    const maxLen = Math.max(futureMovies.length, futureTV.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < futureMovies.length) raw.push(futureMovies[i]);
      if (i < futureTV.length) raw.push(futureTV[i]);
    }
  } catch (err) {
    // Surface a real fetch failure as 502 instead of returning 200 with an empty
    // list — the latter is indistinguishable from "no upcoming releases" and hides
    // the outage. A legitimately-empty result (no error) still falls through to 200.
    console.error("[upcoming] Failed:", err);
    return NextResponse.json({ error: "Failed to load upcoming releases" }, { status: 502 });
  }

  const show4k = await getShow4kVisibility(session);
  let items = await attachAllAvailability(raw, session.user.id, { show4k });
  if (hideAvailable) {
    items = items.filter((m) => !(m.plexAvailable || m.jellyfinAvailable));
  }

  return NextResponse.json({ items });
});
