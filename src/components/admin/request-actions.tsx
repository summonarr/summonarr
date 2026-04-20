"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, AlertTriangle, RefreshCw, RotateCcw, Search, MessageSquare, Trash2, Users } from "lucide-react";

interface RequestActionsProps {
  requestId: string;
  currentStatus: string;
  existingAdminNote?: string | null;
}

export function RequestActions({ requestId, currentStatus, existingAdminNote }: RequestActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<"APPROVED" | "DECLINED" | "RETRY" | "SEARCH" | "NOTE" | "DELETE" | null>(null);

  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
  const status = optimisticStatus ?? currentStatus;
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [arrError, setArrError] = useState<string | null>(null);
  const [retryOk, setRetryOk] = useState(false);
  const [showDeclineNote, setShowDeclineNote] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState(existingAdminNote ?? "");
  const [replySaved, setReplySaved] = useState(false);

  async function saveReply() {
    setLoading("NOTE");
    setReplySaved(false);
    try {
      const res = await fetch(`/api/requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, adminNote: replyText.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError((data as { error?: string }).error ?? "Failed to save reply");
        return;
      }
      setShowReply(false);
      setReplySaved(true);
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  async function updateStatus(newStatus: "APPROVED" | "DECLINED", adminNote?: string, permanent?: boolean) {
    setLoading(newStatus);
    setArrError(null);
    setRetryOk(false);
    setOptimisticStatus(newStatus);
    try {
      const res = await fetch(`/api/requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, ...(adminNote !== undefined ? { adminNote } : {}), ...(permanent !== undefined ? { permanent } : {}) }),
      });
      if (!res.ok) {
        setOptimisticStatus(null);
        const data = await res.json().catch(() => ({}));
        setArrError((data as { error?: string }).error ?? "Failed to update");
        return;
      }
      const data: { arrError?: string } = await res.json();
      if (data.arrError) setArrError(data.arrError);
      setShowDeclineNote(false);
      setDeclineNote("");
      router.refresh();
    } catch {
      setOptimisticStatus(null);
    } finally {
      setLoading(null);
    }
  }

  async function triggerSearch() {
    setLoading("SEARCH");
    setArrError(null);
    setRetryOk(false);
    try {
      const res = await fetch(`/api/requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setArrError((err as { arrError?: string; error?: string }).arrError ?? (err as { error?: string }).error ?? `Request failed (${res.status})`);
        return;
      }
      const data: { arrError?: string } = await res.json();
      if (data.arrError) {
        setArrError(data.arrError);
      } else {
        setRetryOk(true);
      }
    } finally {
      setLoading(null);
    }
  }

  async function retryPush() {
    setLoading("RETRY");
    setArrError(null);
    setRetryOk(false);
    try {
      const res = await fetch(`/api/requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retry: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setArrError((err as { arrError?: string; error?: string }).arrError ?? (err as { error?: string }).error ?? `Request failed (${res.status})`);
        return;
      }
      const data: { arrError?: string } = await res.json();
      if (data.arrError) {
        setArrError(data.arrError);
      } else {
        setRetryOk(true);
      }
    } finally {
      setLoading(null);
    }
  }

  async function deleteRequest() {
    setLoading("DELETE");
    try {
      const res = await fetch(`/api/requests/${requestId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setArrError((data as { error?: string }).error ?? "Delete failed");
        return;
      }
      router.refresh();
    } finally {
      setLoading(null);
      setShowDeleteConfirm(false);
    }
  }

  const replyBlock = (
    <div className="flex flex-col items-end gap-1 mt-1">
      {!showReply ? (
        <button
          onClick={() => { setShowReply(true); setReplySaved(false); }}
          className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <MessageSquare className="w-3 h-3" />
          {existingAdminNote ? "Edit reply" : "Reply"}
        </button>
      ) : (
        <div className="flex flex-col items-end gap-1.5 w-48">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value.slice(0, 500))}
            placeholder="Admin reply (visible to user)"
            rows={2}
            autoFocus
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowReply(false)}
              disabled={loading === "NOTE"}
              className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-500 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={saveReply}
              disabled={loading === "NOTE"}
              className="h-6 px-2 text-[11px] bg-indigo-700 hover:bg-indigo-600 gap-1"
            >
              {loading === "NOTE" ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
              Save
            </Button>
          </div>
        </div>
      )}
      {replySaved && !showReply && (
        <span className="flex items-center gap-1 text-[11px] text-green-400">
          <Check className="w-3 h-3" />Reply saved
        </span>
      )}
    </div>
  );

  if (status === "APPROVED") {
    if (showDeleteConfirm) {
      return (
        <div className="flex flex-col items-end gap-2">
          <span className="text-xs text-zinc-400">Delete this request?</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={loading === "DELETE"}
              className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={deleteRequest}
              disabled={loading === "DELETE"}
              className="h-7 px-3 text-xs bg-red-800 hover:bg-red-700 gap-1"
            >
              {loading === "DELETE" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              Delete
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={triggerSearch}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white gap-1"
          >
            {loading === "SEARCH" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
            Search
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={retryPush}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white gap-1"
          >
            {loading === "RETRY" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Re-push
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-red-800/50 text-red-500 hover:bg-red-950 gap-1"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </Button>
        </div>
        {retryOk && (
          <span className="flex items-center gap-1 text-[11px] text-green-400">
            <Check className="w-3 h-3" />Done
          </span>
        )}
        {arrError && (
          <span className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
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
          className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white gap-1"
        >
          {loading === "APPROVED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          Re-approve
        </Button>
        {arrError && (
          <span className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
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
        <span className="text-xs text-indigo-400 font-medium">Available</span>
        {replyBlock}
      </div>
    );
  }

  if (showDeclineNote) {
    return (
      <div className="flex flex-col items-end gap-2 w-52">
        <textarea
          value={declineNote}
          onChange={(e) => setDeclineNote(e.target.value)}
          placeholder="Reason (optional)"
          rows={2}
          className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setShowDeclineNote(false); setDeclineNote(""); }}
            disabled={loading !== null}
            className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => updateStatus("DECLINED", declineNote.trim() || undefined, false)}
            disabled={loading !== null}
            className="h-7 px-3 text-xs bg-red-800 hover:bg-red-700 gap-1"
            title="User can re-request this title later"
          >
            {loading === "DECLINED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            Deny — allow re-request
          </Button>
          <Button
            size="sm"
            onClick={() => updateStatus("DECLINED", declineNote.trim() || undefined, true)}
            disabled={loading !== null}
            className="h-7 px-3 text-xs bg-red-950 hover:bg-red-900 border border-red-700 gap-1"
            title="User cannot re-request this title"
          >
            {loading === "DECLINED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            Deny — permanent
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => updateStatus("APPROVED")}
          disabled={loading !== null}
          className="h-7 px-3 text-xs bg-green-700 hover:bg-green-600 gap-1"
        >
          {loading === "APPROVED" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowDeclineNote(true)}
          disabled={loading !== null}
          className="h-7 px-3 text-xs border-red-800 text-red-400 hover:bg-red-950 gap-1"
        >
          <X className="w-3 h-3" />
          Decline
        </Button>
      </div>
      {arrError && (
        <span className="flex items-center gap-1 text-[11px] text-amber-400 max-w-48 text-right">
          <AlertTriangle className="w-3 h-3 shrink-0" />{arrError}
        </span>
      )}
      {replyBlock}
    </div>
  );
}

export function SyncButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleSync() {
    setLoading(true);
    setResult(null);
    try {
      const [arrRes, jellyfinRes] = await Promise.all([
        fetch("/api/sync", { method: "POST" }),
        fetch("/api/sync/jellyfin", { method: "POST" }),
      ]);

      const arrData: { marked: number; reverted: number; plexMarked: number; error?: string } = await arrRes.json();
      const jellyfinData: { marked: number; error?: string } = await jellyfinRes.json();

      if (arrData.error || jellyfinData.error) {
        setResult(arrData.error ?? jellyfinData.error ?? "Sync failed");
      } else {
        const totalMarked = arrData.marked + arrData.plexMarked + jellyfinData.marked;
        setResult(totalMarked > 0 ? `Marked ${totalMarked} available` : "Up to date");
        router.refresh();
      }
    } catch {
      setResult("Sync failed");
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
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Syncing…" : "Sync now"}
      </Button>
      {result && <span className="text-xs text-zinc-400">{result}</span>}
    </div>
  );
}

export function SyncRolesButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleSync() {
    setLoading(true);
    setResult(null);
    setIsError(false);
    try {
      const res = await fetch("/api/discord/sync-roles", { method: "POST" });
      const data: { synced?: number; error?: string } = await res.json();
      if (data.error) {
        setIsError(true);
        setResult(data.error);
      } else {
        setResult(`Synced ${data.synced ?? 0} user${data.synced !== 1 ? "s" : ""}`);
      }
    } catch {
      setIsError(true);
      setResult("Sync failed");
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
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        <Users className={`w-4 h-4 ${loading ? "animate-pulse" : ""}`} />
        {loading ? "Syncing…" : "Sync Discord Roles"}
      </Button>
      {result && (
        <span className={`text-xs ${isError ? "text-red-400" : "text-zinc-400"}`}>{result}</span>
      )}
    </div>
  );
}
