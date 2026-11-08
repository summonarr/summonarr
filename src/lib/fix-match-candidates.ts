// What GET /api/admin/fix-match/candidates puts together for the fix-match
// picker (Plex) and the confirmation card (Jellyfin): the CORRECT title's TMDB
// details, a live Radarr/Sonarr cross-check of the folder being re-matched,
// and — for Plex — the server's own /matches candidates, each scored against
// the target. Every upstream here is a hint, so a failure degrades the answer
// instead of failing it; each step says whether it degraded, so the route
// never caches a degraded answer as if it were the whole one.
import { safeFetchAdminConfigured, safeFetchTrusted } from "./safe-fetch";
import { arrFetch } from "./arr";
import { configuredArrCfg, enabledArrInstances } from "./arr-admin";
import { assessCandidate, compareCandidates, type CandidateMatch } from "./fix-match-scoring";
import { cachedArrList, cachedTmdbTitle, normaliseLibraryPath, pathWithin, tmdbDetailsCacheKey } from "./fix-match-shared";
import { getCache } from "./tmdb-cache";
import { tmdbAuth, type TmdbAuth } from "./tmdb-auth";
import { settleLimit } from "./concurrency";
import { v, type Infer } from "./validate";
import { upstreamChecked, upstreamFailed, upstreamMissing, type UpstreamResult } from "./upstream-result";

const TMDB_HOSTS = ["api.themoviedb.org"];

export type { CandidateMatch };

export type PlexCandidate = {
  guid:            string;
  name:            string;
  year:            number | null;
  thumb:           string | null;
  score:           number | null;
  imdbId:          string | null;
  tmdbId:          string | null;
  tmdbTitle:       string | null;
  tmdbOverview:    string | null;
  tmdbRuntime:     number | null;
  tmdbGenres:      string[];
  tmdbVoteAvg:     number | null;
  tmdbPosterPath:  string | null;
  matchLevel:      CandidateMatch;
  confidence:      number;
  titleSimilarity: number;
  radarrConfirmed: boolean;
  suggested:       boolean;
};

export type CandidatesResponse = {
  candidates:          PlexCandidate[];
  targetTitle:         string;
  targetYear:          string;
  targetImdbId:        string;
  targetPosterPath:    string | null;
  targetOverview:      string;
  targetReleaseDate:   string | null;
  targetVoteAverage:   number | null;
  targetRuntime:       number | null;
  targetGenres:        string[];
  arrConfirmedTmdbId:  number | null;
  arrConfirmedTitle:   string | null;
  arrPathAgrees:       boolean | null;
  ratingKey:           string;
  plexFilePath:        string | null;
  // Display-only comparison hint. Read from `serverInstance` when that Jellyfin
  // server holds the title, otherwise from any configured one that does — a bad
  // match can straddle two different servers, so the Plex slug must not scope
  // this side. See the route's lookup.
  jellyfinFilePath:    string | null;
  // Which configured Plex server the ratingKey + candidates came from. Echoed so
  // the caller can POST the fix back against the SAME server (a ratingKey is
  // server-local — see the fix-match POST route).
  serverInstance:      string;
  // What the library row is matched to NOW (the wrong title), so the dialog can
  // show "currently X → will become Y" instead of two bare ids.
  currentTitle:        string | null;
  currentYear:         string | null;
};

export type TargetDetails = {
  targetTitle:       string;
  targetYear:        string;
  targetImdbId:      string;
  targetPosterPath:  string | null;
  targetOverview:    string;
  targetReleaseDate: string | null;
  targetVoteAverage: number | null;
  targetRuntime:     number | null;
  targetGenres:      string[];
};

export type ArrConfirmation = {
  arrConfirmedTmdbId: number | null;
  arrConfirmedTitle: string | null;
  arrPathAgrees: boolean | null;
};

// ── TMDB ─────────────────────────────────────────────────────────────────────

