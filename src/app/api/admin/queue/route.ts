import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { loadDownloadQueue } from "@/lib/arr-queue-data";

// Admin → Download Queue (ADMIN). Every configured Radarr and Sonarr instance's
// download queue, read live and paged (guardrail 32), one row per download — a
// Sonarr season pack's per-episode records fold into one row. Rows Radarr/Sonarr
// flag (warning/error status, blocked or failed import, client unavailable)
// come first with `attention: true`. An instance whose queue could not be read
// is named in `errors`; its downloads are absent, not finished. Nothing is
// written; the last answer is kept for display only (`?cached=1`,
// src/lib/arr-snapshot.ts) — every action re-reads live.
export const GET = withAdmin(snapshotted(async () => {
  return NextResponse.json(await loadDownloadQueue());
}));
