import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { PLEX_CLIENT_ID } from "@/lib/plex";
import { isFeatureEnabled } from "@/lib/features";
import { mapLimit } from "@/lib/concurrency";
import { canAutoRequest, Permission, AUTO_REQUEST_MASK, effectivePermissions } from "@/lib/permissions";
import { sanitizeForLog } from "@/lib/sanitize";
import { loadRequestContext } from "@/lib/request-create";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { getPlexConfig } from "@/lib/plex-config";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";
import {
  AdminTokenRejectedError,
  fetchFriendUuidMap,
  fetchFriendWatchlist,
  fetchOwnerAccountId,
  fetchPlexFriends,
  friendAccountId,
  resolvePlexAccountUsers,
} from "@/lib/plex-friends-watchlist";
import {
  WATCHLIST_AUTO_REQUEST_FEATURE_KEY,
  autoRequestTitle,
  sessionForUser,
  shouldAttemptAutoRequest,
  type AutoRequestOutcome,
} from "@/lib/auto-request";

// Plex watchlist → auto-request (the "plex-watchlist" source of auto-request.ts).
//
// TOKEN SOURCE. Reading someone's plex.tv watchlist needs THEIR plex.tv token —
// the admin's server token cannot see it. Summonarr otherwise keeps only an HMAC
// of a Plex sign-in token (PlexTokenCache), so the token is captured at Plex
// sign-in (rememberPlexWatchlistToken, called from /api/auth/sign-in/plex) into
// an `Account` row { provider: "plex", providerAccountId: User.plexUserId }.
// Account.access_token is encrypted at rest by the Prisma extension (guardrail
// 7a — never encryptToken here), and the account purge already deletes Account
// rows. It is captured ONLY while feature.behavior.watchlistAutoRequest is on,
// so an instance that never enables the feature never stores a Plex token; a
// user signs in with Plex once after the feature is enabled to connect. A token
// plex.tv answers 401 for is deleted and the user is skipped until they sign in
// again.
//
// Endpoints (both plex.tv-hosted, fixed — safeFetchTrusted with an explicit
// allowlist, guardrail 5a):
//   GET https://discover.provider.plex.tv/library/sections/watchlist/all
//       ?X-Plex-Container-Start=&X-Plex-Container-Size=&includeGuids=1
//   GET https://metadata.provider.plex.tv/library/metadata/{ratingKey}
//       — only for an item whose list entry carried no tmdb:// guid.
//
// SERVER SOURCE (optional, Setting plexWatchlistServerSource = "true"). For a
// user with NO stored token, the cron can instead read their watchlist through
// the Plex SERVER OWNER's admin token when they are the owner's Plex friend
// (plex-friends-watchlist.ts). A user's own token always wins when present.
// Consent: the profile toggle defaults ON, so the server path reads only users
// who explicitly switched it on (User.plexWatchlistOptInAt) — unless the admin
// sets plexWatchlistServerAutoEnroll = "true". Both paths share the ledger and
// the "plex-watchlist" source, so switching between them never re-files a title.
// A rejected ADMIN token never deletes any user's Account rows (guardrail 34b).

export const PLEX_WATCHLIST_HOSTS = ["discover.provider.plex.tv", "metadata.provider.plex.tv"] as const;

const WATCHLIST_URL = "https://discover.provider.plex.tv/library/sections/watchlist/all";
const METADATA_URL = "https://metadata.provider.plex.tv/library/metadata/";
const PAGE_SIZE = 50;
// A watchlist bigger than this is read in part; the rest is reached as earlier
// entries are requested or removed. Bounds one user's cost per run.
export const MAX_WATCHLIST_ITEMS = 500;
const FETCH_TIMEOUT_MS = 15_000;
// Detail lookups for items without an inline guid — bounded (guardrail 31).
const METADATA_CONCURRENCY = 4;
// New titles filed per user per run. A first sync of a long watchlist would
// otherwise file hundreds of requests at once; the rest follow on later runs.
export const MAX_AUTO_REQUESTS_PER_USER_PER_RUN = 20;

