// MediaCard's view rules and request (src/components/media/media-card-state.ts).
//
//   - The HD Request overlay shows only when the viewer can request the type,
//     but View / Blocked and an in-flight confirm show regardless.
//   - "Available" is the viewer's own reading: a copy on a server they don't
//     see doesn't hide the Requested chip; only their OWN request (or the
//     card's) makes the bubble a "View".
//   - The request route's answers: created / already available / 409 / a 4xx
//     decision / a transient 5xx-429 / no answer, with the reason read as a
//     string only. A request carries the caller's abort, and a page token.
//
// fetch is scripted; no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let calls: { url: string; signal: AbortSignal | null; body: Record<string, unknown> | null }[] = [];
let answer: () => Response | Promise<Response> = () => new Response("{}");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), signal: init?.signal ?? null, body: init?.body ? JSON.parse(String(init.body)) : null });
  return answer();
}) as typeof fetch;

const { cardView, readCardRequestAnswer, requestStateAfterRefresh, submitCardRequest } = await import("../src/components/media/media-card-state.ts");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const base = { showPlex: true, showJellyfin: true, canRequest: true, state: "idle" as const };

beforeEach(() => {
  calls = [];
});

test("the request overlay: hidden without the request grant unless it's a View/Blocked bubble or a request in flight", () => {
  assert.equal(cardView({}, { ...base, canRequest: false }).showRequestOverlay, false);
  assert.equal(cardView({}, base).showRequestOverlay, true);
  for (const media of [{ plexAvailable: true }, { requestedByMe: true }, { blacklisted: true }]) {
    assert.equal(cardView(media, { ...base, canRequest: false }).showRequestOverlay, true, JSON.stringify(media));
  }
  for (const state of ["confirm", "loading", "error"] as const) {
    assert.equal(cardView({}, { ...base, canRequest: false, state }).showRequestOverlay, true, state);
  }
});

test("available means on a server THIS viewer sees, or found by the card's own request", () => {
  assert.equal(cardView({ plexAvailable: true }, { ...base, showPlex: false }).isAvailable, false);
  assert.equal(cardView({ plexAvailable: true }, base).isAvailable, true);
  assert.equal(cardView({}, { ...base, state: "available" }).isAvailable, true);
  // Hidden copy: the Requested chip still shows.
  assert.equal(cardView({ plexAvailable: true, requested: true }, { ...base, showPlex: false }).requestedChip, true);
  assert.equal(cardView({ plexAvailable: true, requested: true }, base).requestedChip, false);
});

test("someone else's request keeps the title requestable; the viewer's own makes it a View", () => {
  const other = cardView({ requested: true }, base);
  assert.equal(other.ghost, false);
  assert.equal(other.requestedChip, true);
  const mine = cardView({ requested: true, requestedByMe: true }, base);
  assert.equal(mine.ghost, true);
  assert.equal(cardView({}, { ...base, state: "requested" }).requestedChip, true);
});

test("Blocked shows beside someone's request but not beside the viewer's own", () => {
  assert.deepEqual(
    [cardView({ blacklisted: true, requested: true }, base).blockedChip, cardView({ blacklisted: true, requested: true }, base).requestedChip],
    [true, true],
  );
  assert.equal(cardView({ blacklisted: true, requestedByMe: true }, base).blockedChip, false);
  assert.equal(cardView({ blacklisted: true, plexAvailable: true }, base).blockedChip, false);
});

test("the route's answers", () => {
  assert.deepEqual(readCardRequestAnswer(201, { id: "r" }), { kind: "requested" });
  assert.deepEqual(readCardRequestAnswer(200, { alreadyAvailable: true }), { kind: "available" });
  assert.deepEqual(readCardRequestAnswer(200, null), { kind: "requested" });
  assert.deepEqual(readCardRequestAnswer(201, { alreadyAvailable: "yes" }), { kind: "requested" }, "only a real boolean counts");
  assert.deepEqual(readCardRequestAnswer(409, { error: "dup" }), { kind: "requested" });
  assert.deepEqual(readCardRequestAnswer(403, { error: "Quota reached" }), { kind: "refused", transient: false, message: "Quota reached" });
  assert.deepEqual(readCardRequestAnswer(429, { error: "Slow down" }), { kind: "refused", transient: true, message: "Slow down" });
  assert.deepEqual(readCardRequestAnswer(502, null), { kind: "refused", transient: true, message: null });
  assert.deepEqual(readCardRequestAnswer(400, { error: { nested: 1 } }), { kind: "refused", transient: false, message: null }, "a non-string reason is never rendered");
});

test("the request posts with the page token and carries the caller's abort", async () => {
  answer = () => json(201, { id: "r" });
  const ctrl = new AbortController();
  assert.deepEqual(await submitCardRequest({ id: 603, mediaType: "movie" }, "tok", ctrl.signal), { kind: "requested" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/requests");
  assert.deepEqual(calls[0].body, { tmdbId: 603, mediaType: "MOVIE", _token: "tok" });
  assert.ok(calls[0].signal, "the POST is abortable");

  // While the request is in flight, the caller's abort reaches it.
  let release: (r: Response) => void = () => {};
  answer = () => new Promise<Response>((resolve) => { release = resolve; });
  const live = new AbortController();
  const pending = submitCardRequest({ id: 603, mediaType: "movie" }, "tok", live.signal);
  const sent = calls[calls.length - 1].signal;
  assert.equal(sent?.aborted, false);
  live.abort();
  assert.equal(sent?.aborted, true, "the caller's abort reaches the request");
  release(json(201, { id: "r" }));
  await pending;
});

test("no answer is its own outcome", async () => {
  answer = () => { throw new TypeError("offline"); };
  assert.deepEqual(await submitCardRequest({ id: 1399, mediaType: "tv" }, "tok", new AbortController().signal), { kind: "no-answer" });
  assert.equal(calls[0].body?.mediaType, "TV");
});

test("a fresh server render without the viewer's request clears the card's own Requested", () => {
  // Declined or deleted since: the card offers Request again.
  assert.equal(requestStateAfterRefresh("requested", false), "idle");
  // The server still reports the request: nothing changes.
  assert.equal(requestStateAfterRefresh("requested", true), "requested");
  // Every other state is left alone, an in-flight request included.
  for (const state of ["idle", "confirm", "loading", "available", "error"] as const) {
    assert.equal(requestStateAfterRefresh(state, false), state);
  }
});
