"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
  Server,
  KeyRound,
} from "@/components/icons";
import { Permission, parsePermissions, AUTO_APPROVE_MASK } from "@/lib/permissions";
import { withBasePath } from "@/lib/base-path";
import { NotificationsModal } from "./user-modals/notifications-modal";
import { PermissionsModal } from "./user-modals/permissions-modal";
import { SessionsModal } from "./user-modals/sessions-modal";
import { roleLabel, type NamedInstance, type User } from "./user-modals/shared";

export type { NamedInstance } from "./user-modals/shared";

interface UserTableProps {
  users: User[];
  currentUserId: string;
  // When a 4K Radarr/Sonarr instance is configured, the permission editor shows
  // the 4K capability toggles (REQUEST_4K / AUTO_APPROVE_4K).
  has4k?: boolean;
  // Named instances (from the registry) the permission editor can grant
  // per-user access to. Empty/absent hides the Instance access section.
  namedInstances?: NamedInstance[];
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

const avatarColors: Record<User["source"], string> = {
  plex:     "bg-yellow-600",
  jellyfin: "bg-purple-700",
  local:    "bg-indigo-700",
};

interface ActionsMenuProps {
  u: User;
  onPatch: (key: string, body: object) => void;
  onDelete: () => void;
  has4k?: boolean;
  namedInstances?: NamedInstance[];
}

function ActionsMenu({ u, onPatch, onDelete, has4k, namedInstances }: ActionsMenuProps) {
  const [open, setOpen]             = useState(false);
  const [notifOpen, setNotifOpen]   = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [permOpen, setPermOpen]     = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Stable identities — useModalA11y keys its effect on onClose, so an inline
  // arrow would re-run the focus-trap setup (and steal focus) on every render.
  const closeNotif = useCallback(() => setNotifOpen(false), []);
  const closeSessions = useCallback(() => setSessionsOpen(false), []);
  const closePerm = useCallback(() => setPermOpen(false), []);

  useEffect(() => {
    if (!open) return;
    // Move focus into the menu so a keyboard user lands on the first item.
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus(); // return focus to the trigger on dismiss
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
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
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-label="User actions"
        aria-haspopup="true"
        aria-expanded={open}
        className="h-7 w-7 flex items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {open && (
        <div ref={menuRef} className="absolute right-0 top-9 z-50 w-44 rounded-lg bg-zinc-900 border border-zinc-800 shadow-xl p-1">
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

      {notifOpen    && <NotificationsModal u={u} onClose={closeNotif} />}
      {sessionsOpen && <SessionsModal      u={u} onClose={closeSessions} />}
      {permOpen     && <PermissionsModal   u={u} onClose={closePerm} show4k={has4k} namedInstances={namedInstances} />}
    </div>
  );
}

export function UserTable({ users, currentUserId, has4k, namedInstances }: UserTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const mounted = useHasMounted();

  async function patch(id: string, key: string, body: object) {
    setBusy(id + key);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || data?.error) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setBusy(null);
    }
  }

  async function deleteUser(id: string) {
    setConfirmingDelete(null);
    setBusy(id + "del");
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${id}`), { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || data?.error) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again");
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
                namedInstances={namedInstances}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
