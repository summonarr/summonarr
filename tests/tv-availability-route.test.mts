// Route-level unit tests for GET /api/tv-availability — the per-episode
// "which seasons/episodes do we hold" endpoint behind the season pickers.
//
// This route is the sharpest edge of guardrail 35's visibility rules, because
// TVEpisodeCache is the ONE table that cannot be scoped: it has no
// serverInstance column (episodes are TMDB-anchored shared data) and every
// configured server's episodes accumulate into one `source: "plex"` /
// `"jellyfin"` namespace. So a plain `source IN (…)` read hands an ungranted
// caller a RESTRICTED server's per-episode holdings — and this route returns
// them as raw JSON, not as a rendered tick, so no presentation-layer mask can
// help. The gate has to sit one level up (visibleEpisodeSourcesFor: report a
// source only when the viewer can see SOME server of that type actually holding
// the title), and that is what these tests pin.
//
// Also covered, because they are all cheap once the harness exists and each has
// its own failure mode:
//   - the withAuth wrapper (guardrail 6a): anonymous ⇒ 401, never a body;
//   - input validation on the client-supplied tmdbId (missing / non-numeric /
//     zero / negative / float / overflow), which reaches a DB query;
//   - the per-user rate limit, keyed by session user so one caller cannot spend
//     another's budget;
//   - the provider narrowing (a Plex-signin user is told about Plex only) —
//     and its interaction with the grants gate, which must be an AND, not an OR;
//   - the season/episode shaping: cross-source dedup, numeric (not lexical)
//     ordering, and the "both" source verdict.
//
// Harness: the tests/votes-route.test.mts idiom — the real withAuth-wrapped
// handler invoked with a NextRequest carrying a genuine signed session JWT, in a
// synthetic workAsyncStorage + workUnitAsyncStorage scope, over in-memory prisma
// stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "tv-availability-route-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from tv-availability tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture (the api-auth.test.mts idiom) ───────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  mediaServerGrants: unknown;
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
  findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    rec("user.findUnique", args.select);
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

let seq = 0;
async function mintSession(
  opts: { provider?: string; role?: string; permissions?: string; grants?: unknown } = {},
): Promise<string> {
  seq++;
  const userId = `viewer-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `viewer-${seq}@example.com`,
    notificationEmail: null,
    mediaServerGrants: opts.grants ?? null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions,
      provider: opts.provider ?? "credentials",
      sessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
}

const COOKIE = getSessionCookieName();

// ── business-model stubs ─────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    rec("setting.findMany", args.where.key.in);
    return args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) }));
  },
});

// Which serverInstance slugs actually hold the show, per service.
let plexHolders: Array<{ tmdbId: number; serverInstance: string }> = [];
let jellyfinHolders: Array<{ tmdbId: number; serverInstance: string }> = [];

function libraryStub(
  name: string,
  rows: () => Array<{ tmdbId: number; serverInstance: string }>,
) {
  return {
    findFirst: async (args: { where: { tmdbId: number; mediaType: string; serverInstance: { in: string[] } } }) => {
      rec(`${name}.findFirst`, args.where);
      const { tmdbId, serverInstance } = args.where;
      assert.equal(args.where.mediaType, "TV", "the episode gate must probe the TV namespace");
      assert.ok(Array.isArray(serverInstance.in), "the holder probe must be serverInstance-scoped");
      const hit = rows().find((r) => r.tmdbId === tmdbId && serverInstance.in.includes(r.serverInstance));
      return hit ? { tmdbId: hit.tmdbId } : null;
    },
  };
}
shadowPrismaModel(prisma, "plexLibraryItem", libraryStub("plexLibraryItem", () => plexHolders));
shadowPrismaModel(prisma, "jellyfinLibraryItem", libraryStub("jellyfinLibraryItem", () => jellyfinHolders));

type EpisodeRow = { tmdbId: number; source: string; seasonNumber: number; episodeNumber: number };
let episodes: EpisodeRow[] = [];
shadowPrismaModel(prisma, "tVEpisodeCache", {
  findMany: async (args: { where: { tmdbId: number; source: { in: string[] } } }) => {
    rec("tVEpisodeCache.findMany", args.where);
    return episodes
      .filter((e) => e.tmdbId === args.where.tmdbId && args.where.source.in.includes(e.source))
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  },
});

const { GET } = await import("../src/app/api/tv-availability/route.ts");

// ── synthetic request scope ──────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/tv-availability.test",
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

async function get(token: string | null, query: string): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/tv-availability${query}`, {
    method: "GET",
    headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
  return inScope(() => GET(req, undefined));
}

// Register a named instance, optionally restricted.
function registerInstance(service: "plex" | "jellyfin", slug: string, restricted: boolean): void {
  const key = service === "plex" ? "plexInstances" : "jellyfinInstances";
  const existing = JSON.parse(settings.get(key) ?? "[]") as unknown[];
  existing.push({ slug, name: slug, restricted });
  settings.set(key, JSON.stringify(existing));
}

beforeEach(() => {
  ops = [];
  settings.clear();
  plexHolders = [];
  jellyfinHolders = [];
  episodes = [];
});

// ── auth (guardrail 6a) ──────────────────────────────────────────────────────

test("an anonymous request is refused 401 by the withAuth wrapper", async () => {
  const res = await get(null, "?tmdbId=1399");
  assert.equal(res.status, 401);
});

test("a 401 never leaks episode data, and never reaches the cache", async () => {
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  const res = await get(null, "?tmdbId=1399");
  assert.equal(res.status, 401);
  assert.equal(opsOf("tVEpisodeCache.findMany").length, 0);
  const body = await res.json();
  assert.ok(!("seasons" in body));
});

test("a garbage session cookie is refused, not treated as anonymous-but-allowed", async () => {
  const res = await get("not-a-jwt", "?tmdbId=1399");
  assert.equal(res.status, 401);
});

// ── tmdbId validation ────────────────────────────────────────────────────────

test("a missing tmdbId is a 400 and never reaches a query", async () => {
  const res = await get(await mintSession(), "");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "tmdbId is required");
  assert.equal(opsOf("tVEpisodeCache.findMany").length, 0);
});

