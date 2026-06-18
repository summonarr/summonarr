"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { useHasMounted } from "@/hooks/use-has-mounted";
import {
  MoreHorizontal,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Zap,
  Trash2,
  Loader2,
  Bell,
  X,
  MessageCircle,
  Mail,
  Smartphone,
  Monitor,
  Tablet,
  Server,
  KeyRound,
  MapPin,
  Clock,
  AlertTriangle,
} from "@/components/icons";
import { Permission, PRESETS, parsePermissions, AUTO_APPROVE_MASK } from "@/lib/permissions";

interface User {
  id: string;
  name: string | null;
  email: string;
  role: "ADMIN" | "ISSUE_ADMIN" | "USER";
  createdAt: string;
  source: "local" | "plex" | "jellyfin";
  discordId: string | null;
  permissions: string;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  mediaServer: "plex" | "jellyfin" | null;
  notifyOnApproved: boolean;
  notifyOnAvailable: boolean;
  notifyOnDeclined: boolean;
  emailOnApproved: boolean;
  emailOnAvailable: boolean;
  emailOnDeclined: boolean;
  pushOnApproved: boolean;
  pushOnAvailable: boolean;
  pushOnDeclined: boolean;
  notifyOnIssue: boolean;
  _count: { requests: number };
}

interface UserTableProps {
  users: User[];
  currentUserId: string;
  // When a 4K Radarr/Sonarr instance is configured, the permission editor shows
  // the 4K capability toggles (REQUEST_4K / AUTO_APPROVE_4K).
  has4k?: boolean;
}

const sourceStyles: Record<User["source"], string> = {
  plex:     "border-yellow-600/30 bg-yellow-500/10 text-yellow-400",
  jellyfin: "border-purple-600/30 bg-purple-500/10 text-purple-400",
  local:    "border-zinc-700 bg-zinc-800 text-zinc-400",
};

const roleStyles: Record<User["role"], string> = {
  ADMIN:       "border-indigo-500/30 bg-indigo-500/10 text-indigo-400",
  ISSUE_ADMIN: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  USER:        "border-zinc-700 bg-zinc-800 text-zinc-500",
};

const roleLabel: Record<User["role"], string> = {
  ADMIN:       "Admin",
  ISSUE_ADMIN: "Issue Admin",
  USER:        "User",
};

const avatarColors: Record<User["source"], string> = {
  plex:     "bg-yellow-600",
  jellyfin: "bg-purple-700",
  local:    "bg-indigo-700",
};

type NotifKey = "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "emailOnApproved" | "emailOnAvailable" | "emailOnDeclined" | "pushOnApproved" | "pushOnAvailable" | "pushOnDeclined" | "notifyOnIssue";

function AdminToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: () => void; disabled: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0">
      <span className="text-xs text-zinc-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={onChange}
        className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-indigo-600" : "bg-zinc-700"}`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

function NotificationsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Record<NotifKey, boolean>>({
    notifyOnApproved: u.notifyOnApproved,
    notifyOnAvailable: u.notifyOnAvailable,
    notifyOnDeclined: u.notifyOnDeclined,
    emailOnApproved: u.emailOnApproved,
    emailOnAvailable: u.emailOnAvailable,
    emailOnDeclined: u.emailOnDeclined,
    pushOnApproved: u.pushOnApproved,
    pushOnAvailable: u.pushOnAvailable,
    pushOnDeclined: u.pushOnDeclined,
    notifyOnIssue: u.notifyOnIssue,
  });
  const [saving, setSaving] = useState(false);
  const titleId = `notif-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on mount, return focus to the opener on unmount,
  // and close on ESC. Minimal a11y trap (no Tab cycling — small panel, low
  // risk of focus escape; can revisit if we adopt @base-ui/react Dialog).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  async function toggle(key: NotifKey) {
    const newVal = !prefs[key];
    const prevPrefs = { ...prefs };
    setPrefs((p) => ({ ...p, [key]: newVal }));
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: newVal }),
      });
      if (!res.ok) {
        setPrefs(prevPrefs);
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const displayName = u.name ?? u.email;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[440px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3
            id={titleId}
            className="text-sm font-semibold text-white flex items-center gap-2"
          >
            <Bell className="w-4 h-4 text-zinc-400" />
            Notification Settings
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

        {u.discordId ? (
          <div className="mb-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400 mb-1 flex items-center gap-1.5">
              <MessageCircle className="w-3 h-3" /> Discord
            </p>
            <AdminToggleRow label="Request Approved" checked={prefs.notifyOnApproved} onChange={() => toggle("notifyOnApproved")} disabled={saving} />
            <AdminToggleRow label="Now Available" checked={prefs.notifyOnAvailable} onChange={() => toggle("notifyOnAvailable")} disabled={saving} />
            <AdminToggleRow label="Request Declined" checked={prefs.notifyOnDeclined} onChange={() => toggle("notifyOnDeclined")} disabled={saving} />
          </div>
        ) : (
          <p className="text-xs text-zinc-600 mb-3 italic">Discord not linked — no Discord notifications</p>
        )}

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <Mail className="w-3 h-3" /> Email
          </p>
          <AdminToggleRow label="Request Approved" checked={prefs.emailOnApproved} onChange={() => toggle("emailOnApproved")} disabled={saving} />
          <AdminToggleRow label="Now Available" checked={prefs.emailOnAvailable} onChange={() => toggle("emailOnAvailable")} disabled={saving} />
          <AdminToggleRow label="Request Declined" checked={prefs.emailOnDeclined} onChange={() => toggle("emailOnDeclined")} disabled={saving} />
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <Smartphone className="w-3 h-3" /> Push
          </p>
          <AdminToggleRow label="Request Approved" checked={prefs.pushOnApproved} onChange={() => toggle("pushOnApproved")} disabled={saving} />
          <AdminToggleRow label="Now Available" checked={prefs.pushOnAvailable} onChange={() => toggle("pushOnAvailable")} disabled={saving} />
          <AdminToggleRow label="Request Declined" checked={prefs.pushOnDeclined} onChange={() => toggle("pushOnDeclined")} disabled={saving} />
        </div>

        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400 mb-1 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Issues
          </p>
          <AdminToggleRow label="New Issues & Replies" checked={prefs.notifyOnIssue} onChange={() => toggle("notifyOnIssue")} disabled={saving} />
        </div>

        {saving && (
          <p className="text-xs text-zinc-500 flex items-center gap-1 mt-3">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </p>
        )}
      </div>
    </div>
  );
}

const PERMISSION_GROUPS: { title: string; bits: { key: keyof typeof Permission; label: string }[] }[] = [
  {
    title: "Request",
    bits: [
      { key: "REQUEST", label: "Request (all media)" },
      { key: "REQUEST_MOVIE", label: "Request movies" },
      { key: "REQUEST_TV", label: "Request TV" },
    ],
  },
  {
    title: "Auto-approve",
    bits: [
      { key: "AUTO_APPROVE", label: "Auto-approve (all)" },
      { key: "AUTO_APPROVE_MOVIE", label: "Auto-approve movies" },
      { key: "AUTO_APPROVE_TV", label: "Auto-approve TV" },
    ],
  },
  {
    title: "Manage",
    bits: [
      { key: "MANAGE_REQUESTS", label: "Manage requests" },
      { key: "MANAGE_USERS", label: "Manage users" },
      { key: "MANAGE_ISSUES", label: "Manage issues" },
    ],
  },
  {
    title: "Other",
    bits: [
      { key: "REQUEST_ON_BEHALF", label: "Request on behalf of others" },
      { key: "QUOTA_UNLIMITED", label: "Exempt from request quotas" },
    ],
  },
];

// 4K group — rendered only when a configured 4K instance exists (Phase 3 passes
// show4k). The bits are defined now so the editor is ready.
const PERMISSION_GROUP_4K: { title: string; bits: { key: keyof typeof Permission; label: string }[] } = {
  title: "4K",
  bits: [
    { key: "REQUEST_4K", label: "Request 4K (all)" },
    { key: "REQUEST_4K_MOVIE", label: "Request 4K movies" },
    { key: "REQUEST_4K_TV", label: "Request 4K TV" },
    { key: "AUTO_APPROVE_4K", label: "Auto-approve 4K (all)" },
  ],
};

function QuotaRow({
  label,
  limit,
  days,
  onLimit,
  onDays,
  onBlurLimit,
  onBlurDays,
  disabled,
}: {
  label: string;
  limit: string;
  days: string;
  onLimit: (v: string) => void;
  onDays: (v: string) => void;
  onBlurLimit: () => void;
  onBlurDays: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-xs text-zinc-300 w-10 shrink-0">{label}</span>
      <input
        type="number"
        min={0}
        inputMode="numeric"
        placeholder="limit"
        value={limit}
        disabled={disabled}
        onChange={(e) => onLimit(e.target.value)}
        onBlur={onBlurLimit}
        className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 disabled:opacity-50"
      />
      <span className="text-[10px] text-zinc-500">per</span>
      <input
        type="number"
        min={1}
        inputMode="numeric"
        placeholder="days"
        value={days}
        disabled={disabled}
        onChange={(e) => onDays(e.target.value)}
        onBlur={onBlurDays}
        className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 disabled:opacity-50"
      />
      <span className="text-[10px] text-zinc-500">days</span>
    </div>
  );
}

function PermissionsModal({ u, onClose, show4k = false }: { u: User; onClose: () => void; show4k?: boolean }) {
  const router = useRouter();
  const [perms, setPerms] = useState<bigint>(() => parsePermissions(u.permissions));
  const [saving, setSaving] = useState(false);
  const [quota, setQuota] = useState({
    movieQuotaLimit: u.movieQuotaLimit?.toString() ?? "",
    movieQuotaDays: u.movieQuotaDays?.toString() ?? "",
    tvQuotaLimit: u.tvQuotaLimit?.toString() ?? "",
    tvQuotaDays: u.tvQuotaDays?.toString() ?? "",
  });
  const titleId = `perm-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const isSuperAdmin = (perms & Permission.ADMIN) !== 0n;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  async function savePerms(next: bigint, prev: bigint) {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: next.toString() }),
      });
      if (!res.ok) {
        setPerms(prev);
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function toggle(bit: bigint) {
    const prev = perms;
    const next = (perms & bit) !== 0n ? perms & ~bit : perms | bit;
    setPerms(next);
    void savePerms(next, prev);
  }

  function applyPreset() {
    const prev = perms;
    const next = PRESETS[u.role] ?? PRESETS.USER;
    setPerms(next);
    void savePerms(next, prev);
  }

  async function saveQuota(
    field: "movieQuotaLimit" | "movieQuotaDays" | "tvQuotaLimit" | "tvQuotaDays",
    raw: string,
  ) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Math.max(0, Math.floor(Number(trimmed)));
    if (value !== null && !Number.isFinite(value)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const displayName = u.name ?? u.email;
  const groups = show4k ? [...PERMISSION_GROUPS, PERMISSION_GROUP_4K] : PERMISSION_GROUPS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[440px] shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 id={titleId} className="text-sm font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-zinc-400" />
            Permissions &amp; Quota
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

        {isSuperAdmin ? (
          <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-300">
            This user is an <strong>Administrator</strong> with full access. Capabilities are
            governed by the Admin role — change the role to adjust access.
          </div>
        ) : (
          <>
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={applyPreset}
                disabled={saving}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
              >
                Reset to {roleLabel[u.role]} preset
              </button>
            </div>
            {groups.map((g) => (
              <div key={g.title} className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{g.title}</p>
                {g.bits.map((b) => (
                  <AdminToggleRow
                    key={b.key}
                    label={b.label}
                    checked={(perms & Permission[b.key]) !== 0n}
                    onChange={() => toggle(Permission[b.key])}
                    disabled={saving}
                  />
                ))}
              </div>
            ))}

            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Quota overrides</p>
              <p className="text-[10px] text-zinc-600 mb-2">Blank = use the global quota. Limit = max requests in a rolling window of N days.</p>
              <QuotaRow
                label="Movies"
                limit={quota.movieQuotaLimit}
                days={quota.movieQuotaDays}
                onLimit={(v) => setQuota((q) => ({ ...q, movieQuotaLimit: v }))}
                onDays={(v) => setQuota((q) => ({ ...q, movieQuotaDays: v }))}
                onBlurLimit={() => saveQuota("movieQuotaLimit", quota.movieQuotaLimit)}
                onBlurDays={() => saveQuota("movieQuotaDays", quota.movieQuotaDays)}
                disabled={saving}
              />
              <QuotaRow
                label="TV"
                limit={quota.tvQuotaLimit}
                days={quota.tvQuotaDays}
                onLimit={(v) => setQuota((q) => ({ ...q, tvQuotaLimit: v }))}
                onDays={(v) => setQuota((q) => ({ ...q, tvQuotaDays: v }))}
                onBlurLimit={() => saveQuota("tvQuotaLimit", quota.tvQuotaLimit)}
                onBlurDays={() => saveQuota("tvQuotaDays", quota.tvQuotaDays)}
                disabled={saving}
              />
            </div>
          </>
        )}

        {saving && (
          <p className="text-xs text-zinc-500 flex items-center gap-1 mt-3">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </p>
        )}
      </div>
    </div>
  );
}

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

