import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { hashPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { normalizeEmail } from "@/lib/email-normalize";
import { sanitizeOptional } from "@/lib/sanitize";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { logAudit, auditContext } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Shared shape for both the list (GET) and create (POST) so the two never drift.
const USER_SELECT = {
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
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function serializeUser(u: UserRow) {
  return {
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
  };
}

// User list for native admin clients. The web admin page reads this inline in a
// server component; this exposes the same data as REST. Per-user edits go
// through PATCH/DELETE /api/admin/users/[id].
export const GET = withAdmin(async (_req, _ctx, _session) => {
  const users = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 1000,
  });

  return NextResponse.json(users.map(serializeUser));
});

// Create a local-credentials user (web + native admin "Create user"). Registration
// is otherwise closed after the first user, so this is the only in-app path to a
// new username/password account — e.g. an App Review demo account. Role seeds the
// permission bitmask (defaultPermissionsForRole); tune later via PATCH.
export const POST = withAdmin(async (req, _ctx, session) => {
  let body: { email?: string; password?: string; name?: string | null; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const role = body.role ?? "USER";
  if (role !== "USER" && role !== "ISSUE_ADMIN" && role !== "ADMIN") {
    return NextResponse.json({ error: "role must be USER, ISSUE_ADMIN, or ADMIN" }, { status: 400 });
  }

  const email = body.email;
  if (!email || typeof email !== "string" || email.length > 254 || /\s/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }
  const parts = email.split("@");
  const domainDot = parts[1]?.lastIndexOf(".") ?? -1;
  if (parts.length !== 2 || !parts[0] || !parts[1] || domainDot < 1 || domainDot === parts[1].length - 1) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  const password = body.password;
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  if (body.name !== undefined && body.name !== null && (typeof body.name !== "string" || body.name.trim().length > 100)) {
    return NextResponse.json({ error: "Name must be under 100 characters" }, { status: 400 });
  }

  const normalized = normalizeEmail(email);
  const name = sanitizeOptional(body.name);
  const passwordHash = await hashPassword(password);

  let user: UserRow;
  try {
    user = await prisma.user.create({
      data: {
        name,
        email: normalized,
        passwordHash,
        role: role as "USER" | "ISSUE_ADMIN" | "ADMIN",
        permissions: defaultPermissionsForRole(role),
      },
      select: USER_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
    }
    throw err;
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "USER_CREATE",
    target: `user:${user.id}`,
    details: { targetUser: name ?? normalized, targetEmail: normalized, role },
    ...auditContext(req, session),
  });

  return NextResponse.json(serializeUser(user), { status: 201 });
});
