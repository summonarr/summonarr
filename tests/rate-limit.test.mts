// Unit tests for the rate limiter (src/lib/rate-limit.ts). The
// X-Forwarded-For client-IP resolution is security-critical (a spoofable IP
// defeats every IP-keyed limit), so its anti-spoof behaviour is covered here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRateLimit,
  checkRateLimit,
  peekRateLimit,
  recordFailure,
  refundHit,
  getClientIp,
  getClientIpKey,
  ipBucketKey,
} from "../src/lib/rate-limit.ts";

// Run `fn` with the given env vars set (undefined = deleted), restoring the
// previous values afterwards. process.env mutations are file-local (each test
// file runs in its own child process), but tests still must not leak into each
// other within this file.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

// The /profile page renders the push-device cap (`N / cap`) from the same
// `maxPushSubscriptions` Setting the push routes enforce. Those routes go
// through `parseRateLimit` (0 = unlimited, negative/junk = default), and the
// page used to fork its own `parseInt(...) || 5`, which collapsed the admin's
// "0 = no limit" into "5" — a user with 7 devices saw `7 / 5` while
// registration kept succeeding. Pin the page to the shared parser so the cap
// can't be re-forked.
test("profile page derives the push-device cap through parseRateLimit, not a private parseInt", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "app", "(app)", "profile", "page.tsx"),
    "utf-8",
  );
  assert.match(src, /import \{ parseRateLimit \} from "@\/lib\/rate-limit"/);
  assert.match(src, /parseRateLimit\(maxPushSetting\?\.value,/);
  assert.doesNotMatch(src, /parseInt\(maxPushSetting/);
  // 0 must read as "unlimited" (the routes gate eviction on cap > 0) and a
  // negative value must fall back to the routes' default, not leak through.
  assert.equal(parseRateLimit("0", 5), 0);
  assert.equal(parseRateLimit("-1", 5), 5);
  assert.equal(parseRateLimit("7", 5), 7);
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

// ---------------------------------------------------------------------------
// peekRateLimit / recordFailure — the login-failure pairing: peek gates entry
// to the flow without consuming quota; recordFailure charges the bucket only
// when the password verify actually fails. All three functions share one Map,
// so a peek that accidentally recorded a hit would lock accounts out of login
// after `limit` ATTEMPTS instead of `limit` FAILURES.
// ---------------------------------------------------------------------------

test("peekRateLimit never records a hit — repeated peeks stay true", () => {
  const key = `peek:${Math.random()}`;
  for (let i = 0; i < 50; i++) {
    assert.equal(peekRateLimit(key, 3, 60_000), true);
  }
  // The full allowance is still available: 3 real hits succeed, the 4th blocks.
  assert.equal(checkRateLimit(key, 3, 60_000), true);
  assert.equal(checkRateLimit(key, 3, 60_000), true);
  assert.equal(checkRateLimit(key, 3, 60_000), true);
  assert.equal(checkRateLimit(key, 3, 60_000), false);
});

test("peekRateLimit reads the same bucket checkRateLimit writes", () => {
  const key = `peek-shared:${Math.random()}`;
  assert.equal(checkRateLimit(key, 2, 60_000), true);
  assert.equal(peekRateLimit(key, 2, 60_000), true); // 1 hit < 2
  assert.equal(checkRateLimit(key, 2, 60_000), true);
  assert.equal(peekRateLimit(key, 2, 60_000), false); // 2 hits >= 2
});

test("peekRateLimit treats limit <= 0 as disabled", () => {
  const key = `peek-nolimit:${Math.random()}`;
  assert.equal(peekRateLimit(key, 0, 60_000), true);
  assert.equal(peekRateLimit(key, -1, 60_000), true);
});

test("recordFailure charges the shared bucket peek/check read", () => {
  const key = `fail:${Math.random()}`;
  recordFailure(key, 60_000);
  recordFailure(key, 60_000);
  assert.equal(peekRateLimit(key, 3, 60_000), true); // 2 failures < 3
  recordFailure(key, 60_000);
  assert.equal(peekRateLimit(key, 3, 60_000), false); // 3 failures >= 3
  // Same bucket as checkRateLimit: the failures consumed its quota too.
  assert.equal(checkRateLimit(key, 3, 60_000), false);
});

// ---------------------------------------------------------------------------
// checkRateLimit edge cases
// ---------------------------------------------------------------------------

test("checkRateLimit treats a negative limit as disabled", () => {
  const key = `neglimit:${Math.random()}`;
  assert.equal(checkRateLimit(key, -1, 60_000), true);
  assert.equal(checkRateLimit(key, -1, 60_000), true);
});

test("sliding window: a blocked key admits hits again once windowMs elapses", async () => {
  const key = `expiry:${Math.random()}`;
  // Two synchronous calls are microseconds apart — far inside the 100ms window.
  assert.equal(checkRateLimit(key, 1, 100), true);
  assert.equal(checkRateLimit(key, 1, 100), false);
  // Wait well past the window so the hit is pruned by the cutoff filter.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(checkRateLimit(key, 1, 100), true);
});

test("parseRateLimit tolerates a numeric prefix (parseInt semantics)", () => {
  // Pins current behavior: parseInt("5abc") === 5, so trailing junk is accepted.
  assert.equal(parseRateLimit("5abc", 20), 5);
});

// ---------------------------------------------------------------------------
// getClientIp — TRUSTED_PROXY_HOPS selection, clamping, and IP validation.
// The hop clamp is a security property: an oversized hop count would select an
// entry further LEFT in X-Forwarded-For, i.e. a client-forgeable address.
// ---------------------------------------------------------------------------

test("TRUSTED_PROXY_HOPS=2 selects the second-from-right XFF entry", () => {
  withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: "2" }, () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 10.0.0.1" });
    assert.equal(getClientIp(h), "5.6.7.8");
  });
});

