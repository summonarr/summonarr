// Whether the sync orchestrator must hold a Plex instance back instead of
// replacing its library rows with this run's answer (sync/route.ts, Plex arm).
//
// Every write of a Plex instance is a scoped FULL REPLACE: whatever this run
// fetched becomes the instance's whole library, and the Plex episode cache is
// rewritten from it. An answer that is short with no error therefore wipes
// rows and demotes AVAILABLE requests, then repeats every hour. Held back, the
// instance is treated like a failed fetch: its rows stay and the run is
// reported degraded. A library that really was emptied is cleared by the
// admin's Resync on the Plex source (/api/sync/plex, deliberately unguarded).
//
// Three short answers are held:
//   - "empty": no movies AND no shows at all (a selection matching no section,
//     a Plex that is still starting).
//   - "empty-type": a type with stored rows comes back with zero titles while a
//     selected (or, with no selection, any) section of it still exists (mid-scan).
//   - "missing-section": a type with stored rows comes back with zero titles,
//     no selected section of it exists, and a selected library key is not on
//     the server any more. Recreating a library in Plex gives it a NEW key, so
//     the saved selection silently stops matching it.
// Every rule is scoped to a type that LOST everything it had: a stale key alone
// never holds. That matters because the library pickers keep a saved key they
// no longer list (they render only live sections), so a hold keyed on the stale
// key would never clear. Instead it clears itself: ticking the recreated
// library covers the type again, and for a library deleted on purpose the
// admin's Resync empties the type's rows, after which nothing is held.
// Deselecting a library on purpose leaves no missing key, so it is not held.
//
// Each rule holds only an instance that HAS stored rows of what would be lost:
// a new or genuinely empty server is never blocked. Pure and zero-import.

export interface PlexSectionRef {
  key: string;
  type: "movie" | "show";
}

export type PlexHoldReason =
  | { kind: "empty" }
  | { kind: "missing-section"; keys: string[]; mediaType: "MOVIE" | "TV" }
  | { kind: "empty-type"; mediaType: "MOVIE" | "TV" };

export interface PlexHoldInput {
  /** The instance's saved library selection; undefined or empty = every section. */
  selectedKeys: ReadonlySet<string> | undefined;
  /** The server's current movie/show sections. */
  sections: readonly PlexSectionRef[];
  movieCount: number;
  tvCount: number;
  /** Library rows the instance already holds, per type. */
  heldMovieRows: number;
  heldTvRows: number;
}

/** True when the caller must read the held-row counts before deciding: only a type that came back empty can be held. */
export function plexHoldNeedsCounts(input: Pick<PlexHoldInput, "movieCount" | "tvCount">): boolean {
  return input.movieCount === 0 || input.tvCount === 0;
}

export function plexHoldReason(input: PlexHoldInput): PlexHoldReason | null {
  const { selectedKeys, sections, movieCount, tvCount, heldMovieRows, heldTvRows } = input;
  const heldAny = heldMovieRows > 0 || heldTvRows > 0;
  if (!heldAny) return null;

  if (movieCount === 0 && tvCount === 0) return { kind: "empty" };

  const missing = missingSelectedKeys(selectedKeys, sections);
  const covers = (type: PlexSectionRef["type"]) =>
    sections.some((s) => s.type === type && (!selectedKeys?.size || selectedKeys.has(s.key)));
  const lost: Array<{ mediaType: "MOVIE" | "TV"; type: PlexSectionRef["type"] }> = [];
  if (movieCount === 0 && heldMovieRows > 0) lost.push({ mediaType: "MOVIE", type: "movie" });
  if (tvCount === 0 && heldTvRows > 0) lost.push({ mediaType: "TV", type: "show" });
  for (const l of lost) {
    if (covers(l.type)) return { kind: "empty-type", mediaType: l.mediaType };
    if (missing.length > 0) return { kind: "missing-section", keys: missing, mediaType: l.mediaType };
  }
  return null;
}

function missingSelectedKeys(selectedKeys: ReadonlySet<string> | undefined, sections: readonly PlexSectionRef[]): string[] {
  if (!selectedKeys?.size) return [];
  const live = new Set(sections.map((s) => s.key));
  return [...selectedKeys].filter((k) => !live.has(k)).sort();
}
