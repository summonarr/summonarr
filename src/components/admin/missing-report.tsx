"use client";

// Admin → Missing. One tab per service and two modes: MISSING (no file, should
// have one) and CUTOFF UNMET (a file below the quality profile's cutoff —
// Radarr/Sonarr's own /wanted/cutoff). Each (service, mode) loads its report on
// first view (it makes live Radarr/Sonarr calls, so it is never part of the
// server render) and keeps it until Refresh. A Sonarr row expands to its
// episodes — fetched on demand for Missing, already in the listing for Cutoff —
// and every row's Search queues a Radarr/Sonarr search for exactly that title's
// gap (POST /api/admin/missing/search, `mode` picking which). The tables show
// PAGE_SIZE rows at a time; a tick survives a page turn and counts toward the
// bulk cap wherever it is. Every date is a
// server-supplied ISO string formatted for the viewer's locale, and "missing
// for" is a server-computed day count — nothing here reads the clock while
// rendering (guardrail 16).
//
// "Instant, then live" (use-arr-snapshot.ts): until a list holds a live answer,
// the page paints the last one the server kept for the same read — marked with
// when it was read — while the live load is out, then swaps the live answer in.
// A row painted from the snapshot acts through the same routes, which re-judge
// it live. Episode expansion stays live: rows expand independently and the
// hook follows one read per view.
//
// The lists' reads and their snapshots live in use-missing-reports.ts, the
// rows' searches and "Search selected" in use-bulk-search.ts, the pieces
// around the list (stats, notices, filters, bulk bar) in
// missing-report-parts.tsx and the pure rules in missing-report-rules.ts.
// This file is the view: the state, paging, and the one table every list
// renders through (each list's own columns as data).

import { Fragment, useCallback, useDeferredValue, useMemo, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { EmptyState, FilterBar } from "@/components/ui/design";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { ReportTable } from "@/components/admin/report-table";
import { useMissingReports, type Mode, type ReportKey, type Service } from "@/components/admin/use-missing-reports";
import { rowKey, useBulkSearch, useBulkSelection, type BulkRow } from "@/components/admin/use-bulk-search";
import { useAsyncAction } from "@/hooks/use-async-action";
import { fetchJson } from "@/lib/client/fetch-json";
import { missingDateFormatters } from "@/components/admin/missing-format";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Loader2, RefreshCw } from "@/components/icons";
import type { MissingSeries } from "@/lib/arr-missing";
import {
  applyFilters,
  MissingEpisodesAnswer,
  modeOf,
  serviceOf,
  shownInstance,
  sortMovies,
  sortSeries,
  unmonitoredCount,
  type Filters,
  type MovieSort,
  type SeriesSort,
} from "@/components/admin/missing-report-rules";
import {
  EpisodeLines,
  MissingBulkBar,
  MissingBulkConfirmDialog,
  MissingEpisodesDetail,
  MissingExpanderCell,
  MissingFilterRow,
  MissingModeToggle,
  MissingReportNotices,
  MissingSearchCell,
  MissingSelectCell,
  MissingStats,
  MissingTitleCell,
  OtherListRunning,
  SERVICE_LABEL,
  td,
  th,
  type EpisodeState,
} from "@/components/admin/missing-report-parts";

// Rows rendered per page. A cutoff listing can be library-sized (Radarr's is a
// row per movie), and every row carries a poster, links and a title manager —
// the whole list re-rendered on each keystroke and each bulk-run settle.
const PAGE_SIZE = 100;
const SONARR_STATUSES = new Set(["continuing", "ended", "upcoming", "deleted"]);


// A row of any list: what the shared lead (tick box, title, instance) and the
// row's Search read.
type ListRow = BulkRow & { year: number | null; posterPath: string | null; tmdbId: number | null };
// One of a list's own columns, as data: its header and each row's cell.
// `small` and `mono` are the cell's look; `right` aligns header and cell.
type Column<R> = { head: string; cell: (r: R) => React.ReactNode; small?: boolean; mono?: boolean; right?: boolean };
// A Sonarr list's rows expand: `toggle` opens or closes one, `detail` is what
// an open one shows. `k` is the row's key, `${reportKey}|${instance}:${arrId}`.
type Expand<R> = { cutoff: boolean; toggle: (r: R, k: string) => void; detail: (r: R, k: string) => React.ReactNode };

