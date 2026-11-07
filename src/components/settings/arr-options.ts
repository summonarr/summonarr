// Shared by the default/4K Radarr/Sonarr forms (forms/arr-form.tsx) and the
// named-instance manager (arr-instances-manager.tsx), which used to keep their
// own copies.

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
