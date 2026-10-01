// Unit tests for the hand-rolled WebAuthn relying party (src/lib/mfa/webauthn.ts)
// and its strict CBOR decoder (src/lib/mfa/cbor.ts).
//
// Every vector is generated in-test by tests/_webauthn-fixtures.mts with real
// node:crypto keypairs, assembling authenticator data and clientDataJSON
// byte-exactly — so a signature check here is a genuine ES256 / EdDSA / RS256
// verification, not a mock. Each REJECTION test changes exactly one thing from
// a vector the happy-path test proves valid, so a pass means that one check
// fired (each was mutation-verified: disabling the check makes its test fail).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeCbor, decodeCborFirst, CborError } from "../src/lib/mfa/cbor.ts";
import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  parseAuthenticatorData,
  coseToPublicKey,
  webAuthnConfigFromEnv,
  fromBase64Url,
  WebAuthnError,
  type WebAuthnConfig,
} from "../src/lib/mfa/webauthn.ts";
import {
  assertionResponse,
  buildAuthData,
  cborEncode,
  makeAuthenticator,
  registrationResponse,
  FLAG_AT,
  FLAG_BE,
  FLAG_BS,
  FLAG_ED,
  FLAG_UP,
  FLAG_UV,
  type Alg,
} from "./_webauthn-fixtures.mts";

const RP_ID = "requests.example.com";
const ORIGIN = "https://requests.example.com";
const CONFIG: WebAuthnConfig = { rpId: RP_ID, rpName: "Summonarr", origins: [ORIGIN] };
const CHALLENGE = Buffer.from("a-32-byte-challenge-for-testing!").toString("base64url");
const USER_HANDLE = createHash("sha256").update("user-1").digest("base64url");

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof WebAuthnError, `expected a WebAuthnError, got ${err}`);
    return err.code;
  }
  assert.fail("expected the verification to throw");
}

// ── CBOR ────────────────────────────────────────────────────────────────────

test("cbor: decodes ints, negatives, bytes, text, arrays, maps, simple values", () => {
  const v = decodeCbor(cborEncode(new Map<number | string, never>([
    [1, 2 as never], [-1, -7 as never], ["b", Buffer.from([1, 2, 3]) as never], ["t", "héllo" as never],
    ["a", [1, 70000, true, null] as never],
  ]))) as Map<unknown, unknown>;
  assert.equal(v.get(1), 2);
  assert.equal(v.get(-1), -7);
  assert.deepEqual([...(v.get("b") as Uint8Array)], [1, 2, 3]);
  assert.equal(v.get("t"), "héllo");
  assert.deepEqual(v.get("a"), [1, 70000, true, null]);
});

test("cbor: decodeCborFirst reports where the first item ends (the COSE key inside authData)", () => {
  const item = cborEncode(new Map([[1, 2]]));
  const { length } = decodeCborFirst(Buffer.concat([item, Buffer.from([0xff, 0xff])]));
  assert.equal(length, item.length);
});

test("cbor: strict — trailing bytes, truncation, indefinite length, tags, floats, duplicate keys and bad UTF-8 are refused", () => {
  const bad: [string, Buffer][] = [
    ["trailing", Buffer.concat([cborEncode(1), Buffer.from([0])])],
    ["truncated bstr", Buffer.from([0x45, 1, 2])],
    ["indefinite array", Buffer.from([0x9f, 0x01, 0xff])],
    ["tag", Buffer.from([0xc1, 0x01])],
    ["float", Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["duplicate key", Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02])],
    ["array map key", Buffer.from([0xa1, 0x80, 0x01])],
    ["bad utf-8", Buffer.from([0x62, 0xc3, 0x28])],
    ["length beyond input", Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff])],
  ];
  for (const [label, bytes] of bad) assert.throws(() => decodeCbor(bytes), CborError, label);
});

test("cbor: nesting depth is capped (a hostile blob can't blow the stack)", () => {
  const deep = Buffer.concat([Buffer.alloc(40, 0x81), Buffer.from([0x01])]);
  assert.throws(() => decodeCbor(deep), CborError);
});

// ── config ──────────────────────────────────────────────────────────────────

test("config: RP ID is AUTH_URL's host; only same-RP trusted origins are added; no AUTH_URL ⇒ unavailable", () => {
  const cfg = webAuthnConfigFromEnv({
    AUTH_URL: "https://requests.example.com/summonarr",
    AUTH_TRUSTED_ORIGIN: "https://app.requests.example.com, http://192.168.1.5:3001, https://evil.example.net, nonsense",
  })!;
  assert.equal(cfg.rpId, "requests.example.com");
  assert.deepEqual(cfg.origins.sort(), ["https://app.requests.example.com", "https://requests.example.com"]);
  assert.equal(webAuthnConfigFromEnv({}), null);
  assert.equal(webAuthnConfigFromEnv({ AUTH_URL: "not a url" }), null);
});

