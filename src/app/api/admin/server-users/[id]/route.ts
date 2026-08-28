import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { enforceUserDownloadPolicy } from "@/lib/download-policy";
import { isPurgedRow } from "@/lib/account-lifecycle";

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
export const PATCH = withAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
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
      { error: "Provide downloadsEnabled, userId, or autoLink" },
      { status: 400 },
    );
  }
  if (wantsLink && wantsAutoLink) {
    return NextResponse.json(
      { error: "Provide either userId or autoLink, not both" },
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
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── Account linking ───────────────────────────────────────────────────────
  // Deliberately NOT gated on isServerAdmin, source, or `active`: those are
  // download-policy concerns (below). Every identity — Plex or Jellyfin, admin
  // or not, still on the server or long departed — owns watch history that has
  // to land on the right account. A DEPARTED row is in fact the likeliest one to
  // need re-attaching by hand: its history outlives the user's removal from the
  // media server (guardrail 28), so refusing to link it would strand that
  // history with no way to reach it.
  if (wantsLink || wantsAutoLink) {
    let nextUserId: string | null = null;

    if (wantsLink && body.userId !== null) {
      if (typeof body.userId !== "string" || body.userId.length === 0) {
        return NextResponse.json({ error: "userId must be a user id or null" }, { status: 400 });
      }
      const target = await prisma.user.findUnique({
        where: { id: body.userId },
        select: { id: true, name: true, email: true, purgedAt: true },
      });
      if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
      // A purged account has had its identity scrubbed — attributing watch
      // history to it would re-attach data to a row that exists only as a
      // de-identified tombstone. A merely DISABLED account is fine and is the
      // common case: it still owns its history (see account-lifecycle.ts).
      // Shape-aware (see isPurgedRow) so a pre-`purgedAt` scrubbed row is caught too.
      if (isPurgedRow(target)) {
        return NextResponse.json(
          { error: "That account's data was purged and it can no longer be linked." },
          { status: 400 },
        );
      }
      nextUserId = target.id;
    }

    const before = record.userId;
    await prisma.mediaServerUser.update({
      where: { id },
      data: wantsAutoLink
        // Hand the row back to automatic resolution. `userId` is left as-is —
        // the next poll/sync re-derives it (and clears a stale value only if it
        // resolves to someone else; an unresolvable row simply keeps what it has).
        ? { manualUserLink: false }
        : { userId: nextUserId, manualUserLink: true },
    });

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
    return NextResponse.json({ error: "downloadsEnabled must be a boolean" }, { status: 400 });
  }
  // Soft-deleted (active: false) rows are departed users hidden from the active
  // management surfaces; treat them as absent so policy can't be pushed to an
  // account that no longer exists on the server.
  if (!record.active) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (record.isServerAdmin) {
    return NextResponse.json({ error: "Cannot change download policy for server admins" }, { status: 400 });
  }
  // Plex's sharing API does not expose a working remote toggle for allowSync,
  // so download policy is Jellyfin-only. The UI hides the toggle for Plex rows.
  if (record.source === "plex") {
    return NextResponse.json({ error: "Plex download policy is not managed by Summonarr" }, { status: 400 });
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
      : { ok: true, pushed: false, warning: "Saved, but the media server could not be reached to apply the change — it will retry on the next hourly sync only if you disabled downloads." },
  );
});
