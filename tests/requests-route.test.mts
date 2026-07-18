// Route-level unit tests for the media-request API (src/app/api/requests/route.ts):
//   POST /api/requests — create a request (the app's central chokepoint)
//   GET  /api/requests — the paged/scoped request list
//
// Guardrail-23 angle here is the OTHER sanctioned pattern (vs. the votes
// route's outside-the-tx gate): the request insert runs inside a Serializable
// $transaction where the unique-violating create is the tx's LAST op, so a
// concurrent duplicate's P2002 PROPAGATES out of the transaction and the outer
// catch maps it to 409 "Already requested" — nothing after the throw runs
// in-tx, no side effect (SSE, vote-clear, admin notify) fires for the loser,
// and the response is never a phantom 201. Also pinned: the P2034
// write-conflict retry around the same tx (runWithSerializableRetry — a quota
// race retries into a clean 201 instead of a 500), and the in-tx quota
// re-check that turns a concurrent over-quota create into 429 with no row.
//
// The rest of the surface pinned here:
//   - authentication (401 before any business read) and the GET visibility
//     scope: MANAGE_REQUESTS holders see every request (relation include),
//     everyone else only their own (narrow select), plus statusCounts;
//   - the gates in front of the insert: Discord-link requirement, the
//     Setting-driven per-user rate limit, guardrail-30 body caps, field/token
//     validation, blacklist, and the parental content-rating cap;
//   - multi-instance resolution (guardrail 32): explicit `arrInstance` slug
//     validated against the registry (unknown → 400, unconfigured → 400,
//     ungranted-but-explicit → hard 403), the legacy `is4k:true` shorthand
//     mapping to the "4k" instance (whose skipLibraryCheck ignores the shared
//     library), and `routeMediaToSlug` auto-routing — an anime-genre TMDB
//     payload (genre 16 + ja, served from the seeded details cache with ZERO
//     wire fetches) lands on the granted anime instance and falls back to the
//     default for a user without the grant (auto-route never 403s);
//   - quota: the pre-check 429 (per-user override window label) and the in-tx
//     re-check race path;
//   - dedupe semantics: PENDING duplicate → 409, permanently-declined → 403,
//     a plain DECLINED row is CAS-deleted (status+permanentlyDeclined predicate)
//     and re-requested fresh;
//   - the already-available short-circuit (library hit → 200, no row);
//   - branch behavior: auto-approve creates APPROVED with the 90s
//     pendingNotifyAt backstop and, on an ARR push failure, CAS-rolls back to
//     PENDING (status-guarded updateMany) with a corrective SSE and a 201
//     PENDING body; mirror-approved copies a greenlit row's status (AVAILABLE
//     gains availableAt) and never alerts admins; the plain pending branch
//     emits SSE, clears the caller's contradictory deletion vote, and enqueues
//     the admin notify fan-out via after() only when no earlier pending peer
//     exists (notify channel INTERNALS are owned by their own test files — here
//     the unconfigured channels must short-circuit before any network).
//
// Harness: withAuth-wrapped handlers invoked as real route functions with a
// NextRequest + REAL signed session JWT over in-memory authSession/user stubs
// (tests/api-auth.test.mts idiom); maintenanceGuard's cookies() and the notify
// after() run inside a synthetic work/request async-storage scope whose work
// store records after() tasks (tests/maintenance.test.mts idiom, extended);
// $transaction is a recording stub with tx-tagged ops (tests/
// discord-merge.test.mts idiom); dns.lookup is stubbed and globalThis.fetch is
// a recording thrower — every test asserts its wire budget (the only test that
// EXPECTS a fetch is the quality-profile 502 path, where the throw IS the
// scripted outage).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/*.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "requests-route-test-secret-0123456789abcdef"; // session JWT + request token HMAC
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token"; // tmdb.ts reads it at call time
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── DNS stub (tests/tmdb.test.mts pattern) — safe-fetch resolves the admin-
// configured ARR host before fetching; no real lookup may leave the process.
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

