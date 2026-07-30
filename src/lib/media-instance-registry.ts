// Server-side registry of configured Plex/Jellyfin instances (multi-server
// support). The connection config for each instance lives in Setting rows
// keyed by plexSettingKey/jellyfinSettingKey (plex<Slug>ServerUrl, …); THIS
// module holds the instance *list*, persisted as a JSON array in the Setting
// `plexInstances` / `jellyfinInstances`.
//
// The default ("") instance is always synthesized so every existing
// deployment — which has plexServerUrl/jellyfinUrl set but no registry Setting
// yet — keeps working with zero config change. Named instances are added via
// the admin settings UI, which writes the registry JSON through
// saveMediaInstances().
//
// Registry entries are deliberately thin ({ slug, name } only) compared to
// arr-instance-registry.ts's ArrInstanceConfig: nothing routes a request to a
// specific Plex/Jellyfin server (availability is a union across all configured
// servers of a type), so there's no restricted/serverAll/autoRoute metadata to
// carry here. Per-user server-visibility grants are a later, additive addition
// to this same JSON shape, not a schema change.
//
// Impure (reads Setting) — the pure key derivation lives in media-instances.ts
// and is re-used here.

import { prisma } from "./prisma";
import { type MediaInstanceKey, type MediaServerService, DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug, plexSettingKey, jellyfinSettingKey } from "./media-instances";

export interface MediaInstanceConfig {
  slug: MediaInstanceKey;
  name: string;
}

const REGISTRY_KEY: Record<MediaServerService, string> = {
  plex: "plexInstances",
  jellyfin: "jellyfinInstances",
};

function defaultInstanceConfig(): MediaInstanceConfig {
  return { slug: DEFAULT_MEDIA_INSTANCE, name: "Default" };
}

// Coerce one untrusted registry entry into a well-formed MediaInstanceConfig,
// or null to drop it. Defensive against a hand-edited / older-shape JSON blob.
function normalizeEntry(raw: unknown): MediaInstanceConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const slug = typeof o.slug === "string" ? o.slug : "";
  // The default ("") instance is synthesized separately and must never come
  // from the registry — a registry "" entry would shadow defaultInstanceConfig().
  if (slug === DEFAULT_MEDIA_INSTANCE || !isValidMediaInstanceSlug(slug)) return null;
  return {
    slug,
    name: typeof o.name === "string" && o.name.trim() ? o.name : slug,
  };
}

async function readRegistryJson(service: MediaServerService): Promise<MediaInstanceConfig[]> {
  const row = await prisma.setting.findUnique({ where: { key: REGISTRY_KEY[service] } });
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    const out: MediaInstanceConfig[] = [];
    const seen = new Set<string>([DEFAULT_MEDIA_INSTANCE]);
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

// Whether an instance's connection is configured (the service-appropriate
// required fields are both present).
export async function isMediaInstanceConfigured(service: MediaServerService, slug: MediaInstanceKey): Promise<boolean> {
  const [urlKey, authKey] =
    service === "plex"
      ? [plexSettingKey(slug, "ServerUrl"), plexSettingKey(slug, "AdminToken")]
      : [jellyfinSettingKey(slug, "Url"), jellyfinSettingKey(slug, "ApiKey")];
  const rows = await prisma.setting.findMany({ where: { key: { in: [urlKey, authKey] } } });
  // Trimmed presence, not raw truthiness: every consumer trims before use
  // (authorizeWithPlex, plex-membership, the play-history poller), so a
  // whitespace-only value is not a usable config. Reading it as configured
  // showed the instance's sign-in tab and put it in the sync fan-out while
  // every actual connection refused.
  const map = new Map(rows.map((r) => [r.key, r.value.trim()]));
  return !!map.get(urlKey) && !!map.get(authKey);
}

// All registered instances for a service, default first, then registry
// entries in admin order.
export async function getMediaInstances(service: MediaServerService): Promise<MediaInstanceConfig[]> {
  const registry = await readRegistryJson(service);
  return [defaultInstanceConfig(), ...registry];
}

// Only the instances whose connection is actually configured — the set the
// sync orchestrator fans out over. Always includes the default if configured.
export async function getSyncableMediaInstances(service: MediaServerService): Promise<MediaInstanceConfig[]> {
  const all = await getMediaInstances(service);
  const results = await Promise.all(all.map((i) => isMediaInstanceConfigured(service, i.slug)));
  return all.filter((_, idx) => results[idx]);
}

// The Setting row a registry save writes: validated, de-duped, serialized. The
// default ("") is never stored (it's synthesized in getMediaInstances).
//
// PURE, and exported, so a caller that must write the registry INSIDE its own
// transaction (the admin media-instances route, whose registry save and library
// cleanup have to commit together) can hand the row to its own tx client
// without re-implementing — or drifting from — this normalization.
export function buildMediaInstanceRegistryWrite(
  service: MediaServerService,
  entries: MediaInstanceConfig[],
): { key: string; value: string } {
  const seen = new Set<string>([DEFAULT_MEDIA_INSTANCE]);
  const clean: MediaInstanceConfig[] = [];
  for (const e of entries) {
    if (!e || typeof e.slug !== "string") continue;
    if (e.slug === DEFAULT_MEDIA_INSTANCE || !isValidMediaInstanceSlug(e.slug) || seen.has(e.slug)) continue;
    const norm = normalizeEntry(e);
    if (norm) {
      clean.push(norm);
      seen.add(norm.slug);
    }
  }
  return { key: REGISTRY_KEY[service], value: JSON.stringify(clean) };
}

// Persist the named-instance registry (admin settings). Callers must separately
// write each instance's connection Setting rows via
// plexSettingKey/jellyfinSettingKey — and, when removing an instance, clean up
// its library/session rows too (see the admin media-instances route).
export async function saveMediaInstances(service: MediaServerService, entries: MediaInstanceConfig[]): Promise<void> {
  const { key, value } = buildMediaInstanceRegistryWrite(service, entries);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}
