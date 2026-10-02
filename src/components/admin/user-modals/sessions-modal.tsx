"use client";

import { useState, useEffect, useRef } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
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
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

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

function deviceName(s: AdminAuthSession, t: Translator): string {
  if (s.deviceLabel) return s.deviceLabel;
  if (s.deviceType === "mobile") return t("profile.sessions.device.mobile");
  if (s.deviceType === "tablet") return t("profile.sessions.device.tablet");
  if (s.deviceType === "desktop") return t("profile.sessions.device.desktop");
  return t("profile.sessions.device.other", { type: s.deviceType.charAt(0).toUpperCase() + s.deviceType.slice(1) });
}

// Names the device (and IP when known) so each row's icon-only revoke control
// is distinguishable to a screen reader.
function sessionLabel(s: AdminAuthSession, t: Translator): string {
  return s.ipAddress ? `${deviceName(s, t)} (${s.ipAddress})` : deviceName(s, t);
}

export function SessionsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [sessions, setSessions]       = useState<AdminAuthSession[]>([]);
  const [loading, setLoading]         = useState(true);
  const [revoking, setRevoking]       = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  // Guardrail 16: formatRelativeTime reads Date.now() and toLocaleDateString
  // depends on locale, so both render only after mount to avoid a hydration mismatch.
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
      .catch(() => {
        // Say so: an empty list here would read as "no active sessions".
        setSessions([]);
        setError(t("adminManage.sessions.loadError"));
      })
      .finally(() => setLoading(false));
  }, [u.id, t]);

  async function revoke(sessionId: string) {
    setConfirmingRevoke(null);
    setRevoking(sessionId);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}/sessions`), {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        // Show why it failed, so the admin knows the device may still be
        // signed in rather than guessing from a row that didn't disappear.
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("adminManage.sessions.revokeError", { status: res.status }));
        return;
      }
      setSessions((s) => s.filter((r) => r.sessionId !== sessionId));
    } catch {
      setError(t("adminManage.sessions.revokeNetwork"));
    } finally {
      setRevoking(null);
    }
  }

  async function revokeAll() {
    setConfirmingRevokeAll(false);
    setRevokingAll(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}/sessions`), {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("adminManage.sessions.revokeAllError", { status: res.status }));
        return;
      }
      setSessions([]);
    } catch {
      setError(t("adminManage.sessions.revokeAllNetwork"));
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
        <div className="flex items-center justify-between mb-1">
          <h3
            id={titleId}
            className="text-sm font-semibold text-zinc-100 flex items-center gap-2"
          >
            <KeyRound className="w-4 h-4 text-zinc-400" />
            {t("profile.sessions.title")}
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={t("adminManage.common.close")}
            onClick={onClose}
            className="-m-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{displayName}</p>

        {error && (
          <p role="alert" aria-live="assertive" className="text-xs text-red-400 mb-2">
            {error}
          </p>
        )}
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
          {loading && (
            <div className="flex items-center gap-2 py-4 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
              <span className="text-xs text-zinc-500">{t("adminManage.common.loading")}</span>
            </div>
          )}

          {!loading && sessions.length === 0 && !error && (
            <p className="text-xs text-zinc-500 py-4 text-center">{t("profile.sessions.empty")}</p>
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
                    {deviceName(s, t)}
                  </p>
                  <div className="flex items-center gap-3 flex-wrap">
                    {s.ipAddress && (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                        <MapPin className="w-2.5 h-2.5" />{s.ipAddress}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                      <Clock className="w-2.5 h-2.5" />{t("profile.sessions.active", { time: mounted ? formatRelativeTimeLocalized(s.lastSeenAt, locale) : "" })}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    {/* A native-app (iOS) session carries the never-reached sentinel
                        deadline (session-lifetime.ts) — it ends only when revoked. */}
                    {isIndefiniteDeadline(s.expiresAt)
                      ? t("profile.sessions.neverExpires")
                      : t("profile.sessions.expires", { date: mounted ? new Date(s.expiresAt).toLocaleDateString(locale) : "" })}
                  </p>
                </div>
              </div>

              {confirmingRevoke === s.sessionId ? (
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                  <button
                    type="button"
                    aria-label={t("adminManage.sessions.confirmRevokeAria", { name: sessionLabel(s, t) })}
                    disabled={revoking === s.sessionId || revokingAll}
                    onClick={() => revoke(s.sessionId)}
                    autoFocus
                    className="rounded-md px-2 py-1 text-[10px] font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-40"
                  >
                    {revoking === s.sessionId
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : t("profile.sessions.revokeButton")}
                  </button>
                  <button
                    type="button"
                    aria-label={t("adminManage.sessions.cancelRevokeAria", { name: sessionLabel(s, t) })}
                    disabled={revoking === s.sessionId || revokingAll}
                    onClick={() => setConfirmingRevoke(null)}
                    className="rounded-md px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                  >
                    {t("adminManage.common.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={revoking === s.sessionId || revokingAll}
                  onClick={() => setConfirmingRevoke(s.sessionId)}
                  aria-label={t("adminManage.sessions.revokeAria", { name: sessionLabel(s, t) })}
                  className="shrink-0 -m-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
                  title={t("adminManage.sessions.revokeAria", { name: sessionLabel(s, t) })}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

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
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("adminManage.sessions.revoking")}</>
                  : <><Trash2  className="w-3.5 h-3.5" />{t("adminManage.sessions.revokeAll")}</>}
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t("adminManage.sessions.confirmRevokeAllAria", { name: u.name ?? u.email })}
                  disabled={revokingAll}
                  onClick={revokeAll}
                  autoFocus
                  className="flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-40"
                >
                  {revokingAll
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("adminManage.sessions.revoking")}</>
                    : <><Trash2  className="w-3.5 h-3.5" />{t("adminManage.sessions.revokeAllConfirm")}</>}
                </button>
                <button
                  type="button"
                  aria-label={t("adminManage.sessions.cancelRevokeAll")}
                  disabled={revokingAll}
                  onClick={() => setConfirmingRevokeAll(false)}
                  className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                >
                  {t("adminManage.common.cancel")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
