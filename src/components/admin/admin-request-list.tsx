"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import Image from "next/image";
import { Film, Tv2, Loader2, Check, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { RequestActions } from "./request-actions";

const STATUS_STYLES: Record<string, string> = {
  PENDING:   "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  APPROVED:  "bg-green-500/10 text-green-400 border-green-500/20",
  DECLINED:  "bg-red-500/10 text-red-400 border-red-500/20",
  AVAILABLE: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
};

export interface RequestRow {
  id: string;
  tmdbId: number;
  title: string;
  mediaType: string;
  status: string;
  posterUrl: string | null;
  releaseYear: string | null;
  createdAt: string;
  note: string | null;
  adminNote: string | null;
  userName: string | null;
  userEmail: string;
  userDiscordId: string | null;
  onPlex: boolean;
  onJellyfin: boolean;
  userRequestCount: number;
}

interface AdminRequestListProps {
  requests: RequestRow[];
  page: number;
  total: number;
  pageSize: number;
  statusFilter?: string;
  sort?: string;
}

export function AdminRequestList({ requests, page, total, pageSize, statusFilter, sort }: AdminRequestListProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useLiveEvents((event) => {
    if (event.type === "request:new" || event.type === "request:updated" || event.type === "request:deleted") {
      router.refresh();
    }
  });
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchNote, setBatchNote] = useState("");
  const [showBatchNote, setShowBatchNote] = useState<"APPROVED" | "DECLINED" | null>(null);

  const pendingIds = requests.filter((r) => r.status === "PENDING").map((r) => r.id);
  const allPendingSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  function toggleAll() {
    if (allPendingSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        pendingIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...pendingIds]));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function batchAction(status: "APPROVED" | "DECLINED", adminNote?: string) {
    setBatchLoading(true);
    try {
      const res = await fetch("/api/requests/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), status, adminNote: adminNote || undefined }),
      });
      if (!res.ok) {
        console.error("[admin] batch action failed:", res.status);
        return;
      }
      setSelected(new Set());
      setShowBatchNote(null);
      setBatchNote("");
      router.refresh();
    } finally {
      setBatchLoading(false);
    }
  }

  const totalPages = Math.ceil(total / pageSize);

  function pageUrl(p: number) {
    const params = new URLSearchParams();
    if (p > 1) params.set("page", String(p));
    if (statusFilter) params.set("status", statusFilter);
    if (sort && sort !== "newest") params.set("sort", sort);
    const qs = params.toString();
    return `/admin${qs ? `?${qs}` : ""}`;
  }

  return (
    <div>
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-3">
          <span className="text-sm font-medium text-indigo-300">
            {selected.size} selected
          </span>

          {showBatchNote === "DECLINED" ? (
            <>
              <input
                type="text"
                value={batchNote}
                onChange={(e) => setBatchNote(e.target.value)}
                placeholder="Decline reason (optional)"
                className="flex-1 min-w-40 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setShowBatchNote(null); setBatchNote(""); }}
                disabled={batchLoading}
                className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => batchAction("DECLINED", batchNote)}
                disabled={batchLoading}
                className="h-7 px-3 text-xs bg-red-800 hover:bg-red-700 gap-1"
              >
                {batchLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                Decline {selected.size}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => batchAction("APPROVED")}
                disabled={batchLoading}
                className="h-7 px-3 text-xs bg-green-700 hover:bg-green-600 gap-1"
              >
                {batchLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Approve {selected.size}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowBatchNote("DECLINED")}
                disabled={batchLoading}
                className="h-7 px-3 text-xs border-red-800 text-red-400 hover:bg-red-950 gap-1"
              >
                <X className="w-3 h-3" />
                Decline {selected.size}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelected(new Set())}
                disabled={batchLoading}
                className="h-7 px-3 text-xs border-zinc-700 text-zinc-500 hover:text-white ml-auto"
              >
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {pendingIds.length > 0 && (
        <div className="mb-2 flex items-center gap-3 px-4 py-2 rounded-lg bg-zinc-900/50">
          <input
            type="checkbox"
            checked={allPendingSelected}
            onChange={toggleAll}
            className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
          />
          <span className="text-xs text-zinc-500">Select all pending ({pendingIds.length})</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {requests.map((r) => (
          <div
            key={r.id}
            className="flex items-start gap-4 rounded-lg bg-zinc-900 border border-zinc-800 p-4"
          >
            <div className="flex items-center pt-1 w-5 shrink-0">
              {r.status === "PENDING" ? (
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggleOne(r.id)}
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                />
              ) : (
                <span className="w-4" />
              )}
            </div>

            <div className="relative w-10 h-14 shrink-0 rounded bg-zinc-700 overflow-hidden">
              {r.posterUrl ? (
                <Image src={r.posterUrl} alt={r.title} fill className="object-cover" sizes="40px" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                  {r.mediaType === "MOVIE" ? <Film className="w-4 h-4" /> : <Tv2 className="w-4 h-4" />}
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <Link
                href={`/${r.mediaType === "MOVIE" ? "movie" : "tv"}/${r.tmdbId}`}
                className="group inline-flex items-center gap-1 font-medium text-white hover:text-indigo-300 transition-colors truncate max-w-full"
              >
                <span className="truncate">{r.title}</span>
                <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
              </Link>
              <p className="text-xs text-zinc-400 mt-0.5">
                {r.mediaType === "MOVIE" ? "Movie" : "TV Show"}
                {r.releaseYear ? ` · ${r.releaseYear}` : ""}
                {" · "}
                <span className="text-zinc-500">
                  {r.userEmail.endsWith("@discord.local")
                    ? <><span className="text-indigo-400">Discord</span>{r.userName ? `: ${r.userName}` : ""}</>
                    : r.userDiscordId
                    ? <>{r.userName ?? r.userEmail} <span className="text-indigo-400/60">(Discord linked)</span></>
                    : r.userName ?? r.userEmail}
                  {r.userRequestCount > 1 && (
                    <span className="ml-1 inline-flex items-center px-1 py-0 rounded text-[10px] font-medium bg-zinc-700 text-zinc-400">
                      {r.userRequestCount}
                    </span>
                  )}
                </span>
                {" · "}
                <span className="text-zinc-600">{new Date(r.createdAt).toLocaleDateString()}</span>
              </p>

              {(r.onPlex || r.onJellyfin) && (
                <div className="flex items-center gap-1.5 mt-1">
                  {r.onPlex && (
                    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">
                      On Plex
                    </span>
                  )}
                  {r.onJellyfin && (
                    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      On Jellyfin
                    </span>
                  )}
                </div>
              )}

              {r.note && (
                <p className="mt-1 text-xs text-zinc-400 bg-zinc-800 rounded px-2 py-1 border-l-2 border-indigo-500/50">
                  &ldquo;{r.note}&rdquo;
                </p>
              )}
              {r.adminNote && (
                <p className="mt-1 text-xs text-zinc-500 italic">
                  ↳ {r.adminNote}
                </p>
              )}
            </div>

            <Badge className={`shrink-0 border text-xs font-medium hidden sm:inline-flex ${STATUS_STYLES[r.status]}`}>
              {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
            </Badge>

            <RequestActions requestId={r.id} currentStatus={r.status} existingAdminNote={r.adminNote} />
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-6">
          <p className="text-xs text-zinc-500">
            {total} total · page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => router.push(pageUrl(page - 1))}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white disabled:opacity-40"
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => router.push(pageUrl(page + 1))}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white disabled:opacity-40"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
