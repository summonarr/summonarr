// Client half of a background interactive release search (`&async=1` on the
// release routes — the guardrail-37a pattern, release-search-jobs.ts): ask for
// the search, then poll `?job=` until it answers with the search's own status
// and body. Shared by the request queue's / title manager's ReleaseSearchDialog
// and the issue Replace panel, so the two loops can't drift.
//
// Why a job: indexers take a minute or two on a Sonarr season search, longer
// than a reverse proxy keeps one request open — the admin saw a 502 while the
// arr finished, retried, and every indexer was hit again.
//
// The loop is COUNTED, one poll at a time from each answer (never setInterval,
// never a clock — guardrail 16's lesson in arr-command-status.ts): past
// `maxPolls` polls it gives up. A 404 (the job expired, or a restart dropped
// it) is the route's own answer and is returned like any other — its `error`
// says to search again. A network failure rejects, as a bare fetch would.

export interface ReleaseSearchAnswer {
  /** The HTTP status of the search's answer; 0 when none came (no job id, or out of polls). */
  status: number;
  data: unknown;
}

export interface ReleaseSearchOptions {
  /** Waits between polls; a test passes an immediate one. */
  sleep?: (ms: number) => Promise<void>;
  /** False once the search is superseded or the dialog closed: the loop stops and answers null. */
  isAlive?: () => boolean;
  /** Called before each wait with the polls made so far — the "still searching" hint. */
  onPoll?: (polls: number) => void;
  intervalMs?: number;
  maxPolls?: number;
}

export const RELEASE_SEARCH_POLL_MS = 2_000;
// The server stops waiting on the arr after 120 s; 150 × 2 s = 5 minutes, past which the job is lost.
const DEFAULT_MAX_POLLS = 150;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jobOf = (data: unknown): string | null => {
  const job = data && typeof data === "object" ? (data as { job?: unknown }).job : undefined;
  return typeof job === "string" && job !== "" ? job : null;
};

/**
 * GET `url` with `async=1` and wait for the search's answer. Resolves with the
 * answer (status 0 = none came), or null when `isAlive` turned false.
 */
export async function runReleaseSearchJob(
  fetchFn: typeof fetch,
  url: string,
  opts: ReleaseSearchOptions = {},
): Promise<ReleaseSearchAnswer | null> {
  const sleep = opts.sleep ?? wait;
  const alive = opts.isAlive ?? (() => true);
  const interval = opts.intervalMs ?? RELEASE_SEARCH_POLL_MS;
  const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollBase = url.split("?")[0];
  let res = await fetchFn(url + (url.includes("?") ? "&async=1" : "?async=1"));
  if (!alive()) return null;
  let polls = 0;
  while (res.status === 202) {
    const job = jobOf(await res.json().catch(() => null));
    if (!alive()) return null;
    if (job === null || polls >= maxPolls) return { status: 0, data: null };
    opts.onPoll?.(polls);
    polls++;
    await sleep(interval);
    if (!alive()) return null;
    res = await fetchFn(`${pollBase}?job=${encodeURIComponent(job)}`);
    if (!alive()) return null;
  }
  const data: unknown = await res.json().catch(() => null);
  if (!alive()) return null;
  return { status: res.status, data };
}
