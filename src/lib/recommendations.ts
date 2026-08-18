import "server-only";
import { prisma } from "@/lib/prisma";
import type { MediaType, RecommendationSeed } from "@/generated/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getMovieSuggestions, getTVSuggestions, SUGGESTIONS_CACHE_MAX } from "@/lib/tmdb";
import { resolveLinkedMediaServerUserIds } from "@/lib/my-watch-history";
import { settleLimit } from "@/lib/concurrency";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";

// "For You" recommendation engine. Seeds are drawn from a user's own watched
// PlayHistory + WatchlistItem, fanned out through TMDB's existing similar/
// recommendations wrappers, scored, and cached per-user in UserRecommendation
// by the warm-recommendations cron. getUserRecommendations is the only
// live-request-path read — it never calls TMDB.

// 3x the original 20/8. Deeper history is the point: at 20 slots the engine only
// ever saw a sliver of a real library, so most of what someone had watched could
// never influence anything. The cost is bounded by the shared 7-day TMDB
// suggestion cache (tmdb.ts) — seeds repeat across runs and across users, so a
// warm cycle issues far fewer requests than the cold worst case of 2 per seed.
const MAX_WATCH_HISTORY_SEEDS = 60;
const MAX_WATCHLIST_SEEDS = 24;
const SEED_RECENCY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
// Sized for the dedicated /for-you page (a full grid), not just the 20-item
// home rail. Costs no extra TMDB calls: the 28-seed fan-out already produces a
// large candidate pool — this only keeps more of what was computed. Raised
// 100 -> 200 alongside SUGGESTIONS_CACHE_MAX (tmdb.ts), which widened each
// seed's contribution from 18 to 40 titles WITHOUT another request: /similar
// and /recommendations each return 20 and both were already being fetched, so
// the extra depth came out of what used to be discarded.
const MAX_STORED_RECOMMENDATIONS_PER_USER = 200;
const SEED_CONCURRENCY = 5;
const USER_CONCURRENCY = 5;
const ACTIVE_USER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── Scoring ────────────────────────────────────────────────────────────────
// A candidate's score is the sum, over every seed that surfaced it, of
//
//     seedTypeWeight × recencyFactor(seed) × countFactor(seed) × positionFactor(item)
//
// Each factor answers a different question, and the previous single-factor model
// (position in the SEED LIST, nothing else) got two of them wrong.

// How fast a seed's influence fades with age, and how far it can fade. The floor
// is what makes deep history worth seeding at all: a pure half-life sends a
// three-year-old watch to ~0.004, so the extra slots above would buy nothing.
// At FLOOR 0.25 / half-life 180d a seed is worth 1.0 today, 0.63 at six months,
// 0.42 at a year, and never less than a quarter of a fresh one.
//
// This replaces weighting by POSITION IN THE SEED LIST, which was ordered
// count-first — so a movie watched once last week ranked below a show binged
// years ago, and its recommendations were weighted as though it mattered less.
const SEED_RECENCY_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
const SEED_RECENCY_FLOOR = 0.25;

// Watching something repeatedly is a real signal, but PlayHistory writes one row
// PER EPISODE, so raw counts put a 62-episode series two orders of magnitude
// above any film. log10 at a 0.3 coefficient compresses that to 1.0x for a movie
// vs ~1.5x for the whole of Breaking Bad — present, but unable to outrun the 4x
// span of recency above. Weighting by raw count is the bug this file has always
// been designed against (see selectSeeds); this is the smallest dose that keeps
// the signal without reopening it.
const SEED_COUNT_WEIGHT = 0.3;

// Position of a suggestion WITHIN its seed's list. TMDB returns its behavioural
// /recommendations first and the cruder /similar after (see getMovieSuggestions),
// so this favours the former without either endpoint being named here.
//
// It exists because the list is now 40 long (SUGGESTIONS_CACHE_MAX, widened from
// 18). Scoring every entry equally meant the 40th — a weak keyword match — voted
// as loudly as the 1st, which diluted the ranking exactly as the pool grew.
// 1/(1 + i/10) is 1.0 at the head, 0.53 by the 10th and 0.20 at the 40th: sharp
// where it matters, with a long tail that still lets broad corroboration promote
// a title many seeds agree on.
const SUGGESTION_POSITION_K = 10;