export class PlexTokenRevokedError extends Error {
  constructor() {
    super("plex.tv rejected the stored token (401)");
    this.name = "PlexTokenRevokedError";
  }
}

export interface PlexWatchlistItem {
  ratingKey: string;
  title: string;
  mediaType: "MOVIE" | "TV";
  tmdbId: number | null;
}

function plexHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
    "X-Plex-Product": "Summonarr",
    "X-Plex-Version": "1.0",
  };
}

// The TMDB id out of a Plex Guid list: [{ id: "imdb://tt0133093" },
// { id: "tmdb://603" }, { id: "tvdb://169" }]. Only a positive integer after
// "tmdb://" counts; anything else (no tmdb entry, junk, 0) is null. Pure.
export function tmdbIdFromPlexGuids(guids: unknown): number | null {
  if (!Array.isArray(guids)) return null;
  for (const g of guids) {
    const id = g && typeof g === "object" ? (g as { id?: unknown }).id : undefined;
    if (typeof id !== "string") continue;
    const m = /^tmdb:\/\/(\d{1,10})$/.exec(id.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

// Plex's "movie"/"show" → our MediaType; anything else (season, episode, a
// collection) is not requestable from a watchlist and is skipped.
export function mediaTypeFromPlexType(type: unknown): "MOVIE" | "TV" | null {
  if (type === "movie") return "MOVIE";
  if (type === "show") return "TV";
  return null;
}

// Plex discover ratingKeys are hex ids; anything else is refused before it is
// interpolated into a URL path.
const RATING_KEY_RE = /^[A-Za-z0-9]{1,64}$/;

// Map one Metadata entry from the watchlist list. Pure.
export function parseWatchlistEntry(entry: unknown): PlexWatchlistItem | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { ratingKey?: unknown; title?: unknown; type?: unknown; Guid?: unknown };
  const mediaType = mediaTypeFromPlexType(e.type);
  if (!mediaType) return null;
  if (typeof e.ratingKey !== "string" || !RATING_KEY_RE.test(e.ratingKey)) return null;
  return {
    ratingKey: e.ratingKey,
    title: typeof e.title === "string" ? e.title : "",
    mediaType,
    tmdbId: tmdbIdFromPlexGuids(e.Guid),
  };
}

async function plexJson(url: string, token: string): Promise<unknown> {
  const res = await safeFetchTrusted(url, {
    allowedHosts: PLEX_WATCHLIST_HOSTS,
    headers: plexHeaders(token),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (res.status === 401) throw new PlexTokenRevokedError();
  if (!res.ok) throw new Error(`plex.tv answered ${res.status}`);
  return res.json();
}

// Read a user's whole plex.tv watchlist (up to MAX_WATCHLIST_ITEMS) and resolve
// each entry to a TMDB id. An entry whose list row carried no tmdb:// guid gets
// one metadata lookup; one that still has none (e.g. a title Plex knows only by
// TVDB/IMDb) comes back with tmdbId null and is skipped by the caller.
export async function fetchPlexWatchlist(token: string, opts: { signal?: AbortSignal } = {}): Promise<PlexWatchlistItem[]> {
  const items: PlexWatchlistItem[] = [];
  for (let start = 0; start < MAX_WATCHLIST_ITEMS; start += PAGE_SIZE) {
    if (opts.signal?.aborted) break;
    const url = `${WATCHLIST_URL}?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}&includeGuids=1`;
    const data = (await plexJson(url, token)) as { MediaContainer?: { Metadata?: unknown; totalSize?: unknown } };
    const page = Array.isArray(data?.MediaContainer?.Metadata) ? (data.MediaContainer.Metadata as unknown[]) : [];
    for (const entry of page) {
      const item = parseWatchlistEntry(entry);
      if (item) items.push(item);
    }
    const total = typeof data?.MediaContainer?.totalSize === "number" ? data.MediaContainer.totalSize : null;
    if (page.length < PAGE_SIZE || (total !== null && start + PAGE_SIZE >= total)) break;
  }

  await resolveMissingTmdbIds(items, token, opts.signal);
  return items;
}

// One metadata lookup per entry whose list row carried no tmdb:// guid, bounded
// (guardrail 31). A revoked token fails the whole read; a single bad lookup only
// skips that title (it is retried next run — nothing was recorded for it).
export async function resolveMissingTmdbIds(
  items: PlexWatchlistItem[],
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const unresolved = items.filter((i) => i.tmdbId === null);
  if (unresolved.length === 0 || signal?.aborted) return;
  await mapLimit(unresolved, METADATA_CONCURRENCY, async (item) => {
    if (signal?.aborted) return;
    try {
      const data = (await plexJson(`${METADATA_URL}${encodeURIComponent(item.ratingKey)}`, token)) as {
        MediaContainer?: { Metadata?: Array<{ Guid?: unknown }> };
      };
      item.tmdbId = tmdbIdFromPlexGuids(data?.MediaContainer?.Metadata?.[0]?.Guid);
    } catch (err) {
      if (err instanceof PlexTokenRevokedError) throw err;
    }
  });
}

// ── token capture (called at Plex sign-in) ──────────────────────────────────

export async function rememberPlexWatchlistToken(userId: string, plexToken: string): Promise<void> {
  if (typeof plexToken !== "string" || plexToken.length === 0 || plexToken.length > 512) return;
  if (!(await isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY))) return;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plexUserId: true, role: true, permissions: true, plexWatchlistAutoRequest: true },
  });
  if (!user?.plexUserId) return;
  // A plex.tv token is a credential for the user's whole Plex account. Keep one
  // only for a user the cron would actually use it for: permitted AND opted in.
  // Opting out deletes it (PATCH /api/profile/auto-request).
  if (!user.plexWatchlistAutoRequest) return;
  const perms = effectivePermissions(user.role, user.permissions);
  if ((perms & (AUTO_REQUEST_MASK | Permission.ADMIN)) === 0n) return;
  // Raw token — the Prisma extension encrypts access_token on upsert (guardrail 7a).
  await prisma.account.upsert({
    where: { provider_providerAccountId: { provider: "plex", providerAccountId: user.plexUserId } },
    create: { userId, type: "plex", provider: "plex", providerAccountId: user.plexUserId, access_token: plexToken },
    update: { userId, access_token: plexToken },
  });
}

