// Watchlist auto-request (src/lib/auto-request.ts, src/lib/plex-watchlist.ts,
// POST /api/watchlist, /api/cron/sync-plex-watchlists) — guardrail 34b.
//
// What is pinned, and why:
//   1. THE LEDGER IS THE LOOP GUARD. A title the cron already filed is never
//      filed again — even after the request is declined or deleted — and the
//      terminal refusals (blacklisted, already available, …) are never retried.
//      Only quota/access/transient outcomes come back, and only after the
//      backoff. Without this the Plex poll re-requests a declined title every
//      30 minutes forever.
//   2. A WATCHLIST ADD NEVER FAILS BECAUSE OF AUTO-REQUEST. Every refusal
//      (quota, blacklist, already available) and an outright crash of the
//      request path still answer 201 with the item; the outcome rides in an
//      additive `autoRequest` field that is ABSENT whenever auto-request does
//      not apply (no permission, flag off) so the iOS-decoded body is unchanged.
//   3. IT FILES THROUGH THE REQUEST CHOKEPOINT. The created row carries the
//      source note and goes through createMediaRequest (quota, blacklist, the
//      Serializable tx) — no private create path.
//   4. PLEX GUID → TMDB, PAGINATION, METADATA FALLBACK, 401 HANDLING, and the
//      cron's per-user isolation: one user's plex.tv failure is counted and the
//      next user is still processed; a revoked token is deleted.
//
// Harness: in-memory prisma stubs, a REAL signed session JWT for the watchlist
// route (tests/requests-route.test.mts idiom), a synthetic request scope with a
// recording after() context, dns.lookup stubbed, and a scripted globalThis.fetch.
// No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "auto-request-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ───────────────────────────────────────────────────────────
type FetchCall = { url: URL; token: string | null; body: unknown };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, token: string | null, body: unknown) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const token = headers.get("x-plex-token");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  fetchCalls.push({ url, token, body });
  return respond(url, token, body);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { invalidateBlacklistCache } = await import("../src/lib/blacklist.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── users + sessions ─────────────────────────────────────────────────────────
type DbUser = {
  id: string;
  role: string;
  permissions: bigint;
  name: string | null;
  email: string;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  purgedAt: Date | null;
  notificationEmail: string | null;
  discordId: string | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  maxContentRating: string | null;
  instanceGrants: unknown;
  plexWatchlistAutoRequest: boolean;
  plexWatchlistOptInAt: Date | null;
  plexUserId: string | null;
};
// Evaluates the handful of `where` shapes the cron issues (token-path candidates,
// friend resolution, server-path eligibility). An unknown key fails loudly.
function matchesUserWhere(u: DbUser, where: Record<string, unknown> = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "accounts") { if (!plexTokens.has(u.id)) return false; continue; }
    if (k === "id") { if (!(v as { in: string[] }).in.includes(u.id)) return false; continue; }
    if (k === "plexUserId") { if (!u.plexUserId || !(v as { in: string[] }).in.includes(u.plexUserId)) return false; continue; }
    if (k === "deactivatedAt" || k === "purgedAt") { if (u[k] !== null) return false; continue; }
    if (k === "plexWatchlistAutoRequest") { if (u.plexWatchlistAutoRequest !== v) return false; continue; }
    if (k === "plexWatchlistOptInAt") { if (u.plexWatchlistOptInAt === null) return false; continue; }
    throw new Error(`user.findMany stub: unhandled where key ${k}`);
  }
  return true;
}
const users = new Map<string, DbUser>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = users.get(args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async (args: { where?: Record<string, unknown> }) => {
    rec("user.findMany", args.where);
    return [...users.values()].filter((u) => matchesUserWhere(u, args.where)).map((u) => ({ ...u }));
  },
  update: async () => ({}),
});

let seq = 0;
function addUser(over: Partial<DbUser> = {}): DbUser {
  seq++;
  const u: DbUser = {
    id: `user-${seq}`,
    role: "USER",
    permissions: Permission.REQUEST | Permission.REQUEST_MOVIE | Permission.REQUEST_TV | Permission.AUTO_REQUEST,
    name: `User ${seq}`,
    email: `user-${seq}@example.com`,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    purgedAt: null,
    notificationEmail: null,
    discordId: null,
    movieQuotaLimit: null,
    movieQuotaDays: null,
    tvQuotaLimit: null,
    tvQuotaDays: null,
    maxContentRating: null,
    instanceGrants: null,
    plexWatchlistAutoRequest: true,
    plexWatchlistOptInAt: null,
    plexUserId: `plex-${seq}`,
    ...over,
  };
  users.set(u.id, u);
  return u;
}
async function tokenFor(u: DbUser): Promise<string> {
  const sessionId = `sess-${u.id}`;
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: u.id, role: u.role, permissions: u.permissions.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

// ── settings (feature flag, quota, …) ───────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[]; startsWith?: string } } } = {}) => {
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    const k = args.where?.key;
    if (k?.in) return all.filter((r) => k.in!.includes(r.key));
    if (k?.startsWith) return all.filter((r) => r.key.startsWith(k.startsWith!));
    return all;
  },
  upsert: async (args: { where: { key: string }; create: { value: string } }) => {
    rec("setting.upsert", args);
    settings.set(args.where.key, args.create.value);
    return {};
  },
});
const FLAG = "feature.behavior.watchlistAutoRequest";

// ── plex MediaServerUser rows (server-path friend resolution) ───────────────
type MsuRow = { source: string; sourceUserId: string; userId: string | null; manualUserLink: boolean };
let msuRows: MsuRow[] = [];
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { source: string; sourceUserId: { in: string[] } } }) =>
    msuRows.filter((r) => r.source === args.where.source && args.where.sourceUserId.in.includes(r.sourceUserId)),
});

