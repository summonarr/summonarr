"use client";

import { useState, useRef, useCallback, useEffect, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useAsyncAction } from "@/hooks/use-async-action";
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
  type IconComponent,
} from "@/components/icons";
import { Permission, parsePermissions, AUTO_APPROVE_MASK } from "@/lib/permissions";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
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
import { requestFailureText } from "./request-failure-text";
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

// The row's fixed geometry and type, built once rather than per row per render.
// Colours are DS tokens (guardrail 42); the row background stays a CLASS so its
// hover utility can win (an inline background can't be overridden).
const ROW_STYLE: CSSProperties = { gap: 12, padding: "12px 16px", border: "1px solid var(--ds-border)", borderRadius: 8 };
const AVATAR_STYLE: CSSProperties = { width: 34, height: 34, borderRadius: 999, fontSize: 13 };
const GAP_6: CSSProperties = { gap: 6 };
const NAME_STYLE: CSSProperties = { fontSize: 13, color: "var(--ds-fg)" };
const EMAIL_STYLE: CSSProperties = { fontSize: 10.5, color: "var(--ds-fg-subtle)" };
const EMAIL_LINE_STYLE: CSSProperties = { marginTop: 2, fontSize: 10.5, color: "var(--ds-fg-subtle)" };
const YOU_STYLE: CSSProperties = { fontSize: 10, color: "var(--ds-accent-text)" };
const META_STYLE: CSSProperties = { marginTop: 3, gap: 6, fontSize: 10.5, color: "var(--ds-fg-subtle)" };
const SPINNER_STYLE: CSSProperties = { width: 16, height: 16, color: "var(--ds-fg-subtle)" };
const CONFIRM_STYLE: CSSProperties = { flex: "0 1 260px" };

// A Plex/Jellyfin sign-in pins User.mediaServer to the provider it came from;
// a local or OIDC account has no such binding, so an admin assigns the server by
// hand. Both of those sources therefore get the Server access controls.
const adminAssignsServer = (source: User["source"]) => source === "local" || source === "oidc";

interface ActionsMenuProps {
  u: User;
  // One field per PATCH (the route refuses a body naming two).
  onPatch: (body: object) => void;
  // Promotion to ADMIN goes through the table's inline confirm — the bit
  // short-circuits every permission check, so a mis-click on the first menu
  // item must not grant it outright while the reversible Disable asks first.
  onPromote: () => void;
  // Demoting an ADMIN asks first too: it strips every permission at once.
  onDemote: (role: "USER" | "ISSUE_ADMIN") => void;
  onDisable: () => void;
  onReactivate: () => void;
  onPurge: () => void;
  onResetMfa: () => void;
  has4k?: boolean;
  namedInstances?: NamedInstance[];
  mediaInstances?: RestrictedMediaInstance[];
  // Set after a row action or a cancelled confirm: the trigger this menu mounts
  // takes focus back, so the keyboard doesn't drop to <body>.
  refocus?: boolean;
  onRefocused?: () => void;
}

const MENU_LABEL_CLASS = "px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500";

// The modals a row's menu opens. Stable close callbacks: useModalA11y keys its
// effect on onClose, so an inline arrow would re-run the focus-trap setup (and
// steal focus) on every render.
function useRowModals() {
  const [open, setOpen] = useState<"notif" | "sessions" | "perm" | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return { open, setOpen, close };
}

