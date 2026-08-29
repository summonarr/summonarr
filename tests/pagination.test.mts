// Unit tests for the shared page-param parser (src/lib/pagination.ts). The clamp
// is load-bearing: an unclamped `?page=` drives Prisma's `skip` (page × size) into
// the trillions. Pure, zero-import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageParam } from "../src/lib/pagination.ts";

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
