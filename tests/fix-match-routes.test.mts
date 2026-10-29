// Route-level unit tests for the five /api/admin/fix-match handlers (the POST
// plus the candidates, file-info, thumb and status GETs). They are invoked
// directly with constructed NextRequests + a REAL signed session; no DB, no
// network, no DNS.
//
// THE HEADLINE — the multi-server trap. The POST route already read and wrote
// the library row for the `serverInstance` named in the body (findFirst and
// deleteMany by `{ tmdbId, mediaType, serverInstance }`, upsert on the
// `tmdbId_mediaType_serverInstance` compound key), but its two remote-rewrite
// helpers used to call `getPlexConfig()` / `getJellyfinConfig()` with NO
// argument — i.e. the DEFAULT server. A fix-match against a named instance
// therefore read the RIGHT row and then rewrote the WRONG server, replaying a
// ratingKey that belongs to the named server against the default one. Plex
// ratingKeys are small per-server integers, so that remaps an unrelated item on
// a live library rather than doing nothing. Every "goes to the remote origin,
// with the remote token" pin below exists for that bug. The GET routes had a
// milder version: an unscoped findFirst let any instance's row win, and their
// Plex calls also went to the default server only.
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

type LibRow = { tmdbId: number; mediaType: string; serverInstance: string; filePath: string | null; plexRatingKey?: string; plexRatingKeys?: string[]; jellyfinItemId?: string; jellyfinItemIds?: string[] };
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

// Per-test knob for the post-remap tx's "does any OTHER instance still hold
// the old tmdbId" count (guardrail 35: TVEpisodeCache has no serverInstance
// column, so the old-id episode purge must be skipped while another server's
// legitimate rows share the namespace). Default 0 = sole holder.
let otherInstanceHolders = 0;
// Per-test knob for the tx's read of the TARGET (corrected-id) row — the
// pre-existing copy whose `jellyfinItemIds` the upsert must MERGE, not replace.
let existingTargetRow: Record<string, unknown> | null = null;
// Per-test knob for the tx's read of the OLD-id row being removed (tmdbId 111 in
// these tests) — its descriptive columns must carry over to the corrected row.
let removedRow: Record<string, unknown> | null = null;
// Per-test knob: make the DB phase fail AFTER the remote remap landed.
let txThrows = false;
// Per-test knob for item mode (the library match check's Fix): the rows the
// tx finds holding the remapped item's key.
let itemHolders: Array<Record<string, unknown>> = [];

function makeTx() {
  const libTx = (name: "plexLibraryItem" | "jellyfinLibraryItem") => ({
    // `delete` THROWS a P2025-shaped error on purpose: the confirmation poll
    // runs unlocked for minutes, so by the time the tx opens a library sync may
    // already have reconciled the old-id row away. Prisma's `delete` on a
    // missing unique row is not a no-op — it throws — which turned a landed
    // remap into a 502 / failed job. The route must use `deleteMany`; any
    // regression back to `delete` fails every POST test in this file.
    delete: async (args: unknown) => {
      rec(`${name}.delete`, args);
      throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
    },
    deleteMany: async (args: unknown) => { rec(`${name}.deleteMany`, args); return { count: 0 }; },
    count: async (args: unknown) => { rec(`${name}.count`, args); return otherInstanceHolders; },
    findUnique: async (args: unknown) => {
      rec(`${name}.findUnique`, args);
      const k = (args as { where: { tmdbId_mediaType_serverInstance?: { tmdbId: number } } }).where.tmdbId_mediaType_serverInstance;
      return k?.tmdbId === 111 ? removedRow : existingTargetRow;
    },
    upsert: async (args: unknown) => { rec(`${name}.upsert`, args); return {}; },
    findMany: async (args: unknown) => { rec(`${name}.findMany`, args); return itemHolders; },
    create: async (args: unknown) => { rec(`${name}.create`, args); return {}; },
    update: async (args: unknown) => { rec(`${name}.update`, args); return {}; },
  });
  return {
    playHistory: { updateMany: async (args: unknown) => { rec("playHistory.updateMany", args); return { count: 0 }; } },
    activeSession: { updateMany: async (args: unknown) => { rec("activeSession.updateMany", args); return { count: 0 }; } },
    // Both call shapes: a tagged template, or one Prisma.sql value (guardrail 23a).
    $executeRaw: async (strings: TemplateStringsArray | { strings: readonly string[]; values: unknown[] }, ...values: unknown[]) => {
      if (Array.isArray(strings)) rec("$executeRaw", { sql: strings.join("?"), values });
      else { const q = strings as { strings: readonly string[]; values: unknown[] }; rec("$executeRaw", { sql: q.strings.join("?"), values: q.values }); }
      return 0;
    },
    setting: {
      findUnique: async (args: { where: { key: string } }) => {
        rec("setting.findUnique", args);
        const value = settings.get(args.where.key);
        return value === undefined ? null : { key: args.where.key, value };
      },
      update: async (args: { where: { key: string }; data: { value: string } }) => {
        rec("setting.update", args);
        settings.set(args.where.key, args.data.value);
        return {};
      },
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
    findMany: async (args: { where: { key: { in: string[] } } }) =>
      args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) as string })),
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
    if (txThrows) throw new Error("tx boom (test knob)");
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
const { GET: fixMatchStatus } = await import("../src/app/api/admin/fix-match/status/route.ts");
const { clearCandidateCache } = await import("../src/lib/fix-match-candidate-cache.ts");
const { GET: fixMatchJobs } = await import("../src/app/api/admin/fix-match/jobs/route.ts");

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
  clearCandidateCache();
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
  otherInstanceHolders = 0;
  existingTargetRow = null;
  removedRow = null;
  txThrows = false;
  itemHolders = [];
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

test("POST (plex, MOVIE): plays and live sessions recorded under the wrong id are re-attributed IN the tx, scoped to source + instance + the remapped ratingKey", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Correct Title", releaseYear: "2019" }));
  respond = plexRemapResponder(PLEX_REMOTE, "2002", 222);

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz", serverInstance: "remote" },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);

  // Never by tmdbId alone: another server may legitimately hold the old id
  // (guardrail 35). A movie play's sourceItemId IS the item's ratingKey.
  const expectedWhere = { source: "plex", serverInstance: "remote", tmdbId: 111, mediaType: "MOVIE", sourceItemId: { in: ["2002"] } };
  assert.deepEqual(opsOf("playHistory.updateMany")[0]?.args, { where: expectedWhere, data: { tmdbId: 222 } });
  assert.deepEqual(opsOf("activeSession.updateMany")[0]?.args, { where: expectedWhere, data: { tmdbId: 222 } });
  // Ordered INSIDE the transaction: after the row rewrite, before the tx closes.
  const names = ops.map((o) => o.op);
  assert.ok(names.indexOf("plexLibraryItem.upsert") < names.indexOf("playHistory.updateMany"));
  // filePath follows the ratingKey on the update branch too.
  const up = opsOf("plexLibraryItem.upsert")[0].args as { update: Record<string, unknown> };
  assert.deepEqual(up.update, { plexRatingKey: "2002", plexRatingKeys: ["2002"], filePath: "/d/rem.mkv" });
});

test("POST (plex, TV): re-attribution is scoped on the row key (source + instance + mediaType + old tmdbId) — an episode play's sourceItemId is the EPISODE's key, never the show's", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "TV", serverInstance: "", filePath: "/d/show", plexRatingKey: "1001" });
  tmdbCacheRows.set("tv:222:details", JSON.stringify({ title: "Correct Show", releaseYear: "2019" }));
  respond = plexRemapResponder(PLEX_DEFAULT, "1001", 222);

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "TV", correctTmdbId: 222, canonicalGuid: "plex://show/xyz" },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);
  const expectedWhere = { source: "plex", serverInstance: "", tmdbId: 111, mediaType: "TV" };
  assert.deepEqual(opsOf("playHistory.updateMany")[0]?.args, { where: expectedWhere, data: { tmdbId: 222 } });
  assert.deepEqual(opsOf("activeSession.updateMany")[0]?.args, { where: expectedWhere, data: { tmdbId: 222 } });
});

