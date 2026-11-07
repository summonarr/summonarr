import "server-only";
import { prisma } from "./prisma";
import { getCache, getCacheStale, setCache, libraryDetailsTtl, TTL } from "./tmdb-cache";
import { safeFetchTrusted, SafeFetchError, type SafeFetchOptions } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { mapLimit, coalesce } from "./concurrency";
import { processSingleton } from "./process-singleton";
import { warnOnChange } from "./log-dedup";
import {
  MDBLIST_PLAN_SETTING_KEY,
  budgetAllows,
  emptyUsage,
  mdblistBudget,
  mdblistLimitKind,
  mdblistPauseUntil,
  parseMdblistPlanSetting,
  parseUsageHeaders,
  planForDailyLimit,
  recordReport,
  recordSent,
  utcDayStart,
  DEFAULT_PAUSE_MS,
  type MdblistBudget,
  type MdblistPlanId,
  type MdblistPlanSetting,
  type MdblistUsage,
} from "./mdblist-plan";

// How many cache writes one batch page runs at once. A full page has up to 200
// rows; writing them one by one is slow, and writing all at once would swamp
// the small Prisma connection pool.
const MDBLIST_CACHE_WRITE_CONCURRENCY = 8;

const MDBLIST_REST_BASE  = "https://api.mdblist.com/";
const MDBLIST_FETCH_TIMEOUT_MS = 10_000;
const MDBLIST_BATCH_TIMEOUT_MS = 30_000;
const MDBLIST_HOSTS = ["api.mdblist.com"];

// How long (seconds) a "MDBList has no data for this title" answer is cached.
const MDBLIST_NEGATIVE_TTL = 24 * 60 * 60;

// Sentinel stored in cache to distinguish "MDBList returned no data" from "not yet fetched"
const NOT_FOUND_SENTINEL = { _notFound: true } as const;

// The one name of a title's MDBList ratings row in TmdbCache.
export function mdblistCacheKey(mediaType: "movie" | "tv", tmdbId: number): string {
  return `mdblist:tmdb:${mediaType}:${tmdbId}`;
}

export interface MdblistRatings {
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  rtAudienceScore: string | null;
  metacritic: string | null;
  traktRating: string | null;
  letterboxdRating: string | null;
  mdblistScore: string | null;
  malRating: string | null;
  rogerEbertRating: string | null;
  releasedDigital: string | null;
  trailerUrl: string | null;
}

// The MDBList API key lives in a single Setting row that changes only when an admin
// edits it. A blocking ratings batch resolves up to 200 misses and each miss calls
// getApiKey twice (once in getMdblistRatingsForTmdb, once in fetchAndCacheMdblistForTmdb)
// — without memoization that is ~400 identical setting.findUnique reads against the
// small Prisma pool per request. Cache the resolved value for a short window, and
// coalesce concurrent cold reads into one query, so a key change still propagates
// within seconds. Pass { fresh: true } to bypass the cache (admin connection test,
// where stale-by-up-to-TTL would be confusing). Process-wide (guardrail 27a),
// like the rest of this module's state.
const API_KEY_TTL_MS = 30_000;
const apiKeyMemo = processSingleton<{
  cache: { value: string | null; at: number } | null;
  inflight: Promise<string | null> | null;
}>("mdblist:api-key", () => ({ cache: null, inflight: null }));

async function getApiKey(opts: { fresh?: boolean } = {}): Promise<string | null> {
  const memo = apiKeyMemo.cache;
  if (!opts.fresh && memo && Date.now() - memo.at < API_KEY_TTL_MS) {
    return memo.value;
  }
  if (!opts.fresh && apiKeyMemo.inflight) return apiKeyMemo.inflight;
  const p = (async () => {
    const row = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
    const value = row?.value.trim() || null;
    apiKeyMemo.cache = { value, at: Date.now() };
    return value;
  })();
  if (!opts.fresh) {
    apiKeyMemo.inflight = p;
    p.finally(() => { apiKeyMemo.inflight = null; }).catch(() => {});
  }
  return p;
}

export type MdblistResult =
  | { found: true; data: MdblistRatings }
  // `transient` marks a failure that is NOT an authoritative "no ratings" — a 5xx,
  // network/timeout, quota lockout, or a partial/error response — so callers must not
  // pin a null/not-found result into a long-lived cache.
  | { found: false; keyConfigured: boolean; quotaExhausted?: boolean; transient?: boolean };

// The SWR refreshes in flight, process-wide (guardrail 27a): a per-chunk Set let
// a page render and a cron route refresh the same row at once.
const mdblistRevalidating = processSingleton("mdblist:revalidating", () => new Set<string>());

// Who is asking. A background job (pre-warm, ratings sync, For You) stops at the
// reserve so pages people open keep part of the day's limit (mdblist-plan.ts).
// Everything else is a page someone opened.
export interface MdblistCallOptions {
  background?: boolean;
}

// The batch walk's consecutive-failure breaker. fetchMdblistBatch keeps its own
// per call; a caller that walks a library one page per call (the pre-warm)
// passes one that lives for the whole run, or the breaker could never trip.
export interface MdblistBatchBreaker {
  consecutiveFailures: number;
  tripped: boolean;
}

export function newMdblistBatchBreaker(): MdblistBatchBreaker {
  return { consecutiveFailures: 0, tripped: false };
}

export interface MdblistBatchOptions extends MdblistCallOptions {
  breaker?: MdblistBatchBreaker;
}

