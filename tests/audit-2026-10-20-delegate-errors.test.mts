// Radarr/Sonarr failures shown to a MANAGE_REQUESTS delegate name the failure's
// KIND, never the arr's internal address (audit 2026-10-20, F029/F025), and an
// ArrResponseError never prints its upstream body when logged (F024).
//
// Why: arrErrorMessage generalises only an ArrResponseError. A SafeFetchError
// (timeout, refused connection) passed through as err.message — "fetch failed
// for http://10.0.0.5:7878/api/v3/movie?…: fetch failed (connect ECONNREFUSED
// 10.0.0.5:7878)" — and PATCH /api/requests/[id] (Search, Retry, Approve) and
// PATCH /api/requests/batch relayed it as `arrError` / `failed[].error` to a
// role=USER delegate. Guardrail 5g: delegate-facing arr data never carries an
// arr URL. And console.error(err) printed an ArrResponseError's enumerable
// `body`, which can quote an indexer URL with its apikey (guardrail 5e).
//
// Pinned:
//  - arrErrorMessageForClient: an ArrResponseError keeps arrErrorMessage's
//    generic status phrase; a timeout, a refused connection and any other error
//    become a translated phrase by kind, with no URL, host, IP or port;
//  - ArrResponseError.body still reads, but util.inspect / JSON.stringify /
//    Object.keys never show it;
//  - every delegate-reachable route (Search, Retry, Approve, batch Approve) answers
//    the phrase (translated for a Spanish caller) and keeps the wire shape (a
//    string), while the server log keeps the detail — and never the body.
//
// Harness: the shape of tests/requests-mutation-routes.test.mts (real signed
// session JWT, synthetic request scope, in-memory prisma stubs), with a fetch
// that fails the way a dark or slow arr does.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { format, inspect } from "node:util";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "delegate-errors-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

// util.format, as Node's console does: an Error argument goes through util.inspect.
const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(format(...args)); };
console.warn = () => {};

// ── a Radarr/Sonarr that fails ───────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.6:8989";
const BODY_SECRET = "https://indexer.example/api?apikey=UPSTREAM-SECRET-0042";
type Failure = "refused" | "timeout" | "status500";
let failure: Failure = "refused";
const arrCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.origin !== RADARR && url.origin !== SONARR) throw new Error(`unexpected fetch ${url.href}`);
  arrCalls.push(url.pathname);
  if (failure === "refused") {
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${url.host}`), { code: "ECONNREFUSED" });
    throw new TypeError("fetch failed", { cause });
  }
  if (failure === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  return new Response(JSON.stringify({ message: "Unexpected error", description: `HttpException: ${BODY_SECRET}` }), { status: 500 });
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
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { ArrResponseError, arrErrorMessage, arrErrorMessageForClient } = await import("../src/lib/arr.ts");
const { SafeFetchError } = await import("../src/lib/safe-fetch.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");

// ── auth fixture ─────────────────────────────────────────────────────────────
const users = new Map<string, Record<string, unknown>>();
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
  findMany: async () => [],
  update: async () => ({}),
  count: async () => users.size,
});
let seq = 0;
// A role=USER delegate holding MANAGE_REQUESTS, not ADMIN.
async function delegate(): Promise<string> {
  seq++;
  const userId = `delegate-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = Permission.MANAGE_REQUESTS.toString();
  users.set(userId, {
    id: userId, name: `Delegate ${seq}`, email: `delegate-${seq}@example.com`, role: "USER",
    permissions: Permission.MANAGE_REQUESTS, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "USER", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── MediaRequest store honouring the CAS's status predicate ─────────────────
type Row = Record<string, unknown> & { id: string; status: string };
let rows: Row[] = [];
function matches(r: Row, where: Record<string, unknown> = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "id" && typeof v === "object" && v !== null) {
      if (!((v as { in: string[] }).in).includes(r.id)) return false;
      continue;
    }
    if (r[k] !== v) return false;
  }
  return true;
}
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => {
    const r = rows.find((x) => x.id === args.where.id);
    return r ? { ...r } : null;
  },
  findMany: async (args: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of rows) if (matches(r, args.where)) { Object.assign(r, args.data); count++; }
    return { count };
  },
  updateManyAndReturn: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const out: Array<{ id: string; requestedBy: unknown }> = [];
    for (const r of rows) if (matches(r, args.where)) { Object.assign(r, args.data); out.push({ id: r.id, requestedBy: r.requestedBy }); }
    return out;
  },
});
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  upsert: async () => ({}), createMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }),
});
for (const m of ["auditLog", "notification", "notificationAgent", "pushSubscription", "tmdbCache", "deletionVote"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null, count: async () => 0,
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }), upsert: async () => ({}),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const idRoute = await import("../src/app/api/requests/[id]/route.ts");
const batchRoute = await import("../src/app/api/requests/batch/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-2026-10-20-delegate-errors.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
const mk = (path: string, token: string, body: unknown, lang?: string) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: "PATCH",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json", ...(lang ? { "accept-language": lang } : {}) },
    body: JSON.stringify(body),
  });
