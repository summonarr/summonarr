// An instance's Radarr/Sonarr connection and add defaults, read from Setting
// rows (guardrail 32: the variant is an instance slug), the quality-profile
// picker, and the connection test. Re-exported by arr.ts.
import { prisma } from "./prisma";
import { arrSettingKey, isRadarrMinimumAvailability, type ArrInstanceKey, type ArrService, type RadarrMinimumAvailability } from "./arr-instances";
import { arrFetch, type ArrCfg } from "./arr-client";
import { check, v } from "./validate";

export type ArrCfgFull = ArrCfg & {
  rootFolder?: string;
  qualityProfileId?: number;
  // Radarr only — when the movie counts as "available" to search. Absent means
  // "don't send the field", preserving whatever Radarr defaults to.
  minimumAvailability?: RadarrMinimumAvailability;
  // Sonarr v3 only — v4 removed language profiles. Absent means "don't send".
  languageProfileId?: number;
};

// An instance slug: "" (the default), "4k", or any named instance from the
// registry (arr-instance-registry.ts). Functions that target a specific instance
// take an optional `variant` defaulting to "" (the default instance). ArrVariant
// is retained as an alias of ArrInstanceKey for call sites still typed on it, and
// getCfg accepts the legacy "hd" spelling (mapped to the default "") so existing
// `is4k ? "4k" : "hd"` callers keep resolving the same Setting keys.
export type ArrVariant = ArrInstanceKey;

// Human label for an error message: "Radarr" for the default/"hd", "Radarr (4k)"
// for any named instance.
export function instanceLabel(service: string, variant: ArrVariant): string {
  return variant && variant !== "hd" ? `${service} (${variant})` : service;
}

export async function getArrCfg(service: ArrService, variant: ArrVariant = ""): Promise<ArrCfg | null> {
  const cfg = await getCfg(service, variant);
  if (!cfg) return null;
  return { url: cfg.url, apiKey: cfg.apiKey };
}

/**
 * An instance's configured add defaults — what a request's add uses — for the
 * admin's own Add form to preselect. null when the instance isn't configured.
 */
export async function getArrAddDefaults(service: ArrService, variant: ArrVariant = ""): Promise<{
  rootFolder: string | null;
  qualityProfileId: number | null;
  minimumAvailability: string | null;
  languageProfileId: number | null;
} | null> {
  const cfg = await getCfg(service, variant);
  if (!cfg) return null;
  return {
    rootFolder: cfg.rootFolder ?? null,
    qualityProfileId: cfg.qualityProfileId ?? null,
    minimumAvailability: cfg.minimumAvailability ?? null,
    languageProfileId: cfg.languageProfileId ?? null,
  };
}

/** The instance's config, or a "<Service> is not configured" Error for a helper that can't run without it. */
export async function requireArrCfg(service: ArrService, variant: ArrVariant = ""): Promise<ArrCfgFull> {
  const cfg = await getCfg(service, variant);
  if (!cfg) throw new Error(`${service === "radarr" ? "Radarr" : "Sonarr"} is not configured`);
  return cfg;
}

// Whether a given instance is configured (only the default one is expected to be).
export async function isArrConfigured(service: ArrService, variant: ArrVariant = ""): Promise<boolean> {
  return (await getCfg(service, variant)) !== null;
}

