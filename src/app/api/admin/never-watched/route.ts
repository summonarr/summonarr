import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isFeatureEnabled } from "@/lib/features";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { NEVER_WATCHED_FEATURE_KEY } from "@/lib/never-watched-data";
import { parseNwQuery } from "@/lib/never-watched";
import { getNeverWatchedReport, selectReportRows } from "@/lib/never-watched-report";

// Never-watched report (ADMIN, guardrail 14d). Every library title — and every
// season of a watched show — nobody has watched in this server's recorded
// history, filtered, sorted and paged on the server. The whole-library report is
// cached briefly (see getNeverWatchedReport); `?fresh=1` recomputes it and
// re-lists Radarr/Sonarr. Read-only: deleting goes through
// /api/admin/cleanup/delete, whose dry run re-judges every title live.
export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.neverWatched.disabled") }, { status: 404 });
  }
  if (!checkRateLimit(`never-watched:${session.user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsShortly") }, { status: 429 });
  }
  const params = req.nextUrl.searchParams;
  const query = parseNwQuery(params);
  const report = await getNeverWatchedReport({ fresh: params.get("fresh") === "1" });
  const { rows, total } = selectReportRows(report, query);
  const { titles: _titles, seasons: _seasons, ...summary } = report;
  return NextResponse.json({ ...summary, query, rows, total });
});