// ── stored Plex tokens (Account rows) ───────────────────────────────────────
const plexTokens = new Map<string, string>();
shadowPrismaModel(prisma, "account", {
  findFirst: async (args: { where: { userId: string; provider: string } }) => {
    const t = plexTokens.get(args.where.userId);
    return args.where.provider === "plex" && t ? { id: `acct-${args.where.userId}`, access_token: t } : null;
  },
  deleteMany: async (args: { where: { userId: string; provider: string } }) => {
    rec("account.deleteMany", args.where);
    plexTokens.delete(args.where.userId);
    return { count: 1 };
  },
  upsert: async (args: unknown) => { rec("account.upsert", args); return {}; },
});

// ── the ledger ───────────────────────────────────────────────────────────────
type LedgerRow = { userId: string; tmdbId: number; mediaType: string; source: string; outcome: string; requestId: string | null; attempts: number; updatedAt: Date };
const ledger = new Map<string, LedgerRow>();
const lkey = (userId: string, tmdbId: number, mediaType: string) => `${userId}|${mediaType}|${tmdbId}`;
let ledgerWriteFails = false;
shadowPrismaModel(prisma, "autoRequestLedger", {
  findMany: async (args: { where: { userId: string; tmdbId: { in: number[] } } }) =>
    [...ledger.values()].filter((r) => r.userId === args.where.userId && args.where.tmdbId.in.includes(r.tmdbId)),
  upsert: async (args: {
    where: { userId_tmdbId_mediaType: { userId: string; tmdbId: number; mediaType: string } };
    create: Omit<LedgerRow, "attempts" | "updatedAt">;
    update: { source: string; outcome: string; requestId: string | null };
  }) => {
    rec("autoRequestLedger.upsert", args);
    if (ledgerWriteFails) throw new Error("ledger write failed");
    const w = args.where.userId_tmdbId_mediaType;
    const key = lkey(w.userId, w.tmdbId, w.mediaType);
    const prior = ledger.get(key);
    ledger.set(key, prior
      ? { ...prior, ...args.update, attempts: prior.attempts + 1, updatedAt: new Date() }
      : { ...args.create, attempts: 1, updatedAt: new Date() });
    return {};
  },
});

// ── the request chokepoint's tables ──────────────────────────────────────────
let reqSeq = 0;
let requestCount = 0; // what the quota count reads
let existingRequest: Record<string, unknown> | null = null;
let createThrows: Error | null = null;
const mediaRequestModel = {
  findFirst: async (args: { where: Record<string, unknown> }) => {
    rec("mediaRequest.findFirst", args);
    if ("requestedBy" in (args.where ?? {})) return existingRequest;
    return null;
  },
  count: async () => requestCount,
  create: async (args: { data: Record<string, unknown> }) => {
    rec("mediaRequest.create", args);
    if (createThrows) throw createThrows;
    return { id: `req-${++reqSeq}`, createdAt: new Date(), updatedAt: new Date(), status: "PENDING", ...args.data };
  },
  deleteMany: async () => ({ count: 1 }),
  updateMany: async () => ({ count: 1 }),
};
shadowPrismaModel(prisma, "mediaRequest", mediaRequestModel);
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)({ mediaRequest: mediaRequestModel });
});
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findUnique: async (args: { where: Record<string, unknown> }) => ({ title: `Title ${JSON.stringify(args.where)}`, posterPath: null, releaseYear: "2000" }),
});
shadowPrismaModel(prisma, "tmdbCache", { findUnique: async () => null, upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) });
let blacklisted: Array<{ tmdbId: number; mediaType: string }> = [];
shadowPrismaModel(prisma, "blacklistItem", { findMany: async () => blacklisted });
let inPlex = false;
shadowPrismaModel(prisma, "plexLibraryItem", { findFirst: async () => (inPlex ? { tmdbId: 1 } : null) });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findFirst: async () => null });
shadowPrismaModel(prisma, "radarrAvailableItem", { findUnique: async () => null });
shadowPrismaModel(prisma, "sonarrAvailableItem", { findUnique: async () => null });
shadowPrismaModel(prisma, "deletionVote", { deleteMany: () => Promise.resolve({ count: 0 }) });
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });
shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return {}; } });

// ── watchlist table ──────────────────────────────────────────────────────────
let watchlistConflict = false;
shadowPrismaModel(prisma, "watchlistItem", {
  create: async (args: { data: Record<string, unknown> }) => {
    rec("watchlistItem.create", args);
    if (watchlistConflict) {
      const { Prisma } = await import("@/generated/prisma");
      throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "0.0.0-test" });
    }
    const { tmdbId, mediaType, title, posterPath } = args.data;
    return { tmdbId, mediaType, title, posterPath, createdAt: new Date("2026-10-01T00:00:00Z") };
  },
});

// Modules under test — imported after every stub is in place.
const { POST: postWatchlist } = await import("../src/app/api/watchlist/route.ts");
const autoRequest = await import("../src/lib/auto-request.ts");
const plexWatchlist = await import("../src/lib/plex-watchlist.ts");

const afterTasks: unknown[] = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/auto-request.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: (task: unknown) => { afterTasks.push(task); } },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

