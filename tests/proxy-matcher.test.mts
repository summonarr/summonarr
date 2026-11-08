// The proxy's matcher (src/proxy.ts `config`), evaluated by Next's own matcher
// code — the same functions `next build` compiles it with — rather than read as
// source.
//
// Why a file of its own: loading Next's testing helper patches console.warn
// with a wrapper that reads Next's request storage, so it would break the
// warning assertions in tests/proxy.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // proxy.ts → prisma.ts → token-crypto
process.env.NEXTAUTH_SECRET = "proxy-matcher-test-secret-0123456789abcdef";

// Next's server provides AsyncLocalStorage on globalThis; its matcher code reads it.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = createRequire(import.meta.url)(
  "next/experimental/testing/server",
) as {
  unstable_doesMiddlewareMatch(args: { config: unknown; url: string; headers?: Record<string, string> }): boolean;
};
const { config } = await import("../src/proxy.ts");

const runs = (url: string, headers: Record<string, string> = {}): boolean =>
  unstable_doesMiddlewareMatch({ config, url, headers });

const PREFETCH_HEADERS: Array<Record<string, string>> = [
  { "next-router-prefetch": "1" },
  { purpose: "prefetch" },
];

test("a page prefetch skips the proxy, as Next's CSP guide recommends (guardrail 29 makes each page guard itself)", () => {
  assert.equal(runs("/movies"), true);
  assert.equal(runs("/"), true);
  for (const h of PREFETCH_HEADERS) {
    assert.equal(runs("/movies", h), false, `a page prefetch (${JSON.stringify(h)}) skips`);
  }
});

test("EVERY /api request runs the proxy, whatever its prefetch headers", () => {
  // Those headers are client-set: honouring them on /api let any client skip
  // the Host gate, the 426 gate, the CSRF Origin check and auth, on any method.
  for (const path of ["/api", "/api/requests", "/api/settings/plex", "/api/admin/users", "/api/calendar/feed/abc.ics"]) {
    assert.equal(runs(path), true, `${path} runs the proxy`);
    for (const h of PREFETCH_HEADERS) {
      assert.equal(runs(path, h), true, `${path} with ${JSON.stringify(h)} must still run the proxy`);
    }
  }
  // Only a whole `api` segment is the API: a page named /apiary is a page.
  assert.equal(runs("/apiary"), true);
  assert.equal(runs("/apiary", { purpose: "prefetch" }), false);
});

test("static assets never run the proxy", () => {
  for (const path of ["/_next/static/chunks/main.js", "/_next/image", "/favicon.ico", "/sw.js"]) {
    assert.equal(runs(path), false, `${path} skips the proxy`);
  }
});
