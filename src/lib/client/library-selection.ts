// The Plex and Jellyfin library pickers' selection. Pure so the rules are
// unit-tested; the pickers are client components the test loader can't import.
//
// The stored value is a comma-separated id list, and an empty list means "sync
// every library" (the settings route's CLEARABLE meaning, which each picker
// promises when no box is ticked).

/** The ids in a stored `plexLibraries` / `jellyfinLibraries` value. */
export function parseLibrarySelection(raw: string): string[] {
  return raw.split(",").map((id) => id.trim()).filter(Boolean);
}

/**
 * The selected ids the server still lists, in selection order. An id the
 * server no longer has (a library deleted or recreated, or the URL now points
 * at another server) has no checkbox, so it can't be seen or unticked, yet the
 * sync reads any non-empty list as a strict filter: a list of only such ids
 * synced nothing. Call it only with a list that LOADED — never while loading or
 * after an error, or an outage would wipe the selection. Dropping every id
 * leaves [], which means "every library".
 */
export function reconcileLibrarySelection(selected: Iterable<string>, available: Iterable<string>): string[] {
  const known = new Set(available);
  return [...new Set(selected)].filter((id) => known.has(id));
}
