// The admin Radarr/Sonarr pages' calls (src/lib/client/arr-call.ts) and what
// they accept back (src/lib/client/arr-answers.ts), plus the URL rewrite the
// pages keep their view in (src/lib/client/url-query.ts):
//
// - arrCall: a read gives up after ARR_READ_TIMEOUT_MS, a write after
//   ARR_WRITE_TIMEOUT_MS; the route's own refusal text, else the fallback; a
//   proxy's own page is "no answer" (status 0); a 2xx that isn't what the page
//   drives on is a failure, never a crash; the caller's abort says nothing.
// - arrCallJob (the Arr System provider tests and saves): `async: true`, a 202
//   polled at `?job=` through the shared counted loop (job-poll.ts); polls that
//   failed on the way are retried, JOB_MAX_FAILED_POLLS in a row (or out of
//   polls) is "still running" — never the change's failure; the job route's
//   own JSON answers are the job's; a gone tab drops it.
// - the answer schemas: a report or a page is refused when a list the page
//   iterates is missing; a write's extra fields never fail a success.
// - withQuery: only the page's own keys move; other params and the #fragment stay.
//
// globalThis.fetch and the timer functions are stubbed; nothing touches the
// network or a real clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARR_READ_TIMEOUT_MS, ARR_WRITE_TIMEOUT_MS, arrAnswer, arrCall, arrCallJob, isStillRunning, routeShape, type ArrCallResult,
} from "../src/lib/client/arr-call.ts";
import {
  ADD_ANSWER, COMMAND_ANSWER, EVENTS_ANSWER, FILES_ANSWER, HEALTH_REPORT, HISTORY_PAGE, PROVIDER_SAVED, PROVIDERS_REPORT,
  TASKS_REPORT, TITLE_STATE, TITLE_WRITE, idsOf,
} from "../src/lib/client/arr-answers.ts";
import { withQuery } from "../src/lib/client/url-query.ts";
import { JOB_MAX_FAILED_POLLS } from "../src/lib/arr-system.ts";
import { check, v } from "../src/lib/validate.ts";

type Step = Response | Error;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (status: number) => new Response("<html>Bad Gateway</html>", { status, headers: { "content-type": "text/html" } });

