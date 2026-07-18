// Unit tests for triggerFullSync (src/lib/internal-trigger.ts) — the SOLE
// permitted direct `fetch` in the server codebase (guardrail 5b). The Plex SSE
// timeline handler uses it to drive a full orchestrator run through the public
// /api/sync route so the advisory lock, withCronRunRecording, isCronAuthorized,
// and the LIBRARY_SYNC audit path behave exactly as for an external cron.
// Contracts pinned here:
//   - the exact loopback wire shape: POST http://127.0.0.1:${PORT}/api/sync
//     with `Authorization: Bearer ${CRON_SECRET}` — drift in the port default,
//     the BASE_PATH prefix, or the auth header silently breaks SSE-driven syncs
//     (the route would 401/404 and the handler only warns);
//   - no CRON_SECRET ⇒ silent no-op: no request, no log (matches the
//     documented prior behaviour — an unset secret must not spam warnings on
//     every Plex timeline event);
//   - best-effort error contract: non-2xx responses and network/abort failures
//     are logged via console.warn with the [internal-trigger] scope and NEVER
//     thrown — a stuck orchestrator must not take down the timeline handler;
//   - the response body is ignored on success but surfaced (capped at 200
//     chars) on failure;
//   - the 30s AbortController timeout caps the wait on a hung orchestrator.
//
// The module reads all env at call time and has zero imports, so the tests
// stub globalThis.fetch, capture console.warn, and scope every env mutation
// (CRON_SECRET / PORT / BASE_PATH) to the test via save/restore. No network,
// DB, or DNS is ever touched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { triggerFullSync } from "../src/lib/internal-trigger.ts";

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: string; init: RequestInit };
const fetchCalls: FetchCall[] = [];
let respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = { url: String(input), init: init ?? {} };
  fetchCalls.push(call);
  return respond(call.url, call.init);
}) as typeof fetch;

// A minimal Response-shaped object: triggerFullSync touches only ok/status/
// text(). Using a hand-rolled object lets a test make text() throw (unreadable
// body) or make it blow up if the success path ever starts reading the body.
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    text: opts.text ?? (async () => ""),
  } as unknown as Response;
}

// ── env scoping ─────────────────────────────────────────────────────────────
const ENV_KEYS = ["CRON_SECRET", "PORT", "BASE_PATH"] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const v = values[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

const SECRET = "internal-trigger-test-cron-secret-0123456789";

beforeEach(() => {
  warns.length = 0;
  errors.length = 0;
  fetchCalls.length = 0;
  // Baseline: secret set, PORT/BASE_PATH unset (the default docker deployment).
  setEnv({ CRON_SECRET: SECRET });
  respond = () => {
    throw new Error("unexpected fetch — script a responder for this test");
  };
});

// ── the silent-skip gate ────────────────────────────────────────────────────

test("no CRON_SECRET ⇒ silent no-op: no request, no warning, resolves undefined", async () => {
  setEnv({});
  assert.equal(await triggerFullSync(), undefined);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(warns, []);
  assert.deepEqual(errors, []);
});

test("empty-string CRON_SECRET is falsy and also skips (never sends 'Bearer ')", async () => {
  setEnv({ CRON_SECRET: "" });
  await triggerFullSync();
  assert.equal(fetchCalls.length, 0);
});

// ── the exact wire shape ────────────────────────────────────────────────────

test("default wire shape: POST http://127.0.0.1:3000/api/sync with Bearer CRON_SECRET", async () => {
  respond = () =>
    fakeResponse({
      ok: true,
      status: 200,
      // The success path must never read the body — the handler's JSON
      // ({ skipped: true } when the lock is held) is deliberately ignored.
      text: async () => {
        throw new Error("body must not be read on success");
      },
    });
  await triggerFullSync();

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, "http://127.0.0.1:3000/api/sync"); // PORT defaults to 3000, no BASE_PATH
  assert.equal(call.init.method, "POST");
  assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${SECRET}`);
  assert.ok(call.init.signal instanceof AbortSignal, "the 30s timeout signal must ride the request");
  assert.equal(call.init.signal.aborted, false);
  assert.deepEqual(warns, []); // silent success (guardrail 7)
});

test("PORT env moves the loopback port", async () => {
  setEnv({ CRON_SECRET: SECRET, PORT: "4123" });
  respond = () => fakeResponse({ ok: true, status: 200 });
  await triggerFullSync();
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:4123/api/sync");
});

test("BASE_PATH prefixes the route (sub-path deployments would 404 on bare /api/sync)", async () => {
  setEnv({ CRON_SECRET: SECRET, BASE_PATH: "/summonarr" });
  respond = () => fakeResponse({ ok: true, status: 200 });
  await triggerFullSync();
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:3000/summonarr/api/sync");
});

// ── failure paths: warn, never throw ────────────────────────────────────────

test("non-2xx response warns with [internal-trigger] scope + status + body, and does not throw", async () => {
  respond = () => fakeResponse({ ok: false, status: 401, text: async () => '{"error":"Unauthorized"}' });
  await triggerFullSync(); // must resolve, not reject
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[internal-trigger\]/);
  assert.match(warns[0], /non-2xx 401/);
  assert.match(warns[0], /\{"error":"Unauthorized"\}/);
});

test("failure body is capped at 200 chars in the warning", async () => {
  respond = () => fakeResponse({ ok: false, status: 500, text: async () => "x".repeat(300) });
  await triggerFullSync();
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("x".repeat(200)), "first 200 chars of the body are surfaced");
  assert.ok(!warns[0].includes("x".repeat(201)), "anything past 200 chars is dropped");
});

test("unreadable failure body degrades to an empty snippet instead of throwing", async () => {
  respond = () =>
    fakeResponse({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error("stream already consumed");
      },
    });
  await triggerFullSync();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /non-2xx 502 from \/api\/sync: $/); // .catch(() => '') empty body
});

test("network failure (fetch rejects with an Error) warns and resolves", async () => {
  respond = () => {
    throw new Error("ECONNREFUSED 127.0.0.1:3000");
  };
  await triggerFullSync();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[internal-trigger\] full sync trigger failed: ECONNREFUSED/);
});

test("non-Error rejection values are stringified into the warning", async () => {
  respond = () => Promise.reject("weird-string-reason");
  await triggerFullSync();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /full sync trigger failed: weird-string-reason/);
});

// ── the 30s abort cap ───────────────────────────────────────────────────────

test("a hung orchestrator is aborted after exactly 30s and surfaces as a warn, not a hang/throw", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sawSignal: AbortSignal | undefined;
  respond = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      sawSignal = init.signal as AbortSignal;
      sawSignal.addEventListener("abort", () => reject(sawSignal!.reason));
    });

  const pending = triggerFullSync();
  assert.equal(fetchCalls.length, 1, "request must be in flight before the clock advances");

  // One tick short of the cap: still waiting, nothing aborted.
  t.mock.timers.tick(29_999);
  assert.equal(sawSignal?.aborted, false);

  t.mock.timers.tick(1); // 30_000ms total — the cap fires
  await pending; // resolves (never rejects) via the catch → warn path
  assert.equal(sawSignal?.aborted, true);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[internal-trigger\] full sync trigger failed: /);
});
