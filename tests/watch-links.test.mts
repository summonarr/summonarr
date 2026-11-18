// Unit tests for the "Watch on Plex / Jellyfin" URL shapes (src/lib/watch-links.ts,
// guardrail 35b). Pure: no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plexWatchUrls, jellyfinWatchUrl, watchItemId, isWatchLinkId } from "../src/lib/watch-links.ts";

const MACHINE = "0123456789abcdef0123456789abcdef01234567";
const JF_SERVER = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const JF_ITEM = "aabbccddeeff00112233445566778899";

test("a Plex link addresses the item through app.plex.tv and the app by machine id", () => {
  assert.deepEqual(plexWatchUrls(MACHINE, "12345"), {
    webUrl: `https://app.plex.tv/desktop/#!/server/${MACHINE}/details?key=%2Flibrary%2Fmetadata%2F12345`,
    appUrl: `plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F12345&server=${MACHINE}`,
  });
});

test("a Plex link is refused for a missing or malformed machine id or rating key", () => {
  assert.equal(plexWatchUrls("", "12345"), null);
  assert.equal(plexWatchUrls(MACHINE, ""), null);
  assert.equal(plexWatchUrls(MACHINE, "12/../3"), null);
  assert.equal(plexWatchUrls("abc&server=evil", "1"), null);
});

test("a Jellyfin link uses the browser address first, then the connection URL", () => {
  assert.equal(
    jellyfinWatchUrl(["https://watch.example.com/", "http://10.0.0.5:8096"], JF_SERVER, JF_ITEM),
    `https://watch.example.com/web/index.html#/details?id=${JF_ITEM}&serverId=${JF_SERVER}`,
  );
  assert.equal(
    jellyfinWatchUrl([undefined, "http://10.0.0.5:8096/jellyfin/"], JF_SERVER, JF_ITEM),
    `http://10.0.0.5:8096/jellyfin/web/index.html#/details?id=${JF_ITEM}&serverId=${JF_SERVER}`,
  );
  // A blank browser address falls through, exactly like an absent one.
  assert.equal(
    jellyfinWatchUrl(["  ", "http://jf.lan"], JF_SERVER, JF_ITEM),
    `http://jf.lan/web/index.html#/details?id=${JF_ITEM}&serverId=${JF_SERVER}`,
  );
});

test("a Jellyfin link never carries credentials or a non-http address", () => {
  assert.equal(jellyfinWatchUrl(["https://user:pw@jf.example.com"], JF_SERVER, JF_ITEM), null);
  assert.equal(jellyfinWatchUrl(["javascript:alert(1)"], JF_SERVER, JF_ITEM), null);
  // A credentialed browser address is skipped for the next candidate.
  assert.equal(
    jellyfinWatchUrl(["https://user:pw@jf.example.com", "https://jf.example.com"], JF_SERVER, JF_ITEM),
    `https://jf.example.com/web/index.html#/details?id=${JF_ITEM}&serverId=${JF_SERVER}`,
  );
});

test("a Jellyfin link needs an address, a server id and a well-formed item id", () => {
  assert.equal(jellyfinWatchUrl([], JF_SERVER, JF_ITEM), null);
  assert.equal(jellyfinWatchUrl(["https://jf.example.com"], "", JF_ITEM), null);
  assert.equal(jellyfinWatchUrl(["https://jf.example.com"], JF_SERVER, "x&serverId=other"), null);
});

test("the linked item is the canonical id, else the first listed copy", () => {
  assert.equal(watchItemId("10", ["20", "10"]), "10");
  assert.equal(watchItemId(null, ["20", "30"]), "20");
  assert.equal(watchItemId("", ["bad id", "30"]), "30");
  assert.equal(watchItemId(null, []), null);
  assert.equal(watchItemId(undefined, undefined), null);
});

test("an id is letters, digits and dashes only", () => {
  assert.equal(isWatchLinkId("abc-123"), true);
  assert.equal(isWatchLinkId("a/b"), false);
  assert.equal(isWatchLinkId(""), false);
  assert.equal(isWatchLinkId(42), false);
  assert.equal(isWatchLinkId("a".repeat(129)), false);
});
