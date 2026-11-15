import "server-only";
import { createHmac } from "node:crypto";
import { prisma } from "./prisma";
import { check, v } from "./validate";
import { getCacheStale, setCache, libraryDetailsTtl } from "./tmdb-cache";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { tmdbAuth } from "./tmdb-auth";
import { processSingleton } from "./process-singleton";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { upstreamFailed, upstreamMissing, upstreamOk, type UpstreamFailed, type UpstreamResult } from "./upstream-result";

const OMDB_BASE = "https://www.omdbapi.com";
const OMDB_FETCH_TIMEOUT_MS = 10_000;

// Negative-cache TTL scales with title age. A fresh release may simply not be
// indexed by OMDB YET, so its absence re-verifies daily; a back-catalog title
// (or one with no parseable date) absent from OMDB is essentially permanent —
// re-verifying it every daily prewarm run burned one OMDB call per absent
// library item per day, forever. 7 days keeps those to ~4 calls/month while
// still self-healing if OMDB ever gains the title.
const OMDB_NEGATIVE_TTL_FRESH = 24 * 60 * 60;
const OMDB_NEGATIVE_TTL_BACK_CATALOG = 7 * 24 * 60 * 60;
const FRESH_RELEASE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function omdbNegativeTtl(releaseDate?: string | null): number {
  if (releaseDate) {
    const t = Date.parse(releaseDate);
    if (Number.isFinite(t) && Date.now() - t < FRESH_RELEASE_WINDOW_MS) return OMDB_NEGATIVE_TTL_FRESH;
  }
  return OMDB_NEGATIVE_TTL_BACK_CATALOG;
}

// What an OMDb `Error` string means. OMDB returns quota/auth failures with
// Response="False" and an Error string — sometimes as HTTP 200, but its
// key-validation layer (which also owns the daily request counter) demonstrably
// answers HTTP 401 with the same JSON body ("Invalid API key!", "Request limit
// reached!"). Both transports carry the same discrimination problem, so ONE
// classifier reads either:
//   - "quota": a rate/quota limit — trips the lockout on WHICHEVER transport;
//   - "invalidKey": the key was refused — latches the key (see noteKeyRejected),
//     never the hour-long lockout;
//   - "notFound": OMDb's own "no such title" ("Movie not found!", "Series not
//     found!", "Incorrect IMDb ID.") — the ONLY error that may be negative-cached;
//   - "other": anything else ("Error getting data.", a blank Error, a new
//     message) — an unexplained failure, never cached as "not found": a 7-day
//     tombstone for a title OMDb has is far worse than one more call.
type OmdbErrorKind = "quota" | "invalidKey" | "notFound" | "other";
export function classifyOmdbError(msg: string | undefined): OmdbErrorKind {
  const m = (msg ?? "").toLowerCase();
  if (m.includes("limit") || m.includes("quota")) return "quota";
  if (m.includes("invalid api key")) return "invalidKey";
  if (m.includes("not found") || m.includes("incorrect imdb id")) return "notFound";
  return "other";
}

// In-memory quota lockout for the current process lifetime — does not survive restarts,
// but stops the daily library prewarm and per-page lookups from hammering a key whose
// free-tier quota (1,000 requests/day) is already exhausted. Mirrors mdblist.ts.
//
// One copy for the whole server (guardrail 27a): Turbopack gives every server chunk
// its own copy of a module-level `let`, so a lockout tripped by a cron route was
// invisible to page renders, which kept calling and failing.
const lockout = processSingleton("omdb:lockout", () => ({ until: 0, transportFailures: 0 }));
const QUOTA_LOCKOUT_MS = 60 * 60 * 1000;

export function isOmdbQuotaLocked(): boolean {
  return Date.now() < lockout.until;
}

function tripQuotaLockout(reason: string) {
  lockout.until = Date.now() + QUOTA_LOCKOUT_MS;
  console.warn(`[omdb] Quota lockout tripped (${sanitizeForLog(reason)}) — suspending calls for ${QUOTA_LOCKOUT_MS / 60000} min`);
}

