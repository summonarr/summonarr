import test from "node:test";
import assert from "node:assert/strict";
import { parsePlexResources, connectionsToTry } from "../src/lib/plex-resources.ts";

const body = [
  { provides: "client", owned: true, clientIdentifier: "c1", connections: [] },
  { provides: "server", owned: false, clientIdentifier: "shared", name: "Friend", connections: [{ uri: "http://1.1.1.1:32400" }] },
  {
    provides: "server",
    owned: true,
    clientIdentifier: "m1",
    name: "Home",
    accessToken: "SECRET",
    connections: [
      { uri: "https://relay.plex.direct:8443/", relay: true, local: false },
      { uri: "https://remote.plex.direct:32400", relay: false, local: false },
      { uri: "http://192.168.1.2:32400", relay: false, local: true },
      { uri: "http://[::1]:32400", IPv6: true, local: true },
      { uri: "ftp://bad", local: true },
    ],
  },
];

test("keeps owned servers only, orders LAN, remote, relay, drops IPv6 and non-http", () => {
  const s = parsePlexResources(body);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].connections.map((c) => c.uri), [
    "http://192.168.1.2:32400",
    "https://remote.plex.direct:32400",
    "https://relay.plex.direct:8443",
  ]);
  assert.ok(!JSON.stringify(s).includes("SECRET"));
});

test("fallback off tries only the preferred address", () => {
  const [srv] = parsePlexResources(body);
  assert.equal(connectionsToTry(srv, false).length, 1);
  assert.equal(connectionsToTry(srv, true).length, 3);
});

test("a non-array answer is empty", () => {
  assert.deepEqual(parsePlexResources({ nope: 1 }), []);
});
