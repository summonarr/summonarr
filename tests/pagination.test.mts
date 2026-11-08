// Unit tests for the shared page-param parser (src/lib/pagination.ts). The clamp
// is load-bearing: an unclamped `?page=` drives Prisma's `skip` (page × size) into
// the trillions. Pure, zero-import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageNumber, parsePageParam } from "../src/lib/pagination.ts";

const sp = (v: string | null) => {
  const p = new URLSearchParams();
  if (v !== null) p.set("page", v);
  return p;
};

test("parsePageParam returns 1 when absent, blank, junk, or non-positive", () => {
  assert.equal(parsePageParam(sp(null)), 1);
  assert.equal(parsePageParam(sp("")), 1);
  assert.equal(parsePageParam(sp("abc")), 1);
  assert.equal(parsePageParam(sp("0")), 1);
  assert.equal(parsePageParam(sp("-5")), 1);
});

test("parsePageParam passes a normal page through", () => {
  assert.equal(parsePageParam(sp("1")), 1);
  assert.equal(parsePageParam(sp("42")), 42);
  // parseInt semantics: a numeric prefix is taken.
  assert.equal(parsePageParam(sp("7abc")), 7);
});

test("parsePageParam clamps an oversized page to the max (default 10_000)", () => {
  assert.equal(parsePageParam(sp("999999999999")), 10_000);
  assert.equal(parsePageParam(sp("10001")), 10_000);
  assert.equal(parsePageParam(sp("10000")), 10_000);
});

test("parsePageParam honors a custom max", () => {
  assert.equal(parsePageParam(sp("500"), { max: 100 }), 100);
  assert.equal(parsePageParam(sp("50"), { max: 100 }), 50);
});

// The raw-value form a server component reads straight off `searchParams`.
test("parsePageNumber clamps a page past Prisma's 64-bit skip to the max", () => {
  assert.equal(parsePageNumber("99999999999999999999"), 10_000);
  assert.equal(parsePageNumber("1e30"), 1, "parseInt reads the numeric prefix only");
  assert.equal(parsePageNumber("10001"), 10_000);
  assert.equal(parsePageNumber("250", { max: 100 }), 100);
});

test("parsePageNumber returns 1 for absent, blank, junk or non-positive input", () => {
  assert.equal(parsePageNumber(undefined), 1);
  assert.equal(parsePageNumber(null), 1);
  assert.equal(parsePageNumber(""), 1);
  assert.equal(parsePageNumber("abc"), 1);
  assert.equal(parsePageNumber("0"), 1);
  assert.equal(parsePageNumber("-3"), 1);
  assert.equal(parsePageNumber("42"), 42);
});

test("parsePageNumber reads the first value of a repeated ?page= key", () => {
  assert.equal(parsePageNumber(["3", "9"]), 3);
  assert.equal(parsePageNumber(["99999999999999999999"]), 10_000);
  assert.equal(parsePageNumber([]), 1);
});
