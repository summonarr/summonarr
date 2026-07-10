// Unit tests for email canonicalization (src/lib/email-normalize.ts). The NFKC
// fold is the anti-homoglyph control: two visually-identical-but-codepoint-
// distinct addresses must canonicalize to the same string, or they can mint
// separate accounts / sidestep an email-keyed lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail } from "../src/lib/email-normalize.ts";

test("lowercases and trims", () => {
  assert.equal(normalizeEmail("  Foo@EXAMPLE.COM "), "foo@example.com");
});

test("NFKC folds fullwidth compatibility forms to ASCII", () => {
  // Fullwidth "ｆｏｏ" (U+FF46 U+FF4F U+FF4F) must not mint a distinct account.
  assert.equal(normalizeEmail("ｆｏｏ@example.com"), "foo@example.com");
});

test("NFKC decomposes ligatures", () => {
  // "ﬁ" (U+FB01) → "fi"
  assert.equal(normalizeEmail("ﬁrst@example.com"), "first@example.com");
});

test("NFKC unifies composed and decomposed accents", () => {
  const composed = "café@example.com"; // é as one codepoint
  const decomposed = "café@example.com"; // e + combining acute
  assert.equal(normalizeEmail(composed), normalizeEmail(decomposed));
});

test("idempotent — normalizing twice is a no-op", () => {
  const once = normalizeEmail("Ｆｏｏ@Example.com ");
  assert.equal(normalizeEmail(once), once);
});

// ---------------------------------------------------------------------------
// Boundary pins: what the NFKC control does NOT cover. These document (not
// endorse) current behavior so a future "fix" or regression is a deliberate,
// visible change rather than an accident.
// ---------------------------------------------------------------------------

test("BOUNDARY PIN: NFKC does not fold cross-script homoglyphs", () => {
  // Cyrillic "а" (U+0430) renders identically to Latin "a" (U+0061) in most
  // fonts, but NFKC only applies *compatibility* decompositions — cross-script
  // confusables have none (that's Unicode UTS #39 skeleton territory, a
  // different algorithm). So "\u0430dmin@x.com" and "admin@x.com" remain distinct
  // canonical strings and CAN mint separate accounts. The module header's
  // "homoglyph" claim holds only for compatibility variants (fullwidth,
  // ligatures), not cross-script lookalikes.
  const cyrillic = "\u0430dmin@x.com"; // Cyrillic а — escaped so it can't be misread as Latin
  const latin = "admin@x.com"; //                     Latin a
  assert.notEqual(normalizeEmail(cyrillic), normalizeEmail(latin));
  // The Cyrillic codepoint survives normalization untouched.
  assert.equal(normalizeEmail(cyrillic).codePointAt(0), 0x0430);
});

test("BOUNDARY PIN: mid-string zero-width characters survive normalization", () => {
  // U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ) are invisible format (Cf)
  // characters with no NFKC compatibility mapping, and trim() only strips
  // ends (and none of these are in the JS WhiteSpace set anyway). An address
  // with an embedded zero-width char is visually identical to its clean twin
  // yet stays codepoint-distinct — the same account-duplication surface the
  // module exists to close.
  const clean = normalizeEmail("foo@example.com");
  for (const zw of ["\u200B", "\u200C", "\u200D"]) {
    const smuggled = normalizeEmail(`f${zw}oo@example.com`);
    assert.notEqual(smuggled, clean);
    assert.ok(smuggled.includes(zw), `expected ${zw.codePointAt(0)?.toString(16)} to survive`);
  }
});

test("BOUNDARY PIN: trailing zero-width space survives trim()", () => {
  // U+200B is NOT in the ECMAScript WhiteSpace set, so trim() leaves it even
  // at the string ends. (Contrast U+FEFF ZWNBSP/BOM, which IS WhiteSpace and
  // does get trimmed at the ends — but only there.)
  assert.notEqual(normalizeEmail("foo@example.com\u200B"), "foo@example.com");
  assert.equal(normalizeEmail("\uFEFFfoo@example.com"), "foo@example.com");
});
