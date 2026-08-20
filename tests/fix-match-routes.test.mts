// Route-level unit tests for the four /api/admin/fix-match handlers, which had
// ZERO coverage before this file. They are invoked directly with constructed
// NextRequests + a REAL signed session; no DB, no network, no DNS.
//
// THE HEADLINE — the multi-server trap. The POST route has accepted, validated
// and DB-scoped a `serverInstance` body field since the multi-server migration
// (findFirst by `{ tmdbId, mediaType, serverInstance }`, delete/upsert on the
// `tmdbId_mediaType_serverInstance` compound key), but its two remote-rewrite
// helpers read `getPlexConfig()` / `getJellyfinConfig()` with NO argument — the
// DEFAULT server. A fix-match against a named instance therefore read the RIGHT
// row and then rewrote the WRONG server, replaying a ratingKey that belongs to
// the named server against the default one. Plex ratingKeys are small
// server-local integers, so that is a wrong-item remap on a live library, not a
// harmless no-op. Every "goes to the remote origin, with the remote token" pin
// below exists for that bug; the three sibling GET routes were instance-blind in
// the milder direction (an unscoped findFirst let an arbitrary instance's row
// win, and their Plex calls were likewise default-only).
//
// Division of labour with the leaf-module suites (owned elsewhere, NOT re-pinned):
//   - tests/plex-config.test.mts / tests/jellyfin-config.test.mts OWN the
//     slug → Setting-key derivation. Here we pin that these routes PASS the slug
//     (both files' headers already name fix-match as the consumer that "can never
//     drift onto different servers" — this is the behavioural half of that claim).
//   - tests/media-instances.test.mts OWNS isValidMediaInstanceSlug. Here we pin
//     that each route runs it and 400s.
//   - tests/api-auth.test.mts OWNS the wrapper matrix. Here we spot-check that
//     withIssueAdmin fronts these routes (guardrail 6a).
//
// Mechanics: globalThis.prisma is a recording fake seeded BEFORE the module
// graph loads (the admin-routes.test.mts idiom); fetch is scripted per test and
// records url + headers so a pin can assert the CREDENTIAL as well as the
// origin; every Plex/Jellyfin URL is an RFC1918 IP literal so
// safeFetchAdminConfigured's SSRF stack short-circuits on isIP with no lookup.
// TMDB_READ_TOKEN is deliberately unset ⇒ tmdbAuth() is null ⇒ zero TMDB fetches.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// require time and throws an invariant when it's absent (its server preamble
// normally sets it). Needed for the synthetic request scope the thumb route
// requires — see inScope below.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "fix-match-routes-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
delete process.env.TMDB_READ_TOKEN; // tmdbAuth() → null ⇒ no TMDB egress at all

// ── console capture (guardrail 7: warn/error only) ──────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── collapse the long fix-match sleeps ───────────────────────────────────────
// fixPlexMatch sleeps 3s after unmatch and polls at 3s; fixJellyfinMatch polls at
// 5s. Those are real setTimeout calls, so a faithful run would take ~7s per Plex
// test. Collapse only the multi-second waits — sub-second timers (the flush
// helper, anything the session path uses) keep their real delay, and safe-fetch's
// timeouts ride AbortSignal.timeout, which this does not touch.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
  realSetTimeout(fn, typeof ms === "number" && ms >= 1_000 ? 1 : ms, ...rest)) as typeof setTimeout;

// ── scripted fetch ───────────────────────────────────────────────────────────
type FetchCall = { url: URL; method: string; headers: Record<string, string> };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL, method: string) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  // safe-fetch may hand us a plain object or a Headers instance depending on the
  // call site; normalize both to a lowercase-keyed record.
  const headers: Record<string, string> = {};
  for (const [k, v] of new Headers((init?.headers ?? {}) as HeadersInit)) headers[k.toLowerCase()] = v;
  const method = init?.method ?? "GET";
  fetchCalls.push({ url, method, headers });
  return respond(url, method);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── server fixtures (RFC1918 ⇒ admin SSRF mode, isIP short-circuit, no DNS) ──
const PLEX_DEFAULT = "http://10.88.0.1:32400";
const PLEX_REMOTE = "http://10.88.0.9:32400";
const JF_DEFAULT = "http://10.88.0.2:8096";
const JF_REMOTE = "http://10.88.0.10:8096";
const TOKEN_DEFAULT = "plex-token-default";
const TOKEN_REMOTE = "plex-token-remote";
const KEY_DEFAULT = "jf-key-default";
const KEY_REMOTE = "jf-key-remote";

