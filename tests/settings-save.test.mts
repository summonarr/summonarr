// The settings forms' one save path (src/components/settings/forms/shared.ts):
// what counts as "Saved", and what an edit made while a save is in flight does.
// The hook itself needs React; its state machine (createSettingsSaver) and the
// PATCH helper are plain functions, driven here directly. Which forms use them
// is pinned in tests/settings-forms-wiring.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSettingsSaver,
  patchSettings,
  settingsPatchSucceeded,
  type SaveStatus,
  type SettingsPatchResult,
} from "../src/components/settings/forms/shared.ts";

// ── patchSettings ────────────────────────────────────────────────────────────

async function withFetch<T>(answer: () => Promise<Response>, run: () => Promise<T>): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a save is a JSON PATCH of the body to /api/settings", async () => {
  const { result, calls } = await withFetch(async () => json({ ok: true }), () => patchSettings({ siteTitle: "Home" }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/settings");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
  assert.equal(calls[0].init.body, JSON.stringify({ siteTitle: "Home" }));
});

test("only a 2xx that says ok: true is saved — a proxy's 200 page is not", async () => {
  // The route sends `ok` with every answer, so anything else never reached it.
  for (const answer of [
    () => new Response("<html>Sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    () => new Response(null, { status: 200 }),
    () => json({}),
    () => json({ ok: "true" }),
    () => json([{ ok: true }]),
  ]) {
    const { result } = await withFetch(async () => answer(), () => patchSettings({ siteTitle: "Home" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.equal(result.error, "");
  }
  assert.equal(settingsPatchSucceeded({ ok: true }, { ok: true }), true);
  assert.equal(settingsPatchSucceeded({ ok: false }, { ok: true }), false, "an error status never saves");
  assert.equal(settingsPatchSucceeded({ ok: true }, null), false);
});

test("a refusal carries the route's reason and status", async () => {
  const { result } = await withFetch(async () => json({ error: "Wait 9s before changing siteTitle again" }, 429), () => patchSettings({ siteTitle: "x" }));
  assert.deepEqual(result, { ok: false, status: 429, data: { error: "Wait 9s before changing siteTitle again" }, error: "Wait 9s before changing siteTitle again" });
  const failedTest = await withFetch(async () => json({ ok: false, plexError: "Unreachable" }, 422), () => patchSettings({ plexUrl: "x" }));
  assert.equal(failedTest.result.ok, false);
  assert.equal(failedTest.result.data.plexError, "Unreachable", "the whole body is handed back for the forms that read their own fields");
});

test("no answer is a failure with status 0, never a throw", async () => {
  const { result } = await withFetch(async () => { throw new TypeError("Failed to fetch"); }, () => patchSettings({ siteTitle: "x" }));
  assert.deepEqual(result, { ok: false, status: 0, data: {}, error: "" });
});

// ── createSettingsSaver ──────────────────────────────────────────────────────

const OK: SettingsPatchResult = { ok: true, status: 200, data: { ok: true }, error: "" };
const REFUSED: SettingsPatchResult = { ok: false, status: 400, data: { error: "Too long" }, error: "Too long" };

function harness(resetMs?: number) {
  let status: SaveStatus = "idle";
  let message = "";
  const sent: Array<Record<string, unknown>> = [];
  const pending: Array<(r: SettingsPatchResult) => void> = [];
  const saver = createSettingsSaver({
    setStatus: (u) => { status = typeof u === "function" ? u(status) : u; },
    setMessage: (m) => { message = m; },
    resetMs,
    patch: (body) => {
      sent.push(body);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  return {
    saver,
    sent,
    get status() { return status; },
    get message() { return message; },
    answer: (r: SettingsPatchResult) => pending.shift()!(r),
  };
}

test("a save shows saving, then Saved, and Saved fades after the reset delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const done = h.saver.save({ siteTitle: "Home" });
  assert.equal(h.status, "saving");
  assert.deepEqual(h.sent, [{ siteTitle: "Home" }]);
  h.answer(OK);
  assert.deepEqual(await done, OK);
  assert.equal(h.status, "ok");
  t.mock.timers.tick(2999);
  assert.equal(h.status, "ok");
  t.mock.timers.tick(1);
  assert.equal(h.status, "idle");
});

test("a form's own reset delay is honoured", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(4000);
  const done = h.saver.save({ auditPiiRetentionDays: "90" });
  h.answer(OK);
  await done;
  t.mock.timers.tick(3000);
  assert.equal(h.status, "ok");
  t.mock.timers.tick(1000);
  assert.equal(h.status, "idle");
});

test("an edit while the save is in flight keeps Save locked, and the answer doesn't call the unsent edit saved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const done = h.saver.save({ siteTitle: "Hom" });
  h.saver.edited();
  assert.equal(h.status, "saving", "the edit doesn't unlock Save mid-request");
  h.answer(OK);
  await done;
  assert.equal(h.status, "idle", "the form holds an edit the request never carried");
});

test("an edit after the answer clears Saved; the next save is judged on its own", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  let done = h.saver.save({ siteTitle: "Hom" });
  h.answer(OK);
  await done;
  h.saver.edited();
  assert.equal(h.status, "idle");
  done = h.saver.save({ siteTitle: "Home" });
  h.answer(OK);
  await done;
  assert.equal(h.status, "ok", "an edit before the click is in the request");
});

test("a refusal shows the route's reason and stays until the next edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const done = h.saver.save({ siteTitle: "x".repeat(500) });
  h.answer(REFUSED);
  await done;
  assert.equal(h.status, "error");
  assert.equal(h.message, "Too long");
  t.mock.timers.tick(60_000);
  assert.equal(h.status, "error", "only Saved fades");
  h.saver.edited();
  assert.equal(h.status, "idle");
});

test("a new save clears the last reason, and a refusal after an in-flight edit still reports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  let done = h.saver.save({ a: 1 });
  h.answer(REFUSED);
  await done;
  done = h.saver.save({ a: 2 });
  assert.equal(h.message, "", "the old reason goes when the next save starts");
  h.saver.edited();
  h.answer({ ok: false, status: 0, data: {}, error: "" });
  await done;
  assert.equal(h.status, "error");
  assert.equal(h.message, "", "no reason: the form shows its own fallback");
});

test("a failure with no reason from the route can be worded by the form", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const wording = (r: SettingsPatchResult) => (r.status === 0 ? "No connection" : `HTTP ${r.status}`);
  let done = h.saver.save({ a: 1 }, wording);
  h.answer({ ok: false, status: 502, data: {}, error: "" });
  await done;
  assert.equal(h.message, "HTTP 502");
  done = h.saver.save({ a: 1 }, wording);
  h.answer({ ok: false, status: 0, data: {}, error: "" });
  await done;
  assert.equal(h.message, "No connection");
  done = h.saver.save({ a: 1 }, wording);
  h.answer(REFUSED);
  await done;
  assert.equal(h.message, "Too long", "the route's own reason wins");
});

test("an earlier save's fade never hides a later save's result early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  let done = h.saver.save({ a: 1 });
  h.answer(OK);
  await done;
  t.mock.timers.tick(2000);
  done = h.saver.save({ a: 2 });
  h.answer(OK);
  await done;
  // The first save's fade was due 1s from now; only the second's (3s) may clear it.
  t.mock.timers.tick(1500);
  assert.equal(h.status, "ok", "the first save's timer was cancelled");
  t.mock.timers.tick(1500);
  assert.equal(h.status, "idle");
});

test("cancel drops the pending fade", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const done = h.saver.save({ a: 1 });
  h.answer(OK);
  await done;
  h.saver.cancel();
  t.mock.timers.tick(10_000);
  assert.equal(h.status, "ok");
});
