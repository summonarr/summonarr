// Unit tests for the parental-control cap (src/lib/content-rating.ts). Pure leaf.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsCap, isValidContentRatingCap } from "../src/lib/content-rating.ts";

test("no cap → nothing is blocked", () => {
  assert.equal(exceedsCap("R", null), false);
  assert.equal(exceedsCap("NC-17", ""), false);
  assert.equal(exceedsCap("R", undefined), false);
});

test("movie certifications compared against the cap", () => {
  assert.equal(exceedsCap("R", "PG-13"), true); // above
  assert.equal(exceedsCap("PG-13", "PG-13"), false); // equal → allowed
  assert.equal(exceedsCap("PG", "PG-13"), false); // below
  assert.equal(exceedsCap("NC-17", "R"), true);
});

test("TV ratings map onto the same maturity ladder", () => {
  assert.equal(exceedsCap("TV-MA", "PG-13"), true); // TV-MA ≈ R > PG-13
  assert.equal(exceedsCap("TV-14", "PG-13"), false); // TV-14 ≈ PG-13 → allowed
  assert.equal(exceedsCap("TV-PG", "PG-13"), false);
  assert.equal(exceedsCap("TV-Y7", "G"), false); // both rank 0
});

test("unknown / unrated certifications and caps do not over-block", () => {
  assert.equal(exceedsCap("NR", "PG-13"), false); // unrecognized cert → allowed
  assert.equal(exceedsCap("R", "NR"), false); // unrecognized cap → no cap
  assert.equal(exceedsCap(" r ", "pg-13"), true); // normalization (case/trim)
});

test("isValidContentRatingCap only accepts the MPAA ladder", () => {
  assert.equal(isValidContentRatingCap("PG-13"), true);
  assert.equal(isValidContentRatingCap("TV-MA"), false); // TV ratings aren't assignable caps
  assert.equal(isValidContentRatingCap("X"), false);
});

// Distinct from the unrecognized-string case ("NR"): a MISSING certification hits
// the `!cert` short-circuit in normalize(). The policy is fail-open — a title TMDB
// has no US certification for must not be blocked, even under the strictest cap.
test("absent certification never exceeds, even under the strictest cap", () => {
  assert.equal(exceedsCap(null, "G"), false);
  assert.equal(exceedsCap(undefined, "G"), false);
  assert.equal(exceedsCap("", "G"), false);
  assert.equal(exceedsCap("   ", "G"), false); // whitespace-only trims to empty
});

// Caps are stored values (User.maxContentRating), not user free-text: they must be
// in canonical form. isValidContentRatingCap deliberately does NOT share exceedsCap's
// trim/uppercase normalization — validate-then-store keeps the DB canonical.
test("isValidContentRatingCap is case-sensitive and does not trim", () => {
  assert.equal(isValidContentRatingCap("pg-13"), false);
  assert.equal(isValidContentRatingCap(" PG-13 "), false);
  assert.equal(isValidContentRatingCap("r"), false);
});

// "" means "no cap" to exceedsCap, but it is NOT an assignable cap value — callers
// clearing a cap must special-case the empty string rather than pass it through
// the validator.
test("empty string is not an assignable cap value", () => {
  assert.equal(isValidContentRatingCap(""), false);
});

// RANK is a plain object literal, so `"constructor" in RANK` (and toString/__proto__)
// is TRUE via the prototype chain. These certs are rejected today only because
// normalize() uppercases BEFORE the `in` lookup — Object.prototype keys are lowercase.
// Pin that: a refactor that lowercased instead, or looked up before normalizing,
// would treat inherited keys as ranked entries.
test("prototype-chain keys are not ranked certifications or caps", () => {
  assert.equal(exceedsCap("constructor", "G"), false);
  assert.equal(exceedsCap("toString", "G"), false);
  assert.equal(exceedsCap("__proto__", "G"), false);
  assert.equal(exceedsCap("hasOwnProperty", "G"), false);
  // As a cap: an inherited key must read as "no cap", never as a rank.
  assert.equal(exceedsCap("NC-17", "constructor"), false);
  assert.equal(exceedsCap("NC-17", "__proto__"), false);
});
