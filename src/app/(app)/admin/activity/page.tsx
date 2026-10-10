import { authActive } from "@/lib/auth";
import { plexSettingKey } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlayHistoryStats, getMostRewatched, getActivityCalendar, getTranscodeOffenders, appendPlayHistoryFilter, isPlayHistoryEnabled, isSourceEnabled } from "@/lib/play-history";
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
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import { TranscodePressure } from "@/components/admin/transcode-pressure";
import { ActivityWarmButton } from "@/components/admin/activity-warm-button";
import { ActivityLiveRefresher } from "@/components/admin/activity-live-refresher";
import { posterUrl } from "@/lib/tmdb-types";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import {
  addTitleResolutions,
  collectUnmappedPairs,
  lookupTitleResolution,
  titleWhereDisjuncts,
  toActivityMediaType,
  type TitleResolveMap,
} from "@/lib/activity-title-resolve";
import { requireFeature, getFeatureFlags } from "@/lib/features";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { parseActivityDays } from "@/lib/activity-days";

export const dynamic = "force-dynamic";

// Change versus the previous period for a KPI cell: "new" when the previous
// period had nothing, otherwise a rounded percentage with an up/down/flat arrow.
// `complete` = stats.prevPeriod.complete: false when play history doesn't cover
// the previous window (tracking began, or retention purged, inside it), so a
// delta would compare against a gap. None is shown then.
function kpiDelta(
  t: Translator,
  current: number,
  previous: number,
  complete: boolean,
): Kpi["delta"] {
  if (!complete) return null;
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { text: t("adminActivity.kpi.new"), dir: "up" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" };
  return { text: `${Math.abs(pct)}%`, dir: pct > 0 ? "up" : "down" };
}

// Deterministic from a fixed YYYY-MM-DD string — not Date.now()/new Date()
// in a client render path, so this is safe in the server component.
function shortDay(day: string, locale: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
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

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string;
    source?: string;
    mediaType?: string;
    tab?: string;
    from?: string;
    to?: string;
    watched?: string;
  }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const featureFlags = await getFeatureFlags();
  const showActiveSessions   = featureFlags["feature.behavior.activeSessions"] !== false;
  const showActivityCalendar = featureFlags["feature.behavior.activityCalendar"] !== false;

  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  const fmtDay = (day: string) => shortDay(day, locale);
  // One decimal, locale-separated: the integers beside these already go through
  // toLocaleString, so a bare toFixed(1) mixed "1.234 plays" with "12.3 Mbps".
  const dec1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const hoursSuffix = t("adminActivity.common.hoursSuffix");

  const { days: daysParam, source: sourceParam, mediaType: mediaTypeParam, tab, from: fromParam, to: toParam, watched: watchedParam } = await searchParams;

  // The History tab moved to its own route segment (history/page.tsx) so it
  // gets a table-shaped loading.tsx instead of flashing this page's KPI/chart
  // skeleton. Older `?tab=history` links — the calendar "View these plays",
  // the recent-plays "View history", the play-detail back link, the
  // delete-play redirect — still land here and are forwarded with every filter
  // they carried.
  if (tab === "history") {
    const forward = new URLSearchParams();
    const carried: Record<string, string | undefined> = {
      days: daysParam,
      source: sourceParam,
      mediaType: mediaTypeParam,
      from: fromParam,
      to: toParam,
      watched: watchedParam,
    };
    for (const [k, v] of Object.entries(carried)) if (v) forward.set(k, v);
    const qs = forward.toString();
    redirect(`/admin/activity/history${qs ? `?${qs}` : ""}`);
  }

  const days = parseActivityDays(daysParam);
  const source = sourceParam && ["plex", "jellyfin"].includes(sourceParam) ? sourceParam : undefined;
  const mediaType = mediaTypeParam && ["MOVIE", "TV"].includes(mediaTypeParam) ? mediaTypeParam : undefined;

  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const periodCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const prismaWhere: Record<string, unknown> = { startedAt: { gte: periodCutoff } };
  if (source) prismaWhere.source = source;
  if (mediaType) prismaWhere.mediaType = mediaType as "MOVIE" | "TV";

  // Only the window-function leaderboard and the peak-day pick remain inline —
  // genuinely unique to this page; the rest comes from getPlayHistoryStats.
  const fp = appendPlayHistoryFilter([periodCutoff], { source, mediaType });
  const fpJoin = appendPlayHistoryFilter([periodCutoff], { source, mediaType, tableAlias: "p" });

  // Which Plex servers exist has to be known BEFORE the batch below, because it
  // determines which Setting keys the reachability read asks for. One extra
  // round-trip (the registry is a single Setting row) rather than widening the
  // query to `startsWith: "plex"`, which would drag every instance's admin token
  // through the decryption extension just to render a status chip.
  const plexInstances = await getMediaInstances("plex");
  const plexStatusKeys = plexInstances.flatMap((i) => [
    plexSettingKey(i.slug, "ServerReachable"),
    plexSettingKey(i.slug, "ServerUrl"),
    plexSettingKey(i.slug, "AdminToken"),
  ]);

  const [
    stats,
    activeSessions,
    recentPlays,
    mostRewatched,
    calendarData,
    transcodeOffenders,
    plexReachableRows,
    phEnabled,
    plexSourceEnabled,
    watchTimeLeaderboard,
    mostActiveDay,
  ] = await Promise.all([
    getPlayHistoryStats({ days, source, mediaType }),
    prisma.activeSession.findMany({
      ...(source || mediaType
        ? { where: { ...(source ? { source } : {}), ...(mediaType ? { mediaType } : {}) } }
        : {}),
      // Match emitActiveSessionsSnapshot's deterministic ordering so the SSR
      // list and the first live SSE push agree (no reorder flash on connect).
      // `id` (immutable PK) breaks the common startedAt ties.
      orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    }),
    prisma.playHistory.findMany({
      where: prismaWhere,
      // This seeds page 1; `ActivityRecentPlays` loads page 2+ from
      // /api/play-history (ungrouped), whose query orders
      // `ORDER BY startedAt DESC, id DESC`. The `id` tiebreak — and its DESC
      // direction — must match so both walk ONE total order: same-poll
      // sessions share a stamped startedAt, and a tie straddling the page-1/2
      // boundary would otherwise repeat one row and silently skip the other.
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 20,
      include: {
        mediaServerUser: {
          select: { username: true, source: true, thumbUrl: true },
        },
      },
    }),
    getMostRewatched({ days, source, mediaType }, 10),
    getActivityCalendar(source, mediaType),
    getTranscodeOffenders({ days, source, mediaType }),
    prisma.setting.findMany({
      where: { key: { in: plexStatusKeys } },
      select: { key: true, value: true },
    }),
    isPlayHistoryEnabled(),
    isSourceEnabled("plex"),
    prisma.$queryRawUnsafe<
      { id: string; username: string; source: string; hours: number | null; plays: bigint }[]
    >(
      // `plays` is computed HERE, per row, with the same `watched = true` rule as
      // getPlayHistoryStats' topUsers. Looking it up from topUsers instead read 0
      // for anyone outside the per-source top 10 by PLAY COUNT — exactly the
      // few-long-plays viewer a watch-time leaderboard surfaces ("42h · 0 plays").
      `WITH user_hours AS (
         SELECT m."id", m."username", m."source", (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours,
                COUNT(*) FILTER (WHERE p."watched" = true)::bigint AS plays
         FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
         WHERE p."startedAt" >= $1${fpJoin.sql}
         GROUP BY m."id", m."username", m."source"
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY "source" ORDER BY "hours" DESC) AS rn
         FROM user_hours
       )
       SELECT "id", "username", "source", "hours", "plays"
       FROM ranked
       WHERE rn <= 10
       ORDER BY "hours" DESC`,
      ...fpJoin.params,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      // `watched = true` is NOT optional: the "Plays per day" chart this label sits on
      // is built from getPlayHistoryStats' wwhere, which filters watched plays. Counting
      // every row here meant the stated busiest day could be a day the chart shows as a
      // trough — a day of many abandoned starts outranking a day of real viewing.
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "startedAt" >= $1 AND "watched" = true${fp.sql}
       GROUP BY day ORDER BY count DESC LIMIT 1`,
      ...fp.params,
    ),
  ]);

  // Start the rewatched-poster resolution now so it overlaps the tmdb fallback
  // chain and poster-map reads below; awaited where the value is consumed. The
  // no-op catch only marks the promise handled if an intermediate await throws
  // first — the await below still rethrows a resolvePosterMap failure.
  const rewatchedSlice = mostRewatched.slice(0, 6);
  const rewatchedPostersPromise = resolvePosterMap(rewatchedSlice);
  rewatchedPostersPromise.catch(() => {});

  // Parse the saved Plex reachability snapshot (JSON written by
  // plex-events.persistReachability). A malformed row falls back to null
  // (= "unknown") instead of crashing the page.
  //
  // Worked out PER SERVER. Each instance is checked against its OWN url+token,
  // so an unconfigured named server stays "unknown" (no chip) instead of
  // borrowing the default server's answer, and a configured one that goes down
  // gets its own "unreachable" chip.
  const plexSettings = new Map(plexReachableRows.map((r) => [r.key, r.value]));
  const plexReachability = plexInstances.map((inst) => {
    const configured =
      !!plexSettings.get(plexSettingKey(inst.slug, "ServerUrl")) &&
      !!plexSettings.get(plexSettingKey(inst.slug, "AdminToken"));
    // Only trust the flag when the poller that maintains it is running: it is
    // written by the 5s poller (true on getPlexSessions success, false on throw)
    // plus the SSE connect-time probe, which run only when play-history + the
    // Plex source are enabled and url+token are set. Otherwise the value is
    // stale, so gate the chip on the same conditions as its data source.
    const live = configured && phEnabled && plexSourceEnabled;
    let reachable: boolean | null = null;
    const raw = plexSettings.get(plexSettingKey(inst.slug, "ServerReachable"));
    if (live && raw) {
      try {
        const parsed = JSON.parse(raw) as { reachable?: unknown };
        if (typeof parsed.reachable === "boolean") reachable = parsed.reachable;
      } catch { /* leave null = unknown */ }
    }
    // The registry names the default instance "Default", which would render
    // "Default unreachable" on a single-server deployment where it has always
    // said "Plex" — exactly the kind of observable difference guardrail 35
    // forbids. Label the default bare and qualify only named servers.
    const name = inst.slug === "" ? "Plex" : `Plex (${inst.name})`; // brand + server name, not translated
    return { instance: inst.slug, name, reachable };
  });

  const resolvedTmdb: Record<string, { tmdbId: number; mediaType: string }> = {};
  const titleResolved: TitleResolveMap = {};
  const sessionsNeedingTmdb = activeSessions.filter((s: typeof activeSessions[0]) => s.tmdbId == null);

  if (sessionsNeedingTmdb.length > 0) {
    const sourceItemIds = sessionsNeedingTmdb
      .filter((s: typeof sessionsNeedingTmdb[0]) => s.sourceItemId)
      .map((s: typeof sessionsNeedingTmdb[0]) => s.sourceItemId!);

    if (sourceItemIds.length > 0) {
      const historyMatches = await prisma.playHistory.findMany({
        where: { sourceItemId: { in: sourceItemIds }, tmdbId: { not: null } },
        // distinct + select BOTH carry serverInstance: a sourceItemId is issued by
        // one server and two servers reuse the same ids, so distinct on the id
        // alone collapses two servers rows into one and resolves the wrong tmdbId.
        distinct: ["serverInstance", "sourceItemId"],
        orderBy: { startedAt: "desc" },
        select: { sourceItemId: true, tmdbId: true, mediaType: true, serverInstance: true },
      });
      for (const h of historyMatches) {
        if (h.sourceItemId && h.tmdbId != null) {
          resolvedTmdb[`item:${h.serverInstance}:${h.sourceItemId}`] = { tmdbId: h.tmdbId, mediaType: h.mediaType ?? "TV" };
        }
      }
    }

    const stillNeedLibrary = sessionsNeedingTmdb.filter(
      (s: typeof sessionsNeedingTmdb[0]) => s.sourceItemId && !resolvedTmdb[`item:${s.serverInstance}:${s.sourceItemId}`],
    );
    if (stillNeedLibrary.length > 0) {
      const plexPairs = stillNeedLibrary
        .filter((s: typeof stillNeedLibrary[0]) => s.source === "plex")
        .map((s: typeof stillNeedLibrary[0]) => ({ plexRatingKey: s.sourceItemId!, serverInstance: s.serverInstance }));
      // Both id columns (guardrail 37): a title in two Jellyfin libraries has an
      // id per copy but only one is the stored `jellyfinItemId`, so a session on
      // the other copy never resolved here. Rows predating `jellyfinItemIds` are
      // `[]`, so the legacy branch stays.
      const jellyfinPairs = stillNeedLibrary
        .filter((s: typeof stillNeedLibrary[0]) => s.source === "jellyfin")
        .flatMap((s: typeof stillNeedLibrary[0]) => [
          { jellyfinItemId: s.sourceItemId!, serverInstance: s.serverInstance },
          { jellyfinItemIds: { has: s.sourceItemId! }, serverInstance: s.serverInstance },
        ]);
      const [plexItems, jellyfinItems] = await Promise.all([
        plexPairs.length > 0
          ? prisma.plexLibraryItem.findMany({
              where: { OR: plexPairs },
              select: { tmdbId: true, mediaType: true, plexRatingKey: true, serverInstance: true },
            })
          : [],
        jellyfinPairs.length > 0
          ? prisma.jellyfinLibraryItem.findMany({
              where: { OR: jellyfinPairs },
              select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true, serverInstance: true },
            })
          : [],
      ]);
      for (const i of plexItems) {
        if (i.plexRatingKey) resolvedTmdb[`item:${i.serverInstance}:${i.plexRatingKey}`] = { tmdbId: i.tmdbId, mediaType: i.mediaType };
      }
      for (const i of jellyfinItems) {
        // Every id the row answers to — the session's sourceItemId may be any of them.
        if (i.jellyfinItemId) resolvedTmdb[`item:${i.serverInstance}:${i.jellyfinItemId}`] = { tmdbId: i.tmdbId, mediaType: i.mediaType };
        for (const id of i.jellyfinItemIds) {
          resolvedTmdb[`item:${i.serverInstance}:${id}`] = { tmdbId: i.tmdbId, mediaType: i.mediaType };
        }
      }
    }

    const stillNeedTitle = sessionsNeedingTmdb.filter(
      (s: typeof sessionsNeedingTmdb[0]) => !(s.sourceItemId && resolvedTmdb[`item:${s.serverInstance}:${s.sourceItemId}`]),
    );
    if (stillNeedTitle.length > 0) {
      // Keyed on (title, mediaType) through activity-title-resolve, never the
      // bare title: a TV session titled "Fargo" must not pick up the MOVIE
      // "Fargo"'s tmdbId, because the backfill below PERSISTS the answer.
      const titlePairs = collectUnmappedPairs(stillNeedTitle);
      if (titlePairs.length > 0) {
        const titleMatches = await prisma.playHistory.findMany({
          where: {
            tmdbId: { not: null },
            OR: titleWhereDisjuncts(titlePairs),
          },
          distinct: ["title", "mediaType"],
          orderBy: { startedAt: "desc" },
          select: { title: true, tmdbId: true, mediaType: true },
        });
        addTitleResolutions(titleResolved, titleMatches);
      }
    }
  }

  const effectiveSessions = activeSessions.map((s: typeof activeSessions[0]) => {
    if (s.tmdbId != null) return { ...s, effectiveTmdbId: s.tmdbId, effectiveMediaType: s.mediaType };
    // The `item:` key is serverInstance-scoped — a sourceItemId is server-local, so two
    // servers reuse the same ids. EVERY write above uses `item:<instance>:<id>`; reading
    // a bare `item:<id>` here matched nothing at all, so every session that the lookup
    // chain had correctly resolved fell through to the title fallback on the next line.
    // That is worse than the collision it replaced: the title fallback matches across
    // media types, and its answer is then PERSISTED to ActiveSession by the backfill
    // below — so a wrong id became durable.
    const byItem = s.sourceItemId ? resolvedTmdb[`item:${s.serverInstance}:${s.sourceItemId}`] : undefined;
    if (byItem) return { ...s, effectiveTmdbId: byItem.tmdbId, effectiveMediaType: byItem.mediaType };
    // Title fallback: matched on (title, mediaType), and the session's own known
    // type is never overwritten by the resolution (activity-title-resolve rule).
    const byTitle = lookupTitleResolution(titleResolved, s.title, s.mediaType);
    return {
      ...s,
      effectiveTmdbId: byTitle?.tmdbId ?? null,
      effectiveMediaType: toActivityMediaType(s.mediaType) ?? byTitle?.mediaType ?? s.mediaType,
    };
  });

  const sessionsToBackfill = effectiveSessions.filter(
    (s: typeof effectiveSessions[0]) => s.tmdbId == null && s.effectiveTmdbId != null,
  );
  // INTENTIONAL fire-and-forget: persist the resolved tmdbId so future renders
  // skip the lookup chain. NOT awaited — a cache warm, not part of the response,
  // must not delay the page. Safe because Summonarr is a single long-lived Node
  // server (not serverless/edge), so the promise survives past render. Do NOT
  // "fix" by awaiting or moving into the request path — see CLAUDE.md guardrail
  // 17. Errors swallowed by design (next sync re-resolves).
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

  // Keyed by the FULL cache key, not the bare tmdbId: a movie and a series can
  // share a TMDB id, so a bare-id map with a first-row-wins guard rendered
  // whichever of the two the unordered findMany happened to return first.
  const posterMap: Record<string, string | null> = {};
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
        if (parsed.posterPath && !posterMap[row.key]) {
          posterMap[row.key] = posterUrl(parsed.posterPath, "w342");
        }
      } catch { }
    }
  }
  // Prefer the session's own media type; fall back to the other so a session
  // whose type has no cached details still gets the poster it used to get.
  const posterFor = (tmdbId: number | null, mediaType: string | null): string | null => {
    if (tmdbId == null) return null;
    const own = mediaType === "TV" ? "tv" : "movie";
    const other = own === "tv" ? "movie" : "tv";
    return posterMap[`${own}:${tmdbId}:details`] ?? posterMap[`${other}:${tmdbId}:details`] ?? null;
  };

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
    posterUrl: posterFor(s.effectiveTmdbId, s.effectiveMediaType),
  }));

  const serializedRecentPlays = recentPlays.map((p: typeof recentPlays[0]) => ({
    id: p.id,
    source: p.source,
    // Which media server the play came from. "" for the default/only server
    // (and for every row written before multi-server support) — the table
    // badges it only when non-empty.
    serverInstance: p.serverInstance,
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
  const prevComplete = stats.prevPeriod?.complete ?? false;

  /* ── Derived props for the refined overview sections ──────────── */

  const watchHoursNd = Math.round(stats.totalWatchTimeHours);
  const activeUsersNd = stats.uniqueViewers;
  const busiestDay = mostActiveDay[0];

  const kpis: Kpi[] = [
    {
      label: t("adminActivity.kpi.dayPlays", { days }),
      value: stats.totalPlays.toLocaleString(locale),
      delta: kpiDelta(t, stats.totalPlays, prevPlaysNum, prevComplete),
      spark: stats.playsByDay.map((d) => d.count),
      sparkLabels: stats.playsByDay.map((d) => fmtDay(d.day)),
      sparkSuffix: t("adminActivity.common.playsSuffix"),
    },
    {
      label: t("adminActivity.kpi.watchTime"),
      value: `${watchHoursNd.toLocaleString(locale)}${hoursSuffix}`,
      delta: kpiDelta(t, watchHoursNd, Math.round(prevWatchTimeNum), prevComplete),
      spark: stats.watchTimeByDay.map((d) => d.hours),
      sparkLabels: stats.watchTimeByDay.map((d) => fmtDay(d.day)),
      sparkSuffix: hoursSuffix,
    },
    {
      label: t("adminActivity.kpi.activeUsers"),
      value: activeUsersNd.toLocaleString(locale),
      delta: kpiDelta(t, activeUsersNd, stats.prevPeriod?.uniqueViewers ?? 0, prevComplete),
    },
    {
      label: t("adminActivity.kpi.completionRate"),
      value: `${dec1.format(stats.completionRate)}%`,
    },
    {
      label: t("adminActivity.kpi.busiestDay"),
      value: busiestDay?.day ? fmtDay(busiestDay.day) : "—",
      sub: busiestDay?.day
        ? t("adminActivity.common.playsFormatted", { count: Number(busiestDay.count), n: Number(busiestDay.count).toLocaleString(locale) })
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
      ? t("adminActivity.overview.heatmapPeak", {
          day: t(HEATMAP_DAY_KEYS[peakRow]),
          hour: `${peakHour}:00`,
          count: peakVal,
          n: peakVal.toLocaleString(locale),
        })
      : t("adminActivity.overview.heatmapEmpty");

  const STREAM_LABELS: Record<string, { label: string; color: string }> = {
    DirectPlay: { label: t("adminActivity.method.directPlay"), color: "var(--ds-success)" },
    DirectStream: { label: t("adminActivity.method.remux"), color: "var(--ds-info)" },
    Transcode: { label: t("adminActivity.method.transcode"), color: "var(--ds-warning)" },
  };
  const streamTotal = stats.transcodeRatio.reduce((a, r) => a + r.count, 0);
  const streamMix = [...stats.transcodeRatio]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      label: STREAM_LABELS[r.method]?.label ?? r.method,
      color: STREAM_LABELS[r.method]?.color ?? "var(--ds-fg-subtle)",
      value: r.count.toLocaleString(locale),
      pct: streamTotal > 0 ? Math.round((r.count / streamTotal) * 100) : 0,
    }));

  const mediaTotal = stats.mediaTypeBreakdown.reduce((a, r) => a + r.count, 0);
  const mediaMix = [...stats.mediaTypeBreakdown]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
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
      value: r.count.toLocaleString(locale),
      pct: mediaTotal > 0 ? Math.round((r.count / mediaTotal) * 100) : 0,
    }));

  // Up to five evenly spaced axis labels — never more than there are days, or a
  // custom 2–4 day window prints the same date twice.
  const axisLabels: string[] = [];
  if (stats.playsByDay.length > 1) {
    const n = stats.playsByDay.length;
    const count = Math.min(5, n);
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i / (count - 1)) * (n - 1));
      axisLabels.push(fmtDay(stats.playsByDay[idx].day));
    }
  }
  const peakSub = busiestDay?.day
    ? t("adminActivity.overview.peakOn", { n: Number(busiestDay.count).toLocaleString(locale), day: fmtDay(busiestDay.day) })
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

  const leaderUsers = watchTimeLeaderboard.slice(0, 8).map((u, i) => ({
    id: u.id,
    username: u.username,
    source: u.source,
    hours: u.hours ?? 0,
    plays: Number(u.plays),
    rank: i + 1,
  }));
  const rewatchedPosters = await rewatchedPostersPromise;
  const leaderRewatched = rewatchedSlice.map((m, i) => ({
    tmdbId: m.tmdbId,
    mediaType: m.mediaType,
    title: m.title,
    plays: m.plays,
    viewers: m.viewers,
    rank: i + 1,
    posterSrc: rewatchedPosters[posterPathKey(m.tmdbId, m.mediaType)] ?? null,
  }));

  return (
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

      {!phEnabled ? (
        // Tracking off: every aggregate below would read as an all-zero quiet
        // server with nothing saying why. Now playing stays above (the SSE feed
        // is independent of play-history recording).
        <EmptyState
          icon={Activity}
          title={t("adminActivity.trackingOff.title")}
          description={t("adminActivity.trackingOff.description")}
          cta={{ href: "/settings?tab=media#play-history", label: t("adminActivity.trackingOff.cta") }}
        />
      ) : (
        <>
          <KpiStrip kpis={kpis} />

          <AnalyticsRow
            playsByDay={stats.playsByDay.map((d) => d.count)}
            playsByDayLabels={stats.playsByDay.map((d) => fmtDay(d.day))}
            heatmapMatrix={heatmapMatrix}
            heatmapDetailBase={{ days, source, mediaType }}
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
                today={new Date().toISOString()}
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
          />
        </>
      )}
    </div>
  );
}
