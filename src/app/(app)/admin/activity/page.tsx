import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getPlayHistoryStats, getMostRewatched, getActivityCalendar } from "@/lib/play-history";
import { PageHeader, BarChart } from "@/components/ui/design";
import { ActivityNowPlaying } from "@/components/admin/activity-now-playing";
import { ActivityCharts } from "@/components/admin/activity-charts";
import { ActivityRecentPlays } from "@/components/admin/activity-recent-plays";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityHistoryTable } from "@/components/admin/activity-history-table";
import { ActivityLeaderboard } from "@/components/admin/activity-leaderboard";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import { ActivityWarmButton } from "@/components/admin/activity-warm-button";
import { posterUrl } from "@/lib/tmdb-types";
import { requireFeature, getFeatureFlags } from "@/lib/features";

export const dynamic = "force-dynamic";

function TrendBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return null;
  if (previous === 0)
    return (
      <span
        className="ds-mono"
        style={{ fontSize: 11, color: "var(--ds-success)", marginLeft: 4 }}
      >
        new
      </span>
    );
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return null;
  return (
    <span
      className="ds-mono"
      style={{
        fontSize: 11,
        marginLeft: 4,
        color: pct > 0 ? "var(--ds-success)" : "var(--ds-danger)",
      }}
    >
      {pct > 0 ? "↑" : "↓"}
      {Math.abs(pct)}%
    </span>
  );
}

const activityCardStyle: React.CSSProperties = {
  padding: 14,
  background: "var(--ds-bg-2)",
  border: "1px solid var(--ds-border)",
  borderRadius: 8,
};
const activityCardLabel =
  "ds-mono uppercase";
const activityCardLabelStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: "var(--ds-fg-subtle)",
  letterSpacing: "0.08em",
  margin: "0 0 4px",
};
const activityCardValueStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.02em",
  color: "var(--ds-fg)",
  fontVariantNumeric: "tabular-nums",
  margin: 0,
};

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

  const extraFilters: { template: string; value: unknown }[] = [];
  if (source) extraFilters.push({ template: `"source" = $`, value: source });
  if (mediaType) extraFilters.push({ template: `"mediaType"::text = $`, value: mediaType });

  function withFilters(...baseParams: unknown[]): { sql: string; params: unknown[] } {
    if (extraFilters.length === 0) return { sql: "", params: baseParams };
    // Parameter placeholder indices are 1-based and must start after the already-bound base params
    const offset = baseParams.length;
    const clauses = extraFilters.map((f, i) => `${f.template}${offset + i + 1}`);
    return {
      sql: ` AND ${clauses.join(" AND ")}`,
      params: [...baseParams, ...extraFilters.map((f) => f.value)],
    };
  }

  if (isHistoryTab) {
    return (
      <div className="ds-page-enter">
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

  const prevPeriodStart = new Date(periodCutoff.getTime() - days * 24 * 60 * 60 * 1000);

  const fp = withFilters(periodCutoff);
  const fpp = withFilters(prevPeriodStart, periodCutoff);

  const fpJoin = withFilters(periodCutoff);
  const joinSql = fpJoin.sql.replace(/"source"/g, 'p."source"').replace(/"mediaType"/g, 'p."mediaType"');

  const [uniqueUsersNd, totalWatchTimeNd, watchTimeLeaderboard, mostActiveDay, prevPlays, prevWatchTime] =
    await Promise.all([
      prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(DISTINCT "mediaServerUserId")::bigint AS count
         FROM "PlayHistory" WHERE "startedAt" >= $1${fp.sql}`,
        ...fp.params,
      ),
      prisma.$queryRawUnsafe<{ hours: number | null }[]>(
        `SELECT (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours
         FROM "PlayHistory" WHERE "startedAt" >= $1${fp.sql}`,
        ...fp.params,
      ),
      prisma.$queryRawUnsafe<
        { id: string; username: string; source: string; hours: number | null }[]
      >(
        `WITH user_hours AS (
           SELECT m."id", m."username", m."source", (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours
           FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
           WHERE p."startedAt" >= $1${joinSql}
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
      prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM "PlayHistory" WHERE "startedAt" >= $1 AND "startedAt" < $2${fpp.sql}`,
        ...fpp.params,
      ),
      prisma.$queryRawUnsafe<{ hours: number | null }[]>(
        `SELECT (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours
         FROM "PlayHistory" WHERE "startedAt" >= $1 AND "startedAt" < $2${fpp.sql}`,
        ...fpp.params,
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

  const prevPlaysNum = Number(prevPlays[0]?.count ?? 0);
  const prevWatchTimeNum = Math.round(Number(prevWatchTime[0]?.hours ?? 0) * 10) / 10;

  return (
    <div className="ds-page-enter">
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

      <div
        className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"
        style={{ gap: 10, marginBottom: 24 }}
      >
        <div style={activityCardStyle}>
          <p className={activityCardLabel} style={activityCardLabelStyle}>
            {days}-Day Plays
          </p>
          <div className="flex items-baseline gap-1">
            <p style={activityCardValueStyle}>{stats.totalPlays}</p>
            <TrendBadge current={stats.totalPlays} previous={prevPlaysNum} />
          </div>
          <div style={{ marginTop: 4 }}>
            <BarChart
              data={stats.playsByDay.map(
                (d: (typeof stats.playsByDay)[0]) => d.count,
              )}
              height={24}
            />
          </div>
        </div>
        <div style={activityCardStyle}>
          <p className={activityCardLabel} style={activityCardLabelStyle}>
            {days}-Day Watch Time
          </p>
          <div className="flex items-baseline gap-1">
            <p style={activityCardValueStyle}>
              {Math.round(Number(totalWatchTimeNd[0]?.hours ?? 0))}h
            </p>
            <TrendBadge
              current={Math.round(Number(totalWatchTimeNd[0]?.hours ?? 0))}
              previous={Math.round(prevWatchTimeNum)}
            />
          </div>
          <div style={{ marginTop: 4 }}>
            <BarChart
              data={stats.watchTimeByDay.map(
                (d: (typeof stats.watchTimeByDay)[0]) => d.hours,
              )}
              height={24}
            />
          </div>
        </div>
        <div style={activityCardStyle}>
          <p className={activityCardLabel} style={activityCardLabelStyle}>
            Active Users
          </p>
          <p style={activityCardValueStyle}>
            {Number(uniqueUsersNd[0]?.count ?? 0)}
          </p>
        </div>
        <div style={activityCardStyle}>
          <p className={activityCardLabel} style={activityCardLabelStyle}>
            Completion Rate
          </p>
          <p style={activityCardValueStyle}>{stats.completionRate}%</p>
        </div>
        <div style={activityCardStyle}>
          <p className={activityCardLabel} style={activityCardLabelStyle}>
            Busiest Day
          </p>
          <p
            style={{
              ...activityCardValueStyle,
              fontSize: 16,
            }}
          >
            {mostActiveDay[0]?.day
              ? `${new Date(mostActiveDay[0].day + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${Number(mostActiveDay[0].count)})`
              : "—"}
          </p>
        </div>
        <div style={activityCardStyle}>
          <p className={activityCardLabel} style={activityCardLabelStyle}>
            Avg Bandwidth ({days}d)
          </p>
          <p style={activityCardValueStyle}>
            {stats.avgBitrateMbps > 0 ? `${stats.avgBitrateMbps} Mbps` : "—"}
          </p>
          <p
            className="ds-mono"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              marginTop: 4,
            }}
          >
            {stats.totalBandwidthGB >= 1000
              ? `${(stats.totalBandwidthGB / 1000).toFixed(1)} TB total`
              : `${stats.totalBandwidthGB} GB total`}
          </p>
        </div>
      </div>

      <ActivityCharts stats={stats} days={days} />

      <div
        className="grid grid-cols-1 lg:grid-cols-2"
        style={{ gap: 14, marginBottom: 24 }}
      >
        <ActivityLeaderboard
          byHours={watchTimeLeaderboard.map((u) => ({
            ...u,
            hours: u.hours ?? 0,
          }))}
          byPlays={stats.topUsers}
          days={days}
        />
        {mostRewatched.length > 0 && (
          <section
            style={{
              padding: 20,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 10,
            }}
          >
            <h3
              className="font-semibold"
              style={{
                fontSize: 14,
                letterSpacing: "-0.01em",
                color: "var(--ds-fg)",
                margin: "0 0 12px",
              }}
            >
              Most Rewatched
            </h3>
            <div className="flex flex-col" style={{ gap: 8 }}>
              {mostRewatched.map((m: (typeof mostRewatched)[0], i: number) => {
                const maxPlays = mostRewatched[0]?.plays ?? 1;
                const href =
                  m.mediaType === "TV"
                    ? `/tv/${m.tmdbId}`
                    : `/movie/${m.tmdbId}`;
                const activityHref = `/admin/activity/media/${m.tmdbId}`;
                return (
                  <div
                    key={`${m.tmdbId}-${i}`}
                    className="flex items-center"
                    style={{ gap: 12 }}
                  >
                    <span
                      className="ds-mono text-right"
                      style={{
                        width: 20,
                        fontSize: 11,
                        color: "var(--ds-fg-disabled)",
                      }}
                    >
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div
                        className="flex items-center justify-between"
                        style={{ fontSize: 13, marginBottom: 2 }}
                      >
                        <div
                          className="flex items-center min-w-0"
                          style={{ gap: 8 }}
                        >
                          <Link
                            href={href}
                            className="truncate transition-colors"
                            style={{ color: "var(--ds-fg)" }}
                          >
                            {m.title}
                          </Link>
                          <Link
                            href={activityHref}
                            className="ds-mono shrink-0 transition-colors"
                            style={{
                              fontSize: 10,
                              color: "var(--ds-fg-subtle)",
                            }}
                          >
                            activity
                          </Link>
                        </div>
                        <span
                          className="ds-mono shrink-0"
                          style={{
                            fontSize: 11,
                            marginLeft: 8,
                            color: "var(--ds-fg-muted)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {m.plays} plays · {m.viewers} viewers
                        </span>
                      </div>
                      <div
                        className="overflow-hidden"
                        style={{
                          height: 5,
                          background: "var(--ds-bg-3)",
                          borderRadius: 999,
                        }}
                      >
                        <div
                          className="h-full"
                          style={{
                            width: `${maxPlays > 0 ? (m.plays / maxPlays) * 100 : 0}%`,
                            background: "var(--ds-accent)",
                            borderRadius: 999,
                          }}
                        />
                      </div>
                      <span
                        className="ds-mono"
                        style={{
                          fontSize: 10,
                          color: "var(--ds-fg-disabled)",
                        }}
                      >
                        {m.mediaType}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {showActivityCalendar && calendarData.length > 0 && (
        <section
          style={{
            padding: 20,
            background: "var(--ds-bg-2)",
            border: "1px solid var(--ds-border)",
            borderRadius: 10,
            marginBottom: 24,
          }}
        >
          <h2
            className="font-semibold"
            style={{
              fontSize: 14,
              letterSpacing: "-0.01em",
              color: "var(--ds-fg)",
              margin: "0 0 14px",
            }}
          >
            365-Day Activity
          </h2>
          <ActivityCalendar data={calendarData} />
        </section>
      )}

      <ActivityRecentPlays
        key={`rp-${days}-${source ?? ""}-${mediaType ?? ""}`}
        plays={serializedRecentPlays}
        source={source}
        mediaType={mediaType}
        days={days}
      />
    </div>
  );
}
