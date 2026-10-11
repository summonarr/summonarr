// "Never watched" — the PURE verdict (guardrail 14d). Zero imports, so the unit
// suite, the cleanup rule engine, the API routes and client components can all
// share ONE definition. The report, the cleanup `neverWatched`/`unwatched` rules,
// the delete route's re-judgement and the detail-page chip all go through here;
// a second, private copy of any of this is how the view and the delete drift.
//
// The list is used to DELETE media, so the failure that matters is a false
// "never watched". Every rule below leans the safe way:
//
// - EVIDENCE is a union and is never filtered: a play from any source, any
//   server, any user (deactivated, departed, admin), watched-flagged or not,
//   counts. Hard evidence (a recorded play attributed to the title by tmdb id,
//   by the movie's own item key, or by the show's key; a session playing now; the
//   media server's own watch record) makes a title WATCHED. Soft evidence — an
//   unattributed play whose title merely matches — makes it POSSIBLY watched,
//   which is never eligible.
// - The WINDOW a claim is made over is honest. A title is only judged when every
//   server holding it is being recorded and has history; the claim starts at the
//   LATER of when the title arrived (the earliest date anything recorded for it)
//   and when the last of its servers began recording. A media server's own
//   "added" date resets on a re-add or an upgrade, so it is never trusted to make
//   a claim LONGER — only the earliest of every source is used as the arrival,
//   and the window can only start at or after every holder's recording start.
// - Retention purges move the earliest recorded play forward, which moves the
//   window start forward with them: "never watched since <date>" stays true.

export type NwSource = "plex" | "jellyfin";
export type NwMediaType = "MOVIE" | "TV";

export const NW_DAY_MS = 86_400_000;

// A server holding a title: its label (mediaInstanceLabel — "plex",
// "jellyfin:remote", …) and its source.
export interface NwHolder {
  server: string;
  source: NwSource;
}

// What play-history recording looks like on one server.
export interface NwCoverage {
  server: string;
  source: NwSource;
  // The per-source tracking switch (the global switch is NwContext.trackingOn).
  tracked: boolean;
  // When recording demonstrably covers this server from: the later of its
  // earliest surviving recorded play and the moment its source's tracking was
  // last switched on. Null = tracked but nothing recorded yet.
  since: Date | null;
}

export interface NwContext {
  now: Date;
  trackingOn: boolean;
  coverage: ReadonlyMap<string, NwCoverage>;
}

// Everything known about plays of one title (or one season), already resolved
// to it by the data layer.
export interface NwEvidence {
  // Hard evidence: attributed plays, sessions playing now, upstream records.
  plays: number;
  // The latest DATED hard play.
  lastPlayedAt: Date | null;
  // Some hard evidence has no date (an upstream "played" flag with no
  // LastPlayedDate). Watched either way; the idle-time rule can't use it.
  undated: boolean;
  // Soft evidence: unattributed plays whose title matches, on a holding server.
  softPlays: number;
  softLastPlayedAt: Date | null;
  softServers: string[];
}

export const EMPTY_EVIDENCE: NwEvidence = {
  plays: 0,
  lastPlayedAt: null,
  undated: false,
  softPlays: 0,
  softLastPlayedAt: null,
  softServers: [],
};

export type NwState = "watched" | "unobservable" | "possiblyWatched" | "neverWatched" | "noPlaysSince";

// Why a title can't be judged.
export type NwReason =
  | "trackingOff" // the global play-history switch is off
  | "sourceUntracked" // a holding server's source isn't recorded
  | "noHistory" // a holding server has recorded nothing yet
  | "addedUnknown"; // nothing says when the title arrived

export const NW_STATES: readonly NwState[] = ["neverWatched", "noPlaysSince", "possiblyWatched", "unobservable", "watched"];
export const NW_REASONS: readonly NwReason[] = ["trackingOff", "sourceUntracked", "noHistory", "addedUnknown"];