async function addToWatchlist(u: DbUser, tmdbId = 603, mediaType = "MOVIE"): Promise<Response> {
  const token = await tokenFor(u);
  const req = new NextRequest("http://localhost:3000/api/watchlist", {
    method: "POST",
    headers: { cookie: `${getSessionCookieName()}=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tmdbId, mediaType }),
  });
  return inScope(() => postWatchlist(req, undefined));
}

beforeEach(() => {
  ops.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  afterTasks.length = 0;
  settings.clear();
  ledger.clear();
  plexTokens.clear();
  users.clear();
  requestCount = 0;
  existingRequest = null;
  createThrows = null;
  blacklisted = [];
  inPlex = false;
  watchlistConflict = false;
  ledgerWriteFails = false;
  msuRows = [];
  resetLogDedup();
  invalidateFeatureFlagCache();
  invalidateBlacklistCache();
  respond = () => { throw new Error("unexpected fetch"); };
});

// ═══ the retry rule (pure) ═══════════════════════════════════════════════════

test("ledger rule: no row ⇒ attempt; a filed request and the terminal refusals are NEVER retried, however old", () => {
  const ancient = new Date(Date.now() - 365 * 86_400_000);
  assert.equal(autoRequest.shouldAttemptAutoRequest(null), true);
  assert.equal(autoRequest.shouldAttemptAutoRequest(undefined), true);
  for (const outcome of ["requested", "already-available", "already-requested", "blacklisted", "permanently-declined", "rating-cap"]) {
    assert.equal(
      autoRequest.shouldAttemptAutoRequest({ outcome, updatedAt: ancient }),
      false,
      `${outcome} must be terminal — a declined/deleted request re-filed every poll is the loop the ledger exists to stop`,
    );
  }
  assert.equal(autoRequest.shouldAttemptAutoRequest({ outcome: "from-a-newer-build", updatedAt: ancient }), false, "unknown outcomes are terminal");
});

test("ledger rule: quota/access/transient outcomes are retried, but only once the backoff has passed", () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000);
  const stale = new Date(now - autoRequest.AUTO_REQUEST_RETRY_AFTER_MS);
  for (const outcome of ["quota", "forbidden", "instance-unavailable", "discord-link-required", "tmdb-unverified", "arr-unreachable", "maintenance", "rate-limited", "error"]) {
    assert.equal(autoRequest.shouldAttemptAutoRequest({ outcome, updatedAt: fresh }, now), false, `${outcome} inside the backoff`);
    assert.equal(autoRequest.shouldAttemptAutoRequest({ outcome, updatedAt: stale }, now), true, `${outcome} after the backoff`);
  }
});

// ═══ Plex guid → TMDB (pure) ═════════════════════════════════════════════════

test("tmdbIdFromPlexGuids picks the tmdb:// entry and rejects junk", () => {
  const { tmdbIdFromPlexGuids } = plexWatchlist;
  assert.equal(tmdbIdFromPlexGuids([{ id: "imdb://tt0133093" }, { id: "tmdb://603" }, { id: "tvdb://169" }]), 603);
  assert.equal(tmdbIdFromPlexGuids([{ id: "imdb://tt0133093" }, { id: "tvdb://169" }]), null);
  assert.equal(tmdbIdFromPlexGuids([{ id: "tmdb://0" }]), null);
  assert.equal(tmdbIdFromPlexGuids([{ id: "tmdb://abc" }, { id: "tmdb://12x" }, { id: "xtmdb://5" }]), null);
  assert.equal(tmdbIdFromPlexGuids([{ id: 603 }, null, "tmdb://603"]), null);
  assert.equal(tmdbIdFromPlexGuids(undefined), null);
  assert.equal(tmdbIdFromPlexGuids("tmdb://603"), null);
});

test("parseWatchlistEntry maps movie/show, refuses other types and unsafe ratingKeys", () => {
  const { parseWatchlistEntry } = plexWatchlist;
  assert.deepEqual(
    parseWatchlistEntry({ ratingKey: "5d776825880197001ec967c8", type: "movie", title: "The Matrix", Guid: [{ id: "tmdb://603" }] }),
    { ratingKey: "5d776825880197001ec967c8", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603 },
  );
  assert.equal(parseWatchlistEntry({ ratingKey: "abc", type: "show", title: "X" })?.mediaType, "TV");
  assert.equal(parseWatchlistEntry({ ratingKey: "abc", type: "show", title: "X" })?.tmdbId, null);
  assert.equal(parseWatchlistEntry({ ratingKey: "abc", type: "episode" }), null);
  assert.equal(parseWatchlistEntry({ ratingKey: "../../admin", type: "movie" }), null, "a path-traversing key is never interpolated");
  assert.equal(parseWatchlistEntry({ type: "movie" }), null);
});

// ═══ the plex.tv client ═══════════════════════════════════════════════════════

test("fetchPlexWatchlist pages the list, sends the USER's token, and resolves guid-less entries via metadata", async () => {
  respond = (url) => {
    if (url.hostname === "discover.provider.plex.tv" && url.pathname === "/library/sections/watchlist/all") {
      const start = Number(url.searchParams.get("X-Plex-Container-Start"));
      if (start === 0) {
        const page = Array.from({ length: 50 }, (_, i) => ({ ratingKey: `k${i}`, type: "movie", title: `M${i}`, Guid: [{ id: `tmdb://${1000 + i}` }] }));
        return json({ MediaContainer: { totalSize: 52, Metadata: page } });
      }
      return json({ MediaContainer: { totalSize: 52, Metadata: [
        { ratingKey: "nog", type: "show", title: "No guid" },
        { ratingKey: "s1", type: "season", title: "Season" },
      ] } });
    }
    if (url.hostname === "metadata.provider.plex.tv" && url.pathname === "/library/metadata/nog") {
      return json({ MediaContainer: { Metadata: [{ Guid: [{ id: "tvdb://1" }, { id: "tmdb://1399" }] }] } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const items = await plexWatchlist.fetchPlexWatchlist("user-plex-token");
  assert.equal(items.length, 51, "50 movies + the show; the season is skipped");
  assert.deepEqual(items.at(-1), { ratingKey: "nog", title: "No guid", mediaType: "TV", tmdbId: 1399 });
  assert.equal(fetchCalls.filter((c) => c.url.hostname === "discover.provider.plex.tv").length, 2);
  assert.equal(fetchCalls.filter((c) => c.url.hostname === "metadata.provider.plex.tv").length, 1, "only the guid-less entry costs a lookup");
  assert.ok(fetchCalls.every((c) => c.token === "user-plex-token"));
  assert.ok(fetchCalls.every((c) => (plexWatchlist.PLEX_WATCHLIST_HOSTS as readonly string[]).includes(c.url.hostname)));
});

test("fetchPlexWatchlist: a 401 is a revoked token (PlexTokenRevokedError), any other failure a plain error", async () => {
  respond = () => json({}, 401);
  await assert.rejects(plexWatchlist.fetchPlexWatchlist("t"), plexWatchlist.PlexTokenRevokedError);
  respond = () => json({}, 503);
  await assert.rejects(plexWatchlist.fetchPlexWatchlist("t"), (err: unknown) => !(err instanceof plexWatchlist.PlexTokenRevokedError));
});

// ═══ in-app: POST /api/watchlist ═════════════════════════════════════════════

test("no AUTO_REQUEST bit ⇒ the response is the bare item (no autoRequest key) and nothing is requested", async () => {
  settings.set(FLAG, "true");
  const u = addUser({ permissions: Permission.REQUEST });
  const res = await addToWatchlist(u);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal("autoRequest" in body, false, "the iOS-decoded body must be unchanged");
  assert.equal(opsOf("mediaRequest.create").length, 0);
  assert.equal(opsOf("autoRequestLedger.upsert").length, 0);
});

test("feature flag off ⇒ the response is the bare item, even with the permission", async () => {
  const u = addUser();
  const res = await addToWatchlist(u);
  assert.equal(res.status, 201);
  assert.equal("autoRequest" in (await res.json()), false);
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

test("success: the add files a PENDING request through the chokepoint with the source note, records the ledger and audits REQUEST_AUTO", async () => {
  settings.set(FLAG, "true");
  const u = addUser();
  const res = await addToWatchlist(u, 603, "MOVIE");
  assert.equal(res.status, 201);
  const body = await res.json() as { tmdbId: number; autoRequest: { outcome: string; requested: boolean; status: string } };
  assert.equal(body.tmdbId, 603);
  assert.equal(body.autoRequest.outcome, "requested");
  assert.equal(body.autoRequest.requested, true);
  assert.equal(body.autoRequest.status, "PENDING");
  const created = (opsOf("mediaRequest.create")[0].args as { data: Record<string, unknown> }).data;
  assert.equal(created.requestedBy, u.id);
  assert.equal(created.note, "Auto-requested from watchlist");
  assert.equal(ledger.get(lkey(u.id, 603, "MOVIE"))?.outcome, "requested");
  assert.equal(ledger.get(lkey(u.id, 603, "MOVIE"))?.source, "watchlist");
  await new Promise((r) => setImmediate(r));
  const audit = opsOf("auditLog.create").map((o) => (o.args as { data: { action: string } }).data.action);
  assert.deepEqual(audit, ["REQUEST_AUTO"]);
});

test("the type-specific bit only covers its type: AUTO_REQUEST_MOVIE auto-requests a movie, not a show", async () => {
  settings.set(FLAG, "true");
  const u = addUser({ permissions: Permission.REQUEST | Permission.AUTO_REQUEST_MOVIE });
  const tv = await addToWatchlist(u, 1399, "TV");
  assert.equal("autoRequest" in (await tv.json()), false);
  const movie = await addToWatchlist(u, 603, "MOVIE");
  assert.equal((await movie.json()).autoRequest.outcome, "requested");
});

for (const [name, arrange, outcome] of [
  ["quota hit", () => { users.forEach((u) => { u.movieQuotaLimit = 1; u.movieQuotaDays = 7; }); requestCount = 1; }, "quota"],
  ["blacklisted title", () => { blacklisted = [{ tmdbId: 603, mediaType: "MOVIE" }]; }, "blacklisted"],
  ["already available", () => { inPlex = true; }, "already-available"],
  ["already requested", () => { existingRequest = { id: "r0", status: "PENDING", permanentlyDeclined: false }; }, "already-requested"],
  ["request path crashes", () => { createThrows = new Error("connection reset"); }, "error"],
] as const) {
  test(`skip reason "${name}" never fails the watchlist add: 201 + item + autoRequest.outcome=${outcome}`, async () => {
    settings.set(FLAG, "true");
    const u = addUser();
    arrange();
    const res = await addToWatchlist(u, 603, "MOVIE");
    assert.equal(res.status, 201);
    const body = await res.json() as { tmdbId: number; title: string; autoRequest: { outcome: string; requested: boolean } };
    assert.equal(body.tmdbId, 603, "the watchlist item is still in the body");
    assert.equal(body.autoRequest.outcome, outcome);
    assert.equal(body.autoRequest.requested, false);
    assert.equal(opsOf("watchlistItem.create").length, 1);
    assert.equal(ledger.get(lkey(u.id, 603, "MOVIE"))?.outcome, outcome, "the outcome is recorded so the cron won't repeat it");
  });
}

test("a failing ledger write never fails the add or the request", async () => {
  settings.set(FLAG, "true");
  ledgerWriteFails = true;
  const u = addUser();
  const res = await addToWatchlist(u);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).autoRequest.outcome, "requested");
  assert.ok(errors.some((e) => e.includes("[auto-request] ledger write")));
});

test("already on the watchlist ⇒ 409, and no auto-request is attempted", async () => {
  settings.set(FLAG, "true");
  watchlistConflict = true;
  const u = addUser();
  const res = await addToWatchlist(u);
  assert.equal(res.status, 409);
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

// ═══ the Plex watchlist cron body ═════════════════════════════════════════════

function plexWatchlistResponder(lists: Record<string, Array<{ ratingKey: string; type: string; tmdb: number }>>, failing = new Set<string>(), revoked = new Set<string>()) {
  return (url: URL, token: string | null): Response => {
    if (url.hostname !== "discover.provider.plex.tv") throw new Error(`unexpected fetch ${url}`);
    if (token && revoked.has(token)) return json({}, 401);
    if (token && failing.has(token)) return json({}, 500);
    const list = (token && lists[token]) || [];
    return json({ MediaContainer: { totalSize: list.length, Metadata: list.map((i) => ({ ratingKey: i.ratingKey, type: i.type, title: i.ratingKey, Guid: [{ id: `tmdb://${i.tmdb}` }] })) } });
  };
}

test("cron: feature flag off ⇒ skipped, no user is read and no plex.tv call is made", async () => {
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.skipped, "disabled");
  assert.equal(opsOf("user.findMany").length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("cron: files new watchlist titles; the ledger stops every re-request on the next run — even once the request is gone", async () => {
  settings.set(FLAG, "true");
  const u = addUser();
  plexTokens.set(u.id, "tok-a");
  respond = plexWatchlistResponder({ "tok-a": [{ ratingKey: "a", type: "movie", tmdb: 603 }, { ratingKey: "b", type: "show", tmdb: 1399 }] });

  const first = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(first.requested, 2);
  assert.equal(opsOf("mediaRequest.create").length, 2);
  const notes = opsOf("mediaRequest.create").map((o) => (o.args as { data: { note: string } }).data.note);
  assert.deepEqual(notes, ["Auto-requested from Plex watchlist", "Auto-requested from Plex watchlist"]);

  // The admin declines/deletes both requests; the titles stay on the Plex list.
  // Months pass — no backoff applies to a filed request.
  existingRequest = null;
  for (const row of ledger.values()) row.updatedAt = new Date(Date.now() - 365 * 86_400_000);
  ops.length = 0;
  const second = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(second.requested, 0);
  assert.equal(second.alreadyHandled, 2);
  assert.equal(opsOf("mediaRequest.create").length, 0, "a filed title is never re-filed");
});

test("cron: a quota-blocked title waits out the backoff, then is retried and filed", async () => {
  settings.set(FLAG, "true");
  const u = addUser({ movieQuotaLimit: 1, movieQuotaDays: 7 });
  plexTokens.set(u.id, "tok-q");
  respond = plexWatchlistResponder({ "tok-q": [{ ratingKey: "a", type: "movie", tmdb: 603 }] });
  requestCount = 1;
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(ledger.get(lkey(u.id, 603, "MOVIE"))?.outcome, "quota");

  requestCount = 0; // the quota window rolled over…
  ops.length = 0;
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("mediaRequest.create").length, 0, "…but not before the backoff");

  ledger.get(lkey(u.id, 603, "MOVIE"))!.updatedAt = new Date(Date.now() - autoRequest.AUTO_REQUEST_RETRY_AFTER_MS - 1);
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("mediaRequest.create").length, 1);
  assert.equal(ledger.get(lkey(u.id, 603, "MOVIE"))?.outcome, "requested");
  assert.equal(ledger.get(lkey(u.id, 603, "MOVIE"))?.attempts, 2);
});

test("cron: per-user isolation — one user's plex.tv failure is counted and the next user is still processed", async () => {
  settings.set(FLAG, "true");
  const broken = addUser();
  const healthy = addUser();
  plexTokens.set(broken.id, "tok-broken");
  plexTokens.set(healthy.id, "tok-ok");
  respond = plexWatchlistResponder({ "tok-ok": [{ ratingKey: "a", type: "movie", tmdb: 603 }] }, new Set(["tok-broken"]));
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.users, 2);
  assert.equal(r.errors, 1);
  assert.equal(r.requested, 1);
  const created = opsOf("mediaRequest.create").map((o) => (o.args as { data: { requestedBy: string } }).data.requestedBy);
  assert.deepEqual(created, [healthy.id]);
  assert.ok(errors.some((e) => e.includes(`[plex-watchlist] sync failed for user ${broken.id}`)));
});

test("cron: a revoked token (401) is deleted, not counted as a run error, and the other users still run", async () => {
  settings.set(FLAG, "true");
  const revoked = addUser();
  const ok = addUser();
  plexTokens.set(revoked.id, "tok-revoked");
  plexTokens.set(ok.id, "tok-ok");
  respond = plexWatchlistResponder({ "tok-ok": [{ ratingKey: "a", type: "movie", tmdb: 603 }] }, new Set(), new Set(["tok-revoked"]));
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.tokensRevoked, 1);
  assert.equal(r.errors, 0);
  assert.equal(r.requested, 1);
  assert.deepEqual(opsOf("account.deleteMany").map((o) => o.args), [{ userId: revoked.id, provider: "plex" }]);
  assert.equal(plexTokens.has(revoked.id), false);
});

test("cron: users without an AUTO_REQUEST bit are skipped; ADMIN passes via the superbit; per-type bits filter titles", async () => {
  settings.set(FLAG, "true");
  const plain = addUser({ permissions: Permission.REQUEST });
  const admin = addUser({ role: "ADMIN", permissions: 0n });
  const tvOnly = addUser({ permissions: Permission.REQUEST | Permission.AUTO_REQUEST_TV });
  plexTokens.set(plain.id, "tok-plain");
  plexTokens.set(admin.id, "tok-admin");
  plexTokens.set(tvOnly.id, "tok-tv");
  const list = [{ ratingKey: "a", type: "movie", tmdb: 603 }, { ratingKey: "b", type: "show", tmdb: 1399 }];
  respond = plexWatchlistResponder({ "tok-plain": list, "tok-admin": list, "tok-tv": list });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.users, 2, "the plain requester is not even read from plex.tv");
  assert.ok(!fetchCalls.some((c) => c.token === "tok-plain"));
  const filed = opsOf("mediaRequest.create").map((o) => {
    const d = (o.args as { data: { requestedBy: string; mediaType: string } }).data;
    return `${d.requestedBy}:${d.mediaType}`;
  });
  assert.deepEqual(filed.sort(), [`${admin.id}:MOVIE`, `${admin.id}:TV`, `${tvOnly.id}:TV`].sort());
});

test("cron: new filings are capped per user per run; the rest follow on later runs", async () => {
  settings.set(FLAG, "true");
  const u = addUser();
  plexTokens.set(u.id, "tok-long");
  const cap = plexWatchlist.MAX_AUTO_REQUESTS_PER_USER_PER_RUN;
  respond = plexWatchlistResponder({
    "tok-long": Array.from({ length: cap + 5 }, (_, i) => ({ ratingKey: `k${i}`, type: "movie", tmdb: 5000 + i })),
  });
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("mediaRequest.create").length, cap);
  ops.length = 0;
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("mediaRequest.create").length, 5);
});

