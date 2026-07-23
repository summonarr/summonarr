import { prisma } from "@/lib/prisma";
import { resolvePosterMap } from "@/lib/poster-cache";
import type { Prisma } from "@/generated/prisma";

// Self-service watch history — the ONE scoping chokepoint for a user reading
// their OWN PlayHistory. Every query below is filtered by the MediaServerUser
// rows linked to the calling Summonarr account, so a caller can page and
// filter but can never select another user's history. Consumed by
// GET /api/play-history/mine (client refetch + native clients) and the
// /watch-history server page; both must stay on this shared shape so the
// select/serialization can't drift between them.
//
// Entries are CONSOLIDATED: repeat plays of the same title collapse into one
// entry — the latest play is the representative row, with play-count and
// total-watch-time aggregates over the whole group. The group key is an
// identity ladder (strongest available wins):
//   tmdbId + mediaType + season/episode  → the same episode or movie, however
//                                          many times and on whatever device
//   source + sourceItemId                → unmatched rows replayed from the
//                                          same library item
//   the row itself                       → nothing to safely merge on; NEVER
//                                          collapse distinct unmatched titles
//                                          just because their ids are null

export const MY_HISTORY_PAGE_SIZE = 30;

export interface MyWatchHistoryItem {
  id: string;
  source: string;
  startedAt: string;
  stoppedAt: string;
  duration: number;
  playDuration: number;
  watched: boolean;
  completed: boolean;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  title: string;
  year: string | null;
  posterPath: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  posterUrl: string | null;
  // Consolidation aggregates: how many plays this entry collapses and their
  // combined play time. playDuration above stays the LATEST session's seconds;
  // watched/completed are group-wide (any qualifying play marks the entry).
  playCount: number;
  totalPlaySeconds: number;
}

export interface MyWatchHistoryPage {
  // false ⇒ the account has no linked MediaServerUser rows yet (linkage happens
  // automatically by email match at ingest, by the caller's own Plex/Jellyfin
  // sign-in identity, or manually by an admin). The UI uses this to explain
  // WHY history is empty instead of showing a bare list.
  linked: boolean;
  items: MyWatchHistoryItem[];
  // Consolidated-entry count matching the current filters (drives "Load more (N)").
  total: number;
  // Keyset cursor `<startedAt-iso>|<id>` over the representative rows'
  // (startedAt desc, id desc) — the /api/notifications idiom. Offset paging
  // would skip/duplicate entries as the 5s poller inserts new history between
  // page fetches. null ⇒ exhausted.
  nextCursor: string | null;
  pageSize: number;
  // All-time RAW totals for the caller (every play, unaffected by filters and
  // consolidation), for the summary line.
  stats: { plays: number; playSeconds: number };
}

const MAX_SEARCH_LEN = 100;

// Escape LIKE/ILIKE wildcard metacharacters (`%`, `_`, and the escape char `\`
// itself) so user-supplied search text is matched LITERALLY rather than as a
// pattern — paired with `ESCAPE '\'` on every ILIKE below. Without this, a
// wildcard-laden search string forces an unindexable pattern scan (a
// search-box DoS). Same discipline as /api/play-history's grouped path.
function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Raw row shape returned by the grouped page query: the representative
// (latest) play's lean columns plus the window aggregates. Dates arrive as
// Date objects from the pg driver; the ::int casts below keep the SUM/COUNT
// window values out of BigInt territory.
interface RawGroupedRow {
  id: string;
  source: string;
  startedAt: Date;
  stoppedAt: Date;
  duration: number;
  playDuration: number;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  title: string;
  year: string | null;
  posterPath: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  play_count: number;
  total_play_duration: number;
  group_watched: boolean;
  group_completed: boolean;
}

// Scope resolution: which media-server identities belong to the caller.
// Two sources of truth, unioned:
//   1. The explicit MediaServerUser.userId FK (email-matched at ingest, or
//      linked manually by an admin).
//   2. The caller's OWN provider identity (User.plexUserId/jellyfinUserId,
//      bound at Plex/Jellyfin sign-in) matched against the MediaServerUser
//      (source, sourceUserId) key. Jellyfin accounts frequently have no
//      email, so a Jellyfin-signin user would otherwise never email-match —
//      but their provider subject IS the media-server identity they signed
//      in with, which is a stronger claim than an email match.
// Inactive (soft-deleted) server users stay INCLUDED — history outlives a
// user's removal from the media server (guardrail 28), and it is still the
// caller's own history.
async function resolveLinkedMediaServerUserIds(summonarrUserId: string): Promise<string[]> {
  const me = await prisma.user.findUnique({
    where: { id: summonarrUserId },
    select: { plexUserId: true, jellyfinUserId: true },
  });
  const identityOr: Prisma.MediaServerUserWhereInput[] = [{ userId: summonarrUserId }];
  if (me?.plexUserId) {
    identityOr.push({ source: "plex", sourceUserId: me.plexUserId });
  }
  if (me?.jellyfinUserId) {
    identityOr.push({ source: "jellyfin", sourceUserId: me.jellyfinUserId });
  }
  const linked = await prisma.mediaServerUser.findMany({
    where: { OR: identityOr },
    select: { id: true },
  });
  return linked.map((r) => r.id);
}

