// Per-user Trakt (src/lib/trakt-user.ts, /api/cron/sync-trakt) — guardrail 34c.
//
// What is pinned, and why:
//   1. THE DEVICE CODE NEVER LEAVES THE SERVER. Start answers the short user code
//      only; the device code (a bearer secret for the pending grant) is held
//      server-side, and polls are paced by the server so a fast client earns no
//      Trakt 429. Two concurrent polls redeem the code ONCE.
//   2. ONE TRAKT ACCOUNT, ONE SUMMONARR ACCOUNT. A Trakt account already
//      connected elsewhere answers "conflict" and stores nothing.
//   3. TOKENS ROTATE TOGETHER, AND ONLY A REFUSED GRANT ENDS A CONNECTION.
//      Trakt access tokens live 24h, so a token near expiry is refreshed BEFORE
//      use and the rotated refresh token is written with it. A refresh Trakt
//      refuses (400/401) deletes the credential AND the imported history and
//      reads "reauth"; a transient failure deletes nothing.
//   4. HISTORY IMPORT IS SPACED AND STAMP-SKIPPED. Only a moved
//      /sync/last_activities stamp re-imports, at most every
//      TRAKT_HISTORY_MIN_INTERVAL_MS, as a full replace of that user's rows.
//
// Harness: in-memory prisma stubs, dns.lookup stubbed, a scripted
// globalThis.fetch, and node:test's Date mock for the poll pacing. No DB, no
// network. The request chokepoint itself is covered by tests/auto-request.test.mts
// (the Trakt cron files through the same fileAutoRequestTitles body).
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "trakt-user-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted api.trakt.tv ───────────────────────────────────────────────────
type Call = { method: string; path: string; auth: string | null; apiKey: string | null; body: Record<string, unknown> | undefined };
const calls: Call[] = [];
let respond: (c: Call) => Response | Promise<Response> = () => { throw new Error("unexpected fetch"); };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.trakt.tv") throw new Error(`unexpected host ${url.hostname}`);
  const headers = new Headers(init?.headers);
  const c: Call = {
    method: init?.method ?? "GET",
    path: url.pathname + url.search,
    auth: headers.get("authorization"),
    apiKey: headers.get("trakt-api-key"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
  calls.push(c);
  return respond(c);
}) as typeof fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");

// ── state ───────────────────────────────────────────────────────────────────
type Ops = Array<{ op: string; args?: unknown }>;
const ops: Ops = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

const settings = new Map<string, string>();
type AccountRow = { id: string; userId: string; provider: string; providerAccountId: string; access_token: string | null; refresh_token: string | null; expires_at: number | null };
let accounts: AccountRow[] = [];
type ConnRow = {
  userId: string; username: string; watchlistAutoRequest: boolean; historySeeds: boolean;
  historyActivityAt: Date | null; historyImportedAt: Date | null; syncedAt: Date | null; status: string | null;
};
let conns: ConnRow[] = [];
type WatchedRow = { userId: string; tmdbId: number; mediaType: string; title: string; plays: number; lastWatchedAt: Date };
let watched: WatchedRow[] = [];
type UserRow = { id: string; role: string; permissions: bigint; name: string | null; email: string; deactivatedAt: Date | null; purgedAt: Date | null };
let users: UserRow[] = [];
type LedgerRow = { userId: string; tmdbId: number; mediaType: string; outcome: string; updatedAt: Date };
let ledger: LedgerRow[] = [];

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    const keys = args.where?.key?.in;
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
});

