"use client";

// Admin → Arr System. The parts of Radarr's and Sonarr's own System and
// Settings screens an admin opens them for, across every configured instance:
//   Tasks               — the scheduled tasks (last/next run, Run now), the
//                         commands running or just run (cancel a queued one),
//                         and the two library-wide searches (every monitored
//                         missing title, every title below cutoff).
//   Indexers & clients  — which indexers and download clients exist, which
//                         are on (failing ones are in the health panel above);
//                         switch them, test them. Their settings (API keys,
//                         passwords) never leave the server.
//   Storage             — root folders (free space, reachable, folders the arr
//                         has no title for) and disks.
// Live reads (GET /api/admin/arr/{tasks,providers,storage}); the Tasks tab
// re-reads while visible so a command's status moves on its own — a tick is
// skipped while a read is still out (createLoadGate), never stacked on it.
// Opening a tab paints the last answer the server kept for its read at once
// (useArrSnapshot, marked with when it was read) while that live read is out;
// the live answer then replaces it. Display only: every action below still
// re-checks live on the server (guardrail 5e).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, FilterBar, type ChipTone } from "@/components/ui/design";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { CommandWatchLine, isWatchActive, useArrCommandWatch } from "@/components/admin/arr-command-watch";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { queueFormatters } from "@/components/admin/queue-format";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, CircleDashed, Clock, HardDrive, Loader2, Play, RefreshCw, Search, Server, X, XCircle,
} from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind, type ArrErrorKind } from "@/lib/arr-error-kind";
import {
  bulkActionCommand,
  createLoadGate,
  isTransientJobPollFailure,
  JOB_MAX_FAILED_POLLS,
  taskRisk,
  type ArrCommandRow, type ArrDisk, type ArrDownloadClient, type ArrIndexer, type ArrRootFolder, type ArrTag, type ArrTask,
  type CommandStatus, type LoadKind, type ProviderTestResult,
} from "@/lib/arr-system";

type Service = "radarr" | "sonarr";
type Tab = "tasks" | "providers" | "storage";
interface InstanceRef { service: Service; slug: string; name: string }
interface Report<T> {
  instances: InstanceRef[];
  errors: Array<{ service: Service; instance: string; error: string; kind?: ArrErrorKind }>;
  results: Array<{ service: Service; instance: string } & T>;
}

const TASKS_POLL_MS = 15_000;
const SERVICE_LABEL: Record<Service, string> = { radarr: "Radarr", sonarr: "Sonarr" };

type CallResult<T> = { data: T; status: number } | { error: string; status: number; body: Record<string, unknown> | null };

/**
 * The URL a tab's report is read from. ONE builder for the live read and its
 * snapshot (useArrSnapshot), so both name the same server-side snapshot key.
 */
const reportUrl = (path: string) => withBasePath(path);

async function call<T>(path: string, init: { method: string; body?: unknown } | undefined, fallback: string): Promise<CallResult<T>> {
  return callUrl<T>(withBasePath(path), init, fallback);
}

/** `call` on a URL that already carries the base path. */
async function callUrl<T>(url: string, init: { method: string; body?: unknown } | undefined, fallback: string): Promise<CallResult<T>> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    });
    const data = (await res.json().catch(() => null)) as unknown;
    const body = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    if (!res.ok || !body) {
      return { error: typeof body?.error === "string" ? body.error : fallback, status: res.status, body };
    }
    return { data: body as T, status: res.status };
  } catch {
    return { error: fallback, status: 0, body: null };
  }
}

// A provider test or a testing save waits on the arr for up to two minutes —
// longer than a reverse proxy holds a request open (nginx ~60 s, Cloudflare
// ~100 s), which answered the browser with a proxy error while the save landed.
// So they run as background jobs: the call is sent with `async: true`, answers
// 202 { job }, and `?job=` is polled until the route's own answer arrives.
// Time is counted in polls, never read off the clock (guardrail 16).
const JOB_POLL_MS = 2_000;
/** ~5 minutes of polls: past the server's longest wait (a 120 s test, then a minute of read-backs). */
const JOB_MAX_POLLS = 150;

/**
 * `call` as a background job. Null when `alive()` turned false (the tab went
 * away) — the caller drops it. Out of polls, the answer is `stillRunning`
 * (body `{ stillRunning: true }`): the job may yet finish, so the caller shows
 * it as pending, never as a failure of the change. A poll that failed on the
 * way (isTransientJobPollFailure — a network blip, a proxy 502 with no JSON)
 * is not the job's answer: it is retried, and JOB_MAX_FAILED_POLLS of them in
 * a row are `stillRunning` too, because the job keeps running on the server.
 */
async function callJob<T>(
  path: string,
  init: { method: string; body: Record<string, unknown> },
  fallback: string,
  stillRunning: string,
  alive: () => boolean,
): Promise<CallResult<T> | null> {
  let res = await call<T>(path, { method: init.method, body: { ...init.body, async: true } }, fallback);
  let failedPolls = 0;
  for (let polls = 0; "data" in res && res.status === 202; polls++) {
    const job = (res.data as { job?: unknown }).job;
    if (typeof job !== "string") return { error: fallback, status: 0, body: null };
    if (polls >= JOB_MAX_POLLS) return { error: stillRunning, status: 0, body: { stillRunning: true } };
    await new Promise((resolve) => window.setTimeout(resolve, JOB_POLL_MS));
    if (!alive()) return null;
    const next = await call<T>(`${path}?job=${encodeURIComponent(job)}`, undefined, fallback);
    if (!("data" in next) && isTransientJobPollFailure(next.status, next.body)) {
      // `res` stays the last 202: poll again (the polls cap still counts).
      if (++failedPolls >= JOB_MAX_FAILED_POLLS) return { error: stillRunning, status: 0, body: { stillRunning: true } };
      continue;
    }
    failedPolls = 0;
    res = next;
  }
  return alive() ? res : null;
}

