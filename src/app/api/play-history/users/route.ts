import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { getAllUsersStats } from "@/lib/play-history";
import { getCachedPlexMembersByInstance } from "@/lib/plex-membership";
import { getCachedLiveJellyfinUsers } from "@/lib/jellyfin-live-members-cache";
import { isOnServer } from "@/lib/server-user-presence";

export const dynamic = "force-dynamic";

// Safety bound, like /api/admin/server-users: a large shared server keeps every
// departed identity that still holds history. Past it the answer says so
// (`truncated`) rather than silently stopping.
const MAX_LISTED_USERS = 10_000;

type UserStats = Awaited<ReturnType<typeof getAllUsersStats>>[number];

// One row of the answer. No sourceUserId, email or address: the client needs
// the stats and the on-server answer, not the identity behind them.
function userActivityRow(u: UserStats, onServer: boolean) {
  return {
    id: u.id,
    username: u.username,
    source: u.source,
    serverInstance: u.serverInstance,
    thumbUrl: u.thumbUrl,
    plays: u.plays,
    hours: u.hours,
    lastActive: u.lastActive,
    favPlatform: u.favPlatform,
    directPct: u.directPct,
    transcodePct: u.transcodePct,
    onServer,
  };
}

// Native-client mirror of the admin Activity users page
// (src/app/(app)/admin/activity/users/page.tsx): every media-server user with
// their plays, watch time and last activity, plus whether they are still on
// their server — the page's Active / Removed filter. The whole list in one
// answer (most plays first): the client filters, searches and sorts it, as the
// page does in memory. API v6.
//
// `onServer` comes from the same rule as the page (server-user-presence.ts),
// read live per server through the two process caches. A membership read that
// throws must not fail the list: the rule then falls back to the stored
// `active` flag, exactly as it does for one unreadable server.
export const GET = withPermission(Permission.ADMIN)(async (_request, _ctx, _session) => {
  const [stats, plexMembers, jellyfinLive] = await Promise.all([
    getAllUsersStats(),
    getCachedPlexMembersByInstance().catch(() => null),
    getCachedLiveJellyfinUsers().catch(() => null),
  ]);

  const truncated = stats.length > MAX_LISTED_USERS;
  const listed = truncated ? stats.slice(0, MAX_LISTED_USERS) : stats;
  const users = listed.map((u) => userActivityRow(u, isOnServer(u, plexMembers, jellyfinLive)));
  return NextResponse.json({ users, truncated });
});
