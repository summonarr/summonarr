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

  const existingClaimedBy = issue.claimedBy;
  const isSelfClaim = existingClaimedBy === session.user.id;
  const action = isSelfClaim ? "release" : "claim";

  // Compare-and-swap on claimedBy: only mutate if the current value still
  // matches what we just read. Prevents two admins from racing to claim/take
  // over the same issue and stomping each other's writes.
  const result = await prisma.issue.updateMany({
    where: { id, claimedBy: existingClaimedBy },
    data: isSelfClaim
      ? { claimedBy: null, claimedAt: null }
      : { claimedBy: session.user.id, claimedAt: new Date() },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: "claim-conflict", message: "Another admin claimed this issue first." },
      { status: 409 }
    );
  }

  const updated = await prisma.issue.findUnique({
    where: { id },
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
    details: { title: issue.title, before: { claimedBy: existingClaimedBy }, after: { claimedBy: updated?.claimedBy ?? null } },
    ...auditContext(req, session),
  });

  return NextResponse.json(updated);
}
