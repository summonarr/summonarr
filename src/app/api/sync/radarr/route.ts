import { NextRequest, NextResponse } from "next/server";
import { refreshArrCache } from "@/lib/arr-cache-refresh";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  return withCronRunRecording("radarr-sync", async () => {
    try {
      // Every configured Radarr instance (the default, the legacy 4K one and any
      // named ones); the shared refresh owns the fan-out, the lock and the
      // per-instance scoping (arr-cache-refresh.ts).
      const refresh = await refreshArrCache("radarr");
      if (refresh.outcome === "default-failed") {
        console.warn("[sync/radarr] skipping cache update — ARR fetch failed");
        // 502 (not 200) so withCronRunRecording marks this run failed — the cache
        // was NOT refreshed and pending badges may be stale. Unconfigured Radarr
        // returns empty sets, so null only fires on a real fetch failure.
        return NextResponse.json({ skipped: true, reason: "arr-unavailable" }, { status: 502 });
      }
      if (refresh.outcome === "write-failed") throw refresh.error;
      const { wanted, available, failedSlugs } = refresh;
      // A NAMED instance that failed kept its stale rows. Still 200 (the healthy
      // instances were refreshed), but degraded, so the run is not recorded green
      // (guardrail 36: a configured server that failed is red).
      if (failedSlugs.length > 0) {
        console.warn(`[sync/radarr] ${failedSlugs.length} instance(s) failed; their cache rows were left as they were`);
        return NextResponse.json(
          { wanted, available, failedInstances: failedSlugs },
          { headers: { "X-Cron-Degraded": failedSlugs.join(",") } },
        );
      }
      return NextResponse.json({ wanted, available });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/radarr] failed:", msg);
      return NextResponse.json({ error: t("apiAdmin.sync.radarrFailed") }, { status: 502 });
    }
  });
}
