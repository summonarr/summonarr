import { NextResponse, type NextRequest } from "next/server";
import { withIssueAdmin, type SummonarrSession } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { isValidInstanceSlug } from "@/lib/arr-instances";
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
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import type { Issue } from "@/generated/prisma";

const VALID_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];
// Every Refetch queues an automatic search across every indexer and records an
// IssueGrab row (kept, never pruned), and a MANAGE_ISSUES delegate can reach it —
// bounded per caller like the sibling Replace release / Replace file routes.
const REFETCH_LIMIT_PER_MIN = 10;

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
  const id = issue.id;
  // Refuse a RESOLVED issue BEFORE contacting Radarr/Sonarr, as the sibling Replace
  // flow (issues/[id]/releases) does. The post-search status CAS below only avoids
  // flipping the status back — by then the search has already queued a download for
  // a closed issue (a stale tab, a native client, a direct API call).
  if (issue.status === "RESOLVED") {
    return NextResponse.json({ error: t("apiUser.issues.resolvedBeforeRefetch") }, { status: 409 });
  }
  // Which Radarr/Sonarr instance holds the copy this issue is about. Issue has no
  // arrInstance column — the same title can sit on several instances — so the caller
  // names it, exactly as the sibling Replace flow does (issues/[id]/releases). Absent
  // ⇒ the default, so every pre-existing caller is unchanged.
  //
  // Without this the search always went to the DEFAULT instance: a SEASON issue filed
  // against the 4K copy re-grabbed and re-imported the HD one, leaving the reported
  // problem untouched while the issue moved to IN_PROGRESS as though it were handled.
  // Validated, never coerced — a bad slug must not silently retarget the default.
  const instance = typeof rawInstance === "string" ? rawInstance.trim() : "";
  if (!isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiUser.common.invalidInstance") }, { status: 400 });
  }
  if (!checkRateLimit(`issue-refetch:${session.user.id}`, REFETCH_LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }
  // A failed search — and, as before, a failed status write after it — answers
  // with the issue and an `arrError` (the wire shape the iOS app decodes).
  const refetchFailed = (err: unknown) => {
    // The instance doesn't hold the title (removed there, or the reported copy
    // is on another instance): an answer the admin can act on, not a failure.
    if (err instanceof ArrItemNotFoundError) {
      const service = issue.mediaType === "MOVIE" ? "Radarr" : "Sonarr";
      const name = instance === "" ? service : `${service} (${instance})`;
      return NextResponse.json({ ...issue, arrError: t("apiUser.issues.replaceFile.notOnInstance", { name }) });
    }
    console.error("[arr] Issue refetch failed:", arrErrorMessage(err));
    return NextResponse.json({ ...issue, arrError: t("apiUser.issues.arrFailed") });
  };
  let tvdbId: number | null = issue.tvdbId;
  try {
    if (issue.mediaType === "MOVIE") {
      await searchMovieInRadarr(issue.tmdbId, instance);
    } else {
      // Resolve authoritatively from tmdbId when the stored tvdbId is absent
      // (client-supplied tvdbId is no longer trusted, so older/null rows resolve here).
      tvdbId = issue.tvdbId ?? (await resolveTvdbIdFromTmdbId(issue.tmdbId, instance));
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
    }
  } catch (err) {
    return refetchFailed(err);
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
      issueId: id,
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
    const updated = await prisma.issue.findUnique({ where: { id } });
    return NextResponse.json({ ...(updated ?? issue), arrError: null });
  } catch (err) {
    return refetchFailed(err);
  }
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

  const parsed = await readJsonCapped<{ status?: string; resolution?: string; refetch?: unknown; instance?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { status, resolution, refetch } = body;
  // `refetch` queues a real search on every indexer, so only a boolean starts
  // one: `"false"` or `1` used to pass a truthiness test. Absent (or null) is
  // the status/resolution edit below.
  if (refetch !== undefined && refetch !== null && typeof refetch !== "boolean") {
    return NextResponse.json({ error: t("apiUser.issues.refetchInvalid") }, { status: 400 });
  }

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  if (refetch === true) return handleRefetch(req, session, issue, body.instance, t);

  if (status && !VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json(
      { error: t("apiUser.common.statusOneOf", { values: VALID_STATUSES.join(", ") }) },
      { status: 400 }
    );
  }

  if (resolution !== undefined) {
    if (typeof resolution !== "string" || resolution.length > 1000) {
      return NextResponse.json({ error: t("apiUser.issues.resolutionTooLong") }, { status: 400 });
    }
  }
  const sanitizedResolution = sanitizeOptional(resolution);
  // A provided-but-empty resolution (empty/whitespace-only sanitizes to null)
  // is silently DROPPED by the `!= null` guard below. Clearing a stored resolution
  // is intentionally unsupported. Reject it loudly ONLY when it's the whole request
  // (no status change) — so an empty resolution riding alongside a valid status
  // transition never blocks that transition (a native client may send both fields).
  if (resolution !== undefined && sanitizedResolution == null && !status) {
    return NextResponse.json({ error: t("apiUser.issues.resolutionEmpty") }, { status: 400 });
  }

  // Only a status that differs is a status change; re-sending the current one
  // (a native client may echo it beside a note) writes nothing for it.
  const isStatusChange = !!status && status !== issue.status;
  const updateData: { status?: ValidStatus; resolution?: string | null; resolvedAt?: Date | null } = {};
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

  // Nothing to change (an empty body, or only the current status): answer the
  // issue as it is — no write, no issue:updated broadcast, no audit.
  if (Object.keys(updateData).length === 0) return NextResponse.json(issue);

  // Compare-and-swap on status when a status change is requested. The resolution-only
  // update path is not gated — overwriting resolution text concurrently is a benign
  // last-write-wins rather than a state-transition conflict.
  if (isStatusChange) {
    const result = await prisma.issue.updateMany({
      where: { id, status: issue.status },
      data: updateData,
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "status-conflict", message: t("apiUser.issues.modifiedConcurrently") },
        { status: 409 }
      );
    }
  } else {
    // updateMany (not update) so a concurrent delete returns count:0 instead of
    // throwing an unhandled P2025.
    const r = await prisma.issue.updateMany({ where: { id }, data: updateData });
    if (r.count === 0) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  }

  const updated = await prisma.issue.findUnique({ where: { id } });
  if (!updated) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });

  emitSSE({ type: "issue:updated", issueId: id, status: updated.status, userId: issue.reportedBy });

  if (isStatusChange) {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "ISSUE_STATUS_CHANGE", target: `issue:${id}`, details: { title: issue.title, before: { status: issue.status }, after: { status, resolution: sanitizedResolution ?? issue.resolution } }, ...auditContext(req, session) });
  }

  if (status === "RESOLVED" && issue.status !== "RESOLVED") {
    // The issue.resolved event, then the reporter's Discord, push and inbox row
    // behind one deactivatedAt read (guardrail 33) — skipped when an issue admin
    // resolves their OWN report (on a single-admin instance the common case).
    await announceIssueResolved(issue, sanitizedResolution ?? issue.resolution, session.user.id);
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