const accountModel = {
  findUnique: async (args: { where: { provider_providerAccountId: { provider: string; providerAccountId: string } } }) => {
    const w = args.where.provider_providerAccountId;
    const a = accounts.find((r) => r.provider === w.provider && r.providerAccountId === w.providerAccountId);
    return a ? { userId: a.userId } : null;
  },
  findFirst: async (args: { where: { userId: string; provider: string } }) => {
    const a = accounts.find((r) => r.userId === args.where.userId && r.provider === args.where.provider);
    return a ? { ...a } : null;
  },
  findMany: async (args: { where: { userId: string; provider: string } }) =>
    accounts.filter((r) => r.userId === args.where.userId && r.provider === args.where.provider).map((a) => ({ access_token: a.access_token })),
  update: async (args: { where: { id: string }; data: Partial<AccountRow> }) => {
    rec("account.update", args);
    const a = accounts.find((r) => r.id === args.where.id)!;
    Object.assign(a, args.data);
    return a;
  },
  upsert: async (args: {
    where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
    create: Omit<AccountRow, "id">;
    update: Partial<AccountRow>;
  }) => {
    rec("account.upsert", args);
    const w = args.where.provider_providerAccountId;
    const a = accounts.find((r) => r.provider === w.provider && r.providerAccountId === w.providerAccountId);
    if (a) Object.assign(a, args.update);
    else accounts.push({ id: `acct-${accounts.length + 1}`, ...args.create });
    return {};
  },
  deleteMany: async (args: { where: { userId: string; provider: string; NOT?: { providerAccountId: string } } }) => {
    rec("account.deleteMany", args.where);
    const before = accounts.length;
    accounts = accounts.filter((r) => !(
      r.userId === args.where.userId && r.provider === args.where.provider &&
      (!args.where.NOT || r.providerAccountId !== args.where.NOT.providerAccountId)
    ));
    return { count: before - accounts.length };
  },
};
const connModel = {
  findUnique: async (args: { where: { userId: string } }) => conns.find((c) => c.userId === args.where.userId) ?? null,
  findMany: async (args: { where: { user: { deactivatedAt: null; purgedAt: null; accounts: { some: { provider: string } } } } }) => {
    void args;
    return conns
      .filter((c) => {
        const u = users.find((x) => x.id === c.userId);
        return u && !u.deactivatedAt && !u.purgedAt && accounts.some((a) => a.userId === c.userId && a.provider === "trakt");
      })
      .map((c) => ({ ...c, user: { ...users.find((x) => x.id === c.userId)! } }));
  },
  upsert: async (args: { where: { userId: string }; create: Partial<ConnRow>; update: Partial<ConnRow> }) => {
    rec("traktConnection.upsert", args);
    const c = conns.find((x) => x.userId === args.where.userId);
    if (c) Object.assign(c, args.update);
    else conns.push({
      userId: args.where.userId, username: "", watchlistAutoRequest: true, historySeeds: true,
      historyActivityAt: null, historyImportedAt: null, syncedAt: null, status: null, ...args.create,
    });
    return {};
  },
  update: async (args: { where: { userId: string }; data: Partial<ConnRow> }) => {
    rec("traktConnection.update", args);
    Object.assign(conns.find((x) => x.userId === args.where.userId)!, args.data);
    return {};
  },
  updateMany: async (args: { where: { userId: string }; data: Partial<ConnRow> }) => {
    rec("traktConnection.updateMany", args);
    for (const c of conns) if (c.userId === args.where.userId) Object.assign(c, args.data);
    return { count: 1 };
  },
  deleteMany: async (args: { where: { userId: string } }) => {
    const before = conns.length;
    conns = conns.filter((c) => c.userId !== args.where.userId);
    return { count: before - conns.length };
  },
};
const watchedModel = {
  deleteMany: async (args: { where: { userId: string } }) => {
    rec("traktWatchedItem.deleteMany", args.where);
    const before = watched.length;
    watched = watched.filter((w) => w.userId !== args.where.userId);
    return { count: before - watched.length };
  },
  createMany: async (args: { data: WatchedRow[] }) => {
    rec("traktWatchedItem.createMany", args.data.length);
    watched.push(...args.data);
    return { count: args.data.length };
  },
};
shadowPrismaModel(prisma, "account", accountModel);
shadowPrismaModel(prisma, "traktConnection", connModel);
shadowPrismaModel(prisma, "traktWatchedItem", watchedModel);
shadowPrismaModel(prisma, "autoRequestLedger", {
  findMany: async (args: { where: { userId: string; tmdbId: { in: number[] } } }) =>
    ledger.filter((r) => r.userId === args.where.userId && args.where.tmdbId.in.includes(r.tmdbId)),
});
// The history replace locks the connection row (SELECT … FOR UPDATE) and re-reads
// its toggle; the stub answers from the same in-memory row.
let lockedReads = 0;
const queryRawInTx = async () => {
  lockedReads++;
  return conns.length > 0 ? conns.map((c) => ({ historySeeds: c.historySeeds })).slice(0, 1) : [];
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  rec("$transaction");
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)({ account: accountModel, traktConnection: connModel, traktWatchedItem: watchedModel, $queryRaw: queryRawInTx });
});

const trakt = await import("../src/lib/trakt-user.ts");

const FLAG_AUTO = "feature.behavior.watchlistAutoRequest";
const FLAG_FOR_YOU = "feature.page.forYou";

function configure(): void {
  settings.set("traktClientId", "client-id");
  settings.set("traktClientSecret", "client-secret");
}

