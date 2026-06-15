import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

// Discord link status for native clients. The web profile reads discordId inline
// in a server component; /api/auth/me doesn't carry it (not a JWT claim), so a
// native client needs this lookup.
export const GET = withAuth(async (_req, _ctx, session) => {
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { discordId: true },
  });
  return NextResponse.json({ discordId: user?.discordId ?? null, linked: !!user?.discordId });
});
