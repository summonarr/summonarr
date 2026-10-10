import "server-only";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { processSingleton } from "@/lib/process-singleton";
import { isFeatureEnabled } from "@/lib/features";
import { sanitizeForLog } from "@/lib/sanitize";
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { canAutoRequest } from "@/lib/permissions";
import {
  WATCHLIST_AUTO_REQUEST_FEATURE_KEY,
  fileAutoRequestTitles,
  hasAutoRequestBit,
  type AutoRequestOutcome,
  type AutoRequestTally,
} from "@/lib/auto-request";

// A user's OWN Trakt account (guardrail 34c). Two uses, each the user's choice:
//
//   - WATCHLIST AUTO-REQUEST: the cron reads their Trakt watchlist and files new
//     titles through fileAutoRequestTitles — the same ledger, per-run cap and
//     request chokepoint as the Plex watchlist (guardrail 34b). For a Jellyfin
//     user this IS the watchlist: Jellyfin favorites only hold titles the
//     library already has, which the request chokepoint answers "already
//     available", so a Jellyfin-side watchlist can never file anything.
//   - FOR YOU SEEDS: the cron imports their Trakt watch history into
//     TraktWatchedItem, which the seed selection reads as watch history. The
//     recommendation engine makes no upstream call (guardrail 40), so the
//     history must be local before the warm run selects seeds.
//
// CONNECTING. OAuth device-code flow: the user is shown a short code to enter at
// trakt.tv/activate. No redirect URI to register — a self-hosted instance has no
// fixed public URL to give Trakt — and the user's Trakt password never touches
// Summonarr. The admin supplies the Trakt app's client id (the existing
// traktClientId setting) and its client secret (traktClientSecret); both are
// encrypted at rest (settings-sensitive-keys.ts).
//
// TOKENS. Stored in an Account row { provider: "trakt", providerAccountId: the
// Trakt user uuid }, whose token columns the Prisma extension encrypts on write
// (guardrail 7a — never encryptToken here). Trakt access tokens live 24 hours
// (since March 2025), so the cron refreshes one that expires within
// REFRESH_MARGIN_MS before using it; Trakt rotates the refresh token on every
// refresh, so both are written together. A refresh Trakt answers `invalid_grant`
// means the user revoked access or the grant lapsed: the token and the imported
// history are deleted and the connection reads "reauth" until they reconnect —
// the ONLY path that deletes them besides an explicit disconnect or a purge. A
// refusal of the APP's credentials (`invalid_client` — a mistyped or rotated
// client secret) is the admin's configuration, not the user's choice: it stops
// the run and deletes nothing, or one bad secret would end every connection.
//
// Every call goes to api.trakt.tv through safeFetchTrusted (guardrail 5a).

export const TRAKT_HOSTS = ["api.trakt.tv"] as const;
const TRAKT_BASE = "https://api.trakt.tv";
const TRAKT_TIMEOUT_MS = 15_000;
// The redirect_uri Trakt expects for device-code (out-of-band) grants.
const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";
// Where the user enters the code. Trakt returns this too; a value not on
// trakt.tv is replaced by this rather than shown to the user.
export const TRAKT_ACTIVATE_URL = "https://trakt.tv/activate";

export const TRAKT_CLIENT_ID_KEY = "traktClientId";
export const TRAKT_CLIENT_SECRET_KEY = "traktClientSecret";
export const FOR_YOU_FEATURE_KEY = "feature.page.forYou";

// Refresh an access token this close to its expiry before using it.
export const REFRESH_MARGIN_MS = 60 * 60 * 1000;
// Watchlist entries read per media type per run, newest-added first. A longer
// list is reached as earlier entries are requested or removed.
export const MAX_TRAKT_WATCHLIST_ITEMS = 500;
const WATCHLIST_PAGE_SIZE = 100;
// Watched titles kept per user, most recently watched first. Seed selection
// reads at most MAX_WATCH_HISTORY_SEEDS of them; the rest feed the "already
// watched" exclusion so an old watch never comes back as a recommendation.
export const MAX_TRAKT_HISTORY_ITEMS = 5_000;
// Minimum spacing between two history imports for one user. The history only
// feeds the For You warm run (every 12 hours by default), so importing it on
// every watch would rewrite thousands of rows per user per run for nothing.
export const TRAKT_HISTORY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── errors ──────────────────────────────────────────────────────────────────

// Trakt refused the user's grant (refresh 400/401): they revoked Summonarr on
// trakt.tv or the refresh token lapsed. Ends the connection until they reconnect.
export class TraktTokenRevokedError extends Error {
  constructor() {
    super("Trakt rejected the stored grant");
    this.name = "TraktTokenRevokedError";
  }
}

