// "Did the replacement this issue grab was waiting for actually land?" — asked
// of the firing Radarr/Sonarr instance before a Download webhook claims the
// grab (arr-webhook.ts claimCompletedGrabs).
//
// The webhook secret says who is calling, not that the import happened. The
// claim is one-shot (IssueGrab.notifiedAt is never reset), tells the admin "the
// replacement landed" and, with issue auto-resolve on, closes the issue
// (guardrail 5j), so a forged or premature Download must not reach it. The
// instance is the witness: a file inside the grab's own scope whose `dateAdded`
// is NEWER than the grab. The payload only says which title to ask about —
// never which file, and never which series a grab belongs to.
//
// Three answers per grab: confirmed, refuted (the instance answered and holds
// no such file — the grab stays pending for a later delivery), unverified (no
// usable answer: instance unconfigured or unreachable, or an answer of the
// wrong shape — never claimed either; the routes retry those once after the
// library scan). Imports its arr siblings directly, never the arr.ts entry.
import type { IssueGrab } from "@/generated/prisma";
import { arrErrorMessage, arrFetch, asRecord, type ArrCfg } from "./arr-client";
import { getArrCfg } from "./arr-config";
import { findRadarrMovie, findSonarrSeries } from "./arr-lookup";
import { posInt } from "./arr-parse";
import type { ArrService } from "./arr-instances";

export type GrabToConfirm = Pick<
  IssueGrab,
  "id" | "createdAt" | "tmdbId" | "tvdbId" | "mediaType" | "scope" | "seasonNumber" | "episodeNumber" | "arrInstance"
>;

export interface GrabConfirmation {
  /** The instance holds a file in the grab's scope added after the grab. */
  confirmed: Set<string>;
  /** No usable answer from the instance. Everything in neither set was refuted. */
  unverified: Set<string>;
}

/**
 * The most file or episode rows one confirmation reads from an answer
 * (guardrail 5i): arrFetch caps a response by size only. A row past it is not
 * read, so a file there confirms nothing — the grab stays pending.
 */
export const MAX_CONFIRM_ROWS = 50_000;
/** The most distinct titles one delivery's grabs are checked against; the rest stay unverified. */
export const MAX_CONFIRM_TITLES = 4;

const addedAtMs = (row: Record<string, unknown>): number | null => {
  if (typeof row.dateAdded !== "string") return null;
  const ms = Date.parse(row.dateAdded);
  return Number.isFinite(ms) ? ms : null;
};

class UnusableAnswer extends Error {}

