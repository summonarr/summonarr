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
  DEFAULT_ARR_INSTANCE,
  FOURK_ARR_INSTANCE,
  arrSettingKey,
  isValidInstanceSlug,
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
  // The default ("") and legacy 4K ("4k") instances are synthesized separately and
  // must never come from the registry: a registry "4k" entry would shadow the
  // synthesized legacyFourKConfig() (flipping skipLibraryCheck, making it autoRoute-
  // eligible). Access is still governed by the 4K permission bits regardless, so this
  // is a robustness gate, not a security one.
  if (slug === DEFAULT_ARR_INSTANCE || slug === FOURK_ARR_INSTANCE || !isValidInstanceSlug(slug)) return null;
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
    if (!Array.isArray(parsed)) {
      // Warn rather than silently coerce: an empty list here invisibly disables
      // every named instance (webhook secret discrimination 401s, auto-routing
      // stops, sync fan-out skips) with nothing in the logs to explain it.
      console.warn(`[arr] instance registry ${REGISTRY_KEY[service]} is corrupted (not a JSON array); treating as no named instances`);
      return [];
    }
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
    console.warn(`[arr] instance registry ${REGISTRY_KEY[service]} is corrupted (unparseable JSON); treating as no named instances`);
    return [];
  }
}

// The slugs (of `slugs`) whose connection is configured — url + apiKey BOTH
// non-empty — read with ONE Setting query over every slug's two keys. Every
// configured-ness probe in this module funnels through here so the per-request
// cost is a fixed two round-trips (registry + this), not 2 + N: the old shape
// issued one findMany per instance and re-probed the 4K keys on every call.
async function readConfiguredSlugs(service: ArrService, slugs: readonly string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const keys = slugs.flatMap((slug) => [arrSettingKey(service, slug, "Url"), arrSettingKey(service, slug, "ApiKey")]);
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = new Set<string>();
  for (const slug of slugs) {
    // Presence of the row is not enough — a blanked value is "unconfigured".
    if (map.get(arrSettingKey(service, slug, "Url")) && map.get(arrSettingKey(service, slug, "ApiKey"))) out.add(slug);
  }
  return out;
}

// Whether an instance's connection is configured (url + apiKey both present).
export async function isInstanceConfigured(service: ArrService, slug: string): Promise<boolean> {
  return (await readConfiguredSlugs(service, [slug])).has(slug);
}

// The registry list + which of its instances are configured, in exactly two
// queries: the registry row, then one findMany over the default, legacy 4K and
// every registry slug's connection keys. The 4K probe rides on the same query —
// normalizeEntry rejects a registry "4k" entry, so it is never registry-backed
// and always has to be probed.
//
// Exported for a caller that needs BOTH views of one read — the request route
// resolves an explicit slug against the FULL list (an unregistered slug and a
// registered-but-unconfigured one are different 400s) and auto-routes over the
// configured subset; calling getArrInstances + getSyncableArrInstances +
// isInstanceConfigured for that paid the registry read twice and probed the
// chosen slug a third time.
export async function getArrInstancesWithConfigured(
  service: ArrService,
): Promise<{ all: ArrInstanceConfig[]; configured: ReadonlySet<string> }> {
  const registry = await readRegistryJson(service);
  const configured = await readConfiguredSlugs(service, [
    DEFAULT_ARR_INSTANCE,
    FOURK_ARR_INSTANCE,
    ...registry.map((i) => i.slug),
  ]);
  const all: ArrInstanceConfig[] = [defaultInstanceConfig()];
  if (configured.has(FOURK_ARR_INSTANCE)) all.push(legacyFourKConfig());
  all.push(...registry);
  return { all, configured };
}

// All registered instances for a service, default first, then registry entries in
// admin order. The legacy 4K instance is synthesized (after the default) when it's
// configured but absent from the registry JSON — the back-compat path for installs
// that had a 4K instance before the registry existed.
export async function getArrInstances(service: ArrService): Promise<ArrInstanceConfig[]> {
  return (await getArrInstancesWithConfigured(service)).all;
}

// Only the instances whose connection is actually configured — the set the sync
// orchestrator fans out over. Always includes the default if configured.
export async function getSyncableArrInstances(service: ArrService): Promise<ArrInstanceConfig[]> {
  const { all, configured } = await getArrInstancesWithConfigured(service);
  return all.filter((i) => configured.has(i.slug));
}

// Persist the named-instance registry (admin settings). Validates and de-dupes;
// the default ("") is never stored (it's synthesized). Callers must separately
// write the per-instance connection Setting rows via arrSettingKey.
// The Setting row a registry save writes: validated, de-duped, serialized.
//
// PURE, and exported, so a caller that must write the registry INSIDE its own
// transaction (the admin arr-instances route, whose registry save and removal
// cleanup have to commit together) can hand the row to its own tx client without
// re-implementing — or drifting from — this normalization. Mirrors
// buildMediaInstanceRegistryWrite.
export function buildArrInstanceRegistryWrite(
  service: ArrService,
  entries: ArrInstanceConfig[],
): { key: string; value: string } {
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
  return { key: REGISTRY_KEY[service], value: JSON.stringify(clean) };
}

export async function saveArrInstances(service: ArrService, entries: ArrInstanceConfig[]): Promise<void> {
  const { key, value } = buildArrInstanceRegistryWrite(service, entries);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}
