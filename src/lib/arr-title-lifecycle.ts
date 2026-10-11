// Putting a title on one Radarr/Sonarr instance by hand, and taking one off —
// the two jobs an admin still opened the arr for. Both are live calls on one
// CONFIGURED instance (guardrails 5, 32); every value the browser sends is
// checked against what the instance reports now (guardrail 5e).
//
// Adding creates NO MediaRequest: nobody asked for it, so nobody is notified,
// and the request watch grade never sees it (guardrail 34a). "On behalf of a
// user" stays the request path. An add DOES withdraw an earlier removal: the
// `cleanedUpAt` stamps on this instance's requests for the title are cleared,
// so the sync again treats a later disappearance as a lost file (14b).
//
// Removing is guarded like Library cleanup's delete (guardrail 14b), for one
// instance instead of every one:
//   - an APPROVED request for the title on this instance refuses the removal:
//     the sync re-pushes an APPROVED title the arr doesn't know, so the title
//     would come straight back — the admin declines or deletes the request first;
//   - every AVAILABLE request on this instance is stamped `cleanedUpAt` BEFORE
//     the delete (only rows not already stamped), so the sync never reads the
//     title's disappearance as a lost file and re-adds it; the stamps this call
//     wrote are removed again when the delete fails. Status and approvedAt are
//     never touched (guardrail 34a).
import { prisma } from "./prisma";
import { ArrResponseError, arrFetch, arrFetchNoContent, getArrAddDefaults, lookupSeriesByTmdbId, type ArrCfg } from "./arr";
import { configuredArrCfg, type ArrService } from "./arr-admin";
import { findTitle } from "./arr-title-data";
import {
  checkTitleEdit,
  projectChoices,
  projectRootFolderChoices,
  projectTitle,
  type ArrTitle,
  type Choice,
  type RootFolderChoice,
} from "./arr-title";
import type { TitleAdd } from "./arr-title-add";

const resourcePath = (service: ArrService, arrId: number) => `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`;
const mediaTypeOf = (service: ArrService) => (service === "radarr" ? "MOVIE" : "TV") as "MOVIE" | "TV";

/** The title is on the instance already (an add) — `arrId` names it for the manager. */
export class TitleExistsError extends Error {
  readonly arrId: number;
  constructor(arrId: number) {
    super("already on the instance");
    this.arrId = arrId;
  }
}
/** The arr's own lookup has no such title (or only a different one). */
export class TitleLookupError extends Error {}
/** APPROVED requests on this instance would re-add a removed title on the next sync. */
export class RequestsActiveError extends Error {
  readonly approved: number;
  constructor(approved: number) {
    super("approved requests on this instance");
    this.approved = approved;
  }
}

async function readTitle(cfg: ArrCfg, service: ArrService, instance: string, arrId: number): Promise<ArrTitle | null> {
  try {
    const raw = await arrFetch<unknown>(cfg, resourcePath(service, arrId));
    const title = projectTitle(service, instance, raw);
    return title && title.arrId === arrId ? title : null;
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) return null;
    throw err;
  }
}

// ── removing ─────────────────────────────────────────────────────────────────

export interface RequestCounts { pending: number; approved: number; available: number }

/**
 * The requests that point at this title: by tmdb id OR by tvdb id when the
 * arr reports both. Sonarr v3 sends no tmdbId, and a TV request carries the
 * tvdbId it was pushed with — which can be the only link when TMDB's id for
 * the show and Sonarr's disagree (a merged or re-split TMDB entry), so
 * matching on one id alone would miss an APPROVED request that re-adds it.
 */
export function requestIdentity(ids: { tmdbId: number | null; tvdbId: number | null }): { OR: Array<{ tmdbId: number } | { tvdbId: number }> } | null {
  const or: Array<{ tmdbId: number } | { tvdbId: number }> = [];
  if (ids.tmdbId !== null) or.push({ tmdbId: ids.tmdbId });
  if (ids.tvdbId !== null) or.push({ tvdbId: ids.tvdbId });
  return or.length > 0 ? { OR: or } : null;
}