// ── recording fake prisma (seeded on globalThis before the module graph) ─────
type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  purgedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string; deviceLabel: string | null; createdAt: Date }>();

const settings = new Map<string, string>();
const settingReads: string[] = [];

type LibRow = { tmdbId: number; mediaType: string; serverInstance: string; filePath: string | null; plexRatingKey?: string; jellyfinItemId?: string };
const plexRows: LibRow[] = [];
const jellyfinRows: LibRow[] = [];

const tmdbCacheRows = new Map<string, string>();

// Every prisma/tx op, in order — the where-clauses ARE the contract here.
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

const auditRows: Array<Record<string, unknown>> = [];

// Filters an in-memory library table by a prisma-style where clause. An ABSENT
// serverInstance key means "any instance" — which is precisely the pre-fix
// behaviour the GET routes had, so an unscoped query still returns a row here
// and the test has to assert on the WHERE, not just on the result.
function matchRows(rows: LibRow[], where: { tmdbId: number; mediaType: string; serverInstance?: string }): LibRow[] {
  return rows.filter((r) =>
    r.tmdbId === where.tmdbId &&
    r.mediaType === where.mediaType &&
    (where.serverInstance === undefined || r.serverInstance === where.serverInstance));
}

function libraryDelegate(name: "plexLibraryItem" | "jellyfinLibraryItem", rows: LibRow[]) {
  return {
    findFirst: async (args: { where: { tmdbId: number; mediaType: string; serverInstance?: string } }) => {
      rec(`${name}.findFirst`, args);
      return matchRows(rows, args.where)[0] ?? null;
    },
    findMany: async (args: { where: { tmdbId: number; mediaType: string; serverInstance?: string } }) => {
      rec(`${name}.findMany`, args);
      return matchRows(rows, args.where)
        .slice()
        .sort((a, b) => a.serverInstance.localeCompare(b.serverInstance))
        .map((r) => ({ serverInstance: r.serverInstance, filePath: r.filePath }));
    },
  };
}

function makeTx() {
  const libTx = (name: "plexLibraryItem" | "jellyfinLibraryItem") => ({
    delete: async (args: unknown) => { rec(`${name}.delete`, args); return {}; },
    upsert: async (args: unknown) => { rec(`${name}.upsert`, args); return {}; },
  });
  return {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rec("$executeRaw", { sql: strings.join("?"), values });
      return 0;
    },
    plexLibraryItem: libTx("plexLibraryItem"),
    jellyfinLibraryItem: libTx("jellyfinLibraryItem"),
    tVEpisodeCache: {
      deleteMany: async (args: unknown) => { rec("tVEpisodeCache.deleteMany", args); return { count: 0 }; },
      createMany: async (args: unknown) => { rec("tVEpisodeCache.createMany", args); return { count: 0 }; },
    },
  };
}

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) => {
      const row = authSessionsById.get(args.where.sessionId);
      return row
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, userId: row.userId, deviceLabel: row.deviceLabel }
        : null;
    },
    update: async () => ({}), // lastSeenAt fire-and-forget touch
  },
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      settingReads.push(args.where.key);
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
  tmdbCache: {
    findUnique: async (args: { where: { key: string } }) => {
      const data = tmdbCacheRows.get(args.where.key);
      return data === undefined ? null : { key: args.where.key, data };
    },
  },
  plexLibraryItem: libraryDelegate("plexLibraryItem", plexRows),
  jellyfinLibraryItem: libraryDelegate("jellyfinLibraryItem", jellyfinRows),
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => { auditRows.push(args.data); return args.data; },
  },
  $transaction: async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (t: unknown) => Promise<unknown>)(makeTx());
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── synthetic request scope (the thumb route reads next/headers) ─────────────
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

