// Route-level unit tests for the issue-report API:
//   POST /api/issues                 — file an issue (the reporter chokepoint)
//   GET  /api/issues                 — the reporter-scoped vs. MANAGE_ISSUES list
//   PATCH /api/issues/[id]           — status transitions (withIssueAdmin)
//   POST  /api/issues/[id]/messages  — thread replies (withAuth + ownership)
//   POST  /api/issues/[id]/releases  — the "Replace" grab (withIssueAdmin, IssueGrab)
//
// What THIS file pins (contracts none of the leaf tests reach):
//   - guardrail 6a: the wrappers gate every handler. POST/GET /api/issues and
//     the messages POST are withAuth (any authenticated user); a missing session
//     is 401 before the body runs. PATCH + releases are withIssueAdmin — a plain
//     USER (no MANAGE_ISSUES bit) is 403, an ISSUE_ADMIN/ADMIN passes. The
//     messages POST is withAuth but self-enforces ownership (non-reporter, non
//     admin ⇒ 403). Wrapper mechanics themselves are owned by tests/
//     api-auth.test.mts; here they're invoked as real route functions.
//   - guardrail 30: the create body cap (65 536) 413s an oversized body and the
//     readJsonCapped 400s malformed JSON, ahead of any DB write. body-size.ts's
//     own limits are owned by tests/body-size.test.mts.
//   - guardrail 26: the routes audit with the SWALLOWING logAudit AFTER their
//     mutation has committed — a thrown audit write must NOT turn a successful
//     transition into a 500. Pinned by making auditLog.create throw and asserting
//     the PATCH still returns the updated issue.
//   - guardrail 32: the releases grab is instance-slug-scoped — an invalid slug
//     is 400, a valid-but-unconfigured named instance is 422, and the resolved
//     slug lands in IssueGrab.arrInstance. (Request-time instance routing is
//     owned by tests/requests-route.test.mts.)
//   - the created Issue row shape: tmdbId/title/posterPath come from the TMDB
//     verify, tvdbId is resolved SERVER-SIDE (never client-supplied) and is null
//     when Sonarr is unconfigured, and the admin new-issue notify fan-out is
//     enqueued via after() and reached but short-circuits offline (channel
//     internals are owned by tests/push.test.mts / email / discord-notify).
//   - the "notify the other party" inbox write: an admin reply / a resolve
//     writes an in-app Notification row for the reporter, and a self-action
//     (issue-admin acting on their OWN reported issue) suppresses it.
//
// Harness mirrors tests/requests-route.test.mts: withAuth/withIssueAdmin handlers
// invoked as real route functions over in-memory prisma stubs + a REAL signed
// session JWT; maintenanceGuard's cookies() and the notify after() run inside a
// synthetic work/request async-storage scope whose work store records after()
// tasks; dns.lookup is stubbed and globalThis.fetch is a recording thrower — the
// only wire the happy paths permit is the scripted TMDB verify (and one scripted
// Radarr grab), and every test asserts its wire budget.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "issues-routes-test-secret-0123456789abcdef"; // session JWT HMAC
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token"; // tmdb.ts reads it at call time
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── DNS stub (tests/requests-route.test.mts pattern) — safe-fetch resolves the
// TMDB/ARR host before fetching; no real lookup may leave the process.
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

// ── recording fetch: every wire attempt is logged; only a scripted impl succeeds ─
const fetchCalls: URL[] = [];
let fetchImpl: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — this test's flow must be satisfied from stubs/caches");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return fetchImpl(url);
}) as typeof fetch;

// A JSON Response the scripted fetch impls return.
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// TMDB verify (verifyTmdbMedia) hits /3/movie/{id} or /3/tv/{id}. This impl
// answers both with a well-formed payload so the create path proceeds.
function tmdbVerifyFetch(url: URL): Response {
  if (url.hostname !== "api.themoviedb.org") {
    throw new Error(`unexpected non-TMDB fetch: ${url.href}`);
  }
  if (url.pathname.includes("/movie/")) {
    return jsonResponse({ id: 603, title: "The Matrix", poster_path: "/matrix.jpg", release_date: "1999-03-31" });
  }
  if (url.pathname.includes("/tv/")) {
    return jsonResponse({ id: 1396, name: "Breaking Bad", poster_path: "/bb.jpg", first_air_date: "2008-01-20" });
  }
  throw new Error(`unexpected TMDB path: ${url.pathname}`);
}

