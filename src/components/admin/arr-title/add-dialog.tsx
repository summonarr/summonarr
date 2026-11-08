"use client";

// "Add to Radarr/Sonarr" beside the detail pages' "Manage in" for an instance
// that doesn't hold the title (GET/POST /api/admin/arr/title/add): the arr's own
// add choices — quality profile, root folder, tags, monitoring, search now —
// with the instance's configured defaults preselected. Once added (or found
// already there), the button becomes that instance's "Manage in" (by the arr
// id — the synced cache that decides which instances hold a title only learns
// of it at the next sync). Nothing here creates a request: nobody is notified,
// and no watch grade counts it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import { MINIMUM_AVAILABILITIES, SERIES_TYPES, type Choice, type MinimumAvailability, type SeriesType } from "@/lib/arr-title";
import { SONARR_ADD_MONITOR, addSearchIsNoop, type SonarrAddMonitor } from "@/lib/arr-title-add";
import { ADD_ANSWER, ADD_CHOICES, type AddChoices } from "@/lib/client/arr-answers";
import { useAsyncAction } from "@/hooks/use-async-action";
import { arrApi, useTRef, type ArrServiceName } from "./shared";
import { ManageTitleButton } from "./title-manager";
import { ADD_MONITOR_LABEL, AVAILABILITY_LABEL, oneOf, SERIES_TYPE_LABEL } from "./labels";

/** The form's picks. Unions, not strings: only the arr's own words can be sent. */
interface AddPicks {
  profile: number | null;
  root: string;
  tags: number[];
  monitored: boolean;
  availability: MinimumAvailability;
  monitor: SonarrAddMonitor;
  /** The instance has no series-type default of its own; Sonarr's is "standard". */
  seriesType: SeriesType;
  seasonFolder: boolean;
  search: boolean;
}

/**
 * The instance's configured defaults — what a request's add would use — but
 * only one the instance still lists: a profile or folder deleted in the arr
 * since the defaults were saved would preselect a value the select can't show
 * and the add would refuse.
 */
function initialPicks(c: AddChoices): AddPicks {
  const defaultProfile = c.defaults.qualityProfileId;
  const defaultRoot = c.defaults.rootFolderPath;
  const defaultAvailability = c.defaults.minimumAvailability;
  return {
    profile: defaultProfile !== null && c.qualityProfiles.some((p) => p.id === defaultProfile) ? defaultProfile : c.qualityProfiles[0]?.id ?? null,
    root: defaultRoot && c.rootFolders.some((r) => r.path === defaultRoot && r.accessible) ? defaultRoot : c.rootFolders.find((r) => r.accessible)?.path ?? "",
    tags: [],
    monitored: true,
    availability: oneOf(MINIMUM_AVAILABILITIES, defaultAvailability) ? defaultAvailability : "released",
    monitor: "all",
    seriesType: "standard",
    seasonFolder: true,
    search: true,
  };
}

function AddForm({ service, instance, tmdbId, instanceLabel, onAdded }: {
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  instanceLabel: string;
  /**
   * The title is on the instance now — the new arr id, null when the arr took
   * the add but named none — or was already (present). Stable: the choices
   * read depends on it.
   */
  onAdded: (arrId: number | null) => void;
}) {
  const t = useT();
  const [choices, setChoices] = useState<AddChoices | null>(null);
  const [loadError, setLoadError] = useState("");
  const tRef = useTRef();
  // The choices read: a Retry, or the dialog closing, supersedes the one before.
  const action = useAsyncAction();

  // The choices read: on open, and again from Retry after a failed one.
  const loadChoices = useCallback(async () => {
    setLoadError("");
    const q = new URLSearchParams({ service, instance, tmdbId: String(tmdbId) });
    const res = await action.run("choices", (signal) =>
      arrApi(`/api/admin/arr/title/add?${q.toString()}`, { schema: ADD_CHOICES, signal }, tRef.current("adminArr.add.loadFailed")),
    );
    if (!res) return;
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setChoices(res.data);
    // Already there: once the dialog closes, the button is that instance's Manage.
    if (res.data.presentArrId !== null) onAdded(res.data.presentArrId);
  }, [action, service, instance, tmdbId, tRef, onAdded]);

  useEffect(() => {
    void loadChoices();
  }, [loadChoices]);

  if (loadError) {
    return (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-2 py-8 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError}
        <Button variant="ghost" size="sm" onClick={() => void loadChoices()}><RefreshCw /> {t("adminArr.common.retry")}</Button>
      </p>
    );
  }
  if (!choices) {
    return <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>;
  }
  if (choices.presentArrId !== null) {
    return <p className="m-0 py-8 text-sm text-zinc-400">{t("adminArr.add.present", { name: instanceLabel })}</p>;
  }
  return <AddFields service={service} instance={instance} tmdbId={tmdbId} instanceLabel={instanceLabel} choices={choices} onAdded={onAdded} />;
}