// Consecutive failed pages (no ratings answer) that stop a batch walk.
export const MDBLIST_BATCH_MAX_CONSECUTIVE_FAILURES = 3;

// ── Process-wide state ─────────────────────────────────────────────────────
// One copy for the whole server (guardrail 27a): Turbopack gives every server
// chunk its own copy of a module-level `let`, so a pause tripped by a cron route
// was invisible to the page renders, which kept calling.
interface MdblistRuntime {
  // MDBList calls are paused until this time (ms).
  pausedUntil: number;
  pauseReason: string | null;
  // Requests in a row that got no answer at all (see noteTransportFailure).
  transportFailures: number;
  usage: MdblistUsage;
  // The admin's plan choice, memoized like the API key.
  plan: { value: MdblistPlanSetting; at: number } | null;
  planInflight: Promise<MdblistPlanSetting> | null;
}

const runtime = processSingleton<MdblistRuntime>("mdblist:runtime", () => ({
  pausedUntil: 0,
  pauseReason: null,
  transportFailures: 0,
  usage: emptyUsage(Date.now()),
  plan: null,
  planInflight: null,
}));

const PLAN_TTL_MS = 30_000;

async function getPlanSetting(): Promise<MdblistPlanSetting> {
  const memo = runtime.plan;
  if (memo && Date.now() - memo.at < PLAN_TTL_MS) return memo.value;
  if (runtime.planInflight) return runtime.planInflight;
  const p = (async () => {
    try {
      const row = await prisma.setting.findUnique({ where: { key: MDBLIST_PLAN_SETTING_KEY } });
      const value = parseMdblistPlanSetting(row?.value);
      runtime.plan = { value, at: Date.now() };
      return value;
    } catch {
      // An unreadable choice must not stop ratings: keep the last one known.
      return runtime.plan?.value ?? "auto";
    }
  })();
  runtime.planInflight = p;
  p.finally(() => { runtime.planInflight = null; }).catch(() => {});
  return p;
}

// The settings route calls this after a save so the new plan applies at once.
export function invalidateMdblistPlanCache(): void {
  runtime.plan = null;
}

function currentBudget(): MdblistBudget {
  return mdblistBudget(runtime.plan?.value ?? "auto", runtime.usage, Date.now());
}

// Why MDBList must not be called right now, or null when it may be:
// - "locked": a limit error or the transport breaker paused every call;
// - "budget": the day's limit is spent;
// - "reserve": only for background callers, the part kept for pages is all that's left.
export type MdblistPause = "locked" | "budget" | "reserve";

export function mdblistPause(opts: MdblistCallOptions = {}): MdblistPause | null {
  if (Date.now() < runtime.pausedUntil) return "locked";
  const budget = currentBudget();
  if (!budgetAllows(budget, false)) return "budget";
  if (opts.background && !budgetAllows(budget, true)) return "reserve";
  return null;
}

// Every caller already asks "should I skip MDBList right now", and paused,
// spent and (for a background caller) down to the reserve are the same answer.
// Reads the last-known plan; checkMdblistPause re-reads it first.
export function isMdblistQuotaLocked(opts: MdblistCallOptions = {}): boolean {
  return mdblistPause(opts) !== null;
}

// The same question, with the plan choice refreshed first. For a job's own
// before-it-starts check; every call path below does this itself.
export async function checkMdblistPause(opts: MdblistCallOptions = {}): Promise<MdblistPause | null> {
  await getPlanSetting();
  const pause = mdblistPause(opts);
  if (pause === "budget" || pause === "reserve") noteBudgetStop(pause);
  return pause;
}

// One line per day per stop (guardrail 7b): every call refused for the rest of
// the day would otherwise restate it.
function noteBudgetStop(pause: "budget" | "reserve"): void {
  const budget = currentBudget();
  const day = utcDayStart(Date.now());
  if (pause === "budget") {
    warnOnChange(
      "mdblist:budget",
      String(day),
      `[mdblist] today's limit of ${budget.limit ?? "?"} requests is used up — no MDBList calls until 00:00 UTC`,
    );
  } else {
    warnOnChange(
      "mdblist:reserve",
      String(day),
      `[mdblist] ${budget.remaining ?? "?"} of today's ${budget.limit ?? "?"} requests left — background jobs stop until 00:00 UTC so pages keep the last ${budget.reserve}`,
    );
  }
}

// Pause every MDBList call until `until`. A longer pause already running wins.
function pauseMdblist(until: number, reason: string): void {
  if (until <= runtime.pausedUntil) return;
  const safeReason = sanitizeForLog(reason);
  runtime.pausedUntil = until;
  runtime.pauseReason = safeReason;
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  console.warn(`[mdblist] Quota lockout tripped (${safeReason}) — suspending calls for ${minutes} min`);
}

// A limit answer (a 429, or an error body naming a limit). MDBList says how long
// to wait — Retry-After, or the error text plus X-RateLimit-Reset — so the pause
// lasts exactly that: until the 5-minute window ends, or until midnight UTC for
// the daily limit. With no hint at all it is the old hour.
function pauseForLimit(headers: Headers, errorText: string | null, context: string): void {
  pauseMdblist(
    mdblistPauseUntil({
      kind: mdblistLimitKind(errorText),
      retryAfter: headers.get("retry-after"),
      reset: headers.get("x-ratelimit-reset"),
      now: Date.now(),
    }),
    errorText ? `${errorText} ${context}` : context,
  );
}

