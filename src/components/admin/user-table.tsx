"use client";

import { useState, useRef, useCallback } from "react";
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
  UserX,
  UserCheck,
} from "@/components/icons";
import { Permission, parsePermissions, AUTO_APPROVE_MASK } from "@/lib/permissions";
import { withBasePath } from "@/lib/base-path";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationsModal } from "./user-modals/notifications-modal";
import { PermissionsModal } from "./user-modals/permissions-modal";
import { SessionsModal } from "./user-modals/sessions-modal";
import { roleLabelKey, type NamedInstance, type RestrictedMediaInstance, type User } from "./user-modals/shared";
import { WatchGradeChip } from "./watch-grade";
import { hasWatchGradeSignal } from "@/lib/watch-grade";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

export type { NamedInstance, RestrictedMediaInstance } from "./user-modals/shared";

interface UserTableProps {
  users: User[];
  currentUserId: string;
  // When a 4K Radarr/Sonarr instance is configured, the permission editor shows
  // the 4K capability toggles (REQUEST_4K / AUTO_APPROVE_4K).
  has4k?: boolean;
  // Named instances (from the registry) the permission editor can grant
  // per-user access to. Empty/absent hides the Instance access section.
  namedInstances?: NamedInstance[];
  // RESTRICTED Plex/Jellyfin servers the permission editor can grant per-user
  // visibility on. Empty/absent hides the Media server access section.
  mediaInstances?: RestrictedMediaInstance[];
}

// Jellyfin is the one DS brand token (`--ds-jellyfin`, the `.ds-chip-jellyfin`
// recipe — black text, white is 2.86:1) everywhere on this page: chip, avatar,
// the Assign icon and the "Jellyfin access" meta line. The old purple-* set
// put the same identity in two hues within one list.
const sourceStyles: Record<User["source"], string> = {
  // Both provider chips use the DS brand recipes (solid brand fill, black text)
  // so Plex and Jellyfin read as one family here and in the server-users table.
  plex:     "ds-chip-plex",
  jellyfin: "ds-chip-jellyfin",
  oidc:     "border-sky-600/30 bg-sky-500/10 text-sky-400",
  local:    "border-zinc-700 bg-zinc-800 text-zinc-400",
  discord:  "border-indigo-600/30 bg-indigo-500/10 text-indigo-400",
};

const roleStyles: Record<User["role"], string> = {
  ADMIN:       "border-indigo-500/30 bg-indigo-500/10 text-indigo-400",
  ISSUE_ADMIN: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  USER:        "border-zinc-700 bg-zinc-800 text-zinc-500",
};

// Fill + initials colour together. yellow-600, sky-700 and the Jellyfin brand
// are fixed fills the theme remap doesn't touch, so their text is fixed too:
// black on the light yellow-600 (white there is ~2.9:1) and on #00a4dc (7.3:1
// vs 2.9:1), white on the dark sky. indigo-600/700 ARE the accent, so they
// take the accent foreground (dark on the amber/emerald/cyan/mono accents).
const avatarColors: Record<User["source"], string> = {
  plex:     "bg-yellow-600 text-black",
  jellyfin: "bg-[var(--ds-jellyfin)] text-black",
  oidc:     "bg-sky-700 text-white",
  local:    "bg-indigo-700 text-[var(--ds-accent-fg)]",
  discord:  "bg-indigo-600 text-[var(--ds-accent-fg)]",
};

// A Plex/Jellyfin sign-in pins User.mediaServer to the provider it came from;
// a local or OIDC account has no such binding, so an admin assigns the server by
// hand. Both of those sources therefore get the Server access controls.
const adminAssignsServer = (source: User["source"]) => source === "local" || source === "oidc";

