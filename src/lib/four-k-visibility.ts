import "server-only";
import { prisma } from "@/lib/prisma";
import { canRequest } from "@/lib/permissions";
import { processSingleton } from "@/lib/process-singleton";
import type { SummonarrSession } from "@/lib/api-auth";

// Whether to surface 4K availability/pending state to this viewer. True only when a 4K
// Radarr/Sonarr instance is configured AND the viewer can request 4K (per-user REQUEST_4K bit
// or the server-wide request4kAll toggle). Mirrors the gate on the detail-page "Request in 4K"
// button so HD-only users are never shown 4K state they can't act on.
//
// `mediaType` scopes the check to a single backend so a page that lists only one
// type (e.g. /movies, /tv) doesn't surface 4K state for the other backend when
// only its 4K instance is configured. Omit it for mixed lists (the combined OR).
//
// One settings query (presence checks + the server-wide flag), held for a few
// seconds, so callers can pass the result straight into attachAllAvailability
// without extra round-trips per page.
// The settings half of the answer, shared by every viewer. Pages and the
// search route ask on every render, so it is held briefly — the feature flags'
// own window — instead of re-reading (and decrypting) five rows each time. A
// saved 4K instance shows up within it. Process-wide (guardrail 27a).
const FOUR_K_CONFIG_TTL_MS = 10_000;

interface FourKConfig {
  radarr4k: boolean;
  sonarr4k: boolean;
  serverAll4k: boolean;
}

const fourKConfigCache = processSingleton("four-k-visibility:config", () => ({
  value: null as FourKConfig | null,
  expiresAt: 0,
  inflight: null as Promise<FourKConfig> | null,
}));

/** Drops the held 4K settings, so the next viewer reads them fresh. */
export function invalidateShow4kVisibilityCache(): void {
  fourKConfigCache.value = null;
  fourKConfigCache.expiresAt = 0;
  fourKConfigCache.inflight = null;
}

async function readFourKConfig(): Promise<FourKConfig> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["radarr4kUrl", "radarr4kApiKey", "sonarr4kUrl", "sonarr4kApiKey", "request4kAll"] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    radarr4k: !!(map.radarr4kUrl && map.radarr4kApiKey),
    sonarr4k: !!(map.sonarr4kUrl && map.sonarr4kApiKey),
    serverAll4k: map.request4kAll === "true",
  };
}

async function fourKConfig(): Promise<FourKConfig> {
  const cache = fourKConfigCache;
  if (cache.value && Date.now() < cache.expiresAt) return cache.value;
  if (cache.inflight) return cache.inflight;
  const inflight = readFourKConfig().then((value) => {
    // An invalidate while the read was in flight wins: nothing is stored.
    if (cache.inflight === inflight) {
      cache.value = value;
      cache.expiresAt = Date.now() + FOUR_K_CONFIG_TTL_MS;
    }
    return value;
  }).finally(() => {
    if (cache.inflight === inflight) cache.inflight = null;
  });
  cache.inflight = inflight;
  return inflight;
}

export async function getShow4kVisibility(
  session: SummonarrSession | null,
  mediaType?: "movie" | "tv",
): Promise<boolean> {
  if (!session) return false;

  const { radarr4k, sonarr4k, serverAll4k } = await fourKConfig();
  if (!radarr4k && !sonarr4k) return false;

  const perms = session.user.permissions;
  const movieShow = radarr4k && canRequest(perms, "MOVIE", true, serverAll4k);
  const tvShow = sonarr4k && canRequest(perms, "TV", true, serverAll4k);

  if (mediaType === "movie") return movieShow;
  if (mediaType === "tv") return tvShow;
  return movieShow || tvShow;
}
