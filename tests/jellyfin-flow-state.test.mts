// Unit tests for the Jellyfin QuickConnect flow-state cookie
// (src/lib/jellyfin-flow-state.ts). This cookie is the ONLY thing binding a
// QuickConnect secret redemption to the browser that initiated the flow — a
// phished secret submitted from another browser must fail because it carries
// no (or a mismatched) flow cookie. Pins: hash determinism (the sign-in route
// compares hashQuickConnectSecret(body.secret) against the cookie's stored
// hash), signature/expiry enforcement, fail-closed verification (null, never
// throw), never storing the raw secret in the cookie, exact cookie-attribute
// strings, and cookie-header parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import {
  QC_FLOW_COOKIE,
  hashQuickConnectSecret,
  signQcFlowCookie,
  verifyQcFlowCookie,
  readQcFlowCookie,
  buildQcFlowSetCookie,
  buildQcFlowClearedSetCookie,
} from "../src/lib/jellyfin-flow-state.ts";
import { signPlexFlowCookie } from "../src/lib/plex-flow-state.ts";

const SECRET = "unit-test-qc-flow-secret-0123456789abcdef";
process.env.NEXTAUTH_SECRET = SECRET;

const QC_SECRET = "AbCdEf123456QuickConnectSecret";
const QC_HASH = hashQuickConnectSecret(QC_SECRET);

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

test("hashQuickConnectSecret is deterministic SHA-256 hex", () => {
  assert.equal(QC_HASH, createHash("sha256").update(QC_SECRET).digest("hex"));
  assert.match(QC_HASH, /^[0-9a-f]{64}$/);
  // Deterministic across calls (the initiation route and the sign-in route
  // hash independently — they must agree).
  assert.equal(hashQuickConnectSecret(QC_SECRET), QC_HASH);
  // Distinct secrets produce distinct hashes.
  assert.notEqual(hashQuickConnectSecret(`${QC_SECRET}x`), QC_HASH);
  // Known SHA-256 vector for the empty string.
  assert.equal(
    hashQuickConnectSecret(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("sign → verify roundtrip returns exactly the stored secretHash", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  const state = await verifyQcFlowCookie(token);
  assert.deepEqual(state, { secretHash: QC_HASH });
});

test("the cookie JWT never carries the raw QuickConnect secret", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  const payload = decodePayload(token);
  assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "secretHash"]);
  assert.equal(payload.secretHash, QC_HASH);
  assert.ok(!token.includes(QC_SECRET));
});

test("cookie lifetime is pinned to 10 minutes (exp - iat)", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  const payload = decodePayload(token);
  assert.equal(typeof payload.iat, "number");
  assert.equal(payload.exp, (payload.iat as number) + 600);
});

test("expired flow cookie verifies to null", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({ secretHash: QC_HASH })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now - 700)
    .setExpirationTime(now - 60)
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifyQcFlowCookie(expired), null);
});

test("cookie signed with a different secret is rejected", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  process.env.NEXTAUTH_SECRET = "a-completely-different-secret-9876543210";
  try {
    assert.equal(await verifyQcFlowCookie(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
  assert.ok(await verifyQcFlowCookie(token)); // sanity: verifies again with the right secret
});

test("tampered secretHash breaks the signature (phished-secret swap)", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  const [header, , sig] = token.split(".");
  const body = decodePayload(token);
  body.secretHash = hashQuickConnectSecret("attacker-phished-secret");
  const forged = Buffer.from(JSON.stringify(body)).toString("base64url");
  assert.equal(await verifyQcFlowCookie(`${header}.${forged}.${sig}`), null);
});

test("alg:none forgery is rejected (pinned HS256 list)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ secretHash: QC_HASH, iat: now, exp: now + 600 }),
  ).toString("base64url");
  assert.equal(await verifyQcFlowCookie(`${header}.${payload}.`), null);
});

