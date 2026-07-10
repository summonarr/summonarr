// Unit tests for IP allowlist matching (src/lib/ip-allowlist.ts) — the gate on
// machine-session minting. Fail-closed behaviour (indeterminate client IP never
// matches) and the IPv4-mapped-IPv6 normalization (proxies vary in which form
// they forward) are the security-relevant properties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIpAllowlist, isValidIpOrCidr, isIpAllowed } from "../src/lib/ip-allowlist.ts";

test("parseIpAllowlist splits on commas, semicolons, and whitespace", () => {
  assert.deepEqual(
    parseIpAllowlist("1.2.3.4, 5.6.7.8;9.10.11.12\n13.14.15.16"),
    ["1.2.3.4", "5.6.7.8", "9.10.11.12", "13.14.15.16"],
  );
  assert.deepEqual(parseIpAllowlist("  10.0.0.0/8  "), ["10.0.0.0/8"]);
  assert.deepEqual(parseIpAllowlist(null), []);
  assert.deepEqual(parseIpAllowlist(""), []);
});

test("isValidIpOrCidr accepts bare IPs and in-range prefixes", () => {
  assert.equal(isValidIpOrCidr("1.2.3.4"), true);
  assert.equal(isValidIpOrCidr("::1"), true);
  assert.equal(isValidIpOrCidr("1.2.3.0/24"), true);
  assert.equal(isValidIpOrCidr("0.0.0.0/0"), true);
  assert.equal(isValidIpOrCidr("fd00::/8"), true);
  assert.equal(isValidIpOrCidr("2001:db8::/128"), true);
});

test("isValidIpOrCidr rejects malformed addresses and out-of-range prefixes", () => {
  assert.equal(isValidIpOrCidr("1.2.3.4/33"), false); // v4 prefix > 32
  assert.equal(isValidIpOrCidr("fd00::/129"), false); // v6 prefix > 128
  assert.equal(isValidIpOrCidr("1.2.3.4/-1"), false);
  assert.equal(isValidIpOrCidr("1.2.3/24"), false); // truncated address
  assert.equal(isValidIpOrCidr("banana"), false);
  assert.equal(isValidIpOrCidr("999.1.1.1"), false);
});

test("exact-IP entries match only that address", () => {
  assert.equal(isIpAllowed("203.0.113.7", ["203.0.113.7"]), true);
  assert.equal(isIpAllowed("203.0.113.8", ["203.0.113.7"]), false);
});

test("IPv4 CIDR matching, including /32 and /0 edges", () => {
  assert.equal(isIpAllowed("10.255.1.2", ["10.0.0.0/8"]), true);
  assert.equal(isIpAllowed("11.0.0.1", ["10.0.0.0/8"]), false);
  assert.equal(isIpAllowed("192.168.1.5", ["192.168.1.5/32"]), true);
  assert.equal(isIpAllowed("192.168.1.6", ["192.168.1.5/32"]), false);
  assert.equal(isIpAllowed("8.8.8.8", ["0.0.0.0/0"]), true);
});

test("IPv6 exact and CIDR matching, compressed forms included", () => {
  assert.equal(isIpAllowed("fd12:3456::1", ["fd00::/8"]), true);
  assert.equal(isIpAllowed("2001:db8::1", ["fd00::/8"]), false);
  assert.equal(isIpAllowed("2001:db8:0:0:0:0:0:1", ["2001:db8::1"]), true); // expanded == compressed
  assert.equal(isIpAllowed("::1", ["::/0"]), true);
  // Zone ids are stripped before matching (fe80::1%eth0 → fe80::1).
  assert.equal(isIpAllowed("fe80::1%eth0", ["fe80::/10"]), true);
});

test("IPv4-mapped IPv6 clients normalize to plain IPv4 and match v4 entries", () => {
  assert.equal(isIpAllowed("::ffff:10.0.0.5", ["10.0.0.0/8"]), true);
  assert.equal(isIpAllowed("::ffff:8.8.8.8", ["8.8.8.8"]), true);
  assert.equal(isIpAllowed("::ffff:11.0.0.1", ["10.0.0.0/8"]), false);
});

