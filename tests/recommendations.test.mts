// Unit tests for src/lib/recommendations.ts — the "For You" engine
// (computeRecommendationsForUser, warmRecommendationsCache,
// getUserRecommendations). Pinned here:
//   - cold start (zero seeds) short-circuits before any TMDB call;
//   - only watched:true PlayHistory rows seed the engine;
//   - history seeding is windowed to the last 180 days (an old binge cannot
//     outrank recent watches), falling back to all-time ONLY when the window
//     is empty — while the exclusion set stays all-time;
//   - scoring = seedTypeWeight × recency(seed age) × count(plays, log-compressed)
//     × position(rank within the seed's suggestion list), summed across every
//     seed that surfaced a candidate (multi-seed corroboration), with watchlist
//     seeds (1.5x) outweighing watch-history seeds (1.0x) at equal recency.
//     Each factor is pinned by a test that fails if it is neutralised: dropping
//     positional decay, dropping recency, or un-compressing the play count all
//     break at least one assertion — the last of those being the bug where a
//     long-ago 40-episode binge outranks something watched two days ago;
//   - the match-strength band is assigned by RANK over the viewer's surviving
//     set (top 10% / top 33%), independently of whether a row carries a reason;
//   - seed SELECTION is recency-first (the last 100 titles played), so a heavy
//     series can no longer occupy the slots on play count alone. The stub's
//     groupBy honours args.orderBy for exactly this reason — hardcoding a sort
//     there made the real query's ordering untestable;
//   - candidate languages that barely feature in the weighted pool are
//     de-emphasised toward a floor (never filtered), a substantial second
//     language is untouched, and an unknown language is left alone;
//   - a multi-source ratings prior re-weights the shortlist, with an UNRATED
//     title strictly neutral and a ratings outage degrading to relevance-only
//     rather than failing the run. Ratings are served from a seeded cache, so
//     no test reaches MDBList or OMDB;
//   - the exclusion set is wider than the chosen seeds — an unseeded
//     watchlist/watched title is still excluded from suggestions;
//   - warmRecommendationsCache does one $transaction PER eligible user (never
//     one spanning all users) and the active-user cohort excludes
//     deactivated/purged/dormant accounts;
//   - getUserRecommendations re-filters the cache against CURRENT
//     watchlist/watched state at read time (drift since the last cron run),
//     and skips those queries entirely when the cache is empty;
//   - each candidate records WHY it was picked — the strongest seed that
//     surfaced it (not the first one encountered) plus the corroborating seed
//     count — and getRecommendationSummary reports the distinct seed count per
//     pool, so a row predating those columns degrades to no reason at all.
//
// No DB or network: every Prisma model recommendations.ts touches (directly,
// or transitively via resolveLinkedMediaServerUserIds / getMovieSuggestions /
// getTVSuggestions) is shadowed in-memory (tests/_helpers.mts).
// globalThis.fetch is scripted for TMDB's /similar and /recommendations
// endpoints, and dns/promises.lookup is stubbed so safeFetchTrusted's SSRF
// resolver never issues a real lookup for api.themoviedb.org.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.TMDB_READ_TOKEN = "test-tmdb-token"; // tmdbAuth() reads this directly, no Setting lookup

// Freeze the clock BEFORE the module graph loads (imports below are DYNAMIC —
// static imports would hoist above this): the active-user cutoff and every
// fixture's relative createdAt/startedAt/lastSeenAt read the mocked Date.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
const DAY_MS = 24 * 60 * 60 * 1000;

// ── DNS stub (see tests/omdb-quota.test.mts for the rationale) ──────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { computeRecommendationsForUser, warmRecommendationsCache, getUserRecommendations, getRecommendationSummary } =
  await import("../src/lib/recommendations.ts");

// ── in-memory tables ─────────────────────────────────────────────────────────
type MT = "MOVIE" | "TV";
interface UserRow {
  id: string;
  plexUserId: string | null;
  jellyfinUserId: string | null;
  deactivatedAt: Date | null;
  purgedAt: Date | null;
}
interface AuthSessionRow {
  userId: string;
  lastSeenAt: Date;
}
interface MediaServerUserRow {
  id: string;
  source: string;
  sourceUserId: string;
  userId: string | null;
}
interface PlayHistoryRow {
  mediaServerUserId: string;
  tmdbId: number | null;
  mediaType: MT | null;
  watched: boolean;
  startedAt: Date;
  // PlayHistory.title is NOT NULL in the schema; optional here only so the
  // fixtures that predate the reason columns stay readable. Defaulted below.
  title?: string;
}
interface WatchlistRow {
  userId: string;
  tmdbId: number;
  mediaType: MT;
  createdAt: Date;
  title?: string;
}
interface UserRecRow {
  id: string;
  userId: string;
  tmdbId: number;
  mediaType: MT;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number;
  score: number;
  rank: number;
  computedAt: Date;
  // Optional so the pre-existing cache fixtures below stay terse; the stub
  // defaults them to null, which is exactly what a row written before the
  // reason columns existed carries.
  reasonTmdbId?: number | null;
  reasonTitle?: string | null;
  reasonMediaType?: MT | null;
  reasonSource?: "WATCH_HISTORY" | "WATCHLIST" | null;
  seedCount?: number;
}

let users: UserRow[] = [];
let authSessions: AuthSessionRow[] = [];
let mediaServerUsers: MediaServerUserRow[] = [];
let playHistoryRows: PlayHistoryRow[] = [];
let watchlistRows: WatchlistRow[] = [];
let userRecRows: UserRecRow[] = [];
let transactionCalls = 0;
let watchlistFindManyCalls = 0;

// ── prisma.user ───────────────────────────────────────────────────────────
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = users.find((x) => x.id === args.where.id);
    return u ? { plexUserId: u.plexUserId, jellyfinUserId: u.jellyfinUserId } : null;
  },
  findMany: async (args: {
    where: { deactivatedAt: null; purgedAt: null; authSessions: { some: { lastSeenAt: { gte: Date } } } };
  }) => {
    const cutoff = args.where.authSessions.some.lastSeenAt.gte;
    return users
      .filter((u) => u.deactivatedAt === null && u.purgedAt === null)
      .filter((u) => authSessions.some((s) => s.userId === u.id && s.lastSeenAt.getTime() >= cutoff.getTime()))
      .map((u) => ({ id: u.id }));
  },
});

// ── prisma.mediaServerUser (resolveLinkedMediaServerUserIds) ───────────────
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { OR: Array<{ userId?: string; source?: string; sourceUserId?: string }> } }) =>
    mediaServerUsers
      .filter((m) =>
        args.where.OR.some((cond) =>
          cond.userId !== undefined ? m.userId === cond.userId : m.source === cond.source && m.sourceUserId === cond.sourceUserId,
        ),
      )
      .map((m) => ({ id: m.id })),
});

