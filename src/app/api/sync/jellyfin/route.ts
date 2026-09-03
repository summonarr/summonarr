import { NextRequest, NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { buildSeriesItemIdIndex, libraryItemIds, getJellyfinTmdbIds, getJellyfinTVEpisodes, getJellyfinEpisodesForShow } from "@/lib/jellyfin";
import { mapLimit } from "@/lib/concurrency";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, jellyfinSettingKey, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { notifyUsersRequestsAvailable } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { canViewMediaInstance, parseMediaServerGrants, effectivePermissions } from "@/lib/permissions";
import { getCronActor, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording, type CronActor } from "@/lib/cron-auth";
import { claimAvailableNotifications, clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { notifyUsersRequestsAvailableEmail, writeAvailableInAppNotifications } from "@/lib/request-notifications";

// 2 hours — intentionally wider than the 1-hour sync interval so one missed run is survivable
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

// recentOnly episode refresh: at or below this many windowed series, fetch each
// series' episodes directly (ParentId-scoped) instead of page-walking EVERY
// episode in the library to client-filter down to 1-2 shows. Above it (a bulk
// import) the single full walk is the cheaper shape again.
const PER_SERIES_EPISODE_REFRESH_MAX = 50;

export async function POST(request: NextRequest) {
  const actor = await getCronActor(request);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withCronRunRecording("jellyfin-sync", () => syncJellyfin(request, actor));
}

// Fetches the Jellyfin library (movies + TV), writes JellyfinLibraryItem rows
// (recentOnly insert-only within the 2h window, or a full delete+replace), then
// flips matching pending/approved requests to AVAILABLE and fires notifications.
//
// Resyncs ONE Jellyfin server — the default ("") unless the body names another
// via `instance`. Every library read/delete is scoped to that server's
// serverInstance, so resyncing one can never wipe or mask another's rows.
//
// TVEpisodeCache is the exception (see the Plex counterpart for the full
// reasoning): no serverInstance column, one shared `source: "jellyfin"`
// namespace, so a single-server resync cannot produce the whole-table union a
// correct rewrite needs. It therefore rewrites the cache ONLY when it is the
// sole configured Jellyfin server — the full path previously deleted
// `source: "jellyfin"` unscoped and repopulated from this server alone, and even
// the recentOnly path's tmdbId-scoped delete removes another server's episodes
// for a show both of them hold.
async function syncJellyfin(request: NextRequest, actor: CronActor) {
  const rawBody = await readJsonCappedOr<Record<string, unknown>>(request, 8192, {});
  if (rawBody instanceof NextResponse) return rawBody;
  const recentOnly = rawBody.full !== true;

  // Which server to resync. Absent ⇒ the default, so existing callers are
  // unchanged. A malformed slug is rejected rather than coerced to "", which
  // would aim a destructive scoped delete at the wrong server.
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
  const [jellyfinConfig, librariesRow, jellyfinInstances] = await Promise.all([
    getJellyfinConfig(instance),
    prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "Libraries") } }),
    getMediaInstances("jellyfin"),
  ]);

  if (!jellyfinConfig.url || !jellyfinConfig.apiKey) {
    return NextResponse.json({ error: "Jellyfin server not configured" }, { status: 400 });
  }

  // The slug must be REGISTERED, not merely shape-valid: leftover Setting rows
  // from a pre-cleanup de-registration can still satisfy the config check, and
  // an unregistered slug would skip the restricted-visibility gate (the registry
  // entry carries `restricted`) and — on a deployment whose registry holds only
  // the default — take the episode-cache-owner branch and wipe the shared
  // TVEpisodeCache's jellyfin rows in favour of a ghost server's holdings.
  if (instance !== DEFAULT_MEDIA_INSTANCE && !jellyfinInstances.some((i) => i.slug === instance)) {
    return NextResponse.json({ error: "Unknown Jellyfin instance" }, { status: 400 });
  }

  const baseUrl = jellyfinConfig.url.replace(/\/$/, "");
  const apiKey = jellyfinConfig.apiKey;
  const selectedJellyfinIds = librariesRow?.value
    ? new Set(librariesRow.value.split(",").map((k) => k.trim()).filter(Boolean))
    : undefined;

  const minDateLastSaved = recentOnly ? new Date(Date.now() - RECENT_WINDOW_MS) : undefined;

  let movieIds: Awaited<ReturnType<typeof getJellyfinTmdbIds>>;
  let tvIds:    Awaited<ReturnType<typeof getJellyfinTmdbIds>>;
  try {
    [movieIds, tvIds] = await Promise.all([
      getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE", selectedJellyfinIds, minDateLastSaved),
      getJellyfinTmdbIds(baseUrl, apiKey, "TV", selectedJellyfinIds, minDateLastSaved),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync/jellyfin] Failed to fetch library:", msg);
    return NextResponse.json(
      { error: "Could not reach Jellyfin server" },
      { status: 502 }
    );
  }

  // Keyed on EVERY item id per series, not just the stored one — a show in two
  // libraries files its episodes under two SeriesIds and the unlisted one's
  // episodes would be dropped on the floor.
  const seriesItemIdToTmdbId = buildSeriesItemIdIndex(tvIds);

  // Fire-and-forget: episode cache is best-effort and must not block the main library write.
  // On recentOnly, scope deletes to the series we're about to repopulate so unrelated cached
  // episodes survive (the recentOnly tv filter is a 2h window, not the whole library).
  const episodeRecentOnly = recentOnly;
  // Deduped: a duplicated series contributes one entry per item id.
  const tmdbIdsBeingReplaced = Array.from(new Set(seriesItemIdToTmdbId.values()));
  // Decided BEFORE the fetch, like the Plex twin: bailing out inside the .then()
  // still page-walked every Episode in the library first, then threw the whole
  // result away on any multi-server install.
  const ownsEpisodeCache = jellyfinInstances.length <= 1;
  if (!ownsEpisodeCache) {
    console.warn(
      `[sync/jellyfin] ${jellyfinInstances.length} Jellyfin servers configured — leaving the shared TVEpisodeCache to the orchestrator, which rebuilds it from every server.`,
    );
  }
  (ownsEpisodeCache
    ? (episodeRecentOnly && seriesItemIdToTmdbId.size > 0 && seriesItemIdToTmdbId.size <= PER_SERIES_EPISODE_REFRESH_MAX
        // Bounded per-series fan-out (the fix-match pattern, concurrency matching
        // the library walker's MAX_PARALLEL_PAGES). Output is identical to the
        // full walk's client-side SeriesId filter for these series; the
        // tmdbId-scoped delete + insert downstream is unchanged. size === 0
        // falls through to getJellyfinTVEpisodes, which short-circuits to []
        // without fetching — byte-identical to before.
        ? mapLimit(Array.from(seriesItemIdToTmdbId.entries()), 3, ([itemId, tmdbId]) =>
            getJellyfinEpisodesForShow(baseUrl, apiKey, itemId, tmdbId),
          ).then((perSeries) => perSeries.flat())
        : getJellyfinTVEpisodes(baseUrl, apiKey, selectedJellyfinIds, seriesItemIdToTmdbId))
    : Promise.resolve(null)
  )
    .then(async (episodes) => {
      if (episodes === null) return;
      // recentOnly is insert-only within the window: an empty result means nothing new,
      // so skip entirely (a delete here would violate guardrail 13). The full path,
      // however, must clear on empty — getJellyfinTVEpisodes throws on a fetch failure
      // (rejects → .catch), so an empty full result is a genuinely empty library whose
      // stale episode ownership must be cleared.
      if (episodeRecentOnly && episodes.length === 0) return;
      await prisma.$transaction(async (tx) => {
        // Advisory lock 2002,2 — Jellyfin TVEpisodeCache coordination. Shared with
        // /api/sync/route and /api/sync/tv-episodes so a recentOnly tmdbId-scoped delete can't
        // be interleaved with a wholesale rewrite from another runner.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
        if (episodeRecentOnly) {
          if (tmdbIdsBeingReplaced.length > 0) {
            await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin", tmdbId: { in: tmdbIdsBeingReplaced } } });
          }
        } else {
          await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
        }
        if (episodes.length > 0) {
          await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source: "jellyfin" as const, ...e })));
        }
      }, { timeout: BATCH_TX_TIMEOUT });
    })
    .catch((err) => console.error("[sync/jellyfin] Episode cache failed:", err));

  const sanitizeStr = (s: string | null | undefined, maxLen = 1000): string | null => {
    if (s == null) return null;
    return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
  };

  // `serverInstance` is NOT optional here — see the Plex twin. The deletes below are
  // scoped to `instance`, so omitting it made a named-instance resync delete that
  // server's rows and re-insert the whole library under the schema default "",
  // moving it onto the DEFAULT server and un-restricting a `restricted` one.
  const movieRows = Array.from(movieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, serverInstance: instance, mediaType: "MOVIE" as const, filePath: d.filePath, jellyfinItemId: d.itemId, jellyfinItemIds: libraryItemIds(d), title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
  const tvRows    = Array.from(tvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, serverInstance: instance, mediaType: "TV"    as const, filePath: d.filePath, jellyfinItemId: d.itemId, jellyfinItemIds: libraryItemIds(d), title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));

  if (recentOnly) {
    // Insert-only: never delete rows on this path — an empty window would nuke the whole library.
    // The already-present check is default-instance-scoped: a named instance's row for the same
    // tmdbId must not mask inserting the default instance's own row.
    const [existingMovies, existingTv] = await Promise.all([
      prisma.jellyfinLibraryItem.findMany({
        where: { mediaType: "MOVIE", serverInstance: instance, tmdbId: { in: movieRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
      prisma.jellyfinLibraryItem.findMany({
        where: { mediaType: "TV", serverInstance: instance, tmdbId: { in: tvRows.map((r) => r.tmdbId) } },
        select: { tmdbId: true },
      }),
    ]);
    const existingMovieSet = new Set(existingMovies.map((r) => r.tmdbId));
    const existingTvSet    = new Set(existingTv.map((r) => r.tmdbId));
    const newMovieRows = movieRows.filter((r) => !existingMovieSet.has(r.tmdbId));
    const newTvRows    = tvRows.filter((r)    => !existingTvSet.has(r.tmdbId));
    // Advisory lock 2001,2 — serializes Jellyfin library writes against orchestrator + concurrent
    // per-source invocations (admin "Resync Jellyfin" while cron is mid-flight).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
      if (newMovieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, newMovieRows);
      if (newTvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, newTvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  } else {

    // Advisory lock 2001,2 — see comment in the recentOnly branch above. Full replace of
    // the DEFAULT instance's rows only — an unscoped deleteMany here would wipe every
    // named instance's rows and repopulate only the default's (availability flicker
    // until the next orchestrator run).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
      await tx.jellyfinLibraryItem.deleteMany({ where: { serverInstance: instance } });
      if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
      if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
    }, { timeout: BATCH_TX_TIMEOUT });
  }

  // Stamp last-success so the orchestrator's 24h-stale fallback (sync/route.ts
  // pendingAvailableNotify gate) doesn't fire falsely on deployments where the
  // admin runs the per-source resync more recently than the orchestrator.
  await prisma.setting.upsert({
    where: { key: "lastJellyfinSyncSucceededAt" },
    update: { value: String(Date.now()) },
    create: { key: "lastJellyfinSyncSucceededAt", value: String(Date.now()) },
  }).catch((err) => console.error("[sync/jellyfin] failed to stamp lastJellyfinSyncSucceededAt:", err));

  const requests = await prisma.mediaRequest.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
  });

  let toMark = requests.filter((req) =>
    req.mediaType === "MOVIE" ? movieIds.has(req.tmdbId) : tvIds.has(req.tmdbId)
  );

  // Per-user visibility gate for a RESTRICTED named server (guardrail 35) — the Jellyfin
  // twin of the Plex gate; see that route for the full reasoning. This run describes
  // exactly ONE server, so the question is the same for every id: may this requester see
  // `instance`? Only a restricted instance can answer no, so the default ("") server
  // does no extra work and behaves byte-identically.
  //
  // PRE-CAS by construction: filtering `toMark` keeps gated rows out of BOTH the
  // claimAvailableNotificationWinners call and the updateMany flips, so a gated request
  // keeps notifiedAvailable = false, stays PENDING/APPROVED, and is re-evaluated later
  // rather than having its once-only claim burned.
  const instanceConfig = jellyfinInstances.find((i) => i.slug === instance);
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
      return canViewMediaInstance(effectivePermissions(u.role, u.permissions), instanceConfig, parseMediaServerGrants(u.mediaServerGrants), "jellyfin");
    });
  }

  if (toMark.length > 0) {
    const unnotified = toMark.filter((r) => !r.notifiedAvailable);
    if (unnotified.length > 0) {
      // Gate notification by the requester's mediaServer preference — mirror the
      // orchestrator's markLibraryRequests. A Jellyfin-pinned user must NOT get a "ready
      // to watch" ping from a Plex resync (and vice versa); users with no preference are
      // notified by whichever source sees the item first.
      //
      // The per-user media-server VISIBILITY gate now runs where `toMark` is built
      // above — it has to, because this route IS generalized to named instances. The
      // split below is the separate, older concern: which SOURCE the user prefers,
      // not which server they may see.
      const userRows = await prisma.user.findMany({
        where: { id: { in: unnotified.map((r) => r.requestedBy) } },
        select: { id: true, mediaServer: true },
      });
      const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));
      const toNotify = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !ms || ms === "jellyfin";
      });
      // Preferred server is the OTHER source: flip to AVAILABLE but don't notify here.
      const toMarkOnly = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !!ms && ms !== "jellyfin";
      });
      if (toNotify.length > 0) {
        // CAS on notifiedAvailable so concurrent sync paths don't double-fire notifications;
        // winner filter ensures we only notify on rows we actually flipped.
        // `claimed` is every row the CAS flipped; `deliverable` drops the ones whose
        // requester is disabled. Consequences of the TRANSITION key off `claimed` —
        // that row went AVAILABLE too, and its claim is already burned, so nothing
        // later would wipe its stale deletion votes. Only delivery keys off the split.
        const { claimed, deliverable } = await claimAvailableNotifications(toNotify, { markAvailable: true });
        if (claimed.length > 0) {
          // The claim helper sets status/availableAt/notifiedAvailable but not
          // pendingNotifyAt — disarm the 90s "still pending" backstop on the
          // same transition (mirrors the orchestrator's post-claim clear).
          await prisma.mediaRequest.updateMany({
            where: { id: { in: claimed.map((w) => w.id) } },
            data: { pendingNotifyAt: null },
          });
          void clearDeletionVotesForTmdbs(claimed);
        }
        if (deliverable.length > 0) {
          notifyUsersRequestsAvailable(deliverable).catch(() => {});
          notifyUsersRequestsAvailablePush(deliverable).catch(() => {});
          void notifyUsersRequestsAvailableEmail(deliverable, "sync/jellyfin");
          void writeAvailableInAppNotifications(deliverable, "sync/jellyfin");
        }
      }
      if (toMarkOnly.length > 0) {
        // status IN (PENDING, APPROVED): only forward transitions — never resurrect
        // a row an admin DECLINED after this run's snapshot (AVAILABLE is terminal).
        const flipped = await prisma.mediaRequest.updateMany({
          where: { id: { in: toMarkOnly.map((r) => r.id) }, status: { in: ["PENDING", "APPROVED"] } },
          data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
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
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
      if (flipped.count > 0) void clearDeletionVotesForTmdbs(alreadyNotified);
    }
  }

  // Attribution comes from the SAME DB-checked session read that authorized the
  // request (getCronActor in POST), consistent with the orchestrator/plex sync.
  // A CRON_SECRET run has no session to attribute.
  if (actor.trigger === "admin") {
    void logAudit({
      userId: actor.userId,
      userName: actor.userName,
      action: "LIBRARY_SYNC",
      target: "sync:jellyfin",
      details: { movies: movieIds.size, tv: tvIds.size, marked: toMark.length, full: !recentOnly },
    });
  }

  return NextResponse.json({
    scanned: { movies: movieIds.size, tv: tvIds.size },
    checked: requests.length,
    marked: toMark.length,
    full: !recentOnly,
  });
}
