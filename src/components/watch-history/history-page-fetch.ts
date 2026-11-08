// One page of the caller's own watch history from /api/play-history/mine, read
// and shape-checked. Plain fetch rather than fetchJson: a 429's Retry-After
// header is what tells the list how long to hold its Retry button, and
// fetchJson does not hand headers back. No React, so the unit suite loads it.
import { check, v, type Infer } from "@/lib/validate";
import { parseRetryAfterSeconds } from "@/lib/client/rate-limit";
import type { MyWatchHistoryItem, MyWatchHistoryPage } from "@/lib/my-watch-history";

const ItemSchema = v.object({
  id: v.string(),
  source: v.string(),
  startedAt: v.string(),
  stoppedAt: v.string(),
  duration: v.number(),
  playDuration: v.number(),
  watched: v.boolean(),
  completed: v.boolean(),
  tmdbId: v.nullable(v.int()),
  mediaType: v.nullable(v.literal("MOVIE", "TV")),
  title: v.string(),
  year: v.nullable(v.string()),
  posterPath: v.nullable(v.string()),
  seasonNumber: v.nullable(v.int()),
  episodeNumber: v.nullable(v.int()),
  episodeTitle: v.nullable(v.string()),
  platform: v.nullable(v.string()),
  player: v.nullable(v.string()),
  device: v.nullable(v.string()),
  playMethod: v.nullable(v.string()),
  posterUrl: v.nullable(v.string()),
  playCount: v.int(),
  totalPlaySeconds: v.number(),
});

// The fields the list reads off a refetched page; `linked` and `stats` come
// from the server-rendered first page only.
const PageSchema = v.object({
  items: v.array(ItemSchema),
  total: v.int(),
  nextCursor: v.nullable(v.string()),
});

// Compile-time, both directions: a field added to the route's item type or to
// the schema without the other fails typecheck.
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const itemShapeMatches: AssertSame<Infer<typeof ItemSchema>, MyWatchHistoryItem> = true;
void itemShapeMatches;

export type HistoryPageSlice = Pick<MyWatchHistoryPage, "items" | "total" | "nextCursor">;

export type HistoryPageResult =
  | { ok: true; page: HistoryPageSlice }
  | { ok: false; aborted: true }
  /** `retryAfterSeconds` is set only for a 429 that named its wait. */
  | { ok: false; aborted: false; rateLimited: boolean; retryAfterSeconds: number | null };

export function historyQuery(mediaType: string, search: string, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (mediaType) params.set("mediaType", mediaType);
  if (search.trim()) params.set("search", search.trim());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** Never throws. A body that isn't the page shape (a proxy's 200 HTML page,
 *  an error object) is a failure, not a crash on `data.items`. */
export async function fetchHistoryPage(url: string, signal?: AbortSignal): Promise<HistoryPageResult> {
  const failed = (rateLimited = false, retryAfterSeconds: number | null = null): HistoryPageResult => ({
    ok: false,
    aborted: false,
    rateLimited,
    retryAfterSeconds,
  });
  try {
    const res = await fetch(url, { signal });
    if (res.status === 429) return failed(true, parseRetryAfterSeconds(res.headers.get("Retry-After")));
    if (!res.ok) return failed();
    const parsed = check(PageSchema, (await res.json()) as unknown);
    if (!parsed.ok) {
      console.warn(`[watch-history] unexpected page shape: ${parsed.error}`);
      return failed();
    }
    return { ok: true, page: parsed.value };
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return { ok: false, aborted: true };
    return failed();
  }
}
