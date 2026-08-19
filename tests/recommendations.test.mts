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
//   - a multi-source ratings prior re-weights the shortlist, TMDB's own score
//     included (its voteCount gate once read a field the prior forgot to pass —
//     the reintroduction mutation is pinned), with an UNRATED-with-audience
//     title strictly neutral, unrated-obscure damped by exactly OBSCURITY_DAMP,
//     and a ratings outage degrading to relevance-only rather than failing the
//     run. The prior is EVIDENCE-WEIGHTED and IMDb-led: IMDb's weight grows
//     with its vote count (comma-formatted OMDB counts included) and the
//     multiplier's strength scales with total evidence — both the votes-ignored
//     and confidence-dropped mutations flip a pinned ordering. Letterboxd, MAL
//     and RT-audience now participate; mdblistScore and rogerEbert stay
//     excluded by pin. Ratings are served from a seeded cache, so no test
//     reaches MDBList or OMDB;
//   - the exclusion set and the read-time drift filter share ONE reader
//     (collectKnownTitleKeys): hidden titles (enum-cased — the lowercase fold
//     is a pinned mutation), open PENDING/APPROVED requests, permanentlyDeclined
//     requests, own DeletionVotes and the admin blacklist are all out at
//     compute AND at read, while AVAILABLE and re-requestable DECLINED stay;
//   - the store holds the whole rated shortlist (300) while at most 200 are
//     served, so a drift exclusion backfills from the reserve at the same
//     render; and a title in both the watchlist and watch history seeds ONCE
//     (history wins);
//   - corroboration is decay-summed strongest-first (CORROBORATION_DECAY),
//     bounding any candidate's amplification at 4x its best contribution —
//     both the neutralised-decay and unsorted-contributions mutations are
//     pinned;
//   - the user's own requests are a third seed pool (REQUEST, weight 1.5,
//     capped 24 newest-first, per-arrInstance rows collapsed newest-wins,
//     every status seeding) — deduped history > watchlist > request, and
//     request seeds never self-fold into the exclusion set, so the kept
//     AVAILABLE/DECLINED classes stay recommendable even while seeding;
//   - a seedless user gets an HONEST fallback shelf from the trending/popular
//     caches: reasonSource TRENDING with null reason ids (the all-four gate
//     stays closed — fabricating them is a pinned mutation), seedCount 0,
//     stored score 0, never a match chip, ordered by trending-position ×
//     quality, exclusions still applied, and a pool outage reads INCONCLUSIVE
//     so yesterday's shelf survives; thin shelves top up the same way with
//     fallback ranked strictly below every real pick;
//   - a settled low-completion bail (watched:false only, cumulative playtime
//     under 35%, last touch 14+ days old) dampens THAT title by ABANDON_DAMP,
//     with the split-watch, fresh-pause and no-runtime guards each pinned by
//     mutation — and the playHistory.groupBy stub honours where.watched, so
//     the abandoned query cannot silently read the seed query's rows;
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
const { computeRecommendationsForUser, warmRecommendationsCache, getUserRecommendations, getRecommendationSummary, qualityScoreOf } =
  await import("../src/lib/recommendations.ts");
const { invalidateBlacklistCache } = await import("../src/lib/blacklist.ts");

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
  // Playback metrics for the abandoned-play query (watched:false rows).
  playDuration?: number;
  duration?: number;
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

interface HiddenRow { userId: string; tmdbId: number; mediaType: MT; createdAt: Date }
interface RequestRow {
  requestedBy: string;
  tmdbId: number;
  mediaType: MT;
  status: "PENDING" | "APPROVED" | "DECLINED" | "AVAILABLE";
  permanentlyDeclined: boolean;
  // Seed-query columns; defaulted in the stub so exclusion-only fixtures stay terse.
  title?: string;
  createdAt?: Date;
}
interface VoteRow { userId: string; tmdbId: number; mediaType: MT }
interface BlacklistRow { tmdbId: number; mediaType: MT }