// Watchlist is an unambiguous single-person signal (added through the Summonarr
// UI by whoever is signed in); watch-history via resolveLinkedMediaServerUserIds
// can represent a shared Plex/Jellyfin household profile. Watchlist gets a
// higher per-seed weight but fewer slots, so history still dominates volume.
const WATCHLIST_SEED_WEIGHT = 1.5;
const WATCH_HISTORY_SEED_WEIGHT = 1.0;

export interface RecommendationCandidate {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number;
  score: number;
  rank: number;
  // The single strongest seed that surfaced this candidate, and how many seeds
  // surfaced it in total. `score` says HOW MUCH the engine likes a title;
  // these say WHY, which is what the /for-you page shows the user.
  reasonTmdbId: number;
  reasonTitle: string;
  reasonMediaType: MediaType;
  reasonSource: RecommendationSeed;
  seedCount: number;
}

interface Seed {
  tmdbId: number;
  mediaType: MediaType;
  weight: number;
  // Carried purely so a candidate can name its reason. The title is denormalized
  // off the seed row (PlayHistory.title / WatchlistItem.title) rather than looked
  // up later — a title watched years ago may have no TMDB cache row left.
  title: string;
  source: RecommendationSeed;
}

function candidateKey(tmdbId: number, mediaType: MediaType): string {
  return `${tmdbId}:${mediaType}`;
}

function toDbMediaType(m: "movie" | "tv"): MediaType {
  return m === "movie" ? "MOVIE" : "TV";
}

function toTmdbMediaType(m: MediaType): "movie" | "tv" {
  return m === "MOVIE" ? "movie" : "tv";
}

// How much a seed still counts, given when it was last watched (or added to the
// watchlist). Bounded below by SEED_RECENCY_FLOOR so old-but-real taste keeps a
// vote. An absent timestamp is treated as maximally old rather than dropped —
// the seed is genuine, we just can't date it.
function recencyFactor(at: Date | null | undefined, now: number): number {
  if (!at) return SEED_RECENCY_FLOOR;
  // Clamp negatives: a clock skew that puts a watch in the future must not
  // amplify a seed past a fresh one.
  const ageMs = Math.max(0, now - at.getTime());
  const decayed = Math.pow(0.5, ageMs / SEED_RECENCY_HALF_LIFE_MS);
  return SEED_RECENCY_FLOOR + (1 - SEED_RECENCY_FLOOR) * decayed;
}

// Repeat-watch signal, log-compressed — see SEED_COUNT_WEIGHT.
function countFactor(count: number): number {
  return 1 + SEED_COUNT_WEIGHT * Math.log10(Math.max(1, count));
}

// Weight of a single suggestion by its rank within its seed's list.
function positionFactor(index: number): number {
  return 1 / (1 + index / SUGGESTION_POSITION_K);
}

// Seeds are weighted ABSOLUTELY (by their own age and repeat count), not by
// their position in the selected list. Two consequences worth knowing:
//   - a seed's weight no longer depends on how many other seeds there are, so
//     raising MAX_WATCH_HISTORY_SEEDS cannot dilute the ones already there;
//   - the top seed is no longer pinned to exactly 1.0 — a viewer whose most
//     recent watch was months ago has uniformly lower weights. Scores are only
//     ever compared WITHIN one user, so that is immaterial to the ranking.
function weightSeeds(
  rows: { tmdbId: number; mediaType: MediaType; title: string; lastAt?: Date | null; count?: number }[],
  typeWeight: number,
  source: RecommendationSeed,
  now: number,
): Seed[] {
  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    source,
    weight: typeWeight * recencyFactor(r.lastAt, now) * countFactor(r.count ?? 1),
  }));
}

