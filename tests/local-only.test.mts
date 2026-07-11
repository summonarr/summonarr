// Unit tests for the local-only Host gate (src/lib/local-only.ts). When
// TRUST_PROXY !== "true" this is the guard that keeps a misconfigured instance
// from serving the public internet — a public Host must read as NOT local, and
// every loopback/RFC1918/link-local/CGNAT form must read as local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalHost } from "../src/lib/local-only.ts";

test("localhost and loopback are local (with or without a port)", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("LOCALHOST:3000"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("127.0.0.1:3001"), true);
  assert.equal(isLocalHost("127.8.9.10"), true); // whole 127/8 block
});

test("RFC1918 / link-local / CGNAT IPv4 ranges are local", () => {
  assert.equal(isLocalHost("10.0.0.5"), true);
  assert.equal(isLocalHost("192.168.1.20:8080"), true);
  assert.equal(isLocalHost("172.16.0.1"), true);
  assert.equal(isLocalHost("172.31.255.255"), true);
  assert.equal(isLocalHost("169.254.1.1"), true);
  assert.equal(isLocalHost("100.64.0.1"), true); // CGNAT low edge
  assert.equal(isLocalHost("100.127.255.255"), true); // CGNAT high edge
});

test("public IPv4 and range edges are NOT local", () => {
  assert.equal(isLocalHost("8.8.8.8"), false);
  assert.equal(isLocalHost("172.15.0.1"), false); // just below 172.16/12
  assert.equal(isLocalHost("172.32.0.1"), false); // just above 172.31
  assert.equal(isLocalHost("100.63.0.1"), false); // below CGNAT
  assert.equal(isLocalHost("100.128.0.1"), false); // above CGNAT
  assert.equal(isLocalHost("11.0.0.1"), false);
});

test("IPv6 loopback / link-local / ULA are local; global IPv6 is not", () => {
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("[::1]:3000"), true);
  assert.equal(isLocalHost("[fe80::1]"), true);
  assert.equal(isLocalHost("[fc00::1]"), true);
  assert.equal(isLocalHost("[fd12:3456::1]"), true);
  assert.equal(isLocalHost("[2001:db8::1]"), false);
});

test("DNS hostnames are NOT local — only localhost and IP literals qualify", () => {
  assert.equal(isLocalHost("summonarr.example.com"), false);
  assert.equal(isLocalHost("summonarr.example.com:3001"), false);
  assert.equal(isLocalHost("myserver.local"), false); // mDNS name still isn't provably LAN
});

test("degenerate input fails closed (not local)", () => {
  assert.equal(isLocalHost(null), false);
  assert.equal(isLocalHost(undefined), false);
  assert.equal(isLocalHost(""), false);
  assert.equal(isLocalHost("   "), false);
  assert.equal(isLocalHost("["), false); // unterminated bracket
  assert.equal(isLocalHost("999.1.1.1"), false); // not a valid IPv4, not localhost
});

test("public hostname with an embedded private-IP prefix is NOT local", () => {
  // The IPv4-shape regex is anchored (^\d+(\.\d+){3}$), so a DNS name that
  // merely STARTS with a private-IP literal must not read as an IP at all —
  // it falls through to the hostname branch and fails closed. A regression to
  // an unanchored/looser regex would make these public Hosts read as local.
  assert.equal(isLocalHost("10.0.0.5.attacker.com"), false);
  assert.equal(isLocalHost("127.0.0.1.example.com"), false);
  assert.equal(isLocalHost("192.168.1.1.evil.net:3000"), false);
});

test("unbracketed IPv6 Host values (pin current behavior)", () => {
  // These pin surprising-but-harmless behavior of the port-strip heuristic
  // (everything after the LAST colon is treated as a port when numeric):
  //
  // "::1" — the strip eats the trailing "1", leaving ":", which fails every
  // check → NOT local. Fail-closed, but a future port-strip change could
  // silently flip this; the bracketed form "[::1]" is the supported spelling.
  assert.equal(isLocalHost("::1"), false);
  // "fe80::1" — the strip leaves "fe80:", which still satisfies
  // startsWith("fe80:") → local only by luck of the truncation.
  assert.equal(isLocalHost("fe80::1"), true);
});

test("leading-zero IPv4 octets parse as decimal (pin current behavior)", () => {
  // Number("010") === 10, so "010.1.2.3" reads as 10.x → local. Clients that
  // interpret leading-zero octets as octal would treat this as public
  // 8.1.2.3 — a real parser divergence. The module explicitly disclaims
  // being a security boundary (Host is spoofable), so we pin the current
  // decimal reading rather than demanding a rejection.
  assert.equal(isLocalHost("010.1.2.3"), true);
});

test("unspecified addresses: v6 :: is local, v4 0.0.0.0 is not (pin asymmetry)", () => {
  // The IPv6 branch special-cases "::" as local; the IPv4 branch has no
  // a === 0 case, so 0.0.0.0 falls through to false. Intentionally pinned
  // so a change to either side is a conscious decision.
  assert.equal(isLocalHost("[::]"), true);
  assert.equal(isLocalHost("0.0.0.0"), false);
});