type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

// Dynamic imports so the env/global stubs above genuinely precede the module
// graph load (static imports would hoist above them).
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");

// ── recorded SSE events ─────────────────────────────────────────────────────
const sseEvents: Array<Record<string, unknown>> = [];
sseEmitter.on("event", (e: Record<string, unknown>) => { sseEvents.push(e); });

// ── recording op log ─────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
function opsOf(name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

// ── auth fixture (the api-auth.test.mts DB shape) ────────────────────────────
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
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  // The notify fan-out (admin recipients) short-circuits before this, but stub it
  // so an unexpected read returns empty rather than hitting a real delegate.
  findMany: async () => [],
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: string } = {}): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `reporter-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0"; // unseeded ⇒ role preset
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `reporter-${seq}@example.com`,
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
  return { userId, sessionId, token };
}

const COOKIE = getSessionCookieName();

// ── Setting stub (features, maintenance, rate limit, notify, arr config) ─────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) })),
});

// ── issue stub — findUnique returns a SNAPSHOT copy so the route's captured
// `issue` doesn't mutate under it; updateMany mutates the base row on count>0. ─
let issueSeq = 0;
let issueRow: Record<string, unknown> | null = null; // the row findUnique returns
let issueListRows: Array<Record<string, unknown>> = [];
let issueUpdateManyCount = 1; // scriptable CAS result
const issueModel = {
  create: async (args: { data: Record<string, unknown> }) => {
    rec("issue.create", args);
    return {
      id: `issue-${++issueSeq}`,
      status: "OPEN",
      resolution: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: new Date(),
      ...args.data,
    };
  },
  findUnique: async (args: { where: { id: string } }) => {
    rec("issue.findUnique", args);
    return issueRow ? { ...issueRow } : null;
  },
  findMany: async (args: unknown) => {
    rec("issue.findMany", args);
    return issueListRows;
  },
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    rec("issue.updateMany", args);
    const count = issueUpdateManyCount;
    if (count > 0 && issueRow) Object.assign(issueRow, args.data);
    return { count };
  },
};
shadowPrismaModel(prisma, "issue", issueModel);

shadowPrismaModel(prisma, "issueMessage", {
  create: async (args: { data: Record<string, unknown> }) => {
    rec("issueMessage.create", args);
    return { id: `msg-${Date.now()}`, createdAt: new Date(), author: { name: "n", role: "USER" }, ...args.data };
  },
  findMany: async () => [],
});

shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Record<string, unknown> }) => {
    rec("issueGrab.create", args);
    return { id: `grab-${Date.now()}`, ...args.data };
  },
});

// The in-app inbox writer (createInAppNotification) — the observable "notify the
// other party" signal. Recording so tests can assert it fired / was suppressed.
shadowPrismaModel(prisma, "notification", {
  create: async (args: { data: Record<string, unknown> }) => {
    rec("notification.create", args);
    return { id: `note-${Date.now()}`, ...args.data };
  },
});

// logAudit (swallowing) writes here; auditThrows flips it to reject so guardrail
// 26 (a failed post-commit audit must not break the request) can be pinned.
let auditThrows = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => {
    rec("auditLog.create", args);
    if (auditThrows) throw new Error("stubbed audit write failure");
    return {};
  },
});

// Library-presence gate (issues can only be filed for available media).
let plexHas = false;
let jellyfinHas = false;
shadowPrismaModel(prisma, "plexLibraryItem", {
  findUnique: async (args: unknown) => {
    rec("plexLibraryItem.findUnique", args);
    return plexHas ? { tmdbId: 603 } : null;
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findUnique: async (args: unknown) => {
    rec("jellyfinLibraryItem.findUnique", args);
    return jellyfinHas ? { tmdbId: 603 } : null;
  },
});
// The push notify fan-out reads subscriptions; empty ⇒ it short-circuits.
shadowPrismaModel(prisma, "pushSubscription", {
  findMany: async () => [],
});

// Routes under test (imported AFTER every stub is in place).
const { GET: getIssues, POST: postIssues } = await import("../src/app/api/issues/route.ts");
const { PATCH: patchIssueRoute } = await import("../src/app/api/issues/[id]/route.ts");
const { POST: postMessageRoute } = await import("../src/app/api/issues/[id]/messages/route.ts");
const { POST: postReleaseRoute } = await import("../src/app/api/issues/[id]/releases/route.ts");

// ── synthetic request scope with a recording afterContext ────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/issues-routes.test",
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

type Ctx = { params: Promise<{ id: string }> };
function idCtx(id: string): Ctx {
  return { params: Promise.resolve({ id }) };
}

function issuesReq(
  token: string | null,
  init: { method: string; body?: string; query?: string; path?: string },
): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000/api/issues${init.path ?? ""}${init.query ?? ""}`, {
    method: init.method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

async function postIssue(token: string | null, body: unknown, rawBody?: string): Promise<Response> {
  const req = issuesReq(token, { method: "POST", body: rawBody ?? JSON.stringify(body) });
  return inScope(() => postIssues(req, undefined));
}
async function listIssues(token: string | null, query = ""): Promise<Response> {
  return inScope(() => getIssues(issuesReq(token, { method: "GET", query }), undefined));
}
async function patchIssue(token: string | null, id: string, body: unknown): Promise<Response> {
  const req = issuesReq(token, { method: "PATCH", body: JSON.stringify(body), path: `/${id}` });
  return inScope(() => patchIssueRoute(req, idCtx(id)));
}
async function postMessage(token: string | null, id: string, body: unknown, rawBody?: string): Promise<Response> {
  const req = issuesReq(token, { method: "POST", body: rawBody ?? JSON.stringify(body), path: `/${id}/messages` });
  return inScope(() => postMessageRoute(req, idCtx(id)));
}
async function postRelease(token: string | null, id: string, body: unknown): Promise<Response> {
  const req = issuesReq(token, { method: "POST", body: JSON.stringify(body), path: `/${id}/releases` });
  return inScope(() => postReleaseRoute(req, idCtx(id)));
}

// A minimal valid create body. tvdbId is deliberately NOT included — the route
// resolves it server-side (guardrail against a client pairing a mismatched id).
function createBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { mediaType: "MOVIE", tmdbId: 603, issueType: "BAD_VIDEO", ...over };
}

