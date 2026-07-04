import { NextResponse } from "next/server";
import { withAuth, withPermission } from "@/lib/api-auth";
import { Permission, hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, searchMovieInRadarr, arrErrorMessage } from "@/lib/arr";
import { addSeriesToSonarr, searchSeriesInSonarr } from "@/lib/arr";
import { notifyUserDownloadPending, notifyUserAwaitingRelease } from "@/lib/discord-notify";
import { isMovieDownloadingInRadarr, isSeriesDownloadingInSonarr, getMovieReleaseInfo, getSeriesFirstAired } from "@/lib/arr";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, auditContext } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { notifyRequestStatusChange } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { checkRateLimit } from "@/lib/rate-limit";
import { scheduleDelayed } from "@/lib/delayed-jobs";
import { readJsonCapped } from "@/lib/body-size";
import { maintenanceGuard } from "@/lib/maintenance";

const VALID_STATUSES = ["APPROVED", "DECLINED", "AVAILABLE", "PENDING"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  if (!checkRateLimit(`admin-req:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const { id } = await params;

  const parsed = await readJsonCapped<{ status?: string; retry?: boolean; search?: boolean; adminNote?: string; permanent?: boolean; qualityProfileId?: number; qualityProfileName?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { status, retry, search, adminNote, permanent, qualityProfileId, qualityProfileName } = body;

  if (adminNote !== undefined && (typeof adminNote !== "string" || adminNote.length > 1000)) {
    return NextResponse.json({ error: "adminNote must be a string under 1000 characters" }, { status: 400 });
  }
  // Optional one-time quality-profile override for the ARR push on approval. Only
  // consumed by the APPROVE transition below; ignored on other transitions. The
  // name is carried purely so the audit log reads "720p" instead of a bare id.
  if (qualityProfileId !== undefined && (!Number.isInteger(qualityProfileId) || qualityProfileId <= 0)) {
    return NextResponse.json({ error: "qualityProfileId must be a positive integer" }, { status: 400 });
  }
  if (qualityProfileName !== undefined && (typeof qualityProfileName !== "string" || qualityProfileName.length > 100)) {
    return NextResponse.json({ error: "qualityProfileName must be a string under 100 characters" }, { status: 400 });
  }
  const sanitizedAdminNote = sanitizeOptional(adminNote);

  const existing = await prisma.mediaRequest.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (search) {
    if (existing.status !== "APPROVED" && existing.status !== "AVAILABLE") {
      return NextResponse.json(
        { error: "Search is only valid for APPROVED or AVAILABLE requests" },
        { status: 400 }
      );
    }

    if (adminNote !== undefined) {
      await prisma.mediaRequest.update({ where: { id }, data: { adminNote: sanitizedAdminNote } });
      // Audit the note change so silent edits via search/retry leave a trail.
      // The status-transition branches already audit via logAudit.
      if ((existing.adminNote ?? null) !== (sanitizedAdminNote ?? null)) {
        void logAudit({
          userId: session.user.id,
          userName: session.user.name ?? session.user.email ?? "unknown",
          action: "SETTINGS_CHANGE",
          target: `request:${id}:adminNote`,
          details: { via: "search", from: existing.adminNote ?? null, to: sanitizedAdminNote ?? null },
          ...auditContext(req, session),
        });
      }
    }
    const variant = existing.is4k ? "4k" : "hd";
    let arrError: string | null = null;
    try {
      if (existing.mediaType === "MOVIE") {
        await searchMovieInRadarr(existing.tmdbId, variant);
      } else {
        if (!existing.tvdbId) throw new Error("No TVDB ID stored — re-push the request first");
        await searchSeriesInSonarr(existing.tvdbId, variant);
      }
    } catch (err) {
      console.error("[arr] Search failed:", err);
      arrError = arrErrorMessage(err);
    }
    return NextResponse.json({ ...existing, adminNote: adminNote !== undefined ? sanitizedAdminNote : existing.adminNote, arrError });
  }

  if (retry) {
    if (existing.status !== "APPROVED") {
      return NextResponse.json(
        { error: "Retry is only valid for APPROVED requests" },
        { status: 400 }
      );
    }

    if (adminNote !== undefined) {
      await prisma.mediaRequest.update({ where: { id }, data: { adminNote: sanitizedAdminNote } });
      if ((existing.adminNote ?? null) !== (sanitizedAdminNote ?? null)) {
        void logAudit({
          userId: session.user.id,
          userName: session.user.name ?? session.user.email ?? "unknown",
          action: "SETTINGS_CHANGE",
          target: `request:${id}:adminNote`,
          details: { via: "retry", from: existing.adminNote ?? null, to: sanitizedAdminNote ?? null },
          ...auditContext(req, session),
        });
      }
    }
    const variant = existing.is4k ? "4k" : "hd";
    let arrError: string | null = null;
    try {
      if (existing.mediaType === "MOVIE") {
        await addMovieToRadarr(existing.tmdbId, variant);
      } else {
        const tvdbId = await addSeriesToSonarr(existing.tmdbId, variant);
        await prisma.mediaRequest.update({ where: { id }, data: { tvdbId } });
      }
    } catch (err) {
      console.error("[arr] Retry push failed:", err);
      arrError = arrErrorMessage(err);
    }
    return NextResponse.json({ ...existing, adminNote: adminNote !== undefined ? sanitizedAdminNote : existing.adminNote, arrError });
  }

  // Note-only edit: `adminNote` with no status/search/retry updates the admin
  // reply in place (an empty note clears it — sanitizeOptional maps "" to null).
  // Status transitions below stay strictly validated; the old client behavior of
  // sending the CURRENT status alongside the note always 422'd on the
  // same-status transition, so a standalone note edit needs its own path.
  if (status === undefined && adminNote !== undefined) {
    const r = await prisma.mediaRequest.updateMany({ where: { id }, data: { adminNote: sanitizedAdminNote } });
    if (r.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if ((existing.adminNote ?? null) !== (sanitizedAdminNote ?? null)) {
      void logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email ?? "unknown",
        action: "SETTINGS_CHANGE",
        target: `request:${id}:adminNote`,
        details: { via: "note", from: existing.adminNote ?? null, to: sanitizedAdminNote ?? null },
        ...auditContext(req, session),
      });
    }
    const noted = await prisma.mediaRequest.findUnique({
      where: { id },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!noted) return NextResponse.json({ error: "Not found" }, { status: 404 });
    emitSSE({ type: "request:updated", requestId: id, status: noted.status, userId: existing.requestedBy });
    return NextResponse.json(noted);
  }

  if (!status || !VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const VALID_TRANSITIONS: Record<string, string[]> = {
    PENDING:   ["APPROVED", "DECLINED"],
    APPROVED:  ["AVAILABLE", "DECLINED"],
    DECLINED:  ["PENDING", "APPROVED"],
    AVAILABLE: [],
  };

  const currentStatus = existing.status;
  const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(status)) {
    return NextResponse.json(
      { error: `Cannot transition from ${currentStatus} to ${status}` },
      { status: 422 }
    );
  }

  if (status === "APPROVED" && existing.status !== "APPROVED") {
    // CAS on current status prevents double-approve race conditions
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id, status: existing.status },
      data: {
        status: "APPROVED",
        // Approving clears a prior decline; otherwise an APPROVED row keeps
        // permanentlyDeclined=true and re-requests stay blocked (see the
        // permanentlyDeclined gate in requests/route.ts).
        permanentlyDeclined: false,
        // Guard on the RAW body field: sanitizeOptional never returns undefined
        // (it maps undefined → null), so guarding on sanitizedAdminNote would
        // always be true and wipe the stored note on every status transition.
        ...(adminNote !== undefined ? { adminNote: sanitizedAdminNote } : {}),
        // pendingNotifyAt triggers a 90s download-check notification if the item still isn't in the queue
        pendingNotifyAt: new Date(Date.now() + 90_000),
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "Request was modified concurrently" }, { status: 409 });
    }
  } else if (status === "DECLINED" && existing.status !== "DECLINED") {
    // CAS on current status prevents double-decline races
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id, status: existing.status },
      data: {
        status: "DECLINED",
        permanentlyDeclined: permanent === true,
        // Guard on the RAW body field: sanitizeOptional never returns undefined
        // (it maps undefined → null), so guarding on sanitizedAdminNote would
        // always be true and wipe the stored note on every status transition.
        ...(adminNote !== undefined ? { adminNote: sanitizedAdminNote } : {}),
        pendingNotifyAt: null,
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "Request was modified concurrently" }, { status: 409 });
    }
  } else {
    // CAS on current status: the transition-table check ran against the stale
    // `existing` read, so two concurrent admins could both pass it. The status
    // predicate makes the write atomic — a row already moved yields count=0 → 409.
    const claimed = await prisma.mediaRequest.updateMany({
      where: { id, status: existing.status },
      data: {
        status: status as ValidStatus,
        // Guard on the RAW body field: sanitizeOptional never returns undefined
        // (it maps undefined → null), so guarding on sanitizedAdminNote would
        // always be true and wipe the stored note on every status transition.
        ...(adminNote !== undefined ? { adminNote: sanitizedAdminNote } : {}),

        ...(status === "AVAILABLE" || status === "DECLINED" ? { pendingNotifyAt: null } : {}),

        // Reopening a permanently-declined request to PENDING must clear the sticky
        // flag, else the row shows PENDING while the user stays blocked from re-requesting
        // (requests/route.ts permanentlyDeclined gate).
        ...(status === "PENDING" && existing.status === "DECLINED" ? { permanentlyDeclined: false } : {}),

        ...(status === "AVAILABLE" && !existing.availableAt ? { availableAt: new Date() } : {}),
      },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: "Request was modified concurrently" }, { status: 409 });
    }
  }

  const updated = await prisma.mediaRequest.findUnique({
    where: { id },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  emitSSE({ type: "request:updated", requestId: id, status: updated.status, userId: existing.requestedBy });

  const requestedByName = existing.user?.name ?? existing.user?.email ?? existing.requestedBy;
  // An admin acting on their OWN request shouldn't get a self-notification ("your
  // request was approved/declined/available") — they just performed the action.
  const selfAction = existing.requestedBy === session.user.id;
  if (status === "APPROVED" && existing.status !== "APPROVED") {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_APPROVE", target: `request:${id}`, details: { title: updated.title, mediaType: updated.mediaType, year: updated.releaseYear, requestedBy: requestedByName, before: { status: existing.status }, after: { status }, ...(qualityProfileId !== undefined ? { qualityProfileId, qualityProfileName: qualityProfileName ?? null } : {}) }, ...auditContext(req, session) });
  } else if (status === "DECLINED" && existing.status !== "DECLINED") {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_DECLINE", target: `request:${id}`, details: { title: updated.title, mediaType: updated.mediaType, year: updated.releaseYear, requestedBy: requestedByName, adminNote: updated.adminNote, before: { status: existing.status }, after: { status } }, ...auditContext(req, session) });
  }

  if (status === "APPROVED" && existing.status !== "APPROVED") {
    const variant = updated.is4k ? "4k" : "hd";
    let arrError: string | null = null;
    let arrPushSucceeded = false;
    try {
      if (updated.mediaType === "MOVIE") {
        await addMovieToRadarr(updated.tmdbId, variant, qualityProfileId);
      } else {
        const tvdbId = await addSeriesToSonarr(updated.tmdbId, variant, qualityProfileId);
        await prisma.mediaRequest.update({ where: { id }, data: { tvdbId } });
      }
      arrPushSucceeded = true;
    } catch (err) {
      console.error("[arr] Failed to push request:", err);
      arrError = arrErrorMessage(err);
      // Roll status back to PENDING so the request isn't stuck APPROVED with no
      // ARR backing — admin sees the failure in the response (`arrError`) and
      // can retry. Matches the Discord interactions auto-approve rollback shape.
      await prisma.mediaRequest.update({
        where: { id, status: "APPROVED" },
        data: { status: "PENDING", pendingNotifyAt: null },
      }).catch((rbErr) => console.error("[requests] rollback to PENDING failed:", rbErr));
      // Correct the optimistic APPROVED SSE emitted before the push — without this,
      // clients show the request stuck APPROVED when it's actually back to PENDING.
      emitSSE({ type: "request:updated", requestId: id, status: "PENDING", userId: existing.requestedBy });
    }

    // Only notify if ARR push actually succeeded — otherwise the user gets a
    // misleading "Approved!" ping for a request that's actually back to PENDING.
    // Skip when the admin approved their own request (selfAction).
    if (arrPushSucceeded && !selfAction) {
      notifyRequestStatusChange("APPROVED", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, posterPath: updated.posterPath, tmdbId: updated.tmdbId });
    }

    scheduleDelayed(90_000, async () => {
      try {
        const current = await prisma.mediaRequest.findUnique({ where: { id }, select: { status: true } });
        if (current?.status !== "APPROVED") return;

        const downloading = updated.mediaType === "MOVIE"
          ? await isMovieDownloadingInRadarr(updated.tmdbId, variant)
          : await isSeriesDownloadingInSonarr(updated.tmdbId, variant);
        // Skip on true (downloading) and null (queue unreadable) — only a confirmed
        // "not downloading" fires the pending notify. Returning leaves pendingNotifyAt
        // set so the orchestrator backstop retries.
        if (downloading !== false) return;

        const now = new Date();
        let released = true;
        let soonestReleaseDate: string | null = null;

        if (updated.mediaType === "MOVIE") {
          const info = await getMovieReleaseInfo(updated.tmdbId);
          if (info) {
            const futureDates = [info.digitalRelease, info.physicalRelease]
              .filter((d): d is string => !!d && new Date(d) > now);
            const pastDates = [info.digitalRelease, info.physicalRelease]
              .filter((d): d is string => !!d && new Date(d) <= now);

            if (pastDates.length === 0 && futureDates.length > 0) {
              released = false;
              soonestReleaseDate = futureDates.sort()[0];
            }
          }
        } else {
          const firstAired = await getSeriesFirstAired(updated.tmdbId);
          if (firstAired && new Date(firstAired) > now) {
            released = false;
            soonestReleaseDate = firstAired;
          }
        }

        if (!released) {
          await notifyUserAwaitingRelease(updated.requestedBy, updated.title, updated.mediaType, soonestReleaseDate);
        } else {
          await notifyUserDownloadPending(updated.requestedBy, updated.title, updated.mediaType);
        }
        await prisma.mediaRequest.update({ where: { id }, data: { pendingNotifyAt: null } });
      } catch (err) {
        console.error("[download-check] 90s status check failed:", err);
      }
    }, { name: "requests:90s-download-check" });

    return NextResponse.json({ ...updated, arrError });
  }

  if (status === "AVAILABLE" && existing.status !== "AVAILABLE") {
    let casCount = 0;
    try {
      const cas = await prisma.mediaRequest.updateMany({
        where: { id, notifiedAvailable: false },
        data: { notifiedAvailable: true },
      });
      casCount = cas.count;
    } catch (err) {
      console.error("[requests] Failed to CAS notifiedAvailable:", err);
    }
    if (casCount === 1) {
      void clearDeletionVotesForTmdbs([{ tmdbId: updated.tmdbId, mediaType: updated.mediaType }]);
      if (!selfAction) {
        notifyRequestStatusChange("AVAILABLE", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, posterPath: updated.posterPath, tmdbId: updated.tmdbId });
      }
    }
  }

  if (status === "DECLINED" && existing.status !== "DECLINED" && !selfAction) {
    notifyRequestStatusChange("DECLINED", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, adminNote: updated.adminNote, posterPath: updated.posterPath, tmdbId: updated.tmdbId });
  }

  return NextResponse.json(updated);
});

// Two callers share this handler:
//   - An admin (MANAGE_REQUESTS) can delete any request (existing behavior;
//     consumed by the admin request-actions UI). Audited as REQUEST_DELETE.
//   - The request owner can self-cancel their OWN request, but only while it is
//     still PENDING — once approved/available, cancellation goes through the
//     admin PATCH path. Added for native clients.
// Anyone else gets 403. Using withAuth (not withPermission) keeps the route a
// single DELETE export while letting the owner branch through.
export const DELETE = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  const { id } = await params;
  const existing = await prisma.mediaRequest.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isAdmin = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  const isOwnerSelfCancel =
    existing.requestedBy === session.user.id && existing.status === "PENDING";
  if (!isAdmin && !isOwnerSelfCancel) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (isAdmin) {
    // Guarded deleteMany (not delete): a concurrent delete between the stale read
    // above and here would make a bare delete throw P2025 → 500. count=0 means
    // the row is already gone — report 404, matching the pre-read above.
    const { count } = await prisma.mediaRequest.deleteMany({ where: { id } });
    if (count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } else {
    // Owner self-cancel: delete only if STILL pending. An admin may have approved
    // (and pushed to ARR) between the read above and here — a guarded deleteMany
    // makes the status check atomic so we never orphan an approved/grabbed request
    // behind a stale pre-read.
    const { count } = await prisma.mediaRequest.deleteMany({
      where: { id, requestedBy: session.user.id, status: "PENDING" },
    });
    if (count === 0) {
      return NextResponse.json({ error: "Request was already actioned — refresh and try again." }, { status: 409 });
    }
  }
  emitSSE({ type: "request:deleted", requestId: id, userId: existing.requestedBy });
  // Only an admin-initiated delete is an audit-worthy moderation action; a user
  // cancelling their own pending request is routine and stays out of the log.
  if (isAdmin) {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_DELETE", target: `request:${id}`, details: { title: existing.title, mediaType: existing.mediaType, year: existing.releaseYear, requestedBy: existing.user?.name ?? existing.user?.email ?? existing.requestedBy, before: { status: existing.status } }, ...auditContext(req, session) });
  }
  return NextResponse.json({ ok: true });
});
