import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { hashPassword } from "@/lib/password-hash";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { parseAccountEmail } from "@/lib/account-email";
import { isReservedEmailDomain } from "@/lib/reserved-email";
import { sanitizeOptional } from "@/lib/sanitize";
import { Permission, hasPermission, defaultPermissionsForRole, presetExceeds } from "@/lib/permissions";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { deriveUserSource } from "@/lib/user-source";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { parsePageParam } from "@/lib/pagination";
import { splitAtCap, truncationHeaders } from "@/lib/truncation";

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
  notifyOnComment: true,
  emailOnComment: true,
  pushOnComment: true,
  _count: { select: { requests: true } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

// Every selected column goes out as is, except the ones read only to derive
// `source`, the BigInt mask and the count. Listing the fields once (USER_SELECT)
// means a new column can't be selected and then forgotten here.
function serializeUser(u: UserRow, hasOidcAccount: boolean) {
  const { passwordHash, plexUserId, jellyfinUserId, permissions, _count, ...columns } = u;
  return {
    // Account lifecycle rides along: deactivatedAt set ⇒ disabled (sign-in
    // refused, an admin can re-enable); purgedAt set ⇒ personal data was
    // scrubbed and the row can never be re-enabled (account-lifecycle.ts).
    ...columns,
    // Auth source — the SAME derivation the web admin page uses (user-source.ts),
    // so the chip never disagrees between web and native: local (passwordHash),
    // oidc (an `oidc` Account row), jellyfin (subject id or synthetic email),
    // plex, discord. The native client gates the media-server-access control on
    // `source === "local"`; the value set is additive over the old local/jellyfin/plex.
    source: deriveUserSource({
      email: u.email ?? "",
      plexUserId,
      jellyfinUserId,
      hasLocalCredentials: passwordHash != null,
      hasOidcAccount,
    }),
    // BigInt → decimal string (the PATCH expects the same encoding); lets the
    // native client populate the permissions editor.
    permissions: permissions.toString(),
    requestCount: _count.requests,
  };
}

// User list for native admin clients. The web admin page reads this inline in a
// server component; this exposes the same data as REST. Per-user edits go
// through PATCH/DELETE /api/admin/users/[id].
// MANAGE_USERS (not withAdmin) so the same capability bit that gates the [id]
// PATCH/DELETE also gates listing/creating — a MANAGE_USERS holder could
// otherwise edit and delete users it couldn't list.
// The answer stays the bare array: at most USER_LIST_CAP users per page, and
// `X-Truncated: true` says more exist — `?page=2` reads the next USER_LIST_CAP.
const USER_LIST_CAP = 1000;

export const GET = withPermission(Permission.MANAGE_USERS)(async (req, _ctx, _session) => {
  const page = parsePageParam(req.nextUrl.searchParams);
  const fetched = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: [{ name: "asc" }, { email: "asc" }, { id: "asc" }],
    skip: (page - 1) * USER_LIST_CAP,
    take: USER_LIST_CAP + 1,
  });
  const { rows: users, truncated } = splitAtCap(fetched, USER_LIST_CAP);

  const oidcIds = await oidcAccountHolders(users);
  return NextResponse.json(users.map((u) => serializeUser(u, oidcIds.has(u.id))), {
    headers: truncationHeaders(truncated, USER_LIST_CAP),
  });
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
    return tooManyRequests(60, t("apiAdmin.common.tooManyAttempts"));
  }
  const parsed = await readJsonCapped<{ email?: string; password?: string; name?: string | null; role?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const input = validateCreateUser(parsed, session.user.permissions, t);
  if (input instanceof NextResponse) return input;
  const { role, email, password, name } = input;

  // A delegate must not create an account under a media-server user's email.
  // Play-history attribution falls back to an EMAIL match for any identity with
  // no provider-bound account (resolveMediaServerUser, play-history.ts) — the
  // typical Plex friend who never signed in here. So a delegate could create
  // `friend@…` with a password of their choosing, let the next 5s poll bind the
  // friend's identity to it, then sign in as that account and read the friend's
  // watch history (and the friend's own later Plex/OIDC sign-in would be refused
  // as an email collision). An admin may still do this deliberately.
  if (!hasPermission(session.user.permissions, Permission.ADMIN)) {
    const serverUser = await prisma.mediaServerUser.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (serverUser) {
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminCreateServerEmail") }, { status: 403 });
    }
  }

  const passwordHash = await hashPassword(password);

  let user: UserRow;
  try {
    user = await prisma.user.create({
      data: { name, email, passwordHash, role, permissions: defaultPermissionsForRole(role) },
      select: USER_SELECT,
    });
  } catch (err) {
    if (isPrismaErrorCode(err, "P2002")) {
      return NextResponse.json({ error: t("apiAdmin.users.emailExists") }, { status: 409 });
    }
    throw err;
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "USER_CREATE",
    target: `user:${user.id}`,
    // The account is named by its id (and display name, when it has one) —
    // never its email: audit details outlive the retention scrub of everything
    // else unless the scrub reaches them (audit-scrub.ts), and an email is the
    // one value that identifies the person everywhere.
    details: { targetUserId: user.id, ...(name ? { targetUser: name } : {}), role },
    ...auditContext(req, session),
  });

  // A row created with a passwordHash is "local" by construction — no Account read.
  return NextResponse.json(serializeUser(user, false), { status: 201 });
});

