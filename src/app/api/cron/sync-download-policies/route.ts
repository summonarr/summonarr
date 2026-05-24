import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
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

      // Non-2xx on errors so withCronRunRecording marks ok=false.
      const status = totals.errors > 0 ? 500 : 200;
      return NextResponse.json({
        ok: totals.errors === 0,
        durationMs,
        ...totals,
        sources: results.map((r) => r.source),
        timestamp: new Date().toISOString(),
      }, { status });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