function addUser(id: string, over: Partial<UserRow> = {}): UserRow {
  const u: UserRow = {
    id, role: "USER", name: id, email: `${id}@example.com`, deactivatedAt: null, purgedAt: null,
    permissions: Permission.REQUEST | Permission.REQUEST_MOVIE | Permission.REQUEST_TV | Permission.AUTO_REQUEST,
    ...over,
  };
  users.push(u);
  return u;
}

function connect(userId: string, over: Partial<AccountRow> = {}, connOver: Partial<ConnRow> = {}): void {
  accounts.push({
    id: `acct-${userId}`, userId, provider: "trakt", providerAccountId: `uuid-${userId}`,
    access_token: "access-1", refresh_token: "refresh-1",
    // Comfortably valid unless a test says otherwise.
    expires_at: Math.floor(Date.now() / 1000) + 20 * 60 * 60,
    ...over,
  });
  conns.push({
    userId, username: `trakt-${userId}`, watchlistAutoRequest: true, historySeeds: true,
    historyActivityAt: null, historyImportedAt: null, syncedAt: null, status: null, ...connOver,
  });
}

beforeEach(() => {
  ops.length = 0;
  calls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  accounts = [];
  conns = [];
  watched = [];
  users = [];
  ledger = [];
  lockedReads = 0;
  resetLogDedup();
  trakt.__resetTraktPendingForTests();
  invalidateFeatureFlagCache();
  respond = () => { throw new Error("unexpected fetch"); };
  mock.timers.reset();
});

// ═══ pure parsing ════════════════════════════════════════════════════════════

test("parseTraktTokenResponse anchors expiry on created_at; a missing refresh token is unusable; no expiry ⇒ due now", () => {
  const t = trakt.parseTraktTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 86_400, created_at: 1_000, token_type: "bearer", scope: "public" });
  assert.deepEqual(t, { accessToken: "a", refreshToken: "r", expiresAt: 87_400, tokenType: "bearer", scope: "public" });
  assert.equal(trakt.parseTraktTokenResponse({ access_token: "a", expires_in: 10 }), null);
  assert.equal(trakt.parseTraktTokenResponse(null), null);
  const now = 5_000_000;
  assert.equal(trakt.parseTraktTokenResponse({ access_token: "a", refresh_token: "r" }, now)!.expiresAt, 5_000);
});

test("traktTokenNeedsRefresh: within REFRESH_MARGIN_MS of expiry (or unknown) ⇒ refresh", () => {
  const now = 1_000_000_000_000;
  assert.equal(trakt.traktTokenNeedsRefresh(null, now), true);
  assert.equal(trakt.traktTokenNeedsRefresh((now + trakt.REFRESH_MARGIN_MS) / 1000, now), true);
  assert.equal(trakt.traktTokenNeedsRefresh((now + trakt.REFRESH_MARGIN_MS + 1000) / 1000, now), false);
});

test("parseTraktWatchlistEntry: movies and shows map to MOVIE/TV; seasons/episodes are skipped; a missing tmdb id is null", () => {
  assert.deepEqual(trakt.parseTraktWatchlistEntry({ type: "movie", movie: { title: "Tron", ids: { tmdb: 20526 } } }), { tmdbId: 20526, mediaType: "MOVIE", title: "Tron" });
  assert.deepEqual(trakt.parseTraktWatchlistEntry({ type: "show", show: { title: "BB", ids: { tmdb: 1396 } } }), { tmdbId: 1396, mediaType: "TV", title: "BB" });
  assert.equal(trakt.parseTraktWatchlistEntry({ type: "season", season: { ids: { tmdb: 3 } } }), null);
  assert.equal(trakt.parseTraktWatchlistEntry({ type: "movie", movie: { title: "No id", ids: { imdb: "tt1" } } })!.tmdbId, null);
  assert.equal(trakt.parseTraktWatchlistEntry({ type: "movie", movie: { title: "Junk", ids: { tmdb: "603" } } })!.tmdbId, null);
});

