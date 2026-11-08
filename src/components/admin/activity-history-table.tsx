"use client";

// The admin History tab: a searchable, sortable, paginated table of plays.
// Filtering, sorting and paging all happen on the server (/api/play-history).
// Relative-time cells ("3h ago") wait for useHasMounted so the server render
// and the browser's first render match (guardrail 16).
//
// This file composes the pieces under ./activity-history/: the state and
// loading hooks (use-history-table.ts, pure rules in helpers.ts), the filter
// bar, the table's header and status rows, the rows themselves, the
// pagination footer and the delete dialog. Times are shown in the statistics
// zone the server names (`timeZone`), the zone the date filter's days are in.

import { useCallback, useMemo, useState } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useAsyncAction } from "@/hooks/use-async-action";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { ActivityCard } from "@/components/admin/activity-ui";
import { buildHistoryFilterParams, hasActiveFilter } from "./activity-history/helpers";
import { HistoryFilterBar } from "./activity-history/filter-bar";
import { HistoryPagination } from "./activity-history/pagination";
import { HistoryTableRow } from "./activity-history/table-row";
import { HistoryLoadError, HistoryStatusRow, HistoryTableHead } from "./activity-history/table-parts";
import { DeleteConfirm } from "./activity-history/delete-confirm";
import { useHistoryJsonExport } from "./activity-history/use-history-export";
import {
  useHistoryDelete,
  useHistoryOptions,
  useHistoryPage,
  useHistoryQuery,
} from "./activity-history/use-history-table";
import type { HistoryFilters } from "./activity-history/types";

const COL_SPAN = 10;

const DIVIDER = <div style={{ borderTop: "1px solid var(--ds-border)", margin: "0 -18px" }} />;

