import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeDiscordRolesOnUnlink } from "@/lib/discord-notify";

// Unlink the caller's Discord account. No unlink path existed (web only ever
// showed linked status), so native clients had no way to disconnect.
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

  // Roles are revoked only AFTER the unlink commits (guardrail 27: never act on
  // external state before the DB write it represents). Fire-and-forget and
  // self-swallowing — the account is already unlinked, so a Discord API blip
  // must not fail the request. Without this the user kept every role Summonarr
  // granted them, admin included, with no way to lose it.
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
