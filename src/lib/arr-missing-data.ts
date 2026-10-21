// Admin → Missing: the data half. One live listing per configured instance of
// the chosen service (guardrail 32 — every instance, addressed by its slug),
// judged by the pure rules in arr-missing.ts. Every call goes through
// arrFetch (guardrail 5). Nothing is cached and nothing is written.
import { arrErrorKind, arrErrorMessage, arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { commandIdsOf, postArrCommand } from "./arr-admin";
import type { ArrErrorKind } from "./arr-error-kind";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { prisma } from "./prisma";
import {
  cutoffMovie,
  cutoffSeriesFromEpisodes,
  missingEpisodes,
  missingMovie,
  missingMovieList,
  missingSeriesList,
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
} from "./arr-missing";

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
   * Cutoff mode only, present only when non-empty: instances whose
   * /wanted/cutoff listing ran past the page ceiling, so only the first `read`
   * of `total` records were judged — the list is incomplete, never complete.
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

// `read` fetches one instance's raw listing and judges it; the default is the
// Missing mode's single library listing.
async function loadReport<T extends { tmdbId: number | null; posterPath: string | null }>(
  service: MissingService,
  judge: (rows: unknown[], instance: string) => T[],
  read?: (cfg: ArrCfg, instance: string) => Promise<T[]>,
): Promise<MissingReport<T>> {
  const enabled = await isFeatureEnabled(`feature.integration.${service}`);
  const configured = enabled ? await getSyncableArrInstances(service) : [];
  const instances = configured.map((i) => ({ slug: i.slug, name: i.name }));
  const path = service === "radarr" ? "/api/v3/movie" : "/api/v3/series";
  const settled = await settleLimit(instances, LISTING_CONCURRENCY, async (inst) => {
    const cfg = await getArrCfg(service, inst.slug);
    if (!cfg) throw new Error("not configured");
    if (read) return read(cfg, inst.slug);
    const rows = await arrFetch<unknown>(cfg, path);
    return judge(Array.isArray(rows) ? rows : [], inst.slug);
  });

  const report: MissingReport<T> = { service, enabled, instances, errors: [], items: [] };
  settled.forEach((s, i) => {
    // The page re-reads on open and the snapshot refresh re-reads every 10
    // minutes: a dark instance is one unchanged condition, logged once until it
    // changes (guardrail 7b).
    const logKey = `missing:${service}:${instances[i].slug}`;
    if (s.status === "fulfilled") {
      // One by one, never a spread push: each list is capped (MAX_MISSING_ITEMS,
      // the cutoff page ceiling), and a spread of an upstream-sized one throws
      // RangeError (guardrail 5i).
      for (const it of s.value) report.items.push(it);
      forgetWarnOnChange(logKey);
      return;
    }
    const error = arrErrorMessage(s.reason);
    report.errors.push({ instance: instances[i].slug, error, kind: arrErrorKind(s.reason) });
    warnOnChange(logKey, error, `[missing] ${service} instance "${instances[i].slug}" listing failed: ${error}`);
  });

  const needPoster = report.items.filter((it) => it.posterPath === null && it.tmdbId !== null).map((it) => it.tmdbId as number);
  if (needPoster.length > 0) {
    const posters = await cachedPosterPaths(service === "radarr" ? "MOVIE" : "TV", needPoster);
    for (const it of report.items) {
      if (it.posterPath === null && it.tmdbId !== null) it.posterPath = posters.get(it.tmdbId) ?? null;
    }
  }
  return report;
}

// Most recently released first: a title that should have arrived last week is
// the likeliest to still be in flight, the oldest are the stuck ones at the end.
export async function loadMissingMovies(now: Date): Promise<MissingReport<MissingMovie>> {
  const nowMs = now.getTime();
  const report = await loadReport<MissingMovie>("radarr", (rows, instance) => missingMovieList(rows, instance, nowMs));
  report.items.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || a.title.localeCompare(b.title));
  return report;
}

export async function loadMissingSeries(): Promise<MissingReport<MissingSeries>> {
  const report = await loadReport<MissingSeries>("sonarr", (rows, instance) => missingSeriesList(rows, instance));
  report.items.sort((a, b) => (b.lastAired ?? "").localeCompare(a.lastAired ?? "") || a.title.localeCompare(b.title));
  return report;
}

// ── cutoff unmet ─────────────────────────────────────────────────────────────

// /api/v3/wanted/cutoff is paged; same ceiling idea as the queue reads.
export const CUTOFF_PAGE_SIZE = 500;
export const CUTOFF_MAX_PAGES = 40;

// `truncated` when the ceiling — not the end of the list — stopped the read:
// the arr reported more records than were read. Sonarr's listing is per
// EPISODE, so a raised cutoff on a large library can reach it; the series
// past it would otherwise vanish from the page with nothing saying so.
// Exported for its bounds pin (tests/arr-projection-bounds.test.mts).
export async function readCutoffPages(cfg: ArrCfg, service: MissingService): Promise<{ records: unknown[]; total: number; truncated: boolean }> {
  const include = service === "sonarr" ? "&includeSeries=true&includeEpisodeFile=true" : "";
  const records: unknown[] = [];
  let total = 0;
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
    total = typeof res?.totalRecords === "number" ? res.totalRecords : 0;
    if (batch.length === 0 || page * CUTOFF_PAGE_SIZE >= total) {
      reachedEnd = true;
      break;
    }
  }
  return { records, total, truncated: !reachedEnd && total > records.length };
}

