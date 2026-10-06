import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { hashPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { normalizeEmail } from "@/lib/email-normalize";
import { sanitizeOptional } from "@/lib/sanitize";
import { Permission, hasPermission, defaultPermissionsForRole } from "@/lib/permissions";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { deriveUserSource } from "@/lib/user-source";

export const dynamic = "force-dynamic";

// Shared shape for both the list (GET) and create (POST) so the two never drift.
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
  deactivatedAt: true,
  purgedAt: true,
  mediaServer: true,
  maxContentRating: true,
  passwordHash: true, // not serialized — only to derive `source` (local vs OAuth)
  plexUserId: true, // not serialized — only to derive `source`
  jellyfinUserId: true, // not serialized — only to derive `source`
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

function serializeUser(u: UserRow, hasOidcAccount: boolean) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt,
    // Account lifecycle: deactivatedAt set ⇒ disabled (sign-in refused, an admin
    // can re-enable); purgedAt set ⇒ personal data was scrubbed and the row can
    // never be re-enabled. See src/lib/account-lifecycle.ts.
    deactivatedAt: u.deactivatedAt,
    purgedAt: u.purgedAt,
    mediaServer: u.mediaServer,
    maxContentRating: u.maxContentRating,
    // Auth source — the SAME derivation the web admin page uses (user-source.ts),
    // so the chip never disagrees between web and native: local (passwordHash),
    // oidc (an `oidc` Account row), jellyfin (subject id or synthetic email),
    // plex, discord. The native client gates the media-server-access control on
    // `source === "local"`; the value set is additive over the old local/jellyfin/plex.
    source: deriveUserSource({
      email: u.email ?? "",
      plexUserId: u.plexUserId,
      jellyfinUserId: u.jellyfinUserId,
      hasLocalCredentials: u.passwordHash != null,
      hasOidcAccount,
    }),
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
// MANAGE_USERS (not withAdmin) so the same capability bit that gates the [id]
// PATCH/DELETE also gates listing/creating — a MANAGE_USERS holder could
// otherwise edit and delete users it couldn't list.
export const GET = withPermission(Permission.MANAGE_USERS)(async (_req, _ctx, _session) => {
  const users = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 1000,
  });

  const oidcIds = await oidcAccountHolders(users);
  return NextResponse.json(users.map((u) => serializeUser(u, oidcIds.has(u.id))));
});

// One Account read for the whole list (like the admin page), and only for the
// rows that can be OIDC at all — a passwordHash already decides "local". The
// label is cosmetic, so a failed read degrades to "no OIDC binding" rather than
// taking the user list down.
async function oidcAccountHolders(users: readonly { id: string; passwordHash: string | null }[]): Promise<Set<string>> {
  const candidates = users.filter((u) => u.passwordHash == null).map((u) => u.id);
  if (candidates.length === 0) return new Set();
  try {
    const rows = await prisma.account.findMany({
      where: { provider: "oidc", userId: { in: candidates } },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  } catch (err) {
    console.warn("[admin-users] OIDC account read failed; source labels fall back to local/jellyfin/plex", err);
    return new Set();
  }
}

// Create a local-credentials user (web + native admin "Create user"). Registration
// is otherwise closed after the first user, so this is the only in-app path to a
// new username/password account — e.g. an App Review demo account. Role seeds the
// permission bitmask (defaultPermissionsForRole); tune later via PATCH.
export const POST = withPermission(Permission.MANAGE_USERS)(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`admin-user-create:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyAttempts") }, { status: 429 });
  }
  const parsed = await readJsonCapped<{ email?: string; password?: string; name?: string | null; role?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const role = body.role ?? "USER";
  if (role !== "USER" && role !== "ISSUE_ADMIN" && role !== "ADMIN") {
    return NextResponse.json({ error: t("apiAdmin.users.roleInvalidCreate") }, { status: 400 });
  }
  // MANAGE_USERS delegates creation of NON-admin users only. Creating an ADMIN
  // account requires the caller to be a full admin — otherwise a MANAGE_USERS
  // holder could mint a fresh ADMIN with a password they control and self-escalate.
  // session.user.permissions is the effective mask (api-auth resolves it).
  if (role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminCreate") }, { status: 403 });
  }

  // Normalize FIRST, validate the normalized value: NFKC folds a fullwidth "＠"
  // (not whitespace, not "@") into a real "@", so checking the raw string let
  // `a＠b@c.com` pass the single-@ rule and be stored as `a@b@c.com`.
  // Whitespace is still refused on the RAW value (padding is rejected, never
  // trimmed, so two addresses differing only by padding can't both be accepted).
  const rawEmail = body.email;
  if (!rawEmail || typeof rawEmail !== "string" || rawEmail.length > 254 || /\s/.test(rawEmail)) {
    return NextResponse.json({ error: t("apiAdmin.users.invalidEmail") }, { status: 400 });
  }
  const normalized = normalizeEmail(rawEmail);
  if (!normalized || normalized.length > 254 || /\s/.test(normalized)) {
    return NextResponse.json({ error: t("apiAdmin.users.invalidEmail") }, { status: 400 });
  }
  const parts = normalized.split("@");
  const domainDot = parts[1]?.lastIndexOf(".") ?? -1;
  if (parts.length !== 2 || !parts[0] || !parts[1] || domainDot < 1 || domainDot === parts[1].length - 1) {
    return NextResponse.json({ error: t("apiAdmin.users.invalidEmail") }, { status: 400 });
  }

  const password = body.password;
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: t("apiAdmin.users.passwordRequired") }, { status: 400 });
  }
  // 12, the same floor as first-admin registration and the profile password
  // change — an admin-created account (the only post-setup path to a local one,
  // ADMIN role included) must not be weaker than what the user could set alone.
  if (password.length < 12) {
    return NextResponse.json({ error: t("apiAdmin.users.passwordTooShort") }, { status: 400 });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: t("apiAdmin.users.passwordTooLong", { max: MAX_PASSWORD_LENGTH }) }, { status: 400 });
  }

  if (body.name !== undefined && body.name !== null && (typeof body.name !== "string" || body.name.trim().length > 100)) {
    return NextResponse.json({ error: t("apiAdmin.users.nameTooLong") }, { status: 400 });
  }

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
      return NextResponse.json({ error: t("apiAdmin.users.emailExists") }, { status: 409 });
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

  // A row created with a passwordHash is "local" by construction — no Account read.
  return NextResponse.json(serializeUser(user, false), { status: 201 });
});