test("POST (plex): when the unmatch landed but Plex never confirms a re-match, the error names the UNMATCHED state (not the generic no-op failure) and nothing is written", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Correct Title", releaseYear: "2019" }));
  // Unmatch succeeds; every confirmation read keeps reporting the OLD id.
  const confirmWrong = plexRemapResponder(PLEX_DEFAULT, "1001", 111);
  respond = (url) => confirmWrong(url);

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" },
    a.header,
  ), undefined);
  assert.equal(res.status, 502);
  const body = await res.json() as { error: string };
  assert.notEqual(body.error, "Fix-match operation failed", "the generic message implies nothing changed — the item IS unmatched");
  // Before the catalog merge t() falls back to the key; after it, the English text names the state.
  assert.ok(/unmatched/i.test(body.error), `expected the UNMATCHED message, got: ${body.error}`);
  assert.ok(errors.some((e) => e.includes("(PlexUnmatchedError)")), "the dedicated error class reaches the server-side log");
  assert.equal(opsOf("plexLibraryItem.upsert").length, 0, "an unconfirmed match must not touch the DB");
  assert.equal(opsOf("playHistory.updateMany").length, 0);
});

test("POST (plex): remote remap landed but the DB phase failed → 502 cacheUpdateFailed AND a FIX_MATCH audit row with dbUpdated:false", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", plexRatingKey: "1001" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Correct Title", releaseYear: "2019" }));
  respond = plexRemapResponder(PLEX_DEFAULT, "1001", 222);
  txThrows = true;

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" },
    a.header,
  ), undefined);
  assert.equal(res.status, 502);
  const body = await res.json() as { error: string };
  assert.ok(body.error.includes("TMDB #222"), `expected the cache-update-failed message, got: ${body.error}`);
  await flush();
  const audit = auditRows.find((r) => r.action === "FIX_MATCH");
  assert.ok(audit, "a change the library server now carries must reach the audit log even when the cache phase failed");
  const details = JSON.parse(String(audit!.details)) as Record<string, unknown>;
  assert.equal(details.dbUpdated, false);
  assert.equal(details.toTmdbId, 222);
  assert.equal(details.source, "plex");
});

test("POST (jellyfin): the upsert's update branch writes the UNION of the target row's existing jellyfinItemIds and this run's — and re-attributes plays by the copies' ids", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", jellyfinItemId: "aaaaaaaa", jellyfinItemIds: ["aaaaaaaa"] });
  // A correctly matched copy of the TARGET title already holds the row for 222.
  existingTargetRow = { jellyfinItemIds: ["cccccccc"] };
  respond = jellyfinRemapResponder(JF_DEFAULT, "aaaaaaaa", 222);

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);

  const read = opsOf("jellyfinLibraryItem.findUnique").map((o) => o.args as { where: { tmdbId_mediaType_serverInstance: { tmdbId: number } } }).find((a) => a.where.tmdbId_mediaType_serverInstance.tmdbId === 222) as { where: { tmdbId_mediaType_serverInstance: Record<string, unknown> } };
  assert.deepEqual(read.where.tmdbId_mediaType_serverInstance, { tmdbId: 222, mediaType: "MOVIE", serverInstance: "" }, "the TARGET row is read inside the tx");
  const up = opsOf("jellyfinLibraryItem.upsert")[0].args as { create: { jellyfinItemIds: string[] }; update: { jellyfinItemId: string; jellyfinItemIds: string[]; filePath: string | null } };
  assert.deepEqual(up.update.jellyfinItemIds, ["cccccccc", "aaaaaaaa"], "copy C must survive the remap of copy A (guardrail 37)");
  assert.deepEqual(up.create.jellyfinItemIds, ["aaaaaaaa"], "create (no pre-existing row) carries only this run's ids");
  assert.equal(up.update.jellyfinItemId, "aaaaaaaa");
  assert.equal(up.update.filePath, "/d/a.mkv");

  const ph = opsOf("playHistory.updateMany")[0]?.args as { where: { source: string; serverInstance: string; tmdbId: number; mediaType: string; sourceItemId: { in: string[] } }; data: { tmdbId: number } };
  assert.equal(ph.where.source, "jellyfin");
  assert.equal(ph.where.serverInstance, "");
  assert.equal(ph.where.tmdbId, 111);
  assert.ok(ph.where.sourceItemId.in.includes("aaaaaaaa"), "the copy's pre-remap id is what its plays were recorded under");
  assert.deepEqual(ph.data, { tmdbId: 222 });
  assert.equal(opsOf("activeSession.updateMany").length, 1);
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

  const del = opsOf("plexLibraryItem.deleteMany")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(del.where, { tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote" });
  assert.equal(opsOf("plexLibraryItem.delete").length, 0, "the old-id row is removed with a count-insensitive deleteMany, never a throwing delete");

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

// ── review 2026-09 f37: the old-id row may already be gone when the tx opens ──
// The confirm poll holds NO lock and can run for minutes (background mode: up
// to ~10). A library sync landing inside that window rewrites the row under the
// corrected id, so the old-keyed row no longer exists. The tx must tolerate
// that (deleteMany, count 0) and still report ok + still upsert the new row —
// the makeTx `delete` stub throws P2025 so a regression cannot pass this.

test("POST (plex): a remap whose old row was already reconciled by a sync still reports ok and upserts", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", plexRatingKey: "2002" });
  respond = plexRemapResponder(PLEX_REMOTE, "2002", 222);

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz", serverInstance: "remote" },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(opsOf("plexLibraryItem.delete").length, 0);
  assert.equal(opsOf("plexLibraryItem.deleteMany").length, 1);
  assert.equal(opsOf("plexLibraryItem.upsert").length, 1, "the corrected row is still written");
  assert.ok(!warns.some((w) => w.includes("remapped remotely but the DB update failed")), "a landed remap must not be reported as a cache failure");
});

test("POST (jellyfin): a remap whose old row was already reconciled by a sync still reports ok and upserts", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", jellyfinItemId: "bbbbbbbb" });
  respond = jellyfinRemapResponder(JF_REMOTE, "bbbbbbbb", 222);

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, serverInstance: "remote" },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(opsOf("jellyfinLibraryItem.delete").length, 0);
  const del = opsOf("jellyfinLibraryItem.deleteMany")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(del.where, { tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote" });
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 1, "the corrected row is still written");
  assert.ok(!warns.some((w) => w.includes("remapped remotely but the DB update failed")));
});

// ── review 2026-09 f38: the old-id episode purge is instance-aware ───────────
// TVEpisodeCache has no serverInstance column. If ANOTHER server of the same
// type legitimately holds the old tmdbId, purging `{ source, tmdbId }` erases
// that server's episode rows until the next orchestrator run; when this
// instance is the sole holder the purge must still fire (or its stale episodes
// stay attributed to the wrong id for the same hour).

test("POST (plex, TV): old-id episode purge fires when no other instance holds the old id", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "TV", serverInstance: "remote", filePath: "/d/show", plexRatingKey: "2002" });
  otherInstanceHolders = 0;
  respond = (url) => {
    // The post-tx episode re-cache reads /library/metadata/2002/allLeaves; an
    // empty container short-circuits it before any further write.
    if (url.pathname === "/library/metadata/2002/allLeaves") return okJson({ MediaContainer: { Metadata: [] } });
    return plexRemapResponder(PLEX_REMOTE, "2002", 222)(url);
  };

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "TV", correctTmdbId: 222, canonicalGuid: "plex://show/xyz", serverInstance: "remote" },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);

  const cnt = opsOf("plexLibraryItem.count")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(cnt.where, { tmdbId: 111, mediaType: "TV", serverInstance: { not: "remote" } });
  const purges = opsOf("tVEpisodeCache.deleteMany").filter((o) => (o.args as { where: { tmdbId: number } }).where.tmdbId === 111);
  assert.equal(purges.length, 1, "sole holder ⇒ the old-id episode rows are purged");
  assert.deepEqual((purges[0].args as { where: unknown }).where, { source: "plex", tmdbId: 111 });
  await flush();
});

