"use client";

import type { MediaServerGrants } from "@/lib/permissions";
import type { UserSource } from "@/lib/user-source";
import type { WatchGradeSummary } from "@/lib/watch-grade";
import { useId } from "react";
import { Switch } from "@/components/ui/switch";

// A named (non-default, non-4K) Radarr/Sonarr instance eligible for per-user
// grants. Mirrors the registry's ArrInstanceConfig access fields.
export interface NamedInstance {
  slug: string;
  name: string;
  restricted: boolean;
  serverAll: boolean;
}

export type InstanceGrantMap = Record<string, { request?: boolean; autoApprove?: boolean }>;

// A RESTRICTED Plex/Jellyfin server the visibility editor can grant `view` on.
// Only restricted instances reach the client — an unrestricted server is visible
// to everyone and has nothing to grant, so the page filters rather than shipping
// the whole registry and re-deriving the filter in two places.
//
// `service` is part of the identity, not decoration: grants are service-
// namespaced (permissions.ts), so plex "remote" and jellyfin "remote" are two
// different servers and must never collapse into one row.
export interface RestrictedMediaInstance {
  service: "plex" | "jellyfin";
  slug: string;
  name: string;
}

// The stored per-user shape, straight from the permissions leaf so the editor
// and canViewMediaInstance can never disagree about it.
export type { MediaServerGrants };

export interface User {
  id: string;
  name: string | null;
  email: string;
  role: "ADMIN" | "ISSUE_ADMIN" | "USER";
  createdAt: string;
  // Account lifecycle (src/lib/account-lifecycle.ts). `disabled` — sign-in is
  // refused but nothing was scrubbed, so an admin can re-enable it. `purged` —
  // personal data was irreversibly scrubbed; the row can never be re-enabled.
  // Booleans, not timestamps: the client must not call new Date() in render
  // (guardrail 16), and only the on/off state drives the UI.
  disabled: boolean;
  purged: boolean;
  // Has an active second factor (TOTP or a passkey) — offers Reset two-factor.
  mfaEnabled: boolean;
  // How the account authenticates, derived by the page via deriveUserSource
  // (src/lib/user-source.ts): "local" = passwordHash, "oidc" = an oidc Account
  // row, "jellyfin"/"plex" = the provider-pinned rest, "discord" = a shadow
  // account minted by the Discord interactions route. Only local and oidc have
  // no provider-pinned media server, so only those two get the Server access
  // controls in user-table.tsx.
  source: UserSource;
  discordId: string | null;
  permissions: string;
  instanceGrants: InstanceGrantMap;
  mediaServerGrants: MediaServerGrants;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  mediaServer: "plex" | "jellyfin" | null;
  maxContentRating: string | null;
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
  // Request watch grade (src/lib/watch-grade.ts). null when the feature or play
  // history tracking is off — the table then shows no grade at all.
  watchGrade: WatchGradeSummary | null;
}

// Catalog keys for the role names — translated at render (useT), never here.
export const roleLabelKey: Record<User["role"], string> = {
  ADMIN:       "adminManage.users.role.ADMIN",
  ISSUE_ADMIN: "adminManage.users.role.ISSUE_ADMIN",
  USER:        "adminManage.users.role.USER",
};

// The row is a <label> for the switch, so the whole 36px row toggles — the
// 16×32px sm track alone was the only hit target on touch.
//
// `busy` NEVER disables the switch. Disabling the focused button drops focus to
// <body>, and the modal's Tab trap (use-modal-a11y) then reads the next Tab as
// "outside the container" and sends it back to Close — every toggle threw a
// keyboard user to the top of the dialog. While a save is in flight the change
// is ignored instead and aria-busy says so; the same decision QuotaRow
// documents for its inputs.
export function AdminToggleRow({ label, checked, onChange, busy }: { label: string; checked: boolean; onChange: () => void; busy: boolean }) {
  const switchId = useId();
  return (
    <label htmlFor={switchId} className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0">
      <span className="text-xs text-zinc-300">{label}</span>
      <Switch
        id={switchId}
        size="sm"
        checked={checked}
        aria-busy={busy || undefined}
        onCheckedChange={() => { if (!busy) onChange(); }}
      />
    </label>
  );
}
