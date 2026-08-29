import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission, parseAndValidatePermissions, defaultPermissionsForRole, parseInstanceGrants, serializeInstanceGrants, parseMediaServerGrants, serializeMediaServerGrants } from "@/lib/permissions";
import { isValidContentRatingCap } from "@/lib/content-rating";
import { deactivateUserInTx, LastAdminError } from "@/lib/account-lifecycle";

// Thrown by the DELETE tx when the in-transaction role re-read shows the target became
// ADMIN after the pre-tx authority check (guardrail 23: propagate, never swallow in-tx).
class TargetBecameAdminError extends Error {}

// Module-scoped so the self-escalation gate below and the quota branch read the
// SAME list — a second copy would drift and silently reopen the hole.
const QUOTA_FIELDS = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"] as const;

export const PATCH = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const { id } = await params;
  if (!checkRateLimit(`admin-user-edit:${session.user.id}`, 20, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a minute." }, { status: 429 });
  }
  const isSelf = id === session.user.id;

  type NotifKey = "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "emailOnApproved" | "emailOnAvailable" | "emailOnDeclined" | "pushOnApproved" | "pushOnAvailable" | "pushOnDeclined" | "notifyOnIssue";
  const notifKeys: NotifKey[] = ["notifyOnApproved", "notifyOnAvailable", "notifyOnDeclined", "emailOnApproved", "emailOnAvailable", "emailOnDeclined", "pushOnApproved", "pushOnAvailable", "pushOnDeclined", "notifyOnIssue"];

  type UpdateBody = {
    role?: string;
    permissions?: string;
    movieQuotaLimit?: number | null;
    movieQuotaDays?: number | null;
    tvQuotaLimit?: number | null;
    tvQuotaDays?: number | null;
    mediaServer?: string | null;
    maxContentRating?: string | null;
    instanceGrants?: unknown;
    mediaServerGrants?: unknown;
  } & Partial<Record<NotifKey, boolean>>;
  const parsedBody = await readJsonCapped<UpdateBody>(req, 32768);
  if (parsedBody instanceof NextResponse) return parsedBody;
  const body = parsedBody;

  // MANAGE_USERS delegates management of NON-admin users only. Conferring ADMIN,
  // or touching an account that is already ADMIN, requires the caller to be a full
  // admin — otherwise a MANAGE_USERS holder could self-escalate by promoting an
  // accomplice (or themselves via a second account) to ADMIN. session.user.permissions
  // is the effective mask (api-auth resolves it through effectivePermissions).
  const callerIsAdmin = hasPermission(session.user.permissions, Permission.ADMIN);

  // A non-admin MANAGE_USERS delegate must not mutate ANY field of an account
  // that is already ADMIN — not just role/permissions. The role and permissions
  // branches below enforce this individually (and additionally block *granting*
  // ADMIN); this single up-front gate covers the mediaServer, quota, and
  // notification branches too, so a future branch can't silently re-open the
  // hole by forgetting the per-branch check. A missing target falls through to
  // each branch's own 404. Admins skip the extra read entirely.
  if (!callerIsAdmin) {
    const targetForAuth = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (targetForAuth?.role === "ADMIN") {
      return NextResponse.json({ error: "Only an admin can modify an admin account" }, { status: 403 });
    }
  }

  // MANAGE_USERS delegates management of OTHER accounts. The `role` and
  // `permissions` branches each carry their own isSelf gate; these fields are
  // privilege-bearing too and had none, so a delegate could PATCH their OWN
  // row to grant themselves request + auto-approve on a RESTRICTED named instance,
  // visibility into a RESTRICTED Plex/Jellyfin server's library, lift their own
  // quota to an effectively unlimited value, or raise their own content-rating
  // cap. Each branch ends in invalidateUserSession(id), which re-signs the JWT
  // from the DB column, so the self-grant lands on their very next request. Gate
  // them all in one place, mirroring those branches.
  if (!callerIsAdmin && isSelf) {
    const selfPrivilegeEdit =
      "maxContentRating" in body ||
      body.instanceGrants !== undefined ||
      body.mediaServerGrants !== undefined ||
      QUOTA_FIELDS.some((k) => k in body);
    if (selfPrivilegeEdit) {
      return NextResponse.json(
        { error: "Cannot change your own instance access, server visibility, quota, or content rating cap" },
        { status: 403 },
      );
    }
  }

  if ("mediaServer" in body) {
    const ms = body.mediaServer;
    if (ms !== null && ms !== "plex" && ms !== "jellyfin") {
      return NextResponse.json({ error: "mediaServer must be 'plex', 'jellyfin', or null" }, { status: 400 });
    }
    const prevMediaServer = await prisma.user.findUnique({ where: { id }, select: { mediaServer: true } });
    if (!prevMediaServer) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { mediaServer: ms } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: "mediaServer", before: prevMediaServer.mediaServer, after: ms }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, mediaServer: ms });
  }

  if ("maxContentRating" in body) {
    const raw = body.maxContentRating;
    const mcr = raw == null || raw === "" ? null : raw; // empty select ⇒ clear the cap
    if (mcr !== null && !isValidContentRatingCap(mcr)) {
      return NextResponse.json({ error: "maxContentRating must be a valid rating cap or null" }, { status: 400 });
    }
    const prev = await prisma.user.findUnique({ where: { id }, select: { maxContentRating: true } });
    if (!prev) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { maxContentRating: mcr } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: "maxContentRating", before: prev.maxContentRating, after: mcr }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, maxContentRating: mcr });
  }

  if (body.permissions !== undefined) {
    const parsed = parseAndValidatePermissions(body.permissions);
    if (parsed === null) {
      return NextResponse.json({ error: "permissions must be a decimal bitmask within the known permission set" }, { status: 400 });
    }
    // A stored mask of exactly 0 is the "row was never seeded" sentinel:
    // effectivePermissions() maps it back to the ROLE PRESET (permissions.ts).
    // So writing 0 does the opposite of what the editor shows — unchecking the
    // last box would silently restore REQUEST/REQUEST_MOVIE/REQUEST_TV while the
    // modal, the DB column and the audit row all read "no permissions". Refuse it
    // rather than store an unrepresentable intent. Mirrors the quota branch below,
    // which rejects a limit of 0 for exactly this class of footgun.
    if (parsed === 0n) {
      return NextResponse.json(
        {
          error:
            "A mask of 0 means \"unseeded\" and resolves back to the role's default preset, not \"no access\". " +
            "Leave at least one bit set, or disable the account to remove access entirely.",
        },
        { status: 400 },
      );
    }
    const targetUser = await prisma.user.findUnique({ where: { id }, select: { permissions: true, role: true, name: true, email: true } });
    if (!targetUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // A non-admin MANAGE_USERS holder must not edit an admin's permissions or grant
    // the ADMIN superbit. The lockstep guards below stop role/bit desync; this stops
    // the escalation at its source (caller authority).
    if (!callerIsAdmin && (targetUser.role === "ADMIN" || (parsed & Permission.ADMIN) !== 0n)) {
      return NextResponse.json({ error: "Only an admin can grant or modify admin access" }, { status: 403 });
    }

    // MANAGE_USERS delegates managing OTHER accounts. Without this, a delegate could
    // PATCH their own row with any non-ADMIN mask (AUTO_APPROVE, QUOTA_UNLIMITED,
    // MANAGE_REQUESTS, …) — session-refresh re-signs the JWT from the DB column, so the
    // self-grant lands on their very next request. Mirrors the role branch's isSelf gate.
    if (!callerIsAdmin && isSelf) {
      return NextResponse.json({ error: "Cannot change your own permissions" }, { status: 403 });
    }

    // Never let the editor strip the ADMIN bit from a role=ADMIN user — demote the
    // role first (which routes through the last-admin CAS below). Keeps the
    // "never lock out the last admin" invariant on a single code path.
    if (targetUser.role === "ADMIN" && (parsed & Permission.ADMIN) === 0n) {
      return NextResponse.json({ error: "Demote this admin's role before removing the ADMIN permission." }, { status: 400 });
    }

    // Inverse guard: never *grant* the ADMIN superbit to a non-admin-role user. The ADMIN
    // bit short-circuits hasPermission() everywhere, so it must stay in lockstep with
    // role=ADMIN (which the proxy backstop + withAdmin gate on). Promote the role first —
    // that routes through the same last-admin CAS rather than desyncing the bit from role.
    if (targetUser.role !== "ADMIN" && (parsed & Permission.ADMIN) !== 0n) {
      return NextResponse.json({ error: "Promote this user's role to Admin before granting the ADMIN permission." }, { status: 400 });
    }

    try {
      await prisma.user.update({ where: { id }, data: { permissions: parsed } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_PERMISSIONS_CHANGE", target: `user:${id}`, details: { targetUser: targetUser.name ?? targetUser.email, before: targetUser.permissions.toString(), after: parsed.toString() }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, permissions: parsed.toString() });
  }

  // Per-instance grants for NAMED Radarr/Sonarr instances (multi-instance). A JSON
  // map { "<slug>": { request?, autoApprove? } }; the default/"4k" instances are
  // NOT gated here (default is open; 4k uses the REQUEST_4K* bits). Stored on
  // User.instanceGrants and consulted by canRequestInstance/canAutoApproveInstance.
  if (body.instanceGrants !== undefined) {
    if (body.instanceGrants !== null && (typeof body.instanceGrants !== "object" || Array.isArray(body.instanceGrants))) {
      return NextResponse.json({ error: "instanceGrants must be an object map or null" }, { status: 400 });
    }
    const grants = serializeInstanceGrants(parseInstanceGrants(body.instanceGrants));
    const prev = await prisma.user.findUnique({ where: { id }, select: { instanceGrants: true, name: true, email: true } });
    if (!prev) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { instanceGrants: grants } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_PERMISSIONS_CHANGE", target: `user:${id}`, details: { field: "instanceGrants", targetUser: prev.name ?? prev.email, after: grants }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, instanceGrants: grants });
  }

  // Per-server VISIBILITY grants for RESTRICTED Plex/Jellyfin instances. A
  // SERVICE-NAMESPACED JSON map { plex: { "<slug>": { view? } }, jellyfin: {…} }
  // — plex "remote" and jellyfin "remote" are different servers, so this
  // deliberately does NOT reuse instanceGrants' flat shape. Only `restricted`
  // instances are gated (the default "" server is never restricted); stored on
  // User.mediaServerGrants and consulted by canViewMediaInstance.
  //
  // parseMediaServerGrants is the whole validator: it drops unknown service
  // keys, non-object entries and the prototype-pollution keys at BOTH nesting
  // levels, so nothing a client sends can reach the column unfiltered. The
  // array check is separate because Array.isArray(x) && typeof x === "object"
  // is true — a bare `[]` would otherwise serialize to `{}` and silently clear
  // every grant instead of being rejected as malformed.
  if (body.mediaServerGrants !== undefined) {
    if (body.mediaServerGrants !== null && (typeof body.mediaServerGrants !== "object" || Array.isArray(body.mediaServerGrants))) {
      return NextResponse.json({ error: "mediaServerGrants must be an object map or null" }, { status: 400 });
    }
    const grants = serializeMediaServerGrants(parseMediaServerGrants(body.mediaServerGrants));
    const prev = await prisma.user.findUnique({ where: { id }, select: { mediaServerGrants: true, name: true, email: true } });
    if (!prev) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { mediaServerGrants: grants } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_PERMISSIONS_CHANGE", target: `user:${id}`, details: { field: "mediaServerGrants", targetUser: prev.name ?? prev.email, after: grants }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, mediaServerGrants: grants });
  }

  const quotaField = QUOTA_FIELDS.find((k) => k in body);
  if (quotaField !== undefined) {
    const val = body[quotaField];
    if (val !== null && val !== undefined && (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 100_000)) {
      return NextResponse.json({ error: `${quotaField} must be a non-negative integer or null` }, { status: 400 });
    }
    // A per-user LIMIT of 0 is a footgun that does the OPPOSITE of what it reads as.
    // resolveUserQuota() returns `{ limit: 0 }` for it, every enforcement site gates on
    // `limit > 0`, and the override branch returns before the global quota is consulted —
    // so "0" silently means "unlimited AND exempt from the global quota", not "blocked".
    // Reject it rather than guess: to stop someone requesting, clear their REQUEST bits.
    // (0 stays valid for the *Days fields, where it falls back to the 7-day window.)
    if ((quotaField === "movieQuotaLimit" || quotaField === "tvQuotaLimit") && val === 0) {
      return NextResponse.json(
        {
          error:
            `${quotaField} of 0 would mean "unlimited", not "blocked". Leave it empty to use the global quota, set 1 or more for a limit, or clear the user's request permission to stop them requesting.`,
        },
        { status: 400 },
      );
    }
    const nextVal = val ?? null;
    const prevQuota = await prisma.user.findUnique({
      where: { id },
      select: { movieQuotaLimit: true, movieQuotaDays: true, tvQuotaLimit: true, tvQuotaDays: true },
    });
    if (!prevQuota) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { [quotaField]: nextVal } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: quotaField, before: prevQuota[quotaField] ?? null, after: nextVal }, ...auditContext(req, session) });
    invalidateUserSession(id);
    return NextResponse.json({ id, [quotaField]: nextVal });
  }

  const notifKey = notifKeys.find(k => body[k] !== undefined);
  if (notifKey !== undefined) {
    if (typeof body[notifKey] !== "boolean") {
      return NextResponse.json({ error: `${notifKey} must be a boolean` }, { status: 400 });
    }
    const prevNotif = await prisma.user.findUnique({ where: { id }, select: { [notifKey]: true } });
    if (!prevNotif) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { [notifKey]: body[notifKey] } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw err;
    }
    void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "SETTINGS_CHANGE", target: `user:${id}`, details: { field: notifKey, before: prevNotif[notifKey], after: body[notifKey] }, ...auditContext(req, session) });
    return NextResponse.json({ id, [notifKey]: body[notifKey] });
  }

  // If we reached here, none of the typed-field branches (mediaServer/permissions/
  // quota*/notif*) matched. That means the caller either sent {} or only
  // unrecognized keys. Surface that explicitly rather than falling through to the
  // role validator (which would return a misleading "role must be …").
  if (body.role === undefined) {
    return NextResponse.json({ error: "No recognized fields in PATCH body" }, { status: 400 });
  }
  if (isSelf) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }
  if (body.role !== "ADMIN" && body.role !== "USER" && body.role !== "ISSUE_ADMIN") {
    return NextResponse.json({ error: "role must be ADMIN, ISSUE_ADMIN, or USER" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, email: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only a full admin may promote a user TO admin or change an account that is
  // already admin (demotion, re-seed). Without this, a MANAGE_USERS holder could
  // PATCH {role:"ADMIN"} on any account and self-escalate to full control.
  if (!callerIsAdmin && (body.role === "ADMIN" || target.role === "ADMIN")) {
    return NextResponse.json({ error: "Only an admin can grant or modify admin access" }, { status: 403 });
  }

  // The re-read, the caller-authority gate AND the write all run under ONE hold
  // of lock 42. Splitting the re-read into its own committed transaction left a
  // window: a promotion landing between that read and the write made a demotion
  // of the now-last admin route into the bare-update else branch — no lock, no
  // count check — dropping the instance to zero admins, and also slipping past
  // the authority gate. The DELETE handler serializes the same way.
  const demoting = body.role === "USER" || body.role === "ISSUE_ADMIN";
  const now = new Date().toISOString();
  const newRole = body.role as "ADMIN" | "ISSUE_ADMIN" | "USER";
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
    const fresh = await tx.user.findUnique({ where: { id }, select: { role: true } });
    const freshRole = fresh?.role ?? target.role;

    // A target that is (or became, in the old window) ADMIN stays gated on
    // caller authority.
    if (!callerIsAdmin && freshRole === "ADMIN") return { kind: "forbidden" as const };

    if (demoting && freshRole === "ADMIN") {
      // Atomic row count under the lock: never demote the last active admin.
      const rowsAffected = await tx.$executeRaw`
        UPDATE "User" SET role = ${newRole}, permissions = ${defaultPermissionsForRole(newRole)}, "updatedAt" = ${now}
        WHERE id = ${id}
        AND role = 'ADMIN'
        AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL) > 1
      `;
      return rowsAffected === 0 ? { kind: "last-admin" as const } : { kind: "ok" as const };
    }

    // Setting a role re-seeds the permission bitmask from the preset (role is a
    // preset selector); fine-tune afterward via the `permissions` field.
    await tx.user.update({
      where: { id },
      data: { role: newRole, permissions: defaultPermissionsForRole(newRole) },
    });
    return { kind: "ok" as const };
  });
  if (outcome.kind === "forbidden") {
    return NextResponse.json({ error: "Only an admin can grant or modify admin access" }, { status: 403 });
  }
  if (outcome.kind === "last-admin") {
    return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
  }

  invalidateUserSession(id);

  // Role change already committed; a failed audit write must not 500 it (a retry
  // would re-apply and double-audit). logAudit swallows write failures by design.
  void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_ROLE_CHANGE", target: `user:${id}`, details: { targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, after: { role: body.role } }, ...auditContext(req, session) });
  return NextResponse.json({ id, role: body.role });
});

