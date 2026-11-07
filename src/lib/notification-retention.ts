import { prisma } from "@/lib/prisma";

// Notification inbox retention (the purge-notifications cron). Rows are never
// removed otherwise (only a user delete / account purge cascades them), so the
// table grows for ever. Two rules, both age-based on createdAt:
//   - a notification the user has READ goes after READ_DAYS (default 90);
//   - ANY notification, read or not, goes after MAX_DAYS (default 365).
// Env-configured like the cron intervals (no Setting, no UI): read per call.
export const NOTIFICATION_READ_RETENTION_DEFAULT_DAYS = 90;
export const NOTIFICATION_MAX_RETENTION_DEFAULT_DAYS = 365;
export const NOTIFICATION_RETENTION_MIN_DAYS = 7;
// A ceiling, too: a value meant as "for ever" (999999999) puts the cutoff
// outside the Date range, and the Invalid Date made every purge run throw.
export const NOTIFICATION_RETENTION_MAX_DAYS = 36_500;
export const NOTIFICATION_DELETE_BATCH = 2_000;

function envDays(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const n = parseInt(raw, 10);
  return Math.min(NOTIFICATION_RETENTION_MAX_DAYS, Math.max(NOTIFICATION_RETENTION_MIN_DAYS, n));
}

export function notificationRetentionDays(env: NodeJS.ProcessEnv = process.env): { readDays: number; maxDays: number } {
  const readDays = envDays(env.NOTIFICATION_READ_RETENTION_DAYS, NOTIFICATION_READ_RETENTION_DEFAULT_DAYS);
  // A ceiling shorter than the read window would make the read rule dead;
  // keep the ceiling at least as long.
  const maxDays = Math.max(readDays, envDays(env.NOTIFICATION_RETENTION_DAYS, NOTIFICATION_MAX_RETENTION_DEFAULT_DAYS));
  return { readDays, maxDays };
}

export function notificationPurgeWhere(now: Date, readDays: number, maxDays: number) {
  const day = 24 * 60 * 60 * 1000;
  return {
    OR: [
      { createdAt: { lt: new Date(now.getTime() - maxDays * day) } },
      { readAt: { not: null }, createdAt: { lt: new Date(now.getTime() - readDays * day) } },
    ],
  };
}

// Deletes in id batches so one run never holds a long lock. Returns on abort
// (guardrail 41) with what it has deleted so far; the next run continues.
export async function purgeOldNotifications(
  opts: { now?: Date; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<{ deleted: number; readDays: number; maxDays: number; aborted: boolean }> {
  const now = opts.now ?? new Date();
  const { readDays, maxDays } = notificationRetentionDays(opts.env);
  const where = notificationPurgeWhere(now, readDays, maxDays);
  let deleted = 0;
  for (;;) {
    if (opts.signal?.aborted) return { deleted, readDays, maxDays, aborted: true };
    const rows = await prisma.notification.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: NOTIFICATION_DELETE_BATCH,
    });
    if (rows.length === 0) break;
    const res = await prisma.notification.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    deleted += res.count;
    if (rows.length < NOTIFICATION_DELETE_BATCH) break;
  }
  return { deleted, readDays, maxDays, aborted: false };
}
