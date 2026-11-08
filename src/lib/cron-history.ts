// The cron run history: the `cron:lastRun:<target>` ledger every cron/sync
// route writes (withCronRunRecording), its readers for the System tab, and the
// skipped answer that leaves it untouched (guardrail 7b).
import { prisma } from "@/lib/prisma";
import { CRON_DEGRADED_HEADER, CRON_SKIPPED_HEADER } from "@/lib/cron-run-outcome";
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";
import { processSingleton } from "@/lib/process-singleton";

/**
 * How many recent runs the ledger keeps per target.
 *
 * 20 is chosen against the FASTEST configured job (warm-activity, 1800s = 2/h):
 * a healthy ledger therefore spans hours, while a job looping once a minute
 * fills all 20 slots inside 20 minutes and is unmistakable. Each entry is ~60
 * bytes, so a full ledger row stays around 1.3 KB.
 */
export const CRON_RUN_HISTORY_LIMIT = 20;

/** One recorded run. Same three fields the top-level ledger has always carried. */
export interface CronRunEntry {
  at: string;
  durationMs: number;
  ok: boolean;
}

// Records a cron/sync job run. Stored in the `Setting` table (key:
// `cron:lastRun:<target>`, value: JSON `{ at, durationMs, ok, recent[] }`) so
// that admin observability surfaces (settings page) don't depend on whether the
// route also writes a `LIBRARY_SYNC` / `CACHE_WARM` audit row — several warm
// jobs deliberately skip audit on cron triggers to avoid flooding the table.
//
// The top-level `{ at, durationMs, ok }` fields are UNCHANGED and remain the
// contract parseCronLastRun reads; `recent` is additive, so an older reader
// ignores it and a row written before this shipped still parses.
//
// Why `recent` exists: the ledger used to keep only the newest run, which made
// it structurally unable to answer the one question an operator actually has
// when a job misbehaves — "how OFTEN is this running?". A single timestamp
// looks identical whether the job ran once or four hundred times, so a runaway
// trigger was invisible on the very panel the logs point at
// (`[internal-trigger] … see the sync:full entry under Admin → Settings →
// System`). `recent` is what makes a cadence anomaly legible without log
// archaeology.
//
// The read-modify-write below is serialized per target in this process: a
// manual "Run now" and a scheduled run finishing together would otherwise read
// the same history and the later write would drop the earlier run. Summonarr
// runs as one long-lived server (guardrail 17), so a process-wide queue
// (processSingleton, guardrail 27a) covers every writer; no DB lock is needed
// for an observability row.
const ledgerQueue = processSingleton("cron-history:ledger-queue", () => new Map<string, Promise<void>>());

export function recordCronRun(
  target: string,
  durationMs: number,
  ok: boolean = true,
): Promise<void> {
  // Stamped now, not when the queued write runs.
  const entry: CronRunEntry = { at: new Date().toISOString(), durationMs, ok };
  const write = () => writeCronRun(target, entry);
  const next = (ledgerQueue.get(target) ?? Promise.resolve()).then(write, write);
  ledgerQueue.set(target, next);
  const settle = () => {
    if (ledgerQueue.get(target) === next) ledgerQueue.delete(target);
  };
  void next.then(settle, settle);
  return next;
}

