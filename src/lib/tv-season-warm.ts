import { prisma } from "@/lib/prisma";
import { settleLimit } from "@/lib/concurrency";
import { warnOnChange } from "@/lib/log-dedup";
import type { TmdbEpisode } from "@/lib/tmdb-types";

// The season view's cache warm (GET /api/tv/[id]/season/[n]): the owned
// episodes' TVEpisodeCache metadata, backfilled from TMDB's season fetch.
//
// From the ENGLISH list, never the viewer's localized one: TVEpisodeCache is
// shared by every viewer and stored data stays English (guardrail 40a). Warming
// it in the viewer's language made viewers in different languages rewrite every
// owned row back and forth on each expand.

export type OwnedEpisodeRow = {
  source: string;
  episodeNumber: number;
  episodeName: string | null;
  airDate: string | null;
  stillPath: string | null;
  runtime: number | null;
  overview: string | null;
};

export type EpisodeMetadata = Pick<OwnedEpisodeRow, "episodeName" | "airDate" | "stillPath" | "runtime" | "overview">;

/**
 * The writes that bring the owned rows in line with TMDB's English episode
 * list. A row TMDB no longer lists, or whose metadata already matches, needs
 * none — so a warm cache issues zero writes.
 */
export function episodeMetadataUpdates(
  owned: readonly OwnedEpisodeRow[],
  english: readonly TmdbEpisode[],
): Array<{ source: string; episodeNumber: number; data: EpisodeMetadata }> {
  const byNumber = new Map(english.map((e) => [e.episodeNumber, e]));
  const out: Array<{ source: string; episodeNumber: number; data: EpisodeMetadata }> = [];
  for (const row of owned) {
    const ep = byNumber.get(row.episodeNumber);
    if (!ep) continue;
    const data: EpisodeMetadata = {
      episodeName: ep.name ?? null,
      airDate: ep.airDate ?? null,
      stillPath: ep.stillPath ?? null,
      runtime: ep.runtime ?? null,
      overview: ep.overview || null,
    };
    if (
      row.episodeName === data.episodeName
      && row.airDate === data.airDate
      && row.stillPath === data.stillPath
      && row.runtime === data.runtime
      && row.overview === data.overview
    ) continue;
    out.push({ source: row.source, episodeNumber: row.episodeNumber, data });
  }
  return out;
}

/**
 * Applies the updates, at most five at a time (guardrail 31: the list scales
 * with season size × visible sources). Never throws: a failed write self-heals
 * on the next fetch, so failures are counted into ONE warning per pass, through
 * warnOnChange so a persistent failure doesn't restate itself on every view
 * (guardrail 7b).
 */
export async function warmEpisodeMetadata(
  tmdbId: number,
  seasonNumber: number,
  updates: ReadonlyArray<{ source: string; episodeNumber: number; data: EpisodeMetadata }>,
): Promise<void> {
  if (updates.length === 0) return;
  const settled = await settleLimit(updates, 5, (u) =>
    prisma.tVEpisodeCache.update({
      where: {
        source_tmdbId_seasonNumber_episodeNumber: { source: u.source, tmdbId, seasonNumber, episodeNumber: u.episodeNumber },
      },
      data: u.data,
    }),
  );
  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failures.length === 0) return;
  const reason = failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason);
  warnOnChange(
    "tv-season:metadata-warm",
    reason,
    `[tv-season] episode metadata warm failed for ${failures.length} of ${updates.length} episode(s): ${reason}`,
  );
}
