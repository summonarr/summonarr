// Unit tests for the shared server-URL validator/redactor (src/lib/server-url.ts),
// used by both /api/settings and /api/admin/media-instances so the default and
// per-instance keys reject the exact same shapes. Pure, zero-import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateServerUrl, stripUrlUserinfo, SERVER_URL_MAX_LEN } from "../src/lib/server-url.ts";

test("validateServerUrl accepts plain http(s) server URLs", () => {
  assert.equal(validateServerUrl("http://plex.lan:32400"), null);
  assert.equal(validateServerUrl("https://jelly.example.com"), null);
  assert.equal(validateServerUrl("http://10.0.0.5:7878/"), null);
});

test("validateServerUrl rejects a non-http(s) scheme", () => {
  assert.match(validateServerUrl("ftp://host") ?? "", /http\(s\)/);
  assert.match(validateServerUrl("javascript:alert(1)") ?? "", /http\(s\)/);
  assert.match(validateServerUrl("file:///etc/passwd") ?? "", /http\(s\)/);
});

test("validateServerUrl rejects embedded credentials (they ship out on every fetch)", () => {
  assert.match(validateServerUrl("http://user:pass@plex.lan:32400") ?? "", /credentials/);
  assert.match(validateServerUrl("https://:secret@host") ?? "", /credentials/);
  // A bare username with no password still counts.
  assert.match(validateServerUrl("http://user@host") ?? "", /credentials/);
});

test("validateServerUrl rejects an unparseable URL", () => {
  assert.match(validateServerUrl("not a url") ?? "", /valid URL/);
  assert.match(validateServerUrl("http://") ?? "", /valid URL/);
});

test("validateServerUrl httpsOnly forbids http", () => {
  assert.match(validateServerUrl("http://relay.example.com", { httpsOnly: true }) ?? "", /https/);
  assert.equal(validateServerUrl("https://relay.example.com", { httpsOnly: true }), null);
});

test("validateServerUrl enforces a length cap", () => {
  const long = "http://h/" + "a".repeat(SERVER_URL_MAX_LEN);
  assert.match(validateServerUrl(long) ?? "", /characters or fewer/);
  assert.equal(validateServerUrl("http://h/" + "a".repeat(10), { maxLen: 100 }), null);
  assert.match(validateServerUrl("http://h/" + "a".repeat(200), { maxLen: 100 }) ?? "", /characters or fewer/);
});

test("stripUrlUserinfo removes embedded credentials, passes clean URLs and non-URLs through", () => {
  assert.equal(stripUrlUserinfo("http://user:pass@host:8096/"), "http://host:8096/");
  assert.equal(stripUrlUserinfo("http://host:8096/"), "http://host:8096/");
  // A non-URL value is returned unchanged (never throws).
  assert.equal(stripUrlUserinfo("not a url"), "not a url");
  assert.equal(stripUrlUserinfo(""), "");
});
