import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { getMyPlayStats } from "@/lib/my-watch-history";
import { resolvePosterPathMap, posterPathKey } from "@/lib/poster-cache";

export const dynamic = "force-dynamic";

// GET — the caller's OWN aggregate play stats, as a lean JSON projection for
// native clients (the iOS "My Stats" screen). Like GET /api/play-history/mine
// this is open to any authenticated user because the scope is fixed
// server-side: getMyPlayStats aggregates only the MediaServerUser rows linked
// to the SESSION user, and there is deliberately no userId param to widen it.
//
// The projection matches what the web /my-stats dashboard renders and
// intentionally OMITS the admin-only forensics carried on the raw bundle
// (per-play rows, IP addresses, codecs, transcode/resolution mixes) — same
// lean posture as my-watch-history. Posters ship as tmdbId + posterPath so the
// client builds its own image URLs.
//
// { linked: false } ⇒ the account has no linked media-server identity yet;
// { linked: true, stats: {...} } ⇒ aggregates (all-zero until the first watch).
export const GET = withAuth(async (_req, _ctx, session) => {
  if (!checkRateLimit(`play-history-mine-stats:${session.user.id}`, 30, 60_000)) {
    return tooManyRequests(60);
  }
  const { linked, stats } = await getMyPlayStats(session.user.id);
  if (!stats) return NextResponse.json({ linked, stats: null });
  // Live TmdbCache/TmdbMediaCore posters, exactly like the web /my-stats page.
  // The PlayHistory.posterPath snapshot alone is not enough: it's captured at
  // finalize time from the title's `:details` cache row, which usually doesn't
  // exist yet for something nobody opened in the app — so most top-media rows
  // carried a null path and the client rendered a placeholder.
  const posterPaths = await resolvePosterPathMap(stats.topMedia);
  return NextResponse.json({
    linked,
    stats: {
      totalPlays: stats.totalPlays,
      totalWatchTimeHours: stats.totalWatchTimeHours,
      avgSessionDuration: stats.avgSessionDuration,
      lastActiveIso: stats.recentPlays[0]?.startedAt.toISOString() ?? null,
      activityCalendar: stats.activityCalendar,
      playsByDay: stats.playsByDay,
      userHeatmap: stats.userHeatmap,
      platformBreakdown: stats.platformBreakdown,
      deviceList: stats.deviceList,
      topMedia: stats.topMedia.map((m) => ({
        title: m.title,
        tmdbId: m.tmdbId,
        mediaType: m.mediaType,
        count: m.count,
        // Resolved path first, stored snapshot as the fallback. Stays a raw
        // TMDB path (not a URL) so the client picks its own image size, and so
        // already-shipped builds are fixed without a client update.
        posterPath:
          (m.tmdbId != null ? posterPaths[posterPathKey(m.tmdbId, m.mediaType)] : undefined) ??
          m.posterPath,
      })),
    },
  });
});
