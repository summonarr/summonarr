// Request watch grades — do the people who request media actually watch it?
//
// Each user gets an A–F letter from the share of their FULFILLED requests they
// went on to watch. The grade is DISPLAY-ONLY by product decision: it is shown to
// admins (Users page, request queue) and nothing reads it to gate a request, a
// quota or auto-approve. Wiring it into enforcement is a separate decision, not
// a refactor.
//
// Pure, ZERO-import leaf (the sonarr-completion.ts / permissions.ts shape): the
// admin client components import the types and labels from here, and the whole
// rule set is pinned by tests/watch-grade.test.mts without a database. The prisma
// half — which requests, whose plays, how many episodes — is watch-grade-data.ts.
//
// The rules, in one place:
//   - Only AVAILABLE requests are graded, and a request is SCORED only once its
//     grace period since fulfilment has elapsed. Requests inside the grace period
//     are listed but never scored — not even the ones already watched. Counting a
//     prompt watch early while an unwatched sibling waits would bias every
//     recent requester upward; the score only ever averages matured requests.
//   - A request fulfilled before play history covered the user's media servers
//     is "untracked" and never scored: a watch from before tracking began is
//     invisible, and reading that silence as "never watched" is a false F.
//   - Only plays that started at or after the request count. A title watched
//     before it was requested (a re-request after removal, an HD copy watched
//     before asking for 4K) is not evidence the REQUEST was used.
//   - Movie: full credit when watched (a play flagged watched/completed, or the
//     plays since the request adding up to the watched threshold — chunked
//     viewing counts); half credit when meaningfully started; else zero.
//   - TV: credit = episodes watched ÷ the required share of the show's REGULAR-
//     season episodes in the library (specials excluded, as guardrail 14a does),
//     capped at 1. A started-but-unfinished episode counts as half an episode.
//   - A user with no linked media-server identity cannot be graded, and neither
//     can one whose media servers are not being tracked — both say so explicitly
//     rather than rendering an F for data that was never collected.

export type WatchGradeLetter = "A" | "B" | "C" | "D" | "F";

// Minimum score (0–100, rounded) for each letter, best first.
export const WATCH_GRADE_BANDS: ReadonlyArray<{ letter: WatchGradeLetter; min: number }> = [
  { letter: "A", min: 80 },
  { letter: "B", min: 60 },
  { letter: "C", min: 40 },
  { letter: "D", min: 20 },
  { letter: "F", min: 0 },
];

// Scored requests needed before a letter is assigned. Below it the watch rate is
// still reported, but one unwatched film must not stamp a new requester an F.
export const MIN_GRADED_REQUESTS = 3;

// A play below the watched threshold still earns partial credit once it ran long
// enough to be a real attempt rather than a mis-click: 5 minutes, or a quarter of
// the runtime for anything shorter than 20 minutes.
export const STARTED_MIN_SECONDS = 300;
export const STARTED_MIN_FRACTION = 0.25;

const DAY_MS = 86_400_000;

// ── Settings ────────────────────────────────────────────────────────────────

export interface WatchGradeSettings {
  // Days after fulfilment before a request counts toward the grade.
  graceDays: number;
  // Only requests fulfilled within this many days are graded. 0 = no limit.
  windowDays: number;
  // Share of a show's library episodes that must be watched for full credit.
  tvEpisodePercent: number;
}

export const WATCH_GRADE_DEFAULTS: WatchGradeSettings = {
  graceDays: 30,
  windowDays: 365,
  tvEpisodePercent: 50,
};

export const WATCH_GRADE_SETTING_KEYS = {
  graceDays: "watchGradeGraceDays",
  windowDays: "watchGradeWindowDays",
  tvEpisodePercent: "watchGradeTvPercent",
} as const;

// One table serves the write-side validator (/api/settings) and the read-side
// parser, so a value the settings route accepts can never be clamped into
// something else on read. windowDays additionally accepts 0 ("no limit").
const SETTING_BOUNDS: Record<keyof WatchGradeSettings, { min: number; max: number; allowZero: boolean }> = {
  graceDays: { min: 1, max: 365, allowZero: false },
  windowDays: { min: 30, max: 3650, allowZero: true },
  tvEpisodePercent: { min: 1, max: 100, allowZero: false },
};