// Trakt refused the APP's credentials on a refresh (invalid_client): the client
// id/secret in Settings is wrong. Never a reason to touch any user's grant; the
// run stops — every remaining user would fail the same way.
export class TraktClientRejectedError extends Error {
  constructor() {
    super("Trakt rejected the app's client credentials");
    this.name = "TraktClientRejectedError";
  }
}

// Trakt answered 429. The run stops — every remaining user would hit it too.
export class TraktRateLimitedError extends Error {
  constructor() {
    super("Trakt rate limited");
    this.name = "TraktRateLimitedError";
  }
}

// ── configuration ───────────────────────────────────────────────────────────

export interface TraktOAuthConfig {
  clientId: string;
  clientSecret: string;
}

// Both halves of the Trakt app's credentials, or null when either is missing —
// the client id alone (the public popular lists) cannot run an OAuth grant.
export async function getTraktOAuthConfig(): Promise<TraktOAuthConfig | null> {
  const [idRow, secretRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: TRAKT_CLIENT_ID_KEY } }),
    prisma.setting.findUnique({ where: { key: TRAKT_CLIENT_SECRET_KEY } }),
  ]);
  const clientId = idRow?.value?.trim();
  const clientSecret = secretRow?.value?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// What a user could use a Trakt connection for right now. `watchlist` needs the
// auto-request feature AND an AUTO_REQUEST* bit; `history` needs For You.
export interface TraktUses {
  watchlist: boolean;
  history: boolean;
}

export async function traktUsesFor(permissions: bigint): Promise<TraktUses> {
  const permitted = canAutoRequest(permissions, "MOVIE") || canAutoRequest(permissions, "TV");
  const [autoRequest, forYou] = await Promise.all([
    permitted ? isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY) : Promise.resolve(false),
    isFeatureEnabled(FOR_YOU_FEATURE_KEY),
  ]);
  return { watchlist: autoRequest, history: forYou };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function traktHeaders(clientId: string, accessToken?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Trakt requires a User-Agent naming the app.
    "User-Agent": "Summonarr",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function traktPost(path: string, clientId: string, body: Record<string, unknown>): Promise<Response> {
  return safeFetchTrusted(`${TRAKT_BASE}${path}`, {
    allowedHosts: TRAKT_HOSTS,
    method: "POST",
    headers: traktHeaders(clientId),
    body: JSON.stringify(body),
    timeoutMs: TRAKT_TIMEOUT_MS,
  });
}

// An authenticated GET. 401 → `unauthorized` (the caller refreshes once and
// retries); 429 → TraktRateLimitedError; any other non-2xx throws.
async function traktGet(
  path: string,
  clientId: string,
  accessToken: string,
): Promise<{ unauthorized: true } | { unauthorized: false; body: unknown; headers: Headers }> {
  const res = await safeFetchTrusted(`${TRAKT_BASE}${path}`, {
    allowedHosts: TRAKT_HOSTS,
    headers: traktHeaders(clientId, accessToken),
    timeoutMs: TRAKT_TIMEOUT_MS,
  });
  if (res.status === 401) return { unauthorized: true };
  if (res.status === 429) throw new TraktRateLimitedError();
  if (!res.ok) throw new Error(`Trakt ${path.split("?")[0]} answered ${res.status}`);
  return { unauthorized: false, body: await res.json(), headers: res.headers };
}

// ── token bookkeeping ───────────────────────────────────────────────────────

export interface TraktTokenSet {
  accessToken: string;
  refreshToken: string;
  // Absolute expiry, epoch SECONDS (Account.expires_at's unit).
  expiresAt: number;
  tokenType: string | null;
  scope: string | null;
}

// Trakt's token response → our shape; null when a required field is missing.
// `created_at` (epoch seconds) anchors `expires_in` when present. Pure.
export function parseTraktTokenResponse(raw: unknown, nowMs: number = Date.now()): TraktTokenSet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.access_token !== "string" || r.access_token.length === 0) return null;
  if (typeof r.refresh_token !== "string" || r.refresh_token.length === 0) return null;
  const expiresIn = typeof r.expires_in === "number" && Number.isFinite(r.expires_in) && r.expires_in > 0 ? r.expires_in : 0;
  const createdAt = typeof r.created_at === "number" && Number.isFinite(r.created_at) && r.created_at > 0 ? r.created_at : Math.floor(nowMs / 1000);
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    // No expiry reported ⇒ treat as already due, so the next use refreshes.
    expiresAt: expiresIn > 0 ? Math.floor(createdAt + expiresIn) : Math.floor(nowMs / 1000),
    tokenType: typeof r.token_type === "string" ? r.token_type : null,
    scope: typeof r.scope === "string" ? r.scope : null,
  };
}

