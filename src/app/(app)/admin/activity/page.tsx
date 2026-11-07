import { authActive } from "@/lib/auth";
import { plexSettingKey } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { prisma } from "@/lib/prisma";
import { indexPlexRowsByKey } from "@/lib/plex-dedupe";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import {
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
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityCalendar } from "@/components/admin/activity-calendar";
import { TranscodePressure } from "@/components/admin/transcode-pressure";
import { ActivityWarmButton } from "@/components/admin/activity-warm-button";
import { ActivityLiveRefresher } from "@/components/admin/activity-live-refresher";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import {
  addTitleResolutions,
  collectUnmappedPairs,
  lookupTitleResolution,
  sessionBackfill,
  titleWhereDisjuncts,
  toActivityMediaType,
  type TitleResolveMap,
  type UnmappedTitlePair,
} from "@/lib/activity-title-resolve";
import { requireFeature, getFeatureFlags } from "@/lib/features";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { firstParam, parseActivityFilters, type PageParam } from "@/lib/activity-days";
import { RECENT_PLAYS_PAGE_SIZE } from "@/lib/activity-constants";
import { zoneShortLabel, zonedTodayIso } from "@/lib/stats-time-zone";
import { Prisma, type ActiveSession } from "@/generated/prisma";
import type { ReactNode } from "react";

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

