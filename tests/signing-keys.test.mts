// Guardrail 6h, part 2: one HKDF subkey of NEXTAUTH_SECRET per purpose, a kid
// naming the secret that signed each JWT, and verify-only rotation through
// NEXTAUTH_SECRET_PREVIOUS (src/lib/signing-keys.ts, src/lib/session-jwt.ts).
//
// Pinned here:
//   - every purpose has its own key, none of them is the raw secret, and a
//     token or MAC made for one purpose fails every other one ON THE SIGNATURE
//     (typ/audience copied over, so only the key can be what refuses it);
//   - typ and audience are checked on verify;
//   - the kid names the secret, never contains it, and an unknown kid or a
//     missing one is refused;
//   - rotation: a token signed under the old secret verifies while
//     NEXTAUTH_SECRET_PREVIOUS holds it, and dies once it is removed; the
//     previous secret never signs; a PREVIOUS equal to the current secret (or
//     blank) is ignored;
//   - the session JWT: new tokens carry typ/kid/aud; a LEGACY raw-key token
//     (the shape every native device minted before this change still holds)
//     verifies, but only in its legacy shape and never as "current key"; the
//     raw previous secret covers legacy tokens across a rotation;
//   - request tokens: the subkey, rotation, and junk-suffixed MACs refused;
//   - the boot checks for NEXTAUTH_SECRET_PREVIOUS (boot-secrets.ts).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
import {
  keyIdFor,
  signingKey,
  verificationKeys,
  verificationKeyForKid,
  signPurposeJwt,
  verifyPurposeJwt,
  purposeHmacHex,
  verifyPurposeHmacHex,
  type SigningPurpose,
} from "../src/lib/signing-keys.ts";
import {
  signSessionJwt,
  verifySessionToken,
  verifySessionJwt,
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_TYP,
} from "../src/lib/session-jwt.ts";
import { generateRequestToken, verifyRequestToken } from "../src/lib/request-token.ts";
import { previousSecretProblem, secretReuseError } from "../src/lib/boot-secrets.ts";

const SECRET = "signing-keys-test-secret-0123456789abcdef-XYZ";
const OLD = "signing-keys-OLD-secret-0123456789abcdef-old!";
process.env.NEXTAUTH_SECRET = SECRET;
delete process.env.NEXTAUTH_SECRET_PREVIOUS;

afterEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET_PREVIOUS;
});

const PURPOSES: SigningPurpose[] = [
  "session",
  "plex-flow",
  "qc-flow",
  "oidc-flow",
  "request-token",
  "plex-token-cache",
];

function header(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}
function payload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

const SESSION_CLAIMS = { id: "u1", role: "USER", sessionId: "s1", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
const raw = (secret: string) => new TextEncoder().encode(secret);

async function legacySessionToken(secret: string, extra: Record<string, unknown> = {}, typ = "JWT"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...SESSION_CLAIMS, ...extra })
    .setProtectedHeader({ alg: "HS256", typ })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(raw(secret));
}

// ── keys ─────────────────────────────────────────────────────────────────────

test("every purpose has its own 32-byte subkey, none of them the raw secret, all deterministic", () => {
  const keys = PURPOSES.map((p) => Buffer.from(signingKey(p).key).toString("hex"));
  assert.equal(new Set(keys).size, PURPOSES.length, "two purposes share a key");
  for (const k of keys) {
    assert.equal(k.length, 64);
    assert.notEqual(k, Buffer.from(SECRET).toString("hex"));
  }
  assert.deepEqual(PURPOSES.map((p) => Buffer.from(signingKey(p).key).toString("hex")), keys);
});

test("the kid names the secret: stable per secret, different across secrets, never the secret itself", () => {
  assert.equal(keyIdFor(SECRET), keyIdFor(SECRET));
  assert.notEqual(keyIdFor(SECRET), keyIdFor(OLD));
  assert.match(keyIdFor(SECRET), /^[A-Za-z0-9_-]{12}$/);
  assert.ok(!SECRET.includes(keyIdFor(SECRET)));
  // Every purpose's key carries the same kid — it identifies the secret.
  assert.equal(new Set(PURPOSES.map((p) => signingKey(p).kid)).size, 1);
});

