"use client";

import { useState } from "react";
import { Loader2, Play, CheckCircle, XCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface CronJobInfo {
  name: string;
  description: string;
  endpoint: string;
  interval: string;
  lastRun: string | null;
  lastDuration: number | null;
  lastStatus: "ok" | "error" | null;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function CronJobTable({ jobs: initialJobs }: { jobs: CronJobInfo[] }) {
  const [jobs, setJobs] = useState(initialJobs);
  const [running, setRunning] = useState<Set<string>>(new Set());

  async function triggerJob(endpoint: string, name: string) {
    setRunning((prev) => new Set(prev).add(name));
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json() as { ok?: boolean; skipped?: boolean; durationMs?: number; error?: string };

      setJobs((prev) =>
        prev.map((j) =>
          j.name === name
            ? {
                ...j,
                lastRun: new Date().toISOString(),
                lastDuration: data.durationMs ?? null,
                lastStatus: data.ok ? "ok" : data.skipped ? "ok" : "error",
              }
            : j,
        ),
      );
    } catch {
      setJobs((prev) =>
        prev.map((j) =>
          j.name === name
            ? { ...j, lastRun: new Date().toISOString(), lastDuration: null, lastStatus: "error" as const }
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
            <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Job</th>
            <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Interval</th>
            <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Last Run</th>
            <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Duration</th>
            <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</th>
            <th className="py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500"></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const isRunning = running.has(job.name);
            return (
              <tr key={job.name} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                <td className="py-3 pr-4">
                  <div className="text-white font-medium text-xs">{job.name}</div>
                  <div className="text-zinc-500 text-[11px] mt-0.5">{job.description}</div>
                </td>
                <td className="py-3 pr-4 text-zinc-400 text-xs tabular-nums whitespace-nowrap">{job.interval}</td>
                <td className="py-3 pr-4 text-zinc-400 text-xs tabular-nums whitespace-nowrap">
                  {job.lastRun ? (
                    <span title={new Date(job.lastRun).toLocaleString()}>
                      {formatRelativeTime(job.lastRun)}
                    </span>
                  ) : (
                    <span className="text-zinc-600">never</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-zinc-400 text-xs tabular-nums whitespace-nowrap">
                  {job.lastDuration != null ? formatDuration(job.lastDuration) : "—"}
                </td>
                <td className="py-3 pr-4">
                  {job.lastStatus === "ok" && (
                    <span className="flex items-center gap-1 text-green-400 text-xs">
                      <CheckCircle className="w-3.5 h-3.5" /> OK
                    </span>
                  )}
                  {job.lastStatus === "error" && (
                    <span className="flex items-center gap-1 text-red-400 text-xs">
                      <XCircle className="w-3.5 h-3.5" /> Error
                    </span>
                  )}
                  {job.lastStatus === null && (
                    <span className="flex items-center gap-1 text-zinc-600 text-xs">
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
                    className="h-7 px-2.5 text-xs border-zinc-700 text-zinc-400 hover:text-white gap-1.5"
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
