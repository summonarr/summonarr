// Admin → Missing: the data half. One live listing per configured instance of
// the chosen service (guardrail 32 — every instance, addressed by its slug),
// judged by the pure rules in arr-missing.ts. Every call goes through
// arrFetch (guardrail 5). Nothing is cached and nothing is written.
import { arrErrorMessage, arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { asRecord } from "./arr-client";
import { ArrInstanceError, commandIdsOf, configuredArrCfg, postArrCommand } from "./arr-admin";
import type { ArrErrorKind } from "./arr-error-kind";
import { settleArrInstances } from "./arr-instance-fanout";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { pagedReadEnded } from "./arr-parse";
import { isFeatureEnabled } from "./features";
import { prisma } from "./prisma";
import {
  cutoffMovie,
  cutoffSeriesFromEpisodes,
  missingEpisodes,
  missingMovie,
  missingMovieListing,
  missingSeriesListing,
  planCutoffSearch,
  planSeriesSearch,
  qualityProfileInfo,
  type CutoffMovie,
  type CutoffSeries,
  type MissingEpisode,
  type MissingMovie,
  type MissingSeries,
  type RadarrCutoffRow,
  type RadarrMovieRow,
  type SonarrCutoffRecord,
  type SonarrEpisodeFileRow,
  type SonarrEpisodeRow,
  type JudgedListing,
} from "./arr-missing";

// The object rows of an arr list. The pure rules read fields off every row, so a
// null or scalar entry in a hostile or broken answer is dropped here, once,
// instead of throwing out of whichever rule meets it first.
function recordRows<T>(rows: unknown): T[] {
  const out: T[] = [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    // Each rule reads its fields through guards, so T is a reading aid.
    const rec = asRecord(r);
    if (rec) out.push(rec as T);
  }
  return out;
}

export type MissingService = "radarr" | "sonarr";

export function parseMissingService(v: string | null | undefined): MissingService | null {
  return v === "radarr" || v === "sonarr" ? v : null;
}

/** "missing" (no file, should have one) or "cutoff" (has a file below the profile's cutoff). */
export type MissingMode = "missing" | "cutoff";

/** Absent means "missing" — the page's original and only mode before cutoff existed. */
export function parseMissingMode(v: unknown): MissingMode | null {
  if (v === undefined || v === null || v === "" || v === "missing") return "missing";
  return v === "cutoff" ? "cutoff" : null;
}

export interface MissingReport<T> {
  service: MissingService;
  /** feature.integration.<service>; off ⇒ no instance is read. */
  enabled: boolean;
  instances: Array<{ slug: string; name: string }>;
  /** Instances whose listing could not be read; their titles are absent, not "complete". */
  errors: Array<{ instance: string; error: string; kind: ArrErrorKind }>;
  items: T[];
  /**
   * Present only when non-empty: instances whose listing ran past a ceiling,
   * so only the first `read` of `total` records were judged — the list is
   * incomplete, never complete. Cutoff: the /wanted/cutoff page ceiling.
   * Missing: the per-instance MAX_MISSING_ITEMS cap and its bounded scan.
   */
  truncated?: Array<{ instance: string; read: number; total: number }>;
}

// Small and fixed: one library-sized listing per instance.
const LISTING_CONCURRENCY = 3;
const POSTER_LOOKUP_CHUNK = 1_000;

// Poster paths from the TMDB core cache — the only poster source for a series
// (Sonarr's artwork is TheTVDB's, which the CSP does not allow) and the
// fallback for a movie whose Radarr row carried none. Cosmetic: a failed read
// leaves the letter placeholder rather than failing the report.
async function cachedPosterPaths(mediaType: "MOVIE" | "TV", tmdbIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = [...new Set(tmdbIds)];
  try {
    for (let i = 0; i < ids.length; i += POSTER_LOOKUP_CHUNK) {
      const rows = await prisma.tmdbMediaCore.findMany({
        where: { mediaType, tmdbId: { in: ids.slice(i, i + POSTER_LOOKUP_CHUNK) } },
        select: { tmdbId: true, posterPath: true },
      });
      for (const r of rows) if (r.posterPath) out.set(r.tmdbId, r.posterPath);
    }
  } catch (err) {
    console.warn("[missing] poster lookup failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

// `read` fetches one instance's raw listing and judges it.
async function loadReport<T extends { tmdbId: number | null; posterPath: string | null }>(
  service: MissingService,
  read: (cfg: ArrCfg, instance: string) => Promise<T[]>,
): Promise<MissingReport<T>> {
  const enabled = await isFeatureEnabled(`feature.integration.${service}`);
  const configured = enabled ? await getSyncableArrInstances(service) : [];
  const instances = configured.map((i) => ({ slug: i.slug, name: i.name }));
  // The page re-reads on open and the snapshot refresh re-reads every 10
  // minutes: a dark instance is one unchanged condition, logged once until it
  // changes (guardrail 7b).
  const outcomes = await settleArrInstances(instances, LISTING_CONCURRENCY, async (inst) => {
    const cfg = await getArrCfg(service, inst.slug);
    if (!cfg) throw new Error("not configured");
    return read(cfg, inst.slug);
  }, {
    key: (inst) => `missing:${service}:${inst.slug}`,
    message: (inst, error) => `[missing] ${service} instance "${inst.slug}" listing failed: ${error}`,
  });

  const report: MissingReport<T> = { service, enabled, instances, errors: [], items: [] };
  for (const o of outcomes) {
    if (o.ok) {
      // One by one, never a spread push: each list is capped (MAX_MISSING_ITEMS,
      // the cutoff page ceiling), and a spread of an upstream-sized one throws
      // RangeError (guardrail 5i).
      for (const it of o.value) report.items.push(it);
    } else {
      report.errors.push({ instance: o.inst.slug, error: o.error, kind: o.kind });
    }
  }

  const needPoster = report.items.filter((it) => it.posterPath === null && it.tmdbId !== null).map((it) => it.tmdbId as number);
  if (needPoster.length > 0) {
    const posters = await cachedPosterPaths(service === "radarr" ? "MOVIE" : "TV", needPoster);
    for (const it of report.items) {
      if (it.posterPath === null && it.tmdbId !== null) it.posterPath = posters.get(it.tmdbId) ?? null;
    }
  }
  return report;
}

// The Missing mode's reader: the instance's one library listing, judged. A
// listing the cap stopped short is noted in `truncated`, as the cutoff reads do.
function listAndJudge<T>(
  path: "/api/v3/movie" | "/api/v3/series",
  judge: (rows: unknown[], instance: string) => JudgedListing<T>,
  truncated: ListingTruncation,
) {
  return async (cfg: ArrCfg, instance: string): Promise<T[]> => {
    const rows = await arrFetch<unknown>(cfg, path);
    const listing = judge(Array.isArray(rows) ? rows : [], instance);
    if (listing.truncated) truncated.push({ instance, read: listing.read, total: listing.total });
    return listing.items;
  };
}

// Most recently released first: a title that should have arrived last week is
// the likeliest to still be in flight, the oldest are the stuck ones at the end.
export async function loadMissingMovies(now: Date): Promise<MissingReport<MissingMovie>> {
  const nowMs = now.getTime();
  const truncated: ListingTruncation = [];
  const report = await loadReport("radarr", listAndJudge("/api/v3/movie", (rows, instance) => missingMovieListing(rows, instance, nowMs), truncated));
  report.items.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || a.title.localeCompare(b.title));
  return withTruncation(report, truncated);
}

export async function loadMissingSeries(): Promise<MissingReport<MissingSeries>> {
  const truncated: ListingTruncation = [];
  const report = await loadReport("sonarr", listAndJudge("/api/v3/series", (rows, instance) => missingSeriesListing(rows, instance), truncated));
  report.items.sort((a, b) => (b.lastAired ?? "").localeCompare(a.lastAired ?? "") || a.title.localeCompare(b.title));
  return withTruncation(report, truncated);
}

// ── cutoff unmet ─────────────────────────────────────────────────────────────

// /api/v3/wanted/cutoff is paged; same ceiling idea as the queue reads.
export const CUTOFF_PAGE_SIZE = 500;
export const CUTOFF_MAX_PAGES = 40;

// `truncated` when the ceiling — not the end of the list — stopped the read:
// the arr reported more records than were read, or (reporting no total) its
// last page read was still full. Sonarr's listing is per EPISODE, so a raised
// cutoff on a large library can reach it; the series past it would otherwise
// vanish from the page with nothing saying so. With no total from the arr,
// `total` is the records read (a lower bound) — never 0, which once ended the
// read after page 1 and called it complete.
// Exported for its bounds pin (tests/arr-projection-bounds.test.mts).
export async function readCutoffPages(cfg: ArrCfg, service: MissingService): Promise<{ records: unknown[]; total: number; truncated: boolean }> {
  const include = service === "sonarr" ? "&includeSeries=true&includeEpisodeFile=true" : "";
  const records: unknown[] = [];
  let total: number | null = null;
  let reachedEnd = false;
  for (let page = 1; page <= CUTOFF_MAX_PAGES; page++) {
    const res = await arrFetch<{ records?: unknown; totalRecords?: unknown }>(
      cfg, `/api/v3/wanted/cutoff?page=${page}&pageSize=${CUTOFF_PAGE_SIZE}&monitored=true${include}`,
    );
    const batch = Array.isArray(res?.records) ? res.records : [];
    // At most a page's worth per page (an honest arr never sends more), appended
    // one by one: a spread push of a hostile page past ~125k records throws
    // RangeError, and an uncapped page would let one answer outgrow the page cap.
    for (const r of batch.slice(0, CUTOFF_PAGE_SIZE)) records.push(r);
    total = typeof res?.totalRecords === "number" && Number.isFinite(res.totalRecords) ? res.totalRecords : null;
    if (pagedReadEnded(page, CUTOFF_PAGE_SIZE, batch.length, res?.totalRecords)) {
      reachedEnd = true;
      break;
    }
  }
  return { records, total: total ?? records.length, truncated: !reachedEnd && (total === null || total > records.length) };
}

type ListingTruncation = NonNullable<MissingReport<unknown>["truncated"]>;

// The profile names are labels only: a failed read leaves them blank rather
// than failing the instance's listing.
async function readProfiles(cfg: ArrCfg) {
  try {
    return qualityProfileInfo(await arrFetch<unknown>(cfg, "/api/v3/qualityprofile"));
  } catch {
    return qualityProfileInfo([]);
  }
}

// Attaches the instances whose listing hit the ceiling, in instance order.
function withTruncation<T>(report: MissingReport<T>, truncated: ListingTruncation): MissingReport<T> {
  if (truncated.length === 0) return report;
  const order = new Map(report.instances.map((i, n) => [i.slug, n]));
  report.truncated = [...truncated].sort((a, b) => (order.get(a.instance) ?? 0) - (order.get(b.instance) ?? 0));
  return report;
}

/** Radarr movies whose file is below the profile cutoff, monitored only, by title. */
export async function loadCutoffMovies(): Promise<MissingReport<CutoffMovie>> {
  const truncated: ListingTruncation = [];
  const report = await loadReport<CutoffMovie>("radarr", async (cfg, instance) => {
    const [listing, profiles] = await Promise.all([readCutoffPages(cfg, "radarr"), readProfiles(cfg)]);
    const out: CutoffMovie[] = [];
    const seen = new Set<number>();
    for (const row of recordRows<RadarrCutoffRow>(listing.records)) {
      const m = cutoffMovie(row, instance, profiles);
      // A page boundary can repeat a record while the list changes under the read.
      if (m && !seen.has(m.arrId)) {
        seen.add(m.arrId);
        out.push(m);
      }
    }
    if (listing.truncated) truncated.push({ instance, read: listing.records.length, total: listing.total });
    return out;
  });
  report.items.sort((a, b) => a.title.localeCompare(b.title));
  return withTruncation(report, truncated);
}

/** Sonarr series with monitored episodes below the profile cutoff, most episodes first. */
export async function loadCutoffSeries(): Promise<MissingReport<CutoffSeries>> {
  const truncated: ListingTruncation = [];
  const report = await loadReport<CutoffSeries>("sonarr", async (cfg, instance) => {
    const [listing, profiles] = await Promise.all([readCutoffPages(cfg, "sonarr"), readProfiles(cfg)]);
    const out = cutoffSeriesFromEpisodes(recordRows<SonarrCutoffRecord>(listing.records), instance, profiles);
    if (listing.truncated) truncated.push({ instance, read: listing.records.length, total: listing.total });
    return out;
  });
  report.items.sort((a, b) => b.episodes.length - a.episodes.length || a.title.localeCompare(b.title));
  return withTruncation(report, truncated);
}

export class MissingInstanceError extends Error {}
/** The title has nothing missing any more (a file landed, or it left the instance). */
export class NothingMissingError extends Error {}

// The instance must be a CONFIGURED one — a slug is never turned into a
// Setting-key read for an instance the registry doesn't list (a de-registered
// instance's keys can outlive it; configuredArrCfg), refused here as this
// module's own error.
async function configuredCfg(service: MissingService, instance: string): Promise<ArrCfg> {
  try {
    return await configuredArrCfg(service, instance);
  } catch (err) {
    if (err instanceof ArrInstanceError) throw new MissingInstanceError(instance);
    throw err;
  }
}

/** No series with that tvdb id is on the instance (deleted there, or never added). */
export class SeriesNotOnInstanceError extends Error {}

/**
 * A TV request's Sonarr series id on its OWN instance, by the request's tvdb
 * id. The instance must be a configured one (MissingInstanceError otherwise —
 * no Setting read for a slug the registry doesn't list, guardrail 32), and the
 * row must name that tvdb id itself: an arr that ignored the `tvdbId` filter
 * answers with its whole library, and its first row is another series.
 */
export async function findSeriesIdOnInstance(instance: string, tvdbId: number): Promise<number> {
  const cfg = await configuredCfg("sonarr", instance);
  const rows = await arrFetch<unknown>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
  const list = Array.isArray(rows) ? (rows as Array<{ id?: unknown; tvdbId?: unknown } | null>) : [];
  const series = list.find((s) => s?.tvdbId === tvdbId && typeof s.id === "number" && Number.isSafeInteger(s.id) && s.id > 0);
  if (!series) throw new SeriesNotOnInstanceError();
  return series.id as number;
}

// One series' missing episodes, on demand (the page's row expansion).
export async function loadMissingEpisodes(instance: string, seriesId: number, now: Date): Promise<MissingEpisode[]> {
  const cfg = await configuredCfg("sonarr", instance);
  const rows = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${seriesId}`);
  return missingEpisodes(recordRows<SonarrEpisodeRow>(rows), now.getTime());
}

export interface MissingSearchResult {
  /** Commands queued on the instance. */
  commands: number;
  /** Sonarr only: seasons searched whole, and episodes searched one by one. */
  seasons: number[];
  episodes: number;
  /**
   * Present (true) only when a Sonarr search stopped part-way: a later command
   * was refused after earlier ones were queued. `commands`/`seasons`/`episodes`
   * then count only what WAS queued — those searches are running.
   */
  partial?: true;
}

// The page's per-row Search: queue a search on that instance for exactly what
// is missing, judged LIVE by the same rules the report used — a title that
// gained a file since the page loaded is refused (NothingMissingError) rather
// than sent hunting for an upgrade. Commands go through arrFetch (guardrail 5);
// Radarr/Sonarr run them in the background, so this returns once they're queued.
export async function searchMissing(service: MissingService, instance: string, arrId: number, now: Date): Promise<MissingSearchResult> {
  const { commands, seasons, episodes, partial } = await searchMissingTracked(service, instance, arrId, now);
  return partial ? { commands, seasons, episodes, partial } : { commands, seasons, episodes };
}

/**
 * searchMissing, plus the arr's id for every command it queued — the title
 * manager follows them live (GET /api/admin/arr/commands). The Missing page's
 * own answer stays searchMissing's.
 */
export async function searchMissingTracked(
  service: MissingService,
  instance: string,
  arrId: number,
  now: Date,
): Promise<MissingSearchResult & { commandIds: number[] }> {
  const cfg = await configuredCfg(service, instance);
  return service === "radarr" ? searchMissingMovie(cfg, instance, arrId, now) : searchMissingSeries(cfg, instance, arrId, now);
}

type TrackedSearch = MissingSearchResult & { commandIds: number[] };

async function searchMissingMovie(cfg: ArrCfg, instance: string, arrId: number, now: Date): Promise<TrackedSearch> {
  const row: RadarrMovieRow | null = asRecord(await arrFetch<unknown>(cfg, `/api/v3/movie/${arrId}`));
  if (!row || !missingMovie(row, instance, now.getTime())) throw new NothingMissingError();
  const queued = [await postArrCommand(cfg, { name: "MoviesSearch", movieIds: [arrId] })];
  return { commands: 1, seasons: [], episodes: 0, commandIds: commandIdsOf(queued) };
}

async function searchMissingSeries(cfg: ArrCfg, instance: string, arrId: number, now: Date): Promise<TrackedSearch> {
  const rows = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${arrId}`);
  const episodeRows = recordRows<SonarrEpisodeRow>(rows);
  // Sonarr answers an UNKNOWN seriesId's episode list with 200 [] — not a 404 —
  // so an empty list can't tell "nothing to search" from "this series is gone".
  // The series read can: a 404 there propagates (ArrResponseError), which both
  // routes answer as not found rather than "nothing missing". Only on the empty
  // path, so the common one costs no extra request.
  if (episodeRows.length === 0) await arrFetch<unknown>(cfg, `/api/v3/series/${arrId}`);
  const plan = planSeriesSearch(episodeRows, now.getTime());
  if (plan.seasons.length === 0 && plan.episodeIds.length === 0) throw new NothingMissingError();
  // Sequential and per series: a handful of commands at most, one per fully
  // missing season plus one for the rest. A refusal part-way leaves the ones
  // already queued RUNNING on Sonarr: answering a failure would drop their ids
  // (nothing followed, nothing re-read) and invite a retry that queues them
  // again, so once anything is queued the answer is what was, marked partial.
  const queued: Array<{ id: number | null }> = [];
  const seasons: number[] = [];
  let episodes = 0;
  try {
    for (const seasonNumber of plan.seasons) {
      queued.push(await postArrCommand(cfg, { name: "SeasonSearch", seriesId: arrId, seasonNumber }));
      seasons.push(seasonNumber);
    }
    if (plan.episodeIds.length > 0) {
      queued.push(await postArrCommand(cfg, { name: "EpisodeSearch", episodeIds: plan.episodeIds }));
      episodes = plan.episodeIds.length;
    }
  } catch (err) {
    if (queued.length === 0) throw err;
    // An event (this one search stopping part-way), not a recomputed condition — guardrail 7b doesn't apply.
    console.warn(`[missing] sonarr instance "${instance}" search for series ${arrId} stopped after ${queued.length} command(s):`, arrErrorMessage(err));
    return { commands: queued.length, seasons, episodes, partial: true, commandIds: commandIdsOf(queued) };
  }
  return { commands: queued.length, seasons, episodes, commandIds: commandIdsOf(queued) };
}

/** Nothing is below cutoff any more (upgraded, file removed, or unmonitored). */
export class NothingToUpgradeError extends Error {}

// The Cutoff mode's per-row Search: queue an UPGRADE search for exactly what
// Radarr/Sonarr say is below cutoff right now, re-judged live (a row whose file
// was upgraded since the page loaded is refused, not searched again).
// Radarr: MoviesSearch for the movie. Sonarr: one EpisodeSearch for the
// monitored episodes whose file is below cutoff — planCutoffSearch.
export async function searchCutoff(service: MissingService, instance: string, arrId: number): Promise<MissingSearchResult> {
  const { commands, seasons, episodes } = await searchCutoffTracked(service, instance, arrId);
  return { commands, seasons, episodes };
}

/**
 * searchCutoff, plus the arr's id for the command it queued — through the
 * same postArrCommand as searchMissingTracked, so a caller can follow it
 * (GET /api/admin/arr/commands). The Missing page's own answer stays searchCutoff's.
 */
export async function searchCutoffTracked(service: MissingService, instance: string, arrId: number): Promise<TrackedSearch> {
  const cfg = await configuredCfg(service, instance);
  if (service === "radarr") {
    const row = await arrFetch<{ hasFile?: unknown; monitored?: unknown; movieFile?: { qualityCutoffNotMet?: unknown } | null }>(cfg, `/api/v3/movie/${arrId}`);
    if (!row || row.hasFile !== true || row.monitored !== true || row.movieFile?.qualityCutoffNotMet !== true) throw new NothingToUpgradeError();
    const queued = [await postArrCommand(cfg, { name: "MoviesSearch", movieIds: [arrId] })];
    return { commands: 1, seasons: [], episodes: 0, commandIds: commandIdsOf(queued) };
  }

  const [episodes, files] = await Promise.all([
    arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${arrId}`),
    arrFetch<unknown>(cfg, `/api/v3/episodefile?seriesId=${arrId}`),
  ]);
  const ids = planCutoffSearch(
    recordRows<SonarrEpisodeRow & { episodeFileId?: unknown }>(episodes),
    recordRows<SonarrEpisodeFileRow>(files),
  );
  if (ids.length === 0) throw new NothingToUpgradeError();
  const queued = [await postArrCommand(cfg, { name: "EpisodeSearch", episodeIds: ids })];
  return { commands: 1, seasons: [], episodes: ids.length, commandIds: commandIdsOf(queued) };
}
