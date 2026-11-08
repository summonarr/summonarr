// The shared CSRF origin rules (src/lib/trusted-origin.ts) that proxy.ts,
// cron-auth.ts's admin-session path and the register route all read. The
// proxy's own use of them (statuses, bodies, the bearer/native skip) is pinned
// in tests/proxy.test.mts; cron-auth's in tests/cron-auth.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configuredTrustedOrigins,
  isTrustedOrigin,
  isTrustedRequestOrigin,
  parseTrustedOriginEntry,
  requestOrigin,
} from "../src/lib/trusted-origin.ts";
import { parseTrustedOriginEntry as viaCronAuth } from "../src/lib/cron-auth.ts";

const SELF = "http://localhost:3000";
const headers = (h: Record<string, string>) => new Headers(h);

test("an entry counts only as an absolute http(s) URL — a bare host:port parses to origin \"null\" and is skipped", () => {
  assert.equal(parseTrustedOriginEntry("summonarr.local:3001"), null);
  assert.equal(parseTrustedOriginEntry("ftp://files.example.com"), null);
  assert.equal(parseTrustedOriginEntry("null"), null);
  assert.equal(parseTrustedOriginEntry("  "), null);
  assert.equal(parseTrustedOriginEntry(" https://App.Example.com/path "), "https://app.example.com");
  // cron-auth keeps exporting the same function.
  assert.equal(viaCronAuth, parseTrustedOriginEntry);
});

test("the configured set is AUTH_URL plus every usable AUTH_TRUSTED_ORIGIN entry — never \"null\"", () => {
  assert.deepEqual(
    [...configuredTrustedOrigins({
      AUTH_URL: "https://requests.example.com/",
      AUTH_TRUSTED_ORIGIN: "summonarr.local:3001, http://192.168.1.9:3000,,file:///x",
    })],
    ["https://requests.example.com", "http://192.168.1.9:3000"],
  );
  assert.equal(configuredTrustedOrigins({}).size, 0);
  assert.equal(configuredTrustedOrigins({ AUTH_TRUSTED_ORIGIN: "summonarr.local:3001" }).size, 0);
});

test("the request's origin is its Origin header, else its Referer's origin; a malformed Referer or none at all names no origin", () => {
  assert.equal(requestOrigin(headers({ origin: "https://a.example", referer: "https://b.example/x" })), "https://a.example");
  assert.equal(requestOrigin(headers({ referer: "https://b.example/page?q=1" })), "https://b.example");
  assert.equal(requestOrigin(headers({ origin: "", referer: "https://b.example/" })), "https://b.example");
  assert.equal(requestOrigin(headers({ referer: "not a url" })), null);
  assert.equal(requestOrigin(headers({})), null);
  // A browser's opaque origin is passed through as the string it is — and
  // nothing ever trusts it.
  assert.equal(requestOrigin(headers({ origin: "null" })), "null");
});

test("the configured set is the whole allowlist; only with none configured is the request's own origin trusted", () => {
  const configured = new Set(["https://requests.example.com"]);
  assert.equal(isTrustedOrigin("https://requests.example.com", configured, SELF), true);
  assert.equal(isTrustedOrigin(SELF, configured, SELF), false, "configured origins are authoritative");
  assert.equal(isTrustedOrigin(SELF, new Set(), SELF), true, "the self-origin fallback");
  assert.equal(isTrustedOrigin("https://evil.example", new Set(), SELF), false);
  assert.equal(isTrustedOrigin("null", new Set(), SELF), false);
  assert.equal(isTrustedOrigin("null", configuredTrustedOrigins({ AUTH_TRUSTED_ORIGIN: "summonarr.local:3001" }), SELF), false);
});

test("a request naming no origin is never trusted, whatever is configured", () => {
  assert.equal(isTrustedRequestOrigin(headers({}), new Set(), SELF), false);
  assert.equal(isTrustedRequestOrigin(headers({ referer: "nope" }), new Set([SELF]), SELF), false);
  assert.equal(isTrustedRequestOrigin(headers({ referer: `${SELF}/admin` }), new Set(), SELF), true);
  assert.equal(isTrustedRequestOrigin(headers({ origin: "https://evil.example" }), new Set(), SELF), false);
});
