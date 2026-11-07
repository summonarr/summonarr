// The one counted `?job=` poll loop behind every background job the browser
// waits on (the guardrail-37a pattern): an issue's Replace file and the other
// runReplaceFileJob callers, the release searches (release-search-job.ts), the
// title manager's file delete and Arr System's provider tests and saves. Each
// caller keeps its own interval and poll budget; the loop and the rule for a
// failed poll are shared, so a fix to one reaches all of them.
//
// COUNTED, one poll at a time from each answer — never setInterval, never a
// clock (guardrail 16's lesson in arr-command-status.ts). A 202 is "still
// running". A poll that failed on the WAY — the fetch threw, or a 5xx whose
// body is not JSON (a reverse proxy's own error page: nginx's 502/504, a
// Cloudflare 520–524) — is not the job's answer (guardrail 37a): it is
// retried, and `failLimit` of them in a row end the wait as "no answer"
// (status 0), exactly like running out of polls. The job keeps running on the
// server either way, so neither is ever reported as its failure. Every answer
// of the job itself is JSON — the route's 404 "gone", its own 502/504, the
// JSON `null` 500 a thrown job answers with — and is returned as it came.
import { JOB_MAX_FAILED_POLLS } from "../arr-system";

export interface JobPollAnswer {
  /** The job's own answer's status; 0 when none came (out of polls, or too many failed polls in a row). */
  status: number;
  /** Its JSON body, or null when it had none. */
  data: unknown;
}

export interface JobPollOptions {
  /** Waits between polls; a test passes an immediate one. */
  sleep?: (ms: number) => Promise<void>;
  /** False once the caller is gone (superseded, unmounted): the loop stops and answers null. */
  isAlive?: () => boolean;
  /** Called before each wait with the polls made so far. */
  onPoll?: (polls: number) => void;
  intervalMs: number;
  maxPolls: number;
  /** Failed polls in a row before giving up as "no answer"; JOB_MAX_FAILED_POLLS by default. */
  failLimit?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A poll that never reached the job: no answer at all, or a 5xx that is not JSON. */
export function failedOnTheWay(status: number, isJson: boolean): boolean {
  return status === 0 || (status >= 500 && !isJson);
}

/** The job id a 202 names, or null. */
export function jobIdOf(data: unknown): string | null {
  const job = data && typeof data === "object" ? (data as { job?: unknown }).job : undefined;
  return typeof job === "string" && job !== "" ? job : null;
}

/**
 * Poll `pollUrl` until the job answers. Resolves with that answer (status 0,
 * data null = none came), or null once `isAlive` turned false.
 */
export async function pollJob(fetchFn: typeof fetch, pollUrl: string, opts: JobPollOptions): Promise<JobPollAnswer | null> {
  const sleep = opts.sleep ?? wait;
  const alive = opts.isAlive ?? (() => true);
  const failLimit = opts.failLimit ?? JOB_MAX_FAILED_POLLS;
  let failures = 0;
  for (let polls = 0; polls < opts.maxPolls; polls++) {
    opts.onPoll?.(polls);
    await sleep(opts.intervalMs);
    if (!alive()) return null;
    let status = 0;
    let data: unknown = null;
    let isJson = false;
    try {
      const res = await fetchFn(pollUrl);
      status = res.status;
      if (status !== 202) {
        try {
          data = await res.json();
          isJson = true;
        } catch {
          // Not JSON: no route of ours answered it.
        }
      }
    } catch {
      // The poll never arrived: status 0, a failure on the way.
    }
    if (!alive()) return null;
    if (status === 202) {
      failures = 0;
      continue;
    }
    if (failedOnTheWay(status, isJson)) {
      if (++failures >= failLimit) return { status: 0, data: null };
      continue;
    }
    return { status, data };
  }
  return { status: 0, data: null };
}
