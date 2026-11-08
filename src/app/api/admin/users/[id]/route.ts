import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission, type SummonarrSession } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { invalidateUserSession } from "@/lib/auth";
import { prisma, type PrismaTxClient } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission, parseAndValidatePermissions, defaultPermissionsForRole, presetExceeds, parseInstanceGrants, serializeInstanceGrants, parseMediaServerGrants, serializeMediaServerGrants, type InstanceAccess } from "@/lib/permissions";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { isValidContentRatingCap } from "@/lib/content-rating";
import {
  contentCapBeyondOwn,
  instanceGrantsBeyondOwn,
  isSelfPrivilegeField,
  isUserNotifKey,
  isUserQuotaField,
  mediaServerGrantsBeyondOwn,
  presentUserPatchFields,
  storedQuotaValue,
  type UserNotifKey,
  type UserPatchField,
  type UserQuotaField,
} from "@/lib/admin-user-fields";
import {
  deactivateUserInTx,
  isAdminTarget,
  LastAdminError,
  lockTargetInTx,
  lockUserRolesInTx,
  TargetBecameAdminError,
  TargetGoneError,
} from "@/lib/account-lifecycle";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// PATCH edits ONE field per request: a body naming two is refused rather than
// applying the first and silently dropping the rest. The delegate SUBSET rule
// (what a non-ADMIN MANAGE_USERS holder may hand out) lives in
// admin-user-fields.ts.

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
} & Partial<Record<UserNotifKey, boolean>>;

type CallerOwn = { instanceGrants: unknown; mediaServerGrants: unknown; maxContentRating: string | null } | null;

interface EditContext {
  req: Request;
  t: Translator;
  session: SummonarrSession;
  id: string;
  isSelf: boolean;
  callerIsAdmin: boolean;
  /** The caller's own grants/cap, read only when a non-admin hands one out. */
  callerOwn: CallerOwn;
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status });
const notFound = (t: Translator) => json({ error: t("apiAdmin.common.notFound") }, 404);
const beyondOwn = (t: Translator) => json({ error: t("apiAdmin.users.cannotGrantBeyondOwn") }, 403);

