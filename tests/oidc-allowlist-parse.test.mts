// The OIDC allowlist settings form's text ↔ list helpers (src/lib/oidc-allowlist.ts).
// The server matches group names exactly (evaluateOidcAllowlist), so the form
// must hand it the names the admin typed. It used to split the groups box on
// commas as well as newlines, which turned an LDAP DN ("cn=media,ou=groups,…")
// into fragments that match nothing (every sign-in refused) and a display name
// ("Plex, Friends") into fragments that can match an unrelated group (admitting
// the wrong people). Pins: groups split on newlines only, domains keep comma
// splitting, the list → text direction round-trips, and the form uses these
// helpers rather than a private split (read from source: no DOM in this suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateOidcAllowlist,
  formatAllowlistLines,
  parseDomainLines,
  parseGroupLines,
  validateOidcAllowlist,
} from "../src/lib/oidc-allowlist.ts";

const FORM = join(process.cwd(), "src", "components", "settings", "forms", "oidc-allowlist-form.tsx");

test("groups split on newlines only, so a comma stays inside the name", () => {
  assert.deepEqual(parseGroupLines("cn=media,ou=groups,dc=corp\nPlex, Friends"), [
    "cn=media,ou=groups,dc=corp",
    "Plex, Friends",
  ]);
});

test("groups: each line is trimmed and blank lines are dropped", () => {
  assert.deepEqual(parseGroupLines("  Admins \n\n\r\nMedia Users\n"), ["Admins", "Media Users"]);
  assert.deepEqual(parseGroupLines(""), []);
});

test("domains still split on commas and newlines", () => {
  assert.deepEqual(parseDomainLines("a.com, b.com\nc.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(parseDomainLines(" a.com ,,\n\n"), ["a.com"]);
});

test("list → text → list round-trips comma-bearing group names", () => {
  const groups = ["cn=media,ou=groups,dc=corp,dc=com", "Plex, Friends", "Admins"];
  const text = formatAllowlistLines(groups);
  assert.equal(text, "cn=media,ou=groups,dc=corp,dc=com\nPlex, Friends\nAdmins");
  assert.deepEqual(parseGroupLines(text), groups);
  assert.equal(formatAllowlistLines([]), "");
});

test("a typed comma-bearing group survives validation and gates on the whole name", () => {
  const result = validateOidcAllowlist({ groups: parseGroupLines("Plex, Friends") });
  assert.ok(result.ok);
  assert.deepEqual(result.value.groups, ["Plex, Friends"]);
  const subject = (groups: string[]) => ({ email: null, emailVerified: false, groups });
  // A member of a separate "Friends" group is NOT admitted by "Plex, Friends".
  assert.equal(evaluateOidcAllowlist(result.value, subject(["Friends"])), "not_in_allowed_group");
  assert.equal(evaluateOidcAllowlist(result.value, subject(["Plex, Friends"])), null);
});

test("the settings form parses both boxes through the shared helpers", () => {
  const src = readFileSync(FORM, "utf-8");
  assert.match(src, /groups:\s*parseGroupLines\(groups\)/);
  assert.match(src, /emailDomains:\s*parseDomainLines\(emailDomains\)/);
  // Both seeding paths (initial render and the post-save baseline) format through the helper.
  assert.equal(src.match(/setGroups\(formatAllowlistLines\(stored\.groups\)\)/g)?.length, 1);
  assert.equal(src.match(/useState\(formatAllowlistLines\(initial\.groups\)\)/g)?.length, 1);
  // No private splitter left behind to drift from the helpers.
  assert.doesNotMatch(src, /\.split\(/);
});