// ── Transport circuit breaker ──────────────────────────────────────────────
// The omdb.ts breaker, for MDBList. Every pause above needs a RESPONSE, so a
// run of timeouts paused nothing: each page of every job waited out its full
// timeout, and For You read MDBList as answering and saved week-long "no
// ratings" verdicts. Seen live 2026-10-28, when MDBList's servers were slow and
// every batch POST timed out while TMDB and OMDb answered normally.
//
// Threshold rather than one strike: a single timeout is a blip. Five in a row,
// across every MDBList call, is a reachability verdict. Any response at all —
// a 4xx or 5xx included — proves the host is up and clears the count.
const TRANSPORT_FAILURE_LIMIT = 5;

// Every request that got no answer since the process started. Unlike the
// breaker's count it never resets, so a job can read it before and after a
// batch and learn that MDBList failed DURING the batch even when the breaker
// has not tripped: one For You verdict batch sends about three requests, fewer
// than the five the breaker needs. Its own singleton, so a runtime object an
// older build left behind (dev hot reload) can't lack the field.
const transportFailureTotal = processSingleton("mdblist:transport-failure-total", () => ({ count: 0 }));

export function mdblistTransportFailureCount(): number {
  return transportFailureTotal.count;
}

function noteTransportFailure(reason: string): void {
  transportFailureTotal.count++;
  runtime.transportFailures++;
  if (runtime.transportFailures < TRANSPORT_FAILURE_LIMIT) return;
  runtime.transportFailures = 0;
  pauseMdblist(Date.now() + DEFAULT_PAUSE_MS, `${TRANSPORT_FAILURE_LIMIT} consecutive transport failures (${reason})`);
}

// "No response arrived", as opposed to "the answer was no". ssrf-blocked,
// redirect and size are verdicts about a host that did answer.
function isTransportFailure(err: unknown): boolean {
  return err instanceof SafeFetchError && (err.reason === "timeout" || err.reason === "network");
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Every MDBList request goes through here: it is counted against the day, the
// body is read inside the same timeout (so a reply that stalls mid-body counts
// as a failure too), the breaker is fed, and MDBList's own usage report is kept.
// The returned Response is buffered, so reading it can no longer time out.
async function mdblistRequest(url: string, init: SafeFetchOptions = {}): Promise<Response> {
  runtime.usage = recordSent(runtime.usage, Date.now());
  let res: Response;
  let body: string;
  try {
    res = await safeFetchTrusted(url, { allowedHosts: MDBLIST_HOSTS, timeoutMs: MDBLIST_FETCH_TIMEOUT_MS, ...init });
    body = await res.text();
  } catch (err) {
    if (isTransportFailure(err)) noteTransportFailure((err as SafeFetchError).reason);
    throw err;
  }
  runtime.transportFailures = 0;
  const report = parseUsageHeaders((name) => res.headers.get(name), Date.now());
  if (report) runtime.usage = recordReport(runtime.usage, report, Date.now());
  return new Response(NULL_BODY_STATUSES.has(res.status) ? null : body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

// The error a parsed MDBList body carries, or null when it is not an error body.
// MDBList answers some failures with HTTP 200 and `{ error: "<text>" }`, or
// `{ error: true, message: "<text>" }`; an `error: true` with no message text
// reads as `fallback`. The one parser every call path uses.
export function mdblistErrorMessage(data: unknown, fallback: string | null = "unknown"): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as { error?: unknown; message?: unknown };
  if (typeof d.error === "string") return d.error;
  if (d.error === true) return typeof d.message === "string" ? d.message : fallback;
  return null;
}

// The `error` text of a JSON error body, or null (an `error: true` with no text
// is null too: pauseForLimit then goes by the headers alone).
async function errorTextOf(res: Response): Promise<string | null> {
  return mdblistErrorMessage(await res.json().catch(() => null), null);
}

// What the settings page and the debug route show.
export interface MdblistUsageSnapshot {
  plan: MdblistPlanSetting;
  // The account's daily limit as MDBList last reported it, and the plan it matches.
  reportedLimit: number | null;
  reportedPlan: MdblistPlanId | null;
  // Account-wide requests used today by MDBList's own count; null when no reply
  // has reported today yet.
  usedToday: number | null;
  // What Summonarr budgets against (see mdblistBudget).
  limit: number | null;
  remaining: number | null;
  reserve: number;
  backgroundStopped: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
}

export async function getMdblistUsageSnapshot(): Promise<MdblistUsageSnapshot> {
  const plan = await getPlanSetting();
  const now = Date.now();
  const usage = runtime.usage;
  const budget = mdblistBudget(plan, usage, now);
  const report = usage.report;
  const current = report !== null && now < report.resetAt ? report : null;
  const paused = now < runtime.pausedUntil;
  return {
    plan,
    reportedLimit: report?.limit ?? null,
    reportedPlan: planForDailyLimit(report?.limit ?? null),
    usedToday: current ? current.limit - current.remaining + usage.sentSinceReport : null,
    limit: budget.limit,
    remaining: budget.remaining,
    reserve: budget.reserve,
    backgroundStopped: paused || !budgetAllows(budget, true),
    pausedUntil: paused ? new Date(runtime.pausedUntil).toISOString() : null,
    pauseReason: paused ? runtime.pauseReason : null,
  };
}

function isQuotaErrorMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("api limit") || m.includes("quota") || m.includes("rate limit") || m.includes("too many");
}

export async function fetchAndCacheMdblistForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  cacheKey: string,
  releaseDate?: string | null,
  opts: MdblistCallOptions = {},
): Promise<MdblistResult> {
  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  if (await checkMdblistPause(opts)) {
    return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
  }

  try {
    const mdbType = mediaType === "tv" ? "show" : "movie";
    const url = new URL(`${MDBLIST_REST_BASE}tmdb/${mdbType}/${encodeURIComponent(String(tmdbId))}/`);
    url.searchParams.set("apikey", apiKey);

    const res = await mdblistRequest(url.toString());

    if (res.status === 429) {
      pauseForLimit(res.headers, await errorTextOf(res), `HTTP 429 for ${mediaType}:${tmdbId}`);
      return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
    }

    if (res.status === 404) {
      await setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL);
      return { found: false, keyConfigured: true };
    }

    if (!res.ok) {
      console.warn(`[mdblist] API returned ${sanitizeForLog(res.status)} for ${sanitizeForLog(mediaType)}:${sanitizeForLog(tmdbId)}`);
      // A transient 5xx must NOT be negative-cached — that would suppress a valid
      // item's ratings for the full 24h TTL. Only a 404 (handled above) is a real
      // "not found" worth caching. Matches the batch path's reasoning.
      return { found: false, keyConfigured: true, transient: true };
    }

    const data = await res.json() as unknown;

    const errMsg = mdblistErrorMessage(data);
    if (errMsg) {
      if (isQuotaErrorMessage(errMsg)) {
        pauseForLimit(res.headers, errMsg, `for ${mediaType}:${tmdbId}`);
        return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
      }
      console.warn(`[mdblist] API error for ${sanitizeForLog(mediaType)}:${sanitizeForLog(tmdbId)}: ${sanitizeForLog(errMsg)}`);
      // A 200-with-error-body (other than 404, handled above as a real not-found) is an
      // app-level error that may be transient — do NOT negative-cache it for 24h, or a
      // valid item's ratings stay suppressed for the full TTL. Matches the 5xx reasoning.
      return { found: false, keyConfigured: true, transient: true };
    }

    const ratings = parseBatchItem(data as MdblistBatchRaw);

    // TTL bucket: prefer the caller's releaseDate, but fall back to the
    // response's own year — a dateless caller (the prewarm's detail-less
    // items) otherwise pins a brand-new release into the 30-day back-catalog
    // bucket instead of the fresh-title one.
    const respYear = (data as MdblistBatchRaw).year;
    await setCache(cacheKey, ratings, libraryDetailsTtl(releaseDate ?? (respYear ? `${respYear}-01-01` : null)));
    return { found: true, data: ratings };
  } catch (err) {
    const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
    console.error(`[mdblist] Error fetching for ${sanitizeForLog(mediaType)}:${tmdbId}: ${sanitizeForLog(reason)}`);
    return { found: false, keyConfigured: true, transient: true };
  }
}

