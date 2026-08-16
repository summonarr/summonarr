import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assignDiscordRolesOnLink, revokeDiscordRolesOnUnlink } from "@/lib/discord-notify";
import { settleLimit } from "@/lib/concurrency";
import { logAudit } from "@/lib/audit";

// Discord rate-limits per-route aggressively; cap how many member-role syncs run
// at once so a large linked base doesn't burst hundreds of calls and drop syncs.
const SYNC_CONCURRENCY = 5;

export const POST = withAdmin(async (_req, _ctx, session) => {
  // `discordId != null` is necessary but not sufficient. The bot creates SHADOW
  // rows for anyone who runs a slash command — same shape, real snowflake, but
  // synthetic discord_<id>@discord.local email — and nobody has ever linked them
  // to a real account. Granting them the "linked" (and server) roles hands guild
  // membership perks to people who never linked. The synthetic-email suffix is
  // the only discriminator; discord-merge.ts refuses a merge on the same test.
  const [linked, deactivated] = await Promise.all([
    prisma.user.findMany({
      where: {
        discordId: { not: null },
        NOT: { email: { endsWith: "@discord.local" } },
        deactivatedAt: null,
      },
      select: { discordId: true, email: true, role: true },
    }),
    // A disabled account keeps its role, permissions and discordId (guardrail 33
    // deactivates, it does not scrub), so a banned admin otherwise keeps the
    // Discord admin role forever: assignDiscordRolesOnLink's diff only runs while
    // an account is linked, and revokeDiscordRolesOnUnlink is reachable only from
    // an explicit /unlink a banned user never performs. Strip here rather than
    // merely skipping — skipping leaves the grant standing.
    prisma.user.findMany({
      where: { discordId: { not: null }, deactivatedAt: { not: null } },
      select: { discordId: true },
    }),
  ]);

  if (linked.length === 0 && deactivated.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  await settleLimit(linked, SYNC_CONCURRENCY, (u) =>
    assignDiscordRolesOnLink(u.discordId!, u.email, u.role)
  );
  await settleLimit(deactivated, SYNC_CONCURRENCY, (u) =>
    revokeDiscordRolesOnUnlink(u.discordId!)
  );

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "discord:sync-roles",
    details: { type: "discord-role-sync", syncedCount: linked.length, revokedCount: deactivated.length },
  });

  return NextResponse.json({ synced: linked.length, revoked: deactivated.length });
});
