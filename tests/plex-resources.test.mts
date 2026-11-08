import test from "node:test";
import assert from "node:assert/strict";
import { parsePlexResources, connectionsToTry, firstMatchInOrder } from "../src/lib/plex-resources.ts";

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

// A probe the test answers by hand: no timers, every ordering is explicit.
function scriptedProbe() {
  const pending = new Map<string, (v: boolean) => void>();
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const probe = (item: string) => new Promise<boolean>((resolve) => {
    started.push(item);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    pending.set(item, (v) => { inFlight--; resolve(v); });
  });
  const answer = (item: string, v: boolean) => pending.get(item)!(v);
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  return { probe, answer, started, tick, max: () => maxInFlight };
}

test("firstMatchInOrder: the most PREFERRED address that answers wins, not the first to reply", async () => {
  const p = scriptedProbe();
  const pick = firstMatchInOrder(["lan", "remote", "relay"], p.probe, 4);
  await p.tick();
  assert.deepEqual(p.started, ["lan", "remote", "relay"], "probed at once, not one after another");
  p.answer("remote", true); // the remote address answers first…
  p.answer("relay", true);
  await p.tick();
  p.answer("lan", true); // …but the LAN address still answers
  assert.equal(await pick, 0);
});

test("firstMatchInOrder: a lower-ranked match is taken once every address above it has said no", async () => {
  const p = scriptedProbe();
  const pick = firstMatchInOrder(["lan", "remote", "relay"], p.probe, 4);
  await p.tick();
  p.answer("remote", true);
  p.answer("lan", false);
  assert.equal(await pick, 1);
});

test("firstMatchInOrder: at most `concurrency` probes in flight, none started after the answer, -1 when nothing answers", async () => {
  const p = scriptedProbe();
  const items = ["a", "b", "c", "d", "e", "f"];
  const pick = firstMatchInOrder(items, p.probe, 2);
  await p.tick();
  assert.deepEqual(p.started, ["a", "b"]);
  p.answer("a", true);
  assert.equal(await pick, 0);
  p.answer("b", false);
  await p.tick();
  assert.deepEqual(p.started, ["a", "b"], "the answer is known: no further address is probed");
  assert.equal(p.max(), 2);

  const q = scriptedProbe();
  const none = firstMatchInOrder(["x", "y", "z"], q.probe, 2);
  for (const item of ["x", "y", "z"]) {
    await q.tick();
    q.answer(item, false);
  }
  assert.equal(await none, -1);
  assert.equal(q.max(), 2);
});

test("firstMatchInOrder: a probe that throws counts as no — the walk still answers", async () => {
  const hit = await firstMatchInOrder(["a", "b", "c"], async (x) => {
    if (x === "a") throw new Error("probe blew up");
    return x === "b";
  }, 2);
  assert.equal(hit, 1);
  const none = await firstMatchInOrder(["a"], async () => { throw new Error("boom"); }, 1);
  assert.equal(none, -1);
});