/** Runs `fn` with fetch answering `steps` in order (and the timeout timer recorded, never fired). */
async function scripted<T>(steps: Step[], fn: () => Promise<T>) {
  const realFetch = globalThis.fetch;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const delays: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const step = steps.shift();
    if (!step) throw new Error(`no scripted answer for ${String(input)}`);
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  globalThis.setTimeout = ((_fn: () => void, ms: number) => {
    delays.push(ms);
    return 0;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
  try {
    return { result: await fn(), seen, delays };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

const PROVIDER = v.object({ provider: v.object({ id: v.int() }) });

// ── arrCall ──────────────────────────────────────────────────────────────────

test("arrCall: a read and a write each carry their own timeout, and a caller's own wins", async () => {
  const read = await scripted([json({ a: 1 })], () => arrCall("/x", { fallback: "f" }));
  assert.deepEqual(read.delays, [ARR_READ_TIMEOUT_MS]);
  assert.deepEqual(read.result, { ok: true, status: 200, data: { a: 1 } });
  const write = await scripted([json({})], () => arrCall("/x", { method: "POST", body: { b: 2 }, fallback: "f" }));
  assert.deepEqual(write.delays, [ARR_WRITE_TIMEOUT_MS]);
  assert.deepEqual(write.seen, [{ url: "/x", method: "POST", body: { b: 2 } }]);
  const own = await scripted([json({})], () => arrCall("/x", { fallback: "f", timeoutMs: 5 }));
  assert.deepEqual(own.delays, [5]);
  assert.ok(ARR_WRITE_TIMEOUT_MS > ARR_READ_TIMEOUT_MS && ARR_READ_TIMEOUT_MS >= 60_000);
});

test("arrCall: a refusal carries the route's own text and body; a proxy's page and a thrown fetch are no answer, with the fallback", async () => {
  const refused = (await scripted([json({ error: "Radarr is unreachable", detail: "x" }, 422)], () => arrCall("/x", { fallback: "f" }))).result;
  assert.deepEqual(refused, { ok: false, status: 422, error: "Radarr is unreachable", body: { error: "Radarr is unreachable", detail: "x" }, aborted: false });
  for (const step of [page(502), new Error("offline")]) {
    const none = (await scripted([step], () => arrCall("/x", { fallback: "f" }))).result;
    assert.deepEqual(none, { ok: false, status: 0, error: "f", body: null, aborted: false });
  }
});

test("arrCall: a 2xx that isn't what the page drives on is a failure with the fallback, never data", async () => {
  for (const body of [null, [1, 2], "text"]) {
    const r = (await scripted([json(body)], () => arrCall("/x", { fallback: "f" }))).result;
    assert.equal(r.ok, false, JSON.stringify(body));
  }
  const wrong = (await scripted([json({ report: 1 })], () => arrCall("/x", { fallback: "f", schema: HEALTH_REPORT }))).result;
  assert.deepEqual(wrong, { ok: false, status: 200, error: "f", body: { report: 1 }, aborted: false });
});

test("arrCall: the caller's abort says nothing", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const r = (await scripted([], () => arrCall("/x", { fallback: "f", signal: ctl.signal }))).result;
  assert.deepEqual(r, { ok: false, status: 0, error: "", body: null, aborted: true });
});

test("arrAnswer: a job's answer is read like a live one", () => {
  assert.deepEqual(arrAnswer(200, { provider: { id: 3 } }, "f", PROVIDER), { ok: true, status: 200, data: { provider: { id: 3 } } });
  assert.deepEqual(arrAnswer(200, { provider: { id: "3" } }, "f", PROVIDER), { ok: false, status: 200, error: "f", body: { provider: { id: "3" } }, aborted: false });
  assert.deepEqual(arrAnswer(409, { error: "warnings", warningsOnly: true }, "f", PROVIDER), { ok: false, status: 409, error: "warnings", body: { error: "warnings", warningsOnly: true }, aborted: false });
  assert.deepEqual(arrAnswer(500, null, "f", PROVIDER), { ok: false, status: 500, error: "f", body: null, aborted: false });
});

test("routeShape: checks the keyed fields and passes the rest of the route's row on whole", () => {
  const row = routeShape<{ id: number; extra: string }>("a row", (r) => typeof r.id === "number");
  assert.deepEqual(check(row, { id: 1, extra: "kept", more: true }), { ok: true, value: { id: 1, extra: "kept", more: true } });
  assert.equal(check(row, { id: "1" }).ok, false);
  assert.equal(check(row, [1]).ok, false);
  assert.equal(check(row, null).ok, false);
});

// ── arrCallJob (moved from the Arr System component) ─────────────────────────

const job = (polls: Step[], first: Step = json({ job: "j1" }, 202), opts: { maxPolls?: number; signal?: AbortSignal } = {}) => {
  const waits: number[] = [];
  return scripted([first, ...polls], () =>
    arrCallJob("/base/admin/arr/providers", {
      method: "PATCH",
      body: { id: 3 },
      schema: PROVIDER,
      fallback: "failed",
      stillRunning: "still running",
      intervalMs: 2_000,
      maxPolls: opts.maxPolls ?? 150,
      signal: opts.signal,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
  ).then((r) => ({ ...r, waits }));
};
const running = () => json({ job: "j1", running: true }, 202);
const blip = () => new Error("offline");
const stillRunning: ArrCallResult<unknown> = { ok: false, status: 0, error: "still running", body: { stillRunning: true }, aborted: false };

test("arrCallJob: sent with async, polled through the shared loop at the base-pathed ?job= url with its own interval", async () => {
  const { result, seen, waits } = await job([running(), json({ provider: { id: 3 } })]);
  assert.deepEqual(result, { ok: true, status: 200, data: { provider: { id: 3 } } });
  assert.deepEqual(seen[0], { url: "/base/admin/arr/providers", method: "PATCH", body: { id: 3, async: true } });
  assert.deepEqual(seen.slice(1).map((s) => s.url), ["/base/admin/arr/providers?job=j1", "/base/admin/arr/providers?job=j1"]);
  assert.deepEqual(waits, [2_000, 2_000]);
});

test("arrCallJob: a url with a query gets &job=", async () => {
  const { seen } = await scripted([json({ job: "j 2" }, 202), json({ provider: { id: 3 } })], () =>
    arrCallJob("/x?a=1", { method: "POST", body: {}, schema: PROVIDER, fallback: "f", stillRunning: "s", intervalMs: 1, maxPolls: 3, sleep: async () => {} }));
  assert.equal(seen[1].url, "/x?a=1&job=j%202");
});

test("arrCallJob: retries a poll that failed on the way, and a real answer after it is the job's answer", async () => {
  const { result, seen } = await job([blip(), page(502), page(520), running(), json({ provider: { id: 3 } })]);
  assert.deepEqual(result, { ok: true, status: 200, data: { provider: { id: 3 } } });
  assert.equal(seen.length, 6);
});

test("arrCallJob: JOB_MAX_FAILED_POLLS failed polls in a row read as still running — never the change's failure", async () => {
  const { result, seen } = await job([blip(), blip(), page(502), blip(), page(524), running()]);
  assert.deepEqual(result, stillRunning);
  assert.ok(isStillRunning(result!));
  assert.equal(seen.length - 1, JOB_MAX_FAILED_POLLS, "stopped at the fifth failure in a row");
});

test("arrCallJob: out of polls reads as still running too", async () => {
  const { result, seen } = await job(Array.from({ length: 10 }, running), undefined, { maxPolls: 3 });
  assert.deepEqual(result, stillRunning);
  assert.equal(seen.length - 1, 3);
});

test("arrCallJob: a real answer between failures resets the count; the job route's JSON answers are the job's own", async () => {
  const done = () => json({ provider: { id: 3 } });
  const reset = await job([blip(), blip(), blip(), blip(), running(), blip(), blip(), blip(), blip(), done()]);
  assert.deepEqual(reset.result, { ok: true, status: 200, data: { provider: { id: 3 } } }, "4 + 4 failures with a 202 between never reach five in a row");

  const own502 = await job([json({ error: "Radarr is unreachable" }, 502), done()]);
  assert.deepEqual(own502.result, { ok: false, status: 502, error: "Radarr is unreachable", body: { error: "Radarr is unreachable" }, aborted: false });
  assert.equal(own502.seen.length, 2);

  const held = await job([json({ error: "warnings", warningsOnly: true, messages: ["slow"] }, 409)]);
  assert.deepEqual(held.result, { ok: false, status: 409, error: "warnings", body: { error: "warnings", warningsOnly: true, messages: ["slow"] }, aborted: false });

  const thrown = await job([json(null, 500)]);
  assert.deepEqual(thrown.result, { ok: false, status: 500, error: "failed", body: null, aborted: false }, "a thrown job's JSON-null 500 is its failure, with the fallback text");
});

test("arrCallJob: a first answer that is not a 202 is returned as it came; a 202 with no job id is a failure; a gone tab drops the answer", async () => {
  const refused = await job([], json({ error: "bad" }, 400));
  assert.deepEqual(refused.result, { ok: false, status: 400, error: "bad", body: { error: "bad" }, aborted: false });
  assert.equal(refused.seen.length, 1);
  const sync = await job([], json({ provider: { id: 3 } }));
  assert.deepEqual(sync.result, { ok: true, status: 200, data: { provider: { id: 3 } } });
  const noJob = await job([], json({}, 202));
  assert.deepEqual(noJob.result, { ok: false, status: 0, error: "failed", body: null, aborted: false });
  assert.equal(noJob.seen.length, 1);

  const ctl = new AbortController();
  ctl.abort();
  const gone = await job([running(), json({ provider: { id: 3 } })], undefined, { signal: ctl.signal });
  assert.equal(gone.result, null);
  assert.equal(gone.seen.length, 0, "no request, no poll once the tab is gone");

  const leaving = new AbortController();
  const late = await scripted([json({ job: "j1" }, 202), running(), json({ provider: { id: 3 } })], () =>
    arrCallJob("/x", {
      method: "PATCH", body: {}, schema: PROVIDER, fallback: "f", stillRunning: "s", intervalMs: 1, maxPolls: 5, signal: leaving.signal,
      sleep: async () => leaving.abort(),
    }));
  assert.equal(late.result, null, "the tab went away mid-wait");
  assert.equal(late.seen.length, 1, "no poll after it");
});

// ── the answer schemas ───────────────────────────────────────────────────────

const title = { arrId: 1, title: "T", tags: [], seasons: [], sizeOnDisk: 0, extra: "kept" };

test("a title read needs the title and its choice lists (null = not answered)", () => {
  const ok = check(TITLE_STATE, { title, qualityProfiles: [{ id: 1, name: "HD" }], rootFolders: null, tags: [] });
  assert.ok(ok.ok);
  assert.equal((ok.value.title as unknown as { extra: string }).extra, "kept", "the rest of the title is passed on");
  assert.equal(check(TITLE_STATE, { title: { ...title, seasons: undefined }, qualityProfiles: null, rootFolders: null, tags: null }).ok, false);
  assert.equal(check(TITLE_STATE, { title, qualityProfiles: [{ id: "1", name: "HD" }], rootFolders: null, tags: null }).ok, false);
  assert.ok(check(TITLE_WRITE, { title: null }).ok, "a write whose re-read failed");
});

test("a list answer needs its list; a row needs the fields the page keys and iterates on", () => {
  assert.equal(check(FILES_ANSWER, {}).ok, false);
  assert.ok(check(FILES_ANSWER, { files: [] }).ok);
  assert.equal(check(FILES_ANSWER, { files: [{ id: 1, relativePath: "a", size: 1, qualityTags: [], languages: [], customFormats: [] }] }).ok, false, "no episodes list");
  assert.equal(check(EVENTS_ANSWER, { events: [{ id: 1 }] }).ok, false);
  assert.equal(check(HISTORY_PAGE, { page: 1, pageSize: 50, totalRecords: 0 }).ok, false, "no records");
  assert.ok(check(HISTORY_PAGE, { page: 1, pageSize: 50, totalRecords: 0, records: [] }).ok);
});

test("a system report needs its instances, errors and every result's lists — an older snapshot without them is refused", () => {
  const report = { instances: [{ service: "radarr", slug: "", name: "Radarr" }], errors: [], results: [{ service: "radarr", instance: "", tasks: [], commands: [] }] };
  assert.ok(check(TASKS_REPORT, report).ok);
  assert.equal(check(TASKS_REPORT, { ...report, errors: undefined }).ok, false);
  assert.equal(check(TASKS_REPORT, { ...report, results: [{ service: "radarr", instance: "" }] }).ok, false);
  assert.equal(check(PROVIDERS_REPORT, report).ok, false, "a tasks report is not a providers report");
  assert.equal(check(HEALTH_REPORT, { instances: [{ service: "radarr", slug: "", checks: [], webhook: { state: "ok" } }], webhookBase: null }).ok, false);
});

test("a saved provider is read as the kind the page sent — an indexer's answer is never a client", () => {
  const indexer = { provider: { id: 1, name: "I", enableRss: true, tags: [] } };
  const client = { provider: { id: 1, name: "C", enable: true, tags: [] } };
  assert.ok(check(PROVIDER_SAVED.indexer, indexer).ok);
  assert.equal(check(PROVIDER_SAVED.downloadClient, indexer).ok, false);
  assert.ok(check(PROVIDER_SAVED.downloadClient, client).ok);
  assert.equal(check(PROVIDER_SAVED.indexer, client).ok, false);
});

test("a write's extras never fail its success; ids are read leniently", () => {
  assert.ok(check(COMMAND_ANSWER, { commands: 1, commandIds: ["x", 4] }).ok);
  assert.ok(check(ADD_ANSWER, { arrId: "weird" }).ok);
  assert.deepEqual(idsOf([3, "4", -1, 0, 2.5, 7]), [3, 7]);
  assert.deepEqual(idsOf("3"), []);
});

// ── withQuery ────────────────────────────────────────────────────────────────

test("withQuery: only the page's own keys change; other params and the fragment stay", () => {
  const at = { pathname: "/base/admin/arr-system", search: "?tab=tasks&from=nav", hash: "#storage" };
  assert.equal(withQuery(at, { tab: "providers" }), "/base/admin/arr-system?tab=providers&from=nav#storage");
  assert.equal(withQuery(at, { tab: null }), "/base/admin/arr-system?from=nav#storage");
  assert.equal(withQuery({ pathname: "/p", search: "", hash: "" }, { a: null }), "/p");
  assert.equal(withQuery({ pathname: "/p", search: "?a=1", hash: "" }, { b: "x y" }), "/p?a=1&b=x+y");
});
