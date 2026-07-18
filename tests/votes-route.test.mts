// Route-level unit tests for the deletion-vote API:
//   POST /api/votes            (src/app/api/votes/route.ts)
//   GET  /api/votes            (same file — the grouped vote list)
//   DELETE/PATCH /api/votes/[tmdbId]  (src/app/api/votes/[tmdbId]/route.ts)
//
// The headline contract is CLAUDE.md guardrail 23, which this exact route once
// violated: a one-shot "notify admins at threshold" gate did a caught
// tx.setting.create of a unique key AFTER the vote insert, inside a single-level
// interactive $transaction. Once the key existed, every later vote hit the
// unique violation, aborted the tx (no per-statement SAVEPOINT at depth 1), and
// the vote was silently ROLLED BACK behind a 201. The fix moved the gate OUT of
// any transaction as an idempotent createMany({skipDuplicates:true}) one-shot.
// What this file pins about that fix:
//   - the vote insert is a single standalone create — prisma.$transaction is
//     NEVER invoked on the POST path (there is no tx for a caught error to
//     abort);
//   - the threshold gate runs strictly AFTER the vote create, and its outcome
//     cannot un-commit the vote: when createMany reports count 0 (another
//     caller already owns the claim key) the response is STILL 201 and the
//     created vote row is still returned;
//   - only the single claim winner (count === 1, recount still >= threshold)
//     enqueues the admin notify fan-out via after(); losers, below-threshold
//     votes, and the dismiss-race recount all enqueue nothing;
//   - a duplicate vote's P2002 propagates out of the bare create and is mapped
//     to 409 "Already voted" (never a 500, never a phantom 201);
//   - DELETE re-arms the one-shot gate INSIDE its transaction when the tally
//     drops below the threshold, and leaves the claim key alone when it stays
//     at/above (or no threshold is configured).
// Around that core: auth (401 before any business read), the feature-flag and
// maintenance gates, the per-user rate limit, guardrail-30 body caps, field
// validation, the request-token gate, TMDB verification failure, the
// in-a-library requirement, the own-request bar, the admin dismiss (PATCH), and
// the GET list shape (voteCount / userVoted / deduped-and-capped reasons).
//
// Harness: the handlers are withAuth/withAdmin-wrapped (guardrail 6a), so they
// are invoked as real route functions with a NextRequest carrying a REAL signed
// session JWT, backed by in-memory authSession/user stubs (the
// tests/api-auth.test.mts fixture). maintenanceGuard reads cookies() from
// next/headers and the winner path calls after() from next/server — both throw
// outside a Next request scope — so every invocation runs inside a synthetic
// workAsyncStorage + workUnitAsyncStorage scope (the tests/maintenance.test.mts
// idiom) whose work store also carries an afterContext that RECORDS enqueued
// after() tasks instead of running them. No DB or network: all touched prisma
// delegates are shadowed in-memory (tests/_helpers.mts), $transaction is a
// recording stub (the tests/discord-merge.test.mts idiom), dns.lookup is
// stubbed, and globalThis.fetch is scripted per URL (TMDB verification only).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "votes-route-test-secret-0123456789abcdef"; // session JWT + request token HMAC
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token"; // verifyTmdbMedia goes to the (scripted) wire
// Keep next/headers off its dev-warnings wrappers (they expect richer store
// shapes). Cast: next/types marks NODE_ENV readonly at the type level.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── DNS stub (the tests/tmdb.test.mts pattern) ──────────────────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch — TMDB verification is the only sanctioned wire call ─────
const fetchCalls: URL[] = [];
let respond: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return respond(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The storage singletons + request-store building blocks (createRequire so we
// get the exact CJS instances next/headers.js and next/server.js read).
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

// Dynamic imports so the env/global stubs above genuinely precede the
// module-graph load (static imports would hoist above them).
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { Prisma } = await import("@/generated/prisma");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { generateRequestToken } = await import("../src/lib/request-token.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── recording op log (business models only — wrapper auth reads not logged) ─
type Op = { op: string; args?: unknown; inTx: boolean };
const ops: Op[] = [];
let txDepth = 0;
let txCalls = 0;
const rec = (op: string, args?: unknown) => { ops.push({ op, args, inTx: txDepth > 0 }); };
const opNames = () => ops.map((o) => o.op);
function opsOf(name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

// ── in-memory auth fixture (the api-auth.test.mts idiom) ────────────────────
type DbUser = {
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
  update: async () => ({}), // lastSeenAt fire-and-forget touch
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: string } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `voter-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `voter-${seq}@example.com`,
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions,
      provider: "credentials",
      sessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}

const COOKIE = getSessionCookieName();

// ── business-model stubs ────────────────────────────────────────────────────
const settings = new Map<string, string>();
let claimCount = 1; // setting.createMany({skipDuplicates}) result — 1 ⇒ this caller won the one-shot claim
const settingModel = {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    rec("setting.findMany", args);
    return args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) }));
  },
  createMany: async (args: { data: { key: string; value: string }[]; skipDuplicates?: boolean }) => {
    rec("setting.createMany", args);
    return { count: claimCount };
  },
  deleteMany: async (args: { where: { key: string } }) => {
    rec("setting.deleteMany", args);
    return { count: 1 };
  },
};
shadowPrismaModel(prisma, "setting", settingModel);

let voteSeq = 0;
let voteCreateImpl: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>> = async (args) => ({
  id: `vote-${++voteSeq}`,
  createdAt: new Date(),
  ...args.data,
});
let voteCounts: number[] = []; // shifted per deletionVote.count call; empty ⇒ 0
let voteDeleteCount = 1; // deletionVote.deleteMany result (the caller's own vote rows removed)
let groupRows: Array<{ tmdbId: number; mediaType: string; _count: { id: number }; _max: { createdAt: Date } }> = [];
let repRows: Array<{ tmdbId: number; mediaType: string; title: string; posterPath: string | null }> = [];
let userVoteRows: Array<{ tmdbId: number; mediaType: string; id: string; reason: string | null }> = [];
let otherReasonRows: Array<{ tmdbId: number; mediaType: string; reason: string | null }> = [];
const deletionVoteModel = {
  create: async (args: { data: Record<string, unknown> }) => {
    rec("deletionVote.create", args);
    return voteCreateImpl(args);
  },
  count: async (args: unknown) => {
    rec("deletionVote.count", args);
    return voteCounts.shift() ?? 0;
  },
  deleteMany: async (args: unknown) => {
    rec("deletionVote.deleteMany", args);
    return { count: voteDeleteCount };
  },
  groupBy: async (args: { skip?: number }) => {
    rec("deletionVote.groupBy", args);
    // The paged list call carries skip/take; the total call does not.
    return args.skip !== undefined
      ? groupRows
      : groupRows.map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType, _count: g._count }));
  },
  findMany: async (args: { distinct?: string[]; where?: { userId?: unknown } }) => {
    rec("deletionVote.findMany", args);
    if (args.distinct) return repRows; // representative title/poster rows
    if (typeof args.where?.userId === "string") return userVoteRows; // the caller's own votes
    return otherReasonRows; // other users' recent reasons (userId: { not })
  },
};
shadowPrismaModel(prisma, "deletionVote", deletionVoteModel);

let plexHas = true;
let jellyfinHas = false;
shadowPrismaModel(prisma, "plexLibraryItem", {
  findUnique: async (args: unknown) => {
    rec("plexLibraryItem.findUnique", args);
    return plexHas ? { tmdbId: 603, mediaType: "MOVIE" } : null;
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findUnique: async (args: unknown) => {
    rec("jellyfinLibraryItem.findUnique", args);
    return jellyfinHas ? { tmdbId: 603, mediaType: "MOVIE" } : null;
  },
});

let ownRequestRow: { id: string } | null = null;
shadowPrismaModel(prisma, "mediaRequest", {
  findFirst: async (args: unknown) => {
    rec("mediaRequest.findFirst", args);
    return ownRequestRow;
  },
});

shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => {
    rec("auditLog.create", args);
    return {};
  },
});

// The winner path's notify fan-out reads push subscriptions; keep it empty so
// the channel short-circuits before any network (channel internals are owned by
// tests/push.test.mts / tests/email.test.mts / tests/discord-notify.test.mts).
shadowPrismaModel(prisma, "pushSubscription", {
  findMany: async () => [],
});

// $transaction recording stub: callback form tags ops inTx; array form awaits
// the already-issued stub promises (the PATCH dismiss shape).
const txObj = { deletionVote: deletionVoteModel, setting: settingModel };
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  txCalls++;
  if (Array.isArray(arg)) return Promise.all(arg);
  txDepth++;
  try {
    return await (arg as (tx: typeof txObj) => Promise<unknown>)(txObj);
  } finally {
    txDepth--;
  }
});

// Routes under test (imported AFTER every stub is in place).
const { GET: listVotes, POST: postVote } = await import("../src/app/api/votes/route.ts");
const { DELETE: deleteVote, PATCH: dismissVotes } = await import("../src/app/api/votes/[tmdbId]/route.ts");

// ── synthetic request scope with a recording afterContext ───────────────────
// maintenanceGuard reaches cookies()/headers() (next/headers) and the winner
// path calls after() (next/server) — both need a live store. The request store
// carries NO session cookie, so authActive() resolves anonymous and the admin
// maintenance bypass never fires; the enqueued after() tasks are captured, not
// run (tests run them explicitly where reach matters).
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/votes-route.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: {
      after: (task: unknown) => {
        afterTasks.push(typeof task === "function" ? (task as () => Promise<unknown>) : async () => task);
      },
    },
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

// ── invocation helpers ──────────────────────────────────────────────────────
function votesReq(token: string | null, init: { method: string; body?: string; query?: string }): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000/api/votes${init.query ?? ""}`, {
    method: init.method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

async function post(token: string | null, body: unknown, rawBody?: string): Promise<Response> {
  const req = votesReq(token, { method: "POST", body: rawBody ?? JSON.stringify(body) });
  return inScope(() => postVote(req, undefined));
}

async function del(token: string, rawId: string, mediaType?: string): Promise<Response> {
  const req = new NextRequest(
    `http://localhost:3000/api/votes/${rawId}${mediaType ? `?mediaType=${mediaType}` : ""}`,
    { method: "DELETE", headers: { cookie: `${COOKIE}=${token}` } },
  );
  return inScope(() => deleteVote(req, { params: Promise.resolve({ tmdbId: rawId }) }));
}

async function dismiss(token: string, rawId: string, mediaType?: string): Promise<Response> {
  const req = new NextRequest(
    `http://localhost:3000/api/votes/${rawId}${mediaType ? `?mediaType=${mediaType}` : ""}`,
    { method: "PATCH", headers: { cookie: `${COOKIE}=${token}` } },
  );
  return inScope(() => dismissVotes(req, { params: Promise.resolve({ tmdbId: rawId }) }));
}

// A well-formed vote body with a genuine HMAC request token for this user.
function voteBody(userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const tmdbId = (over.tmdbId as number) ?? 603;
  const mediaType = (over.mediaType as string) ?? "MOVIE";
  return { tmdbId, mediaType, _token: generateRequestToken(tmdbId, mediaType, userId), ...over };
}

function prismaKnownError(code: string): InstanceType<typeof Prisma.PrismaClientKnownRequestError> {
  return new Prisma.PrismaClientKnownRequestError(`stubbed prisma error ${code}`, {
    code,
    clientVersion: "0.0.0-test",
  });
}

const MOVIE_603 = { title: "The Matrix", poster_path: "/matrix.jpg", release_date: "1999-03-31" };

beforeEach(() => {
  ops.length = 0;
  txCalls = 0;
  txDepth = 0;
  afterTasks.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  claimCount = 1;
  voteCreateImpl = async (args) => ({ id: `vote-${++voteSeq}`, createdAt: new Date(), ...args.data });
  voteCounts = [];
  voteDeleteCount = 1;
  groupRows = [];
  repRows = [];
  userVoteRows = [];
  otherReasonRows = [];
  plexHas = true;
  jellyfinHas = false;
  ownRequestRow = null;
  invalidateFeatureFlagCache(); // the 10s flag memo would otherwise leak a prior test's toggle
  respond = (url) => {
    if (url.pathname === "/3/movie/603") return jsonResponse(MOVIE_603);
    throw new Error(`unexpected fetch to ${url.href} — script a responder`);
  };
});

// ── auth and pre-body gates ─────────────────────────────────────────────────

test("POST without a session → 401 Unauthorized; no business read or write ever runs", async () => {
  const res = await post(null, { tmdbId: 603, mediaType: "MOVIE" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.equal(ops.length, 0, "the handler body must never run unauthenticated (guardrail 6a)");
  assert.equal(afterTasks.length, 0);
});

test("feature.page.votes=false disables BOTH the vote POST and the un-vote DELETE with 403", async () => {
  settings.set("feature.page.votes", "false");
  const { userId, token } = await mintSession();

  const posted = await post(token, voteBody(userId));
  assert.equal(posted.status, 403);
  assert.deepEqual(await posted.json(), { error: "Deletion voting is disabled" });

  const removed = await del(token, "603", "MOVIE");
  assert.equal(removed.status, 403);
  assert.deepEqual(await removed.json(), { error: "Deletion voting is disabled" });
  assert.equal(opsOf("deletionVote.create").length, 0);
  assert.equal(opsOf("deletionVote.deleteMany").length, 0);
});

test("maintenance mode 503s a non-admin vote before any vote work", async () => {
  settings.set("maintenanceEnabled", "true");
  const { userId, token } = await mintSession();
  const res = await post(token, voteBody(userId));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Service unavailable", message: "Under maintenance" });
  assert.equal(opsOf("deletionVote.create").length, 0);
});

test("the per-user vote rate limit honors the rateLimitRequests Setting and 429s with Retry-After", async () => {
  settings.set("rateLimitRequests", "1");
  const { token } = await mintSession();
  // Every POST entry consumes the bucket — even one that later fails validation.
  const first = await post(token, {});
  assert.equal(first.status, 400, "the first call passes the limiter and fails validation instead");
  const second = await post(token, {});
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "60");
  assert.deepEqual(await second.json(), { error: "Too many requests — try again later" });
});

// ── body handling (guardrail 30) and field validation ───────────────────────

test("body caps: oversized → 413, malformed → 400, empty → 400 (readJsonCapped, 16 KB)", async () => {
  const { token } = await mintSession();

  const oversized = await post(token, null, JSON.stringify({ pad: "x".repeat(17_000) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "Request body too large (max 16KB)" });

  const malformed = await post(token, null, "{not json");
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request body" });

  const empty = await inScope(() => postVote(votesReq(token, { method: "POST" }), undefined));
  assert.equal(empty.status, 400);
  assert.equal(opsOf("deletionVote.create").length, 0);
});

test("field validation 400s: missing ids, non-integer tmdbId, junk mediaType, over-long reason", async () => {
  const { userId, token } = await mintSession();

  const missing = await post(token, {});
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "tmdbId and mediaType are required" });

  const negative = await post(token, { ...voteBody(userId), tmdbId: -5 });
  assert.deepEqual(await negative.json(), { error: "tmdbId must be a positive integer" });
  const fractional = await post(token, { ...voteBody(userId), tmdbId: 1.5 });
  assert.equal(fractional.status, 400);

  const lowercase = await post(token, { tmdbId: 603, mediaType: "movie", _token: "x" });
  assert.deepEqual(await lowercase.json(), { error: "mediaType must be MOVIE or TV" });

  const longReason = await post(token, voteBody(userId, { reason: "r".repeat(201) }));
  assert.deepEqual(await longReason.json(), { error: "reason must be a string under 200 characters" });
  assert.equal(opsOf("deletionVote.create").length, 0);
});

test("the request token is required and scoped to the caller: garbage and another user's token both 403", async () => {
  const { token } = await mintSession();
  const garbage = await post(token, { tmdbId: 603, mediaType: "MOVIE", _token: "deadbeef" });
  assert.equal(garbage.status, 403);
  assert.deepEqual(await garbage.json(), { error: "Invalid or expired request token" });

  // A perfectly valid token minted for a DIFFERENT user must not transfer.
  const stolen = await post(token, {
    tmdbId: 603,
    mediaType: "MOVIE",
    _token: generateRequestToken(603, "MOVIE", "someone-else"),
  });
  assert.equal(stolen.status, 403);
  assert.equal(opsOf("deletionVote.create").length, 0);
});

// ── upstream/library preconditions ──────────────────────────────────────────

test("a TMDB-unverifiable title → 422 before any vote write (wire 404 → null)", async () => {
  respond = () => jsonResponse({ status_code: 34 }, 404);
  const { userId, token } = await mintSession();
  const res = await post(token, voteBody(userId));
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "Could not verify media with TMDB" });
  assert.equal(fetchCalls.length, 1, "exactly one TMDB verification fetch");
  assert.equal(opsOf("deletionVote.create").length, 0);
});

test("the title must be in SOME library: neither → 422; a Jellyfin-only hit suffices", async () => {
  plexHas = false;
  jellyfinHas = false;
  const a = await mintSession();
  const nowhere = await post(a.token, voteBody(a.userId));
  assert.equal(nowhere.status, 422);
  assert.deepEqual(await nowhere.json(), { error: "Media is not in any library" });
  assert.equal(opsOf("deletionVote.create").length, 0);

  // A Jellyfin-only install (zero Plex rows) must still allow the vote.
  jellyfinHas = true;
  const b = await mintSession();
  const jellyfinOnly = await post(b.token, voteBody(b.userId));
  assert.equal(jellyfinOnly.status, 201);
});

test("a user who ever requested the title cannot vote to delete it (403)", async () => {
  ownRequestRow = { id: "req-1" };
  const { userId, token } = await mintSession();
  const res = await post(token, voteBody(userId));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Cannot vote to delete your own request" });
  assert.equal(opsOf("deletionVote.create").length, 0);
});

// ── the vote insert itself + guardrail 23 ───────────────────────────────────

test("a valid vote commits as ONE bare create — no $transaction anywhere on the POST path — and 201s the row", async () => {
  const { userId, token } = await mintSession();
  const res = await post(token, voteBody(userId, { reason: "Low quality rip" }));
  assert.equal(res.status, 201);

  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.tmdbId, 603);
  assert.equal(body.mediaType, "MOVIE");
  assert.equal(body.title, "The Matrix");
  assert.equal(body.posterPath, "/matrix.jpg");
  assert.equal(body.userId, userId);
  assert.equal(body.reason, "Low quality rip");
  assert.ok(typeof body.id === "string" && (body.id as string).startsWith("vote-"));

  const creates = opsOf("deletionVote.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].inTx, false, "the vote insert must NOT run inside a transaction");
  assert.equal(txCalls, 0, "guardrail 23: no interactive tx exists for a caught gate error to abort");
  assert.deepEqual((creates[0].args as { data: unknown }).data, {
    tmdbId: 603,
    mediaType: "MOVIE",
    title: "The Matrix",
    posterPath: "/matrix.jpg",
    userId,
    reason: "Low quality rip",
  });

  // No deletionVoteThreshold Setting configured ⇒ the gate never counts or claims.
  assert.equal(opsOf("deletionVote.count").length, 0);
  assert.equal(opsOf("setting.createMany").length, 0);
  assert.equal(afterTasks.length, 0);
});

test("a duplicate vote's P2002 propagates from the bare create and maps to 409 'Already voted'", async () => {
  voteCreateImpl = async () => { throw prismaKnownError("P2002"); };
  const { userId, token } = await mintSession();
  const res = await post(token, voteBody(userId));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "Already voted" });
  // The failed insert must not evaluate the threshold gate or enqueue notifies.
  assert.equal(opsOf("deletionVote.count").length, 0);
  assert.equal(opsOf("setting.createMany").length, 0);
  assert.equal(afterTasks.length, 0);
});

test("threshold WINNER: the gate runs strictly AFTER the create, claims via createMany(skipDuplicates), recounts, and enqueues exactly one notify task that completes offline", async () => {
  settings.set("deletionVoteThreshold", "5");
  voteCounts = [5, 5]; // count at threshold, recount confirms
  claimCount = 1; // this caller wins the one-shot claim
  const { userId, token } = await mintSession();

  const res = await post(token, voteBody(userId));
  assert.equal(res.status, 201);

  // Structural pin (guardrail 23): everything gate-shaped happens after the
  // committed insert, outside any transaction.
  const fromCreate = opNames().slice(opNames().indexOf("deletionVote.create"));
  assert.deepEqual(fromCreate, [
    "deletionVote.create",
    "setting.findUnique", // deletionVoteThreshold read
    "deletionVote.count",
    "setting.createMany", // the idempotent one-shot claim
    "deletionVote.count", // the dismiss-race recount, only after winning
  ]);
  assert.ok(ops.every((o) => !o.inTx), "no op on the POST path may run inside a tx");

  const claim = opsOf("setting.createMany")[0].args as {
    data: { key: string; value: string }[];
    skipDuplicates?: boolean;
  };
  assert.deepEqual(claim.data, [{ key: "deletionVoteNotified:603:MOVIE", value: "1" }]);
  assert.equal(claim.skipDuplicates, true, "the claim must be skipDuplicates — a bare create would throw");

  // Exactly one notify fan-out enqueued via after(); running it must
  // short-circuit every channel (nothing configured) without touching the wire.
  assert.equal(afterTasks.length, 1);
  const wireBefore = fetchCalls.length;
  await afterTasks[0]();
  assert.equal(fetchCalls.length, wireBefore, "unconfigured notify channels must never reach the network");
  assert.deepEqual(errors, [], "the notify fan-out must complete without channel errors");
});

test("threshold LOSER (claim count 0 — another caller won): the vote STILL commits behind 201 and nothing is notified — the exact silent-rollback bug guardrail 23 documents", async () => {
  settings.set("deletionVoteThreshold", "5");
  voteCounts = [5];
  claimCount = 0; // the claim key already exists — the historic P2002-in-tx trigger
  const { userId, token } = await mintSession();

  const res = await post(token, voteBody(userId));
  assert.equal(res.status, 201, "losing the notify claim must never fail the vote");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.userId, userId, "the committed vote row is still returned");

  assert.equal(opsOf("deletionVote.create").length, 1, "the vote insert happened and nothing rolled it back");
  assert.equal(txCalls, 0, "no tx exists whose abort could discard the vote");
  assert.equal(opsOf("deletionVote.count").length, 1, "losers must not recount");
  assert.equal(afterTasks.length, 0, "only the single claim winner notifies");
});