// Whether a token expiring at `expiresAt` (epoch seconds; null = unknown) must
// be refreshed before use. Pure.
export function traktTokenNeedsRefresh(expiresAt: number | null, nowMs: number = Date.now()): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return true;
  return expiresAt * 1000 - nowMs <= REFRESH_MARGIN_MS;
}

type TraktAccountRow = { id: string; access_token: string | null; refresh_token: string | null; expires_at: number | null };

// What a failed refresh means, from its status and OAuth error body. Only
// `invalid_grant` is the user's grant going away (RFC 6749 §5.2; Trakt answers it
// with 400 or 401). Any other 400/401 — `invalid_client`, or a body we cannot
// read — is treated as the app's credentials being refused: it must never end a
// connection, because a mistyped client secret would otherwise end all of them
// within a day (access tokens live 24h). Anything else is transient. Pure.
export function classifyTraktRefreshFailure(status: number, body: unknown): "revoked" | "client" | "transient" {
  if (status !== 400 && status !== 401) return "transient";
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return error === "invalid_grant" ? "revoked" : "client";
}

async function refreshTraktToken(cfg: TraktOAuthConfig, account: TraktAccountRow): Promise<string> {
  if (!account.refresh_token) throw new TraktTokenRevokedError();
  const res = await traktPost("/oauth/token", cfg.clientId, {
    refresh_token: account.refresh_token,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: OOB_REDIRECT_URI,
    grant_type: "refresh_token",
  });
  if (res.status === 429) throw new TraktRateLimitedError();
  if (!res.ok) {
    const failure = classifyTraktRefreshFailure(res.status, await res.json().catch(() => null));
    if (failure === "revoked") throw new TraktTokenRevokedError();
    if (failure === "client") throw new TraktClientRejectedError();
    throw new Error(`Trakt token refresh answered ${res.status}`);
  }
  const tokens = parseTraktTokenResponse(await res.json());
  if (!tokens) throw new Error("Trakt token refresh returned an unusable body");
  // Raw tokens — the Prisma extension encrypts both on update (guardrail 7a).
  // Written together: Trakt rotates the refresh token, so the old one is dead.
  await prisma.account.update({
    where: { id: account.id },
    data: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      ...(tokens.tokenType ? { token_type: tokens.tokenType } : {}),
      ...(tokens.scope !== null ? { scope: tokens.scope } : {}),
    },
  });
  account.access_token = tokens.accessToken;
  account.refresh_token = tokens.refreshToken;
  account.expires_at = tokens.expiresAt;
  return tokens.accessToken;
}

// A Trakt client bound to one user's grant: refreshes ahead of expiry, and once
// more on a 401 before giving up.
class TraktUserClient {
  cfg: TraktOAuthConfig;
  account: TraktAccountRow;

  constructor(cfg: TraktOAuthConfig, account: TraktAccountRow) {
    this.cfg = cfg;
    this.account = account;
  }

  async token(): Promise<string> {
    if (!this.account.access_token || traktTokenNeedsRefresh(this.account.expires_at)) {
      return refreshTraktToken(this.cfg, this.account);
    }
    return this.account.access_token;
  }

  async get(path: string): Promise<{ body: unknown; headers: Headers }> {
    const first = await traktGet(path, this.cfg.clientId, await this.token());
    if (!first.unauthorized) return first;
    const retried = await traktGet(path, this.cfg.clientId, await refreshTraktToken(this.cfg, this.account));
    if (retried.unauthorized) throw new TraktTokenRevokedError();
    return retried;
  }
}

// ── response parsing (pure) ─────────────────────────────────────────────────

export interface TraktListItem {
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV";
  title: string;
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// One /sync/watchlist entry → a list item. Seasons and episodes on a watchlist
// are not requestable as such and are skipped. Pure.
export function parseTraktWatchlistEntry(entry: unknown): TraktListItem | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { type?: unknown; movie?: unknown; show?: unknown };
  const mediaType = e.type === "movie" ? "MOVIE" : e.type === "show" ? "TV" : null;
  if (!mediaType) return null;
  const media = (mediaType === "MOVIE" ? e.movie : e.show) as { title?: unknown; ids?: { tmdb?: unknown } } | undefined;
  if (!media || typeof media !== "object") return null;
  return {
    tmdbId: positiveInt(media.ids?.tmdb),
    mediaType,
    title: typeof media.title === "string" ? media.title.slice(0, 500) : "",
  };
}

export interface TraktWatchedRow {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  plays: number;
  lastWatchedAt: Date;
}

