// The outbox drain: send what a dead process left owed (see outbox.ts).
//
// Called by the sync orchestrator once per run. It takes only rows whose lock
// has lapsed, so it never races the process that is still delivering its own
// claim; a fresh claim's rows are invisible to it for OUTBOX_LOCK_MINUTES.

import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { check, v } from "./validate";
import {
  AVAILABLE_CHANNELS,
  OUTBOX_AVAILABLE_KIND,
  OUTBOX_LOCK_MINUTES,
  OUTBOX_MAX_ATTEMPTS,
  type AvailableChannel,
} from "./outbox";
import { deliverAvailableChannel, type AvailableWinner } from "./request-notifications";

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

const availablePayload = v.object({
  id: v.string(),
  requestedBy: v.string(),
  title: v.string(),
  mediaType: v.string(),
  tmdbId: v.nullable(v.number()),
  posterPath: v.nullable(v.string()),
  arrInstance: v.string(),
});

export interface OutboxDrainResult {
  /** Rows handed to a sender. */
  delivered: number;
  /** Rows deleted unsent: expired, out of attempts, unreadable, or for a disabled account. */
  dropped: number;
}

const isAvailableChannel = (c: string): c is AvailableChannel => (AVAILABLE_CHANNELS as readonly string[]).includes(c);

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
    const byChannel = new Map<AvailableChannel, AvailableWinner[]>();
    for (const row of rows) {
      const payload = row.kind === OUTBOX_AVAILABLE_KIND && isAvailableChannel(row.channel) ? check(availablePayload, row.payload) : null;
      if (
        !payload?.ok
        || row.expired
        || row.attempts > OUTBOX_MAX_ATTEMPTS
        || (row.userId !== null && disabledIds.has(row.userId))
      ) {
        drop.push(row.id);
        continue;
      }
      const channel = row.channel as AvailableChannel;
      const list = byChannel.get(channel) ?? [];
      list.push(payload.value);
      byChannel.set(channel, list);
    }

    if (drop.length > 0) {
      await prisma.outbox.deleteMany({ where: { id: { in: drop } } });
      result.dropped = drop.length;
    }
    // One channel after another: a redelivery pass is rare and never urgent.
    // deliverAvailableChannel settles (deletes) what it sent and never throws.
    for (const [channel, winners] of byChannel) {
      await deliverAvailableChannel(channel, winners, logScope);
      result.delivered += winners.length;
    }
    if (result.delivered > 0 || result.dropped > 0) {
      console.warn(`[${logScope}] outbox: re-sent ${result.delivered} notification(s) left unsent by an earlier run, dropped ${result.dropped}`);
    }
  } catch (err) {
    console.warn(`[${logScope}] outbox drain failed:`, err instanceof Error ? err.message : String(err));
  }
  return result;
}
