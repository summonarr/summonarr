// Unit tests for the client-side ratings batcher (src/lib/client/ratings-batcher.ts).
// Every ratings badge on a discovery grid funnels through requestRatings(), so the
// batcher is the only thing standing between "one POST per paint cycle" and a
// hundred-card page fanning out a hundred individual requests (the exact fan-out
// class guardrail 31 exists to prevent). Its contracts:
//   • 30ms debounce coalesces all same-window callers into ONE POST;
//   • duplicate `${type}:${id}` keys share a single queue entry and a single
//     resolution (many cards for the same title = one wire item);
//   • MAX_BATCH=200 caps the POST body, re-scheduling the remainder;
//   • every path — success, missing key, HTTP error, transport error, bad JSON —
//     RESOLVES the promise (null on failure). There is no timeout: a path that
//     neither resolves nor rejects would hang card renders forever.
// No network: fetch is replaced with a scripted mock and restored in a finally.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RatingsPayload } from "../src/lib/client/ratings-batcher.ts";

// base-path snapshots NEXT_PUBLIC_BASE_PATH at module load. Clear it BEFORE the
// batcher (which statically imports base-path) loads, so the URL pin below is
// exactly "/api/ratings/batch" regardless of the developer's shell env.
delete process.env.NEXT_PUBLIC_BASE_PATH;
const { requestRatings } = await import("../src/lib/client/ratings-batcher.ts");

// ---------------------------------------------------------------------------
// Scripted fetch mock (pattern: tests/chunked-upload.test.mts)
// ---------------------------------------------------------------------------

type FetchArgs = Parameters<typeof fetch>;

interface BatchItem {
  id: number;
  type: string;
  releaseDate: string | null;
}

interface RecordedCall {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  items: BatchItem[];
}

const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Answers a batch POST with a payload for every requested item, keyed the way
// the server keys its response map: `${type}:${id}`.
function echoResponder(call: RecordedCall): Response {
  return jsonResponse(200, {
    ratings: Object.fromEntries(
      call.items.map((i) => {
        const key = `${i.type}:${i.id}`;
        return [key, payloadFor(key)];
      }),
    ),
  });
}

// Installs a scripted fetch for the duration of `run` and ALWAYS restores the
// real fetch in a finally. Requests are recorded (URL, method, content type,
// parsed body items) at call time.
async function withFetch<T>(
  respond: (call: RecordedCall, index: number) => Response | Promise<Response>,
  run: (calls: RecordedCall[]) => Promise<T>,
): Promise<T> {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((...args: FetchArgs) => {
    const [input, init] = args;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const parsed = JSON.parse(String(init?.body)) as { items: BatchItem[] };
    const call: RecordedCall = {
      url: String(input),
      method: init?.method,
      contentType: headers["Content-Type"],
      items: parsed.items,
    };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length - 1));
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const EMPTY_PAYLOAD: RatingsPayload = {
  imdbId: null,
  imdbRating: null,
  imdbVotes: null,
  rottenTomatoes: null,
  rtAudienceScore: null,
  metacritic: null,
  traktRating: null,
  letterboxdRating: null,
  mdblistScore: null,
  malRating: null,
  rogerEbertRating: null,
};

function payloadFor(key: string): RatingsPayload {
  return { ...EMPTY_PAYLOAD, imdbId: key, imdbRating: "8.4" };
}

function ratingsFor(...keys: string[]): Record<string, RatingsPayload> {
  return Object.fromEntries(keys.map((k) => [k, payloadFor(k)]));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Wire shape + debounce
// ---------------------------------------------------------------------------

test("a single request fires one debounced POST to /api/ratings/batch with the exact wire shape", async () => {
  await withFetch(
    () => jsonResponse(200, { ratings: ratingsFor("movie:550") }),
    async (calls) => {
      const p = requestRatings(550, "movie", "1999-10-15");
      // Debounced: nothing goes out synchronously…
      assert.equal(calls.length, 0);
      // …or on the microtask queue (the 30ms timer is a macrotask, so this
      // check is deterministic — timers can never preempt microtasks).
      await Promise.resolve();
      assert.equal(calls.length, 0);

      const result = await p;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/ratings/batch");
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].contentType, "application/json");
      assert.deepEqual(calls[0].items, [{ id: 550, type: "movie", releaseDate: "1999-10-15" }]);
      assert.deepEqual(result, payloadFor("movie:550"));
    },
  );
});

test("requests spread across microtasks in one debounce window coalesce into a single POST", async () => {
  await withFetch(
    () => jsonResponse(200, { ratings: ratingsFor("movie:1", "tv:2") }),
    async (calls) => {
      const p1 = requestRatings(1, "movie", "2020-01-01");
      await Promise.resolve(); // a later microtask, still inside the same 30ms window
      const p2 = requestRatings(2, "tv"); // releaseDate omitted → defaults to null

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(calls.length, 1); // ONE batch for both callers
      assert.deepEqual(calls[0].items, [
        { id: 1, type: "movie", releaseDate: "2020-01-01" },
        { id: 2, type: "tv", releaseDate: null },
      ]);
      // Each caller is resolved via its own `${type}:${id}` key.
      assert.deepEqual(r1, payloadFor("movie:1"));
      assert.deepEqual(r2, payloadFor("tv:2"));
    },
  );
});

// ---------------------------------------------------------------------------
// Duplicate-key resolver sharing + response keying
// ---------------------------------------------------------------------------

