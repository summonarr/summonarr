import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { prisma } from "@/lib/prisma";
import { getPlexConfig } from "@/lib/plex-config";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";
import { arrFetch } from "@/lib/arr";
import { configuredArrCfg, enabledArrInstances } from "@/lib/arr-admin";
import { candidateCacheKey, getCachedCandidates, setCachedCandidates } from "@/lib/fix-match-candidate-cache";
import { assessCandidate, compareCandidates, pickSuggestedGuid, type CandidateMatch } from "@/lib/fix-match-scoring";
import { cachedArrList, cachedTmdbTitle, normaliseLibraryPath, pathWithin, plexAdminHeaders, rowWithPathFor, tmdbDetailsCacheKey } from "@/lib/fix-match-shared";
import { libraryPathFor } from "@/lib/library-path-view";
import { getCache } from "@/lib/tmdb-cache";
import { tmdbAuth, type TmdbAuth } from "@/lib/tmdb-auth";
import { settleLimit } from "@/lib/concurrency";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

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
  // this side. See the lookup below.
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

type TmdbDetails = {
  id: number;
  title?: string; name?: string;
  overview?: string;
  poster_path?: string | null;
  runtime?: number | null;
  episode_run_time?: number[];
  genres?: { id: number; name: string }[];
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  external_ids?: { imdb_id?: string | null };
};

async function fetchTmdbDetails(
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
  auth: TmdbAuth,
): Promise<TmdbDetails | null> {
  const type = mediaType === "MOVIE" ? "movie" : "tv";
  const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId}`);
  url.searchParams.set("append_to_response", "external_ids");
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  const res = await safeFetchTrusted(url.toString(), {
    allowedHosts: TMDB_HOSTS,
    headers: auth.headers,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!res?.ok) return null;
  // A 200 that isn't JSON (a proxy page, a cut body) is no answer, not a 500.
  const body = await res.json().catch(() => null) as unknown;
  return body !== null && typeof body === "object" ? body as TmdbDetails : null;
}

type TargetDetails = {
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

// TMDB details for the CORRECT id — the entry the Plex picker or the Jellyfin
// confirmation card is about to bind. Cached details row first, live TMDB fills
// the gaps when a token is configured; everything degrades to empty so the UI
// can still render a bare "TMDB #<id>".
async function resolveTargetDetails(correctTmdbId: number, mediaType: "MOVIE" | "TV"): Promise<TargetDetails> {
  const tAuth = tmdbAuth();

  let targetTitle        = "";
  let targetYear         = "";
  let targetImdbId       = "";
  let targetPosterPath:  string | null = null;
  let targetOverview     = "";
  let targetReleaseDate: string | null = null;
  let targetVoteAverage: number | null = null;
  let targetRuntime:     number | null = null;
  let targetGenres:      string[]      = [];

  // getCache, not a raw read: an expired row is a miss, so a stale title, year
  // or IMDb id (which drives "exact" and "wrong") never outranks live TMDB.
  const p = await getCache<Record<string, unknown>>(tmdbDetailsCacheKey(mediaType, correctTmdbId));
  if (p !== null && typeof p === "object") {
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    targetTitle       = str(p.title) ?? str(p.name) ?? "";
    targetYear        = str(p.releaseYear)?.slice(0, 4) ?? "";
    targetImdbId      = str(p.imdbId) ?? "";
    targetPosterPath  = str(p.posterPath) ?? null;
    targetOverview    = str(p.overview) ?? "";
    targetReleaseDate = str(p.releaseDate) ?? null;
    targetVoteAverage = typeof p.voteAverage === "number" ? p.voteAverage : null;
  }

  // The details request already carries external_ids (append_to_response), so
  // a null imdb_id there is TMDB's answer: the separate read below is only for
  // when that request got no answer at all.
  let detailsFetched = false;
  if (tAuth) {
    const details = await fetchTmdbDetails(correctTmdbId, mediaType, tAuth);
    if (details) {
      detailsFetched = true;
      if (!targetTitle)    targetTitle   = details.title ?? details.name ?? "";
      if (!targetYear)     targetYear    = (details.release_date ?? details.first_air_date ?? "").slice(0, 4);
      if (!targetOverview) targetOverview = details.overview ?? "";
      if (!targetVoteAverage && details.vote_average) targetVoteAverage = details.vote_average;
      if (!targetPosterPath) targetPosterPath = details.poster_path ?? null;
      targetRuntime = details.runtime
        ?? (details.episode_run_time?.[0] ?? null);
      targetGenres  = details.genres?.map((g) => g.name) ?? [];
      if (!targetImdbId) targetImdbId = details.external_ids?.imdb_id ?? "";
    }
  }

  if (!targetImdbId && tAuth && !detailsFetched) {
    const extUrl = new URL(`https://api.themoviedb.org/3/${mediaType === "MOVIE" ? "movie" : "tv"}/${correctTmdbId}/external_ids`);
    for (const [k, v] of Object.entries(tAuth.query)) extUrl.searchParams.set(k, v);
    const extRes = await safeFetchTrusted(extUrl.toString(), {
      allowedHosts: TMDB_HOSTS,
      headers: tAuth.headers,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (extRes?.ok) {
      const ext = await extRes.json().catch(() => null) as { imdb_id?: unknown } | null;
      targetImdbId = typeof ext?.imdb_id === "string" ? ext.imdb_id : "";
    }
  }

  return {
    targetTitle, targetYear, targetImdbId, targetPosterPath, targetOverview,
    targetReleaseDate, targetVoteAverage, targetRuntime, targetGenres,
  };
}