test("parseTraktWatchedEntry + selectTraktHistoryRows: no tmdb id or date ⇒ dropped; newest first, one row per title, capped", () => {
  const rows = [
    trakt.parseTraktWatchedEntry({ plays: 4, last_watched_at: "2026-01-01T00:00:00Z", movie: { title: "Old", ids: { tmdb: 1 } } }, "MOVIE"),
    trakt.parseTraktWatchedEntry({ plays: 56, last_watched_at: "2026-05-01T00:00:00Z", show: { title: "Show", ids: { tmdb: 2 } } }, "TV"),
    trakt.parseTraktWatchedEntry({ plays: 1, last_watched_at: "2026-03-01T00:00:00Z", movie: { title: "Mid", ids: { tmdb: 3 } } }, "MOVIE"),
    trakt.parseTraktWatchedEntry({ plays: 1, movie: { title: "Undated", ids: { tmdb: 4 } } }, "MOVIE"),
    trakt.parseTraktWatchedEntry({ plays: 1, last_watched_at: "2026-02-01T00:00:00Z", movie: { title: "No id", ids: {} } }, "MOVIE"),
  ];
  assert.equal(rows[3], null);
  assert.equal(rows[4], null);
  const kept = trakt.selectTraktHistoryRows(rows.filter((r) => r !== null), 2);
  assert.deepEqual(kept.map((r) => [r.tmdbId, r.mediaType, r.plays]), [[2, "TV", 56], [3, "MOVIE", 1]]);
});

test("traktHistoryActivityStamp is the later of the movie and episode watch stamps", () => {
  const stamp = trakt.traktHistoryActivityStamp({ movies: { watched_at: "2026-01-02T00:00:00Z" }, episodes: { watched_at: "2026-03-04T00:00:00Z" } });
  assert.equal(stamp!.toISOString(), "2026-03-04T00:00:00.000Z");
  assert.equal(trakt.traktHistoryActivityStamp({}), null);
});

test("safeVerificationUrl keeps a trakt.tv https link and replaces anything else", () => {
  assert.equal(trakt.safeVerificationUrl("https://trakt.tv/activate"), "https://trakt.tv/activate");
  assert.equal(trakt.safeVerificationUrl("https://evil.example/activate"), trakt.TRAKT_ACTIVATE_URL);
  assert.equal(trakt.safeVerificationUrl("http://trakt.tv/activate"), trakt.TRAKT_ACTIVATE_URL);
  assert.equal(trakt.safeVerificationUrl(42), trakt.TRAKT_ACTIVATE_URL);
});

// ═══ connecting ══════════════════════════════════════════════════════════════

const CFG = { clientId: "client-id", clientSecret: "client-secret" };

test("device flow: start answers only the user code; polls are paced server-side; approval stores the grant and the connection", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T12:00:00Z") });
  addUser("u1");
  let tokenAnswer = 400;
  respond = (c) => {
    if (c.path === "/oauth/device/code") return json({ device_code: "DEVICE-SECRET", user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 });
    if (c.path === "/oauth/device/token") {
      assert.equal(c.body!.code, "DEVICE-SECRET");
      assert.equal(c.body!.client_secret, "client-secret");
      return tokenAnswer === 200
        ? json({ access_token: "acc", refresh_token: "ref", expires_in: 86_400, created_at: Math.floor(Date.now() / 1000), token_type: "bearer", scope: "public" })
        : new Response(null, { status: tokenAnswer });
    }
    if (c.path === "/users/settings") {
      assert.equal(c.auth, "Bearer acc");
      return json({ user: { username: "neo", ids: { slug: "neo", uuid: "uuid-neo" } } });
    }
    throw new Error(`unexpected ${c.path}`);
  };

  const start = await trakt.startTraktDeviceAuth("u1", CFG);
  assert.deepEqual(start, { userCode: "ABCD1234", verificationUrl: "https://trakt.tv/activate", expiresIn: 600, interval: 5 });
  assert.ok(!JSON.stringify(start).includes("DEVICE-SECRET"), "the device code never reaches the browser");

  // Before the interval: answered locally, no Trakt call.
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "pending" });
  assert.equal(calls.filter((c) => c.path === "/oauth/device/token").length, 0);

  mock.timers.tick(5_000);
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "pending" }, "400 = not approved yet");
  assert.equal(calls.filter((c) => c.path === "/oauth/device/token").length, 1);

  mock.timers.tick(5_000);
  tokenAnswer = 200;
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "connected", username: "neo" });
  const acct = accounts.find((a) => a.userId === "u1")!;
  assert.equal(acct.provider, "trakt");
  assert.equal(acct.providerAccountId, "uuid-neo", "the Trakt uuid is the identity, not the renamable slug");
  // Raw tokens handed to Prisma — its extension encrypts them (guardrail 7a).
  assert.equal(acct.access_token, "acc");
  assert.equal(acct.refresh_token, "ref");
  assert.equal(conns.find((c) => c.userId === "u1")!.username, "neo");

  // The code is spent: a further poll has nothing pending.
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "expired" });
});

