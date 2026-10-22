"use client";

// Admin → Watch Sync: the admin pairs a Plex account with a Jellyfin user, and
// the watch-sync cron marks in that Jellyfin account what Plex counted as
// watched (src/lib/watch-sync.ts — guardrail 19e). Pairs are made only here;
// a suggestion (both identities linked to one Summonarr account) is a button,
// never an automatic pair.

import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, SectionHeader } from "@/components/ui/design";
import { ArrowRight, Loader2, RefreshCw, Trash2 } from "@/components/icons";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";

type ServerUser = { id: string; username: string; server: string; active: boolean };
type Counts = { pending: number; marked: number; already: number; missing: number; failed: number };
type LastResult = { queued?: number; unresolved?: number; unmatched?: number; marked?: number; error?: string } | null;
type Pair = {
  id: string;
  enabled: boolean;
  plex: ServerUser;
  jellyfin: ServerUser;
  historyReadTo: string | null;
  lastRunAt: string | null;
  lastResult: LastResult;
  counts?: Counts;
};
type Overview = {
  pairs: Pair[];
  plexUsers: ServerUser[];
  jellyfinUsers: ServerUser[];
  suggestions: Array<{ plexUserId: string; jellyfinUserId: string; account: string }>;
};

const RUN_POLL_MS = 3_000;
const RUN_MAX_POLLS = 400;

function errorOf(data: unknown): string | null {
  const msg = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  return typeof msg === "string" && msg ? msg : null;
}

