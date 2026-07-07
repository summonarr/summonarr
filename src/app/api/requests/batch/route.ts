import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { notifyUsersRequestsApproved, notifyUsersRequestsDeclined } from "@/lib/discord-notify";
import { notifyUsersRequestsApprovedPush, notifyUsersRequestsDeclinedPush } from "@/lib/push";
import { notifyUserRequestApprovedEmail, notifyUserRequestDeclinedEmail } from "@/lib/email";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { emitSSE } from "@/lib/sse-emitter";
import { sanitizeOptional } from "@/lib/sanitize";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { maintenanceGuard } from "@/lib/maintenance";

const VALID_STATUSES = ["APPROVED", "DECLINED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

interface EmailTarget {
  requestedBy: string;
  title: string;
  mediaType: string;
  posterPath?: string | null;
  tmdbId?: number | null;
}

// Mirrors the single-request route's email channel (notifyRequestStatusChange):
// resolve each owner's notification email + per-status opt-in pref, then fan out.
// Fire-and-forget; per-row failures are swallowed by the email helpers.
async function fanOutEmails(targets: EmailTarget[], status: "APPROVED" | "DECLINED", adminNote?: string | null): Promise<void> {
  if (targets.length === 0) return;
  try {
    const userIds = [...new Set(targets.map((t) => t.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, notificationEmail: true, emailOnApproved: true, emailOnDeclined: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    for (const t of targets) {
      const u = userMap.get(t.requestedBy);
      if (!u) continue;
      const to = resolveUserNotificationEmail(u);
      if (!to) continue;
      if (status === "APPROVED") {
        if (!u.emailOnApproved) continue;
        void notifyUserRequestApprovedEmail({ toEmail: to, title: t.title, mediaType: t.mediaType, posterPath: t.posterPath, tmdbId: t.tmdbId ?? undefined });
      } else {
        if (!u.emailOnDeclined) continue;
        void notifyUserRequestDeclinedEmail({ toEmail: to, title: t.title, mediaType: t.mediaType, adminNote: adminNote ?? null, posterPath: t.posterPath });
      }
    }
  } catch (err) {
    console.error("[requests/batch] email fan-out failed:", err instanceof Error ? err.message : err);
  }
}

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (req, _ctx, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  if (!checkRateLimit(`batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many batch operations — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ ids?: unknown; status?: unknown; adminNote?: unknown; permanent?: unknown }>(req, 1048576);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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

  // Atomically CLAIM each row (PENDING -> typedStatus) one at a time: updateMany's
  // count tells us which rows THIS call actually transitioned. A concurrent batch on
  // the same ids finds them already non-PENDING (count 0) and skips them, so the ARR
  // push, notifications, and audit below can't double-fire on the same request. The
  // old bulk findMany(PENDING) + updateMany shared a pre-update snapshot that two
  // concurrent calls could both act on.
  const claimedIds: string[] = [];
  for (const id of typedIds) {
    const res = await prisma.mediaRequest.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: typedStatus,
        pendingNotifyAt,
        // Guard on the RAW body field: sanitizeOptional never returns undefined
        // (it maps undefined → null), so guarding on typedAdminNote would always
        // be true and wipe the stored note on every batch transition.
        ...(adminNote !== undefined ? { adminNote: typedAdminNote } : {}),
        // Approving clears any prior decline; otherwise an APPROVED row keeps
        // permanentlyDeclined=true and the owner's future re-requests stay blocked.
        ...(typedStatus === "APPROVED" ? { permanentlyDeclined: false } : { permanentlyDeclined: typedPermanent }),
      },
    });
    if (res.count === 1) claimedIds.push(id);
  }
  // The set of rows THIS call transitioned — drives every side effect below.
  const pendingBeforeIds = new Set(claimedIds);
  // Hoisted to function scope so the SSE emit below can report the TRUE status of
  // rows whose ARR push failed (rolled back to PENDING), not the batch target.
  const failedIds = new Set<string>();

  if (typedStatus === "APPROVED") {
    // Re-fetch from the pre-update PENDING set to avoid acting on requests that were already approved
    const approved = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "APPROVED" },
    });

    // failedIds is declared at function scope above (reused by the SSE emit).
    await Promise.allSettled(
      approved.map(async (r) => {
        try {
          const variant = r.is4k ? "4k" : "hd";
          if (r.mediaType === "MOVIE") {
            await addMovieToRadarr(r.tmdbId, variant, undefined, r.requestedBy);
          } else {
            const tvdbId = await addSeriesToSonarr(r.tmdbId, variant, undefined, r.requestedBy);
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
    // Skip rows the acting admin owns — no self-notification for one's own request.
    const notifyTargets = approved.filter((r) => !failedIds.has(r.id) && r.requestedBy !== session.user.id);
    if (notifyTargets.length > 0) {
      notifyUsersRequestsApproved(notifyTargets).catch(() => {});
      notifyUsersRequestsApprovedPush(notifyTargets).catch(() => {});
      void fanOutEmails(notifyTargets, "APPROVED");
    }
  }

  if (typedStatus === "DECLINED") {
    // Mirror the APPROVED path: notify only the rows this batch actually transitioned
    // (PENDING → DECLINED), not ids that were already DECLINED before the call — those
    // were left untouched by updateMany and must not get a duplicate decline ping.
    const declined = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "DECLINED" },
      select: { requestedBy: true, title: true, mediaType: true, tmdbId: true, posterPath: true },
    });
    // Skip rows the acting admin owns — no self-notification for one's own request.
    const declineTargets = declined.filter((r) => r.requestedBy !== session.user.id);
    notifyUsersRequestsDeclined(declineTargets, typedAdminNote).catch(() => {});
    notifyUsersRequestsDeclinedPush(declineTargets).catch(() => {});
    void fanOutEmails(declineTargets, "DECLINED", typedAdminNote);
  }

  // Emit only for rows THIS call actually transitioned (claimedIds) — an
  // unclaimed id (already non-PENDING, or claimed by a concurrent batch) was
  // left untouched, and announcing the batch target for it would push a status
  // the row never entered.
  const batchRequests = await prisma.mediaRequest.findMany({
    where: { id: { in: claimedIds } },
    select: { id: true, requestedBy: true },
  });
  const ownerMap = new Map(batchRequests.map((r) => [r.id, r.requestedBy]));
  for (const id of claimedIds) {
    const userId = ownerMap.get(id);
    if (!userId) continue;
    // A row whose ARR push failed was rolled back to PENDING — emit its TRUE
    // status, not the batch target, so clients don't show it stuck APPROVED.
    const effectiveStatus = typedStatus === "APPROVED" && failedIds.has(id) ? "PENDING" : typedStatus;
    emitSSE({ type: "request:updated", requestId: id, status: effectiveStatus, userId });
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
