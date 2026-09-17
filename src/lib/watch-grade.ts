// Request watch grades — do the people who request media actually watch it?
//
// Each user gets an A–F letter from the share of their APPROVED, FULFILLED
// requests they went on to watch. The grade is DISPLAY-ONLY by product decision:
// it is shown to admins (Users page, request queue) and nothing reads it to gate
// a request, a quota or auto-approve. Wiring it into enforcement is a separate
// decision, not a refactor.
//
// Pure, ZERO-import leaf (the sonarr-completion.ts / permissions.ts shape): the
// admin client components import the types and labels from here, and the whole
// rule set is pinned by tests/watch-grade.test.mts without a database. The prisma
// half — which requests, whose plays, how many episodes — is watch-grade-data.ts.
//
// The rules, in one place:
//   - Only APPROVED requests that became AVAILABLE are graded, and approval is
//     per title on an instance: a request counts when it, or any request for the
//     same title on the same instance, was approved (watch-grade-data.ts reads
//     MediaRequest.approvedAt). Pending and declined requests never count, and
//     neither does a request whose title nobody approved — a pending request a
//     library sync marked available when the title arrived.
//   - A request is SCORED only once its grace period since fulfilment has
//     elapsed. Requests inside the grace period are listed but never scored —
//     not even the ones already watched. Counting a prompt watch early while an
//     unwatched sibling waits would bias every recent requester upward; the
//     score only ever averages matured requests.
//   - A request fulfilled before play history covered the user's media servers
//     is "untracked" and never scored: a watch from before tracking began is
//     invisible, and reading that silence as "never watched" is a false F.
//   - One title, one unit. The same title requested on more than one *arr
//     instance (an HD and a 4K request) is folded into one, dated from the
//     earliest request, so one watch or one miss is never counted twice.
//   - Only plays that started at or after the request count. A title watched
//     before it was requested (a re-request after removal, an HD copy watched
//     before asking for 4K) is not evidence the REQUEST was used.
//   - Movie: full credit when watched (a play flagged watched/completed, or the
//     plays since the request adding up to the watched threshold — chunked
//     viewing counts); half credit once a quarter of it was played; else zero.
//   - TV: scored per SEASON, and the best season counts. A season earns
//     episodes watched ÷ the required share of that season's REGULAR-season
//     episodes in the library (specials excluded, as guardrail 14a does), capped
//     at 1; a started-but-unfinished episode counts as half an episode. Watching
//     half of one season means the request was used, and a finished season's
//     credit never decays as later seasons land.
//   - A request the requester didn't watch still counts as WATCHED once enough
//     OTHER people watched it since the request (otherViewers, default 2; 0 turns
//     it off). Others count as play history recorded them: a movie play flagged
//     watched/completed, or watched episodes reaching the same season share. A
//     person with several media-server logins counts once, and the requester's
//     own logins never count. It only ever raises the credit of a request:
//     grace and coverage still decide whether a request is scored.
//   - A user with no linked media-server identity cannot be graded, and neither
//     can one whose media servers are not being tracked — both say so explicitly
//     rather than rendering an F for data that was never collected.
//   - The letter comes from admin-set cutoffs (default A 80, B 60, C 40, D 20;
//     below D is an F), shown only once enough requests are scored (default 3).
//     Cutoffs must be strictly descending: the settings route refuses anything
//     else, and a stored set that isn't falls back to the defaults on read.

export type WatchGradeLetter = "A" | "B" | "C" | "D" | "F";

// A play below the watched threshold earns half credit once it was a real
// attempt: a quarter of the runtime, and never under 15 minutes — half the
// runtime for anything shorter than 30 minutes. A five-minute look at a feature
// earns nothing; with a five-minute floor a requester who sampled every request
// could never score below a C.
export const STARTED_MIN_SECONDS = 900;
export const STARTED_MIN_FRACTION = 0.25;
export const STARTED_SHORT_FRACTION = 0.5;

const DAY_MS = 86_400_000;

// ── Settings ────────────────────────────────────────────────────────────────

