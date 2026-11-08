import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { prisma } from "@/lib/prisma";
import { attachArrPending } from "@/lib/arr-availability";
import { getSonarrSeriesCompletion, isArrConfigured, isMovieWantedInRadarr } from "@/lib/arr";
import { getArrInstances } from "@/lib/arr-instance-registry";
import type { ArrInstanceConfig } from "@/lib/arr-instances";
import { mapLimit } from "@/lib/concurrency";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { check, v } from "@/lib/validate";

// Read-only diagnostic. The one write it can cause is indirect and deliberate:
// the TV live check goes through lookupSeriesByTmdbId, whose TMDB TVDB
// cross-reference fallback (guardrail 14a) populates the `tmdb-to-tvdb:` cache
// row exactly as every real read path does. Nothing here writes a row of its
// own, and the `tvdb-to-tmdb:` dump below reads its row directly rather than
// through getCache, whose lazy expired-row delete would destroy the very
// evidence (a stale negative mapping) this route exists to show.

type LiveCheck = { result: boolean; error?: string };
type LiveCompletion =
  | { tvdbId: number; episodeFileCount: number; episodeCount: number; complete: boolean; basis: "seasons" | "series" }
  | { result: null; error?: string };
type InstanceState = {
  slug: string;
  name: string;
  cacheRow: unknown;
  hasEntry: boolean;
  liveArrApi: LiveCheck;
  liveCompletion?: LiveCompletion;
};

// One instance's cache row and live answer. Movies ask Radarr whether the
// title is wanted. TV asks Sonarr ONCE per instance (lookup + the ?tvdbId=
// library read) for the series' completion, and derives "wanted" from it
// (`match && !complete`): reading it separately doubled the 30s-timeout
// round-trips on a route reached precisely when Sonarr is slow, and let a
// transient failure make the two disagree about one series in one response.
// The completion is WHY a request has not flipped: a TV request goes
// AVAILABLE only once Sonarr reports the series complete (guardrail 14a), so
// the aired counts — e.g. 59/60 — answer "it's in Plex, why is it still
// APPROVED". `basis: "series"` flags a payload with no per-season stats,
// where specials could not be excluded from the count.
async function instanceState(inst: ArrInstanceConfig, type: "movie" | "tv", tmdbId: number): Promise<InstanceState> {
  const where = { tmdbId_arrInstance: { tmdbId, arrInstance: inst.slug } };
  const cacheRow = type === "movie"
    ? await prisma.radarrWantedItem.findUnique({ where })
    : await prisma.sonarrWantedItem.findUnique({ where });
  const base = { slug: inst.slug, name: inst.name, cacheRow, hasEntry: !!cacheRow };
  if (type === "movie") {
    try {
      return { ...base, liveArrApi: { result: await isMovieWantedInRadarr(tmdbId, inst.slug) } };
    } catch (err) {
      // Don't leak raw Arr error detail (may carry the configured server URL /
      // upstream body) to the client — log it server-side, return a generic flag.
      console.error(`[arr-state] live Arr check failed (instance=${inst.slug}):`, err instanceof Error ? err.message : err);
      return { ...base, liveArrApi: { result: false, error: "live Arr check failed" } };
    }
  }
  try {
    const completion = await getSonarrSeriesCompletion(tmdbId, inst.slug);
    return { ...base, liveArrApi: { result: completion ? !completion.complete : false }, liveCompletion: completion ?? { result: null } };
  } catch (err) {
    console.error(`[arr-state] live Sonarr completion check failed (instance=${inst.slug}):`, err instanceof Error ? err.message : err);
    return {
      ...base,
      liveArrApi: { result: false, error: "live Arr check failed" },
      liveCompletion: { result: null, error: "live Sonarr completion check failed" },
    };
  }
}

// The tvdb→tmdb section. The tvdbId comes from the per-instance completion
// results — i.e. from lookupSeriesByTmdbId, the SAME resolver (direct tmdb
// lookup, then TMDB's TVDB cross-reference) every real read path and the
// approve use (guardrail 14a). A private `term=tmdb:` lookup against the
// DEFAULT instance contradicted the pipeline it diagnoses twice over: it
// reported `tvdbId: null` for the lagging-index case 14a documents while
// `instances[].liveCompletion` carried the resolved id, and on a deployment
// whose only Sonarr is a NAMED instance it was null for every title. Default
// instance first, then the first instance that resolved.
function resolvedTvdb(instances: InstanceState[]): { slug: string; tvdbId: number } | null {
  const ordered = [...instances.filter((i) => i.slug === ""), ...instances.filter((i) => i.slug !== "")];
  for (const i of ordered) {
    if (i.liveCompletion && "tvdbId" in i.liveCompletion && i.liveCompletion.tvdbId) {
      return { slug: i.slug, tvdbId: i.liveCompletion.tvdbId };
    }
  }
  return null;
}

type TvdbInfo = {
  tvdbId: number | null;
  tvdbIdInstance?: string;
  cachedMapping?: { tmdbId: number | null } | null;
  cachedMappingRow?: { data: string; cachedAt: string; expiresAt: string; stale: boolean } | null;
  error?: string;
};

const CACHED_MAPPING = v.object({ tmdbId: v.nullable(v.int()) });