test("the gate stays quiet below the threshold, and the winner's recount suppresses a dismiss-raced alert", async () => {
  // Below threshold: no claim is even attempted.
  settings.set("deletionVoteThreshold", "5");
  voteCounts = [3];
  const a = await mintSession();
  const below = await post(a.token, voteBody(a.userId));
  assert.equal(below.status, 201);
  assert.equal(opsOf("setting.createMany").length, 0);
  assert.equal(afterTasks.length, 0);

  // Winner whose RECOUNT dropped below threshold (an admin dismiss raced the
  // claim): claim key created, but no alert for a title whose votes were wiped.
  ops.length = 0;
  voteCounts = [5, 4];
  claimCount = 1;
  const b = await mintSession();
  const raced = await post(b.token, voteBody(b.userId));
  assert.equal(raced.status, 201);
  assert.equal(opsOf("setting.createMany").length, 1, "the claim itself was won");
  assert.equal(opsOf("deletionVote.count").length, 2, "the recount ran");
  assert.equal(afterTasks.length, 0, "a recount below threshold must not alert");
});

// ── DELETE /api/votes/[tmdbId] (un-vote) ────────────────────────────────────

test("DELETE validates its params: non-numeric tmdbId → 400, missing/junk mediaType → 400, no vote → 404", async () => {
  const { token } = await mintSession();

  const badId = await del(token, "abc", "MOVIE");
  assert.equal(badId.status, 400);
  assert.deepEqual(await badId.json(), { error: "Invalid tmdbId" });

  const noType = await del(token, "603");
  assert.equal(noType.status, 400);
  assert.deepEqual(await noType.json(), { error: "mediaType query param must be MOVIE or TV" });
  assert.equal(opsOf("deletionVote.deleteMany").length, 0, "param validation precedes the tx");

  voteDeleteCount = 0;
  const missing = await del(token, "603", "MOVIE");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Vote not found" });
});