function timeAgo(dateStr: string): string {
  const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (secs < 60)    return "just now";
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function SessionsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const [sessions, setSessions]       = useState<AdminAuthSession[]>([]);
  const [loading, setLoading]         = useState(true);
  const [revoking, setRevoking]       = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [confirmingRevokeAll, setConfirmingRevokeAll] = useState(false);
  // Guardrail 16: timeAgo uses Date.now() and toLocaleDateString varies by locale
  const mounted = useHasMounted();
  const titleId = `sessions-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on mount, return focus to opener on unmount, ESC closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    fetch(`/api/admin/users/${u.id}/sessions`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: AdminAuthSession[]) => setSessions(Array.isArray(data) ? data : []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [u.id]);

  async function revoke(sessionId: string) {
    setRevoking(sessionId);
    try {
      const res = await fetch(`/api/admin/users/${u.id}/sessions`, {
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
      const res = await fetch(`/api/admin/users/${u.id}/sessions`, {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[460px] shadow-2xl flex flex-col max-h-[80vh]"
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
                      <Clock className="w-2.5 h-2.5" />Active {mounted ? timeAgo(s.lastSeenAt) : ""}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-600">
                    Expires {mounted ? new Date(s.expiresAt).toLocaleDateString() : ""}
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={revoking === s.sessionId || revokingAll}
                onClick={() => revoke(s.sessionId)}
                aria-label="Revoke this session"
                className="shrink-0 mt-0.5 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
                title="Revoke this session"
              >
                {revoking === s.sessionId
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2  className="w-3.5 h-3.5" />}
              </button>
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

interface ActionsMenuProps {
  u: User;
  onPatch: (key: string, body: object) => void;
  onDelete: () => void;
  has4k?: boolean;
}

function ActionsMenu({ u, onPatch, onDelete, has4k }: ActionsMenuProps) {
  const [open, setOpen]             = useState(false);
  const [notifOpen, setNotifOpen]   = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [permOpen, setPermOpen]     = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function item(
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
    destructive = false,
  ) {
    return (
      <button
        onClick={() => { onClick(); setOpen(false); }}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-left
          ${destructive
            ? "text-red-400 hover:bg-red-500/10"
            : "text-zinc-300 hover:bg-zinc-700/60"
          }`}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="User actions"
        className="h-7 w-7 flex items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-44 rounded-lg bg-zinc-900 border border-zinc-800 shadow-xl p-1">
          <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Set role
          </p>
          {u.role !== "ADMIN" && item(
            () => onPatch("ADMIN", { role: "ADMIN" }),
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400 shrink-0" />,
            "Admin",
          )}
          {u.role !== "ISSUE_ADMIN" && item(
            () => onPatch("ISSUE_ADMIN", { role: "ISSUE_ADMIN" }),
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
            "Issue Admin",
          )}
          {u.role !== "USER" && item(
            () => onPatch("USER", { role: "USER" }),
            <ShieldOff className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            "User",
          )}

          <div className="my-1 border-t border-zinc-800" />

          {item(
            () => setPermOpen(true),
            <Zap className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            "Permissions & Quota",
          )}

          {u.source === "local" && (
            <>
              <div className="my-1 border-t border-zinc-800" />

              {u.mediaServer === null && (
                <>
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    Server access
                  </p>
                  {item(
                    () => onPatch("mediaServer", { mediaServer: "plex" }),
                    <Server className="w-3.5 h-3.5 text-yellow-400 shrink-0" />,
                    "Assign Plex",
                  )}
                  {item(
                    () => onPatch("mediaServer", { mediaServer: "jellyfin" }),
                    <Server className="w-3.5 h-3.5 text-purple-400 shrink-0" />,
                    "Assign Jellyfin",
                  )}
                </>
              )}

              {u.mediaServer !== null && item(
                () => onPatch("mediaServer", { mediaServer: null }),
                <Server className="w-3.5 h-3.5 text-zinc-500 shrink-0" />,
                "Remove server access",
              )}
            </>
          )}

          <div className="my-1 border-t border-zinc-800" />

          {item(
            () => setNotifOpen(true),
            <Bell className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            "Notifications",
          )}
          {item(
            () => setSessionsOpen(true),
            <KeyRound className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            "Sessions",
          )}

          <div className="my-1 border-t border-zinc-800" />

          {item(onDelete, <Trash2 className="w-3.5 h-3.5 shrink-0" />, "Delete user", true)}
        </div>
      )}

      {notifOpen    && <NotificationsModal u={u} onClose={() => setNotifOpen(false)} />}
      {sessionsOpen && <SessionsModal      u={u} onClose={() => setSessionsOpen(false)} />}
      {permOpen     && <PermissionsModal   u={u} onClose={() => setPermOpen(false)} show4k={has4k} />}
    </div>
  );
}

