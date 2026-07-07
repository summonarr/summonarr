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
