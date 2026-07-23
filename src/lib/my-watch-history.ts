import { prisma } from "@/lib/prisma";
import { resolvePosterMap } from "@/lib/poster-cache";
import type { Prisma } from "@/generated/prisma";

// Self-service watch history — the ONE scoping chokepoint for a user reading
// their OWN PlayHistory. Every query below is filtered by the MediaServerUser
// rows linked to the calling Summonarr account (MediaServerUser.userId), so a
// caller can page and filter but can never select another user's history.
// Consumed by GET /api/play-history/mine (client refetch + native clients) and
// the /watch-history server page; both must stay on this shared shape so the
// select/serialization can't drift between them.

export const MY_HISTORY_PAGE_SIZE = 30;

// Lean self-view field set. Deliberately EXCLUDES the admin forensics surface
// (ipAddress, codec/bitrate columns, network location fields, source session
// keys, the MediaServerUser row id): the own-history view needs what/when/
// how-long/on-what, and the payload should stay safe to hand to any
// authenticated caller.
const SELECT = {
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
  seasonNumber: true,
  episodeNumber: true,
  episodeTitle: true,
  platform: true,
  player: true,
  device: true,
  playMethod: true,
} as const;

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
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  posterUrl: string | null;
}

export interface MyWatchHistoryPage {
  // false ⇒ the account has no linked MediaServerUser rows yet (linkage happens
  // automatically by email match at ingest, or manually by an admin). The UI
  // uses this to explain WHY history is empty instead of showing a bare list.
  linked: boolean;
  items: MyWatchHistoryItem[];
  // Row count matching the current filters (drives "Load more (N)").
  total: number;
  // Keyset cursor `<startedAt-iso>|<id>` over (startedAt desc, id desc) — the
  // /api/notifications idiom. Offset paging would skip/duplicate rows as the
  // 5s poller inserts new history between page fetches. null ⇒ exhausted.
  nextCursor: string | null;
  pageSize: number;
  // All-time totals for the caller (unaffected by filters), for the summary line.
  stats: { plays: number; playSeconds: number };
}

const MAX_SEARCH_LEN = 100;

// Prisma's `contains` filter emits an ILIKE with no `ESCAPE` clause, so a
// search term laden with `%`/`_` wildcards would force an unindexable pattern
// scan (a search-box DoS). Strip the LIKE metacharacters (and the escape char)
// and bound the length so the filter is a bounded literal substring match —
// same treatment as /api/play-history's ungrouped path.
function sanitizeContainsSearch(s: string): string {
  return s.replace(/[%_\\]/g, "").slice(0, MAX_SEARCH_LEN);
}

export async function getMyWatchHistory(
  summonarrUserId: string,
  opts: { cursor?: string | null; mediaType?: string | null; search?: string | null } = {},
): Promise<MyWatchHistoryPage> {
  // Scope resolution: which media-server identities belong to the caller.
  // Inactive (soft-deleted) server users stay INCLUDED — history outlives a
  // user's removal from the media server (guardrail 28), and it is still the
  // caller's own history.
  const linked = await prisma.mediaServerUser.findMany({
    where: { userId: summonarrUserId },
    select: { id: true },
  });
  const ids = linked.map((r) => r.id);
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

  const filters: Prisma.PlayHistoryWhereInput = { mediaServerUserId: { in: ids } };
  if (opts.mediaType === "MOVIE" || opts.mediaType === "TV") {
    filters.mediaType = opts.mediaType;
  }
  const search = sanitizeContainsSearch(opts.search?.trim() ?? "");
  if (search) {
    filters.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { episodeTitle: { contains: search, mode: "insensitive" } },
    ];
  }

  // Parse the opaque `<startedAt-iso>|<id>` cursor into a keyset predicate; an
  // absent/malformed cursor fails soft to the first page. Composed via AND so
  // the cursor's OR can't collide with the search filter's OR key.
  let cursorWhere: Prisma.PlayHistoryWhereInput | null = null;
  const cursorRaw = opts.cursor;
  if (cursorRaw) {
    const sep = cursorRaw.indexOf("|");
    if (sep > 0) {
      const at = new Date(cursorRaw.slice(0, sep));
      const id = cursorRaw.slice(sep + 1);
      if (id && !Number.isNaN(at.getTime())) {
        cursorWhere = { OR: [{ startedAt: { lt: at } }, { startedAt: at, id: { lt: id } }] };
      }
    }
  }
  const pageWhere: Prisma.PlayHistoryWhereInput = cursorWhere
    ? { AND: [filters, cursorWhere] }
    : filters;

  const [rows, total, agg] = await Promise.all([
    prisma.playHistory.findMany({
      where: pageWhere,
      select: SELECT,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: MY_HISTORY_PAGE_SIZE,
    }),
    prisma.playHistory.count({ where: filters }),
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
    watched: r.watched,
    completed: r.completed,
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    year: r.year,
    seasonNumber: r.seasonNumber,
    episodeNumber: r.episodeNumber,
    episodeTitle: r.episodeTitle,
    platform: r.platform,
    player: r.player,
    device: r.device,
    playMethod: r.playMethod,
    posterUrl: r.tmdbId != null ? posters[r.tmdbId] ?? null : null,
  }));

  const last = rows.length === MY_HISTORY_PAGE_SIZE ? rows[rows.length - 1] : null;
  return {
    linked: true,
    items,
    total,
    nextCursor: last ? `${last.startedAt.toISOString()}|${last.id}` : null,
    pageSize: MY_HISTORY_PAGE_SIZE,
    stats: { plays: agg._count._all, playSeconds: agg._sum.playDuration ?? 0 },
  };
}
