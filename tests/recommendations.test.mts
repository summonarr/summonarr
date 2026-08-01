// Unit tests for src/lib/recommendations.ts — the "For You" engine
// (computeRecommendationsForUser, warmRecommendationsCache,
// getUserRecommendations). Pinned here:
//   - cold start (zero seeds) short-circuits before any TMDB call;
//   - only watched:true PlayHistory rows seed the engine;
//   - scoring = seedTypeWeight × recencyWeight, summed across every seed that
//     surfaced a candidate (multi-seed corroboration), with watchlist seeds
//     (1.5x) outweighing watch-history seeds (1.0x) at equal recency;
//   - the exclusion set is wider than the chosen seeds — an unseeded
//     watchlist/watched title is still excluded from suggestions;
//   - warmRecommendationsCache does one $transaction PER eligible user (never
//     one spanning all users) and the active-user cohort excludes
//     deactivated/purged/dormant accounts;
//   - getUserRecommendations re-filters the cache against CURRENT
//     watchlist/watched state at read time (drift since the last cron run),
//     and skips those queries entirely when the cache is empty.
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
const { computeRecommendationsForUser, warmRecommendationsCache, getUserRecommendations } = await import(
  "../src/lib/recommendations.ts"
);

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
}
interface WatchlistRow {
  userId: string;
  tmdbId: number;
  mediaType: MT;
  createdAt: Date;
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
  groupBy: async (args: { where: { mediaServerUserId: { in: string[] } }; take: number }) => {
    const ids = new Set(args.where.mediaServerUserId.in);
    const eligible = playHistoryRows.filter((p) => ids.has(p.mediaServerUserId) && p.watched && p.tmdbId != null && p.mediaType != null);
    const groups = new Map<string, { tmdbId: number; mediaType: MT; count: number; max: number }>();
    for (const r of eligible) {
      const key = `${r.tmdbId}:${r.mediaType}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        if (r.startedAt.getTime() > g.max) g.max = r.startedAt.getTime();
      } else {
        groups.set(key, { tmdbId: r.tmdbId as number, mediaType: r.mediaType as MT, count: 1, max: r.startedAt.getTime() });
      }
    }
    return [...groups.values()]
      .sort((a, b) => b.count - a.count || b.max - a.max)
      .slice(0, args.take)
      .map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType, _count: { tmdbId: g.count }, _max: { startedAt: new Date(g.max) } }));
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
    return rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }));
  },
});

// ── prisma.userRecommendation (cache read + cron write) ────────────────────
shadowPrismaModel(prisma, "userRecommendation", {
  findMany: async (args: { where: { userId: string }; orderBy?: { rank: "asc" } }) => {
    let rows = userRecRows.filter((r) => r.userId === args.where.userId);
    if (args.orderBy?.rank === "asc") rows = [...rows].sort((a, b) => a.rank - b.rank);
    return rows.map((r) => ({ ...r }));
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

// ── tmdbCache (always miss, swallow writes — cache correctness is tmdb.ts's
// own concern, not this file's) ─────────────────────────────────────────────
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});

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

// ── scoring: ranking, recency interpolation, seed-type weight, corroboration ─

test("scoring: seed ranking (count desc, recency desc), recency-weighted contributions, watchlist (1.5x) outweighing history (1.0x), and multi-seed corroboration", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];

  // Two history seeds: tmdbId 10 watched twice (most-frequent → seed index 0,
  // weight 1.0×1.0), tmdbId 20 watched once (seed index 1 of 2, weight
  // 1.0×0.5). One watchlist seed: tmdbId 30 (sole entry, weight 1.5×1.0).
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

  // 999 = 1.0 (seed10) + 0.5 (seed20) + 1.5 (seed30) = 3.0; 888 = 0.5 (seed20 only).
  assert.equal(byId.get(999)?.score, 3.0);
  assert.equal(byId.get(888)?.score, 0.5);
  assert.deepEqual(result.candidates.map((c) => c.tmdbId), [999, 888]); // ranked by score desc
  assert.equal(byId.get(999)?.rank, 0);
  assert.equal(byId.get(888)?.rank, 1);
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
