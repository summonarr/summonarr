// Links the media components build from a TMDB title. Pure, client-safe
// (tests/availability-rules.test.mts covers these too).
import type { TmdbMedia } from "@/lib/tmdb-types";

/** The title's detail page: /movie/<id> or /tv/<id>. */
export function mediaDetailPath(media: Pick<TmdbMedia, "id" | "mediaType">): string {
  return media.mediaType === "movie" ? `/movie/${media.id}` : `/tv/${media.id}`;
}

/**
 * The YouTube watch page for a TMDB video key. The key is upstream data: built
 * with URLSearchParams it stays one query value, so a `&` or `#` in it can't
 * add a parameter or cut the URL short. The host is fixed, so no other gate is
 * needed.
 */
export function youtubeTrailerUrl(key: string): string {
  return `https://www.youtube.com/watch?${new URLSearchParams({ v: key })}`;
}
