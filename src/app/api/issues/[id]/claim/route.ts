import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, auditContext } from "@/lib/audit";

type RouteContext = { params: Promise<{ id: string }> };

// Toggle semantics:
//   - unclaimed         → claim for current user
//   - claimed by self   → release
//   - claimed by other  → take over (claim for current user)
// Notifications for replies on a claimed issue narrow to the claimer + the
// reporter — see src/app/api/issues/[id]/messages/route.ts.
export async function POST(req: NextRequest, { params }: RouteContext) {
  const session = await requireAuth({ role: "ISSUE_ADMIN" });
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({
    where: { id },
    select: { id: true, title: true, claimedBy: true, reportedBy: true, status: true },
  });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isSelfClaim = issue.claimedBy === session.user.id;
  const action = isSelfClaim ? "release" : "claim";

  const updated = await prisma.issue.update({
    where: { id },
    data: isSelfClaim
      ? { claimedBy: null, claimedAt: null }
      : { claimedBy: session.user.id, claimedAt: new Date() },
    select: {
      id: true,
      claimedBy: true,
      claimedAt: true,
      claimedUser: { select: { id: true, name: true, email: true } },
    },
  });

  emitSSE({ type: "issue:updated", issueId: id, status: issue.status, userId: issue.reportedBy });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: action === "claim" ? "ISSUE_CLAIM" : "ISSUE_UNCLAIM",
    target: `issue:${id}`,
    details: { title: issue.title, before: { claimedBy: issue.claimedBy }, after: { claimedBy: updated.claimedBy } },
    ...auditContext(req, session),
  });

  return NextResponse.json(updated);
}