export async function getMyWatchHistory(
  summonarrUserId: string,
  opts: { cursor?: string | null; mediaType?: string | null; search?: string | null } = {},
): Promise<MyWatchHistoryPage> {
  const ids = await resolveLinkedMediaServerUserIds(summonarrUserId);
  if (ids.length === 0) {
    return {
      linked: false,
      items: [],
      total: 0,
      nextCursor: null,
      pageSize: MY_HISTORY_PAGE_SIZE,
      stats: { plays: 0, playSeconds: 0 },
    };
  }

  // NOTE on raw SQL here: the only user-influenced inputs are the mediaType
  // (whitelisted to the two enum literals), the search term (ILIKE-escaped and
  // length-bounded, always a bound parameter), and the cursor (parsed into a
  // Date + string bind, never interpolated). The linked-id list comes from the
  // scope resolution above, never from the request. Everything rides $N binds;
  // no user data ever lands in SQL structure. Preserve this discipline (it
  // mirrors /api/play-history's grouped query).
  const binds: unknown[] = [...ids];
  const idPlaceholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  let filterSql = `h."mediaServerUserId" IN (${idPlaceholders})`;

  if (opts.mediaType === "MOVIE" || opts.mediaType === "TV") {
    binds.push(opts.mediaType);
    filterSql += ` AND h."mediaType" = CAST($${binds.length} AS "MediaType")`;
  }
  const search = (opts.search?.trim() ?? "").slice(0, MAX_SEARCH_LEN);
  if (search) {
    binds.push(`%${escapeIlike(search)}%`);
    const bind = binds.length;
    filterSql += ` AND (h."title" ILIKE $${bind} ESCAPE '\\' OR h."episodeTitle" ILIKE $${bind} ESCAPE '\\')`;
  }
  // The count query reuses exactly the filter binds; cursor + limit binds are
  // appended after this snapshot and belong to the page query only.
  const filterBinds = [...binds];

  // The identity ladder. tmdbId alone is NOT enough for TV — every episode of
  // a show shares the show's tmdbId, so season/episode are part of the key.
  const groupKeySql = `
    CASE
      WHEN h."tmdbId" IS NOT NULL THEN
        'tmdb:' || h."tmdbId"::text || ':' || COALESCE(h."mediaType"::text, '')
          || ':' || COALESCE(h."seasonNumber", -1)::text
          || ':' || COALESCE(h."episodeNumber", -1)::text
      WHEN h."sourceItemId" IS NOT NULL THEN 'item:' || h."source" || ':' || h."sourceItemId"
      ELSE 'row:' || h."id"
    END`;

  // Parse the opaque `<startedAt-iso>|<id>` cursor into a keyset predicate on
  // the REPRESENTATIVE rows; an absent/malformed cursor fails soft to the
  // first page. Applied outside the window CTE so a group's aggregates always
  // span every play in the filter scope, no matter which page it renders on.
  let cursorSql = "";
  const cursorRaw = opts.cursor;
  if (cursorRaw) {
    const sep = cursorRaw.indexOf("|");
    if (sep > 0) {
      const at = new Date(cursorRaw.slice(0, sep));
      const cursorId = cursorRaw.slice(sep + 1);
      if (cursorId && !Number.isNaN(at.getTime())) {
        binds.push(at, cursorId);
        cursorSql = ` AND (r."startedAt" < $${binds.length - 1} OR (r."startedAt" = $${binds.length - 1} AND r."id" < $${binds.length}))`;
      }
    }
  }

  binds.push(MY_HISTORY_PAGE_SIZE);
  const limitBind = binds.length;

  // One entry per group: ROW_NUMBER picks the latest play as the
  // representative; COUNT/SUM/bool_or aggregate the whole group. The lean
  // column list is deliberate — no ipAddress, codecs, bitrate, or network
  // forensics ever leave this query (the admin surface keeps those).
  const pageSql = `
    WITH ranked AS (
      SELECT
        h."id", h."source", h."startedAt", h."stoppedAt", h."duration",
        h."playDuration", h."tmdbId", h."mediaType", h."title", h."year",
        h."posterPath", h."seasonNumber", h."episodeNumber", h."episodeTitle",
        h."platform", h."player", h."device", h."playMethod",
        ROW_NUMBER() OVER (PARTITION BY ${groupKeySql} ORDER BY h."startedAt" DESC, h."id" DESC)::int AS rn,
        COUNT(*) OVER (PARTITION BY ${groupKeySql})::int AS play_count,
        SUM(h."playDuration") OVER (PARTITION BY ${groupKeySql})::int AS total_play_duration,
        bool_or(h."watched") OVER (PARTITION BY ${groupKeySql}) AS group_watched,
        bool_or(h."completed") OVER (PARTITION BY ${groupKeySql}) AS group_completed
      FROM "PlayHistory" h
      WHERE ${filterSql}
    )
    SELECT r."id", r."source", r."startedAt", r."stoppedAt", r."duration",
      r."playDuration", r."tmdbId", r."mediaType", r."title", r."year",
      r."posterPath", r."seasonNumber", r."episodeNumber", r."episodeTitle",
      r."platform", r."player", r."device", r."playMethod",
      r.play_count, r.total_play_duration, r.group_watched, r.group_completed
    FROM ranked r
    WHERE r.rn = 1${cursorSql}
    ORDER BY r."startedAt" DESC, r."id" DESC
    LIMIT $${limitBind}
  `;

  // Consolidated-entry count for the filter scope (filter binds only).
  const countSql = `
    SELECT COUNT(DISTINCT ${groupKeySql})::int AS total
    FROM "PlayHistory" h
    WHERE ${filterSql}
  `;

  const [rows, totalRows, agg] = await Promise.all([
    prisma.$queryRawUnsafe<RawGroupedRow[]>(pageSql, ...binds),
    prisma.$queryRawUnsafe<{ total: number }[]>(countSql, ...filterBinds),
    prisma.playHistory.aggregate({
      where: { mediaServerUserId: { in: ids } },
      _count: { _all: true },
      _sum: { playDuration: true },
    }),
  ]);

  const posters = await resolvePosterMap(rows);
  const items: MyWatchHistoryItem[] = rows.map((r) => ({
    id: r.id,
    source: r.source,
    startedAt: r.startedAt.toISOString(),
    stoppedAt: r.stoppedAt.toISOString(),
    duration: r.duration,
    playDuration: r.playDuration,
    watched: r.group_watched,
    completed: r.group_completed,
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    year: r.year,
    posterPath: r.posterPath,
    seasonNumber: r.seasonNumber,
    episodeNumber: r.episodeNumber,
    episodeTitle: r.episodeTitle,
    platform: r.platform,
    player: r.player,
    device: r.device,
    playMethod: r.playMethod,
    posterUrl: r.tmdbId != null ? posters[r.tmdbId] ?? null : null,
    playCount: r.play_count,
    totalPlaySeconds: r.total_play_duration,
  }));

  const last = rows.length === MY_HISTORY_PAGE_SIZE ? rows[rows.length - 1] : null;
  return {
    linked: true,
    items,
    total: totalRows[0]?.total ?? 0,
    nextCursor: last ? `${last.startedAt.toISOString()}|${last.id}` : null,
    pageSize: MY_HISTORY_PAGE_SIZE,
    stats: { plays: agg._count._all, playSeconds: agg._sum.playDuration ?? 0 },
  };
}

