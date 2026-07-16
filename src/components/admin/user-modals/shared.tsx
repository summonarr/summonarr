"use client";

// A named (non-default, non-4K) Radarr/Sonarr instance eligible for per-user
// grants. Mirrors the registry's ArrInstanceConfig access fields.
export interface NamedInstance {
  slug: string;
  name: string;
  restricted: boolean;
  serverAll: boolean;
}

export type InstanceGrantMap = Record<string, { request?: boolean; autoApprove?: boolean }>;

export interface User {
  id: string;
  name: string | null;
  email: string;
  role: "ADMIN" | "ISSUE_ADMIN" | "USER";
  createdAt: string;
  source: "local" | "plex" | "jellyfin";
  discordId: string | null;
  permissions: string;
  instanceGrants: InstanceGrantMap;
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
