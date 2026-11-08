// "Popular on Server": titles ranked by completed viewing arcs, for /popular and
// its native-client route.
import { prisma } from "./prisma";
import { coalesce } from "./concurrency";
import { getArcGapDays, getCompletionThreshold } from "./play-history-settings";
import { activityGeneration, popularCache } from "./play-history-cache";
import { round1 } from "./play-history-aggregate";
import { arcCtes, hoursOf } from "./play-history-sql-fragments";

export type PopularSort = "plays" | "viewers" | "trending";

export const POPULAR_PER_PAGE = 40;

type PopularItem = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  year: string | null;
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

export type PopularResult = {
  items: PopularItem[];
  totalItems: number;
  totalPages: number;
  page: number;
};

// One (mediaType, sort)'s ranked list, cached and sliced into pages.
export type PopularRanking = { items: PopularItem[]; totalItems: number };

const POPULAR_CACHE_TTL_MS = 5 * 60 * 1000;
// A most-played list never legitimately needs more than this many pages; clamping
// bounds how deep a ranking is read.
const MAX_POPULAR_PAGE = 100;
// The rows one ranking holds: every reachable page at the largest page size.
export const MAX_POPULAR_ROWS = MAX_POPULAR_PAGE * POPULAR_PER_PAGE;

// Popularity counts *completed arcs*, not raw sessions. An "arc" is a run of consecutive
// sessions on the same (user, tmdbId, season, episode) that hasn't been broken by either
// a `completed=true` finish (a rewatch boundary) or a gap longer than playHistoryArcGapDays.
// For TV the unit is per-episode; show-level "plays" sum across episodes.
// totalHours and episodes are computed from raw sessions so partial sittings still contribute.
export async function getMostPopularOnServer(
  opts: { mediaType?: "MOVIE" | "TV"; sort?: PopularSort; page?: number; limit?: number } = {},
): Promise<PopularResult> {
  const { mediaType, sort = "plays" } = opts;
  // Clamp page/limit at the SOURCE so every caller is bounded — the /popular server
  // page passes `page` straight through unclamped.
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), MAX_POPULAR_PAGE);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? POPULAR_PER_PAGE) || POPULAR_PER_PAGE), POPULAR_PER_PAGE);

  const ranking = await popularRanking(mediaType, sort);
  const start = (page - 1) * limit;
  return {
    items: ranking.items.slice(start, start + limit),
    totalItems: ranking.totalItems,
    totalPages: Math.max(1, Math.ceil(ranking.totalItems / limit)),
    page,
  };
}

// The whole ranking for one (mediaType, sort), computed once and paged in
// memory: every page of a list used to re-run the full-history arc aggregate
// for its own LIMIT/OFFSET, and two pages read at different moments could
// disagree about the order of tied titles.
async function popularRanking(mediaType: "MOVIE" | "TV" | undefined, sort: PopularSort): Promise<PopularRanking> {
  const cacheKey = JSON.stringify({ mediaType, sort });
  const cached = popularCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  // Read before computing: a clearActivityCache() landing mid-query must not be
  // undone by this result being stored afterwards (see play-history-cache.ts).
  const generation = activityGeneration();
  // /popular is open to every user and every finalize empties this cache, so
  // concurrent visitors missing on one key share ONE full-history window query
  // (guardrail 31). The generation in the key keeps a load that starts after a
  // clear from joining a computation that predates it.
  return coalesce(`popular:${generation}:${cacheKey}`, async () => {
    const ranking = await computePopularRanking(mediaType, sort);
    if (generation === activityGeneration()) {
      popularCache.set(cacheKey, { data: ranking, expiresAt: Date.now() + POPULAR_CACHE_TTL_MS });
    }
    return ranking;
  });
}

async function computePopularRanking(mediaType: "MOVIE" | "TV" | undefined, sort: PopularSort): Promise<PopularRanking> {
  const [completionPct, arcGapDays] = await Promise.all([
    getCompletionThreshold(),
    getArcGapDays(),
  ]);
  const { sql, params } = popularRankingStatement({
    mediaType,
    sort,
    completionRatio: completionPct / 100,
    arcGapSeconds: arcGapDays * 24 * 60 * 60,
    trendingSince: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });

  // `mediaType` is the MediaType enum as text and joins on equality, so it is
  // never NULL and only ever 'MOVIE' or 'TV'.
  const rows = await prisma.$queryRawUnsafe<
    {
      tmdbId: number;
      mediaType: "MOVIE" | "TV";
      title: string;
      year: string | null;
      plays: bigint;
      allTimePlays: bigint;
      viewers: bigint;
      episodes: bigint;
      totalHours: number;
      total_items: bigint;
    }[]
  >(sql, ...params);

  return {
    items: rows.map((r) => ({
      tmdbId: r.tmdbId,
      mediaType: r.mediaType,
      title: r.title,
      year: r.year,
      plays: Number(r.plays),
      allTimePlays: Number(r.allTimePlays),
      viewers: Number(r.viewers),
      episodes: Number(r.episodes ?? 0),
      totalHours: round1(Number(r.totalHours)),
    })),
    totalItems: rows.length > 0 ? Number(rows[0].total_items) : 0,
  };
}