function ActionsMenu({ u, onPatch, onPromote, onDemote, onDisable, onReactivate, onPurge, onResetMfa, has4k, namedInstances, mediaInstances, refocus, onRefocused }: ActionsMenuProps) {
  const t = useT();
  const modals = useRowModals();
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The confirm panel (or the busy spinner) replaced this menu, and the button
  // that held focus unmounted with it. Take focus back only when nothing else
  // has it: an admin who moved on to another row keeps their place.
  useEffect(() => {
    if (!refocus) return;
    const active = document.activeElement;
    if (!active || active === document.body) triggerRef.current?.focus();
    onRefocused?.();
  }, [refocus, onRefocused]);

  // Every item hands focus back to the ⋯ trigger BEFORE running its action. The
  // item unmounts with the menu in the same commit that mounts a modal, so the
  // modal's useModalA11y would otherwise capture `document.activeElement ===
  // body` as its opener and Escape would land at the top of the page instead
  // of this row. base-ui's own return-focus runs after the exit animation and
  // stands down once focus has moved into the modal, so the two never fight.
  function item(
    onClick: () => void,
    icon: ReactNode,
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
              () => (u.role === "ADMIN" ? onDemote("ISSUE_ADMIN") : onPatch({ role: "ISSUE_ADMIN" })),
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
              t(roleLabelKey.ISSUE_ADMIN),
            )}
            {u.role !== "USER" && item(
              () => (u.role === "ADMIN" ? onDemote("USER") : onPatch({ role: "USER" })),
              <ShieldOff className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
              t(roleLabelKey.USER),
            )}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          {item(
            () => modals.setOpen("perm"),
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
                    () => onPatch({ mediaServer: "plex" }),
                    <Server className="w-3.5 h-3.5 text-yellow-400 shrink-0" />,
                    t("adminManage.users.menu.assignPlex"),
                  )}
                  {item(
                    () => onPatch({ mediaServer: "jellyfin" }),
                    <Server className="w-3.5 h-3.5 text-[var(--ds-jellyfin-text)] shrink-0" />,
                    t("adminManage.users.menu.assignJellyfin"),
                  )}
                </DropdownMenuGroup>
              )}

              {u.mediaServer !== null && item(
                () => onPatch({ mediaServer: null }),
                <Server className="w-3.5 h-3.5 text-zinc-500 shrink-0" />,
                t("adminManage.users.menu.removeServer"),
              )}
            </>
          )}

          <DropdownMenuSeparator />

          {item(
            () => modals.setOpen("notif"),
            <Bell className="w-3.5 h-3.5 text-zinc-400 shrink-0" />,
            t("adminManage.users.menu.notifications"),
          )}
          {/* Offered to every MANAGE_USERS delegate: the route admits them and
              answers 403 for an ADMIN target, which the modal shows verbatim. */}
          {item(
            () => modals.setOpen("sessions"),
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

      {modals.open === "notif"    && <NotificationsModal u={u} onClose={modals.close} />}
      {modals.open === "sessions" && <SessionsModal      u={u} onClose={modals.close} />}
      {modals.open === "perm"     && <PermissionsModal   u={u} onClose={modals.close} show4k={has4k} namedInstances={namedInstances} mediaInstances={mediaInstances} />}
    </div>
  );
}

type ConfirmKind = "disable" | "purge" | "resetMfa" | "promote" | "demote";
type LifecycleAction = "disable" | "reactivate" | "purge" | "resetMfa";

// Everything the inline confirm shows for each kind, in one place, so a new
// kind can't silently borrow another kind's wording in one of the chains.
const CONFIRM_UI: Record<ConfirmKind, { hintKey: string; ariaKey: string; labelKey: string; Icon: IconComponent; tone: "accent" | "danger" }> = {
  disable:  { hintKey: "adminManage.users.confirm.disableHint",  ariaKey: "adminManage.users.confirm.disableAria",  labelKey: "adminManage.users.confirm.disable",  Icon: UserX,       tone: "danger" },
  purge:    { hintKey: "adminManage.users.confirm.purgeHint",    ariaKey: "adminManage.users.confirm.purgeAria",    labelKey: "adminManage.users.confirm.purge",    Icon: Trash2,      tone: "danger" },
  resetMfa: { hintKey: "adminManage.users.confirm.resetMfaHint", ariaKey: "adminManage.users.confirm.resetMfaAria", labelKey: "adminManage.users.confirm.resetMfa", Icon: ShieldOff,   tone: "danger" },
  // Granting, not destroying: the accent, not danger.
  promote:  { hintKey: "adminManage.users.confirm.promoteHint",  ariaKey: "adminManage.users.confirm.promoteAria",  labelKey: "adminManage.users.confirm.promote",  Icon: ShieldCheck, tone: "accent" },
  demote:   { hintKey: "adminManage.users.confirm.demoteHint",   ariaKey: "adminManage.users.confirm.demoteAria",   labelKey: "adminManage.users.confirm.demote",   Icon: ShieldOff,   tone: "danger" },
};
const CONFIRM_TONE_CLASS: Record<"accent" | "danger", string> = {
  accent: "bg-[var(--ds-accent)] text-[var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)]",
  danger: "bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]",
};

