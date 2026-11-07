// Client half of an issue's background Replace file (POST /api/issues/[id]/files
// with `async: true` — the guardrail-37a pattern): start the job, then poll
// `?job=` until it answers with the POST's own status and body.
//
// Why a job: the marks run one after another, each re-reading the title's
// history, and a long series outlasts a reverse proxy's hold — the admin saw a
// 502 on a replace that had in fact deleted the files.
//
// The poll loop is the shared one (job-poll.ts): COUNTED, at most `maxPolls`
// polls, and `failLimit` failed polls in a row (network, or a proxy's own
// 5xx whose body is not JSON) give up — both answer status 0 ("no answer, it
// may still be running"), never the proxy's 5xx: every caller reads a non-2xx
// as the job's own failure. A 404 (the job expired or a restart dropped it) is
// the route's own answer and is returned like any other — its `error` says to
// reload, not to retry.
import { jobIdOf, pollJob } from "./job-poll";

export interface ReplaceJobAnswer {
  /** The HTTP status of the replace's answer; 0 when no answer came (network or proxy 5xx polls, or out of polls). */
  status: number;
  data: unknown;
}

export interface ReplaceJobOptions {
  /** Waits between polls; a test passes an immediate one. */
  sleep?: (ms: number) => Promise<void>;
  /** False once the dialog has unmounted: the loop stops and answers null. */
  isAlive?: () => boolean;
  intervalMs?: number;
  maxPolls?: number;
  failLimit?: number;
}

const DEFAULT_INTERVAL_MS = 1_500;
// 400 × 1.5 s ≈ 10 minutes — longer than any replace, shorter than the job's 10-minute answer TTL plus the run.
const DEFAULT_MAX_POLLS = 400;
const DEFAULT_FAIL_LIMIT = 5;

/**
 * POST the replace as a background job and wait for its answer. Resolves with
 * the answer (status 0 = none came), or null when `isAlive` turned false.
 * A network failure on the POST itself rejects, as a bare fetch would.
 */
export async function runReplaceFileJob(
  fetchFn: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  opts: ReplaceJobOptions = {},
): Promise<ReplaceJobAnswer | null> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, async: true }),
  });
  const data: unknown = await res.json().catch(() => ({}));
  const job = res.status === 202 ? jobIdOf(data) : null;
  if (job === null) return { status: res.status, data };

  const answer = await pollJob(fetchFn, `${url}?job=${encodeURIComponent(job)}`, {
    sleep: opts.sleep,
    isAlive: opts.isAlive,
    intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    maxPolls: opts.maxPolls ?? DEFAULT_MAX_POLLS,
    failLimit: opts.failLimit ?? DEFAULT_FAIL_LIMIT,
  });
  if (answer === null || answer.status === 0) return answer;
  return { status: answer.status, data: answer.data ?? {} };
}