export interface WatchGradeSettings {
  // Days after fulfilment before a request counts toward the grade.
  graceDays: number;
  // Only requests fulfilled within this many days are graded. 0 = no limit.
  windowDays: number;
  // Share of a season's library episodes that must be watched for full credit.
  tvEpisodePercent: number;
  // Other people who must have watched a request since it was made for it to
  // count as watched when the requester didn't. 0 = off.
  otherViewers: number;
  // Minimum watch rate (0–100) for each letter; below bandD is an F. Strictly
  // descending — see watchGradeCrossFieldError.
  bandA: number;
  bandB: number;
  bandC: number;
  bandD: number;
  // Scored requests needed before a letter is shown. Below it the watch rate is
  // still reported, but one unwatched film must not stamp a new requester an F.
  minGradedRequests: number;
}

export const WATCH_GRADE_DEFAULTS: WatchGradeSettings = {
  graceDays: 30,
  windowDays: 365,
  tvEpisodePercent: 50,
  otherViewers: 2,
  bandA: 80,
  bandB: 60,
  bandC: 40,
  bandD: 20,
  minGradedRequests: 3,
};

export const WATCH_GRADE_SETTING_KEYS = {
  graceDays: "watchGradeGraceDays",
  windowDays: "watchGradeWindowDays",
  tvEpisodePercent: "watchGradeTvPercent",
  otherViewers: "watchGradeOtherViewers",
  bandA: "watchGradeBandA",
  bandB: "watchGradeBandB",
  bandC: "watchGradeBandC",
  bandD: "watchGradeBandD",
  minGradedRequests: "watchGradeMinRequests",
} as const;

type BandSettings = Pick<WatchGradeSettings, "bandA" | "bandB" | "bandC" | "bandD">;

// Minimum score for each letter, best first. F is everything below D.
export function watchGradeBands(settings: BandSettings): { letter: WatchGradeLetter; min: number }[] {
  return [
    { letter: "A", min: settings.bandA },
    { letter: "B", min: settings.bandB },
    { letter: "C", min: settings.bandC },
    { letter: "D", min: settings.bandD },
    { letter: "F", min: 0 },
  ];
}

// One table serves the write-side validator (/api/settings) and the read-side
// parser, so a value the settings route accepts can never be clamped into
// something else on read. `zero` names what 0 means for the fields that accept it.
const SETTING_BOUNDS: Record<keyof WatchGradeSettings, { min: number; max: number; zero: string | null }> = {
  graceDays: { min: 1, max: 365, zero: null },
  windowDays: { min: 30, max: 3650, zero: "for no limit" },
  tvEpisodePercent: { min: 1, max: 100, zero: null },
  otherViewers: { min: 1, max: 100, zero: "to turn it off" },
  // No 0: a D cutoff of 0 would make an F impossible.
  bandA: { min: 1, max: 100, zero: null },
  bandB: { min: 1, max: 100, zero: null },
  bandC: { min: 1, max: 100, zero: null },
  bandD: { min: 1, max: 100, zero: null },
  minGradedRequests: { min: 1, max: 100, zero: null },
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
  if (n === 0 && b.zero !== null) return 0;
  return n >= b.min && n <= b.max ? n : null;
}

// Validation message for a watch-grade Setting write, or null when the value is
// acceptable (or the key isn't a watch-grade key at all).
export function watchGradeSettingError(key: string, value: string): string | null {
  const field = fieldForKey(key);
  if (!field) return null;
  if (parseBounded(value, field) !== null) return null;
  const b = SETTING_BOUNDS[field];
  return `"${key}" must be an integer between ${b.min} and ${b.max}${b.zero ? `, or 0 ${b.zero}` : ""}`;
}

// The rules that span fields, checked on write against the MERGED values (stored
// plus incoming), so a change to one field that breaks another is caught too.
//   - A window no longer than the grace period scores nothing, ever: every
//     request is still inside its grace period when it leaves the window.
//   - Cutoffs must be strictly descending. Out of order, letterForScore hands
//     out the first letter whose cutoff a score clears, so an A below a B would
//     turn every B into an A.
export function watchGradeCrossFieldError(
  settings: Pick<WatchGradeSettings, "graceDays" | "windowDays"> & BandSettings,
): string | null {
  if (settings.windowDays > 0 && settings.windowDays <= settings.graceDays) {
    return (
      `The grade window (${settings.windowDays} days) must be longer than the grace period ` +
      `(${settings.graceDays} days), or 0 for no limit — otherwise no request can ever be scored`
    );
  }
  const bands = watchGradeBands(settings);
  for (let i = 0; i < 3; i++) {
    if (bands[i].min <= bands[i + 1].min) {
      return (
        `The ${bands[i].letter} cutoff (${bands[i].min}%) must be higher than the ` +
        `${bands[i + 1].letter} cutoff (${bands[i + 1].min}%)`
      );
    }
  }
  return null;
}

