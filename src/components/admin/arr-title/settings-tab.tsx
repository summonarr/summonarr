"use client";

// The title manager's Settings tab: everything Radarr's/Sonarr's own "Edit"
// dialog offers — monitored, quality profile, root folder (with moving the
// files), tags, Radarr's minimum availability, Sonarr's series type, season
// folders and "monitor new seasons". Every choice comes from the instance
// (the server refuses anything else); only the changed fields are sent
// (PATCH /api/admin/arr/title).

import { useMemo, useState } from "react";
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
  moveFiles: boolean;
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
    moveFiles: true,
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
}: {
  titleRef: TitleRef;
  title: ArrTitle;
  qualityProfiles: Choice[];
  rootFolders: RootFolderChoice[];
  tags: Choice[];
  onSaved: (title: ArrTitle) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // A release date is a calendar date (Radarr stores midnight UTC) — shown as that date, in UTC.
  const releaseDay = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }), [locale]);
  const base = useMemo(() => draftOf(title), [title]);
  const [draft, setDraft] = useState<Draft>(base);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const isMovie = titleRef.service === "radarr";

  // What changed, as the PATCH body's fields.
  const changes = useMemo(() => {
    const c: Record<string, unknown> = {};
    if (draft.monitored !== base.monitored) c.monitored = draft.monitored;
    if (draft.qualityProfileId !== base.qualityProfileId && draft.qualityProfileId !== null) c.qualityProfileId = draft.qualityProfileId;
    if (draft.rootFolderPath !== base.rootFolderPath && draft.rootFolderPath !== null) {
      c.rootFolderPath = draft.rootFolderPath;
      c.moveFiles = draft.moveFiles;
    }
    if (!sameTags(draft.tags, base.tags)) c.tags = draft.tags;
    if (isMovie) {
      if (draft.minimumAvailability !== base.minimumAvailability && draft.minimumAvailability !== null) c.minimumAvailability = draft.minimumAvailability;
    } else {
      if (draft.seriesType !== base.seriesType && draft.seriesType !== null) c.seriesType = draft.seriesType;
      if (draft.seasonFolder !== base.seasonFolder && draft.seasonFolder !== null) c.seasonFolder = draft.seasonFolder;
      if (draft.monitorNewItems !== base.monitorNewItems && draft.monitorNewItems !== null) c.monitorNewItems = draft.monitorNewItems;
    }
    return c;
  }, [draft, base, isMovie]);
  const dirty = Object.keys(changes).length > 0;

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
    setError("");
  }

  async function save() {
    setSaving(true);
    setError("");
    const res = await arrApi<{ title: ArrTitle }>(
      "/api/admin/arr/title",
      { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, ...changes } },
      t("adminArr.settings.saveFailed"),
    );
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDraft(draftOf(res.data.title));
    setSaved(true);
    onSaved(res.data.title);
  }

  // The current values stay selectable even when the instance's list lacks them
  // (an old profile, a root folder spelled without its trailing slash).
  const rootOptions = rootFolders.some((r) => r.path === title.rootFolderPath) || !title.rootFolderPath
    ? rootFolders
    : [{ path: title.rootFolderPath, freeSpace: null, accessible: true }, ...rootFolders];
  const rootChanged = draft.rootFolderPath !== base.rootFolderPath;

  return (
    <div className="grid gap-5">
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
        >
          {draft.qualityProfileId === null && <option value="">—</option>}
          {qualityProfiles.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </StyledSelect>
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
        >
          {draft.rootFolderPath === null && <option value="">—</option>}
          {rootOptions.map((r) => (
            <option key={r.path} value={r.path} disabled={!r.accessible && r.path !== base.rootFolderPath}>
              {r.freeSpace !== null ? t("adminArr.settings.rootFolderFree", { path: r.path, size: fmt.size(r.freeSpace) }) : r.path}
            </option>
          ))}
        </StyledSelect>
        {rootChanged && (
          <label className="mt-2 flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft.moveFiles}
              onChange={(e) => update({ moveFiles: e.target.checked })}
              className="mt-0.5 accent-[var(--ds-accent)]"
            />
            <span>
              {t("adminArr.settings.moveFiles")}
              <span className="block text-xs text-zinc-500">
                {draft.moveFiles ? t("adminArr.settings.moveFilesOn") : t("adminArr.settings.moveFilesOff")}
              </span>
            </span>
          </label>
        )}
      </Field>

      <Field label={t("adminArr.settings.tags")}>
        {tags.length === 0 ? (
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

      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4" style={{ borderColor: "var(--ds-border)" }}>
        {error && (
          <p role="alert" className="m-0 mr-auto flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        {saved && !dirty && (
          <p className="m-0 mr-auto flex items-center gap-1.5 text-xs text-green-400">
            <Check className="h-3.5 w-3.5" /> {t("adminArr.settings.saved")}
          </p>
        )}
        <Button variant="ghost" size="sm" onClick={() => update(base)} disabled={!dirty || saving}>
          {t("adminArr.settings.reset")}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
          {saving && <Loader2 className="animate-spin" />}
          {t("adminArr.settings.save")}
        </Button>
      </div>
    </div>
  );
}
