import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  searchMovieInRadarr,
  searchSeriesInSonarr,
  searchSeasonInSonarr,
  searchEpisodeInSonarr,
} from "@/lib/arr";
import { notifyUserIssueResolved } from "@/lib/discord-notify";
import { emitSSE } from "@/lib/sse-emitter";
import { logAudit, auditContext } from "@/lib/audit";
import { sanitizeOptional, sanitizeText } from "@/lib/sanitize";

const VALID_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isTokenExpired(session) || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: { status?: string; resolution?: string; refetch?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { status, resolution, refetch } = body;

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (refetch) {
    let arrError: string | null = null;
    try {
      if (issue.mediaType === "MOVIE") {
        await searchMovieInRadarr(issue.tmdbId);
      } else {
        if (!issue.tvdbId) throw new Error("No TVDB ID on this issue — cannot search in Sonarr");
        if (issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null) {
          await searchEpisodeInSonarr(issue.tvdbId, issue.seasonNumber, issue.episodeNumber);
        } else if (issue.scope === "SEASON" && issue.seasonNumber != null) {
          await searchSeasonInSonarr(issue.tvdbId, issue.seasonNumber);
        } else {
          await searchSeriesInSonarr(issue.tvdbId);
        }
      }
      const updated = await prisma.issue.update({
        where: { id },
        data: { status: "IN_PROGRESS" },
      });
      emitSSE({ type: "issue:updated", issueId: id, status: "IN_PROGRESS", userId: issue.reportedBy });
      return NextResponse.json({ ...updated, arrError: null });
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

  const updated = await prisma.issue.update({ where: { id }, data: updateData });
  emitSSE({ type: "issue:updated", issueId: id, status: updated.status, userId: issue.reportedBy });

  if (status && status !== issue.status) {
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "ISSUE_STATUS_CHANGE", target: `issue:${id}`, details: { title: issue.title, before: { status: issue.status }, after: { status, resolution: sanitizedResolution ?? issue.resolution } }, ...auditContext(req, session) });
  }

  if (status === "RESOLVED" && issue.status !== "RESOLVED") {
    notifyUserIssueResolved(issue.reportedBy, issue.title, issue.mediaType, sanitizedResolution ?? issue.resolution).catch(() => {});
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isTokenExpired(session) || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
}
