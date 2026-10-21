// Audit fixes (wave A, unit "release"): interactive release search and grab.
//
//   C025 — the issue Replace list (GET/POST /api/issues/[id]/releases) hands
//          out OPAQUE handles in the `guid` field, never the raw indexer guid
//          (some indexers build it from the apikey'd download link, and the
//          list reaches MANAGE_ISSUES delegates), and the grab claims a handle
//          ONCE: a raw guid is 410 with nothing sent and no CAS; two racing
//          grabs send one release.
//   C026 — a claimed handle is handed back only when the arr DEFINITELY
//          refused (a 4xx other than 408, or the title missing); a 408/5xx
//          (a gateway that gave up while the arr was sending the release to
//          the client) spends it, like a timeout.
//   C110 — the allowed/not-allowed split of a release list is by the TITLE's
//          own quality profile (the movie/series row), never the instance's
//          add default.
//
// Harness: tests/issues-routes.test.mts / tests/arr-ops-routes.test.mts —
// real wrapped handlers with a signed session JWT in a synthetic request
// scope, in-memory prisma stubs, Radarr/Sonarr scripted behind a fetch stub.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-release-test-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const errorLines: string[] = [];
console.warn = () => {};
console.error = (...a: unknown[]) => { errorLines.push(a.map(String).join(" ")); };

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
type Responder = (c: Call) => Response | Promise<Response> | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const call = { origin: url.origin, method, path: url.pathname, query: url.searchParams, body };
  calls.push(call);
  const res = await responder(call);
  if (res) return res;
  throw new Error(`unexpected ${method} ${url}`);
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
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { _resetReleaseHandlesForTests } = await import("../src/lib/release-handles.ts");
const { grabDefinitelyRefused } = await import("../src/lib/release-grab.ts");
const { ArrItemNotFoundError, ArrResponseError } = await import("../src/lib/arr.ts");
const { stripComments } = await import("./audit-fix2-R8b-tests-vacuous-source.mts");

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async () => [],
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(role = "ADMIN", permissions: bigint = Permission.ADMIN): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  usersById.set(userId, {
    role, permissions, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: permissions.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });

type IssueRow = { id: string; status: string; reportedBy: string; title: string; mediaType: "MOVIE" | "TV"; tmdbId: number; tvdbId: number | null; scope: string; seasonNumber: number | null; episodeNumber: number | null };
let issueRow: IssueRow | null = null;
let casCalls = 0;
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => (issueRow ? { ...issueRow } : null),
  updateMany: async (args: { data: Record<string, unknown> }) => {
    casCalls++;
    if (issueRow && issueRow.status !== "RESOLVED") {
      Object.assign(issueRow, args.data);
      return { count: 1 };
    }
    return { count: 0 };
  },
});
let grabRows = 0;
shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Record<string, unknown> }) => {
    grabRows++;
    return { id: `grab-${grabRows}`, ...args.data };
  },
});
type ReqRow = { id: string; mediaType: "MOVIE" | "TV"; tmdbId: number; tvdbId: number | null; status: string; arrInstance: string };
let requests: ReqRow[] = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => requests.find((r) => r.id === args.where.id) ?? null,
});
let audits: Array<{ action: string; details: unknown }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; details?: unknown } }) => {
    audits.push({ action: args.data.action, details: typeof args.data.details === "string" ? JSON.parse(args.data.details) : args.data.details });
    return {};
  },
});

