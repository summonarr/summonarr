// Admin → Never watched (never-watched-report.tsx): the report page and the
// "Check now" result as the browser checks them before rendering. Every field
// the page reads is declared — a check keeps only declared keys — and the row
// schemas produce exactly NwTitleRow / NwSeasonRow (the component's row props
// are those types, so a field missing here fails the typecheck). A body that
// doesn't match is a failed load, never a page that throws mid-render.
// Pure, no "use client" (tests/never-watched-wire.test.mts).
import { v, type Infer } from "@/lib/validate";
import { NW_REASONS, NW_STATES, type NwUpstreamHealth } from "@/lib/never-watched";
import type { NwSeasonRow, NwTitleRow } from "@/lib/never-watched-report";
import { CLEANUP_EXCLUSIONS as CLEANUP_EXCLUSION_LIST, CLEANUP_RULES as CLEANUP_RULE_LIST, type CleanupExclusion, type CleanupRule } from "@/lib/library-cleanup";

const CLEANUP_RULES: readonly CleanupRule[] = CLEANUP_RULE_LIST;
const CLEANUP_EXCLUSIONS: readonly CleanupExclusion[] = CLEANUP_EXCLUSION_LIST;
const UPSTREAM_HEALTH = v.literal("ok", "unreliable", "failed", "incomplete", "stale", "never");

const state = v.literal(...NW_STATES);
const reason = v.nullable(v.literal(...NW_REASONS));
const isoOrNull = v.nullable(v.string());

export const NwTitleRowWire = v.object({
  kind: v.literal("title"),
  tmdbId: v.int(),
  mediaType: v.literal("MOVIE", "TV"),
  title: v.string(),
  posterPath: v.nullable(v.string()),
  year: v.nullable(v.string()),
  servers: v.array(v.string()),
  addedAt: isoOrNull,
  shelfStart: isoOrNull,
  state,
  reason,
  reasonServers: v.array(v.string()),
  windowStart: isoOrNull,
  days: v.nullable(v.number()),
  fullyObserved: v.boolean(),
  softPlays: v.number(),
  softServers: v.array(v.string()),
  arr: v.array(v.object({ service: v.literal("radarr", "sonarr"), instance: v.string(), sizeOnDisk: v.number() })),
  sizeOnDisk: v.nullable(v.number()),
  protected: v.boolean(),
  cleanup: v.object({
    matched: v.array(v.literal(...CLEANUP_RULES)),
    excludedBy: v.array(v.literal(...CLEANUP_EXCLUSIONS)),
    candidate: v.boolean(),
  }),
  eligible: v.boolean(),
});

export const NwSeasonRowWire = v.object({
  kind: v.literal("season"),
  tmdbId: v.int(),
  mediaType: v.literal("TV"),
  title: v.string(),
  posterPath: v.nullable(v.string()),
  year: v.nullable(v.string()),
  servers: v.array(v.string()),
  seasonNumber: v.int(),
  episodes: v.number(),
  state,
  reason,
  reasonServers: v.array(v.string()),
  windowStart: isoOrNull,
  days: v.nullable(v.number()),
  fullyObserved: v.boolean(),
  airing: v.boolean(),
  sizeOnDisk: v.nullable(v.number()),
  sizeMismatch: v.boolean(),
});

const CoverageWire = v.object({
  server: v.string(),
  tracked: v.boolean(),
  since: isoOrNull,
  holds: v.boolean(),
  upstream: v.object({
    health: UPSTREAM_HEALTH,
    fetchedAt: isoOrNull,
    samples: v.number(),
    agreed: v.number(),
    error: v.nullable(v.string()),
    errorCode: v.optional(v.nullable(v.string())),
    httpStatus: v.optional(v.nullable(v.number())),
  }),
});

/** GET /api/admin/never-watched: the report's summary and one page of rows. */
export const NwPageWire = v.object({
  totals: v.object({
    never: v.object({ titles: v.number(), bytes: v.number(), unsized: v.number() }),
    seasons: v.object({ count: v.number(), bytes: v.number() }),
    eligible: v.object({ titles: v.number(), bytes: v.number() }),
    possible: v.number(),
    unknown: v.number(),
  }),
  coverage: v.array(CoverageWire),
  trackingOn: v.boolean(),
  historyStart: isoOrNull,
  unplacedPlays: v.number(),
  arrErrors: v.array(v.object({
    service: v.literal("radarr", "sonarr"),
    instance: v.string(),
    error: v.string(),
    kind: v.optional(v.string()),
  })),
  sizesAsOf: isoOrNull,
  cleanupEnabled: v.boolean(),
  requireUpstreamCheck: v.boolean(),
  rows: v.array(v.union(NwTitleRowWire, NwSeasonRowWire)),
  total: v.int(),
});
export type NwPage = Infer<typeof NwPageWire>;

/** "Check now"'s finished run: each server's read and its self-check. */
export const NwCheckResultWire = v.object({
  servers: v.optional(v.array(v.object({ ok: v.boolean(), health: UPSTREAM_HEALTH }))),
});

// The schemas above ARE the server's row types: a field added to, dropped from
// or retyped in NwTitleRow / NwSeasonRow (or a new upstream health) fails the
// typecheck here instead of being silently dropped by the check.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type NwWireMatchesServer = [
  Assert<Same<Infer<typeof NwTitleRowWire>, NwTitleRow>>,
  Assert<Same<Infer<typeof NwSeasonRowWire>, NwSeasonRow>>,
  Assert<Same<Infer<typeof UPSTREAM_HEALTH>, NwUpstreamHealth>>,
];