/** The requests for this title routed to THIS instance, by status. */
async function requestCounts(service: ArrService, instance: string, title: ArrTitle): Promise<RequestCounts> {
  const identity = requestIdentity(title);
  if (!identity) return { pending: 0, approved: 0, available: 0 };
  const rows = await prisma.mediaRequest.groupBy({
    by: ["status"],
    where: { ...identity, mediaType: mediaTypeOf(service), arrInstance: instance },
    _count: { _all: true },
  });
  const count = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return { pending: count("PENDING"), approved: count("APPROVED"), available: count("AVAILABLE") };
}

export interface RemovalPlan {
  title: ArrTitle;
  requests: RequestCounts;
}

/** The dry run: what would go, and whether an APPROVED request blocks it. Nothing is changed. */
export async function planTitleRemoval(service: ArrService, instance: string, arrId: number): Promise<RemovalPlan | null> {
  const cfg = await configuredArrCfg(service, instance);
  const title = await readTitle(cfg, service, instance, arrId);
  if (!title) return null;
  return { title, requests: await requestCounts(service, instance, title) };
}

export interface RemovalResult {
  title: ArrTitle;
  /** The instance no longer had it (removed by hand since the dry run). */
  alreadyGone: boolean;
  requestsStamped: number;
}

/**
 * Remove a title from one instance — `deleteFiles` and the import-list
 * exclusion are always sent explicitly (the queue-removal lesson, guardrail
 * 5c: an omitted flag is the arr's default, not "off"). Throws
 * RequestsActiveError (nothing changed) while an APPROVED request on this
 * instance would put it back.
 */
export async function removeTitle(
  service: ArrService,
  instance: string,
  arrId: number,
  opts: { deleteFiles: boolean; addImportExclusion: boolean },
  now: Date = new Date(),
): Promise<RemovalResult | null> {
  const cfg = await configuredArrCfg(service, instance);
  const title = await readTitle(cfg, service, instance, arrId);
  if (!title) return null;
  const counts = await requestCounts(service, instance, title);
  if (counts.approved > 0) throw new RequestsActiveError(counts.approved);

  // Stamp FIRST: without it, the next sync reads the title's disappearance as a
  // lost file and re-adds it. Only rows not already stamped, so an unstamp
  // below never clears an older stamp.
  const identity = requestIdentity(title);
  const toStamp = identity
    ? await prisma.mediaRequest.findMany({
      where: { ...identity, mediaType: mediaTypeOf(service), arrInstance: instance, status: "AVAILABLE", cleanedUpAt: null },
      select: { id: true },
    })
    : [];
  const stampedIds = toStamp.map((r) => r.id);
  if (stampedIds.length > 0) {
    await prisma.mediaRequest.updateMany({ where: { id: { in: stampedIds }, cleanedUpAt: null }, data: { cleanedUpAt: now } });
  }

  const flags = service === "radarr"
    ? `deleteFiles=${opts.deleteFiles}&addImportExclusion=${opts.addImportExclusion}`
    : `deleteFiles=${opts.deleteFiles}&addImportListExclusion=${opts.addImportExclusion}`;
  try {
    await arrFetchNoContent(cfg, `${resourcePath(service, arrId)}?${flags}`, { method: "DELETE" });
  } catch (err) {
    // Gone already: the goal is met, and the stamps are right.
    if (err instanceof ArrResponseError && err.status === 404) return { title, alreadyGone: true, requestsStamped: stampedIds.length };
    if (stampedIds.length > 0) {
      await prisma.mediaRequest.updateMany({ where: { id: { in: stampedIds }, cleanedUpAt: now }, data: { cleanedUpAt: null } });
    }
    throw err;
  }
  return { title, alreadyGone: false, requestsStamped: stampedIds.length };
}

// ── adding ───────────────────────────────────────────────────────────────────

export interface AddPreview {
  tmdbId: number;
  title: string;
  year: number | null;
}

export interface AddChoices {
  /** The arr's id when the instance already has the title — the form offers Manage instead. */
  presentArrId: number | null;
  preview: AddPreview | null;
  qualityProfiles: Choice[];
  rootFolders: RootFolderChoice[];
  tags: Choice[];
  /** The instance's configured add defaults (what a request's add would use). */
  defaults: { qualityProfileId: number | null; rootFolderPath: string | null; minimumAvailability: string | null };
}

