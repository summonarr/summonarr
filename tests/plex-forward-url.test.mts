// The plex.tv PIN approval URL the settings "Connect Plex" form sends the admin
// to (src/lib/client/plex-approval-url.ts), and the address Plex sends them back
// to. The app is served only under BASE_PATH, but the form used the configured
// URL or the page origin as is — AUTH_URL (its fallback) is a bare origin — so on
// a sub-path install Plex returned the admin to /auth/plex/done at the domain
// root, a 404, and the connect flow could never finish. The PIN code was also
// spliced into the URL unencoded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plexApprovalUrl, plexForwardUrl, plexReturnBase } from "../src/lib/client/plex-approval-url.ts";

const FORM = readFileSync(new URL("../src/components/settings/forms/plex-connect-form.tsx", import.meta.url), "utf8");

// The fragment's query, decoded.
function fragmentParams(url: string): URLSearchParams {
  const hash = new URL(url).hash;
  assert.ok(hash.startsWith("#?"), url);
  return new URLSearchParams(hash.slice(2));
}

test("no configured URL: the page origin plus the base path", () => {
  assert.equal(plexReturnBase("", "https://h", "/request"), "https://h/request");
  assert.equal(
    plexForwardUrl(plexReturnBase("", "https://h", "/request"), "abc-123"),
    "https://h/request/auth/plex/done?state=abc-123",
  );
});

test("a bare-origin AUTH_URL fallback gets the base path too", () => {
  assert.equal(plexReturnBase("https://example.com", "https://ignored", "/request"), "https://example.com/request");
  assert.equal(plexReturnBase("https://example.com/", "https://ignored", "request/"), "https://example.com/request");
});

test("a configured URL that already carries the base path is used as is, trailing slash trimmed", () => {
  assert.equal(plexReturnBase("https://ext.example/request/", "https://h", "/request"), "https://ext.example/request");
  assert.equal(plexReturnBase("  https://ext.example/  ", "https://h", ""), "https://ext.example");
});

test("no base path: the configured URL, else the origin, unchanged", () => {
  assert.equal(plexReturnBase("", "https://h", ""), "https://h");
  assert.equal(plexReturnBase("", "https://h", "/"), "https://h");
  assert.equal(plexReturnBase("https://ext.example", "https://h", ""), "https://ext.example");
});

test("the approval URL query-encodes every value, the PIN code included", () => {
  const forwardUrl = plexForwardUrl("https://h/request", "s1");
  const url = plexApprovalUrl({ clientId: "client&id", code: "AB&C=D#E", forwardUrl, device: { product: "Summonarr" } });
  assert.ok(url.startsWith("https://app.plex.tv/auth#?"));
  assert.ok(!url.includes("AB&C"), "a raw & in the code would start a new parameter");
  const q = fragmentParams(url);
  assert.equal(q.get("clientID"), "client&id");
  assert.equal(q.get("code"), "AB&C=D#E");
  assert.equal(q.get("context[device][product]"), "Summonarr");
  assert.equal(q.get("forwardUrl"), "https://h/request/auth/plex/done?state=s1");
});

test("the settings form builds its approval URL through the helpers, with the per-attempt client id", () => {
  const connect = FORM.slice(FORM.indexOf("async function startPlexConnect"), FORM.indexOf("function PlexAccount("));
  assert.ok(connect.length > 0, "the connect start was found");
  assert.match(connect, /plexForwardUrl\(plexReturnBase\(siteUrl, window\.location\.origin, BASE_PATH\), state\)/);
  assert.match(connect, /plexApprovalUrl\(\{\s*clientId: pinClientId,\s*code: pinCode,/);
  assert.doesNotMatch(connect, /PLEX_CLIENT_ID/, "guardrail 6f: never the shared client id");
  assert.doesNotMatch(connect, /app\.plex\.tv/, "no second hand-built copy of the URL");
});
