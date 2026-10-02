"use client";

// Admin → Library cleanup. Loads the report on mount (it makes live Radarr/Sonarr
// calls, so it is never part of the server render), lets the admin tune the
// rules, protect titles, and delete a selection through the route's two-step
// dry run → confirmed execute. Every date shown is a server-supplied ISO string
// sliced to a day, and "idle" is a server-computed day count — nothing here
// reads the clock while rendering (guardrail 16).

import { useCallback, useEffect, useMemo, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmptyState, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { FileX, Loader2, Shield, ShieldOff, Trash2 } from "@/components/icons";
import {
  CLEANUP_NUMERIC_BOUNDS,
  CLEANUP_RULE_LABELS,
  type CleanupExclusion,
  type CleanupRule,
  type CleanupSettings,
} from "@/lib/library-cleanup";

type Row = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
  year: string | null;
  servers: string[];
  addedAt: string | null;
  lastPlayedAt: string | null;
  playCount: number;
  votes: number;
  idleDays: number | null;
  arr: Array<{ service: "radarr" | "sonarr"; instance: string; sizeOnDisk: number }>;
  sizeOnDisk: number | null;
  matched: CleanupRule[];
  excludedBy: CleanupExclusion[];
  candidate: boolean;
};

type Report = {
  settings: CleanupSettings;
  playHistoryTracked: boolean;
  historyStart: string | null;
  rows: Row[];
  libraryTitles: number;
  arrErrors: Array<{ service: string; instance: string; error: string }>;
  protected: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV"; title: string | null; reason: string | null; createdAt: string }>;
  totals: { candidates: number; held: number; reclaimableBytes: number };
};

type Plan = {
  targetCount: number;
  reclaimableBytes: number;
  items: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; targets: Array<{ service: string; instance: string; title: string; sizeOnDisk: number }> }>;
  skipped: Array<{ tmdbId: number; mediaType: string; title: string | null; reason: string }>;
};

type ExecResult = {
  deletedCount: number;
  partialCount: number;
  failedCount: number;
  results: Array<{ tmdbId: number; mediaType: string; title: string; status: "deleted" | "partial" | "failed"; deleted: string[]; failed: Array<{ target: string; error: string }> }>;
};