const issueReleases = await import("../src/app/api/issues/[id]/releases/route.ts");
const requestReleases = await import("../src/app/api/requests/[id]/releases/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix-release.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
type Handler = (req: InstanceType<typeof NextRequest>, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(handler: unknown, token: string, path: string, id: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json", origin: "http://localhost:3000" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return inScope(() => (handler as Handler)(req, { params: Promise.resolve({ id }) }));
}
const drain = () => new Promise((r) => setTimeout(r, 10));

// ── fixtures ─────────────────────────────────────────────────────────────────
// Every test gets its own Radarr/Sonarr origin: arr.ts caches a quality
// profile per (url, profile id), so a shared origin would carry one test's
// profiles into the next.
let originSeq = 0;
let RADARR = "";
let SONARR = "";
const SECRET_GUID = "http://prowlarr.local/1/download?apikey=PLANTED-SECRET&file=x";
let releaseSeq = 0;
const release = (guid: string, extra: Record<string, unknown> = {}) => ({
  guid, title: `Some.Release.${++releaseSeq}.1080p`, size: 1e9, indexerId: 3, indexer: "NZBgeek", qualityWeight: 10, protocol: "usenet",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, age: 2, rejected: false, rejections: [], downloadAllowed: true,
  downloadUrl: "https://indexer.example/get?apikey=PLANTED-SECRET", ...extra,
});
const movieIssue = (over: Partial<IssueRow> = {}): IssueRow => ({
  id: "issue-1", status: "OPEN", reportedBy: "r", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603, tvdbId: null,
  scope: "FULL", seasonNumber: null, episodeNumber: null, ...over,
});

beforeEach(() => {
  originSeq++;
  RADARR = `http://10.0.${originSeq}.5:7878`;
  SONARR = `http://10.0.${originSeq}.7:8989`;
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  calls = [];
  audits = [];
  casCalls = 0;
  grabRows = 0;
  errorLines.length = 0;
  issueRow = null;
  requests = [];
  _resetReleaseHandlesForTests();
});

const moviePosts = () => calls.filter((c) => c.method === "POST" && c.path === "/api/v3/release");

function scriptMovieGrab(grab: (c: Call) => Response | Promise<Response>): void {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/movie") return json([{ id: 44, tmdbId: 603 }]);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([release(SECRET_GUID)]);
    if (c.method === "POST" && c.path === "/api/v3/release") return grab(c);
    return undefined;
  };
}

// ═══════════════════ C025 — issue Replace: handles + single claim ═══════════

test("C025: the issue Replace list hands out a handle in `guid` — the raw guid (an apikey carrier) never reaches the delegate", async () => {
  issueRow = movieIssue();
  scriptMovieGrab(() => json({}));
  const delegate = await mintSession("ISSUE_ADMIN", Permission.MANAGE_ISSUES);
  const res = await call(issueReleases.GET, delegate, "/issues/issue-1/releases", "issue-1");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("PLANTED-SECRET") && !text.includes("prowlarr.local"), text);
  const body = JSON.parse(text) as Array<{ guid: string; indexerId: number }>;
  assert.ok(Array.isArray(body), "the wire shape the iOS app decodes ([ArrRelease]) is unchanged");
  assert.match(body[0].guid, /^[0-9a-f]{32}$/);
  assert.equal(body[0].indexerId, 3);
});

test("C025: the grab redeems the handle into the real guid + indexer, audits the release NAME (never the guid), and spends the handle", async () => {
  issueRow = movieIssue();
  scriptMovieGrab(() => json({}));
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string; title: string }>;
  calls = [];
  // A forged indexerId in the body is ignored: the handle names the indexer.
  const res = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 99 } });
  assert.equal(res.status, 200);
  assert.deepEqual(moviePosts().map((c) => c.body), [{ guid: SECRET_GUID, indexerId: 3, movieId: 44 }]);
  assert.equal(issueRow!.status, "IN_PROGRESS");
  await drain();
  const grabAudit = audits.find((a) => (a.details as { grabId?: string }).grabId);
  assert.ok(grabAudit, "the grab is audited");
  assert.equal((grabAudit!.details as { release: string }).release, rel.title);
  assert.ok(!JSON.stringify(audits).includes("PLANTED-SECRET"), "the guid is never recorded");
  // Spent: a replay of the same handle sends nothing.
  calls = [];
  const replay = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  assert.equal(replay.status, 410);
  assert.equal(moviePosts().length, 0);
});

test("C025: a raw guid (or a handle from another issue / instance) is 410 — no arr call and no IN_PROGRESS flip", async () => {
  issueRow = movieIssue();
  scriptMovieGrab(() => json({}));
  const token = await mintSession();
  calls = [];
  const raw = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: "release-guid-123", indexerId: 3 } });
  assert.equal(raw.status, 410);
  assert.equal(moviePosts().length, 0);
  assert.equal(casCalls, 0, "an unknown handle never reaches the CAS");
  assert.equal(issueRow!.status, "OPEN");

  // A handle issued for issue-2 is no good for issue-1.
  issueRow = movieIssue({ id: "issue-2" });
  const [other] = await (await call(issueReleases.GET, token, "/issues/issue-2/releases", "issue-2")).json() as Array<{ guid: string }>;
  issueRow = movieIssue();
  calls = [];
  const crossed = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: other.guid, indexerId: 3 } });
  assert.equal(crossed.status, 410);
  assert.equal(moviePosts().length, 0);
  assert.equal(casCalls, 0);
});

