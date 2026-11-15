import { NextRequest, NextResponse } from "next/server";
import { getCronActor } from "@/lib/cron-auth";
import { cronSkippedResponse, withCronRunRecording } from "@/lib/cron-history";
import { withAdvisoryLock, SYNC_ORCHESTRATOR_LOCK_ID } from "@/lib/advisory-lock";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { runSyncOrchestrator } from "@/lib/sync-orchestrator";

// SYNC_ORCHESTRATOR_LOCK_ID (2000, advisory-lock.ts) — distinct from every other cron's id.
// An advisory lock is a Postgres-held named mutex. Held for the entire orchestrator run so a
// second concurrent invocation (admin "Resync" while the cron POST is mid-flight) returns
// immediately with skipped=true rather than racing the shared-state writes (notifiedAvailable
// CAS, library tables, MediaRequest status updates).

export async function POST(request: NextRequest) {
  const t = translatorForRequest(request);
  const actor = await getCronActor(request);
  if (!actor) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  return withCronRunRecording("sync:full", () => withAdvisoryLock(
    SYNC_ORCHESTRATOR_LOCK_ID,
    (signal: AbortSignal) => runSyncOrchestrator(actor, t, signal),
    // X-Cron-Skipped keeps a busy answer out of the sync:full ledger (no run
    // happened). Same 200 and body: internal-trigger reads `skipped: true`.
    () => cronSkippedResponse("sync already running"),
  ));
}