const createdIssueData = (i = 0): Record<string, unknown> =>
  (opsOf("issue.create")[i].args as { data: Record<string, unknown> }).data;

// Flush pending fire-and-forget notify microtasks (messages route notifies via
// void ...catch, not after()) so a "no network" assertion is stable.
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  ops.length = 0;
  afterTasks.length = 0;
  sseEvents.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  issueRow = null;
  issueListRows = [];
  issueUpdateManyCount = 1;
  auditThrows = false;
  plexHas = false;
  jellyfinHas = false;
  invalidateFeatureFlagCache();
  fetchImpl = () => {
    throw new Error("unexpected fetch — this test's flow must be satisfied from stubs/caches");
  };
});

// ═══════════════════════════ POST /api/issues (create) ═══════════════════════

test("POST without a session → 401 Unauthorized; the handler body never runs", async () => {
  const res = await postIssue(null, createBody());
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.equal(ops.length, 0);
});

test("POST is gated on the issues feature flag: disabled → 403 before any work", async () => {
  settings.set("feature.page.issues", "false");
  const { userId, token } = await mintSession();
  const res = await postIssue(token, createBody({ tmdbId: 603, mediaType: "MOVIE", issueType: "BAD_VIDEO" }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Issue reporting is disabled" });
  assert.equal(opsOf("issue.create").length, 0);
  assert.equal(fetchCalls.length, 0, "a disabled feature must not reach the TMDB verify");
  void userId;
});

test("POST body handling (guardrail 30): oversized → 413, malformed → 400, and field validation → 400/422 with no row created", async () => {
  settings.set("rateLimitIssues", "1000"); // decouple this multi-POST test from the rate limiter
  const { token } = await mintSession();

  const oversized = await postIssue(token, null, JSON.stringify({ note: "x".repeat(70_000) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "Request body too large (max 64KB)" });

  const malformed = await postIssue(token, null, "{not json");
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request body" });

  const missing = await postIssue(token, { mediaType: "MOVIE", tmdbId: 603 }); // no issueType
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "mediaType, tmdbId, and issueType are required" });

  const badMedia = await postIssue(token, createBody({ mediaType: "PERSON" }));
  assert.equal(badMedia.status, 400);
  assert.deepEqual(await badMedia.json(), { error: "mediaType must be MOVIE or TV" });

  const badId = await postIssue(token, createBody({ tmdbId: -3 }));
  assert.equal(badId.status, 400);
  assert.deepEqual(await badId.json(), { error: "tmdbId must be a positive integer" });

  const badType = await postIssue(token, createBody({ issueType: "NONSENSE" }));
  assert.equal(badType.status, 400);
  assert.ok(((await badType.json()) as { error: string }).error.startsWith("issueType must be one of"));

  const seasonless = await postIssue(token, createBody({ mediaType: "TV", scope: "SEASON" }));
  assert.equal(seasonless.status, 400);
  assert.deepEqual(await seasonless.json(), { error: "seasonNumber is required for SEASON or EPISODE scope" });

  assert.equal(opsOf("issue.create").length, 0, "no create for any rejected body");
  assert.equal(fetchCalls.length, 0, "validation must reject before the TMDB verify");
});

test("POST 422s when TMDB can't verify the media, and again when the title isn't in any library — no row either way", async () => {
  // TMDB verify returns null (fetch throws → verifyTmdbMedia catches → null).
  const a = await mintSession();
  const unverified = await postIssue(a.token, createBody());
  assert.equal(unverified.status, 422);
  assert.deepEqual(await unverified.json(), { error: "Could not verify media with TMDB" });
  assert.equal(fetchCalls.length, 1, "exactly the one TMDB verify attempt was made");

  // Verify succeeds, but neither library has the title → 422 (library gate).
  fetchImpl = tmdbVerifyFetch;
  plexHas = false;
  jellyfinHas = false;
  const b = await mintSession();
  const notInLibrary = await postIssue(b.token, createBody());
  assert.equal(notInLibrary.status, 422);
  assert.deepEqual(await notInLibrary.json(), {
    error: "This title isn't in the library — issues can only be filed for available media.",
  });
  assert.equal(opsOf("issue.create").length, 0);
});

test("POST create (movie): the Issue row is shaped from the verify, tvdbId stays null, SSE fires, and the response is 201", async () => {
  fetchImpl = tmdbVerifyFetch;
  plexHas = true; // in the library
  const { userId, token } = await mintSession();

  const res = await postIssue(token, createBody({ note: "  audio drops out at 12:00  ", issueType: "WRONG_AUDIO" }));
  assert.equal(res.status, 201);

  const data = createdIssueData();
  assert.equal(data.reportedBy, userId);
  assert.equal(data.tmdbId, 603);
  assert.equal(data.mediaType, "MOVIE");
  assert.equal(data.tvdbId, null, "a movie never resolves a tvdbId");
  assert.equal(data.title, "The Matrix", "title comes from the TMDB verify, not the client");
  assert.equal(data.posterPath, "/matrix.jpg");
  assert.equal(data.issueType, "WRONG_AUDIO");
  assert.equal(data.scope, "FULL", "the default scope is FULL");
  assert.equal(data.seasonNumber, null);
  assert.equal(data.note, "audio drops out at 12:00", "the note is sanitized/trimmed");

  assert.deepEqual(sseEvents.map((e) => e.type), ["issue:new"]);
  assert.equal(fetchCalls.length, 1, "only the TMDB verify hit the wire");
});

test("POST create (TV, unconfigured Sonarr): tvdbId resolves to null server-side and EPISODE scope carries season+episode", async () => {
  fetchImpl = tmdbVerifyFetch;
  jellyfinHas = true;
  const { token } = await mintSession();

  const res = await postIssue(
    token,
    // A client-supplied tvdbId must be ignored — the route never destructures it.
    createBody({ mediaType: "TV", tmdbId: 1396, tvdbId: 999999, scope: "EPISODE", seasonNumber: 2, episodeNumber: 5, issueType: "MISSING_SUBTITLES" }),
  );
  assert.equal(res.status, 201);

  const data = createdIssueData();
  assert.equal(data.mediaType, "TV");
  assert.equal(data.title, "Breaking Bad");
  assert.equal(data.tvdbId, null, "Sonarr is unconfigured → resolveTvdbIdFromTmdbId returns null (not the client's 999999)");
  assert.equal(data.scope, "EPISODE");
  assert.equal(data.seasonNumber, 2);
  assert.equal(data.episodeNumber, 5);
  assert.equal(fetchCalls.length, 1, "the TV verify is the only wire call — Sonarr short-circuits with no config");
});

test("POST enqueues exactly one admin new-issue notify fan-out via after() that completes offline with unconfigured channels", async () => {
  fetchImpl = tmdbVerifyFetch;
  plexHas = true;
  const { token } = await mintSession();

  const res = await postIssue(token, createBody());
  assert.equal(res.status, 201);
  assert.equal(afterTasks.length, 1, "the admin notify is deferred to exactly one after() task");

  const wireBefore = fetchCalls.length;
  await afterTasks[0]();
  assert.equal(fetchCalls.length, wireBefore, "email/push/discord all short-circuit before the network when unconfigured");
  assert.deepEqual(errors, []);
});

test("POST honors the rateLimitIssues Setting: past the cap → 429 before the body is parsed", async () => {
  settings.set("rateLimitIssues", "1");
  const { token } = await mintSession();
  const first = await postIssue(token, {}); // consumes the bucket, then 400s on the empty body
  assert.equal(first.status, 400);
  const second = await postIssue(token, createBody());
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: "Too many requests — try again later" });
  assert.equal(opsOf("issue.create").length, 0);
});

