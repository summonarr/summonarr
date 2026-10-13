// Pure rules behind the admin title manager's UI (components/admin/arr-title/),
// kept out of the components so node:test can pin them: when the manager may
// close — or a link may lead out of it — and which Sonarr seasons' episode
// lists a re-read title has made stale. Type-only imports: client components
// import this directly.

import type { TitleSeason } from "./arr-title";

export type CloseVerdict = "close" | "confirm" | "wait";

/**
 * What closing the title manager does right now — Escape, the X, the
 * backdrop, or following the History tab's Download Queue link out of it:
 * - "close": nothing to lose (no unsaved Settings edits, the discard banner is
 *   already showing and this is the second ask, or the title is gone).
 * - "confirm": unsaved Settings edits — show the discard banner first.
 * - "wait": a Settings save is in flight. Its PATCH is already sent and the arr
 *   applies it (a root-folder move included), so offering to "discard" the
 *   edits would describe the opposite of what happens. The close is refused
 *   until the save answers (bounded by arrFetch's timeout).
 */
export function closeVerdict(s: { removed: boolean; saving: boolean; dirty: boolean; confirming: boolean }): CloseVerdict {
  // A removed title has no edits left to lose (its form is gone with it).
  if (s.removed) return "close";
  if (s.saving) return "wait";
  if (s.dirty && !s.confirming) return "confirm";
  return "close";
}

/** Everything a season's header row shows that its episode rows can disagree with. */
export function seasonSignature(s: TitleSeason): string {
  return `${s.monitored ? 1 : 0}:${s.episodeCount}:${s.episodeFileCount}:${s.totalEpisodeCount}:${s.sizeOnDisk}`;
}

/**
 * The seasons whose header changed since `seen` (season number → signature),
 * which is updated in place. A season seen for the first time is recorded,
 * never reported: there is no earlier list of it to be stale.
 */
export function staleSeasons(seen: Map<number, string>, seasons: readonly TitleSeason[]): number[] {
  const changed: number[] = [];
  for (const s of seasons) {
    const sig = seasonSignature(s);
    const prev = seen.get(s.seasonNumber);
    if (prev !== undefined && prev !== sig) changed.push(s.seasonNumber);
    seen.set(s.seasonNumber, sig);
  }
  return changed;
}

/**
 * True when the click on a link should be left to the browser: a modified or
 * non-primary click opens the target ELSEWHERE (a new tab or window), so the
 * page — and the dialog the link sits in — stays exactly as it is.
 */
export function opensElsewhere(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}