async function selectSeeds(userId: string, linkedServerUserIds: string[]): Promise<Seed[]> {
  // History seeds track CURRENT taste, so the grouping is windowed to the last
  // 180 days. Unwindowed, "most rows" is "most episodes ever": one PlayHistory
  // row lands per episode watched, so a years-old 200-episode binge permanently
  // owns the top seed slots while movies (one row each) never seed at all.
  //
  // Windowed rows come FIRST, then the remaining slots TOP UP from all-time
  // history. A busy user with only 2-3 recent watches used to seed from just
  // those (all-time fired only at exactly zero windowed rows), so their pool
  // was thin; old favorites now fill the tail slots — at the taper's lower
  // weights, so they can never outrank recent taste. A fully dormant household
  // (zero windowed rows) degenerates to pure all-time seeding, the same
  // fallback as before: seeds.length === 0 is a CONCLUSIVE empty to the
  // caller, which would clear an established shelf. The exclusion set
  // (buildExclusionSet) stays all-time on purpose: an old watch must still
  // never come back as a "new" recommendation.
  const groupHistory = (windowed: boolean, take: number) =>
    prisma.playHistory.groupBy({
      by: ["tmdbId", "mediaType"],
      where: {
        mediaServerUserId: { in: linkedServerUserIds },
        watched: true,
        tmdbId: { not: null },
        mediaType: { not: null },
        ...(windowed ? { startedAt: { gte: new Date(Date.now() - SEED_RECENCY_WINDOW_MS) } } : {}),
      },
      _count: { tmdbId: true },
      // title rides along in the aggregate so naming the seed ("Because you
      // watched X") costs no second query. PlayHistory.title is the show/movie
      // title — episodeTitle is a separate column — so it is already the right
      // label for a TV seed. _max picks one arbitrary row's title within the
      // group; every row in a (tmdbId, mediaType) group is the same title
      // except for upstream renames, where the newest spelling is fine.
      _max: { startedAt: true, title: true },
      orderBy: [{ _count: { tmdbId: "desc" } }, { _max: { startedAt: "desc" } }],
      take,
    });

  const [windowedRows, watchlistRows] = await Promise.all([
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : groupHistory(true, MAX_WATCH_HISTORY_SEEDS),
    prisma.watchlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: MAX_WATCHLIST_SEEDS,
      select: { tmdbId: true, mediaType: true, title: true, createdAt: true },
    }),
  ]);

  let historyRows = windowedRows;
  if (linkedServerUserIds.length > 0 && windowedRows.length < MAX_WATCH_HISTORY_SEEDS) {
    // Overfetch by the windowed count: every windowed title also sits in the
    // all-time grouping, so the worst case needs that many extras to still
    // fill the remaining slots after dedup.
    const seen = new Set(windowedRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const allTime = await groupHistory(false, MAX_WATCH_HISTORY_SEEDS + seen.size);
    historyRows = [
      ...windowedRows,
      ...allTime.filter((r) => !seen.has(`${r.tmdbId}:${r.mediaType}`)),
    ].slice(0, MAX_WATCH_HISTORY_SEEDS);
  }

  // groupBy's TS types don't narrow tmdbId/mediaType past their nullable
  // column types even though the where clause already excludes nulls.
  const historySeeds = historyRows
    .filter((r) => r.tmdbId != null && r.mediaType != null)
    .map((r) => ({
      tmdbId: r.tmdbId as number,
      mediaType: r.mediaType as MediaType,
      // PlayHistory.title is NOT NULL, but _max over an empty group is typed
      // nullable; fall back to the id so a reason is never a blank string.
      title: r._max.title ?? `TMDB #${r.tmdbId}`,
      // Both were already being fetched to ORDER the groups; they now also
      // weight them, which is the whole point of the rework.
      lastAt: r._max.startedAt,
      count: r._count.tmdbId,
    }));

  // One `now` for the whole selection: reading the clock per seed would let a
  // slow query change the weights partway down the list.
  const now = Date.now();
  return [
    ...weightSeeds(historySeeds, WATCH_HISTORY_SEED_WEIGHT, "WATCH_HISTORY", now),
    // A watchlist entry has no play count; its recency is when it was added.
    ...weightSeeds(
      watchlistRows.map((r) => ({ ...r, lastAt: r.createdAt })),
      WATCHLIST_SEED_WEIGHT,
      "WATCHLIST",
      now,
    ),
  ];
}

// Wider than "the chosen seeds" on purpose: an already-known title elsewhere on
// a long watchlist (past the top-5 seeded) or an old watch (past the top-10
// seeded) must not leak back in as a "new" recommendation.
async function buildExclusionSet(userId: string, linkedServerUserIds: string[], seeds: Seed[]): Promise<Set<string>> {
  const [watchlistRows, watchedRows] = await Promise.all([
    prisma.watchlistItem.findMany({ where: { userId }, select: { tmdbId: true, mediaType: true } }),
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : // groupBy, not findMany + distinct. Prisma applies `distinct` CLIENT-side
        // — verified by capturing the emitted SQL, which is byte-identical with
        // and without it — so every watch row crossed the wire and was deduped
        // in Node. Only the distinct pairs are ever used, and a heavy viewer has
        // thousands of rows collapsing to a few hundred titles. groupBy compiles
        // to a real GROUP BY, so Postgres does the dedup. The result shape is
        // the same {tmdbId, mediaType}, so the consumers below are unchanged.
        prisma.playHistory.groupBy({
          by: ["tmdbId", "mediaType"],
          where: {
            mediaServerUserId: { in: linkedServerUserIds },
            watched: true,
            tmdbId: { not: null },
            mediaType: { not: null },
          },
        }),
  ]);

  const excluded = new Set<string>();
  for (const s of seeds) excluded.add(candidateKey(s.tmdbId, s.mediaType));
  for (const r of watchlistRows) excluded.add(candidateKey(r.tmdbId, r.mediaType));
  for (const r of watchedRows) {
    if (r.tmdbId != null && r.mediaType != null) excluded.add(candidateKey(r.tmdbId, r.mediaType));
  }
  return excluded;
}

