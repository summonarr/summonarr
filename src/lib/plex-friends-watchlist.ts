import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { PLEX_CLIENT_ID } from "@/lib/plex";

// The SERVER-TOKEN half of the Plex watchlist auto-request (guardrail 34b).
//
// The user-token path (plex-watchlist.ts) needs each user's own plex.tv token,
// captured at Plex sign-in. This path needs none: the configured Plex ADMIN
// token (getPlexConfig(slug).token — the server owner's plex.tv account token)
// can read the watchlist of any Plex FRIEND whose watchlist visibility allows
// friends, through plex.tv's community GraphQL API (the approach Pulsarr uses):
//
//   POST https://community.plex.tv/api   allFriendsV2 { user { id username } }
//   POST https://community.plex.tv/api   userV2(user:{id}) { watchlist(first, after) }
//   GET  https://plex.tv/api/v2/friends  [{ id (numeric), uuid, … }]
//   GET  https://plex.tv/api/v2/user     { id (numeric) } — the owner themself
//
// IDENTITY BRIDGE — UNVERIFIED AGAINST A LIVE SERVER. The GraphQL `user.id` is
// believed to be the account UUID, while Summonarr stores the NUMERIC plex.tv
// account id (User.plexUserId, MediaServerUser.sourceUserId). The v2 friends
// list carries both, so it is the bridge (friendAccountId). An all-digit
// GraphQL id is taken as the numeric id directly. Everything shape-dependent is
// isolated in the pure parsers below so a live mismatch is a one-function fix.
//
// FAILURE RULES. A 401/403 on the ADMIN token raises AdminTokenRejectedError —
// the caller aborts this instance for the run and marks it degraded. It must
// NEVER reach the user-token path's 401 branch, which deletes a user's Account
// rows: the admin token being wrong says nothing about any user's own token. A
// friend whose watchlist comes back null (their privacy setting) is a per-user
// "private" status, not a failure.

export const PLEX_COMMUNITY_HOSTS = ["community.plex.tv", "plex.tv"] as const;

const COMMUNITY_API_URL = "https://community.plex.tv/api";
const V2_FRIENDS_URL = "https://plex.tv/api/v2/friends";
const V2_USER_URL = "https://plex.tv/api/v2/user";
const FETCH_TIMEOUT_MS = 15_000;
export const FRIEND_WATCHLIST_PAGE_SIZE = 100;
// A Retry-After longer than this is not waited out — the request fails and the
// next run tries again. One retry at most.
export const MAX_RETRY_AFTER_MS = 30_000;

export class AdminTokenRejectedError extends Error {
  constructor(status: number) {
    super(`plex.tv rejected the server admin token (${status})`);
    this.name = "AdminTokenRejectedError";
  }
}

export interface PlexFriend {
  // The GraphQL user id (believed to be the account uuid).
  graphId: string;
  username: string;
}

export interface FriendWatchlistNode {
  id: string;
  title: string;
  type: string;
}

export type FriendWatchlistResult =
  | { status: "ok"; nodes: FriendWatchlistNode[] }
  | { status: "private" };

function headers(token: string, json: boolean): Record<string, string> {
  return {
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
    "X-Plex-Product": "Summonarr",
    "X-Plex-Version": "1.0",
  };
}