type CutoffTruncation = NonNullable<MissingReport<unknown>["truncated"]>;

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
function withTruncation<T>(report: MissingReport<T>, truncated: CutoffTruncation): MissingReport<T> {
  if (truncated.length === 0) return report;
  const order = new Map(report.instances.map((i, n) => [i.slug, n]));
  report.truncated = [...truncated].sort((a, b) => (order.get(a.instance) ?? 0) - (order.get(b.instance) ?? 0));
  return report;
}

/** Radarr movies whose file is below the profile cutoff, monitored only, by title. */
export async function loadCutoffMovies(): Promise<MissingReport<CutoffMovie>> {
  const truncated: CutoffTruncation = [];
  const report = await loadReport<CutoffMovie>("radarr", () => [], async (cfg, instance) => {
    const [listing, profiles] = await Promise.all([readCutoffPages(cfg, "radarr"), readProfiles(cfg)]);
    const out: CutoffMovie[] = [];
    const seen = new Set<number>();
    for (const row of listing.records as RadarrCutoffRow[]) {
      const m = row && typeof row === "object" ? cutoffMovie(row, instance, profiles) : null;
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
  const truncated: CutoffTruncation = [];
  const report = await loadReport<CutoffSeries>("sonarr", () => [], async (cfg, instance) => {
    const [listing, profiles] = await Promise.all([readCutoffPages(cfg, "sonarr"), readProfiles(cfg)]);
    const out = cutoffSeriesFromEpisodes(listing.records as SonarrCutoffRecord[], instance, profiles);
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
// instance's keys can outlive it).
async function configuredCfg(service: MissingService, instance: string) {
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === instance)) throw new MissingInstanceError(instance);
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new MissingInstanceError(instance);
  return cfg;
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
  return missingEpisodes(Array.isArray(rows) ? (rows as SonarrEpisodeRow[]) : [], now.getTime());
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
  const queued: Array<{ id: number | null }> = [];
  const command = async (body: Record<string, unknown>) => {
    queued.push(await postArrCommand(cfg, body));
  };

  if (service === "radarr") {
    const row = await arrFetch<RadarrMovieRow>(cfg, `/api/v3/movie/${arrId}`);
    if (!row || typeof row !== "object" || !missingMovie(row, instance, now.getTime())) throw new NothingMissingError();
    await command({ name: "MoviesSearch", movieIds: [arrId] });
    return { commands: 1, seasons: [], episodes: 0, commandIds: commandIdsOf(queued) };
  }

  const rows = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${arrId}`);
  const episodeRows = Array.isArray(rows) ? (rows as SonarrEpisodeRow[]) : [];
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
  const seasons: number[] = [];
  let episodes = 0;
  try {
    for (const seasonNumber of plan.seasons) {
      await command({ name: "SeasonSearch", seriesId: arrId, seasonNumber });
      seasons.push(seasonNumber);
    }
    if (plan.episodeIds.length > 0) {
      await command({ name: "EpisodeSearch", episodeIds: plan.episodeIds });
      episodes = plan.episodeIds.length;
    }
  } catch (err) {
    if (queued.length === 0) throw err;
    // An event (this one search stopping part-way), not a recomputed condition — guardrail 7b doesn't apply.
    console.warn(`[missing] sonarr instance "${instance}" search for series ${arrId} stopped after ${queued.length} command(s):`, arrErrorMessage(err));
    return { commands: queued.length, seasons, episodes, partial: true, commandIds: commandIdsOf(queued) };
  }
  return {
    commands: plan.seasons.length + (plan.episodeIds.length > 0 ? 1 : 0),
    seasons: plan.seasons,
    episodes: plan.episodeIds.length,
    commandIds: commandIdsOf(queued),
  };
}

/** Nothing is below cutoff any more (upgraded, file removed, or unmonitored). */
export class NothingToUpgradeError extends Error {}

// The Cutoff mode's per-row Search: queue an UPGRADE search for exactly what
// Radarr/Sonarr say is below cutoff right now, re-judged live (a row whose file
// was upgraded since the page loaded is refused, not searched again).
// Radarr: MoviesSearch for the movie. Sonarr: one EpisodeSearch for the
// monitored episodes whose file is below cutoff — planCutoffSearch.
export async function searchCutoff(service: MissingService, instance: string, arrId: number): Promise<MissingSearchResult> {
  const cfg = await configuredCfg(service, instance);
  const command = (body: Record<string, unknown>) =>
    arrFetch<unknown>(cfg, "/api/v3/command", { method: "POST", body: JSON.stringify(body) });

  if (service === "radarr") {
    const row = await arrFetch<{ hasFile?: unknown; monitored?: unknown; movieFile?: { qualityCutoffNotMet?: unknown } | null }>(cfg, `/api/v3/movie/${arrId}`);
    if (!row || row.hasFile !== true || row.monitored !== true || row.movieFile?.qualityCutoffNotMet !== true) throw new NothingToUpgradeError();
    await command({ name: "MoviesSearch", movieIds: [arrId] });
    return { commands: 1, seasons: [], episodes: 0 };
  }

  const [episodes, files] = await Promise.all([
    arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${arrId}`),
    arrFetch<unknown>(cfg, `/api/v3/episodefile?seriesId=${arrId}`),
  ]);
  const ids = planCutoffSearch(
    Array.isArray(episodes) ? (episodes as Array<SonarrEpisodeRow & { episodeFileId?: unknown }>) : [],
    Array.isArray(files) ? (files as SonarrEpisodeFileRow[]) : [],
  );
  if (ids.length === 0) throw new NothingToUpgradeError();
  await command({ name: "EpisodeSearch", episodeIds: ids });
  return { commands: 1, seasons: [], episodes: ids.length };
}
