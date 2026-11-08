// The browser's one JSON fetch (src/lib/client/fetch-json.ts): how every kind
// of answer is read — ok, "http", "invalid", "network" (guardrail 37a's
// no-answer rule), "timeout", "aborted" — that it never throws, and that its
// timer and abort listener never outlive the call. globalThis.fetch and the
// timer functions are stubbed; nothing touches the network or a real clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchJson, jsonInit, type FetchJsonResult } from "../src/lib/client/fetch-json.ts";
import { v } from "../src/lib/validate.ts";

type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

interface Timers {
  pending(): number;
  /** Fires every pending timer. */
  fire(): void;
  delays: number[];
}

async function withStubs<T>(fetchStub: FetchStub, run: (timers: Timers) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 1;
  globalThis.fetch = ((url: string, init: RequestInit) => fetchStub(url, init)) as typeof fetch;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = nextId++;
    timers.set(id, fn);
    delays.push(ms);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;
  try {
    return await run({
      pending: () => timers.size,
      fire: () => {
        const fns = [...timers.values()];
        timers.clear();
        for (const fn of fns) fn();
      },
      delays,
    });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (status: number) => new Response("<html><body>Bad Gateway</body></html>", { status, headers: { "Content-Type": "text/html" } });

/** A fetch that never answers on its own but rejects the way a real one does when its signal aborts. */
const hangingFetch: FetchStub = (_url, init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
/** A fetch that ignores its signal entirely and never settles. */
const deafFetch: FetchStub = () => new Promise(() => {});

const failure = <T,>(r: FetchJsonResult<T>) => {
  if (r.ok) assert.fail("expected a failure");
  return r;
};

// ── answers ──────────────────────────────────────────────────────────────────

test("a 2xx JSON body that passes the schema is ok, typed and stripped to the schema", async () => {
  const r = await withStubs(async () => json({ id: 1, title: "Dune", secret: "x" }), () =>
    fetchJson("/api/x", { schema: v.object({ id: v.int(), title: v.string() }) }));
  assert.ok(r.ok);
  const title: string = r.data.title;
  assert.equal(title, "Dune");
  assert.deepEqual(r.data, { id: 1, title: "Dune" });
  assert.equal(r.status, 200);
});

test("with no schema a 2xx JSON body comes back as unknown, and an empty body as null", async () => {
  const r = await withStubs(async () => json([1, 2]), () => fetchJson("/api/x"));
  assert.deepEqual(r, { ok: true, status: 200, data: [1, 2] });
  const empty = await withStubs(async () => new Response(null, { status: 204 }), () => fetchJson("/api/x"));
  assert.deepEqual(empty, { ok: true, status: 204, data: null });
  const blank = await withStubs(async () => new Response("  \n", { status: 200 }), () => fetchJson("/api/x"));
  assert.deepEqual(blank, { ok: true, status: 200, data: null });
});

test("an empty 2xx body must still pass the schema", async () => {
  const r = failure(await withStubs(async () => new Response(null, { status: 204 }), () =>
    fetchJson("/api/x", { schema: v.object({ ok: v.boolean() }), fallbackError: "Failed" })));
  assert.equal(r.kind, "invalid");
  assert.equal(r.detail, "expected object, got null");
  const nullable = await withStubs(async () => new Response(null, { status: 204 }), () =>
    fetchJson("/api/x", { schema: v.nullable(v.object({ ok: v.boolean() })) }));
  assert.deepEqual(nullable, { ok: true, status: 204, data: null });
});

test("a 2xx whose body fails the schema is invalid: the path in detail, the fallback in error", async () => {
  const r = failure(await withStubs(async () => json({ items: [{ id: 1 }, { id: "2" }] }), () =>
    fetchJson("/api/x", { schema: v.object({ items: v.array(v.object({ id: v.int() })) }), fallbackError: "Couldn't load" })));
  assert.equal(r.kind, "invalid");
  assert.equal(r.status, 200);
  assert.equal(r.error, "Couldn't load");
  assert.equal(r.detail, "items[1].id: expected integer, got string");
  assert.deepEqual(r.body, { items: [{ id: 1 }, { id: "2" }] });
});

test("a 2xx that is not JSON is invalid even with no schema — a proxy's sign-in page is not an answer", async () => {
  const r = failure(await withStubs(async () => new Response("<html>Sign in</html>", { status: 200 }), () =>
    fetchJson("/api/x", { fallbackError: "Failed" })));
  assert.equal(r.kind, "invalid");
  assert.equal(r.status, 200);
  assert.equal(r.error, "Failed");
  assert.equal(r.body, null);
});

test("a JSON non-2xx is http, with the route's message first, then its error, then the fallback", async () => {
  const both = failure(await withStubs(async () => json({ error: "permanent-batch-too-large", message: "Too many requesters" }, 409), () =>
    fetchJson("/api/x", { fallbackError: "Failed" })));
  assert.equal(both.kind, "http");
  assert.equal(both.status, 409);
  assert.equal(both.error, "Too many requesters");
  assert.deepEqual(both.body, { error: "permanent-batch-too-large", message: "Too many requesters" });

  const onlyError = failure(await withStubs(async () => json({ error: "Not found" }, 404), () => fetchJson("/api/x", { fallbackError: "Failed" })));
  assert.equal(onlyError.error, "Not found");

  const neither = failure(await withStubs(async () => json({ secondFactorRequired: true, methods: ["totp"] }, 400), () =>
    fetchJson("/api/x", { fallbackError: "Failed" })));
  assert.equal(neither.error, "Failed");
  assert.deepEqual(neither.body, { secondFactorRequired: true, methods: ["totp"] }, "the body is there for routes that send more");

  const json500 = failure(await withStubs(async () => json({ error: "Radarr refused" }, 500), () => fetchJson("/api/x")));
  assert.equal(json500.kind, "http", "a JSON 5xx is the route's own answer");
  assert.equal(json500.status, 500);
  assert.equal(json500.error, "Radarr refused");
});

test("a non-JSON 4xx is http with the fallback", async () => {
  const r = failure(await withStubs(async () => html(413), () => fetchJson("/api/x", { fallbackError: "Too big" })));
  assert.equal(r.kind, "http");
  assert.equal(r.status, 413);
  assert.equal(r.error, "Too big");
  assert.equal(r.body, null);
});

test("a 5xx that is not JSON is network with status 0: a proxy's error page is no answer (guardrail 37a)", async () => {
  for (const status of [500, 502, 504, 522]) {
    const r = failure(await withStubs(async () => html(status), () => fetchJson("/api/x", { fallbackError: "Offline" })));
    assert.equal(r.kind, "network", `HTTP ${status}`);
    assert.equal(r.status, 0);
    assert.equal(r.error, "Offline");
    assert.equal(r.body, null);
  }
});

test("a fetch that throws, or a body that breaks off, is network — never a throw", async () => {
  const thrown = failure(await withStubs(async () => { throw new TypeError("Failed to fetch"); }, () =>
    fetchJson("/api/x", { fallbackError: "Offline" })));
  assert.deepEqual(thrown, { ok: false, kind: "network", status: 0, error: "Offline", body: null, detail: "Failed to fetch" });

  const syncThrow = failure(await withStubs(() => { throw new TypeError("bad init"); }, () => fetchJson("/api/x")));
  assert.equal(syncThrow.kind, "network");
  assert.equal(syncThrow.error, "", "no fallback, no text");

  const brokenBody = new Response(new ReadableStream({ start(c) { c.error(new Error("connection reset")); } }), { status: 200 });
  const broken = failure(await withStubs(async () => brokenBody, () => fetchJson("/api/x")));
  assert.equal(broken.kind, "network");
  assert.equal(broken.status, 0);
});

// ── abort and timeout ────────────────────────────────────────────────────────

test("a signal that already fired is aborted with no request made", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const r = failure(await withStubs(async () => { calls++; return json({}); }, () =>
    fetchJson("/api/x", { signal: controller.signal, fallbackError: "Failed" })));
  assert.equal(calls, 0);
  assert.equal(r.kind, "aborted");
  assert.equal(r.status, 0);
  assert.equal(r.error, "", "an abort is not an error to show");
});

test("the caller's abort ends the request as aborted, even when fetch ignores its signal", async () => {
  for (const stub of [hangingFetch, deafFetch]) {
    const controller = new AbortController();
    const r = await withStubs(stub, async (timers) => {
      const pending = fetchJson("/api/x", { signal: controller.signal, fallbackError: "Failed" });
      controller.abort();
      const result = await pending;
      assert.equal(timers.pending(), 0, "the timeout is cleared");
      return result;
    });
    const f = failure(r);
    assert.equal(f.kind, "aborted");
    assert.equal(f.error, "");
  }
});

test("fetch receives our own signal, which the caller's abort and the timeout both fire", async () => {
  for (const end of ["timeout", "aborted"] as const) {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    await withStubs((url, init) => { seen = init.signal ?? undefined; return hangingFetch(url, init); }, async (timers) => {
      const pending = fetchJson("/api/x", { signal: controller.signal });
      assert.ok(seen && seen !== controller.signal);
      assert.equal(seen.aborted, false);
      if (end === "timeout") timers.fire();
      else controller.abort();
      assert.equal(failure(await pending).kind, end);
      assert.equal(seen.aborted, true);
    });
  }
});

test("no answer within timeoutMs is timeout — 30 seconds unless the caller says otherwise", async () => {
  for (const stub of [hangingFetch, deafFetch]) {
    const r = await withStubs(stub, async (timers) => {
      const pending = fetchJson("/api/x", { fallbackError: "Timed out" });
      assert.deepEqual(timers.delays, [DEFAULT_FETCH_TIMEOUT_MS]);
      timers.fire();
      return pending;
    });
    const f = failure(r);
    assert.equal(f.kind, "timeout");
    assert.equal(f.status, 0);
    assert.equal(f.error, "Timed out");
  }
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 30_000);
  await withStubs(hangingFetch, async (timers) => {
    const pending = fetchJson("/api/x", { timeoutMs: 120_000 });
    assert.deepEqual(timers.delays, [120_000]);
    timers.fire();
    assert.equal(failure(await pending).kind, "timeout");
  });
});

test("the timeout and the caller's abort also bound a body that never finishes", async () => {
  for (const end of ["timeout", "aborted"] as const) {
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    // Headers arrive; the body's first chunk never does.
    const stalled = () => new Response(new ReadableStream({ pull: () => { bodyRead(); return new Promise<void>(() => {}); } }), { status: 200 });
    const controller = new AbortController();
    const r = await withStubs(async () => stalled(), async (timers) => {
      const pending = fetchJson("/api/x", { signal: controller.signal });
      await reading;
      if (end === "timeout") timers.fire();
      else controller.abort();
      return pending;
    });
    assert.equal(failure(r).kind, end);
  }
});

test("a timeout of Infinity or 0 arms no timer; a huge one is clamped to what setTimeout can hold", async () => {
  for (const timeoutMs of [Number.POSITIVE_INFINITY, 0]) {
    await withStubs(async () => json({}), async (timers) => {
      await fetchJson("/api/x", { timeoutMs });
      assert.deepEqual(timers.delays, []);
    });
  }
  await withStubs(async () => json({}), async (timers) => {
    await fetchJson("/api/x", { timeoutMs: 1e12 });
    assert.deepEqual(timers.delays, [2_147_483_647]);
  });
});

test("whatever the outcome, the timer is cleared and the caller's abort listener removed", async () => {
  const answers: Array<() => Promise<Response>> = [
    async () => json({ a: 1 }),
    async () => json({ error: "x" }, 400),
    async () => html(502),
    async () => { throw new TypeError("offline"); },
  ];
  for (const answer of answers) {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => { added++; add(...args); }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed++; remove(...args); }) as typeof signal.removeEventListener;
    await withStubs(answer, async (timers) => {
      await fetchJson("/api/x", { signal });
      assert.equal(timers.pending(), 0);
    });
    assert.equal(added, 1);
    assert.equal(removed, 1);
  }
});

// ── the request ──────────────────────────────────────────────────────────────

test("the URL and init go to fetch as given; jsonInit builds a JSON request", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await withStubs(async (url, init) => { calls.push({ url, init }); return json({}); }, () =>
    fetchJson("/base/api/requests/r1", { init: jsonInit("PATCH", { status: "APPROVED" }) }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/base/api/requests/r1");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
  assert.equal(calls[0].init.body, JSON.stringify({ status: "APPROVED" }));
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});
