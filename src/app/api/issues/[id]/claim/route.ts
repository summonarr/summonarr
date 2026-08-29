import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, auditContext } from "@/lib/audit";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCappedOr } from "@/lib/body-size";

type RouteContext = { params: Promise<{ id: string }> };

// Toggle semantics:
//   - unclaimed         → claim for current user
//   - claimed by self   → release
//   - claimed by other  → take over (claim for current user)
// Notifications for replies on a claimed issue narrow to the claimer + the
// reporter — see src/app/api/issues/[id]/messages/route.ts.
export const POST = withIssueAdmin(async (req, { params }: RouteContext, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  const { id } = await params;

  // `expectedClaimedBy` is the claim state the CALLER was rendering. Optional:
  // an absent key (a body-less or `{}` request) keeps the original contract.
  // `null` is a meaningful expectation — "I saw this unclaimed" — so presence is
  // tested with `in`, never truthiness.
  const body = await readJsonCappedOr<{ expectedClaimedBy?: unknown }>(req, 8192, {});
  if (body instanceof NextResponse) return body;
  const hasExpectation = "expectedClaimedBy" in body;
  const expectedClaimedBy = body.expectedClaimedBy;
  if (hasExpectation && expectedClaimedBy !== null && typeof expectedClaimedBy !== "string") {
    return NextResponse.json({ error: "Invalid expectedClaimedBy" }, { status: 400 });
  }

  const issue = await prisma.issue.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      claimedBy: true,
      reportedBy: true,
      status: true,
      claimedUser: { select: { name: true, email: true } },
    },
  });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const existingClaimedBy = issue.claimedBy;

  // The CAS below only guards this handler's own read→write window. A caller
  // acting on stale props — another admin claimed it moments ago, before the
  // issue:updated refresh landed — would otherwise silently take the claim over,
  // skipping the take-over confirmation it never knew to show. Refuse when the
  // caller's view of the claim no longer matches the row.
  if (hasExpectation && expectedClaimedBy !== existingClaimedBy) {
    const holder = issue.claimedUser?.name ?? issue.claimedUser?.email ?? "Another admin";
    return NextResponse.json(
      {
        error: "claim-conflict",
        message: existingClaimedBy
          ? `${holder} claimed this issue first.`
          : "This issue is no longer claimed.",
      },
      { status: 409 }
    );
  }

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
});