// ═══════════════════════════ GET /api/issues (list) ══════════════════════════

test("GET scopes a plain USER to their OWN issues (name-only include) while MANAGE_ISSUES sees all (name+email), and clamps limit", async () => {
  issueListRows = [{ id: "issue-1", title: "The Matrix", status: "OPEN" }];

  const user = await mintSession();
  const own = await listIssues(user.token, "?limit=500");
  assert.equal(own.status, 200);
  const ownArgs = opsOf("issue.findMany")[0].args as { where: Record<string, unknown>; include: { user: { select: Record<string, boolean> } }; take: number };
  assert.equal(ownArgs.where.reportedBy, user.userId, "a plain user only sees their own reports");
  assert.equal(ownArgs.include.user.select.name, true);
  assert.equal(ownArgs.include.user.select.email, undefined, "a non-manager must not receive reporter emails");
  assert.equal(ownArgs.take, 100, "limit is clamped to 100");

  ops.length = 0;
  const manager = await mintSession({ permissions: String(Permission.MANAGE_ISSUES) });
  const all = await listIssues(manager.token); // default limit
  assert.equal(all.status, 200);
  const allArgs = opsOf("issue.findMany")[0].args as { where: Record<string, unknown>; include: { user: { select: Record<string, boolean> } }; take: number };
  assert.equal(allArgs.where.reportedBy, undefined, "MANAGE_ISSUES sees every reporter's issues");
  assert.equal(allArgs.include.user.select.email, true, "the manager include exposes reporter emails");
  assert.equal(allArgs.take, 50, "the default page size is 50");
});