export function MissingReport({
  initialService,
  initialMode,
  configured,
}: {
  initialService: Service;
  initialMode: Mode;
  configured: Record<Service, boolean>;
}) {
  const t = useT();
  const locale = useLocale();
  // A release date by its UTC day, an air time in the viewer's own zone (missing-format.ts).
  const { day, aired } = useMemo(() => missingDateFormatters(locale), [locale]);
  const [service, setService] = useState<Service>(initialService);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [query, setQuery] = useState("");
  const [instance, setInstance] = useState("all");
  const [showUnmonitored, setShowUnmonitored] = useState(false);
  const [movieSort, setMovieSort] = useState<MovieSort>("recent");
  const [seriesSort, setSeriesSort] = useState<SeriesSort>("recent");
  // The filters read the query a beat behind the input, so typing stays
  // responsive over a long listing.
  const deferredQuery = useDeferredValue(query);
  // The page on screen, for the view (list, filters, order) it was turned in —
  // any other view starts again at its first page.
  const [pageView, setPageView] = useState<{ view: string; page: number }>({ view: "", page: 0 });
  // Keyed `${reportKey}|${instance}:${arrId}` — the two modes list the same series.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [episodes, setEpisodes] = useState<Record<string, EpisodeState>>({});

  // An expanded series' episode read, per row; a Refresh of its list drops it.
  const episodeLoads = useAsyncAction();

  const run = useBulkSearch();
  const { searches, selected, bulk, bulkPending, confirming, setConfirming, isBulkRunning, listIdle, resetList, startSearch, cancelBulk } = run;
  // A Refresh's fresh start for one list: its rows' searches and ticks
  // (resetList), and every expanded episode list — those belong to the old
  // listing, and so does a read of one still out.
  const resetRows = useCallback((k: ReportKey) => {
    resetList(k);
    if (k === "sonarr:missing") episodeLoads.abort();
    setExpanded((prev) => new Set([...prev].filter((key) => !key.startsWith(`${k}|`))));
    setEpisodes((s) => Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith(`${k}|`))));
  }, [resetList, episodeLoads]);
  const { current, reports, errors, loadingKeys, loadingHere, load, staleAt } = useMissingReports({
    service,
    mode,
    configured,
    listIdle,
    onLiveReplaced: resetRows,
  });

  // Keep the tab and mode in the URL so a reload or a shared link lands on
  // them. The native History API is synced with Next's router and does not
  // re-render the server page.
  function syncUrl(svc: Service, m: Mode) {
    window.history.replaceState(null, "", `?service=${svc}${m === "cutoff" ? "&mode=cutoff" : ""}`);
  }

  function switchTab(next: Service) {
    if (next === service) return;
    setService(next);
    setInstance("all");
    syncUrl(next, mode);
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    syncUrl(service, next);
  }

  function toggleExpanded(k: string): boolean {
    const open = expanded.has(k);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(k);
      else next.add(k);
      return next;
    });
    return open;
  }

  // Opening a missing series reads its episodes once (again after a failure).
  // The read is checked against its shape; a second click while it is out
  // starts nothing, and a Refresh of the list drops it (resetRows).
  async function toggleMissingSeries(row: MissingSeries) {
    const k = `sonarr:missing|${rowKey(row)}`;
    const wasOpen = toggleExpanded(k);
    if (wasOpen || (episodes[k] && !episodes[k].error)) return;
    setEpisodes((m) => ({ ...m, [k]: { loading: true, error: "", episodes: [] } }));
    const qs = new URLSearchParams({ instance: row.instance, seriesId: String(row.arrId) });
    const res = await episodeLoads.run(k, (signal) => fetchJson(withBasePath(`/api/admin/missing/episodes?${qs}`), {
      schema: MissingEpisodesAnswer,
      signal,
      fallbackError: t("adminManage.missing.episodes.error"),
    }), { ifBusy: "skip" });
    if (!res) return;
    setEpisodes((m) => ({ ...m, [k]: res.ok ? { loading: false, error: "", episodes: res.data.episodes } : { loading: false, error: res.error, episodes: [] } }));
  }

  const report = reports[current];
  // The instance the filters apply: one the list on screen no longer has, or a
  // list down to one instance (no picker), shows every instance.
  const instanceShown = shownInstance(instance, report?.instances);
  const missingMovieItems = reports["radarr:missing"]?.items;
  const missingSeriesItems = reports["sonarr:missing"]?.items;
  const cutoffMovieItems = reports["radarr:cutoff"]?.items;
  const cutoffSeriesItems = reports["sonarr:cutoff"]?.items;

  // The server sends each list in its default order; the other orders are
  // re-sorts of the filtered copy.
  const movies = useMemo(
    () => sortMovies(applyFilters(missingMovieItems ?? [], { showUnmonitored, instance: instanceShown, query: deferredQuery }), movieSort, locale),
    [missingMovieItems, movieSort, showUnmonitored, instanceShown, deferredQuery, locale],
  );
  const series = useMemo(
    () => sortSeries(applyFilters(missingSeriesItems ?? [], { showUnmonitored, instance: instanceShown, query: deferredQuery }), seriesSort, locale),
    [missingSeriesItems, seriesSort, showUnmonitored, instanceShown, deferredQuery, locale],
  );
  const cutoffMovies = useMemo(() => applyFilters(cutoffMovieItems ?? [], { showUnmonitored: true, instance: instanceShown, query: deferredQuery }), [cutoffMovieItems, instanceShown, deferredQuery]);
  const cutoffSeries = useMemo(() => applyFilters(cutoffSeriesItems ?? [], { showUnmonitored: true, instance: instanceShown, query: deferredQuery }), [cutoffSeriesItems, instanceShown, deferredQuery]);
  // A missing list's unmonitored card counts under the same instance and title
  // filters as the cards beside it (hidden or not by the unmonitored switch).
  const unmonitored = useMemo(
    () => (report && mode === "missing" ? unmonitoredCount(report.items, { instance: instanceShown, query: deferredQuery }) : 0),
    [report, mode, instanceShown, deferredQuery],
  );

  // Each tab's count re-filters that service's WHOLE report: once per change of
  // the reports or the unmonitored switch, not on every keystroke and bulk tick.
  const tabCounts = useMemo(() => {
    const countOf = (svc: Service) => {
      const r = reports[`${svc}:${mode}`];
      const f: Filters = { showUnmonitored: mode === "cutoff" || showUnmonitored, instance: "all", query: "" };
      return r ? applyFilters(r.items as Array<{ title: string; instance: string; monitored?: boolean }>, f).length : undefined;
    };
    return { sonarr: countOf("sonarr"), radarr: countOf("radarr") };
  }, [reports, mode, showUnmonitored]);
  const tabCount = (svc: Service) => tabCounts[svc];

  const instanceName = (slug: string) => report?.instances.find((i) => i.slug === slug)?.name || slug || "—";
  const multiInstance = (report?.instances.length ?? 0) > 1;
  const label = SERVICE_LABEL[service];
  const instanceLabel = (slug: string) => arrInstanceLabel(service, instanceName(slug), slug);

  // Every row the filters list, in the order shown, across every page.
  const currentRows: ReadonlyArray<BulkRow> =
    current === "radarr:missing" ? movies : current === "sonarr:missing" ? series : current === "radarr:cutoff" ? cutoffMovies : cutoffSeries;
  const visibleCount = currentRows.length;
  const viewKey = `${current}|${instanceShown}|${query}|${showUnmonitored}|${movieSort}|${seriesSort}`;
  const pageCount = Math.max(1, Math.ceil(currentRows.length / PAGE_SIZE));
  const pageIndex = pageView.view === viewKey ? Math.min(pageView.page, pageCount - 1) : 0;
  const pageStart = pageIndex * PAGE_SIZE;
  function onPage<T>(rows: readonly T[]): T[] {
    return rows.slice(pageStart, pageStart + PAGE_SIZE);
  }
  const pageRows = onPage(currentRows);

  // "Search selected" on this list (use-bulk-search.ts).
  const selection = useBulkSelection(run, { current, currentRows, pageRows, report, loadingKeys });
  const { selectable, atCap, allSelected, bulkRunning, toggleSelected, selectAll, confirmBulk } = selection;

  const selectHeader = (
    <th style={{ ...th, width: 32 }}>
      <input
        type="checkbox"
        checked={allSelected}
        disabled={selectable.length === 0 || bulkRunning}
        onChange={(e) => selectAll(e.target.checked)}
        aria-label={t("adminArr.missingBulk.selectAll")}
        className="accent-[var(--ds-accent)]"
      />
    </th>
  );
  const selectCell = (r: BulkRow) => {
    const k = `${current}|${rowKey(r)}`;
    const st = searches[k];
    const ticked = selected.has(k);
    return (
      <MissingSelectCell
        title={r.title}
        ticked={ticked}
        disabled={!!st?.busy || st?.outcome === "started" || st?.outcome === "already" || bulkRunning || (!ticked && atCap)}
        onToggle={() => toggleSelected(k)}
      />
    );
  };
  // The row's own Search (use-bulk-search.ts's startSearch unticks it first).
  const searchCell = (key: ReportKey, r: { instance: string; arrId: number; title: string }) => {
    const k = `${key}|${rowKey(r)}`;
    return <MissingSearchCell reportKey={key} title={r.title} st={searches[k]} pending={bulkPending.has(k)} onSearch={() => void startSearch(key, r)} />;
  };
  const titleCell = (svc: Service, r: ListRow) => (
    <MissingTitleCell
      service={svc}
      mode={mode}
      row={r}
      href={r.tmdbId !== null ? `/${svc === "radarr" ? "movie" : "tv"}/${r.tmdbId}` : null}
      arrLabel={arrInstanceLabel(svc, instanceName(r.instance), r.instance)}
      // Removed from the arr: re-read the list so the row goes (not while
      // a bulk run is going through it — a fresh listing resets every row).
      onRemoved={() => {
        if (!isBulkRunning()) void load(svc, mode);
      }}
    />
  );

  // What every list's table starts with, head and row: the tick box, the
  // expander (the Sonarr lists), the title, and the instance when there are
  // several. Each list adds its own columns after it.
  const leadHead = (expander: boolean) => (
    <>
      {selectHeader}
      {expander && <th style={{ ...th, width: 32 }} />}
      <th style={th}>{t("adminManage.missing.col.title")}</th>
      {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
    </>
  );
  const leadCells = (svc: Service, r: ListRow, expander: React.ReactNode = null) => (
    <>
      {selectCell(r)}
      {expander}
      <td style={td}>{titleCell(svc, r)}</td>
      {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{instanceName(r.instance)}</td>}
    </>
  );
  // The one table every list renders through: the lead, the list's own
  // columns, the row's Search — and under an expanded row, its detail across
  // every column after the expander. Only the page on screen is rendered.
  const listTable = <R extends ListRow>(key: ReportKey, rows: readonly R[], columns: ReadonlyArray<Column<R>>, expand?: Expand<R>) => {
    const svc = serviceOf(key);
    const width = (expand ? 3 : 2) + (multiInstance ? 1 : 0) + columns.length + 1;
    const cells = (r: R, expander: React.ReactNode = null) => (
      <>
        {leadCells(svc, r, expander)}
        {columns.map((c, i) => (
          <td
            key={i}
            className={c.mono ? "ds-mono" : undefined}
            style={{ ...td, ...(c.small ? { fontSize: 12 } : null), ...(c.right ? { textAlign: "right" as const } : null) }}
          >
            {c.cell(r)}
          </td>
        ))}
        {searchCell(key, r)}
      </>
    );
    const head = (
      <>
        {leadHead(expand !== undefined)}
        {columns.map((c, i) => (
          <th key={i} style={c.right ? { ...th, textAlign: "right" } : th}>{c.head}</th>
        ))}
        <th style={th} />
      </>
    );
    return (
      <ReportTable head={head}>
        {onPage(rows).map((r) => {
        if (!expand) {
          return (
            <tr key={rowKey(r)} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
              {cells(r)}
            </tr>
          );
        }
        const k = `${key}|${rowKey(r)}`;
        return (
          <Fragment key={k}>
            <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
              {cells(r, <MissingExpanderCell open={expanded.has(k)} title={r.title} cutoff={expand.cutoff} onClick={() => expand.toggle(r, k)} />)}
            </tr>
            {expanded.has(k) && (
              <tr style={{ background: "var(--ds-bg-1)" }}>
                <td colSpan={2} />
                <td colSpan={width - 2} style={{ padding: "8px 10px 12px" }}>
                  {expand.detail(r, k)}
                </td>
              </tr>
            )}
          </Fragment>
        );
        })}
      </ReportTable>
    );
  };

  // A cutoff list's profile column: the profile, and the quality it stops at.
  const profileColumn: Column<{ profile: string | null; cutoff: string | null }> = {
    head: t("adminManage.missing.cutoff.col.profile"),
    small: true,
    cell: (r) => (
      <>
        <div style={{ color: "var(--ds-fg)" }}>{r.profile ?? "—"}</div>
        {r.cutoff && <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t("adminManage.missing.cutoff.cutoffAt", { quality: r.cutoff })}</div>}
      </>
    ),
  };

  // Each list's table: its rows, its own columns and, for a Sonarr list, what
  // an expanded row shows. Only the list on screen is built.
  const tables: Record<ReportKey, () => React.ReactNode> = {
    "radarr:missing": () =>
      listTable("radarr:missing", movies, [
        { head: t("adminManage.missing.col.physical"), small: true, mono: true, cell: (m) => day(m.physicalRelease) },
        { head: t("adminManage.missing.col.digital"), small: true, mono: true, cell: (m) => day(m.digitalRelease) },
        { head: t("adminManage.missing.col.missingFor"), small: true, mono: true, right: true, cell: (m) => t("adminManage.missing.days", { count: m.daysMissing }) },
      ]),
    "sonarr:missing": () =>
      listTable(
        "sonarr:missing",
        series,
        [
          {
            head: t("adminManage.missing.col.missing"),
            small: true,
            cell: (s) => (
              <>
                <div>{t("adminManage.missing.episodesOf", { missing: s.missing, count: s.aired })}</div>
                {s.status && SONARR_STATUSES.has(s.status) && (
                  <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t(`adminManage.missing.status.${s.status}`)}</div>
                )}
              </>
            ),
          },
          {
            head: t("adminManage.missing.col.seasons"),
            cell: (s) => (
              <div className="flex flex-wrap gap-1">
                {s.seasons.map((sn) => (
                  <span key={sn.seasonNumber} className="rounded bg-amber-500/15 text-amber-400 ds-mono" style={{ padding: "1px 6px", fontSize: 11 }}>
                    {t("adminManage.missing.seasonChip", { season: sn.seasonNumber, count: sn.missing })}
                  </span>
                ))}
              </div>
            ),
          },
          { head: t("adminManage.missing.col.lastAired"), small: true, mono: true, cell: (s) => aired(s.lastAired) },
        ],
        {
          cutoff: false,
          toggle: (s) => void toggleMissingSeries(s),
          detail: (s, k) => (
            <MissingEpisodesDetail
              state={episodes[k]}
              lines={(eps) => (
                <EpisodeLines
                  label={t("adminManage.missing.episodes.label", { title: s.title })}
                  eps={eps}
                  last={(e) => t("adminManage.missing.episodes.aired", { date: aired(e.airDateUtc) })}
                />
              )}
            />
          ),
        },
      ),
    "radarr:cutoff": () =>
      listTable("radarr:cutoff", cutoffMovies, [
        { head: t("adminManage.missing.cutoff.col.current"), small: true, mono: true, cell: (m) => m.quality ?? "—" },
        profileColumn,
      ]),
    "sonarr:cutoff": () =>
      listTable(
        "sonarr:cutoff",
        cutoffSeries,
        [
          { head: t("adminManage.missing.cutoff.col.episodes"), small: true, cell: (s) => t("adminManage.missing.cutoff.episodeCount", { count: s.episodes.length }) },
          profileColumn,
        ],
        {
          cutoff: true,
          toggle: (_s, k) => void toggleExpanded(k),
          detail: (s) => <EpisodeLines label={t("adminManage.missing.cutoff.episodesLabel", { title: s.title })} eps={s.episodes} last={(e) => e.quality ?? "—"} />,
        },
      ),
  };
  const table = tables[current]();

  const pager = pageCount > 1 ? (
    <nav aria-label={t("adminManage.missing.page.label")} className="flex flex-wrap items-center justify-end gap-2" style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
      <span className="ds-mono">
        {t("adminManage.missing.page.range", { from: pageStart + 1, to: Math.min(pageStart + PAGE_SIZE, currentRows.length), total: currentRows.length })}
      </span>
      <Button size="xs" variant="outline" disabled={pageIndex === 0} onClick={() => setPageView({ view: viewKey, page: pageIndex - 1 })}>
        <ChevronLeft /> {t("adminManage.missing.page.previous")}
      </Button>
      <Button size="xs" variant="outline" disabled={pageIndex >= pageCount - 1} onClick={() => setPageView({ view: viewKey, page: pageIndex + 1 })}>
        {t("adminManage.missing.page.next")} <ChevronRight />
      </Button>
    </nav>
  ) : null;

  let body: React.ReactNode;
  if (!configured[service] || (report && !report.enabled)) {
    body = (
      <EmptyState
        icon={CircleDashed}
        title={t("adminManage.missing.notConfigured.title", { service: label })}
        description={t("adminManage.missing.notConfigured.description", { service: label })}
        cta={{ href: `/settings?tab=media#${service}`, label: t("adminArr.common.openSettings") }}
      />
    );
  } else if (!report) {
    body = errors[current] ? (
      <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{errors[current]}</p>
    ) : (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.missing.loading", { service: label })}
      </div>
    );
  } else {
    // Something is listed, but the filters (title, instance, or hiding the
    // unmonitored titles) leave none of it on screen.
    const filtered = report.items.length > 0;
    body = (
      <div className="flex flex-col gap-4">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <MissingStats current={current} lists={{ movies, series, cutoffMovies, cutoffSeries }} unmonitored={unmonitored} />
        </div>

        <MissingReportNotices report={report} mode={modeOf(current)} instanceLabel={instanceLabel} />

        <MissingFilterRow
          current={current}
          query={query}
          onQuery={setQuery}
          instances={multiInstance ? report.instances : null}
          instance={instanceShown}
          onInstance={setInstance}
          movieSort={movieSort}
          onMovieSort={setMovieSort}
          seriesSort={seriesSort}
          onSeriesSort={setSeriesSort}
          showUnmonitored={showUnmonitored}
          onShowUnmonitored={setShowUnmonitored}
        />

        <MissingBulkBar mode={mode} selection={selection} visibleCount={visibleCount} loadingHere={loadingHere} onCancel={cancelBulk} />

        {visibleCount === 0 ? (
          filtered ? (
            <EmptyState icon={CircleDashed} title={t("adminManage.missing.empty.filteredTitle")} description={t("adminManage.missing.empty.filteredDescription")} />
          ) : mode === "cutoff" ? (
            <EmptyState icon={CheckCircle2} title={t("adminManage.missing.cutoff.empty.title")} description={t("adminManage.missing.cutoff.empty.description")} />
          ) : (
            <EmptyState
              icon={CheckCircle2}
              title={t("adminManage.missing.empty.title")}
              description={service === "radarr" ? t("adminManage.missing.empty.moviesDescription") : t("adminManage.missing.empty.seriesDescription")}
            />
          )
        ) : (
          <>
            {table}
            {pager}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <FilterBar<Service>
        segments={[
          { value: "sonarr", label: SERVICE_LABEL.sonarr, count: tabCount("sonarr") },
          { value: "radarr", label: SERVICE_LABEL.radarr, count: tabCount("radarr") },
        ]}
        active={service}
        onChange={switchTab}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <MissingModeToggle mode={mode} onMode={switchMode} />
            {configured[service] ? (
              // Off while a bulk search runs on this tab: a Refresh clears every
              // row's search state, and the rows already searched could be ticked
              // and searched again.
              <Button size="sm" variant="outline" onClick={() => void load(service, mode)} disabled={loadingHere || bulk?.key === current}>
                {loadingHere ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("adminManage.missing.refresh")}
              </Button>
            ) : null}
          </div>
        }
      />
      {/* The list on screen is the server's last kept answer: when it was read, and that the live read is out (or didn't finish). */}
      <ArrSnapshotNote at={staleAt} refreshing={loadingHere} />
      {report && errors[current] && (
        <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{errors[current]}</p>
      )}
      {bulk && bulk.key !== current && <OtherListRunning bulk={bulk} onCancel={cancelBulk} />}
      {body}

      <MissingBulkConfirmDialog confirming={confirming} onClose={() => setConfirming(null)} onConfirm={confirmBulk} />
    </div>
  );
}