export interface RecommendationComputation {
  candidates: RecommendationCandidate[];
  // Whether the answer above can be trusted as "this is what the user should see".
  //
  // getMovieSuggestions/getTVSuggestions swallow their own upstream failures and
  // return [] — deliberately, see the don't-cache-an-empty guard in tmdb.ts — so at
  // this layer a TMDB outage is indistinguishable from "this title genuinely has no
  // suggestions". A caller that REPLACES stored state must not treat an inconclusive
  // empty as authoritative, or one bad cron run wipes every user's recommendations
  // and reports success.
  //
  // True when there was nothing to compute from (no seeds — a legitimately empty
  // answer that SHOULD clear stale rows), or when at least one seed came back with
  // at least one raw suggestion (upstream is answering, so an empty result after
  // exclusion is real). False only when seeds existed and not one yielded a single
  // item — overwhelmingly an outage, and cheap to be wrong about: the caller just
  // keeps yesterday's recommendations for one more cycle.
  conclusive: boolean;
}

// Pure(ish) compute — no writes. Returns no candidates for a cold-start user (zero
// eligible seeds) without making any TMDB calls. Read `conclusive` before acting on
// an empty `candidates`: the two empties mean different things.
export async function computeRecommendationsForUser(userId: string): Promise<RecommendationComputation> {
  const linkedServerUserIds = await resolveLinkedMediaServerUserIds(userId);
  const seeds = await selectSeeds(userId, linkedServerUserIds);
  if (seeds.length === 0) return { candidates: [], conclusive: true };

  const excluded = await buildExclusionSet(userId, linkedServerUserIds, seeds);

  // SUGGESTIONS_CACHE_MAX (not the 18-item rail default) — the tail of each
  // seed's list is exactly what lets the ranked set reach 200. Same cache row
  // and same request count as the rail; only the slice differs.
  const suggestionResults = await settleLimit(seeds, SEED_CONCURRENCY, (seed) =>
    seed.mediaType === "MOVIE"
      ? getMovieSuggestions(seed.tmdbId, SUGGESTIONS_CACHE_MAX)
      : getTVSuggestions(seed.tmdbId, SUGGESTIONS_CACHE_MAX),
  );

  // Counted BEFORE exclusion: a user who has already watched every suggestion is a
  // conclusive empty (clear their stale rows), whereas zero items arriving at all is
  // the outage case. Filtering first would collapse the two back together.
  let rawSuggestions = 0;

  // reasonWeight is bookkeeping for picking the strongest seed; it is dropped
  // before the candidates are returned (there is no column for it).
  const scored = new Map<string, RecommendationCandidate & { reasonWeight: number }>();
  seeds.forEach((seed, i) => {
    const result = suggestionResults[i];
    if (result.status !== "fulfilled") return;
    // position is the index within THIS seed's suggestion list, so it has to be
    // counted over the raw list — not over the survivors of the exclusion filter
    // below, which would silently promote every item sitting behind a title the
    // user had already watched.
    let position = -1;
    for (const item of result.value) {
      position++;
      rawSuggestions++;
      const mediaType = toDbMediaType(item.mediaType);
      const key = candidateKey(item.id, mediaType);
      if (excluded.has(key)) continue;
      const contribution = seed.weight * positionFactor(position);
      const existing = scored.get(key);
      if (existing) {
        existing.score += contribution;
        existing.seedCount++;
        // Keep the STRONGEST contribution as the reason, not the first one
        // encountered — seeds are no longer visited in weight order at all, so
        // first-wins would name an essentially arbitrary title. Comparing
        // CONTRIBUTION rather than raw seed weight is deliberate: a slightly
        // weaker seed that ranks this title first is a better explanation than a
        // strong seed that had it 40th. Ties keep the incumbent.
        if (contribution > existing.reasonWeight) {
          existing.reasonWeight = contribution;
          existing.reasonTmdbId = seed.tmdbId;
          existing.reasonTitle = seed.title;
          existing.reasonMediaType = seed.mediaType;
          existing.reasonSource = seed.source;
        }
        continue;
      }
      scored.set(key, {
        tmdbId: item.id,
        mediaType,
        title: item.title,
        overview: item.overview || null,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        releaseDate: item.releaseDate,
        voteAverage: item.voteAverage,
        score: contribution,
        rank: 0,
        reasonTmdbId: seed.tmdbId,
        reasonTitle: seed.title,
        reasonMediaType: seed.mediaType,
        reasonSource: seed.source,
        reasonWeight: contribution,
        seedCount: 1,
      });
    }
  });

  const ranked = [...scored.values()]
    // Scores now come from a continuous product of factors, so exact ties are
    // rare — but when they happen, break by community rating rather than by
    // Map insertion order, which is an artefact of seed iteration.
    .sort((a, b) => b.score - a.score || b.voteAverage - a.voteAverage)
    .slice(0, MAX_STORED_RECOMMENDATIONS_PER_USER)
    .map(({ reasonWeight: _reasonWeight, ...c }, i): RecommendationCandidate => ({ ...c, rank: i }));
  return { candidates: ranked, conclusive: rawSuggestions > 0 };
}

