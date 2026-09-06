import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getUserPlayStats } from "@/lib/play-history";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import { posterUrl } from "@/lib/tmdb-types";
import {
  addTitleResolutions,
  collectUnmappedPairs,
  resolveUnmappedEntry,
  titleWhereDisjuncts,
  unresolvedPairs,
  type TitleResolveMap,
} from "@/lib/activity-title-resolve";
import {
  UserDetailView,
  type UserDetailData,
} from "@/components/admin/activity-user-detail";

export const dynamic = "force-dynamic";

export default async function UserActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { id } = await params;

  // All three are independent side-effect-free reads keyed on the same id, so
  // run them concurrently; the notFound() check moves after the batch.
  const [msUser, stats, ipGroups] = await Promise.all([
    prisma.mediaServerUser.findUnique({
      where: { id },
      include: { user: { select: { name: true, email: true } } },
    }),
    getUserPlayStats(id),
    prisma.playHistory.groupBy({
      by: ["ipAddress"],
      where: { mediaServerUserId: id, ipAddress: { not: null } },
      _count: { _all: true },
      _max: { startedAt: true },
    }),
  ]);
  if (!msUser) notFound();
  const knownIps = ipGroups
    .filter((g): g is typeof g & { ipAddress: string } => !!g.ipAddress)
    .map((g) => ({
      ip: g.ipAddress,
      plays: g._count._all,
      lastSeenIso: g._max.startedAt?.toISOString() ?? null,
    }))
    .sort(
      (a, b) =>
        (b.lastSeenIso ? Date.parse(b.lastSeenIso) : 0) -
        (a.lastSeenIso ? Date.parse(a.lastSeenIso) : 0),
    );

  // PlayHistory.tmdbId is null for plays unmapped at record time, so those rows
  // render with no media link (and no cover art). The same title was often
  // resolved on another play — match against those rows so the link target and
  // poster lookup both work.
  //
  // The match is scoped on (title, mediaType), never bare title — a same-titled
  // movie/series pair (Fargo, Westworld, Scream) would otherwise relink a TV
  // play to the movie and produce `/media/<movieId>?type=TV`. The keying and
  // the `where` fragments both come from activity-title-resolve.ts so they
  // cannot drift apart; a play's own non-null mediaType is never overwritten.
  const recentPlaysSlice = stats.recentPlays.slice(0, 12);
  const unmappedPairs = collectUnmappedPairs([...stats.topMedia, ...recentPlaysSlice]);
  const titleResolved: TitleResolveMap = {};
  if (unmappedPairs.length > 0) {
    const matches = await prisma.playHistory.findMany({
      where: {
        OR: titleWhereDisjuncts(unmappedPairs).map((d) => ({ ...d, tmdbId: { not: null } })),
      },
      distinct: ["title", "mediaType"],
      orderBy: { startedAt: "desc" },
      select: { title: true, tmdbId: true, mediaType: true },
    });
    addTitleResolutions(titleResolved, matches);

    // A title may be in a library but never resolved on any *play* (so the
    // PlayHistory match above misses it). The library tables are an
    // authoritative title→tmdbId mapping — use them so the title still links.
    const stillUnmapped = unresolvedPairs(titleResolved, unmappedPairs);
    if (stillUnmapped.length > 0) {
      const libraryWhere = { OR: titleWhereDisjuncts(stillUnmapped) };
      const [plexLib, jellyfinLib] = await Promise.all([
        prisma.plexLibraryItem.findMany({
          where: libraryWhere,
          select: { title: true, tmdbId: true, mediaType: true },
        }),
        prisma.jellyfinLibraryItem.findMany({
          where: libraryWhere,
          select: { title: true, tmdbId: true, mediaType: true },
        }),
      ]);
      addTitleResolutions(titleResolved, [...plexLib, ...jellyfinLib]);
    }
  }
  const resolvedTopMedia = stats.topMedia.map((m) => resolveUnmappedEntry(m, titleResolved));

  const topMediaPosters = await resolvePosterMap(resolvedTopMedia);

  const directPlays =
    stats.transcodeRatio.find((r) => r.method === "DirectPlay")?.count ?? 0;
  const totalWithMethod = stats.transcodeRatio.reduce(
    (s, r) => s + r.count,
    0,
  );
  const directPct =
    totalWithMethod > 0
      ? Math.round((directPlays / totalWithMethod) * 100)
      : null;

  const data: UserDetailData = {
    userId: id,
    username: msUser.username,
    source: msUser.source,
    linkedLabel: msUser.user
      ? `Linked to ${msUser.user.name ?? msUser.user.email}`
      : null,
    email: msUser.email,
    totalPlays: stats.totalPlays,
    totalWatchTimeHours: stats.totalWatchTimeHours,
    avgSessionDuration: stats.avgSessionDuration,
    directPct,
    lastActiveIso: stats.recentPlays[0]?.startedAt.toISOString() ?? null,
    activityCalendar: stats.activityCalendar,
    todayIso: new Date().toISOString(),
    playsByDay: stats.playsByDay,
    userHeatmap: stats.userHeatmap,
    platformBreakdown: stats.platformBreakdown,
    resolutionBreakdown: stats.resolutionBreakdown,
    deviceList: stats.deviceList,
    transcodeRatio: stats.transcodeRatio,
    topMedia: resolvedTopMedia.map((m) => ({
      title: m.title,
      tmdbId: m.tmdbId,
      mediaType: m.mediaType,
      count: m.count,
      // Live TmdbCache (resolvePosterMap) is authoritative and current; the
      // PlayHistory.posterPath snapshot is null for older rows and stale if the
      // poster later changed. Prefer the cache, fall back to the snapshot only
      // for titles no longer cached. (f1d609a preferred the snapshot, which
      // regressed cover art here.)
      posterSrc:
        (m.tmdbId != null ? topMediaPosters[posterPathKey(m.tmdbId, m.mediaType)] : undefined) ??
        (m.posterPath ? posterUrl(m.posterPath, "w342") : null),
    })),
    knownIps,
    recentPlays: recentPlaysSlice.map((p) => {
      const r = resolveUnmappedEntry(p, titleResolved);
      return {
        id: p.id,
        title: p.title,
        tmdbId: r.tmdbId,
        mediaType: r.mediaType,
        seasonNumber: p.seasonNumber,
        episodeNumber: p.episodeNumber,
        resolution: p.resolution,
        videoCodec: p.videoCodec,
        startedAtIso: p.startedAt.toISOString(),
      };
    }),
  };

  return <UserDetailView data={data} />;
}
