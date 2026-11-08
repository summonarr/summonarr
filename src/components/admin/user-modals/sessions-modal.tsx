"use client";

import { useState, useEffect, useRef } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useAsyncAction } from "@/hooks/use-async-action";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
import { localizeDeviceLabel } from "@/lib/ua-fingerprint";
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
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { v, type Infer } from "@/lib/validate";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import type { User } from "./shared";
import { requestFailureText } from "../request-failure-text";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

// GET /api/admin/users/[id]/sessions: the account's devices, newest first.
const AdminAuthSessionSchema = v.object({
  id: v.string(),
  sessionId: v.string(),
  deviceType: v.string(),
  deviceLabel: v.nullable(v.string()),
  ipAddress: v.nullable(v.string()),
  createdAt: v.string(),
  lastSeenAt: v.string(),
  expiresAt: v.string(),
});
const SessionList = v.array(AdminAuthSessionSchema);
type AdminAuthSession = Infer<typeof AdminAuthSessionSchema>;

function DeviceIcon({ deviceType }: { deviceType: string }) {
  if (deviceType === "mobile") return <Smartphone className="w-3.5 h-3.5 shrink-0 text-zinc-400" />;
  if (deviceType === "tablet") return <Tablet      className="w-3.5 h-3.5 shrink-0 text-zinc-400" />;
  return                              <Monitor     className="w-3.5 h-3.5 shrink-0 text-zinc-400" />;
}

function deviceName(s: AdminAuthSession, t: Translator): string {
  // The stored label is English (native clients read it as-is).
  const label = localizeDeviceLabel(s.deviceLabel || null, t);
  if (label) return label;
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

// The account's sessions: { sessions, loading, error } and a setter for the
// list, loaded once per account. The translator rides a ref: the users page
// hands the provider a new catalog (and so a new `t`) on every refresh, and as
// an effect dependency that re-fetched the list under an open modal — a read
// that began before a revoke could land after it and bring the row back.
function useAccountSessions(userId: string) {
  const t = useT();
  const [sessions, setSessions] = useState<AdminAuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchJson(withBasePath(`/api/admin/users/${userId}/sessions`), { schema: SessionList, signal: ctrl.signal }).then((res) => {
      if (!res.ok && res.kind === "aborted") return;
      setLoading(false);
      if (res.ok) {
        setSessions(res.data);
        return;
      }
      // The route's own sentence when it has one: it admits MANAGE_USERS but
      // refuses an ADMIN target to a caller without the ADMIN bit (403), and
      // a generic "could not load" there read as a broken page rather than a
      // rule. An empty list would read as "no sessions".
      setSessions([]);
      setError(res.kind === "http" && res.error ? res.error : tRef.current("adminManage.sessions.loadError"));
    });
    return () => ctrl.abort();
  }, [userId]);

  return { sessions, setSessions, loading, error, setError };
}

