// getFeatureFlags shares one Setting read between every concurrent caller, so a
// single transient failure after the cache TTL lapsed used to fail every page
// render and route that checked a flag. It now serves the last successful read
// — but only one the admin has not invalidated since (an admin toggle is never
// undone), and never the registered defaults (which could re-enable a page or
// integration an admin turned off).
//
// The prisma.setting delegate is shadowed with a scripted stub and Date.now is
// stepped past the TTL; no DB is touched.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { getFeatureFlags, invalidateFeatureFlagCache } from "../src/lib/features.ts";
import { resetLogDedup } from "../src/lib/log-dedup.ts";
import { shadowPrismaModel } from "./_helpers.mts";

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

let rows: Array<{ key: string; value: string }> = [];
let failWith: Error | null = null;
let reads = 0;
shadowPrismaModel(prisma, "setting", {
  findMany: async () => {
    reads++;
    if (failWith) throw failWith;
    return rows;
  },
});

const realNow = Date.now;
let now = realNow();
Date.now = () => now;
after(() => { Date.now = realNow; });

// Well past the 10s flag-cache TTL.
const PAST_TTL_MS = 60_000;

beforeEach(() => {
  invalidateFeatureFlagCache();
  resetLogDedup();
  rows = [];
  failWith = null;
  reads = 0;
  warns.length = 0;
});

test("an expired cache plus a failed read serves the last successful flags, not an error", async () => {
  // The admin turned the Top page OFF; the default is ON.
  rows = [{ key: "feature.page.top", value: "false" }];
  const primed = await getFeatureFlags();
  assert.equal(primed["feature.page.top"], false);

  now += PAST_TTL_MS;
  failWith = new Error("timed out fetching a new connection from the pool");
  const flags = await getFeatureFlags();
  assert.equal(flags["feature.page.top"], false, "the admin's OFF survives the failed read — never the ON default");
  assert.equal(reads, 2, "the failed read was attempted");
  assert.equal(warns.filter((w) => w.startsWith("[features]")).length, 1, "the fallback is reported");

  // The stale entry is not re-armed: the next call reads again.
  await getFeatureFlags();
  assert.equal(reads, 3, "a fallback must not extend the cache's expiry");
  assert.equal(warns.filter((w) => w.startsWith("[features]")).length, 1, "an unchanged failure is not re-logged on every call (guardrail 7b)");

  // Once the DB answers again, the fresh value wins.
  failWith = null;
  rows = [{ key: "feature.page.top", value: "true" }];
  assert.equal((await getFeatureFlags())["feature.page.top"], true);
});

test("after an invalidate the same failure rejects — there is no last-known-good to fall back on", async () => {
  rows = [{ key: "feature.page.top", value: "false" }];
  await getFeatureFlags();
  invalidateFeatureFlagCache();

  failWith = new Error("connection refused");
  await assert.rejects(getFeatureFlags(), /connection refused/);
});

test("a cold cache (no successful read yet) rejects rather than inventing defaults", async () => {
  failWith = new Error("connection refused");
  await assert.rejects(getFeatureFlags(), /connection refused/);
});
