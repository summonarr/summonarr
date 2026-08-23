import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { getMyWrapped } from "@/lib/my-watch-history";
import { resolvePosterPathMap, posterPathKey } from "@/lib/poster-cache";

export const dynamic = "force-dynamic";

// GET — the caller's OWN "Wrapped" year-in-review, as a lean JSON projection for
// native clients (the iOS Wrapped screen). The REST mirror of the
// /my-stats/wrapped page: both render the same getMyWrapped bundle, so keep the
// two projections in step.
//
// Open to any authenticated user for the same reason as the sibling
// /play-history/mine/stats: the scope is fixed server-side. getMyWrapped reads
// only the MediaServerUser rows linked to the SESSION user, and there is
// deliberately no userId param to widen it.
//
// `?year=` is validated to 4 digits here and re-checked against the
// years-with-data list inside getMyWrapped, so it can only ever select a year
// the caller actually has — anything else falls back to the most recent year on
// record. `years` ships alongside so the client can build its own year picker
// without a second call.
//
// Posters ship as raw TMDB `posterPath` (not the web page's `posterSrc` URL) so
// the client picks its own image size — the same native posture as
// /play-history/mine/stats. Live TmdbCache art is authoritative; the PlayHistory
// snapshot is the fallback for titles no longer cached.
//
// { linked: false } ⇒ no linked media-server identity yet;
// { linked: true, year: null, data: null } ⇒ linked, but no watched plays in any
// year; otherwise the chosen year's bundle.
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`play-history-mine-wrapped:${session.user.id}`, 30, 60_000)) {
    return tooManyRequests(60);
  }

  const raw = req.nextUrl.searchParams.get("year");
  const requested = raw && /^\d{4}$/.test(raw) ? parseInt(raw, 10) : undefined;

  const { linked, years, year, data } = await getMyWrapped(session.user.id, requested);
  if (!data || year == null) {
    return NextResponse.json({ linked, years, year: null, data: null });
  }

  const posterItems = [...data.topTitles, ...(data.longestSitting ? [data.longestSitting] : [])];
  const posterPaths = await resolvePosterPathMap(posterItems);
  const resolvePath = (tmdbId: number | null, mediaType: string | null, snapshot: string | null) =>
    (tmdbId != null ? posterPaths[posterPathKey(tmdbId, mediaType)] : undefined) ?? snapshot;

  return NextResponse.json({
    linked,
    years,
    year,
    data: {
      year,
      // Server-side, like the web page — the client renders whatever this says
      // rather than comparing against its own clock, so a device with a skewed
      // date can't disagree with the server about which year is "this" one.
      isCurrentYear: year === new Date().getUTCFullYear(),
      totals: data.totals,
      movies: data.movies,
      tv: data.tv,
      topTitles: data.topTitles.map((t) => ({
        title: t.title,
        tmdbId: t.tmdbId,
        mediaType: t.mediaType,
        count: t.count,
        hours: t.hours,
        posterPath: resolvePath(t.tmdbId, t.mediaType, t.posterPath),
      })),
      biggestDay: data.biggestDay,
      busiestMonth: data.busiestMonth,
      primeDow: data.primeDow,
      primeHour: data.primeHour,
      longestSitting: data.longestSitting
        ? {
            title: data.longestSitting.title,
            tmdbId: data.longestSitting.tmdbId,
            mediaType: data.longestSitting.mediaType,
            seconds: data.longestSitting.seconds,
            startedAt: data.longestSitting.startedAt,
            posterPath: resolvePath(
              data.longestSitting.tmdbId,
              data.longestSitting.mediaType,
              data.longestSitting.posterPath,
            ),
          }
        : null,
      completion: data.completion,
      topPlatform: data.topPlatform,
      topDevice: data.topDevice,
    },
  });
});
