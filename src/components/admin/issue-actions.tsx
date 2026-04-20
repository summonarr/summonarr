"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Loader2, Check, RefreshCw, AlertTriangle, Clock, Trash2,
  Download, ChevronDown, ChevronUp, Magnet, Radio, Search, X,
} from "lucide-react";
import type { ArrRelease } from "@/lib/arr";

interface IssueActionsProps {
  issueId: string;
  currentStatus: string;
  mediaType: string;
  tmdbId: number;
  tvdbId: number | null;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;

  libraryConfirmed?: boolean;
}

const REFETCH_LABEL: Record<string, string> = {
  FULL: "Refetch all",
  SEASON: "Refetch season",
  EPISODE: "Refetch episode",
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  if (hours < 24 * 30) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours / (24 * 30))}mo`;
}

export function IssueActions({
  issueId,
  currentStatus,
  mediaType,
  tmdbId,
  tvdbId,
  scope,
  seasonNumber,
  episodeNumber,
  libraryConfirmed,
}: IssueActionsProps) {
  const router = useRouter();

  const [loading, setLoading] = useState<"refetch" | "status" | "delete" | "releases" | "grab" | null>(null);
  const [arrError, setArrError] = useState<string | null>(null);
  const [refetchOk, setRefetchOk] = useState(false);

  const [panel, setPanel] = useState<"resolve" | "delete" | "replace" | null>(null);
  const [resolution, setResolution] = useState("");

  const [releases, setReleases] = useState<ArrRelease[]>([]);
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [grabOk, setGrabOk] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [releaseFilter, setReleaseFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  async function triggerRefetch() {
    setLoading("refetch");
    setArrError(null);
    setRefetchOk(false);
    try {
      const res = await fetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refetch: true }),
      });
      const data: { arrError?: string } = await res.json();
      if (data.arrError) {
        setArrError(data.arrError);
      } else {
        setRefetchOk(true);
        router.refresh();
      }
    } finally {
      setLoading(null);
    }
  }

  async function updateStatus(status: string, resolutionNote?: string) {
    setLoading("status");
    setArrError(null);
    try {
      const res = await fetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolution: resolutionNote }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError((data as { error?: string }).error ?? "Status update failed");
        return;
      }
      router.refresh();
    } finally {
      setLoading(null);
      setPanel(null);
    }
  }

  async function deleteIssue() {
    setLoading("delete");
    try {
      const res = await fetch(`/api/issues/${issueId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError((data as { error?: string }).error ?? "Delete failed");
        return;
      }
      router.refresh();
    } finally {
      setLoading(null);
      setPanel(null);
    }
  }

  async function openReplacePicker() {
    setPanel("replace");
    setLoading("releases");
    setArrError(null);
    setReleases([]);
    setSelectedGuid(null);
    setGrabOk(false);
    setShowRejected(false);
    setReleaseFilter("");
    try {
      const res = await fetch(`/api/issues/${issueId}/releases`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError(data.error ?? "Failed to fetch releases");
        setPanel(null);
      } else {
        const data: ArrRelease[] = await res.json();
        setReleases(data);
        const first = data.find((r) => !r.rejected) ?? data[0];
        if (first) setSelectedGuid(first.guid);
      }
    } finally {
      setLoading(null);
    }
  }

  async function grabRelease() {
    if (!selectedGuid) return;
    const rel = releases.find((r) => r.guid === selectedGuid);
    if (!rel) return;
    setLoading("grab");
    setArrError(null);
    try {
      const res = await fetch(`/api/issues/${issueId}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guid: rel.guid, indexerId: rel.indexerId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError(data.error ?? "Grab failed");
      } else {
        setGrabOk(true);
        router.refresh();
      }
    } finally {
      setLoading(null);
    }
  }

  useEffect(() => {
    if (panel !== "replace" || releases.length === 0) return;
    const term = releaseFilter.toLowerCase();
    const visible = releases.filter(
      (r) => (showRejected || !r.rejected) && r.title.toLowerCase().includes(term)
    );
    if (visible.length === 0) { setSelectedGuid(null); return; }
    if (!visible.some((r) => r.guid === selectedGuid)) {
      setSelectedGuid(visible[0].guid);
    }
  }, [releaseFilter, showRejected, releases, panel, selectedGuid]);

  useEffect(() => {
    if (panel === "replace" && releases.length > 0 && loading !== "releases") {
      setTimeout(() => filterRef.current?.focus(), 50);
    }
  }, [panel, releases.length, loading]);

  useEffect(() => {
    if (panel !== "replace") return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && loading !== "grab") setPanel(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [panel, loading]);

  const refetchLabel = mediaType === "MOVIE" ? "Refetch movie" : (REFETCH_LABEL[scope] ?? "Refetch");
  const canRefetch = mediaType === "MOVIE" || !!tvdbId;

  const canReplace = mediaType === "MOVIE" || !!tvdbId || scope === "EPISODE";
  const isResolved = currentStatus === "RESOLVED";
  const isInProgress = currentStatus === "IN_PROGRESS";

  const scopeDetail =
    scope === "EPISODE" && seasonNumber != null && episodeNumber != null
      ? `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`
      : scope === "SEASON" && seasonNumber != null
      ? `Season ${seasonNumber}`
      : null;

  const filterTerm = releaseFilter.toLowerCase();
  const visibleReleases = releases.filter(
    (r) => (showRejected || !r.rejected) && (filterTerm === "" || r.title.toLowerCase().includes(filterTerm))
  );
  const rejectedCount = releases.filter((r) => r.rejected).length;

  return (
    <div className="flex flex-col items-end gap-1.5 min-w-0 shrink-0">
      {scopeDetail && (
        <span className="text-[10px] text-zinc-500 font-mono">{scopeDetail}</span>
      )}
      {libraryConfirmed && scope === "EPISODE" && !isResolved && (
        <span className="text-[10px] text-blue-500/70">library match confirmed</span>
      )}

      {panel === null && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {canRefetch && !isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={triggerRefetch}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-amber-400 hover:border-amber-500/50 gap-1"
            >
              {loading === "refetch" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {refetchLabel}
            </Button>
          )}

          {canReplace && !isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={openReplacePicker}
              disabled={loading !== null}
              className={`h-7 px-3 text-xs gap-1 ${
                libraryConfirmed && scope === "EPISODE"
                  ? "border-blue-600/50 text-blue-400 hover:text-blue-300 hover:border-blue-500"
                  : "border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-500/50"
              }`}
            >
              <Download className="w-3 h-3" />
              {libraryConfirmed && scope === "EPISODE" ? "Replace episode" : "Replace"}
            </Button>
          )}

          {!isResolved && !isInProgress && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateStatus("IN_PROGRESS")}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-yellow-400 hover:border-yellow-500/50 gap-1"
            >
              {loading === "status" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
              In Progress
            </Button>
          )}

          {!isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel("resolve")}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-green-400 hover:border-green-500/50 gap-1"
            >
              <Check className="w-3 h-3" />
              Resolve
            </Button>
          )}

          {isResolved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateStatus("OPEN")}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-500 hover:text-white gap-1"
            >
              Reopen
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={() => setPanel("delete")}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-600 hover:text-red-400 hover:border-red-500/50"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      )}

      {panel === "resolve" && (
        <div className="flex items-center gap-1.5 justify-end mt-0.5">
          <input
            type="text"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Resolution note (optional)"
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 w-44"
          />
          <Button
            size="sm"
            onClick={() => updateStatus("RESOLVED", resolution || undefined)}
            disabled={loading !== null}
            className="h-6 px-2 text-xs bg-green-700 hover:bg-green-600 gap-1"
          >
            {loading === "status" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Done
          </Button>
          <button onClick={() => setPanel(null)} className="text-zinc-600 hover:text-zinc-400 text-xs">Cancel</button>
        </div>
      )}

      {panel === "delete" && (
        <div className="flex items-center gap-1.5 justify-end mt-0.5">
          <span className="text-[11px] text-zinc-400">Delete this issue?</span>
          <Button
            size="sm"
            onClick={deleteIssue}
            disabled={loading !== null}
            className="h-6 px-2 text-xs bg-red-800 hover:bg-red-700 gap-1"
          >
            {loading === "delete" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Delete
          </Button>
          <button onClick={() => setPanel(null)} className="text-zinc-600 hover:text-zinc-400 text-xs">Cancel</button>
        </div>
      )}

      {panel === "replace" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget && loading !== "grab") setPanel(null); }}
        >
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
              <p className="text-base font-semibold text-zinc-100">
                {libraryConfirmed && scope === "EPISODE" ? "Replace episode" : "Replace"}
              </p>
              <button
                onClick={() => setPanel(null)}
                disabled={loading === "grab"}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {loading === "releases" ? (
              <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-16">
                <Loader2 className="w-5 h-5 animate-spin" />
                Searching indexers…
              </div>
            ) : grabOk ? (
              <div className="flex items-center justify-center gap-2 text-sm text-green-400 py-16">
                <Check className="w-4 h-4" />
                Grab queued — download starting
              </div>
            ) : releases.length === 0 ? (
              <div className="text-sm text-zinc-500 text-center py-16">No releases found</div>
            ) : (
              <>
                {libraryConfirmed && scope === "EPISODE" && (
                  <div className="px-6 py-2.5 bg-blue-950/30 border-b border-blue-900/30 flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-blue-400/80">
                      Library match confirmed — filter below to find the right episode release
                    </span>
                  </div>
                )}

                <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0">
                  <div className="relative flex items-center">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                    <input
                      ref={filterRef}
                      type="text"
                      value={releaseFilter}
                      onChange={(e) => setReleaseFilter(e.target.value)}
                      placeholder="Filter releases…"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-10 pr-9 py-2.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60"
                    />
                    {releaseFilter && (
                      <button
                        onClick={() => setReleaseFilter("")}
                        className="absolute right-3 text-zinc-500 hover:text-zinc-300"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {visibleReleases.length === 0 && filterTerm && (
                    <p className="text-xs text-zinc-500 mt-2 text-center">
                      No releases match &ldquo;{releaseFilter}&rdquo;{" "}
                      <button onClick={() => setReleaseFilter("")} className="text-zinc-400 hover:text-zinc-200 underline">Clear</button>
                    </p>
                  )}
                </div>

                <div className="overflow-y-auto flex-1 divide-y divide-zinc-800">
                  {visibleReleases.map((rel) => {
                    const isSelected = selectedGuid === rel.guid;
                    const profileMatch = !rel.rejected;
                    return (
                      <button
                        key={rel.guid}
                        onClick={() => setSelectedGuid(rel.guid)}
                        className={`w-full text-left px-6 py-3.5 flex items-start gap-4 hover:bg-zinc-800/60 transition-colors ${isSelected ? "bg-zinc-800" : ""}`}
                      >
                        <span className={`mt-0.5 shrink-0 ${rel.protocol === "torrent" ? "text-green-500" : "text-blue-400"}`}>
                          {rel.protocol === "torrent" ? <Magnet className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
                        </span>

                        <div className="flex-1 min-w-0">
                          <p className={`text-sm truncate ${isSelected ? "text-white" : "text-zinc-300"}`} title={rel.title}>
                            {rel.title}
                          </p>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${profileMatch ? "bg-blue-500/10 text-blue-400" : "bg-zinc-800 text-zinc-500"}`}>
                              {rel.quality.quality.name}
                              {rel.quality.revision.version > 1 && " v2"}
                            </span>
                            <span className="text-xs text-zinc-500">{formatSize(rel.size)}</span>
                            <span className="text-xs text-zinc-600">{rel.indexer}</span>
                            {rel.protocol === "torrent" && rel.seeders != null && (
                              <span className={`text-xs ${rel.seeders > 5 ? "text-green-500/70" : rel.seeders > 0 ? "text-yellow-500/70" : "text-red-500/70"}`}>
                                {rel.seeders}S
                              </span>
                            )}
                            <span className="text-xs text-zinc-700">{formatAge(rel.age * 24)}</span>
                          </div>
                          {rel.rejected && rel.rejections.length > 0 && (
                            <p className="text-xs text-amber-500/70 mt-0.5 truncate">{rel.rejections[0]}</p>
                          )}
                        </div>

                        {isSelected && <Check className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />}
                      </button>
                    );
                  })}
                </div>

                {rejectedCount > 0 && (
                  <button
                    onClick={() => setShowRejected((v) => !v)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-zinc-600 hover:text-zinc-400 border-t border-zinc-800 transition-colors flex-shrink-0"
                  >
                    {showRejected ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {showRejected ? "Hide" : "Show"} {rejectedCount} rejected
                  </button>
                )}

                <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
                  <button onClick={() => setPanel(null)} className="text-sm text-zinc-500 hover:text-zinc-300">Cancel</button>
                  <Button
                    size="sm"
                    onClick={grabRelease}
                    disabled={!selectedGuid || loading === "grab"}
                    className="h-8 px-4 text-sm bg-blue-700 hover:bg-blue-600 gap-2"
                  >
                    {loading === "grab" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Grab release
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {panel === null && refetchOk && (
        <span className="flex items-center gap-1 text-[11px] text-green-400">
          <Check className="w-3 h-3" />
          Search triggered
        </span>
      )}
      {arrError && (
        <span className="flex items-center gap-1 text-[11px] text-amber-400 max-w-52 text-right">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {arrError}
        </span>
      )}
    </div>
  );
}