test("C025: two grabs racing with one handle send the release ONCE — the second is 409 while the first is inside the arr call", { timeout: 5_000 }, async () => {
  issueRow = movieIssue();
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  scriptMovieGrab(async () => {
    entered();
    await gate;
    return json({});
  });
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string }>;
  calls = [];
  const first = call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  const reached = await Promise.race([inside.then(() => true), first.then(() => false)]);
  if (!reached) assert.fail(`the first grab never reached the arr (${(await first).status})`);
  const secondP = call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  const second = await Promise.race([secondP, new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 300))]);
  open();
  if (second === "stuck") {
    await secondP;
    assert.fail("the second grab reached the arr while the first was still inside it");
  }
  assert.equal(second.status, 409);
  assert.equal((await first).status, 200);
  assert.equal(moviePosts().length, 1, "the download client is sent the release once");
});

test("C025: an issue resolved meanwhile (CAS count 0) hands the handle back without sending anything", async () => {
  issueRow = movieIssue();
  scriptMovieGrab(() => json({}));
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string }>;
  // Resolved between the route's read and its CAS.
  const realFind = issueRow;
  let reads = 0;
  shadowPrismaModel(prisma, "issue", {
    findUnique: async () => (reads++ === 0 ? { ...realFind!, status: "OPEN" } : { ...realFind! }),
    updateMany: async () => { casCalls++; return { count: 0 }; },
  });
  try {
    calls = [];
    const res = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
    assert.equal(res.status, 409);
    assert.equal(moviePosts().length, 0);
  } finally {
    shadowPrismaModel(prisma, "issue", {
      findUnique: async () => (issueRow ? { ...issueRow } : null),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        casCalls++;
        if (issueRow && issueRow.status !== "RESOLVED") { Object.assign(issueRow, args.data); return { count: 1 }; }
        return { count: 0 };
      },
    });
  }
  // Handed back, not spent: the same handle grabs once the issue is open again.
  const ok = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  assert.equal(ok.status, 200);
  assert.equal(moviePosts().length, 1);
});

// ═══════════════════ C026 — 408/5xx spends the handle ════════════════════════

test("C026: grabDefinitelyRefused — a 4xx (not 408) or a missing title is a refusal; 408/5xx, timeouts and network errors are unknown", () => {
  for (const s of [400, 401, 404, 409, 422, 429]) assert.equal(grabDefinitelyRefused(new ArrResponseError(s, "")), true, String(s));
  for (const s of [408, 500, 502, 503, 504]) assert.equal(grabDefinitelyRefused(new ArrResponseError(s, "")), false, String(s));
  assert.equal(grabDefinitelyRefused(new ArrItemNotFoundError("gone")), true);
  assert.equal(grabDefinitelyRefused(new TypeError("fetch failed")), false);
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.equal(grabDefinitelyRefused(timeout), false);
});

for (const status of [502, 504]) {
  test(`C026: a gateway ${status} on the issue grab spends the handle — a retry is 410 and the release went out once`, async () => {
    issueRow = movieIssue();
    scriptMovieGrab(() => new Response("bad gateway", { status }));
    const token = await mintSession();
    const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string }>;
    calls = [];
    const first = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
    assert.equal(first.status, 502);
    const again = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
    assert.equal(again.status, 410, "spent: the grab may have gone through");
    assert.equal(moviePosts().length, 1);
  });

  test(`C026: a gateway ${status} on the request Pick release grab spends the handle too`, async () => {
    requests = [{ id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "" }];
    scriptMovieGrab(() => new Response("bad gateway", { status }));
    const token = await mintSession();
    const listed = await (await call(requestReleases.GET, token, "/requests/r1/releases", "r1")).json() as { releases: Array<{ guid: string }> };
    const handle = listed.releases[0].guid;
    calls = [];
    const first = await call(requestReleases.POST, token, "/requests/r1/releases", "r1", { method: "POST", body: { release: handle } });
    assert.equal(first.status, 502);
    const again = await call(requestReleases.POST, token, "/requests/r1/releases", "r1", { method: "POST", body: { release: handle } });
    assert.equal(again.status, 410);
    assert.equal(moviePosts().length, 1);
  });
}

test("C026: a definite refusal (409) still hands the issue handle back — the same release may be tried again", async () => {
  issueRow = movieIssue();
  let n = 0;
  scriptMovieGrab(() => (n++ === 0 ? json([{ errorMessage: "Download client refused it" }], 409) : json({})));
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string }>;
  const first = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  assert.equal(first.status, 409);
  const again = await call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  assert.equal(again.status, 200);
});

