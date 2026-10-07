import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { Permission, effectivePermissions, hasPermission } from "@/lib/permissions";

// Lightweight user list for the "request on behalf of" picker. Gated on
// REQUEST_ON_BEHALF so a non-admin power user with the bit can use it — this is
// deliberately NOT under /api/admin/* (the proxy backstop restricts that subtree
// to admin roles, which would block a legitimate REQUEST_ON_BEHALF holder).
export const GET = withPermission(Permission.REQUEST_ON_BEHALF)(async (_req, _ctx, session) => {
  const rows = await prisma.user.findMany({
    // Deactivated accounts can't sign in or hold requests — keep them out of the
    // picker so nobody files a request on behalf of a disabled user.
    where: { deactivatedAt: null },
    select: { id: true, name: true, email: true, role: true, permissions: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 1000,
  });
  // The bulk route refuses a non-ADMIN actor whose target holds any bit they lack
  // (requests/bulk: `targetMorePermissions`), so the picker must not offer those
  // targets — every pick would end in a 403. ADMIN sees everyone, as before.
  const callerIsAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
  const users = rows
    .filter((u) => callerIsAdmin || (effectivePermissions(u.role, u.permissions) & ~session.user.permissions) === 0n)
    .map(({ id, name, email }) => ({ id, name, email }));
  return NextResponse.json({ users });
});
