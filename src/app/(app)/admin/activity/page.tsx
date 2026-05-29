import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getPlayHistoryStats, getMostRewatched, getActivityCalendar, appendPlayHistoryFilter } from "@/lib/play-history";
import { PageHeader } from "@/components/ui/design";
import { ActivityNowPlaying } from "@/components/admin/activity-now-playing";
import {
  KpiStrip,
  AnalyticsRow,
  Leaderboards,
  CalendarSection,
  type Kpi,
} from "@/components/admin/activity-sections";
import { ActivityRecentPlays } from "@/components/admin/activity-recent-plays";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityHistoryTable } from "@/components/admin/activity-history-table";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import { ActivityWarmButton } from "@/components/admin/activity-warm-button";
import { ActivityLiveRefresher } from "@/components/admin/activity-live-refresher";
import { posterUrl } from "@/lib/tmdb-types";
import { resolvePosterMap } from "@/lib/poster-cache";
import { requireFeature, getFeatureFlags } from "@/lib/features";

export const dynamic = "force-dynamic";

// Period-over-period delta for a KPI cell. Mirrors the old TrendBadge logic
// so the redesigned strip keeps the same up/down/new semantics.
function kpiDelta(
  current: number,
  previous: number,
): Kpi["delta"] {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { text: "new", dir: "up" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" };
  return { text: `${Math.abs(pct)}%`, dir: pct > 0 ? "up" : "down" };
}

// Deterministic from a fixed YYYY-MM-DD string — not Date.now()/new Date()
// in a client render path, so this is safe in the server component.
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const HEATMAP_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; source?: string; mediaType?: string; tab?: string }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const featureFlags = await getFeatureFlags();
  const showActiveSessions   = featureFlags["feature.behavior.activeSessions"] !== false;
  const showActivityCalendar = featureFlags["feature.behavior.activityCalendar"] !== false;

  const { days: daysParam, source: sourceParam, mediaType: mediaTypeParam, tab } = await searchParams;
  const isHistoryTab = tab === "history";
  const days = Math.min(Math.max(parseInt(daysParam ?? "30", 10) || 30, 1), 3650);
  const source = sourceParam && ["plex", "jellyfin"].includes(sourceParam) ? sourceParam : undefined;
  const mediaType = mediaTypeParam && ["MOVIE", "TV"].includes(mediaTypeParam) ? mediaTypeParam : undefined;

  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const periodCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (isHistoryTab) {
    return (
      <div className="ds-page-enter">
        <ActivityLiveRefresher />
        <PageHeader
          title="Activity"
          subtitle="Play history and server activity monitoring"
        />
        <ActivityFilterBar />
        <ActivityHistoryTable
          key={`ht-${days}-${source ?? ""}-${mediaType ?? ""}`}
          source={source}
          mediaType={mediaType}
          days={days}
          startDateIso={periodCutoff.toISOString()}
        />
      </div>
    );
  }

  const prismaWhere: Record<string, unknown> = { startedAt: { gte: periodCutoff } };
  if (source) prismaWhere.source = source;
  if (mediaType) prismaWhere.mediaType = mediaType as "MOVIE" | "TV";

  const [stats, activeSessions, recentPlays, mostRewatched, calendarData] = await Promise.all([
    getPlayHistoryStats({ days, source, mediaType }),
    prisma.activeSession.findMany({
      ...(source || mediaType
        ? { where: { ...(source ? { source } : {}), ...(mediaType ? { mediaType } : {}) } }
        : {}),
      orderBy: { startedAt: "desc" },
    }),
    prisma.playHistory.findMany({
      where: prismaWhere,
      orderBy: { startedAt: "desc" },
      take: 20,
      include: {
        mediaServerUser: {
          select: { username: true, source: true, thumbUrl: true },
        },
      },
    }),
    getMostRewatched({ days, source, mediaType }, 10),
    getActivityCalendar(source, mediaType),
  ]);

  // Inline raw queries here used to re-compute uniqueViewers / totalWatchTimeHours
  // and prevPeriod totals that getPlayHistoryStats already returns above. Removed
  // the four duplicates — only the window-function leaderboard and the peak-day
  // pick remain (genuinely unique to this page).
  const fp = appendPlayHistoryFilter([periodCutoff], { source, mediaType });
  const fpJoin = appendPlayHistoryFilter([periodCutoff], { source, mediaType, tableAlias: "p" });

  const [watchTimeLeaderboard, mostActiveDay] = await Promise.all([
    prisma.$queryRawUnsafe<
      { id: string; username: string; source: string; hours: number | null }[]
    >(
      `WITH user_hours AS (
         SELECT m."id", m."username", m."source", (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours
         FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
         WHERE p."startedAt" >= $1${fpJoin.sql}
         GROUP BY m."id", m."username", m."source"
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY "source" ORDER BY "hours" DESC) AS rn
         FROM user_hours
       )
       SELECT "id", "username", "source", "hours"
       FROM ranked
       WHERE rn <= 10
       ORDER BY "hours" DESC`,
      ...fpJoin.params,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "startedAt" >= $1${fp.sql}
       GROUP BY day ORDER BY count DESC LIMIT 1`,
      ...fp.params,
    ),
  ]);

  const resolvedTmdb: Record<string, { tmdbId: number; mediaType: string }> = {};
  const sessionsNeedingTmdb = activeSessions.filter((s: typeof activeSessions[0]) => s.tmdbId == null);

  if (sessionsNeedingTmdb.length > 0) {
    const sourceItemIds = sessionsNeedingTmdb
      .filter((s: typeof sessionsNeedingTmdb[0]) => s.sourceItemId)
      .map((s: typeof sessionsNeedingTmdb[0]) => s.sourceItemId!);

    if (sourceItemIds.length > 0) {
      const historyMatches = await prisma.playHistory.findMany({
        where: { sourceItemId: { in: sourceItemIds }, tmdbId: { not: null } },
        distinct: ["sourceItemId"],
        orderBy: { startedAt: "desc" },
        select: { sourceItemId: true, tmdbId: true, mediaType: true },
      });
      for (const h of historyMatches) {
        if (h.sourceItemId && h.tmdbId != null) {
          resolvedTmdb[`item:${h.sourceItemId}`] = { tmdbId: h.tmdbId, mediaType: h.mediaType ?? "TV" };
        }
      }
    }

    const stillNeedLibrary = sessionsNeedingTmdb.filter(
      (s: typeof sessionsNeedingTmdb[0]) => s.sourceItemId && !resolvedTmdb[`item:${s.sourceItemId}`],
    );
    if (stillNeedLibrary.length > 0) {
      const plexKeys = stillNeedLibrary.filter((s: typeof stillNeedLibrary[0]) => s.source === "plex").map((s: typeof stillNeedLibrary[0]) => s.sourceItemId!);
      const jellyfinKeys = stillNeedLibrary.filter((s: typeof stillNeedLibrary[0]) => s.source === "jellyfin").map((s: typeof stillNeedLibrary[0]) => s.sourceItemId!);
      const [plexItems, jellyfinItems] = await Promise.all([
        plexKeys.length > 0
          ? prisma.plexLibraryItem.findMany({
              where: { plexRatingKey: { in: plexKeys } },
              select: { tmdbId: true, mediaType: true, plexRatingKey: true },
            })
          : [],
        jellyfinKeys.length > 0
          ? prisma.jellyfinLibraryItem.findMany({
              where: { jellyfinItemId: { in: jellyfinKeys } },
              select: { tmdbId: true, mediaType: true, jellyfinItemId: true },
            })
          : [],
      ]);
      for (const i of plexItems) {
        if (i.plexRatingKey) resolvedTmdb[`item:${i.plexRatingKey}`] = { tmdbId: i.tmdbId, mediaType: i.mediaType };
      }
      for (const i of jellyfinItems) {
        if (i.jellyfinItemId) resolvedTmdb[`item:${i.jellyfinItemId}`] = { tmdbId: i.tmdbId, mediaType: i.mediaType };
      }
    }

    const stillNeedTitle = sessionsNeedingTmdb.filter(
      (s: typeof sessionsNeedingTmdb[0]) => !(s.sourceItemId && resolvedTmdb[`item:${s.sourceItemId}`]),
    );
    if (stillNeedTitle.length > 0) {
      const titles = [...new Set(stillNeedTitle.map((s: typeof stillNeedTitle[0]) => s.title))];
      const titleMatches = await prisma.playHistory.findMany({
        where: { title: { in: titles }, tmdbId: { not: null } },
        distinct: ["title"],
        orderBy: { startedAt: "desc" },
        select: { title: true, tmdbId: true, mediaType: true },
      });
      for (const h of titleMatches) {
        if (h.tmdbId != null) {
          resolvedTmdb[`title:${h.title}`] = { tmdbId: h.tmdbId, mediaType: h.mediaType ?? "TV" };
        }
      }
    }
  }

  const effectiveSessions = activeSessions.map((s: typeof activeSessions[0]) => {
    if (s.tmdbId != null) return { ...s, effectiveTmdbId: s.tmdbId, effectiveMediaType: s.mediaType };
    const resolved =
      (s.sourceItemId ? resolvedTmdb[`item:${s.sourceItemId}`] : undefined)
      ?? resolvedTmdb[`title:${s.title}`];
    return {
      ...s,
      effectiveTmdbId: resolved?.tmdbId ?? null,
      effectiveMediaType: resolved?.mediaType ?? s.mediaType,
    };
  });

  const sessionsToBackfill = effectiveSessions.filter(
    (s: typeof effectiveSessions[0]) => s.tmdbId == null && s.effectiveTmdbId != null,
  );
  // INTENTIONAL fire-and-forget: persist the resolved tmdbId so future renders
  // skip the lookup chain. Deliberately NOT awaited — it's a cache warm, not
  // part of the response, and must not delay the page. Safe because Summonarr
  // runs as a single long-lived Node server (not serverless/edge), so the
  // promise survives past render. Do NOT "fix" this by awaiting it or moving it
  // into the request path. See CLAUDE.md guardrail 17. Errors are swallowed by
  // design (next sync re-resolves).
  if (sessionsToBackfill.length > 0) {
    void Promise.all(
      sessionsToBackfill.map((s: typeof sessionsToBackfill[0]) =>
        prisma.activeSession.update({
          where: { id: s.id },
          data: { tmdbId: s.effectiveTmdbId, mediaType: s.effectiveMediaType },
        }).catch(() => {}),
      ),
    ).catch(() => {});
  }

  const posterMap: Record<number, string | null> = {};
  const sessionTmdbIds = [...new Set(effectiveSessions.map((s: typeof effectiveSessions[0]) => s.effectiveTmdbId).filter((id): id is number => id != null))];
  if (sessionTmdbIds.length > 0) {
    const cacheKeys = sessionTmdbIds.flatMap((id) => [`movie:${id}:details`, `tv:${id}:details`]);
    const cacheRows = await prisma.tmdbCache.findMany({
      where: { key: { in: cacheKeys } },
      select: { key: true, data: true },
    });
    for (const row of cacheRows) {
      try {
        const parsed = JSON.parse(row.data) as { posterPath?: string | null };
        if (parsed.posterPath) {
          const idStr = row.key.split(":")[1];
          const id = parseInt(idStr, 10);
          if (id && !posterMap[id]) {
            posterMap[id] = posterUrl(parsed.posterPath, "w342");
          }
        }
      } catch { }
    }
  }

  const serializedSessions = effectiveSessions.map((s: typeof effectiveSessions[0]) => ({
    id: s.id,
    source: s.source,
    state: s.state,
    mediaServerUserId: s.mediaServerUserId,
    serverUsername: s.serverUsername,
    title: s.title,
    tmdbId: s.effectiveTmdbId,
    mediaType: s.effectiveMediaType,
    year: s.year,
    seasonNumber: s.seasonNumber,
    episodeNumber: s.episodeNumber,
    episodeTitle: s.episodeTitle,
    progressPercent: s.progressPercent,
    progressMs: Number(s.progressMs),
    durationMs: Number(s.durationMs),
    platform: s.platform,
    player: s.player,
    device: s.device,
    ipAddress: s.ipAddress,
    startedAt: s.startedAt.toISOString(),
    playMethod: s.playMethod,
    videoCodec: s.videoCodec,
    audioCodec: s.audioCodec,
    resolution: s.resolution,
    bitrate: s.bitrate,
    videoDecision: s.videoDecision,
    audioDecision: s.audioDecision,
    container: s.container,
    location: s.location,
    bandwidth: s.bandwidth,
    secure: s.secure,
    relayed: s.relayed,
    introStartMs: s.introStartMs,
    introEndMs: s.introEndMs,
    creditsStartMs: s.creditsStartMs,
    creditsEndMs: s.creditsEndMs,
    posterUrl: s.effectiveTmdbId ? posterMap[s.effectiveTmdbId] ?? null : null,
  }));

  const serializedRecentPlays = recentPlays.map((p: typeof recentPlays[0]) => ({
    id: p.id,
    source: p.source,
    title: p.title,
    tmdbId: p.tmdbId,
    mediaType: p.mediaType,
    startedAt: p.startedAt.toISOString(),
    stoppedAt: p.stoppedAt?.toISOString() ?? null,
    duration: p.duration,
    playDuration: p.playDuration,
    pausedDuration: p.pausedDuration,
    watched: p.watched,
    platform: p.platform,
    player: p.player,
    device: p.device,
    ipAddress: p.ipAddress,
    playMethod: p.playMethod,
    resolution: p.resolution,
    videoCodec: p.videoCodec,
    audioCodec: p.audioCodec,
    bitrate: p.bitrate,
    container: p.container,
    videoDecision: p.videoDecision,
    audioDecision: p.audioDecision,
    seasonNumber: p.seasonNumber,
    episodeNumber: p.episodeNumber,
    episodeTitle: p.episodeTitle,
    mediaServerUserId: p.mediaServerUserId,
    username: p.mediaServerUser.username,
    userSource: p.mediaServerUser.source,
    userThumb: p.mediaServerUser.thumbUrl,
  }));

  // prevPeriod and current-period totals come from stats (getPlayHistoryStats already computes them).
  const prevPlaysNum = stats.prevPeriod?.totalPlays ?? 0;
  const prevWatchTimeNum = stats.prevPeriod?.totalWatchTimeHours ?? 0;

  /* ── Derived props for the refined overview sections ──────────── */

  const watchHoursNd = Math.round(stats.totalWatchTimeHours);
  const activeUsersNd = stats.uniqueViewers;
  const busiestDay = mostActiveDay[0];

  const kpis: Kpi[] = [
    {
      label: `${days}-day plays`,
      value: stats.totalPlays.toLocaleString(),
      delta: kpiDelta(stats.totalPlays, prevPlaysNum),
      spark: stats.playsByDay.map((d) => d.count),
      sparkLabels: stats.playsByDay.map((d) => shortDay(d.day)),
      sparkSuffix: " plays",
    },
    {
      label: "Watch time",
      value: `${watchHoursNd.toLocaleString()}h`,
      delta: kpiDelta(watchHoursNd, Math.round(prevWatchTimeNum)),
      spark: stats.watchTimeByDay.map((d) => d.hours),
      sparkLabels: stats.watchTimeByDay.map((d) => shortDay(d.day)),
      sparkSuffix: "h",
    },
    {
      label: "Active users",
      value: activeUsersNd.toLocaleString(),
      delta: kpiDelta(activeUsersNd, stats.prevPeriod?.uniqueViewers ?? 0),
    },
    {
      label: "Completion rate",
      value: `${stats.completionRate}%`,
    },
    {
      label: "Busiest day",
      value: busiestDay?.day ? shortDay(busiestDay.day) : "—",
      sub: busiestDay?.day
        ? `${Number(busiestDay.count).toLocaleString()} plays`
        : undefined,
    },
    {
      label: "Bandwidth",
      value: stats.avgBitrateMbps > 0 ? `${stats.avgBitrateMbps} Mbps` : "—",
      sub:
        stats.totalBandwidthGB >= 1000
          ? `${(stats.totalBandwidthGB / 1000).toFixed(1)} TB total`
          : `${stats.totalBandwidthGB} GB total`,
    },
  ];

  // Postgres EXTRACT(DOW) is 0=Sun..6=Sat; the design heatmap rows are
  // Mon-first, so dow d maps to row (d + 6) % 7.
  const heatmapMatrix = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  for (const cell of stats.heatmap) {
    if (cell.dow >= 0 && cell.dow < 7 && cell.hour >= 0 && cell.hour < 24) {
      heatmapMatrix[(cell.dow + 6) % 7][cell.hour] = cell.count;
    }
  }
  let peakRow = -1;
  let peakHour = -1;
  let peakVal = 0;
  heatmapMatrix.forEach((row, ri) =>
    row.forEach((v, hi) => {
      if (v > peakVal) {
        peakVal = v;
        peakRow = ri;
        peakHour = hi;
      }
    }),
  );
  const heatmapInsight =
    peakVal > 0
      ? `${HEATMAP_DAYS[peakRow]} ${peakHour}:00 is the busiest hour — ${peakVal.toLocaleString()} plays.`
      : "Not enough play history yet to surface a peak hour.";

  const STREAM_LABELS: Record<string, { label: string; color: string }> = {
    DirectPlay: { label: "Direct Play", color: "var(--ds-success)" },
    DirectStream: { label: "Remux", color: "var(--ds-info)" },
    Transcode: { label: "Transcode", color: "var(--ds-warning)" },
  };
  const streamTotal = stats.transcodeRatio.reduce((a, r) => a + r.count, 0);
  const streamMix = [...stats.transcodeRatio]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      label: STREAM_LABELS[r.method]?.label ?? r.method,
      color: STREAM_LABELS[r.method]?.color ?? "var(--ds-fg-subtle)",
      value: r.count.toLocaleString(),
      pct: streamTotal > 0 ? Math.round((r.count / streamTotal) * 100) : 0,
    }));

  const mediaTotal = stats.mediaTypeBreakdown.reduce((a, r) => a + r.count, 0);
  const mediaMix = [...stats.mediaTypeBreakdown]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      label:
        r.type === "TV"
          ? "TV episodes"
          : r.type === "MOVIE"
            ? "Movies"
            : r.type,
      color: r.type === "TV" ? "var(--ds-accent)" : "oklch(0.72 0.10 275)",
      value: r.count.toLocaleString(),
      pct: mediaTotal > 0 ? Math.round((r.count / mediaTotal) * 100) : 0,
    }));

  const axisLabels: string[] = [];
  if (stats.playsByDay.length > 1) {
    const n = stats.playsByDay.length;
    for (let i = 0; i < 5; i++) {
      const idx = Math.round((i / 4) * (n - 1));
      axisLabels.push(shortDay(stats.playsByDay[idx].day));
    }
  }
  const peakSub = busiestDay?.day
    ? `peak ${Number(busiestDay.count).toLocaleString()} on ${shortDay(busiestDay.day)}`
    : "";

  // calendarData is GROUP BY date over the last 365 days, so every row already
  // has count > 0 — activeDays is just the row count, total is their sum.
  // (A real consecutive-day "streak" can't be derived here without the empty
  // days; the stat was removed rather than left silently wrong.)
  let totalCalPlays = 0;
  let activeDays = 0;
  for (const d of calendarData) {
    totalCalPlays += d.count;
    if (d.count > 0) activeDays++;
  }

  const playsById = new Map(stats.topUsers.map((u) => [u.id, u.count]));
  const leaderUsers = watchTimeLeaderboard.slice(0, 8).map((u, i) => ({
    id: u.id,
    username: u.username,
    source: u.source,
    hours: u.hours ?? 0,
    plays: playsById.get(u.id) ?? 0,
    rank: i + 1,
  }));
  const rewatchedSlice = mostRewatched.slice(0, 6);
  const rewatchedPosters = await resolvePosterMap(rewatchedSlice);
  const leaderRewatched = rewatchedSlice.map((m, i) => ({
    tmdbId: m.tmdbId,
    mediaType: m.mediaType,
    title: m.title,
    plays: m.plays,
    viewers: m.viewers,
    rank: i + 1,
    posterSrc: rewatchedPosters[m.tmdbId] ?? null,
  }));

  return (
    <div className="ds-page-enter">
      <ActivityLiveRefresher />
      <PageHeader
        title="Activity"
        subtitle="Play history and server activity monitoring"
        right={<ActivityWarmButton />}
      />

      <ActivityFilterBar />

      {showActiveSessions && (
        <ActivityNowPlaying
          key={`np-${source ?? ""}-${mediaType ?? ""}`}
          initialSessions={serializedSessions}
          source={source}
          mediaType={mediaType}
        />
      )}

      <KpiStrip kpis={kpis} />

      <AnalyticsRow
        playsByDay={stats.playsByDay.map((d) => d.count)}
        playsByDayLabels={stats.playsByDay.map((d) => shortDay(d.day))}
        heatmapMatrix={heatmapMatrix}
        streamMix={streamMix}
        mediaMix={mediaMix}
        days={days}
        peakSub={peakSub}
        axisLabels={axisLabels}
        heatmapInsight={heatmapInsight}
      />

      <Leaderboards
        users={leaderUsers}
        rewatched={leaderRewatched}
        days={days}
      />

      {showActivityCalendar && calendarData.length > 0 && (
        <CalendarSection
          activeDays={activeDays}
          totalPlays={totalCalPlays}
        >
          <ActivityCalendar
            data={calendarData}
            today={new Date().toISOString()}
          />
        </CalendarSection>
      )}

      <ActivityRecentPlays
        key={`rp-${days}-${source ?? ""}-${mediaType ?? ""}`}
        plays={serializedRecentPlays}
        source={source}
        mediaType={mediaType}
        startDateIso={periodCutoff.toISOString()}
      />
    </div>
  );
}
