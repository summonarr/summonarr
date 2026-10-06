import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission, parseAndValidatePermissions, defaultPermissionsForRole, parseInstanceGrants, serializeInstanceGrants, parseMediaServerGrants, serializeMediaServerGrants, canRequestInstance, canAutoApproveInstance, canViewMediaInstance } from "@/lib/permissions";
import type { InstanceGrants, MediaServerGrants } from "@/lib/permissions";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { isValidContentRatingCap, exceedsCap } from "@/lib/content-rating";
import { deactivateUserInTx, LastAdminError } from "@/lib/account-lifecycle";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Thrown by the DELETE tx when the in-transaction role re-read shows the target became
// ADMIN after the pre-tx authority check (guardrail 23: propagate, never swallow in-tx).
class TargetBecameAdminError extends Error {}

// Module-scoped so the self-escalation gate below and the quota branch read the
// SAME list — a second copy would drift and silently reopen the hole.
const QUOTA_FIELDS = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"] as const;

// ── Delegate SUBSET rule (non-ADMIN caller) ──────────────────────────────────
// A MANAGE_USERS holder may hand out only what it holds itself. The isSelf gates
// in PATCH stop a delegate editing its OWN privileges, but a delegate can mint a
// sock-puppet (POST /api/admin/users — it knows the password) or pick an
// accomplice, and the target is then not "self": without these checks it could
// grant that account every non-ADMIN bit (MANAGE_REQUESTS, AUTO_APPROVE,
// QUOTA_UNLIMITED, REQUEST_4K, REQUEST_ON_BEHALF, …), access to a RESTRICTED
// named arr instance, visibility into a RESTRICTED Plex/Jellyfin server, or a
// looser content cap, and sign in as it — the self-grant gate defeated in two
// requests. Each helper answers "does the proposed value exceed the caller's
// own?"; the branches 403 with cannotGrantBeyondOwn when it does. ADMIN callers
// never reach them.

// An unregistered slug is judged as a RESTRICTED instance with no serverAll:
// the grant is dormant today but goes live the moment an admin registers that
// slug as restricted, so a delegate must already hold it. Radarr and Sonarr
// share instanceGrants' flat slug namespace, so a slug registered on both must
// be held on both.
function instanceGrantsBeyondOwn(
  proposed: InstanceGrants,
  callerPerms: bigint,
  callerGrants: InstanceGrants,
  registry: ReadonlyMap<string, { slug: string; restricted: boolean; serverAll: boolean }[]>,
): boolean {
  for (const [slug, g] of Object.entries(proposed)) {
    if (!g.request && !g.autoApprove) continue; // a no-op entry grants nothing
    const configs = registry.get(slug) ?? [{ slug, restricted: true, serverAll: false }];
    for (const cfg of configs) {
      if (g.request && !(canRequestInstance(callerPerms, cfg, callerGrants, "MOVIE") || canRequestInstance(callerPerms, cfg, callerGrants, "TV"))) return true;
      if (g.autoApprove && !(canAutoApproveInstance(callerPerms, cfg, callerGrants, "MOVIE") || canAutoApproveInstance(callerPerms, cfg, callerGrants, "TV"))) return true;
    }
  }
  return false;
}

function mediaServerGrantsBeyondOwn(
  proposed: MediaServerGrants,
  callerPerms: bigint,
  callerGrants: MediaServerGrants,
  registry: { plex: ReadonlyMap<string, { slug: string; restricted: boolean }>; jellyfin: ReadonlyMap<string, { slug: string; restricted: boolean }> },
): boolean {
  for (const service of ["plex", "jellyfin"] as const) {
    for (const [slug, g] of Object.entries(proposed[service] ?? {})) {
      if (!g.view) continue;
      const cfg = registry[service].get(slug) ?? { slug, restricted: true };
      if (!canViewMediaInstance(callerPerms, cfg, callerGrants, service)) return true;
    }
  }
  return false;
}

// `null` (no cap) is the loosest value: a capped caller may not clear a cap, and
// may not set one more mature than its own. An uncapped caller may set anything.
function contentCapBeyondOwn(proposed: string | null, callerCap: string | null): boolean {
  if (callerCap === null) return false;
  if (proposed === null) return true;
  return exceedsCap(proposed, callerCap);
}