// ── Transport circuit breaker ──────────────────────────────────────────────
// Every tripQuotaLockout call site in this file requires a RESPONSE — a 429, or a body
// whose Error names a limit. A request that never gets one (connection refused,
// a host that blackholes, broken IPv6 in the container) therefore tripped
// nothing, and isOmdbQuotaLocked() stayed false no matter how comprehensively
// OMDB was unreachable. Every defence keyed off that flag was inert in exactly
// the case it most needed to fire, and each attempt cost a full
// OMDB_FETCH_TIMEOUT_MS to learn nothing: an unreachable host was strictly more
// expensive than an exhausted quota.
//
// Observed live: 100% of requests failing at exactly 10000ms while MDBList
// calls through the same safeFetchTrusted succeeded, so DNS, TLS and egress
// were all fine and only this host was unresponsive.
//
// Threshold rather than one-strike, deliberately: a quota response is
// authoritative on the first one, but a single timeout is a blip and must not
// disable ratings for an hour. A RUN of them is a reachability verdict. Any
// response at all — including a 4xx/5xx — proves the host is up and clears the
// count.
//
// A run must also SPAN time. Callers send several lookups at once (the prewarm
// 5, the ratings fallback 6), so one network blip that timed out a single
// batch reached the count in one go — five failures, all at the same instant,
// and an hour of no OMDb ratings for it. A real outage still trips within a
// few batches (sequential 10s timeouts span 40s by the fifth).
const TRANSPORT_FAILURE_LIMIT = 5;
const TRANSPORT_FAILURE_MIN_SPAN_MS = 30_000;
// When the current run of failures began (0 = no run). Its own singleton, so a
// lockout object an older build left behind (dev hot reload) can't lack it.
const transportRun = processSingleton("omdb:transport-run", () => ({ firstAt: 0 }));

function noteTransportSuccess(): void {
  lockout.transportFailures = 0;
  transportRun.firstAt = 0;
}

function noteTransportFailure(reason: string): void {
  const now = Date.now();
  if (lockout.transportFailures === 0) transportRun.firstAt = now;
  lockout.transportFailures++;
  if (lockout.transportFailures < TRANSPORT_FAILURE_LIMIT || now - transportRun.firstAt < TRANSPORT_FAILURE_MIN_SPAN_MS) return;
  const count = lockout.transportFailures;
  noteTransportSuccess();
  // Reuses the quota lockout rather than adding a second flag: every caller
  // already asks "should I skip OMDB right now", and unreachable and exhausted
  // are the same answer to that question (guardrail 40 reads it for that).
  tripQuotaLockout(`${count} consecutive transport failures (${sanitizeForLog(reason)})`);
}

// A failure that means "no response arrived", as opposed to one that means "the
// answer was no". ssrf-blocked/redirect/size are policy verdicts about a host
// that DID answer (or that we refuse to call) and must not count toward it.
function isTransportFailure(err: unknown): boolean {
  return err instanceof SafeFetchError && (err.reason === "timeout" || err.reason === "network");
}

// Only rate/quota conditions trip the lockout. "Invalid API key" stays transient
// (never negative-cached) but must NOT lock — it's an operator-config problem,
// and an admin actively fixing their key needs immediate feedback, not a 1h
// suspension.

// ── Rejected key ───────────────────────────────────────────────────────────
// OMDb's "Invalid API key!" (HTTP 401, or 200 with Response=False) must not
// trip the hour-long lockout above. But with nothing at all, every cold title
// on every page view paid a TMDB external_ids call plus a failing OMDb call and
// logged two error lines: up to 200 of each per ratings batch.
//
// So the KEY is remembered instead. While the stored key is the one OMDb
// refused, fetchAndCacheOmdbForTmdb answers transient without any network. A
// changed key is a different value, so it is tried at once (within getApiKey's
// 30s memo); a successful Settings → Test clears it; and the same key is tried
// again after REJECTED_KEY_RETRY_MS, because a new OMDb key answers "Invalid
// API key!" until its owner clicks the activation email. Process-wide
// (guardrail 27a). Logged once per key (guardrail 7b).
const REJECTED_KEY_RETRY_MS = 60 * 60 * 1000;
const REJECTED_KEY_WARN_KEY = "omdb:rejected-key";
const rejectedKey = processSingleton<{ key: string | null; until: number }>(
  "omdb:rejected-key",
  () => ({ key: null, until: 0 }),
);

