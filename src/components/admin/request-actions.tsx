"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, Ban, AlertTriangle, RefreshCw, RotateCcw, Search, MessageSquare, Trash2, Users, Settings } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

interface RequestActionsProps {
  requestId: string;
  currentStatus: string;
  /** "MOVIE" | "TV" — picks Radarr vs Sonarr for the quality-profile picker. */
  mediaType: string;
  /** Instance slug this request targets ("" = default, "4k", or a named slug) — picks which instance's profiles to list. */
  arrInstance: string;
  existingAdminNote?: string | null;
  /** When set, approve/decline apply to all of these PENDING request IDs via the batch endpoint. */
  groupPendingIds?: string[];
}

export function RequestActions({ requestId, currentStatus, mediaType, arrInstance, existingAdminNote, groupPendingIds }: RequestActionsProps) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState<"APPROVED" | "DECLINED" | "RETRY" | "SEARCH" | "NOTE" | "DELETE" | null>(null);

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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [arrError, setArrError] = useState<string | null>(null);
  const [retryOk, setRetryOk] = useState(false);
  const [showDeclineNote, setShowDeclineNote] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState(existingAdminNote ?? "");
  const [replySaved, setReplySaved] = useState(false);

  // Approve-with-a-specific-quality-profile picker (single requests only).
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [profiles, setProfiles] = useState<{ id: number; name: string }[] | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<number | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [approvingProfileId, setApprovingProfileId] = useState<number | null>(null);

  // The cached list belongs to ONE instance. `arrInstance` is the row's
  // representative request's instance and is re-derived on every refresh, so
  // when the pending default-instance request is declined elsewhere and a 4K
  // request becomes the representative, a list loaded for the default would
  // otherwise be offered for the 4K approve (the server only checks the id is a
  // positive integer). Drop the cache — and the open picker, whose rows no
  // longer apply — whenever the instance changes.
  useEffect(() => {
    setProfiles(null);
    setDefaultProfileId(null);
    setProfilesError(null);
    setShowProfilePicker(false);
  }, [arrInstance, mediaType]);

  async function openProfilePicker() {
    setShowProfilePicker(true);
    setArrError(null);
    if (profiles) return; // already loaded for this instance
    setProfilesLoading(true);
    setProfilesError(null);
    try {
      const res = await fetch(withBasePath(`/api/requests/quality-profiles?mediaType=${mediaType}&instance=${encodeURIComponent(arrInstance)}`));
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setProfilesError(data.message ?? data.error ?? t("adminQueue.actions.profilesFailed"));
        return;
      }
      const data: { qualityProfiles: { id: number; name: string }[]; defaultId: number | null } = await res.json();
      setProfiles(data.qualityProfiles);
      setDefaultProfileId(data.defaultId);
    } catch {
      setProfilesError(t("adminQueue.actions.profilesFailed"));
    } finally {
      setProfilesLoading(false);
    }
  }

  async function saveReply() {
    setLoading("NOTE");
    setReplySaved(false);
    try {
      // Note-only PATCH (no status): sending the current status alongside the
      // note trips the same-status transition check (422). An empty string
      // clears the stored note server-side.
      const targetIds = groupPendingIds && groupPendingIds.length > 1 ? groupPendingIds : [requestId];
      const results = await Promise.all(
        targetIds.map((id) =>
          fetch(withBasePath(`/api/requests/${id}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ adminNote: replyText.trim() }),
          }),
        ),
      );
      const failed = results.find((r) => !r.ok);
      if (failed) {
        const data = (await failed.json().catch(() => ({}))) as { error?: string; message?: string };
        setArrError(data.message ?? data.error ?? t("adminQueue.actions.saveReplyFailed"));
        return;
      }
      setShowReply(false);
      setReplySaved(true);
      router.refresh();
    } catch {
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
  }

  async function updateStatus(
    newStatus: "APPROVED" | "DECLINED",
    adminNote?: string,
    permanent?: boolean,
    override?: { qualityProfileId: number; qualityProfileName: string },
  ) {
    setLoading(newStatus);
    setArrError(null);
    setRetryOk(false);
    setOptimisticStatus(newStatus);
    try {
      const isBatch = (groupPendingIds?.length ?? 0) > 1;
      const res = isBatch
        ? await fetch(withBasePath("/api/requests/batch"), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ids: groupPendingIds,
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
        return;
      }
      const data: { arrError?: string } = await res.json().catch(() => ({}));
      if (data.arrError) {
        setArrError(data.arrError);
        // A failed Radarr/Sonarr push rolls the approval back to PENDING
        // server-side (single and batch alike). currentStatus then never
        // changes, so the reset effect above never fires and the optimistic
        // APPROVED would mask the real PENDING row — hiding Approve/Decline and
        // offering a Re-push the route refuses ("only valid for APPROVED").
        // Drop the optimistic value and let the refreshed server status render.
        setOptimisticStatus(null);
      }
      setShowDeclineNote(false);
      setDeclineNote("");
      setShowProfilePicker(false);
      router.refresh();
    } catch {
      setOptimisticStatus(null);
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
  }

  async function triggerSearch() {
    setLoading("SEARCH");
    setArrError(null);
    setRetryOk(false);
    try {
      const res = await fetch(withBasePath(`/api/requests/${requestId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: true }),
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

  async function retryPush() {
    setLoading("RETRY");
    setArrError(null);
    setRetryOk(false);
    try {
      const res = await fetch(withBasePath(`/api/requests/${requestId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retry: true }),
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
      // `finally` always closes the confirm dialog, so show an error here —
      // otherwise a network failure would look like the admin just cancelled.
      setArrError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
      setShowDeleteConfirm(false);
    }
  }

  const replyBlock = (
    <div className="flex flex-col items-end gap-1 mt-1">
      {!showReply ? (
        <button
          type="button"
          onClick={() => { setShowReply(true); setReplySaved(false); }}
          className="flex items-center gap-1 rounded px-1.5 py-1 -mr-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <MessageSquare className="w-3 h-3" />
          {existingAdminNote ? t("adminQueue.actions.editReply") : t("adminQueue.actions.reply")}
        </button>
      ) : (
        <div className="flex flex-col items-end gap-1.5 w-48">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value.slice(0, 500))}
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
              onClick={() => setShowReply(false)}
              disabled={loading === "NOTE"}
              className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-500 hover:text-zinc-100"
            >
              {t("shared.common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={saveReply}
              disabled={loading === "NOTE"}
              className="h-6 px-2 text-[11px] bg-indigo-700 hover:bg-indigo-600 gap-1"
            >
              {loading === "NOTE" ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
              {t("adminQueue.actions.save")}
            </Button>
          </div>
        </div>
      )}
      {replySaved && !showReply && (
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-[11px] text-green-400">
          <Check className="w-3 h-3" />{t("adminQueue.actions.replySaved")}
        </span>
      )}
    </div>
  );

  if (status === "APPROVED") {
    if (showDeleteConfirm) {
      return (
        <div className="flex flex-col items-end gap-2">
          <span className="text-xs text-zinc-400">{t("adminQueue.actions.deleteConfirm")}</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={loading === "DELETE"}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100"
            >
              {t("shared.common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={deleteRequest}
              disabled={loading === "DELETE"}
              className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
            >
              {loading === "DELETE" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              {t("adminQueue.actions.delete")}
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={triggerSearch}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
          >
            {loading === "SEARCH" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
            {t("adminQueue.actions.search")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={retryPush}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
          >
            {loading === "RETRY" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            {t("adminQueue.actions.repush")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400 gap-1"
          >
            <Trash2 className="w-3 h-3" />
            {t("adminQueue.actions.delete")}
          </Button>
        </div>
        {retryOk && (
          <span role="status" aria-live="polite" className="flex items-center gap-1 text-[11px] text-green-400">
            <Check className="w-3 h-3" />{t("adminQueue.actions.done")}
          </span>
        )}
        {arrError && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
            <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
          </span>
        )}
        {replyBlock}
      </div>
    );
  }

  if (status === "DECLINED") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateStatus("APPROVED")}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1"
        >
          {loading === "APPROVED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          {t("adminQueue.actions.reapprove")}
        </Button>
        {arrError && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
            <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
          </span>
        )}
        {replyBlock}
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
        {replyBlock}
        {/* saveReply is reachable from this branch too, so it needs somewhere to
            report a failure — otherwise a reply on an available title silently
            does nothing. */}
        {arrError && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
            <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
          </span>
        )}
      </div>
    );
  }

  if (showDeclineNote) {
    return (
      <div className="flex flex-col items-end gap-2 w-52">
        <textarea
          value={declineNote}
          onChange={(e) => setDeclineNote(e.target.value)}
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
            onClick={() => { setShowDeclineNote(false); setDeclineNote(""); }}
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
            onClick={() => updateStatus("DECLINED", declineNote.trim() || undefined, false)}
            disabled={loading !== null}
            className="h-7 px-3 text-xs bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] gap-1"
            title={t("adminQueue.actions.denyAllowTitle")}
          >
            {loading === "DECLINED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            {t("adminQueue.actions.denyAllow")}
          </Button>
          <Button
            size="sm"
            onClick={() => updateStatus("DECLINED", declineNote.trim() || undefined, true)}
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
        {arrError && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 text-right">
            <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
          </span>
        )}
      </div>
    );
  }

  if (showProfilePicker) {
    return (
      <div className="flex flex-col items-end gap-2 w-56">
        <span className="text-xs text-zinc-400">{t("adminQueue.actions.approveWithProfile")}</span>
        {profilesLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
        ) : profilesError ? (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 text-right">
            <AlertTriangle className="w-3 h-3 shrink-0" />{profilesError}
          </span>
        ) : (profiles?.length ?? 0) === 0 ? (
          <span className="text-[11px] text-zinc-500 text-right">{t("adminQueue.actions.noProfiles")}</span>
        ) : (
          <div className="flex flex-col items-stretch gap-1 w-full">
            {(profiles ?? []).map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="outline"
                onClick={() => { setApprovingProfileId(p.id); updateStatus("APPROVED", undefined, undefined, { qualityProfileId: p.id, qualityProfileName: p.name }); }}
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
          onClick={() => { setShowProfilePicker(false); setArrError(null); }}
          disabled={loading !== null}
          className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-500 hover:text-zinc-100"
        >
          {t("shared.common.cancel")}
        </Button>
        {arrError && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 max-w-56 text-right">
            <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
          </span>
        )}
      </div>
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
          onClick={() => updateStatus("APPROVED")}
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
      {arrError && (
        <span role="alert" aria-live="assertive" className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
          <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
        </span>
      )}
      {replyBlock}
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
      {result && (
        <span
          role={isError ? "alert" : "status"}
          aria-live={isError ? "assertive" : "polite"}
          className={`text-xs ${isError ? "text-red-400" : "text-zinc-400"}`}
        >
          {result}
        </span>
      )}
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
      {result && (
        <span
          role={isError ? "alert" : "status"}
          aria-live={isError ? "assertive" : "polite"}
          className={`text-xs ${isError ? "text-red-400" : "text-zinc-400"}`}
        >
          {result}
        </span>
      )}
    </div>
  );
}