test("DELETE re-arms the one-shot notify gate INSIDE its tx when the tally drops below threshold", async () => {
  settings.set("deletionVoteThreshold", "2");
  voteDeleteCount = 1;
  voteCounts = [1]; // remaining after removal < threshold
  const { userId, token } = await mintSession();

  const res = await del(token, "603", "MOVIE");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const removed = opsOf("deletionVote.deleteMany")[0];
  assert.equal(removed.inTx, true);
  assert.deepEqual((removed.args as { where: unknown }).where, {
    tmdbId: 603,
    mediaType: "MOVIE",
    userId,
  });
  const rearm = opsOf("setting.deleteMany");
  assert.equal(rearm.length, 1, "the claim key must be cleared so a future re-crossing can alert again");
  assert.equal(rearm[0].inTx, true, "the re-arm must be atomic with the vote removal");
  assert.deepEqual((rearm[0].args as { where: unknown }).where, {
    key: "deletionVoteNotified:603:MOVIE",
  });
});

test("DELETE leaves the claim key alone when the tally stays at/above threshold, and skips the recount entirely with no threshold configured", async () => {
  settings.set("deletionVoteThreshold", "2");
  voteCounts = [2]; // still at threshold after removal
  const a = await mintSession();
  const still = await del(a.token, "603", "MOVIE");
  assert.equal(still.status, 200);
  assert.equal(opsOf("setting.deleteMany").length, 0, "an armed gate above threshold must stay armed");

  ops.length = 0;
  settings.delete("deletionVoteThreshold");
  const b = await mintSession();
  const noThreshold = await del(b.token, "603", "MOVIE");
  assert.equal(noThreshold.status, 200);
  assert.equal(opsOf("deletionVote.count").length, 0, "no threshold ⇒ no remaining-tally count");
  assert.equal(opsOf("setting.deleteMany").length, 0);
});

