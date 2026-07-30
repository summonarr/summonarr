// Unit tests for the READ half of per-user media-server visibility: the two
// entry points added to src/lib/media-visibility.ts for callers that don't hold
// a SummonarrSession, plus the two user-facing decisions that are easiest to get
// subtly wrong.
//
// Background: a Plex/Jellyfin server can be marked `restricted`, and then its
// library contributes availability ONLY to users granted `view` on it. The
// product rule is that availability is per-user EVERYWHERE it is user-facing —
// a restricted server the viewer can't see must not make a title read
// "available", must not reject their request as already-in-library, and must not
// satisfy the in-library gates. What this file pins:
//
//   - getVisibleServerInstancesForUserId (the attachAllAvailability chokepoint's
//     entry point — it carries a bare userId, not a session): the
//     nothing-restricted fast path issues NO user read; a restricted deployment
//     resolves grants from the row; ADMIN passes via effectivePermissions on the
//     stored ROLE (the bit isn't in a JWT claim here); a missing row falls back
//     to least privilege rather than to "sees everything";
//   - getMediaInstanceAccessLists: both registries plus the anyRestricted flag
//     that the two non-session callers below branch on;
//   - POST /api/requests/bulk resolves availability from the TARGET's grants,
//     never the caller's. This is the sharp edge of the on-behalf flow: an ADMIN
//     acting for a plain user sees every server, so keying off the caller would
//     classify the target's item "already-available" for a copy the target can
//     never watch — and silently drop it from the bulk create;
//   - POST /api/votes's "Media is not in any library" 422 gate is per-grant: the
//     granted voter gets through, the ungranted one is refused, on identical DB
//     state.
//
// Harness: the two route handlers are withAuth/withPermission-wrapped (guardrail
// 6a), so they're invoked as real route functions with a NextRequest carrying a
// REAL signed session JWT over in-memory authSession/user stubs, inside a
// synthetic workAsyncStorage + workUnitAsyncStorage scope (the
// tests/maintenance.test.mts idiom, as used by tests/votes-route.test.mts) whose
// work store records after() tasks instead of running them. No DB or network:
// every touched prisma delegate is shadowed in-memory (tests/_helpers.mts),
// dns.lookup is stubbed and globalThis.fetch is scripted (TMDB verification
// only).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "media-visibility-read-path-secret-0123456789"; // session JWT + request token HMAC
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
console.warn = () => {};
console.error = () => {};

// ── scripted fetch — TMDB verification is the only sanctioned wire call ─────
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.themoviedb.org") {
    return new Response(
      JSON.stringify({ id: 603, title: "The Matrix", poster_path: "/m.jpg", release_date: "1999-03-31" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(`unexpected fetch to ${url.hostname}`);
}) as typeof fetch;

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
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { generateRequestToken } = await import("../src/lib/request-token.ts");
const { invalidateBlacklistCache } = await import("../src/lib/blacklist.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const {
  getMediaInstanceAccessLists,
  getVisibleServerInstancesForUserId,
  visibleEpisodeSourcesFor,
  visibleEpisodeSourcesFrom,
} = await import("../src/lib/media-visibility.ts");

// ── in-memory state ─────────────────────────────────────────────────────────
type DbUser = {
  id: string;
  role: string;
  permissions: bigint;
  mediaServerGrants: unknown;
  maxContentRating: string | null;
  instanceGrants: unknown;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  discordId: string | null;
  name: string | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();
let userReads = 0;

const settings = new Map<string, string>();
// Library rows as (tmdbId, mediaType, serverInstance) triples — the real 3-column PK.
type LibRow = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string };
let plexRows: LibRow[] = [];
let jellyfinRows: LibRow[] = [];
const plexWhere: unknown[] = [];
const jellyfinWhere: unknown[] = [];
let existingRequests: Array<{ id: string; tmdbId: number; mediaType: string; status: string; permanentlyDeclined: boolean }> = [];
let ownRequest: { id: string } | null = null;
const createdVotes: unknown[] = [];

function makeUser(id: string, over: Partial<DbUser> = {}): DbUser {
  return {
    id,
    role: "USER",
    permissions: 0n,
    mediaServerGrants: null,
    maxContentRating: null,
    instanceGrants: null,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `${id}@example.com`,
    notificationEmail: null,
    discordId: null,
    name: id,
    movieQuotaLimit: null,
    movieQuotaDays: null,
    tvQuotaLimit: null,
    tvQuotaDays: null,
    ...over,
  };
}

// `OR: [{tmdbId, mediaType}, …]` (bulk/person shape) or a flat {tmdbId, mediaType}.
type LibWhere = {
  tmdbId?: number;
  mediaType?: "MOVIE" | "TV";
  OR?: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV" }>;
  serverInstance: { in: string[] };
};
function matchLib(rows: LibRow[], where: LibWhere): LibRow[] {
  return rows.filter((r) => {
    if (!where.serverInstance.in.includes(r.serverInstance)) return false;
    if (where.OR) return where.OR.some((p) => p.tmdbId === r.tmdbId && p.mediaType === r.mediaType);
    return r.tmdbId === where.tmdbId && r.mediaType === where.mediaType;
  });
}

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null,
  update: async () => ({}), // lastSeenAt fire-and-forget touch
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    userReads += 1;
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) as string })),
  createMany: async () => ({ count: 1 }),
});
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { where: LibWhere }) => {
    plexWhere.push(args.where);
    return matchLib(plexRows, args.where);
  },
  findFirst: async (args: { where: LibWhere }) => {
    plexWhere.push(args.where);
    return matchLib(plexRows, args.where)[0] ?? null;
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async (args: { where: LibWhere }) => {
    jellyfinWhere.push(args.where);
    return matchLib(jellyfinRows, args.where);
  },
  findFirst: async (args: { where: LibWhere }) => {
    jellyfinWhere.push(args.where);
    return matchLib(jellyfinRows, args.where)[0] ?? null;
  },
});
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async () => existingRequests,
  findFirst: async () => ownRequest,
  count: async () => 0,
});
shadowPrismaModel(prisma, "radarrAvailableItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "sonarrAvailableItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "blacklistItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "deletionVote", {
  create: async (args: { data: unknown }) => {
    createdVotes.push(args.data);
    return { id: "vote-1", createdAt: new Date(), ...(args.data as object) };
  },
  count: async () => 0,
});

