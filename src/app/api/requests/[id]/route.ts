import { NextResponse } from "next/server";
import { withAuth, withPermission, type SummonarrSession } from "@/lib/api-auth";
import { Permission, hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { searchMovieInRadarr, arrErrorMessage, arrErrorMessageForClient, ArrItemNotFoundError, listQualityProfiles } from "@/lib/arr";
import { MissingInstanceError, NothingMissingError, SeriesNotOnInstanceError, findSeriesIdOnInstance, searchMissing } from "@/lib/arr-missing-data";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, auditContext } from "@/lib/audit";
import { requesterAuditDetails } from "@/lib/audit-scrub";
import { sanitizeOptional } from "@/lib/sanitize";
import { notifyRequestStatusChange } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import type { Translator } from "@/lib/i18n/translate";
import {
  REQUEST_STATUSES,
  addRequestToArr,
  announceStatus,
  approvalAuditDetails,
  claimApproval,
  claimDecline,
  claimMarkAvailable,
  claimReopen,
  declineAuditDetails,
  followUpDecidedApprovals,
  isAllowedTransition,
  isRequestStatus,
  notifyDecided,
  pushApproval,
  stampTvdbId,
} from "@/lib/request-transition";

// Longest quality-profile name the audit row records beside the id.
const QUALITY_PROFILE_NAME_MAX = 100;

