import "server-only";
import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";

type MediaType = "MOVIE" | "TV";

/**
 * Atomically flips `notifiedAvailable: true` on the candidate set (WHERE
 * notifiedAvailable=false) and returns the subset whose row was actually
 * flipped — collapses the snapshot-then-CAS pattern into a single statement
 * so the previous TOCTOU between findMany() and updateMany() is closed.
 *
 * Multiple paths (orchestrator, per-source sync routes, webhooks) can
 * concurrently flip `notifiedAvailable` for overlapping request sets. The
 * `UPDATE ... RETURNING id` is atomic in Postgres: another writer that wins
 * the race for a row sees zero rows affected (notifiedAvailable already true
 * by the time their WHERE clause re-evaluates), so the row appears only in
 * the genuine winner's RETURNING set.
 *
 * When `opts.markAvailable=true` (used by sync paths that also need to flip
 * status), the same UPDATE additionally writes `status='AVAILABLE'` and
 * `availableAt=NOW()`. Without it, only `notifiedAvailable` flips (used by
 * the webhook path where status was already set upstream).
 */
export async function claimAvailableNotificationWinners<T extends { id: string }>(
  candidates: readonly T[],
  opts: { markAvailable?: boolean; requireStatusAvailable?: boolean } = {},
): Promise<T[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((r) => r.id);
  // Non-markAvailable callers (the notify-fallback path) only flip notifiedAvailable
  // for rows ALREADY AVAILABLE — they don't set status themselves — so they pass
  // requireStatusAvailable to keep that guard. markAvailable callers set status in
  // the same statement and don't need it.
  const statusGuard = opts.requireStatusAvailable ? Prisma.sql`AND "status" = 'AVAILABLE'` : Prisma.empty;
  // The markAvailable candidate sets are snapshots of PENDING/APPROVED rows taken
  // earlier in the sync run. An admin can DECLINE one of those rows before the
  // claim executes (the decline CAS doesn't touch notifiedAvailable), and without
  // a status predicate this UPDATE would resurrect the DECLINED row to AVAILABLE —
  // a terminal state (VALID_TRANSITIONS has AVAILABLE: []) — and notify the
  // requester of content the admin just declined. A row that turned AVAILABLE
  // mid-run (webhook flip) is intentionally skipped here; the webhook's own
  // poller and the orchestrator's requireStatusAvailable fallback pick it up.
  const updated = opts.markAvailable
    ? await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "MediaRequest"
        SET "notifiedAvailable" = true,
            "status" = 'AVAILABLE',
            "availableAt" = NOW()
        WHERE id IN (${Prisma.join(ids)})
          AND "notifiedAvailable" = false
          AND "status" IN ('PENDING', 'APPROVED')
        RETURNING id
      `)
    : await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "MediaRequest"
        SET "notifiedAvailable" = true
        WHERE id IN (${Prisma.join(ids)})
          AND "notifiedAvailable" = false
          ${statusGuard}
        RETURNING id
      `);
  if (updated.length === 0) return [];
  const winnerIds = new Set(updated.map((r) => r.id));
  return candidates.filter((r) => winnerIds.has(r.id));
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
