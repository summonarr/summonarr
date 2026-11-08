import { authActive } from "@/lib/auth";
import { plexSettingKey } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import {
  ACTIVE_SESSION_SNAPSHOT_SELECT,
  serializeActiveSession,
  getPlayHistoryStats,
  getMostRewatched,
  getActivityCalendar,
  getTranscodeOffenders,
  getWatchTimeLeaderboard,
  getBusiestDay,
  isPlayHistoryEnabled,
  isSourceEnabled,
} from "@/lib/play-history";
import { EmptyState, PageHeader } from "@/components/ui/design";
import { Activity } from "@/components/icons";
import { ActivityNowPlaying } from "@/components/admin/activity-now-playing";
import {
  KpiStrip,
  AnalyticsRow,
  Leaderboards,
  CalendarSection,
  type Kpi,
} from "@/components/admin/activity-sections";
import { ActivityRecentPlays } from "@/components/admin/activity-recent-plays";
import { toRecentPlay } from "@/components/admin/recent-plays/map";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import { TranscodePressure } from "@/components/admin/transcode-pressure";
import { ActivityWarmButton } from "@/components/admin/activity-warm-button";
import { toHeatmapMatrix } from "@/components/admin/activity-format";
import { ActivityLiveRefresher } from "@/components/admin/activity-live-refresher";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import { toActivityMediaType } from "@/lib/activity-title-resolve";
import { resolveActiveSessionTmdb } from "@/lib/activity-session-tmdb";
import {
  axisLabelIndices,
  buildMix,
  calendarTotals,
  heatmapPeak,
  kpiDelta,
  plexReachability as buildPlexReachability,
} from "@/lib/activity-overview";
import { requireFeature, getFeatureFlags } from "@/lib/features";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { firstParam, parseActivityFilters, type PageParam } from "@/lib/activity-days";
import { RECENT_PLAYS_PAGE_SIZE } from "@/lib/activity-constants";
import { zoneShortLabel, zonedTodayIso } from "@/lib/stats-time-zone";
import type { Prisma } from "@/generated/prisma";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

