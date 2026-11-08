// The browser's "not interested" writes (src/lib/client/hidden-items.ts), shared
// by the detail page's HideButton and the For You card's NotInterestedButton.
//
//   - Hide POSTs the title; a 409 (already hidden) is the end state wanted, so
//     it counts as done. Unhide DELETEs by an encoded query.
//   - Every failure reads the same way from both buttons: a 429 is the
//     rate-limit notice, a refusal is the route's own reason (or the caller's
//     fallback), no answer is the caller's network text, an abort is silent.
//
// fetch is scripted; no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answer: () => Response | Promise<Response> = () => new Response("{}");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
  return answer();
}) as typeof fetch;

const { hideTitle, unhideTitle, hiddenFailureText } = await import("../src/lib/client/hidden-items.ts");

const t = (key: string) => `t:${key}`;
const text = (r: Awaited<ReturnType<typeof hideTitle>>) => {
  assert.equal(r.ok, false);
  return r.ok ? "" : hiddenFailureText(r.failure, t, "fallback", "network");
};

beforeEach(() => {
  calls = [];
});

test("hide POSTs the title; a stored row and an already-hidden 409 are both done", async () => {
  answer = () => json(201, { id: "h1" });
  assert.deepEqual(await hideTitle({ tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", posterPath: "/p.jpg" }), { ok: true });
  assert.deepEqual(calls[0], {
    url: "/api/hidden",
    method: "POST",
    body: { tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", posterPath: "/p.jpg" },
  });
  answer = () => json(409, { error: "Already hidden" });
  assert.deepEqual(await hideTitle({ tmdbId: 603, mediaType: "MOVIE", title: "The Matrix" }), { ok: true });
});

test("unhide DELETEs by an encoded query; a 409 there is a failure", async () => {
  answer = () => json(200, { ok: true });
  assert.deepEqual(await unhideTitle({ tmdbId: 1399, mediaType: "TV" }), { ok: true });
  assert.deepEqual(calls[0], { url: "/api/hidden?tmdbId=1399&mediaType=TV", method: "DELETE", body: null });
  answer = () => json(409, { error: "conflict" });
  assert.equal(text(await unhideTitle({ tmdbId: 1399, mediaType: "TV" })), "conflict");
});

test("a failure reads the same from both buttons", async () => {
  answer = () => json(429, { error: "Too many requests — try again later" });
  assert.equal(text(await hideTitle({ tmdbId: 1, mediaType: "MOVIE", title: "x" })), "t:shared.rateLimited.generic");

  answer = () => json(400, { error: "mediaType must be MOVIE or TV" });
  assert.equal(text(await hideTitle({ tmdbId: 1, mediaType: "MOVIE", title: "x" })), "mediaType must be MOVIE or TV");

  answer = () => json(500, {});
  assert.equal(text(await unhideTitle({ tmdbId: 1, mediaType: "MOVIE" })), "fallback", "no reason of its own: the caller's");

  answer = () => { throw new TypeError("offline"); };
  assert.equal(text(await hideTitle({ tmdbId: 1, mediaType: "MOVIE", title: "x" })), "network");

  answer = () => new Response("<html>502</html>", { status: 502 });
  assert.equal(text(await unhideTitle({ tmdbId: 1, mediaType: "MOVIE" })), "network", "a proxy's error page is no answer");
});

test("an aborted write shows nothing", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await hideTitle({ tmdbId: 1, mediaType: "MOVIE", title: "x" }, { signal: ctrl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? null : r.failure.kind, "aborted");
  assert.equal(text(r), "");
  assert.equal(calls.length, 0, "an already-aborted write sends nothing");
});
