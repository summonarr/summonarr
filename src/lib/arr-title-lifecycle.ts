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
//     the delete (only rows not already stamped, in one conditional write), so
//     the sync never reads the title's disappearance as a lost file and re-adds
//     it; the stamps this call wrote are removed again only when the arr
//     definitely refused the delete AND a re-read shows the title still there,
//     and a removal that went through re-asserts them with its own time, so a
//     concurrent removal whose delete was refused can't unstamp a gone title.
//     An unknown outcome — a timeout, a network failure, a 502/504 from a
//     proxy — KEEPS them: the arr may have taken the delete.
//     Status and approvedAt are never touched (guardrail 34a).
import { prisma } from "./prisma";
import {
  ArrResponseError,
  arrFetch,
  arrFetchNoContent,
  arrWriteOutcomeUnknown,
  getArrAddDefaults,
  lookupSeriesByTmdbId,
  resolveSingleTvdbToTmdb,
  type ArrCfg,
} from "./arr";
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

type RequestIds = { tmdbId: number | null; tvdbId: number | null };

/**
 * The ids a removal matches requests by. A Sonarr series with no tmdbId (v3
 * sends none; v4 reports 0 when TVDB has no TMDB link) would otherwise match
 * on its tvdb id alone — but `MediaRequest.tvdbId` is written only by a
 * successful Sonarr push, so a request that was never pushed (a mirror copy, a
 * PENDING row the library marking pass flipped AVAILABLE) carries none. The
 * sync's Sonarr cache keys such a series by the tmdb id `resolveTvdbToTmdb`
 * maps it to (cache → MediaRequest → TMDB), and the demote and re-push act on
 * THAT key, so the removal counts and stamps by it too (guardrail 14b).
 * Unresolvable (a TMDB outage) ⇒ the tvdb id alone, as before.
 */
async function requestIds(service: ArrService, title: ArrTitle): Promise<RequestIds> {
  if (title.tmdbId !== null || service !== "sonarr" || title.tvdbId === null) return { tmdbId: title.tmdbId, tvdbId: title.tvdbId };
  return { tmdbId: await resolveSingleTvdbToTmdb(title.tvdbId), tvdbId: title.tvdbId };
}

