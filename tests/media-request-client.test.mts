// postMediaRequest — the browser's POST /api/requests (src/lib/client/media-request.ts),
// shared by the media card, the detail-page request buttons and the fix-match
// "request the right title" action.
//
// Two behaviours are pinned:
//   - A token the PAGE minted expires after one to two hours. A 403 on it mints
//     a fresh token and resends exactly once; the card used to resend the dead
//     token on every retry until the page was reloaded.
//   - When the caller has no token and the token fetch fails, nothing is posted
//     and the token route's own answer comes back. The card used to post
//     `_token: undefined` and show "invalid request token" instead.
//
// fetch is scripted; no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let tokenAnswers: Array<() => Response> = [];
let postAnswers: Array<() => Response> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ url, method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
  if (url.startsWith("/api/requests/token")) {
    const next = tokenAnswers.shift();
    assert.ok(next, `unexpected token fetch: ${url}`);
    return next();
  }
  if (url === "/api/requests" && method === "POST") {
    const next = postAnswers.shift();
    assert.ok(next, "unexpected POST /api/requests");
    return next();
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

const { postMediaRequest, fetchRequestToken, submitMediaRequest } = await import("../src/lib/client/media-request.ts");

const posts = () => calls.filter((c) => c.method === "POST");
const tokenFetches = () => calls.filter((c) => c.url.startsWith("/api/requests/token"));

beforeEach(() => {
  calls = [];
  tokenAnswers = [];
  postAnswers = [];
});

test("a page-minted token that the server refuses is refreshed and the request resent ONCE", async () => {
  postAnswers = [() => json(403, { error: "invalid request token" }), () => json(201, { id: "r1" })];
  tokenAnswers = [() => json(200, { token: "fresh" })];
  const res = await postMediaRequest({ tmdbId: 603, mediaType: "MOVIE" }, "stale");
  assert.equal(res.status, 201);
  assert.equal(tokenFetches().length, 1);
  assert.equal(tokenFetches()[0].url, "/api/requests/token?tmdbId=603&mediaType=MOVIE");
  assert.deepEqual(posts().map((p) => p.body?._token), ["stale", "fresh"]);
  // The body is the caller's own plus the token — nothing renamed or dropped.
  assert.deepEqual(posts()[1].body, { tmdbId: 603, mediaType: "MOVIE", _token: "fresh" });
});

test("a 403 on the fresh token is final — no loop", async () => {
  postAnswers = [() => json(403, { error: "a" }), () => json(403, { error: "Forbidden" })];
  tokenAnswers = [() => json(200, { token: "fresh" })];
  const res = await postMediaRequest({ tmdbId: 1, mediaType: "TV", is4k: true }, "stale");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "Forbidden");
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].body?.is4k, true, "extra payload fields ride the resend too");
});

test("when the refresh itself fails, the original 403 is what the caller sees", async () => {
  postAnswers = [() => json(403, { error: "invalid request token" })];
  tokenAnswers = [() => json(500, { error: "boom" })];
  const res = await postMediaRequest({ tmdbId: 1, mediaType: "MOVIE" }, "stale");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "invalid request token");
  assert.equal(posts().length, 1);
});

test("a non-403 answer on a page token is returned as-is, with no token fetch", async () => {
  postAnswers = [() => json(409, { error: "dup" })];
  const res = await postMediaRequest({ tmdbId: 1, mediaType: "MOVIE" }, "page");
  assert.equal(res.status, 409);
  assert.equal(tokenFetches().length, 0);
});

test("no page token: one is fetched first, and a 403 on it is NOT retried (it can't be stale)", async () => {
  tokenAnswers = [() => json(200, { token: "minted" })];
  postAnswers = [() => json(403, { error: "Forbidden" })];
  const res = await postMediaRequest({ tmdbId: 550, mediaType: "MOVIE" });
  assert.equal(res.status, 403);
  assert.equal(tokenFetches().length, 1);
  assert.deepEqual(posts().map((p) => p.body?._token), ["minted"]);
});

