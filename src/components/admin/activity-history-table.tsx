"use client";

// Refined History tab, ported from the Claude Design handoff (history.jsx).
// Visual layer is the design; the data layer (debounced search, server-side
// filter/sort/paginate against /api/play-history, distinct platform/user
// fetch, row delete, CSV/JSON export) is preserved from the prior
// implementation. Relative-time cells are gated behind useHasMounted so SSR
// and hydration agree (guardrail 16).
//
// All state lives here; the filter bar, pagination footer, expanded detail
// row, delete modal, and pure helpers are extracted under ./activity-history/
// and receive state + callbacks (including the `mounted` flag) via props.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  ActivityCard,
  Avatar,
  MethodPill,
  Poster,
  Th,
  ChevIcon,
  methodLabel,
  fmtDuration,
  fmtTimestamp,
} from "@/components/admin/activity-ui";
import type {
  HistoryRow,
  MediaServerUserOption,
  SortDir,
  SortField,
} from "./activity-history/types";
import { buildHistoryFilterParams } from "./activity-history/helpers";
import { HistoryFilterBar } from "./activity-history/filter-bar";
import { HistoryPagination } from "./activity-history/pagination";
import { DetailRow } from "./activity-history/detail-row";
import { DeleteConfirm } from "./activity-history/delete-confirm";

