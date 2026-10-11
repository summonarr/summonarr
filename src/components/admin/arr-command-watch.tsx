"use client";

// Live feedback for a Radarr/Sonarr command Summonarr started — a search, a
// refresh, a rename, a task run, Clear blocklist. The route that queued it
// answers with the arr's command id(s); the watch reads
// GET /api/admin/arr/commands every WATCH_POLL_MS (a setTimeout chain from
// each answer, so reads never overlap) until every command has ended or is no
// longer listed, then calls `onDone` — which is where a page re-reads what the
// command changed, instead of guessing with a fixed timer. It gives up after
// WATCH_MAX_POLLS reads (~10 minutes, counted — never a clock read here,
// guardrail 16), after WATCH_MAX_FAILED_READS failed reads in a row, at once on
// a refusal, and on unmount. The loop and its decisions are the pure
// createCommandWatcher / watchStep / commandLine (lib/arr-command-status.ts);
// this file supplies fetch, timers and React state.
//
// Several watches can run at once, each under a key the page picks (one per
// button). Starting a watch under a key replaces the one there; `stop(key)`
// ends it and forgets it, `stop()` ends them all.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, CircleDashed, Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { cn } from "@/lib/utils";
import {
  commandLine,
  commandLineTone,
  createCommandWatcher,
  isLineActive,
  parseCommandStates,
  readCommandsInChunks,
  type ArrCommandState,
  type CommandLine,
  type WatchRead,
  type WatchStop,
  type WatchTarget,
} from "@/lib/arr-command-status";

export type CommandTarget = WatchTarget;

export interface CommandWatch {
  target: CommandTarget;
  ids: number[];
  /** Shown until the first status arrives — the "started" notice the page always showed. */
  pendingText: string;
  /** The newest read; null until the first answer. */
  states: ArrCommandState[] | null;
  /** Set when the watch gave up before every command ended. */
  stopped: WatchStop | null;
  error: string;
}

export interface WatchOptions {
  pendingText: string;
  /** Every command has ended (or is no longer listed). Never called after a stop or an unmount. */
  onDone?: (states: ArrCommandState[]) => void;
}

const SERVICE_LABEL: Record<CommandTarget["service"], string> = { radarr: "Radarr", sonarr: "Sonarr" };

// The arr's status words, translated (a literal map — never a built key).
const STATUS_KEYS: Record<string, string> = {
  queued: "adminArr.system.command.queued",
  started: "adminArr.system.command.started",
  completed: "adminArr.system.command.completed",
  failed: "adminArr.system.command.failed",
  aborted: "adminArr.system.command.aborted",
  cancelled: "adminArr.system.command.cancelled",
  orphaned: "adminArr.system.command.orphaned",
  unknown: "adminArr.system.command.unknown",
};

