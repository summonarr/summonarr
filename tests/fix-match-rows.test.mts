// Pins src/lib/fix-match-rows.ts: the corrected row inherits descriptive columns,
// keys are unioned never replaced, and the old row survives only on copies that
// did not move.
import test from "node:test";
import assert from "node:assert/strict";
import { carryMeta, LIBRARY_META_KEYS, remainingOnOldRow, unionKeys } from "../src/lib/fix-match-rows.ts";

test("carryMeta: target wins, the removed row fills gaps, nulls are not carried", () => {
  const out = carryMeta(LIBRARY_META_KEYS, { title: "T", year: null }, { title: "X", year: "2020", overview: null, addedAt: 5 });
  assert.deepEqual(out, { year: "2020", addedAt: 5 });
  assert.deepEqual(carryMeta(LIBRARY_META_KEYS, null, { title: "X" }), { title: "X" });
  assert.deepEqual(carryMeta(LIBRARY_META_KEYS, null, null), {});
});

test("unionKeys: ordered, de-duplicated, blank-free", () => {
  assert.deepEqual(unionKeys(["b", null, "a"], undefined, ["a", "c", ""]), ["b", "a", "c"]);
});

test("remainingOnOldRow: deletes when everything moved, else keeps the unmoved keys canonical-first", () => {
  assert.deepEqual(remainingOnOldRow("1", ["1", "2"], new Set(["1", "2"])), { delete: true });
  assert.deepEqual(remainingOnOldRow("1", ["1", "2", "3"], new Set(["1", "3"])), { delete: false, canonicalKey: "2", keys: ["2"] });
});
