// Pins for deriveUserSource (src/lib/user-source.ts) — the derivation behind
// the auth-source chip on Admin → Users. The page used to infer the source
// from the email suffix alone, so a Discord shadow account (no passwordHash,
// no subject, no Account row, `discord_<id>@discord.local`) fell through to
// "plex". Pure function; no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveUserSource, type UserSourceInput } from "../src/lib/user-source.ts";

const base: UserSourceInput = {
  email: "user@example.com",
  plexUserId: null,
  jellyfinUserId: null,
  hasLocalCredentials: false,
  hasOidcAccount: false,
};

test("a Discord shadow account is labelled discord, not plex", () => {
  assert.equal(
    deriveUserSource({ ...base, email: "discord_123456789@discord.local" }),
    "discord",
  );
});

test("a legacy Plex row with a null plexUserId still reads as plex (the fallback)", () => {
  // plex-user-backfill.ts exists because these rows are real; a bare
  // `plexUserId != null` test would mislabel every one of them.
  assert.equal(deriveUserSource({ ...base, email: "someone@gmail.com" }), "plex");
});

test("a pinned Plex subject reads as plex", () => {
  assert.equal(deriveUserSource({ ...base, plexUserId: "12345" }), "plex");
});

test("a Jellyfin subject reads as jellyfin even with the synthetic address", () => {
  assert.equal(
    deriveUserSource({ ...base, jellyfinUserId: "abc", email: "jellyfin-abc@jellyfin.local" }),
    "jellyfin",
  );
});

test("the synthetic @jellyfin.local anchor alone still reads as jellyfin", () => {
  // Rows minted before the subject column was pinned carry only the anchor.
  assert.equal(deriveUserSource({ ...base, email: "jellyfin-abc@jellyfin.local" }), "jellyfin");
});

test("a Jellyfin subject on a non-synthetic address reads as jellyfin (subject beats suffix)", () => {
  assert.equal(deriveUserSource({ ...base, jellyfinUserId: "abc", email: "real@example.com" }), "jellyfin");
});

test("local credentials win over a set jellyfinUserId", () => {
  assert.equal(
    deriveUserSource({ ...base, hasLocalCredentials: true, jellyfinUserId: "abc", email: "jellyfin-abc@jellyfin.local" }),
    "local",
  );
});

test("local credentials win over a Discord shadow address", () => {
  assert.equal(
    deriveUserSource({ ...base, hasLocalCredentials: true, email: "discord_1@discord.local" }),
    "local",
  );
});

test("an oidc Account row wins over every provider signal except local", () => {
  assert.equal(deriveUserSource({ ...base, hasOidcAccount: true, plexUserId: "1" }), "oidc");
  assert.equal(deriveUserSource({ ...base, hasOidcAccount: true, jellyfinUserId: "x" }), "oidc");
  assert.equal(deriveUserSource({ ...base, hasOidcAccount: true, hasLocalCredentials: true }), "local");
});