async function storedPlexToken(userId: string): Promise<string | null> {
  const row = await prisma.account.findFirst({
    where: { userId, provider: "plex" },
    select: { access_token: true },
  });
  return row?.access_token || null;
}

// ── settings ────────────────────────────────────────────────────────────────

// "true" ⇒ the cron also reads friends' watchlists through the Plex admin token
// (plex-friends-watchlist.ts) for users without their own token.
export const PLEX_WATCHLIST_SERVER_SOURCE_KEY = "plexWatchlistServerSource";
// "true" ⇒ the server path reads every permitted friend whose profile toggle is
// on, without waiting for them to switch it on themselves (consent by admin).
export const PLEX_WATCHLIST_SERVER_AUTO_ENROLL_KEY = "plexWatchlistServerAutoEnroll";
// JSON written once per run by the server path (best-effort): per-user status
// for the profile copy and the admin card. Not admin-writable.
export const PLEX_WATCHLIST_SERVER_STATUS_KEY = "plexWatchlistServerStatus";

export type ServerWatchlistUserStatus = "ok" | "private" | "error";

export interface PlexWatchlistServerStatus {
  updatedAt: string;
  users: Record<string, ServerWatchlistUserStatus>;
  unmatchedFriends: number;
}

// Parse the stored status JSON; null for absent or malformed. Pure.
export function parsePlexWatchlistServerStatus(raw: string | null | undefined): PlexWatchlistServerStatus | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PlexWatchlistServerStatus>;
    if (!v || typeof v !== "object" || typeof v.updatedAt !== "string") return null;
    const users: Record<string, ServerWatchlistUserStatus> = {};
    if (v.users && typeof v.users === "object") {
      for (const [id, st] of Object.entries(v.users)) {
        if (st === "ok" || st === "private" || st === "error") users[id] = st;
      }
    }
    const unmatched = typeof v.unmatchedFriends === "number" && Number.isFinite(v.unmatchedFriends) ? v.unmatchedFriends : 0;
    return { updatedAt: v.updatedAt, users, unmatchedFriends: unmatched };
  } catch {
    return null;
  }
}

