import type { Session } from "next-auth";

// Admins see both badges regardless of their own mediaServer preference; regular users only see
// the badge for the server they authenticated with.  ISSUE_ADMIN is intentionally included here
// because issue triage needs full availability context across both backends.
export function getBadgeVisibility(session: Session | null): {
  showPlex: boolean;
  showJellyfin: boolean;
} {
  if (!session) return { showPlex: false, showJellyfin: false };

  const { role, mediaServer } = session.user;

  if (role === "ADMIN" || role === "ISSUE_ADMIN") {
    return { showPlex: true, showJellyfin: true };
  }

  return {
    showPlex: mediaServer === "plex",
    showJellyfin: mediaServer === "jellyfin",
  };
}