// A failure the server didn't word itself carries no text: the line says the
// generic "couldn't read its status" in the viewer's language.
async function readChunk(target: CommandTarget, ids: readonly number[]): Promise<WatchRead> {
  const fallback = "";
  try {
    const q = new URLSearchParams({ service: target.service, instance: target.instance, ids: ids.join(",") });
    const res = await fetch(withBasePath(`/api/admin/arr/commands?${q.toString()}`), { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as unknown;
    if (res.status === 429) return { kind: "rateLimited" };
    if (!res.ok) {
      const body = data && typeof data === "object" ? (data as { error?: unknown }) : null;
      const error = typeof body?.error === "string" ? body.error : fallback;
      return res.status >= 400 && res.status < 500 ? { kind: "refused", error } : { kind: "failed", error };
    }
    const states = parseCommandStates(data, ids);
    return states ? { kind: "ok", states } : { kind: "failed", error: fallback };
  } catch {
    return { kind: "failed", error: fallback };
  }
}

// One poll: every id, COMMAND_READ_MAX_IDS per request (the route's cap) — a
// long series' "search missing" can queue more commands than one read takes.
const readCommands = (target: CommandTarget, ids: readonly number[]): Promise<WatchRead> =>
  readCommandsInChunks(ids, (chunk) => readChunk(target, chunk));

function without(w: Readonly<Record<string, CommandWatch>>, key: string): Readonly<Record<string, CommandWatch>> {
  if (!(key in w)) return w;
  const next = { ...w };
  delete next[key];
  return next;
}

export function useArrCommandWatch() {
  const [watches, setWatches] = useState<Readonly<Record<string, CommandWatch>>>({});
  // One watcher for the component's life; its callbacks run from timers and
  // fetches, never during render.
  const [watcher] = useState(() => createCommandWatcher({
    read: readCommands,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle as number),
    hidden: () => document.visibilityState === "hidden",
    update: (key, change) => setWatches((w) => (w[key] ? { ...w, [key]: { ...w[key], ...change } } : w)),
  }));

  /** Follow `ids` on one instance under `key` (replacing whatever was there). An empty list follows nothing. */
  const watch = useCallback((key: string, target: CommandTarget, ids: readonly number[], opts: WatchOptions) => {
    const started = watcher.start(key, target, ids, opts.onDone);
    const list = [...new Set(ids)];
    setWatches((w) => (started
      ? { ...w, [key]: { target, ids: list, pendingText: opts.pendingText, states: null, stopped: null, error: "" } }
      : without(w, key)));
  }, [watcher]);

  /** End one watch (or every watch) and forget it — no read and no onDone after this. */
  const stop = useCallback((key?: string) => {
    watcher.stop(key);
    setWatches((w) => (key === undefined ? (Object.keys(w).length === 0 ? w : {}) : without(w, key)));
  }, [watcher]);

  // Unmount: every pending read is cancelled, and an answer already on its
  // way is dropped by the watcher's token check.
  useEffect(() => () => watcher.stop(), [watcher]);

  return { watch, stop, watches };
}

/** True while the watch is still polling — the button that started it stays disabled. */
export function isWatchActive(w: CommandWatch | undefined): boolean {
  return w !== undefined && isLineActive(commandLine(w.states, w.stopped, w.error));
}

function lineText(line: CommandLine, w: CommandWatch, t: ReturnType<typeof useT>): string {
  const service = SERVICE_LABEL[w.target.service];
  const status = (s: string) => (STATUS_KEYS[s] ? t(STATUS_KEYS[s]) : s);
  switch (line.kind) {
    case "waiting":
      return w.pendingText;
    case "running": {
      const text = line.message ?? (line.status === "started" ? t("adminArr.commandWatch.running", { service }) : t("adminArr.commandWatch.queued", { service }));
      return line.total > 1 ? `${t("adminArr.commandWatch.progress", { finished: line.finished, total: line.total })} · ${text}` : text;
    }
    case "timeout":
      return t("adminArr.commandWatch.timeout");
    case "error":
      return line.error ? t("adminArr.commandWatch.readFailed", { error: line.error }) : t("adminArr.commandWatch.readFailedGeneric");
    case "done":
      switch (line.status) {
        case "completed":
          // The arr's own result line, unless it only repeats the word.
          return line.message && !/^completed\.?$/i.test(line.message.trim())
            ? t("adminArr.commandWatch.completedWith", { message: line.message })
            : t("adminArr.commandWatch.completed");
        case "gone":
          return t("adminArr.commandWatch.gone", { service });
        case "unknown":
          return t("adminArr.commandWatch.unknown", { service });
        case "cancelled":
          return line.message ? t("adminArr.commandWatch.statusWith", { status: status(line.status), message: line.message }) : status(line.status);
        default:
          return line.message
            ? t("adminArr.commandWatch.statusWith", { status: status(line.status), message: line.message })
            : t("adminArr.commandWatch.noReason", { status: status(line.status), service });
      }
  }
}

/**
 * One line for a watch: the page's "started" notice until the first status,
 * then a spinner and the arr's own progress line, then how it ended.
 */
export function CommandWatchLine({ watch, className = "" }: { watch: CommandWatch; className?: string }) {
  const t = useT();
  const line = commandLine(watch.states, watch.stopped, watch.error);
  const tone = commandLineTone(line);
  const text = lineText(line, watch, t);
  const icon =
    tone === "progress" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
    : tone === "success" ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
    : tone === "neutral" ? <CircleDashed className="h-3.5 w-3.5 shrink-0" aria-hidden />
    : <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  const toneClass = tone === "success" ? "text-green-400" : tone === "warning" ? "text-amber-400" : tone === "danger" ? "" : "text-zinc-400";
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn("m-0 flex items-start gap-1.5 text-xs", toneClass, className)}
      style={tone === "danger" ? { color: "var(--ds-danger)" } : undefined}
    >
      <span className="mt-px">{icon}</span>
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}
