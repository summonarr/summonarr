import { NextResponse, type NextRequest } from "next/server";
import { withIssueAdmin, type SummonarrSession } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import {
  searchMovieInRadarr,
  searchSeriesInSonarr,
  searchSeasonInSonarr,
  searchEpisodeInSonarr,
  resolveTvdbIdFromTmdbId,
  arrErrorMessage,
  ArrItemNotFoundError,
} from "@/lib/arr";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, logAuditTx, auditContext } from "@/lib/audit";
import { sanitizeOptional } from "@/lib/sanitize";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { recordIssueGrab } from "@/lib/issue-grab";
import { announceIssueResolved, promoteIssueInProgress } from "@/lib/issue-transitions";
import { issueArrService, resolveIssueArrInstance } from "@/lib/issue-arr-instance";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import type { Issue } from "@/generated/prisma";
import { arrServiceName } from "@/lib/arr-service-name";

const VALID_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];
// Every Refetch queues an automatic search across every indexer and records an
// IssueGrab row (kept, never pruned), and a MANAGE_ISSUES delegate can reach it —
// bounded per caller like the sibling Replace release / Replace file routes.
const REFETCH_LIMIT_PER_MIN = 10;
const MAX_RESOLUTION_LENGTH = 1000;

/**
 * Queue the refetch search of the issue's own scope on `instance`, resolving the
 * series' TVDB id when the row has none. Resolves to that TVDB id (null for a
 * movie); throws what the arr call threw.
 */
async function queueRefetchSearch(issue: Issue, instance: string): Promise<number | null> {
  if (issue.mediaType === "MOVIE") {
    await searchMovieInRadarr(issue.tmdbId, instance);
    return issue.tvdbId;
  }
  // Resolve authoritatively from tmdbId when the stored tvdbId is absent
  // (client-supplied tvdbId is no longer trusted, so older/null rows resolve here).
  const tvdbId = issue.tvdbId ?? (await resolveTvdbIdFromTmdbId(issue.tmdbId, instance));
  if (!tvdbId) throw new Error("Could not resolve a TVDB ID for this series — cannot search in Sonarr");
  if (issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null) {
    await searchEpisodeInSonarr(tvdbId, issue.seasonNumber, issue.episodeNumber, instance);
  } else if (issue.scope === "SEASON" && issue.seasonNumber != null) {
    await searchSeasonInSonarr(tvdbId, issue.seasonNumber, instance);
  } else {
    // Deliberately SeriesSearch: a refetch is an upgrade search of the
    // issue's own scope (the arr only replaces a file on disk with an
    // upgrade), the series-wide twin of the SeasonSearch/EpisodeSearch
    // above. The Missing plan would queue nothing whenever every episode
    // is on disk — exactly when the issue is about the files themselves.
    await searchSeriesInSonarr(tvdbId, instance);
  }
  return tvdbId;
}

// A search the arr did not take answers with the issue and an `arrError` (the
// wire shape the iOS app decodes; still 200 — the OpenAPI contract).
function refetchFailed(issue: Issue, instance: string, err: unknown, t: Translator): NextResponse {
  // The instance doesn't hold the title (removed there, or the reported copy
  // is on another instance): an answer the admin can act on, not a failure.
  if (err instanceof ArrItemNotFoundError) {
    const service = arrServiceName(issue.mediaType);
    const name = instance === "" ? service : `${service} (${instance})`;
    return NextResponse.json({ ...issue, arrError: t("apiUser.issues.replaceFile.notOnInstance", { name }) });
  }
  console.error("[arr] Issue refetch failed:", arrErrorMessage(err));
  return NextResponse.json({ ...issue, arrError: t("apiUser.issues.arrFailed") });
}