async function tvdbSection(instances: InstanceState[]): Promise<TvdbInfo> {
  const resolved = resolvedTvdb(instances);
  if (!resolved) {
    // `cachedMapping` must be null here, not `{ tmdbId: null }` — that shape is
    // exactly what a genuine NEGATIVE tvdb→tmdb cache entry looks like, and
    // nothing was read (no instance produced a tvdbId to key on). The error
    // flag is set only when some configured instance's check actually failed
    // (its real detail is already logged); "Sonarr simply doesn't know this
    // show" on every instance is a null without an error.
    const anyFailed = instances.some((i) => i.liveCompletion !== undefined && "error" in i.liveCompletion);
    return { tvdbId: null, cachedMapping: null, ...(anyFailed ? { error: "sonarr lookup failed" } : {}) };
  }
  // Read the row DIRECTLY (ratings-state's rule): getCache lazily DELETES an
  // expired row and answers null — indistinguishable from "never cached",
  // and the stale negative mapping the operator came to inspect is gone.
  // `stale` carries the expiry verdict instead; `cachedMapping` keeps the
  // parsed shape (`{ tmdbId: null }` IS a genuine negative entry) for the
  // existing readers, now including an expired row.
  const row = await prisma.tmdbCache.findUnique({ where: { key: `tvdb-to-tmdb:${resolved.tvdbId}` } });
  let cachedMapping: { tmdbId: number | null } | null = null;
  if (row) {
    // A blob that isn't the mapping shape shows as unreadable (null), never as a
    // genuine negative entry.
    try {
      const parsed = check(CACHED_MAPPING, JSON.parse(row.data));
      cachedMapping = parsed.ok ? parsed.value : null;
    } catch { cachedMapping = null; }
  }
  return {
    tvdbId: resolved.tvdbId,
    tvdbIdInstance: resolved.slug,
    cachedMapping,
    cachedMappingRow: row
      ? { data: row.data, cachedAt: row.cachedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), stale: row.expiresAt.getTime() <= Date.now() }
      : null,
  };
}

async function lastFullSync(): Promise<{ at: Date; details: unknown } | null> {
  const lastSync = await prisma.auditLog.findFirst({
    where: { action: "LIBRARY_SYNC" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!lastSync) return null;
  let details: unknown = null;
  if (lastSync.details) {
    try { details = JSON.parse(lastSync.details); } catch { details = lastSync.details; }
  }
  return { at: lastSync.createdAt, details };
}

export const GET = withAdmin(async (req, _ctx, _session) => {
  const sp = req.nextUrl.searchParams;
  const tmdbIdRaw = sp.get("tmdbId");
  const type = sp.get("type");
  if (!tmdbIdRaw || (type !== "movie" && type !== "tv")) {
    return NextResponse.json({ error: "tmdbId and type=movie|tv required" }, { status: 400 });
  }
  const tmdbId = Number(tmdbIdRaw);
  if (!isTmdbIdInRange(tmdbId)) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  const dbType: "MOVIE" | "TV" = type === "movie" ? "MOVIE" : "TV";

  // attachArrPending only needs id and mediaType; other fields are irrelevant for this diagnostic
  const stub: TmdbMedia = {
    id: tmdbId,
    mediaType: type,
    title: "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: "",
    voteAverage: 0,
  };

  const service = type === "movie" ? "radarr" : "sonarr";

  // Generalized per-instance view: iterate every configured instance (default
  // first, plus legacy 4k and any named instances) so the diagnostic can explain
  // a missing badge on ANY instance, not just HD/4K. The legacy top-level
  // `cacheTable` / `fourK` / `liveArrApi` fields are DERIVED from this list below
  // (getArrInstances always yields the default first and includes "4k" whenever
  // it is configured) — re-reading the rows / re-running the live checks for
  // those two slugs doubled the DB reads and the 30s-timeout Arr round-trips on
  // a route meant to be hit whenever a badge looks wrong.
  //
  // The reads that don't depend on the live checks run beside them (a fixed
  // handful, guardrail 31) rather than after the slowest Arr call.
  const [[instanceConfigs, has4kInstance], mediaRequests, enriched, lastSync, radarrTotal, sonarrTotal] = await Promise.all([
    Promise.all([getArrInstances(service), isArrConfigured(service, "4k")]),
    prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType: dbType },
      select: { id: true, status: true, requestedBy: true, tvdbId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "desc" },
    }),
    attachArrPending([stub]),
    lastFullSync(),
    prisma.radarrWantedItem.count(),
    prisma.sonarrWantedItem.count(),
  ]);
  const instances = await mapLimit(instanceConfigs, 4, (inst) => instanceState(inst, type, tmdbId));

  // Legacy HD/4K sections, derived from the per-instance results (additive: the
  // debug UI still reads them). `has4kInstance` is its own predicate on purpose —
  // a registry-listed-but-unconfigured "4k" entry still appears in `instances`,
  // so mere presence there must not report the instance as configured. The
  // default is always listed (getArrInstances), so its live check is always there.
  const defaultInst = instances.find((i) => i.slug === "");
  const fourKInst = instances.find((i) => i.slug === "4k");
  const wantedRow = defaultInst?.cacheRow ?? null;
  const wanted4kRow = fourKInst?.cacheRow ?? null;
  const liveCheck: LiveCheck = defaultInst?.liveArrApi ?? { result: false };
  const liveCheck4k: LiveCheck | null = has4kInstance ? (fourKInst?.liveArrApi ?? null) : null;
  const tvdbInfo = type === "tv" ? await tvdbSection(instances) : null;

  return NextResponse.json({
    query: { tmdbId, type },
    cacheTable: {
      tableName: type === "movie" ? "radarrWantedItem" : "sonarrWantedItem",
      row: wantedRow,
      hasEntry: !!wantedRow,
    },
    fourK: {
      instanceConfigured: has4kInstance,
      cacheRow: wanted4kRow,
      hasEntry: !!wanted4kRow,
      liveArrApi: liveCheck4k,
    },
    instances,
    attachArrPendingReturns: enriched[0]?.arrPending ?? false,
    liveArrApi: liveCheck,
    mediaRequests,
    tvdbInfo,
    wantedTableTotals: { radarr: radarrTotal, sonarr: sonarrTotal },
    lastFullSync: lastSync,
  });
});