export function ActivityHistoryTable({
  source: globalSource,
  mediaType: globalMediaType,
  days,
  startDateIso,
  initialFromDate,
  initialToDate,
}: {
  source?: string;
  mediaType?: string;
  days: number;
  // Period lower bound, computed once on the server so client refetches don't
  // drift off a fresh client clock (guardrail 16).
  startDateIso?: string;
  // Seed the date filter from the URL (a calendar "View these plays" deep-link).
  // YYYY-MM-DD; the server page validates the format before passing them.
  initialFromDate?: string;
  initialToDate?: string;
}) {
  const mounted = useHasMounted();

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [watched, setWatched] = useState<"" | "true" | "false">("");
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

  const [deleteRow, setDeleteRow] = useState<HistoryRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [
    debouncedSearch,
    watched,
    method,
    platform,
    userFilter,
    fromDate,
    toDate,
    sortBy,
    sortDir,
    limit,
    grouped,
    globalSource,
    globalMediaType,
    days,
  ]);

  useEffect(() => {
    // AbortController guards against unmount during the in-flight fetch + against
    // a backend 4xx returning `{ error: "..." }` which (untyped) would crash the
    // downstream .map/.filter in the dropdown render. Typed parsers narrow the
    // payload to the array shape the setters expect; non-array responses are
    // silently dropped (empty dropdown is preferable to a render crash).
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

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    const params = buildFilterParams();
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
        setRows(data.items ?? []);
        setTotal(data.total ?? 0);
        setTotalPages(data.totalPages ?? 1);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("[activity-history]", err);
        setError(err instanceof Error ? err.message : "Failed to load");
        setLoading(false);
      });

    return () => controller.abort();
  }, [page, limit, buildFilterParams]);

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
      const res = await fetch(withBasePath(`/api/play-history/${deleteRow.id}`), {
        method: "DELETE",
      });
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.id !== deleteRow.id));
        setTotal((t) => Math.max(0, t - 1));
        setExpandedId(null);
        setDeleteRow(null);
      } else {
        setDeleteError("Couldn't delete this play record. Please try again.");
      }
    } catch {
      setDeleteError("Couldn't delete this play record. Please try again.");
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

  const colSpan = 10;

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
                <Th label="User" />
                <Th
                  label="Title"
                  onSort={() => toggleSort("title")}
                  active={sortBy === "title"}
                  dir={sortDir}
                />
                <Th
                  label="Started"
                  onSort={() => toggleSort("startedAt")}
                  active={sortBy === "startedAt"}
                  dir={sortDir}
                />
                <Th
                  label="Length"
                  onSort={() => toggleSort("duration")}
                  active={sortBy === "duration"}
                  dir={sortDir}
                  align="right"
                />
                <Th
                  label="Watched"
                  onSort={() => toggleSort("playDuration")}
                  active={sortBy === "playDuration"}
                  dir={sortDir}
                  align="right"
                />
                <Th label="Stream" />
                <Th label="Quality" />
                <Th
                  label="Platform"
                  onSort={() => toggleSort("platform")}
                  active={sortBy === "platform"}
                  dir={sortDir}
                />
                <Th width={48} align="right" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={colSpan}
                    style={{
                      padding: "60px 20px",
                      textAlign: "center",
                      color: "var(--ds-fg-subtle)",
                    }}
                  >
                    Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td
                    colSpan={colSpan}
                    style={{
                      padding: "60px 20px",
                      textAlign: "center",
                      color: "var(--ds-danger)",
                    }}
                  >
                    {error}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={colSpan}
                    style={{
                      padding: "60px 20px",
                      textAlign: "center",
                      color: "var(--ds-fg-subtle)",
                      fontSize: 13,
                    }}
                  >
                    No plays match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const isExpanded = expandedId === r.id;
                  // Use chain totals when present (grouped mode). Ungrouped
                  // rows mirror these to single-segment defaults, so the
                  // expression is safe either way.
                  const effectivePlay = r.totalPlayDuration ?? r.playDuration;
                  const pct =
                    r.duration > 0
                      ? Math.min(
                          100,
                          Math.round((effectivePlay / r.duration) * 100),
                        )
                      : 0;
                  const ml = methodLabel(
                    r.playMethod,
                    r.videoDecision,
                    r.audioDecision,
                  );
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className="history-row"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onClick={() =>
                          setExpandedId((id) => (id === r.id ? null : r.id))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setExpandedId((id) => (id === r.id ? null : r.id));
                          }
                        }}
                        style={{
                          background: isExpanded
                            ? "var(--ds-bg-3)"
                            : i % 2 === 1
                              ? "oklch(1 0 0 / 0.012)"
                              : "transparent",
                          borderBottom: "1px solid var(--ds-border)",
                          cursor: "pointer",
                        }}
                      >
                        <td style={{ padding: "10px 0 10px 12px" }}>
                          <ChevIcon open={isExpanded} />
                        </td>
                        <td
                          style={{
                            padding: "10px 11px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <Link
                            href={`/admin/activity/user/${r.mediaServerUserId}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              textDecoration: "none",
                              color: "inherit",
                            }}
                          >
                            <Avatar
                              letter={(
                                r.mediaServerUser.username[0] ?? "?"
                              ).toUpperCase()}
                              size={20}
                            />
                            <span style={{ color: "var(--ds-fg)" }}>
                              {r.mediaServerUser.username}
                            </span>
                            <span
                              style={{
                                width: 4,
                                height: 4,
                                borderRadius: 999,
                                background:
                                  r.source === "plex"
                                    ? "var(--ds-plex)"
                                    : "var(--ds-jellyfin)",
                              }}
                            />
                          </Link>
                        </td>
                        <td style={{ padding: "10px 11px", minWidth: 240 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <Poster
                              src={r.posterUrl}
                              letter={(r.title[0] ?? "?").toUpperCase()}
                              w={28}
                              h={40}
                              radius={3}
                            />
                            <div
                              style={{
                                minWidth: 0,
                                lineHeight: 1.25,
                                flex: 1,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  minWidth: 0,
                                }}
                              >
                                <div
                                  style={{
                                    color: "var(--ds-fg)",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {r.title}
                                </div>
                                {(r.segmentCount ?? 1) > 1 && (
                                  <span
                                    className="ds-mono"
                                    title="Continued watch — toggle Group resumes off to see individual segments"
                                    style={{
                                      fontSize: 9.5,
                                      padding: "2px 6px",
                                      borderRadius: 999,
                                      background: "oklch(1 0 0 / 0.06)",
                                      color: "var(--ds-fg-subtle)",
                                      letterSpacing: "0.04em",
                                      whiteSpace: "nowrap",
                                      flexShrink: 0,
                                    }}
                                  >
                                    {r.segmentCount}×
                                  </span>
                                )}
                              </div>
                              <div
                                className="ds-mono"
                                style={{
                                  fontSize: 10.5,
                                  color: "var(--ds-fg-disabled)",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {r.mediaType === "TV" &&
                                r.seasonNumber != null
                                  ? `S${String(r.seasonNumber).padStart(2, "0")} · E${String(r.episodeNumber ?? 0).padStart(2, "0")}${r.episodeTitle ? ` · ${r.episodeTitle}` : ""}`
                                  : (r.mediaType ?? "")}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td
                          className="ds-mono"
                          style={{
                            padding: "10px 11px",
                            color: "var(--ds-fg-muted)",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmtTimestamp(r.startedAt, mounted)}
                          <div
                            className="ds-mono"
                            style={{
                              fontSize: 10,
                              color: "var(--ds-fg-disabled)",
                            }}
                          >
                            {mounted ? formatRelativeTime(r.startedAt) : ""}
                          </div>
                        </td>
                        <td
                          className="ds-mono"
                          style={{
                            padding: "10px 11px",
                            color: "var(--ds-fg-muted)",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmtDuration(r.duration)}
                        </td>
                        <td
                          style={{
                            padding: "10px 11px",
                            whiteSpace: "nowrap",
                            minWidth: 130,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                flex: 1,
                                height: 3,
                                background: "oklch(1 0 0 / 0.06)",
                                borderRadius: 999,
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  width: `${pct}%`,
                                  height: "100%",
                                  background: r.watched
                                    ? "var(--ds-success)"
                                    : "var(--ds-accent)",
                                  borderRadius: 999,
                                }}
                              />
                            </div>
                            <span
                              className="ds-mono"
                              style={{
                                fontSize: 10.5,
                                color: r.watched
                                  ? "var(--ds-success)"
                                  : "var(--ds-fg-subtle)",
                                fontVariantNumeric: "tabular-nums",
                                width: 32,
                                textAlign: "right",
                              }}
                            >
                              {pct}%
                            </span>
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "10px 11px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <MethodPill
                            method={ml.label}
                            methodClass={ml.cls}
                          />
                        </td>
                        <td
                          className="ds-mono"
                          style={{
                            padding: "10px 11px",
                            color: "var(--ds-fg-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.resolution ?? "—"}
                          {r.videoCodec && (
                            <span
                              style={{ color: "var(--ds-fg-disabled)" }}
                            >
                              {" "}
                              · {r.videoCodec}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "10px 11px",
                            color: "var(--ds-fg-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.platform ?? "—"}
                        </td>
                        <td
                          style={{
                            padding: "10px 11px",
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => setDeleteRow(r)}
                            className="history-delete"
                            aria-label="Delete play"
                            style={{
                              background: "transparent",
                              border: "1px solid transparent",
                              color: "var(--ds-fg-disabled)",
                              cursor: "pointer",
                              borderRadius: 4,
                              padding: "4px 6px",
                              lineHeight: 0,
                              transition: "all 120ms var(--ds-ease)",
                            }}
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 14 14"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M2.5 3.5h9M5 3.5V2.5a1 1 0 011-1h2a1 1 0 011 1v1M5 6v5M9 6v5M3.5 3.5l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <DetailRow
                          play={r}
                          colSpan={colSpan}
                          mounted={mounted}
                        />
                      )}
                    </Fragment>
                  );
                })
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

        {/* Pagination */}
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
