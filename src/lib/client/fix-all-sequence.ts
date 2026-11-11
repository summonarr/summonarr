// The bulk "Fix all" loop shared by the library diff's suspected bad matches
// and the library match check (useFixAllRun, components/admin/fix-all-run.tsx):
// one remap at a time, each finishing on the server before the next starts
// (guardrail 37a's background job + status poll, runFixMatch).
//
// - Stoppable: no further title starts, and the caller may abort the wait on
//   the one in flight. Its job is not cancelled and finishes on the server; the
//   loop names it (`abortedEntry`) so the caller can say its result is unknown.
// - An abort (the page went away) ends the loop quietly — the job itself
//   carries on — and is never counted as a failure.
// - Every title's outcome is kept, in order: a partial remap's warning
//   (guardrail 37) or the reason one failed is shown beside its name, never
//   folded into an "N/N fixed" total.
//
// React-free so the unit suite drives it with a fake remap
// (tests/fix-all-sequence.test.mts).
import type { FixMatchOutcome, FixMatchRequest } from "./fix-match";

/** One title of a bulk run: its key (the row it fixes), its name and its remap. */
export interface FixAllEntry {
  key: string;
  title: string;
  request: FixMatchRequest;
}

export type FixAllResult = { key: string; title: string; kind: "ok" | "warn" | "error"; text?: string };

export interface FixAllProgress {
  /** Titles answered (fixed or failed). */
  handled: number;
  total: number;
  /** Remapped, with or without a warning. */
  fixed: number;
  failed: number;
  /** Remapped with a warning. */
  partial: number;
  /** The run ended before every title was answered (Stop, or the page went away). */
  stopped: boolean;
}

export function fixAllProgress(results: readonly FixAllResult[], total: number, finished: boolean): FixAllProgress {
  let failed = 0;
  let partial = 0;
  for (const r of results) {
    if (r.kind === "error") failed++;
    else if (r.kind === "warn") partial++;
  }
  return {
    handled: results.length,
    total,
    fixed: results.length - failed,
    failed,
    partial,
    stopped: finished && results.length < total,
  };
}

export interface FixAllDeps<E extends FixAllEntry = FixAllEntry> {
  /** The remap (runFixMatch); rejects with an AbortError when `signal` fires. */
  fix: (request: FixMatchRequest, signal: AbortSignal) => Promise<FixMatchOutcome>;
  /** A remap's warning text, or null when it was clean. */
  warningOf: (outcome: FixMatchOutcome) => string | null;
  /** A failed remap's text. */
  errorOf: (err: unknown) => string;
  /** True once a stop was asked for (checked before each title). */
  stopped: () => boolean;
  /** Each title's controller, so an unmount can abort the poll in flight. */
  onTitleStart?: (controller: AbortController) => void;
  /** After each title: its result, and every result so far. */
  onResult?: (result: FixAllResult, entry: E, results: readonly FixAllResult[]) => void;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Runs `entries` in order. `aborted`: an abort ended it (stop quietly, write nothing more). */
export async function runFixAllSequence<E extends FixAllEntry>(
  entries: readonly E[],
  deps: FixAllDeps<E>,
): Promise<{ results: FixAllResult[]; aborted: boolean; abortedEntry?: E }> {
  const results: FixAllResult[] = [];
  for (const entry of entries) {
    if (deps.stopped()) break;
    const ac = new AbortController();
    deps.onTitleStart?.(ac);
    let result: FixAllResult;
    try {
      const outcome = await deps.fix(entry.request, ac.signal);
      const warning = deps.warningOf(outcome);
      result = warning
        ? { key: entry.key, title: entry.title, kind: "warn", text: warning }
        : { key: entry.key, title: entry.title, kind: "ok" };
    } catch (err) {
      // Unmounted mid-run: stop quietly — the job itself carries on.
      if (isAbortError(err)) return { results, aborted: true, abortedEntry: entry };
      result = { key: entry.key, title: entry.title, kind: "error", text: deps.errorOf(err) };
    }
    results.push(result);
    deps.onResult?.(result, entry, results);
  }
  return { results, aborted: false };
}
