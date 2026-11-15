import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsDeletionVoteThreshold } from "@/lib/email";
import { notifyAdminsDeletionVoteThresholdPush } from "@/lib/push";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";
import { OUTBOX_ALL_CHANNELS, OUTBOX_VOTE_THRESHOLD_KIND, queueVoteAlert, settleOutbox, voteAlertSubject } from "@/lib/outbox";
import {
  DELETION_VOTE_THRESHOLD_KEY,
  deletionVoteMarkerKey,
  parseDeletionVoteThreshold,
} from "@/lib/deletion-vote-keys";

/** The threshold Setting, read on `db` (a transaction's client inside one). 0 = off. */
export async function readDeletionVoteThreshold(db: Pick<typeof prisma, "setting"> = prisma): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: DELETION_VOTE_THRESHOLD_KEY } });
  return parseDeletionVoteThreshold(row?.value);
}

/**
 * The title a /api/votes/[tmdbId] call names: the canonical path id within
 * INT4 and the `mediaType` query parameter. The un-vote (DELETE) and the admin
 * dismiss (PATCH) parse it the same way.
 */
export function parseVoteTitleParams(
  rawId: string,
  searchParams: URLSearchParams,
): { ok: true; tmdbId: number; mediaType: "MOVIE" | "TV" } | { ok: false; error: "tmdbId" | "mediaType" } {
  const tmdbId = parseTmdbIdParam(rawId);
  if (tmdbId === null || !isTmdbIdInRange(tmdbId)) return { ok: false, error: "tmdbId" };
  const mediaType = searchParams.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") return { ok: false, error: "mediaType" };
  return { ok: true, tmdbId, mediaType };
}

/**
 * Fire the "deletion threshold reached" admin alert exactly once per title,
 * after a vote on it COMMITTED. The marker row is an idempotent one-shot gate:
 * createMany(skipDuplicates) reports count === 1 for the single caller that
 * wins the insert and 0 for everyone after. The winner queues the alert in the
 * SAME transaction (outbox.ts), so a process that dies after the claim leaves
 * the alert for the outbox drain instead of losing it — no later vote can win
 * that claim again.
 *
 * Runs OUTSIDE the vote's own write, after it (guardrail 23): a bare create()
 * whose duplicate-key error is caught-and-ignored inside a single-level
 * interactive tx leaves Postgres in the aborted state, so the trailing COMMIT
 * becomes a ROLLBACK and silently discards the vote too. Neither statement of
 * the claim's transaction can raise a duplicate (skipDuplicates, then an
 * upsert).
 */
export async function alertIfVoteThresholdReached(media: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
}): Promise<void> {
  const { tmdbId, mediaType } = media;
  const threshold = await readDeletionVoteThreshold();
  if (threshold <= 0) return;
  const voteCount = await prisma.deletionVote.count({ where: { tmdbId, mediaType } });
  if (voteCount < threshold) return;
  const claimKey = deletionVoteMarkerKey(tmdbId, mediaType);
  // Later votes on an already-alerted title stop here, without writing anything.
  if (await prisma.setting.findUnique({ where: { key: claimKey } })) return;
  const subject = voteAlertSubject(tmdbId, mediaType);
  const queued: ThresholdAlertData = { title: media.title, mediaType, voteCount, posterPath: media.posterPath, tmdbId };
  const won = await prisma.$transaction(async (tx) => {
    const claim = await tx.setting.createMany({ data: [{ key: claimKey, value: "1" }], skipDuplicates: true });
    if (claim.count !== 1) return false;
    await queueVoteAlert(tx, subject, { ...queued });
    return true;
  });
  if (!won) return;
  // Re-count after winning the claim: an admin "dismiss" deletes all votes AND
  // this claim key in one tx, so a dismiss racing between the count above and
  // the claim insert would re-create the key and fire a false threshold alert
  // for a title whose votes were just wiped. Only notify if still over.
  const recount = await prisma.deletionVote.count({ where: { tmdbId, mediaType } });
  if (recount < threshold) {
    // The race wiped the votes, so give the claim back. Left in place, the key
    // would block the alert when the title genuinely reaches the threshold
    // again. Best-effort: the vote is already saved, and the drain drops a
    // queued alert whose title is no longer over the threshold.
    await prisma.setting
      .deleteMany({ where: { key: { in: [claimKey] } } })
      .catch((err) => console.warn("[votes] releasing threshold claim failed:", err));
    await settleOutbox(OUTBOX_VOTE_THRESHOLD_KIND, OUTBOX_ALL_CHANNELS, [subject]);
    return;
  }
  const data = { ...queued, voteCount: recount };
  after(async () => {
    await deliverThresholdAlert(data);
    // A row a failed delete leaves only costs one repeat from the drain.
    await settleOutbox(OUTBOX_VOTE_THRESHOLD_KIND, OUTBOX_ALL_CHANNELS, [subject]);
  });
}

export type ThresholdAlertData = { title: string; mediaType: "MOVIE" | "TV"; voteCount: number; posterPath: string | null; tmdbId: number };

async function deliverThresholdAlert(data: ThresholdAlertData): Promise<void> {
  try {
    emitNotificationEvent({
      event: "vote.threshold",
      media: { type: data.mediaType, tmdbId: data.tmdbId, title: data.title, posterPath: data.posterPath },
      votes: data.voteCount,
    });
  } catch (err) {
    // An outbound-agent failure must not keep the admins' email and push from going out.
    console.warn("[votes] threshold agent emit failed:", err);
  }
  await Promise.allSettled([
    notifyAdminsDeletionVoteThreshold(data),
    notifyAdminsDeletionVoteThresholdPush(data),
  ]);
}

/**
 * The outbox drain's half: an alert whose claimer never finished it. The title
 * is re-judged first — the alert is owed only while the claim marker still
 * stands (a dismiss or a "now available" wipe deletes it) and the title is
 * still at or over the threshold — then delivered with the current count.
 * The row is deleted either way; returns whether the alert was sent. Throws
 * only when a read fails, which leaves the row for the next pass.
 */
export async function deliverQueuedVoteAlert(queued: ThresholdAlertData): Promise<boolean> {
  const { tmdbId, mediaType } = queued;
  const subject = voteAlertSubject(tmdbId, mediaType);
  const threshold = await readDeletionVoteThreshold();
  const claimed = threshold > 0 && (await prisma.setting.findUnique({ where: { key: deletionVoteMarkerKey(tmdbId, mediaType) } })) !== null;
  const voteCount = claimed ? await prisma.deletionVote.count({ where: { tmdbId, mediaType } }) : 0;
  const owed = claimed && voteCount >= threshold;
  if (owed) await deliverThresholdAlert({ ...queued, voteCount });
  await settleOutbox(OUTBOX_VOTE_THRESHOLD_KIND, OUTBOX_ALL_CHANNELS, [subject]);
  return owed;
}