// Routes under test (imported AFTER every stub is in place).
const { POST: bulkRequest } = await import("../src/app/api/requests/bulk/route.ts");
const { POST: postVote } = await import("../src/app/api/votes/route.ts");

// ── synthetic request scope with a recording afterContext ───────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/media-visibility-read-path.test",
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

const COOKIE = getSessionCookieName();
let seq = 0;

async function mintSession(user: DbUser): Promise<string> {
  seq++;
  const sessionId = `sess-${seq}`;
  usersById.set(user.id, user);
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    {
      id: user.id,
      role: user.role,
      permissions: user.permissions.toString(),
      provider: "credentials",
      sessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
}

function postJson(url: string, token: string, body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest(url, {
    method: "POST",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Only "remote" is restricted; the default ("") server is never restrictable.
const RESTRICTED_PLEX = JSON.stringify([{ slug: "remote", name: "Friend's", restricted: true }]);
const VIEW_REMOTE = { plex: { remote: { view: true } } };
const REQUESTER = Permission.REQUEST | Permission.REQUEST_MOVIE;

beforeEach(() => {
  usersById.clear();
  sessionRows.clear();
  settings.clear();
  userReads = 0;
  plexRows = [];
  jellyfinRows = [];
  plexWhere.length = 0;
  jellyfinWhere.length = 0;
  existingRequests = [];
  ownRequest = null;
  createdVotes.length = 0;
  afterTasks.length = 0;
  invalidateBlacklistCache(); // 30s module-global cache must not leak across tests
  invalidateFeatureFlagCache();
});

// ── getVisibleServerInstancesForUserId ──────────────────────────────────────

test("nothing restricted → every instance is visible and the user row is NEVER read", async () => {
  // The cost contract for every deployment that hasn't opted in. This entry point
  // rides attachAllAvailability, i.e. every discovery grid — an unconditional
  // identity round-trip here would be a per-render tax on the whole app.
  settings.set("plexInstances", JSON.stringify([{ slug: "open", name: "Shared" }]));
  usersById.set("u1", makeUser("u1"));
  const v = await getVisibleServerInstancesForUserId("u1");
  assert.deepEqual(v, { plex: ["", "open"], jellyfin: [""] });
  assert.equal(userReads, 0);
});

test("a restricted server resolves from the row's grants: ungranted is excluded, granted is not", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  usersById.set("plain", makeUser("plain"));
  usersById.set("granted", makeUser("granted", { mediaServerGrants: VIEW_REMOTE }));
  assert.deepEqual((await getVisibleServerInstancesForUserId("plain")).plex, [""]);
  assert.deepEqual((await getVisibleServerInstancesForUserId("granted")).plex, ["", "remote"]);
  assert.equal(userReads, 2, "a restricted server exists — the grants read is load-bearing here");
});

test("ADMIN passes on the stored ROLE — the superbit isn't in a JWT claim on this path", async () => {
  // The session form reads session.user.permissions (already effective). With a
  // bare id there is no claim, so effectivePermissions(role, permissions) is what
  // grants the bypass; a plain `permissions` read would leave a legacy admin row
  // (permissions = 0) unable to see its own restricted servers.
  settings.set("plexInstances", RESTRICTED_PLEX);
  usersById.set("boss", makeUser("boss", { role: "ADMIN", permissions: 0n }));
  assert.deepEqual((await getVisibleServerInstancesForUserId("boss")).plex, ["", "remote"]);
});

test("an unknown id and an absent id both fall back to LEAST privilege, never to 'sees everything'", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  assert.deepEqual((await getVisibleServerInstancesForUserId("ghost")).plex, [""]);
  assert.deepEqual((await getVisibleServerInstancesForUserId(undefined)).plex, [""]);
  assert.deepEqual((await getVisibleServerInstancesForUserId(null)).plex, [""]);
  assert.equal(userReads, 1, "only the plausible id is looked up; anonymous never reaches the user table");
});

// ── getMediaInstanceAccessLists ─────────────────────────────────────────────

test("getMediaInstanceAccessLists reports both registries and whether grants can matter at all", async () => {
  const bare = await getMediaInstanceAccessLists();
  assert.deepEqual(bare.plex, [{ slug: "", name: "Default", restricted: false }]);
  assert.deepEqual(bare.jellyfin, [{ slug: "", name: "Default", restricted: false }]);
  assert.equal(bare.anyRestricted, false);

  settings.set("jellyfinInstances", JSON.stringify([{ slug: "attic", name: "Attic", restricted: true }]));
  const restricted = await getMediaInstanceAccessLists();
  assert.equal(restricted.anyRestricted, true, "a restricted server on EITHER service must flip the flag");
});

// ── POST /api/requests/bulk — the TARGET's visibility, never the caller's ───

// Both bulk assertions run the same request against the same DB state; only the
// grants of the two users differ. The item is BOTH in the restricted library and
// already requested by the target, so the classification reveals which user's
// visibility the route used — "already-available" (library gate, checked first)
// vs "already-requested" (the fallthrough). Nothing is created either way, so
// this never reaches the create transaction.
async function bulkOnBehalf(callerToken: string, targetId: string): Promise<{ status: number; body: { results: Array<{ result: string }>; created: number } }> {
  const req = postJson("http://localhost:3000/api/requests/bulk", callerToken, {
    items: [{ tmdbId: 603, mediaType: "MOVIE" }],
    onBehalfOfUserId: targetId,
  });
  const res = await inScope(() => bulkRequest(req, undefined));
  return { status: res.status, body: (await res.json()) as { results: Array<{ result: string }>; created: number } };
}

test("bulk on-behalf classifies from the TARGET's grants — an ungranted target is not told 'already-available'", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  plexRows = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "remote" }];
  existingRequests = [{ id: "r1", tmdbId: 603, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false }];

  // The caller is an ADMIN — they see EVERY server, restricted included. Keying
  // off them would classify this "already-available" for a copy the target can
  // never watch, and silently drop it from the bulk create.
  const admin = makeUser("admin", { role: "ADMIN", permissions: Permission.ADMIN });
  const token = await mintSession(admin);
  usersById.set("plain", makeUser("plain", { permissions: REQUESTER }));

  const out = await bulkOnBehalf(token, "plain");
  assert.equal(out.status, 200);
  assert.deepEqual(
    out.body.results.map((r) => r.result),
    ["already-requested"],
    "the restricted copy is invisible to the target, so the library gate must not fire",
  );
  // And the query itself proves it: the target's allowlist, not the admin's.
  const libWheres = plexWhere.filter((w) => (w as LibWhere).OR);
  assert.deepEqual((libWheres.at(-1) as LibWhere).serverInstance, { in: [""] });
});

