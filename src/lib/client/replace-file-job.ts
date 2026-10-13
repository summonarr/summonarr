// Client half of an issue's background Replace file (POST /api/issues/[id]/files
// with `async: true` — the guardrail-37a pattern): start the job, then poll
// `?job=` until it answers with the POST's own status and body.
//
// Why a job: the marks run one after another, each re-reading the title's
// history, and a long series outlasts a reverse proxy's hold — the admin saw a
// 502 on a replace that had in fact deleted the files.
//
// The loop is COUNTED, one poll at a time from each answer (never setInterval,
// never a clock — guardrail 16's lesson in arr-command-status.ts): at most
// `maxPolls` polls, and `failLimit` failed polls in a row (network, or a
// proxy's own 5xx with no JSON body) give up. A 404
// (the job expired or a restart dropped it) is the route's own answer and is
// returned like any other — its `error` says to reload, not to retry.

export interface ReplaceJobAnswer {
  /** The HTTP status of the replace's answer; 0 when no answer came (network, or out of polls). */
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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jobOf = (data: unknown): string | null => {
  const job = data && typeof data === "object" ? (data as { job?: unknown }).job : undefined;
  return typeof job === "string" && job !== "" ? job : null;
};

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
  const sleep = opts.sleep ?? wait;
  const alive = opts.isAlive ?? (() => true);
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, async: true }),
  });
  const data: unknown = await res.json().catch(() => ({}));
  const job = res.status === 202 ? jobOf(data) : null;
  if (job === null) return { status: res.status, data };

  const pollUrl = `${url}?job=${encodeURIComponent(job)}`;
  let failures = 0;
  for (let i = 0; i < (opts.maxPolls ?? DEFAULT_MAX_POLLS); i++) {
    await sleep(opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    if (!alive()) return null;
    let poll: Response;
    try {
      poll = await fetchFn(pollUrl);
    } catch {
      if (++failures >= (opts.failLimit ?? DEFAULT_FAIL_LIMIT)) return { status: 0, data: null };
      continue;
    }
    if (!alive()) return null;
    if (poll.status === 202) {
      failures = 0;
      continue;
    }
    const answer: unknown = await poll.json().catch(() => null);
    // A proxy's own 5xx (no JSON body) is a blip on the POLL, not the
    // replace's answer — the route's 502 always carries its counts.
    if (poll.status >= 500 && (answer === null || typeof answer !== "object")) {
      if (++failures >= (opts.failLimit ?? DEFAULT_FAIL_LIMIT)) return { status: poll.status, data: answer };
      continue;
    }
    return { status: poll.status, data: answer ?? {} };
  }
  return { status: 0, data: null };
}
