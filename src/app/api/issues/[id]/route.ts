import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { prisma } from "@/lib/prisma";
import {
  searchMovieInRadarr,
  searchSeriesInSonarr,
  searchSeasonInSonarr,
  searchEpisodeInSonarr,
  resolveTvdbIdFromTmdbId,
} from "@/lib/arr";
import { notifyUserIssueResolved } from "@/lib/discord-notify";
import { notifyUserIssueResolvedPush } from "@/lib/push";
import { createInAppNotification } from "@/lib/in-app-notify";
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

  const parsed = await readJsonCapped<{ status?: string; resolution?: string; refetch?: boolean; instance?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { status, resolution, refetch } = body;

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (refetch) {
    // Which Radarr/Sonarr instance holds the copy this issue is about. Issue has no
    // arrInstance column — the same title can sit on several instances — so the caller
    // names it, exactly as the sibling Replace flow does (issues/[id]/releases). Absent
    // ⇒ the default, so every pre-existing caller is unchanged.
    //
    // Without this the search always went to the DEFAULT instance: a SEASON issue filed
    // against the 4K copy re-grabbed and re-imported the HD one, leaving the reported
    // problem untouched while the issue moved to IN_PROGRESS as though it were handled.
    // Validated, never coerced — a bad slug must not silently retarget the default.
    const instance = typeof body.instance === "string" ? body.instance.trim() : "";
    if (!isValidInstanceSlug(instance)) {
      return NextResponse.json({ error: "Invalid instance" }, { status: 400 });
    }
    let arrError: string | null = null;
    try {
      if (issue.mediaType === "MOVIE") {
        await searchMovieInRadarr(issue.tmdbId, instance);
      } else {
        // Resolve authoritatively from tmdbId when the stored tvdbId is absent
        // (client-supplied tvdbId is no longer trusted, so older/null rows resolve here).
        const tvdbId = issue.tvdbId ?? (await resolveTvdbIdFromTmdbId(issue.tmdbId, instance));
        if (!tvdbId) throw new Error("Could not resolve a TVDB ID for this series — cannot search in Sonarr");
        if (issue.scope === "EPISODE" && issue.seasonNumber != null && issue.episodeNumber != null) {
          await searchEpisodeInSonarr(tvdbId, issue.seasonNumber, issue.episodeNumber, instance);
        } else if (issue.scope === "SEASON" && issue.seasonNumber != null) {
          await searchSeasonInSonarr(tvdbId, issue.seasonNumber, instance);
        } else {
          await searchSeriesInSonarr(tvdbId, instance);
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
  // A provided-but-empty resolution (empty/whitespace-only sanitizes to null)
  // is silently DROPPED by the `!= null` guard below. Clearing a stored resolution
  // is intentionally unsupported. Reject it loudly ONLY when it's the whole request
  // (no status change) — so an empty resolution riding alongside a valid status
  // transition never blocks that transition (a native client may send both fields).
  if (resolution !== undefined && sanitizedResolution == null && !status) {
    return NextResponse.json({ error: "resolution must not be empty" }, { status: 400 });
  }

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
    // One lookup decides whether the reporter-facing channels run, mirroring
    // notifyRequestStatusChange and the messages route's `reporterActive`
    // (guardrail 33 — gate at a chokepoint, never re-scatter it into the
    // per-channel queries). Account removal disables rather than scrubs, so a
    // removed reporter keeps a live email, Discord link and push subscriptions
    // and would otherwise be notified forever.
    const reporterActive = prisma.user
      .findUnique({ where: { id: issue.reportedBy }, select: { deactivatedAt: true } })
      .then((u) => !!u && u.deactivatedAt == null)
      .catch(() => false);

    // An issue admin resolving their OWN reported issue must not be notified about it —
    // on a single-admin self-hosted instance that is the common case. The inbox row
    // below already honoured this; Discord and push did not, so the admin got pinged by
    // their own action on every resolve.
    const selfAction = issue.reportedBy === session.user.id;
    void reporterActive.then((active) => {
      if (!active || selfAction) return;
      notifyUserIssueResolved(issue.reportedBy, issue.title, issue.mediaType, sanitizedResolution ?? issue.resolution).catch(() => {});
      notifyUserIssueResolvedPush({
        userId: issue.reportedBy,
        title: issue.title,
        resolution: sanitizedResolution ?? issue.resolution,
        issueId: id,
      }).catch(() => {});
    });
    const res = (sanitizedResolution ?? issue.resolution) ?? "";
    // An issue admin resolving their OWN reported issue shouldn't get a
    // self-notification inbox row ("Your reported issue was resolved"). Mirrors the
    // selfAction guard the request routes use.
    if (!selfAction) {
      createInAppNotification(issue.reportedBy, {
        type: "ISSUE_RESOLVED",
        title: issue.title,
        body: res ? `Resolved: ${res.slice(0, 400)}` : "Your reported issue was resolved.",
        tmdbId: issue.tmdbId,
        mediaType: issue.mediaType,
        posterPath: issue.posterPath,
      });
    }
  }

  return NextResponse.json(updated);
});

export const DELETE = withIssueAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  // The last mutation in the issues/votes family that was missing this, and not
  // a harmless omission: withIssueAdmin is authoritative on MANAGE_ISSUES, while
  // maintenanceGuard exempts only the ADMIN superbit — and the ISSUE_ADMIN
  // preset carries MANAGE_ISSUES WITHOUT ADMIN. So during maintenance an issue
  // admin was refused every other action here and could still hard-delete a
  // row, which is the most destructive one in the family.
  const maintenance = await maintenanceGuard();
  if (maintenance) return maintenance;

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
