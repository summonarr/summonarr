export const dynamic = "force-dynamic";

import { getUpcomingMovies, getUpcomingTV, type TmdbMedia } from "@/lib/tmdb";
import { MediaCard } from "@/components/media/media-card";
import { attachAllAvailability } from "@/lib/attach-all";
import { prisma } from "@/lib/prisma";
import { Suspense } from "react";
import { HideAvailableToggle } from "@/components/media/hide-available-toggle";
import { auth } from "@/lib/auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { LiveRefresh } from "@/components/live-refresh";

async function getUpcomingFromCache(): Promise<TmdbMedia[]> {
  const rows = await prisma.upcomingCacheItem.findMany({
    where: {
      cachedAt: { gt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
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

export default async function UpcomingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, auth()]);
  const hideAvailable = sp.hideAvailable === "1";
  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  let raw: TmdbMedia[] = [];
  try {
    const today = new Date().toISOString().slice(0, 10);

    let all = await getUpcomingFromCache();
    if (all.length === 0) {
      const [movies, tv] = await Promise.all([getUpcomingMovies(), getUpcomingTV()]);
      all = [...movies, ...tv];
    }

    const movies = all.filter((m) => m.mediaType === "movie");
    const tv = all.filter((m) => m.mediaType === "tv");

    const futureMovies = movies.filter((m) => m.releaseDate && m.releaseDate >= today);
    const futureTV = tv.filter((m) => m.releaseDate && m.releaseDate >= today);

    const maxLen = Math.max(futureMovies.length, futureTV.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < futureMovies.length) raw.push(futureMovies[i]);
      if (i < futureTV.length) raw.push(futureTV[i]);
    }
  } catch {

  }

  let items = await attachAllAvailability(raw, session?.user.id);

  if (hideAvailable) {
    items = items.filter((m) => !(m.plexAvailable || m.jellyfinAvailable));
  }

  return (
    <div>
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <h1 className="text-2xl font-bold mb-1">Upcoming</h1>
      <p className="text-zinc-400 text-sm mb-4">Movies releasing soon &amp; TV shows currently airing</p>

      <Suspense>
        <HideAvailableToggle active={hideAvailable} />
      </Suspense>

      {items.length === 0 ? (
        <div className="text-zinc-500 text-sm">
          No results — set TMDB_READ_TOKEN (or TMDB_API_KEY) in .env.local to see upcoming content.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {items.map((media) => (
            <MediaCard key={`${media.mediaType}-${media.id}`} media={media} showPlex={showPlex} showJellyfin={showJellyfin} size="md" />
          ))}
        </div>
      )}
    </div>
  );
}