test("an empty tmdbId is a 400", async () => {
  assert.equal((await get(await mintSession(), "?tmdbId=")).status, 400);
});

for (const [label, raw] of [
  ["non-numeric", "abc"],
  ["zero", "0"],
  ["negative", "-5"],
  ["whitespace", "%20"],
  ["a bare sign", "%2B"],
  ["a hex literal", "0x10"], // parseInt(_, 10) stops at the `x` ⇒ 0 ⇒ rejected
] as const) {
  test(`a ${label} tmdbId is rejected with 400 and never reaches a query`, async () => {
    const res = await get(await mintSession(), `?tmdbId=${raw}`);
    assert.equal(res.status, 400);
    assert.equal(opsOf("tVEpisodeCache.findMany").length, 0);
  });
}

// parseInt is a PREFIX parse, so several malformed-looking inputs are accepted.
// That is safe here, and pinning it says why: whatever the caller sends is
// coerced to a single positive integer before it reaches the query, so the
// leniency can never widen the scope past one tmdbId or reach SQL as text.
for (const [label, raw, want] of [
  ["a trailing-garbage id", "12abc", 12],
  ["a float", "12.5", 12],
  ["a SQL-ish string", "1%20OR%201%3D1", 1],
  ["a semicolon-terminated id", "77%3B%20DROP%20TABLE", 77],
] as const) {
  test(`${label} truncates to a bound positive integer rather than erroring`, async () => {
    plexHolders = [{ tmdbId: want, serverInstance: "" }];
    episodes = [{ tmdbId: want, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
    const res = await get(await mintSession(), `?tmdbId=${raw}`);
    assert.equal(res.status, 200);
    const where = opsOf("tVEpisodeCache.findMany")[0].args as { tmdbId: number };
    assert.equal(where.tmdbId, want);
    assert.equal(typeof where.tmdbId, "number");
  });
}

test("a valid tmdbId with no library holder returns the empty shape, not a 404", async () => {
  const res = await get(await mintSession(), "?tmdbId=99999");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { source: null, seasons: [] });
});

// ── the guardrail-35 episode gate ────────────────────────────────────────────

test("with nothing restricted, a plain user sees the episodes of a held show", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 2 },
  ];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.equal(body.source, "plex");
  assert.deepEqual(body.seasons, [{ seasonNumber: 1, episodes: [1, 2] }]);
});

test("a RESTRICTED server's episodes are withheld from an ungranted viewer", async () => {
  // The leak this gate exists to stop: the show sits ONLY on the restricted
  // instance, and TVEpisodeCache cannot tell the two apart.
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];

  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.deepEqual(body, { source: null, seasons: [] });
});

test("the withheld case short-circuits BEFORE reading TVEpisodeCache at all", async () => {
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  await get(await mintSession(), "?tmdbId=1399");
  assert.equal(opsOf("tVEpisodeCache.findMany").length, 0, "an ungranted read must not touch the shared table");
});

