// The upstream result type (src/lib/upstream-result.ts): an answer ("ok",
// "missing") is kept apart from a failure, a failure is never cacheable, and a
// malformed payload is a failure — never "missing".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCacheable,
  mapUpstream,
  upstreamChecked,
  upstreamFailed,
  upstreamMissing,
  upstreamOk,
  valueOr,
  type UpstreamResult,
} from "../src/lib/upstream-result.ts";
import { v } from "../src/lib/validate.ts";

test("the constructors build the three kinds", () => {
  assert.deepEqual(upstreamOk([]), { kind: "ok", value: [] });
  assert.deepEqual(upstreamMissing(), { kind: "missing" });
  const cause = new Error("HTTP 503");
  assert.deepEqual(upstreamFailed(cause), { kind: "failed", error: cause });
});

test("only an answer is cacheable: ok and missing yes, failed never", () => {
  assert.equal(isCacheable(upstreamOk(null)), true);
  assert.equal(isCacheable(upstreamOk([])), true, "an empty list is an answer");
  assert.equal(isCacheable(upstreamMissing()), true, "the upstream said there is nothing: an answer");
  assert.equal(isCacheable(upstreamFailed(new Error("timeout"))), false);
  assert.equal(isCacheable(upstreamFailed(undefined)), false, "even a failure with no error object");
});

test("isCacheable narrows the result to an answer", () => {
  const r: UpstreamResult<number> = upstreamOk(1);
  if (isCacheable(r)) {
    // @ts-expect-error — an answer has no failure branch left
    void r.error;
    assert.equal(r.kind === "ok" ? r.value : null, 1);
  }
});

test("a malformed payload is a failure, never missing", () => {
  const Movie = v.object({ id: v.int(), title: v.string() });
  const good = upstreamChecked(Movie, { id: 1, title: "Alien", extra: true });
  assert.deepEqual(good, { kind: "ok", value: { id: 1, title: "Alien" } });

  for (const payload of [{ id: "1", title: "Alien" }, undefined, null, "<html>"]) {
    const bad = upstreamChecked(Movie, payload);
    assert.equal(bad.kind, "failed");
    assert.equal(isCacheable(bad), false);
    assert.ok(bad.kind === "failed" && bad.error instanceof Error);
  }
  const bad = upstreamChecked(Movie, { id: "1", title: "Alien" });
  assert.match(String(bad.kind === "failed" && (bad.error as Error).message), /id: expected integer, got string/);
});

test("valueOr gives the value, else the fallback for missing and failed alike", () => {
  assert.equal(valueOr(upstreamOk(7), 0), 7);
  assert.equal(valueOr(upstreamOk(0), 5), 0, "a falsy value is still the value");
  assert.equal(valueOr(upstreamMissing(), "none"), "none");
  assert.equal(valueOr(upstreamFailed(new Error("x")), "none"), "none");
});

test("mapUpstream transforms only a value; missing and failed pass through as they are", () => {
  assert.deepEqual(mapUpstream(upstreamOk(2), (n) => n * 10), { kind: "ok", value: 20 });
  const missing = upstreamMissing();
  assert.equal(mapUpstream<number, number>(missing, () => assert.fail("not called")), missing);
  const failed = upstreamFailed(new Error("x"));
  assert.equal(mapUpstream<number, number>(failed, () => assert.fail("not called")), failed);
});
