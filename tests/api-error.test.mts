// The shared client reader for a failed route's reason (src/lib/client/api-error.ts):
// the queue, Missing, cleanup and issue pages all show what the route said, or
// their own fallback when it said nothing usable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiErrorText, readApiError } from "../src/lib/client/api-error.ts";

const FALLBACK = "Something went wrong";
const json = (body: unknown, status = 400) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("message wins over error: a conflict's sentence, not its slug", async () => {
  assert.equal(apiErrorText({ error: "status-conflict", message: "Someone changed it first" }, FALLBACK), "Someone changed it first");
  assert.equal(await readApiError(json({ error: "claim-conflict", message: "Alex claimed it" }, 409), FALLBACK), "Alex claimed it");
});

test("error is used when there is no message", async () => {
  assert.equal(apiErrorText({ error: "Radarr is not configured" }, FALLBACK), "Radarr is not configured");
  assert.equal(await readApiError(json({ error: "Not found" }, 404), FALLBACK), "Not found");
});

test("an empty or non-string field is no reason: the next one, then the fallback", async () => {
  assert.equal(apiErrorText({ message: "", error: "Not found" }, FALLBACK), "Not found");
  assert.equal(apiErrorText({ message: 42, error: "Not found" }, FALLBACK), "Not found");
  assert.equal(apiErrorText({ error: "" }, FALLBACK), FALLBACK);
  assert.equal(apiErrorText({ error: { code: 1 } }, FALLBACK), FALLBACK);
  assert.equal(apiErrorText({ error: null, message: null }, FALLBACK), FALLBACK);
  assert.equal(apiErrorText({}, FALLBACK), FALLBACK);
});

test("a body that isn't the route's JSON gives the fallback", async () => {
  // A reverse proxy's HTML page, an empty body, a JSON array or scalar.
  assert.equal(await readApiError(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }), FALLBACK), FALLBACK);
  assert.equal(await readApiError(new Response(null, { status: 500 }), FALLBACK), FALLBACK);
  assert.equal(await readApiError(json(["nope"]), FALLBACK), FALLBACK);
  assert.equal(apiErrorText("nope", FALLBACK), FALLBACK);
  assert.equal(apiErrorText(null, FALLBACK), FALLBACK);
  assert.equal(apiErrorText(undefined, FALLBACK), FALLBACK);
});

test("a body that was already read gives the fallback instead of throwing", async () => {
  const res = json({ error: "Not found" }, 404);
  await res.text();
  assert.equal(await readApiError(res, FALLBACK), FALLBACK);
});
