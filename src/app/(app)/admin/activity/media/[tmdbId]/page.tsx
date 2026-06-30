import { authActive } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getMediaPlayStats } from "@/lib/play-history";
import { resolvePosterMap } from "@/lib/poster-cache";
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
  const posterSrc = (await resolvePosterMap([{ tmdbId }]))[tmdbId] ?? null;

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
    libraryHref: stats.mediaType === "TV" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`,
    topViewers: stats.topViewers,
    transcodeRatio: stats.transcodeRatio,
    resolutionBreakdown: stats.resolutionBreakdown,
    platforms,
    completionHist,
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
