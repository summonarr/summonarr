// What an admin's own "Add to Radarr/Sonarr" may ask for — pure, no imports
// beyond types. Every value is checked against a fixed vocabulary here and
// against the instance's own profiles, root folders and tags in the data layer
// (guardrail 5e: a browser value only ever NAMES something the instance has).

import type { ArrService } from "./arr-instances";
import { MINIMUM_AVAILABILITIES, SERIES_TYPES, type MinimumAvailability, type SeriesType } from "./arr-title";

/**
 * Sonarr's own add-time monitoring choices, the subset both v3 and v4 accept.
 * `latestSeason` is v3's name; v4 keeps it as an alias of `lastSeason`, so it
 * works on both (v4's recent/specials options are left out on purpose).
 */
export const SONARR_ADD_MONITOR = ["all", "future", "missing", "existing", "pilot", "firstSeason", "latestSeason", "none"] as const;
export type SonarrAddMonitor = (typeof SONARR_ADD_MONITOR)[number];

export interface TitleAdd {
  tmdbId: number;
  qualityProfileId: number;
  rootFolderPath: string;
  tags: number[];
  /** Search for it right after adding (Radarr searchForMovie / Sonarr searchForMissingEpisodes). */
  search: boolean;
  // Radarr.
  monitored?: boolean;
  minimumAvailability?: MinimumAvailability;
  // Sonarr.
  monitor?: SonarrAddMonitor;
  seriesType?: SeriesType;
  seasonFolder?: boolean;
}

const MAX_TAGS = 100;
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** The add a request body asks for, or null when anything in it is malformed or belongs to the other service. */
export function parseTitleAdd(service: ArrService, body: Record<string, unknown>): TitleAdd | null {
  const tmdbId = posInt(body.tmdbId);
  const qualityProfileId = posInt(body.qualityProfileId);
  const root = body.rootFolderPath;
  if (tmdbId === null || qualityProfileId === null) return null;
  if (typeof root !== "string" || root.trim() === "" || root.length > 1_000) return null;
  if (typeof body.search !== "boolean") return null;
  const tags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every((t) => posInt(t) !== null)) return null;
  const add: TitleAdd = { tmdbId, qualityProfileId, rootFolderPath: root, tags: [...new Set(tags as number[])], search: body.search };
  const has = (k: string) => body[k] !== undefined;
  if (service === "radarr") {
    if (["monitor", "seriesType", "seasonFolder"].some(has)) return null;
    if (typeof body.monitored !== "boolean") return null;
    add.monitored = body.monitored;
    if (has("minimumAvailability")) {
      if (!isOneOf(MINIMUM_AVAILABILITIES, body.minimumAvailability)) return null;
      add.minimumAvailability = body.minimumAvailability;
    }
    return add;
  }
  if (["monitored", "minimumAvailability"].some(has)) return null;
  if (!isOneOf(SONARR_ADD_MONITOR, body.monitor)) return null;
  add.monitor = body.monitor;
  if (has("seriesType")) {
    if (!isOneOf(SERIES_TYPES, body.seriesType)) return null;
    add.seriesType = body.seriesType;
  }
  if (has("seasonFolder")) {
    if (typeof body.seasonFolder !== "boolean") return null;
    add.seasonFolder = body.seasonFolder;
  }
  return add;
}