test("POST (plex, TV): old-id episode purge is SKIPPED while another instance still holds the old id; the library row is still rewritten", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "TV", serverInstance: "", filePath: "/d/def-show", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "TV", serverInstance: "remote", filePath: "/d/show", plexRatingKey: "2002" });
  otherInstanceHolders = 1;
  respond = (url) => {
    if (url.pathname === "/library/metadata/2002/allLeaves") return okJson({ MediaContainer: { Metadata: [] } });
    return plexRemapResponder(PLEX_REMOTE, "2002", 222)(url);
  };

  const res = await fixMatch(postBody(
    { server: "plex", tmdbId: 111, mediaType: "TV", correctTmdbId: 222, canonicalGuid: "plex://show/xyz", serverInstance: "remote" },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);

  const purges = opsOf("tVEpisodeCache.deleteMany").filter((o) => (o.args as { where: { tmdbId: number } }).where.tmdbId === 111);
  assert.equal(purges.length, 0, "another server's legitimate episode rows for tmdb 111 must survive");
  assert.equal(opsOf("plexLibraryItem.deleteMany").length, 1, "the instance's own library row is still removed");
  assert.equal(opsOf("plexLibraryItem.upsert").length, 1, "…and rewritten under the corrected id");
  await flush();
});

test("POST (jellyfin, MOVIE): old-id episode purge is SKIPPED while another instance still holds the old id", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/d/rem.mkv", jellyfinItemId: "bbbbbbbb" });
  otherInstanceHolders = 1;
  respond = jellyfinRemapResponder(JF_REMOTE, "bbbbbbbb", 222);

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, serverInstance: "remote" },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);

  const cnt = opsOf("jellyfinLibraryItem.count")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(cnt.where, { tmdbId: 111, mediaType: "MOVIE", serverInstance: { not: "remote" } });
  assert.equal(opsOf("tVEpisodeCache.deleteMany").length, 0);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 1);
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

test("POST / candidates / file-info refuse a tmdbId past INT4 with 400 — never a Prisma 500 — before any read or fetch", async () => {
  const a = await admin();
  configureServers();
  const TOO_BIG = 2_147_483_648;
  for (const [field, body] of [
    ["tmdbId", { server: "plex", tmdbId: TOO_BIG, mediaType: "MOVIE", correctTmdbId: 222 }],
    ["correctTmdbId", { server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: TOO_BIG }],
  ] as const) {
    const res = await fixMatch(postBody(body, a.header), undefined);
    assert.equal(res.status, 400, `POST ${field}`);
  }
  for (const params of [
    { server: "plex", tmdbId: String(TOO_BIG), mediaType: "MOVIE", correctTmdbId: "222" },
    { server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: String(TOO_BIG) },
  ]) {
    const res = await candidates(req(candidatesUrl(params), { headers: a.header }), undefined);
    assert.equal(res.status, 400, `candidates ${JSON.stringify(params)}`);
  }
  const fi = await fileInfo(req(fileInfoUrl({ tmdbId: String(TOO_BIG), mediaType: "MOVIE" }), { headers: a.header }), undefined);
  assert.equal(fi.status, 400, "file-info");
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

// Multi-copy (guardrail 37): a title in two Jellyfin libraries is remapped copy
// by copy. When the SECOND copy's confirmation read fails, the path/tmdb
// fallback search used the canonical row's filePath — i.e. the FIRST copy's —
// and found that first copy, already remapped to the correct id. The second
// copy was then reported confirmed without ever being read, deduped out of
// jellyfinItemIds, and no partial warning was raised.
test("POST (jellyfin, two copies): a failed read of copy B is never confirmed by the already-remapped copy A", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({
    tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/Title (2000)/a.mkv",
    jellyfinItemId: "aaaaaaaa", jellyfinItemIds: ["aaaaaaaa", "bbbbbbbb"],
  });

  const searches: string[] = [];
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p.endsWith("/Refresh")) return new Response("", { status: 200 });
    if (p === "/Items/aaaaaaaa") return okJson({ ProviderIds: { Tmdb: "222" } });
    if (p === "/Items/bbbbbbbb") return new Response("", { status: 500 }); // B never reads back
    if (p === "/Items") {
      searches.push(url.search);
      // Copy A, already remapped — the only hit a path or tmdb search can find.
      return okJson({ Items: [{ Id: "aaaaaaaa", Path: "/d/Title (2000)/a.mkv", ProviderIds: { Tmdb: "222" } }] });
    }
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; warning?: string };
  assert.ok(body.warning?.includes("1 of 2 copies"), `copy B must be reported unconfirmed, got: ${JSON.stringify(body)}`);
  assert.ok(errors.some((e) => e.includes("jellyfin copy bbbbbbbb failed")), "copy B's failure must be logged");
  const upsert = opsOf("jellyfinLibraryItem.upsert")[0]?.args as { create: { jellyfinItemId: string; jellyfinItemIds: string[] } };
  assert.equal(upsert.create.jellyfinItemId, "aaaaaaaa");
  assert.deepEqual(upsert.create.jellyfinItemIds, ["aaaaaaaa"]);
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
  assert.equal(opsOf("jellyfinLibraryItem.deleteMany").length, 0, "an unconfirmed match must not touch the DB");
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0);
  assert.ok(fetchCalls.every((c) => !c.url.pathname.endsWith("/Refresh")), "no refresh may be queued on a box that is already mid-apply");
  assert.ok(errors.some((e) => e.includes("still processing the match")), "the failure must say the server is still working, not imply a revert");
});

// ════════════════════════════════════════════════════════════════════════════
// Unconfirmed-apply diagnosis (jellyfin) — an item still reporting the OLD id
// when the window expires is USUALLY a slow series refresh settling late (field
// data: every sampled "failure" had actually landed when inspected afterwards),
// so the error must lead with re-sync-and-check guidance — and only name the
// repeat-offender explanations (an enabled Nfo reader re-importing a stale
// .nfo, or a metadata-locked item) as what to look at if it KEEPS happening.
// ════════════════════════════════════════════════════════════════════════════

test("POST (jellyfin): when EVERY confirmation read fails, the error says the item could not be read back — not that the match was refused", async () => {
  // The other diagnosis branches all infer from what Jellyfin REPORTED. With no
  // successful read there is nothing to infer from — lastSeenTmdbId stays null
  // and itemLocked stays false only because nothing was observed — and the
  // fall-through message blamed Jellyfin's metadata provider for what is really
  // an unreachable or erroring Jellyfin. Seen live: four items, 120/120 reads
  // failed, every one reported as a provider problem.
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/movies/Wrong (1999)/wrong.mkv", jellyfinItemId: "aaaaaaaa" });

  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    // The server answers nothing for the rest of the window: the direct
    // confirmation read AND the path/name fallback search both fail.
    if (p === "/Items/aaaaaaaa" || p === "/Items") return new Response("", { status: 500 });
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 502);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0, "an unconfirmed match must not touch the DB");
  const msg = errors.find((e) => e.includes("Could not read the item back"));
  assert.ok(msg, `the error must name the unreadable server, got: ${errors.join(" | ")}`);
  assert.ok(msg.includes("all 4 confirmation reads failed"), "the operator needs the count — it is the evidence for the claim");
  assert.ok(
    !msg.includes("metadata provider"),
    "blaming Jellyfin's metadata provider is the fall-through message for an item that DID answer; " +
      "reaching it here sends the operator to the wrong system",
  );
  assert.ok(msg.includes("unknown"), "we genuinely do not know whether the match applied — the message must not assert it failed");
});

test("POST (jellyfin): old-id-after-window failure says re-sync-first and names the library's enabled Nfo reader (and saver)", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/movies/Wrong (1999)/wrong.mkv", jellyfinItemId: "aaaaaaaa" });

  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    if (p === "/Items/aaaaaaaa") return okJson({ ProviderIds: { Tmdb: "111" } }); // the server reverted
    if (p === "/Library/VirtualFolders") return okJson([
      { Name: "Shows", Locations: ["/media/shows"], LibraryOptions: { DisabledLocalMetadataReaders: [] } },
      // Owning library: Nfo reader ON (not in the disabled list) + Nfo saver ON.
      { Name: "Movies", Locations: ["/media/movies"], LibraryOptions: { DisabledLocalMetadataReaders: ["Collections"], MetadataSavers: ["Nfo"] } },
    ]);
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 502);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0, "an unconfirmed match must not touch the DB");
  const msg = errors.find((e) => e.includes("still reported the previous match"));
  assert.ok(msg, `the error must say the old id was still reported, got: ${errors.join(" | ")}`);
  assert.ok(msg.includes("re-sync"), "slow-settle is the common case — re-sync-and-check guidance must lead");
  assert.ok(msg.includes('"Movies"'), "the OWNING library must be named, not the first one in the list");
  assert.ok(msg.includes("Nfo metadata reader"), "the reader must be called out as the cause");
  assert.ok(msg.includes("SAVER"), "an enabled Nfo saver must be flagged too — it keeps rewriting the stale files");
  assert.ok(msg.includes("TMDB #111"), "the id the server restored must be shown");
});

