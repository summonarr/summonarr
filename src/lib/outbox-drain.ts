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
  OUTBOX_APPROVED_KIND,
  OUTBOX_AVAILABLE_KIND,
  OUTBOX_DECLINED_KIND,
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

/** Rows taken per pass. A backlog larger than this drains over later passes. */
export const OUTBOX_DRAIN_BATCH = 500;

const rowSchema = v.object({
  id: v.string(),
  kind: v.string(),
  channel: v.string(),
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
const isDecisionKind = (k: string): k is DecisionKindKey => k in DECISION_STATUS;

export interface OutboxDrainResult {
  /** Rows handed to a sender. */
  delivered: number;
  /** Rows deleted unsent: expired, out of attempts, unreadable, or for a disabled account. */
  dropped: number;
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
      RETURNING id, kind, channel, "userId", payload, attempts, ("expiresAt" < NOW()) AS expired
    `);
    if (!Array.isArray(raw) || raw.length === 0) return result;

    const rows = raw.flatMap((r) => {
      const checked = check(rowSchema, r);
      return checked.ok ? [checked.value] : [];
    });
    if (rows.length === 0) return result;

    // Disabled since the claim (guardrail 33): delivery is dropped, not deferred.
    const userIds = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
    const disabled = userIds.length === 0 ? [] : await prisma.user.findMany({
      where: { id: { in: userIds }, deactivatedAt: { not: null } },
      select: { id: true },
    });
    const disabledIds = new Set(disabled.map((u) => u.id));

    const drop: string[] = [];
    type Owed = { rowId: string; kind: string; channel: NoticeChannel; payload: AvailableWinner & { adminNote?: string | null } };
    const owed: Owed[] = [];
    for (const row of rows) {
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
      if (isDecisionKind(o.kind) && statusById.get(o.payload.id) !== DECISION_STATUS[o.kind]) {
        drop.push(o.rowId);
        continue;
      }
      const key = `${o.kind}/${o.channel}`;
      const group = byGroup.get(key) ?? { kind: o.kind, channel: o.channel, payloads: [] };
      group.payloads.push(o.payload);
      byGroup.set(key, group);
    }

    if (drop.length > 0) {
      await prisma.outbox.deleteMany({ where: { id: { in: drop } } });
      result.dropped = drop.length;
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
