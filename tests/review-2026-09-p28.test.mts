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
//   f51  POST /admin/users        password minLength 8 (what the route enforces)
//   f52  PATCH /requests/{id} and PATCH /admin/users/{id} are labeled with the
//        MANAGE_* permission their withPermission wrapper gates on, not "(ADMIN)"
//
// The spec is served by a withPermission(ADMIN) handler, so it is fetched
// through the same synthetic request scope + in-memory prisma stubs the
// setup-events-openapi suite uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

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

type Spec = {
  paths: Record<string, Record<string, {
    summary?: string;
    description?: string;
    parameters?: Array<{ name: string; in: string; schema?: { enum?: string[] } }>;
    requestBody?: { content: Record<string, { schema: { properties: Record<string, { minLength?: number }> } }> };
    responses: Record<string, { description: string; content?: Record<string, { schema: Record<string, unknown> }> }>;
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

test("f51: POST /admin/users password minLength matches the route's 8-char floor", async () => {
  const spec = await getSpec();
  const body = spec.paths["/admin/users"].post.requestBody?.content["application/json"].schema;
  // src/app/api/admin/users/route.ts rejects only `< 8`, and the create-user
  // form gates submit at `>= 8`; the register + profile/password routes use 12.
  assert.equal(body?.properties.password.minLength, 8);
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