// ── recording fetch: every wire attempt is logged, none succeeds ────────────
const fetchCalls: URL[] = [];
let fetchImpl: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — this test's flow must be satisfied from stubs/caches");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return fetchImpl(url);
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { Prisma } = await import("@/generated/prisma");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { generateRequestToken } = await import("../src/lib/request-token.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { invalidateBlacklistCache } = await import("../src/lib/blacklist.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");

// ── recorded SSE events ─────────────────────────────────────────────────────
const sseEvents: Array<Record<string, unknown>> = [];
sseEmitter.on("event", (e: Record<string, unknown>) => { sseEvents.push(e); });

// ── recording op log (business models only) ─────────────────────────────────
type Op = { op: string; args?: unknown; inTx: boolean };
const ops: Op[] = [];
let txDepth = 0;
let txCalls = 0;
const rec = (op: string, args?: unknown) => { ops.push({ op, args, inTx: txDepth > 0 }); };
function opsOf(name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

// ── auth fixture + the route's own user read (one shared user table) ────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  // POST /api/requests selects these off the same row:
  discordId: string | null;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
  maxContentRating: string | null;
  instanceGrants: unknown;
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
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: {
  role?: string;
  permissions?: string;
  discordId?: string | null;
  movieQuotaLimit?: number | null;
  movieQuotaDays?: number | null;
  maxContentRating?: string | null;
  instanceGrants?: unknown;
} = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `requester-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0"; // unseeded ⇒ USER preset (base requester)
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `requester-${seq}@example.com`,
    notificationEmail: null,
    discordId: opts.discordId ?? null,
    movieQuotaLimit: opts.movieQuotaLimit ?? null,
    movieQuotaDays: opts.movieQuotaDays ?? null,
    tvQuotaLimit: null,
    tvQuotaDays: null,
    maxContentRating: opts.maxContentRating ?? null,
    instanceGrants: opts.instanceGrants ?? null,
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

// ── Setting stub (registry, connections, quota, rate limit, notify config) ──
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

function seedAnimeInstance(opts: { configured?: boolean } = {}): void {
  settings.set(
    "arrRadarrInstances",
    JSON.stringify([
      {
        slug: "anime",
        name: "Anime",
        restricted: true,
        serverAll: false,
        skipLibraryCheck: false,
        autoRoute: { animeOnly: true },
      },
    ]),
  );
  if (opts.configured !== false) {
    settings.set("radarrAnimeUrl", "http://radarr-anime.example.com:7878");
    settings.set("radarrAnimeApiKey", "anime-api-key");
  }
}
function seedFourKInstance(): void {
  settings.set("radarr4kUrl", "http://radarr-4k.example.com:7878");
  settings.set("radarr4kApiKey", "4k-api-key");
}

// ── mediaRequest stub — the tx create/count are per-test scriptable ─────────
let reqSeq = 0;
function defaultCreate(args: { data: Record<string, unknown> }): Record<string, unknown> {
  return {
    id: `req-${++reqSeq}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    status: "PENDING",
    note: null,
    qualityProfileId: null,
    availableAt: null,
    pendingNotifyAt: null,
    tvdbId: null,
    permanentlyDeclined: false,
    ...args.data,
  };
}
let createImpls: Array<(args: { data: Record<string, unknown> }) => Record<string, unknown>> = [];
let requestCounts: number[] = []; // shifted per mediaRequest.count call
let existingRow: Record<string, unknown> | null = null; // the caller's own prior request
let greenlitRow: { status: string } | null = null; // any APPROVED/AVAILABLE peer
let earlierPendingRow: { id: string } | null = null; // an earlier pending peer (notify dedupe)
let listRows: Array<Record<string, unknown>> = [];
let statusGroups: Array<{ status: string; _count: { status: number } }> = [];
const mediaRequestModel = {
  findFirst: async (args: { where: Record<string, unknown> }) => {
    rec("mediaRequest.findFirst", args);
    const w = args.where ?? {};
    if ("requestedBy" in w) return existingRow; // the pre-tx duplicate check
    if (w.status && typeof w.status === "object" && "in" in (w.status as object)) return greenlitRow;
    if (w.id && typeof w.id === "object" && "not" in (w.id as object)) return earlierPendingRow;
    return null;
  },
  count: async (args: unknown) => {
    rec("mediaRequest.count", args);
    return requestCounts.shift() ?? 0;
  },
  create: async (args: { data: Record<string, unknown> }) => {
    rec("mediaRequest.create", args);
    const impl = createImpls.shift() ?? defaultCreate;
    return impl(args);
  },
  deleteMany: async (args: unknown) => {
    rec("mediaRequest.deleteMany", args);
    return { count: 1 };
  },
  updateMany: async (args: unknown) => {
    rec("mediaRequest.updateMany", args);
    return { count: 1 };
  },
  update: async (args: unknown) => {
    rec("mediaRequest.update", args);
    return {};
  },
  findMany: async (args: unknown) => {
    rec("mediaRequest.findMany", args);
    return listRows;
  },
  groupBy: async (args: unknown) => {
    rec("mediaRequest.groupBy", args);
    return statusGroups;
  },
};
shadowPrismaModel(prisma, "mediaRequest", mediaRequestModel);

