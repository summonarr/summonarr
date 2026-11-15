// The outbox drain: send what a dead process left owed (see outbox.ts).
//
// Called by the sync orchestrator once per run. It takes only rows whose lock
// has lapsed, so it never races the process that is still delivering its own
// claim; a fresh claim's rows are invisible to it for OUTBOX_LOCK_MINUTES.

import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { check, v } from "./validate";
import {
  NOTICE_CHANNELS,
  OUTBOX_ALL_CHANNELS,
  OUTBOX_APPROVED_KIND,
  OUTBOX_COMMENT_KIND,
  OUTBOX_ISSUE_REPLY_KIND,
  OUTBOX_AVAILABLE_KIND,
  OUTBOX_DECLINED_KIND,
  OUTBOX_GRAB_CHANNEL,
  OUTBOX_GRAB_KIND,
  OUTBOX_VOTE_THRESHOLD_KIND,
  OUTBOX_LOCK_MINUTES,
  OUTBOX_MAX_ATTEMPTS,
  type NoticeChannel,
} from "./outbox";
import {
  deliverAvailableChannel,
  deliverDecisionChannel,
  type AvailableWinner,
  type StatusChangeTarget,
} from "./request-notifications";

import { announceRequestComment, type RequestCommentAnnouncement } from "./request-comment-notify";
import { announceIssueReply, type IssueReplyAnnouncement } from "./issue-reply-notify";
import { deliverGrabPush, type GrabPush } from "./issue-grab-notify";
import { deliverQueuedVoteAlert, type ThresholdAlertData } from "./deletion-vote-threshold";

/** Rows taken per pass. A backlog larger than this drains over later passes. */
export const OUTBOX_DRAIN_BATCH = 500;

const rowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  channel: v.string(),
  dedupeKey: v.string(),
  userId: v.nullable(v.string()),
  payload: v.unknown(),
  attempts: v.number(),
  expired: v.boolean(),
});

// The payload every request notice carries (outbox.ts builds it from the
// MediaRequest row). `adminNote` rides the approve/decline kinds only.
const noticePayload = v.object({
  id: v.string(),
  requestedBy: v.string(),
  title: v.string(),
  mediaType: v.string(),
  tmdbId: v.nullable(v.number()),
  posterPath: v.nullable(v.string()),
  arrInstance: v.string(),
  adminNote: v.optional(v.nullable(v.string())),
});

// An approve/decline notice is only still true while the request is in the
// status the decision put it in: an approval whose push was rolled back, a
// decline that was reopened, a deleted request all owe nothing.
const DECISION_STATUS = { [OUTBOX_APPROVED_KIND]: "APPROVED", [OUTBOX_DECLINED_KIND]: "DECLINED" } as const;
type DecisionKindKey = keyof typeof DECISION_STATUS;
const isDecisionKind = (k: string): k is DecisionKindKey => Object.hasOwn(DECISION_STATUS, k);
// An approval that STOOD and has since moved on (the file was already there, so
// Radarr/Sonarr/the sync flipped it to AVAILABLE within seconds) still owes its
// "approved" notice: only a rolled-back or reopened approval does not.
const DECISION_STILL_TRUE: Record<DecisionKindKey, readonly string[]> = {
  [OUTBOX_APPROVED_KIND]: ["APPROVED", "AVAILABLE"],
  [OUTBOX_DECLINED_KIND]: ["DECLINED"],
};

// A whole announcement (channel "all"): what announceRequestComment /
// announceIssueReply were handed when the comment or message was written.
const commentPayload = v.object({
  commentId: v.string(),
  request: v.object({
    id: v.string(),
    title: v.string(),
    mediaType: v.string(),
    tmdbId: v.number(),
    posterPath: v.nullable(v.string()),
    requestedBy: v.string(),
    arrInstance: v.string(),
  }),
  authorId: v.string(),
  authorName: v.string(),
  authorDisplayName: v.nullable(v.string()),
  text: v.string(),
  authorIsManager: v.boolean(),
});
const issueReplyPayload = v.object({
  messageId: v.string(),
  issue: v.object({
    id: v.string(),
    title: v.string(),
    mediaType: v.string(),
    tmdbId: v.number(),
    posterPath: v.nullable(v.string()),
    issueType: v.string(),
    reportedBy: v.string(),
    claimedBy: v.nullable(v.string()),
  }),
  authorId: v.string(),
  authorDisplayName: v.nullable(v.string()),
  authorName: v.string(),
  fromIssueAdmin: v.boolean(),
  text: v.string(),
});

