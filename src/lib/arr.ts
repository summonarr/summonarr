// The Radarr/Sonarr client's entry point. Every importer reads "@/lib/arr"; most
// of the code lives in flat siblings, re-exported here:
//   arr-client.ts       the transport (arrFetch), read retry, errors
//   arr-config.ts       an instance's Setting-backed config, profiles, connection test
//   arr-id-map.ts       tvdb↔tmdb cross-references and the Sonarr series lookup
//   arr-lookup.ts       a title by the arr's own ids (library row, episode)
//   arr-add.ts          the add flow (the approval's push, the sync's re-push)
//   arr-releases.ts     interactive release search and grab
//   arr-queue-cache.ts  "is it in the download queue?"
// This file keeps the library verdicts (the wanted/available sets, the webhooks'
// download checks, the arr-state diagnostic), the search commands and the movie
// release dates.
import { safeFetchTrusted } from "./safe-fetch";
import { getCache, setCache, TTL } from "./tmdb-cache";
import { tmdbAuth } from "./tmdb-auth";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { posInt } from "./arr-parse";
import { sonarrSeriesCompletion, type SonarrSeriesCompletion, type SonarrSeriesStatsRow } from "./sonarr-completion";
import { check, v } from "./validate";
import { arrErrorMessage, arrFetch, ArrItemNotFoundError, asRecord, unusableAnswer, type ArrCfg } from "./arr-client";
import { getArrCfg, getCfg, requireArrCfg, type ArrVariant } from "./arr-config";
import { lookupSeriesByTmdbId, lookupSeriesIdsCached, resolveTmdbToTvdb, resolveTvdbToTmdb } from "./arr-id-map";
import { findEpisodeId, findRadarrMovie, findSonarrSeries, requireRadarrMovie, requireSonarrSeries } from "./arr-lookup";

export {
  ArrItemNotFoundError,
  ArrResponseError,
  arrErrorKind,
  arrErrorMessage,
  arrErrorMessageForClient,
  arrFetch,
  arrFetchNoContent,
  arrReadRetry,
  arrWriteOutcomeUnknown,
  retryTransientRead,
  type ArrCfg,
  type ArrFetchOptions,
} from "./arr-client";
export {
  MAX_QUALITY_PROFILES,
  getArrAddDefaults,
  getArrCfg,
  isArrConfigured,
  listQualityProfiles,
  testRadarrConnection,
  testSonarrConnection,
  type ArrVariant,
} from "./arr-config";
export {
  lookupSeriesByTmdbId,
  pickSeriesByTmdbId,
  pickSeriesByTvdbCrossRef,
  resolveSingleTvdbToTmdb,
  resolveTmdbToTvdb,
  resolveTvdbToTmdb,
} from "./arr-id-map";
export { addMovieToRadarr, addSeriesToSonarr, type AddProgress } from "./arr-add";
export {
  ArrReleaseGrabError,
  RELEASE_GRAB_TIMEOUT_MS,
  RELEASE_SEARCH_TIMEOUT_MS,
  ReleaseSeasonRequiredError,
  getReleasesForMovie,
  getReleasesForSeries,
  grabMovieRelease,
  grabSeriesRelease,
  postReleaseGrab,
  searchReleasesByArrId,
  toArrRelease,
  type ArrRelease,
  type GrabProgress,
} from "./arr-releases";
export { countRadarrQueue, countSonarrQueue, isMovieDownloadingInRadarr, isSeriesDownloadingInSonarr } from "./arr-queue-cache";

// ── the wanted/available sets (arr-cache-refresh.ts) ────────────────────────

/**
 * One instance's library split into the titles it still wants and the ones it
 * has. `partial` (Sonarr only): some series could not be mapped to a tmdbId this
 * run (TMDB unreachable, rate-limited or not configured), so they are missing
 * from both sets — the sets are not the whole library, and the cache refresh
 * keeps the rows it can't account for instead of evicting them.
 */
export type ArrWantedSets = { wanted: Set<number>; available: Set<number>; partial?: boolean };

