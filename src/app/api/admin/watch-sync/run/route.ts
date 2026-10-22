import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isFeatureEnabled } from "@/lib/features";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { withAdvisoryLock, WATCH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { WATCH_SYNC_FEATURE_KEY, runWatchSync } from "@/lib/watch-sync-data";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// "Run now" on the watch sync page (ADMIN). Always a BACKGROUND job (the 37a
// pattern through startArrJob): a first run reads a whole Plex history, which
// outlasts what a reverse proxy holds a request open. Same lock as the cron, so
// a click while the cron runs answers 409 in the job's result.
//   POST          → 202 { job }; the same admin asking again while theirs runs joins it.
//   GET ?job=<id> → 202 while running, then the run's own answer; 404 once gone.
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const JOB_KEY = "watch-sync-run";

export const GET = withAdmin(async (req, _ctx, session) => {
  const job = req.nextUrl.searchParams.get("job") ?? "";
  return jobResponse(session.user.id, job, translatorForRequest(req), "apiAdmin.watchSync.jobGone");
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const owner = session.user.id;
  const running = runningArrJob(owner, JOB_KEY);
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  if (!checkRateLimit(`watch-sync-run:${owner}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }
  const run = () => withAdvisoryLock(
    WATCH_SYNC_LOCK_ID,
    async (signal: AbortSignal) => NextResponse.json(await runWatchSync({ signal })),
    () => NextResponse.json(
      { ok: false, error: t("apiAdmin.watchSync.running"), retryAfter: 30 },
      { status: 409, headers: { "Retry-After": "30" } },
    ),
  );
  // Outlives the request — safe only because Summonarr is one long-lived Node
  // server (the guardrail 17/37a assumption); a restart drops it and the poll 404s.
  const { jobId } = startArrJob(owner, JOB_KEY, async () => answerOf(await run()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
