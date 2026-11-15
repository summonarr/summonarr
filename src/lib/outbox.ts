// The notification outbox — the durable half of a send that can only be made
// once.
//
// Why: the "now available" claim burns MediaRequest.notifiedAvailable before
// anything is sent, and the fan-out ran detached. A restart in between (every
// upgrade is one — the app has no drain on SIGTERM) lost the notification for
// good, because no later run can win that claim again.
//
// How:
//   - The CLAIM writes the outbox rows, one per channel, already locked for
//     OUTBOX_LOCK_MINUTES: "now available" in the claim's own SQL statement
//     (availableOutboxInsert, inside its data-modifying CTE), an approve/decline
//     decision in the claim's own transaction (queueDecisionNotices).
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
import { prisma, type PrismaTxClient } from "./prisma";

export const OUTBOX_AVAILABLE_KIND = "request.available";
export const OUTBOX_APPROVED_KIND = "request.approved";
export const OUTBOX_DECLINED_KIND = "request.declined";
export type DecisionKind = typeof OUTBOX_APPROVED_KIND | typeof OUTBOX_DECLINED_KIND;

// A comment or an issue reply is announced as a WHOLE (one row, channel "all"):
// its audience and channels are decided when it is sent, not when it is written.
export const OUTBOX_COMMENT_KIND = "request.comment";
export const OUTBOX_ISSUE_REPLY_KIND = "issue.reply";
export type AnnouncementKind = typeof OUTBOX_COMMENT_KIND | typeof OUTBOX_ISSUE_REPLY_KIND;
export const OUTBOX_ALL_CHANNELS = "all";

// The channels a request notice goes out on. "Now available" and the
// approve/decline notices use the same five.
export const NOTICE_CHANNELS = ["discord", "push", "inbox", "agents", "email"] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];
export const AVAILABLE_CHANNELS = NOTICE_CHANNELS;
export type AvailableChannel = NoticeChannel;

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
export function availableOutboxInsert(claimed: Prisma.Sql, opts: { exceptRequester?: string } = {}): Prisma.Sql {
  // The admin's manual "mark available": a request the marking admin filed
  // themself owes no notice. The one bind parameter this insert can add.
  const notSelf = opts.exceptRequester !== undefined ? Prisma.sql`WHERE c."requestedBy" <> ${opts.exceptRequester}` : Prisma.empty;
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
    ${notSelf}
    ON CONFLICT ("dedupeKey") DO NOTHING
  `;
}

/**
 * Queue the approve/decline notices a decision owes, INSIDE the transaction
 * that claims it, so the decision and the record that its requester must be
 * told commit together. One row per channel per request, read from the rows as
 * the claim left them (the note included). Skipped for a request the deciding
 * admin filed themself (nobody to tell) and for a disabled requester
 * (guardrail 33). Await it as the transaction's LAST statement (guardrail 23c:
 * one query at a time on a transaction client).
 */
export async function queueDecisionNotices(
  tx: PrismaTxClient,
  kind: DecisionKind,
  requestIds: readonly string[],
  actorId: string,
): Promise<void> {
  if (requestIds.length === 0) return;
  // Module constants written as literals, as in availableOutboxInsert.
  const kindSql = Prisma.raw(`'${kind}'`);
  const channels = Prisma.raw(NOTICE_CHANNELS.map((c) => `'${c}'`).join(","));
  const lockMinutes = Prisma.raw(String(OUTBOX_LOCK_MINUTES));
  const ttlHours = Prisma.raw(String(OUTBOX_TTL_HOURS));
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "Outbox" (id, kind, channel, "dedupeKey", "userId", payload, attempts, "lockedUntil", "createdAt", "expiresAt")
    SELECT gen_random_uuid()::text,
           ${kindSql},
           ch,
           ${kindSql} || ':' || m.id || ':' || ch,
           m."requestedBy",
           jsonb_build_object(
             'id', m.id,
             'requestedBy', m."requestedBy",
             'title', m.title,
             'mediaType', m."mediaType"::text,
             'tmdbId', m."tmdbId",
             'posterPath', m."posterPath",
             'arrInstance', m."arrInstance",
             'adminNote', m."adminNote"
           ),
           0,
           NOW() + make_interval(mins => ${lockMinutes}),
           NOW(),
           NOW() + make_interval(hours => ${ttlHours})
    FROM "MediaRequest" m
    JOIN "User" u ON u.id = m."requestedBy" AND u."deactivatedAt" IS NULL
    CROSS JOIN unnest(ARRAY[${channels}]) AS ch
    WHERE m.id IN (${Prisma.join([...requestIds])})
      AND m."requestedBy" <> ${actorId}
    ON CONFLICT ("dedupeKey") DO NOTHING
  `);
}

/**
 * Queue the announcement a new comment or issue reply owes, INSIDE the
 * transaction that writes it. `subjectId` is the comment/message id, `authorId`
 * its writer (the purge deletes by it), `payload` everything the announcer
 * needs — a plain JSON object. One row; the announcer deletes it once every
 * channel has returned (settleOutbox with OUTBOX_ALL_CHANNELS). Await it as the
 * transaction's LAST statement.
 */
export async function queueAnnouncement(
  tx: PrismaTxClient,
  kind: AnnouncementKind,
  subjectId: string,
  authorId: string,
  payload: Prisma.InputJsonObject,
): Promise<void> {
  const now = Date.now();
  await tx.outbox.create({
    data: {
      kind,
      channel: OUTBOX_ALL_CHANNELS,
      dedupeKey: outboxKey(kind, subjectId, OUTBOX_ALL_CHANNELS),
      userId: authorId,
      payload,
      lockedUntil: new Date(now + OUTBOX_LOCK_MINUTES * 60_000),
      expiresAt: new Date(now + OUTBOX_TTL_HOURS * 3_600_000),
    },
  });
}

/**
 * The notice is no longer owed on ANY channel (an approval whose push failed
 * and was taken back): delete every channel's rows. Never throws; rows a failed
 * delete leaves are dropped by the drain, which re-checks the request's status.
 */
export async function cancelOutbox(kind: string, subjectIds: readonly string[]): Promise<void> {
  if (subjectIds.length === 0) return;
  try {
    await prisma.outbox.deleteMany({
      where: { dedupeKey: { in: subjectIds.flatMap((id) => NOTICE_CHANNELS.map((c) => outboxKey(kind, id, c))) } },
    });
  } catch (err) {
    console.warn(`[outbox] could not cancel ${kind}:`, err instanceof Error ? err.message : String(err));
  }
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
