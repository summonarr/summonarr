// Unit tests for the Plex PIN flow-state cookie (src/lib/plex-flow-state.ts).
// This cookie is the ONLY thing binding a Plex PIN redemption to the browser
// that started the flow: /api/auth/plex/start stamps { pinId, clientId } into
// a short-lived signed HttpOnly cookie, and /api/auth/sign-in/plex rejects any
// submission whose body pinId doesn't match — defeating an attacker who
// phished a victim into approving an attacker-created PIN. Pins:
// signature/expiry enforcement, strict payload type checks (fail closed on a
// stringified pinId), null-never-throw verification, exact cookie-attribute
// strings, and cookie-header parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  PLEX_FLOW_COOKIE,
  signPlexFlowCookie,
  verifyPlexFlowCookie,
  readPlexFlowCookie,
  buildPlexFlowSetCookie,
  buildPlexFlowClearedSetCookie,
} from "../src/lib/plex-flow-state.ts";
import { signQcFlowCookie } from "../src/lib/jellyfin-flow-state.ts";

const SECRET = "unit-test-plex-flow-secret-0123456789abcdef";
process.env.NEXTAUTH_SECRET = SECRET;

const STATE = { pinId: 987654321, clientId: "summonarr-web-3f2a" };

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

test("sign → verify roundtrip returns exactly the stored pinId and clientId", async () => {
  const token = await signPlexFlowCookie(STATE);
  const state = await verifyPlexFlowCookie(token);
  assert.deepEqual(state, STATE);
});

test("the cookie JWT carries only pinId/clientId plus iat/exp", async () => {
  const token = await signPlexFlowCookie(STATE);
  const payload = decodePayload(token);
  assert.deepEqual(Object.keys(payload).sort(), ["clientId", "exp", "iat", "pinId"]);
  assert.equal(payload.pinId, STATE.pinId);
  assert.equal(payload.clientId, STATE.clientId);
});

test("cookie lifetime is pinned to 10 minutes (exp - iat)", async () => {
  const token = await signPlexFlowCookie(STATE);
  const payload = decodePayload(token);
  assert.equal(typeof payload.iat, "number");
  assert.equal(payload.exp, (payload.iat as number) + 600);
});

test("expired flow cookie verifies to null", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({ ...STATE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now - 700)
    .setExpirationTime(now - 60)
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifyPlexFlowCookie(expired), null);
});