// An arr answer's rows, appended one by one: a spread push throws RangeError
// past ~125k rows (a Radarr that ignored ?tmdbId= sends its whole table), and a
// non-array answer or a non-object row adds nothing instead of a TypeError
// (guardrail 5i). The cross-check is a hint; a broken answer must not 500.
function appendRows<T extends object>(out: T[], rows: unknown): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows as unknown[]) {
    if (row !== null && typeof row === "object") out.push(row as T);
  }
}

// An arr entry with no folder can't vouch for a file: test the raw string, not
// its normalised form.
const hasArrPath = (path: unknown): path is string => typeof path === "string" && path.trim() !== "";

// Live Radarr/Sonarr cross-check for the folder being re-matched — an additive
// trust signal for both the Plex picker and the Jellyfin confirmation card.
// Null everywhere when no arr is configured or nothing matched.
async function resolveArrConfirmation(
  mediaType: "MOVIE" | "TV",
  tmdbId: number,
  correctTmdbId: number,
  filePath: string | null,
  targetTitle: string,
): Promise<{ arrConfirmedTmdbId: number | null; arrConfirmedTitle: string | null; arrPathAgrees: boolean | null }> {
  let arrConfirmedTmdbId: number | null = null;
  // Whether the arr entry's folder path agrees with the library item's — an
  // additive diagnostic; null when no arr confirmation was possible at all.
  let arrPathAgrees: boolean | null = null;
  type ArrMovie = { tmdbId?: number; path?: string; hasFile?: boolean; statistics?: { episodeFileCount?: number } };
  const correctRows: ArrMovie[] = [];
  const wrongRows: ArrMovie[] = [];

  // EVERY enabled instance of the service, not just the default one (guardrail
  // 32): a title that lives only in a 4K or anime instance used to get no
  // confirmation at all. The arr cross-check is an additive trust signal, so a
  // registry/settings failure degrades to "no confirmation", never a 500.
  let instances: Awaited<ReturnType<typeof enabledArrInstances>> = [];
  if (filePath) {
    try {
      instances = await enabledArrInstances(mediaType === "MOVIE" ? "radarr" : "sonarr");
    } catch (err) {
      console.error("[fix-match/candidates] arr instance lookup failed:", err instanceof Error ? err.message : err);
    }
  }

  if (filePath && instances.length > 0) {
    // The library path ITSELF, not its parent: a Jellyfin series row's Path is
    // the series folder (Plex's is an episode file), so its parent is the
    // library root, which equals no Sonarr series path. A path at or under the
    // arr folder covers a movie file, an episode file and a series folder alike
    // (pathWithin).
    const libraryPath = normaliseLibraryPath(filePath);
    const endpoint = mediaType === "MOVIE" ? "movie" : "series";

    for (const inst of instances) {
      let cfg;
      try {
        cfg = await configuredArrCfg(inst.service, inst.slug);
      } catch {
        continue;
      }
      // Route Arr library lookups through arrFetch so they inherit the 30s
      // timeout, 50 MB cap (guardrail 5), X-Api-Key injection, and
      // ArrResponseError handling.
      //
      // Radarr's movie list honors ?tmdbId= server-side. Sonarr's series list
      // does NOT (its only filter is ?tvdbId=), and on Sonarr v3 SeriesResource
      // carries no TmdbId at all — TV reads the whole table once per instance,
      // shared by both probes and kept briefly (cachedArrList) so a bulk run of
      // pickers does not download it again for every title.
      if (mediaType === "MOVIE") {
        const [correctRes, wrongRes] = await Promise.allSettled([
          arrFetch<ArrMovie[]>(cfg, `/api/v3/${endpoint}?tmdbId=${correctTmdbId}`),
          arrFetch<ArrMovie[]>(cfg, `/api/v3/${endpoint}?tmdbId=${tmdbId}`),
        ]);
        for (const result of [correctRes, wrongRes]) {
          if (result.status === "rejected") {
            console.error("[fix-match/candidates] Arr fetch rejected:", result.reason instanceof Error ? result.reason.message : result.reason);
          }
        }
        if (correctRes.status === "fulfilled") appendRows(correctRows, correctRes.value);
        if (wrongRes.status === "fulfilled") appendRows(wrongRows, wrongRes.value);
      } else {
        try {
          const all = await cachedArrList("sonarr", inst.slug, () => arrFetch<unknown>(cfg, `/api/v3/${endpoint}`));
          appendRows(correctRows, all);
          appendRows(wrongRows, all);
        } catch (err) {
          console.error("[fix-match/candidates] Arr fetch rejected:", err instanceof Error ? err.message : err);
        }
      }
    }

    const correctMatch = correctRows.find((m) => m.tmdbId === correctTmdbId && hasArrPath(m.path));
    if (correctMatch) {
      // Library membership confirmed. Path agreement is reported separately —
      // gating the confirmation on it would lose the feature entirely on
      // split-mount deployments (the arr and media-server paths legitimately
      // differ there).
      arrConfirmedTmdbId = correctTmdbId;
      arrPathAgrees = pathWithin(correctMatch.path, libraryPath);
    }
    if (arrConfirmedTmdbId === null) {
      const wrongMatch = wrongRows.find((m) => m.tmdbId === tmdbId && pathWithin(m.path, libraryPath));
      if (wrongMatch) {
        // The arr library maps THIS folder to the current (wrong) id — surface
        // the disagreement (the "⚠ Radarr/Sonarr has TMDB #X" UI warning).
        arrConfirmedTmdbId = tmdbId;
        arrPathAgrees = true;
      }
    }
  }

  let arrConfirmedTitle: string | null = null;
  if (arrConfirmedTmdbId !== null && arrConfirmedTmdbId !== correctTmdbId) {
    arrConfirmedTitle = await cachedTmdbTitle(mediaType, arrConfirmedTmdbId);
  } else if (arrConfirmedTmdbId === correctTmdbId) {
    arrConfirmedTitle = targetTitle || null;
  }

  return { arrConfirmedTmdbId, arrConfirmedTitle, arrPathAgrees };
}

