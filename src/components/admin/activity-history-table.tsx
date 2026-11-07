"use client";

// The admin History tab: a searchable, sortable, paginated table of plays.
// Filtering, sorting and paging all happen on the server (/api/play-history).
// Relative-time cells ("3h ago") wait for useHasMounted so the server render
// and the browser's first render match (guardrail 16).
//
// All state lives here. The filter bar, pagination footer, table rows,
// expanded detail row, delete modal and pure helpers live under
// ./activity-history/ and get their state and callbacks (including the
// `mounted` flag) through props.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { ActivityCard, Th } from "@/components/admin/activity-ui";
import type {
  HistoryRow,
  MediaServerUserOption,
  SortDir,
  SortField,
} from "./activity-history/types";
import { buildHistoryFilterParams } from "./activity-history/helpers";
import { HistoryFilterBar } from "./activity-history/filter-bar";
import { HistoryPagination } from "./activity-history/pagination";
import { HistoryTableRow } from "./activity-history/table-row";
import { DeleteConfirm } from "./activity-history/delete-confirm";

const COL_SPAN = 10;

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
  // Not read here: the parent remounts the table via `key="ht-<days>-…"`
  // (admin/activity/history/page.tsx), so a period change starts from fresh
  // state.
  days: number;
  // Period lower bound, computed once on the server so client refetches don't
  // drift off a fresh client clock (guardrail 16).
  startDateIso?: string;
  // The statistics zone the date filter's days are read in (by the API).
  timeZone: string;
  // Seed the date filter from the URL (a calendar "View these plays" deep-link).
  // YYYY-MM-DD; the server page validates the format before passing them.
  initialFromDate?: string;
  initialToDate?: string;
  initialWatched?: "true" | "false";
}) {
  const mounted = useHasMounted();
  const t = useT();

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [watched, setWatched] = useState<"" | "true" | "false">(initialWatched ?? "");
  const [method, setMethod] = useState("");
  const [platform, setPlatform] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [fromDate, setFromDate] = useState(initialFromDate ?? "");
  const [toDate, setToDate] = useState(initialToDate ?? "");

  const [sortBy, setSortBy] = useState<SortField>("startedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Resume-grouping: default-on. When grouped, the table shows one row per
  // chain (latest segment + chain aggregates); when off, each segment is its
  // own row. Stored as `grouped` (true = collapsed) — API param is the
  // inverse (`?ungrouped=true`) because the server defaults to grouped.
  const [grouped, setGrouped] = useState(true);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  const [platforms, setPlatforms] = useState<string[]>([]);
  const [users, setUsers] = useState<MediaServerUserOption[]>([]);

  // Bumped after a delete to re-run the fetch effect. The table is the only
  // thing that knows the DB changed — the DELETE route emits no SSE event.
  const [reloadToken, setReloadToken] = useState(0);
  const [deleteRow, setDeleteRow] = useState<HistoryRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Keep from/to/watched in the URL in step with the table's own. The period
  // selector copies the current query string, so a date picked here survives a
  // period change or a reload, and one the user has since cleared doesn't ride
  // along and re-seed the remounted table. The state argument is null on
  // purpose: Next's patched replaceState skips its router sync for a state
  // carrying its own marker (which `window.history.state` does), so the router
  // kept the old query; with null, Next copies its own history state itself.
  useEffect(() => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const [key, value] of [["from", fromDate], ["to", toDate], ["watched", watched]] as const) {
      if (value === "") {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      } else if (url.searchParams.get(key) !== value) {
        url.searchParams.set(key, value);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(null, "", url);
  }, [fromDate, toDate, watched]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    // Loads the options for the Platform and User dropdowns. The
    // AbortController cancels the requests if the table unmounts first. Only
    // an array is accepted: an error reply like `{ error: "..." }` would crash
    // the dropdown's .map(), so anything else is ignored and the dropdown
    // just stays empty.
    const ac = new AbortController();
    fetch(withBasePath("/api/play-history?distinct=platforms"), { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (Array.isArray(data)) setPlatforms(data as string[]);
      })
      .catch(() => {});
    fetch(withBasePath("/api/play-history?distinct=users"), { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (Array.isArray(data)) setUsers(data as MediaServerUserOption[]);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const buildFilterParams = useCallback(
    () =>
      buildHistoryFilterParams({
        globalSource,
        globalMediaType,
        startDateIso,
        fromDate,
        toDate,
        debouncedSearch,
        watched,
        method,
        platform,
        userFilter,
        sortBy,
        sortDir,
        grouped,
      }),
    [
      globalSource,
      globalMediaType,
      startDateIso,
      fromDate,
      toDate,
      debouncedSearch,
      watched,
      method,
      platform,
      userFilter,
      sortBy,
      sortDir,
      grouped,
    ],
  );

  // Remembers the filters the fetch effect last used. When the filters change
  // we jump back to page 1, and that decision is made INSIDE the fetch effect
  // on purpose. A separate `useEffect(() => setPage(1), [filters])` would run
  // in the same render as the fetch, so the fetch would first request the
  // OLD page with the NEW filters, then cancel it and ask for page 1. The
  // cancel only happens in the browser — the server still runs the first
  // (expensive) query. Doing both here sends exactly one request.
  const lastFilterKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const params = buildFilterParams();
    // `limit` is part of the key (a page-size change re-pages from 1); `page`
    // and `reloadToken` deliberately are not — a delete refetches the CURRENT
    // page.
    //
    // The period's lower bound is NOT part of the key. `startDateIso` is read
    // off the clock on every server render, and the page's live refresher
    // (activity:history-updated → router.refresh) hands this table a new one
    // each time a play finishes: keyed on it, every finished stream looked like
    // a filter change and threw an admin paging through history back to page 1.
    // A period change remounts the table (the page's `key`), so it never needs
    // to be detected here; the refetch itself still runs, on the current page.
    const keyParams = new URLSearchParams(params);
    if (startDateIso && keyParams.get("startDate") === startDateIso) keyParams.delete("startDate");
    const filterKey = `${keyParams.toString()}|${limit}`;
    if (
      lastFilterKeyRef.current !== null &&
      lastFilterKeyRef.current !== filterKey &&
      page !== 1
    ) {
      lastFilterKeyRef.current = filterKey;
      setPage(1);
      return;
    }
    lastFilterKeyRef.current = filterKey;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    params.set("page", String(page));
    params.set("limit", String(limit));

    fetch(withBasePath(`/api/play-history?${params.toString()}`), {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        // After a delete the current page can end up past the last page
        // (e.g. removing the only row on the final page). Step back to the new
        // last page; changing `page` re-runs this effect and fetches it.
        const lastPage = Math.max(1, data.totalPages ?? 1);
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setRows(data.items ?? []);
        setTotal(data.total ?? 0);
        setTotalPages(data.totalPages ?? 1);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("[activity-history]", err);
        // The raw status lands in the console above; the table shows copy an
        // admin can act on, with a Retry beside it. Stored as a catalog key so
        // the effect needs no translator dependency; translated at render.
        setError("adminActivity.history.loadError");
        setLoading(false);
      });

    return () => controller.abort();
  }, [page, limit, buildFilterParams, reloadToken, startDateIso]);

  function toggleSort(field: SortField) {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir(field === "startedAt" ? "desc" : "asc");
    }
  }

  async function confirmDelete() {
    if (!deleteRow) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      // In grouped mode a row IS the whole viewing — one film paused and
      // resumed across several sittings — so the delete has to take the chain.
      // The row's own id is only the NEWEST segment (the group's representative
      // is picked by startedAt DESC), so deleting it alone left the rest behind.
      const res = await fetch(
        withBasePath(`/api/play-history/${deleteRow.id}${grouped ? "?chain=true" : ""}`),
        { method: "DELETE" },
      );
      if (res.ok) {
        setExpandedId(null);
        setDeleteRow(null);
        // Refetch rather than splice the row out and decrement `total` by one.
        // Both of those were guesses about what the server did, and both were
        // wrong for a chain: the row vanished while its remaining segments
        // survived, and `total` counts DISTINCT chains so it had not changed at
        // all. Re-reading is the only thing that cannot disagree with the DB.
        setReloadToken((n) => n + 1);
      } else {
        setDeleteError(t("adminActivity.history.deleteError"));
      }
    } catch {
      setDeleteError(t("adminActivity.history.deleteError"));
    } finally {
      setDeleting(false);
    }
  }

  function exportAs(format: "csv" | "json") {
    const params = buildFilterParams();
    params.set("format", format);
    window.open(withBasePath(`/api/play-history/export?${params.toString()}`), "_blank");
  }

  function clearFilters() {
    setSearch("");
    setWatched("");
    setMethod("");
    setPlatform("");
    setUserFilter("");
    setFromDate("");
    setToDate("");
  }

  const hasFilter =
    !!search ||
    !!watched ||
    !!method ||
    !!platform ||
    !!userFilter ||
    !!fromDate ||
    !!toDate;

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
          colSpan={COL_SPAN}
          onToggle={toggleExpanded}
          onDelete={setDeleteRow}
        />
      )),
    [rows, expandedId, mounted, toggleExpanded],
  );

  return (
    <div>
      <ActivityCard style={{ padding: 18 }}>
        {/* Search + dates + export */}
        <HistoryFilterBar
          search={search}
          setSearch={setSearch}
          fromDate={fromDate}
          setFromDate={setFromDate}
          toDate={toDate}
          setToDate={setToDate}
          watched={watched}
          setWatched={setWatched}
          method={method}
          setMethod={setMethod}
          userFilter={userFilter}
          setUserFilter={setUserFilter}
          platform={platform}
          setPlatform={setPlatform}
          grouped={grouped}
          setGrouped={setGrouped}
          users={users}
          platforms={platforms}
          total={total}
          hasFilter={hasFilter}
          clearFilters={clearFilters}
          exportAs={exportAs}
          timeZone={timeZone}
        />

        <div
          style={{
            borderTop: "1px solid var(--ds-border)",
            margin: "0 -18px",
          }}
        />

        <div className="resp-table-scroll" style={{ margin: "0 -18px" }}>
          <table
            style={{
              width: "100%",
              minWidth: 920,
              borderCollapse: "collapse",
              fontSize: 12.5,
            }}
          >
            <thead>
              <tr style={{ background: "var(--ds-bg-1)" }}>
                <Th width={28} />
                <Th label={t("adminActivity.field.user")} />
                <Th
                  label={t("adminActivity.field.title")}
                  onSort={() => toggleSort("title")}
                  active={sortBy === "title"}
                  dir={sortDir}
                />
                <Th
                  label={t("adminActivity.field.started")}
                  onSort={() => toggleSort("startedAt")}
                  active={sortBy === "startedAt"}
                  dir={sortDir}
                />
                <Th
                  label={t("adminActivity.field.length")}
                  onSort={() => toggleSort("duration")}
                  active={sortBy === "duration"}
                  dir={sortDir}
                  align="right"
                />
                <Th
                  label={t("adminActivity.field.watched")}
                  onSort={() => toggleSort("playDuration")}
                  active={sortBy === "playDuration"}
                  dir={sortDir}
                  align="right"
                />
                <Th label={t("adminActivity.field.stream")} />
                <Th label={t("adminActivity.field.quality")} />
                <Th
                  label={t("adminActivity.field.platform")}
                  onSort={() => toggleSort("platform")}
                  active={sortBy === "platform"}
                  dir={sortDir}
                />
                <Th width={48} align="right" />
              </tr>
            </thead>
            {/* A refetch (sort, page, filter, keystroke) keeps the previous
                rows on screen, dimmed and inert, so the table doesn't collapse
                to a 60px text cell and bounce the pagination footer. The text
                cell is for the FIRST load only, when there is nothing to keep. */}
            <tbody
              aria-busy={loading || undefined}
              className={loading && rows.length > 0 ? "opacity-50 pointer-events-none" : undefined}
              style={{ transition: "opacity 120ms var(--ds-ease)" }}
            >
              {loading && rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={COL_SPAN}
                    style={{
                      padding: "60px 20px",
                      textAlign: "center",
                      color: "var(--ds-fg-subtle)",
                    }}
                  >
                    {t("adminActivity.common.loading")}
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td
                    colSpan={COL_SPAN}
                    style={{
                      padding: "60px 20px",
                      textAlign: "center",
                      color: "var(--ds-danger)",
                    }}
                  >
                    <div role="alert">{t(error)}</div>
                    <button
                      type="button"
                      className="ds-hover-tint"
                      onClick={() => setReloadToken((n) => n + 1)}
                      style={{
                        marginTop: 10,
                        fontSize: 12,
                        padding: "5px 12px",
                        borderRadius: 6,
                        background: "transparent",
                        border: "1px solid var(--ds-border)",
                        color: "var(--ds-fg-muted)",
                      }}
                    >
                      {t("adminActivity.common.retry")}
                    </button>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={COL_SPAN}
                    style={{
                      padding: "60px 20px",
                      textAlign: "center",
                      color: "var(--ds-fg-subtle)",
                      fontSize: 13,
                    }}
                  >
                    {t("adminActivity.history.noMatch")}
                  </td>
                </tr>
              ) : (
                rowNodes
              )}
            </tbody>
          </table>
        </div>

        <div
          style={{
            borderTop: "1px solid var(--ds-border)",
            margin: "0 -18px",
          }}
        />

        <HistoryPagination
          page={page}
          setPage={setPage}
          limit={limit}
          setLimit={setLimit}
          total={total}
          totalPages={totalPages}
        />
      </ActivityCard>

      {deleteRow && (
        <DeleteConfirm
          row={deleteRow}
          deleting={deleting}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => {
            setDeleteRow(null);
            setDeleteError(null);
          }}
        />
      )}
    </div>
  );
}
