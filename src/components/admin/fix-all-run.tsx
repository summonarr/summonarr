"use client";

// The bulk "Fix all" control shared by the library diff (suspected bad
// matches) and the library match check: confirm first, one remap at a time
// (src/lib/client/fix-all-sequence.ts), stoppable, and stopped when the page
// goes away. The hook lives in the PAGE, not in the control, so the rows can
// lock what the run still has to do (`pending`): a row's own fix started on a
// title the run then reaches came back as a false "not found" error.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n/i18n-provider";
import { fixMatchErrorMessage, fixMatchWarningMessage, runFixMatch } from "@/lib/client/fix-match";
import {
  fixAllProgress,
  runFixAllSequence,
  type FixAllEntry,
  type FixAllProgress,
  type FixAllResult,
} from "@/lib/client/fix-all-sequence";

export type FixAllState = "idle" | "confirm" | "running" | "done";

export interface FixAllRun {
  state: FixAllState;
  progress: FixAllProgress;
  results: FixAllResult[];
  /** The keys the running run has not answered yet (empty when idle or done). */
  pending: ReadonlySet<string>;
  /** A run has started (it stays true once it ended, so its results outlive the list emptying). */
  started: boolean;
  askConfirm: () => void;
  cancelConfirm: () => void;
  stop: () => void;
  /**
   * Runs `entries` in order. `onFixed` follows each remap that went through,
   * with its warning — the row keeps it (a bulk run that dropped it read
   * "N/N fixed" over a remap that was only partial).
   */
  start: <E extends FixAllEntry>(entries: readonly E[], onFixed?: (entry: E, warning: string | undefined) => void) => Promise<void>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export function useFixAllRun(): FixAllRun {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<FixAllState>("idle");
  const [results, setResults] = useState<FixAllResult[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(NO_KEYS);
  const [started, setStarted] = useState(false);

  // Stop request + unmount guard: the remap already running finishes on the
  // server (its job is not cancelled), but no further one is started — and
  // leaving the page stops the status poll and writes nothing more.
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stopRef.current = true; abortRef.current?.abort(); };
  }, []);

  const start = useCallback(async <E extends FixAllEntry>(
    entries: readonly E[],
    onFixed?: (entry: E, warning: string | undefined) => void,
  ) => {
    stopRef.current = false;
    setStarted(true);
    setState("running");
    setTotal(entries.length);
    setResults([]);
    setPending(new Set(entries.map((e) => e.key)));
    const { results: all, aborted } = await runFixAllSequence(entries, {
      fix: (request, signal) => runFixMatch(request, { signal }),
      warningOf: (outcome) => fixMatchWarningMessage(outcome, t),
      errorOf: (err) => fixMatchErrorMessage(err, t),
      stopped: () => stopRef.current,
      onTitleStart: (ac) => { abortRef.current = ac; },
      onResult: (result, entry, sofar) => {
        if (result.kind !== "error") onFixed?.(entry, result.text);
        setResults([...sofar]);
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(entry.key);
          return next;
        });
      },
    });
    // A Stop aborts only the wait on the title in flight (its job carries on
    // server-side); the run then ends as stopped. A page that went away writes nothing.
    if (!alive.current || (aborted && !stopRef.current)) return;
    setPending(NO_KEYS);
    setState("done");
    if (all.some((r) => r.kind !== "error")) router.refresh();
  }, [router, t]);

  return {
    state,
    progress: fixAllProgress(results, total, state === "done"),
    results,
    pending,
    started,
    askConfirm: () => setState("confirm"),
    cancelConfirm: () => setState("idle"),
    stop: () => { stopRef.current = true; abortRef.current?.abort(); },
    start,
  };
}

const BUTTON = "ds-tap inline-flex items-center font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BUTTON_STYLE = { padding: "5px 12px", fontSize: 12, borderRadius: 6 } as const;
const GHOST_STYLE = { ...BUTTON_STYLE, border: "1px solid var(--ds-border)", color: "var(--ds-fg-muted)" } as const;

/**
 * The Fix all button, its confirm and the run's results. `count` is what a
 * click would run; `label` is the button's text for the run's state (each page
 * words its own); `onConfirm` starts the run. `outcomes`: "all" lists every
 * title (the rows leave on refresh), "errors" only the failures (the rows keep
 * their warnings themselves).
 */
export function FixAllControl({
  run,
  count,
  label,
  onConfirm,
  outcomes,
  maxWidth,
}: {
  run: FixAllRun;
  count: number;
  label: string;
  onConfirm: () => void;
  outcomes: "all" | "errors";
  maxWidth: number;
}) {
  const t = useT();
  // The confirm replaces the focused button: focus goes to its Cancel, to Stop
  // while running, and back to the button when it is offered again.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const state = run.state;
  useEffect(() => {
    if (state === "confirm") cancelRef.current?.focus();
    else if (state === "running") stopButtonRef.current?.focus();
    else if (refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [state]);

  if (count === 0 && state === "idle") return null;
  const listed = outcomes === "all" ? run.results : run.results.filter((r) => r.kind === "error");
  return (
    <div className="flex flex-col items-end gap-1" style={{ maxWidth }}>
      {state === "confirm" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>{t("adminManage.library.match.confirmAll", { count })}</span>
          <button type="button" onClick={() => { refocus.current = true; onConfirm(); }} className={BUTTON} style={{ ...BUTTON_STYLE, background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}>
            {t("adminManage.library.match.rematchAll")}
          </button>
          <button ref={cancelRef} type="button" onClick={() => { refocus.current = true; run.cancelConfirm(); }} className={`${BUTTON} ds-hover-tint`} style={GHOST_STYLE}>
            {t("adminManage.library.match.cancel")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            ref={triggerRef}
            type="button"
            onClick={run.askConfirm}
            disabled={state === "running" || count === 0}
            className={BUTTON}
            style={{
              ...BUTTON_STYLE,
              background: "color-mix(in oklab, var(--ds-success) 14%, transparent)",
              border: "1px solid color-mix(in oklab, var(--ds-success) 35%, var(--ds-border))",
              color: "var(--ds-success)",
            }}
          >
            {label}
          </button>
          {state === "running" && (
            <button ref={stopButtonRef} type="button" onClick={run.stop} className={`${BUTTON} ds-hover-tint`} style={GHOST_STYLE}>
              {t("adminManage.library.diff.stop")}
            </button>
          )}
        </div>
      )}
      {listed.length > 0 && (
        <ul role="log" aria-relevant="additions" className="m-0 list-none p-0 text-right" style={{ fontSize: 11, lineHeight: 1.35, maxHeight: 160, overflowY: "auto" }}>
          {listed.map((o) => (
            <li key={o.key} className={o.kind === "error" ? "text-red-400" : o.kind === "warn" ? "text-amber-400" : ""} style={o.kind === "ok" ? { color: "var(--ds-fg-subtle)" } : undefined}>
              <span aria-hidden>{o.kind === "ok" ? "✓ " : o.kind === "warn" ? "⚠ " : "✕ "}</span>
              <span className="font-medium">{o.title}</span>
              {o.text && (<><span style={{ color: "var(--ds-fg-subtle)" }}> — </span>{o.text}</>)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