function isKeyRejected(apiKey: string): boolean {
  return rejectedKey.key === apiKey && Date.now() < rejectedKey.until;
}

// The key itself never reaches the log or the dedup map: a short digest tells
// one rejected key from the next.
function keyFingerprint(apiKey: string): string {
  return createHmac("sha256", "summonarr:key-fingerprint").update(apiKey).digest("hex").slice(0, 12);
}

function noteKeyRejected(apiKey: string): void {
  rejectedKey.key = apiKey;
  rejectedKey.until = Date.now() + REJECTED_KEY_RETRY_MS;
  warnOnChange(
    REJECTED_KEY_WARN_KEY,
    keyFingerprint(apiKey),
    "[omdb] OMDb refused the API key (\"Invalid API key!\") — no OMDb ratings until the key is changed or Settings → Test succeeds; the same key is retried hourly",
  );
}

// OMDb answered with this key: whatever it refused before, it takes it now.
function noteKeyAccepted(apiKey: string): void {
  if (rejectedKey.key !== apiKey) return;
  rejectedKey.key = null;
  rejectedKey.until = 0;
  forgetWarnOnChange(REJECTED_KEY_WARN_KEY);
}

// The rejected-key error: transient like any other (never negative-cached), but
// not logged per title — noteKeyRejected has said it once.
class OmdbKeyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmdbKeyRejectedError";
  }
}

// Sentinel stored in the cache to distinguish "item not in OMDB" from "never fetched" so we don't
// re-query OMDB on every page load for titles it genuinely doesn't know about.
const NOT_FOUND_SENTINEL = { _notFound: true } as const;

// In-memory dedup prevents concurrent requests from spawning multiple background revalidations for
// the same cache key during a single request burst. Process-wide (guardrail 27a).
const revalidating = processSingleton("omdb:revalidating", () => new Set<string>());

// The one name of a title's OMDb ratings row in TmdbCache.
export function omdbCacheKey(mediaType: "movie" | "tv", tmdbId: number): string {
  return `omdb:tmdb:${mediaType}:${tmdbId}`;
}

export interface OmdbRatings {
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  metacritic: string | null;
}

// The OMDB API key lives in a single Setting row that changes only when an admin
// edits it. A blocking ratings batch resolves up to 200 misses and each miss
// calls getApiKey twice (once here, once in fetchAndCacheOmdbForTmdb) — without
// memoization that is ~400 identical setting.findUnique reads against the small
// Prisma pool per request. Cache the resolved value for a short window, and
// coalesce concurrent cold reads into one query, so a key change still
// propagates within seconds. Pass { fresh: true } to bypass the cache (admin
// connection test, where stale-by-up-to-TTL would be confusing). Process-wide
// (guardrail 27a).
const API_KEY_TTL_MS = 30_000;
const apiKeyMemo = processSingleton<{
  cache: { value: string | null; at: number } | null;
  inflight: Promise<string | null> | null;
  // Bumped by every fresh read: an older read that finishes later must not
  // overwrite what the fresh one stored.
  generation: number;
}>("omdb:api-key", () => ({ cache: null, inflight: null, generation: 0 }));

