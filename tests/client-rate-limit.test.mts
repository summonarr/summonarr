import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterSeconds, rateLimitMessage, RETRY_AFTER_MAX_SECONDS } from "../src/lib/client/rate-limit.ts";

const t = (key: string, vars?: Record<string, string | number>) => `${key}|${vars?.seconds ?? ""}`;
const res = (status: number, ra?: string) => ({ status, headers: { get: (n: string) => (n === "Retry-After" ? (ra ?? null) : null) } });

test("parseRetryAfterSeconds: delta-seconds only, bounded", () => {
  assert.equal(parseRetryAfterSeconds("30"), 30);
  assert.equal(parseRetryAfterSeconds(" 5 "), 5);
  assert.equal(parseRetryAfterSeconds("0"), null);
  assert.equal(parseRetryAfterSeconds("-3"), null);
  assert.equal(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assert.equal(parseRetryAfterSeconds(null), null);
  assert.equal(parseRetryAfterSeconds("999999"), RETRY_AFTER_MAX_SECONDS);
});

test("rateLimitMessage: null unless 429; names the wait only when usable", () => {
  assert.equal(rateLimitMessage(res(500), t), null);
  assert.equal(rateLimitMessage(res(429, "12"), t), "shared.rateLimited.seconds|12");
  assert.equal(rateLimitMessage(res(429), t), "shared.rateLimited.generic|");
  assert.equal(rateLimitMessage(res(429, "soon"), t), "shared.rateLimited.generic|");
});
