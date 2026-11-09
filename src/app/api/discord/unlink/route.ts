import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeDiscordRolesOnUnlink } from "@/lib/discord-notify";

// A concurrent link can change the id between the read and the clear; the
// clear is retried on the new id this many times before giving up.
const MAX_CLEAR_ATTEMPTS = 3;

// Clears the caller's Discord link as a compare-and-swap on the id it read, and
// returns the id this call actually cleared (null when nothing was linked). A
// confirm-merge that links another Discord account between the read and the
// write makes the swap miss: the id is read again, so the roles revoked below
// always belong to the account that was unlinked.
async function clearDiscordLink(userId: string): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_CLEAR_ATTEMPTS; attempt++) {
    const prev = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
    if (!prev?.discordId) return null;
    const { count } = await prisma.user.updateMany({
      where: { id: userId, discordId: prev.discordId },
      data: { discordId: null },
    });
    if (count === 1) return prev.discordId;
  }
  return null;
}

// Unlink the caller's Discord account (used by the native clients). Unlinking
// nothing is a harmless 200 that writes, revokes and audits nothing.
export const POST = withAuth(async (req, _ctx, session) => {
  const cleared = await clearDiscordLink(session.user.id);
  if (cleared === null) return NextResponse.json({ ok: true });

  // A code still pending from before the unlink would re-link the account
  // within its window; the user just chose the opposite. Best-effort: the
  // unlink has committed, and both rows expire on their own.
  try {
    await prisma.discordLinkToken.deleteMany({ where: { userId: session.user.id } });
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
  } catch (err) {
    console.error("[discord] Unlinked, but clearing the pending link codes failed:", err instanceof Error ? err.message : err);
  }

  // Remove the Discord roles Summonarr gave this user, but only AFTER the
  // unlink is saved (guardrail 27: DB write first, side effects second). It is
  // not awaited and handles its own errors: the account is already unlinked,
  // so a Discord API hiccup must not fail the request.
  void revokeDiscordRolesOnUnlink(cleared);
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
