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

export interface Requester {
  requestId: string;
  status: string;
  note: string | null;
  adminNote: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string;
  userDiscordId: string | null;
  userRequestCount: number;
}

export interface GroupedRequestRow {
  groupKey: string;
  tmdbId: number;
  title: string;
  mediaType: string;
  posterUrl: string | null;
  releaseYear: string | null;
  onPlex: boolean;
  onJellyfin: boolean;
  aggregateStatus: string;
  requesters: Requester[];
}

interface AdminRequestListProps {
  requests: GroupedRequestRow[];
  page: number;
  total: number;
  pageSize: number;
  statusFilter?: string;
  sort?: string;
}

function formatUserLabel(r: Requester) {
  if (r.userEmail.endsWith("@discord.local")) {
    return (
      <>
        <span style={{ color: "var(--ds-accent)" }}>Discord</span>
        {r.userName ? `: ${r.userName}` : ""}
      </>
    );
  }
  if (r.userDiscordId) {
    return (
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
    );
  }
  return r.userName ?? r.userEmail;
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

  const allPendingIds = requests.flatMap((g) =>
    g.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId),
  );
  const allPendingSelected = allPendingIds.length > 0 && allPendingIds.every((id) => selected.has(id));

  function pendingIdsFor(group: GroupedRequestRow) {
    return group.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId);
  }

  function toggleAll() {
    if (allPendingSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        allPendingIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...allPendingIds]));
    }
  }

  function toggleGroup(group: GroupedRequestRow) {
    const ids = pendingIdsFor(group);
    if (ids.length === 0) return;
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
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

      {allPendingIds.length > 0 && (
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
            Select all pending ({allPendingIds.length})
          </span>
        </div>
      )}

      <div className="flex flex-col" style={{ gap: 8 }}>
        {requests.map((group) => {
          const pendingIds = pendingIdsFor(group);
          const primaryRequester = group.requesters[0];
          const representativeId =
            group.requesters.find((r) => r.status === group.aggregateStatus)?.requestId ??
            primaryRequester.requestId;
          const representativeAdminNote =
            group.requesters.find((r) => r.status === group.aggregateStatus)?.adminNote ??
            primaryRequester.adminNote;
          const groupAllPendingSelected =
            pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

          return (
            <div
              key={group.groupKey}
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
                {pendingIds.length > 0 ? (
                  <input
                    type="checkbox"
                    checked={groupAllPendingSelected}
                    onChange={() => toggleGroup(group)}
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
                {group.posterUrl ? (
                  <Image
                    src={group.posterUrl}
                    alt={group.title}
                    fill
                    className="object-cover"
                    sizes="40px"
                  />
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ color: "var(--ds-fg-subtle)" }}
                  >
                    {group.mediaType === "MOVIE" ? (
                      <Film style={{ width: 14, height: 14 }} />
                    ) : (
                      <Tv2 style={{ width: 14, height: 14 }} />
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <Link
                  href={`/${group.mediaType === "MOVIE" ? "movie" : "tv"}/${group.tmdbId}`}
                  className="group inline-flex items-center gap-1 font-medium transition-colors truncate max-w-full"
                  style={{ color: "var(--ds-fg)" }}
                >
                  <span className="truncate">{group.title}</span>
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
                  {group.mediaType === "MOVIE" ? "MOVIE" : "TV"}
                  {group.releaseYear ? ` · ${group.releaseYear}` : ""}
                  {group.requesters.length > 1 && (
                    <>
                      {" · "}
                      <span style={{ color: "var(--ds-fg-muted)" }}>
                        {group.requesters.length} requesters
                      </span>
                    </>
                  )}
                </p>

                <div
                  className="flex flex-col"
                  style={{ marginTop: 6, gap: 3 }}
                >
                  {group.requesters.map((r) => (
                    <div
                      key={r.requestId}
                      className="flex items-center flex-wrap ds-mono"
                      style={{
                        fontSize: 10.5,
                        gap: 6,
                        color: "var(--ds-fg-muted)",
                      }}
                    >
                      <span>{formatUserLabel(r)}</span>
                      {r.userRequestCount > 1 && (
                        <span
                          className="inline-flex items-center font-medium"
                          style={{
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
                      <span style={{ color: "var(--ds-fg-subtle)" }}>
                        · {new Date(r.createdAt).toLocaleDateString()}
                      </span>
                      {group.requesters.length > 1 && r.status !== group.aggregateStatus && (
                        <span
                          className="inline-flex items-center"
                          style={{
                            padding: "0 5px",
                            borderRadius: 3,
                            fontSize: 9.5,
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                            background: "var(--ds-bg-3)",
                            color: "var(--ds-fg-subtle)",
                          }}
                        >
                          {r.status}
                        </span>
                      )}
                      {r.note && (
                        <span
                          className="italic truncate"
                          style={{
                            fontSize: 11,
                            color: "var(--ds-fg-subtle)",
                            maxWidth: 260,
                          }}
                          title={r.note}
                        >
                          &ldquo;{r.note}&rdquo;
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {(group.onPlex || group.onJellyfin) && (
                  <div
                    className="flex items-center flex-wrap"
                    style={{ gap: 4, marginTop: 6 }}
                  >
                    {group.onPlex && (
                      <span className="ds-chip ds-chip-plex">On Plex</span>
                    )}
                    {group.onJellyfin && (
                      <span className="ds-chip ds-chip-jellyfin">On Jellyfin</span>
                    )}
                  </div>
                )}

                {representativeAdminNote && (
                  <p
                    className="italic"
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      color: "var(--ds-fg-subtle)",
                    }}
                  >
                    ↳ {representativeAdminNote}
                  </p>
                )}
              </div>

              <div className="hidden sm:inline-flex shrink-0">
                <Chip tone={STATUS_TONE[group.aggregateStatus]}>
                  {group.aggregateStatus.charAt(0) + group.aggregateStatus.slice(1).toLowerCase()}
                </Chip>
              </div>

              <RequestActions
                requestId={representativeId}
                currentStatus={group.aggregateStatus}
                existingAdminNote={representativeAdminNote}
                groupPendingIds={pendingIds.length > 1 ? pendingIds : undefined}
              />
            </div>
          );
        })}
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
