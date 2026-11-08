// Paged reads of Jellyfin's /Items listings: one page (with retry), the
// counted fan-out walk the library sync uses, and the sequential walk for
// everything else.
//
// Every walk pages by OFFSET (StartIndex), and Jellyfin's listings change while
// they are read: an item deleted or added mid-walk shifts every later item, so
// a walk can silently miss the item at a page boundary. The counted walk
// checks itself against page 0's TotalRecordCount and reads again when it came
// up short; a walk's items go into a COLLECTOR of its own, so a discarded walk
// leaves nothing behind and nothing is processed twice.
import { safeFetchAdminConfigured } from "./safe-fetch";
import { warnOnChange } from "./log-dedup";
import { processSingleton } from "./process-singleton";
import { check, v } from "./validate";
import { loose, type PageControl, STOP_PAGING } from "./media-server-payload";
import { jellyfinHeaders } from "./jellyfin-http";

export const LIBRARY_PAGE_SIZE = 5_000;
// Upper bound on the upstream-reported TotalRecordCount used for page fan-out.
// `total` is attacker-influenceable (a hostile/compromised configured Jellyfin can
// return any TotalRecordCount); without a cap, `for (s=pageSize; s<total; …)` pushes
// total/pageSize entries into startIndexes — a 10^15 total → a ~10^11-element array →
// OOM. 10M items is far beyond any real library (episodes included) yet bounds the
// pre-allocation to ≤2000 page indexes.
export const MAX_LIBRARY_ITEMS = 10_000_000;
// 60 s per page — Jellyfin can be slow on large libraries over slow connections
const PAGE_TIMEOUT_MS = 60_000;
// Response cap per page. safe-fetch's default is 10 MB of DECOMPRESSED bytes —
// at 5000 items/page with Overview + ImageBlurHashes/ImageTags a page can top
// that, and the size error retries identically 3× then aborts the whole
// movie/series sync. Same undersized-cap failure arr.ts hit at 10 MB (its cap
// was raised to 50 MB for >3k-item libraries — guardrail 5); match it.
const LIBRARY_FETCH_MAX_BYTES = 50 * 1024 * 1024;
// Pages in flight at once, across every library of one listing call: a small
// Jellyfin instance gets at most this many heavy queries together.
export const MAX_PARALLEL_PAGES = 3;
export const EPISODE_PAGE_SIZE = 1_000;
const PAGE_RETRY_ATTEMPTS = 3;
const PAGE_RETRY_DELAY_MS = 2_000;

export interface JellyfinPage {
  items: unknown[];
  // null when the response carried no TotalRecordCount — callers must treat
  // that as "unknown", never as 0.
  total: number | null;
}

// The QueryResult envelope. Strict: a 2xx that isn't one (a proxy's page that
// parses as JSON, another service) is a failed read, never an empty page. The
// items stay unknown here; each reader checks its own item shape.
const PageEnvelope = v.object({
  Items: v.optional(v.array(v.unknown())),
  TotalRecordCount: loose(v.number()),
});

/**
 * Runs `fn` once a slot is free: at most `limit` at a time, first come first
 * served. Shared by every walk of one listing call, so the pages of several
 * libraries read in parallel still respect one limit.
 */
export type PageSlots = <T>(fn: () => Promise<T>) => Promise<T>;

