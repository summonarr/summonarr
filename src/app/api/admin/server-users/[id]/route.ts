import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withPermission } from "@/lib/api-auth";
import { Permission, hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { enforceUserDownloadPolicy } from "@/lib/download-policy";
import { isPurgedRow } from "@/lib/account-lifecycle";
import { translatorForRequest } from "@/lib/i18n/server-locale";

class LinkNeedsAdminError extends Error {}
class LinkTargetGoneError extends Error {}

// An admin is role ADMIN OR the ADMIN superbit (the users PATCH keeps the two in
// lockstep; this gate must not depend on that for a legacy/hand-edited row).
function isAdminRow(row: { role: string; permissions: bigint | null }): boolean {
  return row.role === "ADMIN" || (typeof row.permissions === "bigint" && (row.permissions & Permission.ADMIN) !== 0n);
}

// PATCH /api/admin/server-users/[id] — two independent admin actions on one
// media-server identity:
//
//   { downloadsEnabled }        Jellyfin download policy (pushed to the server).
//   { userId } | { autoLink }   Which Summonarr account this identity's watch
//                               history is attributed to.
//
// The linking half exists because automatic resolution can't always be right:
// it matches on the provider subject id first and the email second, so an
// identity whose email collided with the wrong account — or that matches nothing
// at all — needs a hand correction. Setting it by hand pins `manualUserLink`, and
// BOTH automatic linkers (resolveMediaServerUser on every 5s poll, and the hourly
// Jellyfin user sync) skip a pinned row. Without that pin a manual fix would be
// overwritten within seconds.
export const PATCH = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  const { id } = await params;

  const parsed = await readJsonCapped<{
    downloadsEnabled?: boolean;
    userId?: string | null;
    autoLink?: boolean;
  }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const wantsLink = "userId" in body;
  const wantsAutoLink = body.autoLink === true;
  const wantsPolicy = body.downloadsEnabled !== undefined;

  if (!wantsLink && !wantsAutoLink && !wantsPolicy) {
    return NextResponse.json(
      { error: t("apiAdmin.serverUsers.provideField") },
      { status: 400 },
    );
  }
  if (wantsLink && wantsAutoLink) {
    return NextResponse.json(
      { error: t("apiAdmin.serverUsers.userIdOrAutoLink") },
      { status: 400 },
    );
  }

  const record = await prisma.mediaServerUser.findUnique({
    where: { id },
    select: {
      isServerAdmin: true,
      source: true,
      active: true,
      username: true,
      userId: true,
      manualUserLink: true,
    },
  });
  if (!record) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });

  // ── Account linking ───────────────────────────────────────────────────────
  // For an ADMIN caller, deliberately NOT gated on isServerAdmin, source, or
  // `active`: those are download-policy concerns (below). Every identity — Plex
  // or Jellyfin, admin or not, still on the server or long departed — owns watch
  // history that has to land on the right account. (A delegate without the
  // ADMIN bit IS gated — see the transaction below.) A DEPARTED row is in fact the likeliest one to
  // need re-attaching by hand: its history outlives the user's removal from the
  // media server (guardrail 28), so refusing to link it would strand that
  // history with no way to reach it.
  if (wantsLink || wantsAutoLink) {
    let nextUserId: string | null = null;

    if (wantsLink && body.userId !== null) {
      if (typeof body.userId !== "string" || body.userId.length === 0) {
        return NextResponse.json({ error: t("apiAdmin.serverUsers.userIdInvalid") }, { status: 400 });
      }
      const target = await prisma.user.findUnique({
        where: { id: body.userId },
        select: { id: true, name: true, email: true, purgedAt: true },
      });
      if (!target) return NextResponse.json({ error: t("apiAdmin.serverUsers.userNotFound") }, { status: 404 });
      // A purged account has had its identity scrubbed — attributing watch
      // history to it would re-attach data to a row that exists only as a
      // de-identified tombstone. A merely DISABLED account is fine and is the
      // common case: it still owns its history (see account-lifecycle.ts).
      // Shape-aware (see isPurgedRow) so a pre-`purgedAt` scrubbed row is caught too.
      if (isPurgedRow(target)) {
        return NextResponse.json(
          { error: t("apiAdmin.serverUsers.purgedCannotLink") },
          { status: 400 },
        );
      }
      nextUserId = target.id;
    }

    // A MANAGE_USERS delegate (no ADMIN bit) may re-attach ordinary members'
    // history, but never take an identity for themselves, and never touch an
    // identity that belongs to — or would go to — an admin, or the media server's
    // own admin. Linking an identity is what makes its watch history readable by
    // its new owner (/api/play-history/mine*), so without these rules a delegate
    // could point the server owner's identity at their own account and read
    // every title the owner watched, while the owner's own history went blank.
    const callerIsAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
    if (!callerIsAdmin && nextUserId === session.user.id) {
      return NextResponse.json({ error: t("apiAdmin.serverUsers.cannotLinkSelf") }, { status: 403 });
    }

    const before = record.userId;
    try {
      await prisma.$transaction(async (tx) => {
        if (!callerIsAdmin) {
          // Decide on fresh rows under advisory lock 42 — the lock the role-change
          // and deactivate paths take — so a promotion landing after the read
          // above can't slip an admin's identity past the check.
          await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
          const fresh = await tx.mediaServerUser.findUnique({
            where: { id },
            select: { userId: true, isServerAdmin: true },
          });
          if (!fresh) throw new LinkTargetGoneError();
          const ids = [fresh.userId, nextUserId].filter((v): v is string => typeof v === "string");
          const owners = ids.length
            ? await tx.user.findMany({ where: { id: { in: ids } }, select: { role: true, permissions: true } })
            : [];
          if (fresh.isServerAdmin || owners.some(isAdminRow)) throw new LinkNeedsAdminError();
        }
        await tx.mediaServerUser.update({
          where: { id },
          data: wantsAutoLink
            // Hand the row back to automatic resolution. `userId` is left as-is —
            // the next poll/sync re-derives it (and clears a stale value only if it
            // resolves to someone else; an unresolvable row simply keeps what it has).
            ? { manualUserLink: false }
            : { userId: nextUserId, manualUserLink: true },
        });
      });
    } catch (err) {
      if (err instanceof LinkNeedsAdminError) {
        return NextResponse.json({ error: t("apiAdmin.serverUsers.onlyAdminLink") }, { status: 403 });
      }
      if (err instanceof LinkTargetGoneError) {
        return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
      }
      throw err;
    }

    // Already committed — a failed audit write must not 500 it (guardrail 26).
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "SERVER_USER_LINK",
      target: `mediaServerUser:${id}`,
      details: {
        serverUser: record.username,
        source: record.source,
        mode: wantsAutoLink ? "auto" : nextUserId ? "manual-link" : "manual-unlink",
        before,
        after: wantsAutoLink ? before : nextUserId,
      },
      ...auditContext(req, session),
    });

    return NextResponse.json({ ok: true });
  }

  // ── Download policy (Jellyfin only) ───────────────────────────────────────
  if (typeof body.downloadsEnabled !== "boolean") {
    return NextResponse.json({ error: t("apiAdmin.common.downloadsEnabledBoolean") }, { status: 400 });
  }
  // Soft-deleted (active: false) rows are departed users hidden from the active
  // management surfaces; treat them as absent so policy can't be pushed to an
  // account that no longer exists on the server.
  if (!record.active) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  if (record.isServerAdmin) {
    return NextResponse.json({ error: t("apiAdmin.serverUsers.cannotChangeAdminPolicy") }, { status: 400 });
  }
  // Plex's sharing API does not expose a working remote toggle for allowSync,
  // so download policy is Jellyfin-only. The UI hides the toggle for Plex rows.
  if (record.source === "plex") {
    return NextResponse.json({ error: t("apiAdmin.serverUsers.plexPolicyUnmanaged") }, { status: 400 });
  }

  await prisma.mediaServerUser.update({
    where: { id },
    data: { downloadsEnabled: body.downloadsEnabled },
  });

  // Push the change to the media server immediately; log but don't fail the
  // response. The push OUTCOME is surfaced to the client: the hourly reconcile
  // only re-pushes drift in the DISABLE direction, so a failed enable-push
  // never self-heals — the UI must be able to tell the admin the server wasn't
  // actually updated rather than showing a bare success.
  let pushed = true;
  try {
    await enforceUserDownloadPolicy(id);
  } catch (err) {
    pushed = false;
    console.warn(`[server-users] Failed to push policy for ${id}:`, err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json(
    pushed
      ? { ok: true, pushed: true }
      : { ok: true, pushed: false, warning: t("apiAdmin.serverUsers.savedNotPushed") },
  );
});