async function settingIsTrue(key: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value === "true";
}

// How the caller's Plex watchlist reaches the cron, for the profile card and
// GET /api/profile/auto-request. `hasToken` is the caller's own stored token.
export interface PlexWatchlistConnection {
  serverSource: boolean;
  // Their consent counts for the server path: they switched the toggle on
  // themselves (plexWatchlistOptInAt), or the admin auto-enrolls.
  serverOptedIn: boolean;
  // The last server-path run's verdict for them; null when it did not read them.
  serverStatus: ServerWatchlistUserStatus | null;
  connectedVia: "token" | "server" | null;
}

export async function getPlexWatchlistConnection(
  user: { id: string; plexWatchlistOptInAt: Date | null },
  hasToken: boolean,
): Promise<PlexWatchlistConnection> {
  const [serverSource, autoEnroll, statusRow] = await Promise.all([
    settingIsTrue(PLEX_WATCHLIST_SERVER_SOURCE_KEY),
    settingIsTrue(PLEX_WATCHLIST_SERVER_AUTO_ENROLL_KEY),
    prisma.setting.findUnique({ where: { key: PLEX_WATCHLIST_SERVER_STATUS_KEY } }),
  ]);
  const serverOptedIn = user.plexWatchlistOptInAt !== null || autoEnroll;
  const serverStatus = serverSource ? parsePlexWatchlistServerStatus(statusRow?.value)?.users[user.id] ?? null : null;
  const connectedVia = hasToken ? "token" : serverSource && serverOptedIn && serverStatus === "ok" ? "server" : null;
  return { serverSource, serverOptedIn, serverStatus, connectedVia };
}

// ── the cron body ───────────────────────────────────────────────────────────

export interface PlexWatchlistServerResult {
  // Plex instances whose owner token was used (distinct tokens).
  instances: number;
  // Distinct friends across those instances (the owner excluded).
  friends: number;
  // Accounts (friends and the owner) resolved to an active Summonarr user.
  matched: number;
  // Friends with no bridgeable id or no Summonarr account — skipped.
  unmatchedFriends: number;
  // Users whose watchlist was read through the server path this run.
  users: number;
  // Of those, users whose watchlist is private to the owner.
  private: number;
  // Instances whose admin token plex.tv rejected (401/403) — skipped this run.
  adminTokensRejected: number;
  // Instances whose friend list could not be read for any other reason.
  instanceErrors: number;
}

export interface PlexWatchlistSyncResult {
  skipped?: "disabled";
  users: number;
  requested: number;
  refused: number;
  // Titles on a watchlist the ledger says not to retry yet (or ever).
  alreadyHandled: number;
  // Users whose stored token plex.tv rejected — the token is deleted.
  tokensRevoked: number;
  // Users whose watchlist could not be read or processed this run (either path).
  errors: number;
  outcomes: Partial<Record<AutoRequestOutcome, number>>;
  // Present only while plexWatchlistServerSource is on.
  server?: PlexWatchlistServerResult;
}

// How many problems make the run degraded (X-Cron-Degraded): user failures on
// either path, plus server instances that could not be read at all.
export function plexWatchlistRunProblems(result: PlexWatchlistSyncResult): number {
  return result.errors + (result.server ? result.server.adminTokensRejected + result.server.instanceErrors : 0);
}