// PATCH { refetch: true, instance? }: search the issue's scope again on that
// instance. Takes precedence over status/resolution in the same body (the
// OpenAPI contract), and answers `{ ...issue, arrError }` — the wire shape the
// iOS app decodes.
async function handleRefetch(
  req: NextRequest,
  session: SummonarrSession,
  issue: Issue,
  rawInstance: unknown,
  t: Translator,
): Promise<NextResponse> {
  // Refuse a RESOLVED issue BEFORE contacting Radarr/Sonarr, as the sibling Replace
  // flow (issues/[id]/releases) does. The post-search status CAS below only avoids
  // flipping the status back — by then the search has already queued a download for
  // a closed issue (a stale tab, a native client, a direct API call).
  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: t("apiUser.issues.resolvedBeforeRefetch") }, { status: 409 });
  }
  // Which Radarr/Sonarr instance holds the copy this issue is about, resolved as
  // the Replace flow resolves it (issue-arr-instance.ts): absent ⇒ the default,
  // so every pre-existing caller is unchanged. Without this the search always
  // went to the DEFAULT instance: a SEASON issue filed against the 4K copy
  // re-grabbed and re-imported the HD one, leaving the reported problem
  // untouched while the issue moved to IN_PROGRESS as though it were handled.
  const instanceOr = await resolveIssueArrInstance(rawInstance, issueArrService(issue.mediaType), t);
  if (instanceOr instanceof NextResponse) return instanceOr;
  const instance = instanceOr;
  if (!checkRateLimit(`issue-refetch:${session.user.id}`, REFETCH_LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }
  let tvdbId: number | null;
  try {
    tvdbId = await queueRefetchSearch(issue, instance);
  } catch (err) {
    return refetchFailed(issue, instance, err, t);
  }

  // The arr has queued exactly one search, on `instance`. Record it as an
  // instance-scoped IssueGrab — as Replace release and Replace file do — so the
  // Download webhooks tell this admin when the refetched copy lands (they match
  // by title, instance and the issue's scope, never by release, so a search
  // matches like a grab). Kept OUTSIDE the try blocks that decide the answer:
  // the search was accepted, so a failure here (usually P2003 — the issue was
  // deleted meanwhile) must not read as the refetch failing, or the admin would
  // queue a second search. It supersedes this admin's earlier pending grabs of
  // the issue on this instance (one import, one announcement — recordIssueGrab).
  try {
    await recordIssueGrab({
      issueId: issue.id,
      triggeredById: session.user.id,
      tmdbId: issue.tmdbId,
      tvdbId,
      mediaType: issue.mediaType,
      title: issue.title,
      scope: issue.scope,
      seasonNumber: issue.seasonNumber,
      episodeNumber: issue.episodeNumber,
      arrInstance: instance,
    });
  } catch (err) {
    console.warn("[issues] Refetch search queued but recording the grab failed (issue deleted meanwhile?):", err);
  }

  try {
    // CAS on status: don't clobber a RESOLVED issue if another admin closed it
    // while the search was in flight (count 0 — the current, RESOLVED issue is
    // answered unchanged). An issue already IN_PROGRESS is not re-announced.
    await promoteIssueInProgress({ issue, from: "notResolved", trigger: "refetch", session, req });
    const updated = await prisma.issue.findUnique({ where: { id: issue.id } });
    return NextResponse.json({ ...(updated ?? issue), arrError: null });
  } catch (err) {
    // The search WAS queued, so this is not the arr failing: an `arrError`
    // here sent the admin to queue a second search for a database hiccup.
    // Logged, and the issue answered as it was read.
    console.error("[issues] Refetch search queued but updating the issue failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ...issue, arrError: null });
  }
}

/** What a status/resolution PATCH writes, decided before any write. */
interface IssueEdit {
  updateData: { status?: ValidStatus; resolution?: string | null; resolvedAt?: Date | null };
  isStatusChange: boolean;
}

// The status/resolution body → the write it asks for, or the 400 refusing it.
function planIssueEdit(issue: Issue, status: unknown, resolution: unknown, t: Translator): IssueEdit | NextResponse {
  if (status && !VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json(
      { error: t("apiUser.common.statusOneOf", { values: VALID_STATUSES.join(", ") }) },
      { status: 400 }
    );
  }
  // `resolution: null` reads as an empty note (below), never as "too long".
  if (resolution !== undefined && resolution !== null) {
    if (typeof resolution !== "string" || resolution.length > MAX_RESOLUTION_LENGTH) {
      return NextResponse.json({ error: t("apiUser.issues.resolutionTooLong") }, { status: 400 });
    }
  }
  const sanitizedResolution = typeof resolution === "string" ? sanitizeOptional(resolution) : null;
  // A provided-but-empty resolution (null, or empty/whitespace-only, which
  // sanitizes to null) is silently DROPPED below: clearing a stored resolution
  // on its own is intentionally unsupported — a reopen clears it. Reject it
  // loudly ONLY when it's the whole request (no status change), so an empty
  // resolution riding alongside a valid status transition never blocks that
  // transition (a native client may send both fields).
  if (resolution !== undefined && sanitizedResolution == null && !status) {
    return NextResponse.json({ error: t("apiUser.issues.resolutionEmpty") }, { status: 400 });
  }

  // Only a status that differs is a status change; re-sending the current one
  // (a native client may echo it beside a note) writes nothing for it.
  const isStatusChange = !!status && status !== issue.status;
  const updateData: IssueEdit["updateData"] = {};
  // resolvedAt follows the status transition only (a resolution-only edit leaves
  // it alone): stamped on → RESOLVED, cleared on any move away from it.
  if (isStatusChange) {
    updateData.status = status as ValidStatus;
    updateData.resolvedAt = status === "RESOLVED" ? new Date() : null;
  }
  if (sanitizedResolution != null) updateData.resolution = sanitizedResolution;
  // Reopening (RESOLVED → OPEN/IN_PROGRESS) clears the old resolution, matching the
  // reporter-reply reopen in the messages route. Otherwise a later re-resolve with no
  // new note falls back to `issue.resolution` and re-announces the EARLIER fix.
  if (sanitizedResolution == null && issue.status === "RESOLVED" && isStatusChange) {
    updateData.resolution = null;
  }
  return { updateData, isStatusChange };
}

// The write itself, or the refusal: a status change is a compare-and-swap on
// the status read (409 when another admin moved it first). The resolution-only
// update path is not gated — overwriting resolution text concurrently is a
// benign last-write-wins rather than a state-transition conflict. updateMany
// (not update) either way, so a concurrent delete is a 404, not a P2025 throw.
async function writeIssueEdit(issue: Issue, edit: IssueEdit, t: Translator): Promise<NextResponse | null> {
  const where = edit.isStatusChange ? { id: issue.id, status: issue.status } : { id: issue.id };
  const result = await prisma.issue.updateMany({ where, data: edit.updateData });
  if (result.count > 0) return null;
  return edit.isStatusChange
    ? NextResponse.json({ error: "status-conflict", message: t("apiUser.issues.modifiedConcurrently") }, { status: 409 })
    : NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
}

export const PATCH = withIssueAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const { id } = await params;

  const parsed = await readJsonCapped<{ status?: string; resolution?: unknown; refetch?: unknown; instance?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const { status, resolution, refetch } = parsed;
  // `refetch` queues a real search on every indexer, so only a boolean starts
  // one: `"false"` or `1` used to pass a truthiness test. Absent (or null) is
  // the status/resolution edit below.
  if (refetch !== undefined && refetch !== null && typeof refetch !== "boolean") {
    return NextResponse.json({ error: t("apiUser.issues.refetchInvalid") }, { status: 400 });
  }

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  if (refetch === true) return handleRefetch(req, session, issue, parsed.instance, t);

  const edit = planIssueEdit(issue, status, resolution, t);
  if (edit instanceof NextResponse) return edit;
  // Nothing to change (an empty body, or only the current status): answer the
  // issue as it is — no write, no issue:updated broadcast, no audit.
  if (Object.keys(edit.updateData).length === 0) return NextResponse.json(issue);

  const refused = await writeIssueEdit(issue, edit, t);
  if (refused) return refused;

  const updated = await prisma.issue.findUnique({ where: { id } });
  if (!updated) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  emitSSE({ type: "issue:updated", issueId: id, status: updated.status, userId: issue.reportedBy });

  // The resolution this write left on the row: what it set (a new note, or the
  // null a reopen clears it to), else the one it kept.
  const resolutionAfter = edit.updateData.resolution !== undefined ? edit.updateData.resolution : issue.resolution;
  if (edit.isStatusChange) {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "ISSUE_STATUS_CHANGE", target: `issue:${id}`, details: { title: issue.title, before: { status: issue.status }, after: { status: edit.updateData.status, resolution: resolutionAfter } }, ...auditContext(req, session) });
  }

  if (edit.updateData.status === "RESOLVED") {
    // The issue.resolved event, then the reporter's Discord, push and inbox row
    // behind one deactivatedAt read (guardrail 33) — skipped when an issue admin
    // resolves their OWN report (on a single-admin instance the common case).
    await announceIssueResolved(issue, resolutionAfter, session.user.id);
  }

  return NextResponse.json(updated);
});

export const DELETE = withIssueAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  // The last mutation in the issues/votes family that was missing this, and not
  // a harmless omission: withIssueAdmin is authoritative on MANAGE_ISSUES, while
  // maintenanceGuard exempts only the ADMIN superbit — and the ISSUE_ADMIN
  // preset carries MANAGE_ISSUES WITHOUT ADMIN. So during maintenance an issue
  // admin was refused every other action here and could still hard-delete a
  // row, which is the most destructive one in the family.
  const maintenance = await maintenanceGuard(session);
  if (maintenance) return maintenance;

  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  const ctx = auditContext(req, session);
  // The audit row is written in the delete's own transaction, after it, so a
  // failed audit write rolls the delete back (guardrail 26) — through the shared
  // row builder, which sanitizes the client-supplied user agent.
  await prisma.$transaction(async (tx) => {
    await tx.issue.delete({ where: { id } });
    await logAuditTx(tx, {
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ISSUE_DELETE",
      target: `issue:${id}`,
      details: { action: "delete", title: issue.title, mediaType: issue.mediaType },
      ...ctx,
    });
  });

  emitSSE({ type: "issue:deleted", issueId: id, userId: issue.reportedBy });

  return NextResponse.json({ ok: true });
});
