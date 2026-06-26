import "server-only";

// Bounded-concurrency runners. Several hot paths fan out a large list of async
// work (paged TMDB list fetches, per-item OMDB rating lookups). A bare
// `Promise.all(items.map(fn))` issues every task at once, which can saturate the
// small Prisma connection pool and burst hundreds of requests at upstream APIs
// (TMDB ~50 req/s, OMDB free tier 1k/day). These cap the number of in-flight
// tasks while preserving input order.

/**
 * Run `fn` over `items` with at most `limit` invocations in flight at once.
 * Mirrors `Promise.all`: results preserve input order and the returned promise
 * rejects if any `fn` rejects. Use when each task handles its own errors (or
 * when a rejection should abort the batch).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, n));
  const results = new Array<R>(n);
  let cursor = 0;

  async function run(): Promise<void> {
    // `cursor++` is atomic between awaits on a single-threaded event loop, so no
    // two workers ever claim the same index.
    while (cursor < n) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}

/**
 * Bounded-concurrency `Promise.allSettled`: at most `limit` tasks in flight,
 * results in input order, never rejects. Drop-in replacement for
 * `Promise.allSettled(items.map(fn))` on large fan-outs.
 */
export async function settleLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapLimit(items, limit, async (item, i): Promise<PromiseSettledResult<R>> => {
    try {
      return { status: "fulfilled", value: await fn(item, i) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  });
}
