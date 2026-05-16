import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getUserPlayStats } from "@/lib/play-history";
import { resolvePosterMap } from "@/lib/poster-cache";
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
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { id } = await params;

  const msUser = await prisma.mediaServerUser.findUnique({
    where: { id },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!msUser) notFound();

  const stats = await getUserPlayStats(id);

  const ipGroups = await prisma.playHistory.groupBy({
    by: ["ipAddress"],
    where: { mediaServerUserId: id, ipAddress: { not: null } },
    _count: { _all: true },
    _max: { startedAt: true },
  });
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

  const topMediaPosters = await resolvePosterMap(stats.topMedia);

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
    topMedia: stats.topMedia.map((m) => ({
      ...m,
      posterSrc: m.tmdbId != null ? topMediaPosters[m.tmdbId] ?? null : null,
    })),
    knownIps,
    recentPlays: stats.recentPlays.slice(0, 12).map((p) => ({
      id: p.id,
      title: p.title,
      tmdbId: p.tmdbId,
      mediaType: p.mediaType,
      seasonNumber: p.seasonNumber,
      episodeNumber: p.episodeNumber,
      resolution: p.resolution,
      videoCodec: p.videoCodec,
      startedAtIso: p.startedAt.toISOString(),
    })),
  };

  return <UserDetailView data={data} />;
}