// Only the fields read below. TMDB sends null for many of them; any other
// shape is a broken answer, never a partial one.
const TmdbDetailsSchema = v.object({
  title: v.optional(v.nullable(v.string())),
  name: v.optional(v.nullable(v.string())),
  overview: v.optional(v.nullable(v.string())),
  poster_path: v.optional(v.nullable(v.string())),
  runtime: v.optional(v.nullable(v.number())),
  episode_run_time: v.optional(v.nullable(v.array(v.number()))),
  genres: v.optional(v.nullable(v.array(v.object({ name: v.string() })))),
  vote_average: v.optional(v.nullable(v.number())),
  release_date: v.optional(v.nullable(v.string())),
  first_air_date: v.optional(v.nullable(v.string())),
  external_ids: v.optional(v.nullable(v.object({ imdb_id: v.optional(v.nullable(v.string())) }))),
});
type TmdbDetails = Infer<typeof TmdbDetailsSchema>;

// One title's details (external_ids appended). 404 is TMDB's answer; a network
// error, any other status, or a body that isn't the details shape is a failure.
async function fetchTmdbDetails(tmdbId: number, mediaType: "MOVIE" | "TV", auth: TmdbAuth): Promise<UpstreamResult<TmdbDetails>> {
  const type = mediaType === "MOVIE" ? "movie" : "tv";
  const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId}`);
  url.searchParams.set("append_to_response", "external_ids");
  let res: Response;
  try {
    res = await safeFetchTrusted(url.toString(), { allowedHosts: TMDB_HOSTS, headers: auth.headers, timeoutMs: 10_000 });
  } catch (err) {
    return upstreamFailed(err);
  }
  if (res.status === 404) return upstreamMissing();
  if (!res.ok) return upstreamFailed(new Error(`TMDB answered ${res.status}`));
  // A 200 that isn't JSON (a proxy page, a cut body) is no answer, not a 500.
  return upstreamChecked(TmdbDetailsSchema, await res.json().catch(() => undefined));
}

const str = (val: unknown): string | undefined => (typeof val === "string" ? val : undefined);

/**
 * The target's details: the cached details row first, live TMDB fills the gaps
 * (and alone gives the runtime and genres) when a token is configured. Every
 * field degrades to empty so the UI can still render a bare "TMDB #<id>";
 * `failed` says TMDB was asked and gave no usable answer (a 404 is an answer).
 */
export async function resolveTargetDetails(correctTmdbId: number, mediaType: "MOVIE" | "TV"): Promise<{ target: TargetDetails; failed: boolean }> {
  // getCache, not a raw read: an expired row is a miss, so a stale title, year
  // or IMDb id (which drives "exact" and "wrong") never outranks live TMDB.
  const p = await getCache<Record<string, unknown>>(tmdbDetailsCacheKey(mediaType, correctTmdbId));
  const cached = p !== null && typeof p === "object" ? p : {};
  const cache = {
    title: str(cached.title) ?? str(cached.name) ?? "",
    year: str(cached.releaseYear)?.slice(0, 4) ?? "",
    imdbId: str(cached.imdbId) ?? "",
    posterPath: str(cached.posterPath) ?? null,
    overview: str(cached.overview) ?? "",
    releaseDate: str(cached.releaseDate) ?? null,
    voteAverage: typeof cached.voteAverage === "number" ? cached.voteAverage : null,
  };

  // The details request carries external_ids (append_to_response), so a null
  // imdb_id there is TMDB's answer: there is no second read for it.
  const auth = tmdbAuth();
  const fetched = auth ? await fetchTmdbDetails(correctTmdbId, mediaType, auth) : null;
  const d = fetched?.kind === "ok" ? fetched.value : null;
  return {
    target: {
      targetTitle: d && !cache.title ? d.title ?? d.name ?? "" : cache.title,
      targetYear: d && !cache.year ? (d.release_date ?? d.first_air_date ?? "").slice(0, 4) : cache.year,
      targetImdbId: d && !cache.imdbId ? d.external_ids?.imdb_id ?? "" : cache.imdbId,
      targetPosterPath: d && !cache.posterPath ? d.poster_path ?? null : cache.posterPath,
      targetOverview: d && !cache.overview ? d.overview ?? "" : cache.overview,
      targetReleaseDate: cache.releaseDate,
      targetVoteAverage: d && !cache.voteAverage && d.vote_average ? d.vote_average : cache.voteAverage,
      targetRuntime: d ? d.runtime ?? d.episode_run_time?.[0] ?? null : null,
      targetGenres: d ? d.genres?.map((g) => g.name) ?? [] : [],
    },
    failed: fetched?.kind === "failed",
  };
}

// ── Radarr / Sonarr ──────────────────────────────────────────────────────────

/** An arr library row as far as the cross-check reads it. */
export type ArrRow = { tmdbId?: unknown; path?: unknown };

// An arr answer's rows, appended one by one: a spread push throws RangeError
// past ~125k rows (a Radarr that ignored ?tmdbId= sends its whole table), and a
// non-array answer or a non-object row adds nothing instead of a TypeError
// (guardrail 5i). The cross-check is a hint; a broken answer must not 500.
function appendRows(out: ArrRow[], rows: unknown): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows as unknown[]) {
    if (row !== null && typeof row === "object") out.push(row as ArrRow);
  }
}

// An arr entry with no folder can't vouch for a file: test the raw string, not
// its normalised form.
const hasArrPath = (path: unknown): path is string => typeof path === "string" && path.trim() !== "";

/**
 * Which TMDB id the arr library says the re-matched folder is, and whether its
 * folder holds the file. A row AT the file's folder decides it — the correct
 * id's first, then the current (wrong) id's, which the UI shows as the
 * "⚠ Radarr/Sonarr has TMDB #X" disagreement — so an arr that holds the right
 * title elsewhere never outvotes one that maps THIS folder to the wrong one.
 * Only when no row is at the folder does the correct id's membership confirm
 * on its own, with the paths disagreeing: gating on the path would lose the
 * confirmation entirely on split-mount deployments (the arr and media-server
 * paths legitimately differ there). Several instances: any row at the folder
 * wins over the first row listed.
 */
export function decideArrConfirmation(
  rows: { correct: readonly ArrRow[]; wrong: readonly ArrRow[] },
  ids: { tmdbId: number; correctTmdbId: number },
  libraryPath: string,
): { arrConfirmedTmdbId: number | null; arrPathAgrees: boolean | null } {
  const isCorrect = (m: ArrRow) => m.tmdbId === ids.correctTmdbId && hasArrPath(m.path);
  if (rows.correct.some((m) => isCorrect(m) && pathWithin(m.path as string, libraryPath))) {
    return { arrConfirmedTmdbId: ids.correctTmdbId, arrPathAgrees: true };
  }
  if (rows.wrong.some((m) => m.tmdbId === ids.tmdbId && hasArrPath(m.path) && pathWithin(m.path, libraryPath))) {
    return { arrConfirmedTmdbId: ids.tmdbId, arrPathAgrees: true };
  }
  if (rows.correct.some(isCorrect)) return { arrConfirmedTmdbId: ids.correctTmdbId, arrPathAgrees: false };
  return { arrConfirmedTmdbId: null, arrPathAgrees: null };
}

// Every enabled instance's rows for the two ids, read a few instances at a
// time and kept in instance order. `failed` = some read failed, so a missing
// confirmation may be the arr not answering rather than not knowing.
async function readArrRows(
  mediaType: "MOVIE" | "TV",
  tmdbId: number,
  correctTmdbId: number,
): Promise<{ correct: ArrRow[]; wrong: ArrRow[]; failed: boolean }> {
  const out = { correct: [] as ArrRow[], wrong: [] as ArrRow[], failed: false };
  // EVERY enabled instance of the service, not just the default one (guardrail
  // 32): a title that lives only in a 4K or anime instance used to get no
  // confirmation at all. A registry/settings failure degrades to "no
  // confirmation", never a 500.
  let instances: Awaited<ReturnType<typeof enabledArrInstances>>;
  try {
    instances = await enabledArrInstances(mediaType === "MOVIE" ? "radarr" : "sonarr");
  } catch (err) {
    console.error("[fix-match/candidates] arr instance lookup failed:", err instanceof Error ? err.message : err);
    return { ...out, failed: true };
  }
  const endpoint = mediaType === "MOVIE" ? "movie" : "series";
  const settled = await settleLimit(instances, 4, async (inst) => {
    const per = { correct: [] as ArrRow[], wrong: [] as ArrRow[], failed: false };
    let cfg;
    try {
      cfg = await configuredArrCfg(inst.service, inst.slug);
    } catch {
      return per;
    }
    // Through arrFetch: the 30s timeout, the 50 MB cap (guardrail 5), the
    // X-Api-Key and ArrResponseError. Radarr's movie list honors ?tmdbId=
    // server-side. Sonarr's series list does NOT (its only filter is ?tvdbId=),
    // and on Sonarr v3 SeriesResource carries no TmdbId at all — TV reads the
    // whole table once per instance, shared by both probes and kept briefly
    // (cachedArrList) so a bulk run of pickers does not download it again.
    if (mediaType === "MOVIE") {
      const [correctRes, wrongRes] = await Promise.allSettled([
        arrFetch<unknown>(cfg, `/api/v3/${endpoint}?tmdbId=${correctTmdbId}`),
        arrFetch<unknown>(cfg, `/api/v3/${endpoint}?tmdbId=${tmdbId}`),
      ]);
      for (const result of [correctRes, wrongRes]) {
        if (result.status === "rejected") {
          per.failed = true;
          console.error("[fix-match/candidates] Arr fetch rejected:", result.reason instanceof Error ? result.reason.message : result.reason);
        }
      }
      if (correctRes.status === "fulfilled") appendRows(per.correct, correctRes.value);
      if (wrongRes.status === "fulfilled") appendRows(per.wrong, wrongRes.value);
    } else {
      try {
        const all = await cachedArrList("sonarr", inst.slug, () => arrFetch<unknown>(cfg, `/api/v3/${endpoint}`));
        appendRows(per.correct, all);
        appendRows(per.wrong, all);
      } catch (err) {
        per.failed = true;
        console.error("[fix-match/candidates] Arr fetch rejected:", err instanceof Error ? err.message : err);
      }
    }
    return per;
  });
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      out.failed = true;
      continue;
    }
    // One by one, never a spread (above): the rows can be a whole library.
    for (const row of s.value.correct) out.correct.push(row);
    for (const row of s.value.wrong) out.wrong.push(row);
    if (s.value.failed) out.failed = true;
  }
  return out;
}

/**
 * The live Radarr/Sonarr cross-check of the folder being re-matched, minus
 * its title — an additive trust signal for the picker and the confirmation
 * card. Null everywhere when no file path, no arr, or nothing matched.
 */
export async function resolveArrMatch(
  mediaType: "MOVIE" | "TV",
  tmdbId: number,
  correctTmdbId: number,
  filePath: string | null,
): Promise<{ arrConfirmedTmdbId: number | null; arrPathAgrees: boolean | null; failed: boolean }> {
  if (!filePath) return { arrConfirmedTmdbId: null, arrPathAgrees: null, failed: false };
  const rows = await readArrRows(mediaType, tmdbId, correctTmdbId);
  // The library path ITSELF, not its parent: a Jellyfin series row's Path is
  // the series folder (Plex's is an episode file), so its parent is the
  // library root, which equals no Sonarr series path. A path at or under the
  // arr folder covers a movie file, an episode file and a series folder alike
  // (pathWithin).
  const decided = decideArrConfirmation(rows, { tmdbId, correctTmdbId }, normaliseLibraryPath(filePath));
  return { ...decided, failed: rows.failed };
}

/** The confirmed title's name: the target's own, or the cached name of the id the arr disagrees with. */
export async function arrConfirmedTitle(
  mediaType: "MOVIE" | "TV",
  arrConfirmedTmdbId: number | null,
  correctTmdbId: number,
  targetTitle: string,
): Promise<string | null> {
  if (arrConfirmedTmdbId === null) return null;
  if (arrConfirmedTmdbId === correctTmdbId) return targetTitle || null;
  return cachedTmdbTitle(mediaType, arrConfirmedTmdbId);
}

// ── Plex ─────────────────────────────────────────────────────────────────────

type RawResult = { guid: string; name: string; year: number | null; thumb: string | null; score: number | null; Guid: unknown };
export type RawCandidate = Omit<PlexCandidate, "matchLevel" | "confidence" | "titleSimilarity" | "tmdbTitle" | "tmdbOverview" | "tmdbRuntime" | "tmdbGenres" | "tmdbVoteAvg" | "tmdbPosterPath" | "radarrConfirmed" | "suggested">;

const finite = (val: unknown): number | null => (typeof val === "number" && Number.isFinite(val) ? val : null);

// One Plex search result, each field checked on its own: a result with no
// guid can't be picked and is dropped; a field of another type is absent.
// Plex has sent `year` as text — read as the number it names, never passed on
// as a string the scoring then can't compare.
function plexResult(raw: unknown): RawResult | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.guid !== "string") return null;
  const year = typeof r.year === "string" && /^\d{4}$/.test(r.year) ? Number(r.year) : finite(r.year);
  return {
    guid: r.guid,
    name: typeof r.name === "string" ? r.name : "",
    year,
    thumb: typeof r.thumb === "string" ? r.thumb : null,
    score: finite(r.score),
    Guid: r.Guid,
  };
}

function providerGuid(r: RawResult, prefix: "imdb://" | "tmdb://"): string | null {
  if (!Array.isArray(r.Guid)) return null;
  for (const g of r.Guid as unknown[]) {
    const id = (g as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return null;
}

function extractProviderIds(r: RawResult): { imdbId: string | null; tmdbId: string | null } {
  if (Array.isArray(r.Guid) && r.Guid.length > 0) {
    return { imdbId: providerGuid(r, "imdb://"), tmdbId: providerGuid(r, "tmdb://") };
  }
  const imdbMatch = /com\.plexapp\.agents\.imdb:\/\/(tt\d+)/i.exec(r.guid);
  const tmdbMatch = /com\.plexapp\.agents\.themoviedb:\/\/(\d+)/i.exec(r.guid);
  return { imdbId: imdbMatch?.[1] ?? null, tmdbId: tmdbMatch?.[1] ?? null };
}

/**
 * Plex's /matches for the item, five ways (IMDb guid, IMDb agent, TMDB agent,
 * title + year, the arr's id hint), deduped by guid in that order.
 * `firstImdbGuid` is the IMDb-guid search's first hit — the initial suggestion.
 * `failed` = some search got no usable answer, so the list may be short.
 */
export async function searchPlexCandidates(
  serverUrl: string,
  ratingKey: string,
  headers: Record<string, string>,
  target: { correctTmdbId: number; imdbId: string; title: string; year: string },
  arrTmdbIdHint: number | null,
): Promise<{ raw: RawCandidate[]; firstImdbGuid: string | null; failed: boolean }> {
  let failed = false;
  const plexSearch = async (params: Record<string, string>): Promise<RawResult[]> => {
    const res = await safeFetchAdminConfigured(
      `${serverUrl}/library/metadata/${ratingKey}/matches?` + new URLSearchParams(params),
      { headers, timeoutMs: 30_000 },
    ).catch(() => null);
    // A 200 that isn't JSON — a proxy's login page, a cut body — is no answer
    // for this search, not a 500 for the whole picker.
    const json = res?.ok ? await res.json().catch(() => null) as { MediaContainer?: { SearchResult?: unknown } } | null : null;
    if (json === null || typeof json !== "object") {
      failed = true;
      return [];
    }
    const results = json.MediaContainer?.SearchResult;
    if (!Array.isArray(results)) return [];
    return results.flatMap((r) => plexResult(r) ?? []);
  };

  const { correctTmdbId, imdbId, title, year } = target;
  const titleYear: Record<string, string> = { manual: "1", includeGuids: "1" };
  if (title) titleYear.title = title;
  if (year) titleYear.year = year;
  const [imdbGuidResults, imdbAgentResults, tmdbAgentResults, titleYearResults, arrHintResults] = await Promise.all([
    imdbId ? plexSearch({ manual: "1", includeGuids: "1", guid: `imdb://${imdbId}` }) : Promise.resolve([]),
    imdbId ? plexSearch({ manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en" }) : Promise.resolve([]),
    plexSearch({ manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" }),
    plexSearch(titleYear),
    arrTmdbIdHint && arrTmdbIdHint !== correctTmdbId
      ? plexSearch({ manual: "1", includeGuids: "1", q: String(arrTmdbIdHint), agent: "com.plexapp.agents.themoviedb", language: "en" })
      : Promise.resolve([]),
  ]);

  const candidateMap = new Map<string, RawCandidate>();
  for (const results of [imdbGuidResults, imdbAgentResults, tmdbAgentResults, titleYearResults, arrHintResults]) {
    for (const r of results) {
      if (candidateMap.has(r.guid)) continue;
      const ids = extractProviderIds(r);
      candidateMap.set(r.guid, {
        guid: r.guid, name: r.name, year: r.year, thumb: r.thumb, score: r.score,
        imdbId: ids.imdbId, tmdbId: ids.tmdbId,
      });
    }
  }
  return { raw: Array.from(candidateMap.values()), firstImdbGuid: imdbGuidResults[0]?.guid ?? null, failed };
}

/**
 * TMDB details for every candidate that names another id (bounded, guardrail
 * 31: five searches can return dozens), then each one scored against the
 * target, best first. `failed` = some details read failed.
 */
export async function enrichCandidates(
  raw: RawCandidate[],
  mediaType: "MOVIE" | "TV",
  correctTmdbId: number,
  target: TargetDetails,
  arrConfirmedTmdbId: number | null,
  arrTmdbIdHint: number | null,
  auth: TmdbAuth | null,
): Promise<{ candidates: PlexCandidate[]; failed: boolean }> {
  const ids = [...new Set(raw.map((c) => c.tmdbId).filter((id): id is string => !!id && id !== String(correctTmdbId)))];
  const detailsById = new Map<string, TmdbDetails>();
  let failed = false;
  if (auth && ids.length) {
    const fetches = await settleLimit(ids, 6, (id) => fetchTmdbDetails(Number(id), mediaType, auth));
    fetches.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.kind === "ok") detailsById.set(ids[i], r.value.value);
      else if (r.status === "rejected" || r.value.kind === "failed") failed = true;
    });
  }

  const candidates: PlexCandidate[] = raw.map((c) => {
    const details = c.tmdbId ? detailsById.get(c.tmdbId) : undefined;
    const isCorrectId = c.tmdbId === String(correctTmdbId);
    const tmdbTitle      = isCorrectId ? target.targetTitle      : (details?.title ?? details?.name ?? null);
    const tmdbOverview   = isCorrectId ? target.targetOverview   : (details?.overview ?? null);
    const tmdbRuntime    = isCorrectId ? target.targetRuntime    : (details?.runtime ?? details?.episode_run_time?.[0] ?? null);
    const tmdbGenres     = isCorrectId ? target.targetGenres     : (details?.genres?.map((g) => g.name) ?? []);
    const tmdbVoteAvg    = isCorrectId ? target.targetVoteAverage : (details?.vote_average ?? null);
    const tmdbPosterPath = isCorrectId ? target.targetPosterPath  : (details?.poster_path ?? null);
    const resolvedImdbId = c.imdbId ?? details?.external_ids?.imdb_id ?? null;
    const radarrConfirmed =
      (arrConfirmedTmdbId !== null && c.tmdbId === String(arrConfirmedTmdbId)) ||
      (arrTmdbIdHint      !== null && c.tmdbId === String(arrTmdbIdHint));
    const { matchLevel, confidence, titleSimilarity } = assessCandidate(
      { ...c, imdbId: resolvedImdbId, tmdbTitle, tmdbRuntime, tmdbGenres, radarrConfirmed },
      {
        tmdbId: correctTmdbId, imdbId: target.targetImdbId, title: target.targetTitle, year: target.targetYear,
        runtime: target.targetRuntime, genres: target.targetGenres,
      },
    );
    return {
      ...c,
      imdbId: resolvedImdbId,
      tmdbTitle, tmdbOverview, tmdbRuntime, tmdbGenres, tmdbVoteAvg, tmdbPosterPath,
      matchLevel, confidence, titleSimilarity,
      radarrConfirmed,
      suggested: false,
    };
  });
  candidates.sort(compareCandidates);
  return { candidates, failed };
}
