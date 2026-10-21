import type { AuditAction, Prisma } from "@/generated/prisma";
import type { prisma } from "./prisma";

// Admin-action PII in audit DETAILS.
//
// The retention scrub (the scrub-audit-pii cron and the manual DELETE
// /api/admin/audit-log) redacts the PII COLUMNS of every aged row — ipAddress,
// userAgent, userName — and clears the details of login events. Admin actions
// about a user also NAME that user inside their details: `targetUser` (a
// display name, which used to fall back to the email), on rows written before
// 2026-10-17 `targetEmail`, and on request moderation rows (`request:<id>`)
// `requestedBy` (the requester's name, which fell back to the email before
// 2026-10-20). Those outlived every other trace of the person — a purged
// account's "Deleted user" row sat next to audit rows still spelling out their
// name and email. These keys are removed:
//   - on the retention schedule, from every aged row (both scrub paths), and
//   - at account purge, inside the purge transaction (purgeUserDataInTx), from
//     every row ABOUT the purged user (`user:<id>` target), from the admin
//     single-session revokes written before 2026-10-20, which named the account
//     only inside their details under a `session:<sid>` target
//     (scrubLegacySessionRevokePii), and from the moderation rows of the
//     account's requests: exactly, by request id, for the requests it still
//     owns (scrubOwnedRequestPii), and by requester id or email for the ones
//     since deleted (scrubRequesterPii).
// The row itself — action, target id, the rest of its details — stays: the
// trail keeps WHAT happened to which account id, only WHO that was goes.
//
// New rows name the target by `targetUserId` (+ `targetUser` only when the
// account has a display name), and the requester by `requesterId` (+
// `requestedBy` likewise — requesterAuditDetails), never by email. The one
// deliberate exception is USER_PURGE, written after the purge commits: it is
// the record of whom the erasure removed, so it keeps the name and email until
// the retention scrub.

export const AUDIT_TARGET_PII_KEYS = ["targetUser", "targetEmail", "requestedBy"] as const;

const SCRUB_BATCH = 500;

// An exact check on the parsed details, for a `where` that can only narrow by
// substring (Prisma's `contains` is a LIKE with no ESCAPE, so `_` and `%` in a
// matched value are wildcards).
type DetailsMatch = (details: Record<string, unknown>) => boolean;

// The details JSON with the target-identity keys removed, or null when there
// is nothing to remove — including details that don't parse as an object
// (left as they are rather than guessed at), and details `match` rejects.
export function stripTargetPii(details: string, match?: DetailsMatch): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (match && !match(parsed as Record<string, unknown>)) return null;
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
// not carry its own OR — its AND terms are kept) and, when given, `match`.
// Paged by a strict `id > last` bound, NOT Prisma's cursor + skip:1: the cursor
// positions on the last row by id alone, and that row was just rewritten so it
// no longer matches the filter — skip:1 then dropped the first STILL-matching
// row of every following page, one unscrubbed row per full batch. The bound
// also means a row that mentions a key but can't be rewritten (or fails
// `match`) can't be fetched forever. Each write is a CAS on the details it
// read, so a concurrent edit is never overwritten with a stale copy. Returns
// the number of rows rewritten.
export async function scrubTargetPiiFromAudit(
  db: AuditDb,
  where: Prisma.AuditLogWhereInput,
  match?: DetailsMatch,
): Promise<number> {
  const callerAnd = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND];
  let scrubbed = 0;
  let lastId: string | undefined;
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: {
        ...where,
        ...(lastId !== undefined ? { AND: [...callerAnd, { id: { gt: lastId } }] } : {}),
        OR: AUDIT_TARGET_PII_KEYS.map((key) => ({ details: { contains: `"${key}"` } })),
      },
      select: { id: true, details: true },
      orderBy: { id: "asc" },
      take: SCRUB_BATCH,
    });
    for (const row of rows) {
      if (!row.details) continue;
      const next = stripTargetPii(row.details, match);
      if (next === null) continue;
      const res = await db.auditLog.updateMany({
        where: { ...where, id: row.id, details: row.details },
        data: { details: next },
      });
      scrubbed += res.count;
    }
    if (rows.length < SCRUB_BATCH) break;
    lastId = rows[rows.length - 1].id;
  }
  return scrubbed;
}