export const PATCH = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  if (!checkRateLimit(`admin-user-edit:${session.user.id}`, 20, 60 * 1000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyAttempts"));
  }
  const parsedBody = await readJsonCapped<UpdateBody>(req, 32768);
  if (parsedBody instanceof NextResponse) return parsedBody;
  const body = parsedBody;

  const fields = presentUserPatchFields(body);
  if (fields.length > 1) {
    return json({ error: t("apiAdmin.users.oneFieldPerRequest", { fields: fields.join(", ") }) }, 400);
  }
  const field: UserPatchField | undefined = fields[0];
  const isSelf = id === session.user.id;

  // MANAGE_USERS delegates management of NON-admin users only. Conferring ADMIN,
  // or touching an account that is already ADMIN, requires the caller to be a full
  // admin — otherwise a MANAGE_USERS holder could self-escalate by promoting an
  // accomplice (or themselves via a second account) to ADMIN. session.user.permissions
  // is the effective mask (api-auth resolves it through effectivePermissions).
  const callerIsAdmin = hasPermission(session.user.permissions, Permission.ADMIN);

  // A non-admin MANAGE_USERS delegate must not mutate ANY field of an account
  // that is already ADMIN (by role or by the ADMIN bit — isAdminTarget, the
  // rule the in-transaction re-checks apply). The role and permissions handlers
  // below enforce this individually (and additionally block *granting* ADMIN);
  // this single up-front gate covers the mediaServer, quota, and notification
  // fields too, so a future field can't silently re-open the hole by forgetting
  // the per-field check. A missing target falls through to each handler's own
  // 404. Admins skip the extra read entirely.
  if (!callerIsAdmin) {
    const targetForAuth = await prisma.user.findUnique({ where: { id }, select: { role: true, permissions: true } });
    if (isAdminTarget(targetForAuth)) {
      return json({ error: t("apiAdmin.users.onlyAdminModify") }, 403);
    }
  }

  // MANAGE_USERS delegates management of OTHER accounts. The `role` and
  // `permissions` handlers each carry their own isSelf gate; these fields grant
  // privileges too. Without this gate a delegate could PATCH their OWN row to
  // grant themselves access to a RESTRICTED named instance, visibility into a
  // RESTRICTED Plex/Jellyfin server's library, an effectively unlimited quota,
  // or a higher content-rating cap. Each commit ends in invalidateUserSession(id),
  // which re-signs the JWT from the DB, so such a self-grant would take effect on
  // their very next request.
  //
  // This self gate alone does NOT close the hole: the target of a sock-puppet or
  // accomplice edit is not "self". The SUBSET rule (admin-user-fields.ts, applied
  // in the permissions / maxContentRating / instanceGrants / mediaServerGrants
  // handlers) is what bounds a delegate to handing out only what it holds. Quota
  // stays delegate-editable on other accounts by design — it is a per-user limit
  // the Users page exists to tune, and QUOTA_UNLIMITED (the bit) is subset-checked.
  if (!callerIsAdmin && isSelf && field !== undefined && isSelfPrivilegeField(field)) {
    return json({ error: t("apiAdmin.users.cannotChangeOwnLimits") }, 403);
  }

  const handsOutGrant = field === "maxContentRating" || field === "instanceGrants" || field === "mediaServerGrants";
  const callerOwn: CallerOwn = !callerIsAdmin && handsOutGrant
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { instanceGrants: true, mediaServerGrants: true, maxContentRating: true } })
    : null;

  const ctx: EditContext = { req, t, session, id, isSelf, callerIsAdmin, callerOwn };
  // None of the recognised fields: the caller sent {} or only unknown keys.
  // Answered explicitly rather than falling through to the role validator
  // (which would return a misleading "role must be …").
  if (field === undefined) return json({ error: t("apiAdmin.users.noRecognizedFields") }, 400);
  if (field === "mediaServer") return editMediaServer(ctx, body.mediaServer);
  if (field === "maxContentRating") return editContentCap(ctx, body.maxContentRating);
  if (field === "permissions") return editPermissions(ctx, body.permissions);
  if (field === "instanceGrants") return editInstanceGrants(ctx, body.instanceGrants);
  if (field === "mediaServerGrants") return editMediaServerGrants(ctx, body.mediaServerGrants);
  if (isUserQuotaField(field)) return editQuota(ctx, field, body[field]);
  if (isUserNotifKey(field)) return editNotif(ctx, field, body[field]);
  return editRole(ctx, body.role);
});

// The shared tail of every single-field edit: the write (a row deleted since
// the handler read it is a 404, not an unhandled P2025), the audit AFTER the
// commit (guardrail 26), the session re-sign when the field rides the JWT, and
// the `{ id, <field> }` answer the native client and OpenAPI pin. Each handler
// runs its own validation, subset and self/admin gates first.
async function commitField(
  { req, t, session, id, callerIsAdmin }: EditContext,
  write: (db: Pick<PrismaTxClient, "user">) => Promise<unknown>,
  audit: { action: "SETTINGS_CHANGE" | "USER_PERMISSIONS_CHANGE"; details: Record<string, unknown> },
  response: Record<string, unknown>,
  { invalidate = true }: { invalidate?: boolean } = {},
): Promise<NextResponse> {
  try {
    if (callerIsAdmin) {
      await write(prisma);
    } else {
      // A delegate's write re-reads the target under lock 42 first: a promotion
      // to ADMIN that landed after the route's unlocked read must not be edited.
      await prisma.$transaction(async (tx) => {
        if (!(await lockTargetInTx(tx, id, false))) throw new TargetGoneError();
        await write(tx);
      });
    }
  } catch (err) {
    if (err instanceof TargetBecameAdminError) return json({ error: t("apiAdmin.users.onlyAdminModify") }, 403);
    if (err instanceof TargetGoneError || isPrismaErrorCode(err, "P2025")) return notFound(t);
    throw err;
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: audit.action,
    target: `user:${id}`,
    details: audit.details,
    ...auditContext(req, session),
  });
  if (invalidate) invalidateUserSession(id);
  return NextResponse.json({ id, ...response });
}