const keyOf = (r: { tmdbId: number; mediaType: string }) => `${r.mediaType}:${r.tmdbId}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const instanceLabel = (service: string, instance: string) =>
  `${service === "radarr" ? "Radarr" : "Sonarr"}${instance ? ` (${instance})` : ""}`;

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

const panel: React.CSSProperties = {
  padding: 16,
  borderRadius: 10,
  border: "1px solid var(--ds-border)",
  background: "var(--ds-bg-1)",
};
const inputStyle: React.CSSProperties = {
  width: 76,
  padding: "4px 8px",
  fontSize: 13,
  color: "var(--ds-fg)",
  background: "var(--ds-bg-2)",
  border: "1px solid var(--ds-border)",
  borderRadius: 6,
};
const selectStyle: React.CSSProperties = { ...inputStyle, width: "auto" };

async function readError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? fallback;
}

export function LibraryCleanup() {
  const t = useT();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<CleanupSettings | null>(null);
  const [savingRules, setSavingRules] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | "MOVIE" | "TV">("all");
  const [view, setView] = useState<"candidates" | "held" | "all">("candidates");
  const [ruleFilter, setRuleFilter] = useState<"any" | CleanupRule>("any");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [blacklist, setBlacklist] = useState(true);
  const [result, setResult] = useState<ExecResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup"));
      if (!res.ok) {
        setError(await readError(res, t("adminManage.cleanup.error.load")));
        return;
      }
      const data = (await res.json()) as Report;
      setReport(data);
      setDraft(data.settings);
      // Drop selections that are no longer deletable candidates.
      const live = new Set(data.rows.filter((r) => r.candidate).map(keyOf));
      setSelected((prev) => new Set([...prev].filter((k) => live.has(k))));
    } catch {
      setError(t("adminManage.cleanup.error.loadNetwork"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.rows.filter((r) => {
      if (view === "candidates" && !r.candidate) return false;
      if (view === "held" && r.candidate) return false;
      if (typeFilter !== "all" && r.mediaType !== typeFilter) return false;
      if (ruleFilter !== "any" && !r.matched.includes(ruleFilter)) return false;
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [report, view, typeFilter, ruleFilter, query]);

  const selectableVisible = visible.filter((r) => r.candidate && r.arr.length > 0);
  const selectedRows = report ? report.rows.filter((r) => selected.has(keyOf(r))) : [];
  const selectedBytes = selectedRows.reduce((n, r) => n + (r.sizeOnDisk ?? 0), 0);

  function toggle(k: string) {
    setPlan(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleAllVisible() {
    setPlan(null);
    const keys = selectableVisible.map(keyOf);
    const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  async function saveRules() {
    if (!draft) return;
    setSavingRules(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        setError(await readError(res, t("adminManage.cleanup.error.save")));
        return;
      }
      setPlan(null);
      await load();
    } catch {
      setError(t("adminManage.cleanup.error.saveNetwork"));
    } finally {
      setSavingRules(false);
    }
  }

  async function setProtected(row: { tmdbId: number; mediaType: "MOVIE" | "TV"; title: string | null }, on: boolean) {
    const k = keyOf(row);
    setBusyKey(k);
    setError("");
    try {
      const res = on
        ? await fetch(withBasePath("/api/admin/cleanup/protect"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tmdbId: row.tmdbId, mediaType: row.mediaType, ...(row.title ? { title: row.title.slice(0, 500) } : {}) }),
          })
        : await fetch(withBasePath(`/api/admin/cleanup/protect?tmdbId=${row.tmdbId}&mediaType=${row.mediaType}`), { method: "DELETE" });
      if (!res.ok) {
        setError(await readError(res, on ? t("adminManage.cleanup.error.protect") : t("adminManage.cleanup.error.unprotect")));
        return;
      }
      setPlan(null);
      await load();
    } catch {
      setError(t("adminManage.cleanup.error.network"));
    } finally {
      setBusyKey(null);
    }
  }

  const itemsBody = () => selectedRows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }));

  async function dryRun() {
    if (selectedRows.length === 0) return;
    setPlanning(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: itemsBody(), blacklist }),
      });
      if (!res.ok) {
        setError(await readError(res, t("adminManage.cleanup.error.dryRun")));
        return;
      }
      setPlan((await res.json()) as Plan);
    } catch {
      setError(t("adminManage.cleanup.error.dryRunNetwork"));
    } finally {
      setPlanning(false);
    }
  }

  async function execute() {
    if (!plan) return;
    setExecuting(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup/delete?execute=true"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: itemsBody(), blacklist, confirmTargets: plan.targetCount }),
      });
      if (res.status === 409) {
        // Something changed since the dry run — show the fresh plan instead.
        const fresh = (await res.json().catch(() => null)) as (Plan & { error?: string }) | null;
        setError(t("adminManage.cleanup.error.changed"));
        if (fresh?.items) setPlan({ targetCount: fresh.targetCount, reclaimableBytes: plan.reclaimableBytes, items: fresh.items, skipped: fresh.skipped ?? [] });
        return;
      }
      if (!res.ok) {
        setError(await readError(res, t("adminManage.cleanup.error.delete")));
        return;
      }
      setResult((await res.json()) as ExecResult);
      setPlan(null);
      setSelected(new Set());
      await load();
    } catch {
      setError(t("adminManage.cleanup.error.deleteNetwork"));
    } finally {
      setExecuting(false);
    }
  }

  if (loading && !report) {
    return (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.cleanup.judging")}
      </div>
    );
  }
  if (!report || !draft) {
    return <p style={{ color: "var(--ds-danger)", fontSize: 13 }}>{error || t("adminManage.cleanup.error.load")}</p>;
  }

  const anyRuleOn = report.settings.unwatchedEnabled || report.settings.neverWatchedEnabled || report.settings.votesEnabled;
  const setNum = (field: keyof typeof CLEANUP_NUMERIC_BOUNDS, v: string) =>
    setDraft((d) => (d ? { ...d, [field]: v === "" ? 0 : Math.trunc(Number(v)) } : d));
  const setBool = (field: "unwatchedEnabled" | "neverWatchedEnabled" | "votesEnabled" | "excludeAiring", v: boolean) =>
    setDraft((d) => (d ? { ...d, [field]: v } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(report.settings);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <StatCard label={t("adminManage.cleanup.stat.candidates")} value={report.totals.candidates} hint={t("adminManage.cleanup.stat.candidatesHint")} />
        <StatCard label={t("adminManage.cleanup.stat.held")} value={report.totals.held} hint={t("adminManage.cleanup.stat.heldHint")} />
        <StatCard label={t("adminManage.cleanup.stat.reclaimable")} value={formatBytes(report.totals.reclaimableBytes)} hint={t("adminManage.cleanup.stat.reclaimableHint")} />
        <StatCard label={t("adminManage.cleanup.stat.libraryTitles")} value={report.libraryTitles} hint={t("adminManage.cleanup.stat.libraryTitlesHint")} />
      </div>

      {!report.playHistoryTracked && (
        <p role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.cleanup.trackingOff")}
        </p>
      )}
      {report.arrErrors.length > 0 && (
        <p role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.cleanup.arrErrors", { list: report.arrErrors.map((e) => instanceLabel(e.service, e.instance)).join(", ") })}
        </p>
      )}

      {/* ── rules ───────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3" style={panel} aria-labelledby="cleanup-rules">
        <h2 id="cleanup-rules" style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>{t("adminManage.cleanup.rules")}</h2>
        <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
          {report.historyStart
            ? t("adminManage.cleanup.rulesHelpSince", { date: day(report.historyStart) })
            : t("adminManage.cleanup.rulesHelp")}
        </p>
        <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
          <label className="flex flex-wrap items-center gap-2">
            <Switch checked={draft.unwatchedEnabled} onCheckedChange={(v) => setBool("unwatchedEnabled", v)} aria-label={t("adminManage.cleanup.rule.unwatchedAria")} />
            {t("adminManage.cleanup.rule.unwatchedBefore")}
            <input type="number" style={inputStyle} min={1} max={3650} value={draft.unwatchedDays} onChange={(e) => setNum("unwatchedDays", e.target.value)} aria-label={t("adminManage.cleanup.rule.unwatchedDaysAria")} />
            {t("adminManage.cleanup.days")}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <Switch checked={draft.neverWatchedEnabled} onCheckedChange={(v) => setBool("neverWatchedEnabled", v)} aria-label={t("adminManage.cleanup.rule.neverWatchedAria")} />
            {t("adminManage.cleanup.rule.neverWatchedBefore")}
            <input type="number" style={inputStyle} min={1} max={3650} value={draft.neverWatchedDays} onChange={(e) => setNum("neverWatchedDays", e.target.value)} aria-label={t("adminManage.cleanup.rule.neverWatchedDaysAria")} />
            {t("adminManage.cleanup.days")}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <Switch checked={draft.votesEnabled} onCheckedChange={(v) => setBool("votesEnabled", v)} aria-label={t("adminManage.cleanup.rule.votesAria")} />
            {t("adminManage.cleanup.rule.votesBefore")}
            <input type="number" style={inputStyle} min={1} max={1000} value={draft.votesMin} onChange={(e) => setNum("votesMin", e.target.value)} aria-label={t("adminManage.cleanup.rule.votesMinAria")} />
            {t("adminManage.cleanup.rule.votesAfter")}
          </label>
        </div>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)", margin: "4px 0 0" }}>{t("adminManage.cleanup.alwaysExcluded")}</h3>
        <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
          <label className="flex flex-wrap items-center gap-2">
            {t("adminManage.cleanup.excl.minAgeBefore")}
            <input type="number" style={inputStyle} min={0} max={3650} value={draft.minAgeDays} onChange={(e) => setNum("minAgeDays", e.target.value)} aria-label={t("adminManage.cleanup.excl.minAgeAria")} />
            {t("adminManage.cleanup.excl.minAgeAfter")}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            {t("adminManage.cleanup.excl.recentBefore")}
            <input type="number" style={inputStyle} min={0} max={3650} value={draft.recentRequestDays} onChange={(e) => setNum("recentRequestDays", e.target.value)} aria-label={t("adminManage.cleanup.excl.recentAria")} />
            {t("adminManage.cleanup.excl.recentAfter")}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <Switch checked={draft.excludeAiring} onCheckedChange={(v) => setBool("excludeAiring", v)} aria-label={t("adminManage.cleanup.excl.airingAria")} />
            {t("adminManage.cleanup.excl.airing")}
          </label>
          <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
            {t("adminManage.cleanup.excl.alsoHeld")}
          </p>
        </div>
        <div>
          <Button size="sm" onClick={saveRules} disabled={!dirty || savingRules}>
            {savingRules ? <Loader2 className="animate-spin" /> : null}
            {t("adminManage.cleanup.saveRules")}
          </Button>
        </div>
      </section>

      {/* ── filters + bulk action ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 13 }}>
        <select style={selectStyle} value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label={t("adminManage.cleanup.filter.show")}>
          <option value="candidates">{t("adminManage.cleanup.stat.candidates")}</option>
          <option value="held">{t("adminManage.cleanup.stat.held")}</option>
          <option value="all">{t("adminManage.cleanup.filter.allMatched")}</option>
        </select>
        <select style={selectStyle} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} aria-label={t("adminManage.cleanup.filter.mediaType")}>
          <option value="all">{t("adminManage.cleanup.filter.moviesAndTv")}</option>
          <option value="MOVIE">{t("nav.movies")}</option>
          <option value="TV">{t("adminManage.cleanup.tv")}</option>
        </select>
        <select style={selectStyle} value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value as typeof ruleFilter)} aria-label={t("adminManage.cleanup.filter.rule")}>
          <option value="any">{t("adminManage.cleanup.filter.anyRule")}</option>
          {(Object.keys(CLEANUP_RULE_LABELS) as CleanupRule[]).map((r) => (
            <option key={r} value={r}>{t(`adminManage.cleanup.ruleLabel.${r}`)}</option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 200))}
          placeholder={t("adminManage.cleanup.filter.titlePlaceholder")}
          aria-label={t("adminManage.cleanup.filter.title")}
          style={{ ...inputStyle, width: 200 }}
        />
        <div className="flex-1" />
        <Button size="sm" variant="destructive" onClick={dryRun} disabled={selectedRows.length === 0 || planning || executing}>
          {planning ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {selectedRows.length > 0
            ? t("adminManage.cleanup.deleteSelectedSize", { count: selectedRows.length, size: formatBytes(selectedBytes) })
            : t("adminManage.cleanup.deleteSelected", { count: 0 })}
        </Button>
      </div>

      {error && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error}</p>}

      {/* ── dry run → confirm ──────────────────────────────────────── */}
      {plan && (
        <section className="flex flex-col gap-3 rounded-md bg-red-500/10" style={{ padding: 16, border: "1px solid var(--ds-border)" }} aria-labelledby="cleanup-plan">
          <h2 id="cleanup-plan" className="text-red-400" style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            {t("adminManage.cleanup.plan.title", {
              deletions: t("adminManage.cleanup.plan.deletions", { count: plan.targetCount }),
              titles: t("adminManage.cleanup.plan.titles", { count: plan.items.length }),
              size: formatBytes(plan.reclaimableBytes),
            })}
          </h2>
          <p style={{ fontSize: 12, color: "var(--ds-fg)", margin: 0 }}>
            {t("adminManage.cleanup.plan.warning")}
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ds-fg)" }}>
            {plan.items.map((it) => (
              <li key={keyOf(it)}>
                {it.title} — {it.targets.map((tg) => `${instanceLabel(tg.service, tg.instance)} (${formatBytes(tg.sizeOnDisk)})`).join(", ")}
              </li>
            ))}
          </ul>
          {plan.skipped.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>
              {t("adminManage.cleanup.plan.skipped")}
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.skipped.map((s) => <li key={keyOf(s)}>{s.title ?? `${s.mediaType} ${s.tmdbId}`} — {s.reason}</li>)}
              </ul>
            </div>
          )}
          <label className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
            <Switch checked={blacklist} onCheckedChange={setBlacklist} aria-label={t("adminManage.cleanup.plan.blacklistAria")} />
            {t("adminManage.cleanup.plan.blacklist")}
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={execute}
              disabled={executing || plan.targetCount === 0}
              className="ds-hover-tint inline-flex items-center gap-1.5 rounded-md"
              style={{
                padding: "6px 12px",
                fontSize: 13,
                fontWeight: 600,
                background: "var(--ds-danger)",
                color: "var(--ds-on-status)",
                opacity: executing || plan.targetCount === 0 ? 0.6 : 1,
              }}
            >
              {executing ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : <Trash2 style={{ width: 14, height: 14 }} />}
              {t("adminManage.cleanup.plan.deleteNow", { count: plan.targetCount })}
            </button>
            <Button size="sm" variant="outline" onClick={() => setPlan(null)} disabled={executing}>{t("adminManage.common.cancel")}</Button>
          </div>
        </section>
      )}

      {result && (
        <section className="flex flex-col gap-2" style={panel} aria-labelledby="cleanup-result">
          <h2 id="cleanup-result" style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>
            {t("adminManage.cleanup.result.deleted", { count: result.deletedCount })}
            {result.partialCount > 0 ? t("adminManage.cleanup.result.partial", { count: result.partialCount }) : ""}
            {result.failedCount > 0 ? t("adminManage.cleanup.result.failed", { count: result.failedCount }) : ""}
          </h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ds-fg)" }}>
            {result.results.map((r) => (
              <li key={keyOf(r)}>
                <span className={r.status === "deleted" ? "text-green-400" : "text-red-400"}>{t(`adminManage.cleanup.status.${r.status}`)}</span> — {r.title}
                {r.failed.length > 0 ? ` ${t("adminManage.cleanup.result.failedOn", { list: r.failed.map((f) => `${f.target}: ${f.error}`).join("; ") })}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── table ───────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <EmptyState
          icon={FileX}
          title={anyRuleOn ? t("adminManage.cleanup.empty.title") : t("adminManage.cleanup.empty.noRulesTitle")}
          description={anyRuleOn ? t("adminManage.cleanup.empty.description") : t("adminManage.cleanup.empty.noRulesDescription")}
        />
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--ds-border)", borderRadius: 10 }}>
          <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
            <thead>
              <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>
                <th style={{ padding: "8px 10px", width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label={t("adminManage.cleanup.selectAll")}
                    checked={selectableVisible.length > 0 && selectableVisible.every((r) => selected.has(keyOf(r)))}
                    onChange={toggleAllVisible}
                    disabled={selectableVisible.length === 0}
                  />
                </th>
                <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.title")}</th>
                <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.on")}</th>
                <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.added")}</th>
                <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.lastPlayed")}</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>{t("adminManage.cleanup.col.plays")}</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>{t("adminManage.cleanup.col.votes")}</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>{t("adminManage.cleanup.col.size")}</th>
                <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.why")}</th>
                <th style={{ padding: "8px 10px" }} />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const k = keyOf(r);
                const deletable = r.candidate && r.arr.length > 0;
                const isProtected = r.excludedBy.includes("protected");
                return (
                  <tr key={k} style={{ borderTop: "1px solid var(--ds-border)" }}>
                    <td style={{ padding: "6px 10px" }}>
                      <input
                        type="checkbox"
                        aria-label={t("adminManage.cleanup.select", { title: r.title })}
                        checked={selected.has(k)}
                        disabled={!deletable}
                        title={deletable ? undefined : r.candidate ? t("adminManage.cleanup.notManaged") : t("adminManage.cleanup.heldByExclusion")}
                        onChange={() => toggle(k)}
                      />
                    </td>
                    <td style={{ padding: "6px 10px" }}>
                      <div className="flex items-center gap-2">
                        <Poster src={posterUrl(r.posterPath)} letter={(r.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
                        <div>
                          <div style={{ fontWeight: 500 }}>{r.title}{r.year ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.year})</span> : null}</div>
                          <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                            {r.mediaType === "MOVIE" ? t("adminManage.cleanup.movie") : t("adminManage.cleanup.tv")}
                            {r.idleDays !== null ? ` · ${t("adminManage.cleanup.idle", { days: r.idleDays })}` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "6px 10px", fontSize: 11, color: "var(--ds-fg-muted)" }}>
                      <div>{r.servers.join(", ")}</div>
                      <div style={{ color: "var(--ds-fg-subtle)" }}>
                        {r.arr.length > 0 ? r.arr.map((a) => instanceLabel(a.service, a.instance)).join(", ") : t("adminManage.cleanup.notInArr")}
                      </div>
                    </td>
                    <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12 }}>{day(r.addedAt)}</td>
                    <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12 }}>{r.lastPlayedAt ? day(r.lastPlayedAt) : t("adminManage.cleanup.never")}</td>
                    <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, textAlign: "right" }}>{r.playCount}</td>
                    <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, textAlign: "right" }}>{r.votes}</td>
                    <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, textAlign: "right" }}>{formatBytes(r.sizeOnDisk)}</td>
                    <td style={{ padding: "6px 10px" }}>
                      <div className="flex flex-wrap gap-1">
                        {r.matched.map((m) => (
                          <span key={m} className="rounded bg-red-500/15 text-red-400" style={{ padding: "1px 6px", fontSize: 11 }}>{t(`adminManage.cleanup.ruleLabel.${m}`)}</span>
                        ))}
                        {r.excludedBy.map((x) => (
                          <span key={x} className="rounded bg-sky-500/15 text-sky-400" style={{ padding: "1px 6px", fontSize: 11 }}>{t(`adminManage.cleanup.exclusionLabel.${x}`)}</span>
                        ))}
                      </div>
                    </td>
                    <td style={{ padding: "6px 10px", textAlign: "right" }}>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setProtected(r, !isProtected)}
                        disabled={busyKey === k}
                        aria-label={isProtected ? t("adminManage.cleanup.unprotectTitle", { title: r.title }) : t("adminManage.cleanup.protectTitle", { title: r.title })}
                      >
                        {busyKey === k ? <Loader2 className="animate-spin" /> : isProtected ? <ShieldOff /> : <Shield />}
                        {isProtected ? t("adminManage.cleanup.unprotect") : t("adminManage.cleanup.protect")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── protected titles ───────────────────────────────────────── */}
      {report.protected.length > 0 && (
        <section className="flex flex-col gap-2" style={panel} aria-labelledby="cleanup-protected">
          <h2 id="cleanup-protected" style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>
            {t("adminManage.cleanup.protectedCount", { count: report.protected.length })}
          </h2>
          {report.protected.map((p) => (
            <div key={keyOf(p)} className="flex items-center justify-between" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
              <span>
                {p.title ?? `${p.mediaType} ${p.tmdbId}`}
                <span style={{ color: "var(--ds-fg-subtle)" }}> · {p.mediaType === "MOVIE" ? t("adminManage.cleanup.movie") : t("adminManage.cleanup.tv")} · {t("adminManage.cleanup.since", { date: day(p.createdAt) })}</span>
              </span>
              <Button size="xs" variant="ghost" onClick={() => setProtected(p, false)} disabled={busyKey === keyOf(p)}>
                {busyKey === keyOf(p) ? <Loader2 className="animate-spin" /> : <ShieldOff />}
                {t("adminManage.cleanup.unprotect")}
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
