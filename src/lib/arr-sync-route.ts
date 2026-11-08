// The body of POST /api/sync/radarr and /api/sync/sonarr — one copy for both
// services (the routes keep their own auth gate, which the route audit reads
// per file). The refresh itself is arr-cache-refresh.ts's, shared with the
// orchestrator.
import { NextResponse } from "next/server";
import { refreshArrCache } from "@/lib/arr-cache-refresh";
import { CRON_DEGRADED_HEADER } from "@/lib/cron-history";
import type { ArrService } from "@/lib/arr-instances";
import type { Translator } from "@/lib/i18n/translate";

/** Refresh every configured instance of `service` and answer the cron run. */
export async function arrCacheSyncResponse(service: ArrService, t: Translator): Promise<NextResponse> {
  const scope = `sync/${service}`;
  try {
    // Every configured instance (the default, the legacy 4K one and any named
    // ones); the shared refresh owns the fan-out, the lock and the per-instance
    // scoping.
    const refresh = await refreshArrCache(service);
    if (refresh.outcome === "default-failed") {
      console.warn(`[${scope}] skipping cache update — ARR fetch failed`);
      // 502 (not 200) so withCronRunRecording marks this run failed — the cache
      // was NOT refreshed and pending badges may be stale. An unconfigured
      // service returns empty sets, so this only fires on a real fetch failure.
      return NextResponse.json({ skipped: true, reason: "arr-unavailable" }, { status: 502 });
    }
    if (refresh.outcome === "write-failed") throw refresh.error;
    const { wanted, available, failedSlugs } = refresh;
    // A NAMED instance that failed kept its stale rows. Still 200 (the healthy
    // instances were refreshed), but degraded, so the run is not recorded green
    // (guardrail 36: a configured server that failed is red).
    if (failedSlugs.length > 0) {
      console.warn(`[${scope}] ${failedSlugs.length} instance(s) failed; their cache rows were left as they were`);
      return NextResponse.json(
        { wanted, available, failedInstances: failedSlugs },
        { headers: { [CRON_DEGRADED_HEADER]: failedSlugs.join(",") } },
      );
    }
    return NextResponse.json({ wanted, available });
  } catch (err) {
    console.error(`[${scope}] failed:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: service === "radarr" ? t("apiAdmin.sync.radarrFailed") : t("apiAdmin.sync.sonarrFailed") },
      { status: 502 },
    );
  }
}
