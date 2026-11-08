// The header search's reading of GET /api/search (an array of titles). Each
// entry is checked on its own and an odd one is dropped, not the whole list:
// an entry without a movie/tv type or a numeric id would route to
// /undefined/undefined and collide on its React key. Pure, so the unit suite
// reads it (tests/search-results.test.mts).
import { check, v, type Infer } from "@/lib/validate";

const SearchHitSchema = v.object({
  id: v.int(),
  mediaType: v.literal("movie", "tv"),
  title: v.string(),
  posterPath: v.optional(v.nullable(v.string())),
  releaseYear: v.optional(v.nullable(v.string())),
  plexAvailable: v.optional(v.boolean()),
  jellyfinAvailable: v.optional(v.boolean()),
});

export type SearchHit = Infer<typeof SearchHitSchema>;

/** How many results the dropdown lists. */
export const SEARCH_RESULT_LIMIT = 8;

/** The usable hits of an answer (at most SEARCH_RESULT_LIMIT, in order), or null when the answer isn't a list. */
export function searchHits(body: unknown): SearchHit[] | null {
  if (!Array.isArray(body)) return null;
  const hits: SearchHit[] = [];
  for (const entry of body) {
    const parsed = check(SearchHitSchema, entry);
    if (parsed.ok) hits.push(parsed.value);
    if (hits.length >= SEARCH_RESULT_LIMIT) break;
  }
  return hits;
}
