"use client";

import { useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useHasMounted } from "@/hooks/use-has-mounted";
import Image from "next/image";
import { AlertTriangle, Film, Tv2, Loader2, Check, X, ExternalLink } from "@/components/icons";
import Link from "next/link";
import { RequestActions } from "./request-actions";
import { actionTargets, chosenActionTarget, type RequestMediaType } from "./request-action-rules";
import { StyledSelect } from "@/components/ui/styled-select";
import { RequestThread } from "@/components/requests/request-thread";
import { OpenInArrLink, arrInstanceLabel } from "./open-in-arr";
import { ManageTitleButton } from "./arr-title/title-manager";
import { manageTabFor } from "@/lib/arr-manage-links";
import { Chip } from "@/components/ui/design";
import { RatingsBar } from "@/components/media/ratings-bar";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, LONG_RUN_TIMEOUT_MS, jsonInit, type FetchJsonFailure } from "@/lib/client/fetch-json";
import { REQUEST_STATUS_LABEL_KEY, REQUEST_STATUS_TONE } from "@/lib/status-labels";
import { createRefreshGate } from "@/lib/refresh-gate";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import type { WatchGradeSummary } from "@/lib/watch-grade";
import { WatchGradeChip } from "./watch-grade";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import {
  BatchAnswer,
  NO_PROGRESS,
  batchErrorText,
  idChunks,
  offPageCount,
  pendingIdsFor,
  pendingIdsOf,
  pruneSelection,
  recordChunk,
  settledIds,
  titlesFor,
  type BatchProgress,
} from "./request-batch";

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
  mediaType: RequestMediaType;
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

// A status's label; one the map doesn't know shows as stored, never as a
// catalog key built at runtime that may not exist.
function statusLabel(status: string, t: Translator): string {
  const key = REQUEST_STATUS_LABEL_KEY[status];
  return key ? t(key) : status;
}

// Why a batch run stopped, in the viewer's language. The route's 429 carries no
// Retry-After, so it gets the generic "slow down"; any other refusal its own
// reason; no answer at all the network line.
function batchStopText(res: FetchJsonFailure, t: Translator): string {
  if (res.kind === "http") {
    if (res.status === 429) return t("shared.rateLimited.generic");
    return res.error || t("adminQueue.common.requestFailed", { status: res.status });
  }
  if (res.kind === "invalid") return t("adminQueue.common.requestFailed", { status: res.status });
  return t("shared.thread.networkError");
}

// One batch run: the selected ids in chunks the route accepts, in order. The
// first refusal (or no answer) stops it: what the route answered before that
// was applied, the chunk in flight and the unsent ones were not (or may not
// have been — the refresh and the list's own pending check settle it).
async function sendBatch(
  ids: readonly string[],
  status: "APPROVED" | "DECLINED",
  adminNote: string | undefined,
  signal: AbortSignal,
): Promise<{ progress: BatchProgress; stop: FetchJsonFailure | null }> {
  let progress = NO_PROGRESS;
  for (const chunk of idChunks(ids)) {
    const res = await fetchJson(withBasePath("/api/requests/batch"), {
      init: jsonInit("PATCH", { ids: chunk, status, adminNote: adminNote || undefined }),
      schema: BatchAnswer,
      signal,
      // An approval pushes each title to Radarr/Sonarr before the route
      // answers: a long run is still working, not failed (guardrail 37a).
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
    if (!res.ok) return { progress, stop: res };
    progress = recordChunk(progress, chunk, res.data);
  }
  return { progress, stop: null };
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

// The list's refreshes. While a row's title manager is open the list's refresh
// WAITS: a refresh can drop the row — its status left the ?status= filter, a
// new request pushed it to the next page — and the dialog with it, unsaved
// edits and all, or re-prop it mid-edit. The deferred refresh runs once the
// last manager closes (the Download Queue pauses its poll the same way).
function useListRefresh() {
  const router = useRouter();
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
  }, {
    // The stream has no replay: a request event emitted while it was down (the
    // server recycles it hourly) never arrives, so re-read once it is back.
    onReconnect: scheduleRefresh,
  });
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);
  // ManageTitleButton's onActiveChange, and the row's Pick release dialog's
  // (RequestActions' onDialogActive). Its close arrives from an effect
  // cleanup, also when the list itself is unmounting: nothing is scheduled then.
  function onManagerActive(open: boolean) {
    if (open) return refreshGate.opened();
    if (refreshGate.closed() && !unmountedRef.current) scheduleRefresh();
  }
  // The batch route emits request:updated per id BEFORE it responds, so by the
  // time a run ends the SSE handler has already armed a 500ms refresh. Cancel
  // it so the two collapse into the run's one immediate refresh — which stays
  // as the fallback for when the SSE singleton is closed.
  function refreshNow() {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    refreshList();
  }
  return { refreshNow, onManagerActive };
}