let users: UserRow[] = [];
let authSessions: AuthSessionRow[] = [];
let mediaServerUsers: MediaServerUserRow[] = [];
let playHistoryRows: PlayHistoryRow[] = [];
let watchlistRows: WatchlistRow[] = [];
let userRecRows: UserRecRow[] = [];
let hiddenItems: HiddenRow[] = [];
let mediaRequests: RequestRow[] = [];
let deletionVotes: VoteRow[] = [];
let blacklistItems: BlacklistRow[] = [];
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
    where: { mediaServerUserId: { in: string[] }; watched: boolean; startedAt?: { gte: Date } };
    take: number;
    _sum?: { playDuration?: true };
    _max?: { startedAt?: true; title?: true; duration?: true };
    orderBy?: ({ _count?: { tmdbId: "desc" } } | { _max?: { startedAt: "desc" } })[];
  }) => {
    const ids = new Set(args.where.mediaServerUserId.in);
    const cutoff = args.where.startedAt?.gte.getTime();
    // HONOUR where.watched. This stub used to hardcode `p.watched` (truthy),
    // which silently served the watched:FALSE abandoned-play query the same
    // rows as the seed query — the abandoned test would then dampen nothing
    // and the guard branches would be exercised against the wrong data.
    const eligible = playHistoryRows.filter(
      (p) =>
        ids.has(p.mediaServerUserId) &&
        p.watched === args.where.watched &&
        p.tmdbId != null &&
        p.mediaType != null &&
        (cutoff === undefined || p.startedAt.getTime() >= cutoff),
    );
    // _max.title rides along with _max.startedAt exactly as the real aggregate
    // does — the engine names a seed off it, so a stub that omitted it would
    // silently exercise the "TMDB #<id>" fallback instead of the real path.
    const groups = new Map<
      string,
      { tmdbId: number; mediaType: MT; count: number; max: number; title: string; playSum: number; maxDuration: number | null }
    >();
    for (const r of eligible) {
      const key = `${r.tmdbId}:${r.mediaType}`;
      const title = r.title ?? `Watched ${r.tmdbId}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        g.playSum += r.playDuration ?? 0;
        if (r.duration != null && (g.maxDuration === null || r.duration > g.maxDuration)) g.maxDuration = r.duration;
        if (r.startedAt.getTime() > g.max) {
          g.max = r.startedAt.getTime();
          g.title = title;
        }
      } else {
        groups.set(key, {
          tmdbId: r.tmdbId as number,
          mediaType: r.mediaType as MT,
          count: 1,
          max: r.startedAt.getTime(),
          title,
          playSum: r.playDuration ?? 0,
          maxDuration: r.duration ?? null,
        });
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
        // Real groupBy returns only the requested aggregates; serving _sum
        // unconditionally is harmless here because the callers destructure by name.
        _sum: { playDuration: g.playSum },
        _max: { startedAt: new Date(g.max), title: g.title, duration: g.maxDuration },
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

// ── exclusion sources (collectKnownTitleKeys) ───────────────────────────────
shadowPrismaModel(prisma, "hiddenItem", {
  findMany: async (args: { where: { userId: string } }) =>
    hiddenItems
      .filter((r) => r.userId === args.where.userId)
      .map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })),
});
shadowPrismaModel(prisma, "mediaRequest", {
  // TWO query shapes share this delegate, discriminated by the OR clause:
  //   - collectKnownTitleKeys' exclusion read: requestedBy + (status in [...]
  //     OR permanentlyDeclined) — status-filtered;
  //   - selectSeeds' seed read: requestedBy alone, newest-first with a take —
  //     every status seeds.
  findMany: async (args: {
    where: {
      requestedBy: string;
      OR?: [{ status: { in: string[] } }, { permanentlyDeclined: boolean }];
    };
    orderBy?: { createdAt: "desc" };
    take?: number;
  }) => {
    let rows = mediaRequests.filter((r) => r.requestedBy === args.where.requestedBy);
    if (args.where.OR) {
      const or = args.where.OR;
      return rows
        .filter((r) => or[0].status.in.includes(r.status) || r.permanentlyDeclined === or[1].permanentlyDeclined)
        .map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }));
    }
    if (args.orderBy?.createdAt === "desc") {
      rows = [...rows].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    }
    if (args.take != null) rows = rows.slice(0, args.take);
    return rows.map((r) => ({
      tmdbId: r.tmdbId,
      mediaType: r.mediaType,
      title: r.title ?? `Requested ${r.tmdbId}`,
      createdAt: r.createdAt ?? new Date(T0),
    }));
  },
});
shadowPrismaModel(prisma, "deletionVote", {
  findMany: async (args: { where: { userId: string } }) =>
    deletionVotes
      .filter((r) => r.userId === args.where.userId)
      .map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })),
});
shadowPrismaModel(prisma, "blacklistItem", {
  findMany: async () => blacklistItems.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })),
});

// ── tmdbCache ───────────────────────────────────────────────────────────────
// findUnique always misses (suggestion-cache correctness is tmdb.ts's concern,
// not this file's) and writes are swallowed. findMany DOES serve, because it is
// what readCachedRatings reads: seeding `ratingRows` lets the quality prior be
// driven deterministically with zero network — MDBList/OMDB are only consulted
// for keys the cache misses, and here it never misses for a seeded title.
let ratingRows: { key: string; data: string; expiresAt: Date }[] = [];
// Warm list rows for the cold-start fallback (trending:week / movies:popular /
// tv:popular). Empty in most tests, so getTrending & co fetch through the
// scripted TMDB mock (which answers unknown paths with empty pages) and the
// fallback pool reads as UNAVAILABLE — the pre-fallback status quo.
let listCacheRows = new Map<string, unknown>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const seeded = listCacheRows.get(args.where.key);
    if (seeded === undefined) return null;
    return { key: args.where.key, data: JSON.stringify(seeded), cachedAt: new Date(T0), expiresAt: new Date(T0 + 7 * DAY_MS) };
  },
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
  hiddenItems = [];
  listCacheRows = new Map();
  mediaRequests = [];
  deletionVotes = [];
  blacklistItems = [];
  // blacklist.ts caches its resolved set module-globally for 30s — without this
  // a test's blacklist rows leak into every later test in the file.
  invalidateBlacklistCache();
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

test("cold start with the fallback pool UNAVAILABLE: empty and INCONCLUSIVE — yesterday's shelf survives the outage", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  // No list caches seeded and the scripted fetch answers trending/popular with
  // empty pages — the pool reads as unavailable. Before the fallback existed
  // this was a CONCLUSIVE empty; now conclusive=false, so a transient TMDB
  // outage can no longer wipe a cold-start user's previous (fallback) shelf.
  const result = await computeRecommendationsForUser("u1");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.conclusive, false);
  // No seed fan-out happened — only the fallback pool reads.
  assert.ok(!fetchCalls.some((pth) => /\/(similar|recommendations)$/.test(pth)), "no suggestion fetches without seeds");
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
  // score. Derivations (see the scoring block in recommendations.ts) — the
  // trailing ×0.9 is OBSCURITY_DAMP: these fixtures carry vote_count 0 and no
  // seeded ratings, so every candidate here is unrated-obscure:
  //   666 = 1.0 × recency(3d)   × count(1) × position(0) × 0.9 = 0.8922469…
  //   555 = 1.0 × recency(300d) × count(3) × position(0) × 0.9 = 0.5002498…
  const byId = new Map(result.candidates.map((c) => [c.tmdbId, c]));
  const near = (actual: number, expected: number, msg: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} (got ${actual}, want ~${expected})`);
  near(byId.get(666)!.score, 0.8922469637382048, "one contribution — a duplicated seed would double this");
  near(byId.get(555)!.score, 0.5002498269171234, "the older, more-watched seed contributes less");
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

  // 999 is first in all three lists, so it collects each seed's full weight —
  // decay-summed strongest-first (1.5 + 0.75×1.0871661 + 0.5625×0.9913855),
  // × 0.9 OBSCURITY_DAMP (unrated zero-vote fixtures). An unbounded sum would
  // read 3.2206964699785716 here — the difference IS the corroboration cap.
  near(byId.get(999)?.score, 2.585726046783016, "corroboration decay-sums every seed's contribution");
  assert.ok(byId.get(999)!.score < 3.2206964699785716, "strictly below the unbounded sum");

  // 888 sits SECOND in seed 20's list, so it is discounted by position(1) =
  // 1/(1 + 1/10). Without positional decay it would score seed 20's full
  // damped weight (0.9913855 × 0.9) — the assertion below distinguishes the two.
  near(byId.get(888)?.score, 0.811133603398368, "a later suggestion in the same list is worth less");
  assert.ok(
    byId.get(888)!.score < 0.9913855152646721 * 0.9,
    "position 1 must score strictly below the seed's full (damped) weight",
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
  // Decay-summed strongest-first: (1.5 + 0.75 × 0.9856975(history, 5d)) × 0.9
  // OBSCURITY_DAMP, both contributions at position 0.
  assert.ok(Math.abs(c.score - 2.015345856882388) < 1e-9, `score was ${c.score}`);
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
  assert.deepEqual(summary, { computedAt: null, watchHistorySeeds: 0, watchlistSeeds: 0, requestSeeds: 0 });
});

