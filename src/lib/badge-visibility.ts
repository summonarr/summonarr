import type { SummonarrSession } from "@/lib/api-auth";

// Admins see both badges regardless of their own mediaServer preference; regular users only see
// the badge for the server they authenticated with.  ISSUE_ADMIN is intentionally included here
// because issue triage needs full availability context across both backends.
//
// `integrations` lets a caller suppress a backend's badges when its integration
// flag is disabled (cached library rows can outlive a disabled integration).
// Omitted/undefined flags default to enabled so callers that don't read the
// flags keep their prior behaviour.
export function getBadgeVisibility(
  session: SummonarrSession | null,
  integrations?: { plex?: boolean; jellyfin?: boolean },
): {
  showPlex: boolean;
  showJellyfin: boolean;
} {
  if (!session) return { showPlex: false, showJellyfin: false };

  const plexIntegration = integrations?.plex ?? true;
  const jellyfinIntegration = integrations?.jellyfin ?? true;

  const { role, mediaServer } = session.user;

  if (role === "ADMIN" || role === "ISSUE_ADMIN") {
    return { showPlex: plexIntegration, showJellyfin: jellyfinIntegration };
  }

  return {
    showPlex: plexIntegration && mediaServer === "plex",
    showJellyfin: jellyfinIntegration && mediaServer === "jellyfin",
  };
}
