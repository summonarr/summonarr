// The detail-page link for a play-history title. PlayHistory.mediaType is
// nullable, and a Jellyfin item that is neither a Movie nor an Episode can carry
// a TMDB id with no type: guessing "movie" for it would link an unrelated film
// that happens to share the id. Only a known type gets a link; the caller
// renders the title as plain text otherwise. Pure, client-safe.
export function mediaHref(tmdbId: number | null | undefined, mediaType: string | null | undefined): string | null {
  if (tmdbId == null) return null;
  if (mediaType === "MOVIE") return `/movie/${tmdbId}`;
  if (mediaType === "TV") return `/tv/${tmdbId}`;
  return null;
}
