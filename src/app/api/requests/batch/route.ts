import { NextResponse } from "next/server";
import { withPermission, type SummonarrSession } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { arrErrorMessageForClient } from "@/lib/arr";
import { sanitizeOptional } from "@/lib/sanitize";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import type { Translator } from "@/lib/i18n/translate";
import {
  announceStatus,
  claimPendingBatch,
  followUpDecidedApprovals,
  notifyDecided,
  pushApprovals,
} from "@/lib/request-transition";
import { REQUEST_BATCH_MAX_IDS, REQUEST_BATCH_MAX_PERMANENT } from "@/lib/api-body-limits";

// Ids per batch, and the tighter cap on a PERMANENT decline: permanent declines
// are terminal (they block re-requests), so one click can't blast a hundred
// users' requests into that state.
const MAX_BATCH_IDS = REQUEST_BATCH_MAX_IDS;
const MAX_PERMANENT_DECLINES = REQUEST_BATCH_MAX_PERMANENT;

// The decision this call makes on every listed PENDING request.
interface BatchDecision {
  ids: string[];
  status: "APPROVED" | "DECLINED";
  // undefined: no note sent, every row keeps its own.
  adminNote: string | null | undefined;
  // Only ever true on a decline.
  permanent: boolean;
}

// What an approval batch reports beside `ok`: each definite push failure (the
// queue keeps those rows selected for another try), and each add that got no
// definite answer and stays APPROVED.
interface ApprovalReport {
  failures: { id: string; title: string; error: string }[];
  rolledBackIds: string[];
  // A definite failure whose rollback did not land (the row moved on, or the
  // write failed): reported as failed, but it is not PENDING.
  rollbackMissedIds: string[];
  outcomeUnknownIds: string[];
}

const NO_APPROVALS: ApprovalReport = { failures: [], rolledBackIds: [], rollbackMissedIds: [], outcomeUnknownIds: [] };

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiUser.requests.batch.rateLimited") }, { status: 429 });
  }

  const raw = await readJsonCapped<Record<string, unknown>>(req, 1048576);
  if (raw instanceof NextResponse) return raw;
  const decision = parseBatchDecision(raw, t);
  if (decision instanceof NextResponse) return decision;

  // Claims only the rows still PENDING, in one statement (claimPendingBatch):
  // every side effect below keys off what THIS call moved — never an id that
  // was already decided, or claimed by a concurrent batch.
  const claimed = await claimPendingBatch(decision.ids, decision.status, { adminNote: decision.adminNote, permanent: decision.permanent });
  for (const row of claimed) announceStatus(row, decision.status);
  const claimedIds = claimed.map((r) => r.id);

  let report = NO_APPROVALS;
  if (decision.status === "APPROVED") report = await approveClaimed(claimedIds, session, t);
  else await notifyDeclined(claimedIds, session);

  auditBatch(req, session, decision, claimedIds, report);

  // Additive: `failed` lists every row whose push definitely failed; `arrError`
  // is the one-line summary the single-request PATCH returns under the same
  // name, which the group Approve button renders as-is. `outcomeUnknown` lists
  // the ids whose add got no answer and that stay APPROVED (never in `failed`,
  // which the queue keeps selected for retry). Each is omitted when empty, so a
  // clean batch reads `{ ok: true }` as before.
  return NextResponse.json({
    ok: true,
    ...(report.failures.length > 0 ? { failed: report.failures, arrError: summarizeArrFailures(report.failures, t) } : {}),
    ...(report.outcomeUnknownIds.length > 0 ? { outcomeUnknown: report.outcomeUnknownIds } : {}),
  });
});

// The body, narrowed field by field: readJsonCapped proves only that it is a
// JSON object.
function parseBatchDecision(raw: Record<string, unknown>, t: Translator): BatchDecision | NextResponse {
  const { ids, status, adminNote, permanent } = raw;
  const bad = (key: string) => NextResponse.json({ error: t(key) }, { status: 400 });
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_IDS) return bad("apiUser.requests.batch.idsInvalid");
  if (!ids.every((id): id is string => typeof id === "string")) return bad("apiUser.requests.batch.idsStrings");
  if (status !== "APPROVED" && status !== "DECLINED") return bad("apiUser.requests.batch.statusInvalid");
  if (adminNote !== undefined && (typeof adminNote !== "string" || adminNote.length > ADMIN_NOTE_MAX)) return bad("apiUser.common.adminNoteTooLong");
  if (permanent !== undefined && typeof permanent !== "boolean") return bad("apiUser.requests.batch.permanentBoolean");

  const isPermanent = permanent === true && status === "DECLINED";
  if (isPermanent && ids.length > MAX_PERMANENT_DECLINES) {
    return NextResponse.json(
      // Human text in `error` like every sibling 400 (both web callers render
      // `data.error` verbatim); the machine token rides under `code`.
      { error: t("apiUser.requests.batch.permanentTooMany"), code: "permanent-batch-too-large" },
      { status: 400 },
    );
  }
  return {
    ids,
    status,
    // An absent note leaves every stored one; sanitizeOptional maps "" to null.
    adminNote: adminNote === undefined ? undefined : sanitizeOptional(adminNote),
    permanent: isPermanent,
  };
}