test("POST (jellyfin): a metadata-locked item is diagnosed as locked, without probing library config", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/movies/Wrong (1999)/wrong.mkv", jellyfinItemId: "aaaaaaaa" });

  let virtualFoldersCalls = 0;
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    if (p === "/Items/aaaaaaaa") return okJson({ ProviderIds: { Tmdb: "111" }, LockData: true });
    if (p === "/Library/VirtualFolders") { virtualFoldersCalls++; return okJson([]); }
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody(
    { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 },
    a.header,
  ), undefined);

  assert.equal(res.status, 502);
  assert.ok(errors.some((e) => e.includes("locked in Jellyfin")), "a lock explains everything — say so");
  assert.equal(virtualFoldersCalls, 0, "the lock short-circuits the library-config probe");
});

// ════════════════════════════════════════════════════════════════════════════
// Background mode (guardrail 37a) — `async: true` answers 202 + jobId before
// the remap finishes, an identical in-flight remap is deduped, and the status
// route reports running → done/failed with the same outcomes the synchronous
// path produces. The synchronous default is untouched (every test above).
// ════════════════════════════════════════════════════════════════════════════

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const statusUrl = (id: string) => `http://localhost:3000/api/admin/fix-match/status?id=${id}`;

test("POST async:true → 202 + jobId BEFORE the remap finishes; same key dedupes; status polls running → done; DB written once", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });

  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    // The confirming read is held until the test releases it — this is the
    // "media server still busy" window the 202 must not wait for.
    if (p === "/Items/aaaaaaaa") return gate.then(() => okJson({ ProviderIds: { Tmdb: "222" } }));
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const body = { server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, async: true };
  const res = await fixMatch(postBody(body, a.header), undefined);
  assert.equal(res.status, 202);
  const started = await res.json() as { ok: boolean; jobId: string; status: string };
  assert.equal(started.ok, true);
  assert.equal(started.status, "running");
  assert.match(started.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0, "the 202 must come back before the remap has finished");

  const again = await fixMatch(postBody(body, a.header), undefined);
  assert.equal(again.status, 202);
  assert.equal((await again.json() as { jobId: string }).jobId, started.jobId, "an identical remap already running is returned, never started twice");

  let st = await fixMatchStatus(req(statusUrl(started.jobId), { headers: a.header }), undefined);
  assert.equal(st.status, 200);
  assert.equal((await st.json() as { status: string }).status, "running");

  // While gated, the job has already passed Apply: the status must say the
  // media server accepted the match and Summonarr is merely confirming — the
  // signal the UI turns into "Jellyfin accepted — waiting for its refresh".
  let progress: { phase?: string; remoteApplied?: boolean } | undefined;
  for (let i = 0; i < 400 && !progress?.remoteApplied; i++) {
    await flush();
    st = await fixMatchStatus(req(statusUrl(started.jobId), { headers: a.header }), undefined);
    progress = (await st.json() as { progress?: typeof progress }).progress;
  }
  assert.equal(progress?.remoteApplied, true, "the job reports the server accepted the match before confirmation lands");
  assert.equal(progress?.phase, "confirming");

  release();
  await until(() => opsOf("jellyfinLibraryItem.upsert").length === 1, "the background remap's DB write");
  let final: { status: string; result?: unknown; error?: string } = { status: "running" };
  for (let i = 0; i < 400 && final.status === "running"; i++) {
    await flush();
    st = await fixMatchStatus(req(statusUrl(started.jobId), { headers: a.header }), undefined);
    final = await st.json() as typeof final;
  }
  assert.equal(final.status, "done", `job should settle as done, got ${JSON.stringify(final)}`);
  assert.deepEqual(final.result, { ok: true });
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 1, "exactly one DB write for the deduped pair of POSTs");
});

test("POST async:true failure → status failed with the client-safe error + errorStatus, and no DB write", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    if (p === "/Items/aaaaaaaa") return okJson({ ProviderIds: { Tmdb: "111" } }); // never confirms
    if (p === "/Library/VirtualFolders") return okJson([]);
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody({ server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, async: true }, a.header), undefined);
  assert.equal(res.status, 202);
  const { jobId } = await res.json() as { jobId: string };

  let final: { status: string; error?: string; errorStatus?: number } = { status: "running" };
  for (let i = 0; i < 400 && final.status === "running"; i++) {
    await flush();
    const st = await fixMatchStatus(req(statusUrl(jobId), { headers: a.header }), undefined);
    final = await st.json() as typeof final;
  }
  assert.equal(final.status, "failed");
  assert.equal(final.error, "Fix-match operation failed", "the job carries the same client-safe message the synchronous 502 would");
  assert.equal(final.errorStatus, 502);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0);
});

test("background mode waits out a long series cascade: a TV item confirming only on the 40th poll succeeds as a job, while the synchronous window gives up at 24", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "TV", serverInstance: "", filePath: "/media/shows/Long Show", jellyfinItemId: "aaaaaaaa" });
  let checks = 0;
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Long Show" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    // The cascade "settles" only on the 40th confirmation read — past the
    // synchronous 24-poll window, inside the background one.
    if (p === "/Items/aaaaaaaa") { checks++; return okJson({ ProviderIds: { Tmdb: checks >= 40 ? "222" : "111" } }); }
    if (p === "/Library/VirtualFolders") return okJson([]);
    return okJson({ Items: [] }); // the post-success episode re-cache fetch
  };

  const res = await fixMatch(postBody({ server: "jellyfin", tmdbId: 111, mediaType: "TV", correctTmdbId: 222, async: true }, a.header), undefined);
  assert.equal(res.status, 202);
  const { jobId } = await res.json() as { jobId: string };
  let final: { status: string; error?: string } = { status: "running" };
  for (let i = 0; i < 600 && final.status === "running"; i++) {
    await flush();
    final = await (await fixMatchStatus(req(statusUrl(jobId), { headers: a.header }), undefined)).json() as typeof final;
  }
  assert.equal(final.status, "done", `the job must keep polling past the synchronous window; got ${JSON.stringify(final)}`);
  assert.ok(checks >= 40, `expected at least 40 confirmation polls, got ${checks}`);
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 1, "the landed remap is recorded");

  // Same server behaviour under the synchronous contract: it stops at its window.
  checks = 0;
  ops = [];
  const sync = await fixMatch(postBody({ server: "jellyfin", tmdbId: 111, mediaType: "TV", correctTmdbId: 222 }, a.header), undefined);
  assert.equal(sync.status, 502);
  assert.equal(checks, 24, "the synchronous TV window is still 24 polls");
  assert.equal(opsOf("jellyfinLibraryItem.upsert").length, 0);
  assert.ok(errors.some((e) => e.includes("still reported the previous match")), "and it says the cascade may still be settling");
});

test("confirmation reads that fail are counted on the job's progress and warned once — and the job still confirms afterwards", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: null, jellyfinItemId: "aaaaaaaa" });
  let reads = 0;
  respond = (url) => {
    const p = url.pathname;
    if (p.startsWith("/Items/RemoteSearch/Apply/")) return new Response("", { status: 200 });
    if (p.startsWith("/Items/RemoteSearch/")) return okJson([{ ProviderIds: { Tmdb: "222" }, Name: "Correct Title" }]);
    if (p === "/Items/aaaaaaaa/Refresh") return new Response("", { status: 200 });
    if (p === "/Items/aaaaaaaa") {
      reads++;
      if (reads <= 3) throw new Error("socket hang up"); // Jellyfin busy: the read errors out
      return okJson({ ProviderIds: { Tmdb: "222" } });
    }
    throw new Error(`unexpected Jellyfin path ${p}`);
  };

  const res = await fixMatch(postBody({ server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, async: true }, a.header), undefined);
  assert.equal(res.status, 202);
  const { jobId } = await res.json() as { jobId: string };
  let final: { status: string; progress?: { readFailures?: number } } = { status: "running" };
  for (let i = 0; i < 400 && final.status === "running"; i++) {
    await flush();
    final = await (await fixMatchStatus(req(statusUrl(jobId), { headers: a.header }), undefined)).json() as typeof final;
  }
  assert.equal(final.status, "done", `a few failed reads must not fail the job: ${JSON.stringify(final)}`);
  assert.equal(final.progress?.readFailures, 3, "every failed confirmation read is counted for the UI");
  assert.equal(warns.filter((w) => w.includes("confirmation read failed")).length, 1, "warned on the first failure only (then every 10th)");
});