// The target is named by id (+ display name), never by email — on the
// permission and grant rows below (audit-scrub.ts).
const targetDetails = (id: string, name: string | null) => ({ targetUserId: id, ...(name ? { targetUser: name } : {}) });

async function editMediaServer(ctx: EditContext, ms: string | null | undefined): Promise<NextResponse> {
  const { t, id } = ctx;
  if (ms !== null && ms !== "plex" && ms !== "jellyfin") {
    return json({ error: t("apiAdmin.users.mediaServerInvalid") }, 400);
  }
  const prev = await prisma.user.findUnique({ where: { id }, select: { mediaServer: true } });
  if (!prev) return notFound(t);
  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { mediaServer: ms } }),
    { action: "SETTINGS_CHANGE", details: { field: "mediaServer", before: prev.mediaServer, after: ms } },
    { mediaServer: ms },
  );
}

async function editContentCap(ctx: EditContext, raw: string | null | undefined): Promise<NextResponse> {
  const { t, id, callerIsAdmin, callerOwn } = ctx;
  const mcr = raw == null || raw === "" ? null : raw; // empty select ⇒ clear the cap
  if (mcr !== null && !isValidContentRatingCap(mcr)) {
    return json({ error: t("apiAdmin.users.maxContentRatingInvalid") }, 400);
  }
  if (!callerIsAdmin && contentCapBeyondOwn(mcr, callerOwn?.maxContentRating ?? null)) return beyondOwn(t);
  const prev = await prisma.user.findUnique({ where: { id }, select: { maxContentRating: true } });
  if (!prev) return notFound(t);
  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { maxContentRating: mcr } }),
    { action: "SETTINGS_CHANGE", details: { field: "maxContentRating", before: prev.maxContentRating, after: mcr } },
    { maxContentRating: mcr },
  );
}

async function editPermissions(ctx: EditContext, raw: string | undefined): Promise<NextResponse> {
  const { t, id, session, isSelf, callerIsAdmin } = ctx;
  const parsed = parseAndValidatePermissions(raw);
  if (parsed === null) {
    return json({ error: t("apiAdmin.users.permissionsInvalid") }, 400);
  }
  // A stored mask of exactly 0 is the "row was never seeded" sentinel:
  // effectivePermissions() maps it back to the ROLE PRESET (permissions.ts).
  // So writing 0 does the opposite of what the editor shows — unchecking the
  // last box would silently restore REQUEST/REQUEST_MOVIE/REQUEST_TV while the
  // modal, the DB column and the audit row all read "no permissions". Refuse it
  // rather than store an unrepresentable intent. Mirrors the quota handler,
  // which rejects a limit of 0 for exactly this class of footgun.
  if (parsed === 0n) {
    return json({ error: t("apiAdmin.users.permissionsZero") }, 400);
  }
  const targetUser = await prisma.user.findUnique({ where: { id }, select: { permissions: true, role: true, name: true } });
  if (!targetUser) return notFound(t);

  // A non-admin MANAGE_USERS holder must not edit an admin's permissions or grant
  // the ADMIN superbit. The lockstep guards below stop role/bit desync; this stops
  // the escalation at its source (caller authority).
  if (!callerIsAdmin && (targetUser.role === "ADMIN" || (parsed & Permission.ADMIN) !== 0n)) {
    return json({ error: t("apiAdmin.users.onlyAdminGrantAdmin") }, 403);
  }

  // MANAGE_USERS delegates managing OTHER accounts. Without this, a delegate could
  // PATCH their own row with any non-ADMIN mask (AUTO_APPROVE, QUOTA_UNLIMITED,
  // MANAGE_REQUESTS, …) — session-refresh re-signs the JWT from the DB column, so the
  // self-grant lands on their very next request. Mirrors the role handler's isSelf gate.
  if (!callerIsAdmin && isSelf) {
    return json({ error: t("apiAdmin.users.cannotChangeOwnPermissions") }, 403);
  }

  // Subset rule: a delegate may grant only bits it holds itself (effective mask).
  if (!callerIsAdmin && (parsed & ~session.user.permissions) !== 0n) return beyondOwn(t);

  // Never let the editor strip the ADMIN bit from a role=ADMIN user — demote the
  // role first (which routes through the last-admin CAS in editRole). Keeps the
  // "never lock out the last admin" invariant on a single code path.
  if (targetUser.role === "ADMIN" && (parsed & Permission.ADMIN) === 0n) {
    return json({ error: t("apiAdmin.users.demoteBeforeRemovingAdmin") }, 400);
  }

  // Inverse guard: never *grant* the ADMIN superbit to a non-admin-role user. The ADMIN
  // bit short-circuits hasPermission() everywhere, so it must stay in lockstep with
  // role=ADMIN (which the proxy backstop + withAdmin gate on). Promote the role first —
  // that routes through the same last-admin CAS rather than desyncing the bit from role.
  if (targetUser.role !== "ADMIN" && (parsed & Permission.ADMIN) !== 0n) {
    return json({ error: t("apiAdmin.users.promoteBeforeGrantingAdmin") }, 400);
  }

  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { permissions: parsed } }),
    { action: "USER_PERMISSIONS_CHANGE", details: { ...targetDetails(id, targetUser.name), before: targetUser.permissions.toString(), after: parsed.toString() } },
    { permissions: parsed.toString() },
  );
}

