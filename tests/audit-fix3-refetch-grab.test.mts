// An issue's Refetch (PATCH /api/issues/[id] `{ refetch: true, instance? }`)
// records an instance-scoped IssueGrab once Radarr/Sonarr ACCEPTED its search,
// so the Download webhooks tell the admin the refetched copy landed — as Replace
// release and Replace file already did (src/lib/issue-grab.ts, guardrail 5f).
//
// Why: Refetch queued a search and recorded nothing, so the webhook's IssueGrab
// match never fired for it — the admin who refetched was never told the new
// download arrived, while the same admin's Replace release on the same issue was.
//
// Pinned:
//  - an accepted movie search records ONE grab with the issue's scope, the
//    caller's instance slug and the admin as `triggeredById`; the response is
//    the unchanged `{ ...issue, arrError: null }` (the iOS app decodes it);
//  - the grab is the one the webhooks claim: a Download from ANOTHER instance
//    leaves it pending, one from the refetched instance claims it;
//  - a TV refetch records the tvdbId it RESOLVED (the stored one was null), and
//    Sonarr's per-season match applies: another season's Download leaves it
//    pending, the issue's season claims it;
//  - it supersedes the same admin's earlier pending grab of the issue on that
//    instance (one import, one announcement — recordIssueGrab);
//  - a refused search records nothing and still answers `arrError`;
//  - a failed record (P2003 — the issue deleted meanwhile) never changes the
//    answer: the status CAS still runs and the answer is still the success one;
//  - a failed status write after an accepted search still answers `arrError`
//    as it did before — and the grab is already recorded.
//
// Harness: tests/issues-routes.test.mts (real signed session JWT, synthetic
// work/request async-storage scope from tests/maintenance.test.mts, recording
// fetch, DNS stub) plus the in-memory IssueGrab table and webhook stubs of
// tests/audit-fix-issue-grab.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "refetch-grab-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
Math.random = () => 0.5;

// Recording fetch. Outside a scripted refetch every wire attempt is refused —
// the webhooks then read their live verify as "unreachable" (null) and proceed.
const fetchCalls: URL[] = [];
const refuse = (url: URL): Response => { throw new Error(`scripted network refusal: ${url.href}`); };
let fetchImpl: (url: URL, init?: RequestInit) => Response | Promise<Response> = refuse;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return fetchImpl(url, init);
}) as typeof fetch;
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
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
const { arrSettingKey } = await import("../src/lib/arr-instances.ts");

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
let userSeq = 0;
async function mintAdmin(): Promise<{ userId: string; token: string }> {
  userSeq++;
  const userId = `admin-${userSeq}`;
  const sessionId = `sess-${userSeq}`;
  usersById.set(userId, {
    role: "ADMIN",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `${userId}@example.com`,
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: "ADMIN", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();

// ── Setting stub (arr config, webhook secrets, features, maintenance) ────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  createMany: async () => ({ count: 0 }),
  deleteMany: async () => ({ count: 0 }),
});

// ── Issue table: findUnique hands out SNAPSHOTS (the route's captured `issue`
// must not mutate under it); updateMany applies the CAS predicate. ──────────
type IssueRow = {
  id: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED";
  reportedBy: string;
  title: string;
  mediaType: "MOVIE" | "TV";
  tmdbId: number;
  tvdbId: number | null;
  scope: "FULL" | "SEASON" | "EPISODE";
  seasonNumber: number | null;
  episodeNumber: number | null;
};
const issues = new Map<string, IssueRow>();
let issueUpdateThrows = false;
const issueCas: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "issue", {
  findUnique: async (args: { where: { id: string } }) => {
    const row = issues.get(args.where.id);
    return row ? { ...row } : null;
  },
  updateMany: async (args: { where: { id: string; status?: { not: string } }; data: Partial<IssueRow> }) => {
    issueCas.push(args.where);
    if (issueUpdateThrows) throw new Error("stubbed status write failure");
    const row = issues.get(args.where.id);
    if (!row || (args.where.status && row.status === args.where.status.not)) return { count: 0 };
    Object.assign(row, args.data);
    return { count: 1 };
  },
});

