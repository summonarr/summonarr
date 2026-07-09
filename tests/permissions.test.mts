// Unit tests for the Overseerr-style capability bitmask (src/lib/permissions.ts).
// This module is the authorization source of truth — a regression here silently
// grants or denies requests/admin actions — and it is a pure leaf (zero imports),
// so it is exhaustively unit-testable. Run via `npm test` (Node's built-in runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Permission,
  KNOWN_MASK,
  hasPermission,
  effectivePermissions,
  canRequest,
  canAutoApprove,
  parsePermissions,
  serializePermissions,
  parseAndValidatePermissions,
} from "../src/lib/permissions.ts";

test("ADMIN superbit grants every capability", () => {
  const admin = Permission.ADMIN;
  assert.equal(hasPermission(admin, Permission.MANAGE_USERS), true);
  assert.equal(hasPermission(admin, Permission.REQUEST_4K_TV), true);
  assert.equal(canRequest(admin, "TV", true), true);
  assert.equal(canAutoApprove(admin, "MOVIE", true), true);
});

test("hasPermission or/and modes", () => {
  const perms = Permission.REQUEST_MOVIE; // single bit
  assert.equal(hasPermission(perms, [Permission.REQUEST, Permission.REQUEST_MOVIE], "or"), true);
  assert.equal(hasPermission(perms, [Permission.REQUEST, Permission.REQUEST_MOVIE], "and"), false);
  // Empty requirement list is trivially satisfied.
  assert.equal(hasPermission(0n, [], "and"), true);
  // No matching bit → denied.
  assert.equal(hasPermission(Permission.REQUEST_MOVIE, Permission.MANAGE_ISSUES), false);
});

test("effectivePermissions: ADMIN role adds the superbit; unseeded falls back to preset", () => {
  // role=ADMIN always resolves to the superbit even from a bare mask.
  assert.equal((effectivePermissions("ADMIN", 0n) & Permission.ADMIN) !== 0n, true);
  // permissions===0n (unseeded) → USER preset (can request movies + TV).
  const userEff = effectivePermissions("USER", 0n);
  assert.equal(canRequest(userEff, "MOVIE", false), true);
  assert.equal(canRequest(userEff, "TV", false), true);
  // A non-zero mask is authoritative and is NOT widened by the preset.
  const restricted = Permission.REQUEST_MOVIE;
  assert.equal(effectivePermissions("USER", restricted), restricted);
  assert.equal(canRequest(restricted, "TV", false), false);
});

test("canRequest: umbrella-or-specific, plus 4K gating", () => {
  // Umbrella REQUEST grants both types at HD.
  assert.equal(canRequest(Permission.REQUEST, "MOVIE", false), true);
  assert.equal(canRequest(Permission.REQUEST, "TV", false), true);
  // Specific bit grants only its type.
  assert.equal(canRequest(Permission.REQUEST_MOVIE, "MOVIE", false), true);
  assert.equal(canRequest(Permission.REQUEST_MOVIE, "TV", false), false);
  // 4K needs a base grant AND a 4K bit...
  assert.equal(canRequest(Permission.REQUEST_MOVIE, "MOVIE", true), false);
  assert.equal(canRequest(Permission.REQUEST_MOVIE | Permission.REQUEST_4K_MOVIE, "MOVIE", true), true);
  // ...unless the server-wide 4K toggle is on (base grant is then sufficient).
  assert.equal(canRequest(Permission.REQUEST_MOVIE, "MOVIE", true, true), true);
  // But server-wide 4K still requires the base media grant.
  assert.equal(canRequest(Permission.REQUEST_TV, "MOVIE", true, true), false);
});

test("canAutoApprove: 4K vs non-4K bits are distinct", () => {
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_MOVIE, "MOVIE", false), true);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_MOVIE, "MOVIE", true), false);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K_MOVIE, "MOVIE", true), true);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE, "TV", false), true);
});

test("parsePermissions / serializePermissions round-trip via decimal string", () => {
  const mask = Permission.REQUEST | Permission.REQUEST_4K | Permission.MANAGE_ISSUES;
  assert.equal(parsePermissions(serializePermissions(mask)), mask);
  assert.equal(parsePermissions(null), 0n);
  assert.equal(parsePermissions("not-a-number"), 0n);
});

test("parseAndValidatePermissions rejects junk and unknown bits", () => {
  assert.equal(parseAndValidatePermissions(serializePermissions(Permission.REQUEST)), Permission.REQUEST);
  assert.equal(parseAndValidatePermissions("0"), 0n);
  assert.equal(parseAndValidatePermissions(""), null); // not \d+
  assert.equal(parseAndValidatePermissions("-1"), null); // regex rejects sign
  assert.equal(parseAndValidatePermissions(123 as unknown as string), null); // not a string
  // A bit outside KNOWN_MASK must be rejected (can't smuggle undefined bits).
  const smuggled = (KNOWN_MASK | (1n << 40n)).toString();
  assert.equal(parseAndValidatePermissions(smuggled), null);
});