// The batch selection: request ids, kept across pages (the bar names those on
// other pages), checked live while a batch runs.
function useSelection(requests: GroupedRequestRow[], filterKey: string, batchRunning: boolean) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Read by the prune below. Declared (and so run) before it, so a list that
  // arrives in the same commit a run starts is already judged as mid-run.
  const batchRunningRef = useRef(batchRunning);
  useEffect(() => {
    batchRunningRef.current = batchRunning;
  });

  // A new status or type filter starts a new selection: what was picked under
  // the old one may not be shown at all now, and a batch would act on it
  // unseen. (Paging keeps it: the bar says how many are on other pages.)
  // Adjusted during render (React's "store the previous value" pattern).
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    if (selected.size > 0) setSelected(new Set());
  }

  const allPendingIds = pendingIdsOf(requests);
  const allPendingSelected = allPendingIds.length > 0 && allPendingIds.every((id) => selected.has(id));

  // Drop selected ids whose request is no longer PENDING (e.g. another admin
  // approved it, or its owner deleted it). Without this the "N selected"
  // count stays wrong, and because the selection survives page changes, stale
  // ids could pile up and push a real batch over the route's 100-id limit.
  //
  // We can only judge ids for rows on THIS page. An id missing from `requests`
  // may just be on another page (selecting across pages is allowed), so a
  // missing id is kept.
  //
  // Not while a batch runs: the route claims every row APPROVED before it
  // pushes, and the list refresh that claim triggers lands mid-run. Pruning
  // then would drop the rows whose push goes on to fail (they roll back to
  // PENDING and must stay selected for another try) and, with the selection
  // emptied, hide the bar that shows why. The run's own refresh re-reads the
  // list when it ends, and that one prunes.
  useEffect(() => {
    if (batchRunningRef.current) return;
    setSelected((prev) => pruneSelection(prev, requests));
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

  // Removes only `done` from the CURRENT selection (a functional update), so a
  // box ticked or unticked while a batch ran keeps the admin's choice.
  function dropSettled(done: readonly string[]) {
    setSelected((prev) => {
      if (!done.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of done) next.delete(id);
      return next;
    });
  }

  return { selected, setSelected, allPendingIds, allPendingSelected, toggleAll, toggleGroup, dropSettled };
}

// Admin request queue: groups requests by title, drives per-group + batch
// approve/decline, and paginates. Live-refreshes on request:* SSE events.
export function AdminRequestList({ requests, page, total, pageSize, statusFilter, typeFilter, sort, instanceNames, canOpenArr = false, arrServices, initialOpenThread }: AdminRequestListProps) {
  const t = useT();
  const batchRun = useAsyncAction();
  const batchLoading = batchRun.busy("batch");
  const { selected, setSelected, allPendingIds, allPendingSelected, toggleAll, toggleGroup, dropSettled } =
    useSelection(requests, `${statusFilter ?? ""}|${typeFilter ?? ""}`, batchLoading);
  const instanceLabel = (slug: string) =>
    instanceNames?.[slug] ?? (slug === "4k" ? "4K" : slug);
  const { refreshNow, onManagerActive } = useListRefresh();
  const [batchNote, setBatchNote] = useState("");
  const [showBatchNote, setShowBatchNote] = useState<"APPROVED" | "DECLINED" | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  // A batch's adds that got no answer: shown above the list, not in the bar —
  // those requests stay APPROVED, so they leave the selection and the bar.
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
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

  async function batchAction(status: "APPROVED" | "DECLINED", adminNote?: string) {
    setBatchError(null);
    setBatchNotice(null);
    // The checkboxes stay live during the run, so the selection is never
    // replaced with a snapshot: the run only removes the ids it settled, and a
    // box ticked or unticked meanwhile keeps the admin's choice.
    const run = await batchRun.run(
      "batch",
      (signal) => sendBatch(Array.from(selected), status, adminNote, signal),
      { ifBusy: "skip" },
    );
    // Skipped (a run is going) or unmounted: nothing to apply.
    if (!run) return;
    const { progress, stop } = run;
    // One way out, whatever happened: drop what was settled, keep on screen
    // every chunk's push failures (those rows stay selected) beside whatever
    // stopped the run, and refresh.
    dropSettled(settledIds(progress));
    setBatchError(batchErrorText(progress, stop ? batchStopText(stop, t) : null));
    setBatchNotice(outcomeUnknownNotice(progress.outcomeUnknown));
    if (!stop) {
      setShowBatchNote(null);
      setBatchNote("");
      setConfirmingApprove(false);
    }
    refreshNow();
  }

  // The adds that got no answer, by title where this page shows them.
  function outcomeUnknownNotice(ids: readonly string[]): string | null {
    if (ids.length === 0) return null;
    const { titles, unknown } = titlesFor(ids, requests);
    const names = unknown > 0 ? [...titles, t("adminQueue.list.onOtherPages", { count: unknown })] : titles;
    return t("adminQueue.list.outcomeUnknown", { count: ids.length, titles: names.join(", ") });
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
      {batchNotice && (
        <div
          role="status"
          className="flex items-start gap-2 text-amber-400"
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            fontSize: 12,
            borderRadius: 8,
            background: "color-mix(in oklab, var(--ds-warning) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-warning) 30%, transparent)",
          }}
        >
          <AlertTriangle aria-hidden style={{ ...ICON_12, flexShrink: 0, marginTop: 2 }} />
          <span className="flex-1 min-w-0">{batchNotice}</span>
          <button
            type="button"
            className="ds-hover-tint"
            onClick={() => setBatchNotice(null)}
            aria-label={t("shared.common.dismiss")}
            style={{ border: 0, background: "transparent", color: "var(--ds-fg-subtle)", padding: 2, borderRadius: 4 }}
          >
            <X aria-hidden style={ICON_12} />
          </button>
        </div>
      )}

      {/* The bar shows a run's error; with nothing selected there is no bar,
          and the reason must not wait for the next tick of a checkbox. */}
      {selected.size === 0 && batchError && (
        <div
          role="alert"
          className="flex items-start gap-2 whitespace-pre-line"
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            fontSize: 12,
            borderRadius: 8,
            color: "var(--ds-danger)",
            background: "color-mix(in oklab, var(--ds-danger) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-danger) 30%, transparent)",
          }}
        >
          <AlertTriangle aria-hidden style={{ ...ICON_12, flexShrink: 0, marginTop: 2 }} />
          <span className="flex-1 min-w-0">{batchError}</span>
          <button
            type="button"
            className="ds-hover-tint"
            onClick={() => setBatchError(null)}
            aria-label={t("shared.common.dismiss")}
            style={{ border: 0, background: "transparent", color: "var(--ds-fg-subtle)", padding: 2, borderRadius: 4 }}
          >
            <X aria-hidden style={ICON_12} />
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <BatchBar
          count={selected.size}
          offPage={offPageCount(selected, requests)}
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
  offPage,
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
  /** Selected ids this page doesn't show: named, so a batch never acts on them unseen. */
  offPage: number;
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
        {offPage > 0 && (
          <span className="ds-mono" style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: "var(--ds-fg-muted)" }}>
            ({t("adminQueue.list.onOtherPages", { count: offPage })})
          </span>
        )}
      </span>

      {declining ? (
        <DeclineControls
          count={count}
          loading={loading}
          note={note}
          onNoteChange={onNoteChange}
          onCancel={() => onDeclining(false)}
          onDecline={onDecline}
        />
      ) : confirmingApprove ? (
        <ConfirmApproveControls
          count={count}
          loading={loading}
          onCancel={() => onConfirmingApprove(false)}
          onApprove={onApprove}
        />
      ) : (
        <IdleControls
          count={count}
          loading={loading}
          onArmApprove={() => onConfirmingApprove(true)}
          onOpenDecline={() => onDeclining(true)}
          onClear={onClear}
        />
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

const APPROVE_BTN: CSSProperties = { background: "var(--ds-success)", color: "var(--ds-on-status)" };

// Decline: the optional reason, Cancel and the decline itself.
function DeclineControls({
  count,
  loading,
  note,
  onNoteChange,
  onCancel,
  onDecline,
}: {
  count: number;
  loading: boolean;
  note: string;
  onNoteChange: (note: string) => void;
  onCancel: () => void;
  onDecline: () => void;
}) {
  const t = useT();
  return (
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
      <ActionButton onClick={onCancel} disabled={loading} style={NEUTRAL_BTN}>
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
  );
}

// The armed approve: one more click approves the whole selection.
function ConfirmApproveControls({
  count,
  loading,
  onCancel,
  onApprove,
}: {
  count: number;
  loading: boolean;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const t = useT();
  return (
    <>
      <span style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
        {t("adminQueue.list.approveConfirm", { count })}
      </span>
      <ActionButton onClick={onCancel} disabled={loading} style={NEUTRAL_BTN}>
        {t("shared.common.cancel")}
      </ActionButton>
      <ActionButton onClick={onApprove} disabled={loading} loading={loading} icon={<Check style={ICON_12} />} style={APPROVE_BTN}>
        {t("adminQueue.list.confirmApprove")}
      </ActionButton>
    </>
  );
}

// Nothing armed: Approve (asks first), Decline (opens the reason), Clear.
function IdleControls({
  count,
  loading,
  onArmApprove,
  onOpenDecline,
  onClear,
}: {
  count: number;
  loading: boolean;
  onArmApprove: () => void;
  onOpenDecline: () => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <>
      <ActionButton onClick={onArmApprove} disabled={loading} loading={loading} icon={<Check style={ICON_12} />} style={APPROVE_BTN}>
        {t("adminQueue.list.approveN", { count })}
      </ActionButton>
      <ActionButton
        onClick={onOpenDecline}
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
  const t = useT();
  // Which request the row's actions are aimed at, when the admin picked one
  // other than the representative (actionTargets). By id, so it survives a
  // refresh only while the group still offers that request.
  const [chosenTargetId, setChosenTargetId] = useState<string | null>(null);
  const pendingIds = pendingIdsFor(group);
  const primaryRequester = group.requesters[0];
  // A group always carries its requests; one that came through empty has
  // nothing to show or act on, and must not take the list down with it.
  if (!primaryRequester) return null;
  // The representative request: the first whose status is the row's aggregate.
  // Each field falls back to the primary on its own — a representative with no
  // note still shows the primary's note.
  const rep = group.requesters.find((r) => r.status === group.aggregateStatus);
  const representativeAdminNote = rep?.adminNote ?? primaryRequester.adminNote;
  // The request the actions act on: the representative unless the admin aimed
  // them at another of the group's (status, instance) pairs.
  const targets = actionTargets(group.requesters, group.aggregateStatus);
  const target = chosenActionTarget(targets, chosenTargetId) ?? primaryRequester;
  const targetIsRepresentative = target.requestId === targets[0]?.requestId;
  // Open in / Manage for THIS row's service only while its integration is on.
  const showArrLinks =
    canOpenArr && (arrServices?.[group.mediaType === "MOVIE" ? "radarr" : "sonarr"] ?? true);
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

      <PosterThumb group={group} />

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
        {showArrLinks && (
          <ArrTitleIcons
            group={group}
            groupArrInstances={groupArrInstances}
            instanceLabel={instanceLabel}
            onManagerActive={onManagerActive}
          />
        )}
        </div>

        <MetaLine group={group} />

        {group.ratings && <GroupRatings ratings={group.ratings} />}

        <div
          className="flex flex-col"
          style={{ marginTop: 6, gap: 3 }}
        >
          {group.requesters.map((r) => (
            <RequesterLine
              key={r.requestId}
              r={r}
              aggregateStatus={group.aggregateStatus}
              several={group.requesters.length > 1}
              mixedInstances={mixedInstances}
              instanceLabel={instanceLabel}
            />
          ))}
        </div>

        <AvailabilityChips group={group} groupInstances={groupInstances} instanceLabel={instanceLabel} />

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
          {statusLabel(group.aggregateStatus, t)}
        </Chip>
      </div>

      {/* Below xl the actions take their own row. An APPROVED row's bar
          (Why? · Search · Pick release · Re-push · Delete, ~490px) and the
          208–224px approve/decline and Why? panels left the title column
          36px wide at a 1024px viewport — the title disappeared. */}
      <div className="flex justify-end basis-full xl:basis-auto xl:shrink-0">
        <div className="flex flex-col items-end" style={{ gap: 6 }}>
          {targets.length > 1 && (
            <StyledSelect
              compact
              value={target.requestId}
              onChange={(e) => setChosenTargetId(e.target.value)}
              aria-label={t("adminQueue.list.actOn")}
              title={t("adminQueue.list.actOn")}
              className="w-auto md:text-xs"
            >
              {targets.map((r) => (
                <option key={r.requestId} value={r.requestId}>
                  {statusLabel(r.status, t)} · {r.arrInstance === "" ? t("adminQueue.list.defaultInstance") : instanceLabel(r.arrInstance)}
                </option>
              ))}
            </StyledSelect>
          )}
          <RequestActions
            // A picked target starts from clean state: the representative's
            // open panel or half-typed note must not act on another request.
            key={targetIsRepresentative ? "representative" : target.requestId}
            requestId={target.requestId}
            currentStatus={target.status}
            mediaType={group.mediaType}
            arrInstance={target.arrInstance}
            arrInstanceName={instanceLabel(target.arrInstance)}
            existingAdminNote={targetIsRepresentative ? representativeAdminNote : target.adminNote}
            groupPendingIds={pendingIds.length > 1 ? pendingIds : undefined}
            onDialogActive={onManagerActive}
          />
        </div>
      </div>

      </div>

      <RequesterThreads requesters={group.requesters} initialOpenThread={initialOpenThread} />
    </div>
  );
}

function GroupRatings({ ratings }: { ratings: MediaRatings }) {
  return (
    <div style={{ marginTop: 6 }}>
      <RatingsBar
        size="sm"
        compact
        imdbId={ratings.imdbId}
        imdbRating={ratings.imdbRating}
        imdbVotes={ratings.imdbVotes}
        rottenTomatoes={ratings.rottenTomatoes}
        rtAudienceScore={ratings.rtAudienceScore}
        metacritic={ratings.metacritic}
        traktRating={ratings.traktRating}
        letterboxdRating={ratings.letterboxdRating}
        mdblistScore={ratings.mdblistScore}
        malRating={ratings.malRating}
        rogerEbertRating={ratings.rogerEbertRating}
        voteAverage={ratings.voteAverage ?? undefined}
      />
    </div>
  );
}

// One collapsed thread per requester: a group can hold several people's
// requests for the same title, and each conversation is private to its own
// requester. Nothing loads until it is opened.
function RequesterThreads({ requesters, initialOpenThread }: { requesters: Requester[]; initialOpenThread?: string }) {
  const t = useT();
  return (
    <div>
      {requesters.map((r) => (
        <div key={r.requestId} className="flex flex-col items-start">
          {requesters.length > 1 && (
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
  );
}

function PosterThumb({ group }: { group: GroupedRequestRow }) {
  return (
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
  );
}

// Open in / Manage beside the title, for the row's own service (the caller
// gates on its integration). One Open-in per instance the group's requests sit
// on — an HD and a 4K request for one title are two instances, and the icons
// must name both (guardrail 32), never only a representative.
function ArrTitleIcons({
  group,
  groupArrInstances,
  instanceLabel,
  onManagerActive,
}: {
  group: GroupedRequestRow;
  groupArrInstances: string[];
  instanceLabel: (slug: string) => string;
  onManagerActive: (open: boolean) => void;
}) {
  const t = useT();
  const arrService = group.mediaType === "MOVIE" ? "radarr" : "sonarr";
  return (
    <>
      {groupArrInstances.map((slug) => (
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
      {groupArrInstances.map((slug) => {
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
    </>
  );
}

// The small square tags of a row (the content rating, a request count, an
// instance, a status): one shape, each with its own colours.
const SMALL_TAG: CSSProperties = {
  padding: "0 5px",
  borderRadius: 3,
  fontSize: 9.5,
};
const INSTANCE_TINT: CSSProperties = {
  background: "color-mix(in oklab, var(--ds-accent) 14%, transparent)",
  color: "var(--ds-accent-text)",
};

// "Movie · 1999 · R · 3 requesters"
function MetaLine({ group }: { group: GroupedRequestRow }) {
  const t = useT();
  return (
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
              ...SMALL_TAG,
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
  );
}

// One requester: who, their watch grade and request count, when, and — when
// the group mixes them — the instance and a status that differs from the row's.
function RequesterLine({
  r,
  aggregateStatus,
  several,
  mixedInstances,
  instanceLabel,
}: {
  r: Requester;
  aggregateStatus: string;
  several: boolean;
  mixedInstances: boolean;
  instanceLabel: (slug: string) => string;
}) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  return (
    <div
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
          style={{ ...SMALL_TAG, textTransform: "uppercase", letterSpacing: 0.4, ...INSTANCE_TINT }}
        >
          {instanceLabel(r.arrInstance)}
        </span>
      )}
      {several && r.status !== aggregateStatus && (
        <span
          className="inline-flex items-center"
          style={{
            ...SMALL_TAG,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            background: "var(--ds-bg-3)",
            color: "var(--ds-fg-subtle)",
          }}
        >
          {statusLabel(r.status, t)}
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
  );
}

// Where the title already is (Plex, Jellyfin) and the named instances its
// requests target.
function AvailabilityChips({
  group,
  groupInstances,
  instanceLabel,
}: {
  group: GroupedRequestRow;
  groupInstances: string[];
  instanceLabel: (slug: string) => string;
}) {
  const t = useT();
  if (!group.onPlex && !group.onJellyfin && groupInstances.length === 0) return null;
  return (
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
          style={INSTANCE_TINT}
        >
          {instanceLabel(slug)}
        </span>
      ))}
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
