// The "still on the server" rule behind the admin Activity users page and GET
// /api/play-history/users. Pure — no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOnServer, jellyfinOnServer, plexOnServer } from "../src/lib/server-user-presence.ts";

const row = (over: Partial<Parameters<typeof isOnServer>[0]> = {}) => ({
  source: "plex",
  active: true,
  isServerAdmin: false,
  serverInstance: "",
  sourceUserId: "u1",
  ...over,
});

test("a Plex user is checked against THEIR server's share list, never another server's", () => {
  const members = new Map([
    ["", { ids: new Set(["u1"]) }],
    ["b", { ids: new Set(["u2"]) }],
  ]);
  assert.equal(plexOnServer(row(), members), true);
  // On A's list only: removed from B even though A still shares with them.
  assert.equal(plexOnServer(row({ serverInstance: "b" }), members), false);
  assert.equal(plexOnServer(row({ serverInstance: "b", sourceUserId: "u2" }), members), true);
});

test("the Plex server owner is always on the server (never on their own share list)", () => {
  assert.equal(plexOnServer(row({ isServerAdmin: true, sourceUserId: "owner" }), new Map([["", { ids: new Set<string>() }]])), true);
});

test("a server whose list could not be read falls back to the stored flag", () => {
  for (const members of [null, undefined, new Map<string, { ids: Set<string> }>()]) {
    assert.equal(plexOnServer(row({ active: true }), members), true);
    assert.equal(plexOnServer(row({ active: false }), members), false);
  }
  for (const live of [null, undefined, new Map<string, Map<string, boolean>>()]) {
    assert.equal(jellyfinOnServer(row({ active: true }), live), true);
    assert.equal(jellyfinOnServer(row({ active: false }), live), false);
  }
});

test("a Jellyfin user is on the server only when listed AND not disabled", () => {
  const live = new Map([["", new Map([["u1", false], ["u2", true]])]]);
  assert.equal(jellyfinOnServer(row({ sourceUserId: "u1" }), live), true);
  assert.equal(jellyfinOnServer(row({ sourceUserId: "u2" }), live), false, "disabled");
  assert.equal(jellyfinOnServer(row({ sourceUserId: "gone" }), live), false, "deleted");
  // The live answer wins over a stale stored flag, both ways.
  assert.equal(jellyfinOnServer(row({ sourceUserId: "gone", active: true }), live), false);
  assert.equal(jellyfinOnServer(row({ sourceUserId: "u1", active: false }), live), true);
});

test("isOnServer routes by source", () => {
  const plex = new Map([["", { ids: new Set(["u1"]) }]]);
  const jellyfin = new Map([["", new Map([["u1", true]])]]);
  assert.equal(isOnServer(row({ source: "plex" }), plex, jellyfin), true);
  assert.equal(isOnServer(row({ source: "jellyfin" }), plex, jellyfin), false);
});