export function pageSlots(limit: number): PageSlots {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Resolves after `ms`, or at once when `signal` aborts. Never rejects.
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** One page of a listing, retried on a 5xx/429/network failure. */
export async function fetchPage(
  baseQuery: string,
  apiKey: string,
  startIndex: number,
  limit: number,
  signal?: AbortSignal,
): Promise<JellyfinPage> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PAGE_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleepUnlessAborted(PAGE_RETRY_DELAY_MS * attempt, signal);
      if (signal?.aborted) break;
      console.warn(`[jellyfin] retry ${attempt}/${PAGE_RETRY_ATTEMPTS} for StartIndex=${startIndex}`);
    }
    try {
      const res = await safeFetchAdminConfigured(`${baseQuery}&StartIndex=${startIndex}&Limit=${limit}`, {
        headers: jellyfinHeaders(apiKey),
        timeoutMs: PAGE_TIMEOUT_MS,
        maxResponseBytes: LIBRARY_FETCH_MAX_BYTES,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const err = new Error(`Jellyfin fetch failed: ${res.status} at StartIndex=${startIndex}`);
        // Fast-fail non-429 4xx: a 400/401/403 (bad request, revoked or
        // de-elevated API key) can never succeed on retry — retrying just
        // hammers the server for ~12s per page across a multi-page library.
        // 429 and 5xx/network errors stay retryable.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { noRetry: true });
        throw err;
      }
      // A JSON parse error stays retryable: a body can arrive truncated.
      const page = check(PageEnvelope, await res.json());
      if (!page.ok) {
        throw Object.assign(new Error(`Jellyfin fetch returned an unexpected body at StartIndex=${startIndex}: ${page.error}`), { noRetry: true });
      }
      return { items: page.value.Items ?? [], total: page.value.TotalRecordCount ?? null };
    } catch (err) {
      lastErr = err;
      if ((err as { noRetry?: boolean }).noRetry || signal?.aborted) break;
    }
  }
  throw lastErr;
}

/** Where one walk of a listing puts its items; `result` is read only for the walk that is kept. */
export interface ListingCollector<R> {
  add(items: unknown[]): void;
  result(): R;
}

export interface ListingOptions {
  pageSize?: number;
  // Shared across the libraries of one call (see pageSlots).
  slots?: PageSlots;
  // Aborts the walk: a sibling library's failure, or the caller giving up.
  signal?: AbortSignal;
}

/**
 * Reads a whole listing and returns what the accepted walk collected. Page 0's
 * TotalRecordCount drives a parallel fan-out; without one, pages are read in
 * sequence until a short page ends the results.
 */
export async function readJellyfinListing<R>(
  baseQuery: string,
  apiKey: string,
  newCollector: () => ListingCollector<R>,
  opts: ListingOptions = {},
): Promise<R> {
  const pageSize = opts.pageSize ?? LIBRARY_PAGE_SIZE;
  const slots = opts.slots ?? pageSlots(MAX_PARALLEL_PAGES);
  const first = await slots(() => fetchPage(baseQuery, apiKey, 0, pageSize, opts.signal));
  if (first.total !== null) {
    return readByCount(baseQuery, apiKey, { items: first.items, total: first.total }, newCollector, pageSize, slots, opts.signal);
  }
  return readWithoutCount(baseQuery, apiKey, first, newCollector(), pageSize, slots, opts.signal);
}

// An ABSENT TotalRecordCount is not a count of zero. Some Jellyfin versions and
// endpoints omit the field entirely, and an old `?? 0` turned that into
// `total = 0` → an empty startIndexes list → return after the FIRST page. The
// sync then wrote a library truncated to `pageSize` items and reported success,
// and the next full sync's deleteMany+repopulate (guardrail 13) made that
// truncation durable. Without a total we cannot fan out, so walk sequentially
// until a short page marks the end, bounded by the same cap as the fan-out so a
// server that never returns a short page can't loop forever.
async function readWithoutCount<R>(
  baseQuery: string,
  apiKey: string,
  first: JellyfinPage,
  collector: ListingCollector<R>,
  pageSize: number,
  slots: PageSlots,
  signal?: AbortSignal,
): Promise<R> {
  collector.add(first.items);
  if (first.items.length < pageSize) return collector.result();
  let startIndex = pageSize;
  const maxPages = Math.ceil(MAX_LIBRARY_ITEMS / pageSize);
  for (let page = 1; page < maxPages; page++) {
    const next = await slots(() => fetchPage(baseQuery, apiKey, startIndex, pageSize, signal));
    collector.add(next.items);
    if (next.items.length < pageSize) return collector.result();
    startIndex += next.items.length;
  }
  console.warn(
    `[jellyfin] page walk hit the ${MAX_LIBRARY_ITEMS}-item cap with no TotalRecordCount; library may be incomplete`,
  );
  return collector.result();
}

