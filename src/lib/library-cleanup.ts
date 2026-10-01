// Library cleanup (Maintainerr-style) — the PURE rule engine. Zero imports, so
// the unit suite, the API routes and the client component can all share it.
//
// The engine never deletes anything. It answers one question per library title:
// "would an admin plausibly want this gone, and is there any reason it must
// stay?" — `matched` lists the enabled rules the title meets, `excludedBy` every
// exclusion that holds it back. A title is a CANDIDATE when at least one rule
// matched and no exclusion applies ("any enabled rule matches, minus
// exclusions"). Deletion itself is a separate, admin-confirmed, two-step action
// (dry run, then execute with the echoed count) in /api/admin/cleanup/delete.
//
// The watch-based rules read play history, which only exists from the moment
// tracking began. A title added before that could have been watched every week
// for years and still show no plays, so a title is only ever judged over the
// window history actually OBSERVED it: from the later of its addedAt and the
// first recorded play anywhere (`observedSince`). With tracking off, or no
// history at all, the watch-based rules never match — an empty table is not
// evidence that nobody watches anything.

export type CleanupMediaType = "MOVIE" | "TV";

export type CleanupRule = "unwatched" | "neverWatched" | "votes";

export type CleanupExclusion =
  | "recentlyAdded"
  | "activeRequest"
  | "recentlyFulfilled"
  | "watchlisted"
  | "playingNow"
  | "airing"
  | "protected";

export const CLEANUP_RULE_LABELS: Record<CleanupRule, string> = {
  unwatched: "Unwatched",
  neverWatched: "Never watched",
  votes: "Deletion votes",
};

export const CLEANUP_EXCLUSION_LABELS: Record<CleanupExclusion, string> = {
  recentlyAdded: "Recently added",
  activeRequest: "Pending or approved request",
  recentlyFulfilled: "Recently fulfilled request",
  watchlisted: "On a watchlist",
  playingNow: "Playing now",
  airing: "Still airing",
  protected: "Protected",
};

export interface CleanupSettings {
  unwatchedEnabled: boolean;
  unwatchedDays: number;
  neverWatchedEnabled: boolean;
  neverWatchedDays: number;
  votesEnabled: boolean;
  votesMin: number;
  // Exclusions. 0 turns a day-based exclusion off.
  minAgeDays: number;
  recentRequestDays: number;
  excludeAiring: boolean;
}

export const CLEANUP_SETTING_DEFAULTS: CleanupSettings = {
  unwatchedEnabled: false,
  unwatchedDays: 365,
  neverWatchedEnabled: false,
  neverWatchedDays: 90,
  votesEnabled: false,
  votesMin: 3,
  minAgeDays: 30,
  recentRequestDays: 30,
  excludeAiring: true,
};

// One Setting row per field, like the watch-grade settings.
export const CLEANUP_SETTING_KEYS: Record<keyof CleanupSettings, string> = {
  unwatchedEnabled: "cleanupUnwatchedEnabled",
  unwatchedDays: "cleanupUnwatchedDays",
  neverWatchedEnabled: "cleanupNeverWatchedEnabled",
  neverWatchedDays: "cleanupNeverWatchedDays",
  votesEnabled: "cleanupVotesEnabled",
  votesMin: "cleanupVotesMin",
  minAgeDays: "cleanupMinAgeDays",
  recentRequestDays: "cleanupRecentRequestDays",
  excludeAiring: "cleanupExcludeAiring",
};

type NumericField = "unwatchedDays" | "neverWatchedDays" | "votesMin" | "minAgeDays" | "recentRequestDays";
type BooleanField = Exclude<keyof CleanupSettings, NumericField>;

export const CLEANUP_NUMERIC_BOUNDS: Record<NumericField, { min: number; max: number }> = {
  unwatchedDays: { min: 1, max: 3650 },
  neverWatchedDays: { min: 1, max: 3650 },
  votesMin: { min: 1, max: 1000 },
  minAgeDays: { min: 0, max: 3650 },
  recentRequestDays: { min: 0, max: 3650 },
};

const BOOLEAN_FIELDS: readonly BooleanField[] = ["unwatchedEnabled", "neverWatchedEnabled", "votesEnabled", "excludeAiring"];
const NUMERIC_FIELDS = Object.keys(CLEANUP_NUMERIC_BOUNDS) as NumericField[];

// Read side: a missing or malformed row falls back to its default, field by field.
export function parseCleanupSettings(raw: Readonly<Record<string, string | null | undefined>>): CleanupSettings {
  const out: CleanupSettings = { ...CLEANUP_SETTING_DEFAULTS };
  for (const f of BOOLEAN_FIELDS) {
    const v = raw[CLEANUP_SETTING_KEYS[f]];
    if (v === "true") out[f] = true;
    else if (v === "false") out[f] = false;
  }
  for (const f of NUMERIC_FIELDS) {
    const v = raw[CLEANUP_SETTING_KEYS[f]];
    if (v == null || !/^\d+$/.test(v.trim())) continue;
    const n = Number(v.trim());
    const { min, max } = CLEANUP_NUMERIC_BOUNDS[f];
    if (Number.isSafeInteger(n) && n >= min && n <= max) out[f] = n;
  }
  return out;
}