export const PATCH = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  if (!checkRateLimit(`admin-user-edit:${session.user.id}`, 20, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyAttempts") }, { status: 429 });
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
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminModify") }, { status: 403 });
    }
  }

  // MANAGE_USERS delegates management of OTHER accounts. The `role` and
  // `permissions` branches each carry their own isSelf gate; these fields grant
  // privileges too. Without this gate a delegate could PATCH their OWN row to
  // grant themselves access to a RESTRICTED named instance, visibility into a
  // RESTRICTED Plex/Jellyfin server's library, an effectively unlimited quota,
  // or a higher content-rating cap. Each branch ends in invalidateUserSession(id),
  // which re-signs the JWT from the DB, so such a self-grant would take effect on
  // their very next request.
  //
  // This self gate alone does NOT close the hole: the target of a sock-puppet or
  // accomplice edit is not "self". The SUBSET rule (helpers above, applied in the
  // permissions / maxContentRating / instanceGrants / mediaServerGrants branches)
  // is what bounds a delegate to handing out only what it holds. Quota stays
  // delegate-editable on other accounts by design — it is a per-user limit the
  // Users page exists to tune, and QUOTA_UNLIMITED (the bit) is subset-checked.
  if (!callerIsAdmin && isSelf) {
    const selfPrivilegeEdit =
      "maxContentRating" in body ||
      body.instanceGrants !== undefined ||
      body.mediaServerGrants !== undefined ||
      QUOTA_FIELDS.some((k) => k in body);
    if (selfPrivilegeEdit) {
      return NextResponse.json(
        { error: t("apiAdmin.users.cannotChangeOwnLimits") },
        { status: 403 },
      );
    }
  }

  // The caller's OWN grants/cap, read once, only when a non-admin is about to
  // hand one out (session.user.permissions already carries the effective mask).
  const callerOwn =
    !callerIsAdmin && ("maxContentRating" in body || body.instanceGrants !== undefined || body.mediaServerGrants !== undefined)
      ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { instanceGrants: true, mediaServerGrants: true, maxContentRating: true } })
      : null;

  if ("mediaServer" in body) {
    const ms = body.mediaServer;
    if (ms !== null && ms !== "plex" && ms !== "jellyfin") {
      return NextResponse.json({ error: t("apiAdmin.users.mediaServerInvalid") }, { status: 400 });
    }
    const prevMediaServer = await prisma.user.findUnique({ where: { id }, select: { mediaServer: true } });
    if (!prevMediaServer) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { mediaServer: ms } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiAdmin.users.maxContentRatingInvalid") }, { status: 400 });
    }
    if (!callerIsAdmin && contentCapBeyondOwn(mcr, callerOwn?.maxContentRating ?? null)) {
      return NextResponse.json({ error: t("apiAdmin.users.cannotGrantBeyondOwn") }, { status: 403 });
    }
    const prev = await prisma.user.findUnique({ where: { id }, select: { maxContentRating: true } });
    if (!prev) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { maxContentRating: mcr } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiAdmin.users.permissionsInvalid") }, { status: 400 });
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
          error: t("apiAdmin.users.permissionsZero"),
        },
        { status: 400 },
      );
    }
    const targetUser = await prisma.user.findUnique({ where: { id }, select: { permissions: true, role: true, name: true, email: true } });
    if (!targetUser) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });

    // A non-admin MANAGE_USERS holder must not edit an admin's permissions or grant
    // the ADMIN superbit. The lockstep guards below stop role/bit desync; this stops
    // the escalation at its source (caller authority).
    if (!callerIsAdmin && (targetUser.role === "ADMIN" || (parsed & Permission.ADMIN) !== 0n)) {
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminGrantAdmin") }, { status: 403 });
    }

    // MANAGE_USERS delegates managing OTHER accounts. Without this, a delegate could
    // PATCH their own row with any non-ADMIN mask (AUTO_APPROVE, QUOTA_UNLIMITED,
    // MANAGE_REQUESTS, …) — session-refresh re-signs the JWT from the DB column, so the
    // self-grant lands on their very next request. Mirrors the role branch's isSelf gate.
    if (!callerIsAdmin && isSelf) {
      return NextResponse.json({ error: t("apiAdmin.users.cannotChangeOwnPermissions") }, { status: 403 });
    }

    // Subset rule: a delegate may grant only bits it holds itself (effective mask).
    if (!callerIsAdmin && (parsed & ~session.user.permissions) !== 0n) {
      return NextResponse.json({ error: t("apiAdmin.users.cannotGrantBeyondOwn") }, { status: 403 });
    }

    // Never let the editor strip the ADMIN bit from a role=ADMIN user — demote the
    // role first (which routes through the last-admin CAS below). Keeps the
    // "never lock out the last admin" invariant on a single code path.
    if (targetUser.role === "ADMIN" && (parsed & Permission.ADMIN) === 0n) {
      return NextResponse.json({ error: t("apiAdmin.users.demoteBeforeRemovingAdmin") }, { status: 400 });
    }

    // Inverse guard: never *grant* the ADMIN superbit to a non-admin-role user. The ADMIN
    // bit short-circuits hasPermission() everywhere, so it must stay in lockstep with
    // role=ADMIN (which the proxy backstop + withAdmin gate on). Promote the role first —
    // that routes through the same last-admin CAS rather than desyncing the bit from role.
    if (targetUser.role !== "ADMIN" && (parsed & Permission.ADMIN) !== 0n) {
      return NextResponse.json({ error: t("apiAdmin.users.promoteBeforeGrantingAdmin") }, { status: 400 });
    }

    try {
      await prisma.user.update({ where: { id }, data: { permissions: parsed } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiAdmin.users.instanceGrantsInvalid") }, { status: 400 });
    }
    const parsedGrants = parseInstanceGrants(body.instanceGrants);
    if (!callerIsAdmin) {
      const [radarr, sonarr] = await Promise.all([getArrInstances("radarr"), getArrInstances("sonarr")]);
      const registry = new Map<string, { slug: string; restricted: boolean; serverAll: boolean }[]>();
      for (const cfg of [...radarr, ...sonarr]) registry.set(cfg.slug, [...(registry.get(cfg.slug) ?? []), cfg]);
      if (instanceGrantsBeyondOwn(parsedGrants, session.user.permissions, parseInstanceGrants(callerOwn?.instanceGrants), registry)) {
        return NextResponse.json({ error: t("apiAdmin.users.cannotGrantBeyondOwn") }, { status: 403 });
      }
    }
    const grants = serializeInstanceGrants(parsedGrants);
    const prev = await prisma.user.findUnique({ where: { id }, select: { instanceGrants: true, name: true, email: true } });
    if (!prev) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { instanceGrants: grants } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiAdmin.users.mediaServerGrantsInvalid") }, { status: 400 });
    }
    const parsedGrants = parseMediaServerGrants(body.mediaServerGrants);
    if (!callerIsAdmin) {
      const [plex, jellyfin] = await Promise.all([getMediaInstances("plex"), getMediaInstances("jellyfin")]);
      const registry = {
        plex: new Map(plex.map((cfg) => [cfg.slug as string, cfg])),
        jellyfin: new Map(jellyfin.map((cfg) => [cfg.slug as string, cfg])),
      };
      if (mediaServerGrantsBeyondOwn(parsedGrants, session.user.permissions, parseMediaServerGrants(callerOwn?.mediaServerGrants), registry)) {
        return NextResponse.json({ error: t("apiAdmin.users.cannotGrantBeyondOwn") }, { status: 403 });
      }
    }
    const grants = serializeMediaServerGrants(parsedGrants);
    const prev = await prisma.user.findUnique({ where: { id }, select: { mediaServerGrants: true, name: true, email: true } });
    if (!prev) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { mediaServerGrants: grants } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiAdmin.users.quotaInvalid", { field: quotaField }) }, { status: 400 });
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
          error: t("apiAdmin.users.quotaZero", { field: quotaField }),
        },
        { status: 400 },
      );
    }
    const nextVal = val ?? null;
    const prevQuota = await prisma.user.findUnique({
      where: { id },
      select: { movieQuotaLimit: true, movieQuotaDays: true, tvQuotaLimit: true, tvQuotaDays: true },
    });
    if (!prevQuota) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { [quotaField]: nextVal } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
      return NextResponse.json({ error: t("apiAdmin.users.notifBoolean", { field: notifKey }) }, { status: 400 });
    }
    const prevNotif = await prisma.user.findUnique({ where: { id }, select: { [notifKey]: true } });
    if (!prevNotif) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    try {
      await prisma.user.update({ where: { id }, data: { [notifKey]: body[notifKey] } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
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
    return NextResponse.json({ error: t("apiAdmin.users.noRecognizedFields") }, { status: 400 });
  }
  if (isSelf) {
    return NextResponse.json({ error: t("apiAdmin.users.cannotChangeOwnRole") }, { status: 400 });
  }
  if (body.role !== "ADMIN" && body.role !== "USER" && body.role !== "ISSUE_ADMIN") {
    return NextResponse.json({ error: t("apiAdmin.users.roleInvalid") }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, email: true } });
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });

  // Only a full admin may promote a user TO admin or change an account that is
  // already admin (demotion, re-seed). Without this, a MANAGE_USERS holder could
  // PATCH {role:"ADMIN"} on any account and self-escalate to full control.
  if (!callerIsAdmin && (body.role === "ADMIN" || target.role === "ADMIN")) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminGrantAdmin") }, { status: 403 });
  }

  // The re-read, the caller-authority gate AND the write all run inside ONE
  // transaction holding advisory lock 42 (a Postgres lock that makes these
  // role changes run one at a time). Doing the re-read outside it would leave a
  // gap: a promotion landing between the read and the write could let the last
  // admin be demoted without the count check, leaving zero admins. The DELETE
  // handler serializes the same way.
  const demoting = body.role === "USER" || body.role === "ISSUE_ADMIN";
  const now = new Date().toISOString();
  const newRole = body.role as "ADMIN" | "ISSUE_ADMIN" | "USER";
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
    const fresh = await tx.user.findUnique({ where: { id }, select: { role: true } });
    const freshRole = fresh?.role ?? target.role;

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
  if (outcome.kind === "forbidden") {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminGrantAdmin") }, { status: 403 });
  }
  if (outcome.kind === "last-admin") {
    return NextResponse.json({ error: t("apiAdmin.users.cannotDemoteLastAdmin") }, { status: 400 });
  }

  invalidateUserSession(id);

  // Role change already committed; a failed audit write must not 500 it (a retry
  // would re-apply and double-audit). logAudit swallows write failures by design.
  void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_ROLE_CHANGE", target: `user:${id}`, details: { targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, after: { role: body.role } }, ...auditContext(req, session) });
  return NextResponse.json({ id, role: body.role });
});

