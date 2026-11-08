import type { RequestStatus } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, arrErrorMessage, arrWriteOutcomeUnknown, type AddProgress } from "@/lib/arr";
import { emitSSE } from "@/lib/sse-emitter";
import { DOWNLOAD_CHECK_DELAY_MS, scheduleDownloadChecks, type DownloadCheckTarget } from "@/lib/download-check";
import { notifyRequestStatusChanges } from "@/lib/request-notifications";
import { requesterAuditDetails } from "@/lib/audit-scrub";
import { mapLimit } from "@/lib/concurrency";
import { sanitizeForLog } from "@/lib/sanitize";

// THE request decision state machine. Every path that DECIDES a request — the
// single PATCH (/api/requests/[id]), the batch PATCH and the Discord admin
// buttons — claims it here, and every path that sends an approved request to
// Radarr/Sonarr — those three plus auto-approve at creation (request-create.ts)
// and in bulk (request-bulk.ts) — pushes it here. Each path used to carry its own
// copy and they disagreed: one announced PENDING for a rollback that never
// landed, one let a failed rollback write escape, one queued the download check
// for a rolled-back row.
//
//   claim  a compare-and-swap on the status the caller read, so two admins
//          deciding at once can't both win. Approval stamps approvedAt and arms
//          the 90s backstop; decline clears approvedAt (guardrail 34a).
//   push   to the request's OWN instance (guardrail 32), then settled as one of:
//            pushed       the approval stands
//            unknown      the add was sent and got no definite answer (a timeout,
//                         a dropped connection, a gateway 502/504): the arr may
//                         hold it, so the approval stands; the sync re-pushes an
//                         APPROVED title the arr doesn't hold
//            rolled-back  a definite failure: back to PENDING with the backstop
//                         cleared, approvedAt KEPT (the approval was made, only
//                         the push failed — guardrail 34a), PENDING announced
//            failed       a definite failure whose rollback did not land: the row
//                         moved on (a webhook marked it AVAILABLE, an admin
//                         declined or deleted it) or the write failed. It is not
//                         PENDING, so nothing announces it as PENDING
//   follow up  the 90s download check for every row that kept its armed backstop
//          (all but rolled-back); "approved" told to the requester only while
//          the approval stands, and never to an admin deciding their own request.
//          The notifications are notifyRequestStatusChanges' (guardrail 14c).

// Concurrent Radarr/Sonarr adds per decision (guardrail 31): a 100-row batch
// approve or a 50-item bulk request never bursts every add at once.
export const APPROVAL_PUSH_CONCURRENCY = 5;

const DECIDED_STATUSES = ["APPROVED", "DECLINED", "AVAILABLE", "PENDING"] as const satisfies readonly RequestStatus[];

// The transitions an admin may make by hand. Every target differs from its
// source, so a transition is never a no-op.
const ALLOWED_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  PENDING: ["APPROVED", "DECLINED"],
  APPROVED: ["AVAILABLE", "DECLINED"],
  DECLINED: ["PENDING", "APPROVED"],
  AVAILABLE: [],
};

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && (DECIDED_STATUSES as readonly string[]).includes(value);
}

export const REQUEST_STATUSES: readonly RequestStatus[] = DECIDED_STATUSES;

export function isAllowedTransition(from: RequestStatus, to: RequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ── claims ───────────────────────────────────────────────────────────────────

// What a decision writes besides the status. `adminNote` undefined means the
// decision sent no note and the stored one stays; null clears it.
export interface DecisionWrite {
  adminNote?: string | null;
}

function noteData(adminNote: string | null | undefined): { adminNote?: string | null } {
  return adminNote === undefined ? {} : { adminNote };
}

// The 90s download-check deadline every approval arms (download-check.ts).
function backstopDeadline(): Date {
  return new Date(Date.now() + DOWNLOAD_CHECK_DELAY_MS);
}

/**
 * Approve one request still in `from`. Clears a prior decline's
 * permanentlyDeclined (else re-requests stay blocked) and records an admin's
 * quality-profile choice, so a later Re-push, the sync's re-push and a
 * re-approval use the profile the admin picked rather than the requester's.
 * False when the row moved on since it was read.
 */
export async function claimApproval(
  id: string,
  from: RequestStatus,
  opts: DecisionWrite & { qualityProfileId?: number } = {},
): Promise<boolean> {
  const claimed = await prisma.mediaRequest.updateMany({
    where: { id, status: from },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      permanentlyDeclined: false,
      ...noteData(opts.adminNote),
      ...(opts.qualityProfileId !== undefined ? { qualityProfileId: opts.qualityProfileId } : {}),
      pendingNotifyAt: backstopDeadline(),
    },
  });
  return claimed.count > 0;
}

