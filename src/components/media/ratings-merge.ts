import type { TmdbMedia } from "@/lib/tmdb-types";
import type { RatingsPayload } from "@/lib/client/ratings-batcher";

export type RatingFields = { [K in keyof RatingsPayload]?: string | null };

// The rating props RatingsBar takes from a title: the lazily fetched ratings
// (requestRatings) win, and a field they don't carry (null) falls back to what
// the list item arrived with. One copy for MediaCard and DiscoverHero, so a new
// rating source is added in one place.
export function mergeRatings(
  media: Pick<TmdbMedia, keyof RatingsPayload>,
  live: RatingsPayload | null,
): RatingFields {
  return {
    imdbRating: live?.imdbRating ?? media.imdbRating,
    imdbId: live?.imdbId ?? media.imdbId,
    imdbVotes: live?.imdbVotes ?? media.imdbVotes,
    rottenTomatoes: live?.rottenTomatoes ?? media.rottenTomatoes,
    rtAudienceScore: live?.rtAudienceScore ?? media.rtAudienceScore,
    metacritic: live?.metacritic ?? media.metacritic,
    traktRating: live?.traktRating ?? media.traktRating,
    letterboxdRating: live?.letterboxdRating ?? media.letterboxdRating,
    mdblistScore: live?.mdblistScore ?? media.mdblistScore,
    malRating: live?.malRating ?? media.malRating,
    rogerEbertRating: live?.rogerEbertRating ?? media.rogerEbertRating,
  };
}