const MDBLIST_BATCH_SIZE = 200;

export type MdblistBatchRaw = {
  // MDBList's media object carries ITS OWN id in `id` and the TMDB id SEPARATELY
  // (see MdblistListItem below — same API — which has both `id` and `tmdb_id` and
  // keys off `tmdb_id`). The tmdb/{type} batch must be matched on the TMDB id, so
  // it's resolved from whichever of these the response carries — never `id`, which
  // is MDBList's internal id and matching on it left every row "unmatched".
  id?: number | null;
  tmdb_id?: number | string | null;
  tmdbid?: number | string | null;
  ids?: { tmdb?: number | string | null } | null;
  title?: string;
  imdb_id?: string | null;
  type?: string;
  year?: number | null;
  score?: number | null;
  trailer?: string | null;
  released_digital?: string | null;
  ratings?: { source: string; value: number | null; score?: number | null; votes?: number | null }[];
};

// Extract the requested-namespace TMDB id from a batch row, tolerating the field
// name/shape MDBList uses (tmdb_id / tmdbid / nested ids.tmdb) and a string-encoded
// value. Returns null when the row carries no usable TMDB id. NEVER reads `id` —
// that is MDBList's internal media id, not the TMDB id.
export function batchRowTmdbId(raw: MdblistBatchRaw): number | null {
  const candidate = raw.tmdb_id ?? raw.tmdbid ?? raw.ids?.tmdb ?? null;
  if (candidate == null) return null;
  const n = Number(candidate);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// MDBList signals "no score" with a SENTINEL, not null: the aggregate `score`
// comes back as -1 (and sometimes 0) for a title it holds but has not scored.
// `!= null` alone lets those through, and every downstream consumer treats the
// resulting string as a real rating — the badge prints "MDB -1", and
// hasAnyMdblistRating (omdb-availability.ts) reads the row as populated, which
// is exactly the shadowing its own comment says must not happen. A genuine
// aggregate of 0 would mean every constituent source scored it zero, which is
// not a reachable state, so non-positive is treated as absent.
function aggregateScore(score: number | null | undefined): string | null {
  return score != null && score > 0 ? String(Math.round(score)) : null;
}

// Per-source values keep legitimate zeros (Rotten Tomatoes 0% and Metacritic 0
// are real scores) and only reject negatives, which no scale here can produce.
function sourceValue(value: number | null | undefined): number | null {
  return value != null && value >= 0 ? value : null;
}

// A batch row we can read at all: a plain object. A null, a number or an array
// in its place would throw on the first property access.
function isBatchRow(raw: unknown): raw is MdblistBatchRaw {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

// Exported for direct unit coverage (tests/mdblist-parse.test.mts) — pure parser, no I/O.
export function parseBatchItem(raw: MdblistBatchRaw): MdblistRatings {
  // A `ratings` that is not an array, or a non-object entry in it, is read as
  // no rating rather than thrown on.
  const sources = Array.isArray(raw.ratings) ? raw.ratings : [];
  // MDBList source names vary across API versions; multiple aliases are checked per source
  const findSrc = (...names: string[]) => {
    for (const n of names) {
      const hit = sources.find((s) => s !== null && typeof s === "object" && s.source === n);
      if (hit) return hit;
    }
    return undefined;
  };
  const imdb             = findSrc("imdb");
  const tomatoes         = findSrc("tomatoes");
  const tomatoesAudience = findSrc("audience", "tomatoesaudience", "popcornrating");
  const mc               = findSrc("metacritic");
  const trakt            = findSrc("trakt");
  const letterboxd       = findSrc("letterboxd", "letterrating");
  const mal              = findSrc("mal", "myanimelist");
  const ebert            = findSrc("rogerebert");

  const imdbValue       = sourceValue(imdb?.value);
  const tomatoesValue   = sourceValue(tomatoes?.value);
  const audienceValue   = sourceValue(tomatoesAudience?.value);
  const mcValue         = sourceValue(mc?.value);
  const traktValue      = sourceValue(trakt?.value);
  const letterboxdValue = sourceValue(letterboxd?.value);
  const malValue        = sourceValue(mal?.value);
  const ebertValue      = sourceValue(ebert?.value);

  return {
    imdbId:           raw.imdb_id || null,
    imdbRating:       imdbValue != null       ? String(imdbValue)                     : null,
    imdbVotes:        imdb?.votes             ? String(imdb.votes)                    : null,
    rottenTomatoes:   tomatoesValue != null   ? `${Math.round(tomatoesValue)}%`       : null,
    rtAudienceScore:  audienceValue != null   ? `${Math.round(audienceValue)}%`       : null,
    metacritic:       mcValue != null         ? `${Math.round(mcValue)}/100`          : null,
    traktRating:      traktValue != null      ? String(Math.round(traktValue))        : null,
    letterboxdRating: letterboxdValue != null ? String(letterboxdValue)               : null,
    mdblistScore:     aggregateScore(raw.score),
    malRating:        malValue != null        ? String(malValue)                      : null,
    rogerEbertRating: ebertValue != null      ? String(ebertValue)                    : null,
    releasedDigital:  raw.released_digital || null,
    trailerUrl:       raw.trailer || null,
  };
}

export async function fetchMdblistBatch(
  items: { id: number; releaseDate?: string | null }[],
  mediaType: "movie" | "tv",
  opts: MdblistBatchOptions = {},
): Promise<Map<number, MdblistRatings>> {
  const result = new Map<number, MdblistRatings>();
  if (items.length === 0) return result;

  // Log an unresolvable row's shape at most ONCE per call (covers all internal pages),
  // so a persistent MDBList field rename is diagnosable without spamming a line per page.
  let loggedUnmatchedShape = false;

  const apiKey = await getApiKey();
  if (!apiKey) return result;
  if (await checkMdblistPause(opts)) return result;

  const mdbType = mediaType === "tv" ? "show" : "movie";
  const url = new URL(`${MDBLIST_REST_BASE}tmdb/${mdbType}/`);
  url.searchParams.set("apikey", apiKey);

  // Breaker state: a wall of consecutive failed pages (upstream incident, an
  // invalid key answering 200-with-error on every page) must stop the walk
  // instead of burning one request per remaining page. Reset on any success.
  // The caller's breaker when it passes one (it spans that caller's calls).
  const breaker = opts.breaker ?? newMdblistBatchBreaker();
  // True when the page failure just counted is the one that trips the breaker.
  const pageFailed = (): boolean => {
    if (++breaker.consecutiveFailures < MDBLIST_BATCH_MAX_CONSECUTIVE_FAILURES) return false;
    breaker.tripped = true;
    console.warn(`[mdblist] batch ${mediaType}: ${breaker.consecutiveFailures} consecutive page failures — stopping the walk`);
    return true;
  };

  for (let offset = 0; offset < items.length; offset += MDBLIST_BATCH_SIZE) {
    // A pause tripped mid-run (this loop's own 429 breaks directly; a
    // CONCURRENT caller's trip, the breaker, or the budget running down is only
    // visible here) must stop later pages.
    if (breaker.tripped || isMdblistQuotaLocked(opts)) break;
    const page = items.slice(offset, offset + MDBLIST_BATCH_SIZE);
    const ids  = page.map((item) => item.id);

    let res: Response | null = null;
    try {
      const body = JSON.stringify({ ids });

      for (let attempt = 0; attempt < 2; attempt++) {
        res = await mdblistRequest(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          timeoutMs: MDBLIST_BATCH_TIMEOUT_MS,
        });
        if (res.status !== 503) break;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!res) break;

      if (res.status === 429) {
        pauseForLimit(res.headers, await errorTextOf(res), `HTTP 429 on batch ${mediaType}`);
        break;
      }

      if (!res.ok) {
        console.warn(`[mdblist] batch ${mediaType} returned ${res.status}`);
        if (pageFailed()) break;
        continue;
      }

      const data = await res.json() as unknown;

      const errMsg = mdblistErrorMessage(data);
      if (errMsg && isQuotaErrorMessage(errMsg)) {
        pauseForLimit(res.headers, errMsg, `on batch ${mediaType}`);
        break;
      }
      if (errMsg) {
        // A 200-with-error body (bad key, malformed request) is not a ratings
        // answer. Log the real error and count it toward the failure breaker.
        console.warn(`[mdblist] batch ${mediaType} API error: ${sanitizeForLog(errMsg)}`);
        if (pageFailed()) break;
        continue;
      }
      breaker.consecutiveFailures = 0;

      // Rows stay `unknown` until isBatchRow says they can be read.
      const arr: unknown[] = Array.isArray(data) ? data : [];

      // Collect the page's cache upserts and flush them with bounded concurrency
      // below, rather than awaiting each one serially in-loop.
      const cacheWrites: Array<() => Promise<unknown>> = [];
      // Rows that resolved to no REQUESTED item (a foreign id, an id-less row that
      // can't be placed, or a row that isn't an object). They must not count
      // toward "the response covered the full request" below, or the requested
      // ids they displaced get a 24h NOT_FOUND sentinel MDBList never actually
      // answered for.
      let unmatchedRows = 0;

      // Positional binding for a row with no TMDB id is safe only when the
      // response lines up with the request one to one: as many rows as ids, and
      // none of them carrying an id. MDBList leaves out unknown ids and may
      // reorder rows, so in any other response a position names the wrong title,
      // and its ratings would be cached under that title's key for the full TTL.
      const positionalOk = arr.length === page.length
        && arr.every((r) => isBatchRow(r) && batchRowTmdbId(r) == null);

      for (let i = 0; i < arr.length; i++) {
        const raw = arr[i];

        // Match by the response's TMDB id (batchRowTmdbId — resolves tmdb_id/tmdbid/
        // ids.tmdb, never MDBList's internal `id`). MDBList batch responses may return
        // items in a different order than the request, so match by id, not position.
        // A row whose TMDB id isn't in the page must NOT bind positionally (that
        // mis-binds it to the wrong requested item: wrong TTL, foreign id in the
        // result map). A row that isn't an object is skipped, not thrown on: one
        // bad row must not cost the page's other ratings.
        let pageItem: (typeof page)[number] | undefined;
        if (isBatchRow(raw)) {
          const respTmdbId = batchRowTmdbId(raw);
          pageItem = respTmdbId != null
            ? page.find((p) => p.id === respTmdbId)
            : positionalOk ? page[i] : undefined;
        }
        // MDBList can return MORE items than requested (or unmatched ids), so
        // page.find()/page[i] can be undefined — guard before any property access
        // or the whole 200-item batch throws and silently yields zero ratings.
        if (!pageItem || !isBatchRow(raw)) {
          unmatchedRows++;
          // Surface the real row shape ONCE if nothing resolves — makes a future
          // MDBList field rename diagnosable instead of a silent zero-ratings run.
          // Keys only (no values) so no rating/id data lands in logs.
          if (!loggedUnmatchedShape) {
            loggedUnmatchedShape = true;
            console.warn(`[mdblist] batch row did not resolve to a requested TMDB id — row keys: [${Object.keys(isBatchRow(raw) ? raw : {}).join(",")}]`);
          }
          continue;
        }
        // Cache/result key is the REQUESTED TMDB id (pageItem.id), never raw.id,
        // which is MDBList's own internal id.
        const tmdbId = pageItem.id;

        const ratings = parseBatchItem(raw);
        result.set(tmdbId, ratings);

        const cacheKey = mdblistCacheKey(mediaType, tmdbId);
        // Prefer the requested item's date; fall back to the response row's
        // year so dateless prewarm items land in the right TTL bucket.
        const ttl = libraryDetailsTtl(pageItem.releaseDate ?? (raw.year ? `${raw.year}-01-01` : null));
        cacheWrites.push(() => setCache(cacheKey, ratings, ttl));
      }

      // A SHORT response means MDBList simply has no data for the missing ids —
      // it is not a cut-off batch. Live logs showed the row count tracks the
      // request size (197/200, 87/88, 8/9), which is per-id absence, not
      // truncation. So the missing ids get a "not found" marker like any other
      // miss. Without it, every such id was re-requested on each page load and
      // sent to the OMDB fallback each time. If a short answer was ever a blip,
      // the cost is one MDBLIST_NEGATIVE_TTL (24h) and it fixes itself.
      //
      // Two shapes are still ambiguous and skip the marker: an EMPTY array
      // (looks the same as an upstream blip) and any response with UNMATCHED
      // rows (they took the place of requested ids MDBList never answered for).
      if (unmatchedRows === 0 && arr.length > 0) {
        for (const item of page) {
          if (!result.has(item.id)) {
            const cacheKey = mdblistCacheKey(mediaType, item.id);
            cacheWrites.push(() => setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL));
          }
        }
        // No log for the shortfall: it is expected, and a marked id drops out of
        // the next run's page on its own. A real coverage collapse still shows
        // up as missing ratings and in /api/admin/debug/ratings-state.
      } else if (arr.length === 0) {
        // An empty array likely means MDBList had a transient issue, not that all items are absent —
        // skip negative-caching to avoid poisoning future lookups.
        console.warn(`[mdblist] batch ${mediaType} returned empty array for ${page.length} items — skipping NOT_FOUND caching`);
      } else {
        console.warn(`[mdblist] batch ${mediaType} returned ${unmatchedRows} unmatched row(s) (${arr.length} rows for ${page.length} ids) — skipping NOT_FOUND caching for omitted ids`);
      }

      // Flush this page's cache writes a few at a time. A failed write jumps to
      // the catch below, which logs and moves on to the next page — caching is
      // best-effort.
      await mapLimit(cacheWrites, MDBLIST_CACHE_WRITE_CONCURRENCY, (w) => w());
    } catch (err) {
      const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
      console.error(`[mdblist] batch error for ${mediaType}: ${reason}`);
      if (pageFailed()) break;
    }
  }

  return result;
}

