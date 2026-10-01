// Unit tests for the two-factor flow tokens (src/lib/mfa/mfa-token.ts).
//
// The security property under test: a challenge token is NEVER a session, and
// a session is never a challenge token — in either direction, by key, by `typ`
// and by audience — and each token is single-use and short-lived (guardrail 6d).
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";

process.env.NEXTAUTH_SECRET = "mfa-token-test-secret-0123456789abcdef";

const {
  signMfaSigninToken,
  verifyMfaSigninToken,
  signPasskeyRegisterToken,
  verifyPasskeyRegisterToken,
  consumeToken,
  isTokenUsable,
  recordTokenFailure,
  resetMfaTokenLedgerForTests,
  MAX_TOKEN_FAILURES,
  MFA_TOKEN_TTL_SECONDS,
} = await import("../src/lib/mfa/mfa-token.ts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");

beforeEach(() => resetMfaTokenLedgerForTests());

const INPUT = { userId: "user-1", native: false, pwv: "pwv-abc", rememberMe: "true", webauthnChallenge: "Y2hhbGxlbmdl" };

test("a sign-in challenge token round-trips its claims and expires in five minutes", async () => {
  const before = Math.floor(Date.now() / 1000);
  const { token, jti, exp } = await signMfaSigninToken(INPUT);
  const claims = await verifyMfaSigninToken(token);
  assert.ok(claims);
  assert.equal(claims.userId, "user-1");
  assert.equal(claims.jti, jti);
  assert.equal(claims.native, false);
  assert.equal(claims.pwv, "pwv-abc");
  assert.equal(claims.rememberMe, "true");
  assert.equal(claims.webauthnChallenge, "Y2hhbGxlbmdl");
  assert.ok(exp - before >= MFA_TOKEN_TTL_SECONDS - 1 && exp - before <= MFA_TOKEN_TTL_SECONDS + 1);
});

test("a challenge token is NOT a session: verifySessionJwt rejects it (different key, no id/role)", async () => {
  const { token } = await signMfaSigninToken(INPUT);
  assert.equal(await verifySessionJwt(token), null);
});

test("a session JWT is NOT a challenge token — and neither is a passkey-registration token", async () => {
  const session = await signSessionJwt({ id: "user-1", role: "ADMIN", sessionId: "s1" }, { expiresInSeconds: 3600 });
  assert.equal(await verifyMfaSigninToken(session), null);
  const { token: reg } = await signPasskeyRegisterToken({ userId: "user-1", sessionId: "s1", challenge: "abc" });
  assert.equal(await verifyMfaSigninToken(reg), null, "cross-purpose: registration → sign-in");
  const { token: signin } = await signMfaSigninToken(INPUT);
  assert.equal(await verifyPasskeyRegisterToken(signin), null, "cross-purpose: sign-in → registration");
});

test("a token signed with the RAW session secret (right claims, wrong key) is refused", async () => {
  // The derived subkey is the point: knowing the claim layout and signing it the
  // way sessions are signed must not produce a valid challenge.
  const now = Math.floor(Date.now() / 1000);
  const forged = await new SignJWT({ native: false, pwv: "pwv-abc" })
    .setProtectedHeader({ alg: "HS256", typ: "summonarr-mfa+jwt" })
    .setSubject("user-1")
    .setAudience("summonarr:mfa-signin")
    .setJti("x")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
  assert.equal(await verifyMfaSigninToken(forged), null);
});

test("an expired or tampered challenge token is refused", async () => {
  const { token } = await signMfaSigninToken(INPUT);
  const [h, p, s] = token.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  payload.sub = "admin-1";
  const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
  assert.equal(await verifyMfaSigninToken(tampered), null, "re-targeted subject");

  // jose reads the clock through new Date(), so mock the Date API wholesale.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + (MFA_TOKEN_TTL_SECONDS + 5) * 1000 });
  try {
    assert.equal(await verifyMfaSigninToken(token), null, "past its five minutes");
  } finally {
    mock.timers.reset();
  }
  for (const junk of [undefined, null, 42, "", "a.b.c", "x".repeat(5000)]) {
    assert.equal(await verifyMfaSigninToken(junk), null);
  }
});

test("single use: a token is consumed exactly once", async () => {
  const { jti, exp } = await signMfaSigninToken(INPUT);
  assert.ok(isTokenUsable(jti, exp));
  assert.equal(consumeToken(jti, exp), true);
  assert.equal(consumeToken(jti, exp), false, "a second redemption must lose");
  assert.equal(isTokenUsable(jti, exp), false);
});

test("a token burns after MAX_TOKEN_FAILURES wrong answers and can't then be redeemed", async () => {
  const { jti, exp } = await signMfaSigninToken(INPUT);
  for (let i = 1; i < MAX_TOKEN_FAILURES; i++) {
    assert.equal(recordTokenFailure(jti, exp), i);
    assert.ok(isTokenUsable(jti, exp), `still usable after ${i} failure(s)`);
  }
  recordTokenFailure(jti, exp);
  assert.equal(isTokenUsable(jti, exp), false);
  assert.equal(consumeToken(jti, exp), false, "even a correct answer can't redeem a burned token");
});

test("a passkey-registration token binds user, session and challenge", async () => {
  const { token, jti } = await signPasskeyRegisterToken({ userId: "u1", sessionId: "sess-9", challenge: "Y2g" });
  assert.deepEqual(
    { ...(await verifyPasskeyRegisterToken(token))!, exp: 0 },
    { userId: "u1", sessionId: "sess-9", challenge: "Y2g", jti, exp: 0 },
  );
});
