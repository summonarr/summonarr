import { authActive } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { getMediaPlayStats } from "@/lib/play-history";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import { prisma } from "@/lib/prisma";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { first, type PageSearchParams } from "@/lib/search-params";
import { dominantMediaType, parseTitleMediaType, sampleDistributions } from "@/lib/activity-title-detail";
import {
  TitleDetailView,
  type TitleDetailData,
} from "@/components/admin/activity-title-detail";

export const dynamic = "force-dynamic";

export default async function MediaActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { tmdbId: tmdbIdStr } = await params;
  // Canonical digits only, inside INT4 (the column's range: past it Postgres
  // throws, a 500).
  const tmdbId = parseTmdbIdParam(tmdbIdStr);
  if (tmdbId === null || !isTmdbIdInRange(tmdbId)) notFound();

  // TMDB ids are namespaced per type, so a movie and a show can share one id.
  // When the linking surface passes ?type=, scope the stats to that media type.
  const mediaType = parseTitleMediaType(first((await searchParams).type));
  // Untyped, and the id has plays as a film AND as a show: the stats would add
  // the two titles together and link the library to whichever won, so go to
  // the typed page of the one with more plays.
  if (!mediaType) {
    const typed = await prisma.playHistory.groupBy({
      by: ["mediaType"],
      where: { tmdbId, mediaType: { not: null } },
      _count: { _all: true },
    });
    const dominant = dominantMediaType(typed.map((g) => ({ mediaType: g.mediaType, count: g._count._all })));
    if (dominant) redirect(`/admin/activity/media/${tmdbId}?type=${dominant}`);
  }

  const stats = await getMediaPlayStats(tmdbId, mediaType);
  // No plays at all AND not in any library (an unknown id, a negative one) is
  // a 404, not a dashboard headed "TMDB 999999999" with three empty charts and
  // an "Open in library" button to a page that may not exist. A library title
  // with no plays yet still renders, empty: the now-playing card and the user
  // page link here for a title whose first play has not been recorded.
  if (stats.totalPlays === 0 && stats.recentPlays.length === 0 && !stats.inLibrary) notFound();

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
  const { watchedCount, completionHist, platforms } = sampleDistributions(stats.recentPlays);

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
    timeZone: stats.timeZone,
    topViewers: stats.topViewers,
    transcodeRatio: stats.transcodeRatio,
    resolutionBreakdown: stats.resolutionBreakdown,
    platforms,
    completionHist,
    // Already one entry per day of the 90-day window, in the statistics zone
    // (getMediaPlayStats pads it like its siblings): AreaChart positions points
    // by index and draws nothing for fewer than two, so gaps must be zeros.
    playsByDay: stats.playsByDay,
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
