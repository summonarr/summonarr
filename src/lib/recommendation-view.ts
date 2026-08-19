import type { TmdbMedia } from "./tmdb-types";

// How the /for-you grid is narrowed and ordered. Pure and dependency-free so the
// web page and the native mirror (/api/recommendations) share ONE implementation
// — the two drifting is exactly the class of bug the "audit every consumer of a
// response shape" rule exists to prevent.
//
// Every one of these runs AFTER attachAllAvailability, because `availability`
// reads post-enrichment fields. That is also why the page enriches its whole
// stored set rather than just the visible page.

export type RecommendationAvailability = "available" | "missing" | undefined;
export type RecommendationType = "movie" | "tv" | undefined;
export type RecommendationSort = "match" | "newest" | "rating";

export const DEFAULT_RECOMMENDATION_SORT: RecommendationSort = "match";

export function parseAvailability(raw: string | null | undefined): RecommendationAvailability {
  return raw === "available" || raw === "missing" ? raw : undefined;
}

export function parseRecommendationType(raw: string | null | undefined): RecommendationType {
  return raw === "movie" || raw === "tv" ? raw : undefined;
}

export function parseRecommendationSort(raw: string | null | undefined): RecommendationSort {
  return raw === "newest" || raw === "rating" ? raw : DEFAULT_RECOMMENDATION_SORT;
}

export interface RecommendationView {
  availability?: RecommendationAvailability;
  type?: RecommendationType;
  sort?: RecommendationSort;
}

// What "Highest rated" ranks on: IMDb's rating when the ratings attach
// produced one — by far the deepest vote base of the sources the app carries,
// so its figure is the sturdiest — falling back to TMDB's own average (the
// same 0-10 scale) for titles IMDb data hasn't covered. Exported so any other
// surface ordering "by rating" ranks on the SAME definition.
export function ratingSortValue(m: TmdbMedia): number {
  const imdb = parseFloat(m.imdbRating ?? "");
  return Number.isFinite(imdb) ? imdb : m.voteAverage;
}

// Sorts are applied to a COPY: the caller's array is the enriched set that other
// code (counts, the untouched "match" order) may still be reading.
export function applyRecommendationView(items: TmdbMedia[], view: RecommendationView): TmdbMedia[] {
  const { availability, type, sort = DEFAULT_RECOMMENDATION_SORT } = view;

  let out = items;
  if (type) out = out.filter((m) => m.mediaType === type);
  if (availability === "available") {
    out = out.filter((m) => m.plexAvailable || m.jellyfinAvailable);
  } else if (availability === "missing") {
    out = out.filter((m) => !(m.plexAvailable || m.jellyfinAvailable));
  }

  // "match" is the engine's own ranking, which the input already carries (the
  // read path orders by `rank`), so it is deliberately a no-op rather than a
  // re-derivation — `score` is not on TmdbMedia and re-sorting by anything else
  // here would silently redefine what "best match" means.
  if (sort === "match") return out === items ? [...out] : out;

  // Array.prototype.sort is stable (spec-guaranteed since ES2019), so ties fall
  // back to rank order — a "newest" run of same-year titles stays best-first.
  const sorted = out === items ? [...out] : out;
  if (sort === "newest") {
    // TMDB release dates are ISO "YYYY-MM-DD", so a plain lexicographic compare
    // is a date compare. Deliberately NOT localeCompare — its collation is
    // locale-dependent, and this must order identically on every runtime.
    // Undated titles fall to the end: "" is the lowest comparand descending.
    sorted.sort((a, b) => {
      const av = a.releaseDate ?? "";
      const bv = b.releaseDate ?? "";
      return av === bv ? 0 : av > bv ? -1 : 1;
    });
  } else if (sort === "rating") {
    sorted.sort((a, b) => ratingSortValue(b) - ratingSortValue(a));
  }
  return sorted;
}
