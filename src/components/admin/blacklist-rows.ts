// The request blacklist manager's pure halves (blacklist-manager.tsx): the row
// keys, the client filter over the loaded rows, and the checked reads of the
// three answers it uses — /api/search's results and the blacklist route's
// POST and DELETE. No React, so the unit suite reads it
// (tests/blacklist-manager-ui.test.mts).
import { check, v } from "@/lib/validate";

export interface BlacklistRow {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  reason: string | null;
  createdAt: string;
}

export interface SearchResult {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  releaseYear?: string | null;
  /** /api/search marks a title on the WHOLE blacklist — the page loads only the newest 1000 rows. */
  blacklisted: boolean;
}

/** A title on the blacklist, as the DELETE names it. */
export type BlacklistKey = Pick<BlacklistRow, "tmdbId" | "mediaType">;

export const rowKey = (tmdbId: number, mt: string) => `${tmdbId}:${mt}`;

/** The blacklist's media type for a search result's. */
export const rowMediaType = (r: Pick<SearchResult, "mediaType">): BlacklistRow["mediaType"] => (r.mediaType === "movie" ? "MOVIE" : "TV");

/** Client-side narrowing of the loaded rows: title, reason, or the exact TMDB id. */
export function filterRows(items: readonly BlacklistRow[], filter: string): readonly BlacklistRow[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (i) =>
      (i.title ?? `TMDB #${i.tmdbId}`).toLowerCase().includes(needle) ||
      (i.reason ?? "").toLowerCase().includes(needle) ||
      String(i.tmdbId) === needle,
  );
}

const SearchItem = v.object({
  id: v.int(),
  mediaType: v.literal("movie", "tv"),
  title: v.string(),
  releaseYear: v.optional(v.nullable(v.string())),
  blacklisted: v.optional(v.boolean()),
});

/** The first `max` movie and TV results of a /api/search answer; anything else (a person, junk) is skipped. */
export function searchResultsFrom(data: unknown, max = 8): SearchResult[] {
  if (!Array.isArray(data)) return [];
  const out: SearchResult[] = [];
  for (const d of data) {
    if (out.length >= max) break;
    const item = check(SearchItem, d);
    if (!item.ok) continue;
    out.push({
      id: item.value.id,
      mediaType: item.value.mediaType,
      title: item.value.title,
      releaseYear: item.value.releaseYear,
      blacklisted: item.value.blacklisted === true,
    });
  }
  return out;
}

const AddAnswer = v.object({
  item: v.optional(v.nullable(v.object({
    title: v.optional(v.nullable(v.string())),
    reason: v.optional(v.nullable(v.string())),
    createdAt: v.optional(v.string()),
  }))),
  created: v.optional(v.boolean()),
});

/**
 * What a POST told us: the stored row's cleaned fields (each may be missing) and
 * whether it ADDED a row. An unreadable body says neither.
 */
export function addAnswerFrom(data: unknown): { item: { title?: string | null; reason?: string | null; createdAt?: string } | null; created: boolean } {
  const parsed = check(AddAnswer, data);
  if (!parsed.ok) return { item: null, created: false };
  return { item: parsed.value.item ?? null, created: parsed.value.created === true };
}

/** How many rows a DELETE removed (0 when another admin got there first); 0 when unreadable. */
export function removedCountFrom(data: unknown): number {
  const parsed = check(v.object({ removed: v.int() }), data);
  return parsed.ok && parsed.value.removed > 0 ? parsed.value.removed : 0;
}