// Push the claimed approvals (bounded) through the shared state machine, then
// ONE batched download check for the rows that kept their backstop — a 100-id
// batch would otherwise fill the whole delayed-job run queue — and "approved"
// to the requesters whose approval stands (not the acting admin's own rows).
async function approveClaimed(claimedIds: string[], session: SummonarrSession, t: Translator): Promise<ApprovalReport> {
  // The full rows for just the ids THIS call claimed and that are still
  // APPROVED, so an already-approved row is never re-pushed.
  const approved = await prisma.mediaRequest.findMany({ where: { id: { in: claimedIds }, status: "APPROVED" } });
  const settled = await pushApprovals(approved, "Batch approve");
  followUpDecidedApprovals(settled, { actorId: session.user.id, checkName: "requests/batch:90s-download-check", logScope: "requests/batch" });

  const report: ApprovalReport = { failures: [], rolledBackIds: [], rollbackMissedIds: [], outcomeUnknownIds: [] };
  // In `approved` order, not completion order, so the reported list is stable.
  for (const { row, outcome } of settled) {
    if (outcome.kind === "unknown") report.outcomeUnknownIds.push(row.id);
    if (outcome.kind !== "rolled-back" && outcome.kind !== "failed") continue;
    (outcome.kind === "rolled-back" ? report.rolledBackIds : report.rollbackMissedIds).push(row.id);
    // The kind, never the arr's internal URL: the caller may be a delegate (guardrail 5g).
    report.failures.push({ id: row.id, title: row.title, error: arrErrorMessageForClient(outcome.error, t) });
  }
  return report;
}

// Tell each declined request's owner, with the note as the decline left it —
// the one this call wrote, else the one already stored — exactly what the single
// decline sends. Only rows this call moved, and never the acting admin's own.
async function notifyDeclined(claimedIds: string[], session: SummonarrSession): Promise<void> {
  const declined = await prisma.mediaRequest.findMany({
    where: { id: { in: claimedIds }, status: "DECLINED" },
    select: { id: true, requestedBy: true, title: true, mediaType: true, tmdbId: true, posterPath: true, arrInstance: true, adminNote: true },
  });
  void notifyDecided("DECLINED", declined, session.user.id, "requests/batch");
}

// Permanent declines get their own audit action so they're trivially queryable;
// the (capped) id list is kept in full so the trail is reproducible, beside what
// actually happened: `claimedIds` are the rows THIS call moved off PENDING (an id
// already non-PENDING, or claimed by a concurrent batch, is not among them),
// `rolledBackIds` the approvals whose push failed and went back to PENDING, and
// `transitioned` the rows left in the batch's target status. Request ids only —
// batch rows name no requester (guardrail 33). Post-commit: the swallowing
// variant (guardrail 26).
function auditBatch(req: Request, session: SummonarrSession, decision: BatchDecision, claimedIds: string[], report: ApprovalReport): void {
  const action =
    decision.status === "APPROVED" ? "REQUEST_APPROVE" : decision.permanent ? "BATCH_REQUEST_DECLINE" : "REQUEST_DECLINE";
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action,
    target: `batch:${decision.ids.length}`,
    details: {
      batch: true,
      count: decision.ids.length,
      ids: decision.ids,
      claimedIds,
      rolledBackIds: report.rolledBackIds,
      ...(report.rollbackMissedIds.length > 0 ? { rollbackMissedIds: report.rollbackMissedIds } : {}),
      ...(report.outcomeUnknownIds.length > 0 ? { outcomeUnknownIds: report.outcomeUnknownIds } : {}),
      transitioned: claimedIds.length - report.rolledBackIds.length,
      adminNote: decision.adminNote ?? null,
      permanent: decision.permanent,
    },
    ...auditContext(req, session),
  });
}

// Names the first few failures with their reasons and counts the rest, so a
// 100-row batch can't produce an unbounded message.
function summarizeArrFailures(failures: { title: string; error: string }[], t: Translator): string {
  const SHOWN = 3;
  const list = failures.slice(0, SHOWN).map((f) => `"${f.title}": ${f.error}`).join("; ");
  const count = failures.length;
  return count > SHOWN
    ? t("apiUser.requests.batch.arrFailedMore", { count, list, more: count - SHOWN })
    : t("apiUser.requests.batch.arrFailed", { count, list });
}
