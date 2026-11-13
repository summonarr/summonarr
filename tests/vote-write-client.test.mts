// writeDeletionVote (src/lib/client/vote-write.ts): the vote buttons' DELETE /
// PATCH. fetch is scripted; no network.
import { test } from "node:test";
import assert from "node:assert/strict";

let answer: () => Response = () => new Response("{}", { status: 200 });
globalThis.fetch = (async () => answer()) as typeof fetch;

const { writeDeletionVote } = await import("../src/lib/client/vote-write.ts");

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