// One /sync/watched/{movies|shows} entry → a history row; null without a TMDB
// id or a watch date (a seed is ranked by when it was watched). Pure.
export function parseTraktWatchedEntry(entry: unknown, mediaType: "MOVIE" | "TV"): TraktWatchedRow | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { plays?: unknown; last_watched_at?: unknown; movie?: unknown; show?: unknown };
  const media = (mediaType === "MOVIE" ? e.movie : e.show) as { title?: unknown; ids?: { tmdb?: unknown } } | undefined;
  if (!media || typeof media !== "object") return null;
  const tmdbId = positiveInt(media.ids?.tmdb);
  const lastWatchedAt = parseDate(e.last_watched_at);
  if (tmdbId === null || lastWatchedAt === null) return null;
  const title = typeof media.title === "string" && media.title.length > 0 ? media.title.slice(0, 500) : `TMDB #${tmdbId}`;
  const plays = typeof e.plays === "number" && Number.isFinite(e.plays) && e.plays > 0 ? Math.min(Math.floor(e.plays), 1_000_000) : 1;
  return { tmdbId, mediaType, title, plays, lastWatchedAt };
}

// Newest-first, one row per title (the latest watch wins a duplicate), at most
// `max` rows. Pure.
export function selectTraktHistoryRows(rows: readonly TraktWatchedRow[], max: number = MAX_TRAKT_HISTORY_ITEMS): TraktWatchedRow[] {
  const byKey = new Map<string, TraktWatchedRow>();
  for (const r of rows) {
    const key = `${r.mediaType}:${r.tmdbId}`;
    const prior = byKey.get(key);
    if (!prior || r.lastWatchedAt > prior.lastWatchedAt) byKey.set(key, r);
  }
  return [...byKey.values()]
    .sort((a, b) => b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime() || a.tmdbId - b.tmdbId)
    .slice(0, max);
}

// The watch-history stamp out of /sync/last_activities: the later of the movie
// and episode watched_at. Null when neither is readable. Pure.
export function traktHistoryActivityStamp(activities: unknown): Date | null {
  if (!activities || typeof activities !== "object") return null;
  const a = activities as { movies?: { watched_at?: unknown }; episodes?: { watched_at?: unknown } };
  const stamps = [parseDate(a.movies?.watched_at), parseDate(a.episodes?.watched_at)].filter((d): d is Date => d !== null);
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps.map((d) => d.getTime())));
}

// Whether a user's history may be re-imported now (never imported, or the last
// import is at least TRAKT_HISTORY_MIN_INTERVAL_MS old). Pure.
export function traktHistoryImportDue(importedAt: Date | null, nowMs: number = Date.now()): boolean {
  return importedAt === null || nowMs - importedAt.getTime() >= TRAKT_HISTORY_MIN_INTERVAL_MS;
}

// ── reads ───────────────────────────────────────────────────────────────────

async function fetchWatchlist(client: TraktUserClient, signal?: AbortSignal): Promise<TraktListItem[]> {
  const items: TraktListItem[] = [];
  for (const type of ["movies", "shows"] as const) {
    let read = 0;
    for (let page = 1; read < MAX_TRAKT_WATCHLIST_ITEMS; page++) {
      if (signal?.aborted) return items;
      const { body, headers } = await client.get(`/sync/watchlist/${type}/added/desc?page=${page}&limit=${WATCHLIST_PAGE_SIZE}`);
      const rows = Array.isArray(body) ? body : [];
      for (const row of rows) {
        const item = parseTraktWatchlistEntry(row);
        if (item) items.push(item);
      }
      read += rows.length;
      const pageCount = Number(headers.get("x-pagination-page-count"));
      if (rows.length < WATCHLIST_PAGE_SIZE || (Number.isFinite(pageCount) && pageCount > 0 && page >= pageCount)) break;
    }
  }
  return items;
}

async function fetchWatchedHistory(client: TraktUserClient): Promise<TraktWatchedRow[]> {
  const rows: TraktWatchedRow[] = [];
  const movies = await client.get("/sync/watched/movies");
  for (const e of Array.isArray(movies.body) ? movies.body : []) {
    const row = parseTraktWatchedEntry(e, "MOVIE");
    if (row) rows.push(row);
  }
  // noseasons: per-show plays and last_watched_at without every episode.
  const shows = await client.get("/sync/watched/shows?extended=noseasons");
  for (const e of Array.isArray(shows.body) ? shows.body : []) {
    const row = parseTraktWatchedEntry(e, "TV");
    if (row) rows.push(row);
  }
  return selectTraktHistoryRows(rows);
}

