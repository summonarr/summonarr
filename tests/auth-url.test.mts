// parseAuthUrl — the boot-time AUTH_URL rule.
//
// instrumentation.ts process.exit(1)s and cannot be exercised by this suite, so
// the rule lives in a pure helper and is pinned here instead. What matters is the
// SET-BUT-UNUSABLE case: the boot check used to test presence only, so a
// scheme-less host passed it and then threw inside proxy.ts's buildLoginRedirect
// (`new URL("/login", base)`) on every logged-out request.

import test from "node:test";
import assert from "node:assert/strict";

import { parseAuthUrl } from "../src/lib/auth-url.ts";

test("a well-formed absolute http(s) URL parses", () => {
  assert.equal(parseAuthUrl("https://requests.example.com")?.origin, "https://requests.example.com");
  assert.equal(parseAuthUrl("http://192.168.1.10:3001")?.origin, "http://192.168.1.10:3001");
  // A path is kept — callers use the URL as a base, and BASE_PATH deployments rely on it.
  assert.equal(parseAuthUrl("https://example.com/requests")?.pathname, "/requests");
});

test("surrounding whitespace is tolerated", () => {
  // A trailing newline is easy to acquire from a .env file or a docker secret.
  assert.equal(parseAuthUrl("  https://example.com\n")?.origin, "https://example.com");
});

test("a scheme-less host is REJECTED — the typo that used to pass a presence check", () => {
  // This is the whole point of the helper. `new URL("/login", "requests.example.com")`
  // throws, so accepting this value boots an app that 500s every logged-out request.
  assert.equal(parseAuthUrl("requests.example.com"), null);
  assert.equal(parseAuthUrl("example.com:3001"), null);
  assert.equal(parseAuthUrl("//example.com"), null);
});

test("absent, blank, or whitespace-only is null", () => {
  assert.equal(parseAuthUrl(undefined), null);
  assert.equal(parseAuthUrl(""), null);
  assert.equal(parseAuthUrl("   "), null);
});

test("a non-http(s) scheme is rejected even though it parses", () => {
  // These construct fine as URLs but are unusable as an origin for redirect and
  // CSRF checks, so presence-plus-parses would still not be enough.
  assert.equal(parseAuthUrl("file:///srv/app"), null);
  assert.equal(parseAuthUrl("ftp://example.com"), null);
  assert.equal(parseAuthUrl("javascript:alert(1)"), null);
});

test("every accepted value is safe to use as a `new URL(path, base)` base", () => {
  // The property the boot check exists to guarantee. Anything parseAuthUrl accepts
  // must not throw in buildLoginRedirect; anything it rejects is refused at boot.
  for (const raw of ["https://example.com", "http://10.0.0.5:3000", "https://example.com/base"]) {
    const parsed = parseAuthUrl(raw);
    assert.ok(parsed, `${raw} should parse`);
    assert.doesNotThrow(() => new URL("/login", parsed!.toString()));
  }
});
