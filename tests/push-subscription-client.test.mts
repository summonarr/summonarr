// The push bell's requests (src/lib/client/push-subscription.ts), with a
// scripted fetch and a fake service worker — no browser, no network.
//
//   - The once-per-page-load resync is flagged `resync: true` (guardrail 6g);
//     only a 410 (removed on purpose) or a 409 (the endpoint belongs to
//     another account) drops this browser's own subscription, and it never
//     repeats.
//   - The VAPID key is checked: an empty or missing key is reported as the
//     server's problem, a refusal carries the server's own reason, and a
//     network failure is not mistaken for either.
//   - A failed enable rolls back ONLY the subscription it created: a failure
//     before the browser subscribed never deletes a subscription that was
//     already there (server row or browser).
//   - The test-send outcome and the disable keep their semantics: a 404 on
//     DELETE means the server had already forgotten the browser.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let answers: Array<(call: Call) => Response | Promise<Response>> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call: Call = {
    url: String(input),
    method: init?.method ?? "GET",
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  };
  calls.push(call);
  const next = answers.shift();
  assert.ok(next, `unexpected fetch ${call.method} ${call.url}`);
  return next(call);
}) as typeof fetch;

// The window event the bells listen for.
const win = new EventTarget();
let changes = 0;
win.addEventListener("summonarr:push-changed", () => { changes++; });
(globalThis as { window?: unknown }).window = win;

const lib = await import("../src/lib/client/push-subscription.ts");

function fakeSub(endpoint: string) {
  let unsubscribed = 0;
  const sub = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => { unsubscribed++; return true; },
    get unsubscribed() { return unsubscribed; },
  };
  return sub;
}

function fakeReg(subscribeImpl: () => Promise<unknown>, existing: unknown = null) {
  return { pushManager: { subscribe: subscribeImpl, getSubscription: async () => existing } } as unknown as ServiceWorkerRegistration;
}

beforeEach(() => {
  calls = [];
  answers = [];
  changes = 0;
  lib.resetResyncForTests();
});

test("the resync is one flagged POST per page load; a 410 drops this browser's subscription and tells the other bells", async () => {
  const sub = fakeSub("https://push.example/1");
  answers = [() => json(410, { error: "removed" })];
  await lib.resyncSubscription(sub as unknown as PushSubscription);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/push/subscribe");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" }, resync: true });
  assert.equal(sub.unsubscribed, 1);
  assert.equal(changes, 1);
  await lib.resyncSubscription(sub as unknown as PushSubscription);
  assert.equal(calls.length, 1, "once per page load");
});

test("a resync refused because the endpoint belongs to another account drops this browser's subscription", async () => {
  const sub = fakeSub("https://push.example/shared");
  answers = [() => json(409, { error: "taken" })];
  await lib.resyncSubscription(sub as unknown as PushSubscription);
  assert.equal(sub.unsubscribed, 1, "the bell must not show on for an account the server sends nothing to");
  assert.equal(changes, 1, "the other bells re-read the browser");
});

test("any other resync answer leaves the browser's subscription alone", async () => {
  for (const answer of [() => json(200, { ok: true }), () => json(403, { error: "off" }), () => new Response("<html>", { status: 502 })]) {
    lib.resetResyncForTests();
    const sub = fakeSub("https://push.example/2");
    answers = [answer];
    await lib.resyncSubscription(sub as unknown as PushSubscription);
    assert.equal(sub.unsubscribed, 0);
  }
  assert.equal(changes, 0);
});

test("the VAPID key: a usable key, a refusal with the server's reason, and an empty key", async () => {
  answers = [() => json(200, { publicKey: "BKey" })];
  assert.equal(await lib.fetchVapidKey("fallback"), "BKey");

  answers = [() => json(503, { error: "Web push is not configured" })];
  await assert.rejects(lib.fetchVapidKey("fallback"), (err: unknown) => err instanceof lib.ServerReasonError && err.message === "Web push is not configured");

  for (const body of [{ publicKey: "" }, { publicKey: "   " }, {}, { publicKey: 42 }]) {
    answers = [() => json(200, body)];
    await assert.rejects(lib.fetchVapidKey("fallback"), (err: unknown) => err instanceof lib.ServerReasonError && err.message === "fallback", JSON.stringify(body));
  }

  answers = [() => { throw new TypeError("offline"); }];
  await assert.rejects(lib.fetchVapidKey("fallback"), (err: unknown) => err instanceof Error && !(err instanceof lib.ServerReasonError));
});

