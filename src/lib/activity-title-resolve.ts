// Title-only tmdbId fallback for the admin activity pages — pure, zero-import.
//
// PlayHistory.tmdbId is null for plays that were unmapped at record time. The
// per-user activity page tries to relink those by TITLE against (a) other
// PlayHistory rows that did resolve and (b) the library tables. That fallback
// used to be keyed on the bare title, which is wrong for same-titled cross-type
// pairs (Fargo, Westworld, Scream, The Thing, M*A*S*H): a TV play of "Fargo"
// with only the MOVIE "Fargo" in the library was relinked to the movie's tmdbId,
// its own non-null mediaType was overwritten by the library row's, and the
// recent-plays row produced `/admin/activity/media/<movieId>?type=TV` — a link
// to a title that does not exist.
//
// The unmapped play DOES know its own type (PlayHistory.mediaType is written
// verbatim from the session, and the topMedia SQL groups on it), so the rule is:
//   - a typed play matches ONLY a candidate of the same type;
//   - a type-less play (mediaType null) accepts a typed candidate of either
//     type, deterministically preferring MOVIE over TV so two same-titled
//     library rows can't flip the answer between renders;
//   - a play's own non-null mediaType is NEVER overwritten by the resolver's.
// The Prisma `where` fragments are built here too so the query scoping and the
// map keying can't drift apart.

export type ActivityMediaType = "MOVIE" | "TV";

export interface UnmappedTitlePair {
  title: string;
  mediaType: ActivityMediaType | null;
}

export interface ResolvedTitle {
  tmdbId: number;
  mediaType: string | null;
}

export type TitleResolveMap = Record<string, ResolvedTitle>;

interface TitleEntry {
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
}

export function toActivityMediaType(value: string | null | undefined): ActivityMediaType | null {
  return value === "MOVIE" || value === "TV" ? value : null;
}

// Map key: `<MOVIE|TV|''>:<title>`. Never the bare title.
export function titleResolveKey(title: string, mediaType: string | null | undefined): string {
  return `${toActivityMediaType(mediaType) ?? ""}:${title}`;
}

// The distinct (title, mediaType) pairs still needing a tmdbId, in first-seen
// order. Empty/whitespace titles are dropped — nothing could match them.
export function collectUnmappedPairs(items: readonly TitleEntry[]): UnmappedTitlePair[] {
  const seen = new Set<string>();
  const out: UnmappedTitlePair[] = [];
  for (const m of items) {
    if (m.tmdbId != null || !m.title) continue;
    const mediaType = toActivityMediaType(m.mediaType);
    const key = titleResolveKey(m.title, mediaType);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: m.title, mediaType });
  }
  return out;
}

// One `OR` disjunct per pair. A typed pair carries the mediaType predicate; a
// type-less one matches either type. Spread extra predicates (`tmdbId: { not:
// null }`) at the call site.
export function titleWhereDisjuncts(
  pairs: readonly UnmappedTitlePair[],
): Array<{ title: string; mediaType?: ActivityMediaType }> {
  return pairs.map((p) => (p.mediaType ? { title: p.title, mediaType: p.mediaType } : { title: p.title }));
}

// First writer wins per key — callers feed the authoritative source first.
export function addTitleResolutions(
  map: TitleResolveMap,
  rows: readonly { title: string | null; tmdbId: number | null; mediaType: string | null }[],
): TitleResolveMap {
  for (const r of rows) {
    if (!r.title || r.tmdbId == null) continue;
    const key = titleResolveKey(r.title, r.mediaType);
    if (!(key in map)) map[key] = { tmdbId: r.tmdbId, mediaType: toActivityMediaType(r.mediaType) };
  }
  return map;
}

// Exact (type, title) match; a type-less lookup falls back to a typed match,
// MOVIE first for determinism.
export function lookupTitleResolution(
  map: TitleResolveMap,
  title: string,
  mediaType: string | null | undefined,
): ResolvedTitle | undefined {
  const typed = toActivityMediaType(mediaType);
  const exact = map[titleResolveKey(title, typed)];
  if (exact || typed) return exact;
  return map[titleResolveKey(title, "MOVIE")] ?? map[titleResolveKey(title, "TV")];
}

// Pairs the resolver still has no answer for (the second-stage lookup input).
export function unresolvedPairs(
  map: TitleResolveMap,
  pairs: readonly UnmappedTitlePair[],
): UnmappedTitlePair[] {
  return pairs.filter((p) => !lookupTitleResolution(map, p.title, p.mediaType));
}

export type ResolvedEntry<T extends TitleEntry> = Omit<T, "tmdbId" | "mediaType"> & {
  tmdbId: number | null;
  mediaType: string | null;
};

// Applies a resolution to an entry: fills tmdbId, keeps the entry's own
// mediaType when it has one. Already-mapped entries are returned untouched.
export function resolveUnmappedEntry<T extends TitleEntry>(
  entry: T,
  map: TitleResolveMap,
): ResolvedEntry<T> {
  if (entry.tmdbId != null) return entry;
  const r = lookupTitleResolution(map, entry.title, entry.mediaType);
  if (!r) return entry;
  return { ...entry, tmdbId: r.tmdbId, mediaType: entry.mediaType ?? r.mediaType };
}
