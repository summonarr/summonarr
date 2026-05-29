"use client";

// Refined History tab, ported from the Claude Design handoff (history.jsx).
// Visual layer is the design; the data layer (debounced search, server-side
// filter/sort/paginate against /api/play-history, distinct platform/user
// fetch, row delete, CSV/JSON export) is preserved from the prior
// implementation. Relative-time cells are gated behind useHasMounted so SSR
// and hydration agree (guardrail 16).

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { IpInfo } from "@/components/admin/ip-info";
import {
  ActivityCard,
  Avatar,
  MethodPill,
  Poster,
  Th,
  ChevIcon,
  methodLabel,
  fmtDuration,
  fmtBitrate,
  fmtTimestamp,
} from "@/components/admin/activity-ui";

interface HistoryRow {
  id: string;
  source: string;
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
  startedAt: string;
  stoppedAt: string | null;
  duration: number;
  playDuration: number;
  pausedDuration: number | null;
  watched: boolean;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  container: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  posterUrl: string | null;
  // Network metadata (Plex-only — Jellyfin leaves these null).
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  // Intro/credits markers (Plex-only). Offsets in milliseconds.
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
  // Resume-grouping anchor (see prisma/schema.prisma PlayHistory.referenceId).
  referenceId: string | null;
  mediaServerUserId: string;
  mediaServerUser: {
    username: string;
    source: string;
    thumbUrl: string | null;
  };
}

interface MediaServerUserOption {
  id: string;
  username: string;
  source: string;
}

type SortField =
  | "startedAt"
  | "title"
  | "playDuration"
  | "duration"
  | "platform";
type SortDir = "asc" | "desc";

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Format a millisecond offset as m:ss / h:mm:ss for marker labels in the
// session detail panel. Matches the formatter on the Now Playing card so the
// numbers line up visually.
function fmtMarkerOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const inputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 11.5,
  padding: "5px 8px",
  background: "var(--ds-bg-1)",
  color: "var(--ds-fg)",
  border: "1px solid var(--ds-border)",
  borderRadius: 6,
  colorScheme: "dark",
};