test("family mismatch never matches (v6 client vs v4 entry and vice versa)", () => {
  assert.equal(isIpAllowed("2001:db8::1", ["10.0.0.0/8"]), false);
  assert.equal(isIpAllowed("10.0.0.1", ["fd00::/8"]), false);
});

test("fail-closed: indeterminate client IP and empty allowlist never match", () => {
  assert.equal(isIpAllowed("unknown", ["0.0.0.0/0"]), false);
  assert.equal(isIpAllowed("", ["0.0.0.0/0"]), false);
  assert.equal(isIpAllowed("8.8.8.8", []), false);
});

test("malformed allowlist entries are skipped, not fatal", () => {
  assert.equal(isIpAllowed("10.0.0.1", ["banana", "999.1.1.1/8", "10.0.0.0/8"]), true);
  assert.equal(isIpAllowed("10.0.0.1", ["10.0.0.0/99"]), false); // out-of-range prefix ignored
});

// LATENT SRC QUIRK (pinned, not endorsed): isIpAllowed's prefix parse
// (src/lib/ip-allowlist.ts ~lines 141-143) uses Number(entry.slice(slash + 1)),
// and Number("") === 0 / Number(" 8") === 8. So a degenerate entry like
// "10.0.0.0/" silently acts as /0 and matches EVERY same-family client, and
// "10.0.0.0/ 8" acts as /8 — while isValidIpOrCidr rejects both tokens.
// PATCH-time validation is the only thing standing between a stored degenerate
// entry and match-everything. These tests pin the current permissive matcher
// behavior AND the validator's rejection, so any refactor that widens the gap
// (e.g. loosening the validator without tightening the matcher) fails loudly.
test("degenerate prefixes: matcher is looser than the validator (pinned quirk)", () => {
  // Empty prefix — Number("") === 0 → behaves as /0, matches any v4 client.
  assert.equal(isIpAllowed("99.9.9.9", ["10.0.0.0/"]), true);
  // Whitespace-padded prefix — Number(" 8") === 8 → behaves as /8.
  assert.equal(isIpAllowed("10.5.5.5", ["10.0.0.0/ 8"]), true);
  assert.equal(isIpAllowed("99.9.9.9", ["10.0.0.0/ 8"]), false);
  // The validator rejects both tokens, so a PATCH can never store them.
  assert.equal(isValidIpOrCidr("10.0.0.0/"), false);
  assert.equal(isValidIpOrCidr("10.0.0.0/ 8"), false);
});

// Validator/matcher inconsistency: an IPv4-mapped-IPv6 CIDR with prefix > 32 is
// VALID to store (fam=6, prefix <= 128) but can never match any client — the
// matcher normalizes the mapped base to bits=32, then skips the entry because
// prefix 104 > 32; mapped clients also normalize to 32 bits, and plain-v6
// clients fail the bits mismatch. Fail-closed, so pin the current false result:
// an admin can save "::ffff:10.0.0.0/104" and it silently never matches.
test("valid-but-dead entry: IPv4-mapped CIDR with prefix > 32 never matches (pinned)", () => {
  assert.equal(isValidIpOrCidr("::ffff:10.0.0.0/104"), true);
  assert.equal(isIpAllowed("10.0.0.5", ["::ffff:10.0.0.0/104"]), false);
  assert.equal(isIpAllowed("::ffff:10.0.0.5", ["::ffff:10.0.0.0/104"]), false);
  assert.equal(isIpAllowed("2001:db8::1", ["::ffff:10.0.0.0/104"]), false);
});

test("client IP carrying a port fails closed (never port-tolerant)", () => {
  // Some proxies put "ip:port" in X-Forwarded-For; isIP rejects it, so the
  // client parse fails and the allowlist can never match — even against an
  // entry that would match the bare IP.
  assert.equal(isIpAllowed("10.0.0.1:443", ["10.0.0.0/8", "10.0.0.1"]), false);
});

test("parseIpAllowlist(undefined) returns an empty list", () => {
  assert.deepEqual(parseIpAllowlist(undefined), []);
});
