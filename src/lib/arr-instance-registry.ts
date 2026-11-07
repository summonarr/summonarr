// Server-side registry of configured Radarr/Sonarr instances (multi-instance
// support). The connection config for each instance lives in Setting rows keyed
// by arrSettingKey (radarr<Slug>Url, …); THIS module holds the instance *list* +
// per-instance routing/access/display metadata, persisted as a JSON array in the
// Setting `arrRadarrInstances` / `arrSonarrInstances`.
//
// The default ("") and legacy 4K ("4k") instances are synthesized so existing
// deployments — which have radarr4kUrl set but no registry Setting yet — keep
// working with zero config change. Named instances (anime, …) are added via the
// admin settings UI (/api/admin/arr-instances), which writes the registry JSON
// built by buildArrInstanceRegistryWrite inside its own transaction.
//
// Impure (reads Setting) — the pure key derivation + routing predicate live in
// arr-instances.ts and are re-used here.

import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { warnOnChange, forgetWarnOnChange } from "./log-dedup";
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

// Serializes saves of one service's registry (the admin arr-instances POST).
// A transaction-scoped advisory lock rather than a row lock because the row may
// not exist yet: two first-ever saves would otherwise both read "no instances"
// and the second would overwrite the first's entry, orphaning its Setting rows.
// Literal ids — pg_advisory_xact_lock has no (int, bigint) overload, so a bound
// parameter would not resolve. The media registry uses 2101/3 and 2101/4.
const REGISTRY_SAVE_LOCK: Record<ArrService, Prisma.Sql> = {
  radarr: Prisma.sql`SELECT pg_advisory_xact_lock(2101, 1)`,
  sonarr: Prisma.sql`SELECT pg_advisory_xact_lock(2101, 2)`,
};

// The interactive-tx client of the EXTENDED prisma (the generated
// Prisma.TransactionClient is not assignable to it — see account-lifecycle.ts).
type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
type RegistryTx = Pick<TxClient, "$executeRaw" | "setting">;

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
    // Trimmed + bounded on READ too: rows written before the write-side cap can
    // carry an untrimmed or oversized name, and this label lands on buttons and chips.
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 100) : slug,
    restricted: o.restricted === true,
    serverAll: o.serverAll === true,
    skipLibraryCheck: o.skipLibraryCheck === true,
    autoRoute,
  };
}

function parseRegistryValue(service: ArrService, value: string | null | undefined): ArrInstanceConfig[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      // Warn rather than silently coerce: an empty list here invisibly disables
      // every named instance (webhook secret discrimination 401s, auto-routing
      // stops, sync fan-out skips) with nothing in the logs to explain it.
      console.warn(`[arr] instance registry ${REGISTRY_KEY[service]} is corrupted (not a JSON array); treating as no named instances`);
      return [];
    }
    const out: ArrInstanceConfig[] = [];
    const seen = new Set<string>([DEFAULT_ARR_INSTANCE]);
    const dropped: string[] = [];
    for (const entry of parsed) {
      const norm = normalizeEntry(entry);
      if (norm && !seen.has(norm.slug)) {
        out.push(norm);
        seen.add(norm.slug);
      } else if (!norm) {
        const slug = entry && typeof entry === "object" ? (entry as { slug?: unknown }).slug : undefined;
        // A NAMED-looking slug the current rules refuse (e.g. "external", whose
        // Url key is the default instance's ExternalUrl). It stops working
        // silently otherwise; once per change, not per read (guardrail 7b).
        if (typeof slug === "string" && slug !== DEFAULT_ARR_INSTANCE && slug !== FOURK_ARR_INSTANCE) dropped.push(slug);
      }
    }
    const warnKey = `arr-registry-dropped:${service}`;
    if (dropped.length > 0) {
      const list = dropped.map((d) => JSON.stringify(d.slice(0, 40))).join(", ");
      warnOnChange(warnKey, list, `[arr] instance registry ${REGISTRY_KEY[service]} has entries with an invalid or reserved slug (${list}); they are ignored — remove them and re-add the instance under another slug`);
    } else {
      forgetWarnOnChange(warnKey);
    }
    return out;
  } catch {
    console.warn(`[arr] instance registry ${REGISTRY_KEY[service]} is corrupted (unparseable JSON); treating as no named instances`);
    return [];
  }
}

async function readRegistryJson(service: ArrService): Promise<ArrInstanceConfig[]> {
  const row = await prisma.setting.findUnique({ where: { key: REGISTRY_KEY[service] } });
  return parseRegistryValue(service, row?.value);
}

// The registry as a SAVE must see it: inside the caller's transaction, after
// the per-service save lock, so the diff a save computes ("which named slugs did
// this list drop") is against the list no other save can change before this
// one commits. Read before the lock, a save that landed in between (an instance
// added in another tab) was overwritten without ever being "removed", so its
// Setting rows — the encrypted API key included — were never cleaned up.
// Named entries only (the built-ins are synthesized, never stored).
export async function readArrInstanceRegistryForSave(tx: RegistryTx, service: ArrService): Promise<ArrInstanceConfig[]> {
  await tx.$executeRaw(REGISTRY_SAVE_LOCK[service]);
  const row = await tx.setting.findUnique({ where: { key: REGISTRY_KEY[service] } });
  return parseRegistryValue(service, row?.value);
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

// The Setting row a registry save writes: validated, de-duped, serialized.
// The default ("") is never stored (it's synthesized).
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
