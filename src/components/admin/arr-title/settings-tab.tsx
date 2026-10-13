"use client";

// The title manager's Settings tab: everything Radarr's/Sonarr's own "Edit"
// dialog offers — monitored, quality profile, root folder (with moving the
// files), tags, Radarr's minimum availability, Sonarr's series type, season
// folders and "monitor new seasons". Every choice comes from the instance
// (the server refuses anything else); only the changed fields are sent
// (PATCH /api/admin/arr/title).
//
// The form holds the admin's EDITS, not a copy of the title: a field they
// haven't touched always shows the title as the arr last reported it, so a
// background re-read (after a refresh, Radarr unmonitoring a movie whose file
// vanished) can never be saved back over the arr as if the admin had chosen it.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Check, Loader2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle, Choice, RootFolderChoice } from "@/lib/arr-title";
import { arrApi, type TitleRef } from "./shared";

type Draft = {
  monitored: boolean;
  qualityProfileId: number | null;
  rootFolderPath: string | null;
  tags: number[];
  minimumAvailability: string | null;
  seriesType: string | null;
  seasonFolder: boolean | null;
  monitorNewItems: string | null;
};

const AVAILABILITY = ["announced", "inCinemas", "released"] as const;
const SERIES_TYPES = ["standard", "daily", "anime"] as const;
const MONITOR_NEW = ["all", "none"] as const;
const AVAILABILITY_LABEL: Record<string, string> = {
  announced: "adminArr.availability.announced",
  inCinemas: "adminArr.availability.inCinemas",
  released: "adminArr.availability.released",
};
const SERIES_TYPE_LABEL: Record<string, string> = {
  standard: "adminArr.seriesType.standard",
  daily: "adminArr.seriesType.daily",
  anime: "adminArr.seriesType.anime",
};
const MONITOR_NEW_LABEL: Record<string, string> = {
  all: "adminArr.monitorNew.all",
  none: "adminArr.monitorNew.none",
};

function draftOf(title: ArrTitle): Draft {
  return {
    monitored: title.monitored,
    qualityProfileId: title.qualityProfileId,
    rootFolderPath: title.rootFolderPath,
    tags: [...title.tags].sort((a, b) => a - b),
    minimumAvailability: title.minimumAvailability,
    seriesType: title.seriesType,
    seasonFolder: title.seasonFolder,
    monitorNewItems: title.monitorNewItems,
  };
}

const sameTags = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[180px_1fr] sm:items-center">
      <div className="text-sm text-zinc-300">{label}</div>
      <div className="min-w-0">
        {children}
        {hint && <p className="m-0 mt-1 text-xs text-zinc-500">{hint}</p>}
      </div>
    </div>
  );
}

