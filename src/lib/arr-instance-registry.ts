// Server-side registry of configured Radarr/Sonarr instances (multi-instance
// support). The connection config for each instance lives in Setting rows keyed
// by arrSettingKey (radarr<Slug>Url, …); THIS module holds the instance *list* +
// per-instance routing/access/display metadata, persisted as a JSON array in the
// Setting `arrRadarrInstances` / `arrSonarrInstances`.
//
// The default ("") and legacy 4K ("4k") instances are synthesized so existing
// deployments — which have radarr4kUrl set but no registry Setting yet — keep
// working with zero config change. Named instances (anime, …) are added via the
// admin settings UI, which writes the registry JSON through saveArrInstances().
//
// Impure (reads Setting) — the pure key derivation + routing predicate live in
// arr-instances.ts and are re-used here.

import { prisma } from "./prisma";
import {
  type ArrInstanceConfig,
  type ArrService,
  type ArrAutoRoute,
  type RoutableMedia,
  DEFAULT_ARR_INSTANCE,
  FOURK_ARR_INSTANCE,
  arrSettingKey,
  isValidInstanceSlug,
  routeMediaToSlug,
} from "./arr-instances";

const REGISTRY_KEY: Record<ArrService, string> = {
  radarr: "arrRadarrInstances",
  sonarr: "arrSonarrInstances",
};

// The synthesized default instance — always present, open to any requester,
// honors the shared-library availability check, never auto-routed.
function defaultInstanceConfig(): ArrInstanceConfig {
  return {
    slug: DEFAULT_ARR_INSTANCE,
    name: "Default",
    restricted: false,
    serverAll: false,
    skipLibraryCheck: false,
    autoRoute: null,
  };
}

// The synthesized legacy 4K instance. `restricted` is informational — 4K access
// is decided by the REQUEST_4K*/AUTO_APPROVE_4K* permission bits (see
// canRequestInstance), not the registry — but skipLibraryCheck=true preserves the
// legacy behavior where a 4K request is NOT suppressed by a shared-library hit.
function legacyFourKConfig(): ArrInstanceConfig {
  return {
    slug: FOURK_ARR_INSTANCE,
    name: "4K",
    restricted: true,
    serverAll: false,
    skipLibraryCheck: true,
    autoRoute: null,
  };
}

// Coerce one untrusted registry entry into a well-formed ArrInstanceConfig, or
// null to drop it. Defensive against a hand-edited / older-shape JSON blob.
function normalizeEntry(raw: unknown): ArrInstanceConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const slug = typeof o.slug === "string" ? o.slug : "";
  // The default is synthesized separately and must never come from the registry.
  if (slug === DEFAULT_ARR_INSTANCE || !isValidInstanceSlug(slug)) return null;
  let autoRoute: ArrAutoRoute | null = null;
  if (o.autoRoute && typeof o.autoRoute === "object") {
    const r = o.autoRoute as Record<string, unknown>;
    autoRoute = {
      animeOnly: r.animeOnly === true,
      genreIds: Array.isArray(r.genreIds) ? r.genreIds.filter((g): g is number => typeof g === "number") : undefined,
      originalLanguages: Array.isArray(r.originalLanguages)
        ? r.originalLanguages.filter((l): l is string => typeof l === "string")
        : undefined,
    };
  }
  return {
    slug,
    name: typeof o.name === "string" && o.name.trim() ? o.name : slug,
    restricted: o.restricted === true,
    serverAll: o.serverAll === true,
    skipLibraryCheck: o.skipLibraryCheck === true,
    autoRoute,
  };
}

async function readRegistryJson(service: ArrService): Promise<ArrInstanceConfig[]> {
  const row = await prisma.setting.findUnique({ where: { key: REGISTRY_KEY[service] } });
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    const out: ArrInstanceConfig[] = [];
    const seen = new Set<string>([DEFAULT_ARR_INSTANCE]);
    for (const entry of parsed) {
      const norm = normalizeEntry(entry);
      if (norm && !seen.has(norm.slug)) {
        out.push(norm);
        seen.add(norm.slug);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Whether an instance's connection is configured (url + apiKey both present).
export async function isInstanceConfigured(service: ArrService, slug: string): Promise<boolean> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [arrSettingKey(service, slug, "Url"), arrSettingKey(service, slug, "ApiKey")] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return !!map[arrSettingKey(service, slug, "Url")] && !!map[arrSettingKey(service, slug, "ApiKey")];
}

// All registered instances for a service, default first, then registry entries in
// admin order. The legacy 4K instance is synthesized (after the default) when it's
// configured but absent from the registry JSON — the back-compat path for installs
// that had a 4K instance before the registry existed.
export async function getArrInstances(service: ArrService): Promise<ArrInstanceConfig[]> {
  const registry = await readRegistryJson(service);
  const out: ArrInstanceConfig[] = [defaultInstanceConfig()];
  const seen = new Set<string>([DEFAULT_ARR_INSTANCE]);
  for (const entry of registry) {
    out.push(entry);
    seen.add(entry.slug);
  }
  if (!seen.has(FOURK_ARR_INSTANCE) && (await isInstanceConfigured(service, FOURK_ARR_INSTANCE))) {
    out.splice(1, 0, legacyFourKConfig());
  }
  return out;
}

export async function getArrInstance(service: ArrService, slug: string): Promise<ArrInstanceConfig | undefined> {
  return (await getArrInstances(service)).find((i) => i.slug === slug);
}

// Only the instances whose connection is actually configured — the set the sync
// orchestrator fans out over. Always includes the default if configured.
export async function getSyncableArrInstances(service: ArrService): Promise<ArrInstanceConfig[]> {
  const all = await getArrInstances(service);
  const results = await Promise.all(all.map((i) => isInstanceConfigured(service, i.slug)));
  return all.filter((_, idx) => results[idx]);
}

// First-match-wins auto-routing for a request. Returns the slug the request should
// target given its TMDB metadata; falls back to the default instance ("").
export async function routeArrInstanceForMedia(service: ArrService, media: RoutableMedia): Promise<string> {
  const instances = await getArrInstances(service);
  return routeMediaToSlug(instances, media);
}

// Persist the named-instance registry (admin settings). Validates and de-dupes;
// the default ("") is never stored (it's synthesized). Callers must separately
// write the per-instance connection Setting rows via arrSettingKey.
export async function saveArrInstances(service: ArrService, entries: ArrInstanceConfig[]): Promise<void> {
  const seen = new Set<string>([DEFAULT_ARR_INSTANCE]);
  const clean: ArrInstanceConfig[] = [];
  for (const e of entries) {
    if (!e || typeof e.slug !== "string") continue;
    if (e.slug === DEFAULT_ARR_INSTANCE || !isValidInstanceSlug(e.slug) || seen.has(e.slug)) continue;
    const norm = normalizeEntry(e);
    if (norm) {
      clean.push(norm);
      seen.add(norm.slug);
    }
  }
  await prisma.setting.upsert({
    where: { key: REGISTRY_KEY[service] },
    create: { key: REGISTRY_KEY[service], value: JSON.stringify(clean) },
    update: { value: JSON.stringify(clean) },
  });
}
