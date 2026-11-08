// A TMDB image path as a caller may SEND one (a "not interested" tap carries the
// card's poster): "/abc123.jpg" — one path segment, a file name and an image
// extension. Anything else (a query string, a "..", a space, a full URL) would
// be concatenated into image.tmdb.org URLs later, so it is stored as null.
// Zero imports: the routes and the unit suite load it as is.

const MAX_IMAGE_PATH_LENGTH = 500;
const TMDB_IMAGE_PATH = /^\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|svg)$/i;

/** The value when it is a well-formed TMDB image path, else null. */
export function tmdbImagePathOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_IMAGE_PATH_LENGTH) return null;
  return TMDB_IMAGE_PATH.test(value) ? value : null;
}
