"use client";

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  Loader2,
  X,
} from "@/components/icons";
import { Permission, PRESETS, parsePermissions } from "@/lib/permissions";
import { withBasePath } from "@/lib/base-path";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { CONTENT_RATING_CAPS } from "@/lib/content-rating";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import {
  AdminToggleRow,
  roleLabelKey,
  type InstanceGrantMap,
  type MediaServerGrants,
  type NamedInstance,
  type RestrictedMediaInstance,
  type User,
} from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

const PERMISSION_GROUPS: { titleKey: string; bits: { key: keyof typeof Permission }[] }[] = [
  {
    titleKey: "adminManage.perm.group.request",
    bits: [
      { key: "REQUEST" },
      { key: "REQUEST_MOVIE" },
      { key: "REQUEST_TV" },
    ],
  },
  {
    titleKey: "adminManage.perm.group.autoApprove",
    bits: [
      { key: "AUTO_APPROVE" },
      { key: "AUTO_APPROVE_MOVIE" },
      { key: "AUTO_APPROVE_TV" },
    ],
  },
  {
    // File a request when the user adds a title to their watchlist (Summonarr or
    // Plex). The request still needs the Request bits above and goes through quota,
    // blacklist and approval like any other — this only automates the click.
    titleKey: "adminManage.perm.group.autoRequest",
    bits: [
      { key: "AUTO_REQUEST" },
      { key: "AUTO_REQUEST_MOVIE" },
      { key: "AUTO_REQUEST_TV" },
    ],
  },
  {
    titleKey: "adminManage.perm.group.manage",
    bits: [
      { key: "MANAGE_REQUESTS" },
      { key: "MANAGE_USERS" },
      { key: "MANAGE_ISSUES" },
    ],
  },
  {
    titleKey: "adminManage.perm.group.other",
    bits: [
      { key: "REQUEST_ON_BEHALF" },
      { key: "QUOTA_UNLIMITED" },
      { key: "REQUEST_ADVANCED" },
    ],
  },
];

// 4K group — rendered only when a configured 4K instance exists (the page passes
// show4k). Exposes every 4K bit defined in the permission model, including the
// per-type auto-approve bits so an admin can grant "auto-approve 4K movies" (or
// TV) without the blanket AUTO_APPROVE_4K.
const PERMISSION_GROUP_4K: { titleKey: string; bits: { key: keyof typeof Permission }[] } = {
  titleKey: "adminManage.perm.group.fourK",
  bits: [
    { key: "REQUEST_4K" },
    { key: "REQUEST_4K_MOVIE" },
    { key: "REQUEST_4K_TV" },
    { key: "AUTO_APPROVE_4K" },
    { key: "AUTO_APPROVE_4K_MOVIE" },
    { key: "AUTO_APPROVE_4K_TV" },
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
  noun,
}: {
  label: string;
  limit: string;
  days: string;
  onLimit: (v: string) => void;
  onDays: (v: string) => void;
  onBlurLimit: () => void;
  onBlurDays: () => void;
  // "Movie" / "TV" — names the inputs, which otherwise only carry placeholders.
  noun: string;
}) {
  const t = useT();
  // Enter commits the field the same way leaving it does. The inputs are never
  // disabled while another field saves: that knocked keyboard focus out of the
  // field the admin had just tabbed into.
  const commitOnEnter = (commit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-xs text-zinc-300 w-10 shrink-0">{label}</span>
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        placeholder={t("adminManage.perm.quota.limitPlaceholder")}
        aria-label={t("adminManage.perm.quota.limitAria", { noun })}
        value={limit}
        onChange={(e) => onLimit(e.target.value)}
        onBlur={onBlurLimit}
        onKeyDown={commitOnEnter(onBlurLimit)}
        className="w-16 h-7 md:text-xs"
      />
      <span className="text-[10px] text-zinc-500">{t("adminManage.perm.quota.per")}</span>
      <Input
        type="number"
        min={1}
        inputMode="numeric"
        placeholder={t("adminManage.perm.quota.daysPlaceholder")}
        aria-label={t("adminManage.perm.quota.daysAria", { noun })}
        value={days}
        onChange={(e) => onDays(e.target.value)}
        onBlur={onBlurDays}
        onKeyDown={commitOnEnter(onBlurDays)}
        className="w-16 h-7 md:text-xs"
      />
      <span className="text-[10px] text-zinc-500">{t("adminManage.perm.quota.days")}</span>
    </div>
  );
}

type QuotaField = "movieQuotaLimit" | "movieQuotaDays" | "tvQuotaLimit" | "tvQuotaDays";
const QUOTA_FIELDS: readonly QuotaField[] = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"];