// Coalesce concurrent cold-miss callers — see omdb.ts inflightCold rationale.
// Process-wide (guardrail 27a), keyed by the cache key AND the caller class
// (coldInflightKey): a page joining a background call would share its refusal
// at the reserve.
const mdblistInflightCold = processSingleton("mdblist:inflight-cold", () => new Map<string, Promise<MdblistResult>>());

function coldInflightKey(cacheKey: string, opts: MdblistCallOptions): string {
  return `${cacheKey}|${opts.background ? "bg" : "fg"}`;
}

// Public entry: cache-first (stale-while-revalidate) MDBList ratings lookup keyed by
// TMDB id. A stale row is served immediately and its refresh is DETACHED.
export function getMdblistRatingsForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
  opts: MdblistCallOptions = {},
): Promise<MdblistResult> {
  return readMdblistForTmdb(tmdbId, mediaType, releaseDate, false, opts);
}

// The batch counterpart (guardrail 31a): the same read, except that a stale row's
// refresh is AWAITED. Wrapping the getter in mapLimit/Promise.all bounds only the
// cache read — every detached upstream GET starts together no matter what limit
// the caller picked. A caller that refreshes a LIST of stale rows one by one (the
// ratings cron's per-item pass, once its batch pre-warm has failed or is locked
// out) must use this so its limit covers the upstream work too. The twin of
// omdb.ts's revalidateOmdbForTmdb.
//
// A refresh already in flight is not waited on: whoever started it owns it.
export async function revalidateMdblistForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
  opts: MdblistCallOptions = {},
): Promise<void> {
  await readMdblistForTmdb(tmdbId, mediaType, releaseDate, true, opts);
}

