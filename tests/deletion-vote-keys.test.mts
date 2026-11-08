// The deletion-vote threshold's keys (src/lib/deletion-vote-keys.ts): one
// marker spelling for the claim, the re-arm, the dismiss and the available wipe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { deletionVoteMarkerKey, parseDeletionVoteThreshold } = await import("../src/lib/deletion-vote-keys.ts");

test("the marker key names the title and its media type", () => {
  assert.equal(deletionVoteMarkerKey(603, "MOVIE"), "deletionVoteNotified:603:MOVIE");
  assert.notEqual(deletionVoteMarkerKey(603, "MOVIE"), deletionVoteMarkerKey(603, "TV"));
});

test("a threshold is a positive whole number; anything else is off (0)", () => {
  assert.equal(parseDeletionVoteThreshold("5"), 5);
  for (const raw of [null, undefined, "", "0", "-3", "abc"]) assert.equal(parseDeletionVoteThreshold(raw), 0, String(raw));
});

test("no writer spells the marker key out by hand", () => {
  for (const file of [
    "src/app/api/votes/route.ts",
    "src/app/api/votes/[tmdbId]/route.ts",
    "src/lib/deletion-vote-threshold.ts",
    "src/lib/notify-available.ts",
  ]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /`deletionVoteNotified:\$\{/, file);
  }
});