// ── PATCH /api/votes/[tmdbId] (admin dismiss-all) ───────────────────────────

test("PATCH is admin-only (USER → 403) and dismisses votes + claim key together, reporting the count and auditing", async () => {
  const user = await mintSession({ role: "USER" });
  const denied = await dismiss(user.token, "603", "MOVIE");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Forbidden" });
  assert.equal(opsOf("deletionVote.deleteMany").length, 0);

  voteDeleteCount = 4;
  const admin = await mintSession({ role: "ADMIN" });
  const res = await dismiss(admin.token, "603", "MOVIE");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, dismissed: 4 });
  assert.equal(txCalls >= 1, true, "the dismiss pairs both deletes in one $transaction");
  assert.deepEqual((opsOf("deletionVote.deleteMany")[0].args as { where: unknown }).where, {
    tmdbId: 603,
    mediaType: "MOVIE",
  });
  assert.deepEqual((opsOf("setting.deleteMany")[0].args as { where: unknown }).where, {
    key: "deletionVoteNotified:603:MOVIE",
  });
  // logAudit is fire-and-forget (guardrail 26's swallowing variant) — give the
  // microtask a beat, then confirm the audit row was written.
  await new Promise((resolve) => setImmediate(resolve));
  const audit = opsOf("auditLog.create");
  assert.equal(audit.length, 1);
  assert.equal((audit[0].args as { data: { action: string } }).data.action, "VOTE_DISMISS_ALL");
});

