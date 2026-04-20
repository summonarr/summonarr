"use client";

import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Film, Tv2, ChevronDown, ChevronRight, Loader2,
  ArrowUpDown, ArrowUp, ArrowDown, Download, Search,
  X, Trash2, ExternalLink, Calendar,
} from "lucide-react";

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

type SortField = "startedAt" | "title" | "playDuration" | "duration" | "source" | "platform";
type SortDir = "asc" | "desc";

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

function formatBitrate(raw: number | null): string {
  if (!raw || raw <= 0) return "—";
  const kbps = raw > 100000 ? raw / 1000 : raw;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function progressPercent(playDuration: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.min(Math.round((playDuration / duration) * 100), 100);
}

function SortHeader({
  label,
  field,
  currentSort,
  currentDir,
  onSort,
  className = "",
}: {
  label: string;
  field: SortField;
  currentSort: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  className?: string;
}) {
  const isActive = currentSort === field;
  return (
    <th
      className={`py-2 pr-4 cursor-pointer select-none hover:text-zinc-300 transition-colors ${className}`}
      onClick={() => onSort(field)}
    >
      <div className="flex items-center gap-1">
        <span>{label}</span>
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="w-3 h-3" />
          ) : (
            <ArrowDown className="w-3 h-3" />
          )
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-30" />
        )}
      </div>
    </th>
  );
}

function StreamBadge({ method }: { method: string | null }) {
  if (!method) return <span className="text-zinc-600">—</span>;
  const color =
    method === "Transcode"
      ? "text-orange-400"
      : method === "DirectPlay"
        ? "text-green-500"
        : "text-blue-400";
  return (
    <span className={color}>
      {method === "DirectPlay" ? "Direct" : method === "DirectStream" ? "Remux" : method}
    </span>
  );
}

