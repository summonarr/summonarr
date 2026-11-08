"use client";

// The title manager's Settings tab: everything Radarr's/Sonarr's own "Edit"
// dialog offers — monitored, quality profile, root folder (with moving the
// files), tags, Radarr's minimum availability, Sonarr's series type, season
// folders and "monitor new seasons". Every choice comes from the instance
// (the server refuses anything else); only the changed fields are sent
// (PATCH /api/admin/arr/title).
//
// The form holds the admin's EDITS, not a copy of the title (settings-draft.ts):
// a field they haven't touched always shows the title as the arr last reported
// it, so a background re-read (after a refresh, Radarr unmonitoring a movie
// whose file vanished) can never be saved back over the arr as if the admin had
// chosen it. While the title shown is the last-known SNAPSHOT
// (src/lib/arr-snapshot.ts), edits are kept but Save waits: the live read
// rebases them first, so no save is ever diffed against data that may be a day
// old. Tags are edited as the ones turned on and off (TagDelta), never a whole
// list, so a tag added on the arr since the snapshot survives that rebase.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Check, Loader2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import { MINIMUM_AVAILABILITIES, MONITOR_NEW_ITEMS, SERIES_TYPES, type ArrTitle, type Choice, type RootFolderChoice } from "@/lib/arr-title";
import { TITLE_WRITE } from "@/lib/client/arr-answers";
import { useAsyncAction } from "@/hooks/use-async-action";
import { arrApi, type TitleRef } from "./shared";
import { NO_TAG_DELTA, toggleTagDelta } from "./snapshot-rules";
import { AVAILABILITY_LABEL, MONITOR_NEW_LABEL, oneOf, SERIES_TYPE_LABEL } from "./labels";
import { applyEdits, draftOf, formBase, titleChanges, type Draft, type Edits } from "./settings-draft";