async function readMdblistForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate: string | null | undefined,
  awaitRefresh: boolean,
  opts: MdblistCallOptions,
): Promise<MdblistResult> {
  const cacheKey = mdblistCacheKey(mediaType, tmdbId);
  const { value: cached, isStale } = await getCacheStale<MdblistRatings | typeof NOT_FOUND_SENTINEL>(cacheKey);

  if (cached !== null) {
    if (isStale) {
      if (!mdblistRevalidating.has(cacheKey)) {
        mdblistRevalidating.add(cacheKey);
        const refresh = fetchAndCacheMdblistForTmdb(tmdbId, mediaType, cacheKey, releaseDate, opts).catch(() => {}).finally(() => {
          mdblistRevalidating.delete(cacheKey);
        });
        if (awaitRefresh) await refresh;
      }
    }
    if ("_notFound" in cached) return { found: false, keyConfigured: true };
    return { found: true, data: cached };
  }

  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  const inflightKey = coldInflightKey(cacheKey, opts);
  const existing = mdblistInflightCold.get(inflightKey);
  if (existing) return existing;
  const p = fetchAndCacheMdblistForTmdb(tmdbId, mediaType, cacheKey, releaseDate, opts)
    .finally(() => mdblistInflightCold.delete(inflightKey));
  mdblistInflightCold.set(inflightKey, p);
  return p;
}

