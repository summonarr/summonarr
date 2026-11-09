import { test } from "node:test";
import assert from "node:assert/strict";
import { peekRateLimit, recordFailure } from "../src/lib/rate-limit.ts";

test("recordFailure keeps a bounded number of hits per key", () => {
  const key = "hit-cap-test:a";
  for (let i = 0; i < 10_050; i++) recordFailure(key, 60_000);
  // At the cap, a limit one above it still has room; an unbounded list would not.
  assert.equal(peekRateLimit(key, 10_001, 60_000), true);
  assert.equal(peekRateLimit(key, 10_000, 60_000), false);
});
