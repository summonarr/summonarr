import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isFeatureEnabled } from "@/lib/features";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { withAdvisoryLock, WATCH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import { readOptionalJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { WATCH_SYNC_FEATURE_KEY, runWatchSync } from "@/lib/watch-sync-data";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// "Run now" on the watch sync page (ADMIN). Always a BACKGROUND job (the 37a
// pattern through startArrJob): a first run reads a whole Plex history, which
// outlasts what a reverse proxy holds a request open. Same lock as the cron, so
// a click while the cron runs answers 409 in the job's result.
//   POST          → 202 { job }; the same admin asking again while theirs runs joins it.
//   POST { pairId, full: true } → a FULL sync of that one pair, for moving a user
//     between platforms: forgets both read points, switches the pair's resume-point
//     sync on, then reads the whole history AND every partial watch on both sides
//     and applies until the queue is drained (or the run's budget ends; the next
//     run continues). Add-only like every run (guardrail 19e).
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
  const body = await readOptionalJsonCapped<{ pairId?: unknown; full?: unknown }>(req, 1024, {});
  if (body instanceof NextResponse) return body;
  const full = body.full === true;
  const pairId = typeof body.pairId === "string" && body.pairId.length > 0 && body.pairId.length <= 64 ? body.pairId : null;
  if ((body.full !== undefined && typeof body.full !== "boolean") || (body.pairId !== undefined && pairId === null) || (full && !pairId)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
  }
  const owner = session.user.id;
  const jobKey = full && pairId ? `${JOB_KEY}:full:${pairId}` : JOB_KEY;
  const running = runningArrJob(owner, jobKey);
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  if (!checkRateLimit(`watch-sync-run:${owner}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return tooManyRequests(RATE_WINDOW_MS / 1000, t("apiAdmin.common.tooManyRequestsLater"));
  }
  if (full && pairId) {
    // Checked before a job is started; the pair itself is changed only under the
    // lock (below), so a click that loses the lock to a running sync changes nothing.
    const pair = await prisma.watchSyncPair.findUnique({ where: { id: pairId }, select: { enabled: true } });
    if (!pair) return NextResponse.json({ error: t("apiAdmin.watchSync.pairNotFound") }, { status: 404 });
    if (!pair.enabled) return NextResponse.json({ error: t("apiAdmin.watchSync.pairPaused") }, { status: 409 });
  }
  const actor = { userId: session.user.id, userName: session.user.name ?? session.user.email, ...auditContext(req, session) };
  const run = () => withAdvisoryLock(
    WATCH_SYNC_LOCK_ID,
    async (signal: AbortSignal) => {
      if (!(full && pairId)) return NextResponse.json(await runWatchSync({ signal }));
      // Under the lock: no run is mid-pair, so nothing writes a newer read point
      // over the reset, and a refused click (409 below) leaves the pair as it was.
      const updated = await prisma.watchSyncPair.updateMany({
        where: { id: pairId, enabled: true },
        data: { syncProgress: true, historyReadTo: null, jellyfinReadTo: null },
      });
      if (updated.count === 0) return NextResponse.json({ error: t("apiAdmin.watchSync.pairNotFound") }, { status: 404 });
      void logAudit({
        ...actor,
        action: "SETTINGS_CHANGE",
        target: `watch-sync:${pairId}`,
        details: { change: "pair-full-sync", rescan: true, syncProgress: true },
      });
      return NextResponse.json(await runWatchSync({ signal, pairIds: [pairId], full: true }));
    },
    () => NextResponse.json(
      { ok: false, error: t("apiAdmin.watchSync.running"), retryAfter: 30 },
      { status: 409, headers: { "Retry-After": "30" } },
    ),
  );
  // Outlives the request — safe only because Summonarr is one long-lived Node
  // server (the guardrail 17/37a assumption); a restart drops it and the poll 404s.
  const { jobId } = startArrJob(owner, jobKey, async () => answerOf(await run()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