// The newest resolved play per (title, mediaType) pair, for the display-only
// title fallback. DISTINCT ON keeps one row per pair in Postgres: Prisma's
// `distinct` (no native distinct here) fetched EVERY matching play and
// de-duplicated in memory, so a long-running series sent back each episode.
// One Prisma.sql value, never a tagged template with a fragment (guardrail 23a).
async function latestResolvedByTitle(
  pairs: readonly UnmappedTitlePair[],
): Promise<{ title: string; tmdbId: number; mediaType: string | null }[]> {
  // The pair scoping comes from titleWhereDisjuncts, so this query and the map
  // keying (activity-title-resolve) can't drift apart.
  const disjuncts = titleWhereDisjuncts(pairs).map((d) =>
    d.mediaType
      ? Prisma.sql`("title" = ${d.title} AND "mediaType" = CAST(${d.mediaType} AS "MediaType"))`
      : Prisma.sql`"title" = ${d.title}`,
  );
  return prisma.$queryRaw<{ title: string; tmdbId: number; mediaType: string | null }[]>(Prisma.sql`
    SELECT DISTINCT ON ("title", "mediaType") "title", "tmdbId", "mediaType"::text AS "mediaType"
    FROM "PlayHistory"
    WHERE "tmdbId" IS NOT NULL AND (${Prisma.join(disjuncts, " OR ")})
    ORDER BY "title", "mediaType", "startedAt" DESC
  `);
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
  // A repeated key arrives as an array; the parsers below take its first value.
  searchParams: Promise<{
    days?: PageParam;
    source?: PageParam;
    mediaType?: PageParam;
    tab?: PageParam;
    from?: PageParam;
    to?: PageParam;
    watched?: PageParam;
  }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  // Read before any data: a section the page won't render runs no query.
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
  if (firstParam(sp.tab) === "history") {
    const forward = new URLSearchParams();
    // One value per key: a repeated one used to be joined into "a,b".
    const carried: Record<string, string | undefined> = {
      days: firstParam(sp.days),
      source: firstParam(sp.source),
      mediaType: firstParam(sp.mediaType),
      from: firstParam(sp.from),
      to: firstParam(sp.to),
      watched: firstParam(sp.watched),
    };
    for (const [k, v] of Object.entries(carried)) if (v) forward.set(k, v);
    const qs = forward.toString();
    redirect(`/admin/activity/history${qs ? `?${qs}` : ""}`);
  }

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
  // determines which Setting keys the reachability read asks for. One extra
  // round-trip (the registry is a single Setting row) rather than widening the
  // query to `startsWith: "plex"`. The admin tokens are tested for PRESENCE
  // only, by a key-only read: selecting `value` sent every instance's token
  // through the decryption extension just to render a status chip (guardrail
  // 7a). Now playing hidden ⇒ nothing here is read.
  const plexInstances = showActiveSessions ? await getMediaInstances("plex") : [];
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
        })
      : Promise.resolve([] as ActiveSession[]),
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

  // Parse the saved Plex reachability snapshot (JSON written by
  // plex-events.persistReachability). A malformed row falls back to null
  // (= "unknown") instead of crashing the page.
  //
  // Worked out PER SERVER. Each instance is checked against its OWN url+token,
  // so an unconfigured named server stays "unknown" (no chip) instead of
  // borrowing the default server's answer, and a configured one that goes down
  // gets its own "unreachable" chip.
  const plexSettings = new Map(plexReachableRows.map((r) => [r.key, r.value]));
  const plexTokenSet = new Set(plexTokenRows.map((r) => r.key));
  const plexReachability = plexInstances.map((inst) => {
    const configured =
      !!plexSettings.get(plexSettingKey(inst.slug, "ServerUrl")) &&
      plexTokenSet.has(plexSettingKey(inst.slug, "AdminToken"));
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

  // The item-level answers carry the matched row's own type, null when the
  // history row had none (no longer guessed as "TV").
  const resolvedTmdb: Record<string, { tmdbId: number; mediaType: string | null }> = {};
  const titleResolved: TitleResolveMap = {};
  const sessionsNeedingTmdb = activeSessions.filter((s) => s.tmdbId == null);

  if (sessionsNeedingTmdb.length > 0) {
    const withItem = sessionsNeedingTmdb.filter(
      (s): s is typeof s & { sourceItemId: string } => !!s.sourceItemId,
    );
    // Per source, so the [source, sourceItemId, …] index serves the lookup —
    // the id alone matches no index's leading column.
    const itemsBySource = (["plex", "jellyfin"] as const)
      .map((src) => ({
        source: src,
        sourceItemId: { in: withItem.filter((s) => s.source === src).map((s) => s.sourceItemId) },
      }))
      .filter((arm) => arm.sourceItemId.in.length > 0);

    if (itemsBySource.length > 0) {
      const historyMatches = await prisma.playHistory.findMany({
        where: { OR: itemsBySource, tmdbId: { not: null } },
        // distinct + select BOTH carry serverInstance: a sourceItemId is issued by
        // one server and two servers reuse the same ids, so distinct on the id
        // alone collapses two servers rows into one and resolves the wrong tmdbId.
        distinct: ["serverInstance", "sourceItemId"],
        orderBy: { startedAt: "desc" },
        select: { sourceItemId: true, tmdbId: true, mediaType: true, serverInstance: true },
      });
      for (const h of historyMatches) {
        if (h.sourceItemId && h.tmdbId != null) {
          resolvedTmdb[`item:${h.serverInstance}:${h.sourceItemId}`] = { tmdbId: h.tmdbId, mediaType: h.mediaType };
        }
      }
    }

    const stillNeedLibrary = withItem.filter(
      (s) => !resolvedTmdb[`item:${s.serverInstance}:${s.sourceItemId}`],
    );
    if (stillNeedLibrary.length > 0) {
      // Both ratingKey columns, for the same reason (guardrail 37c).
      const plexPairs = stillNeedLibrary
        .filter((s) => s.source === "plex")
        .flatMap((s) => [
          { plexRatingKey: s.sourceItemId, serverInstance: s.serverInstance },
          { plexRatingKeys: { has: s.sourceItemId }, serverInstance: s.serverInstance },
        ]);
      // Both id columns (guardrail 37): a title in two Jellyfin libraries has an
      // id per copy but only one is the stored `jellyfinItemId`, so a session on
      // the other copy never resolved here. Rows predating `jellyfinItemIds` are
      // `[]`, so the legacy branch stays.
      const jellyfinPairs = stillNeedLibrary
        .filter((s) => s.source === "jellyfin")
        .flatMap((s) => [
          { jellyfinItemId: s.sourceItemId, serverInstance: s.serverInstance },
          { jellyfinItemIds: { has: s.sourceItemId }, serverInstance: s.serverInstance },
        ]);
      const [plexItems, jellyfinItems] = await Promise.all([
        plexPairs.length > 0
          ? prisma.plexLibraryItem.findMany({
              where: { OR: plexPairs },
              select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true, serverInstance: true },
            })
          : [],
        jellyfinPairs.length > 0
          ? prisma.jellyfinLibraryItem.findMany({
              where: { OR: jellyfinPairs },
              select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true, serverInstance: true },
            })
          : [],
      ]);
      // Each key resolves to its ONE owner per instance (canonical holder, else
      // lowest tmdbId — `indexPlexRowsByKey`), never last-write-wins: an array
      // entry overwriting another row's canonical key made the answer follow
      // findMany's row order, and this backfill PERSISTS it.
      const plexByInstance = new Map<string, Array<(typeof plexItems)[number]>>();
      for (const i of plexItems) {
        const list = plexByInstance.get(i.serverInstance);
        if (list) list.push(i);
        else plexByInstance.set(i.serverInstance, [i]);
      }
      for (const [inst, rows] of plexByInstance) {
        for (const [k, i] of indexPlexRowsByKey(rows)) {
          resolvedTmdb[`item:${inst}:${k}`] = { tmdbId: i.tmdbId, mediaType: i.mediaType };
        }
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
      (s) => !(s.sourceItemId && resolvedTmdb[`item:${s.serverInstance}:${s.sourceItemId}`]),
    );
    if (stillNeedTitle.length > 0) {
      // Keyed on (title, mediaType) through activity-title-resolve, never the
      // bare title: a TV session titled "Fargo" must not pick up the MOVIE
      // "Fargo"'s tmdbId. Display-only: a title match is never persisted
      // (sessionBackfill below).
      const titlePairs = collectUnmappedPairs(stillNeedTitle);
      if (titlePairs.length > 0) {
        addTitleResolutions(titleResolved, await latestResolvedByTitle(titlePairs));
      }
    }
  }

  const effectiveSessions = activeSessions.map((s) => {
    if (s.tmdbId != null) return { ...s, effectiveTmdbId: s.tmdbId, effectiveMediaType: s.mediaType, backfill: null };
    // The `item:` key is serverInstance-scoped — a sourceItemId is server-local, so two
    // servers reuse the same ids. EVERY write above uses `item:<instance>:<id>`; reading
    // a bare `item:<id>` here matched nothing at all, so every session that the lookup
    // chain had correctly resolved fell through to the title fallback on the next line.
    const byItem = s.sourceItemId ? resolvedTmdb[`item:${s.serverInstance}:${s.sourceItemId}`] : undefined;
    if (byItem) {
      return {
        ...s,
        effectiveTmdbId: byItem.tmdbId,
        effectiveMediaType: byItem.mediaType ?? s.mediaType,
        backfill: sessionBackfill(s.mediaType, { ...byItem, via: "item" }),
      };
    }
    // Title fallback: matched on (title, mediaType), and the session's own known
    // type is never overwritten by the resolution (activity-title-resolve rule).
    // It feeds the poster and the link only — never the backfill.
    const byTitle = lookupTitleResolution(titleResolved, s.title, s.mediaType);
    return {
      ...s,
      effectiveTmdbId: byTitle?.tmdbId ?? null,
      effectiveMediaType: toActivityMediaType(s.mediaType) ?? byTitle?.mediaType ?? s.mediaType,
      backfill: null,
    };
  });

  const sessionsToBackfill = effectiveSessions.filter(
    (s): s is typeof s & { backfill: NonNullable<typeof s.backfill> } => s.backfill !== null,
  );
  // INTENTIONAL fire-and-forget: persist the resolved tmdbId so future renders
  // skip the lookup chain. NOT awaited — a cache warm, not part of the response,
  // must not delay the page. Safe because Summonarr is a single long-lived Node
  // server (not serverless/edge), so the promise survives past render. Do NOT
  // "fix" by awaiting or moving into the request path — see CLAUDE.md guardrail
  // 17. Errors swallowed by design (next sync re-resolves). Item-level matches
  // only (sessionBackfill): the finalize copies this into PlayHistory, and the
  // poller never overwrites a stored id it can't resolve itself.
  if (sessionsToBackfill.length > 0) {
    void Promise.all(
      sessionsToBackfill.map((s) =>
        prisma.activeSession.update({
          where: { id: s.id },
          data: { tmdbId: s.backfill.tmdbId, mediaType: s.backfill.mediaType },
        }).catch(() => {}),
      ),
    ).catch(() => {});
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

  const serializedSessions = effectiveSessions.map((s) => ({
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

  const serializedRecentPlays = recentPlays.map((p) => ({
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
  // Every day and hour on this page is a bucket in the statistics zone.
  const zoneLabel = zoneShortLabel(stats.timeZone);

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
          // The heatmap buckets by the statistics zone's hour and names the
          // zone on its axis; the sentence under it does too, in the grid's own
          // HH:00 form.
          hour: `${String(peakHour).padStart(2, "0")}:00 ${zoneLabel}`,
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
    ? t("adminActivity.overview.peakOn", { n: busiestDay.count.toLocaleString(locale), day: `${fmtDay(busiestDay.day)} ${zoneLabel}` })
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
      />
    </>,
  );
}