function inScope<T>(headerInit: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/fix-match-routes.test", forceStatic: false, dynamicShouldError: false };
  const reqHeaders = new Headers(headerInit);
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

// ── dynamic imports (env + globalThis stubs must precede the module graph) ───
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { Permission } = await import("../src/lib/permissions.ts");

const { POST: fixMatch } = await import("../src/app/api/admin/fix-match/route.ts");
const { GET: candidates } = await import("../src/app/api/admin/fix-match/candidates/route.ts");
const { GET: fileInfo } = await import("../src/app/api/admin/fix-match/file-info/route.ts");
const { GET: thumb } = await import("../src/app/api/admin/fix-match/thumb/route.ts");

type Req = InstanceType<typeof NextRequest>;

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

// Mint a real signed session JWT backed by an in-memory User + AuthSession row.
// Bearer transport: skips the UA-fingerprint check and the sliding Set-Cookie;
// the DB-checked auth still runs in full.
async function mintSession(role: string, perms: bigint): Promise<{ userId: string; header: Record<string, string> }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: perms, name: `Actor ${seq}`, email: "actor@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, purgedAt: null,
  });
  authSessionsById.set(sessionId, { userId, deviceLabel: "actor-device", createdAt: new Date() });
  const token = await signSessionJwt(
    { id: userId, role, permissions: perms.toString(), provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { userId, header: { authorization: `Bearer ${token}` } };
}

const admin = () => mintSession("ADMIN", 0n);
const issueAdmin = () => mintSession("ISSUE_ADMIN", Permission.MANAGE_ISSUES);
const plainUser = () => mintSession("USER", 0n);

function req(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Req {
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

const flush = () => new Promise((r) => realSetTimeout(r, 5));

// Configure one or both Plex/Jellyfin instances. Named slugs capitalize —
// plexRemoteServerUrl / jellyfinRemoteApiKey — which is exactly the derivation
// getPlexConfig/getJellyfinConfig do and the whole point of threading the slug.
function configureServers() {
  settings.set("plexServerUrl", PLEX_DEFAULT);
  settings.set("plexAdminToken", TOKEN_DEFAULT);
  settings.set("plexRemoteServerUrl", PLEX_REMOTE);
  settings.set("plexRemoteAdminToken", TOKEN_REMOTE);
  settings.set("jellyfinUrl", JF_DEFAULT);
  settings.set("jellyfinApiKey", KEY_DEFAULT);
  settings.set("jellyfinRemoteUrl", JF_REMOTE);
  settings.set("jellyfinRemoteApiKey", KEY_REMOTE);
}

const origins = () => [...new Set(fetchCalls.map((c) => c.url.origin))];

beforeEach(() => {
  ops = [];
  fetchCalls.length = 0;
  settingReads.length = 0;
  auditRows.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  tmdbCacheRows.clear();
  plexRows.length = 0;
  jellyfinRows.length = 0;
  respond = (url) => { throw new Error(`unexpected fetch ${url}`); };
});

// ── scripted upstreams ───────────────────────────────────────────────────────

// The whole Plex remap conversation for one ratingKey, hosted at `base`: unmatch,
// clean/bundles, match, refresh, then a confirmation poll that reports the target
// tmdb guid. Anything hitting a DIFFERENT origin throws — the trap under test is
// a call landing on the wrong server, so a wrong origin must fail loudly rather
// than quietly return a plausible body.
function plexRemapResponder(base: string, ratingKey: string, confirmTmdbId: number) {
  return (url: URL): Response => {
    if (url.origin !== new URL(base).origin) {
      throw new Error(`WRONG SERVER: ${url.origin} (expected ${new URL(base).origin})`);
    }
    const p = url.pathname;
    if (p === `/library/metadata/${ratingKey}/unmatch`) return new Response("", { status: 200 });
    if (p === "/library/clean/bundles") return new Response("", { status: 200 });
    if (p === `/library/metadata/${ratingKey}/match`) return new Response("", { status: 200 });
    if (p === `/library/metadata/${ratingKey}/refresh`) return new Response("", { status: 200 });
    if (p === `/library/metadata/${ratingKey}`) {
      return okJson({ MediaContainer: { Metadata: [{ guid: `plex://movie/abc`, Guid: [{ id: `tmdb://${confirmTmdbId}` }] }] } });
    }
    throw new Error(`unexpected Plex path ${p}`);
  };
}

// The Jellyfin counterpart: remote-search → apply → refresh → confirming re-read.
function jellyfinRemapResponder(base: string, itemId: string, confirmTmdbId: number) {
  return (url: URL): Response => {
    if (url.origin !== new URL(base).origin) {
      throw new Error(`WRONG SERVER: ${url.origin} (expected ${new URL(base).origin})`);
    }
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: String(confirmTmdbId) }, Name: "Correct Title" }]);
    if (p === `/Items/${itemId}/Refresh`) return new Response("", { status: 200 });
    if (p === `/Items/${itemId}`) return okJson({ ProviderIds: { Tmdb: String(confirmTmdbId) } });
    throw new Error(`unexpected Jellyfin path ${p}`);
  };
}

