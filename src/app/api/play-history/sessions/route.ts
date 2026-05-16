import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const sessions = await prisma.activeSession.findMany({
    orderBy: { startedAt: "desc" },
  });

  return NextResponse.json(
    sessions.map((s) => ({
      ...s,
      progressMs: Number(s.progressMs),
      durationMs: Number(s.durationMs),
    })),
  );
});
