import "server-only";
import { prisma } from "./prisma";

type MediaType = "MOVIE" | "TV";

/**
 * Filters `candidates` to those whose `notifiedAvailable` was actually flipped
 * by `applyCas`. Pattern: snapshot preState IMMEDIATELY before the CAS, then
 * return the subset whose preState was unnotified and the CAS reported
 * `count > 0`.
 *
 * Multiple paths (orchestrator, per-source sync routes, webhooks) can
 * concurrently flip `notifiedAvailable` for overlapping request sets. Without
 * filtering to actual winners, every caller fires notifications for the full
 * pre-CAS overlap → duplicate "Now Available" pushes/Discord/email/CAS-race.
 *
 * Caller's `applyCas` must include `notifiedAvailable: false` in its WHERE
 * clause — that's what makes it a CAS, not a blind write.
 */
export async function claimAvailableNotificationWinners<T extends { id: string }>(
  candidates: readonly T[],
  applyCas: (ids: string[]) => Promise<{ count: number }>,
): Promise<T[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((r) => r.id);
  const preState = await prisma.mediaRequest.findMany({
    where: { id: { in: ids } },
    select: { id: true, notifiedAvailable: true },
  });
  const stillUnnotifiedIds = new Set(
    preState.filter((r) => !r.notifiedAvailable).map((r) => r.id),
  );
  if (stillUnnotifiedIds.size === 0) return [];
  const { count } = await applyCas(ids);
  if (count === 0) return [];
  return candidates.filter((r) => stillUnnotifiedIds.has(r.id));
}

/**
 * Wipes any user-cast DeletionVotes for the given (tmdbId, mediaType) pairs and
 * clears the per-item `deletionVoteNotified:` Setting key so a fresh round of
 * votes after re-add can re-arm the threshold notification.
 *
 * Call this from every AVAILABLE-transition site. Without it, a user who voted
 * to delete an item that's later re-added (via *arr → webhook or sync) keeps
 * their vote against the now-AVAILABLE row; subsequent threshold notifications
 * fire on stale votes, and the `deletionVoteNotified:` setting key blocks
 * future legitimate threshold notifications.
 *
 * Idempotent (deleteMany on missing rows is a no-op). Best-effort: swallows
 * errors so a transient DB blip during the wipe doesn't roll back the
 * AVAILABLE flip itself.
 */
export async function clearDeletionVotesForTmdbs(
  items: readonly { tmdbId: number; mediaType: MediaType }[],
): Promise<void> {
  if (items.length === 0) return;
  const byType = new Map<MediaType, Set<number>>();
  const settingKeys = new Set<string>();
  for (const { tmdbId, mediaType } of items) {
    let bucket = byType.get(mediaType);
    if (!bucket) {
      bucket = new Set();
      byType.set(mediaType, bucket);
    }
    bucket.add(tmdbId);
    settingKeys.add(`deletionVoteNotified:${tmdbId}:${mediaType}`);
  }
  try {
    await prisma.$transaction([
      ...Array.from(byType.entries()).map(([mediaType, tmdbIds]) =>
        prisma.deletionVote.deleteMany({
          where: { tmdbId: { in: Array.from(tmdbIds) }, mediaType },
        }),
      ),
      prisma.setting.deleteMany({ where: { key: { in: Array.from(settingKeys) } } }),
    ]);
  } catch (err) {
    console.error("[notify-available] clearDeletionVotesForTmdbs failed:", err);
  }
}
