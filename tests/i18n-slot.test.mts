// A translated sentence with one element inside it (src/lib/i18n/slot.ts):
// the element sits where the locale's word order puts it, and a translation
// that drops the slot never moves the element to the end of the sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SLOT, splitAtSlot } from "../src/lib/i18n/slot.ts";

test("the text around the slot, in the locale's order", () => {
  assert.deepEqual(splitAtSlot(`Request ${SLOT}?`), { before: "Request ", after: "?" });
  assert.deepEqual(splitAtSlot(`${SLOT} anfragen?`), { before: "", after: " anfragen?" });
});

test("a translation without the slot is reported, not split", () => {
  assert.equal(splitAtSlot("Request this title?"), null);
});

test("a repeated slot keeps the first and never prints a stray one", () => {
  assert.deepEqual(splitAtSlot(`a ${SLOT} b ${SLOT} c`), { before: "a ", after: " b  c" });
});

test("the request and report dialogs render their emphasized names through SlotText", () => {
  for (const p of ["src/components/media/request-button.tsx", "src/components/media/report-issue-button.tsx"]) {
    const src = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    assert.match(src, /<SlotText text=\{t\("[^"]+", \{ \w+: SLOT \}\)\}>/, p);
    assert.doesNotMatch(src, /split\("\\u0000"\)/, `${p}: a hand-rolled split is back`);
  }
});
