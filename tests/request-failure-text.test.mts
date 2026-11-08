// One reading of a failed admin request (src/components/admin/request-failure-text.ts):
// the route's own reason, else its status, else the network sentence; nothing
// for a request the panel aborted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestFailureText } from "../src/components/admin/request-failure-text.ts";
import type { FetchJsonFailure } from "../src/lib/client/fetch-json.ts";

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
const keys = { status: "s", network: "n" };
const fail = (kind: FetchJsonFailure["kind"], status: number, error = ""): FetchJsonFailure => ({ ok: false, kind, status, error, body: null, detail: "" });

test("the route's reason wins; a reason-less refusal or a non-JSON 2xx names the status", () => {
  assert.equal(requestFailureText(fail("http", 429, "Too many attempts"), t, keys), "Too many attempts");
  assert.equal(requestFailureText(fail("http", 403), t, keys), 's:{"status":403}');
  assert.equal(requestFailureText(fail("invalid", 200), t, keys), 's:{"status":200}');
});

test("no answer is the network sentence; an abort says nothing", () => {
  assert.equal(requestFailureText(fail("network", 0), t, keys), "n");
  assert.equal(requestFailureText(fail("timeout", 0), t, keys), "n");
  assert.equal(requestFailureText(fail("aborted", 0), t, keys), null);
});
