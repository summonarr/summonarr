import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFailureText } from "../src/lib/client/fetch-failure-text.ts";
import type { FetchJsonFailure } from "../src/lib/client/fetch-json.ts";

const t = (key: string) => `<${key}>`;
const fail = (kind: FetchJsonFailure["kind"], error = ""): FetchJsonFailure =>
  ({ ok: false, kind, status: kind === "http" ? 409 : 0, error, body: null, detail: "" });

test("a refusal reads as the route's reason, an invalid 2xx as the call's fallback", () => {
  assert.equal(fetchFailureText(fail("http", "Already grabbed"), t), "Already grabbed");
  assert.equal(fetchFailureText(fail("invalid", "Search failed"), t), "Search failed");
});

test("no answer reads as the network sentence, and an aborted request says nothing", () => {
  assert.equal(fetchFailureText(fail("network"), t), "<shared.thread.networkError>");
  assert.equal(fetchFailureText(fail("timeout"), t), "<shared.thread.networkError>");
  assert.equal(fetchFailureText(fail("aborted"), t), null);
});
