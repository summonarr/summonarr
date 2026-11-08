"use client";

// Admin → Arr System → Tasks: per instance, the scheduled tasks (last/next run,
// Run now), the commands running or just run (cancel a queued one), and the
// two library-wide searches (every monitored missing title, every title below
// cutoff). The report re-reads every TASKS_POLL_MS while visible, so a
// command's status moves on its own; each run's command is also followed live
// (useArrCommandWatch) and the report re-read once it ends.

import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/design";
import { CommandWatchLine, isWatchActive, useArrCommandWatch, type CommandWatch } from "@/components/admin/arr-command-watch";
import { queueFormatters } from "@/components/admin/queue-format";
import { AlertTriangle, Check, Loader2, Play, Search, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { bulkActionCommand, taskRisk, type ArrBulkAction, type ArrCommandRow, type ArrTask, type CommandStatus } from "@/lib/arr-system";
import { arrCall } from "@/lib/client/arr-call";
import { TASK_RUN, TASKS_REPORT, type ArrServiceName, type TasksResult } from "@/lib/client/arr-answers";
import { SERVICE_LABEL } from "@/components/admin/arr-title/shared";
import { Card, InstanceErrors, labelOf, Loading, Toolbar, useLifetimeSignal, useReport } from "./arr-system-parts";
import { activeCommandNames, cardKey } from "./arr-system-state";

const TASKS_POLL_MS = 15_000;

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

// The Recent commands list shows this many until "Show all".
const RECENT_COMMANDS_SHOWN = 8;

/** A card's newest run: a refusal, or the "started" notice — and the key of the command it follows, whose line replaces it once the arr reports. */
type TaskMessage = { ok: boolean; text: string; watchKey?: string };

type Formatters = ReturnType<typeof queueFormatters>;

export function TasksTab() {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // How long a task or command took: seconds under a minute, else the duration.
  const took = (seconds: number) => (seconds < 60 ? t("adminArr.system.seconds", { count: Math.round(seconds) }) : fmt.duration(seconds));
  const { report, loading, error, load, staleAt } = useReport<TasksResult>("/api/admin/arr/tasks", TASKS_REPORT, t("adminArr.system.loadFailed"), TASKS_POLL_MS);
  // Per instance card: the action in flight there. A dark instance holds its
  // POST for the whole arr timeout; that must not lock every other card.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const startBusy = (card: string, action: string) => setBusy((m) => ({ ...m, [card]: action }));
  const endBusy = (card: string) => setBusy((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== card)));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, TaskMessage>>({});
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  // Each run's command, followed live under its button's key: the button stays
  // disabled while it is queued or running, and the report is re-read once it
  // ends (its task's last run, the Recent commands list).
  const { watch, watches } = useArrCommandWatch();
  const lifetime = useLifetimeSignal();

  async function run(key: string, service: ArrServiceName, instance: string, body: Record<string, unknown>, done: string) {
    const card = cardKey(service, instance);
    startBusy(card, key);
    setConfirming(null);
    const res = await arrCall(withBasePath("/api/admin/arr/tasks"), {
      method: "POST",
      body: { service, instance, ...body },
      schema: TASK_RUN,
      signal: lifetime(),
      fallback: t("adminArr.system.runFailed"),
    });
    if (res.ok === false && res.aborted) return;
    endBusy(card);
    if (!res.ok) {
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

  async function cancel(service: ArrServiceName, instance: string, id: number) {
    const card = cardKey(service, instance);
    startBusy(card, `cancel:${card}:${id}`);
    const q = new URLSearchParams({ service, instance, commandId: String(id) });
    const res = await arrCall(withBasePath(`/api/admin/arr/tasks?${q.toString()}`), { method: "DELETE", signal: lifetime(), fallback: t("adminArr.system.runFailed") });
    if (res.ok === false && res.aborted) return;
    endBusy(card);
    if (!res.ok) setMessages((m) => ({ ...m, [card]: { ok: false, text: res.error } }));
    void load();
  }

  // Reload also clears each card's last line — but never one still following
  // its command (that line goes on until the arr says how it ended).
  function reload() {
    setMessages((m) => Object.fromEntries(Object.entries(m).filter(([, msg]) => msg.watchKey !== undefined && isWatchActive(watches[msg.watchKey]))));
    void load();
  }

  if (!report) return <Loading error={error} loading={loading} onRetry={() => void load()} />;
  return (
    <div className="grid gap-4">
      <Toolbar loading={loading} onReload={reload} error={error} staleAt={staleAt} />
      <InstanceErrors report={report} />
      {report.results.map((r) => {
        const card = cardKey(r.service, r.instance);
        return (
          <TasksCard
            key={card}
            card={card}
            result={r}
            name={labelOf(report, r.service, r.instance)}
            cardBusy={busy[card]}
            confirming={confirming}
            onConfirming={setConfirming}
            message={messages[card]}
            watches={watches}
            showAllCommands={showAll.has(card)}
            onToggleAllCommands={() => setShowAll((s) => {
              const next = new Set(s);
              if (next.has(card)) next.delete(card);
              else next.add(card);
              return next;
            })}
            onRun={(key, body, done) => void run(key, r.service, r.instance, body, done)}
            onCancel={(id) => void cancel(r.service, r.instance, id)}
            fmt={fmt}
            took={took}
          />
        );
      })}
    </div>
  );
}

function TasksCard({ card, result: r, name, cardBusy, confirming, onConfirming, message, watches, showAllCommands, onToggleAllCommands, onRun, onCancel, fmt, took }: {
  card: string;
  result: { service: ArrServiceName; instance: string } & TasksResult;
  name: string;
  /** The key of the action in flight on this card, if any: every control on it waits. */
  cardBusy: string | undefined;
  confirming: string | null;
  onConfirming: (key: string | null) => void;
  message: TaskMessage | undefined;
  watches: Readonly<Record<string, CommandWatch>>;
  showAllCommands: boolean;
  onToggleAllCommands: () => void;
  onRun: (key: string, body: Record<string, unknown>, done: string) => void;
  onCancel: (id: number) => void;
  fmt: Formatters;
  took: (seconds: number) => string;
}) {
  const t = useT();
  // The 15 s report's queued and running commands, read once for every button on the card.
  const running = useMemo(() => activeCommandNames(r.commands), [r.commands]);
  const msgWatch = message?.watchKey ? watches[message.watchKey] : undefined;
  const bulk = (action: ArrBulkAction) => {
    const key = `${card}:${action}`;
    // This page's own run still followed live, or — after a tab switch, a page
    // load, or once the watch's poll cap ran out — the same search still
    // queued or running in the 15 s report (a library-wide search runs for
    // hours), as a task row's Run does.
    const commandName = String(bulkActionCommand(r.service, action).name);
    const active = isWatchActive(watches[key]) || running.has(commandName);
    return (
      <BulkSearchControl
        key={key}
        service={r.service}
        action={action}
        confirming={confirming === key}
        busy={cardBusy === key}
        disabled={cardBusy !== undefined || active}
        active={active}
        onAsk={() => onConfirming(key)}
        onCancel={() => onConfirming(null)}
        onRun={(label) => onRun(key, { action }, t("adminArr.system.bulkStarted", { action: label }))}
      />
    );
  };
  return (
    <Card title={name} actions={<div className="flex flex-wrap items-center gap-2">{bulk("searchMissing")}{bulk("searchCutoff")}</div>}>
      {msgWatch ? (
        <CommandWatchLine watch={msgWatch} />
      ) : message && (
        <p role={message.ok ? "status" : "alert"} className={`m-0 flex items-center gap-1.5 text-xs ${message.ok ? "text-green-400" : ""}`} style={message.ok ? undefined : { color: "var(--ds-danger)" }}>
          {message.ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />} <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>{message.text}</span>
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
              return (
                <TaskRow
                  key={task.taskName}
                  task={task}
                  service={r.service}
                  // The 15 s report, or this page's own run still followed live.
                  running={isWatchActive(watches[key]) || running.has(task.taskName)}
                  confirming={confirming === key}
                  cardBusy={cardBusy}
                  busy={cardBusy === key}
                  onAsk={() => onConfirming(key)}
                  onCancel={() => onConfirming(null)}
                  onRun={() => onRun(key, { task: task.taskName }, t("adminArr.system.taskStarted", { task: task.name }))}
                  fmt={fmt}
                  took={took}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <RecentCommands card={card} commands={r.commands} showAll={showAllCommands} onToggleAll={onToggleAllCommands} cardBusy={cardBusy} onCancel={onCancel} fmt={fmt} took={took} />
    </Card>
  );
}

/** "Search all missing" / "Search all cutoff unmet": a library-wide search, confirmed inline first. */
function BulkSearchControl({ service, action, confirming, busy, disabled, active, onAsk, onCancel, onRun }: {
  service: ArrServiceName;
  action: ArrBulkAction;
  confirming: boolean;
  /** This search's own POST is in flight. */
  busy: boolean;
  disabled: boolean;
  /** The search is queued or running on the instance. */
  active: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRun: (label: string) => void;
}) {
  const t = useT();
  const label = action === "searchMissing" ? t("adminArr.system.searchAllMissing") : t("adminArr.system.searchAllCutoff");
  return confirming ? (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
      {action === "searchMissing" ? t("adminArr.system.confirmMissing") : t("adminArr.system.confirmCutoff")}
      {/* Radarr searches from the API ignore Minimum Availability (bulkActionCommand). */}
      {service === "radarr" && <> {t("adminArr.system.radarrCaveat")}</>}
      <Button variant="ghost" size="xs" onClick={onCancel}>{t("adminArr.common.cancel")}</Button>
      <Button size="xs" disabled={disabled} onClick={() => onRun(label)}>
        {busy && <Loader2 className="animate-spin" />} {t("adminArr.system.confirmRun")}
      </Button>
    </span>
  ) : (
    <Button variant="outline" size="sm" disabled={disabled} onClick={onAsk}>
      {busy || active ? <Loader2 className="animate-spin" /> : <Search />} {label}
    </Button>
  );
}

/** One scheduled task: when it ran and runs next, and Run now (confirmed first for an update or a full library refresh). */
function TaskRow({ task, service, running, confirming, cardBusy, busy, onAsk, onCancel, onRun, fmt, took }: {
  task: ArrTask;
  service: ArrServiceName;
  running: boolean;
  confirming: boolean;
  cardBusy: string | undefined;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRun: () => void;
  fmt: Formatters;
  took: (seconds: number) => string;
}) {
  const t = useT();
  const risk = taskRisk(task.taskName);
  return (
    <Fragment>
      <tr style={{ borderTop: "1px solid var(--ds-border)" }}>
        <td className="px-2 py-1.5 text-zinc-100">{task.name}</td>
        <td className="hidden px-2 py-1.5 text-xs text-zinc-400 sm:table-cell">{task.intervalMinutes ? fmt.duration(task.intervalMinutes * 60) : "—"}</td>
        <td className="px-2 py-1.5 text-xs text-zinc-400">
          {fmt.dateTime(task.lastExecution)}
          <div className="text-zinc-500 sm:hidden">{t("adminArr.system.nextRunShort", { date: fmt.dateTime(task.nextExecution) })}</div>
        </td>
        <td className="hidden px-2 py-1.5 text-xs text-zinc-400 sm:table-cell">{task.lastDurationSeconds !== null ? took(task.lastDurationSeconds) : "—"}</td>
        <td className="hidden px-2 py-1.5 text-xs text-zinc-400 sm:table-cell">{fmt.dateTime(task.nextExecution)}</td>
        <td className="px-2 py-1.5 text-right">
          <Button
            variant="ghost"
            size="xs"
            disabled={cardBusy !== undefined || running}
            onClick={() => (risk ? onAsk() : onRun())}
            aria-label={t("adminArr.system.runAria", { task: task.name })}
          >
            {busy || running ? <Loader2 className="animate-spin" /> : <Play />} <span className="hidden sm:inline">{t("adminArr.system.run")}</span>
          </Button>
        </td>
      </tr>
      {risk && confirming && (
        <tr>
          <td colSpan={6} className="px-2 pb-2">
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
              {risk === "update"
                ? t("adminArr.system.confirmUpdate", { service: SERVICE_LABEL[service] })
                : t("adminArr.system.confirmRefresh", { service: SERVICE_LABEL[service] })}
              <Button variant="ghost" size="xs" onClick={onCancel}>{t("adminArr.common.cancel")}</Button>
              <Button size="xs" disabled={cardBusy !== undefined || running} onClick={onRun}>
                {busy && <Loader2 className="animate-spin" />} {t("adminArr.system.confirmRun")}
              </Button>
            </span>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** The commands the arr is running or just ran; a queued one can be cancelled. */
function RecentCommands({ card, commands, showAll, onToggleAll, cardBusy, onCancel, fmt, took }: {
  card: string;
  commands: ArrCommandRow[];
  showAll: boolean;
  onToggleAll: () => void;
  cardBusy: string | undefined;
  onCancel: (id: number) => void;
  fmt: Formatters;
  took: (seconds: number) => string;
}) {
  const t = useT();
  const shown = showAll ? commands : commands.slice(0, RECENT_COMMANDS_SHOWN);
  return (
    <div className="grid gap-1.5">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.recentCommands")}</h3>
      {commands.length === 0 ? (
        <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noCommands")}</p>
      ) : (
        <ul id={`commands-${card}`} className="m-0 grid list-none gap-1 p-0">
          {shown.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <Chip tone={COMMAND_TONE[c.status]}>{t(COMMAND_LABEL[c.status])}</Chip>
              <span className="text-zinc-200">{c.name}</span>
              <span className="text-zinc-500">{fmt.dateTime(c.started ?? c.queued)}</span>
              {c.durationSeconds !== null && c.status !== "queued" && <span className="text-zinc-500">{took(c.durationSeconds)}</span>}
              {c.trigger === "scheduled" && <span className="text-zinc-500">{t("adminArr.system.scheduled")}</span>}
              {c.message && <span className="min-w-0 truncate text-zinc-500" title={c.message}>{c.message}</span>}
              {c.status === "queued" && (
                <Button variant="ghost" size="icon-xs" disabled={cardBusy !== undefined} onClick={() => onCancel(c.id)} aria-label={t("adminArr.system.cancelCommand", { name: c.name })} title={t("adminArr.system.cancelCommand", { name: c.name })}>
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {commands.length > RECENT_COMMANDS_SHOWN && (
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={`commands-${card}`}
          className="justify-self-start text-xs text-zinc-500 hover:text-zinc-300"
          onClick={onToggleAll}
        >
          {showAll ? t("adminArr.system.showFewer") : t("adminArr.system.showAll", { count: commands.length })}
        </button>
      )}
    </div>
  );
}