// Write side: validates a partial patch keyed by FIELD name and returns the
// Setting rows to write. Strict — unlike the read side it never repairs a bad
// value, it refuses the whole patch.
export function validateCleanupSettingsPatch(
  body: unknown,
): { rows: Array<{ key: string; value: string }> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object" };
  const rows: Array<{ key: string; value: string }> = [];
  for (const [field, value] of Object.entries(body as Record<string, unknown>)) {
    if ((BOOLEAN_FIELDS as readonly string[]).includes(field)) {
      if (typeof value !== "boolean") return { error: `${field} must be a boolean` };
      rows.push({ key: CLEANUP_SETTING_KEYS[field as BooleanField], value: String(value) });
    } else if ((NUMERIC_FIELDS as readonly string[]).includes(field)) {
      const { min, max } = CLEANUP_NUMERIC_BOUNDS[field as NumericField];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return { error: `${field} must be an integer between ${min} and ${max}` };
      }
      rows.push({ key: CLEANUP_SETTING_KEYS[field as NumericField], value: String(value) });
    } else {
      return { error: `Unknown setting: ${field}` };
    }
  }
  if (rows.length === 0) return { error: "Nothing to update" };
  return { rows };
}

export interface CleanupRequestFact {
  status: "PENDING" | "APPROVED" | "DECLINED" | "AVAILABLE";
  availableAt: Date | null;
}

// Everything the engine needs to know about one library title, already
// aggregated across every server and every user.
export interface CleanupTitleFacts {
  tmdbId: number;
  mediaType: CleanupMediaType;
  // Earliest addedAt across every server holding it; null when no server reported one.
  addedAt: Date | null;
  playCount: number;
  lastPlayedAt: Date | null;
  votes: number;
  requests: readonly CleanupRequestFact[];
  watchlisted: boolean;
  playingNow: boolean;
  // null = unknown (no Sonarr entry and no cached TMDB status).
  airing: boolean | null;
  protected: boolean;
}

export interface CleanupContext {
  now: Date;
  // Whether play history tracking is on. Off ⇒ the watch-based rules never match.
  playHistoryTracked: boolean;
  // The earliest recorded play anywhere; null when there is no history at all.
  historyStart: Date | null;
}

export interface CleanupVerdict {
  matched: CleanupRule[];
  excludedBy: CleanupExclusion[];
  candidate: boolean;
  // Start of the window play history observed this title over (see the header).
  observedSince: Date | null;
}

const DAY_MS = 86_400_000;

function maxDate(...dates: Array<Date | null>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

export function evaluateCleanupTitle(
  t: CleanupTitleFacts,
  settings: CleanupSettings,
  ctx: CleanupContext,
): CleanupVerdict {
  const now = ctx.now.getTime();
  const olderThan = (d: Date | null, days: number) => d !== null && now - d.getTime() >= days * DAY_MS;
  const newerThan = (d: Date | null, days: number) => d !== null && now - d.getTime() < days * DAY_MS;

  const watchRulesUsable = ctx.playHistoryTracked && ctx.historyStart !== null;
  // A title whose age is unknown has no observable window — the watch rules can't prove anything about it.
  const observedSince = watchRulesUsable && t.addedAt ? maxDate(t.addedAt, ctx.historyStart) : null;

  const matched: CleanupRule[] = [];
  if (settings.unwatchedEnabled && observedSince) {
    // The last thing that happened to this title: its last play, or (never
    // played) the start of the window history watched it over.
    if (olderThan(maxDate(t.lastPlayedAt, observedSince), settings.unwatchedDays)) matched.push("unwatched");
  }
  if (settings.neverWatchedEnabled && observedSince && t.playCount === 0) {
    if (olderThan(observedSince, settings.neverWatchedDays)) matched.push("neverWatched");
  }
  if (settings.votesEnabled && t.votes >= settings.votesMin) matched.push("votes");

  const excludedBy: CleanupExclusion[] = [];
  if (settings.minAgeDays > 0 && newerThan(t.addedAt, settings.minAgeDays)) excludedBy.push("recentlyAdded");
  if (t.requests.some((r) => r.status === "PENDING" || r.status === "APPROVED")) excludedBy.push("activeRequest");
  if (
    settings.recentRequestDays > 0 &&
    t.requests.some((r) => r.status === "AVAILABLE" && newerThan(r.availableAt, settings.recentRequestDays))
  ) {
    excludedBy.push("recentlyFulfilled");
  }
  if (t.watchlisted) excludedBy.push("watchlisted");
  if (t.playingNow) excludedBy.push("playingNow");
  if (settings.excludeAiring && t.mediaType === "TV" && t.airing === true) excludedBy.push("airing");
  if (t.protected) excludedBy.push("protected");

  return { matched, excludedBy, candidate: matched.length > 0 && excludedBy.length === 0, observedSince };
}

// TMDB's own words for a show that is still being made. "Ended" and "Canceled"
// are the finished states; anything else that names production counts as airing.
const TMDB_AIRING_STATUSES = new Set(["Returning Series", "In Production", "Planned", "Pilot"]);

export function tmdbStatusIsAiring(status: unknown, inProduction: unknown): boolean | null {
  if (inProduction === true) return true;
  if (typeof status !== "string" || status.length === 0) return inProduction === false ? false : null;
  return TMDB_AIRING_STATUSES.has(status);
}

// Sonarr's series status: "continuing" | "upcoming" | "ended" | "deleted".
export function sonarrStatusIsAiring(status: unknown): boolean | null {
  if (status === "continuing" || status === "upcoming") return true;
  if (status === "ended" || status === "deleted") return false;
  return null;
}

export function cleanupKey(tmdbId: number, mediaType: string): string {
  return `${mediaType}:${tmdbId}`;
}