test("a granted viewer DOES see the restricted server's episodes", async () => {
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 2, episodeNumber: 4 },
    { tmdbId: 1399, source: "plex", seasonNumber: 2, episodeNumber: 5 },
  ];
  const token = await mintSession({ grants: { plex: { remote: { view: true } } } });
  const body = await (await get(token, "?tmdbId=1399")).json();
  assert.equal(body.source, "plex");
  assert.deepEqual(body.seasons, [{ seasonNumber: 2, episodes: [4, 5] }]);
});

test("grants are service-namespaced — a Jellyfin `remote` grant does not unlock Plex `remote`", async () => {
  // Plex "remote" and Jellyfin "remote" are different servers with different
  // content; a flat slug map would collide them.
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const token = await mintSession({ grants: { jellyfin: { remote: { view: true } } } });
  assert.deepEqual(await (await get(token, "?tmdbId=1399")).json(), { source: null, seasons: [] });
});

test("a grant must be the { view: true } object form — a bare `true` does not grant", async () => {
  // A hand-edited mediaServerGrants column carrying the shorthand must fail
  // CLOSED; parseMediaServerGrants only accepts the object form.
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const token = await mintSession({ grants: { plex: { remote: true } } });
  assert.deepEqual(await (await get(token, "?tmdbId=1399")).json(), { source: null, seasons: [] });
});

test("an explicit view:false grant withholds the restricted server", async () => {
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const token = await mintSession({ grants: { plex: { remote: { view: false } } } });
  assert.deepEqual(await (await get(token, "?tmdbId=1399")).json(), { source: null, seasons: [] });
});

test("a grant for a DIFFERENT slug does not unlock the restricted one", async () => {
  registerInstance("plex", "remote", true);
  registerInstance("plex", "attic", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const token = await mintSession({ grants: { plex: { attic: { view: true } } } });
  assert.deepEqual(await (await get(token, "?tmdbId=1399")).json(), { source: null, seasons: [] });
});

test("holding the show on an UNRESTRICTED server keeps the episodes visible to everyone", async () => {
  // The residual the design accepts: once the viewer can see the title on some
  // visible server, episode granularity within it is the pre-grants status quo.
  registerInstance("plex", "remote", true);
  plexHolders = [
    { tmdbId: 1399, serverInstance: "" },
    { tmdbId: 1399, serverInstance: "remote" },
  ];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.equal(body.source, "plex");
});

test("an ADMIN short-circuits the grant check and sees a restricted server's episodes", async () => {
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const { Permission } = await import("../src/lib/permissions.ts");
  const token = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN.toString() });
  assert.equal((await (await get(token, "?tmdbId=1399")).json()).source, "plex");
});

test("the holder probe is scoped to the viewer's visible instances, not all of them", async () => {
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  await get(await mintSession(), "?tmdbId=1399");
  const where = opsOf("plexLibraryItem.findFirst")[0].args as { serverInstance: { in: string[] } };
  assert.deepEqual(where.serverInstance.in, [""], "the ungranted viewer sees the default instance only");
});

test("with nothing restricted the grants column is never read", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  await get(await mintSession(), "?tmdbId=1399");
  const grantReads = opsOf("user.findUnique").filter(
    (o) => (o.args as Record<string, boolean> | undefined)?.mediaServerGrants,
  );
  assert.equal(grantReads.length, 0, "the nothing-restricted fast path must skip the grants read");
});

test("a restricted deployment DOES read the grants column", async () => {
  registerInstance("plex", "remote", true);
  await get(await mintSession(), "?tmdbId=1399");
  const grantReads = opsOf("user.findUnique").filter(
    (o) => (o.args as Record<string, boolean> | undefined)?.mediaServerGrants,
  );
  assert.equal(grantReads.length, 1);
});

// ── provider narrowing, and its AND with the grants gate ─────────────────────

test("a Plex-signin user is told about Plex only", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  jellyfinHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 1399, source: "jellyfin", seasonNumber: 9, episodeNumber: 9 },
  ];
  const body = await (await get(await mintSession({ provider: "plex" }), "?tmdbId=1399")).json();
  assert.equal(body.source, "plex");
  assert.deepEqual(body.seasons, [{ seasonNumber: 1, episodes: [1] }]);
});

