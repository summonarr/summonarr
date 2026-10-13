// "Instant, then live" in the admin title manager (src/lib/arr-snapshot.ts):
// the rules that keep a painted snapshot away from anything the admin did.
// A snapshot is display only — every write still goes to the same routes,
// which re-check the title live (guardrail 5e). Pure and zero-import, so the
// unit suite pins it (tests/arr-snapshot-title-manager.test.mts).

/** Which title: by TMDB id (resolved on the instance) or by the arr's own id. */
export type TitleReadTarget = { tmdbId: number } | { arrId: number };

/**
 * The title read for one target, before the base path. The live read and the
 * snapshot read are BOTH this URL: the server keys a snapshot on path + query,
 * so a second spelling would never find the one the live read kept.
 */
export function titleReadPath(service: string, instance: string, by: TitleReadTarget): string {
  const q = new URLSearchParams({ service, instance });
  if ("tmdbId" in by) q.set("tmdbId", String(by.tmdbId));
  else q.set("id", String(by.arrId));
  return `/api/admin/arr/title?${q.toString()}`;
}

/** A target as an effect key — a parent re-render hands a new object. */
export function titleTargetKey(target: TitleReadTarget): string {
  return "tmdbId" in target ? `tmdb:${target.tmdbId}` : `arr:${target.arrId}`;
}

/** The target an effect key names (the inverse of titleTargetKey). */
export function titleTargetOfKey(key: string): TitleReadTarget {
  const [kind, id] = key.split(":");
  return kind === "tmdb" ? { tmdbId: Number(id) } : { arrId: Number(id) };
}

/**
 * How a LIVE title answer lands. The open-time read replaces the state and
 * remounts the Settings form — unless a snapshot was painted first: the admin
 * may already be editing over it, so that live answer REBASES the form exactly
 * as a background re-read does (merged, edits kept). Every later read rebases.
 */
export function liveTitleLanding(initial: boolean, snapshotPainted: boolean): "replace" | "rebase" {
  return initial && !snapshotPainted ? "replace" : "rebase";
}

/**
 * Whether a snapshot may paint a view: only an EMPTY one, and never while a
 * write the admin started is in flight. Anything already shown — a live
 * answer, a write's answer, rows the admin selected or flipped — wins.
 */
export function snapshotMayPaint(shown: boolean, writing: boolean): boolean {
  return !shown && !writing;
}

/**
 * A season's episode list (read per expand, so no one url per tab): its
 * snapshot paints only for the NEWEST read of that season, only while that
 * read hasn't answered — or answered with a failure (an arr that is down keeps
 * its last good list on screen, marked stale) — and only over an empty list
 * with no write in flight.
 */
export function episodeSnapshotMayPaint(p: {
  /** The read this snapshot belongs to. */
  seq: number;
  /** The newest read started for the season. */
  newest: number | undefined;
  /** The newest read that answered for the season. */
  answered: number | undefined;
  /** That answer was a failure (the list kept nothing new). */
  failed: boolean;
  /** Episodes the list shows now. */
  shown: number;
  writing: boolean;
}): boolean {
  return p.seq === p.newest && (p.answered !== p.seq || p.failed) && snapshotMayPaint(p.shown > 0, p.writing);
}