export function WatchSyncPanel() {
  const t = useT();
  const locale = useLocale();
  const mounted = useRef(true);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [plexSel, setPlexSel] = useState("");
  const [jfSel, setJfSel] = useState("");

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

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : "");

  async function send(key: string, url: string, init: RequestInit) {
    setBusy(key);
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
      if (mounted.current) setBusy(null);
    }
  }

  async function addPair(plexUserId: string, jellyfinUserId: string) {
    const ok = await send(`add:${plexUserId}:${jellyfinUserId}`, "/api/admin/watch-sync", {
      method: "POST",
      body: JSON.stringify({ plexUserId, jellyfinUserId }),
    });
    if (ok) {
      setPlexSel("");
      setJfSel("");
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
      const pairs = (answer.data as { pairs?: Array<{ marked?: number; error?: string }> } | null)?.pairs ?? [];
      const marked = pairs.reduce((n, p) => n + (p.marked ?? 0), 0);
      const problems = pairs.filter((p) => p.error).length;
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

  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-[var(--ds-fg-muted)]">{t("adminManage.watchSync.intro")}</p>

      {(error || note) && (
        <p role="status" className={`text-sm ${error ? "text-[var(--ds-danger)]" : "text-[var(--ds-fg-muted)]"}`}>{error || note}</p>
      )}

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
            {data.pairs.map((p) => {
              const c = p.counts ?? { pending: 0, marked: 0, already: 0, missing: 0, failed: 0 };
              return (
                <li key={p.id} className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-1)] p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
                      <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                        <Chip tone="plex" className="shrink-0">Plex</Chip>
                        <span className="truncate text-[var(--ds-fg)]">{userLabel(p.plex)}</span>
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--ds-fg-subtle)]" aria-label={t("adminManage.watchSync.to")} />
                      <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                        <Chip tone="jellyfin" className="shrink-0">Jellyfin</Chip>
                        <span className="truncate text-[var(--ds-fg)]">{userLabel(p.jellyfin)}</span>
                      </span>
                      {!p.jellyfin.active && <Chip tone="declined" className="whitespace-nowrap">{t("adminManage.watchSync.jellyfinGone")}</Chip>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <label className="flex items-center gap-2 text-xs text-[var(--ds-fg-muted)]">
                        <Switch
                          size="sm"
                          checked={p.enabled}
                          disabled={busy !== null}
                          onCheckedChange={(enabled) => void send(`toggle:${p.id}`, `/api/admin/watch-sync/${p.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) })}
                          aria-label={t("adminManage.watchSync.enabled")}
                        />
                        {p.enabled ? t("adminManage.watchSync.enabled") : t("adminManage.watchSync.paused")}
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm(t("adminManage.watchSync.rescanConfirm"))) {
                            void send(`rescan:${p.id}`, `/api/admin/watch-sync/${p.id}`, { method: "PATCH", body: JSON.stringify({ rescan: true }) })
                              .then((ok) => { if (ok) setNote(t("adminManage.watchSync.rescanQueued")); });
                          }
                        }}
                      >
                        {t("adminManage.watchSync.rescan")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy !== null}
                        aria-label={t("adminManage.watchSync.remove")}
                        title={t("adminManage.watchSync.remove")}
                        onClick={() => {
                          if (window.confirm(t("adminManage.watchSync.removeConfirm"))) {
                            void send(`remove:${p.id}`, `/api/admin/watch-sync/${p.id}`, { method: "DELETE" });
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <Chip tone="approved">{t("adminManage.watchSync.count.marked", { count: c.marked })}</Chip>
                    <Chip>{t("adminManage.watchSync.count.already", { count: c.already })}</Chip>
                    {c.pending > 0 && <Chip tone="pending">{t("adminManage.watchSync.count.pending", { count: c.pending })}</Chip>}
                    {c.missing > 0 && <Chip>{t("adminManage.watchSync.count.missing", { count: c.missing })}</Chip>}
                    {c.failed > 0 && <Chip tone="declined">{t("adminManage.watchSync.count.failed", { count: c.failed })}</Chip>}
                    {(p.lastResult?.unmatched ?? 0) > 0 && (
                      <Chip title={t("adminManage.watchSync.count.unmatchedHint")}>{t("adminManage.watchSync.count.unmatched", { count: p.lastResult?.unmatched ?? 0 })}</Chip>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-[var(--ds-fg-subtle)]">
                    {p.historyReadTo
                      ? t("adminManage.watchSync.readTo", { date: fmt(p.historyReadTo) })
                      : t("adminManage.watchSync.notReadYet")}
                    {p.lastRunAt ? ` · ${t("adminManage.watchSync.lastRun", { date: fmt(p.lastRunAt) })}` : ""}
                  </p>
                  {p.lastResult?.error && (
                    <p className="mt-1 text-xs text-[var(--ds-danger)]">{t("adminManage.watchSync.lastError", { error: p.lastResult.error })}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader title={t("adminManage.watchSync.add.title")} subtitle={t("adminManage.watchSync.add.subtitle")} />
        {data.plexUsers.length === 0 || data.jellyfinUsers.length === 0 ? (
          <p className="text-sm text-[var(--ds-fg-muted)]">{t("adminManage.watchSync.add.noUsers")}</p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <StyledSelect compact value={plexSel} onChange={(e) => setPlexSel(e.target.value)} aria-label={t("adminManage.watchSync.add.plex")} className="sm:max-w-xs">
              <option value="">{t("adminManage.watchSync.add.plex")}</option>
              {data.plexUsers.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </StyledSelect>
            <ArrowRight className="hidden h-4 w-4 shrink-0 text-[var(--ds-fg-subtle)] sm:block" aria-hidden />
            <StyledSelect compact value={jfSel} onChange={(e) => setJfSel(e.target.value)} aria-label={t("adminManage.watchSync.add.jellyfin")} className="sm:max-w-xs">
              <option value="">{t("adminManage.watchSync.add.jellyfin")}</option>
              {data.jellyfinUsers.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </StyledSelect>
            <Button size="sm" disabled={!plexSel || !jfSel || busy !== null} onClick={() => void addPair(plexSel, jfSel)}>
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
                    <ArrowRight className="h-4 w-4 text-[var(--ds-fg-subtle)]" aria-hidden />
                    <span className="text-[var(--ds-fg-muted)]">{userLabel(jf)}</span>
                    <Button variant="outline" size="xs" disabled={busy !== null} onClick={() => void addPair(s.plexUserId, s.jellyfinUserId)}>
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
