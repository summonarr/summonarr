// The header avatar's initials fallback (src/lib/avatar-initials.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarInitials } from "../src/lib/avatar-initials.ts";

test("an empty, whitespace-only or missing name falls back to '?'", () => {
  assert.equal(avatarInitials(""), "?");
  assert.equal(avatarInitials("   "), "?");
  assert.equal(avatarInitials("\t \n"), "?");
  assert.equal(avatarInitials(null), "?");
  assert.equal(avatarInitials(undefined), "?");
});

test("at most two initials, uppercased, however many words", () => {
  assert.equal(avatarInitials("Mary Jane Watson Parker"), "MJ");
  assert.equal(avatarInitials("ada lovelace"), "AL");
  assert.equal(avatarInitials("Cher"), "C");
  // Runs of spaces never produce an empty part.
  assert.equal(avatarInitials("  Ada   Lovelace  "), "AL");
});

test("a name starting with an emoji keeps the whole code point", () => {
  assert.equal(avatarInitials("😀 Smile"), "😀S");
  assert.equal(avatarInitials("𝒜lice"), "𝒜");
  assert.equal(Array.from(avatarInitials("🎬 Film Fan")).length, 2);
});