async function getApiKey(opts: { fresh?: boolean } = {}): Promise<string | null> {
  const memo = apiKeyMemo.cache;
  if (!opts.fresh && memo && Date.now() - memo.at < API_KEY_TTL_MS) {
    return memo.value;
  }
  if (!opts.fresh && apiKeyMemo.inflight) return apiKeyMemo.inflight;
  if (opts.fresh) apiKeyMemo.generation += 1;
  const generation = apiKeyMemo.generation;
  const p = (async () => {
    const row = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
    const value = row?.value.trim() || null;
    if (generation === apiKeyMemo.generation) apiKeyMemo.cache = { value, at: Date.now() };
    return value;
  })();
  if (!opts.fresh) {
    apiKeyMemo.inflight = p;
    p.finally(() => { apiKeyMemo.inflight = null; }).catch(() => {});
  }
  return p;
}

// The fields of an OMDb answer this module reads, each narrowed on its own: a
// field of the wrong type reads as absent instead of flowing into the cache and
// the UI as a non-string. Null when the body is not an object at all.
interface OmdbBody {
  response: string | undefined;
  error: string | undefined;
  title: string | undefined;
  imdbRating: string | undefined;
  imdbVotes: string | undefined;
  metascore: string | undefined;
  rottenTomatoes: string | undefined;
}

const strOf = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

function readOmdbBody(raw: unknown): OmdbBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  // The Ratings array is consulted ONLY for Rotten Tomatoes.
  const rt = Array.isArray(b.Ratings)
    ? b.Ratings.find((r): r is { Value?: unknown } => !!r && typeof r === "object" && (r as { Source?: unknown }).Source === "Rotten Tomatoes")
    : undefined;
  return {
    response: strOf(b.Response),
    error: strOf(b.Error),
    title: strOf(b.Title),
    imdbRating: strOf(b.imdbRating),
    imdbVotes: strOf(b.imdbVotes),
    metascore: strOf(b.Metascore),
    rottenTomatoes: strOf(rt?.Value),
  };
}

// OMDb writes "N/A" for a field it has no value for.
const present = (value: string | undefined): string | null => (value && value !== "N/A" ? value : null);

function ratingsFromBody(imdbId: string, body: OmdbBody): OmdbRatings {
  const metascore = present(body.metascore);
  return {
    imdbId,
    imdbRating: present(body.imdbRating),
    imdbVotes: present(body.imdbVotes),
    rottenTomatoes: present(body.rottenTomatoes),
    metacritic: metascore ? `${metascore}/100` : null,
  };
}

// The failure an OMDb error body is, acted on: a quota trips the lockout (on
// either transport), a refused key is latched and failed with
// OmdbKeyRejectedError (logged once per key, not per title).
function failForOmdbError(apiKey: string, imdbId: string, kind: OmdbErrorKind, error: string | undefined, message: string): UpstreamFailed {
  if (kind === "quota") tripQuotaLockout(`${error ?? ""} for ${imdbId}`);
  if (kind === "invalidKey") {
    noteKeyRejected(apiKey);
    return upstreamFailed(new OmdbKeyRejectedError(message));
  }
  return upstreamFailed(new Error(message));
}

