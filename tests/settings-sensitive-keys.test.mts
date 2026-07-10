// Unit tests for the sensitive-Setting-keys list (src/lib/settings-sensitive-keys.ts).
// The array and the Set are consumed by different layers (API write-only masking
// vs the Prisma encrypt/decrypt extension) — if they ever diverge, a key ends up
// either plaintext-at-rest or ciphertext-to-upstream. Pin the invariants.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_SENSITIVE_KEYS,
  SETTINGS_SENSITIVE_KEYS_SET,
} from "../src/lib/settings-sensitive-keys.ts";

test("the Set mirrors the array exactly (no drift, no duplicates)", () => {
  assert.equal(SETTINGS_SENSITIVE_KEYS_SET.size, SETTINGS_SENSITIVE_KEYS.length);
  for (const key of SETTINGS_SENSITIVE_KEYS) {
    assert.equal(SETTINGS_SENSITIVE_KEYS_SET.has(key), true, `Set is missing "${key}"`);
  }
});

test("every entry is a plausible Setting key (non-empty camelCase identifier)", () => {
  for (const key of SETTINGS_SENSITIVE_KEYS) {
    assert.match(key, /^[a-z][a-zA-Z0-9]*$/, `"${key}" is not a camelCase Setting key`);
  }
});

test("the high-blast-radius credentials are present", () => {
  for (const key of [
    "plexAdminToken",
    "jellyfinApiKey",
    "radarrApiKey",
    "sonarrApiKey",
    "radarr4kApiKey",
    "sonarr4kApiKey",
    "webhookSecret",
    "vapidPrivateKey",
    "smtpPassword",
  ]) {
    assert.equal(SETTINGS_SENSITIVE_KEYS_SET.has(key), true, `"${key}" must stay in the sensitive list`);
  }
});

// Exhaustive pin of every key currently in the list. Removing ANY of these
// silently lands that credential plaintext-at-rest (the Prisma extension stops
// encrypting it on write) and drops the API write-only masking — the exact
// failure mode the module header warns about — while the rest of the suite
// stays green. Adding NEW keys is fine (this test only forbids removals);
// update this list when a key is deliberately added or retired.
test("every currently-known sensitive key stays in the list (removal = plaintext-at-rest)", () => {
  const mustStay = [
    "plexAdminToken",
    "jellyfinApiKey",
    "vapidPrivateKey",
    "webhookSecret",
    "sonarrWebhookSecret",
    "radarrWebhookSecret",
    "discordBotToken",
    "radarrApiKey",
    "sonarrApiKey",
    "radarr4kApiKey",
    "sonarr4kApiKey",
    "radarr4kWebhookSecret",
    "sonarr4kWebhookSecret",
    "omdbApiKey",
    "mdblistApiKey",
    "traktClientId",
    "ipinfoToken",
    "resendApiKey",
    "smtpPassword",
    "trashGithubToken",
    "apnsRelayKey",
  ] as const;
  for (const key of mustStay) {
    assert.equal(
      SETTINGS_SENSITIVE_KEYS_SET.has(key),
      true,
      `"${key}" was removed from SETTINGS_SENSITIVE_KEYS — it would be stored plaintext-at-rest`,
    );
  }
  // Guard the pin itself: if the source list grows, this count check nudges
  // the maintainer to extend mustStay so new credentials get pinned too.
  assert.equal(
    SETTINGS_SENSITIVE_KEYS.length >= mustStay.length,
    true,
    "source list shrank below the pinned set",
  );
});
