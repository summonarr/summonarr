import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { WATCH_SYNC_FEATURE_KEY } from "@/lib/watch-sync-data";

// One watch sync pair (ADMIN).
//   PATCH { enabled?: boolean, rescan?: true } — pause/resume; `rescan` forgets
//     the pair's history read point so the next run re-reads the WHOLE Plex
//     history (titles that reached Jellyfin since are then marked; items
//     already in the ledger are not re-queued).
//   DELETE — removes the pair and its ledger. Nothing in Jellyfin is unmarked
//     (guardrail 19e: add-only).

export const PATCH = withAdmin(async (req, ctx: { params: Promise<{ id: string }> }, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const { id } = await ctx.params;
  const parsed = await readJsonCapped<{ enabled?: unknown; rescan?: unknown }>(req, 1024);
  if (parsed instanceof NextResponse) return parsed;
  const { enabled, rescan } = parsed;
  if ((enabled !== undefined && typeof enabled !== "boolean") || (rescan !== undefined && rescan !== true) || (enabled === undefined && rescan === undefined)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
  }
  // updateMany: a concurrent delete answers 404 rather than throwing P2025.
  const updated = await prisma.watchSyncPair.updateMany({
    where: { id },
    data: { ...(enabled !== undefined ? { enabled } : {}), ...(rescan ? { historyReadTo: null } : {}) },
  });
  if (updated.count === 0) return NextResponse.json({ error: t("apiAdmin.watchSync.pairNotFound") }, { status: 404 });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    ...auditContext(req, session),
    action: "SETTINGS_CHANGE",
    target: `watch-sync:${id}`,
    details: { change: "pair-update", ...(enabled !== undefined ? { enabled } : {}), ...(rescan ? { rescan: true } : {}) },
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withAdmin(async (req, ctx: { params: Promise<{ id: string }> }, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const { id } = await ctx.params;
  // The ledger goes with it (onDelete: Cascade).
  const deleted = await prisma.watchSyncPair.deleteMany({ where: { id } });
  if (deleted.count === 0) return NextResponse.json({ error: t("apiAdmin.watchSync.pairNotFound") }, { status: 404 });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    ...auditContext(req, session),
    action: "SETTINGS_CHANGE",
    target: `watch-sync:${id}`,
    details: { change: "pair-delete" },
  });
  return NextResponse.json({ ok: true });
});