// ═══════════════════════ PATCH /api/issues/[id] (status) ═════════════════════

test("PATCH is withIssueAdmin-gated: a plain USER is 403, an ISSUE_ADMIN and an ADMIN pass", async () => {
  issueRow = { id: "issue-1", status: "OPEN", reportedBy: "reporter-x", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603, resolution: null, posterPath: "/m.jpg" };

  const plain = await mintSession(); // USER, no MANAGE_ISSUES
  const denied = await patchIssue(plain.token, "issue-1", { status: "IN_PROGRESS" });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Forbidden" });
  assert.equal(opsOf("issue.updateMany").length, 0, "a forbidden caller never reaches the mutation");

  for (const role of ["ISSUE_ADMIN", "ADMIN"]) {
    issueRow = { id: "issue-1", status: "OPEN", reportedBy: "reporter-x", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603, resolution: null, posterPath: "/m.jpg" };
    const admin = await mintSession({ role });
    const ok = await patchIssue(admin.token, "issue-1", { status: "IN_PROGRESS" });
    assert.equal(ok.status, 200, `${role} must pass withIssueAdmin`);
  }
});

test("PATCH OPEN→RESOLVED: CAS updateMany, an issue:updated SSE, a resolved inbox row for the reporter, and an audit entry", async () => {
  issueRow = { id: "issue-9", status: "OPEN", reportedBy: "reporter-victim", title: "Dune", mediaType: "MOVIE", tmdbId: 438631, resolution: null, posterPath: "/dune.jpg" };
  const admin = await mintSession({ role: "ISSUE_ADMIN" });

  const res = await patchIssue(admin.token, "issue-9", { status: "RESOLVED", resolution: "Re-downloaded a clean copy." });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "RESOLVED");

  // The status change is a CAS on the prior status so a concurrent transition wins.
  const cas = opsOf("issue.updateMany")[0].args as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.equal(cas.where.id, "issue-9");
  assert.equal(cas.where.status, "OPEN", "the CAS guards the observed status");
  assert.equal(cas.data.status, "RESOLVED");
  assert.equal(cas.data.resolution, "Re-downloaded a clean copy.");

  assert.deepEqual(sseEvents.map((e) => e.type), ["issue:updated"]);
  assert.equal((sseEvents[0] as { userId: string }).userId, "reporter-victim", "the SSE targets the reporter");

  // The reporter (a different user) gets the "resolved" inbox row.
  const note = opsOf("notification.create")[0].args as { data: Record<string, unknown> };
  assert.equal(note.data.userId, "reporter-victim");
  assert.equal(note.data.type, "ISSUE_RESOLVED");
  assert.equal(opsOf("auditLog.create").length, 1, "a status change is audited");
});