const patchOne = (token: string, id: string, body: unknown, lang?: string) =>
  inScope(() => idRoute.PATCH(mk(`/api/requests/${id}`, token, body, lang), { params: Promise.resolve({ id }) }));
const patchBatch = (token: string, body: unknown) =>
  inScope(() => (batchRoute.PATCH as unknown as (r: unknown, c: unknown) => Promise<Response>)(mk("/api/requests/batch", token, body), undefined));

const row = (over: Record<string, unknown> & { id: string; status: string }): Row => ({
  tmdbId: 603, mediaType: "MOVIE", arrInstance: "", title: "The Matrix", requestedBy: "requester-1",
  posterPath: null, releaseYear: "1999", permanentlyDeclined: false, adminNote: null, pendingNotifyAt: null,
  availableAt: null, qualityProfileId: null, tvdbId: null, createdAt: new Date(), approvedAt: null, ...over,
});

// No internal address in what the caller is shown.
function assertNoAddress(text: string, what: string): void {
  for (const leak of ["10.0.0.5", "10.0.0.6", "7878", "8989", "ECONNREFUSED", "http://", "/api/v3"]) {
    assert.ok(!text.includes(leak), `${what} carries ${leak}: ${text}`);
  }
}

const tEn = translatorFor("en");
const tEs = translatorFor("es");
const UNREACHABLE = tEn("apiUser.common.arrUnreachable");
const TIMEOUT = tEn("apiUser.common.arrTimeout");

beforeEach(() => {
  rows = [];
  errors.length = 0;
  arrCalls.length = 0;
  failure = "refused";
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
});

// ── pure ─────────────────────────────────────────────────────────────────────

test("arrErrorMessageForClient: a SafeFetchError is named by its kind — no URL, host, IP or port — and translated", () => {
  const url = "http://10.0.0.5:7878/api/v3/command";
  const timeout = new SafeFetchError("timeout", url, `Request to ${url} timed out after 30000ms`);
  const refused = new SafeFetchError("network", url, `fetch failed for ${url}: fetch failed (connect ECONNREFUSED 10.0.0.5:7878)`);
  const blocked = new SafeFetchError("ssrf-blocked", url, `Host 10.0.0.5 failed re-resolution check (DNS-rebind defence)`);
  const redirect = new SafeFetchError("redirect", url, `Request to ${url} attempted to redirect (blocked by safeFetch)`);
  const plain = new Error(`Radarr: lookup at ${url} returned garbage`);
  assert.equal(arrErrorMessageForClient(timeout, tEn), TIMEOUT);
  assert.equal(arrErrorMessageForClient(refused, tEn), UNREACHABLE);
  assert.equal(arrErrorMessageForClient(blocked, tEn), UNREACHABLE);
  assert.equal(arrErrorMessageForClient(redirect, tEn), tEn("apiUser.common.arrFailed"));
  assert.equal(arrErrorMessageForClient(plain, tEn), tEn("apiUser.common.arrFailed"));
  assert.equal(arrErrorMessageForClient("a thrown string", tEn), tEn("apiUser.common.arrFailed"));
  assert.equal(arrErrorMessageForClient(Object.assign(new Error("aborted"), { name: "TimeoutError" }), tEn), TIMEOUT);
  for (const err of [timeout, refused, blocked, redirect, plain]) assertNoAddress(arrErrorMessageForClient(err, tEn), "the client text");
  // The detail is still there for the server log.
  assert.match(arrErrorMessage(refused), /10\.0\.0\.5:7878/);
  // Translated through the caller's translator.
  assert.equal(arrErrorMessageForClient(refused, tEs), tEs("apiUser.common.arrUnreachable"));
  assert.notEqual(tEs("apiUser.common.arrUnreachable"), UNREACHABLE);
});

test("arrErrorMessageForClient: an ArrResponseError keeps arrErrorMessage's generic status phrase, never its body", () => {
  for (const status of [401, 404, 500, 502, 503, 504, 400]) {
    const err = new ArrResponseError(status, `{"message":"boom","description":"${BODY_SECRET}"}`);
    assert.equal(arrErrorMessageForClient(err, tEn), arrErrorMessage(err), String(status));
    assert.ok(!arrErrorMessageForClient(err, tEn).includes("UPSTREAM-SECRET"), String(status));
  }
});

