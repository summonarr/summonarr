import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission, parseAndValidatePermissions, defaultPermissionsForRole, parseInstanceGrants, serializeInstanceGrants } from "@/lib/permissions";
import { isValidContentRatingCap } from "@/lib/content-rating";
import { anonymizeUserInTx, LastAdminError } from "@/lib/anonymize-user";

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
    const targetUser = await prisma.user.findUnique({ where: { id }, select: { permissions: true, role: true, name: true, email: true } });
    if (!targetUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // A non-admin MANAGE_USERS holder must not edit an admin's permissions or grant
    // the ADMIN superbit. The lockstep guards below stop role/bit desync; this stops
    // the escalation at its source (caller authority).
    if (!callerIsAdmin && (targetUser.role === "ADMIN" || (parsed & Permission.ADMIN) !== 0n)) {
      return NextResponse.json({ error: "Only an admin can grant or modify admin access" }, { status: 403 });
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

  const quotaFields = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"] as const;
  const quotaField = quotaFields.find((k) => k in body);
  if (quotaField !== undefined) {
    const val = body[quotaField];
    if (val !== null && val !== undefined && (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 100_000)) {
      return NextResponse.json({ error: `${quotaField} must be a non-negative integer or null` }, { status: 400 });
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

  if ((body.role === "USER" || body.role === "ISSUE_ADMIN") && target.role === "ADMIN") {
    // Advisory lock 42 + atomic row count ensures we never demote the last admin, even under concurrent requests
    const now = new Date().toISOString();
    const newRole = body.role;
    const rowsAffected = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
      return tx.$executeRaw`
        UPDATE "User" SET role = ${newRole}, permissions = ${defaultPermissionsForRole(newRole)}, "updatedAt" = ${now}
        WHERE id = ${id}
        AND role = 'ADMIN'
        AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL) > 1
      `;
    });
    if (rowsAffected === 0) {
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
    }
  } else {
    // Setting a role re-seeds the permission bitmask from the preset (role is a
    // preset selector); fine-tune afterward via the `permissions` field.
    await prisma.user.update({
      where: { id },
      data: {
        role: body.role as "ADMIN" | "ISSUE_ADMIN" | "USER",
        permissions: defaultPermissionsForRole(body.role),
      },
    });
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

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, name: true, email: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A non-admin MANAGE_USERS holder must not delete/deactivate an admin account.
  if (target.role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: "Only an admin can delete an admin account" }, { status: 403 });
  }

  const [requestCount, issueCount, voteCount] = await Promise.all([
    prisma.mediaRequest.count({ where: { requestedBy: id } }),
    prisma.issue.count({ where: { reportedBy: id } }),
    prisma.deletionVote.count({ where: { userId: id } }),
  ]);

  // Admin delete ANONYMIZES rather than hard-deletes, mirroring the self-delete
  // path (/api/profile): a hard delete cascades and destroys the user's
  // requests/issues/votes, whereas anonymization preserves that instance history
  // behind a de-identified row. Both paths share anonymizeUserInTx.
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await anonymizeUserInTx(tx, id, target.role, now);
    });
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json({ error: "Cannot delete the last admin" }, { status: 400 });
    }
    throw err;
  }

  invalidateUserSession(id);

  // Account already anonymized; a failed audit write must not 500 it (guardrail 26
  // — logAudit swallows write failures). History (requests/issues/votes) is
  // preserved on the de-identified row, not cascade-deleted.
  void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_DELETE", target: `user:${id}`, details: { kind: "admin-delete-anonymize", targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, historyPreserved: { mediaRequests: requestCount, issues: issueCount, deletionVotes: voteCount } }, ...auditContext(_req, session) });
  return NextResponse.json({ ok: true });
});