interface ActionsMenuProps {
  u: User;
  onPatch: (key: string, body: object) => void;
  // Promotion to ADMIN goes through the table's inline confirm — the bit
  // short-circuits every permission check, so a mis-click on the first menu
  // item must not grant it outright while the reversible Disable asks first.
  onPromote: () => void;
  onDisable: () => void;
  onReactivate: () => void;
  onPurge: () => void;
  onResetMfa: () => void;
  has4k?: boolean;
  namedInstances?: NamedInstance[];
  mediaInstances?: RestrictedMediaInstance[];
}

const MENU_LABEL_CLASS = "px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500";

function ActionsMenu({ u, onPatch, onPromote, onDisable, onReactivate, onPurge, onResetMfa, has4k, namedInstances, mediaInstances }: ActionsMenuProps) {
  const t = useT();
  const [notifOpen, setNotifOpen]   = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [permOpen, setPermOpen]     = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Stable identities — useModalA11y keys its effect on onClose, so an inline
  // arrow would re-run the focus-trap setup (and steal focus) on every render.
  const closeNotif = useCallback(() => setNotifOpen(false), []);
  const closeSessions = useCallback(() => setSessionsOpen(false), []);
  const closePerm = useCallback(() => setPermOpen(false), []);

  // Every item hands focus back to the ⋯ trigger BEFORE running its action. The
  // item unmounts with the menu in the same commit that mounts a modal, so the
  // modal's useModalA11y would otherwise capture `document.activeElement ===
  // body` as its opener and Escape would land at the top of the page instead
  // of this row. base-ui's own return-focus runs after the exit animation and
  // stands down once focus has moved into the modal, so the two never fight.
  function item(
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
    destructive = false,
  ) {
    return (
      <DropdownMenuItem
        variant={destructive ? "destructive" : "default"}
        className="gap-2 px-2 py-1.5"
        onClick={() => { triggerRef.current?.focus(); onClick(); }}
      >
        {icon}
        {label}
      </DropdownMenuItem>
    );
  }

  return (
    <div className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label={t("adminManage.users.actions")}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
        >
          <MoreHorizontal className="w-4 h-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel className={MENU_LABEL_CLASS}>{t("adminManage.users.setRole")}</DropdownMenuLabel>
            {u.role !== "ADMIN" && item(
              onPromote,
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-400 shrink-0" />,
              t(roleLabelKey.ADMIN),
            )}
            {u.role !== "ISSUE_ADMIN" && item(
              () => onPatch("ISSUE_ADMIN", { role: "ISSUE_ADMIN" }),
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
              t(roleLabelKey.ISSUE_ADMIN),
            )}
            {u.role !== "USER" && item(
              () => onPatch("USER", { role: "USER" }),
              <ShieldOff className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
              t(roleLabelKey.USER),
            )}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          {item(
            () => setPermOpen(true),
            <Zap className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            t("adminManage.users.menu.permissions"),
          )}

          {adminAssignsServer(u.source) && (
            <>
              <DropdownMenuSeparator />

              {u.mediaServer === null && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel className={MENU_LABEL_CLASS}>{t("adminManage.users.menu.serverAccess")}</DropdownMenuLabel>
                  {item(
                    () => onPatch("mediaServer", { mediaServer: "plex" }),
                    <Server className="w-3.5 h-3.5 text-yellow-400 shrink-0" />,
                    t("adminManage.users.menu.assignPlex"),
                  )}
                  {item(
                    () => onPatch("mediaServer", { mediaServer: "jellyfin" }),
                    <Server className="w-3.5 h-3.5 text-[var(--ds-jellyfin-text)] shrink-0" />,
                    t("adminManage.users.menu.assignJellyfin"),
                  )}
                </DropdownMenuGroup>
              )}

              {u.mediaServer !== null && item(
                () => onPatch("mediaServer", { mediaServer: null }),
                <Server className="w-3.5 h-3.5 text-zinc-500 shrink-0" />,
                t("adminManage.users.menu.removeServer"),
              )}
            </>
          )}

          <DropdownMenuSeparator />

          {item(
            () => setNotifOpen(true),
            <Bell className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            t("adminManage.users.menu.notifications"),
          )}
          {/* Offered to every MANAGE_USERS delegate: the route admits them and
              answers 403 for an ADMIN target, which the modal shows verbatim. */}
          {item(
            () => setSessionsOpen(true),
            <KeyRound className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            t("adminManage.users.menu.sessions"),
          )}
          {/* Lost phone / lost security key: removes every second factor and
              recovery code and signs the account out everywhere. */}
          {u.mfaEnabled && !u.purged && item(
            onResetMfa,
            <ShieldOff className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            t("adminManage.users.menu.resetMfa"),
          )}

          <DropdownMenuSeparator />

          {/* Account removal is two steps: disable (reversible — nothing is
              scrubbed, and the user's watch history keeps being attributed) and
              then purge (irreversible PII scrub). A purged row can't be
              re-enabled, so it gets neither action. */}
          {!u.disabled && item(onDisable, <UserX className="w-3.5 h-3.5 shrink-0" />, t("adminManage.users.menu.disable"), true)}
          {u.disabled && !u.purged && item(
            onReactivate,
            <UserCheck className="w-3.5 h-3.5 text-green-400 shrink-0" />,
            t("adminManage.users.menu.reenable"),
          )}
          {u.disabled && !u.purged && item(onPurge, <Trash2 className="w-3.5 h-3.5 shrink-0" />, t("adminManage.users.menu.purge"), true)}
        </DropdownMenuContent>
      </DropdownMenu>

      {notifOpen    && <NotificationsModal u={u} onClose={closeNotif} />}
      {sessionsOpen && <SessionsModal      u={u} onClose={closeSessions} />}
      {permOpen     && <PermissionsModal   u={u} onClose={closePerm} show4k={has4k} namedInstances={namedInstances} mediaInstances={mediaInstances} />}
    </div>
  );
}