export interface NwVerdict {
  state: NwState;
  reason: NwReason | null;
  // The servers the reason names (untracked / no history).
  reasonServers: string[];
  // Start of the window the claim is made over; null when unobservable.
  windowStart: Date | null;
  // When the title arrived (earliest known).
  shelfStart: Date | null;
  // Whole days from windowStart to now.
  days: number | null;
  // shelfStart is at or after every holder's recording start: the title has
  // been observed for its whole time on the shelf ("never watched since added").
  fullyObserved: boolean;
}

// Both "never" states are "never watched in this server's recorded history";
// they differ only in whether the title predates recording.
export function isNeverWatchedState(state: NwState): boolean {
  return state === "neverWatched" || state === "noPlaysSince";
}

export function earliestDate(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d < best)) best = d;
  return best;
}

export function latestDate(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

function wholeDays(now: Date, since: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / NW_DAY_MS));
}

interface NwWindow {
  start: Date | null;
  reason: NwReason | null;
  reasonServers: string[];
  fullyObserved: boolean;
}

// The window a "no plays" claim can honestly be made over, or why there is none.
// INTERSECTION across holders, never a union: every server holding the title must
// be recorded and have history, and the window opens only once the LAST of them
// started recording — a play on any holder before that could have gone unseen.
export function observedWindow(holders: readonly NwHolder[], shelfStart: Date | null, ctx: NwContext): NwWindow {
  const none = (reason: NwReason, reasonServers: string[] = []): NwWindow =>
    ({ start: null, reason, reasonServers, fullyObserved: false });
  if (!ctx.trackingOn) return none("trackingOff");
  if (holders.length === 0) return none("addedUnknown");

  const untracked = holders.filter((h) => !ctx.coverage.get(h.server)?.tracked).map((h) => h.server);
  if (untracked.length > 0) return none("sourceUntracked", [...new Set(untracked)].sort());

  const coverageStarts: Date[] = [];
  const noHistory: string[] = [];
  for (const h of holders) {
    const since = ctx.coverage.get(h.server)?.since ?? null;
    if (since) coverageStarts.push(since);
    else noHistory.push(h.server);
  }
  if (noHistory.length > 0) return none("noHistory", [...new Set(noHistory)].sort());
  if (!shelfStart) return none("addedUnknown");

  const lastCoverageStart = latestDate(...coverageStarts)!;
  const start = latestDate(shelfStart, lastCoverageStart)!;
  return { start, reason: null, reasonServers: [], fullyObserved: shelfStart.getTime() >= lastCoverageStart.getTime() };
}

export function judgeTitle(
  holders: readonly NwHolder[],
  shelfStart: Date | null,
  ev: NwEvidence,
  ctx: NwContext,
): NwVerdict {
  const w = observedWindow(holders, shelfStart, ctx);
  const base = {
    reason: w.reason,
    reasonServers: w.reasonServers,
    windowStart: w.start,
    shelfStart,
    days: w.start ? wholeDays(ctx.now, w.start) : null,
    fullyObserved: w.fullyObserved,
  };
  // Hard evidence wins over everything, from anywhere — even a server that isn't
  // being recorded proves the title was watched.
  if (ev.plays > 0) return { ...base, state: "watched", reason: null, reasonServers: [] };
  if (w.reason) return { ...base, state: "unobservable" };
  if (ev.softPlays > 0) return { ...base, state: "possiblyWatched" };
  return { ...base, state: w.fullyObserved ? "neverWatched" : "noPlaysSince" };
}

// When the title was last known to be in use, for the idle-time ("unwatched N
// days") rule: the latest dated play, soft plays included, or the window start
// when there are none. Null when it can't be measured — the title is
// unobservable, or some evidence carries no date (it could be yesterday).
export function idleAnchor(v: NwVerdict, ev: NwEvidence): Date | null {
  if (v.state === "unobservable" || !v.windowStart) return null;
  if (ev.undated) return null;
  return latestDate(ev.lastPlayedAt, ev.softLastPlayedAt, v.windowStart);
}