test("bulk on-behalf DOES short-circuit when the TARGET holds the grant", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  plexRows = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "remote" }];
  existingRequests = [{ id: "r1", tmdbId: 603, mediaType: "MOVIE", status: "PENDING", permanentlyDeclined: false }];

  const admin = makeUser("admin", { role: "ADMIN", permissions: Permission.ADMIN });
  const token = await mintSession(admin);
  usersById.set("granted", makeUser("granted", { permissions: REQUESTER, mediaServerGrants: VIEW_REMOTE }));

  const out = await bulkOnBehalf(token, "granted");
  assert.deepEqual(out.body.results.map((r) => r.result), ["already-available"]);
  const libWheres = plexWhere.filter((w) => (w as LibWhere).OR);
  assert.deepEqual((libWheres.at(-1) as LibWhere).serverInstance, { in: ["", "remote"] });
});

// ── POST /api/votes — the in-library 422 gate is per-grant ──────────────────

async function vote(token: string, userId: string): Promise<Response> {
  const req = postJson("http://localhost:3000/api/votes", token, {
    tmdbId: 603,
    mediaType: "MOVIE",
    _token: generateRequestToken(603, "MOVIE", userId),
  });
  return inScope(() => postVote(req, undefined));
}

test("the votes in-library gate is per-grant: ungranted → 422, granted → 201, on identical state", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  plexRows = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "remote" }];

  const plainToken = await mintSession(makeUser("plain", { permissions: REQUESTER }));
  const refused = await vote(plainToken, "plain");
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error, "Media is not in any library");
  assert.equal(createdVotes.length, 0);

  const grantedToken = await mintSession(
    makeUser("granted", { permissions: REQUESTER, mediaServerGrants: VIEW_REMOTE }),
  );
  const allowed = await vote(grantedToken, "granted");
  assert.equal(allowed.status, 201);
  assert.equal(createdVotes.length, 1);
});

