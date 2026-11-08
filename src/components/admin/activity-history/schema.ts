// What /api/play-history answers the History table, checked before it drives
// any state (validate.ts). The row TYPES in ./types derive from these schemas,
// so the table's idea of a row can't drift from what it checks. `v.object`
// keeps only the declared keys: every field a component reads is declared here.

import { v } from "@/lib/validate";

const text = v.nullable(v.string());
const num = v.nullable(v.number());
const int = v.nullable(v.int());
const flag = v.nullable(v.boolean());

export const historyRowSchema = v.object({
  id: v.string(),
  // "plex" | "jellyfin" by convention; the column is a plain VarChar, and the
  // UI only colours and labels by it, so any string renders.
  source: v.string(),
  // Media-server instance slug (media-instances.ts). "" = the default/only
  // server, which is also what every row written before multi-server support
  // reads (`@default("")`), so the UI renders a badge for it only when
  // non-empty.
  serverInstance: v.string(),
  title: v.string(),
  tmdbId: int,
  // The MediaType enum.
  mediaType: v.nullable(v.literal("MOVIE", "TV")),
  startedAt: v.string(),
  stoppedAt: text,
  duration: v.number(),
  playDuration: v.number(),
  pausedDuration: num,
  watched: v.boolean(),
  platform: text,
  player: text,
  device: text,
  ipAddress: text,
  playMethod: text,
  resolution: text,
  videoCodec: text,
  audioCodec: text,
  bitrate: num,
  container: text,
  videoDecision: text,
  audioDecision: text,
  seasonNumber: int,
  episodeNumber: int,
  episodeTitle: text,
  posterUrl: text,
  // Network metadata (Plex-only — Jellyfin leaves these null).
  location: text,
  bandwidth: num,
  secure: flag,
  relayed: flag,
  // Intro/credits markers (Plex-only). Offsets in milliseconds.
  introStartMs: num,
  introEndMs: num,
  creditsStartMs: num,
  creditsEndMs: num,
  // Resume-grouping anchor (see prisma/schema.prisma PlayHistory.referenceId).
  referenceId: text,
  // The chain a row stands for. BOTH API paths send these: the grouped path
  // aggregates over the chain (COUNT / SUM / MIN / MAX window functions), and
  // the ungrouped path mirrors the row's own values (segmentCount 1,
  // totalPlayDuration = playDuration, chainId = referenceId ?? id), so the UI
  // reads them unconditionally. The row's own startedAt stays the table's
  // Started column (it is the grouped sort key); the detail panel spans the
  // chain with these.
  segmentCount: v.int(),
  chainId: v.string(),
  totalPlayDuration: v.number(),
  totalPausedDuration: num,
  firstStartedAt: v.string(),
  lastStoppedAt: text,
  mediaServerUserId: v.string(),
  // A required FK, so always present in practice; the grouped path still
  // answers null when the joined username is missing, so the UI falls back.
  mediaServerUser: v.nullable(
    v.object({
      username: v.string(),
      source: v.string(),
      thumbUrl: text,
    }),
  ),
});

// One page of the table. `page`, `limit` and `grouped` also arrive; the table
// keeps its own copies of the first two and doesn't read the third.
export const historyPageSchema = v.object({
  items: v.array(historyRowSchema),
  total: v.int(),
  totalPages: v.int(),
});

// `?distinct=platforms`: the platforms any play was recorded on.
export const platformOptionsSchema = v.array(v.string());

// `?distinct=users`. `serverInstance` is additive on the wire: the filter bar
// reads it only to tell apart a username that exists on two same-type servers.
export const userOptionsSchema = v.array(
  v.object({
    id: v.string(),
    username: v.string(),
    source: v.string(),
    serverInstance: v.optional(v.string()),
  }),
);
