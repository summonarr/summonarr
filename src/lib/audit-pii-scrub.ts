// The audit-log PII retention scrub, shared by the scrub-audit-pii cron and the
// admin's manual DELETE /api/admin/audit-log, so both keep one promise. Past
// the cutoff it:
//   - nulls ipAddress / userAgent and redacts userName on every row (the row
//     stays keyed by userId, so it can still be joined),
//   - clears the details of login events (free-form, may carry identifiers),
//   - removes the TARGET user's name/email keys from admin-action details
//     (audit-scrub.ts) — the rest of those records stays.
// It redacts; it never deletes a row.
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { REDACTED_USER_NAME } from "./audit";
import { scrubTargetPiiFromAudit } from "./audit-scrub";

// Rows per statement. One unbounded UPDATE over a large, long-unscrubbed table
// held its row locks for the whole pass; in batches each statement is short
// and commits on its own. The scrub is idempotent, so a pass that fails part-
// way is finished by the next one.
export const AUDIT_SCRUB_BATCH = 5_000;
// A bound on one pass of a step (AUDIT_SCRUB_BATCH × this many rows): past it
// the step stops and the next run carries on, rather than looping on rows a
// write somehow failed to take out of the filter.
const MAX_BATCHES = 1_000;

export const AUTH_EVENT_ACTIONS = ["AUTH_LOGIN_FAILED", "AUTH_LOGIN", "AUTH_LOGOUT"] as const;

export type AuditPiiScrubCounts = {
  /** Rows whose ipAddress / userAgent / userName were redacted. */
  scrubbed: number;
  /** Login-event rows whose details were cleared. */
  authDetailsCleared: number;
  /** Admin-action rows that lost the target user's name/email keys. */
  adminDetailsScrubbed: number;
};

/** A scrub that stopped on an error; `done` holds the steps that finished. */
export class AuditPiiScrubError extends Error {
  readonly done: Partial<AuditPiiScrubCounts>;
  constructor(cause: unknown, done: Partial<AuditPiiScrubCounts>) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AuditPiiScrubError";
    this.done = done;
  }
}

// `where` must stop matching a row once `data` is written to it, or the loop
// would see the same rows again (MAX_BATCHES bounds that).
async function updateInBatches(where: Prisma.AuditLogWhereInput, data: Prisma.AuditLogUpdateManyMutationInput): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { count } = await prisma.auditLog.updateMany({ where, data, limit: AUDIT_SCRUB_BATCH });
    total += count;
    if (count < AUDIT_SCRUB_BATCH) return total;
  }
  // The ceiling, not the end of the matching rows, stopped the loop: the next
  // run carries on, so say so rather than let this one read as complete.
  console.warn("[audit-scrub] batch ceiling reached after %d rows; the next run continues", total);
  return total;
}

/** Scrubs every row older than `cutoff`. Throws AuditPiiScrubError, carrying the finished steps. */
export async function scrubAuditPii(cutoff: Date): Promise<AuditPiiScrubCounts> {
  const done: Partial<AuditPiiScrubCounts> = {};
  try {
    done.scrubbed = await updateInBatches(
      {
        createdAt: { lt: cutoff },
        OR: [
          { ipAddress: { not: null } },
          { userAgent: { not: null } },
          { userName: { not: REDACTED_USER_NAME } },
        ],
      },
      { ipAddress: null, userAgent: null, userName: REDACTED_USER_NAME },
    );
    done.authDetailsCleared = await updateInBatches(
      { createdAt: { lt: cutoff }, action: { in: [...AUTH_EVENT_ACTIONS] }, details: { not: null } },
      { details: null },
    );
    done.adminDetailsScrubbed = await scrubTargetPiiFromAudit(prisma, { createdAt: { lt: cutoff } });
  } catch (err) {
    throw new AuditPiiScrubError(err, done);
  }
  return { scrubbed: done.scrubbed, authDetailsCleared: done.authDetailsCleared, adminDetailsScrubbed: done.adminDetailsScrubbed };
}