// Per-instance grants for NAMED Radarr/Sonarr instances (multi-instance). A JSON
// map { "<slug>": { request?, autoApprove? } }; the default/"4k" instances are
// NOT gated here (default is open; 4k uses the REQUEST_4K* bits). Stored on
// User.instanceGrants and consulted by canRequestInstance/canAutoApproveInstance.
async function editInstanceGrants(ctx: EditContext, raw: unknown): Promise<NextResponse> {
  const { t, id, session, callerIsAdmin, callerOwn } = ctx;
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return json({ error: t("apiAdmin.users.instanceGrantsInvalid") }, 400);
  }
  const parsedGrants = parseInstanceGrants(raw);
  if (!callerIsAdmin) {
    const [radarr, sonarr] = await Promise.all([getArrInstances("radarr"), getArrInstances("sonarr")]);
    const registry = new Map<string, InstanceAccess[]>();
    for (const cfg of [...radarr, ...sonarr]) registry.set(cfg.slug, [...(registry.get(cfg.slug) ?? []), cfg]);
    if (instanceGrantsBeyondOwn(parsedGrants, session.user.permissions, parseInstanceGrants(callerOwn?.instanceGrants), registry)) {
      return beyondOwn(t);
    }
  }
  const grants = serializeInstanceGrants(parsedGrants);
  const prev = await prisma.user.findUnique({ where: { id }, select: { instanceGrants: true, name: true } });
  if (!prev) return notFound(t);
  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { instanceGrants: grants } }),
    // `before` too, so the trail shows which grants a change removed.
    { action: "USER_PERMISSIONS_CHANGE", details: { field: "instanceGrants", ...targetDetails(id, prev.name), before: prev.instanceGrants, after: grants } },
    { instanceGrants: grants },
  );
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
async function editMediaServerGrants(ctx: EditContext, raw: unknown): Promise<NextResponse> {
  const { t, id, session, callerIsAdmin, callerOwn } = ctx;
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return json({ error: t("apiAdmin.users.mediaServerGrantsInvalid") }, 400);
  }
  const parsedGrants = parseMediaServerGrants(raw);
  if (!callerIsAdmin) {
    const [plex, jellyfin] = await Promise.all([getMediaInstances("plex"), getMediaInstances("jellyfin")]);
    const registry = {
      plex: new Map(plex.map((cfg) => [cfg.slug as string, cfg])),
      jellyfin: new Map(jellyfin.map((cfg) => [cfg.slug as string, cfg])),
    };
    if (mediaServerGrantsBeyondOwn(parsedGrants, session.user.permissions, parseMediaServerGrants(callerOwn?.mediaServerGrants), registry)) {
      return beyondOwn(t);
    }
  }
  const grants = serializeMediaServerGrants(parsedGrants);
  const prev = await prisma.user.findUnique({ where: { id }, select: { mediaServerGrants: true, name: true } });
  if (!prev) return notFound(t);
  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { mediaServerGrants: grants } }),
    { action: "USER_PERMISSIONS_CHANGE", details: { field: "mediaServerGrants", ...targetDetails(id, prev.name), before: prev.mediaServerGrants, after: grants } },
    { mediaServerGrants: grants },
  );
}