export function SettingsTab({
  titleRef,
  title,
  qualityProfiles,
  rootFolders,
  tags,
  onSaved,
  onDirtyChange,
  onSavingChange,
}: {
  titleRef: TitleRef;
  title: ArrTitle;
  /** null: the instance didn't answer that list — the field is disabled. */
  qualityProfiles: Choice[] | null;
  rootFolders: RootFolderChoice[] | null;
  tags: Choice[] | null;
  /** The title as the arr now has it — null when the save landed but its re-read failed. */
  onSaved: (title: ArrTitle | null) => void;
  /** Tells the manager there are unsaved edits (closing asks first). */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Tells the manager a save is in flight: its PATCH is already sent and the
   * arr applies it, so the manager must not offer to "discard" these edits.
   */
  onSavingChange?: (saving: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // A release date is a calendar date (Radarr stores midnight UTC) — shown as that date, in UTC.
  const releaseDay = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }), [locale]);
  const base = useMemo(() => draftOf(title), [title]);
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const draft: Draft = { ...base, ...edits };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<"plain" | "moving" | null>(null);
  // A root-folder change waits here for the admin's explicit choice about the files.
  const [confirmMove, setConfirmMove] = useState(false);
  const isMovie = titleRef.service === "radarr";
  const service = isMovie ? "Radarr" : "Sonarr";

  // What changed, as the PATCH body's fields.
  const changes = (() => {
    const c: Record<string, unknown> = {};
    if (draft.monitored !== base.monitored) c.monitored = draft.monitored;
    if (draft.qualityProfileId !== base.qualityProfileId && draft.qualityProfileId !== null) c.qualityProfileId = draft.qualityProfileId;
    if (draft.rootFolderPath !== base.rootFolderPath && draft.rootFolderPath !== null) c.rootFolderPath = draft.rootFolderPath;
    if (!sameTags(draft.tags, base.tags)) c.tags = draft.tags;
    if (isMovie) {
      if (draft.minimumAvailability !== base.minimumAvailability && draft.minimumAvailability !== null) c.minimumAvailability = draft.minimumAvailability;
    } else {
      if (draft.seriesType !== base.seriesType && draft.seriesType !== null) c.seriesType = draft.seriesType;
      if (draft.seasonFolder !== base.seasonFolder && draft.seasonFolder !== null) c.seasonFolder = draft.seasonFolder;
      if (draft.monitorNewItems !== base.monitorNewItems && draft.monitorNewItems !== null) c.monitorNewItems = draft.monitorNewItems;
    }
    return c;
  })();
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!saving) return;
    onSavingChange?.(true);
    // The save answered — or this form unmounted under it (the manager reset):
    // either way no save of THIS form is waiting any more.
    return () => onSavingChange?.(false);
  }, [saving, onSavingChange]);

  function update(patch: Partial<Draft>) {
    setEdits((e) => ({ ...e, ...patch }));
    setSaved(null);
    setError("");
    setConfirmMove(false);
  }

  async function save(moveFiles?: boolean) {
    // Moving a title's files is the one irreversible part of an edit: it gets
    // its own explicit choice, nothing pre-selected (Radarr's/Sonarr's own UI
    // asks the same question).
    if (changes.rootFolderPath !== undefined && moveFiles === undefined) {
      setConfirmMove(true);
      return;
    }
    setConfirmMove(false);
    setSaving(true);
    setError("");
    const res = await arrApi<{ title: ArrTitle | null }>(
      "/api/admin/arr/title",
      {
        method: "PATCH",
        body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, ...changes, ...(moveFiles !== undefined ? { moveFiles } : {}) },
      },
      t("adminArr.settings.saveFailed"),
    );
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEdits({});
    setSaved(moveFiles ? "moving" : "plain");
    onSaved(res.data.title);
  }

  // The current values stay selectable even when the instance's list lacks them
  // (an old profile, a root folder spelled without its trailing slash).
  const rootList = rootFolders ?? [];
  const rootOptions = rootList.some((r) => r.path === title.rootFolderPath) || !title.rootFolderPath
    ? rootList
    : [{ path: title.rootFolderPath, freeSpace: null, accessible: true }, ...rootList];
  const target = rootList.find((r) => r.path === draft.rootFolderPath) ?? null;
  // The files won't fit where they're going — a warning, never a block: the
  // arr may count free space differently (same disk, hardlinks).
  const noSpace = target?.freeSpace != null && title.sizeOnDisk > target.freeSpace;
  const unavailable = <p className="m-0 mt-1 text-xs text-amber-400">{t("adminArr.settings.listUnavailable", { service })}</p>;

  return (
    // Disabled while saving: a change made mid-save would be cleared by its answer.
    <fieldset disabled={saving} className="m-0 grid gap-5 border-0 p-0">
      <Field label={t("adminArr.settings.monitored")} hint={isMovie ? t("adminArr.settings.monitoredHintMovie") : t("adminArr.settings.monitoredHintSeries")}>
        <Switch checked={draft.monitored} onCheckedChange={(v) => update({ monitored: v })} aria-label={t("adminArr.settings.monitored")} />
      </Field>

      <Field label={t("adminArr.settings.qualityProfile")}>
        <StyledSelect
          compact
          value={draft.qualityProfileId === null ? "" : String(draft.qualityProfileId)}
          onChange={(e) => update({ qualityProfileId: Number(e.target.value) })}
          aria-label={t("adminArr.settings.qualityProfile")}
          className="sm:max-w-sm"
          disabled={qualityProfiles === null}
        >
          {(draft.qualityProfileId === null || qualityProfiles === null) && <option value={draft.qualityProfileId === null ? "" : String(draft.qualityProfileId)}>—</option>}
          {(qualityProfiles ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </StyledSelect>
        {qualityProfiles === null && unavailable}
      </Field>

      {isMovie ? (
        <Field label={t("adminArr.settings.minimumAvailability")} hint={t("adminArr.settings.minimumAvailabilityHint")}>
          <StyledSelect
            compact
            value={draft.minimumAvailability ?? ""}
            onChange={(e) => update({ minimumAvailability: e.target.value })}
            aria-label={t("adminArr.settings.minimumAvailability")}
            className="sm:max-w-sm"
          >
            {draft.minimumAvailability !== null && !(AVAILABILITY as readonly string[]).includes(draft.minimumAvailability) && (
              <option value={draft.minimumAvailability}>{draft.minimumAvailability}</option>
            )}
            {AVAILABILITY.map((a) => <option key={a} value={a}>{t(AVAILABILITY_LABEL[a])}</option>)}
          </StyledSelect>
        </Field>
      ) : (
        <>
          <Field label={t("adminArr.settings.seriesType")} hint={t("adminArr.settings.seriesTypeHint")}>
            <StyledSelect
              compact
              value={draft.seriesType ?? "standard"}
              onChange={(e) => update({ seriesType: e.target.value })}
              aria-label={t("adminArr.settings.seriesType")}
              className="sm:max-w-sm"
            >
              {SERIES_TYPES.map((s) => <option key={s} value={s}>{t(SERIES_TYPE_LABEL[s])}</option>)}
            </StyledSelect>
          </Field>
          {draft.seasonFolder !== null && (
            <Field label={t("adminArr.settings.seasonFolder")}>
              <Switch checked={draft.seasonFolder} onCheckedChange={(v) => update({ seasonFolder: v })} aria-label={t("adminArr.settings.seasonFolder")} />
            </Field>
          )}
          {/* Sonarr v3 has no such setting — the field is absent there. */}
          {draft.monitorNewItems !== null && (
            <Field label={t("adminArr.settings.monitorNewItems")}>
              <StyledSelect
                compact
                value={draft.monitorNewItems}
                onChange={(e) => update({ monitorNewItems: e.target.value })}
                aria-label={t("adminArr.settings.monitorNewItems")}
                className="sm:max-w-sm"
              >
                {MONITOR_NEW.map((m) => <option key={m} value={m}>{t(MONITOR_NEW_LABEL[m])}</option>)}
              </StyledSelect>
            </Field>
          )}
        </>
      )}

      <Field label={t("adminArr.settings.rootFolder")} hint={title.path ? t("adminArr.settings.currentPath", { path: title.path }) : undefined}>
        <StyledSelect
          compact
          value={draft.rootFolderPath ?? ""}
          onChange={(e) => update({ rootFolderPath: e.target.value })}
          aria-label={t("adminArr.settings.rootFolder")}
          className="sm:max-w-md"
          disabled={rootFolders === null}
        >
          {draft.rootFolderPath === null && <option value="">—</option>}
          {rootOptions.map((r) => (
            <option key={r.path} value={r.path} disabled={!r.accessible && r.path !== base.rootFolderPath}>
              {r.freeSpace !== null ? t("adminArr.settings.rootFolderFree", { path: r.path, size: fmt.size(r.freeSpace) }) : r.path}
            </option>
          ))}
        </StyledSelect>
        {rootFolders === null && unavailable}
      </Field>

      <Field label={t("adminArr.settings.tags")}>
        {tags === null ? (
          unavailable
        ) : tags.length === 0 ? (
          <span className="text-xs text-zinc-500">{t("adminArr.settings.noTags")}</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const on = draft.tags.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ tags: on ? draft.tags.filter((x) => x !== tag.id) : [...draft.tags, tag.id].sort((a, b) => a - b) })}
                  className="ds-hover-tint rounded-full px-2.5 py-1 text-xs transition-colors"
                  style={{
                    border: `1px solid ${on ? "var(--ds-accent)" : "var(--ds-border)"}`,
                    background: on ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
                    color: on ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
                  }}
                >
                  {on && <Check className="mr-1 inline h-3 w-3" aria-hidden />}
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </Field>

      {isMovie && (title.inCinemas || title.physicalRelease || title.digitalRelease) && (
        <Field label={t("adminArr.settings.releaseDates")}>
          <dl className="m-0 grid gap-1 text-xs text-zinc-400 sm:grid-cols-3">
            {([["inCinemas", title.inCinemas], ["physical", title.physicalRelease], ["digital", title.digitalRelease]] as const).map(([k, v]) => (
              <div key={k}>
                <dt className="text-zinc-500">{t(`adminArr.releaseDate.${k}`)}</dt>
                <dd className="m-0 text-zinc-300">{v ? releaseDay.format(Date.parse(v)) : "—"}</dd>
              </div>
            ))}
          </dl>
        </Field>
      )}

      {confirmMove && draft.rootFolderPath !== null && (
        <div role="alertdialog" aria-label={t("adminArr.settings.moveConfirmTitle", { path: draft.rootFolderPath })} className="grid gap-3 rounded-lg p-3" style={{ border: "1px solid var(--ds-warning)", background: "color-mix(in oklab, var(--ds-warning) 10%, transparent)" }}>
          <div className="grid gap-1 text-sm">
            <span className="font-medium text-zinc-100">{t("adminArr.settings.moveConfirmTitle", { path: draft.rootFolderPath })}</span>
            <span className="text-xs text-zinc-400">
              {t("adminArr.settings.moveConfirmBody", { current: title.path ?? base.rootFolderPath ?? "—", size: fmt.size(title.sizeOnDisk) })}
            </span>
            {noSpace && target && (
              <span className="flex items-center gap-1.5 text-xs text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t("adminArr.settings.moveNoSpace", { path: target.path, free: fmt.size(target.freeSpace ?? 0), size: fmt.size(title.sizeOnDisk) })}
              </span>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => void save(true)} disabled={saving} className="ds-hover-tint rounded-md px-3 py-2 text-left text-sm" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}>
              <span className="block text-zinc-100">{t("adminArr.settings.moveFiles")}</span>
              <span className="block text-xs text-zinc-500">{t("adminArr.settings.moveFilesOn")}</span>
            </button>
            <button type="button" onClick={() => void save(false)} disabled={saving} className="ds-hover-tint rounded-md px-3 py-2 text-left text-sm" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}>
              <span className="block text-zinc-100">{t("adminArr.settings.moveNo")}</span>
              <span className="block text-xs text-zinc-500">{t("adminArr.settings.moveFilesOff")}</span>
            </button>
          </div>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setConfirmMove(false)} disabled={saving}>{t("adminArr.common.cancel")}</Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4" style={{ borderColor: "var(--ds-border)" }}>
        {error && (
          <p role="alert" className="m-0 mr-auto flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        {saved && !dirty && (
          <p className="m-0 mr-auto flex items-center gap-1.5 text-xs text-green-400">
            <Check className="h-3.5 w-3.5 shrink-0" /> {saved === "moving" ? t("adminArr.settings.moveStarted", { service }) : t("adminArr.settings.saved")}
          </p>
        )}
        <Button variant="ghost" size="sm" onClick={() => { setEdits({}); setConfirmMove(false); setError(""); }} disabled={!dirty || saving}>
          {t("adminArr.settings.reset")}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || confirmMove}>
          {saving && <Loader2 className="animate-spin" />}
          {t("adminArr.settings.save")}
        </Button>
      </div>
    </fieldset>
  );
}
