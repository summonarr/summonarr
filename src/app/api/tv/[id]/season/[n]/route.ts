import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getTVSeasonEpisodesLocalized, tmdbLanguageFor } from "@/lib/tmdb";
import type { TmdbEpisode } from "@/lib/tmdb-types";
import { checkRateLimit } from "@/lib/rate-limit";
import { episodeMetadataUpdates, warmEpisodeMetadata } from "@/lib/tv-season-warm";
import {
  getVisibleServerInstances,
  providerEpisodeSources,
  summarizeEpisodeSources,
  visibleEpisodeSourcesFor,
} from "@/lib/media-visibility";
import { localeForRequest, translatorForRequest } from "@/lib/i18n/server-locale";
import { isTmdbIdInRange, parseTmdbIdParam } from "@/lib/tmdb-id";

export interface TVSeasonResponse {
  episodes: TmdbEpisode[];
  owned: number[];
  source: "plex" | "jellyfin" | "both" | null;
}

export const GET = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string; n: string }> },
  session
) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`tv-season:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const { id: rawId, n: rawN } = await params;
  const tmdbId = parseTmdbIdParam(rawId);
  // Canonical digits only, like the id: parseInt read "1abc" and "1.5" as
  // season 1, so one season answered under URLs that weren't its own. 0 is the
  // specials.
  const seasonNumber = /^(?:0|[1-9]\d{0,3})$/.test(rawN) ? Number(rawN) : NaN;
  if (tmdbId === null) {
    return NextResponse.json({ error: t("apiUser.common.idPositive") }, { status: 400 });
  }
  // INT4 ceiling shared with tv-availability and media/[type]/[tmdbId]: the
  // TVEpisodeCache read below is keyed on tmdbId and throws past it.
  if (!isTmdbIdInRange(tmdbId)) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdOutOfRange") }, { status: 400 });
  }
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
    return NextResponse.json({ error: t("apiUser.tv.seasonInvalid") }, { status: 400 });
  }

  // `episodes` is what the viewer sees; `english` is the only list that may be
  // written anywhere (guardrail 40a — see the metadata warm below).
  let episodes: TmdbEpisode[];
  let english: TmdbEpisode[];
  try {
    ({ episodes, english } = await getTVSeasonEpisodesLocalized(tmdbId, seasonNumber, tmdbLanguageFor(localeForRequest(req))));
  } catch (err) {
    // tmdbFetch throws without logging, so without this a run of TMDB failures
    // here left no trace at all.
    console.warn("[tv-season] TMDB season fetch failed:", tmdbId, seasonNumber, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: t("apiUser.tv.seasonFetchFailed") }, { status: 502 });
  }

  const providerSources = providerEpisodeSources(session.user.provider);

  // TVEpisodeCache has no serverInstance column, so `source` alone would report
  // a RESTRICTED server's per-episode holdings to an ungranted caller — as raw
  // JSON on this route. Gate on whether the viewer can see any server of that
  // type actually holding the title. See media-visibility.ts.
  const visible = await getVisibleServerInstances(session);
  const sources = await visibleEpisodeSourcesFor(tmdbId, visible, providerSources);

  const ownedRows = sources.length === 0 ? [] : await prisma.tVEpisodeCache.findMany({
    where: { tmdbId, seasonNumber, source: { in: sources } },
    select: {
      episodeNumber: true,
      source: true,
      episodeName: true,
      airDate: true,
      stillPath: true,
      runtime: true,
      overview: true,
    },
  });

  // Fire-and-forget cache warm: backfill owned episodes' cached metadata from the
  // fresh ENGLISH fetch (guardrail 40a; tv-season-warm.ts). Unawaited by design —
  // it's not part of the response, and a failed update self-heals on the next
  // fetch; warmEpisodeMetadata never throws and warns on failure.
  if (ownedRows.length > 0 && english.length > 0) {
    void warmEpisodeMetadata(tmdbId, seasonNumber, episodeMetadataUpdates(ownedRows, english));
  }

  const ownedSet = new Set<number>();
  const sourcesPresent = new Set<string>();
  for (const row of ownedRows) {
    ownedSet.add(row.episodeNumber);
    sourcesPresent.add(row.source);
  }

  const source: TVSeasonResponse["source"] = summarizeEpisodeSources(sourcesPresent);

  return NextResponse.json({
    episodes,
    owned: Array.from(ownedSet).sort((a, b) => a - b),
    source,
  } satisfies TVSeasonResponse);
});
