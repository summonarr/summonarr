// The words the fix-match surfaces share: the row button (fix-match-button.tsx),
// its dialog, and the job tray (fix-match-tray.tsx). Pure, no React, so the unit
// suite reads it (tests/fix-match-labels.test.mts). No clock: elapsed time is
// what the poll already measured (guardrail 16).
import type { Translator } from "@/lib/i18n/translate";
import type { FixMatchProgressView } from "@/lib/client/fix-match";
import { check, v, type Infer } from "@/lib/validate";

/** m:ss from a duration the poll measured. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** " · copy 2 of 3" while a multi-copy title is remapped, else "". */
export function copyOfSuffix(p: { copy?: number; copies?: number } | null | undefined, t: Translator): string {
  const copies = p?.copies ?? 0;
  return copies > 1 ? ` · ${t("adminQueue.fixMatch.copyOf", { copy: p?.copy ?? 1, copies })}` : "";
}

/** The row button's label while its job runs: queued, confirming (with the clock and copy), or applying. */
export function fixMatchRunningLabel(progress: FixMatchProgressView | null, t: Translator): string {
  if (progress?.phase === "queued") return t("adminQueue.fixMatch.queued", { ahead: progress.queueAhead ?? 0 });
  if (progress?.remoteApplied) {
    return t("adminQueue.fixMatch.confirming", { elapsed: formatElapsed(progress.elapsedMs) }) + copyOfSuffix(progress, t);
  }
  return t("adminQueue.fixMatch.applying");
}

// One job of GET /api/admin/fix-match/jobs. Checked one by one: a malformed
// entry is dropped rather than rendered (its id is a React key, its status picks
// the words) or allowed to cost the whole list.
const TrayJobSchema = v.object({
  id: v.string(),
  status: v.literal("queued", "running", "done", "failed"),
  title: v.nullable(v.string()),
  server: v.string(),
  // "" = the default server; absent from a server that predates the field.
  serverInstance: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.nullable(v.number()),
  queueAhead: v.optional(v.number()),
  progress: v.optional(v.object({
    phase: v.string(),
    attempt: v.number(),
    attempts: v.number(),
    copy: v.optional(v.number()),
    copies: v.optional(v.number()),
  })),
  warning: v.optional(v.string()),
  error: v.optional(v.string()),
});
export type TrayJob = Infer<typeof TrayJobSchema>;

/** The well-formed jobs of the feed, each id once (the first wins). */
export function trayJobsFrom(raw: readonly unknown[]): TrayJob[] {
  const out: TrayJob[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const job = check(TrayJobSchema, item);
    if (!job.ok || seen.has(job.value.id)) continue;
    seen.add(job.value.id);
    out.push(job.value);
  }
  return out;
}

/** The tray's line for a job: its place in the queue, running (and which copy), or its outcome. */
export function trayStatusText(j: TrayJob, t: Translator): string {
  if (j.status === "queued") return t("adminQueue.fixMatch.queued", { ahead: j.queueAhead ?? 0 });
  if (j.status === "running") return t("adminQueue.fixMatch.tray.running") + copyOfSuffix(j.progress, t);
  // The job's own message is the server's translated reason (a 409 conflict,
  // a locked item, …), so it is shown as is.
  if (j.status === "failed") return j.error || t("adminQueue.fixMatch.tray.failed");
  return j.warning || t("adminQueue.fixMatch.tray.done");
}
