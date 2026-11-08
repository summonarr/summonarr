// The i18n keys for the arr's own add and edit choices, shared by the Add
// dialog and the Settings tab. Literal maps — never a built key (the i18n
// dead-key check can't see one).
import type { MinimumAvailability, MonitorNewItems, SeriesType } from "@/lib/arr-title";
import type { SonarrAddMonitor } from "@/lib/arr-title-add";

export const AVAILABILITY_LABEL: Record<MinimumAvailability, string> = {
  announced: "adminArr.availability.announced",
  inCinemas: "adminArr.availability.inCinemas",
  released: "adminArr.availability.released",
};

export const SERIES_TYPE_LABEL: Record<SeriesType, string> = {
  standard: "adminArr.seriesType.standard",
  daily: "adminArr.seriesType.daily",
  anime: "adminArr.seriesType.anime",
};

export const MONITOR_NEW_LABEL: Record<MonitorNewItems, string> = {
  all: "adminArr.monitorNew.all",
  none: "adminArr.monitorNew.none",
};

export const ADD_MONITOR_LABEL: Record<SonarrAddMonitor, string> = {
  all: "adminArr.add.monitor.all",
  future: "adminArr.add.monitor.future",
  missing: "adminArr.add.monitor.missing",
  existing: "adminArr.add.monitor.existing",
  pilot: "adminArr.add.monitor.pilot",
  firstSeason: "adminArr.add.monitor.firstSeason",
  latestSeason: "adminArr.add.monitor.latestSeason",
  none: "adminArr.add.monitor.none",
};

/** `v` is one of `list` (a value the arr reported may be outside its own vocabulary). */
export const oneOf = <T extends string>(list: readonly T[], v: string | null): v is T => v !== null && (list as readonly string[]).includes(v);
