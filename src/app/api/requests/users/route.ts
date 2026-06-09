import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { Permission } from "@/lib/permissions";

// Lightweight user list for the "request on behalf of" picker. Gated on
// REQUEST_ON_BEHALF so a non-admin power user with the bit can use it — this is
// deliberately NOT under /api/admin/* (the proxy backstop restricts that subtree
// to admin roles, which would block a legitimate REQUEST_ON_BEHALF holder).
export const GET = withPermission(Permission.REQUEST_ON_BEHALF)(async () => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 1000,
  });
  return NextResponse.json({ users });
});