// Replace one user's imported history, newest MAX_TRAKT_HISTORY_ITEMS titles.
// Full replace in one transaction (guardrail 4): an unwatch on Trakt drops the row.
//
// The history read takes seconds, and the user may switch the history off or
// disconnect meanwhile — both of which delete these rows. So the transaction
// LOCKS the connection row (FOR UPDATE: the toggle's update and the disconnect's
// delete wait for it) and re-checks that the history is still wanted and the
// grant still exists before writing. Returns false (nothing written) otherwise.
async function replaceTraktHistory(userId: string, rows: TraktWatchedRow[]): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      // One Prisma.sql value, never a tagged template with a fragment (23a).
      const locked = await tx.$queryRaw<Array<{ historySeeds: boolean }>>(
        Prisma.sql`SELECT "historySeeds" FROM "TraktConnection" WHERE "userId" = ${userId} FOR UPDATE`,
      );
      if (locked[0]?.historySeeds !== true) return false;
      const grant = await tx.account.findFirst({ where: { userId, provider: "trakt" }, select: { id: true } });
      if (!grant) return false;
      await tx.traktWatchedItem.deleteMany({ where: { userId } });
      await batchCreateMany(
        tx.traktWatchedItem,
        rows.map((r) => ({ userId, tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, plays: r.plays, lastWatchedAt: r.lastWatchedAt })),
      );
      return true;
    },
    { timeout: BATCH_TX_TIMEOUT },
  );
}

// ── connecting (device-code flow) ───────────────────────────────────────────
//
// The device code is a bearer secret for the pending grant, so it never leaves
// the server: it is held here, keyed by user, and the browser only ever sees
// the short user code. In-process (single long-lived server, guardrail 17) — a
// restart drops a pending connection and the user starts again.

interface PendingDeviceAuth {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  // Reserved while a poll is talking to Trakt, so two concurrent polls cannot
  // both redeem the code (the loser would see 409 and report a failure for a
  // connection that succeeded).
  polling: boolean;
}

const pendingDeviceAuth = processSingleton("trakt-user:pendingDeviceAuth", () => new Map<string, PendingDeviceAuth>());
const MAX_PENDING_DEVICE_AUTH = 1_000;

export function __resetTraktPendingForTests(): void {
  pendingDeviceAuth.clear();
}

export interface TraktDeviceStart {
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

// Only a trakt.tv https URL is shown to the user; anything else is replaced.
export function safeVerificationUrl(raw: unknown): string {
  if (typeof raw !== "string") return TRAKT_ACTIVATE_URL;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "trakt.tv" || u.hostname.endsWith(".trakt.tv")) ? u.toString() : TRAKT_ACTIVATE_URL;
  } catch {
    return TRAKT_ACTIVATE_URL;
  }
}

