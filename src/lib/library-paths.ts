// The library path rules the Plex↔Jellyfin bad-match join, the admin library
// page and the strip-prefix preview all apply. Pure and zero-import: the
// settings form (a client component) imports it too, so its preview strips a
// prefix exactly as the server does.

/** A path relative to its inferred mount, or the path itself when the mount doesn't prefix it. */
export function stripMountPoint(filePath: string | null, mountPoint: string): string | null {
  if (!filePath) return null;
  const normalised = filePath.replace(/\\/g, "/");
  if (mountPoint && normalised.startsWith(mountPoint)) return normalised.slice(mountPoint.length);
  return normalised;
}

/**
 * A relative path with the admin's strip prefix (the *PathStripPrefix settings)
 * peeled off. The prefix may be typed with or without its trailing "/"; a path
 * the prefix doesn't start is returned unchanged.
 */
export function stripRelPrefix(rel: string, stripPrefix: string): string {
  if (!stripPrefix) return rel;
  const p = stripPrefix.endsWith("/") ? stripPrefix : stripPrefix + "/";
  return rel.startsWith(p) ? rel.slice(p.length) : rel;
}

/** The directory a file path sits in ("" for a bare name). */
export function folderOf(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
}

/** The join key: a movie keys on its whole relative path, a show on its series folder (segment 0). */
export function toMatchKey(rel: string, mediaType: "MOVIE" | "TV"): string {
  if (mediaType === "TV") return rel.split("/")[0];
  return rel;
}

// A season folder by its whole name — "Season 01", "Series 2", "S01",
// "Specials" — never a name that merely starts with one of those words: a show
// called "Series of Unfortunate Events" stored with flat episodes is the show
// folder, and reading it as a season moved the inferred mount a level too high.
const SEASON_FOLDER_RE = /^(?:(?:season|series)[\s._-]*\d+(?:\D.*)?|specials|s\d+)$/i;

export function isSeasonFolderName(name: string): boolean {
  return SEASON_FOLDER_RE.test(name);
}

// Video containers a library item's file can be. A known list, not "any short
// suffix": a dotted folder name ("Agents of S.H.I.E.L.D", "M.A.S.H") is a
// folder, and a 1–5 character suffix test read it as a file.
const MEDIA_FILE_RE = /\.(?:mkv|mk3d|mp4|m4v|avi|mov|qt|wmv|asf|flv|f4v|webm|ogm|ogv|mpg|mpeg|mpe|m2v|ts|m2t|m2ts|mts|vob|iso|img|divx|xvid|3gp|3g2|rm|rmvb|wtv|dvr-ms|strm)$/i;

/** Whether a path segment names a video file (by extension), as opposed to a folder. */
export function isMediaFileName(name: string): boolean {
  return MEDIA_FILE_RE.test(name);
}

/**
 * The show folder a TV path belongs to, kept with every segment above it: a
 * Plex row's episode file and its season folder are dropped, a Jellyfin series
 * folder is kept whole. "tv/Show A/Season 1/e1.mkv" → "tv/Show A".
 */
export function tvShowFolderPath(rel: string): string {
  const segs = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segs.length > 1 && isMediaFileName(segs[segs.length - 1])) segs.pop();
  if (segs.length > 1 && isSeasonFolderName(segs[segs.length - 1])) segs.pop();
  return segs.join("/");
}
