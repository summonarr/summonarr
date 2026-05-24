import "server-only";
import { prisma } from "./prisma";

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