// ── IssueGrab table, with the Issue relation filter the webhooks send ────────
type GrabRow = {
  id: string;
  createdAt: Date;
  issueId: string;
  triggeredById: string;
  tmdbId: number;
  tvdbId: number | null;
  mediaType: "MOVIE" | "TV";
  title: string;
  scope: "FULL" | "SEASON" | "EPISODE";
  seasonNumber: number | null;
  episodeNumber: number | null;
  arrInstance: string;
  notifiedAt: Date | null;
};
const grabs: GrabRow[] = [];
let clock = Date.parse("2026-10-01T00:00:00Z");
let createThrows = false;
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [field, cond] of Object.entries(where)) {
    if (field === "OR") {
      if (!(cond as Record<string, unknown>[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    if (field === "issue") {
      if (!matches({ status: issues.get(row.issueId as string)?.status ?? "OPEN" }, cond as Record<string, unknown>)) return false;
      continue;
    }
    const v = row[field];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, x] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "not" && (x === null ? v === null : v === x)) return false;
        else if (op === "lt" && !((v as Date).getTime() < (x as Date).getTime())) return false;
        else if (op === "in" && !(x as unknown[]).includes(v)) return false;
        else if (op !== "not" && op !== "lt" && op !== "in") throw new Error(`unsupported operator ${op} on ${field}`);
      }
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}
shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Omit<GrabRow, "id" | "createdAt" | "notifiedAt"> }) => {
    if (createThrows) throw new Error("P2003: Foreign key constraint violated on IssueGrab_issueId_fkey");
    const row: GrabRow = { id: `grab-${grabs.length + 1}`, createdAt: new Date((clock += 1000)), notifiedAt: null, ...args.data };
    grabs.push(row);
    return { ...row };
  },
  findMany: async (args: { where: Record<string, unknown> }) =>
    grabs.filter((g) => matches(g as unknown as Record<string, unknown>, args.where)).map((g) => ({ ...g })),
  updateMany: async (args: { where: Record<string, unknown>; data: Partial<GrabRow> }) => {
    let count = 0;
    for (const g of grabs) {
      if (!matches(g as unknown as Record<string, unknown>, args.where)) continue;
      Object.assign(g, args.data);
      count++;
    }
    return { count };
  },
  update: async (args: { where: { id: string }; data: Partial<GrabRow> }) => {
    const g = grabs.find((x) => x.id === args.where.id)!;
    Object.assign(g, args.data);
    return { ...g };
  },
});

// ── what the PATCH's audit/notify and the Download webhooks touch ────────────
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [], update: async () => ({}) });
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });
const replay = new Set<string>();
shadowPrismaModel(prisma, "webhookReplay", {
  create: async (args: { data: { digest: string; expiresAt: Date } }) => { replay.add(args.data.digest); return args.data; },
  updateMany: async () => ({ count: 0 }),
  delete: async (args: { where: { digest: string } }) => { replay.delete(args.where.digest); return { digest: args.where.digest }; },
  deleteMany: async () => ({ count: 0 }),
});
const mediaRequestStub = { updateMany: async () => ({ count: 0 }), findMany: async () => [], findFirst: async () => null };
shadowPrismaModel(prisma, "mediaRequest", mediaRequestStub);
const cacheStub = { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) };
for (const model of ["radarrWantedItem", "radarrAvailableItem", "sonarrWantedItem", "sonarrAvailableItem"]) {
  shadowPrismaModel(prisma, model, cacheStub);
}
shadowPrismaModel(prisma, "deletionVote", { deleteMany: async () => ({ count: 0 }) });
const txDelegates = {
  $executeRaw: async () => 0,
  mediaRequest: mediaRequestStub,
  radarrWantedItem: cacheStub,
  radarrAvailableItem: cacheStub,
  sonarrWantedItem: cacheStub,
  sonarrAvailableItem: cacheStub,
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  typeof arg === "function" ? (arg as (tx: typeof txDelegates) => Promise<unknown>)(txDelegates) : Promise.all(arg as Promise<unknown>[]),
);

const { PATCH: patchIssueRoute } = await import("../src/app/api/issues/[id]/route.ts");
const { POST: radarrPOST } = await import("../src/app/api/webhooks/radarr/route.ts");
const { POST: sonarrPOST } = await import("../src/app/api/webhooks/sonarr/route.ts");

// ── synthetic request scope (tests/maintenance.test.mts); after() is recorded,
// never run — it would open the library-scan debounce timers. ────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/audit-fix3-refetch-grab.test",
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

