import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { WATCH_SYNC_FEATURE_KEY, markCountsByPair, watchSyncRunState } from "@/lib/watch-sync-data";
import { compareServerUsers, parseWatchSyncDirection } from "@/lib/watch-sync";
import { serverUserOut, splitServerUsers, watchSyncSuggestions, type ServerNames, type ServerUserRow } from "@/lib/watch-sync-view";
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

// The pickable accounts are read with a bound, like the Users page's server
// user list; past it the answer says so (`truncated`).
const MAX_LISTED_ACCOUNTS = 10_000;

async function serverNames(): Promise<ServerNames> {
  const [plex, jellyfin] = await Promise.all([getMediaInstances("plex"), getMediaInstances("jellyfin")]);
  return {
    plex: new Map(plex.map((i) => [i.slug, i.name])),
    jellyfin: new Map(jellyfin.map((i) => [i.slug, i.name])),
  };
}

const SERVER_USER_SELECT = { id: true, source: true, serverInstance: true, username: true, active: true, userId: true } as const;

export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.watchSync.disabled") }, { status: 404 });
  }
  const names = await serverNames();
  const [pairs, rows] = await Promise.all([
    prisma.watchSyncPair.findMany({
      select: {
        id: true, enabled: true, direction: true, syncProgress: true, historyReadTo: true, jellyfinReadTo: true, lastRunAt: true, lastResult: true, createdAt: true,
        plexUser: { select: SERVER_USER_SELECT },
        jellyfinUser: { select: SERVER_USER_SELECT },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.mediaServerUser.findMany({
      where: { source: { in: ["plex", "jellyfin"] }, active: true },
      select: { ...SERVER_USER_SELECT, user: { select: { name: true, email: true } } },
      orderBy: { username: "asc" },
      // One past the bound, to tell a full list from a cut one.
      take: MAX_LISTED_ACCOUNTS + 1,
    }),
  ]);
  const truncated = rows.length > MAX_LISTED_ACCOUNTS;
  const { plex: plexUsers, jellyfin: jellyfinUsers } = splitServerUsers(truncated ? rows.slice(0, MAX_LISTED_ACCOUNTS) : rows);
  const counts = await markCountsByPair(pairs.map((p) => p.id));
  const out = (u: ServerUserRow) => serverUserOut(names, u);

  pairs.sort((a, b) => compareServerUsers(a.plexUser, b.plexUser) || compareServerUsers(a.jellyfinUser, b.jellyfinUser));
  const run = watchSyncRunState();

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
    suggestions: watchSyncSuggestions(plexUsers, jellyfinUsers, pairs),
    // A run in progress in this process (cron or Run now).
    run: { running: run.running, startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null, pairId: run.pairId },
    // Additive: the account lists stopped at the bound.
    truncated,
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
  // A NEW pair needs both identities active, matching the GET list (which hides
  // inactive ones). runWatchSync checks only the Jellyfin side: nothing ever
  // re-activates a Plex identity, so an EXISTING pair must not be stopped by a
  // stale Plex flag (a server removed and re-added under its slug).
  if (!plex || plex.source !== "plex" || !plex.active || !jellyfin || jellyfin.source !== "jellyfin" || !jellyfin.active) {
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