// ── GET /api/votes (grouped list) ───────────────────────────────────────────

test("GET groups votes with voteCount, the caller's own vote/reason, and others' reasons deduped and capped at 3", async () => {
  const now = new Date();
  groupRows = [
    { tmdbId: 603, mediaType: "MOVIE", _count: { id: 4 }, _max: { createdAt: now } },
    { tmdbId: 1399, mediaType: "TV", _count: { id: 2 }, _max: { createdAt: now } },
  ];
  repRows = [
    { tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", posterPath: "/matrix.jpg" },
    { tmdbId: 1399, mediaType: "TV", title: "Game of Thrones", posterPath: null },
  ];
  userVoteRows = [{ tmdbId: 603, mediaType: "MOVIE", id: "vote-9", reason: "my own reason" }];
  otherReasonRows = [
    { tmdbId: 603, mediaType: "MOVIE", reason: "bad encode" },
    { tmdbId: 603, mediaType: "MOVIE", reason: "bad encode" }, // duplicate → deduped
    { tmdbId: 603, mediaType: "MOVIE", reason: "   " }, // whitespace-only → dropped
    { tmdbId: 603, mediaType: "MOVIE", reason: "wrong cut" },
    { tmdbId: 603, mediaType: "MOVIE", reason: "nobody watches it" },
    { tmdbId: 603, mediaType: "MOVIE", reason: "a fourth reason past the cap" },
  ];

  const { token } = await mintSession();
  const res = await inScope(() =>
    listVotes(votesReq(token, { method: "GET" }), undefined),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
  };
  assert.equal(body.total, 2);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 40);
  assert.deepEqual(body.items[0], {
    tmdbId: 603,
    mediaType: "MOVIE",
    title: "The Matrix",
    posterPath: "/matrix.jpg",
    voteCount: 4,
    userVoted: true,
    userReason: "my own reason",
    reasons: ["bad encode", "wrong cut", "nobody watches it"],
  });
  assert.deepEqual(body.items[1], {
    tmdbId: 1399,
    mediaType: "TV",
    title: "Game of Thrones",
    posterPath: null,
    voteCount: 2,
    userVoted: false,
    userReason: null,
    reasons: [],
  });
});

test("GET scopes ?mine=1 to the caller, filters ?q= by title, and falls back to the votes sort on junk", async () => {
  const { userId, token } = await mintSession();
  const res = await inScope(() =>
    listVotes(votesReq(token, { method: "GET", query: "?mine=1&q=matrix&sort=bogus" }), undefined),
  );
  assert.equal(res.status, 200);
  const paged = opsOf("deletionVote.groupBy")[0].args as {
    where: { userId?: string; title?: { contains: string; mode: string } };
    orderBy: unknown;
  };
  assert.equal(paged.where.userId, userId, "mine=1 must scope the group query to the caller");
  assert.deepEqual(paged.where.title, { contains: "matrix", mode: "insensitive" });
  assert.deepEqual(paged.orderBy, { _count: { id: "desc" } }, "an unknown sort falls back to 'votes'");
  const body = (await res.json()) as { items: unknown[]; total: number };
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 0);
});