// Direct OMDB lookup by IMDb ID, as an answer or a failure: "ok" with the
// ratings, "missing" for OMDb's own "no such title", "failed" for everything
// else (network/timeout, a lockout, a refused key, a 5xx, an unexplained error
// body) — which says nothing about the title and is never cached as an answer.
//
// Deliberately CACHE-FREE — the tmdb-keyed rows written by
// fetchAndCacheOmdbForTmdb are the app's one OMDB cache layer. The old
// imdb-keyed `omdb:<imdbId>` rows were written on every fetch but essentially
// never read, doubling every OMDB cache write for no serving value.
async function lookupOmdb(imdbId: string, apiKey: string): Promise<UpstreamResult<OmdbRatings>> {
  // Quota lockout: skip the network entirely.
  if (isOmdbQuotaLocked()) {
    return upstreamFailed(new Error(`OMDB quota locked — skipping fetch for ${sanitizeForLog(imdbId)}`));
  }

  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", imdbId);

  let res: Response;
  try {
    res = await safeFetchTrusted(url.toString(), { allowedHosts: ["www.omdbapi.com"], timeoutMs: OMDB_FETCH_TIMEOUT_MS });
  } catch (err) {
    if (isTransportFailure(err)) noteTransportFailure((err as SafeFetchError).reason);
    return upstreamFailed(err);
  }
  // A response of ANY status proves the host is reachable.
  noteTransportSuccess();

  if (!res.ok) {
    if (res.status === 429) {
      res.body?.cancel().catch(() => {});
      tripQuotaLockout(`HTTP 429 for ${imdbId}`);
      return upstreamFailed(new Error(`OMDB API returned 429 for ${sanitizeForLog(imdbId)}`));
    }
    // OMDB's key layer sends "Request limit reached!" as HTTP 401 + JSON body —
    // read it defensively and run the SAME classification as the 200 path, or
    // real daily exhaustion never trips the lockout and every quota defense
    // keyed off it stays inert. A non-2xx is never "not found", whatever its
    // body says.
    const body = readOmdbBody(await res.json().catch(() => null));
    const message = `OMDB API returned ${res.status} for ${sanitizeForLog(imdbId)}`;
    return failForOmdbError(apiKey, imdbId, classifyOmdbError(body?.error), body?.error, message);
  }

  let body: OmdbBody | null;
  try {
    body = readOmdbBody(await res.json());
  } catch (err) {
    return upstreamFailed(err);
  }
  if (!body) return upstreamFailed(new Error(`OMDB answered ${sanitizeForLog(imdbId)} with no JSON object`));
  if (body.response !== "True") {
    const kind = classifyOmdbError(body.error);
    if (kind === "notFound") {
      // A genuine not-found: OMDb took the key.
      noteKeyAccepted(apiKey);
      return upstreamMissing();
    }
    const message = `OMDB transient error for ${sanitizeForLog(imdbId)}: ${sanitizeForLog(body.error ?? "no error text")}`;
    return failForOmdbError(apiKey, imdbId, kind, body.error, message);
  }

  noteKeyAccepted(apiKey);
  return upstreamOk(ratingsFromBody(imdbId, body));
}

// Logs a failed lookup once — a refused key was logged once already, by key,
// not per title.
function logLookupFailure(imdbId: string, err: unknown): void {
  if (err instanceof OmdbKeyRejectedError) return;
  const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
  console.error(`[omdb] fetch failed for ${sanitizeForLog(imdbId)}: ${sanitizeForLog(reason)}`);
}

// The raw IMDb-id lookup with its long-standing contract: the ratings, null for
// an authoritative not-found (or no key configured), a throw for every other
// failure. fetchAndCacheOmdbForTmdb reads lookupOmdb's result directly.
export async function getOmdbRatings(imdbId: string): Promise<OmdbRatings | null> {
  // Lockout: throw — the transient semantics — WITHOUT the key read or a log.
  if (isOmdbQuotaLocked()) {
    throw new Error(`OMDB quota locked — skipping fetch for ${sanitizeForLog(imdbId)}`);
  }
  const apiKey = await getApiKey();
  if (!apiKey) return null;
  const result = await lookupOmdb(imdbId, apiKey);
  if (result.kind === "ok") return result.value;
  if (result.kind === "missing") return null;
  logLookupFailure(imdbId, result.error);
  throw result.error;
}

// Admin connection test. Intentionally ignores the quota lockout and the rejected-key
// latch (and bypasses the key cache via { fresh: true }) so a recovered or replaced key
// can be verified immediately instead of waiting out the remainder of a suspension. A
// pass clears the latch for that key.
// The test answer's three fields; anything else in the payload is dropped.
const TEST_ANSWER = v.object({
  Response: v.string(),
  Title: v.optional(v.string()),
  Error: v.optional(v.string()),
});

