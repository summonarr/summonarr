// The spec's server url under a subpath deployment. NEXT_PUBLIC_BASE_PATH is
// read once when base-path.ts loads, so this file runs in its own process with
// the variable set before anything is imported (the other spec suites run with
// it unset and pin the bare "/api").

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

process.env.NEXT_PUBLIC_BASE_PATH = "/request";
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "openapi-base-path-secret-0123456";
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

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => ({ id: "row", sessionId: args.where.sessionId }),
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async () => ({
    id: "u-admin", name: "Admin", email: "admin@example.com", role: "ADMIN",
    permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  }),
  findMany: async () => [],
  count: async () => 1,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "setting", { findUnique: async () => null, findMany: async () => [], upsert: async () => ({}) });

const openapi = await import("../src/app/api/openapi/route.ts");

test("under BASE_PATH the spec's server url carries the base path, so an external client calls /request/api/…", async () => {
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: "u-admin", role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId: "s-admin", expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  const cookie = `${getSessionCookieName()}=${token}`;
  const headers = new Headers({ cookie });
  const res = await workAsyncStorage.run(
    { route: "/openapi-base-path.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } },
    () => workUnitAsyncStorage.run(
      { type: "request", phase: "render", headers: HeadersAdapter.seal(headers), cookies: RequestCookiesAdapter.seal(new RequestCookies(headers)), usedDynamic: false },
      () => openapi.GET(new NextRequest("http://localhost:3000/request/api/openapi", { method: "GET", headers: { cookie } }), undefined),
    ),
  );
  assert.equal(res.status, 200);
  const spec = (await res.json()) as { servers: { url: string }[] };
  assert.equal(spec.servers[0].url, "/request/api");
});