// The push for a landed replacement (issue-grab-notify.ts) and the admins'
// vote-threshold alert (deletion-vote-threshold.ts), as their claims queued them.
const grabPayload = v.object({
  userId: v.string(),
  title: v.string(),
  tmdbId: v.number(),
  mediaType: v.string(),
  scope: v.string(),
  seasonNumber: v.nullable(v.number()),
  episodeNumber: v.nullable(v.number()),
  issueId: v.string(),
});
const voteAlertPayload = v.object({
  title: v.string(),
  mediaType: v.string(),
  voteCount: v.number(),
  posterPath: v.nullable(v.string()),
  tmdbId: v.number(),
});

export interface OutboxDrainResult {
  /** Rows handed to a sender. */
  delivered: number;
  /** Rows deleted unsent: expired, out of attempts, unreadable, or for a disabled account. */
  dropped: number;
}

// The IssueGrab id a grab row's key carries: `<kind>:<grabId>:<channel>`.
function grabIdOf(dedupeKey: string): string | null {
  const prefix = `${OUTBOX_GRAB_KIND}:`;
  const suffix = `:${OUTBOX_GRAB_CHANNEL}`;
  if (!dedupeKey.startsWith(prefix) || !dedupeKey.endsWith(suffix)) return null;
  return dedupeKey.slice(prefix.length, dedupeKey.length - suffix.length) || null;
}

const isNoticeChannel = (c: string): c is NoticeChannel => (NOTICE_CHANNELS as readonly string[]).includes(c);

/**
 * One pass. Never throws: it runs inside the sync, and a notification backlog
 * must not fail a library sync.
 */
