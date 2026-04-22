import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { notifyUsersRequestsApproved, notifyUsersRequestsDeclined } from "@/lib/discord-notify";
import { notifyUsersRequestsApprovedPush, notifyUsersRequestsDeclinedPush } from "@/lib/push";
import { emitSSE } from "@/lib/sse-emitter";
import { sanitizeOptional } from "@/lib/sanitize";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";

const VALID_STATUSES = ["APPROVED", "DECLINED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

export async function PATCH(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN", split: true });
  if (session instanceof NextResponse) return session;

  if (!checkRateLimit(`batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many batch operations — try again later" }, { status: 429 });
  }

  let body: { ids?: unknown; status?: unknown; adminNote?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { ids, status, adminNote } = body;

  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return NextResponse.json({ error: "ids must be a non-empty array of up to 100 items" }, { status: 400 });
  }
  if (!ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "ids must be strings" }, { status: 400 });
  }
  if (!VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json({ error: "status must be APPROVED or DECLINED" }, { status: 400 });
  }
  if (adminNote !== undefined && (typeof adminNote !== "string" || adminNote.length > 1000)) {
    return NextResponse.json({ error: "adminNote must be a string under 1000 characters" }, { status: 400 });
  }

  const typedIds = ids as string[];
  const typedStatus = status as ValidStatus;
  const typedAdminNote = sanitizeOptional(adminNote as string | undefined);

  const pendingNotifyAt = typedStatus === "APPROVED" ? new Date(Date.now() + 90_000) : null;

  const pendingBefore = await prisma.mediaRequest.findMany({
    where: { id: { in: typedIds }, status: "PENDING" },
    select: { id: true },
  });
  const pendingBeforeIds = new Set(pendingBefore.map((r) => r.id));

  await prisma.mediaRequest.updateMany({
    where: { id: { in: typedIds }, status: "PENDING" },
    data: {
      status: typedStatus,
      pendingNotifyAt,
      ...(typedAdminNote !== undefined ? { adminNote: typedAdminNote } : {}),
    },
  });

  if (typedStatus === "APPROVED") {
    // Re-fetch from the pre-update PENDING set to avoid acting on requests that were already approved
    const approved = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "APPROVED" },
    });

    await Promise.allSettled(
      approved.map(async (r) => {
        try {
          if (r.mediaType === "MOVIE") {
            await addMovieToRadarr(r.tmdbId);
          } else {
            const tvdbId = await addSeriesToSonarr(r.tmdbId);
            await prisma.mediaRequest.update({ where: { id: r.id }, data: { tvdbId } });
          }
        } catch (err) {
          console.error("[arr] Batch approve push failed for", r.id, err);
        }
      })
    );

    notifyUsersRequestsApproved(approved).catch(() => {});
    notifyUsersRequestsApprovedPush(approved).catch(() => {});
  }

  if (typedStatus === "DECLINED") {
    const declined = await prisma.mediaRequest.findMany({
      where: { id: { in: typedIds }, status: "DECLINED" },
      select: { requestedBy: true, title: true, mediaType: true },
    });
    notifyUsersRequestsDeclined(declined, typedAdminNote).catch(() => {});
    notifyUsersRequestsDeclinedPush(declined).catch(() => {});
  }

  const batchRequests = await prisma.mediaRequest.findMany({
    where: { id: { in: typedIds } },
    select: { id: true, requestedBy: true },
  });
  const ownerMap = new Map(batchRequests.map((r) => [r.id, r.requestedBy]));
  for (const id of typedIds) {
    const userId = ownerMap.get(id);
    if (!userId) continue;
    emitSSE({ type: "request:updated", requestId: id, status: typedStatus, userId });
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: typedStatus === "APPROVED" ? "REQUEST_APPROVE" : "REQUEST_DECLINE",
    target: `batch:${typedIds.length}`,
    details: { batch: true, count: typedIds.length, ids: typedIds.slice(0, 20), adminNote: typedAdminNote ?? null },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
}