interface CountedWalk<R> {
  collector: ListingCollector<R>;
  served: number;
  // Page 0's count, capped (the walk's target) and as reported.
  total: number;
  reported: number;
}

// One fan-out walk: every StartIndex fixed up front from page 0's count,
// fetched in batches through the shared slots; each page goes into the walk's
// collector as its batch lands, so at most one batch of raw pages is held.
async function countedWalk<R>(
  baseQuery: string,
  apiKey: string,
  page0: { items: unknown[]; total: number },
  newCollector: () => ListingCollector<R>,
  pageSize: number,
  slots: PageSlots,
  signal?: AbortSignal,
): Promise<CountedWalk<R>> {
  const collector = newCollector();
  collector.add(page0.items);
  let served = page0.items.length;
  // Cap the upstream-reported total before deriving page indexes — a hostile
  // TotalRecordCount would otherwise pre-allocate an unbounded startIndexes array.
  const total = Math.min(page0.total, MAX_LIBRARY_ITEMS);
  const startIndexes: number[] = [];
  for (let s = pageSize; s < total; s += pageSize) startIndexes.push(s);
  for (let i = 0; i < startIndexes.length; i += MAX_PARALLEL_PAGES) {
    const batch = startIndexes.slice(i, i + MAX_PARALLEL_PAGES);
    const fetched = await Promise.all(batch.map((s) => slots(() => fetchPage(baseQuery, apiKey, s, pageSize, signal))));
    for (const p of fetched) {
      collector.add(p.items);
      served += p.items.length;
    }
  }
  return { collector, served, total, reported: page0.total };
}

// Every StartIndex is fixed from page 0's count, and those offsets assume the
// listing holds still. An item deleted mid-walk (an arr upgrade replacing a
// file) shifts every later item down one under the DateCreated sort, and the
// item at a page boundary is never read while the walk still ends "healthy" —
// and a full sync is a scoped replace, so that title would drop out of the
// library rows. So a walk that served fewer items than page 0 counted is read
// again, and only the accepted walk's collector is used. The same rule
// getJellyfinUserPlayedItems applies to its own offset walk.
async function readByCount<R>(
  baseQuery: string,
  apiKey: string,
  page0: { items: unknown[]; total: number },
  newCollector: () => ListingCollector<R>,
  pageSize: number,
  slots: PageSlots,
  signal?: AbortSignal,
): Promise<R> {
  // Keyed without the per-run MinDateLastSaved, so one listing is one key.
  const key = `jellyfin-listing-shortfall:${baseQuery.replace(/&MinDateLastSaved=[^&]*/, "")}`;
  const firstWalk = await countedWalk(baseQuery, apiKey, page0, newCollector, pageSize, slots, signal);
  if (firstWalk.served >= firstWalk.total) {
    forgetShortfall(key);
    return firstWalk.collector.result();
  }
  // The same shortfall the last read of this listing settled on: a server
  // that counts more than it serves, not a live change. Reading it twice on
  // every sync proved nothing new.
  if (isKnownShortfall(key, firstWalk.reported, firstWalk.served)) return firstWalk.collector.result();

  const again = await slots(() => fetchPage(baseQuery, apiKey, 0, pageSize, signal));
  // A count on the first read and none on the second: nothing to check the
  // read against. Failing keeps this instance's stored rows (a failed fetch).
  if (again.total === null) throw new Error("Jellyfin library listing stopped reporting its count while it was read");
  const secondWalk = await countedWalk(baseQuery, apiKey, { items: again.items, total: again.total }, newCollector, pageSize, slots, signal);
  if (secondWalk.served < secondWalk.total) {
    // Short twice with a MOVED count: the library is changing under the read.
    if (secondWalk.reported !== firstWalk.reported) {
      throw new Error("Jellyfin library listing changed while it was read");
    }
    // Short twice by the SAME count: read it as served and say so once (7b).
    rememberShortfall(key, secondWalk.reported, secondWalk.served);
    warnOnChange(
      key,
      `${secondWalk.served}/${secondWalk.total}`,
      `[jellyfin] a library listing reports ${secondWalk.total} item(s) but serves ${secondWalk.served}; read as served`,
    );
  } else {
    forgetShortfall(key);
  }
  return secondWalk.collector.result();
}

