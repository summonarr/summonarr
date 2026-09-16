import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getUserWatchGradeDetail } from "@/lib/watch-grade-data";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// A user's request watch grade with the per-request breakdown behind it (see
// src/lib/watch-grade.ts). Readable by MANAGE_USERS (the Users page) OR
// MANAGE_REQUESTS (the request queue shows the same grade beside each requester,
// and the breakdown is what makes that letter actionable). Read-only: the grade
// is display-only and nothing here changes a request, a quota or a permission.
export const GET = withPermission([Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS])(async (
  _req,
  { params }: RouteParams,
  _session,
) => {
  const { id } = await params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(await getUserWatchGradeDetail(id));
});