/** The add's choices, seeded from the instance's defaults, and the add itself. */
function AddFields({ service, instance, tmdbId, instanceLabel, choices, onAdded }: {
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  instanceLabel: string;
  choices: AddChoices;
  onAdded: (arrId: number | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [form, setForm] = useState<AddPicks>(() => initialPicks(choices));
  const set = <K extends keyof AddPicks>(key: K, value: AddPicks[K]) => setForm((f) => ({ ...f, [key]: value }));
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const action = useAsyncAction();
  const busy = action.busy("add");
  // Nothing monitored ⇒ the arr's add-time search does nothing, so the box is
  // off and disabled rather than a tick that silently means nothing.
  const searchNoop = addSearchIsNoop(service, service === "radarr" ? { monitored: form.monitored } : { monitor: form.monitor });

  async function submit() {
    if (form.profile === null || !form.root) return;
    setError("");
    const body: Record<string, unknown> = { service, instance, tmdbId, qualityProfileId: form.profile, rootFolderPath: form.root, tags: form.tags, search: form.search && !searchNoop };
    if (service === "radarr") Object.assign(body, { monitored: form.monitored, minimumAvailability: form.availability });
    else Object.assign(body, { monitor: form.monitor, seriesType: form.seriesType, seasonFolder: form.seasonFolder });
    const res = await action.run(
      "add",
      (signal) => arrApi("/api/admin/arr/title/add", { method: "POST", body, schema: ADD_ANSWER, signal }, t("adminArr.add.failed")),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAdded(true);
    const arrId = res.data.arrId;
    onAdded(typeof arrId === "number" && Number.isSafeInteger(arrId) && arrId > 0 ? arrId : null);
  }

  if (added) {
    return (
      <p className="m-0 flex items-center gap-2 py-8 text-sm text-green-400">
        <Check className="h-4 w-4 shrink-0" /> {t("adminArr.add.done", { name: instanceLabel })}
      </p>
    );
  }

  const field = "grid gap-1.5 sm:grid-cols-[160px_1fr] sm:items-center";
  // Why Submit is off when the instance offers nothing to pick.
  const noProfile = choices.qualityProfiles.length === 0;
  const noRoot = !choices.rootFolders.some((r) => r.accessible);
  return (
    <div className="grid gap-4">
      {choices.preview && (
        <p className="m-0 text-sm text-zinc-300">
          {choices.preview.title}{choices.preview.year ? ` (${choices.preview.year})` : ""}
        </p>
      )}
      <div className={field}>
        <span className="text-sm text-zinc-300">{t("adminArr.settings.qualityProfile")}</span>
        <StyledSelect compact value={form.profile === null ? "" : String(form.profile)} onChange={(e) => set("profile", Number(e.target.value))} aria-label={t("adminArr.settings.qualityProfile")} className="sm:max-w-sm">
          {choices.qualityProfiles.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </StyledSelect>
      </div>
      <div className={field}>
        <span className="text-sm text-zinc-300">{t("adminArr.settings.rootFolder")}</span>
        <StyledSelect compact value={form.root} onChange={(e) => set("root", e.target.value)} aria-label={t("adminArr.settings.rootFolder")} className="sm:max-w-md">
          {choices.rootFolders.map((r) => (
            <option key={r.path} value={r.path} disabled={!r.accessible}>
              {r.freeSpace !== null ? t("adminArr.settings.rootFolderFree", { path: r.path, size: fmt.size(r.freeSpace) }) : r.path}
            </option>
          ))}
        </StyledSelect>
      </div>
      {service === "radarr" ? (
        <>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.monitored")}</span>
            <Switch checked={form.monitored} onCheckedChange={(v) => set("monitored", v)} aria-label={t("adminArr.settings.monitored")} />
          </div>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.minimumAvailability")}</span>
            <StyledSelect
              compact
              value={form.availability}
              onChange={(e) => { if (oneOf(MINIMUM_AVAILABILITIES, e.target.value)) set("availability", e.target.value); }}
              aria-label={t("adminArr.settings.minimumAvailability")}
              className="sm:max-w-sm"
            >
              {MINIMUM_AVAILABILITIES.map((a) => <option key={a} value={a}>{t(AVAILABILITY_LABEL[a])}</option>)}
            </StyledSelect>
          </div>
        </>
      ) : (
        <>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.add.monitorLabel")}</span>
            <StyledSelect
              compact
              value={form.monitor}
              onChange={(e) => { if (oneOf(SONARR_ADD_MONITOR, e.target.value)) set("monitor", e.target.value); }}
              aria-label={t("adminArr.add.monitorLabel")}
              className="sm:max-w-sm"
            >
              {SONARR_ADD_MONITOR.map((m) => <option key={m} value={m}>{t(ADD_MONITOR_LABEL[m])}</option>)}
            </StyledSelect>
          </div>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.seriesType")}</span>
            <StyledSelect
              compact
              value={form.seriesType}
              onChange={(e) => { if (oneOf(SERIES_TYPES, e.target.value)) set("seriesType", e.target.value); }}
              aria-label={t("adminArr.settings.seriesType")}
              className="sm:max-w-sm"
            >
              {SERIES_TYPES.map((s) => <option key={s} value={s}>{t(SERIES_TYPE_LABEL[s])}</option>)}
            </StyledSelect>
          </div>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.seasonFolder")}</span>
            <Switch checked={form.seasonFolder} onCheckedChange={(v) => set("seasonFolder", v)} aria-label={t("adminArr.settings.seasonFolder")} />
          </div>
        </>
      )}
      {choices.tags.length > 0 && (
        <div className={field}>
          <span className="text-sm text-zinc-300">{t("adminArr.settings.tags")}</span>
          <TagPicker tags={choices.tags} on={form.tags} onChange={(next) => set("tags", next)} />
        </div>
      )}
      <label className={`flex items-start gap-2 text-sm ${searchNoop ? "text-zinc-500" : "text-zinc-300"}`}>
        <input
          type="checkbox"
          checked={form.search && !searchNoop}
          disabled={searchNoop}
          onChange={(e) => set("search", e.target.checked)}
          className="mt-0.5 accent-[var(--ds-accent)]"
        />
        <span>
          {service === "radarr" ? t("adminArr.add.searchMovie") : t("adminArr.add.searchSeries")}
          <span className="block text-xs text-zinc-500">{searchNoop ? t("adminArr.add.searchNeedsMonitor") : t("adminArr.add.searchHint")}</span>
        </span>
      </label>
      <p className="m-0 text-xs text-zinc-500">{t("adminArr.add.noRequest")}</p>
      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {(noProfile || noRoot) && (
        <p className="m-0 flex items-start gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {noProfile && <span className="block">{t("adminArr.add.noQualityProfile", { name: instanceLabel })}</span>}
            {noRoot && <span className="block">{t("adminArr.add.noRootFolder", { name: instanceLabel })}</span>}
          </span>
        </p>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void submit()} disabled={busy || form.profile === null || !form.root}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />} {t("adminArr.add.submit", { name: instanceLabel })}
        </Button>
      </div>
    </div>
  );
}

function TagPicker({ tags, on: onIds, onChange }: { tags: Choice[]; on: number[]; onChange: (next: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const on = onIds.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? onIds.filter((x) => x !== tag.id) : [...onIds, tag.id])}
            className="ds-hover-tint rounded-full px-2.5 py-1 text-xs"
            style={{
              border: `1px solid ${on ? "var(--ds-accent)" : "var(--ds-border)"}`,
              background: on ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
              color: on ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
            }}
          >
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

/** "Add to Radarr / Sonarr" for one instance that doesn't hold the title. Callers render it for admins only. */
export function ArrAddButton({ service, instance, tmdbId, instanceLabel }: {
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  /** Already formatted: "Radarr", "Sonarr (4K)". */
  instanceLabel: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // The title is on the instance (added here, or found already there): its arr
  // id when the arr named one.
  const [onInstance, setOnInstance] = useState<{ arrId: number | null } | null>(null);
  const onAdded = useCallback((arrId: number | null) => setOnInstance({ arrId }), []);
  const label = t("adminArr.add.button", { name: instanceLabel });
  // The trigger this dialog would return focus to is replaced once the title
  // is on the instance: focus goes to what replaces it.
  if (onInstance !== null && !open) {
    if (onInstance.arrId !== null) {
      return <ManageTitleButton service={service} instance={instance} target={{ arrId: onInstance.arrId }} instanceLabel={instanceLabel} autoFocus />;
    }
    // Added, but the arr named no id to manage it by (until the next sync lists it).
    return <AddedNote instanceLabel={instanceLabel} />;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        className="ds-hover-tint inline-flex items-center gap-1.5 rounded-md text-zinc-400 transition-colors hover:text-zinc-100"
        style={{ fontSize: 12, padding: "5px 10px", border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}
      >
        <Plus style={{ width: 12, height: 12 }} aria-hidden />
        {label}
      </button>
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPortal>
            <DialogBackdrop />
            <DialogPopup className="max-w-xl">
              <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-zinc-700 px-6 py-4">
                <DialogTitle className="text-base font-semibold text-zinc-100">{label}</DialogTitle>
                <DialogClose aria-label={t("adminArr.common.close")} title={t("adminArr.common.close")} className="text-zinc-500 transition-colors hover:text-zinc-300">
                  <X className="h-5 w-5" />
                </DialogClose>
              </div>
              <DialogContent>
                <AddForm service={service} instance={instance} tmdbId={tmdbId} instanceLabel={instanceLabel} onAdded={onAdded} />
              </DialogContent>
            </DialogPopup>
          </DialogPortal>
        </Dialog>
      )}
    </>
  );
}

/** "Added to …" in the trigger's place, taking its focus: a title added with no arr id to manage it by. */
function AddedNote({ instanceLabel }: { instanceLabel: string }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <span ref={ref} tabIndex={-1} role="status" className="inline-flex items-center gap-1.5 rounded-md text-green-400" style={{ fontSize: 12, padding: "5px 10px" }}>
      <Check style={{ width: 12, height: 12 }} aria-hidden />
      {t("adminArr.add.done", { name: instanceLabel })}
    </span>
  );
}