test("no page token and the token fetch fails: nothing is posted, the token route's answer comes back", async () => {
  tokenAnswers = [() => json(503, { error: "Service unavailable" })];
  const res = await postMediaRequest({ tmdbId: 550, mediaType: "MOVIE" });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "Service unavailable");
  assert.equal(posts().length, 0, "a request without a token can only fail as 'invalid request token'");
});

test("a 200 from the token route that carries no token is a 502, never a token-less POST", async () => {
  tokenAnswers = [() => json(200, {})];
  const minted = await fetchRequestToken(1, "TV");
  assert.ok(minted instanceof Response);
  assert.equal(minted.status, 502);

  tokenAnswers = [() => json(200, { token: 42 })];
  const res = await postMediaRequest({ tmdbId: 1, mediaType: "TV" });
  assert.equal(res.status, 502);
  assert.equal(posts().length, 0);
});

test("a network failure minting the retry's token returns the 403 — unless the caller aborted, which propagates", async () => {
  postAnswers = [() => json(403, { error: "invalid request token" })];
  tokenAnswers = [() => { throw new TypeError("fetch failed"); }];
  const res = await postMediaRequest({ tmdbId: 1, mediaType: "MOVIE" }, "stale");
  assert.equal(res.status, 403);

  const ctrl = new AbortController();
  postAnswers = [() => json(403, { error: "invalid request token" })];
  tokenAnswers = [() => {
    ctrl.abort();
    throw new DOMException("aborted", "AbortError");
  }];
  await assert.rejects(
    postMediaRequest({ tmdbId: 1, mediaType: "MOVIE" }, "stale", { signal: ctrl.signal }),
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  );
  assert.equal(posts().length, 2, "nothing is resent after the abort");
});

test("submitMediaRequest reads the answer into an outcome and an abort still propagates", async () => {
  const t = (key: string) => key;
  const payload = { tmdbId: 1, mediaType: "MOVIE" as const };
  postAnswers = [() => json(409, {})];
  assert.equal(await submitMediaRequest(payload, "tok", t), "duplicate");
  postAnswers = [() => json(200, { alreadyAvailable: true })];
  assert.equal(await submitMediaRequest(payload, "tok", t), "alreadyAvailable");
  postAnswers = [() => json(201, { id: "x" })];
  assert.equal(await submitMediaRequest(payload, "tok", t), "created");
  postAnswers = [() => new Response("not json", { status: 200 })];
  assert.equal(await submitMediaRequest(payload, "tok", t), "created");
  // A 2xx reached through a redirect is a page in front of the app (an auth
  // proxy's sign-in), not the route: nothing was requested.
  postAnswers = [() => Object.defineProperty(new Response("<html>Sign in</html>", { status: 200 }), "redirected", { value: true })];
  assert.deepEqual(await submitMediaRequest(payload, "tok", t), { error: "request.networkError" });
  postAnswers = [() => json(500, { error: "boom" })];
  assert.deepEqual(await submitMediaRequest(payload, "tok", t), { error: "boom" });

  const ctrl = new AbortController();
  postAnswers = [() => {
    ctrl.abort();
    throw new DOMException("aborted", "AbortError");
  }];
  await assert.rejects(submitMediaRequest(payload, "tok", t, ctrl.signal));
});

test("a spent quota (429 with no Retry-After) shows the route's own sentence, not the rate-limit wording", async () => {
  const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  postAnswers = [() => json(429, { error: "You have reached your request quota of 5 per week" })];
  assert.deepEqual(await submitMediaRequest({ tmdbId: 603, mediaType: "MOVIE" }, "tok", t), {
    error: "You have reached your request quota of 5 per week",
  });
});

test("the rate limiter's 429 (with Retry-After) still names the wait; a bodyless 429 falls back to the generic line", async () => {
  const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  postAnswers = [
    () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": "60" } }),
    () => new Response("<html>", { status: 429 }),
  ];
  assert.deepEqual(await submitMediaRequest({ tmdbId: 1, mediaType: "TV" }, "tok", t), { error: 'shared.rateLimited.seconds:{"seconds":60}' });
  assert.deepEqual(await submitMediaRequest({ tmdbId: 1, mediaType: "TV" }, "tok", t), { error: "shared.rateLimited.generic" });
});