// ── prisma.playHistory (seed groupBy + exclusion/drift findMany) ──────────
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: {
    where: { mediaServerUserId: { in: string[] }; startedAt?: { gte: Date } };
    take: number;
    orderBy?: ({ _count?: { tmdbId: "desc" } } | { _max?: { startedAt: "desc" } })[];
  }) => {
    const ids = new Set(args.where.mediaServerUserId.in);
    const cutoff = args.where.startedAt?.gte.getTime();
    const eligible = playHistoryRows.filter(
      (p) =>
        ids.has(p.mediaServerUserId) &&
        p.watched &&
        p.tmdbId != null &&
        p.mediaType != null &&
        (cutoff === undefined || p.startedAt.getTime() >= cutoff),
    );
    // _max.title rides along with _max.startedAt exactly as the real aggregate
    // does — the engine names a seed off it, so a stub that omitted it would
    // silently exercise the "TMDB #<id>" fallback instead of the real path.
    const groups = new Map<string, { tmdbId: number; mediaType: MT; count: number; max: number; title: string }>();
    for (const r of eligible) {
      const key = `${r.tmdbId}:${r.mediaType}`;
      const title = r.title ?? `Watched ${r.tmdbId}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        if (r.startedAt.getTime() > g.max) {
          g.max = r.startedAt.getTime();
          g.title = title;
        }
      } else {
        groups.set(key, { tmdbId: r.tmdbId as number, mediaType: r.mediaType as MT, count: 1, max: r.startedAt.getTime(), title });
      }
    }
    // HONOUR args.orderBy rather than assuming one. This stub used to hardcode
    // count-first, which silently made the selection ORDER untestable: a change
    // to the real query's orderBy could not move a single assertion here.
    const comparators = (args.orderBy ?? [{ _count: { tmdbId: "desc" as const } }]).map((clause) =>
      "_count" in clause && clause._count
        ? (a: { count: number }, b: { count: number }) => b.count - a.count
        : (a: { max: number }, b: { max: number }) => b.max - a.max,
    );
    return [...groups.values()]
      .sort((a, b) => {
        for (const cmp of comparators) {
          const d = cmp(a, b);
          if (d !== 0) return d;
        }
        return 0;
      })
      .slice(0, args.take)
      .map((g) => ({
        tmdbId: g.tmdbId,
        mediaType: g.mediaType,
        _count: { tmdbId: g.count },
        _max: { startedAt: new Date(g.max), title: g.title },
      }));
  },
  findMany: async (args: { where: { mediaServerUserId: { in: string[] } } }) => {
    const ids = new Set(args.where.mediaServerUserId.in);
    const eligible = playHistoryRows.filter((p) => ids.has(p.mediaServerUserId) && p.watched && p.tmdbId != null && p.mediaType != null);
    const seen = new Set<string>();
    const out: { tmdbId: number; mediaType: MT }[] = [];
    for (const r of eligible) {
      const key = `${r.tmdbId}:${r.mediaType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tmdbId: r.tmdbId as number, mediaType: r.mediaType as MT });
    }
    return out;
  },
});

// ── prisma.watchlistItem ────────────────────────────────────────────────────
shadowPrismaModel(prisma, "watchlistItem", {
  findMany: async (args: { where: { userId: string }; orderBy?: { createdAt: "desc" }; take?: number }) => {
    watchlistFindManyCalls++;
    let rows = watchlistRows.filter((w) => w.userId === args.where.userId);
    if (args.orderBy?.createdAt === "desc") rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (args.take != null) rows = rows.slice(0, args.take);
    return rows.map((r) => ({
      tmdbId: r.tmdbId,
      mediaType: r.mediaType,
      title: r.title ?? `Listed ${r.tmdbId}`,
      createdAt: r.createdAt,
    }));
  },
});

