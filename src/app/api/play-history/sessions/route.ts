import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = withPermission(Permission.ADMIN)(async (_req, _ctx, _session) => {
  const sessions = await prisma.activeSession.findMany({
    orderBy: { startedAt: "desc" },
  });

  return NextResponse.json(
    sessions.map((s) => ({
      ...s,
      // All three BigInt columns must be coerced — the `...s` spread would
      // otherwise leak playtimeMs as a BigInt and blow up JSON.stringify.
      progressMs: Number(s.progressMs),
      playtimeMs: Number(s.playtimeMs),
      durationMs: Number(s.durationMs),
    })),
  );
});
