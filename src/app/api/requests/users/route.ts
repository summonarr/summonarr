import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { Permission, effectivePermissions, hasPermission } from "@/lib/permissions";
import { maskEmail } from "@/lib/email-mask";

// The most users the picker lists, and the page size it reads them in.
const MAX_USERS = 1000;
// A non-ADMIN caller's read stops here even short of MAX_USERS eligible rows, so
// one request stays bounded on any deployment.
const MAX_SCANNED = 50 * MAX_USERS;

// Lightweight user list for the "request on behalf of" picker. Gated on
// REQUEST_ON_BEHALF so a non-admin power user with the bit can use it — this is
// deliberately NOT under /api/admin/* (the proxy backstop restricts that subtree
// to admin roles, which would block a legitimate REQUEST_ON_BEHALF holder).
//
// A non-ADMIN caller gets every OTHER account's email masked (maskEmail): the
// name, or the masked address for a name-less account, is enough to pick, and
// the holder of this one bit has no reason to collect every user's address.
// `truncated` (additive) says the list stopped before reading every account.
export const GET = withPermission(Permission.REQUEST_ON_BEHALF)(async (_req, _ctx, session) => {
  // The bulk route refuses a non-ADMIN actor whose target holds any bit they lack
  // (requests/bulk: `targetMorePermissions`), so the picker must not offer those
  // targets — every pick would end in a 403. ADMIN sees everyone, as before.
  const callerIsAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
  const eligible = (u: { role: string; permissions: bigint }) =>
    callerIsAdmin || (effectivePermissions(u.role, u.permissions) & ~session.user.permissions) === 0n;
  const shownEmail = (u: { id: string; email: string }) =>
    callerIsAdmin || u.id === session.user.id ? u.email : maskEmail(u.email);

  // That filter runs on the rows read, so the read pages on until MAX_USERS
  // eligible users are found: one page of the first 1000 by name could be all
  // more-privileged accounts and hide every user the caller may pick. An ADMIN
  // keeps everyone, so their first page is the whole answer.
  const users: Array<{ id: string; name: string | null; email: string }> = [];
  let readEveryAccount = false;
  for (let skip = 0; users.length < MAX_USERS && skip < MAX_SCANNED; skip += MAX_USERS) {
    const rows = await prisma.user.findMany({
      // Deactivated accounts can't sign in or hold requests — keep them out of the
      // picker so nobody files a request on behalf of a disabled user.
      where: { deactivatedAt: null },
      select: { id: true, name: true, email: true, role: true, permissions: true },
      // The id makes the order total, so consecutive pages neither repeat nor skip a row.
      orderBy: [{ name: "asc" }, { email: "asc" }, { id: "asc" }],
      skip,
      take: MAX_USERS,
    });
    let consumed = 0;
    for (const u of rows) {
      if (users.length >= MAX_USERS) break;
      consumed++;
      if (eligible(u)) users.push({ id: u.id, name: u.name, email: shownEmail(u) });
    }
    // A short page read to its end is the end of the table.
    if (rows.length < MAX_USERS && consumed === rows.length) {
      readEveryAccount = true;
      break;
    }
    if (callerIsAdmin) break;
  }
  return NextResponse.json({ users, truncated: !readEveryAccount });
});