/**
 * Load one of the system reports; `poll` re-reads while the tab is visible. A
 * poll tick is skipped while a read is out; Reload, and the re-read after an
 * action, start at once and supersede it (createLoadGate). `load` resolves
 * true only when ITS report landed — false when it was skipped, superseded or
 * failed (the old report is then still shown).
 *
 * On open the tab's snapshot is painted while the first live read is out
 * (`staleAt` says when it was read). It only ever sets the report: errors,
 * the tab's in-flight tests/saves/runs, its switch overrides and its command
 * watches are the tab's own state and a snapshot never touches them — and it
 * lands at most once, before any live answer, i.e. before there is a row to
 * act on that it could overwrite.
 */
function useReport<T>(path: string, fallback: string, poll: number | null) {
  const [report, setReport] = useState<Report<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [gate] = useState(createLoadGate);
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  }, [fallback]);
  const url = reportUrl(path);
  const snap = useArrSnapshot<Report<T>>(url, (data) => {
    if (data && typeof data === "object" && !Array.isArray(data)) setReport(data);
  });
  const { markLive } = snap;
  const load = useCallback(async (kind: LoadKind = "manual"): Promise<boolean> => {
    const id = gate.begin(kind);
    if (id === null) return false;
    setLoading(true);
    const res = await callUrl<Report<T>>(url, undefined, fallbackRef.current);
    if (!gate.settle(id)) return false;
    setLoading(false);
    if ("data" in res) {
      // This read's answer replaces whatever is shown, a snapshot included.
      markLive();
      setReport(res.data);
      setError("");
      return true;
    }
    setError(res.error);
    return false;
  }, [url, gate, markLive]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (poll === null) return;
    const h = window.setInterval(() => {
      if (document.visibilityState === "visible") void load("poll");
    }, poll);
    return () => window.clearInterval(h);
  }, [poll, load]);
  return { report, loading, error, load, staleAt: snap.staleAt };
}

/** Each instance that could not be read, and why — in the viewer's language (the raw upstream detail stays in the server log). */
function InstanceErrors({ report }: { report: Report<unknown> | null }) {
  const t = useT();
  if (!report || report.errors.length === 0) return null;
  return (
    <>
      {report.errors.map((e) => (
        <p key={`${e.service}:${e.instance}`} role="alert" className="m-0 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t(ARR_ERROR_KIND_KEYS[isArrErrorKind(e.kind) ? e.kind : "other"], { name: labelOf(report, e.service, e.instance) })}
        </p>
      ))}
    </>
  );
}