type RawResult = {
  guid: string; name?: string; year?: number; thumb?: string | null; score?: number | null;
  Guid?: unknown;
};
type RawCandidate = Omit<PlexCandidate, "matchLevel" | "confidence" | "titleSimilarity" | "tmdbTitle" | "tmdbOverview" | "tmdbRuntime" | "tmdbGenres" | "tmdbVoteAvg" | "tmdbPosterPath" | "radarrConfirmed" | "suggested">;

const isRawResult = (r: unknown): r is RawResult =>
  r !== null && typeof r === "object" && typeof (r as { guid?: unknown }).guid === "string";

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
  return {
    imdbId: imdbMatch?.[1] ?? null,
    tmdbId: tmdbMatch?.[1] ?? null,
  };
}

// Plex's /matches for the item, five ways (IMDb guid, IMDb agent, TMDB agent,
// title + year, the arr's id hint), deduped by guid in that order.
// `firstImdbGuid` is the IMDb-guid search's first hit — the initial suggestion.
async function searchPlexCandidates(
  serverUrl: string,
  ratingKey: string,
  headers: Record<string, string>,
  target: { correctTmdbId: number; imdbId: string; title: string; year: string },
  arrTmdbIdHint: number | null,
): Promise<{ raw: RawCandidate[]; firstImdbGuid: string | null }> {
  const plexSearch = async (params: Record<string, string>): Promise<RawResult[]> => {
    const res = await safeFetchAdminConfigured(
      `${serverUrl}/library/metadata/${ratingKey}/matches?` + new URLSearchParams(params),
      { headers, timeoutMs: 30_000 },
    ).catch(() => null);
    if (!res?.ok) return [];
    // A 200 that isn't JSON — a proxy's login page, a cut body — means this
    // search found nothing, not a 500 for the whole picker.
    const json = await res.json().catch(() => null) as { MediaContainer?: { SearchResult?: unknown } } | null;
    const results = json?.MediaContainer?.SearchResult;
    return Array.isArray(results) ? results.filter(isRawResult) : [];
  };

  const { correctTmdbId, imdbId, title, year } = target;
  const [imdbGuidResults, imdbAgentResults, tmdbAgentResults, titleYearResults, arrHintResults] = await Promise.all([
    imdbId ? plexSearch({ manual: "1", includeGuids: "1", guid: `imdb://${imdbId}` }) : Promise.resolve([]),
    imdbId ? plexSearch({ manual: "1", includeGuids: "1", q: imdbId, agent: "com.plexapp.agents.imdb", language: "en" }) : Promise.resolve([]),
    plexSearch({ manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" }),
    (() => {
      const p: Record<string, string> = { manual: "1", includeGuids: "1" };
      if (title) p.title = title;
      if (year)  p.year  = year;
      return plexSearch(p);
    })(),
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
        guid: r.guid, name: r.name ?? "", year: r.year ?? null,
        thumb: r.thumb ?? null, score: r.score ?? null,
        imdbId: ids.imdbId, tmdbId: ids.tmdbId,
      });
    }
  }
  return { raw: Array.from(candidateMap.values()), firstImdbGuid: imdbGuidResults[0]?.guid ?? null };
}

