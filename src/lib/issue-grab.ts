// IssueGrab bookkeeping shared by the routes that record one (an issue's Replace
// release, Replace file and Refetch) and the Radarr/Sonarr Download webhooks that
// claim one (guardrail 5f).
//
// A row is how a Download webhook knows to tell the admin "the replacement for
// this issue landed". The webhooks match it by title, instance and — Sonarr —
// the issue's scope, never by release, and the scope fields are copied from the
// issue row (which never changes them). So every pending row of one issue on
// one instance matches exactly the same deliveries. Two consequences:
//
//  - Every attempt used to add a row, and the next import claimed ALL of them:
//    N identical pushes and N `arr.grab_completed` events for one download.
//    `recordIssueGrab` therefore retires the SAME admin's EARLIER pending rows
//    of the issue on that instance once the new row exists — the new row
//    announces what they would have. Retiring stamps `notifiedAt` (the claim
//    column): a retired row reads "notified" although no push went out for it.
//    Another admin's row is NOT a duplicate: the completion push goes to the
//    row's `triggeredById` alone, so retiring it would leave the admin who
//    started that replacement never told it landed. Two admins on one issue
//    therefore keep one pending row each (and one `arr.grab_completed` each).
//  - A row had no lifetime of its own. A replacement that found nothing stayed
//    pending after the issue was RESOLVED, and an unrelated RSS import months
//    later announced it. The webhooks never claim a grab whose issue is
//    RESOLVED (`CLAIMABLE_GRAB_ISSUE`); a reopened issue's rows count again.
import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";

/**
 * The webhooks' relation filter on `IssueGrab.issue`: a resolved issue's grab is
 * never claimed. Both webhooks use this one value so the rule can't drift.
 */
export const CLAIMABLE_GRAB_ISSUE = { status: { not: "RESOLVED" } } as const satisfies Prisma.IssueWhereInput;

/**
 * The issue's pending grabs on `arrInstance` that `grab` supersedes: the same
 * admin's (`triggeredById` — the push recipient), created strictly BEFORE it.
 * Ordered by `createdAt`, not "every row but mine", so two attempts recording
 * at once (Replace release beside Replace file) can't retire each other and
 * leave nothing to announce — the newer one survives.
 */
export function supersededGrabsWhere(grab: {
  id: string;
  issueId: string;
  arrInstance: string;
  triggeredById: string;
  createdAt: Date;
}): Prisma.IssueGrabWhereInput {
  return {
    issueId: grab.issueId,
    arrInstance: grab.arrInstance,
    triggeredById: grab.triggeredById,
    notifiedAt: null,
    id: { not: grab.id },
    createdAt: { lt: grab.createdAt },
  };
}

/**
 * Write an IssueGrab and retire the same admin's earlier pending grabs of the
 * issue on the same instance. The create throws like a bare
 * `prisma.issueGrab.create` (callers already catch it — P2003 when the issue
 * was deleted meanwhile); the retire runs only once the new row exists, so a
 * failed create never retires the rows that would still have announced the
 * replacement, and it is best-effort: a failure leaves the duplicates (one
 * extra push), never fails the caller.
 */
export async function recordIssueGrab(data: Prisma.IssueGrabUncheckedCreateInput): Promise<{ id: string }> {
  const grab = await prisma.issueGrab.create({ data });
  // Without the row's own timestamp there is no safe "earlier" to retire.
  if (grab.createdAt instanceof Date) {
    try {
      await prisma.issueGrab.updateMany({ where: supersededGrabsWhere(grab), data: { notifiedAt: new Date() } });
    } catch (err) {
      console.warn("[issues] Recorded the grab but retiring the issue's earlier pending grabs failed:", err);
    }
  }
  return grab;
}
