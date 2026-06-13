import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
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

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (req, _ctx, session) => {
  if (!checkRateLimit(`batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many batch operations — try again later" }, { status: 429 });
  }

  let body: { ids?: unknown; status?: unknown; adminNote?: unknown; permanent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { ids, status, adminNote, permanent } = body;

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
  if (permanent !== undefined && typeof permanent !== "boolean") {
    return NextResponse.json({ error: "permanent must be a boolean" }, { status: 400 });
  }

  const typedIds = ids as string[];
  const typedStatus = status as ValidStatus;
  const typedAdminNote = sanitizeOptional(adminNote as string | undefined);
  const typedPermanent = permanent === true && typedStatus === "DECLINED";

  // Permanent declines are terminal (block re-requests); cap below the general 100 ceiling
  // so an admin can't blast 100 users' requests into the permanent state in a single click.
  if (typedPermanent && typedIds.length > 25) {
    return NextResponse.json(
      { error: "permanent-batch-too-large", message: "Permanent declines are limited to 25 at a time." },
      { status: 400 },
    );
  }

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
      ...(typedStatus === "DECLINED" ? { permanentlyDeclined: typedPermanent } : {}),
    },
  });

  if (typedStatus === "APPROVED") {
    // Re-fetch from the pre-update PENDING set to avoid acting on requests that were already approved
    const approved = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "APPROVED" },
    });

    const failedIds = new Set<string>();
    await Promise.allSettled(
      approved.map(async (r) => {
        try {
          const variant = r.is4k ? "4k" : "hd";
          if (r.mediaType === "MOVIE") {
            await addMovieToRadarr(r.tmdbId, variant);
          } else {
            const tvdbId = await addSeriesToSonarr(r.tmdbId, variant);
            await prisma.mediaRequest.update({ where: { id: r.id }, data: { tvdbId } });
          }
        } catch (err) {
          console.error("[arr] Batch approve push failed for", r.id, err);
          failedIds.add(r.id);
        }
      })
    );

    // Roll back rows whose ARR push failed so they aren't stuck APPROVED with no ARR backing.
    if (failedIds.size > 0) {
      await prisma.mediaRequest.updateMany({
        where: { id: { in: [...failedIds] }, status: "APPROVED" },
        data: { status: "PENDING", pendingNotifyAt: null },
      }).catch((err) => console.error("[requests/batch] rollback to PENDING failed:", err));
    }

    // Notify only the ones that actually made it into ARR — otherwise users get
    // a misleading "Approved!" ping for a request that's actually back to PENDING.
    const notifyTargets = approved.filter((r) => !failedIds.has(r.id));
    if (notifyTargets.length > 0) {
      notifyUsersRequestsApproved(notifyTargets).catch(() => {});
      notifyUsersRequestsApprovedPush(notifyTargets).catch(() => {});
    }
  }

  if (typedStatus === "DECLINED") {
    // Mirror the APPROVED path: notify only the rows this batch actually transitioned
    // (PENDING → DECLINED), not ids that were already DECLINED before the call — those
    // were left untouched by updateMany and must not get a duplicate decline ping.
    const declined = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "DECLINED" },
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

  // Permanent declines get their own audit action so they're trivially queryable;
  // the (capped) typedIds list is preserved in full so the trail is reproducible.
  const auditAction =
    typedStatus === "APPROVED"
      ? "REQUEST_APPROVE"
      : typedPermanent
        ? "BATCH_REQUEST_DECLINE"
        : "REQUEST_DECLINE";

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: auditAction,
    target: `batch:${typedIds.length}`,
    details: {
      batch: true,
      count: typedIds.length,
      ids: typedIds,
      adminNote: typedAdminNote ?? null,
      permanent: typedPermanent,
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
