"use client";

import { useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useHasMounted } from "@/hooks/use-has-mounted";
import Image from "next/image";
import { Film, Tv2, Loader2, Check, X, ExternalLink } from "@/components/icons";
import Link from "next/link";
import { RequestActions } from "./request-actions";
import { RequestThread } from "@/components/requests/request-thread";
import { OpenInArrLink, arrInstanceLabel } from "./open-in-arr";
import { ManageTitleButton } from "./arr-title/title-manager";
import { manageTabFor } from "@/lib/arr-manage-links";
import { Chip } from "@/components/ui/design";
import { RatingsBar } from "@/components/media/ratings-bar";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { REQUEST_STATUS_TONE } from "@/lib/status-labels";
import { createRefreshGate } from "@/lib/refresh-gate";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import type { WatchGradeSummary } from "@/lib/watch-grade";
import { WatchGradeChip } from "./watch-grade";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

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
  /** Comments on this request (RequestComment); the thread loads on open. */
  commentCount: number;
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
  /** A request id whose comment thread opens on load (?comments=). */
  initialOpenThread?: string;
  requests: GroupedRequestRow[];
  page: number;
  total: number;
  pageSize: number;
  statusFilter?: string;
  typeFilter?: string;
  sort?: string;
  /** Display names for non-default instances, keyed by slug (from the instance registry). */
  instanceNames?: Record<string, string>;
  /** ADMIN viewer: show "Open in Radarr/Sonarr" (the route behind it is ADMIN-only). */
  canOpenArr?: boolean;
  /**
   * Which integrations are switched on. A movie's Open in / Manage icons need
   * Radarr's, a show's Sonarr's: the routes behind them 404 while the
   * integration is off (arrGate). Absent = both on.
   */
  arrServices?: { radarr: boolean; sonarr: boolean };
}

// The first line of every request card — the select checkbox, the title (with its
// Open-in / Manage icons) and the status chip — shares this height and centres its
// content in it, so the three sit on one line instead of each hanging from the top.
const TITLE_LINE_PX = 24;

function formatUserLabel(r: Requester, t: Translator) {
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
          {t("adminQueue.list.discordLinked")}
        </span>
      </>
    );
  }
  return r.userName ?? r.userEmail;
}

const BATCH_ID_CAP = 100; // /api/requests/batch rejects more ids than this per call

function pendingIdsFor(group: GroupedRequestRow) {
  return group.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId);
}

const ACTION_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  height: 28,
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 500,
  border: "1px solid transparent",
  // No `cursor` here: globals.css restores the pointer for every ENABLED
  // button and leaves a disabled one at the default (guardrail 42). An inline
  // pointer kept showing a hand on the greyed batch buttons mid-flight.
  transition: "background 120ms var(--ds-ease)",
};

const ICON_12: CSSProperties = { width: 12, height: 12 };