type CronUser = { id: string; role: string; permissions: bigint; name: string | null; email: string };

function hasAutoRequestBit(u: { role: string; permissions: bigint }): boolean {
  const perms = effectivePermissions(u.role, u.permissions);
  return (perms & (AUTO_REQUEST_MASK | Permission.ADMIN)) !== 0n;
}

export async function syncPlexWatchlists(opts: { signal?: AbortSignal } = {}): Promise<PlexWatchlistSyncResult> {
  const result: PlexWatchlistSyncResult = {
    users: 0, requested: 0, refused: 0, alreadyHandled: 0, tokensRevoked: 0, errors: 0, outcomes: {},
  };
  if (!(await isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY))) {
    return { ...result, skipped: "disabled" };
  }

  // Active, opted-in users with a stored Plex token. The permission is checked
  // below on the EFFECTIVE mask (role presets, the ADMIN superbit), which the
  // stored column alone cannot express in SQL.
  const candidates = await prisma.user.findMany({
    where: {
      deactivatedAt: null,
      purgedAt: null,
      plexWatchlistAutoRequest: true,
      accounts: { some: { provider: "plex" } },
    },
    select: { id: true, role: true, permissions: true, name: true, email: true },
  });
  const users = candidates.filter(hasAutoRequestBit);

  // Users one at a time: each runs its own sequential request filing, and the
  // Prisma pool is five connections (guardrail 31). Per-user isolation — one
  // user's failure is counted and the run moves on.
  for (const user of users) {
    if (opts.signal?.aborted) break; // guardrail 41 — return, never throw
    result.users++;
    try {
      await syncOneUser(user, result, opts.signal);
    } catch (err) {
      // The ONLY branch that deletes Account rows: the USER's own token was
      // rejected. The server path below has its own catch and never gets here.
      if (err instanceof PlexTokenRevokedError) {
        result.tokensRevoked++;
        console.warn(`[plex-watchlist] plex.tv rejected the stored token for user ${user.id} — removed; they must sign in with Plex again`);
        await prisma.account
          .deleteMany({ where: { userId: user.id, provider: "plex" } })
          .catch((e: unknown) =>
            console.error(`[plex-watchlist] token removal failed for user ${user.id}: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`),
          );
        continue;
      }
      result.errors++;
      console.error(`[plex-watchlist] sync failed for user ${user.id}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }

  if (!opts.signal?.aborted && (await settingIsTrue(PLEX_WATCHLIST_SERVER_SOURCE_KEY))) {
    // Every user holding a token stays on the token path — own token wins, even
    // one plex.tv just rejected (they become server-eligible from the next run).
    const tokenUserIds = new Set(candidates.map((u) => u.id));
    result.server = await syncServerPath(tokenUserIds, result, opts.signal);
  }
  return result;
}

const adminTokenWarnKey = (slug: string) => `plex-watchlist:admin-token:${slug}`;

// A friend (or the owner, graphId null) reached through one instance's owner token.
type ServerTarget = { graphId: string | null; token: string; slug: string };

async function syncServerPath(
  tokenUserIds: ReadonlySet<string>,
  result: PlexWatchlistSyncResult,
  signal: AbortSignal | undefined,
): Promise<PlexWatchlistServerResult> {
  const server: PlexWatchlistServerResult = {
    instances: 0, friends: 0, matched: 0, unmatchedFriends: 0, users: 0, private: 0, adminTokensRejected: 0, instanceErrors: 0,
  };
  const statuses: Record<string, ServerWatchlistUserStatus> = {};
  const rejectedTokens = new Set<string>();
  const rejectToken = (token: string, slug: string) => {
    if (rejectedTokens.has(token)) return;
    rejectedTokens.add(token);
    server.adminTokensRejected++;
    // Restates an unchanged condition every run until fixed (guardrail 7b).
    warnOnChange(
      adminTokenWarnKey(slug),
      "rejected",
      `[plex-watchlist] plex.tv rejected the Plex admin token of ${mediaInstanceLabel("plex", slug)} — friends' watchlists are not read through it until the token is fixed in Settings → Media`,
    );
  };

  // Union every configured instance's friends, deduped by numeric account id
  // (guardrail 35 — findUnique-only config reads, skip-if-unconfigured).
  const targets = new Map<string, ServerTarget>();
  const friendIds = new Set<string>();
  let unbridged = 0;
  const seenTokens = new Set<string>();
  for (const inst of await getMediaInstances("plex")) {
    if (signal?.aborted) break;
    const cfg = await getPlexConfig(inst.slug);
    const token = cfg.token?.trim();
    if (!token || !cfg.url?.trim()) continue;
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    server.instances++;
    try {
      const friends = await fetchPlexFriends(token, signal);
      const uuidToId = await fetchFriendUuidMap(token, signal);
      const ownerId = await fetchOwnerAccountId(token, signal);
      forgetWarnOnChange(adminTokenWarnKey(inst.slug));
      // The owner: the admin token IS their account token — read directly.
      if (ownerId && !targets.has(ownerId)) targets.set(ownerId, { graphId: null, token, slug: inst.slug });
      for (const f of friends) {
        const accountId = friendAccountId(f.graphId, uuidToId);
        if (!accountId) {
          unbridged++;
          continue;
        }
        friendIds.add(accountId);
        if (!targets.has(accountId)) targets.set(accountId, { graphId: f.graphId, token, slug: inst.slug });
      }
    } catch (err) {
      if (err instanceof AdminTokenRejectedError) {
        rejectToken(token, inst.slug);
        continue;
      }
      server.instanceErrors++;
      console.error(`[plex-watchlist] could not list Plex friends for ${mediaInstanceLabel("plex", inst.slug)}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }
  server.friends = friendIds.size + unbridged;

  const resolved = targets.size > 0 && !signal?.aborted ? await resolvePlexAccountUsers([...targets.keys()]) : new Map<string, string>();
  server.matched = resolved.size;
  server.unmatchedFriends = unbridged + [...friendIds].filter((id) => !resolved.has(id)).length;

  // userId → the first target that resolved to them.
  const targetByUser = new Map<string, ServerTarget>();
  for (const [accountId, userId] of resolved) {
    if (tokenUserIds.has(userId) || targetByUser.has(userId)) continue;
    targetByUser.set(userId, targets.get(accountId)!);
  }

  if (targetByUser.size > 0 && !signal?.aborted) {
    const autoEnroll = await settingIsTrue(PLEX_WATCHLIST_SERVER_AUTO_ENROLL_KEY);
    const rows = await prisma.user.findMany({
      where: {
        id: { in: [...targetByUser.keys()] },
        deactivatedAt: null,
        purgedAt: null,
        plexWatchlistAutoRequest: true,
        // Consent: the toggle defaults ON, so it alone is not consent to read a
        // watchlist for someone who may never have opened Summonarr.
        ...(autoEnroll ? {} : { plexWatchlistOptInAt: { not: null } }),
      },
      select: { id: true, role: true, permissions: true, name: true, email: true },
    });

    for (const user of rows.filter(hasAutoRequestBit)) {
      if (signal?.aborted) break; // guardrail 41
      const target = targetByUser.get(user.id)!;
      if (rejectedTokens.has(target.token)) {
        statuses[user.id] = "error";
        continue;
      }
      server.users++;
      try {
        let items: PlexWatchlistItem[];
        if (target.graphId === null) {
          items = await fetchPlexWatchlist(target.token, { signal });
        } else {
          const list = await fetchFriendWatchlist(target.token, target.graphId, { maxItems: MAX_WATCHLIST_ITEMS, signal });
          if (list.status === "private") {
            statuses[user.id] = "private";
            server.private++;
            continue;
          }
          items = [];
          for (const node of list.nodes) {
            const item = parseWatchlistEntry({ ratingKey: node.id, title: node.title, type: node.type });
            if (item) items.push(item);
          }
          await resolveMissingTmdbIds(items, target.token, signal);
        }
        await fileWatchlistTitles(user, items, result, signal);
        statuses[user.id] = "ok";
      } catch (err) {
        statuses[user.id] = "error";
        // The ADMIN token was rejected mid-run (GraphQL or a metadata lookup):
        // stop using this instance. NEVER the user-token 401 branch — no Account
        // row is touched.
        if (err instanceof AdminTokenRejectedError || err instanceof PlexTokenRevokedError) {
          rejectToken(target.token, target.slug);
          continue;
        }
        result.errors++;
        console.error(`[plex-watchlist] server-path sync failed for user ${user.id}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      }
    }
  }

  // Best-effort, swallowed: an observability write must never fail the run.
  const status: PlexWatchlistServerStatus = { updatedAt: new Date().toISOString(), users: statuses, unmatchedFriends: server.unmatchedFriends };
  try {
    const value = JSON.stringify(status);
    await prisma.setting.upsert({
      where: { key: PLEX_WATCHLIST_SERVER_STATUS_KEY },
      create: { key: PLEX_WATCHLIST_SERVER_STATUS_KEY, value },
      update: { value },
    });
  } catch {
    // ignored — see above
  }
  return server;
}

