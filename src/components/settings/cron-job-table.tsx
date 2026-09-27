"use client";

import { useState } from "react";
import { Loader2, Play, CheckCircle, XCircle, Clock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format-duration";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import { withBasePath } from "@/lib/base-path";

export interface CronJobInfo {
  name: string;
  description: string;
  endpoint: string;
  interval: string;
  lastRun: string | null;
  lastDuration: number | null;
  lastStatus: "ok" | "error" | null;
  /**
   * Runs recorded in the hour before this page was rendered, or null when the
   * ledger holds no history for this target (a job that has only ever reported
   * through the audit-log fallback, or has not run since the history shipped).
   *
   * Computed on the SERVER and passed in as a plain number — never derived from
   * Date.now() during render here, which would be a guardrail-16 hydration bug.
   */
  runsLastHour: number | null;
  /** True when runsLastHour hit the ledger cap, so the true count may be higher. */
  runsLastHourCapped: boolean;
}

// At this many runs in an hour or more, the count is shown in warning colour.
// With default intervals the most frequent job here is Warm Activity, every
// 1800s (2 per hour), so 4 per hour is double that and not normal for any row.
// The count is shown either way — this number only picks the colour.
const RUNS_PER_HOUR_WARN_AT = 4;

// Admin table of the app's scheduled (cron) jobs: when each last ran, whether
// it worked, and a Run button to start one by hand.
export function CronJobTable({ jobs: initialJobs }: { jobs: CronJobInfo[] }) {
  const [jobs, setJobs] = useState(initialJobs);
  const [running, setRunning] = useState<Set<string>>(new Set());
  // Why the last MANUAL run of each job failed. Kept client-side only: the
  // server-rendered rows carry no reason, so scheduled failures show none.
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const mounted = useHasMounted();

  async function triggerJob(endpoint: string, name: string) {
    setRunning((prev) => new Set(prev).add(name));
    const setRunError = (message: string | null) =>
      setRunErrors((prev) => {
        const next = { ...prev };
        if (message) next[name] = message;
        else delete next[name];
        return next;
      });
    try {
      const res = await fetch(withBasePath(endpoint), { method: "POST" });
      const data = await res.json() as { ok?: boolean; skipped?: unknown; durationMs?: number; error?: string };
      // Success = a 2xx status and no `error` field. Don't look at `ok` or
      // `skipped`: most of these endpoints don't return `ok` at all (/api/sync
      // answers {checked, marked, …}), and /api/sync/ratings' `skipped` is a
      // COUNT, so `skipped: 0` — the best possible run — would look like a
      // failure. Real failures come back as a non-2xx status (e.g. upcoming's
      // 502) or as an `error` field on a 200 (a partly failed sync).
      const succeeded = res.ok && !data.error;
      setRunError(succeeded ? null : typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);

      setJobs((prev) =>
        prev.map((j) =>
          j.name === name
            ? {
                ...j,
                lastRun: new Date().toISOString(),
                lastDuration: data.durationMs ?? null,
                lastStatus: succeeded ? "ok" : "error",
                // A manual run is recorded in the same run history as a
                // scheduled one, so count it here too without needing a reload.
                runsLastHour: (j.runsLastHour ?? 0) + 1,
              }
            : j,
        ),
      );
    } catch {
      setRunError("Network error or unreadable response");
      setJobs((prev) =>
        prev.map((j) =>
          j.name === name
            ? { ...j, lastRun: new Date().toISOString(), lastDuration: null, lastStatus: "error" as const, runsLastHour: (j.runsLastHour ?? 0) + 1 }
            : j,
        ),
      );
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left">
            <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Job</th>
            <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Interval</th>
            <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Last Run</th>
            {/* Duration is the least useful column, so it's hidden on small
                screens to let the rest of the table fit a ~440px phone without
                sideways scrolling. */}
            <th scope="col" className="hidden sm:table-cell py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Duration</th>
            <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</th>
            <th scope="col" className="py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500"></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const isRunning = running.has(job.name);
            return (
              <tr key={job.name} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                <td className="py-3 pr-4">
                  <div className="text-zinc-100 font-medium text-xs">{job.name}</div>
                  <div className="text-zinc-500 text-[11px] mt-0.5">{job.description}</div>
                </td>
                <td className="py-3 pr-4 text-zinc-400 text-xs tabular-nums whitespace-nowrap">{job.interval}</td>
                <td className="py-3 pr-4 text-zinc-400 text-xs tabular-nums whitespace-nowrap">
                  {job.lastRun ? (
                    <span title={mounted ? new Date(job.lastRun).toLocaleString() : undefined}>
                      {mounted ? formatRelativeTime(job.lastRun) : ""}
                    </span>
                  ) : (
                    <span className="text-zinc-500">never</span>
                  )}
                  {/* How OFTEN it ran, not just when. A single "last run" time
                      looks the same whether the job ran once or 400 times in
                      the hour, which once hid a runaway sync loop. */}
                  {job.runsLastHour != null && job.runsLastHour > 1 && (
                    <div
                      className={`text-[11px] mt-0.5 ${
                        job.runsLastHour >= RUNS_PER_HOUR_WARN_AT ? "text-amber-400" : "text-zinc-500"
                      }`}
                      title={
                        job.runsLastHourCapped
                          ? "At least this many runs in the last hour — the ledger keeps a bounded history, so the true count may be higher."
                          : "Runs recorded in the last hour."
                      }
                    >
                      {job.runsLastHourCapped ? `${job.runsLastHour}+` : job.runsLastHour} runs/h
                    </div>
                  )}
                </td>
                <td className="hidden sm:table-cell py-3 pr-4 text-zinc-400 text-xs tabular-nums whitespace-nowrap">
                  {job.lastDuration != null ? formatDurationMs(job.lastDuration) : "—"}
                </td>
                <td className="py-3 pr-4">
                  {job.lastStatus === "ok" && (
                    <span className="flex items-center gap-1 text-green-400 text-xs">
                      <CheckCircle className="w-3.5 h-3.5" /> OK
                    </span>
                  )}
                  {job.lastStatus === "error" && (
                    <>
                      <span className="flex items-center gap-1 text-red-400 text-xs" title={runErrors[job.name]}>
                        <XCircle className="w-3.5 h-3.5" /> Error
                      </span>
                      {runErrors[job.name] && (
                        <div className="text-[11px] text-zinc-500 mt-0.5 max-w-48 break-words">{runErrors[job.name]}</div>
                      )}
                    </>
                  )}
                  {job.lastStatus === null && (
                    <span className="flex items-center gap-1 text-zinc-500 text-xs">
                      <Clock className="w-3.5 h-3.5" /> —
                    </span>
                  )}
                </td>
                <td className="py-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isRunning}
                    onClick={() => triggerJob(job.endpoint, job.name)}
                    className="h-9 px-2.5 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1.5"
                  >
                    {isRunning ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Running</>
                    ) : (
                      <><Play className="w-3 h-3" /> Run</>
                    )}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