// Deterministic from a fixed YYYY-MM-DD string — not Date.now()/new Date()
// in a client render path, so this is safe in the server component.
function shortDay(day: string, locale: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

// The Now-playing backfill's error handler: a session the poller removed
// between the read and the write is the expected race, anything else is said.
function logBackfillFailure(err: unknown): void {
  if (isPrismaErrorCode(err, "P2025")) return;
  console.warn("[activity] session backfill failed:", err instanceof Error ? err.message : String(err));
}

// Catalog keys (Mon-first), translated at render.
const HEATMAP_DAY_KEYS = [
  "adminActivity.weekday.mon",
  "adminActivity.weekday.tue",
  "adminActivity.weekday.wed",
  "adminActivity.weekday.thu",
  "adminActivity.weekday.fri",
  "adminActivity.weekday.sat",
  "adminActivity.weekday.sun",
];

type ActivityPageParams = {
  days?: PageParam;
  source?: PageParam;
  mediaType?: PageParam;
  tab?: PageParam;
  from?: PageParam;
  to?: PageParam;
  watched?: PageParam;
};

// The History tab moved to its own route segment (history/page.tsx) so it gets
// a table-shaped loading.tsx instead of flashing this page's KPI/chart skeleton.
// Older `?tab=history` links — the calendar "View these plays", the recent-plays
// "View history", the play-detail back link, the delete-play redirect — still
// land here and are forwarded with every filter they carried, one value per key
// (a repeated one used to be joined into "a,b").
function historyRedirectTarget(sp: ActivityPageParams): string | null {
  if (firstParam(sp.tab) !== "history") return null;
  const forward = new URLSearchParams();
  for (const k of ["days", "source", "mediaType", "from", "to", "watched"] as const) {
    const v = firstParam(sp[k]);
    if (v) forward.set(k, v);
  }
  const qs = forward.toString();
  return `/admin/activity/history${qs ? `?${qs}` : ""}`;
}

// The KPI strip. prevPeriod and the current-period totals come from stats
// (getPlayHistoryStats already computes them).
function overviewKpis(
  fmt: {
    t: Translator;
    locale: string;
    days: number;
    fmtDay: (day: string) => string;
    dec1: Intl.NumberFormat;
    hoursSuffix: string;
    zoneLabel: string;
  },
  stats: Awaited<ReturnType<typeof getPlayHistoryStats>>,
  busiestDay: Awaited<ReturnType<typeof getBusiestDay>>,
): Kpi[] {
  const { t, locale, days, fmtDay, dec1, hoursSuffix, zoneLabel } = fmt;
  const prevPlaysNum = stats.prevPeriod?.totalPlays ?? 0;
  const prevWatchTimeNum = stats.prevPeriod?.totalWatchTimeHours ?? 0;
  const prevComplete = stats.prevPeriod?.complete ?? false;

  const watchHoursNd = Math.round(stats.totalWatchTimeHours);
  const activeUsersNd = stats.uniqueViewers;
  const newLabel = t("adminActivity.kpi.new");
  return [
    {
      label: t("adminActivity.kpi.dayPlays", { days }),
      value: stats.totalPlays.toLocaleString(locale),
      delta: kpiDelta(newLabel, stats.totalPlays, prevPlaysNum, prevComplete),
      spark: stats.playsByDay.map((d) => d.count),
      sparkLabels: stats.playsByDay.map((d) => fmtDay(d.day)),
      sparkSuffix: t("adminActivity.common.playsSuffix"),
    },
    {
      label: t("adminActivity.kpi.watchTime"),
      value: `${watchHoursNd.toLocaleString(locale)}${hoursSuffix}`,
      // Unrounded on both sides: the cell shows whole hours, the trend compares
      // the real ones.
      delta: kpiDelta(newLabel, stats.totalWatchTimeHours, prevWatchTimeNum, prevComplete),
      spark: stats.watchTimeByDay.map((d) => d.hours),
      sparkLabels: stats.watchTimeByDay.map((d) => fmtDay(d.day)),
      sparkSuffix: hoursSuffix,
    },
    {
      label: t("adminActivity.kpi.activeUsers"),
      value: activeUsersNd.toLocaleString(locale),
      delta: kpiDelta(newLabel, activeUsersNd, stats.prevPeriod?.uniqueViewers ?? 0, prevComplete),
    },
    {
      label: t("adminActivity.kpi.completionRate"),
      value: `${dec1.format(stats.completionRate)}%`,
    },
    {
      label: t("adminActivity.kpi.busiestDay"),
      value: busiestDay?.day ? fmtDay(busiestDay.day) : "—",
      // A day in the statistics zone, like every day bucket on the page (the
      // charts carry the same zone tag).
      sub: busiestDay?.day
        ? `${t("adminActivity.common.playsFormatted", { count: busiestDay.count, n: busiestDay.count.toLocaleString(locale) })} · ${zoneLabel}`
        : undefined,
    },
    {
      label: t("adminActivity.kpi.bandwidth"),
      value: stats.avgBitrateMbps > 0 ? `${dec1.format(stats.avgBitrateMbps)} Mbps` : "—",
      sub:
        stats.totalBandwidthGB >= 1000
          ? t("adminActivity.kpi.total", { amount: `${dec1.format(stats.totalBandwidthGB / 1000)} TB` })
          : t("adminActivity.kpi.total", { amount: `${dec1.format(stats.totalBandwidthGB)} GB` }),
    },
  ];
}

export default async function ActivityPage({
  searchParams,
}: {
  // A repeated key arrives as an array; the parsers below take its first value.
  searchParams: Promise<ActivityPageParams>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  // Read before any data: a section the page won't render runs no query. The
  // Plex server list (one registry row) starts alongside, since it decides which
  // Setting keys the reachability read below asks for; it is only awaited when
  // Now playing shows. The no-op catch marks it handled until then.
  const plexInstancesPromise = getMediaInstances("plex");
  plexInstancesPromise.catch(() => {});
  const [featureFlags, phEnabled] = await Promise.all([getFeatureFlags(), isPlayHistoryEnabled()]);
  const showActiveSessions   = featureFlags["feature.behavior.activeSessions"] !== false;
  const showActivityCalendar = featureFlags["feature.behavior.activityCalendar"] !== false;

  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  const fmtDay = (day: string) => shortDay(day, locale);
  // One decimal, locale-separated: the integers beside these already go through
  // toLocaleString, so a bare toFixed(1) mixed "1.234 plays" with "12.3 Mbps".
  const dec1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const hoursSuffix = t("adminActivity.common.hoursSuffix");

  const sp = await searchParams;

  // The History tab moved to its own route segment (history/page.tsx) so it
  // gets a table-shaped loading.tsx instead of flashing this page's KPI/chart
  // skeleton. Older `?tab=history` links — the calendar "View these plays",
  // the recent-plays "View history", the play-detail back link, the
  // delete-play redirect — still land here and are forwarded with every filter
  // they carried.
  const historyTarget = historyRedirectTarget(sp);
  if (historyTarget) redirect(historyTarget);

  const { days, source, mediaType } = parseActivityFilters(sp);
  const filters = { days, source, mediaType };

  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const periodCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const prismaWhere: Prisma.PlayHistoryWhereInput = {
    startedAt: { gte: periodCutoff },
    ...(source ? { source } : {}),
    ...(mediaType ? { mediaType } : {}),
  };

  // Every aggregate, started now so it overlaps the now-playing work below, and
  // only when play history is recorded: with tracking off the page renders an
  // EmptyState instead of these sections. The calendar is skipped when hidden.
  // The leaderboard and busiest day are memoized in play-history.ts like the
  // rest (guardrail 19b). The no-op catch only marks the promise handled while
  // the session work runs first; the await below still rethrows a failure.
  const aggregates = phEnabled
    ? Promise.all([
        getPlayHistoryStats(filters),
        getMostRewatched(filters, 10),
        showActivityCalendar ? getActivityCalendar(source, mediaType) : Promise.resolve([]),
        getTranscodeOffenders(filters),
        getWatchTimeLeaderboard(filters),
        getBusiestDay(filters),
        prisma.playHistory.findMany({
          where: prismaWhere,
          // This seeds page 1; `ActivityRecentPlays` loads page 2+ from
          // /api/play-history (ungrouped), whose query orders
          // `ORDER BY startedAt DESC, id DESC`. The `id` tiebreak — and its DESC
          // direction — must match so both walk ONE total order: same-poll
          // sessions share a stamped startedAt, and a tie straddling the page-1/2
          // boundary would otherwise repeat one row and silently skip the other.
          // The page size is shared with the card's own page-N requests.
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          take: RECENT_PLAYS_PAGE_SIZE,
          include: {
            mediaServerUser: {
              select: { username: true, source: true, thumbUrl: true },
            },
          },
        }),
      ])
    : null;
  aggregates?.catch(() => {});
  // The rewatched posters resolve as soon as their list does, overlapping the
  // session work and the reads below; awaited where the value is consumed.
  const rewatchedPostersPromise = aggregates?.then(([, mostRewatched]) => resolvePosterMap(mostRewatched.slice(0, 6)));
  rewatchedPostersPromise?.catch(() => {});

  // Which Plex servers exist has to be known BEFORE the batch below, because it
  // determines which Setting keys the reachability read asks for (rather than
  // widening the query to `startsWith: "plex"`). The admin tokens are tested for
  // PRESENCE only, by a key-only read: selecting `value` sent every instance's
  // token through the decryption extension just to render a status chip
  // (guardrail 7a). Now playing hidden ⇒ nothing here is read.
  const plexInstances = showActiveSessions ? await plexInstancesPromise : [];
  const plexStatusKeys = plexInstances.flatMap((i) => [
    plexSettingKey(i.slug, "ServerReachable"),
    plexSettingKey(i.slug, "ServerUrl"),
  ]);
  const plexTokenKeys = plexInstances.map((i) => plexSettingKey(i.slug, "AdminToken"));

  const [activeSessions, plexReachableRows, plexTokenRows, plexSourceEnabled] = await Promise.all([
    showActiveSessions
      ? prisma.activeSession.findMany({
          ...(source || mediaType
            ? { where: { ...(source ? { source } : {}), ...(mediaType ? { mediaType } : {}) } }
            : {}),
          // Match emitActiveSessionsSnapshot's deterministic ordering so the SSR
          // list and the first live SSE push agree (no reorder flash on connect).
          // `id` (immutable PK) breaks the common startedAt ties.
          orderBy: [{ startedAt: "desc" }, { id: "asc" }],
          // The snapshot's columns plus the two the tmdbId lookup keys on.
          select: { ...ACTIVE_SESSION_SNAPSHOT_SELECT, sourceItemId: true, serverInstance: true },
        })
      : Promise.resolve([]),
    plexStatusKeys.length > 0
      ? prisma.setting.findMany({
          where: { key: { in: plexStatusKeys } },
          select: { key: true, value: true },
        })
      : Promise.resolve([] as { key: string; value: string }[]),
    plexTokenKeys.length > 0
      ? prisma.setting.findMany({
          where: { key: { in: plexTokenKeys }, NOT: { value: "" } },
          select: { key: true },
        })
      : Promise.resolve([] as { key: string }[]),
    showActiveSessions ? isSourceEnabled("plex") : Promise.resolve(false),
  ]);

  // The saved reachability snapshot (written by plex-events.persistReachability),
  // worked out per server. The flag is written by the 5s poller and the SSE
  // connect-time probe, which run only while play history and the Plex source
  // are on, so it is trusted only then (activity-overview.ts).
  const plexReachability = buildPlexReachability(
    plexInstances,
    (slug) => ({
      url: plexSettingKey(slug, "ServerUrl"),
      token: plexSettingKey(slug, "AdminToken"),
      reachable: plexSettingKey(slug, "ServerReachable"),
    }),
    new Map(plexReachableRows.map((r) => [r.key, r.value])),
    new Set(plexTokenRows.map((r) => r.key)),
    phEnabled && plexSourceEnabled,
  );

  // The three-step lookup chain (item in history, item in the library, then
  // the title — display only) lives in activity-session-tmdb.ts.
  const effectiveSessions = await resolveActiveSessionTmdb(activeSessions);

  const sessionsToBackfill = effectiveSessions.filter(
    (s): s is typeof s & { backfill: NonNullable<typeof s.backfill> } => s.backfill !== null,
  );
  // INTENTIONAL fire-and-forget: persist the resolved tmdbId so future renders
  // skip the lookup chain. NOT awaited — a cache warm, not part of the response,
  // must not delay the page. Safe because Summonarr is a single long-lived Node
  // server (not serverless/edge), so the promise survives past render. Do NOT
  // "fix" by awaiting or moving into the request path — see CLAUDE.md guardrail
  // 17. A failed write leaves the session for the next render or sync to
  // re-resolve; only a session the poller already removed (P2025) is expected,
  // anything else is logged so a persistent failure is visible. Item-level
  // matches only (sessionBackfill): the finalize copies this into PlayHistory,
  // and the poller never overwrites a stored id it can't resolve itself.
  if (sessionsToBackfill.length > 0) {
    void Promise.all(
      sessionsToBackfill.map((s) =>
        prisma.activeSession.update({
          where: { id: s.id },
          data: { tmdbId: s.backfill.tmdbId, mediaType: s.backfill.mediaType },
        }).catch(logBackfillFailure),
      ),
    );
  }

  // Through the shared poster lookup (TmdbMediaCore, then the :details cache),
  // keyed by (tmdbId, mediaType): TMDB numbers movies and TV separately, and a
  // type the session NAMES is never filled from the other medium's art — only
  // an unknown type consults both (poster-cache.ts).
  const sessionPosters = await resolvePosterMap(
    effectiveSessions.map((s) => ({ tmdbId: s.effectiveTmdbId, mediaType: toActivityMediaType(s.effectiveMediaType) })),
  );
  const posterFor = (tmdbId: number | null, mediaType: string | null): string | null =>
    tmdbId == null ? null : sessionPosters[posterPathKey(tmdbId, toActivityMediaType(mediaType))] ?? null;

  // The SSE snapshot's own row shape (play-history-snapshot.ts), so the
  // server-rendered cards and the first live push can't drift apart, with this
  // render's resolved tmdbId/type in place of the stored ones.
  const serializedSessions = effectiveSessions.map((s) => {
    const { effectiveTmdbId, effectiveMediaType, backfill: _backfill, sourceItemId: _item, serverInstance: _server, ...row } = s;
    return serializeActiveSession(
      { ...row, tmdbId: effectiveTmdbId, mediaType: effectiveMediaType },
      posterFor(effectiveTmdbId, effectiveMediaType),
    );
  });

  // Header, filter bar and Now playing render in every state; `body` is the rest.
  const shell = (body: ReactNode) => (
    <div className="ds-page-enter">
      <ActivityLiveRefresher />
      <PageHeader
        title={t("adminActivity.title")}
        subtitle={t("adminActivity.subtitle")}
        right={<ActivityWarmButton />}
      />

      <ActivityFilterBar />

      {showActiveSessions && (
        <ActivityNowPlaying
          key={`np-${source ?? ""}-${mediaType ?? ""}`}
          initialSessions={serializedSessions}
          source={source}
          mediaType={mediaType}
          plexReachability={plexReachability}
        />
      )}

      {body}
    </div>
  );

  if (!aggregates || !rewatchedPostersPromise) {
    // Tracking off: every aggregate below would read as an all-zero quiet
    // server with nothing saying why — and none of them was queried. Now
    // playing stays above (the SSE feed is independent of play-history
    // recording).
    return shell(
      <EmptyState
        icon={Activity}
        title={t("adminActivity.trackingOff.title")}
        description={t("adminActivity.trackingOff.description")}
        cta={{ href: "/settings?tab=media#play-history", label: t("adminActivity.trackingOff.cta") }}
      />,
    );
  }

  const [stats, mostRewatched, calendarData, transcodeOffenders, watchTimeLeaderboard, busiestDay, recentPlays] =
    await aggregates;

  // The card's own mapping (recent-plays/map.ts), shared with its "Load more"
  // pages so the two can't drift apart; it picks the card's fields only.
  const serializedRecentPlays = recentPlays.map((p) => toRecentPlay(p));

  // Every day and hour on this page is a bucket in the statistics zone.
  const zoneLabel = zoneShortLabel(stats.timeZone);
  const kpis = overviewKpis({ t, locale, days, fmtDay, dec1, hoursSuffix, zoneLabel }, stats, busiestDay);

  // Postgres EXTRACT(DOW) is 0=Sun..6=Sat; the design heatmap rows are
  // Mon-first (toHeatmapMatrix).
  const heatmapMatrix = toHeatmapMatrix(stats.heatmap);
  const peak = heatmapPeak(heatmapMatrix);
  const peakHour = peak?.hour ?? 0;
  const heatmapInsight = peak
    ? t("adminActivity.overview.heatmapPeak", {
        day: t(HEATMAP_DAY_KEYS[peak.row]),
        // The heatmap buckets by the statistics zone's hour and names the zone
        // on its axis; the sentence under it does too, in the grid's own HH:00
        // form.
        hour: `${String(peakHour).padStart(2, "0")}:00 ${zoneLabel}`,
        count: peak.value,
        n: peak.value.toLocaleString(locale),
      })
    : t("adminActivity.overview.heatmapEmpty");

  const STREAM_LABELS: Record<string, { label: string; color: string }> = {
    DirectPlay: { label: t("adminActivity.method.directPlay"), color: "var(--ds-success)" },
    DirectStream: { label: t("adminActivity.method.remux"), color: "var(--ds-info)" },
    Transcode: { label: t("adminActivity.method.transcode"), color: "var(--ds-warning)" },
  };
  const formatCount = (n: number) => n.toLocaleString(locale);
  const streamMix = buildMix(
    stats.transcodeRatio,
    (r) => ({
      label: STREAM_LABELS[r.method]?.label ?? r.method,
      color: STREAM_LABELS[r.method]?.color ?? "var(--ds-fg-subtle)",
    }),
    formatCount,
  );
  const mediaMix = buildMix(
    stats.mediaTypeBreakdown,
    (r) => ({
      label:
        r.type === "TV"
          ? t("adminActivity.overview.tvEpisodes")
          : r.type === "MOVIE"
            ? t("adminActivity.overview.movies")
            : r.type,
      // Both bars follow the theme: the TV bar is the accent, the Movies bar the
      // second chart token (a baked indigo hue ignored the accent and nearly
      // vanished on the light card — guardrail 42).
      color: r.type === "TV" ? "var(--ds-accent)" : "var(--ds-chart-2)",
    }),
    formatCount,
  );

  const axisLabels = axisLabelIndices(stats.playsByDay.length).map((i) => fmtDay(stats.playsByDay[i].day));
  const peakSub = busiestDay?.day
    ? t("adminActivity.overview.peakOn", { n: busiestDay.count.toLocaleString(locale), day: `${fmtDay(busiestDay.day)} ${zoneLabel}` })
    : "";

  const { totalPlays: totalCalPlays, activeDays } = calendarTotals(calendarData);

  // One overall ranking of WATCH_TIME_LEADERBOARD_SIZE (8), ties broken by id.
  const leaderUsers = watchTimeLeaderboard.map((u, i) => ({
    id: u.id,
    username: u.username,
    source: u.source,
    hours: u.hours,
    plays: u.plays,
    rank: i + 1,
  }));
  const rewatchedPosters = await rewatchedPostersPromise;
  const leaderRewatched = mostRewatched.slice(0, 6).map((m, i) => ({
    tmdbId: m.tmdbId,
    mediaType: m.mediaType,
    title: m.title,
    plays: m.plays,
    viewers: m.viewers,
    rank: i + 1,
    posterSrc: rewatchedPosters[posterPathKey(m.tmdbId, m.mediaType)] ?? null,
  }));

  return shell(
    <>
      <KpiStrip kpis={kpis} />

      <AnalyticsRow
        playsByDay={stats.playsByDay.map((d) => d.count)}
        playsByDayLabels={stats.playsByDay.map((d) => fmtDay(d.day))}
        heatmapMatrix={heatmapMatrix}
        heatmapDetailBase={{ days, source, mediaType }}
        timeZone={stats.timeZone}
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

      <TranscodePressure data={transcodeOffenders} days={days} />

      {showActivityCalendar && calendarData.length > 0 && (
        <CalendarSection
          activeDays={activeDays}
          totalPlays={totalCalPlays}
        >
          <ActivityCalendar
            data={calendarData}
            // The statistics zone's today: the calendar's days are that zone's.
            today={zonedTodayIso(new Date(), stats.timeZone)}
            timeZone={stats.timeZone}
            detailBase={{ source, mediaType, historyPath: "/admin/activity/history" }}
          />
        </CalendarSection>
      )}

      <ActivityRecentPlays
        key={`rp-${days}-${source ?? ""}-${mediaType ?? ""}`}
        plays={serializedRecentPlays}
        source={source}
        mediaType={mediaType}
        days={days}
        startDateIso={periodCutoff.toISOString()}
        timeZone={stats.timeZone}
      />
    </>,
  );
}
