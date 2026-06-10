import "server-only";
import { prisma } from "@/lib/prisma";
import { canRequest } from "@/lib/permissions";
import type { SummonarrSession } from "@/lib/api-auth";

// Whether to surface 4K availability/pending state to this viewer. True only when a 4K
// Radarr/Sonarr instance is configured AND the viewer can request 4K (per-user REQUEST_4K bit
// or the server-wide request4kAll toggle). Mirrors the gate on the detail-page "Request in 4K"
// button so HD-only users are never shown 4K state they can't act on.
//
// Single settings query (presence checks + the server-wide flag) so callers can pass the result
// straight into attachAllAvailability without fanning out extra round-trips per page.
export async function getShow4kVisibility(session: SummonarrSession | null): Promise<boolean> {
  if (!session) return false;

  const rows = await prisma.setting.findMany({
    where: { key: { in: ["radarr4kUrl", "radarr4kApiKey", "sonarr4kUrl", "sonarr4kApiKey", "request4kAll"] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const radarr4k = !!(map.radarr4kUrl && map.radarr4kApiKey);
  const sonarr4k = !!(map.sonarr4kUrl && map.sonarr4kApiKey);
  if (!radarr4k && !sonarr4k) return false;

  const serverAll4k = map.request4kAll === "true";
  const perms = session.user.permissions;
  return (
    (radarr4k && canRequest(perms, "MOVIE", true, serverAll4k)) ||
    (sonarr4k && canRequest(perms, "TV", true, serverAll4k))
  );
}
