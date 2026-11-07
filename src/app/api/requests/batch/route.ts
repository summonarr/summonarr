import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { addMovieToRadarr, addSeriesToSonarr, arrErrorMessage, arrErrorMessageForClient, arrWriteOutcomeUnknown, type AddProgress } from "@/lib/arr";
import { notifyRequestStatusChanges } from "@/lib/request-notifications";
import { emitSSE } from "@/lib/sse-emitter";
import { DOWNLOAD_CHECK_DELAY_MS, scheduleDownloadChecks } from "@/lib/download-check";
import { sanitizeOptional } from "@/lib/sanitize";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { maintenanceGuard } from "@/lib/maintenance";
import { settleLimit } from "@/lib/concurrency";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import type { Translator } from "@/lib/i18n/translate";

// Cap concurrent ARR pushes (guardrail 31) — mirrors the bulk route's
// ARR_CONCURRENCY so a large batch approve doesn't burst every Radarr/Sonarr
// add at once.
const ARR_CONCURRENCY = 5;

const VALID_STATUSES = ["APPROVED", "DECLINED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiUser.requests.batch.rateLimited") }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ ids?: unknown; status?: unknown; adminNote?: unknown; permanent?: unknown }>(req, 1048576);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { ids, status, adminNote, permanent } = body;

  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return NextResponse.json({ error: t("apiUser.requests.batch.idsInvalid") }, { status: 400 });
  }
  if (!ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: t("apiUser.requests.batch.idsStrings") }, { status: 400 });
  }
  if (!VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json({ error: t("apiUser.requests.batch.statusInvalid") }, { status: 400 });
  }
  if (adminNote !== undefined && (typeof adminNote !== "string" || adminNote.length > ADMIN_NOTE_MAX)) {
    return NextResponse.json({ error: t("apiUser.common.adminNoteTooLong") }, { status: 400 });
  }
  if (permanent !== undefined && typeof permanent !== "boolean") {
    return NextResponse.json({ error: t("apiUser.requests.batch.permanentBoolean") }, { status: 400 });
  }

  const typedIds = ids as string[];
  const typedStatus = status as ValidStatus;
  const typedAdminNote = sanitizeOptional(adminNote as string | undefined);
  const typedPermanent = permanent === true && typedStatus === "DECLINED";

  // Permanent declines are terminal (block re-requests); cap below the general 100 ceiling
  // so an admin can't blast 100 users' requests into the permanent state in a single click.
  if (typedPermanent && typedIds.length > 25) {
    return NextResponse.json(
      // Human text in `error` like every sibling 400 (both web callers render
      // `data.error` verbatim); the machine token rides under `code`.
      { error: t("apiUser.requests.batch.permanentTooMany"), code: "permanent-batch-too-large" },
      { status: 400 },
    );
  }

  const pendingNotifyAt = typedStatus === "APPROVED" ? new Date(Date.now() + DOWNLOAD_CHECK_DELAY_MS) : null;

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
      // The approval the watch grade reads (MediaRequest.approvedAt): stamped on
      // approve, withdrawn on decline — a PENDING row can carry one from an
      // approval whose push failed and rolled back.
      approvedAt: typedStatus === "APPROVED" ? new Date() : null,
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
  // Why each failed push failed, returned to the caller. The batch used to answer a
  // bare { ok: true } regardless, so the admin saw a clean approve while the rows
  // quietly went back to PENDING — the reason existed only in the server log.
  const failureReasons = new Map<string, string>();
  let failures: { id: string; title: string; error: string }[] = [];
  // Rows whose add was SENT but got no definite answer (a timeout, a dropped
  // connection, a gateway 502/504). The arr may have added the title, so they
  // stay APPROVED like the single PATCH; the sync re-pushes an APPROVED title
  // the arr doesn't hold. Never in failedIds.
  const outcomeUnknownIds = new Set<string>();

  if (typedStatus === "APPROVED") {
    // Load the full rows for just the ids THIS call claimed (the claim above
    // returned only id + requestedBy), so already-approved rows are never re-pushed.
    const approved = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "APPROVED" },
    });

    await settleLimit(approved, ARR_CONCURRENCY, async (r) => {
      let pushedTvdbId: number | null = null;
      const pushProgress: AddProgress = { sent: false };
      try {
        const variant = r.arrInstance;
        // Honor the profile the requester chose at request time (REQUEST_ADVANCED);
        // absent ⇒ the instance default. Mirrors requests/[id] effectiveProfileId
        // and the sync re-push — batch approve previously discarded it.
        const profileId = r.qualityProfileId ?? undefined;
        if (r.mediaType === "MOVIE") {
          await addMovieToRadarr(r.tmdbId, variant, profileId, r.requestedBy, pushProgress);
        } else {
          pushedTvdbId = await addSeriesToSonarr(r.tmdbId, variant, profileId, r.requestedBy, pushProgress);
        }
      } catch (err) {
        // Unknown only once the add itself was sent: a failure before it (a
        // lookup, a dark arr refusing the connection) added nothing.
        if (pushProgress.sent && arrWriteOutcomeUnknown(err)) {
          console.error("[arr] Batch approve push outcome unknown, left APPROVED:", r.id, arrErrorMessage(err));
          outcomeUnknownIds.add(r.id);
        } else {
          console.error("[arr] Batch approve push failed for", r.id, arrErrorMessage(err));
          failedIds.add(r.id);
          // The kind, never the arr's internal URL: the caller may be a delegate (guardrail 5g).
          failureReasons.set(r.id, arrErrorMessageForClient(err, t));
        }
      }
      // Bookkeeping write kept OUT of the try above: Sonarr has already accepted the
      // series by this point, so a P2025 (row deleted mid-push) or transient DB error
      // must not land the id in failedIds and roll a genuinely-grabbed request back to
      // PENDING. updateMany no-ops on a concurrently deleted row instead of throwing.
      if (pushedTvdbId !== null) {
        await prisma.mediaRequest.updateMany({ where: { id: r.id }, data: { tvdbId: pushedTvdbId } });
      }
    });

    // In `approved` order, not completion order, so the reported list is stable.
    failures = approved
      .filter((r) => failedIds.has(r.id))
      .map((r) => ({ id: r.id, title: r.title, error: failureReasons.get(r.id) ?? t("apiUser.requests.batch.arrFailedDefault") }));

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
    // The fan-out is the single decision's, for many rows: disabled owners are
    // dropped once there, for every channel (guardrails 14c, 33).
    void notifyRequestStatusChanges(
      "APPROVED",
      approved.filter((r) => !failedIds.has(r.id) && r.requestedBy !== session.user.id),
      "requests/batch",
    );
  }

  if (typedStatus === "DECLINED") {
    // Mirror the APPROVED path: notify only the rows this batch actually transitioned
    // (PENDING → DECLINED), not ids that were already DECLINED before the call — those
    // were left untouched by the claim above and must not get a duplicate decline ping.
    // Each row's note as the decline left it — the one this call wrote, else the
    // one already stored — exactly what the single decline sends.
    const declined = await prisma.mediaRequest.findMany({
      where: { id: { in: [...pendingBeforeIds] }, status: "DECLINED" },
      select: { id: true, requestedBy: true, title: true, mediaType: true, tmdbId: true, posterPath: true, arrInstance: true, adminNote: true },
    });
    // Skip rows the acting admin owns — no self-notification for one's own request.
    void notifyRequestStatusChanges("DECLINED", declined.filter((r) => r.requestedBy !== session.user.id), "requests/batch");
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
  // the (capped) typedIds list is preserved in full so the trail is reproducible,
  // beside what actually happened: `claimedIds` are the rows THIS call moved off
  // PENDING (an id already non-PENDING, or claimed by a concurrent batch, is not
  // among them), `rolledBackIds` the approvals whose push failed and went back to
  // PENDING, and `transitioned` the rows left in the batch's target status.
  // Request ids only — batch rows name no requester (guardrail 33).
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
      claimedIds,
      rolledBackIds: [...failedIds],
      ...(outcomeUnknownIds.size > 0 ? { outcomeUnknownIds: [...outcomeUnknownIds] } : {}),
      transitioned: claimedIds.length - failedIds.size,
      adminNote: typedAdminNote ?? null,
      permanent: typedPermanent,
    },
    ...auditContext(req, session),
  });

  // Additive: `failed` lists every row whose push failed and was rolled back to
  // PENDING; `arrError` is the one-line summary the single-request PATCH already
  // returns under the same name, which the group Approve button renders as-is.
  // Both are omitted when every push landed, so a clean batch reads as before.
  // Additive: `outcomeUnknown` lists the ids whose add got no answer and that
  // stay APPROVED (never in `failed`, which the queue keeps selected for retry).
  return NextResponse.json({
    ok: true,
    ...(failures.length > 0 ? { failed: failures, arrError: summarizeArrFailures(failures, t) } : {}),
    ...(outcomeUnknownIds.size > 0 ? { outcomeUnknown: [...outcomeUnknownIds] } : {}),
  });
});

// Names the first few failures with their reasons and counts the rest, so a
// 100-row batch can't produce an unbounded message.
function summarizeArrFailures(failures: { title: string; error: string }[], t: Translator): string {
  const SHOWN = 3;
  const list = failures.slice(0, SHOWN).map((f) => `"${f.title}": ${f.error}`).join("; ");
  const count = failures.length;
  return count > SHOWN
    ? t("apiUser.requests.batch.arrFailedMore", { count, list, more: count - SHOWN })
    : t("apiUser.requests.batch.arrFailed", { count, list });
}