// ── Entry detail (per-consolidated-entry play breakdown) ─────────────────────

// One session inside a consolidated entry — the per-play subset of the lean
// field set (the shared title/episode identity lives on the entry, not here).
export interface MyWatchHistoryPlay {
  id: string;
  source: string;
  startedAt: string;
  stoppedAt: string;
  duration: number;
  playDuration: number;
  watched: boolean;
  completed: boolean;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
}

export interface MyWatchHistoryEntryDetail {
  // The consolidated entry (same shape as the list items — latest play as the
  // representative, group aggregates included).
  item: MyWatchHistoryItem;
  // Every play in the group, newest first, capped at MY_ENTRY_PLAYS_CAP. The
  // aggregates on `item` are exact even when this list is truncated.
  plays: MyWatchHistoryPlay[];
  firstStartedAt: string;
  lastStartedAt: string;
}

export const MY_ENTRY_PLAYS_CAP = 100;

// Fields needed to (a) rebuild the group key and (b) serve as the
// representative row. sourceItemId is key-input only — it never serializes.
const ANCHOR_SELECT = {
  id: true,
  source: true,
  startedAt: true,
  stoppedAt: true,
  duration: true,
  playDuration: true,
  watched: true,
  completed: true,
  tmdbId: true,
  mediaType: true,
  title: true,
  year: true,
  posterPath: true,
  seasonNumber: true,
  episodeNumber: true,
  episodeTitle: true,
  sourceItemId: true,
  platform: true,
  player: true,
  device: true,
  playMethod: true,
} as const;

