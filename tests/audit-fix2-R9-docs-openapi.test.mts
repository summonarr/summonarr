// Audit fix 2 / R9 — the shared /admin/arr/* error map in the OpenAPI spec
// (`ARR_ERRORS`, src/app/api/openapi/route.ts) claims to document every answer
// arrGate/arrTitleGate and arrFailure (src/lib/arr-admin-http.ts) share. It
// listed 400/404/502/504 only, while arrFailure also answers 409 — a named
// season/episode/file/history record not on the title, not a grab, already
// failed, gone from the blocklist, no longer queued, or the arr's own 409
// relayed masked — and arrTitleGate answers 400 for an invalid title id. So an
// operation with no 409 of its own (GET /admin/arr/title/releases with a season
// the series lacks) answered a 409 the spec never mentioned.
//
// The pins are coupled to the handlers: each status is first produced by the
// real arrFailure / arrTitleGate, then required on every /admin/arr/* operation
// whose handler calls arrFailure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix2-r9-docs-openapi-secret-0123";
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
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const { arrFailure, arrTitleGate } = await import("../src/lib/arr-admin-http.ts");
const { ArrResponseError } = await import("../src/lib/arr.ts");
const { AlreadyFailedError, NotAGrabError, NotOnTitleError } = await import("../src/lib/arr-title-data.ts");
const { BlocklistGoneError } = await import("../src/lib/arr-history-data.ts");
const { CommandNotQueuedError } = await import("../src/lib/arr-system-data.ts");

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
    route: "/audit-fix2-R9-docs-openapi.test", forceStatic: false, dynamicShouldError: false,
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

type Spec = { paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>> };

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

function routeSource(apiPath: string): string {
  return readFileSync(new URL(`../src/app/api${apiPath}/route.ts`, import.meta.url), "utf8");
}

function handlerSlices(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const marks = [...src.matchAll(/^export const (GET|POST|PATCH|DELETE|PUT) =/gm)];
  marks.forEach((m, i) => out.set(m[1].toLowerCase(), src.slice(m.index, marks[i + 1]?.index ?? src.length)));
  return out;
}

const t = translatorFor("en");
const target = { service: "sonarr" as const, instance: "" };

test("R9#1: arrFailure answers 409 for every shared conflict, and the spec's shared map documents it", async () => {
  const conflicts: Array<[string, unknown]> = [
    ["season not on the title", new NotOnTitleError("season")],
    ["episode not on the title", new NotOnTitleError("episode")],
    ["file not on the title", new NotOnTitleError("file")],
    ["history record not on the title", new NotOnTitleError("history")],
    ["not a grab", new NotAGrabError()],
    ["already failed", new AlreadyFailedError()],
    ["gone from the blocklist", new BlocklistGoneError()],
    ["no longer queued", new CommandNotQueuedError()],
    ["the arr's own 409", new ArrResponseError(409, JSON.stringify([{ errorMessage: "Unable to cancel task" }]))],
  ];
  for (const [label, err] of conflicts) {
    const res = arrFailure(err, target, t, "test");
    assert.equal(res.status, 409, `${label}: arrFailure answers ${res.status}`);
  }
  const relayed = (await arrFailure(conflicts.at(-1)![1], target, t, "test").json()) as { messages?: unknown };
  assert.ok(Array.isArray(relayed.messages), "the arr's 409 is relayed as { error, messages }");

  const spec = await getSpec();
  const titleReleases = spec.paths["/admin/arr/title/releases"].get.responses["409"];
  assert.ok(titleReleases, "GET /admin/arr/title/releases has no 409 of its own, so the shared map must supply one");
  for (const word of [/season/, /episode/, /file/, /history/, /grab/, /already failed/, /blocklist/, /queued/, /messages/, /masked/]) {
    assert.match(titleReleases.description, word, `the shared 409 does not mention ${word}`);
  }
});

test("R9#2: arrTitleGate answers 400 for an invalid title id, and the shared 400 says so", async () => {
  const res = await arrTitleGate("sonarr", "", "not-a-number", t);
  assert.ok(!("arrId" in res), "an invalid id passed the gate");
  assert.equal((res as { status: number }).status, 400);
  const spec = await getSpec();
  // title/files GET goes through arrTitleGate and keeps the shared 400 text.
  assert.match(spec.paths["/admin/arr/title/files"].get.responses["400"].description, /title id/);
});

test("R9#3: every /admin/arr/* operation whose handler calls arrFailure documents a 409 and a 400", async () => {
  const spec = await getSpec();
  let checked = 0;
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.startsWith("/admin/arr/")) continue;
    const slices = handlerSlices(routeSource(path));
    for (const [method, op] of Object.entries(methods)) {
      const handler = slices.get(method);
      if (!handler || !/arrFailure\(|\bfailure\(/.test(handler)) continue;
      checked++;
      for (const status of ["400", "409"]) assert.ok(op.responses[status], `${method} ${path} calls arrFailure but documents no ${status}`);
    }
  }
  assert.ok(checked >= 20, `only ${checked} arrFailure operations found`);
});