function SegGroup<T extends string>({
  label,
  value,
  setValue,
  options,
}: {
  label: string;
  value: T;
  setValue: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className="ds-mono uppercase"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "inline-flex",
          padding: 2,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 7,
        }}
      >
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => setValue(o.value)}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              borderRadius: 5,
              background:
                value === o.value ? "var(--ds-bg-3)" : "transparent",
              color:
                value === o.value
                  ? "var(--ds-fg)"
                  : "var(--ds-fg-muted)",
              border: "1px solid",
              borderColor:
                value === o.value
                  ? "var(--ds-border-strong)"
                  : "transparent",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "all 100ms var(--ds-ease)",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className="ds-mono uppercase"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: "inherit",
          fontSize: 11.5,
          padding: "4px 26px 4px 9px",
          background: "var(--ds-bg-1)",
          color: value ? "var(--ds-fg)" : "var(--ds-fg-muted)",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          cursor: "pointer",
        }}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DetailRow({
  play,
  colSpan,
  mounted,
}: {
  play: HistoryRow;
  colSpan: number;
  mounted: boolean;
}) {
  const pct =
    play.duration > 0
      ? Math.round((play.playDuration / play.duration) * 100)
      : 0;
  const details: [string, React.ReactNode][] = [
    ["Started", fmtTimestamp(play.startedAt, mounted)],
    ["Stopped", fmtTimestamp(play.stoppedAt, mounted)],
    ["Total length", fmtDuration(play.duration)],
    ["Watch time", fmtDuration(play.playDuration)],
    [
      "Paused",
      play.pausedDuration ? fmtDuration(play.pausedDuration) : "—",
    ],
    ["Progress", `${pct}%`],
    ["Device", play.device ?? "—"],
    [
      "IP address",
      play.ipAddress ? <IpInfo ip={play.ipAddress} inline /> : "—",
    ],
    ["Container", play.container ?? "—"],
    ["Bitrate", fmtBitrate(play.bitrate)],
    ["Video codec", play.videoCodec ?? "—"],
    ["Audio codec", play.audioCodec ?? "—"],
    ["Video decision", play.videoDecision ?? "—"],
    ["Audio decision", play.audioDecision ?? "—"],
  ];

  // Network metadata. Plex-only — Jellyfin rows leave these null. Suppress
  // the cells entirely when there's nothing to show rather than emit a row
  // of dashes that pads the panel for no reason.
  if (play.location || play.secure != null || play.relayed != null || play.bandwidth != null) {
    if (play.location) {
      details.push(["Connection", play.location.toUpperCase()]);
    }
    if (play.secure != null) {
      details.push(["Secure", play.secure ? "TLS" : "HTTP"]);
    }
    if (play.relayed) {
      details.push(["Relay", "via plex.tv"]);
    }
    if (play.bandwidth != null) {
      // Plex reports bandwidth in kbps; surface as Mbps for parity with the
      // rest of the panel.
      const mbps = play.bandwidth / 1000;
      details.push(["Session bandwidth", `${mbps.toFixed(1)} Mbps`]);
    }
  }

  // Intro/credits markers (Plex includeMarkers=1). Same suppression rule.
  if (play.introStartMs != null && play.introEndMs != null) {
    details.push([
      "Intro marker",
      `${fmtMarkerOffset(play.introStartMs)} – ${fmtMarkerOffset(play.introEndMs)}`,
    ]);
  }
  if (play.creditsStartMs != null) {
    const tail = play.creditsEndMs != null && play.duration > 0
      && play.creditsEndMs >= play.duration * 1000 - 1000
      ? "end"
      : play.creditsEndMs != null
        ? fmtMarkerOffset(play.creditsEndMs)
        : "end";
    details.push([
      "Credits marker",
      `${fmtMarkerOffset(play.creditsStartMs)} – ${tail}`,
    ]);
  }

  if (play.mediaType === "TV" && play.seasonNumber != null) {
    details.push([
      "Episode",
      `S${String(play.seasonNumber).padStart(2, "0")} · E${String(
        play.episodeNumber ?? 0,
      ).padStart(2, "0")}${play.episodeTitle ? ` — ${play.episodeTitle}` : ""}`,
    ]);
  }
  return (
    <tr
      style={{
        background: "var(--ds-bg-1)",
        borderBottom: "1px solid var(--ds-border)",
      }}
    >
      <td colSpan={colSpan} style={{ padding: "16px 22px 18px 56px" }}>
        <div
          className="ds-mono uppercase"
          style={{
            fontSize: 9.5,
            color: "var(--ds-fg-disabled)",
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          Session detail
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "10px 24px",
          }}
        >
          {details.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 0,
              }}
            >
              <span
                className="ds-mono uppercase"
                style={{
                  fontSize: 9,
                  color: "var(--ds-fg-disabled)",
                  letterSpacing: "0.08em",
                }}
              >
                {k}
              </span>
              <span
                className="ds-mono"
                style={{
                  fontSize: 12,
                  color: "var(--ds-fg-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {v}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          {play.tmdbId && (
            <Link
              href={`/admin/activity/media/${play.tmdbId}`}
              style={{
                fontSize: 11.5,
                padding: "5px 11px",
                borderRadius: 6,
                background: "var(--ds-bg-3)",
                border: "1px solid var(--ds-border)",
                color: "var(--ds-fg)",
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              View title activity →
            </Link>
          )}
          <Link
            href={`/admin/activity/user/${play.mediaServerUserId}`}
            style={{
              fontSize: 11.5,
              padding: "5px 11px",
              borderRadius: 6,
              background: "var(--ds-bg-3)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg)",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            User activity →
          </Link>
        </div>
      </td>
    </tr>
  );
}

function DeleteConfirm({
  row,
  deleting,
  onConfirm,
  onCancel,
}: {
  row: HistoryRow;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360,
          padding: 18,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border-strong)",
          borderRadius: 10,
          boxShadow: "var(--ds-shadow-lg)",
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ds-fg)",
            marginBottom: 6,
            letterSpacing: "-0.01em",
          }}
        >
          Delete this play?
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ds-fg-muted)",
            marginBottom: 14,
            lineHeight: 1.5,
          }}
        >
          The play record for{" "}
          <span style={{ color: "var(--ds-fg)" }}>{row.title}</span> by{" "}
          <span style={{ color: "var(--ds-fg)" }}>
            {row.mediaServerUser.username}
          </span>{" "}
          will be permanently removed from history.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={deleting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: "var(--ds-danger)",
              border: "1px solid transparent",
              color: "white",
              cursor: deleting ? "default" : "pointer",
              fontWeight: 500,
              opacity: deleting ? 0.7 : 1,
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ActivityHistoryTable({
  source: globalSource,
  mediaType: globalMediaType,
  days,
  startDateIso,
}: {
  source?: string;
  mediaType?: string;
  days: number;
  // Period lower bound, computed once on the server so client refetches don't
  // drift off a fresh client clock (guardrail 16).
  startDateIso?: string;
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
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [sortBy, setSortBy] = useState<SortField>("startedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  const [platforms, setPlatforms] = useState<string[]>([]);
  const [users, setUsers] = useState<MediaServerUserOption[]>([]);

  const [deleteRow, setDeleteRow] = useState<HistoryRow | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    fetch("/api/play-history?distinct=platforms", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (Array.isArray(data)) setPlatforms(data as string[]);
      })
      .catch(() => {});
    fetch("/api/play-history?distinct=users", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (Array.isArray(data)) setUsers(data as MediaServerUserOption[]);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (globalSource) params.set("source", globalSource);
    if (globalMediaType) params.set("mediaType", globalMediaType);
    if (fromDate) {
      params.set("startDate", new Date(`${fromDate}T00:00:00`).toISOString());
    } else if (startDateIso) {
      params.set("startDate", startDateIso);
    }
    if (toDate)
      params.set("endDate", new Date(`${toDate}T23:59:59`).toISOString());
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (watched) params.set("watched", watched);
    if (method) params.set("playMethod", method);
    if (platform) params.set("platform", platform);
    if (userFilter) params.set("userId", userFilter);
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir);
    return params;
  }, [
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
  ]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    const params = buildFilterParams();
    params.set("page", String(page));
    params.set("limit", String(limit));

    fetch(`/api/play-history?${params.toString()}`, {
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
    try {
      const res = await fetch(`/api/play-history/${deleteRow.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.id !== deleteRow.id));
        setTotal((t) => Math.max(0, t - 1));
        setExpandedId(null);
        setDeleteRow(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  function exportAs(format: "csv" | "json") {
    const params = buildFilterParams();
    params.set("format", format);
    window.open(`/api/play-history/export?${params.toString()}`, "_blank");
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

  const startItem = total > 0 ? (page - 1) * limit + 1 : 0;
  const endItem = Math.min(page * limit, total);
  const pageRange: number[] = [];
  {
    const s = Math.max(1, page - 2);
    const e = Math.min(totalPages, page + 2);
    for (let i = s; i <= e; i++) pageRange.push(i);
  }
  const colSpan = 10;

  return (
    <div>
      <ActivityCard style={{ padding: 18 }}>
        {/* Search + dates + export */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div
            className="resp-history-bar"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <div style={{ position: "relative", flex: "0 1 360px" }}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 14 14"
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--ds-fg-subtle)",
                }}
              >
                <circle
                  cx="6"
                  cy="6"
                  r="3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M8.7 8.7L11 11"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by title or user…"
                style={{
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  width: "100%",
                  padding: "7px 30px 7px 30px",
                  background: "var(--ds-bg-1)",
                  color: "var(--ds-fg)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 8,
                  outline: "none",
                }}
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  style={{
                    position: "absolute",
                    right: 8,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "transparent",
                    border: 0,
                    color: "var(--ds-fg-subtle)",
                    cursor: "pointer",
                    padding: 4,
                    lineHeight: 0,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12">
                    <path
                      d="M3 3l6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={{
                  ...inputStyle,
                  color: fromDate ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                }}
              />
              <span
                className="ds-mono"
                style={{ fontSize: 11, color: "var(--ds-fg-disabled)" }}
              >
                →
              </span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={{
                  ...inputStyle,
                  color: toDate ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                }}
              />
            </div>

            <div style={{ flex: 1 }} />

            <div
              className="ds-mono"
              style={{
                fontSize: 11,
                color: "var(--ds-fg-subtle)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {total.toLocaleString("en-US")} total
            </div>

            {hasFilter && (
              <button
                onClick={clearFilters}
                className="ds-mono"
                style={{
                  fontSize: 11,
                  padding: "5px 10px",
                  borderRadius: 6,
                  background: "transparent",
                  border: "1px solid var(--ds-border)",
                  color: "var(--ds-fg-muted)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Clear filters
              </button>
            )}

            <div style={{ display: "inline-flex", gap: 4 }}>
              <button
                onClick={() => exportAs("csv")}
                style={{
                  fontSize: 12,
                  padding: "6px 11px",
                  borderRadius: 6,
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  color: "var(--ds-fg-muted)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Export CSV
              </button>
              <button
                onClick={() => exportAs("json")}
                style={{
                  fontSize: 12,
                  padding: "6px 11px",
                  borderRadius: 6,
                  background: "var(--ds-bg-2)",
                  border: "1px solid var(--ds-border)",
                  color: "var(--ds-fg-muted)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                JSON
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <SegGroup
              label="Watched"
              value={watched}
              setValue={setWatched}
              options={[
                { value: "", label: "All" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
            />
            <SegGroup
              label="Stream"
              value={method}
              setValue={setMethod}
              options={[
                { value: "", label: "All" },
                { value: "DirectPlay", label: "Direct" },
                { value: "DirectStream", label: "Remux" },
                { value: "Transcode", label: "Transcode" },
              ]}
            />
            <SelectField
              label="User"
              value={userFilter}
              onChange={setUserFilter}
              options={users.map((u) => ({ value: u.id, label: u.username }))}
            />
            <SelectField
              label="Platform"
              value={platform}
              onChange={setPlatform}
              options={platforms.map((p) => ({ value: p, label: p }))}
            />
          </div>
        </div>

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
                  const pct =
                    r.duration > 0
                      ? Math.min(
                          100,
                          Math.round((r.playDuration / r.duration) * 100),
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
                                  color: "var(--ds-fg)",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {r.title}
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
                            {mounted ? relTime(r.startedAt) : ""}
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 0 0",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              className="ds-mono"
              style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
            >
              Rows
            </span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                padding: "3px 7px",
                background: "var(--ds-bg-1)",
                color: "var(--ds-fg)",
                border: "1px solid var(--ds-border)",
                borderRadius: 5,
                cursor: "pointer",
              }}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span
              className="ds-mono"
              style={{
                fontSize: 10.5,
                color: "var(--ds-fg-disabled)",
                marginLeft: 6,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {total > 0
                ? `${startItem.toLocaleString("en-US")}–${endItem.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`
                : "0 results"}
            </span>
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {(
              [
                ["«", () => setPage(1), page === 1],
                ["‹", () => setPage(page - 1), page === 1],
              ] as const
            ).map(([label, fn, disabled], idx) => (
              <PageBtn key={idx} onClick={fn} disabled={disabled}>
                {label}
              </PageBtn>
            ))}
            {pageRange[0] > 1 && (
              <span
                className="ds-mono"
                style={{
                  color: "var(--ds-fg-disabled)",
                  fontSize: 11,
                  padding: "0 4px",
                }}
              >
                …
              </span>
            )}
            {pageRange.map((p) => (
              <PageBtn
                key={p}
                onClick={() => setPage(p)}
                active={p === page}
              >
                {p}
              </PageBtn>
            ))}
            {pageRange[pageRange.length - 1] < totalPages && (
              <span
                className="ds-mono"
                style={{
                  color: "var(--ds-fg-disabled)",
                  fontSize: 11,
                  padding: "0 4px",
                }}
              >
                …
              </span>
            )}
            {(
              [
                ["›", () => setPage(page + 1), page >= totalPages],
                ["»", () => setPage(totalPages), page >= totalPages],
              ] as const
            ).map(([label, fn, disabled], idx) => (
              <PageBtn key={idx} onClick={fn} disabled={disabled}>
                {label}
              </PageBtn>
            ))}
          </div>
        </div>
      </ActivityCard>

      {deleteRow && (
        <DeleteConfirm
          row={deleteRow}
          deleting={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </div>
  );
}

function PageBtn({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="ds-mono"
      style={{
        minWidth: 26,
        height: 26,
        padding: "0 6px",
        fontSize: 11,
        background: active ? "var(--ds-accent)" : "transparent",
        color: active
          ? "var(--ds-accent-fg)"
          : disabled
            ? "var(--ds-fg-disabled)"
            : "var(--ds-fg-muted)",
        border: "1px solid",
        borderColor: active ? "transparent" : "var(--ds-border)",
        borderRadius: 5,
        cursor: disabled ? "default" : "pointer",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </button>
  );
}
