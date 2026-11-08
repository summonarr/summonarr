// Admin → Missing, "Search selected": the runner behind the bulk bar in
// missing-report.tsx. Pure (its one import is zero-import too) so a client
// component can use it and the unit suite can pin it — the component supplies the network call and the
// row-state reads; this decides the order, the pacing, cancellation and the one
// retry after a 429.
//
// The pacing does NOT protect Radarr/Sonarr. Every search POST answers 202 as
// soon as the arr has QUEUED its command, so two at a time paces only
// Summonarr's own requests — the arr's command queue, and every indexer behind
// it, still receives the whole selection within minutes. What bounds a run is
// the cap (BULK_SEARCH_MAX, past which the library-wide "Search all missing" in
// Arr System is the tool), the confirmation above BULK_SEARCH_CONFIRM_OVER,
// Cancel, and the search route's per-admin rate limit.

import { retryAfterDeltaSeconds } from "./client/rate-limit";

/** Search requests in flight at once. */
export const BULK_SEARCH_CONCURRENCY = 2;
/** The most titles one run takes; the selection UI refuses to tick more. */
export const BULK_SEARCH_MAX = 100;
/** A run of more titles than this asks first. */
export const BULK_SEARCH_CONFIRM_OVER = 10;
/** Wait before the one retry of a rate-limited row when the 429 names no usable Retry-After. */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 30_000;
/** The longest a Retry-After is honoured: the route's limiter window. */
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;

/**
 * How one title's search ended. `already` is a 409 — Radarr/Sonarr, re-judged
 * live, say nothing is missing (or below cutoff) any more: the title is
 * complete, which is not a failure.
 */
export type SearchOutcome = "started" | "already" | "failed";

export type SearchAttempt =
  | { outcome: SearchOutcome; message: string }
  | { outcome: "rateLimited"; message: string; retryAfterMs: number };

/** A Retry-After header (delta-seconds) → how long to wait, bounded. An HTTP-date or garbage gets the default. */
export function retryAfterMs(header: string | null): number {
  const seconds = retryAfterDeltaSeconds(header);
  if (seconds === null) return RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(1_000, seconds * 1_000));
}

/** The search route's answer → an attempt. `message` is the route's (already translated) error text. */
export function searchAttemptFromResponse(status: number, message: string, retryAfter: string | null): SearchAttempt {
  if (status >= 200 && status < 300) return { outcome: "started", message: "" };
  if (status === 409) return { outcome: "already", message };
  if (status === 429) return { outcome: "rateLimited", message, retryAfterMs: retryAfterMs(retryAfter) };
  return { outcome: "failed", message };
}

/** The first BULK_SEARCH_MAX rows — what "select all" ticks and what a run takes. */
export function capSelection<T>(rows: readonly T[], max: number = BULK_SEARCH_MAX): T[] {
  return rows.slice(0, Math.max(0, max));
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface BulkSearchHooks<R> {
  /** Aborted by Cancel and by the page unmounting; checked before each row is taken. */
  signal: AbortSignal;
  /** One search request for the row. Should not throw; a throw counts as a failure. */
  attempt: (row: R) => Promise<SearchAttempt>;
  /**
   * Read when the row is DEQUEUED, not when the run started: a row that is busy
   * or already searched by then is skipped, never searched twice.
   */
  skip: (row: R) => boolean;
  /** Each row's final outcome, as it lands. */
  onSettled: (row: R, outcome: SearchOutcome | "skipped", message: string) => void;
  /** Rows settled so far (skipped ones included). */
  onProgress?: (done: number) => void;
  /** Injectable for tests; must resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface BulkSearchSummary<R> {
  started: number;
  already: number;
  failed: R[];
  skipped: number;
  /** Rows never taken because the run was cancelled. */
  notRun: number;
  cancelled: boolean;
}

// The run's tally, and the one place a row's outcome is reported. A hook that
// throws must not stop the worker that called it.
function makeSettler<R>(hooks: BulkSearchHooks<R>, summary: BulkSearchSummary<R>) {
  let done = 0;
  return (row: R, outcome: SearchOutcome | "skipped", message: string) => {
    if (outcome === "started") summary.started++;
    else if (outcome === "already") summary.already++;
    else if (outcome === "failed") summary.failed.push(row);
    else summary.skipped++;
    done++;
    try {
      hooks.onSettled(row, outcome, message);
      hooks.onProgress?.(done);
    } catch {
      // the UI's bookkeeping, not the run's
    }
  };
}

// One shared back-off for every worker: a 429 says the ROUTE's per-admin
// limit is spent, so the other worker's next request would be refused too.
// Every worker waits out the latest pause before it sends again.
function makeBackoff(sleep: (ms: number, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
  let pause: Promise<void> = Promise.resolve();
  return {
    /** Starts (or extends) the pause and resolves when it is over. */
    hold(ms: number): Promise<void> {
      const before = pause;
      pause = Promise.all([before, sleep(ms, signal)]).then(() => {});
      return pause;
    },
    wait(): Promise<void> {
      return pause;
    },
  };
}

/**
 * Searches `rows` (capped at BULK_SEARCH_MAX) BULK_SEARCH_CONCURRENCY at a time.
 * A 429 waits out its Retry-After (abortable) — every worker waits with it —
 * and retries that row ONCE; a second 429, or a cancel during the wait,
 * settles it as failed.
 */
export async function runBulkSearch<R>(rows: readonly R[], hooks: BulkSearchHooks<R>): Promise<BulkSearchSummary<R>> {
  const queue = capSelection(rows);
  const summary: BulkSearchSummary<R> = { started: 0, already: 0, failed: [], skipped: 0, notRun: 0, cancelled: false };
  const settle = makeSettler(hooks, summary);
  const backoff = makeBackoff(hooks.sleep ?? abortableSleep, hooks.signal);
  let next = 0;

  // A throwing attempt must not kill its worker: the rows behind it would never
  // be taken, and the run would report them as neither done nor cancelled.
  const attempt = async (row: R): Promise<SearchAttempt> => {
    try {
      return await hooks.attempt(row);
    } catch {
      return { outcome: "failed", message: "" };
    }
  };
  const skip = (row: R): boolean | null => {
    try {
      return hooks.skip(row);
    } catch {
      return null;
    }
  };

  const worker = async () => {
    while (next < queue.length && !hooks.signal.aborted) {
      await backoff.wait();
      if (next >= queue.length || hooks.signal.aborted) break;
      const row = queue[next++];
      const skipped = skip(row);
      if (skipped !== false) {
        // Unreadable row state: never searched, reported as failed.
        settle(row, skipped === null ? "failed" : "skipped", "");
        continue;
      }
      let result = await attempt(row);
      if (result.outcome === "rateLimited") {
        await backoff.hold(result.retryAfterMs);
        if (!hooks.signal.aborted) result = await attempt(row);
      }
      settle(row, result.outcome === "rateLimited" ? "failed" : result.outcome, result.message);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_SEARCH_CONCURRENCY, queue.length) }, worker));
  summary.notRun = queue.length - next;
  summary.cancelled = hooks.signal.aborted;
  return summary;
}