// The three account-lifecycle actions and the 2FA reset. DELETE disables
// (reversible, nothing scrubbed); /reactivate turns it back on; /purge is the
// irreversible scrub and is only offered for an already-disabled account.
// resetMfa (DELETE …/mfa) is destructive for the target's sign-in setup, so it
// rides the same inline confirm.
function lifecycleRequest(id: string, action: LifecycleAction): { path: string; method: "DELETE" | "POST" } {
  if (action === "disable") return { path: `/api/admin/users/${id}`, method: "DELETE" };
  if (action === "resetMfa") return { path: `/api/admin/users/${id}/mfa`, method: "DELETE" };
  return { path: `/api/admin/users/${id}/${action}`, method: "POST" };
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

/** A dot-separated item on the meta line, in its own colour. */
function MetaItem({ color, children }: { color: string; children: ReactNode }) {
  return (
    <>
      <span>·</span>
      <span style={{ color }}>{children}</span>
    </>
  );
}

function UserIdentity({ u, isSelf, displayName }: { u: User; isSelf: boolean; displayName: string }) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  // Capability badges read the RAW mask (no ADMIN short-circuit) so they
  // reflect explicitly-granted bits; the role badge already implies admin.
  const rawPerms = parsePermissions(u.permissions);
  const showAutoApprove = (rawPerms & AUTO_APPROVE_MASK) !== 0n;
  const showNoQuota = (rawPerms & Permission.QUOTA_UNLIMITED) !== 0n;
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center flex-wrap" style={GAP_6}>
        <span className="font-medium truncate min-w-0 max-w-full" style={NAME_STYLE}>
          {displayName}
        </span>
        {u.name && (
          <span className="ds-mono truncate min-w-0 max-w-full hidden sm:block" style={EMAIL_STYLE}>
            {u.email}
          </span>
        )}
        {isSelf && (
          <span className="font-medium" style={YOU_STYLE}>
            {t("adminManage.users.you")}
          </span>
        )}
      </div>
      {/* Below sm the email moves to its own line: two same-named users
          were otherwise indistinguishable on a phone. */}
      {u.name && (
        <p className="ds-mono truncate block sm:hidden" style={EMAIL_LINE_STYLE}>
          {u.email}
        </p>
      )}
      <p className="ds-mono flex items-center flex-wrap" style={META_STYLE}>
        <span>
          {/* Locale-formatted only after mount (guardrail 16). */}
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
        {u.discordId && <MetaItem color="var(--ds-accent-text)">{t("adminManage.users.discordLinked")}</MetaItem>}
        {showAutoApprove && <MetaItem color="var(--ds-success)">{t("adminManage.users.autoApprove")}</MetaItem>}
        {showNoQuota && <MetaItem color="var(--ds-info)">{t("adminManage.users.noQuota")}</MetaItem>}
        {u.mediaServer === "plex" && adminAssignsServer(u.source) && (
          <MetaItem color="var(--ds-plex-text)">{t("adminManage.users.plexAccess")}</MetaItem>
        )}
        {u.mediaServer === "jellyfin" && adminAssignsServer(u.source) && (
          <MetaItem color="var(--ds-jellyfin-text)">{t("adminManage.users.jellyfinAccess")}</MetaItem>
        )}
      </p>
    </div>
  );
}

function UserBadges({ u }: { u: User }) {
  const t = useT();
  return (
    <div className="flex items-center shrink-0" style={GAP_6}>
      <Badge className={`border text-[10px] px-1.5 h-5 ${sourceStyles[u.source]}`}>
        {t(`adminManage.users.source.${u.source}`)}
      </Badge>
      <Badge className={`border text-[10px] px-1.5 h-5 ${roleStyles[u.role]}`}>
        {t(roleLabelKey[u.role])}
      </Badge>
      {u.disabled && (
        <Badge
          className="border text-[10px] px-1.5 h-5 border-red-500/30 bg-red-500/10 text-red-400"
          title={u.purged ? t("adminManage.users.purgedTitle") : t("adminManage.users.disabledTitle")}
        >
          {u.purged ? t("adminManage.users.purged") : t("adminManage.users.disabled")}
        </Badge>
      )}
    </div>
  );
}