test("cron: an aborted lock signal stops before the next user (guardrail 41) and returns rather than throwing", async () => {
  settings.set(FLAG, "true");
  const u = addUser();
  plexTokens.set(u.id, "tok-a");
  respond = plexWatchlistResponder({ "tok-a": [{ ratingKey: "a", type: "movie", tmdb: 603 }] });
  const controller = new AbortController();
  controller.abort();
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists({ signal: controller.signal }));
  assert.equal(r.users, 0);
  assert.equal(fetchCalls.length, 0);
});

// ═══ the server-token path (guardrail 34b) ════════════════════════════════════
//
// A Plex instance's owner token lists friends (community GraphQL), bridges each
// friend's uuid to the numeric account id (plex.tv/api/v2/friends), reads the
// friend's watchlist (GraphQL), and resolves node ids to TMDB through the
// metadata lookup. Node ids here are `n<tmdb>` so the metadata stub can answer.

type Friend = { uuid: string; id: string; list: number[] | "private" };
type ServerSpec = { owner?: string; ownerList?: number[]; friends: Friend[]; unbridged?: string[]; reject?: "list" | "watchlist" };
function serverResponder(servers: Record<string, ServerSpec>, userLists: Record<string, Array<{ ratingKey: string; type: string; tmdb: number }>> = {}) {
  const userToken = plexWatchlistResponder(userLists);
  return (url: URL, token: string | null, body: unknown): Response => {
    if (url.hostname === "metadata.provider.plex.tv") {
      const id = url.pathname.split("/").pop()!;
      return json({ MediaContainer: { Metadata: [{ Guid: [{ id: `tmdb://${id.slice(1)}` }] }] } });
    }
    const spec = token ? servers[token] : undefined;
    if (!spec) return userToken(url, token);
    if (url.hostname === "discover.provider.plex.tv") {
      const list = spec.ownerList ?? [];
      return json({ MediaContainer: { totalSize: list.length, Metadata: list.map((t) => ({ ratingKey: `o${t}`, type: "movie", title: "", Guid: [{ id: `tmdb://${t}` }] })) } });
    }
    if (spec.reject === "list") return json({}, 401);
    if (url.hostname === "plex.tv" && url.pathname === "/api/v2/friends") {
      return json(spec.friends.map((f) => ({ id: Number(f.id), uuid: f.uuid })));
    }
    if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") return json({ id: Number(spec.owner ?? 0) });
    if (url.hostname === "community.plex.tv") {
      const q = (body as { query: string; variables?: { user: { id: string } } });
      if (q.query.includes("allFriendsV2")) {
        const all = [...spec.friends.map((f) => f.uuid), ...(spec.unbridged ?? [])];
        return json({ data: { allFriendsV2: all.map((id) => ({ user: { id, username: id } })) } });
      }
      if (spec.reject === "watchlist") return json({}, 401);
      const friend = spec.friends.find((f) => f.uuid === q.variables!.user.id);
      if (!friend || friend.list === "private") return json({ data: { userV2: { watchlist: null } }, errors: [{ message: "not allowed" }] });
      return json({ data: { userV2: { watchlist: { nodes: friend.list.map((t) => ({ id: `n${t}`, title: "", type: "MOVIE" })), pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}
function configurePlex(slug: string, token: string) {
  const seg = slug ? slug[0].toUpperCase() + slug.slice(1) : "";
  settings.set(`plex${seg}ServerUrl`, `http://plex-${slug || "default"}.lan:32400`);
  settings.set(`plex${seg}AdminToken`, token);
}
const SERVER_SOURCE = "plexWatchlistServerSource";
const AUTO_ENROLL = "plexWatchlistServerAutoEnroll";
const graphqlWatchlistReads = () => fetchCalls.filter((c) => c.url.hostname === "community.plex.tv" && String((c.body as { query?: string })?.query).includes("userV2"));
const serverStatus = () => JSON.parse(settings.get("plexWatchlistServerStatus") ?? "null");

test("server path: off by default — a consenting friend is never read and community.plex.tv is never called", async () => {
  settings.set(FLAG, "true");
  configurePlex("", "admin-1");
  addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({ "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }] } });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.server, undefined);
  assert.equal(fetchCalls.length, 0);
});

test("server path: files a consenting friend's titles with the ADMIN token (uuid → numeric id → plexUserId), same ledger + source", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  const friend = addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({ "admin-1": { owner: "1", friends: [{ uuid: "uuid-501", id: "501", list: [603, 1399] }] } });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.requested, 2);
  assert.equal(r.server?.users, 1);
  assert.equal(r.server?.matched, 1);
  assert.equal(plexWatchlist.plexWatchlistRunProblems(r), 0);
  assert.ok(fetchCalls.every((c) => c.token === "admin-1"), "only the server owner's token is ever sent");
  const filed = opsOf("mediaRequest.create").map((o) => (o.args as { data: { requestedBy: string; note: string } }).data);
  assert.deepEqual(filed.map((d) => d.requestedBy), [friend.id, friend.id]);
  assert.ok(filed.every((d) => d.note === "Auto-requested from Plex watchlist"));
  assert.ok([...ledger.values()].every((row) => row.source === "plex-watchlist"));
  assert.deepEqual(serverStatus().users, { [friend.id]: "ok" });
});

test("server path: a user's OWN token takes precedence — their watchlist is never read through the admin token", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  const u = addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  plexTokens.set(u.id, "own-tok");
  respond = serverResponder(
    { "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [1399] }] } },
    { "own-tok": [{ ratingKey: "a", type: "movie", tmdb: 603 }] },
  );
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(graphqlWatchlistReads().length, 0);
  assert.equal(r.server?.users, 0);
  const filed = opsOf("mediaRequest.create").map((o) => (o.args as { data: { tmdbId: number } }).data.tmdbId);
  assert.deepEqual(filed, [603], "only the own-token list was filed");
});

test("server path: an admin-token 401 deletes NO Account rows, degrades the run, warns once, and the token-path users still run", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-bad");
  addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  const tokenUser = addUser();
  plexTokens.set(tokenUser.id, "own-tok");
  respond = serverResponder(
    { "admin-bad": { friends: [{ uuid: "uuid-501", id: "501", list: [1399] }], reject: "list" } },
    { "own-tok": [{ ratingKey: "a", type: "movie", tmdb: 603 }] },
  );
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("account.deleteMany").length, 0, "the ADMIN token's rejection must never delete a user's token");
  assert.equal(plexTokens.has(tokenUser.id), true);
  assert.equal(r.tokensRevoked, 0);
  assert.equal(r.server?.adminTokensRejected, 1);
  assert.ok(plexWatchlist.plexWatchlistRunProblems(r) > 0, "the run is marked degraded");
  assert.equal(r.requested, 1, "the own-token user was still processed");
  assert.equal(warns.filter((w) => w.startsWith("[plex-watchlist]") && w.includes("admin token")).length, 1);

  // Unchanged condition on the next run ⇒ no second line (guardrail 7b).
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(warns.filter((w) => w.includes("admin token")).length, 1);
});

test("server path: an admin-token 401 MID-RUN (on a friend's watchlist) also deletes nothing and stops that instance", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-flaky");
  const a = addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  const b = addUser({ plexUserId: "502", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({
    "admin-flaky": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }, { uuid: "uuid-502", id: "502", list: [604] }], reject: "watchlist" },
  });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("account.deleteMany").length, 0);
  assert.equal(r.server?.adminTokensRejected, 1);
  assert.equal(graphqlWatchlistReads().length, 1, "the second friend is not tried with a rejected token");
  assert.equal(r.errors, 0, "a rejected admin token is one instance problem, not N user errors");
  assert.deepEqual(serverStatus().users, { [a.id]: "error", [b.id]: "error" });
});

test("server path: a private watchlist is a per-user status, not an error — the run is not degraded", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  const u = addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({ "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: "private" }] } });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.server?.private, 1);
  assert.equal(r.errors, 0);
  assert.equal(plexWatchlist.plexWatchlistRunProblems(r), 0);
  assert.deepEqual(serverStatus().users, { [u.id]: "private" });
});

test("server path: CONSENT — a friend who never switched the toggle on is not read, unless the admin auto-enrolls", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  const u = addUser({ plexUserId: "501", plexWatchlistOptInAt: null }); // toggle defaults on — not consent
  const optedOut = addUser({ plexUserId: "502", plexWatchlistAutoRequest: false });
  respond = serverResponder({
    "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }, { uuid: "uuid-502", id: "502", list: [604] }] },
  });
  const first = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(first.server?.users, 0);
  assert.equal(graphqlWatchlistReads().length, 0);
  assert.equal(opsOf("mediaRequest.create").length, 0);

  settings.set(AUTO_ENROLL, "true");
  fetchCalls.length = 0;
  const second = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(second.server?.users, 1, "auto-enroll reads the permitted friend whose toggle is on…");
  const filed = opsOf("mediaRequest.create").map((o) => (o.args as { data: { requestedBy: string } }).data.requestedBy);
  assert.deepEqual(filed, [u.id], "…but never one who switched it off");
  assert.ok(!filed.includes(optedOut.id));
});

test("server path: friends are unioned across Plex instances and deduped by account id; unmatched friends counted", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  configurePlex("remote", "admin-2");
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote" }]));
  const shared = addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  const remoteOnly = addUser({ plexUserId: "777", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({
    "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }, { uuid: "uuid-900", id: "900", list: [1] }], unbridged: ["uuid-unknown"] },
    "admin-2": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }, { uuid: "uuid-777", id: "777", list: [550] }] },
  });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.server?.instances, 2);
  assert.equal(r.server?.friends, 4, "501 (on both), 900, 777, and the unbridged uuid");
  assert.equal(r.server?.unmatchedFriends, 2, "900 has no account; the unbridged uuid has no numeric id");
  const reads = graphqlWatchlistReads().map((c) => `${c.token}:${(c.body as { variables: { user: { id: string } } }).variables.user.id}`);
  assert.deepEqual(reads.sort(), ["admin-1:uuid-501", "admin-2:uuid-777"], "the shared friend is read once, through the first instance");
  const filed = opsOf("mediaRequest.create").map((o) => (o.args as { data: { requestedBy: string } }).data.requestedBy).sort();
  assert.deepEqual(filed, [shared.id, remoteOnly.id].sort());
  assert.equal(serverStatus().unmatchedFriends, 2);
});