test("base64url: padding, the standard alphabet and non-canonical encodings are refused", () => {
  assert.equal(fromBase64Url("AQID").toString("hex"), "010203");
  assert.throws(() => fromBase64Url("AQID="), WebAuthnError);
  assert.throws(() => fromBase64Url("a+b/"), WebAuthnError);
  assert.throws(() => fromBase64Url("AR"), WebAuthnError, "AR has non-zero trailing bits; canonical is AQ");
  assert.throws(() => fromBase64Url(42), WebAuthnError);
});

// ── registration (§7.1) ─────────────────────────────────────────────────────

for (const alg of ["ES256", "EdDSA", "RS256"] as Alg[]) {
  test(`registration happy path (${alg}): returns the credential, its COSE key and filtered transports`, () => {
    const auth = makeAuthenticator(alg);
    const v = verifyRegistrationResponse({
      response: registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE }),
      expectedChallenge: CHALLENGE,
      config: CONFIG,
    });
    assert.equal(v.credentialId, auth.credentialId.toString("base64url"));
    assert.equal(v.publicKey, auth.coseKey.toString("base64url"));
    assert.equal(v.alg, alg === "ES256" ? -7 : alg === "EdDSA" ? -8 : -257);
    assert.equal(v.signCount, 0);
    assert.deepEqual(v.transports, ["usb"], "unknown transport strings are dropped");
    assert.equal(v.aaguid, "00000000-0000-0000-0000-000000000000");
  });
}

test("registration: an attStmt in another fmt is IGNORED (attestation 'none' policy), but fmt none must be empty", () => {
  const auth = makeAuthenticator();
  const packed = registrationResponse({
    auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE,
    fmt: "packed", attStmt: new Map<string, number | Buffer>([["alg", -7], ["sig", Buffer.from("garbage")]]),
  });
  assert.doesNotThrow(() => verifyRegistrationResponse({ response: packed, expectedChallenge: CHALLENGE, config: CONFIG }));
  const noneWithStmt = registrationResponse({
    auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, attStmt: new Map([["x", 1]]),
  });
  assert.equal(code(() => verifyRegistrationResponse({ response: noneWithStmt, expectedChallenge: CHALLENGE, config: CONFIG })), "attestation");
});

test("registration REJECTS: wrong origin, wrong RP ID, wrong type, wrong challenge, cross-origin", () => {
  const auth = makeAuthenticator();
  const run = (r: ReturnType<typeof registrationResponse>, challenge = CHALLENGE) =>
    code(() => verifyRegistrationResponse({ response: r, expectedChallenge: challenge, config: CONFIG }));
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: "https://evil.example.com", challenge: CHALLENGE })), "origin");
  assert.equal(run(registrationResponse({ auth, rpId: "evil.example.com", origin: ORIGIN, challenge: CHALLENGE })), "rp-id");
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, type: "webauthn.get" })), "type");
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE }), "b3RoZXI"), "challenge");
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, crossOrigin: true })), "origin");
});

test("registration REJECTS: no user presence, missing attested data, rawId ≠ attested id, BS without BE", () => {
  const auth = makeAuthenticator();
  const run = (r: ReturnType<typeof registrationResponse>) =>
    code(() => verifyRegistrationResponse({ response: r, expectedChallenge: CHALLENGE, config: CONFIG }));
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, flags: FLAG_AT })), "user-presence");
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, rawId: Buffer.from("someone-else") })), "shape");
  assert.equal(run(registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, flags: FLAG_UP | FLAG_AT | FLAG_BS })), "authdata");
  // UV demanded but not performed.
  assert.equal(
    code(() => verifyRegistrationResponse({
      response: registrationResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE }),
      expectedChallenge: CHALLENGE, config: CONFIG, requireUserVerification: true,
    })),
    "user-verification",
  );
});

test("authenticator data: trailing bytes, truncated attested data and malformed extensions are refused", () => {
  const auth = makeAuthenticator();
  assert.throws(() => parseAuthenticatorData(buildAuthData({ rpId: RP_ID, flags: FLAG_UP, signCount: 1, trailing: Buffer.from([0]) })), WebAuthnError);
  assert.throws(() => parseAuthenticatorData(buildAuthData({ rpId: RP_ID, flags: FLAG_UP | FLAG_AT, signCount: 1 })), WebAuthnError);
  assert.throws(() => parseAuthenticatorData(buildAuthData({ rpId: RP_ID, flags: FLAG_UP | FLAG_ED, signCount: 1, extensions: Buffer.from([0x01]) })), WebAuthnError);
  // Well-formed extensions parse.
  const ok = parseAuthenticatorData(buildAuthData({
    rpId: RP_ID, flags: FLAG_UP | FLAG_AT | FLAG_ED | FLAG_BE, signCount: 7,
    attested: { credentialId: auth.credentialId, coseKey: auth.coseKey },
    extensions: cborEncode(new Map([["credProtect", 1]])),
  }));
  assert.equal(ok.signCount, 7);
  assert.ok(ok.flags.be && !ok.flags.bs);
});

