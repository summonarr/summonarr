// The "Popular on server" titles as cards: one page of the most-played ranking
// (play-history-popular.ts) resolved to TMDB media plus its play counts. Used by
// GET /api/popular and the web /popular page (which also numbers each slot's
// rank from the unfiltered page).
import { prisma } from "./prisma";
import { settleLimit } from "./concurrency";
import { getMovieDetails, getTVDetails } from "./tmdb";
import type { TmdbMedia } from "./tmdb-types";
import type { PopularResult } from "./play-history-popular";
import type { TmdbMediaCore } from "@/generated/prisma";

export type PopularItem = PopularResult["items"][number];

export type PopularTitle = TmdbMedia & {
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

/** The `?mediaType=` filter: one type, or both when absent. */
export type PopularMediaFilter = "movies" | "tv" | undefined;

/**
 * The filter a query value names, or null when it names none. "movies" and "tv"
 * are the documented values; "movie" — what every other route calls the type —
 * means movies too. Absent or empty means both.
 */
export function parsePopularMediaFilter(raw: string | null): PopularMediaFilter | null {
  if (raw === null || raw === "") return undefined;
  if (raw === "movies" || raw === "movie") return "movies";
  if (raw === "tv") return "tv";
  return null;
}

// A ranked title with a fresh TmdbMediaCore row is built from it, with no TMDB call.
function fromCore(
  item: PopularItem,
  type: "movie" | "tv",
  core: TmdbMediaCore,
): TmdbMedia {
  return {
    id: item.tmdbId,
    mediaType: type,
    title: core.title,
    overview: "",
    posterPath: core.posterPath ?? null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: core.releaseYear ?? "",
    voteAverage: core.voteAverage,
    certification: core.certification ?? undefined,
  };
}

/**
 * One type's ranked items as cards. A title with a fresh TmdbMediaCore row is
 * built from it; the rest are read from TMDB, at most `concurrency` at a time
 * (guardrail 31 — on a cold cache that is every title). A title whose TMDB read
 * fails is dropped from the page (logged, so a most-played title that vanished
 * is diagnosable) — the page can then hold fewer than the reported totals.
 */
export async function resolvePopularTitles(
  items: readonly PopularItem[],
  type: "movie" | "tv",
  concurrency: number,
): Promise<PopularTitle[]> {
  if (items.length === 0) return [];
  // One query for the whole page: every item shares mediaType and the
  // freshness check, so a single `tmdbId IN (...)` list is all that's needed.
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      tmdbId: { in: items.map((i) => i.tmdbId) },
      mediaType: type === "movie" ? "MOVIE" : "TV",
      expiresAt: { gt: new Date() },
    },
  });
  const coreMap = new Map(coreRows.map((r) => [r.tmdbId, r]));

  const results = await settleLimit(items, concurrency, async (item): Promise<PopularTitle> => {
    const core = coreMap.get(item.tmdbId);
    const details = core
      ? fromCore(item, type, core)
      : type === "movie"
        ? await getMovieDetails(item.tmdbId)
        : await getTVDetails(item.tmdbId);
    return {
      ...details,
      plays: item.plays,
      allTimePlays: item.allTimePlays,
      viewers: item.viewers,
      episodes: item.episodes,
      totalHours: item.totalHours,
    };
  });
  const out: PopularTitle[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(r.value);
    else console.error(`[popular] ${type} detail resolve failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
  }
  return out;
}