test("NEXTAUTH_SECRET_PREVIOUS adds a verify-only key; blank or equal to the current secret adds nothing", () => {
  assert.equal(verificationKeys("session").length, 1);
  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  const keys = verificationKeys("session");
  assert.equal(keys.length, 2);
  assert.equal(keys[0].current, true, "current first");
  assert.equal(keys[1].current, false);
  assert.equal(keys[1].kid, keyIdFor(OLD));
  assert.equal(signingKey("session").kid, keyIdFor(SECRET), "the previous secret never signs");
  assert.equal(verificationKeyForKid("session", keyIdFor(OLD))?.current, false);
  process.env.NEXTAUTH_SECRET_PREVIOUS = "   ";
  assert.equal(verificationKeys("session").length, 1);
  process.env.NEXTAUTH_SECRET_PREVIOUS = SECRET;
  assert.equal(verificationKeys("session").length, 1);
});

// ── purpose-bound JWTs ───────────────────────────────────────────────────────

const OPTS = { typ: "summonarr-test+jwt", audience: "summonarr:test" };

test("a purpose JWT verifies under its own purpose and fails every other ON THE KEY (same typ and audience)", async () => {
  for (const signer of PURPOSES) {
    const token = await signPurposeJwt(signer, { x: 1 }, { ...OPTS, ttlSeconds: 60 });
    assert.equal(header(token).kid, keyIdFor(SECRET));
    for (const verifier of PURPOSES) {
      const ok = (await verifyPurposeJwt(verifier, token, OPTS)) !== null;
      assert.equal(ok, signer === verifier, `${signer} token under ${verifier}`);
    }
  }
});

test("typ and audience are checked; a missing or unknown kid is refused", async () => {
  const token = await signPurposeJwt("plex-flow", { x: 1 }, { ...OPTS, ttlSeconds: 60 });
  assert.ok(await verifyPurposeJwt("plex-flow", token, OPTS));
  assert.equal(await verifyPurposeJwt("plex-flow", token, { ...OPTS, typ: "JWT" }), null);
  assert.equal(await verifyPurposeJwt("plex-flow", token, { ...OPTS, audience: "summonarr:other" }), null);

  const key = signingKey("plex-flow").key;
  const now = Math.floor(Date.now() / 1000);
  const noKid = await new SignJWT({ x: 1 })
    .setProtectedHeader({ alg: "HS256", typ: OPTS.typ })
    .setAudience(OPTS.audience).setIssuedAt(now).setExpirationTime(now + 60).sign(key);
  assert.equal(await verifyPurposeJwt("plex-flow", noKid, OPTS), null, "no kid ⇒ refused");
  const badKid = await new SignJWT({ x: 1 })
    .setProtectedHeader({ alg: "HS256", typ: OPTS.typ, kid: "AAAAAAAAAAAA" })
    .setAudience(OPTS.audience).setIssuedAt(now).setExpirationTime(now + 60).sign(key);
  assert.equal(await verifyPurposeJwt("plex-flow", badKid, OPTS), null, "unknown kid ⇒ refused");
});

test("rotation: a flow token from the old secret verifies while PREVIOUS holds it, and dies without it", async () => {
  process.env.NEXTAUTH_SECRET = OLD;
  const token = await signPurposeJwt("oidc-flow", { x: 1 }, { ...OPTS, ttlSeconds: 60 });
  process.env.NEXTAUTH_SECRET = SECRET;
  assert.equal(await verifyPurposeJwt("oidc-flow", token, OPTS), null, "rotated with no PREVIOUS ⇒ gone");
  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  assert.ok(await verifyPurposeJwt("oidc-flow", token, OPTS), "PREVIOUS keeps it alive");
});

// ── the session JWT ──────────────────────────────────────────────────────────

test("a new session JWT carries the session typ, the current kid and the session audience", async () => {
  const token = await signSessionJwt(SESSION_CLAIMS, { expiresInSeconds: 600 });
  assert.equal(header(token).typ, SESSION_JWT_TYP);
  assert.equal(header(token).kid, keyIdFor(SECRET));
  assert.equal(payload(token).aud, SESSION_JWT_AUDIENCE);
  const v = await verifySessionToken(token);
  assert.equal(v?.signedWithCurrentKey, true);
  // It is NOT HMAC'd with the raw secret: the raw key does not verify it.
  const [h, p, sig] = token.split(".");
  const rawSig = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  assert.notEqual(sig, rawSig);
});