// TMDB details for every candidate that names another id (bounded, guardrail
// 31: five searches can return dozens), then the score of each against the
// target, best first.
async function enrichCandidates(
  raw: RawCandidate[],
  mediaType: "MOVIE" | "TV",
  correctTmdbId: number,
  target: TargetDetails,
  arrConfirmedTmdbId: number | null,
  arrTmdbIdHint: number | null,
  tAuth: TmdbAuth | null,
): Promise<PlexCandidate[]> {
  const tmdbIdsToFetch = [...new Set(
    raw.map((c) => c.tmdbId).filter((id): id is string => !!id && id !== String(correctTmdbId)),
  )];

  const tmdbDetailMap = new Map<string, TmdbDetails>();
  if (tAuth && tmdbIdsToFetch.length) {
    const fetches = await settleLimit(tmdbIdsToFetch, 6, async (id) => {
      const d = await fetchTmdbDetails(Number(id), mediaType, tAuth);
      return { id, d };
    });
    for (const r of fetches) {
      if (r.status === "fulfilled" && r.value.d) {
        tmdbDetailMap.set(r.value.id, r.value.d);
      }
    }
  }

  const candidates: PlexCandidate[] = raw.map((c) => {
    const details = c.tmdbId ? tmdbDetailMap.get(c.tmdbId) : undefined;
    const isCorrectId = c.tmdbId === String(correctTmdbId);

    const tmdbTitle      = isCorrectId ? target.targetTitle      : (details?.title ?? details?.name ?? null);
    const tmdbOverview   = isCorrectId ? target.targetOverview   : (details?.overview ?? null);
    const tmdbRuntime    = isCorrectId
      ? target.targetRuntime
      : (details?.runtime ?? details?.episode_run_time?.[0] ?? null);
    const tmdbGenres     = isCorrectId ? target.targetGenres     : (details?.genres?.map((g) => g.name) ?? []);
    const tmdbVoteAvg    = isCorrectId ? target.targetVoteAverage : (details?.vote_average ?? null);
    const tmdbPosterPath = isCorrectId ? target.targetPosterPath  : (details?.poster_path ?? null);

    const resolvedImdbId = c.imdbId
      ?? details?.external_ids?.imdb_id
      ?? null;

    const radarrConfirmed =
      (arrConfirmedTmdbId !== null && c.tmdbId === String(arrConfirmedTmdbId)) ||
      (arrTmdbIdHint      !== null && c.tmdbId === String(arrTmdbIdHint));

    const { matchLevel, confidence, titleSimilarity: ts } = assessCandidate(
      { ...c, imdbId: resolvedImdbId, tmdbTitle, tmdbRuntime, tmdbGenres, radarrConfirmed },
      {
        tmdbId: correctTmdbId, imdbId: target.targetImdbId, title: target.targetTitle, year: target.targetYear,
        runtime: target.targetRuntime, genres: target.targetGenres,
      },
    );

    return {
      ...c,
      imdbId: resolvedImdbId,
      tmdbTitle,
      tmdbOverview,
      tmdbRuntime,
      tmdbGenres,
      tmdbVoteAvg,
      tmdbPosterPath,
      matchLevel,
      confidence,
      titleSimilarity: ts,
      radarrConfirmed,
      suggested: false,
    };
  });

  candidates.sort(compareCandidates);
  return candidates;
}

