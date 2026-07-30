// Unit tests for input/log sanitizers (src/lib/sanitize.ts). These are
// injection defences (HTML, log-line forging, bidi spoofing), so they're worth
// pinning down. Pure leaf module. Control/bidi chars are constructed
// programmatically so this source file stays clean ASCII (no literal control
// bytes / "Trojan Source" glyphs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeText, sanitizeOptional, sanitizeForLog, sanitizeContainsSearch } from "../src/lib/sanitize.ts";

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

test("sanitizeForLog removes CR/LF (log-injection) and stringifies", () => {
  // Removed, NOT replaced with a space. CodeQL's log-injection barrier is
  // `replaces(s, "") and s.regexpMatch("\\n")` - it matches only when the
  // replacement is the EMPTY string, so a space here reopens seven alerts.
  assert.equal(sanitizeForLog("line1\r\nFAKE LOG LINE"), "line1FAKE LOG LINE");
  assert.equal(sanitizeForLog("a\nb"), "ab");
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

test("sanitizeForLog removes the Unicode line/paragraph separators", () => {
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x2028)}b`), "ab");
  assert.equal(sanitizeForLog(`a${String.fromCharCode(0x2029)}b`), "ab");
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
// Source-level pin on the CodeQL contract. The barrier in
// javascript/ql/lib/semmle/javascript/security/dataflow/LogInjectionQuery.qll is:
//
//   this.(StringReplaceCall).replaces(s, "") and s.regexpMatch("\\n")
//
// `replaces(old, new)` resolves `new` from the literal second argument, so the
// replacement must be the EMPTY string and the pattern must be a plain `\n`.
// The pre-v0.17.2 code used `/[\r\n]/g -> " "` and failed BOTH clauses, which
// is why seven js/log-injection alerts stayed open on already-sanitised
// callsites. Verified locally with CodeQL 2.26.1: 11 results -> 0.
// Asserting on the source text because a behavioural test cannot distinguish
// "removed" from "removed via a form CodeQL recognises".
test("sanitizeForLog keeps the exact replace form CodeQL's barrier matches", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "sanitize.ts"), "utf-8");
  const body = src.slice(src.indexOf("export function sanitizeForLog"));
  assert.match(
    body,
    /\.replace\(\/\\n\/g, ""\)/,
    'sanitizeForLog must contain a literal `.replace(/\\n/g, "")` - an empty-string '
      + "replacement of a bare newline is what CodeQL's log-injection barrier matches",
  );
  // A character class such as `[\r\n]` is NOT a constant pattern, so
  // getAReplacedString() cannot resolve it back to "\n".
  for (const bad of ["[\\r\\n]", "[\\n\\r]"]) {
    assert.equal(
      body.includes(bad),
      false,
      `sanitizeForLog must not fold CR/LF into the character class ${bad} - CodeQL `
        + "resolves the replaced string only from a constant pattern",
    );
  }
});

test("sanitizeForLog stringifies undefined and plain objects", () => {
  assert.equal(sanitizeForLog(undefined), "undefined");
  assert.equal(sanitizeForLog({}), "[object Object]");
});

// Prisma `contains` emits ILIKE with NO ESCAPE clause, so %/_ left in a search
// term stay live wildcards — an unindexable pattern-scan DoS. This is the
// shared helper every `contains:`-filtered search box now routes through.
test("sanitizeContainsSearch strips LIKE wildcard metacharacters and the escape char", () => {
  assert.equal(sanitizeContainsSearch("50% off_the_wall\\path"), "50 offthewallpath");
  assert.equal(sanitizeContainsSearch("normal title"), "normal title");
});

test("sanitizeContainsSearch bounds the length at 100 chars", () => {
  const long = "a".repeat(150);
  assert.equal(sanitizeContainsSearch(long).length, 100);
  assert.equal(sanitizeContainsSearch(long), "a".repeat(100));
});

test("sanitizeOptional runtime-guards non-strings instead of throwing", () => {
  // The declared param type is a compile-time claim only — every caller feeds it a
  // field off a parsed JSON request body. `{"title": 123}` reached .replace on a
  // number and threw, turning a 400 into a 500 on /api/hidden, /api/push/apns and
  // /api/push/subscribe.
  for (const bad of [123, true, {}, [], 0, NaN] as unknown as (string | undefined | null)[]) {
    assert.equal(sanitizeOptional(bad), null);
  }
  // Genuine strings are unaffected, including the empty-string → null contract.
  assert.equal(sanitizeOptional("  Dune  "), "Dune");
  assert.equal(sanitizeOptional("   "), null);
  assert.equal(sanitizeOptional(null), null);
  assert.equal(sanitizeOptional(undefined), null);
});