export function ActivityHistoryTable({
  source: globalSource,
  mediaType: globalMediaType,
  startDateIso,
  timeZone,
  initialFromDate,
  initialToDate,
  initialWatched,
}: {
  source?: string;
  mediaType?: string;
  // Period lower bound, computed once on the server so client refetches don't
  // drift off a fresh client clock (guardrail 16). The page remounts the table
  // (its `key`) when the period, source or type changes; the table's own
  // filters ride along in the URL (helpers.ts).
  startDateIso?: string;
  // The statistics zone: the date filter's days are whole days in it (the API
  // reads them there), and the table's times are shown in it.
  timeZone: string;
  // Seed the date filter from the URL (a calendar "View these plays" deep-link).
  // YYYY-MM-DD; the server page validates the format before passing them.
  initialFromDate?: string;
  initialToDate?: string;
  initialWatched?: "true" | "false";
}) {
  const mounted = useHasMounted();
  const t = useT();
  const loader = useAsyncAction();

  const { query, dispatch, searchDraft, setSearchDraft } = useHistoryQuery({
    fromDate: initialFromDate,
    toDate: initialToDate,
    watched: initialWatched,
  });
  const { filters, grouped, sortBy, sortDir, limit, page } = query;
  const { rows, total, totalPages, loading, error, invertedRange, reload } = useHistoryPage({
    query,
    dispatch,
    globalSource,
    globalMediaType,
    startDateIso,
    loader,
  });
  const { platforms, users } = useHistoryOptions(loader);

  const jsonExport = useHistoryJsonExport();
  const exportNotice = jsonExport.notice;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const del = useHistoryDelete({
    grouped,
    loader,
    failedText: t("adminActivity.history.deleteError"),
    onDeleted: () => {
      setExpandedId(null);
      reload();
    },
  });
  const openDelete = del.open;

  function exportAs(format: "csv" | "json") {
    const params = buildHistoryFilterParams({ globalSource, globalMediaType, startDateIso, filters, sortBy, sortDir, grouped });
    params.set("format", format);
    const url = withBasePath(`/api/play-history/export?${params.toString()}`);
    // The CSV streams as a plain download; the JSON is fetched so the cut-at-cap
    // header can be shown.
    if (format === "csv") window.open(url, "_blank");
    else void jsonExport.exportJson(url);
  }

  const setFilter = useCallback((patch: Partial<HistoryFilters>) => dispatch({ type: "filter", patch }), [dispatch]);
  const clearFilters = useCallback(() => {
    setSearchDraft("");
    dispatch({ type: "clearFilters" });
  }, [dispatch, setSearchDraft]);

  // Stable callbacks, so the memoized rows below skip a re-render whenever
  // their own props are unchanged.
  const toggleExpanded = useCallback(
    (id: string) => setExpandedId((cur) => (cur === id ? null : id)),
    [],
  );

  // The row list is memoized so a keystroke in the search box (which
  // re-renders this component before the debounce fires) doesn't rebuild up to
  // 200 rows; each row is also memo()'d, so expanding one re-renders only the
  // rows whose `isExpanded` changed.
  const rowNodes = useMemo(
    () =>
      rows.map((r, i) => (
        <HistoryTableRow
          key={r.id}
          row={r}
          index={i}
          isExpanded={expandedId === r.id}
          mounted={mounted}
          timeZone={timeZone}
          colSpan={COL_SPAN}
          onToggle={toggleExpanded}
          onDelete={openDelete}
        />
      )),
    [rows, expandedId, mounted, timeZone, toggleExpanded, openDelete],
  );

  let body: React.ReactNode;
  if (invertedRange) {
    body = <HistoryStatusRow colSpan={COL_SPAN} fontSize={13}>{t("adminActivity.history.dateOrderError")}</HistoryStatusRow>;
  } else if (loading && rows.length === 0) {
    body = <HistoryStatusRow colSpan={COL_SPAN}>{t("adminActivity.common.loading")}</HistoryStatusRow>;
  } else if (error) {
    body = <HistoryLoadError colSpan={COL_SPAN} message={t(error)} onRetry={reload} />;
  } else if (rows.length === 0) {
    body = <HistoryStatusRow colSpan={COL_SPAN} fontSize={13}>{t("adminActivity.history.noMatch")}</HistoryStatusRow>;
  } else {
    body = rowNodes;
  }

  return (
    <div>
      <ActivityCard style={{ padding: 18 }}>
        {/* Search + dates + export */}
        <HistoryFilterBar
          searchDraft={searchDraft}
          setSearchDraft={setSearchDraft}
          filters={filters}
          setFilter={setFilter}
          grouped={grouped}
          setGrouped={(value) => dispatch({ type: "grouped", grouped: value })}
          users={users}
          platforms={platforms}
          total={total}
          hasFilter={hasActiveFilter(filters, searchDraft)}
          clearFilters={clearFilters}
          exportAs={exportAs}
          timeZone={timeZone}
          invertedRange={invertedRange}
        />

        {exportNotice && (
          <p
            role="status"
            className="ds-mono"
            style={{ fontSize: 11, color: exportNotice.kind === "failed" ? "var(--ds-danger)" : "var(--ds-fg-subtle)", margin: "8px 0 0" }}
          >
            {exportNotice.kind === "failed"
              ? exportNotice.message
              : t("adminActivity.history.exportTruncated", { max: exportNotice.max })}
          </p>
        )}

        {DIVIDER}

        <div className="resp-table-scroll" style={{ margin: "0 -18px" }}>
          <table
            style={{
              width: "100%",
              minWidth: 920,
              borderCollapse: "collapse",
              fontSize: 12.5,
            }}
          >
            <HistoryTableHead sortBy={sortBy} sortDir={sortDir} onSort={(field) => dispatch({ type: "sort", field })} />
            {/* A load the admin asked for (sort, page, filter) keeps the
                previous rows on screen, dimmed and inert, so the table doesn't
                collapse to a 60px text cell and bounce the pagination footer.
                The text cell is for the FIRST load only, when there is nothing
                to keep. A live refresh's background re-read doesn't dim. */}
            <tbody
              aria-busy={loading || undefined}
              className={loading && rows.length > 0 ? "opacity-50 pointer-events-none" : undefined}
              style={{ transition: "opacity 120ms var(--ds-ease)" }}
            >
              {body}
            </tbody>
          </table>
        </div>

        {DIVIDER}

        <HistoryPagination
          page={page}
          setPage={(value) => dispatch({ type: "page", page: value })}
          limit={limit}
          setLimit={(value) => dispatch({ type: "limit", limit: value })}
          total={total}
          totalPages={totalPages}
        />
      </ActivityCard>

      {del.row && (
        <DeleteConfirm
          row={del.row}
          deleting={del.deleting}
          error={del.error}
          onConfirm={del.confirm}
          onCancel={del.cancel}
        />
      )}
    </div>
  );
}