export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`admin-req:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const { id } = await params;

  const raw = await readJsonCapped<Record<string, unknown>>(req, 16384);
  if (raw instanceof NextResponse) return raw;
  const body = parsePatchBody(raw, t);
  if (body instanceof NextResponse) return body;

  const existing = await loadRequest(id);
  if (!existing) return notFound(t);

  const pc: PatchContext = { req, session, t, id, existing, adminNote: body.adminNote, sanitizedAdminNote: sanitizeOptional(body.adminNote) };
  if (body.search) return searchRequest(pc);
  if (body.retry) return retryRequest(pc);
  // Note-only edit: `adminNote` with no status/search/retry updates the admin
  // reply in place (an empty note clears it — sanitizeOptional maps "" to null).
  // Status transitions below stay strictly validated; the old client behavior of
  // sending the CURRENT status alongside the note always 422'd on the
  // same-status transition, so a standalone note edit needs its own path.
  if (body.status === undefined && body.adminNote !== undefined) return editNote(pc);
  return transitionRequest(pc, body);
});

// The PATCH body, narrowed field by field: readJsonCapped proves only that it
// is a JSON object.
interface PatchBody {
  // Checked by transitionRequest, which answers the 400 that names the values.
  status: unknown;
  // Strictly `true`: a truthy non-boolean such as "false" must not trigger an
  // arr search or re-push.
  search: boolean;
  retry: boolean;
  // Qualifies a decline only.
  permanent: boolean;
  adminNote: string | undefined;
  // Optional one-time quality-profile override for the ARR push on approval,
  // ignored on other transitions. The name is carried purely so the audit log
  // reads "720p" instead of a bare id.
  qualityProfileId: number | undefined;
  qualityProfileName: string | undefined;
}

function parsePatchBody(raw: Record<string, unknown>, t: Translator): PatchBody | NextResponse {
  const { adminNote, qualityProfileId, qualityProfileName } = raw;
  if (adminNote !== undefined && (typeof adminNote !== "string" || adminNote.length > ADMIN_NOTE_MAX)) {
    return NextResponse.json({ error: t("apiUser.common.adminNoteTooLong") }, { status: 400 });
  }
  if (qualityProfileId !== undefined && (typeof qualityProfileId !== "number" || !Number.isInteger(qualityProfileId) || qualityProfileId <= 0)) {
    return NextResponse.json({ error: t("apiUser.requests.qualityProfileIdInvalid") }, { status: 400 });
  }
  if (qualityProfileName !== undefined && (typeof qualityProfileName !== "string" || qualityProfileName.length > QUALITY_PROFILE_NAME_MAX)) {
    return NextResponse.json({ error: t("apiUser.requests.qualityProfileNameTooLong") }, { status: 400 });
  }
  return {
    status: raw.status,
    search: raw.search === true,
    retry: raw.retry === true,
    permanent: raw.permanent === true,
    adminNote,
    qualityProfileId,
    qualityProfileName,
  };
}

function loadRequest(id: string) {
  return prisma.mediaRequest.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } } } });
}

type ExistingRequest = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

// What every PATCH mode reads: the caller, the row as read at the start, and
// the body's note (raw, to tell "absent" from "cleared", and sanitized).
interface PatchContext {
  req: Request;
  session: SummonarrSession;
  t: Translator;
  id: string;
  existing: ExistingRequest;
  adminNote: string | undefined;
  sanitizedAdminNote: string | null;
}

function notFound(t: Translator): NextResponse {
  return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
}

// The transition table ran against the read at the start; the claim's
// compare-and-swap found the row moved since.
function conflict(t: Translator): NextResponse {
  return NextResponse.json({ error: t("apiUser.requests.modifiedConcurrently") }, { status: 409 });
}

// The note a transition writes: the body's, sanitized, only when it sent one.
// Guarding on the RAW field matters: sanitizeOptional maps undefined to null, so
// the sanitized value alone would wipe the stored note on every transition.
function noteWrite(pc: PatchContext): string | null | undefined {
  return pc.adminNote !== undefined ? pc.sanitizedAdminNote : undefined;
}

// Writes the body's admin note when one was sent, and audits a change of it.
// updateMany, like every other write in this handler: a bare update throws P2025
// when the row is deleted between the read and this write, and nothing catches
// it — a concurrent delete would answer 500 where DELETE answers 404. Returns
// that 404, or null to carry on. The audit runs after the write has committed,
// so it is the swallowing logAudit (guardrail 26); `via` names the mode, so a
// silent edit through search or retry still leaves a trail.
async function writeAdminNote(pc: PatchContext, via: "search" | "retry" | "note"): Promise<NextResponse | null> {
  const { req, session, t, id, existing, adminNote, sanitizedAdminNote } = pc;
  if (adminNote === undefined) return null;
  const noteWritten = await prisma.mediaRequest.updateMany({ where: { id }, data: { adminNote: sanitizedAdminNote } });
  if (noteWritten.count === 0) return notFound(t);
  if ((existing.adminNote ?? null) !== (sanitizedAdminNote ?? null)) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? "unknown",
      action: "SETTINGS_CHANGE",
      target: `request:${id}:adminNote`,
      details: { via, from: existing.adminNote ?? null, to: sanitizedAdminNote ?? null },
      ...auditContext(req, session),
    });
  }
  return null;
}

// The note the answer carries: the one just written, else the stored one.
function answeredNote(pc: PatchContext): string | null {
  return pc.adminNote !== undefined ? pc.sanitizedAdminNote : pc.existing.adminNote;
}

// What a Search queues: the movie, or the series by the tvdbId the push
// stored. A TV request with none was never pushed (or predates the bookkeeping
// write) and has nothing to search.
type SearchTarget = { kind: "movie"; tmdbId: number } | { kind: "series"; tvdbId: number };

function searchTargetOf(existing: ExistingRequest): SearchTarget | null {
  if (existing.mediaType === "MOVIE") return { kind: "movie", tmdbId: existing.tmdbId };
  return existing.tvdbId ? { kind: "series", tvdbId: existing.tvdbId } : null;
}

// Queues the search on the request's own instance (guardrail 32) and answers the
// translated arrError, or null when everything queued.
async function queueSearch(target: SearchTarget, variant: string, t: Translator): Promise<string | null> {
  if (target.kind === "movie") {
    await searchMovieInRadarr(target.tmdbId, variant);
    return null;
  }
  // NEVER SeriesSearch: it searches every monitored season, files on disk
  // included, so a partly downloaded series also gets upgrade grabs and a
  // season search per COMPLETE season. Queue the Missing page's plan
  // instead (planSeriesSearch — SeasonSearch for a season with nothing on
  // disk, one EpisodeSearch for the rest), judged live.
  const seriesId = await findSeriesIdOnInstance(variant, target.tvdbId);
  const result = await searchMissing("sonarr", variant, seriesId, new Date());
  // Sonarr refused a command part-way: what was queued IS running, but the
  // rest wasn't — a bare success would say the whole plan started.
  return result.partial ? t("apiUser.requests.searchPartial") : null;
}

// A search that threw, as the caller is answered. Most are answers, not
// failures, and are translated; the rest are logged.
function searchFailureText(err: unknown, t: Translator): string {
  // No aired, monitored episode is missing — every one is on disk, OR none is
  // monitored (a series added with "Monitor: Future"), so the wording claims
  // neither. An upgrade search is the title manager's, never this button's.
  if (err instanceof NothingMissingError) return t("apiUser.requests.searchNothingMissing");
  // Its message is the bare slug ("" for the default instance) — relayed
  // through arrErrorMessage it would read as an empty, i.e. successful, answer.
  if (err instanceof MissingInstanceError) return t("apiUser.requests.searchInstanceUnavailable");
  // Removed in Sonarr since the push (or pushed elsewhere): Re-push adds it back.
  if (err instanceof SeriesNotOnInstanceError) return t("apiUser.requests.searchSeriesNotInSonarr");
  // The movie twin: Radarr no longer holds it, and Re-push adds it back.
  if (err instanceof ArrItemNotFoundError) return t("apiUser.requests.releases.notInArr", { service: "Radarr" });
  // The detail to the log; the caller (a MANAGE_REQUESTS delegate, maybe) gets
  // the failure's kind, never the arr's internal URL (guardrail 5g).
  console.error("[arr] Search failed:", arrErrorMessage(err));
  return arrErrorMessageForClient(err, t);
}

async function searchRequest(pc: PatchContext): Promise<NextResponse> {
  const { t, existing } = pc;
  if (existing.status !== "APPROVED" && existing.status !== "AVAILABLE") {
    return NextResponse.json({ error: t("apiUser.requests.searchInvalidStatus") }, { status: 400 });
  }

  const missing = await writeAdminNote(pc, "search");
  if (missing) return missing;
  const searchedNote = answeredNote(pc);
  const target = searchTargetOf(existing);
  // Answered with a translated arrError rather than an English Error thrown into
  // the generic arr failure below.
  if (!target) {
    return NextResponse.json({ ...existing, adminNote: searchedNote, arrError: t("apiUser.requests.searchNoTvdbId") });
  }
  let arrError: string | null;
  try {
    arrError = await queueSearch(target, existing.arrInstance, t);
  } catch (err) {
    arrError = searchFailureText(err, t);
  }
  return NextResponse.json({ ...existing, adminNote: searchedNote, arrError });
}

// Re-push an APPROVED request whose title the arr may have lost, with its
// stored profile — the admin's approve-time choice or the requester's. A failed
// re-push answers the arr's error and leaves the row APPROVED: unlike an
// approval, there is no decision to roll back.
async function retryRequest(pc: PatchContext): Promise<NextResponse> {
  const { t, id, existing } = pc;
  if (existing.status !== "APPROVED") {
    return NextResponse.json({ error: t("apiUser.requests.retryInvalidStatus") }, { status: 400 });
  }

  const missing = await writeAdminNote(pc, "retry");
  if (missing) return missing;
  let arrError: string | null = null;
  let pushedTvdbId: number | null = null;
  try {
    pushedTvdbId = await addRequestToArr(existing);
  } catch (err) {
    console.error("[arr] Retry push failed:", arrErrorMessage(err));
    arrError = arrErrorMessageForClient(err, t);
  }
  // Outside the try: Sonarr has already accepted the series, so a DB hiccup
  // here must not be reported as an ARR push failure.
  if (pushedTvdbId !== null) await stampTvdbId(id, pushedTvdbId);
  return NextResponse.json({ ...existing, adminNote: answeredNote(pc), arrError });
}

async function editNote(pc: PatchContext): Promise<NextResponse> {
  const { t, id } = pc;
  const missing = await writeAdminNote(pc, "note");
  if (missing) return missing;
  const noted = await loadRequest(id);
  if (!noted) return notFound(t);
  announceStatus(noted, noted.status);
  return NextResponse.json(noted);
}

// A status change, dispatched per target. The transition table rules out a
// same-status "transition", so each handler knows the row really moves.
async function transitionRequest(pc: PatchContext, body: PatchBody): Promise<NextResponse> {
  const { t, existing } = pc;
  const status = body.status;
  if (!isRequestStatus(status)) {
    return NextResponse.json({ error: t("apiUser.common.statusOneOf", { values: REQUEST_STATUSES.join(", ") }) }, { status: 400 });
  }
  if (!isAllowedTransition(existing.status, status)) {
    return NextResponse.json({ error: t("apiUser.requests.invalidTransition", { from: existing.status, to: status }) }, { status: 422 });
  }
  switch (status) {
    case "APPROVED":
      return approveRequest(pc, body);
    case "DECLINED":
      return declineRequest(pc, body.permanent);
    case "AVAILABLE":
      return markAvailable(pc);
    case "PENDING":
      return reopenRequest(pc);
  }
}

// Validate the one-time profile override against the request's OWN instance
// BEFORE the claim — the same membership check the create path runs
// (request-create.ts). A stale picker id (profile deleted in Radarr/Sonarr since
// the list loaded) otherwise approved the row, audited the approval, had the arr
// answer 400 and rolled back, surfacing a generic "Arr request failed (400)".
async function refuseUnlistedProfile(pc: PatchContext, qualityProfileId: number): Promise<NextResponse | null> {
  const { t, existing } = pc;
  const service = existing.mediaType === "MOVIE" ? "radarr" : "sonarr";
  let profileList: Awaited<ReturnType<typeof listQualityProfiles>>;
  try {
    profileList = await listQualityProfiles(service, existing.arrInstance);
  } catch (err) {
    console.error(`[requests] Failed to fetch ${service} profiles:`, err);
    return NextResponse.json({ error: t("apiUser.common.couldNotConnect", { service }) }, { status: 502 });
  }
  if (!profileList || !profileList.profiles.some((p) => p.id === qualityProfileId)) {
    return NextResponse.json({ error: t("apiUser.create.profileInvalid") }, { status: 400 });
  }
  return null;
}

async function approveRequest(pc: PatchContext, body: PatchBody): Promise<NextResponse> {
  const { req, session, t, id, existing } = pc;
  const { qualityProfileId, qualityProfileName } = body;
  if (qualityProfileId !== undefined) {
    const refusal = await refuseUnlistedProfile(pc, qualityProfileId);
    if (refusal) return refusal;
  }
  // The admin's picker choice is stored on the row, so the push below, a later
  // Re-push and the sync's re-push all use it; without one the row keeps the
  // requester's choice, else the instance default.
  if (!(await claimApproval(id, existing.status, { adminNote: noteWrite(pc), qualityProfileId }))) return conflict(t);

  const updated = await loadRequest(id);
  if (!updated) return notFound(t);
  announceStatus(updated, updated.status);

  const outcome = await pushApproval(updated, "Approve");
  // Post-commit, so the swallowing variant (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "REQUEST_APPROVE",
    target: `request:${id}`,
    details: {
      ...approvalAuditDetails(existing, existing.status, outcome),
      ...(qualityProfileId !== undefined ? { qualityProfileId, qualityProfileName: qualityProfileName ?? null } : {}),
    },
    ...auditContext(req, session),
  });
  followUpDecidedApprovals([{ row: updated, outcome }], {
    actorId: session.user.id,
    checkName: "requests:90s-download-check",
    logScope: "requests",
  });

  // `updated` was read before the push; after a rollback it is stale (APPROVED +
  // armed pendingNotifyAt for a row that is PENDING again). A bearer/native
  // client has no SSE stream to correct it, so the body reflects the rolled-back
  // state — the same contract as the POST auto-approve. `arrError` names any
  // failure's kind, never the arr's address (guardrail 5g). Additive:
  // `arrPushOutcomeUnknown` marks an APPROVED row whose push got no answer.
  return NextResponse.json({
    ...updated,
    ...(outcome.kind === "rolled-back" ? { status: "PENDING", pendingNotifyAt: null } : {}),
    arrError: outcome.kind === "pushed" ? null : arrErrorMessageForClient(outcome.error, t),
    ...(outcome.kind === "unknown" ? { arrPushOutcomeUnknown: true } : {}),
  });
}

async function declineRequest(pc: PatchContext, permanent: boolean): Promise<NextResponse> {
  const { req, session, t, id, existing } = pc;
  if (!(await claimDecline(id, existing.status, { permanent, adminNote: noteWrite(pc) }))) return conflict(t);

  const updated = await loadRequest(id);
  if (!updated) return notFound(t);
  announceStatus(updated, updated.status);
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "REQUEST_DECLINE",
    target: `request:${id}`,
    details: declineAuditDetails({ ...existing, adminNote: updated.adminNote }, existing.status),
    ...auditContext(req, session),
  });
  // The note as the decline left it: the one it wrote, else the stored one.
  void notifyDecided("DECLINED", [updated], session.user.id, "requests");
  return NextResponse.json(updated);
}

// The manual "mark available". Its "now available" fan-out is a once-only
// claim like every other path's (guardrail 14): a sync or webhook may have
// announced the title already. A failed claim write announces nothing.
async function claimAvailableNotice(id: string): Promise<boolean> {
  try {
    const cas = await prisma.mediaRequest.updateMany({ where: { id, notifiedAvailable: false }, data: { notifiedAvailable: true } });
    return cas.count === 1;
  } catch (err) {
    console.error("[requests] Failed to CAS notifiedAvailable:", err);
    return false;
  }
}

async function markAvailable(pc: PatchContext): Promise<NextResponse> {
  const { session, t, id, existing } = pc;
  if (!(await claimMarkAvailable(id, existing.status, { adminNote: noteWrite(pc), stampAvailableAt: !existing.availableAt }))) {
    return conflict(t);
  }
  const updated = await loadRequest(id);
  if (!updated) return notFound(t);
  announceStatus(updated, updated.status);

  if (await claimAvailableNotice(id)) {
    void clearDeletionVotesForTmdbs([{ tmdbId: updated.tmdbId, mediaType: updated.mediaType }]);
    // An admin marking their own request needs no "your request is available".
    if (updated.requestedBy !== session.user.id) {
      notifyRequestStatusChange("AVAILABLE", { requestedBy: updated.requestedBy, title: updated.title, mediaType: updated.mediaType, posterPath: updated.posterPath, tmdbId: updated.tmdbId, requestId: updated.id, arrInstance: updated.arrInstance });
    }
  }
  return NextResponse.json(updated);
}

async function reopenRequest(pc: PatchContext): Promise<NextResponse> {
  const { t, id, existing } = pc;
  if (!(await claimReopen(id, existing.status, { adminNote: noteWrite(pc) }))) return conflict(t);
  const updated = await loadRequest(id);
  if (!updated) return notFound(t);
  announceStatus(updated, updated.status);
  return NextResponse.json(updated);
}

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
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const { id } = await params;
  const existing = await loadRequest(id);
  if (!existing) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  const isAdmin = hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS);
  const isOwnerSelfCancel =
    existing.requestedBy === session.user.id && existing.status === "PENDING";
  if (!isAdmin && !isOwnerSelfCancel) {
    return NextResponse.json({ error: t("apiUser.common.forbidden") }, { status: 403 });
  }

  if (isAdmin) {
    // Guarded deleteMany (not delete): a concurrent delete between the stale read
    // above and here would make a bare delete throw P2025 → 500. count=0 means
    // the row is already gone — report 404, matching the pre-read above.
    const { count } = await prisma.mediaRequest.deleteMany({ where: { id } });
    if (count === 0) {
      return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiUser.requests.alreadyActioned") }, { status: 409 });
    }
  }
  emitSSE({ type: "request:deleted", requestId: id, userId: existing.requestedBy });
  // Only an admin-initiated delete is an audit-worthy moderation action; a user
  // cancelling their own pending request is routine and stays out of the log.
  if (isAdmin) {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "REQUEST_DELETE", target: `request:${id}`, details: { title: existing.title, mediaType: existing.mediaType, year: existing.releaseYear, ...requesterAuditDetails(existing.requestedBy, existing.user?.name), before: { status: existing.status } }, ...auditContext(req, session) });
  }
  return NextResponse.json({ ok: true });
});