// ── exclusion widening: hidden / requests / votes / blacklist ────────────────

test("exclusion: a hidden title never enters the stored set, and hiding later vacates its slot at read time", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(111), movieItem(222)]);
  // Enum-cased mediaType, exactly as the DB stores it. The compute fold must
  // match candidateKey's enum casing — folding through getUserHiddenSet's
  // lowercase keyspace would silently never match (the casing trap).
  hiddenItems = [{ userId: "u1", tmdbId: 111, mediaType: "MOVIE", createdAt: daysAgo(0) }];

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.deepEqual(candidates.map((c) => c.tmdbId), [222], "the hidden title is excluded at COMPUTE");

  // Read-time drift: a row stored before the hide must vacate on the next render.
  userRecRows = [
    { id: "a", userId: "u1", tmdbId: 111, mediaType: "MOVIE", title: "Hidden Later", overview: null, posterPath: null, backdropPath: null, releaseDate: null, voteAverage: 5, score: 2, rank: 0, computedAt: daysAgo(0) },
    { id: "b", userId: "u1", tmdbId: 333, mediaType: "MOVIE", title: "Still Fine", overview: null, posterPath: null, backdropPath: null, releaseDate: null, voteAverage: 5, score: 1, rank: 1, computedAt: daysAgo(0) },
  ];
  const served = await getUserRecommendations("u1");
  assert.deepEqual(served.map((m) => m.id), [333], "the hidden row is dropped at READ, tier reassigned over survivors");
  assert.equal(served[0].matchTier, "top", "the survivor inherits the top band");
});

test("exclusion: open requests are out, AVAILABLE and re-requestable DECLINED stay in", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(1), movieItem(2), movieItem(3), movieItem(4), movieItem(5)]);
  mediaRequests = [
    { requestedBy: "u1", tmdbId: 1, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false },
    { requestedBy: "u1", tmdbId: 2, mediaType: "MOVIE", status: "APPROVED", permanentlyDeclined: false },
    // AVAILABLE deliberately stays: "On your server" filtering is a feature,
    // and the request lifecycle already ran its course.
    { requestedBy: "u1", tmdbId: 3, mediaType: "MOVIE", status: "AVAILABLE", permanentlyDeclined: false },
    // Plain DECLINED stays: it is re-requestable.
    { requestedBy: "u1", tmdbId: 4, mediaType: "MOVIE", status: "DECLINED", permanentlyDeclined: false },
    // permanentlyDeclined goes: the request POST 403s it forever.
    { requestedBy: "u1", tmdbId: 5, mediaType: "MOVIE", status: "DECLINED", permanentlyDeclined: true },
  ];

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.deepEqual(
    candidates.map((c) => c.tmdbId).sort((a, b) => a - b),
    [3, 4],
    "PENDING/APPROVED/permanentlyDeclined excluded; AVAILABLE and plain DECLINED kept",
  );
});

test("exclusion: another user's requests and votes do NOT poison this user's shelf", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(111)]);
  mediaRequests = [{ requestedBy: "someone-else", tmdbId: 111, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false }];
  deletionVotes = [{ userId: "someone-else", tmdbId: 111, mediaType: "MOVIE" }];

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.deepEqual(candidates.map((c) => c.tmdbId), [111], "exclusions are strictly per-user (blacklist aside)");
});

test("exclusion: own DeletionVotes and the admin blacklist are out, at compute AND at read", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(111), movieItem(222), movieItem(333)]);
  deletionVotes = [{ userId: "u1", tmdbId: 111, mediaType: "MOVIE" }];
  blacklistItems = [{ tmdbId: 222, mediaType: "MOVIE" }];

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.deepEqual(candidates.map((c) => c.tmdbId), [333]);

  // Read-time: rows stored before the vote/blacklisting vacate on render.
  userRecRows = [111, 222, 333].map((id, i) => ({
    id: `r${id}`, userId: "u1", tmdbId: id, mediaType: "MOVIE" as MT, title: `T${id}`,
    overview: null, posterPath: null, backdropPath: null, releaseDate: null,
    voteAverage: 5, score: 3 - i, rank: i, computedAt: daysAgo(0),
  }));
  const served = await getUserRecommendations("u1");
  assert.deepEqual(served.map((m) => m.id), [333]);
});