export const DELETE = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  if (!checkRateLimit(`admin-user-delete:${session.user.id}`, 5, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyAttempts") }, { status: 429 });
  }

  if (id === session.user.id) {
    return NextResponse.json({ error: t("apiAdmin.users.cannotDeleteSelf") }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, name: true, email: true, deactivatedAt: true } });
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  // Idempotent, and load-bearing: re-running deactivateUserInTx on an already
  // disabled ADMIN would see its own row excluded from the active-admin count
  // and throw LastAdminError spuriously.
  if (target.deactivatedAt) return NextResponse.json({ ok: true });

  // A non-admin MANAGE_USERS holder must not delete/deactivate an admin account.
  if (target.role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminDelete") }, { status: 403 });
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
      return NextResponse.json({ error: t("apiAdmin.users.cannotDisableLastAdmin") }, { status: 400 });
    }
    if (err instanceof TargetBecameAdminError) {
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminDelete") }, { status: 403 });
    }
    throw err;
  }

  invalidateUserSession(id);

  // Account already disabled; a failed audit write must not 500 it (guardrail 26
  // — logAudit swallows write failures). Everything (requests/issues/votes, the
  // identity itself) is preserved — the account is off, not erased.
  void logAudit({ userId: session.user.id, userName: session.user.name ?? session.user.email, action: "USER_DEACTIVATE", target: `user:${id}`, details: { kind: "admin-disable", targetUser: target.name ?? target.email, targetEmail: target.email, before: { role: target.role }, historyPreserved: { mediaRequests: requestCount, issues: issueCount, deletionVotes: voteCount } }, ...auditContext(req, session) });
  return NextResponse.json({ ok: true });
});