// Shortfalls a listing settled on (reported vs served), so the next read of
// the same listing that comes up short by exactly that much is accepted
// without a second full walk. Process-wide (27a); bounded like log-dedup —
// cleared wholesale on overflow, which costs at most one extra re-read per key.
const MAX_SHORTFALL_KEYS = 512;
const knownShortfalls = processSingleton("jellyfin:known-shortfalls", () => new Map<string, string>());

export function isKnownShortfall(key: string, reported: number, served: number): boolean {
  return knownShortfalls.get(key) === `${reported}/${served}`;
}

export function rememberShortfall(key: string, reported: number, served: number): void {
  if (knownShortfalls.size >= MAX_SHORTFALL_KEYS && !knownShortfalls.has(key)) knownShortfalls.clear();
  knownShortfalls.set(key, `${reported}/${served}`);
}

export function forgetShortfall(key: string): void {
  knownShortfalls.delete(key);
}

/**
 * Pages a listing in sequence until a short page, `onPage` seeing each page's
 * raw entries as it lands (STOP_PAGING ends the walk — the upstream-watch walk
 * stops on its AbortSignal, guardrail 41). Used where per-page memory matters
 * more than speed: episode counts per series are unpredictable and concurrent
 * large episode requests can stall slow Jellyfin servers.
 *
 * Returns page 0's TotalRecordCount (capped), so a caller that must know the
 * walk read everything can compare (getJellyfinUserPlayedItems); null = the
 * server reported no count. A reported total is trusted as the end of the
 * listing: a walk that reached it stops even on a full page.
 */
export async function walkJellyfinSequential(
  baseQuery: string,
  apiKey: string,
  onPage: (items: unknown[]) => PageControl,
  pageSize: number = EPISODE_PAGE_SIZE,
): Promise<number | null> {
  // Absent TotalRecordCount ⇒ walk until a short page ends the results. The
  // starting bound is the CAP, not Infinity: a server that ignores StartIndex
  // (or otherwise never returns a partial page) would otherwise spin forever —
  // holding the sync's advisory lock while onPage accumulates every page.
  let total = MAX_LIBRARY_ITEMS;
  let reportedTotal: number | null = null;
  // Second, independent bound: `startIndex` only advances by what the server
  // actually returned, so the `total` guard alone can't bound a server that
  // returns full pages without advancing.
  const maxPages = Math.ceil(MAX_LIBRARY_ITEMS / pageSize);
  let startIndex = 0;
  let pageNum = 0;
  let endedOnShortPage = false;

  while (startIndex < total && pageNum < maxPages) {
    const page = await fetchPage(baseQuery, apiKey, startIndex, pageSize);
    if (pageNum === 0 && page.total !== null) {
      total = Math.min(page.total, MAX_LIBRARY_ITEMS);
      reportedTotal = total;
    }
    const stop = onPage(page.items) === STOP_PAGING;
    startIndex += page.items.length;
    pageNum++;
    if (stop) break;
    // A short page (an empty one included) is the end of the results.
    if (page.items.length < pageSize) {
      endedOnShortPage = true;
      break;
    }
  }
  // Warn only on a genuine truncation. A library whose size is an exact
  // multiple of pageSize also exits via `startIndex < total` without a short
  // page, and that is a complete, correct walk — not something to warn about.
  if (!endedOnShortPage && startIndex >= MAX_LIBRARY_ITEMS) {
    console.warn(
      `[jellyfin] sequential page walk hit the ${MAX_LIBRARY_ITEMS}-item cap; results may be incomplete`,
    );
  }
  return reportedTotal;
}