test("status: 400 on a malformed id, 404 on an unknown job, 401 with no session", async () => {
  const a = await admin();
  const unknown = "00000000-0000-4000-8000-000000000000";
  assert.equal((await fixMatchStatus(req(statusUrl("nope"), { headers: a.header }), undefined)).status, 400);
  assert.equal((await fixMatchStatus(req(statusUrl(unknown), { headers: a.header }), undefined)).status, 404);
  assert.equal((await fixMatchStatus(req(statusUrl(unknown)), undefined)).status, 401, "withIssueAdmin fronts the status route (guardrail 6a)");
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

test("candidates GET is rate limited per admin: the 31st call inside a minute → 429 before any validation or read", async () => {
  const a = await admin();
  configureServers();
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) {
    const res = await candidates(req(candidatesUrl({
      server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "BAD SLUG",
    }), { headers: a.header }), undefined);
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 30).every((s) => s === 400), `the first 30 are the ordinary validation answer, got ${statuses.slice(0, 30)}`);
  assert.equal(statuses[30], 429, "the sibling POST caps at 10/min; the GET had no bound at all");
  assert.equal(opsOf("plexLibraryItem.findFirst").length, 0);
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

// candidates?server=jellyfin — the confirmation-card payload. Jellyfin has no
// candidate list (the POST applies the exact TMDB id), so this mode returns the
// target's details + the file about to be re-identified, from the DB alone: no
// media-server config read, no upstream call.

test("candidates?server=jellyfin: confirm-card payload from the INSTANCE row — zero network, zero media-server config reads", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/def/wrong.mkv", jellyfinItemId: "aaaaaaaa" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/media/rem/wrong.mkv", jellyfinItemId: "bbbbbbbb" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/plex/wrong.mkv", plexRatingKey: "1001" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({
    title: "Correct Title", releaseYear: "2010", imdbId: "tt0000222",
    posterPath: "/p222.jpg", overview: "The right film.", releaseDate: "2010-05-01", voteAverage: 7.4,
  }));

  const res = await candidates(req(candidatesUrl({
    server: "jellyfin", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "remote",
  }), { headers: a.header }), undefined);

  assert.equal(res.status, 200);
  const body = await res.json() as {
    candidates: unknown[]; ratingKey: string; serverInstance: string;
    jellyfinFilePath: string | null; plexFilePath: string | null;
    targetTitle: string; targetYear: string; targetImdbId: string;
    targetPosterPath: string | null; targetVoteAverage: number | null;
  };
  assert.deepEqual(body.candidates, [], "jellyfin mode has no candidate list");
  assert.equal(body.ratingKey, "", "the Plex-only field stays neutral");
  assert.equal(body.serverInstance, "remote");
  assert.equal(body.jellyfinFilePath, "/media/rem/wrong.mkv", "the file shown must be the REQUESTED instance's copy");
  assert.equal(body.plexFilePath, "/media/plex/wrong.mkv", "cross-server hint mirrors the Plex mode's Jellyfin hint");
  assert.equal(body.targetTitle, "Correct Title");
  assert.equal(body.targetYear, "2010");
  assert.equal(body.targetImdbId, "tt0000222");
  assert.equal(body.targetPosterPath, "/p222.jpg");
  assert.equal(body.targetVoteAverage, 7.4);

  const read = opsOf("jellyfinLibraryItem.findFirst")[0].args as { where: Record<string, unknown> };
  assert.deepEqual(read.where, { tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote" });
  assert.equal(fetchCalls.length, 0, "the confirm card is DB-only — no TMDB, no arr, no media server");
  assert.equal(
    settingReads.filter((k) => k.startsWith("plex") || k.startsWith("jellyfin")).length, 0,
    "no media-server config may even be read",
  );
});

test("candidates for a MANAGE_ISSUES delegate carries file NAMES only — fresh AND from the title-keyed cache (library-path-view)", async () => {
  const a = await issueAdmin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/media/rem/wrong.mkv", jellyfinItemId: "bbbbbbbb" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/plex/wrong.mkv", plexRatingKey: "1001" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Correct Title", releaseYear: "2010" }));
  const url = candidatesUrl({ server: "jellyfin", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "remote" });

  const fresh = await (await candidates(req(url, { headers: a.header }), undefined)).json() as { jellyfinFilePath: string | null; plexFilePath: string | null };
  assert.equal(fresh.jellyfinFilePath, "wrong.mkv");
  assert.equal(fresh.plexFilePath, "wrong.mkv");
  assert.ok(!JSON.stringify(fresh).includes("/media/"), JSON.stringify(fresh));

  // The cache is keyed by the title, not the caller: the ADMIN's full-path
  // answer it holds after this read must not be replayed to the delegate.
  const boss = await admin();
  const full = await (await candidates(req(url, { headers: boss.header }), undefined)).json() as { jellyfinFilePath: string | null };
  assert.equal(full.jellyfinFilePath, "/media/rem/wrong.mkv", "an ADMIN sees the path (served from the cache)");
  const again = await (await candidates(req(url, { headers: a.header }), undefined)).json() as { jellyfinFilePath: string | null; plexFilePath: string | null };
  assert.equal(again.jellyfinFilePath, "wrong.mkv", "the delegate, from the same cache entry");
  assert.equal(again.plexFilePath, "wrong.mkv");
});

test("candidates?server=jellyfin 404s when the instance has no row (re-sync first)", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/def.mkv", jellyfinItemId: "aaaaaaaa" });

  const res = await candidates(req(candidatesUrl({
    server: "jellyfin", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222", serverInstance: "remote",
  }), { headers: a.header }), undefined);

  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /re-sync/);
  assert.equal(fetchCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// file-info
// ════════════════════════════════════════════════════════════════════════════

function fileInfoUrl(params: Record<string, string>): string {
  return `http://localhost:3000/api/admin/fix-match/file-info?${new URLSearchParams(params)}`;
}

test("file-info?serverInstance=remote: paths come from the named instance, and every holder is enumerated", async () => {
  const a = await admin();
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

test("file-info for a MANAGE_ISSUES delegate carries file NAMES only — the mount layout is ADMIN data (library-path-view)", async () => {
  const a = await issueAdmin();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/mnt/media/plex/Def (2010)/def.mkv", plexRatingKey: "1001" });
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "/srv/remote/rem.mkv", plexRatingKey: "2002" });
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "remote", filePath: "D:\\Media\\jf-rem.mkv", jellyfinItemId: "bbbbbbbb" });

  const res = await fileInfo(req(fileInfoUrl({ tmdbId: "111", mediaType: "MOVIE", serverInstance: "remote" }), { headers: a.header }), undefined);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plexFilePath, "rem.mkv");
  assert.equal(body.jellyfinFilePath, "jf-rem.mkv", "a Windows path is reduced the same way");
  assert.deepEqual(body.plexInstances, [
    { serverInstance: "", filePath: "def.mkv" },
    { serverInstance: "remote", filePath: "rem.mkv" },
  ]);
  assert.deepEqual(body.jellyfinInstances, [{ serverInstance: "remote", filePath: "jf-rem.mkv" }]);
  assert.ok(!JSON.stringify(body).includes("/mnt/") && !JSON.stringify(body).includes("/srv/") && !JSON.stringify(body).includes("Media"), JSON.stringify(body));
});

