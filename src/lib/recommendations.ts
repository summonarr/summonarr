import "server-only";
import { prisma } from "@/lib/prisma";
import type { MediaType } from "@/generated/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getMovieSuggestions, getTVSuggestions } from "@/lib/tmdb";
import { resolveLinkedMediaServerUserIds } from "@/lib/my-watch-history";
import { settleLimit } from "@/lib/concurrency";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";

// "For You" recommendation engine. Seeds are drawn from a user's own watched
// PlayHistory + WatchlistItem, fanned out through TMDB's existing similar/
// recommendations wrappers, scored, and cached per-user in UserRecommendation
// by the warm-recommendations cron. getUserRecommendations is the only
// live-request-path read — it never calls TMDB.

const MAX_WATCH_HISTORY_SEEDS = 20;
const MAX_WATCHLIST_SEEDS = 8;
const SEED_RECENCY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
// Sized for the dedicated /for-you page (a full grid), not just the 20-item
// home rail. Costs no extra TMDB calls: the 15-seed fan-out already produces
// a 100-250 candidate pool — this only keeps more of what was computed.
const MAX_STORED_RECOMMENDATIONS_PER_USER = 100;
const SEED_CONCURRENCY = 5;
const USER_CONCURRENCY = 5;
const ACTIVE_USER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
}

interface Seed {
  tmdbId: number;
  mediaType: MediaType;
  weight: number;
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

// Linearly interpolates 1.0 (index 0, most recent/most-watched) down to 0.5
// (the oldest seed in its own list) rather than an arbitrary calendar half-life.
function weightSeeds(rows: { tmdbId: number; mediaType: MediaType }[], typeWeight: number): Seed[] {
  const n = rows.length;
  return rows.map((r, i) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    weight: typeWeight * (n <= 1 ? 1 : 1 - 0.5 * (i / (n - 1))),
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
      _max: { startedAt: true },
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
      select: { tmdbId: true, mediaType: true },
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
    .map((r) => ({ tmdbId: r.tmdbId as number, mediaType: r.mediaType as MediaType }));

  return [...weightSeeds(historySeeds, WATCH_HISTORY_SEED_WEIGHT), ...weightSeeds(watchlistRows, WATCHLIST_SEED_WEIGHT)];
}

// Wider than "the chosen seeds" on purpose: an already-known title elsewhere on
// a long watchlist (past the top-5 seeded) or an old watch (past the top-10
// seeded) must not leak back in as a "new" recommendation.
async function buildExclusionSet(userId: string, linkedServerUserIds: string[], seeds: Seed[]): Promise<Set<string>> {
  const [watchlistRows, watchedRows] = await Promise.all([
    prisma.watchlistItem.findMany({ where: { userId }, select: { tmdbId: true, mediaType: true } }),
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : prisma.playHistory.findMany({
          where: {
            mediaServerUserId: { in: linkedServerUserIds },
            watched: true,
            tmdbId: { not: null },
            mediaType: { not: null },
          },
          select: { tmdbId: true, mediaType: true },
          distinct: ["tmdbId", "mediaType"],
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

  const suggestionResults = await settleLimit(seeds, SEED_CONCURRENCY, (seed) =>
    seed.mediaType === "MOVIE" ? getMovieSuggestions(seed.tmdbId) : getTVSuggestions(seed.tmdbId),
  );

  // Counted BEFORE exclusion: a user who has already watched every suggestion is a
  // conclusive empty (clear their stale rows), whereas zero items arriving at all is
  // the outage case. Filtering first would collapse the two back together.
  let rawSuggestions = 0;

  const scored = new Map<string, RecommendationCandidate>();
  seeds.forEach((seed, i) => {
    const result = suggestionResults[i];
    if (result.status !== "fulfilled") return;
    for (const item of result.value) {
      rawSuggestions++;
      const mediaType = toDbMediaType(item.mediaType);
      const key = candidateKey(item.id, mediaType);
      if (excluded.has(key)) continue;
      const existing = scored.get(key);
      if (existing) {
        existing.score += seed.weight;
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
        score: seed.weight,
        rank: 0,
      });
    }
  });

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, MAX_STORED_RECOMMENDATIONS_PER_USER);
  ranked.forEach((c, i) => {
    c.rank = i;
  });
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
  };
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
      : prisma.playHistory.findMany({
          where: {
            mediaServerUserId: { in: linkedServerUserIds },
            watched: true,
            tmdbId: { not: null },
            mediaType: { not: null },
          },
          select: { tmdbId: true, mediaType: true },
          distinct: ["tmdbId", "mediaType"],
        }),
  ]);

  const currentlyKnown = new Set<string>();
  for (const r of watchlistRows) currentlyKnown.add(candidateKey(r.tmdbId, r.mediaType));
  for (const r of watchedRows) {
    if (r.tmdbId != null && r.mediaType != null) currentlyKnown.add(candidateKey(r.tmdbId, r.mediaType));
  }

  return cached.filter((row) => !currentlyKnown.has(candidateKey(row.tmdbId, row.mediaType))).map(rowToTmdbMedia);
}
