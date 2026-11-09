"use client";

// Admin → Watch Sync: the admin pairs a Plex account with a Jellyfin user and
// picks a direction; the watch-sync cron marks in each account what the other
// server counted as watched (src/lib/watch-sync.ts — guardrail 19e). Pairs are
// made only here; a suggestion (both identities linked to one Summonarr
// account) is a button, never an automatic pair.

import { useCallback, useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { apiErrorText } from "@/lib/client/api-error";
import { useAsyncAction, type AsyncAction } from "@/hooks/use-async-action";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, SectionHeader } from "@/components/ui/design";
import { ArrowLeftRight, ArrowRight, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import type { Translator } from "@/lib/i18n/translate";
import { requestFailureText } from "./request-failure-text";
import {
  DIRECTIONS,
  OverviewSchema,
  lastFor,
  pairLevelError,
  runSummary,
  toOverview,
  toward,
  type Counts,
  type Direction,
  type Overview,
  type Pair,
  type ServerUser,
  type SyncTarget,
} from "./watch-sync-overview";

const RUN_POLL_MS = 3_000;
// While a scheduled run is in progress the page re-reads itself this often.
const RUNNING_REFRESH_MS = 10_000;
const RUN_MAX_POLLS = 400;
const NO_COUNTS: Counts = { pending: 0, marked: 0, already: 0, missing: 0, failed: 0 };
const DIRECTION_KEYS: Record<Direction, string> = {
  both: "adminManage.watchSync.direction.both",
  toJellyfin: "adminManage.watchSync.direction.toJellyfin",
  toPlex: "adminManage.watchSync.direction.toPlex",
};

// Busy keys: one page read at a time (a newer read drops an older one's
// answer), and one change at a time (every control is off while it runs).
const LOAD = "load";
const MUTATE = "mutate";
const RUN = "run";

// An unknown stored direction reads as "both" in the labels and the select;
// it syncs nothing (toward), so no direction's numbers are shown for it.
const dirLabel = (t: Translator, d: Direction | null) => t(DIRECTION_KEYS[d ?? "both"]);
const userLabel = (u: ServerUser) => `${u.username} · ${u.server}`;
const fmtDate = (iso: string | null, locale: string) => (iso ? new Date(iso).toLocaleString(locale) : "");

function DirectionIcon({ direction, label }: { direction: Direction | null; label: string }) {
  const cls = "h-4 w-4 shrink-0 text-[var(--ds-fg-subtle)]";
  // role="img": without it an svg's aria-label isn't reliably announced, and
  // this icon is the pair header's only direction cue.
  if (direction === "both") return <ArrowLeftRight className={cls} role="img" aria-label={label} />;
  return <ArrowRight className={`${cls}${direction === "toPlex" ? " rotate-180" : ""}`} role="img" aria-label={label} />;
}

// The page's data, read on mount and after every change, and every
// RUNNING_REFRESH_MS while a run is in progress (the cron's, or another
// admin's Run now) so the page stays current until it finishes. Each read runs
// under one busy key: a newer one aborts the older and drops its answer, so a
// slow poll can't land over the read that followed a change.
function useWatchSyncOverview(action: AsyncAction) {
  const t = useT();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  // Bumped after every background re-read, so the next one is armed whatever
  // the last one returned (a failed load leaves `data` as it was).
  const [pollTick, setPollTick] = useState(0);

  // False only when the read failed (a superseded read is not a failure).
  const load = useCallback(async (): Promise<boolean> => {
    const res = await action.run(LOAD, (signal) =>
      fetchJson(withBasePath("/api/admin/watch-sync"), { schema: OverviewSchema, signal }));
    if (!res) return true;
    if (!res.ok) {
      const text = requestFailureText(res, t, { status: "adminManage.watchSync.error.load", network: "adminManage.watchSync.error.loadNetwork" });
      if (text !== null) setError(text);
      return false;
    }
    setData(toOverview(res.data));
    setError("");
    return true;
  }, [action, t]);

  useEffect(() => { void load(); }, [load]);

  const serverRunning = data?.run?.running === true;
  useEffect(() => {
    if (!serverRunning) return;
    const id = setTimeout(() => {
      void load().finally(() => setPollTick((n) => n + 1));
    }, RUNNING_REFRESH_MS);
    return () => clearTimeout(id);
  }, [serverRunning, pollTick, load]);

  return { data, error, setError, load, serverRunning };
}

function DirectionStats({ pair, dir }: { pair: Pair; dir: SyncTarget }) {
  const t = useT();
  const locale = useLocale();
  const c = pair.counts?.[dir] ?? NO_COUNTS;
  const last = lastFor(pair.lastResult, dir);
  const toPlex = dir === "toPlex";
  const readTo = toPlex ? pair.jellyfinReadTo : pair.historyReadTo;
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-[var(--ds-fg-muted)]">{dirLabel(t, dir)}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <Chip tone="approved">{t("adminManage.watchSync.count.marked", { count: c.marked })}</Chip>
        <Chip>{t("adminManage.watchSync.count.already", { count: c.already })}</Chip>
        {c.pending > 0 && <Chip tone="pending">{t("adminManage.watchSync.count.pending", { count: c.pending })}</Chip>}
        {c.missing > 0 && <Chip>{t(toPlex ? "adminManage.watchSync.count.missingPlex" : "adminManage.watchSync.count.missing", { count: c.missing })}</Chip>}
        {c.failed > 0 && <Chip tone="declined">{t("adminManage.watchSync.count.failed", { count: c.failed })}</Chip>}
        {(last?.unmatched ?? 0) > 0 && (
          <Chip title={t(toPlex ? "adminManage.watchSync.count.unmatchedHintPlex" : "adminManage.watchSync.count.unmatchedHint")}>
            {t(toPlex ? "adminManage.watchSync.count.unmatchedPlex" : "adminManage.watchSync.count.unmatched", { count: last?.unmatched ?? 0 })}
          </Chip>
        )}
      </div>
      <p className="mt-1.5 text-xs text-[var(--ds-fg-subtle)]">
        {readTo
          ? t(toPlex ? "adminManage.watchSync.readToJellyfin" : "adminManage.watchSync.readTo", { date: fmtDate(readTo, locale) })
          : t(toPlex ? "adminManage.watchSync.notReadYetJellyfin" : "adminManage.watchSync.notReadYet")}
      </p>
      {last?.error && <p className="mt-1 text-xs text-[var(--ds-danger)]">{t("adminManage.watchSync.lastError", { error: last.error })}</p>}
    </div>
  );
}