export async function startTraktDeviceAuth(userId: string, cfg: TraktOAuthConfig): Promise<TraktDeviceStart> {
  const res = await traktPost("/oauth/device/code", cfg.clientId, { client_id: cfg.clientId });
  if (res.status === 429) throw new TraktRateLimitedError();
  if (!res.ok) throw new Error(`Trakt device code answered ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  if (!deviceCode || !userCode || userCode.length > 32) throw new Error("Trakt device code response was unusable");
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? Math.min(body.expires_in, 1800) : 600;
  const interval = typeof body.interval === "number" && body.interval > 0 ? Math.min(body.interval, 60) : 5;
  const now = Date.now();
  if (pendingDeviceAuth.size >= MAX_PENDING_DEVICE_AUTH) {
    for (const [k, v] of pendingDeviceAuth) if (v.expiresAt <= now) pendingDeviceAuth.delete(k);
    if (pendingDeviceAuth.size >= MAX_PENDING_DEVICE_AUTH) {
      const oldest = pendingDeviceAuth.keys().next().value;
      if (oldest !== undefined) pendingDeviceAuth.delete(oldest);
    }
  }
  // A new start replaces the user's previous pending code.
  pendingDeviceAuth.set(userId, {
    deviceCode,
    expiresAt: now + expiresIn * 1000,
    intervalMs: interval * 1000,
    nextPollAt: now + interval * 1000,
    polling: false,
  });
  return { userCode, verificationUrl: safeVerificationUrl(body.verification_url), expiresIn, interval };
}

export type TraktPollResult =
  | { state: "pending" }
  | { state: "connected"; username: string }
  // The code expired, was refused, or no connection is pending (start again).
  | { state: "expired" }
  | { state: "denied" }
  // That Trakt account is already connected to another Summonarr account.
  | { state: "conflict" };

export async function pollTraktDeviceAuth(userId: string, cfg: TraktOAuthConfig): Promise<TraktPollResult> {
  const pending = pendingDeviceAuth.get(userId);
  const now = Date.now();
  if (!pending || pending.expiresAt <= now) {
    pendingDeviceAuth.delete(userId);
    return { state: "expired" };
  }
  // Pace Trakt ourselves: a client polling faster than Trakt's interval (or two
  // tabs) is answered from here instead of earning the app a 429.
  if (pending.polling || now < pending.nextPollAt) return { state: "pending" };
  pending.polling = true;
  try {
    const res = await traktPost("/oauth/device/token", cfg.clientId, {
      code: pending.deviceCode,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    if (res.status === 400) {
      pending.nextPollAt = Date.now() + pending.intervalMs;
      return { state: "pending" };
    }
    if (res.status === 429) {
      // "Slow down": widen the interval for the rest of this grant.
      pending.intervalMs += 5_000;
      pending.nextPollAt = Date.now() + pending.intervalMs;
      return { state: "pending" };
    }
    if (res.status === 418) {
      pendingDeviceAuth.delete(userId);
      return { state: "denied" };
    }
    if (res.status === 404 || res.status === 409 || res.status === 410) {
      pendingDeviceAuth.delete(userId);
      return { state: "expired" };
    }
    if (!res.ok) {
      // Transient: keep the grant, try again on the next interval.
      pending.nextPollAt = Date.now() + pending.intervalMs;
      throw new Error(`Trakt device token answered ${res.status}`);
    }
    const tokens = parseTraktTokenResponse(await res.json());
    // The code is redeemed whatever happens next — it cannot be polled again.
    pendingDeviceAuth.delete(userId);
    if (!tokens) throw new Error("Trakt device token response was unusable");
    let result: TraktPollResult;
    try {
      const profile = await fetchTraktProfile(cfg.clientId, tokens.accessToken);
      result = await storeTraktConnection(userId, tokens, profile);
    } catch (err) {
      // The code is spent but nothing was stored: hand the grant back.
      revokeTraktToken(cfg, tokens.accessToken, userId);
      throw err;
    }
    // Nothing was stored: give the just-issued grant back rather than leave a
    // live token for someone else's Trakt account sitting at Trakt.
    if (result.state === "conflict") revokeTraktToken(cfg, tokens.accessToken, userId);
    return result;
  } finally {
    pending.polling = false;
  }
}

async function fetchTraktProfile(clientId: string, accessToken: string): Promise<{ uuid: string; username: string }> {
  const res = await traktGet("/users/settings", clientId, accessToken);
  if (res.unauthorized) throw new Error("Trakt rejected a token it just issued");
  const user = (res.body as { user?: { username?: unknown; ids?: { uuid?: unknown; slug?: unknown } } })?.user;
  const uuid = typeof user?.ids?.uuid === "string" && user.ids.uuid.length > 0 ? user.ids.uuid : null;
  const slug = typeof user?.ids?.slug === "string" && user.ids.slug.length > 0 ? user.ids.slug : null;
  const id = uuid ?? (slug ? `slug:${slug}` : null);
  if (!id || id.length > 191) throw new Error("Trakt /users/settings carried no user id");
  const username = typeof user?.username === "string" && user.username.length > 0 ? user.username : (slug ?? "trakt");
  return { uuid: id, username: username.slice(0, 100) };
}

async function storeTraktConnection(
  userId: string,
  tokens: TraktTokenSet,
  profile: { uuid: string; username: string },
): Promise<TraktPollResult> {
  // One Trakt account backs at most one Summonarr account (the Account unique
  // key): reading someone else's watchlist into your requests is not a feature.
  // Checked inside the transaction so the upsert below can never overwrite the
  // credential of the account that already holds it.
  const connected = await prisma.$transaction(async (tx) => {
    const owner = await tx.account.findUnique({
      where: { provider_providerAccountId: { provider: "trakt", providerAccountId: profile.uuid } },
      select: { userId: true },
    });
    if (owner && owner.userId !== userId) return false;
    // A reconnect with a DIFFERENT Trakt account replaces the old one. The
    // imported history is dropped either way and re-imported by the next sync,
    // so it can only ever describe the account now connected.
    await tx.account.deleteMany({ where: { userId, provider: "trakt", NOT: { providerAccountId: profile.uuid } } });
    await tx.traktWatchedItem.deleteMany({ where: { userId } });
    // Raw tokens — the Prisma extension encrypts them on write (guardrail 7a).
    await tx.account.upsert({
      where: { provider_providerAccountId: { provider: "trakt", providerAccountId: profile.uuid } },
      create: {
        userId,
        type: "oauth",
        provider: "trakt",
        providerAccountId: profile.uuid,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
        token_type: tokens.tokenType,
        scope: tokens.scope,
      },
      update: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
        token_type: tokens.tokenType,
        scope: tokens.scope,
      },
    });
    await tx.traktConnection.upsert({
      where: { userId },
      create: { userId, username: profile.username },
      // Keep the user's toggles across a reconnect; reset the sync bookkeeping.
      update: { username: profile.username, historyActivityAt: null, historyImportedAt: null, syncedAt: null, status: null },
    });
    return true;
  });
  return connected ? { state: "connected", username: profile.username } : { state: "conflict" };
}

// ── disconnecting ───────────────────────────────────────────────────────────

// Delete the grant, the connection and the imported history, then revoke the
// token at Trakt best-effort (a failed revoke never fails the disconnect — the
// grant is already useless to us). Returns whether anything was connected.
export async function disconnectTrakt(userId: string): Promise<boolean> {
  const accounts = await prisma.account.findMany({
    where: { userId, provider: "trakt" },
    select: { access_token: true },
  });
  const [, conn] = await prisma.$transaction([
    prisma.account.deleteMany({ where: { userId, provider: "trakt" } }),
    prisma.traktConnection.deleteMany({ where: { userId } }),
    prisma.traktWatchedItem.deleteMany({ where: { userId } }),
  ]);
  pendingDeviceAuth.delete(userId);
  const cfg = await getTraktOAuthConfig().catch(() => null);
  if (cfg) {
    for (const a of accounts) if (a.access_token) revokeTraktToken(cfg, a.access_token, userId);
  }
  return accounts.length > 0 || conn.count > 0;
}

// Revoke one token at Trakt, fire-and-forget: a failure is warned, never thrown —
// the token is already useless to us.
function revokeTraktToken(cfg: TraktOAuthConfig, token: string, userId: string): void {
  void traktPost("/oauth/revoke", cfg.clientId, { token, client_id: cfg.clientId, client_secret: cfg.clientSecret })
    .then((res) => {
      if (!res.ok) console.warn(`[trakt] token revoke for user ${userId} answered ${res.status}`);
    })
    .catch((err: unknown) =>
      console.warn(`[trakt] token revoke for user ${userId} failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`),
    );
}

// ── the cron body ───────────────────────────────────────────────────────────

export interface TraktSyncResult extends AutoRequestTally {
  skipped?: "unconfigured" | "disabled";
  users: number;
  // Users whose watch history changed and was re-imported this run.
  historyImported: number;
  // Users whose grant Trakt refused — token and history deleted, "reauth".
  tokensRevoked: number;
  // Users whose Trakt data could not be read or processed this run.
  errors: number;
  // Trakt answered 429 and the run stopped early.
  rateLimited?: boolean;
  // Trakt refused the app's client credentials and the run stopped early.
  clientRejected?: boolean;
}

const CLIENT_REJECTED_WARN_KEY = "trakt:client-rejected";

export function traktRunProblems(result: TraktSyncResult): number {
  return result.errors + (result.rateLimited ? 1 : 0) + (result.clientRejected ? 1 : 0);
}

export async function syncTraktUsers(opts: { signal?: AbortSignal } = {}): Promise<TraktSyncResult> {
  const result: TraktSyncResult = {
    users: 0, requested: 0, refused: 0, alreadyHandled: 0, historyImported: 0, tokensRevoked: 0, errors: 0, outcomes: {},
  };
  const cfg = await getTraktOAuthConfig();
  if (!cfg) return { ...result, skipped: "unconfigured" };
  const [autoRequestOn, forYouOn] = await Promise.all([
    isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY),
    isFeatureEnabled(FOR_YOU_FEATURE_KEY),
  ]);
  if (!autoRequestOn && !forYouOn) return { ...result, skipped: "disabled" };

  const rows = await prisma.traktConnection.findMany({
    where: {
      user: { deactivatedAt: null, purgedAt: null, accounts: { some: { provider: "trakt" } } },
    },
    select: {
      userId: true,
      watchlistAutoRequest: true,
      historySeeds: true,
      historyActivityAt: true,
      historyImportedAt: true,
      user: { select: { id: true, role: true, permissions: true, name: true, email: true } },
    },
  });

  // One user at a time (guardrail 31 — each runs sequential request filing and
  // the Prisma pool is five connections), each isolated.
  for (const row of rows) {
    if (opts.signal?.aborted) break; // guardrail 41 — return, never throw
    const wantWatchlist = autoRequestOn && row.watchlistAutoRequest && hasAutoRequestBit(row.user);
    const wantHistory = forYouOn && row.historySeeds;
    if (!wantWatchlist && !wantHistory) continue;
    result.users++;
    try {
      const account = await prisma.account.findFirst({
        where: { userId: row.userId, provider: "trakt" },
        select: { id: true, access_token: true, refresh_token: true, expires_at: true },
      });
      if (!account) continue;
      const client = new TraktUserClient(cfg, account);
      let historyActivityAt = row.historyActivityAt;
      let historyImportedAt = row.historyImportedAt;

      if (wantWatchlist) {
        const watchlist = await fetchWatchlist(client, opts.signal);
        await fileAutoRequestTitles(row.user, watchlist, "trakt-watchlist", result, opts.signal);
      }
      if (wantHistory && !opts.signal?.aborted && traktHistoryImportDue(historyImportedAt)) {
        const { body } = await client.get("/sync/last_activities");
        const stamp = traktHistoryActivityStamp(body);
        // Unchanged since the last import ⇒ skip the (large) history read.
        if (stamp === null || historyActivityAt === null || stamp.getTime() !== historyActivityAt.getTime()) {
          const history = await fetchWatchedHistory(client);
          // False: switched off or disconnected mid-read — nothing written, and
          // the bookkeeping below must not claim an import either.
          if (await replaceTraktHistory(row.userId, history)) {
            historyActivityAt = stamp;
            historyImportedAt = new Date();
            result.historyImported++;
          }
        }
      }
      // updateMany: a user who disconnected mid-run has no row left, and that
      // is not a run error.
      await prisma.traktConnection.updateMany({
        where: { userId: row.userId },
        data: { syncedAt: new Date(), status: "ok", historyActivityAt, historyImportedAt },
      });
      forgetWarnOnChange(CLIENT_REJECTED_WARN_KEY);
    } catch (err) {
      if (err instanceof TraktTokenRevokedError) {
        result.tokensRevoked++;
        console.warn(`[trakt] Trakt refused the stored grant for user ${row.userId} — removed; they must reconnect Trakt`);
        await endRevokedConnection(row.userId);
        continue;
      }
      result.errors++;
      await markConnection(row.userId, "error");
      if (err instanceof TraktClientRejectedError) {
        result.clientRejected = true;
        // Restates an unchanged condition every run until fixed (guardrail 7b).
        warnOnChange(
          CLIENT_REJECTED_WARN_KEY,
          "rejected",
          "[trakt] Trakt rejected the app's client id/secret on a token refresh — no user grant was touched; fix the Trakt credentials in Settings → Integrations",
        );
        break;
      }
      if (err instanceof TraktRateLimitedError) {
        result.rateLimited = true;
        console.warn("[trakt] Trakt rate limited the sync — the remaining users wait for the next run");
        break;
      }
      console.error(`[trakt] sync failed for user ${row.userId}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }
  return result;
}

