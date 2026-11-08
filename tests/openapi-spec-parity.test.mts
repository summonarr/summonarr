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
process.env.NEXTAUTH_SECRET = "openapi-spec-parity-secret-0123";
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
const { handlerCalls } = await import("./_openapi-spec.mts");

function inScope<T>(fn: () => Promise<T>, cookie?: string): Promise<T> {
  const workStore = {
    route: "/openapi-spec-parity.test", forceStatic: false, dynamicShouldError: false,
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
  // TitleState's lists are `Choice[] | null` — readCatalog({ tolerant: true }) answers null per failed list.
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
    // Followed through the route file's own helpers (a handler may hand its
    // error to a local function that calls arrFailure).
    const callees = new Set(handlerCalls(path, method).map((c) => c.callee));
    const failsThroughMap = callees.has("arrFailure") || callees.has("failure");
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

// ── The spec stays in step with the handlers it describes ───────────────────
//
// Each pin below reads the handler (or the lib module it projects through) and
// asserts the spec says the same, so a handler change that drifts from the
// document goes red here instead of shipping a stale contract.

interface SchemaNode {
  type?: string;
  pattern?: string;
  maxLength?: number;
  description?: string;
  required?: string[];
  enum?: unknown[];
  $ref?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: SchemaNode;
  allOf?: SchemaNode[];
}
interface FullOp {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  requestBody?: { content: Record<string, { schema: SchemaNode }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: SchemaNode }> }>;
}
interface FullSpec {
  tags: { name: string }[];
  security: Record<string, string[]>[];
  servers: { url: string }[];
  paths: Record<string, Record<string, FullOp>>;
}
const fullSpec = async () => (await getSpec()) as unknown as FullSpec;
const libSource = (path: string) => readFileSync(new URL(`../src/lib/${path}`, import.meta.url), "utf8");
const jsonSchema = (op: FullOp, status: string) => op.responses[status]?.content?.["application/json"]?.schema;
const keysOf = (schema: SchemaNode | undefined) => Object.keys(schema?.properties ?? {}).sort();

/** The field names of `export interface <name> { … }` in a lib module (one level). */
function interfaceFields(src: string, name: string): string[] {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  assert.ok(m, `interface ${name} not found`);
  return [...m[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]).sort();
}

test("statuses the handlers answer are documented: /popular 500, Trakt device 503, watchlist add 413, fix-match thumb 403/500", async () => {
  const spec = await fullSpec();
  assert.match(routeSource("/popular"), /status: 500/);
  assert.ok(spec.paths["/popular"].get.responses["500"], "/popular 500");
  assert.match(routeSource("/profile/trakt/device"), /maintenanceGuard\(/);
  assert.ok(spec.paths["/profile/trakt/device"].post.responses["503"], "trakt device 503");
  assert.match(handlerSlices(routeSource("/watchlist")).get("post") ?? "", /readJsonCapped[<(]/);
  assert.ok(spec.paths["/watchlist"].post.responses["413"], "watchlist POST 413");
  const thumb = readFileSync(new URL("../src/app/api/admin/fix-match/thumb/route.ts", import.meta.url), "utf8");
  assert.match(thumb, /status: 403/);
  assert.match(thumb, /Plex not configured", \{ status: 500 \}/);
  for (const status of ["403", "500"]) assert.ok(spec.paths["/admin/fix-match/thumb"].get.responses[status], `thumb ${status}`);
});

test("POST /admin/users documents all three of its 403 causes", async () => {
  const spec = await fullSpec();
  const src = handlerSlices(routeSource("/admin/users")).get("post") ?? "";
  for (const key of ["onlyAdminCreate", "cannotGrantBeyondOwn", "onlyAdminCreateServerEmail"]) {
    assert.match(src, new RegExp(`apiAdmin\\.users\\.${key}"\\) \\}, \\{ status: 403 \\}`), key);
  }
  const text = spec.paths["/admin/users"].post.responses["403"].description;
  assert.match(text, /ADMIN bit/);
  assert.match(text, /preset/);
  assert.match(text, /Plex\/Jellyfin server user/);
});

test("POST /requests/bulk names every request grant its door check accepts", async () => {
  const spec = await fullSpec();
  const src = routeSource("/requests/bulk");
  for (const bit of ["REQUEST", "REQUEST_MOVIE", "REQUEST_TV"]) {
    assert.match(src, new RegExp(`Permission\\.${bit}\\b`), bit);
    assert.match(spec.paths["/requests/bulk"].post.summary ?? "", new RegExp(`\\b${bit}\\b`), bit);
  }
});

test("every background-job 202 carries the 32-hex job id schema", async () => {
  const spec = await fullSpec();
  let jobs = 0;
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const r = op.responses["202"];
      if (!r) continue;
      const schema = jsonSchema(op, "202");
      // A job 202's prose names `{ job`; such a response must also carry the schema.
      if (/\{ job\b/.test(r.description)) assert.ok(schema?.properties?.job, `${method} ${path}: a job 202 without a schema`);
      if (!schema?.properties?.job) continue;
      jobs++;
      assert.equal(schema.properties.job.pattern, "^[0-9a-f]{32}$", `${method} ${path}`);
      assert.ok(schema.required?.includes("job"), `${method} ${path}: job not required`);
      if (schema.required?.includes("running")) assert.deepEqual(schema.properties.running?.enum, [true], `${method} ${path}`);
    }
  }
  assert.ok(jobs >= 20, `only ${jobs} job 202s found`);
  // The registry those routes share mints exactly that id, and its poll answers { job, running: true }.
  const registry = libSource("release-search-jobs.ts");
  assert.match(registry, /randomBytes\(16\)\.toString\("hex"\)/);
  assert.match(registry, /\{ job: jobId, running: true \}, \{ status: 202 \}/);
});

test("the three release searches document one ArrRelease shape, field for field the projection's", async () => {
  const spec = await fullSpec();
  const fromRequests = jsonSchema(spec.paths["/requests/{id}/releases"].get, "200")?.properties?.releases?.items;
  const fromIssues = jsonSchema(spec.paths["/issues/{id}/releases"].get, "200")?.items;
  const fromAdmin = jsonSchema(spec.paths["/admin/arr/title/releases"].get, "200")?.properties?.releases?.items;
  assert.ok(fromRequests && fromIssues && fromAdmin);
  assert.deepEqual(fromIssues, fromRequests);
  assert.deepEqual(fromAdmin, fromRequests);
  assert.deepEqual(keysOf(fromRequests), interfaceFields(libSource("arr-releases.ts"), "ArrRelease"));
  // The guid on the wire is the search's opaque handle, never the indexer's (guardrail 5e).
  assert.equal(fromRequests.properties?.guid.pattern, "^[0-9a-f]{32}$");
});

test("GET /ratings documents every MdblistRatings field, and the batch map every field its handler projects", async () => {
  const spec = await fullSpec();
  const single = keysOf(jsonSchema(spec.paths["/ratings"].get, "200"));
  assert.deepEqual(single, interfaceFields(libSource("mdblist.ts"), "MdblistRatings"));
  const batchSrc = routeSource("/ratings/batch");
  const fieldList = /const RATING_FIELDS = \[([\s\S]*?)\] as const/.exec(batchSrc)?.[1] ?? "";
  const projected = [...fieldList.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
  assert.ok(projected.length >= 11, projected.join(","));
  const batchItem = jsonSchema(spec.paths["/ratings/batch"].post, "200")?.properties?.ratings?.additionalProperties;
  assert.deepEqual(keysOf(batchItem), projected);
  for (const k of projected) assert.ok(single.includes(k), `GET /ratings lacks ${k}`);
});

test("the admin user list item, its create answer and every notification-preference list stay one shape", async () => {
  const spec = await fullSpec();
  const listItem = jsonSchema(spec.paths["/admin/users"].get, "200")?.items;
  assert.ok(listItem);
  assert.deepEqual(jsonSchema(spec.paths["/admin/users"].post, "201"), listItem);
  const prefKeys = [...(/const PREF_KEYS = \[([\s\S]*?)\]/.exec(routeSource("/profile/notifications"))?.[1] ?? "").matchAll(/"(\w+)"/g)]
    .map((m) => m[1]).sort();
  assert.equal(prefKeys.length, 13);
  const flagsIn = (schema: SchemaNode | undefined) => keysOf(schema).filter((k) => /^(notify|email|push)On/.test(k));
  const places: Array<[string, SchemaNode | undefined]> = [
    ["GET /profile/notifications", jsonSchema(spec.paths["/profile/notifications"].get, "200")],
    ["PATCH /profile/notifications", spec.paths["/profile/notifications"].patch.requestBody?.content["application/json"].schema],
    ["GET /admin/users item", listItem],
    ["POST /admin/users 201", jsonSchema(spec.paths["/admin/users"].post, "201")],
    ["PATCH /admin/users/{id}", spec.paths["/admin/users/{id}"].patch.requestBody?.content["application/json"].schema],
  ];
  for (const [where, schema] of places) assert.deepEqual(flagsIn(schema), prefKeys, where);
});

test("every operation's first tag is a declared tag", async () => {
  const spec = await fullSpec();
  const declared = new Set(spec.tags.map((t) => t.name));
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(declared.has(op.tags?.[0] ?? ""), `${method} ${path}: tag "${op.tags?.[0]}" is not declared`);
    }
  }
});

test("POST /admin/watch-sync documents that both identities must be active and the 64-character id cap", async () => {
  const spec = await fullSpec();
  const src = handlerSlices(routeSource("/admin/watch-sync")).get("post") ?? "";
  assert.match(src, /!plex\.active/);
  assert.match(src, /plexUserId\.length > 64/);
  assert.match(src, /jellyfinUserId\.length > 64/);
  const props = spec.paths["/admin/watch-sync"].post.requestBody?.content["application/json"].schema.properties ?? {};
  assert.match(props.plexUserId?.description ?? "", /active/);
  assert.equal(props.plexUserId?.maxLength, 64);
  assert.equal(props.jellyfinUserId?.maxLength, 64);
  assert.match(spec.paths["/admin/watch-sync"].post.responses["400"].description, /active Plex account/);
});

test("every cron and sync operation behind getCronActor/isCronAuthorized lists an admin session on both transports", async () => {
  const spec = await fullSpec();
  let checked = 0;
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.startsWith("/cron/") && path !== "/sync" && !path.startsWith("/sync/")) continue;
    const src = routeSource(path.replace(/\{(\w+)\}/g, "[$1]"));
    for (const [method, op] of Object.entries(methods)) {
      const handler = handlerSlices(src).get(method) ?? src.slice(src.indexOf(`export async function ${method.toUpperCase()}`));
      // defineCronRoute / withCronActor call getCronActor first (tests/cron-route.test.mts).
      assert.match(handler, /getCronActor\(|isCronAuthorized\(|defineCronRoute\(|withCronActor\(/, `${method} ${path}`);
      const schemes = new Set((op.security ?? spec.security).flatMap((e) => Object.keys(e)));
      assert.ok(schemes.has("session") && schemes.has("sessionBearer"), `${method} ${path}: ${[...schemes].join(",")}`);
      // A poll (GET) is an admin's own job — the secret has no jobs; every run takes it.
      if (method === "post") assert.ok(schemes.has("cronSecret"), `${method} ${path}: no cronSecret`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `only ${checked} cron/sync operations`);
});

test("enums copied from code match it: notification events and kinds, arr error kinds", async () => {
  const spec = await fullSpec();
  const { NOTIFY_EVENT_KEYS, AGENT_KINDS } = await import("../src/lib/notify-events.ts");
  const { ARR_ERROR_KIND_KEYS } = await import("../src/lib/arr-error-kind.ts");
  const post = spec.paths["/admin/notification-agents"].post.requestBody?.content["application/json"].schema.properties ?? {};
  assert.deepEqual(post.events?.items?.enum, [...NOTIFY_EVENT_KEYS]);
  assert.deepEqual(post.kind?.enum, [...AGENT_KINDS]);
  const kinds = JSON.stringify(Object.keys(ARR_ERROR_KIND_KEYS));
  const text = JSON.stringify(spec);
  // A nullable field's enum ends in null (OpenAPI 3.0 checks `enum` before `nullable`).
  const enums = [...text.matchAll(/"enum":(\["auth","timeout"[^\]]*\])/g)].map((m) => m[1].replace(/,null\]$/, "]"));
  assert.ok(enums.length >= 8, `found ${enums.length} arr error-kind enums`);
  for (const e of enums) assert.equal(e, kinds);
});

test("PATCH /settings documents what the handler does: unknown keys skipped, 413 cap, 500 on a failed write, tests before the write", async () => {
  const spec = await fullSpec();
  const src = handlerSlices(routeSource("/settings")).get("patch") ?? "";
  assert.match(src, /checkSubmittedSettings\(body, /);
  assert.match(libSource("settings-registry.ts"), /if \(!isSettingKey\(key\)\) continue;/);
  assert.match(src, /readJsonCapped<Record<string, unknown>>\(req, 65536\)/);
  assert.match(src, /status: 500/);
  assert.match(src, /ignored/);
  const patch = spec.paths["/settings"].patch;
  assert.doesNotMatch(patch.responses["400"].description, /unknown key/);
  assert.ok(patch.responses["413"] && patch.responses["500"]);
  assert.doesNotMatch(patch.responses["422"].description, /rolled back/);
  assert.match(patch.responses["200"].description, /`ignored`/);
});

test("decoded list rows are documented field for field: audit log, notifications, watchlist and hidden", async () => {
  const spec = await fullSpec();
  const prisma = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const modelFields = (model: string) => {
    const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(prisma)?.[1] ?? "";
    return [...body.matchAll(/^\s{2}(\w+)\s+\w+/gm)].map((m) => m[1]).filter((f) => f !== "user").sort();
  };
  assert.deepEqual(keysOf(jsonSchema(spec.paths["/admin/audit-log"].get, "200")?.properties?.logs.items), modelFields("AuditLog"));
  const select = (src: string) => [...(/const SELECT = \{([^}]*)\}/.exec(src)?.[1] ?? "").matchAll(/(\w+): true/g)].map((m) => m[1]).sort();
  const notifSelect = select(routeSource("/notifications")).filter((k) => k !== "data");
  assert.deepEqual(keysOf(jsonSchema(spec.paths["/notifications"].get, "200")?.properties?.items.items), notifSelect);
  const watchlistSelect = [...(/WATCHLIST_ITEM_SELECT = \{([^}]*)\}/.exec(libSource("watchlist-add.ts"))?.[1] ?? "").matchAll(/(\w+): true/g)]
    .map((m) => m[1]).sort();
  const listItems = (path: string) => jsonSchema(spec.paths[path].get, "200")?.allOf?.[1]?.properties?.items.items;
  assert.deepEqual(keysOf(listItems("/watchlist")), watchlistSelect);
  assert.deepEqual(keysOf(listItems("/hidden")), select(routeSource("/hidden")));
});

test("the arr history and blocklist pages document their projected records, and no path field", async () => {
  const spec = await fullSpec();
  const src = libSource("arr-history.ts");
  const records = (path: string) => jsonSchema(spec.paths[path].get, "200")?.properties?.records.items;
  assert.deepEqual(keysOf(records("/admin/arr/blocklist")), interfaceFields(src, "BlocklistEntry"));
  const history = keysOf(records("/admin/arr/history"));
  const eventFields = interfaceFields(src, "ArrHistoryEvent");
  for (const k of history) assert.ok(eventFields.includes(k), `history documents ${k}, which ArrHistoryEvent lacks`);
  for (const k of ["droppedPath", "importedPath", "sourcePath", "path", "downloadId", "downloadClient"]) {
    assert.ok(eventFields.includes(k), k);
    assert.ok(!history.includes(k), `history documents ${k}`);
  }
});

test("/sync/ratings documents its no-key answer as recorded and WITHOUT X-Cron-Skipped", async () => {
  const spec = await fullSpec();
  const src = routeSource("/sync/ratings");
  const noKey = src.slice(src.indexOf("if (!mdblistKey?.value && !omdbKey?.value)"), src.indexOf("return withCronRunRecording(\"ratings-sync\", () => withAdvisoryLock("));
  assert.match(noKey, /withCronRunRecording\(/);
  assert.doesNotMatch(noKey, /cronSkippedResponse|X-Cron-Skipped/);
  assert.match(spec.paths["/sync/ratings"].post.responses["200"].description, /"no ratings API key configured" WITHOUT the header/);
});

// ── Every success body is a schema, not prose ───────────────────────────────
//
// A body described only in prose ("{ ok, … }") drifts from its handler with
// nothing going red, and a generated client can't decode it. The per-area pins
// (tests/openapi-response-schemas-*.test.mts) tie each schema to its handler;
// these two guards keep a new operation from shipping without one.

type AnySchema = Record<string, unknown>;
const COMPOSED = ["$ref", "allOf", "oneOf", "anyOf"];

/** Every schema node under `schema`, with its path. */
function* schemaNodes(schema: unknown, path: string): Generator<[string, AnySchema]> {
  if (!schema || typeof schema !== "object") return;
  const node = schema as AnySchema;
  yield [path, node];
  for (const [k, v] of Object.entries((node.properties ?? {}) as Record<string, unknown>)) yield* schemaNodes(v, `${path}.${k}`);
  yield* schemaNodes(node.items, `${path}[]`);
  if (typeof node.additionalProperties === "object") yield* schemaNodes(node.additionalProperties, `${path}{*}`);
  for (const k of ["allOf", "oneOf", "anyOf"]) {
    for (const [i, v] of ((node[k] ?? []) as unknown[]).entries()) yield* schemaNodes(v, `${path}.${k}[${i}]`);
  }
}

test("every 2xx response documents its body as a schema, unless it is a 204", async () => {
  const spec = await fullSpec();
  const missing: string[] = [];
  let bodies = 0;
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      for (const [status, res] of Object.entries(op.responses)) {
        if (!status.startsWith("2") || status === "204") continue;
        const media = Object.values(res.content ?? {});
        if (media.length > 0 && media.every((m) => m.schema)) bodies++;
        else missing.push(`${method.toUpperCase()} ${path} ${status}`);
      }
    }
  }
  assert.deepEqual(missing, [], "2xx bodies described only in prose");
  assert.ok(bodies >= 270, `only ${bodies} documented 2xx bodies`);
});

test("an open-ended schema in a success body or a component says why it is open-ended", async () => {
  const spec = (await fullSpec()) as unknown as { paths: FullSpec["paths"]; components: { schemas: Record<string, unknown> } };
  const roots: Array<[string, unknown]> = Object.entries(spec.components.schemas).map(([name, s]) => [`components.${name}`, s]);
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      for (const [status, res] of Object.entries(op.responses)) {
        if (!status.startsWith("2")) continue;
        for (const [type, m] of Object.entries(res.content ?? {})) roots.push([`${method.toUpperCase()} ${path} ${status} ${type}`, m.schema]);
      }
    }
  }
  const silent: string[] = [];
  for (const [where, root] of roots) {
    for (const [at, node] of schemaNodes(root, "")) {
      if (COMPOSED.some((k) => k in node) || typeof node.description === "string") continue;
      // No type at all (any value), or an object with nothing said about its keys.
      const bareObject = node.type === "object" && !node.properties && node.additionalProperties === undefined;
      if (node.type === undefined || bareObject) silent.push(`${where}${at}`);
    }
  }
  assert.deepEqual(silent, [], "open-ended schemas without a description");
});
