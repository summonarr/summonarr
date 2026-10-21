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
// The watch-based rules read the never-watched VERDICT (never-watched.ts,
// guardrail 14d) — one definition shared with the never-watched report and the
// delete route's re-judgement, never a private copy. It judges a title only over
// the window play history demonstrably OBSERVED it — every server holding it
// recorded and with history, from the later of its arrival and the last of
// those servers' recording start — and counts every piece of evidence that it
// was played (any user, any server, by tmdb id, item key, show key, or the media
// server's own records). With tracking off, a holder untracked, or nothing
// recorded, the watch-based rules never match: an empty table is not evidence
// that nobody watches anything.

import type { Translator } from "./i18n/translate";
import { idleAnchor, isNeverWatchedState, type NwEvidence, type NwVerdict } from "./never-watched";

export type CleanupMediaType = "MOVIE" | "TV";

export type CleanupRule = "unwatched" | "neverWatched" | "votes";

export type CleanupExclusion =
  | "recentlyAdded"
  | "activeRequest"
  | "recentlyFulfilled"
  | "watchlisted"
  | "playingNow"
  | "airing"
  | "protected"
  // A holding server's own watch records weren't checked (successfully and
  // recently), so a play Summonarr never saw can't be ruled out.
  | "upstreamUnchecked";

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
  upstreamUnchecked: "Server history not checked",
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
  // Hold back watch-rule candidates until every holding server's own watch
  // records have been checked (the upstreamUnchecked exclusion).
  requireUpstreamCheck: boolean;
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
  requireUpstreamCheck: true,
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
  requireUpstreamCheck: "cleanupRequireUpstreamCheck",
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

const BOOLEAN_FIELDS: readonly BooleanField[] = ["unwatchedEnabled", "neverWatchedEnabled", "votesEnabled", "excludeAiring", "requireUpstreamCheck"];
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
  t?: Translator,
): { rows: Array<{ key: string; value: string }> } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: t ? t("apiAdmin.cleanup.bodyObject") : "Body must be an object" };
  }
  const rows: Array<{ key: string; value: string }> = [];
  for (const [field, value] of Object.entries(body as Record<string, unknown>)) {
    if ((BOOLEAN_FIELDS as readonly string[]).includes(field)) {
      if (typeof value !== "boolean") return { error: t ? t("apiAdmin.cleanup.fieldBoolean", { field }) : `${field} must be a boolean` };
      rows.push({ key: CLEANUP_SETTING_KEYS[field as BooleanField], value: String(value) });
    } else if ((NUMERIC_FIELDS as readonly string[]).includes(field)) {
      const { min, max } = CLEANUP_NUMERIC_BOUNDS[field as NumericField];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return { error: t ? t("apiAdmin.cleanup.fieldRange", { field, min, max }) : `${field} must be an integer between ${min} and ${max}` };
      }
      rows.push({ key: CLEANUP_SETTING_KEYS[field as NumericField], value: String(value) });
    } else {
      return { error: t ? t("apiAdmin.cleanup.unknownSetting", { field }) : `Unknown setting: ${field}` };
    }
  }
  if (rows.length === 0) return { error: t ? t("apiAdmin.cleanup.nothingToUpdate") : "Nothing to update" };
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
  // Hard evidence (display): plays and the latest dated one.
  playCount: number;
  lastPlayedAt: Date | null;
  // The never-watched verdict and the evidence behind it — what the watch rules judge.
  watch: NwVerdict;
  evidence: NwEvidence;
  // Holding servers whose own watch records weren't checked (successfully, recently).
  upstreamUnchecked: readonly string[];
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
}

export interface CleanupVerdict {
  matched: CleanupRule[];
  excludedBy: CleanupExclusion[];
  candidate: boolean;
  // Start of the window play history observed this title over (see the header).
  observedSince: Date | null;
}

const DAY_MS = 86_400_000;