async function editQuota(ctx: EditContext, quotaField: UserQuotaField, val: unknown): Promise<NextResponse> {
  const { t, id } = ctx;
  if (val !== null && val !== undefined && (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 100_000)) {
    return json({ error: t("apiAdmin.users.quotaInvalid", { field: quotaField }) }, 400);
  }
  // A per-user LIMIT of 0 is a footgun that does the OPPOSITE of what it reads as.
  // resolveUserQuota() returns `{ limit: 0 }` for it, every enforcement site gates on
  // `limit > 0`, and the override branch returns before the global quota is consulted —
  // so "0" silently means "unlimited AND exempt from the global quota", not "blocked".
  // Reject it rather than guess: to stop someone requesting, clear their REQUEST bits.
  // (0 days is accepted and stored as "no value": both mean the 7-day window.)
  if ((quotaField === "movieQuotaLimit" || quotaField === "tvQuotaLimit") && val === 0) {
    return json({ error: t("apiAdmin.users.quotaZero", { field: quotaField }) }, 400);
  }
  const nextVal = storedQuotaValue(quotaField, typeof val === "number" ? val : null);
  const prev = await prisma.user.findUnique({
    where: { id },
    select: { movieQuotaLimit: true, movieQuotaDays: true, tvQuotaLimit: true, tvQuotaDays: true },
  });
  if (!prev) return notFound(t);
  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { [quotaField]: nextVal } }),
    { action: "SETTINGS_CHANGE", details: { field: quotaField, before: prev[quotaField] ?? null, after: nextVal } },
    { [quotaField]: nextVal },
  );
}

async function editNotif(ctx: EditContext, notifKey: UserNotifKey, value: unknown): Promise<NextResponse> {
  const { t, id } = ctx;
  if (typeof value !== "boolean") {
    return json({ error: t("apiAdmin.users.notifBoolean", { field: notifKey }) }, 400);
  }
  const prev = await prisma.user.findUnique({ where: { id }, select: { [notifKey]: true } });
  if (!prev) return notFound(t);
  // Notification preferences don't ride the session token: no re-sign.
  return commitField(
    ctx,
    (db) => db.user.update({ where: { id }, data: { [notifKey]: value } }),
    { action: "SETTINGS_CHANGE", details: { field: notifKey, before: prev[notifKey], after: value } },
    { [notifKey]: value },
    { invalidate: false },
  );
}

type RoleOutcome = { kind: "ok" } | { kind: "not-found" } | { kind: "forbidden" } | { kind: "last-admin" };