// ── TVEpisodeCache gate ──────────────────────────────────────────────────────
// TVEpisodeCache has NO serverInstance column — every server's episodes land in
// one `source` namespace — so a plain `source IN (...)` read would hand an
// ungranted viewer a RESTRICTED server's per-episode holdings, and two of the
// three read sites return them as raw JSON. The gate is one level up: report a
// source only when the viewer can see some server of that type holding the
// title. These pin the shared helper both sites use.

test("TVEpisodeCache gate: a title held ONLY on a restricted server reports NO episode sources to an ungranted viewer", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  plexRows = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "remote" }];

  // Register the row — resolving a MISSING user also yields least privilege, so
  // an unregistered fixture would pass this test for the wrong reason.
  const plain = makeUser("tv-plain", { permissions: REQUESTER });
  usersById.set(plain.id, plain);
  const ungranted = await getVisibleServerInstancesForUserId(plain.id);
  assert.deepEqual(ungranted.plex, [""], "sanity: the row resolved, and it can see only the default server");
  assert.deepEqual(
    await visibleEpisodeSourcesFor(1399, ungranted, ["plex", "jellyfin"]),
    [],
    "no visible server holds it ⇒ no source ⇒ the per-episode rows are never read, so nothing leaks via the season/availability JSON",
  );
});

test("TVEpisodeCache gate: the same title reports its source once the viewer is granted", async () => {
  settings.set("plexInstances", RESTRICTED_PLEX);
  plexRows = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "remote" }];

  const grantedUser = makeUser("tv-granted", { permissions: REQUESTER, mediaServerGrants: VIEW_REMOTE });
  usersById.set(grantedUser.id, grantedUser);
  const granted = await getVisibleServerInstancesForUserId(grantedUser.id);
  assert.deepEqual(await visibleEpisodeSourcesFor(1399, granted, ["plex", "jellyfin"]), ["plex"]);
});

test("TVEpisodeCache gate: the provider preference still narrows, and never widens, the gated set", async () => {
  // The pure form the TV detail page uses — it holds the scoped library rows
  // already, so it must not re-query. A viewer pinned to Jellyfin sees no Plex
  // episodes even where Plex genuinely holds the title (pre-existing cosmetic
  // behaviour), and a source the gate rejected can never be re-added by it.
  assert.deepEqual(visibleEpisodeSourcesFrom(true, true, ["jellyfin"]), ["jellyfin"]);
  assert.deepEqual(visibleEpisodeSourcesFrom(true, false, ["plex", "jellyfin"]), ["plex"]);
  assert.deepEqual(visibleEpisodeSourcesFrom(false, false, ["plex", "jellyfin"]), []);
  assert.deepEqual(visibleEpisodeSourcesFrom(false, true, ["plex"]), []);
});