function postBody(body: Record<string, unknown>, headers: Record<string, string>): Req {
  return req("http://localhost:3000/api/admin/fix-match", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// THE HEADLINE — the remote rewrite lands on the instance the caller named
// ════════════════════════════════════════════════════════════════════════════

test("POST serverInstance:'remote' (plex): every upstream call goes to the REMOTE server with the REMOTE token", async () => {
  // Reintroducing the bug (dropping the arg from getPlexConfig(instance) in
  // fixPlexMatch) makes the responder throw WRONG SERVER on the very first
  // unmatch → the route 502s and this fails on the status line alone.
  const a = await admin();
  configureServers();
  // Same tmdbId on BOTH servers with DIFFERENT ratingKeys — the exact shape that
  // makes a mis-routed remap corrupt an unrelated item rather than no-op.
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Correct Title", releaseYear: "2019" }));
  respond = plexRemapResponder(PLEX_REMOTE, "2002", 222);

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz", serverInstance: "remote" },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(origins(), [new URL(PLEX_REMOTE).origin], "every Plex call must hit the named server, none the default");
  assert.ok(fetchCalls.length >= 4, `expected the full remap conversation, saw ${fetchCalls.length} calls`);
  // The credential, not just the origin: a default-server token replayed at the
  // remote host would 401 in production but still "look" correctly routed here.
  for (const c of fetchCalls) {
    assert.equal(c.headers["x-plex-token"], TOKEN_REMOTE, `${c.url.pathname} carried the wrong Plex token`);
  }
  // The instance's ratingKey, never the default instance's.
  assert.ok(fetchCalls.every((c) => !c.url.pathname.includes("/1001")), "the DEFAULT server's ratingKey must never appear in a remote URL");
  assert.ok(fetchCalls.some((c) => c.url.pathname === "/library/metadata/2002/unmatch"));
  // Setting-key derivation reached plex-config with the slug.
  assert.ok(settingReads.includes("plexRemoteServerUrl") && settingReads.includes("plexRemoteAdminToken"));
  assert.ok(!settingReads.includes("plexServerUrl"), "the default server's config must not even be read");
});

test("POST serverInstance:'remote' (jellyfin): every upstream call goes to the REMOTE server with the REMOTE api key", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", jellyfinItemId: "bbbbbbbb" });
  respond = jellyfinRemapResponder(JF_REMOTE, "bbbbbbbb", 222);

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, serverInstance: "remote" },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(origins(), [new URL(JF_REMOTE).origin]);
  for (const c of fetchCalls) {
    assert.equal(c.headers["x-mediabrowser-token"], KEY_REMOTE, `${c.url.pathname} carried the wrong Jellyfin key`);
  }
  assert.ok(fetchCalls.every((c) => !c.url.pathname.includes("aaaaaaaa")), "the DEFAULT server's item id must never appear in a remote URL");
  assert.ok(settingReads.includes("jellyfinRemoteUrl") && settingReads.includes("jellyfinRemoteApiKey"));
  assert.ok(!settingReads.includes("jellyfinUrl"), "the default server's config must not even be read");
});

// ════════════════════════════════════════════════════════════════════════════
// The DB half — existing behaviour, pinned so a refactor can't regress it
// ════════════════════════════════════════════════════════════════════════════

