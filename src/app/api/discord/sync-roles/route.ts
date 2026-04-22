import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assignDiscordRolesOnLink } from "@/lib/discord-notify";
import { logAudit } from "@/lib/audit";

export async function POST() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const users = await prisma.user.findMany({
    where: { discordId: { not: null } },
    select: { discordId: true, email: true, role: true },
  });

  if (users.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  await Promise.allSettled(
    users.map((u) => assignDiscordRolesOnLink(u.discordId!, u.email, u.role))
  );

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "discord:sync-roles",
    details: { type: "discord-role-sync", syncedCount: users.length },
  });

  return NextResponse.json({ synced: users.length });
}