test("device flow: two concurrent polls redeem the code ONCE", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T12:00:00Z") });
  addUser("u1");
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  respond = async (c) => {
    if (c.path === "/oauth/device/code") return json({ device_code: "D", user_code: "U", expires_in: 600, interval: 1 });
    if (c.path === "/oauth/device/token") {
      await gate;
      return json({ access_token: "acc", refresh_token: "ref", expires_in: 86_400 });
    }
    if (c.path === "/users/settings") return json({ user: { username: "neo", ids: { uuid: "uuid-neo" } } });
    throw new Error(`unexpected ${c.path}`);
  };
  await trakt.startTraktDeviceAuth("u1", CFG);
  mock.timers.tick(1_000);
  const first = trakt.pollTraktDeviceAuth("u1", CFG);
  // Released on a real timer so a broken reservation fails the asserts below
  // instead of parking both polls on the gate forever.
  setTimeout(release, 50);
  const second = await trakt.pollTraktDeviceAuth("u1", CFG);
  assert.deepEqual(second, { state: "pending" }, "the second poll sees the reservation, not Trakt");
  assert.deepEqual(await first, { state: "connected", username: "neo" });
  assert.equal(calls.filter((c) => c.path === "/oauth/device/token").length, 1);
});

test("device flow: a Trakt account connected to ANOTHER user is a conflict — nothing is stored", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T12:00:00Z") });
  addUser("u1");
  addUser("u2");
  connect("u2", { providerAccountId: "uuid-neo" });
  respond = (c) => {
    if (c.path === "/oauth/device/code") return json({ device_code: "D", user_code: "U", expires_in: 600, interval: 1 });
    if (c.path === "/oauth/device/token") return json({ access_token: "acc-u1", refresh_token: "ref-u1", expires_in: 86_400 });
    if (c.path === "/users/settings") return json({ user: { username: "neo", ids: { uuid: "uuid-neo" } } });
    if (c.path === "/oauth/revoke") return json({});
    throw new Error(`unexpected ${c.path}`);
  };
  await trakt.startTraktDeviceAuth("u1", CFG);
  mock.timers.tick(1_000);
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "conflict" });
  // The grant Trakt just issued is handed back, not left live.
  for (let i = 0; i < 50 && !calls.some((c) => c.path === "/oauth/revoke"); i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls.find((c) => c.path === "/oauth/revoke")?.body?.token, "acc-u1");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].userId, "u2");
  assert.equal(accounts[0].access_token, "access-1", "the other user's credential is untouched");
  assert.equal(conns.some((c) => c.userId === "u1"), false);
});

test("device flow: a refusal on trakt.tv (418) reads denied and ends the pending grant", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T12:00:00Z") });
  respond = (c) => {
    if (c.path === "/oauth/device/code") return json({ device_code: "D", user_code: "U", expires_in: 600, interval: 1 });
    if (c.path === "/oauth/device/token") return new Response(null, { status: 418 });
    throw new Error(`unexpected ${c.path}`);
  };
  await trakt.startTraktDeviceAuth("u1", CFG);
  mock.timers.tick(1_000);
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "denied" });
  assert.deepEqual(await trakt.pollTraktDeviceAuth("u1", CFG), { state: "expired" });
});

test("disconnect deletes the grant, the connection and the imported history, then revokes at Trakt best-effort", async () => {
  configure();
  addUser("u1");
  connect("u1");
  watched.push({ userId: "u1", tmdbId: 1, mediaType: "MOVIE", title: "x", plays: 1, lastWatchedAt: new Date() });
  respond = (c) => {
    if (c.path === "/oauth/revoke") return new Response(null, { status: 500 });
    throw new Error(`unexpected ${c.path}`);
  };
  assert.equal(await trakt.disconnectTrakt("u1"), true);
  assert.equal(accounts.length, 0);
  assert.equal(conns.length, 0);
  assert.equal(watched.length, 0);
  // The revoke is fire-and-forget: let it reach the scripted endpoint.
  for (let i = 0; i < 50 && !warns.some((w) => w.includes("revoke")); i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c.path === "/oauth/revoke").length, 1);
  assert.equal(calls.find((c) => c.path === "/oauth/revoke")!.body!.token, "access-1");
  assert.ok(warns.some((w) => w.includes("revoke")), "a failed revoke is warned, never thrown");
});

// ═══ the sync ════════════════════════════════════════════════════════════════

