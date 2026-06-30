import type { SummonarrSession } from "@/lib/api-auth";
import { hasPermission, Permission } from "@/lib/permissions";

// Admins (ADMIN bit) and issue managers see both badges regardless of their own
// mediaServer preference; regular users only see the badge for the server they
// authenticated with. Uses bits so granular MANAGE_ISSUES etc get full context.
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

  const { mediaServer, permissions } = session.user;

  if (hasPermission(permissions, [Permission.ADMIN, Permission.MANAGE_ISSUES])) {
    return { showPlex: plexIntegration, showJellyfin: jellyfinIntegration };
  }

  return {
    showPlex: plexIntegration && mediaServer === "plex",
    showJellyfin: jellyfinIntegration && mediaServer === "jellyfin",
  };
}
