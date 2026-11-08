import "server-only";
import { prisma } from "./prisma";
import { isFeatureEnabled } from "./features";
import { logAudit } from "./audit";
import { emitSSE } from "./sse-emitter";
import { announceIssueResolved } from "./issue-transitions";

// Closing an issue when the replacement the admin asked for has landed.
//
// The Radarr/Sonarr Download webhooks already claim an IssueGrab when "the
// replacement for this issue landed" and tell the admin who started it
// (guardrail 5f). This is the second half: with the feature on, that same
// first claim also marks the ISSUE resolved and tells the reporter, so nobody
// chases it by hand. The reporter replying reopens it (messages route), so a
// wrong guess costs one message.

export const ISSUE_AUTO_RESOLVE_FEATURE_KEY = "feature.behavior.issueAutoResolve";

/** A grab older than this is a stale intent, not "the replacement just landed". */
export const AUTO_RESOLVE_MAX_GRAB_AGE_DAYS = 30;

/**
 * Whether a delivery of this scope can say the issue is fixed. A movie is one
 * file, and an episode issue is one episode; but a season or whole-series issue
 * is NOT fixed by its first imported episode (the webhook matches a season grab
 * on any episode of that season), so those stay with the admin.
 */
export function scopeCanAutoResolve(grab: { mediaType: string; scope: string }): boolean {
  if (grab.mediaType === "MOVIE") return true;
  return grab.scope === "EPISODE";
}

export function grabIsFreshEnough(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= AUTO_RESOLVE_MAX_GRAB_AGE_DAYS * 86_400_000;
}

export interface ClaimedGrab {
  issueId: string;
  triggeredById: string;
  mediaType: string;
  scope: string;
  createdAt: Date;
}

/**
 * Resolve the issue behind a freshly CLAIMED grab. Best effort: callers
 * fire-and-forget it, and it never throws into a webhook.
 *
 * - The status write is a compare-and-swap on OPEN/IN_PROGRESS, so an admin who
 *   resolved it a moment earlier (or a concurrent delivery) wins and nothing is
 *   announced twice.
 * - Audited as ISSUE_STATUS_CHANGE with actor "system", trigger
 *   "auto-resolve-replacement" — there is no resolution text (nothing here
 *   speaks any user's language), the audit row says why.
 * - The reporter is told through the same channels as a manual resolve, behind
 *   one deactivatedAt read (guardrail 33) — announceIssueResolved, shared with
 *   the PATCH. When the reporter is the admin whose grab landed they have just
 *   been told by the grab-completed push, so no second message.
 */
export async function autoResolveIssueForGrab(grab: ClaimedGrab, now: Date = new Date()): Promise<boolean> {
  try {
    if (!scopeCanAutoResolve(grab) || !grabIsFreshEnough(grab.createdAt, now)) return false;
    if (!(await isFeatureEnabled(ISSUE_AUTO_RESOLVE_FEATURE_KEY))) return false;

    const issue = await prisma.issue.findUnique({
      where: { id: grab.issueId },
      select: { id: true, status: true, reportedBy: true, title: true, mediaType: true, tmdbId: true, posterPath: true, issueType: true },
    });
    if (!issue || issue.status === "RESOLVED") return false;

    const resolved = await prisma.issue.updateMany({
      where: { id: issue.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (resolved.count === 0) return false;

    emitSSE({ type: "issue:updated", issueId: issue.id, status: "RESOLVED", userId: issue.reportedBy });
    void logAudit({
      // The system principal's id every automated audit row carries
      // (cron-auth.ts CRON_SYSTEM_ACTOR, the offboarding revoke), so "hide cron"
      // and an actor filter treat it like them; the name stays "system"
      // (guardrail 5j).
      userId: "system",
      userName: "system",
      action: "ISSUE_STATUS_CHANGE",
      target: `issue:${issue.id}`,
      details: { trigger: "auto-resolve-replacement", title: issue.title, before: { status: issue.status }, after: { status: "RESOLVED" } },
    });

    await announceIssueResolved(issue, null, grab.triggeredById);
    return true;
  } catch (err) {
    console.error("[issue-auto-resolve] failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