test("TRUSTED_PROXY_HOPS clamps oversized values to MAX_TRUSTED_HOPS=5", () => {
  // 7-entry chain of distinct IPs. Clamped hops=5 selects parts[7-5]=parts[2];
  // an unclamped hops=99 would clamp the index to parts[0] — the entry the
  // client itself sent — re-opening the spoof hole.
  const chain = "203.0.113.1, 203.0.113.2, 203.0.113.3, 203.0.113.4, 203.0.113.5, 203.0.113.6, 203.0.113.7";
  withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: "99" }, () => {
    assert.equal(getClientIp(new Headers({ "x-forwarded-for": chain })), "203.0.113.3");
  });
});

test("TRUSTED_PROXY_HOPS of 0 / negative / junk defaults to 1 hop (rightmost)", () => {
  const h = () => new Headers({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" });
  for (const bad of ["0", "-1", "abc"]) {
    withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: bad }, () => {
      assert.equal(getClientIp(h()), "5.6.7.8", `TRUSTED_PROXY_HOPS=${JSON.stringify(bad)}`);
    });
  }
});

test("an XFF chain shorter than the hop count clamps to the leftmost entry", () => {
  withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: "5" }, () => {
    const h = new Headers({ "x-forwarded-for": "5.6.7.8" });
    assert.equal(getClientIp(h), "5.6.7.8"); // parts[0], never an out-of-range index
  });
});

test("a non-IP XFF candidate is rejected, falling through to X-Real-IP", () => {
  withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: undefined }, () => {
    const h = new Headers({
      "x-forwarded-for": "not-an-ip",
      "x-real-ip": "203.0.113.9",
    });
    assert.equal(getClientIp(h), "203.0.113.9");
  });
});

test("invalid XFF and X-Real-IP both fall through to the unknown: UA bucket", () => {
  withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: undefined }, () => {
    // A regression that returned the raw header value as the bucket key would
    // hand attackers a per-request unique key (rate limit bypass) — the result
    // must be the hashed unknown: bucket, never the header contents.
    const h = new Headers({
      "user-agent": "TestAgent/1.0",
      "x-forwarded-for": "999.999.999.999, evil=payload",
      "x-real-ip": "also-not-an-ip",
    });
    const bucket = getClientIp(h);
    assert.equal(bucket.startsWith("unknown:"), true);
    assert.equal(bucket.includes("999.999.999.999"), false);
    assert.equal(bucket.includes("evil"), false);
    assert.equal(bucket.includes("also-not-an-ip"), false);
  });
});

test("distinct User-Agents land in distinct untrusted buckets", () => {
  withEnv({ TRUST_PROXY: undefined }, () => {
    const a = getClientIp(new Headers({ "user-agent": "AgentA/1.0" }));
    const b = getClientIp(new Headers({ "user-agent": "AgentB/2.0" }));
    assert.equal(a.startsWith("unknown:"), true);
    assert.equal(b.startsWith("unknown:"), true);
    assert.notEqual(a, b); // abuse isolation: one noisy client != everyone's quota
  });
});

// ---------------------------------------------------------------------------
// LRU eviction — the MAX_KEYS=100_000 memory-DoS bound. Kept last: it churns
// the shared Map with 100k filler keys.
// ---------------------------------------------------------------------------

test("LRU eviction at MAX_KEYS gives the evicted (oldest) key a fresh bucket", () => {
  const windowMs = 3_600_000;
  const victim = `lru-victim:${Math.random()}`;
  assert.equal(checkRateLimit(victim, 1, windowMs), true);
  assert.equal(checkRateLimit(victim, 1, windowMs), false); // exhausted
  // Insert 100k distinct new keys: once the Map reaches MAX_KEYS, each further
  // new-key insert evicts the oldest entry — the victim (and the handful of
  // keys earlier tests created) are the oldest, so the victim is evicted.
  for (let i = 0; i < 100_000; i++) {
    checkRateLimit(`lru-fill:${i}`, 1, windowMs);
  }
  // Evicted => fresh bucket; without eviction this would still be false.
  assert.equal(checkRateLimit(victim, 1, windowMs), true);
});

