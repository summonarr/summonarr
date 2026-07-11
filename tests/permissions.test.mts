// Unit tests for the Overseerr-style capability bitmask (src/lib/permissions.ts).
// This module is the authorization source of truth — a regression here silently
// grants or denies requests/admin actions — and it is a pure leaf (zero imports),
// so it is exhaustively unit-testable. Run via `npm test` (Node's built-in runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Permission,
  KNOWN_MASK,
  AUTO_APPROVE_MASK,
  PRESETS,
  defaultPermissionsForRole,
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

test("defaultPermissionsForRole: known roles map to their preset; unknown falls back to USER", () => {
  assert.equal(defaultPermissionsForRole("USER"), PRESETS.USER);
  assert.equal(defaultPermissionsForRole("ISSUE_ADMIN"), PRESETS.ISSUE_ADMIN);
  assert.equal(defaultPermissionsForRole("ADMIN"), PRESETS.ADMIN);
  // An unrecognized role string (future enum drift, corrupted row) must fall
  // back to the least-privileged USER preset, never throw or return 0n.
  assert.equal(defaultPermissionsForRole("BOGUS"), PRESETS.USER);
});

test("ISSUE_ADMIN preset grants MANAGE_ISSUES (the withIssueAdmin gate bit)", () => {
  // Unseeded (0n) ISSUE_ADMIN rows fall back to the preset; withIssueAdmin
  // gates on the MANAGE_ISSUES bit, so a preset regression would silently
  // strip issue-admin capability for every unseeded row.
  const eff = effectivePermissions("ISSUE_ADMIN", 0n);
  assert.equal(hasPermission(eff, Permission.MANAGE_ISSUES), true);
  // The preset also keeps normal requesting rights...
  assert.equal(canRequest(eff, "MOVIE", false), true);
  assert.equal(canRequest(eff, "TV", false), true);
  // ...but is NOT a full admin.
  assert.equal(hasPermission(eff, Permission.MANAGE_USERS), false);
});

test("canRequest: 4K TV branch uses the TV-specific 4K bit", () => {
  // The TV branch of the 4K check — a copy-paste swap of REQUEST_4K_TV /
  // REQUEST_4K_MOVIE between the two branches would flip these.
  assert.equal(canRequest(Permission.REQUEST_TV | Permission.REQUEST_4K_TV, "TV", true), true);
  // The MOVIE 4K bit must not satisfy the TV branch.
  assert.equal(canRequest(Permission.REQUEST_TV | Permission.REQUEST_4K_MOVIE, "TV", true), false);
  // And the TV 4K bit must not satisfy the MOVIE branch.
  assert.equal(canRequest(Permission.REQUEST_MOVIE | Permission.REQUEST_4K_TV, "MOVIE", true), false);
});

test("canRequest: REQUEST_4K umbrella grants 4K for both media types", () => {
  assert.equal(canRequest(Permission.REQUEST_MOVIE | Permission.REQUEST_4K, "MOVIE", true), true);
  assert.equal(canRequest(Permission.REQUEST_TV | Permission.REQUEST_4K, "TV", true), true);
  // The umbrella is only the 4K overlay — the base media grant is still required.
  assert.equal(canRequest(Permission.REQUEST_4K, "MOVIE", true), false);
});

test("canAutoApprove: 4K TV branch and the AUTO_APPROVE_4K umbrella", () => {
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K_TV, "TV", true), true);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K, "TV", true), true);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K, "MOVIE", true), true);
  // The MOVIE-specific 4K bit must not satisfy the TV branch.
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K_MOVIE, "TV", true), false);
});

test("canAutoApprove: a 4K grant does not leak into HD auto-approve", () => {
  // The existing distinctness test covers HD-bit-does-not-grant-4K; this is
  // the reverse direction — 4K bits must not satisfy the non-4K branch.
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K_MOVIE, "MOVIE", false), false);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K_TV, "TV", false), false);
  assert.equal(canAutoApprove(Permission.AUTO_APPROVE_4K, "MOVIE", false), false);
});

test("parsePermissions: pins the lenient JWT-boundary parse (trust boundary, not a validator)", () => {
  // parsePermissions only ever sees server-signed JWT claims, so it is
  // deliberately lenient — validation of client-supplied input happens in
  // parseAndValidatePermissions (which rejects "-1" and prefix forms via
  // /^\d+$/). These pin the current lenient behavior so any tightening is a
  // conscious decision:
  // "-1" parses to -1n — in BigInt two's-complement that is an all-bits-set
  // mask, which passes every hasPermission check including the ADMIN superbit.
  assert.equal(parsePermissions("-1"), -1n);
  assert.equal(hasPermission(parsePermissions("-1"), Permission.ADMIN), true);
  // BigInt prefix forms are accepted as-is.
  assert.equal(parsePermissions("0x10"), 16n);
  // Missing claim → no permissions.
  assert.equal(parsePermissions(undefined), 0n);
});

test("AUTO_APPROVE_MASK covers all six auto-approve bits and excludes ADMIN", () => {
  const bits = [
    Permission.AUTO_APPROVE,
    Permission.AUTO_APPROVE_MOVIE,
    Permission.AUTO_APPROVE_TV,
    Permission.AUTO_APPROVE_4K,
    Permission.AUTO_APPROVE_4K_MOVIE,
    Permission.AUTO_APPROVE_4K_TV,
  ];
  for (const bit of bits) {
    assert.equal((AUTO_APPROVE_MASK & bit) !== 0n, true);
  }
  // Exactly those bits — nothing else smuggled in.
  assert.equal(AUTO_APPROVE_MASK, bits.reduce((m, b) => m | b, 0n));
  // Documented purpose: badge auto-approve from the raw mask WITHOUT the
  // ADMIN short-circuit — so the superbit must not be part of the mask.
  assert.equal((AUTO_APPROVE_MASK & Permission.ADMIN), 0n);
});

test("parseAndValidatePermissions accepts the maximal legal mask (KNOWN_MASK)", () => {
  // Guards against an off-by-one tightening of the `value & ~KNOWN_MASK`
  // check rejecting a legitimate full-capability mask.
  assert.equal(parseAndValidatePermissions(KNOWN_MASK.toString()), KNOWN_MASK);
  // One bit above the mask is still rejected (boundary just past legal space).
  assert.equal(parseAndValidatePermissions((KNOWN_MASK + 1n).toString()), null);
});
