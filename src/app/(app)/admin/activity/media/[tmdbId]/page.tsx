import { authActive } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getMediaPlayStats } from "@/lib/play-history";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import {
  TitleDetailView,
  type TitleDetailData,
} from "@/components/admin/activity-title-detail";

export const dynamic = "force-dynamic";

const COMPLETION_BUCKETS = [
  "0-25%",
  "25-50%",
  "50-75%",
  "75-95%",
  "95-100%",
];

// getMediaPlayStats' 90-day window (`ninetyDaysAgo` in play-history.ts).
const PLAYS_BY_DAY_WINDOW_DAYS = 90;

// Postgres GROUP BY day omits zero-play days, and getMediaPlayStats hands its
// daily series over unpadded — unlike its two siblings, which run it through
// play-history.ts's private padDailySeries. AreaChart positions points evenly
// by index with no date awareness and renders NOTHING for fewer than two
// points, so an unpadded feed collapses the "90d" x-axis onto the non-zero
// days (a Jun 1 → Aug 30 gap looks like Jun 1 → Jun 2) and a title watched on
// one day in the window shows a blank box. Pad here, mirroring that helper
// (UTC day keys, oldest → newest, `daysBack` entries), so the chart reads the
// same way as the user-detail page's identical card.
function padPlaysByDay(
  rows: { day: string; count: number }[],
  daysBack: number,
): { day: string; count: number }[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; count: number }[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, count: 0 });
  }
  return out;
}

export default async function MediaActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { tmdbId: tmdbIdStr } = await params;
  const tmdbId = parseInt(tmdbIdStr, 10);
  if (!Number.isFinite(tmdbId)) notFound();

  // TMDB ids are namespaced per type, so a movie and a show can share one id.
  // When the linking surface passes ?type=, scope the stats to that media type.
  const { type } = await searchParams;
  const mediaType = type === "TV" || type === "tv" ? "TV" : type === "MOVIE" || type === "movie" ? "MOVIE" : undefined;

  const stats = await getMediaPlayStats(tmdbId, mediaType);

  // Real TMDB poster art from the cache (same source the overview uses).
  // Pass the mediaType we already know: TMDB numbers movies and TV separately,
  // and an untyped lookup files BOTH rows under their own keys while
  // `posterPathKey(id)` reads the movie one — so a show sharing its number with
  // a cached movie would render the movie's poster. `?type=` wins when the
  // linking surface sent it; otherwise the type the stats resolved to (the
  // heatmap popover links without `?type=`).
  const posterMediaType = mediaType ?? stats.mediaType;
  const posterSrc =
    (await resolvePosterMap([{ tmdbId, mediaType: posterMediaType }]))[
      posterPathKey(tmdbId, posterMediaType)
    ] ?? null;

  // Per-play distributions getMediaPlayStats doesn't aggregate — derived from
  // the recent-plays sample (≤50 rows), labelled "recent sample" in the UI.
  const completionCounts = [0, 0, 0, 0, 0];
  const platformMap = new Map<string, number>();
  let watchedCount = 0;
  for (const p of stats.recentPlays) {
    if (p.watched) watchedCount += 1;
    if (p.platform) {
      platformMap.set(p.platform, (platformMap.get(p.platform) ?? 0) + 1);
    }
    const pct =
      p.duration > 0 ? (p.playDuration / p.duration) * 100 : 0;
    const idx =
      pct >= 95 ? 4 : pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0;
    completionCounts[idx] += 1;
  }
  const completionHist = COMPLETION_BUCKETS.map((label, i) => ({
    label,
    count: completionCounts[i],
  }));
  const platforms = [...platformMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const data: TitleDetailData = {
    tmdbId,
    title: stats.title,
    posterSrc,
    mediaType: stats.mediaType,
    year: stats.year,
    totalPlays: stats.totalPlays,
    uniqueViewers: stats.uniqueViewers,
    avgCompletion: stats.avgCompletion,
    watchedCount,
    recentSampleSize: stats.recentPlays.length,
    libraryHref: stats.mediaType === "TV" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`,
    topViewers: stats.topViewers,
    transcodeRatio: stats.transcodeRatio,
    resolutionBreakdown: stats.resolutionBreakdown,
    platforms,
    completionHist,
    playsByDay: padPlaysByDay(stats.playsByDay, PLAYS_BY_DAY_WINDOW_DAYS),
    recentPlays: stats.recentPlays.slice(0, 14).map((p) => ({
      id: p.id,
      username: p.mediaServerUser.username,
      userSource: p.mediaServerUser.source,
      mediaServerUserId: p.mediaServerUserId,
      seasonNumber: p.seasonNumber,
      episodeNumber: p.episodeNumber,
      resolution: p.resolution,
      videoCodec: p.videoCodec,
      platform: p.platform,
      playMethod: p.playMethod,
      videoDecision: p.videoDecision,
      audioDecision: p.audioDecision,
      playDuration: p.playDuration,
      startedAtIso: p.startedAt.toISOString(),
    })),
  };

  return <TitleDetailView data={data} />;
}
