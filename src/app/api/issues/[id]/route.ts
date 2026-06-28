import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import {
  searchMovieInRadarr,
  searchSeriesInSonarr,
  searchSeasonInSonarr,
  searchEpisodeInSonarr,
  resolveTvdbIdFromTmdbId,
} from "@/lib/arr";
import { notifyUserIssueResolved } from "@/lib/discord-notify";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, auditContext } from "@/lib/audit";
import { sanitizeOptional, sanitizeText } from "@/lib/sanitize";
import { maintenanceGuard } from "@/lib/maintenance";

const VALID_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

export const PATCH = withIssueAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;

  const { id } = await params;

  const parsed = await readJsonCapped<{ status?: string; resolution?: string; refetch?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { status, resolution, refetch } = body;

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (refetch) {
    let arrError: string | null = null;
    try {
      if (issue.mediaType === "MOVIE") {
        await searchMovieInRadarr(issue.tmdbId);
      } else {
        // Resolve authoritatively from tmdbId when the stored tvdbId is absent
        // (client-supplied tvdbId is no longer trusted, so older/null rows resolve here).
        const tvdbId = issue.tvdbId ?? (await resolveTvdbIdFromTmdbId(issue.tmdbId));
        if (!tvdbId) throw new Error("Could not resolve a TVDB ID for this series — cannot search in Sonarr");
        if (issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null) {
          await searchEpisodeInSonarr(tvdbId, issue.seasonNumber, issue.episodeNumber);
        } else if (issue.scope === "SEASON" && issue.seasonNumber != null) {
          await searchSeasonInSonarr(tvdbId, issue.seasonNumber);
        } else {
          await searchSeriesInSonarr(tvdbId);
        }
      }
      // CAS on status: don't clobber a RESOLVED issue if another admin closed it
      // while the search was in flight. updateMany returns count=0 in that case
      // so we just return the current (RESOLVED) issue without changing status.
      const claimed = await prisma.issue.updateMany({
        where: { id, status: { not: "RESOLVED" } },
        data: { status: "IN_PROGRESS" },
      });
      const updated = await prisma.issue.findUnique({ where: { id } });
      if (claimed.count > 0) {
        emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
        void logAudit({
          userId: session.user.id,
          userName: session.user.name ?? session.user.email ?? null,
          action: "ISSUE_STATUS_CHANGE",
          target: `issue:${id}`,
          details: { trigger: "refetch", before: { status: issue.status }, after: { status: "IN_PROGRESS" } },
          ...auditContext(req, session),
        });
      }
      return NextResponse.json({ ...(updated ?? issue), arrError: null });
    } catch (err) {
      console.error("[arr] Issue refetch failed:", err);
      arrError = "Arr service request failed";
      return NextResponse.json({ ...issue, arrError });
    }
  }

  if (status && !VALID_STATUSES.includes(status as ValidStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  if (resolution !== undefined) {
    if (typeof resolution !== "string" || resolution.length > 1000) {
      return NextResponse.json({ error: "resolution must be a string under 1000 characters" }, { status: 400 });
    }
  }
  const sanitizedResolution = sanitizeOptional(resolution);

  const updateData: { status?: ValidStatus; resolution?: string } = {};
  if (status) updateData.status = status as ValidStatus;
  if (sanitizedResolution != null) updateData.resolution = sanitizedResolution;

  // Compare-and-swap on status when a status change is requested. The resolution-only
  // update path is not gated — overwriting resolution text concurrently is a benign
  // last-write-wins rather than a state-transition conflict.
  const isStatusChange = status && status !== issue.status;
  if (isStatusChange) {
    const result = await prisma.issue.updateMany({
      where: { id, status: issue.status },
      data: updateData,
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "status-conflict", message: "Issue was modified concurrently. Refresh and try again." },
        { status: 409 }
      );
    }
  } else if (Object.keys(updateData).length > 0) {
    // updateMany (not update) so a concurrent delete returns count:0 instead of
    // throwing an unhandled P2025.
    const r = await prisma.issue.updateMany({ where: { id }, data: updateData });
    if (r.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.issue.findUnique({ where: { id } });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  emitSSE({ type: "issue:updated", issueId: id, status: updated.status, userId: issue.reportedBy });

  if (isStatusChange) {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "ISSUE_STATUS_CHANGE", target: `issue:${id}`, details: { title: issue.title, before: { status: issue.status }, after: { status, resolution: sanitizedResolution ?? issue.resolution } }, ...auditContext(req, session) });
  }

  if (status === "RESOLVED" && issue.status !== "RESOLVED") {
    notifyUserIssueResolved(issue.reportedBy, issue.title, issue.mediaType, sanitizedResolution ?? issue.resolution).catch(() => {});
  }

  return NextResponse.json(updated);
});

export const DELETE = withIssueAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ctx = auditContext(req, session);
  await prisma.$transaction(async (tx) => {
    await tx.issue.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        userId: session.user.id,
        userName: sanitizeText(session.user.name ?? session.user.email ?? "unknown"),
        action: "ISSUE_DELETE",
        target: sanitizeText(`issue:${id}`),
        details: JSON.stringify({ action: "delete", title: issue.title, mediaType: issue.mediaType }),
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        provider: ctx.provider ?? null,
        sessionId: null,
      },
    });
  });

  emitSSE({ type: "issue:deleted", issueId: id, userId: issue.reportedBy });

  return NextResponse.json({ ok: true });
});