// Before 2026-10-20 an admin's single-session revoke was written under a
// `session:<sid>` target with the account named only in its details
// (`targetUser`: name or email, `targetEmail`), so the purge's `user:<id>`
// scrub never reached it. They are found by the account's email — every one
// carried `targetEmail`, so the caller passes the email it read before the
// purge rewrote it — or by a `targetUserId`; another account's rows are left
// alone. A row written before the account changed its email is left for the
// retention scrub. Run inside the purge transaction, like the `user:<id>` scrub.
//
// The email is matched ONLY by `match`, never in the `where`: Prisma's
// `contains` is a LIKE with no ESCAPE, so the backslashes JSON writes for a `"`
// or `\` in the address are read as escapes and the row is never fetched.
// Without it the read is every legacy admin revoke that still names anyone —
// a set no writer adds to any more, and the retention scrub empties.
export async function scrubLegacySessionRevokePii(db: AuditDb, userId: string, email: string): Promise<number> {
  return scrubTargetPiiFromAudit(
    db,
    { action: "SESSION_REVOKE", target: { startsWith: "session:" } },
    (d) => d.targetEmail === email || d.targetUserId === userId,
  );
}

// The audit actions that moderate ONE request, under a `request:<id>` target.
// (A batch is written under these actions too, but under `batch:<n>`, and it
// names no requester.)
const REQUEST_MODERATION_ACTIONS: AuditAction[] = ["REQUEST_APPROVE", "REQUEST_DECLINE", "REQUEST_DELETE"];

// How a request-moderation audit row names the requester: by id, plus the
// display name only when the account has one — never the email, so the purge
// finds every such row by the id alone (scrubRequesterPii).
export function requesterAuditDetails(
  requesterId: string,
  name: string | null | undefined,
): { requesterId: string; requestedBy?: string } {
  return { requesterId, ...(name ? { requestedBy: name } : {}) };
}

// The purge's exact scrub of the moderation rows of requests the account still
// OWNS: the `request:<rid>` target names the request and MediaRequest.requestedBy
// says whose it is, so no name or email has to match. This reaches what
// scrubRequesterPii can't: an older row that named the requester by display
// name only, and a row whose requesterId is a Discord placeholder that
// discord-merge.ts folded into this account (it moves the requests, then deletes
// the placeholder). The caller reads the ids; chunked so the IN list stays small.
export async function scrubOwnedRequestPii(db: AuditDb, requestIds: readonly string[]): Promise<number> {
  let scrubbed = 0;
  for (let i = 0; i < requestIds.length; i += SCRUB_BATCH) {
    const chunk = requestIds.slice(i, i + SCRUB_BATCH);
    scrubbed += await scrubTargetPiiFromAudit(db, {
      action: { in: REQUEST_MODERATION_ACTIONS },
      target: { in: chunk.map((rid) => `request:${rid}`) },
    });
  }
  return scrubbed;
}

// The purge's scrub of the account's request moderation rows. A row written
// since 2026-10-20 names the requester by `requesterId`, an exact id the
// `where` can narrow by (an id is cuid2, so nothing in it is a LIKE wildcard
// or escape). An older row carried only `requestedBy` — the display name, else
// the email — and is matched here by the email alone, which the caller read
// before the purge rewrote it; never by a display name, which another account
// may share. This pass is what reaches a row whose request is GONE (a
// REQUEST_DELETE): one on a request the account still owns is scrubbed exactly
// by scrubOwnedRequestPii. So only an older row naming a named account by
// display name, on a deleted request, is left for the retention scrub. As
// above, the email is never a `where` term.
export async function scrubRequesterPii(db: AuditDb, userId: string, email: string): Promise<number> {
  return scrubTargetPiiFromAudit(
    db,
    {
      action: { in: REQUEST_MODERATION_ACTIONS },
      target: { startsWith: "request:" },
      AND: [{
        OR: [
          { details: { contains: `"requesterId":${JSON.stringify(userId)}` } },
          { NOT: { details: { contains: '"requesterId"' } } },
        ],
      }],
    },
    (d) => (d.requesterId === undefined ? d.requestedBy === email : d.requesterId === userId),
  );
}
