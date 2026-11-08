// The IpInfo popover's lookup and shared cache (src/components/admin/ip-info-cache.ts).
//
//   - The route's 404 means "nothing to look up with" (no ipinfo token). It is
//     cached, but only for MISSING_TTL_MS: cached for the whole session, an
//     admin who then adds a token kept seeing "Not available" for every IP
//     looked up before, until a full reload.
//   - A lookup is shape-checked before it is cached: a body that isn't one (a
//     proxy's page, a changed route) used to be cached as is, and the popover
//     then crashed on `latitude.toFixed`.
//   - Anything else (429, 503, no answer) is transient: never cached.
import { test } from "node:test";
import assert from "node:assert/strict";

const { cacheSet, cachedView, ipLookupCache, isFreshMissing, lookupIp, MISSING_TTL_MS } = await import(
  "../src/components/admin/ip-info-cache.ts"
);

const LOOKUP = {
  ip: "8.8.8.8", hostname: "dns.google", city: "Mountain View", region: "California", country: "US",
  postal: "94043", latitude: 37.4, longitude: -122.1, timezone: "America/Los_Angeles", org: "AS15169 Google LLC", bogon: false,
};

function answer(status: number, body: unknown): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("a 200 lookup is checked and found; extra fields are dropped", async () => {
  const out = await withFetch(answer(200, { ...LOOKUP, userId: "x" }), () => lookupIp("8.8.8.8"));
  assert.deepEqual(out, { kind: "found", lookup: LOOKUP });
});

test("a 200 that isn't a lookup is a transient failure, never something to cache", async () => {
  const out = await withFetch(answer(200, { ...LOOKUP, latitude: "37.4" }), () => lookupIp("8.8.8.8"));
  assert.deepEqual(out, { kind: "failed", message: null });
  const html = await withFetch(answer(200, "<html>sign in</html>"), () => lookupIp("8.8.8.8"));
  assert.equal(html.kind, "failed");
});

test("a 404 is 'missing'; a 429/503 keeps the route's own words; no answer has none", async () => {
  assert.deepEqual(await withFetch(answer(404, { error: "nope" }), () => lookupIp("1.1.1.1")), { kind: "missing" });
  assert.deepEqual(await withFetch(answer(429, { error: "Slow down" }), () => lookupIp("1.1.1.1")), { kind: "failed", message: "Slow down" });
  const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.deepEqual(await withFetch(down, () => lookupIp("1.1.1.1")), { kind: "failed", message: null });
});

test("a cached 404 answers an open only while it is young", () => {
  const entry = { missingAt: 1_000_000 };
  assert.equal(isFreshMissing(entry, 1_000_000 + MISSING_TTL_MS - 1), true);
  assert.equal(isFreshMissing(entry, 1_000_000 + MISSING_TTL_MS), false, "past the TTL the next open asks again");
  assert.equal(isFreshMissing(LOOKUP, 1_000_000), false, "a lookup is not a 404");
  assert.equal(isFreshMissing(undefined, 1_000_000), false);
});

test("the cache's view: a lookup, a 404 (whatever its age — render reads no clock), or nothing", () => {
  ipLookupCache.clear();
  cacheSet("8.8.8.8", LOOKUP);
  cacheSet("10.0.0.1", { missingAt: 0 });
  assert.deepEqual(cachedView("8.8.8.8"), { data: LOOKUP, error: null });
  assert.deepEqual(cachedView("10.0.0.1"), { data: null, error: { kind: "missing" } });
  assert.deepEqual(cachedView("9.9.9.9"), { data: null, error: null });
  ipLookupCache.clear();
});

test("the popover re-asks a stale 404 on open and releases its fetch guard for anything but a lookup", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/admin/ip-info.tsx", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf("async function handleOpenChange("), src.indexOf("const errorText ="));
  assert.match(handler, /if \(isFreshMissing\(cached, Date\.now\(\)\)\) \{/);
  assert.match(handler, /if \(outcome\.kind !== "found" && fetchedRef\.current === requested\) fetchedRef\.current = null;/);
  assert.match(handler, /else if \(outcome\.kind === "missing"\) cacheSet\(requested, \{ missingAt: Date\.now\(\) \}\);/);
  // The message is chosen at render from the kept kind, so a locale switch re-words it.
  assert.match(src, /useState<IpError \| null>/);
  assert.doesNotMatch(handler, /setError\(t\(/);
});
