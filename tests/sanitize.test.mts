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

// The strip regex covers TWO bidi ranges: the overrides/embeddings
// (U+202A–U+202E) and the isolates (U+2066–U+2069, LRI/RLI/FSI/PDI). Both are
// "Trojan Source" vectors; dropping either range from the regex must fail here.
test("sanitizeText strips every bidi isolate (U+2066-U+2069) and the embedding range start (U+202A)", () => {
  for (const code of [0x2066, 0x2067, 0x2068, 0x2069, 0x202a]) {
    const ch = String.fromCharCode(code);
    assert.equal(
      sanitizeText(`x${ch}y`),
      "xy",
      `U+${code.toString(16).toUpperCase()} should be stripped`,
    );
  }
});

// The control-char range deliberately skips tab (\x09), LF (\x0A), and CR
// (\x0D) so multi-line user text (issue descriptions) survives intact. A
// regression widening the range to \x01-\x1F would silently eat newlines —
// pin that interior whitespace is preserved (leading/trailing is trimmed).
test("sanitizeText preserves interior tab/LF/CR", () => {
  assert.equal(sanitizeText("a\nb"), "a\nb");
  assert.equal(sanitizeText("a\tb"), "a\tb");
  assert.equal(sanitizeText("a\r\nb"), "a\r\nb");
  // ...while still stripping their control-char neighbours
  assert.equal(sanitizeText("a\x08\x0B\x0C\x0Eb"), "ab");
});

// Pin CURRENT behavior: despite the "control chars" comment in the source, the
// strip range ends at \x1F — DEL (\x7F) and the C1 controls (U+0080–U+009F)
// pass through untouched. Not asserting this is desirable, only that it is
// what the code does today; tightening it would be a deliberate change.
test("sanitizeText passes DEL and C1 controls through (current behavior)", () => {
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const nel = String.fromCharCode(0x85); // U+0085 NEL, a C1 control
  const c1End = String.fromCharCode(0x9f);
  assert.equal(sanitizeText(`a${del}b`), `a${del}b`);
  assert.equal(sanitizeText(`a${c1Start}${nel}${c1End}b`), `a${c1Start}${nel}${c1End}b`);
});

// sanitizeForLog's scope was deliberately widened past CR/LF: a value that
// reaches an operator's terminal can forge log content with ANSI escapes, with
// the C1/Unicode line separators, or with bidi overrides, none of which emit a
// newline. Each block below pins a distinct forging vector — dropping any one
// range from the implementation must fail here.
test("sanitizeForLog strips ESC / ANSI sequences", () => {
  const esc = String.fromCharCode(0x1b);
  assert.equal(sanitizeForLog(`a${esc}[31mb`), "a[31mb");
});

test("sanitizeForLog strips NUL, DEL and the C1 controls", () => {
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x00)}b`), "ab");
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x7f)}b`), "ab");
  // U+0085 NEL is a line break to many log viewers.
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x85)}b`), "ab");
});

test("sanitizeForLog collapses the Unicode line/paragraph separators to a space", () => {
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x2028)}b`), "a b");
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x2029)}b`), "a b");
});

test("sanitizeForLog strips bidi overrides and isolates", () => {
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x202e)}b`), "ab");
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x2066)}b`), "ab");
});

// Legitimate non-ASCII text must survive — the strip targets control and
// formatting codepoints, not accents or punctuation.
test("sanitizeForLog leaves ordinary unicode text intact", () => {
  const s = "Dune: Part Two — café";
  assert.equal(sanitizeForLog(s), s);
});

// Pin the String() coercion contract log callsites rely on for
// non-string values.
test("sanitizeForLog stringifies undefined and plain objects", () => {
  assert.equal(sanitizeForLog(undefined), "undefined");
  assert.equal(sanitizeForLog({}), "[object Object]");
});