export function PermissionsModal({
  u,
  onClose,
  show4k = false,
  namedInstances = [],
  mediaInstances = [],
}: {
  u: User;
  onClose: () => void;
  show4k?: boolean;
  namedInstances?: NamedInstance[];
  // RESTRICTED Plex/Jellyfin servers only. Empty on every deployment that has
  // never restricted one — which is the overwhelming majority — and the section
  // then renders nothing at all rather than an empty heading.
  mediaInstances?: RestrictedMediaInstance[];
}) {
  const t = useT();
  const router = useRouter();
  const [perms, setPerms] = useState<bigint>(() => parsePermissions(u.permissions));
  const [grants, setGrants] = useState<InstanceGrantMap>(u.instanceGrants);
  const [mediaGrants, setMediaGrants] = useState<MediaServerGrants>(u.mediaServerGrants);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState({
    movieQuotaLimit: u.movieQuotaLimit?.toString() ?? "",
    movieQuotaDays: u.movieQuotaDays?.toString() ?? "",
    tvQuotaLimit: u.tvQuotaLimit?.toString() ?? "",
    tvQuotaDays: u.tvQuotaDays?.toString() ?? "",
  });
  // The last value sent (or loaded) per quota field. Compared against instead of
  // the `u` prop, which stays stale until router.refresh lands — so an Enter
  // followed by a blur, or a close right after either, doesn't PATCH twice.
  const committedQuota = useRef<Record<QuotaField, number | null>>({
    movieQuotaLimit: u.movieQuotaLimit ?? null,
    movieQuotaDays: u.movieQuotaDays ?? null,
    tvQuotaLimit: u.tvQuotaLimit ?? null,
    tvQuotaDays: u.tvQuotaDays ?? null,
  });
  // Saves every uncommitted quota edit. Refreshed after each render so the
  // close handler below can stay stable for useModalA11y (which re-runs its
  // focus-in effect whenever onClose changes) yet still see the latest text.
  const flushQuotaRef = useRef<() => void>(() => {});
  const [confirmReset, setConfirmReset] = useState(false);
  const [maxRating, setMaxRating] = useState<string>(u.maxContentRating ?? "");
  const titleId = `perm-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isSuperAdmin = (perms & Permission.ADMIN) !== 0n;

  // Closing (Escape, the X, or the backdrop) unmounts the quota inputs without
  // firing their onBlur, which silently dropped a value just typed. Flush any
  // uncommitted quota edit first; saveQuota no-ops for unchanged fields.
  const handleClose = useCallback(() => {
    flushQuotaRef.current();
    onClose();
  }, [onClose]);

  // Focus-in + Tab-trap + Escape + focus-restore for this hand-rolled overlay.
  useModalA11y(dialogRef, handleClose, closeBtnRef);

  // Every change in this modal works the same way: update local state first
  // (an "optimistic" update), PATCH the one field that changed, and call
  // `rollback` to undo the local change if the server refuses. The server's
  // error message is shown, because some refusals are things an admin does on
  // purpose and needs explained:
  //   • clearing the last permission bit sends a mask of 0, which the route
  //     rejects with a sentence explaining what to do instead;
  //   • a quota limit of 0 is rejected because 0 already means "unlimited" —
  //     the response spells out the real alternatives.
  // The route also allows only 20 PATCHes a minute and this modal has up to 18
  // checkboxes, so an admin clicking steadily down the list can hit a 429.
  //
  // The rollback only has to restore the value it captured: the nested updates
  // below build new maps instead of editing `prev`, so no deep copy is needed.
  async function patchUser(body: Record<string, unknown>, rollback: () => void): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        rollback();
        setError(data?.error ?? t("adminManage.notif.failed", { status: res.status }));
        return;
      }
      router.refresh();
    } catch {
      // A network failure throws instead of returning a response, so the
      // !res.ok branch above never runs. Roll back here too, and swallow the
      // error: callers don't await this promise, so a throw would go unhandled.
      rollback();
      setError(t("adminManage.users.error.network"));
    } finally {
      setSaving(false);
    }
  }

  function toggle(bit: bigint) {
    const prev = perms;
    const next = (perms & bit) !== 0n ? perms & ~bit : perms | bit;
    setPerms(next);
    void patchUser({ permissions: next.toString() }, () => setPerms(prev));
  }

  function applyPreset() {
    setConfirmReset(false);
    const prev = perms;
    const next = PRESETS[u.role] ?? PRESETS.USER;
    setPerms(next);
    void patchUser({ permissions: next.toString() }, () => setPerms(prev));
  }

  async function toggleGrant(slug: string, field: "request" | "autoApprove") {
    const prev = grants;
    const entry = { ...prev[slug], [field]: !prev[slug]?.[field] };
    const next: InstanceGrantMap = { ...prev, [slug]: entry };
    setGrants(next);
    await patchUser({ instanceGrants: next }, () => setGrants(prev));
  }

  // Visibility grant on a RESTRICTED Plex/Jellyfin server. Service-namespaced —
  // the two service maps are written independently so granting plex:remote can
  // never touch a jellyfin instance that happens to share the slug.
  async function toggleMediaGrant(service: "plex" | "jellyfin", slug: string) {
    const prev = mediaGrants;
    const serviceMap = { ...(prev[service] ?? {}) };
    serviceMap[slug] = { view: serviceMap[slug]?.view !== true };
    const next: MediaServerGrants = { ...prev, [service]: serviceMap };
    setMediaGrants(next);
    await patchUser({ mediaServerGrants: next }, () => setMediaGrants(prev));
  }

  async function saveQuota(field: QuotaField, raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Math.max(0, Math.floor(Number(trimmed)));
    if (value !== null && !Number.isFinite(value)) return;
    // Nothing changed, so nothing to save. This runs on blur, so without this
    // check just tabbing through the four inputs would send four PATCHes — each
    // writing a no-op audit row and using up the 20-per-minute rate limit
    // shared with the permission checkboxes above.
    const prev = committedQuota.current[field];
    if (value === prev) return;
    committedQuota.current[field] = value;
    // Rollback restores the server's value, not the typed text: the server
    // refused, so what it holds is still what it held before.
    await patchUser({ [field]: value }, () => {
      committedQuota.current[field] = prev;
      setQuota((q) => ({ ...q, [field]: prev?.toString() ?? "" }));
    });
  }
  useEffect(() => {
    flushQuotaRef.current = () => {
      for (const field of QUOTA_FIELDS) void saveQuota(field, quota[field]);
    };
  });

  async function saveMaxRating(value: string) {
    const prev = maxRating;
    setMaxRating(value);
    await patchUser({ maxContentRating: value === "" ? null : value }, () => setMaxRating(prev));
  }

  const displayName = u.name ?? u.email;
  const groups = show4k ? [...PERMISSION_GROUPS, PERMISSION_GROUP_4K] : PERMISSION_GROUPS;

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={handleClose}>
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
          <h3 id={titleId} className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-zinc-400" />
            {t("adminManage.users.menu.permissions")}
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={t("adminManage.common.close")}
            onClick={handleClose}
            className="-m-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{displayName}</p>

        {isSuperAdmin ? (
          <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-300">
            {t("adminManage.perm.superAdmin.before")} <strong>{t("adminManage.perm.superAdmin.role")}</strong> {t("adminManage.perm.superAdmin.after")}
          </div>
        ) : (
          <>
            {/* Resetting replaces every custom grant at once, so it asks first —
                the same Confirm/Cancel pair the table uses for Disable. */}
            <div className="flex items-center justify-end gap-1.5 mb-2">
              {confirmReset ? (
                <>
                  <span className="text-[11px] text-zinc-400">{t("adminManage.perm.reset.confirm")}</span>
                  <button
                    type="button"
                    onClick={applyPreset}
                    disabled={saving}
                    autoFocus
                    className="rounded-md px-2 py-1 text-[11px] font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-50"
                  >
                    {t("adminManage.perm.reset.button")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                  >
                    {t("adminManage.common.cancel")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  disabled={saving}
                  className="rounded-md px-2 py-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                >
                  {t("adminManage.perm.reset.toPreset", { role: t(roleLabelKey[u.role]) })}
                </button>
              )}
            </div>
            {groups.map((g) => (
              <div key={g.titleKey} className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t(g.titleKey)}</p>
                {g.bits.map((b) => (
                  <AdminToggleRow
                    key={b.key}
                    label={t(`adminManage.perm.bit.${b.key}`)}
                    checked={(perms & Permission[b.key]) !== 0n}
                    onChange={() => toggle(Permission[b.key])}
                    busy={saving}
                  />
                ))}
              </div>
            ))}

            {namedInstances.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t("adminManage.perm.instance.title")}</p>
                <p className="text-[10px] text-zinc-500 mb-2">
                  {t("adminManage.perm.instance.description")}
                </p>
                {namedInstances.map((inst) => {
                  const open = !inst.restricted || inst.serverAll;
                  return (
                    <div key={inst.slug} className="mb-2">
                      <p className="text-[11px] text-zinc-400 mb-0.5">
                        {inst.name}
                        {open && (
                          <span className="text-zinc-500"> — {t("adminManage.perm.instance.open")}</span>
                        )}
                      </p>
                      {!open && (
                        <AdminToggleRow
                          label={t("adminManage.perm.instance.request", { name: inst.name })}
                          checked={grants[inst.slug]?.request === true}
                          onChange={() => toggleGrant(inst.slug, "request")}
                          busy={saving}
                        />
                      )}
                      <AdminToggleRow
                        label={t("adminManage.perm.instance.autoApprove", { name: inst.name })}
                        checked={grants[inst.slug]?.autoApprove === true}
                        onChange={() => toggleGrant(inst.slug, "autoApprove")}
                        busy={saving}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* Restricted Plex/Jellyfin servers. Rendered ONLY when at least one
                exists — a deployment that has never restricted a server sees no
                trace of this feature. Sits inside the non-admin branch, so an
                admin never gets a grants list implying they need one:
                canViewMediaInstance short-circuits on the ADMIN bit. */}
            {mediaInstances.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t("adminManage.perm.media.title")}</p>
                <p className="text-[10px] text-zinc-500 mb-2">
                  {t("adminManage.perm.media.description")}
                </p>
                {mediaInstances.map((inst) => (
                  <AdminToggleRow
                    // Slug alone collides across services — plex:remote and
                    // jellyfin:remote are different servers (see MediaServerGrants).
                    key={mediaInstanceLabel(inst.service, inst.slug)}
                    label={`${inst.name} (${mediaInstanceLabel(inst.service, inst.slug)})`}
                    checked={mediaGrants[inst.service]?.[inst.slug]?.view === true}
                    onChange={() => toggleMediaGrant(inst.service, inst.slug)}
                    busy={saving}
                  />
                ))}
              </div>
            )}

            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t("adminManage.perm.quota.title")}</p>
              <p className="text-[10px] text-zinc-500 mb-2">{t("adminManage.perm.quota.description")}</p>
              <QuotaRow
                label={t("nav.movies")}
                limit={quota.movieQuotaLimit}
                days={quota.movieQuotaDays}
                onLimit={(v) => setQuota((q) => ({ ...q, movieQuotaLimit: v }))}
                onDays={(v) => setQuota((q) => ({ ...q, movieQuotaDays: v }))}
                onBlurLimit={() => saveQuota("movieQuotaLimit", quota.movieQuotaLimit)}
                onBlurDays={() => saveQuota("movieQuotaDays", quota.movieQuotaDays)}
                noun={t("adminManage.perm.quota.movieNoun")}
              />
              <QuotaRow
                label={t("adminManage.perm.quota.tv")}
                limit={quota.tvQuotaLimit}
                days={quota.tvQuotaDays}
                onLimit={(v) => setQuota((q) => ({ ...q, tvQuotaLimit: v }))}
                onDays={(v) => setQuota((q) => ({ ...q, tvQuotaDays: v }))}
                onBlurLimit={() => saveQuota("tvQuotaLimit", quota.tvQuotaLimit)}
                onBlurDays={() => saveQuota("tvQuotaDays", quota.tvQuotaDays)}
                noun={t("adminManage.perm.quota.tv")}
              />
            </div>

            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{t("adminManage.perm.parental.title")}</p>
              <p className="text-[10px] text-zinc-500 mb-2">{t("adminManage.perm.parental.description")}</p>
              <StyledSelect
                compact
                value={maxRating}
                // Not disabled while saving: a disabled control drops keyboard
                // focus to <body> and the modal's trap then lands on Close (the
                // switches had the same defect). Ignore changes mid-save instead.
                onChange={(e) => { if (!saving) saveMaxRating(e.target.value); }}
                aria-busy={saving || undefined}
                aria-label={t("adminManage.perm.parental.aria")}
                className="w-auto"
              >
                <option value="">{t("adminManage.perm.parental.noLimit")}</option>
                {CONTENT_RATING_CAPS.map((r) => (
                  <option key={r} value={r}>{t("adminManage.perm.parental.andUnder", { rating: r })}</option>
                ))}
              </StyledSelect>
            </div>
          </>
        )}

        {saving && (
          <p className="text-xs text-zinc-500 flex items-center gap-1 mt-3">
            <Loader2 className="w-3 h-3 animate-spin" /> {t("adminManage.common.saving")}
          </p>
        )}

        {error && (
          <p role="alert" aria-live="assertive" className="text-xs text-red-400 mt-3">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
