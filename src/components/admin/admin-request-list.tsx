"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import Image from "next/image";
import { Film, Tv2, Loader2, Check, X, ExternalLink } from "lucide-react";
import Link from "next/link";
import { RequestActions } from "./request-actions";
import { Chip } from "@/components/ui/design";
import type { ChipTone } from "@/components/ui/design";

const STATUS_TONE: Record<string, ChipTone> = {
  PENDING: "pending",
  APPROVED: "approved",
  DECLINED: "declined",
  AVAILABLE: "accent",
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

  const actionBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    height: 28,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 500,
    border: "1px solid transparent",
    cursor: "pointer",
    transition: "background 120ms var(--ds-ease)",
  };

  return (
    <div>
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-3"
          style={{
            marginBottom: 12,
            padding: "10px 14px",
            background: "var(--ds-accent-soft)",
            border: "1px solid var(--ds-accent-ring)",
            borderRadius: 8,
          }}
        >
          <span
            className="font-medium"
            style={{ fontSize: 13, color: "var(--ds-accent)" }}
          >
            {selected.size} selected
          </span>

          {showBatchNote === "DECLINED" ? (
            <>
              <input
                type="text"
                value={batchNote}
                onChange={(e) => setBatchNote(e.target.value)}
                placeholder="Decline reason (optional)"
                className="flex-1 min-w-40 focus:outline-none"
                style={{
                  padding: "5px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: "var(--ds-bg-1)",
                  color: "var(--ds-fg)",
                  border: "1px solid var(--ds-border)",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setShowBatchNote(null);
                  setBatchNote("");
                }}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "var(--ds-bg-2)",
                  color: "var(--ds-fg-muted)",
                  borderColor: "var(--ds-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => batchAction("DECLINED", batchNote)}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "var(--ds-danger)",
                  color: "#fff",
                }}
              >
                {batchLoading ? (
                  <Loader2
                    className="animate-spin"
                    style={{ width: 12, height: 12 }}
                  />
                ) : (
                  <X style={{ width: 12, height: 12 }} />
                )}
                Decline {selected.size}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => batchAction("APPROVED")}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "var(--ds-success)",
                  color: "oklch(0.14 0 0)",
                }}
              >
                {batchLoading ? (
                  <Loader2
                    className="animate-spin"
                    style={{ width: 12, height: 12 }}
                  />
                ) : (
                  <Check style={{ width: 12, height: 12 }} />
                )}
                Approve {selected.size}
              </button>
              <button
                type="button"
                onClick={() => setShowBatchNote("DECLINED")}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "transparent",
                  color: "var(--ds-danger)",
                  borderColor:
                    "color-mix(in oklab, var(--ds-danger) 40%, transparent)",
                }}
              >
                <X style={{ width: 12, height: 12 }} />
                Decline {selected.size}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  marginLeft: "auto",
                  background: "transparent",
                  color: "var(--ds-fg-subtle)",
                  borderColor: "var(--ds-border)",
                }}
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {pendingIds.length > 0 && (
        <div
          className="flex items-center"
          style={{
            gap: 12,
            marginBottom: 8,
            padding: "6px 14px",
            borderRadius: 6,
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
          }}
        >
          <input
            type="checkbox"
            checked={allPendingSelected}
            onChange={toggleAll}
            className="w-4 h-4"
            style={{ accentColor: "var(--ds-accent)" }}
          />
          <span
            className="ds-mono"
            style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
          >
            Select all pending ({pendingIds.length})
          </span>
        </div>
      )}

      <div className="flex flex-col" style={{ gap: 8 }}>
        {requests.map((r) => (
          <div
            key={r.id}
            className="flex items-start"
            style={{
              gap: 14,
              padding: 14,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 8,
            }}
          >
            <div
              className="flex items-center shrink-0"
              style={{ paddingTop: 2, width: 20 }}
            >
              {r.status === "PENDING" ? (
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggleOne(r.id)}
                  className="w-4 h-4"
                  style={{ accentColor: "var(--ds-accent)" }}
                />
              ) : (
                <span style={{ width: 16 }} />
              )}
            </div>

            <div
              className="relative shrink-0 overflow-hidden"
              style={{
                width: 40,
                aspectRatio: "2 / 3",
                borderRadius: 4,
                background: "var(--ds-bg-3)",
              }}
            >
              {r.posterUrl ? (
                <Image
                  src={r.posterUrl}
                  alt={r.title}
                  fill
                  className="object-cover"
                  sizes="40px"
                />
              ) : (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ color: "var(--ds-fg-subtle)" }}
                >
                  {r.mediaType === "MOVIE" ? (
                    <Film style={{ width: 14, height: 14 }} />
                  ) : (
                    <Tv2 style={{ width: 14, height: 14 }} />
                  )}
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <Link
                href={`/${r.mediaType === "MOVIE" ? "movie" : "tv"}/${r.tmdbId}`}
                className="group inline-flex items-center gap-1 font-medium transition-colors truncate max-w-full"
                style={{ color: "var(--ds-fg)" }}
              >
                <span className="truncate">{r.title}</span>
                <ExternalLink
                  className="shrink-0 transition-opacity"
                  style={{
                    width: 12,
                    height: 12,
                    opacity: 0,
                    color: "var(--ds-fg-subtle)",
                  }}
                />
              </Link>
              <p
                className="ds-mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--ds-fg-subtle)",
                  marginTop: 2,
                }}
              >
                {r.mediaType === "MOVIE" ? "MOVIE" : "TV"}
                {r.releaseYear ? ` · ${r.releaseYear}` : ""}
                {" · "}
                <span style={{ color: "var(--ds-fg-muted)" }}>
                  {r.userEmail.endsWith("@discord.local") ? (
                    <>
                      <span style={{ color: "var(--ds-accent)" }}>Discord</span>
                      {r.userName ? `: ${r.userName}` : ""}
                    </>
                  ) : r.userDiscordId ? (
                    <>
                      {r.userName ?? r.userEmail}{" "}
                      <span
                        style={{
                          color: "color-mix(in oklab, var(--ds-accent) 60%, transparent)",
                        }}
                      >
                        (Discord linked)
                      </span>
                    </>
                  ) : (
                    (r.userName ?? r.userEmail)
                  )}
                  {r.userRequestCount > 1 && (
                    <span
                      className="inline-flex items-center font-medium"
                      style={{
                        marginLeft: 4,
                        padding: "0 4px",
                        borderRadius: 3,
                        fontSize: 10,
                        background: "var(--ds-bg-3)",
                        color: "var(--ds-fg-muted)",
                      }}
                    >
                      {r.userRequestCount}
                    </span>
                  )}
                </span>
                {" · "}
                <span>{new Date(r.createdAt).toLocaleDateString()}</span>
              </p>

              {(r.onPlex || r.onJellyfin) && (
                <div
                  className="flex items-center flex-wrap"
                  style={{ gap: 4, marginTop: 6 }}
                >
                  {r.onPlex && (
                    <span className="ds-chip ds-chip-plex">On Plex</span>
                  )}
                  {r.onJellyfin && (
                    <span className="ds-chip ds-chip-jellyfin">On Jellyfin</span>
                  )}
                </div>
              )}

              {r.note && (
                <p
                  style={{
                    marginTop: 6,
                    padding: "6px 10px",
                    borderRadius: 4,
                    background: "var(--ds-bg-1)",
                    borderLeft: "2px solid var(--ds-accent-ring)",
                    fontSize: 11.5,
                    color: "var(--ds-fg-muted)",
                  }}
                >
                  &ldquo;{r.note}&rdquo;
                </p>
              )}
              {r.adminNote && (
                <p
                  className="italic"
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: "var(--ds-fg-subtle)",
                  }}
                >
                  ↳ {r.adminNote}
                </p>
              )}
            </div>

            <div className="hidden sm:inline-flex shrink-0">
              <Chip tone={STATUS_TONE[r.status]}>
                {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
              </Chip>
            </div>

            <RequestActions
              requestId={r.id}
              currentStatus={r.status}
              existingAdminNote={r.adminNote}
            />
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div
          className="flex items-center justify-between"
          style={{ marginTop: 24 }}
        >
          <p
            className="ds-mono"
            style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
          >
            {total} total · page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => router.push(pageUrl(page - 1))}
              style={{
                ...actionBtn,
                background: page <= 1 ? "transparent" : "var(--ds-bg-2)",
                color:
                  page <= 1 ? "var(--ds-fg-disabled)" : "var(--ds-fg-muted)",
                borderColor: "var(--ds-border)",
                cursor: page <= 1 ? "not-allowed" : "pointer",
              }}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => router.push(pageUrl(page + 1))}
              style={{
                ...actionBtn,
                background:
                  page >= totalPages ? "transparent" : "var(--ds-bg-2)",
                color:
                  page >= totalPages
                    ? "var(--ds-fg-disabled)"
                    : "var(--ds-fg-muted)",
                borderColor: "var(--ds-border)",
                cursor: page >= totalPages ? "not-allowed" : "pointer",
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