// The consequence is VISIBLE, not aria-label-only: a sighted admin saw a red
// "Purge data" with no "cannot be undone", and Disable never said it was
// reversible (guardrail 33's vocabulary lived in a badge tooltip shown after
// the fact). Basis 260px, shrink 1: the sentence wraps rather than widening
// the row on a phone.
function RowConfirm({ kind, displayName, onConfirm, onCancel }: { kind: ConfirmKind; displayName: string; onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  const ui = CONFIRM_UI[kind];
  return (
    <div className="flex flex-col items-end gap-1 min-w-0" style={CONFIRM_STYLE}>
      <span className="text-[11px] text-zinc-400 text-right">
        {t(ui.hintKey)}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={t(ui.ariaKey, { name: displayName })}
          onClick={onConfirm}
          autoFocus
          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${CONFIRM_TONE_CLASS[ui.tone]}`}
        >
          <ui.Icon className="w-3.5 h-3.5" />
          {t(ui.labelKey)}
        </button>
        <button
          type="button"
          aria-label={t("adminManage.common.cancel")}
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
        >
          {t("adminManage.common.cancel")}
        </button>
      </div>
    </div>
  );
}

const rowKey = (id: string) => `row:${id}`;

export function UserTable({ users, currentUserId, has4k, namedInstances, mediaInstances }: UserTableProps) {
  const router = useRouter();
  // Per row (keyed by user id), so two rows' actions in flight never clear
  // each other, and one row runs one action at a time.
  const action = useAsyncAction();
  // Failed row actions, kept with the user each belongs to so it renders under
  // that row — a single banner above a long list was off-screen for anyone
  // working further down it, and didn't say which user it was about.
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The row whose actions menu takes focus back once it remounts.
  const [refocusId, setRefocusId] = useState<string | null>(null);
  const clearRefocus = useCallback(() => setRefocusId(null), []);
  // Inline confirm state, keyed by user id. "disable" is reversible; "purge"
  // is not, so they confirm separately and never share a button. "promote"
  // (→ ADMIN) is the one role change that asks: the bit bypasses every
  // permission check, so it must not be a single mis-click away.
  const [confirming, setConfirming] = useState<{ id: string; kind: ConfirmKind; role?: "USER" | "ISSUE_ADMIN" } | null>(null);
  const t = useT();

  // One request on a user's row: the row shows a spinner while it runs and its
  // old error clears; afterwards focus goes back to the row's menu, and the
  // page is re-read on success. The route's own reason is shown on a refusal.
  async function runRow(id: string, path: string, init: RequestInit) {
    setErrors((e) => withoutKey(e, id));
    const res = await action.run(rowKey(id), (signal) => fetchJson(withBasePath(path), { init, signal }), { ifBusy: "skip" });
    if (res === undefined) return;
    setRefocusId(id);
    if (!res.ok) {
      const text = requestFailureText(res, t, { status: "adminManage.users.error.requestFailed", network: "adminManage.users.error.network" });
      if (text !== null) setErrors((e) => ({ ...e, [id]: text }));
      return;
    }
    router.refresh();
  }

  // PATCH edits one field per request (the route refuses two).
  const patch = (id: string, body: object) => runRow(id, `/api/admin/users/${id}`, jsonInit("PATCH", body));

  function lifecycle(id: string, kind: LifecycleAction) {
    setConfirming((c) => (c?.id === id ? null : c));
    const { path, method } = lifecycleRequest(id, kind);
    void runRow(id, path, { method });
  }

  function confirm(id: string, kind: ConfirmKind) {
    if (kind === "promote") {
      setConfirming(null);
      void patch(id, { role: "ADMIN" });
    } else if (kind === "demote") {
      const role = confirming?.role ?? "USER";
      setConfirming(null);
      void patch(id, { role });
    } else {
      lifecycle(id, kind);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {users.map((u) => {
        const isSelf = u.id === currentUserId;
        const isBusy = action.busy(rowKey(u.id));
        const displayName = u.name ?? u.email;
        // `?? "?"` guards an empty name string, where [0] is undefined.
        const initial = (displayName[0] ?? "?").toUpperCase();
        const rowError = errors[u.id] ?? null;
        const confirmKind = confirming?.id === u.id ? confirming.kind : null;

        return (
          <div key={u.id}>
          {/* Background is a CLASS, not inline: a hover utility can't beat an
              inline background (guardrail 42), and the server-users table 40px
              below highlights its rows — these didn't. */}
          <div className="flex items-center bg-[var(--ds-bg-2)] hover:bg-[var(--ds-bg-3)] transition-colors" style={ROW_STYLE}>
            <div className={`${avatarColors[u.source]} flex items-center justify-center font-bold shrink-0`} style={AVATAR_STYLE}>
              {initial}
            </div>

            {/* Below sm the badge cluster drops under the name/meta lines instead
                of taking a fixed slice of the row, which left ~30-60px for the
                name on a 375px phone. */}
            <div className="flex-1 min-w-0 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <UserIdentity u={u} isSelf={isSelf} displayName={displayName} />
              <UserBadges u={u} />
            </div>

            {isBusy ? (
              <Loader2 className="animate-spin shrink-0" style={SPINNER_STYLE} />
            ) : isSelf ? (
              <div className="w-8 shrink-0" />
            ) : confirmKind ? (
              <RowConfirm
                kind={confirmKind}
                displayName={displayName}
                onConfirm={() => confirm(u.id, confirmKind)}
                onCancel={() => { setConfirming(null); setRefocusId(u.id); }}
              />
            ) : (
              <ActionsMenu
                u={u}
                onPatch={(body) => void patch(u.id, body)}
                onPromote={() => setConfirming({ id: u.id, kind: "promote" })}
                onDemote={(role) => setConfirming({ id: u.id, kind: "demote", role })}
                onDisable={() => setConfirming({ id: u.id, kind: "disable" })}
                onReactivate={() => lifecycle(u.id, "reactivate")}
                onPurge={() => setConfirming({ id: u.id, kind: "purge" })}
                onResetMfa={() => setConfirming({ id: u.id, kind: "resetMfa" })}
                has4k={has4k}
                namedInstances={namedInstances}
                mediaInstances={mediaInstances}
                refocus={refocusId === u.id}
                onRefocused={clearRefocus}
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
