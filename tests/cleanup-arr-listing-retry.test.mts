// The Radarr/Sonarr library listing's 502/503/504 retry (src/lib/library-cleanup-arr.ts)
// retries only a FAST failure. The cleanup dry run and execute read the listing
// synchronously behind a reverse proxy (~60 s): a gateway that gave up after
// ~30 s, retried with a second full timeout, pushed the execute past the proxy
// while it went on deleting (guardrail 37a). A restart's quick 502/503 is still
// retried — tests/library-cleanup-routes.test.mts pins that half end to end.
//
// Harness: the listing through loadArrLibraryIndex, over an in-memory Setting
// table and a scripted Sonarr on an RFC1918 literal (the routes test's idiom).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const SONARR = "http://10.0.0.7:8989";
let seriesCalls = 0;
// Per call (0-based): how long Sonarr's gateway takes, and what it answers.
let script: (n: number) => { delayMs: number; status: number } = () => ({ delayMs: 0, status: 200 });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.origin === SONARR && url.pathname === "/api/v3/series") {
    const { delayMs, status } = script(seriesCalls++);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return status === 200 ? Response.json([]) : new Response("gateway", { status });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

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

const { loadArrLibraryIndex, _setArrListingRetryDelayForTests, _setArrListingRetryFastFailForTests } = await import("../src/lib/library-cleanup-arr.ts");
_setArrListingRetryDelayForTests(0);

beforeEach(() => {
  seriesCalls = 0;
  settings.clear();
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  invalidateFeatureFlagCache();
  _setArrListingRetryFastFailForTests(null);
});

after(() => {
  _setArrListingRetryFastFailForTests(null);
});

test("a 504 that took longer than the fast-fail bound is reported at once, never retried", async () => {
  _setArrListingRetryFastFailForTests(25);
  script = () => ({ delayMs: 120, status: 504 });
  const index = await loadArrLibraryIndex();
  assert.equal(seriesCalls, 1, "a slow gateway failure costs one timeout, not two");
  assert.deepEqual(index.errors.map((e) => [e.service, e.instance]), [["sonarr", ""]]);
});

test("a 503 that came back fast is still retried once, and the retry's answer is used", async () => {
  _setArrListingRetryFastFailForTests(5_000);
  script = (n) => ({ delayMs: 0, status: n === 0 ? 503 : 200 });
  const index = await loadArrLibraryIndex();
  assert.equal(seriesCalls, 2);
  assert.deepEqual(index.errors, []);
});

test("the production bound retries a quick failure", async () => {
  // Restored to production (null) by beforeEach: an instant 502 is retried.
  script = (n) => ({ delayMs: 0, status: n === 0 ? 502 : 200 });
  const index = await loadArrLibraryIndex();
  assert.equal(seriesCalls, 2);
  assert.deepEqual(index.errors, []);
});

test("worst case with a retry stays under a 60 s proxy: fast-fail bound + pause + one 30 s timeout", () => {
  const src = readFileSync(new URL("../src/lib/library-cleanup-arr.ts", import.meta.url), "utf8");
  const bound = Number(/const LISTING_RETRY_FAST_FAIL_MS = ([\d_]+);/.exec(src)?.[1].replaceAll("_", ""));
  const pause = Number(/let listingRetryDelayMs = ([\d_]+);/.exec(src)?.[1].replaceAll("_", ""));
  assert.ok(Number.isFinite(bound) && Number.isFinite(pause), "both constants found");
  assert.ok(bound + pause + 30_000 < 60_000, `${bound} + ${pause} + 30000 must stay under 60000`);
  // The elapsed check runs BEFORE the pause and the second attempt.
  const body = src.slice(src.indexOf("async function fetchListing"), src.indexOf("async function listInstance"));
  const check = body.indexOf("Date.now() - started > listingRetryFastFailMs");
  assert.ok(check > 0 && check < body.indexOf("setTimeout"), "the fast-fail check precedes the retry");
});
