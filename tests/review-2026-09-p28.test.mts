// Review 2026-09 / P28 — OpenAPI spec parity pins (f49, f50, f51, f52).
//
// scripts/audit-openapi.mts only checks path/method parity, so parameter
// enums, response status codes and permission labels in the spec can drift
// from the handlers without anything going red. These pins tie the four
// drifted spots back to the route they describe:
//
//   f49  GET  /requests           sort enum == the route's VALID_SORTS (no "title")
//   f50  POST /requests           201 → MediaRequest on create; 200 is the
//                                 alreadyAvailable short-circuit, not a request
//   f51  POST /admin/users        password minLength 12 (what the route enforces)
//   f52  PATCH /requests/{id} and PATCH /admin/users/{id} are labeled with the
//        MANAGE_* permission their withPermission wrapper gates on, not "(ADMIN)"
//
// The 2026-10 audit of the arr management routes added the g-openapi pins at the
// bottom: the title manager's edit/add rules, the blocklist's paging hint, its
// "too old" 404 and the clear's `count`, the shared arrGate/arrFailure error map
// on every /admin/arr/* operation, the Missing search's 429, and the release
// routes' 202 / busy-409 / 503. Each spec claim is coupled to the handler (or
// the parser it calls), so the spec can't be "fixed" back without a red test.
//
// The spec is served by a withPermission(ADMIN) handler, so it is fetched
// through the same synthetic request scope + in-memory prisma stubs the
// setup-events-openapi suite uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load; the server preamble normally provides it.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "review-2026-09-p28-openapi-secret-0123";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
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
const { Permission } = await import("../src/lib/permissions.ts");

const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => usersById.get(args.where.id) ?? null,
  findMany: async () => [],
  count: async () => 1,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}),
});

const openapi = await import("../src/app/api/openapi/route.ts");

