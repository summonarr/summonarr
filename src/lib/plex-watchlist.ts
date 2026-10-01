import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { PLEX_CLIENT_ID } from "@/lib/plex";
import { isFeatureEnabled } from "@/lib/features";
import { mapLimit } from "@/lib/concurrency";
import { canAutoRequest, Permission, AUTO_REQUEST_MASK, effectivePermissions } from "@/lib/permissions";
import { sanitizeForLog } from "@/lib/sanitize";
import { loadRequestContext } from "@/lib/request-create";
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

  const unresolved = items.filter((i) => i.tmdbId === null);
  if (unresolved.length > 0 && !opts.signal?.aborted) {
    await mapLimit(unresolved, METADATA_CONCURRENCY, async (item) => {
      try {
        const data = (await plexJson(`${METADATA_URL}${encodeURIComponent(item.ratingKey)}`, token)) as {
          MediaContainer?: { Metadata?: Array<{ Guid?: unknown }> };
        };
        item.tmdbId = tmdbIdFromPlexGuids(data?.MediaContainer?.Metadata?.[0]?.Guid);
      } catch (err) {
        // A revoked token fails the whole read; a single bad lookup only skips
        // that title (it is retried next run — nothing was recorded for it).
        if (err instanceof PlexTokenRevokedError) throw err;
      }
    });
  }
  return items;
}

// ── token capture (called at Plex sign-in) ──────────────────────────────────

export async function rememberPlexWatchlistToken(userId: string, plexToken: string): Promise<void> {
  if (typeof plexToken !== "string" || plexToken.length === 0 || plexToken.length > 512) return;
  if (!(await isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY))) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { plexUserId: true } });
  if (!user?.plexUserId) return;
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

// ── the cron body ───────────────────────────────────────────────────────────

export interface PlexWatchlistSyncResult {
  skipped?: "disabled";
  users: number;
  requested: number;
  refused: number;
  // Titles on a watchlist the ledger says not to retry yet (or ever).
  alreadyHandled: number;
  // Users whose stored token plex.tv rejected — the token is deleted.
  tokensRevoked: number;
  // Users whose watchlist could not be read or processed this run.
  errors: number;
  outcomes: Partial<Record<AutoRequestOutcome, number>>;
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
  const users = candidates.filter((u) => {
    const perms = effectivePermissions(u.role, u.permissions);
    return (perms & (AUTO_REQUEST_MASK | Permission.ADMIN)) !== 0n;
  });

  // Users one at a time: each runs its own sequential request filing, and the
  // Prisma pool is five connections (guardrail 31). Per-user isolation — one
  // user's failure is counted and the run moves on.
  for (const user of users) {
    if (opts.signal?.aborted) break; // guardrail 41 — return, never throw
    result.users++;
    try {
      await syncOneUser(user, result, opts.signal);
    } catch (err) {
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
  return result;
}

async function syncOneUser(
  user: { id: string; role: string; permissions: bigint; name: string | null; email: string },
  result: PlexWatchlistSyncResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const token = await storedPlexToken(user.id);
  if (!token) return;
  const session = sessionForUser(user);

  const watchlist = await fetchPlexWatchlist(token, { signal });
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
