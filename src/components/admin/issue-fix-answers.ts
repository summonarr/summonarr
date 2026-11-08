// What the issue "Fix file" window reads from its routes, checked before it is
// rendered (src/lib/validate.ts): the release list, what is on disk, and what a
// replace did. A payload of another shape becomes the window's error state
// instead of a crash deep inside the render (`rel.quality.quality.name`).
//
// Pure and React-free: tests/issue-fix-answers.test.mts runs every reader.
import type { ArrRelease } from "@/lib/arr-releases";
import { check, v, type Infer } from "@/lib/validate";

// GET /api/issues/[id]/releases — toArrRelease's projection (guardrail 5e),
// every field declared so the checked release is a whole ArrRelease.
const ReleaseSchema = v.object({
  guid: v.string(),
  title: v.string(),
  size: v.number(),
  indexerId: v.int(),
  indexer: v.string(),
  quality: v.object({
    quality: v.object({ id: v.int(), name: v.string() }),
    revision: v.object({ version: v.number() }),
  }),
  qualityWeight: v.number(),
  releaseWeight: v.nullable(v.number()),
  customFormatScore: v.nullable(v.number()),
  customFormats: v.array(v.string()),
  languages: v.array(v.string()),
  protocol: v.literal("torrent", "usenet"),
  seeders: v.nullable(v.number()),
  leechers: v.nullable(v.number()),
  age: v.number(),
  rejected: v.boolean(),
  rejections: v.array(v.string()),
  downloadAllowed: v.boolean(),
});
const ReleaseListSchema = v.array(ReleaseSchema);

/** The release list of a search's answer, or null when it isn't one. */
export function releaseListOf(data: unknown): ArrRelease[] | null {
  const checked = check(ReleaseListSchema, data);
  return checked.ok ? checked.value : null;
}

// GET /api/issues/[id]/files — the fields of each file the window shows.
const ListedFileSchema = v.object({
  id: v.int(),
  relativePath: v.string(),
  path: v.nullable(v.string()),
  size: v.number(),
  quality: v.nullable(v.string()),
  qualityCutoffNotMet: v.boolean(),
  languages: v.array(v.string()),
  releaseGroup: v.nullable(v.string()),
  episodes: v.array(v.object({ seasonNumber: v.int(), episodeNumber: v.int(), title: v.nullable(v.string()) })),
  grab: v.nullable(v.object({ failed: v.boolean(), event: v.object({ sourceTitle: v.string() }) })),
});
const FileListingSchema = v.object({
  files: v.array(ListedFileSchema),
  otherFiles: v.optional(v.unknown()),
  seriesType: v.optional(v.unknown()),
});

export type ListedFile = Infer<typeof ListedFileSchema>;

export interface FileListing {
  files: ListedFile[];
  /** The title's files outside the issue's scope — not offered, only counted. */
  otherFiles: number;
  /** Sonarr's series type: "anime" numbers episodes its own way (the issue's numbers are the media server's). */
  seriesType: string | null;
}

/** The files on one instance, or null when the answer isn't a listing. */
export function fileListingOf(data: unknown): FileListing | null {
  const checked = check(FileListingSchema, data);
  if (!checked.ok) return null;
  const { files, otherFiles, seriesType } = checked.value;
  return {
    files,
    otherFiles: typeof otherFiles === "number" && Number.isFinite(otherFiles) ? otherFiles : 0,
    seriesType: typeof seriesType === "string" ? seriesType : null,
  };
}

// POST /api/issues/[id]/files — what happened (also carried by a 502 beside
// `error`). Only what the window shows; a count it left out reads 0.
export interface ReplaceResult {
  deleted: number;
  marked: number;
  unmarked: number;
  searched: boolean;
  /** Marks the arr's own redownload searches for. */
  redownloading: number;
  /** What the delete unmonitored and was monitored again. */
  remonitored: number;
  /** That re-monitor failed: the files were searched for by name, and may stay unmonitored. */
  remonitorFailed: boolean;
  nothingMissing: boolean;
}

const ReplaceAnswerSchema = v.object({
  deleted: v.optional(v.unknown()),
  marked: v.optional(v.unknown()),
  unmarked: v.optional(v.unknown()),
  searched: v.optional(v.unknown()),
  redownloading: v.optional(v.unknown()),
  remonitored: v.optional(v.unknown()),
  remonitorFailed: v.optional(v.unknown()),
  nothingMissing: v.optional(v.unknown()),
});

const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * What a replace did, or null when it deleted nothing (or the answer isn't one):
 * a 502 can still carry what WAS done — files deleted before the search
 * failed, or a delete that stopped part-way — and it is shown either way.
 */
export function replaceResultOf(data: unknown): ReplaceResult | null {
  const checked = check(ReplaceAnswerSchema, data);
  if (!checked.ok) return null;
  const d = checked.value;
  const deleted = countOf(d.deleted);
  if (deleted === 0) return null;
  return {
    deleted,
    marked: countOf(d.marked),
    unmarked: countOf(d.unmarked),
    searched: d.searched === true,
    redownloading: countOf(d.redownloading),
    remonitored: countOf(d.remonitored),
    remonitorFailed: d.remonitorFailed === true,
    nothingMissing: d.nothingMissing === true,
  };
}