test("duplicate keys share one queue entry: one body item, first releaseDate wins, identical resolution", async () => {
  await withFetch(
    () => jsonResponse(200, { ratings: ratingsFor("movie:42") }),
    async (calls) => {
      const pa = requestRatings(42, "movie", "2024-05-01");
      const pb = requestRatings(42, "movie", "1999-12-31"); // later releaseDate is ignored
      const pc = requestRatings(42, "movie");

      const [a, b, c] = await Promise.all([pa, pb, pc]);
      assert.equal(calls.length, 1);
      // Three callers, ONE wire item, carrying the FIRST caller's releaseDate.
      assert.deepEqual(calls[0].items, [{ id: 42, type: "movie", releaseDate: "2024-05-01" }]);
      // All resolvers fire with the SAME payload object (reference identity).
      assert.ok(a);
      assert.equal(b, a);
      assert.equal(c, a);
      assert.deepEqual(a, payloadFor("movie:42"));
    },
  );
});

test("the same id under different media types are distinct entries; a key absent from the response resolves null", async () => {
  await withFetch(
    () => jsonResponse(200, { ratings: ratingsFor("movie:7") }), // no "tv:7" in the response
    async (calls) => {
      const [movie, tv] = await Promise.all([requestRatings(7, "movie"), requestRatings(7, "tv")]);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0].items.map((i) => `${i.type}:${i.id}`),
        ["movie:7", "tv:7"], // two entries — "movie:7" does not swallow "tv:7"
      );
      assert.deepEqual(movie, payloadFor("movie:7"));
      assert.equal(tv, null); // missing key → null, not a hang and not the movie payload
    },
  );
});

// ---------------------------------------------------------------------------
// MAX_BATCH drain + remainder re-schedule
// ---------------------------------------------------------------------------

test("an oversize queue drains MAX_BATCH=200 first, then re-schedules the remainder in insertion order", async () => {
  await withFetch(echoResponder, async (calls) => {
    const promises = Array.from({ length: 250 }, (_, i) => requestRatings(i + 1, "movie"));
    const results = await Promise.all(promises);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[0].items.map((i) => i.id),
      Array.from({ length: 200 }, (_, i) => i + 1), // first 200 enqueued, in order
    );
    assert.deepEqual(
      calls[1].items.map((i) => i.id),
      Array.from({ length: 50 }, (_, i) => i + 201), // remainder, no new callers needed
    );
    for (const [i, r] of results.entries()) {
      assert.deepEqual(r, payloadFor(`movie:${i + 1}`));
    }
  });
});

test("exactly MAX_BATCH requests fit one POST with no follow-up flush", async () => {
  await withFetch(echoResponder, async (calls) => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => requestRatings(i + 1, "tv")),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].items.length, 200);
    assert.deepEqual(results[199], payloadFor("tv:200"));

    // Past another full debounce window: the boundary case must not have
    // re-scheduled an empty second batch.
    await sleep(45);
    assert.equal(calls.length, 1);
  });
});

test("a failed oversize first batch still re-schedules and resolves the remainder", async () => {
  await withFetch(
    (call, index) => (index === 0 ? jsonResponse(503, {}) : echoResponder(call)),
    async (calls) => {
      const promises = Array.from({ length: 201 }, (_, i) => requestRatings(i + 1, "movie"));
      const results = await Promise.all(promises);

      assert.equal(calls.length, 2);
      for (const r of results.slice(0, 200)) assert.equal(r, null); // batch 1 failed → null
      assert.deepEqual(results[200], payloadFor("movie:201")); // batch 2 unaffected
    },
  );
});

// ---------------------------------------------------------------------------
// Error paths: always resolve(null), never reject, never hang
// ---------------------------------------------------------------------------

const failureModes: Array<[string, () => Response | Promise<Response>]> = [
  ["a rejected fetch (network failure)", () => Promise.reject(new Error("network down"))],
  ["a non-2xx response", () => jsonResponse(500, { error: "upstream boom" })],
  [
    "an ok response whose JSON body fails to parse",
    () =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("unexpected token")),
      }) as unknown as Response,
  ],
];

for (const [name, respond] of failureModes) {
  test(`${name} resolves every waiter to null instead of rejecting`, async () => {
    await withFetch(respond, async (calls) => {
      // A rejection here would fail the test — awaiting IS the never-rejects pin.
      const [a, b] = await Promise.all([requestRatings(1, "movie"), requestRatings(2, "tv")]);
      assert.equal(calls.length, 1);
      assert.equal(a, null);
      assert.equal(b, null);
    });
  });
}

test("an ok response without a ratings map resolves null (the `?? {}` / `?? null` fallback chain)", async () => {
  await withFetch(
    () => jsonResponse(200, {}),
    async (calls) => {
      assert.equal(await requestRatings(9, "movie"), null);
      assert.equal(calls.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// Batches in flight
// ---------------------------------------------------------------------------

test("a request enqueued while a batch is in flight forms its own debounced batch", async () => {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  let markStarted: () => void = () => {};
  const firstStarted = new Promise<void>((r) => {
    markStarted = r;
  });

  await withFetch(
    async (call, index) => {
      if (index === 0) {
        markStarted();
        await firstGate; // hold batch 1's response open
      }
      return echoResponder(call);
    },
    async (calls) => {
      const pA = requestRatings(100, "movie");
      await firstStarted; // batch 1 POST is on the wire, unresolved
      const pB = requestRatings(200, "tv"); // queue was drained → fresh entry + fresh timer
      releaseFirst();

      const [a, b] = await Promise.all([pA, pB]);
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls[0].items.map((i) => i.id),
        [100],
      );
      assert.deepEqual(
        calls[1].items.map((i) => i.id),
        [200],
      );
      assert.deepEqual(a, payloadFor("movie:100"));
      assert.deepEqual(b, payloadFor("tv:200"));
    },
  );
});
