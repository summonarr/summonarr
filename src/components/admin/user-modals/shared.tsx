"use client";

import type { MediaServerGrants } from "@/lib/permissions";

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
  // How the account authenticates, derived by the page: "local" = passwordHash,
  // "oidc" = an oidc Account row, "jellyfin"/"plex" = the provider-pinned rest.
  // Only the first two have no provider-pinned media server, so only those two
  // get the Server access controls in user-table.tsx.
  source: "local" | "oidc" | "plex" | "jellyfin";
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
}

export const roleLabel: Record<User["role"], string> = {
  ADMIN:       "Admin",
  ISSUE_ADMIN: "Issue Admin",
  USER:        "User",
};

export function AdminToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: () => void; disabled: boolean }) {
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
