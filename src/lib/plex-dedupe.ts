// Plex can conflate two or more TMDB ids onto ONE ratingKey when metadata bundles
// merge, so a single physical item claims several tmdb guids. PlexLibraryItem is
// keyed ([tmdbId, mediaType, serverInstance]), so those candidates would become
// several rows all pointing at the same item — and every reader that maps
// ratingKey → title (play-history, fix-match) would then have no single answer.
// Exactly one candidate may survive per conflated ratingKey.
//
// ONE definition, called by both writers — the orchestrator's Plex arm
// (/api/sync) and the admin Resync route (/api/sync/plex). They previously held
// near-identical private copies that a comment asked you to keep in agreement by
// hand; the rule below decides which title keeps its library row, so a drift
// between them means one writer drops the row the other just wrote, every run.
//
// Scoped per instance (guardrail 35): ratingKeys are small server-local integers,
// so the SAME key on two independently-administered servers is routine and
// legitimate — NOT conflation. Callers run this per instance batch, and the
// prior-mapping lookup consults only THAT instance's stored rows (an unscoped
// read could import another server's ratingKey→tmdbId mapping and wrongly drop
// this server's row).

import { prisma } from "@/lib/prisma";
import type { MediaInstanceKey } from "@/lib/media-instances";
import { warnOnChange } from "@/lib/log-dedup";

export type PlexDedupeRow = { tmdbId: number; plexRatingKey: string | null };

/** Log/dedup scope — distinct per writer so the admin Resync's finding is not
 *  swallowed just because the hourly orchestrator logged the same conflicts. */
export type PlexDedupeScope = "sync" | "sync/plex";

/**
 * Lowest tmdbId wins. The tiebreak's only job is to be the SAME on every run:
 * the losing candidates get no library row at all (no availability badge, no
 * TVEpisodeCache entry), so an unstable rule silently swaps which title is
 * visible. Any total order over the candidates would do — this one needs no
 * extra columns, so PlexDedupeRow stays minimal and every caller's richer row
 * type flows through the generic unchanged.
 *
 * Deliberately NOT "first occurrence in the fetched array": the rows arrive
 * from a Map filled by a concurrent walk over library sections
 * (Promise.all in getPlexTmdbIds), so array order varies between runs.
 */
function lowestTmdbId(ids: number[]): number {
  return ids.reduce((best, id) => (id < best ? id : best));
}

export async function deduplicatePlexRowsByRatingKey<T extends PlexDedupeRow>(
  rows: T[],
  mediaType: "MOVIE" | "TV",
  serverInstance: MediaInstanceKey,
  scope: PlexDedupeScope,
): Promise<T[]> {
  const ratingKeyCount = new Map<string, number>();
  for (const r of rows) {
    if (r.plexRatingKey) ratingKeyCount.set(r.plexRatingKey, (ratingKeyCount.get(r.plexRatingKey) ?? 0) + 1);
  }
  const conflatedKeys = [...ratingKeyCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (conflatedKeys.length === 0) return rows;
  const conflated = new Set(conflatedKeys);

  // Keyed on the RATING KEY, never on the candidate tmdbIds.
  //
  // This read is what pins a conflated key to the title it resolved to last
  // time, so the choice does not wander. Looking the prior mapping up by
  // `tmdbId IN (this batch's candidates)` lost that pin whenever the pinned
  // title was missing from the current fetch — and a partial fetch is routine
  // while Plex is mid-scan, which is exactly when the sync runs most often
  // (the SSE timeline handler triggers it). With no mapping found the code fell
  // through to "keep the first occurrence in array order", wrote a DIFFERENT
  // winner, and read that back as the pin forever after. Observed live: four
  // shows on one ratingKey, pinned to 225634 for two runs and to 113988 after.
  const existing = await prisma.plexLibraryItem.findMany({
    where: { mediaType, serverInstance, plexRatingKey: { in: conflatedKeys } },
    select: { tmdbId: true, plexRatingKey: true },
  });
  const pinned = new Map<string, number>();
  for (const e of existing) {
    if (!e.plexRatingKey) continue;
    // findMany returns rows in no defined order and plexRatingKey is only
    // indexed, not unique, so resolve a duplicate stored mapping the same way
    // the batch tiebreak does rather than by last-write-wins.
    const prev = pinned.get(e.plexRatingKey);
    if (prev === undefined || e.tmdbId < prev) pinned.set(e.plexRatingKey, e.tmdbId);
  }

  const candidates = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.plexRatingKey || !conflated.has(r.plexRatingKey)) continue;
    const ids = candidates.get(r.plexRatingKey);
    if (ids) ids.push(r.tmdbId);
    else candidates.set(r.plexRatingKey, [r.tmdbId]);
  }

  const winners = new Map<string, number>();
  for (const [key, ids] of candidates) {
    const pin = pinned.get(key);
    // Honour the pin only when that title is actually in this batch. A pin
    // naming an absent tmdbId would drop EVERY candidate and leave the
    // ratingKey with no row at all — which on the full-replace path also
    // destroys the pin, so the next run starts over from the tiebreak.
    winners.set(key, pin !== undefined && ids.includes(pin) ? pin : lowestTmdbId(ids));
  }

  // Collected, not logged per row. The same handful of conflations recurs on
  // EVERY sync — they describe a stable property of the library, not an event
  // — so a line per dropped item made the library sync the loudest thing in
  // the log while saying nothing new each time. One summary per run keeps the
  // signal (how many, which keys, which instance) without the repetition.
  const dropped: string[] = [];
  const kept = rows.filter((r) => {
    if (!r.plexRatingKey || !conflated.has(r.plexRatingKey)) return true;
    const winner = winners.get(r.plexRatingKey);
    if (winner === r.tmdbId) return true;
    dropped.push(`${r.plexRatingKey}→${winner} (dropped ${r.tmdbId})`);
    return false;
  });

  if (dropped.length > 0) {
    // Repeat-suppressed: a conflated ratingKey is a standing property of the
    // Plex library plus its pinned mappings, so this recomputes to the same
    // string on every run. The signature is the dropped list itself — not just
    // its length — so a different set of conflicts re-logs even when the count
    // happens to match, which is what makes a moved winner visible.
    warnOnChange(
      `${scope}-conflated:${mediaType}:${serverInstance}`,
      dropped.join(", "),
      `[${scope}] ${dropped.length} conflated ratingKey(s) resolved to one tmdbId ` +
        `(${mediaType}, instance="${serverInstance}"): ${dropped.join(", ")}`,
    );
  }
  return kept;
}