test("PATCH: an issue-admin resolving their OWN reported issue gets NO self-notification inbox row", async () => {
  const admin = await mintSession({ role: "ISSUE_ADMIN" });
  issueRow = { id: "issue-self", status: "OPEN", reportedBy: admin.userId, title: "Arrival", mediaType: "MOVIE", tmdbId: 329865, resolution: null, posterPath: "/a.jpg" };

  const res = await patchIssue(admin.token, "issue-self", { status: "RESOLVED", resolution: "Fixed it myself." });
  assert.equal(res.status, 200);
  assert.equal(opsOf("notification.create").length, 0, "resolving your own report must not notify yourself");
});

test("PATCH edge cases: unknown id → 404, invalid status → 400, and a lost CAS (count 0) → 409 conflict", async () => {
  const admin = await mintSession({ role: "ISSUE_ADMIN" });

  issueRow = null; // findUnique misses
  const notFound = await patchIssue(admin.token, "ghost", { status: "RESOLVED" });
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: "Not found" });

  issueRow = { id: "issue-1", status: "OPEN", reportedBy: "r", title: "t", mediaType: "MOVIE", tmdbId: 1, resolution: null, posterPath: null };
  const badStatus = await patchIssue(admin.token, "issue-1", { status: "SIDEWAYS" });
  assert.equal(badStatus.status, 400);
  assert.ok(((await badStatus.json()) as { error: string }).error.startsWith("status must be one of"));

  issueRow = { id: "issue-1", status: "OPEN", reportedBy: "r", title: "t", mediaType: "MOVIE", tmdbId: 1, resolution: null, posterPath: null };
  issueUpdateManyCount = 0; // a concurrent admin already moved it
  const conflict = await patchIssue(admin.token, "issue-1", { status: "RESOLVED" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "status-conflict",
    message: "Issue was modified concurrently. Refresh and try again.",
  });
});

