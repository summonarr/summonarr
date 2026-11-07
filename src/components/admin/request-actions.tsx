"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, Ban, AlertTriangle, RefreshCw, RotateCcw, Search, MessageSquare, Trash2, Users, Settings, Download, Activity } from "@/components/icons";
import { ReleaseSearchDialog } from "./release-search-dialog";
import { RequestArrStatusPanel } from "./request-arr-status";
import { withBasePath } from "@/lib/base-path";
import { ADMIN_NOTE_MAX } from "@/lib/request-limits";
import { useT } from "@/components/i18n/i18n-provider";

interface RequestActionsProps {
  requestId: string;
  currentStatus: string;
  /** "MOVIE" | "TV" — picks Radarr vs Sonarr for the quality-profile picker. */
  mediaType: string;
  /** Instance slug this request targets ("" = default, "4k", or a named slug) — picks which instance's profiles to list. */
  arrInstance: string;
  /** That instance's display name — the "Why?" panel names the instance it checked. */
  arrInstanceName?: string | null;
  existingAdminNote?: string | null;
  /** When set, approve/decline apply to all of these PENDING request IDs via the batch endpoint. */
  groupPendingIds?: string[];
}

type LoadingKind = "APPROVED" | "DECLINED" | "RETRY" | "SEARCH" | "NOTE" | "DELETE";
type QualityProfile = { id: number; name: string };
type QualityOverride = { qualityProfileId: number; qualityProfileName: string };