test("sync: skipped until both credentials are saved, and while neither use is enabled", async () => {
  settings.set(FLAG_AUTO, "true");
  assert.equal((await trakt.syncTraktUsers()).skipped, "unconfigured");
  configure();
  settings.set(FLAG_AUTO, "false");
  settings.set(FLAG_FOR_YOU, "false");
  invalidateFeatureFlagCache();
  assert.equal((await trakt.syncTraktUsers()).skipped, "disabled");
  assert.equal(calls.length, 0);
});

test("sync: a token near expiry is refreshed FIRST; the rotated refresh token is written with it and the new token is used", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "false");
  addUser("u1");
  connect("u1", { expires_at: Math.floor(Date.now() / 1000) + 60 });
  respond = (c) => {
    if (c.path === "/oauth/token") {
      assert.equal(c.body!.grant_type, "refresh_token");
      assert.equal(c.body!.refresh_token, "refresh-1");
      return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 86_400, created_at: Math.floor(Date.now() / 1000) });
    }
    if (c.path.startsWith("/sync/watchlist/")) {
      assert.equal(c.auth, "Bearer access-2", "the list read uses the fresh token");
      return json([], 200, { "x-pagination-page-count": "1" });
    }
    throw new Error(`unexpected ${c.path}`);
  };
  const result = await trakt.syncTraktUsers();
  assert.equal(result.errors, 0);
  assert.equal(calls[0].path, "/oauth/token", "refresh before any API call");
  const acct = accounts.find((a) => a.userId === "u1")!;
  assert.equal(acct.access_token, "access-2");
  assert.equal(acct.refresh_token, "refresh-2", "Trakt rotates the refresh token — the old one is dead");
  assert.equal(conns[0].status, "ok");
});

test("sync: a REFUSED refresh ends the connection (credential + history deleted, reauth) without degrading the run; a transient one deletes nothing", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "true");
  addUser("u1");
  addUser("u2");
  connect("u1", { expires_at: 0, refresh_token: "refresh-revoked" });
  connect("u2", { expires_at: 0, refresh_token: "refresh-flaky" });
  watched.push({ userId: "u1", tmdbId: 1, mediaType: "MOVIE", title: "x", plays: 1, lastWatchedAt: new Date() });
  watched.push({ userId: "u2", tmdbId: 2, mediaType: "MOVIE", title: "y", plays: 1, lastWatchedAt: new Date() });
  respond = (c) => {
    // u1's grant is refused (400 invalid_grant); u2 hits a Trakt outage.
    if (c.path === "/oauth/token") {
      return c.body!.refresh_token === "refresh-revoked" ? json({ error: "invalid_grant" }, 400) : new Response(null, { status: 503 });
    }
    throw new Error(`unexpected ${c.path}`);
  };
  const result = await trakt.syncTraktUsers();
  assert.equal(result.tokensRevoked, 1);
  assert.equal(result.errors, 1, "u2's 503 is a run error");
  assert.equal(trakt.traktRunProblems({ ...result, errors: 0 }), 0, "a revoked grant alone never degrades the run");
  // u1: refused — the grant and the history are gone, the row says why.
  assert.equal(accounts.some((a) => a.userId === "u1"), false);
  assert.equal(watched.some((w) => w.userId === "u1"), false);
  assert.equal(conns.find((c) => c.userId === "u1")!.status, "reauth");
  // u2: transient — nothing deleted.
  assert.equal(accounts.some((a) => a.userId === "u2"), true);
  assert.equal(watched.some((w) => w.userId === "u2"), true);
  assert.equal(conns.find((c) => c.userId === "u2")!.status, "error");
});

test("sync: the watchlist is read newest-first per type and each title meets the ledger as trakt-watchlist", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "false");
  addUser("u1");
  connect("u1");
  // Every title already terminal: the filing body counts them without filing.
  ledger = [
    { userId: "u1", tmdbId: 20526, mediaType: "MOVIE", outcome: "requested", updatedAt: new Date() },
    { userId: "u1", tmdbId: 1396, mediaType: "TV", outcome: "already-available", updatedAt: new Date() },
  ];
  respond = (c) => {
    if (c.path === "/sync/watchlist/movies/added/desc?page=1&limit=100") {
      return json([{ type: "movie", movie: { title: "Tron", ids: { tmdb: 20526 } } }, { type: "movie", movie: { title: "No tmdb", ids: { imdb: "tt0" } } }], 200, { "x-pagination-page-count": "1" });
    }
    if (c.path === "/sync/watchlist/shows/added/desc?page=1&limit=100") {
      return json([{ type: "show", show: { title: "BB", ids: { tmdb: 1396 } } }], 200, { "x-pagination-page-count": "1" });
    }
    throw new Error(`unexpected ${c.path}`);
  };
  const result = await trakt.syncTraktUsers();
  assert.equal(result.alreadyHandled, 2);
  assert.equal(result.requested, 0);
  assert.ok(calls.every((c) => c.apiKey === "client-id"), "every call names the Trakt app");
});