type ConfirmKind = "disable" | "purge" | "resetMfa" | "promote";

export function UserTable({ users, currentUserId, has4k, namedInstances, mediaInstances }: UserTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  // A failed row action, kept with the user it belongs to so it renders under
  // that row — a single banner above a long list was off-screen for anyone
  // working further down it, and didn't say which user it was about.
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  // Inline confirm state, keyed by user id. "disable" is reversible; "purge"
  // is not, so they confirm separately and never share a button. "promote"
  // (→ ADMIN) is the one role change that asks: the bit bypasses every
  // permission check, so it must not be a single mis-click away.
  const [confirming, setConfirming] = useState<{ id: string; kind: ConfirmKind } | null>(null);
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();

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
        setError({ id, message: data?.error ?? t("adminManage.users.error.requestFailed", { status: res.status }) });
        return;
      }
      router.refresh();
    } catch {
      setError({ id, message: t("adminManage.users.error.network") });
    } finally {
      setBusy(null);
    }
  }

  // The three account-lifecycle actions. DELETE disables (reversible, nothing
  // scrubbed); /reactivate turns it back on; /purge is the irreversible scrub and
  // is only offered for an already-disabled account.
  // resetMfa (DELETE …/mfa) rides the same plumbing: it is destructive for the
  // target's sign-in setup, so it gets the same inline confirm.
  async function lifecycle(id: string, action: "disable" | "reactivate" | "purge" | "resetMfa") {
    setConfirming(null);
    setBusy(id + action);
    setError(null);
    const path =
      action === "disable"
        ? `/api/admin/users/${id}`
        : action === "resetMfa"
          ? `/api/admin/users/${id}/mfa`
          : `/api/admin/users/${id}/${action}`;
    try {
      const res = await fetch(withBasePath(path), {
        method: action === "disable" || action === "resetMfa" ? "DELETE" : "POST",
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || data?.error) {
        setError({ id, message: data?.error ?? t("adminManage.users.error.requestFailed", { status: res.status }) });
        return;
      }
      router.refresh();
    } catch {
      setError({ id, message: t("adminManage.users.error.network") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {users.map((u) => {
        const isSelf = u.id === currentUserId;
        const isBusy = busy?.startsWith(u.id) ?? false;
        const displayName = u.name ?? u.email;
        // `?? "?"` guards an empty name string, where [0] is undefined.
        const initial = (displayName[0] ?? "?").toUpperCase();
        // Capability badges read the RAW mask (no ADMIN short-circuit) so they
        // reflect explicitly-granted bits; the role badge already implies admin.
        const rawPerms = parsePermissions(u.permissions);
        const showAutoApprove = (rawPerms & AUTO_APPROVE_MASK) !== 0n;
        const showNoQuota = (rawPerms & Permission.QUOTA_UNLIMITED) !== 0n;

        const rowError = error?.id === u.id ? error.message : null;

        return (
          <div key={u.id}>
          {/* Background is a CLASS, not inline: a hover utility can't beat an
              inline background (guardrail 42), and the server-users table 40px
              below highlights its rows — these didn't. */}
          <div
            className="flex items-center bg-[var(--ds-bg-2)] hover:bg-[var(--ds-bg-3)] transition-colors"
            style={{
              gap: 12,
              padding: "12px 16px",
              border: "1px solid var(--ds-border)",
              borderRadius: 8,
            }}
          >
            <div
              className={`${avatarColors[u.source]} flex items-center justify-center font-bold shrink-0`}
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                fontSize: 13,
              }}
            >
              {initial}
            </div>

            {/* Below sm the badge cluster drops under the name/meta lines instead
                of taking a fixed slice of the row, which left ~30-60px for the
                name on a 375px phone. */}
            <div className="flex-1 min-w-0 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
                <span
                  className="font-medium truncate min-w-0 max-w-full"
                  style={{ fontSize: 13, color: "var(--ds-fg)" }}
                >
                  {displayName}
                </span>
                {u.name && (
                  <span
                    className="ds-mono truncate min-w-0 max-w-full hidden sm:block"
                    style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
                  >
                    {u.email}
                  </span>
                )}
                {isSelf && (
                  <span
                    className="font-medium"
                    style={{ fontSize: 10, color: "var(--ds-accent-text)" }}
                  >
                    {t("adminManage.users.you")}
                  </span>
                )}
              </div>
              {/* Below sm the email moves to its own line: two same-named users
                  were otherwise indistinguishable on a phone. */}
              {u.name && (
                <p
                  className="ds-mono truncate block sm:hidden"
                  style={{ marginTop: 2, fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
                >
                  {u.email}
                </p>
              )}
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
                  {t("adminManage.users.joined", { date: mounted ? new Date(u.createdAt).toLocaleDateString(locale) : "" })}
                </span>
                <span>·</span>
                <span>
                  {t("adminManage.users.requests", { count: u._count.requests })}
                </span>
                {hasWatchGradeSignal(u.watchGrade) && (
                  <>
                    <span>·</span>
                    <WatchGradeChip userId={u.id} userLabel={displayName} summary={u.watchGrade} />
                  </>
                )}
                {u.discordId && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-accent-text)" }}>
                      {t("adminManage.users.discordLinked")}
                    </span>
                  </>
                )}
                {showAutoApprove && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-success)" }}>
                      {t("adminManage.users.autoApprove")}
                    </span>
                  </>
                )}
                {showNoQuota && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-info)" }}>{t("adminManage.users.noQuota")}</span>
                  </>
                )}
                {u.mediaServer === "plex" && adminAssignsServer(u.source) && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-plex-text)" }}>{t("adminManage.users.plexAccess")}</span>
                  </>
                )}
                {u.mediaServer === "jellyfin" && adminAssignsServer(u.source) && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--ds-jellyfin-text)" }}>
                      {t("adminManage.users.jellyfinAccess")}
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
                {t(`adminManage.users.source.${u.source}`)}
              </Badge>
              <Badge
                className={`border text-[10px] px-1.5 h-5 ${roleStyles[u.role]}`}
              >
                {t(roleLabelKey[u.role])}
              </Badge>
              {u.disabled && (
                <Badge
                  className="border text-[10px] px-1.5 h-5 border-red-500/30 bg-red-500/10 text-red-400"
                  title={
                    u.purged
                      ? t("adminManage.users.purgedTitle")
                      : t("adminManage.users.disabledTitle")
                  }
                >
                  {u.purged ? t("adminManage.users.purged") : t("adminManage.users.disabled")}
                </Badge>
              )}
            </div>
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
              <div className="w-8 shrink-0" />
            ) : confirming?.id === u.id ? (
              /* The consequence is VISIBLE, not aria-label-only: a sighted admin
                 saw a red "Purge data" with no "cannot be undone", and Disable
                 never said it was reversible (guardrail 33's vocabulary lived in
                 a badge tooltip shown after the fact). Basis 260px, shrink 1:
                 the sentence wraps rather than widening the row on a phone. */
              <div className="flex flex-col items-end gap-1 min-w-0" style={{ flex: "0 1 260px" }}>
                <span className="text-[11px] text-zinc-400 text-right">
                  {confirming.kind === "disable"
                    ? t("adminManage.users.confirm.disableHint")
                    : confirming.kind === "purge"
                      ? t("adminManage.users.confirm.purgeHint")
                      : confirming.kind === "resetMfa"
                        ? t("adminManage.users.confirm.resetMfaHint")
                        : t("adminManage.users.confirm.promoteHint")}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={
                      confirming.kind === "disable"
                        ? t("adminManage.users.confirm.disableAria", { name: displayName })
                        : confirming.kind === "resetMfa"
                          ? t("adminManage.users.confirm.resetMfaAria", { name: displayName })
                          : confirming.kind === "promote"
                            ? t("adminManage.users.confirm.promoteAria", { name: displayName })
                            : t("adminManage.users.confirm.purgeAria", { name: displayName })
                    }
                    onClick={() => {
                      if (confirming.kind === "promote") {
                        setConfirming(null);
                        void patch(u.id, "ADMIN", { role: "ADMIN" });
                      } else {
                        void lifecycle(u.id, confirming.kind);
                      }
                    }}
                    autoFocus
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      confirming.kind === "promote"
                        // Granting, not destroying: the accent, not danger.
                        ? "bg-[var(--ds-accent)] text-[var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)]"
                        : "bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
                    }`}
                  >
                    {confirming.kind === "disable" ? (
                      <><UserX className="w-3.5 h-3.5" />{t("adminManage.users.confirm.disable")}</>
                    ) : confirming.kind === "resetMfa" ? (
                      <><ShieldOff className="w-3.5 h-3.5" />{t("adminManage.users.confirm.resetMfa")}</>
                    ) : confirming.kind === "promote" ? (
                      <><ShieldCheck className="w-3.5 h-3.5" />{t("adminManage.users.confirm.promote")}</>
                    ) : (
                      <><Trash2 className="w-3.5 h-3.5" />{t("adminManage.users.confirm.purge")}</>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={t("adminManage.common.cancel")}
                    onClick={() => setConfirming(null)}
                    className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                  >
                    {t("adminManage.common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <ActionsMenu
                u={u}
                onPatch={(key, body) => patch(u.id, key, body)}
                onPromote={() => setConfirming({ id: u.id, kind: "promote" })}
                onDisable={() => setConfirming({ id: u.id, kind: "disable" })}
                onReactivate={() => lifecycle(u.id, "reactivate")}
                onPurge={() => setConfirming({ id: u.id, kind: "purge" })}
                onResetMfa={() => setConfirming({ id: u.id, kind: "resetMfa" })}
                has4k={has4k}
                namedInstances={namedInstances}
                mediaInstances={mediaInstances}
              />
            )}
          </div>
          {rowError && (
            <p role="alert" className="text-xs text-red-400 px-4 pt-1">
              {displayName}: {rowError}
            </p>
          )}
          </div>
        );
      })}
    </div>
  );
}