async function editRole(ctx: EditContext, role: string | undefined): Promise<NextResponse> {
  const { req, t, session, id, isSelf, callerIsAdmin } = ctx;
  if (isSelf) {
    return json({ error: t("apiAdmin.users.cannotChangeOwnRole") }, 400);
  }
  if (role !== "ADMIN" && role !== "USER" && role !== "ISSUE_ADMIN") {
    return json({ error: t("apiAdmin.users.roleInvalid") }, 400);
  }

  // Subset rule (same as the permissions handler and account creation): setting a
  // role re-seeds the target's WHOLE bitmask from the role's preset, baseline
  // REQUEST* bits included. So a delegate may only pick a role whose preset it
  // holds in full — management bits (ISSUE_ADMIN needs MANAGE_ISSUES) AND the
  // request bits. Checking management bits alone let a delegate without, say,
  // REQUEST_TV "re-set" a user an admin had restricted to movies back to USER and
  // hand them TV requests (a same-role PATCH is accepted and re-seeds too).
  if (presetExceeds(role, session.user.permissions)) return beyondOwn(t);

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, email: true } });
  if (!target) return notFound(t);

  // Only a full admin may promote a user TO admin or change an account that is
  // already admin (demotion, re-seed). Without this, a MANAGE_USERS holder could
  // PATCH {role:"ADMIN"} on any account and self-escalate to full control.
  if (!callerIsAdmin && (role === "ADMIN" || target.role === "ADMIN")) {
    return json({ error: t("apiAdmin.users.onlyAdminGrantAdmin") }, 403);
  }

  const outcome = await changeRoleInTx(id, role, callerIsAdmin);
  if (outcome.kind === "not-found") return notFound(t);
  if (outcome.kind === "forbidden") return json({ error: t("apiAdmin.users.onlyAdminGrantAdmin") }, 403);
  if (outcome.kind === "last-admin") return json({ error: t("apiAdmin.users.cannotDemoteLastAdmin") }, 400);

  invalidateUserSession(id);

  // Role change already committed; a failed audit write must not 500 it (a retry
  // would re-apply and double-audit). logAudit swallows write failures by design.
  // The target is named by id (+ display name), never by email.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "USER_ROLE_CHANGE",
    target: `user:${id}`,
    details: { ...targetDetails(id, target.name), before: { role: target.role }, after: { role } },
    ...auditContext(req, session),
  });
  return NextResponse.json({ id, role });
}

