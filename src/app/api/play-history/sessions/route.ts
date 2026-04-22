import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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
}