test("cookie signed with a different secret is rejected", async () => {
  const token = await signPlexFlowCookie(STATE);
  process.env.NEXTAUTH_SECRET = "a-completely-different-secret-9876543210";
  try {
    assert.equal(await verifyPlexFlowCookie(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
  assert.ok(await verifyPlexFlowCookie(token)); // sanity: verifies again with the right secret
});

test("tampered pinId breaks the signature (attacker PIN swap)", async () => {
  const token = await signPlexFlowCookie(STATE);
  const [header, , sig] = token.split(".");
  const body = decodePayload(token);
  body.pinId = 111111; // attacker-created PIN
  const forged = Buffer.from(JSON.stringify(body)).toString("base64url");
  assert.equal(await verifyPlexFlowCookie(`${header}.${forged}.${sig}`), null);
});

test("alg:none forgery is rejected (pinned HS256 list)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ ...STATE, iat: now, exp: now + 600 })).toString(
    "base64url",
  );
  assert.equal(await verifyPlexFlowCookie(`${header}.${payload}.`), null);
});

test("validly-signed token with wrong payload types verifies to null", async () => {
  const key = new TextEncoder().encode(SECRET);
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  // pinId as a string must NOT coerce — fail closed.
  assert.equal(await verifyPlexFlowCookie(await sign({ pinId: "987654321", clientId: "c" })), null);
  // clientId as a number likewise.
  assert.equal(await verifyPlexFlowCookie(await sign({ pinId: 1, clientId: 42 })), null);
  // Missing either field.
  assert.equal(await verifyPlexFlowCookie(await sign({ pinId: 1 })), null);
  assert.equal(await verifyPlexFlowCookie(await sign({ clientId: "c" })), null);
  assert.equal(await verifyPlexFlowCookie(await sign({ sub: "not-a-flow" })), null);
});

test("a QC flow cookie does not verify as Plex flow state (cross-flow confusion)", async () => {
  // Both flow cookies are HS256 JWTs under the same NEXTAUTH_SECRET; the shape
  // check is what keeps a QuickConnect-flow token out of the Plex path.
  const qcToken = await signQcFlowCookie({ secretHash: "a".repeat(64) });
  assert.equal(await verifyPlexFlowCookie(qcToken), null);
});

test("garbage tokens verify to null, never throw", async () => {
  assert.equal(await verifyPlexFlowCookie(""), null);
  assert.equal(await verifyPlexFlowCookie("not.a.jwt"), null);
  assert.equal(await verifyPlexFlowCookie("deadbeef"), null);
});

test("sign throws without NEXTAUTH_SECRET; verify fails closed to null", async () => {
  const token = await signPlexFlowCookie(STATE);
  delete process.env.NEXTAUTH_SECRET;
  try {
    await assert.rejects(signPlexFlowCookie(STATE), /NEXTAUTH_SECRET/);
    assert.equal(await verifyPlexFlowCookie(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
});

test("readPlexFlowCookie extracts the flow cookie from a Cookie header", () => {
  assert.equal(readPlexFlowCookie(null), null);
  assert.equal(readPlexFlowCookie(""), null);
  assert.equal(readPlexFlowCookie("other=1; session=abc"), null);
  assert.equal(readPlexFlowCookie(`${PLEX_FLOW_COOKIE}=tok123`), "tok123");
  assert.equal(readPlexFlowCookie(`a=1; ${PLEX_FLOW_COOKIE}=tok123; b=2`), "tok123");
  // Only the FIRST '=' splits name from value.
  assert.equal(readPlexFlowCookie(`${PLEX_FLOW_COOKIE}=abc=def==`), "abc=def==");
});

test("readPlexFlowCookie matches the exact cookie name only", () => {
  assert.equal(readPlexFlowCookie(`${PLEX_FLOW_COOKIE}-evil=tok`), null);
  assert.equal(readPlexFlowCookie(`x${PLEX_FLOW_COOKIE}=tok`), null);
  // A valueless fragment (no '=') is skipped, not matched.
  assert.equal(readPlexFlowCookie(`${PLEX_FLOW_COOKIE}; a=1`), null);
  // Empty value is still a match (returns empty string, not null).
  assert.equal(readPlexFlowCookie(`${PLEX_FLOW_COOKIE}=`), "");
});

test("buildPlexFlowSetCookie emits the exact hardened attribute set", () => {
  assert.equal(
    buildPlexFlowSetCookie("tok123", false),
    `${PLEX_FLOW_COOKIE}=tok123; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  assert.equal(
    buildPlexFlowSetCookie("tok123", true),
    `${PLEX_FLOW_COOKIE}=tok123; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure`,
  );
});

test("buildPlexFlowClearedSetCookie clears the same name+path it set", () => {
  const cleared = buildPlexFlowClearedSetCookie();
  assert.equal(cleared, `${PLEX_FLOW_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax`);
  assert.ok(cleared.startsWith(`${PLEX_FLOW_COOKIE}=;`));
  assert.ok(cleared.includes("Path=/api/auth"));
  assert.ok(cleared.includes("Max-Age=0"));
});

test("full flow: set-cookie → echoed Cookie header → verified state matches", async () => {
  const token = await signPlexFlowCookie(STATE);
  const setCookie = buildPlexFlowSetCookie(token, true);
  // Browser echoes back only the name=value pair, alongside other cookies.
  const echoed = `theme=dark; ${setCookie.split("; ")[0]}; lang=en`;
  const read = readPlexFlowCookie(echoed);
  assert.equal(read, token);
  const state = await verifyPlexFlowCookie(read as string);
  assert.deepEqual(state, STATE);
  // The sign-in route's binding check: a body pinId from a different flow
  // (attacker-created PIN) does not match the cookie's pinId.
  assert.notEqual(state?.pinId, 111111);
});