async function refetch(token: string, id: string, body: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/issues/${id}`, {
    method: "PATCH",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ refetch: true, ...body }),
  });
  return inScope(() => patchIssueRoute(req, { params: Promise.resolve({ id }) }));
}

const SECRETS = {
  radarr: { "": "radarr-default-secret", "4k": "radarr-4k-secret" },
  sonarr: { "": "sonarr-default-secret", "4k": "sonarr-4k-secret" },
} as const;
let ip = 0;
async function deliver(service: "radarr" | "sonarr", instance: "" | "4k", body: Record<string, unknown>): Promise<number> {
  fetchImpl = refuse;
  const req = new NextRequest(`http://localhost:3000/api/webhooks/${service}?token=${SECRETS[service][instance]}`, {
    method: "POST",
    headers: { "x-forwarded-for": `203.0.113.${(ip++ % 200) + 1}` },
    body: JSON.stringify(body),
  });
  const handler = (service === "radarr" ? radarrPOST : sonarrPOST) as unknown as (r: unknown) => Promise<Response>;
  const res = await inScope(() => handler(req));
  return res.status;
}

// Scripted Radarr: the movie is in the library and the search command is accepted.
function radarrAccepts(url: URL): Response {
  if (url.pathname === "/api/v3/movie") return jsonResponse([{ id: 42, tmdbId: 603 }]);
  if (url.pathname === "/api/v3/command") return jsonResponse({ id: 1001, name: "MoviesSearch", status: "queued" });
  throw new Error(`unexpected Radarr fetch: ${url.href}`);
}

const MATRIX: IssueRow = {
  id: "issue-movie", status: "OPEN", reportedBy: "reporter-1", title: "The Matrix", mediaType: "MOVIE",
  tmdbId: 603, tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null,
};
const SHOW: IssueRow = {
  id: "issue-show", status: "OPEN", reportedBy: "reporter-1", title: "Game of Thrones", mediaType: "TV",
  tmdbId: 1399, tvdbId: null, scope: "SEASON", seasonNumber: 2, episodeNumber: null,
};

const pending = () => grabs.filter((g) => g.notifiedAt === null);
// Read through a call: after `assert.equal(x, null)` TypeScript narrows a plain
// property read to `null`, and a later `instanceof Date` on it would not compile.
const claimedAt = (i: number): Date | null => grabs[i].notifiedAt;

beforeEach(() => {
  settings.clear();
  for (const service of ["radarr", "sonarr"] as const) {
    for (const slug of ["", "4k"] as const) {
      settings.set(arrSettingKey(service, slug, "Url"), `http://${service}${slug ? `-${slug}` : ""}.example.com:7878`);
      settings.set(arrSettingKey(service, slug, "ApiKey"), `${service}-${slug || "default"}-key`);
      settings.set(arrSettingKey(service, slug, "WebhookSecret"), SECRETS[service][slug]);
    }
  }
  issues.clear();
  grabs.length = 0;
  issueCas.length = 0;
  replay.clear();
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  createThrows = false;
  issueUpdateThrows = false;
  fetchImpl = refuse;
});

test("an accepted movie refetch records ONE instance-scoped grab, answers the unchanged shape, and the refetched instance's Download claims it", async () => {
  issues.set(MATRIX.id, { ...MATRIX });
  const admin = await mintAdmin();
  fetchImpl = radarrAccepts;

  const res = await refetch(admin.token, MATRIX.id, { instance: "4k" });
  assert.equal(res.status, 200);
  // The wire shape the iOS app decodes: the (re-read) issue plus arrError: null.
  assert.deepEqual(await res.json(), { ...MATRIX, status: "IN_PROGRESS", arrError: null });
  assert.ok(fetchCalls.some((u) => u.host === "radarr-4k.example.com:7878" && u.pathname === "/api/v3/command"), "the search went to the 4K instance");

  assert.equal(grabs.length, 1, "exactly one grab is recorded for the accepted search");
  const { id: _id, createdAt: _createdAt, ...recorded } = grabs[0];
  assert.deepEqual(recorded, {
    issueId: MATRIX.id,
    triggeredById: admin.userId,
    tmdbId: 603,
    tvdbId: null,
    mediaType: "MOVIE",
    title: "The Matrix",
    scope: "FULL",
    seasonNumber: null,
    episodeNumber: null,
    arrInstance: "4k",
    notifiedAt: null,
  });

  // The default instance's import is a different copy — it must not claim the 4K refetch.
  assert.equal(await deliver("radarr", "", { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } }), 200);
  assert.equal(grabs[0].notifiedAt, null, "another instance's Download leaves the refetch's grab pending");

  assert.equal(await deliver("radarr", "4k", { eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } }), 200);
  assert.ok(claimedAt(0) instanceof Date, "the refetched instance's Download claims it — the admin is told it landed");
});