test("C026: every release-grab route decides the hand-back through grabDefinitelyRefused, never a bare `instanceof ArrResponseError`", () => {
  for (const file of [
    "src/app/api/issues/[id]/releases/route.ts",
    "src/app/api/requests/[id]/releases/route.ts",
    "src/app/api/admin/arr/title/releases/route.ts",
  ]) {
    // Comments stripped: a commented-out copy of the rule must not satisfy it.
    // The behaviour is pinned per route — the issue and request grabs above,
    // the title manager's in tests/audit-fix2-R8b-tests-vacuous-title-releases.test.mts.
    const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.match(src, /if \(grabDefinitelyRefused\(err\)\) releaseReleaseHandle\(/, file);
    assert.doesNotMatch(src, /instanceof ArrResponseError[\s\S]{0,120}?releaseReleaseHandle/, file);
  }
});

// ═══════════════════ C110 — the title's own quality profile ══════════════════

// Profile 1 (the instance's add default) allows only Bluray-1080p (7);
// profile 2 (the title's own) allows 1080p AND Remux-2160p (19).
const PROFILES = [
  { id: 1, items: [{ quality: { id: 7 }, allowed: true }, { quality: { id: 19 }, allowed: false }] },
  { id: 2, items: [{ quality: { id: 7 }, allowed: true }, { quality: { id: 19 }, allowed: true }] },
];
// The arr ranks the 2160p release first (releaseWeight 0) for this title.
const RANKED = () => [
  release("g-1080", { quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, releaseWeight: 1 }),
  release("g-2160", { quality: { quality: { id: 19, name: "Remux-2160p" }, revision: { version: 1 } }, releaseWeight: 0 }),
];

test("C110: a movie's Pick release list is split by the MOVIE's own profile, not the instance's add default — the arr's top pick stays first", async () => {
  settings.set("radarrQualityProfileId", "1");
  requests = [{ id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "" }];
  responder = (c) => {
    if (c.path === "/api/v3/movie") return json([{ id: 44, tmdbId: 603, qualityProfileId: 2 }]);
    if (c.path === "/api/v3/qualityprofile") return json(PROFILES);
    if (c.path === "/api/v3/release") return json(RANKED());
    return undefined;
  };
  const token = await mintSession();
  const body = await (await call(requestReleases.GET, token, "/requests/r1/releases", "r1")).json() as { releases: Array<{ quality: { quality: { id: number } } }> };
  assert.deepEqual(body.releases.map((r) => r.quality.quality.id), [19, 7]);
});

test("C110: the issue Replace list for a season follows the SERIES' own profile too", async () => {
  settings.set("sonarrQualityProfileId", "1");
  issueRow = { id: "issue-tv", status: "OPEN", reportedBy: "r", title: "Show", mediaType: "TV", tmdbId: 1399, tvdbId: 121361, scope: "SEASON", seasonNumber: 1, episodeNumber: null };
  responder = (c) => {
    if (c.path === "/api/v3/series") return json([{ id: 8, tvdbId: 121361, qualityProfileId: 2 }]);
    if (c.path === "/api/v3/qualityprofile") return json(PROFILES);
    if (c.path === "/api/v3/release") return json(RANKED());
    return undefined;
  };
  const token = await mintSession();
  const body = await (await call(issueReleases.GET, token, "/issues/issue-tv/releases", "issue-tv")).json() as Array<{ quality: { quality: { id: number } } }>;
  assert.deepEqual(body.map((r) => r.quality.quality.id), [19, 7]);
});

test("C110: a title whose own profile rejects a quality still sends that release last; a row with no profile keeps the arr's order", async () => {
  settings.set("radarrQualityProfileId", "2");
  requests = [{ id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "" }];
  let profileId: number | undefined = 1;
  responder = (c) => {
    if (c.path === "/api/v3/movie") return json([{ id: 44, tmdbId: 603, ...(profileId !== undefined ? { qualityProfileId: profileId } : {}) }]);
    if (c.path === "/api/v3/qualityprofile") return json(PROFILES);
    if (c.path === "/api/v3/release") return json(RANKED());
    return undefined;
  };
  const token = await mintSession();
  const own = await (await call(requestReleases.GET, token, "/requests/r1/releases", "r1")).json() as { releases: Array<{ quality: { quality: { id: number } } }> };
  assert.deepEqual(own.releases.map((r) => r.quality.quality.id), [7, 19], "profile 1 (the movie's) does not allow 2160p");
  profileId = undefined;
  // The instance's add default now REJECTS 2160p (profile 1): were a row with
  // no profile to fall back to it (the C110 bug), the split would come out
  // [7, 19]. With default 2 both paths agree and the leg could not tell.
  settings.set("radarrQualityProfileId", "1");
  const none =await (await call(requestReleases.GET, token, "/requests/r1/releases", "r1")).json() as { releases: Array<{ quality: { quality: { id: number } } }> };
  assert.deepEqual(none.releases.map((r) => r.quality.quality.id), [19, 7], "no profile on the row: the arr's own order");
});
