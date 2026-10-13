import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCappedOr } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { withAdvisoryLock, LIBRARY_MATCH_CHECK_LOCK_ID } from "@/lib/advisory-lock";
import { readLibraryMatchReport, runLibraryMatchCheck } from "@/lib/library-match-data";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// The library match check (ADMIN): every Plex/Jellyfin item — every copy and
// every unmatched one — judged against the folder Radarr/Sonarr say it is in
// (src/lib/library-match.ts). Read-only towards every server; the one write is
// the stored report the Admin → Library page paints.
//
//   GET                    → { report } — the last stored report, or null.
//   GET ?job=<id>          → 202 { job, running } while a background check runs,
//                            then its answer; 404 once the job is gone.
//   POST {}                → the check, answered when it finishes (API callers).
//   POST { async: true }   → 202 { job } at once (the guardrail-37a pattern,
//                            through startArrJob): a whole Plex + Jellyfin
//                            listing plus every Radarr/Sonarr title outlasts a
//                            reverse proxy's hold. The same admin asking again
//                            while theirs runs joins it — no rate token spent.
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const JOB_KEY = "library-match-check";

export const GET = withAdmin(async (req, _ctx, session) => {
  const job = req.nextUrl.searchParams.get("job");
  if (job !== null) return jobResponse(session.user.id, job, translatorForRequest(req), "apiAdmin.libraryMatch.jobGone");
  return NextResponse.json({ report: await readLibraryMatchReport() });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCappedOr<unknown>(req, 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const background = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { async?: unknown }).async === true
    : false;
  const owner = session.user.id;
  const running = background ? runningArrJob(owner, JOB_KEY) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  if (!checkRateLimit(`library-match-check:${owner}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }
  const run = () => withAdvisoryLock(
    LIBRARY_MATCH_CHECK_LOCK_ID,
    async (signal: AbortSignal) => {
      const report = await runLibraryMatchCheck({ signal });
      if (!report) return NextResponse.json({ ok: false, aborted: true });
      return NextResponse.json({
        ok: true,
        checkedAt: report.checkedAt,
        counts: report.counts,
        sources: report.sources,
        truncated: report.truncated,
      });
    },
    () => NextResponse.json(
      { ok: false, error: t("apiAdmin.libraryMatch.running"), retryAfter: 30 },
      { status: 409, headers: { "Retry-After": "30" } },
    ),
  );
  if (!background) return run();
  // Outlives the request — safe only because Summonarr is one long-lived Node
  // server (the guardrail 17/37a assumption); a restart drops it and the poll 404s.
  const { jobId } = startArrJob(owner, JOB_KEY, async () => answerOf(await run()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