export function UserTable({ users, currentUserId, has4k }: UserTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const mounted = useHasMounted();

  async function patch(id: string, key: string, body: object) {
    setBusy(id + key);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: { error?: string } = await res.json();
      if (data.error) { setError(data.error); return; }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteUser(id: string) {
    setConfirmingDelete(null);
    setBusy(id + "del");
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
      const data: { error?: string } = await res.json();
      if (data.error) { setError(data.error); return; }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {error && (
        <p className="text-sm text-red-400 px-1 mb-1">{error}</p>
      )}

      {users.map((u) => {
        const isSelf = u.id === currentUserId;
        const isBusy = busy?.startsWith(u.id) ?? false;
        const displayName = u.name ?? u.email;
        const initial = displayName[0].toUpperCase();
        // Capability badges read the RAW mask (no ADMIN short-circuit) so they
        // reflect explicitly-granted bits; the role badge already implies admin.
        const rawPerms = parsePermissions(u.permissions);
        const showAutoApprove = (rawPerms & AUTO_APPROVE_MASK) !== 0n;
        const showNoQuota = (rawPerms & Permission.QUOTA_UNLIMITED) !== 0n;

        return (
          <div
            key={u.id}
            className="flex items-center transition-colors"
            style={{
              gap: 12,
              padding: "12px 16px",
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 8,
            }}
          >
            <div
              className={`${avatarColors[u.source]} flex items-center justify-center font-bold text-white shrink-0`}
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                fontSize: 13,
              }}
            >
              {initial}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
                <span
                  className="font-medium truncate"
                  style={{ fontSize: 13, color: "var(--ds-fg)" }}
                >
                  {displayName}
                </span>
                {u.name && (
                  <span
                    className="ds-mono truncate hidden sm:block"
                    style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
                  >
                    {u.email}
                  </span>
                )}
                {isSelf && (
                  <span
                    className="font-medium"
                    style={{ fontSize: 10, color: "var(--ds-accent)" }}
                  >
                    (you)
                  </span>
                )}
              </div>
              <p
                className="ds-mono flex items-center flex-wrap"
                style={{
                  marginTop: 3,
                  gap: 6,
                  fontSize: 10.5,
                  color: "var(--ds-fg-subtle)",
                }}
              >
                <span>
                  Joined {mounted ? new Date(u.createdAt).toLocaleDateString() : ""}
                </span>
                <span>·</span>
                <span>
                  {u._count.requests} request
                  {u._count.requests !== 1 ? "s" : ""}
                </span>
                {u.discordId && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-accent)" }}>
                      Discord linked
                    </span>
                  </>
                )}
                {showAutoApprove && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-success)" }}>
                      Auto-approve
                    </span>
                  </>
                )}
                {showNoQuota && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-info)" }}>No quota</span>
                  </>
                )}
                {u.mediaServer === "plex" && u.source === "local" && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-plex)" }}>Plex access</span>
                  </>
                )}
                {u.mediaServer === "jellyfin" && u.source === "local" && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-jellyfin)" }}>
                      Jellyfin access
                    </span>
                  </>
                )}
              </p>
            </div>

            <div
              className="flex items-center shrink-0"
              style={{ gap: 6 }}
            >
              <Badge
                className={`border text-[10px] px-1.5 h-5 ${sourceStyles[u.source]}`}
              >
                {u.source}
              </Badge>
              <Badge
                className={`border text-[10px] px-1.5 h-5 ${roleStyles[u.role]}`}
              >
                {roleLabel[u.role]}
              </Badge>
            </div>

            {isBusy ? (
              <Loader2
                className="animate-spin shrink-0"
                style={{
                  width: 16,
                  height: 16,
                  color: "var(--ds-fg-subtle)",
                }}
              />
            ) : isSelf ? (
              <div className="w-7 shrink-0" />
            ) : confirmingDelete === u.id ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  aria-label={`Confirm delete ${displayName} and all their requests`}
                  onClick={() => deleteUser(u.id)}
                  autoFocus
                  className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete user
                </button>
                <button
                  type="button"
                  aria-label="Cancel delete"
                  onClick={() => setConfirmingDelete(null)}
                  className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <ActionsMenu
                u={u}
                onPatch={(key, body) => patch(u.id, key, body)}
                onDelete={() => setConfirmingDelete(u.id)}
                has4k={has4k}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