// The newest `dateAdded` among the movie's own file rows (null: no file).
// Radarr's row for the tmdbId gives its arr id; null when Radarr doesn't hold it.
async function newestMovieFileMs(cfg: ArrCfg, tmdbId: number): Promise<number | null> {
  const movie = await findRadarrMovie(cfg, tmdbId);
  if (!movie) return null;
  const arrId = posInt(movie.id);
  if (arrId === null) throw new UnusableAnswer();
  const files = await arrFetch<unknown>(cfg, `/api/v3/moviefile?movieId=${arrId}`);
  if (!Array.isArray(files)) throw new UnusableAnswer();
  let newest: number | null = null;
  const end = Math.min(files.length, MAX_CONFIRM_ROWS);
  for (let i = 0; i < end; i++) {
    const f = asRecord(files[i]);
    // Strict: a row naming another movie (an arr that ignored the filter) is not this one's.
    if (!f || f.movieId !== arrId) continue;
    const ms = addedAtMs(f);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

async function confirmRadarr(cfg: ArrCfg, grabs: readonly GrabToConfirm[], out: GrabConfirmation): Promise<void> {
  const newestByTmdb = new Map<number, number | null | "unverified">();
  for (const grab of grabs) {
    if (!newestByTmdb.has(grab.tmdbId)) {
      if (newestByTmdb.size >= MAX_CONFIRM_TITLES) {
        out.unverified.add(grab.id);
        continue;
      }
      try {
        newestByTmdb.set(grab.tmdbId, await newestMovieFileMs(cfg, grab.tmdbId));
      } catch (err) {
        console.warn("[webhook/radarr] grab confirmation failed:", err instanceof UnusableAnswer ? "unusable answer" : arrErrorMessage(err));
        newestByTmdb.set(grab.tmdbId, "unverified");
      }
    }
    const newest = newestByTmdb.get(grab.tmdbId);
    if (newest === "unverified") out.unverified.add(grab.id);
    else if (newest != null && newest > grab.createdAt.getTime()) out.confirmed.add(grab.id);
  }
}

// One series' files on the instance, read once per delivery.
interface SeriesFiles {
  arrId: number;
  /** Sonarr's own tmdbId for the series, when its row names one. */
  tmdbId: number | null;
  /** file id → when it was added. */
  addedById: Map<number, number>;
  newestBySeason: Map<number, number>;
  newest: number | null;
}

async function readSeriesFiles(cfg: ArrCfg, tvdbId: number): Promise<SeriesFiles | null> {
  const series = await findSonarrSeries(cfg, tvdbId);
  if (!series) return null;
  const arrId = posInt(series.id);
  if (arrId === null) throw new UnusableAnswer();
  const files = await arrFetch<unknown>(cfg, `/api/v3/episodefile?seriesId=${arrId}`);
  if (!Array.isArray(files)) throw new UnusableAnswer();
  const out: SeriesFiles = { arrId, tmdbId: posInt(series.tmdbId), addedById: new Map(), newestBySeason: new Map(), newest: null };
  const end = Math.min(files.length, MAX_CONFIRM_ROWS);
  for (let i = 0; i < end; i++) {
    const f = asRecord(files[i]);
    if (!f || f.seriesId !== arrId) continue;
    const id = posInt(f.id);
    const ms = addedAtMs(f);
    if (id === null || ms === null) continue;
    out.addedById.set(id, ms);
    if (out.newest === null || ms > out.newest) out.newest = ms;
    const season = f.seasonNumber;
    if (typeof season === "number" && Number.isInteger(season) && season >= 0) {
      const prev = out.newestBySeason.get(season);
      if (prev === undefined || ms > prev) out.newestBySeason.set(season, ms);
    }
  }
  return out;
}

// When episode SxEy's CURRENT file was added, or null when it has none. Asks
// for that season only and still matches season, episode and series itself
// (findEpisodeId's rule), since the file list alone doesn't say which episode
// a file holds.
async function episodeFileAddedMs(cfg: ArrCfg, files: SeriesFiles, seasonNumber: number, episodeNumber: number): Promise<number | null> {
  const rows = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${files.arrId}&seasonNumber=${seasonNumber}`);
  if (!Array.isArray(rows)) throw new UnusableAnswer();
  const end = Math.min(rows.length, MAX_CONFIRM_ROWS);
  for (let i = 0; i < end; i++) {
    const ep = asRecord(rows[i]);
    if (!ep || ep.seasonNumber !== seasonNumber || ep.episodeNumber !== episodeNumber) continue;
    if (ep.seriesId !== undefined && ep.seriesId !== files.arrId) continue;
    const fileId = posInt(ep.episodeFileId);
    return fileId === null ? null : files.addedById.get(fileId) ?? null;
  }
  return null;
}

async function confirmSonarr(
  cfg: ArrCfg,
  grabs: readonly GrabToConfirm[],
  deliveryTvdbId: number | null,
  out: GrabConfirmation,
): Promise<void> {
  const seriesByTvdb = new Map<number, SeriesFiles | null | "unverified">();
  const episodeMs = new Map<string, number | null | "unverified">();
  const warn = (err: unknown) =>
    console.warn("[webhook/sonarr] grab confirmation failed:", err instanceof UnusableAnswer ? "unusable answer" : arrErrorMessage(err));

  for (const grab of grabs) {
    // The series is the GRAB's own (its tvdbId was stored when it was fired).
    // A grab without one is tied to the delivery's series only by Sonarr's own
    // row naming the grab's tmdbId — never by the payload pairing the two.
    const tvdbId = posInt(grab.tvdbId) ?? deliveryTvdbId;
    if (tvdbId === null) continue;
    if (!seriesByTvdb.has(tvdbId)) {
      if (seriesByTvdb.size >= MAX_CONFIRM_TITLES) {
        out.unverified.add(grab.id);
        continue;
      }
      try {
        seriesByTvdb.set(tvdbId, await readSeriesFiles(cfg, tvdbId));
      } catch (err) {
        warn(err);
        seriesByTvdb.set(tvdbId, "unverified");
      }
    }
    const files = seriesByTvdb.get(tvdbId);
    if (files === "unverified") {
      out.unverified.add(grab.id);
      continue;
    }
    if (!files) continue;
    if (grab.tvdbId === null && files.tmdbId !== grab.tmdbId) continue;

    // The scope rule is grabMatchesDelivery's, asked of the instance's files.
    let added: number | null;
    if (grab.scope === "EPISODE" && grab.seasonNumber != null && grab.episodeNumber != null) {
      const key = `${tvdbId}:${grab.seasonNumber}:${grab.episodeNumber}`;
      if (!episodeMs.has(key)) {
        try {
          episodeMs.set(key, await episodeFileAddedMs(cfg, files, grab.seasonNumber, grab.episodeNumber));
        } catch (err) {
          warn(err);
          episodeMs.set(key, "unverified");
        }
      }
      const ms = episodeMs.get(key);
      if (ms === "unverified") {
        out.unverified.add(grab.id);
        continue;
      }
      added = ms ?? null;
    } else if (grab.scope === "SEASON" && grab.seasonNumber != null) {
      added = files.newestBySeason.get(grab.seasonNumber) ?? null;
    } else {
      added = files.newest;
    }
    if (added !== null && added > grab.createdAt.getTime()) out.confirmed.add(grab.id);
  }
}

/**
 * Ask the firing instance which of `grabs` its files confirm. Only that
 * instance's config is read (guardrail 32); a grab recorded for another
 * instance or media type is refuted without a call. Never throws.
 */
export async function confirmDeliveredGrabs(
  service: ArrService,
  arrInstance: string,
  grabs: readonly GrabToConfirm[],
  delivery: { tvdbId?: number | null } = {},
): Promise<GrabConfirmation> {
  const out: GrabConfirmation = { confirmed: new Set(), unverified: new Set() };
  const mediaType = service === "radarr" ? "MOVIE" : "TV";
  const own = grabs.filter((g) => g.arrInstance === arrInstance && g.mediaType === mediaType);
  if (own.length === 0) return out;
  try {
    const cfg = await getArrCfg(service, arrInstance);
    if (!cfg) {
      for (const g of own) out.unverified.add(g.id);
      return out;
    }
    if (service === "radarr") await confirmRadarr(cfg, own, out);
    else await confirmSonarr(cfg, own, posInt(delivery.tvdbId), out);
  } catch (err) {
    console.warn(`[webhook/${service}] grab confirmation failed:`, arrErrorMessage(err));
    for (const g of own) if (!out.confirmed.has(g.id)) out.unverified.add(g.id);
  }
  return out;
}