// resolveMediaMeta prefers the pre-warmed TmdbMediaCore row — serving it from
// the stub keeps TMDB entirely off the wire (its live shape is owned by
// tests/request-meta.test.mts).
let metaRow: { title: string; posterPath: string | null; releaseYear: string } | null = {
  title: "The Matrix",
  posterPath: "/matrix.jpg",
  releaseYear: "1999",
};
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findUnique: async () => metaRow,
});

// The details cache backs auto-routing metadata and the certification read.
// Seeded blobs carry every lazy-upgrade trigger field (null, not undefined) so
// getMovieDetails serves the row with zero fetches and zero rewrites.
type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const detailsRows = new Map<string, CacheRow>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => detailsRows.get(args.where.key) ?? null,
  upsert: async (args: { where: { key: string } }) => args,
  deleteMany: async () => ({ count: 0 }),
  delete: async (args: { where: { key: string } }) => args,
});
function seedMovieDetails(tmdbId: number, over: Record<string, unknown> = {}): void {
  const media = {
    id: tmdbId,
    mediaType: "movie",
    title: "Ghost in the Shell",
    posterPath: "/gits.jpg",
    releaseYear: "1995",
    releaseDate: "1995-11-18",
    originalLanguage: "en",
    genreList: [{ id: 878, name: "Science Fiction" }],
    imdbRating: null,
    rtAudienceScore: null,
    traktRating: null,
    mdblistScore: null,
    letterboxdRating: null,
    malRating: null,
    rogerEbertRating: null,
    ...over,
  };
  detailsRows.set(`movie:${tmdbId}:details`, {
    key: `movie:${tmdbId}:details`,
    data: JSON.stringify(media),
    cachedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

let blacklistRows: Array<{ tmdbId: number; mediaType: string }> = [];
shadowPrismaModel(prisma, "blacklistItem", {
  findMany: async () => blacklistRows,
});

let plexHas = false;
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
shadowPrismaModel(prisma, "radarrAvailableItem", {
  findUnique: async (args: unknown) => {
    rec("radarrAvailableItem.findUnique", args);
    return null;
  },
});
shadowPrismaModel(prisma, "sonarrAvailableItem", {
  findUnique: async () => null,
});
shadowPrismaModel(prisma, "deletionVote", {
  deleteMany: async (args: unknown) => {
    rec("deletionVote.deleteMany", args);
    return { count: 0 };
  },
});
// The pending-branch notify fan-out reads push subscriptions; empty ⇒ the push
// channel short-circuits (channel internals are owned by tests/push.test.mts).
shadowPrismaModel(prisma, "pushSubscription", {
  findMany: async () => [],
});

// $transaction stub: callback form (the request insert) tags ops inTx and
// PROPAGATES the callback's rejection — the abort semantics the route's outer
// catch depends on. Array form covers any batched shape.
const txObj = { mediaRequest: mediaRequestModel };
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
const { GET: listRequests, POST: postRequest } = await import("../src/app/api/requests/route.ts");

// ── synthetic request scope with a recording afterContext ───────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/requests-route.test",
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

function requestsReq(token: string | null, init: { method: string; body?: string; query?: string }): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000/api/requests${init.query ?? ""}`, {
    method: init.method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

async function post(token: string | null, body: unknown, rawBody?: string): Promise<Response> {
  const req = requestsReq(token, { method: "POST", body: rawBody ?? JSON.stringify(body) });
  return inScope(() => postRequest(req, undefined));
}

async function list(token: string, query = ""): Promise<Response> {
  return inScope(() => listRequests(requestsReq(token, { method: "GET", query }), undefined));
}

// A well-formed request body with a genuine HMAC token for this user.
function requestBody(userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
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

const createdData = (i = 0): Record<string, unknown> =>
  (opsOf("mediaRequest.create")[i].args as { data: Record<string, unknown> }).data;

beforeEach(() => {
  ops.length = 0;
  txCalls = 0;
  txDepth = 0;
  afterTasks.length = 0;
  sseEvents.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  createImpls = [];
  requestCounts = [];
  existingRow = null;
  greenlitRow = null;
  earlierPendingRow = null;
  listRows = [];
  statusGroups = [];
  metaRow = { title: "The Matrix", posterPath: "/matrix.jpg", releaseYear: "1999" };
  detailsRows.clear();
  blacklistRows = [];
  plexHas = false;
  jellyfinHas = false;
  invalidateFeatureFlagCache();
  invalidateBlacklistCache(); // 30s memo would otherwise leak a prior test's block
  fetchImpl = () => {
    throw new Error("unexpected fetch — this test's flow must be satisfied from stubs/caches");
  };
});

// ── auth + GET scope ────────────────────────────────────────────────────────

test("POST without a session → 401 Unauthorized; the handler body never runs", async () => {
  const res = await post(null, { tmdbId: 603, mediaType: "MOVIE" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.equal(ops.length, 0);
});

test("GET scopes a plain USER to their own requests (narrow select) while MANAGE_REQUESTS sees everything (relation include), and maps statusCounts", async () => {
  listRows = [{ id: "req-1", title: "The Matrix", status: "PENDING" }];
  statusGroups = [
    { status: "PENDING", _count: { status: 2 } },
    { status: "APPROVED", _count: { status: 1 } },
  ];

  const user = await mintSession();
  const own = await list(user.token, "?status=PENDING&q=matrix");
  assert.equal(own.status, 200);
  const ownBody = (await own.json()) as { statusCounts: unknown; total: number; pageSize: number };
  assert.deepEqual(ownBody.statusCounts, { PENDING: 2, APPROVED: 1 });
  assert.equal(ownBody.pageSize, 20);
  const ownArgs = opsOf("mediaRequest.findMany")[0].args as {
    where: Record<string, unknown>;
    select?: unknown;
    include?: unknown;
  };
  assert.equal(ownArgs.where.requestedBy, user.userId, "a plain user must only see their own rows");
  assert.equal(ownArgs.where.status, "PENDING");
  assert.deepEqual(ownArgs.where.title, { contains: "matrix", mode: "insensitive" });
  assert.ok(ownArgs.select, "the non-manager path uses the narrow select");
  assert.equal(ownArgs.include, undefined);
  // The chip counts honor q but ignore the selected status filter.
  const groupArgs = opsOf("mediaRequest.groupBy")[0].args as { where: Record<string, unknown> };
  assert.equal(groupArgs.where.status, undefined);

  ops.length = 0;
  const manager = await mintSession({ permissions: String(Permission.MANAGE_REQUESTS) });
  const all = await list(manager.token);
  assert.equal(all.status, 200);
  const allArgs = opsOf("mediaRequest.findMany")[0].args as {
    where: Record<string, unknown>;
    include?: unknown;
  };
  assert.equal(allArgs.where.requestedBy, undefined, "MANAGE_REQUESTS must see every user's requests");
  assert.ok(allArgs.include, "the manager path includes the requesting user relation");
});

// ── pre-body gates ──────────────────────────────────────────────────────────

test("the site-wide Discord-link requirement blocks unlinked users with 403 and passes linked ones through", async () => {
  settings.set("discordRequireLinkedAccountSite", "true");

  const unlinked = await mintSession();
  const blocked = await post(unlinked.token, requestBody(unlinked.userId));
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), {
    error: "You must link your Discord account before making requests",
  });

  const linked = await mintSession({ discordId: "123456789012345678" });
  const through = await post(linked.token, {});
  assert.equal(through.status, 400, "a linked user reaches ordinary body validation");
});

test("the Setting-driven request rate limit 429s past the cap with Retry-After", async () => {
  settings.set("rateLimitRequests", "1");
  const { token } = await mintSession();
  const first = await post(token, {});
  assert.equal(first.status, 400, "the first call consumes the bucket and fails validation instead");
  const second = await post(token, {});
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "60");
  assert.deepEqual(await second.json(), { error: "Too many requests — try again later" });
});

test("body handling: oversized → 413 (64 KB cap), malformed → 400, missing ids → 400, missing token → 403, over-long note → 400", async () => {
  const { userId, token } = await mintSession();

  const oversized = await post(token, null, JSON.stringify({ note: "x".repeat(70_000) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "Request body too large (max 64KB)" });

  const malformed = await post(token, null, "{not json");
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request body" });

  const missing = await post(token, {});
  assert.deepEqual(await missing.json(), { error: "tmdbId and mediaType are required" });

  const tokenless = await post(token, { tmdbId: 603, mediaType: "MOVIE" });
  assert.equal(tokenless.status, 403);
  assert.deepEqual(await tokenless.json(), { error: "Invalid or expired request token" });

  const longNote = await post(token, requestBody(userId, { note: "n".repeat(501) }));
  assert.equal(longNote.status, 400);
  assert.deepEqual(await longNote.json(), { error: "note must be a string under 500 characters" });
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

// ── instance resolution (guardrail 32) ──────────────────────────────────────

test("an unknown instance slug → 400, and a registered-but-unconfigured named instance → 400", async () => {
  const a = await mintSession();
  const unknown = await post(a.token, requestBody(a.userId, { arrInstance: "plex9000" }));
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "That instance isn't available for requests" });

  seedAnimeInstance({ configured: false });
  const b = await mintSession({ instanceGrants: { anime: { request: true } } });
  const unconfigured = await post(b.token, requestBody(b.userId, { arrInstance: "anime" }));
  assert.equal(unconfigured.status, 400);
  assert.deepEqual(await unconfigured.json(), {
    error: 'Requests to "Anime" aren\'t available — that instance isn\'t configured',
  });
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

test("an EXPLICITLY targeted restricted instance without a grant is a hard 403; with the per-user grant the request lands on that instance", async () => {
  seedAnimeInstance();

  const ungranted = await mintSession();
  const denied = await post(ungranted.token, requestBody(ungranted.userId, { arrInstance: "anime" }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "You don't have permission to request this" });
  assert.equal(opsOf("mediaRequest.create").length, 0);

  const granted = await mintSession({ instanceGrants: { anime: { request: true } } });
  const res = await post(granted.token, requestBody(granted.userId, { arrInstance: "anime" }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.arrInstance, "anime");
  assert.equal(body.status, "PENDING");
  assert.equal(createdData().arrInstance, "anime");
  assert.equal(opsOf("mediaRequest.create")[0].inTx, true, "the insert runs inside the Serializable tx");
});

test("auto-routing: an anime-genre TMDB payload (cache-served, zero fetches) routes to the granted anime instance and FALLS BACK to the default without the grant — never a 403", async () => {
  seedAnimeInstance();
  seedMovieDetails(603, { genreList: [{ id: 16, name: "Animation" }], originalLanguage: "ja" });

  const granted = await mintSession({ instanceGrants: { anime: { request: true } } });
  const routed = await post(granted.token, requestBody(granted.userId)); // no arrInstance, no is4k
  assert.equal(routed.status, 201);
  assert.equal(((await routed.json()) as Record<string, unknown>).arrInstance, "anime");
  assert.equal(createdData().arrInstance, "anime");
  assert.equal(fetchCalls.length, 0, "routing metadata must come from the details cache, not the wire");

  ops.length = 0;
  const ungranted = await mintSession();
  const fallback = await post(ungranted.token, requestBody(ungranted.userId));
  assert.equal(fallback.status, 201, "a server-side routing decision must never block a base requester");
  assert.equal(((await fallback.json()) as Record<string, unknown>).arrInstance, "");
  assert.equal(createdData().arrInstance, "");
});

test("the legacy is4k:true shorthand maps to the '4k' instance, skips the shared-library check, and gates on the REQUEST_4K bits", async () => {
  seedFourKInstance();
  plexHas = true; // in the shared library — must NOT suppress a 4K request

  const no4k = await mintSession(); // base requester without any 4K bit
  const denied = await post(no4k.token, requestBody(no4k.userId, { is4k: true }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "You don't have permission to request this" });

  const with4k = await mintSession({ permissions: String(Permission.REQUEST | Permission.REQUEST_4K) });
  const res = await post(with4k.token, requestBody(with4k.userId, { is4k: true }));
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as Record<string, unknown>).arrInstance, "4k");
  assert.equal(createdData().arrInstance, "4k");
  assert.equal(
    opsOf("plexLibraryItem.findUnique").length,
    0,
    "skipLibraryCheck: a library copy at another quality must not block the 4K request",
  );
});

test("quality-profile override: gated on REQUEST_ADVANCED, integer-validated, rejected against an unconfigured instance, and an ARR outage maps to 502 — not 500", async () => {
  const plain = await mintSession();
  const noPerm = await post(plain.token, requestBody(plain.userId, { qualityProfileId: 3 }));
  assert.equal(noPerm.status, 403);
  assert.deepEqual(await noPerm.json(), { error: "You don't have permission to choose a quality profile" });

  const advanced = await mintSession({ permissions: String(Permission.REQUEST | Permission.REQUEST_ADVANCED) });
  const badId = await post(advanced.token, requestBody(advanced.userId, { qualityProfileId: 0 }));
  assert.equal(badId.status, 400);
  assert.deepEqual(await badId.json(), { error: "qualityProfileId must be a positive integer" });

  // Default instance with no ARR configured: listQualityProfiles returns null
  // → the picked id can't be validated → 400.
  const unvalidatable = await post(advanced.token, requestBody(advanced.userId, { qualityProfileId: 3 }));
  assert.equal(unvalidatable.status, 400);
  assert.deepEqual(await unvalidatable.json(), { error: "Invalid quality profile for this request" });

  // A CONFIGURED instance whose ARR is down: the profile fetch failure maps to
  // a clean 502 (the scripted fetch throw IS the outage).
  seedFourKInstance();
  const adv4k = await mintSession({
    permissions: String(Permission.REQUEST | Permission.REQUEST_4K | Permission.REQUEST_ADVANCED),
  });
  const outage = await post(adv4k.token, requestBody(adv4k.userId, { is4k: true, qualityProfileId: 3 }));
  assert.equal(outage.status, 502);
  assert.deepEqual(await outage.json(), { error: "Could not connect to radarr" });
  assert.equal(fetchCalls.length, 1, "exactly the one profile fetch was attempted");
  assert.ok(errors.some((e) => e.includes("[requests] Failed to fetch radarr profiles")));
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

// ── quota ───────────────────────────────────────────────────────────────────

test("the quota pre-check 429s an over-quota user with the per-user override's window label, before any TMDB/library work", async () => {
  const { userId, token } = await mintSession({ movieQuotaLimit: 1, movieQuotaDays: 3 });
  requestCounts = [1]; // already at the override limit
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), {
    error: "You have reached your request quota of 1 per 3 days",
  });
  const countArgs = opsOf("mediaRequest.count")[0].args as { where: Record<string, unknown> };
  assert.equal(countArgs.where.requestedBy, userId);
  assert.equal(countArgs.where.mediaType, "MOVIE");
  assert.deepEqual(countArgs.where.status, { notIn: ["DECLINED"] }, "declined rows never consume quota");
  assert.equal(txCalls, 0);
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

test("the IN-TX quota re-check catches a concurrent race: pre-check passes, tx count is at the limit → 429 with no row created", async () => {
  settings.set("quotaLimit", "2");
  settings.set("quotaPeriod", "week");
  const { userId, token } = await mintSession();
  requestCounts = [0, 2]; // pre-check clean; a concurrent create filled the window before the tx count
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), {
    error: "You have reached your request quota of 2 per week",
  });
  assert.equal(txCalls, 1, "QUOTA_EXCEEDED is not a write conflict — no serializable retry");
  assert.equal(opsOf("mediaRequest.count")[1].inTx, true, "the re-check must run inside the tx");
  assert.equal(opsOf("mediaRequest.create").length, 0);
  assert.deepEqual(sseEvents, []);
});

// ── the tx create: guardrail-23 propagate pattern + the P2034 retry ─────────

test("a concurrent duplicate's P2002 propagates out of the tx (the create is the LAST op) and maps to 409 with ZERO side effects", async () => {
  createImpls = [() => { throw prismaKnownError("P2002"); }];
  const { userId, token } = await mintSession();
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "Already requested" });
  assert.equal(txCalls, 1, "P2002 is not retried — it must surface on the first attempt");
  // Guardrail 23: nothing may run after the throwing create, in-tx or out.
  assert.equal(ops[ops.length - 1].op, "mediaRequest.create");
  assert.deepEqual(sseEvents, [], "no SSE for a request that never committed");
  assert.equal(afterTasks.length, 0, "no admin notify for a request that never committed");
  assert.equal(opsOf("deletionVote.deleteMany").length, 0, "no vote-clear for a request that never committed");
});

test("a Serializable write conflict (P2034) is retried into a clean 201 — the whole tx re-runs once", async () => {
  createImpls = [() => { throw prismaKnownError("P2034"); }]; // attempt 1 aborts; attempt 2 falls back to the default create
  const { userId, token } = await mintSession();
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 201);
  assert.equal(txCalls, 2, "runWithSerializableRetry must re-run the transaction");
  assert.equal(opsOf("mediaRequest.create").length, 2);
  assert.equal(((await res.json()) as Record<string, unknown>).status, "PENDING");
});

// ── availability + duplicate semantics ──────────────────────────────────────

test("a title already in a library short-circuits with 200 { alreadyAvailable } and creates nothing", async () => {
  plexHas = true;
  const { userId, token } = await mintSession();
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    alreadyAvailable: true,
    tmdbId: 603,
    mediaType: "MOVIE",
    title: "The Matrix",
  });
  assert.equal(opsOf("mediaRequest.create").length, 0);
  assert.deepEqual(sseEvents, []);
  assert.equal(afterTasks.length, 0);
});

test("duplicates: PENDING → 409; permanently declined → 403; a plain DECLINED row is CAS-deleted and re-requested fresh", async () => {
  const a = await mintSession();
  existingRow = { id: "req-old", status: "PENDING", permanentlyDeclined: false };
  const dup = await post(a.token, requestBody(a.userId));
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: "Already requested" });
  assert.equal(txCalls, 0, "a visible duplicate never opens the tx");

  const b = await mintSession();
  existingRow = { id: "req-banned", status: "DECLINED", permanentlyDeclined: true };
  const banned = await post(b.token, requestBody(b.userId));
  assert.equal(banned.status, 403);
  assert.deepEqual(await banned.json(), { error: "This request has been permanently denied" });

  ops.length = 0;
  const c = await mintSession();
  existingRow = { id: "req-declined", status: "DECLINED", permanentlyDeclined: false };
  const retried = await post(c.token, requestBody(c.userId));
  assert.equal(retried.status, 201, "an ordinary decline is not terminal — the user may re-request");
  // The stale-row delete is a CAS on status + permanentlyDeclined so a racing
  // re-approve or fresh permanent ban survives (deleteMany, never delete).
  assert.deepEqual((opsOf("mediaRequest.deleteMany")[0].args as { where: unknown }).where, {
    id: "req-declined",
    status: "DECLINED",
    permanentlyDeclined: false,
  });
  assert.equal(opsOf("mediaRequest.create").length, 1);
});

// ── branch behavior ─────────────────────────────────────────────────────────

test("auto-approve creates APPROVED with the 90s pendingNotifyAt backstop; a failed ARR push CAS-rolls back to PENDING with a corrective SSE and a 201 PENDING body", async () => {
  // AUTO_APPROVE on the (unconfigured) default instance: the create succeeds,
  // then addMovieToRadarr throws "not configured" — the documented outage shape.
  const { userId, token } = await mintSession({
    permissions: String(Permission.REQUEST | Permission.AUTO_APPROVE),
  });
  const before = Date.now();
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 201);

  const data = createdData();
  assert.equal(data.status, "APPROVED");
  const pendingNotifyAt = data.pendingNotifyAt as Date;
  assert.ok(pendingNotifyAt instanceof Date);
  const offset = pendingNotifyAt.getTime() - before;
  assert.ok(offset >= 80_000 && offset <= 100_000, `pendingNotifyAt must arm the ~90s backstop (got ${offset}ms)`);

  // The rollback is status-guarded (CAS) so a concurrent AVAILABLE flip could
  // never be clobbered back to PENDING.
  const rollback = opsOf("mediaRequest.updateMany")[0].args as { where: Record<string, unknown>; data: unknown };
  assert.equal(rollback.where.status, "APPROVED");
  assert.deepEqual(rollback.data, { status: "PENDING", pendingNotifyAt: null });

  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "PENDING", "the response must reflect the rolled-back state, not the stale APPROVED row");
  assert.deepEqual(
    sseEvents.map((e) => e.type),
    ["request:new", "request:updated"],
    "the client that saw request:new must also see the corrective update",
  );
  assert.equal((sseEvents[1] as { status?: string }).status, "PENDING");
  assert.ok(errors.some((e) => e.includes("[arr] Auto-approve push failed")));
  assert.equal(afterTasks.length, 0, "auto-approve never fires the admin new-request alert");
});

test("a greenlit peer is mirrored: APPROVED copies the status, AVAILABLE also stamps availableAt — and admins are never re-alerted", async () => {
  greenlitRow = { status: "APPROVED" };
  const a = await mintSession();
  const approved = await post(a.token, requestBody(a.userId));
  assert.equal(approved.status, 201);
  assert.equal(createdData().status, "APPROVED");
  assert.equal(createdData().availableAt, undefined);
  assert.equal(afterTasks.length, 0, "nothing to review ⇒ no admin alert");
  assert.deepEqual(sseEvents.map((e) => e.type), ["request:new"]);

  ops.length = 0;
  sseEvents.length = 0;
  greenlitRow = { status: "AVAILABLE" };
  const b = await mintSession();
  const available = await post(b.token, requestBody(b.userId));
  assert.equal(available.status, 201);
  assert.equal(createdData().status, "AVAILABLE");
  assert.ok(createdData().availableAt instanceof Date, "mirroring AVAILABLE must stamp availableAt");
});

test("the pending branch: first pending request emits SSE, clears the caller's contradictory deletion vote, and enqueues ONE admin notify fan-out that completes offline; an earlier pending peer suppresses it", async () => {
  const a = await mintSession();
  const res = await post(a.token, requestBody(a.userId, { note: "please and thank you" }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "PENDING");
  assert.equal(body.note, "please and thank you");
  assert.deepEqual(sseEvents.map((e) => e.type), ["request:new"]);

  // A request and a deletion vote for the same title are contradictory.
  assert.deepEqual((opsOf("deletionVote.deleteMany")[0].args as { where: unknown }).where, {
    userId: a.userId,
    tmdbId: 603,
    mediaType: "MOVIE",
  });

  // Exactly one notify fan-out enqueued; with nothing configured every channel
  // (email/push/discord) must short-circuit before the network.
  assert.equal(afterTasks.length, 1);
  const wireBefore = fetchCalls.length;
  await afterTasks[0]();
  assert.equal(fetchCalls.length, wireBefore, "unconfigured notify channels must never reach the network");
  assert.deepEqual(errors, []);

  // An EARLIER pending peer for the same (tmdbId, mediaType, instance) means
  // this duplicate must not re-alert the admins.
  afterTasks.length = 0;
  earlierPendingRow = { id: "req-earlier" };
  const b = await mintSession();
  const second = await post(b.token, requestBody(b.userId));
  assert.equal(second.status, 201);
  assert.equal(afterTasks.length, 0, "only the earliest pending request alerts admins");
});

// ── content gates ───────────────────────────────────────────────────────────

test("an admin-blacklisted title can never be requested (403), before any row is created", async () => {
  blacklistRows = [{ tmdbId: 603, mediaType: "MOVIE" }];
  const { userId, token } = await mintSession();
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "This title has been blocked by an administrator" });
  assert.equal(txCalls, 0);
  assert.equal(opsOf("mediaRequest.create").length, 0);
});

test("the parental content-rating cap blocks a capped user when the cached certification exceeds it (403)", async () => {
  seedMovieDetails(603, { certification: "R" });
  const { userId, token } = await mintSession({ maxContentRating: "PG-13" });
  const res = await post(token, requestBody(userId));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "This title's rating exceeds your account's limit" });
  assert.equal(fetchCalls.length, 0, "the certification is read from the details cache, not the wire");
  assert.equal(opsOf("mediaRequest.create").length, 0);
});
