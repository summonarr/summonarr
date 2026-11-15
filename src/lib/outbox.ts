// The notification outbox — the durable half of a send that can only be made
// once.
//
// Why: the "now available" claim burns MediaRequest.notifiedAvailable before
// anything is sent, and the fan-out ran detached. A restart in between (every
// upgrade is one — the app has no drain on SIGTERM) lost the notification for
// good, because no later run can win that claim again.
//
// How:
//   - The CLAIM writes the outbox rows, in the same SQL statement
//     (availableOutboxInsert below, inside the claim's data-modifying CTE), one
//     row per channel, already locked for OUTBOX_LOCK_MINUTES.
//   - The claimer sends as it always did and deletes each channel's rows when
//     that channel returns (settleOutbox). Steady state: rows live for seconds.
//   - Whatever is still there once its lock lapses was orphaned (the process
//     died, or the delete failed). The drain (outbox-drain.ts) re-locks it,
//     sends it from the stored payload and deletes it.
//
// What this is NOT: a retry for a send the channel itself gave up on. Every
// sender swallows its own failures (Discord, push, email log and move on), so a
// channel that "returned" is settled whether or not the message landed. Rows
// are per channel so that can change one sender at a time.
//
// Delivery is at-least-once: a death between a send and its delete repeats that
// one channel for that one request.
//
// Zero imports from the notification modules — they import this.

import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";

export const OUTBOX_AVAILABLE_KIND = "request.available";
export const AVAILABLE_CHANNELS = ["discord", "push", "inbox", "agents", "email"] as const;
export type AvailableChannel = (typeof AVAILABLE_CHANNELS)[number];

/** How long a claimer (or a drain pass) owns a row before the drain may take it. */
export const OUTBOX_LOCK_MINUTES = 30;
/** A notification older than this is dropped, not sent late. */
export const OUTBOX_TTL_HOURS = 24;
/** Redeliveries by the drain before a row is given up on. */
export const OUTBOX_MAX_ATTEMPTS = 5;

export function outboxKey(kind: string, subjectId: string, channel: string): string {
  return `${kind}:${subjectId}:${channel}`;
}

/**
 * The INSERT a "now available" claim runs in its own statement: one row per
 * channel for every claimed request whose requester's account is not disabled
 * (guardrail 33 — the same rule as the claim's `deliverable`). `claimed` is the
 * name of the CTE holding the claim's RETURNING rows, which must carry id,
 * requestedBy, title, mediaType, tmdbId, posterPath and arrInstance.
 */
export function availableOutboxInsert(claimed: Prisma.Sql): Prisma.Sql {
  // Every value below is a constant of this module, written into the statement
  // as a literal (integers and fixed lowercase words — nothing from a caller),
  // so the claim's bind parameters stay exactly its candidate ids.
  const kind = Prisma.raw(`'${OUTBOX_AVAILABLE_KIND}'`);
  const channels = Prisma.raw(AVAILABLE_CHANNELS.map((c) => `'${c}'`).join(","));
  const lockMinutes = Prisma.raw(String(OUTBOX_LOCK_MINUTES));
  const ttlHours = Prisma.raw(String(OUTBOX_TTL_HOURS));
  return Prisma.sql`
    INSERT INTO "Outbox" (id, kind, channel, "dedupeKey", "userId", payload, attempts, "lockedUntil", "createdAt", "expiresAt")
    SELECT gen_random_uuid()::text,
           ${kind},
           ch,
           ${kind} || ':' || c.id || ':' || ch,
           c."requestedBy",
           jsonb_build_object(
             'id', c.id,
             'requestedBy', c."requestedBy",
             'title', c.title,
             'mediaType', c."mediaType"::text,
             'tmdbId', c."tmdbId",
             'posterPath', c."posterPath",
             'arrInstance', c."arrInstance"
           ),
           0,
           NOW() + make_interval(mins => ${lockMinutes}),
           NOW(),
           NOW() + make_interval(hours => ${ttlHours})
    FROM ${claimed} c
    JOIN "User" u ON u.id = c."requestedBy" AND u."deactivatedAt" IS NULL
    CROSS JOIN unnest(ARRAY[${channels}]) AS ch
    ON CONFLICT ("dedupeKey") DO NOTHING
  `;
}

/**
 * The channel has been sent for these subjects: delete its rows. Never throws —
 * a failed delete leaves the rows for the drain, which repeats that one channel
 * (at-least-once), and the triggering action must not fail over bookkeeping.
 */
export async function settleOutbox(kind: string, channel: string, subjectIds: readonly string[]): Promise<void> {
  if (subjectIds.length === 0) return;
  try {
    await prisma.outbox.deleteMany({
      where: { dedupeKey: { in: subjectIds.map((id) => outboxKey(kind, id, channel)) } },
    });
  } catch (err) {
    console.warn(`[outbox] could not settle ${kind}/${channel}; the drain will repeat it:`, err instanceof Error ? err.message : String(err));
  }
}
