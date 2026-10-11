"use client";

// Admin → Library cleanup. Loads the report on mount (it makes live Radarr/Sonarr
// calls, so it is never part of the server render), lets the admin tune the
// rules, protect titles, and delete a selection through the route's two-step
// dry run → confirmed execute. Every date shown is a server-supplied ISO string
// formatted for the viewer's locale (the report arrives after mount, so there is
// no SSR/hydration pair to disagree), and "idle" is a server-computed day count
// — nothing here reads the clock while rendering (guardrail 16).

import { useCallback, useEffect, useMemo, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { EmptyState, SectionHeader, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { FileX, Loader2, Shield, ShieldOff, Trash2 } from "@/components/icons";
import {
  CleanupPlanPanel,
  CleanupResultPanel,
  arrInstanceLabel as instanceLabel,
  cleanupKeyOf as keyOf,
  dayFormatter,
  formatBytesIn,
  readApiError as readError,
  useCleanupDelete,
} from "@/components/admin/cleanup-delete";
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
export function LibraryCleanup() {
  const t = useT();
  const locale = useLocale();
  const day = useMemo(() => dayFormatter(locale), [locale]);
  const formatBytes = useCallback((n: number | null) => formatBytesIn(n, locale), [locale]);
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
  const del = useCleanupDelete({
    items: () => selectedRows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })),
    onDeleted: async () => {
      setSelected(new Set());
      await load();
    },
  });

  function toggle(k: string) {
    del.clearPlan();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleAllVisible() {
    del.clearPlan();
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
      del.clearPlan();
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
      del.clearPlan();
      await load();
    } catch {
      setError(t("adminManage.cleanup.error.network"));
    } finally {
      setBusyKey(null);
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
  const setBool = (field: "unwatchedEnabled" | "neverWatchedEnabled" | "votesEnabled" | "excludeAiring" | "requireUpstreamCheck", v: boolean) =>
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
        {/* The wrapper carries the id the section's aria-labelledby points at
            (SectionHeader exposes none) and cancels the header's own 12px
            bottom margin — the column's gap-3 already spaces it. */}
        <div id="cleanup-rules" className="-mb-3">
          <SectionHeader title={t("adminManage.cleanup.rules")} />
        </div>
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
          <label className="flex flex-wrap items-center gap-2">
            <Switch checked={draft.requireUpstreamCheck} onCheckedChange={(v) => setBool("requireUpstreamCheck", v)} aria-label={t("adminManage.cleanup.excl.upstreamAria")} />
            {t("adminManage.cleanup.excl.upstream")}
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
        <StyledSelect compact className="w-auto" value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label={t("adminManage.cleanup.filter.show")}>
          <option value="candidates">{t("adminManage.cleanup.stat.candidates")}</option>
          <option value="held">{t("adminManage.cleanup.stat.held")}</option>
          <option value="all">{t("adminManage.cleanup.filter.allMatched")}</option>
        </StyledSelect>
        <StyledSelect compact className="w-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} aria-label={t("adminManage.cleanup.filter.mediaType")}>
          <option value="all">{t("adminManage.cleanup.filter.moviesAndTv")}</option>
          <option value="MOVIE">{t("nav.movies")}</option>
          <option value="TV">{t("adminManage.cleanup.tv")}</option>
        </StyledSelect>
        <StyledSelect compact className="w-auto" value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value as typeof ruleFilter)} aria-label={t("adminManage.cleanup.filter.rule")}>
          <option value="any">{t("adminManage.cleanup.filter.anyRule")}</option>
          {(Object.keys(CLEANUP_RULE_LABELS) as CleanupRule[]).map((r) => (
            <option key={r} value={r}>{t(`adminManage.cleanup.ruleLabel.${r}`)}</option>
          ))}
        </StyledSelect>
        {/* Input is the h-8 twin of the compact selects beside it; the old
            hand-rolled 26px field sat visibly shorter in the same row. */}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 200))}
          placeholder={t("adminManage.cleanup.filter.titlePlaceholder")}
          aria-label={t("adminManage.cleanup.filter.title")}
          className="w-[200px]"
        />
        <div className="flex-1" />
        <Button size="sm" variant="destructive" onClick={() => void del.dryRun()} disabled={selectedRows.length === 0 || del.planning || del.executing}>
          {del.planning ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {selectedRows.length > 0
            ? t("adminManage.cleanup.deleteSelectedSize", { count: selectedRows.length, size: formatBytes(selectedBytes) })
            : t("adminManage.cleanup.deleteSelected", { count: 0 })}
        </Button>
      </div>

      {(error || del.error) && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error || del.error}</p>}

      {/* ── dry run → confirm ──────────────────────────────────────── */}
      <CleanupPlanPanel del={del} formatBytes={formatBytes} />
      <CleanupResultPanel result={del.result} />

      {/* ── table ───────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <EmptyState
          icon={FileX}
          title={anyRuleOn ? t("adminManage.cleanup.empty.title") : t("adminManage.cleanup.empty.noRulesTitle")}
          description={anyRuleOn ? t("adminManage.cleanup.empty.description") : t("adminManage.cleanup.empty.noRulesDescription")}
        />
      ) : (
        <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
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
                  <tr key={k} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
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
          <div id="cleanup-protected" className="-mb-3">
            <SectionHeader title={t("adminManage.cleanup.protectedCount", { count: report.protected.length })} />
          </div>
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
