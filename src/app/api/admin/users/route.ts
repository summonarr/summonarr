import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// User list for native admin clients. The web admin page reads this inline in a
// server component; this exposes the same data as REST. Per-user edits go
// through PATCH/DELETE /api/admin/users/[id].
export const GET = withAdmin(async (_req, _ctx, _session) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      mediaServer: true,
      movieQuotaLimit: true,
      movieQuotaDays: true,
      tvQuotaLimit: true,
      tvQuotaDays: true,
      permissions: true,
      notifyOnApproved: true,
      notifyOnAvailable: true,
      notifyOnDeclined: true,
      emailOnApproved: true,
      emailOnAvailable: true,
      emailOnDeclined: true,
      pushOnApproved: true,
      pushOnAvailable: true,
      pushOnDeclined: true,
      notifyOnIssue: true,
      _count: { select: { requests: true } },
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 1000,
  });

  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      mediaServer: u.mediaServer,
      movieQuotaLimit: u.movieQuotaLimit,
      movieQuotaDays: u.movieQuotaDays,
      tvQuotaLimit: u.tvQuotaLimit,
      tvQuotaDays: u.tvQuotaDays,
      // BigInt → decimal string (the PATCH expects the same encoding); lets the
      // native client populate the permissions editor.
      permissions: u.permissions.toString(),
      notifyOnApproved: u.notifyOnApproved,
      notifyOnAvailable: u.notifyOnAvailable,
      notifyOnDeclined: u.notifyOnDeclined,
      emailOnApproved: u.emailOnApproved,
      emailOnAvailable: u.emailOnAvailable,
      emailOnDeclined: u.emailOnDeclined,
      pushOnApproved: u.pushOnApproved,
      pushOnAvailable: u.pushOnAvailable,
      pushOnDeclined: u.pushOnDeclined,
      notifyOnIssue: u.notifyOnIssue,
      requestCount: u._count.requests,
    })),
  );
});
