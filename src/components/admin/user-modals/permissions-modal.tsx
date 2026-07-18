"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  Loader2,
  X,
} from "@/components/icons";
import { Permission, PRESETS, parsePermissions } from "@/lib/permissions";
import { withBasePath } from "@/lib/base-path";
import { CONTENT_RATING_CAPS } from "@/lib/content-rating";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import {
  AdminToggleRow,
  roleLabel,
  type InstanceGrantMap,
  type NamedInstance,
  type User,
} from "./shared";

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
      { key: "REQUEST_ADVANCED", label: "Choose quality profile at request" },
    ],
  },
];

// 4K group — rendered only when a configured 4K instance exists (the page passes
// show4k). Exposes every 4K bit defined in the permission model, including the
// per-type auto-approve bits so an admin can grant "auto-approve 4K movies" (or
// TV) without the blanket AUTO_APPROVE_4K.
const PERMISSION_GROUP_4K: { title: string; bits: { key: keyof typeof Permission; label: string }[] } = {
  title: "4K",
  bits: [
    { key: "REQUEST_4K", label: "Request 4K (all)" },
    { key: "REQUEST_4K_MOVIE", label: "Request 4K movies" },
    { key: "REQUEST_4K_TV", label: "Request 4K TV" },
    { key: "AUTO_APPROVE_4K", label: "Auto-approve 4K (all)" },
    { key: "AUTO_APPROVE_4K_MOVIE", label: "Auto-approve 4K movies" },
    { key: "AUTO_APPROVE_4K_TV", label: "Auto-approve 4K TV" },
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

export function PermissionsModal({ u, onClose, show4k = false, namedInstances = [] }: { u: User; onClose: () => void; show4k?: boolean; namedInstances?: NamedInstance[] }) {
  const router = useRouter();
  const [perms, setPerms] = useState<bigint>(() => parsePermissions(u.permissions));
  const [grants, setGrants] = useState<InstanceGrantMap>(u.instanceGrants);
  const [saving, setSaving] = useState(false);
  const [quota, setQuota] = useState({
    movieQuotaLimit: u.movieQuotaLimit?.toString() ?? "",
    movieQuotaDays: u.movieQuotaDays?.toString() ?? "",
    tvQuotaLimit: u.tvQuotaLimit?.toString() ?? "",
    tvQuotaDays: u.tvQuotaDays?.toString() ?? "",
  });
  const [maxRating, setMaxRating] = useState<string>(u.maxContentRating ?? "");
  const titleId = `perm-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isSuperAdmin = (perms & Permission.ADMIN) !== 0n;

  // Focus-in + Tab-trap + Escape + focus-restore for this hand-rolled overlay.
  useModalA11y(dialogRef, onClose, closeBtnRef);

  async function savePerms(next: bigint, prev: bigint) {
    setSaving(true);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}`), {
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

  async function toggleGrant(slug: string, field: "request" | "autoApprove") {
    const prev = grants;
    const entry = { ...prev[slug], [field]: !prev[slug]?.[field] };
    const next: InstanceGrantMap = { ...prev, [slug]: entry };
    setGrants(next);
    setSaving(true);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceGrants: next }),
      });
      if (!res.ok) {
        setGrants(prev);
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
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
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function saveMaxRating(value: string) {
    const prev = maxRating;
    setMaxRating(value);
    setSaving(true);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxContentRating: value === "" ? null : value }),
      });
      if (!res.ok) {
        setMaxRating(prev);
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const displayName = u.name ?? u.email;
  const groups = show4k ? [...PERMISSION_GROUPS, PERMISSION_GROUP_4K] : PERMISSION_GROUPS;

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[440px] shadow-2xl max-h-[85vh] overflow-y-auto outline-none"
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

            {namedInstances.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Instance access</p>
                <p className="text-[10px] text-zinc-500 mb-2">
                  Per-user access to named Radarr/Sonarr instances. The default instance is open to every requester; 4K uses the permission toggles above.
                </p>
                {namedInstances.map((inst) => {
                  const open = !inst.restricted || inst.serverAll;
                  return (
                    <div key={inst.slug} className="mb-2">
                      <p className="text-[11px] text-zinc-400 mb-0.5">
                        {inst.name}
                        {open && (
                          <span className="text-zinc-500"> — open to all requesters</span>
                        )}
                      </p>
                      {!open && (
                        <AdminToggleRow
                          label={`Request on ${inst.name}`}
                          checked={grants[inst.slug]?.request === true}
                          onChange={() => toggleGrant(inst.slug, "request")}
                          disabled={saving}
                        />
                      )}
                      <AdminToggleRow
                        label={`Auto-approve on ${inst.name}`}
                        checked={grants[inst.slug]?.autoApprove === true}
                        onChange={() => toggleGrant(inst.slug, "autoApprove")}
                        disabled={saving}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Quota overrides</p>
              <p className="text-[10px] text-zinc-500 mb-2">Blank = use the global quota. Limit = max requests in a rolling window of N days.</p>
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

            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Parental control</p>
              <p className="text-[10px] text-zinc-500 mb-2">Maximum content rating this user can request. Applies to movies and TV; admins are exempt.</p>
              <select
                value={maxRating}
                onChange={(e) => saveMaxRating(e.target.value)}
                disabled={saving}
                aria-label="Maximum content rating"
                className="text-xs rounded-md bg-zinc-800 border border-zinc-700 text-zinc-200 px-2 py-1.5"
              >
                <option value="">No limit</option>
                {CONTENT_RATING_CAPS.map((r) => (
                  <option key={r} value={r}>{r} and under</option>
                ))}
              </select>
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