test("a TV refetch records the tvdbId it RESOLVED, and Sonarr's per-season match claims it only for the issue's season", async () => {
  issues.set(SHOW.id, { ...SHOW });
  const admin = await mintAdmin();
  const commands: Array<Record<string, unknown>> = [];
  fetchImpl = (url, init) => {
    if (url.pathname === "/api/v3/series") return jsonResponse([{ id: 9, tvdbId: 121361, tmdbId: 1399 }]);
    if (url.pathname === "/api/v3/command") {
      commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ id: 2002 });
    }
    throw new Error(`unexpected Sonarr fetch: ${url.href}`);
  };

  const res = await refetch(admin.token, SHOW.id, {});
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { arrError: unknown }).arrError, null);
  assert.deepEqual(commands, [{ name: "SeasonSearch", seriesId: 9, seasonNumber: 2 }]);

  assert.equal(grabs.length, 1);
  assert.equal(grabs[0].tvdbId, 121361, "the resolved tvdbId is recorded — a Download may carry only that id");
  assert.equal(grabs[0].arrInstance, "", "an absent instance is the default, as the search was");
  assert.equal(grabs[0].scope, "SEASON");
  assert.equal(grabs[0].seasonNumber, 2);

  // The payload carries ONLY the tvdbId, so only the resolved id can match it.
  const download = (season: number) => ({
    eventType: "Download",
    series: { tvdbId: 121361, title: "Game of Thrones" },
    episodes: [{ seasonNumber: season, episodeNumber: 1 }],
  });
  assert.equal(await deliver("sonarr", "", download(1)), 200);
  assert.equal(grabs[0].notifiedAt, null, "another season's import is not the refetched season");
  assert.equal(await deliver("sonarr", "", download(2)), 200);
  assert.ok(claimedAt(0) instanceof Date, "the issue's season landing claims the refetch's grab");
});

test("the refetch's grab supersedes the same admin's earlier pending grab of the issue on that instance", async () => {
  issues.set(MATRIX.id, { ...MATRIX, status: "IN_PROGRESS" });
  const admin = await mintAdmin();
  const other = await mintAdmin();
  const earlier = (triggeredById: string, arrInstance: string): GrabRow => {
    const row: GrabRow = {
      id: `seed-${grabs.length + 1}`, createdAt: new Date((clock += 1000)), issueId: MATRIX.id, triggeredById,
      tmdbId: 603, tvdbId: null, mediaType: "MOVIE", title: "The Matrix", scope: "FULL",
      seasonNumber: null, episodeNumber: null, arrInstance, notifiedAt: null,
    };
    grabs.push(row);
    return row;
  };
  const mine = earlier(admin.userId, "4k"); // e.g. this admin's Replace release a minute ago
  const theirs = earlier(other.userId, "4k");
  const mineOtherInstance = earlier(admin.userId, "");
  fetchImpl = radarrAccepts;

  assert.equal((await refetch(admin.token, MATRIX.id, { instance: "4k" })).status, 200);

  assert.ok(mine.notifiedAt instanceof Date, "the same admin's earlier pending grab is retired — one import, one announcement");
  assert.equal(theirs.notifiedAt, null, "another admin's grab is not a duplicate — its push goes to that admin");
  assert.equal(mineOtherInstance.notifiedAt, null, "another instance's grab matches other deliveries");
  assert.deepEqual(
    pending().filter((g) => g.triggeredById === admin.userId && g.arrInstance === "4k").map((g) => g.id),
    [grabs[3].id],
    "exactly the refetch's own row is pending for this admin on 4K",
  );
});

test("a search the arr refused records NOTHING and still answers arrError", async () => {
  issues.set(MATRIX.id, { ...MATRIX });
  const admin = await mintAdmin();
  // Radarr is reachable but doesn't hold the movie: searchMovieInRadarr throws before any command.
  fetchImpl = (url) => {
    if (url.pathname === "/api/v3/movie") return jsonResponse([]);
    throw new Error(`unexpected Radarr fetch: ${url.href}`);
  };

  const res = await refetch(admin.token, MATRIX.id, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...MATRIX, arrError: "Arr service request failed" });
  assert.equal(grabs.length, 0, "nothing was queued, so nothing may be announced later");
  assert.equal(issueCas.length, 0, "the status is not moved for a failed search");
  assert.ok(!fetchCalls.some((u) => u.pathname === "/api/v3/command"));
});