type PairChange = { direction: Direction } | { syncProgress: boolean } | { enabled: boolean };
type ConfirmKind = "remove" | "rescan";

function PairCard({
  p,
  busy,
  syncing,
  confirming,
  setConfirming,
  onChange,
  onRescan,
  onRemove,
}: {
  p: Pair;
  busy: boolean;
  // This pair is the one the run in progress is on.
  syncing: boolean;
  // The Remove / Re-scan waiting for the inline confirmation (one pair at a time).
  confirming: ConfirmKind | null;
  setConfirming: (kind: ConfirmKind | null) => void;
  onChange: (change: PairChange) => void;
  onRescan: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toggleConfirm = (kind: ConfirmKind) => setConfirming(confirming === kind ? null : kind);
  const pairError = pairLevelError(p.lastResult);
  return (
    <li className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
          <span className="inline-flex min-w-0 max-w-full items-center gap-2">
            <Chip tone="plex" className="shrink-0">Plex</Chip>
            <span className="truncate text-[var(--ds-fg)]">{userLabel(p.plex)}</span>
          </span>
          <DirectionIcon direction={p.direction} label={dirLabel(t, p.direction)} />
          <span className="inline-flex min-w-0 max-w-full items-center gap-2">
            <Chip tone="jellyfin" className="shrink-0">Jellyfin</Chip>
            <span className="truncate text-[var(--ds-fg)]">{userLabel(p.jellyfin)}</span>
          </span>
          {!p.jellyfin.active && <Chip tone="declined" className="whitespace-nowrap">{t("adminManage.watchSync.jellyfinGone")}</Chip>}
          {syncing && (
            <Chip tone="pending" className="whitespace-nowrap">{t("adminManage.watchSync.run.syncingPair")}</Chip>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <StyledSelect
            compact
            value={p.direction ?? "both"}
            disabled={busy}
            aria-label={t("adminManage.watchSync.direction.label")}
            className="w-auto"
            onChange={(e) => {
              const direction = DIRECTIONS.find((d) => d === e.target.value);
              if (direction) onChange({ direction });
            }}
          >
            {DIRECTIONS.map((d) => <option key={d} value={d}>{dirLabel(t, d)}</option>)}
          </StyledSelect>
          <label className="flex items-center gap-2 text-xs text-[var(--ds-fg-muted)]" title={t("adminManage.watchSync.progress.hint")}>
            <Switch
              size="sm"
              checked={p.syncProgress}
              disabled={busy}
              onCheckedChange={(syncProgress) => onChange({ syncProgress })}
              aria-label={t("adminManage.watchSync.progress.label")}
            />
            {t("adminManage.watchSync.progress.label")}
          </label>
          <label className="flex items-center gap-2 text-xs text-[var(--ds-fg-muted)]">
            <Switch
              size="sm"
              checked={p.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => onChange({ enabled })}
              aria-label={t("adminManage.watchSync.enabled")}
            />
            {p.enabled ? t("adminManage.watchSync.enabled") : t("adminManage.watchSync.paused")}
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-expanded={confirming === "rescan"}
            onClick={() => toggleConfirm("rescan")}
          >
            {t("adminManage.watchSync.rescan")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={t("adminManage.watchSync.remove")}
            title={t("adminManage.watchSync.remove")}
            aria-expanded={confirming === "remove"}
            onClick={() => toggleConfirm("remove")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {/* The inline confirmation the other admin managers use (never a
          blocking browser dialog). */}
      {confirming && (
        <div className="mt-3 space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-3">
          <p className="text-xs text-[var(--ds-danger)]">
            {t(confirming === "remove" ? "adminManage.watchSync.removeConfirm" : "adminManage.watchSync.rescanConfirm")}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              size="xs"
              disabled={busy}
              autoFocus
              onClick={() => {
                const kind = confirming;
                setConfirming(null);
                if (kind === "remove") onRemove();
                else onRescan();
              }}
            >
              {confirming === "remove" ? <Trash2 className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t(confirming === "remove" ? "adminManage.watchSync.remove" : "adminManage.watchSync.rescan")}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>
              {t("adminManage.common.cancel")}
            </Button>
          </div>
        </div>
      )}
      {toward(p.direction, "toJellyfin") && <DirectionStats pair={p} dir="toJellyfin" />}
      {toward(p.direction, "toPlex") && <DirectionStats pair={p} dir="toPlex" />}
      {p.syncProgress && p.lastResult?.progress && (
        <div className="mt-3">
          <p className="text-xs text-[var(--ds-fg-muted)]">
            {t("adminManage.watchSync.progress.result", { toJellyfin: p.lastResult.progress.toJellyfin ?? 0, toPlex: p.lastResult.progress.toPlex ?? 0 })}
          </p>
          {p.lastResult.progress.error && (
            <p className="mt-1 text-xs text-[var(--ds-danger)]">{t("adminManage.watchSync.lastError", { error: p.lastResult.progress.error })}</p>
          )}
        </div>
      )}
      {p.lastRunAt && (
        <p className="mt-3 text-xs text-[var(--ds-fg-subtle)]">{t("adminManage.watchSync.lastRun", { date: fmtDate(p.lastRunAt, locale) })}</p>
      )}
      {/* A problem with the pair itself (both directions stopped). A flat,
          pre-Jellyfin → Plex result's error is shown in its direction above. */}
      {pairError && (
        <p className="mt-1 text-xs text-[var(--ds-danger)]">{t("adminManage.watchSync.lastError", { error: pairError })}</p>
      )}
    </li>
  );
}

function AddPairForm({
  data,
  busy,
  onAdd,
}: {
  data: Overview;
  busy: boolean;
  // A pair added (here or from a suggestion) remounts the form, so it starts empty.
  onAdd: (plexUserId: string, jellyfinUserId: string, direction: Direction) => void;
}) {
  const t = useT();
  const [plexSel, setPlexSel] = useState("");
  const [jfSel, setJfSel] = useState("");
  const [dirSel, setDirSel] = useState<Direction>("both");
  if (data.plexUsers.length === 0 || data.jellyfinUsers.length === 0) {
    return <p className="text-sm text-[var(--ds-fg-muted)]">{t("adminManage.watchSync.add.noUsers")}</p>;
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <StyledSelect compact value={plexSel} onChange={(e) => setPlexSel(e.target.value)} aria-label={t("adminManage.watchSync.add.plex")} className="sm:max-w-xs">
        <option value="">{t("adminManage.watchSync.add.plex")}</option>
        {data.plexUsers.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
      </StyledSelect>
      <StyledSelect
        compact
        value={dirSel}
        onChange={(e) => setDirSel(DIRECTIONS.find((d) => d === e.target.value) ?? "both")}
        aria-label={t("adminManage.watchSync.direction.label")}
        className="sm:w-auto"
      >
        {DIRECTIONS.map((d) => <option key={d} value={d}>{dirLabel(t, d)}</option>)}
      </StyledSelect>
      <StyledSelect compact value={jfSel} onChange={(e) => setJfSel(e.target.value)} aria-label={t("adminManage.watchSync.add.jellyfin")} className="sm:max-w-xs">
        <option value="">{t("adminManage.watchSync.add.jellyfin")}</option>
        {data.jellyfinUsers.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
      </StyledSelect>
      <Button size="sm" disabled={!plexSel || !jfSel || busy} onClick={() => onAdd(plexSel, jfSel, dirSel)}>
        {t("adminManage.watchSync.add.submit")}
      </Button>
    </div>
  );
}

function Suggestions({ data, busy, onPair }: { data: Overview; busy: boolean; onPair: (plexUserId: string, jellyfinUserId: string) => void }) {
  const t = useT();
  if (data.suggestions.length === 0) return null;
  const byId = new Map([...data.plexUsers, ...data.jellyfinUsers].map((u) => [u.id, u]));
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-medium text-[var(--ds-fg)]">{t("adminManage.watchSync.suggestions.title")}</h3>
      <p className="mb-3 text-xs text-[var(--ds-fg-subtle)]">{t("adminManage.watchSync.suggestions.subtitle")}</p>
      <ul className="space-y-2">
        {data.suggestions.map((s) => {
          const plex = byId.get(s.plexUserId);
          const jf = byId.get(s.jellyfinUserId);
          if (!plex || !jf) return null;
          return (
            <li key={`${s.plexUserId}:${s.jellyfinUserId}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-[var(--ds-fg)]">{s.account}</span>
              <span className="text-[var(--ds-fg-muted)]">{userLabel(plex)}</span>
              <ArrowLeftRight className="h-4 w-4 text-[var(--ds-fg-subtle)]" aria-hidden />
              <span className="text-[var(--ds-fg-muted)]">{userLabel(jf)}</span>
              <Button variant="outline" size="xs" disabled={busy} onClick={() => onPair(s.plexUserId, s.jellyfinUserId)}>
                {t("adminManage.watchSync.suggestions.pair")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function WatchSyncPanel() {
  const t = useT();
  const locale = useLocale();
  const action = useAsyncAction();
  const { data, error, setError, load, serverRunning } = useWatchSyncOverview(action);
  const [note, setNote] = useState("");
  // Pairs added: the add form's key, so it starts empty after each one.
  const [added, setAdded] = useState(0);
  const [confirming, setConfirming] = useState<{ id: string; kind: ConfirmKind } | null>(null);
  const busy = action.busy(MUTATE);
  const running = action.busy(RUN);

  // One change at a time; the page is re-read before the controls come back,
  // so the next change starts from what the server now holds.
  async function send(url: string, init: RequestInit): Promise<boolean> {
    setError("");
    setNote("");
    let reloaded = true;
    const res = await action.run(MUTATE, async (signal) => {
      const answer = await fetchJson(withBasePath(url), { init, signal });
      if (answer.ok) reloaded = await load();
      return answer;
    }, { ifBusy: "skip" });
    if (!res) return false;
    if (!res.ok) {
      const text = requestFailureText(res, t, { status: "adminManage.watchSync.error.save", network: "adminManage.watchSync.error.saveNetwork" });
      if (text !== null) setError(text);
      return false;
    }
    // The change went through; a failed re-read leaves its own error line and
    // no success note over a stale list.
    return reloaded;
  }

  async function addPair(plexUserId: string, jellyfinUserId: string, direction: Direction) {
    if (!(await send("/api/admin/watch-sync", jsonInit("POST", { plexUserId, jellyfinUserId, direction })))) return;
    setAdded((n) => n + 1);
    setNote(t("adminManage.watchSync.added"));
  }

  async function runNow() {
    setError("");
    setNote("");
    let answer: Awaited<ReturnType<typeof runReplaceFileJob>> | undefined;
    try {
      answer = await action.run(RUN, async (signal) => {
        // A background job (the 37a pattern): polled until it answers, and
        // the polls stop when the page goes away.
        return await runReplaceFileJob(fetch, withBasePath("/api/admin/watch-sync/run"), {}, {
          intervalMs: RUN_POLL_MS,
          maxPolls: RUN_MAX_POLLS,
          isAlive: () => !signal.aborted,
        });
      }, { ifBusy: "skip" });
    } catch {
      setError(t("adminManage.watchSync.error.runNetwork"));
      return;
    }
    if (!answer) return;
    if (answer.status === 0) { setNote(t("adminManage.watchSync.runStillRunning")); return; }
    if (answer.status < 200 || answer.status >= 300) {
      setError(apiErrorText(answer.data, t("adminManage.watchSync.error.run")));
      return;
    }
    const { marked, problems } = runSummary(answer.data);
    setNote(problems > 0
      ? t("adminManage.watchSync.ranWithProblems", { marked, problems })
      : t("adminManage.watchSync.ran", { marked }));
    await load();
  }

  if (!data) {
    return error
      ? <p className="text-sm text-[var(--ds-danger)]">{error}</p>
      : <p className="flex items-center gap-2 text-sm text-[var(--ds-fg-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("adminManage.watchSync.loading")}</p>;
  }

  const pairUrl = (id: string) => `/api/admin/watch-sync/${encodeURIComponent(id)}`;

  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-[var(--ds-fg-muted)]">{t("adminManage.watchSync.intro")}</p>

      {serverRunning && !running && (
        <p role="status" className="flex items-center gap-2 text-sm text-[var(--ds-fg-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("adminManage.watchSync.run.inProgress", { date: fmtDate(data.run?.startedAt ?? null, locale) })}
        </p>
      )}

      {/* A failure is announced at once (alert); a note waits its turn (status). */}
      {error ? (
        <p role="alert" className="text-sm text-[var(--ds-danger)]">{error}</p>
      ) : note ? (
        <p role="status" className="text-sm text-[var(--ds-fg-muted)]">{note}</p>
      ) : null}

      <section>
        <SectionHeader
          title={t("adminManage.watchSync.pairs.title")}
          subtitle={t("adminManage.watchSync.pairs.subtitle")}
          right={
            // Off while a run is already going (the cron's or another
            // admin's): a second one would only answer "already running".
            <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={running || serverRunning || data.pairs.length === 0}>
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {running ? t("adminManage.watchSync.running") : t("adminManage.watchSync.runNow")}
            </Button>
          }
        />
        {data.pairs.length === 0 ? (
          <EmptyState title={t("adminManage.watchSync.pairs.empty")} />
        ) : (
          <ul className="space-y-3">
            {data.pairs.map((p) => (
              <PairCard
                key={p.id}
                p={p}
                busy={busy}
                syncing={serverRunning && data.run?.pairId === p.id}
                confirming={confirming?.id === p.id ? confirming.kind : null}
                setConfirming={(kind) => setConfirming(kind ? { id: p.id, kind } : null)}
                onChange={(change) => void send(pairUrl(p.id), jsonInit("PATCH", change))}
                onRescan={() => void send(pairUrl(p.id), jsonInit("PATCH", { rescan: true })).then((ok) => {
                  if (ok) setNote(t("adminManage.watchSync.rescanQueued"));
                })}
                onRemove={() => void send(pairUrl(p.id), { method: "DELETE" })}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader title={t("adminManage.watchSync.add.title")} subtitle={t("adminManage.watchSync.add.subtitle")} />
        <AddPairForm key={added} data={data} busy={busy} onAdd={(plex, jellyfin, direction) => void addPair(plex, jellyfin, direction)} />
        <Suggestions data={data} busy={busy} onPair={(plexUserId, jellyfinUserId) => void addPair(plexUserId, jellyfinUserId, "both")} />
      </section>
    </div>
  );
}