// Who the cron bothers computing for. authSessions.lastSeenAt (not a fresh
// lastActiveAt column, and not PlayHistory recency — a rich-but-dormant
// account shouldn't burn TMDB calls every cycle) tracks genuine recent app use.
async function getActiveUserIds(): Promise<string[]> {
  const cutoff = new Date(Date.now() - ACTIVE_USER_WINDOW_MS);
  const rows = await prisma.user.findMany({
    where: {
      deactivatedAt: null,
      purgedAt: null,
      authSessions: { some: { lastSeenAt: { gte: cutoff } } },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function warmRecommendationsCache(): Promise<{
  usersEligible: number;
  usersUpdated: number;
  usersSkipped: number;
  usersFailed: number;
  candidatesWritten: number;
}> {
  const userIds = await getActiveUserIds();

  // One transaction PER USER, not one spanning all users — bounds the blast
  // radius of a single user's failure and keeps any one lock/timeout small.
  const results = await settleLimit(userIds, USER_CONCURRENCY, async (userId) => {
    const { candidates, conclusive } = await computeRecommendationsForUser(userId);
    // NEVER let an inconclusive run replace good rows with nothing. The write below
    // is delete-then-insert, so an empty `candidates` produced by a TMDB outage
    // would clear the user's shelf — and because the compute RESOLVES rather than
    // throws, it would be counted as a successful update. Keep the stale set and
    // recompute next cycle.
    if (!conclusive) return null;
    await prisma.$transaction(
      async (tx) => {
        await tx.userRecommendation.deleteMany({ where: { userId } });
        if (candidates.length > 0) {
          await batchCreateMany(
            tx.userRecommendation,
            candidates.map((c) => ({ ...c, userId })),
          );
        }
      },
      { timeout: BATCH_TX_TIMEOUT },
    );
    return candidates.length;
  });

  let usersUpdated = 0;
  let usersSkipped = 0;
  let usersFailed = 0;
  let candidatesWritten = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === null) {
        usersSkipped++;
        continue;
      }
      usersUpdated++;
      candidatesWritten += r.value;
    } else {
      usersFailed++;
      console.error("[recommendations] per-user compute/write failed:", r.reason);
    }
  }
  if (usersSkipped > 0) {
    console.warn(
      `[recommendations] kept the existing recommendations for ${usersSkipped}/${userIds.length} user(s) — ` +
        "they had seeds but no suggestions came back at all (most likely a TMDB outage). Nothing was cleared.",
    );
  }
  return { usersEligible: userIds.length, usersUpdated, usersSkipped, usersFailed, candidatesWritten };
}

function rowToTmdbMedia(row: {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number;
  reasonTmdbId: number | null;
  reasonTitle: string | null;
  reasonMediaType: MediaType | null;
  reasonSource: RecommendationSeed | null;
  seedCount: number;
}): TmdbMedia {
  return {
    id: row.tmdbId,
    mediaType: toTmdbMediaType(row.mediaType),
    title: row.title,
    overview: row.overview ?? "",
    posterPath: row.posterPath,
    backdropPath: row.backdropPath,
    releaseDate: row.releaseDate,
    releaseYear: row.releaseDate?.slice(0, 4) ?? null,
    voteAverage: row.voteAverage,
    // All four reason columns are written together or not at all, so one
    // null-check covers the whole object. Rows predating the columns simply
    // carry no reason and the UI omits the line — they heal on the next cron run.
    ...(row.reasonTmdbId != null && row.reasonTitle != null && row.reasonMediaType != null && row.reasonSource != null
      ? {
          recommendedBecause: {
            tmdbId: row.reasonTmdbId,
            title: row.reasonTitle,
            mediaType: toTmdbMediaType(row.reasonMediaType),
            source: row.reasonSource,
            seedCount: row.seedCount,
          },
        }
      : {}),
  };
}

export interface RecommendationSummary {
  // When THIS user's set was last rebuilt. Read per-user rather than from the
  // global `cron:lastRun:recommendations` Setting because the cron deliberately
  // skips users (inconclusive TMDB run, or dormant and out of the active
  // cohort) — the global timestamp would claim a refresh they never got.
  computedAt: Date | null;
  // How many DISTINCT seed titles actually produced a visible pick, split by
  // pool. Counted off the stored reasons rather than by re-running selectSeeds:
  // it is one small per-user query instead of three, and it answers the more
  // honest question — not "what did we feed the engine" but "what did the
  // engine actually get something out of".
  watchHistorySeeds: number;
  watchlistSeeds: number;
}

export async function getRecommendationSummary(userId: string): Promise<RecommendationSummary> {
  const [agg, seedRows] = await Promise.all([
    prisma.userRecommendation.aggregate({ where: { userId }, _max: { computedAt: true } }),
    prisma.userRecommendation.groupBy({
      by: ["reasonSource", "reasonTmdbId"],
      where: { userId, reasonSource: { not: null }, reasonTmdbId: { not: null } },
    }),
  ]);

  let watchHistorySeeds = 0;
  let watchlistSeeds = 0;
  for (const row of seedRows) {
    if (row.reasonSource === "WATCHLIST") watchlistSeeds++;
    else if (row.reasonSource === "WATCH_HISTORY") watchHistorySeeds++;
  }

  return { computedAt: agg._max.computedAt, watchHistorySeeds, watchlistSeeds };
}

// Read path — called directly by home/route.ts and page.tsx. Re-filters the
// cache against CURRENT WatchlistItem + watched-PlayHistory state so drift
// between a 6-12h cron cycle and the page load never surfaces something the
// user has since watchlisted or watched. HiddenItem needs no handling here —
// attachAllAvailability already removes it downstream for every rail.
export async function getUserRecommendations(userId: string): Promise<TmdbMedia[]> {
  const cached = await prisma.userRecommendation.findMany({
    where: { userId },
    orderBy: { rank: "asc" },
  });
  if (cached.length === 0) return [];

  const linkedServerUserIds = await resolveLinkedMediaServerUserIds(userId);
  const [watchlistRows, watchedRows] = await Promise.all([
    prisma.watchlistItem.findMany({ where: { userId }, select: { tmdbId: true, mediaType: true } }),
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : // groupBy, not findMany + distinct. Prisma applies `distinct` CLIENT-side
        // — verified by capturing the emitted SQL, which is byte-identical with
        // and without it — so every watch row crossed the wire and was deduped
        // in Node. Only the distinct pairs are ever used, and a heavy viewer has
        // thousands of rows collapsing to a few hundred titles. groupBy compiles
        // to a real GROUP BY, so Postgres does the dedup. The result shape is
        // the same {tmdbId, mediaType}, so the consumers below are unchanged.
        prisma.playHistory.groupBy({
          by: ["tmdbId", "mediaType"],
          where: {
            mediaServerUserId: { in: linkedServerUserIds },
            watched: true,
            tmdbId: { not: null },
            mediaType: { not: null },
          },
        }),
  ]);

  const currentlyKnown = new Set<string>();
  for (const r of watchlistRows) currentlyKnown.add(candidateKey(r.tmdbId, r.mediaType));
  for (const r of watchedRows) {
    if (r.tmdbId != null && r.mediaType != null) currentlyKnown.add(candidateKey(r.tmdbId, r.mediaType));
  }

  return cached.filter((row) => !currentlyKnown.has(candidateKey(row.tmdbId, row.mediaType))).map(rowToTmdbMedia);
}
