import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";

// Unlink the caller's Discord account. No unlink path existed (web only ever
// showed linked status), so native clients had no way to disconnect.
export const POST = withAuth(async (req, _ctx, session) => {
  await prisma.user.update({
    where: { id: session.user.id },
    data: { discordId: null },
  });
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
