// Unit tests for the external-href gate (src/lib/safe-url.ts). Third-party
// metadata (TMDB homepage, MDBList trailer URL) lands in <a href> — anything
// other than absolute http(s) is an XSS vector and must come back undefined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeExternalHref } from "../src/lib/safe-url.ts";

test("absolute http/https pass through (trimmed)", () => {
  assert.equal(safeExternalHref("https://example.com/movie"), "https://example.com/movie");
  assert.equal(safeExternalHref("http://example.com"), "http://example.com");
  assert.equal(safeExternalHref("  https://example.com  "), "https://example.com");
});

test("script-execution schemes are rejected", () => {
  assert.equal(safeExternalHref("javascript:alert(1)"), undefined);
  assert.equal(safeExternalHref("data:text/html,<script>alert(1)</script>"), undefined);
  assert.equal(safeExternalHref("vbscript:msgbox(1)"), undefined);
  // Scheme names are case-insensitive per URL parsing — mixed case must not slip by.
  assert.equal(safeExternalHref("JaVaScRiPt:alert(1)"), undefined);
});

test("non-http(s) but otherwise-valid schemes are rejected", () => {
  assert.equal(safeExternalHref("ftp://example.com/file"), undefined);
  assert.equal(safeExternalHref("file:///etc/passwd"), undefined);
});

test("protocol-relative and relative URLs are rejected (absolute-only contract)", () => {
  assert.equal(safeExternalHref("//evil.example.com/x"), undefined);
  assert.equal(safeExternalHref("/local/path"), undefined);
  assert.equal(safeExternalHref("movie/603"), undefined);
});

test("null / undefined / empty / garbage → undefined", () => {
  assert.equal(safeExternalHref(null), undefined);
  assert.equal(safeExternalHref(undefined), undefined);
  assert.equal(safeExternalHref(""), undefined);
  assert.equal(safeExternalHref("not a url"), undefined);
});

// The URL spec strips ASCII tab/LF/CR from the input before parsing, so these
// classic href-filter bypasses parse to protocol "javascript:" and are rejected.
// A regression from URL-parser-based checking to raw-string scheme matching
// (e.g. startsWith / regex on the trimmed input) would reopen them.
test("tab/newline-embedded scheme bypass vectors are rejected", () => {
  assert.equal(safeExternalHref("java\tscript:alert(1)"), undefined);
  assert.equal(safeExternalHref("javascript\n:alert(1)"), undefined);
  assert.equal(safeExternalHref("javascript\r:alert(1)"), undefined);
});

// Scheme comparison must be against the parser's normalized (lowercased)
// protocol, not the raw string: uppercase http(s) schemes are valid URLs and
// must pass through verbatim…
test("uppercase/mixed-case http(s) schemes are accepted verbatim", () => {
  assert.equal(safeExternalHref("HTTPS://example.com/x"), "HTTPS://example.com/x");
  assert.equal(safeExternalHref("HtTp://example.com/x"), "HtTp://example.com/x");
});

// …while http-prefixed-but-non-http schemes must be rejected. A naive
// `startsWith("http")` regression would accept these AND reject the uppercase
// forms above — the two tests together pin the protocol-equality check.
test("http-prefixed non-http schemes are rejected", () => {
  assert.equal(safeExternalHref("httpss://evil"), undefined);
  assert.equal(safeExternalHref("https2://evil"), undefined);
});
