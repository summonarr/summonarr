// The Download Queue's Import dialog (queue-import-dialog.tsx): the shapes of
// the routes' answers as the browser checks them, and the per-file editor's
// working copy and what it sends back. Pure, no "use client", so the unit suite
// drives it (tests/queue-import-rules.test.mts).
import { v, type Infer } from "@/lib/validate";
import { SONARR_RELEASE_TYPES, type ImportCandidate, type ImportOverride, type SonarrReleaseType } from "@/lib/arr-queue";

const Choice = v.object({ id: v.int(), name: v.string() });
export type ImportChoice = Infer<typeof Choice>;

/** One file as the routes project it (ImportCandidate, src/lib/arr-queue.ts). */
export const ImportCandidateWire = v.object({
  path: v.string(),
  name: v.string(),
  size: v.number(),
  quality: v.nullable(v.string()),
  languages: v.array(v.string()),
  releaseGroup: v.nullable(v.string()),
  target: v.nullable(v.string()),
  episodes: v.array(v.object({ seasonNumber: v.int(), episodeNumber: v.int() })),
  rejections: v.array(v.string()),
  importable: v.boolean(),
  movieId: v.nullable(v.int()),
  seriesId: v.nullable(v.int()),
  episodeIds: v.array(v.int()),
  qualityId: v.nullable(v.int()),
  languageIds: v.array(v.int()),
  releaseType: v.nullable(v.string()),
});

/** GET /api/admin/queue/import: the download's files and the instance's choices for the editor. */
export const ImportListAnswer = v.object({
  files: v.array(ImportCandidateWire),
  qualities: v.optional(v.array(Choice)),
  languages: v.optional(v.array(Choice)),
});

/** POST …/import/preview: the arr's verdict on the corrected file. */
export const ImportPreviewAnswer = v.object({ files: v.array(ImportCandidateWire), rechecked: v.optional(v.boolean()) });

/** GET …/import/targets: titles the instance has that match a search. */
export const ImportTargetsAnswer = v.object({
  results: v.array(v.object({ id: v.int(), title: v.string(), year: v.nullable(v.number()) })),
});
export type ImportTargetChoice = Infer<typeof ImportTargetsAnswer>["results"][number];

/** GET …/import/episodes: one series' episodes. */
export const ImportEpisodesAnswer = v.object({
  episodes: v.array(v.object({ id: v.int(), seasonNumber: v.int(), episodeNumber: v.int(), title: v.string(), hasFile: v.boolean() })),
});
export type ImportEpisodeChoice = Infer<typeof ImportEpisodesAnswer>["episodes"][number];

/** POST /api/admin/queue/import: how many files the arr took. */
export const ImportSubmitAnswer = v.object({ files: v.optional(v.number()) });

export function isSonarrReleaseType(value: unknown): value is SonarrReleaseType {
  return (SONARR_RELEASE_TYPES as readonly unknown[]).includes(value);
}

/** The editor's working copy of one file. */
export type Draft = {
  movie: ImportTargetChoice | null;
  series: ImportTargetChoice | null;
  episodeIds: number[];
  season: number | null;
  qualityId: number | null;
  languageIds: number[];
  releaseGroup: string;
  releaseType: SonarrReleaseType | null;
};

/** The editor's starting point: what the file shows now (with any applied correction). */
export function initialDraft(service: "radarr" | "sonarr", current: ImportCandidate): Draft {
  const titleLabel = current.target
    ? { id: service === "radarr" ? current.movieId ?? 0 : current.seriesId ?? 0, title: current.target, year: null }
    : null;
  return {
    movie: service === "radarr" && current.movieId ? titleLabel : null,
    series: service === "sonarr" && current.seriesId ? titleLabel : null,
    episodeIds: [...current.episodeIds],
    season: current.episodes[0]?.seasonNumber ?? null,
    qualityId: current.qualityId,
    languageIds: [...current.languageIds],
    releaseGroup: current.releaseGroup ?? "",
    // A release type the dialog doesn't offer starts as no choice ("unknown" in the select).
    releaseType: isSonarrReleaseType(current.releaseType) ? current.releaseType : null,
  };
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Only what the admin actually changed goes back as a correction. */
export function overrideFrom(file: ImportCandidate, d: Draft, service: "radarr" | "sonarr"): ImportOverride {
  const o: ImportOverride = {};
  if (service === "radarr" && d.movie && d.movie.id !== file.movieId) o.movieId = d.movie.id;
  if (service === "sonarr" && d.series && d.episodeIds.length > 0) {
    if (d.series.id !== file.seriesId) {
      o.seriesId = d.series.id;
      o.episodeIds = [...d.episodeIds];
    } else if (!sameSet(d.episodeIds, file.episodeIds)) {
      o.episodeIds = [...d.episodeIds];
    }
  }
  if (d.qualityId !== null && d.qualityId !== file.qualityId) o.qualityId = d.qualityId;
  if (!sameSet(d.languageIds, file.languageIds)) o.languageIds = [...d.languageIds];
  if (d.releaseGroup.trim() !== (file.releaseGroup ?? "")) o.releaseGroup = d.releaseGroup.trim();
  if (service === "sonarr" && d.releaseType && d.releaseType !== file.releaseType) o.releaseType = d.releaseType;
  return o;
}

/** `ids` with `id` added, or removed when it was there. */
export function toggleId(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * The chosen episodes across EVERY season, in order: the season select only
 * changes which season's episodes are listed, and a choice made in another
 * season still goes back with Apply — so the editor names them all.
 */
export function chosenEpisodes(episodes: readonly ImportEpisodeChoice[], ids: readonly number[]): ImportEpisodeChoice[] {
  const chosen = new Set(ids);
  return episodes
    .filter((e) => chosen.has(e.id))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}