/**
 * Decline one request still in `from`. Withdraws any approval — including one
 * whose push failed and rolled back to PENDING — and disarms the backstop.
 */
export async function claimDecline(
  id: string,
  from: RequestStatus,
  opts: DecisionWrite & { permanent?: boolean } = {},
): Promise<boolean> {
  const claimed = await prisma.mediaRequest.updateMany({
    where: { id, status: from },
    data: {
      status: "DECLINED",
      approvedAt: null,
      permanentlyDeclined: opts.permanent === true,
      ...noteData(opts.adminNote),
      pendingNotifyAt: null,
    },
  });
  return claimed.count > 0;
}

/**
 * Approve or decline every listed request still PENDING, in ONE
 * `UPDATE … WHERE id IN (…) AND status = 'PENDING' RETURNING`. Postgres
 * re-evaluates the status per row once it holds the row lock, so the returned
 * rows are exactly the ones THIS call moved: a concurrent batch on the same ids
 * gets them back in its result set, never both. Every side effect keys off the
 * returned rows, and `requestedBy` comes back with them for the announcement.
 */
export function claimPendingBatch(
  ids: string[],
  decision: "APPROVED" | "DECLINED",
  opts: DecisionWrite & { permanent?: boolean } = {},
): Promise<Array<{ id: string; requestedBy: string }>> {
  const where = { id: { in: ids }, status: "PENDING" as const };
  const select = { id: true, requestedBy: true } as const;
  if (decision === "APPROVED") {
    return prisma.mediaRequest.updateManyAndReturn({
      where,
      select,
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        permanentlyDeclined: false,
        ...noteData(opts.adminNote),
        pendingNotifyAt: backstopDeadline(),
      },
    });
  }
  return prisma.mediaRequest.updateManyAndReturn({
    where,
    select,
    data: {
      status: "DECLINED",
      approvedAt: null,
      permanentlyDeclined: opts.permanent === true,
      ...noteData(opts.adminNote),
      pendingNotifyAt: null,
    },
  });
}

/**
 * Mark an APPROVED request AVAILABLE by hand. The approval is kept; the
 * backstop is disarmed and the first availability is timestamped
 * (`stampAvailableAt` when the row has none yet).
 */
export async function claimMarkAvailable(
  id: string,
  from: RequestStatus,
  opts: DecisionWrite & { stampAvailableAt: boolean },
): Promise<boolean> {
  const claimed = await prisma.mediaRequest.updateMany({
    where: { id, status: from },
    data: {
      status: "AVAILABLE",
      ...noteData(opts.adminNote),
      pendingNotifyAt: null,
      ...(opts.stampAvailableAt ? { availableAt: new Date() } : {}),
    },
  });
  return claimed.count > 0;
}

/**
 * Reopen a DECLINED request to PENDING. Clears the sticky permanentlyDeclined,
 * or the row would read PENDING while its owner stays blocked from re-requesting.
 */
export async function claimReopen(id: string, from: RequestStatus, opts: DecisionWrite = {}): Promise<boolean> {
  const claimed = await prisma.mediaRequest.updateMany({
    where: { id, status: from },
    data: {
      status: "PENDING",
      permanentlyDeclined: false,
      ...noteData(opts.adminNote),
    },
  });
  return claimed.count > 0;
}

// The live request lists (admin queue, browse pages) follow every move.
export function announceStatus(row: { id: string; requestedBy: string }, status: RequestStatus): void {
  emitSSE({ type: "request:updated", requestId: row.id, status, userId: row.requestedBy });
}

// ── the Radarr/Sonarr push ───────────────────────────────────────────────────

export interface PushableRequest {
  id: string;
  tmdbId: number;
  mediaType: string;
  // The request's own instance (guardrail 32).
  arrInstance: string;
  requestedBy: string;
  // The profile the requester or the deciding admin chose; null ⇒ the
  // instance's configured default.
  qualityProfileId?: number | null;
}

