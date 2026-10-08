// Admin → Missing: the data half. One live listing per configured instance of
// the chosen service (guardrail 32 — every instance, addressed by its slug),
// judged by the pure rules in arr-missing.ts. Every call goes through
// arrFetch (guardrail 5). Nothing is cached and nothing is written.
import { arrErrorMessage, arrFetch, getArrCfg } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { prisma } from "./prisma";
import {
  missingEpisodes,
  missingMovie,
  missingSeries,
  planSeriesSearch,
  type MissingEpisode,
  type MissingMovie,
  type MissingSeries,
  type RadarrMovieRow,
  type SonarrEpisodeRow,
  type SonarrSeriesRow,
} from "./arr-missing";

export type MissingService = "radarr" | "sonarr";

export function parseMissingService(v: string | null | undefined): MissingService | null {
  return v === "radarr" || v === "sonarr" ? v : null;
}

export interface MissingReport<T> {
  service: MissingService;
  /** feature.integration.<service>; off ⇒ no instance is read. */
  enabled: boolean;
  instances: Array<{ slug: string; name: string }>;
  /** Instances whose listing could not be read; their titles are absent, not "complete". */
  errors: Array<{ instance: string; error: string }>;
  items: T[];
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

async function loadReport<T extends { tmdbId: number | null; posterPath: string | null }>(
  service: MissingService,
  judge: (rows: unknown[], instance: string) => T[],
): Promise<MissingReport<T>> {
  const enabled = await isFeatureEnabled(`feature.integration.${service}`);
  const configured = enabled ? await getSyncableArrInstances(service) : [];
  const instances = configured.map((i) => ({ slug: i.slug, name: i.name }));
  const path = service === "radarr" ? "/api/v3/movie" : "/api/v3/series";
  const settled = await settleLimit(instances, LISTING_CONCURRENCY, async (inst) => {
    const cfg = await getArrCfg(service, inst.slug);
    if (!cfg) throw new Error("not configured");
    const rows = await arrFetch<unknown>(cfg, path);
    return judge(Array.isArray(rows) ? rows : [], inst.slug);
  });

  const report: MissingReport<T> = { service, enabled, instances, errors: [], items: [] };
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      report.items.push(...s.value);
      return;
    }
    const error = arrErrorMessage(s.reason);
    report.errors.push({ instance: instances[i].slug, error });
    console.warn(`[missing] ${service} instance "${instances[i].slug}" listing failed:`, error);
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
  const report = await loadReport<MissingMovie>("radarr", (rows, instance) => {
    const out: MissingMovie[] = [];
    for (const row of rows as RadarrMovieRow[]) {
      const m = row && typeof row === "object" ? missingMovie(row, instance, nowMs) : null;
      if (m) out.push(m);
    }
    return out;
  });
  report.items.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || a.title.localeCompare(b.title));
  return report;
}

export async function loadMissingSeries(): Promise<MissingReport<MissingSeries>> {
  const report = await loadReport<MissingSeries>("sonarr", (rows, instance) => {
    const out: MissingSeries[] = [];
    for (const row of rows as SonarrSeriesRow[]) {
      const s = row && typeof row === "object" ? missingSeries(row, instance) : null;
      if (s) out.push(s);
    }
    return out;
  });
  report.items.sort((a, b) => (b.lastAired ?? "").localeCompare(a.lastAired ?? "") || a.title.localeCompare(b.title));
  return report;
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
}

// The page's per-row Search: queue a search on that instance for exactly what
// is missing, judged LIVE by the same rules the report used — a title that
// gained a file since the page loaded is refused (NothingMissingError) rather
// than sent hunting for an upgrade. Commands go through arrFetch (guardrail 5);
// Radarr/Sonarr run them in the background, so this returns once they're queued.
export async function searchMissing(service: MissingService, instance: string, arrId: number, now: Date): Promise<MissingSearchResult> {
  const cfg = await configuredCfg(service, instance);
  const command = (body: Record<string, unknown>) =>
    arrFetch<unknown>(cfg, "/api/v3/command", { method: "POST", body: JSON.stringify(body) });

  if (service === "radarr") {
    const row = await arrFetch<RadarrMovieRow>(cfg, `/api/v3/movie/${arrId}`);
    if (!row || typeof row !== "object" || !missingMovie(row, instance, now.getTime())) throw new NothingMissingError();
    await command({ name: "MoviesSearch", movieIds: [arrId] });
    return { commands: 1, seasons: [], episodes: 0 };
  }

  const rows = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${arrId}`);
  const plan = planSeriesSearch(Array.isArray(rows) ? (rows as SonarrEpisodeRow[]) : [], now.getTime());
  if (plan.seasons.length === 0 && plan.episodeIds.length === 0) throw new NothingMissingError();
  // Sequential and per series: a handful of commands at most, one per fully
  // missing season plus one for the rest.
  for (const seasonNumber of plan.seasons) {
    await command({ name: "SeasonSearch", seriesId: arrId, seasonNumber });
  }
  if (plan.episodeIds.length > 0) await command({ name: "EpisodeSearch", episodeIds: plan.episodeIds });
  return { commands: plan.seasons.length + (plan.episodeIds.length > 0 ? 1 : 0), seasons: plan.seasons, episodes: plan.episodeIds.length };
}