// ── prisma.userRecommendation (cache read + cron write) ────────────────────
shadowPrismaModel(prisma, "userRecommendation", {
  findMany: async (args: { where: { userId: string }; orderBy?: { rank: "asc" } }) => {
    let rows = userRecRows.filter((r) => r.userId === args.where.userId);
    if (args.orderBy?.rank === "asc") rows = [...rows].sort((a, b) => a.rank - b.rank);
    return rows.map((r) => ({
      ...r,
      reasonTmdbId: r.reasonTmdbId ?? null,
      reasonTitle: r.reasonTitle ?? null,
      reasonMediaType: r.reasonMediaType ?? null,
      reasonSource: r.reasonSource ?? null,
      seedCount: r.seedCount ?? 1,
    }));
  },
  // getRecommendationSummary: newest build time for the user…
  aggregate: async (args: { where: { userId: string } }) => {
    const rows = userRecRows.filter((r) => r.userId === args.where.userId);
    const max = rows.reduce<Date | null>(
      (acc, r) => (acc === null || r.computedAt.getTime() > acc.getTime() ? r.computedAt : acc),
      null,
    );
    return { _max: { computedAt: max } };
  },
  // …and the DISTINCT (source, seed) pairs behind the visible picks. Real
  // groupBy returns one row per distinct combination, which is the whole point
  // of the query — one seed that produced 40 picks must count once.
  groupBy: async (args: { where: { userId: string } }) => {
    const seen = new Set<string>();
    const out: { reasonSource: string | null; reasonTmdbId: number | null }[] = [];
    for (const r of userRecRows) {
      if (r.userId !== args.where.userId) continue;
      if (r.reasonSource == null || r.reasonTmdbId == null) continue;
      const key = `${r.reasonSource}:${r.reasonTmdbId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ reasonSource: r.reasonSource, reasonTmdbId: r.reasonTmdbId });
    }
    return out;
  },
  deleteMany: async (args: { where: { userId: string } }) => {
    const before = userRecRows.length;
    userRecRows = userRecRows.filter((r) => r.userId !== args.where.userId);
    return { count: before - userRecRows.length };
  },
  createMany: async (args: { data: UserRecRow[] }) => {
    userRecRows.push(...args.data);
    return { count: args.data.length };
  },
});

// batchCreateMany calls tx.createMany directly (not a delegate lookup), and
// warmRecommendationsCache's $transaction callback receives `tx` — shadowing
// $transaction to just invoke the callback with `prisma` itself means
// tx.userRecommendation resolves to the same shadowed delegate above.
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) => {
  transactionCalls++;
  return fn(prisma);
});

// ── prisma.setting ──────────────────────────────────────────────────────────
// No MDBList/OMDB key configured. Both clients short-circuit on a null key
// (`if (!apiKey) return`), so the quality prior runs on CACHED ratings alone and
// this suite can never reach the network — while still exercising the real
// attachRatingsUnified path rather than a stub of it.
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => null,
  findMany: async () => [],
});

// ── tmdbCache ───────────────────────────────────────────────────────────────
// findUnique always misses (suggestion-cache correctness is tmdb.ts's concern,
// not this file's) and writes are swallowed. findMany DOES serve, because it is
// what readCachedRatings reads: seeding `ratingRows` lets the quality prior be
// driven deterministically with zero network — MDBList/OMDB are only consulted
// for keys the cache misses, and here it never misses for a seeded title.
let ratingRows: { key: string; data: string; expiresAt: Date }[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    const wanted = new Set(args.where.key.in);
    return ratingRows.filter((r) => wanted.has(r.key));
  },
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});

// Writes an MDBList-shaped ratings row for a title, fresh (never stale) so
// attachRatingsUnified serves it without attempting a revalidation fetch.
function seedRatings(
  tmdbId: number,
  mediaType: "movie" | "tv",
  ratings: Record<string, unknown>,
): void {
  ratingRows.push({
    key: `mdblist:tmdb:${mediaType}:${tmdbId}`,
    data: JSON.stringify(ratings),
    expiresAt: new Date(T0 + 7 * DAY_MS),
  });
}

// ── scripted TMDB fetch ──────────────────────────────────────────────────────
// Keyed by "movie:<id>" / "tv:<id>"; the same result set answers BOTH /similar
// and /recommendations for that seed (getMovieSuggestions/getTVSuggestions
// already dedupe the two responses by id, so duplicating content across them
// doesn't double-count).
const suggestionsFor = new Map<string, RawFixture[]>();
interface RawFixture {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  // Present on TMDB's real list payloads, which is why the language profile
  // costs no extra request — normalizeMovie/normalizeTV carry it straight
  // through onto the suggestion items.
  original_language?: string;
}
function movieItem(id: number): RawFixture {
  return {
    id,
    title: `Movie ${id}`,
    overview: `overview ${id}`,
    poster_path: `/poster${id}.jpg`,
    backdrop_path: `/backdrop${id}.jpg`,
    release_date: "2020-01-01",
    vote_average: 7,
  };
}
function tvItem(id: number): RawFixture {
  return {
    id,
    name: `Show ${id}`,
    overview: `overview ${id}`,
    poster_path: `/poster${id}.jpg`,
    backdrop_path: `/backdrop${id}.jpg`,
    first_air_date: "2020-01-01",
    vote_average: 7,
  };
}

const fetchCalls: string[] = [];
// Simulates TMDB being unreachable. A network failure rejects, which lands in the
// Promise.allSettled INSIDE getMovieSuggestions/getTVSuggestions — those swallow it
// and return [], which is exactly why an outage is indistinguishable from "no
// suggestions" one layer up and why the conclusive flag has to exist.
let tmdbOutage = false;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url.pathname);
  if (tmdbOutage) throw new TypeError("fetch failed");
  // Not anchored to the start: TMDB's real paths carry a version prefix
  // (/3/movie/{id}/similar) — match the suffix shape regardless of it.
  const match = url.pathname.match(/\/(movie|tv)\/(\d+)\/(similar|recommendations)$/);
  const items = match ? (suggestionsFor.get(`${match[1]}:${match[2]}`) ?? []) : [];
  return new Response(JSON.stringify({ page: 1, results: items, total_pages: 1, total_results: items.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// ── shared fixtures ──────────────────────────────────────────────────────────
function daysAgo(n: number): Date {
  return new Date(T0 - n * DAY_MS);
}

beforeEach(() => {
  users = [];
  authSessions = [];
  mediaServerUsers = [];
  playHistoryRows = [];
  watchlistRows = [];
  userRecRows = [];
  suggestionsFor.clear();
  ratingRows = [];
  fetchCalls.length = 0;
  tmdbOutage = false;
  transactionCalls = 0;
  watchlistFindManyCalls = 0;
});

// ── cold start ───────────────────────────────────────────────────────────────

test("TV seeds route through getTVSuggestions and round-trip the Prisma MediaType enum correctly", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [{ mediaServerUserId: "msu1", tmdbId: 40, mediaType: "TV", watched: true, startedAt: daysAgo(1) }];
  suggestionsFor.set("tv:40", [tvItem(900)]);

  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates.map((c) => ({ tmdbId: c.tmdbId, mediaType: c.mediaType })), [{ tmdbId: 900, mediaType: "TV" }]);
  assert.ok(fetchCalls.some((p) => p.endsWith("/tv/40/similar") || p.endsWith("/tv/40/recommendations")));
});

test("cold start: a user with no watch history or watchlist gets [] with zero TMDB calls", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates, []);
  // No seeds is a LEGITIMATE empty — conclusive, so the caller clears stale rows.
  assert.equal(result.conclusive, true);
  assert.equal(fetchCalls.length, 0);
});

// ── seed selection ───────────────────────────────────────────────────────────

test("only watched:true rows seed the engine — a merely-sampled (watched:false) title never becomes a seed", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) },
    { mediaServerUserId: "msu1", tmdbId: 99, mediaType: "MOVIE", watched: false, startedAt: daysAgo(0) },
  ];
  suggestionsFor.set("movie:10", [movieItem(500)]);
  suggestionsFor.set("movie:99", [movieItem(600)]); // must never be fetched — 99 isn't a seed

  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates.map((c) => c.tmdbId), [500]);
  assert.ok(!fetchCalls.some((p) => p.startsWith("/movie/99/")), "watched:false row must not become a seed");
});

test("seed recency window: an old episode binge outside 180 days seeds BEHIND the recent watch (top-up), never past it, and stays EXCLUDED", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    // A three-row "binge" 400 days ago — unwindowed it would outrank the recent
    // watch on count and take seed index 0 (the highest weight). With the
    // windowed-first + all-time top-up, it still seeds (busy users with sparse
    // recent history must not lose their pool) but only in a TAIL slot: the
    // recent watch keeps index 0 and the higher weight.
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "TV", watched: true, startedAt: daysAgo(400) },
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "TV", watched: true, startedAt: daysAgo(401) },
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "TV", watched: true, startedAt: daysAgo(402) },
    { mediaServerUserId: "msu1", tmdbId: 20, mediaType: "TV", watched: true, startedAt: daysAgo(2) },
  ];
  // Distinct suggestions per seed prove the ordering: 222 (from the recent
  // watch's higher-weight slot) must rank ahead of 111 (from the binge's tail
  // slot). The old watch itself must still be excluded (exclusion is all-time)
  // — 10 arriving as a suggestion must not surface.
  suggestionsFor.set("tv:10", [tvItem(111)]);
  suggestionsFor.set("tv:20", [tvItem(222), tvItem(10)]);

  const result = await computeRecommendationsForUser("u1");

  assert.deepEqual(
    result.candidates.map((c) => c.tmdbId),
    [222, 111],
    "the recent watch's suggestion must outrank the topped-up binge's",
  );
  assert.ok(fetchCalls.some((p) => p.includes("/tv/10/")), "the beyond-window title tops up the unused seed slots");
});

test("windowed-first top-up: a busy user's few recent watches keep the TOP slots while old favorites fill the tail", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    // Old favorite watched 3× (all-time count winner) vs one recent watch.
    { mediaServerUserId: "msu1", tmdbId: 50, mediaType: "MOVIE", watched: true, startedAt: daysAgo(300) },
    { mediaServerUserId: "msu1", tmdbId: 50, mediaType: "MOVIE", watched: true, startedAt: daysAgo(301) },
    { mediaServerUserId: "msu1", tmdbId: 50, mediaType: "MOVIE", watched: true, startedAt: daysAgo(302) },
    { mediaServerUserId: "msu1", tmdbId: 60, mediaType: "MOVIE", watched: true, startedAt: daysAgo(3) },
  ];
  suggestionsFor.set("movie:50", [movieItem(555)]);
  suggestionsFor.set("movie:60", [movieItem(666)]);

  const result = await computeRecommendationsForUser("u1");

  // Both seed — but the recent watch is weighted on its OWN age, so it wins
  // despite the old favorite having 3x the plays. This is the case the scoring
  // rework is for: under the previous list-position taper the count-ordered
  // binge took slot 0 and outranked a watch from three days ago.
  assert.deepEqual(
    result.candidates.map((c) => c.tmdbId),
    [666, 555],
    "recent taste ranks first; the topped-up old favorite trails",
  );
  // Seed dedup across the two groupings: 60 sits in BOTH the windowed and the
  // all-time result, so a missing dedup would seed it twice and double 666's
  // score. Derivations (see the scoring block in recommendations.ts):
  //   666 = 1.0 × recency(3d)   × count(1) × position(0) = 0.9913855…
  //   555 = 1.0 × recency(300d) × count(3) × position(0) = 0.5558331…
  const byId = new Map(result.candidates.map((c) => [c.tmdbId, c]));
  const near = (actual: number, expected: number, msg: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} (got ${actual}, want ~${expected})`);
  near(byId.get(666)!.score, 0.991385515264672, "one contribution — a duplicated seed would double this");
  near(byId.get(555)!.score, 0.555833141019026, "the older, more-watched seed contributes less");
  assert.ok(byId.get(666)!.score < 1.5, "a doubled seed would land far above this");
});

test("seed recency window: ONLY-old history falls back to all-time seeding instead of clearing the shelf", async () => {
  // A dormant household (nothing watched in 180 days, empty watchlist) must not
  // collapse to zero seeds: that reads as a CONCLUSIVE empty and would clear an
  // established shelf. All-time seeding is the fallback, not the default.
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(400) },
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(390) },
  ];
  suggestionsFor.set("movie:10", [movieItem(333)]);

  const result = await computeRecommendationsForUser("u1");

  assert.deepEqual(result.candidates.map((c) => c.tmdbId), [333]);
  assert.equal(result.conclusive, true);
});

