"use client";

import { useState, useEffect, useRef } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  Trash2,
  Loader2,
  X,
  Smartphone,
  Monitor,
  Tablet,
  KeyRound,
  MapPin,
  Clock,
} from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import type { User } from "./shared";

interface AdminAuthSession {
  id: string;
  sessionId: string;
  deviceType: string;
  deviceLabel: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

function DeviceIcon({ deviceType }: { deviceType: string }) {
  if (deviceType === "mobile") return <Smartphone className="w-3.5 h-3.5 shrink-0 text-zinc-400" />;
  if (deviceType === "tablet") return <Tablet      className="w-3.5 h-3.5 shrink-0 text-zinc-400" />;
  return                              <Monitor     className="w-3.5 h-3.5 shrink-0 text-zinc-400" />;
}

export function SessionsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const [sessions, setSessions]       = useState<AdminAuthSession[]>([]);
  const [loading, setLoading]         = useState(true);
  const [revoking, setRevoking]       = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  // Guardrail 16: formatRelativeTime uses Date.now() and toLocaleDateString varies by locale
  const mounted = useHasMounted();
  const titleId = `sessions-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus-in + Tab-trap + Escape + focus-restore for this hand-rolled overlay.
  useModalA11y(dialogRef, onClose, closeBtnRef);

  useEffect(() => {
    fetch(withBasePath(`/api/admin/users/${u.id}/sessions`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: AdminAuthSession[]) => setSessions(Array.isArray(data) ? data : []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [u.id]);

  async function revoke(sessionId: string) {
    setConfirmingRevoke(null);
    setRevoking(sessionId);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}/sessions`), {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        console.error("[sessions] revoke failed:", res.status);
        return;
      }
      setSessions((s) => s.filter((r) => r.sessionId !== sessionId));
    } finally {
      setRevoking(null);
    }
  }

  async function revokeAll() {
    setConfirmingRevokeAll(false);
    setRevokingAll(true);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}/sessions`), {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        console.error("[sessions] revokeAll failed:", res.status);
        return;
      }
      setSessions([]);
    } finally {
      setRevokingAll(false);
    }
  }

  const displayName = u.name ?? u.email;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[460px] shadow-2xl flex flex-col max-h-[80vh] outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {}
        <div className="flex items-center justify-between mb-1">
          <h3
            id={titleId}
            className="text-sm font-semibold text-white flex items-center gap-2"
          >
            <KeyRound className="w-4 h-4 text-zinc-400" />
            Active Sessions
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{displayName}</p>

        {}
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
          {loading && (
            <div className="flex items-center gap-2 py-4 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
              <span className="text-xs text-zinc-500">Loading…</span>
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <p className="text-xs text-zinc-500 py-4 text-center">No active sessions.</p>
          )}

          {!loading && sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2.5"
            >
              <div className="flex items-start gap-2 min-w-0">
                <DeviceIcon deviceType={s.deviceType} />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs text-zinc-200 truncate">
                    {s.deviceLabel ?? `${s.deviceType.charAt(0).toUpperCase() + s.deviceType.slice(1)} device`}
                  </p>
                  <div className="flex items-center gap-3 flex-wrap">
                    {s.ipAddress && (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                        <MapPin className="w-2.5 h-2.5" />{s.ipAddress}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                      <Clock className="w-2.5 h-2.5" />Active {mounted ? formatRelativeTime(s.lastSeenAt) : ""}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    Expires {mounted ? new Date(s.expiresAt).toLocaleDateString() : ""}
                  </p>
                </div>
              </div>

              {confirmingRevoke === s.sessionId ? (
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                  <button
                    type="button"
                    aria-label="Confirm revoke this session"
                    disabled={revoking === s.sessionId || revokingAll}
                    onClick={() => revoke(s.sessionId)}
                    autoFocus
                    className="rounded-md px-2 py-1 text-[10px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-40"
                  >
                    {revoking === s.sessionId
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : "Revoke"}
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel revoke this session"
                    disabled={revoking === s.sessionId || revokingAll}
                    onClick={() => setConfirmingRevoke(null)}
                    className="rounded-md px-2 py-1 text-[10px] text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={revoking === s.sessionId || revokingAll}
                  onClick={() => setConfirmingRevoke(s.sessionId)}
                  aria-label="Revoke this session"
                  className="shrink-0 mt-0.5 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
                  title="Revoke this session"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        {}
        {!loading && sessions.length > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800">
            {!confirmingRevokeAll ? (
              <button
                type="button"
                disabled={revokingAll}
                onClick={() => setConfirmingRevokeAll(true)}
                className="w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
              >
                {revokingAll
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Revoking…</>
                  : <><Trash2  className="w-3.5 h-3.5" />Revoke all sessions</>}
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`Confirm revoke all sessions for ${u.name ?? u.email}`}
                  disabled={revokingAll}
                  onClick={revokeAll}
                  autoFocus
                  className="flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-40"
                >
                  {revokingAll
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Revoking…</>
                    : <><Trash2  className="w-3.5 h-3.5" />Revoke all — they will be signed out</>}
                </button>
                <button
                  type="button"
                  aria-label="Cancel revoke all"
                  disabled={revokingAll}
                  onClick={() => setConfirmingRevokeAll(false)}
                  className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