export type PushOutcome =
  | { kind: "pushed" }
  | { kind: "unknown"; error: unknown }
  | { kind: "rolled-back"; error: unknown }
  | { kind: "failed"; error: unknown };

export interface SettledApproval<R extends PushableRequest = PushableRequest> {
  row: R;
  outcome: PushOutcome;
}

/** Whether the request is still approved after its push: it landed, or nobody knows. */
export function approvalStands(outcome: PushOutcome): boolean {
  return outcome.kind === "pushed" || outcome.kind === "unknown";
}

function logLine(err: unknown): string {
  return sanitizeForLog(arrErrorMessage(err));
}

// Back to PENDING, only while still APPROVED: a webhook or the sync may have
// marked the row AVAILABLE since the claim, and a blind write would clobber it.
// A failed write is logged, not thrown — the approval is committed, and every
// caller answers for the row as it stands.
async function rollBackToPending(id: string): Promise<boolean> {
  try {
    const rb = await prisma.mediaRequest.updateMany({
      where: { id, status: "APPROVED" },
      data: { status: "PENDING", pendingNotifyAt: null },
    });
    return rb.count === 1;
  } catch (err) {
    console.error(`[requests] rollback to PENDING failed (request ${id}): ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    return false;
  }
}

/**
 * Add the request's title to its own Radarr/Sonarr instance with its profile.
 * Returns Sonarr's tvdbId for a series (null for a movie). Throws the arr's
 * error; `progress.sent` says whether the add itself went out.
 */
export async function addRequestToArr(row: PushableRequest, progress?: AddProgress): Promise<number | null> {
  const profileId = row.qualityProfileId ?? undefined;
  if (row.mediaType === "MOVIE") {
    await addMovieToRadarr(row.tmdbId, row.arrInstance, profileId, row.requestedBy, progress);
    return null;
  }
  return addSeriesToSonarr(row.tmdbId, row.arrInstance, profileId, row.requestedBy, progress);
}

/**
 * Record the tvdbId Sonarr answered with. Kept apart from the push so a
 * database hiccup here is never read as a push failure (which would roll back a
 * series Sonarr is already grabbing); updateMany no-ops on a deleted row.
 * Logged, never thrown.
 */
export async function stampTvdbId(id: string, tvdbId: number): Promise<void> {
  try {
    await prisma.mediaRequest.updateMany({ where: { id }, data: { tvdbId } });
  } catch (err) {
    console.error(`[requests] tvdbId stamp failed (request ${id}): ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
  }
}

async function settleFailedPush(row: PushableRequest, err: unknown, progress: AddProgress, label: string): Promise<PushOutcome> {
  // Unknown only once the add itself was sent: a failure before it (a lookup,
  // a dark arr refusing the connection) added nothing.
  if (progress.sent && arrWriteOutcomeUnknown(err)) {
    console.error(`[arr] ${label} push outcome unknown, left APPROVED (request ${row.id}): ${logLine(err)}`);
    return { kind: "unknown", error: err };
  }
  console.error(`[arr] ${label} push failed (request ${row.id}): ${logLine(err)}`);
  if (!(await rollBackToPending(row.id))) return { kind: "failed", error: err };
  // Whoever showed the approval must now show it PENDING again.
  announceStatus(row, "PENDING");
  return { kind: "rolled-back", error: err };
}

/**
 * Push one APPROVED request to Radarr/Sonarr and settle the row by the outcome
 * (see the header). `label` names the path in the log. Never throws.
 */
export async function pushApproval(row: PushableRequest, label: string): Promise<PushOutcome> {
  const progress: AddProgress = { sent: false };
  let tvdbId: number | null;
  try {
    tvdbId = await addRequestToArr(row, progress);
  } catch (err) {
    return settleFailedPush(row, err, progress, label);
  }
  if (tvdbId !== null) await stampTvdbId(row.id, tvdbId);
  return { kind: "pushed" };
}

/** pushApproval over many rows, bounded, in the rows' order. */
export function pushApprovals<R extends PushableRequest>(rows: readonly R[], label: string): Promise<Array<SettledApproval<R>>> {
  return mapLimit(rows, APPROVAL_PUSH_CONCURRENCY, async (row) => ({ row, outcome: await pushApproval(row, label) }));
}

// ── follow-up ────────────────────────────────────────────────────────────────

export interface FollowUpRow extends PushableRequest {
  title: string;
  posterPath: string | null;
}

/**
 * The download-check targets of a settled push: every row that kept its armed
 * backstop. A rolled-back row had it cleared, so a job for it would have nothing
 * to consume (and, re-approved within the 90s, would fire beside the new one).
 */
export function downloadChecksFor(settled: ReadonlyArray<SettledApproval<FollowUpRow>>): DownloadCheckTarget[] {
  return settled
    .filter((s) => s.outcome.kind !== "rolled-back")
    .map(({ row }) => ({
      requestId: row.id,
      tmdbId: row.tmdbId,
      mediaType: row.mediaType === "MOVIE" ? "MOVIE" : "TV",
      arrInstance: row.arrInstance,
      requestedBy: row.requestedBy,
      title: row.title,
    }));
}

export interface DecidedRow {
  id: string;
  requestedBy: string;
  title: string;
  mediaType: string;
  tmdbId: number;
  posterPath: string | null;
  arrInstance: string;
  // DECLINED: the note as the decision left it (the one it wrote, else the stored one).
  adminNote?: string | null;
}

/**
 * Tell the requesters of decided rows, skipping the admin's own: the one
 * APPROVED/DECLINED fan-out (guardrails 14c, 33). Never throws.
 */
export function notifyDecided(
  status: "APPROVED" | "DECLINED",
  rows: readonly DecidedRow[],
  actorId: string,
  logScope: string,
): Promise<void> {
  return notifyRequestStatusChanges(
    status,
    rows
      .filter((r) => r.requestedBy !== actorId)
      .map((r) => ({
        id: r.id,
        requestedBy: r.requestedBy,
        title: r.title,
        mediaType: r.mediaType,
        tmdbId: r.tmdbId,
        posterPath: r.posterPath,
        arrInstance: r.arrInstance,
        ...(status === "DECLINED" ? { adminNote: r.adminNote ?? null } : {}),
      })),
    logScope,
  );
}

/**
 * After an admin's approvals were pushed: ONE batched download-check job for
 * the rows that kept their backstop, and "approved" to the requesters whose
 * approval stands.
 */
export function followUpDecidedApprovals(
  settled: ReadonlyArray<SettledApproval<FollowUpRow & DecidedRow>>,
  opts: { actorId: string; checkName: string; logScope: string },
): void {
  scheduleDownloadChecks(downloadChecksFor(settled), { name: opts.checkName });
  void notifyDecided("APPROVED", settled.filter((s) => approvalStands(s.outcome)).map((s) => s.row), opts.actorId, opts.logScope);
}

// ── audit ────────────────────────────────────────────────────────────────────

interface AuditedRow {
  title: string;
  mediaType: string;
  releaseYear: string | null;
  requestedBy: string;
  // The requester's display name; the email never goes in the row (guardrail 33).
  user?: { name: string | null } | null;
}

function decisionAuditBase(row: AuditedRow): Record<string, unknown> {
  return { title: row.title, mediaType: row.mediaType, year: row.releaseYear, ...requesterAuditDetails(row.requestedBy, row.user?.name) };
}

/**
 * REQUEST_APPROVE details, written once the push's outcome is known: the
 * approval was a real decision either way, but the trail must say whether the
 * request reached Radarr/Sonarr or went back to PENDING.
 */
export function approvalAuditDetails(row: AuditedRow, from: RequestStatus, outcome: PushOutcome): Record<string, unknown> {
  return {
    ...decisionAuditBase(row),
    before: { status: from },
    after: { status: "APPROVED" },
    arrPushSucceeded: outcome.kind === "pushed",
    rolledBack: outcome.kind === "rolled-back",
    ...(outcome.kind === "unknown" ? { arrPushOutcomeUnknown: true } : {}),
  };
}

/** REQUEST_DECLINE details: the note as the decline left it. */
export function declineAuditDetails(row: AuditedRow & { adminNote: string | null }, from: RequestStatus): Record<string, unknown> {
  return { ...decisionAuditBase(row), adminNote: row.adminNote, before: { status: from }, after: { status: "DECLINED" } };
}
