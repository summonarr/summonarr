// siteBaseUrl — the root the settings page builds the copyable Radarr/Sonarr
// webhook URLs on. A cleared Site URL ("") must fall through to AUTH_URL rather
// than produce relative URLs, and the result must carry BASE_PATH or every
// copied URL 404s on a sub-path install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { siteBaseUrl } from "../src/lib/site-base-url.ts";

test("the Site URL wins, with its trailing slash stripped", () => {
  assert.equal(siteBaseUrl("https://req.example.com/", "https://auth.example.com", ""), "https://req.example.com");
});

test("a cleared (empty or blank) Site URL falls through to AUTH_URL, then to localhost", () => {
  assert.equal(siteBaseUrl("", "https://auth.example.com/", ""), "https://auth.example.com");
  assert.equal(siteBaseUrl("   ", "https://auth.example.com", ""), "https://auth.example.com");
  assert.equal(siteBaseUrl(undefined, "https://auth.example.com", undefined), "https://auth.example.com");
  assert.equal(siteBaseUrl("", "", ""), "http://localhost:3000");
  assert.equal(siteBaseUrl(null, undefined, null), "http://localhost:3000");
});

test("BASE_PATH is appended to a bare origin, once", () => {
  assert.equal(siteBaseUrl("", "https://auth.example.com", "/summonarr"), "https://auth.example.com/summonarr");
  assert.equal(siteBaseUrl("", "https://auth.example.com", "summonarr/"), "https://auth.example.com/summonarr");
  assert.equal(siteBaseUrl("https://req.example.com", "", "/summonarr"), "https://req.example.com/summonarr");
  assert.equal(siteBaseUrl("", "", "/summonarr"), "http://localhost:3000/summonarr");
  // A configured URL that already carries the base path is used as is.
  assert.equal(siteBaseUrl("https://req.example.com/summonarr/", "", "/summonarr"), "https://req.example.com/summonarr");
  // No base path (or "/") adds nothing.
  assert.equal(siteBaseUrl("https://req.example.com", "", "/"), "https://req.example.com");
});
