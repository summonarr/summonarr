import "server-only";
import { prisma } from "./prisma";
import { auditContext, logAudit } from "./audit";
import { emitSSE } from "./sse-emitter";
import { emitNotificationEvent } from "./notify-agents";
import { notifyUserIssueResolved } from "./discord-notify";
import { notifyUserIssueResolvedPush } from "./push";
import { createInAppNotification } from "./in-app-notify";
import type { SummonarrSession } from "./api-auth";

// The two issue status changes several paths share, so each is written once.

/**
 * Move an issue to IN_PROGRESS with a compare-and-swap, and announce + audit it
 * when the status really changed (an IN_PROGRESS → IN_PROGRESS claim says
 * nothing new). `from`: "notResolved" (an admin's grab, Replace file, Refetch —
 * anything short of a closed issue) or "open" (an admin's first reply). Returns
 * the CAS count: 0 means the guard failed (resolved meanwhile, or no longer
 * OPEN) and nothing was announced. A failed CAS write throws, to the caller.
 *
 * The audit is the swallowing logAudit, after the CAS committed (guardrail 26),
 * so it never turns the caller's answer into a 500.
 */
export async function promoteIssueInProgress(opts: {
  issue: { id: string; status: string; reportedBy: string };
  from: "notResolved" | "open";
  trigger: string;
  /** Extra audit details, between `trigger` and before/after. */
  details?: Record<string, unknown>;
  session: SummonarrSession;
  req: Request | { headers: Headers };
}): Promise<number> {
  const { issue, session } = opts;
  const claim = await prisma.issue.updateMany({
    where: { id: issue.id, status: opts.from === "open" ? "OPEN" : { not: "RESOLVED" } },
    data: { status: "IN_PROGRESS" },
  });
  if (claim.count > 0 && issue.status !== "IN_PROGRESS") {
    emitSSE({ type: "issue:updated", issueId: issue.id, status: "IN_PROGRESS", userId: issue.reportedBy });
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${issue.id}`,
      details: { trigger: opts.trigger, ...opts.details, before: { status: issue.status }, after: { status: "IN_PROGRESS" } },
      ...auditContext(opts.req, opts.session),
    });
  }
  return claim.count;
}

/**
 * Close an issue for an action that fixed it — the issue dialog's fix-match,
 * which runs as a background job, so closing no longer depends on the browser
 * staying until the remap ends. A compare-and-swap on OPEN/IN_PROGRESS stamps
 * resolvedAt and the resolution; only when THIS call closed it does it
 * broadcast issue:updated, write the ISSUE_STATUS_CHANGE audit (the swallowing
 * logAudit, after the write — guardrail 26) and announceIssueResolved, so a
 * concurrent resolve announces once. `about` binds the close to the title the
 * action changed: an issue about anything else is left alone.
 *
 * True when the issue is closed afterwards (by this call or already), false
 * when it is gone, about another title, or the write failed. Never throws.
 */
export async function resolveIssueAfterAction(opts: {
  issueId: string;
  about: { tmdbId: number; mediaType: string };
  resolution: string;
  trigger: string;
  actor: { userId: string; userName: string | null; ctx: ReturnType<typeof auditContext> };
}): Promise<boolean> {
  try {
    const issue = await prisma.issue.findUnique({
      where: { id: opts.issueId },
      select: { id: true, status: true, reportedBy: true, title: true, mediaType: true, tmdbId: true, posterPath: true, issueType: true },
    });
    if (!issue || issue.tmdbId !== opts.about.tmdbId || issue.mediaType !== opts.about.mediaType) return false;
    if (issue.status === "RESOLVED") return true;
    const claim = await prisma.issue.updateMany({
      where: { id: issue.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolution: opts.resolution },
    });
    if (claim.count === 0) {
      // Resolved (or deleted) in between: closed is closed, whoever did it.
      const now = await prisma.issue.findUnique({ where: { id: issue.id }, select: { status: true } });
      return now?.status === "RESOLVED";
    }
    emitSSE({ type: "issue:updated", issueId: issue.id, status: "RESOLVED", userId: issue.reportedBy });
    void logAudit({
      userId: opts.actor.userId,
      userName: opts.actor.userName,
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${issue.id}`,
      details: { trigger: opts.trigger, title: issue.title, before: { status: issue.status }, after: { status: "RESOLVED", resolution: opts.resolution } },
      ...opts.actor.ctx,
    });
    await announceIssueResolved(issue, opts.resolution, opts.actor.userId);
    return true;
  } catch (err) {
    console.error("[issues] closing the issue after a fix failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export interface ResolvedIssue {
  id: string;
  reportedBy: string;
  title: string;
  mediaType: string;
  tmdbId: number;
  posterPath: string | null;
  issueType: string;
}

/**
 * Tell everyone an issue was resolved — the admin's resolve (PATCH) and the
 * auto-resolve on a landed replacement (issue-auto-resolve.ts) alike: the
 * outbound agents' issue.resolved, then the reporter's Discord, push and inbox
 * row behind ONE deactivatedAt read (guardrail 33 — a missing row or a failed
 * read notifies nobody). Nothing reporter-facing when the reporter is `actorId`
 * (an admin resolving their own report, or the admin whose grab landed).
 *
 * The inbox row stores English (what the iOS app reads) and `data` re-renders
 * it in the reader's language (notification-render.ts — the English render must
 * stay byte-identical to these strings). Never throws.
 */
export async function announceIssueResolved(
  issue: ResolvedIssue,
  resolution: string | null,
  actorId: string | null,
): Promise<void> {
  const res = resolution ? resolution : null;
  emitNotificationEvent({
    event: "issue.resolved",
    media: { type: issue.mediaType === "MOVIE" ? "MOVIE" : "TV", tmdbId: issue.tmdbId, title: issue.title, posterPath: issue.posterPath ?? null },
    issue: { id: issue.id, type: issue.issueType },
    text: res,
  });
  if (issue.reportedBy === actorId) return;
  const reporter = await prisma.user
    .findUnique({ where: { id: issue.reportedBy }, select: { deactivatedAt: true } })
    .catch(() => null);
  if (!reporter || reporter.deactivatedAt != null) return;

  void notifyUserIssueResolved(issue.reportedBy, issue.title, issue.mediaType, res, issue.tmdbId).catch(() => {});
  void notifyUserIssueResolvedPush({
    userId: issue.reportedBy,
    title: issue.title,
    tmdbId: issue.tmdbId,
    mediaType: issue.mediaType,
    resolution: res,
    issueId: issue.id,
  }).catch(() => {});
  createInAppNotification(issue.reportedBy, {
    type: "ISSUE_RESOLVED",
    title: issue.title,
    body: res ? `Resolved: ${res.slice(0, 400)}` : "Your reported issue was resolved.",
    tmdbId: issue.tmdbId,
    mediaType: issue.mediaType,
    posterPath: issue.posterPath,
    data: { v: 1, resolution: res ? res.slice(0, 400) : null },
  });
}