test("a kid-signed token must carry the session typ and audience; another purpose's key can't make one", async () => {
  const opts = { typ: SESSION_JWT_TYP, audience: SESSION_JWT_AUDIENCE, ttlSeconds: 600 };
  assert.ok(await verifySessionToken(await signPurposeJwt("session", SESSION_CLAIMS, opts)), "control");
  assert.equal(await verifySessionToken(await signPurposeJwt("session", SESSION_CLAIMS, { ...opts, typ: "JWT" })), null);
  assert.equal(
    await verifySessionToken(await signPurposeJwt("session", SESSION_CLAIMS, { ...opts, audience: "summonarr:plex-flow" })),
    null,
  );
  for (const other of PURPOSES.filter((p) => p !== "session")) {
    assert.equal(
      await verifySessionToken(await signPurposeJwt(other, SESSION_CLAIMS, opts)),
      null,
      `a ${other} key minted a session`,
    );
  }
});

test("a session JWT never verifies as a flow token", async () => {
  const session = await signSessionJwt({ ...SESSION_CLAIMS, pinId: 1, clientId: "c" } as never, { expiresInSeconds: 600 });
  for (const p of PURPOSES.filter((x) => x !== "session")) {
    assert.equal(await verifyPurposeJwt(p, session, { typ: SESSION_JWT_TYP, audience: SESSION_JWT_AUDIENCE }), null);
  }
});

test("a LEGACY raw-key session token (no kid) still verifies — but never as the current key", async () => {
  // Every iOS device signed in before this change holds exactly this shape, and
  // is never handed a replacement (guardrail 6b).
  const legacy = await legacySessionToken(SECRET);
  const v = await verifySessionToken(legacy);
  assert.ok(v, "the shipped app's token must keep verifying");
  assert.equal(v.signedWithCurrentKey, false, "so session-refresh re-signs it rather than fast-pathing it");
  assert.equal(v.claims.id, "u1");
});

test("the raw key only vouches for the LEGACY shape: an audience, a transport claim or the new typ ⇒ refused", async () => {
  assert.equal(await verifySessionToken(await legacySessionToken(SECRET, { aud: SESSION_JWT_AUDIENCE })), null);
  assert.equal(await verifySessionToken(await legacySessionToken(SECRET, { transport: "cookie" })), null);
  assert.equal(await verifySessionToken(await legacySessionToken(SECRET, {}, SESSION_JWT_TYP)), null);
  assert.equal(await verifySessionToken(await legacySessionToken(OLD)), null, "a raw key we never held");
});

test("rotation: session tokens from the old secret — kid-signed and legacy raw-key — verify only while PREVIOUS holds it", async () => {
  process.env.NEXTAUTH_SECRET = OLD;
  const kidToken = await signSessionJwt(SESSION_CLAIMS, { expiresInSeconds: 600 });
  process.env.NEXTAUTH_SECRET = SECRET;
  const legacy = await legacySessionToken(OLD);

  assert.equal(await verifySessionJwt(kidToken), null);
  assert.equal(await verifySessionJwt(legacy), null);

  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  const v = await verifySessionToken(kidToken);
  assert.ok(v);
  assert.equal(v.signedWithCurrentKey, false, "a previous-key token is re-signed on its next slow path");
  assert.ok(await verifySessionJwt(legacy), "the raw previous secret covers legacy tokens across a rotation");
});

// ── request tokens ───────────────────────────────────────────────────────────

test("request tokens use their own subkey, rotate through PREVIOUS, and refuse a MAC with junk appended", () => {
  const t = generateRequestToken(603, "MOVIE", "u_alice");
  const bucket = Math.floor(Date.now() / 3_600_000);
  const rawMac = createHmac("sha256", SECRET).update(`req:603:MOVIE:u_alice:${bucket}`).digest("hex");
  assert.notEqual(t, rawMac, "not the raw-secret HMAC any more");
  assert.equal(verifyRequestToken(rawMac, 603, "MOVIE", "u_alice"), false);
  assert.equal(t, purposeHmacHex(signingKey("request-token"), `req:603:MOVIE:u_alice:${bucket}`));

  assert.equal(verifyRequestToken(`${t}zz`, 603, "MOVIE", "u_alice"), false, "hex parse must not truncate");
  assert.equal(verifyPurposeHmacHex("request-token", "m", `${"0".repeat(63)}`), false);

  process.env.NEXTAUTH_SECRET = OLD;
  const old = generateRequestToken(603, "MOVIE", "u_alice");
  process.env.NEXTAUTH_SECRET = SECRET;
  assert.equal(verifyRequestToken(old, 603, "MOVIE", "u_alice"), false);
  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  assert.equal(verifyRequestToken(old, 603, "MOVIE", "u_alice"), true);
});