function SessionRow({
  s,
  confirming,
  revoking,
  locked,
  mounted,
  onAsk,
  onCancel,
  onRevoke,
}: {
  s: AdminAuthSession;
  confirming: boolean;
  // This row's revoke is in flight.
  revoking: boolean;
  // Its controls are off: this row's revoke, or revoke-all, is in flight.
  locked: boolean;
  mounted: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const label = sessionLabel(s, t);
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2.5">
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

      {confirming ? (
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          <button
            type="button"
            aria-label={t("adminManage.sessions.confirmRevokeAria", { name: label })}
            disabled={locked}
            onClick={onRevoke}
            autoFocus
            className="rounded-md px-2 py-1 text-[10px] font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-40"
          >
            {revoking
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : t("profile.sessions.revokeButton")}
          </button>
          <button
            type="button"
            aria-label={t("adminManage.sessions.cancelRevokeAria", { name: label })}
            disabled={locked}
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-40"
          >
            {t("adminManage.common.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={locked}
          onClick={onAsk}
          aria-label={t("adminManage.sessions.revokeAria", { name: label })}
          className="shrink-0 -m-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
          title={t("adminManage.sessions.revokeAria", { name: label })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function RevokeAllBar({
  accountName,
  confirming,
  revoking,
  locked,
  onAsk,
  onCancel,
  onRevoke,
}: {
  accountName: string;
  confirming: boolean;
  revoking: boolean;
  // Off while any revoke is in flight: two DELETEs for one account never overlap.
  locked: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const t = useT();
  const label = revoking
    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("adminManage.sessions.revoking")}</>
    : null;
  return (
    <div className="mt-4 pt-3 border-t border-zinc-800">
      {!confirming ? (
        <button
          type="button"
          disabled={locked}
          onClick={onAsk}
          className="w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
        >
          {label ?? <><Trash2  className="w-3.5 h-3.5" />{t("adminManage.sessions.revokeAll")}</>}
        </button>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={t("adminManage.sessions.confirmRevokeAllAria", { name: accountName })}
            disabled={locked}
            onClick={onRevoke}
            autoFocus
            className="flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-40"
          >
            {label ?? <><Trash2  className="w-3.5 h-3.5" />{t("adminManage.sessions.revokeAllConfirm")}</>}
          </button>
          <button
            type="button"
            aria-label={t("adminManage.sessions.cancelRevokeAll")}
            disabled={locked}
            onClick={onCancel}
            className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-40"
          >
            {t("adminManage.common.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

const REVOKE_ALL = "revoke-all";
const revokeKey = (sessionId: string) => `revoke:${sessionId}`;

export function SessionsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const t = useT();
  const { sessions, setSessions, loading, error, setError } = useAccountSessions(u.id);
  // Each revoke is busy under its own key, so two in flight never clear each
  // other's spinner; revoke-all waits for every single one.
  const action = useAsyncAction();
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

  const sessionsUrl = withBasePath(`/api/admin/users/${u.id}/sessions`);
  const revokingAll = action.busy(REVOKE_ALL);

  async function revoke(sessionId: string) {
    setConfirmingRevoke(null);
    setError(null);
    const res = await action.run(
      revokeKey(sessionId),
      (signal) => fetchJson(sessionsUrl, { init: jsonInit("DELETE", { sessionId }), signal }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      // Say why it failed, so the admin knows the device may still be signed
      // in rather than guessing from a row that didn't disappear.
      const text = requestFailureText(res, t, { status: "adminManage.sessions.revokeError", network: "adminManage.sessions.revokeNetwork" });
      if (text !== null) setError(text);
      return;
    }
    setSessions((s) => s.filter((r) => r.sessionId !== sessionId));
  }

  async function revokeAll() {
    setConfirmingRevokeAll(false);
    setError(null);
    const res = await action.run(
      REVOKE_ALL,
      (signal) => fetchJson(sessionsUrl, { init: jsonInit("DELETE", { all: true }), signal }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      const text = requestFailureText(res, t, { status: "adminManage.sessions.revokeAllError", network: "adminManage.sessions.revokeAllNetwork" });
      if (text !== null) setError(text);
      return;
    }
    setSessions([]);
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

          {!loading && sessions.map((s) => {
            const revoking = action.busy(revokeKey(s.sessionId));
            return (
              <SessionRow
                key={s.id}
                s={s}
                confirming={confirmingRevoke === s.sessionId}
                revoking={revoking}
                locked={revoking || revokingAll}
                mounted={mounted}
                onAsk={() => setConfirmingRevoke(s.sessionId)}
                onCancel={() => setConfirmingRevoke(null)}
                onRevoke={() => void revoke(s.sessionId)}
              />
            );
          })}
        </div>

        {!loading && sessions.length > 0 && (
          <RevokeAllBar
            accountName={displayName}
            confirming={confirmingRevokeAll}
            revoking={revokingAll}
            locked={action.anyBusy}
            onAsk={() => setConfirmingRevokeAll(true)}
            onCancel={() => setConfirmingRevokeAll(false)}
            onRevoke={() => void revokeAll()}
          />
        )}
      </div>
    </div>
  );
}
