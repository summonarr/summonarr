// What the release routes answer, as the browser checks it: the request queue's
// "Pick release" (GET /api/requests/[id]/releases), the title manager's
// interactive search (GET /api/admin/arr/title/releases) and the issue Fix file
// window list the same projected ArrRelease (src/lib/arr-releases.ts, where
// `guid` is already the server's opaque handle, guardrail 5e). A body that
// doesn't match is a failed search, never a list rendered from a guess.
// Pure, no "use client": a server module may import it too.
import { v, type Infer } from "@/lib/validate";

export const ArrReleaseWire = v.object({
  guid: v.string(),
  title: v.string(),
  size: v.number(),
  indexerId: v.int(),
  indexer: v.string(),
  quality: v.object({
    quality: v.object({ id: v.int(), name: v.string() }),
    revision: v.object({ version: v.int() }),
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
export type ArrReleaseWire = Infer<typeof ArrReleaseWire>;

/** A search's answer. */
export const ReleasesAnswer = v.object({ releases: v.array(ArrReleaseWire) });

/** A series' seasons, before its first search (SonarrSeasonSummary). */
export const SeasonsAnswer = v.object({
  seasons: v.array(
    v.object({
      seasonNumber: v.int(),
      aired: v.int(),
      missing: v.int(),
      monitored: v.boolean(),
    }),
  ),
});