function bandsDescending(settings: BandSettings): boolean {
  return settings.bandA > settings.bandB && settings.bandB > settings.bandC && settings.bandC > settings.bandD;
}

// Per-field parse: each value inside its own bounds, else its default. No
// cross-field repair — the write path validates these merged values with
// watchGradeCrossFieldError, and a repair here would hide a bad combination.
export function parseWatchGradeFields(raw: Record<string, string | null | undefined>): WatchGradeSettings {
  const out = { ...WATCH_GRADE_DEFAULTS };
  for (const field of Object.keys(WATCH_GRADE_SETTING_KEYS) as (keyof WatchGradeSettings)[]) {
    const parsed = parseBounded(raw[WATCH_GRADE_SETTING_KEYS[field]], field);
    if (parsed !== null) out[field] = parsed;
  }
  return out;
}

// Read-side parse: a missing or out-of-range row falls back to its default rather
// than to NaN or an unbounded window, and cutoffs that aren't strictly
// descending fall back to the defaults ALL FOUR together — restoring only the
// offending one could still leave them out of order. The route refuses such a
// set; this covers rows written any other way.
export function parseWatchGradeSettings(raw: Record<string, string | null | undefined>): WatchGradeSettings {
  const out = parseWatchGradeFields(raw);
  if (!bandsDescending(out)) {
    out.bandA = WATCH_GRADE_DEFAULTS.bandA;
    out.bandB = WATCH_GRADE_DEFAULTS.bandB;
    out.bandC = WATCH_GRADE_DEFAULTS.bandC;
    out.bandD = WATCH_GRADE_DEFAULTS.bandD;
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
// (season, episode) — movies arrive as a single (null, null) unit. Keyed by the
// request that is graded: when a title was requested on several instances, the
// earliest request's plays are the superset and are the ones read.
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

// What ONE other person watched of a requested title since the request, as play
// history recorded it. Never the requester's own plays.
export interface OtherViewerWatch {
  requestId: string;
  // One key per PERSON: the account the media-server identity belongs to, or the
  // identity itself when it belongs to no account. An account's several logins
  // share one key, so they count once.
  viewer: string;
  // null for a movie; the season for a show.
  seasonNumber: number | null;
  // Movie: 1 when any play was flagged watched/completed. TV: distinct episodes
  // of this season flagged watched/completed.
  watched: number;
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
  // Everyone else's watches of the same requests. Empty when the rule is off.
  otherWatches: OtherViewerWatch[];
  // tmdbId → season → regular-season episodes in the library, for the TV requests.
  libraryEpisodes: ReadonlyMap<number, ReadonlyMap<number, number>>;
  identity: WatchGradeIdentity;
  // Play-history "watched" threshold (percent), reused for summed plays.
  watchedThresholdPercent: number;
  settings: WatchGradeSettings;
  now: Date;
}

export type WatchState = "watched" | "partial" | "unwatched";
export type ScoringState = "scored" | "grace" | "untracked";

// The season a show's credit comes from — the best one — and how far it got.
export interface EpisodeProgress {
  // null only when the show has no plays and no known library episodes.
  season: number | null;
  watched: number;
  started: number;
  // Regular-season episodes of that season in the library. 0 = unknown, in
  // which case one watched episode is enough.
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
  // Further requests for the same title (other *arr instances) folded into this one.
  duplicates: number;
  // The requester's OWN watch state; null when their watches can't be observed
  // at all (unlinked/untracked).
  watch: WatchState | null;
  // Other people who watched it since the request. Counted only where it can
  // change the verdict — a scored request the requester didn't fully watch —
  // and null everywhere else (rule off, unobservable, grace, untracked, watched).
  otherViewers: number | null;
  // Counts as watched because enough other people watched it, although the
  // requester didn't.
  watchedByOthers: boolean;
  // 0–1, two decimals. 1 when watchedByOthers.
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
  // The scored requests a letter needs (the setting in force), so list surfaces
  // can explain a missing letter without carrying the settings.
  minGradedRequests: number;
  // 0–100 watch rate over the scored requests; null when nothing was scored.
  score: number | null;
  // Scored requests, and how they split.
  graded: number;
  watched: number;
  // Not watched (or only partly) by the requester, but counted as watched
  // because enough other people watched it.
  byOthers: number;
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
  settings: (WatchGradeSettings & { watchedThresholdPercent: number }) | null;
  grade: WatchGradeSummary | null;
  requests: RequestWatchVerdict[];
  // True when `requests` was cut at the row cap (the grade still covers every request).
  truncated: boolean;
}

export function emptyWatchGradeSummary(
  status: WatchGradeStatus = "insufficient",
  minGradedRequests: number = WATCH_GRADE_DEFAULTS.minGradedRequests,
): WatchGradeSummary {
  return {
    status, letter: null, minGradedRequests, score: null,
    graded: 0, watched: 0, byOthers: 0, partial: 0, unwatched: 0, inGrace: 0, untracked: 0,
  };
}

// How many users land on each letter — the settings preview's before/after.
// Counts only summaries a user would show a chip for; "notGraded" is everyone
// with approved, fulfilled requests but no letter yet.
export interface WatchGradeSpread {
  A: number;
  B: number;
  C: number;
  D: number;
  F: number;
  notGraded: number;
}

// Wire shape of POST /api/admin/watch-grade/preview.
export interface WatchGradePreview {
  enabled: boolean;
  reason: "feature-off" | "tracking-off" | null;
  // Accounts with at least one approved, fulfilled request — everyone who could show a grade.
  requesters: number;
  current: WatchGradeSpread | null;
  proposed: WatchGradeSpread | null;
}

export function letterForScore(score: number, settings: BandSettings = WATCH_GRADE_DEFAULTS): WatchGradeLetter {
  for (const band of watchGradeBands(settings)) {
    if (score >= band.min) return band.letter;
  }
  return "F";
}

function unitWatched(u: RequestPlayUnit, watchedThresholdPercent: number): boolean {
  if (u.anyWatched) return true;
  return u.durationSeconds > 0 && u.playSeconds * 100 >= u.durationSeconds * watchedThresholdPercent;
}

// Seconds of play before a unit counts as started (half credit). A quarter of the
// runtime, but never under 15 minutes — or half the runtime, for anything shorter
// than 30 minutes. 15 minutes flat when the runtime is unknown.
export function startedFloorSeconds(durationSeconds: number): number {
  if (durationSeconds <= 0) return STARTED_MIN_SECONDS;
  return Math.max(
    durationSeconds * STARTED_MIN_FRACTION,
    Math.min(STARTED_MIN_SECONDS, durationSeconds * STARTED_SHORT_FRACTION),
  );
}

function unitStarted(u: RequestPlayUnit): boolean {
  return u.playSeconds > 0 && u.playSeconds >= startedFloorSeconds(u.durationSeconds);
}

// Episodes needed for full credit. Integer ceil — a float `ceil(n * p / 100)`
// can overshoot by one on an exact multiple.
export function requiredEpisodes(libraryEpisodes: number, tvEpisodePercent: number): number {
  if (libraryEpisodes <= 0) return 1;
  return Math.max(1, Math.floor((libraryEpisodes * tvEpisodePercent + 99) / 100));
}

function librarySeason(input: GradeUserInput, tmdbId: number, season: number): number {
  return Math.max(0, input.libraryEpisodes.get(tmdbId)?.get(season) ?? 0);
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

  // Per season; the best one is the show's credit. Specials and plays with no
  // episode identity don't count toward any season.
  const played = new Map<number, { watched: number; started: number }>();
  for (const u of units) {
    if (u.seasonNumber == null || u.seasonNumber <= 0 || u.episodeNumber == null) continue;
    const s = played.get(u.seasonNumber) ?? { watched: 0, started: 0 };
    if (unitWatched(u, threshold)) s.watched++;
    else if (unitStarted(u)) s.started++;
    played.set(u.seasonNumber, s);
  }
  const seasons = new Set<number>([...played.keys(), ...(input.libraryEpisodes.get(request.tmdbId)?.keys() ?? [])]);
  let best: EpisodeProgress | null = null;
  let bestCredit = -1;
  // Ascending, so an exact tie reports the earliest season.
  for (const season of [...seasons].sort((a, b) => a - b)) {
    const { watched, started } = played.get(season) ?? { watched: 0, started: 0 };
    const library = librarySeason(input, request.tmdbId, season);
    const required = requiredEpisodes(library, input.settings.tvEpisodePercent);
    const credit = Math.min(1, (watched + started / 2) / required);
    if (credit > bestCredit) {
      bestCredit = credit;
      best = { season, watched, started, library, required };
    }
  }
  if (!best) return { credit: 0, episodes: { season: null, watched: 0, started: 0, library: 0, required: 1 } };
  return { credit: bestCredit, episodes: best };
}

// How many OTHER people watched a request: a movie play flagged watched, or a
// season whose watched episodes reach the same share the requester needs. A
// person's rows for one season are merged by max — the data layer already
// merges across logins; this keeps the rule honest if it ever doesn't.
function viewersWhoWatched(request: GradableRequest, watches: OtherViewerWatch[], input: GradeUserInput): number {
  const byViewer = new Map<string, Map<number | null, number>>();
  for (const w of watches) {
    const seasons = byViewer.get(w.viewer) ?? new Map<number | null, number>();
    seasons.set(w.seasonNumber, Math.max(seasons.get(w.seasonNumber) ?? 0, w.watched));
    byViewer.set(w.viewer, seasons);
  }
  let count = 0;
  for (const seasons of byViewer.values()) {
    let watched = false;
    for (const [season, n] of seasons) {
      if (request.mediaType === "MOVIE") {
        if (n > 0) watched = true;
      } else if (season != null && season > 0) {
        const required = requiredEpisodes(librarySeason(input, request.tmdbId, season), input.settings.tvEpisodePercent);
        if (n >= required) watched = true;
      }
    }
    if (watched) count++;
  }
  return count;
}

function watchStateFor(credit: number): WatchState {
  if (credit >= 1) return "watched";
  return credit > 0 ? "partial" : "unwatched";
}

type FoldedRequest = GradableRequest & { duplicates: number };

// One unit per title. The earliest request is kept (its plays-since-request set
// is the superset), fulfilment is the FIRST time the title became available, and
// the fold is counted so the breakdown can say so.
function foldByTitle(requests: GradableRequest[]): FoldedRequest[] {
  const byTitle = new Map<string, GradableRequest[]>();
  for (const r of requests) {
    const key = `${r.mediaType}:${r.tmdbId}`;
    const list = byTitle.get(key);
    if (list) list.push(r);
    else byTitle.set(key, [r]);
  }
  const out: FoldedRequest[] = [];
  for (const group of byTitle.values()) {
    group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const primary = group[0];
    let fulfilledAt = primary.fulfilledAt;
    for (const r of group) if (r.fulfilledAt < fulfilledAt) fulfilledAt = r.fulfilledAt;
    out.push({ ...primary, fulfilledAt, duplicates: group.length - 1 });
  }
  return out;
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
  const otherWatchesByRequest = new Map<string, OtherViewerWatch[]>();
  for (const w of input.otherWatches) {
    const list = otherWatchesByRequest.get(w.requestId);
    if (list) list.push(w);
    else otherWatchesByRequest.set(w.requestId, [w]);
  }

  const requests = foldByTitle(
    input.requests.filter((r) => windowStartMs === null || r.fulfilledAt.getTime() >= windowStartMs),
  ).sort((a, b) => b.fulfilledAt.getTime() - a.fulfilledAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const summary = emptyWatchGradeSummary("insufficient", settings.minGradedRequests);
  let creditSum = 0;

  const verdicts = requests.map((r): RequestWatchVerdict => {
    const fulfilledMs = r.fulfilledAt.getTime();
    let scoring: ScoringState;
    let graceDaysLeft: number | null = null;
    if (!observable || coverageStartMs === null || fulfilledMs < coverageStartMs) {
      scoring = "untracked";
    } else {
      const graceEndsMs = fulfilledMs + settings.graceDays * DAY_MS;
      if (nowMs < graceEndsMs) {
        scoring = "grace";
        graceDaysLeft = Math.ceil((graceEndsMs - nowMs) / DAY_MS);
      } else {
        scoring = "scored";
      }
    }

    const own = observable
      ? creditFor(r, unitsByRequest.get(r.id) ?? [], input)
      : { credit: 0, episodes: null };
    const watch = observable ? watchStateFor(own.credit) : null;
    // Other viewers are counted only where they can change the verdict: a scored
    // request the requester didn't fully watch. The `> 0` guard is what makes 0
    // mean off — every count is >= 0. (The data layer reads the audience for
    // exactly this set, so anywhere else the count would be an artefact.)
    const otherViewers =
      observable && settings.otherViewers > 0 && scoring === "scored" && own.credit < 1
        ? viewersWhoWatched(r, otherWatchesByRequest.get(r.id) ?? [], input)
        : null;
    const watchedByOthers = otherViewers !== null && otherViewers >= settings.otherViewers;
    const credit = watchedByOthers ? 1 : own.credit;

    if (scoring === "untracked") summary.untracked++;
    else if (scoring === "grace") summary.inGrace++;
    else {
      summary.graded++;
      creditSum += credit;
      if (watch === "watched") summary.watched++;
      else if (watchedByOthers) summary.byOthers++;
      else if (watch === "partial") summary.partial++;
      else summary.unwatched++;
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
      duplicates: r.duplicates,
      watch,
      otherViewers,
      watchedByOthers,
      credit: Math.round(credit * 100) / 100,
      scoring,
      graceDaysLeft,
      episodes: own.episodes,
    };
  });

  if (identity.kind === "unlinked") {
    summary.status = "unlinked";
  } else if (identity.kind === "untracked" || coverageStartMs === null) {
    summary.status = "untracked";
  } else {
    if (summary.graded > 0) summary.score = Math.round((creditSum / summary.graded) * 100);
    if (summary.graded >= settings.minGradedRequests && summary.score !== null) {
      summary.status = "graded";
      summary.letter = letterForScore(summary.score, settings);
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

export function watchGradeSpread(summaries: Iterable<WatchGradeSummary>): WatchGradeSpread {
  const spread: WatchGradeSpread = { A: 0, B: 0, C: 0, D: 0, F: 0, notGraded: 0 };
  for (const summary of summaries) {
    if (!hasWatchGradeSignal(summary)) continue;
    if (summary.letter) spread[summary.letter]++;
    else spread.notGraded++;
  }
  return spread;
}

// "watched/scored" for the chip — the requests that earned full credit: the
// requester's own watches plus the ones enough other people watched. Partial
// credit moves the score, not this count; the tooltip has the split.
export function watchGradeVolume(summary: WatchGradeSummary): string {
  return `${summary.watched + summary.byOthers}/${summary.graded}`;
}

// One-line explanation for tooltips and the detail header. List surfaces don't
// carry the settings, so the grace length is named only when it's supplied.
export function describeWatchGrade(summary: WatchGradeSummary, settings?: WatchGradeSettings): string {
  const fulfilled = (n: number) => `${n} fulfilled request${n === 1 ? "" : "s"}`;
  switch (summary.status) {
    case "graded": {
      const byOthers = summary.byOthers > 0 ? `, ${summary.byOthers} watched by others` : "";
      return (
        `Watch grade ${summary.letter} — ${summary.score}% across ${fulfilled(summary.graded)} ` +
        `(${summary.watched} watched${byOthers}, ${summary.partial} partly, ${summary.unwatched} not watched)`
      );
    }
    case "insufficient":
      if (summary.graded === 0 && summary.inGrace > 0) {
        const grace = settings ? `the ${settings.graceDays}-day grace period` : "the grace period";
        return `Not graded yet — ${fulfilled(summary.inGrace)} still inside ${grace}`;
      }
      if (summary.graded === 0 && summary.untracked > 0) {
        return `Not graded yet — ${fulfilled(summary.untracked)} predate${summary.untracked === 1 ? "s" : ""} play history tracking`;
      }
      return `Not graded yet — needs ${summary.minGradedRequests} scored requests, has ${summary.graded}`;
    case "unlinked":
      return "Not graded — no Plex or Jellyfin account is linked, so watches can't be tracked";
    case "untracked":
      return "Not graded — play history isn't recording this user's media server yet";
  }
}