type Formatters = ReturnType<typeof queueFormatters>;

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
  baseIsSnapshot = false,
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
  /** `title` is the snapshot painted on open, not yet rebased by a live read: Save waits for it. */
  baseIsSnapshot?: boolean;
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
  const reported = useMemo(() => draftOf(title), [title]);
  // What a save whose re-read failed sent, on the title it was sent over (settings-draft.ts formBase).
  const [landed, setLanded] = useState<{ on: ArrTitle; draft: Draft } | null>(null);
  const base = formBase(title, reported, landed);
  const [edits, setEdits] = useState<Edits>({});
  const tagDelta = edits.tags ?? NO_TAG_DELTA;
  const draft = applyEdits(base, edits);
  const action = useAsyncAction();
  const saving = action.busy("save");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<"plain" | "moving" | null>(null);
  // A root-folder change waits here for the admin's explicit choice about the files.
  const [confirmMove, setConfirmMove] = useState(false);
  // The move confirm is an alertdialog: focus moves to its first choice when
  // it opens (Save, which had it, is disabled meanwhile), and back to Save
  // when Cancel closes it.
  const saveRef = useRef<HTMLButtonElement>(null);
  const moveChoiceRef = useRef<HTMLButtonElement>(null);
  const refocusSave = useRef(false);
  useEffect(() => {
    if (confirmMove) moveChoiceRef.current?.focus();
    else if (refocusSave.current) {
      refocusSave.current = false;
      saveRef.current?.focus();
    }
  }, [confirmMove]);
  const isMovie = titleRef.service === "radarr";
  const service = isMovie ? "Radarr" : "Sonarr";

  // What changed, as the PATCH body's fields.
  const changes = titleChanges(base, edits, isMovie);
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

  function update(patch: Edits) {
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
    setError("");
    const sent = draft;
    const res = await action.run(
      "save",
      (signal) =>
        arrApi(
          "/api/admin/arr/title",
          {
            method: "PATCH",
            body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, ...changes, ...(moveFiles !== undefined ? { moveFiles } : {}) },
            schema: TITLE_WRITE,
            signal,
          },
          t("adminArr.settings.saveFailed"),
        ),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // The arr has the edits. With no title back, they are shown as the title
    // until the manager's re-read (onSaved(null)) hands in the real one.
    setLanded(res.data.title === null ? { on: title, draft: sent } : null);
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
          {/* The current profile stays selectable when the list lacks it — or the first one would show selected and could never be picked. */}
          {(draft.qualityProfileId === null || !(qualityProfiles ?? []).some((p) => p.id === draft.qualityProfileId)) && (
            <option value={draft.qualityProfileId === null ? "" : String(draft.qualityProfileId)}>{draft.qualityProfileId === null ? "—" : `#${draft.qualityProfileId}`}</option>
          )}
          {(qualityProfiles ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </StyledSelect>
        {qualityProfiles === null && unavailable}
      </Field>

      {isMovie ? (
        <Field label={t("adminArr.settings.minimumAvailability")} hint={t("adminArr.settings.minimumAvailabilityHint")}>
          <VocabularySelect
            value={draft.minimumAvailability}
            choices={MINIMUM_AVAILABILITIES}
            labels={AVAILABILITY_LABEL}
            onChange={(v) => update({ minimumAvailability: v })}
            label={t("adminArr.settings.minimumAvailability")}
          />
        </Field>
      ) : (
        <SeriesFields draft={draft} onChange={update} />
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
          <TagToggles tags={tags} on={draft.tags} onToggle={(id) => update({ tags: toggleTagDelta(tagDelta, base.tags, id) })} />
        )}
      </Field>

      {isMovie && <ReleaseDates title={title} locale={locale} />}

      {confirmMove && draft.rootFolderPath !== null && (
        <MoveConfirm
          to={draft.rootFolderPath}
          from={title.path ?? base.rootFolderPath ?? "—"}
          sizeOnDisk={title.sizeOnDisk}
          noSpaceIn={noSpace ? target : null}
          saving={saving}
          firstChoiceRef={moveChoiceRef}
          onChoose={(moveFiles) => void save(moveFiles)}
          onCancel={() => {
            refocusSave.current = true;
            setConfirmMove(false);
          }}
          fmt={fmt}
        />
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
        <Button ref={saveRef} size="sm" onClick={() => void save()} disabled={!dirty || saving || confirmMove || baseIsSnapshot}>
          {saving && <Loader2 className="animate-spin" />}
          {t("adminArr.settings.save")}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * A select over the arr's own vocabulary. A value it reported outside that
 * vocabulary stays selectable as it was sent, and no value shows as no choice
 * — never as the first word, which then could not be picked (choosing it fires
 * no change).
 */
function VocabularySelect<V extends string>({ value, choices, labels, onChange, label }: {
  value: string | null;
  choices: readonly V[];
  labels: Record<V, string>;
  onChange: (value: string) => void;
  label: string;
}) {
  const t = useT();
  return (
    <StyledSelect compact value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={label} className="sm:max-w-sm">
      {value === null && <option value="">—</option>}
      {value !== null && !oneOf(choices, value) && <option value={value}>{value}</option>}
      {choices.map((c) => <option key={c} value={c}>{t(labels[c])}</option>)}
    </StyledSelect>
  );
}

/** Sonarr's own: series type, season folders (when the arr reports it) and "monitor new seasons" (v4 only). */
function SeriesFields({ draft, onChange }: { draft: Draft; onChange: (patch: Edits) => void }) {
  const t = useT();
  return (
    <>
      <Field label={t("adminArr.settings.seriesType")} hint={t("adminArr.settings.seriesTypeHint")}>
        <VocabularySelect
          value={draft.seriesType}
          choices={SERIES_TYPES}
          labels={SERIES_TYPE_LABEL}
          onChange={(v) => onChange({ seriesType: v })}
          label={t("adminArr.settings.seriesType")}
        />
      </Field>
      {draft.seasonFolder !== null && (
        <Field label={t("adminArr.settings.seasonFolder")}>
          <Switch checked={draft.seasonFolder} onCheckedChange={(v) => onChange({ seasonFolder: v })} aria-label={t("adminArr.settings.seasonFolder")} />
        </Field>
      )}
      {/* Sonarr v3 has no such setting — the field is absent there. */}
      {draft.monitorNewItems !== null && (
        <Field label={t("adminArr.settings.monitorNewItems")}>
          <VocabularySelect
            value={draft.monitorNewItems}
            choices={MONITOR_NEW_ITEMS}
            labels={MONITOR_NEW_LABEL}
            onChange={(v) => onChange({ monitorNewItems: v })}
            label={t("adminArr.settings.monitorNewItems")}
          />
        </Field>
      )}
    </>
  );
}

/** The instance's tags as toggles: on is the form's list (the arr's with the admin's delta over it). */
function TagToggles({ tags, on: onIds, onToggle }: { tags: Choice[]; on: readonly number[]; onToggle: (id: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const on = onIds.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(tag.id)}
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
  );
}

/** Radarr's release dates: calendar dates (midnight UTC) — shown as that date, in UTC. */
function ReleaseDates({ title, locale }: { title: ArrTitle; locale: string }) {
  const t = useT();
  const releaseDay = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }), [locale]);
  if (!title.inCinemas && !title.physicalRelease && !title.digitalRelease) return null;
  return (
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
  );
}

/** A root-folder change's explicit choice about the files: move them, or leave them where they are. */
function MoveConfirm({ to, from, sizeOnDisk, noSpaceIn, saving, firstChoiceRef, onChoose, onCancel, fmt }: {
  to: string;
  from: string;
  sizeOnDisk: number;
  /** The new folder, when the files won't fit there (a warning, never a block). */
  noSpaceIn: RootFolderChoice | null;
  saving: boolean;
  firstChoiceRef: React.Ref<HTMLButtonElement>;
  onChoose: (moveFiles: boolean) => void;
  onCancel: () => void;
  fmt: Formatters;
}) {
  const t = useT();
  return (
    <div role="alertdialog" aria-label={t("adminArr.settings.moveConfirmTitle", { path: to })} className="grid gap-3 rounded-lg p-3" style={{ border: "1px solid var(--ds-warning)", background: "color-mix(in oklab, var(--ds-warning) 10%, transparent)" }}>
      <div className="grid gap-1 text-sm">
        <span className="font-medium text-zinc-100">{t("adminArr.settings.moveConfirmTitle", { path: to })}</span>
        <span className="text-xs text-zinc-400">
          {t("adminArr.settings.moveConfirmBody", { current: from, size: fmt.size(sizeOnDisk) })}
        </span>
        {noSpaceIn && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {t("adminArr.settings.moveNoSpace", { path: noSpaceIn.path, free: fmt.size(noSpaceIn.freeSpace ?? 0), size: fmt.size(sizeOnDisk) })}
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button ref={firstChoiceRef} type="button" onClick={() => onChoose(true)} disabled={saving} className="ds-hover-tint rounded-md px-3 py-2 text-left text-sm" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}>
          <span className="block text-zinc-100">{t("adminArr.settings.moveFiles")}</span>
          <span className="block text-xs text-zinc-500">{t("adminArr.settings.moveFilesOn")}</span>
        </button>
        <button type="button" onClick={() => onChoose(false)} disabled={saving} className="ds-hover-tint rounded-md px-3 py-2 text-left text-sm" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}>
          <span className="block text-zinc-100">{t("adminArr.settings.moveNo")}</span>
          <span className="block text-xs text-zinc-500">{t("adminArr.settings.moveFilesOff")}</span>
        </button>
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t("adminArr.common.cancel")}
        </Button>
      </div>
    </div>
  );
}
