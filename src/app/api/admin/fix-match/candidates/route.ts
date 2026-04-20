import { NextRequest, NextResponse } from "next/server";
import nodePath from "node:path";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { tmdbAuth, type TmdbAuth } from "@/lib/tmdb-auth";

export type CandidateMatch = "exact" | "strong" | "likely" | "possible" | "wrong" | "unknown";

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
  ratingKey:           string;
  plexFilePath:        string | null;
  jellyfinFilePath:    string | null;
};

function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const na = norm(a), nb = norm(b);
  if (na === nb) return 100;
  if (!na || !nb) return 0;
  const m = na.length, n = nb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = na[i - 1] === nb[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return Math.round((1 - dp[m][n] / Math.max(m, n)) * 100);
}

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
    headers: auth.headers,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json() as Promise<TmdbDetails>;
}

function assessCandidate(
  candidate: { tmdbId: string | null; imdbId: string | null; name: string; year: number | null;
               tmdbTitle: string | null; tmdbRuntime: number | null; tmdbGenres: string[]; radarrConfirmed: boolean },
  target: { tmdbId: number; imdbId: string; title: string; year: string;
            runtime: number | null; genres: string[] },
): { matchLevel: CandidateMatch; confidence: number; titleSimilarity: number } {

  const ts = titleSimilarity(candidate.tmdbTitle ?? candidate.name, target.title);

  if (
    candidate.radarrConfirmed ||
    (candidate.tmdbId && candidate.tmdbId === String(target.tmdbId)) ||
    (candidate.imdbId && candidate.imdbId === target.imdbId && target.imdbId)
  ) {
    return { matchLevel: "exact", confidence: 100, titleSimilarity: ts };
  }

  if (
    candidate.imdbId && target.imdbId &&
    candidate.imdbId !== target.imdbId
  ) {
    return { matchLevel: "wrong", confidence: 0, titleSimilarity: ts };
  }
  if (
    candidate.tmdbId && candidate.tmdbId !== String(target.tmdbId) &&
    candidate.imdbId && target.imdbId && candidate.imdbId !== target.imdbId
  ) {
    return { matchLevel: "wrong", confidence: 0, titleSimilarity: ts };
  }

  let score = 0;

  score += Math.round(ts * 0.4);

  const cYear = candidate.year;
  const tYear = parseInt(target.year, 10);
  if (cYear && tYear) {
    if (cYear === tYear) score += 20;
    else if (Math.abs(cYear - tYear) === 1) score += 10;
    else if (Math.abs(cYear - tYear) === 2) score += 5;
  }

  if (candidate.tmdbRuntime && target.runtime) {
    const diff = Math.abs(candidate.tmdbRuntime - target.runtime);
    if (diff <= 2) score += 15;
    else if (diff <= 5) score += 12;
    else if (diff <= 10) score += 7;
    else if (diff <= 20) score += 3;
  }

  if (candidate.tmdbGenres.length && target.genres.length) {
    const intersection = candidate.tmdbGenres.filter((g) => target.genres.includes(g)).length;
    const union = new Set([...candidate.tmdbGenres, ...target.genres]).size;
    score += Math.round((intersection / union) * 15);
  }

  if (candidate.tmdbId && candidate.tmdbId !== String(target.tmdbId)) {
    score = Math.min(score, 40);
  }

  let matchLevel: CandidateMatch;
  if (score >= 75)      matchLevel = "strong";
  else if (score >= 55) matchLevel = "likely";
  else if (score >= 30) matchLevel = "possible";
  else                  matchLevel = "unknown";

  return { matchLevel, confidence: score, titleSimilarity: ts };
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const server             = searchParams.get("server");
  const mediaType          = searchParams.get("mediaType") as "MOVIE" | "TV" | null;
  const tmdbIdRaw          = parseInt(searchParams.get("tmdbId") ?? "", 10);
  const correctTmdbIdRaw   = parseInt(searchParams.get("correctTmdbId") ?? "", 10);
  const arrTmdbIdParam     = searchParams.get("arrTmdbId");
  const arrTmdbIdHintRaw   = arrTmdbIdParam ? parseInt(arrTmdbIdParam, 10) : null;

  const tmdbId        = Number.isInteger(tmdbIdRaw)        && tmdbIdRaw        > 0 ? tmdbIdRaw        : 0;
  const correctTmdbId = Number.isInteger(correctTmdbIdRaw) && correctTmdbIdRaw > 0 ? correctTmdbIdRaw : 0;
  const arrTmdbIdHint = arrTmdbIdHintRaw !== null && Number.isInteger(arrTmdbIdHintRaw) && arrTmdbIdHintRaw > 0
    ? arrTmdbIdHintRaw
    : null;

  if (!server || !tmdbId || !mediaType || !correctTmdbId) {
    return NextResponse.json({ error: "Missing required params" }, { status: 400 });
  }
  if (server !== "plex") {
    return NextResponse.json({ error: "Candidate listing only supported for Plex" }, { status: 400 });
  }

  const [item, jellyfinItem] = await Promise.all([
    prisma.plexLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { plexRatingKey: true, filePath: true },
    }),
    prisma.jellyfinLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { filePath: true },
    }),
  ]);
  if (!item?.plexRatingKey) {
    return NextResponse.json({ error: "Plex rating key not found — re-sync first" }, { status: 404 });
  }

  const [urlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);
  if (!urlRow?.value || !tokenRow?.value) {
    return NextResponse.json({ error: "Plex server not configured" }, { status: 500 });
  }

  const serverUrl = urlRow.value.replace(/\/$/, "");

  const plexHeaders = {
    Accept: "application/json",
    "X-Plex-Token": tokenRow.value,
    "X-Plex-Client-Identifier": "summonarr-server",
    "X-Plex-Product": "Summonarr",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };

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

  const cacheKey = `${mediaType === "MOVIE" ? "movie" : "tv"}:${correctTmdbId}:details`;
  const cacheRow = await prisma.tmdbCache.findUnique({ where: { key: cacheKey }, select: { data: true } });
  if (cacheRow) {
    try {
      const p = JSON.parse(cacheRow.data) as {
        title?: string; name?: string; releaseYear?: string; imdbId?: string | null;
        posterPath?: string | null; overview?: string; releaseDate?: string | null;
        voteAverage?: number;
      };
      targetTitle       = p.title ?? p.name ?? "";
      targetYear        = p.releaseYear?.slice(0, 4) ?? "";
      targetImdbId      = p.imdbId ?? "";
      targetPosterPath  = p.posterPath ?? null;
      targetOverview    = p.overview ?? "";
      targetReleaseDate = p.releaseDate ?? null;
      targetVoteAverage = p.voteAverage ?? null;
    } catch { }
  }

  if (tAuth) {
    const details = await fetchTmdbDetails(correctTmdbId, mediaType, tAuth);
    if (details) {
      if (!targetTitle)    targetTitle   = details.title ?? details.name ?? "";
      if (!targetYear)     targetYear    = (details.release_date ?? details.first_air_date ?? "").slice(0, 4);
      if (!targetOverview) targetOverview = details.overview ?? "";
      if (!targetVoteAverage && details.vote_average) targetVoteAverage = details.vote_average;
      targetRuntime = details.runtime
        ?? (details.episode_run_time?.[0] ?? null);
      targetGenres  = details.genres?.map((g) => g.name) ?? [];
      if (!targetImdbId) targetImdbId = details.external_ids?.imdb_id ?? "";
    }
  }

  if (!targetImdbId && tAuth) {
    const extUrl = new URL(`https://api.themoviedb.org/3/${mediaType === "MOVIE" ? "movie" : "tv"}/${correctTmdbId}/external_ids`);
    for (const [k, v] of Object.entries(tAuth.query)) extUrl.searchParams.set(k, v);
    const extRes = await safeFetchTrusted(extUrl.toString(), {
      headers: tAuth.headers,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (extRes?.ok) {
      const ext = await extRes.json() as { imdb_id?: string | null };
      targetImdbId = ext.imdb_id ?? "";
    }
  }

  let arrConfirmedTmdbId: number | null = null;
  const arrUrlKey  = mediaType === "MOVIE" ? "radarrUrl"    : "sonarrUrl";
  const arrKeyKey  = mediaType === "MOVIE" ? "radarrApiKey" : "sonarrApiKey";

  const [arrUrlRow, arrKeyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: arrUrlKey } }),
    prisma.setting.findUnique({ where: { key: arrKeyKey } }),
  ]);

  if (arrUrlRow?.value && arrKeyRow?.value) {
    const arrBaseUrl = arrUrlRow.value.replace(/\/$/, "");
    if (item.filePath) {
      const arrHeaders = {
        "X-Api-Key": arrKeyRow.value,
        "Content-Type": "application/json",
      };
      const folderPath = nodePath.posix.normalize(item.filePath.replace(/\/[^/]+$/, ""));
      const endpoint   = mediaType === "MOVIE" ? "movie" : "series";

      const [correctRes, wrongRes] = await Promise.allSettled([
        safeFetchTrusted(`${arrBaseUrl}/api/v3/${endpoint}?tmdbId=${correctTmdbId}`, {
          headers: arrHeaders, timeoutMs: 8_000,
        }),
        safeFetchTrusted(`${arrBaseUrl}/api/v3/${endpoint}?tmdbId=${tmdbId}`, {
          headers: arrHeaders, timeoutMs: 8_000,
        }),
      ]);

      for (const result of [correctRes, wrongRes]) {
        if (result.status === "rejected") {
          console.error("[fix-match/candidates] Arr fetch rejected:", result.reason);
        }
      }

      type ArrMovie = { tmdbId: number; path?: string; hasFile?: boolean; statistics?: { episodeFileCount?: number } };

      if (correctRes.status === "fulfilled" && correctRes.value.ok) {
        const data = await correctRes.value.json() as ArrMovie[];
        const match = data.find((m) => m.tmdbId === correctTmdbId);
        if (match) {
          const arrPath = nodePath.posix.normalize(match.path ?? "");
          if (arrPath && folderPath && (arrPath === folderPath || folderPath.startsWith(arrPath + "/"))) {
            arrConfirmedTmdbId = correctTmdbId;
          } else if (arrPath) {
            arrConfirmedTmdbId = correctTmdbId;
          }
        }
      }

      if (arrConfirmedTmdbId === null && wrongRes.status === "fulfilled" && wrongRes.value.ok) {
        const data = await wrongRes.value.json() as ArrMovie[];
        const match = data.find((m) => m.tmdbId === tmdbId);
        if (match?.path && folderPath && (nodePath.posix.normalize(match.path) === folderPath || folderPath.startsWith(nodePath.posix.normalize(match.path) + "/"))) {
          arrConfirmedTmdbId = null;
        }
      }

    }
  }

  let arrConfirmedTitle: string | null = null;
  if (arrConfirmedTmdbId !== null && arrConfirmedTmdbId !== correctTmdbId) {
    const arrCacheKey = `${mediaType === "MOVIE" ? "movie" : "tv"}:${arrConfirmedTmdbId}:details`;
    const arrCacheRow = await prisma.tmdbCache.findUnique({ where: { key: arrCacheKey }, select: { data: true } });
    if (arrCacheRow) {
      try {
        const p = JSON.parse(arrCacheRow.data) as { title?: string; name?: string };
        arrConfirmedTitle = p.title ?? p.name ?? null;
      } catch { }
    }
  } else if (arrConfirmedTmdbId === correctTmdbId) {
    arrConfirmedTitle = targetTitle || null;
  }

  type RawResult = {
    guid: string; name?: string; year?: number; thumb?: string | null; score?: number | null;
    Guid?: Array<{ id: string }>;
  };
  const candidateMap = new Map<string, Omit<PlexCandidate, "matchLevel" | "confidence" | "titleSimilarity" | "tmdbTitle" | "tmdbOverview" | "tmdbRuntime" | "tmdbGenres" | "tmdbVoteAvg" | "tmdbPosterPath" | "radarrConfirmed" | "suggested">>();
  let suggestedGuid: string | null = null;

  const extractProviderIds = (r: RawResult): { imdbId: string | null; tmdbId: string | null } => {
    if (r.Guid?.length) {
      return {
        imdbId: r.Guid.find((g) => g.id.startsWith("imdb://"))?.id.replace("imdb://", "") ?? null,
        tmdbId: r.Guid.find((g) => g.id.startsWith("tmdb://"))?.id.replace("tmdb://", "") ?? null,
      };
    }
    const imdbMatch = /com\.plexapp\.agents\.imdb:\/\/(tt\d+)/i.exec(r.guid);
    const tmdbMatch = /com\.plexapp\.agents\.themoviedb:\/\/(\d+)/i.exec(r.guid);
    return {
      imdbId: imdbMatch?.[1] ?? null,
      tmdbId: tmdbMatch?.[1] ?? null,
    };
  };

  const plexSearch = async (params: Record<string, string>): Promise<RawResult[]> => {
    const res = await safeFetchTrusted(
      `${serverUrl}/library/metadata/${item.plexRatingKey}/matches?` + new URLSearchParams(params),
      { headers: plexHeaders, timeoutMs: 30_000 },
    ).catch(() => null);
    if (!res?.ok) return [];
    const json = await res.json() as { MediaContainer?: { SearchResult?: RawResult[] } };
    return json?.MediaContainer?.SearchResult ?? [];
  };

  const addResults = (results: RawResult[], markFirstAsSuggested = false) => {
    for (const r of results) {
      if (!candidateMap.has(r.guid)) {
        const { imdbId, tmdbId: cTmdbId } = extractProviderIds(r);
        candidateMap.set(r.guid, {
          guid: r.guid, name: r.name ?? "", year: r.year ?? null,
          thumb: r.thumb ?? null, score: r.score ?? null,
          imdbId, tmdbId: cTmdbId,
        });
      }
    }
    if (markFirstAsSuggested && results.length > 0 && !suggestedGuid) {
      suggestedGuid = results[0].guid;
    }
  };

  const [imdbGuidResults, imdbAgentResults, tmdbAgentResults, titleYearResults, arrHintResults] = await Promise.all([
    targetImdbId ? plexSearch({ manual: "1", includeGuids: "1", guid: `imdb://${targetImdbId}` }) : Promise.resolve([]),
    targetImdbId ? plexSearch({ manual: "1", includeGuids: "1", q: targetImdbId, agent: "com.plexapp.agents.imdb", language: "en" }) : Promise.resolve([]),
    plexSearch({ manual: "1", includeGuids: "1", q: String(correctTmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" }),
    (() => {
      const p: Record<string, string> = { manual: "1", includeGuids: "1" };
      if (targetTitle) p.title = targetTitle;
      if (targetYear)  p.year  = targetYear;
      return plexSearch(p);
    })(),
    arrTmdbIdHint && arrTmdbIdHint !== correctTmdbId
      ? plexSearch({ manual: "1", includeGuids: "1", q: String(arrTmdbIdHint), agent: "com.plexapp.agents.themoviedb", language: "en" })
      : Promise.resolve([]),
  ]);

  addResults(imdbGuidResults, true);
  addResults(imdbAgentResults);
  addResults(tmdbAgentResults);
  addResults(titleYearResults);
  addResults(arrHintResults);

  const rawCandidates = Array.from(candidateMap.values());

  const tmdbIdsToFetch = [...new Set(
    rawCandidates.map((c) => c.tmdbId).filter((id): id is string => !!id && id !== String(correctTmdbId)),
  )];

  const tmdbDetailMap = new Map<string, TmdbDetails>();
  if (tAuth && tmdbIdsToFetch.length) {
    const fetches = await Promise.allSettled(
      tmdbIdsToFetch.map(async (id) => {
        const d = await fetchTmdbDetails(Number(id), mediaType, tAuth);
        return { id, d };
      }),
    );
    for (const r of fetches) {
      if (r.status === "fulfilled" && r.value.d) {
        tmdbDetailMap.set(r.value.id, r.value.d);
      }
    }
  }

  const candidates: PlexCandidate[] = rawCandidates.map((c) => {
    const details = c.tmdbId ? tmdbDetailMap.get(c.tmdbId) : undefined;
    const isCorrectId = c.tmdbId === String(correctTmdbId);

    const tmdbTitle      = isCorrectId ? targetTitle      : (details?.title ?? details?.name ?? null);
    const tmdbOverview   = isCorrectId ? targetOverview   : (details?.overview ?? null);
    const tmdbRuntime    = isCorrectId
      ? targetRuntime
      : (details?.runtime ?? details?.episode_run_time?.[0] ?? null);
    const tmdbGenres     = isCorrectId ? targetGenres     : (details?.genres?.map((g) => g.name) ?? []);
    const tmdbVoteAvg    = isCorrectId ? targetVoteAverage : (details?.vote_average ?? null);
    const tmdbPosterPath = isCorrectId ? targetPosterPath  : (details?.poster_path ?? null);

    const resolvedImdbId = c.imdbId
      ?? details?.external_ids?.imdb_id
      ?? null;

    const radarrConfirmed =
      (arrConfirmedTmdbId !== null && c.tmdbId === String(arrConfirmedTmdbId)) ||
      (arrTmdbIdHint      !== null && c.tmdbId === String(arrTmdbIdHint));

    const { matchLevel, confidence, titleSimilarity: ts } = assessCandidate(
      { ...c, imdbId: resolvedImdbId, tmdbTitle, tmdbRuntime, tmdbGenres, radarrConfirmed },
      { tmdbId: correctTmdbId, imdbId: targetImdbId, title: targetTitle, year: targetYear, runtime: targetRuntime, genres: targetGenres },
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

  const levelOrder: Record<CandidateMatch, number> = { exact: 0, strong: 1, likely: 2, possible: 3, unknown: 4, wrong: 5 };
  candidates.sort((a, b) => {
    const lo = levelOrder[a.matchLevel] - levelOrder[b.matchLevel];
    return lo !== 0 ? lo : (b.confidence - a.confidence);
  });

  const initialSuggested = suggestedGuid ? candidates.find((c) => c.guid === suggestedGuid) : null;
  const topNonWrong = candidates.find((c) => c.matchLevel !== "wrong");
  const finalSuggestedGuid =
    topNonWrong && initialSuggested && levelOrder[topNonWrong.matchLevel] < levelOrder[initialSuggested.matchLevel]
      ? topNonWrong.guid
      : (suggestedGuid ?? topNonWrong?.guid ?? null);

  for (const c of candidates) {
    c.suggested = c.guid === finalSuggestedGuid;
  }

  return NextResponse.json({
    candidates,
    targetTitle,
    targetYear,
    targetImdbId,
    targetPosterPath,
    targetOverview,
    targetReleaseDate,
    targetVoteAverage,
    targetRuntime,
    targetGenres,
    arrConfirmedTmdbId,
    arrConfirmedTitle,
    ratingKey: item.plexRatingKey,
    plexFilePath: item.filePath ?? null,
    jellyfinFilePath: jellyfinItem?.filePath ?? null,
  } satisfies CandidatesResponse);
}