// Admin connection test. Ignores the pause and the budget (a recovered or
// replaced key must be checkable at once) but still goes through mdblistRequest,
// so the reply's usage report is what the settings page shows next.
export async function testMdblistConnection(): Promise<string> {
  const apiKey = await getApiKey({ fresh: true });
  if (!apiKey) throw new Error("No MDBList API key configured");

  const url = new URL(`${MDBLIST_REST_BASE}tmdb/show/1396/`);
  url.searchParams.set("apikey", apiKey);

  const res = await mdblistRequest(url.toString());
  if (!res.ok) throw new Error(`MDBList returned HTTP ${res.status}`);

  const data = await res.json() as unknown;

  const errMsg = mdblistErrorMessage(data, "unknown error");
  if (errMsg) throw new Error(`MDBList: ${errMsg}`);
  const title = (data as { title?: unknown } | null)?.title;
  return typeof title === "string" ? title : "OK";
}

import type { TmdbMedia } from "./tmdb-types";

interface MdblistListMeta {
  id: number;
  name: string;
  slug: string;
  items: number;
  likes: number;
}

interface MdblistListItem {
  id: number;
  rank: number;
  title: string;
  year: number | null;
  mediatype: string;
  imdb_id: string | null;
  tmdb_id: number | null;
  score: number | null;
}