test("a failed grab record (the issue deleted meanwhile) never changes the answer — the CAS still runs and the refetch reads as accepted", async () => {
  issues.set(MATRIX.id, { ...MATRIX });
  const admin = await mintAdmin();
  fetchImpl = radarrAccepts;
  createThrows = true;

  const res = await refetch(admin.token, MATRIX.id, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...MATRIX, status: "IN_PROGRESS", arrError: null }, "a 502/arrError would make the admin queue a second search");
  assert.equal(issueCas.length, 1, "the status CAS still ran");
  assert.ok(warns.some((w) => w.includes("Refetch search queued but recording the grab failed")), "the failure is logged, not swallowed silently");
});

test("a failed status write AFTER an accepted search answers arrError as before — and the grab is already recorded", async () => {
  issues.set(MATRIX.id, { ...MATRIX });
  const admin = await mintAdmin();
  fetchImpl = radarrAccepts;
  issueUpdateThrows = true;

  const res = await refetch(admin.token, MATRIX.id, { instance: "4k" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...MATRIX, arrError: "Arr service request failed" });
  assert.equal(grabs.length, 1, "the search was accepted, so its download is still announced");
  assert.equal(grabs[0].arrInstance, "4k");
});

test("a refused refetch (RESOLVED issue, malformed instance) contacts no arr and records no grab", async () => {
  issues.set(MATRIX.id, { ...MATRIX, status: "RESOLVED" });
  const admin = await mintAdmin();
  fetchImpl = radarrAccepts;
  assert.equal((await refetch(admin.token, MATRIX.id, {})).status, 409);

  issues.set(MATRIX.id, { ...MATRIX });
  assert.equal((await refetch(admin.token, MATRIX.id, { instance: "../../etc" })).status, 400);

  assert.equal(fetchCalls.length, 0);
  assert.equal(grabs.length, 0);
});

// Refetch is an UPGRADE search of the issue's own scope — the arr only replaces a
// file on disk with an upgrade — so each scope sends that scope's own search:
// EPISODE → EpisodeSearch, SEASON → SeasonSearch, FULL → SeriesSearch. The
// "never SeriesSearch" rule belongs to the MISSING-only actions (Missing page,
// title manager Search missing, the request queue's Search, Replace file's
// follow-up); a FULL refetch routed through the Missing plan would queue nothing
// whenever every episode is on disk, i.e. exactly when the issue is about the
// files themselves.
test("a refetch searches the issue's own scope: FULL → SeriesSearch, EPISODE → EpisodeSearch (SEASON → SeasonSearch above)", async () => {
  const admin = await mintAdmin();
  const commands: Array<Record<string, unknown>> = [];
  fetchImpl = (url, init) => {
    if (url.pathname === "/api/v3/series") return jsonResponse([{ id: 9, tvdbId: 121361, tmdbId: 1399 }]);
    if (url.pathname === "/api/v3/episode") return jsonResponse([{ id: 501, seriesId: 9, seasonNumber: 3, episodeNumber: 4 }]);
    if (url.pathname === "/api/v3/command") {
      commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ id: 2003 });
    }
    throw new Error(`unexpected Sonarr fetch: ${url.href}`);
  };

  issues.set("issue-full", { ...SHOW, id: "issue-full", scope: "FULL", seasonNumber: null });
  assert.equal(((await (await refetch(admin.token, "issue-full", {})).json()) as { arrError: unknown }).arrError, null);
  assert.deepEqual(commands, [{ name: "SeriesSearch", seriesId: 9 }]);

  commands.length = 0;
  issues.set("issue-ep", { ...SHOW, id: "issue-ep", scope: "EPISODE", seasonNumber: 3, episodeNumber: 4 });
  assert.equal(((await (await refetch(admin.token, "issue-ep", {})).json()) as { arrError: unknown }).arrError, null);
  // Read through a fresh binding: the deepEqual above narrowed `commands` to the
  // SeriesSearch literal shape, which has no episodeIds.
  const sent: Array<Record<string, unknown>> = commands;
  assert.deepEqual(sent, [{ name: "EpisodeSearch", episodeIds: [501] }]);
});
