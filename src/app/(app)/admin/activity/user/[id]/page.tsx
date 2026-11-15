import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { getUserPlayStats } from "@/lib/play-history";
import { zonedTodayIso } from "@/lib/stats-time-zone";
import { sharePct } from "@/lib/activity-stats-view";
import { resolvePosterMap, posterSrcFor } from "@/lib/poster-cache";
import { getTranslator } from "@/lib/i18n/server";
import { collectUnmappedPairs, resolveUnmappedEntry } from "@/lib/activity-title-resolve";
import { resolveTitlesToTmdb } from "@/lib/activity-title-resolve-data";
import {
  UserDetailView,
  type UserDetailData,
} from "@/components/admin/activity-user-detail";

export const dynamic = "force-dynamic";

// The known-IP table lists the most recently seen addresses only: a mobile
// viewer can collect hundreds, and every one was sent to the client as a row.
const KNOWN_IPS_SHOWN = 50;

// Every address the viewer played from, newest sighting first.
function knownIpRows(
  groups: readonly { ipAddress: string | null; _count: { _all: number }; _max: { startedAt: Date | null } }[],
): { ip: string; plays: number; lastSeenIso: string | null }[] {
  return groups
    .filter((g): g is typeof g & { ipAddress: string } => !!g.ipAddress)
    .map((g) => ({ ip: g.ipAddress, plays: g._count._all, lastSeenIso: g._max.startedAt?.toISOString() ?? null }))
    .sort(
      (a, b) =>
        (b.lastSeenIso ? Date.parse(b.lastSeenIso) : 0) -
        (a.lastSeenIso ? Date.parse(a.lastSeenIso) : 0),
    );
}

// The share of ALL the user's plays that played direct, or null with no plays —
// the same rule as the Users list's Direct % (getAllUsersStats).
function directPlayPercent(ratio: readonly { method: string; count: number }[]): number | null {
  const direct = ratio.find((r) => r.method === "DirectPlay")?.count ?? 0;
  const total = ratio.reduce((n, r) => n + r.count, 0);
  return total > 0 ? sharePct(direct, total) : null;
}

export default async function UserActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { id } = await params;
  const t = await getTranslator();

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
  const allKnownIps = knownIpRows(ipGroups);
  // The count stays exact (the group-by already has every address); only the
  // rows sent to the client are capped, newest first.
  const knownIps = allKnownIps.slice(0, KNOWN_IPS_SHOWN);

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
  // The overview's own reads (activity-title-resolve-data.ts): the newest
  // resolved play per pair, then — a title may be in a library but never
  // resolved on any play — the library tables, where a title held under two
  // tmdbIds stays unlinked rather than guessed.
  const recentPlaysSlice = stats.recentPlays.slice(0, 12);
  const titleResolved = await resolveTitlesToTmdb(
    collectUnmappedPairs([...stats.topMedia, ...recentPlaysSlice]),
    { libraryFallback: true },
  );
  const resolvedTopMedia = stats.topMedia.map((m) => resolveUnmappedEntry(m, titleResolved));

  const topMediaPosters = await resolvePosterMap(resolvedTopMedia);

  const directPct = directPlayPercent(stats.transcodeRatio);

  const data: UserDetailData = {
    userId: id,
    username: msUser.username,
    source: msUser.source,
    linkedLabel: msUser.user
      ? t("adminActivity.user.linkedTo", { name: msUser.user.name ?? msUser.user.email ?? "" })
      : null,
    email: msUser.email,
    // Identity state the server-users table already shows (guardrails 28/34):
    // a departed row and a hand-pinned binding must read differently from a
    // live auto-linked one on the page the history-link debug route lands on.
    active: msUser.active,
    manualUserLink: msUser.manualUserLink,
    totalPlays: stats.totalPlays,
    totalWatchTimeHours: stats.totalWatchTimeHours,
    avgSessionDuration: stats.avgSessionDuration,
    directPct,
    lastActiveIso: stats.recentPlays[0]?.startedAt.toISOString() ?? null,
    activityCalendar: stats.activityCalendar,
    todayIso: zonedTodayIso(new Date(), stats.timeZone),
    timeZone: stats.timeZone,
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
      posterSrc: posterSrcFor(topMediaPosters, m.tmdbId, m.mediaType, m.posterPath),
    })),
    knownIps,
    knownIpTotal: allKnownIps.length,
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
