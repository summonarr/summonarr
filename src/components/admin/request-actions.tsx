"use client";

// One row of the admin request queue: the controls for its status. PENDING
// gets Approve / Approve as… / Decline (a group's approve and decline go to the
// batch route), APPROVED gets Why? / Search / Pick release / Re-push / Delete,
// DECLINED a Re-approve, AVAILABLE nothing but the reply. Every status keeps
// the admin's reply (the note the requester sees).
//
// Each server call is its own keyed action (useAsyncAction): busy per call,
// never one shared slot, so a reply saved during an approve can't re-enable
// the buttons while the approve is still out. Only one call runs at a time.
// What a status gets and what an answer leaves on screen are
// request-action-rules.ts.

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, Ban, AlertTriangle, RotateCcw, Search, MessageSquare, Trash2, Settings, Download, Activity } from "@/components/icons";
import { ReleaseSearchDialog } from "./release-search-dialog";
import { RequestArrStatusPanel } from "./request-arr-status";
import { withBasePath } from "@/lib/base-path";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import { useT } from "@/components/i18n/i18n-provider";
import { useAsyncAction } from "@/hooks/use-async-action";
import { fetchJson, ARR_WRITE_TIMEOUT_MS, jsonInit, type FetchJsonFailure } from "@/lib/client/fetch-json";
import type { Translator } from "@/lib/i18n/translate";
import { REQUEST_STATUS_LABEL_KEY } from "@/lib/status-labels";
import { BatchAnswer } from "./request-batch";
import {
  ArrActionAnswer,
  DecisionAnswer,
  QualityProfilesAnswer,
  arrErrorOf,
  decisionOutcome,
  parseRequestStatus,
  type RequestMediaType,
} from "./request-action-rules";

interface RequestActionsProps {
  requestId: string;
  /** The stored status; one the row doesn't know gets no actions (parseRequestStatus). */
  currentStatus: string;
  /** Picks Radarr vs Sonarr for the quality-profile picker. */
  mediaType: RequestMediaType;
  /** Instance slug this request targets ("" = default, "4k", or a named slug) — picks which instance's profiles to list. */
  arrInstance: string;
  /** That instance's display name — the "Why?" panel names the instance it checked. */
  arrInstanceName?: string | null;
  existingAdminNote?: string | null;
  /** When set, approve/decline apply to all of these PENDING request IDs via the batch endpoint. */
  groupPendingIds?: string[];
}

type MutationKind = "APPROVED" | "DECLINED" | "RETRY" | "SEARCH" | "NOTE" | "DELETE";
type QualityProfile = { id: number; name: string };
type QualityOverride = { qualityProfileId: number; qualityProfileName: string };

// No answer came (the network, or the browser gave up): the plain network line.
// A refusal is the route's own reason (`message`, then `error`).
function failureText(res: FetchJsonFailure, t: Translator): string {
  return res.kind === "http" || res.kind === "invalid" ? res.error : t("shared.thread.networkError");
}