test("ArrResponseError.body reads as before but is never printed: not in util.inspect, JSON.stringify or Object.keys", () => {
  const err = new ArrResponseError(500, BODY_SECRET);
  assert.equal(err.body, BODY_SECRET);
  assert.equal(err.status, 500);
  assert.ok(!inspect(err).includes("UPSTREAM-SECRET"), inspect(err));
  assert.ok(!format("[arr] failed:", err).includes("UPSTREAM-SECRET"));
  assert.ok(!JSON.stringify(err).includes("UPSTREAM-SECRET"));
  assert.ok(!Object.keys(err).includes("body"));
  assert.equal(Object.prototype.propertyIsEnumerable.call(err, "body"), false);
  assert.ok(inspect(err).includes("status: 500"), "the status still prints");
});

// ── routes: what a MANAGE_REQUESTS delegate is answered ─────────────────────

test("Search on a request while Radarr refuses the connection: the delegate gets the kind, the log keeps the address", async () => {
  const token = await delegate();
  rows = [row({ id: "r1", status: "APPROVED" })];
  const res = await patchOne(token, "r1", { search: true });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { arrError: unknown; id: string };
  assert.equal(body.id, "r1");
  assert.equal(typeof body.arrError, "string", "the wire shape the iOS app decodes");
  assert.equal(body.arrError, UNREACHABLE);
  assertNoAddress(String(body.arrError), "arrError");
  assert.ok(arrCalls.length > 0, "the search did reach the (dark) arr");
  assert.ok(errors.some((l) => l.includes("[arr] Search failed:") && l.includes("10.0.0.5:7878")), errors.join("\n"));
});

test("Search on a request while Radarr times out answers the timeout phrase — in the caller's language", async () => {
  const token = await delegate();
  failure = "timeout";
  rows = [row({ id: "r1", status: "APPROVED" })];
  const en = (await (await patchOne(token, "r1", { search: true })).json()) as { arrError: string };
  assert.equal(en.arrError, TIMEOUT);
  const es = (await (await patchOne(token, "r1", { search: true }, "es")).json()) as { arrError: string };
  assert.equal(es.arrError, tEs("apiUser.common.arrTimeout"));
  assertNoAddress(en.arrError, "arrError");
  assertNoAddress(es.arrError, "arrError");
});

test("Retry push while Radarr is dark answers the kind, never the address", async () => {
  const token = await delegate();
  rows = [row({ id: "r1", status: "APPROVED" })];
  const res = await patchOne(token, "r1", { retry: true });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { arrError: string };
  assert.equal(body.arrError, UNREACHABLE);
  assertNoAddress(body.arrError, "arrError");
  assert.ok(errors.some((l) => l.includes("[arr] Retry push failed:") && l.includes("10.0.0.5:7878")));
});

test("Approve while Radarr is dark rolls back and answers the kind, never the address", async () => {
  const token = await delegate();
  rows = [row({ id: "r1", status: "PENDING" })];
  const res = await patchOne(token, "r1", { status: "APPROVED" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { arrError: string; status: string };
  assert.equal(body.status, "PENDING", "rolled back");
  assert.equal(body.arrError, UNREACHABLE);
  assertNoAddress(body.arrError, "arrError");
  assert.ok(errors.some((l) => l.includes("[arr] Failed to push request:") && l.includes("10.0.0.5:7878")));
});

test("Approve answered 500 by Radarr: the generic status phrase reaches the delegate, the body reaches neither the answer nor the log", async () => {
  const token = await delegate();
  failure = "status500";
  rows = [row({ id: "r1", status: "PENDING" })];
  const text = await (await patchOne(token, "r1", { status: "APPROVED" })).text();
  assert.equal((JSON.parse(text) as { arrError: string }).arrError, arrErrorMessage(new ArrResponseError(500, "")));
  assert.ok(!text.includes("UPSTREAM-SECRET"));
  assert.ok(errors.length > 0);
  for (const line of errors) assert.ok(!line.includes("UPSTREAM-SECRET"), line);
});

test("batch Approve while Radarr is dark: failed[].error and the arrError summary carry the kind, never the address", async () => {
  const token = await delegate();
  rows = [row({ id: "r1", status: "PENDING" }), row({ id: "r2", status: "PENDING", tmdbId: 604, title: "The Matrix Reloaded" })];
  const res = await patchBatch(token, { ids: ["r1", "r2"], status: "APPROVED" });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as { failed: Array<{ id: string; error: string }>; arrError: string };
  assert.deepEqual(body.failed.map((f) => [f.id, f.error]), [["r1", UNREACHABLE], ["r2", UNREACHABLE]]);
  assert.equal(typeof body.arrError, "string");
  assertNoAddress(text, "the batch answer");
  assert.ok(errors.some((l) => l.includes("[arr] Batch approve push failed for") && l.includes("10.0.0.5:7878")));
  assert.deepEqual(rows.map((r) => r.status), ["PENDING", "PENDING"], "both rolled back");
});