export async function testOmdbConnection(): Promise<string> {
  const apiKey = await getApiKey({ fresh: true });
  if (!apiKey) throw new Error("No OMDB API key configured");

  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", "tt0133093");

  const res = await safeFetchTrusted(url.toString(), { allowedHosts: ["www.omdbapi.com"], timeoutMs: OMDB_FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`OMDB returned HTTP ${res.status}`);

  const checked = check(TEST_ANSWER, await res.json() as unknown);
  if (!checked.ok) throw new Error("OMDB returned an unreadable answer");
  const data = checked.value;
  if (data.Response !== "True") throw new Error(data.Error ?? "OMDB API key invalid");
  noteKeyAccepted(apiKey);
  return data.Title ?? "OK";
}

export type OmdbResult =
  | { found: true; data: OmdbRatings }
  // `transient` marks a failure that is NOT an authoritative "no ratings" (network/timeout,
  // 5xx, quota/auth error) so callers must not pin a null/not-found into a long-lived cache.
  // `quotaExhausted` additionally flags the in-process quota lockout (mirrors MdblistResult).
  // `tmdbUnconfigured` marks the no-TMDB-token miss: neither transient nor negative-cached,
  // but not an authoritative absence either — the prewarm counts it as `failed` so a
  // missing TMDB_READ_TOKEN can't read as a green run in the cron history.
  // `keyRejected` marks the transient miss of a key OMDb refused (latched, see
  // noteKeyRejected): every other title would answer the same, so a job walking
  // a library can stop.
  | { found: false; keyConfigured: boolean; quotaExhausted?: boolean; transient?: boolean; tmdbUnconfigured?: true; keyRejected?: true };

// The tmdbId→imdbId resolve, isolated so fetchAndCacheOmdbForTmdb can run it
// zero times (a caller-supplied known id), once (the normal cold path), or a
// second time (the remap self-heal below). Outcomes beyond a resolved id keep
// their pre-existing semantics exactly: "noAuth" = no TMDB token (non-transient
// miss, no negative-cache), "gone" = TMDB 404 (authoritative — the tmdbId
// doesn't exist for this media type, so it IS negative-cached; left transient,
// a blocking ratings batch of bogus ids would re-hit TMDB on every load),
// "transient" = any other non-OK.
type ImdbResolve =
  | { kind: "id"; imdbId: string | null }
  | { kind: "noAuth" }
  | { kind: "gone" }
  | { kind: "transient" };

async function resolveImdbIdViaTmdb(tmdbId: number, mediaType: "movie" | "tv"): Promise<ImdbResolve> {
  const auth = tmdbAuth();
  if (!auth) return { kind: "noAuth" };

  const extUrl = new URL(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids`);
  const extRes = await safeFetchTrusted(extUrl.toString(), {
    allowedHosts: ["api.themoviedb.org"],
    headers: auth.headers,
    timeoutMs: OMDB_FETCH_TIMEOUT_MS,
  });
  if (!extRes.ok) {
    // Unread bodies hold their socket until GC.
    extRes.body?.cancel().catch(() => {});
    if (extRes.status === 404) return { kind: "gone" };
    console.warn(`[omdb] TMDB external_ids fetch failed (${sanitizeForLog(extRes.status)}) for ${sanitizeForLog(mediaType)}:${sanitizeForLog(tmdbId)}`);
    return { kind: "transient" };
  }
  const ext: unknown = await extRes.json();
  if (!ext || typeof ext !== "object") return { kind: "transient" };
  const imdbId = (ext as { imdb_id?: unknown }).imdb_id;
  // A non-string id is no id: TMDB's answer, an absent IMDb entry.
  return { kind: "id", imdbId: typeof imdbId === "string" && imdbId ? imdbId : null };
}

// What OMDb holds for a TMDB title, with the tmdb→imdb resolve folded in.
// "missing" is authoritative (TMDB 404 for the id, no IMDb id, or OMDb's own
// "no such title" after the remap self-heal); "noAuth" is the no-TMDB-token
// miss; "failed" is any failure.
type TmdbOmdbAnswer =
  | { kind: "ok"; ratings: OmdbRatings }
  | { kind: "missing" }
  | { kind: "noAuth" }
  | { kind: "failed"; error: unknown };

function answerForResolve(r: Exclude<ImdbResolve, { kind: "id" }>): TmdbOmdbAnswer {
  if (r.kind === "noAuth") return { kind: "noAuth" };
  if (r.kind === "gone") return { kind: "missing" };
  return { kind: "failed", error: new Error("TMDB external_ids resolve failed") };
}

async function lookupOmdbForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  apiKey: string,
  knownImdbId: string | null,
): Promise<TmdbOmdbAnswer> {
  let imdbId = knownImdbId;
  const hinted = imdbId !== null;
  if (!hinted) {
    const resolved = await resolveImdbIdViaTmdb(tmdbId, mediaType);
    if (resolved.kind !== "id") return answerForResolve(resolved);
    imdbId = resolved.imdbId;
  }

  let result: UpstreamResult<OmdbRatings> = imdbId ? await lookupOmdb(imdbId, apiKey) : upstreamMissing();
  if (result.kind === "missing" && hinted) {
    // The hinted id is authoritatively unknown to OMDB — either a stale stored
    // id or a rare imdb-id remap. Re-resolve live ONCE before negative-caching
    // so the remap self-heals instead of negative-caching ("tombstoning") the
    // title on the strength of a hint.
    const resolved = await resolveImdbIdViaTmdb(tmdbId, mediaType);
    if (resolved.kind !== "id") return answerForResolve(resolved);
    if (resolved.imdbId && resolved.imdbId !== imdbId) {
      imdbId = resolved.imdbId;
      result = await lookupOmdb(imdbId, apiKey);
    }
  }
  if (result.kind === "failed") {
    if (imdbId) logLookupFailure(imdbId, result.error);
    return { kind: "failed", error: result.error };
  }
  if (result.kind === "missing" || !imdbId) return { kind: "missing" };
  return { kind: "ok", ratings: { ...result.value, imdbId } };
}

// OMDB only accepts IMDb IDs, not TMDB IDs — we must resolve via TMDB's external_ids endpoint first.
// If TMDB returns no IMDb ID the item has no OMDB entry and is negative-cached immediately.
// `knownImdbId` skips that resolve: the tmdb→imdb mapping is effectively immutable, and
// re-buying it on every refresh doubled the upstream call count of the steady-state path
// (SWR revalidations and the prewarm both refresh from a stored row that already carries
// the id; the detail pages fetch external_ids in their append_to_response anyway).
//
// Only an ANSWER is cached: ratings, or an authoritative not-found as the
// NOT_FOUND sentinel. A failure caches nothing and reads `transient`.
export async function fetchAndCacheOmdbForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
  knownImdbId?: string | null,
): Promise<OmdbResult> {
  const cacheKey = omdbCacheKey(mediaType, tmdbId);
  // A settings read that throws rejects (the prewarm counts it as a failed item).
  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  // Quota lockout: return without touching the network (this also skips the TMDB
  // external_ids resolve — pointless work when the OMDB call it feeds can't run).
  // `transient` ensures no caller negative-caches the miss.
  if (isOmdbQuotaLocked()) {
    return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
  }
  // The stored key is one OMDb refused (see noteKeyRejected): nothing to ask.
  if (isKeyRejected(apiKey)) {
    return { found: false, keyConfigured: true, transient: true, keyRejected: true };
  }

  try {
    const answer = await lookupOmdbForTmdb(tmdbId, mediaType, apiKey, knownImdbId ?? null);
    switch (answer.kind) {
      case "noAuth":
        return { found: false, keyConfigured: true, tmdbUnconfigured: true };
      case "failed":
        return answer.error instanceof OmdbKeyRejectedError
          ? { found: false, keyConfigured: true, transient: true, keyRejected: true }
          : { found: false, keyConfigured: true, transient: true };
      case "missing":
        await setCache(cacheKey, NOT_FOUND_SENTINEL, omdbNegativeTtl(releaseDate));
        return { found: false, keyConfigured: true };
      case "ok":
        await setCache(cacheKey, answer.ratings, libraryDetailsTtl(releaseDate));
        return { found: true, data: answer.ratings };
    }
  } catch (err) {
    // A throw here is a TMDB resolve that never answered or a cache write —
    // never an answer about the title, so nothing is negative-cached.
    const msg = err instanceof SafeFetchError
      ? `${err.reason}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.error(`[omdb] Error fetching for ${sanitizeForLog(mediaType)}:${tmdbId}: ${sanitizeForLog(msg)}`);
    return { found: false, keyConfigured: true, transient: true };
  }
}

// In-flight cold-miss fetches keyed by cacheKey. Concurrent callers for the same
// (mediaType, tmdbId) reuse the existing promise instead of fanning out a herd
// of upstream requests when the cache is cold. The pre-existing `revalidating`
// Set only covered the SWR-revalidation path, leaving cold-miss susceptible to
// a stampede when many pages load simultaneously. Process-wide (guardrail 27a).
const inflightCold = processSingleton("omdb:inflight-cold", () => new Map<string, Promise<OmdbResult>>());

// Public entry: cache-first (stale-while-revalidate) OMDB ratings lookup keyed by TMDB id,
// coalescing concurrent cold misses into one upstream fetch. `knownImdbId` (optional —
// e.g. the detail pages already hold external_ids from their append_to_response) spares
// the cold path its TMDB resolve; the SWR path prefers the STALE ROW's own stored id,
// which is fresher than any caller hint.
export function getOmdbRatingsForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
  knownImdbId?: string | null,
): Promise<OmdbResult> {
  return readOmdbForTmdb(tmdbId, mediaType, releaseDate, knownImdbId, false);
}

