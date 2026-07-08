// Unit tests for the rate limiter (src/lib/rate-limit.ts). The
// X-Forwarded-For client-IP resolution is security-critical (a spoofable IP
// defeats every IP-keyed limit), so its anti-spoof behaviour is covered here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRateLimit, checkRateLimit, getClientIp } from "../src/lib/rate-limit.ts";

test("parseRateLimit falls back to the default on junk", () => {
  assert.equal(parseRateLimit("5", 20), 5);
  assert.equal(parseRateLimit("0", 20), 0);
  assert.equal(parseRateLimit("", 20), 20);
  assert.equal(parseRateLimit("   ", 20), 20);
  assert.equal(parseRateLimit(null, 20), 20);
  assert.equal(parseRateLimit(undefined, 20), 20);
  assert.equal(parseRateLimit("abc", 20), 20);
  assert.equal(parseRateLimit("-3", 20), 20);
});

test("checkRateLimit allows up to `limit` hits per window, then blocks", () => {
  const key = `test:${Math.random()}`;
  assert.equal(checkRateLimit(key, 3, 60_000), true);
  assert.equal(checkRateLimit(key, 3, 60_000), true);
  assert.equal(checkRateLimit(key, 3, 60_000), true);
  assert.equal(checkRateLimit(key, 3, 60_000), false); // 4th within window
  // A different key has its own bucket.
  assert.equal(checkRateLimit(`other:${Math.random()}`, 3, 60_000), true);
  // limit <= 0 disables the limiter.
  assert.equal(checkRateLimit(`nolimit:${Math.random()}`, 0, 60_000), true);
});

test("getClientIp ignores the spoofable leftmost X-Forwarded-For entry", () => {
  const orig = process.env.TRUST_PROXY;
  const origHops = process.env.TRUSTED_PROXY_HOPS;
  process.env.TRUST_PROXY = "true";
  delete process.env.TRUSTED_PROXY_HOPS; // default 1 hop
  try {
    // Client forges "9.9.9.9"; the trusted proxy appends the real peer "5.6.7.8".
    // With 1 hop, only the rightmost entry is trustworthy.
    const h = new Headers({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" });
    assert.equal(getClientIp(h), "5.6.7.8");
    // X-Real-IP is honoured when no XFF.
    assert.equal(getClientIp(new Headers({ "x-real-ip": "203.0.113.7" })), "203.0.113.7");
  } finally {
    if (orig === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = orig;
    if (origHops === undefined) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = origHops;
  }
});

test("getClientIp falls back to a stable non-IP bucket when proxy is untrusted", () => {
  const orig = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY; // untrusted
  try {
    const h1 = new Headers({ "user-agent": "TestAgent/1.0", "x-forwarded-for": "9.9.9.9" });
    const h2 = new Headers({ "user-agent": "TestAgent/1.0", "x-forwarded-for": "9.9.9.9" });
    const b = getClientIp(h1);
    assert.equal(typeof b, "string");
    assert.equal(b.length > 0, true);
    assert.notEqual(b, "9.9.9.9"); // must NOT trust the forwarded IP
    assert.equal(getClientIp(h2), b); // stable for identical headers
  } finally {
    if (orig === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = orig;
  }
});
