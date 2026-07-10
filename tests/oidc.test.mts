// Unit tests for the pure parts of the OIDC client (src/lib/oidc.ts).
// The flow-state cookie is the ONLY thing carrying the PKCE codeVerifier,
// CSRF state, and replay nonce across the IdP redirect: /api/auth/oidc/start
// stamps them into a short-lived signed JWT cookie and the callback trusts
// what verifies. A forgeable or type-loose cookie would let an attacker
// substitute their own state/nonce/verifier and splice a victim's browser
// into an attacker-initiated login. Pins: signature/expiry enforcement, the
// pinned-HS256 rejection of alg:none forgeries, fail-closed shape checks on
// all four required string fields, the optional returnTo passthrough, the
// exact 5-minute TTL, and env-driven isOidcConfigured gating (network-bound
// discovery/token exchange is deliberately NOT exercised here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  OIDC_STATE_COOKIE,
  isOidcConfigured,
  signOidcStateCookie,
  verifyOidcStateCookie,
} from "../src/lib/oidc.ts";
import { signPlexFlowCookie } from "../src/lib/plex-flow-state.ts";

const SECRET = "unit-test-oidc-state-secret-0123456789abcdef";
process.env.NEXTAUTH_SECRET = SECRET;

const STATE = {
  state: "st_9f2c1a7b",
  nonce: "n_5d3e8c40",
  codeVerifier: "cv_" + "a".repeat(43),
  redirectUri: "https://summonarr.example.com/api/auth/oidc/callback",
};

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function signRaw(claims: Record<string, unknown>, expiresIn = "5m"): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(SECRET));
}

test("OIDC_STATE_COOKIE is the exact cookie name both routes agree on", () => {
  assert.equal(OIDC_STATE_COOKIE, "summonarr-oidc-flow");
});

test("isOidcConfigured requires all three OIDC_* env vars, non-empty", () => {
  const saved = {
    issuer: process.env.OIDC_ISSUER,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
  };
  try {
    process.env.OIDC_ISSUER = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "summonarr";
    process.env.OIDC_CLIENT_SECRET = "s3cret";
    assert.equal(isOidcConfigured(), true);

    // Each var missing individually → not configured.
    delete process.env.OIDC_ISSUER;
    assert.equal(isOidcConfigured(), false);
    process.env.OIDC_ISSUER = "https://idp.example.com";

    delete process.env.OIDC_CLIENT_ID;
    assert.equal(isOidcConfigured(), false);
    process.env.OIDC_CLIENT_ID = "summonarr";

    delete process.env.OIDC_CLIENT_SECRET;
    assert.equal(isOidcConfigured(), false);

    // Empty string is falsy — a blank docker env line must not count as configured.
    process.env.OIDC_CLIENT_SECRET = "";
    assert.equal(isOidcConfigured(), false);
  } finally {
    for (const [env, val] of [
      ["OIDC_ISSUER", saved.issuer],
      ["OIDC_CLIENT_ID", saved.clientId],
      ["OIDC_CLIENT_SECRET", saved.clientSecret],
    ] as const) {
      if (val === undefined) delete process.env[env];
      else process.env[env] = val;
    }
  }
});

test("sign → verify roundtrip returns exactly the stored flow state", async () => {
  const token = await signOidcStateCookie(STATE);
  const verified = await verifyOidcStateCookie(token);
  assert.deepEqual(verified, { ...STATE, returnTo: undefined });
});

test("returnTo survives the roundtrip verbatim (post-login destination)", async () => {
  const withReturn = { ...STATE, returnTo: "/requests?tab=pending&sort=votes" };
  const token = await signOidcStateCookie(withReturn);
  const verified = await verifyOidcStateCookie(token);
  assert.deepEqual(verified, withReturn);
});

test("the state JWT carries only the flow fields plus iat/exp", async () => {
  const bare = decodePayload(await signOidcStateCookie(STATE));
  assert.deepEqual(Object.keys(bare).sort(), [
    "codeVerifier",
    "exp",
    "iat",
    "nonce",
    "redirectUri",
    "state",
  ]);
  assert.equal(bare.state, STATE.state);
  assert.equal(bare.nonce, STATE.nonce);
  assert.equal(bare.codeVerifier, STATE.codeVerifier);
  assert.equal(bare.redirectUri, STATE.redirectUri);

  const withReturn = decodePayload(
    await signOidcStateCookie({ ...STATE, returnTo: "/movies" }),
  );
  assert.equal(withReturn.returnTo, "/movies");
  assert.deepEqual(Object.keys(withReturn).sort(), [
    "codeVerifier",
    "exp",
    "iat",
    "nonce",
    "redirectUri",
    "returnTo",
    "state",
  ]);
});

