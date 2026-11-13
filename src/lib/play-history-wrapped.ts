// "Wrapped" — a person's year in review, over the same id SET as their stats.
import { prisma } from "./prisma";
import { getStatsTimeZone } from "./stats-time-zone-data";
import { zonedMidnightSql } from "./stats-time-zone";
import { round1, runCapped } from "./play-history-aggregate";
import { hoursOf, localStartedAt, PLAY_HOURS_SQL, TITLE_GROUP_BY_SQL } from "./play-history-sql-fragments";
import { idScope } from "./play-history-user-stats";

// Every day, month, day-of-week and hour here is in `timeZone`, the statistics
// zone (stats-time-zone.ts), and so is the calendar year the bundle covers.
export interface WrappedBundle {
  timeZone: string;
  totals: { plays: number; hours: number; titles: number };
  movies: { titles: number; hours: number };
  tv: { shows: number; episodes: number; hours: number };
  topTitles: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    posterPath: string | null;
    count: number;
    hours: number;
  }[];
  biggestDay: { day: string; plays: number; hours: number } | null;
  busiestMonth: { month: string; plays: number } | null;
  primeDow: number | null;
  primeHour: number | null;
  longestSitting: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    posterPath: string | null;
    seconds: number;
    startedAt: string;
  } | null;
  // completion = watched / total plays ("how often you saw it through").
  completion: { watched: number; total: number };
  topPlatform: string | null;
  topDevice: string | null;
}

// Distinct calendar years (in the statistics zone) that have a watched play for
// the id set, newest first — drives the year picker. `watched` only, so a year
// of aborted starts with no real watch doesn't offer an empty review.
export async function getPlayYearsForServerUsers(ids: string[], timeZone?: string): Promise<number[]> {
  if (ids.length === 0) return [];
  const zone = timeZone ?? (await getStatsTimeZone());
  const { idIn, refs, params } = idScope(ids, zone);
  const rows = await prisma.$queryRawUnsafe<{ y: number }[]>(
    `SELECT DISTINCT EXTRACT(YEAR FROM ${localStartedAt(refs[0])})::int AS y
     FROM "PlayHistory" WHERE "mediaServerUserId" IN (${idIn}) AND watched
     ORDER BY y DESC`,
    ...params,
  );
  return rows.map((r) => r.y);
}

// Hours of the watched plays matching `filter` (an SQL predicate ANDed with watched).
const watchedHours = (filter = "") => hoursOf(`SUM("playDuration") FILTER (WHERE ${filter}watched)`);

