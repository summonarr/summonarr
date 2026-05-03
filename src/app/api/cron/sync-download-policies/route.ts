import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, recordCronRun } from "@/lib/cron-auth";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { syncDownloadPolicies } from "@/lib/download-policy";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2009,
    async () => {
      const startTime = Date.now();
      const results = await syncDownloadPolicies();
      const durationMs = Date.now() - startTime;

      await recordCronRun("download-policies", durationMs);

      const totals = results.reduce(
        (acc, r) => ({
          upserted: acc.upserted + r.upserted,
          enforced: acc.enforced + r.enforced,
          errors: acc.errors + r.errors,
        }),
        { upserted: 0, enforced: 0, errors: 0 },
      );

      return NextResponse.json({
        ok: true,
        durationMs,
        ...totals,
        sources: results.map((r) => r.source),
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