test("validly-signed token without a string secretHash verifies to null", async () => {
  const key = new TextEncoder().encode(SECRET);
  const missing = await new SignJWT({ sub: "not-a-flow" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
  assert.equal(await verifyQcFlowCookie(missing), null);
  const wrongType = await new SignJWT({ secretHash: 12345 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
  assert.equal(await verifyQcFlowCookie(wrongType), null);
});

test("a Plex flow cookie does not verify as QC flow state (cross-flow confusion)", async () => {
  // Both flow cookies are HS256 JWTs under the same NEXTAUTH_SECRET; the shape
  // check is what keeps a Plex-flow token from being replayed into the QC path.
  const plexToken = await signPlexFlowCookie({ pinId: 42, clientId: "client-abc" });
  assert.equal(await verifyQcFlowCookie(plexToken), null);
});

test("garbage tokens verify to null, never throw", async () => {
  assert.equal(await verifyQcFlowCookie(""), null);
  assert.equal(await verifyQcFlowCookie("not.a.jwt"), null);
  assert.equal(await verifyQcFlowCookie("deadbeef"), null);
});

test("sign throws without NEXTAUTH_SECRET; verify fails closed to null", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  delete process.env.NEXTAUTH_SECRET;
  try {
    await assert.rejects(signQcFlowCookie({ secretHash: QC_HASH }), /NEXTAUTH_SECRET/);
    assert.equal(await verifyQcFlowCookie(token), null);
  } finally {
    process.env.NEXTAUTH_SECRET = SECRET;
  }
});

test("readQcFlowCookie extracts the flow cookie from a Cookie header", () => {
  assert.equal(readQcFlowCookie(null), null);
  assert.equal(readQcFlowCookie(""), null);
  assert.equal(readQcFlowCookie("other=1; session=abc"), null);
  assert.equal(readQcFlowCookie(`${QC_FLOW_COOKIE}=tok123`), "tok123");
  assert.equal(readQcFlowCookie(`a=1; ${QC_FLOW_COOKIE}=tok123; b=2`), "tok123");
  // Real JWTs are dot-separated but cookie values may contain '=' padding —
  // only the FIRST '=' splits name from value.
  assert.equal(readQcFlowCookie(`${QC_FLOW_COOKIE}=abc=def==`), "abc=def==");
});

test("readQcFlowCookie matches the exact cookie name only", () => {
  assert.equal(readQcFlowCookie(`${QC_FLOW_COOKIE}-evil=tok`), null);
  assert.equal(readQcFlowCookie(`x${QC_FLOW_COOKIE}=tok`), null);
  // A valueless fragment (no '=') is skipped, not matched.
  assert.equal(readQcFlowCookie(`${QC_FLOW_COOKIE}; a=1`), null);
  // Empty value is still a match (returns empty string, not null).
  assert.equal(readQcFlowCookie(`${QC_FLOW_COOKIE}=`), "");
});

test("buildQcFlowSetCookie emits the exact hardened attribute set", () => {
  assert.equal(
    buildQcFlowSetCookie("tok123", false),
    `${QC_FLOW_COOKIE}=tok123; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  assert.equal(
    buildQcFlowSetCookie("tok123", true),
    `${QC_FLOW_COOKIE}=tok123; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure`,
  );
});

test("buildQcFlowClearedSetCookie clears the same name+path it set", () => {
  const cleared = buildQcFlowClearedSetCookie();
  assert.equal(cleared, `${QC_FLOW_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax`);
  // Name and Path must match the setter or browsers keep the original cookie.
  assert.ok(cleared.startsWith(`${QC_FLOW_COOKIE}=;`));
  assert.ok(cleared.includes("Path=/api/auth"));
  assert.ok(cleared.includes("Max-Age=0"));
});

test("full flow: set-cookie → echoed Cookie header → verified state matches", async () => {
  const token = await signQcFlowCookie({ secretHash: QC_HASH });
  const setCookie = buildQcFlowSetCookie(token, true);
  // Browser echoes back only the name=value pair, alongside other cookies.
  const echoed = `theme=dark; ${setCookie.split("; ")[0]}; lang=en`;
  const read = readQcFlowCookie(echoed);
  assert.equal(read, token);
  assert.deepEqual(await verifyQcFlowCookie(read as string), { secretHash: QC_HASH });
  // The sign-in route's binding check: the submitted secret must hash to the
  // cookie's stored hash — a phished-but-different secret fails.
  assert.equal(hashQuickConnectSecret(QC_SECRET), QC_HASH);
  assert.notEqual(hashQuickConnectSecret("some-other-browser-secret"), QC_HASH);
});
