// Unit tests for two module-level guards in src/lib/api-auth.ts (exported for
// unit tests):
//
// hasRole — the role check behind requireAuth/withAdmin/withIssueAdmin. Its
// hierarchy is deliberately asymmetric: required ADMIN admits ONLY the literal
// "ADMIN", while required ISSUE_ADMIN admits ADMIN or ISSUE_ADMIN (admins can
// do everything an issue-admin can, never the reverse). Matching is exact and
// case-sensitive — role strings come from signed JWT claims minted from the
// Prisma enum, so any other spelling is a forgery/corruption and must fail
// closed.
//
// machineIpAllowed — the per-request IP re-check for machine sessions. The
// allowlist is snapshotted into the claims at mint time; absent/empty (or a
// malformed non-array claim) means "no restriction" → true, while a non-empty
// list is enforced against getClientIp(headers) via isIpAllowed. Fail-closed:
// when TRUST_PROXY is off the client IP is indeterminate (a UA-hash bucket,
// never a parseable IP), so a token with an allowlist rejects EVERY caller —
// and forwarded headers are only believed under TRUST_PROXY=true, rightmost-
// entry-first (left X-Forwarded-For entries are client-forgeable).
//
// Both functions are pure over (claims, headers, env) — no DB, no network. The
// module graph pulls in prisma via session-refresh, so TOKEN_ENCRYPTION_KEY is
// set defensively; no query is ever issued.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
// Silence rate-limit's module-load TRUST_PROXY warning; individual tests set
// the env explicitly through withTrustProxy below. The module under test is
// imported DYNAMICALLY so these assignments genuinely precede the module-graph
// load — static imports are hoisted above them (the poster-cache.test pattern).
process.env.TRUST_PROXY = "true";

import type { SessionClaims } from "../src/lib/session-jwt.ts";
const { hasRole, machineIpAllowed } = await import("../src/lib/api-auth.ts");

// ── hasRole ─────────────────────────────────────────────────────────────────

test("required ADMIN admits only the literal 'ADMIN'", () => {
  assert.equal(hasRole("ADMIN", "ADMIN"), true);
  assert.equal(hasRole("ISSUE_ADMIN", "ADMIN"), false); // no upward inheritance
  assert.equal(hasRole("USER", "ADMIN"), false);
  assert.equal(hasRole(undefined, "ADMIN"), false);
  assert.equal(hasRole("", "ADMIN"), false);
});

test("required ISSUE_ADMIN admits ADMIN or ISSUE_ADMIN, nothing else", () => {
  assert.equal(hasRole("ADMIN", "ISSUE_ADMIN"), true); // ADMIN superset
  assert.equal(hasRole("ISSUE_ADMIN", "ISSUE_ADMIN"), true);
  assert.equal(hasRole("USER", "ISSUE_ADMIN"), false);
  assert.equal(hasRole(undefined, "ISSUE_ADMIN"), false);
  assert.equal(hasRole("", "ISSUE_ADMIN"), false);
});

test("matching is exact and case-sensitive — near-miss spellings fail closed", () => {
  for (const required of ["ADMIN", "ISSUE_ADMIN"] as const) {
    assert.equal(hasRole("admin", required), false);
    assert.equal(hasRole("Admin", required), false);
    assert.equal(hasRole("issue_admin", required), false);
    assert.equal(hasRole(" ADMIN", required), false); // no trimming
    assert.equal(hasRole("SUPER_ADMIN", required), false); // no substring match
  }
});

// ── machineIpAllowed ────────────────────────────────────────────────────────

function claims(machineAllowedIps?: unknown): SessionClaims {
  return { id: "u_1", role: "USER", machineAllowedIps } as SessionClaims;
}

function headers(map: Record<string, string> = {}): Headers {
  return new Headers(map);
}

// getClientIp reads TRUST_PROXY at call time; scope each enforcement test to
// an explicit value and restore afterwards so file order can't leak env state.
function withTrustProxy<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  }
}

