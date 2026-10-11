"use client";

// Admin → Never watched (guardrail 14d). Every library title — and every season
// of a show that HAS been watched — nobody has watched in this server's recorded
// history, biggest first. The report is computed on the server, filtered, sorted
// and paged there; this component only asks for a page. Every date is a
// server-supplied ISO string formatted for the viewer, every "days" a server
// count — nothing here reads the clock while rendering (guardrail 16).
//
// Deleting is NOT this page's own: a selection goes through Library cleanup's
// dry run → confirm (the shared cleanup-delete flow), which re-judges every title
// live. Without Library cleanup switched on this page is a report and nothing more.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Chip, EmptyState, FilterBar, SectionHeader, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { HistoryPagination } from "@/components/admin/activity-history/pagination";
import { ArrowDown, ArrowUp, ArrowUpDown, EyeOff, Loader2, RefreshCw, Shield, ShieldOff, Trash2 } from "@/components/icons";
import {
  CleanupPlanPanel,
  CleanupResultPanel,
  arrInstanceLabel,
  cleanupKeyOf,
  dayFormatter,
  formatBytesIn,
  readApiError,
  useCleanupDelete,
} from "@/components/admin/cleanup-delete";
import type { NwLevel, NwSortKey, NwStateFilter } from "@/lib/never-watched";
import type { NeverWatchedReport, NwSeasonRow, NwTitleRow } from "@/lib/never-watched-report";

type Summary = Omit<NeverWatchedReport, "titles" | "seasons">;
type Page = Summary & { rows: Array<NwTitleRow | NwSeasonRow>; total: number };
type Selected = { tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; sizeOnDisk: number | null };

// The route caps a delete at 500 titles.
const MAX_SELECTION = 500;

// Literal key maps — the i18n dead-string check can't see a built key.
const STATE_KEYS = {
  neverWatched: "adminManage.neverWatched.state.neverWatched",
  noPlaysSince: "adminManage.neverWatched.state.noPlaysSince",
  possiblyWatched: "adminManage.neverWatched.state.possiblyWatched",
  unobservable: "adminManage.neverWatched.state.unobservable",
  watched: "adminManage.neverWatched.state.watched",
} as const;
const REASON_KEYS = {
  trackingOff: "adminManage.neverWatched.reason.trackingOff",
  sourceUntracked: "adminManage.neverWatched.reason.sourceUntracked",
  noHistory: "adminManage.neverWatched.reason.noHistory",
  addedUnknown: "adminManage.neverWatched.reason.addedUnknown",
} as const;
const HEALTH_KEYS = {
  ok: "adminManage.neverWatched.upstream.ok",
  unreliable: "adminManage.neverWatched.upstream.unreliable",
  failed: "adminManage.neverWatched.upstream.failed",
  stale: "adminManage.neverWatched.upstream.stale",
  never: "adminManage.neverWatched.upstream.never",
} as const;
const FILTER_KEYS: Record<NwStateFilter, string> = {
  never: "adminManage.neverWatched.filter.never",
  possible: "adminManage.neverWatched.filter.possible",
  unknown: "adminManage.neverWatched.filter.unknown",
  all: "adminManage.neverWatched.filter.all",
};

const panel: React.CSSProperties = {
  padding: 16,
  borderRadius: 10,
  border: "1px solid var(--ds-border)",
  background: "var(--ds-bg-1)",
};
const th: React.CSSProperties = { padding: "8px 10px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 10px" };
// Dates, counts and sizes never break mid-value.
const tdMono: React.CSSProperties = { ...td, fontSize: 12, whiteSpace: "nowrap" };

function bannerClass(tone: "warn" | "info") {
  return tone === "warn" ? "rounded-md bg-amber-500/15 text-amber-400" : "rounded-md bg-sky-500/15 text-sky-400";
}

