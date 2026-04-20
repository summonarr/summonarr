import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN" || isTokenExpired(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
