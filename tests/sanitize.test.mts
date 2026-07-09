// Unit tests for input/log sanitizers (src/lib/sanitize.ts). These are
// injection defences (HTML, log-line forging, bidi spoofing), so they're worth
// pinning down. Pure leaf module. Control/bidi chars are constructed
// programmatically so this source file stays clean ASCII (no literal control
// bytes / "Trojan Source" glyphs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, sanitizeOptional, sanitizeForLog } from "../src/lib/sanitize.ts";

const RTL_OVERRIDE = String.fromCharCode(0x202e); // U+202E, a bidi override

test("sanitizeText strips HTML angle brackets, control chars, bidi overrides; trims", () => {
  assert.equal(sanitizeText("  hello  "), "hello");
  assert.equal(sanitizeText("a<script>b"), "ascriptb");
  assert.equal(sanitizeText("a\x00\x07bc"), "abc"); // NUL + BEL control char
  assert.equal(sanitizeText(`x${RTL_OVERRIDE}y`), "xy"); // bidi override stripped
  assert.equal(sanitizeText("normal text 123"), "normal text 123");
});

test("sanitizeOptional maps empty/whitespace/null to null", () => {
  assert.equal(sanitizeOptional(null), null);
  assert.equal(sanitizeOptional(undefined), null);
  assert.equal(sanitizeOptional("   "), null);
  assert.equal(sanitizeOptional("<>"), null); // sanitizes to empty
  assert.equal(sanitizeOptional("  keep me  "), "keep me");
});

test("sanitizeForLog collapses CR/LF (log-injection) and stringifies", () => {
  assert.equal(sanitizeForLog("line1\r\nFAKE LOG LINE"), "line1  FAKE LOG LINE");
  assert.equal(sanitizeForLog("a\nb"), "a b");
  assert.equal(sanitizeForLog(42), "42");
  assert.equal(sanitizeForLog(null), "null");
});
