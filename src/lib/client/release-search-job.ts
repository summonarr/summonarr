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
// The poll loop is the shared one (job-poll.ts): COUNTED, and past `maxPolls`
// polls it gives up. A poll that fails on the way (a network blip, a proxy's
// own 502–504 with no JSON) is retried, `failLimit` of them in a row being "no
// answer" (status 0) — one dropped poll no longer ends a search that is still
// running. A 404 (the job expired, or a restart dropped it) is the route's own
// answer and is returned like any other — its `error` says to search again;
// so is the route's own JSON 502. A network failure on the first request
// rejects, as a bare fetch would.
import { jobIdOf, pollJob } from "./job-poll";

export interface ReleaseSearchAnswer {
  /** The HTTP status of the search's answer; 0 when none came (no job id, out of polls, or too many failed polls in a row). */
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
  /** Failed polls in a row before giving up (job-poll.ts's default). */
  failLimit?: number;
}

export const RELEASE_SEARCH_POLL_MS = 2_000;
// The server stops waiting on the arr after 120 s; 150 × 2 s = 5 minutes, past which the job is lost.
const DEFAULT_MAX_POLLS = 150;

/**
 * GET `url` with `async=1` and wait for the search's answer. Resolves with the
 * answer (status 0 = none came), or null when `isAlive` turned false.
 */
export async function runReleaseSearchJob(
  fetchFn: typeof fetch,
  url: string,
  opts: ReleaseSearchOptions = {},
): Promise<ReleaseSearchAnswer | null> {
  const alive = opts.isAlive ?? (() => true);
  const res = await fetchFn(url + (url.includes("?") ? "&async=1" : "?async=1"));
  if (!alive()) return null;
  const data: unknown = await res.json().catch(() => null);
  if (!alive()) return null;
  if (res.status !== 202) return { status: res.status, data };
  const job = jobIdOf(data);
  if (job === null) return { status: 0, data: null };
  return pollJob(fetchFn, `${url.split("?")[0]}?job=${encodeURIComponent(job)}`, {
    sleep: opts.sleep,
    isAlive: alive,
    onPoll: opts.onPoll,
    intervalMs: opts.intervalMs ?? RELEASE_SEARCH_POLL_MS,
    maxPolls: opts.maxPolls ?? DEFAULT_MAX_POLLS,
    failLimit: opts.failLimit,
  });
}