test("cookie lifetime is pinned to 5 minutes (exp - iat)", async () => {
  const payload = decodePayload(await signOidcStateCookie(STATE));
  assert.equal(typeof payload.iat, "number");
  assert.equal(payload.exp, (payload.iat as number) + 300);
});

test("expired state cookie verifies to null (stale flow cannot complete)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({ ...STATE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now - 400)
    .setExpirationTime(now - 60)
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifyOidcStateCookie(expired), null);
});

test("cookie signed with a different secret is rejected", async () => {
  const token = await signOidcStateCookie(STATE);
  process.env.NEXTAUTH_SECRET = "a-completely-different-secret-9876543210";
  try {
    assert.equal(await verifyOidcStateCookie(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
  assert.ok(await verifyOidcStateCookie(token)); // sanity: verifies again with the right secret
});

test("tampered state value breaks the signature (CSRF state swap)", async () => {
  const token = await signOidcStateCookie(STATE);
  const [header, , sig] = token.split(".");
  const body = decodePayload(token);
  body.state = "st_attacker"; // splice in an attacker-initiated flow's state
  const forged = Buffer.from(JSON.stringify(body)).toString("base64url");
  assert.equal(await verifyOidcStateCookie(`${header}.${forged}.${sig}`), null);
});

test("alg:none forgery is rejected (pinned HS256 list)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ ...STATE, iat: now, exp: now + 300 })).toString(
    "base64url",
  );
  assert.equal(await verifyOidcStateCookie(`${header}.${payload}.`), null);
});

test("validly-signed token missing any required field verifies to null", async () => {
  // Each of the four fields is load-bearing for the callback: state (CSRF),
  // nonce (replay), codeVerifier (PKCE), redirectUri (token exchange). Fail
  // closed if ANY is absent.
  for (const missing of ["state", "nonce", "codeVerifier", "redirectUri"] as const) {
    const partial: Record<string, unknown> = { ...STATE };
    delete partial[missing];
    assert.equal(
      await verifyOidcStateCookie(await signRaw(partial)),
      null,
      `expected null when '${missing}' is absent`,
    );
  }
});

test("validly-signed token with non-string required fields verifies to null", async () => {
  assert.equal(await verifyOidcStateCookie(await signRaw({ ...STATE, state: 12345 })), null);
  assert.equal(await verifyOidcStateCookie(await signRaw({ ...STATE, nonce: null })), null);
  assert.equal(
    await verifyOidcStateCookie(await signRaw({ ...STATE, codeVerifier: ["cv"] })),
    null,
  );
  assert.equal(
    await verifyOidcStateCookie(await signRaw({ ...STATE, redirectUri: { href: "x" } })),
    null,
  );
  assert.equal(await verifyOidcStateCookie(await signRaw({ sub: "not-a-flow" })), null);
});

test("non-string returnTo is dropped to undefined, not rejected", async () => {
  // returnTo is optional cosmetics (post-login redirect); a wrong type must
  // not kill the whole login, but it must never pass through non-string.
  const verified = await verifyOidcStateCookie(await signRaw({ ...STATE, returnTo: 42 }));
  assert.deepEqual(verified, { ...STATE, returnTo: undefined });
});

test("a Plex flow cookie does not verify as OIDC state (cross-flow confusion)", async () => {
  // Both flow cookies are HS256 JWTs under the same NEXTAUTH_SECRET; the
  // shape check is what keeps a Plex PIN-flow token out of the OIDC callback.
  const plexToken = await signPlexFlowCookie({ pinId: 987654321, clientId: "summonarr-web" });
  assert.equal(await verifyOidcStateCookie(plexToken), null);
});

test("garbage tokens verify to null, never throw", async () => {
  assert.equal(await verifyOidcStateCookie(""), null);
  assert.equal(await verifyOidcStateCookie("not.a.jwt"), null);
  assert.equal(await verifyOidcStateCookie("deadbeef"), null);
});

test("sign throws without NEXTAUTH_SECRET; verify fails closed to null", async () => {
  const token = await signOidcStateCookie(STATE);
  delete process.env.NEXTAUTH_SECRET;
  try {
    await assert.rejects(signOidcStateCookie(STATE), /NEXTAUTH_SECRET/);
    assert.equal(await verifyOidcStateCookie(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
});