/**
 * Expand one consolidated entry into its full play-by-play breakdown. `rowId`
 * is any play id from the entry (clients pass the representative row's id).
 * Returns null — surfaced as 404 — when the row doesn't exist OR belongs to a
 * media-server user outside the caller's linked set, so foreign row ids are
 * indistinguishable from missing ones.
 *
 * The group membership mirrors the list query's identity ladder exactly:
 * tmdb identity (null-safe season/episode/mediaType equality, source-agnostic),
 * else same library item (source + sourceItemId), else the row alone.
 */
export async function getMyWatchHistoryEntry(
  summonarrUserId: string,
  rowId: string,
): Promise<MyWatchHistoryEntryDetail | null> {
  const ids = await resolveLinkedMediaServerUserIds(summonarrUserId);
  if (ids.length === 0) return null;

  const anchor = await prisma.playHistory.findFirst({
    where: { id: rowId, mediaServerUserId: { in: ids } },
    select: ANCHOR_SELECT,
  });
  if (!anchor) return null;

  let groupWhere: Prisma.PlayHistoryWhereInput;
  if (anchor.tmdbId != null) {
    groupWhere = {
      tmdbId: anchor.tmdbId,
      mediaType: anchor.mediaType,
      seasonNumber: anchor.seasonNumber,
      episodeNumber: anchor.episodeNumber,
    };
  } else if (anchor.sourceItemId != null) {
    groupWhere = { tmdbId: null, source: anchor.source, sourceItemId: anchor.sourceItemId };
  } else {
    groupWhere = { id: anchor.id };
  }
  const scopedGroup: Prisma.PlayHistoryWhereInput = {
    AND: [{ mediaServerUserId: { in: ids } }, groupWhere],
  };

  const [playRows, agg] = await Promise.all([
    prisma.playHistory.findMany({
      where: scopedGroup,
      select: {
        id: true,
        source: true,
        startedAt: true,
        stoppedAt: true,
        duration: true,
        playDuration: true,
        watched: true,
        completed: true,
        platform: true,
        player: true,
        device: true,
        playMethod: true,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: MY_ENTRY_PLAYS_CAP,
    }),
    // Exact aggregates even when the play list is capped.
    prisma.playHistory.aggregate({
      where: scopedGroup,
      _count: { _all: true },
      _sum: { playDuration: true },
      _min: { startedAt: true },
      _max: { startedAt: true },
    }),
  ]);

  const newest = playRows[0];
  if (!newest) return null;

  const posters = anchor.tmdbId != null ? await resolvePosterMap([anchor]) : {};
  const item: MyWatchHistoryItem = {
    id: newest.id,
    source: newest.source,
    startedAt: newest.startedAt.toISOString(),
    stoppedAt: newest.stoppedAt.toISOString(),
    duration: newest.duration,
    playDuration: newest.playDuration,
    watched: playRows.some((p) => p.watched),
    completed: playRows.some((p) => p.completed),
    tmdbId: anchor.tmdbId,
    mediaType: anchor.mediaType,
    title: anchor.title,
    year: anchor.year,
    posterPath: anchor.posterPath,
    seasonNumber: anchor.seasonNumber,
    episodeNumber: anchor.episodeNumber,
    episodeTitle: anchor.episodeTitle,
    platform: newest.platform,
    player: newest.player,
    device: newest.device,
    playMethod: newest.playMethod,
    posterUrl: anchor.tmdbId != null ? posters[anchor.tmdbId] ?? null : null,
    playCount: agg._count._all,
    totalPlaySeconds: agg._sum.playDuration ?? 0,
  };

  return {
    item,
    plays: playRows.map((p) => ({
      id: p.id,
      source: p.source,
      startedAt: p.startedAt.toISOString(),
      stoppedAt: p.stoppedAt.toISOString(),
      duration: p.duration,
      playDuration: p.playDuration,
      watched: p.watched,
      completed: p.completed,
      platform: p.platform,
      player: p.player,
      device: p.device,
      playMethod: p.playMethod,
    })),
    firstStartedAt: (agg._min.startedAt ?? newest.startedAt).toISOString(),
    lastStartedAt: (agg._max.startedAt ?? newest.startedAt).toISOString(),
  };
}