test("file-info with NO serverInstance resolves the default instance and reports a null side honestly", async () => {
  const a = await admin(); // the ADMIN view: full paths (a delegate gets file names — see below);
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
  const a = await admin(); // the ADMIN view: full paths (a delegate gets file names — see below);
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

// ════════════════════════════════════════════════════════════════════════════
// Item mode — the library match check's Fix rematches ONE flagged item
// ════════════════════════════════════════════════════════════════════════════
//
// A title can hold a correct copy beside a wrong one ("Ghost in the Shell
// (2017)" matched to the 1995 film's TMDB id). The tmdbId mode remaps EVERY
// copy holding the id (guardrail 37) — the correct 1995 copy included. Item mode
// names one item the last match check flagged; its id, media type and path are
// read from the stored flag, never the body.

const COPY_OK = "a".repeat(32);
const COPY_WRONG = "b".repeat(32);

function storeMatchReport(flags: Array<Record<string, unknown>>) {
  settings.set("libraryMatchCheck:report", JSON.stringify({
    version: 1, checkedAt: "2026-10-13T00:00:00.000Z", sources: [],
    counts: { checked: 10, agreed: 8, notManaged: 0, flagged: flags.length }, flags, truncated: 0,
  }));
}
const wrongCopyFlag = (over: Record<string, unknown> = {}) => ({
  kind: "wrongMatch", server: "jellyfin", serverInstance: "", mediaType: "MOVIE", itemKey: COPY_WRONG,
  title: "Ghost in the Shell", year: 1995, folder: "Ghost in the Shell (2017)", file: "b.mkv", path: "/m/Ghost in the Shell (2017)/b.mkv",
  serverTmdbId: 9323, arr: { service: "radarr", instance: "", tmdbId: 315837, tvdbId: null, title: "Ghost in the Shell", year: 2017 }, sibling: false,
  ...over,
});

test("POST itemKey (jellyfin): rematches ONLY the flagged copy — the correct copy keeps its row, its plays and its server match", async () => {
  const a = await admin();
  configureServers();
  storeMatchReport([wrongCopyFlag(), wrongCopyFlag({ itemKey: "c".repeat(32), folder: "Other (2001)" })]);
  itemHolders = [{ tmdbId: 9323, jellyfinItemId: COPY_OK, jellyfinItemIds: [COPY_OK, COPY_WRONG] }];
  respond = jellyfinRemapResponder(JF_DEFAULT, COPY_WRONG, 315837);

  const res = await fixMatch(postBody(
    // tmdbId in the body is ignored in item mode — the stored flag's id is used.
    { server: "jellyfin", tmdbId: 1, mediaType: "MOVIE", correctTmdbId: 315837, itemKey: COPY_WRONG },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.ok(fetchCalls.length > 0 && fetchCalls.every((c) => !c.url.pathname.includes(COPY_OK)), "the correct copy is never sent to Jellyfin");
  assert.equal(opsOf("jellyfinLibraryItem.findFirst").length, 0, "item mode never resolves the item through the title's row");

  // The old title keeps its correct copy: an update, never the tmdbId mode's deleteMany.
  assert.equal(opsOf("jellyfinLibraryItem.deleteMany").length, 0);
  assert.deepEqual(opsOf("jellyfinLibraryItem.update")[0]?.args, {
    where: { tmdbId_mediaType_serverInstance: { tmdbId: 9323, mediaType: "MOVIE", serverInstance: "" } },
    data: { jellyfinItemIds: [COPY_OK] },
  });
  assert.deepEqual(opsOf("jellyfinLibraryItem.create")[0]?.args, {
    data: { tmdbId: 315837, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: COPY_WRONG, jellyfinItemIds: [COPY_WRONG], filePath: "/m/Ghost in the Shell (2017)/b.mkv" },
  });

  // Plays of THIS item only — by its own key, whatever id they were recorded under.
  const expectedWhere = { source: "jellyfin", serverInstance: "", mediaType: "MOVIE", sourceItemId: { in: [COPY_WRONG] } };
  assert.deepEqual(opsOf("playHistory.updateMany")[0]?.args, { where: expectedWhere, data: { tmdbId: 315837 } });
  assert.deepEqual(opsOf("activeSession.updateMany")[0]?.args, { where: expectedWhere, data: { tmdbId: 315837 } });
  assert.equal(opsOf("tVEpisodeCache.deleteMany").length, 0, "the episode cache is left to the next full sync");

  // The fixed flag leaves the stored report in the same transaction; the other stays.
  const stored = JSON.parse(settings.get("libraryMatchCheck:report")!) as { flags: Array<{ itemKey: string }>; counts: { flagged: number } };
  assert.deepEqual(stored.flags.map((f) => f.itemKey), ["c".repeat(32)]);
  assert.equal(stored.counts.flagged, 1);

  await flush();
  const audit = auditRows.find((r) => r.action === "FIX_MATCH");
  assert.equal(audit?.target, "tmdb:9323");
  assert.deepEqual(JSON.parse(String(audit?.details)), {
    type: "fix-match", mode: "item", source: "jellyfin", itemKey: COPY_WRONG, fromTmdbId: 9323, toTmdbId: 315837, mediaType: "MOVIE", serverInstance: "",
  });
});

test("POST itemKey (plex): an UNMATCHED item (no TMDB id) is matched; its plays move whatever id they carried", async () => {
  const a = await admin();
  configureServers();
  storeMatchReport([wrongCopyFlag({ kind: "noTmdbId", server: "plex", serverInstance: "remote", itemKey: "2002", serverTmdbId: null, path: "/d/Invictus (2009)/x.mkv" })]);
  tmdbCacheRows.set("movie:22954:details", JSON.stringify({ title: "Invictus", releaseYear: "2009" }));
  respond = plexRemapResponder(PLEX_REMOTE, "2002", 22954);

  const res = await fixMatch(postBody(
    { server: "plex", mediaType: "MOVIE", correctTmdbId: 22954, itemKey: "2002", serverInstance: "remote", canonicalGuid: "plex://movie/x" },
    a.header,
  ), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(origins(), [new URL(PLEX_REMOTE).origin]);
  assert.deepEqual(opsOf("plexLibraryItem.create")[0]?.args, {
    data: { tmdbId: 22954, mediaType: "MOVIE", serverInstance: "remote", plexRatingKey: "2002", plexRatingKeys: ["2002"], filePath: "/d/Invictus (2009)/x.mkv" },
  });
  const where = (opsOf("playHistory.updateMany")[0]?.args as { where: Record<string, unknown> }).where;
  assert.deepEqual(where, { source: "plex", serverInstance: "remote", mediaType: "MOVIE", sourceItemId: { in: ["2002"] } });
  assert.ok(!("tmdbId" in where), "an unmatched item's plays were recorded with no id — never filter on one");
  await flush();
  assert.equal(auditRows.find((r) => r.action === "FIX_MATCH")?.target, "tmdb:22954");
});

test("POST itemKey (TV): an episode's plays move by its SHOW's key", async () => {
  const a = await admin();
  configureServers();
  storeMatchReport([wrongCopyFlag({ mediaType: "TV", itemKey: COPY_WRONG, serverTmdbId: 37854, path: "/tv/ONE PIECE (2023)" })]);
  respond = jellyfinRemapResponder(JF_DEFAULT, COPY_WRONG, 111110);
  const res = await fixMatch(postBody({ server: "jellyfin", mediaType: "TV", correctTmdbId: 111110, itemKey: COPY_WRONG }, a.header), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual((opsOf("playHistory.updateMany")[0]?.args as { where: unknown }).where,
    { source: "jellyfin", serverInstance: "", mediaType: "TV", sourceShowId: { in: [COPY_WRONG] } });
});

test("POST itemKey is refused — with nothing sent and nothing written — unless the last match check flagged that item on that server", async () => {
  const a = await admin();
  configureServers();
  respond = (url) => { throw new Error(`nothing may be fetched: ${url}`); };
  const post = (body: Record<string, unknown>) => fixMatch(postBody({ server: "jellyfin", mediaType: "MOVIE", correctTmdbId: 315837, ...body }, a.header), undefined);

  assert.equal((await post({ itemKey: COPY_WRONG })).status, 404, "no stored report");
  storeMatchReport([wrongCopyFlag()]);
  assert.equal((await post({ itemKey: COPY_WRONG, serverInstance: "remote" })).status, 404, "flagged on ANOTHER server");
  assert.equal((await post({ itemKey: COPY_WRONG, server: "plex" })).status, 400, "a Jellyfin id is not a Plex ratingKey");
  assert.equal((await post({ itemKey: "c".repeat(32) })).status, 404, "an item the check didn't flag");
  assert.equal((await post({ itemKey: COPY_WRONG, mediaType: "TV" })).status, 404, "the flag's media type wins");
  assert.equal((await post({ itemKey: "../Items/x" })).status, 400);
  assert.equal((await post({ itemKey: 42 })).status, 400);
  assert.equal((await post({ itemKey: COPY_WRONG, correctTmdbId: 9323 })).status, 400, "rematching to the id it already has");
  assert.equal(fetchCalls.length, 0);
  assert.equal(ops.filter((o) => o.op.includes("update") || o.op.includes("create") || o.op.includes("delete")).length, 0);
});

test("item-mode jobs are keyed by the ITEM: two unmatched items fixed to one title are two jobs", async () => {
  const { fixMatchJobKey } = await import("../src/lib/fix-match-jobs.ts");
  const base = { server: "jellyfin", serverInstance: "", mediaType: "MOVIE", tmdbId: 0, correctTmdbId: 5 };
  assert.notEqual(fixMatchJobKey({ ...base, itemKey: "x" }), fixMatchJobKey({ ...base, itemKey: "y" }));
  assert.equal(fixMatchJobKey({ ...base, tmdbId: 3 }), "jellyfin::MOVIE:3->5", "the tmdbId mode's key is unchanged");
});

// ════════════════════════════════════════════════════════════════════════════
// fix-match review: Plex copies, unmatched-on-apply-failure, metadata carry-over
// ════════════════════════════════════════════════════════════════════════════

// A multi-key Plex conversation: each key starts on the OLD id and flips to the
// new one once its /match PUT lands. `failMatch` keys answer 500 to /match.
function plexCopiesResponder(base: string, keys: string[], oldId: number, newId: number, opts: { failMatch?: string[]; claimsOther?: string[] } = {}) {
  const fixed = new Set<string>();
  return (url: URL, method: string): Response => {
    if (url.origin !== new URL(base).origin) throw new Error(`WRONG SERVER: ${url.origin}`);
    const p = url.pathname;
    if (p === "/library/clean/bundles") return new Response("", { status: 200 });
    const m = /^\/library\/metadata\/(\d+)(?:\/(unmatch|match|refresh))?$/.exec(p);
    if (!m || !keys.includes(m[1])) throw new Error(`unexpected Plex path ${p}`);
    const [, key, action] = m;
    if (action === "match") {
      if (opts.failMatch?.includes(key)) return new Response("", { status: 500 });
      fixed.add(key);
      return new Response("", { status: 200 });
    }
    if (action) return new Response("", { status: 200 });
    void method;
    const id = fixed.has(key) ? newId : (opts.claimsOther?.includes(key) ? 999 : oldId);
    return okJson({ MediaContainer: { Metadata: [{ guid: "plex://movie/abc", Guid: [{ id: `tmdb://${id}` }] }] } });
  };
}

test("POST (plex): EVERY copy of the title is remapped, not just the canonical key (guardrail 37c twin)", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001", plexRatingKeys: ["1001", "1002"] });
  respond = plexCopiesResponder(PLEX_DEFAULT, ["1001", "1002"], 111, 222);

  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" }, a.header), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const matched = fetchCalls.filter((c) => c.method === "PUT" && c.url.pathname.endsWith("/match")).map((c) => c.url.pathname);
  assert.deepEqual(matched, ["/library/metadata/1001/match", "/library/metadata/1002/match"]);
  const up = opsOf("plexLibraryItem.upsert")[0].args as { create: { plexRatingKeys: string[] } };
  assert.deepEqual(up.create.plexRatingKeys, ["1001", "1002"], "both copies' keys land on the corrected row");
  const ph = opsOf("playHistory.updateMany")[0].args as { where: { sourceItemId: { in: string[] } } };
  assert.deepEqual(ph.where.sourceItemId.in, ["1001", "1002"], "plays filed under either copy move");
  assert.equal(opsOf("plexLibraryItem.deleteMany").length, 1, "nothing left on the old row");
});

test("POST (plex): a rider key that does NOT carry the old id is left alone, not unmatched", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001", plexRatingKeys: ["1001", "1002"] });
  respond = plexCopiesResponder(PLEX_DEFAULT, ["1001", "1002"], 111, 222, { claimsOther: ["1002"] });

  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" }, a.header), undefined);
  assert.equal(res.status, 200);
  assert.ok(!fetchCalls.some((c) => c.url.pathname === "/library/metadata/1002/unmatch"), "an item that belongs to another title is never unmatched");
  assert.ok(!fetchCalls.some((c) => c.url.pathname === "/library/metadata/1002/match"), "and it is never rematched onto the correction");
  assert.equal(opsOf("plexLibraryItem.deleteMany").length, 1, "the old row no longer lists a key that isn't this title");
  const up = opsOf("plexLibraryItem.upsert")[0].args as { create: { plexRatingKeys: string[] } };
  assert.deepEqual(up.create.plexRatingKeys, ["1001"], "the foreign key is not merged onto the corrected row");
  const ph = opsOf("playHistory.updateMany")[0].args as { where: { sourceItemId: { in: string[] } } };
  assert.deepEqual(ph.where.sourceItemId.in, ["1001"], "plays of the other title stay on that title");
});

test("POST (plex): a copy that fails stays on the OLD row and the result carries the partial warning", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001", plexRatingKeys: ["1001", "1002"] });
  respond = plexCopiesResponder(PLEX_DEFAULT, ["1001", "1002"], 111, 222, { failMatch: ["1002"] });

  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" }, a.header), undefined);
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; warning?: string };
  assert.ok(body.warning, "a partial remap must say so");
  assert.equal(opsOf("plexLibraryItem.deleteMany").length, 0, "the old row survives while a copy still carries the old match");
  const upd = opsOf("plexLibraryItem.update")[0].args as { data: { plexRatingKey: string; plexRatingKeys: string[]; filePath: null } };
  assert.deepEqual(upd.data, { plexRatingKey: "1002", plexRatingKeys: ["1002"], filePath: null });
  const up = opsOf("plexLibraryItem.upsert")[0].args as { create: { plexRatingKeys: string[] } };
  assert.deepEqual(up.create.plexRatingKeys, ["1001"]);
});

test("POST (plex): an apply failure AFTER the unmatch reports the UNMATCHED state, not the generic failure", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001" });
  respond = plexCopiesResponder(PLEX_DEFAULT, ["1001"], 111, 222, { failMatch: ["1001"] });

  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" }, a.header), undefined);
  assert.equal(res.status, 502);
  const body = await res.json() as { error: string };
  assert.ok(/unmatched/i.test(body.error), `expected the UNMATCHED message, got: ${body.error}`);
  assert.ok(errors.some((e) => e.includes("(PlexUnmatchedError)")));
  assert.equal(opsOf("plexLibraryItem.upsert").length, 0);
});

test("POST (plex): the corrected row keeps the removed row's title/year/overview/addedAt, and a pre-existing target's keys survive", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001" });
  const addedAt = new Date("2024-05-01T00:00:00Z");
  removedRow = { title: "Old Title", year: "2018", overview: "o", contentRating: "R", addedAt };
  existingTargetRow = { plexRatingKey: "7777", plexRatingKeys: ["7777"], filePath: "/d/other.mkv", title: "Right Title", year: null, overview: null, contentRating: null, addedAt: null };
  respond = plexRemapResponder(PLEX_DEFAULT, "1001", 222);

  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz" }, a.header), undefined);
  assert.equal(res.status, 200);
  const up = opsOf("plexLibraryItem.upsert")[0].args as { create: Record<string, unknown>; update: Record<string, unknown> };
  assert.equal(up.create.year, "2018");
  assert.equal(up.update.title, undefined, "the target's own title is never overwritten");
  assert.equal(up.update.year, "2018");
  assert.equal(up.update.addedAt, addedAt, "addedAt survives so the title stays in recently-added");
  assert.equal(up.update.plexRatingKey, "7777", "the target's canonical key stays canonical");
  assert.deepEqual(up.update.plexRatingKeys, ["7777", "1001"], "this run's key joins the target's set instead of replacing it");
  assert.equal(up.update.filePath, "/d/other.mkv");
});

