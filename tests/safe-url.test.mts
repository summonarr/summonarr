// Unit tests for the external-href gate (src/lib/safe-url.ts). Third-party
// metadata (TMDB homepage, MDBList trailer URL) lands in <a href> — anything
// other than absolute http(s) is an XSS vector and must come back undefined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeExternalHref, safeInternalPath } from "../src/lib/safe-url.ts";

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

// ── safeInternalPath — post-login redirect targets ─────────────────────────
// Consumed by the OIDC /start + /callback routes and login-form.tsx. The
// callback's 302 also carries the freshly-minted session cookie, so an
// off-origin target there is a post-authentication phishing hand-off.

test("in-app paths survive intact (path + query + hash)", () => {
  assert.equal(safeInternalPath("/requests"), "/requests");
  assert.equal(safeInternalPath("/"), "/");
  assert.equal(safeInternalPath("/admin/users?tab=x"), "/admin/users?tab=x");
  assert.equal(safeInternalPath("/movie/123#cast"), "/movie/123#cast");
  assert.equal(safeInternalPath("/tv/9?a=1&b=2"), "/tv/9?a=1&b=2");
});

test("null / undefined / empty → undefined", () => {
  assert.equal(safeInternalPath(null), undefined);
  assert.equal(safeInternalPath(undefined), undefined);
  assert.equal(safeInternalPath(""), undefined);
});

test("protocol-relative and absolute targets are rejected", () => {
  assert.equal(safeInternalPath("//evil.com"), undefined);
  assert.equal(safeInternalPath("///evil.com"), undefined);
  assert.equal(safeInternalPath("https://evil.com/x"), undefined);
  assert.equal(safeInternalPath(" //evil.com"), undefined);
});

// THE REGRESSION THIS HELPER EXISTS FOR. The WHATWG URL parser strips ASCII
// TAB/LF/CR *before* parsing, so `?callbackUrl=/%09/evil.com` arrives from
// searchParams.get() already decoded to `/\t/evil.com` — which satisfies
// "starts with / and not //" and contains no backslash, yet resolves to
// https://evil.com/. A regression to a startsWith-based string test reopens
// every case below.
test("control-character open-redirect bypasses are rejected", () => {
  assert.equal(safeInternalPath("/\t/evil.com"), undefined);
  assert.equal(safeInternalPath("/\n/evil.com"), undefined);
  assert.equal(safeInternalPath("/\r/evil.com"), undefined);
  assert.equal(safeInternalPath("/\r\n/evil.com"), undefined);
  assert.equal(safeInternalPath("/\t//evil.com"), undefined);
});

// Backslash folds to "/" for special schemes during URL parsing, so these
// resolve to an authority just like "//" does.
test("backslash-folding bypasses are rejected", () => {
  assert.equal(safeInternalPath("/\\evil.com"), undefined);
  assert.equal(safeInternalPath("\\\\evil.com"), undefined);
  assert.equal(safeInternalPath("/\t\\evil.com"), undefined);
  assert.equal(safeInternalPath("http:/\\evil.com"), undefined);
});

test("script-execution schemes are rejected", () => {
  assert.equal(safeInternalPath("javascript:alert(1)"), undefined);
  assert.equal(safeInternalPath("java\tscript:alert(1)"), undefined);
  assert.equal(safeInternalPath("data:text/html,<script>alert(1)</script>"), undefined);
});