test("the PlexTokenCache key is its own subkey, not the raw secret (auth.ts)", () => {
  const src = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
  assert.match(src, /purposeHmacHex\(signingKey\("plex-token-cache"\), plexToken\)/);
  assert.doesNotMatch(src, /createHmac\(/, "auth.ts HMACs nothing with a raw secret");
});

test("no module outside signing-keys.ts derives a key from NEXTAUTH_SECRET by hand, except the pre-existing MFA/connect subkeys", () => {
  // mfa-token.ts, mfa-store.ts and the Plex connect cookie predate this module
  // and already derive their own HKDF subkeys; everything else goes through it.
  const allowed = new Set([
    "src/lib/signing-keys.ts",
    "src/lib/mfa/mfa-token.ts",
    "src/lib/mfa/mfa-store.ts",
    "src/lib/plex-flow-state.ts",
    "src/instrumentation.ts",
  ]);
  const files = [
    "src/lib/session-jwt.ts",
    "src/lib/jellyfin-flow-state.ts",
    "src/lib/oidc.ts",
    "src/lib/request-token.ts",
    "src/lib/auth.ts",
    "src/lib/plex-flow-state.ts",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const reads = (src.match(/process\.env\.NEXTAUTH_SECRET\b/g) ?? []).length;
    if (allowed.has(f)) continue;
    assert.equal(reads, 0, `${f} reads NEXTAUTH_SECRET directly`);
  }
  // plex-flow-state.ts: only the connect cookie's own derivation may read it.
  const plex = readFileSync(new URL("../src/lib/plex-flow-state.ts", import.meta.url), "utf8");
  assert.equal((plex.match(/process\.env\.NEXTAUTH_SECRET\b/g) ?? []).length, 1);
});

// ── boot checks ──────────────────────────────────────────────────────────────

test("boot: NEXTAUTH_SECRET_PREVIOUS shorter than 32 is fatal, equal to the current secret is a warning, unset is fine", () => {
  assert.equal(previousSecretProblem({ nextAuthSecret: SECRET }), null);
  assert.equal(previousSecretProblem({ nextAuthSecret: SECRET, nextAuthSecretPrevious: "  " }), null);
  assert.equal(previousSecretProblem({ nextAuthSecret: SECRET, nextAuthSecretPrevious: OLD }), null);
  assert.equal(previousSecretProblem({ nextAuthSecret: SECRET, nextAuthSecretPrevious: "short" })?.fatal, true);
  assert.equal(previousSecretProblem({ nextAuthSecret: SECRET, nextAuthSecretPrevious: SECRET })?.fatal, false);
});

test("boot: NEXTAUTH_SECRET_PREVIOUS reused as CRON_SECRET or TOKEN_ENCRYPTION_KEY is a reuse error", () => {
  const tek = "ab".repeat(32);
  assert.match(
    secretReuseError({ nextAuthSecret: SECRET, nextAuthSecretPrevious: OLD, cronSecret: OLD, tokenEncryptionKey: tek }) ?? "",
    /NEXTAUTH_SECRET_PREVIOUS and CRON_SECRET/,
  );
  assert.match(
    secretReuseError({ nextAuthSecret: SECRET, nextAuthSecretPrevious: tek.toUpperCase(), cronSecret: "c".repeat(40), tokenEncryptionKey: tek }) ?? "",
    /NEXTAUTH_SECRET_PREVIOUS and TOKEN_ENCRYPTION_KEY/,
  );
  assert.equal(secretReuseError({ nextAuthSecret: SECRET, nextAuthSecretPrevious: OLD, cronSecret: "c".repeat(40), tokenEncryptionKey: tek }), null);
});

test("boot: instrumentation wires both checks for the previous secret", () => {
  const src = readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8");
  assert.match(src, /nextAuthSecretPrevious: process\.env\.NEXTAUTH_SECRET_PREVIOUS/);
  assert.match(src, /previousSecretProblem\(\{[\s\S]*?\}\);\s*if \(previous\?\.fatal\) \{[\s\S]*?process\.exit\(1\)/);
});