test("POST (jellyfin): the corrected row keeps the removed row's title/year/addedAt/communityRating", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", jellyfinItemId: "aaaaaaaa", jellyfinItemIds: ["aaaaaaaa"] });
  const addedAt = new Date("2024-06-01T00:00:00Z");
  removedRow = { title: "Old Title", year: "2018", overview: null, contentRating: "PG", addedAt, communityRating: 7.4 };
  respond = jellyfinRemapResponder(JF_DEFAULT, "aaaaaaaa", 222);

  const res = await fixMatch(postBody({ server: "jellyfin", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222 }, a.header), undefined);
  assert.equal(res.status, 200);
  const up = opsOf("jellyfinLibraryItem.upsert")[0].args as { create: Record<string, unknown>; update: Record<string, unknown> };
  for (const branch of [up.create, up.update]) {
    assert.equal(branch.title, "Old Title");
    assert.equal(branch.addedAt, addedAt);
    assert.equal(branch.communityRating, 7.4);
    assert.equal("overview" in branch, false, "a null on the removed row is not carried");
  }
});

test("a Plex job reports confirming progress (attempt counts) tagged with the copy it is on", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001", plexRatingKeys: ["1001", "1002"] });
  respond = plexCopiesResponder(PLEX_DEFAULT, ["1001", "1002"], 111, 222);

  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz", async: true }, a.header), undefined);
  const { jobId } = await res.json() as { jobId: string };
  type Status = { status: string; progress?: { phase: string; remoteApplied: boolean; attempts: number; copy?: number; copies?: number } };
  let final: Status = { status: "running" };
  for (let i = 0; i < 400 && final.status === "running"; i++) {
    await flush();
    final = await (await fixMatchStatus(req(statusUrl(jobId), { headers: a.header }), undefined)).json() as Status;
  }
  assert.equal(final.status, "done");
  assert.equal(final.progress?.phase, "confirming");
  assert.equal(final.progress?.remoteApplied, true);
  assert.ok((final.progress?.attempts ?? 0) > 0, "Plex now reports its confirmation window");
  assert.deepEqual([final.progress?.copy, final.progress?.copies], [2, 2], "the last progress report names the last of the two copies");
});