// The request's server calls and the state they share: the optimistic status
// and the last Radarr/Sonarr answer. A handler that closes a form answers
// whether it went through; the form is the caller's.
function useRequestMutations({ requestId, currentStatus, groupPendingIds }: Pick<RequestActionsProps, "requestId" | "currentStatus" | "groupPendingIds">) {
  const router = useRouter();
  const t = useT();
  const action = useAsyncAction();
  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
  // Drop the optimistic value as soon as the server-rendered status changes,
  // during render (no effect, so no frame of the stale value).
  //
  // router.refresh() keeps this component's state (the row is keyed by title,
  // not by status), so without this reset an old optimistic value would hide
  // the real status forever — e.g. a row that sync moved to AVAILABLE, or a
  // group sent back to PENDING by a new requester, would keep showing the
  // APPROVED buttons until a hard reload.
  const [statusSeen, setStatusSeen] = useState(currentStatus);
  if (statusSeen !== currentStatus) {
    setStatusSeen(currentStatus);
    setOptimisticStatus(null);
  }
  const status = optimisticStatus ?? currentStatus;
  const [arrError, setArrError] = useState<string | null>(null);
  const [retryOk, setRetryOk] = useState(false);
  const groupIds = groupPendingIds && groupPendingIds.length > 1 ? groupPendingIds : null;

  // Every call starts from a clean line: no earlier failure stays beside a
  // later success.
  function begin(): boolean {
    if (action.anyBusy) return false;
    setArrError(null);
    setRetryOk(false);
    return true;
  }

  async function updateStatus(
    newStatus: "APPROVED" | "DECLINED",
    adminNote?: string,
    permanent?: boolean,
    override?: QualityOverride,
  ): Promise<boolean> {
    if (!begin()) return false;
    setOptimisticStatus(newStatus);
    const fields = {
      status: newStatus,
      ...(adminNote !== undefined ? { adminNote } : {}),
      ...(permanent !== undefined ? { permanent } : {}),
    };
    // The approve waits on the Radarr/Sonarr push, so it gets a long bound: a slow
    // success must not read as a failure and drop the optimistic status.
    const opts = { timeoutMs: ARR_WRITE_TIMEOUT_MS, fallbackError: t("adminQueue.actions.updateFailed") };
    const outcome = await action.run(newStatus, async (signal) => {
      if (groupIds) {
        const res = await fetchJson(withBasePath("/api/requests/batch"), { ...opts, signal, schema: BatchAnswer, init: jsonInit("PATCH", { ids: groupIds, ...fields }) });
        return res.ok ? { ok: true as const, ...decisionOutcome({ arrError: res.data.arrError }) } : { ok: false as const, res };
      }
      const res = await fetchJson(withBasePath(`/api/requests/${requestId}`), {
        ...opts,
        signal,
        schema: DecisionAnswer,
        init: jsonInit("PATCH", {
          ...fields,
          ...(override ? { qualityProfileId: override.qualityProfileId, qualityProfileName: override.qualityProfileName } : {}),
        }),
      });
      return res.ok
        ? { ok: true as const, ...decisionOutcome({ arrError: res.data.arrError, pushOutcomeUnknown: res.data.arrPushOutcomeUnknown }) }
        : { ok: false as const, res };
    }, { ifBusy: "skip" });
    if (!outcome) return false;
    if (!outcome.ok) {
      setOptimisticStatus(null);
      setArrError(failureText(outcome.res, t));
      return false;
    }
    if (outcome.arrError) setArrError(outcome.arrError);
    if (!outcome.keepOptimistic) setOptimisticStatus(null);
    router.refresh();
    return true;
  }

  // Search and Re-push: one PATCH with a different flag. A 200 can still carry
  // `arrError` (nothing missing to search, the push failed again).
  async function patchRequestAction(kind: "SEARCH" | "RETRY", body: { search: true } | { retry: true }) {
    if (!begin()) return;
    const res = await action.run(
      kind,
      (signal) => fetchJson(withBasePath(`/api/requests/${requestId}`), {
        init: jsonInit("PATCH", body),
        schema: ArrActionAnswer,
        signal,
        timeoutMs: ARR_WRITE_TIMEOUT_MS,
        fallbackError: "",
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setArrError(res.kind === "http"
        ? arrErrorOf(res.body) ?? (res.error || t("adminQueue.common.requestFailed", { status: res.status }))
        : res.kind === "invalid" ? t("adminQueue.common.requestFailed", { status: res.status }) : t("shared.thread.networkError"));
      return;
    }
    if (res.data.arrError) setArrError(res.data.arrError);
    else setRetryOk(true);
  }
  const triggerSearch = () => patchRequestAction("SEARCH", { search: true });
  const retryPush = () => patchRequestAction("RETRY", { retry: true });

  // Note-only PATCH (no status): sending the current status alongside the
  // note trips the same-status transition check (422). An empty string
  // clears the stored note server-side.
  //
  // A group saves the note on each pending request IN TURN: every PATCH counts
  // against the per-admin rate limit, so a refusal (429) or a dropped connection
  // stops the rest. Whatever saved is kept and shown (the refresh), and a part-way
  // stop says how many saved.
  async function saveReply(note: string): Promise<boolean> {
    if (!begin()) return false;
    const targetIds = groupIds ?? [requestId];
    const outcome = await action.run("NOTE", async (signal) => {
      let saved = 0;
      let failure: string | null = null;
      for (const id of targetIds) {
        const res = await fetchJson(withBasePath(`/api/requests/${id}`), {
          init: jsonInit("PATCH", { adminNote: note }),
          signal,
          fallbackError: t("adminQueue.actions.saveReplyFailed"),
        });
        if (res.ok) {
          saved++;
          continue;
        }
        if (res.kind === "aborted") break;
        failure = failureText(res, t);
        // No answer, or not the route's: the next one would fare no better.
        if (res.kind !== "http") break;
        if (res.status === 429) break;
      }
      return { saved, failure };
    }, { ifBusy: "skip" });
    if (!outcome) return false;
    const { saved, failure } = outcome;
    if (saved > 0) router.refresh();
    if (failure === null) return true;
    setArrError(saved > 0 ? t("adminQueue.actions.saveReplyPartial", { saved, total: targetIds.length }) : failure);
    return false;
  }

  async function deleteRequest() {
    if (!begin()) return;
    const res = await action.run(
      "DELETE",
      (signal) => fetchJson(withBasePath(`/api/requests/${requestId}`), {
        init: { method: "DELETE" },
        signal,
        fallbackError: t("adminQueue.actions.deleteFailed"),
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    // The caller always closes the confirm dialog, so a failure is shown here —
    // otherwise a network failure would look like the admin just cancelled.
    if (!res.ok) {
      setArrError(failureText(res, t));
      return;
    }
    router.refresh();
  }

  return {
    status,
    busy: (kind: MutationKind) => action.busy(kind),
    anyBusy: action.anyBusy,
    arrError,
    clearArrError: () => setArrError(null),
    retryOk,
    updateStatus,
    triggerSearch,
    retryPush,
    saveReply,
    deleteRequest,
  };
}

type RequestMutations = ReturnType<typeof useRequestMutations>;

type ProfileState =
  | { key: string; phase: "loading" }
  | { key: string; phase: "error"; error: string }
  | { key: string; phase: "ready"; profiles: QualityProfile[]; defaultId: number | null };

// The PENDING forms: the decline reason and the approve-with-profile picker.
// They live with the row, not with the PENDING controls, because a decision
// flips the row optimistically: a failed decline comes back to its form, note
// and all, with the error under it.
//
// The profile list belongs to ONE instance (`mediaType:arrInstance`).
// `arrInstance` is the row's representative request's instance and is
// re-derived on every refresh, so when the pending default-instance request is
// declined elsewhere and a 4K request becomes the representative, a list
// loaded for the default would otherwise be offered for the 4K approve — and
// default profile ids exist on every instance, so the approve would land with
// a profile the admin never picked. The list, the open picker and any read
// still out are keyed by the instance, so a change of instance leaves them all
// behind: nothing answers for an instance the row has since left.
function usePendingForms({ mediaType, arrInstance, m }: { mediaType: RequestMediaType; arrInstance: string; m: RequestMutations }) {
  const t = useT();
  const [showDeclineNote, setShowDeclineNote] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const profileKey = `${mediaType}:${arrInstance}`;
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [profileState, setProfileState] = useState<ProfileState | null>(null);
  const [approvingProfileId, setApprovingProfileId] = useState<number | null>(null);
  const profiles = profileState?.key === profileKey ? profileState : null;

  async function openProfilePicker() {
    setPickerFor(profileKey);
    m.clearArrError();
    if (profiles?.phase === "ready" || profiles?.phase === "loading") return; // already loaded (or loading) for this instance
    const key = profileKey;
    setProfileState({ key, phase: "loading" });
    const query = new URLSearchParams({ mediaType, instance: arrInstance });
    const res = await fetchJson(withBasePath(`/api/requests/quality-profiles?${query.toString()}`), {
      schema: QualityProfilesAnswer,
      fallbackError: t("adminQueue.actions.profilesFailed"),
    });
    const next: ProfileState = res.ok
      ? { key, phase: "ready", profiles: res.data.qualityProfiles, defaultId: res.data.defaultId }
      : { key, phase: "error", error: res.kind === "http" ? res.error : t("adminQueue.actions.profilesFailed") };
    // Only over the read it started: a newer read for this instance, or one for another, keeps its own.
    setProfileState((prev) => (prev?.key === key && prev.phase === "loading" ? next : prev));
  }

  async function decide(newStatus: "APPROVED" | "DECLINED", adminNote?: string, permanent?: boolean, override?: QualityOverride) {
    if (await m.updateStatus(newStatus, adminNote, permanent, override)) {
      setShowDeclineNote(false);
      setDeclineNote("");
      setPickerFor(null);
    }
  }

  return {
    decide,
    openProfilePicker,
    pickerOpen: pickerFor === profileKey,
    closePicker: () => { setPickerFor(null); m.clearArrError(); },
    profiles,
    approvingProfileId,
    pickProfile: (p: QualityProfile) => {
      setApprovingProfileId(p.id);
      void decide("APPROVED", undefined, undefined, { qualityProfileId: p.id, qualityProfileName: p.name });
    },
    showDeclineNote,
    openDecline: () => setShowDeclineNote(true),
    cancelDecline: () => { setShowDeclineNote(false); setDeclineNote(""); },
    declineNote,
    setDeclineNote,
  };
}

export function RequestActions({ requestId, currentStatus, mediaType, arrInstance, arrInstanceName, existingAdminNote, groupPendingIds }: RequestActionsProps) {
  const t = useT();
  const m = useRequestMutations({ requestId, currentStatus, groupPendingIds });
  const forms = usePendingForms({ mediaType, arrInstance, m });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState(existingAdminNote ?? "");
  const [replySaved, setReplySaved] = useState(false);

  async function submitReply() {
    setReplySaved(false);
    if (await m.saveReply(replyText.trim())) {
      setShowReply(false);
      setReplySaved(true);
    }
  }

  const reply = (
    <ReplyBlock
      open={showReply}
      hasNote={!!existingAdminNote}
      // Starts from the stored note every time: the row survives the refreshes
      // that bring a newer note (another admin, a decline reason), and a stale
      // draft saved over it would overwrite — or, blank, clear — it.
      onOpen={() => { setReplyText(existingAdminNote ?? ""); setShowReply(true); setReplySaved(false); }}
      onCancel={() => setShowReply(false)}
      text={replyText}
      onText={setReplyText}
      onSave={submitReply}
      saving={m.busy("NOTE")}
      disabled={m.anyBusy}
      saved={replySaved}
    />
  );

  const status = parseRequestStatus(m.status);
  switch (status) {
    case "APPROVED":
      // The delete confirm replaces the controls, so the Why? panel and the
      // release dialog (ApprovedActions' own state) close with them.
      if (showDeleteConfirm) {
        return (
          <DeleteConfirm
            deleting={m.busy("DELETE")}
            onCancel={() => setShowDeleteConfirm(false)}
            onConfirm={async () => {
              await m.deleteRequest();
              setShowDeleteConfirm(false);
            }}
          />
        );
      }
      return (
        <ApprovedActions
          requestId={requestId}
          mediaType={mediaType}
          arrInstance={arrInstance}
          arrInstanceName={arrInstanceName}
          m={m}
          onAskDelete={() => setShowDeleteConfirm(true)}
          reply={reply}
        />
      );

    case "DECLINED":
      return (
        <div className="flex flex-col items-end gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => forms.decide("APPROVED")}
            disabled={m.anyBusy}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
          >
            {m.busy("APPROVED") ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            {t("adminQueue.actions.reapprove")}
          </Button>
          <ArrErrorNote message={m.arrError} />
          {reply}
        </div>
      );

    case "AVAILABLE":
      return (
        <div className="flex flex-col items-end gap-1">
          {/* There is nothing to action once a request is available. This label
              only shows on small screens: the row's own status chip is
              `hidden sm:inline-flex`, so exactly one "Available" shows at any
              width. */}
          <span className="sm:hidden text-xs text-indigo-400 font-medium">{t(REQUEST_STATUS_LABEL_KEY.AVAILABLE)}</span>
          {reply}
          {/* saveReply is reachable from this branch too, so it needs somewhere to
              report a failure — otherwise a reply on an available title silently
              does nothing. */}
          <ArrErrorNote message={m.arrError} />
        </div>
      );

    case "PENDING":
      return <PendingActions m={m} forms={forms} allowProfilePick={(groupPendingIds?.length ?? 0) <= 1} reply={reply} />;

    case null:
      // A status this row doesn't know: no decision controls, only the reply.
      return (
        <div className="flex flex-col items-end gap-1">
          {reply}
          <ArrErrorNote message={m.arrError} />
        </div>
      );
  }
}

function PendingActions({
  m,
  forms,
  allowProfilePick,
  reply,
}: {
  m: RequestMutations;
  forms: ReturnType<typeof usePendingForms>;
  allowProfilePick: boolean;
  reply: ReactNode;
}) {
  const t = useT();
  if (forms.showDeclineNote) {
    return (
      <DeclineNoteForm
        note={forms.declineNote}
        onNote={forms.setDeclineNote}
        declining={m.busy("DECLINED")}
        disabled={m.anyBusy}
        onCancel={forms.cancelDecline}
        onDeny={(permanent) => forms.decide("DECLINED", forms.declineNote.trim() || undefined, permanent)}
        arrError={m.arrError}
      />
    );
  }

  if (forms.pickerOpen) {
    return (
      <ProfilePicker
        profiles={forms.profiles}
        approving={m.busy("APPROVED")}
        disabled={m.anyBusy}
        approvingProfileId={forms.approvingProfileId}
        onPick={forms.pickProfile}
        onCancel={forms.closePicker}
        arrError={m.arrError}
      />
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Wraps like the decline-note row above: below sm the actions cell is
          the card's full width (~315px at 375px), and Approve / "Approve as…" /
          Decline run to ~340px in German. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          onClick={() => forms.decide("APPROVED")}
          disabled={m.anyBusy}
          className="h-7 px-3 text-xs bg-green-600 text-[var(--ds-on-status)] hover:bg-green-600/90 gap-1"
        >
          {m.busy("APPROVED") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          {t("adminQueue.actions.approve")}
        </Button>
        {allowProfilePick && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void forms.openProfilePicker()}
            disabled={m.anyBusy}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800 gap-1"
            title={t("adminQueue.actions.approveAsTitle")}
          >
            <Settings className="w-3 h-3" />
            {t("adminQueue.actions.approveAs")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={forms.openDecline}
          disabled={m.anyBusy}
          className="h-7 px-3 text-xs border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400 gap-1"
        >
          <X className="w-3 h-3" />
          {t("adminQueue.actions.decline")}
        </Button>
      </div>
      <ArrErrorNote message={m.arrError} />
      {reply}
    </div>
  );
}

// A Radarr/Sonarr (or save/delete) failure, under whichever controls are showing.
function ArrErrorNote({ message, className = "max-w-48" }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <span role="alert" aria-live="assertive" className={`flex items-center gap-1 text-[11px] text-amber-400 text-right ${className}`}>
      <AlertTriangle className="w-3 h-3 shrink-0" />{message}
    </span>
  );
}

function ReplyBlock({
  open,
  hasNote,
  onOpen,
  onCancel,
  text,
  onText,
  onSave,
  saving,
  disabled,
  saved,
}: {
  open: boolean;
  hasNote: boolean;
  onOpen: () => void;
  onCancel: () => void;
  text: string;
  onText: (text: string) => void;
  onSave: () => void;
  /** This reply's save is out (its spinner). */
  saving: boolean;
  /** Any of the row's calls is out: one at a time. */
  disabled: boolean;
  saved: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-end gap-1 mt-1">
      {!open ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 rounded px-1.5 py-1 -mr-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <MessageSquare className="w-3 h-3" />
          {hasNote ? t("adminQueue.actions.editReply") : t("adminQueue.actions.reply")}
        </button>
      ) : (
        <div className="flex flex-col items-end gap-1.5 w-48">
          {/* The routes' own cap: a longer note is refused (400) after submit. */}
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value.slice(0, ADMIN_NOTE_MAX))}
            maxLength={ADMIN_NOTE_MAX}
            placeholder={t("adminQueue.actions.replyPlaceholder")}
            aria-label={t("adminQueue.actions.replyAria")}
            rows={2}
            autoFocus
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={onCancel}
              disabled={saving}
              className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-500 hover:text-zinc-100"
            >
              {t("shared.common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={onSave}
              disabled={disabled}
              className="h-6 px-2 text-[11px] bg-indigo-700 hover:bg-indigo-600 gap-1"
            >
              {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
              {t("adminQueue.actions.save")}
            </Button>
          </div>
        </div>
      )}
      {saved && !open && (
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-[11px] text-green-400">
          <Check className="w-3 h-3" />{t("adminQueue.actions.replySaved")}
        </span>
      )}
    </div>
  );
}

function DeleteConfirm({ deleting, onCancel, onConfirm }: { deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-end gap-2">
      <span className="text-xs text-zinc-400">{t("adminQueue.actions.deleteConfirm")}</span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={deleting}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100"
        >
          {t("shared.common.cancel")}
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={deleting}
          className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
        >
          {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          {t("adminQueue.actions.delete")}
        </Button>
      </div>
    </div>
  );
}

// An APPROVED row's controls. The Why? panel and the release dialog are this
// component's own state, so they close whenever it unmounts: the row leaving
// APPROVED (a sync marking it AVAILABLE, a decline elsewhere) or the delete
// confirm taking its place. The panel reads Radarr/Sonarr when it MOUNTS, so
// it must never come back open without a click.
function ApprovedActions({
  requestId,
  mediaType,
  arrInstance,
  arrInstanceName,
  m,
  onAskDelete,
  reply,
}: {
  requestId: string;
  mediaType: RequestMediaType;
  arrInstance: string;
  arrInstanceName?: string | null;
  m: RequestMutations;
  onAskDelete: () => void;
  reply: ReactNode;
}) {
  const t = useT();
  // "Why?" — the inline Radarr/Sonarr status panel, loaded on click only.
  const [showStatus, setShowStatus] = useState(false);
  const statusPanelId = useId();
  // Interactive search ("Pick release") on the request's own instance.
  const [showReleases, setShowReleases] = useState(false);
  const onPickRelease = () => {
    m.clearArrError();
    setShowReleases(true);
  };
  const busy = m.anyBusy;
  return (
    // Full width below sm while the status panel is open, so it can use the row.
    <div className={`flex flex-col items-end gap-1 ${showStatus ? "w-full sm:w-auto" : ""}`}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowStatus((v) => !v)}
          aria-expanded={showStatus}
          aria-controls={showStatus ? statusPanelId : undefined}
          title={t("adminQueue.arrStatus.buttonTitle")}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          <Activity className="w-3 h-3" />
          {t("adminQueue.arrStatus.button")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={m.triggerSearch}
          disabled={busy}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          {m.busy("SEARCH") ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          {t("adminQueue.actions.search")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onPickRelease}
          disabled={busy}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          <Download className="w-3 h-3" />
          {t("adminQueue.actions.pickRelease")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={m.retryPush}
          disabled={busy}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          {m.busy("RETRY") ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          {t("adminQueue.actions.repush")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onAskDelete}
          disabled={busy}
          className="h-7 px-3 text-xs border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400 gap-1"
        >
          <Trash2 className="w-3 h-3" />
          {t("adminQueue.actions.delete")}
        </Button>
      </div>
      {showStatus && (
        <RequestArrStatusPanel
          // A new representative request starts from no verdict: the old
          // one's buttons would act on the new request.
          key={requestId}
          id={statusPanelId}
          requestId={requestId}
          mediaType={mediaType}
          arrInstance={arrInstance}
          arrInstanceName={arrInstanceName}
          busy={busy}
          onSearch={m.triggerSearch}
          onPickRelease={onPickRelease}
          onRepush={m.retryPush}
          onClose={() => setShowStatus(false)}
        />
      )}
      {m.retryOk && (
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-[11px] text-green-400">
          <Check className="w-3 h-3" />{t("adminQueue.actions.done")}
        </span>
      )}
      <ArrErrorNote message={m.arrError} />
      {reply}
      <ReleaseSearchDialog open={showReleases} onOpenChange={setShowReleases} requestId={requestId} mediaType={mediaType} />
    </div>
  );
}

function DeclineNoteForm({
  note,
  onNote,
  declining,
  disabled,
  onCancel,
  onDeny,
  arrError,
}: {
  note: string;
  onNote: (note: string) => void;
  /** The decline is out (its spinners). */
  declining: boolean;
  /** Any of the row's calls is out. */
  disabled: boolean;
  onCancel: () => void;
  onDeny: (permanent: boolean) => void;
  arrError: string | null;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-end gap-2 w-52">
      {/* The routes' own cap: a longer reason is refused (400) after submit. */}
      <textarea
        value={note}
        onChange={(e) => onNote(e.target.value)}
        maxLength={ADMIN_NOTE_MAX}
        placeholder={t("adminQueue.actions.reasonPlaceholder")}
        aria-label={t("adminQueue.actions.declineReasonAria")}
        rows={2}
        className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
      />
      {/* Wraps inside the fixed-width column: the three buttons need ~380px,
          and a non-wrapping row spilled left over the request's title. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={disabled}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100"
        >
          {t("shared.common.cancel")}
        </Button>
        {/* Both denies share the one danger fill (guardrail 42 — red-800/950
            were raw Tailwind in both themes, a near-black slab in light mode);
            "permanent" is told apart by its label and the Ban icon, not a
            darker shade. */}
        <Button
          size="sm"
          onClick={() => onDeny(false)}
          disabled={disabled}
          className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
          title={t("adminQueue.actions.denyAllowTitle")}
        >
          {declining ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          {t("adminQueue.actions.denyAllow")}
        </Button>
        <Button
          size="sm"
          onClick={() => onDeny(true)}
          disabled={disabled}
          className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
          title={t("adminQueue.actions.denyPermanentTitle")}
        >
          {declining ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
          {t("adminQueue.actions.denyPermanent")}
        </Button>
      </div>
      {/* A failed decline leaves this form open, so its error has to be
          shown here or the failure would be silent. */}
      <ArrErrorNote message={arrError} className="" />
    </div>
  );
}

function ProfilePicker({
  profiles,
  approving,
  disabled,
  approvingProfileId,
  onPick,
  onCancel,
  arrError,
}: {
  /** This instance's list, its read, or its failure; null before the first read. */
  profiles: ProfileState | null;
  approving: boolean;
  disabled: boolean;
  approvingProfileId: number | null;
  onPick: (profile: QualityProfile) => void;
  onCancel: () => void;
  arrError: string | null;
}) {
  const t = useT();
  const list = profiles?.phase === "ready" ? profiles.profiles : [];
  const defaultId = profiles?.phase === "ready" ? profiles.defaultId : null;
  return (
    <div className="flex flex-col items-end gap-2 w-56">
      <span className="text-xs text-zinc-400">{t("adminQueue.actions.approveWithProfile")}</span>
      {profiles?.phase === "loading" ? (
        // The spinner alone is silent to a screen reader.
        <span role="status" aria-live="polite" className="flex items-center">
          <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
          <span className="sr-only">{t("adminQueue.actions.profilesLoading")}</span>
        </span>
      ) : profiles?.phase === "error" ? (
        <ArrErrorNote message={profiles.error} className="" />
      ) : list.length === 0 ? (
        <span className="text-[11px] text-zinc-500 text-right">{t("adminQueue.actions.noProfiles")}</span>
      ) : (
        <div className="flex flex-col items-stretch gap-1 w-full">
          {list.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant="outline"
              onClick={() => onPick(p)}
              disabled={disabled}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-200 hover:bg-zinc-800 justify-between gap-2"
            >
              <span className="flex items-center gap-1 truncate">
                {approving && approvingProfileId === p.id ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : null}
                <span className="truncate">{p.name}</span>
              </span>
              {p.id === defaultId && <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">{t("adminQueue.actions.defaultProfile")}</span>}
            </Button>
          ))}
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={onCancel}
        disabled={disabled}
        className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-500 hover:text-zinc-100"
      >
        {t("shared.common.cancel")}
      </Button>
      <ArrErrorNote message={arrError} className="max-w-56" />
    </div>
  );
}
