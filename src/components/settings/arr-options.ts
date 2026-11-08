// Shared by the default/4K Radarr/Sonarr forms (forms/arr-form.tsx) and the
// named-instance manager (arr-instances-manager.tsx), which used to keep their
// own copies.
import { check, v } from "@/lib/validate";

// Root folders + quality profiles read live from a configured instance (the
// shape /api/settings/arr-options returns), so they show as dropdowns instead
// of fields where you type an id. languageProfiles only appears for Sonarr v3
// (Sonarr v4 removed language profiles); it is missing for Radarr.
export interface ArrOptions {
  rootFolders: { path: string }[];
  qualityProfiles: { id: number; name: string }[];
  languageProfiles?: { id: number; name: string }[];
}

// Radarr's closed enum for when a movie counts as "available" to search for.
// The settings route accepts exactly these values.
export const MINIMUM_AVAILABILITY_OPTIONS = [
  { value: "announced", labelKey: "settings.arr.minAvail.announced" },
  { value: "inCinemas", labelKey: "settings.arr.minAvail.inCinemas" },
  { value: "released", labelKey: "settings.arr.minAvail.released" },
] as const;

const ArrOptionsSchema = v.object({
  rootFolders: v.array(v.object({ path: v.string() })),
  qualityProfiles: v.array(v.object({ id: v.number(), name: v.string() })),
  languageProfiles: v.optional(v.array(v.object({ id: v.number(), name: v.string() }))),
});

/** The arr-options answer, or null when it isn't one (then the form shows "couldn't load"). */
export function readArrOptions(data: unknown): ArrOptions | null {
  const r = check(ArrOptionsSchema, data);
  return r.ok ? r.value : null;
}

/**
 * The Setting keys one default/4K form edits (forms/arr-form.tsx). When the
 * connection test fails, /api/settings replies 422 with the reason under
 * `error` here (e.g. `radarrError`, `sonarr4kError`), not the usual `error`.
 */
export function arrFormKeys(service: "radarr" | "sonarr", variant: "hd" | "4k") {
  const p = `${service}${variant === "4k" ? "4k" : ""}`;
  return {
    idPrefix: p,
    url: `${p}Url`,
    externalUrl: `${p}ExternalUrl`,
    apiKey: `${p}ApiKey`,
    rootFolder: `${p}RootFolder`,
    qualityProfileId: `${p}QualityProfileId`,
    minimumAvailability: `${p}MinimumAvailability`,
    languageProfileId: `${p}LanguageProfileId`,
    version: `${p}Version`,
    error: `${p}Error`,
  };
}

export type ArrFormKeys = ReturnType<typeof arrFormKeys>;
