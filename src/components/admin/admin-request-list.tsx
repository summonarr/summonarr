"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useHasMounted } from "@/hooks/use-has-mounted";
import Image from "next/image";
import { Film, Tv2, Loader2, Check, X, ExternalLink } from "@/components/icons";
import Link from "next/link";
import { RequestActions } from "./request-actions";
import { Chip } from "@/components/ui/design";
import { RatingsBar } from "@/components/media/ratings-bar";
import { withBasePath } from "@/lib/base-path";
import { REQUEST_STATUS_TONE } from "@/lib/status-labels";
import type { WatchGradeSummary } from "@/lib/watch-grade";
import { WatchGradeChip } from "./watch-grade";

export interface Requester {
  requestId: string;
  userId: string;
  // The requester's watch grade (src/lib/watch-grade.ts); null when the feature
  // or play history tracking is off.
  userWatchGrade: WatchGradeSummary | null;
  status: string;
  /** Instance slug the request targets: "" = default, "4k", or a named slug. */
  arrInstance: string;
  note: string | null;
  adminNote: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string;
  userDiscordId: string | null;
  userRequestCount: number;
}

export interface MediaRatings {
  certification: string | null;
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  rtAudienceScore: string | null;
  metacritic: string | null;
  traktRating: string | null;
  letterboxdRating: string | null;
  mdblistScore: string | null;
  malRating: string | null;
  rogerEbertRating: string | null;
  voteAverage: number | null;
}

export interface GroupedRequestRow {
  groupKey: string;
  tmdbId: number;
  title: string;
  mediaType: string;
  posterUrl: string | null;
  releaseYear: string | null;
  ratings: MediaRatings | null;
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
  typeFilter?: string;
  sort?: string;
  /** Display names for non-default instances, keyed by slug (from the instance registry). */
  instanceNames?: Record<string, string>;
}

function formatUserLabel(r: Requester) {
  if (r.userEmail.endsWith("@discord.local")) {
    return (
      <>
        <span style={{ color: "var(--ds-accent-text)" }}>Discord</span>
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
            color: "color-mix(in oklab, var(--ds-accent-text) 60%, transparent)",
          }}
        >
          (Discord linked)
        </span>
      </>
    );
  }
  return r.userName ?? r.userEmail;
}