// Retry-After as milliseconds: delta-seconds or an HTTP date. Null when absent
// or unparseable. Pure.
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// One plex.tv call with the ADMIN token. 401/403 → AdminTokenRejectedError; a
// 429 is retried once after its Retry-After (bounded); any other non-2xx throws.
async function adminFetchJson(
  url: string,
  token: string,
  init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await safeFetchTrusted(url, {
      allowedHosts: PLEX_COMMUNITY_HOSTS,
      method: init.method ?? "GET",
      headers: headers(token, init.body !== undefined),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (res.status === 401 || res.status === 403) throw new AdminTokenRejectedError(res.status);
    if (res.status === 429 && attempt === 0) {
      const wait = parseRetryAfterMs(res.headers.get("retry-after")) ?? 1000;
      if (wait <= MAX_RETRY_AFTER_MS && !init.signal?.aborted) {
        await sleep(wait, init.signal);
        continue;
      }
    }
    if (!res.ok) throw new Error(`plex.tv answered ${res.status}`);
    return res.json();
  }
}

// ── pure parsers (every live-shape assumption lives here) ───────────────────

// allFriendsV2 → friends with a string id. Pure.
export function parseAllFriends(body: unknown): PlexFriend[] {
  const data = (body as { data?: { allFriendsV2?: unknown } } | null)?.data;
  const list = data?.allFriendsV2;
  if (!Array.isArray(list)) {
    const errs = graphqlErrorMessages(body);
    throw new Error(`plex.tv friends query returned no list${errs.length ? `: ${errs.join("; ")}` : ""}`);
  }
  const out: PlexFriend[] = [];
  for (const entry of list) {
    const user = entry && typeof entry === "object" ? (entry as { user?: unknown }).user : undefined;
    if (!user || typeof user !== "object") continue;
    const rawId = (user as { id?: unknown }).id;
    const id = typeof rawId === "string" ? rawId.trim() : typeof rawId === "number" ? String(rawId) : "";
    if (!id || id.length > 128) continue;
    const username = (user as { username?: unknown }).username;
    out.push({ graphId: id, username: typeof username === "string" ? username : "" });
  }
  return out;
}

function graphqlErrorMessages(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (e && typeof e === "object" ? (e as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === "string")
    .slice(0, 3);
}

// One page of userV2.watchlist. A null/absent watchlist is the friend's privacy
// setting ("private"), unless the errors read as a server-side failure, which
// throws so the user is counted as an error and retried next run. Pure.
export function parseWatchlistPage(
  body: unknown,
): { status: "private" } | { status: "ok"; nodes: FriendWatchlistNode[]; hasNextPage: boolean; endCursor: string | null } {
  const user = (body as { data?: { userV2?: unknown } } | null)?.data?.userV2;
  const watchlist = user && typeof user === "object" ? (user as { watchlist?: unknown }).watchlist : undefined;
  if (!watchlist || typeof watchlist !== "object") {
    const errs = graphqlErrorMessages(body);
    if (errs.some((m) => /internal|timeout|timed out|unavailable|rate limit|too many/i.test(m))) {
      throw new Error(`plex.tv watchlist query failed: ${errs.join("; ")}`);
    }
    return { status: "private" };
  }
  const w = watchlist as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
  const nodes: FriendWatchlistNode[] = [];
  for (const n of Array.isArray(w.nodes) ? w.nodes : []) {
    if (!n || typeof n !== "object") continue;
    const { id, title, type } = n as { id?: unknown; title?: unknown; type?: unknown };
    if (typeof id !== "string" || !id) continue;
    nodes.push({ id, title: typeof title === "string" ? title : "", type: typeof type === "string" ? type.toLowerCase() : "" });
  }
  const endCursor = typeof w.pageInfo?.endCursor === "string" && w.pageInfo.endCursor ? w.pageInfo.endCursor : null;
  return { status: "ok", nodes, hasNextPage: w.pageInfo?.hasNextPage === true && endCursor !== null, endCursor };
}

// plex.tv/api/v2/friends → uuid (lower-cased) → numeric account id. Tolerates
// a bare array or a { friends: [...] } wrapper; entries without both a uuid and
// a positive numeric id are skipped. Pure.
export function parseFriendUuidMap(body: unknown): Map<string, string> {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { friends?: unknown } | null)?.friends)
      ? ((body as { friends: unknown[] }).friends)
      : [];
  const out = new Map<string, string>();
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const { id, uuid } = f as { id?: unknown; uuid?: unknown };
    const numeric = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
    if (!/^\d{1,20}$/.test(numeric) || numeric === "0") continue;
    if (typeof uuid !== "string" || !uuid.trim()) continue;
    out.set(uuid.trim().toLowerCase(), numeric);
  }
  return out;
}

// GraphQL friend id → the numeric plex.tv account id Summonarr stores, or null
// when it cannot be bridged (the friend is then counted as unmatched). Pure.
export function friendAccountId(graphId: string, uuidToId: ReadonlyMap<string, string>): string | null {
  const id = graphId.trim();
  if (/^\d{1,20}$/.test(id)) return id === "0" ? null : id;
  return uuidToId.get(id.toLowerCase()) ?? null;
}

// ── plex.tv calls ───────────────────────────────────────────────────────────

const FRIENDS_QUERY = "query GetAllFriends { allFriendsV2 { user { id username } } }";
const WATCHLIST_QUERY =
  "query GetWatchlistHub($user: UserInput!, $first: PaginationInt!, $after: String) { userV2(user: $user) { ... on User { watchlist(first: $first, after: $after) { nodes { id title type } pageInfo { hasNextPage endCursor } } } } }";