// ── store 300 / serve 200 ─────────────────────────────────────────────────────

test("store/serve split: the rated reserve is stored, at most 200 are served, and drift backfills from the reserve", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  authSessions = [{ userId: "u1", lastSeenAt: daysAgo(0) }];
  // 6 seeds × 40 distinct suggestions = 240 candidates — above the old 200 cap,
  // below the shortlist, so the stored count itself proves the raise.
  playHistoryRows = Array.from({ length: 6 }, (_, i) => ({
    mediaServerUserId: "msu1", tmdbId: 10 + i, mediaType: "MOVIE" as MT,
    watched: true, startedAt: daysAgo(1), title: `Seed ${i}`,
  }));
  for (let i = 0; i < 6; i++) {
    suggestionsFor.set(
      `movie:${10 + i}`,
      Array.from({ length: 40 }, (_, j) => movieItem(1000 + i * 40 + j)),
    );
  }

  await warmRecommendationsCache();
  const stored = userRecRows.filter((r) => r.userId === "u1");
  assert.equal(stored.length, 240, "everything scored+rated is stored (old cap was 200)");

  const served = await getUserRecommendations("u1");
  assert.equal(served.length, 200, "the serve cap holds regardless of reserve size");

  // Drift: hide a served row — the reserve backfills at the SAME render, so the
  // count stays 200 instead of shrinking until the next cron.
  hiddenItems = [{ userId: "u1", tmdbId: served[0].id, mediaType: "MOVIE", createdAt: daysAgo(0) }];
  const afterHide = await getUserRecommendations("u1");
  assert.equal(afterHide.length, 200, "a drift exclusion backfills from the stored reserve");
  assert.ok(!afterHide.some((m) => m.id === served[0].id), "the hidden row itself is gone");
});

// ── quality prior: the TMDB vote term is alive, and obscurity is damped ──────

test("quality: TMDB's own score now participates — a well-voted 8.5 outranks a 10-vote nobody", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  // Same seed. The obscure one sits FIRST (higher relevance via position);
  // only the TMDB vote term can flip the order — no external ratings seeded.
  // Before the voteCount fix both were q===null and the order never flipped.
  suggestionsFor.set("movie:10", [
    { ...movieItem(111), vote_average: 9.9, vote_count: 10 },   // 10 voters — noise
    { ...movieItem(222), vote_average: 8.5, vote_count: 5000 }, // real acclaim
  ]);

  const { candidates } = await computeRecommendationsForUser("u1");
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  // 222: TMDB term at 5000 votes → weight 0.75×5000/6000 = 0.625, so
  //      confidence 0.625/1.625 and q = 0.85:
  //      ×(1 + 0.9×(0.625/1.625)×0.20) = ×1.06923; at position 1 (1/1.1) → 0.9720×w
  // 111: q = null (10 < 50 votes) → OBSCURITY_DAMP ×0.9 at position 0 → 0.9×w
  assert.deepEqual(candidates.map((c) => c.tmdbId), [222, 111], "the vote term reorders; dead voteCount could not");
  const w = 0.9971174404154314; // seed weight at 1d, count 1
  assert.ok(Math.abs(byId.get(222)!.score - w * (1 / 1.1) * (1 + 0.9 * (0.625 / 1.625) * (0.85 - 0.65))) < 1e-9, `got ${byId.get(222)!.score}`);
  assert.ok(Math.abs(byId.get(111)!.score - w * 0.9) < 1e-9, `got ${byId.get(111)!.score}`);
});

test("quality: unrated-obscure is damped by exactly OBSCURITY_DAMP — a real audience never is", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [
    { ...movieItem(111), vote_count: 0 },                        // unrated-obscure → ×0.9
    { ...movieItem(222), vote_average: 7.0, vote_count: 5000 },  // unrated by providers, real audience → tmdb term
  ]);
  seedRatings(333, "movie", {}); // unrelated row; must not affect anything

  const { candidates } = await computeRecommendationsForUser("u1");
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  const w = 0.9971174404154314;
  assert.ok(Math.abs(byId.get(111)!.score - w * 0.9) < 1e-9, "obscure: damped by exactly OBSCURITY_DAMP");
  // 222: TMDB-only evidence 0.625 (5000 votes), q = 0.7 →
  //      ×(1 + 0.9×(0.625/1.625)×0.05) = ×1.01731, at position 1 → w × (1/1.1) × 1.01731
  assert.ok(Math.abs(byId.get(222)!.score - w * (1 / 1.1) * (1 + 0.9 * (0.625 / 1.625) * (0.7 - 0.65))) < 1e-9, "a real audience is never damped");
});

// ── watchlist ∩ history seed dedup ────────────────────────────────────────────

test("seed dedup: a watched title's stale watchlist entry does not double-seed", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  // The core loop: the user watchlisted title 10, then watched it twice. The
  // WatchlistItem row survives (watching never deletes it), so before the dedup
  // this title seeded TWICE — 1.0×recency×count(2) + 1.5×recency ≈ 2.5x any
  // single-source seed, silently tilting every engaged user's shelf toward
  // whatever they most recently got through their list.
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Both Pools" },
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(2), title: "Both Pools" },
  ];
  watchlistRows = [{ userId: "u1", tmdbId: 10, mediaType: "MOVIE", createdAt: daysAgo(0), title: "Both Pools" }];
  suggestionsFor.set("movie:10", [movieItem(999)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  // Exactly ONE contribution, from the HISTORY seed (the fulfilled list entry is
  // bookkeeping; history carries the real recency + count):
  // 1.0 × recency(1d) × count(2) × position(0) × 0.9 damp = 0.97844950…
  assert.ok(Math.abs(c.score - 1.0871661180448523 * 0.9) < 1e-9, `got ${c.score} — ~2.24 means it double-seeded`);
  assert.equal(c.seedCount, 1, "one seed, not two");
  assert.equal(c.reasonSource, "WATCH_HISTORY", "the history seed wins the dedup");
});

