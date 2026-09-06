import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr } from "@/lib/arr";
import { notifyUsersRequestsApproved, notifyUsersRequestsDeclined } from "@/lib/discord-notify";
import { notifyUsersRequestsApprovedPush, notifyUsersRequestsDeclinedPush } from "@/lib/push";
import { notifyUserRequestApprovedEmail, notifyUserRequestDeclinedEmail } from "@/lib/email";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { buildNotificationData } from "@/lib/notification-data";
import { emitSSE } from "@/lib/sse-emitter";
import { scheduleDownloadChecks } from "@/lib/download-check";
import { sanitizeOptional } from "@/lib/sanitize";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { maintenanceGuard } from "@/lib/maintenance";
import { settleLimit } from "@/lib/concurrency";

// Cap concurrent ARR pushes (guardrail 31) — mirrors the bulk route's
// ARR_CONCURRENCY so a large batch approve doesn't burst every Radarr/Sonarr
// add at once.
const ARR_CONCURRENCY = 5;

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
      // deactivatedAt: null — account removal disables rather than scrubs
      // (guardrail 33), so a removed user keeps a live notification email and
      // would otherwise still get emailed by a later batch approve/decline.
      // Mirrors the same guard just added to the Discord/push plural notifiers.
      where: { id: { in: userIds }, deactivatedAt: null },
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

