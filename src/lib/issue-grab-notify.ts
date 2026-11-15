// The push that tells an admin "the replacement for this issue landed".
//
// It is owed from the moment a Download webhook claims the grab
// (IssueGrab.notifiedAt, a once-only compare-and-swap — arr-webhook.ts), so the
// claim queues it in the same transaction (outbox.ts) and it is deleted only
// once the push service has answered. A push that failed in a way worth
// repeating, or a process that died after the claim, leaves the row for the
// outbox drain. The outbound-agent emit and the auto-resolve happen once, at
// the claim, and are never repeated.
import type { IssueGrab } from "@/generated/prisma";
import { prisma, type PrismaTxClient } from "./prisma";
import { notifyAdminGrabCompletedPush, type AdminGrabPushOutcome } from "./push";
import { OUTBOX_GRAB_CHANNEL, OUTBOX_GRAB_KIND, queueGrabPush, settleOutbox } from "./outbox";

export interface GrabPush {
  userId: string;
  title: string;
  tmdbId: number;
  mediaType: string;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  issueId: string;
}

type GrabPushFields = Pick<IssueGrab, "triggeredById" | "title" | "tmdbId" | "mediaType" | "scope" | "seasonNumber" | "episodeNumber" | "issueId">;
export const grabPushOf = (grab: GrabPushFields): GrabPush => ({
  userId: grab.triggeredById,
  title: grab.title,
  tmdbId: grab.tmdbId,
  mediaType: grab.mediaType,
  scope: grab.scope,
  seasonNumber: grab.seasonNumber,
  episodeNumber: grab.episodeNumber,
  issueId: grab.issueId,
});

/**
 * Claim a grab and queue its push, together. True for the one caller that won
 * the claim. The queue insert is the transaction's last statement: a push that
 * cannot be queued rolls the claim back, so a later delivery claims it again.
 */
export async function claimGrabAndQueuePush(grab: IssueGrab, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx: PrismaTxClient) => {
    const claimed = await tx.issueGrab.updateMany({ where: { id: grab.id, notifiedAt: null }, data: { notifiedAt: now } });
    if (claimed.count === 0) return false;
    await queueGrabPush(tx, grab.id, grab.triggeredById, { ...grabPushOf(grab) });
    return true;
  });
}

/**
 * Send a queued grab push and settle its row unless the send is worth
 * repeating ("failed": no device was reached). Never throws; a thrown send
 * leaves the row owed.
 */
export async function deliverGrabPush(grabId: string, push: GrabPush, logScope: string): Promise<AdminGrabPushOutcome> {
  let outcome: AdminGrabPushOutcome;
  try {
    outcome = await notifyAdminGrabCompletedPush(push);
  } catch (err) {
    console.warn(`${logScope} grab notification failed, will retry push:`, err instanceof Error ? err.message : String(err));
    return "failed";
  }
  if (outcome === "failed") {
    console.warn(`${logScope} grab notification failed, will retry push`);
    return outcome;
  }
  // Nothing a retry would change: no subscription or keys (logged, so an
  // operator can wire up another channel), push switched off, or delivered.
  if (outcome === "skipped-no-subs" || outcome === "skipped-no-keys") {
    console.warn(`${logScope} grab push skipped (${outcome}) for user=${push.userId} issue=${push.issueId}`);
  }
  await settleOutbox(OUTBOX_GRAB_KIND, OUTBOX_GRAB_CHANNEL, [grabId]);
  return outcome;
}
