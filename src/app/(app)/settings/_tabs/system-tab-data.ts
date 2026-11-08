import { prisma } from "@/lib/prisma";
import { parseCronRunHistory, type CronRunEntry } from "@/lib/cron-history";
import { CRON_JOBS, lastRunFromAudit, lastRunFromLedger, type CronLastRunInfo } from "./cron-jobs";

/**
 * Every listed job's last run and bounded run history. Primary source: the
 * `cron:lastRun:<target>` Setting rows `recordCronRun` writes on every run
 * (admin- or cron-triggered) — several warm jobs deliberately skip the audit
 * log on cron to avoid flooding, so reading the audit table alone showed stale
 * "Last Run" values for those jobs.
 */
export async function loadCronRuns(): Promise<{
  lastRuns: Map<string, CronLastRunInfo>;
  histories: Map<string, CronRunEntry[]>;
}> {
  const cronTargets = CRON_JOBS.map((job) => job.target);
  const lastRunSettings = await prisma.setting.findMany({
    where: { key: { in: cronTargets.map((target) => `cron:lastRun:${target}`) } },
    select: { key: true, value: true },
  });

  const lastRunMap = new Map<string, CronLastRunInfo>();
  // Bounded run history, Setting rows only — the audit-log fallback below has
  // no equivalent, so a target that only ever reported there stays without one
  // and the table omits a rate for it rather than showing a wrong one.
  const historyMap = new Map<string, CronRunEntry[]>();
  for (const s of lastRunSettings) {
    const target = s.key.replace(/^cron:lastRun:/, "");
    historyMap.set(target, parseCronRunHistory(s.value));
    const last = lastRunFromLedger(s.value);
    if (last) lastRunMap.set(target, last);
  }

  // The audit log is the fallback for a job with no usable ledger row (one
  // that has not run since the ledger existed), so it is asked only for those.
  // One index-bounded LIMIT-1 read per target (`@@index([target])`), NOT a
  // single `distinct: ["target"]` query: Prisma's query compiler implements
  // `distinct` client-side, so that shape transferred EVERY audit row for
  // these targets (the orchestrator writes one per run, kept for 365 days)
  // into Node on each System-tab render just to keep one per target.
  const unrecorded = cronTargets.filter((target) => !lastRunMap.has(target));
  const lastRuns = await Promise.all(
    unrecorded.map((target) =>
      prisma.auditLog.findFirst({
        where: { target },
        orderBy: { createdAt: "desc" },
        select: { target: true, createdAt: true, details: true },
      }),
    ),
  );
  for (const r of lastRuns) {
    if (!r) continue;
    lastRunMap.set(r.target, lastRunFromAudit(r.createdAt, r.details));
  }
  return { lastRuns: lastRunMap, histories: historyMap };
}
