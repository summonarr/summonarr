import type { SummonarrSession } from "@/lib/api-auth";
import { hasPermission, parsePermissions, Permission } from "@/lib/permissions";

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

/**
 * The same predicate for a CLIENT session.
 *
 * The client session shape differs in two ways that both caused real
 * divergence before this existed: `permissions` arrives as a decimal string
 * rather than a bigint, and the two client copies of this logic keyed on
 * `provider` instead of `mediaServer`. Those are genuinely different fields —
 * `mediaServer` is provider-pinned for a Plex/Jellyfin sign-in, but for a
 * credentials or OIDC sign-in it comes from the `User.mediaServer` column an
 * admin sets. So a local-password account assigned a media server got badges on
 * every server-rendered browse card and none in either search bar. Reading only
 * the role STRING was the second divergence: a delegate holding the ADMIN or
 * MANAGE_ISSUES bit on role USER saw both chips in one bar and one in the other.
 *
 * This is a cosmetic mask, not a boundary — /api/search deliberately returns
 * availability unmasked and guardrail 35 says visibility enforcement belongs in
 * the data layer. It exists so the three surfaces agree with each other.
 */
export function getClientBadgeVisibility(
  user: { permissions?: string; mediaServer?: string | null } | null | undefined,
  integrations?: { plex?: boolean; jellyfin?: boolean },
): { showPlex: boolean; showJellyfin: boolean } {
  if (!user) return { showPlex: false, showJellyfin: false };
  return getBadgeVisibility(
    {
      user: {
        permissions: parsePermissions(user.permissions),
        mediaServer: user.mediaServer ?? null,
      },
    } as SummonarrSession,
    integrations,
  );
}