/** The requests for this title routed to THIS instance, by status. */
async function requestCounts(service: ArrService, instance: string, ids: RequestIds): Promise<RequestCounts> {
  const identity = requestIdentity(ids);
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
  return { title, requests: await requestCounts(service, instance, await requestIds(service, title)) };
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
  const ids = await requestIds(service, title);
  const counts = await requestCounts(service, instance, ids);
  if (counts.approved > 0) throw new RequestsActiveError(counts.approved);

  // Stamp FIRST: without it, the next sync reads the title's disappearance as a
  // lost file and re-adds it. ONE conditional write, and the rows it returns are
  // the stamps this call owns: only rows not already stamped, so a concurrent
  // removal's stamps are never counted, audited or unstamped here, and an
  // unstamp below never clears an older stamp.
  const identity = requestIdentity(ids);
  const stamped = identity
    ? await prisma.mediaRequest.updateManyAndReturn({
      where: { ...identity, mediaType: mediaTypeOf(service), arrInstance: instance, status: "AVAILABLE", cleanedUpAt: null },
      data: { cleanedUpAt: now },
      select: { id: true },
    })
    : [];
  const stampedIds = stamped.map((r) => r.id);

  const flags = service === "radarr"
    ? `deleteFiles=${opts.deleteFiles}&addImportExclusion=${opts.addImportExclusion}`
    : `deleteFiles=${opts.deleteFiles}&addImportListExclusion=${opts.addImportExclusion}`;
  // The title is gone from the instance: this call now OWNS the stamp on every
  // AVAILABLE request routed there. A concurrent removal (or a cleanup execute)
  // that stamped first and then saw its own delete refused unstamps by ITS time
  // — re-asserted with this call's, its unstamp misses the rows, and if it
  // already ran this writes them back (14b). Only null vs set is ever read.
  // Best-effort: the delete is durable, so a failed write is logged, not thrown.
  const reassertStamp = async () => {
    if (!identity) return;
    try {
      await prisma.mediaRequest.updateMany({
        where: { ...identity, mediaType: mediaTypeOf(service), arrInstance: instance, status: "AVAILABLE" },
        data: { cleanedUpAt: now },
      });
    } catch (err) {
      console.error(`[arr-title] re-asserting the cleanup stamp after removing ${service}:${instance || "default"}:${arrId} failed:`, err instanceof Error ? err.message : err);
    }
  };
  try {
    await arrFetchNoContent(cfg, `${resourcePath(service, arrId)}?${flags}`, { method: "DELETE" });
  } catch (err) {
    // Gone already: the goal is met, and the stamps are right.
    if (err instanceof ArrResponseError && err.status === 404) {
      await reassertStamp();
      return { title, alreadyGone: true, requestsStamped: stampedIds.length };
    }
    // Any other failure may still have deleted it — a timeout or a dropped
    // connection after the arr acted, or a concurrent removal that won. Only a
    // re-read showing the title STILL on the instance proves the delete didn't
    // happen; an unstamp on a deleted title re-downloads it (14b), whereas a
    // stamp left on a present one costs at most one automatic re-push later.
    // An UNKNOWN outcome (timeout, network, a gateway's 502/504) keeps the
    // stamps even then: the arr may still be holding the DELETE — behind its
    // database lock, while a GET answers "still there" — and finish it later.
    let stillThere: boolean | null;
    try {
      stillThere = (await readTitle(cfg, service, instance, arrId)) !== null;
    } catch {
      stillThere = null;
    }
    if (stillThere === false) {
      // Removed after all — by this call, most likely, so it reads as removed
      // here (alreadyGone: false keeps the route's library rescan).
      await reassertStamp();
      return { title, alreadyGone: false, requestsStamped: stampedIds.length };
    }
    if (stillThere && stampedIds.length > 0 && !arrWriteOutcomeUnknown(err)) {
      await prisma.mediaRequest.updateMany({ where: { id: { in: stampedIds }, cleanedUpAt: now }, data: { cleanedUpAt: null } });
    }
    throw err;
  }
  await reassertStamp();
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

/** The title's arr id on the instance now, or null (a failed read included). */
async function presentArrId(service: ArrService, instance: string, tmdbId: number): Promise<number | null> {
  try {
    return (await findTitle(service, instance, tmdbId))?.arrId ?? null;
  } catch {
    return null;
  }
}

/**
 * The series Sonarr holds under the tvdbId an add was just POSTed with, or null
 * (a failed read included). That id is what Sonarr keys the series on, so it
 * confirms the add by itself — findTitle's tmdb route can't: on Sonarr v3 (no
 * tmdbId on any row) it needs TMDB's TVDB cross-reference, which is missing or
 * failing exactly when the add resolved the series through a lone lookup row.
 */
async function seriesIdByTvdb(cfg: ArrCfg, tvdbId: number): Promise<number | null> {
  try {
    const library = await arrFetch<unknown>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
    const row = Array.isArray(library) ? (library as Array<{ id?: unknown; tvdbId?: unknown }>).find((s) => s?.tvdbId === tvdbId) : undefined;
    return typeof row?.id === "number" && row.id > 0 ? row.id : null;
  } catch {
    return null;
  }
}

/**
 * POST the add and answer the new arr id. A definite refusal (a 4xx) stays the
 * arr's error. An UNKNOWN outcome — a timeout, a dropped connection, a 5xx (a
 * reverse proxy's 504), a body that won't parse — may have been accepted: the
 * arr would then hold a title nobody audited and whose removal stamps were
 * never withdrawn, and the retry only hits "already there" (409). So the title
 * is re-read (`reread`: Radarr by tmdbId, Sonarr by the tvdbId it was sent —
 * seriesIdByTvdb), and found there it is treated as added. A created resource
 * with no id is resolved the same way rather than recorded as 0.
 */
async function postAdd(cfg: ArrCfg, service: ArrService, body: string, reread: () => Promise<number | null>): Promise<number> {
  let created: { id?: unknown } | null;
  try {
    created = await arrFetch<{ id?: unknown }>(cfg, service === "radarr" ? "/api/v3/movie" : "/api/v3/series", { method: "POST", body });
  } catch (err) {
    if (err instanceof ArrResponseError && err.status < 500) throw err;
    const arrId = await reread();
    if (arrId === null) throw err;
    return arrId;
  }
  if (typeof created?.id === "number" && created.id > 0) return created.id;
  return (await reread()) ?? 0;
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
    const arrId = await postAdd(cfg, service, JSON.stringify({
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
    }), () => presentArrId(service, instance, add.tmdbId));
    await clearRemovalStamps(service, instance, { tmdbId: add.tmdbId, tvdbId: null });
    return { arrId, title: movie.title };
  }

  const series = await lookupSeries(cfg, add.tmdbId);
  if (!series || typeof series.title !== "string" || typeof series.tvdbId !== "number") throw new TitleLookupError();
  const defaults = await getArrAddDefaults("sonarr", instance);
  // Sonarr v3 refuses an add without a language profile; v4 has none (404).
  const languageProfileId = defaults?.languageProfileId ?? (await firstLanguageProfile(cfg));
  const monitor = add.monitor ?? "all";
  const tvdbId = series.tvdbId;
  const arrId = await postAdd(cfg, service, JSON.stringify({
    tvdbId,
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
  }), () => seriesIdByTvdb(cfg, tvdbId));
  await clearRemovalStamps(service, instance, { tmdbId: add.tmdbId, tvdbId });
  return { arrId, title: series.title };
}