async function syncOneUser(user: CronUser, result: PlexWatchlistSyncResult, signal: AbortSignal | undefined): Promise<void> {
  const token = await storedPlexToken(user.id);
  if (!token) return;
  const watchlist = await fetchPlexWatchlist(token, { signal });
  await fileWatchlistTitles(user, watchlist, result, signal);
}

// Shared by both paths: same ledger, same source string, same per-run cap — so
// switching a user between paths never re-files a title.
async function fileWatchlistTitles(
  user: CronUser,
  watchlist: PlexWatchlistItem[],
  result: PlexWatchlistSyncResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const session = sessionForUser(user);
  // One entry per title (a watchlist cannot hold duplicates, but a degraded page
  // overlap could), requestable types the user may auto-request only.
  const seen = new Set<string>();
  const titles: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV" }> = [];
  for (const item of watchlist) {
    if (item.tmdbId === null) continue;
    if (!canAutoRequest(session.user.permissions, item.mediaType)) continue;
    const key = `${item.mediaType}:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push({ tmdbId: item.tmdbId, mediaType: item.mediaType });
  }
  if (titles.length === 0) return;

  const ledger = await prisma.autoRequestLedger.findMany({
    where: { userId: user.id, tmdbId: { in: [...new Set(titles.map((t) => t.tmdbId))] } },
    select: { tmdbId: true, mediaType: true, outcome: true, updatedAt: true },
  });
  const byKey = new Map(ledger.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));
  const now = Date.now();
  const due = titles.filter((t) => {
    const attempt = shouldAttemptAutoRequest(byKey.get(`${t.mediaType}:${t.tmdbId}`), now);
    if (!attempt) result.alreadyHandled++;
    return attempt;
  });
  if (due.length === 0) return;

  // One context read per user, reused across titles (quota/grants/settings).
  const ctx = await loadRequestContext(user.id);
  // Sequential: each filing is several queries and, for an auto-approver, a
  // Radarr/Sonarr push. The per-run cap bounds the first sync of a long list.
  for (const t of due.slice(0, MAX_AUTO_REQUESTS_PER_USER_PER_RUN)) {
    if (signal?.aborted) return;
    const attempt = await autoRequestTitle({ session, tmdbId: t.tmdbId, mediaType: t.mediaType, source: "plex-watchlist", ctx });
    result.outcomes[attempt.outcome] = (result.outcomes[attempt.outcome] ?? 0) + 1;
    if (attempt.outcome === "requested") result.requested++;
    else result.refused++;
  }
}
