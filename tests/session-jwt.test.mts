// Unit tests for the session JWT (src/lib/session-jwt.ts) — the core auth
// credential for both cookie and bearer transports. Pins signature/expiry
// enforcement, the pinned-alg rejection of alg:none forgeries, the id/role
// shape check, and the iat override used by the role-rotation path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { signSessionJwt, verifySessionJwt } from "../src/lib/session-jwt.ts";

const SECRET = "unit-test-session-secret-0123456789abcdef";
process.env.NEXTAUTH_SECRET = SECRET;

const CLAIMS = {
  id: "u_alice",
  role: "USER",
  permissions: "12345",
  email: "alice@example.com",
  provider: "credentials",
  sessionId: "sess_1",
  machineAllowedIps: ["10.0.0.0/8"],
};

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

test("sign → verify roundtrip preserves the claim set", async () => {
  const token = await signSessionJwt(CLAIMS, { expiresInSeconds: 3600 });
  const claims = await verifySessionJwt(token);
  assert.ok(claims);
  assert.equal(claims.id, "u_alice");
  assert.equal(claims.role, "USER");
  assert.equal(claims.permissions, "12345");
  assert.equal(claims.sessionId, "sess_1");
  assert.deepEqual(claims.machineAllowedIps, ["10.0.0.0/8"]);
});

test("expired tokens verify to null", async () => {
  const token = await signSessionJwt(CLAIMS, { expiresInSeconds: -10 });
  assert.equal(await verifySessionJwt(token), null);
});

test("tampered payload breaks the signature", async () => {
  const token = await signSessionJwt(CLAIMS, { expiresInSeconds: 3600 });
  const [header, , sig] = token.split(".");
  const body = decodePayload(token);
  body.role = "ADMIN"; // privilege-escalation attempt
  const forgedPayload = Buffer.from(JSON.stringify(body)).toString("base64url");
  assert.equal(await verifySessionJwt(`${header}.${forgedPayload}.${sig}`), null);
});

test("token signed with a different secret is rejected", async () => {
  const token = await signSessionJwt(CLAIMS, { expiresInSeconds: 3600 });
  process.env.NEXTAUTH_SECRET = "a-completely-different-secret-9876543210";
  try {
    assert.equal(await verifySessionJwt(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
  assert.ok(await verifySessionJwt(token)); // sanity: verifies again with the right secret
});

test("alg:none forgery is rejected (pinned HS256 list)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ id: "u_evil", role: "ADMIN", iat: now, exp: now + 3600 }),
  ).toString("base64url");
  assert.equal(await verifySessionJwt(`${header}.${payload}.`), null);
});

test("a validly-signed token missing id/role claims verifies to null", async () => {
  // Signed with the right secret and alg, but the payload shape is wrong.
  const token = await new SignJWT({ sub: "not-a-session" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifySessionJwt(token), null);
});

test("garbage tokens verify to null, never throw", async () => {
  assert.equal(await verifySessionJwt(""), null);
  assert.equal(await verifySessionJwt("not.a.jwt"), null);
  assert.equal(await verifySessionJwt("deadbeef"), null);
});

test("iat override pins both iat and exp (role-rotation contract)", async () => {
  const fixedIat = 1_700_000_000;
  const token = await signSessionJwt(CLAIMS, { expiresInSeconds: 3600, iat: fixedIat });
  const payload = decodePayload(token);
  assert.equal(payload.iat, fixedIat);
  assert.equal(payload.exp, fixedIat + 3600);
});

// Regression detector for the algorithms:["HS256"] pin. jose accepts any HMAC
// alg (HS256/384/512) for a Uint8Array secret when no alg list is pinned, so a
// token HMAC'd with the CORRECT secret under HS384/HS512 verifies fine without
// the pin — the alg:none test above would NOT catch its removal. These are the
// tests that fail if someone drops the pin.
for (const alg of ["HS384", "HS512"] as const) {
  test(`token signed ${alg} with the correct secret is rejected (alg pin)`, async () => {
    const token = await new SignJWT({ id: "u_alice", role: "ADMIN" })
      .setProtectedHeader({ alg, typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    assert.equal(await verifySessionJwt(token), null);
  });
}

// One-sided shape-check cases. The existing missing-claims test omits BOTH id
// and role, so it would survive an ||→&& slip in the
// `typeof payload.id !== "string" || typeof payload.role !== "string"` check —
// which would let an id-only (or role-only, or numeric-id) forgery through.
test("validly-signed token with id but no role verifies to null", async () => {
  const token = await new SignJWT({ id: "u_alice" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifySessionJwt(token), null);
});

test("validly-signed token with role but no id verifies to null", async () => {
  const token = await new SignJWT({ role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifySessionJwt(token), null);
});

test("validly-signed token with a non-string id verifies to null", async () => {
  const token = await new SignJWT({ id: 42, role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifySessionJwt(token), null);
});

test("missing NEXTAUTH_SECRET: sign rejects, verify swallows to null", async () => {
  // getSecret() reads process.env lazily on every call, so deleting the var is
  // effective immediately. signSessionJwt propagates the throw; verifySessionJwt
  // catches it and returns null (its blanket catch covers the config error too).
  const token = await signSessionJwt(CLAIMS, { expiresInSeconds: 3600 });
  delete process.env.NEXTAUTH_SECRET;
  try {
    await assert.rejects(
      signSessionJwt(CLAIMS, { expiresInSeconds: 3600 }),
      /\[session-jwt\] NEXTAUTH_SECRET must be set/,
    );
    assert.equal(await verifySessionJwt(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
  assert.ok(await verifySessionJwt(token)); // sanity: verifies again once restored
});

test("PINS CURRENT BEHAVIOR: a validly-signed token with NO exp claim verifies", async () => {
  // jose's jwtVerify does not require an exp claim unless maxTokenAge or
  // requiredClaims is passed — and verifySessionJwt passes neither. Expiry
  // enforcement therefore depends entirely on the signer setting exp
  // (signSessionJwt always does). A hand-signed never-expiring token with a
  // valid id/role shape currently returns its claims rather than null.
  const token = await new SignJWT({ id: "u_alice", role: "USER" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .sign(new TextEncoder().encode(SECRET));
  const claims = await verifySessionJwt(token);
  assert.ok(claims);
  assert.equal(claims.id, "u_alice");
  assert.equal(claims.exp, undefined);
});
