import type { Prisma } from "@/generated/prisma";
import type { prisma } from "./prisma";

// Admin-action PII in audit DETAILS.
//
// The retention scrub (the scrub-audit-pii cron and the manual DELETE
// /api/admin/audit-log) redacts the PII COLUMNS of every aged row — ipAddress,
// userAgent, userName — and clears the details of login events. Admin actions
// about a user also NAME that user inside their details: `targetUser` (a
// display name, which used to fall back to the email) and, on rows written
// before 2026-10-17, `targetEmail`. Those outlived every other trace of the
// person — a purged account's "Deleted user" row sat next to audit rows still
// spelling out their name and email. These keys are removed:
//   - on the retention schedule, from every aged row (both scrub paths), and
//   - at account purge, from every row ABOUT the purged user (`user:<id>`
//     target), inside the purge transaction (purgeUserDataInTx).
// The row itself — action, target id, the rest of its details — stays: the
// trail keeps WHAT happened to which account id, only WHO that was goes.
//
// New rows name the target by `targetUserId` (+ `targetUser` only when the
// account has a display name), never by email.

export const AUDIT_TARGET_PII_KEYS = ["targetUser", "targetEmail"] as const;

const SCRUB_BATCH = 500;

// The details JSON with the target-identity keys removed, or null when there
// is nothing to remove — including details that don't parse as an object
// (left as they are rather than guessed at).
export function stripTargetPii(details: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = { ...(parsed as Record<string, unknown>) };
  let changed = false;
  for (const key of AUDIT_TARGET_PII_KEYS) {
    if (key in obj) {
      delete obj[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : null;
}

// Either the client or an interactive-transaction client.
type AuditDb = Pick<typeof prisma, "auditLog">;

// Removes the target-identity keys from every row matching `where` (which must
// not carry its own OR). Paged by id so a row whose details mention a key but
// don't parse can't be fetched forever; each write is a CAS on the details it
// read, so a concurrent edit is never overwritten with a stale copy. Returns
// the number of rows rewritten.
export async function scrubTargetPiiFromAudit(db: AuditDb, where: Prisma.AuditLogWhereInput): Promise<number> {
  let scrubbed = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: { ...where, OR: AUDIT_TARGET_PII_KEYS.map((key) => ({ details: { contains: `"${key}"` } })) },
      select: { id: true, details: true },
      orderBy: { id: "asc" },
      take: SCRUB_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) {
      if (!row.details) continue;
      const next = stripTargetPii(row.details);
      if (next === null) continue;
      const res = await db.auditLog.updateMany({
        where: { ...where, id: row.id, details: row.details },
        data: { details: next },
      });
      scrubbed += res.count;
    }
    if (rows.length < SCRUB_BATCH) break;
    cursor = rows[rows.length - 1].id;
  }
  return scrubbed;
}