// A batch-bar button: the shared shape, its own colours, and the spinner in
// place of its icon while `loading`.
function ActionButton({
  loading = false,
  icon,
  style,
  children,
  ...rest
}: {
  loading?: boolean;
  icon?: ReactNode;
  style: CSSProperties;
  children: ReactNode;
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled">) {
  return (
    <button className="ds-hover-tint" type="button" {...rest} style={{ ...ACTION_BTN, ...style }}>
      {loading ? <Loader2 className="animate-spin" style={ICON_12} /> : icon}
      {children}
    </button>
  );
}

const NEUTRAL_BTN: CSSProperties = {
  background: "var(--ds-bg-2)",
  color: "var(--ds-fg-muted)",
  borderColor: "var(--ds-border)",
};

// Admin request queue: groups requests by title, drives per-group + batch
// approve/decline, and paginates. Live-refreshes on request:* SSE events.
export function AdminRequestList({ requests, page, total, pageSize, statusFilter, typeFilter, sort, instanceNames, canOpenArr = false, arrServices, initialOpenThread }: AdminRequestListProps) {
  const router = useRouter();
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const instanceLabel = (slug: string) =>
    instanceNames?.[slug] ?? (slug === "4k" ? "4K" : slug);

  // While a row's title manager is open the list's refresh WAITS: a refresh
  // can drop the row — its status left the ?status= filter, a new request
  // pushed it to the next page — and the dialog with it, unsaved edits and
  // all, or re-prop it mid-edit. The deferred refresh runs once the last
  // manager closes (the Download Queue pauses its poll the same way).
  const [refreshGate] = useState(createRefreshGate);
  const unmountedRef = useRef(false);
  function refreshList() {
    if (refreshGate.request()) router.refresh();
  }

  // Debounced ~500ms so a burst of request:* events (bulk approve, a sync run)
  // coalesces into one refresh — mirrors activity-live-refresher.tsx.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRefresh() {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshList();
    }, 500);
  }
  useLiveEvents((event) => {
    if (event.type === "request:new" || event.type === "request:updated" || event.type === "request:deleted") {
      scheduleRefresh();
    }
  });
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);
  // ManageTitleButton's onActiveChange. Its close arrives from an effect
  // cleanup, also when the list itself is unmounting: nothing is scheduled then.
  function onManagerActive(open: boolean) {
    if (open) return refreshGate.opened();
    if (refreshGate.closed() && !unmountedRef.current) scheduleRefresh();
  }
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchNote, setBatchNote] = useState("");
  const [showBatchNote, setShowBatchNote] = useState<"APPROVED" | "DECLINED" | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [confirmingApprove, setConfirmingApprove] = useState(false);

  // The batch bar hides (but keeps its state) when the selection empties by
  // unchecking boxes or Clear. Reset the armed approve-confirm, the decline
  // note and any error then, so the NEXT selection opens in the neutral state
  // rather than one click away from a batch approve. Adjusted during render
  // (React's "store the previous value" pattern) instead of in an effect.
  const selectionEmpty = selected.size === 0;
  const [prevSelectionEmpty, setPrevSelectionEmpty] = useState(selectionEmpty);
  if (selectionEmpty !== prevSelectionEmpty) {
    setPrevSelectionEmpty(selectionEmpty);
    if (selectionEmpty) {
      setConfirmingApprove(false);
      setShowBatchNote(null);
      setBatchNote("");
      setBatchError(null);
    }
  }

  const allPendingIds = requests.flatMap((g) =>
    g.requesters.filter((r) => r.status === "PENDING").map((r) => r.requestId),
  );
  const allPendingSelected = allPendingIds.length > 0 && allPendingIds.every((id) => selected.has(id));

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
    // The route takes at most BATCH_ID_CAP ids per call. A bigger selection
    // (select-all across a long queue) is sent in sequential chunks; the first
    // refusal stops the run and leaves the unsent + failed ids selected.
    //
    // The checkboxes stay live during the run, so the selection is never
    // replaced with a snapshot: each write below only removes ids this run
    // settled, and a box ticked or unticked meanwhile keeps the admin's choice.
    const allIds = Array.from(selected);
    // Ids in chunks the route answered; minus `stillPending`, they leave the selection.
    const answered: string[] = [];
    const stillPending: string[] = [];
    let arrError: string | undefined;
    const dropSettled = () => {
      const keep = new Set(stillPending);
      const done = answered.filter((id) => !keep.has(id));
      setSelected((prev) => {
        if (!done.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of done) next.delete(id);
        return next;
      });
    };
    // An earlier chunk's push failures stay selected, so their reason must stay
    // on screen beside whatever stopped the run.
    const withEarlier = (message: string) => (arrError ? `${arrError}\n${message}` : message);
    try {
      for (let i = 0; i < allIds.length; i += BATCH_ID_CAP) {
        const chunk = allIds.slice(i, i + BATCH_ID_CAP);
        const res = await fetch(withBasePath("/api/requests/batch"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk, status, adminNote: adminNote || undefined }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setBatchError(withEarlier(rateLimitMessage(res, t) ?? data?.error ?? t("adminQueue.common.requestFailed", { status: res.status })));
          dropSettled();
          refreshList();
          return;
        }
        // A 200 can still carry rows whose Radarr/Sonarr push failed and were rolled
        // back to PENDING. Keep exactly those selected, so the bar (and the reason in
        // it) stays up and they can be retried or declined without re-picking them.
        const data = (await res.json().catch(() => null)) as { arrError?: string; failed?: { id?: unknown }[] } | null;
        for (const f of data?.failed ?? []) if (typeof f.id === "string") stillPending.push(f.id);
        for (const id of chunk) answered.push(id);
        arrError = arrError ?? data?.arrError;
      }
      dropSettled();
      if (arrError) setBatchError(arrError);
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
      refreshList();
    } catch {
      // A network failure mid-run: the chunks answered before it were applied.
      // Drop those; the chunk in flight and the unsent ones stay selected (the
      // refresh, and the list's own pending check, settle whether it landed).
      setBatchError(withEarlier(t("shared.thread.networkError")));
      dropSettled();
      refreshList();
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

  return (
    <div>
      {selected.size > 0 && (
        <BatchBar
          count={selected.size}
          loading={batchLoading}
          error={batchError}
          declining={showBatchNote === "DECLINED"}
          note={batchNote}
          onNoteChange={setBatchNote}
          onDeclining={(open) => {
            setShowBatchNote(open ? "DECLINED" : null);
            if (!open) setBatchNote("");
          }}
          confirmingApprove={confirmingApprove}
          onConfirmingApprove={setConfirmingApprove}
          onApprove={() => batchAction("APPROVED")}
          onDecline={() => batchAction("DECLINED", batchNote)}
          onClear={() => setSelected(new Set())}
        />
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
              {t("adminQueue.list.selectAllPending", { count: allPendingIds.length })}
            </span>
          </label>
        </div>
      )}

      <div className="flex flex-col" style={{ gap: 8 }}>
        {requests.map((group) => (
          <RequestGroupRow
            key={group.groupKey}
            group={group}
            selected={selected}
            onToggle={toggleGroup}
            instanceLabel={instanceLabel}
            canOpenArr={canOpenArr}
            arrServices={arrServices}
            onManagerActive={onManagerActive}
            initialOpenThread={initialOpenThread}
          />
        ))}
      </div>

      {totalPages > 1 && <Pager page={page} totalPages={totalPages} total={total} pageUrl={pageUrl} />}
    </div>
  );
}

