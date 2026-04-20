import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { count } = await prisma.tmdbCache.deleteMany({
    where: {
      OR: [
        { key: { startsWith: "omdb:" } },
        { key: { startsWith: "mdblist:" } },
      ],
    },
  });

  try {
    await logAuditOrFail({
      userId:   session.user.id,
      userName: session.user.name ?? session.user.email,
      action:   "RATINGS_CACHE_CLEAR",
      target:   "tmdbCache",
      details:  { cleared: count },
      ...auditContext(req, session),
    });
  } catch (err) {
    console.error("[audit] Critical audit log failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

  return NextResponse.json({ cleared: count });
}
