"use client";

// "Add to Radarr/Sonarr" beside the detail pages' "Manage in" for an instance
// that doesn't hold the title (GET/POST /api/admin/arr/title/add): the arr's own
// add choices — quality profile, root folder, tags, monitoring, search now —
// with the instance's configured defaults preselected. Once added, the button
// becomes that instance's "Manage in" (by the new arr id — the synced cache
// that decides which instances hold a title only learns of it at the next
// sync). Nothing here creates a request: nobody is notified, and no watch
// grade counts it.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, Loader2, Plus, X } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import type { Choice, RootFolderChoice } from "@/lib/arr-title";
import { SONARR_ADD_MONITOR, addSearchIsNoop, type SonarrAddMonitor } from "@/lib/arr-title-add";
import { arrApi, type ArrServiceName } from "./shared";
import { ManageTitleButton } from "./title-manager";

interface AddChoices {
  presentArrId: number | null;
  preview: { tmdbId: number; title: string; year: number | null } | null;
  qualityProfiles: Choice[];
  rootFolders: RootFolderChoice[];
  tags: Choice[];
  defaults: { qualityProfileId: number | null; rootFolderPath: string | null; minimumAvailability: string | null };
}

// Literal maps — never a built key (the i18n dead-key check can't see one).
const MONITOR_LABEL: Record<SonarrAddMonitor, string> = {
  all: "adminArr.add.monitor.all",
  future: "adminArr.add.monitor.future",
  missing: "adminArr.add.monitor.missing",
  existing: "adminArr.add.monitor.existing",
  pilot: "adminArr.add.monitor.pilot",
  firstSeason: "adminArr.add.monitor.firstSeason",
  latestSeason: "adminArr.add.monitor.latestSeason",
  none: "adminArr.add.monitor.none",
};
const AVAILABILITY = ["announced", "inCinemas", "released"] as const;
const AVAILABILITY_LABEL: Record<(typeof AVAILABILITY)[number], string> = {
  announced: "adminArr.availability.announced",
  inCinemas: "adminArr.availability.inCinemas",
  released: "adminArr.availability.released",
};
const SERIES_TYPES = ["standard", "daily", "anime"] as const;
const SERIES_TYPE_LABEL: Record<(typeof SERIES_TYPES)[number], string> = {
  standard: "adminArr.seriesType.standard",
  daily: "adminArr.seriesType.daily",
  anime: "adminArr.seriesType.anime",
};