// ── Seasons ─────────────────────────────────────────────────────────────────

export interface NwSeasonFacts {
  seasonNumber: number;
  // Distinct episodes the media servers hold for this season.
  episodes: number;
  // Earliest / newest episode arrival. Null when any episode has no date.
  firstAddedAt: Date | null;
  lastAddedAt: Date | null;
}

export interface NwSeasonVerdict extends NwVerdict {
  seasonNumber: number;
  episodes: number;
}

// A season of a show that HAS been watched (a never-watched show is reported as a
// whole, never season by season — so nothing is counted twice). Its window opens
// at its first episode's arrival; its age counts from its NEWEST episode, so a
// season still gaining episodes never looks older than its latest addition.
export function judgeSeason(
  holders: readonly NwHolder[],
  season: NwSeasonFacts,
  ev: NwEvidence,
  ctx: NwContext,
): NwSeasonVerdict {
  const v = judgeTitle(holders, season.firstAddedAt, ev, ctx);
  const ageFrom = latestDate(v.windowStart, season.lastAddedAt);
  return {
    ...v,
    days: v.windowStart && ageFrom ? wholeDays(ctx.now, ageFrom) : null,
    seasonNumber: season.seasonNumber,
    episodes: season.episodes,
  };
}

export interface NwArrSeasonStat {
  seasonNumber: number;
  sizeOnDisk: number;
  episodeFileCount: number;
}

// A season's size from Radarr/Sonarr — only when the arr and the media server
// agree what the season IS. Sonarr numbers seasons by TVDB order and the media
// server by its own (often the same, not always — anime absolute order, DVD vs
// aired); a size attached across a numbering mismatch is another season's size.
// Agreement = every instance holding files for that season has exactly as many
// episode files as the library has episodes. Instances (HD + 4K) are separate
// files, so their sizes add.
export function seasonSizeIfAgreed(
  perInstance: ReadonlyArray<readonly NwArrSeasonStat[]>,
  seasonNumber: number,
  libraryEpisodes: number,
): { bytes: number | null; mismatch: boolean } {
  let total = 0;
  for (const seasons of perInstance) {
    const s = seasons.find((x) => x.seasonNumber === seasonNumber);
    if (!s || s.sizeOnDisk <= 0) continue;
    if (s.episodeFileCount !== libraryEpisodes) return { bytes: null, mismatch: true };
    total += s.sizeOnDisk;
  }
  return { bytes: total > 0 ? total : null, mismatch: false };
}

// ── Unattributed plays ─────────────────────────────────────────────────────

// The comparison key for matching an unattributed play's title to a library
// title. Deliberately plain (trim + lower-case): a looser match only widens
// "possibly watched", and a stricter one would let a real play slip through.
export function normalizeTitleKey(title: string | null | undefined): string {
  return (title ?? "").trim().toLowerCase();
}

// ── Upstream (the media server's own watch records) ────────────────────────

export type NwUpstreamHealth = "ok" | "unreliable" | "failed" | "stale" | "never";

export interface NwUpstreamStatus {
  fetchedAt: string | null; // last SUCCESSFUL fetch (ISO)
  attemptedAt: string | null; // last attempt (ISO)
  ok: boolean; // the last attempt succeeded
  entries: number; // records the server returned
  matched: number; // of those, how many resolved to a library title
  samples: number; // titles Summonarr itself recorded as played in the snapshot's span
  agreed: number; // of those, how many the server also reports
  error: string | null;
}

// Below this many samples the agreement ratio says nothing.
export const UPSTREAM_MIN_SAMPLES = 20;
export const UPSTREAM_MIN_AGREEMENT = 0.5;
// A snapshot older than this no longer counts as a check.
export const UPSTREAM_MAX_AGE_MS = 7 * NW_DAY_MS;

