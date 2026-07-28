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

const MAX_WATCH_HISTORY_SEEDS = 10;
const MAX_WATCHLIST_SEEDS = 5;
const MAX_STORED_RECOMMENDATIONS_PER_USER = 40;
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
  const [historyRows, watchlistRows] = await Promise.all([
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : prisma.playHistory.groupBy({
          by: ["tmdbId", "mediaType"],
          where: {
            mediaServerUserId: { in: linkedServerUserIds },
            watched: true,
            tmdbId: { not: null },
            mediaType: { not: null },
          },
          _count: { tmdbId: true },
          _max: { startedAt: true },
          orderBy: [{ _count: { tmdbId: "desc" } }, { _max: { startedAt: "desc" } }],
          take: MAX_WATCH_HISTORY_SEEDS,
        }),
    prisma.watchlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: MAX_WATCHLIST_SEEDS,
      select: { tmdbId: true, mediaType: true },
    }),
  ]);

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

// Pure(ish) compute — no writes. Returns [] for a cold-start user (zero
// eligible seeds) without making any TMDB calls.
export async function computeRecommendationsForUser(userId: string): Promise<RecommendationCandidate[]> {
  const linkedServerUserIds = await resolveLinkedMediaServerUserIds(userId);
  const seeds = await selectSeeds(userId, linkedServerUserIds);
  if (seeds.length === 0) return [];

  const excluded = await buildExclusionSet(userId, linkedServerUserIds, seeds);

  const suggestionResults = await settleLimit(seeds, SEED_CONCURRENCY, (seed) =>
    seed.mediaType === "MOVIE" ? getMovieSuggestions(seed.tmdbId) : getTVSuggestions(seed.tmdbId),
  );

  const scored = new Map<string, RecommendationCandidate>();
  seeds.forEach((seed, i) => {
    const result = suggestionResults[i];
    if (result.status !== "fulfilled") return;
    for (const item of result.value) {
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
  return ranked;
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
  usersFailed: number;
  candidatesWritten: number;
}> {
  const userIds = await getActiveUserIds();

  // One transaction PER USER, not one spanning all users — bounds the blast
  // radius of a single user's failure and keeps any one lock/timeout small.
  const results = await settleLimit(userIds, USER_CONCURRENCY, async (userId) => {
    const candidates = await computeRecommendationsForUser(userId);
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
  let usersFailed = 0;
  let candidatesWritten = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      usersUpdated++;
      candidatesWritten += r.value;
    } else {
      usersFailed++;
      console.error("[recommendations] per-user compute/write failed:", r.reason);
    }
  }
  return { usersEligible: userIds.length, usersUpdated, usersFailed, candidatesWritten };
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