export const DELETE = withPermission(Permission.MANAGE_USERS)(async (
  _req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const { id } = await params;
  if (!checkRateLimit(`admin-user-delete:${session.user.id}`, 5, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a minute." }, { status: 429 });
  }

  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, name: true, email: true, deactivatedAt: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Idempotent, and load-bearing: re-running deactivateUserInTx on an already
  // disabled ADMIN would see its own row excluded from the active-admin count
  // and throw LastAdminError spuriously.
  if (target.deactivatedAt) return NextResponse.json({ ok: true });

  // A non-admin MANAGE_USERS holder must not delete/deactivate an admin account.
  if (target.role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: "Only an admin can delete an admin account" }, { status: 403 });
  }

  const [requestCount, issueCount, voteCount] = await Promise.all([
    prisma.mediaRequest.count({ where: { requestedBy: id } }),
    prisma.issue.count({ where: { reportedBy: id } }),
    prisma.deletionVote.count({ where: { userId: id } }),
  ]);

  // Admin delete DISABLES rather than hard-deletes, mirroring the self-delete
  // path (/api/profile): a hard delete cascades and destroys the user's
  // requests/issues/votes, and even an anonymize-in-place severs the
  // MediaServerUser link so their future watches stop being attributed. Disabling
  // keeps everything and is reversible via the reactivate route; the irreversible
  // scrub is the separate purge route. Both paths share deactivateUserInTx.
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      // The role read above is three DB round-trips stale by the time the tx opens, and
      // deactivateUserInTx only arms the advisory lock + last-admin CAS when the role it is
      // HANDED is ADMIN. A promotion landing in that window would otherwise slip past both
      // that CAS and the caller-authority gate, letting a non-admin MANAGE_USERS holder
      // deactivate the instance's last admin. Re-resolve the role inside the tx, under the
      // same lock 42 the role-change CAS takes, and decide on that value.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
      const fresh = await tx.user.findUnique({ where: { id }, select: { role: true } });
      const freshRole = fresh?.role ?? target.role;
      if (freshRole === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
        throw new TargetBecameAdminError();
      }
      await deactivateUserInTx(tx, id, freshRole, now);
    });
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json({ error: "Cannot disable the last admin" }, { status: 400 });
    }
    if (err instanceof TargetBecameAdminError) {
      return NextResponse.json({ error: "Only an admin can delete an admin account" }, { status: 403 });
    }
    throw err;
  }

  invalidateUserSession(id);

  // Account already disabled; a failed audit write must not 500 it (guardrail 26
  // — logAudit swallows write failures). Everything (requests/issues/votes, the
  // identity itself) is preserved — the account is off, not erased.
  void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_DEACTIVATE", target: `user:${id}`, details: { kind: "admin-disable", targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, historyPreserved: { mediaRequests: requestCount, issues: issueCount, deletionVotes: voteCount } }, ...auditContext(_req, session) });
  return NextResponse.json({ ok: true });
});