export function upstreamHealth(status: NwUpstreamStatus | null, now: Date): NwUpstreamHealth {
  if (!status || !status.fetchedAt) return "never";
  if (!status.ok) return "failed";
  // A parser that understands nothing it is handed is broken, not "no plays".
  if (status.entries > 0 && status.matched === 0) return "failed";
  if (status.samples >= UPSTREAM_MIN_SAMPLES && status.agreed / status.samples < UPSTREAM_MIN_AGREEMENT) return "unreliable";
  if (now.getTime() - new Date(status.fetchedAt).getTime() > UPSTREAM_MAX_AGE_MS) return "stale";
  return "ok";
}

// ── Tracking stamps ────────────────────────────────────────────────────────

// Each tracking switch → the Setting that records when it was last turned ON.
// A play while a switch was off was never recorded, so recording can only be
// trusted from the moment it came back on (NwCoverage.since).
export const TRACKING_STAMP_KEYS: Readonly<Record<string, string>> = {
  playHistoryEnabled: "playHistoryTrackedSince",
  playHistoryPlexEnabled: "playHistoryPlexTrackedSince",
  playHistoryJellyfinEnabled: "playHistoryJellyfinTrackedSince",
};

// The stamps a settings write must record: every tracking switch going from
// anything-but-"true" to "true".
export function trackingStampsFor(
  writes: ReadonlyArray<readonly [string, string]>,
  before: ReadonlyMap<string, string | null>,
  now: Date,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of writes) {
    const stamp = TRACKING_STAMP_KEYS[key];
    if (!stamp || value !== "true" || before.get(key) === "true") continue;
    out.push([stamp, now.toISOString()]);
  }
  return out;
}

export function parseStampDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ── Report query ───────────────────────────────────────────────────────────

export type NwLevel = "title" | "season";
export type NwStateFilter = "never" | "possible" | "unknown" | "all";
export type NwSortKey = "size" | "days" | "since" | "added" | "title";

export const NW_SORT_KEYS: readonly NwSortKey[] = ["size", "days", "since", "added", "title"];
export const NW_PAGE_DEFAULT = 50;
export const NW_PAGE_MAX = 200;

export interface NwQuery {
  level: NwLevel;
  state: NwStateFilter;
  type: "all" | "movie" | "tv";
  q: string;
  eligibleOnly: boolean;
  sortBy: NwSortKey;
  sortDir: "asc" | "desc";
  page: number;
  limit: number;
}

// Every parameter is whitelisted; anything else falls back to the default.
export function parseNwQuery(params: { get(name: string): string | null }): NwQuery {
  const pick = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T =>
    raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const int = (raw: string | null, fallback: number, min: number, max: number) => {
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const sortBy = pick(params.get("sortBy"), NW_SORT_KEYS, "size");
  return {
    level: pick(params.get("level"), ["title", "season"] as const, "title"),
    state: pick(params.get("state"), ["never", "possible", "unknown", "all"] as const, "never"),
    type: pick(params.get("type"), ["all", "movie", "tv"] as const, "all"),
    q: (params.get("q") ?? "").trim().slice(0, 100),
    eligibleOnly: params.get("eligible") === "1",
    sortBy,
    // Title sorts A→Z by default; everything else biggest/oldest first.
    sortDir: pick(params.get("sortDir"), ["asc", "desc"] as const, sortBy === "title" ? "asc" : "desc"),
    page: int(params.get("page"), 1, 1, 100_000),
    limit: int(params.get("limit"), NW_PAGE_DEFAULT, 1, NW_PAGE_MAX),
  };
}

export function stateMatchesFilter(state: NwState, filter: NwStateFilter): boolean {
  switch (filter) {
    case "never": return isNeverWatchedState(state);
    case "possible": return state === "possiblyWatched";
    case "unknown": return state === "unobservable";
    case "all": return state !== "watched";
  }
}
