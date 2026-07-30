import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission } from "@/lib/permissions";
import { purgeUserDataInTx, NotDeactivatedError } from "@/lib/account-lifecycle";

// POST /api/admin/users/[id]/purge — IRREVERSIBLY scrub a disabled account's
// personal data.
//
// Deactivation (DELETE on this user, or the user's own DELETE /api/profile) turns
// an account off but keeps everything. This is the second, deliberate step that
// actually erases the person: name / email / password / image / Discord /
// notification email, the Plex+Jellyfin provider-subject keys, OAuth rows, push
// subscriptions, watchlist / hidden / in-app notifications, and the
// MediaServerUser identity link. Requests, votes and issues stay attached to the
// resulting de-identified "Deleted user" row so the instance keeps its history.
//
// Use this to service a genuine "delete my data" request — App Store Review
// Guideline 5.1.1(v) / GDPR erasure. It is gated on the account being disabled
// first (enforced inside the transaction), so no single click can destroy a live
// user's data. Authority mirrors the disable path rather than requiring full
// ADMIN: MANAGE_USERS may purge, but only an ADMIN may act on an admin account.
export const POST = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const { id } = await params;
  if (!checkRateLimit(`admin-user-purge:${session.user.id}`, 5, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a minute." }, { status: 429 });
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, name: true, email: true, deactivatedAt: true, purgedAt: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (target.role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: "Only an admin can purge an admin account" }, { status: 403 });
  }
  if (target.purgedAt) return NextResponse.json({ ok: true }); // idempotent
  if (!target.deactivatedAt) {
    return NextResponse.json(
      { error: "Disable this account before purging its data." },
      { status: 400 },
    );
  }

  // Captured BEFORE the scrub — after it there is no name/email left to audit,
  // and this row is the only remaining record of who the account belonged to.
  const [requestCount, issueCount, voteCount] = await Promise.all([
    prisma.mediaRequest.count({ where: { requestedBy: id } }),
    prisma.issue.count({ where: { reportedBy: id } }),
    prisma.deletionVote.count({ where: { userId: id } }),
  ]);

  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      await purgeUserDataInTx(tx, id, now);
    });
  } catch (err) {
    if (err instanceof NotDeactivatedError) {
      // Re-activated between our read and the tx.
      return NextResponse.json(
        { error: "Disable this account before purging its data." },
        { status: 400 },
      );
    }
    throw err;
  }

  invalidateUserSession(id);

  // Already committed; a failed audit write must not 500 it (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "USER_PURGE",
    target: `user:${id}`,
    details: {
      targetUser: target.name ?? target.email,
      targetEmail: target.email,
      role: target.role,
      historyPreserved: { mediaRequests: requestCount, issues: issueCount, deletionVotes: voteCount },
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