for (const provider of ["jellyfin", "jellyfin-quickconnect"]) {
  test(`a ${provider} user is told about Jellyfin only`, async () => {
    plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
    jellyfinHolders = [{ tmdbId: 1399, serverInstance: "" }];
    episodes = [
      { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
      { tmdbId: 1399, source: "jellyfin", seasonNumber: 9, episodeNumber: 9 },
    ];
    const body = await (await get(await mintSession({ provider }), "?tmdbId=1399")).json();
    assert.equal(body.source, "jellyfin");
    assert.deepEqual(body.seasons, [{ seasonNumber: 9, episodes: [9] }]);
  });
}

test("a credentials/OIDC user sees both providers", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  jellyfinHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 1399, source: "jellyfin", seasonNumber: 2, episodeNumber: 1 },
  ];
  const body = await (await get(await mintSession({ provider: "oidc" }), "?tmdbId=1399")).json();
  assert.equal(body.source, "both");
});

test("provider narrowing does not skip the holder probe for the narrowed source", async () => {
  // A Plex-signin user on a restricted-only Plex instance must still be gated —
  // the two checks are an AND, not an either/or.
  registerInstance("plex", "remote", true);
  plexHolders = [{ tmdbId: 1399, serverInstance: "remote" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  const body = await (await get(await mintSession({ provider: "plex" }), "?tmdbId=1399")).json();
  assert.deepEqual(body, { source: null, seasons: [] });
});

test("the un-narrowed provider's library is never probed for a single-provider user", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  await get(await mintSession({ provider: "plex" }), "?tmdbId=1399");
  assert.equal(opsOf("jellyfinLibraryItem.findFirst").length, 0);
});

// ── season/episode shaping ───────────────────────────────────────────────────

test("the same episode present on both sources is de-duplicated", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  jellyfinHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 1399, source: "jellyfin", seasonNumber: 1, episodeNumber: 1 },
  ];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.deepEqual(body.seasons, [{ seasonNumber: 1, episodes: [1] }]);
  assert.equal(body.source, "both");
});

test("seasons and episodes sort numerically, not lexically", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 10, episodeNumber: 2 },
    { tmdbId: 1399, source: "plex", seasonNumber: 2, episodeNumber: 10 },
    { tmdbId: 1399, source: "plex", seasonNumber: 2, episodeNumber: 2 },
  ];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.deepEqual(body.seasons, [
    { seasonNumber: 2, episodes: [2, 10] },
    { seasonNumber: 10, episodes: [2] },
  ]);
});

test("season 0 (specials) is preserved and sorts first", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 1399, source: "plex", seasonNumber: 0, episodeNumber: 1 },
  ];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.deepEqual(body.seasons.map((s: { seasonNumber: number }) => s.seasonNumber), [0, 1]);
});

test("a holder with no cached episodes reports a null source and no seasons", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.deepEqual(body, { source: null, seasons: [] });
});

test("the source verdict reflects the rows actually returned, not the probed sources", async () => {
  // Both sources were probed and both hold the show, but only Plex has cached
  // episodes — the verdict must be "plex", not "both".
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  jellyfinHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [{ tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 }];
  assert.equal((await (await get(await mintSession(), "?tmdbId=1399")).json()).source, "plex");
});

test("episodes belonging to another show are never returned", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  episodes = [
    { tmdbId: 1399, source: "plex", seasonNumber: 1, episodeNumber: 1 },
    { tmdbId: 4242, source: "plex", seasonNumber: 5, episodeNumber: 5 },
  ];
  const body = await (await get(await mintSession(), "?tmdbId=1399")).json();
  assert.deepEqual(body.seasons, [{ seasonNumber: 1, episodes: [1] }]);
});

// ── rate limiting ────────────────────────────────────────────────────────────

test("the 31st request in the window is rejected 429 for that user", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  const token = await mintSession();
  for (let i = 0; i < 30; i++) {
    assert.equal((await get(token, "?tmdbId=1399")).status, 200, `request ${i + 1} should pass`);
  }
  const limited = await get(token, "?tmdbId=1399");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "Too many requests");
});

test("the rate limit is keyed per user — a second caller has their own budget", async () => {
  plexHolders = [{ tmdbId: 1399, serverInstance: "" }];
  const a = await mintSession();
  for (let i = 0; i < 31; i++) await get(a, "?tmdbId=1399");
  assert.equal((await get(a, "?tmdbId=1399")).status, 429);

  const b = await mintSession();
  assert.equal((await get(b, "?tmdbId=1399")).status, 200);
});

test("the rate limit runs before input validation, so a flood of bad ids still costs budget", async () => {
  const token = await mintSession();
  for (let i = 0; i < 30; i++) assert.equal((await get(token, "?tmdbId=bad")).status, 400);
  assert.equal((await get(token, "?tmdbId=bad")).status, 429);
});