test("candidates: the arr cross-check reads EVERY enabled instance — a title only in a NAMED instance is still confirmed (guardrail 32)", async () => {
  const a = await admin();
  configureServers();
  // No default Radarr at all; only the "anime" instance is configured.
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  settings.set("radarrAnimeUrl", "http://10.88.0.20:7878");
  settings.set("radarrAnimeApiKey", "anime-key");
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/media/anime/Right Film (2010)/right.mkv", jellyfinItemId: "aaaaaaaa" });
  tmdbCacheRows.set("movie:222:details", JSON.stringify({ title: "Right Film", releaseYear: "2010", imdbId: "tt0000222" }));
  const arrHits: string[] = [];
  respond = (url) => {
    if (url.origin !== "http://10.88.0.20:7878") throw new Error(`unexpected origin ${url.origin}`);
    arrHits.push(url.pathname + url.search);
    if (url.search === "?tmdbId=222") return okJson([{ tmdbId: 222, path: "/media/anime/Right Film (2010)" }]);
    return okJson([]);
  };

  const res = await candidates(req(candidatesUrl({ server: "jellyfin", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222" }), { headers: a.header }), undefined);
  assert.equal(res.status, 200);
  const body = await res.json() as { arrConfirmedTmdbId: number | null; arrPathAgrees: boolean | null; arrConfirmedTitle: string | null };
  assert.equal(body.arrConfirmedTmdbId, 222, "the named instance confirms the corrected id");
  assert.equal(body.arrPathAgrees, true);
  assert.equal(body.arrConfirmedTitle, "Right Film");
  assert.ok(arrHits.includes("/api/v3/movie?tmdbId=222"));
  assert.ok(settingReads.every((k) => k !== "radarrUrl" && k !== "radarrApiKey"), "the default-instance keys are no longer read raw");
});

test("jobs feed: lists recent jobs with a title and outcome, coarse only — no ratingKey, path or key — and needs a session", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/secret/path/a.mkv", plexRatingKey: "1001", title: "Dune", year: "2021" } as LibRow);
  respond = plexRemapResponder(PLEX_DEFAULT, "1001", 222);
  const res = await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/xyz", async: true }, a.header), undefined);
  assert.equal(res.status, 202);
  const { jobId } = await res.json() as { jobId: string };
  for (let i = 0; i < 400; i++) {
    await flush();
    const st = await (await fixMatchStatus(req(statusUrl(jobId), { headers: a.header }), undefined)).json() as { status: string };
    if (st.status !== "running") break;
  }
  const feed = await fixMatchJobs(req("http://localhost:3000/api/admin/fix-match/jobs", { headers: a.header }), undefined);
  assert.equal(feed.status, 200);
  const text = await feed.text();
  const body = JSON.parse(text) as { jobs: Array<{ id: string; status: string; title: string | null; server: string }> };
  const job = body.jobs.find((j) => j.id === jobId);
  assert.equal(job?.status, "done");
  assert.equal(job?.title, "Dune (2021)");
  assert.equal(job?.server, "plex");
  for (const secret of ["1001", "/secret/path", "plex://movie/xyz", PLEX_DEFAULT, TOKEN_DEFAULT]) {
    assert.ok(!text.includes(secret), `the feed must not leak ${secret}`);
  }
  assert.equal((await fixMatchJobs(req("http://localhost:3000/api/admin/fix-match/jobs"), undefined)).status, 401);
});

test("candidates (plex): a re-open inside the TTL is served from memory with ZERO Plex calls, and a fix-match run clears it", async () => {
  const a = await admin();
  configureServers();
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/d/a.mkv", plexRatingKey: "1001" });
  respond = (url) => {
    if (url.pathname === "/library/metadata/1001/matches") return okJson({ MediaContainer: { SearchResult: [{ guid: "plex://movie/aaa", name: "Right", year: 2010 }] } });
    throw new Error(`unexpected ${url}`);
  };
  const call = () => candidates(req(candidatesUrl({ server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222" }), { headers: a.header }), undefined);
  const first = await call();
  assert.equal(first.status, 200);
  const callsAfterFirst = fetchCalls.length;
  assert.ok(callsAfterFirst > 0);
  const second = await call();
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(fetchCalls.length, callsAfterFirst, "the second open made no upstream call");

  // A fix-match run (even a failing one) drops the cached list.
  respond = (url) => { throw new Error(`unexpected ${url}`); };
  await fixMatch(postBody({ server: "plex", tmdbId: 111, mediaType: "MOVIE", correctTmdbId: 222, canonicalGuid: "plex://movie/aaa" }, a.header), undefined);
  respond = (url) => {
    if (url.pathname === "/library/metadata/1001/matches") return okJson({ MediaContainer: { SearchResult: [] } });
    throw new Error(`unexpected ${url}`);
  };
  const before = fetchCalls.length;
  await call();
  assert.ok(fetchCalls.length > before, "after a fix-match run the list is fetched fresh");
});

test("candidates: the payload names what the row is matched to NOW (current title + year) for both servers", async () => {
  const a = await admin();
  configureServers();
  jellyfinRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/m/w.mkv", jellyfinItemId: "aaaaaaaa", title: "Wrong Film", year: "1995" } as LibRow);
  plexRows.push({ tmdbId: 111, mediaType: "MOVIE", serverInstance: "", filePath: "/m/w.mkv", plexRatingKey: "1001", title: "Wrong Film", year: "1995" } as LibRow);
  const jf = await (await candidates(req(candidatesUrl({ server: "jellyfin", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222" }), { headers: a.header }), undefined)).json() as { currentTitle: string | null; currentYear: string | null };
  assert.deepEqual([jf.currentTitle, jf.currentYear], ["Wrong Film", "1995"]);
  respond = (url) => {
    if (url.pathname === "/library/metadata/1001/matches") return okJson({ MediaContainer: { SearchResult: [] } });
    throw new Error(`unexpected ${url}`);
  };
  const px = await (await candidates(req(candidatesUrl({ server: "plex", tmdbId: "111", mediaType: "MOVIE", correctTmdbId: "222" }), { headers: a.header }), undefined)).json() as { currentTitle: string | null; currentYear: string | null };
  assert.deepEqual([px.currentTitle, px.currentYear], ["Wrong Film", "1995"]);
});