test("POST reads and rewrites the COMPOUND-KEY row for the named instance only", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  respond = plexRemapResponder(PLEX_REMOTE, "2002", 222);

  await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz", serverInstance: "remote" },
    a.header,
  ), undefined);

  const read = opsOf("plexLibraryItem.findFirst")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(read.where, { tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote" });

  const del = opsOf("plexLibraryItem.delete")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(del.where, { tmdbId_mediaType_serverInstance: { tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote" } });

  const up = opsOf("plexLibraryItem.upsert")[0].args as { where: Record<string, unknown>; create: Record<string, unknown> };
  assert.deepEqual(up.where, { tmdbId_mediaType_serverInstance: { tmdbId: 222, mediaType: "MOVIE", serverInstance: "remote" } });
  assert.equal(up.create.serverInstance, "remote");
  assert.equal(up.create.plexRatingKey, "2002", "the corrected row must carry the NAMED server's rating key");

  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "FIX_MATCH");
  // audit.ts stores `details` as a JSON string.
  const details = JSON.parse(auditRows[0].details as string) as { source: string; serverInstance: string };
  assert.equal(details.serverInstance, "remote");
  assert.equal(details.source, "plex");
});

test("POST rejects an invalid serverInstance with 400 before touching the DB or the network", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, serverInstance: "Not A Slug!" },
    a.header,
  ), undefined);

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid serverInstance/);
  assert.equal(fetchCalls.length, 0);
  assert.equal(opsOf("plexLibraryItem.findFirst").length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Backward compatibility — omitting serverInstance is today's behaviour
// ════════════════════════════════════════════════════════════════════════════

test("POST with NO serverInstance targets the default server (plex): default row, default origin, default token", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  respond = plexRemapResponder(PLEX_DEFAULT, "1001", 222);

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(origins(), [new URL(PLEX_DEFAULT).origin]);
  for (const c of fetchCalls) assert.equal(c.headers["x-plex-token"], TOKEN_DEFAULT);
  assert.ok(settingReads.includes("plexServerUrl") && settingReads.includes("plexAdminToken"));
  assert.ok(!settingReads.some((k) => k.startsWith("plexRemote")), "no named-instance Setting key may be read");
  const read = opsOf("plexLibraryItem.findFirst")[0].args as { where: Record<string, unknown> };
  assert.equal(read.where.serverInstance, "", "an absent body field must resolve to the default slug, not to 'any instance'");
});

test("POST with NO serverInstance targets the default server (jellyfin)", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", jellyfinItemId: "bbbbbbbb" });
  respond = jellyfinRemapResponder(JF_DEFAULT, "aaaaaaaa", 222);

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(origins(), [new URL(JF_DEFAULT).origin]);
  for (const c of fetchCalls) assert.equal(c.headers["x-mediabrowser-token"], KEY_DEFAULT);
  assert.ok(!settingReads.some((k) => k.startsWith("jellyfinRemote")));
});

// ════════════════════════════════════════════════════════════════════════════
// Apply-timeout tolerance (jellyfin) — Jellyfin runs the identify's FullRefresh
// synchronously INSIDE the Apply request with CancellationToken.None, so a
// client-side timeout means "still working", not "failed". The route must keep
// polling on that signal, defer the extra image refresh until confirmation, and
// when even the extended window expires, say "still processing" rather than
// implying a revert.
// ════════════════════════════════════════════════════════════════════════════

// The same TimeoutError shape undici's AbortSignal.timeout produces, which
// safe-fetch maps to SafeFetchError("timeout").
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

test("POST (jellyfin): apply timeout → extended poll confirms → 200, DB written, image refresh deferred until after confirmation", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });

  let checks = 0;
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) throw timeoutError();
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    if (p === "/Items/aaaaaaaa") {
      checks++;
      // Old id for the first five polls — past the NORMAL path's 4-attempt
      // window, so a pass here proves the extended window did the confirming.
      return okJson({ ProviderIds: { Tmdb: checks <= 5 ? "111" : "222" } });
    }
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(checks >= 6, `the poll must continue past the normal 4-attempt window (got ${checks} checks)`);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 1, "the DB rewrite must land once confirmed");
  assert.ok(warns.some((w) => w.includes("apply timed out client-side")), "the timeout must be surfaced as a warn, not swallowed silently");
  // The image refresh is deferred: exactly one, and only AFTER a confirming read.
  const calls = fetchCalls.map((c) => c.url.pathname);
  const refreshCalls = calls.filter((p) => p === "/Items/aaaaaaaa/Refresh");
  assert.equal(refreshCalls.length, 1, "exactly one deferred image refresh");
  assert.ok(
    calls.indexOf("/Items/aaaaaaaa/Refresh") > calls.indexOf("/Items/aaaaaaaa"),
    "the image refresh must fire only after confirmation, never while the server is mid-apply",
  );
});