// Year-in-review aggregates for the id SET, bounded to one calendar year in the
// statistics zone. Same IN(...) + bind discipline as getPlayStatsForServerUsers;
// every query is scoped by the shared `scope` predicate ($ids…, then the year's
// first day, the next year's first day and the zone). The bounds are the zone's
// midnights as stored-UTC instants, so the bare column still uses its indexes.
export async function getWrappedForServerUsers(ids: string[], year: number, timeZone?: string): Promise<WrappedBundle> {
  const zone = timeZone ?? (await getStatsTimeZone());
  // IN (NULL) on an empty list: matches nothing instead of the "IN ()" syntax error.
  const { idIn, refs: [y1, y2, z], params: binds } = idScope(ids, `${year}-01-01`, `${year + 1}-01-01`, zone);
  const local = localStartedAt(z);
  const scope = `"mediaServerUserId" IN (${idIn}) AND "startedAt" >= ${zonedMidnightSql(`${y1}::date`, z)} AND "startedAt" < ${zonedMidnightSql(`${y2}::date`, z)}`;

  // At most STATS_STATEMENT_CONCURRENCY in flight, like every aggregate fan-out (guardrail 31).
  const r = await runCapped({
    totals: () => prisma.$queryRawUnsafe<{ plays: number; hours: number; titles: number }[]>(
      `SELECT COUNT(*) FILTER (WHERE watched)::int AS plays,
              ${watchedHours()} AS hours,
              COUNT(DISTINCT COALESCE("tmdbId"::text || ':' || COALESCE("mediaType"::text, ''), lower("title"))) FILTER (WHERE watched)::int AS titles
       FROM "PlayHistory" WHERE ${scope}`,
      ...binds,
    ),
    split: () => prisma.$queryRawUnsafe<{ movie_titles: number; movie_hours: number; shows: number; episodes: number; tv_hours: number }[]>(
      `SELECT COUNT(DISTINCT COALESCE("tmdbId"::text, lower("title"))) FILTER (WHERE "mediaType" = 'MOVIE' AND watched)::int AS movie_titles,
              ${watchedHours(`"mediaType" = 'MOVIE' AND `)} AS movie_hours,
              COUNT(DISTINCT COALESCE("tmdbId"::text, lower("title"))) FILTER (WHERE "mediaType" = 'TV' AND watched)::int AS shows,
              COUNT(*) FILTER (WHERE "mediaType" = 'TV' AND watched)::int AS episodes,
              ${watchedHours(`"mediaType" = 'TV' AND `)} AS tv_hours
       FROM "PlayHistory" WHERE ${scope}`,
      ...binds,
    ),
    top: () => prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; posterPath: string | null; cnt: number; hours: number }[]>(
      `SELECT MAX("title") AS title, "tmdbId", "mediaType"::text AS "mediaType", MAX("posterPath") AS "posterPath",
              COUNT(*)::int AS cnt, ${PLAY_HOURS_SQL} AS hours
       FROM "PlayHistory" WHERE ${scope} AND watched
       ${TITLE_GROUP_BY_SQL}
       ORDER BY cnt DESC, hours DESC, "mediaType" ASC, "tmdbId" ASC NULLS LAST, MAX("title") ASC LIMIT 5`,
      ...binds,
    ),
    day: () => prisma.$queryRawUnsafe<{ day: string; plays: number; hours: number }[]>(
      `SELECT to_char(date_trunc('day', ${local}), 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE watched)::int AS plays,
              ${watchedHours()} AS hours
       FROM "PlayHistory" WHERE ${scope}
       GROUP BY day ORDER BY plays DESC, hours DESC, day ASC LIMIT 1`,
      ...binds,
    ),
    month: () => prisma.$queryRawUnsafe<{ month: string; plays: number }[]>(
      `SELECT to_char(date_trunc('month', ${local}), 'YYYY-MM') AS month, COUNT(*) FILTER (WHERE watched)::int AS plays
       FROM "PlayHistory" WHERE ${scope} GROUP BY month ORDER BY plays DESC, month ASC LIMIT 1`,
      ...binds,
    ),
    // Every pick here breaks its ties (the earliest day, month, hour or play;
    // the lowest title key), so the answer is the same on every read.
    dow: () => prisma.$queryRawUnsafe<{ dow: number; c: number }[]>(
      `SELECT EXTRACT(DOW FROM ${local})::int AS dow, COUNT(*)::int AS c
       FROM "PlayHistory" WHERE ${scope} AND watched GROUP BY dow ORDER BY c DESC, dow ASC LIMIT 1`,
      ...binds,
    ),
    hour: () => prisma.$queryRawUnsafe<{ hour: number; c: number }[]>(
      `SELECT EXTRACT(HOUR FROM ${local})::int AS hour, COUNT(*)::int AS c
       FROM "PlayHistory" WHERE ${scope} AND watched GROUP BY hour ORDER BY c DESC, hour ASC LIMIT 1`,
      ...binds,
    ),
    longest: () => prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; posterPath: string | null; secs: number; startedAt: Date }[]>(
      `SELECT "title", "tmdbId", "mediaType"::text AS "mediaType", "posterPath", "playDuration" AS secs, "startedAt"
       FROM "PlayHistory" WHERE ${scope} AND watched ORDER BY "playDuration" DESC, "startedAt" ASC, "id" ASC LIMIT 1`,
      ...binds,
    ),
    completion: () => prisma.$queryRawUnsafe<{ watched: number; total: number }[]>(
      `SELECT COUNT(*) FILTER (WHERE watched)::int AS watched, COUNT(*)::int AS total FROM "PlayHistory" WHERE ${scope}`,
      ...binds,
    ),
    platform: () => prisma.$queryRawUnsafe<{ v: string; c: number }[]>(
      // A blank value (some clients send "") is no answer — it must not win the
      // top slot over a real name.
      `SELECT "platform" AS v, COUNT(*)::int AS c FROM "PlayHistory" WHERE ${scope} AND watched AND NULLIF(btrim("platform"), '') IS NOT NULL
       GROUP BY v ORDER BY c DESC LIMIT 1`,
      ...binds,
    ),
    device: () => prisma.$queryRawUnsafe<{ v: string; c: number }[]>(
      `SELECT "device" AS v, COUNT(*)::int AS c FROM "PlayHistory" WHERE ${scope} AND watched AND NULLIF(btrim("device"), '') IS NOT NULL
       GROUP BY v ORDER BY c DESC LIMIT 1`,
      ...binds,
    ),
  });

  const totals = r.totals[0];
  const split = r.split[0];
  const day = r.day[0];
  const month = r.month[0];
  const long = r.longest[0];
  return {
    timeZone: zone,
    totals: {
      plays: totals?.plays ?? 0,
      hours: round1(totals?.hours ?? 0),
      titles: totals?.titles ?? 0,
    },
    movies: { titles: split?.movie_titles ?? 0, hours: round1(split?.movie_hours ?? 0) },
    tv: { shows: split?.shows ?? 0, episodes: split?.episodes ?? 0, hours: round1(split?.tv_hours ?? 0) },
    topTitles: r.top.map((t) => ({
      title: t.title,
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      posterPath: t.posterPath,
      count: t.cnt,
      hours: round1(t.hours),
    })),
    biggestDay: day ? { day: day.day, plays: day.plays, hours: round1(day.hours) } : null,
    busiestMonth: month ? { month: month.month, plays: month.plays } : null,
    primeDow: r.dow[0]?.dow ?? null,
    primeHour: r.hour[0]?.hour ?? null,
    longestSitting: long
      ? {
          title: long.title,
          tmdbId: long.tmdbId,
          mediaType: long.mediaType,
          posterPath: long.posterPath,
          seconds: long.secs,
          startedAt: long.startedAt.toISOString(),
        }
      : null,
    completion: { watched: r.completion[0]?.watched ?? 0, total: r.completion[0]?.total ?? 0 },
    topPlatform: r.platform[0]?.v ?? null,
    topDevice: r.device[0]?.v ?? null,
  };
}
