import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { WATCH_SYNC_FEATURE_KEY } from "@/lib/watch-sync-data";
import { parseWatchSyncDirection } from "@/lib/watch-sync";

// One watch sync pair (ADMIN).
//   PATCH { enabled?: boolean, direction?: "both"|"toJellyfin"|"toPlex", syncProgress?: boolean, rescan?: true }
//     — pause/resume, change direction, switch resume-point sync; `rescan` forgets BOTH read points so the
//     next run re-reads the whole Plex history and the whole Jellyfin played
//     list (titles that reached the other server since are then marked; items
//     already in a ledger are not re-queued).
//   DELETE — removes the pair and its ledgers. Nothing on either server is
//     unmarked (guardrail 19e: add-only).

export const PATCH = withAdmin(async (req, ctx: { params: Promise<{ id: string }> }, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const { id } = await ctx.params;
  const parsed = await readJsonCapped<{ enabled?: unknown; rescan?: unknown; direction?: unknown; syncProgress?: unknown }>(req, 1024);
  if (parsed instanceof NextResponse) return parsed;
  const { enabled, rescan, syncProgress } = parsed;
  const direction = parsed.direction === undefined ? undefined : parseWatchSyncDirection(parsed.direction);
  if (
    (enabled !== undefined && typeof enabled !== "boolean") ||
    (syncProgress !== undefined && typeof syncProgress !== "boolean") ||
    (rescan !== undefined && rescan !== true) ||
    direction === null ||
    (enabled === undefined && rescan === undefined && direction === undefined && syncProgress === undefined)
  ) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
  }
  // updateMany: a concurrent delete answers 404 rather than throwing P2025.
  const updated = await prisma.watchSyncPair.updateMany({
    where: { id },
    data: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(syncProgress !== undefined ? { syncProgress } : {}),
      ...(rescan ? { historyReadTo: null, jellyfinReadTo: null } : {}),
    },
  });
  if (updated.count === 0) return NextResponse.json({ error: t("apiAdmin.watchSync.pairNotFound") }, { status: 404 });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    ...auditContext(req, session),
    action: "SETTINGS_CHANGE",
    target: `watch-sync:${id}`,
    details: {
      change: "pair-update",
      ...(enabled !== undefined ? { enabled } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(syncProgress !== undefined ? { syncProgress } : {}),
      ...(rescan ? { rescan: true } : {}),
    },
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