type LookupMovie = { tmdbId?: number; title?: string; year?: number; titleSlug?: string; images?: unknown };
type LookupSeries = { tmdbId?: number; tvdbId?: number; title?: string; year?: number; titleSlug?: string; images?: unknown; seasons?: Array<{ seasonNumber?: number }> };

async function lookupMovie(cfg: ArrCfg, tmdbId: number): Promise<LookupMovie | null> {
  const rows = await arrFetch<LookupMovie[]>(cfg, `/api/v3/movie/lookup?term=tmdb:${tmdbId}`);
  // A `tmdb:` term the arr doesn't recognise degrades to a title search, so
  // only the row naming THIS id counts (the request add's rule).
  const list = Array.isArray(rows) ? rows : [];
  return list.find((m) => m?.tmdbId === tmdbId) ?? null;
}

async function firstLanguageProfile(cfg: ArrCfg): Promise<number | null> {
  try {
    const rows = await arrFetch<Array<{ id?: unknown }>>(cfg, "/api/v3/languageprofile", { quietErrors: true });
    const id = Array.isArray(rows) ? rows.find((r) => typeof r?.id === "number")?.id : undefined;
    return typeof id === "number" && id > 0 ? id : null;
  } catch {
    return null;
  }
}

async function lookupSeries(cfg: ArrCfg, tmdbId: number): Promise<LookupSeries | null> {
  // Sonarr by tmdb id, then TMDB's own TVDB cross-reference (guardrail 14a).
  return lookupSeriesByTmdbId<LookupSeries & { tmdbId?: number; tvdbId?: number }>(cfg, tmdbId);
}

export async function loadAddChoices(service: ArrService, instance: string, tmdbId: number): Promise<AddChoices> {
  const cfg = await configuredArrCfg(service, instance);
  const [found, profiles, folders, tags, defaults, looked] = await Promise.all([
    findTitle(service, instance, tmdbId),
    arrFetch<unknown>(cfg, "/api/v3/qualityprofile"),
    arrFetch<unknown>(cfg, "/api/v3/rootfolder"),
    arrFetch<unknown>(cfg, "/api/v3/tag"),
    getArrAddDefaults(service, instance),
    service === "radarr" ? lookupMovie(cfg, tmdbId) : lookupSeries(cfg, tmdbId),
  ]);
  return {
    presentArrId: found?.arrId ?? null,
    preview: looked && typeof looked.title === "string"
      ? { tmdbId, title: looked.title.slice(0, 300), year: typeof looked.year === "number" && looked.year > 0 ? looked.year : null }
      : null,
    qualityProfiles: projectChoices(profiles),
    rootFolders: projectRootFolderChoices(folders),
    tags: projectChoices(tags, "label"),
    defaults: {
      qualityProfileId: defaults?.qualityProfileId ?? null,
      rootFolderPath: defaults?.rootFolder ?? null,
      minimumAvailability: defaults?.minimumAvailability ?? null,
    },
  };
}

/**
 * An admin putting the title back on this instance withdraws an earlier
 * removal (this instance's or Library cleanup's): its `cleanedUpAt` stamps on
 * this instance's requests are cleared, so a later disappearance is read as a
 * lost file again and re-pushed (guardrail 14b) instead of being remembered as
 * a deliberate delete forever. Other instances' stamps stay — the title is
 * still gone there. Best-effort: the add has happened, and a stamp left behind
 * only means one less automatic re-push.
 */