// Never rejects: recording THIS run is the job's actual contract, and a failed
// observability write must never fail the cron route that ran it (guardrail 7b).
// Failures warn once per condition (warnOnChange), not once per run.
async function writeCronRun(target: string, entry: CronRunEntry): Promise<void> {
  const key = `cron:lastRun:${target}`;

  // Best-effort history read: its predecessors are a nicety. A read that throws
  // — or a caller whose Prisma surface has no `setting.findUnique` at all —
  // degrades to "no history yet" and still writes, never propagates.
  let recent: CronRunEntry[] = [];
  try {
    const existing = await prisma.setting.findUnique({
      where: { key },
      select: { value: true },
    });
    recent = parseCronRunHistory(existing?.value);
    forgetWarnOnChange(`cron-history:read:${target}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    warnOnChange(
      `cron-history:read:${target}`,
      why,
      `[cron-history] could not read the ${target} run history; recording this run without it: ${why}`,
    );
  }

  const value = JSON.stringify({
    ...entry,
    recent: [entry, ...recent].slice(0, CRON_RUN_HISTORY_LIMIT),
  });
  try {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    forgetWarnOnChange(`cron-history:write:${target}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    warnOnChange(
      `cron-history:write:${target}`,
      why,
      `[cron-history] could not record the ${target} run: ${why}`,
    );
  }
}

// Wraps a cron/sync route body so a single recordCronRun call always fires on
// completion — including thrown errors and 4xx/5xx responses — instead of every
// route having to remember its own try/finally. Caller is still responsible for
// the inner work; the wrapper just guarantees observability.
//
// ok is derived from: (a) whether the body threw → false, (b) response status
// >= 400 → false, (c) an `X-Cron-Degraded` response header → false, otherwise
// true. The header exists for routes whose caller retry semantics make a non-2xx
// harmful: the docker entrypoint reschedules any non-2xx after CRON_RETRY_INTERVAL
// (300s) instead of SYNC_INTERVAL (3600s), so the orchestrator returning 502 on a
// sustained single-source outage would run a full library replace every 5 minutes
// for the outage's duration. Degraded-but-completed runs return 200 + the header:
// the ledger records ok:false (admin System tab shows the failure) while the cron
// cadence stays at the normal interval. Hard failures should still throw / >=500.
//
// A response carrying `X-Cron-Skipped` (the lock-busy answer, or a job that is
// not configured — see cronSkippedResponse) is NOT recorded at all: no run
// happened, so a ledger entry for it (ok, ~0 ms) would over-count runs/h on the
// System tab — the one place guardrail 7b says a cadence anomaly is read. The
// header lives in cron-run-outcome.ts, which the admin cron table shares to
// show a manual skip as a skip; so does CRON_DEGRADED_HEADER, which every
// producer names instead of spelling the header out.
export { CRON_DEGRADED_HEADER, CRON_SKIPPED_HEADER };

export async function withCronRunRecording<T extends Response>(
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let ok = true;
  let skipped = false;
  try {
    const res = await fn();
    if (res.headers.get(CRON_SKIPPED_HEADER) !== null) skipped = true;
    else if (res.status >= 400 || res.headers.get(CRON_DEGRADED_HEADER) !== null) ok = false;
    return res;
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    if (!skipped) await recordCronRun(target, Date.now() - start, ok);
  }
}

// The "no run happened" answer for a cron route — a busy lock, or a job that is
// not configured: 200 (the entrypoint fast-retries any non-2xx) plus the marker
// withCronRunRecording reads to leave the run ledger untouched.
export function cronSkippedResponse(reason = "already running"): Response {
  return Response.json(
    { skipped: true, reason },
    { headers: { [CRON_SKIPPED_HEADER]: "1" } },
  );
}

export interface CronLastRun {
  at: string;
  durationMs: number;
  ok: boolean;
}

export function parseCronLastRun(raw: string | null | undefined): CronLastRun | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CronLastRun>;
    if (typeof parsed.at !== "string") return null;
    return {
      at: parsed.at,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      ok: parsed.ok !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Read the bounded run history out of a `cron:lastRun:<target>` ledger value,
 * most-recent-first. Returns `[]` rather than throwing on anything malformed —
 * a corrupt observability row must never break the page rendering it.
 *
 * A row written BEFORE `recent` existed has no array, but its top-level fields
 * are still a run we know about, so it degrades to a single-entry history
 * instead of losing the last run on upgrade.
 */
export function parseCronRunHistory(raw: string | null | undefined): CronRunEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const entries = (parsed as { recent?: unknown }).recent;
  if (!Array.isArray(entries)) {
    const single = parseCronLastRun(raw);
    return single ? [single] : [];
  }

  const out: CronRunEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const r = e as Partial<CronRunEntry>;
    // `at` is the only load-bearing field — an entry without a timestamp cannot
    // contribute to a cadence answer, so drop it rather than invent one.
    if (typeof r.at !== "string") continue;
    out.push({
      at: r.at,
      durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
      // Matches parseCronLastRun: only a literal false reads as a failure, so
      // pre-`ok` entries read as successful.
      ok: r.ok !== false,
    });
    if (out.length >= CRON_RUN_HISTORY_LIMIT) break;
  }
  return out;
}

/**
 * How many of `entries` ran at or after `sinceMs` (epoch ms).
 *
 * Saturates at CRON_RUN_HISTORY_LIMIT by construction, so callers that report
 * this to a human should say "N+" once it reaches the cap rather than implying
 * the count is exact.
 */
export function countCronRunsSince(
  entries: readonly CronRunEntry[],
  sinceMs: number,
): number {
  let n = 0;
  for (const e of entries) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && t >= sinceMs) n++;
  }
  return n;
}