test("absent, empty, or malformed (non-array) allowlist claim means no restriction", () => {
  // No claim at all — the common non-machine session.
  assert.equal(machineIpAllowed(claims(undefined), headers()), true);
  // Empty list — "no allowlist configured" snapshots as [] on some paths.
  assert.equal(machineIpAllowed(claims([]), headers()), true);
  // Defensive: a corrupted/hand-rolled claim that isn't an array must not
  // throw or lock anyone out — the Array.isArray gate treats it as absent.
  assert.equal(machineIpAllowed(claims("203.0.113.7"), headers()), true);
  assert.equal(machineIpAllowed(claims({ 0: "203.0.113.7" }), headers()), true);
});

test("exact-IP entry matches the forwarded client IP (TRUST_PROXY on)", () => {
  withTrustProxy("true", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.7" });
    assert.equal(machineIpAllowed(claims(["203.0.113.7"]), h), true);
    assert.equal(machineIpAllowed(claims(["203.0.113.8"]), h), false);
  });
});

test("CIDR entries match by prefix", () => {
  withTrustProxy("true", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.7" });
    assert.equal(machineIpAllowed(claims(["203.0.113.0/24"]), h), true);
    assert.equal(machineIpAllowed(claims(["198.51.100.0/24"]), h), false);
  });
});

test("fail-closed: with TRUST_PROXY off the client IP is indeterminate and never matches", () => {
  withTrustProxy(undefined, () => {
    // Even a "matching" X-Forwarded-For is ignored — it's client-forgeable
    // without a trusted proxy, so getClientIp returns a UA-hash bucket that
    // can never parse as an IP.
    const h = headers({ "x-forwarded-for": "203.0.113.7" });
    assert.equal(machineIpAllowed(claims(["203.0.113.7"]), h), false);
    // …but a claim with no allowlist is still unrestricted.
    assert.equal(machineIpAllowed(claims(undefined), h), true);
  });
});

test("only the rightmost X-Forwarded-For entry is believed (default 1 trusted hop)", () => {
  withTrustProxy("true", () => {
    // The left entry is attacker-supplied; the right one is what the trusted
    // proxy appended. An allowlist naming the forged left entry must NOT match.
    const h = headers({ "x-forwarded-for": "203.0.113.99, 198.51.100.4" });
    assert.equal(machineIpAllowed(claims(["203.0.113.99"]), h), false);
    assert.equal(machineIpAllowed(claims(["198.51.100.4"]), h), true);
  });
});

test("X-Real-IP is the fallback when no X-Forwarded-For chain is present", () => {
  withTrustProxy("true", () => {
    const h = headers({ "x-real-ip": "198.51.100.4" });
    assert.equal(machineIpAllowed(claims(["198.51.100.4"]), h), true);
    assert.equal(machineIpAllowed(claims(["203.0.113.7"]), h), false);
  });
});

test("no forwarded headers at all → indeterminate IP → non-empty allowlist rejects", () => {
  withTrustProxy("true", () => {
    assert.equal(machineIpAllowed(claims(["203.0.113.7"]), headers()), false);
  });
});

test("malformed allowlist entries are skipped without throwing; a later valid entry still matches", () => {
  withTrustProxy("true", () => {
    const h = headers({ "x-forwarded-for": "203.0.113.7" });
    assert.equal(
      machineIpAllowed(claims(["not-an-ip", "10.0.0.0/33", "1.2.3.4/", "203.0.113.7"]), h),
      true,
    );
    assert.equal(machineIpAllowed(claims(["not-an-ip", "10.0.0.0/33"]), h), false);
  });
});

test("IPv6 clients match IPv6 entries and CIDRs; IPv4-mapped form matches its v4 entry", () => {
  withTrustProxy("true", () => {
    const v6 = headers({ "x-forwarded-for": "2001:db8::1" });
    assert.equal(machineIpAllowed(claims(["2001:db8::1"]), v6), true);
    assert.equal(machineIpAllowed(claims(["2001:db8::/32"]), v6), true);
    assert.equal(machineIpAllowed(claims(["2001:db9::/32"]), v6), false);
    // Proxies vary in forwarding ::ffff:a.b.c.d vs plain a.b.c.d — the
    // allowlist matcher normalizes the mapped form to v4.
    const mapped = headers({ "x-forwarded-for": "::ffff:203.0.113.7" });
    assert.equal(machineIpAllowed(claims(["203.0.113.7"]), mapped), true);
  });
});