test("a failure before the browser subscribed touches no existing subscription", async () => {
  // The key fetch is refused while this browser already holds a working
  // subscription: no DELETE, nothing unsubscribed.
  const existing = fakeSub("https://push.example/working");
  // Where the old catch-all rollback looked it up.
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: { getRegistration: async () => fakeReg(async () => existing, existing) },
    configurable: true,
  });
  const out = await lib.enablePush(Promise.reject(new lib.ServerReasonError("not configured")), "Laptop");
  assert.deepEqual(out, { kind: "failed", reason: "not configured" });
  assert.equal(existing.unsubscribed, 0);
  assert.equal(calls.length, 0, "no forget DELETE for a subscription this call never made");
});

test("a browser that refuses the prompt rolls back nothing", async () => {
  const reg = fakeReg(async () => { throw new DOMException("denied", "NotAllowedError"); });
  const out = await lib.enablePush(Promise.resolve({ publicKey: "k", reg }), "");
  assert.deepEqual(out, { kind: "failed", reason: null });
  assert.equal(calls.length, 0);
});

test("a lost POST answer rolls back the subscription it created, server row first", async () => {
  const created = fakeSub("https://push.example/new");
  const reg = fakeReg(async () => created);
  answers = [() => { throw new TypeError("connection reset"); }, () => json(200, { ok: true })];
  const out = await lib.enablePush(Promise.resolve({ publicKey: "k", reg }), "  Work Mac  ");
  assert.deepEqual(out, { kind: "failed", reason: null });
  assert.deepEqual(calls.map((c) => c.method), ["POST", "DELETE"]);
  assert.equal(calls[0].body?.label, "Work Mac");
  assert.deepEqual(calls[1].body, { endpoint: "https://push.example/new" });
  assert.equal(created.unsubscribed, 1);
});

test("a refusal undoes the browser subscription and reports the route's reason", async () => {
  const created = fakeSub("https://push.example/new");
  const reg = fakeReg(async () => created);
  answers = [() => json(403, { error: "Push notifications are disabled" })];
  const out = await lib.enablePush(Promise.resolve({ publicKey: "k", reg }), "");
  assert.deepEqual(out, { kind: "refused", status: 403, error: "Push notifications are disabled" });
  assert.equal(calls.length, 1, "no forget DELETE: the server refused, it stored nothing");
  assert.equal(calls[0].body?.label, undefined, "a blank label is left out");
  assert.equal(created.unsubscribed, 1);
});

test("a stored subscription is enabled", async () => {
  const created = fakeSub("https://push.example/new");
  answers = [() => json(200, { ok: true })];
  const out = await lib.enablePush(Promise.resolve({ publicKey: "k", reg: fakeReg(async () => created) }), "Phone");
  assert.deepEqual(out, { kind: "subscribed" });
  assert.equal(created.unsubscribed, 0);
});

test("disable: the server row goes first; a 404 counts as gone, any other failure keeps the subscription", async () => {
  const setReady = (reg: ServiceWorkerRegistration) =>
    Object.defineProperty(globalThis.navigator, "serviceWorker", { value: { ready: Promise.resolve(reg) }, configurable: true });

  for (const [answer, expected] of [
    [() => json(200, { ok: true }), true],
    [() => json(404, { error: "gone" }), true],
    [() => json(500, { error: "db" }), false],
    [() => { throw new TypeError("offline"); }, false],
  ] as const) {
    const sub = fakeSub("https://push.example/x");
    setReady(fakeReg(async () => sub, sub));
    answers = [answer];
    assert.equal(await lib.disablePush(), expected);
    assert.equal(sub.unsubscribed, expected ? 1 : 0);
  }
});

test("the test send: true only when every device's send went out", async () => {
  answers = [() => json(200, { results: [{ platform: "web", endpoint: "e", ok: true }] })];
  assert.equal(await lib.sendTestPush(), true);
  const quiet = console.error;
  console.error = () => {};
  try {
    answers = [() => json(502, { results: [{ platform: "web", endpoint: "e", ok: false, status: 410 }] })];
    assert.equal(await lib.sendTestPush(), false);
    answers = [() => json(200, { results: [{ ok: true }, { ok: false, message: "x" }] })];
    assert.equal(await lib.sendTestPush(), false);
    answers = [() => new Response("<html>bad gateway</html>", { status: 502 })];
    assert.equal(await lib.sendTestPush(), false);
    answers = [() => json(200, { results: [{ ok: "yes" }] })];
    assert.equal(await lib.sendTestPush(), false, "a malformed answer is not a success");
  } finally {
    console.error = quiet;
  }
});
