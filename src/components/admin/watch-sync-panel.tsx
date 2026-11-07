"use client";

// Admin → Watch Sync: the admin pairs a Plex account with a Jellyfin user and
// picks a direction; the watch-sync cron marks in each account what the other
// server counted as watched (src/lib/watch-sync.ts — guardrail 19e). Pairs are
// made only here; a suggestion (both identities linked to one Summonarr
// account) is a button, never an automatic pair.

import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, SectionHeader } from "@/components/ui/design";
import { ArrowLeftRight, ArrowRight, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";

type Direction = "both" | "toJellyfin" | "toPlex";
const DIRECTIONS: readonly Direction[] = ["both", "toJellyfin", "toPlex"];
type ServerUser = { id: string; username: string; server: string; active: boolean };
type Counts = { pending: number; marked: number; already: number; missing: number; failed: number };
type DirResult = { queued?: number; unresolved?: number; unmatched?: number; marked?: number; failed?: number; error?: string };
type ProgressResult = { toJellyfin?: number; toPlex?: number; failed?: number; error?: string };
// Results written before Jellyfin → Plex existed are flat (the Plex → Jellyfin numbers).
type LastResult = (DirResult & { toJellyfin?: DirResult | null; toPlex?: DirResult | null; progress?: ProgressResult | null }) | null;
type Pair = {
  id: string;
  enabled: boolean;
  direction: string;
  syncProgress: boolean;
  plex: ServerUser;
  jellyfin: ServerUser;
  historyReadTo: string | null;
  jellyfinReadTo: string | null;
  lastRunAt: string | null;
  lastResult: LastResult;
  counts?: { toJellyfin: Counts; toPlex: Counts };
};
type Overview = {
  pairs: Pair[];
  plexUsers: ServerUser[];
  jellyfinUsers: ServerUser[];
  suggestions: Array<{ plexUserId: string; jellyfinUserId: string; account: string }>;
  run?: { running: boolean; startedAt: string | null; pairId: string | null };
};

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

function errorOf(data: unknown): string | null {
  const msg = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  return typeof msg === "string" && msg ? msg : null;
}

function toward(direction: string, target: "toJellyfin" | "toPlex"): boolean {
  return direction === "both" || direction === target;
}

function lastFor(last: LastResult, dir: "toJellyfin" | "toPlex"): DirResult | null {
  if (!last) return null;
  if ("toJellyfin" in last || "toPlex" in last) return last[dir] ?? null;
  return dir === "toJellyfin" ? last : null;
}

function DirectionIcon({ direction, label }: { direction: string; label: string }) {
  const cls = "h-4 w-4 shrink-0 text-[var(--ds-fg-subtle)]";
  // role="img": without it an svg's aria-label isn't reliably announced, and
  // this icon is the pair header's only direction cue.
  if (direction === "both") return <ArrowLeftRight className={cls} role="img" aria-label={label} />;
  return <ArrowRight className={`${cls}${direction === "toPlex" ? " rotate-180" : ""}`} role="img" aria-label={label} />;
}

export function WatchSyncPanel() {
  const t = useT();
  const locale = useLocale();
  const mounted = useRef(true);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // One change at a time: every control is disabled while one is in flight.
  const [busy, setBusy] = useState(false);
  // The pair whose Remove / Re-scan is waiting for the inline confirmation.
  const [confirming, setConfirming] = useState<{ id: string; kind: "remove" | "rescan" } | null>(null);
  // Bumped after every background re-read, so the next one is armed whatever
  // the last one returned (a failed load leaves `data` as it was).
  const [pollTick, setPollTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [plexSel, setPlexSel] = useState("");
  const [jfSel, setJfSel] = useState("");
  const [dirSel, setDirSel] = useState<Direction>("both");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/admin/watch-sync"));
      const body: unknown = await res.json().catch(() => null);
      if (!mounted.current) return;
      if (!res.ok) { setError(errorOf(body) ?? t("adminManage.watchSync.error.load")); return; }
      setData(body as Overview);
      setError("");
    } catch {
      if (mounted.current) setError(t("adminManage.watchSync.error.loadNetwork"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  // A run in progress (the cron's, or another admin's Run now): keep the page
  // current until it finishes.
  const serverRunning = data?.run?.running === true;
  useEffect(() => {
    if (!serverRunning) return;
    const id = setTimeout(() => {
      void load().finally(() => { if (mounted.current) setPollTick((n) => n + 1); });
    }, RUNNING_REFRESH_MS);
    return () => clearTimeout(id);
  }, [serverRunning, pollTick, load]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : "");
  const dirLabel = (d: string) => t(DIRECTION_KEYS[(DIRECTIONS as readonly string[]).includes(d) ? (d as Direction) : "both"]);

  async function send(url: string, init: RequestInit) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const res = await fetch(withBasePath(url), { ...init, headers: { "Content-Type": "application/json" } });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) { setError(errorOf(body) ?? t("adminManage.watchSync.error.save")); return false; }
      await load();
      return true;
    } catch {
      setError(t("adminManage.watchSync.error.saveNetwork"));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function addPair(plexUserId: string, jellyfinUserId: string, direction: Direction) {
    const ok = await send("/api/admin/watch-sync", {
      method: "POST",
      body: JSON.stringify({ plexUserId, jellyfinUserId, direction }),
    });
    if (ok) {
      setPlexSel("");
      setJfSel("");
      setDirSel("both");
      setNote(t("adminManage.watchSync.added"));
    }
  }

  async function runNow() {
    setRunning(true);
    setError("");
    setNote("");
    try {
      const answer = await runReplaceFileJob(fetch, withBasePath("/api/admin/watch-sync/run"), {}, {
        intervalMs: RUN_POLL_MS,
        maxPolls: RUN_MAX_POLLS,
        isAlive: () => mounted.current,
      });
      if (!answer) return;
      if (answer.status === 0) { setNote(t("adminManage.watchSync.runStillRunning")); return; }
      if (answer.status < 200 || answer.status >= 300) {
        setError(errorOf(answer.data) ?? t("adminManage.watchSync.error.run"));
        return;
      }
      type RunPair = { error?: string; toJellyfin?: DirResult | null; toPlex?: DirResult | null };
      const pairs = (answer.data as { pairs?: RunPair[] } | null)?.pairs ?? [];
      const marked = pairs.reduce((n, p) => n + (p.toJellyfin?.marked ?? 0) + (p.toPlex?.marked ?? 0), 0);
      const problems = pairs.filter((p) => p.error || p.toJellyfin?.error || p.toPlex?.error || (p.toJellyfin?.failed ?? 0) > 0 || (p.toPlex?.failed ?? 0) > 0).length;
      setNote(problems > 0
        ? t("adminManage.watchSync.ranWithProblems", { marked, problems })
        : t("adminManage.watchSync.ran", { marked }));
      await load();
    } catch {
      setError(t("adminManage.watchSync.error.runNetwork"));
    } finally {
      if (mounted.current) setRunning(false);
    }
  }

  if (!data) {
    return error
      ? <p className="text-sm text-[var(--ds-danger)]">{error}</p>
      : <p className="flex items-center gap-2 text-sm text-[var(--ds-fg-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("adminManage.watchSync.loading")}</p>;
  }

  const userLabel = (u: ServerUser) => `${u.username} · ${u.server}`;
  const byId = new Map([...data.plexUsers, ...data.jellyfinUsers].map((u) => [u.id, u]));

  const directionStats = (p: Pair, dir: "toJellyfin" | "toPlex") => {
    const c = p.counts?.[dir] ?? NO_COUNTS;
    const last = lastFor(p.lastResult, dir);
    const toPlex = dir === "toPlex";
    const readTo = toPlex ? p.jellyfinReadTo : p.historyReadTo;
    return (
      <div key={dir} className="mt-3">
        <p className="mb-1.5 text-xs font-medium text-[var(--ds-fg-muted)]">{dirLabel(dir)}</p>
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
            ? t(toPlex ? "adminManage.watchSync.readToJellyfin" : "adminManage.watchSync.readTo", { date: fmt(readTo) })
            : t(toPlex ? "adminManage.watchSync.notReadYetJellyfin" : "adminManage.watchSync.notReadYet")}
        </p>
        {last?.error && <p className="mt-1 text-xs text-[var(--ds-danger)]">{t("adminManage.watchSync.lastError", { error: last.error })}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-[var(--ds-fg-muted)]">{t("adminManage.watchSync.intro")}</p>

      {serverRunning && !running && (
        <p role="status" className="flex items-center gap-2 text-sm text-[var(--ds-fg-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("adminManage.watchSync.run.inProgress", { date: fmt(data.run?.startedAt ?? null) })}
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
            <Button variant="outline" size="sm" onClick={runNow} disabled={running || data.pairs.length === 0}>
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
              <li key={p.id} className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
                    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                      <Chip tone="plex" className="shrink-0">Plex</Chip>
                      <span className="truncate text-[var(--ds-fg)]">{userLabel(p.plex)}</span>
                    </span>
                    <DirectionIcon direction={p.direction} label={dirLabel(p.direction)} />
                    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                      <Chip tone="jellyfin" className="shrink-0">Jellyfin</Chip>
                      <span className="truncate text-[var(--ds-fg)]">{userLabel(p.jellyfin)}</span>
                    </span>
                    {!p.jellyfin.active && <Chip tone="declined" className="whitespace-nowrap">{t("adminManage.watchSync.jellyfinGone")}</Chip>}
                    {serverRunning && data.run?.pairId === p.id && (
                      <Chip tone="pending" className="whitespace-nowrap">{t("adminManage.watchSync.run.syncingPair")}</Chip>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <StyledSelect
                      compact
                      value={(DIRECTIONS as readonly string[]).includes(p.direction) ? p.direction : "both"}
                      disabled={busy}
                      aria-label={t("adminManage.watchSync.direction.label")}
                      className="w-auto"
                      onChange={(e) => void send(`/api/admin/watch-sync/${p.id}`, { method: "PATCH", body: JSON.stringify({ direction: e.target.value }) })}
                    >
                      {DIRECTIONS.map((d) => <option key={d} value={d}>{dirLabel(d)}</option>)}
                    </StyledSelect>
                    <label className="flex items-center gap-2 text-xs text-[var(--ds-fg-muted)]" title={t("adminManage.watchSync.progress.hint")}>
                      <Switch
                        size="sm"
                        checked={p.syncProgress}
                        disabled={busy}
                        onCheckedChange={(syncProgress) => void send(`/api/admin/watch-sync/${p.id}`, { method: "PATCH", body: JSON.stringify({ syncProgress }) })}
                        aria-label={t("adminManage.watchSync.progress.label")}
                      />
                      {t("adminManage.watchSync.progress.label")}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--ds-fg-muted)]">
                      <Switch
                        size="sm"
                        checked={p.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) => void send(`/api/admin/watch-sync/${p.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) })}
                        aria-label={t("adminManage.watchSync.enabled")}
                      />
                      {p.enabled ? t("adminManage.watchSync.enabled") : t("adminManage.watchSync.paused")}
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-expanded={confirming?.id === p.id && confirming.kind === "rescan"}
                      onClick={() => setConfirming(confirming?.id === p.id && confirming.kind === "rescan" ? null : { id: p.id, kind: "rescan" })}
                    >
                      {t("adminManage.watchSync.rescan")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={t("adminManage.watchSync.remove")}
                      title={t("adminManage.watchSync.remove")}
                      aria-expanded={confirming?.id === p.id && confirming.kind === "remove"}
                      onClick={() => setConfirming(confirming?.id === p.id && confirming.kind === "remove" ? null : { id: p.id, kind: "remove" })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {/* The inline confirmation the other admin managers use (never a
                    blocking browser dialog). */}
                {confirming?.id === p.id && (
                  <div className="mt-3 space-y-2 rounded-md border border-red-500/40 bg-red-500/10 p-3">
                    <p className="text-xs text-[var(--ds-danger)]">
                      {t(confirming.kind === "remove" ? "adminManage.watchSync.removeConfirm" : "adminManage.watchSync.rescanConfirm")}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={busy}
                        autoFocus
                        onClick={() => {
                          const kind = confirming.kind;
                          setConfirming(null);
                          if (kind === "remove") {
                            void send(`/api/admin/watch-sync/${p.id}`, { method: "DELETE" });
                          } else {
                            void send(`/api/admin/watch-sync/${p.id}`, { method: "PATCH", body: JSON.stringify({ rescan: true }) })
                              .then((ok) => { if (ok) setNote(t("adminManage.watchSync.rescanQueued")); });
                          }
                        }}
                      >
                        {confirming.kind === "remove" ? <Trash2 className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        {t(confirming.kind === "remove" ? "adminManage.watchSync.remove" : "adminManage.watchSync.rescan")}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>
                        {t("adminManage.common.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
                {toward(p.direction, "toJellyfin") && directionStats(p, "toJellyfin")}
                {toward(p.direction, "toPlex") && directionStats(p, "toPlex")}
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
                  <p className="mt-3 text-xs text-[var(--ds-fg-subtle)]">{t("adminManage.watchSync.lastRun", { date: fmt(p.lastRunAt) })}</p>
                )}
                {/* A problem with the pair itself (both directions stopped). A flat,
                    pre-Jellyfin → Plex result's error is shown in its direction above. */}
                {p.lastResult && ("toJellyfin" in p.lastResult || "toPlex" in p.lastResult) && p.lastResult.error && (
                  <p className="mt-1 text-xs text-[var(--ds-danger)]">{t("adminManage.watchSync.lastError", { error: p.lastResult.error })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader title={t("adminManage.watchSync.add.title")} subtitle={t("adminManage.watchSync.add.subtitle")} />
        {data.plexUsers.length === 0 || data.jellyfinUsers.length === 0 ? (
          <p className="text-sm text-[var(--ds-fg-muted)]">{t("adminManage.watchSync.add.noUsers")}</p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <StyledSelect compact value={plexSel} onChange={(e) => setPlexSel(e.target.value)} aria-label={t("adminManage.watchSync.add.plex")} className="sm:max-w-xs">
              <option value="">{t("adminManage.watchSync.add.plex")}</option>
              {data.plexUsers.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </StyledSelect>
            <StyledSelect compact value={dirSel} onChange={(e) => setDirSel(e.target.value as Direction)} aria-label={t("adminManage.watchSync.direction.label")} className="sm:w-auto">
              {DIRECTIONS.map((d) => <option key={d} value={d}>{dirLabel(d)}</option>)}
            </StyledSelect>
            <StyledSelect compact value={jfSel} onChange={(e) => setJfSel(e.target.value)} aria-label={t("adminManage.watchSync.add.jellyfin")} className="sm:max-w-xs">
              <option value="">{t("adminManage.watchSync.add.jellyfin")}</option>
              {data.jellyfinUsers.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </StyledSelect>
            <Button size="sm" disabled={!plexSel || !jfSel || busy} onClick={() => void addPair(plexSel, jfSel, dirSel)}>
              {t("adminManage.watchSync.add.submit")}
            </Button>
          </div>
        )}

        {data.suggestions.length > 0 && (
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
                    <Button variant="outline" size="xs" disabled={busy} onClick={() => void addPair(s.plexUserId, s.jellyfinUserId, "both")}>
                      {t("adminManage.watchSync.suggestions.pair")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
