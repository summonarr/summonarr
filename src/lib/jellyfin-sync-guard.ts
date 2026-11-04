// Whether the sync orchestrator must hold a Jellyfin instance back instead of
// replacing its library rows with this run's answer (sync/route.ts, Jellyfin arm).
//
// The Jellyfin twin of plex-sync-guard.ts, and for the same reason. Every
// orchestrator write of a Jellyfin instance is a scoped FULL REPLACE: whatever
// this run fetched becomes the instance's whole library, and the shared episode
// cache is rewritten from it. A clean 200 with no items (a selected library
// that was recreated under a new id, a server that is mid-scan or just started)
// therefore wipes rows and demotes AVAILABLE requests, then repeats every hour.
// Held back, the instance is treated like a failed fetch: its rows stay and the
// run is reported degraded. A library that really was emptied is cleared by the
// admin's Resync on the Jellyfin source (/api/sync/jellyfin with `full`,
// deliberately unguarded, exactly like the Plex Resync).
//
// Three short answers are held, each only for an instance that HAS stored rows
// of what would be lost (a new or genuinely empty server is never blocked):
//   - "empty": no movies AND no shows at all.
//   - "empty-type": a type with stored rows comes back with zero titles while a
//     selected (or, with no selection, any) library of it still exists.
//   - "missing-library": a type with stored rows comes back with zero titles,
//     no selected library of it exists, and a selected library id is not on the
//     server any more (recreating a library gives it a NEW id).
// A stale id alone never holds: the library pickers keep a saved id they no
// longer list, so such a hold could never clear. Deselecting a library on
// purpose leaves no missing id, so it is not held either.
//
// Pure and zero-import.

export interface JellyfinFolderRef {
  id: string;
  collectionType: "movies" | "tvshows" | string;
}

export type JellyfinHoldReason =
  | { kind: "empty" }
  | { kind: "missing-library"; ids: string[]; mediaType: "MOVIE" | "TV" }
  | { kind: "empty-type"; mediaType: "MOVIE" | "TV" };

export interface JellyfinHoldInput {
  /** The instance's saved library selection; undefined or empty = every library. */
  selectedIds: ReadonlySet<string> | undefined;
  /** The server's current movie/show libraries. */
  folders: readonly JellyfinFolderRef[];
  movieCount: number;
  tvCount: number;
  /** Library rows the instance already holds, per type. */
  heldMovieRows: number;
  heldTvRows: number;
}

/** True when the caller must read the held-row counts (and the server's libraries) before deciding: only a type that came back empty can be held. */
export function jellyfinHoldNeedsCounts(input: Pick<JellyfinHoldInput, "movieCount" | "tvCount">): boolean {
  return input.movieCount === 0 || input.tvCount === 0;
}

export function jellyfinHoldReason(input: JellyfinHoldInput): JellyfinHoldReason | null {
  const { selectedIds, folders, movieCount, tvCount, heldMovieRows, heldTvRows } = input;
  if (heldMovieRows <= 0 && heldTvRows <= 0) return null;

  if (movieCount === 0 && tvCount === 0) return { kind: "empty" };

  const missing = missingSelectedIds(selectedIds, folders);
  const covers = (collectionType: string) =>
    folders.some((f) => f.collectionType === collectionType && (!selectedIds?.size || selectedIds.has(f.id)));
  const lost: Array<{ mediaType: "MOVIE" | "TV"; collectionType: string }> = [];
  if (movieCount === 0 && heldMovieRows > 0) lost.push({ mediaType: "MOVIE", collectionType: "movies" });
  if (tvCount === 0 && heldTvRows > 0) lost.push({ mediaType: "TV", collectionType: "tvshows" });
  for (const l of lost) {
    if (covers(l.collectionType)) return { kind: "empty-type", mediaType: l.mediaType };
    if (missing.length > 0) return { kind: "missing-library", ids: missing, mediaType: l.mediaType };
  }
  return null;
}

function missingSelectedIds(selectedIds: ReadonlySet<string> | undefined, folders: readonly JellyfinFolderRef[]): string[] {
  if (!selectedIds?.size) return [];
  const live = new Set(folders.map((f) => f.id));
  return [...selectedIds].filter((id) => !live.has(id)).sort();
}
