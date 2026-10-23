import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { WATCH_SYNC_FEATURE_KEY, markCountsByPair } from "@/lib/watch-sync-data";
import { parseWatchSyncDirection } from "@/lib/watch-sync";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// Watch sync, Plex ⇄ Jellyfin — the admin page's data (ADMIN). Pairs are made
// ONLY here, by an admin (guardrail 19e): a Plex account and a Jellyfin user
// linked to the same Summonarr user are offered as a suggestion, never paired
// automatically.
//
//   GET                                   → pairs + per-pair ledger counts, the
//                                            pickable accounts, suggestions.
//   POST { plexUserId, jellyfinUserId, direction?, syncProgress? } → create a
//                                            pair (MediaServerUser ids; direction
//                                            "both" (default) | "toJellyfin" | "toPlex";
//                                            syncProgress: resume points, default false).
//
// No provider subject id, token or server address reaches the browser: an
// account is its row id, username and server display name.

type ServerUserOut = { id: string; username: string; server: string; active: boolean };

async function serverNames(): Promise<{ plex: Map<string, string>; jellyfin: Map<string, string> }> {
  const [plex, jellyfin] = await Promise.all([getMediaInstances("plex"), getMediaInstances("jellyfin")]);
  return {
    plex: new Map(plex.map((i) => [i.slug, i.name])),
    jellyfin: new Map(jellyfin.map((i) => [i.slug, i.name])),
  };
}

export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const names = await serverNames();
  const serverUserSelect = { id: true, source: true, serverInstance: true, username: true, active: true, userId: true } as const;
  const [pairs, users] = await Promise.all([
    prisma.watchSyncPair.findMany({
      select: {
        id: true, enabled: true, direction: true, syncProgress: true, historyReadTo: true, jellyfinReadTo: true, lastRunAt: true, lastResult: true, createdAt: true,
        plexUser: { select: serverUserSelect },
        jellyfinUser: { select: serverUserSelect },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.mediaServerUser.findMany({
      where: { source: { in: ["plex", "jellyfin"] }, active: true },
      select: { ...serverUserSelect, user: { select: { name: true, email: true } } },
      orderBy: { username: "asc" },
    }),
  ]);
  const counts = await markCountsByPair(pairs.map((p) => p.id));
  const label = (u: { source: string; serverInstance: string }) =>
    (u.source === "plex" ? names.plex : names.jellyfin).get(u.serverInstance) ?? (u.serverInstance || u.source);
  const out = (u: { id: string; source: string; serverInstance: string; username: string; active: boolean }): ServerUserOut =>
    ({ id: u.id, username: u.username, server: label(u), active: u.active });

  const plexUsers = users.filter((u) => u.source === "plex");
  const jellyfinUsers = users.filter((u) => u.source === "jellyfin");
  const paired = new Set(pairs.map((p) => `${p.plexUser.id}\u0000${p.jellyfinUser.id}`));
  // Suggestions: both identities linked to the same Summonarr account.
  const suggestions: Array<{ plexUserId: string; jellyfinUserId: string; account: string }> = [];
  for (const p of plexUsers) {
    if (!p.userId) continue;
    for (const j of jellyfinUsers) {
      if (j.userId !== p.userId || paired.has(`${p.id}\u0000${j.id}`)) continue;
      suggestions.push({ plexUserId: p.id, jellyfinUserId: j.id, account: p.user?.name || p.user?.email || p.username });
    }
  }

  return NextResponse.json({
    pairs: pairs.map((p) => ({
      id: p.id,
      enabled: p.enabled,
      direction: p.direction,
      syncProgress: p.syncProgress,
      plex: out(p.plexUser),
      jellyfin: out(p.jellyfinUser),
      historyReadTo: p.historyReadTo,
      jellyfinReadTo: p.jellyfinReadTo,
      lastRunAt: p.lastRunAt,
      lastResult: p.lastResult,
      counts: counts.get(p.id),
    })),
    plexUsers: plexUsers.map(out),
    jellyfinUsers: jellyfinUsers.map(out),
    suggestions,
  });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const parsed = await readJsonCapped<{ plexUserId?: unknown; jellyfinUserId?: unknown; direction?: unknown; syncProgress?: unknown }>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  const { plexUserId, jellyfinUserId } = parsed;
  const direction = parsed.direction === undefined ? "both" : parseWatchSyncDirection(parsed.direction);
  const syncProgress = parsed.syncProgress === undefined ? false : parsed.syncProgress;
  if (typeof syncProgress !== "boolean" || !direction || typeof plexUserId !== "string" || typeof jellyfinUserId !== "string" || plexUserId.length > 64 || jellyfinUserId.length > 64) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
  }
  const [plex, jellyfin] = await Promise.all([
    prisma.mediaServerUser.findUnique({ where: { id: plexUserId }, select: { id: true, source: true, active: true } }),
    prisma.mediaServerUser.findUnique({ where: { id: jellyfinUserId }, select: { id: true, source: true, active: true } }),
  ]);
  if (!plex || plex.source !== "plex" || !jellyfin || jellyfin.source !== "jellyfin" || !jellyfin.active) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.pairInvalid") }, { status: 400 });
  }
  try {
    const pair = await prisma.watchSyncPair.create({
      data: { plexUserId, jellyfinUserId, direction, syncProgress, createdById: session.user.id },
      select: { id: true },
    });
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      ...auditContext(req, session),
      action: "SETTINGS_CHANGE",
      target: `watch-sync:${pair.id}`,
      details: { change: "pair-create", plexServerUserId: plexUserId, jellyfinServerUserId: jellyfinUserId, direction, syncProgress },
    });
    return NextResponse.json({ id: pair.id }, { status: 201 });
  } catch (err) {
    if (isPrismaErrorCode(err, "P2002")) {
      return NextResponse.json({ error: t("apiAdmin.watchSync.pairExists") }, { status: 409 });
    }
    throw err;
  }
});