export async function drainOutbox(logScope = "outbox"): Promise<OutboxDrainResult> {
  const result: OutboxDrainResult = { delivered: 0, dropped: 0 };
  try {
    // Take and re-lock in one statement (SKIP LOCKED: two passes never take the
    // same row), counting the attempt before anything is sent.
    const raw = await prisma.$queryRaw<unknown[]>(Prisma.sql`
      UPDATE "Outbox"
      SET attempts = attempts + 1,
          "lockedUntil" = NOW() + make_interval(mins => ${OUTBOX_LOCK_MINUTES}::int)
      WHERE id IN (
        SELECT id FROM "Outbox"
        WHERE "lockedUntil" < NOW()
        ORDER BY "createdAt"
        LIMIT ${OUTBOX_DRAIN_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind, channel, "dedupeKey", "userId", payload, attempts, ("expiresAt" < NOW()) AS expired
    `);
    if (!Array.isArray(raw) || raw.length === 0) return result;

    // A row that cannot be read (column-type drift) can never be sent, and the
    // statement above already re-locked it: delete it now, or it is re-taken
    // every lock period and eats the batch.
    const drop: string[] = [];
    const rows = raw.flatMap((r) => {
      const checked = check(rowSchema, r);
      if (checked.ok) return [checked.value];
      const id = typeof r === "object" && r !== null ? (r as { id?: unknown }).id : undefined;
      if (typeof id === "string") drop.push(id);
      return [];
    });
    if (rows.length === 0) {
      if (drop.length > 0) {
        await prisma.outbox.deleteMany({ where: { id: { in: drop } } });
        result.dropped += drop.length;
      }
      return result;
    }

    // Disabled since the claim (guardrail 33): delivery is dropped, not deferred.
    const userIds = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
    const disabled = userIds.length === 0 ? [] : await prisma.user.findMany({
      where: { id: { in: userIds }, deactivatedAt: { not: null } },
      select: { id: true },
    });
    const disabledIds = new Set(disabled.map((u) => u.id));

    type Owed = { rowId: string; kind: string; channel: NoticeChannel; payload: AvailableWinner & { adminNote?: string | null } };
    const owed: Owed[] = [];
    const comments: Array<{ rowId: string; a: RequestCommentAnnouncement & { commentId: string } }> = [];
    const replies: Array<{ rowId: string; a: IssueReplyAnnouncement & { messageId: string } }> = [];
    const grabs: Array<{ rowId: string; grabId: string; push: GrabPush }> = [];
    const voteAlerts: ThresholdAlertData[] = [];
    for (const row of rows) {
      // A comment or reply row's userId is its AUTHOR, not its recipient: the
      // author being disabled since says nothing about the person to tell (the
      // announcer re-checks the recipient itself, guardrail 33).
      const authorRow = row.kind === OUTBOX_COMMENT_KIND || row.kind === OUTBOX_ISSUE_REPLY_KIND;
      const stale = row.expired || row.attempts > OUTBOX_MAX_ATTEMPTS
        || (!authorRow && row.userId !== null && disabledIds.has(row.userId));
      if (row.kind === OUTBOX_GRAB_KIND && row.channel === OUTBOX_GRAB_CHANNEL && !stale) {
        const g = check(grabPayload, row.payload);
        const grabId = grabIdOf(row.dedupeKey);
        if (g.ok && grabId) {
          grabs.push({ rowId: row.id, grabId, push: g.value });
          continue;
        }
      }
      if (row.kind === OUTBOX_VOTE_THRESHOLD_KIND && row.channel === OUTBOX_ALL_CHANNELS && !stale) {
        const a = check(voteAlertPayload, row.payload);
        if (a.ok && (a.value.mediaType === "MOVIE" || a.value.mediaType === "TV")) {
          voteAlerts.push({ ...a.value, mediaType: a.value.mediaType });
          continue;
        }
      }
      if (row.channel === OUTBOX_ALL_CHANNELS && !stale) {
        if (row.kind === OUTBOX_COMMENT_KIND) {
          const c = check(commentPayload, row.payload);
          if (c.ok) {
            comments.push({ rowId: row.id, a: { ...c.value, request: { ...c.value.request, mediaType: c.value.request.mediaType === "MOVIE" ? "MOVIE" : "TV" } } });
            continue;
          }
        } else if (row.kind === OUTBOX_ISSUE_REPLY_KIND) {
          const m = check(issueReplyPayload, row.payload);
          if (m.ok) {
            replies.push({ rowId: row.id, a: m.value });
            continue;
          }
        }
      }
      const known = (row.kind === OUTBOX_AVAILABLE_KIND || isDecisionKind(row.kind)) && isNoticeChannel(row.channel);
      const payload = known ? check(noticePayload, row.payload) : null;
      if (
        !payload?.ok
        || row.expired
        || row.attempts > OUTBOX_MAX_ATTEMPTS
        || (row.userId !== null && disabledIds.has(row.userId))
      ) {
        drop.push(row.id);
        continue;
      }
      owed.push({ rowId: row.id, kind: row.kind, channel: row.channel as NoticeChannel, payload: payload.value });
    }

    // Decisions: drop what is no longer true (see DECISION_STATUS).
    const decisionIds = [...new Set(owed.filter((o) => isDecisionKind(o.kind)).map((o) => o.payload.id))];
    const statusById = new Map<string, string>();
    if (decisionIds.length > 0) {
      const current = await prisma.mediaRequest.findMany({ where: { id: { in: decisionIds } }, select: { id: true, status: true } });
      for (const r of current) statusById.set(r.id, r.status);
    }
    const byGroup = new Map<string, { kind: string; channel: NoticeChannel; payloads: Owed["payload"][] }>();
    for (const o of owed) {
      if (isDecisionKind(o.kind) && !DECISION_STILL_TRUE[o.kind].includes(statusById.get(o.payload.id) ?? "")) {
        drop.push(o.rowId);
        continue;
      }
      const key = `${o.kind}/${o.channel}`;
      const group = byGroup.get(key) ?? { kind: o.kind, channel: o.channel, payloads: [] };
      group.payloads.push(o.payload);
      byGroup.set(key, group);
    }

    // A comment or reply deleted since it was written (with its request or
    // issue, which cascade) is announced to nobody.
    const liveComments = comments.length === 0 ? new Set<string>() : new Set(
      (await prisma.requestComment.findMany({ where: { id: { in: comments.map((c) => c.a.commentId) } }, select: { id: true } })).map((r) => r.id),
    );
    const liveReplies = replies.length === 0 ? new Set<string>() : new Set(
      (await prisma.issueMessage.findMany({ where: { id: { in: replies.map((r) => r.a.messageId) } }, select: { id: true } })).map((r) => r.id),
    );
    for (const c of comments) if (!liveComments.has(c.a.commentId)) drop.push(c.rowId);
    for (const r of replies) if (!liveReplies.has(r.a.messageId)) drop.push(r.rowId);
    // A grab deleted since its claim (with its issue or its admin, which
    // cascade) has nobody left to tell.
    const liveGrabs = grabs.length === 0 ? new Set<string>() : new Set(
      (await prisma.issueGrab.findMany({ where: { id: { in: grabs.map((g) => g.grabId) } }, select: { id: true } })).map((r) => r.id),
    );
    for (const g of grabs) if (!liveGrabs.has(g.grabId)) drop.push(g.rowId);

    if (drop.length > 0) {
      await prisma.outbox.deleteMany({ where: { id: { in: drop } } });
      result.dropped += drop.length;
    }
    // The announcers settle their own row once their channels have returned.
    for (const c of comments) {
      if (!liveComments.has(c.a.commentId)) continue;
      await announceRequestComment(c.a);
      result.delivered++;
    }
    for (const r of replies) {
      if (!liveReplies.has(r.a.messageId)) continue;
      await announceIssueReply(r.a);
      result.delivered++;
    }
    // A grab push settles its own row unless it failed again (then it waits for
    // its lock to lapse once more).
    for (const g of grabs) {
      if (!liveGrabs.has(g.grabId)) continue;
      await deliverGrabPush(g.grabId, g.push, `[${logScope}]`);
      result.delivered++;
    }
    // A vote alert is re-judged before it is sent; one that is no longer owed
    // is deleted unsent. A failed read leaves its row for the next pass.
    for (const alert of voteAlerts) {
      try {
        if (await deliverQueuedVoteAlert(alert)) result.delivered++;
        else result.dropped++;
      } catch (err) {
        console.warn(`[${logScope}] outbox: vote alert left queued:`, err instanceof Error ? err.message : String(err));
      }
    }
    // One channel after another: a redelivery pass is rare and never urgent.
    // The deliver functions settle (delete) what they sent and never throw.
    for (const { kind, channel, payloads } of byGroup.values()) {
      if (isDecisionKind(kind)) {
        const targets: StatusChangeTarget[] = payloads.map((p) => ({ ...p, tmdbId: p.tmdbId ?? null, posterPath: p.posterPath ?? null, adminNote: p.adminNote ?? null }));
        await deliverDecisionChannel(DECISION_STATUS[kind], channel, targets, logScope);
      } else {
        await deliverAvailableChannel(channel, payloads, logScope);
      }
      result.delivered += payloads.length;
    }
    if (result.delivered > 0 || result.dropped > 0) {
      console.warn(`[${logScope}] outbox: re-sent ${result.delivered} notification(s) left unsent by an earlier run, dropped ${result.dropped}`);
    }
  } catch (err) {
    console.warn(`[${logScope}] outbox drain failed:`, err instanceof Error ? err.message : String(err));
  }
  return result;
}
