import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assignDiscordRolesOnLink, revokeDiscordRolesOnUnlink, type DiscordRoleSyncOutcome } from "@/lib/discord-notify";
import { settleLimit } from "@/lib/concurrency";
import { logAudit, auditContext } from "@/lib/audit";

// Discord rate-limits per-route aggressively; cap how many member-role syncs run
// at once so a large linked base doesn't burst hundreds of calls and drop syncs.
const SYNC_CONCURRENCY = 5;

// The role helpers report what they did instead of throwing, so the counts are
// what Discord ACCEPTED: "ok" counts, "failed" (any refused or failed call, or a
// throw) and "skipped" (integration off, no guild or managed role configured)
// are reported apart.
function tally(results: PromiseSettledResult<DiscordRoleSyncOutcome>[]): Record<DiscordRoleSyncOutcome, number> {
  const out: Record<DiscordRoleSyncOutcome, number> = { ok: 0, failed: 0, skipped: 0 };
  for (const r of results) out[r.status === "fulfilled" ? r.value : "failed"]++;
  return out;
}

export const POST = withAdmin(async (req, _ctx, session) => {
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
      // The sign-in facts pick the server role (discordServerRoleSource): a
      // local or OIDC account earns neither the Plex nor the Jellyfin role.
      select: { id: true, discordId: true, email: true, role: true, plexUserId: true, jellyfinUserId: true, passwordHash: true },
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

  const oidcIds = linked.length === 0
    ? new Set<string>()
    : new Set((await prisma.account.findMany({
        where: { provider: "oidc", userId: { in: linked.map((u) => u.id) } },
        select: { userId: true },
      })).map((a) => a.userId));

  const assigned = tally(await settleLimit(linked, SYNC_CONCURRENCY, (u) =>
    assignDiscordRolesOnLink(u.discordId!, {
      email: u.email,
      role: u.role,
      plexUserId: u.plexUserId,
      jellyfinUserId: u.jellyfinUserId,
      hasLocalCredentials: u.passwordHash != null,
      hasOidcAccount: oidcIds.has(u.id),
    })
  ));
  const revoked = tally(await settleLimit(deactivated, SYNC_CONCURRENCY, (u) =>
    revokeDiscordRolesOnUnlink(u.discordId!)
  ));
  const failed = assigned.failed + revoked.failed;
  const skipped = assigned.skipped + revoked.skipped;

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "discord:sync-roles",
    details: { type: "discord-role-sync", syncedCount: assigned.ok, revokedCount: revoked.ok, failedCount: failed, skippedCount: skipped },
    ...auditContext(req, session),
  });

  return NextResponse.json({ synced: assigned.ok, revoked: revoked.ok, failed, skipped });
});
