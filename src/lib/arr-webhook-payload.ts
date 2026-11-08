// Typed views of a Radarr/Sonarr webhook payload. The payload is attacker-shaped
// (the secret is the only auth, guardrail 2) and only its top level is checked
// before the handlers run, so every field is `unknown` here and narrowed once:
// a non-number id is null, a non-string title is null, never "[object Object]".
// A view is DERIVED, never written back: the replay digest is recorded (and
// cleared) over the original object. Pure, so the rules are testable alone.
import { isTmdbIdInRange } from "./tmdb-id";

/** A positive integer, else null. */
export function positiveInt(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x > 0 ? x : null;
}

/** A tmdbId the INT4 columns can hold, else null. */
export function tmdbIdOrNull(x: unknown): number | null {
  return typeof x === "number" && isTmdbIdInRange(x) ? x : null;
}

/** A string, else null. */
export function stringOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

const fieldsOf = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};

export interface RadarrWebhookView {
  eventType: unknown;
  /** Absent when the payload names no movie. */
  movie: {
    /** As sent: the Download path tells "no id" (skipped) from "a bad id" (400). */
    rawTmdbId: unknown;
    tmdbId: number | null;
    title: string | null;
  } | null;
  /** MovieFileDelete only — Radarr's DeleteMediaFileReason ("upgrade" when replaced by a better file). */
  deleteReason: string | null;
}

export function readRadarrPayload(payload: { movie?: unknown; eventType?: unknown; deleteReason?: unknown }): RadarrWebhookView {
  const movie = payload.movie ? fieldsOf(payload.movie) : null;
  return {
    eventType: payload.eventType,
    movie: movie && { rawTmdbId: movie.tmdbId, tmdbId: tmdbIdOrNull(movie.tmdbId), title: stringOrNull(movie.title) },
    deleteReason: stringOrNull(payload.deleteReason),
  };
}

export type SonarrEpisodeRef = { seasonNumber?: unknown; episodeNumber?: unknown };

export interface SonarrWebhookView {
  eventType: unknown;
  /** Absent when the payload names no series. */
  series: {
    /** Sonarr's own key: a positive integer. */
    tvdbId: number | null;
    /** In INT4 range. */
    tmdbId: number | null;
    /** Any positive integer — the manual-interaction marker's fallback key, never a lookup. */
    tmdbIdKey: number | null;
    title: string | null;
  } | null;
  /** The delivered episodes; a non-array or a null entry is dropped. */
  episodes: SonarrEpisodeRef[];
}

export function readSonarrPayload(payload: { series?: unknown; eventType?: unknown; episodes?: unknown }): SonarrWebhookView {
  const series = payload.series ? fieldsOf(payload.series) : null;
  return {
    eventType: payload.eventType,
    series: series && {
      tvdbId: positiveInt(series.tvdbId),
      tmdbId: tmdbIdOrNull(series.tmdbId),
      tmdbIdKey: positiveInt(series.tmdbId),
      title: stringOrNull(series.title),
    },
    episodes: Array.isArray(payload.episodes)
      ? payload.episodes.filter((e): e is SonarrEpisodeRef => e !== null && typeof e === "object")
      : [],
  };
}

/** " S01E05" for one episode, " (3 episodes)" for several, "" when unknown. */
export function sonarrEpisodeScope(episodes: readonly SonarrEpisodeRef[]): string {
  if (episodes.length === 1 && episodes[0].seasonNumber != null && episodes[0].episodeNumber != null) {
    return ` S${String(episodes[0].seasonNumber).padStart(2, "0")}E${String(episodes[0].episodeNumber).padStart(2, "0")}`;
  }
  return episodes.length > 1 ? ` (${episodes.length} episodes)` : "";
}

/**
 * Whether a Sonarr Download delivered what an issue grab was waiting for.
 * Sonarr fires one Download per EPISODE (guardrail 14a), so a grab is claimed
 * only by its own delivery: EPISODE needs a delivered episode matching season
 * AND episode; SEASON needs a matching season; FULL matches any delivery. A grab
 * with no season/episode to match on keeps the any-delivery behaviour rather
 * than being stranded.
 */
export function grabMatchesDelivery(
  grab: { scope: string; seasonNumber: number | null; episodeNumber: number | null },
  episodes: readonly SonarrEpisodeRef[],
): boolean {
  const delivered = episodes.filter((e) => Number.isInteger(e.seasonNumber));
  if (grab.scope === "EPISODE" && grab.seasonNumber != null && grab.episodeNumber != null) {
    return delivered.some((e) => e.seasonNumber === grab.seasonNumber && e.episodeNumber === grab.episodeNumber);
  }
  if (grab.scope === "SEASON" && grab.seasonNumber != null) {
    return delivered.some((e) => e.seasonNumber === grab.seasonNumber);
  }
  return true;
}
