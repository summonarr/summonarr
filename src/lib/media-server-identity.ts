// Each configured Plex/Jellyfin server's own identity, stored once per library
// sync so the "Watch on …" links (watch-links-data.ts) need no upstream call
// at page render: Plex's machineIdentifier, Jellyfin's server Id.
//
// A failed or unusable read keeps whatever is stored — an identity only changes
// when a server is reinstalled, and a link built on the old one is merely dead.
// Never throws: this rides the sync and must not fail it.
import { prisma } from "./prisma";
import { getPlexMachineId, PLEX_IDENTITY_TIMEOUT_MS } from "./plex";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { jellyfinIdentityHeaders } from "./jellyfin-http";
import { safeFetchAdminConfigured } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { asRecord } from "./media-server-payload";
import { plexSettingKey, jellyfinSettingKey } from "./media-instances";
import { isWatchLinkId } from "./watch-links";
import { settleLimit } from "./concurrency";

const JELLYFIN_IDENTITY_TIMEOUT_MS = 10_000;

/** A Jellyfin server's own Id (`/System/Info/Public`, unauthenticated), or null. */
export async function getJellyfinServerId(baseUrl: string): Promise<string | null> {
  try {
    const res = await safeFetchAdminConfigured(`${trimServerBase(baseUrl)}/System/Info/Public`, {
      headers: jellyfinIdentityHeaders(false),
      timeoutMs: JELLYFIN_IDENTITY_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const id = asRecord(await res.json())?.Id;
    return isWatchLinkId(id) ? id : null;
  } catch {
    return null;
  }
}

async function storeIfChanged(key: string, value: string | null): Promise<void> {
  if (value === null) return;
  const stored = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
  if (stored?.value === value) return;
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function stampPlex(slug: string): Promise<void> {
  const cfg = await getPlexConfig(slug);
  if (!cfg.url || !cfg.token) return;
  const id = await getPlexMachineId(trimServerBase(cfg.url), cfg.token, PLEX_IDENTITY_TIMEOUT_MS);
  await storeIfChanged(plexSettingKey(slug, "MachineId"), isWatchLinkId(id) ? id : null);
}

async function stampJellyfin(slug: string): Promise<void> {
  const cfg = await getJellyfinConfig(slug);
  if (!cfg.url) return;
  await storeIfChanged(jellyfinSettingKey(slug, "ServerId"), await getJellyfinServerId(cfg.url));
}

export async function stampMediaServerIdentities(targets: {
  plexInstances: ReadonlyArray<{ slug: string }>;
  jellyfinInstances: ReadonlyArray<{ slug: string }>;
}): Promise<void> {
  const tasks = [
    ...targets.plexInstances.map((i) => () => stampPlex(i.slug)),
    ...targets.jellyfinInstances.map((i) => () => stampJellyfin(i.slug)),
  ];
  const results = await settleLimit(tasks, 4, (task) => task());
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[sync] media server identity read failed:", result.reason instanceof Error ? result.reason.message : result.reason);
    }
  }
}
