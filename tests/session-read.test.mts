// The client session provider's reading of GET /api/auth/me
// (src/components/auth/session-read.ts): only the server's own "no session"
// (401/403) signs the UI out. A 5xx while the server restarts behind a proxy,
// no answer at all, or a body that isn't the session keeps what is shown —
// before, any non-2xx dropped the user to "unauthenticated" while a network
// error kept them, so one blip during a restart blanked the nav.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MeSchema, sessionAfterRead, type SessionState } from "../src/components/auth/session-read.ts";
import { check } from "../src/lib/validate.ts";
import type { FetchJsonResult } from "../src/lib/client/fetch-json.ts";

type S = { user: { id: string; role: string } };
const signedIn: SessionState<S> = { session: { user: { id: "u1", role: "USER" } }, status: "authenticated" };
const loading: SessionState<S> = { session: null, status: "loading" };
const fail = (kind: "http" | "network" | "timeout" | "invalid" | "aborted", status: number): FetchJsonResult<{ session: S | null }> =>
  ({ ok: false, kind, status, error: "", body: null, detail: "" });

test("a 401 or 403 is the server saying there is no session: signed out", () => {
  for (const status of [401, 403]) {
    assert.deepEqual(sessionAfterRead(signedIn, fail("http", status)), { session: null, status: "unauthenticated" });
  }
});

test("a 5xx, no answer, a timeout or a body that isn't the session keeps the session shown", () => {
  for (const res of [fail("http", 500), fail("http", 502), fail("network", 0), fail("timeout", 0), fail("invalid", 200), fail("http", 429)]) {
    assert.deepEqual(sessionAfterRead(signedIn, res), signedIn, `${res.ok ? "" : res.kind} ${res.status}`);
  }
  // With nothing shown, a failed first read settles on "unauthenticated" (no spinner forever).
  assert.deepEqual(sessionAfterRead(loading, fail("network", 0)), { session: null, status: "unauthenticated" });
});

test("an answer replaces what is shown", () => {
  const next = { user: { id: "u2", role: "ADMIN" } };
  assert.deepEqual(sessionAfterRead(loading, { ok: true, status: 200, data: { session: next } }), { session: next, status: "authenticated" });
  assert.deepEqual(sessionAfterRead(signedIn, { ok: true, status: 200, data: { session: null } }), { session: null, status: "unauthenticated" });
});

test("the schema takes what /api/auth/me answers, and refuses a body that isn't a session", () => {
  const body = {
    session: {
      user: { id: "u1", role: "USER", permissions: "1048576", email: null, name: "Alice", provider: "credentials", mediaServer: null },
      expiresAt: 1_800_000_000,
    },
  };
  const parsed = check(MeSchema, body);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, body);
  assert.ok(check(MeSchema, { session: null }).ok);
  // `permissions` is left out when the claim has none.
  assert.ok(check(MeSchema, { session: { user: { id: "u1", role: "USER" } } }).ok);
  assert.equal(check(MeSchema, { session: { user: { id: 7, role: "USER" } } }).ok, false);
  assert.equal(check(MeSchema, "<html>").ok, false);
});
