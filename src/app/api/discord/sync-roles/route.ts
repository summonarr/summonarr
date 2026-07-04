import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assignDiscordRolesOnLink } from "@/lib/discord-notify";
import { settleLimit } from "@/lib/concurrency";
import { logAudit } from "@/lib/audit";

// Discord rate-limits per-route aggressively; cap how many member-role syncs run
// at once so a large linked base doesn't burst hundreds of calls and drop syncs.
const SYNC_CONCURRENCY = 5;

export const POST = withAdmin(async (_req, _ctx, session) => {
  const users = await prisma.user.findMany({
    where: { discordId: { not: null } },
    select: { discordId: true, email: true, role: true },
  });

  if (users.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  await settleLimit(users, SYNC_CONCURRENCY, (u) =>
    assignDiscordRolesOnLink(u.discordId!, u.email, u.role)
  );

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "discord:sync-roles",
    details: { type: "discord-role-sync", syncedCount: users.length },
  });

  return NextResponse.json({ synced: users.length });
});