function inScope<T>(fn: () => Promise<T>, cookie?: string): Promise<T> {
  const workStore = {
    route: "/review-2026-09-p28.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers(cookie ? { cookie } : {});
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

async function mintAdmin(): Promise<string> {
  const userId = "u-admin";
  const sessionId = "sess-admin";
  usersById.set(userId, {
    id: userId, name: "Admin", email: "admin@example.com", role: "ADMIN",
    permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

type SchemaProp = {
  minLength?: number;
  description?: string;
  nullable?: boolean;
  items?: { required?: string[] };
};
type Spec = {
  paths: Record<string, Record<string, {
    summary?: string;
    description?: string;
    parameters?: Array<{ name: string; in: string; schema?: { enum?: string[]; minimum?: number; maximum?: number } }>;
    requestBody?: { content: Record<string, { schema: { properties: Record<string, SchemaProp> } }> };
    responses: Record<string, {
      description: string;
      headers?: Record<string, unknown>;
      content?: Record<string, { schema: Record<string, unknown> }>;
    }>;
  }>>;
};

let cached: Spec | null = null;
async function getSpec(): Promise<Spec> {
  if (cached) return cached;
  const token = await mintAdmin();
  const cookie = `${getSessionCookieName()}=${token}`;
  const res = await inScope(() => openapi.GET(new NextRequest("http://localhost:3000/api/openapi", {
    method: "GET", headers: { cookie },
  }), undefined), cookie);
  assert.equal(res.status, 200);
  cached = (await res.json()) as Spec;
  return cached;
}

// Mirrors `VALID_SORTS` in src/app/api/requests/route.ts (module-private).
// tests/requests-route.test.mts pins the handler side; this pins the spec side.
const REQUESTS_VALID_SORTS = ["newest", "oldest"];

test("f49: GET /requests sort enum matches the handler's VALID_SORTS (no phantom title sort)", async () => {
  const spec = await getSpec();
  const sort = spec.paths["/requests"].get.parameters?.find((p) => p.name === "sort");
  assert.ok(sort, "sort query parameter is documented");
  assert.deepEqual(sort.schema?.enum, REQUESTS_VALID_SORTS);
});

test("f50: POST /requests documents 201 → MediaRequest and 200 as the alreadyAvailable short-circuit", async () => {
  const spec = await getSpec();
  const responses = spec.paths["/requests"].post.responses;
  assert.ok(responses["201"], "every create path in the handler answers 201");
  assert.deepEqual(
    responses["201"].content?.["application/json"].schema,
    { $ref: "#/components/schemas/MediaRequest" },
  );
  const ok = responses["200"].content?.["application/json"].schema as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.ok(ok?.properties?.alreadyAvailable, "the 200 body is the alreadyAvailable shape, not a MediaRequest");
  assert.deepEqual([...(ok.required ?? [])].sort(), ["alreadyAvailable", "mediaType", "title", "tmdbId"]);
  assert.equal(responses["409"].description, "Duplicate request");
});

test("f51: POST /admin/users password minLength matches the route's 12-char floor", async () => {
  const spec = await getSpec();
  const body = spec.paths["/admin/users"].post.requestBody?.content["application/json"].schema;
  // src/app/api/admin/users/route.ts, the create-user form, register and
  // profile/password all share the 12-char floor (the admin path was 8).
  assert.equal(body?.properties.password.minLength, 12);
});

test("f52: the two PATCH operations are labeled with their withPermission gate, not (ADMIN)", async () => {
  const spec = await getSpec();
  const requestPatch = spec.paths["/requests/{id}"].patch;
  const userPatch = spec.paths["/admin/users/{id}"].patch;
  assert.match(requestPatch.summary ?? "", /\(MANAGE_REQUESTS\)$/);
  assert.match(userPatch.summary ?? "", /\(MANAGE_USERS\)$/);
  assert.doesNotMatch(requestPatch.summary ?? "", /\(ADMIN\)/);
  assert.doesNotMatch(userPatch.summary ?? "", /\(ADMIN\)/);
  // The ADMIN-only sub-branch (role promotion / editing an ADMIN) stays documented.
  assert.match(userPatch.description ?? "", /ADMIN/);
});

// ── 2026-10 audit: arr management spec parity (g-openapi#1–#6) ──────────────

const { parseTitleEdit } = await import("../src/lib/arr-title.ts");
const { parseTitleAdd } = await import("../src/lib/arr-title-add.ts");

const routeSource = (path: string) => readFileSync(new URL(`../src/app/api${path}/route.ts`, import.meta.url), "utf8");

/** Each exported handler's own source, by method — handlers are contiguous `export const METHOD =` blocks. */
function handlerSlices(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const marks = [...src.matchAll(/^export const (GET|POST|PATCH|DELETE|PUT) =/gm)];
  marks.forEach((m, i) => out.set(m[1].toLowerCase(), src.slice(m.index, marks[i + 1]?.index ?? src.length)));
  return out;
}

test("g-openapi#1: PATCH /admin/arr/title documents `seasons` as its own write and the other service's fields as 400", async () => {
  const spec = await getSpec();
  const patch = spec.paths["/admin/arr/title"].patch;
  const props = patch.requestBody?.content["application/json"].schema.properties ?? {};
  assert.match(patch.description ?? "", /`seasons` is its own write/);
  assert.match(patch.description ?? "", /other service/);
  assert.match(props.seasons?.description ?? "", /must be sent alone/);
  assert.deepEqual([...(props.seasons?.items?.required ?? [])].sort(), ["monitored", "seasonNumber"]);
  assert.match(props.minimumAvailability?.description ?? "", /Radarr only/);
  for (const k of ["seriesType", "seasonFolder", "monitorNewItems"]) assert.match(props[k]?.description ?? "", /Sonarr only/, k);
  assert.match(patch.responses["400"].description, /`seasons` combined with other fields/);
  assert.match(patch.responses["400"].description, /other service/);
  assert.match(patch.responses["200"].description, /null when the re-read/);

  // …and the parser behind it says the same.
  const seasons = [{ seasonNumber: 1, monitored: false }];
  assert.equal(parseTitleEdit("sonarr", { monitored: true, seasons }), null, "seasons with another field");
  assert.ok(parseTitleEdit("sonarr", { seasons }), "seasons alone");
  assert.equal(parseTitleEdit("sonarr", { seasons: [{ seasonNumber: 1 }] }), null, "a season without `monitored`");
  assert.equal(parseTitleEdit("radarr", { seriesType: "anime" }), null, "a Sonarr field sent to Radarr");
  assert.equal(parseTitleEdit("sonarr", { minimumAvailability: "released" }), null, "a Radarr field sent to Sonarr");
});

test("g-openapi#1: GET /admin/arr/title types the instance's choice lists as nullable", async () => {
  const spec = await getSpec();
  const schema = spec.paths["/admin/arr/title"].get.responses["200"].content?.["application/json"].schema as {
    properties: Record<string, SchemaProp>;
  };
  for (const k of ["qualityProfiles", "rootFolders", "tags"]) {
    assert.equal(schema.properties[k]?.nullable, true, k);
    assert.match(schema.properties[k]?.description ?? "", /null when the instance failed/, k);
  }
  // TitleState's lists are `Choice[] | null` — readCatalogTolerant answers null per failed list.
  assert.match(readFileSync(new URL("../src/lib/arr-title-data.ts", import.meta.url), "utf8"), /qualityProfiles: Choice\[\] \| null;/);
});

test("g-openapi#2: POST /admin/arr/title/add marks `monitored` (Radarr) and `monitor` (Sonarr) required; GET lists its 400", async () => {
  const spec = await getSpec();
  const add = spec.paths["/admin/arr/title/add"];
  const props = add.post.requestBody?.content["application/json"].schema.properties ?? {};
  assert.match(props.monitored?.description ?? "", /Radarr — required/);
  assert.match(props.monitor?.description ?? "", /Sonarr — required/);
  assert.match(add.post.description ?? "", /Radarr REQUIRES `monitored`/);
  assert.match(add.post.description ?? "", /Sonarr REQUIRES `monitor`/);
  assert.match(add.post.responses["400"].description, /without `monitored`/);
  assert.match(add.get.responses["400"]?.description ?? "", /tmdbId/, "GET answers 400 for an invalid tmdbId");

  const base = { tmdbId: 603, qualityProfileId: 1, rootFolderPath: "/movies", search: true };
  assert.equal(parseTitleAdd("radarr", base), null, "Radarr without monitored");
  assert.ok(parseTitleAdd("radarr", { ...base, monitored: true }));
  assert.equal(parseTitleAdd("sonarr", base), null, "Sonarr without monitor");
  assert.ok(parseTitleAdd("sonarr", { ...base, monitor: "all" }));
  assert.equal(parseTitleAdd("sonarr", { ...base, monitor: "all", monitored: true }), null, "a Radarr field sent to Sonarr");
  assert.equal(parseTitleAdd("radarr", { ...base, monitored: true, seasonFolder: true }), null, "a Sonarr field sent to Radarr");
});

test("g-openapi#3: the blocklist documents DELETE's page hint, the 'too old' 404 and the clear's `count`", async () => {
  const spec = await getSpec();
  const blocklist = spec.paths["/admin/arr/blocklist"];
  const names = (blocklist.delete.parameters ?? []).map((p) => p.name);
  assert.ok(names.includes("page") && names.includes("pageSize"), names.join(","));
  assert.equal(blocklist.delete.parameters?.find((p) => p.name === "pageSize")?.schema?.maximum, 100);
  for (const m of ["get", "delete"]) {
    assert.match(blocklist[m].responses["404"]?.description ?? "", /older than the \/blocklist API/, m);
    assert.match(blocklist[m].responses["400"]?.description ?? "", /paging|page\/pageSize/, m);
  }
  const clear = spec.paths["/admin/arr/blocklist/clear"].post.requestBody?.content["application/json"].schema.properties ?? {};
  assert.ok(clear.count, "the clear body documents `count`");
  assert.match(clear.count.description ?? "", /audit/);

  // The handlers read exactly these.
  const del = handlerSlices(routeSource("/admin/arr/blocklist")).get("delete") ?? "";
  assert.match(del, /q\.has\("page"\) \|\| q\.has\("pageSize"\)/);
  assert.match(routeSource("/admin/arr/blocklist"), /BlocklistUnsupportedError[\s\S]*status: 404/);
  assert.match(routeSource("/admin/arr/blocklist/clear"), /body\.count/);
  assert.equal(Number(/MAX_PAGE_SIZE = (\d+)/.exec(readFileSync(new URL("../src/lib/arr-history.ts", import.meta.url), "utf8"))?.[1]), 100);
});

// Operations under /admin/arr/ that do NOT answer the shared arrGate/arrFailure
// map, and why. Every other operation must list it.
const ARR_ERROR_EXEMPT: Record<string, string> = {
  "get /admin/arr/open": "its own gate; a failed read redirects to the instance's home page, never a 502",
  "get /admin/arr/calendar": "fan-out report: a failed instance is named in errors[]",
  "get /admin/arr/tasks": "fan-out report: a failed instance is named in errors[]",
  "get /admin/arr/storage": "fan-out report: a failed instance is named in errors[]",
  "get /admin/arr/providers": "fan-out report, or a job poll replaying PATCH's own answer",
  "get /admin/arr/providers/test": "a job poll replaying POST's own answer",
};

test("g-openapi#4: every /admin/arr/* operation behind arrFailure lists its 404, 502 and 504 — and only those", async () => {
  const spec = await getSpec();
  const ops = Object.entries(spec.paths)
    .filter(([path]) => path.startsWith("/admin/arr/"))
    .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));
  assert.ok(ops.length >= 25, `found only ${ops.length} /admin/arr/ operations`);
  const seenExempt = new Set<string>();
  for (const { path, method, op } of ops) {
    const key = `${method} ${path}`;
    const handler = handlerSlices(routeSource(path)).get(method);
    assert.ok(handler, `${key}: no ${method.toUpperCase()} handler in the route file`);
    const failsThroughMap = /arrFailure\(|\bfailure\(/.test(handler);
    if (key in ARR_ERROR_EXEMPT) {
      seenExempt.add(key);
      assert.equal(failsThroughMap, false, `${key} is exempt (${ARR_ERROR_EXEMPT[key]}) but its handler calls arrFailure`);
      // …and the spec must not claim the shared answers it never sends.
      for (const status of ["502", "504"]) assert.equal(op.responses[status], undefined, `${key} lists ${status} it never answers`);
      continue;
    }
    assert.equal(failsThroughMap, true, `${key} lists the shared arr errors but its handler never calls arrFailure — exempt it with a reason`);
    for (const status of ["404", "502", "504"]) assert.ok(op.responses[status], `${key} is missing ${status}`);
  }
  assert.deepEqual([...seenExempt].sort(), Object.keys(ARR_ERROR_EXEMPT).sort(), "a stale exemption");

  // Route-specific wording still wins over the shared text.
  assert.match(spec.paths["/admin/arr/providers"].patch.responses["504"].description, /does not hold it/);
  assert.match(spec.paths["/admin/arr/title"].get.responses["404"].description, /doesn't have the title/);
  assert.match(spec.paths["/admin/arr/title/files"].delete.responses["502"].description, /part-way/);
});

test("g-openapi#5: POST /admin/missing/search documents its 429 and Retry-After", async () => {
  const spec = await getSpec();
  const post = spec.paths["/admin/missing/search"].post;
  assert.ok(post.responses["429"], "429 documented");
  assert.ok(post.responses["429"].headers?.["Retry-After"], "Retry-After documented");
  assert.match(post.responses["429"].description, /120 per minute/);
  assert.match(post.description ?? "", /Retry-After/);
  const src = routeSource("/admin/missing/search");
  assert.match(src, /const LIMIT_PER_MIN = 120;/);
  assert.match(src, /tooManyRequests\(/);
});

test("g-openapi#6: the release routes document the background 202, the busy 409 and the maintenance 503", async () => {
  const spec = await getSpec();
  const req = spec.paths["/requests/{id}/releases"];
  assert.ok(req.get.responses["202"], "GET documents 202 { job }");
  assert.match(req.get.responses["404"].description, /job is gone/);
  assert.ok(req.post.responses["503"], "POST documents the maintenance 503");
  assert.match(req.post.responses["409"].description, /already in progress/);
  assert.match(req.post.responses["200"].description, /ok: true/);
  const admin = spec.paths["/admin/arr/title/releases"];
  assert.match(admin.post.responses["409"].description, /already in progress/);
  assert.match(admin.post.responses["200"].description, /ok: true/);
  assert.match(admin.get.responses["404"].description, /job is gone/);

  // The handlers answer exactly that.
  const reqPost = handlerSlices(routeSource("/requests/[id]/releases")).get("post") ?? "";
  assert.match(reqPost, /maintenanceGuard\(session\)/);
  assert.match(reqPost, /picked === "busy"\) return NextResponse\.json\(.*\{ status: 409 \}\);/);
  assert.match(handlerSlices(routeSource("/admin/arr/title/releases")).get("post") ?? "", /picked === "busy"\) return NextResponse\.json\(.*\{ status: 409 \}\);/);
});