// The request's server calls and the state they share: which call is in
// flight, the optimistic status, and the last Radarr/Sonarr answer. A handler
// that closes a form answers whether it went through; the form is the caller's.
function useRequestMutations({ requestId, currentStatus, groupPendingIds }: Pick<RequestActionsProps, "requestId" | "currentStatus" | "groupPendingIds">) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState<LoadingKind | null>(null);

  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
  const status = optimisticStatus ?? currentStatus;

  // Drop the optimistic value as soon as the server-rendered status changes.
  //
  // router.refresh() keeps this component's state (the row is keyed by title,
  // not by status), so without this reset an old optimistic value would hide
  // the real status forever — e.g. a row that sync moved to AVAILABLE, or a
  // group sent back to PENDING by a new requester, would keep showing the
  // APPROVED buttons until a hard reload.
  useEffect(() => {
    setOptimisticStatus(null);
  }, [currentStatus]);
  const [arrError, setArrError] = useState<string | null>(null);
  const [retryOk, setRetryOk] = useState(false);
  const groupIds = groupPendingIds && groupPendingIds.length > 1 ? groupPendingIds : null;

  async function updateStatus(
    newStatus: "APPROVED" | "DECLINED",
    adminNote?: string,
    permanent?: boolean,
    override?: QualityOverride,
  ): Promise<boolean> {
    setLoading(newStatus);
    setArrError(null);
    setRetryOk(false);
    setOptimisticStatus(newStatus);
    try {
      const res = groupIds
        ? await fetch(withBasePath("/api/requests/batch"), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ids: groupIds,
              status: newStatus,
              ...(adminNote !== undefined ? { adminNote } : {}),
              ...(permanent !== undefined ? { permanent } : {}),
            }),
          })
        : await fetch(withBasePath(`/api/requests/${requestId}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: newStatus,
              ...(adminNote !== undefined ? { adminNote } : {}),
              ...(permanent !== undefined ? { permanent } : {}),
              ...(override ? { qualityProfileId: override.qualityProfileId, qualityProfileName: override.qualityProfileName } : {}),
            }),
          });
      if (!res.ok) {
        setOptimisticStatus(null);
        // `message` first — the batch route answers a >25-requester permanent
        // decline with { error: "permanent-batch-too-large", message: "<sentence>" }
        // and the slug alone is noise (the issue components already read it so).
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setArrError(data.message ?? data.error ?? t("adminQueue.actions.updateFailed"));
        return false;
      }
      const data = (await res.json().catch(() => ({}))) as { arrError?: string; arrPushOutcomeUnknown?: unknown };
      if (data.arrError) {
        setArrError(data.arrError);
        // A Radarr/Sonarr push that FAILED rolls the approval back to PENDING
        // server-side (single and batch alike). currentStatus then never
        // changes, so the reset effect above never fires and the optimistic
        // APPROVED would mask the real PENDING row — hiding Approve/Decline and
        // offering a Re-push the route refuses ("only valid for APPROVED").
        // Drop the optimistic value and let the refreshed server status render.
        // A push that got NO answer (`arrPushOutcomeUnknown`) leaves the request
        // APPROVED — the arr may have the title — so the optimistic value is right.
        if (data.arrPushOutcomeUnknown !== true) setOptimisticStatus(null);
      }
      router.refresh();
      return true;
    } catch {
      setOptimisticStatus(null);
      setArrError(t("shared.thread.networkError"));
      return false;
    } finally {
      setLoading(null);
    }
  }

  // Search and Re-push: one PATCH with a different flag. A 200 can still carry
  // `arrError` (nothing missing to search, the push failed again).
  async function patchRequestAction(kind: "SEARCH" | "RETRY", body: { search: true } | { retry: true }) {
    setLoading(kind);
    setArrError(null);
    setRetryOk(false);
    try {
      const res = await fetch(withBasePath(`/api/requests/${requestId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { arrError?: string; error?: string; message?: string };
        setArrError(err.arrError ?? err.message ?? err.error ?? t("adminQueue.common.requestFailed", { status: res.status }));
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { arrError?: string };
      if (data.arrError) {
        setArrError(data.arrError);
      } else {
        setRetryOk(true);
      }
    } catch {
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
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
    setLoading("NOTE");
    const targetIds = groupIds ?? [requestId];
    let saved = 0;
    let failure: string | null = null;
    try {
      for (const id of targetIds) {
        let res: Response;
        try {
          res = await fetch(withBasePath(`/api/requests/${id}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ adminNote: note }),
          });
        } catch {
          failure = t("shared.thread.networkError");
          break;
        }
        if (res.ok) {
          saved++;
          continue;
        }
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        failure = data.message ?? data.error ?? t("adminQueue.actions.saveReplyFailed");
        if (res.status === 429) break;
      }
    } finally {
      setLoading(null);
    }
    if (saved > 0) router.refresh();
    if (failure === null) return true;
    setArrError(saved > 0 ? t("adminQueue.actions.saveReplyPartial", { saved, total: targetIds.length }) : failure);
    return false;
  }

  async function deleteRequest() {
    setLoading("DELETE");
    try {
      const res = await fetch(withBasePath(`/api/requests/${requestId}`), { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setArrError(data.message ?? data.error ?? t("adminQueue.actions.deleteFailed"));
        return;
      }
      router.refresh();
    } catch {
      // The caller always closes the confirm dialog, so show an error here —
      // otherwise a network failure would look like the admin just cancelled.
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
  }

  return { status, loading, arrError, setArrError, retryOk, updateStatus, triggerSearch, retryPush, saveReply, deleteRequest };
}

export function RequestActions({ requestId, currentStatus, mediaType, arrInstance, arrInstanceName, existingAdminNote, groupPendingIds }: RequestActionsProps) {
  const { status, loading, arrError, setArrError, retryOk, updateStatus, triggerSearch, retryPush, saveReply, deleteRequest } =
    useRequestMutations({ requestId, currentStatus, groupPendingIds });

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Interactive search ("Pick release") on the request's own instance.
  const [showReleases, setShowReleases] = useState(false);
  // "Why?" — the inline Radarr/Sonarr status panel, loaded on click only.
  const [showStatus, setShowStatus] = useState(false);
  const statusPanelId = useId();
  // The panel reads Radarr/Sonarr when it MOUNTS, so it must never re-mount
  // without a click. Leaving the APPROVED branch (a sync marking the row
  // AVAILABLE, a decline elsewhere) unmounts it; close it then, or its return
  // would read again on its own. The delete confirm closes it the same way.
  useEffect(() => {
    if (status !== "APPROVED") setShowStatus(false);
  }, [status]);
  const [showDeclineNote, setShowDeclineNote] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState(existingAdminNote ?? "");
  const [replySaved, setReplySaved] = useState(false);

  // Approve-with-a-specific-quality-profile picker (single requests only).
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [profiles, setProfiles] = useState<QualityProfile[] | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<number | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [approvingProfileId, setApprovingProfileId] = useState<number | null>(null);
  // Bumped by every reset below: a profile read still out when the instance
  // changes answers for the OLD instance, and its answer is dropped.
  const profilesRequest = useRef(0);
  const t = useT();

  // The cached list belongs to ONE instance. `arrInstance` is the row's
  // representative request's instance and is re-derived on every refresh, so
  // when the pending default-instance request is declined elsewhere and a 4K
  // request becomes the representative, a list loaded for the default would
  // otherwise be offered for the 4K approve — and default profile ids exist on
  // every instance, so the approve would land with a profile the admin never
  // picked. Drop the cache, any read still in flight, and the open picker,
  // whose rows no longer apply, whenever the instance changes.
  useEffect(() => {
    profilesRequest.current++;
    setProfiles(null);
    setDefaultProfileId(null);
    setProfilesError(null);
    setProfilesLoading(false);
    setShowProfilePicker(false);
  }, [arrInstance, mediaType]);

  async function openProfilePicker() {
    setShowProfilePicker(true);
    setArrError(null);
    if (profiles) return; // already loaded for this instance
    const token = ++profilesRequest.current;
    const current = () => token === profilesRequest.current;
    setProfilesLoading(true);
    setProfilesError(null);
    try {
      const query = new URLSearchParams({ mediaType, instance: arrInstance });
      const res = await fetch(withBasePath(`/api/requests/quality-profiles?${query.toString()}`));
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (current()) setProfilesError(data.message ?? data.error ?? t("adminQueue.actions.profilesFailed"));
        return;
      }
      const data: { qualityProfiles: QualityProfile[]; defaultId: number | null } = await res.json();
      if (!current()) return;
      setProfiles(data.qualityProfiles);
      setDefaultProfileId(data.defaultId);
    } catch {
      if (current()) setProfilesError(t("adminQueue.actions.profilesFailed"));
    } finally {
      if (current()) setProfilesLoading(false);
    }
  }

  async function decide(newStatus: "APPROVED" | "DECLINED", adminNote?: string, permanent?: boolean, override?: QualityOverride) {
    if (await updateStatus(newStatus, adminNote, permanent, override)) {
      setShowDeclineNote(false);
      setDeclineNote("");
      setShowProfilePicker(false);
    }
  }

  async function submitReply() {
    setReplySaved(false);
    if (await saveReply(replyText.trim())) {
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
      saving={loading === "NOTE"}
      saved={replySaved}
    />
  );

  if (status === "APPROVED") {
    if (showDeleteConfirm) {
      return (
        <DeleteConfirm
          deleting={loading === "DELETE"}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={async () => {
            await deleteRequest();
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
        loading={loading}
        showStatus={showStatus}
        onToggleStatus={() => setShowStatus((v) => !v)}
        onCloseStatus={() => setShowStatus(false)}
        statusPanelId={statusPanelId}
        onSearch={triggerSearch}
        onRepush={retryPush}
        onPickRelease={() => { setArrError(null); setShowReleases(true); }}
        showReleases={showReleases}
        onReleasesChange={setShowReleases}
        onAskDelete={() => { setShowStatus(false); setShowDeleteConfirm(true); }}
        retryOk={retryOk}
        arrError={arrError}
        reply={reply}
      />
    );
  }

  if (status === "DECLINED") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={() => decide("APPROVED")}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          {loading === "APPROVED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          {t("adminQueue.actions.reapprove")}
        </Button>
        <ArrErrorNote message={arrError} />
        {reply}
      </div>
    );
  }

  if (status === "AVAILABLE") {
    return (
      <div className="flex flex-col items-end gap-1">
        {/* There is nothing to action once a request is available. This label
            only shows on small screens: the row's own status chip is
            `hidden sm:inline-flex`, so exactly one "Available" shows at any
            width. */}
        <span className="sm:hidden text-xs text-indigo-400 font-medium">{t("requests.status.available")}</span>
        {reply}
        {/* saveReply is reachable from this branch too, so it needs somewhere to
            report a failure — otherwise a reply on an available title silently
            does nothing. */}
        <ArrErrorNote message={arrError} />
      </div>
    );
  }

  if (showDeclineNote) {
    return (
      <DeclineNoteForm
        note={declineNote}
        onNote={setDeclineNote}
        loading={loading}
        onCancel={() => { setShowDeclineNote(false); setDeclineNote(""); }}
        onDeny={(permanent) => decide("DECLINED", declineNote.trim() || undefined, permanent)}
        arrError={arrError}
      />
    );
  }

  if (showProfilePicker) {
    return (
      <ProfilePicker
        profilesLoading={profilesLoading}
        profilesError={profilesError}
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        loading={loading}
        approvingProfileId={approvingProfileId}
        onPick={(p) => { setApprovingProfileId(p.id); void decide("APPROVED", undefined, undefined, { qualityProfileId: p.id, qualityProfileName: p.name }); }}
        onCancel={() => { setShowProfilePicker(false); setArrError(null); }}
        arrError={arrError}
      />
    );
  }

  const allowProfilePick = (groupPendingIds?.length ?? 0) <= 1;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Wraps like the decline-note row above: below sm the actions cell is
          the card's full width (~315px at 375px), and Approve / "Approve as…" /
          Decline run to ~340px in German. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          onClick={() => decide("APPROVED")}
          disabled={loading !== null}
          className="h-7 px-3 text-xs bg-green-600 text-[var(--ds-on-status)] hover:bg-green-600/90 gap-1"
        >
          {loading === "APPROVED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          {t("adminQueue.actions.approve")}
        </Button>
        {allowProfilePick && (
          <Button
            size="sm"
            variant="outline"
            onClick={openProfilePicker}
            disabled={loading !== null}
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
          onClick={() => setShowDeclineNote(true)}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400 gap-1"
        >
          <X className="w-3 h-3" />
          {t("adminQueue.actions.decline")}
        </Button>
      </div>
      <ArrErrorNote message={arrError} />
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
  saved,
}: {
  open: boolean;
  hasNote: boolean;
  onOpen: () => void;
  onCancel: () => void;
  text: string;
  onText: (text: string) => void;
  onSave: () => void;
  saving: boolean;
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
              disabled={saving}
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

function ApprovedActions({
  requestId,
  mediaType,
  arrInstance,
  arrInstanceName,
  loading,
  showStatus,
  onToggleStatus,
  onCloseStatus,
  statusPanelId,
  onSearch,
  onRepush,
  onPickRelease,
  showReleases,
  onReleasesChange,
  onAskDelete,
  retryOk,
  arrError,
  reply,
}: {
  requestId: string;
  mediaType: string;
  arrInstance: string;
  arrInstanceName?: string | null;
  loading: LoadingKind | null;
  showStatus: boolean;
  onToggleStatus: () => void;
  onCloseStatus: () => void;
  statusPanelId: string;
  onSearch: () => Promise<void>;
  onRepush: () => Promise<void>;
  onPickRelease: () => void;
  showReleases: boolean;
  onReleasesChange: (open: boolean) => void;
  onAskDelete: () => void;
  retryOk: boolean;
  arrError: string | null;
  reply: ReactNode;
}) {
  const t = useT();
  return (
    // Full width below sm while the status panel is open, so it can use the row.
    <div className={`flex flex-col items-end gap-1 ${showStatus ? "w-full sm:w-auto" : ""}`}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onToggleStatus}
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
          onClick={onSearch}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          {loading === "SEARCH" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          {t("adminQueue.actions.search")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onPickRelease}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          <Download className="w-3 h-3" />
          {t("adminQueue.actions.pickRelease")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onRepush}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          {loading === "RETRY" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          {t("adminQueue.actions.repush")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onAskDelete}
          disabled={loading !== null}
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
          busy={loading !== null}
          onSearch={onSearch}
          onPickRelease={onPickRelease}
          onRepush={onRepush}
          onClose={onCloseStatus}
        />
      )}
      {retryOk && (
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-[11px] text-green-400">
          <Check className="w-3 h-3" />{t("adminQueue.actions.done")}
        </span>
      )}
      <ArrErrorNote message={arrError} />
      {reply}
      <ReleaseSearchDialog open={showReleases} onOpenChange={onReleasesChange} requestId={requestId} mediaType={mediaType} />
    </div>
  );
}

function DeclineNoteForm({
  note,
  onNote,
  loading,
  onCancel,
  onDeny,
  arrError,
}: {
  note: string;
  onNote: (note: string) => void;
  loading: LoadingKind | null;
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
          disabled={loading !== null}
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
          disabled={loading !== null}
          className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
          title={t("adminQueue.actions.denyAllowTitle")}
        >
          {loading === "DECLINED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
          {t("adminQueue.actions.denyAllow")}
        </Button>
        <Button
          size="sm"
          onClick={() => onDeny(true)}
          disabled={loading !== null}
          className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
          title={t("adminQueue.actions.denyPermanentTitle")}
        >
          {loading === "DECLINED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
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
  profilesLoading,
  profilesError,
  profiles,
  defaultProfileId,
  loading,
  approvingProfileId,
  onPick,
  onCancel,
  arrError,
}: {
  profilesLoading: boolean;
  profilesError: string | null;
  profiles: QualityProfile[] | null;
  defaultProfileId: number | null;
  loading: LoadingKind | null;
  approvingProfileId: number | null;
  onPick: (profile: QualityProfile) => void;
  onCancel: () => void;
  arrError: string | null;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-end gap-2 w-56">
      <span className="text-xs text-zinc-400">{t("adminQueue.actions.approveWithProfile")}</span>
      {profilesLoading ? (
        // The spinner alone is silent to a screen reader.
        <span role="status" aria-live="polite" className="flex items-center">
          <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
          <span className="sr-only">{t("adminQueue.actions.profilesLoading")}</span>
        </span>
      ) : profilesError ? (
        <ArrErrorNote message={profilesError} className="" />
      ) : (profiles?.length ?? 0) === 0 ? (
        <span className="text-[11px] text-zinc-500 text-right">{t("adminQueue.actions.noProfiles")}</span>
      ) : (
        <div className="flex flex-col items-stretch gap-1 w-full">
          {(profiles ?? []).map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant="outline"
              onClick={() => onPick(p)}
              disabled={loading !== null}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-200 hover:bg-zinc-800 justify-between gap-2"
            >
              <span className="flex items-center gap-1 truncate">
                {loading === "APPROVED" && approvingProfileId === p.id ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : null}
                <span className="truncate">{p.name}</span>
              </span>
              {p.id === defaultProfileId && <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">{t("adminQueue.actions.defaultProfile")}</span>}
            </Button>
          ))}
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={onCancel}
        disabled={loading !== null}
        className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-500 hover:text-zinc-100"
      >
        {t("shared.common.cancel")}
      </Button>
      <ArrErrorNote message={arrError} className="max-w-56" />
    </div>
  );
}

export function SyncButton() {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleSync() {
    setLoading(true);
    setResult(null);
    setIsError(false);
    try {
      // ONE call. /api/sync already does a full Jellyfin sync of every server,
      // so a second call to /api/sync/jellyfin would only repeat work and race
      // this one (guardrail 36).
      const res = await fetch(withBasePath("/api/sync"), { method: "POST" });

      // These annotations are a claim, not a check — res.json() is `any`, so
      // nothing here is validated by the compiler. Read the fields defensively.
      const data = (await res.json().catch(() => ({}))) as {
        marked?: number; plexMarked?: number; jellyfinMarked?: number;
        skipped?: boolean; error?: string;
        failedSources?: string[]; skippedSources?: string[];
      };

      // { skipped: true } (HTTP 200, no counts) means another sync — the hourly
      // cron or a Plex-triggered run — already holds the lock. Check it first,
      // because none of the count fields are present in that answer.
      if (data.skipped) {
        setResult(t("adminQueue.sync.alreadyRunning"));
        return;
      }
      if (!res.ok) {
        setIsError(true);
        setResult(data.error ?? t("adminQueue.sync.failedStatus", { status: res.status }));
        return;
      }

      // A degraded run answers 200 WITH `error` set — some configured source
      // failed while the rest refreshed normally. Report per source and STILL
      // refresh: the rows that did update are the whole reason for the click.
      const failed = new Set(data.failedSources ?? []);
      const skipped = new Set(data.skippedSources ?? []);

      // Report per server, never summed: a title on both servers is counted
      // once by each, so adding them would count it twice (guardrail 36).
      const parts = ([["Plex", "plex", data.plexMarked], ["Jellyfin", "jellyfin", data.jellyfinMarked]] as const)
        .filter(([, key]) => !skipped.has(key))
        .map(([name, key, count]) =>
          failed.has(key) ? t("adminQueue.sync.sourceFailed", { name }) : t("adminQueue.sync.sourceMarked", { name, marked: count ?? 0 }),
        );

      // A *arr outage is worth saying even though its count is not per-server.
      // Display names, not the wire slugs — "Plex 3 · radarr failed" read as a typo.
      for (const [name, key] of [["Radarr", "radarr"], ["Sonarr", "sonarr"]] as const) {
        if (failed.has(key)) parts.push(t("adminQueue.sync.sourceFailed", { name }));
      }

      setIsError(failed.size > 0);
      setResult(parts.length > 0 ? parts.join(" · ") : t("adminQueue.sync.noServers"));
      router.refresh();
    } catch {
      setIsError(true);
      setResult(t("adminQueue.sync.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={loading}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        {loading ? t("adminQueue.sync.syncing") : t("adminQueue.sync.syncNow")}
      </Button>
      <SyncResultNote result={result} isError={isError} />
    </div>
  );
}

export function SyncRolesButton() {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleSync() {
    setLoading(true);
    setResult(null);
    setIsError(false);
    try {
      const res = await fetch(withBasePath("/api/discord/sync-roles"), { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { synced?: number; error?: string };
      // res.ok first: an error status carrying no `error` key (or a non-JSON
      // body from a reverse proxy) otherwise reported "Synced 0 users".
      if (!res.ok || data.error) {
        setIsError(true);
        setResult(data.error ?? t("adminQueue.sync.failedStatus", { status: res.status }));
      } else {
        setResult(t("adminQueue.sync.syncedUsers", { count: data.synced ?? 0 }));
      }
    } catch {
      setIsError(true);
      setResult(t("adminQueue.sync.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={loading}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <Users className={`w-4 h-4 ${loading ? "animate-pulse" : ""}`} />
        {loading ? t("adminQueue.sync.syncing") : t("adminQueue.sync.syncDiscordRoles")}
      </Button>
      <SyncResultNote result={result} isError={isError} />
    </div>
  );
}

// The outcome line beside both sync buttons: an alert for a failure, a status
// otherwise.
function SyncResultNote({ result, isError }: { result: string | null; isError: boolean }) {
  if (!result) return null;
  return (
    <span
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`text-xs ${isError ? "text-red-400" : "text-zinc-400"}`}
    >
      {result}
    </span>
  );
}
