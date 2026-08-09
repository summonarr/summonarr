// Route-level unit tests for five previously-uncovered routes that share one
// theme — a per-caller resource with no user pivot:
//   /api/hidden        GET/POST/DELETE  the caller's "not interested" list
//   /api/watchlist     GET/POST/DELETE  the caller's save-for-later list
//   /api/requests/token GET             mints the HMAC that gates request creation
//   /api/requests/users GET             the on-behalf-of picker
//   /api/health        GET              the Docker HEALTHCHECK target
//
// What each is actually risky for:
//
//   1. OWNERSHIP SCOPING (hidden, watchlist). Every read, write and delete is
//      keyed on session.user.id and there is deliberately no userId parameter.
//      The tests send ?userId= / body userId pointing at somebody else and
//      assert the query is STILL scoped to the caller — the failure mode is a
//      user reading or deleting another user's list. DELETE is the sharpest:
//      an unscoped deleteMany would clear the pair for every user at once.
//   2. THE REQUEST TOKEN IS PER-USER AND PER-ITEM. /api/requests/token mints the
//      HMAC that POST /api/requests verifies. A token minted for user A must not
//      validate for user B, or for a different tmdbId/mediaType — otherwise the
//      gate stops being a gate.
//   3. requests/users IS PERMISSION-GATED, NOT ADMIN-GATED, and must exclude
//      deactivated accounts. It sits outside /api/admin/* on purpose (the proxy
//      backstop would block a legitimate REQUEST_ON_BEHALF holder), so the
//      permission check on the route is the ONLY thing standing there. It also
//      must not leak more of the user row than the picker needs.
//   4. /api/health MUST REFLECT DB READINESS. It is the container HEALTHCHECK
//      target, so a live Node process fronting a dead Postgres has to report 503
//      — a bare {ok:true} liveness reply hid exactly that. It is also public by
//      design (no auth), which is why it must never leak anything but up/down.
//   5. Shared: guardrail-30 body caps, P2002 mapped to a 409 rather than a 500,
//      idempotent DELETE, and per-user rate limits.
//
// Harness: the tests/votes-route.test.mts idiom — real wrapped handlers, genuine
// signed session JWTs, a synthetic workAsyncStorage + workUnitAsyncStorage
// scope, in-memory prisma stubs, and a scripted fetch (watchlist's TMDB
// verification is the only sanctioned wire call). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "personal-lists-test-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── DNS stub (the tests/tmdb.test.mts pattern) ──────────────────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch — TMDB verification only ─────────────────────────────────
let tmdbOk = true;
const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  if (!(url.hostname === "themoviedb.org" || url.hostname.endsWith(".themoviedb.org"))) {
    throw new Error(`unexpected non-TMDB fetch: ${url}`);
  }
  if (!tmdbOk) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  const isTv = url.pathname.includes("/tv/");
  return new Response(
    JSON.stringify(
      isTv
        ? { id: 1399, name: "Game of Thrones", poster_path: "/got.jpg", first_air_date: "2011-04-17" }
        : { id: 603, title: "The Matrix", poster_path: "/matrix.jpg", release_date: "1999-03-31" },
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { Prisma } = await import("@/generated/prisma");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { verifyRequestToken } = await import("../src/lib/request-token.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
type DbUser = {
  id: string;
  name: string | null;
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null,
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { permissions?: bigint; role?: string } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `member-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = (opts.permissions ?? 0n).toString();
  usersById.set(userId, {
    id: userId,
    name: `Member ${seq}`,
    role,
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `member-${seq}@example.com`,
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}

const COOKIE = getSessionCookieName();

// ── list-model stubs (hidden + watchlist share the shape) ────────────────────
type ListRow = { userId: string; tmdbId: number; mediaType: string; title: string; posterPath: string | null; createdAt: Date };
let hiddenRows: ListRow[] = [];
let watchlistRows: ListRow[] = [];
let nextCreateThrows: "P2002" | null = null;

function listModel(name: string, store: () => ListRow[]) {
  const match = (r: ListRow, where: Record<string, unknown>): boolean => {
    if (where.userId !== undefined && r.userId !== where.userId) return false;
    if (where.tmdbId !== undefined && r.tmdbId !== where.tmdbId) return false;
    if (where.mediaType !== undefined && r.mediaType !== where.mediaType) return false;
    const t = where.title as { contains?: string } | undefined;
    if (t?.contains && !r.title.toLowerCase().includes(t.contains.toLowerCase())) return false;
    return true;
  };
  return {
    findMany: async (args: { where: Record<string, unknown>; skip?: number; take?: number }) => {
      rec(`${name}.findMany`, args.where);
      const rows = store()
        .filter((r) => match(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = args.skip ?? 0;
      return rows.slice(start, start + (args.take ?? rows.length));
    },
    count: async (args: { where: Record<string, unknown> }) => {
      rec(`${name}.count`, args.where);
      return store().filter((r) => match(r, args.where)).length;
    },
    // The routes never send createdAt — the DB default supplies it — so the
    // stub's row shape is the payload plus a stamped timestamp.
    create: async (args: { data: Omit<ListRow, "createdAt"> }) => {
      rec(`${name}.create`, args.data);
      if (nextCreateThrows === "P2002") {
        nextCreateThrows = null;
        throw new Prisma.PrismaClientKnownRequestError("unique violation", {
          code: "P2002",
          clientVersion: "0.0.0-test",
        });
      }
      const row = { createdAt: new Date(), ...args.data };
      store().push(row);
      return row;
    },
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      rec(`${name}.deleteMany`, args.where);
      const keep = store().filter((r) => !match(r, args.where));
      const removed = store().length - keep.length;
      store().length = 0;
      store().push(...keep);
      return { count: removed };
    },
  };
}
shadowPrismaModel(prisma, "hiddenItem", listModel("hiddenItem", () => hiddenRows));
shadowPrismaModel(prisma, "watchlistItem", listModel("watchlistItem", () => watchlistRows));

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, boolean>; take?: number }) => {
    rec("user.findMany", { where: args.where, select: args.select, take: args.take });
    let rows = [...usersById.values()];
    if (args.where && "deactivatedAt" in args.where) {
      rows = rows.filter((u) => u.deactivatedAt === (args.where as { deactivatedAt: null }).deactivatedAt);
    }
    // Honor `select` so a widened projection is observable in the payload.
    return rows.map((u) => {
      if (!args.select) return { ...u };
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) out[k] = (u as unknown as Record<string, unknown>)[k];
      return out;
    });
  },
  update: async () => ({}),
});

shadowPrismaModel(prisma, "setting", { findUnique: async () => null, findMany: async () => [] });

// resolveMediaMeta's first two tiers (TmdbMediaCore, the details TmdbCache
// blob). Default to misses so the existing tests keep exercising the tier-3
// live-verify wire path (scripted fetch); a test can point `metaRow` at a row to pin the
// cached tier short-circuiting the wire.
let metaRow: { title: string; posterPath: string | null; releaseYear: string } | null = null;
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findUnique: async () => metaRow,
});
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  upsert: async (args: { where: { key: string } }) => args,
  deleteMany: async () => ({ count: 0 }),
});


// /api/health pings the DB with $queryRaw; `dbUp` steers it.
let dbUp = true;
shadowPrismaClientMethod(prisma, "$queryRaw", async () => {
  rec("$queryRaw");
  if (!dbUp) throw new Error("connection refused");
  return [{ "?column?": 1 }];
});

// Routes under test (imported AFTER every stub is in place).
const hidden = await import("../src/app/api/hidden/route.ts");
const watchlist = await import("../src/app/api/watchlist/route.ts");
const requestsToken = await import("../src/app/api/requests/token/route.ts");
const requestsUsers = await import("../src/app/api/requests/users/route.ts");
const health = await import("../src/app/api/health/route.ts");

// ── synthetic request scope ──────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/personal-lists.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string }) {
  return new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const LISTS = [
  { name: "hidden", mod: hidden, rows: () => hiddenRows, model: "hiddenItem", verifies: false },
  { name: "watchlist", mod: watchlist, rows: () => watchlistRows, model: "watchlistItem", verifies: true },
] as const;

beforeEach(() => {
  ops = [];
  hiddenRows = [];
  watchlistRows = [];
  nextCreateThrows = null;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  tmdbOk = true;
  dbUp = true;
});

// ── auth ─────────────────────────────────────────────────────────────────────

for (const list of LISTS) {
  test(`${list.name}: all three verbs refuse an anonymous caller`, async () => {
    const g = await inScope(() => list.mod.GET(mk(`/api/${list.name}`, null, { method: "GET" }), undefined));
    const p = await inScope(() => list.mod.POST(mk(`/api/${list.name}`, null, { method: "POST", body: "{}" }), undefined));
    const d = await inScope(() => list.mod.DELETE(mk(`/api/${list.name}`, null, { method: "DELETE", query: "?tmdbId=1&mediaType=MOVIE" }), undefined));
    assert.deepEqual([g.status, p.status, d.status], [401, 401, 401]);
    assert.equal(opsOf(`${list.model}.findMany`).length, 0);
    assert.equal(opsOf(`${list.model}.deleteMany`).length, 0);
  });
}

// ── 1: ownership scoping ─────────────────────────────────────────────────────

for (const list of LISTS) {
  test(`${list.name} GET is scoped to the caller and ignores a ?userId= override`, async () => {
    const me = await mintSession();
    const them = await mintSession();
    list.rows().push(
      { userId: me.userId, tmdbId: 1, mediaType: "MOVIE", title: "Mine", posterPath: null, createdAt: new Date() },
      { userId: them.userId, tmdbId: 2, mediaType: "MOVIE", title: "Theirs", posterPath: null, createdAt: new Date() },
    );
    const res = await inScope(() =>
      list.mod.GET(mk(`/api/${list.name}`, me.token, { method: "GET", query: `?userId=${them.userId}` }), undefined),
    );
    const body = await res.json();
    assert.deepEqual(body.items.map((i: ListRow) => i.title), ["Mine"]);
    assert.equal(body.total, 1);
    const where = opsOf(`${list.model}.findMany`)[0].args as { userId: string };
    assert.equal(where.userId, me.userId, "the query must be scoped to the SESSION user");
  });

  test(`${list.name} POST writes under the caller's id even when the body names another user`, async () => {
    const me = await mintSession();
    const them = await mintSession();
    await inScope(() =>
      list.mod.POST(
        mk(`/api/${list.name}`, me.token, {
          method: "POST",
          body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE", userId: them.userId }),
        }),
        undefined,
      ),
    );
    const data = opsOf(`${list.model}.create`)[0].args as { userId: string };
    assert.equal(data.userId, me.userId, "a body-supplied userId must never be honored");
  });

  test(`${list.name} DELETE is scoped to the caller — it cannot clear another user's row`, async () => {
    // The sharpest one: an unscoped deleteMany here would remove the pair for
    // EVERY user in a single request.
    const me = await mintSession();
    const them = await mintSession();
    list.rows().push(
      { userId: me.userId, tmdbId: 603, mediaType: "MOVIE", title: "Mine", posterPath: null, createdAt: new Date() },
      { userId: them.userId, tmdbId: 603, mediaType: "MOVIE", title: "Theirs", posterPath: null, createdAt: new Date() },
    );
    const res = await inScope(() =>
      list.mod.DELETE(mk(`/api/${list.name}`, me.token, { method: "DELETE", query: `?tmdbId=603&mediaType=MOVIE&userId=${them.userId}` }), undefined),
    );
    assert.equal(res.status, 200);
    const where = opsOf(`${list.model}.deleteMany`)[0].args as { userId: string };
    assert.equal(where.userId, me.userId);
    assert.deepEqual(list.rows().map((r) => r.userId), [them.userId], "the other user's row must survive");
  });

  test(`${list.name} GET's count query carries the SAME scope as the page query`, async () => {
    // A total computed over an unscoped where would leak the global row count.
    const me = await mintSession();
    await inScope(() => list.mod.GET(mk(`/api/${list.name}`, me.token, { method: "GET" }), undefined));
    const page = opsOf(`${list.model}.findMany`)[0].args as { userId: string };
    const count = opsOf(`${list.model}.count`)[0].args as { userId: string };
    assert.equal(page.userId, me.userId);
    assert.equal(count.userId, me.userId);
  });
}

// ── shared validation + write semantics ──────────────────────────────────────

for (const list of LISTS) {
  for (const [label, body] of [
    ["a missing tmdbId", { mediaType: "MOVIE" }],
    ["a missing mediaType", { tmdbId: 603 }],
    ["a zero tmdbId", { tmdbId: 0, mediaType: "MOVIE" }],
    ["a negative tmdbId", { tmdbId: -1, mediaType: "MOVIE" }],
    ["a float tmdbId", { tmdbId: 1.5, mediaType: "MOVIE" }],
    ["a string tmdbId", { tmdbId: "603", mediaType: "MOVIE" }],
    ["a lowercase mediaType", { tmdbId: 603, mediaType: "movie" }],
    ["an unknown mediaType", { tmdbId: 603, mediaType: "ANIME" }],
  ] as const) {
    test(`${list.name} POST with ${label} is 400 and writes nothing`, async () => {
      const me = await mintSession();
      const res = await inScope(() =>
        list.mod.POST(mk(`/api/${list.name}`, me.token, { method: "POST", body: JSON.stringify(body) }), undefined),
      );
      assert.equal(res.status, 400);
      assert.equal(opsOf(`${list.model}.create`).length, 0);
    });
  }

  test(`${list.name} POST maps a P2002 unique violation to 409, not a 500`, async () => {
    const me = await mintSession();
    nextCreateThrows = "P2002";
    const res = await inScope(() =>
      list.mod.POST(mk(`/api/${list.name}`, me.token, { method: "POST", body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE" }) }), undefined),
    );
    assert.equal(res.status, 409);
  });

  test(`${list.name} POST with a malformed body is 400, not a 500`, async () => {
    const me = await mintSession();
    const res = await inScope(() =>
      list.mod.POST(mk(`/api/${list.name}`, me.token, { method: "POST", body: "{not json" }), undefined),
    );
    assert.equal(res.status, 400);
  });

  test(`${list.name} POST rejects an oversized body (guardrail 30)`, async () => {
    const me = await mintSession();
    const huge = JSON.stringify({ tmdbId: 603, mediaType: "MOVIE", title: "z".repeat(30_000) });
    const res = await inScope(() =>
      list.mod.POST(mk(`/api/${list.name}`, me.token, { method: "POST", body: huge }), undefined),
    );
    assert.ok(res.status === 400 || res.status === 413, `expected a cap rejection, got ${res.status}`);
    assert.equal(opsOf(`${list.model}.create`).length, 0);
  });

  test(`${list.name} DELETE of an absent row is an idempotent 200`, async () => {
    const me = await mintSession();
    const res = await inScope(() =>
      list.mod.DELETE(mk(`/api/${list.name}`, me.token, { method: "DELETE", query: "?tmdbId=999&mediaType=TV" }), undefined),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test(`${list.name} DELETE validates its query params`, async () => {
    const me = await mintSession();
    for (const q of ["?mediaType=MOVIE", "?tmdbId=603", "?tmdbId=abc&mediaType=MOVIE", "?tmdbId=603&mediaType=X"]) {
      const res = await inScope(() =>
        list.mod.DELETE(mk(`/api/${list.name}`, me.token, { method: "DELETE", query: q }), undefined),
      );
      assert.equal(res.status, 400, `query ${q} should be rejected`);
    }
    assert.equal(opsOf(`${list.model}.deleteMany`).length, 0);
  });

  test(`${list.name} GET clamps the page number rather than trusting it`, async () => {
    // page is a raw query param multiplied into `skip`. Unclamped, page=0 or a
    // negative yields a NEGATIVE skip (a Prisma error), and an unbounded page
    // lets a caller drive an arbitrarily large OFFSET scan.
    const me = await mintSession();
    const seen: Array<{ q: string; page: number; skip: number }> = [];
    for (const q of ["?page=0", "?page=-5", "?page=abc", "?page=1", "?page=3", "?page=999999999"]) {
      ops = [];
      const res = await inScope(() =>
        list.mod.GET(mk(`/api/${list.name}`, me.token, { method: "GET", query: q }), undefined),
      );
      assert.equal(res.status, 200, `page ${q} should still serve`);
      const body = await res.json();
      seen.push({ q, page: body.page, skip: (body.page - 1) * body.pageSize });
    }
    for (const s of seen) {
      assert.ok(Number.isInteger(s.page) && s.page >= 1, `${s.q} produced page=${s.page}`);
      assert.ok(s.skip >= 0, `${s.q} produced a negative skip (${s.skip})`);
      assert.ok(s.page <= 10_000, `${s.q} produced an unclamped page=${s.page}`);
    }
    // The specific clamps, so a widened bound is a deliberate edit.
    assert.equal(seen.find((s) => s.q === "?page=0")!.page, 1);
    assert.equal(seen.find((s) => s.q === "?page=-5")!.page, 1);
    assert.equal(seen.find((s) => s.q === "?page=abc")!.page, 1);
    assert.equal(seen.find((s) => s.q === "?page=3")!.page, 3);
    assert.equal(seen.find((s) => s.q === "?page=999999999")!.page, 10_000);
  });
}

// hidden-specific: no TMDB round trip, by design.
test("hidden POST never contacts TMDB — a 'not interested' tap must not fail on an upstream outage", async () => {
  const me = await mintSession();
  const res = await inScope(() =>
    hidden.POST(mk("/api/hidden", me.token, { method: "POST", body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE", title: "The Matrix" }) }), undefined),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(fetchCalls, []);
});

test("hidden POST bounds the caller-supplied title and posterPath", async () => {
  const me = await mintSession();
  await inScope(() =>
    hidden.POST(
      mk("/api/hidden", me.token, {
        method: "POST",
        body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE", title: "t".repeat(2000), posterPath: "p".repeat(2000) }),
      }),
      undefined,
    ),
  );
  const data = opsOf("hiddenItem.create")[0].args as { title: string; posterPath: string | null };
  assert.ok(data.title.length <= 500, `title was ${data.title.length} chars`);
  assert.equal(data.posterPath, null, "an over-long posterPath must be dropped, not stored");
});

// watchlist-specific: TMDB verification supplies the denormalized fields.
test("watchlist POST verifies against TMDB and stores the verified title, not a caller-supplied one", async () => {
  const me = await mintSession();
  const res = await inScope(() =>
    watchlist.POST(
      mk("/api/watchlist", me.token, {
        method: "POST",
        body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE", title: "ATTACKER CONTROLLED" }),
      }),
      undefined,
    ),
  );
  assert.equal(res.status, 201);
  const data = opsOf("watchlistItem.create")[0].args as { title: string };
  assert.equal(data.title, "The Matrix");
});

test("watchlist POST serves a warm TmdbMediaCore row WITHOUT touching the TMDB wire (three-tier resolver)", async () => {
  // The route resolves via resolveMediaMeta, not a direct live verify — a title
  // the app already knows must not cost a TMDB call per mutation (and must
  // still work during a TMDB outage).
  metaRow = { title: "Core Matrix", posterPath: "/core.jpg", releaseYear: "1999" };
  tmdbOk = false; // even a hard TMDB outage must not block a known title
  try {
    const me = await mintSession();
    const before = fetchCalls.length;
    const res = await inScope(() =>
      watchlist.POST(
        mk("/api/watchlist", me.token, { method: "POST", body: JSON.stringify({ tmdbId: 603, mediaType: "MOVIE" }) }),
        undefined,
      ),
    );
    assert.equal(res.status, 201);
    assert.equal(fetchCalls.length, before, "tier 1 (TmdbMediaCore) must short-circuit the live verify");
    const data = opsOf("watchlistItem.create").at(-1)!.args as { title: string; posterPath: string | null };
    assert.equal(data.title, "Core Matrix");
    assert.equal(data.posterPath, "/core.jpg");
  } finally {
    metaRow = null;
  }
});

test("watchlist POST returns 422 when TMDB cannot verify the item, and writes nothing", async () => {
  tmdbOk = false;
  const me = await mintSession();
  const res = await inScope(() =>
    watchlist.POST(mk("/api/watchlist", me.token, { method: "POST", body: JSON.stringify({ tmdbId: 999999, mediaType: "MOVIE" }) }), undefined),
  );
  assert.equal(res.status, 422);
  assert.equal(opsOf("watchlistItem.create").length, 0);
});

test("watchlist GET's search term is wildcard-stripped before it reaches `contains`", async () => {
  // Prisma's `contains` emits an ILIKE with no ESCAPE clause, so raw %/_ stay
  // wildcards and force an unindexable scan (a search-box DoS).
  const me = await mintSession();
  await inScope(() => watchlist.GET(mk("/api/watchlist", me.token, { method: "GET", query: "?q=%25%25%25_%5C" }), undefined));
  const where = opsOf("watchlistItem.findMany")[0].args as { title?: { contains: string } };
  if (where.title) {
    for (const ch of ["%", "_", "\\"]) {
      assert.ok(!where.title.contains.includes(ch), `wildcard ${ch} reached the contains filter`);
    }
  }
});

test("watchlist GET's type filter is whitelisted to the two enum literals", async () => {
  const me = await mintSession();
  for (const [q, want] of [["?type=MOVIE", "MOVIE"], ["?type=TV", "TV"], ["?type=ANIME", undefined], ["?type=movie", undefined]] as const) {
    ops = [];
    await inScope(() => watchlist.GET(mk("/api/watchlist", me.token, { method: "GET", query: q }), undefined));
    const where = opsOf("watchlistItem.findMany")[0].args as { mediaType?: string };
    assert.equal(where.mediaType, want, `type=${q} produced mediaType=${where.mediaType}`);
  }
});

// ── 2: the request token ─────────────────────────────────────────────────────

test("requests/token mints a token that verifies for that user, item and type", async () => {
  const me = await mintSession();
  const res = await inScope(() =>
    requestsToken.GET(mk("/api/requests/token", me.token, { method: "GET", query: "?tmdbId=603&mediaType=MOVIE" }), undefined),
  );
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.equal(verifyRequestToken(token, 603, "MOVIE", me.userId), true);
});

test("a token minted for one user does NOT verify for another", async () => {
  const me = await mintSession();
  const them = await mintSession();
  const res = await inScope(() =>
    requestsToken.GET(mk("/api/requests/token", me.token, { method: "GET", query: "?tmdbId=603&mediaType=MOVIE" }), undefined),
  );
  const { token } = await res.json();
  assert.equal(verifyRequestToken(token, 603, "MOVIE", them.userId), false);
});

test("a token is bound to its tmdbId and mediaType", async () => {
  const me = await mintSession();
  const res = await inScope(() =>
    requestsToken.GET(mk("/api/requests/token", me.token, { method: "GET", query: "?tmdbId=603&mediaType=MOVIE" }), undefined),
  );
  const { token } = await res.json();
  assert.equal(verifyRequestToken(token, 604, "MOVIE", me.userId), false, "a different tmdbId must not verify");
  assert.equal(verifyRequestToken(token, 603, "TV", me.userId), false, "a different mediaType must not verify");
});

test("requests/token refuses an anonymous caller", async () => {
  const res = await inScope(() =>
    requestsToken.GET(mk("/api/requests/token", null, { method: "GET", query: "?tmdbId=603&mediaType=MOVIE" }), undefined),
  );
  assert.equal(res.status, 401);
});

for (const [label, q] of [
  ["a missing tmdbId", "?mediaType=MOVIE"],
  ["a zero tmdbId", "?tmdbId=0&mediaType=MOVIE"],
  ["a negative tmdbId", "?tmdbId=-2&mediaType=MOVIE"],
  ["a non-numeric tmdbId", "?tmdbId=abc&mediaType=MOVIE"],
  ["a missing mediaType", "?tmdbId=603"],
  ["an unknown mediaType", "?tmdbId=603&mediaType=ANIME"],
] as const) {
  test(`requests/token with ${label} is 400 and mints nothing`, async () => {
    const me = await mintSession();
    const res = await inScope(() => requestsToken.GET(mk("/api/requests/token", me.token, { method: "GET", query: q }), undefined));
    assert.equal(res.status, 400);
    assert.ok(!("token" in (await res.json())));
  });
}

// ── 3: the on-behalf-of picker ───────────────────────────────────────────────

test("requests/users refuses a caller without REQUEST_ON_BEHALF", async () => {
  const plain = await mintSession();
  const res = await inScope(() => requestsUsers.GET(mk("/api/requests/users", plain.token, { method: "GET" }), undefined));
  assert.equal(res.status, 403);
  assert.equal(opsOf("user.findMany").length, 0);
});

test("requests/users refuses an anonymous caller with 401, not 403", async () => {
  const res = await inScope(() => requestsUsers.GET(mk("/api/requests/users", null, { method: "GET" }), undefined));
  assert.equal(res.status, 401);
});

test("requests/users admits a NON-admin holding REQUEST_ON_BEHALF", async () => {
  // The whole reason it lives outside /api/admin/*: the proxy backstop there
  // would block a legitimate holder who has no admin role.
  const power = await mintSession({ permissions: Permission.REQUEST_ON_BEHALF });
  const res = await inScope(() => requestsUsers.GET(mk("/api/requests/users", power.token, { method: "GET" }), undefined));
  assert.equal(res.status, 200);
});

test("requests/users excludes deactivated accounts from the picker", async () => {
  const power = await mintSession({ permissions: Permission.REQUEST_ON_BEHALF });
  const gone = await mintSession();
  usersById.get(gone.userId)!.deactivatedAt = new Date();
  const res = await inScope(() => requestsUsers.GET(mk("/api/requests/users", power.token, { method: "GET" }), undefined));
  const body = await res.json();
  assert.ok(!body.users.some((u: { id: string }) => u.id === gone.userId), "a disabled account must not be pickable");
  assert.ok(body.users.some((u: { id: string }) => u.id === power.userId));
});

test("requests/users leaks only id, name and email — no role, permissions or password fields", async () => {
  const power = await mintSession({ permissions: Permission.REQUEST_ON_BEHALF });
  const res = await inScope(() => requestsUsers.GET(mk("/api/requests/users", power.token, { method: "GET" }), undefined));
  const body = await res.json();
  for (const u of body.users) {
    assert.deepEqual(Object.keys(u).sort(), ["email", "id", "name"]);
  }
  const select = (opsOf("user.findMany")[0].args as { select: Record<string, boolean> }).select;
  assert.deepEqual(Object.keys(select).sort(), ["email", "id", "name"]);
});

test("requests/users bounds its page size", async () => {
  const power = await mintSession({ permissions: Permission.REQUEST_ON_BEHALF });
  await inScope(() => requestsUsers.GET(mk("/api/requests/users", power.token, { method: "GET" }), undefined));
  const take = (opsOf("user.findMany")[0].args as { take: number }).take;
  assert.equal(take, 1000);
});

// ── 4: /api/health ───────────────────────────────────────────────────────────

test("health reports ok with a reachable DB", async () => {
  const res = await inScope(() => health.GET());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: "up" });
});

test("health returns 503 when the DB ping fails — the container must be marked unhealthy", async () => {
  // A live Node process fronting a dead Postgres is NOT healthy; a bare
  // liveness {ok:true} hid exactly this.
  dbUp = false;
  const res = await inScope(() => health.GET());
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, db: "down" });
});

test("health actually pings the database rather than answering from memory", async () => {
  await inScope(() => health.GET());
  assert.equal(opsOf("$queryRaw").length, 1);
});

test("health is force-dynamic so a cached 200 can't outlive a DB outage", () => {
  assert.equal(health.dynamic, "force-dynamic");
});

test("health leaks no error detail to an unauthenticated caller", async () => {
  dbUp = false;
  const res = await inScope(() => health.GET());
  const text = await res.text();
  assert.ok(!text.includes("connection refused"), "the underlying DB error must not reach the probe body");
});

test("health logs the failure for the operator with a scoped prefix (guardrail 7)", async () => {
  dbUp = false;
  await inScope(() => health.GET());
  assert.ok(errors.some((e) => e.includes("[health]")), `no scoped error log: ${errors.join(" | ")}`);
});
