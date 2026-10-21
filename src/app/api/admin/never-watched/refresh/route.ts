import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isFeatureEnabled } from "@/lib/features";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCappedOr } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { withAdvisoryLock, UPSTREAM_WATCH_LOCK_ID } from "@/lib/advisory-lock";
import { NEVER_WATCHED_FEATURE_KEY } from "@/lib/never-watched-data";
import { refreshUpstreamWatch } from "@/lib/upstream-watch-data";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// Re-read the media servers' own watch records now (ADMIN) — the never-watched
// page's "Refresh" for the evidence the daily refresh-upstream-watch cron
// collects (src/lib/upstream-watch-data.ts). Same advisory lock as the cron, so
// a click while the cron runs answers 409 instead of starting a second walk of
// every server's history beside it (guardrail 41). Read-only towards the media
// servers; the only writes are the evidence snapshot and its status rows.
//
//   POST {}                → the walk, answered when it finishes (API callers).
//   POST { async: true }   → 202 { job } at once; the walk runs in the
//                            background (the guardrail-37a pattern, through the
//                            generic startArrJob registry). A whole Plex history
//                            plus every Jellyfin user's played items outlasts
//                            what a reverse proxy holds a request open (~60–100 s):
//                            held, the browser saw a 502 while the walk went on to
//                            write the snapshot. The same admin asking again while
//                            theirs runs JOINS it — no second walk, no rate token.
//   GET ?job=<id>          → 202 { job, running } while it runs, then the walk's
//                            own answer (status + body), 404 once the job is gone
//                            (expired, another admin's, or dropped by a restart).
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const JOB_KEY = "never-watched-refresh";

export const GET = withAdmin(async (req, _ctx, session) => {
  const job = req.nextUrl.searchParams.get("job") ?? "";
  return jobResponse(session.user.id, job, translatorForRequest(req), "apiAdmin.neverWatched.refreshJobGone");
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.neverWatched.disabled") }, { status: 404 });
  }
  // No body (the original contract) is the synchronous walk.
  const parsed = await readJsonCappedOr<unknown>(req, 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const background = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { async?: unknown }).async === true
    : false;
  const owner = session.user.id;
  // Joining the admin's own running walk reaches no media server: no token.
  const running = background ? runningArrJob(owner, JOB_KEY) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  // Each refresh walks every configured server's whole watch history (and every
  // Jellyfin user's played items) — a tight loop would hammer the media servers.
  if (!checkRateLimit(`never-watched-refresh:${owner}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }
  const run = () => withAdvisoryLock(
    UPSTREAM_WATCH_LOCK_ID,
    async (signal: AbortSignal) => {
      const result = await refreshUpstreamWatch({ signal });
      // New evidence changes verdicts; the cached report must not outlive it.
      invalidateNeverWatchedReport();
      return NextResponse.json(result);
    },
    () => NextResponse.json(
      { ok: false, error: t("apiAdmin.neverWatched.refreshRunning"), retryAfter: 30 },
      { status: 409, headers: { "Retry-After": "30" } },
    ),
  );
  if (!background) return run();
  // Outlives the request — safe only because Summonarr is one long-lived Node
  // server (the guardrail 17/37a assumption); a restart drops it and the poll 404s.
  const { jobId } = startArrJob(owner, JOB_KEY, async () => answerOf(await run()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