function fieldForKey(key: string): keyof WatchGradeSettings | null {
  for (const field of Object.keys(WATCH_GRADE_SETTING_KEYS) as (keyof WatchGradeSettings)[]) {
    if (WATCH_GRADE_SETTING_KEYS[field] === key) return field;
  }
  return null;
}

function parseBounded(value: string | null | undefined, field: keyof WatchGradeSettings): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const n = Number.parseInt(value.trim(), 10);
  const b = SETTING_BOUNDS[field];
  if (n === 0 && b.allowZero) return 0;
  return n >= b.min && n <= b.max ? n : null;
}

// Validation message for a watch-grade Setting write, or null when the value is
// acceptable (or the key isn't a watch-grade key at all).
export function watchGradeSettingError(key: string, value: string): string | null {
  const field = fieldForKey(key);
  if (!field) return null;
  if (parseBounded(value, field) !== null) return null;
  const b = SETTING_BOUNDS[field];
  return `"${key}" must be an integer between ${b.min} and ${b.max}${b.allowZero ? ", or 0 for no limit" : ""}`;
}

// Read-side parse: a missing or out-of-range row falls back to the default rather
// than to NaN or an unbounded window.
export function parseWatchGradeSettings(raw: Record<string, string | null | undefined>): WatchGradeSettings {
  const out = { ...WATCH_GRADE_DEFAULTS };
  for (const field of Object.keys(WATCH_GRADE_SETTING_KEYS) as (keyof WatchGradeSettings)[]) {
    const parsed = parseBounded(raw[WATCH_GRADE_SETTING_KEYS[field]], field);
    if (parsed !== null) out[field] = parsed;
  }
  return out;
}

// ── Grading ─────────────────────────────────────────────────────────────────

export interface GradableRequest {
  id: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  releaseYear: string | null;
  posterPath: string | null;
  createdAt: Date;
  // When the request was fulfilled: MediaRequest.availableAt, or updatedAt for a
  // legacy AVAILABLE row that predates the column. updatedAt is never earlier
  // than the real fulfilment, so the fallback can only delay scoring.
  fulfilledAt: Date;
}

// The requester's plays of one requested title since the request, aggregated per
// (season, episode) — movies arrive as a single (null, null) unit.
export interface RequestPlayUnit {
  requestId: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  // Any play flagged watched or completed by the play-history finalizer.
  anyWatched: boolean;
  // Summed PlayHistory.playDuration across those plays.
  playSeconds: number;
  // Longest reported runtime across those plays (0 when unknown).
  durationSeconds: number;
}

export type WatchGradeIdentity =
  // No media-server identity links to the account: nothing it watches is visible.
  | { kind: "unlinked" }
  // Linked, but only through media servers whose play history isn't tracked.
  | { kind: "untracked" }
  // Watches are observable. coverageStart is when play history began covering
  // every tracked server the user is on (null: nothing recorded yet).
  | { kind: "tracked"; coverageStart: Date | null };

export interface GradeUserInput {
  requests: GradableRequest[];
  units: RequestPlayUnit[];
  // tmdbId → regular-season episodes in the library, for the TV requests.
  libraryEpisodes: ReadonlyMap<number, number>;
  identity: WatchGradeIdentity;
  // Play-history "watched" threshold (percent), reused for summed plays.
  watchedThresholdPercent: number;
  settings: WatchGradeSettings;
  now: Date;
}

export type WatchState = "watched" | "partial" | "unwatched";
export type ScoringState = "scored" | "grace" | "untracked";

export interface EpisodeProgress {
  watched: number;
  started: number;
  // Regular-season episodes in the library. 0 = unknown, in which case one
  // watched episode is enough.
  library: number;
  required: number;
}

export interface RequestWatchVerdict {
  requestId: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  releaseYear: string | null;
  posterPath: string | null;
  requestedAt: string;
  fulfilledAt: string;
  // null when the user's watches can't be observed at all (unlinked/untracked).
  watch: WatchState | null;
  // 0–1, two decimals.
  credit: number;
  scoring: ScoringState;
  // Whole days until a grace-period request starts counting; null otherwise.
  graceDaysLeft: number | null;
  episodes: EpisodeProgress | null;
}

export type WatchGradeStatus = "graded" | "insufficient" | "unlinked" | "untracked";