export function evaluateCleanupTitle(
  t: CleanupTitleFacts,
  settings: CleanupSettings,
  ctx: CleanupContext,
): CleanupVerdict {
  const now = ctx.now.getTime();
  const olderThan = (d: Date | null, days: number) => d !== null && now - d.getTime() >= days * DAY_MS;
  const newerThan = (d: Date | null, days: number) => d !== null && now - d.getTime() < days * DAY_MS;

  // An unobservable title has no window — the watch rules can't prove anything about it.
  const observedSince = t.watch.state === "unobservable" ? null : t.watch.windowStart;

  const matched: CleanupRule[] = [];
  if (settings.unwatchedEnabled) {
    // The last thing that happened to this title: its last play (soft plays
    // included), or — never played — the start of the window history watched it
    // over. Null when it can't be measured (unobservable, or an undated play).
    const anchor = idleAnchor(t.watch, t.evidence);
    if (olderThan(anchor, settings.unwatchedDays)) matched.push("unwatched");
  }
  if (settings.neverWatchedEnabled && isNeverWatchedState(t.watch.state)) {
    if (olderThan(t.watch.windowStart, settings.neverWatchedDays)) matched.push("neverWatched");
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
  // Only a WATCH rule rests on "no plays"; the votes rule is the users' own call
  // and needs no upstream check.
  if (settings.requireUpstreamCheck && t.upstreamUnchecked.length > 0 && !matched.includes("votes")) {
    excludedBy.push("upstreamUnchecked");
  }

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

// The most titles one cleanup delete takes — dry run and execute alike. ONE
// definition: the route refuses a longer list (parseCleanupItems), and both
// pages that build a selection for it (Library cleanup, Never watched) stop
// adding at it, so "Delete selected" never offers a request that can only 400.
export const CLEANUP_MAX_ITEMS = 500;

// The delete route's body `items`: 1–CLEANUP_MAX_ITEMS `{ tmdbId, mediaType }`,
// duplicates dropped. `null` for anything else (the route answers 400).
export function parseCleanupItems(raw: unknown): Array<{ tmdbId: number; mediaType: CleanupMediaType }> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CLEANUP_MAX_ITEMS) return null;
  const seen = new Set<string>();
  const out: Array<{ tmdbId: number; mediaType: CleanupMediaType }> = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") return null;
    const { tmdbId, mediaType } = it as { tmdbId?: unknown; mediaType?: unknown };
    if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    if (mediaType !== "MOVIE" && mediaType !== "TV") return null;
    const key = cleanupKey(tmdbId, mediaType);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tmdbId, mediaType });
  }
  return out;
}

// A page's selection, kept within CLEANUP_MAX_ITEMS. `toggleCleanupSelection`
// ticks or unticks one key (a tick past the cap is ignored);
// `cleanupSelectAllOn` is what the select-all box shows — every key ticked, or
// the selection full with some of them in it (so the next click clears instead
// of doing nothing); `toggleAllCleanupSelection` clears those keys when it is
// on and otherwise adds them in order, up to the cap.
export function toggleCleanupSelection(prev: ReadonlySet<string>, key: string, max = CLEANUP_MAX_ITEMS): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else if (next.size < max) next.add(key);
  return next;
}

export function cleanupSelectAllOn(selected: ReadonlySet<string>, keys: readonly string[], max = CLEANUP_MAX_ITEMS): boolean {
  if (keys.length === 0) return false;
  if (keys.every((k) => selected.has(k))) return true;
  return selected.size >= max && keys.some((k) => selected.has(k));
}

export function toggleAllCleanupSelection(prev: ReadonlySet<string>, keys: readonly string[], max = CLEANUP_MAX_ITEMS): Set<string> {
  const next = new Set(prev);
  if (cleanupSelectAllOn(prev, keys, max)) {
    for (const k of keys) next.delete(k);
    return next;
  }
  for (const k of keys) {
    if (next.size >= max) break;
    next.add(k);
  }
  return next;
}