// The ranking statement and its binds. Pure: each placeholder index is read off
// `params` right after its push, so an optional push (the media type, the
// trending window) shifts every later index in lockstep.
export function popularRankingStatement(opts: {
  mediaType: "MOVIE" | "TV" | undefined;
  sort: PopularSort;
  completionRatio: number;
  arcGapSeconds: number;
  // Bound only for sort=trending.
  trendingSince: Date;
}): { sql: string; params: unknown[] } {
  const { mediaType, sort } = opts;
  const params: unknown[] = [];

  const baseConditions: string[] = ['"tmdbId" IS NOT NULL'];
  if (mediaType) {
    params.push(mediaType);
    baseConditions.push(`"mediaType"::text = $${params.length}`);
  }
  const baseWhere = baseConditions.join(" AND ");

  params.push(opts.arcGapSeconds);
  const arcGapIdx = params.length;

  params.push(opts.completionRatio);
  const completionIdx = params.length;

  let trendingIdx: number | null = null;
  if (sort === "trending") {
    params.push(opts.trendingSince);
    trendingIdx = params.length;
  }

  const trendArcFilter = trendingIdx ? `FILTER (WHERE arc_started_at >= $${trendingIdx})` : "";
  const trendRawFilter = trendingIdx ? `FILTER (WHERE "startedAt" >= $${trendingIdx})` : "";
  // Episodes badge counts only episodes that have at least one completed arc, so a half-watched
  // pilot no longer pads the "5 eps" count. Pulled from completed_arcs (ca.*), filtered to TV.
  const episodesArcFilter = trendingIdx
    ? `FILTER (WHERE ca."mediaType"::text = 'TV' AND ca."seasonNumber" IS NOT NULL AND ca."episodeNumber" IS NOT NULL AND ca.arc_started_at >= $${trendingIdx})`
    : `FILTER (WHERE ca."mediaType"::text = 'TV' AND ca."seasonNumber" IS NOT NULL AND ca."episodeNumber" IS NOT NULL)`;
  const havingSql = trendingIdx ? `HAVING COUNT(*) ${trendArcFilter} > 0` : "";

  const orderBy =
    sort === "viewers" ? "viewers DESC, plays DESC" : "plays DESC, viewers DESC";

  // The whole ranking up to the deepest reachable page; pages are sliced from it.
  params.push(MAX_POPULAR_ROWS);
  const limitIdx = params.length;

  const arcs = arcCtes(baseWhere, arcGapIdx, {
    key: `"tmdbId"`,
    arcSelect: `"tmdbId", "mediaType", "mediaServerUserId",
             "seasonNumber", "episodeNumber", arc_id,
             SUM("playDuration") AS arc_play,
             MAX("duration") AS arc_dur,
             MIN("startedAt") AS arc_started_at`,
    arcGroupBy: `"tmdbId", "mediaType", "mediaServerUserId",
               "seasonNumber", "episodeNumber", arc_id`,
  });

  const sql = `
    WITH ${arcs},
    completed_arcs AS (
      SELECT *
      FROM arcs
      WHERE arc_dur > 0 AND (arc_play::float / arc_dur) >= $${completionIdx}
    ),
    session_aggregates AS (
      SELECT "tmdbId", "mediaType"::text AS "mediaType",
             MAX("title") AS title,
             MAX("year") AS year,
             ${hoursOf(`SUM("playDuration") ${trendRawFilter}`)} AS "totalHours"
      FROM "PlayHistory"
      WHERE ${baseWhere}
      GROUP BY "tmdbId", "mediaType"
    ),
    popular AS (
      SELECT ca."tmdbId", ca."mediaType"::text AS "mediaType",
             sa.title, sa.year, sa."totalHours",
             (COUNT(DISTINCT (ca."seasonNumber", ca."episodeNumber")) ${episodesArcFilter})::bigint AS episodes,
             (COUNT(*) ${trendArcFilter})::bigint AS plays,
             COUNT(*)::bigint AS "allTimePlays",
             (COUNT(DISTINCT ca."mediaServerUserId") ${trendArcFilter})::bigint AS viewers
      FROM completed_arcs ca
      JOIN session_aggregates sa
        ON sa."tmdbId" = ca."tmdbId" AND sa."mediaType" = ca."mediaType"::text
      GROUP BY ca."tmdbId", ca."mediaType", sa.title, sa.year, sa."totalHours"
      ${havingSql}
    )
    SELECT *,
           (COUNT(*) OVER ())::bigint AS total_items
    FROM popular
    ORDER BY ${orderBy}
    LIMIT $${limitIdx}
  `;
  return { sql, params };
}
