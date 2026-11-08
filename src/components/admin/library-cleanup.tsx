"use client";

// Admin → Library cleanup. Loads the report on mount (it makes live Radarr/Sonarr
// calls, so it is never part of the server render), lets the admin tune the
// rules, protect titles, and delete a selection through the route's two-step
// dry run → confirmed execute. Every date shown is a server-supplied ISO string
// formatted for the viewer's locale (the report arrives after mount, so there is
// no SSR/hydration pair to disagree), and "idle" is a server-computed day count
// — nothing here reads the clock while rendering (guardrail 16).
//
// This file holds the state and the requests; library-cleanup-parts.tsx draws
// the pieces, and library-cleanup-report.ts checks the report's shape.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { applyLocalProtection, createCoalescedReload, nextCleanupDraft } from "@/lib/cleanup-delete-plan";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/design";
import { FileX, Loader2, RefreshCw } from "@/components/icons";
import {
  CleanupPlanPanel,
  CleanupResultPanel,
  arrSlugLabel as instanceLabel,
  cleanupKeyOf as keyOf,
  dayFormatter,
  formatBytesIn,
  useCleanupDelete,
} from "@/components/admin/cleanup-delete";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import {
  CLEANUP_MAX_ITEMS,
  CLEANUP_NUMERIC_BOUNDS,
  toggleAllCleanupSelection,
  toggleCleanupSelection,
  type CleanupSettings,
} from "@/lib/library-cleanup";
import {
  CLEANUP_VIEW_DEFAULTS,
  cleanupArrKey,
  defaultCleanupSortDir,
  filterCleanupRows,
  serializeCleanupView,
  sortCleanupRows,
  type CleanupSortKey,
  type CleanupViewState,
} from "@/lib/library-cleanup-view";
import { CleanupReportSchema, parseRuleNumber, selectedOutsideView, type CleanupReportView } from "./library-cleanup-report";
import { CleanupBanners, CleanupFilterBar, CleanupStats, CleanupTable, ProtectedList, RulesPanel } from "./library-cleanup-parts";

type Report = CleanupReportView;

// Rows the table renders at once. Each row is a poster, dates, chips and
// buttons, and a broad rule can match thousands of titles; every tick, busy
// change or filter keystroke re-rendered all of them. The cap is the selection
// cap (one delete's worth). Select-all, the selection and the counts still read
// the whole filtered, sorted view — only the rows drawn are capped.
const RENDER_CAP = CLEANUP_MAX_ITEMS;

// The URL follows the view this long after the last change: typing in the
// title filter changed it per keystroke, and Safari throws (SecurityError,
// into the page's error boundary) past ~100 history calls in a short window.
const URL_SYNC_DELAY_MS = 300;

