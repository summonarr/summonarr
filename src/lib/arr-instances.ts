// Radarr/Sonarr instance addressing — the single source of truth for how an
// instance maps to its Setting keys.
//
// Today there are at most two instances per service: the default (HD) and an
// optional 4K instance, whose Settings are namespaced by inserting a "4k"
// segment (radarrUrl → radarr4kUrl). That suffix rule was previously duplicated
// in ~4 places (arr.ts getCfg, /api/settings/arr-options, the settings UI, and
// the webhook secret-key names). Centralizing it here is Phase 1 of generalizing
// to N named instances: widening the instance space later becomes a change to
// THIS module rather than a scavenger hunt across the codebase.
//
// PURE — zero imports (no prisma / server-only) so it's unit-testable and usable
// from client components (the settings UI) as well as server routes.

export type ArrService = "radarr" | "sonarr";

// Instance key: "" is the default (HD) instance; "4k" is the optional second.
// A string (not a boolean) precisely so additional instances can be added here
// without re-typing every caller.
export type ArrInstanceKey = "" | "4k";

export const ARR_INSTANCE_KEYS: readonly ArrInstanceKey[] = ["", "4k"];

export type ArrSettingField = "Url" | "ApiKey" | "RootFolder" | "QualityProfileId";

// e.g. arrSettingKey("radarr", "", "Url") → "radarrUrl"
//      arrSettingKey("radarr", "4k", "Url") → "radarr4kUrl"
export function arrSettingKey(service: ArrService, instance: ArrInstanceKey, field: ArrSettingField): string {
  return `${service}${instance}${field}`;
}

// Bridge from the legacy ArrVariant ("hd" | "4k") to the instance key. Lets the
// existing variant-typed call sites keep working while the key derivation is
// centralized.
export function variantToInstanceKey(variant: "hd" | "4k"): ArrInstanceKey {
  return variant === "4k" ? "4k" : "";
}
