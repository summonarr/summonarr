import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, withCronRunRecording, cronSkippedResponse } from "@/lib/cron-auth";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { syncDownloadPolicies } from "@/lib/download-policy";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("download-policies", () => withAdvisoryLock(
    2009,
    async () => {
      const startTime = Date.now();
      const results = await syncDownloadPolicies();
      const durationMs = Date.now() - startTime;

      const totals = results.reduce(
        (acc, r) => ({
          upserted: acc.upserted + r.upserted,
          enforced: acc.enforced + r.enforced,
          errors: acc.errors + r.errors,
        }),
        { upserted: 0, enforced: 0, errors: 0 },
      );

      // Status stays 200 on a partial failure; X-Cron-Degraded marks the run
      // failed in the ledger (withCronRunRecording), and `error` (singular) is
      // the field the admin Run-now badge surfaces — `errors` (the count) alone
      // rendered as a bare "HTTP 500" where every sibling names the failure.
      const ok = totals.errors === 0;
      return NextResponse.json({
        ok,
        durationMs,
        ...totals,
        ...(ok ? {} : { error: `${totals.errors} download-policy error(s)` }),
        sources: results.map((r) => r.source),
        timestamp: new Date().toISOString(),
      }, ok ? undefined : { headers: { "X-Cron-Degraded": String(totals.errors) } });
    },
    () => cronSkippedResponse(),
  ));
}