// ── reserve-then-refund (the login gate) ───────────────────────────────────

test("concurrent attempts cannot all pass the gate — reserving is atomic where peeking was not", () => {
  // peekRateLimit is synchronous, but the password verify between it and
  // recordFailure is AWAITED, so N concurrent sign-in attempts every one observed an
  // under-limit bucket and every one got a real password verification regardless of
  // the limit. This simulates that interleaving: gate all attempts BEFORE any of them
  // reports its outcome.
  const key = `atomic-${Math.round(performance.now() * 1000)}`;
  const LIMIT = 3;

  const peeked = Array.from({ length: 10 }, () => peekRateLimit(key, LIMIT, 60_000));
  assert.equal(peeked.filter(Boolean).length, 10, "peek lets every concurrent attempt through — the bug");

  const reserved = Array.from({ length: 10 }, () => checkRateLimit(key, LIMIT, 60_000));
  assert.equal(reserved.filter(Boolean).length, LIMIT, "reserving admits exactly the limit, whatever the interleaving");
});

test("refundHit gives a reserved slot back so a successful sign-in does not consume the bucket", () => {
  // The property the peek/record split existed for: the account bucket counts real
  // FAILED verifications, not successful ones. Reserving would break that without a
  // refund on the success path.
  const key = `refund-${Math.round(performance.now() * 1000)}`;
  const LIMIT = 2;

  for (let i = 0; i < 50; i++) {
    assert.ok(checkRateLimit(key, LIMIT, 60_000), `a successful sign-in must never exhaust the bucket (iteration ${i})`);
    refundHit(key); // success path
  }

  // A genuine failure keeps its reservation, and the limit still bites.
  assert.ok(checkRateLimit(key, LIMIT, 60_000));
  assert.ok(checkRateLimit(key, LIMIT, 60_000));
  assert.equal(checkRateLimit(key, LIMIT, 60_000), false, "two failures must still exhaust a limit of 2");
});

test("refundHit on an unknown or empty key is a no-op, never a negative count", () => {
  assert.doesNotThrow(() => refundHit("never-seen-key"));
  const key = `empty-${Math.round(performance.now() * 1000)}`;
  assert.ok(checkRateLimit(key, 1, 60_000));
  refundHit(key);
  refundHit(key); // extra refund must not create headroom beyond a fresh bucket
  assert.ok(checkRateLimit(key, 1, 60_000));
  assert.equal(checkRateLimit(key, 1, 60_000), false);
});

// ── IPv6 /64 bucketing (getClientIpKey / ipBucketKey) ────────────────────────
// An IPv6 delegation is typically a /64 — 2^64 addresses one holder may freely
// choose. Keying limiter buckets on the full address let that holder mint a
// fresh empty bucket per request and rotate past every IP-keyed limit, so the
// bucket key collapses to the /64 prefix while IPv4 keeps its full address.

test("ipBucketKey collapses a full IPv6 /64 to one prefixed bucket", () => {
  const a = ipBucketKey("2001:db8:abcd:1234::1");
  const b = ipBucketKey("2001:db8:abcd:1234:ffff:ffff:ffff:fffe");
  assert.equal(a, b, "two hosts in the same /64 share a bucket");
  assert.equal(a, "v6:2001:0db8:abcd:1234", "keyed on the canonical /64 prefix");
});

test("ipBucketKey separates different IPv6 /64s", () => {
  assert.notEqual(
    ipBucketKey("2001:db8:abcd:1234::1"),
    ipBucketKey("2001:db8:abcd:5678::1"),
    "a different /64 is a different bucket",
  );
});

test("ipBucketKey keeps IPv4 and the unknown UA bucket keyed in full", () => {
  assert.equal(ipBucketKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucketKey("unknown:deadbeefcafe"), "unknown:deadbeefcafe");
});

test("ipBucketKey keys a v4-mapped IPv6 literal on the embedded IPv4", () => {
  // ::ffff:203.0.113.7 is really an IPv4 client — collapsing it to an all-zero
  // /64 would make every mapped-v4 client share one bucket.
  assert.equal(ipBucketKey("::ffff:203.0.113.7"), "203.0.113.7");
});

test("ipBucketKey strips an IPv6 zone index before prefixing", () => {
  assert.equal(ipBucketKey("fe80::1%eth0"), ipBucketKey("fe80::2%eth0"));
});

test("getClientIpKey buckets the trusted forwarded IPv6 by /64", () => {
  withEnv({ TRUST_PROXY: "true", TRUSTED_PROXY_HOPS: "1" }, () => {
    const k1 = getClientIpKey(new Headers({ "x-forwarded-for": "2001:db8:abcd:1234::1" }));
    const k2 = getClientIpKey(new Headers({ "x-forwarded-for": "2001:db8:abcd:1234::99" }));
    assert.equal(k1, k2, "rotating the low 64 bits cannot mint a fresh limiter bucket");
  });
});