function ProgressBar({ play, pause }: { play: number; pause: number }) {
  const total = play + Math.max(pause ?? 0, 0);
  if (total <= 0) return <span className="text-zinc-600">—</span>;
  const pct = Math.min(Math.round((play / total) * 100), 100);
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-blue-500" : "bg-zinc-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function DetailRow({ play }: { play: HistoryRow }) {
  const pct = progressPercent(play.playDuration, play.duration);
  return (
    <tr className="bg-zinc-800/30">
      <td colSpan={10} className="px-4 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2 text-xs">
          <div>
            <span className="text-zinc-500">Device</span>
            <p className="text-zinc-300">{play.device ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">IP Address</span>
            <p className="text-zinc-300 tabular-nums">{play.ipAddress ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Container</span>
            <p className="text-zinc-300">{play.container ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Bitrate</span>
            <p className="text-zinc-300">{formatBitrate(play.bitrate)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Video Decision</span>
            <p className="text-zinc-300">{play.videoDecision ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Audio Decision</span>
            <p className="text-zinc-300">{play.audioDecision ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Audio Codec</span>
            <p className="text-zinc-300">{play.audioCodec?.toUpperCase() ?? "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Paused Duration</span>
            <p className="text-zinc-300">{play.pausedDuration ? formatDuration(play.pausedDuration) : "—"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Started</span>
            <p className="text-zinc-300">{formatTimestamp(play.startedAt)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Stopped</span>
            <p className="text-zinc-300">{formatTimestamp(play.stoppedAt)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Total Duration</span>
            <p className="text-zinc-300">{formatDuration(play.duration)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Actual Watch Time</span>
            <p className="text-zinc-300">{formatDuration(play.playDuration)}</p>
          </div>
          <div>
            <span className="text-zinc-500">Progress</span>
            <p className="text-zinc-300">{pct}%</p>
          </div>
          {play.seasonNumber != null && (
            <div>
              <span className="text-zinc-500">Season / Episode</span>
              <p className="text-zinc-300">
                S{String(play.seasonNumber).padStart(2, "0")}
                E{String(play.episodeNumber ?? 0).padStart(2, "0")}
                {play.episodeTitle ? ` — ${play.episodeTitle}` : ""}
              </p>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function ExportButton({ filterParams }: { filterParams: URLSearchParams }) {
  const [open, setOpen] = useState(false);

  function exportAs(format: "csv" | "json") {
    const exportParams = new URLSearchParams(filterParams.toString());
    exportParams.set("format", format);
    window.open(`/api/play-history/export?${exportParams.toString()}`, "_blank");
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
      >
        <Download size={14} /> Export
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg overflow-hidden">
            <button
              onClick={() => exportAs("csv")}
              className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Export as CSV
            </button>
            <button
              onClick={() => exportAs("json")}
              className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Export as JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ActivityHistoryTable({
  source: globalSource,
  mediaType: globalMediaType,
  days,
}: {
  source?: string;
  mediaType?: string;
  days: number;
}) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [watchedFilter, setWatchedFilter] = useState<"" | "true" | "false">("");
  const [playMethodFilter, setPlayMethodFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [sortBy, setSortBy] = useState<SortField>("startedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  const [platforms, setPlatforms] = useState<string[]>([]);
  const [users, setUsers] = useState<MediaServerUserOption[]>([]);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, watchedFilter, playMethodFilter, platformFilter, userFilter, fromDate, toDate, sortBy, sortDir, limit, globalSource, globalMediaType, days]);

  useEffect(() => {
    fetch("/api/play-history?distinct=platforms")
      .then((r) => r.json())
      .then(setPlatforms)
      .catch(() => {});
    fetch("/api/play-history?distinct=users")
      .then((r) => r.json())
      .then(setUsers)
      .catch(() => {});
  }, []);

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (globalSource) params.set("source", globalSource);
    if (globalMediaType) params.set("mediaType", globalMediaType);

    if (fromDate) {
      params.set("startDate", new Date(fromDate + "T00:00:00").toISOString());
    } else if (days) {
      params.set("startDate", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
    }
    if (toDate) {
      params.set("endDate", new Date(toDate + "T23:59:59").toISOString());
    }
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (watchedFilter) params.set("watched", watchedFilter);
    if (playMethodFilter) params.set("playMethod", playMethodFilter);
    if (platformFilter) params.set("platform", platformFilter);
    if (userFilter) params.set("userId", userFilter);
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir);
    return params;
  }, [globalSource, globalMediaType, days, fromDate, toDate, debouncedSearch, watchedFilter, playMethodFilter, platformFilter, userFilter, sortBy, sortDir]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    const params = buildFilterParams();
    params.set("page", String(page));
    params.set("limit", String(limit));

    fetch(`/api/play-history?${params.toString()}`, { signal: controller.signal })
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
        if (err.name !== "AbortError") setLoading(false);
      });

    return () => controller.abort();
  }, [page, limit, buildFilterParams]);

  function handleSort(field: SortField) {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir(field === "startedAt" ? "desc" : "asc");
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/play-history/${id}`, { method: "DELETE" });
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.id !== id));
        setTotal((t) => Math.max(0, t - 1));
        setDeleteId(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  function getPageRange(): number[] {
    const range: number[] = [];
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    for (let i = start; i <= end; i++) range.push(i);
    return range;
  }

  const startItem = (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-5">
      <div className="flex flex-col gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or user..."
              className="w-full pl-8 pr-8 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <ExportButton filterParams={buildFilterParams()} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">Watched</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {([["All", ""], ["Yes", "true"], ["No", "false"]] as const).map(([label, value]) => (
                <button
                  key={value}
                  onClick={() => setWatchedFilter(value)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    watchedFilter === value
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">Stream</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {([["All", ""], ["Direct", "DirectPlay"], ["Remux", "DirectStream"], ["Transcode", "Transcode"]] as const).map(
                ([label, value]) => (
                  <button
                    key={value}
                    onClick={() => setPlayMethodFilter(value)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      playMethodFilter === value
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-800 text-zinc-400 hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </div>

          {platforms.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500 mr-1">Platform</span>
              <select
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
                className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">All</option>
                {platforms.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}

          {users.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500 mr-1">User</span>
              <select
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 max-w-[160px]"
              >
                <option value="">All</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username} ({u.source})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
              title="Start date"
            />
            <span className="text-xs text-zinc-500">—</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
              title="End date"
            />
            {(fromDate || toDate) && (
              <button
                onClick={() => { setFromDate(""); setToDate(""); }}
                className="text-zinc-500 hover:text-red-400 transition-colors"
                title="Clear date range"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {(debouncedSearch || watchedFilter || playMethodFilter || platformFilter || userFilter || fromDate || toDate) && (
            <button
              onClick={() => {
                setSearch("");
                setWatchedFilter("");
                setPlayMethodFilter("");
                setPlatformFilter("");
                setUserFilter("");
                setFromDate("");
                setToDate("");
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
              <th className="text-left py-2 pr-2 w-6" />
              <SortHeader label="Media" field="title" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <th className="text-left py-2 pr-4">User</th>
              <SortHeader label="Source" field="source" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Platform" field="platform" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <th className="text-left py-2 pr-4">Stream</th>
              <th className="text-left py-2 pr-4">Quality</th>
              <SortHeader label="Duration" field="playDuration" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <th className="text-left py-2 pr-4">Progress</th>
              <SortHeader label="When" field="startedAt" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <th className="py-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-12 text-center">
                  <Loader2 className="w-5 h-5 animate-spin text-zinc-500 mx-auto mb-2" />
                  <p className="text-zinc-500 text-xs">Loading history...</p>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-12 text-center text-zinc-500 text-sm">
                  No play history found
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const isExpanded = expandedId === p.id;
                const qualityParts: string[] = [];
                if (p.resolution) qualityParts.push(p.resolution);
                if (p.videoCodec) qualityParts.push(p.videoCodec.toUpperCase());
                const qualityStr = qualityParts.length > 0 ? qualityParts.join(" · ") : null;
                const pct = progressPercent(p.playDuration, p.duration);

                return (
                  <Fragment key={p.id}>
                    <tr
                      className={`group border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer transition-colors ${
                        loading ? "opacity-50" : ""
                      }`}
                      onClick={() => setExpandedId(isExpanded ? null : p.id)}
                    >
                      <td className="py-2.5 pr-2 text-zinc-500">
                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          {(p.mediaType ?? "").toUpperCase() === "TV" ? (
                            <Tv2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          ) : (
                            <Film className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          )}
                          {p.tmdbId && p.mediaType ? (
                            <Link
                              href={p.mediaType === "TV" ? `/tv/${p.tmdbId}` : `/movie/${p.tmdbId}`}
                              className="text-white hover:text-indigo-400 transition-colors truncate max-w-[220px] block"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {p.title}
                            </Link>
                          ) : (
                            <span className="text-white truncate max-w-[220px] block">{p.title}</span>
                          )}
                          {(p.mediaType ?? "").toUpperCase() === "TV" && p.seasonNumber != null && (
                            <span className="text-zinc-500 text-xs shrink-0">
                              S{String(p.seasonNumber).padStart(2, "0")}E{String(p.episodeNumber ?? 0).padStart(2, "0")}
                            </span>
                          )}
                          {p.watched && (
                            <span className="text-[10px] bg-green-600/20 text-green-400 px-1.5 py-0.5 rounded shrink-0">
                              watched
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          {p.mediaServerUser.thumbUrl && /^https?:\/\//i.test(p.mediaServerUser.thumbUrl) && (
                            <img
                              src={p.mediaServerUser.thumbUrl}
                              alt=""
                              className="w-5 h-5 rounded-full object-cover shrink-0"
                            />
                          )}
                          <Link
                            href={`/admin/activity/user/${p.mediaServerUserId}`}
                            className="text-zinc-300 hover:text-indigo-400 transition-colors truncate max-w-[120px]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {p.mediaServerUser.username}
                          </Link>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            p.source === "plex"
                              ? "bg-amber-500/15 text-amber-400"
                              : "bg-purple-500/15 text-purple-400"
                          }`}
                        >
                          {p.source === "plex" ? "Plex" : "Jellyfin"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-zinc-400 text-xs truncate max-w-[100px]">
                        {p.platform ?? "—"}
                      </td>
                      <td className="py-2.5 pr-4">
                        <StreamBadge method={p.playMethod} />
                      </td>
                      <td className="py-2.5 pr-4">
                        {qualityStr ? (
                          <span className="text-zinc-400 text-xs">{qualityStr}</span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-zinc-400 tabular-nums">
                        {formatDuration(p.playDuration)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <ProgressBar play={p.playDuration} pause={p.duration - p.playDuration} />
                          <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right text-zinc-500" title={formatTimestamp(p.startedAt)}>
                        {formatRelativeTime(p.startedAt)}
                      </td>
                      <td className="py-2.5 pl-2">
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100">
                          <Link
                            href={`/admin/activity/play/${p.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-zinc-600 hover:text-indigo-400 transition-colors"
                            title="View details"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Link>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteId(p.id);
                            }}
                            className="text-zinc-700 hover:text-red-400 transition-colors"
                            title="Delete record"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && <DetailRow play={p} />}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-3 border-t border-zinc-800">
          <div className="text-xs text-zinc-500">
            Showing {startItem}–{endItem} of {total.toLocaleString()} results
          </div>

          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage(1)}
              className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              First
            </button>
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            {getPageRange().map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  p === page
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:text-white"
                }`}
              >
                {p}
              </button>
            ))}
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
              className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Last
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Per page</span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded text-white focus:outline-none focus:border-indigo-500"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 className="text-white font-semibold mb-2">Delete Play Record</h3>
            <p className="text-zinc-400 text-sm mb-4">
              Are you sure you want to delete this play history record? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteId(null)}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
