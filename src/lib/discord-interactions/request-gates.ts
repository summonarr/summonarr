import { prisma } from "@/lib/prisma";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { effectivePermissions, hasPermission, Permission } from "@/lib/permissions";

// The Discord request rules the /request command and its result pick share:
// who must have a linked account, who holds an auto-approve role, and who may
// act during maintenance. One copy, so the command and the button can't drift.

/** The `discordAutoApproveRoles` setting: comma-separated Discord role ids. */
export function parseAutoApproveRoles(value: string | null | undefined): string[] {
  return (value ?? "").split(",").map((r) => r.trim()).filter(Boolean);
}

/**
 * Whether a guild member holds an auto-approve role. Such a role exempts them
 * from the linked-account requirement and auto-approves their requests (as the
 * global auto-approve bit — request-policy.ts autoApprovesOn).
 */
export function holdsAutoApproveRole(autoApproveRoles: readonly string[], memberRoles: readonly string[]): boolean {
  return autoApproveRoles.length > 0 && memberRoles.some((r) => autoApproveRoles.includes(r));
}

export interface DiscordRequestSettings {
  // `discordRequireLinkedAccount`: a request needs a linked site account.
  requireLinked: boolean;
  autoApproveRoles: string[];
}

export async function loadDiscordRequestSettings(): Promise<DiscordRequestSettings> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["discordRequireLinkedAccount", "discordAutoApproveRoles"] } },
  });
  const setting = new Map(rows.map((r) => [r.key, r.value]));
  return {
    requireLinked: setting.get("discordRequireLinkedAccount") === "true",
    autoApproveRoles: parseAutoApproveRoles(setting.get("discordAutoApproveRoles")),
  };
}

/**
 * Whether maintenance refuses a Discord user's write. The web's rule
 * (maintenance.ts): the ADMIN bit of their linked, active account bypasses it,
 * and a maintenance setting that can't be read refuses. A user who ran a
 * command BEFORE maintenance began can still click its buttons afterwards, so
 * every write behind a button checks again.
 */
export async function maintenanceRefuses(discordUserId: string): Promise<boolean> {
  if (!(await getMaintenanceStatus()).enabled) return false;
  const account = await prisma.user.findFirst({
    where: { discordId: discordUserId, deactivatedAt: null },
    select: { role: true, permissions: true },
  });
  return !(account && hasPermission(effectivePermissions(account.role, account.permissions), Permission.ADMIN));
}
