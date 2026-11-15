// writeDeletionVote (src/lib/client/vote-write.ts): the vote buttons' DELETE /
// PATCH. fetch is scripted; no network.
import { test } from "node:test";
import assert from "node:assert/strict";

let answer: () => Response = () => new Response("{}", { status: 200 });
// A scripted queue wins over `answer`; each call is recorded.
let queue: Array<() => Response> = [];
let calls: Array<{ url: string; token: unknown }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as { _token?: unknown }) : null;
  calls.push({ url: String(input), token: body?._token });
  return (queue.shift() ?? answer)();
}) as typeof fetch;

const { writeDeletionVote, castDeletionVote } = await import("../src/lib/client/vote-write.ts");

const write = (okOn404 = false) =>
  writeDeletionVote({
    method: "DELETE", tmdbId: 1, mediaType: "MOVIE", okOn404, failed: "failed",
    signal: new AbortController().signal, t: (key: string) => key,
  });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the route's own 2xx is done; a 404 only when the caller counts it", async () => {
  answer = () => json(200, { ok: true });
  assert.deepEqual(await write(), { ok: true });
  answer = () => json(404, { error: "gone" });
  assert.deepEqual(await write(true), { ok: true });
  assert.deepEqual(await write(false), { ok: false, message: "failed" });
});

test("a 2xx reached through a redirect is not the route's answer: the vote was not written", async () => {
  answer = () => Object.defineProperty(new Response("<html>Sign in</html>", { status: 200 }), "redirected", { value: true });
  assert.deepEqual(await write(), { ok: false, message: "failed" });
});

const cast = () =>
  castDeletionVote({
    tmdbId: 603, mediaType: "MOVIE", reason: "dupe", pageToken: "stale", failed: "failed",
    signal: new AbortController().signal, t: (key: string) => key,
  });

test("a vote refused for a stale page token mints a fresh one and resends once", async () => {
  calls = [];
  queue = [() => json(403, { error: "Invalid or expired request token" }), () => json(200, { token: "fresh" }), () => json(201, { id: "v1" })];
  assert.deepEqual(await cast(), { ok: true });
  assert.deepEqual(calls.map((c) => c.url), ["/api/votes", "/api/requests/token?tmdbId=603&mediaType=MOVIE", "/api/votes"]);
  assert.deepEqual([calls[0].token, calls[2].token], ["stale", "fresh"]);
});

test("a 403 on the fresh token is final and shows the route's reason; a failed mint keeps the first 403", async () => {
  calls = [];
  queue = [() => json(403, { error: "stale" }), () => json(200, { token: "fresh" }), () => json(403, { error: "Cannot vote to delete your own request" })];
  assert.deepEqual(await cast(), { ok: false, message: "Cannot vote to delete your own request" });
  assert.equal(calls.length, 3, "no loop");

  calls = [];
  queue = [() => json(403, { error: "Invalid or expired request token" }), () => json(429, { error: "slow down" })];
  assert.deepEqual(await cast(), { ok: false, message: "Invalid or expired request token" });
  assert.equal(calls.length, 2, "nothing is resent without a fresh token");
});

test("an already-recorded vote is done; other refusals are not retried", async () => {
  calls = [];
  queue = [() => json(409, { error: "already voted" })];
  assert.deepEqual(await cast(), { ok: true });
  queue = [() => json(422, { error: "not in the library" })];
  assert.deepEqual(await cast(), { ok: false, message: "not in the library" });
  assert.equal(calls.length, 2);
  queue = [];
});