async function clearRemovalStamps(service: ArrService, instance: string, ids: { tmdbId: number | null; tvdbId: number | null }): Promise<void> {
  const identity = requestIdentity(ids);
  if (!identity) return;
  try {
    await prisma.mediaRequest.updateMany({
      where: { ...identity, mediaType: mediaTypeOf(service), arrInstance: instance, cleanedUpAt: { not: null } },
      data: { cleanedUpAt: null },
    });
  } catch (err) {
    console.error(`[arr-title] couldn't clear the removal stamps after an add: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Add a title with the admin's choices. The profile, root folder and tags must
 * be the instance's own (TitleEditError otherwise — nothing is written); a
 * title it already has is TitleExistsError; one its lookup can't find is
 * TitleLookupError. Answers the new arr id.
 */
export async function addTitle(service: ArrService, instance: string, add: TitleAdd): Promise<{ arrId: number; title: string }> {
  const cfg = await configuredArrCfg(service, instance);
  const [found, profiles, folders, tags] = await Promise.all([
    findTitle(service, instance, add.tmdbId),
    arrFetch<unknown>(cfg, "/api/v3/qualityprofile"),
    arrFetch<unknown>(cfg, "/api/v3/rootfolder"),
    arrFetch<unknown>(cfg, "/api/v3/tag"),
  ]);
  if (found) throw new TitleExistsError(found.arrId);
  checkTitleEdit(
    { qualityProfileId: add.qualityProfileId, rootFolderPath: add.rootFolderPath, tags: add.tags },
    {
      profileIds: new Set(projectChoices(profiles).map((p) => p.id)),
      rootFolders: new Set(projectRootFolderChoices(folders).map((f) => f.path)),
      tagIds: new Set(projectChoices(tags, "label").map((t) => t.id)),
      seasonNumbers: new Set(),
    },
  );

  if (service === "radarr") {
    const movie = await lookupMovie(cfg, add.tmdbId);
    if (!movie || typeof movie.title !== "string") throw new TitleLookupError();
    // Only the listed fields, never the whole lookup row (the request add's rule).
    const created = await arrFetch<{ id?: unknown }>(cfg, "/api/v3/movie", {
      method: "POST",
      body: JSON.stringify({
        tmdbId: add.tmdbId,
        title: movie.title,
        year: movie.year,
        titleSlug: movie.titleSlug,
        images: movie.images,
        rootFolderPath: add.rootFolderPath,
        qualityProfileId: add.qualityProfileId,
        ...(add.minimumAvailability ? { minimumAvailability: add.minimumAvailability } : {}),
        tags: add.tags,
        monitored: add.monitored === true,
        addOptions: { searchForMovie: add.search },
      }),
    });
    const arrId = typeof created?.id === "number" ? created.id : 0;
    await clearRemovalStamps(service, instance, { tmdbId: add.tmdbId, tvdbId: null });
    return { arrId, title: movie.title };
  }

  const series = await lookupSeries(cfg, add.tmdbId);
  if (!series || typeof series.title !== "string" || typeof series.tvdbId !== "number") throw new TitleLookupError();
  const defaults = await getArrAddDefaults("sonarr", instance);
  // Sonarr v3 refuses an add without a language profile; v4 has none (404).
  const languageProfileId = defaults?.languageProfileId ?? (await firstLanguageProfile(cfg));
  const monitor = add.monitor ?? "all";
  const created = await arrFetch<{ id?: unknown }>(cfg, "/api/v3/series", {
    method: "POST",
    body: JSON.stringify({
      tvdbId: series.tvdbId,
      title: series.title,
      year: series.year,
      titleSlug: series.titleSlug,
      images: series.images,
      // Sonarr sets each season's and episode's monitoring from addOptions.monitor;
      // the seasons only need to be listed.
      seasons: (series.seasons ?? [])
        .filter((s) => typeof s?.seasonNumber === "number")
        .map((s) => ({ seasonNumber: s.seasonNumber, monitored: monitor !== "none" && (s.seasonNumber as number) > 0 })),
      rootFolderPath: add.rootFolderPath,
      qualityProfileId: add.qualityProfileId,
      // Sonarr v3 only (v4 has no language profiles).
      ...(languageProfileId ? { languageProfileId } : {}),
      ...(add.seriesType ? { seriesType: add.seriesType } : {}),
      ...(add.seasonFolder !== undefined ? { seasonFolder: add.seasonFolder } : {}),
      tags: add.tags,
      monitored: monitor !== "none",
      addOptions: { monitor, searchForMissingEpisodes: add.search },
    }),
  });
  const arrId = typeof created?.id === "number" ? created.id : 0;
  await clearRemovalStamps(service, instance, { tmdbId: add.tmdbId, tvdbId: series.tvdbId });
  return { arrId, title: series.title };
}