export function NeverWatchedReport({ initialLevel, initialState }: { initialLevel: NwLevel; initialState: NwStateFilter }) {
  const t = useT();
  const locale = useLocale();
  const day = useMemo(() => dayFormatter(locale), [locale]);
  const formatBytes = useCallback((n: number | null) => formatBytesIn(n, locale), [locale]);
  const num = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [level, setLevel] = useState<NwLevel>(initialLevel);
  const [stateFilter, setStateFilter] = useState<NwStateFilter>(initialState);
  const [type, setType] = useState<"all" | "movie" | "tv">("all");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [sortBy, setSortBy] = useState<NwSortKey>("size");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState("");
  const loadSeq = useRef(0);
  const freshNext = useRef(false);

  // Debounce the search box: a keystroke is not a whole-report request.
  useEffect(() => {
    const id = setTimeout(() => {
      setAppliedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      level, state: stateFilter, type, sortBy, sortDir, page: String(page), limit: String(limit),
    });
    if (appliedQuery) params.set("q", appliedQuery);
    if (eligibleOnly) params.set("eligible", "1");
    if (freshNext.current) {
      params.set("fresh", "1");
      freshNext.current = false;
    }
    try {
      const res = await fetch(withBasePath(`/api/admin/never-watched?${params}`));
      if (seq !== loadSeq.current) return;
      if (!res.ok) {
        setError(await readApiError(res, t("adminManage.neverWatched.error.load")));
        return;
      }
      const next = (await res.json()) as Page;
      if (seq !== loadSeq.current) return;
      setData(next);
    } catch {
      if (seq === loadSeq.current) setError(t("adminManage.neverWatched.error.loadNetwork"));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [level, stateFilter, type, sortBy, sortDir, page, limit, appliedQuery, eligibleOnly, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tab + state are shareable; the rest is per-visit.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (level !== "title") qs.set("level", level);
    if (stateFilter !== "never") qs.set("state", stateFilter);
    const s = qs.toString();
    window.history.replaceState(null, "", s ? `?${s}` : window.location.pathname);
  }, [level, stateFilter]);

  const reload = useCallback(async (fresh = false) => {
    freshNext.current = fresh;
    await load();
  }, [load]);

  const del = useCleanupDelete({
    items: () => [...selected.values()].map((s) => ({ tmdbId: s.tmdbId, mediaType: s.mediaType })),
    onDeleted: async () => {
      setSelected(new Map());
      await reload(true);
    },
  });

  function sortOn(key: NwSortKey) {
    if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir(key === "title" ? "asc" : "desc");
    }
    setPage(1);
  }

  function toggle(r: NwTitleRow) {
    del.clearPlan();
    const k = cleanupKeyOf(r);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(k)) next.delete(k);
      else if (next.size < MAX_SELECTION) next.set(k, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, sizeOnDisk: r.sizeOnDisk });
      return next;
    });
  }

  const titleRows = (data?.rows ?? []).filter((r): r is NwTitleRow => r.kind === "title");
  const selectableOnPage = titleRows.filter((r) => r.eligible);

  function toggleAllOnPage() {
    del.clearPlan();
    const allOn = selectableOnPage.length > 0 && selectableOnPage.every((r) => selected.has(cleanupKeyOf(r)));
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of selectableOnPage) {
        const k = cleanupKeyOf(r);
        if (allOn) next.delete(k);
        else if (next.size < MAX_SELECTION) next.set(k, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, sizeOnDisk: r.sizeOnDisk });
      }
      return next;
    });
  }

  async function setProtected(r: NwTitleRow, on: boolean) {
    const k = cleanupKeyOf(r);
    setBusyKey(k);
    setError("");
    try {
      const res = on
        ? await fetch(withBasePath("/api/admin/cleanup/protect"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title.slice(0, 500) }),
          })
        : await fetch(withBasePath(`/api/admin/cleanup/protect?tmdbId=${r.tmdbId}&mediaType=${r.mediaType}`), { method: "DELETE" });
      if (!res.ok) {
        setError(await readApiError(res, on ? t("adminManage.cleanup.error.protect") : t("adminManage.cleanup.error.unprotect")));
        return;
      }
      del.clearPlan();
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(k);
        return next;
      });
      await reload();
    } catch {
      setError(t("adminManage.cleanup.error.network"));
    } finally {
      setBusyKey(null);
    }
  }

  async function checkUpstream() {
    setChecking(true);
    setCheckNote("");
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/never-watched/refresh"), { method: "POST" });
      if (!res.ok) {
        setError(await readApiError(res, t("adminManage.neverWatched.error.check")));
        return;
      }
      const body = (await res.json().catch(() => null)) as { servers?: Array<{ ok: boolean }> } | null;
      const failed = (body?.servers ?? []).filter((s) => !s.ok).length;
      setCheckNote(failed > 0 ? t("adminManage.neverWatched.checkedSomeFailed", { count: failed }) : t("adminManage.neverWatched.checked"));
      await reload(true);
    } catch {
      setError(t("adminManage.neverWatched.error.checkNetwork"));
    } finally {
      setChecking(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.neverWatched.loading")}
      </div>
    );
  }
  if (!data) {
    return <p role="alert" style={{ color: "var(--ds-danger)", fontSize: 13 }}>{error || t("adminManage.neverWatched.error.load")}</p>;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / limit));
  const selectedList = [...selected.values()];
  const selectedBytes = selectedList.reduce((n, s) => n + (s.sizeOnDisk ?? 0), 0);
  const unchecked = data.coverage.filter((c) => c.upstream.health !== "ok");

  const sortHead = (k: NwSortKey, label: string, align?: "right") => {
    const active = sortBy === k;
    const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th key={k} style={{ ...th, textAlign: align ?? "left" }} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => sortOn(k)}
          className="inline-flex items-center gap-1 hover:text-zinc-100"
          style={{ font: "inherit", color: active ? "var(--ds-fg)" : "inherit" }}
        >
          {label}
          <Icon style={{ width: 11, height: 11, opacity: active ? 1 : 0.5 }} />
        </button>
      </th>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <StatCard
          label={t("adminManage.neverWatched.stat.titles")}
          value={num.format(data.totals.never.titles)}
          hint={t("adminManage.neverWatched.stat.titlesHint", { size: formatBytes(data.totals.never.bytes), count: data.totals.never.unsized })}
        />
        <StatCard
          label={t("adminManage.neverWatched.stat.seasons")}
          value={num.format(data.totals.seasons.count)}
          hint={t("adminManage.neverWatched.stat.seasonsHint", { size: formatBytes(data.totals.seasons.bytes) })}
        />
        <StatCard
          label={t("adminManage.neverWatched.stat.eligible")}
          value={data.cleanupEnabled ? num.format(data.totals.eligible.titles) : "—"}
          hint={data.cleanupEnabled
            ? t("adminManage.neverWatched.stat.eligibleHint", { size: formatBytes(data.totals.eligible.bytes) })
            : t("adminManage.neverWatched.stat.eligibleOff")}
        />
        <StatCard
          label={t("adminManage.neverWatched.stat.unknown")}
          value={num.format(data.totals.unknown + data.totals.possible)}
          hint={t("adminManage.neverWatched.stat.unknownHint", { unknown: data.totals.unknown, possible: data.totals.possible })}
        />
      </div>

      {/* ── how far the claim can be trusted, per server ────────────────── */}
      <section className="flex flex-col gap-2" style={panel} aria-labelledby="nw-coverage">
        <div id="nw-coverage" className="-mb-3">
          <SectionHeader
            title={t("adminManage.neverWatched.coverage.title")}
            right={
              <Button size="sm" variant="outline" onClick={() => void checkUpstream()} disabled={checking}>
                {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("adminManage.neverWatched.coverage.checkNow")}
              </Button>
            }
          />
        </div>
        <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>{t("adminManage.neverWatched.coverage.help")}</p>
        {data.coverage.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ds-fg-muted)", margin: 0 }}>{t("adminManage.neverWatched.coverage.none")}</p>
        ) : (
          <ul className="flex flex-col gap-1" style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 13 }}>
            {data.coverage.map((c) => {
              const u = c.upstream;
              const pct = u.samples > 0 ? Math.round((u.agreed / u.samples) * 100) : null;
              return (
                <li key={c.server} className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: "var(--ds-fg)" }}>
                  <span className="ds-mono" style={{ minWidth: 120, fontWeight: 600 }}>{c.server}</span>
                  <span style={{ color: "var(--ds-fg-muted)" }}>
                    {!c.tracked
                      ? t("adminManage.neverWatched.coverage.untracked")
                      : c.since
                        ? t("adminManage.neverWatched.coverage.since", { date: day(c.since) })
                        : t("adminManage.neverWatched.coverage.noHistory")}
                  </span>
                  <Chip tone={u.health === "ok" ? "approved" : u.health === "never" ? "neutral" : "declined"}>
                    {t(HEALTH_KEYS[u.health], {
                      date: day(u.fetchedAt),
                      pct: pct ?? 0,
                      agreed: u.agreed,
                      samples: u.samples,
                    })}
                  </Chip>
                  {u.health === "failed" && u.error ? (
                    <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{u.error}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {checkNote && <p role="status" style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: 0 }}>{checkNote}</p>}
      </section>

      {!data.trackingOn && (
        <p role="status" className={bannerClass("warn")} style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.neverWatched.banner.trackingOff")}
        </p>
      )}
      {data.unplacedPlays > 0 && (
        <p role="status" className={bannerClass("info")} style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.neverWatched.banner.unplaced", { count: data.unplacedPlays })}
        </p>
      )}
      {data.cleanupEnabled && data.requireUpstreamCheck && unchecked.length > 0 && (
        <p role="status" className={bannerClass("warn")} style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.neverWatched.banner.unchecked", { list: unchecked.map((c) => c.server).join(", ") })}
        </p>
      )}
      {data.arrErrors.length > 0 && (
        <p role="status" className={bannerClass("warn")} style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.cleanup.arrErrors", { list: data.arrErrors.map((e) => arrInstanceLabel(e.service, e.instance)).join(", ") })}
        </p>
      )}
      {!data.cleanupEnabled && (
        <p role="status" className={bannerClass("info")} style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.neverWatched.banner.cleanupOff")}
        </p>
      )}

      {/* ── tabs + filters ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <FilterBar<NwLevel>
          className="mb-0"
          segments={[
            { value: "title", label: t("adminManage.neverWatched.tab.titles") },
            { value: "season", label: t("adminManage.neverWatched.tab.seasons") },
          ]}
          active={level}
          onChange={(v) => {
            setLevel(v);
            setPage(1);
          }}
        />
        <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 13 }}>
          <StyledSelect
            compact
            className="w-auto"
            value={stateFilter}
            onChange={(e) => {
              setStateFilter(e.target.value as NwStateFilter);
              setPage(1);
            }}
            aria-label={t("adminManage.neverWatched.filter.state")}
          >
            {(Object.keys(FILTER_KEYS) as NwStateFilter[]).map((f) => (
              <option key={f} value={f}>{t(FILTER_KEYS[f])}</option>
            ))}
          </StyledSelect>
          {level === "title" && (
            <StyledSelect
              compact
              className="w-auto"
              value={type}
              onChange={(e) => {
                setType(e.target.value as typeof type);
                setPage(1);
              }}
              aria-label={t("adminManage.cleanup.filter.mediaType")}
            >
              <option value="all">{t("adminManage.cleanup.filter.moviesAndTv")}</option>
              <option value="movie">{t("nav.movies")}</option>
              <option value="tv">{t("adminManage.cleanup.tv")}</option>
            </StyledSelect>
          )}
          {level === "title" && data.cleanupEnabled && (
            <label className="inline-flex items-center gap-1.5" style={{ color: "var(--ds-fg)" }}>
              <input
                type="checkbox"
                checked={eligibleOnly}
                onChange={(e) => {
                  setEligibleOnly(e.target.checked);
                  setPage(1);
                }}
              />
              {t("adminManage.neverWatched.filter.eligibleOnly")}
            </label>
          )}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 100))}
            placeholder={t("adminManage.cleanup.filter.titlePlaceholder")}
            aria-label={t("adminManage.cleanup.filter.title")}
            className="w-[200px]"
          />
          {loading && <Loader2 className="animate-spin" style={{ width: 14, height: 14, color: "var(--ds-fg-subtle)" }} />}
          <div className="flex-1" />
          {data.cleanupEnabled && level === "title" && (
            <Button size="sm" variant="destructive" onClick={() => void del.dryRun()} disabled={selected.size === 0 || del.planning || del.executing}>
              {del.planning ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {selected.size > 0
                ? t("adminManage.cleanup.deleteSelectedSize", { count: selected.size, size: formatBytes(selectedBytes) })
                : t("adminManage.cleanup.deleteSelected", { count: 0 })}
            </Button>
          )}
        </div>
      </div>

      {(error || del.error) && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error || del.error}</p>}

      <CleanupPlanPanel del={del} formatBytes={formatBytes} />
      <CleanupResultPanel result={del.result} />

      {/* ── table ──────────────────────────────────────────────────────── */}
      {data.rows.length === 0 ? (
        <EmptyState
          icon={EyeOff}
          title={
            !data.trackingOn
              ? t("adminManage.neverWatched.empty.trackingOffTitle")
              : data.historyStart === null
                ? t("adminManage.neverWatched.empty.noHistoryTitle")
                : t("adminManage.neverWatched.empty.title")
          }
          description={
            !data.trackingOn
              ? t("adminManage.neverWatched.empty.trackingOffDescription")
              : data.historyStart === null
                ? t("adminManage.neverWatched.empty.noHistoryDescription")
                : t("adminManage.neverWatched.empty.description")
          }
        />
      ) : level === "title" ? (
        <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
          <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
            <thead>
              <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>
                {data.cleanupEnabled && (
                  <th style={{ ...th, width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label={t("adminManage.cleanup.selectAll")}
                      checked={selectableOnPage.length > 0 && selectableOnPage.every((r) => selected.has(cleanupKeyOf(r)))}
                      onChange={toggleAllOnPage}
                      disabled={selectableOnPage.length === 0}
                    />
                  </th>
                )}
                {sortHead("title", t("adminManage.cleanup.col.title"))}
                <th style={th}>{t("adminManage.cleanup.col.on")}</th>
                {sortHead("added", t("adminManage.cleanup.col.added"))}
                {sortHead("since", t("adminManage.neverWatched.col.since"))}
                {sortHead("days", t("adminManage.neverWatched.col.days"), "right")}
                {sortHead("size", t("adminManage.cleanup.col.size"), "right")}
                <th style={th}>{t("adminManage.neverWatched.col.status")}</th>
                {data.cleanupEnabled && <th style={th} />}
              </tr>
            </thead>
            <tbody>
              {titleRows.map((r) => (
                <TitleRow
                  key={cleanupKeyOf(r)}
                  r={r}
                  cleanupEnabled={data.cleanupEnabled}
                  checked={selected.has(cleanupKeyOf(r))}
                  onToggle={() => toggle(r)}
                  busy={busyKey === cleanupKeyOf(r)}
                  onProtect={(on) => void setProtected(r, on)}
                  day={day}
                  formatBytes={formatBytes}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
          <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
            <thead>
              <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>
                {sortHead("title", t("adminManage.neverWatched.col.season"))}
                <th style={th}>{t("adminManage.cleanup.col.on")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("adminManage.neverWatched.col.episodes")}</th>
                {sortHead("since", t("adminManage.neverWatched.col.since"))}
                {sortHead("days", t("adminManage.neverWatched.col.days"), "right")}
                {sortHead("size", t("adminManage.cleanup.col.size"), "right")}
                <th style={th}>{t("adminManage.neverWatched.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {(data.rows as NwSeasonRow[]).map((r) => (
                <SeasonRow key={`${r.tmdbId}:${r.seasonNumber}`} r={r} day={day} formatBytes={formatBytes} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.total > 0 && (
        <HistoryPagination
          page={page}
          setPage={(p) => setPage(Math.min(Math.max(1, p), totalPages))}
          limit={limit}
          setLimit={(n) => {
            setLimit(n);
            setPage(1);
          }}
          total={data.total}
          totalPages={totalPages}
        />
      )}

      <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
        {t("adminManage.neverWatched.footnote")}
        {data.sizesAsOf ? ` ${t("adminManage.neverWatched.sizesAsOf", { date: day(data.sizesAsOf) })}` : ""}
      </p>
    </div>
  );
}

function StateChips({ r }: { r: NwTitleRow | NwSeasonRow }) {
  const t = useT();
  const never = r.state === "neverWatched" || r.state === "noPlaysSince";
  // Both "never" states read "Never watched"; the since column says whether the
  // title predates recording, and the tooltip spells the state out.
  return (
    <Chip
      tone={never ? "accent" : r.state === "possiblyWatched" ? "pending" : "neutral"}
      className="whitespace-nowrap"
      title={t(STATE_KEYS[r.state])}
    >
      {t(never ? STATE_KEYS.neverWatched : STATE_KEYS[r.state])}
    </Chip>
  );
}

function SinceCell({ r, day }: { r: NwTitleRow | NwSeasonRow; day: (iso: string | null) => string }) {
  const t = useT();
  if (r.state === "unobservable") {
    return (
      <span style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
        {r.reason ? t(REASON_KEYS[r.reason], { list: r.reasonServers.join(", ") }) : "—"}
      </span>
    );
  }
  return (
    <div>
      <div className="ds-mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{day(r.windowStart)}</div>
      {!r.fullyObserved && r.kind === "title" && r.shelfStart ? (
        <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t("adminManage.neverWatched.onShelfSince", { date: day(r.shelfStart) })}</div>
      ) : null}
      {r.kind === "title" && r.state === "possiblyWatched" ? (
        <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
          {t("adminManage.neverWatched.softPlays", { count: r.softPlays, list: r.softServers.join(", ") })}
        </div>
      ) : null}
    </div>
  );
}

function TitleRow({
  r, cleanupEnabled, checked, onToggle, busy, onProtect, day, formatBytes,
}: {
  r: NwTitleRow;
  cleanupEnabled: boolean;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  onProtect: (on: boolean) => void;
  day: (iso: string | null) => string;
  formatBytes: (n: number | null) => string;
}) {
  const t = useT();
  const href = r.mediaType === "MOVIE" ? `/movie/${r.tmdbId}` : `/tv/${r.tmdbId}`;
  const never = r.state === "neverWatched" || r.state === "noPlaysSince";
  const noRule = cleanupEnabled && never && r.cleanup.matched.length === 0;
  return (
    <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
      {cleanupEnabled && (
        <td style={td}>
          <input
            type="checkbox"
            aria-label={t("adminManage.cleanup.select", { title: r.title })}
            checked={checked}
            disabled={!r.eligible}
            title={r.eligible ? undefined : t("adminManage.neverWatched.notEligible")}
            onChange={onToggle}
          />
        </td>
      )}
      <td style={td}>
        <div className="flex items-center gap-2">
          <Poster src={posterUrl(r.posterPath)} letter={(r.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
          <div>
            <Link href={href} className="hover:underline" style={{ fontWeight: 500, color: "var(--ds-fg)" }}>
              {r.title}
            </Link>
            {r.year ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.year})</span> : null}
            <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
              {r.mediaType === "MOVIE" ? t("adminManage.cleanup.movie") : t("adminManage.cleanup.tv")}
            </div>
          </div>
        </div>
      </td>
      <td style={{ ...td, fontSize: 11, color: "var(--ds-fg-muted)" }}>
        <div>{r.servers.join(", ")}</div>
        <div style={{ color: "var(--ds-fg-subtle)" }}>
          {r.arr.length > 0 ? r.arr.map((a) => arrInstanceLabel(a.service, a.instance)).join(", ") : t("adminManage.cleanup.notInArr")}
        </div>
      </td>
      <td className="ds-mono" style={tdMono}>{day(r.shelfStart ?? r.addedAt)}</td>
      <td style={td}><SinceCell r={r} day={day} /></td>
      <td className="ds-mono" style={{ ...tdMono, textAlign: "right" }}>{r.days ?? "—"}</td>
      <td className="ds-mono" style={{ ...tdMono, textAlign: "right" }}>{formatBytes(r.sizeOnDisk)}</td>
      <td style={td}>
        <div className="flex flex-wrap gap-1">
          <StateChips r={r} />
          {r.eligible && <Chip tone="approved">{t("adminManage.neverWatched.eligible")}</Chip>}
          {noRule && <Chip>{t("adminManage.neverWatched.noRule")}</Chip>}
          {cleanupEnabled && r.cleanup.excludedBy.map((x) => (
            <span key={x} className="rounded bg-sky-500/15 text-sky-400" style={{ padding: "1px 6px", fontSize: 11 }}>
              {t(`adminManage.cleanup.exclusionLabel.${x}`)}
            </span>
          ))}
        </div>
      </td>
      {cleanupEnabled && (
        <td style={{ ...td, textAlign: "right" }}>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onProtect(!r.protected)}
            disabled={busy}
            aria-label={r.protected ? t("adminManage.cleanup.unprotectTitle", { title: r.title }) : t("adminManage.cleanup.protectTitle", { title: r.title })}
          >
            {busy ? <Loader2 className="animate-spin" /> : r.protected ? <ShieldOff /> : <Shield />}
            {r.protected ? t("adminManage.cleanup.unprotect") : t("adminManage.cleanup.protect")}
          </Button>
        </td>
      )}
    </tr>
  );
}

function SeasonRow({ r, day, formatBytes }: { r: NwSeasonRow; day: (iso: string | null) => string; formatBytes: (n: number | null) => string }) {
  const t = useT();
  return (
    <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
      <td style={td}>
        <div className="flex items-center gap-2">
          <Poster src={posterUrl(r.posterPath)} letter={(r.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
          <div>
            <Link href={`/tv/${r.tmdbId}`} className="hover:underline" style={{ fontWeight: 500, color: "var(--ds-fg)" }}>
              {r.title}
            </Link>
            <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t("adminManage.neverWatched.seasonN", { n: r.seasonNumber })}</div>
          </div>
        </div>
      </td>
      <td style={{ ...td, fontSize: 11, color: "var(--ds-fg-muted)" }}>{r.servers.join(", ")}</td>
      <td className="ds-mono" style={{ ...tdMono, textAlign: "right" }}>{r.episodes}</td>
      <td style={td}><SinceCell r={r} day={day} /></td>
      <td className="ds-mono" style={{ ...tdMono, textAlign: "right" }}>{r.days ?? "—"}</td>
      <td className="ds-mono" style={{ ...tdMono, textAlign: "right" }} title={r.sizeMismatch ? t("adminManage.neverWatched.sizeMismatchHint") : undefined}>
        {r.sizeMismatch ? t("adminManage.neverWatched.sizeMismatch") : formatBytes(r.sizeOnDisk)}
      </td>
      <td style={td}>
        <div className="flex flex-wrap gap-1">
          <StateChips r={r} />
          {r.airing && <Chip tone="pending">{t("adminManage.neverWatched.airing")}</Chip>}
        </div>
      </td>
    </tr>
  );
}