// The re-read, the caller-authority gate AND the write all run inside ONE
// transaction holding advisory lock 42 (a Postgres lock that makes these role
// changes run one at a time). Doing the re-read outside it would leave a gap: a
// promotion landing between the read and the write could let the last admin be
// demoted without the count check, leaving zero admins. The DELETE handler
// serializes the same way.
async function changeRoleInTx(id: string, newRole: "ADMIN" | "ISSUE_ADMIN" | "USER", callerIsAdmin: boolean): Promise<RoleOutcome> {
  const demoting = newRole === "USER" || newRole === "ISSUE_ADMIN";
  const now = new Date().toISOString();
  return prisma.$transaction(async (tx) => {
    await lockUserRolesInTx(tx);
    const fresh = await tx.user.findUnique({ where: { id }, select: { role: true } });
    // Gone since the read above (a Discord merge hard-deletes its shadow row):
    // nothing to change. Falling back to the stale role turned this into an
    // uncaught P2025 (500) or a false "last admin".
    if (!fresh) return { kind: "not-found" as const };
    const freshRole = fresh.role;

    // A target that is ADMIN now (even if it was promoted after our first read)
    // still needs a full-admin caller.
    if (!callerIsAdmin && freshRole === "ADMIN") return { kind: "forbidden" as const };

    if (demoting && freshRole === "ADMIN") {
      // Atomic row count under the lock: never demote the last active admin.
      // A DISABLED admin is already outside that count, so demoting it can never
      // reduce the active-admin total — without the first disjunct it was refused
      // as "the last admin" whenever exactly one OTHER active admin existed.
      const rowsAffected = await tx.$executeRaw`
        UPDATE "User" SET role = ${newRole}, permissions = ${defaultPermissionsForRole(newRole)}, "updatedAt" = ${now}
        WHERE id = ${id}
        AND role = 'ADMIN'
        AND ("deactivatedAt" IS NOT NULL
             OR (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL) > 1)
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
}

// What the disabled account keeps: recorded in its audit row.
async function preservedHistoryCounts(id: string) {
  const [mediaRequests, issues, deletionVotes] = await Promise.all([
    prisma.mediaRequest.count({ where: { requestedBy: id } }),
    prisma.issue.count({ where: { reportedBy: id } }),
    prisma.deletionVote.count({ where: { userId: id } }),
  ]);
  return { mediaRequests, issues, deletionVotes };
}

// Admin delete DISABLES rather than hard-deletes, mirroring the self-delete
// path (/api/profile): a hard delete cascades and destroys the user's
// requests/issues/votes, and even an anonymize-in-place severs the
// MediaServerUser link so their future watches stop being attributed. Disabling
// keeps everything and is reversible via the reactivate route; the irreversible
// scrub is the separate purge route. Both paths share deactivateUserInTx.
export const DELETE = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  if (!checkRateLimit(`admin-user-delete:${session.user.id}`, 5, 60 * 1000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyAttempts"));
  }

  if (id === session.user.id) {
    return json({ error: t("apiAdmin.users.cannotDeleteSelf") }, 400);
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, permissions: true, name: true, email: true, deactivatedAt: true } });
  if (!target) return notFound(t);
  // Idempotent, and load-bearing: re-running deactivateUserInTx on an already
  // disabled ADMIN would see its own row excluded from the active-admin count
  // and throw LastAdminError spuriously. Re-checked under the lock below.
  if (target.deactivatedAt) return NextResponse.json({ ok: true });

  // A non-admin MANAGE_USERS holder must not delete/deactivate an admin account.
  // This early answer spares the counts below; the transaction re-decides it.
  const callerIsAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
  if (isAdminTarget(target) && !callerIsAdmin) {
    return json({ error: t("apiAdmin.users.onlyAdminDelete") }, 403);
  }

  const historyPreserved = await preservedHistoryCounts(id);

  let outcome: "disabled" | "already";
  try {
    outcome = await deactivateInTx(id, callerIsAdmin);
  } catch (err) {
    if (err instanceof LastAdminError) return json({ error: t("apiAdmin.users.cannotDisableLastAdmin") }, 400);
    if (err instanceof TargetBecameAdminError) return json({ error: t("apiAdmin.users.onlyAdminDelete") }, 403);
    if (err instanceof TargetGoneError) return notFound(t);
    throw err;
  }
  // The other request disabled it and wrote its own audit row; this one changed nothing.
  if (outcome === "already") return NextResponse.json({ ok: true });

  invalidateUserSession(id);

  // Account already disabled; a failed audit write must not 500 it (guardrail 26
  // — logAudit swallows write failures). Everything (requests/issues/votes, the
  // identity itself) is preserved — the account is off, not erased.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "USER_DEACTIVATE",
    target: `user:${id}`,
    details: {
      kind: "admin-disable",
      ...targetDetails(id, target.name),
      before: { role: target.role },
      historyPreserved,
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});

// The role read in DELETE is several DB round-trips stale by the time the tx
// opens, and deactivateUserInTx only arms the advisory lock + last-admin CAS
// when the role it is HANDED is ADMIN. A promotion landing in that window would
// otherwise slip past both that CAS and the caller-authority gate, letting a
// non-admin MANAGE_USERS holder deactivate the instance's last admin. So the
// row is re-resolved inside the tx, under the same lock 42 the role-change CAS
// takes, and decided on that value.
function deactivateInTx(id: string, callerIsAdmin: boolean): Promise<"disabled" | "already"> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const fresh = await lockTargetInTx(tx, id, callerIsAdmin);
    if (!fresh) throw new TargetGoneError();
    // A concurrent disable (a double submit, the user's own self-delete) committed
    // after the first read. Re-running the deactivate would miss its own row in
    // the active-admin count and report a false "last admin" (guardrail 33).
    if (fresh.deactivatedAt) return "already" as const;
    await deactivateUserInTx(tx, id, fresh.role, now);
    return "disabled" as const;
  });
}
