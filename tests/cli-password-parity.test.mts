// The break-glass password scripts (scripts/reset-password.mjs, create-user.mjs)
// are the ONLY recovery path — there is no in-app "forgot password". They must
// do what the in-app change does (guardrail 6g), or "reset the password from
// the CLI after a compromise" leaves the attacker's sessions, devices and feed
// URL alive. The scripts connect to Postgres on import, so — like
// tests/review-2026-09-p13.test.mts — these pins read the SOURCE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Permission } from "../src/lib/permissions.ts";
import { verifyIdentifierPrefixFor } from "../src/lib/notification-email-verify.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const RESET = read("scripts/reset-password.mjs");
const CREATE = read("scripts/create-user.mjs");

test("both scripts enforce the app's 12-character minimum", () => {
  assert.match(RESET, /const MIN_PASSWORD_LENGTH = 12;/);
  assert.match(RESET, /password\.length < MIN_PASSWORD_LENGTH/);
  assert.match(CREATE, /password\.length < 12\)/);
  assert.doesNotMatch(RESET + CREATE, /length < 8\b/);
});

test("reset-password moves BOTH cutoffs to now, on both the plain and the --admin path", () => {
  const updates = RESET.match(/UPDATE "User"\s+SET "passwordHash" = \$1,[\s\S]*?RETURNING/g) ?? [];
  assert.equal(updates.length, 2, "the plain and the promote UPDATE");
  for (const u of updates) {
    assert.match(u, /"passwordChangedAt" = NOW\(\)/);
    assert.match(u, /"sessionsRevokedAt" = NOW\(\)/);
  }
});

test("reset-password removes what the in-app change removes: device rows, the feed URL, push and pending Discord links", () => {
  assert.match(RESET, /DELETE FROM "AuthSession" WHERE "userId" = \$1/);
  assert.match(RESET, /"calendarTokenHash" = NULL, "calendarTokenCreatedAt" = NULL/);
  assert.match(RESET, /\["PushSubscription", "DiscordLinkToken", "DiscordMergeCode"\]/);
});

// The in-app change deletes `notif-email:<id>:` rows with the sessions
// (session-footholds.ts): a pending link at a hijacker's address would otherwise
// bind through the PUBLIC confirm route after the reset.
test("reset-password also deletes the pending notification-email verification, by exact prefix, inside the transaction", () => {
  const stmt = RESET.match(
    /if \(await hasTable\(client, "VerificationToken"\)\) \{\s+await client\.query\(`DELETE FROM "VerificationToken" WHERE left\(identifier, length\(\$1\)\) = \$1`, \[\s+`notif-email:\$\{u\.id\}:`,\s+\]\);/,
  );
  assert.ok(stmt, "probed, then deleted by the app's identifier prefix (notification-email-verify.ts)");
  assert.equal(verifyIdentifierPrefixFor("ID"), "notif-email:ID:", "the script's copy of the prefix matches the app's");
  assert.doesNotMatch(RESET, /"VerificationToken"[^`]*LIKE/, "never LIKE: `_`/`%` would act as wildcards");
  // Between BEGIN and COMMIT, so it lands or rolls back with the password change.
  const begin = RESET.indexOf('client.query("BEGIN")');
  const commit = RESET.indexOf('client.query("COMMIT")');
  assert.ok(begin >= 0 && commit > begin);
  assert.ok(stmt.index! > begin && stmt.index! < commit);
});

test("--admin sets the ADMIN bitmask WITH the role, and the constant is Permission.ADMIN", () => {
  assert.match(RESET, /role = 'ADMIN',\s+permissions = \$3::bigint/);
  const m = RESET.match(/const ADMIN_PERMISSIONS = "(\d+)";/);
  assert.ok(m);
  assert.equal(BigInt(m[1]), Permission.ADMIN);
});