export const GET = withIssueAdmin(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  // Every TV call pulls the whole Sonarr series table (up to the 50 MB
  // ARR_FETCH_MAX_BYTES), fires five 30s Plex agent searches and up to N TMDB
  // detail reads — a stuck picker (re-render loop) or a script from any
  // MANAGE_ISSUES holder had no bound at all, where the sibling POST caps at
  // 10/min. 30/min is generous for a human paging through candidates.
  if (!checkRateLimit(`fix-match-candidates:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.tooMany") }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const server             = searchParams.get("server");
  const mediaTypeRaw       = searchParams.get("mediaType");
  // Validated, not just cast: an arbitrary value reaching the Prisma enum
  // filter below throws PrismaClientValidationError → an unhandled 500 where
  // the sibling POST answers 400.
  const mediaType: "MOVIE" | "TV" | null =
    mediaTypeRaw === "MOVIE" || mediaTypeRaw === "TV" ? mediaTypeRaw : null;
  const tmdbIdRaw          = parseInt(searchParams.get("tmdbId") ?? "", 10);
  const correctTmdbIdRaw   = parseInt(searchParams.get("correctTmdbId") ?? "", 10);
  const arrTmdbIdParam     = searchParams.get("arrTmdbId");
  const arrTmdbIdHintRaw   = arrTmdbIdParam ? parseInt(arrTmdbIdParam, 10) : null;

  const tmdbId        = isTmdbIdInRange(tmdbIdRaw)        ? tmdbIdRaw        : 0;
  const correctTmdbId = isTmdbIdInRange(correctTmdbIdRaw) ? correctTmdbIdRaw : 0;
  const arrTmdbIdHint = arrTmdbIdHintRaw !== null && isTmdbIdInRange(arrTmdbIdHintRaw)
    ? arrTmdbIdHintRaw
    : null;

  if (!server || !tmdbId || !mediaType || !correctTmdbId) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.missingParams") }, { status: 400 });
  }
  if (server !== "plex" && server !== "jellyfin") {
    return NextResponse.json({ error: t("apiAdmin.common.serverPlexOrJellyfin") }, { status: 400 });
  }

  // Which configured server's library row (and therefore whose ratingKey and
  // whose /matches endpoint) this listing is for. Absent ⇒ the default server,
  // so every pre-multi-server caller keeps its exact behaviour.
  const serverInstanceParam = searchParams.get("serverInstance");
  if (serverInstanceParam !== null && !isValidMediaInstanceSlug(serverInstanceParam)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidServerInstance", { slug: String(serverInstanceParam) }) }, { status: 400 });
  }
  const serverInstance = serverInstanceParam ?? DEFAULT_MEDIA_INSTANCE;

  // Jellyfin mode: there is no candidate list to pick from — the fix-match POST
  // applies the exact TMDB id deterministically (it refuses any search result
  // carrying a different id; see that route). This branch instead feeds the
  // pre-apply CONFIRMATION card: the target's TMDB details, the file about to be
  // re-identified, and the same live arr cross-check the Plex picker shows. Same
  // response shape with the Plex-only fields neutral, so every existing
  // CandidatesResponse consumer is unchanged.
  if (server === "jellyfin") {
    const [jfItem, plexRows] = await Promise.all([
      prisma.jellyfinLibraryItem.findFirst({
        where: { tmdbId, mediaType, serverInstance },
        select: { jellyfinItemId: true, filePath: true, title: true, year: true },
      }),
      // Cross-server display hint — deliberately unscoped, mirroring (and for
      // the same reason as) the Jellyfin read in the Plex mode below.
      prisma.plexLibraryItem.findMany({
        where: { tmdbId, mediaType },
        select: { serverInstance: true, filePath: true },
        orderBy: { serverInstance: "asc" },
      }),
    ]);
    if (!jfItem?.jellyfinItemId) {
      return NextResponse.json({ error: t("apiAdmin.fixMatch.jellyfinItemNotFound") }, { status: 404 });
    }
    const plexHint = rowWithPathFor(plexRows, serverInstance);
    const target = await resolveTargetDetails(correctTmdbId, mediaType);
    const arr = await resolveArrConfirmation(mediaType, tmdbId, correctTmdbId, jfItem.filePath ?? null, target.targetTitle);
    return NextResponse.json({
      candidates: [],
      ...target,
      ...arr,
      ratingKey: "",
      // The caller's view of the paths (library-path-view.ts), like the Plex
      // mode's answer below.
      plexFilePath: libraryPathFor(session.user.permissions, plexHint?.filePath),
      jellyfinFilePath: libraryPathFor(session.user.permissions, jfItem.filePath),
      serverInstance,
      currentTitle: jfItem.title ?? null,
      currentYear: jfItem.year ?? null,
    } satisfies CandidatesResponse);
  }

  const [item, jellyfinRows] = await Promise.all([
    prisma.plexLibraryItem.findFirst({
      where: { tmdbId, mediaType, serverInstance },
      select: { plexRatingKey: true, filePath: true, title: true, year: true },
    }),
    // Deliberately NOT scoped by `serverInstance`: that slug names the PLEX
    // server this listing is for, and the two sides of a bad match are
    // independent instances — bad-matches.ts pairs library rows by relative
    // path across every configured server and gives each side its own
    // `serverInstance`. Scoping the Jellyfin read with the Plex slug therefore
    // blanked (or mis-sourced) the hint on exactly the cross-instance mismatch
    // an admin opens this picker to resolve. Widening is safe because
    // `jellyfinFilePath` is display-only — nothing is written from it, and this
    // part of the route only runs for server=plex (Jellyfin returned above).
    prisma.jellyfinLibraryItem.findMany({
      where: { tmdbId, mediaType },
      select: { serverInstance: true, filePath: true },
      orderBy: { serverInstance: "asc" },
    }),
  ]);
  // Requested instance first, so every answer this route already gives is
  // unchanged — a single-server deployment (every row on "") is byte-identical
  // (guardrail 35), and a multi-server one only gains a path where it used to
  // report none.
  const jellyfinItem = rowWithPathFor(jellyfinRows, serverInstance);
  if (!item?.plexRatingKey) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.plexRatingKeyNotFound") }, { status: 404 });
  }
  const cacheKey = candidateCacheKey({ serverInstance, ratingKey: item.plexRatingKey, correctTmdbId, arrHint: arrTmdbIdHint });
  // The cache holds the full body (it is keyed by the title, not the caller);
  // every answer, cached or fresh, leaves through the caller's view of the
  // two paths (library-path-view.ts: ADMIN sees the path, a MANAGE_ISSUES
  // delegate the file name).
  const perms = session.user.permissions;
  const viewOf = (body: CandidatesResponse): CandidatesResponse => ({
    ...body,
    plexFilePath: libraryPathFor(perms, body.plexFilePath),
    jellyfinFilePath: libraryPathFor(perms, body.jellyfinFilePath),
  });
  const cached = getCachedCandidates<CandidatesResponse>(cacheKey);
  if (cached) return NextResponse.json(viewOf(cached));
  // Coerce to break taint from the DB-read string before interpolating into the
  // Plex admin-token URL below (rating keys are always integers).
  const safeRatingKey = String(parseInt(item.plexRatingKey, 10) || 0);

  const plexConfig = await getPlexConfig(serverInstance);
  if (!plexConfig.url || !plexConfig.token) {
    return NextResponse.json({ error: t("apiAdmin.common.plexNotConfigured") }, { status: 500 });
  }
  const serverUrl = plexConfig.url.replace(/\/$/, "");

  const target = await resolveTargetDetails(correctTmdbId, mediaType);
  const arr = await resolveArrConfirmation(mediaType, tmdbId, correctTmdbId, item.filePath ?? null, target.targetTitle);
  const { raw, firstImdbGuid } = await searchPlexCandidates(
    serverUrl, safeRatingKey, plexAdminHeaders(plexConfig.token),
    { correctTmdbId, imdbId: target.targetImdbId, title: target.targetTitle, year: target.targetYear },
    arrTmdbIdHint,
  );
  const candidates = await enrichCandidates(raw, mediaType, correctTmdbId, target, arr.arrConfirmedTmdbId, arrTmdbIdHint, tmdbAuth());
  const suggestedGuid = pickSuggestedGuid(candidates, firstImdbGuid);
  for (const c of candidates) {
    c.suggested = c.guid === suggestedGuid;
  }

  const responseBody = {
    candidates,
    ...target,
    ...arr,
    ratingKey: item.plexRatingKey,
    plexFilePath: item.filePath ?? null,
    jellyfinFilePath: jellyfinItem?.filePath ?? null,
    serverInstance,
    currentTitle: item.title ?? null,
    currentYear: item.year ?? null,
  } satisfies CandidatesResponse;
  setCachedCandidates(cacheKey, responseBody);
  return NextResponse.json(viewOf(responseBody));
});