test("sync: history is imported on a moved stamp, skipped on an unchanged one, and spaced by TRAKT_HISTORY_MIN_INTERVAL_MS", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T12:00:00Z") });
  configure();
  settings.set(FLAG_AUTO, "false");
  settings.set(FLAG_FOR_YOU, "true");
  addUser("u1");
  connect("u1");
  let stamp = "2026-10-08T10:00:00.000Z";
  respond = (c) => {
    if (c.path === "/sync/last_activities") return json({ movies: { watched_at: stamp }, episodes: { watched_at: "2026-01-01T00:00:00.000Z" } });
    if (c.path === "/sync/watched/movies") return json([{ plays: 2, last_watched_at: "2026-10-01T00:00:00Z", movie: { title: "M", ids: { tmdb: 1 } } }]);
    if (c.path === "/sync/watched/shows?extended=noseasons") return json([{ plays: 30, last_watched_at: "2026-10-02T00:00:00Z", show: { title: "S", ids: { tmdb: 2 } } }]);
    throw new Error(`unexpected ${c.path}`);
  };

  const first = await trakt.syncTraktUsers();
  assert.equal(first.historyImported, 1);
  assert.deepEqual(watched.map((w) => [w.tmdbId, w.mediaType, w.plays]).sort(), [[1, "MOVIE", 2], [2, "TV", 30]]);
  assert.equal(conns[0].historyActivityAt!.toISOString(), stamp);

  // Inside the spacing window: not even the activity probe is called.
  calls.length = 0;
  mock.timers.tick(trakt.TRAKT_HISTORY_MIN_INTERVAL_MS - 1000);
  assert.equal((await trakt.syncTraktUsers()).historyImported, 0);
  assert.equal(calls.length, 0);

  // Past the window, stamp unchanged: one probe, no history read.
  mock.timers.tick(2000);
  assert.equal((await trakt.syncTraktUsers()).historyImported, 0);
  assert.deepEqual(calls.map((c) => c.path), ["/sync/last_activities"]);

  // A moved stamp re-imports as a full replace.
  calls.length = 0;
  stamp = "2026-10-09T10:00:00.000Z";
  assert.equal((await trakt.syncTraktUsers()).historyImported, 1);
  assert.equal(watched.length, 2, "replaced, not appended");
  assert.equal(opsOf("traktWatchedItem.deleteMany").length, 2);
});

test("sync: an opted-out user, a deactivated user and a user without the permission cost no Trakt call", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "false");
  addUser("off");
  connect("off", {}, { watchlistAutoRequest: false });
  addUser("gone", { deactivatedAt: new Date() });
  connect("gone");
  addUser("noperm", { permissions: Permission.REQUEST });
  connect("noperm");
  const result = await trakt.syncTraktUsers();
  assert.equal(result.users, 0);
  assert.equal(calls.length, 0);
});

test("sync: an aborted signal stops before the next user and returns (guardrail 41)", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "false");
  addUser("u1");
  connect("u1");
  addUser("u2");
  connect("u2");
  const controller = new AbortController();
  respond = (c) => {
    controller.abort();
    if (c.path.startsWith("/sync/watchlist/")) return json([], 200, { "x-pagination-page-count": "1" });
    throw new Error(`unexpected ${c.path}`);
  };
  const result = await trakt.syncTraktUsers({ signal: controller.signal });
  assert.equal(result.users, 1, "the second user is never started");
  assert.equal(calls.length, 1, "the abort is observed between the movie and show pages too");
});

test("classifyTraktRefreshFailure: only invalid_grant ends a grant; any other 400/401 is the app's credentials; the rest is transient", () => {
  assert.equal(trakt.classifyTraktRefreshFailure(400, { error: "invalid_grant" }), "revoked");
  assert.equal(trakt.classifyTraktRefreshFailure(401, { error: "invalid_grant" }), "revoked");
  assert.equal(trakt.classifyTraktRefreshFailure(401, { error: "invalid_client" }), "client");
  assert.equal(trakt.classifyTraktRefreshFailure(401, null), "client", "an unreadable 401 never deletes anyone's grant");
  assert.equal(trakt.classifyTraktRefreshFailure(400, { error: "invalid_request" }), "client");
  assert.equal(trakt.classifyTraktRefreshFailure(503, { error: "invalid_grant" }), "transient");
});