test("POST (jellyfin): apply timeout that never confirms → 502, NO DB write, NO extra refresh, still-processing error", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });

  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) throw timeoutError();
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa") return okJson({ ProviderIds: { Tmdb: "111" } }); // never flips
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 502);
  assert.equal(opsOf("jellyfinLibraryItem.delete").length, 0, "an unconfirmed match must not touch the DB");
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0);
  assert.ok(fetchCalls.every((c) => !c.url.pathname.endsWith("/Refresh")), "no refresh may be queued on a box that is already mid-apply");
  assert.ok(errors.some((e) => e.includes("still processing the match")), "the failure must say the server is still working, not imply a revert");
});

// ════════════════════════════════════════════════════════════════════════════
// candidates
// ════════════════════════════════════════════════════════════════════════════

function candidatesUrl(params: Record<string, string>): string {
  return `http://localhost:3000/api/admin/fix-match/candidates?${new URLSearchParams(params)}`;
}

test("candidates?serverInstance=remote: scopes the library reads and searches the REMOTE Plex", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  respond = (url) => {
    if (url.origin !== new URL(PLEX_REMOTE).origin) throw new Error(`WRONG SERVER: ${url.origin}`);
    return okJson({ MediaContainer: { SearchResult: [{ guid: "plex://movie/cand", name: "Cand", year: 2019, Guid: [{ id: "tmdb://222" }] }] } });
  };

  const res = await candidates(req(candidatesUrl({
    server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "remote",
  }), { headers: a.header }), undefined);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ratingKey, "2002", "the NAMED instance's row must win the findFirst");
  assert.equal(body.serverInstance, "remote", "the response echoes the instance so the POST can target the same server");
  assert.deepEqual(origins(), [new URL(PLEX_REMOTE).origin]);
  for (const c of fetchCalls) assert.equal(c.headers["x-plex-token"], TOKEN_REMOTE);

  const plexRead = opsOf("plexLibraryItem.findFirst")[0].args as { where: Record<string, unknown> };
  assert.equal(plexRead.where.serverInstance, "remote");
  // The sibling Jellyfin lookup is deliberately NOT scoped by this slug: it
  // names the PLEX server, and the two sides of a bad match are independent
  // instances (bad-matches.ts pairs rows by relative path across every
  // configured server, each side carrying its own serverInstance). See the
  // cross-instance pin below.
  const jfRead = opsOf("jellyfinLibraryItem.findMany")[0].args as { where: Record<string, unknown> };
  assert.equal(jfRead.where.serverInstance, undefined, "the Jellyfin path hint must not be scoped by the PLEX slug");
});

test("candidates: the Jellyfin path hint crosses instances — a bad match straddling two servers still names both files", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  // Jellyfin holds the same tmdbId on the DEFAULT server only — exactly the
  // shape bad-matches.ts emits when one server's row is wrong and the other's
  // isn't. Scoping this read with the Plex slug ("remote") reported null here,
  // blanking the comparison the admin opened the picker to make.
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/jf-def.mkv", jellyfinItemId: "aaaaaaaa" });
  respond = (url) => {
    if (url.origin !== new URL(PLEX_REMOTE).origin) throw new Error(`WRONG SERVER: ${url.origin}`);
    return okJson({ MediaContainer: { SearchResult: [] } });
  };

  const res = await candidates(req(candidatesUrl({
    server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "remote",
  }), { headers: a.header }), undefined);

  assert.equal(res.status, 200);
  const body = await res.json();
  // The PLEX side stays strictly scoped — it carries the ratingKey the POST
  // rewrites, so a cross-server read there would remap the wrong library.
  assert.equal(body.plexFilePath, "/d/rem.mkv");
  assert.equal(body.jellyfinFilePath, "/d/jf-def.mkv");
});

test("candidates: when several Jellyfin servers hold the title, the REQUESTED instance still wins", async () => {
  // Preference, not a free-for-all: every answer the old scoped read produced
  // must survive unchanged, so widening can only ever turn a null into a path.
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/jf-def.mkv", jellyfinItemId: "aaaaaaaa" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/jf-rem.mkv", jellyfinItemId: "bbbbbbbb" });
  respond = () => okJson({ MediaContainer: { SearchResult: [] } });

  const res = await candidates(req(candidatesUrl({
    server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "remote",
  }), { headers: a.header }), undefined);

  assert.equal((await res.json()).jellyfinFilePath, "/d/jf-rem.mkv");
});