test("PATCH audit is post-commit + swallowing (guardrail 26): a thrown audit write still returns the updated issue, not a 500", async () => {
  issueRow = { id: "issue-a", status: "OPEN", reportedBy: "reporter-z", title: "Tenet", mediaType: "MOVIE", tmdbId: 577922, resolution: null, posterPath: null };
  auditThrows = true; // logAudit's auditLog.create rejects
  const admin = await mintSession({ role: "ADMIN" });

  const res = await patchIssue(admin.token, "issue-a", { status: "IN_PROGRESS" });
  assert.equal(res.status, 200, "the committed transition must survive a failed audit write");
  assert.equal((await res.json() as { status: string }).status, "IN_PROGRESS");
  assert.ok(errors.some((e) => e.includes("[audit] Failed to write audit log")), "the swallow variant logs the failure");
});

// ═══════════════════ POST /api/issues/[id]/messages (thread) ═════════════════

test("messages POST is ownership-gated: a non-reporter USER is 403; the reporter and an issue-admin may post", async () => {
  issueRow = { id: "issue-m", status: "OPEN", reportedBy: "reporter-owner", title: "Sicario", mediaType: "MOVIE", tmdbId: 273481, posterPath: null, claimedBy: null };

  const stranger = await mintSession(); // a different plain USER
  const denied = await postMessage(stranger.token, "issue-m", { body: "not my issue" });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Forbidden" });
  assert.equal(opsOf("issueMessage.create").length, 0);

  // The reporter themselves may reply.
  issueRow = { id: "issue-m", status: "OPEN", reportedBy: "reporter-owner", title: "Sicario", mediaType: "MOVIE", tmdbId: 273481, posterPath: null, claimedBy: null };
  usersById.set("reporter-owner", {
    role: "USER", permissions: 0n, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: null, notificationEmail: null,
  });
  const iat = Math.floor(Date.now() / 1000);
  sessionRows.add("sess-owner");
  const ownerToken = await signSessionJwt(
    { id: "reporter-owner", role: "USER", permissions: "0", provider: "credentials", sessionId: "sess-owner", expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  const asReporter = await postMessage(ownerToken, "issue-m", { body: "still broken" });
  assert.equal(asReporter.status, 201, "the reporter can always post on their own thread");
  await flushMicrotasks();
});

test("messages POST (admin reply): creates a fromAdmin IssueMessage, notifies the reporter's inbox, and auto-promotes OPEN→IN_PROGRESS", async () => {
  issueRow = { id: "issue-t", status: "OPEN", reportedBy: "reporter-owner2", title: "Prisoners", mediaType: "MOVIE", tmdbId: 146233, posterPath: "/p.jpg", claimedBy: null };
  const admin = await mintSession({ role: "ISSUE_ADMIN" });

  const res = await postMessage(admin.token, "issue-t", { body: "  looking into it now  " });
  assert.equal(res.status, 201);

  const created = opsOf("issueMessage.create")[0].args as { data: Record<string, unknown> };
  assert.equal(created.data.issueId, "issue-t");
  assert.equal(created.data.authorId, admin.userId);
  assert.equal(created.data.fromAdmin, true);
  assert.equal(created.data.body, "looking into it now", "the body is trimmed + sanitized");

  // The reporter (the other party) gets an ISSUE_REPLY inbox row.
  const note = opsOf("notification.create")[0].args as { data: Record<string, unknown> };
  assert.equal(note.data.userId, "reporter-owner2");
  assert.equal(note.data.type, "ISSUE_REPLY");

  // Admin's first reply on an OPEN issue CAS-promotes it to IN_PROGRESS.
  const promote = opsOf("issue.updateMany").find(
    (o) => (o.args as { data: Record<string, unknown> }).data.status === "IN_PROGRESS",
  );
  assert.ok(promote, "the admin's first reply promotes OPEN→IN_PROGRESS");
  const sseTypes = sseEvents.map((e) => e.type);
  assert.ok(sseTypes.includes("issue:updated") && sseTypes.includes("issuemessage:created"));

  await flushMicrotasks();
  assert.equal(fetchCalls.length, 0, "unconfigured message-notify channels never reach the network");
});

test("messages POST body validation: a non-string body → 400, whitespace-only → 400, over-2000-chars → 400", async () => {
  issueRow = { id: "issue-v", status: "OPEN", reportedBy: "reporter-owner3", title: "t", mediaType: "MOVIE", tmdbId: 1, posterPath: null, claimedBy: null };
  const admin = await mintSession({ role: "ISSUE_ADMIN" });

  const nonString = await postMessage(admin.token, "issue-v", { body: 123 });
  assert.equal(nonString.status, 400);
  assert.deepEqual(await nonString.json(), { error: "body is required" });

  const blank = await postMessage(admin.token, "issue-v", { body: "   " });
  assert.equal(blank.status, 400);

  const tooLong = await postMessage(admin.token, "issue-v", { body: "y".repeat(2001) });
  assert.equal(tooLong.status, 400);
  assert.deepEqual(await tooLong.json(), { error: "body must be under 2000 characters" });
  assert.equal(opsOf("issueMessage.create").length, 0);
});

// ═══════════════════ POST /api/issues/[id]/releases (grab) ═══════════════════

test("releases POST is withIssueAdmin-gated and refuses a RESOLVED issue with 409", async () => {
  issueRow = { id: "issue-r", status: "OPEN", reportedBy: "r", title: "t", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null };

  const plain = await mintSession();
  const denied = await postRelease(plain.token, "issue-r", { guid: "abc", indexerId: 1 });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Forbidden" });

  issueRow = { id: "issue-r", status: "RESOLVED", reportedBy: "r", title: "t", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null };
  const admin = await mintSession({ role: "ISSUE_ADMIN" });
  const resolved = await postRelease(admin.token, "issue-r", { guid: "abc", indexerId: 1 });
  assert.equal(resolved.status, 409);
  assert.deepEqual(await resolved.json(), { error: "Issue is resolved — reopen it before grabbing a release" });
  assert.equal(opsOf("issueGrab.create").length, 0);
});

test("releases POST is instance-slug-scoped (guardrail 32): an invalid slug → 400, a valid-but-unconfigured named instance → 422", async () => {
  issueRow = { id: "issue-r2", status: "OPEN", reportedBy: "r", title: "t", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null };
  const admin = await mintSession({ role: "ADMIN" });

  const badSlug = await postRelease(admin.token, "issue-r2", { guid: "abc", indexerId: 1, instance: "9nope" }); // fails ^[a-z]
  assert.equal(badSlug.status, 400);
  assert.deepEqual(await badSlug.json(), { error: "Invalid instance" });

  const unconfigured = await postRelease(admin.token, "issue-r2", { guid: "abc", indexerId: 1, instance: "anime" });
  assert.equal(unconfigured.status, 422);
  assert.deepEqual(await unconfigured.json(), { error: "radarr (anime) is not configured" });
  assert.equal(opsOf("issueGrab.create").length, 0);
});

test("releases POST (happy grab): the resolved instance slug flows into IssueGrab.arrInstance and the issue is claimed IN_PROGRESS", async () => {
  issueRow = { id: "issue-r3", status: "OPEN", reportedBy: "r", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null };
  // Configure the legacy 4K Radarr instance and script its two grab calls.
  settings.set("radarr4kUrl", "http://radarr-4k.example.com:7878");
  settings.set("radarr4kApiKey", "4k-api-key");
  fetchImpl = (url: URL) => {
    if (url.pathname.startsWith("/api/v3/movie")) return jsonResponse([{ id: 42, tmdbId: 603 }]);
    if (url.pathname === "/api/v3/release") return jsonResponse({ ok: true });
    throw new Error(`unexpected grab fetch: ${url.href}`);
  };
  const admin = await mintSession({ role: "ADMIN" });

  const res = await postRelease(admin.token, "issue-r3", { guid: "release-guid-123", indexerId: 7, instance: "4k" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const grab = opsOf("issueGrab.create")[0].args as { data: Record<string, unknown> };
  assert.equal(grab.data.arrInstance, "4k", "the grab is recorded against the picked instance");
  assert.equal(grab.data.tmdbId, 603);
  assert.equal(grab.data.triggeredById, admin.userId);

  // The pre-grab CAS claims the issue IN_PROGRESS on a not-RESOLVED predicate.
  const claim = opsOf("issue.updateMany")[0].args as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.deepEqual(claim.where.status, { not: "RESOLVED" });
  assert.equal(claim.data.status, "IN_PROGRESS");
  assert.equal(opsOf("auditLog.create").length, 1, "the grab is audited");
});