async function markConnection(userId: string, status: "error" | "reauth"): Promise<void> {
  await prisma.traktConnection
    .updateMany({ where: { userId }, data: { status } })
    .catch((e: unknown) => console.error(`[trakt] status write for user ${userId} failed: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`));
}

// The grant is gone: drop the credential and the history it imported (the user
// may have revoked Summonarr on trakt.tv precisely to stop that), keep the
// connection row as "reauth" so the profile can say what happened.
async function endRevokedConnection(userId: string): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.account.deleteMany({ where: { userId, provider: "trakt" } }),
      prisma.traktWatchedItem.deleteMany({ where: { userId } }),
      prisma.traktConnection.updateMany({ where: { userId }, data: { status: "reauth", historyActivityAt: null, historyImportedAt: null } }),
    ]);
  } catch (e) {
    console.error(`[trakt] revoked-grant cleanup for user ${userId} failed: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`);
  }
}

// ── the profile's view ──────────────────────────────────────────────────────

export interface TraktProfileState {
  // The admin configured a Trakt app (id + secret) AND the user has a use for it.
  available: boolean;
  uses: TraktUses;
  connected: boolean;
  username: string | null;
  watchlistAutoRequest: boolean;
  historySeeds: boolean;
  // "ok" | "error" | "reauth" | null (not synced yet / not connected).
  status: "ok" | "error" | "reauth" | null;
  syncedAt: string | null;
}

export async function getTraktProfileState(userId: string, permissions: bigint): Promise<TraktProfileState> {
  const [cfg, uses, conn, account] = await Promise.all([
    getTraktOAuthConfig(),
    traktUsesFor(permissions),
    prisma.traktConnection.findUnique({
      where: { userId },
      select: { username: true, watchlistAutoRequest: true, historySeeds: true, status: true, syncedAt: true },
    }),
    prisma.account.findFirst({ where: { userId, provider: "trakt" }, select: { id: true } }),
  ]);
  const status = conn?.status === "ok" || conn?.status === "error" || conn?.status === "reauth" ? conn.status : null;
  return {
    available: cfg !== null && (uses.watchlist || uses.history),
    uses,
    connected: account !== null,
    username: conn?.username ?? null,
    watchlistAutoRequest: conn?.watchlistAutoRequest ?? true,
    historySeeds: conn?.historySeeds ?? true,
    status,
    syncedAt: conn?.syncedAt?.toISOString() ?? null,
  };
}

// Re-exported for the route, which reports outcomes by name.
export type { AutoRequestOutcome };
