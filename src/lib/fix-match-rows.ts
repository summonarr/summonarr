// Pure row rules for a fix-match remap (no I/O; the route's DB phase feeds them).
//
// Why it exists:
// - A remap deletes the library row under the wrong TMDB id and writes one under
//   the corrected id. It used to write only the id, file path and item key, so the
//   title, year, overview, rating and `addedAt` the sync had stored were gone
//   until the next full sync — a fixed title showed blank in the library diff and
//   a null `addedAt` dropped it out of "recently added".
// - A row that ALREADY exists for the corrected id (a correctly matched copy) has
//   its own item keys; replacing them lost the key the play-history poller resolves
//   plays through (guardrails 37 / 37c). Keys are always unioned, never replaced.

/** The descriptive columns both library tables carry. */
export const LIBRARY_META_KEYS = ["title", "year", "overview", "contentRating", "addedAt"] as const;
/** Jellyfin only. */
export const JELLYFIN_META_KEYS = [...LIBRARY_META_KEYS, "communityRating"] as const;

type Meta = Record<string, unknown>;

/**
 * Metadata for the corrected row: the target's own value wins (it was written by
 * a sync for exactly that title), the removed row's fills any gap. Only keys with
 * something to write appear, so the result is safe to spread into create or update.
 */
export function carryMeta(
  keys: readonly string[],
  target: Meta | null | undefined,
  removed: Meta | null | undefined,
): Meta {
  const out: Meta = {};
  for (const k of keys) {
    const own = target?.[k];
    if (own !== null && own !== undefined) continue;
    const carried = removed?.[k];
    if (carried !== null && carried !== undefined) out[k] = carried;
  }
  return out;
}

/** Ordered, de-duplicated, blank-free union — the first occurrence keeps its slot. */
export function unionKeys(...lists: ReadonlyArray<ReadonlyArray<string | null | undefined> | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const k of list ?? []) if (k) seen.add(k);
  }
  return [...seen];
}

/**
 * What to do with the OLD row after some of its item keys were remapped away:
 * delete it when nothing is left, otherwise keep it on the keys that did not move
 * (their copies still carry the old match) with the canonical key and file path
 * reset — the path belonged to the copy that moved.
 */
export function remainingOnOldRow(
  canonicalKey: string | null,
  allKeys: readonly string[],
  movedKeys: ReadonlySet<string>,
): { delete: true } | { delete: false; canonicalKey: string; keys: string[] } {
  const rest = unionKeys([canonicalKey], allKeys).filter((k) => !movedKeys.has(k));
  if (rest.length === 0) return { delete: true };
  return { delete: false, canonicalKey: rest[0], keys: rest };
}
