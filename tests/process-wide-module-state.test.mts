// Scan 2026-09-22 (partition P12) — process-wide module state.
//
// Turbopack compiles a lib module into every server chunk that imports it, each
// with its own module instance (see src/lib/process-singleton.ts). Loading the
// same source twice under distinct URLs reproduces that: two module instances in
// one process. State that must be shared across the boot chunk and the route
// chunks has to live in processSingleton, not in a module-scope binding.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);

type PlexEvents = typeof import("../src/lib/plex-events.ts");
type RateLimit = typeof import("../src/lib/rate-limit.ts");

// A runtime specifier (not a literal) so the typecheckers don't try to resolve
// the query-suffixed path; Node's ESM cache keys on the full URL.
function instanceUrl(rel: string, tag: string): string {
  return new URL(`${rel}?instance=${tag}`, import.meta.url).href;
}

test("plex-events: the finalize ledger is shared across module instances", async () => {
  const a = (await import(instanceUrl("../src/lib/plex-events.ts", "a"))) as PlexEvents;
  const b = (await import(instanceUrl("../src/lib/plex-events.ts", "b"))) as PlexEvents;
  assert.notEqual(a, b, "harness must produce two module instances");
  a.markPlexSessionFinalized("plex:scan-p12-ledger");
  assert.equal(b.isPlexSessionRecentlyFinalized("plex:scan-p12-ledger"), true);
});

test("rate-limit: one key has one budget across module instances", async () => {
  const a = (await import(instanceUrl("../src/lib/rate-limit.ts", "a"))) as RateLimit;
  const b = (await import(instanceUrl("../src/lib/rate-limit.ts", "b"))) as RateLimit;
  assert.notEqual(a, b, "harness must produce two module instances");
  const key = `scan-p12:${Date.now()}`;
  assert.equal(a.checkRateLimit(key, 1, 60_000), true);
  assert.equal(b.checkRateLimit(key, 1, 60_000), false);
});