// A filtered view survives a reload and can be shared (house style: URL state).
function useViewInUrl(vs: CleanupViewState) {
  useEffect(() => {
    const timer = setTimeout(() => {
      const qs = serializeCleanupView(vs);
      try {
        window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
      } catch {
        // The browser refused (its history rate limit): the URL just lags.
      }
    }, URL_SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [vs]);
}

export function LibraryCleanup({ initialView = CLEANUP_VIEW_DEFAULTS }: { initialView?: CleanupViewState }) {
  const t = useT();
  const locale = useLocale();
  const day = useMemo(() => dayFormatter(locale), [locale]);
  const formatBytes = useCallback((n: number | null) => formatBytesIn(n, locale), [locale]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  // Two error slots: a load clears only its own, so a background reload (the
  // one a Protect schedules seconds later) never wipes an action's failure.
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [draft, setDraft] = useState<CleanupSettings | null>(null);
  const [savingRules, setSavingRules] = useState(false);
  // Every filter and the sort, in one object that round-trips through the URL.
  const [vs, setVs] = useState<CleanupViewState>(initialView);
  const patchView = (p: Partial<CleanupViewState>) => setVs((prev) => ({ ...prev, ...p }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // One entry per Protect/Unprotect in flight (a single key let a second
  // row's click re-enable the first row's button mid-request).
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  // Protect/unprotect, a rules save and a delete each reload the report, and
  // two can overlap: only the newest load's answer is shown (an older one
  // landing last would put back a title's pre-protect state).
  const loadSeq = useRef(0);
  // The settings the draft was taken from — what "unsaved edits" are judged
  // against. A rules save moves it to the saved draft at once (saveRules).
  const draftBase = useRef<CleanupSettings | null>(null);
  // The one reload a burst of Protect / Unprotect clicks shares.
  const [protectReload] = useState(() => createCoalescedReload());

  const load = useCallback(async (opts?: { resetDraft?: boolean }) => {
    const seq = ++loadSeq.current;
    // Any load answers for the clicks a pending coalesced reload was waiting on.
    protectReload.cancel();
    setLoading(true);
    setLoadError("");
    // No client-side timeout: the report reads every Radarr/Sonarr instance
    // live, each under its own server-side limit.
    const res = await fetchJson(withBasePath("/api/admin/cleanup"), {
      schema: CleanupReportSchema,
      timeoutMs: Infinity,
      fallbackError: t("adminManage.cleanup.error.load"),
    });
    if (seq !== loadSeq.current) return;
    setLoading(false);
    if (!res.ok) {
      // The route's own reason; a body of another shape reads as "couldn't load".
      setLoadError(res.kind === "network" ? t("adminManage.cleanup.error.loadNetwork") : res.error);
      return;
    }
    const data = res.data;
    setReport(data);
    // A reload keeps the admin's unsaved rule edits; only their own save
    // (or an unedited draft) takes the fresh settings. The reset belongs to
    // THIS load: superseded, it dies with it rather than staying armed to
    // discard edits made since.
    const base = draftBase.current;
    const reset = opts?.resetDraft === true;
    const fresh: CleanupSettings = data.settings;
    draftBase.current = fresh;
    setDraft((d) => nextCleanupDraft(d, base, data.settings, reset));
    // Drop selections that are no longer deletable candidates.
    const live = new Set(data.rows.filter((r) => r.candidate).map(keyOf));
    setSelected((prev) => new Set([...prev].filter((k) => live.has(k))));
  }, [t, protectReload]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => protectReload.cancel(), [protectReload]);

  useViewInUrl(vs);

  // The table follows the view a step behind the controls, so typing in the
  // title filter stays responsive over a whole library's rows.
  const viewForRows = useDeferredValue(vs);
  const visible = useMemo(
    () => (report ? sortCleanupRows(filterCleanupRows(report.rows, viewForRows), viewForRows.sort, viewForRows.dir) : []),
    [report, viewForRows],
  );
  // The servers and Radarr/Sonarr instances that occur in this report.
  const serverOptions = useMemo(() => [...new Set((report?.rows ?? []).flatMap((r) => r.servers))].sort(), [report]);
  const arrOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of report?.rows ?? []) for (const a of r.arr) m.set(cleanupArrKey(a.service, a.instance), instanceLabel(a.service, a.instance));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [report]);

  function sortOn(key: CleanupSortKey) {
    setVs((prev) =>
      prev.sort === key
        ? { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { ...prev, sort: key, dir: defaultCleanupSortDir(key) },
    );
  }

  const selectableVisible = useMemo(() => visible.filter((r) => r.candidate && r.arr.length > 0), [visible]);
  const selectedRows = useMemo(() => (report ? report.rows.filter((r) => selected.has(keyOf(r))) : []), [report, selected]);
  const selectedBytes = useMemo(() => selectedRows.reduce((n, r) => n + (r.sizeOnDisk ?? 0), 0), [selectedRows]);
  // A selection the filters now hide is still deleted: the bar says how much of it.
  const hiddenSelected = useMemo(() => selectedOutsideView(selected, new Set(visible.map(keyOf))), [selected, visible]);
  const del = useCleanupDelete({
    items: () => selectedRows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })),
    onDeleted: async () => {
      setSelected(new Set());
      await load();
    },
  });

  // The selection never grows past what one delete takes (CLEANUP_MAX_ITEMS,
  // the route's own cap): select-all on a large view ticks the first ones in
  // the view's order, and the page says the rest wait for the next delete.
  const selectableKeys = useMemo(() => selectableVisible.map(keyOf), [selectableVisible]);
  const selectionFull = selected.size >= CLEANUP_MAX_ITEMS;

  function toggle(k: string) {
    del.clearPlan();
    setSelected((prev) => toggleCleanupSelection(prev, k));
  }

  function toggleAllVisible() {
    del.clearPlan();
    setSelected((prev) => toggleAllCleanupSelection(prev, selectableKeys));
  }

  async function saveRules() {
    if (!draft) return;
    setSavingRules(true);
    setActionError("");
    try {
      const res = await fetchJson(withBasePath("/api/admin/cleanup/settings"), {
        init: jsonInit("PATCH", draft),
        fallbackError: t("adminManage.cleanup.error.save"),
      });
      // A 2xx whose body isn't JSON still saved.
      if (!res.ok && res.kind !== "invalid") {
        setActionError(res.kind === "network" || res.kind === "timeout" ? t("adminManage.cleanup.error.saveNetwork") : res.error);
        return;
      }
      // Saved: these ARE the settings now. Installed before the reload, so Save
      // reads clean even when a Protect supersedes that reload's answer.
      draftBase.current = draft;
      setReport((r) => (r ? { ...r, settings: draft } : r));
      del.clearPlan();
      await load({ resetDraft: true });
    } finally {
      setSavingRules(false);
    }
  }

  async function setProtected(row: { tmdbId: number; mediaType: "MOVIE" | "TV"; title: string | null }, on: boolean) {
    const k = keyOf(row);
    setBusyKeys((prev) => new Set(prev).add(k));
    setActionError("");
    try {
      const res = on
        ? await fetchJson(withBasePath("/api/admin/cleanup/protect"), {
            init: jsonInit("POST", { tmdbId: row.tmdbId, mediaType: row.mediaType, ...(row.title ? { title: row.title.slice(0, 500) } : {}) }),
            fallbackError: t("adminManage.cleanup.error.protect"),
          })
        : await fetchJson(withBasePath(`/api/admin/cleanup/protect?tmdbId=${row.tmdbId}&mediaType=${row.mediaType}`), {
            init: { method: "DELETE" },
            fallbackError: t("adminManage.cleanup.error.unprotect"),
          });
      // A 2xx whose body isn't JSON (a 204) still went through.
      if (!res.ok && res.kind !== "invalid") {
        setActionError(res.kind === "network" || res.kind === "timeout" ? t("adminManage.cleanup.error.network") : res.error);
        return;
      }
      del.clearPlan();
      // Shown at once, reloaded once the clicks stop: one report GET per burst,
      // not per click (the GET allows 30 a minute — createCoalescedReload). A
      // load already in flight read the pre-click state, so it is superseded.
      loadSeq.current++;
      setReport((r) => (r ? applyLocalProtection(r, row, on, new Date().toISOString()) : r));
      if (on) {
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
      protectReload.schedule(() => void load());
    } finally {
      // Only this row's entry: another row's request may still be running.
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(k);
        return next;
      });
    }
  }
  const isBusy = (k: string) => busyKeys.has(k);

  if (loading && !report) {
    return (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.cleanup.judging")}
      </div>
    );
  }
  if (!report || !draft) {
    // Nothing else on the page can reload it — the coalesced reload only arms
    // after a Protect, which needs the table.
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" style={{ color: "var(--ds-danger)", fontSize: 13, margin: 0 }}>{loadError || t("adminManage.cleanup.error.load")}</p>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("adminManage.common.retry")}
        </Button>
      </div>
    );
  }

  const anyRuleOn = report.settings.unwatchedEnabled || report.settings.neverWatchedEnabled || report.settings.votesEnabled;
  const setNum = (field: keyof typeof CLEANUP_NUMERIC_BOUNDS, v: string) =>
    setDraft((d) => (d ? { ...d, [field]: parseRuleNumber(v) } : d));
  const setBool = (field: "unwatchedEnabled" | "neverWatchedEnabled" | "votesEnabled" | "excludeAiring" | "requireUpstreamCheck", v: boolean) =>
    setDraft((d) => (d ? { ...d, [field]: v } : d));
  const shown = visible.slice(0, RENDER_CAP);
  const protectedTotal = Math.max(report.protectedTotal ?? 0, report.protected.length);

  return (
    <div className="flex flex-col gap-6">
      <CleanupStats report={report} formatBytes={formatBytes} />
      <CleanupBanners report={report} />

      {/* ── rules ───────────────────────────────────────────────────── */}
      <RulesPanel
        draft={draft}
        settings={report.settings}
        historyStart={report.historyStart}
        savingRules={savingRules}
        day={day}
        onNumber={setNum}
        onToggle={setBool}
        onSave={() => void saveRules()}
      />

      {/* ── filters + sort + bulk action ────────────────────────────── */}
      <CleanupFilterBar
        vs={vs}
        patchView={patchView}
        resetFilters={() => setVs({ ...CLEANUP_VIEW_DEFAULTS, sort: vs.sort, dir: vs.dir })}
        serverOptions={serverOptions}
        arrOptions={arrOptions}
        shownCount={visible.length}
        totalCount={report.rows.length}
        selectedCount={selectedRows.length}
        selectedSize={formatBytes(selectedBytes)}
        hiddenSelected={hiddenSelected}
        del={del}
      />

      {[loadError, actionError, del.error].filter((m) => m !== "").map((m, i) => (
        <p key={i} role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{m}</p>
      ))}
      {selectionFull && (
        <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>{t("adminManage.cleanup.selectionFull", { max: CLEANUP_MAX_ITEMS })}</p>
      )}

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
        <CleanupTable
          shown={shown}
          selected={selected}
          selectableKeys={selectableKeys}
          selectionFull={selectionFull}
          sort={vs.sort}
          dir={vs.dir}
          onSort={sortOn}
          onToggle={toggle}
          onToggleAll={toggleAllVisible}
          isBusy={isBusy}
          onProtect={(r, on) => void setProtected(r, on)}
          day={day}
          formatBytes={formatBytes}
        />
      )}
      {visible.length > shown.length && (
        <p role="status" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
          {t("adminManage.cleanup.renderCap", { cap: shown.length, total: visible.length })}
        </p>
      )}

      {/* ── protected titles ───────────────────────────────────────── */}
      <ProtectedList titles={report.protected} total={protectedTotal} isBusy={isBusy} onUnprotect={(p) => void setProtected(p, false)} day={day} />
    </div>
  );
}