// ── request seeds ─────────────────────────────────────────────────────────────

test("request seeds: a serverless account's requests build the shelf, worded as requests", async () => {
  // Local/OIDC accounts with no linked media-server identity resolve to zero
  // server users — before this pool their shelves were built from nothing.
  users = [{ id: "u1", plexUserId: null, jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = []; // nothing links — the history arm short-circuits
  mediaRequests = [
    { requestedBy: "u1", tmdbId: 10, mediaType: "MOVIE", status: "AVAILABLE", permanentlyDeclined: false, title: "Fulfilled Want", createdAt: daysAgo(1) },
    // Even a DECLINED request seeds: the admin vetoed the fulfilment, not the taste.
    { requestedBy: "u1", tmdbId: 20, mediaType: "MOVIE", status: "DECLINED", permanentlyDeclined: false, title: "Vetoed Want", createdAt: daysAgo(3) },
  ];
  suggestionsFor.set("movie:10", [movieItem(111)]);
  suggestionsFor.set("movie:20", [movieItem(222)]);

  const { candidates, conclusive } = await computeRecommendationsForUser("u1");
  assert.equal(conclusive, true);
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  assert.equal(byId.get(111)!.reasonSource, "REQUEST");
  assert.equal(byId.get(111)!.reasonTitle, "Fulfilled Want");
  // Weight: 1.5 (request) × recency(1d) × count(1) × pos(0) × 0.9 damp.
  assert.ok(Math.abs(byId.get(111)!.score - 1.5 * 0.9971174404154314 * 0.9) < 1e-9, `got ${byId.get(111)!.score}`);
  assert.ok(byId.get(111)!.score > byId.get(222)!.score, "the fresher request weighs more");
});

test("request seeds: one title in all three pools seeds ONCE — history > watchlist > request", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Everywhere" },
  ];
  watchlistRows = [{ userId: "u1", tmdbId: 10, mediaType: "MOVIE", createdAt: daysAgo(0), title: "Everywhere" }];
  mediaRequests = [
    { requestedBy: "u1", tmdbId: 10, mediaType: "MOVIE", status: "AVAILABLE", permanentlyDeclined: false, title: "Everywhere", createdAt: daysAgo(0) },
    // And a watchlist∩request pair on a second title: watchlist keeps the slot.
    { requestedBy: "u1", tmdbId: 30, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false, title: "Listed+Requested", createdAt: daysAgo(0) },
  ];
  watchlistRows.push({ userId: "u1", tmdbId: 30, mediaType: "MOVIE", createdAt: daysAgo(2), title: "Listed+Requested" });
  suggestionsFor.set("movie:10", [movieItem(111)]);
  suggestionsFor.set("movie:30", [movieItem(222)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  // 111: exactly one contribution from the HISTORY seed.
  assert.equal(byId.get(111)!.seedCount, 1);
  assert.equal(byId.get(111)!.reasonSource, "WATCH_HISTORY");
  assert.ok(Math.abs(byId.get(111)!.score - 0.9971174404154314 * 0.9) < 1e-9, "a triple-pool title contributes once");
  // 222: exactly one contribution, and the WATCHLIST seed kept the slot.
  assert.equal(byId.get(222)!.seedCount, 1);
  assert.equal(byId.get(222)!.reasonSource, "WATCHLIST");
});

test("request seeds: per-arrInstance duplicate rows collapse to one seed, newest wins", async () => {
  users = [{ id: "u1", plexUserId: null, jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  // The same title requested on the default AND the 4K instance (the unique
  // key permits one row per instance). One seed, dated by the newer row.
  mediaRequests = [
    { requestedBy: "u1", tmdbId: 10, mediaType: "MOVIE", status: "APPROVED", permanentlyDeclined: false, title: "Both Instances", createdAt: daysAgo(10) },
    { requestedBy: "u1", tmdbId: 10, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false, title: "Both Instances", createdAt: daysAgo(2) },
  ];
  suggestionsFor.set("movie:10", [movieItem(111)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].seedCount, 1, "two instance rows are one want");
  // Weight dated by the NEWER row (2d), not the older (10d).
  assert.ok(Math.abs(candidates[0].score - 1.5 * (0.25 + 0.75 * 0.5 ** (2 / 180)) * 0.9) < 1e-9, `got ${candidates[0].score}`);
});

test("request seeds: the pool is capped at 24, newest first — a request-hoarder cannot monopolise the fan-out", async () => {
  users = [{ id: "u1", plexUserId: null, jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  // 30 distinct requested titles, strictly newer for lower ids. Only the 24
  // newest may seed: without the cap, every request a power user has ever
  // placed would fan out to TMDB on every cron run.
  mediaRequests = Array.from({ length: 30 }, (_, i) => ({
    requestedBy: "u1", tmdbId: 100 + i, mediaType: "MOVIE" as MT, status: "AVAILABLE" as const,
    permanentlyDeclined: false, title: `Req ${i}`, createdAt: daysAgo(i + 1),
  }));
  for (let i = 0; i < 30; i++) suggestionsFor.set(`movie:${100 + i}`, []);

  await computeRecommendationsForUser("u1");
  const requestFetches = new Set(
    fetchCalls.map((pth) => pth.match(/\/movie\/(1\d\d)\/(?:similar|recommendations)$/)?.[1]).filter(Boolean),
  );
  assert.equal(requestFetches.size, 24, "exactly the cap");
  assert.ok(requestFetches.has("100"), "the newest request seeds");
  assert.ok(requestFetches.has("123"), "the 24th-newest seeds");
  assert.ok(!requestFetches.has("124"), "the 25th-newest does not");
});

test("request seeds: an AVAILABLE request seeds WITHOUT self-excluding — the kept classes stay recommendable", async () => {
  users = [{ id: "u1", plexUserId: null, jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  // Title 10 is an AVAILABLE request (deliberately KEPT recommendable by the
  // exclusion policy) and now also a seed. The blanket seed-fold would have
  // silently re-excluded it the moment it seeded — reversing that decision.
  mediaRequests = [
    { requestedBy: "u1", tmdbId: 10, mediaType: "MOVIE", status: "AVAILABLE", permanentlyDeclined: false, title: "Kept", createdAt: daysAgo(1) },
    { requestedBy: "u1", tmdbId: 20, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false, title: "Open", createdAt: daysAgo(1) },
  ];
  // Seed 20's list contains BOTH request titles.
  suggestionsFor.set("movie:20", [movieItem(10), movieItem(30)]);
  suggestionsFor.set("movie:10", []);

  const { candidates } = await computeRecommendationsForUser("u1");
  const ids = candidates.map((c) => c.tmdbId).sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 30], "the AVAILABLE request title survives as a candidate; the PENDING one is excluded by status");
});

// ── cold-start fallback ───────────────────────────────────────────────────────

function seedFallbackPool(): void {
  const entry = (id: number, title: string, voteAverage: number, voteCount: number) => ({
    id, mediaType: "movie", title, overview: "o", posterPath: `/p${id}.jpg`, backdropPath: null,
    releaseDate: "2024-01-01", releaseYear: "2024", voteAverage, voteCount,
  });
  listCacheRows.set("trending:week", [entry(901, "Trend A", 7.2, 900), entry(902, "Trend B", 5.1, 800), entry(903, "Trend C", 8.1, 1200)]);
  listCacheRows.set("movies:popular", [entry(904, "Pop Movie", 6.9, 700)]);
  listCacheRows.set("tv:popular", []);
}

test("cold start with a warm pool: an honest TRENDING shelf — no reasons, no chips, score 0", async () => {
  users = [{ id: "u1", plexUserId: null, jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  seedFallbackPool();
  // Exclusions still apply to a seedless user: 904 is hidden.
  hiddenItems = [{ userId: "u1", tmdbId: 904, mediaType: "MOVIE", createdAt: daysAgo(0) }];

  const { candidates, conclusive } = await computeRecommendationsForUser("u1");
  assert.equal(conclusive, true, "a served pool is an authoritative answer");
  assert.deepEqual(
    candidates.map((c) => c.tmdbId).sort((a, b) => a - b),
    [901, 902, 903],
    "pool minus the hidden title",
  );
  for (const c of candidates) {
    assert.equal(c.reasonSource, "TRENDING");
    assert.equal(c.reasonTmdbId, null, "no fabricated reason");
    assert.equal(c.seedCount, 0);
    assert.equal(c.score, 0, "the engine has no relevance opinion on a fallback row");
  }
  // The order BLENDS trending position with quality — the prior refines the
  // trending order, it does not replace it. Transient score = poolPos × mult,
  // where mult = 1 + 0.9 × conf × (q − 0.65) over TMDB-only evidence
  // (weight 0.75×votes/(votes+1000), conf = weight/(weight+1)):
  //   901 (7.2 @ 900):  1.0000 × (1 + 0.9×0.2621×0.07)  = 1.0000 × 1.0165 = 1.0165
  //   902 (5.1 @ 800):  0.9524 × (1 − 0.9×0.2500×0.14)  = 0.9524 × 0.9685 = 0.9224
  //   903 (8.1 @ 1200): 0.9091 × (1 + 0.9×0.2903×0.16)  = 0.9091 × 1.0418 = 0.9471
  // So 902's genuinely bad rating drops it below 903 (the refinement), while
  // 903's mild edge does NOT overturn 901's two-slot trending lead. A pure
  // quality sort here would mean trending rank carries no signal at all.
  assert.deepEqual(candidates.map((c) => c.tmdbId), [901, 903, 902]);

  // Read path: labeled, tierless, reasonless.
  userRecRows = candidates.map((c, i) => ({
    id: `f${i}`, userId: "u1", tmdbId: c.tmdbId, mediaType: c.mediaType, title: c.title,
    overview: c.overview, posterPath: c.posterPath, backdropPath: c.backdropPath,
    releaseDate: c.releaseDate, voteAverage: c.voteAverage, score: c.score, rank: i,
    computedAt: daysAgo(0), reasonTmdbId: null, reasonTitle: null, reasonMediaType: null,
    reasonSource: "TRENDING" as never, seedCount: 0,
  }));
  const served = await getUserRecommendations("u1");
  assert.equal(served.length, 3);
  for (const m of served) {
    assert.equal((m as { fromTrendingFallback?: boolean }).fromTrendingFallback, true);
    assert.equal(m.matchTier, undefined, "a title picked for everyone never wears a match chip");
    assert.equal(m.recommendedBecause, undefined, "the all-four gate stays closed");
  }
});

test("thin shelf: fallback tops up BELOW every real pick, and tiers count only the real prefix", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  suggestionsFor.set("movie:10", [movieItem(111), movieItem(222)]);
  seedFallbackPool();

  const { candidates } = await computeRecommendationsForUser("u1");
  // 2 real + 4 fallback (whole pool fits inside the target).
  assert.equal(candidates.length, 6);
  assert.deepEqual(candidates.slice(0, 2).map((c) => c.reasonSource), ["WATCH_HISTORY", "WATCH_HISTORY"], "real picks first");
  assert.ok(candidates.slice(2).every((c) => c.reasonSource === "TRENDING"), "fallback strictly after");
  assert.deepEqual(candidates.map((c) => c.rank), [0, 1, 2, 3, 4, 5], "ranks are continuous across the boundary");

  // Read path: tiers over the 2 real rows only — ceil(2×0.1)=1 top — and never
  // on a TRENDING row even though the shelf is mostly fallback.
  userRecRows = candidates.map((c, i) => ({
    id: `m${i}`, userId: "u1", tmdbId: c.tmdbId, mediaType: c.mediaType, title: c.title,
    overview: c.overview, posterPath: c.posterPath, backdropPath: c.backdropPath,
    releaseDate: c.releaseDate, voteAverage: c.voteAverage, score: c.score, rank: i,
    computedAt: daysAgo(0), reasonTmdbId: c.reasonTmdbId, reasonTitle: c.reasonTitle,
    reasonMediaType: c.reasonMediaType, reasonSource: c.reasonSource as never, seedCount: c.seedCount,
  }));
  const served = await getUserRecommendations("u1");
  assert.deepEqual(
    served.map((m) => m.matchTier),
    ["top", undefined, undefined, undefined, undefined, undefined],
    "one real top-band pick; the fallback majority earns nothing",
  );
});

// ── corroboration cap ─────────────────────────────────────────────────────────

test("corroboration: amplification is decay-bounded — equal agreements can never sum unbounded", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  // Four equally-fresh seeds ALL pointing at candidate 999 first; a fifth seed
  // points only at candidate 111. Under the old unbounded sum 999 scored 4w;
  // decay-summed it scores w×(1 + 0.75 + 0.5625 + 0.421875) = 2.734375w — the
  // shape of the franchise-centroid fix: agreement still wins, but at a bounded
  // premium, so it can no longer bury every strong single-seed match under a
  // wall of small corroborations.
  playHistoryRows = Array.from({ length: 5 }, (_, i) => ({
    mediaServerUserId: "msu1", tmdbId: 10 + i, mediaType: "MOVIE" as MT,
    watched: true, startedAt: daysAgo(1), title: `Seed ${i}`,
  }));
  for (let i = 0; i < 4; i++) suggestionsFor.set(`movie:${10 + i}`, [movieItem(999)]);
  suggestionsFor.set("movie:14", [movieItem(111)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  const w = 0.9971174404154314; // each seed's weight at 1d, count 1
  assert.ok(Math.abs(byId.get(999)!.score - 2.453843701022351) < 1e-9, `got ${byId.get(999)!.score}`);
  assert.ok(byId.get(999)!.score < 4 * w * 0.9, "strictly below the unbounded sum");
  // The bound itself: even infinite equal corroborations converge to 4x one seed.
  assert.ok(byId.get(999)!.score < 4 * w * 0.9, "the 1/(1-0.75) = 4x ceiling holds");
  assert.ok(Math.abs(byId.get(111)!.score - w * 0.9) < 1e-9, "a single contribution is untouched by the decay");
  assert.equal(byId.get(999)!.seedCount, 4, "seedCount still reports every corroborator");
});

// ── abandoned-play dampening ──────────────────────────────────────────────────

test("abandoned: a settled low-completion bail dampens THAT title 0.3x — split-watch and fresh pauses do not", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    // The seed (watched, so it seeds and is excluded as a candidate).
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
    // 111: bailed at 15%, last touch 30d ago → DAMPENED.
    { mediaServerUserId: "msu1", tmdbId: 111, mediaType: "MOVIE", watched: false, startedAt: daysAgo(30), title: "Bailed", playDuration: 1080, duration: 7200 },
    // 222: two half-watches summing 90% — the weeknight split → NOT dampened.
    { mediaServerUserId: "msu1", tmdbId: 222, mediaType: "MOVIE", watched: false, startedAt: daysAgo(31), title: "Split A", playDuration: 3200, duration: 7200 },
    { mediaServerUserId: "msu1", tmdbId: 222, mediaType: "MOVIE", watched: false, startedAt: daysAgo(30), title: "Split B", playDuration: 3300, duration: 7200 },
    // 333: bailed at 10% but only 5 days ago — inside the settle window → NOT dampened.
    { mediaServerUserId: "msu1", tmdbId: 333, mediaType: "MOVIE", watched: false, startedAt: daysAgo(5), title: "Fresh Pause", playDuration: 720, duration: 7200 },
    // 444: no runtime recorded → ratio unjudgeable → NOT dampened.
    { mediaServerUserId: "msu1", tmdbId: 444, mediaType: "MOVIE", watched: false, startedAt: daysAgo(30), title: "No Runtime", playDuration: 700 },
  ];
  suggestionsFor.set("movie:10", [movieItem(111), movieItem(222), movieItem(333), movieItem(444)]);

  const { candidates } = await computeRecommendationsForUser("u1");
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  const w = 0.9971174404154314 * 0.9; // seed weight × obscurity damp, at each position
  const pos = (i: number) => 1 / (1 + i / 10);
  assert.ok(Math.abs(byId.get(111)!.score - w * pos(0) * 0.3) < 1e-9, "the settled bail is dampened by exactly ABANDON_DAMP");
  assert.ok(Math.abs(byId.get(222)!.score - w * pos(1)) < 1e-9, "cumulative 90% playtime reads as in-progress, not abandoned");
  assert.ok(Math.abs(byId.get(333)!.score - w * pos(2)) < 1e-9, "a 5-day-old pause has not settled into a verdict");
  assert.ok(Math.abs(byId.get(444)!.score - w * pos(3)) < 1e-9, "no runtime, no judgement");
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
  // contribution times only OBSCURITY_DAMP (unrated, vote_count 0) — a
  // monolingual viewer must not be silently scaled down by LANGUAGE.
  // 1.0 (type) × recency(1d) × count(1) × position(0) × 0.9
  //   = (0.25 + 0.75 × 0.5^(1/180)) × 0.9 = 0.8974056963738883
  assert.ok(Math.abs(candidates[0].score - 0.8974056963738883) < 1e-12, `score was ${candidates[0].score}`);
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

test("quality: IMDb vote depth decides — a million-vote 8.6 overtakes a 200-vote 9.2", async () => {
  users = [{ id: "u1", plexUserId: "p1", jellyfinUserId: null, deactivatedAt: null, purgedAt: null }];
  mediaServerUsers = [{ id: "msu1", source: "plex", sourceUserId: "p1", userId: "u1" }];
  playHistoryRows = [
    { mediaServerUserId: "msu1", tmdbId: 10, mediaType: "MOVIE", watched: true, startedAt: daysAgo(1), title: "Seed" },
  ];
  // The thin-stellar title sits FIRST (higher relevance via position); only
  // vote-depth weighting can flip the order. Both mutations this pin exists
  // for restore the old behavior and fail it: ignore the vote counts (every
  // IMDb rating at anchor weight) and 111's 9.2 wins on raw score; drop the
  // confidence scaling (multiplier at full strength regardless of evidence)
  // and it wins the same way. Under the pre-rework flat mean it also won —
  // this test fails on that code, which is how it earns its keep.
  suggestionsFor.set("movie:10", [
    { ...movieItem(111), original_language: "en" }, // stellar on paper, 200 voters
    { ...movieItem(222), original_language: "en" }, // a hair lower, a million voters
  ]);
  seedRatings(111, "movie", { imdbRating: "9.2", imdbVotes: "200" });
  // OMDB delivers counts comma-formatted — this exercises that parse in situ.
  seedRatings(222, "movie", { imdbRating: "8.6", imdbVotes: "1,000,000" });

  const { candidates } = await computeRecommendationsForUser("u1");
  assert.deepEqual(
    candidates.map((c) => c.tmdbId),
    [222, 111],
    "the deep-voted verdict overtakes the thin one despite starting lower on relevance",
  );

  // Exact scores: IMDb is the only participating source (movieItem carries no
  // vote_count, so the TMDB term abstains), weight 3×votes/(votes+5000),
  // confidence ev/(ev+1), multiplier 1 + 0.9×conf×(q−0.65).
  const byId = new Map(candidates.map((c) => [c.tmdbId, c]));
  const w = 0.9971174404154314; // seed weight at 1d, count 1
  const conf = (ev: number) => ev / (ev + 1);
  const thin = 3 * (200 / 5200);
  const deep = 3 * (1_000_000 / 1_005_000);
  assert.ok(
    Math.abs(byId.get(111)!.score - w * (1 + 0.9 * conf(thin) * (0.92 - 0.65))) < 1e-9,
    `got ${byId.get(111)!.score}`,
  );
  assert.ok(
    Math.abs(byId.get(222)!.score - w * (1 / 1.1) * (1 + 0.9 * conf(deep) * (0.86 - 0.65))) < 1e-9,
    `got ${byId.get(222)!.score}`,
  );
});

test("qualityScoreOf: IMDb anchors by vote depth; comma counts parse; the excluded aggregates stay out", () => {
  const base = {
    id: 1, mediaType: "movie" as const, title: "", overview: "",
    posterPath: null, backdropPath: null, releaseDate: null, releaseYear: null,
    voteAverage: 0,
  };

  // Deep-voted IMDb outweighs a contradicting thin source ~6:1 — the blend
  // lands IMDb-side, not at the flat mean (0.6) the old prior produced.
  const deep = 3 * (1_000_000 / 1_005_000);
  const v = qualityScoreOf({ ...base, imdbRating: "8.0", imdbVotes: "1000000", traktRating: "40" })!;
  assert.ok(Math.abs(v.quality - (0.8 * deep + 0.4 * 0.5) / (deep + 0.5)) < 1e-9, `got ${v.quality}`);
  assert.ok(v.quality > 0.72, "IMDb-led: a lone Trakt 40% cannot drag an anchored 8.0 toward it");
  assert.ok(Math.abs(v.evidence - (deep + 0.5)) < 1e-9, `got ${v.evidence}`);

  // OMDB's comma-formatted count and MDBList's bare form are the same number.
  assert.deepEqual(
    qualityScoreOf({ ...base, imdbRating: "8.0", imdbVotes: "1,000,000" }),
    qualityScoreOf({ ...base, imdbRating: "8.0", imdbVotes: "1000000" }),
  );

  // A rating with no usable count is trusted at the flat unknown-votes weight
  // — never anchor strength on unproven depth, never dropped either.
  for (const votes of [undefined, null, "N/A", "0"]) {
    const u = qualityScoreOf({ ...base, imdbRating: "8.0", imdbVotes: votes })!;
    assert.equal(u.evidence, 1, `votes=${String(votes)} must read as unknown`);
    assert.equal(u.quality, 0.8);
  }

  // The three newly-admitted community sources participate on their own scales.
  const lb = qualityScoreOf({ ...base, letterboxdRating: "4.6" })!;
  assert.ok(Math.abs(lb.quality - 4.6 / 5) < 1e-12);
  assert.equal(lb.evidence, 0.75);
  const mal = qualityScoreOf({ ...base, malRating: "8.4" })!;
  assert.ok(Math.abs(mal.quality - 0.84) < 1e-12);
  assert.equal(mal.evidence, 0.75);
  const aud = qualityScoreOf({ ...base, rtAudienceScore: "88%" })!;
  assert.ok(Math.abs(aud.quality - 0.88) < 1e-12);
  assert.equal(aud.evidence, 0.5);

  // Deliberately excluded: mdblistScore aggregates the same per-source ratings
  // already blended (admitting it double-counts them), and Ebert is a single
  // critic on a 4-star scale. Alone they must produce NO verdict.
  assert.equal(qualityScoreOf({ ...base, mdblistScore: "95", rogerEbertRating: "4" }), null);
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