test("candidates with NO serverInstance uses the DEFAULT instance's row + server", async () => {
  const a = await admin();
  configureServers();
  // Deliberately ordered named-first: an unscoped findFirst would return "remote"
  // here, so this also pins that the route no longer lets an arbitrary row win.
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/jf.mkv", jellyfinItemId: "aaaaaaaa" });
  respond = (url) => {
    if (url.origin !== new URL(PLEX_DEFAULT).origin) throw new Error(`WRONG SERVER: ${url.origin}`);
    return okJson({ MediaContainer: { SearchResult: [] } });
  };

  const res = await candidates(req(candidatesUrl({
    server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222",
  }), { headers: a.header }), undefined);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ratingKey, "1001");
  assert.equal(body.serverInstance, "");
  assert.equal(body.plexFilePath, "/d/def.mkv");
  // Single-server shape (every row on ""): byte-identical to the pre-multi-server
  // response, including the Jellyfin hint (guardrail 35).
  assert.equal(body.jellyfinFilePath, "/d/jf.mkv");
  assert.deepEqual(origins(), [new URL(PLEX_DEFAULT).origin]);
});

test("candidates rejects an invalid serverInstance with 400 and reads no library row", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });

  const res = await candidates(req(candidatesUrl({
    server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "BAD SLUG",
  }), { headers: a.header }), undefined);

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid serverInstance/);
  assert.equal(opsOf("plexLibraryItem.findFirst").length, 0);
  assert.equal(fetchCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// file-info
// ════════════════════════════════════════════════════════════════════════════

function fileInfoUrl(params: Record<string, string>): string {
  return `http://localhost:3000/api/admin/fix-match/file-info?${new URLSearchParams(params)}`;
}

test("file-info?serverInstance=remote: paths come from the named instance, and every holder is enumerated", async () => {
  const a = await issueAdmin();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/jf-rem.mkv", jellyfinItemId: "bbbbbbbb" });

  const res = await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE", serverInstance: "remote" }), { headers: a.header }), undefined);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plexFilePath, "/d/rem.mkv");
  assert.equal(body.jellyfinFilePath, "/d/jf-rem.mkv");
  assert.equal(body.plexServerInstance, "remote");
  assert.equal(body.jellyfinServerInstance, "remote");
  // The enumeration is what lets the issue dialog thread an instance it was
  // never handed — it starts from a tmdbId with no library row in hand.
  assert.deepEqual(body.plexInstances, [
    { serverInstance: "", filePath: "/d/def.mkv" },
    { serverInstance: "remote", filePath: "/d/rem.mkv" },
  ]);
  assert.deepEqual(body.jellyfinInstances, [{ serverInstance: "remote", filePath: "/d/jf-rem.mkv" }]);

  const scoped = opsOf("plexLibraryItem.findFirst")[0].args as { where: Record<string, unknown> };
  assert.equal(scoped.where.serverInstance, "remote");
  const enumerated = opsOf("plexLibraryItem.findMany")[0].args as { where: Record<string, unknown> };
  assert.equal(enumerated.where.serverInstance, undefined, "the enumeration is deliberately cross-instance");
});

test("file-info with NO serverInstance resolves the default instance and reports a null side honestly", async () => {
  const a = await issueAdmin();
  // Named-first ordering again: an unscoped findFirst would surface /d/rem.mkv.
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/jf-rem.mkv", jellyfinItemId: "bbbbbbbb" });

  const res = await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE" }), { headers: a.header }), undefined);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plexFilePath, "/d/def.mkv");
  assert.equal(body.plexServerInstance, "");
  // Jellyfin holds it only on "remote", which the caller didn't ask for — so the
  // path is null, but the picker still learns where it lives.
  assert.equal(body.jellyfinFilePath, null);
  assert.equal(body.jellyfinServerInstance, null);
  assert.deepEqual(body.jellyfinInstances, [{ serverInstance: "remote", filePath: "/d/jf-rem.mkv" }]);
});

test("file-info on a single-server deployment is byte-identical to the pre-multi-server response", async () => {
  const a = await issueAdmin();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/jf.mkv", jellyfinItemId: "aaaaaaaa" });

  const res = await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE" }), { headers: a.header }), undefined);
  const body = await res.json();
  // The four legacy fields keep their exact old values; the rest is additive.
  assert.equal(body.plexFilePath, "/d/def.mkv");
  assert.equal(body.jellyfinFilePath, "/d/jf.mkv");
  assert.equal(body.arrTmdbId, null);
  assert.equal(body.arrTitle, null);
  assert.equal(fetchCalls.length, 0, "no Radarr/Sonarr configured ⇒ no egress");
});

test("file-info rejects an invalid serverInstance with 400 and reads no library row", async () => {
  const a = await issueAdmin();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });

  const res = await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE", serverInstance: "BAD SLUG" }), { headers: a.header }), undefined);

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid serverInstance/);
  assert.equal(opsOf("plexLibraryItem.findFirst").length, 0);
  assert.equal(opsOf("plexLibraryItem.findMany").length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// thumb (binary/plain-text route — inline requireAuth, so it needs a scope)
// ════════════════════════════════════════════════════════════════════════════

function thumbUrl(params: Record<string, string>): string {
  return `http://localhost:3000/api/admin/fix-match/thumb?${new URLSearchParams(params)}`;
}

const PNG = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });

test("thumb?serverInstance=remote: a relative thumb path is proxied off the REMOTE Plex", async () => {
  const a = await admin();
  configureServers();
  respond = (url) => {
    if (url.origin !== new URL(PLEX_REMOTE).origin) throw new Error(`WRONG SERVER: ${url.origin}`);
    return PNG.clone();
  };

  const res = await inScope(a.header, () =>
    thumb(req(thumbUrl({ path: "/library/metadata/2002/thumb/17", serverInstance: "remote" }), { headers: a.header })));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(origins(), [new URL(PLEX_REMOTE).origin]);
  assert.equal(fetchCalls[0].headers["x-plex-token"], TOKEN_REMOTE);
  assert.ok(settingReads.includes("plexRemoteServerUrl"));
  assert.ok(!settingReads.includes("plexServerUrl"));
});

test("thumb with NO serverInstance proxies off the DEFAULT Plex", async () => {
  const a = await admin();
  configureServers();
  respond = (url) => {
    if (url.origin !== new URL(PLEX_DEFAULT).origin) throw new Error(`WRONG SERVER: ${url.origin}`);
    return PNG.clone();
  };

  const res = await inScope(a.header, () =>
    thumb(req(thumbUrl({ path: "/library/metadata/1001/thumb/17" }), { headers: a.header })));

  assert.equal(res.status, 200);
  assert.deepEqual(origins(), [new URL(PLEX_DEFAULT).origin]);
  assert.equal(fetchCalls[0].headers["x-plex-token"], TOKEN_DEFAULT);
  assert.ok(!settingReads.some((k) => k.startsWith("plexRemote")));
});

test("thumb rejects an invalid serverInstance with 400 before reading any Plex config", async () => {
  const a = await admin();
  configureServers();

  const res = await inScope(a.header, () =>
    thumb(req(thumbUrl({ path: "/library/metadata/1/thumb/1", serverInstance: "BAD SLUG" }), { headers: a.header })));

  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Invalid serverInstance");
  assert.equal(settingReads.length, 0);
  assert.equal(fetchCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Authorization fronting (guardrail 6a) — spot-checked, not re-enumerated
// ════════════════════════════════════════════════════════════════════════════

test("all four routes: no session → 401, a plain USER → 403, and nothing is read or rewritten", async () => {
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  const u = await plainUser();

  const anon: Array<{ status: number }> = [
    await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, serverInstance: "remote" }, {}), undefined),
    await candidates(req(candidatesUrl({ server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222" })), undefined),
    await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE" })), undefined),
    await inScope({}, () => thumb(req(thumbUrl({ path: "/library/metadata/1/thumb/1" })))),
  ];
  for (const r of anon) assert.equal(r.status, 401);

  const forbidden: Array<{ status: number }> = [
    await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, serverInstance: "remote" }, u.header), undefined),
    await candidates(req(candidatesUrl({ server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222" }), { headers: u.header }), undefined),
    await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE" }), { headers: u.header }), undefined),
    await inScope(u.header, () => thumb(req(thumbUrl({ path: "/library/metadata/1/thumb/1" }), { headers: u.header }))),
  ];
  for (const r of forbidden) assert.equal(r.status, 403);

  assert.equal(fetchCalls.length, 0, "no upstream call may escape for an unauthorized caller");
  assert.equal(opsOf("plexLibraryItem.findFirst").length, 0, "no handler body may run for an unauthorized caller");
  assert.equal(opsOf("plexLibraryItem.upsert").length, 0);
});