test("COSE: unsupported algorithms, mismatched key types and off-curve EC points are refused", () => {
  assert.throws(() => coseToPublicKey(cborEncode(new Map([[1, 2], [3, -35], [-1, 2]]))), WebAuthnError, "ES384 not offered");
  assert.throws(() => coseToPublicKey(cborEncode(new Map<number, number | Buffer>([[1, 1], [3, -7], [-1, 6], [-2, Buffer.alloc(32)]]))), WebAuthnError, "ES256 on an OKP key");
  assert.throws(
    () => coseToPublicKey(cborEncode(new Map<number, Buffer | number>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 2)]]))),
    WebAuthnError,
    "a point not on P-256",
  );
});

// ── assertion (§7.2) ────────────────────────────────────────────────────────

function stored(auth: ReturnType<typeof makeAuthenticator>, signCount = 0) {
  return { credentialId: auth.credentialId.toString("base64url"), publicKey: auth.coseKey.toString("base64url"), signCount };
}

for (const alg of ["ES256", "EdDSA", "RS256"] as Alg[]) {
  test(`assertion happy path (${alg}): a genuine signature verifies and the new counter is returned`, () => {
    const auth = makeAuthenticator(alg);
    const v = verifyAuthenticationResponse({
      response: assertionResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 5, flags: FLAG_UP | FLAG_UV, userHandle: USER_HANDLE }),
      expectedChallenge: CHALLENGE,
      config: CONFIG,
      credential: stored(auth, 4),
      expectedUserHandle: USER_HANDLE,
    });
    assert.deepEqual(v, { newSignCount: 5, userVerified: true, backedUp: false });
  });
}

test("assertion: an authenticator that doesn't count (0 → 0, synced passkeys) is accepted", () => {
  const auth = makeAuthenticator();
  const v = verifyAuthenticationResponse({
    response: assertionResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 0 }),
    expectedChallenge: CHALLENGE, config: CONFIG, credential: stored(auth, 0),
  });
  assert.equal(v.newSignCount, 0);
});

test("assertion REJECTS a counter regression (possible cloned authenticator): equal, lower, and 0 after a real count", () => {
  const auth = makeAuthenticator();
  for (const [storedCount, received] of [[10, 10], [10, 3], [10, 0]]) {
    assert.equal(
      code(() => verifyAuthenticationResponse({
        response: assertionResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: received }),
        expectedChallenge: CHALLENGE, config: CONFIG, credential: stored(auth, storedCount),
      })),
      "counter",
      `${storedCount} → ${received}`,
    );
  }
});

test("assertion REJECTS a bad signature: signed by another key, or authenticator data altered after signing", () => {
  const auth = makeAuthenticator();
  const other = makeAuthenticator();
  assert.equal(
    code(() => verifyAuthenticationResponse({
      response: assertionResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 1, signWith: other }),
      expectedChallenge: CHALLENGE, config: CONFIG, credential: stored(auth),
    })),
    "signature",
  );
  assert.equal(
    code(() => verifyAuthenticationResponse({
      response: assertionResponse({
        auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 1,
        tamperAuthData: (b) => { b[32] |= FLAG_UV; return b; }, // claim UV after the fact
      }),
      expectedChallenge: CHALLENGE, config: CONFIG, credential: stored(auth),
    })),
    "signature",
  );
});

test("assertion REJECTS: wrong origin, wrong RP ID, wrong type, replayed/foreign challenge, no UP, cross-origin", () => {
  const auth = makeAuthenticator();
  const run = (r: ReturnType<typeof assertionResponse>, challenge = CHALLENGE) =>
    code(() => verifyAuthenticationResponse({ response: r, expectedChallenge: challenge, config: CONFIG, credential: stored(auth) }));
  const base = { auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 1 };
  assert.equal(run(assertionResponse({ ...base, origin: "https://requests.example.com.evil.io" })), "origin");
  assert.equal(run(assertionResponse({ ...base, rpId: "example.com" })), "rp-id");
  assert.equal(run(assertionResponse({ ...base, type: "webauthn.create" })), "type");
  // An assertion produced for an OLD challenge, replayed against a new one.
  assert.equal(run(assertionResponse(base), Buffer.from("a-different-fresh-challenge-32b!").toString("base64url")), "challenge");
  assert.equal(run(assertionResponse({ ...base, flags: 0 })), "user-presence");
  assert.equal(run(assertionResponse({ ...base, crossOrigin: true })), "origin");
});

test("assertion REJECTS a credential that isn't the stored one, and a userHandle for another account", () => {
  const auth = makeAuthenticator();
  const other = makeAuthenticator();
  assert.equal(
    code(() => verifyAuthenticationResponse({
      response: assertionResponse({ auth: other, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 1 }),
      expectedChallenge: CHALLENGE, config: CONFIG, credential: stored(auth),
    })),
    "credential",
  );
  assert.equal(
    code(() => verifyAuthenticationResponse({
      response: assertionResponse({ auth, rpId: RP_ID, origin: ORIGIN, challenge: CHALLENGE, signCount: 1, userHandle: createHash("sha256").update("user-2").digest("base64url") }),
      expectedChallenge: CHALLENGE, config: CONFIG, credential: stored(auth), expectedUserHandle: USER_HANDLE,
    })),
    "credential",
  );
});
