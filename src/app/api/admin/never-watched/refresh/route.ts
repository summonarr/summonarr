import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isFeatureEnabled } from "@/lib/features";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { withAdvisoryLock, UPSTREAM_WATCH_LOCK_ID } from "@/lib/advisory-lock";
import { NEVER_WATCHED_FEATURE_KEY } from "@/lib/never-watched-data";
import { refreshUpstreamWatch } from "@/lib/upstream-watch-data";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";

// Re-read the media servers' own watch records now (ADMIN) — the never-watched
// page's "Refresh" for the evidence the daily refresh-upstream-watch cron
// collects (src/lib/upstream-watch-data.ts). Same advisory lock as the cron, so
// a click while the cron runs answers 409 instead of starting a second walk of
// every server's history beside it (guardrail 41). Read-only towards the media
// servers; the only writes are the evidence snapshot and its status rows.
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.neverWatched.disabled") }, { status: 404 });
  }
  // Each refresh walks every configured server's whole watch history (and every
  // Jellyfin user's played items) — a tight loop would hammer the media servers.
  if (!checkRateLimit(`never-watched-refresh:${session.user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }
  return withAdvisoryLock(
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
});
