import { randomUUID } from "node:crypto";

// In-memory registry for background fix-match runs (guardrail 37a). A remap
// waits on the media server for minutes — a Jellyfin series identify refreshes
// every season and episode before its ids become readable — which is longer
// than a reverse proxy keeps one HTTP request open, so the browser got a 502
// while the remap quietly succeeded. The route therefore starts the work here,
// answers immediately with a job id, and the client polls
// /api/admin/fix-match/status. Single long-lived process model (see the
// Deployment section of CLAUDE.md): nothing here survives a restart, and the
// status route answers 404 for a job it no longer knows.

export type FixMatchJobStatus = "running" | "done" | "failed";
export type FixMatchJobResult = { ok: true; warning?: string };

export type FixMatchJob = {
  id: string;
  key: string;
  status: FixMatchJobStatus;
  startedAt: number;
  finishedAt: number | null;
  result: FixMatchJobResult | null;
  // Client-safe message only — the route logs the real detail before throwing.
  error: string | null;
  // The HTTP status the synchronous path would have answered with (404/502).
  errorStatus: number | null;
};

// A failure the client may see verbatim. Anything else that escapes a runner
// is reported as the generic message, exactly like the synchronous path.
export class FixMatchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FixMatchError";
    this.status = status;
  }
}

export function fixMatchJobKey(input: {
  server: string; serverInstance: string; mediaType: string; tmdbId: number; correctTmdbId: number;
}): string {
  return `${input.server}:${input.serverInstance}:${input.mediaType}:${input.tmdbId}->${input.correctTmdbId}`;
}

// Finished jobs stay readable this long so a client that lost a poll (proxy
// blip, sleeping tab) can still collect the outcome; the cap bounds memory if
// a script hammers the route under the rate limit.
const FINISHED_JOB_TTL_MS = 60 * 60_000;
const MAX_JOBS = 500;

const jobs = new Map<string, FixMatchJob>();

function prune(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > FINISHED_JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size > MAX_JOBS) {
    // Oldest finished first; a running job is never evicted.
    const finished = [...jobs.values()]
      .filter((j) => j.finishedAt !== null)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const j of finished) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(j.id);
    }
  }
}

// Starts `run` detached and returns the job record immediately. A job with the
// same key that is still running is returned instead of started twice — a
// double-click or the Fix-all loop must never drive two concurrent remaps of
// one title.
export function startFixMatchJob(
  key: string,
  run: () => Promise<FixMatchJobResult>,
  now: number = Date.now(),
): FixMatchJob {
  prune(now);
  for (const job of jobs.values()) {
    if (job.key === key && job.status === "running") return job;
  }
  const job: FixMatchJob = {
    id: randomUUID(), key, status: "running", startedAt: now,
    finishedAt: null, result: null, error: null, errorStatus: null,
  };
  jobs.set(job.id, job);
  void Promise.resolve().then(run).then(
    (result) => {
      job.status = "done";
      job.result = result;
      job.finishedAt = Date.now();
    },
    (err: unknown) => {
      job.status = "failed";
      job.finishedAt = Date.now();
      if (err instanceof FixMatchError) {
        job.error = err.message;
        job.errorStatus = err.status;
      } else {
        console.error("[fix-match] background job failed with an unmapped error:", err instanceof Error ? err.message : err);
        job.error = "Fix-match operation failed";
        job.errorStatus = 502;
      }
    },
  );
  return job;
}

export function getFixMatchJob(id: string, now: number = Date.now()): FixMatchJob | null {
  prune(now);
  return jobs.get(id) ?? null;
}

// Test seam: the registry is module state.
export function _resetFixMatchJobsForTests(): void {
  jobs.clear();
}
