// Library diff — the pure rules for ordering the Plex/Jellyfin difference lists
// and for saying WHY a title sits on one server only (no I/O; the page feeds it).
//
// Why it exists:
// - The "only on X" lists used to be sorted by a bare localeCompare with no
//   tie-break, so rows of one title on two servers (or two identical titles)
//   swapped places between renders, and the rows that need an admin's attention
//   (a wrong match) were buried among plain misses.
// - On a mirrored setup (both servers read the same files) a title that is on
//   one server only is never random: the other server either holds the SAME
//   file under a different TMDB id, lists the folder with no TMDB id at all, or
//   does not have the file. Telling those apart is the source of the diff.

export type DiffSourceKind =
  /** The other server holds this very file/folder, matched to a different TMDB id. */
  | "idMismatch"
  /** The other server lists this folder but the sync dropped it: no TMDB id. */
  | "unmatched"
  /** The other server has nothing at this path: not scanned, not shared, or not synced. */
  | "notOnOther"
  /** The item has no file path, so it cannot be compared with the other server. */
  | "noPath";

export interface DiffSource {
  kind: DiffSourceKind;
  /** idMismatch only: what the other server matched the same file to. */
  otherTmdbId?: number;
  otherTitle?: string | null;
  otherServerInstance?: string;
}

export interface OtherSidePathEntry {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  serverInstance: string;
  title: string | null;
}

/**
 * Why `item` is on one server only.
 * - matchKey: the item's relative-path join key (null/"" when it has no usable path)
 * - otherByPath: the OTHER server's rows keyed by the same join key
 * - otherUnmatchedFolders: folder keys the other server lists WITHOUT a TMDB id
 */
export function diffSourceFor(
  matchKey: string | null,
  folder: string | null,
  mediaType: "MOVIE" | "TV",
  otherByPath: ReadonlyMap<string, OtherSidePathEntry>,
  otherUnmatchedFolders: ReadonlySet<string>,
): DiffSource {
  if (!matchKey) return { kind: "noPath" };
  const hit = otherByPath.get(matchKey);
  if (hit) {
    return {
      kind: "idMismatch",
      otherTmdbId: hit.tmdbId,
      otherTitle: hit.title,
      otherServerInstance: hit.serverInstance,
    };
  }
  if (folder && otherUnmatchedFolders.has(`${mediaType}:${folder}`)) return { kind: "unmatched" };
  return { kind: "notOnOther" };
}

export interface DiffSortable {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  serverInstance: string;
  title: string | null;
  arrMismatch: boolean;
  diffSource: DiffSource | null;
}

/** A row an admin can act on: the library disagrees with Radarr/Sonarr or with the other server's id. */
export function needsAttention(item: Pick<DiffSortable, "arrMismatch" | "diffSource">): boolean {
  return item.arrMismatch || item.diffSource?.kind === "idMismatch" || item.diffSource?.kind === "unmatched";
}

/**
 * Attention rows first, then titled rows, then by title (numeric, accent- and
 * case-insensitive), with tmdbId / mediaType / serverInstance as the tie-break so
 * the order is the same on every render.
 */
export function makeDiffComparator(collator: Intl.Collator) {
  return (a: DiffSortable, b: DiffSortable): number => {
    const attn = Number(needsAttention(b)) - Number(needsAttention(a));
    if (attn !== 0) return attn;
    const aHas = !!a.title;
    const bHas = !!b.title;
    if (aHas !== bHas) return aHas ? -1 : 1;
    const byTitle = collator.compare(a.title ?? "", b.title ?? "");
    if (byTitle !== 0) return byTitle;
    if (a.tmdbId !== b.tmdbId) return a.tmdbId - b.tmdbId;
    if (a.mediaType !== b.mediaType) return a.mediaType < b.mediaType ? -1 : 1;
    return a.serverInstance < b.serverInstance ? -1 : a.serverInstance > b.serverInstance ? 1 : 0;
  };
}

/** Bad matches: ones Radarr/Sonarr can settle first (they have a Fix), then by path. */
export function makeBadMatchComparator(collator: Intl.Collator) {
  return (
    a: { relativePath: string; arrVerdict: "plex" | "jellyfin" | null },
    b: { relativePath: string; arrVerdict: "plex" | "jellyfin" | null },
  ): number => {
    const fix = Number(b.arrVerdict !== null) - Number(a.arrVerdict !== null);
    if (fix !== 0) return fix;
    const byPath = collator.compare(a.relativePath, b.relativePath);
    return byPath !== 0 ? byPath : a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  };
}

export function diffCollator(locale: string): Intl.Collator {
  try {
    return new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  } catch {
    return new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  }
}
