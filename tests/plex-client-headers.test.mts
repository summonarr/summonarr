// The X-Plex-* identification headers have one source (plex-client-headers.ts).
// Every caller that used to spell them out by hand must still send exactly the
// same names, values and order: plex.tv keys a device on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plexClientHeaders, plexClientIdentity } from "../src/lib/plex-client-headers.ts";
import { plexPinHeaders, WEB_PLEX_DEVICE } from "../src/lib/plex-pin.ts";
import { plexTvJsonHeaders, plexTvXmlHeaders } from "../src/lib/plex-http.ts";
import { plexAdminHeaders } from "../src/lib/fix-match-shared.ts";

const DEVICE_ENTRIES = (clientId: string) => [
  ["X-Plex-Client-Identifier", clientId],
  ["X-Plex-Product", "Summonarr"],
  ["X-Plex-Version", "1.0"],
  ["X-Plex-Model", "hosted"],
  ["X-Plex-Device", "Web"],
  ["X-Plex-Device-Name", "Summonarr"],
  ["X-Plex-Platform", "Web"],
  ["Accept", "application/json"],
];

test("the PIN headers ARE the shared client headers, with the same web default device", () => {
  assert.equal(plexPinHeaders, plexClientHeaders);
  assert.deepEqual(Object.entries(plexPinHeaders("cid")), DEVICE_ENTRIES("cid"));
  assert.deepEqual(Object.entries(plexPinHeaders("cid", WEB_PLEX_DEVICE)), DEVICE_ENTRIES("cid"));
  assert.deepEqual(Object.entries(plexPinHeaders("cid", { platform: "iOS", device: "iPhone", model: "15" })), [
    ["X-Plex-Client-Identifier", "cid"], ["X-Plex-Product", "Summonarr"], ["X-Plex-Version", "1.0"],
    ["X-Plex-Model", "15"], ["X-Plex-Device", "iPhone"], ["X-Plex-Device-Name", "Summonarr"], ["X-Plex-Platform", "iOS"],
    ["Accept", "application/json"],
  ]);
});

test("plex.tv JSON, XML and server-admin headers keep their exact names, values and order", () => {
  assert.deepEqual(Object.entries(plexTvJsonHeaders("tok")), [...DEVICE_ENTRIES("summonarr-server"), ["X-Plex-Token", "tok"]]);
  assert.deepEqual(Object.entries(plexTvJsonHeaders("tok", "pin-cid")), [...DEVICE_ENTRIES("pin-cid"), ["X-Plex-Token", "tok"]]);
  assert.deepEqual(Object.entries(plexTvXmlHeaders("tok")), [["X-Plex-Client-Identifier", "summonarr-server"], ["X-Plex-Token", "tok"]]);
  assert.deepEqual(Object.entries(plexAdminHeaders("tok")), [
    ["Accept", "application/json"], ["X-Plex-Token", "tok"], ["X-Plex-Client-Identifier", "summonarr-server"],
    ["X-Plex-Product", "Summonarr"], ["User-Agent", "Summonarr/1.0 (Node.js)"],
  ]);
  assert.deepEqual(Object.entries(plexClientIdentity("x")), DEVICE_ENTRIES("x").slice(0, 3));
});

test("no Plex caller spells the product or version header out by hand", () => {
  for (const file of ["plex-http.ts", "plex-pin.ts", "plex-events.ts", "plex-watchlist.ts", "plex-friends-watchlist.ts", "fix-match-shared.ts"]) {
    const src = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /"X-Plex-(Product|Version)":\s*"/, `${file} builds the identity through plex-client-headers.ts`);
  }
});