export async function getRadarrWantedTmdbIds(variant: ArrVariant = ""): Promise<ArrWantedSets | null> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) return { wanted: new Set(), available: new Set() };
  try {
    const movies = await arrFetch<unknown>(cfg, "/api/v3/movie");
    if (!Array.isArray(movies)) throw unusableAnswer("Radarr", "library");
    const wanted = new Set<number>();
    const available = new Set<number>();
    for (const x of movies) {
      const movie = asRecord(x);
      const tmdbId = posInt(movie?.tmdbId);
      if (!movie || tmdbId === null) continue;
      if (movie.hasFile === true) available.add(tmdbId); else wanted.add(tmdbId);
    }
    return { wanted, available };
  } catch (err) {
    console.error("[arr] getRadarrWantedTmdbIds failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getSonarrWantedTmdbIds(variant: ArrVariant = ""): Promise<ArrWantedSets | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return { wanted: new Set(), available: new Set() };
  try {
    const series = await arrFetch<unknown>(cfg, "/api/v3/series");
    if (!Array.isArray(series)) throw unusableAnswer("Sonarr", "library");
    const wanted = new Set<number>();
    const available = new Set<number>();
    const wantedNeedsResolve: number[] = [];
    const availableNeedsResolve: number[] = [];
    for (const x of series) {
      const s = asRecord(x);
      if (!s) continue;
      // "Available" = COMPLETE: every aired, monitored, regular-season episode
      // has a file (guardrail 14a). A continuing series with a partial season
      // is WANTED, not available — the request must not flip AVAILABLE (and
      // notify "ready to watch") off the first episode of a season pack, and
      // Plex/Jellyfin presence alone must not flip it either (the library
      // marking passes defer to this wanted row). The rule lives in ONE place,
      // sonarrSeriesCompletion, shared with the webhook's authoritative check
      // below, so the two writers can never disagree and flip-flop a request.
      //
      // The helper also guards a missing/malformed `statistics` block: one
      // anomalous /api/v3/series row would otherwise throw here, trip the outer
      // catch, and silently skip the entire wanted/available cache update run
      // after run — an opaque availability freeze. Missing stats read as zero
      // files (wanted). It checks every field it reads (Array.isArray, typeof),
      // so any upstream row is safe to hand it — hence the casts here and below.
      const isAvailable = sonarrSeriesCompletion(s as SonarrSeriesStatsRow).complete;
      const tmdbId = posInt(s.tmdbId);
      const tvdbId = posInt(s.tvdbId);
      if (tmdbId !== null) {
        if (isAvailable) available.add(tmdbId); else wanted.add(tmdbId);
      } else if (tvdbId !== null) {
        if (isAvailable) availableNeedsResolve.push(tvdbId); else wantedNeedsResolve.push(tvdbId);
      }
    }
    const allNeedsResolve = [...new Set([...wantedNeedsResolve, ...availableNeedsResolve])];
    if (allNeedsResolve.length === 0) return { wanted, available };
    const { map, hadErrors } = await resolveTvdbToTmdb(allNeedsResolve);
    for (const tvdbId of wantedNeedsResolve) {
      const tmdbId = map.get(tvdbId);
      if (tmdbId !== undefined) wanted.add(tmdbId);
    }
    for (const tvdbId of availableNeedsResolve) {
      const tmdbId = map.get(tvdbId);
      if (tmdbId !== undefined) available.add(tmdbId);
    }
    // A tvdb→tmdb resolution failure (TMDB unreachable / 429 / auth missing)
    // leaves those series out of BOTH sets. The cache refresh replaces this
    // instance's rows from the result, so their vanishing could revert a
    // previously-AVAILABLE TV request: it is marked `partial`, and the refresh
    // keeps the cached rows it can't account for. Everything that DID resolve
    // still updates — one series TMDB keeps failing on (or a missing TMDB
    // token) used to freeze the whole Sonarr cache indefinitely.
    const warnKey = `arr:sonarr-wanted-partial:${variant}`;
    if (!hadErrors) {
      forgetWarnOnChange(warnKey);
      return { wanted, available };
    }
    warnOnChange(warnKey, "partial", "[arr] getSonarrWantedTmdbIds: tvdb→tmdb resolution incomplete; keeping the unresolved series' cached rows this run");
    return { wanted, available, partial: true };
  } catch (err) {
    console.error("[arr] getSonarrWantedTmdbIds failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * A partial result (ArrWantedSets.partial) merged with the instance's cached
 * rows: every cached title the new sets don't mention keeps its row as it was
 * (it may be a series that just couldn't be mapped this run), while every
 * mentioned title takes the table the new sets give it. A complete result is
 * returned as it is. Pure.
 */
export function mergePartialWantedSets(
  result: ArrWantedSets,
  cached: { wanted: Iterable<number>; available: Iterable<number> },
): { wanted: Set<number>; available: Set<number> } {
  if (!result.partial) return { wanted: result.wanted, available: result.available };
  const wanted = new Set(result.wanted);
  const available = new Set(result.available);
  const mentioned = (tmdbId: number) => result.wanted.has(tmdbId) || result.available.has(tmdbId);
  for (const tmdbId of cached.wanted) if (!mentioned(tmdbId)) wanted.add(tmdbId);
  for (const tmdbId of cached.available) if (!mentioned(tmdbId) && !wanted.has(tmdbId)) available.add(tmdbId);
  return { wanted, available };
}

// ── movie release dates (TMDB) ──────────────────────────────────────────────

// Radarr's own rule for a title with no home-release date at all: it counts as
// released once it left cinemas this long ago (its `status` turns "released" —
// the add path trusts the same rule).
const ESTIMATED_HOME_RELEASE_DAYS = 90;

// The cached row: the earliest digital (type 4) and physical (type 5) date in
// any region, and TMDB's primary date (normally the theatrical one). A row of
// any other shape is a miss.
const ReleaseInfo = v.object({
  digital: v.optional(v.nullable(v.string())),
  physical: v.optional(v.nullable(v.string())),
  primary: v.optional(v.nullable(v.string())),
});
type ReleaseInfo = { digital: string | null; physical: string | null; primary: string | null };

const TmdbReleaseDates = v.object({
  release_date: v.optional(v.nullable(v.string())),
  release_dates: v.optional(v.nullable(v.object({
    results: v.optional(v.nullable(v.array(v.object({
      release_dates: v.optional(v.nullable(v.array(v.object({
        type: v.optional(v.nullable(v.number())),
        release_date: v.optional(v.nullable(v.string())),
      })))),
    })))),
  }))),
});

/**
 * The home-release dates download-check gates on. A title with a digital or
 * physical date anywhere uses those. One with neither — a film in cinemas with
 * no home date announced, or a dateless back-catalog title — is estimated at
 * its primary (theatrical) date plus ESTIMATED_HOME_RELEASE_DAYS: the
 * theatrical date itself is NOT a home release (reporting it as one read an
 * in-cinemas-only film as released, so the requester was told "download
 * pending" instead of "awaiting release"), while an old title's estimate is
 * long past, so it still reads released rather than forever-unreleased. Pure.
 */
function homeReleaseDates(info: ReleaseInfo): { digitalRelease: string | null; physicalRelease: string | null } {
  if (info.digital !== null || info.physical !== null) {
    return { digitalRelease: info.digital, physicalRelease: info.physical };
  }
  const primaryMs = info.primary ? Date.parse(info.primary) : NaN;
  const estimate = Number.isFinite(primaryMs)
    ? new Date(primaryMs + ESTIMATED_HOME_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;
  return { digitalRelease: estimate, physicalRelease: estimate };
}

// Earliest digital/physical date across every region (ISO strings —
// lexicographic min is chronological min).
function releaseInfoFrom(body: { release_date?: string | null; release_dates?: { results?: Array<{ release_dates?: Array<{ type?: number | null; release_date?: string | null }> | null }> | null } | null }): ReleaseInfo {
  let digital: string | null = null;
  let physical: string | null = null;
  for (const region of body.release_dates?.results ?? []) {
    for (const rd of region.release_dates ?? []) {
      if (!rd.release_date) continue;
      if (rd.type === 4 && (digital === null || rd.release_date < digital)) digital = rd.release_date;
      if (rd.type === 5 && (physical === null || rd.release_date < physical)) physical = rd.release_date;
    }
  }
  return { digital, physical, primary: body.release_date ?? null };
}

export async function getMovieReleaseInfo(tmdbId: number): Promise<{
  digitalRelease: string | null;
  physicalRelease: string | null;
} | null> {
  const auth = tmdbAuth();
  if (!auth) return null;
  // DEDICATED key — never `movie:${id}:details`. That key belongs to
  // getMovieDetails (tmdb.ts) and holds a NORMALIZED TmdbMedia; this fn used to
  // write the raw snake_case TMDB body under it, poisoning the detail page
  // (mediaType/posterPath/releaseDate all undefined) for the rest of the 7-day
  // TTL — and reading a normalized blob back here found no `release_date`, so
  // release gating silently returned null dates. Store only the fields we need.
  //
  // :v2 — the v1 rows held only the primary release_date, which is normally the
  // THEATRICAL date. v2 rows carry the real per-type dates from /release_dates
  // (type 4 = Digital, 5 = Physical); v1 rows age out via their own TTL. The
  // calendar feed reads these rows directly (calendar-events.ts), so their
  // shape stays { digital, physical, primary }.
  const cacheKey = `movie:${tmdbId}:release-info:v2`;
  try {
    const cached = check(ReleaseInfo, await getCache<unknown>(cacheKey));
    let details: ReleaseInfo | null = cached.ok
      ? { digital: cached.value.digital ?? null, physical: cached.value.physical ?? null, primary: cached.value.primary ?? null }
      : null;
    if (!details) {
      const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
      url.searchParams.set("append_to_response", "release_dates");
      const res = await safeFetchTrusted(url.toString(), {
        allowedHosts: ["api.themoviedb.org"],
        headers: auth.headers,
        timeoutMs: 10_000,
      });
      const logKey = `arr:release-info:${tmdbId}`;
      if (!res.ok) {
        warnOnChange(logKey, String(res.status), `[arr] TMDB release dates for ${tmdbId} answered ${res.status}`);
        return null;
      }
      const body = check(TmdbReleaseDates, await res.json());
      // An unusable answer is a failed fetch: nothing is cached.
      if (!body.ok) {
        warnOnChange(logKey, "unusable", `[arr] TMDB release dates for ${tmdbId} sent an unusable answer`);
        return null;
      }
      forgetWarnOnChange(logKey);
      details = releaseInfoFrom(body.value);
      // The answer is good whether or not it could be kept.
      await setCache(cacheKey, details, TTL.DETAILS).catch((err: unknown) => {
        console.warn("[arr] release-info cache write failed for tmdbId %s:", tmdbId, err instanceof Error ? err.message : err);
      });
    }
    return homeReleaseDates(details);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnOnChange(`arr:release-info:${tmdbId}`, message, `[arr] TMDB release dates for ${tmdbId} failed: ${message}`);
    return null;
  }
}

// ── Sonarr series by tmdb id ────────────────────────────────────────────────

export async function getSeriesFirstAired(tmdbId: number, variant: ArrVariant = ""): Promise<string | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return null;
  try {
    return (await lookupSeriesIdsCached(cfg, tmdbId))?.firstAired ?? null;
  } catch { return null; }
}

// Live "is this movie wanted" for the arr-state diagnostic. false = unconfigured
// or Radarr holds it with a file (or not at all). A Radarr request failure
// THROWS, like getSonarrSeriesCompletion, so the route reports it instead of a
// confident false during an outage.
export async function isMovieWantedInRadarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) return false;
  const movie = await findRadarrMovie(cfg, tmdbId);
  return movie !== null && movie.hasFile !== true;
}

// Authoritative "is this movie actually downloaded" check, used by the Radarr
// webhook to confirm against Radarr's live library before acting on a webhook
// payload. The webhook is authenticated only by a shared secret (no per-payload
// signature — the upstream services don't sign), so a caller who learns that
// secret could POST a forged Download event carrying an arbitrary tmdbId and
// flip an APPROVED request to AVAILABLE for a title Radarr never downloaded.
// Re-querying Radarr for the movie's hasFile flag closes that gap: we trust the
// upstream library's own state rather than the (spoofable) webhook body.
// Returns:
//   true  — Radarr has the movie WITH a file
//   false — Radarr is reachable and reports the movie absent / without a file
//   null  — could not verify (variant not configured, or the call errored).
//           The caller proceeds on null: an attacker can't induce it without
//           also breaking the operator's Radarr connectivity, and the periodic
//           sync reconciles availability independently.
export async function isMovieDownloadedInRadarr(
  tmdbId: number,
  variant: ArrVariant = "",
): Promise<boolean | null> {
  const cfg = await getArrCfg("radarr", variant);
  if (!cfg) return null;
  try {
    return (await findRadarrMovie(cfg, tmdbId))?.hasFile === true;
  } catch (err) {
    console.warn("[arr] isMovieDownloadedInRadarr failed:", arrErrorMessage(err));
    return null;
  }
}

// The Sonarr webhook's verdict on a Download event. `null` keeps the same
// meaning as isMovieDownloadedInRadarr's null: unverifiable (instance not
// configured, or Sonarr unreachable). The false branch carries WHY, because the
// webhook treats the reasons differently — "incomplete" is the normal state of
// an in-progress season import (defer, keep the library scan), while "absent"
// and "ids-disagree" are the forgery shapes the guard exists to refuse.
export type SeriesDownloadVerdict =
  // tmdbId: the one Sonarr's own library row carries (null when it has none —
  // Sonarr v3, or a series it never mapped). The webhook keys a tvdb-only
  // event's cache rows on it, as the sync writer does.
  | { downloaded: true; tmdbId: number | null; episodeFileCount: number; episodeCount: number }
  | { downloaded: false; reason: "incomplete"; episodeFileCount: number; episodeCount: number }
  | { downloaded: false; reason: "absent" | "ids-disagree" };

// Authoritative "is this series COMPLETE" check for the Sonarr webhook — the
// series-side counterpart to isMovieDownloadedInRadarr, with the same purpose:
// confirm against Sonarr's live library so a forged Download event (the
// secret-only webhook auth means anyone holding the secret can submit an
// arbitrary payload) can't mark a series AVAILABLE that Sonarr never grabbed.
// Resolves the series by tvdbId (Sonarr's primary key); falls back to a
// tmdb→tvdb lookup when only tmdbId is present. The completeness rule MUST
// match getSonarrWantedTmdbIds (the sync writer) — both call
// sonarrSeriesCompletion (guardrail 14a): every aired, monitored,
// regular-season episode on disk, specials excluded. A divergent threshold
// here would flip a request AVAILABLE on the webhook and have the next sync
// revert it to APPROVED — a per-tick flip-flop.
//
// The two ids are checked against Sonarr's OWN library row first, and the
// `series/lookup` call runs only when that row can't answer (no tmdbId on it:
// Sonarr v3, or a series Sonarr never mapped). The lookup makes Sonarr query
// its internet metadata service, so it is slow, and when that service stalls
// every check timed out after 30s and the webhook could verify nothing. The
// library row is also the better witness: Sonarr builds the payload's tmdbId
// from that same row, so a genuine event always agrees with it. At most ONE
// lookup runs per check: either the payload had no tvdbId to find the row by,
// or it had both ids and the row can't vouch for the tmdbId.
export async function isSeriesDownloadedInSonarr(
  ids: { tvdbId?: number | null; tmdbId?: number | null },
  variant: ArrVariant = "",
): Promise<SeriesDownloadVerdict | null> {
  const cfg = await getArrCfg("sonarr", variant);
  if (!cfg) return null;
  try {
    const payloadTvdbId = posInt(ids.tvdbId);
    const claimedTmdbId = posInt(ids.tmdbId);
    // Sonarr-sourced only. This resolution decides whether a payload is FORGED, and
    // TMDB's TVDB cross-reference is third-party, user-edited data: one wrong edit
    // would have Sonarr's genuine events refused as ids-disagree. Nothing is lost
    // without it — when Sonarr can't resolve the tmdb id, `resolved` stays null and
    // the verify proceeds on the payload's own tvdbId, which Sonarr always sends.
    const lookupTvdbId = async (tmdbId: number): Promise<number | null> => {
      const looked = await lookupSeriesByTmdbId(cfg, tmdbId, { tvdbCrossRef: false });
      // The lookup row is never schema-checked by Sonarr, so hold it to the same
      // positive-integer contract as the payload ids above. Unguarded, a malformed
      // upstream value could become `tvdbId` below, where the `===` against the
      // library rows would silently never match — reporting "not downloaded" for a
      // series Sonarr actually has, rather than the honest `null` for unverifiable.
      const rawResolved = looked ? looked.tvdbId : null;
      return posInt(rawResolved);
    };
    // No tvdbId in the payload: the lookup is the only way to find the library row.
    const tvdbId = payloadTvdbId ?? (claimedTmdbId !== null ? await lookupTvdbId(claimedTmdbId) : null);
    if (tvdbId === null) return null;
    // A filtered read — this runs on EVERY Sonarr Download webhook, so an
    // unfiltered fetch paid a full-library transfer per episode of a
    // season-pack import.
    const match = await findSonarrSeries(cfg, tvdbId);
    if (!match) return { downloaded: false, reason: "absent" };
    const libraryTmdbId = posInt(match.tmdbId);

    // The payload's two ids must name the SAME series. This is the forgery shape the
    // webhook guard exists to catch: the caller (who holds the webhook secret)
    // supplies a tvdbId they really did download so the download check passes,
    // paired with an arbitrary tmdbId — and the Sonarr webhook's status flip keys
    // on the tmdbId, so an unrelated APPROVED request would be marked AVAILABLE,
    // its wanted row evicted, and its requester told it's ready. Verifying only
    // the tvdbId left that path unchecked. Disagreeing ids are never legitimate.
    //
    // Every id below is a positive integer by the guards above, so the explicit
    // Number() is a no-op at runtime — it is there to make that evident AT the
    // call site, both to a reader and to the log-injection scanner, which cannot
    // see validation that happened several lines earlier. The webhook payload is
    // attacker-shaped (secret-only auth, no schema), so a string id carrying a
    // newline would otherwise be able to forge a second "[arr] …" log entry.
    const bothIds = payloadTvdbId !== null && claimedTmdbId !== null;
    if (bothIds && libraryTmdbId !== null && libraryTmdbId !== claimedTmdbId) {
      console.warn(
        "[arr] Sonarr download check: payload ids disagree (tvdbId=%s is tmdbId=%s in Sonarr's library, payload says tmdbId=%s); treating as not downloaded.",
        Number(tvdbId), Number(libraryTmdbId), Number(claimedTmdbId),
      );
      return { downloaded: false, reason: "ids-disagree" };
    }
    if (bothIds && libraryTmdbId === null) {
      const resolved = await lookupTvdbId(claimedTmdbId);
      if (resolved !== null && resolved !== tvdbId) {
        console.warn(
          "[arr] Sonarr download check: payload ids disagree (tvdbId=%s resolves tmdbId=%s to tvdbId=%s); treating as not downloaded.",
          Number(tvdbId), Number(claimedTmdbId), Number(resolved),
        );
        return { downloaded: false, reason: "ids-disagree" };
      }
    }

    const { complete, episodeFileCount, episodeCount } = sonarrSeriesCompletion(match as SonarrSeriesStatsRow);
    return complete
      ? { downloaded: true, tmdbId: libraryTmdbId, episodeFileCount, episodeCount }
      : { downloaded: false, reason: "incomplete", episodeFileCount, episodeCount };
  } catch (err) {
    console.warn("[arr] isSeriesDownloadedInSonarr failed:", arrErrorMessage(err));
    return null;
  }
}

// Live completeness of a series by tmdbId, for the arr-state diagnostic: the
// same lookup + filtered library read as the webhook check, reported as counts
// so an operator can see WHY a request has not flipped (e.g. 59/60 aired
// episodes on disk). null = instance unconfigured or series not in Sonarr.
// A Sonarr request failure THROWS instead, so the caller (the arr-state debug
// route) can report it separately. Read-only, and never cached: a diagnostic
// reads live.
export async function getSonarrSeriesCompletion(
  tmdbId: number,
  variant: ArrVariant = "",
): Promise<(SonarrSeriesCompletion & { tvdbId: number }) | null> {
  const cfg = await getArrCfg("sonarr", variant);
  if (!cfg) return null;
  const looked = await lookupSeriesByTmdbId(cfg, tmdbId);
  const tvdbId = posInt(looked?.tvdbId);
  if (tvdbId === null) return null;
  const match = await findSonarrSeries(cfg, tvdbId);
  if (!match) return null;
  return { tvdbId, ...sonarrSeriesCompletion(match as SonarrSeriesStatsRow) };
}

/**
 * The tvdbId to persist on an issue for a tmdb id, or null. This value is
 * PERSISTED onto Issue.tvdbId and never re-resolved, so an unverified pick here
 * misroutes every later search/grab for that issue. TMDB's TVDB cross-reference
 * (cached) only names a candidate: Sonarr's own library row must carry it AND
 * name this tmdbId (the cross-reference is user-edited; a v3 row names no
 * tmdbId and falls through to the verified lookup). A filtered read, never the
 * whole library — every TV issue a user files runs this.
 */
export async function resolveTvdbIdFromTmdbId(tmdbId: number, variant: ArrVariant = ""): Promise<number | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return null;
  try {
    const candidate = await resolveTmdbToTvdb(tmdbId);
    if (candidate !== null) {
      const row = await findSonarrSeries(cfg, candidate);
      if (row && row.tmdbId === tmdbId) return candidate;
    }
    return (await lookupSeriesIdsCached(cfg, tmdbId))?.tvdbId ?? null;
  } catch {
    return null;
  }
}

// ── search commands and seasons ─────────────────────────────────────────────

async function postCommand(cfg: ArrCfg, body: Record<string, unknown>): Promise<void> {
  await arrFetch<unknown>(cfg, "/api/v3/command", { method: "POST", body: JSON.stringify(body) });
}

export async function searchMovieInRadarr(tmdbId: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await requireArrCfg("radarr", variant);
  const movie = await requireRadarrMovie(cfg, tmdbId);
  await postCommand(cfg, { name: "MoviesSearch", movieIds: [movie.id] });
}

export async function searchSeriesInSonarr(tvdbId: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await requireArrCfg("sonarr", variant);
  const series = await requireSonarrSeries(cfg, tvdbId);
  await postCommand(cfg, { name: "SeriesSearch", seriesId: series.id });
}

export async function searchSeasonInSonarr(tvdbId: number, seasonNumber: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await requireArrCfg("sonarr", variant);
  const series = await requireSonarrSeries(cfg, tvdbId);
  await postCommand(cfg, { name: "SeasonSearch", seriesId: series.id, seasonNumber });
}

export async function searchEpisodeInSonarr(tvdbId: number, seasonNumber: number, episodeNumber: number, variant: ArrVariant = ""): Promise<void> {
  const cfg = await requireArrCfg("sonarr", variant);
  const series = await requireSonarrSeries(cfg, tvdbId);
  const episodeId = await findEpisodeId(cfg, series.id, seasonNumber, episodeNumber);
  await postCommand(cfg, { name: "EpisodeSearch", episodeIds: [episodeId] });
}

export interface SonarrSeasonSummary {
  seasonNumber: number;
  /** Aired, monitored episodes in the season (plus any with a file) — Sonarr's own count. */
  aired: number;
  /** Of those, how many have no file. */
  missing: number;
  monitored: boolean;
}

const count = (value: unknown): number => posInt(value) ?? 0;

// The regular seasons of one series in Sonarr, with their per-season counts —
// what the request release picker offers (a Sonarr release search is per season
// or per episode; a series-only search returns the indexers' RSS feed, not the
// series). Throws ArrItemNotFoundError when the series isn't in the library.
export async function getSonarrSeasons(tvdbId: number, variant: ArrVariant = ""): Promise<SonarrSeasonSummary[]> {
  const cfg = await requireArrCfg("sonarr", variant);
  const series = await findSonarrSeries(cfg, tvdbId);
  if (!series) throw new ArrItemNotFoundError("Series not found in Sonarr library");
  const out: SonarrSeasonSummary[] = [];
  for (const x of Array.isArray(series.seasons) ? series.seasons : []) {
    const s = asRecord(x);
    const n = posInt(s?.seasonNumber);
    if (!s || n === null) continue;
    const stats = asRecord(s.statistics);
    const aired = count(stats?.episodeCount);
    out.push({ seasonNumber: n, aired, missing: Math.max(0, aired - count(stats?.episodeFileCount)), monitored: s.monitored === true });
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber);
}