function AddForm({ service, instance, tmdbId, instanceLabel, onDone }: {
  service: ArrServiceName;
  instance: string;
  tmdbId: number;
  instanceLabel: string;
  onDone: (arrId: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [choices, setChoices] = useState<AddChoices | null>(null);
  const [loadError, setLoadError] = useState("");
  const [profile, setProfile] = useState<number | null>(null);
  const [root, setRoot] = useState<string>("");
  const [tags, setTags] = useState<number[]>([]);
  const [monitored, setMonitored] = useState(true);
  const [availability, setAvailability] = useState<string>("released");
  const [monitor, setMonitor] = useState<SonarrAddMonitor>("all");
  const [seriesType, setSeriesType] = useState<string>("standard");
  const [seasonFolder, setSeasonFolder] = useState(true);
  const [search, setSearch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  // Nothing monitored ⇒ the arr's add-time search does nothing, so the box is
  // off and disabled rather than a tick that silently means nothing.
  const searchNoop = addSearchIsNoop(service, service === "radarr" ? { monitored } : { monitor });

  useEffect(() => {
    let live = true;
    void (async () => {
      const q = new URLSearchParams({ service, instance, tmdbId: String(tmdbId) });
      const res = await arrApi<AddChoices>(`/api/admin/arr/title/add?${q.toString()}`, undefined, tRef.current("adminArr.add.loadFailed"));
      if (!live) return;
      if (!res.ok) {
        setLoadError(res.error);
        return;
      }
      const c = res.data;
      setChoices(c);
      // The instance's configured defaults — what a request's add would use —
      // but only one the instance still lists: a profile or folder deleted in
      // the arr since the defaults were saved would preselect a value the
      // select can't show and the add would refuse.
      const defaultProfile = c.defaults.qualityProfileId;
      setProfile(defaultProfile !== null && c.qualityProfiles.some((p) => p.id === defaultProfile) ? defaultProfile : c.qualityProfiles[0]?.id ?? null);
      setRoot(c.defaults.rootFolderPath && c.rootFolders.some((r) => r.path === c.defaults.rootFolderPath && r.accessible) ? c.defaults.rootFolderPath : c.rootFolders.find((r) => r.accessible)?.path ?? "");
      const defaultAvailability = c.defaults.minimumAvailability;
      if (defaultAvailability && (AVAILABILITY as readonly string[]).includes(defaultAvailability)) setAvailability(defaultAvailability);
    })();
    return () => {
      live = false;
    };
  }, [service, instance, tmdbId]);

  async function submit() {
    if (profile === null || !root) return;
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = { service, instance, tmdbId, qualityProfileId: profile, rootFolderPath: root, tags, search: search && !searchNoop };
    if (service === "radarr") Object.assign(body, { monitored, minimumAvailability: availability });
    else Object.assign(body, { monitor, seriesType, seasonFolder });
    const res = await arrApi<{ arrId: number }>("/api/admin/arr/title/add", { method: "POST", body }, t("adminArr.add.failed"));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAdded(true);
    onDone(res.data.arrId);
  }

  if (loadError) {
    return (
      <p role="alert" className="m-0 flex items-center gap-2 py-8 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> {loadError}
      </p>
    );
  }
  if (!choices) {
    return <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>;
  }
  if (added) {
    return (
      <p className="m-0 flex items-center gap-2 py-8 text-sm text-green-400">
        <Check className="h-4 w-4 shrink-0" /> {t("adminArr.add.done", { name: instanceLabel })}
      </p>
    );
  }
  if (choices.presentArrId !== null) {
    return <p className="m-0 py-8 text-sm text-zinc-400">{t("adminArr.add.present", { name: instanceLabel })}</p>;
  }

  const field = "grid gap-1.5 sm:grid-cols-[160px_1fr] sm:items-center";
  return (
    <div className="grid gap-4">
      {choices.preview && (
        <p className="m-0 text-sm text-zinc-300">
          {choices.preview.title}{choices.preview.year ? ` (${choices.preview.year})` : ""}
        </p>
      )}
      <div className={field}>
        <span className="text-sm text-zinc-300">{t("adminArr.settings.qualityProfile")}</span>
        <StyledSelect compact value={profile === null ? "" : String(profile)} onChange={(e) => setProfile(Number(e.target.value))} aria-label={t("adminArr.settings.qualityProfile")} className="sm:max-w-sm">
          {choices.qualityProfiles.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </StyledSelect>
      </div>
      <div className={field}>
        <span className="text-sm text-zinc-300">{t("adminArr.settings.rootFolder")}</span>
        <StyledSelect compact value={root} onChange={(e) => setRoot(e.target.value)} aria-label={t("adminArr.settings.rootFolder")} className="sm:max-w-md">
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
            <Switch checked={monitored} onCheckedChange={setMonitored} aria-label={t("adminArr.settings.monitored")} />
          </div>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.minimumAvailability")}</span>
            <StyledSelect compact value={availability} onChange={(e) => setAvailability(e.target.value)} aria-label={t("adminArr.settings.minimumAvailability")} className="sm:max-w-sm">
              {AVAILABILITY.map((a) => <option key={a} value={a}>{t(AVAILABILITY_LABEL[a])}</option>)}
            </StyledSelect>
          </div>
        </>
      ) : (
        <>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.add.monitorLabel")}</span>
            <StyledSelect compact value={monitor} onChange={(e) => setMonitor(e.target.value as SonarrAddMonitor)} aria-label={t("adminArr.add.monitorLabel")} className="sm:max-w-sm">
              {SONARR_ADD_MONITOR.map((m) => <option key={m} value={m}>{t(MONITOR_LABEL[m])}</option>)}
            </StyledSelect>
          </div>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.seriesType")}</span>
            <StyledSelect compact value={seriesType} onChange={(e) => setSeriesType(e.target.value)} aria-label={t("adminArr.settings.seriesType")} className="sm:max-w-sm">
              {SERIES_TYPES.map((s) => <option key={s} value={s}>{t(SERIES_TYPE_LABEL[s])}</option>)}
            </StyledSelect>
          </div>
          <div className={field}>
            <span className="text-sm text-zinc-300">{t("adminArr.settings.seasonFolder")}</span>
            <Switch checked={seasonFolder} onCheckedChange={setSeasonFolder} aria-label={t("adminArr.settings.seasonFolder")} />
          </div>
        </>
      )}
      {choices.tags.length > 0 && (
        <div className={field}>
          <span className="text-sm text-zinc-300">{t("adminArr.settings.tags")}</span>
          <div className="flex flex-wrap gap-1.5">
            {choices.tags.map((tag) => {
              const on = tags.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTags(on ? tags.filter((x) => x !== tag.id) : [...tags, tag.id])}
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
        </div>
      )}
      <label className={`flex items-start gap-2 text-sm ${searchNoop ? "text-zinc-500" : "text-zinc-300"}`}>
        <input
          type="checkbox"
          checked={search && !searchNoop}
          disabled={searchNoop}
          onChange={(e) => setSearch(e.target.checked)}
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
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void submit()} disabled={busy || profile === null || !root}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />} {t("adminArr.add.submit", { name: instanceLabel })}
        </Button>
      </div>
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
  const [addedArrId, setAddedArrId] = useState<number | null>(null);
  const label = t("adminArr.add.button", { name: instanceLabel });
  if (addedArrId !== null && !open) {
    return <ManageTitleButton service={service} instance={instance} target={{ arrId: addedArrId }} instanceLabel={instanceLabel} />;
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
                <AddForm service={service} instance={instance} tmdbId={tmdbId} instanceLabel={instanceLabel} onDone={(arrId) => { if (arrId > 0) setAddedArrId(arrId); }} />
              </DialogContent>
            </DialogPopup>
          </DialogPortal>
        </Dialog>
      )}
    </>
  );
}
