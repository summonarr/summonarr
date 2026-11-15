import { NextResponse } from "next/server";
import { refundHit, reserveRateLimit } from "@/lib/rate-limit";
import { answerOf, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// The shared tail of an admin action that takes an advisory lock and may run
// as a background job (guardrail 37a): join the admin's own running job without
// spending a rate token, spend one otherwise, run, and start the job when the
// caller asked for `async`. `run` answers 409 itself when the lock is busy; that
// refusal did no work, so the token it spent is handed back — retrying a busy
// check must not lock the admin out.

export interface LockedAdminJob {
  owner: string;
  /** Names the job in the per-admin registry. */
  jobKey: string;
  rateKey: string;
  limit: number;
  windowMs: number;
  /** `{ async: true }` was sent: answer 202 + job id and run in the background. */
  background: boolean;
  /** The translated 429 message. */
  tooManyMessage: string;
  run: () => NextResponse | Promise<NextResponse>;
}

/** Whether a request body asked for the background form. */
export function wantsBackgroundJob(body: unknown): boolean {
  return body !== null && typeof body === "object" && !Array.isArray(body) && (body as { async?: unknown }).async === true;
}

export async function runLockedAdminJob(job: LockedAdminJob): Promise<NextResponse> {
  const running = job.background ? runningArrJob(job.owner, job.jobKey) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  const hitAt = reserveRateLimit(job.rateKey, job.limit, job.windowMs);
  if (hitAt === null) return NextResponse.json({ error: job.tooManyMessage }, { status: 429 });
  const run = async () => {
    const res = await job.run();
    if (res.status === 409) refundHit(job.rateKey, hitAt);
    return res;
  };
  if (!job.background) return run();
  // Outlives the request — safe only because Summonarr is one long-lived Node
  // server (the guardrail 17/37a assumption); a restart drops it and the poll 404s.
  const { jobId } = startArrJob(job.owner, job.jobKey, async () => answerOf(await run()));
  return NextResponse.json({ job: jobId }, { status: 202 });
}
