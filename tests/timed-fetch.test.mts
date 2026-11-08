// timedFetch (src/lib/client/fetch-json.ts) bounds the body read as well as the
// wait for headers, and never leaves its timer or listener behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { timedFetch } from "../src/lib/client/fetch-json.ts";

async function withTimers<T>(fetchStub: (url: string, init: RequestInit) => Promise<Response>, run: (t: { pending(): number; fire(): void }) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let next = 1;
  globalThis.fetch = ((u: string, i: RequestInit) => fetchStub(u, i)) as typeof fetch;
  globalThis.setTimeout = ((fn: () => void) => {
    const id = next++;
    timers.set(id, fn);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;
  try {
    return await run({ pending: () => timers.size, fire: () => [...timers.values()].forEach((f) => f()) });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

function stalledBody(signal: AbortSignal, first: string): Response {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(enc.encode(first));
        return undefined;
      }
      return new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  return new Response(body, { status: 200 });
}

test("a body that stalls after the headers is aborted by the timeout", async () => {
  await withTimers(
    async (_u, init) => stalledBody(init.signal as AbortSignal, "{"),
    async (t) => {
      const res = await timedFetch("/x", {}, 1000);
      assert.equal(t.pending(), 1, "the timer is still running while the body is unread");
      const reading = res.text();
      reading.catch(() => {});
      t.fire();
      await assert.rejects(reading);
      assert.equal(t.pending(), 0);
    },
  );
});

test("reading the body to its end stops the timer and keeps status and headers", async () => {
  await withTimers(
    async () => new Response('{"a":1}', { status: 201, headers: { "x-k": "v" } }),
    async (t) => {
      const res = await timedFetch("/x", {}, 1000);
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("x-k"), "v");
      assert.deepEqual(await res.json(), { a: 1 });
      assert.equal(t.pending(), 0);
    },
  );
});

test("a response without a body and a failed fetch both release the timer", async () => {
  await withTimers(
    async () => new Response(null, { status: 204 }),
    async (t) => {
      const res = await timedFetch("/x", {}, 1000);
      assert.equal(res.status, 204);
      assert.equal(t.pending(), 0);
    },
  );
  await withTimers(
    async () => {
      throw new TypeError("down");
    },
    async (t) => {
      await assert.rejects(timedFetch("/x", {}, 1000));
      assert.equal(t.pending(), 0);
    },
  );
});