// `opts.background` marks a cron caller (the warm-list-cache job): it stops at
// the reserve kept for pages (guardrail 31b). Coalesced callers share whichever
// call started first.
export async function getMdblistTopLists(limit = 10, opts: MdblistCallOptions = {}): Promise<MdblistListMeta[]> {
  const key = "mdblist:top-lists";
  return coalesce(key, async () => {
  const cached = await getCache<MdblistListMeta[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];
  if (await checkMdblistPause(opts)) return [];

  try {
    const url = new URL(`${MDBLIST_REST_BASE}lists/top`);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("limit", String(limit));

    const res = await mdblistRequest(url.toString());
    if (res.status === 429) { pauseForLimit(res.headers, await errorTextOf(res), "HTTP 429 on top lists"); return []; }
    if (!res.ok) return [];

    const data = await res.json() as unknown;
    // MDBList signals quota/auth failures as HTTP 200 with an { error } object
    // body (same shape the single-item path handles). Returning that object as
    // a list crashed getMdblistTopRated on `lists.map` — surface the error,
    // trip the lockout on quota messages, and only ever return an array.
    const errMsg = mdblistErrorMessage(data);
    if (errMsg) {
      if (isQuotaErrorMessage(errMsg)) pauseForLimit(res.headers, errMsg, "on top lists");
      console.warn(`[mdblist] top lists API error: ${sanitizeForLog(errMsg)}`);
    }
    if (!Array.isArray(data)) return [];
    const lists = data as MdblistListMeta[];
    if (lists.length > 0) await setCache(key, lists, TTL.DISCOVER);
    return lists;
  } catch (err) {
    console.error("[mdblist] Failed to fetch top lists:", err);
    return [];
  }
  });
}

// Fetches one list, distinguishing a genuine empty list (ok:true, items:[]) from
// a FAILED fetch (ok:false). The aggregate below needs that split so it never
// caches a partial union for 12h — the exact failure mode trakt.ts's `complete`
// flag exists to prevent. The per-list cache row is still only written on
// success, so a failure never poisons this list's own cache either.
async function fetchMdblistListItemsWithStatus(
  listId: number,
  opts: MdblistCallOptions = {},
): Promise<{ items: TmdbMedia[]; ok: boolean }> {
  // ONE cache row per list, holding every item (movies and TV together).
  // Callers filter by type in memory, so one upstream fetch serves both, and
  // coalesce merges the movie + TV requests the /top page fires at once.
  const key = `mdblist:list:${listId}`;
  return coalesce(key, async (): Promise<{ items: TmdbMedia[]; ok: boolean }> => {
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return { items: cached, ok: true };

  const apiKey = await getApiKey();
  if (!apiKey) return { items: [], ok: false };
  if (await checkMdblistPause(opts)) return { items: [], ok: false };

  try {
    const url = new URL(`${MDBLIST_REST_BASE}lists/${listId}/items`);
    url.searchParams.set("apikey", apiKey);

    const res = await mdblistRequest(url.toString());
    if (res.status === 429) { pauseForLimit(res.headers, await errorTextOf(res), "HTTP 429 on list items"); return { items: [], ok: false }; }
    if (!res.ok) return { items: [], ok: false };

    const data = await res.json() as MdblistListItem[];
    if (!Array.isArray(data)) return { items: [], ok: false };

    // Dedup on type+id: movie and TV ids are independent TMDB namespaces, and
    // this projection is unfiltered, so a bare-id set would drop a legitimate
    // cross-type pair.
    const seen = new Set<string>();
    const result: TmdbMedia[] = [];
    for (const item of data) {
      if (!item.tmdb_id || item.tmdb_id <= 0) continue;
      const itemType = item.mediatype === "show" ? "tv" : "movie";
      const dedupKey = `${itemType}:${item.tmdb_id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      result.push({
        id: item.tmdb_id,
        mediaType: itemType as "movie" | "tv",
        title: item.title ?? "",
        overview: "",
        posterPath: null,
        backdropPath: null,
        releaseDate: null,
        releaseYear: item.year ? String(item.year) : null,
        voteAverage: 0,
      });
    }

    // A genuinely-empty list is a SUCCESS (ok:true) — just nothing to cache.
    if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return { items: result, ok: true };
  } catch (err) {
    console.error("[mdblist] Failed to fetch list items:", err);
    return { items: [], ok: false };
  }
  });
}

export async function getMdblistListItems(
  listId: number,
  mediaType?: "movie" | "tv",
): Promise<TmdbMedia[]> {
  const { items } = await fetchMdblistListItemsWithStatus(listId);
  return mediaType ? items.filter((m) => m.mediaType === mediaType) : items;
}

// `opts.background`: see getMdblistTopLists. Pages pass nothing.
export async function getMdblistTopRated(
  mediaType: "movie" | "tv",
  maxLists = 5,
  opts: MdblistCallOptions = {},
): Promise<TmdbMedia[]> {
  const key = `mdblist:top-rated:${mediaType}`;
  // coalesce: the /top page and /api/top-rated both call this per request, so
  // simultaneous cold-cache callers must share one list fan-out (guardrail 31
  // — same shape as the trakt/tmdb list helpers).
  return coalesce(key, async () => {
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const lists = await getMdblistTopLists(maxLists, opts);
  if (lists.length === 0) return [];

  const settled = await Promise.all(
    lists.map((l) => fetchMdblistListItemsWithStatus(l.id, opts)),
  );
  // If ANY list failed (quota lockout, 429, transient error), the union is a
  // partial picture — cache it and the 12h hard TTL would pin the truncated
  // list, and the cache-first read (including the warm cron's own next run)
  // could never repair it until it expired. Serve the partial this once, but
  // don't cache it; the next call retries the failed lists. (trakt.ts's
  // `complete` gate, applied to this fan-out.)
  const allOk = settled.every((s) => s.ok);

  const seen = new Set<number>();
  const result: TmdbMedia[] = [];
  for (const { items } of settled) {
    for (const item of items) {
      if (item.mediaType !== mediaType) continue;
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    }
  }

  if (result.length > 0 && allOk) await setCache(key, result, TTL.DISCOVER);
  return result;
  });
}
