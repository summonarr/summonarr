"use client";

import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ReactNode } from "react";
import {
  ShieldCheck,
  Loader2,
  X,
} from "@/components/icons";
import { Permission } from "@/lib/permissions";
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
import { usePermissionEdits, type QuotaField, type QuotaText } from "./use-permission-edits";
import { useT } from "@/components/i18n/i18n-provider";

type PermissionGroup = { titleKey: string; bits: { key: keyof typeof Permission }[] };

const PERMISSION_GROUPS: PermissionGroup[] = [
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
const PERMISSION_GROUP_4K: PermissionGroup = {
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

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{children}</p>;
}

function SectionNote({ children }: { children: ReactNode }) {
  return <p className="text-[10px] text-zinc-500 mb-2">{children}</p>;
}

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
        // 0 is a valid window: the route reads it as the 7-day default.
        min={0}
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

// Resetting replaces every custom grant at once, so it asks first — the same
// Confirm/Cancel pair the table uses for Disable.
function ResetToPreset({ role, onReset }: { role: User["role"]; onReset: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center justify-end gap-1.5 mb-2">
      {confirming ? (
        <>
          <span className="text-[11px] text-zinc-400">{t("adminManage.perm.reset.confirm")}</span>
          <button
            type="button"
            onClick={() => { setConfirming(false); onReset(); }}
            autoFocus
            className="rounded-md px-2 py-1 text-[11px] font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-50"
          >
            {t("adminManage.perm.reset.button")}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            {t("adminManage.common.cancel")}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md px-2 py-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
        >
          {t("adminManage.perm.reset.toPreset", { role: t(roleLabelKey[role]) })}
        </button>
      )}
    </div>
  );
}

function PermissionGroups({ groups, perms, onToggle }: { groups: PermissionGroup[]; perms: bigint; onToggle: (bit: bigint) => void }) {
  const t = useT();
  return (
    <>
      {groups.map((g) => (
        <div key={g.titleKey} className="mb-3">
          <SectionTitle>{t(g.titleKey)}</SectionTitle>
          {g.bits.map((b) => (
            <AdminToggleRow
              key={b.key}
              label={t(`adminManage.perm.bit.${b.key}`)}
              checked={(perms & Permission[b.key]) !== 0n}
              onChange={() => onToggle(Permission[b.key])}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function InstanceGrantsSection({
  instances,
  grants,
  onToggle,
}: {
  instances: NamedInstance[];
  grants: InstanceGrantMap;
  onToggle: (slug: string, field: "request" | "autoApprove") => void;
}) {
  const t = useT();
  return (
    <div className="mb-3">
      <SectionTitle>{t("adminManage.perm.instance.title")}</SectionTitle>
      <SectionNote>{t("adminManage.perm.instance.description")}</SectionNote>
      {instances.map((inst) => {
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
                onChange={() => onToggle(inst.slug, "request")}
              />
            )}
            <AdminToggleRow
              label={t("adminManage.perm.instance.autoApprove", { name: inst.name })}
              checked={grants[inst.slug]?.autoApprove === true}
              onChange={() => onToggle(inst.slug, "autoApprove")}
            />
          </div>
        );
      })}
    </div>
  );
}

// Restricted Plex/Jellyfin servers. Rendered ONLY when at least one exists — a
// deployment that has never restricted a server sees no trace of this feature.
function MediaGrantsSection({
  instances,
  grants,
  onToggle,
}: {
  instances: RestrictedMediaInstance[];
  grants: MediaServerGrants;
  onToggle: (service: "plex" | "jellyfin", slug: string) => void;
}) {
  const t = useT();
  return (
    <div className="mb-3">
      <SectionTitle>{t("adminManage.perm.media.title")}</SectionTitle>
      <SectionNote>{t("adminManage.perm.media.description")}</SectionNote>
      {instances.map((inst) => (
        <AdminToggleRow
          // Slug alone collides across services — plex:remote and
          // jellyfin:remote are different servers (see MediaServerGrants).
          key={mediaInstanceLabel(inst.service, inst.slug)}
          label={`${inst.name} (${mediaInstanceLabel(inst.service, inst.slug)})`}
          checked={grants[inst.service]?.[inst.slug]?.view === true}
          onChange={() => onToggle(inst.service, inst.slug)}
        />
      ))}
    </div>
  );
}

function QuotaSection({
  quota,
  onText,
  onCommit,
}: {
  quota: QuotaText;
  onText: (field: QuotaField, text: string) => void;
  onCommit: (field: QuotaField, text: string) => void;
}) {
  const t = useT();
  return (
    <div className="mt-3">
      <SectionTitle>{t("adminManage.perm.quota.title")}</SectionTitle>
      <SectionNote>{t("adminManage.perm.quota.description")}</SectionNote>
      <QuotaRow
        label={t("nav.movies")}
        limit={quota.movieQuotaLimit}
        days={quota.movieQuotaDays}
        onLimit={(v) => onText("movieQuotaLimit", v)}
        onDays={(v) => onText("movieQuotaDays", v)}
        onBlurLimit={() => onCommit("movieQuotaLimit", quota.movieQuotaLimit)}
        onBlurDays={() => onCommit("movieQuotaDays", quota.movieQuotaDays)}
        noun={t("adminManage.perm.quota.movieNoun")}
      />
      <QuotaRow
        label={t("adminManage.perm.quota.tv")}
        limit={quota.tvQuotaLimit}
        days={quota.tvQuotaDays}
        onLimit={(v) => onText("tvQuotaLimit", v)}
        onDays={(v) => onText("tvQuotaDays", v)}
        onBlurLimit={() => onCommit("tvQuotaLimit", quota.tvQuotaLimit)}
        onBlurDays={() => onCommit("tvQuotaDays", quota.tvQuotaDays)}
        noun={t("adminManage.perm.quota.tv")}
      />
    </div>
  );
}

function ContentCapSection({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  return (
    <div className="mt-3">
      <SectionTitle>{t("adminManage.perm.parental.title")}</SectionTitle>
      <SectionNote>{t("adminManage.perm.parental.description")}</SectionNote>
      <StyledSelect
        compact
        value={value}
        // Never disabled: a disabled control drops keyboard focus to <body>
        // and the modal's trap then lands on Close. A change made while a save
        // is out is queued behind it (field-save.ts).
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("adminManage.perm.parental.aria")}
        className="w-auto"
      >
        <option value="">{t("adminManage.perm.parental.noLimit")}</option>
        {CONTENT_RATING_CAPS.map((r) => (
          <option key={r} value={r}>{t("adminManage.perm.parental.andUnder", { rating: r })}</option>
        ))}
      </StyledSelect>
    </div>
  );
}

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
  const edits = usePermissionEdits(u);
  const titleId = `perm-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isSuperAdmin = (edits.perms & Permission.ADMIN) !== 0n;

  // The latest flush, so the close handler below can stay stable for
  // useModalA11y (which re-runs its focus-in effect whenever onClose changes)
  // yet still see the latest typed text.
  const flushRef = useRef(edits.flush);
  useEffect(() => {
    flushRef.current = edits.flush;
  });

  // Closing (Escape, the X, or the backdrop) closes only once every change has
  // been saved (usePermissionEdits' flush); a refused save keeps the modal open
  // with its error.
  const handleClose = useCallback(async () => {
    if (await flushRef.current()) onClose();
  }, [onClose]);

  // Focus-in + Tab-trap + Escape + focus-restore for this hand-rolled overlay.
  useModalA11y(dialogRef, handleClose, closeBtnRef);

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
            <ResetToPreset role={u.role} onReset={edits.applyPreset} />
            <PermissionGroups groups={groups} perms={edits.perms} onToggle={edits.toggle} />

            {namedInstances.length > 0 && (
              <InstanceGrantsSection instances={namedInstances} grants={edits.grants} onToggle={edits.toggleGrant} />
            )}

            {/* Sits inside the non-admin branch, so an admin never gets a
                grants list implying they need one: canViewMediaInstance
                short-circuits on the ADMIN bit. */}
            {mediaInstances.length > 0 && (
              <MediaGrantsSection instances={mediaInstances} grants={edits.mediaGrants} onToggle={edits.toggleMediaGrant} />
            )}

            <QuotaSection quota={edits.quota} onText={edits.setQuotaText} onCommit={(field, text) => void edits.saveQuota(field, text)} />
            <ContentCapSection value={edits.maxRating} onChange={edits.saveMaxRating} />
          </>
        )}

        {edits.saving && (
          <p className="text-xs text-zinc-500 flex items-center gap-1 mt-3">
            <Loader2 className="w-3 h-3 animate-spin" /> {t("adminManage.common.saving")}
          </p>
        )}

        {edits.error && (
          <p role="alert" aria-live="assertive" className="text-xs text-red-400 mt-3">
            {edits.error}
          </p>
        )}
      </div>
    </div>
  );
}
