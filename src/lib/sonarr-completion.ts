// Pure, zero-import: the ONE definition of "Sonarr has finished downloading this
// series". Both writers of that verdict — the sync cache writer
// (getSonarrWantedTmdbIds) and the webhook's authoritative check
// (isSeriesDownloadedInSonarr) — call this, so they can never disagree and
// flip-flop a request between AVAILABLE and APPROVED (guardrail 14a).
//
// "Complete" means every AIRED, MONITORED, REGULAR-SEASON episode has a file:
//
//   • Sonarr's per-season `statistics.episodeCount` is already "(monitored AND
//     aired) OR has-file" — its own PercentOfEpisodes denominator — so unaired
//     episodes of a continuing series never count against it, and an episode an
//     operator UNMONITORS drops out of the denominator. That last part is the
//     escape hatch for a title one episode can never be found for: unmonitor it
//     in Sonarr and the series reads complete on the next sync.
//   • Specials are excluded HERE, not by Sonarr. The series-level
//     `statistics` block on /api/v3/series SUMS EVERY SEASON, season 0 included
//     (NzbDrone.Core/SeriesStats/SeriesStatisticsService.MapSeriesStatistics —
//     only the resource's `seasonCount` filters `SeasonNumber > 0`). A monitored
//     special without a release would hold an otherwise-complete series in
//     APPROVED forever, so the sum runs over `seasons[].statistics` with
//     seasonNumber > 0 whenever the per-season blocks are present, and only
//     falls back to the series-level aggregate when they are not.
//   • `episodeFileCount >= episodeCount` rather than `===`: Sonarr counts a
//     file-bearing episode in both, so equality is the steady state, but a
//     denominator that shrinks (an episode unmonitored after its file landed)
//     must still read complete.

export type SonarrEpisodeStats = {
  episodeFileCount?: number | null;
  episodeCount?: number | null;
} | null;

// The subset of a Sonarr /api/v3/series row this module reads. Real rows carry
// many more fields (title, path, images, …); callers intersect with their own
// types, and the two documented extras below are the ones tests build rows
// with — `status` deliberately plays NO part in the verdict (the old
// `status !== "ended"` any-file shortcut is exactly what guardrail 14a removed).
export type SonarrSeasonRow = {
  seasonNumber?: number | null;
  monitored?: boolean | null;
  statistics?: SonarrEpisodeStats;
};

export type SonarrSeriesStatsRow = {
  status?: string | null;
  statistics?: SonarrEpisodeStats;
  seasons?: readonly SonarrSeasonRow[] | null;
};

export type SonarrSeriesCompletion = {
  /** Regular-season episodes with a file on disk. */
  episodeFileCount: number;
  /** Regular-season episodes that are (monitored AND aired) OR have a file. */
  episodeCount: number;
  /** Every counted episode has a file, and there is at least one. */
  complete: boolean;
  /** Which block produced the counts — "series" means specials could not be excluded. */
  basis: "seasons" | "series";
};

function count(n: unknown): number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

export function sonarrSeriesCompletion(row: SonarrSeriesStatsRow | null | undefined): SonarrSeriesCompletion {
  const seasons = Array.isArray(row?.seasons) ? row.seasons : [];
  // Per-season blocks are authoritative only when at least one REGULAR season
  // carries one. A seasons list with no statistics at all (older payloads, or a
  // series-level fetch that skipped them) says nothing about completeness, so it
  // must not read as 0/0 = "no files" when the series block says otherwise.
  const regular = seasons.filter(
    (s): s is SonarrSeasonRow & { statistics: NonNullable<SonarrEpisodeStats> } =>
      typeof s?.seasonNumber === "number" && s.seasonNumber > 0 &&
      s.statistics != null && typeof s.statistics === "object",
  );
  let episodeFileCount: number;
  let episodeCount: number;
  let basis: SonarrSeriesCompletion["basis"];
  if (regular.length > 0) {
    episodeFileCount = regular.reduce((n, s) => n + count(s.statistics.episodeFileCount), 0);
    episodeCount = regular.reduce((n, s) => n + count(s.statistics.episodeCount), 0);
    basis = "seasons";
  } else {
    episodeFileCount = count(row?.statistics?.episodeFileCount);
    episodeCount = count(row?.statistics?.episodeCount);
    basis = "series";
  }
  return {
    episodeFileCount,
    episodeCount,
    complete: episodeFileCount > 0 && episodeFileCount >= episodeCount,
    basis,
  };
}
