import { NextRequest, NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";
import { prisma } from "@/lib/prisma";
import { getPlexTmdbIds, getPlexTVEpisodes, getPlexLibrarySections, type PlexLegacyGuidRef } from "@/lib/plex";
import { resolvePlexLegacyGuids, mergeResolvedLegacyItems } from "@/lib/plex-legacy-resolve";
import { getPlexConfig } from "@/lib/plex-config";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, plexSettingKey, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { notifyUsersRequestsAvailable } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { canViewMediaInstance, parseMediaServerGrants, effectivePermissions } from "@/lib/permissions";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording } from "@/lib/cron-auth";
import { claimAvailableNotificationWinners, clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { notifyUsersRequestsAvailableEmail, writeAvailableInAppNotifications } from "@/lib/request-notifications";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withCronRunRecording("plex-sync", () => syncPlex(request));
}

// Resyncs ONE Plex server — the default ("") unless the body names another via
// `instance`. Every library read/delete is scoped to that server's
// serverInstance, so resyncing one can never wipe or mask another's rows.
//
// TVEpisodeCache is the exception that needs care: it has NO serverInstance
// column, so every Plex server's episodes share one `source: "plex"` namespace
// and the only correct rewrite is a whole-table one built from EVERY server (the
// orchestrator's job, where it is gated on all instances having been fetched).
// A single-server resync cannot produce that union, so it rewrites the cache
// ONLY when it is the sole configured Plex server. With more than one it leaves
// the cache alone — previously it deleted `source: "plex"` unscoped and
// repopulated from this server alone, silently destroying every other Plex
// server's episode rows until the next orchestrator run.
async function syncPlex(request: NextRequest) {
  const rawBody = await readJsonCappedOr<Record<string, unknown>>(request, 8192, {});
  if (rawBody instanceof NextResponse) return rawBody;
  const recentOnly = rawBody.full !== true;

  // Which server to resync. Absent ⇒ the default, so every existing caller (the
  // admin Resync button, the connect form, the master-fill button) is unchanged.
  // A malformed slug is rejected rather than coerced: coercing to "" would point
  // a destructive scoped delete at the WRONG server.
  const instance: MediaInstanceKey =
    typeof rawBody.instance === "string" ? rawBody.instance : DEFAULT_MEDIA_INSTANCE;
  if (instance !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(instance)) {
    return NextResponse.json({ error: "Invalid instance" }, { status: 400 });
  }

  // getMediaInstances, NOT getSyncableMediaInstances: the latter probes each
  // instance with a setting.findMany, and this path is held to the same
  // findUnique-only read shape as the other per-instance config readers
  // (guardrail 35). Counting REGISTERED rather than CONFIGURED servers is also
  // the safer error: a registered-but-unconfigured server has no episodes to
  // contribute, so at worst this skips a rewrite the orchestrator will do anyway
  // — the opposite mistake destroys another server rows.
  const [plexConfig, librariesRow, plexInstances] = await Promise.all([
    getPlexConfig(instance),
    prisma.setting.findUnique({ where: { key: plexSettingKey(instance, "Libraries") } }),
    getMediaInstances("plex"),
  ]);

  if (!plexConfig.url || !plexConfig.token) {
    return NextResponse.json({ error: "Plex server not configured" }, { status: 400 });
  }

  const serverUrl = plexConfig.url.replace(/\/$/, "");
  const token = plexConfig.token;
  const selectedPlexKeys = librariesRow?.value
    ? new Set(librariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
    : undefined;

  let sections: Awaited<ReturnType<typeof getPlexLibrarySections>>;
  let movieIds: Awaited<ReturnType<typeof getPlexTmdbIds>>;
  let tvIds:    Awaited<ReturnType<typeof getPlexTmdbIds>>;
  // Show-walk accumulator + legacy-agent channels — same wiring as the
  // orchestrator's Plex arm (see ../route.ts).
  const ratingKeyToTmdb = new Map<string, number[]>();
  const movieLegacy = new Map<string, PlexLegacyGuidRef>();
  const tvLegacy = new Map<string, PlexLegacyGuidRef>();
  try {
    sections = await getPlexLibrarySections(serverUrl, token);
    [movieIds, tvIds] = await Promise.all([
      getPlexTmdbIds(serverUrl, token, "MOVIE", recentOnly, selectedPlexKeys, sections, undefined, movieLegacy),
      getPlexTmdbIds(serverUrl, token, "TV", recentOnly, selectedPlexKeys, sections, ratingKeyToTmdb, tvLegacy),
    ]);
    const [resolvedMovies, resolvedTv] = await Promise.all([
      resolvePlexLegacyGuids(movieLegacy, "MOVIE"),
      resolvePlexLegacyGuids(tvLegacy, "TV"),
    ]);
    mergeResolvedLegacyItems(resolvedMovies, movieIds);
    mergeResolvedLegacyItems(resolvedTv, tvIds, ratingKeyToTmdb);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync/plex] Failed to fetch library:", msg);
    return NextResponse.json(
      { error: "Could not reach Plex server" },
      { status: 502 }
    );
  }

  // Fire-and-forget: episode cache is best-effort and must not block the main library write.
  // Full replace: clear unconditionally then insert. getPlexTVEpisodes throws on a fetch
  // failure (rejects → .catch, no clear), so an empty result is a genuinely empty library
  // and the stale episode ownership must be cleared rather than left behind.
  const ownsEpisodeCache = plexInstances.length <= 1;
  if (!ownsEpisodeCache) {
    console.warn(
      `[sync/plex] ${plexInstances.length} Plex servers configured — leaving the shared TVEpisodeCache to the orchestrator, which rebuilds it from every server.`,
    );
  }
  (ownsEpisodeCache
    // The precomputed show map is complete only when the walk above was FULL —
    // on recentOnly it covers just the 2h window while this episode rewrite is
    // a full replace, so getPlexTVEpisodes keeps its own walk there.
    ? getPlexTVEpisodes(serverUrl, token, selectedPlexKeys, sections, recentOnly ? undefined : ratingKeyToTmdb)
    : Promise.resolve(null)
  )
    .then(async (episodes) => {
      if (episodes === null) return;
      await prisma.$transaction(async (tx) => {
        // Advisory lock 2002,1 — Plex TVEpisodeCache coordination. Shared with /api/sync/route
        // and /api/sync/tv-episodes so concurrent runners can't interleave delete/insert phases.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
        await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
        if (episodes.length > 0) {
          await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "plex" as const, ...e })));
        }
      }, { timeout: BATCH_TX_TIMEOUT });
    })
    .catch((err) => console.error("[sync/plex] Episode cache failed:", err));

  const sanitizeStr = (s: string | null | undefined, maxLen = 1000): string | null => {
    if (s == null) return null;
    return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
  };

  // `serverInstance` is NOT optional here. Every delete on this path is scoped to
  // `instance`, so omitting it on the insert made a named-instance resync delete that
  // server's rows and re-insert them under the schema default "" — moving the whole
  // library onto the DEFAULT server. That silently un-restricts a `restricted` server
  // (slug "" is visible to everyone) and drops its server-local ratingKeys into the
  // default's namespace, where a later fix-match would address the wrong server.
  const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, serverInstance: instance, mediaType: "MOVIE" as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
  const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, serverInstance: instance, mediaType: "TV"    as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));

  // Plex can conflate two TMDB IDs onto the same ratingKey when metadata bundles merge;
  // deduplicate by preferring the previously stored mapping to avoid flip-flopping on every
  // sync. Keep in agreement with deduplicatePlexRowsByRatingKey in /api/sync/route so the
  // two writers agree on the row set — including the per-instance scoping: ratingKeys are
  // small server-local integers, so the prior-mapping lookup must consult only the instance
  // being written (`instance`, which the body may name — NOT always the default).
  type PlexRow = { tmdbId: number; mediaType: "MOVIE" | "TV"; filePath: string | null; plexRatingKey: string | null };
  // Generic in the row type so the caller's extra columns — `serverInstance` above in
  // particular — survive in the TYPE and not just at runtime. A concrete PlexRow[]
  // return would erase them, hiding the very field whose omission moved a named
  // server's library onto the default.
  const deduplicateByRatingKey = async <T extends PlexRow>(
    rows: T[],
    mediaType: "MOVIE" | "TV",
    serverInstance: MediaInstanceKey,
  ): Promise<T[]> => {
    const ratingKeyCount = new Map<string, number>();
    for (const r of rows) {
      if (r.plexRatingKey) ratingKeyCount.set(r.plexRatingKey, (ratingKeyCount.get(r.plexRatingKey) ?? 0) + 1);
    }
    const conflatedKeys = new Set([...ratingKeyCount.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    if (conflatedKeys.size === 0) return rows;

    const conflatedTmdbIds = rows.filter((r) => r.plexRatingKey && conflatedKeys.has(r.plexRatingKey)).map((r) => r.tmdbId);
    const existing = await prisma.plexLibraryItem.findMany({
      where: { mediaType, serverInstance, tmdbId: { in: conflatedTmdbIds } },
      select: { tmdbId: true, plexRatingKey: true },
    });
    const fixedIdByRatingKey = new Map<string, number>();
    for (const e of existing) {
      if (e.plexRatingKey) fixedIdByRatingKey.set(e.plexRatingKey, e.tmdbId);
    }

    const seenRatingKeys = new Set<string>();
    // One summary per run rather than a line per dropped row — see the
    // matching comment in the orchestrator's copy in ../route.ts.
    const dropped: string[] = [];
    const kept = rows.filter((r) => {
      if (!r.plexRatingKey || !conflatedKeys.has(r.plexRatingKey)) return true;
      const fixed = fixedIdByRatingKey.get(r.plexRatingKey);
      if (fixed !== undefined) {
        if (r.tmdbId !== fixed) {
          dropped.push(`${r.plexRatingKey}→${fixed} (dropped ${r.tmdbId})`);
          return false;
        }
      } else if (seenRatingKeys.has(r.plexRatingKey)) {
        // No prior DB mapping; keep the first occurrence, drop subsequent duplicates
        return false;
      }
      seenRatingKeys.add(r.plexRatingKey);
      return true;
    });

    if (dropped.length > 0) {
      console.warn(
        `[sync/plex] ${dropped.length} conflated ratingKey(s) kept their pinned tmdbId ` +
          `(${mediaType}, instance="${serverInstance}"): ${dropped.join(", ")}`,
      );
    }
    return kept;
  };

  let finalMovieRows = await deduplicateByRatingKey(movieRows, "MOVIE", instance);
  let finalTvRows    = await deduplicateByRatingKey(tvRows,    "TV",    instance);

  if (recentOnly) {
    // Insert-only: never delete rows on this path — an empty window would nuke the whole library.
    // The already-present check is scoped to the instance being written: another server's
    // row for the same tmdbId must not mask inserting this server's own row.
    const [existingMovies, existingTv] = await Promise.all([
      prisma.plexLibraryItem.findMany({
        where: { mediaType: "MOVIE", serverInstance: instance, tmdbId: { in: finalMovieRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
      prisma.plexLibraryItem.findMany({
        where: { mediaType: "TV", serverInstance: instance, tmdbId: { in: finalTvRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
    ]);
    const existingMovieSet = new Set(existingMovies.map((r) => r.tmdbId));
    const existingTvSet    = new Set(existingTv.map((r) => r.tmdbId));
    finalMovieRows = finalMovieRows.filter((r) => !existingMovieSet.has(r.tmdbId));
    finalTvRows    = finalTvRows.filter((r)    => !existingTvSet.has(r.tmdbId));

    // Clear stale plexRatingKey → tmdbId mappings for any ratingKey we're about to insert.
    // Stays insert-only with respect to ratingKeys NOT in this batch (recentOnly contract).
    const incomingRatingKeys = [
      ...finalMovieRows.map((r) => r.plexRatingKey).filter((k): k is string => !!k),
      ...finalTvRows.map((r) => r.plexRatingKey).filter((k): k is string => !!k),
    ];

    // Advisory lock 2001,1 — serializes Plex library writes against orchestrator + concurrent
    // per-source invocations (admin "Resync Plex" while cron is mid-flight).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
      if (incomingRatingKeys.length > 0) {
        // Scoped to the instance being written: the same small integer ratingKey can
        // legitimately exist on another server — only THIS server's mapping is stale.
        await tx.plexLibraryItem.deleteMany({ where: { serverInstance: instance, plexRatingKey: { in: incomingRatingKeys } } });
      }
      if (finalMovieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, finalMovieRows);
      if (finalTvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, finalTvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  } else {

    // Advisory lock 2001,1 — see comment in the recentOnly branch above. Full replace of
    // the rows belonging to `instance` ONLY; every other server's rows survive untouched.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
      await tx.plexLibraryItem.deleteMany({ where: { mediaType: "MOVIE", serverInstance: instance } });
      await tx.plexLibraryItem.deleteMany({ where: { mediaType: "TV", serverInstance: instance } });
      if (finalMovieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, finalMovieRows);
      if (finalTvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, finalTvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  }

  // Stamp last-success so the orchestrator's 24h-stale fallback (sync/route.ts
  // pendingAvailableNotify gate) doesn't fire falsely on deployments where the
  // admin runs the per-source resync more recently than the orchestrator.
  await prisma.setting.upsert({
    where: { key: "lastPlexSyncSucceededAt" },
    update: { value: String(Date.now()) },
    create: { key: "lastPlexSyncSucceededAt", value: String(Date.now()) },
  }).catch((err) => console.error("[sync/plex] failed to stamp lastPlexSyncSucceededAt:", err));

  const requests = await prisma.mediaRequest.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
  });

  let toMark = requests.filter((req) =>
    req.mediaType === "MOVIE" ? movieIds.has(req.tmdbId) : tvIds.has(req.tmdbId)
  );

  // Per-user visibility gate for a RESTRICTED named server (guardrail 35). This run
  // describes exactly ONE server, so unlike the orchestrator — which unions every
  // server and needs per-tmdbId holder sets — the question is the same for every id:
  // may this requester see `instance`? Only a restricted instance can answer no, so
  // the default ("") server does no extra work and behaves byte-identically.
  //
  // PRE-CAS by construction: filtering `toMark` here keeps gated rows out of BOTH the
  // claimAvailableNotificationWinners call and the two updateMany flips below, so a
  // gated request keeps notifiedAvailable = false and stays PENDING/APPROVED. It is
  // re-evaluated on every later run, and the once-only claim is never burned — so the
  // legitimate notification still fires if the title lands on a server they can see,
  // or if they are granted access later.
  const instanceConfig = plexInstances.find((i) => i.slug === instance);
  if (instanceConfig?.restricted === true && toMark.length > 0) {
    const requesterRows = await prisma.user.findMany({
      where: { id: { in: [...new Set(toMark.map((r) => r.requestedBy))] } },
      // `role` is NOT optional. The raw `permissions` column is @default(0) and is
      // seeded only by a manual one-shot script, so an upgraded deployment can hold a
      // role="ADMIN" row with permissions=0. Passing that raw would deny the ADMIN
      // short-circuit HERE while every read path grants it (they all go through
      // effectivePermissions) — stranding the operator's own requests as PENDING while
      // the UI insists the title is available. Same reasoning as the orchestrator's
      // loadRequesters.
      select: { id: true, role: true, permissions: true, mediaServerGrants: true },
    });
    const byId = new Map(requesterRows.map((u) => [u.id, u]));
    toMark = toMark.filter((r) => {
      const u = byId.get(r.requestedBy);
      if (!u) return false; // requester vanished mid-run — fail closed
      return canViewMediaInstance(effectivePermissions(u.role, u.permissions), instanceConfig, parseMediaServerGrants(u.mediaServerGrants), "plex");
    });
  }

  if (toMark.length > 0) {
    const unnotified = toMark.filter((r) => !r.notifiedAvailable);
    if (unnotified.length > 0) {
      // Gate notification by the requester's mediaServer preference — mirror the
      // orchestrator's markLibraryRequests. A Plex-pinned user must NOT get a "ready to
      // watch" ping from a Jellyfin resync (and vice versa); users with no preference
      // are notified by whichever source sees the item first.
      //
      // The per-user media-server VISIBILITY gate now runs where `toMark` is built
      // above — it has to, because this route IS generalized to named instances and a
      // restricted one must not flip a request AVAILABLE (or notify) for a requester
      // who cannot see that server. The split below is the separate, older concern:
      // which SOURCE the user prefers, not which server they may see.
      const userRows = await prisma.user.findMany({
        where: { id: { in: unnotified.map((r) => r.requestedBy) } },
        select: { id: true, mediaServer: true },
      });
      const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));
      const toNotify = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !ms || ms === "plex";
      });
      // Preferred server is the OTHER source: flip to AVAILABLE but don't notify here.
      const toMarkOnly = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !!ms && ms !== "plex";
      });
      if (toNotify.length > 0) {
        // CAS on notifiedAvailable so concurrent sync paths don't double-fire notifications;
        // winner filter ensures we only notify on rows we actually flipped.
        const winners = await claimAvailableNotificationWinners(toNotify, { markAvailable: true });
        if (winners.length > 0) {
          void clearDeletionVotesForTmdbs(winners);
          notifyUsersRequestsAvailable(winners).catch(() => {});
          notifyUsersRequestsAvailablePush(winners).catch(() => {});
          void notifyUsersRequestsAvailableEmail(winners, "sync/plex");
          void writeAvailableInAppNotifications(winners, "sync/plex");
        }
      }
      if (toMarkOnly.length > 0) {
        // status IN (PENDING, APPROVED): only forward transitions — never resurrect
        // a row an admin DECLINED after this run's snapshot (AVAILABLE is terminal).
        const flipped = await prisma.mediaRequest.updateMany({
          where: { id: { in: toMarkOnly.map((r) => r.id) }, status: { in: ["PENDING", "APPROVED"] } },
          data: { status: "AVAILABLE", availableAt: new Date() },
        });
        if (flipped.count > 0) void clearDeletionVotesForTmdbs(toMarkOnly);
      }
    }

    const alreadyNotified = toMark.filter((r) => r.notifiedAvailable);
    if (alreadyNotified.length > 0) {
      // Stamp availableAt on the flip (matches the orchestrator's markLibraryRequests).
      // status IN (PENDING, APPROVED): gates timestamp rewrites on every sync tick
      // AND refuses to resurrect a concurrently-DECLINED row (AVAILABLE is terminal).
      const flipped = await prisma.mediaRequest.updateMany({
        where: { id: { in: alreadyNotified.map((r) => r.id) }, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      if (flipped.count > 0) void clearDeletionVotesForTmdbs(alreadyNotified);
    }
  }

  // DB-checked attribution (bearer-first then cookie) so a stale/revoked admin
  // JWT can't mis-attribute the audit row. Access control stays isCronAuthorized
  // (in POST above); this only attributes the admin-triggered run.
  const attributionClaims = await readActiveSummonarrSessionFromRequest(request);
  if (attributionClaims) {
    void logAudit({
      userId: attributionClaims.id,
      userName: attributionClaims.name ?? attributionClaims.id,
      action: "LIBRARY_SYNC",
      target: "sync:plex",
      details: { movies: movieIds.size, tv: tvIds.size, marked: toMark.length },
    });
  }

  return NextResponse.json({
    scanned: { movies: movieIds.size, tv: tvIds.size },
    checked: requests.length,
    marked: toMark.length,
    full: !recentOnly,
  });
}
