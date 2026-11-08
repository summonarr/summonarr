// maskEmail (src/lib/email-mask.ts): enough to tell accounts apart, never the address.
import { test } from "node:test";
import assert from "node:assert/strict";

const { maskEmail } = await import("../src/lib/email-mask.ts");

test("keeps the first character of the local part and the domain", () => {
  assert.equal(maskEmail("chris@example.com"), "c…@example.com");
  assert.equal(maskEmail("a@b.co"), "a…@b.co");
});

test("an address with no usable @ keeps only its first character", () => {
  assert.equal(maskEmail("jellyfin-user"), "j…");
  assert.equal(maskEmail("@example.com"), "@…");
  assert.equal(maskEmail(""), "");
});

test("a quoted local part holding an @ masks up to the LAST @", () => {
  assert.equal(maskEmail('"a@b"@example.com'), '"…@example.com');
});
