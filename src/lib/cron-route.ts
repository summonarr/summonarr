// The one shape every /api/cron/* route shares (guardrails 6, 7b, 41):
//
//   auth (getCronActor) → 401
//   → a pre-lock skip: the job is off or unconfigured → cronSkippedResponse
//   → the run ledger (withCronRunRecording)
//   → the job's advisory lock; busy → cronSkippedResponse
//   → the work, with the lock's AbortSignal
//   → { ok, …fields, error?, timestamp }, 200 either way, X-Cron-Degraded on a
//     run with problems (the entrypoint fast-retries any non-2xx, so a partial
//     failure must stay 200 and the header is what records it failed).
//
// Each route used to spell all of that out, and the copies drifted: one answered
// a partial failure 500, one sent a non-numeric degraded header, two never
// reported a stopped run.
import { NextRequest, NextResponse } from "next/server";
import { getCronActor, type CronActor } from "@/lib/cron-auth";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { CRON_DEGRADED_HEADER, cronSkippedResponse, withCronRunRecording } from "@/lib/cron-history";
import { logAudit } from "@/lib/audit";

export interface CronRunContext {
  /** The lock's signal: aborted on the work timeout or a lost lock connection. Observe it and RETURN (guardrail 41). */
  signal: AbortSignal;
  /** Who drove the run: an admin ("Run now") or the scheduler. */
  actor: CronActor;
  /** Milliseconds since the work started (the lock was just taken). */
  elapsedMs(): number;
}

/** What a finished run reports. */
export interface CronRunReport {
  /** The route's own fields, sent between `ok` and `timestamp`. */
  body: Record<string, unknown>;
  /** How many things went wrong; above 0 the run answers ok:false, `error` and X-Cron-Degraded: <problems>. */
  problems?: number;
  /** The `error` a degraded run answers with — the field the admin "Run now" badge shows. */
  error?: string;
}

export interface CronRouteConfig {
  /** The run ledger's target (`cron:lastRun:<target>`) — what the admin cron table's CRON_JOBS row names. */
  target: string;
  /** The job's advisory lock: a named id from advisory-lock.ts, never a literal. */
  lockId: number;
  /** withAdvisoryLock's work timeout (its default is 30 minutes). */
  timeoutMs?: number;
  /**
   * Checked after auth and before the lock. A reason means no run happens (the
   * job is off or unconfigured): answered through cronSkippedResponse, so no
   * lock connection is opened and no ledger row is written (guardrail 7b).
   */
  skipReason?: (actor: CronActor) => Promise<string | null> | string | null;
  /**
   * A cache warm: an admin-triggered run writes a CACHE_WARM audit row under
   * `target`. Scheduled runs don't — they would flood the audit log, and the run
   * ledger already records them.
   */
  cacheWarm?: boolean;
  /** The work. Returns its report, or a Response for an answer outside the run shape. */
  run(ctx: CronRunContext): Promise<CronRunReport | Response>;
}

/**
 * The cron gate (guardrail 6): an admin session or the CRON_SECRET bearer, read
 * once, or 401 before the handler runs. For a cron route with no lock or ledger
 * (a read-only diagnostic); everything else uses defineCronRoute.
 */
export function withCronActor(
  handler: (request: NextRequest, actor: CronActor) => Promise<Response>,
): (request: NextRequest) => Promise<Response> {
  return async (request) => {
    const actor = await getCronActor(request);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return handler(request, actor);
  };
}

/** A cron route handler: `export const POST = defineCronRoute({ … })`. */
export function defineCronRoute(config: CronRouteConfig): (request: NextRequest) => Promise<Response> {
  return withCronActor((_request, actor) => runCronRoute(config, actor));
}

/** Everything after auth. Exported so tests can drive it with an admin actor. */
export async function runCronRoute(config: CronRouteConfig, actor: CronActor): Promise<Response> {
  const skipReason = await config.skipReason?.(actor);
  if (skipReason) return cronSkippedResponse(skipReason);
  return withCronRunRecording(config.target, () => withAdvisoryLock(
    config.lockId,
    (signal: AbortSignal) => runLocked(config, actor, signal),
    // A lock-busy skip is not a run (guardrail 7b).
    () => cronSkippedResponse(),
    config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs },
  ));
}

async function runLocked(config: CronRouteConfig, actor: CronActor, signal: AbortSignal): Promise<Response> {
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  const report = await config.run({ signal, actor, elapsedMs });
  if (report instanceof Response) return report;
  if (config.cacheWarm && actor.trigger !== "cron") {
    await logAudit({
      userId: actor.userId,
      userName: actor.userName,
      action: "CACHE_WARM",
      target: config.target,
      details: { ...report.body, durationMs: elapsedMs(), trigger: actor.trigger },
    });
  }
  return cronRunResponse(report);
}

/**
 * A finished run's answer. Always 200: the entrypoint fast-retries any non-2xx,
 * so a partial failure is `ok: false` + `error` + X-Cron-Degraded (a count),
 * which withCronRunRecording reads to record the run as failed.
 */
export function cronRunResponse(report: CronRunReport): NextResponse {
  const problems = report.problems ?? 0;
  const ok = problems === 0;
  return NextResponse.json(
    {
      ok,
      ...report.body,
      ...(ok ? {} : { error: report.error ?? `${problems} problem(s) during the run` }),
      timestamp: new Date().toISOString(),
    },
    ok ? undefined : { headers: { [CRON_DEGRADED_HEADER]: String(problems) } },
  );
}
