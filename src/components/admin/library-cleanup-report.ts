// GET /api/admin/cleanup — the Library cleanup page's report, as the page
// reads it: checked against this shape (src/lib/validate.ts) before anything
// dereferences it, so a body of another shape (an error page with a 200, a
// half-deployed server) reads as "couldn't load" instead of throwing inside
// the load and being reported as a network error.
//
// The rule and exclusion names are the closed sets from library-cleanup.ts:
// the page and the route ship together, and an unknown one would render as a
// raw catalog key.
import { CLEANUP_EXCLUSIONS, CLEANUP_RULES } from "@/lib/library-cleanup";
import { v, type Infer } from "@/lib/validate";

const MEDIA_TYPE = v.literal("MOVIE", "TV");
const RULE = v.literal(...CLEANUP_RULES);
const EXCLUSION = v.literal(...CLEANUP_EXCLUSIONS);

const SettingsSchema = v.object({
  unwatchedEnabled: v.boolean(),
  unwatchedDays: v.number(),
  neverWatchedEnabled: v.boolean(),
  neverWatchedDays: v.number(),
  votesEnabled: v.boolean(),
  votesMin: v.number(),
  minAgeDays: v.number(),
  recentRequestDays: v.number(),
  excludeAiring: v.boolean(),
  requireUpstreamCheck: v.boolean(),
});

const RowSchema = v.object({
  tmdbId: v.int(),
  mediaType: MEDIA_TYPE,
  title: v.string(),
  posterPath: v.nullable(v.string()),
  year: v.nullable(v.string()),
  servers: v.array(v.string()),
  addedAt: v.nullable(v.string()),
  lastPlayedAt: v.nullable(v.string()),
  playCount: v.number(),
  votes: v.number(),
  idleDays: v.nullable(v.number()),
  arr: v.array(v.object({ service: v.literal("radarr", "sonarr"), instance: v.string(), sizeOnDisk: v.number() })),
  sizeOnDisk: v.nullable(v.number()),
  matched: v.array(RULE),
  excludedBy: v.array(EXCLUSION),
  candidate: v.boolean(),
});

const ProtectedSchema = v.object({
  tmdbId: v.int(),
  mediaType: MEDIA_TYPE,
  title: v.nullable(v.string()),
  reason: v.nullable(v.string()),
  createdAt: v.string(),
});

export const CleanupReportSchema = v.object({
  settings: SettingsSchema,
  playHistoryTracked: v.boolean(),
  historyStart: v.nullable(v.string()),
  rows: v.array(RowSchema),
  libraryTitles: v.number(),
  arrErrors: v.array(v.object({ service: v.string(), instance: v.string(), error: v.string(), kind: v.optional(v.string()) })),
  // The most recent protections only; `protectedTotal` counts all of them.
  protected: v.array(ProtectedSchema),
  // Absent from an older server.
  protectedTotal: v.optional(v.number()),
  totals: v.object({ candidates: v.number(), held: v.number(), reclaimableBytes: v.number() }),
});

export type CleanupReportView = Infer<typeof CleanupReportSchema>;
export type CleanupReportRow = CleanupReportView["rows"][number];
export type CleanupProtectedTitle = CleanupReportView["protected"][number];

// A rule's number field, as typed. Cleared, it stays empty while the admin
// retypes: the draft holds NaN, which no bound accepts (cleanupNumberInBounds
// wants an integer), so the field is marked and Save stays off — never a
// silent 0 in front of the caret that a save would keep.
export function parseRuleNumber(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Math.trunc(Number(raw));
}

/** What a rule's number field shows: the draft's value, or nothing while it is cleared. */
export function ruleNumberText(value: number): number | "" {
  return Number.isNaN(value) ? "" : value;
}

/** How many selected titles the current filters hide — a delete still takes them. */
export function selectedOutsideView(selected: ReadonlySet<string>, visibleKeys: ReadonlySet<string>): number {
  let n = 0;
  for (const k of selected) if (!visibleKeys.has(k)) n++;
  return n;
}