// The bar over the list while anything is selected: approve (behind a
// confirm), decline with an optional reason, clear.
function BatchBar({
  count,
  loading,
  error,
  declining,
  note,
  onNoteChange,
  onDeclining,
  confirmingApprove,
  onConfirmingApprove,
  onApprove,
  onDecline,
  onClear,
}: {
  count: number;
  loading: boolean;
  error: string | null;
  declining: boolean;
  note: string;
  onNoteChange: (note: string) => void;
  onDeclining: (open: boolean) => void;
  confirmingApprove: boolean;
  onConfirmingApprove: (armed: boolean) => void;
  onApprove: () => void;
  onDecline: () => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
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
        {t("adminQueue.list.selected", { count })}
      </span>

      {declining ? (
        <>
          {/* Capped at the routes' own limit, so a long reason is stopped here
              rather than refused after submit. */}
          <input
            type="text"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            maxLength={ADMIN_NOTE_MAX}
            placeholder={t("adminQueue.common.declineReason")}
            aria-label={t("adminQueue.actions.declineReasonAria")}
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
          <ActionButton onClick={() => onDeclining(false)} disabled={loading} style={NEUTRAL_BTN}>
            {t("shared.common.cancel")}
          </ActionButton>
          <ActionButton
            onClick={onDecline}
            disabled={loading}
            loading={loading}
            icon={<X style={ICON_12} />}
            style={{ background: "var(--ds-danger)", color: "var(--ds-on-status)" }}
          >
            {t("adminQueue.list.declineN", { count })}
          </ActionButton>
        </>
      ) : confirmingApprove ? (
        <>
          <span style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
            {t("adminQueue.list.approveConfirm", { count })}
          </span>
          <ActionButton onClick={() => onConfirmingApprove(false)} disabled={loading} style={NEUTRAL_BTN}>
            {t("shared.common.cancel")}
          </ActionButton>
          <ActionButton
            onClick={onApprove}
            disabled={loading}
            loading={loading}
            icon={<Check style={ICON_12} />}
            style={{ background: "var(--ds-success)", color: "var(--ds-on-status)" }}
          >
            {t("adminQueue.list.confirmApprove")}
          </ActionButton>
        </>
      ) : (
        <>
          <ActionButton
            onClick={() => onConfirmingApprove(true)}
            disabled={loading}
            loading={loading}
            icon={<Check style={ICON_12} />}
            style={{ background: "var(--ds-success)", color: "var(--ds-on-status)" }}
          >
            {t("adminQueue.list.approveN", { count })}
          </ActionButton>
          <ActionButton
            onClick={() => onDeclining(true)}
            disabled={loading}
            icon={<X style={ICON_12} />}
            style={{
              background: "transparent",
              color: "var(--ds-danger)",
              borderColor: "color-mix(in oklab, var(--ds-danger) 40%, transparent)",
            }}
          >
            {t("adminQueue.list.declineN", { count })}
          </ActionButton>
          <ActionButton
            onClick={onClear}
            disabled={loading}
            style={{
              marginLeft: "auto",
              background: "transparent",
              color: "var(--ds-fg-subtle)",
              borderColor: "var(--ds-border)",
            }}
          >
            {t("adminQueue.list.clear")}
          </ActionButton>
        </>
      )}
      {error && (
        // An earlier chunk's push failures and what stopped the run are one line each.
        <span
          className="w-full whitespace-pre-line"
          style={{ fontSize: 12, color: "var(--ds-danger)" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

// One title's card: every request for it, its actions and the requesters'
// comment threads.
function RequestGroupRow({
  group,
  selected,
  onToggle,
  instanceLabel,
  canOpenArr,
  arrServices,
  onManagerActive,
  initialOpenThread,
}: {
  group: GroupedRequestRow;
  selected: ReadonlySet<string>;
  onToggle: (group: GroupedRequestRow) => void;
  instanceLabel: (slug: string) => string;
  canOpenArr: boolean;
  arrServices?: { radarr: boolean; sonarr: boolean };
  onManagerActive: (open: boolean) => void;
  initialOpenThread?: string;
}) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const pendingIds = pendingIdsFor(group);
  const primaryRequester = group.requesters[0];
  // The representative request: the first whose status is the row's aggregate.
  // Each field falls back to the primary on its own — a representative with no
  // note still shows the primary's note.
  const rep = group.requesters.find((r) => r.status === group.aggregateStatus);
  const representativeId = rep?.requestId ?? primaryRequester.requestId;
  const representativeAdminNote = rep?.adminNote ?? primaryRequester.adminNote;
  // Which Radarr/Sonarr instance the approve picker should read profiles
  // from — follows the same representative request as the rest of the row.
  const representativeInstance = rep?.arrInstance ?? primaryRequester.arrInstance;
  // Open in / Manage for THIS row's service only while its integration is on.
  const showArrLinks =
    canOpenArr && (arrServices?.[group.mediaType === "MOVIE" ? "radarr" : "sonarr"] ?? true);
  const arrService = group.mediaType === "MOVIE" ? "radarr" : "sonarr";
  // Every instance a request of this title names, the default ("") included, once each.
  const groupArrInstances = [...new Set(group.requesters.map((r) => r.arrInstance))];
  const groupInstances = groupArrInstances.filter((slug) => slug !== "");
  const mixedInstances = groupArrInstances.length > 1;
  const groupAllPendingSelected =
    pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 14,
        padding: 14,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {/* The row and the thread are separate flex children of the card: the
          thread used to sit INSIDE the xl:flex-nowrap row with basis-full, so at xl
          it claimed the whole width and squeezed the title column to ~100px. */}
      <div className="flex flex-wrap xl:flex-nowrap items-start" style={{ gap: 14 }}>
      <div
        className="flex items-center shrink-0"
        style={{ height: TITLE_LINE_PX, width: 20 }}
      >
        {pendingIds.length > 0 ? (
          // The label pads the 16px box out to a ~32px touch target
          // without moving it (the negative margin cancels the padding).
          <label className="flex items-center justify-center" style={{ padding: 8, margin: -8 }}>
            <input
              type="checkbox"
              checked={groupAllPendingSelected}
              onChange={() => onToggle(group)}
              aria-label={t("adminQueue.list.selectTitle", { title: group.title })}
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
        <div className="flex items-center gap-1 min-w-0" style={{ minHeight: TITLE_LINE_PX }}>
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
        {/* One Open-in per instance the group's requests sit on — an HD
            and a 4K request for one title are two instances, and the
            icons must name both (guardrail 32), never only a representative. */}
        {showArrLinks && groupArrInstances.map((slug) => (
          <OpenInArrLink
            key={`open:${slug}`}
            service={arrService}
            instance={slug}
            target={{ tmdbId: group.tmdbId }}
            label={t("adminManage.openIn", { name: arrInstanceLabel(arrService, instanceLabel(slug), slug) })}
            iconOnly
          />
        ))}
        {/* Only once it was pushed there: a pending title isn't on the instance yet. */}
        {showArrLinks && groupArrInstances.map((slug) => {
          const onInstance = group.requesters.filter((r) => r.arrInstance === slug);
          const available = onInstance.some((r) => r.status === "AVAILABLE");
          if (!available && !onInstance.some((r) => r.status === "APPROVED")) return null;
          return (
            <ManageTitleButton
              key={`manage:${slug}`}
              service={arrService}
              instance={slug}
              target={{ tmdbId: group.tmdbId }}
              instanceLabel={arrInstanceLabel(arrService, instanceLabel(slug), slug)}
              variant="icon"
              initialTab={manageTabFor(available ? "requestAvailable" : "requestApproved", arrService)}
              onActiveChange={onManagerActive}
            />
          );
        })}
        </div>

        <p
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-subtle)",
            marginTop: 2,
          }}
        >
          {group.mediaType === "MOVIE" ? t("requests.mediaType.movie") : t("requests.mediaType.tv")}
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
                title={t("adminQueue.list.contentRating")}
              >
                {group.ratings.certification}
              </span>
            </>
          )}
          {group.requesters.length > 1 && (
            <>
              {" · "}
              <span style={{ color: "var(--ds-fg-muted)" }}>
                {t("adminQueue.list.requesters", { count: group.requesters.length })}
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
              <span>{formatUserLabel(r, t)}</span>
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
                {mounted ? `· ${new Date(r.createdAt).toLocaleDateString(locale)}` : ""}
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
                  {t(`requests.status.${r.status.toLowerCase()}`)}
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
              <span className="ds-chip ds-chip-plex">{t("adminQueue.list.onPlex")}</span>
            )}
            {group.onJellyfin && (
              <span className="ds-chip ds-chip-jellyfin">{t("adminQueue.list.onJellyfin")}</span>
            )}
            {groupInstances.map((slug) => (
              <span
                key={slug}
                className="ds-chip"
                title={t("adminQueue.list.instanceTitle")}
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

      <div className="hidden sm:inline-flex items-center shrink-0" style={{ height: TITLE_LINE_PX }}>
        <Chip tone={REQUEST_STATUS_TONE[group.aggregateStatus]}>
          {t(`requests.status.${group.aggregateStatus.toLowerCase()}`)}
        </Chip>
      </div>

      {/* Below xl the actions take their own row. An APPROVED row's bar
          (Why? · Search · Pick release · Re-push · Delete, ~490px) and the
          208–224px approve/decline and Why? panels left the title column
          36px wide at a 1024px viewport — the title disappeared. */}
      <div className="flex justify-end basis-full xl:basis-auto xl:shrink-0">
        <RequestActions
          requestId={representativeId}
          currentStatus={group.aggregateStatus}
          mediaType={group.mediaType}
          arrInstance={representativeInstance}
          arrInstanceName={instanceLabel(representativeInstance)}
          existingAdminNote={representativeAdminNote}
          groupPendingIds={pendingIds.length > 1 ? pendingIds : undefined}
        />
      </div>

      </div>

      {/* One collapsed thread per requester: a group can hold several
          people's requests for the same title, and each conversation is
          private to its own requester. Nothing loads until it is opened. */}
      <div>
        {group.requesters.map((r) => (
          <div key={r.requestId} className="flex flex-col items-start">
            {group.requesters.length > 1 && (
              <span style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 6 }}>
                {formatUserLabel(r, t)}
              </span>
            )}
            <RequestThread
              requestId={r.requestId}
              viewerIsManager
              requestNote={r.note}
              declineNote={r.status === "DECLINED" ? r.adminNote : null}
              initialCount={r.commentCount}
              defaultOpen={initialOpenThread === r.requestId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Previous / Next as links (middle-click, new tab, prefetch); an end with no
// page is a disabled button, as in the shared PaginationBar.
function Pager({
  page,
  totalPages,
  total,
  pageUrl,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageUrl: (p: number) => string;
}) {
  const t = useT();
  return (
    <div
      className="flex items-center justify-between"
      style={{ marginTop: 24 }}
    >
      <p
        className="ds-mono"
        style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
      >
        {t("adminQueue.list.pageOf", { total, page, pages: totalPages })}
      </p>
      <div className="flex items-center gap-2">
        <PagerLink href={page > 1 ? pageUrl(page - 1) : null}>{t("adminQueue.list.previous")}</PagerLink>
        <PagerLink href={page < totalPages ? pageUrl(page + 1) : null}>{t("adminQueue.list.next")}</PagerLink>
      </div>
    </div>
  );
}

function PagerLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (href === null) {
    return (
      <button
        type="button"
        disabled
        style={{
          ...ACTION_BTN,
          background: "transparent",
          color: "var(--ds-fg-disabled)",
          borderColor: "var(--ds-border)",
          cursor: "not-allowed",
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <Link href={href} className="ds-hover-tint" style={{ ...ACTION_BTN, ...NEUTRAL_BTN }}>
      {children}
    </Link>
  );
}
