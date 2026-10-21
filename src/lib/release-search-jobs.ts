// Interactive release searches as background jobs (the guardrail-37a pattern).
// An arr's interactive search waits on every indexer it has — a Sonarr season
// search routinely takes 60–110 s — while a reverse proxy in front of
// Summonarr keeps one request open for ~60 s (nginx, NPM) to ~100 s
// (Cloudflare). Held open, the browser got a proxy 502/504 while the search
// finished on the server, the admin retried, and every indexer was hit again.
//
// A caller asking for `async` gets 202 { job } at once; the search runs in this
// process and the client polls with the job id until it gets the search's own
// answer — the exact status and body the synchronous route would have sent.
// The same owner starting the same search while one is running joins it
// instead of spending indexer hits twice.
//
// In memory, per process (Summonarr is one long-lived Node server — the
// assumption guardrail 17 rests on). A restart drops every job; the poll then
// 404s and the client says to search again.
//
// The same registry runs Arr System's provider tests and testing saves
// (startArrJob / jobResponse): an arr tests an indexer before saving it ON and
// Test All waits on every enabled one — up to 120 s, past what a proxy holds.
// The registry is generic (owner, key, run → { status, body }); only the
// "job gone" message and the log line name what the job was.
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { Translator } from "./i18n/translate";
import { processSingleton } from "./process-singleton";

/** How long a finished job's answer stays readable. */
const RESULT_TTL_MS = 10 * 60_000;
// A finished job holds a whole release list (a Sonarr season answer runs to
// hundreds of KB), so the map is swept of expired answers on every start and
// poll — never left to fill up to the cap.
const MAX_JOBS = 200;
const JOB_RE = /^[0-9a-f]{32}$/;

export interface JobAnswer {
  status: number;
  body: unknown;
}

type Job = {
  owner: string;
  key: string;
  answer: JobAnswer | null;
  finishedAt: number | null;
};

const jobs = processSingleton("release-search-jobs", () => new Map<string, Job>());

function sweepExpired(now: number): void {
  for (const [id, j] of jobs) if (j.finishedAt !== null && now - j.finishedAt > RESULT_TTL_MS) jobs.delete(id);
}

function sweep(now: number): void {
  sweepExpired(now);
  // Still full: drop the oldest FINISHED jobs first; a running search is never dropped.
  for (const [id, j] of jobs) {
    if (jobs.size < MAX_JOBS) break;
    if (j.finishedAt !== null) jobs.delete(id);
  }
}

function startJob(scope: string, owner: string, key: string, run: () => Promise<JobAnswer>, now: number): { jobId: string; joined: boolean } {
  const running = runningJob(owner, key);
  if (running) return { jobId: running, joined: true };
  sweepExpired(now);
  if (jobs.size >= MAX_JOBS) sweep(now);
  const jobId = randomBytes(16).toString("hex");
  const job: Job = { owner, key, answer: null, finishedAt: null };
  jobs.set(jobId, job);
  void run()
    .catch((err: unknown) => {
      console.error(`[${scope}] background job failed:`, err);
      return { status: 500, body: null } as JobAnswer;
    })
    .then((answer) => {
      job.answer = answer;
      job.finishedAt = Date.now();
    });
  return { jobId, joined: false };
}

function runningJob(owner: string, key: string): string | null {
  for (const [id, j] of jobs) if (j.owner === owner && j.key === key && j.answer === null) return id;
  return null;
}

/**
 * Start `run` as a job for `owner` (the user id) under `key` (what is searched
 * — the route's own handle scope), or join the owner's running job for the
 * same key. `run` resolves to the answer the synchronous route would send; a
 * throw becomes a 500 answer (the route's own catch should have mapped it).
 */
export function startReleaseSearchJob(owner: string, key: string, run: () => Promise<JobAnswer>, now: number = Date.now()): { jobId: string; joined: boolean } {
  return startJob("release-search", owner, key, run, now);
}

/** The owner's job for `key` that is still running, if any — joining it costs no indexer hit. */
export function runningReleaseSearchJob(owner: string, key: string): string | null {
  return runningJob(owner, key);
}

/**
 * Any other long Radarr/Sonarr call as a job — startReleaseSearchJob's
 * contract, logged under its own scope. Keys share one map with the release
 * searches, so a caller prefixes its own (`provider-test\u0000…`).
 */
export function startArrJob(owner: string, key: string, run: () => Promise<JobAnswer>, now: number = Date.now()): { jobId: string; joined: boolean } {
  return startJob("arr-job", owner, key, run, now);
}

/** The owner's running job for `key`, if any — the same call again joins it. */
export function runningArrJob(owner: string, key: string): string | null {
  return runningJob(owner, key);
}

export type JobPoll = { state: "unknown" } | { state: "running" } | { state: "done"; answer: JobAnswer };

/** A job's state for its owner. Someone else's job id reads as unknown. */
export function pollReleaseSearchJob(owner: string, jobId: string, now: number = Date.now()): JobPoll {
  if (!JOB_RE.test(jobId)) return { state: "unknown" };
  sweepExpired(now);
  const j = jobs.get(jobId);
  if (!j || j.owner !== owner) return { state: "unknown" };
  if (j.answer === null) return { state: "running" };
  if (j.finishedAt !== null && now - j.finishedAt > RESULT_TTL_MS) {
    jobs.delete(jobId);
    return { state: "unknown" };
  }
  return { state: "done", answer: j.answer };
}

/**
 * The poll response: 202 { job, running } while it runs, the job's own answer
 * once done, 404 { error: t(goneMessageKey) } when the job is unknown
 * (expired, someone else's, or dropped by a restart) — the caller names the
 * message, so a provider test is never told "that search is no longer
 * available".
 */
export function jobResponse(owner: string, jobId: string, t: Translator, goneMessageKey: string): NextResponse {
  const poll = pollReleaseSearchJob(owner, jobId);
  if (poll.state === "unknown") return NextResponse.json({ error: t(goneMessageKey) }, { status: 404 });
  if (poll.state === "running") return NextResponse.json({ job: jobId, running: true }, { status: 202 });
  return NextResponse.json(poll.answer.body, { status: poll.answer.status });
}

/** jobResponse for a release search: gone is "search again". */
export function releaseSearchJobResponse(owner: string, jobId: string, t: Translator): NextResponse {
  return jobResponse(owner, jobId, t, "apiUser.requests.releases.jobGone");
}

/** A route's NextResponse as a job answer (status + parsed body). */
export async function answerOf(res: NextResponse): Promise<JobAnswer> {
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Test seams. */
export function _resetReleaseSearchJobsForTests(): void {
  jobs.clear();
}
export function _releaseSearchJobCountForTests(): number {
  return jobs.size;
}
