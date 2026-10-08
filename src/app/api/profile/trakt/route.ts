import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { disconnectTrakt, getTraktProfileState } from "@/lib/trakt-user";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// The caller's own Trakt connection (src/lib/trakt-user.ts, guardrail 34c):
//   available            — the admin configured a Trakt app (client id AND
//                          secret) and the caller has a use for it;
//   uses                 — { watchlist, history }: watchlist auto-request is on
//                          and permitted / For You is on;
//   connected, username  — a Trakt grant is stored, and whose;
//   watchlistAutoRequest — file new Trakt watchlist titles as requests;
//   historySeeds         — seed For You from the Trakt watch history;
//   status, syncedAt     — the last cron run's verdict ("reauth" = Trakt
//                          refused the grant; reconnect).
export const GET = withAuth(async (_req, _ctx, session) => {
  return NextResponse.json(await getTraktProfileState(session.user.id, session.user.permissions));
});

// Flip either use. Turning the history off deletes the imported history at once
// — it exists only to seed For You — and turning it back on re-imports it on
// the next run.
export const PATCH = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCapped<{ watchlistAutoRequest?: unknown; historySeeds?: unknown }>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  const { watchlistAutoRequest, historySeeds } = parsed;
  if (
    (watchlistAutoRequest !== undefined && typeof watchlistAutoRequest !== "boolean") ||
    (historySeeds !== undefined && typeof historySeeds !== "boolean") ||
    (watchlistAutoRequest === undefined && historySeeds === undefined)
  ) {
    return NextResponse.json({ error: t("apiAuth.profile.trakt.toggleBoolean") }, { status: 400 });
  }
  const conn = await prisma.traktConnection.findUnique({ where: { userId: session.user.id }, select: { userId: true } });
  if (!conn) return NextResponse.json({ error: t("apiAuth.profile.trakt.notConnected") }, { status: 404 });

  await prisma.$transaction(async (tx) => {
    await tx.traktConnection.update({
      where: { userId: session.user.id },
      data: {
        ...(watchlistAutoRequest !== undefined ? { watchlistAutoRequest } : {}),
        ...(historySeeds !== undefined
          ? { historySeeds, historyActivityAt: null, historyImportedAt: null }
          : {}),
      },
    });
    if (historySeeds === false) await tx.traktWatchedItem.deleteMany({ where: { userId: session.user.id } });
  });
  return NextResponse.json(await getTraktProfileState(session.user.id, session.user.permissions));
});

// Disconnect: the grant, the connection and the imported history are deleted,
// and the token is revoked at Trakt best-effort.
export const DELETE = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const had = await disconnectTrakt(session.user.id);
  if (had) {
    // A stored credential was deleted. After the commit, swallowing (guardrail 26).
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? "unknown",
      action: "SETTINGS_CHANGE",
      target: `user:${session.user.id}`,
      details: { kind: "trakt-disconnect" },
      ...auditContext(req, session),
    });
  }
  return NextResponse.json({ ok: true });
});