test("sync: a REFUSED APP credential (invalid_client) deletes NO grant, stops the run, degrades it and warns once", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "true");
  addUser("u1");
  addUser("u2");
  connect("u1", { expires_at: 0 });
  connect("u2", { expires_at: 0 });
  watched.push({ userId: "u1", tmdbId: 1, mediaType: "MOVIE", title: "x", plays: 1, lastWatchedAt: new Date() });
  respond = (c) => {
    if (c.path === "/oauth/token") return json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
    throw new Error(`unexpected ${c.path}`);
  };
  const first = await trakt.syncTraktUsers();
  assert.equal(first.clientRejected, true);
  assert.equal(first.tokensRevoked, 0);
  assert.ok(trakt.traktRunProblems(first) > 0, "the run degrades — the admin has something to fix");
  assert.equal(calls.filter((c) => c.path === "/oauth/token").length, 1, "the run stops at the first refusal");
  assert.equal(accounts.length, 2, "no grant deleted");
  assert.equal(watched.length, 1, "no history deleted");
  assert.notEqual(conns.find((c) => c.userId === "u1")!.status, "reauth");
  await trakt.syncTraktUsers();
  assert.equal(warns.filter((w) => w.includes("client id/secret")).length, 1, "an unchanged condition is warned once (guardrail 7b)");
});

test("sync: history switched OFF while it was being read writes nothing and records no import", async () => {
  configure();
  settings.set(FLAG_AUTO, "false");
  settings.set(FLAG_FOR_YOU, "true");
  addUser("u1");
  connect("u1");
  respond = (c) => {
    if (c.path === "/sync/last_activities") return json({ movies: { watched_at: "2026-10-08T10:00:00.000Z" } });
    if (c.path === "/sync/watched/movies") return json([{ plays: 1, last_watched_at: "2026-10-01T00:00:00Z", movie: { title: "M", ids: { tmdb: 1 } } }]);
    if (c.path === "/sync/watched/shows?extended=noseasons") {
      // The user flips the toggle off (PATCH deletes their rows) mid-read.
      conns[0].historySeeds = false;
      return json([]);
    }
    throw new Error(`unexpected ${c.path}`);
  };
  const result = await trakt.syncTraktUsers();
  assert.equal(lockedReads, 1, "the write path re-read the toggle under the row lock");
  assert.equal(result.historyImported, 0);
  assert.equal(watched.length, 0, "nothing re-inserted after the user asked for deletion");
  assert.equal(conns[0].historyImportedAt, null);
});

test("sync: a user who DISCONNECTED mid-run is not a run error", async () => {
  configure();
  settings.set(FLAG_AUTO, "true");
  settings.set(FLAG_FOR_YOU, "false");
  addUser("u1");
  connect("u1");
  respond = (c) => {
    if (c.path.startsWith("/sync/watchlist/movies")) {
      conns = [];
      accounts = [];
      return json([]);
    }
    if (c.path.startsWith("/sync/watchlist/shows")) return json([]);
    throw new Error(`unexpected ${c.path}`);
  };
  const result = await trakt.syncTraktUsers();
  assert.equal(result.errors, 0);
});

test("device flow: a failure AFTER the code was redeemed hands the new grant back", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T12:00:00Z") });
  respond = (c) => {
    if (c.path === "/oauth/device/code") return json({ device_code: "D", user_code: "U", expires_in: 600, interval: 1 });
    if (c.path === "/oauth/device/token") return json({ access_token: "acc-fail", refresh_token: "ref", expires_in: 86_400 });
    if (c.path === "/users/settings") return new Response(null, { status: 502 });
    if (c.path === "/oauth/revoke") return json({});
    throw new Error(`unexpected ${c.path}`);
  };
  await trakt.startTraktDeviceAuth("u1", CFG);
  mock.timers.tick(1_000);
  await assert.rejects(() => trakt.pollTraktDeviceAuth("u1", CFG));
  for (let i = 0; i < 50 && !calls.some((c) => c.path === "/oauth/revoke"); i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls.find((c) => c.path === "/oauth/revoke")?.body?.token, "acc-fail");
  assert.equal(accounts.length, 0);
});

test("no success logs (guardrail 7) and nothing unexpected reached console.error", () => {
  assert.deepEqual(errors.filter((e) => !e.includes("sync failed for user")), []);
});