function Card({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl p-4" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-zinc-100"><Server className="h-4 w-4 text-zinc-500" aria-hidden /> {title}</h2>
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

const labelOf = (report: Report<unknown>, service: Service, slug: string) =>
  arrInstanceLabel(service, report.instances.find((i) => i.service === service && i.slug === slug)?.name, slug);

// ── tasks ────────────────────────────────────────────────────────────────────

const COMMAND_TONE: Record<CommandStatus, ChipTone> = {
  queued: "neutral",
  started: "accent",
  completed: "approved",
  failed: "declined",
  aborted: "declined",
  cancelled: "neutral",
  orphaned: "declined",
  unknown: "neutral",
};
const COMMAND_LABEL: Record<CommandStatus, string> = {
  queued: "adminArr.system.command.queued",
  started: "adminArr.system.command.started",
  completed: "adminArr.system.command.completed",
  failed: "adminArr.system.command.failed",
  aborted: "adminArr.system.command.aborted",
  cancelled: "adminArr.system.command.cancelled",
  orphaned: "adminArr.system.command.orphaned",
  unknown: "adminArr.system.command.unknown",
};

function TasksTab() {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const { report, loading, error, load, staleAt } = useReport<{ tasks: ArrTask[]; commands: ArrCommandRow[] }>("/api/admin/arr/tasks", t("adminArr.system.loadFailed"), TASKS_POLL_MS);
  // Per instance card: the action in flight there. A dark instance holds its
  // POST for the whole arr timeout; that must not lock every other card.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const startBusy = (card: string, action: string) => setBusy((m) => ({ ...m, [card]: action }));
  const endBusy = (card: string) => setBusy((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== card)));
  const [confirming, setConfirming] = useState<string | null>(null);
  // Per card: the newest run's outcome — a refusal, or the key of the command
  // it is following (its line replaces the "started" notice once the arr reports).
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string; watchKey?: string }>>({});
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  // Each run's command, followed live under its button's key: the button stays
  // disabled while it is queued or running, and the report is re-read once it
  // ends (its task's last run, the Recent commands list).
  const { watch, watches } = useArrCommandWatch();

  async function run(key: string, service: Service, instance: string, body: Record<string, unknown>, done: string) {
    const card = `${service}:${instance}`;
    startBusy(card, key);
    setConfirming(null);
    const res = await call<{ id: number | null }>("/api/admin/arr/tasks", { method: "POST", body: { service, instance, ...body } }, t("adminArr.system.runFailed"));
    endBusy(card);
    if (!("data" in res)) {
      setMessages((m) => ({ ...m, [card]: { ok: false, text: res.error } }));
      return;
    }
    const id = res.data.id;
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
      watch(key, { service, instance }, [id], { pendingText: done, onDone: () => void load() });
      setMessages((m) => ({ ...m, [card]: { ok: true, text: done, watchKey: key } }));
    } else {
      setMessages((m) => ({ ...m, [card]: { ok: true, text: done } }));
    }
    // The command is already in the arr's list (queued): show it now.
    void load();
  }

  async function cancel(service: Service, instance: string, id: number) {
    const card = `${service}:${instance}`;
    startBusy(card, `cancel:${card}:${id}`);
    const q = new URLSearchParams({ service, instance, commandId: String(id) });
    const res = await call<{ ok: true }>(`/api/admin/arr/tasks?${q.toString()}`, { method: "DELETE" }, t("adminArr.system.runFailed"));
    endBusy(card);
    if (!("data" in res)) setMessages((m) => ({ ...m, [`${service}:${instance}`]: { ok: false, text: res.error } }));
    void load();
  }

  if (!report) return <Loading error={error} loading={loading} onRetry={() => void load()} />;
  return (
    <div className="grid gap-4">
      <Toolbar loading={loading} onReload={() => void load()} error={error} staleAt={staleAt} />
      <InstanceErrors report={report} />
      {report.results.map((r) => {
        const card = `${r.service}:${r.instance}`;
        const cardBusy = busy[card];
        const name = labelOf(report, r.service, r.instance);
        const msg = messages[card];
        const msgWatch = msg?.watchKey ? watches[msg.watchKey] : undefined;
        const commands = showAll.has(card) ? r.commands : r.commands.slice(0, 8);
        const bulk = (action: "searchMissing" | "searchCutoff") => {
          const key = `${card}:${action}`;
          const label = action === "searchMissing" ? t("adminArr.system.searchAllMissing") : t("adminArr.system.searchAllCutoff");
          // This page's own run still followed live, or — after a tab switch,
          // a page load, or once the watch's poll cap ran out — the same
          // search still queued or running in the 15 s report (a library-wide
          // search runs for hours), as a task row's Run does.
          const commandName = bulkActionCommand(r.service, action).name;
          const active = isWatchActive(watches[key]) || r.commands.some((c) => c.commandName === commandName && (c.status === "started" || c.status === "queued"));
          return confirming === key ? (
            <span key={key} className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
              {action === "searchMissing" ? t("adminArr.system.confirmMissing") : t("adminArr.system.confirmCutoff")}
              {/* Radarr searches from the API ignore Minimum Availability (bulkActionCommand). */}
              {r.service === "radarr" && <> {t("adminArr.system.radarrCaveat")}</>}
              <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>{t("adminArr.common.cancel")}</Button>
              <Button size="xs" disabled={cardBusy !== undefined || active} onClick={() => void run(key, r.service, r.instance, { action }, t("adminArr.system.bulkStarted", { action: label }))}>
                {cardBusy === key && <Loader2 className="animate-spin" />} {t("adminArr.system.confirmRun")}
              </Button>
            </span>
          ) : (
            <Button key={key} variant="outline" size="sm" disabled={cardBusy !== undefined || active} onClick={() => setConfirming(key)}>
              {cardBusy === key || active ? <Loader2 className="animate-spin" /> : <Search />} {label}
            </Button>
          );
        };
        return (
          <Card key={card} title={name} actions={<div className="flex flex-wrap items-center gap-2">{bulk("searchMissing")}{bulk("searchCutoff")}</div>}>
            {msgWatch ? (
              <CommandWatchLine watch={msgWatch} />
            ) : msg && (
              <p role={msg.ok ? "status" : "alert"} className={`m-0 flex items-center gap-1.5 text-xs ${msg.ok ? "text-green-400" : ""}`} style={msg.ok ? undefined : { color: "var(--ds-danger)" }}>
                {msg.ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />} <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{msg.text}</span>
              </p>
            )}
            <div className="overflow-x-auto">
              {/* Below sm: Interval, Took and Next run fold away (next run moves under Last run) and Run is icon-only, so Run stays on screen at 375 px. */}
              <table className="w-full text-sm sm:min-w-[640px]">
                <thead>
                  <tr className="text-left text-xs text-zinc-500">
                    <th className="px-2 py-1.5 font-medium">{t("adminArr.system.task")}</th>
                    <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t("adminArr.system.interval")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("adminArr.system.lastRun")}</th>
                    <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t("adminArr.system.duration")}</th>
                    <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t("adminArr.system.nextRun")}</th>
                    <th className="px-2 py-1.5"><span className="sr-only">{t("adminArr.system.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {r.tasks.map((task) => {
                    const key = `${card}:task:${task.taskName}`;
                    // The 15 s report, or this page's own run still followed live.
                    const running = isWatchActive(watches[key]) || r.commands.some((c) => c.commandName === task.taskName && (c.status === "started" || c.status === "queued"));
                    const risk = taskRisk(task.taskName);
                    const start = () => void run(key, r.service, r.instance, { task: task.taskName }, t("adminArr.system.taskStarted", { task: task.name }));
                    return (
                      <Fragment key={task.taskName}>
                        <tr style={{ borderTop: "1px solid var(--ds-border)" }}>
                          <td className="px-2 py-1.5 text-zinc-100">{task.name}</td>
                          <td className="hidden px-2 py-1.5 text-xs text-zinc-400 sm:table-cell">{task.intervalMinutes ? fmt.duration(task.intervalMinutes * 60) : "—"}</td>
                          <td className="px-2 py-1.5 text-xs text-zinc-400">
                            {fmt.dateTime(task.lastExecution)}
                            <div className="text-zinc-500 sm:hidden">{t("adminArr.system.nextRunShort", { date: fmt.dateTime(task.nextExecution) })}</div>
                          </td>
                          <td className="hidden px-2 py-1.5 text-xs text-zinc-400 sm:table-cell">{task.lastDurationSeconds !== null ? (task.lastDurationSeconds < 60 ? t("adminArr.system.seconds", { count: Math.round(task.lastDurationSeconds) }) : fmt.duration(task.lastDurationSeconds)) : "—"}</td>
                          <td className="hidden px-2 py-1.5 text-xs text-zinc-400 sm:table-cell">{fmt.dateTime(task.nextExecution)}</td>
                          <td className="px-2 py-1.5 text-right">
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={cardBusy !== undefined || running}
                              onClick={() => (risk ? setConfirming(key) : start())}
                              aria-label={t("adminArr.system.runAria", { task: task.name })}
                            >
                              {cardBusy === key || running ? <Loader2 className="animate-spin" /> : <Play />} <span className="hidden sm:inline">{t("adminArr.system.run")}</span>
                            </Button>
                          </td>
                        </tr>
                        {risk && confirming === key && (
                          <tr>
                            <td colSpan={6} className="px-2 pb-2">
                              <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
                                {risk === "update"
                                  ? t("adminArr.system.confirmUpdate", { service: SERVICE_LABEL[r.service] })
                                  : t("adminArr.system.confirmRefresh", { service: SERVICE_LABEL[r.service] })}
                                <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>{t("adminArr.common.cancel")}</Button>
                                <Button size="xs" disabled={cardBusy !== undefined || running} onClick={start}>
                                  {cardBusy === key && <Loader2 className="animate-spin" />} {t("adminArr.system.confirmRun")}
                                </Button>
                              </span>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="grid gap-1.5">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.recentCommands")}</h3>
              {r.commands.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noCommands")}</p>
              ) : (
                <ul id={`commands-${card}`} className="m-0 grid list-none gap-1 p-0">
                  {commands.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <Chip tone={COMMAND_TONE[c.status]}>{t(COMMAND_LABEL[c.status])}</Chip>
                      <span className="text-zinc-200">{c.name}</span>
                      <span className="text-zinc-500">{fmt.dateTime(c.started ?? c.queued)}</span>
                      {c.durationSeconds !== null && c.status !== "queued" && <span className="text-zinc-500">{c.durationSeconds < 60 ? t("adminArr.system.seconds", { count: Math.round(c.durationSeconds) }) : fmt.duration(c.durationSeconds)}</span>}
                      {c.trigger === "scheduled" && <span className="text-zinc-500">{t("adminArr.system.scheduled")}</span>}
                      {c.message && <span className="min-w-0 truncate text-zinc-500" title={c.message}>{c.message}</span>}
                      {c.status === "queued" && (
                        <Button variant="ghost" size="icon-xs" disabled={cardBusy !== undefined} onClick={() => void cancel(r.service, r.instance, c.id)} aria-label={t("adminArr.system.cancelCommand", { name: c.name })} title={t("adminArr.system.cancelCommand", { name: c.name })}>
                          <X />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {r.commands.length > 8 && (
                <button
                  type="button"
                  aria-expanded={showAll.has(card)}
                  aria-controls={`commands-${card}`}
                  className="justify-self-start text-xs text-zinc-500 hover:text-zinc-300"
                  onClick={() => setShowAll((s) => {
                    const next = new Set(s);
                    if (next.has(card)) next.delete(card);
                    else next.add(card);
                    return next;
                  })}
                >
                  {showAll.has(card) ? t("adminArr.system.showFewer") : t("adminArr.system.showAll", { count: r.commands.length })}
                </button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── indexers and download clients ────────────────────────────────────────────

type ProviderKind = "indexer" | "downloadClient";
/**
 * `pending`: the page stopped waiting while the arr was still at it — neither a pass nor a failure.
 * `uncertain`: Test All's answer doesn't say whether the failures were only warnings (projectTestAll).
 */
type TestView = Pick<ProviderTestResult, "ok" | "warning" | "messages" | "uncertain"> & { pending?: boolean };
const pendingView = (res: { error: string; body: Record<string, unknown> | null }): TestView =>
  ({ ok: false, warning: false, messages: [res.error], ...(res.body?.stillRunning === true ? { pending: true } : {}) });
type Change = Record<string, boolean>;
type ToggleOpts = { acceptWarnings?: boolean; confirmed?: boolean };

function ProvidersTab() {
  const t = useT();
  const { report, loading, error, load, staleAt } = useReport<{ indexers: ArrIndexer[]; downloadClients: ArrDownloadClient[]; tags?: ArrTag[] }>("/api/admin/arr/providers", t("adminArr.system.loadFailed"), null);
  // Per instance card (`service:instance`): the test or save in flight there.
  // One card at a time keeps a Test All and a single test on it from racing
  // the results; a dead indexer hanging ~100 s on one instance must not lock
  // every other instance's switches.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, TestView>>({});
  // The last Test All per instance and kind: how many answered, how many work,
  // and how many the arr's answer left unclear (failures it didn't flag either way).
  const [summaries, setSummaries] = useState<Record<string, { working: number; count: number; uncertain: number }>>({});
  const [overrides, setOverrides] = useState<Record<string, ArrIndexer | ArrDownloadClient>>({});
  // A switch-ON the arr held back for warnings alone, until the admin accepts or drops it.
  const [held, setHeld] = useState<Record<string, { change: Change; messages: string[] }>>({});
  // A Prowlarr-managed indexer's switch, until the admin confirms it.
  const [prowlarrAsk, setProwlarrAsk] = useState<{ key: string; change: Change } | null>(null);
  // A test or save still being polled when the tab goes away is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isAlive = useCallback(() => alive.current, []);

  const keyOf = (service: Service, instance: string, kind: ProviderKind, id: number) => `${service}:${instance}:${kind}:${id}`;
  const without = <V,>(m: Record<string, V>, drop: (k: string) => boolean) => Object.fromEntries(Object.entries(m).filter(([k]) => !drop(k)));
  const startBusy = (card: string, action: string) => setBusy((m) => ({ ...m, [card]: action }));
  const endBusy = (card: string) => setBusy((m) => without(m, (key) => key === card));

  async function test(service: Service, instance: string, kind: ProviderKind, id: number | null) {
    const prefix = `${service}:${instance}:${kind}:`;
    const k = id === null ? `${prefix}all` : keyOf(service, instance, kind, id);
    const card = `${service}:${instance}`;
    startBusy(card, `test:${k}`);
    const res = await callJob<{ results: ProviderTestResult[] }>(
      "/api/admin/arr/providers/test",
      { method: "POST", body: { service, instance, kind, ...(id !== null ? { id } : {}) } },
      t("adminArr.system.testFailed"),
      t("adminArr.system.stillRunning", { service: SERVICE_LABEL[service] }),
      isAlive,
    );
    if (res === null) return;
    endBusy(card);
    if ("data" in res) {
      const answered = res.data.results;
      setResults((m) => {
        // Test All replaces every row of the kind (a row it didn't test — one
        // switched off — must not keep an older verdict); a single test clears
        // an earlier refusal shown for the whole kind.
        const next = id === null ? without(m, (key) => key.startsWith(prefix)) : without(m, (key) => key === `${prefix}all`);
        for (const r of answered) next[keyOf(service, instance, kind, r.id)] = r;
        return next;
      });
      setSummaries((m) => {
        if (id !== null) return without(m, (key) => key === `${service}:${instance}:${kind}`);
        return {
          ...m,
          [`${service}:${instance}:${kind}`]: {
            working: answered.filter((r) => r.ok).length,
            count: answered.length,
            uncertain: answered.filter((r) => r.uncertain === true).length,
          },
        };
      });
    } else {
      setResults((m) => ({ ...m, [k]: pendingView(res) }));
      if (id === null) setSummaries((m) => without(m, (key) => key === `${service}:${instance}:${kind}`));
    }
  }

  async function toggle(service: Service, instance: string, kind: ProviderKind, provider: ArrIndexer | ArrDownloadClient, change: Change, opts: ToggleOpts = {}) {
    const k = keyOf(service, instance, kind, provider.id);
    // Prowlarr's next full sync turns a change made here back — say so first.
    if ("managedByProwlarr" in provider && provider.managedByProwlarr && !opts.confirmed) {
      setProwlarrAsk({ key: k, change });
      return;
    }
    setProwlarrAsk(null);
    const card = `${service}:${instance}`;
    startBusy(card, `toggle:${k}`);
    const res = await callJob<{ provider: ArrIndexer | ArrDownloadClient }>(
      "/api/admin/arr/providers",
      { method: "PATCH", body: { service, instance, kind, id: provider.id, ...change, ...(opts.acceptWarnings ? { acceptWarnings: true } : {}) } },
      t("adminArr.system.saveFailed"),
      t("adminArr.system.stillRunning", { service: SERVICE_LABEL[service] }),
      isAlive,
    );
    if (res === null) return;
    endBusy(card);
    setHeld((m) => without(m, (key) => key === k));
    if ("data" in res) {
      setOverrides((m) => ({ ...m, [k]: res.data.provider }));
      setResults((m) => without(m, (key) => key === k));
      return;
    }
    // Held back for warnings alone: show them, and let the admin switch it on anyway.
    if (res.status === 409 && res.body?.warningsOnly === true) {
      const messages = Array.isArray(res.body.messages) ? res.body.messages.filter((x): x is string => typeof x === "string") : [];
      setHeld((m) => ({ ...m, [k]: { change, messages } }));
      setResults((m) => without(m, (key) => key === k));
      return;
    }
    // A save that timed out still says what the arr holds now.
    const now = res.body?.provider;
    if (now && typeof now === "object") setOverrides((m) => ({ ...m, [k]: now as ArrIndexer | ArrDownloadClient }));
    setResults((m) => ({ ...m, [k]: pendingView(res) }));
  }

  function result(k: string, service: Service) {
    const r = results[k];
    if (!r) return null;
    if (r.pending) {
      return (
        <span role="status" className="flex items-start gap-1 text-xs text-amber-400">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{r.messages.join(" ")}</span>
        </span>
      );
    }
    if (r.ok && !r.warning) {
      return <span className="flex items-center gap-1 text-xs text-green-400"><Check className="h-3.5 w-3.5" /> {t("adminArr.system.testOk")}</span>;
    }
    if (r.ok) {
      return (
        <span className="flex items-start gap-1 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{t("adminArr.system.testWarnings")}{r.messages.length > 0 && `: ${r.messages.join(" ")}`}</span>
        </span>
      );
    }
    // Not a failure we can name: Test All didn't say whether these were only
    // warnings, and the row's own Test will.
    if (r.uncertain === true) {
      return (
        <span className="flex items-start gap-1 text-xs" style={{ color: "var(--ds-fg-muted)" }}>
          <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{" "}
          <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
            {t("adminArr.system.testUncertain", { service: SERVICE_LABEL[service] })}{r.messages.length > 0 && `: ${r.messages.join(" ")}`}
          </span>
        </span>
      );
    }
    return (
      <span className="flex items-start gap-1 text-xs" style={{ color: "var(--ds-danger)" }}>
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{r.messages.join(" ") || t("adminArr.system.testFailed")}</span>
      </span>
    );
  }

  function summary(key: string) {
    const s = summaries[key];
    if (!s) return null;
    if (s.count === 0) return <span className="text-xs text-zinc-400">{t("adminArr.system.testNothing")}</span>;
    // Nothing known to have failed (the rest are unclear) is neutral, not a warning.
    const tone = s.working === s.count ? "text-green-400" : s.working + s.uncertain === s.count ? "text-zinc-400" : "text-amber-400";
    return (
      <span className={`text-xs ${tone}`}>
        {t("adminArr.system.testSummary", { working: s.working, count: s.count })}
        {s.uncertain > 0 && ` · ${t("adminArr.system.testSummaryUncertain", { count: s.uncertain })}`}
      </span>
    );
  }

  // What stands between a switch and the arr: a Prowlarr confirm, or warnings to accept.
  function pending(service: Service, instance: string, kind: ProviderKind, provider: ArrIndexer | ArrDownloadClient) {
    const k = keyOf(service, instance, kind, provider.id);
    const h = held[k];
    const cardBusy = busy[`${service}:${instance}`];
    return (
      <>
        {prowlarrAsk?.key === k && (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
            {t("adminArr.system.prowlarrConfirm", { name: provider.name })}
            <Button variant="ghost" size="xs" onClick={() => setProwlarrAsk(null)}>{t("adminArr.common.cancel")}</Button>
            <Button size="xs" disabled={cardBusy !== undefined} onClick={() => void toggle(service, instance, kind, provider, prowlarrAsk.change, { confirmed: true })}>
              {t("adminArr.system.changeAnyway")}
            </Button>
          </span>
        )}
        {h && (
          <div role="alert" className="grid gap-1 text-xs text-amber-400">
            <span className="flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t("adminArr.system.warningsHeld")}</span>
            {h.messages.length > 0 && (
              <ul className="m-0 grid list-disc gap-0.5 pl-5">{h.messages.map((m) => <li key={m} style={{ overflowWrap: "anywhere" }}>{m}</li>)}</ul>
            )}
            <span className="flex flex-wrap items-center gap-1.5">
              <Button variant="ghost" size="xs" disabled={cardBusy !== undefined} onClick={() => setHeld((m) => without(m, (key) => key === k))}>{t("adminArr.common.cancel")}</Button>
              <Button size="xs" disabled={cardBusy !== undefined} onClick={() => void toggle(service, instance, kind, provider, h.change, { acceptWarnings: true, confirmed: true })}>
                {cardBusy === `toggle:${k}` && <Loader2 className="animate-spin" />} {t("adminArr.system.switchAnyway")}
              </Button>
            </span>
          </div>
        )}
      </>
    );
  }

  // Reload: the switches keep what this page saved until the NEW report lands —
  // a failed reload keeps the old report, and dropping them first showed every
  // switched provider back in its pre-change state beside the error. Only the
  // overrides and held-warnings prompts already there at the click are
  // replaced: one a save writes while the reload is out may be newer than what
  // the reload read — a "switch anyway" prompt that arrived meanwhile stays.
  function reload() {
    setProwlarrAsk(null);
    const before = overrides;
    const heldBefore = held;
    void load().then((ok) => {
      if (!ok) return;
      setOverrides((m) => without(m, (key) => m[key] === before[key]));
      setHeld((m) => without(m, (key) => m[key] === heldBefore[key]));
    });
  }

  if (!report) return <Loading error={error} loading={loading} onRetry={() => void load()} />;
  const anyProwlarr = report.results.some((r) => r.indexers.some((ix) => ix.managedByProwlarr));
  return (
    <div className="grid gap-4">
      <Toolbar loading={loading} onReload={reload} error={error} staleAt={staleAt} />
      {anyProwlarr && <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.prowlarrHint")}</p>}
      <InstanceErrors report={report} />
      {report.results.map((r) => {
        const card = `${r.service}:${r.instance}`;
        const cardBusy = busy[card];
        const tagList = (ids: number[]) => ids.map((id) => r.tags?.find((tag) => tag.id === id)?.label ?? `#${id}`).join(", ");
        return (
          <Card key={card} title={labelOf(report, r.service, r.instance)}>
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.indexers")}</h3>
                <span className="flex-1" />
                {summary(`${card}:indexer`)}
                {result(`${card}:indexer:all`, r.service)}
                <Button variant="outline" size="xs" disabled={cardBusy !== undefined || r.indexers.length === 0} onClick={() => void test(r.service, r.instance, "indexer", null)}>
                  {cardBusy === `test:${card}:indexer:all` && <Loader2 className="animate-spin" />} {t("adminArr.system.testAll")}
                </Button>
              </div>
              {r.indexers.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noIndexers")}</p>
              ) : (
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                  {r.indexers.map((orig, i) => {
                    const k = keyOf(r.service, r.instance, "indexer", orig.id);
                    const ix = (overrides[k] as ArrIndexer | undefined) ?? orig;
                    return (
                      <li key={ix.id} className="grid gap-1.5 px-3 py-2" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-zinc-100">{ix.name}</span>
                          <span className="text-xs text-zinc-500">
                            {[ix.implementation, t(`adminManage.queue.protocol.${ix.protocol}`), ix.priority !== null ? t("adminArr.system.priority", { value: ix.priority }) : null].filter(Boolean).join(" · ")}
                          </span>
                          {ix.managedByProwlarr && <Chip title={t("adminArr.system.prowlarrHint")}>{t("adminArr.system.prowlarrChip")}</Chip>}
                          {ix.tags.length > 0 && <span className="text-xs text-zinc-500">{t("adminArr.system.tags", { list: tagList(ix.tags) })}</span>}
                          <span className="flex-1" />
                          <Button variant="ghost" size="xs" disabled={cardBusy !== undefined} onClick={() => void test(r.service, r.instance, "indexer", ix.id)}>
                            {cardBusy === `test:${k}` && <Loader2 className="animate-spin" />} {t("adminArr.system.test")}
                          </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
                          {([
                            ["enableRss", ix.enableRss, "adminArr.system.rss", ix.supportsRss],
                            ["enableAutomaticSearch", ix.enableAutomaticSearch, "adminArr.system.automatic", ix.supportsSearch],
                            ["enableInteractiveSearch", ix.enableInteractiveSearch, "adminArr.system.interactive", ix.supportsSearch],
                          ] as const).map(([field, on, label, supported]) => {
                            // A use the indexer can't do (a Torrent RSS Feed can't search) is
                            // not offered — as the arr's own dialog — but one that is somehow
                            // on can still be switched off. Null (an arr that doesn't say) keeps it.
                            const unsupported = supported === false && !on;
                            return (
                              <label key={field} className="flex items-center gap-1.5" title={unsupported ? t("adminArr.system.useUnsupportedHint", { service: SERVICE_LABEL[r.service] }) : undefined}>
                                <Switch
                                  size="sm"
                                  checked={on}
                                  loading={cardBusy === `toggle:${k}`}
                                  disabled={cardBusy !== undefined || unsupported}
                                  onCheckedChange={(v) => void toggle(r.service, r.instance, "indexer", ix, { [field]: v })}
                                  aria-label={t("adminArr.system.toggleAria", { what: t(label), name: ix.name })}
                                />
                                {t(label)}
                                {unsupported && <span className="text-zinc-500">({t("adminArr.system.useUnsupported")})</span>}
                              </label>
                            );
                          })}
                        </div>
                        {pending(r.service, r.instance, "indexer", ix)}
                        {result(k, r.service)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.downloadClients")}</h3>
                <span className="flex-1" />
                {summary(`${card}:downloadClient`)}
                {result(`${card}:downloadClient:all`, r.service)}
                <Button variant="outline" size="xs" disabled={cardBusy !== undefined || r.downloadClients.length === 0} onClick={() => void test(r.service, r.instance, "downloadClient", null)}>
                  {cardBusy === `test:${card}:downloadClient:all` && <Loader2 className="animate-spin" />} {t("adminArr.system.testAll")}
                </Button>
              </div>
              {r.downloadClients.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noClients")}</p>
              ) : (
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                  {r.downloadClients.map((orig, i) => {
                    const k = keyOf(r.service, r.instance, "downloadClient", orig.id);
                    const dc = (overrides[k] as ArrDownloadClient | undefined) ?? orig;
                    return (
                      <li key={dc.id} className="grid gap-1.5 px-3 py-2" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Switch
                            size="sm"
                            checked={dc.enable}
                            loading={cardBusy === `toggle:${k}`}
                            disabled={cardBusy !== undefined}
                            onCheckedChange={(v) => void toggle(r.service, r.instance, "downloadClient", dc, { enable: v })}
                            aria-label={t("adminArr.system.toggleAria", { what: t("adminArr.system.enabled"), name: dc.name })}
                          />
                          <span className="text-sm font-medium text-zinc-100">{dc.name}</span>
                          <span className="text-xs text-zinc-500">
                            {[dc.implementation, t(`adminManage.queue.protocol.${dc.protocol}`), dc.priority !== null ? t("adminArr.system.priority", { value: dc.priority }) : null].filter(Boolean).join(" · ")}
                          </span>
                          {!dc.enable && <Chip>{t("adminArr.system.off")}</Chip>}
                          {dc.removeCompletedDownloads === false && (
                            <Chip tone="pending" title={t("adminArr.system.removesCompletedOffHint", { service: SERVICE_LABEL[r.service] })}>
                              {t("adminArr.system.removesCompletedOff")}
                            </Chip>
                          )}
                          {dc.removeFailedDownloads === false && <Chip>{t("adminArr.system.removesFailedOff")}</Chip>}
                          {dc.tags.length > 0 && <span className="text-xs text-zinc-500">{t("adminArr.system.tags", { list: tagList(dc.tags) })}</span>}
                          <span className="flex-1" />
                          <Button variant="ghost" size="xs" disabled={cardBusy !== undefined} onClick={() => void test(r.service, r.instance, "downloadClient", dc.id)}>
                            {cardBusy === `test:${k}` && <Loader2 className="animate-spin" />} {t("adminArr.system.test")}
                          </Button>
                        </div>
                        {pending(r.service, r.instance, "downloadClient", dc)}
                        {result(k, r.service)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── storage ──────────────────────────────────────────────────────────────────

function UsageBar({ free, total }: { free: number | null; total: number | null }) {
  if (free === null || total === null || total <= 0) return null;
  const used = Math.max(0, Math.min(1, (total - free) / total));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--ds-bg-3)" }} aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${used * 100}%`, background: used > 0.9 ? "var(--ds-danger)" : used > 0.75 ? "var(--ds-warning)" : "var(--ds-accent)" }} />
    </div>
  );
}

/** Disk-sized amounts: terabytes once past 1 TB ("8 TB", not "8,000GB"). */
function storageSize(locale: string) {
  const tb = new Intl.NumberFormat(locale, { style: "unit", unit: "terabyte", unitDisplay: "narrow", maximumFractionDigits: 1 });
  const small = queueFormatters(locale).size;
  return (bytes: number) => (bytes >= 1e12 ? tb.format(bytes / 1e12) : small(bytes));
}

function StorageTab() {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => ({ size: storageSize(locale) }), [locale]);
  const { report, loading, error, load, staleAt } = useReport<{ rootFolders: ArrRootFolder[]; disks: ArrDisk[] }>("/api/admin/arr/storage", t("adminArr.system.loadFailed"), null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  if (!report) return <Loading error={error} loading={loading} onRetry={() => void load()} />;
  return (
    <div className="grid gap-4">
      <Toolbar loading={loading} onReload={() => void load()} error={error} staleAt={staleAt} />
      <InstanceErrors report={report} />
      {report.results.map((r) => {
        const card = `${r.service}:${r.instance}`;
        return (
          <Card key={card} title={labelOf(report, r.service, r.instance)}>
            <div className="grid gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.rootFolders")}</h3>
              {r.rootFolders.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noRootFolders")}</p>
              ) : (
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                  {r.rootFolders.map((f, i) => {
                    const k = `${card}:${f.id}`;
                    const expanded = open.has(k);
                    return (
                      <Fragment key={f.id}>
                        <li className="grid gap-1.5 px-3 py-2" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all text-sm text-zinc-100">{f.path}</span>
                            {!f.accessible && <Chip tone="declined">{t("adminArr.system.unreachable")}</Chip>}
                            <span className="flex-1" />
                            {f.freeSpace !== null && (
                              <span className="text-xs text-zinc-400">
                                {f.totalSpace !== null
                                  ? t("adminArr.system.freeOf", { free: fmt.size(f.freeSpace), total: fmt.size(f.totalSpace) })
                                  : t("adminArr.system.free", { size: fmt.size(f.freeSpace) })}
                              </span>
                            )}
                          </div>
                          <UsageBar free={f.freeSpace} total={f.totalSpace} />
                          {f.unmappedCount > 0 && (
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => setOpen((s) => {
                                const next = new Set(s);
                                if (next.has(k)) next.delete(k);
                                else next.add(k);
                                return next;
                              })}
                              className="flex items-center gap-1 justify-self-start text-xs text-amber-400 hover:underline"
                            >
                              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              {t("adminArr.system.unmapped", { count: f.unmappedCount })}
                            </button>
                          )}
                          {expanded && (
                            <ul className="m-0 grid list-none gap-0.5 p-0 pl-5 text-xs text-zinc-400">
                              {f.unmappedFolders.map((u) => <li key={u.path || u.name} className="break-all" title={u.path}>{u.name}</li>)}
                              {f.unmappedCount > f.unmappedFolders.length && (
                                <li className="text-zinc-500">{t("adminArr.system.andMore", { count: f.unmappedCount - f.unmappedFolders.length })}</li>
                              )}
                            </ul>
                          )}
                        </li>
                      </Fragment>
                    );
                  })}
                </ul>
              )}
              {r.rootFolders.some((f) => f.unmappedCount > 0) && <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.unmappedHint")}</p>}
            </div>
            <div className="grid gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.disks")}</h3>
              {r.disks.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noDisks")}</p>
              ) : (
                <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
                  {r.disks.map((d) => (
                    <li key={d.path} className="grid gap-1.5 rounded-lg px-3 py-2" style={{ border: "1px solid var(--ds-border)" }}>
                      <div className="flex flex-wrap items-center gap-2">
                        <HardDrive className="h-4 w-4 text-zinc-500" aria-hidden />
                        <span className="break-all text-sm text-zinc-100">{d.path}</span>
                        {d.label && d.label !== d.path && <span className="text-xs text-zinc-500">{d.label}</span>}
                      </div>
                      <UsageBar free={d.freeSpace} total={d.totalSpace} />
                      {d.freeSpace !== null && d.totalSpace !== null && (
                        <span className="text-xs text-zinc-400">{t("adminArr.system.freeOf", { free: fmt.size(d.freeSpace), total: fmt.size(d.totalSpace) })}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── shell ────────────────────────────────────────────────────────────────────

/** Reload, the last read's error, and — while the report shown is a snapshot — when it was read. */
function Toolbar({ loading, onReload, error, staleAt }: { loading: boolean; onReload: () => void; error: string; staleAt: string | null }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      <ArrSnapshotNote at={staleAt} refreshing={loading} />
      <Button variant="ghost" size="sm" className="ml-auto" disabled={loading} onClick={onReload}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.common.reload")}
      </Button>
    </div>
  );
}

/**
 * Before the first report: a spinner, or the first read's error with a Reload
 * — the Indexers and Storage tabs never poll, so without it a failed first
 * read stayed on screen until the tab was switched.
 */
function Loading({ error, loading, onRetry }: { error: string; loading: boolean; onRetry: () => void }) {
  const t = useT();
  return error ? (
    <div className="flex flex-wrap items-center gap-2 py-6">
      <p role="alert" className="m-0 flex min-w-0 items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{error}</span>
      </p>
      <Button variant="ghost" size="sm" disabled={loading} onClick={onRetry}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.common.reload")}
      </Button>
    </div>
  ) : (
    <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
  );
}

export function ArrSystem({ configured, initialTab }: { configured: boolean; initialTab: Tab }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  if (!configured) {
    return <EmptyState icon={Server} title={t("adminArr.common.noneConfigured")} description={t("adminArr.common.noneConfiguredHint")} cta={{ href: "/settings?tab=media#radarr", label: t("adminArr.common.openSettings") }} />;
  }
  function switchTab(next: Tab) {
    setTab(next);
    window.history.replaceState(null, "", `?tab=${next}`);
  }
  return (
    <div className="grid gap-4">
      <ArrHealthPanel variant="full" />
      <FilterBar
        segments={[
          { value: "tasks" as const, label: t("adminArr.system.tab.tasks") },
          { value: "providers" as const, label: t("adminArr.system.tab.providers") },
          { value: "storage" as const, label: t("adminArr.system.tab.storage") },
        ]}
        active={tab}
        onChange={switchTab}
        className="mb-0"
      />
      {tab === "tasks" && <TasksTab />}
      {tab === "providers" && <ProvidersTab />}
      {tab === "storage" && <StorageTab />}
    </div>
  );
}