test("server path: the owner is matched through plex.tv/api/v2/user and read from the discover list with the admin token", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  const owner = addUser({ role: "ADMIN", permissions: 0n, plexUserId: "1001", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({ "admin-1": { owner: "1001", ownerList: [603], friends: [] } });
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.server?.users, 1);
  const filed = opsOf("mediaRequest.create").map((o) => (o.args as { data: { requestedBy: string; tmdbId: number } }).data);
  assert.deepEqual(filed.map((d) => `${d.requestedBy}:${d.tmdbId}`), [`${owner.id}:603`]);
});

test("server path: new filings are capped per user per run, as on the token path", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  const cap = plexWatchlist.MAX_AUTO_REQUESTS_PER_USER_PER_RUN;
  respond = serverResponder({ "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: Array.from({ length: cap + 3 }, (_, i) => 7000 + i) }] } });
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("mediaRequest.create").length, cap);
});

test("server path: the ledger is SHARED with the token path — moving a user between paths never re-files a title", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  const u = addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  plexTokens.set(u.id, "own-tok");
  respond = serverResponder(
    { "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }] } },
    { "own-tok": [{ ratingKey: "a", type: "movie", tmdb: 603 }] },
  );
  await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(opsOf("mediaRequest.create").length, 1);

  plexTokens.delete(u.id); // their own token is gone — now read through the server
  ops.length = 0;
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists());
  assert.equal(r.server?.users, 1);
  assert.equal(r.alreadyHandled, 1);
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

test("server path: an aborted signal stops before any plex.tv call and returns (guardrail 41)", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  respond = serverResponder({ "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }] } });
  const ctl = new AbortController();
  ctl.abort();
  const r = await inScope(() => plexWatchlist.syncPlexWatchlists({ signal: ctl.signal }));
  assert.equal(fetchCalls.length, 0);
  assert.equal(r.requested, 0);
});

test("server path: an abort between friends stops before the next friend's watchlist", async () => {
  settings.set(FLAG, "true");
  settings.set(SERVER_SOURCE, "true");
  configurePlex("", "admin-1");
  addUser({ plexUserId: "501", plexWatchlistOptInAt: new Date() });
  addUser({ plexUserId: "502", plexWatchlistOptInAt: new Date() });
  const ctl = new AbortController();
  const inner = serverResponder({
    "admin-1": { friends: [{ uuid: "uuid-501", id: "501", list: [603] }, { uuid: "uuid-502", id: "502", list: [604] }] },
  });
  respond = (url, token, body) => {
    const res = inner(url, token, body);
    if (url.hostname === "community.plex.tv" && String((body as { query: string }).query).includes("userV2")) ctl.abort();
    return res;
  };
  await inScope(() => plexWatchlist.syncPlexWatchlists({ signal: ctl.signal }));
  assert.equal(graphqlWatchlistReads().length, 1);
});

test("getPlexWatchlistConnection: token wins; server needs the source on, consent, and an ok status", async () => {
  const u = addUser({ plexWatchlistOptInAt: null });
  assert.deepEqual(await plexWatchlist.getPlexWatchlistConnection(u, true), { serverSource: false, serverOptedIn: false, serverStatus: null, connectedVia: "token" });
  settings.set(SERVER_SOURCE, "true");
  settings.set("plexWatchlistServerStatus", JSON.stringify({ updatedAt: new Date().toISOString(), users: { [u.id]: "ok" }, unmatchedFriends: 0 }));
  assert.equal((await plexWatchlist.getPlexWatchlistConnection(u, false)).connectedVia, null, "no consent yet");
  const opted = { id: u.id, plexWatchlistOptInAt: new Date() };
  assert.deepEqual(await plexWatchlist.getPlexWatchlistConnection(opted, false), { serverSource: true, serverOptedIn: true, serverStatus: "ok", connectedVia: "server" });
  settings.set("plexWatchlistServerStatus", JSON.stringify({ updatedAt: new Date().toISOString(), users: { [u.id]: "private" }, unmatchedFriends: 0 }));
  const priv = await plexWatchlist.getPlexWatchlistConnection(opted, false);
  assert.equal(priv.serverStatus, "private");
  assert.equal(priv.connectedVia, null);
  assert.equal(plexWatchlist.parsePlexWatchlistServerStatus("{not json"), null);
});

// ═══ token capture at sign-in ═════════════════════════════════════════════════

test("rememberPlexWatchlistToken stores the raw token on a plex Account row only while the feature is on", async () => {
  const u = addUser({ plexUserId: "777" });
  await plexWatchlist.rememberPlexWatchlistToken(u.id, "plex-raw-token");
  assert.equal(opsOf("account.upsert").length, 0, "feature off ⇒ no Plex token is ever stored");

  settings.set(FLAG, "true");
  invalidateFeatureFlagCache();
  await plexWatchlist.rememberPlexWatchlistToken(u.id, "plex-raw-token");
  const [up] = opsOf("account.upsert").map((o) => o.args as {
    where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
    create: Record<string, unknown>;
  });
  assert.deepEqual(up.where.provider_providerAccountId, { provider: "plex", providerAccountId: "777" });
  // Raw at the call site — the Prisma extension encrypts it (guardrail 7a).
  assert.equal(up.create.access_token, "plex-raw-token");
  assert.equal(up.create.userId, u.id);
});

test("rememberPlexWatchlistToken never stores a token for a user without the permission or who opted out", async () => {
  settings.set(FLAG, "true");
  invalidateFeatureFlagCache();
  const noPerm = addUser({ plexUserId: "801", permissions: Permission.REQUEST });
  const optedOut = addUser({ plexUserId: "802", plexWatchlistAutoRequest: false });
  const before = opsOf("account.upsert").length;
  await plexWatchlist.rememberPlexWatchlistToken(noPerm.id, "tok-a");
  await plexWatchlist.rememberPlexWatchlistToken(optedOut.id, "tok-b");
  assert.equal(opsOf("account.upsert").length, before, "a full-account Plex credential is kept only when the cron would use it");
});

// ═══ language of the user-facing text ═════════════════════════════════════════

async function addToWatchlistWith(u: DbUser, headers: Record<string, string>): Promise<Response> {
  const token = await tokenFor(u);
  const { cookie, ...rest } = headers;
  const req = new NextRequest("http://localhost:3000/api/watchlist", {
    method: "POST",
    headers: { cookie: `${getSessionCookieName()}=${token}${cookie ? `; ${cookie}` : ""}`, "content-type": "application/json", ...rest },
    body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE" }),
  });
  return inScope(() => postWatchlist(req, undefined));
}

test("i18n: autoRequest.message follows the request's language; the outcome and the stored note do not", async () => {
  settings.set(FLAG, "true");
  const en = await addToWatchlist(addUser());
  const enBody = await en.json() as { autoRequest: { outcome: string; message: string } };
  assert.equal(enBody.autoRequest.message, "Requested — waiting for approval");

  const es = await addToWatchlistWith(addUser(), { cookie: "summonarr-locale=es" });
  const esBody = await es.json() as { autoRequest: { outcome: string; message: string } };
  assert.equal(esBody.autoRequest.outcome, "requested");
  assert.equal(esBody.autoRequest.message, "Solicitado — pendiente de aprobación");
  const notes = opsOf("mediaRequest.create").map((o) => (o.args as { data: { note: string } }).data.note);
  assert.deepEqual(notes, ["Auto-requested from watchlist", "Auto-requested from watchlist"]);
});

test("i18n: a chokepoint refusal reaches autoRequest.message translated, and the watchlist 409 is translated too", async () => {
  settings.set(FLAG, "true");
  blacklisted = [{ tmdbId: 603, mediaType: "MOVIE" }];
  const res = await addToWatchlistWith(addUser(), { "accept-language": "es" });
  const body = await res.json() as { autoRequest: { outcome: string; message: string } };
  assert.equal(body.autoRequest.outcome, "blacklisted");
  assert.equal(body.autoRequest.message, "Un administrador ha bloqueado este título");

  watchlistConflict = true;
  const dup = await addToWatchlistWith(addUser(), { cookie: "summonarr-locale=es" });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: "Ya está en tu lista de seguimiento" });
});
