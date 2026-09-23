import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeDiscordRolesOnUnlink } from "@/lib/discord-notify";

// Unlink the caller's Discord account (used by the native clients).
export const POST = withAuth(async (req, _ctx, session) => {
  // Read the id BEFORE clearing it — the update nulls the only record of which
  // Discord member to strip roles from.
  const prev = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { discordId: true },
  });

  await prisma.user.update({
    where: { id: session.user.id },
    data: { discordId: null },
  });

  // Remove the Discord roles Summonarr gave this user, but only AFTER the
  // unlink is saved (guardrail 27: DB write first, side effects second). It is
  // not awaited and handles its own errors: the account is already unlinked,
  // so a Discord API hiccup must not fail the request.
  if (prev?.discordId) {
    void revokeDiscordRolesOnUnlink(prev.discordId);
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `discord-unlink:${session.user.id}`,
    details: { type: "discord-unlink" },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