// The batch counterpart: the same read, except that a stale row's refresh is AWAITED.
//
// getOmdbRatingsForTmdb serves a stale row immediately and DETACHES its refresh, so
// wrapping it in mapLimit bounds only the cache read — the upstream calls all start
// together no matter what limit the caller picked. A stale sentinel's refresh starts
// with a TMDB external_ids lookup, and a few hundred of those at once is how the
// ratings refresh after a recommendations run got answered with a wall of TMDB 429s.
// A caller that refreshes a LIST must use this, so its concurrency limit covers the
// upstream work too.
//
// A refresh already in flight is not waited on: whoever started it owns it.
export async function revalidateOmdbForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
): Promise<void> {
  await readOmdbForTmdb(tmdbId, mediaType, releaseDate, null, true);
}

async function readOmdbForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate: string | null | undefined,
  knownImdbId: string | null | undefined,
  awaitRefresh: boolean,
): Promise<OmdbResult> {
  const cacheKey = omdbCacheKey(mediaType, tmdbId);
  const { value: cached, isStale } = await getCacheStale<OmdbRatings | typeof NOT_FOUND_SENTINEL>(cacheKey);

  if (cached !== null) {
    if (isStale) {
      if (!revalidating.has(cacheKey)) {
        revalidating.add(cacheKey);
        // A found-shape stale row carries the imdbId it was fetched with — reuse
        // it so the background refresh skips the TMDB external_ids round-trip
        // (the remap self-heal in fetchAndCacheOmdbForTmdb covers a stale id).
        const storedImdbId = "_notFound" in cached ? null : cached.imdbId;
        const refresh = fetchAndCacheOmdbForTmdb(tmdbId, mediaType, releaseDate, storedImdbId).catch(() => {}).finally(() => {
          revalidating.delete(cacheKey);
        });
        if (awaitRefresh) await refresh;
      }
    }
    if ("_notFound" in cached) return { found: false, keyConfigured: true };
    return { found: true, data: cached };
  }

  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  const existing = inflightCold.get(cacheKey);
  if (existing) return existing;
  const p = fetchAndCacheOmdbForTmdb(tmdbId, mediaType, releaseDate, knownImdbId)
    .finally(() => inflightCold.delete(cacheKey));
  inflightCold.set(cacheKey, p);
  return p;
}
