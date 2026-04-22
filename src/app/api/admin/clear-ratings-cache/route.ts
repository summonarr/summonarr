import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";

export async function DELETE(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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