export interface WatchGradeSummary {
  status: WatchGradeStatus;
  letter: WatchGradeLetter | null;
  // 0–100 watch rate over the scored requests; null when nothing was scored.
  score: number | null;
  // Scored requests, and how they split.
  graded: number;
  watched: number;
  partial: number;
  unwatched: number;
  // Fulfilled requests that aren't scored (yet).
  inGrace: number;
  untracked: number;
}

export interface UserWatchGrade {
  summary: WatchGradeSummary;
  // Newest fulfilment first.
  verdicts: RequestWatchVerdict[];
}

// Wire shape of GET /api/admin/users/[id]/watch-grade. Lives in this leaf (not
// beside its producer in watch-grade-data.ts) so the client modal can type the
// response without reaching into a prisma-importing module.
export interface WatchGradeDetail {
  enabled: boolean;
  reason: "feature-off" | "tracking-off" | null;
  settings: (WatchGradeSettings & { minGradedRequests: number; watchedThresholdPercent: number }) | null;
  grade: WatchGradeSummary | null;
  requests: RequestWatchVerdict[];
  // True when `requests` was cut at the row cap (the grade still covers every request).
  truncated: boolean;
}

export function emptyWatchGradeSummary(status: WatchGradeStatus = "insufficient"): WatchGradeSummary {
  return { status, letter: null, score: null, graded: 0, watched: 0, partial: 0, unwatched: 0, inGrace: 0, untracked: 0 };
}

export function letterForScore(score: number): WatchGradeLetter {
  for (const band of WATCH_GRADE_BANDS) {
    if (score >= band.min) return band.letter;
  }
  return "F";
}

function unitWatched(u: RequestPlayUnit, watchedThresholdPercent: number): boolean {
  if (u.anyWatched) return true;
  return u.durationSeconds > 0 && u.playSeconds * 100 >= u.durationSeconds * watchedThresholdPercent;
}

function unitStarted(u: RequestPlayUnit): boolean {
  const floor =
    u.durationSeconds > 0
      ? Math.min(STARTED_MIN_SECONDS, u.durationSeconds * STARTED_MIN_FRACTION)
      : STARTED_MIN_SECONDS;
  return u.playSeconds > 0 && u.playSeconds >= floor;
}

// Episodes needed for full credit. Integer ceil — a float `ceil(n * p / 100)`
// can overshoot by one on an exact multiple.
export function requiredEpisodes(libraryEpisodes: number, tvEpisodePercent: number): number {
  if (libraryEpisodes <= 0) return 1;
  return Math.max(1, Math.floor((libraryEpisodes * tvEpisodePercent + 99) / 100));
}

function creditFor(
  request: GradableRequest,
  units: RequestPlayUnit[],
  input: GradeUserInput,
): { credit: number; episodes: EpisodeProgress | null } {
  const threshold = input.watchedThresholdPercent;
  if (request.mediaType === "MOVIE") {
    if (units.some((u) => unitWatched(u, threshold))) return { credit: 1, episodes: null };
    if (units.some(unitStarted)) return { credit: 0.5, episodes: null };
    return { credit: 0, episodes: null };
  }

  let watched = 0;
  let started = 0;
  for (const u of units) {
    // Specials and plays with no episode identity don't count toward the show.
    if (u.seasonNumber == null || u.seasonNumber <= 0 || u.episodeNumber == null) continue;
    if (unitWatched(u, threshold)) watched++;
    else if (unitStarted(u)) started++;
  }
  const library = Math.max(0, input.libraryEpisodes.get(request.tmdbId) ?? 0);
  const required = requiredEpisodes(library, input.settings.tvEpisodePercent);
  const credit = Math.min(1, (watched + started / 2) / required);
  return { credit, episodes: { watched, started, library, required } };
}

function watchStateFor(credit: number): WatchState {
  if (credit >= 1) return "watched";
  return credit > 0 ? "partial" : "unwatched";
}