// A stored id that is not a positive integer reads as "unset" (nothing validates
// these Settings on the write side).
function storedPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function getCfg(service: ArrService, variant: ArrVariant = ""): Promise<ArrCfgFull | null> {
  // Key derivation is centralized in arr-instances.ts (the single place that
  // knows how an instance maps to Setting keys). `variant` is an instance slug;
  // the legacy "hd" spelling maps to the default instance ("").
  const instance    = variant === "hd" ? "" : variant;
  const urlKey      = arrSettingKey(service, instance, "Url");
  const keyKey      = arrSettingKey(service, instance, "ApiKey");
  const folderKey   = arrSettingKey(service, instance, "RootFolder");
  const profileKey  = arrSettingKey(service, instance, "QualityProfileId");
  // Service-specific optional fields — the derived key for the "wrong" service
  // simply never has a Setting row, so reading both keeps this fn uniform.
  const minAvailKey = arrSettingKey(service, instance, "MinimumAvailability");
  const langKey     = arrSettingKey(service, instance, "LanguageProfileId");
  const rows = await prisma.setting.findMany({
    where: { key: { in: [urlKey, keyKey, folderKey, profileKey, minAvailKey, langKey] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!map[urlKey] || !map[keyKey]) return null;
  return {
    url: map[urlKey].replace(/\/$/, ""),
    apiKey: map[keyKey],
    // A stored EMPTY string is the instance manager's documented "— use the
    // server's default —" choice (its select ships `<option value="">`), written
    // verbatim as a Setting row. `""` is falsy — so the add fetches the fallback
    // list — but it SURVIVES `??`, so `cfg.rootFolder ?? fallback` would yield
    // `""` and the add would POST `"rootFolderPath": ""`, which Radarr/Sonarr
    // reject with a 400. Normalise to undefined so `??` behaves as the add
    // assumes.
    rootFolder: map[folderKey] || undefined,
    // Same hazard one type down: a non-numeric value must read as "unset", not
    // NaN (NaN survives `??` and the add would POST `"qualityProfileId": null`).
    qualityProfileId: storedPositiveInt(map[profileKey]),
    // An unexpected stored value must read as "unset", never ship in a POST body.
    minimumAvailability:
      map[minAvailKey] && isRadarrMinimumAvailability(map[minAvailKey]) ? map[minAvailKey] : undefined,
    languageProfileId: storedPositiveInt(map[langKey]),
  };
}

export const MAX_QUALITY_PROFILES = 200;
const PROFILE_SCAN_FACTOR = 4;

// Quality profiles for one instance variant, plus the configured default id so a
// picker can mark/pre-select it. Returns null when that instance isn't configured.
// Permission-agnostic — callers gate access (e.g. MANAGE_REQUESTS for the approve
// picker, ADMIN for settings).
export async function listQualityProfiles(
  service: ArrService,
  variant: ArrVariant = "",
): Promise<{ profiles: { id: number; name: string }[]; defaultId: number | null } | null> {
  const cfg = await getCfg(service, variant);
  if (!cfg) return null;
  // Projected, not forwarded: the whole QualityProfileResource (items, cutoff,
  // format scores, language, …) otherwise reaches ordinary requesters through
  // /api/requests/quality-profiles. Bounded like every projection over an
  // upstream list (guardrail 5i).
  const raw = await arrFetch<unknown>(cfg, "/api/v3/qualityprofile");
  const profiles: { id: number; name: string }[] = [];
  const list = Array.isArray(raw) ? (raw as Array<{ id?: unknown; name?: unknown } | null>) : [];
  for (let i = 0; i < list.length && i < MAX_QUALITY_PROFILES * PROFILE_SCAN_FACTOR && profiles.length < MAX_QUALITY_PROFILES; i++) {
    const p = list[i];
    if (!p || typeof p !== "object" || typeof p.id !== "number" || !Number.isSafeInteger(p.id)) continue;
    profiles.push({ id: p.id, name: typeof p.name === "string" ? p.name : String(p.id) });
  }
  return { profiles, defaultId: cfg.qualityProfileId ?? null };
}

const SystemStatus = v.object({ version: v.string(), appName: v.optional(v.nullable(v.string())) });

/**
 * The version the URL's /system/status reports, after checking the service is
 * the one asked for. A Sonarr URL pasted into the Radarr field used to pass
 * (both answer with a version) and persist a cross-wired config. A missing
 * appName (older builds) is tolerated; a PRESENT mismatched one fails so the
 * save rolls back, and so does an answer that names no version at all.
 */
async function testArrConnection(label: "Radarr" | "Sonarr", url: string, apiKey: string): Promise<string> {
  const cfg = { url: url.replace(/\/$/, ""), apiKey };
  const status = check(SystemStatus, await arrFetch<unknown>(cfg, "/api/v3/system/status"));
  if (!status.ok) throw new Error(`URL did not answer like ${label}`);
  const { version, appName } = status.value;
  if (appName && appName.toLowerCase() !== label.toLowerCase()) {
    throw new Error(`URL points at ${appName}, not ${label}`);
  }
  return version;
}

export function testRadarrConnection(url: string, apiKey: string): Promise<string> {
  return testArrConnection("Radarr", url, apiKey);
}

export function testSonarrConnection(url: string, apiKey: string): Promise<string> {
  return testArrConnection("Sonarr", url, apiKey);
}
