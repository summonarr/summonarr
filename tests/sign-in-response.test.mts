// Unit tests for the shared sign-in response builder
// (src/lib/sign-in-response.ts) — guardrail 6b's choke point. The session JWT
// may reach a response BODY only when the caller positively identifies as a
// native client via X-Summonarr-Client; a browser login must never see the
// token in JSON (that would defeat HttpOnly). The contract pinned here:
//   - the HttpOnly session cookie is ALWAYS set (web AND native — the module
//     deliberately keeps the web flow unchanged for native callers),
//   - token/tokenType/expiresInSeconds appear in the body ONLY on the native
//     header (presence of Authorization: Bearer alone does NOT unlock it),
//   - extraSetCookies append after the session cookie, in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { buildSignInResponse } from "../src/lib/sign-in-response.ts";
import type { SignInResult } from "../src/lib/auth.ts";

// serializeSessionCookie reads AUTH_URL at call time; pin an http:// URL so
// the default expectation is the unprefixed, non-Secure dev cookie.
process.env.AUTH_URL = "http://localhost:3000";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InVfYWxpY2UifQ.c2lnbmF0dXJl";

const RESULT: SignInResult = {
  token: TOKEN,
  expiresInSeconds: 3600,
  sessionId: "sess_1",
  user: {
    id: "u_alice",
    role: "USER",
    email: "alice@example.com",
    name: "Alice",
    provider: "credentials",
    mediaServer: null,
  },
};

function makeRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/sign-in/credentials", {
    method: "POST",
    headers,
  });
}

test("web sign-in (no native header): token never reaches the body, cookie carries it", async () => {
  const res = buildSignInResponse(makeRequest(), RESULT);
  assert.equal(res.status, 200);

  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { ok: true, user: RESULT.user });
  assert.ok(!("token" in body));
  assert.ok(!("tokenType" in body));
  assert.ok(!("expiresInSeconds" in body));
  assert.ok(!("sessionId" in body)); // internal id, never exposed
  // The strongest form: the JWT appears nowhere in the serialized body.
  assert.equal(JSON.stringify(body).includes(TOKEN), false);

  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.equal(
    cookies[0],
    `summonarr-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
  );
});

test("native client header: JWT + Bearer metadata land in the body", async () => {
  const res = buildSignInResponse(
    makeRequest({ "X-Summonarr-Client": "ios; build=42" }),
    RESULT,
  );
  assert.equal(res.status, 200);

  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.deepEqual(body.user, RESULT.user);
  assert.equal(body.token, TOKEN);
  assert.equal(body.tokenType, "Bearer");
  assert.equal(body.expiresInSeconds, 3600);
});

test("native response STILL sets the session cookie (web flow unchanged by design)", () => {
  const res = buildSignInResponse(makeRequest({ "x-summonarr-client": "ios" }), RESULT);
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.equal(
    cookies[0],
    `summonarr-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
  );
});

test("native header name is case-insensitive (client may send any casing)", async () => {
  const res = buildSignInResponse(makeRequest({ "X-SUMMONARR-CLIENT": "ios" }), RESULT);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.token, TOKEN);
});

test("blank / whitespace-only native header does not unlock the token", async () => {
  // Fetch header normalization strips outer whitespace, so " " arrives as "";
  // hasNativeClientHeader must treat both as absent.
  for (const value of ["", " "]) {
    const res = buildSignInResponse(makeRequest({ "x-summonarr-client": value }), RESULT);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(!("token" in body), `value ${JSON.stringify(value)} must not unlock the token`);
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
  }
});

test("Authorization: Bearer alone does NOT unlock the body token — the gate is X-Summonarr-Client", async () => {
  const res = buildSignInResponse(
    makeRequest({ authorization: `Bearer ${TOKEN}` }),
    RESULT,
  );
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(!("token" in body));
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("extraSetCookies append after the session cookie, in order", () => {
  const extras = [
    "summonarr-oidc-state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    "legacy=; Max-Age=0; Path=/",
  ];
  const res = buildSignInResponse(makeRequest(), RESULT, { extraSetCookies: extras });
  const cookies = res.headers.getSetCookie();
  assert.deepEqual(cookies, [
    `summonarr-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    ...extras,
  ]);
});

test("cookie Max-Age tracks result.expiresInSeconds exactly (rememberMe long TTL)", async () => {
  const longLived: SignInResult = { ...RESULT, expiresInSeconds: 2_592_000 };
  const res = buildSignInResponse(makeRequest({ "x-summonarr-client": "ios" }), longLived);
  const cookies = res.headers.getSetCookie();
  assert.equal(
    cookies[0],
    `summonarr-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  );
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.expiresInSeconds, 2_592_000);
});

test("secure context (https AUTH_URL): __Host- prefixed cookie with Secure", () => {
  process.env.AUTH_URL = "https://summonarr.example.com";
  try {
    const res = buildSignInResponse(makeRequest(), RESULT);
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.equal(
      cookies[0],
      `__Host-summonarr-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`,
    );
  } finally {
    process.env.AUTH_URL = "http://localhost:3000";
  }
});
