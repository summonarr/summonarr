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

test("--admin sets the ADMIN bitmask WITH the role, and the constant is Permission.ADMIN", () => {
  assert.match(RESET, /role = 'ADMIN',\s+permissions = \$3::bigint/);
  const m = RESET.match(/const ADMIN_PERMISSIONS = "(\d+)";/);
  assert.ok(m);
  assert.equal(BigInt(m[1]), Permission.ADMIN);
});
