import { getJellyfinAllUsers } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import type { MediaInstanceKey } from "@/lib/media-instances";

/**
 * Each configured Jellyfin server's CURRENT users, read live: server instance →
 * (user id → disabled). An instance whose fetch failed or came back empty is
 * left out ("can't tell") so callers fall back to the stored `active` flag
 * rather than reading an outage as everyone having left.
 */
export async function getLiveJellyfinUsers(): Promise<Map<MediaInstanceKey, Map<string, boolean>>> {
  const out = new Map<MediaInstanceKey, Map<string, boolean>>();
  let instances;
  try {
    instances = await getSyncableMediaInstances("jellyfin");
  } catch (err) {
    console.warn("[jellyfin-live-members] instance read failed:", err instanceof Error ? err.message : String(err));
    return out;
  }
  await Promise.all(
    instances.map(async ({ slug }) => {
      try {
        const cfg = await getJellyfinConfig(slug);
        if (!cfg.url || !cfg.apiKey) return;
        const users = await getJellyfinAllUsers(cfg.url, cfg.apiKey);
        if (users.length === 0) return;
        out.set(slug, new Map(users.map((u) => [u.id, u.isDisabled === true])));
      } catch (err) {
        console.warn(`[jellyfin-live-members] fetch failed for "${slug}":`, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  return out;
}