export function gradeUser(input: GradeUserInput): UserWatchGrade {
  const { identity, settings, now } = input;
  const nowMs = now.getTime();
  const windowStartMs = settings.windowDays > 0 ? nowMs - settings.windowDays * DAY_MS : null;
  const observable = identity.kind === "tracked";
  const coverageStartMs =
    identity.kind === "tracked" && identity.coverageStart ? identity.coverageStart.getTime() : null;

  const unitsByRequest = new Map<string, RequestPlayUnit[]>();
  for (const u of input.units) {
    const list = unitsByRequest.get(u.requestId);
    if (list) list.push(u);
    else unitsByRequest.set(u.requestId, [u]);
  }

  const requests = input.requests
    .filter((r) => windowStartMs === null || r.fulfilledAt.getTime() >= windowStartMs)
    .sort((a, b) => b.fulfilledAt.getTime() - a.fulfilledAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const summary = emptyWatchGradeSummary();
  let creditSum = 0;

  const verdicts = requests.map((r): RequestWatchVerdict => {
    const fulfilledMs = r.fulfilledAt.getTime();
    const { credit, episodes } = observable
      ? creditFor(r, unitsByRequest.get(r.id) ?? [], input)
      : { credit: 0, episodes: null };
    const watch = observable ? watchStateFor(credit) : null;

    let scoring: ScoringState;
    let graceDaysLeft: number | null = null;
    if (!observable || coverageStartMs === null || fulfilledMs < coverageStartMs) {
      scoring = "untracked";
      summary.untracked++;
    } else {
      const graceEndsMs = fulfilledMs + settings.graceDays * DAY_MS;
      if (nowMs < graceEndsMs) {
        scoring = "grace";
        graceDaysLeft = Math.ceil((graceEndsMs - nowMs) / DAY_MS);
        summary.inGrace++;
      } else {
        scoring = "scored";
        summary.graded++;
        creditSum += credit;
        if (watch === "watched") summary.watched++;
        else if (watch === "partial") summary.partial++;
        else summary.unwatched++;
      }
    }

    return {
      requestId: r.id,
      tmdbId: r.tmdbId,
      mediaType: r.mediaType,
      title: r.title,
      releaseYear: r.releaseYear,
      posterPath: r.posterPath,
      requestedAt: r.createdAt.toISOString(),
      fulfilledAt: r.fulfilledAt.toISOString(),
      watch,
      credit: Math.round(credit * 100) / 100,
      scoring,
      graceDaysLeft,
      episodes,
    };
  });

  if (identity.kind === "unlinked") {
    summary.status = "unlinked";
  } else if (identity.kind === "untracked" || coverageStartMs === null) {
    summary.status = "untracked";
  } else {
    if (summary.graded > 0) summary.score = Math.round((creditSum / summary.graded) * 100);
    if (summary.graded >= MIN_GRADED_REQUESTS && summary.score !== null) {
      summary.status = "graded";
      summary.letter = letterForScore(summary.score);
    }
  }

  return { summary, verdicts };
}

// True when a summary has anything worth showing next to a user: a letter, or
// fulfilled requests that explain why there isn't one yet.
export function hasWatchGradeSignal(summary: WatchGradeSummary | null | undefined): summary is WatchGradeSummary {
  if (!summary) return false;
  return summary.letter !== null || summary.graded + summary.inGrace + summary.untracked > 0;
}

// One-line explanation for tooltips and the detail header. List surfaces don't
// carry the settings, so the grace length is named only when it's supplied.
export function describeWatchGrade(summary: WatchGradeSummary, settings?: WatchGradeSettings): string {
  const fulfilled = (n: number) => `${n} fulfilled request${n === 1 ? "" : "s"}`;
  switch (summary.status) {
    case "graded":
      return (
        `Watch grade ${summary.letter} — ${summary.score}% across ${fulfilled(summary.graded)} ` +
        `(${summary.watched} watched, ${summary.partial} partly, ${summary.unwatched} not watched)`
      );
    case "insufficient":
      if (summary.graded === 0 && summary.inGrace > 0) {
        const grace = settings ? `the ${settings.graceDays}-day grace period` : "the grace period";
        return `Not graded yet — ${fulfilled(summary.inGrace)} still inside ${grace}`;
      }
      if (summary.graded === 0 && summary.untracked > 0) {
        return `Not graded yet — ${fulfilled(summary.untracked)} predate${summary.untracked === 1 ? "s" : ""} play history tracking`;
      }
      return `Not graded yet — needs ${MIN_GRADED_REQUESTS} scored requests, has ${summary.graded}`;
    case "unlinked":
      return "Not graded — no Plex or Jellyfin account is linked, so watches can't be tracked";
    case "untracked":
      return "Not graded — play history isn't recording this user's media server yet";
  }
}