// Admin request queue: groups requests by title, drives per-group + batch
// approve/decline, and paginates. Live-refreshes on request:* SSE events.
export function AdminRequestList({ requests, page, total, pageSize, statusFilter, typeFilter, sort, instanceNames }: AdminRequestListProps) {
  const router = useRouter();
  const mounted = useHasMounted();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const instanceLabel = (slug: string) =>
    instanceNames?.[slug] ?? (slug === "4k" ? "4K" : slug);

  // Debounced ~500ms so a burst of request:* events (bulk approve, a sync run)
  // coalesces into one refresh — mirrors activity-live-refresher.tsx.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveEvents((event) => {
    if (event.type === "request:new" || event.type === "request:updated" || event.type === "request:deleted") {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        router.refresh();
      }, 500);
    }
  });
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchNote, setBatchNote] = useState("");
  const [showBatchNote, setShowBatchNote] = useState<"APPROVED" | "DECLINED" | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [confirmingApprove, setConfirmingApprove] = useState(false);

  const allPendingIds = requests.flatMap((g) =>
    g.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId),
  );
  const allPendingSelected = allPendingIds.length > 0 && allPendingIds.every((id) => selected.has(id));

  function pendingIdsFor(group: GroupedRequestRow) {
    return group.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId);
  }

  // Drop selected ids whose request is no longer PENDING (e.g. another admin
  // approved it, or its owner deleted it). Without this the "N selected"
  // count stays wrong, and because the selection survives page changes, stale
  // ids could pile up and push a real batch over the route's 100-id limit.
  //
  // We can only judge ids for rows on THIS page. An id missing from `requests`
  // may just be on another page (selecting across pages is allowed), so a
  // missing id is kept.
  useEffect(() => {
    const onPage = new Set(requests.flatMap((g) => g.requesters.map((r) => r.requestId)));
    const pending = new Set(
      requests.flatMap((g) => g.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId)),
    );
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => !onPage.has(id) || pending.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [requests]);

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
    setBatchError(null);
    try {
      const res = await fetch(withBasePath("/api/requests/batch"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), status, adminNote: adminNote || undefined }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setBatchError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      // A 200 can still carry rows whose Radarr/Sonarr push failed and were rolled
      // back to PENDING. Keep exactly those selected, so the bar (and the reason in
      // it) stays up and they can be retried or declined without re-picking them.
      const data = (await res.json().catch(() => null)) as { arrError?: string; failed?: { id?: unknown }[] } | null;
      const stillPending = (data?.failed ?? [])
        .map((f) => f.id)
        .filter((id): id is string => typeof id === "string");
      setSelected(new Set(stillPending));
      if (data?.arrError) setBatchError(data.arrError);
      setShowBatchNote(null);
      setBatchNote("");
      setConfirmingApprove(false);
      // The batch route emits request:updated per id BEFORE it responds, so by
      // the time res.ok resolves the SSE handler above has already armed a 500ms
      // refresh. Cancel it so the two collapse into this one immediate refresh —
      // which stays as the fallback for when the SSE singleton is closed.
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      router.refresh();
    } catch {
      setBatchError("Network error — please try again");
    } finally {
      setBatchLoading(false);
    }
  }

  const totalPages = Math.ceil(total / pageSize);

  function pageUrl(p: number) {
    const params = new URLSearchParams();
    if (p > 1) params.set("page", String(p));
    if (statusFilter) params.set("status", statusFilter);
    if (typeFilter) params.set("type", typeFilter);
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
            style={{ fontSize: 13, color: "var(--ds-accent-text)" }}
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
                className="flex-1 min-w-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  padding: "5px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: "var(--ds-bg-1)",
                  color: "var(--ds-fg)",
                  border: "1px solid var(--ds-border)",
                }}
              />
              <button className="ds-hover-tint"
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
              <button className="ds-hover-tint"
                type="button"
                onClick={() => batchAction("DECLINED", batchNote)}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "var(--ds-danger)",
                  color: "var(--ds-on-status)",
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
          ) : confirmingApprove ? (
            <>
              <span style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
                Approve {selected.size} request{selected.size === 1 ? "" : "s"}?
              </span>
              <button className="ds-hover-tint"
                type="button"
                onClick={() => setConfirmingApprove(false)}
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
              <button className="ds-hover-tint"
                type="button"
                onClick={() => batchAction("APPROVED")}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "var(--ds-success)",
                  color: "var(--ds-on-status)",
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
                Confirm approve
              </button>
            </>
          ) : (
            <>
              <button className="ds-hover-tint"
                type="button"
                onClick={() => setConfirmingApprove(true)}
                disabled={batchLoading}
                style={{
                  ...actionBtn,
                  background: "var(--ds-success)",
                  color: "var(--ds-on-status)",
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
              <button className="ds-hover-tint"
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
              <button className="ds-hover-tint"
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
          {batchError && (
            <span
              className="w-full"
              style={{ fontSize: 12, color: "var(--ds-danger)" }}
            >
              {batchError}
            </span>
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
          <label className="flex items-center" style={{ gap: 12, padding: "4px 0" }}>
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
          </label>
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
          // Which Radarr/Sonarr instance the approve picker should read profiles
          // from — follows the same representative request as the rest of the row.
          const representativeInstance =
            group.requesters.find((r) => r.status === group.aggregateStatus)?.arrInstance ??
            primaryRequester.arrInstance;
          const groupInstances = [...new Set(group.requesters.map((r) => r.arrInstance))].filter(
            (slug) => slug !== "",
          );
          const mixedInstances =
            new Set(group.requesters.map((r) => r.arrInstance)).size > 1;
          const groupAllPendingSelected =
            pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

          return (
            <div
              key={group.groupKey}
              className="flex flex-wrap sm:flex-nowrap items-start"
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
                  // The label pads the 16px box out to a ~32px touch target
                  // without moving it (the negative margin cancels the padding).
                  <label className="flex items-center justify-center" style={{ padding: 8, margin: -8 }}>
                    <input
                      type="checkbox"
                      checked={groupAllPendingSelected}
                      onChange={() => toggleGroup(group)}
                      aria-label={`Select ${group.title}`}
                      className="w-4 h-4"
                      style={{ accentColor: "var(--ds-accent)" }}
                    />
                  </label>
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
                    aria-hidden
                    className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                    style={{
                      width: 12,
                      height: 12,
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
                  {group.ratings?.certification && (
                    <>
                      {" · "}
                      <span
                        className="inline-flex items-center font-medium"
                        style={{
                          padding: "0 5px",
                          borderRadius: 3,
                          fontSize: 9.5,
                          letterSpacing: 0.4,
                          background: "var(--ds-bg-3)",
                          color: "var(--ds-fg-muted)",
                          border: "1px solid var(--ds-border)",
                        }}
                        title="Content rating"
                      >
                        {group.ratings.certification}
                      </span>
                    </>
                  )}
                  {group.requesters.length > 1 && (
                    <>
                      {" · "}
                      <span style={{ color: "var(--ds-fg-muted)" }}>
                        {group.requesters.length} requesters
                      </span>
                    </>
                  )}
                </p>

                {group.ratings && (
                  <div style={{ marginTop: 6 }}>
                    <RatingsBar
                      size="sm"
                      compact
                      imdbId={group.ratings.imdbId}
                      imdbRating={group.ratings.imdbRating}
                      imdbVotes={group.ratings.imdbVotes}
                      rottenTomatoes={group.ratings.rottenTomatoes}
                      rtAudienceScore={group.ratings.rtAudienceScore}
                      metacritic={group.ratings.metacritic}
                      traktRating={group.ratings.traktRating}
                      letterboxdRating={group.ratings.letterboxdRating}
                      mdblistScore={group.ratings.mdblistScore}
                      malRating={group.ratings.malRating}
                      rogerEbertRating={group.ratings.rogerEbertRating}
                      voteAverage={group.ratings.voteAverage ?? undefined}
                    />
                  </div>
                )}

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
                        gap: 8,
                        color: "var(--ds-fg-muted)",
                      }}
                    >
                      <span>{formatUserLabel(r)}</span>
                      <WatchGradeChip
                        userId={r.userId}
                        userLabel={r.userName ?? r.userEmail}
                        summary={r.userWatchGrade}
                        compact
                      />
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
                        {mounted ? `· ${new Date(r.createdAt).toLocaleDateString()}` : ""}
                      </span>
                      {mixedInstances && r.arrInstance !== "" && (
                        <span
                          className="inline-flex items-center"
                          style={{
                            padding: "0 5px",
                            borderRadius: 3,
                            fontSize: 9.5,
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                            background: "color-mix(in oklab, var(--ds-accent) 14%, transparent)",
                            color: "var(--ds-accent-text)",
                          }}
                        >
                          {instanceLabel(r.arrInstance)}
                        </span>
                      )}
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

                {(group.onPlex || group.onJellyfin || groupInstances.length > 0) && (
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
                    {groupInstances.map((slug) => (
                      <span
                        key={slug}
                        className="ds-chip"
                        title="Radarr/Sonarr instance this title was requested on"
                        style={{
                          background: "color-mix(in oklab, var(--ds-accent) 14%, transparent)",
                          color: "var(--ds-accent-text)",
                        }}
                      >
                        {instanceLabel(slug)}
                      </span>
                    ))}
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
                <Chip tone={REQUEST_STATUS_TONE[group.aggregateStatus]}>
                  {group.aggregateStatus.charAt(0) + group.aggregateStatus.slice(1).toLowerCase()}
                </Chip>
              </div>

              {/* Below sm the actions take their own row: their approve/decline
                  panels are 208–224px wide and would crush the title column. */}
              <div className="flex justify-end basis-full sm:basis-auto sm:shrink-0">
                <RequestActions
                  requestId={representativeId}
                  currentStatus={group.aggregateStatus}
                  mediaType={group.mediaType}
                  arrInstance={representativeInstance}
                  existingAdminNote={representativeAdminNote}
                  groupPendingIds={pendingIds.length > 1 ? pendingIds : undefined}
                />
              </div>
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
            <button className="ds-hover-tint"
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
            <button className="ds-hover-tint"
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