// Mirrors the single-request path's inbox write (writeInAppNotification →
// createInAppNotification in request-notifications.ts): the header bell /
// /notifications inbox must record a REQUEST_APPROVED / REQUEST_DECLINED row for
// every batch transition too. The batch route previously fanned out only
// Discord/push/email and left the inbox empty. One bounded createMany (guardrail
// 31) instead of per-user creates; body copy matches inAppBodyFor. Unconditional —
// the inbox is a passive record the user pulls, not a channel to opt out of.
// Fire-and-forget; a failed inbox write must never break the batch action.
async function writeBatchInboxRows(
  targets: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number | null; posterPath?: string | null }>,
  type: "REQUEST_APPROVED" | "REQUEST_DECLINED",
): Promise<void> {
  if (targets.length === 0) return;
  const bodyFor = (mediaType: string) => {
    const label = mediaType === "MOVIE" ? "movie" : "TV show";
    return type === "REQUEST_APPROVED"
      ? `Your ${label} request was approved and is downloading.`
      : `Your ${label} request was declined.`;
  };
  try {
    // Guardrail 33: account removal disables rather than scrubs — mirror the
    // deactivatedAt gate the email/Discord/push fan-outs already apply, or a
    // later re-enabled account signs in to a bell full of stale batch rows for
    // requests it never saw actioned.
    const activeIds = new Set(
      (
        await prisma.user.findMany({
          where: { id: { in: [...new Set(targets.map((t) => t.requestedBy))] }, deactivatedAt: null },
          select: { id: true },
        })
      ).map((u) => u.id),
    );
    const liveTargets = targets.filter((t) => activeIds.has(t.requestedBy));
    if (liveTargets.length === 0) return;
    await prisma.notification.createMany({
      data: liveTargets.map((t) =>
        buildNotificationData(t.requestedBy, {
          type,
          title: t.title,
          body: bodyFor(t.mediaType),
          tmdbId: t.tmdbId ?? null,
          mediaType: t.mediaType,
          posterPath: t.posterPath ?? null,
        }),
      ),
    });
  } catch (err) {
    console.error("[requests/batch] in-app inbox write failed:", err instanceof Error ? err.message : err);
  }
}

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
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

  // Atomically CLAIM the rows (PENDING -> typedStatus) in ONE `UPDATE … WHERE id IN
  // (…) AND status = 'PENDING' RETURNING id, requestedBy`. The returned rows are
  // exactly the ones THIS call transitioned: Postgres re-evaluates the status
  // predicate per row at write time (after taking the row lock), so a concurrent
  // batch on the same ids finds them already non-PENDING and gets them back in
  // ITS result set — never both. That is the same CAS the old per-id updateMany
  // loop gave, minus up to 100 sequential round-trips per click, and the
  // returned `requestedBy` is what the SSE emit below needs, so no re-read. The
  // even older bulk findMany(PENDING) + updateMany shared a pre-update snapshot
  // that two concurrent calls could both act on — do not regress to that.
  const claimed = await prisma.mediaRequest.updateManyAndReturn({
    where: { id: { in: typedIds }, status: "PENDING" },
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
    select: { id: true, requestedBy: true },
  });
  const claimedIds = claimed.map((r) => r.id);
  const ownerMap = new Map(claimed.map((r) => [r.id, r.requestedBy]));
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
    await settleLimit(approved, ARR_CONCURRENCY, async (r) => {
      let pushedTvdbId: number | null = null;
      try {
        const variant = r.arrInstance;
        // Honor the profile the requester chose at request time (REQUEST_ADVANCED);
        // absent ⇒ the instance default. Mirrors requests/[id] effectiveProfileId
        // and the sync re-push — batch approve previously discarded it.
        const profileId = r.qualityProfileId ?? undefined;
        if (r.mediaType === "MOVIE") {
          await addMovieToRadarr(r.tmdbId, variant, profileId, r.requestedBy);
        } else {
          pushedTvdbId = await addSeriesToSonarr(r.tmdbId, variant, profileId, r.requestedBy);
        }
      } catch (err) {
        console.error("[arr] Batch approve push failed for", r.id, err);
        failedIds.add(r.id);
      }
      // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the
      // series by this point, so a P2025 (row deleted mid-push) or transient DB error
      // must not land the id in failedIds and roll a genuinely-grabbed request back to
      // PENDING. updateMany no-ops on a concurrently deleted row instead of throwing.
      if (pushedTvdbId !== null) {
        await prisma.mediaRequest.updateMany({ where: { id: r.id }, data: { tvdbId: pushedTvdbId } });
      }
    });

    // Roll back rows whose ARR push failed so they aren't stuck APPROVED with no ARR backing.
    if (failedIds.size > 0) {
      await prisma.mediaRequest.updateMany({
        where: { id: { in: [...failedIds] }, status: "APPROVED" },
        data: { status: "PENDING", pendingNotifyAt: null },
      }).catch((err) => console.error("[requests/batch] rollback to PENDING failed:", err));
    }

    // Run the pendingNotifyAt check PROMPTLY at ~90s for every row that actually
    // landed in ARR, instead of leaving it to the orchestrator's next sweep. One
    // batched job, not one per row — a 100-id batch would otherwise fill the whole
    // delayed-job run queue. Rolled-back rows are excluded: they had
    // pendingNotifyAt cleared above, so there is nothing left to check.
    scheduleDownloadChecks(
      approved
        .filter((r) => !failedIds.has(r.id))
        .map((r) => ({
          requestId: r.id,
          tmdbId: r.tmdbId,
          mediaType: r.mediaType,
          arrInstance: r.arrInstance,
          requestedBy: r.requestedBy,
          title: r.title,
        })),
      { name: "requests/batch:90s-download-check" },
    );

    // Notify only the ones that actually made it into ARR — otherwise users get
    // a misleading "Approved!" ping for a request that's actually back to PENDING.
    // Skip rows the acting admin owns — no self-notification for one's own request.
    const notifyTargets = approved.filter((r) => !failedIds.has(r.id) && r.requestedBy !== session.user.id);
    if (notifyTargets.length > 0) {
      notifyUsersRequestsApproved(notifyTargets).catch(() => {});
      notifyUsersRequestsApprovedPush(notifyTargets).catch(() => {});
      void fanOutEmails(notifyTargets, "APPROVED");
      void writeBatchInboxRows(notifyTargets, "REQUEST_APPROVED");
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
    void writeBatchInboxRows(declineTargets, "REQUEST_DECLINED");
  }

  // Emit only for rows THIS call actually transitioned (claimedIds) — an
  // unclaimed id (already non-PENDING, or claimed by a concurrent batch) was
  // left untouched, and announcing the batch target for it would push a status
  // the row never entered. ownerMap came back with the claim itself.
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