// ── scoring: ranking, recency interpolation, seed-type weight, corroboration ─

test("scoring: recency + compressed play-count per seed, positional decay per suggestion, watchlist (1.5x) over history, and multi-seed corroboration", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];

  // Two history seeds: tmdbId 10 watched twice (last 1d ago), tmdbId 20 watched
  // once (3d ago). One watchlist seed, tmdbId 30, added today. Seed weights are
  // now ABSOLUTE — typeWeight × recency(age) × count(plays) — so they no longer
  // depend on how many seeds there are or what order they were selected in:
  //   seed 10 = 1.0 × recency(1d) × count(2) = 1.0871661…
  //   seed 20 = 1.0 × recency(3d) × count(1) = 0.9913855…
  //   seed 30 = 1.5 × recency(0d) × count(1) = 1.5
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(5) },
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) },
    { mediaServerUserId: "msu1", tmdbId: 20, mediaType: "MOVIE", watched: true, startedAt: daysAgo(3) },
  ];
  watchlistRows = [{ userId: "u1", tmdbId: 30, mediaType: "MOVIE", createdAt: daysAgo(0) }];

  // Candidate 999 is corroborated by all three seeds; 888 only by seed 20.
  suggestionsFor.set("movie:10", [movieItem(999)]);
  suggestionsFor.set("movie:20", [movieItem(999), movieItem(888)]);
  suggestionsFor.set("movie:30", [movieItem(999)]);

  const result = await computeRecommendationsForUser("u1");
  const byId = new Map(result.candidates.map((c) => [c.tmdbId, c]));
  const near = (actual: number | undefined, expected: number, msg: string) =>
    assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${msg} (got ${actual}, want ~${expected})`);

  // 999 is first in all three lists, so it collects each seed's full weight.
  near(byId.get(999)?.score, 3.578551633309524, "corroboration sums every seed's contribution");

  // 888 sits SECOND in seed 20's list, so it is discounted by position(1) =
  // 1/(1 + 1/10). Without positional decay it would score seed 20's full
  // 0.9913855 — the assertion below is what distinguishes the two.
  near(byId.get(888)?.score, 0.901259559331520, "a later suggestion in the same list is worth less");
  assert.ok(
    byId.get(888)!.score < 0.991385515264672,
    "position 1 must score strictly below the seed's full weight",
  );

  assert.deepEqual(result.candidates.map((c) => c.tmdbId), [999, 888]); // ranked by score desc
  assert.equal(byId.get(999)?.rank, 0);
  assert.equal(byId.get(888)?.rank, 1);
});

test("scoring: a fresh single watch outweighs an old binge — recency beats raw play count", async () => {
  // The compression in countFactor is what makes this true. PlayHistory writes
  // one row PER EPISODE, so an unweighted count puts a 40-episode series ~40x
  // above any film and the shelf becomes whatever was binged longest ago.
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    ...Array.from({ length: 40 }, (_, i) => ({
      mediaServerUserId: "msu1", tmdbId: 70, mediaType: "TV" as MT, watched: true, startedAt: daysAgo(500 + i),
    })),
    { mediaServerUserId: "msu1", tmdbId: 80, mediaType: "MOVIE", watched: true, startedAt: daysAgo(2) },
  ];
  suggestionsFor.set("tv:70", [tvItem(700)]);
  suggestionsFor.set("movie:80", [movieItem(800)]);

  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(
    result.candidates.map((c) => c.tmdbId),
    [800, 700],
    "the recent movie's suggestion outranks the long-ago 40-episode binge's",
  );

  // The binge is not silenced, just outweighed — it still carries more than the
  // floor, because count DOES contribute. Both halves matter: a countFactor of
  // 1 would make this equal to any single old watch, and an uncompressed one
  // would put it back on top.
  const byId = new Map(result.candidates.map((c) => [c.tmdbId, c]));
  assert.ok(byId.get(700)!.score > 0.25, "an old binge still votes");
  assert.ok(byId.get(700)!.score < byId.get(800)!.score, "but never above fresh taste");
});

// ── the stored "why" ─────────────────────────────────────────────────────────

test("reason: a candidate names the STRONGEST seed that surfaced it, not the first one seen", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];

  // Seeds are concatenated history-then-watchlist, so the history seed is
  // encountered FIRST while the watchlist seed (1.5x) is the heavier one. A
  // first-wins implementation would name "The Weak One" here — the failure this
  // test exists to catch, since the resulting page still looks plausible.
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(5), title: "The Weak One" },
  ];
  watchlistRows = [{ userId: "u1", tmdbId: 30, mediaType: "MOVIE", createdAt: daysAgo(0), title: "The Strong One" }];

  suggestionsFor.set("movie:10", [movieItem(999)]);
  suggestionsFor.set("movie:30", [movieItem(999)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  // 0.9856975 (history, 5d old) + 1.5 (watchlist, added today), both at position 0.
  assert.ok(Math.abs(c.score - 2.485697565751686) < 1e-9, `score was ${c.score}`);
  assert.equal(c.reasonTitle, "The Strong One");
  assert.equal(c.reasonTmdbId, 30);
  assert.equal(c.reasonSource, "WATCHLIST");
  assert.equal(c.reasonMediaType, "MOVIE");
  assert.equal(c.seedCount, 2, "both seeds corroborated it");
});

test("reason: a WEAKER later seed does not steal the reason, and seedCount still counts it", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];

  // Reverse of the case above: the heaviest seed comes first (history seed 10 at
  // full weight 1.0), and the later seeds are strictly lighter — the taper puts
  // seed 20 at 0.5, and the sole watchlist seed at 1.5 is EXCLUDED from this
  // fixture so nothing can outweigh the incumbent.
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Top Seed" },
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(2), title: "Top Seed" },
    { mediaServerUserId: "msu1", tmdbId: 20, mediaType: "MOVIE", watched: true, startedAt: daysAgo(3), title: "Lesser Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(999)]);
  suggestionsFor.set("movie:20", [movieItem(999)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.equal(candidates[0].reasonTitle, "Top Seed");
  assert.equal(candidates[0].reasonSource, "WATCH_HISTORY");
  assert.equal(candidates[0].seedCount, 2);
});

test("reason: a TV seed's reason keeps its own mediaType, independent of the recommended title's", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 40, mediaType: "TV", watched: true, startedAt: daysAgo(1), title: "Some Show" },
  ];
  suggestionsFor.set("tv:40", [tvItem(900)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.equal(candidates[0].mediaType, "TV");
  assert.equal(candidates[0].reasonMediaType, "TV");
  assert.equal(candidates[0].reasonTitle, "Some Show");
});

test("getUserRecommendations surfaces the reason, and omits it entirely for a pre-column row", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  userRecRows = [
    {
      id: "r1", userId: "u1", tmdbId: 501, mediaType: "MOVIE", title: "With Reason",
      overview: null, posterPath: null, backdropPath: null, releaseDate: "2021-05-05",
      voteAverage: 7, score: 2, rank: 0, computedAt: daysAgo(0),
      reasonTmdbId: 10, reasonTitle: "Because Of This", reasonMediaType: "MOVIE",
      reasonSource: "WATCH_HISTORY", seedCount: 3,
    },
    // Written before the columns existed: every reason field null. It must come
    // back WITHOUT a recommendedBecause key rather than with a half-built one.
    {
      id: "r2", userId: "u1", tmdbId: 502, mediaType: "MOVIE", title: "No Reason",
      overview: null, posterPath: null, backdropPath: null, releaseDate: "2019-01-01",
      voteAverage: 6, score: 1, rank: 1, computedAt: daysAgo(0),
    },
  ];

  const out = await getUserRecommendations("u1");
  assert.deepEqual(out.map((m) => m.id), [501, 502]);
  assert.deepEqual(out[0].recommendedBecause, {
    tmdbId: 10,
    title: "Because Of This",
    mediaType: "movie", // DB enum → TmdbMedia's lowercase union
    source: "WATCH_HISTORY",
    seedCount: 3,
  });
  assert.equal(out[1].recommendedBecause, undefined);
});

test("matchTier: bands are assigned by RANK over the viewer's whole set, top 10% then top 33%", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  const base = {
    userId: "u1", mediaType: "MOVIE" as MT, overview: null, posterPath: null,
    backdropPath: null, releaseDate: null, voteAverage: 0, computedAt: new Date(T0),
  };
  // 20 picks: ceil(20 × 0.10) = 2 "top", then up to ceil(20 × 0.33) = 7 "strong",
  // so ranks 0-1 are top, 2-6 strong, 7-19 unlabelled.
  userRecRows = Array.from({ length: 20 }, (_, i) => ({
    ...base, id: `r${i}`, tmdbId: 100 + i, title: `T${i}`, score: 20 - i, rank: i,
  }));

  const out = await getUserRecommendations("u1");
  assert.equal(out.length, 20);
  assert.deepEqual(out.slice(0, 2).map((m) => m.matchTier), ["top", "top"]);
  assert.deepEqual(out.slice(2, 7).map((m) => m.matchTier), ["strong", "strong", "strong", "strong", "strong"]);
  assert.deepEqual(
    out.slice(7).map((m) => m.matchTier),
    Array(13).fill(undefined),
    "the long tail carries no chip — a label everything gets says nothing",
  );
});

test("matchTier: a one-pick shelf still labels its best", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  userRecRows = [
    {
      id: "solo", userId: "u1", tmdbId: 11, mediaType: "MOVIE", title: "Only Pick",
      overview: null, posterPath: null, backdropPath: null, releaseDate: null,
      voteAverage: 0, score: 9, rank: 0, computedAt: new Date(T0),
    },
  ];
  // ceil(1 × 0.1) = 1, so the single pick is labelled. Flooring would round the
  // top band away entirely and a small shelf would carry no chips at all.
  const out = await getUserRecommendations("u1");
  assert.deepEqual(out.map((m) => m.matchTier), ["top"]);
});

test("matchTier: bands are computed over the SURVIVING set, not the stored one", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  const base = {
    userId: "u1", mediaType: "MOVIE" as MT, overview: null, posterPath: null,
    backdropPath: null, releaseDate: null, voteAverage: 0, computedAt: new Date(T0),
  };
  // 20 stored, but the viewer has since watched the bottom 10 — so 10 survive.
  userRecRows = Array.from({ length: 20 }, (_, i) => ({
    ...base, id: `r${i}`, tmdbId: 100 + i, title: `T${i}`, score: 20 - i, rank: i,
  }));
  playHistoryRows = Array.from({ length: 10 }, (_, i) => ({
    mediaServerUserId: "msu1", tmdbId: 110 + i, mediaType: "MOVIE" as MT,
    watched: true, startedAt: daysAgo(1), title: `T${10 + i}`,
  }));

  const out = await getUserRecommendations("u1");
  assert.equal(out.length, 10, "the watched half is filtered out first");

  // Sized to 10 survivors: ceil(10 × 0.1) = 1 top, ceil(10 × 0.33) = 4 → ranks
  // 1-3 strong. Sizing to the stored 20 instead would give 2 top and 7 strong,
  // so index 1 is the discriminator — "top" there means the band was computed
  // against rows the viewer can no longer see.
  assert.deepEqual(
    out.map((m) => m.matchTier),
    ["top", "strong", "strong", "strong", undefined, undefined, undefined, undefined, undefined, undefined],
  );
  assert.equal(out[1].matchTier, "strong", "banding against the pre-drift set would make this 'top'");
});

test("matchTier: a pre-reason row is still banded — rank is known even when the why is not", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  userRecRows = [
    {
      id: "old", userId: "u1", tmdbId: 42, mediaType: "MOVIE", title: "Pre-migration",
      overview: null, posterPath: null, backdropPath: null, releaseDate: null,
      voteAverage: 0, score: 5, rank: 0, computedAt: new Date(T0),
    },
  ];
  const out = await getUserRecommendations("u1");
  assert.equal(out[0].recommendedBecause, undefined);
  assert.equal(out[0].matchTier, "top", "the two labels are independent");
});

test("getRecommendationSummary: DISTINCT seeds per pool, and the newest build time", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  const base = {
    userId: "u1", mediaType: "MOVIE" as MT, title: "t", overview: null,
    posterPath: null, backdropPath: null, releaseDate: null, voteAverage: 0, seedCount: 1,
  };
  userRecRows = [
    // Two picks from ONE watched seed — it must count once, not twice.
    { ...base, id: "a", tmdbId: 1, score: 3, rank: 0, computedAt: daysAgo(2), reasonTmdbId: 10, reasonTitle: "A", reasonMediaType: "MOVIE", reasonSource: "WATCH_HISTORY" },
    { ...base, id: "b", tmdbId: 2, score: 2, rank: 1, computedAt: daysAgo(2), reasonTmdbId: 10, reasonTitle: "A", reasonMediaType: "MOVIE", reasonSource: "WATCH_HISTORY" },
    { ...base, id: "c", tmdbId: 3, score: 2, rank: 2, computedAt: daysAgo(2), reasonTmdbId: 11, reasonTitle: "B", reasonMediaType: "MOVIE", reasonSource: "WATCH_HISTORY" },
    { ...base, id: "d", tmdbId: 4, score: 1, rank: 3, computedAt: daysAgo(1), reasonTmdbId: 30, reasonTitle: "C", reasonMediaType: "MOVIE", reasonSource: "WATCHLIST" },
    // A reasonless row contributes to neither count.
    { ...base, id: "e", tmdbId: 5, score: 1, rank: 4, computedAt: daysAgo(3) },
    // Another user's rows must not leak in.
    { ...base, userId: "u2", id: "f", tmdbId: 6, score: 9, rank: 0, computedAt: daysAgo(0), reasonTmdbId: 99, reasonTitle: "X", reasonMediaType: "MOVIE", reasonSource: "WATCHLIST" },
  ];

  const summary = await getRecommendationSummary("u1");
  assert.equal(summary.watchHistorySeeds, 2); // seeds 10 and 11 — NOT 3 rows
  assert.equal(summary.watchlistSeeds, 1);
  assert.equal(summary.computedAt?.getTime(), daysAgo(1).getTime());
});

test("getRecommendationSummary: a user with no cached picks reports nothing rather than throwing", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  const summary = await getRecommendationSummary("u1");
  assert.deepEqual(summary, { computedAt: null, watchHistorySeeds: 0, watchlistSeeds: 0 });
});

// ── seed selection is recency-first ──────────────────────────────────────────

test("seed SELECTION is the last 100 titles played — a heavy old binge no longer takes a slot", async () => {
  // The selection key used to be play count, and PlayHistory writes one row per
  // EPISODE, so a long series could occupy the top slots forever while recent
  // films never seeded at all. The cap has to BITE for this to be observable,
  // so there are more distinct titles here than there are slots.
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    // Exactly MAX_WATCH_HISTORY_SEEDS recent titles, one play each.
    ...Array.from({ length: 100 }, (_, i) => ({
      mediaServerUserId: "msu1", tmdbId: 1000 + i, mediaType: "MOVIE" as MT,
      watched: true, startedAt: daysAgo(i + 1), title: `Recent ${i}`,
    })),
    // A series with 50 plays, INSIDE the 180-day window but older than all 100
    // titles above. The window must not be what excludes it — otherwise this
    // test passes under either ordering and proves nothing (it did: the first
    // version put this at 200 days and was satisfied by the window alone).
    // Under count-first it was seed #1 by a wide margin and pushed the oldest
    // recent title out; under recency-first it is #101 and never seeds.
    ...Array.from({ length: 50 }, (_, i) => ({
      mediaServerUserId: "msu1", tmdbId: 5000, mediaType: "TV" as MT,
      watched: true, startedAt: daysAgo(150 + i), title: "Heavy Binge",
    })),
  ];
  for (let i = 0; i < 100; i++) suggestionsFor.set(`movie:${1000 + i}`, [movieItem(9000 + i)]);
  suggestionsFor.set("tv:5000", [tvItem(9999)]);

  await computeRecommendationsForUser("u1");

  assert.ok(fetchCalls.some((p) => p.includes("/movie/1000/")), "the most recent title seeds");
  assert.ok(fetchCalls.some((p) => p.includes("/movie/1099/")), "the 100th-most-recent title seeds");
  assert.ok(
    !fetchCalls.some((p) => p.includes("/tv/5000/")),
    "the 50-play binge is #101 by recency and must NOT seed, despite dwarfing every other title on play count",
  );
});

// ── language consistency ─────────────────────────────────────────────────────

test("language: a one-off foreign title is de-emphasised, but a substantial second language is kept", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  // 13 equally-recent seeds, each contributing EXACTLY ONE suggestion at
  // position 0. That is what makes this test about language and nothing else:
  // seed weights are identical and positional decay is constant, so any score
  // difference can only come from the language factor. (An earlier version let
  // the foreign titles sit at position 1, and passed with the factor disabled —
  // positional decay alone explained the gap.)
  playHistoryRows = Array.from({ length: 13 }, (_, i) => ({
    mediaServerUserId: "msu1", tmdbId: 10 + i, mediaType: "MOVIE" as MT,
    watched: true, startedAt: daysAgo(1), title: `Seed ${i}`,
  }));
  // 10 English, 2 Japanese (a real second taste, 2/13 = 15.4% — just over
  // LANGUAGE_FULL_SHARE), 1 Korean (1/13 = 7.7% — a one-off, well under it).
  for (let i = 0; i < 10; i++) suggestionsFor.set(`movie:${10 + i}`, [{ ...movieItem(500 + i), original_language: "en" }]);
  suggestionsFor.set("movie:20", [{ ...movieItem(600), original_language: "ja" }]);
  suggestionsFor.set("movie:21", [{ ...movieItem(601), original_language: "ja" }]);
  suggestionsFor.set("movie:22", [{ ...movieItem(700), original_language: "ko" }]);

  const { candidates } = await computeRecommendationsForUser("u1");
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  const en = byId.get(500)!;
  const ja = byId.get(600)!;
  const ko = byId.get(700)!;

  // ja clears the full-share threshold, so it is NOT discounted at all.
  assert.ok(Math.abs(ja.score - en.score) < 1e-9, "a substantial second language is untouched");

  // ko is under the threshold: factor = 0.35 + 0.65 × (1/13) / 0.15 = 0.6833…
  assert.ok(ko.score < ja.score, "the one-off language is de-emphasised");
  assert.ok(
    Math.abs(ko.score / en.score - (0.35 + 0.65 * (1 / 13) / 0.15)) < 1e-9,
    `expected the documented factor, got ratio ${ko.score / en.score}`,
  );

  // De-emphasis is a MULTIPLIER, not a filter: the Korean title still appears.
  assert.ok(ko.score > 0, "a de-emphasised language is still present, not removed");
});

test("language: with only one language present, nothing is penalised", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [{ ...movieItem(555), original_language: "en" }]);

  const { candidates } = await computeRecommendationsForUser("u1");
  // Share is 1.0, so languageFactor is exactly 1 and the score is the raw
  // contribution — a monolingual viewer must not be silently scaled down.
  // 1.0 (type) × recency(1d) × count(1) × position(0)
  //   = 0.25 + 0.75 × 0.5^(1/180) = 0.9971174404154314
  assert.ok(Math.abs(candidates[0].score - 0.9971174404154314) < 1e-12, `score was ${candidates[0].score}`);
});

test("language: a title with no language recorded is left alone", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = Array.from({ length: 6 }, (_, i) => ({
    mediaServerUserId: "msu1", tmdbId: 10 + i, mediaType: "MOVIE" as MT,
    watched: true, startedAt: daysAgo(1), title: `Seed ${i}`,
  }));
  for (let i = 0; i < 5; i++) suggestionsFor.set(`movie:${10 + i}`, [{ ...movieItem(500 + i), original_language: "en" }]);
  // No original_language on this one — missing metadata is not evidence of
  // anything, so it must not be treated as a rare language and demoted.
  suggestionsFor.set("movie:15", [movieItem(900)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  const unknown = candidates.find((c) => c.tmdbId === 900)!;
  const english = candidates.find((c) => c.tmdbId === 500)!;
  assert.ok(Math.abs(unknown.score - english.score) < 1e-9, "an unknown language scores exactly as the dominant one");
});

// ── quality prior ────────────────────────────────────────────────────────────

test("quality: better-rated candidates outrank equally-relevant worse-rated ones", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  // Same seed, adjacent positions — so relevance is near-identical and the
  // acclaimed title starts marginally BEHIND on position alone. Only the
  // ratings can reorder them, which is the point of the test.
  suggestionsFor.set("movie:10", [
    { ...movieItem(111), original_language: "en" }, // panned, but listed first
    { ...movieItem(222), original_language: "en" }, // acclaimed, listed second
  ]);
  seedRatings(111, "movie", { imdbRating: "3.1", rottenTomatoes: "18", metacritic: "24" });
  seedRatings(222, "movie", { imdbRating: "8.6", rottenTomatoes: "94", metacritic: "88" });

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.deepEqual(
    candidates.map((c) => c.tmdbId),
    [222, 111],
    "the acclaimed title overtakes despite starting lower on relevance",
  );
});

test("quality: an unrated title is neutral — never penalised against a rated one", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [
    { ...movieItem(111), original_language: "en" }, // rated BADLY, listed first
    { ...movieItem(222), original_language: "en" }, // no ratings at all, second
  ]);
  seedRatings(111, "movie", { imdbRating: "2.0", rottenTomatoes: "9", metacritic: "12" });

  const { candidates } = await computeRecommendationsForUser("u1");
  // Ratings coverage is partial by design (OMDB is quota-bound), so "unrated"
  // must never be read as "bad" — otherwise the shelf silently becomes
  // whatever the rating providers happened to cover.
  assert.deepEqual(
    candidates.map((c) => c.tmdbId),
    [222, 111],
    "the unrated title keeps its full relevance score and passes the panned one",
  );
});

test("quality: a ratings outage degrades to relevance-only instead of failing the run", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(111), movieItem(222)]);

  // The ratings read itself throws — a DB blip, a provider client fault.
  const original = prisma.tmdbCache.findMany;
  (prisma.tmdbCache as { findMany: unknown }).findMany = async () => {
    throw new Error("ratings backend unavailable");
  };
  try {
    const { candidates, conclusive } = await computeRecommendationsForUser("u1");
    assert.equal(conclusive, true, "a ratings failure must not be read as a TMDB outage");
    assert.deepEqual(candidates.map((c) => c.tmdbId), [111, 222], "relevance order stands");
  } finally {
    (prisma.tmdbCache as { findMany: unknown }).findMany = original;
  }
});

// ── exclusion wider than the chosen seeds ────────────────────────────────────

test("exclusion covers the FULL current watchlist and watched-set, not just the chosen seeds", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) },
    // Watched, but never chosen as a seed (below) — still must be excluded.
    { mediaServerUserId: "msu1", tmdbId: 700, mediaType: "MOVIE", watched: true, startedAt: daysAgo(9) },
  ];
  // 6 watchlist rows; only the 5 most-recent become seeds, the oldest (800) doesn't.
  watchlistRows = [
    { userId: "u1", tmdbId: 301, mediaType: "MOVIE", createdAt: daysAgo(0) },
    { userId: "u1", tmdbId: 302, mediaType: "MOVIE", createdAt: daysAgo(1) },
    { userId: "u1", tmdbId: 303, mediaType: "MOVIE", createdAt: daysAgo(2) },
    { userId: "u1", tmdbId: 304, mediaType: "MOVIE", createdAt: daysAgo(3) },
    { userId: "u1", tmdbId: 305, mediaType: "MOVIE", createdAt: daysAgo(4) },
    { userId: "u1", tmdbId: 800, mediaType: "MOVIE", createdAt: daysAgo(5) },
  ];
  // Seed 10's suggestions include both unseeded exclusions plus one genuinely new title.
  suggestionsFor.set("movie:10", [movieItem(700), movieItem(800), movieItem(555)]);
  for (const id of [301, 302, 303, 304, 305]) suggestionsFor.set(`movie:${id}`, []);

  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates.map((c) => c.tmdbId).sort((a, b) => a - b), [555]);
  // Seed 10 answered, so this empty-after-exclusion answer is trustworthy.
  assert.equal(result.conclusive, true);
});

// ── warmRecommendationsCache: per-user transactions + active cohort ─────────

test("warmRecommendationsCache: one $transaction per eligible user, and the active cohort excludes deactivated/purged/dormant accounts", async () => {
  users = [
    { id: "active", plexUserId: "p-active", jellyfinUserId: null, deactivatedAt: null, purgedAt: null },
    { id: "dormant", plexUserId: "p-dormant", jellyfinUserId: null, deactivatedAt: null, purgedAt: null },
    { id: "deactivated", plexUserId: "p-deact", jellyfinUserId: null, deactivatedAt: daysAgo(2), purgedAt: null },
    { id: "purged", plexUserId: "p-purged", jellyfinUserId: null, deactivatedAt: daysAgo(10), purgedAt: daysAgo(9) },
  ];
  mediaServerUsers = [
    { id: "msu-active", source: "plex", sourceUserId: "p-active", userId: "active" },
    { id: "msu-dormant", source: "plex", sourceUserId: "p-dormant", userId: "dormant" },
  ];
  authSessions = [
    { userId: "active", lastSeenAt: daysAgo(1) }, // within the 30-day window
    { userId: "dormant", lastSeenAt: daysAgo(45) }, // outside the window
    { userId: "deactivated", lastSeenAt: daysAgo(1) },
    { userId: "purged", lastSeenAt: daysAgo(1) },
  ];
  playHistoryRows = [{ mediaServerUserId: "msu-active", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) }];
  suggestionsFor.set("movie:10", [movieItem(500)]);

  const result = await warmRecommendationsCache();

  assert.equal(result.usersEligible, 1, "only the active, non-deactivated, non-purged, recently-seen user is eligible");
  assert.equal(result.usersUpdated, 1);
  assert.equal(result.usersFailed, 0);
  assert.equal(result.usersSkipped, 0);
  assert.equal(result.candidatesWritten, 1);
  assert.equal(transactionCalls, 1, "exactly one transaction — never one spanning all users");
  assert.deepEqual(
    userRecRows.map((r) => [r.userId, r.tmdbId]),
    [["active", 500]],
  );
});

// ── getUserRecommendations: read path + drift re-filtering ──────────────────

test("getUserRecommendations: an empty cache returns [] without querying current watchlist/history state", async () => {
  const result = await getUserRecommendations("nobody-cached");
  assert.deepEqual(result, []);
  assert.equal(watchlistFindManyCalls, 0);
});

test("getUserRecommendations: drift re-filtering drops a cached candidate the user has SINCE watchlisted or watched", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  userRecRows = [
    {
      id: "r1", userId: "u1", tmdbId: 500, mediaType: "MOVIE", title: "Since Watchlisted",
      overview: "o", posterPath: "/p.jpg", backdropPath: "/b.jpg", releaseDate: "2020-01-01",
      voteAverage: 7, score: 3, rank: 0, computedAt: daysAgo(1),
    },
    {
      id: "r2", userId: "u1", tmdbId: 600, mediaType: "MOVIE", title: "Since Watched",
      overview: "o", posterPath: "/p.jpg", backdropPath: "/b.jpg", releaseDate: "2020-01-01",
      voteAverage: 7, score: 2, rank: 1, computedAt: daysAgo(1),
    },
    {
      id: "r3", userId: "u1", tmdbId: 700, mediaType: "MOVIE", title: "Still Fresh",
      overview: "o", posterPath: "/p.jpg", backdropPath: "/b.jpg", releaseDate: "2020-01-01",
      voteAverage: 7, score: 1, rank: 2, computedAt: daysAgo(1),
    },
  ];
  // Drift since the cron last ran: the user watchlisted 500 and watched 600.
  watchlistRows = [{ userId: "u1", tmdbId: 500, mediaType: "MOVIE", createdAt: daysAgo(0) }];
  playHistoryRows = [{ mediaServerUserId: "msu1", tmdbId: 600, mediaType: "MOVIE", watched: true, startedAt: daysAgo(0) }];

  const result = await getUserRecommendations("u1");
  assert.deepEqual(
    result.map((m) => m.id),
    [700],
  );
  const only = result[0];
  assert.equal(only.mediaType, "movie"); // lowercased for TmdbMedia, unlike the Prisma enum
  assert.equal(only.releaseYear, "2020"); // derived from releaseDate, not stored separately
});

// ── inconclusive vs legitimately-empty ──────────────────────────────────────

function storedRec(userId: string, tmdbId: number): UserRecRow {
  return {
    id: `rec-${userId}-${tmdbId}`, userId, tmdbId, mediaType: "MOVIE",
    title: `Movie ${tmdbId}`, overview: null, posterPath: null, backdropPath: null,
    releaseDate: null, voteAverage: 7, score: 1, rank: 0, computedAt: daysAgo(1),
  };
}

test("a TMDB outage yields an INCONCLUSIVE empty, not an authoritative one", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [{ mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) }];
  suggestionsFor.set("movie:10", [movieItem(500)]);
  tmdbOutage = true;

  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.conclusive, false, "seeds existed but nothing came back — the caller must not trust this empty");
});

test("upstream answering with everything already excluded is a CONCLUSIVE empty", async () => {
  // The discrimination that matters: empty alone must not imply inconclusive, or
  // a user who has genuinely watched every suggestion keeps stale rows forever.
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) },
    { mediaServerUserId: "msu1", tmdbId: 700, mediaType: "MOVIE", watched: true, startedAt: daysAgo(9) },
  ];
  suggestionsFor.set("movie:10", [movieItem(700)]); // the only suggestion is already watched

  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.conclusive, true, "a real answer that filters down to nothing is authoritative");
});

// ── warmRecommendationsCache: never replace good rows with an outage ────────

test("warmRecommendationsCache: a TMDB outage KEEPS existing recommendations and opens no transaction", async () => {
  // The write is delete-then-insert, so an inconclusive empty used to clear the
  // shelf — and, because the compute resolves rather than throws, be counted as a
  // successful update. Every active user would be wiped by one bad cron run.
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  authSessions = [{ userId: "u1", lastSeenAt: daysAgo(1) }];
  playHistoryRows = [{ mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) }];
  userRecRows = [storedRec("u1", 500), storedRec("u1", 501)];
  tmdbOutage = true;

  const result = await warmRecommendationsCache();

  assert.deepEqual(userRecRows.map((r) => r.tmdbId).sort((a, b) => a - b), [500, 501], "yesterday's recommendations must survive");
  assert.equal(transactionCalls, 0, "no destructive replace may even be attempted");
  assert.equal(result.usersSkipped, 1);
  assert.equal(result.usersUpdated, 0, "a skipped user must NOT be reported as updated");
  assert.equal(result.candidatesWritten, 0);
});

test("warmRecommendationsCache: a CONCLUSIVE empty still clears the user's stale rows", async () => {
  // Counterpart to the test above — pins that the guard did not simply stop the
  // cron from ever clearing anything.
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  authSessions = [{ userId: "u1", lastSeenAt: daysAgo(1) }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1) },
    { mediaServerUserId: "msu1", tmdbId: 700, mediaType: "MOVIE", watched: true, startedAt: daysAgo(9) },
  ];
  suggestionsFor.set("movie:10", [movieItem(700)]);
  userRecRows = [storedRec("u1", 500)];

  const result = await warmRecommendationsCache();

  assert.deepEqual(userRecRows, [], "an authoritative empty answer must clear the shelf");
  assert.equal(transactionCalls, 1);
  assert.equal(result.usersUpdated, 1);
  assert.equal(result.usersSkipped, 0);
});
