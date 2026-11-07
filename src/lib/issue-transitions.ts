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