export async function fetchPlexFriends(token: string, signal?: AbortSignal): Promise<PlexFriend[]> {
  const body = await adminFetchJson(COMMUNITY_API_URL, token, { method: "POST", body: { query: FRIENDS_QUERY }, signal });
  return parseAllFriends(body);
}

export async function fetchFriendUuidMap(token: string, signal?: AbortSignal): Promise<Map<string, string>> {
  return parseFriendUuidMap(await adminFetchJson(V2_FRIENDS_URL, token, { signal }));
}

// The owner's own numeric account id (the admin token is their account token).
export async function fetchOwnerAccountId(token: string, signal?: AbortSignal): Promise<string | null> {
  const body = (await adminFetchJson(V2_USER_URL, token, { signal })) as { id?: unknown } | null;
  const id = body?.id;
  const s = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
  return /^\d{1,20}$/.test(s) && s !== "0" ? s : null;
}

// A friend's watchlist, cursor-paged, up to maxItems. Checks the signal per
// page and returns what it has on abort (guardrail 41).
export async function fetchFriendWatchlist(
  token: string,
  friendGraphId: string,
  opts: { maxItems: number; signal?: AbortSignal },
): Promise<FriendWatchlistResult> {
  const nodes: FriendWatchlistNode[] = [];
  let after: string | null = null;
  while (nodes.length < opts.maxItems) {
    if (opts.signal?.aborted) break;
    const body = await adminFetchJson(COMMUNITY_API_URL, token, {
      method: "POST",
      body: {
        query: WATCHLIST_QUERY,
        variables: { user: { id: friendGraphId }, first: FRIEND_WATCHLIST_PAGE_SIZE, after },
      },
      signal: opts.signal,
    });
    const page = parseWatchlistPage(body);
    if (page.status === "private") {
      // A first page that is private is the friend's setting; a later page going
      // null mid-walk keeps what was already read.
      if (nodes.length === 0) return { status: "private" };
      break;
    }
    nodes.push(...page.nodes);
    if (!page.hasNextPage) break;
    after = page.endCursor;
  }
  return { status: "ok", nodes: nodes.slice(0, opts.maxItems) };
}

// ── friend → Summonarr user ─────────────────────────────────────────────────

// Numeric plex.tv account ids → Summonarr user id. Order, per id:
//   1. an admin's MANUAL pin on a plex MediaServerUser row (manualUserLink) —
//      a pin to nobody skips the friend; a pin never loses to automatic
//      resolution (guardrail 34);
//   2. User.plexUserId (the Plex sign-in subject — the same identity);
//   3. an automatic MediaServerUser{source:"plex"} link on any instance.
// NEVER by email. A resolved user that is deactivated or purged is dropped (it
// does NOT fall through to a weaker rule). Ambiguous automatic links (one
// account id linked to two users across instances) are skipped.
export async function resolvePlexAccountUsers(accountIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(accountIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const [msuRows, subjectUsers] = await Promise.all([
    prisma.mediaServerUser.findMany({
      where: { source: "plex", sourceUserId: { in: ids } },
      select: { sourceUserId: true, userId: true, manualUserLink: true },
    }),
    prisma.user.findMany({
      where: { plexUserId: { in: ids } },
      select: { id: true, plexUserId: true },
    }),
  ]);

  const candidate = new Map<string, string>();
  for (const id of ids) {
    const rows = msuRows.filter((r) => r.sourceUserId === id);
    const pins = rows.filter((r) => r.manualUserLink);
    if (pins.length > 0) {
      const pinned = new Set(pins.map((r) => r.userId));
      // Pinned to nobody, or to different accounts on different instances ⇒ skip.
      if (pinned.size !== 1) continue;
      const only = [...pinned][0];
      if (only) candidate.set(id, only);
      continue;
    }
    const bySubject = subjectUsers.find((u) => u.plexUserId === id);
    if (bySubject) {
      candidate.set(id, bySubject.id);
      continue;
    }
    const linked = new Set(rows.map((r) => r.userId).filter((u): u is string => !!u));
    if (linked.size === 1) candidate.set(id, [...linked][0]);
  }
  if (candidate.size === 0) return out;

  const active = await prisma.user.findMany({
    where: { id: { in: [...new Set(candidate.values())] }, deactivatedAt: null, purgedAt: null },
    select: { id: true },
  });
  const activeIds = new Set(active.map((u) => u.id));
  for (const [accountId, userId] of candidate) {
    if (activeIds.has(userId)) out.set(accountId, userId);
  }
  return out;
}