type NewUserRole = "USER" | "ISSUE_ADMIN" | "ADMIN";

// Everything about a create request that needs no database: the role and the
// caller's authority over it, the email, the password and the name. Answers
// the first refusal, in this order.
function validateCreateUser(
  body: { email?: unknown; password?: unknown; name?: unknown; role?: unknown },
  callerPerms: bigint,
  t: Translator,
): { role: NewUserRole; email: string; password: string; name: string | null } | NextResponse {
  const refuse = (key: string, vars?: Record<string, string | number>) =>
    NextResponse.json({ error: t(key, vars) }, { status: 400 });
  const role = body.role ?? "USER";
  if (role !== "USER" && role !== "ISSUE_ADMIN" && role !== "ADMIN") return refuse("apiAdmin.users.roleInvalidCreate");
  // MANAGE_USERS delegates creation of NON-admin users only. Creating an ADMIN
  // account requires the caller to be a full admin — otherwise a MANAGE_USERS
  // holder could mint a fresh ADMIN with a password they control and self-escalate.
  // The caller's mask is the effective one (api-auth resolves it).
  if (role === "ADMIN" && !hasPermission(callerPerms, Permission.ADMIN)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminCreate") }, { status: 403 });
  }
  // Subset rule: the role seeds the new account's whole bitmask, so a delegate may
  // only create a role whose preset it holds in full — management bits (ISSUE_ADMIN
  // needs MANAGE_ISSUES) and the baseline REQUEST* bits — else it mints a
  // sock-puppet carrying bits it was never given.
  if (presetExceeds(role, callerPerms)) {
    return NextResponse.json({ error: t("apiAdmin.users.cannotGrantBeyondOwn") }, { status: 403 });
  }

  const email = parseAccountEmail(body.email);
  if (email === null) return refuse("apiAdmin.users.invalidEmail");
  // Summonarr mints addresses in these domains for itself (reserved-email.ts,
  // guardrail 34e). Not even an ADMIN may create one: a local account holding
  // `jellyfin-<id>@jellyfin.local` blocks that Jellyfin user from ever being
  // provisioned, and before 34e it inherited their sign-in.
  if (isReservedEmailDomain(email)) return refuse("apiAdmin.users.reservedEmail");

  const password = body.password;
  if (!password || typeof password !== "string") return refuse("apiAdmin.users.passwordRequired");
  // The same floor as first-admin registration and the profile password
  // change — an admin-created account (the only post-setup path to a local one,
  // ADMIN role included) must not be weaker than what the user could set alone.
  if (password.length < MIN_PASSWORD_LENGTH) return refuse("apiAdmin.users.passwordTooShort");
  if (password.length > MAX_PASSWORD_LENGTH) return refuse("apiAdmin.users.passwordTooLong", { max: MAX_PASSWORD_LENGTH });

  if (body.name !== undefined && body.name !== null && (typeof body.name !== "string" || body.name.trim().length > 100)) {
    return refuse("apiAdmin.users.nameTooLong");
  }
  return { role, email, password, name: sanitizeOptional(typeof body.name === "string" ? body.name : null) };
}
